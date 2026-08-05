import { z } from "zod"

import type { HostCommand } from "./host-commands.js"
import { zooErrorSchema } from "./outcomes.js"
import {
	createZooStreamRedactor,
	rawZooStreamEventSchema,
	zooStreamEventSchema,
	type RawZooStreamEvent,
} from "./public-events.js"
import { redactText } from "./redaction.js"
import { ZOO_HOST_PROTOCOL_VERSION } from "./version.js"

const base = {
	v: z.literal(ZOO_HOST_PROTOCOL_VERSION),
	seq: z.number().int().safe().positive(),
	hostId: z.string().min(1),
}

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

const taskReferenceSchema = strictObject({
	rootTaskId: z.string().min(1),
	taskId: z.string().min(1),
})

const taskSummarySchema = strictObject({
	rootTaskId: z.string().min(1),
	currentTaskId: z.string().min(1),
	workspace: z.string().min(1),
	state: z.enum(["running", "waiting", "interrupted", "completed", "failed"]),
})

export const commandDoneDataSchema = z.discriminatedUnion("commandType", [
	strictObject({ commandType: z.literal("task.start"), task: taskReferenceSchema }),
	strictObject({ commandType: z.literal("task.resume"), task: taskReferenceSchema }),
	strictObject({ commandType: z.literal("task.input"), taskId: z.string().min(1) }),
	strictObject({ commandType: z.literal("ask.respond"), taskId: z.string().min(1), askId: z.string().min(1) }),
	strictObject({ commandType: z.literal("task.cancel"), rootTaskId: z.string().min(1) }),
	strictObject({
		commandType: z.literal("history.list"),
		workspace: z.string().min(1),
		tasks: z.array(taskSummarySchema),
	}),
	strictObject({
		commandType: z.literal("host.snapshot"),
		lastSeq: z.number().int().safe().nonnegative(),
		activeRootTaskId: z.string().min(1).optional(),
	}),
	strictObject({ commandType: z.literal("host.shutdown") }),
])

const commandAckSchema = strictObject({ ...base, type: z.literal("command.ack"), commandId: z.string().min(1) })
const commandDoneSchema = strictObject({
	...base,
	type: z.literal("command.done"),
	commandId: z.string().min(1),
	data: commandDoneDataSchema,
})
const commandErrorSchema = strictObject({
	...base,
	type: z.literal("command.error"),
	commandId: z.string().min(1),
	error: zooErrorSchema,
})
const heartbeatSchema = strictObject({
	...base,
	type: z.literal("host.heartbeat"),
	monotonicMs: z.number().finite().nonnegative(),
})
const snapshotSchema = strictObject({
	...base,
	type: z.literal("host.snapshot"),
	lastSeq: z.number().int().safe().nonnegative(),
	activeRootTaskId: z.string().min(1).optional(),
})
const normalizedEventSchema = strictObject({ ...base, type: z.literal("event"), event: zooStreamEventSchema })
const rawNormalizedEventSchema = strictObject({ ...base, type: z.literal("event"), event: rawZooStreamEventSchema })

const hostEventDiscriminatedSchema = z.discriminatedUnion("type", [
	commandAckSchema,
	commandDoneSchema,
	commandErrorSchema,
	heartbeatSchema,
	snapshotSchema,
	normalizedEventSchema,
])

const rawHostEventDiscriminatedSchema = z.discriminatedUnion("type", [
	commandAckSchema,
	commandDoneSchema,
	commandErrorSchema,
	heartbeatSchema,
	snapshotSchema,
	rawNormalizedEventSchema,
])

export const hostEventSchema = hostEventDiscriminatedSchema
	.superRefine((event, context) => {
		if (event.type === "event" && event.event.hostId !== event.hostId) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Normalized event hostId must match its host envelope" })
		}
	})
	.transform((event) =>
		event.type === "command.error"
			? {
					...event,
					error: {
						...event.error,
						message: redactText(event.error.message),
						phase: event.error.phase === undefined ? undefined : redactText(event.error.phase),
					},
				}
			: event,
	)

export type HostEvent = z.infer<typeof hostEventSchema>

export type HostEventStreamParser = {
	push: (event: unknown) => HostEvent[]
	flush: () => HostEvent[]
}

export function createHostEventStreamParser(
	options: {
		maxPendingBytes?: number
		maxPendingEvents?: number
		maxPendingStreams?: number
		maxQueuedEvents?: number
		maxPendingMs?: number
		now?: () => number
	} = {},
): HostEventStreamParser {
	const redactor = createZooStreamRedactor(options)
	const maxQueuedEvents = options.maxQueuedEvents ?? 512
	const maxPendingMs = options.maxPendingMs ?? 1_000
	const now = options.now ?? Date.now
	type QueueEntry = { envelope?: z.infer<typeof rawNormalizedEventSchema>; output?: HostEvent; enqueuedAt: number }
	const queue: QueueEntry[] = []
	const envelopes = new Map<string, QueueEntry[]>()
	let pinnedHostId: string | undefined
	let lastSeq: number | undefined
	const eventKey = (event: RawZooStreamEvent) =>
		JSON.stringify([
			event.hostId,
			event.seq,
			event.timestamp,
			event.type,
			event.requestId,
			"rootTaskId" in event ? event.rootTaskId : undefined,
			"taskId" in event ? event.taskId : undefined,
			"messageId" in event ? event.messageId : undefined,
			"askId" in event ? event.askId : undefined,
			"toolCallId" in event ? event.toolCallId : undefined,
			"operationId" in event ? event.operationId : undefined,
			"stream" in event ? event.stream : undefined,
		])
	const assign = (events: ReturnType<typeof redactor.flush>) => {
		for (const event of events) {
			const key = eventKey(event)
			const entries = envelopes.get(key)
			const entry = entries?.shift()
			if (entry === undefined) throw new Error("Missing host envelope for buffered Zoo stream event")
			if (entries?.length === 0) envelopes.delete(key)
			const envelope = entry.envelope
			if (envelope === undefined) {
				throw new Error("Missing host envelope for buffered Zoo stream event")
			}
			entry.output = { ...envelope, event }
		}
	}
	const drain = (): HostEvent[] => {
		const ready: HostEvent[] = []
		while (queue[0]?.output !== undefined) ready.push(queue.shift()!.output!)
		return ready
	}
	const releaseBlockedQueue = (): HostEvent[] => {
		const oldest = queue[0]
		if (
			oldest !== undefined &&
			(oldest.output === undefined &&
				(queue.length >= maxQueuedEvents || now() - oldest.enqueuedAt >= maxPendingMs))
		) {
			assign(redactor.failClosed())
		}
		return drain()
	}
	const sanitizeNonEvent = (event: z.infer<typeof rawHostEventDiscriminatedSchema>): HostEvent =>
		event.type === "command.error"
			? {
					...event,
					error: {
						...event.error,
						message: redactText(event.error.message),
						phase: event.error.phase === undefined ? undefined : redactText(event.error.phase),
					},
				}
			: event as HostEvent

	return {
		push(input) {
			const event = rawHostEventDiscriminatedSchema.parse(input)
			if (pinnedHostId !== undefined && event.hostId !== pinnedHostId) {
				throw new Error("Host event stream cannot span multiple hosts")
			}
			if (lastSeq !== undefined && !validateMonotonicSequence(lastSeq, event.seq).ok) {
				throw new Error(`Expected host sequence ${lastSeq + 1}`)
			}
			pinnedHostId ??= event.hostId
			lastSeq = event.seq
			const released = releaseBlockedQueue()
			const entry: QueueEntry = { enqueuedAt: now() }
			queue.push(entry)
			if (event.type !== "event") {
				entry.output = sanitizeNonEvent(event)
				return [...released, ...releaseBlockedQueue()]
			}
			if (event.event.hostId !== event.hostId) throw new Error("Normalized event hostId must match its host envelope")
			entry.envelope = event
			const key = eventKey(event.event)
			const entries = envelopes.get(key) ?? []
			entries.push(entry)
			envelopes.set(key, entries)
			assign(redactor.push(event.event))
			return [...released, ...releaseBlockedQueue()]
		},
		flush() {
			assign(redactor.flush())
			const output = drain()
			if (queue.length > 0 || envelopes.size > 0) throw new Error("Host event stream contains unflushed events")
			return output
		},
	}
}

export function validateMonotonicSequence(
	previous: number,
	next: number,
): { ok: true } | { ok: false; expected: number } {
	const expected = previous + 1
	return Number.isSafeInteger(previous) && Number.isSafeInteger(next) && next === expected
		? { ok: true }
		: { ok: false, expected }
}

export function validateCommandLifecycle(
	commands: readonly HostCommand[],
	events: readonly HostEvent[],
): { ok: true } | { ok: false; commandId: string; message: string } {
	const commandById = new Map<string, HostCommand>()
	const startedRoots = new Set<string>()
	for (const command of commands) {
		if (commandById.has(command.id)) {
			return { ok: false, commandId: command.id, message: "Command IDs must be unique" }
		}
		commandById.set(command.id, command)
	}

	const firstHostId = events[0]?.hostId
	for (const [index, event] of events.entries()) {
		if (event.hostId !== firstHostId) {
			const commandId = "commandId" in event ? event.commandId : commands[0]?.id ?? "unknown"
			return { ok: false, commandId, message: "Command lifecycle cannot span multiple hosts" }
		}
		if (
			(event.type === "command.ack" || event.type === "command.done" || event.type === "command.error") &&
			!commandById.has(event.commandId)
		) {
			return { ok: false, commandId: event.commandId, message: "Response references an unknown command" }
		}
		if (index > 0) {
			const expected = events[index - 1]!.seq + 1
			if (event.seq !== expected) {
				const commandId = "commandId" in event ? event.commandId : commands[0]?.id ?? "unknown"
				return { ok: false, commandId, message: `Expected host sequence ${expected}` }
			}
		}
	}

	for (const command of commands) {
		const commandId = command.id
		const commandEvents = events.filter(
			(event) =>
				(event.type === "command.ack" || event.type === "command.done" || event.type === "command.error") &&
				event.commandId === commandId,
		)
		const acknowledgements = commandEvents.filter((event) => event.type === "command.ack")
		const terminals = commandEvents.filter(
			(event) => event.type === "command.done" || event.type === "command.error",
		)
		if (acknowledgements.length !== 1) {
			return { ok: false, commandId, message: `Expected one ACK, received ${acknowledgements.length}` }
		}
		if (terminals.length !== 1) {
			return { ok: false, commandId, message: `Expected one DONE or ERROR, received ${terminals.length}` }
		}
		if (acknowledgements[0]!.seq >= terminals[0]!.seq) {
			return { ok: false, commandId, message: "ACK must precede DONE or ERROR" }
		}
		const terminal = terminals[0]!
		if (terminal.type === "command.done") {
			const data = terminal.data
			const matches = (() => {
				switch (command.type) {
				case "task.start":
						return data.commandType === command.type && data.task.taskId === data.task.rootTaskId
					case "task.resume":
						return (
							data.commandType === command.type &&
							data.task.taskId === command.taskId &&
							data.task.rootTaskId === command.rootTaskId
						)
					case "task.input":
						return data.commandType === command.type && data.taskId === command.taskId
					case "ask.respond":
						return data.commandType === command.type && data.taskId === command.taskId && data.askId === command.askId
					case "task.cancel":
						return data.commandType === command.type && data.rootTaskId === command.rootTaskId
					case "history.list":
						return (
							data.commandType === command.type &&
							data.workspace === command.workspace &&
							data.tasks.every((task) => task.workspace === command.workspace)
						)
					case "host.snapshot":
					case "host.shutdown":
						return data.commandType === command.type
				}
			})()
			if (!matches) {
				return { ok: false, commandId, message: "DONE payload does not match the originating command" }
			}
			if (command.type === "task.start" && data.commandType === "task.start") {
				if (startedRoots.has(data.task.rootTaskId)) {
					return { ok: false, commandId, message: "Successful task starts must return unique root task IDs" }
				}
				startedRoots.add(data.task.rootTaskId)
			}
		}
	}
	return { ok: true }
}
