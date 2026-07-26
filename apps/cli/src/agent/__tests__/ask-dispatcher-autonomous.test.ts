import type { ClineAsk, ClineMessage } from "@roo-code/types"

import { AskDispatcher } from "../ask-dispatcher.js"
import type { OutputManager } from "../output-manager.js"
import type { PromptManager } from "../prompt-manager.js"

describe("AskDispatcher autonomous input policy", () => {
	function createDispatcher(onInputRequired: (ask: ClineAsk, text: string) => void): AskDispatcher {
		return new AskDispatcher({
			outputManager: {
				output: vi.fn(),
				markDisplayed: vi.fn(),
			} as unknown as OutputManager,
			promptManager: {} as PromptManager,
			sendMessage: vi.fn(),
			nonInteractive: true,
			onInputRequired,
		})
	}

	it("reports provider failures without retrying or waiting", async () => {
		const onInputRequired = vi.fn()
		const dispatcher = createDispatcher(onInputRequired)

		await expect(
			dispatcher.handleAsk({ ts: 1, type: "ask", ask: "api_req_failed", text: "rate limited" } as ClineMessage),
		).resolves.toEqual({ handled: true })
		expect(onInputRequired).toHaveBeenCalledWith("api_req_failed", "rate limited")
	})

	it("reports unknown asks instead of leaving the task blocked", async () => {
		const onInputRequired = vi.fn()
		const dispatcher = createDispatcher(onInputRequired)

		await expect(
			dispatcher.handleAsk({ ts: 2, type: "ask", ask: "unknown" as ClineAsk, text: "decide" } as ClineMessage),
		).resolves.toEqual({ handled: true })
		expect(onInputRequired).toHaveBeenCalledWith("unknown", "decide")
	})
})
