import type { ZooOutcome, ZooErrorCode } from "./outcomes.js"

export type SemanticTraceEntry = {
	type: string
	taskId?: string
	parentTaskId?: string
	toolCallId?: string
	content?: string
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
			{ type: "task.created", taskId: "root" },
			{ type: "message.upsert", taskId: "root", content: "Hello from Zoo." },
			{ type: "task.result", taskId: "root", outcome: "completed" },
		],
	},
	{
		id: "tool-pairing",
		prompt: "Read README.md and report its title.",
		providerTurns: ["tool:read_file:call-1:README.md", "Zoo Code"],
		expected: [
			{ type: "task.created", taskId: "root" },
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
			{ type: "task.created", taskId: "root" },
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
	const expectedJson = JSON.stringify(expected)
	const actualJson = JSON.stringify(actual)
	return expectedJson === actualJson
		? { ok: true }
		: { ok: false, difference: `Expected ${expectedJson}\nReceived ${actualJson}` }
}

export function assertAuthoritativeRootResult(trace: readonly SemanticTraceEntry[], rootTaskId: string): boolean {
	const results = trace.filter((entry) => entry.type === "task.result")
	return results.length === 1 && results[0]?.taskId === rootTaskId
}
