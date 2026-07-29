// npx vitest run src/core/task/__tests__/delegation-concurrent.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { HistoryItem } from "@roo-code/types"

import { ClineProvider } from "../../webview/ClineProvider"
import { TaskScheduler } from "../TaskScheduler"
import { TaskRegistry } from "../TaskRegistry"
import { type Task } from "../Task"
import { makeProviderStub } from "../../../__tests__/helpers/provider-stub"

function makeParent(overrides: Record<string, unknown> = {}): Task {
	return {
		taskId: "parent-1",
		clineMessages: [] as unknown[],
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		retrySaveApiConversationHistory: vi.fn().mockResolvedValue(true),
		abort: false,
		abandoned: false,
		...overrides,
	} as unknown as Task
}

function makeChild(overrides: Record<string, unknown> = {}): Task {
	return {
		taskId: "child-1",
		clineMessages: [] as unknown[],
		abort: false,
		abandoned: false,
		run: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as Task
}

/**
 * Real createTask() pushes the child onto taskRegistry (which also focuses
 * it) before returning. Mirror that here so the fan-out branch has a real
 * registry entry to operate on, same as production.
 */
function makeCreateTaskMock(provider: ClineProvider, child: Task) {
	return vi.fn().mockImplementation(async () => {
		;(provider as unknown as { taskRegistry: { push: (t: Task) => void } }).taskRegistry.push(child)
		return child
	})
}

function baseStubFields(parent: Task) {
	const atomicReadAndUpdate = vi.fn(async (_id: string, updater: (h: HistoryItem) => HistoryItem) =>
		updater({ id: "parent-1", status: "active", childIds: [] } as unknown as HistoryItem),
	)
	return {
		contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
		getCurrentTask: vi.fn(() => parent),
		handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		taskHistoryStore: {
			get: vi.fn(() => undefined),
			atomicReadAndUpdate,
		},
		isViewLaunched: false,
		emit: vi.fn(),
		deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
		getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: "parent-1" } }),
		createTaskWithHistoryItem: vi.fn().mockResolvedValue(parent),
	}
}

function getRunningTasks(provider: ClineProvider): Task[] {
	return ClineProvider.prototype.getRunningTasks.call(provider)
}

function callDelegate(provider: ClineProvider) {
	return (
		ClineProvider.prototype as unknown as {
			delegateParentAndOpenChild: (params: {
				parentTaskId: string
				message: string
				initialTodos: never[]
				mode: string
			}) => Promise<Task>
		}
	).delegateParentAndOpenChild.call(provider, {
		parentTaskId: "parent-1",
		message: "do work",
		initialTodos: [],
		mode: "code",
	})
}

describe("delegateParentAndOpenChild — fan-out (Story 3.2b)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("maxConcurrency=1: removeClineFromStack is still called — existing behavior fully preserved", async () => {
		const parent = makeParent()
		const child = makeChild()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue(child)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(1),
			removeClineFromStack,
			createTask,
		})

		await callDelegate(provider)

		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
	})

	it("maxConcurrency=2 with a free permit: parent stays active, fan-out path is taken", async () => {
		const parent = makeParent()
		const child = makeChild()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(2),
			removeClineFromStack,
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await callDelegate(provider)

		// Parent must not be suspended.
		expect(removeClineFromStack).not.toHaveBeenCalled()
		// UI focus moves to the child, parent remains in the registry.
		const registry = (provider as unknown as { taskRegistry: TaskRegistry }).taskRegistry
		expect(registry.current?.taskId).toBe("child-1")
		expect(registry.getById("parent-1")).toBeDefined()
	})

	it("maxConcurrency=2 but no free permit: falls back to the suspending (maxConcurrency=1) path", async () => {
		const parent = makeParent()
		const child = makeChild()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue(child)

		const scheduler = new TaskScheduler(2)
		// Occupy both permits so none are free for fan-out. Don't await —
		// the occupying "run" functions never resolve on purpose.
		void scheduler.schedule(makeParent({ taskId: "occupant-1" }), () => new Promise<void>(() => {}))
		void scheduler.schedule(makeParent({ taskId: "occupant-2" }), () => new Promise<void>(() => {}))
		// Let both schedule() calls' internal sem.acquire() microtasks settle so
		// both permits are actually held before we check availability.
		await Promise.resolve()
		await Promise.resolve()

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: scheduler,
			removeClineFromStack,
			createTask,
		})

		await callDelegate(provider)

		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
	})

	it("fan-out path: both parent and child are tracked in the registry with no shared clineMessages reference", async () => {
		const parent = makeParent({ clineMessages: [{ text: "parent msg" }] })
		const child = makeChild({ clineMessages: [{ text: "child msg" }] })

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(2),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await callDelegate(provider)

		const running = getRunningTasks(provider).map((t) => t.taskId)
		expect(running).toContain("parent-1")
		expect(running).toContain("child-1")
		expect(parent.clineMessages).not.toBe(child.clineMessages)
	})

	it("fan-out path: the child's run() actually starts concurrently with the parent, not just the registry bookkeeping", async () => {
		const parent = makeParent()
		let parentResolve!: () => void
		// The parent's own request loop is "in flight" (never resolves during
		// this test) — provided as run() the way ClineProvider's real scheduler
		// invocation for the parent would use it, to prove the child does not
		// wait for the parent to finish.
		const parentRun = vi.fn(() => new Promise<void>((res) => (parentResolve = res)))

		let childStarted = false
		let childResolve!: () => void
		const child = makeChild({
			run: vi.fn().mockImplementation(() => {
				childStarted = true
				return new Promise<void>((res) => (childResolve = res))
			}),
		})

		const scheduler = new TaskScheduler(2)
		// Occupy one permit with the "parent's own request loop" so only one
		// permit remains — exactly the scenario fan-out is meant to handle.
		void scheduler.schedule(parent, parentRun)
		await Promise.resolve()

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: scheduler,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await callDelegate(provider)
		// Let the reserved-permit run() invocation's microtask fire.
		await Promise.resolve()
		await Promise.resolve()

		expect(childStarted).toBe(true)
		expect(child.run).toHaveBeenCalledTimes(1)

		childResolve()
		parentResolve()
	})

	it("fan-out path: persisted parent history status is still 'delegated' (awaiting child), independent of the in-memory registry", async () => {
		// Fan-out only changes whether the parent Task instance stays alive in
		// TaskRegistry — it does not change what delegateParentAndOpenChild
		// persists to TaskHistoryStore. The parent's HistoryItem status becomes
		// "delegated" (awaiting the child) in both the fan-out and suspending
		// paths; "both recorded as active simultaneously" is not the intended
		// semantics here, even though the parent Task keeps running in memory.
		const parent = makeParent()
		const child = makeChild()
		let persistedParent: HistoryItem | undefined

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(2),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			taskHistoryStore: {
				get: vi.fn(() => undefined),
				atomicReadAndUpdate: vi.fn(async (_id: string, updater: (h: HistoryItem) => HistoryItem) => {
					persistedParent = updater({
						id: "parent-1",
						status: "active",
						childIds: [],
					} as unknown as HistoryItem)
					return persistedParent
				}),
			},
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await callDelegate(provider)

		expect(persistedParent?.status).toBe("delegated")
		expect(persistedParent?.awaitingChildId).toBe("child-1")
		// But the parent Task instance itself is still live and running in the registry.
		expect(getRunningTasks(provider).map((t) => t.taskId)).toContain("parent-1")
	})

	it("permit is reserved atomically at the fan-out decision — a concurrent delegation cannot steal the last free permit", async () => {
		// maxConcurrency=2, one permit already held by an unrelated running task,
		// leaving exactly one free — the contested permit.
		const scheduler = new TaskScheduler(2)
		void scheduler.schedule(makeParent({ taskId: "occupant" }), () => new Promise<void>(() => {}))
		await Promise.resolve()
		expect(scheduler.available).toBe(1)

		// Two reservation attempts race for the single remaining permit. Because
		// tryReserve() has no await before the underlying semaphore decrements
		// its count, only one can win even though both observe available === 1
		// beforehand.
		const [first, second] = await Promise.all([scheduler.tryReserve(), scheduler.tryReserve()])

		const wins = [first, second].filter((r) => r !== undefined)
		expect(wins).toHaveLength(1)
		expect(scheduler.available).toBe(0)
	})

	it("getRunningTasks() exposes all concurrently active tasks", () => {
		const parent = makeParent()
		const child = makeChild()
		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent, child],
			taskScheduler: new TaskScheduler(2),
		})

		expect(getRunningTasks(provider).map((t) => t.taskId)).toEqual(["parent-1", "child-1"])
	})
})
