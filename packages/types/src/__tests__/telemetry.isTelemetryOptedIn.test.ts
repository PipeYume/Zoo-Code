// pnpm --filter @roo-code/types test src/__tests__/telemetry.isTelemetryOptedIn.test.ts

import { isTelemetryOptedIn } from "../telemetry.js"

describe("isTelemetryOptedIn", () => {
	it("returns true only for an explicit 'enabled' setting", () => {
		expect(isTelemetryOptedIn("enabled")).toBe(true)
	})

	it("returns false for an explicit 'disabled' setting", () => {
		expect(isTelemetryOptedIn("disabled")).toBe(false)
	})

	it("returns false for 'unset' (no explicit consent yet)", () => {
		expect(isTelemetryOptedIn("unset")).toBe(false)
	})

	it("returns false for undefined (treated the same as unset)", () => {
		expect(isTelemetryOptedIn(undefined)).toBe(false)
	})
})
