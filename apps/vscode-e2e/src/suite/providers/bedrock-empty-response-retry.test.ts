import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import {
	startBedrockMockServer,
	buildEmptyResponseFrames,
	buildToolCallFrames,
	type BedrockMockServer,
} from "../../bedrock-mock-server"
import { setDefaultSuiteTimeout } from "../test-utils"
import { waitFor, waitUntilCompleted } from "../utils"

const BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
const USER_PROMPT = "bedrock-empty-response-retry-smoke: what is 2+2? Reply with only the number."

suite("Bedrock provider — empty assistant response retry", function () {
	setDefaultSuiteTimeout(this)
	this.timeout(3 * 60_000)

	let mockServer: BedrockMockServer | undefined

	suiteTeardown(async () => {
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})

		if (mockServer) {
			await new Promise<void>((resolve) => setTimeout(resolve, 500))
			await mockServer.close()
			mockServer = undefined
		}
	})

	// Regression test for a bug where the manual-retry path (autoApprovalEnabled: false,
	// user clicks "retry" on the api_req_failed prompt after the model returns no assistant
	// content) failed to mark userMessageWasRemoved on the retried stack item. That caused
	// shouldAddUserMessageToHistory to skip re-adding the user's message entirely on retry,
	// so the retried request went out without it -- silently dropping the user's turn.
	test("re-sends the user message and completes after a manual retry following an empty assistant response", async () => {
		mockServer = await startBedrockMockServer({
			responses: [
				buildEmptyResponseFrames(),
				buildToolCallFrames("attempt_completion", "tooluse_bedrock_mock_002", JSON.stringify({ result: "4" })),
			],
		})

		await globalThis.api.setConfiguration({
			apiProvider: "bedrock" as const,
			awsUseApiKey: true,
			awsApiKey: "mock-key",
			awsRegion: "us-east-1",
			apiModelId: BEDROCK_MODEL_ID,
			awsBedrockEndpoint: mockServer.url,
			awsBedrockEndpointEnabled: true,
		})

		const api = globalThis.api
		// Keyed by taskId: this suite runs after bedrock.test.ts's tests in the same
		// extension host, and RooCodeEventName.Message is a global event stream, so a
		// leftover ask from a prior test's task could otherwise be mistaken for this
		// test's own "api_req_failed"/"completion_result" prompts.
		const asksByTaskId: Record<string, ClineMessage[]> = {}
		let ourTaskId: string | undefined

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			// Only track the final, non-partial ask -- approving a still-streaming/partial
			// ask (e.g. mid-tool-execution) can interrupt the in-flight tool call, which the
			// framework then reports as an error and retries, inflating the request count.
			if (message.type === "ask" && message.partial !== true) {
				;(asksByTaskId[taskId] ??= []).push(message)
			}
		}
		api.on(RooCodeEventName.Message, messageHandler)

		try {
			await waitUntilCompleted({
				api,
				start: async () => {
					const taskId = await api.startNewTask({
						// autoApprovalEnabled: false is required so the empty-response retry
						// goes through the manual ask("api_req_failed", ...) prompt path
						// (the buggy branch) rather than the auto-retry backoff path.
						configuration: { mode: "ask", autoApprovalEnabled: false },
						text: USER_PROMPT,
					})
					ourTaskId = taskId

					// Wait for the manual retry prompt, then approve it (equivalent to
					// clicking the primary "Retry" button -- response: "yesButtonClicked").
					await waitFor(() => asksByTaskId[taskId]?.some(({ ask }) => ask === "api_req_failed") ?? false)
					await api.approveCurrentAsk()

					// After the retry succeeds, the model calls attempt_completion, which
					// prompts a separate "completion_result" ask -- approve that too so
					// RooCodeEventName.TaskCompleted (what waitUntilCompleted waits on) fires.
					await waitFor(() => asksByTaskId[taskId]?.some(({ ask }) => ask === "completion_result") ?? false)
					await api.approveCurrentAsk()

					return taskId
				},
			})
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}

		const asks = ourTaskId ? (asksByTaskId[ourTaskId] ?? []) : []

		assert.ok(
			asks.some(({ ask }) => ask === "api_req_failed"),
			"Should have prompted for retry after the empty assistant response",
		)

		// The task must have completed at all -- if the user message was dropped on
		// retry (the bug), the retried request would still be missing the user's turn,
		// and depending on API validation this could hang, error, or produce a
		// nonsensical response instead of reaching completion via waitUntilCompleted above.
		//
		// The request count itself is intentionally >= 2 rather than exactly 2: after the
		// retry succeeds, the framework's own tool_result-interruption recovery
		// (validateAndFixToolResultIds, unrelated to this fix) can occasionally inject an
		// extra self-correcting exchange if the attempt_completion tool result hasn't been
		// recorded by the time the next turn is built. That's expected, independently
		// tested framework behavior -- what this test cares about is specifically the
		// *first retry request* (index 1, immediately after the empty response), which is
		// exactly what the userMessageWasRemoved fix governs.
		assert.ok(
			mockServer.requestBodies.length >= 2,
			`Should have made at least 2 requests (initial + retry), got ${mockServer.requestBodies.length}`,
		)

		const retryRequestBody = mockServer.requestBodies[1] as { messages?: Array<{ content?: unknown[] }> }
		const retryRequestJson = JSON.stringify(retryRequestBody)

		assert.ok(
			retryRequestJson.includes("bedrock-empty-response-retry-smoke"),
			"The retried request must still include the user's original message text " +
				"(regression check: userMessageWasRemoved must be set so the message is re-added before retrying)",
		)
	})
})
