import fs from "fs"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getBinPath, resolvePlatformRipgrepPath } from "../index"

describe("platform ripgrep filesystem resolution", () => {
	let appRoot: string

	beforeEach(() => {
		appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ripgrep-wrapper-"))
	})

	afterEach(() => {
		fs.rmSync(appRoot, { recursive: true, force: true })
	})

	it("probes the wrapper-exported rgPath on the real filesystem", async () => {
		const wrapperRoot = path.join(appRoot, "node_modules", "@vscode", "ripgrep")
		const wrapperEntry = path.join(wrapperRoot, "index.js")
		const rgPath = path.join(appRoot, "platform", process.platform === "win32" ? "rg.exe" : "rg")
		fs.mkdirSync(path.dirname(rgPath), { recursive: true })
		fs.mkdirSync(wrapperRoot, { recursive: true })
		fs.writeFileSync(path.join(wrapperRoot, "package.json"), JSON.stringify({ main: "index.js" }))
		fs.writeFileSync(wrapperEntry, `module.exports = { rgPath: ${JSON.stringify(rgPath)} }`)
		fs.writeFileSync(rgPath, "")

		expect(resolvePlatformRipgrepPath(appRoot)).toBe(rgPath)
		await expect(getBinPath(appRoot)).resolves.toBe(rgPath)
	})

	it("rejects a wrapper path that does not exist", async () => {
		const wrapperRoot = path.join(appRoot, "node_modules", "@vscode", "ripgrep")
		const missing = path.join(appRoot, "missing-rg")
		fs.mkdirSync(wrapperRoot, { recursive: true })
		fs.writeFileSync(path.join(wrapperRoot, "package.json"), JSON.stringify({ main: "index.js" }))
		fs.writeFileSync(path.join(wrapperRoot, "index.js"), `module.exports = { rgPath: ${JSON.stringify(missing)} }`)

		await expect(getBinPath(appRoot)).resolves.toBeUndefined()
	})
})
