import { EventEmitter } from "events"

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import { RooCodeEventName } from "@roo-code/types"

import { ClineProvider } from "../../core/webview/ClineProvider"
import { API } from "../api"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

type FakeTask = EventEmitter & {
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	pendingAskId?: number
	respondToAsk: ReturnType<typeof vi.fn>
}

function createTask(taskId: string, options: { rootTaskId?: string; parentTaskId?: string } = {}): FakeTask {
	return Object.assign(new EventEmitter(), {
		taskId,
		...options,
		respondToAsk: vi.fn().mockReturnValue(true),
	})
}

describe("API headless facade", () => {
	let api: API
	let providerEvents: EventEmitter
	let history: Map<string, { status?: string }>
	let provider: ClineProvider
	let rootTask: FakeTask
	let currentTask: FakeTask | undefined
	let createTaskMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		providerEvents = new EventEmitter()
		history = new Map()
		rootTask = createTask("root-1")
		currentTask = rootTask
		createTaskMock = vi.fn().mockImplementation(async () => {
			providerEvents.emit(RooCodeEventName.TaskCreated, rootTask)
			return rootTask
		})

		const fakeProvider = {
			context: {},
			on: providerEvents.on.bind(providerEvents),
			waitUntilReady: vi.fn().mockResolvedValue(undefined),
			createTask: createTaskMock,
			createTaskWithHistoryItem: vi.fn(),
			getTaskWithId: vi.fn(),
			getTaskById: vi.fn((taskId: string) => (taskId === currentTask?.taskId ? currentTask : undefined)),
			getCurrentTask: vi.fn(() => currentTask),
			cancelTask: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
			taskHistoryStore: { get: (taskId: string) => history.get(taskId) },
		}
		// ClineProvider is concrete and has private state; this precise fake exercises only the API boundary above.
		provider = fakeProvider as unknown as ClineProvider
		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, provider)
	})

	it("starts directly without invoking VS Code or a webview", async () => {
		await expect(api.startHeadlessTask({ text: "  preserve whitespace  " })).resolves.toEqual({
			taskId: "root-1",
			rootTaskId: "root-1",
		})
		expect(createTaskMock).toHaveBeenCalledWith("  preserve whitespace  ", undefined, undefined, {}, undefined)
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
	})

	it("routes a response only to the matching task and ask", async () => {
		await api.startHeadlessTask({ text: "task" })
		await api.respondToHeadlessAsk({ taskId: "root-1", askId: "42", response: { response: "reject" } })
		expect(rootTask.respondToAsk).toHaveBeenCalledWith(42, "noButtonClicked", undefined, undefined)
		await expect(
			api.respondToHeadlessAsk({ taskId: "other", askId: "42", response: { response: "approve" } }),
		).rejects.toThrow("not active")
	})

	it("ignores child completion and waits for persisted root completion", async () => {
		await api.startHeadlessTask({ text: "delegate" })
		const child = createTask("child-1", { rootTaskId: "root-1", parentTaskId: "root-1" })
		providerEvents.emit(RooCodeEventName.TaskCreated, child)
		child.emit(RooCodeEventName.TaskCompleted, "child-1", {}, {})
		expect(await api.getHeadlessTaskResult("root-1")).toBeUndefined()

		history.set("root-1", { status: "completed" })
		rootTask.emit(RooCodeEventName.TaskCompleted, "root-1", { totalTokensIn: 1 }, {})
		await expect(api.waitForHeadlessTaskResult("root-1")).resolves.toMatchObject({
			outcome: "completed",
			rootTaskId: "root-1",
		})
	})

	it("settles cancellation only after canonical cancellation returns", async () => {
		await api.startHeadlessTask({ text: "cancel" })
		history.set("root-1", { status: "interrupted" })
		const settlement = await api.cancelHeadlessTask({ rootTaskId: "root-1", reason: "signal" })
		expect(provider.cancelTask).toHaveBeenCalledWith({ rehydrate: false })
		expect(settlement).toEqual({ rootTaskId: "root-1", resumable: true, status: "interrupted" })
		await expect(api.waitForHeadlessTaskResult("root-1")).resolves.toMatchObject({ outcome: "cancelled" })
	})

	it("settles pending runs and disposes exactly once on shutdown", async () => {
		await api.startHeadlessTask({ text: "pending" })
		await expect(api.shutdownHeadless()).resolves.toEqual({ settledRuns: 1, pendingRuns: 1 })
		await expect(api.waitForHeadlessTaskResult("root-1")).resolves.toMatchObject({
			outcome: "failed",
			error: { code: "shutdown" },
		})
		await api.shutdownHeadless()
		expect(provider.dispose).toHaveBeenCalledTimes(1)
	})
})
