import { z } from "zod"

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

export const hostEventSchema = z.discriminatedUnion("type", [
	commandAckSchema,
	commandDoneSchema,
	commandErrorSchema,
	heartbeatSchema,
	snapshotSchema,
	normalizedEventSchema,
])

export type HostEvent = z.infer<typeof hostEventSchema>

export function validateMonotonicSequence(
	previous: number,
	next: number,
): { ok: true } | { ok: false; expected: number } {
	const expected = previous + 1
	return next === expected ? { ok: true } : { ok: false, expected }
}

export function validateCommandLifecycle(
	commandIds: readonly string[],
	events: readonly HostEvent[],
): { ok: true } | { ok: false; commandId: string; message: string } {
	for (const commandId of commandIds) {
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
	}
	return { ok: true }
}
