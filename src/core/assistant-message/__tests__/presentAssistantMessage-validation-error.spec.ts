// npx vitest run src/core/assistant-message/__tests__/presentAssistantMessage-validation-error.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"

// Mock dependencies
vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	// isValidToolName: true means this is a *known* tool name, so it reaches recordToolUsage's
	// gate -- but validateToolUse itself still throws (e.g. mode-disallowed), which is the gap
	// this suite covers: that thrown error must not leave the attempt unrecorded in telemetry.
	validateToolUse: vi.fn(() => {
		throw new Error('Tool "read_file" is not allowed in ask mode.')
	}),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

describe("presentAssistantMessage - validateToolUse throws", () => {
	let mockTask: any

	beforeEach(() => {
		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [],
			userMessageContent: [],
			didCompleteReadingStream: false,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			api: {
				getModel: () => ({ id: "test-model", info: {} }),
			},
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "ask",
						customModes: [],
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		}

		mockTask.pushToolResultToUserContent = vi.fn().mockImplementation((toolResult: any) => {
			const existingResult = mockTask.userMessageContent.find(
				(block: any) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
			)
			if (existingResult) {
				return false
			}
			mockTask.userMessageContent.push(toolResult)
			return true
		})
	})

	it("records a tool error when a known tool fails validateToolUse validation", async () => {
		const toolCallId = "tool_call_mode_disallowed"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "read_file",
				params: { path: "foo.ts" },
				nativeArgs: { path: "foo.ts" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask)

		// The failed attempt must not vanish from telemetry: neither recordToolUsage (the tool
		// never actually ran) nor silence -- it must show up via recordToolError instead.
		expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
		expect(mockTask.recordToolError).toHaveBeenCalledWith(
			"read_file",
			expect.stringContaining("not allowed in ask mode"),
		)

		// The tool_result error is still sent to the model as before.
		const toolResult = mockTask.userMessageContent.find(
			(item: any) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)
		expect(toolResult).toBeDefined()
		expect(toolResult.is_error).toBe(true)
	})
})
