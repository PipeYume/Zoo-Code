import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
	exitCodeFor,
	ZOO_PUBLIC_SCHEMA_VERSION,
	zooRunResultSchema,
	type HostCommand,
	type ZooErrorCode,
	type ZooRunResult,
	type ZooStreamEvent,
} from "@roo-code/zoo-protocol"

import { runOverrides, type OutputFormat, type SharedOptions } from "./options.js"
import { initialProjection, reduceSession } from "./projection.js"
import { createRenderer } from "./render.js"
import { defaultStorageRoot, HostClient } from "./supervisor.js"

type AutomationOptions = Omit<SharedOptions, "timeout"> & {
	format: OutputFormat
	quiet: boolean
	workspace: string
	timeout?: number
}

export async function runAutomation(
	request: { type: "run"; prompt: string } | { type: "resume"; taskId?: string },
	options: AutomationOptions,
): Promise<number> {
	if (options.format === "stream-json" && options.quiet) throw new Error("--quiet cannot be used with stream-json")
	if (options.approval === "interactive") throw new Error("--approval interactive cannot be used in automation")
	const overrides = runOverrides({ ...options, approval: options.approval ?? "safe" })
	const startedAt = Date.now()
	const storageRoot = options.ephemeral
		? fs.mkdtempSync(path.join(os.tmpdir(), "zoo-"))
		: path.join(defaultStorageRoot(), "state")
	fs.mkdirSync(storageRoot, { recursive: true })
	const renderer = createRenderer(options.format, options.quiet)
	let projection = initialProjection()
	let settled = false
	let settleResult: ((result: ZooRunResult) => void) | undefined
	const resultPromise = new Promise<ZooRunResult>((resolve) => {
		settleResult = (result) => {
			if (settled) return
			settled = true
			resolve(result)
		}
	})
	let lastEvent: ZooStreamEvent | undefined
	const makeResult = (
		outcome: "needs_input" | "cancelled" | "timed_out" | "failed",
		rootTaskId: string,
		input: { currentTaskId?: string; resumable: boolean; code?: ZooErrorCode; message?: string; content?: string },
	): ZooRunResult =>
		zooRunResultSchema.parse({
			schemaVersion: ZOO_PUBLIC_SCHEMA_VERSION,
			protocol: "zoo-run-result",
			success: false,
			outcome,
			rootTaskId,
			currentTaskId: input.currentTaskId,
			workspace: options.workspace,
			resumable: input.resumable,
			content: input.content,
			error:
				outcome === "failed" || outcome === "timed_out"
					? { code: input.code ?? "task_failed", message: input.message ?? "Task failed", kind: "runtime" }
					: undefined,
			elapsedMs: Date.now() - startedAt,
			cancellationReason: outcome === "cancelled" ? "signal" : undefined,
		})
	const client = new HostClient({
		workspace: options.workspace,
		storageRoot,
		extensionRoot: process.env.ZOO_EXTENSION_PATH ?? fileURLToPath(new URL("../../../src/dist", import.meta.url)),
		debug: options.debug,
		onEvent(event) {
			const normalizedEvent: ZooStreamEvent =
				event.type === "task.result" &&
				event.result.outcome === "cancelled" &&
				event.result.cancellationReason === "timeout"
					? {
							...event,
							result: makeResult("timed_out", event.result.rootTaskId, {
								currentTaskId: event.result.currentTaskId,
								resumable: event.result.resumable,
								code: "task_timed_out",
								message: "Task deadline exceeded",
							}),
						}
					: event
			lastEvent = normalizedEvent
			projection = reduceSession(projection, normalizedEvent)
			renderer.event(normalizedEvent)
			if (normalizedEvent.type === "task.result") settleResult?.(normalizedEvent.result)
			if (normalizedEvent.type === "ask.required" && options.approval !== "auto") {
				settleResult?.(
					makeResult("needs_input", normalizedEvent.rootTaskId, {
						currentTaskId: normalizedEvent.taskId,
						resumable: true,
						content: normalizedEvent.subject,
					}),
				)
			}
		},
	})
	let signal: "SIGINT" | "SIGTERM" | undefined
	let notifySignal: ((value: "SIGINT" | "SIGTERM") => void) | undefined
	const signalPromise = new Promise<"SIGINT" | "SIGTERM">((resolve) => (notifySignal = resolve))
	let rootTaskId: string | undefined
	const onSignal = (received: "SIGINT" | "SIGTERM") => {
		if (signal) {
			void client.stop()
			if (rootTaskId) {
				settleResult?.(
					makeResult("cancelled", rootTaskId, { currentTaskId: projection.currentTaskId, resumable: false }),
				)
			}
			return
		}
		signal = received
		notifySignal?.(received)
	}
	process.on("SIGINT", onSignal)
	process.on("SIGTERM", onSignal)
	let timeout: NodeJS.Timeout | undefined
	let notifyTimeout: (() => void) | undefined
	const timeoutPromise = new Promise<"timeout">((resolve) => (notifyTimeout = () => resolve("timeout")))
	if (options.timeout !== undefined) timeout = setTimeout(() => notifyTimeout?.(), options.timeout)
	try {
		const startup = await Promise.race([
			client.start().then(() => "started" as const),
			timeoutPromise,
			signalPromise.then(() => "signal" as const),
		])
		if (startup === "timeout") throw new Error("Task deadline exceeded during host startup")
		if (startup === "signal") throw new Error(`Received ${signal} during host startup`)
		let command: HostCommand extends infer Command
			? Command extends HostCommand
				? Omit<Command, "v" | "id">
				: never
			: never
		if (request.type === "run") {
			command = {
				type: "task.start",
				workspace: options.workspace,
				prompt: request.prompt,
				overrides,
			}
		} else {
			let taskId = request.taskId
			if (!taskId) {
				const history = await client.command({ type: "history.list", workspace: options.workspace })
				if (history.data.commandType !== "history.list" || history.data.tasks.length === 0) {
					throw new Error("No session exists for this workspace")
				}
				taskId = history.data.tasks[0]!.rootTaskId
			}
			command = { type: "task.resume", taskId, rootTaskId: taskId, overrides }
		}
		const accepted = await client.command(command)
		if (accepted.data.commandType !== "task.start" && accepted.data.commandType !== "task.resume") {
			throw new Error("Host returned an invalid task acceptance")
		}
		rootTaskId = accepted.data.task.rootTaskId
		if (signal) void client.command({ type: "task.cancel", rootTaskId, reason: "signal" }).catch(() => undefined)
		const localSettlement = Promise.race([
			timeoutPromise.then(async () => {
				await client
					.command({ type: "task.cancel", rootTaskId: rootTaskId!, reason: "timeout" }, 5_000)
					.catch(() => undefined)
				return makeResult("timed_out", rootTaskId!, {
					currentTaskId: projection.currentTaskId,
					resumable: true,
					code: "task_timed_out",
					message: "Task deadline exceeded",
				})
			}),
			signalPromise.then(async () => {
				await client
					.command({ type: "task.cancel", rootTaskId: rootTaskId!, reason: "signal" }, 5_000)
					.catch(() => undefined)
				await new Promise((resolve) => setTimeout(resolve, 1_000))
				return makeResult("cancelled", rootTaskId!, {
					currentTaskId: projection.currentTaskId,
					resumable: false,
				})
			}),
			renderer.outputClosed.then(async () => {
				await client
					.command({ type: "task.cancel", rootTaskId: rootTaskId!, reason: "user" }, 5_000)
					.catch(() => undefined)
				return makeResult("failed", rootTaskId!, {
					currentTaskId: projection.currentTaskId,
					resumable: false,
					code: "output_closed",
					message: "Output stream closed",
				})
			}),
			client.failed.catch((error: Error) =>
				makeResult("failed", rootTaskId!, {
					currentTaskId: projection.currentTaskId,
					resumable: false,
					code: "host_crashed",
					message: error.message,
				}),
			),
		])
		const result = await Promise.race([resultPromise, localSettlement])
		if (options.format === "stream-json" && lastEvent?.type !== "task.result") {
			const event: ZooStreamEvent = {
				v: 1,
				seq: (lastEvent?.seq ?? 0) + 1,
				timestamp: new Date().toISOString(),
				hostId: lastEvent?.hostId ?? "parent",
				type: "task.result",
				rootTaskId: result.rootTaskId,
				taskId: result.rootTaskId,
				result,
			}
			renderer.event(event)
		}
		renderer.result(result)
		const failedCode =
			result.error?.code === "task_timed_out" || result.error?.code === "cleanup_timed_out"
				? "task_failed"
				: (result.error?.code ?? "task_failed")
		return exitCodeFor(
			result.outcome === "failed"
				? { outcome: "failed", errorCode: failedCode }
				: result.outcome === "cancelled"
					? { outcome: "cancelled", signal }
					: result.outcome === "timed_out"
						? { outcome: "timed_out", errorCode: "task_timed_out" }
						: { outcome: result.outcome },
		)
	} finally {
		if (timeout) clearTimeout(timeout)
		process.removeListener("SIGINT", onSignal)
		process.removeListener("SIGTERM", onSignal)
		await client.stop()
		renderer.dispose()
		if (options.ephemeral) fs.rmSync(storageRoot, { recursive: true, force: true })
	}
}

export async function listSessions(options: {
	workspace: string
	format: "text" | "json"
	ephemeral?: boolean
	debug?: boolean
}) {
	if (options.ephemeral) return options.format === "json" ? process.stdout.write("[]\n") : undefined
	const client = new HostClient({
		workspace: options.workspace,
		storageRoot: path.join(defaultStorageRoot(), "state"),
		extensionRoot: process.env.ZOO_EXTENSION_PATH ?? fileURLToPath(new URL("../../../src/dist", import.meta.url)),
		debug: options.debug,
		onEvent: () => undefined,
	})
	try {
		await client.start()
		const response = await client.command({ type: "history.list", workspace: options.workspace })
		if (response.data.commandType !== "history.list") throw new Error("Host returned an invalid history response")
		if (options.format === "json") process.stdout.write(`${JSON.stringify(response.data.tasks)}\n`)
		else
			for (const task of response.data.tasks)
				process.stdout.write(`${task.rootTaskId}\t${task.state}\t${task.currentTaskId}\n`)
	} finally {
		await client.stop()
	}
}
