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
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// SHUTDOWN_REQUEST_TIMEOUT_MS is read at MODULE LOAD in client.ts, so the env
// override must land before the static import below evaluates — vi.hoisted
// runs this ahead of every import in the file. Shrinks the "cold start
// shutdown falls back to process kill" test's real wait for a server that
// never replies to the shutdown request; that fake server's ignore branch
// never replies either way, so there's no race and the assertions are
// magnitude-independent.
vi.hoisted(() => {
	process.env.PI_LENS_LSP_SHUTDOWN_TIMEOUT_MS = "150";
});
import { createLSPClient } from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";
import { CacheManager } from "../../../clients/cache-manager.js";
import { getDegradationSummary } from "../../../clients/degradation-ledger.js";
import { registerMutationBridge } from "../../../clients/mutation-bridge.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { readChangesSince } from "../../../clients/project-changes.js";
import { countFileLines } from "../../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { isRecordableProjectPath } from "../../../clients/file-utils.js";

describe("LSP Client Integration", () => {
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;

	beforeEach(async () => {
		proc = await spawnFakeLspServer({
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

	it("detects operation capabilities from initialize result", () => {
		const support = client!.getOperationSupport();
		expect(support.definition).toBe(true);
		expect(support.references).toBe(true);
		expect(support.hover).toBe(true);
		expect(support.documentSymbol).toBe(true);
		expect(support.workspaceSymbol).toBe(true);
		expect(support.codeAction).toBe(true);
		expect(support.codeActionResolve).toBe(true);
		expect(support.willRenameFiles).toBe(false);
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
			"fake.applyEditDeferred",
			"fake.doThing",
			"fake.releaseDeferredApplyEdit",
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
			process.cwd(),
			`.lsp-exec-${process.pid}-${Date.now()}.ts`,
		);
		fs.writeFileSync(file, "hello world", "utf-8");
		try {
			const res = await client!.executeCommand("fake.applyEdit", [
				pathToFileURL(file).href,
			]);
			expect(res.executed).toBe(true);
			expect((res.result as { applied?: boolean }).applied).toBe(true);
			// The gate (serverEditsAllowed) was open during the call, so the edit landed.
			expect(fs.readFileSync(file, "utf-8")).toBe("EDITED world");
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("shuts down gracefully", async () => {
		expect(client!.isAlive()).toBe(true);
		await client!.shutdown();
		expect(client!.isAlive()).toBe(false);
	});
});

describe("LSP Client Integration — nested capability gates (#1971)", () => {
	const capabilityCases = [
		{ name: "absent", env: {}, supported: false },
		{ name: "false", env: { FAKE_LSP_WILL_RENAME: "false" }, supported: false },
		{
			name: "malformed",
			env: { FAKE_LSP_WILL_RENAME: "malformed" },
			supported: false,
		},
		{
			name: "object without filters",
			env: { FAKE_LSP_WILL_RENAME: "empty-object" },
			supported: false,
		},
		{ name: "present", env: { FAKE_LSP_WILL_RENAME: "true" }, supported: true },
	] as const;

	it.each(capabilityCases)(
		"sends workspace/willRenameFiles only when nested capability is $name",
		async ({ env, supported }) => {
			const proc = await spawnFakeLspServer({
				cwd: process.cwd(),
				env: {
					...process.env,
					...env,
					FAKE_LSP_ECHO_REQUEST_METHODS: "1",
				},
			});
			const client = await createLSPClient({
				serverId: "fake-rename-capability",
				process: proc,
				root: process.cwd(),
			});
			const received: string[] = [];
			client.connection.onNotification(
				"$/test/requestReceived",
				(params: { method: string }) => {
					received.push(params.method);
				},
			);
			try {
				const result = await client.willRenameFiles(
					path.join(process.cwd(), "old.ts"),
					path.join(process.cwd(), "new.ts"),
				);
				await new Promise((resolve) => setImmediate(resolve));
				expect(client.getOperationSupport().willRenameFiles).toBe(supported);
				expect(result).toBeNull();
				expect(received).toEqual(
					supported ? ["workspace/willRenameFiles"] : [],
				);
			} finally {
				await client.shutdown();
				await stopLSP(proc);
			}
		},
	);

	it("sends didRenameFiles only when didRename is registered and filters match", async () => {
		const cases: Array<{
			name: string;
			env: Record<string, string>;
			sent: boolean;
		}> = [
			{
				name: "not registered",
				env: {},
				sent: false,
			},
			{
				name: "registered with matching glob",
				env: { FAKE_LSP_DID_RENAME: "true" },
				sent: true,
			},
			{
				name: "registered but glob excludes the paths",
				env: {
					FAKE_LSP_DID_RENAME: "true",
					FAKE_LSP_DID_RENAME_GLOB: "**/*.go",
				},
				sent: false,
			},
		];

		for (const { name, env, sent } of cases) {
			const proc = await spawnFakeLspServer({
				cwd: process.cwd(),
				env: {
					...process.env,
					...env,
					FAKE_LSP_WILL_RENAME: "true",
					FAKE_LSP_ECHO_NOTIFY_METHODS: "1",
				},
			});
			const client = await createLSPClient({
				serverId: "fake-did-rename-capability",
				process: proc,
				root: process.cwd(),
			});
			const notified: string[] = [];
			client.connection.onNotification(
				"$/test/notifyReceived",
				(params: { method: string }) => {
					notified.push(params.method);
				},
			);
			try {
				await client.notify.open(
					path.join(process.cwd(), "doc.ts"),
					"greet();",
					"typescript",
				);
				notified.length = 0;
				await client.didRenameFiles(
					path.join(process.cwd(), "old.ts"),
					path.join(process.cwd(), "new.ts"),
				);
				// A notification has no awaitable reply, so the echo's stdio
				// round-trip needs several event-loop turns — a single
				// setImmediate yield cannot cover it. Poll until the echo
				// arrives; for the negative cases, give the pipe a bounded
				// grace window before asserting nothing was sent.
				const graceMs = sent ? 5000 : 500;
				for (
					let i = 0;
					i < graceMs / 25 && !notified.includes("workspace/didRenameFiles");
					i++
				) {
					await new Promise((r) => setTimeout(r, 25));
				}
				// Support reflects REGISTRATION at initialize time (a static
				// capability fact); the per-path FILTER decision happens at
				// send time, so the glob case suppresses the send without
				// un-advertising support.
				expect(client.getOperationSupport().didRenameFiles, name).toBe(
					env.FAKE_LSP_DID_RENAME === "true",
				);
				expect(notified.includes("workspace/didRenameFiles"), name).toBe(sent);
			} finally {
				await client.shutdown();
				await stopLSP(proc);
			}
		}
	}, 20_000); // so a regression fails on an ASSERTION, not this timeout. // Three real server launches plus a bounded echo round-trip; generous

	it("applies willRename filter matching before sending the preflight request", async () => {
		const cases = [
			{ glob: undefined as string | undefined, sent: true },
			{ glob: "**/*.ts", sent: true },
			{ glob: "**/*.go", sent: false },
		] as const;

		for (const { glob, sent } of cases) {
			const proc = await spawnFakeLspServer({
				cwd: process.cwd(),
				env: {
					...process.env,
					FAKE_LSP_WILL_RENAME: "true",
					...(glob ? { FAKE_LSP_WILL_RENAME_GLOB: glob } : {}),
					FAKE_LSP_ECHO_REQUEST_METHODS: "1",
				},
			});
			const client = await createLSPClient({
				serverId: "fake-will-rename-filter",
				process: proc,
				root: process.cwd(),
			});
			const received: string[] = [];
			client.connection.onNotification(
				"$/test/requestReceived",
				(params: { method: string }) => {
					received.push(params.method);
				},
			);
			try {
				const result = await client.willRenameFiles(
					path.join(process.cwd(), "old.ts"),
					path.join(process.cwd(), "new.ts"),
				);
				// Same bounded-poll rationale as the didRename matrix above: the
				// echo notification rides the stdio round-trip and can land after
				// one event-loop turn under load.
				const graceMs = sent ? 5000 : 500;
				for (
					let i = 0;
					i < graceMs / 25 && !received.includes("workspace/willRenameFiles");
					i++
				) {
					await new Promise((r) => setTimeout(r, 25));
				}
				expect(result, `glob=${glob ?? "default"}`).toBeNull();
				expect(
					received.includes("workspace/willRenameFiles"),
					`glob=${glob ?? "default"}`,
				).toBe(sent);
			} finally {
				await client.shutdown();
				await stopLSP(proc);
			}
		}
	}, 20_000);

	it("honors complete file-operation filters on the protocol wire", async () => {
		const tempRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pi-lsp-rename-filter-"),
		);
		const oldFile = path.join(tempRoot, "OLD.TS");
		const newFile = path.join(tempRoot, "NEW.TS");
		const oldFolder = path.join(tempRoot, "old-folder");
		const newFolder = path.join(tempRoot, "new-folder");
		const nestedDir = path.join(tempRoot, "a", "b");
		const nestedOldFile = path.join(nestedDir, "old.ts");
		const nestedNewFile = path.join(nestedDir, "new.ts");
		fs.writeFileSync(oldFile, "export {};\n");
		fs.mkdirSync(oldFolder);
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(nestedOldFile, "export {};\n");

		const filter = (
			glob: unknown,
			extra: Record<string, unknown> = {},
		): Record<string, unknown> => ({
			scheme: "file",
			pattern: { glob, ...extra },
		});
		const cases: Array<{
			name: string;
			filters: unknown;
			oldPath?: string;
			newPath?: string;
			oldUri?: string;
			newUri?: string;
			sent: boolean;
			registered?: boolean;
		}> = [
			{
				name: "mixed filters match when one complete filter matches",
				filters: [
					filter("**/*.go"),
					filter("**/*.ts", { options: { ignoreCase: true } }),
				],
				sent: true,
			},
			{
				name: "ignoreCase defaults to false independent of host",
				filters: [filter("**/*.ts")],
				sent: false,
			},
			{
				name: "basename does not widen a nested path glob",
				filters: [filter("*.ts")],
				oldPath: nestedOldFile,
				newPath: nestedNewFile,
				sent: false,
			},
			{
				name: "folder kind matches a probed folder",
				filters: [filter("**/old-folder", { matches: "folder" })],
				oldPath: oldFolder,
				newPath: newFolder,
				sent: true,
			},
			{
				name: "file kind rejects a probed folder",
				filters: [filter("**/old-folder", { matches: "file" })],
				oldPath: oldFolder,
				newPath: newFolder,
				sent: false,
			},
			{
				name: "unsupported URI scheme fails closed",
				filters: [{ scheme: "untitled", pattern: { glob: "**/*.ts" } }],
				oldUri: "untitled:///OLD.TS",
				newUri: "untitled:///NEW.TS",
				sent: false,
			},
			{
				name: "unsupported wire URI scheme fails closed without filter scheme",
				filters: [{ pattern: { glob: "**/*.ts" } }],
				oldUri: "vscode-vfs://host/old.ts",
				newUri: "vscode-vfs://host/new.ts",
				sent: false,
			},
			{
				name: "omitted scheme matches a supported file URI",
				filters: [{ pattern: { glob: "**/*.TS" } }],
				sent: true,
			},
			{
				name: "empty scheme is malformed",
				filters: [{ scheme: "", pattern: { glob: "**/*.TS" } }],
				sent: false,
				registered: false,
			},
			{
				name: "invalid matches value is malformed",
				filters: [filter("**/*.TS", { matches: "document" })],
				sent: false,
				registered: false,
			},
			{
				name: "invalid options are malformed",
				filters: [filter("**/*.TS", { options: { ignoreCase: "yes" } })],
				sent: false,
				registered: false,
			},
		];
		let symlinkPaths: { oldPath: string; newPath: string } | undefined;
		try {
			const oldLink = path.join(tempRoot, "old-link");
			const newLink = path.join(tempRoot, "new-link");
			fs.symlinkSync(oldFolder, oldLink, "junction");
			symlinkPaths = { oldPath: oldLink, newPath: newLink };
		} catch {
			// Symlink-specific coverage is omitted when the platform denies creation;
			// the non-symlink protocol matrix still runs below.
		}
		if (symlinkPaths) {
			cases.push({
				name: "matches file treats a directory symlink as the renamed entity",
				filters: [filter("**/old-link", { matches: "file" })],
				...symlinkPaths,
				sent: true,
			});
		}

		try {
			for (const operation of ["will", "did"] as const) {
				for (const testCase of cases) {
					const envKey =
						operation === "will"
							? "FAKE_LSP_WILL_RENAME_FILTERS"
							: "FAKE_LSP_DID_RENAME_FILTERS";
					const launched = await spawnFakeLspServer({
						cwd: tempRoot,
						env: {
							...process.env,
							FAKE_LSP_WILL_RENAME: "true",
							FAKE_LSP_DID_RENAME: "true",
							[envKey]: JSON.stringify(testCase.filters),
							...(operation === "will"
								? { FAKE_LSP_ECHO_REQUEST_METHODS: "1" }
								: { FAKE_LSP_ECHO_NOTIFY_METHODS: "1" }),
						},
					});
					const filteredClient = await createLSPClient({
						serverId: `fake-${operation}-${testCase.name}`,
						process: launched,
						root: tempRoot,
					});
					const received: string[] = [];
					filteredClient.connection.onNotification(
						operation === "will"
							? "$/test/requestReceived"
							: "$/test/notifyReceived",
						(params: { method: string }) => {
							received.push(params.method);
						},
					);
					try {
						expect(
							filteredClient.getOperationSupport()[
								operation === "will" ? "willRenameFiles" : "didRenameFiles"
							],
							`${operation}: ${testCase.name} registration`,
						).toBe(testCase.registered ?? true);
						const oldPath = testCase.oldPath ?? oldFile;
						const newPath = testCase.newPath ?? newFile;
						if (operation === "will") {
							await filteredClient.willRenameFiles(oldPath, newPath);
						} else {
							await filteredClient.didRenameFiles(
								oldPath,
								newPath,
								testCase.oldUri,
								testCase.newUri,
							);
						}
						const method = `workspace/${operation}RenameFiles`;
						const graceMs = testCase.sent ? 5000 : 300;
						for (
							let i = 0;
							i < graceMs / 25 && !received.includes(method);
							i++
						) {
							await new Promise((resolve) => setTimeout(resolve, 25));
						}
						expect(
							received.includes(method),
							`${operation}: ${testCase.name}`,
						).toBe(testCase.sent);
					} finally {
						await filteredClient.shutdown();
						await stopLSP(launched);
					}
				}
			}
		} finally {
			removeTempDirSync(tempRoot);
		}
	}, 60_000);

	const resolveCases = [
		{
			name: "absent",
			env: { FAKE_LSP_NO_CODE_ACTION_RESOLVE: "1" },
			supported: false,
		},
		{
			name: "false",
			env: { FAKE_LSP_CODE_ACTION_PROVIDER: "false" },
			supported: false,
		},
		{
			name: "malformed",
			env: { FAKE_LSP_CODE_ACTION_PROVIDER: "malformed" },
			supported: false,
		},
		{ name: "present", env: {}, supported: true },
	] as const;

	it.each(resolveCases)(
		"sends codeAction/resolve only when resolveProvider is $name",
		async ({ env, supported }) => {
			const proc = await spawnFakeLspServer({
				cwd: process.cwd(),
				env: {
					...process.env,
					...env,
					FAKE_LSP_ECHO_REQUEST_METHODS: "1",
				},
			});
			const client = await createLSPClient({
				serverId: "fake-code-action-capability",
				process: proc,
				root: process.cwd(),
			});
			const received: string[] = [];
			client.connection.onNotification(
				"$/test/requestReceived",
				(params: { method: string }) => {
					received.push(params.method);
				},
			);
			try {
				const filePath = path.join(process.cwd(), "resolve.ts");
				await client.notify.open(filePath, "greet();", "typescript");
				const actions = await client.codeAction(filePath, 0, 0, 0, 5);
				await new Promise((resolve) => setImmediate(resolve));
				expect(client.getOperationSupport().codeActionResolve).toBe(supported);
				if (supported) expect(actions[0]?.edit).toBeDefined();
				else expect(actions[0]?.edit).toBeUndefined();
				expect(received).toEqual(
					supported
						? ["textDocument/codeAction", "codeAction/resolve"]
						: ["textDocument/codeAction"],
				);
			} finally {
				await client.shutdown();
				await stopLSP(proc);
			}
		},
	);
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
		const proc = await spawnFakeLspServer({
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

describe("LSP Client Integration — UTF-8 position encoding (#269)", () => {
	const prevEnv = process.env.FAKE_LSP_POSITION_ENCODING;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let tmpDir: string;
	let filePath: string;
	// 'value' begins at UTF-16 char 13 but UTF-8 byte 14 (é is 2 bytes).
	const SRC = "const café = value;\n";

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-posenc-"));
		filePath = path.join(tmpDir, "a.ts");
		fs.writeFileSync(filePath, SRC); // toWirePosition reads the line from disk
		proc = await spawnFakeLspServer({
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_POSITION_ENCODING: "utf-8" },
		});
		client = await createLSPClient({
			serverId: "fake-utf8",
			process: proc,
			root: process.cwd(),
		});
	});

	afterEach(async () => {
		try {
			if (client) await client.shutdown();
		} catch {
			/* ignore */
		}
		try {
			if (proc) await stopLSP(proc);
		} catch {
			/* ignore */
		}
		client = undefined;
		proc = undefined;
		removeTempDirSync(tmpDir);
		if (prevEnv === undefined) delete process.env.FAKE_LSP_POSITION_ENCODING;
		else process.env.FAKE_LSP_POSITION_ENCODING = prevEnv;
	});

	it("sends a UTF-8 byte offset (not the raw UTF-16 offset) when the server negotiates utf-8", async () => {
		await client!.notify.open(filePath, SRC, "typescript");
		// 'value' is at UTF-16 char 13; the fake echoes back the position it received.
		const locations = await client!.definition(filePath, 0, 13);
		expect(locations.length).toBeGreaterThanOrEqual(1);
		const sentChar = locations[0].range.start.character;
		// The é before the offset costs one extra UTF-8 byte, so 13 → 14.
		expect(sentChar).toBe(Buffer.byteLength("const café = ", "utf8"));
		expect(sentChar).toBe(14);
		expect(sentChar).toBeGreaterThan(13);
	});
});

describe("LSP Client Integration — stale navigation drop (#276)", () => {
	const prevDelay = process.env.FAKE_LSP_DEFINITION_DELAY_MS;
	const prevFlag = process.env.PI_LENS_LSP_NAV_STALE_DROP;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let filePath: string;
	// Let the in-flight request's version get captured before we bump it. The
	// nav method yields at `await toWirePosition` before navRequest reads the
	// version, so a change issued too eagerly would be seen as the request's own
	// version. This gap (≪ the reply delay) makes the ordering deterministic.
	const settle = () => new Promise((r) => setTimeout(r, 40));

	beforeEach(async () => {
		filePath = path.join(process.cwd(), "stale-nav.ts");
		// The fake holds its definition reply for 300ms so we can land a
		// notify.change (which bumps the client's documentVersions) mid-request.
		proc = await spawnFakeLspServer({
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_DEFINITION_DELAY_MS: "300" },
		});
		client = await createLSPClient({
			serverId: "fake-stale",
			process: proc,
			root: process.cwd(),
		});
	});

	afterEach(async () => {
		try {
			if (client) await client.shutdown();
		} catch {
			/* ignore */
		}
		try {
			if (proc) await stopLSP(proc);
		} catch {
			/* ignore */
		}
		client = undefined;
		proc = undefined;
		if (prevDelay === undefined)
			delete process.env.FAKE_LSP_DEFINITION_DELAY_MS;
		else process.env.FAKE_LSP_DEFINITION_DELAY_MS = prevDelay;
		if (prevFlag === undefined) delete process.env.PI_LENS_LSP_NAV_STALE_DROP;
		else process.env.PI_LENS_LSP_NAV_STALE_DROP = prevFlag;
	});

	it("drops a nav result when the document is edited mid-request", async () => {
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		// Fire the (delayed) request, let it send, then bump the version before
		// it replies.
		const pending = client!.definition(filePath, 0, 6);
		await settle();
		await client!.notify.change(filePath, "const x = 2;\nconst y = 3;");
		const locations = await pending;
		// The in-flight result referred to the pre-edit document → dropped.
		expect(locations).toEqual([]);
	});

	it("returns a nav result when the document is not edited mid-request", async () => {
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		// Same delay, but no edit lands → result is returned unchanged.
		const locations = await client!.definition(filePath, 0, 6);
		expect(locations.length).toBeGreaterThanOrEqual(1);
	});

	it("returns the stale result when the drop is disabled via env", async () => {
		process.env.PI_LENS_LSP_NAV_STALE_DROP = "0";
		await client!.notify.open(filePath, "const x = 1;", "typescript");
		const pending = client!.definition(filePath, 0, 6);
		await settle();
		await client!.notify.change(filePath, "const x = 2;\nconst y = 3;");
		const locations = await pending;
		// Kill-switch off → the (now-stale) result is still returned.
		expect(locations.length).toBeGreaterThanOrEqual(1);
	});
});

describe("LSP Client Integration — batched watched-files (#271)", () => {
	const prev = process.env.FAKE_LSP_ECHO_WATCHED_FILES;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	// Frames the fake SERVER actually received over the wire (one entry = one
	// didChangeWatchedFiles notification), echoed back via $/test/watchedFilesReceived.
	let received: Array<Array<{ uri: string; type: number }>> = [];

	beforeEach(async () => {
		received = [];
		proc = await spawnFakeLspServer({
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_ECHO_WATCHED_FILES: "1" },
		});
		client = await createLSPClient({
			serverId: "fake-watch",
			process: proc,
			root: process.cwd(),
		});
		client.connection.onNotification(
			"$/test/watchedFilesReceived",
			(params: { changes: Array<{ uri: string; type: number }> }) => {
				received.push(params.changes);
			},
		);
	});

	afterEach(async () => {
		try {
			if (client) await client.shutdown();
		} catch {
			/* ignore */
		}
		try {
			if (proc) await stopLSP(proc);
		} catch {
			/* ignore */
		}
		client = undefined;
		proc = undefined;
		if (prev === undefined) delete process.env.FAKE_LSP_ECHO_WATCHED_FILES;
		else process.env.FAKE_LSP_ECHO_WATCHED_FILES = prev;
	});

	// Poll until the server has echoed at least one frame (the flush is on a
	// ~100ms debounce + a stdio round-trip), with a generous ceiling.
	const waitForEcho = async () => {
		for (let i = 0; i < 60 && received.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
	};

	it("coalesces N rapid file opens into ONE wire frame with N changes", async () => {
		const files = ["wf-a.ts", "wf-b.ts", "wf-c.ts"].map((f) =>
			path.join(process.cwd(), f),
		);
		// Open three distinct files within the debounce window.
		for (const f of files) {
			await client!.notify.open(f, "const x = 1;", "typescript");
		}

		await waitForEcho();

		// Exactly one notification reached the server for the whole burst…
		expect(received).toHaveLength(1);
		// …carrying all three URIs (deduped, insertion order).
		expect(received[0]).toHaveLength(3);
		const uris = received[0].map((c) => c.uri);
		for (const f of files) {
			expect(uris).toContain(pathToFileURL(f).href);
		}
	});

	it("does not emit a frame for a silent open (cascade read)", async () => {
		await client!.notify.open(
			path.join(process.cwd(), "wf-silent.ts"),
			"const x = 1;",
			"typescript",
			false,
			true, // silent
		);
		// Wait out the debounce window — nothing should have been enqueued/sent.
		await new Promise((r) => setTimeout(r, 200));
		expect(received).toHaveLength(0);
	});
});

describe("LSP Client Integration — mutation-bridge fallback for server-initiated edits (#2450)", () => {
	// `workspace/applyEdit`'s fallback `LspMutationContext` (clients/lsp/client.ts)
	// is reached whenever `state.activeMutationDepth !== 1` at request time —
	// review round 2 (F5) corrected the round-1 citation, which claimed
	// `clients/lsp/tsserver-sync.ts` was the production caller reaching this
	// path. It is not: both of that module's `executeCommand` calls request
	// `TSSERVER_REQUEST_COMMAND`, a read-only diagnostics pull, never a
	// mutating command. `tools/lsp-navigation.ts` — the one production caller
	// that solicits a MUTATING `executeCommand` — always threads a real
	// `mutationContext`. The actually-reachable no-context shape is nested/
	// re-entrant `executeCommand`: `runServerCommand` (clients/lsp/client.ts)
	// clears `state.activeMutationContext` to `undefined` for the ENTIRE
	// duration any call is not the outermost one (`activeMutationDepth !== 1`),
	// even though the outer call's own context is still live. Before #2450,
	// `bookkeepLspMutation` skipped every bookkeeping step for a write that
	// reached disk this way — no read-guard stamp, no turn-state entry, no
	// change-log receipt. This proves the mutation bridge fallback
	// (clients/lsp-mutation.ts `bookkeepLspMutation`) closes that gap using the
	// SAME seam every other LSP-applied edit bookkeeps through, not a parallel
	// one. The dedicated nested-case test below pins the corrected shape; the
	// first test here pins the simpler "no mutationContext argument at all"
	// client-level contract (still a real, if narrower, way to reach the same
	// fallback).
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let tmpDir: string;
	let filePath: string;
	let prevDataDir: string | undefined;

	// #2450 review round 2 (F2): 8 lines, with the edit target on line 7
	// (1-based) — never line 1 — so the real recorded range ({7,7}) cannot
	// collide with the {1,1} resource-op/whole-file-fallback default. A test
	// that edits line 1 stays green even if every range-plumbing step between
	// the fake server's response and the turn-state entry is neutered.
	const FIXTURE_LINES = [
		"const a = 1;",
		"const b = 2;",
		"const c = 3;",
		"const d = 4;",
		"const e = 5;",
		"const f = 6;",
		"hello world;",
		"const h = 8;",
	];
	const EDIT_LINE_0BASED = 6; // "hello world;" — 1-based line 7.

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-bridge-fallback-"),
		);
		filePath = path.join(tmpDir, "target.ts");
		fs.writeFileSync(filePath, `${FIXTURE_LINES.join("\n")}\n`, "utf-8");
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
		proc = await spawnFakeLspServer({ cwd: tmpDir });
		client = await createLSPClient({
			serverId: "fake-bridge-fallback",
			process: proc,
			root: tmpDir,
		});
	});

	afterEach(async () => {
		try {
			if (client) await client.shutdown();
		} catch {
			/* ignore */
		}
		try {
			if (proc) await stopLSP(proc);
		} catch {
			/* ignore */
		}
		client = undefined;
		proc = undefined;
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		removeTempDirSync(tmpDir);
	});

	it("records turn-state and a change-log receipt for a server-initiated applyEdit with no mutationContext threaded through executeCommand", async () => {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "s-2450-fallback" });
		runtime.beginTurn();
		const cacheManager = new CacheManager(false);
		registerMutationBridge({
			getRuntime: () => runtime as never,
			getCacheManager: () => cacheManager,
			getProjectRoot: () => tmpDir,
			getDispatchCwd: () => tmpDir,
			countFileLines,
			isRecordable: () => true,
			dbg: () => {},
		});

		// Same call shape as "applies a server-initiated edit solicited during
		// executeCommand" above: no mutationContext argument. The edit lands on
		// line 7 (1-based), not line 1, so the recorded range can't collide with
		// the {1,1} default (#2450 review round 2, F2).
		const res = await client!.executeCommand("fake.applyEdit", [
			pathToFileURL(filePath).href,
			{ line: EDIT_LINE_0BASED, startCharacter: 0, endCharacter: 5 },
		]);
		expect(res.executed).toBe(true);
		const expectedLines = [...FIXTURE_LINES];
		expectedLines[EDIT_LINE_0BASED] = "EDITED world;";
		expect(fs.readFileSync(filePath, "utf-8")).toBe(
			`${expectedLines.join("\n")}\n`,
		);

		const receipts = runtime.getMutationsSince(0);
		expect(receipts.map((r) => r.filePath)).toEqual([
			normalizeMapKey(filePath),
		]);
		// The bridge names the LSP handler that recorded it — not a generic
		// "settled sweep"/unattributed tag, and not silently absent.
		expect(receipts[0].source).toBe("agent-tool:lsp-workspace-applyEdit");

		// The durable change-log entry carries the REAL range the edit touched
		// (line 7, 1-based), not the {1,1} resource-op/whole-file default.
		const changes = readChangesSince(tmpDir, 0);
		expect(changes).toHaveLength(1);
		expect(changes[0].source).toBe("agent-tool:lsp-workspace-applyEdit");
		expect(changes[0].changedRange).toEqual({ start: 7, end: 7 });

		const turnFiles = cacheManager.readTurnState(tmpDir).files ?? {};
		const keys = Object.keys(turnFiles);
		expect(keys).toHaveLength(1);
		expect(keys[0]).toContain("target.ts");
		expect(turnFiles[keys[0]].modifiedRanges).toEqual([{ start: 7, end: 7 }]);
	});

	// #2450 review round 2 (F5)/round 3 (F3). The reachable production shape
	// is nested executeCommand, not "a caller that never threads a context"
	// — see the describe-level comment above. Two `executeCommand` calls fire
	// back to back with NO `await` between them, so both calls' synchronous
	// prefix (the `activeMutationDepth` bump in `runServerCommand`, before
	// its first `await`) runs before either awaits a server round-trip: the
	// outer call bumps depth 0→1 and stores ITS OWN (fully-threaded) mutation
	// context; the inner call then bumps depth 1→2, which — per
	// `runServerCommand` — clears `activeMutationContext` to `undefined` for
	// the window, even though BOTH calls' context objects are still very much
	// alive. Round 3 (F3): the inner call below now threads its OWN
	// fully-threaded context too (own runtime/cacheManager/cwd), not
	// `undefined` — the round-2 version passed no context at all, which made
	// a test asserting "the outer call's context isn't used" pass even with
	// the `workspace/applyEdit` handler's now-deleted `depth === 1` re-check
	// removed, because there was never a second context in play for that
	// removal to accidentally let through. With the inner call threading its
	// own context, the fallback must still fire — proving nesting clears
	// `activeMutationContext` for ANY inner context, not merely "no context
	// was ever passed for the inner call".
	it("falls back to the mutation bridge for a nested executeCommand's server-initiated edit, using neither the outer nor the inner call's own context", async () => {
		// SEPARATE cwds for the outer and inner calls' own bookkeeping,
		// deliberately distinct from `tmpDir` (the real edit target's
		// directory, and the bridge's `getProjectRoot`) and from each other.
		// `cacheManager.addModifiedRange`/`readTurnState` and
		// `readChangesSince` are FILE-scoped by `cwd` — any two
		// `CacheManager`/`readChangesSince` calls sharing the same `cwd`
		// observe the SAME on-disk store regardless of which JS instance made
		// them. Reusing `tmpDir` for either call's own context would make
		// that call's turn-state/change-log indistinguishable from the
		// bridge's, defeating the "never touched by either call's own
		// context" assertions below.
		const outerCwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-bridge-fallback-outer-"),
		);
		const innerCwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-bridge-fallback-inner-"),
		);
		try {
			const outerRuntime = new RuntimeCoordinator();
			outerRuntime.projectRoot = outerCwd;
			outerRuntime.setTelemetryIdentity({ sessionId: "s-2450-outer" });
			outerRuntime.beginTurn();
			const outerCacheManager = new CacheManager(false);

			const innerRuntime = new RuntimeCoordinator();
			innerRuntime.projectRoot = innerCwd;
			innerRuntime.setTelemetryIdentity({ sessionId: "s-2450-inner" });
			innerRuntime.beginTurn();
			const innerCacheManager = new CacheManager(false);

			const bridgeRuntime = new RuntimeCoordinator();
			bridgeRuntime.projectRoot = tmpDir;
			bridgeRuntime.setTelemetryIdentity({
				sessionId: "s-2450-nested-fallback",
			});
			bridgeRuntime.beginTurn();
			const bridgeCacheManager = new CacheManager(false);
			registerMutationBridge({
				getRuntime: () => bridgeRuntime as never,
				getCacheManager: () => bridgeCacheManager,
				getProjectRoot: () => tmpDir,
				getDispatchCwd: () => tmpDir,
				countFileLines,
				isRecordable: () => true,
				dbg: () => {},
			});

			const outerContext = {
				cwd: outerCwd,
				correlationId: "nested-outer",
				tool: "lsp_navigation:executeCommand",
				source: "lsp-execute-command" as const,
				runtime: outerRuntime as never,
				cacheManager: outerCacheManager,
				emitSummary: false,
			};
			// Round 3 (F3): the inner call's OWN fully-threaded context — a
			// distinct runtime/cacheManager/cwd from the outer call's, so a
			// bug that let the applyEdit handler read `state.activeMutationContext`
			// as the INNER call's own context (instead of falling back to the
			// bridge) would show up as a write landing in `innerCacheManager`/
			// `innerRuntime`, not just "the outer call's stores stayed empty".
			const innerContext = {
				cwd: innerCwd,
				correlationId: "nested-inner",
				tool: "lsp_navigation:executeCommand",
				source: "lsp-execute-command" as const,
				runtime: innerRuntime as never,
				cacheManager: innerCacheManager,
				emitSummary: false,
			};

			// Fired back to back, deliberately not awaited individually — see the
			// comment above for why this ordering is what makes depth 1→2 happen
			// before either request round-trips.
			const outerPromise = client!.executeCommand(
				"fake.doThing",
				undefined,
				outerContext,
			);
			const innerPromise = client!.executeCommand(
				"fake.applyEdit",
				[
					pathToFileURL(filePath).href,
					{ line: EDIT_LINE_0BASED, startCharacter: 0, endCharacter: 5 },
				],
				innerContext,
			);

			const [outerRes, innerRes] = await Promise.all([
				outerPromise,
				innerPromise,
			]);

			expect(outerRes.executed).toBe(true);
			expect(innerRes.executed).toBe(true);
			const expectedLines = [...FIXTURE_LINES];
			expectedLines[EDIT_LINE_0BASED] = "EDITED world;";
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				`${expectedLines.join("\n")}\n`,
			);

			// The inner write landed through the bridge fallback, not either
			// call's directly-threaded runtime/cacheManager.
			const bridgeChanges = readChangesSince(tmpDir, 0);
			expect(bridgeChanges).toHaveLength(1);
			expect(bridgeChanges[0].source).toBe(
				"agent-tool:lsp-workspace-applyEdit",
			);
			expect(bridgeChanges[0].changedRange).toEqual({ start: 7, end: 7 });
			const bridgeTurnFiles =
				bridgeCacheManager.readTurnState(tmpDir).files ?? {};
			expect(Object.keys(bridgeTurnFiles)).toHaveLength(1);

			// Neither call's OWN context (and its own, differently-scoped
			// turn-state/change-log/receipt store) was used for the inner
			// write — proof the fallback fired because nesting clears the
			// active context for ANY inner context, not merely because the
			// inner call happened to pass none.
			expect(
				Object.keys(outerCacheManager.readTurnState(outerCwd).files ?? {}),
			).toHaveLength(0);
			expect(readChangesSince(outerCwd, 0)).toEqual([]);
			expect(outerRuntime.getMutationsSince(0)).toEqual([]);

			expect(
				Object.keys(innerCacheManager.readTurnState(innerCwd).files ?? {}),
			).toHaveLength(0);
			expect(readChangesSince(innerCwd, 0)).toEqual([]);
			expect(innerRuntime.getMutationsSince(0)).toEqual([]);
		} finally {
			removeTempDirSync(outerCwd);
			removeTempDirSync(innerCwd);
		}
	});

	// #2450 fix round 3 (F4): a single (non-nested) executeCommand's
	// server-initiated edit is confined to `state.root` — the LSP CLIENT's
	// launch root (`tmpDir` here, matching a monorepo-wide server) — not to
	// the calling tool's `cwd`. `tools/lsp-navigation.ts` threads a
	// `cwd`-scoped `LspMutationContext` for a call issued from a sub-package
	// directory, so an edit landing on a SIBLING package (still inside
	// `state.root`, just outside the sub-package `cwd`) must still be judged
	// recordable against the PROJECT root (`runtime.projectRoot`), not the
	// narrower `cwd` — mirroring exactly how `tools/lsp-navigation.ts` builds
	// `isRecordable` post-fix.
	it("records a server-initiated edit on a sibling package when the mutation context's isRecordable judges against the project root, not cwd", async () => {
		const subPkgCwd = path.join(tmpDir, "packages", "a");
		const siblingPkgDir = path.join(tmpDir, "packages", "b");
		fs.mkdirSync(subPkgCwd, { recursive: true });
		fs.mkdirSync(siblingPkgDir, { recursive: true });
		const siblingFile = path.join(siblingPkgDir, "index.ts");
		fs.writeFileSync(siblingFile, `${FIXTURE_LINES.join("\n")}\n`, "utf-8");

		const runtime = new RuntimeCoordinator();
		// The REAL project root spans both sibling packages; the call below
		// is issued with the sub-package directory as its `cwd`.
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "s-2450-subpkg" });
		runtime.beginTurn();
		const cacheManager = new CacheManager(false);

		// Mirrors `tools/lsp-navigation.ts`'s post-fix `isRecordable` closure
		// exactly: judge against `runtime.projectRoot`, falling back to `cwd`
		// only when no runtime is threaded.
		const context = {
			cwd: subPkgCwd,
			correlationId: "subpkg-direct",
			tool: "lsp_navigation:executeCommand",
			source: "lsp-execute-command" as const,
			runtime: runtime as never,
			cacheManager,
			isRecordable: (fp: string): boolean =>
				isRecordableProjectPath(fp, runtime.projectRoot ?? subPkgCwd),
			emitSummary: false,
		};

		const res = await client!.executeCommand(
			"fake.applyEdit",
			[
				pathToFileURL(siblingFile).href,
				{ line: EDIT_LINE_0BASED, startCharacter: 0, endCharacter: 5 },
			],
			context,
		);
		expect(res.executed).toBe(true);
		const expectedLines = [...FIXTURE_LINES];
		expectedLines[EDIT_LINE_0BASED] = "EDITED world;";
		expect(fs.readFileSync(siblingFile, "utf-8")).toBe(
			`${expectedLines.join("\n")}\n`,
		);

		const receipts = runtime.getMutationsSince(0);
		expect(receipts.map((r) => r.filePath)).toEqual([
			normalizeMapKey(siblingFile),
		]);

		const changes = readChangesSince(subPkgCwd, 0);
		expect(changes).toHaveLength(1);
		expect(changes[0].filePath).toBe(path.resolve(siblingFile));

		const turnFiles = cacheManager.readTurnState(subPkgCwd).files ?? {};
		expect(Object.keys(turnFiles)).toHaveLength(1);
	});

	// #2479. `runServerCommand` (clients/lsp/client.ts) restored
	// `activeMutationContext` only when `activeMutationDepth` returned to 0 —
	// never back to the OUTER call's own context when a nested
	// `executeCommand` unwound from depth 2 to depth 1. Every server-initiated
	// applyEdit the outer call solicited AFTER that unwind therefore read
	// `undefined`, fell to the mutation-bridge fallback, and carried the
	// generic `agent-tool:lsp-workspace-applyEdit` receipt instead of the outer
	// operation's own (`lsp-execute-command`, or `lsp-rename` for a rename) for
	// the entire remaining life of its window.
	//
	// The ordering is made deterministic by the fixture's
	// "fake.applyEditDeferred" / "fake.releaseDeferredApplyEdit" pair rather
	// than by message-arrival timing: the outer call's edit is HELD server-side
	// until the test has AWAITED the nested call (so the depth 2 to 1 unwind,
	// which runs in `runServerCommand`'s `finally` before its promise settles,
	// has definitely completed), and only then released into the outer call's
	// still-open `serverEditsAllowed` window. The release rides
	// `executeReadOnlyCommand` — the #1412 read-only sibling that never touches
	// `serverEditsAllowed`/`activeMutationDepth`/`activeMutationContext` — so
	// what the applyEdit handler reads is the RESTORED outer context, not a
	// third mutating frame's own.
	it("keeps the outer call's own mutation context for an applyEdit solicited after a nested executeCommand unwinds (#2479)", async () => {
		// Separate cwds for the outer and inner calls' own bookkeeping, distinct
		// from `tmpDir` (the edit target's directory and the bridge's
		// `getProjectRoot`) and from each other — `readTurnState`/
		// `readChangesSince` are cwd-scoped on-disk stores, so sharing a cwd
		// would make "whose context recorded this" unanswerable.
		const outerCwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-nested-restore-outer-"),
		);
		const innerCwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-nested-restore-inner-"),
		);
		try {
			// Both calls' runtimes carry the REAL project root (`tmpDir`, the
			// LSP client's launch root), exactly as `tools/lsp-navigation.ts`
			// threads it — their `cwd` is the narrower calling directory. So
			// each context's `isRecordable` is built the way production builds
			// it, and neither call is exempted from that gate by construction.
			const outerRuntime = new RuntimeCoordinator();
			outerRuntime.projectRoot = tmpDir;
			outerRuntime.setTelemetryIdentity({ sessionId: "s-2479-outer" });
			outerRuntime.beginTurn();
			const outerCacheManager = new CacheManager(false);

			const innerRuntime = new RuntimeCoordinator();
			innerRuntime.projectRoot = tmpDir;
			innerRuntime.setTelemetryIdentity({ sessionId: "s-2479-inner" });
			innerRuntime.beginTurn();
			const innerCacheManager = new CacheManager(false);

			const bridgeRuntime = new RuntimeCoordinator();
			bridgeRuntime.projectRoot = tmpDir;
			bridgeRuntime.setTelemetryIdentity({ sessionId: "s-2479-bridge" });
			bridgeRuntime.beginTurn();
			const bridgeCacheManager = new CacheManager(false);
			registerMutationBridge({
				getRuntime: () => bridgeRuntime as never,
				getCacheManager: () => bridgeCacheManager,
				getProjectRoot: () => tmpDir,
				getDispatchCwd: () => tmpDir,
				countFileLines,
				isRecordable: () => true,
				dbg: () => {},
			});

			const outerContext = {
				cwd: outerCwd,
				correlationId: "restore-outer",
				tool: "lsp_navigation:executeCommand",
				source: "lsp-execute-command" as const,
				runtime: outerRuntime as never,
				cacheManager: outerCacheManager,
				isRecordable: (fp: string): boolean =>
					isRecordableProjectPath(fp, outerRuntime.projectRoot ?? outerCwd),
				emitSummary: false,
			};
			const innerContext = {
				cwd: innerCwd,
				correlationId: "restore-inner",
				tool: "lsp_navigation:executeCommand",
				source: "lsp-execute-command" as const,
				runtime: innerRuntime as never,
				cacheManager: innerCacheManager,
				isRecordable: (fp: string): boolean =>
					isRecordableProjectPath(fp, innerRuntime.projectRoot ?? innerCwd),
				emitSummary: false,
			};

			// Depth 0 to 1, context = the outer call's. The server holds the
			// edit back rather than sending it during this window's first leg.
			const outerPromise = client!.executeCommand(
				"fake.applyEditDeferred",
				[
					pathToFileURL(filePath).href,
					{ line: EDIT_LINE_0BASED, startCharacter: 0, endCharacter: 5 },
				],
				outerContext,
			);
			// Depth 1 to 2, context cleared for the nested frame — then awaited
			// to completion, so the 2 to 1 unwind has run before anything below.
			const innerRes = await client!.executeCommand(
				"fake.doThing",
				undefined,
				innerContext,
			);
			expect(innerRes.executed).toBe(true);

			// Release the held edit into the outer call's still-open window.
			const released = await client!.executeReadOnlyCommand(
				"fake.releaseDeferredApplyEdit",
			);
			expect(released.executed).toBe(true);
			expect((released.result as { released?: boolean }).released).toBe(true);

			const outerRes = await outerPromise;
			expect(outerRes.executed).toBe(true);
			const expectedLines = [...FIXTURE_LINES];
			expectedLines[EDIT_LINE_0BASED] = "EDITED world;";
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				`${expectedLines.join("\n")}\n`,
			);

			// The receipt carries the OUTER operation's own provenance, through
			// the outer call's own directly-threaded runtime/cacheManager.
			const outerReceipts = outerRuntime.getMutationsSince(0);
			expect(outerReceipts.map((r) => r.filePath)).toEqual([
				normalizeMapKey(filePath),
			]);
			expect(outerReceipts[0].source).toBe("lsp-execute-command");

			const outerChanges = readChangesSince(outerCwd, 0);
			expect(outerChanges).toHaveLength(1);
			expect(outerChanges[0].source).toBe("lsp-execute-command");
			expect(outerChanges[0].changedRange).toEqual({ start: 7, end: 7 });

			const outerTurnFiles =
				outerCacheManager.readTurnState(outerCwd).files ?? {};
			const outerKeys = Object.keys(outerTurnFiles);
			expect(outerKeys).toHaveLength(1);
			expect(outerKeys[0]).toContain("target.ts");
			expect(outerTurnFiles[outerKeys[0]].modifiedRanges).toEqual([
				{ start: 7, end: 7 },
			]);

			// Nothing reached the mutation-bridge fallback: the generic
			// `agent-tool:lsp-workspace-applyEdit` receipt is exactly the lost
			// provenance this test exists to catch.
			expect(readChangesSince(tmpDir, 0)).toEqual([]);
			expect(bridgeRuntime.getMutationsSince(0)).toEqual([]);
			expect(
				Object.keys(bridgeCacheManager.readTurnState(tmpDir).files ?? {}),
			).toHaveLength(0);

			// And what was restored is the OUTER call's context, not the
			// already-unwound inner frame's.
			expect(readChangesSince(innerCwd, 0)).toEqual([]);
			expect(innerRuntime.getMutationsSince(0)).toEqual([]);
			expect(
				Object.keys(innerCacheManager.readTurnState(innerCwd).files ?? {}),
			).toHaveLength(0);
		} finally {
			removeTempDirSync(outerCwd);
			removeTempDirSync(innerCwd);
		}
	});
});

// #4801: `runReadOnlyServerCommand` raced `safeSendRequest` against a timer and
// passed no signal. A server that accepted the command and never answered left
// the request pending for good: no `$/cancelRequest` went out and the
// connection's busy count never dropped, so `ClientRegistry` (which declines to
// evict `isBusy()` clients, client-registry.ts) could never retire the client.
// The warm-attach membership probe takes this route, so each attached read
// could add one more pending request. The commands that share this timeout
// are `executeReadOnlyCommand` callers only: the tsserver `projectInfo`
// membership probe (`fetchTsserverProjectIdentity`) and the didOpen
// project-identity probe (`probeTsserverProjectIdentity`).
// "1": the server ignores the cancel and never answers (the wedged server the
// issue names). "cancel": it answers the cancel with RequestCancelled after
// the client already released the request, a late rejection that must not
// surface as an unhandled one.
async function expectTimedOutProjectInfoReleased(
	mode: "1" | "cancel",
): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ro-cancel-"));
	const trace = path.join(tmp, "trace.log");
	const proc = await spawnFakeLspServer({
		cwd: tmp,
		env: {
			...process.env,
			FAKE_LSP_HANG_PROJECT_INFO: mode,
			FAKE_LSP_TRACE_FILE: trace,
		},
	});
	const client = await createLSPClient({
		serverId: "fake",
		process: proc,
		root: tmp,
	});
	try {
		expect(client.isBusy?.()).toBe(false);

		// The request `fetchTsserverProjectIdentity` sends for the warm-attach
		// membership probe, which the server never answers.
		const res = await client.executeReadOnlyCommand(
			"typescript.tsserverRequest",
			[
				"projectInfo",
				{ file: path.join(tmp, "a.ts"), needFileNameList: false },
			],
		);

		expect(res.executed).toBe(false);
		expect(res.reason).toContain("timed out");
		// The client no longer counts the abandoned request, so the registry's
		// eviction predicate reads it as idle. The server never answered the
		// cancel, so this is a local release, not a reply. `runReadOnlyServerCommand`
		// awaits the released request before it returns, so the count is already
		// down when this promise resolves — no polling, and no dependence on how
		// many `async` hops sit between the release and the caller (review F1).
		expect(client.isBusy?.()).toBe(false);
		// #4801: the release is a production-visible fact, not only a test one.
		// Its own record is once per server per session, so a wedged server
		// cannot storm it; a regression of the release leaves this row absent.
		const released = getDegradationSummary().find(
			(group) => group.kind === "lsp-readonly-command-released",
		);
		expect(released?.latestReasons.map((row) => row.subject)).toContain("fake");
		// The connection is still usable after the local release. Its answer
		// also orders the trace: the server reads stdio in order, so it has
		// read the cancel before it answers a request sent after it.
		const next = await client.executeReadOnlyCommand(
			"typescript.tsserverRequest",
			["version"],
		);
		expect(next.executed).toBe(true);
		expect(client.isBusy?.()).toBe(false);
		// The server saw the cancel on the wire, and an answered command is
		// never cancelled: exactly one cancel.
		expect(
			fs
				.readFileSync(trace, "utf-8")
				.split("\n")
				.filter((line) => line === "recv $/cancelRequest"),
		).toHaveLength(1);
	} finally {
		try {
			await client.shutdown();
		} catch {
			/* ignore */
		}
		try {
			await stopLSP(proc);
		} catch {
			/* ignore */
		}
		removeTempDirSync(tmp);
	}
}

describe("LSP Client Integration — a timed-out read-only command is cancelled and released (#4801)", () => {
	it(
		"sends $/cancelRequest and drops the busy count for a projectInfo the server never answers",
		() => expectTimedOutProjectInfoReleased("1"),
		15_000,
	);

	it(
		"sends $/cancelRequest and drops the busy count for a projectInfo the server answers with RequestCancelled",
		() => expectTimedOutProjectInfoReleased("cancel"),
		15_000,
	);
});
