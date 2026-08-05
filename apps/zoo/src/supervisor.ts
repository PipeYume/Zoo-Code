import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
	createHostEventStreamParser,
	hostCommandSchema,
	hostHelloSchema,
	negotiateProtocol,
	parentHelloSchema,
	validateNegotiatedStreamSession,
	ZOO_HOST_PROTOCOL_VERSION,
	type HostCommand,
	type HostEvent,
	type HostHello,
	type ParentHello,
	type ZooCapability,
	type ZooStreamEvent,
	redactText,
} from "@roo-code/zoo-protocol"

type PendingCommand = {
	acknowledged: boolean
	resolve: (event: Extract<HostEvent, { type: "command.done" }>) => void
	reject: (error: Error) => void
}
type OutboundHostCommand = HostCommand extends infer Command
	? Command extends HostCommand
		? Omit<Command, "v" | "id">
		: never
	: never
type HostClientOptions = {
	workspace: string
	storageRoot: string
	extensionRoot: string
	onEvent: (event: ZooStreamEvent) => void
	debug?: boolean
}

const requiredCapabilities: ZooCapability[] = [
	"task:start",
	"task:resume",
	"task:cancel",
	"history:list",
	"host:shutdown",
]

export class HostClient {
	private child: ChildProcess | undefined
	private parser: ReturnType<typeof createHostEventStreamParser> | undefined
	private readonly pending = new Map<string, PendingCommand>()
	private failure: Error | undefined
	private rejectFailure: ((error: Error) => void) | undefined
	public readonly failed = new Promise<never>((_, reject) => (this.rejectFailure = reject))
	private hello: HostHello | undefined
	private selection: ParentHello | undefined
	private resolveInitialized: (() => void) | undefined
	private initialized = new Promise<void>((resolve) => (this.resolveInitialized = resolve))
	private lastHeartbeat = Date.now()
	private watchdog: NodeJS.Timeout | undefined

	constructor(private readonly options: HostClientOptions) {}

	public async start(): Promise<void> {
		const hostPath =
			process.env.ZOO_HOST_PATH ??
			fileURLToPath(new URL("../../../packages/zoo-host/dist/child.js", import.meta.url))
		const child = fork(hostPath, [], {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: {
				...process.env,
				ZOO_HOST_CONFIG: JSON.stringify({
					extensionRoot: this.options.extensionRoot,
					workspaceRoot: this.options.workspace,
					storageRoot: this.options.storageRoot,
					appRoot: this.options.extensionRoot,
					buildVersion: "0.1.0",
				}),
			},
		})
		this.child = child
		child.stdout?.resume()
		child.stderr?.on("data", (chunk: Buffer) => {
			if (this.options.debug) process.stderr.write(redactText(chunk.subarray(0, 16 * 1024).toString("utf8")))
		})
		child.once("exit", (code, signal) => this.fail(new Error(`Zoo host exited (${signal ?? code ?? "unknown"})`)))
		child.once("error", (error) => this.fail(error))

		const hello = await Promise.race([this.waitForHello(child, 15_000), this.failed])
		this.hello = hello
		const negotiation = negotiateProtocol(hello, [ZOO_HOST_PROTOCOL_VERSION], requiredCapabilities)
		if (!negotiation.ok) throw new Error(negotiation.message)
		this.parser = createHostEventStreamParser({ hostId: hello.hostId })
		child.on("message", (message) => this.receive(message))
		this.selection = parentHelloSchema.parse({
			type: "hello.select",
			version: negotiation.version,
			clientVersion: "0.1.0",
			requiredCapabilities,
		})
		child.send(this.selection)
		let initializationTimer: NodeJS.Timeout | undefined
		try {
			await Promise.race([
				this.initialized,
				this.failed,
				new Promise<never>((_, reject) => {
					initializationTimer = setTimeout(
						() => reject(new Error("Zoo host initialization timed out")),
						30_000,
					)
				}),
			])
		} finally {
			if (initializationTimer) clearTimeout(initializationTimer)
		}
		this.lastHeartbeat = Date.now()
		this.watchdog = setInterval(() => {
			if (Date.now() - this.lastHeartbeat > 5_000) this.fail(new Error("Zoo host heartbeat timed out"))
		}, 1_000)
		this.watchdog.unref()
	}

	public async command(input: OutboundHostCommand, timeoutMs = 15_000) {
		if (!this.child?.connected) throw this.failure ?? new Error("Zoo host is unavailable")
		const id = randomUUID()
		const command = hostCommandSchema.parse({ v: ZOO_HOST_PROTOCOL_VERSION, id, ...input })
		return new Promise<Extract<HostEvent, { type: "command.done" }>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`Host command timed out: ${command.type}`))
			}, timeoutMs)
			this.pending.set(id, {
				acknowledged: false,
				resolve: (event) => {
					clearTimeout(timer)
					resolve(event)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
			})
			this.child!.send(command, (error) => {
				if (error) this.pending.get(id)?.reject(error)
			})
		})
	}

	public async stop(): Promise<void> {
		const child = this.child
		if (!child) return
		if (this.watchdog) clearInterval(this.watchdog)
		this.watchdog = undefined
		if (child.connected && !this.failure)
			await this.command({ type: "host.shutdown" }, 5_000).catch(() => undefined)
		child.disconnect()
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) return resolve()
			const timer = setTimeout(() => {
				child.kill("SIGKILL")
				resolve()
			}, 2_000)
			child.once("exit", () => {
				clearTimeout(timer)
				resolve()
			})
		})
	}

	private waitForHello(child: ChildProcess, timeoutMs: number) {
		return new Promise<ReturnType<typeof hostHelloSchema.parse>>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Zoo host startup timed out")), timeoutMs)
			child.once("message", (message) => {
				clearTimeout(timer)
				try {
					resolve(hostHelloSchema.parse(message))
				} catch (error) {
					reject(error)
				}
			})
		})
	}

	private receive(input: unknown): void {
		try {
			for (const event of this.parser?.push(input) ?? []) {
				if (event.type === "host.heartbeat") this.lastHeartbeat = Date.now()
				if (event.type === "event") {
					if (event.event.type === "system.init") {
						if (!this.hello || !this.selection)
							throw new Error("Host initialized before protocol negotiation")
						const validation = validateNegotiatedStreamSession(this.hello, this.selection, [event.event])
						if (!validation.ok) throw new Error(validation.message)
						this.resolveInitialized?.()
					}
					this.options.onEvent(event.event)
				}
				if (event.type === "command.ack") {
					const pending = this.pending.get(event.commandId)
					if (!pending || pending.acknowledged) throw new Error(`Invalid ACK for command ${event.commandId}`)
					pending.acknowledged = true
				}
				if (event.type === "command.done") {
					const pending = this.pending.get(event.commandId)
					if (!pending?.acknowledged) throw new Error(`DONE preceded ACK for command ${event.commandId}`)
					pending.resolve(event)
					this.pending.delete(event.commandId)
				}
				if (event.type === "command.error") {
					const pending = this.pending.get(event.commandId)
					if (!pending?.acknowledged) throw new Error(`ERROR preceded ACK for command ${event.commandId}`)
					pending.reject(new Error(`${event.error.code}: ${event.error.message}`))
					this.pending.delete(event.commandId)
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)))
		}
	}

	private fail(error: Error): void {
		if (this.failure) return
		this.failure = error
		this.rejectFailure?.(error)
		for (const pending of this.pending.values()) pending.reject(error)
		this.pending.clear()
	}
}

export const defaultStorageRoot = () => path.join(os.homedir(), ".zoo")
