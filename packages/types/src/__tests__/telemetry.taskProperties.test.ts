// pnpm --filter @roo-code/types test src/__tests__/telemetry.taskProperties.test.ts

import { taskPropertiesSchema } from "../telemetry.js"

describe("taskPropertiesSchema", () => {
	it("accepts a payload with no message/tool summary", () => {
		const result = taskPropertiesSchema.safeParse({ taskId: "task_1" })

		expect(result.success).toBe(true)
	})

	it("accepts an optional toolsUsed map", () => {
		const result = taskPropertiesSchema.safeParse({
			taskId: "task_1",
			toolsUsed: { read_file: { attempts: 3, failures: 0 } },
		})

		expect(result.success).toBe(true)
	})

	it("accepts an optional messageCount summary", () => {
		const result = taskPropertiesSchema.safeParse({
			taskId: "task_1",
			messageCount: { user: 4, assistant: 5 },
		})

		expect(result.success).toBe(true)
	})

	it("rejects a messageCount missing a required field", () => {
		const result = taskPropertiesSchema.safeParse({
			taskId: "task_1",
			messageCount: { user: 4 },
		})

		expect(result.success).toBe(false)
	})
})
