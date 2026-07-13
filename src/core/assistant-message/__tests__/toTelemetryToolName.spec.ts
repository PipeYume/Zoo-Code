// npx vitest run src/core/assistant-message/__tests__/toTelemetryToolName.spec.ts

import { describe, it, expect } from "vitest"
import { toTelemetryToolName } from "../presentAssistantMessage"

describe("toTelemetryToolName", () => {
	it("records a statically known tool name as-is", () => {
		expect(toTelemetryToolName("read_file", false)).toBe("read_file")
	})

	it("records a registered custom tool as the static 'custom_tool' key regardless of its actual name", () => {
		expect(toTelemetryToolName("my_custom_tool", true)).toBe("custom_tool")
	})

	// Regression coverage: isValidToolName() accepts ANY string starting with "mcp_" as a
	// dynamic MCP tool (the "mcp_serverName_toolName" convention), including
	// model-controlled/malicious strings that merely happen to match the prefix. Recording
	// block.name directly would let a crafted tool name become an arbitrary toolsUsed
	// property key -- these must all bucket under the static "use_mcp_tool" key, matching
	// how the dedicated mcp_tool_use block type always records.
	it("records a well-formed dynamic MCP tool name as the static 'use_mcp_tool' key", () => {
		expect(toTelemetryToolName("mcp_myServer_myTool", false)).toBe("use_mcp_tool")
	})

	it("records a malicious mcp_-prefixed name as 'use_mcp_tool', never as the raw string", () => {
		const maliciousName = "mcp_'; DROP TABLE users; --"
		expect(toTelemetryToolName(maliciousName, false)).toBe("use_mcp_tool")
		expect(toTelemetryToolName(maliciousName, false)).not.toBe(maliciousName)
	})

	it("records an unknown/invalid tool name as 'invalid_tool_call'", () => {
		const maliciousName = "'; DROP TABLE users; --"
		expect(toTelemetryToolName(maliciousName, false)).toBe("invalid_tool_call")
	})

	it("prefers the mcp_ prefix bucket over isCustomTool=false unknown-name fallback", () => {
		// Even without experiments/customTools context, an "mcp_" prefix always wins over
		// falling through to "invalid_tool_call", since isValidToolName() treats any such
		// name as valid.
		expect(toTelemetryToolName("mcp_", false)).toBe("use_mcp_tool")
	})
})
