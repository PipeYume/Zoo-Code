import { z } from "zod"

export const zooOutcomeSchema = z.enum(["completed", "needs_input", "cancelled", "timed_out", "failed"])
export type ZooOutcome = z.infer<typeof zooOutcomeSchema>

export const zooErrorCodes = [
	"invalid_usage",
	"invalid_workspace",
	"invalid_provider",
	"invalid_profile",
	"invalid_model",
	"invalid_mode",
	"invalid_session",
	"credentials_missing",
	"permission_required",
	"permission_denied",
	"outside_workspace",
	"protected_path",
	"provider_failed",
	"task_failed",
	"host_start_failed",
	"host_crashed",
	"protocol_incompatible",
	"protocol_gap",
	"cancel_failed",
	"cleanup_timed_out",
	"task_timed_out",
	"output_closed",
] as const

export const zooErrorCodeSchema = z.enum(zooErrorCodes)
export type ZooErrorCode = z.infer<typeof zooErrorCodeSchema>

export const zooErrorKindSchema = z.enum(["configuration", "provider", "runtime"])
export type ZooErrorKind = z.infer<typeof zooErrorKindSchema>

export const zooErrorSchema = z
	.object({
		code: zooErrorCodeSchema,
		message: z.string().min(1),
		kind: zooErrorKindSchema.optional(),
		phase: z.string().min(1).optional(),
	})
	.strict()

export type ZooError = z.infer<typeof zooErrorSchema>

export const EXIT_CODES = {
	completed: 0,
	usage: 2,
	needsInput: 3,
	cancelled: 4,
	providerFailure: 10,
	runtimeFailure: 70,
	timedOut: 124,
	sigint: 130,
	sigterm: 143,
} as const

const usageErrors = new Set<ZooErrorCode>([
	"invalid_usage",
	"invalid_workspace",
	"invalid_provider",
	"invalid_profile",
	"invalid_model",
	"invalid_mode",
	"invalid_session",
	"credentials_missing",
])

export type ExitContext = {
	outcome: ZooOutcome
	errorCode?: ZooErrorCode
	signal?: "SIGINT" | "SIGTERM"
}

export function exitCodeFor({ outcome, errorCode, signal }: ExitContext): number {
	if (signal === "SIGINT") return EXIT_CODES.sigint
	if (signal === "SIGTERM") return EXIT_CODES.sigterm
	if (errorCode && usageErrors.has(errorCode)) return EXIT_CODES.usage
	if (outcome === "completed") return EXIT_CODES.completed
	if (outcome === "needs_input") return EXIT_CODES.needsInput
	if (outcome === "cancelled") return EXIT_CODES.cancelled
	if (outcome === "timed_out") return EXIT_CODES.timedOut
	if (errorCode === "provider_failed") return EXIT_CODES.providerFailure
	return EXIT_CODES.runtimeFailure
}
