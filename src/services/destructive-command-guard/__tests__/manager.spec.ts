import { DCG_ARCHIVES } from "../constants"
import { getDcgArchiveInfo, getDcgBinaryPath, isDcgSupportedPlatform } from "../manager"

describe("Destructive Command Guard manager", () => {
	it("maps all supported platform and architecture combinations", () => {
		expect(Object.keys(DCG_ARCHIVES).sort()).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"win32-arm64",
			"win32-x64",
		])
		expect(getDcgArchiveInfo("darwin", "arm64")?.archive).toBe("dcg-aarch64-apple-darwin.tar.xz")
		expect(getDcgArchiveInfo("win32", "x64")?.binary).toBe("dcg.exe")
	})

	it("rejects unsupported platforms", () => {
		expect(isDcgSupportedPlatform("freebsd", "x64")).toBe(false)
		expect(getDcgBinaryPath("/storage", "freebsd", "x64")).toBeUndefined()
	})

	it("returns a versioned managed binary path", () => {
		expect(getDcgBinaryPath("/storage", "linux", "x64")).toMatch(
			/[/\\]destructive-command-guard[/\\]v0\.7\.7[/\\]dcg$/,
		)
	})
})
