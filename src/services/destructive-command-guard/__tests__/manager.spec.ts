import { createHash } from "crypto"
import { EventEmitter } from "events"
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { PassThrough } from "stream"

import { spawn } from "child_process"

import { DCG_ARCHIVES, DCG_MAX_ARCHIVE_BYTES, DCG_VERSION } from "../constants"
import {
	assertArchiveSizeWithinLimit,
	cleanupStaleInstallations,
	downloadFile,
	extractSingleBinary,
	getDcgArchiveInfo,
	getDcgBinaryPath,
	isDcgSupportedPlatform,
	isTrustedDownloadUrl,
	promoteStagedInstallation,
	resolveTrustedRedirect,
	verifyChecksum,
} from "../manager"

vi.mock("child_process", () => ({ spawn: vi.fn() }))

const mockSpawn = vi.mocked(spawn)

describe("Destructive Command Guard manager", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "dcg-manager-"))
		mockSpawn.mockReset()
	})

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true })
	})

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
		expect(getDcgBinaryPath("/storage", "linux", "x64")).toBe(
			path.join("/storage", "destructive-command-guard", DCG_VERSION, "dcg"),
		)
	})

	it("accepts only HTTPS URLs on trusted host boundaries", () => {
		expect(isTrustedDownloadUrl("https://github.com/release")).toBe(true)
		expect(isTrustedDownloadUrl("https://cdn.objects.githubusercontent.com/release")).toBe(true)
		expect(isTrustedDownloadUrl("http://github.com/release")).toBe(false)
		expect(isTrustedDownloadUrl("https://evilgithub.com/release")).toBe(false)
	})

	it("rejects untrusted download URLs before opening a destination", async () => {
		await expect(downloadFile("https://example.com/dcg", path.join(tempDir, "archive"))).rejects.toThrow(
			"DCG download redirected to an untrusted host",
		)
	})

	it("allows trusted relative redirects and rejects unsafe or exhausted redirects", () => {
		expect(resolveTrustedRedirect("https://github.com/release", "/asset", 5)).toBe("https://github.com/asset")
		expect(() => resolveTrustedRedirect("https://github.com/release", "https://example.com/asset", 5)).toThrow(
			"DCG download redirected to an untrusted host",
		)
		expect(() => resolveTrustedRedirect("https://github.com/release", "/asset", 0)).toThrow(
			"Too many DCG download redirects",
		)
		expect(() => resolveTrustedRedirect("https://github.com/release", undefined, 5)).toThrow(
			"Too many DCG download redirects",
		)
	})

	it("enforces the archive download size limit", () => {
		expect(() => assertArchiveSizeWithinLimit(DCG_MAX_ARCHIVE_BYTES)).not.toThrow()
		expect(() => assertArchiveSizeWithinLimit(DCG_MAX_ARCHIVE_BYTES + 1)).toThrow(
			"DCG archive exceeds the download size limit",
		)
	})

	it("verifies matching checksums and rejects mismatches", async () => {
		const filePath = path.join(tempDir, "archive")
		const contents = Buffer.from("verified archive")
		await writeFile(filePath, contents)
		const checksum = createHash("sha256").update(contents).digest("hex")

		await expect(verifyChecksum(filePath, checksum)).resolves.toBeUndefined()
		await expect(verifyChecksum(filePath, "0".repeat(64))).rejects.toThrow(
			"DCG archive checksum verification failed",
		)
	})

	it("uses PowerShell to validate and extract a single ZIP entry", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		})
		// The production code uses only the event and stream subset supplied by this test double.
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)

		const extraction = extractSingleBinary("C:\\dcg.zip", "C:\\staging", DCG_ARCHIVES["win32-x64"])
		child.emit("close", 0)
		await extraction

		expect(mockSpawn).toHaveBeenCalledWith(
			"powershell",
			expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
			expect.objectContaining({ shell: false }),
		)
		const script = mockSpawn.mock.calls[0][1][3]
		expect(script).toContain("$entries.Count -ne 1")
		expect(script).toContain("dcg.exe")
	})

	it("rejects unexpected tar archive layouts before extraction", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		})
		// The production code uses only the event and stream subset supplied by this test double.
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)

		const extraction = extractSingleBinary("/tmp/dcg.tar.xz", tempDir, DCG_ARCHIVES["linux-x64"])
		child.stdout.write("dcg\nREADME.md\n")
		child.emit("close", 0)

		await expect(extraction).rejects.toThrow("DCG archive has an unexpected layout")
		expect(mockSpawn).toHaveBeenCalledTimes(1)
	})

	it("does not replace an installation completed by another process", async () => {
		const stagingDir = path.join(tempDir, "staging")
		const finalDir = path.join(tempDir, "final")
		const binaryPath = path.join(finalDir, "dcg")
		await mkdir(stagingDir)
		await mkdir(finalDir)
		await writeFile(path.join(stagingDir, "dcg"), "staged")
		await writeFile(binaryPath, "installed")

		await promoteStagedInstallation(stagingDir, finalDir, binaryPath)

		expect(await readFile(binaryPath, "utf8")).toBe("installed")
		expect(await readFile(path.join(stagingDir, "dcg"), "utf8")).toBe("staged")
	})

	it("removes only stale version directories after a successful update", async () => {
		const currentDir = path.join(tempDir, DCG_VERSION)
		const staleDir = path.join(tempDir, "v0.6.0")
		const stagingDir = path.join(tempDir, `${DCG_VERSION}.staging-123`)
		const unrelatedDir = path.join(tempDir, "user-data")
		await Promise.all([currentDir, staleDir, stagingDir, unrelatedDir].map((dir) => mkdir(dir)))

		await cleanupStaleInstallations(tempDir)

		await expect(access(staleDir)).rejects.toThrow()
		await expect(
			Promise.all([currentDir, stagingDir, unrelatedDir].map((dir) => access(dir))),
		).resolves.toBeDefined()
	})
})
