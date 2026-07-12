import * as http2 from "http2"
import * as net from "net"
import { crc32 } from "zlib"

export interface BedrockMockServer {
	url: string
	/** Headers from the most recent converse-stream request (populated after first call). */
	lastRequestHeaders: http2.IncomingHttpHeaders | undefined
	/** Parsed JSON bodies of every converse-stream request received so far, oldest first. */
	requestBodies: unknown[]
	close(): Promise<void>
}

// AWS binary event stream encoder — matches the real Bedrock wire format.
// Derived from the live converse-stream capture:
//   { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "..." } } } }
// aimock's builder nests the payload one level too deep (contentBlockDelta inside contentBlockDelta),
// causing the AWS SDK deserializer's take() to miss the delta field entirely.
function encodeHeaders(headers: Record<string, string>): Buffer {
	const parts: Buffer[] = []
	for (const [name, value] of Object.entries(headers)) {
		const nameBytes = Buffer.from(name, "utf8")
		const valueBytes = Buffer.from(value, "utf8")
		const buf = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length)
		let off = 0
		buf.writeUInt8(nameBytes.length, off)
		off += 1
		nameBytes.copy(buf, off)
		off += nameBytes.length
		buf.writeUInt8(7, off)
		off += 1 // type 7 = string
		buf.writeUInt16BE(valueBytes.length, off)
		off += 2
		valueBytes.copy(buf, off)
		parts.push(buf)
	}
	return Buffer.concat(parts)
}

function encodeFrame(eventType: string, payload: object): Buffer {
	const hdrs = encodeHeaders({
		":content-type": "application/json",
		":event-type": eventType,
		":message-type": "event",
	})
	const body = Buffer.from(JSON.stringify(payload), "utf8")
	const total = 12 + hdrs.length + body.length + 4
	const frame = Buffer.alloc(total)
	let off = 0
	frame.writeUInt32BE(total, off)
	off += 4
	frame.writeUInt32BE(hdrs.length, off)
	off += 4
	frame.writeUInt32BE(crc32(frame.subarray(0, 8)) >>> 0, off)
	off += 4
	hdrs.copy(frame, off)
	off += hdrs.length
	body.copy(frame, off)
	off += body.length
	frame.writeUInt32BE(crc32(frame.subarray(0, total - 4)) >>> 0, off)
	return frame
}

export function buildToolCallFrames(toolName: string, toolUseId: string, argsJson: string): Buffer[] {
	const frames: Buffer[] = []
	frames.push(encodeFrame("messageStart", { role: "assistant" }))
	frames.push(
		encodeFrame("contentBlockStart", {
			contentBlockIndex: 0,
			start: { toolUse: { name: toolName, toolUseId } },
		}),
	)
	const CHUNK = 20
	for (let i = 0; i < argsJson.length; i += CHUNK) {
		frames.push(
			encodeFrame("contentBlockDelta", {
				contentBlockIndex: 0,
				delta: { toolUse: { input: argsJson.slice(i, i + CHUNK) } },
			}),
		)
	}
	frames.push(encodeFrame("contentBlockStop", { contentBlockIndex: 0 }))
	frames.push(encodeFrame("messageStop", { stopReason: "tool_use" }))
	frames.push(
		encodeFrame("metadata", {
			metrics: { latencyMs: 1 },
			usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, serverToolUsage: {} },
		}),
	)
	return frames
}

// A response with no content blocks at all -- no text, no tool_use. Exercises the
// "no assistant messages" retry path (Task#recursivelyMakeClineRequests), which is
// otherwise unreachable from a real model (a real model asked to return nothing
// still typically returns some text) and untestable at the unit level without
// deeply mocking the streaming loop.
export function buildEmptyResponseFrames(): Buffer[] {
	const frames: Buffer[] = []
	frames.push(encodeFrame("messageStart", { role: "assistant" }))
	frames.push(encodeFrame("messageStop", { stopReason: "end_turn" }))
	frames.push(
		encodeFrame("metadata", {
			metrics: { latencyMs: 1 },
			usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100, serverToolUsage: {} },
		}),
	)
	return frames
}

export interface BedrockMockServerOptions {
	/**
	 * Frame sequences to serve, one per converse-stream request, in order. The last
	 * entry repeats for any request beyond the queue's length. Defaults to always
	 * returning the attempt_completion("4") tool call (the pre-existing behavior).
	 */
	responses?: Buffer[][]
}

export async function startBedrockMockServer(options: BedrockMockServerOptions = {}): Promise<BedrockMockServer> {
	const responses = options.responses ?? [
		buildToolCallFrames("attempt_completion", "tooluse_bedrock_mock_001", JSON.stringify({ result: "4" })),
	]
	let requestCount = 0
	const requestBodies: unknown[] = []

	// HTTP/2 cleartext (h2c) — matches what @aws-sdk/client-bedrock-runtime uses by default.
	const server = http2.createServer()
	let lastRequestHeaders: http2.IncomingHttpHeaders | undefined
	const sessions = new Set<http2.ServerHttp2Session>()

	server.on("session", (session) => {
		sessions.add(session)
		session.on("close", () => sessions.delete(session))
	})

	server.on("stream", (stream, headers) => {
		const path = headers[":path"] as string
		const method = headers[":method"] as string

		if (!path?.includes("converse-stream") || method !== "POST") {
			stream.respond({ ":status": 404 })
			stream.end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }))
			return
		}

		lastRequestHeaders = headers

		// Capture the request body (AWS SDK sends the full request before reading the response).
		const bodyChunks: Buffer[] = []
		stream.on("data", (chunk: Buffer) => bodyChunks.push(chunk))
		stream.on("end", () => {
			try {
				requestBodies.push(JSON.parse(Buffer.concat(bodyChunks).toString("utf8")))
			} catch {
				requestBodies.push(undefined)
			}

			stream.respond({
				":status": 200,
				"content-type": "application/vnd.amazon.eventstream",
			})
			const frames = responses[Math.min(requestCount, responses.length - 1)] ?? []
			requestCount++
			for (const frame of frames) {
				stream.write(frame)
			}
			stream.end()
		})
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const addr = server.address() as net.AddressInfo
	const url = `http://127.0.0.1:${addr.port}`

	return {
		url,
		get lastRequestHeaders() {
			return lastRequestHeaders
		},
		get requestBodies() {
			return requestBodies
		},
		close: () => {
			// Destroy all open HTTP/2 sessions first so server.close() resolves immediately
			// instead of waiting for the extension's retry loop to exhaust itself.
			for (const session of sessions) {
				session.destroy()
			}
			sessions.clear()
			return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
		},
	}
}
