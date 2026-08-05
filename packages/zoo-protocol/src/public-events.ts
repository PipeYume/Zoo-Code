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
	rootTaskId: z.string().min(1).optional(),
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
})

export type ZooRunResult = z.infer<typeof zooRunResultSchema>

const eventBase = {
	v: z.literal(ZOO_PUBLIC_SCHEMA_VERSION),
	seq: z.number().int().positive(),
	timestamp: z.string().datetime({ offset: true }),
	hostId: z.string().min(1),
	rootTaskId: z.string().min(1).optional(),
	taskId: z.string().min(1).optional(),
	requestId: z.string().min(1).optional(),
}

const event = <T extends z.ZodRawShape>(type: string, shape: T) =>
	strictObject({ ...eventBase, type: z.literal(type), ...shape })

const systemInitEventSchema = event("system.init", {
	protocol: z.literal("zoo-stream"),
	capabilities: z.array(zooCapabilitySchema),
	clientVersion: z.string().min(1),
	hostVersion: z.string().min(1),
})
const systemWarningEventSchema = event("system.warning", { code: z.string().min(1), message: z.string().min(1) })
const taskCreatedEventSchema = event("task.created", { parentTaskId: z.string().min(1).optional() })
const taskStartedEventSchema = event("task.started", {})
const taskLifecycleEventSchema = event("task.lifecycle", {
	state: z.enum(["running", "waiting", "interrupted", "completed", "failed"]),
})
const taskResumedEventSchema = event("task.resumed", {})
const taskDelegatedEventSchema = event("task.delegated", {
	parentTaskId: z.string().min(1),
	childTaskId: z.string().min(1),
})
const messageUpsertEventSchema = event("message.upsert", {
	messageId: z.string().min(1),
	role: z.enum(["assistant", "user", "reasoning"]),
	content: z.string(),
	complete: z.boolean(),
})
const askRequiredEventSchema = event("ask.required", {
	askId: z.string().min(1),
	category: z.string().min(1),
	subject: z.string().min(1),
})
const askResolvedEventSchema = event("ask.resolved", {
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
const toolStartedEventSchema = event("tool.started", toolEventState)
const toolUpdatedEventSchema = event("tool.updated", toolEventState)
const toolCompletedEventSchema = event("tool.completed", toolEventState)
const toolFailedEventSchema = event("tool.failed", { ...toolEventState, error: zooErrorSchema })
const terminalOutputEventSchema = event("terminal.output", {
	toolCallId: z.string().min(1),
	stream: z.enum(["stdout", "stderr"]),
	delta: z.string(),
})
const terminalStatusEventSchema = event("terminal.status", {
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
const mcpStartedEventSchema = event("mcp.started", mcpEventState)
const mcpCompletedEventSchema = event("mcp.completed", mcpEventState)
const mcpFailedEventSchema = event("mcp.failed", { ...mcpEventState, error: zooErrorSchema })
const usageUpdatedEventSchema = event("usage.updated", {
	usage: usageSchema,
	cost: z.number().nonnegative().optional(),
})
const taskResultEventSchema = event("task.result", { result: zooRunResultSchema })

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
	return { ok: true }
}
