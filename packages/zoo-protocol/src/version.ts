import { z } from "zod"

export const ZOO_HOST_PROTOCOL_VERSION = 1 as const
export const ZOO_PUBLIC_SCHEMA_VERSION = 1 as const

export const zooCapabilities = [
	"task:start",
	"task:resume",
	"task:input",
	"task:cancel",
	"ask:respond",
	"history:list",
	"host:snapshot",
	"host:shutdown",
	"checkpoint:unavailable",
] as const

export const zooCapabilitySchema = z.enum(zooCapabilities)
export type ZooCapability = z.infer<typeof zooCapabilitySchema>

export const hostHelloSchema = z
	.object({
		type: z.literal("hello"),
		hostId: z.string().min(1),
		supportedVersions: z.array(z.number().int().positive()).nonempty(),
		capabilities: z.array(z.string().min(1)),
		buildVersion: z.string().min(1),
	})
	.strict()

export type HostHello = z.infer<typeof hostHelloSchema>

export const parentHelloSchema = z
	.object({
		type: z.literal("hello.select"),
		version: z.number().int().positive(),
		clientVersion: z.string().min(1),
		requiredCapabilities: z.array(zooCapabilitySchema),
	})
	.strict()

export type ParentHello = z.infer<typeof parentHelloSchema>

export type NegotiationResult =
	| { ok: true; version: number }
	| { ok: false; code: "protocol_incompatible"; message: string }

export function negotiateProtocol(
	host: HostHello,
	supportedVersions: readonly number[],
	requiredCapabilities: readonly ZooCapability[],
): NegotiationResult {
	const missing = requiredCapabilities.filter((capability) => !host.capabilities.includes(capability))
	if (missing.length > 0) {
		return {
			ok: false,
			code: "protocol_incompatible",
			message: `Host is missing required capabilities: ${missing.join(", ")}`,
		}
	}

	const version = [...supportedVersions]
		.sort((left, right) => right - left)
		.find((candidate) => host.supportedVersions.includes(candidate))
	return version === undefined
		? { ok: false, code: "protocol_incompatible", message: "No mutually supported host protocol version" }
		: { ok: true, version }
}
