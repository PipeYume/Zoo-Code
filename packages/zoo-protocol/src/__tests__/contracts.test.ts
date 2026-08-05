import {
	EXIT_CODES,
	ZOO_HOST_PROTOCOL_VERSION,
	assertAuthoritativeRootResult,
	compareSemanticTraces,
	exitContextSchema,
	exitCodeFor,
	hostCommandSchema,
	hostEventSchema,
	hostHelloSchema,
	negotiateProtocol,
	parentHelloSchema,
	parityScenarios,
	redactText,
	redactValue,
	runDeterministicFakeProvider,
	validateCommandLifecycle,
	validateMonotonicSequence,
	validateParentHello,
	validateStreamLifecycle,
	zooRunResultSchema,
	zooStreamEventSchema,
	zooStreamSchema,
} from "../index.js"

const timestamp = "2026-08-05T12:00:00.000Z"
const startCommand = hostCommandSchema.parse({
	v: 1,
	id: "start",
	type: "task.start",
	workspace: "/workspace",
	prompt: "Start",
})

const initEvent = zooStreamEventSchema.parse({
	v: 1,
	seq: 1,
	timestamp,
	hostId: "host",
	type: "system.init",
	protocol: "zoo-stream",
	capabilities: ["task:start"],
	clientVersion: "1.0.0",
	hostVersion: "1.0.0",
})

function taskEvent(seq: number, type: string, fields: Record<string, unknown> = {}) {
	return zooStreamEventSchema.parse({
		v: 1,
		seq,
		timestamp,
		hostId: "host",
		type,
		rootTaskId: "root",
		taskId: "root",
		...(type === "task.created" ? { requestId: "start" } : {}),
		...fields,
	})
}

function resultEvent(seq: number, result: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
	const outcome = result.outcome ?? "completed"
	const parsed = taskEvent(seq, "task.result", {
		requestId: "start",
		result: {
			schemaVersion: 1,
			protocol: "zoo-run-result",
			success: outcome === "completed",
			outcome,
			rootTaskId: "root",
			workspace: "/workspace",
			resumable: false,
			elapsedMs: 10,
			...result,
		},
		...event,
	})
	if (parsed.type !== "task.result") throw new Error("Expected task.result fixture")
	return parsed
}

describe("strict host contracts", () => {
	it("accepts a valid start and rejects unknown fields", () => {
		const command = {
			v: ZOO_HOST_PROTOCOL_VERSION,
			id: "command-1",
			type: "task.start",
			workspace: "/workspace",
			prompt: "Fix the test",
			overrides: { approval: "safe" },
		}
		expect(hostCommandSchema.parse(command)).toEqual(command)
		expect(hostCommandSchema.safeParse({ ...command, unexpected: true }).success).toBe(false)
		expect(hostCommandSchema.safeParse({ ...command, overrides: { reasoningEffort: "max" } }).success).toBe(true)
		expect(hostCommandSchema.safeParse({ ...command, overrides: { reasoningEffort: "disabled" } }).success).toBe(
			true,
		)
		const formattedPrompt = hostCommandSchema.parse({ ...command, prompt: "  formatted prompt\n" })
		expect(formattedPrompt.type === "task.start" && formattedPrompt.prompt).toBe("  formatted prompt\n")
		expect(hostCommandSchema.safeParse({ ...command, prompt: " \n\t" }).success).toBe(false)
	})

	it("enforces input and approval payload invariants", () => {
		expect(hostCommandSchema.safeParse({ v: 1, id: "1", type: "task.input", taskId: "task" }).success).toBe(false)
		expect(
			hostCommandSchema.safeParse({ v: 1, id: "1", type: "task.input", taskId: "task", text: " \n" }).success,
		).toBe(false)
		expect(
			hostCommandSchema.safeParse({
				v: 1,
				id: "1",
				type: "ask.respond",
				taskId: "task",
				askId: "ask",
				response: "message",
			}).success,
		).toBe(false)
		expect(
			hostCommandSchema.safeParse({
				v: 1,
				id: "1",
				type: "ask.respond",
				taskId: "task",
				askId: "ask",
				response: "message",
				text: " \t",
			}).success,
		).toBe(false)
	})

	it("negotiates versions and required capabilities", () => {
		const hello = hostHelloSchema.parse({
			type: "hello",
			hostId: "host-1",
			supportedVersions: [1],
			capabilities: { 1: ["task:start", "host:shutdown", "future:additive-capability"] },
			buildVersion: "1.0.0",
		})
		expect(negotiateProtocol(hello, [1], ["task:start"])).toEqual({ ok: true, version: 1 })
		expect(negotiateProtocol(hello, [2], ["task:start"])).toMatchObject({ ok: false })
		expect(negotiateProtocol(hello, [1], ["task:resume"])).toMatchObject({ ok: false })
		const multiVersionHello = hostHelloSchema.parse({
			...hello,
			supportedVersions: [1, 2],
			capabilities: { 1: ["task:start"], 2: ["task:start", "task:resume"] },
		})
		expect(negotiateProtocol(multiVersionHello, [1], ["task:resume"])).toMatchObject({ ok: false })
		expect(negotiateProtocol(multiVersionHello, [2, 1], ["task:resume"])).toMatchObject({ ok: false })
		const lowerVersionCapabilities = hostHelloSchema.parse({
			...hello,
			supportedVersions: [1, 2],
			capabilities: { 1: ["task:start", "task:resume"], 2: ["task:start"] },
		})
		expect(negotiateProtocol(lowerVersionCapabilities, [2, 1], ["task:resume"])).toEqual({ ok: true, version: 1 })
	})

	it("binds parent selection to the host advertisement", () => {
		const host = hostHelloSchema.parse({
			type: "hello",
			hostId: "host-1",
			supportedVersions: [1, 2],
			capabilities: { 1: ["task:start"], 2: ["task:start", "task:resume"] },
			buildVersion: "1.0.0",
		})
		const selected = parentHelloSchema.parse({
			type: "hello.select",
			version: 2,
			clientVersion: "1.0.0",
			requiredCapabilities: ["task:resume"],
		})
		expect(validateParentHello(host, selected)).toMatchObject({ ok: false })
		expect(validateParentHello(host, { ...selected, version: 3 })).toMatchObject({ ok: false })
		expect(validateParentHello(host, { ...selected, version: 1 })).toMatchObject({ ok: false })
		expect(
			validateParentHello(host, { ...selected, version: 1, requiredCapabilities: ["task:start"] }),
		).toEqual({ ok: true, version: 1 })
	})

	it("requires contiguous host sequence numbers", () => {
		expect(validateMonotonicSequence(8, 9)).toEqual({ ok: true })
		expect(validateMonotonicSequence(8, 10)).toEqual({ ok: false, expected: 9 })
		expect(validateMonotonicSequence(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: false })
		expect(
			hostEventSchema.safeParse({
				v: 1,
				seq: Number.MAX_SAFE_INTEGER + 1,
				hostId: "host",
				type: "command.ack",
				commandId: "cmd",
			}).success,
		).toBe(false)
	})

	it("models one ACK and terminal command response independently", () => {
		const command = hostCommandSchema.parse({ v: 1, id: "cmd", type: "host.shutdown" })
		const events = [
			hostEventSchema.parse({ v: 1, seq: 1, hostId: "host", type: "command.ack", commandId: "cmd" }),
			hostEventSchema.parse({
				v: 1,
				seq: 2,
				hostId: "host",
				type: "command.done",
				commandId: "cmd",
				data: { commandType: "host.shutdown" },
			}),
		]
		expect(validateCommandLifecycle([command], events)).toEqual({ ok: true })
		expect(validateCommandLifecycle([command], [...events, events[1]!])).toMatchObject({ ok: false })
		expect(validateCommandLifecycle([command], [events[1]!, events[0]!])).toMatchObject({ ok: false })
		expect(validateCommandLifecycle([command], [events[0]!, { ...events[1]!, seq: 3 }])).toMatchObject({
			ok: false,
		})
	})

	it("correlates terminal responses with commands and hosts", () => {
		const command = hostCommandSchema.parse({
			v: 1,
			id: "cmd",
			type: "ask.respond",
			taskId: "task",
			askId: "ask",
			response: "approve",
		})
		const acknowledgement = hostEventSchema.parse({
			v: 1,
			seq: 1,
			hostId: "host-a",
			type: "command.ack",
			commandId: "cmd",
		})
		const completion = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host-a",
			type: "command.done",
			commandId: "cmd",
			data: { commandType: "ask.respond", taskId: "task", askId: "ask" },
		})
		const mismatchedIdentity = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host-a",
			type: "command.done",
			commandId: "cmd",
			data: { commandType: "ask.respond", taskId: "task", askId: "other" },
		})
		const mismatchedType = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host-a",
			type: "command.done",
			commandId: "cmd",
			data: { commandType: "host.shutdown" },
		})
		expect(validateCommandLifecycle([command], [acknowledgement, completion])).toEqual({ ok: true })
		expect(validateCommandLifecycle([command], [acknowledgement, mismatchedIdentity])).toMatchObject({ ok: false })
		expect(validateCommandLifecycle([command], [acknowledgement, mismatchedType])).toMatchObject({ ok: false })
		expect(
			validateCommandLifecycle([command], [acknowledgement, { ...completion, hostId: "host-b" }]),
		).toMatchObject({
			ok: false,
		})
	})

	it("rejects missing and mismatched command completion payloads", () => {
		const done = { v: 1, seq: 1, hostId: "host", type: "command.done", commandId: "cmd" }
		expect(hostEventSchema.safeParse(done).success).toBe(false)
		expect(
			hostEventSchema.safeParse({
				...done,
				data: { commandType: "task.start", task: { rootTaskId: "root" } },
			}).success,
		).toBe(false)
		const start = hostCommandSchema.parse({
			v: 1,
			id: "cmd",
			type: "task.start",
			workspace: "/workspace",
			prompt: "start",
		})
		const acknowledgement = hostEventSchema.parse({
			v: 1,
			seq: 1,
			hostId: "host",
			type: "command.ack",
			commandId: "cmd",
		})
		const childCompletion = hostEventSchema.parse({
			...done,
			seq: 2,
			data: { commandType: "task.start", task: { rootTaskId: "root", taskId: "child" } },
		})
		expect(validateCommandLifecycle([start], [acknowledgement, childCompletion])).toMatchObject({ ok: false })
	})

	it("does not reuse root identities across successful starts", () => {
		const commands = ["first", "second"].map((id) =>
			hostCommandSchema.parse({ v: 1, id, type: "task.start", workspace: "/workspace", prompt: id }),
		)
		const events = commands.flatMap((command, index) => [
			hostEventSchema.parse({
				v: 1,
				seq: index * 2 + 1,
				hostId: "host",
				type: "command.ack",
				commandId: command.id,
			}),
			hostEventSchema.parse({
				v: 1,
				seq: index * 2 + 2,
				hostId: "host",
				type: "command.done",
				commandId: command.id,
				data: { commandType: "task.start", task: { rootTaskId: "root", taskId: "root" } },
			}),
		])
		expect(validateCommandLifecycle(commands, events)).toMatchObject({ ok: false })
	})

	it("redacts command errors before they cross the host boundary", () => {
		const parsed = hostEventSchema.parse({
			v: 1,
			seq: 1,
			hostId: "host",
			type: "command.error",
			commandId: "command",
			error: { code: "provider_failed", message: "password=hunter2", phase: "token=secret" },
		})
		expect(parsed.type === "command.error" && parsed.error.message).toBe("[REDACTED]")
		expect(parsed.type === "command.error" && parsed.error.phase).toBe("[REDACTED]")
	})

	it("binds history completion data to its requested workspace", () => {
		const command = hostCommandSchema.parse({
			v: 1,
			id: "history",
			type: "history.list",
			workspace: "/workspace",
		})
		const acknowledgement = hostEventSchema.parse({
			v: 1,
			seq: 1,
			hostId: "host",
			type: "command.ack",
			commandId: "history",
		})
		const completion = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host",
			type: "command.done",
			commandId: "history",
			data: { commandType: "history.list", workspace: "/workspace", tasks: [] },
		})
		const mismatchedCompletion = hostEventSchema.parse({
			v: 1,
			seq: 2,
			hostId: "host",
			type: "command.done",
			commandId: "history",
			data: { commandType: "history.list", workspace: "/other", tasks: [] },
		})
		expect(validateCommandLifecycle([command], [acknowledgement, completion])).toEqual({ ok: true })
		expect(validateCommandLifecycle([command], [acknowledgement, mismatchedCompletion])).toMatchObject({
			ok: false,
		})
	})
})

describe("public automation contracts", () => {
	it("validates one-object results and semantic success", () => {
		const result = {
			schemaVersion: 1,
			protocol: "zoo-run-result",
			success: true,
			outcome: "completed",
			rootTaskId: "root",
			workspace: "/workspace",
			resumable: false,
			content: "Finished",
			elapsedMs: 25,
		}
		expect(zooRunResultSchema.parse(result)).toEqual(result)
		expect(zooRunResultSchema.safeParse({ ...result, success: false }).success).toBe(false)
		expect(
			zooRunResultSchema.safeParse({
				...result,
				error: { code: "task_failed", message: "contradiction" },
			}).success,
		).toBe(false)
		expect(
			zooRunResultSchema.safeParse({
				...result,
				success: false,
				outcome: "needs_input",
				error: { code: "provider_failed", message: "contradiction" },
			}).success,
		).toBe(false)
		expect(
			zooRunResultSchema.safeParse({
				...result,
				success: false,
				outcome: "failed",
				error: { code: "task_timed_out", message: "contradiction" },
			}).success,
		).toBe(false)
	})

	it("validates strict, ordered stream records", () => {
		const event = {
			v: 1,
			seq: 1,
			timestamp,
			hostId: "host",
			type: "message.upsert",
			rootTaskId: "root",
			taskId: "root",
			messageId: "message-1",
			role: "assistant",
			content: "hello",
			complete: false,
		}
		expect(zooStreamEventSchema.parse(event)).toEqual(event)
		expect(zooStreamEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...event, seq: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...event, rawSecret: "no" }).success).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...event, taskId: undefined }).success).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...initEvent, capabilities: ["task:start", "future:additive"] }).success).toBe(
			true,
		)
	})

	it("requires init, contiguous sequence, and a settled authoritative root", () => {
		const created = taskEvent(2, "task.created")
		const started = taskEvent(3, "task.started")
		const completed = taskEvent(4, "task.lifecycle", { state: "completed" })
		const result = resultEvent(5)
		expect(validateStreamLifecycle([initEvent, created, started, completed, result], [startCommand])).toEqual({ ok: true })
		expect(
			validateStreamLifecycle(
				[initEvent, created, started, completed, resultEvent(5, { workspace: "/other" })],
				[startCommand],
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[initEvent, created, started, completed, resultEvent(5, {}, { requestId: "other" })],
				[startCommand],
			),
		).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([initEvent, resultEvent(2)])).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([initEvent, created, resultEvent(3)])).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([initEvent, created, completed, { ...result, hostId: "other-host" }]),
		).toMatchObject({
			ok: false,
		})
		expect(validateStreamLifecycle([{ ...initEvent, seq: 2 }, created, completed, result])).toMatchObject({
			ok: false,
		})
		expect(validateStreamLifecycle([initEvent])).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([initEvent, created, completed, { ...result, taskId: "child" }])).toMatchObject({
			ok: false,
		})
		expect(
			validateStreamLifecycle([initEvent, created, taskEvent(3, "task.lifecycle", { state: "failed" }), result]),
		).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([initEvent, { ...initEvent, seq: 2 }, resultEvent(3)])).toMatchObject({
			ok: false,
		})
	})

	it("validates task-tree settlement and approval command causation", () => {
		const rootCreated = taskEvent(2, "task.created")
		const rootStarted = taskEvent(3, "task.started")
		const childCreated = taskEvent(4, "task.created", { taskId: "child", parentTaskId: "root" })
		const delegated = taskEvent(5, "task.delegated", {
			taskId: "child",
			parentTaskId: "root",
			childTaskId: "child",
		})
		const childStarted = taskEvent(6, "task.started", { taskId: "child" })
		const childCompleted = taskEvent(7, "task.lifecycle", { taskId: "child", state: "completed" })
		const rootCompleted = taskEvent(8, "task.lifecycle", { state: "completed" })
		expect(
			validateStreamLifecycle([
				initEvent,
				rootCreated,
				rootStarted,
				childCreated,
				delegated,
				childStarted,
				childCompleted,
				rootCompleted,
				resultEvent(9),
			], [startCommand]),
		).toEqual({ ok: true })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					rootCreated,
					rootStarted,
					childCreated,
					delegated,
					childStarted,
					{ ...rootCompleted, seq: 7 },
					{ ...childCompleted, seq: 8 },
					resultEvent(9),
				],
				[startCommand],
			),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([initEvent, rootCreated, childCreated, delegated, rootCompleted, resultEvent(6)]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				rootCreated,
				childCreated,
				taskEvent(4, "task.lifecycle", { taskId: "child", state: "completed" }),
				taskEvent(5, "task.lifecycle", { state: "completed" }),
				resultEvent(6),
			]),
		).toMatchObject({ ok: false })
		const mismatchedDelegation = taskEvent(4, "task.delegated", {
			taskId: "root",
			parentTaskId: "root",
			childTaskId: "child",
		})
		expect(
			validateStreamLifecycle([
				initEvent,
				rootCreated,
				childCreated,
				mismatchedDelegation,
				rootCompleted,
				resultEvent(6),
			]),
		).toMatchObject({ ok: false })

		const required = taskEvent(4, "ask.required", {
			askId: "ask",
			category: "tool",
			subject: "Run command",
		})
		const resolved = taskEvent(5, "ask.resolved", {
			requestId: "respond",
			askId: "ask",
			decision: "approve",
			source: "user",
		})
		const response = hostCommandSchema.parse({
			v: 1,
			id: "respond",
			type: "ask.respond",
			taskId: "root",
			askId: "ask",
			response: "approve",
		})
		const completed = taskEvent(6, "task.lifecycle", { state: "completed" })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, rootStarted, required, resolved, completed, resultEvent(7)],
				[startCommand, response],
			),
		).toEqual({
			ok: true,
		})
		const mismatchedResolution = zooStreamEventSchema.parse({ ...resolved, decision: "reject" })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, required, mismatchedResolution, completed, resultEvent(6)],
				[response],
			),
		).toMatchObject({ ok: false })
		const deniedApproval = zooStreamEventSchema.parse({ ...resolved, source: "deny" })
		expect(
			validateStreamLifecycle([initEvent, rootCreated, required, deniedApproval, completed, resultEvent(6)]),
		).toMatchObject({ ok: false })
	})

	it("correlates cancellation and settles operation lifecycles", () => {
		const created = taskEvent(2, "task.created")
		const started = taskEvent(3, "task.started")
		const toolStarted = taskEvent(4, "tool.started", { toolCallId: "tool", name: "read" })
		const toolCompleted = taskEvent(5, "tool.completed", { toolCallId: "tool", name: "read" })
		const terminalStarted = taskEvent(6, "terminal.status", { toolCallId: "terminal", state: "running" })
		const terminalExited = taskEvent(7, "terminal.status", { toolCallId: "terminal", state: "exited", exitCode: 0 })
		const mcpStarted = taskEvent(8, "mcp.started", { operationId: "mcp", server: "test", operation: "read" })
		const mcpCompleted = taskEvent(9, "mcp.completed", { operationId: "mcp", server: "test", operation: "read" })
		const interrupted = taskEvent(10, "task.lifecycle", { state: "interrupted" })
		const cancelled = resultEvent(11, { outcome: "cancelled", cancellationReason: "user" }, { requestId: "cancel" })
		const command = hostCommandSchema.parse({
			v: 1,
			id: "cancel",
			type: "task.cancel",
			rootTaskId: "root",
			reason: "user",
		})
		if (command.type !== "task.cancel") throw new Error("Expected task.cancel fixture")
		const stream = [
			initEvent,
			created,
			started,
			toolStarted,
			toolCompleted,
			terminalStarted,
			terminalExited,
			mcpStarted,
			mcpCompleted,
			interrupted,
			cancelled,
		]
		expect(validateStreamLifecycle(stream, [startCommand, command])).toEqual({ ok: true })
		expect(validateStreamLifecycle(stream)).toMatchObject({ ok: false })
		expect(validateStreamLifecycle(stream, [{ ...command, reason: "signal" }])).toMatchObject({ ok: false })
		expect(
			zooStreamEventSchema.safeParse({
				...terminalStarted,
				exitCode: 0,
			}).success,
		).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...terminalExited, exitCode: undefined }).success).toBe(false)
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				toolStarted,
				taskEvent(4, "tool.completed", { toolCallId: "tool", name: "write" }),
				taskEvent(5, "task.lifecycle", { state: "completed" }),
				resultEvent(6),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				mcpStarted,
				taskEvent(4, "mcp.completed", { operationId: "mcp", server: "other", operation: "read" }),
				taskEvent(5, "task.lifecycle", { state: "completed" }),
				resultEvent(6),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				toolCompleted,
				taskEvent(4, "task.lifecycle", { state: "completed" }),
				resultEvent(5),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				toolStarted,
				taskEvent(4, "task.lifecycle", { state: "completed" }),
				resultEvent(5),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				taskEvent(3, "terminal.status", { toolCallId: "terminal", state: "exited", exitCode: 0 }),
				taskEvent(4, "task.lifecycle", { state: "completed" }),
				resultEvent(5),
			]),
		).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				initEvent,
				created,
				mcpCompleted,
				taskEvent(4, "task.lifecycle", { state: "completed" }),
				resultEvent(5),
			]),
		).toMatchObject({ ok: false })
	})

	it("abandons pending asks only for cancellation or timeout", () => {
		const created = taskEvent(2, "task.created")
		const started = taskEvent(3, "task.started")
		const required = taskEvent(4, "ask.required", { askId: "ask", category: "tool", subject: "Run" })
		const abandoned = taskEvent(5, "ask.abandoned", { askId: "ask", reason: "cancelled" })
		if (abandoned.type !== "ask.abandoned") throw new Error("Expected ask.abandoned fixture")
		const interrupted = taskEvent(6, "task.lifecycle", { state: "interrupted" })
		const cancelled = resultEvent(7, { outcome: "cancelled", cancellationReason: "user" }, { requestId: "cancel" })
		const command = hostCommandSchema.parse({
			v: 1,
			id: "cancel",
			type: "task.cancel",
			rootTaskId: "root",
			reason: "user",
		})
		expect(
			validateStreamLifecycle([initEvent, created, started, required, abandoned, interrupted, cancelled], [startCommand, command]),
		).toEqual({ ok: true })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					required,
					{ ...abandoned, reason: "timed_out" },
					interrupted,
					cancelled,
				],
				[command],
			),
		).toMatchObject({ ok: false })
	})

	it("requires currentTaskId to belong to the authoritative tree", () => {
		expect(
			validateStreamLifecycle([
				initEvent,
				taskEvent(2, "task.created"),
				taskEvent(3, "task.lifecycle", { state: "completed" }),
				resultEvent(4, { currentTaskId: "ghost" }),
			]),
		).toMatchObject({ ok: false })
	})

	it("reconstructs resume streams from a matching command", () => {
		const command = hostCommandSchema.parse({
			v: 1,
			id: "resume",
			type: "task.resume",
			rootTaskId: "root",
			taskId: "root",
		})
		const predecessor = taskEvent(3, "task.lifecycle", { state: "interrupted" })
		const resumed = taskEvent(4, "task.resumed", { requestId: "resume", previousState: "interrupted" })
		const started = taskEvent(5, "task.started")
		const completed = taskEvent(6, "task.lifecycle", { state: "completed" })
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			predecessor,
			resumed,
			started,
			completed,
			resultEvent(7, {}, { requestId: "resume" }),
		]
		expect(validateStreamLifecycle(stream, [command])).toEqual({ ok: true })
		expect(validateStreamLifecycle(stream)).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle(
				[...stream.slice(0, 3), { ...resumed, seq: 4 }, { ...completed, seq: 5 }, resultEvent(6)],
				[command],
			),
		).toMatchObject({ ok: false })
		expect(zooStreamEventSchema.safeParse({ ...resumed, previousState: "completed" }).success).toBe(false)
	})

	it("resumes a correlated descendant from its reconstructed predecessor", () => {
		const command = hostCommandSchema.parse({
			v: 1,
			id: "resume-child",
			type: "task.resume",
			rootTaskId: "root",
			taskId: "child",
		})
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.created", { taskId: "child", parentTaskId: "root" }),
			taskEvent(4, "task.delegated", { taskId: "child", parentTaskId: "root", childTaskId: "child" }),
			taskEvent(5, "task.lifecycle", { taskId: "child", state: "waiting" }),
			taskEvent(6, "task.resumed", {
				taskId: "child",
				requestId: "resume-child",
				previousState: "waiting",
			}),
			taskEvent(7, "task.started", { taskId: "child" }),
			taskEvent(8, "task.lifecycle", { taskId: "child", state: "completed" }),
			taskEvent(9, "task.started"),
			taskEvent(10, "task.lifecycle", { state: "completed" }),
			resultEvent(11, {}, { requestId: "resume-child" }),
		]
		expect(validateStreamLifecycle(stream, [command])).toEqual({ ok: true })
		expect(
			validateStreamLifecycle(
				stream.map((event) =>
					event.type === "task.resumed" ? { ...event, previousState: "interrupted" as const } : event,
				),
				[command],
			),
		).toMatchObject({ ok: false })
	})

	it("keeps operation identities separate for delimiter-bearing IDs", () => {
		const stream = [
			initEvent,
			taskEvent(2, "task.created"),
			taskEvent(3, "task.started"),
			taskEvent(4, "task.created", { taskId: "root\u0000x", parentTaskId: "root" }),
			taskEvent(5, "task.delegated", {
				taskId: "root\u0000x",
				parentTaskId: "root",
				childTaskId: "root\u0000x",
			}),
			taskEvent(6, "task.started", { taskId: "root\u0000x" }),
			taskEvent(7, "tool.started", { toolCallId: "x\u0000y", name: "read" }),
			taskEvent(8, "tool.started", { taskId: "root\u0000x", toolCallId: "y", name: "read" }),
			taskEvent(9, "tool.completed", { toolCallId: "x\u0000y", name: "read" }),
			taskEvent(10, "tool.completed", { taskId: "root\u0000x", toolCallId: "y", name: "read" }),
			taskEvent(11, "task.lifecycle", { taskId: "root\u0000x", state: "completed" }),
			taskEvent(12, "task.lifecycle", { state: "completed" }),
			resultEvent(13),
		]
		expect(validateStreamLifecycle(stream, [startCommand])).toEqual({ ok: true })
	})

	it("keeps pending asks on waiting tasks", () => {
		const childCreated = taskEvent(3, "task.created", { taskId: "child", parentTaskId: "root" })
		const delegated = taskEvent(4, "task.delegated", {
			taskId: "child",
			parentTaskId: "root",
			childTaskId: "child",
		})
		const required = taskEvent(5, "ask.required", {
			taskId: "child",
			askId: "ask",
			category: "tool",
			subject: "Run",
		})
		const childCompleted = taskEvent(6, "task.lifecycle", { taskId: "child", state: "completed" })
		const rootWaiting = taskEvent(7, "task.lifecycle", { state: "waiting" })
		expect(
			validateStreamLifecycle([
				initEvent,
				taskEvent(2, "task.created"),
				childCreated,
				delegated,
				required,
				childCompleted,
				rootWaiting,
				resultEvent(8, { outcome: "needs_input" }),
			]),
		).toMatchObject({ ok: false })
	})

	it("enforces operation, ask, message, and parent execution state", () => {
		const created = taskEvent(2, "task.created")
		const started = taskEvent(3, "task.started")
		const required = taskEvent(4, "ask.required", { askId: "ask", category: "tool", subject: "Run" })
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					required,
					taskEvent(5, "tool.started", { toolCallId: "tool", name: "shell" }),
					taskEvent(6, "task.lifecycle", { state: "completed" }),
					resultEvent(7),
				],
				[startCommand],
			),
		).toMatchObject({ ok: false })

		const response = hostCommandSchema.parse({
			v: 1,
			id: "respond",
			type: "ask.respond",
			taskId: "root",
			askId: "ask",
			response: "approve",
		})
		const resolved = taskEvent(5, "ask.resolved", {
			requestId: "respond",
			askId: "ask",
			decision: "approve",
			source: "user",
		})
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					required,
					resolved,
					taskEvent(6, "ask.required", { askId: "ask", category: "tool", subject: "Again" }),
					taskEvent(7, "task.lifecycle", { state: "completed" }),
					resultEvent(8),
				],
				[startCommand, response],
			),
		).toMatchObject({ ok: false })

		const message = taskEvent(4, "message.upsert", {
			messageId: "message",
			role: "assistant",
			content: "done",
			complete: true,
		})
		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					started,
					message,
					taskEvent(5, "message.upsert", {
						messageId: "message",
						role: "user",
						content: "changed",
						complete: false,
					}),
					taskEvent(6, "task.lifecycle", { state: "completed" }),
					resultEvent(7),
				],
				[startCommand],
			),
		).toMatchObject({ ok: false })

		expect(
			validateStreamLifecycle(
				[
					initEvent,
					created,
					taskEvent(3, "task.created", { taskId: "child", parentTaskId: "root" }),
					taskEvent(4, "task.delegated", { taskId: "child", parentTaskId: "root", childTaskId: "child" }),
					taskEvent(5, "task.started", { taskId: "child" }),
					taskEvent(6, "task.lifecycle", { taskId: "child", state: "completed" }),
					taskEvent(7, "task.started"),
					taskEvent(8, "task.lifecycle", { state: "completed" }),
					resultEvent(9),
				],
				[startCommand],
			),
		).toMatchObject({ ok: false })
	})

	it("maps every terminal outcome deterministically", () => {
		expect(exitCodeFor({ outcome: "completed" })).toBe(EXIT_CODES.completed)
		expect(exitCodeFor({ outcome: "needs_input" })).toBe(EXIT_CODES.needsInput)
		expect(exitCodeFor({ outcome: "cancelled" })).toBe(EXIT_CODES.cancelled)
		expect(exitCodeFor({ outcome: "timed_out" })).toBe(EXIT_CODES.timedOut)
		expect(exitCodeFor({ outcome: "failed", errorCode: "invalid_mode" })).toBe(EXIT_CODES.usage)
		expect(exitCodeFor({ outcome: "failed", errorCode: "provider_failed" })).toBe(EXIT_CODES.providerFailure)
		expect(exitCodeFor({ outcome: "failed", errorCode: "host_crashed" })).toBe(EXIT_CODES.runtimeFailure)
		expect(exitCodeFor({ outcome: "cancelled", signal: "SIGINT" })).toBe(EXIT_CODES.sigint)
		expect(exitCodeFor({ outcome: "cancelled", signal: "SIGTERM" })).toBe(EXIT_CODES.sigterm)
		expect(exitContextSchema.safeParse({ outcome: "cancelled", errorCode: "invalid_mode" }).success).toBe(false)
		expect(exitContextSchema.safeParse({ outcome: "completed", signal: "SIGINT" }).success).toBe(false)
		expect(exitContextSchema.safeParse({ outcome: "failed", errorCode: "task_timed_out" }).success).toBe(false)
	})
})

describe("redaction contracts", () => {
	it("redacts secret-shaped keys and text before buffering", () => {
		const input = {
			provider: "openrouter",
			apiKey: "sk-secret-value",
			nested: { authorization: "Bearer abcdefgh", command: "API_TOKEN=abcdefgh run" },
		}
		expect(redactValue(input)).toEqual({
			provider: "openrouter",
			apiKey: "[REDACTED]",
			nested: { authorization: "[REDACTED]", command: "[REDACTED] run" },
		})
		expect(redactText("Authorization: Bearer abcdefgh")).not.toContain("abcdefgh")
		expect(redactText("Authorization: abc123\nCookie: session=abc")).not.toMatch(/abc123|session=abc/)
		expect(redactText('{"password":"hunter2"}')).toBe('{"password":"[REDACTED]"}')
		expect(redactText('{"password": hunter2}')).toBe('{"password": [REDACTED]}')
		expect(redactText("{'api_key': abc123}")).toBe("{'api_key': [REDACTED]}")
		expect(redactText('{"client_secret":"secret-value","access_token":"token-value"}')).toBe(
			'{"client_secret":"[REDACTED]","access_token":"[REDACTED]"}',
		)
		expect(redactText("--api-key abc123 run")).toBe("[REDACTED] run")
		expect(redactText("API Key: abc123")).toBe("[REDACTED]")
		expect(redactText("Private Key: abc123")).toBe("[REDACTED]")
		expect(redactText('{"auth.token":"secret"}')).toBe('{"auth.token":"[REDACTED]"}')
		expect(redactText("https://alice:hunter2@example.com/path")).toBe("https://[REDACTED]@example.com/path")
		expect(redactText("https://alice:p@ss@example.com/path")).toBe("https://[REDACTED]@example.com/path")
		expect(redactText("--password abc,def run")).toBe("[REDACTED] run")
		expect(redactText('API_TOKEN="abc def" run')).toBe("[REDACTED] run")
		expect(redactText('{"access token":"hunter2","client secret":"secret-value"}')).toBe(
			'{"access token":"[REDACTED]","client secret":"[REDACTED]"}',
		)
		expect(redactValue({ max_tokens: 4096, tokenCount: 12, tokenizer: "bpe", accessToken: "secret" })).toEqual({
			max_tokens: 4096,
			tokenCount: 12,
			tokenizer: "bpe",
			accessToken: "[REDACTED]",
		})
	})

	it("redacts public event and result payloads during parsing", () => {
		const message = taskEvent(1, "message.upsert", {
			messageId: "message",
			role: "assistant",
			content: "Authorization: Bearer abcdefgh",
			complete: true,
		})
		expect(message.type === "message.upsert" && message.content).toBe("[REDACTED]")
		const result = zooRunResultSchema.parse({
			schemaVersion: 1,
			protocol: "zoo-run-result",
			success: true,
			outcome: "completed",
			rootTaskId: "root",
			workspace: "/workspace",
			resumable: false,
			content: "password=hunter2",
			elapsedMs: 1,
		})
		expect(result.content).toBe("[REDACTED]")
		expect(zooStreamEventSchema.safeParse({ ...message, taskId: Symbol("secret") }).success).toBe(false)
		const structuralIdentity = taskEvent(2, "message.upsert", {
			taskId: "password=hunter2",
			messageId: "token=identity",
			role: "assistant",
			content: "safe",
			complete: true,
		})
		if (structuralIdentity.type !== "message.upsert") throw new Error("Expected message.upsert fixture")
		expect(structuralIdentity.taskId).toBe("password=hunter2")
		expect(structuralIdentity.messageId).toBe("token=identity")
		const terminalOutput = taskEvent(3, "terminal.output", {
			toolCallId: "terminal",
			stream: "stdout",
			delta: "abcdefgh",
		})
		expect(terminalOutput.type === "terminal.output" && terminalOutput.delta).toBe("[REDACTED]")
		const terminalPrefix = taskEvent(4, "terminal.output", {
			toolCallId: "terminal",
			stream: "stdout",
			delta: "API_TOKEN=",
		})
		expect(terminalPrefix.type === "terminal.output" && terminalPrefix.delta).toBe("[REDACTED]")
		const failed = zooRunResultSchema.parse({
			schemaVersion: 1,
			protocol: "zoo-run-result",
			success: false,
			outcome: "failed",
			rootTaskId: "root",
			workspace: "/workspace",
			resumable: false,
			error: { code: "provider_failed", message: "safe", phase: "password=hunter2" },
			elapsedMs: 1,
		})
		expect(failed.error?.phase).toBe("[REDACTED]")
	})

	it("buffers terminal output across delta boundaries without destroying harmless output", () => {
		const terminal = {
			v: 1,
			timestamp,
			hostId: "host",
			rootTaskId: "root",
			taskId: "root",
			type: "terminal.output",
			toolCallId: "terminal",
			stream: "stdout",
		} as const
		const output = zooStreamSchema.parse([
			{ ...terminal, seq: 1, delta: "Build succeeded\n" },
			{ ...terminal, seq: 2, delta: "API_TOKEN=" },
			{ ...terminal, seq: 3, delta: "abcdefgh" },
		])
		expect(output.map((event) => (event.type === "terminal.output" ? event.delta : "")).join("")).toBe(
			"Build succeeded\n[REDACTED]",
		)
	})

	it("handles cycles without throwing", () => {
		const input: Record<string, unknown> = {}
		input.self = input
		expect(redactValue(input)).toEqual({ self: "[CIRCULAR]" })
	})

	it("preserves repeated non-cyclic references", () => {
		const shared = { value: "safe" }
		expect(redactValue({ left: shared, right: shared })).toEqual({
			left: { value: "safe" },
			right: { value: "safe" },
		})
	})
})

describe("deterministic parity oracle", () => {
	it.each(parityScenarios)("accepts the $id golden semantic trace", (scenario) => {
		expect(compareSemanticTraces(scenario.expected, runDeterministicFakeProvider(scenario))).toEqual({ ok: true })
	})

	it("includes the prompt in fake-provider semantics", () => {
		const scenario = { ...parityScenarios[0]!, prompt: "Changed prompt" }
		expect(
			compareSemanticTraces(parityScenarios[0]!.expected, runDeterministicFakeProvider(scenario)),
		).toMatchObject({
			ok: false,
		})
	})

	it("includes tool identity and arguments in fake-provider semantics", () => {
		const trace = runDeterministicFakeProvider(parityScenarios[1]!)
		expect(trace.find((entry) => entry.type === "tool.started")).toMatchObject({
			toolName: "read_file",
			toolArguments: { path: "README.md" },
		})
	})

	it("detects child completion incorrectly settling the root", () => {
		const trace = [
			{ type: "task.created", taskId: "root" },
			{ type: "task.result", taskId: "child", outcome: "completed" as const },
		]
		expect(assertAuthoritativeRootResult(trace, "root")).toBe(false)
		expect(assertAuthoritativeRootResult(parityScenarios[2]!.expected, "root")).toBe(true)
		expect(assertAuthoritativeRootResult([{ type: "task.result", taskId: "root", rootTaskId: "root" }], "root")).toBe(
			false,
		)
		expect(
			assertAuthoritativeRootResult(
				[{ type: "task.result", taskId: "root", rootTaskId: "root", outcome: "failed" }],
				"root",
			),
		).toBe(false)
		expect(
			assertAuthoritativeRootResult(
				[
					{
						type: "task.result",
						taskId: "root",
						rootTaskId: "root",
						outcome: "cancelled",
						cancellationReason: "invalid" as "user",
					},
				],
				"root",
			),
		).toBe(false)
		expect(
			assertAuthoritativeRootResult(
				[{ type: "task.result", taskId: "root", rootTaskId: "root", outcome: "timed_out" }],
				"root",
			),
		).toBe(true)
	})

	it("reports semantic drift without timestamps", () => {
		const expected = parityScenarios[0]!.expected
		const result = compareSemanticTraces(expected, expected.slice(0, -1))
		expect(result).toMatchObject({ ok: false })
	})

	it("models timeout separately and rejects trailing terminal turns", () => {
		const timeout = runDeterministicFakeProvider({
			id: "timeout",
			prompt: "Timeout",
			providerTurns: ["timeout:task_timed_out"],
			expected: [],
		})
		expect(timeout.at(-1)).toMatchObject({ outcome: "timed_out", errorCode: "task_timed_out" })
		expect(
			assertAuthoritativeRootResult(
				[{ type: "task.result", taskId: "root", rootTaskId: "root", outcome: "timed_out" }],
				"root",
			),
		).toBe(true)
		const colonArgument = runDeterministicFakeProvider({
			id: "colon-argument",
			prompt: "Read URL",
			providerTurns: ["tool:read_file:call:https://example.com/a:b"],
			expected: [],
		})
		expect(colonArgument.find((entry) => entry.type === "tool.started")?.toolArguments).toEqual({
			path: "https://example.com/a:b",
		})
		expect(() =>
			runDeterministicFakeProvider({
				id: "invalid-failure",
				prompt: "Fail",
				providerTurns: ["fail:task_timed_out"],
				expected: [],
			}),
		).toThrow()
		expect(() =>
			runDeterministicFakeProvider({
				id: "trailing",
				prompt: "Cancel",
				providerTurns: ["cancel:cancel-1:user", "trailing"],
				expected: [],
			}),
		).toThrow()
	})

	it("ignores object property insertion order without ignoring event order", () => {
		const expected = [{ type: "message.upsert", taskId: "root", content: "hello" }]
		const reordered = [{ content: "hello", taskId: "root", type: "message.upsert" }]
		expect(compareSemanticTraces(expected, reordered)).toEqual({ ok: true })
		expect(compareSemanticTraces(expected, [...reordered, ...reordered])).toMatchObject({ ok: false })
	})
})
