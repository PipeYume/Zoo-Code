import fs from "fs"
import os from "os"
import path from "path"

import type { FlagOptions } from "@/types/index.js"
import { AUTONOMOUS_EXIT_CODES, AutonomousRunError } from "@/agent/autonomous-run.js"

const mocks = vi.hoisted(() => ({
	hostOptions: [] as Array<Record<string, unknown>>,
	terminalEvents: [] as Array<Record<string, unknown>>,
	lastTaskResult: undefined as { rootTaskId?: string; result?: string } | undefined,
	loadSettings: vi.fn(async () => ({})),
	readWorkspaceTaskSessions: vi.fn(async () => []),
	resolveWorkspaceResumeSessionId: vi.fn(),
	activate: vi.fn(async () => {}),
	runTask: vi.fn(async () => {}),
	resumeTask: vi.fn(async () => {}),
	cancelTask: vi.fn(async () => {}),
	dispose: vi.fn(async () => {}),
	emitterFlush: vi.fn(async () => {}),
	emitterDetach: vi.fn(),
	emitterAttach: vi.fn(),
}))

vi.mock("@roo-code/vscode-shim", () => ({ setLogger: vi.fn() }))
vi.mock("@/lib/storage/index.js", () => ({ loadSettings: mocks.loadSettings }))
vi.mock("@/lib/task-history/index.js", () => ({
	readWorkspaceTaskSessions: mocks.readWorkspaceTaskSessions,
	resolveWorkspaceResumeSessionId: mocks.resolveWorkspaceResumeSessionId,
}))
vi.mock("@/lib/utils/provider.js", () => ({
	getEnvVarName: vi.fn(() => "OPENROUTER_API_KEY"),
	getApiKeyFromEnv: vi.fn(() => undefined),
}))
vi.mock("@/lib/utils/shell.js", () => ({
	validateTerminalShellPath: vi.fn(async (shellPath: string) => ({ valid: true, shellPath })),
}))
vi.mock("@/lib/utils/extension.js", () => ({ getDefaultExtensionPath: vi.fn(() => "/extension") }))
vi.mock("@/lib/utils/onboarding.js", () => ({ runOnboarding: vi.fn(async () => {}) }))
vi.mock("@/agent/index.js", () => ({
	ExtensionHost: vi.fn(function (options: Record<string, unknown>) {
		mocks.hostOptions.push(options)
		return {
			client: {},
			activate: mocks.activate,
			runTask: mocks.runTask,
			resumeTask: mocks.resumeTask,
			cancelTask: mocks.cancelTask,
			dispose: mocks.dispose,
			getLastTaskResult: () => mocks.lastTaskResult,
			getRootTaskId: () => mocks.lastTaskResult?.rootTaskId,
		}
	}),
}))
vi.mock("@/agent/json-event-emitter.js", () => ({
	JsonEventEmitter: vi.fn(function () {
		return {
			attachToClient: mocks.emitterAttach,
			detach: mocks.emitterDetach,
			flush: mocks.emitterFlush,
			emitTerminal: (event: Record<string, unknown>) => mocks.terminalEvents.push(event),
		}
	}),
}))
vi.mock("../stdin-stream.js", () => ({ runStdinStreamMode: vi.fn(async () => {}) }))

import { run } from "../run.js"

function autonomousFlags(workspace: string, overrides: Partial<FlagOptions> = {}): FlagOptions {
	return {
		continue: false,
		print: true,
		stdinPromptStream: false,
		signalOnlyExit: false,
		debug: false,
		requireApproval: false,
		autonomous: true,
		timeout: 10,
		exitOnError: false,
		apiKey: "test-key",
		provider: "openrouter",
		model: "test-model",
		workspace,
		extension: "/extension",
		ephemeral: true,
		oneshot: false,
		outputFormat: "stream-json",
		...overrides,
	}
}

describe("run command autonomous lifecycle", () => {
	let workspace: string
	let exitSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "zoo-run-test-"))
		mocks.hostOptions.length = 0
		mocks.terminalEvents.length = 0
		mocks.lastTaskResult = undefined
		vi.clearAllMocks()
		mocks.loadSettings.mockResolvedValue({})
		mocks.readWorkspaceTaskSessions.mockResolvedValue([])
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
	})

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("canonicalizes autonomous configuration and emits one successful root outcome", async () => {
		mocks.lastTaskResult = { rootTaskId: "root-1", result: "finished" }

		await run("do the work", autonomousFlags(workspace, { providerBaseUrl: "http://127.0.0.1:1234/v1" }))

		expect(mocks.hostOptions).toEqual([
			expect.objectContaining({
				mode: "orchestrator",
				autonomous: true,
				nonInteractive: true,
				exitOnComplete: true,
				taskTimeoutMs: 10_000,
				workspacePath: fs.realpathSync(workspace),
				providerBaseUrl: "http://127.0.0.1:1234/v1",
			}),
		])
		expect(mocks.activate).toHaveBeenCalledOnce()
		expect(mocks.runTask).toHaveBeenCalledWith("do the work", undefined)
		expect(mocks.terminalEvents).toEqual([
			{ state: "completed", exitCode: 0, content: "finished", rootTaskId: "root-1" },
		])
		expect(mocks.emitterDetach).toHaveBeenCalledOnce()
		expect(mocks.dispose).toHaveBeenCalledOnce()
		expect(mocks.emitterFlush).toHaveBeenCalledOnce()
		expect(exitSpy).toHaveBeenCalledOnce()
		expect(exitSpy).toHaveBeenCalledWith(0)
	})

	it("loads prompt-file content before starting the task", async () => {
		const promptFile = path.join(workspace, "prompt.md")
		fs.writeFileSync(promptFile, "prompt from file")
		mocks.lastTaskResult = { rootTaskId: "root-file", result: "done" }

		await run(undefined, autonomousFlags(workspace, { promptFile }))

		expect(mocks.runTask).toHaveBeenCalledWith("prompt from file", undefined)
	})

	it("resumes the resolved workspace session instead of creating a task", async () => {
		const sessionId = "123e4567-e89b-42d3-a456-426614174000"
		mocks.resolveWorkspaceResumeSessionId.mockReturnValue(sessionId)
		mocks.lastTaskResult = { rootTaskId: sessionId, result: "resumed" }

		await run(undefined, autonomousFlags(workspace, { sessionId }))

		expect(mocks.resumeTask).toHaveBeenCalledWith(sessionId)
		expect(mocks.runTask).not.toHaveBeenCalled()
	})

	it.each([
		["needs_input", 2],
		["provider_failed", 4],
		["tool_failed", 5],
		["cancelled", 6],
		["timed_out", 124],
	] as const)("maps %s failures to one terminal outcome and its exit code", async (state, exitCode) => {
		mocks.lastTaskResult = { rootTaskId: "root-error" }
		mocks.runTask.mockRejectedValueOnce(new AutonomousRunError(state, `${state} detail`))

		await run("fail", autonomousFlags(workspace))

		expect(mocks.terminalEvents).toEqual([
			{ state, exitCode, content: `${state} detail`, rootTaskId: "root-error" },
		])
		expect(mocks.cancelTask).toHaveBeenCalledOnce()
		expect(mocks.dispose).toHaveBeenCalledOnce()
		expect(exitSpy).toHaveBeenCalledWith(exitCode)
	})

	it("maps an unexpected host crash to crashed/70 and still cleans up", async () => {
		mocks.activate.mockRejectedValueOnce(new Error("extension crashed"))

		await run("crash", autonomousFlags(workspace))

		expect(mocks.terminalEvents).toEqual([
			{ state: "crashed", exitCode: 70, content: "extension crashed", rootTaskId: undefined },
		])
		expect(mocks.cancelTask).toHaveBeenCalledOnce()
		expect(mocks.dispose).toHaveBeenCalledOnce()
		expect(exitSpy).toHaveBeenCalledWith(70)
	})

	it("emits a parseable configuration terminal and never constructs a host", async () => {
		const chunks: string[] = []
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			chunks.push(chunk.toString())
			return true
		}) as never)
		exitSpy.mockImplementation(((code: number) => {
			throw new Error(`exit:${code}`)
		}) as never)

		await expect(run("invalid", autonomousFlags(workspace, { mode: "code" }))).rejects.toThrow("exit:78")

		expect(JSON.parse(chunks.join(""))).toEqual(
			expect.objectContaining({
				type: "result",
				subtype: "terminal",
				state: "configuration_error",
				exitCode: AUTONOMOUS_EXIT_CODES.configuration_error,
				success: false,
				done: true,
			}),
		)
		expect(mocks.hostOptions).toHaveLength(0)
	})

	it("returns configuration errors for malformed autonomous inputs before activation", async () => {
		const validId = "123e4567-e89b-42d3-a456-426614174000"
		const promptFile = path.join(workspace, "missing-prompt.md")
		const workspaceFile = path.join(workspace, "not-a-directory")
		fs.writeFileSync(workspaceFile, "file")
		const cases: Array<[string | undefined, Partial<FlagOptions>]> = [
			["task", { promptFile }],
			["task", { createWithSessionId: " " }],
			[undefined, { sessionId: " " }],
			["task", { createWithSessionId: "not-a-uuid" }],
			[undefined, { sessionId: "not-a-uuid" }],
			[undefined, { createWithSessionId: validId, continue: true }],
			[undefined, { sessionId: validId, continue: true }],
			["task", { sessionId: validId }],
			["task", { consecutiveMistakeLimit: -1 }],
			["task", { apiKey: undefined }],
			["task", { reasoningEffort: "invalid" as FlagOptions["reasoningEffort"] }],
			["task", { outputFormat: "invalid" as FlagOptions["outputFormat"] }],
			[undefined, {}],
			["task", { workspace: path.join(workspace, "missing-workspace") }],
			["task", { workspace: workspaceFile }],
			["task", { provider: "invalid" as FlagOptions["provider"] }],
		]
		exitSpy.mockImplementation(((code: number) => {
			throw new Error(`exit:${code}`)
		}) as never)
		vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never)
		vi.spyOn(console, "error").mockImplementation(() => {})

		for (const [prompt, overrides] of cases) {
			await expect(run(prompt, autonomousFlags(workspace, overrides))).rejects.toThrow("exit:78")
		}

		expect(mocks.activate).not.toHaveBeenCalled()
	})

	it("prints a text terminal failure without producing machine output", async () => {
		mocks.runTask.mockRejectedValueOnce(new AutonomousRunError("provider_failed", "provider unavailable"))
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await run("fail", autonomousFlags(workspace, { outputFormat: "text" }))

		expect(consoleError).toHaveBeenCalledWith("[CLI] provider_failed: provider unavailable")
		expect(mocks.terminalEvents).toHaveLength(0)
		expect(exitSpy).toHaveBeenCalledWith(4)
	})

	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const)("cancels, emits once, and exits on %s", async (signal, exitCode) => {
		mocks.lastTaskResult = { rootTaskId: "root-signal" }
		mocks.runTask.mockImplementationOnce(() => new Promise<void>(() => {}))
		const existingListeners = new Set(process.listeners(signal))
		void run("wait", autonomousFlags(workspace))
		await vi.waitFor(() => expect(mocks.runTask).toHaveBeenCalledOnce())
		const handler = process.listeners(signal).find((listener) => !existingListeners.has(listener))
		expect(handler).toBeDefined()

		handler!(signal)
		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(exitCode))

		expect(mocks.cancelTask).toHaveBeenCalledOnce()
		expect(mocks.terminalEvents).toEqual([
			{ state: "cancelled", exitCode, content: `Received ${signal}`, rootTaskId: "root-signal" },
		])
		expect(mocks.dispose).toHaveBeenCalledOnce()
	})

	it("lets a repeated SIGINT force native termination without a second terminal", async () => {
		mocks.runTask.mockImplementationOnce(() => new Promise<void>(() => {}))
		mocks.cancelTask.mockImplementationOnce(() => new Promise<void>(() => {}))
		const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never)
		const existingListeners = new Set(process.listeners("SIGINT"))
		void run("wait", autonomousFlags(workspace))
		await vi.waitFor(() => expect(mocks.runTask).toHaveBeenCalledOnce())
		const handler = process.listeners("SIGINT").find((listener) => !existingListeners.has(listener))

		handler!("SIGINT")
		handler!("SIGINT")

		expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT")
		expect(mocks.terminalEvents).toHaveLength(0)
	})

	it.each([
		["uncaughtException", new Error("uncaught crash")],
		["unhandledRejection", "rejected crash"],
	] as const)("turns %s into a crashed terminal and cleans up", async (eventName, reason) => {
		mocks.lastTaskResult = { rootTaskId: "root-runtime-crash" }
		mocks.runTask.mockImplementationOnce(() => new Promise<void>(() => {}))
		const processEmitter = process as unknown as {
			listeners: (event: string) => Array<(...args: unknown[]) => void>
		}
		const existingListeners = new Set(processEmitter.listeners(eventName))
		void run("wait", autonomousFlags(workspace))
		await vi.waitFor(() => expect(mocks.runTask).toHaveBeenCalledOnce())
		const handler = processEmitter.listeners(eventName).find((listener) => !existingListeners.has(listener))

		handler!(reason)
		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(70))

		expect(mocks.terminalEvents).toEqual([
			{
				state: "crashed",
				exitCode: 70,
				content: reason instanceof Error ? reason.message : reason,
				rootTaskId: "root-runtime-crash",
			},
		])
		expect(mocks.cancelTask).toHaveBeenCalledOnce()
		expect(mocks.dispose).toHaveBeenCalledOnce()
	})
})
