import type { Anthropic } from "@anthropic-ai/sdk"

import { moonshotDefaultModelId } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"

import { MoonshotHandler } from "../moonshot"

describe("MoonshotHandler", () => {
	let handler: MoonshotHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			moonshotApiKey: "test-api-key",
			apiModelId: "kimi-k2-0905-preview",
			moonshotBaseUrl: "https://api.moonshot.ai/v1",
		}
		handler = new MoonshotHandler(mockOptions)
		vi.clearAllMocks()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(MoonshotHandler)
			expect(handler.getModel().id).toBe(mockOptions.apiModelId)
		})

		it("should use default model ID if not provided", () => {
			const handlerWithoutModel = new MoonshotHandler({
				...mockOptions,
				apiModelId: undefined,
			})
			expect(handlerWithoutModel.getModel().id).toBe(moonshotDefaultModelId)
		})

		it("should use default base URL if not provided", () => {
			const handlerWithoutBaseUrl = new MoonshotHandler({
				...mockOptions,
				moonshotBaseUrl: undefined,
			})
			expect(handlerWithoutBaseUrl).toBeInstanceOf(MoonshotHandler)
		})

		it("should use chinese base URL if provided", () => {
			const customBaseUrl = "https://api.moonshot.cn/v1"
			const handlerWithCustomUrl = new MoonshotHandler({
				...mockOptions,
				moonshotBaseUrl: customBaseUrl,
			})
			expect(handlerWithCustomUrl).toBeInstanceOf(MoonshotHandler)
		})
	})

	describe("getModel", () => {
		it("returns Kimi K3 catalog metadata without changing the default model", () => {
			const k3Handler = new MoonshotHandler({ ...mockOptions, apiModelId: "kimi-k3" })

			expect(moonshotDefaultModelId).not.toBe("kimi-k3")
			expect(k3Handler.getModel().info).toMatchObject({
				maxTokens: 131_072,
				contextWindow: 1_048_576,
				supportsImages: true,
				supportsPromptCache: true,
				supportsMaxTokens: true,
				supportsReasoningEffort: ["max"],
				requiredReasoningEffort: true,
				reasoningEffort: "max",
				preserveReasoning: true,
				supportsTemperature: false,
				inputPrice: 3,
				outputPrice: 15,
				cacheReadsPrice: 0.3,
			})
			expect("cacheWritesPrice" in k3Handler.getModel().info).toBe(false)
		})

		it("should return model info for valid model ID", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mockOptions.apiModelId)
			expect(model.info).toBeDefined()
			expect(model.info.maxTokens).toBe(16384)
			expect(model.info.contextWindow).toBe(262144)
			expect(model.info.supportsImages).toBe(false)
			expect(model.info.supportsPromptCache).toBe(true)
		})

		it("should return provided model ID with default model info if model does not exist", () => {
			const handlerWithInvalidModel = new MoonshotHandler({
				...mockOptions,
				apiModelId: "invalid-model",
			})
			const model = handlerWithInvalidModel.getModel()
			expect(model.id).toBe("invalid-model") // Returns provided ID
			expect(model.info).toBeDefined()
			// Should have the same structural properties as default model
			expect(model.info.contextWindow).toBe(handler.getModel().info.contextWindow)
			expect(model.info.supportsPromptCache).toBe(true)
			// Unknown models should not send a guessed maxTokens to the API
			expect(model.info.maxTokens).toBeUndefined()
			// Pricing should be unknown for unrecognized models
			expect(model.info.inputPrice).toBeUndefined()
			expect(model.info.outputPrice).toBeUndefined()
			expect(model.info.cacheReadsPrice).toBeUndefined()
			expect(model.info.cacheWritesPrice).toBeUndefined()
		})

		it("should return default model if no model ID is provided", () => {
			const handlerWithoutModel = new MoonshotHandler({
				...mockOptions,
				apiModelId: undefined,
			})
			const model = handlerWithoutModel.getModel()
			expect(model.id).toBe(moonshotDefaultModelId)
			expect(model.info).toBeDefined()
			expect(model.info.supportsPromptCache).toBe(true)
		})

		it("should include model parameters from getModelParams", () => {
			const model = handler.getModel()
			expect(model).toHaveProperty("temperature")
			expect(model).toHaveProperty("maxTokens")
		})
	})

	describe("createMessage", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text" as const,
						text: "Hello!",
					},
				],
			},
		]

		it("should handle streaming responses", async () => {
			async function* mockStream() {
				yield {
					choices: [{ delta: { content: "Test response" }, finish_reason: null }],
					usage: null,
				}
			}

			const mockClient = {
				chat: {
					completions: {
						create: vi.fn().mockResolvedValue(mockStream()),
					},
				},
			}

			;(handler as any).client = mockClient

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("omits temperature and sends required max reasoning for Kimi K3", async () => {
			async function* mockStream() {
				yield {
					choices: [{ delta: { content: "K3 response" }, finish_reason: null }],
					usage: null,
				}
			}

			const mockClient = {
				chat: {
					completions: {
						create: vi.fn().mockResolvedValue(mockStream()),
					},
				},
			}

			const k3Handler = new MoonshotHandler({
				...mockOptions,
				apiModelId: "kimi-k3",
				modelTemperature: 0.9,
				reasoningEffort: "disable",
				enableReasoningEffort: false,
			})
			;(k3Handler as any).client = mockClient

			for await (const _chunk of k3Handler.createMessage(systemPrompt, messages)) {
				void _chunk
			}

			const [requestOptions] = mockClient.chat.completions.create.mock.calls[0]
			expect(requestOptions).toMatchObject({
				model: "kimi-k3",
				reasoning_effort: "max",
				max_tokens: 131_072,
			})
			expect(requestOptions).not.toHaveProperty("temperature")
		})

		it("sends required max reasoning for Kimi K3 when streaming is disabled", async () => {
			const mockClient = {
				chat: {
					completions: {
						create: vi.fn().mockResolvedValue({
							choices: [{ message: { content: "K3 response" } }],
							usage: { prompt_tokens: 1, completion_tokens: 1 },
						}),
					},
				},
			}

			const k3Handler = new MoonshotHandler({
				...mockOptions,
				apiModelId: "kimi-k3",
				modelTemperature: 0.9,
				reasoningEffort: "disable",
				enableReasoningEffort: false,
				openAiStreamingEnabled: false,
			})
			;(k3Handler as any).client = mockClient

			for await (const _chunk of k3Handler.createMessage(systemPrompt, messages)) {
				void _chunk
			}

			const [requestOptions] = mockClient.chat.completions.create.mock.calls[0]
			expect(requestOptions).toMatchObject({
				model: "kimi-k3",
				reasoning_effort: "max",
				max_tokens: 131_072,
			})
			expect(requestOptions).not.toHaveProperty("temperature")
		})

		it("serializes retained Kimi K3 reasoning through the installed OpenAI SDK", async () => {
			let requestBody: Record<string, any> | undefined
			const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body))
				return new Response(
					'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\ndata: [DONE]\n\n',
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)
			})
			vi.stubGlobal("fetch", fetchMock)

			try {
				const k3Handler = new MoonshotHandler({
					apiModelId: "kimi-k3",
					moonshotApiKey: "test-key",
					moonshotBaseUrl: "https://api.moonshot.ai/v1",
					modelTemperature: 0.9,
				})
				const retainedMessages = [
					{ role: "user", content: "Inspect the file" },
					{
						role: "assistant",
						content: [
							{ type: "reasoning", text: "I need the file contents first." },
							{ type: "tool_use", id: "call_123", name: "read_file", input: { path: "a.ts" } },
						],
					},
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "call_123", content: "export const a = 1" }],
					},
				] as Anthropic.Messages.MessageParam[]

				for await (const _chunk of k3Handler.createMessage("system", retainedMessages)) {
					void _chunk
				}

				expect(requestBody).toMatchObject({
					model: "kimi-k3",
					reasoning_effort: "max",
					max_tokens: 131_072,
					messages: [
						{ role: "system", content: "system" },
						{ role: "user", content: "Inspect the file" },
						{
							role: "assistant",
							content: "",
							reasoning_content: "I need the file contents first.",
							tool_calls: [
								{
									id: "call_123",
									type: "function",
									function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
								},
							],
						},
						{ role: "tool", tool_call_id: "call_123", content: "export const a = 1" },
					],
				})
				expect(requestBody).not.toHaveProperty("temperature")
				expect(fetchMock).toHaveBeenCalledOnce()
			} finally {
				vi.unstubAllGlobals()
			}
		})

		it("should include usage information", async () => {
			async function* mockStream() {
				yield {
					choices: [{ delta: { content: "Test response" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 5 },
				}
			}

			const mockClient = {
				chat: {
					completions: {
						create: vi.fn().mockResolvedValue(mockStream()),
					},
				},
			}

			;(handler as any).client = mockClient

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks.length).toBeGreaterThan(0)
			expect(usageChunks[0].inputTokens).toBe(10)
			expect(usageChunks[0].outputTokens).toBe(5)
		})

		it("should include cache metrics in usage information", async () => {
			async function* mockStream() {
				yield {
					choices: [{ delta: { content: "Test response" }, finish_reason: "stop" }],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 5,
						prompt_tokens_details: { cached_tokens: 2 },
					},
				}
			}

			const mockClient = {
				chat: {
					completions: {
						create: vi.fn().mockResolvedValue(mockStream()),
					},
				},
			}

			;(handler as any).client = mockClient

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks.length).toBeGreaterThan(0)
			expect(usageChunks[0].cacheWriteTokens).toBe(0)
			expect(usageChunks[0].cacheReadTokens).toBe(2)
		})
	})

	describe("completePrompt", () => {
		it("should complete a prompt using the OpenAI client", async () => {
			const mockClient = {
				chat: {
					completions: {
						create: vi.fn().mockResolvedValue({
							choices: [{ message: { content: "Test completion" } }],
						}),
					},
				},
			}

			;(handler as any).client = mockClient

			const result = await handler.completePrompt("Test prompt")

			expect(result).toBe("Test completion")
			expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockOptions.apiModelId,
					messages: [{ role: "user", content: "Test prompt" }],
				}),
				{},
			)
		})

		it("omits temperature and sends required max reasoning for Kimi K3", async () => {
			const mockClient = {
				chat: {
					completions: {
						create: vi.fn().mockResolvedValue({
							choices: [{ message: { content: "K3 completion" } }],
						}),
					},
				},
			}

			const k3Handler = new MoonshotHandler({
				...mockOptions,
				apiModelId: "kimi-k3",
				modelTemperature: 0.9,
				reasoningEffort: "disable",
				enableReasoningEffort: false,
			})
			;(k3Handler as any).client = mockClient

			const result = await k3Handler.completePrompt("Test prompt")

			expect(result).toBe("K3 completion")
			const [requestOptions] = mockClient.chat.completions.create.mock.calls[0]
			expect(requestOptions).toMatchObject({
				model: "kimi-k3",
				reasoning_effort: "max",
				max_tokens: 131_072,
			})
			expect(requestOptions).not.toHaveProperty("temperature")
		})
	})

	describe("processUsageMetrics", () => {
		it("should correctly process usage metrics including cache information", () => {
			class TestMoonshotHandler extends MoonshotHandler {
				public testProcessUsageMetrics(usage: any) {
					return this.processUsageMetrics(usage)
				}
			}

			const testHandler = new TestMoonshotHandler(mockOptions)

			const usage = {
				prompt_tokens: 100,
				completion_tokens: 50,
				prompt_tokens_details: {
					cached_tokens: 20,
				},
			}

			const result = testHandler.testProcessUsageMetrics(usage)

			expect(result.type).toBe("usage")
			expect(result.inputTokens).toBe(100)
			expect(result.outputTokens).toBe(50)
			expect(result.cacheWriteTokens).toBe(0)
			expect(result.cacheReadTokens).toBe(20)
		})

		it("should handle missing cache metrics gracefully", () => {
			class TestMoonshotHandler extends MoonshotHandler {
				public testProcessUsageMetrics(usage: any) {
					return this.processUsageMetrics(usage)
				}
			}

			const testHandler = new TestMoonshotHandler(mockOptions)

			const usage = {
				prompt_tokens: 100,
				completion_tokens: 50,
			}

			const result = testHandler.testProcessUsageMetrics(usage)

			expect(result.type).toBe("usage")
			expect(result.inputTokens).toBe(100)
			expect(result.outputTokens).toBe(50)
			expect(result.cacheWriteTokens).toBe(0)
			expect(result.cacheReadTokens).toBeUndefined()
		})

		it("should handle cached_tokens at top level (not in prompt_tokens_details)", () => {
			class TestMoonshotHandler extends MoonshotHandler {
				public testProcessUsageMetrics(usage: any) {
					return this.processUsageMetrics(usage)
				}
			}

			const testHandler = new TestMoonshotHandler(mockOptions)

			const usage = {
				prompt_tokens: 100,
				completion_tokens: 50,
				cached_tokens: 15,
			}

			const result = testHandler.testProcessUsageMetrics(usage)

			expect(result.cacheReadTokens).toBe(15)
		})

		it("should handle null usage gracefully", () => {
			class TestMoonshotHandler extends MoonshotHandler {
				public testProcessUsageMetrics(usage: any) {
					return this.processUsageMetrics(usage)
				}
			}

			const testHandler = new TestMoonshotHandler(mockOptions)

			const result = testHandler.testProcessUsageMetrics(null)

			expect(result.inputTokens).toBe(0)
			expect(result.outputTokens).toBe(0)
			expect(result.cacheReadTokens).toBeUndefined()
		})
	})

	describe("addMaxTokensIfNeeded", () => {
		it("should use max_tokens (not max_completion_tokens) for Moonshot", () => {
			class TestMoonshotHandler extends MoonshotHandler {
				public testAddMaxTokensIfNeeded(requestOptions: any, modelInfo: any) {
					return this.addMaxTokensIfNeeded(requestOptions, modelInfo)
				}
			}

			const testHandler = new TestMoonshotHandler(mockOptions)
			const requestOptions: any = {}
			testHandler.testAddMaxTokensIfNeeded(requestOptions, handler.getModel().info)

			expect(requestOptions.max_tokens).toBe(16384)
			expect(requestOptions.max_completion_tokens).toBeUndefined()
		})

		it("should use modelMaxTokens override when provided", () => {
			class TestMoonshotHandler extends MoonshotHandler {
				public testAddMaxTokensIfNeeded(requestOptions: any, modelInfo: any) {
					return this.addMaxTokensIfNeeded(requestOptions, modelInfo)
				}
			}

			const customMaxTokens = 5000
			const testHandler = new TestMoonshotHandler({
				...mockOptions,
				modelMaxTokens: customMaxTokens,
			})
			const requestOptions: any = {}
			testHandler.testAddMaxTokensIfNeeded(requestOptions, handler.getModel().info)

			expect(requestOptions.max_tokens).toBe(customMaxTokens)
		})

		it("should not send maxTokens for unknown model IDs", () => {
			class TestMoonshotHandler extends MoonshotHandler {
				public testAddMaxTokensIfNeeded(requestOptions: any, modelInfo: any) {
					return this.addMaxTokensIfNeeded(requestOptions, modelInfo)
				}
			}

			const testHandler = new TestMoonshotHandler({
				...mockOptions,
				apiModelId: "future-moonshot-model",
			})
			const requestOptions: any = {}
			testHandler.testAddMaxTokensIfNeeded(requestOptions, testHandler.getModel().info)

			expect(requestOptions.max_tokens).toBeUndefined()
		})
	})

	describe("tool handling", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "text" as const, text: "Hello!" }],
			},
		]

		it("should handle tool calls in streaming", async () => {
			async function* mockStream() {
				yield {
					choices: [
						{
							delta: {
								content: null,
								tool_calls: [
									{
										index: 0,
										id: "tool-call-1",
										function: {
											name: "read_file",
											arguments: '{"path":"test.ts"}',
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
					usage: null,
				}
			}

			const mockClient = {
				chat: {
					completions: {
						create: vi.fn().mockResolvedValue(mockStream()),
					},
				},
			}

			;(handler as any).client = mockClient

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				tools: [
					{
						type: "function",
						function: {
							name: "read_file",
							description: "Read a file",
							parameters: {
								type: "object",
								properties: { path: { type: "string" } },
								required: ["path"],
							},
						},
					},
				],
			})

			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const partialChunks = chunks.filter((c) => c.type === "tool_call_partial")
			const endChunks = chunks.filter((c) => c.type === "tool_call_end")

			expect(partialChunks.length).toBe(1)
			expect(partialChunks[0].id).toBe("tool-call-1")
			expect(partialChunks[0].name).toBe("read_file")
			expect(partialChunks[0].arguments).toBe('{"path":"test.ts"}')

			expect(endChunks.length).toBe(1)
			expect(endChunks[0].id).toBe("tool-call-1")
		})
	})
})
