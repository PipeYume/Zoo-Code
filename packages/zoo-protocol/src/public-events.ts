import { z } from "zod"

import type { HostCommand } from "./host-commands.js"
import { failedErrorCodeSchema, zooErrorSchema, zooOutcomeSchema } from "./outcomes.js"
import { redactValue, type RedactedValue } from "./redaction.js"
import { ZOO_PUBLIC_SCHEMA_VERSION, zooCapabilitySchema } from "./version.js"

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

export const usageSchema = strictObject({
	inputTokens: z.number().int().safe().nonnegative().optional(),
	outputTokens: z.number().int().safe().nonnegative().optional(),
	cacheReads: z.number().int().safe().nonnegative().optional(),
	cacheWrites: z.number().int().safe().nonnegative().optional(),
})

export const changedFileSchema = strictObject({ path: z.string().min(1), status: z.string().min(1) })

const rawZooRunResultSchema = strictObject({
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
	cost: z.number().finite().nonnegative().optional(),
	elapsedMs: z.number().int().safe().nonnegative(),
	changedFiles: z.array(changedFileSchema).optional(),
	cancellationReason: z.enum(["user", "signal", "timeout"]).optional(),
}).superRefine((result, context) => {
	if (result.success !== (result.outcome === "completed")) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "success must match completed outcome" })
	}
	if (result.outcome === "failed" && result.error === undefined) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "failed results require an error" })
	}
	if (
		result.outcome === "failed" &&
		result.error !== undefined &&
		!failedErrorCodeSchema.safeParse(result.error.code).success
	) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "failed results require a non-timeout error code" })
	}
	if (
		result.outcome === "timed_out" &&
		result.error !== undefined &&
		!["task_timed_out", "cleanup_timed_out"].includes(result.error.code)
	) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "timed_out results require a timeout error code" })
	}
	if (!["failed", "timed_out"].includes(result.outcome) && result.error !== undefined) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: `${result.outcome} results cannot include an error` })
	}
	if ((result.outcome === "cancelled") !== (result.cancellationReason !== undefined)) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "cancelled results require a cancellation reason" })
	}
})

const redactError = <T extends { message: string }>(error: T): T => ({ ...error, message: String(redactValue(error.message)) })
const redactRecord = (value: Record<string, unknown>): Record<string, RedactedValue> =>
	redactValue(value) as Record<string, RedactedValue>

export const zooRunResultSchema = rawZooRunResultSchema.transform((result) => ({
	...result,
	content: result.content === undefined ? undefined : String(redactValue(result.content)),
	error: result.error === undefined ? undefined : redactError(result.error),
}))

export type ZooRunResult = z.infer<typeof zooRunResultSchema>

const eventBase = {
	v: z.literal(ZOO_PUBLIC_SCHEMA_VERSION),
	seq: z.number().int().safe().positive(),
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
const taskResumedEventSchema = taskEvent("task.resumed", {
	previousState: z.enum(["waiting", "interrupted"]),
})
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
const askAbandonedEventSchema = taskEvent("ask.abandoned", {
	askId: z.string().min(1),
	reason: z.enum(["cancelled", "timed_out"]),
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
	exitCode: z.number().int().safe().nullable().optional(),
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
	cost: z.number().finite().nonnegative().optional(),
})
const taskResultEventSchema = taskEvent("task.result", { result: zooRunResultSchema })

const rawZooStreamEventSchema = z.discriminatedUnion("type", [
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
	askAbandonedEventSchema,
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
]).superRefine((streamEvent, context) => {
	if (streamEvent.type !== "terminal.status") return
	const terminal = streamEvent.state === "exited" || streamEvent.state === "killed"
	if (terminal === (streamEvent.exitCode === undefined)) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: terminal ? "Terminal states require an exit code or null" : "Nonterminal states cannot include an exit code",
		})
	}
})

export const zooStreamEventSchema = rawZooStreamEventSchema.transform((streamEvent) => {
	switch (streamEvent.type) {
		case "system.warning":
			return { ...streamEvent, message: String(redactValue(streamEvent.message)) }
		case "message.upsert":
			return { ...streamEvent, content: String(redactValue(streamEvent.content)) }
		case "ask.required":
			return { ...streamEvent, subject: String(redactValue(streamEvent.subject)) }
		case "tool.started":
		case "tool.updated":
		case "tool.completed":
			return {
				...streamEvent,
				arguments: streamEvent.arguments === undefined ? undefined : redactRecord(streamEvent.arguments),
				output: streamEvent.output === undefined ? undefined : String(redactValue(streamEvent.output)),
			}
		case "tool.failed":
			return {
				...streamEvent,
				arguments: streamEvent.arguments === undefined ? undefined : redactRecord(streamEvent.arguments),
				output: streamEvent.output === undefined ? undefined : String(redactValue(streamEvent.output)),
				error: redactError(streamEvent.error),
			}
		case "terminal.output":
			return { ...streamEvent, delta: String(redactValue(streamEvent.delta)) }
		case "mcp.started":
		case "mcp.completed":
			return {
				...streamEvent,
				output: streamEvent.output === undefined ? undefined : String(redactValue(streamEvent.output)),
			}
		case "mcp.failed":
			return {
				...streamEvent,
				output: streamEvent.output === undefined ? undefined : String(redactValue(streamEvent.output)),
				error: redactError(streamEvent.error),
			}
		default:
			return streamEvent
	}
})

export type ZooStreamEvent = z.infer<typeof zooStreamEventSchema>

export function validateStreamLifecycle(
	events: readonly ZooStreamEvent[],
	commands: readonly HostCommand[] = [],
): { ok: true } | { ok: false; code: "protocol_gap" | "task_failed"; message: string } {
	if (events[0]?.type !== "system.init") {
		return { ok: false, code: "task_failed", message: "Stream must start with system.init" }
	}
	if (events[0].seq !== 1 || events.slice(1).some((streamEvent) => streamEvent.type === "system.init")) {
		return { ok: false, code: "protocol_gap", message: "Stream must contain one sequence-1 system.init" }
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
	const abandonedAsks = new Map<string, "cancelled" | "timed_out">()
	const taskStates = new Map<string, "running" | "waiting" | "interrupted" | "completed" | "failed">()
	const terminalStates = new Set(["interrupted", "completed", "failed"])
	const taskParents = new Map<string, string | null>()
	const createdTasks = new Set<string>()
	const delegatedTasks = new Set<string>()
	const resumedTasks = new Set<string>()
	const toolStates = new Map<string, { state: "active" | "terminal"; name: string }>()
	const terminalOperationStates = new Map<string, "active" | "terminal">()
	const mcpStates = new Map<string, { state: "active" | "terminal"; server: string; operation: string }>()
	for (const streamEvent of events) {
		if ("rootTaskId" in streamEvent && streamEvent.rootTaskId !== rootTaskId) {
			return {
				ok: false,
				code: "task_failed",
				message: "All task events must identify the authoritative root task",
			}
		}
		if (!("taskId" in streamEvent) || streamEvent.type === "task.result") continue

		if (streamEvent.type === "task.created") {
			const parentTaskId = streamEvent.parentTaskId ?? null
			if (
				(streamEvent.taskId === rootTaskId) !== (parentTaskId === null) ||
				(parentTaskId !== null && !taskParents.has(parentTaskId)) ||
				(parentTaskId !== null && terminalStates.has(taskStates.get(parentTaskId) ?? "")) ||
				createdTasks.has(streamEvent.taskId)
			) {
				return {
					ok: false,
					code: "task_failed",
					message: `Invalid creation edge for task ${streamEvent.taskId}`,
				}
			}
			if (taskParents.has(streamEvent.taskId) && taskParents.get(streamEvent.taskId) !== parentTaskId) {
				return { ok: false, code: "task_failed", message: `Conflicting parent for task ${streamEvent.taskId}` }
			}
			taskParents.set(streamEvent.taskId, parentTaskId)
			createdTasks.add(streamEvent.taskId)
		} else if (streamEvent.type === "task.delegated") {
			if (
				streamEvent.taskId !== streamEvent.childTaskId ||
				streamEvent.childTaskId === rootTaskId ||
				streamEvent.childTaskId === streamEvent.parentTaskId ||
				!createdTasks.has(streamEvent.parentTaskId) ||
				!createdTasks.has(streamEvent.childTaskId) ||
				terminalStates.has(taskStates.get(streamEvent.parentTaskId) ?? "") ||
				delegatedTasks.has(streamEvent.childTaskId)
			) {
				return {
					ok: false,
					code: "task_failed",
					message: `Invalid delegation edge for task ${streamEvent.childTaskId}`,
				}
			}
			if (
				taskParents.has(streamEvent.childTaskId) &&
				taskParents.get(streamEvent.childTaskId) !== streamEvent.parentTaskId
			) {
				return {
					ok: false,
					code: "task_failed",
					message: `Conflicting parent for task ${streamEvent.childTaskId}`,
				}
			}
			taskParents.set(streamEvent.childTaskId, streamEvent.parentTaskId)
			delegatedTasks.add(streamEvent.childTaskId)
		} else if (!taskParents.has(streamEvent.taskId)) {
			return { ok: false, code: "task_failed", message: `Event references unknown task ${streamEvent.taskId}` }
		}
		if (
			streamEvent.taskId !== rootTaskId &&
			streamEvent.type !== "task.created" &&
			streamEvent.type !== "task.delegated" &&
			!delegatedTasks.has(streamEvent.taskId)
		) {
			return { ok: false, code: "task_failed", message: `Task ${streamEvent.taskId} emitted an event before delegation` }
		}

		const previousState = taskStates.get(streamEvent.taskId)
		if (previousState !== undefined && terminalStates.has(previousState)) {
			return {
				ok: false,
				code: "task_failed",
				message: `Task ${streamEvent.taskId} emitted an event after termination`,
			}
		}
		if (streamEvent.type === "task.lifecycle") {
			const hasPendingAsk = [...pendingAsks].some((askKey) => askKey.startsWith(`${streamEvent.taskId}\u0000`))
			if (hasPendingAsk && terminalStates.has(streamEvent.state)) {
				return { ok: false, code: "task_failed", message: "A task with a pending ask cannot terminate" }
			}
			taskStates.set(streamEvent.taskId, streamEvent.state)
		}
		if (streamEvent.type === "task.resumed") {
			const resume = commands.find(
				(command) =>
					command.type === "task.resume" &&
					command.id === streamEvent.requestId &&
					command.taskId === streamEvent.taskId &&
					command.rootTaskId === streamEvent.rootTaskId,
			)
			if (resume === undefined || resumedTasks.size > 0 || streamEvent.taskId !== rootTaskId) {
				return { ok: false, code: "task_failed", message: "task.resumed must uniquely match the root resume command" }
			}
			resumedTasks.add(streamEvent.taskId)
			taskStates.set(streamEvent.taskId, "running")
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
			if (
				(streamEvent.source === "deny" && streamEvent.decision !== "reject") ||
				(streamEvent.source === "auto" && streamEvent.decision !== "approve")
			) {
				return { ok: false, code: "task_failed", message: "Ask decision contradicts its resolution source" }
			}
			if (streamEvent.source === "user") {
				const response = commands.find(
					(command) =>
						command.type === "ask.respond" &&
						command.id === streamEvent.requestId &&
						command.taskId === streamEvent.taskId &&
						command.askId === streamEvent.askId,
				)
				const expectedDecision =
					response?.type === "ask.respond"
						? { approve: "approve", reject: "reject", message: "needs_input" }[response.response]
						: undefined
				if (expectedDecision !== streamEvent.decision) {
					return {
						ok: false,
						code: "task_failed",
						message: "User ask resolution does not match its response command",
					}
				}
			}
		}
		if (streamEvent.type === "ask.abandoned") {
			const askKey = `${streamEvent.taskId}\u0000${streamEvent.askId}`
			if (!pendingAsks.delete(askKey)) {
				return { ok: false, code: "task_failed", message: `Ask ${streamEvent.askId} was not pending` }
			}
			abandonedAsks.set(askKey, streamEvent.reason)
		}

		const toolKey = "toolCallId" in streamEvent ? `${streamEvent.taskId}\u0000${streamEvent.toolCallId}` : undefined
		if (streamEvent.type === "tool.started") {
			if (toolStates.has(toolKey!))
				return { ok: false, code: "task_failed", message: "Tool operation started twice" }
			toolStates.set(toolKey!, { state: "active", name: streamEvent.name })
		} else if (
			streamEvent.type === "tool.updated" ||
			streamEvent.type === "tool.completed" ||
			streamEvent.type === "tool.failed"
		) {
			const tool = toolStates.get(toolKey!)
			if (tool?.state !== "active" || tool.name !== streamEvent.name) {
				return { ok: false, code: "task_failed", message: "Tool event requires an active operation" }
			}
			if (streamEvent.type === "tool.completed" || streamEvent.type === "tool.failed")
				toolStates.set(toolKey!, { ...tool, state: "terminal" })
		}

		if (streamEvent.type === "terminal.status") {
			const state = terminalOperationStates.get(toolKey!)
			if (streamEvent.state === "running") {
				if (state !== undefined)
					return { ok: false, code: "task_failed", message: "Terminal operation started twice" }
				terminalOperationStates.set(toolKey!, "active")
			} else if (state !== "active") {
				return { ok: false, code: "task_failed", message: "Terminal status requires an active operation" }
			} else if (streamEvent.state === "exited" || streamEvent.state === "killed") {
				terminalOperationStates.set(toolKey!, "terminal")
			}
		} else if (streamEvent.type === "terminal.output" && terminalOperationStates.get(toolKey!) !== "active") {
			return { ok: false, code: "task_failed", message: "Terminal output requires an active operation" }
		}

		const mcpKey =
			"operationId" in streamEvent ? `${streamEvent.taskId}\u0000${streamEvent.operationId}` : undefined
		if (streamEvent.type === "mcp.started") {
			if (mcpStates.has(mcpKey!))
				return { ok: false, code: "task_failed", message: "MCP operation started twice" }
			mcpStates.set(mcpKey!, {
				state: "active",
				server: streamEvent.server,
				operation: streamEvent.operation,
			})
		} else if (streamEvent.type === "mcp.completed" || streamEvent.type === "mcp.failed") {
			const operation = mcpStates.get(mcpKey!)
			if (
				operation?.state !== "active" ||
				operation.server !== streamEvent.server ||
				operation.operation !== streamEvent.operation
			) {
				return { ok: false, code: "task_failed", message: "MCP result requires an active operation" }
			}
			mcpStates.set(mcpKey!, { ...operation, state: "terminal" })
		}
	}
	if (pendingAsks.size > 0 && resultEvent.result.outcome !== "needs_input") {
		return { ok: false, code: "task_failed", message: "Terminal stream contains unresolved asks" }
	}
	if (
		resultEvent.result.outcome === "needs_input" &&
		[...pendingAsks].some((askKey) => taskStates.get(askKey.slice(0, askKey.indexOf("\u0000"))) !== "waiting")
	) {
		return { ok: false, code: "task_failed", message: "Pending asks must belong to waiting tasks" }
	}
	const resumeCommands = commands.filter((command) => command.type === "task.resume")
	if (resumeCommands.length !== resumedTasks.size) {
		return { ok: false, code: "task_failed", message: "Every resume command must reconstruct one resumed root" }
	}
	if ([...abandonedAsks.values()].some((reason) => reason !== resultEvent.result.outcome)) {
		return { ok: false, code: "task_failed", message: "Ask abandonment contradicts task.result" }
	}
	const expectedState = {
		completed: "completed",
		needs_input: "waiting",
		cancelled: "interrupted",
		timed_out: "interrupted",
		failed: "failed",
	} as const
	if (
		!createdTasks.has(rootTaskId) ||
		[...taskParents.keys()].some((taskId) => !createdTasks.has(taskId)) ||
		[...createdTasks].some((taskId) => taskId !== rootTaskId && !delegatedTasks.has(taskId))
	) {
		return {
			ok: false,
			code: "task_failed",
			message: "Every task in the authoritative tree must be created and every descendant delegated",
		}
	}
	if (resultEvent.result.currentTaskId !== undefined && !createdTasks.has(resultEvent.result.currentTaskId)) {
		return { ok: false, code: "task_failed", message: "currentTaskId must identify a task in the authoritative tree" }
	}
	const rootState = taskStates.get(rootTaskId)
	if (rootState !== expectedState[resultEvent.result.outcome]) {
		return { ok: false, code: "task_failed", message: "Root lifecycle state contradicts task.result" }
	}
	const allowedDescendantStates = {
		completed: new Set(["completed"]),
		needs_input: new Set(["waiting", "interrupted", "completed", "failed"]),
		cancelled: new Set(["interrupted", "completed", "failed"]),
		timed_out: new Set(["interrupted", "completed", "failed"]),
		failed: new Set(["interrupted", "completed", "failed"]),
	}[resultEvent.result.outcome]
	if (
		[...createdTasks].some(
			(taskId) => taskId !== rootTaskId && !allowedDescendantStates.has(taskStates.get(taskId) ?? "running"),
		)
	) {
		return {
			ok: false,
			code: "task_failed",
			message: "Every descendant task must reach a compatible settled state",
		}
	}
	if (
		[...toolStates.values(), ...mcpStates.values()].some((operation) => operation.state === "active") ||
		[...terminalOperationStates.values()].includes("active")
	) {
		return { ok: false, code: "task_failed", message: "Terminal stream contains active operations" }
	}
	if (resultEvent.result.outcome === "cancelled") {
		const cancellation = commands.find(
			(command) =>
				command.type === "task.cancel" &&
				command.id === resultEvent.requestId &&
				command.rootTaskId === rootTaskId &&
				command.reason === resultEvent.result.cancellationReason,
		)
		if (cancellation === undefined) {
			return {
				ok: false,
				code: "task_failed",
				message: "Cancelled result does not match its cancellation command",
			}
		}
	}
	return { ok: true }
}
