import type { ClineMessage } from "@roo-code/types"
import { Writable } from "stream"

import type { TaskCompletedEvent } from "../events.js"
import { JsonEventEmitter } from "../json-event-emitter.js"
import { AgentLoopState, type AgentStateInfo } from "../agent-state.js"
import type { ExtensionClient } from "../extension-client.js"

function createMockStdout(): {
	stdout: NodeJS.WriteStream
	lines: () => Record<string, unknown>[]
	content: () => string
} {
	const chunks: string[] = []

	const writable = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk.toString())
			callback()
		},
	}) as unknown as NodeJS.WriteStream

	const lines = () =>
		chunks
			.join("")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>)

	return { stdout: writable, lines, content: () => chunks.join("") }
}

function emitMessage(emitter: JsonEventEmitter, message: ClineMessage): void {
	;(emitter as unknown as { handleMessage: (msg: ClineMessage, isUpdate: boolean) => void }).handleMessage(
		message,
		false,
	)
}

function emitTaskCompleted(emitter: JsonEventEmitter, event: TaskCompletedEvent): void {
	;(emitter as unknown as { handleTaskCompleted: (taskCompleted: TaskCompletedEvent) => void }).handleTaskCompleted(
		event,
	)
}

function createAskCompletionMessage(ts: number, text = ""): ClineMessage {
	return {
		ts,
		type: "ask",
		ask: "completion_result",
		partial: false,
		text,
	} as ClineMessage
}

function createCompletedStateInfo(message: ClineMessage): AgentStateInfo {
	return {
		state: AgentLoopState.IDLE,
		isWaitingForInput: true,
		isRunning: false,
		isStreaming: false,
		currentAsk: "completion_result",
		requiredAction: "start_task",
		lastMessageTs: message.ts,
		lastMessage: message,
		description: "Task completed successfully. You can provide feedback or start a new task.",
	}
}

describe("JsonEventEmitter result emission", () => {
	it("emits exactly one authoritative autonomous terminal outcome", () => {
		const { stdout, lines } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "stream-json", stdout, authoritativeCompletion: true })

		emitter.emitTerminal({ state: "needs_input", exitCode: 2, rootTaskId: "root-1", content: "question" })
		emitter.emitTerminal({ state: "crashed", exitCode: 70, content: "duplicate" })

		expect(lines()).toEqual([
			expect.objectContaining({
				type: "result",
				subtype: "terminal",
				state: "needs_input",
				exitCode: 2,
				rootTaskId: "root-1",
				done: true,
				success: false,
			}),
		])
	})

	it("serializes a crashed terminal outcome on the first emission", () => {
		const { stdout, lines } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "stream-json", stdout, authoritativeCompletion: true })

		emitter.emitTerminal({ state: "crashed", exitCode: 70, content: "boom" })

		expect(lines()).toEqual([
			expect.objectContaining({
				type: "result",
				subtype: "terminal",
				state: "crashed",
				exitCode: 70,
				done: true,
				success: false,
			}),
		])
	})

	it("does not subscribe to inferred task completion in authoritative mode", () => {
		const { stdout } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "stream-json", stdout, authoritativeCompletion: true })
		const on = vi.fn((_event: string, _listener: (...args: never[]) => void) => vi.fn())

		emitter.attachToClient({ on } as unknown as ExtensionClient)

		expect(on.mock.calls.map(([event]) => event)).toEqual(["message", "messageUpdated", "stateChange", "error"])
	})

	it("subscribes to task completion in the standard event mode", () => {
		const { stdout } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "stream-json", stdout })
		const on = vi.fn((_event: string, _listener: (...args: never[]) => void) => vi.fn())

		emitter.attachToClient({ on } as unknown as ExtensionClient)

		expect(on.mock.calls.map(([event]) => event)).toContain("taskCompleted")
	})

	it("uses the terminal discriminator for aggregate JSON output", () => {
		const { stdout, content } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "json", stdout, authoritativeCompletion: true })

		emitter.emitControl({ subtype: "ack", requestId: "request-1" })
		emitter.emitTerminal({ state: "completed", exitCode: 0, rootTaskId: "root-1", content: "done" })

		expect(JSON.parse(content())).toEqual(
			expect.objectContaining({
				type: "result",
				subtype: "terminal",
				done: true,
				state: "completed",
				exitCode: 0,
			}),
		)
		expect(JSON.parse(content()).events).toEqual([expect.objectContaining({ type: "control", subtype: "ack" })])
	})

	it("prefers current completion message content over stale cached completion text", () => {
		const { stdout, lines } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "stream-json", stdout })

		emitMessage(emitter, {
			ts: 100,
			type: "say",
			say: "completion_result",
			partial: false,
			text: "FIRST",
		} as ClineMessage)

		const firstCompletionMessage = createAskCompletionMessage(101, "")
		emitTaskCompleted(emitter, {
			success: true,
			stateInfo: createCompletedStateInfo(firstCompletionMessage),
			message: firstCompletionMessage,
		})

		const secondCompletionMessage = createAskCompletionMessage(102, "SECOND")
		emitTaskCompleted(emitter, {
			success: true,
			stateInfo: createCompletedStateInfo(secondCompletionMessage),
			message: secondCompletionMessage,
		})

		const output = lines().filter((line) => line.type === "result")
		expect(output).toHaveLength(2)
		expect(output[0]?.content).toBe("FIRST")
		expect(output[1]?.content).toBe("SECOND")
	})

	it("clears cached completion text after each result emission", () => {
		const { stdout, lines } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "stream-json", stdout })

		emitMessage(emitter, {
			ts: 200,
			type: "say",
			say: "completion_result",
			partial: false,
			text: "FIRST",
		} as ClineMessage)

		const firstCompletionMessage = createAskCompletionMessage(201, "")
		emitTaskCompleted(emitter, {
			success: true,
			stateInfo: createCompletedStateInfo(firstCompletionMessage),
			message: firstCompletionMessage,
		})

		const secondCompletionMessage = createAskCompletionMessage(202, "")
		emitTaskCompleted(emitter, {
			success: true,
			stateInfo: createCompletedStateInfo(secondCompletionMessage),
			message: secondCompletionMessage,
		})

		const output = lines().filter((line) => line.type === "result")
		expect(output).toHaveLength(2)
		expect(output[0]?.content).toBe("FIRST")
		expect(output[1]).not.toHaveProperty("content")
	})
})
