import { checkAutoApproval } from ".."

describe("Destructive Command Guard auto-approval precedence", () => {
	const baseState = {
		autoApprovalEnabled: true,
		alwaysAllowExecute: true,
		alwaysAllowReadOnly: false,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		alwaysAllowWrite: false,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		alwaysAllowMcp: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		alwaysAllowFollowupQuestions: false,
		allowedCommands: ["echo"],
		deniedCommands: ["rm"],
		alwaysAllowCommandsExceptDenied: false,
		destructiveCommandGuardEnabled: true,
		mcpServers: [],
	}

	it("ignores Zoo's deny list while DCG is enabled", async () => {
		expect(await checkAutoApproval({ state: baseState, ask: "command", text: "rm file" })).toEqual({
			decision: "ask",
		})
	})

	it("requires explicit approval for a DCG-protected command", async () => {
		expect(
			await checkAutoApproval({ state: baseState, ask: "command", text: "echo safe", isProtected: true }),
		).toEqual({ decision: "ask" })
	})

	it("retains ordinary allowlist auto-approval for DCG-allowed commands", async () => {
		expect(await checkAutoApproval({ state: baseState, ask: "command", text: "echo safe" })).toEqual({
			decision: "approve",
		})
	})
})
