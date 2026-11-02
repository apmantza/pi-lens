/**
 * #4320: with Pyrefly 1.3.2 an already-running session kept reporting
 * `missing-import` for `from pkg.new_module import f` after `new_module.py` was
 * created, in both `pilens_diagnostics` and `pilens_lsp_navigation`. A fresh
 * server resolved it. Two layers held the stale answer:
 *
 *  1. the server: it caches the failed lookup and only a watched-files
 *     Created (1) clears it, but the client announced every file that existed
 *     at open time as Changed (2);
 *  2. the persisted workspace-diagnostics cache: it replayed the importer's
 *     finding because the importer's bytes and its known imports never changed.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real LSPService and
 * the real client over a stdio JSON-RPC wire. The server is the shared fake in
 * its `FAKE_LSP_STALE_MODULE_LOOKUP` profile: it models Pyrefly's measured
 * behaviour (failed lookup cached, cleared only by Created), launched as a
 * project-configured custom server. No pi write is involved: the module is
 * created straight on disk, the reporter's isolated reproduction.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4320-svc-");
const workspace = env.tmpDir;

// The stale-lookup server's record of every watched-files change it heard.
const luaTrace = path.join(workspace, "lua-server.trace");
const IMPORTER = 'import "./new_module"\nlocal value = 1\n';

async function diagnose(paths: string[]): Promise<{
	text: string;
	details: Record<string, unknown>;
}> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4320",
		{ paths, serverScope: "primary", waitMs: 3000, concurrency: 1 },
		undefined,
		null,
		{ cwd: workspace },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		details: result.details ?? {},
	};
}

describe("a module created after the server started (#4320)", () => {
	let service: { shutdown: () => Promise<void> } | undefined;

	beforeAll(async () => {
		// Host-boundary stub: the fixture launches a project-configured server in a
		// project pi has trusted (#4248 refuses it otherwise).
		setProjectTrustState("trusted");
		const shim = path.join(workspace, "stale-lookup-server.mjs");
		fs.writeFileSync(
			shim,
			[
				// A push-only server, Pyrefly's measured shape here.
				'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
				'process.env.FAKE_LSP_STALE_MODULE_LOOKUP = "1";',
				`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(luaTrace)};`,
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		// A second server, for `.tl` files only.
		const otherShim = path.join(workspace, "other-server.mjs");
		fs.writeFileSync(
			otherShim,
			[
				'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		fs.writeFileSync(path.join(workspace, ".luarc.json"), "{}\n");
		// The rename case's module, born before any server starts: the rename
		// moves only its name, so its inode keeps a birth older than the server.
		fs.writeFileSync(path.join(workspace, "old_module.lua"), "return {}\n");
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					emmylua: {
						name: "stale lookup server",
						extensions: [".lua"],
						command: process.execPath,
						args: [shim],
						rootMarkers: [".luarc.json"],
					},
					"other-fake": {
						name: "other server",
						extensions: [".tl"],
						command: process.execPath,
						args: [otherShim],
						rootMarkers: [".luarc.json"],
					},
				},
				// ast-grep and typos never confirm here, and a sweep persists no
				// entry with an unconfirmed server, so the sweep case would never
				// reach the cache it pins.
				disabledServers: ["lua", "ast-grep", "typos"],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4320-svc-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
	});

	it("clears the importer's missing-import without a restart, and still reports a module that never appears", async () => {
		const importer = path.join(workspace, "probe.lua");
		const orphan = path.join(workspace, "orphan.lua");
		fs.writeFileSync(importer, IMPORTER);
		fs.writeFileSync(orphan, 'import "./never_exists"\nlocal value = 2\n');

		// Step 2 of the issue: both imports are missing.
		const before = await diagnose([importer, orphan]);
		expect(before.details.primaryDiagnosticsCount).toBe(2);

		// Step 3: the module appears on disk. No pi write, no restart.
		const created = path.join(workspace, "new_module.lua");
		fs.writeFileSync(created, "return {}\n");

		// Step 4: the same active diagnostics, new module first.
		const after = await diagnose([created, importer, orphan]);

		expect(after.text).toContain("never_exists");
		expect(after.text).not.toContain("Cannot find module new_module");
		// Exactly the module that never appears is still reported.
		expect(after.details.primaryDiagnosticsCount).toBe(1);
	}, 30_000);

	// #4320 r2 (F1): with the importer listed before the module, round 1 served
	// the importer from cache (and the server had not yet heard Created) and
	// cleared it only on the next call.
	it("clears the importer in the same call when it is listed before the new module", async () => {
		const importer = path.join(workspace, "first.lua");
		fs.writeFileSync(importer, 'import "./first_module"\nlocal value = 3\n');
		expect((await diagnose([importer])).details.primaryDiagnosticsCount).toBe(
			1,
		);

		const created = path.join(workspace, "first_module.lua");
		fs.writeFileSync(created, "return {}\n");
		const after = await diagnose([importer, created]);

		expect(after.text).not.toContain("Cannot find module first_module");
		expect(after.details.primaryDiagnosticsCount).toBe(0);
	}, 30_000);

	// #4320 r2 (F1): a workspace sweep looks every file up before it touches
	// any, so round 1 always served the importer's cached finding for one sweep.
	it("clears the importer in the same workspace sweep that first sees the new module", async () => {
		const importer = path.join(workspace, "swept.lua");
		fs.writeFileSync(importer, 'import "./swept_module"\nlocal value = 4\n');
		const sweep = async () =>
			(
				await (
					service as unknown as {
						runWorkspaceDiagnostics: (
							cwd: string,
						) => Promise<Array<{ filePath: string; diagnostics: unknown[] }>>;
					}
				).runWorkspaceDiagnostics(workspace)
			).find((result) => result.filePath === importer)?.diagnostics.length;
		expect(await sweep()).toBe(1);
		// The importer is itself new: its first open sent Created, which drops
		// the entry the first sweep recorded. The second sweep records the
		// entry the module's creation must not be answered from.
		expect(await sweep()).toBe(1);

		fs.writeFileSync(path.join(workspace, "swept_module.lua"), "return {}\n");

		expect(await sweep()).toBe(0);
	}, 60_000);

	// #4320 r2 (class sweep): pi-lens writes a new module in one package while
	// another package's client holds the failed lookup for it. The write's
	// open sent Created only to the owning client; its siblings heard Changed
	// (`announceToSiblings`), which Pyrefly ignores for a failed lookup.
	it("clears an importer in a sibling package after pi-lens writes the module there", async () => {
		for (const pkg of ["pkg_a", "pkg_b"]) {
			fs.mkdirSync(path.join(workspace, pkg), { recursive: true });
			fs.writeFileSync(path.join(workspace, pkg, ".luarc.json"), "{}\n");
			// a project boundary, so each package gets its own client
			fs.writeFileSync(path.join(workspace, pkg, "package.json"), "{}\n");
		}
		const importer = path.join(workspace, "pkg_a", "cross.lua");
		fs.writeFileSync(
			importer,
			'import "../pkg_b/sibling_module"\nlocal value = 6\n',
		);
		const seed = path.join(workspace, "pkg_b", "seed.lua");
		fs.writeFileSync(seed, "return {}\n");
		expect(
			(await diagnose([importer, seed])).details.primaryDiagnosticsCount,
		).toBe(1);

		const created = path.join(workspace, "pkg_b", "sibling_module.lua");
		fs.writeFileSync(created, "return {}\n");
		// the pi write path: the service syncs the written file
		await (
			service as unknown as {
				touchFile: (
					filePath: string,
					content: string,
					options: { diagnostics: "none"; source: string },
				) => Promise<unknown>;
			}
		).touchFile(created, "return {}\n", {
			diagnostics: "none",
			source: "probe-4320",
		});
		const after = await diagnose([importer]);

		expect(after.text).not.toContain("Cannot find module sibling_module");
		expect(after.details.primaryDiagnosticsCount).toBe(0);
	}, 30_000);

	// #4320 r3 (G2): a batch tells each client only the files of its own
	// server. Without the per-server filter in `announceCreatedFiles` the
	// stale-lookup (`.lua`) server heard Created for a `.tl` file, and every
	// cached finding of that server was dropped and re-checked (probe4 with
	// Pyrefly: replay 8 ms -> 629 ms).
	it("announces a new file only to its own server's clients", async () => {
		// #3801: the `.tl` server publishes nothing (push-only, no provider), so
		// each `.tl` check waited the full push window (21 s for the case). The
		// case asserts what the Lua server heard, not the `.tl` verdict, so the
		// window is capped for this case alone.
		vi.stubEnv("PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS", "1500");
		const luaFile = path.join(workspace, "own_server.lua");
		fs.writeFileSync(luaFile, "return {}\n");
		const seed = path.join(workspace, "seed.tl");
		fs.writeFileSync(seed, "local s = 1\n");
		const fresh = path.join(workspace, "fresh_other.tl");
		const sentinel = path.join(workspace, "sentinel_module.lua");
		try {
			await diagnose([luaFile, seed]);

			fs.writeFileSync(fresh, "local f = 1\n");
			await diagnose([fresh, luaFile]);
			// a sentinel the stale-lookup server must hear, so its trace is current
			fs.writeFileSync(sentinel, "return {}\n");
			await diagnose([sentinel]);
		} finally {
			vi.unstubAllEnvs();
		}

		const watched = fs
			.readFileSync(luaTrace, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("watched "));
		expect(watched).toContain(`watched ${pathToFileURL(sentinel).href} 1`);
		expect(watched.filter((line) => line.includes("fresh_other.tl"))).toEqual(
			[],
		);
	}, 30_000);

	// #4320 r2 (F2): `rename_file` moves a module into the missing path. The
	// moved inode keeps its old birth, so its first open read as Changed, and
	// a server without didRenameFiles (Pyrefly) kept the failed lookup.
	it("clears the importer after rename_file moves a module into the missing path", async () => {
		const importer = path.join(workspace, "renamed_user.lua");
		const source = path.join(workspace, "old_module.lua");
		const target = path.join(workspace, "renamed_module.lua");
		fs.writeFileSync(importer, 'import "./renamed_module"\nlocal value = 5\n');
		expect(
			(await diagnose([importer, source])).details.primaryDiagnosticsCount,
		).toBe(1);

		await (
			service as unknown as {
				renameFile: (
					from: string,
					to: string,
					options: { cwd: string; apply: boolean },
				) => Promise<unknown>;
			}
		).renameFile(source, target, { cwd: workspace, apply: true });
		const after = await diagnose([target, importer]);

		expect(after.text).not.toContain("Cannot find module renamed_module");
		expect(after.details.primaryDiagnosticsCount).toBe(0);
	}, 30_000);
});
