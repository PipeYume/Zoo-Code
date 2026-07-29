import { createHash } from "crypto"
import { spawn } from "child_process"
import { createReadStream, createWriteStream } from "fs"
import * as fs from "fs/promises"
import * as https from "https"
import * as path from "path"

import {
	DCG_ARCHIVES,
	DCG_DOWNLOAD_BASE_URL,
	DCG_DOWNLOAD_TIMEOUT_MS,
	DCG_MAX_ARCHIVE_BYTES,
	DCG_TRUSTED_DOWNLOAD_DOMAINS,
	DCG_VERSION,
	type DcgArchiveInfo,
} from "./constants"

const installationPromises = new Map<string, Promise<string>>()

export function getDcgArchiveInfo(platform = process.platform, arch = process.arch): DcgArchiveInfo | undefined {
	return DCG_ARCHIVES[`${platform}-${arch}`]
}

export function isDcgSupportedPlatform(platform = process.platform, arch = process.arch): boolean {
	return getDcgArchiveInfo(platform, arch) !== undefined
}

export function getDcgBinaryPath(
	storageDir: string,
	platform = process.platform,
	arch = process.arch,
): string | undefined {
	const info = getDcgArchiveInfo(platform, arch)
	return info ? path.join(storageDir, "destructive-command-guard", DCG_VERSION, info.binary) : undefined
}

function isTrustedDownloadUrl(url: string): boolean {
	try {
		const parsed = new URL(url)
		return (
			parsed.protocol === "https:" &&
			DCG_TRUSTED_DOWNLOAD_DOMAINS.some(
				(domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
			)
		)
	} catch {
		return false
	}
}

function downloadFile(url: string, destination: string, redirectsRemaining = 5): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!isTrustedDownloadUrl(url)) {
			reject(new Error("DCG download redirected to an untrusted host"))
			return
		}

		const request = https.get(url, (response) => {
			const status = response.statusCode ?? 0
			if ([301, 302, 303, 307, 308].includes(status)) {
				response.resume()
				if (redirectsRemaining <= 0 || !response.headers.location) {
					reject(new Error("Too many DCG download redirects"))
					return
				}
				const nextUrl = new URL(response.headers.location, url).toString()
				downloadFile(nextUrl, destination, redirectsRemaining - 1).then(resolve, reject)
				return
			}

			if (status !== 200) {
				response.resume()
				reject(new Error(`DCG download failed with HTTP ${status}`))
				return
			}

			const declaredSize = Number(response.headers["content-length"] ?? 0)
			if (declaredSize > DCG_MAX_ARCHIVE_BYTES) {
				response.resume()
				reject(new Error("DCG archive exceeds the download size limit"))
				return
			}

			let received = 0
			const output = createWriteStream(destination, { flags: "wx", mode: 0o600 })
			response.on("data", (chunk: Buffer) => {
				received += chunk.length
				if (received > DCG_MAX_ARCHIVE_BYTES) {
					request.destroy(new Error("DCG archive exceeds the download size limit"))
				}
			})
			response.pipe(output)
			output.on("finish", () => output.close(() => resolve()))
			output.on("error", reject)
		})

		request.setTimeout(DCG_DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error("DCG download timed out")))
		request.on("error", reject)
	})
}

async function verifyChecksum(filePath: string, expected: string): Promise<void> {
	const hash = createHash("sha256")
	await new Promise<void>((resolve, reject) => {
		const input = createReadStream(filePath)
		input.on("data", (chunk) => hash.update(chunk))
		input.on("end", resolve)
		input.on("error", reject)
	})
	if (hash.digest("hex") !== expected) {
		throw new Error("DCG archive checksum verification failed")
	}
}

function runProcess(
	executable: string,
	args: string[],
	timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			reject(new Error(`${path.basename(executable)} timed out`))
		}, timeoutMs)
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.on("error", (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on("close", (code) => {
			clearTimeout(timer)
			if (code === 0) {
				resolve({ stdout, stderr })
			} else {
				reject(new Error(stderr.trim() || `Process exited with code ${code}`))
			}
		})
	})
}

async function extractSingleBinary(archivePath: string, stagingDir: string, info: DcgArchiveInfo): Promise<void> {
	const listingArgs = info.archive.endsWith(".zip") ? ["-tf", archivePath] : ["-tJf", archivePath]
	const listing = await runProcess("tar", listingArgs)
	const entries = listing.stdout
		.split(/\r?\n/)
		.map((entry) => entry.trim().replace(/^\.\//, ""))
		.filter(Boolean)
	if (entries.length !== 1 || entries[0] !== info.binary) {
		throw new Error("DCG archive has an unexpected layout")
	}

	const extractArgs = info.archive.endsWith(".zip")
		? ["-xf", archivePath, "-C", stagingDir, info.binary]
		: ["-xJf", archivePath, "-C", stagingDir, info.binary]
	await runProcess("tar", extractArgs)
}

async function installDcg(storageDir: string): Promise<string> {
	const info = getDcgArchiveInfo()
	if (!info) {
		throw new Error(`Destructive Command Guard is not available for ${process.platform}-${process.arch}`)
	}

	const installRoot = path.join(storageDir, "destructive-command-guard")
	const finalDir = path.join(installRoot, DCG_VERSION)
	const binaryPath = path.join(finalDir, info.binary)
	try {
		await fs.access(binaryPath)
		return binaryPath
	} catch {
		// First install, or the managed executable was removed.
	}

	await fs.mkdir(installRoot, { recursive: true })
	const stagingDir = path.join(installRoot, `${DCG_VERSION}.staging-${process.pid}-${Date.now()}`)
	const archivePath = path.join(installRoot, `${info.archive}.${process.pid}.${Date.now()}.download`)
	await fs.mkdir(stagingDir, { recursive: true })

	try {
		await downloadFile(`${DCG_DOWNLOAD_BASE_URL}/${info.archive}`, archivePath)
		await verifyChecksum(archivePath, info.sha256)
		await extractSingleBinary(archivePath, stagingDir, info)
		const stagedBinary = path.join(stagingDir, info.binary)
		if (process.platform !== "win32") {
			await fs.chmod(stagedBinary, 0o755)
		}
		const version = await runProcess(stagedBinary, ["--version"], 10_000)
		if (!`${version.stdout}\n${version.stderr}`.includes(DCG_VERSION.replace(/^v/, ""))) {
			throw new Error("Downloaded DCG executable reported an unexpected version")
		}
		await fs.rm(finalDir, { recursive: true, force: true })
		await fs.rename(stagingDir, finalDir)
		return binaryPath
	} finally {
		await fs.rm(archivePath, { force: true }).catch(() => {})
		await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
	}
}

export function ensureDcgInstalled(storageDir: string): Promise<string> {
	const existing = installationPromises.get(storageDir)
	if (existing) {
		return existing
	}
	const promise = installDcg(storageDir).finally(() => installationPromises.delete(storageDir))
	installationPromises.set(storageDir, promise)
	return promise
}
