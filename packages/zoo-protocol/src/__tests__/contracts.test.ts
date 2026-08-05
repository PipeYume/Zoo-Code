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
	parityScenarios,
	redactText,
	redactValue,
	runDeterministicFakeProvider,
	validateCommandLifecycle,
	validateMonotonicSequence,
	validateStreamLifecycle,
	zooRunResultSchema,
	zooStreamEventSchema,
} from "../index.js"

const timestamp = "2026-08-05T12:00:00.000Z"

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
		expect(hostCommandSchema.safeParse({ ...command, overrides: { reasoningEffort: "disabled" } }).success).toBe(true)
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
		expect(validateCommandLifecycle([command], [events[0]!, { ...events[1]!, seq: 3 }])).toMatchObject({ ok: false })
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
		expect(validateCommandLifecycle([command], [acknowledgement, { ...completion, hostId: "host-b" }])).toMatchObject({
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
		expect(validateCommandLifecycle([command], [acknowledgement, mismatchedCompletion])).toMatchObject({ ok: false })
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

	it("requires init, contiguous sequence, and exactly one terminal root result", () => {
		const init = zooStreamEventSchema.parse({
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
		const result = zooStreamEventSchema.parse({
			v: 1,
			seq: 2,
			timestamp,
			hostId: "host",
			type: "task.result",
			rootTaskId: "root",
			taskId: "root",
			result: {
				schemaVersion: 1,
				protocol: "zoo-run-result",
				success: true,
				outcome: "completed",
				rootTaskId: "root",
				workspace: "/workspace",
				resumable: false,
				elapsedMs: 10,
			},
		})
		const childResult = zooStreamEventSchema.parse({ ...result, taskId: "child" })
		expect(validateStreamLifecycle([init, result])).toEqual({ ok: true })
		expect(validateStreamLifecycle([init, { ...result, hostId: "other-host" }])).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([{ ...init, seq: 2 }, result])).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([init])).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([init, childResult])).toMatchObject({ ok: false })
		expect(
			validateStreamLifecycle([
				init,
				zooStreamEventSchema.parse({
					v: 1,
					seq: 2,
					timestamp,
					hostId: "host",
					type: "ask.required",
					rootTaskId: "root",
					taskId: "root",
					askId: "ask-1",
					category: "tool",
					subject: "Run command",
				}),
				{ ...result, seq: 3 },
			]),
		).toMatchObject({ ok: false })
		const completedLifecycle = zooStreamEventSchema.parse({
			v: 1,
			seq: 2,
			timestamp,
			hostId: "host",
			type: "task.lifecycle",
			rootTaskId: "root",
			taskId: "root",
			state: "failed",
		})
		expect(validateStreamLifecycle([init, completedLifecycle, { ...result, seq: 3 }])).toMatchObject({ ok: false })
		expect(validateStreamLifecycle([init, { ...init, seq: 2 }, { ...result, seq: 3 }])).toMatchObject({ ok: false })
	})

	it("validates task-tree edges and approval command causation", () => {
		const init = zooStreamEventSchema.parse({
			v: 1,
			seq: 1,
			timestamp,
			hostId: "host",
			type: "system.init",
			protocol: "zoo-stream",
			capabilities: ["ask:respond"],
			clientVersion: "1.0.0",
			hostVersion: "1.0.0",
		})
		const result = zooStreamEventSchema.parse({
			v: 1,
			seq: 4,
			timestamp,
			hostId: "host",
			type: "task.result",
			rootTaskId: "root",
			taskId: "root",
			result: {
				schemaVersion: 1,
				protocol: "zoo-run-result",
				success: true,
				outcome: "completed",
				rootTaskId: "root",
				workspace: "/workspace",
				resumable: false,
				elapsedMs: 10,
			},
		})
		const created = zooStreamEventSchema.parse({
			v: 1,
			seq: 2,
			timestamp,
			hostId: "host",
			type: "task.created",
			rootTaskId: "root",
			taskId: "child",
			parentTaskId: "root",
		})
		const delegated = zooStreamEventSchema.parse({
			v: 1,
			seq: 3,
			timestamp,
			hostId: "host",
			type: "task.delegated",
			rootTaskId: "root",
			taskId: "child",
			parentTaskId: "root",
			childTaskId: "child",
		})
		expect(validateStreamLifecycle([init, created, delegated, result])).toEqual({ ok: true })
		const mismatchedDelegation = zooStreamEventSchema.parse({ ...delegated, taskId: "root" })
		expect(validateStreamLifecycle([init, created, mismatchedDelegation, result])).toMatchObject({ ok: false })

		const required = zooStreamEventSchema.parse({
			v: 1,
			seq: 2,
			timestamp,
			hostId: "host",
			type: "ask.required",
			rootTaskId: "root",
			taskId: "root",
			askId: "ask",
			category: "tool",
			subject: "Run command",
		})
		const resolved = zooStreamEventSchema.parse({
			v: 1,
			seq: 3,
			timestamp,
			hostId: "host",
			requestId: "respond",
			type: "ask.resolved",
			rootTaskId: "root",
			taskId: "root",
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
		expect(validateStreamLifecycle([init, required, resolved, result], [response])).toEqual({ ok: true })
		const mismatchedResolution = zooStreamEventSchema.parse({ ...resolved, decision: "reject" })
		expect(validateStreamLifecycle([init, required, mismatchedResolution, result], [response])).toMatchObject({ ok: false })
		const deniedApproval = zooStreamEventSchema.parse({ ...resolved, source: "deny" })
		expect(
			validateStreamLifecycle([init, required, deniedApproval, result]),
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
		expect(redactText('{"client_secret":"secret-value","access_token":"token-value"}')).toBe(
			'{"client_secret":"[REDACTED]","access_token":"[REDACTED]"}',
		)
		expect(redactText("--api-key abc123 run")).toBe("[REDACTED] run")
		expect(redactText('API_TOKEN="abc def" run')).toBe("[REDACTED] run")
	})

	it("handles cycles without throwing", () => {
		const input: Record<string, unknown> = {}
		input.self = input
		expect(redactValue(input)).toEqual({ self: "[CIRCULAR]" })
	})

	it("preserves repeated non-cyclic references", () => {
		const shared = { value: "safe" }
		expect(redactValue({ left: shared, right: shared })).toEqual({ left: { value: "safe" }, right: { value: "safe" } })
	})
})

describe("deterministic parity oracle", () => {
	it.each(parityScenarios)("accepts the $id golden semantic trace", (scenario) => {
		expect(compareSemanticTraces(scenario.expected, runDeterministicFakeProvider(scenario))).toEqual({ ok: true })
	})

	it("includes the prompt in fake-provider semantics", () => {
		const scenario = { ...parityScenarios[0]!, prompt: "Changed prompt" }
		expect(compareSemanticTraces(parityScenarios[0]!.expected, runDeterministicFakeProvider(scenario))).toMatchObject({
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
