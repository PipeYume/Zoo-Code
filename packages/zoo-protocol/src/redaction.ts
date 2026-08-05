const REDACTED = "[REDACTED]" as const
const sensitiveKey = /(?:api[-_ ]?key|authorization|cookie|credential|password|private[-_ ]?key|secret|token)/i
const sensitiveKeyName = String.raw`[A-Za-z0-9_.-]*(?:api[-_ ]?key|authorization|cookie|credential|password|private[-_ ]?key|secret|token)[A-Za-z0-9_.-]*`
const secretValue = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)`
const cliSecretValue = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;}]+)`
const doubleQuotedSecret = new RegExp(`("${sensitiveKeyName}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi")
const singleQuotedSecret = new RegExp(`('${sensitiveKeyName}'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, "gi")
const quotedUnquotedSecret = new RegExp(
	`((?:"${sensitiveKeyName}"|'${sensitiveKeyName}')\\s*:\\s*)(?!["'])[^\\s,;}]+`,
	"gi",
)
const secretPatterns: ReadonlyArray<RegExp> = [
	/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
	new RegExp(`--${sensitiveKeyName}(?:\\s*=\\s*|\\s+)${cliSecretValue}`, "gi"),
	new RegExp(`(?<!["'])\\b${sensitiveKeyName}\\s*[:=]\\s*${secretValue}`, "gi"),
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
	/\b(?:sk|xox[baprs]|gh[opusr])[-_][A-Za-z0-9_-]{8,}\b/g,
	/\b[A-Za-z][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\s*=\s*[^\s]+/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export type RedactedValue = null | undefined | boolean | number | string | RedactedValue[] | { [key: string]: RedactedValue }

export function redactText(value: string): string {
	const structured = value
		.replace(/\bhttps?:\/\/[^\s/?#]+/gi, (authority) => {
			const schemeEnd = authority.indexOf("//") + 2
			const credentialsEnd = authority.lastIndexOf("@")
			if (credentialsEnd < schemeEnd || !authority.slice(schemeEnd, credentialsEnd).includes(":")) return authority
			return `${authority.slice(0, schemeEnd)}${REDACTED}@${authority.slice(credentialsEnd + 1)}`
		})
		.replace(doubleQuotedSecret, `$1"${REDACTED}"`)
		.replace(singleQuotedSecret, `$1'${REDACTED}'`)
		.replace(quotedUnquotedSecret, `$1${REDACTED}`)
	return secretPatterns.reduce((redacted, pattern) => redacted.replace(pattern, REDACTED), structured)
}

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
			entries[key] = sensitiveKey.test(key) ? REDACTED : redactValue(entry, seen)
		}
		result = entries
	}
	seen.delete(value)
	return result
}

export { REDACTED }
