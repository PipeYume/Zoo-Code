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
} from "../index.js"

const timestamp = "2026-08-05T12:00:00.000Z"

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
		...fields,
	})
}

function resultEvent(seq: number, result: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
	const outcome = result.outcome ?? "completed"
	const parsed = taskEvent(seq, "task.result", {
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
	})

	it("enforces input and approval payload invariants", () => {
		expect(hostCommandSchema.safeParse({ v: 1, id: "1", type: "task.input", taskId: "task" }).success).toBe(false)
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
		expect(negotiateProtocol(multiVersionHello, [2, 1], ["task:resume"])).toEqual({ ok: true, version: 2 })
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
		expect(validateParentHello(host, selected)).toEqual({ ok: true, version: 2 })
		expect(validateParentHello(host, { ...selected, version: 3 })).toMatchObject({ ok: false })
		expect(validateParentHello(host, { ...selected, version: 1 })).toMatchObject({ ok: false })
	})

	it("requires contiguous host sequence numbers", () => {
		expect(validateMonotonicSequence(8, 9)).toEqual({ ok: true })
		expect(validateMonotonicSequence(8, 10)).toEqual({ ok: false, expected: 9 })
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
		expect(zooStreamEventSchema.safeParse({ ...event, rawSecret: "no" }).success).toBe(false)
		expect(zooStreamEventSchema.safeParse({ ...event, taskId: undefined }).success).toBe(false)
	})

	it("requires init, contiguous sequence, and a settled authoritative root", () => {
		const created = taskEvent(2, "task.created")
		const completed = taskEvent(3, "task.lifecycle", { state: "completed" })
		const result = resultEvent(4)
		expect(validateStreamLifecycle([initEvent, created, completed, result])).toEqual({ ok: true })
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
		const childCreated = taskEvent(3, "task.created", { taskId: "child", parentTaskId: "root" })
		const delegated = taskEvent(4, "task.delegated", {
			taskId: "child",
			parentTaskId: "root",
			childTaskId: "child",
		})
		const childCompleted = taskEvent(5, "task.lifecycle", { taskId: "child", state: "completed" })
		const rootCompleted = taskEvent(6, "task.lifecycle", { state: "completed" })
		expect(
			validateStreamLifecycle([
				initEvent,
				rootCreated,
				childCreated,
				delegated,
				childCompleted,
				rootCompleted,
				resultEvent(7),
			]),
		).toEqual({ ok: true })
		expect(
			validateStreamLifecycle([initEvent, rootCreated, childCreated, delegated, rootCompleted, resultEvent(6)]),
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

		const required = taskEvent(3, "ask.required", {
			askId: "ask",
			category: "tool",
			subject: "Run command",
		})
		const resolved = taskEvent(4, "ask.resolved", {
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
		const completed = taskEvent(5, "task.lifecycle", { state: "completed" })
		expect(
			validateStreamLifecycle(
				[initEvent, rootCreated, required, resolved, completed, resultEvent(6)],
				[response],
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
		const toolStarted = taskEvent(3, "tool.started", { toolCallId: "tool", name: "read" })
		const toolCompleted = taskEvent(4, "tool.completed", { toolCallId: "tool", name: "read" })
		const terminalStarted = taskEvent(5, "terminal.status", { toolCallId: "terminal", state: "running" })
		const terminalExited = taskEvent(6, "terminal.status", { toolCallId: "terminal", state: "exited", exitCode: 0 })
		const mcpStarted = taskEvent(7, "mcp.started", { operationId: "mcp", server: "test", operation: "read" })
		const mcpCompleted = taskEvent(8, "mcp.completed", { operationId: "mcp", server: "test", operation: "read" })
		const interrupted = taskEvent(9, "task.lifecycle", { state: "interrupted" })
		const cancelled = resultEvent(10, { outcome: "cancelled", cancellationReason: "user" }, { requestId: "cancel" })
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
			toolStarted,
			toolCompleted,
			terminalStarted,
			terminalExited,
			mcpStarted,
			mcpCompleted,
			interrupted,
			cancelled,
		]
		expect(validateStreamLifecycle(stream, [command])).toEqual({ ok: true })
		expect(validateStreamLifecycle(stream)).toMatchObject({ ok: false })
		expect(validateStreamLifecycle(stream, [{ ...command, reason: "signal" }])).toMatchObject({ ok: false })
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
		expect(redactText('API_TOKEN="abc def" run')).toBe("[REDACTED] run")
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

	it("detects child completion incorrectly settling the root", () => {
		const trace = [
			{ type: "task.created", taskId: "root" },
			{ type: "task.result", taskId: "child", outcome: "completed" as const },
		]
		expect(assertAuthoritativeRootResult(trace, "root")).toBe(false)
		expect(assertAuthoritativeRootResult(parityScenarios[2]!.expected, "root")).toBe(true)
	})

	it("reports semantic drift without timestamps", () => {
		const expected = parityScenarios[0]!.expected
		const result = compareSemanticTraces(expected, expected.slice(0, -1))
		expect(result).toMatchObject({ ok: false })
	})

	it("ignores object property insertion order without ignoring event order", () => {
		const expected = [{ type: "message.upsert", taskId: "root", content: "hello" }]
		const reordered = [{ content: "hello", taskId: "root", type: "message.upsert" }]
		expect(compareSemanticTraces(expected, reordered)).toEqual({ ok: true })
		expect(compareSemanticTraces(expected, [...reordered, ...reordered])).toMatchObject({ ok: false })
	})
})
