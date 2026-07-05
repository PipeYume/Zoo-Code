// pnpm --filter @roo-code/telemetry test src/__tests__/TelemetryService.shutdown.test.ts

import { TelemetryEventName, type TelemetryClient } from "@roo-code/types"

import { TelemetryService } from "../TelemetryService"

describe("TelemetryService.shutdown draining", () => {
	it("awaits in-flight captureEvent calls before shutting down clients", async () => {
		let resolveCapture!: () => void
		const capturePromise = new Promise<void>((resolve) => {
			resolveCapture = resolve
		})

		const captureOrder: string[] = []

		const mockClient: TelemetryClient = {
			setProvider: vi.fn(),
			capture: vi.fn().mockImplementation(async () => {
				await capturePromise
				captureOrder.push("captured")
			}),
			captureException: vi.fn(),
			updateTelemetryState: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn().mockImplementation(async () => {
				captureOrder.push("shutdown")
			}),
		}

		const service = new TelemetryService([mockClient])

		// Fire a capture whose underlying client.capture() promise hasn't resolved yet.
		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "abc" })

		const shutdownPromise = service.shutdown()

		// Capture is still pending - shutdown must not have run yet.
		expect(captureOrder).toEqual([])

		resolveCapture()
		await shutdownPromise

		// The in-flight capture must complete before the client is shut down.
		expect(captureOrder).toEqual(["captured", "shutdown"])
	})

	it("does not let a rejected capture prevent shutdown from completing", async () => {
		const mockClient: TelemetryClient = {
			setProvider: vi.fn(),
			capture: vi.fn().mockRejectedValue(new Error("capture failed")),
			captureException: vi.fn(),
			updateTelemetryState: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn().mockResolvedValue(undefined),
		}

		const service = new TelemetryService([mockClient])

		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "abc" })

		await expect(service.shutdown()).resolves.toBeUndefined()
		expect(mockClient.shutdown).toHaveBeenCalledTimes(1)
	})
})
