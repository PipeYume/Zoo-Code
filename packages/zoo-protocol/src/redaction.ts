const REDACTED = "[REDACTED]" as const
const sensitiveKey = /(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)/i
const sensitiveKeyName = String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)[A-Za-z0-9_-]*`
const doubleQuotedSecret = new RegExp(`("${sensitiveKeyName}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi")
const singleQuotedSecret = new RegExp(`('${sensitiveKeyName}'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, "gi")
const secretPatterns: ReadonlyArray<RegExp> = [
	/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
	new RegExp(`(?<!["'])\\b${sensitiveKeyName}\\s*[:=]\\s*[^\\s,;}]+`, "gi"),
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
	/\b(?:sk|xox[baprs]|gh[opusr])[-_][A-Za-z0-9_-]{8,}\b/g,
	/\b[A-Za-z][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\s*=\s*[^\s]+/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export type RedactedValue = null | boolean | number | string | RedactedValue[] | { [key: string]: RedactedValue }

export function redactText(value: string): string {
	const structured = value
		.replace(doubleQuotedSecret, `$1"${REDACTED}"`)
		.replace(singleQuotedSecret, `$1'${REDACTED}'`)
	return secretPatterns.reduce((redacted, pattern) => redacted.replace(pattern, REDACTED), structured)
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): RedactedValue {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value
	if (typeof value === "string") return redactText(value)
	if (typeof value !== "object") return String(value)
	if (seen.has(value)) return "[CIRCULAR]"
	seen.add(value)

	if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen))

	const result: Record<string, RedactedValue> = {}
	for (const [key, entry] of Object.entries(value)) {
		result[key] = sensitiveKey.test(key) ? REDACTED : redactValue(entry, seen)
	}
	return result
}

export { REDACTED }
