import type { RooCodeAPI, HeadlessTaskResult } from "@roo-code/types"
import { RooCodeEventName } from "@roo-code/types"
import { ZOO_PUBLIC_SCHEMA_VERSION, type ZooStreamEvent } from "@roo-code/zoo-protocol"

import { HostTransport } from "./transport.js"

export class HostEventBridge {
	private publicSequence = 0
	private readonly roots = new Map<string, string>()
	private readonly startedAt = new Map<string, number>()
	private readonly pendingCreated = new Set<string>()

	constructor(
		private readonly api: RooCodeAPI,
		private readonly transport: HostTransport,
		private readonly workspace: string,
		private readonly clientVersion: string,
		private readonly hostVersion: string,
	) {}

	public async initialize(): Promise<void> {
		await this.emit({
			type: "system.init",
			protocol: "zoo-stream",
			hostProtocolVersion: 1,
			capabilities: [
				"task:start",
				"task:resume",
				"task:input",
				"task:cancel",
				"ask:respond",
				"history:list",
				"host:snapshot",
				"host:shutdown",
				"checkpoint:unavailable",
			],
			clientVersion: this.clientVersion,
			hostVersion: this.hostVersion,
		})
		this.api.on(RooCodeEventName.TaskCreated, (taskId) => {
			this.pendingCreated.add(taskId)
		})
		this.api.on(RooCodeEventName.TaskStarted, (taskId) => {
			if (this.pendingCreated.delete(taskId)) {
				this.roots.set(taskId, taskId)
				void this.emitTask("task.created", taskId, {})
			}
			this.startedAt.set(this.roots.get(taskId) ?? taskId, Date.now())
			void this.emitTask("task.started", taskId, {})
			void this.emitTask("task.lifecycle", taskId, { state: "running" })
		})
		this.api.on(RooCodeEventName.TaskDelegated, (parentTaskId, childTaskId) => {
			const rootTaskId = this.roots.get(parentTaskId) ?? parentTaskId
			this.roots.set(childTaskId, rootTaskId)
			if (this.pendingCreated.delete(childTaskId)) {
				void this.emitTask("task.created", childTaskId, { parentTaskId }, rootTaskId)
			}
			void this.emitTask("task.delegated", childTaskId, { parentTaskId, childTaskId }, rootTaskId)
		})
		this.api.on(RooCodeEventName.Message, ({ taskId, message }) => {
			if (message.type !== "say" || !message.say || message.say === "api_req_started") return
			const role = message.say === "reasoning" ? "reasoning" : "assistant"
			void this.emitTask("message.upsert", taskId, {
				messageId: String(message.ts),
				role,
				content: message.text ?? "",
				complete: message.partial !== true,
			})
		})
		this.api.on(RooCodeEventName.HeadlessAsk, (ask) => {
			this.roots.set(ask.taskId, ask.rootTaskId)
			void (async () => {
				await this.emitTask(
					"ask.required",
					ask.taskId,
					{ askId: ask.askId, category: ask.ask, subject: ask.text ?? ask.ask },
					ask.rootTaskId,
				)
				await this.emitTask("task.lifecycle", ask.taskId, { state: "waiting" }, ask.rootTaskId)
			})()
		})
		this.api.on(RooCodeEventName.HeadlessTaskResult, (result) => void this.emitResult(result))
	}

	private async emitResult(event: {
		rootTaskId: string
		currentTaskId: string
		outcome: "completed" | "cancelled" | "failed"
		resumable: boolean
		cancellationReason?: "user" | "signal" | "timeout"
		content?: string
	}): Promise<void> {
		const detailed = (await this.api.getHeadlessTaskResult(event.rootTaskId)) as HeadlessTaskResult | undefined
		const outcome = event.outcome
		await this.emitTask(
			"task.lifecycle",
			event.currentTaskId,
			{
				state: outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "interrupted",
				cause: outcome === "cancelled" ? "cancelled" : outcome === "failed" ? "failed" : undefined,
			},
			event.rootTaskId,
		)
		await this.emit({
			type: "task.result",
			rootTaskId: event.rootTaskId,
			taskId: event.rootTaskId,
			result: {
				schemaVersion: 1,
				protocol: "zoo-run-result",
				success: outcome === "completed",
				outcome,
				rootTaskId: event.rootTaskId,
				currentTaskId: event.currentTaskId,
				workspace: this.workspace,
				resumable: event.resumable,
				content: event.content ?? detailed?.content,
				error:
					outcome === "failed"
						? {
								code:
									detailed?.error?.code === "shutdown"
										? "task_failed"
										: (detailed?.error?.code ?? "task_failed"),
								message: detailed?.error?.message ?? "Task failed",
								kind: "runtime",
							}
						: undefined,
				usage: detailed?.tokenUsage
					? {
							inputTokens: detailed.tokenUsage.totalTokensIn,
							outputTokens: detailed.tokenUsage.totalTokensOut,
							cacheReads: detailed.tokenUsage.totalCacheReads,
							cacheWrites: detailed.tokenUsage.totalCacheWrites,
						}
					: undefined,
				cost: detailed?.tokenUsage?.totalCost,
				elapsedMs: Date.now() - (this.startedAt.get(event.rootTaskId) ?? Date.now()),
				cancellationReason:
					outcome === "cancelled"
						? (detailed?.cancellationReason ?? event.cancellationReason ?? "user")
						: undefined,
			},
		})
		this.startedAt.delete(event.rootTaskId)
	}

	private emitTask(type: string, taskId: string, data: Record<string, unknown>, rootTaskId?: string): Promise<void> {
		return this.emit({ type, rootTaskId: rootTaskId ?? this.roots.get(taskId) ?? taskId, taskId, ...data })
	}

	private async emit(event: Record<string, unknown>): Promise<void> {
		const normalized = {
			v: ZOO_PUBLIC_SCHEMA_VERSION,
			seq: ++this.publicSequence,
			timestamp: new Date().toISOString(),
			hostId: this.transport.hostId,
			...event,
		} as ZooStreamEvent
		await this.transport.send({ type: "event", event: normalized })
	}
}
