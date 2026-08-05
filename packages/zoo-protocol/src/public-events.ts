import { z } from "zod"

import { zooErrorSchema, zooOutcomeSchema } from "./outcomes.js"
import { ZOO_PUBLIC_SCHEMA_VERSION, zooCapabilitySchema } from "./version.js"

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

export const usageSchema = strictObject({
	inputTokens: z.number().int().nonnegative().optional(),
	outputTokens: z.number().int().nonnegative().optional(),
	cacheReads: z.number().int().nonnegative().optional(),
	cacheWrites: z.number().int().nonnegative().optional(),
})

export const changedFileSchema = strictObject({ path: z.string().min(1), status: z.string().min(1) })

export const zooRunResultSchema = strictObject({
	schemaVersion: z.literal(ZOO_PUBLIC_SCHEMA_VERSION),
	protocol: z.literal("zoo-run-result"),
	success: z.boolean(),
	outcome: zooOutcomeSchema,
	rootTaskId: z.string().min(1),
	currentTaskId: z.string().min(1).optional(),
	workspace: z.string().min(1),
	resumable: z.boolean(),
	content: z.string().optional(),
	error: zooErrorSchema.optional(),
	usage: usageSchema.optional(),
	cost: z.number().nonnegative().optional(),
	elapsedMs: z.number().int().nonnegative(),
	changedFiles: z.array(changedFileSchema).optional(),
}).superRefine((result, context) => {
	if (result.success !== (result.outcome === "completed")) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "success must match completed outcome" })
	}
	if (result.outcome === "failed" && result.error === undefined) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "failed results require an error" })
	}
	if (result.outcome === "completed" && result.error !== undefined) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "completed results cannot include an error" })
	}
})

export type ZooRunResult = z.infer<typeof zooRunResultSchema>

const eventBase = {
	v: z.literal(ZOO_PUBLIC_SCHEMA_VERSION),
	seq: z.number().int().positive(),
	timestamp: z.string().datetime({ offset: true }),
	hostId: z.string().min(1),
	requestId: z.string().min(1).optional(),
}

const event = <const Type extends string, T extends z.ZodRawShape>(type: Type, shape: T) =>
	strictObject({ ...eventBase, type: z.literal(type), ...shape })

const taskEvent = <const Type extends string, T extends z.ZodRawShape>(type: Type, shape: T) =>
	strictObject({
		...eventBase,
		type: z.literal(type),
		rootTaskId: z.string().min(1),
		taskId: z.string().min(1),
		...shape,
	})

const systemInitEventSchema = event("system.init", {
	protocol: z.literal("zoo-stream"),
	capabilities: z.array(zooCapabilitySchema),
	clientVersion: z.string().min(1),
	hostVersion: z.string().min(1),
})
const systemWarningEventSchema = event("system.warning", { code: z.string().min(1), message: z.string().min(1) })
const taskCreatedEventSchema = taskEvent("task.created", { parentTaskId: z.string().min(1).optional() })
const taskStartedEventSchema = taskEvent("task.started", {})
const taskLifecycleEventSchema = taskEvent("task.lifecycle", {
	state: z.enum(["running", "waiting", "interrupted", "completed", "failed"]),
})
const taskResumedEventSchema = taskEvent("task.resumed", {})
const taskDelegatedEventSchema = taskEvent("task.delegated", {
	parentTaskId: z.string().min(1),
	childTaskId: z.string().min(1),
})
const messageUpsertEventSchema = taskEvent("message.upsert", {
	messageId: z.string().min(1),
	role: z.enum(["assistant", "user", "reasoning"]),
	content: z.string(),
	complete: z.boolean(),
})
const askRequiredEventSchema = taskEvent("ask.required", {
	askId: z.string().min(1),
	category: z.string().min(1),
	subject: z.string().min(1),
})
const askResolvedEventSchema = taskEvent("ask.resolved", {
	askId: z.string().min(1),
	decision: z.enum(["approve", "reject", "needs_input"]),
	source: z.enum(["policy", "user", "auto", "deny"]),
})
const toolEventState = {
	toolCallId: z.string().min(1),
	name: z.string().min(1),
	arguments: z.record(z.unknown()).optional(),
	output: z.string().optional(),
}
const toolStartedEventSchema = taskEvent("tool.started", toolEventState)
const toolUpdatedEventSchema = taskEvent("tool.updated", toolEventState)
const toolCompletedEventSchema = taskEvent("tool.completed", toolEventState)
const toolFailedEventSchema = taskEvent("tool.failed", { ...toolEventState, error: zooErrorSchema })
const terminalOutputEventSchema = taskEvent("terminal.output", {
	toolCallId: z.string().min(1),
	stream: z.enum(["stdout", "stderr"]),
	delta: z.string(),
})
const terminalStatusEventSchema = taskEvent("terminal.status", {
	toolCallId: z.string().min(1),
	state: z.enum(["running", "background", "exited", "killed"]),
	exitCode: z.number().int().nullable().optional(),
})
const mcpEventState = {
	operationId: z.string().min(1),
	server: z.string().min(1),
	operation: z.string().min(1),
	output: z.string().optional(),
}
const mcpStartedEventSchema = taskEvent("mcp.started", mcpEventState)
const mcpCompletedEventSchema = taskEvent("mcp.completed", mcpEventState)
const mcpFailedEventSchema = taskEvent("mcp.failed", { ...mcpEventState, error: zooErrorSchema })
const usageUpdatedEventSchema = taskEvent("usage.updated", {
	usage: usageSchema,
	cost: z.number().nonnegative().optional(),
})
const taskResultEventSchema = taskEvent("task.result", { result: zooRunResultSchema })

export const zooStreamEventSchema = z.discriminatedUnion("type", [
	systemInitEventSchema,
	systemWarningEventSchema,
	taskCreatedEventSchema,
	taskStartedEventSchema,
	taskLifecycleEventSchema,
	taskResumedEventSchema,
	taskDelegatedEventSchema,
	messageUpsertEventSchema,
	askRequiredEventSchema,
	askResolvedEventSchema,
	toolStartedEventSchema,
	toolUpdatedEventSchema,
	toolCompletedEventSchema,
	toolFailedEventSchema,
	terminalOutputEventSchema,
	terminalStatusEventSchema,
	mcpStartedEventSchema,
	mcpCompletedEventSchema,
	mcpFailedEventSchema,
	usageUpdatedEventSchema,
	taskResultEventSchema,
])

export type ZooStreamEvent = z.infer<typeof zooStreamEventSchema>

export function validateStreamLifecycle(
	events: readonly ZooStreamEvent[],
): { ok: true } | { ok: false; code: "protocol_gap" | "task_failed"; message: string } {
	if (events[0]?.type !== "system.init") {
		return { ok: false, code: "task_failed", message: "Stream must start with system.init" }
	}
	const hostId = events[0].hostId
	if (events.some((streamEvent) => streamEvent.hostId !== hostId)) {
		return { ok: false, code: "protocol_gap", message: "Stream cannot span multiple hosts" }
	}
	for (let index = 1; index < events.length; index += 1) {
		const expected = events[index - 1]!.seq + 1
		if (events[index]!.seq !== expected) {
			return { ok: false, code: "protocol_gap", message: `Expected sequence ${expected}` }
		}
	}
	const results = events.filter((event) => event.type === "task.result")
	if (results.length !== 1 || events.at(-1)?.type !== "task.result") {
		return { ok: false, code: "task_failed", message: "Accepted stream must end with exactly one task.result" }
	}
	const resultEvent = results[0]!
	const rootTaskId = resultEvent.result.rootTaskId
	if (resultEvent.rootTaskId !== rootTaskId || resultEvent.taskId !== rootTaskId) {
		return { ok: false, code: "task_failed", message: "task.result must identify the authoritative root task" }
	}

	const pendingAsks = new Set<string>()
	const taskStates = new Map<string, "running" | "waiting" | "interrupted" | "completed" | "failed">()
	const terminalStates = new Set(["interrupted", "completed", "failed"])
	for (const streamEvent of events) {
		if ("rootTaskId" in streamEvent && streamEvent.rootTaskId !== rootTaskId) {
			return { ok: false, code: "task_failed", message: "All task events must identify the authoritative root task" }
		}
		if (!("taskId" in streamEvent) || streamEvent.type === "task.result") continue

		const previousState = taskStates.get(streamEvent.taskId)
		if (previousState !== undefined && terminalStates.has(previousState)) {
			return { ok: false, code: "task_failed", message: `Task ${streamEvent.taskId} emitted an event after termination` }
		}
		if (streamEvent.type === "task.lifecycle") {
			taskStates.set(streamEvent.taskId, streamEvent.state)
		}
		if (streamEvent.type === "ask.required") {
			const askKey = `${streamEvent.taskId}\u0000${streamEvent.askId}`
			if (pendingAsks.has(askKey)) {
				return { ok: false, code: "task_failed", message: `Ask ${streamEvent.askId} is already pending` }
			}
			pendingAsks.add(askKey)
		}
		if (streamEvent.type === "ask.resolved") {
			const askKey = `${streamEvent.taskId}\u0000${streamEvent.askId}`
			if (!pendingAsks.delete(askKey)) {
				return { ok: false, code: "task_failed", message: `Ask ${streamEvent.askId} was not pending` }
			}
		}
	}
	if (pendingAsks.size > 0 && resultEvent.result.outcome !== "needs_input") {
		return { ok: false, code: "task_failed", message: "Terminal stream contains unresolved asks" }
	}
	const expectedState = {
		completed: "completed",
		needs_input: "waiting",
		cancelled: "interrupted",
		timed_out: "interrupted",
		failed: "failed",
	} as const
	const rootState = taskStates.get(rootTaskId)
	if (rootState !== undefined && rootState !== expectedState[resultEvent.result.outcome]) {
		return { ok: false, code: "task_failed", message: "Root lifecycle state contradicts task.result" }
	}
	return { ok: true }
}
