import {
	failedErrorCodeSchema,
	type ZooErrorCode,
	type ZooOutcome,
	zooErrorCodeSchema,
	zooOutcomeSchema,
} from "./outcomes.js"

export type SemanticTraceEntry = {
	type: string
	taskId?: string
	rootTaskId?: string
	parentTaskId?: string
	toolCallId?: string
	toolName?: string
	toolArguments?: Record<string, unknown>
	state?: "running" | "waiting" | "interrupted" | "completed" | "failed"
	askId?: string
	decision?: "approve" | "reject" | "needs_input"
	source?: "policy" | "user" | "auto" | "deny"
	requestId?: string
	cancellationReason?: "user" | "signal" | "timeout"
	content?: string
	prompt?: string
	outcome?: ZooOutcome
	errorCode?: ZooErrorCode
}

export type ParityScenario = {
	id: string
	prompt: string
	providerTurns: readonly string[]
	expected: readonly SemanticTraceEntry[]
}

export const parityScenarios: readonly ParityScenario[] = [
	{
		id: "text-completion",
		prompt: "Reply with the fixture greeting.",
		providerTurns: ["Hello from Zoo."],
		expected: [
			{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: "Reply with the fixture greeting." },
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "message.upsert", rootTaskId: "root", taskId: "root", content: "Hello from Zoo." },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" },
			{ type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "tool-pairing",
		prompt: "Read README.md and report its title.",
		providerTurns: ["tool:read_file:call-1:README.md", "Zoo Code"],
		expected: [
			{
				type: "task.created",
				rootTaskId: "root",
				taskId: "root",
				prompt: "Read README.md and report its title.",
			},
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{
				type: "tool.started",
				rootTaskId: "root",
				taskId: "root",
				toolCallId: "call-1",
				toolName: "read_file",
				toolArguments: { path: "README.md" },
			},
			{
				type: "tool.completed",
				rootTaskId: "root",
				taskId: "root",
				toolCallId: "call-1",
				toolName: "read_file",
				toolArguments: { path: "README.md" },
			},
			{ type: "message.upsert", rootTaskId: "root", taskId: "root", content: "Zoo Code" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" },
			{ type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "delegation-root-authority",
		prompt: "Delegate once, then finish the root task.",
		providerTurns: ["delegate:child", "child:done", "root:accepted"],
		expected: [
			{
				type: "task.created",
				rootTaskId: "root",
				taskId: "root",
				prompt: "Delegate once, then finish the root task.",
			},
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "task.created", rootTaskId: "root", taskId: "child", parentTaskId: "root" },
			{ type: "task.delegated", rootTaskId: "root", taskId: "child", parentTaskId: "root" },
			{ type: "task.started", rootTaskId: "root", taskId: "child" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "child", state: "completed" },
			{ type: "message.upsert", rootTaskId: "root", taskId: "root", content: "root:accepted" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" },
			{ type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "approval-causation",
		prompt: "Request approval.",
		providerTurns: ["ask:ask-1", "approve:ask-1:user:respond-1"],
		expected: [
			{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: "Request approval." },
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "ask.required", rootTaskId: "root", taskId: "root", askId: "ask-1" },
			{
				type: "ask.resolved",
				rootTaskId: "root",
				taskId: "root",
				askId: "ask-1",
				decision: "approve",
				source: "user",
				requestId: "respond-1",
			},
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" },
			{ type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "cancelled",
		prompt: "Cancel deterministically.",
		providerTurns: ["cancel:cancel-1:user"],
		expected: [
			{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: "Cancel deterministically." },
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "interrupted" },
			{
				type: "task.result",
				rootTaskId: "root",
				taskId: "root",
				outcome: "cancelled",
				requestId: "cancel-1",
				cancellationReason: "user",
			},
		],
	},
	{
		id: "provider-failure",
		prompt: "Fail deterministically.",
		providerTurns: ["fail:provider_failed"],
		expected: [
			{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: "Fail deterministically." },
			{ type: "task.started", rootTaskId: "root", taskId: "root" },
			{ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "failed" },
			{
				type: "task.result",
				rootTaskId: "root",
				taskId: "root",
				outcome: "failed",
				errorCode: "provider_failed",
			},
		],
	},
]

export function compareSemanticTraces(
	expected: readonly SemanticTraceEntry[],
	actual: readonly SemanticTraceEntry[],
): { ok: true } | { ok: false; difference: string } {
	const canonicalize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonicalize)
		if (value === null || typeof value !== "object") return value
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, canonicalize(entry)]),
		)
	}
	const expectedJson = JSON.stringify(canonicalize(expected))
	const actualJson = JSON.stringify(canonicalize(actual))
	return expectedJson === actualJson
		? { ok: true }
		: { ok: false, difference: `Expected ${expectedJson}\nReceived ${actualJson}` }
}

export function runDeterministicFakeProvider(scenario: ParityScenario): readonly SemanticTraceEntry[] {
	if (scenario.prompt.trim().length === 0) throw new Error("Fake-provider scenarios require a prompt")

	const trace: SemanticTraceEntry[] = [
		{ type: "task.created", rootTaskId: "root", taskId: "root", prompt: scenario.prompt },
		{ type: "task.started", rootTaskId: "root", taskId: "root" },
	]
	let result: SemanticTraceEntry = { type: "task.result", rootTaskId: "root", taskId: "root", outcome: "completed" }
	let terminalReached = false
	for (const turn of scenario.providerTurns) {
		if (terminalReached) throw new Error("Fake-provider terminal directives must be the final turn")
		if (turn.startsWith("tool:")) {
			const separator1 = turn.indexOf(":")
			const separator2 = turn.indexOf(":", separator1 + 1)
			const separator3 = turn.indexOf(":", separator2 + 1)
			const operation = turn.slice(separator1 + 1, separator2)
			const toolCallId = turn.slice(separator2 + 1, separator3)
			const argument = turn.slice(separator3 + 1)
			if (operation !== "read_file" || !toolCallId || !argument) throw new Error(`Invalid tool fixture: ${turn}`)
			const tool = {
				rootTaskId: "root",
				taskId: "root",
				toolCallId,
				toolName: operation,
				toolArguments: { path: argument },
			}
			trace.push({ type: "tool.started", ...tool })
			trace.push({ type: "tool.completed", ...tool })
			continue
		}
		if (turn.startsWith("delegate:")) {
			const taskId = turn.slice("delegate:".length)
			if (!taskId) throw new Error(`Invalid delegation fixture: ${turn}`)
			trace.push({ type: "task.created", rootTaskId: "root", taskId, parentTaskId: "root" })
			trace.push({ type: "task.delegated", rootTaskId: "root", taskId, parentTaskId: "root" })
			trace.push({ type: "task.started", rootTaskId: "root", taskId })
			continue
		}
		if (turn.endsWith(":done")) {
			const taskId = turn.slice(0, -":done".length)
			if (!taskId) throw new Error(`Invalid completion fixture: ${turn}`)
			trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId, state: "completed" })
			continue
		}
		if (turn.startsWith("ask:")) {
			trace.push({ type: "ask.required", rootTaskId: "root", taskId: "root", askId: turn.slice(4) })
			continue
		}
		if (turn.startsWith("approve:")) {
			const [, askId, source, requestId] = turn.split(":")
			if (!askId || source !== "user" || !requestId) throw new Error(`Invalid approval fixture: ${turn}`)
			trace.push({
				type: "ask.resolved",
				rootTaskId: "root",
				taskId: "root",
				askId,
				decision: "approve",
				source,
				requestId,
			})
			continue
		}
		if (turn.startsWith("cancel:")) {
			const [, requestId, cancellationReason] = turn.split(":")
			if (!requestId || !["user", "signal", "timeout"].includes(cancellationReason ?? ""))
				throw new Error(`Invalid cancellation fixture: ${turn}`)
			trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "interrupted" })
			result = {
				type: "task.result",
				rootTaskId: "root",
				taskId: "root",
				outcome: "cancelled",
				requestId,
				cancellationReason: cancellationReason as "user" | "signal" | "timeout",
			}
			terminalReached = true
			continue
		}
		if (turn.startsWith("fail:")) {
			const errorCode = failedErrorCodeSchema.parse(turn.slice(5))
			trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "failed" })
			result = { type: "task.result", rootTaskId: "root", taskId: "root", outcome: "failed", errorCode }
			terminalReached = true
			continue
		}
		if (turn.startsWith("timeout:")) {
			const errorCode = zooErrorCodeSchema.parse(turn.slice(8))
			if (errorCode !== "task_timed_out" && errorCode !== "cleanup_timed_out") {
				throw new Error(`Invalid timeout fixture: ${turn}`)
			}
			trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "interrupted" })
			result = { type: "task.result", rootTaskId: "root", taskId: "root", outcome: "timed_out", errorCode }
			terminalReached = true
			continue
		}
		trace.push({ type: "message.upsert", rootTaskId: "root", taskId: "root", content: turn })
	}
	if (result.outcome === "completed") {
		trace.push({ type: "task.lifecycle", rootTaskId: "root", taskId: "root", state: "completed" })
	}
	trace.push(result)
	return trace
}

export function assertAuthoritativeRootResult(trace: readonly SemanticTraceEntry[], rootTaskId: string): boolean {
	const results = trace.filter((entry) => entry.type === "task.result")
	if (results.length !== 1) return false
	const result = results[0]!
	if (
		result.taskId !== rootTaskId ||
		result.rootTaskId !== rootTaskId ||
		!zooOutcomeSchema.safeParse(result.outcome).success
	) {
		return false
	}
	if (result.outcome === "failed") {
		return failedErrorCodeSchema.safeParse(result.errorCode).success && result.cancellationReason === undefined
	}
	if (result.outcome === "timed_out") {
		return (
			(result.errorCode === undefined || ["task_timed_out", "cleanup_timed_out"].includes(result.errorCode)) &&
			result.cancellationReason === undefined
		)
	}
	if (result.outcome === "cancelled") {
		return (
			result.errorCode === undefined &&
			result.cancellationReason !== undefined &&
			["user", "signal", "timeout"].includes(result.cancellationReason)
		)
	}
	return result.errorCode === undefined && result.cancellationReason === undefined
}
