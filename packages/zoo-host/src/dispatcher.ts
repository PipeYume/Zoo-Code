import type { RooCodeAPI } from "@roo-code/types"
import { hostCommandSchema, type HostCommand } from "@roo-code/zoo-protocol"

import { HostTransport } from "./transport.js"
import { HostEventBridge } from "./events.js"

export class HostCommandDispatcher {
	private queue = Promise.resolve()
	private activeRootTaskId: string | undefined

	constructor(
		private readonly api: RooCodeAPI,
		private readonly transport: HostTransport,
		private readonly workspace: string,
		private readonly bridge?: HostEventBridge,
	) {}

	public dispatch(input: unknown): Promise<void> {
		const command = hostCommandSchema.parse(input)
		const operation = this.queue.then(() => this.execute(command))
		this.queue = operation.catch(() => undefined)
		return operation
	}

	private async execute(command: HostCommand): Promise<void> {
		await this.transport.send({ type: "command.ack", commandId: command.id })
		try {
			const data = await this.executeCommand(command)
			await this.transport.send({ type: "command.done", commandId: command.id, data })
		} catch (error) {
			await this.transport.send({
				type: "command.error",
				commandId: command.id,
				error: {
					code: "task_failed",
					kind: "runtime",
					phase: command.type,
					message: error instanceof Error ? error.message : String(error),
				},
			})
		}
	}

	private async executeCommand(command: HostCommand) {
		switch (command.type) {
			case "task.start": {
				if (command.workspace !== this.workspace) throw new Error("Host workspace identity cannot change")
				this.bridge?.prepareStart(command.id, command.overrides?.approval ?? "safe")
				const task = await this.api.startHeadlessTask({ text: command.prompt, overrides: command.overrides })
				this.activeRootTaskId = task.rootTaskId
				return { commandType: command.type, task }
			}
			case "task.resume": {
				const history = await this.api.getTaskHistoryItem(command.taskId)
				if (!history) throw new Error(`Unknown session ${command.taskId}`)
				if (history.workspace !== this.workspace) {
					throw new Error(`Session ${command.taskId} belongs to workspace ${history.workspace ?? "unknown"}`)
				}
				this.bridge?.prepareResume(
					command.id,
					command.taskId,
					command.rootTaskId,
					command.overrides?.approval ?? "safe",
					history.status === "delegated" ? "waiting" : "interrupted",
				)
				const task = await this.api.resumeHeadlessTask(command.taskId, command.overrides)
				this.activeRootTaskId = task.rootTaskId
				return { commandType: command.type, task }
			}
			case "task.input":
				await this.api.sendMessage(command.text, command.images)
				return { commandType: command.type, taskId: command.taskId }
			case "ask.respond":
				this.bridge?.prepareAskResponse(
					command.id,
					command.taskId,
					command.askId,
					command.response === "approve" ? "approve" : command.response === "reject" ? "reject" : "needs_input",
				)
				await this.api.respondToHeadlessAsk({
					taskId: command.taskId,
					askId: command.askId,
					response:
						command.response === "message"
							? { response: "message", text: command.text! }
							: { response: command.response },
				})
				return { commandType: command.type, taskId: command.taskId, askId: command.askId }
			case "task.cancel":
				this.bridge?.prepareCancellation(command.id, command.rootTaskId)
				await this.api.cancelHeadlessTask({ rootTaskId: command.rootTaskId, reason: command.reason })
				return { commandType: command.type, rootTaskId: command.rootTaskId }
			case "host.snapshot":
				return {
					commandType: command.type,
					lastSeq: this.transport.lastSequence,
					activeRootTaskId: this.activeRootTaskId,
				}
			case "host.shutdown":
				await this.api.shutdownHeadless()
				return { commandType: command.type }
			case "history.list":
				if (command.workspace !== this.workspace) throw new Error("Host workspace identity cannot change")
				return {
					commandType: command.type,
					workspace: command.workspace,
					tasks: (await this.api.listHeadlessTaskHistory(command.workspace))
						.filter((item) => item.parentTaskId === undefined)
						.map((item) => ({
							rootTaskId: item.rootTaskId ?? item.id,
							currentTaskId: item.delegatedToId ?? item.id,
							workspace: command.workspace,
							state:
								item.status === "completed"
									? ("completed" as const)
									: item.status === "interrupted"
										? ("interrupted" as const)
										: item.status === "delegated"
											? ("waiting" as const)
											: ("running" as const),
						})),
				}
		}
	}
}
