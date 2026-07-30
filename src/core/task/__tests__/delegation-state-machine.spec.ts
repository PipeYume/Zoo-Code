// npx vitest run src/core/task/__tests__/delegation-state-machine.spec.ts

import { describe, expect, it } from "vitest"

type Profile = "parent-profile" | "child-profile"
type Focus = "parent" | "child" | "none"
type Phase =
	| "parent-running"
	| "parent-suspended"
	| "permit-reserved"
	| "child-profile-selected"
	| "child-created"
	| "delegation-persisted"
	| "child-running"
	| "child-completed"
	| "failed"

interface TaskModel {
	live: boolean
	localProfile: Profile
	historyStatus: "active" | "delegated" | "completed"
}

interface ModelState {
	phase: Phase
	maxConcurrency: number
	permitsHeld: number
	reservedPermit: boolean
	focus: Focus
	globalProfile: Profile
	parent: TaskModel
	child?: TaskModel
	trace: string[]
}

interface Transition {
	name: string
	canApply: (state: ModelState) => boolean
	apply: (state: ModelState) => ModelState
}

function cloneState(state: ModelState): ModelState {
	return {
		...state,
		parent: { ...state.parent },
		child: state.child ? { ...state.child } : undefined,
		trace: [...state.trace],
	}
}

function transition(name: string, state: ModelState, patch: (next: ModelState) => void): ModelState {
	const next = cloneState(state)
	next.trace.push(name)
	patch(next)
	return next
}

function activePermitCount(state: ModelState): number {
	return state.permitsHeld + (state.reservedPermit ? 1 : 0)
}

function assertInvariants(state: ModelState) {
	const trace = state.trace.join(" -> ")

	expect(activePermitCount(state), `permit bound violated after ${trace}`).toBeLessThanOrEqual(state.maxConcurrency)
	expect(state.permitsHeld, `negative held permits after ${trace}`).toBeGreaterThanOrEqual(0)

	if (state.parent.live) {
		expect(state.parent.localProfile, `parent profile leaked after ${trace}`).toBe("parent-profile")
	}

	if (state.child?.live) {
		expect(state.child.localProfile, `child profile was not scoped after ${trace}`).toBe("child-profile")
	}

	if (state.phase === "failed") {
		expect(state.reservedPermit, `failed delegation leaked a reserved permit after ${trace}`).toBe(false)
		expect(state.parent.live, `failed delegation lost the parent after ${trace}`).toBe(true)
		expect(state.focus, `failed delegation did not restore parent focus after ${trace}`).toBe("parent")
	}

	if (state.phase === "child-running") {
		expect(state.parent.historyStatus, `running child without delegated parent history after ${trace}`).toBe(
			"delegated",
		)
		expect(state.child?.live, `child-running phase without live child after ${trace}`).toBe(true)
	}
}

function initialFanOutState(): ModelState {
	return {
		phase: "parent-running",
		maxConcurrency: 2,
		permitsHeld: 1,
		reservedPermit: false,
		focus: "parent",
		globalProfile: "parent-profile",
		parent: {
			live: true,
			localProfile: "parent-profile",
			historyStatus: "active",
		},
		trace: [],
	}
}

const fanOutTransitions: Transition[] = [
	{
		name: "reserve fan-out permit",
		canApply: (state) => state.phase === "parent-running" && activePermitCount(state) < state.maxConcurrency,
		apply: (state) =>
			transition("reserve fan-out permit", state, (next) => {
				next.phase = "permit-reserved"
				next.reservedPermit = true
			}),
	},
	{
		name: "select child profile without broadcasting to live tasks",
		canApply: (state) => state.phase === "permit-reserved",
		apply: (state) =>
			transition("select child profile without broadcasting to live tasks", state, (next) => {
				next.phase = "child-profile-selected"
				next.globalProfile = "child-profile"
			}),
	},
	{
		name: "create child succeeds",
		canApply: (state) => state.phase === "child-profile-selected",
		apply: (state) =>
			transition("create child succeeds", state, (next) => {
				next.phase = "child-created"
				next.focus = "child"
				next.child = {
					live: true,
					localProfile: next.globalProfile,
					historyStatus: "active",
				}
			}),
	},
	{
		name: "create child throws and rolls back",
		canApply: (state) => state.phase === "child-profile-selected",
		apply: (state) =>
			transition("create child throws and rolls back", state, (next) => {
				next.phase = "failed"
				next.reservedPermit = false
				next.focus = "parent"
				next.child = undefined
				next.globalProfile = "parent-profile"
			}),
	},
	{
		name: "persist parent delegation succeeds",
		canApply: (state) => state.phase === "child-created",
		apply: (state) =>
			transition("persist parent delegation succeeds", state, (next) => {
				next.phase = "delegation-persisted"
				next.parent.historyStatus = "delegated"
			}),
	},
	{
		name: "persist parent delegation throws and rolls back",
		canApply: (state) => state.phase === "child-created",
		apply: (state) =>
			transition("persist parent delegation throws and rolls back", state, (next) => {
				next.phase = "failed"
				next.reservedPermit = false
				next.focus = "parent"
				next.child = undefined
				next.globalProfile = "parent-profile"
			}),
	},
	{
		name: "start child with reserved permit",
		canApply: (state) => state.phase === "delegation-persisted" && state.reservedPermit,
		apply: (state) =>
			transition("start child with reserved permit", state, (next) => {
				next.phase = "child-running"
				next.reservedPermit = false
				next.permitsHeld += 1
			}),
	},
	{
		name: "parent continues while child runs",
		canApply: (state) => state.phase === "child-running",
		apply: (state) => transition("parent continues while child runs", state, () => {}),
	},
	{
		name: "child uses its scoped profile",
		canApply: (state) => state.phase === "child-running",
		apply: (state) => transition("child uses its scoped profile", state, () => {}),
	},
	{
		name: "child completes",
		canApply: (state) => state.phase === "child-running",
		apply: (state) =>
			transition("child completes", state, (next) => {
				next.phase = "child-completed"
				next.permitsHeld -= 1
				next.focus = "parent"
				if (next.child) {
					next.child.live = false
					next.child.historyStatus = "completed"
				}
			}),
	},
]

function initialSerialDelegationState(): ModelState {
	return {
		phase: "parent-running",
		maxConcurrency: 1,
		permitsHeld: 0,
		reservedPermit: false,
		focus: "parent",
		globalProfile: "parent-profile",
		parent: {
			live: true,
			localProfile: "parent-profile",
			historyStatus: "active",
		},
		trace: [],
	}
}

const serialDelegationTransitions: Transition[] = [
	{
		name: "suspend parent before serial child creation",
		canApply: (state) => state.phase === "parent-running",
		apply: (state) =>
			transition("suspend parent before serial child creation", state, (next) => {
				next.phase = "parent-suspended"
				next.parent.live = false
				next.focus = "none"
			}),
	},
	{
		name: "create child throws and restores suspended parent",
		canApply: (state) => state.phase === "parent-suspended",
		apply: (state) =>
			transition("create child throws and restores suspended parent", state, (next) => {
				next.phase = "failed"
				next.parent.live = true
				next.focus = "parent"
			}),
	},
	{
		name: "create child succeeds after parent suspension",
		canApply: (state) => state.phase === "parent-suspended",
		apply: (state) =>
			transition("create child succeeds after parent suspension", state, (next) => {
				next.phase = "child-created"
				next.focus = "child"
				next.globalProfile = "child-profile"
				next.child = {
					live: true,
					localProfile: "child-profile",
					historyStatus: "active",
				}
			}),
	},
	{
		name: "persist serial delegation throws and restores suspended parent",
		canApply: (state) => state.phase === "child-created" && !state.parent.live,
		apply: (state) =>
			transition("persist serial delegation throws and restores suspended parent", state, (next) => {
				next.phase = "failed"
				next.parent.live = true
				next.focus = "parent"
				next.child = undefined
				next.globalProfile = "parent-profile"
			}),
	},
]

function explore(state: ModelState, transitions: Transition[], depth: number, terminalStates: ModelState[]) {
	assertInvariants(state)

	if (depth === 0) {
		terminalStates.push(state)
		return
	}

	const applicable = transitions.filter((candidate) => candidate.canApply(state))
	if (applicable.length === 0) {
		terminalStates.push(state)
		return
	}

	for (const candidate of applicable) {
		explore(candidate.apply(state), transitions, depth - 1, terminalStates)
	}
}

describe("delegation state machine model", () => {
	it("exhaustively preserves fan-out permit, rollback, history, and profile-isolation invariants", () => {
		const terminalStates: ModelState[] = []

		explore(initialFanOutState(), fanOutTransitions, 8, terminalStates)

		expect(terminalStates.length).toBeGreaterThan(0)
		expect(terminalStates.some((state) => state.phase === "child-running")).toBe(true)
		expect(terminalStates.some((state) => state.phase === "failed")).toBe(true)
		expect(terminalStates.some((state) => state.phase === "child-completed")).toBe(true)
	})

	it("exhaustively preserves serial-path rollback when the parent was suspended before child creation", () => {
		const terminalStates: ModelState[] = []

		explore(initialSerialDelegationState(), serialDelegationTransitions, 3, terminalStates)

		expect(terminalStates.some((state) => state.phase === "failed")).toBe(true)
		expect(
			terminalStates.find(
				(state) =>
					state.phase === "failed" &&
					state.trace.includes("create child throws and restores suspended parent"),
			)?.parent.live,
		).toBe(true)
		expect(
			terminalStates.find(
				(state) =>
					state.phase === "failed" &&
					state.trace.includes("persist serial delegation throws and restores suspended parent"),
			)?.parent.live,
		).toBe(true)
	})

	it("would catch a provider-profile event broadcast leaking the child's profile into the live parent", () => {
		const buggyState = transition("buggy profile broadcast", initialFanOutState(), (next) => {
			next.phase = "child-profile-selected"
			next.reservedPermit = true
			next.globalProfile = "child-profile"
			next.parent.localProfile = "child-profile"
		})

		expect(() => assertInvariants(buggyState)).toThrow(/parent profile leaked/)
	})

	it("would catch a failed child creation that leaks its reserved permit", () => {
		const buggyState = transition("buggy createTask rollback", initialFanOutState(), (next) => {
			next.phase = "failed"
			next.reservedPermit = true
			next.focus = "parent"
		})

		expect(() => assertInvariants(buggyState)).toThrow(/reserved permit/)
	})

	it("would catch a serial-path child creation failure that does not restore the suspended parent", () => {
		const buggyState = transition("buggy serial createTask rollback", initialSerialDelegationState(), (next) => {
			next.phase = "failed"
			next.parent.live = false
			next.focus = "none"
		})

		expect(() => assertInvariants(buggyState)).toThrow(/lost the parent/)
	})
})
