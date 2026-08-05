import { describe, expect, it, vi } from "vitest"

import { HostCommandDispatcher } from "../dispatcher.js"
import { validateHostRoots } from "../roots.js"
import { VaultSecretStorage, type VaultBackend } from "../security.js"
import { HostTransport } from "../transport.js"

describe("host security and transport", () => {
	it("requires explicit absolute roots", () => {
		expect(() =>
			validateHostRoots({
				extensionRoot: "relative",
				workspaceRoot: "/workspace",
				storageRoot: "/storage",
				appRoot: "/app",
			}),
		).toThrow("extensionRoot")
		expect(
			validateHostRoots({
				extensionRoot: "/extension",
				workspaceRoot: "/workspace",
				storageRoot: "/storage",
				appRoot: "/app",
			}),
		).toEqual({
			extensionRoot: "/extension",
			workspaceRoot: "/workspace",
			storageRoot: "/storage",
			appRoot: "/app",
		})
	})

	it("round trips secrets only through the injected vault", async () => {
		const values = new Map<string, string>()
		const backend: VaultBackend = {
			get: vi.fn(async (key) => values.get(key)),
			store: vi.fn(async (key, value) => void values.set(key, value)),
			delete: vi.fn(async (key) => void values.delete(key)),
		}
		const storage = new VaultSecretStorage(backend)
		const changes: string[] = []
		storage.onDidChange(({ key }) => changes.push(key))
		await storage.store("api-key", "secret")
		await expect(storage.get("api-key")).resolves.toBe("secret")
		await storage.delete("api-key")
		expect(changes).toEqual(["api-key", "api-key"])
		expect(backend.store).toHaveBeenCalledWith("api-key", "secret")
	})

	it("uses one monotonic sequence for ACK and DONE", async () => {
		const sent: unknown[] = []
		const transport = new HostTransport("host-1", async (message) => void sent.push(message))
		const api = {
			startHeadlessTask: vi.fn().mockResolvedValue({ taskId: "root", rootTaskId: "root" }),
		} as never
		const dispatcher = new HostCommandDispatcher(api, transport, "/workspace")
		await dispatcher.dispatch({ v: 1, id: "cmd-1", type: "task.start", workspace: "/workspace", prompt: "hello" })
		expect(sent).toMatchObject([
			{ seq: 1, type: "command.ack", commandId: "cmd-1" },
			{ seq: 2, type: "command.done", commandId: "cmd-1", data: { commandType: "task.start" } },
		])
	})

	it("rejects workspace identity changes after ACK", async () => {
		const sent: unknown[] = []
		const transport = new HostTransport("host-1", async (message) => void sent.push(message))
		const dispatcher = new HostCommandDispatcher({} as never, transport, "/workspace")
		await dispatcher.dispatch({ v: 1, id: "cmd-1", type: "task.start", workspace: "/other", prompt: "hello" })
		expect(sent).toMatchObject([
			{ seq: 1, type: "command.ack" },
			{ seq: 2, type: "command.error", error: { code: "task_failed" } },
		])
	})
})
