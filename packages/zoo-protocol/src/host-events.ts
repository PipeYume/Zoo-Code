import { z } from "zod"

import type { HostCommand } from "./host-commands.js"
import { zooErrorSchema } from "./outcomes.js"
import { zooStreamEventSchema } from "./public-events.js"
import { ZOO_HOST_PROTOCOL_VERSION } from "./version.js"

const base = {
	v: z.literal(ZOO_HOST_PROTOCOL_VERSION),
	seq: z.number().int().positive(),
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
	strictObject({ commandType: z.literal("history.list"), tasks: z.array(taskSummarySchema) }),
	strictObject({
		commandType: z.literal("host.snapshot"),
		lastSeq: z.number().int().nonnegative(),
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
	monotonicMs: z.number().nonnegative(),
})
const snapshotSchema = strictObject({
	...base,
	type: z.literal("host.snapshot"),
	lastSeq: z.number().int().nonnegative(),
	activeRootTaskId: z.string().min(1).optional(),
})
const normalizedEventSchema = strictObject({ ...base, type: z.literal("event"), event: zooStreamEventSchema })

const hostEventDiscriminatedSchema = z.discriminatedUnion("type", [
	commandAckSchema,
	commandDoneSchema,
	commandErrorSchema,
	heartbeatSchema,
	snapshotSchema,
	normalizedEventSchema,
])

export const hostEventSchema = hostEventDiscriminatedSchema.superRefine((event, context) => {
	if (event.type === "event" && event.event.hostId !== event.hostId) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "Normalized event hostId must match its host envelope" })
	}
})

export type HostEvent = z.infer<typeof hostEventSchema>

export function validateMonotonicSequence(
	previous: number,
	next: number,
): { ok: true } | { ok: false; expected: number } {
	const expected = previous + 1
	return next === expected ? { ok: true } : { ok: false, expected }
}

export function validateCommandLifecycle(
	commands: readonly HostCommand[],
	events: readonly HostEvent[],
): { ok: true } | { ok: false; commandId: string; message: string } {
	const commandById = new Map<string, HostCommand>()
	for (const command of commands) {
		if (commandById.has(command.id)) {
			return { ok: false, commandId: command.id, message: "Command IDs must be unique" }
		}
		commandById.set(command.id, command)
	}

	const firstHostId = events[0]?.hostId
	for (const event of events) {
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
						return data.commandType === command.type
					case "task.resume":
						return data.commandType === command.type && data.task.taskId === command.taskId
					case "task.input":
						return data.commandType === command.type && data.taskId === command.taskId
					case "ask.respond":
						return data.commandType === command.type && data.taskId === command.taskId && data.askId === command.askId
					case "task.cancel":
						return data.commandType === command.type && data.rootTaskId === command.rootTaskId
					case "history.list":
					case "host.snapshot":
					case "host.shutdown":
						return data.commandType === command.type
				}
			})()
			if (!matches) {
				return { ok: false, commandId, message: "DONE payload does not match the originating command" }
			}
		}
	}
	return { ok: true }
}
