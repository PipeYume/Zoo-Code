import type { ZooOutcome, ZooErrorCode } from "./outcomes.js"

export type SemanticTraceEntry = {
	type: string
	taskId?: string
	parentTaskId?: string
	toolCallId?: string
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
			{ type: "task.created", taskId: "root", prompt: "Reply with the fixture greeting." },
			{ type: "message.upsert", taskId: "root", content: "Hello from Zoo." },
			{ type: "task.result", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "tool-pairing",
		prompt: "Read README.md and report its title.",
		providerTurns: ["tool:read_file:call-1:README.md", "Zoo Code"],
		expected: [
			{ type: "task.created", taskId: "root", prompt: "Read README.md and report its title." },
			{ type: "tool.started", taskId: "root", toolCallId: "call-1" },
			{ type: "tool.completed", taskId: "root", toolCallId: "call-1" },
			{ type: "message.upsert", taskId: "root", content: "Zoo Code" },
			{ type: "task.result", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "delegation-root-authority",
		prompt: "Delegate once, then finish the root task.",
		providerTurns: ["delegate:child", "child:done", "root:accepted"],
		expected: [
			{ type: "task.created", taskId: "root", prompt: "Delegate once, then finish the root task." },
			{ type: "task.delegated", taskId: "child", parentTaskId: "root" },
			{ type: "task.lifecycle", taskId: "child" },
			{ type: "message.upsert", taskId: "root", content: "root:accepted" },
			{ type: "task.result", taskId: "root", outcome: "completed" },
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

	const trace: SemanticTraceEntry[] = [{ type: "task.created", taskId: "root", prompt: scenario.prompt }]
	for (const turn of scenario.providerTurns) {
		if (turn.startsWith("tool:")) {
			const [, operation, toolCallId, argument] = turn.split(":")
			if (operation !== "read_file" || !toolCallId || !argument) throw new Error(`Invalid tool fixture: ${turn}`)
			trace.push({ type: "tool.started", taskId: "root", toolCallId })
			trace.push({ type: "tool.completed", taskId: "root", toolCallId })
			continue
		}
		if (turn.startsWith("delegate:")) {
			const taskId = turn.slice("delegate:".length)
			if (!taskId) throw new Error(`Invalid delegation fixture: ${turn}`)
			trace.push({ type: "task.delegated", taskId, parentTaskId: "root" })
			continue
		}
		if (turn.endsWith(":done")) {
			const taskId = turn.slice(0, -":done".length)
			if (!taskId) throw new Error(`Invalid completion fixture: ${turn}`)
			trace.push({ type: "task.lifecycle", taskId })
			continue
		}
		trace.push({ type: "message.upsert", taskId: "root", content: turn })
	}
	trace.push({ type: "task.result", taskId: "root", outcome: "completed" })
	return trace
}

export function assertAuthoritativeRootResult(trace: readonly SemanticTraceEntry[], rootTaskId: string): boolean {
	const results = trace.filter((entry) => entry.type === "task.result")
	return results.length === 1 && results[0]?.taskId === rootTaskId
}
