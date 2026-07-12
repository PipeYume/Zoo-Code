// npx vitest run core/task/__tests__/messageCounting.retrySymmetry.spec.ts

import { shouldAddUserMessageToHistory } from "../messageCounting"

/**
 * Regression coverage for the empty-assistant-response retry cycle in
 * Task#recursivelyMakeClineRequests: the user message is added once (incrementing
 * messageCounts.user), popped when the assistant fails to respond (decrementing
 * messageCounts.user to match), then re-added on retry via userMessageWasRemoved
 * (incrementing messageCounts.user again). This exercises that increment/decrement/
 * increment sequence end-to-end using the same primitives Task.ts calls, without
 * needing to drive the full streaming loop -- see
 * apps/vscode-e2e/src/suite/providers/bedrock-empty-response-retry.test.ts for the
 * end-to-end proof that the retried request actually includes the user's message.
 */
describe("empty-assistant-response retry keeps messageCounts.user symmetric", () => {
	function simulateAttempt(
		messageCounts: { user: number; assistant: number },
		params: {
			retryAttempt: number | undefined
			isEmptyUserContent: boolean
			userMessageWasRemoved: boolean | undefined
		},
	) {
		if (shouldAddUserMessageToHistory(params)) {
			messageCounts.user++
		}
	}

	function simulatePopOnEmptyResponse(messageCounts: { user: number; assistant: number }) {
		// Mirrors Task.ts: popping the just-added user message from apiConversationHistory
		// is paired with decrementing messageCounts.user to match.
		messageCounts.user--
	}

	it("ends at 1 after one empty-response retry that then succeeds (not 2)", () => {
		const messageCounts = { user: 0, assistant: 0 }

		// First attempt: message added, count incremented.
		simulateAttempt(messageCounts, { retryAttempt: 0, isEmptyUserContent: false, userMessageWasRemoved: false })
		expect(messageCounts.user).toBe(1)

		// Assistant returns nothing -- Task.ts pops the message it just added.
		simulatePopOnEmptyResponse(messageCounts)
		expect(messageCounts.user).toBe(0)

		// Retry (either auto or manual-approved branch) re-adds it via userMessageWasRemoved.
		simulateAttempt(messageCounts, { retryAttempt: 1, isEmptyUserContent: false, userMessageWasRemoved: true })

		// Exactly one logical user turn occurred -- the count must reflect that, not 2.
		expect(messageCounts.user).toBe(1)
	})

	it("stays symmetric across multiple consecutive empty-response retries", () => {
		const messageCounts = { user: 0, assistant: 0 }

		simulateAttempt(messageCounts, { retryAttempt: 0, isEmptyUserContent: false, userMessageWasRemoved: false })
		simulatePopOnEmptyResponse(messageCounts)

		simulateAttempt(messageCounts, { retryAttempt: 1, isEmptyUserContent: false, userMessageWasRemoved: true })
		simulatePopOnEmptyResponse(messageCounts)

		simulateAttempt(messageCounts, { retryAttempt: 2, isEmptyUserContent: false, userMessageWasRemoved: true })
		simulatePopOnEmptyResponse(messageCounts)

		// Final successful attempt.
		simulateAttempt(messageCounts, { retryAttempt: 3, isEmptyUserContent: false, userMessageWasRemoved: true })

		expect(messageCounts.user).toBe(1)
	})

	it("never goes negative when a message is popped and correctly re-added", () => {
		const messageCounts = { user: 0, assistant: 0 }

		simulateAttempt(messageCounts, { retryAttempt: 0, isEmptyUserContent: false, userMessageWasRemoved: false })
		simulatePopOnEmptyResponse(messageCounts)
		simulateAttempt(messageCounts, { retryAttempt: 1, isEmptyUserContent: false, userMessageWasRemoved: true })

		expect(messageCounts.user).toBeGreaterThanOrEqual(0)
	})
})
