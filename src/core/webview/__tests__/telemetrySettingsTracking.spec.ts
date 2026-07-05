import { describe, it, expect, vi, beforeEach } from "vitest"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName, type TelemetrySetting, isTelemetryOptedIn } from "@roo-code/types"

describe("Telemetry Settings Tracking", () => {
	let mockTelemetryService: {
		captureTelemetrySettingsChanged: ReturnType<typeof vi.fn>
		updateTelemetryState: ReturnType<typeof vi.fn>
		hasInstance: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		// Reset mocks
		vi.clearAllMocks()

		// Create mock service
		mockTelemetryService = {
			captureTelemetrySettingsChanged: vi.fn(),
			updateTelemetryState: vi.fn(),
			hasInstance: vi.fn().mockReturnValue(true),
		}

		// Mock the TelemetryService
		vi.spyOn(TelemetryService, "hasInstance").mockReturnValue(true)
		vi.spyOn(TelemetryService, "instance", "get").mockReturnValue(mockTelemetryService as any)
	})

	describe("when telemetry is turned OFF", () => {
		it("should fire event BEFORE disabling telemetry", () => {
			const previousSetting = "enabled" as TelemetrySetting
			const newSetting = "disabled" as TelemetrySetting

			// Simulate the logic from webviewMessageHandler
			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			// If turning telemetry OFF, fire event BEFORE disabling
			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			// Update the telemetry state
			TelemetryService.instance.updateTelemetryState(isOptedIn)

			// Verify the event was captured before updateTelemetryState
			expect(mockTelemetryService.captureTelemetrySettingsChanged).toHaveBeenCalledWith("enabled", "disabled")
			expect(mockTelemetryService.captureTelemetrySettingsChanged).toHaveBeenCalledBefore(
				mockTelemetryService.updateTelemetryState as any,
			)
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(false)
		})

		it("should not fire an opt-out event when going from unset to disabled (was never opted in)", () => {
			const previousSetting = "unset" as TelemetrySetting
			const newSetting = "disabled" as TelemetrySetting

			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			TelemetryService.instance.updateTelemetryState(isOptedIn)

			// "unset" was never opted in, so there is no opt-out transition to report.
			expect(mockTelemetryService.captureTelemetrySettingsChanged).not.toHaveBeenCalled()
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(false)
		})
	})

	describe("when telemetry is turned ON", () => {
		it("should fire event AFTER enabling telemetry", () => {
			const previousSetting = "disabled" as TelemetrySetting
			const newSetting = "enabled" as TelemetrySetting

			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			// Update the telemetry state first
			TelemetryService.instance.updateTelemetryState(isOptedIn)

			// If turning telemetry ON, fire event AFTER enabling
			if (!wasPreviouslyOptedIn && isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			// Verify the event was captured after updateTelemetryState
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(true)
			expect(mockTelemetryService.captureTelemetrySettingsChanged).toHaveBeenCalledWith("disabled", "enabled")
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledBefore(
				mockTelemetryService.captureTelemetrySettingsChanged as any,
			)
		})

		it("should not fire event when going from enabled to enabled", () => {
			const previousSetting = "enabled" as TelemetrySetting
			const newSetting = "enabled" as TelemetrySetting

			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			// Neither condition should be met
			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			TelemetryService.instance.updateTelemetryState(isOptedIn)

			if (!wasPreviouslyOptedIn && isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			// Should not fire any telemetry events
			expect(mockTelemetryService.captureTelemetrySettingsChanged).not.toHaveBeenCalled()
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(true)
		})

		it("should fire an opt-in event when going from unset to enabled (explicit Accept)", () => {
			const previousSetting = "unset" as TelemetrySetting
			const newSetting = "enabled" as TelemetrySetting

			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			TelemetryService.instance.updateTelemetryState(isOptedIn)

			if (!wasPreviouslyOptedIn && isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			// "unset" is not opted in, so unset -> enabled is a genuine opt-in transition.
			expect(mockTelemetryService.captureTelemetrySettingsChanged).toHaveBeenCalledWith("unset", "enabled")
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(true)
		})
	})

	describe("neutral banner dismiss ('unset' left as-is)", () => {
		it("does not report telemetry as opted in while the setting remains unset", () => {
			// A neutral dismiss of the consent banner sends no telemetrySetting message at
			// all, so the stored setting stays "unset". Confirm "unset" alone -- with no
			// transition -- is not treated as consent.
			expect(isTelemetryOptedIn("unset" as TelemetrySetting)).toBe(false)
		})
	})

	describe("TelemetryService.captureTelemetrySettingsChanged", () => {
		it("should call captureEvent with correct parameters", () => {
			// Create a real instance to test the method
			const mockCaptureEvent = vi.fn()
			const service = new (TelemetryService as any)([])
			service.captureEvent = mockCaptureEvent

			service.captureTelemetrySettingsChanged("enabled", "disabled")

			expect(mockCaptureEvent).toHaveBeenCalledWith(TelemetryEventName.TELEMETRY_SETTINGS_CHANGED, {
				previousSetting: "enabled",
				newSetting: "disabled",
			})
		})
	})
})
