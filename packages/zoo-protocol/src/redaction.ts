const REDACTED = "[REDACTED]" as const
const sensitiveKeyName = String.raw`(?:[A-Za-z0-9_.-]*(?:password|secret|passphrase|passwd|pwd)[A-Za-z0-9_.-]*|[A-Za-z0-9_.-]*(?:api[-_. ]?(?:key|token)|access[-_. ]?token|auth[-_. ]?token|bearer[-_. ]?token|client[-_. ]?secret|id[-_. ]?token|private[-_. ]?key|refresh[-_. ]?token|session[-_. ]?token)|authorization|cookie|credentials?|token)`
const secretValue = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;}]+)`
const cliSecretValue = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;}]+)`
const doubleQuotedSecret = new RegExp(`("${sensitiveKeyName}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi")
const singleQuotedSecret = new RegExp(`('${sensitiveKeyName}'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, "gi")
const quotedUnquotedSecret = new RegExp(
	`((?:"${sensitiveKeyName}"|'${sensitiveKeyName}')\\s*:\\s*)(?!["'])[^\\s,;}]+`,
	"gi",
)
const terminalControl = new RegExp(
	`(?:${String.fromCharCode(27)}\\][^${String.fromCharCode(7)}${String.fromCharCode(27)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\)|${String.fromCharCode(27)}[PX^_][\\s\\S]*?${String.fromCharCode(27)}\\\\|${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]|[\\u0090\\u0098\\u009d\\u009e\\u009f][\\s\\S]*?\\u009c|\\u009b[0-?]*[ -/]*[@-~]|${String.fromCharCode(27)}[@-_])`,
	"g",
)
const secretPatterns: ReadonlyArray<RegExp> = [
	/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
	new RegExp(`--${sensitiveKeyName}(?:\\s*=\\s*|\\s+)${cliSecretValue}`, "gi"),
	new RegExp(`(?<!["'])\\b${sensitiveKeyName}\\s*:\\s*${secretValue}`, "gi"),
	new RegExp(`(?<!["'])\\b${sensitiveKeyName}\\s*=\\s*${cliSecretValue}`, "gi"),
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
	/\b(?:sk|xox[baprs]|gh[opusr])[-_][A-Za-z0-9_-]{8,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
	/\b[A-Za-z][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\s*=\s*[^\s]+/gi,
	/-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g,
]

export type RedactedValue = null | undefined | boolean | number | string | RedactedValue[] | { [key: string]: RedactedValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function isSensitiveKey(key: string): boolean {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.toLowerCase()
	if (
		/\b(?:password|secret|passphrase|passwd|pwd)\b/.test(words) ||
		/^(?:(?:proxy )?authorization|credentials?)$/.test(words) ||
		/\bcookie\b/.test(words) ||
		/\bprivate key\b/.test(words)
	)
		return true
	if (
		/\b(?:api key|api token|access token|auth token|bearer token|id token|private key|refresh token|session token) value$/.test(
			words,
		)
	) {
		return true
	}
	return /^(?:.* )?(?:api key|api token|access token|auth token|bearer token|id token|private key|refresh token|session token|token)$/.test(
		words,
	)
}

export function canonicalizeRedactionText(value: string): string {
	const withoutTerminalControls = value
		.replace(terminalControl, "")
		.replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
	const rendered: string[] = []
	for (const character of withoutTerminalControls) {
		if (character === "\b") {
			if (rendered.at(-1) !== "\n") rendered.pop()
		} else {
			rendered.push(character)
		}
	}
	return rendered.join("")
}

export function redactText(value: string): string {
	const canonical = canonicalizeRedactionText(value)
	const structured = canonical
		.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#]+/g, (authority) => {
			const schemeEnd = authority.indexOf("//") + 2
			const credentialsEnd = authority.lastIndexOf("@")
			if (credentialsEnd < schemeEnd) return authority
			return `${authority.slice(0, schemeEnd)}${REDACTED}@${authority.slice(credentialsEnd + 1)}`
		})
		.replace(doubleQuotedSecret, `$1"${REDACTED}"`)
		.replace(singleQuotedSecret, `$1'${REDACTED}'`)
		.replace(quotedUnquotedSecret, `$1${REDACTED}`)
	const redacted = secretPatterns.reduce((text, pattern) => text.replace(pattern, REDACTED), structured)
	if (canonical !== value) return redacted === canonical ? value : REDACTED
	return redacted
}

export function redactValue(value: Record<string, JsonValue>): Record<string, JsonValue>
export function redactValue(value: JsonValue[]): JsonValue[]
export function redactValue(value: JsonValue): JsonValue
export function redactValue(value: unknown, seen?: WeakSet<object>): RedactedValue
export function redactValue(value: unknown, seen = new WeakSet<object>()): RedactedValue {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value
	if (value === undefined) return undefined
	if (typeof value === "string") return redactText(value)
	if (typeof value !== "object") return undefined
	if (seen.has(value)) return "[CIRCULAR]"
	seen.add(value)

	let result: RedactedValue
	if (Array.isArray(value)) {
		result = value.map((entry) => redactValue(entry, seen))
	} else {
		const entries: Record<string, RedactedValue> = {}
		for (const [key, entry] of Object.entries(value)) {
			Object.defineProperty(entries, key, {
				value: isSensitiveKey(key) ? REDACTED : redactValue(entry, seen),
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
		result = entries
	}
	seen.delete(value)
	return result
}

export { REDACTED }
