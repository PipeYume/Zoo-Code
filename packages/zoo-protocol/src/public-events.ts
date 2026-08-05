import { z } from "zod"

import type { HostCommand } from "./host-commands.js"
import { failedErrorCodeSchema, zooErrorSchema, zooOutcomeSchema } from "./outcomes.js"
import { REDACTED, redactValue, type RedactedValue } from "./redaction.js"
import { ZOO_PUBLIC_SCHEMA_VERSION } from "./version.js"

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

const redactError = <T extends { message: string; phase?: string }>(error: T): T => ({
	...error,
	message: String(redactValue(error.message)),
	...(error.phase === undefined ? {} : { phase: String(redactValue(error.phase)) }),
})
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
	capabilities: z.array(z.string().min(1)),
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
			return { ...streamEvent, delta: streamEvent.delta.length === 0 ? "" : REDACTED }
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

export const zooStreamSchema = z.array(rawZooStreamEventSchema).transform((events): ZooStreamEvent[] => {
	type BufferedOutput = { pending: string; outputIndex: number }
	const buffers = new Map<string, Map<string, Map<"stdout" | "stderr", BufferedOutput>>>()
	const output = events.map((streamEvent) =>
		streamEvent.type === "terminal.output"
			? ({ ...streamEvent, delta: "" } as ZooStreamEvent)
			: zooStreamEventSchema.parse(streamEvent),
	)
	const bufferFor = (streamEvent: z.infer<typeof terminalOutputEventSchema>, outputIndex: number): BufferedOutput => {
		let taskBuffers = buffers.get(streamEvent.taskId)
		if (taskBuffers === undefined) {
			taskBuffers = new Map()
			buffers.set(streamEvent.taskId, taskBuffers)
		}
		let operationBuffers = taskBuffers.get(streamEvent.toolCallId)
		if (operationBuffers === undefined) {
			operationBuffers = new Map()
			taskBuffers.set(streamEvent.toolCallId, operationBuffers)
		}
		const existing = operationBuffers.get(streamEvent.stream)
		if (existing !== undefined) return existing
		const created = { pending: "", outputIndex }
		operationBuffers.set(streamEvent.stream, created)
		return created
	}
	const flush = (buffer: BufferedOutput) => {
		if (buffer.pending.length === 0) return
		const event = output[buffer.outputIndex]
		if (event?.type === "terminal.output") event.delta += String(redactValue(buffer.pending))
		buffer.pending = ""
	}

	events.forEach((streamEvent, index) => {
		if (streamEvent.type === "terminal.output") {
			const buffer = bufferFor(streamEvent, index)
			buffer.pending += streamEvent.delta
			buffer.outputIndex = index
			const boundary = buffer.pending.lastIndexOf("\n")
			if (boundary >= 0) {
				const event = output[index]
				if (event?.type === "terminal.output") event.delta = String(redactValue(buffer.pending.slice(0, boundary + 1)))
				buffer.pending = buffer.pending.slice(boundary + 1)
			}
		} else if (
			streamEvent.type === "terminal.status" &&
			(streamEvent.state === "exited" || streamEvent.state === "killed")
		) {
			for (const buffer of buffers.get(streamEvent.taskId)?.get(streamEvent.toolCallId)?.values() ?? []) flush(buffer)
		}
	})
	for (const taskBuffers of buffers.values()) {
		for (const operationBuffers of taskBuffers.values()) {
			for (const buffer of operationBuffers.values()) flush(buffer)
		}
	}
	return output
})

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
	const resumedEvents = events.filter((streamEvent) => streamEvent.type === "task.resumed")
	const startCommands = commands.filter((command) => command.type === "task.start")
	const resumeCommands = commands.filter((command) => command.type === "task.resume")
	if (resumedEvents.length === 0) {
		const start = startCommands[0]
		if (
			startCommands.length !== 1 ||
			resumeCommands.length !== 0 ||
			start === undefined ||
			resultEvent.result.workspace !== start.workspace ||
			(resultEvent.result.outcome !== "cancelled" && resultEvent.requestId !== start.id)
		) {
			return { ok: false, code: "task_failed", message: "Fresh streams must match exactly one task.start command" }
		}
	} else if (resumedEvents.length !== 1 || startCommands.length !== 0 || resumeCommands.length !== 1) {
		return { ok: false, code: "task_failed", message: "Resume streams must match exactly one task.resume command" }
	}

	const pendingAsks = new Map<string, Set<string>>()
	const settledAsks = new Map<string, Set<string>>()
	const consumedResponseCommands = new Set<string>()
	const abandonedAsks = new Map<string, Map<string, "cancelled" | "timed_out">>()
	const taskStates = new Map<string, "running" | "waiting" | "interrupted" | "completed" | "failed">()
	const endedStates = new Set(["completed", "failed"])
	const settledStates = new Set(["interrupted", "completed", "failed"])
	const taskParents = new Map<string, string | null>()
	const createdTasks = new Set<string>()
	const delegatedTasks = new Set<string>()
	const resumedTasks = new Set<string>()
	const startedTasks = new Set<string>()
	type MessageState = { role: "assistant" | "user" | "reasoning"; complete: boolean }
	type ToolState = { state: "active" | "terminal"; name: string }
	type McpState = { state: "active" | "terminal"; server: string; operation: string }
	const toolStates = new Map<string, Map<string, ToolState>>()
	const terminalOperationStates = new Map<string, Map<string, "active" | "terminal">>()
	const mcpStates = new Map<string, Map<string, McpState>>()
	const messageStates = new Map<string, Map<string, MessageState>>()
	const scope = <T>(map: Map<string, Map<string, T>>, taskId: string): Map<string, T> => {
		const existing = map.get(taskId)
		if (existing !== undefined) return existing
		const created = new Map<string, T>()
		map.set(taskId, created)
		return created
	}
	const askScope = (taskId: string): Set<string> => {
		const existing = pendingAsks.get(taskId)
		if (existing !== undefined) return existing
		const created = new Set<string>()
		pendingAsks.set(taskId, created)
		return created
	}
	const setScope = (map: Map<string, Set<string>>, taskId: string): Set<string> => {
		const existing = map.get(taskId)
		if (existing !== undefined) return existing
		const created = new Set<string>()
		map.set(taskId, created)
		return created
	}
	const values = <T>(map: Map<string, Map<string, T>>): T[] => [...map.values()].flatMap((entries) => [...entries.values()])
	const isDescendantOf = (taskId: string, parentTaskId: string): boolean => {
		let current = taskParents.get(taskId)
		while (current !== undefined && current !== null) {
			if (current === parentTaskId) return true
			current = taskParents.get(current)
		}
		return false
	}
	const hasPendingAskInAncestry = (taskId: string): boolean => {
		let current: string | null | undefined = taskId
		while (current !== undefined && current !== null) {
			if ((pendingAsks.get(current)?.size ?? 0) > 0) return true
			current = taskParents.get(current)
		}
		return false
	}
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
				(parentTaskId !== null && settledStates.has(taskStates.get(parentTaskId) ?? "")) ||
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
			if (streamEvent.taskId === rootTaskId && resumedEvents.length === 0 && streamEvent.requestId !== startCommands[0]?.id) {
				return { ok: false, code: "task_failed", message: "Root creation must match its task.start request" }
			}
		} else if (streamEvent.type === "task.delegated") {
			if (
				streamEvent.taskId !== streamEvent.childTaskId ||
				streamEvent.childTaskId === rootTaskId ||
				streamEvent.childTaskId === streamEvent.parentTaskId ||
				!createdTasks.has(streamEvent.parentTaskId) ||
				!createdTasks.has(streamEvent.childTaskId) ||
				settledStates.has(taskStates.get(streamEvent.parentTaskId) ?? "") ||
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
		if (
			(previousState !== undefined && endedStates.has(previousState)) ||
			(previousState === "interrupted" && streamEvent.type !== "task.resumed")
		) {
			return {
				ok: false,
				code: "task_failed",
				message: `Task ${streamEvent.taskId} emitted an event after termination`,
			}
		}
		if (streamEvent.type === "task.started") {
			const parentTaskId = taskParents.get(streamEvent.taskId)
			const reconstructingResumedDescendant =
				resumedEvents.length === 1 && resumeCommands[0]?.taskId === streamEvent.taskId && resumedTasks.has(streamEvent.taskId)
			if (
				startedTasks.has(streamEvent.taskId) ||
				(previousState !== undefined && previousState !== "running") ||
				(resumeCommands[0]?.taskId === streamEvent.taskId && !resumedTasks.has(streamEvent.taskId)) ||
				(parentTaskId !== null &&
					parentTaskId !== undefined &&
					taskStates.get(parentTaskId) !== "running" &&
					!reconstructingResumedDescendant)
			) {
				return { ok: false, code: "task_failed", message: `Invalid start transition for task ${streamEvent.taskId}` }
			}
			startedTasks.add(streamEvent.taskId)
			taskStates.set(streamEvent.taskId, "running")
		}
		if (streamEvent.type === "task.lifecycle") {
			const resume = resumeCommands[0]
			const reconstructingPredecessor =
				!startedTasks.has(streamEvent.taskId) &&
				resume?.taskId === streamEvent.taskId &&
				!resumedTasks.has(streamEvent.taskId) &&
				(streamEvent.state === "waiting" || streamEvent.state === "interrupted")
			if (!startedTasks.has(streamEvent.taskId) && !reconstructingPredecessor) {
				return { ok: false, code: "task_failed", message: "Task lifecycle requires an ordered task.started event" }
			}
			if ((pendingAsks.get(streamEvent.taskId)?.size ?? 0) > 0 && settledStates.has(streamEvent.state)) {
				return { ok: false, code: "task_failed", message: "A task with a pending ask cannot terminate" }
			}
			if (
				settledStates.has(streamEvent.state) &&
				[...createdTasks].some(
					(taskId) => isDescendantOf(taskId, streamEvent.taskId) && !settledStates.has(taskStates.get(taskId) ?? ""),
				)
			) {
				return { ok: false, code: "task_failed", message: "A task cannot terminate before its descendants" }
			}
			taskStates.set(streamEvent.taskId, streamEvent.state)
		}
		if (streamEvent.type === "task.resumed") {
			const resume = resumeCommands[0]
			if (
				resume === undefined ||
				resume.id !== streamEvent.requestId ||
				resume.taskId !== streamEvent.taskId ||
				resume.rootTaskId !== streamEvent.rootTaskId ||
				resultEvent.requestId !== resume.id ||
				resumedTasks.size > 0 ||
				previousState !== streamEvent.previousState
			) {
				return { ok: false, code: "task_failed", message: "task.resumed must match reconstructed persisted state" }
			}
			resumedTasks.add(streamEvent.taskId)
			taskStates.set(streamEvent.taskId, "running")
		}
		if (
			[
				"message.upsert",
				"ask.required",
				"ask.resolved",
				"ask.abandoned",
				"tool.started",
				"tool.updated",
				"tool.completed",
				"tool.failed",
				"terminal.output",
				"terminal.status",
				"mcp.started",
				"mcp.completed",
				"mcp.failed",
				"usage.updated",
			].includes(streamEvent.type) &&
			!startedTasks.has(streamEvent.taskId)
		) {
			return { ok: false, code: "task_failed", message: "Task operation requires an ordered task.started event" }
		}
		if (
			[
				"tool.started",
				"tool.updated",
				"tool.completed",
				"tool.failed",
				"terminal.output",
				"terminal.status",
				"mcp.started",
				"mcp.completed",
				"mcp.failed",
			].includes(streamEvent.type) &&
			(taskStates.get(streamEvent.taskId) !== "running" || hasPendingAskInAncestry(streamEvent.taskId))
		) {
			return { ok: false, code: "task_failed", message: "Task operations require an unblocked running task" }
		}
		if (streamEvent.type === "message.upsert") {
			const messages = scope(messageStates, streamEvent.taskId)
			const previous = messages.get(streamEvent.messageId)
			if (previous?.complete === true || (previous !== undefined && previous.role !== streamEvent.role)) {
				return { ok: false, code: "task_failed", message: `Invalid update for message ${streamEvent.messageId}` }
			}
			messages.set(streamEvent.messageId, { role: streamEvent.role, complete: streamEvent.complete })
		}
		if (streamEvent.type === "ask.required") {
			const asks = askScope(streamEvent.taskId)
			if (asks.has(streamEvent.askId) || settledAsks.get(streamEvent.taskId)?.has(streamEvent.askId) === true) {
				return { ok: false, code: "task_failed", message: `Ask ${streamEvent.askId} was already used` }
			}
			asks.add(streamEvent.askId)
		}
		if (streamEvent.type === "ask.resolved") {
			if (!pendingAsks.get(streamEvent.taskId)?.delete(streamEvent.askId)) {
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
						!consumedResponseCommands.has(command.id) &&
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
				if (response !== undefined) consumedResponseCommands.add(response.id)
			}
			setScope(settledAsks, streamEvent.taskId).add(streamEvent.askId)
		}
		if (streamEvent.type === "ask.abandoned") {
			if (!pendingAsks.get(streamEvent.taskId)?.delete(streamEvent.askId)) {
				return { ok: false, code: "task_failed", message: `Ask ${streamEvent.askId} was not pending` }
			}
			scope(abandonedAsks, streamEvent.taskId).set(streamEvent.askId, streamEvent.reason)
			setScope(settledAsks, streamEvent.taskId).add(streamEvent.askId)
		}

		if (streamEvent.type === "tool.started") {
			const tools = scope(toolStates, streamEvent.taskId)
			if (tools.has(streamEvent.toolCallId))
				return { ok: false, code: "task_failed", message: "Tool operation started twice" }
			tools.set(streamEvent.toolCallId, { state: "active", name: streamEvent.name })
		} else if (
			streamEvent.type === "tool.updated" ||
			streamEvent.type === "tool.completed" ||
			streamEvent.type === "tool.failed"
		) {
			const tools = scope(toolStates, streamEvent.taskId)
			const tool = tools.get(streamEvent.toolCallId)
			if (tool?.state !== "active" || tool.name !== streamEvent.name) {
				return { ok: false, code: "task_failed", message: "Tool event requires an active operation" }
			}
			if (streamEvent.type === "tool.completed" || streamEvent.type === "tool.failed")
				tools.set(streamEvent.toolCallId, { ...tool, state: "terminal" })
		}

		if (streamEvent.type === "terminal.status") {
			const operations = scope(terminalOperationStates, streamEvent.taskId)
			const state = operations.get(streamEvent.toolCallId)
			if (streamEvent.state === "running") {
				if (state !== undefined)
					return { ok: false, code: "task_failed", message: "Terminal operation started twice" }
				operations.set(streamEvent.toolCallId, "active")
			} else if (state !== "active") {
				return { ok: false, code: "task_failed", message: "Terminal status requires an active operation" }
			} else if (streamEvent.state === "exited" || streamEvent.state === "killed") {
				operations.set(streamEvent.toolCallId, "terminal")
			}
		} else if (
			streamEvent.type === "terminal.output" &&
			terminalOperationStates.get(streamEvent.taskId)?.get(streamEvent.toolCallId) !== "active"
		) {
			return { ok: false, code: "task_failed", message: "Terminal output requires an active operation" }
		}

		if (streamEvent.type === "mcp.started") {
			const operations = scope(mcpStates, streamEvent.taskId)
			if (operations.has(streamEvent.operationId))
				return { ok: false, code: "task_failed", message: "MCP operation started twice" }
			operations.set(streamEvent.operationId, {
				state: "active",
				server: streamEvent.server,
				operation: streamEvent.operation,
			})
		} else if (streamEvent.type === "mcp.completed" || streamEvent.type === "mcp.failed") {
			const operations = scope(mcpStates, streamEvent.taskId)
			const operation = operations.get(streamEvent.operationId)
			if (
				operation?.state !== "active" ||
				operation.server !== streamEvent.server ||
				operation.operation !== streamEvent.operation
			) {
				return { ok: false, code: "task_failed", message: "MCP result requires an active operation" }
			}
			operations.set(streamEvent.operationId, { ...operation, state: "terminal" })
		}
	}
	const pendingAskCount = [...pendingAsks.values()].reduce((count, asks) => count + asks.size, 0)
	if (pendingAskCount > 0 && resultEvent.result.outcome !== "needs_input") {
		return { ok: false, code: "task_failed", message: "Terminal stream contains unresolved asks" }
	}
	if (
		resultEvent.result.outcome === "needs_input" &&
		[...pendingAsks].some(([taskId, asks]) => asks.size > 0 && taskStates.get(taskId) !== "waiting")
	) {
		return { ok: false, code: "task_failed", message: "Pending asks must belong to waiting tasks" }
	}
	if (resumeCommands.length !== resumedTasks.size) {
		return { ok: false, code: "task_failed", message: "Every resume command must reconstruct one resumed task" }
	}
	if (values(abandonedAsks).some((reason) => reason !== resultEvent.result.outcome)) {
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
		[...values(toolStates), ...values(mcpStates)].some((operation) => operation.state === "active") ||
		values(terminalOperationStates).includes("active")
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
