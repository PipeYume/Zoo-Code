import { Task } from "../Task"
import { MessageQueueService } from "../../message-queue/MessageQueueService"

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

const buildTask = () => {
	const task = Object.create(Task.prototype) as Task

	Object.assign(task, {
		abort: false,
		clineMessages: [],
		askResponse: undefined,
		askResponseText: undefined,
		askResponseImages: undefined,
		lastMessageTs: undefined,
		messageQueueService: new MessageQueueService(),
		addToClineMessages: vi.fn(async () => {}),
		saveClineMessages: vi.fn(async () => {}),
		updateClineMessage: vi.fn(async () => {}),
		cancelAutoApprovalTimeout: vi.fn(() => {}),
		checkpointSave: vi.fn(async () => {}),
		emit: vi.fn(),
		providerRef: { deref: () => undefined },
	})

	return task
}

describe("Task.ask queued message drain", () => {
	it.each(["tool", "command", "use_mcp_server"] as const)(
		"treats queued input as feedback instead of approving a %s ask",
		async (askType) => {
			const task = buildTask()
			task.messageQueueService.addMessage("change direction", ["queued-image.png"])

			const result = await task.ask(askType, "pending approval", false)

			expect(result).toEqual({
				response: "messageResponse",
				text: "change direction",
				images: ["queued-image.png"],
			})
			expect(task.messageQueueService.isEmpty()).toBe(true)
		},
	)

	it.each(["tool", "command", "use_mcp_server"] as const)(
		"treats input queued while blocked as feedback instead of approving a %s ask",
		async (askType) => {
			const task = buildTask()
			const askPromise = task.ask(askType, "pending approval", false)

			// Let ask() observe an empty queue and enter its pWaitFor loop before
			// simulating input that arrives while the approval is already blocked.
			await new Promise((resolve) => setTimeout(resolve, 0))
			task.messageQueueService.addMessage("change direction")

			await expect(askPromise).resolves.toMatchObject({
				response: "messageResponse",
				text: "change direction",
			})
		},
	)

	it("consumes queued message while blocked on followup ask", async () => {
		const task = buildTask()

		const askPromise = task.ask("followup", "Q?", false)

		// Simulate webview queuing the user's selection text while the ask is pending.
		task.messageQueueService.addMessage("picked answer")

		const result = await askPromise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("picked answer")
	})

	it("does not consume queued messages for command_output asks", async () => {
		const task = buildTask()

		const askPromise = task.ask("command_output", "command is still running...", false)
		task.messageQueueService.addMessage("1+1=?")

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect(task.messageQueueService.isEmpty()).toBe(false)
		expect(task.messageQueueService.messages[0]?.text).toBe("1+1=?")
	})
})
