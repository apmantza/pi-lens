/**
 * LSP Integration Tests
 *
 * Tests createLSPClient against a real JSON-RPC fake server over stdio.
 * Validates the full wire protocol: message framing, initialize handshake,
 * request/response round-trips, and shutdown lifecycle.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER_PATH = path.join(
	__dirname,
	"../../fixtures/fake-lsp-server.mjs",
);

describe("LSP Client Integration", () => {
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;

	beforeEach(async () => {
		proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
		});
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				/* ignore */
			}
			client = undefined;
		}
		if (proc) {
			try {
				await stopLSP(proc);
			} catch {
				/* ignore */
			}
			proc = undefined;
		}
	});

	it("initializes and reports connected", () => {
		expect(client).toBeDefined();
		expect(client!.isAlive()).toBe(true);
	});

	it("detects operation capabilities from initialize result", () => {
		const support = client!.getOperationSupport();
		expect(support.definition).toBe(true);
		expect(support.references).toBe(true);
		expect(support.hover).toBe(true);
		expect(support.documentSymbol).toBe(true);
		expect(support.workspaceSymbol).toBe(true);
		expect(support.codeAction).toBe(true);
		expect(support.callHierarchy).toBe(false);
	});

	it("detects pull diagnostics support from object provider", () => {
		const ws = client!.getWorkspaceDiagnosticsSupport();
		expect(ws.advertised).toBe(true);
		expect(ws.mode).toBe("pull");
	});

	it("sends didOpen and tracks the document", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		expect(client!.getDiagnostics(filePath)).toEqual([]);
	});

	it("returns document symbols", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "function greet() {}", "typescript");
		const symbols = await client!.documentSymbol(filePath);
		expect(symbols.length).toBeGreaterThanOrEqual(1);
		expect(symbols[0].name).toBe("greet");
		expect(symbols[0].kind).toBe(12); // Function
	});

	it("strips noisy URL lines from pulled diagnostics", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "oops();", "typescript");
		await client!.waitForDiagnostics(filePath, 1000);

		const diagnostics = client!.getDiagnostics(filePath);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("actual diagnostic");
	});

	it("returns hover info", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "const message = 'hi';", "typescript");
		const hover = await client!.hover(filePath, 0, 6);
		expect(hover).not.toBeNull();
		expect(hover!.contents).toBeDefined();
	});

	it("returns definition location", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		const locations = await client!.definition(filePath, 0, 6);
		expect(locations.length).toBeGreaterThanOrEqual(1);
		expect(locations[0].range).toBeDefined();
	});

	it("returns references", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(
			filePath,
			"const x = 1; console.log(x);",
			"typescript",
		);
		const refs = await client!.references(filePath, 0, 6);
		expect(refs.length).toBeGreaterThanOrEqual(1);
	});

	it("returns workspace symbols", async () => {
		const symbols = await client!.workspaceSymbol("greet");
		expect(symbols.length).toBeGreaterThanOrEqual(1);
	});

	it("resolves lightweight code actions before returning them", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(filePath, "greet();", "typescript");
		const actions = await client!.codeAction(filePath, 0, 0, 0, 5);

		expect(actions).toHaveLength(1);
		expect(actions[0].title).toBe("Replace greeting");
		expect(actions[0].edit).toBeDefined();
	});

	it("finds nested symbol via document symbol children", async () => {
		const filePath = path.join(process.cwd(), "test.ts");
		await client!.notify.open(
			filePath,
			"function greet() { const message = 'hi'; }",
			"typescript",
		);
		const symbols = await client!.documentSymbol(filePath);
		// Fake server returns 'greet' with a child 'message'
		const greet = symbols.find((s) => s.name === "greet");
		expect(greet).toBeDefined();
		expect(greet!.children?.length).toBeGreaterThanOrEqual(1);
		expect(greet!.children![0].name).toBe("message");
	});

	it("advertises executeCommand commands from initialize", () => {
		expect(client!.getAdvertisedCommands().sort()).toEqual([
			"fake.applyEdit",
			"fake.doThing",
		]);
	});

	it("runs an advertised command via executeCommand", async () => {
		const res = await client!.executeCommand("fake.doThing");
		expect(res.executed).toBe(true);
		expect(res.result).toEqual({ ran: "fake.doThing" });
	});

	it("refuses an unadvertised command without sending it", async () => {
		const res = await client!.executeCommand("evil.command");
		expect(res.executed).toBe(false);
		expect(res.reason).toContain("not advertised");
	});

	it("applies a server-initiated edit solicited during executeCommand", async () => {
		const file = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "lsp-exec-")),
			"target.ts",
		);
		fs.writeFileSync(file, "hello world", "utf-8");
		const res = await client!.executeCommand("fake.applyEdit", [
			pathToFileURL(file).href,
		]);
		expect(res.executed).toBe(true);
		expect((res.result as { applied?: boolean }).applied).toBe(true);
		// The gate (serverEditsAllowed) was open during the call, so the edit landed.
		expect(fs.readFileSync(file, "utf-8")).toBe("EDITED world");
	});

	it("shuts down gracefully", async () => {
		expect(client!.isAlive()).toBe(true);
		await client!.shutdown();
		expect(client!.isAlive()).toBe(false);
	});
});

describe("LSP Client Integration — cold start", () => {
	it("rejects when fake server exits immediately", async () => {
		// Pass invalid args to make the process crash on startup
		await expect(
			launchLSP(process.execPath, ["--nonexistent-flag"], {
				cwd: process.cwd(),
			}),
		).rejects.toThrow();
	});

	it("shutdown falls back to process kill when server ignores shutdown", async () => {
		const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_IGNORE_SHUTDOWN: "1" },
		});
		const client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});

		await expect(client.shutdown()).resolves.toBeUndefined();
		expect(client.isAlive()).toBe(false);
	});
});
