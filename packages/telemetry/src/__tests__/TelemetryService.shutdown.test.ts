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

	it("drains a second capture that gets queued after shutdown() has already started draining", async () => {
		// Regression test: shutdown() must not take a single Promise.all snapshot of
		// pendingClientCalls. A promise added to pendingClientCalls *after* Promise.all(set)
		// has already been called is never awaited by that call, even if it never resolves
		// -- Promise.all takes its list of promises to await synchronously, at call time.
		// So a second capture queued while the first Promise.all pass is still pending (e.g.
		// a teardown-time error handler reacting to something unrelated) would be silently
		// dropped by a single-pass drain, letting client.shutdown() run without it.
		let resolveFirstCapture!: () => void
		const firstCapturePromise = new Promise<void>((resolve) => {
			resolveFirstCapture = resolve
		})

		let resolveSecondCapture!: () => void
		const secondCapturePromise = new Promise<void>((resolve) => {
			resolveSecondCapture = resolve
		})

		const captureOrder: string[] = []
		let firstCaptureStarted = false

		const mockClient: TelemetryClient = {
			setProvider: vi.fn(),
			capture: vi.fn().mockImplementation(async () => {
				if (!firstCaptureStarted) {
					firstCaptureStarted = true
					await firstCapturePromise
					captureOrder.push("first-captured")
					return
				}

				await secondCapturePromise
				captureOrder.push("second-captured")
			}),
			captureException: vi.fn(),
			updateTelemetryState: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn().mockImplementation(async () => {
				captureOrder.push("shutdown")
			}),
		}

		const service = new TelemetryService([mockClient])

		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "first" })

		const shutdownPromise = service.shutdown()

		// Queue the second capture synchronously, immediately after shutdown() has started
		// (and thus after its first Promise.all(pendingClientCalls) pass has already taken
		// its snapshot). This is the scenario the loop fix protects against.
		service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "second" })

		resolveFirstCapture()
		// Flush several microtask ticks so a buggy single-pass drain has every opportunity
		// to run client.shutdown() before we check -- a couple of ticks isn't enough since
		// the mocked capture/shutdown chain itself spans a few microtask hops.
		for (let i = 0; i < 4; i++) {
			await Promise.resolve()
		}

		// The second capture is still pending (its own resolver hasn't fired) -- shutdown
		// must not have completed yet, otherwise it dropped the second capture.
		expect(captureOrder).not.toContain("shutdown")

		resolveSecondCapture()
		await shutdownPromise

		expect(mockClient.capture).toHaveBeenCalledTimes(2)
		expect(captureOrder).toEqual(["first-captured", "second-captured", "shutdown"])
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
