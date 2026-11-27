import { killProcessTree } from "../../../clients/lsp/client.js";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";
import { withEnv } from "../../support/with-env.js";

// The repair announces itself through `logSessionStart` — capture the real
// production call rather than reading the rotated log file, so the assertion
// cannot pass on an unrelated session's line.
const { sessionStartLines } = vi.hoisted(() => ({
	sessionStartLines: [] as string[],
}));

vi.mock("../../../clients/sessionstart-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/sessionstart-logger.js")
		>();
	return {
		...actual,
		logSessionStart: (line: string) => {
			sessionStartLines.push(line);
		},
	};
});

const RUN_LIVE_CLASSIC_REPAIR = process.env.PI_LENS_INTEGRATION === "1";
const IS_WIN = process.platform === "win32";
const NPM = IS_WIN ? "npm.cmd" : "npm";
const REPAIR_LOG = /managed compiler resolved to TypeScript 7\./;

const tempDirs: string[] = [];
const originalCwd = process.cwd();
// `importServerBoundTo` mutates both vars repeatedly across the suite (once
// per case); capture-now/restore-once-in-afterAll is deliberate here, not a
// per-test hook — `withEnv` still owns the save/restore correctness (the
// undefined-handling), it's just invoked as a no-op override so it only
// records the pre-suite values instead of changing them yet.
const restoreClassicRepairEnv = withEnv({
	PI_LENS_HOME: process.env.PI_LENS_HOME,
	PI_LENS_DISABLE_TOOL_INSTALL: process.env.PI_LENS_DISABLE_TOOL_INSTALL,
});

/** Set by `beforeAll` when npm or the registry is unavailable (§5: skip, never fail). */
let skipReason = "";
/** A pristine broken-#1436 managed tree; each case copies it instead of re-installing. */
let brokenTemplate = "";
let ts7Version = "";

function runNpm(
	args: string[],
	cwd: string,
	timeoutMs: number,
): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync(NPM, args, {
		cwd,
		encoding: "utf8",
		shell: IS_WIN,
		timeout: timeoutMs,
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.error?.message ?? result.stderr ?? "",
	};
}

function makeTempDir(label: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-${label}-`));
	tempDirs.push(dir);
	return dir;
}

function typeScriptVersion(toolsDir: string): string | undefined {
	try {
		const manifest = fs.readFileSync(
			path.join(toolsDir, "node_modules", "typescript", "package.json"),
			"utf8",
		);
		const parsed: unknown = JSON.parse(manifest);
		return typeof parsed === "object" &&
			parsed !== null &&
			"version" in parsed &&
			typeof parsed.version === "string"
			? parsed.version
			: undefined;
	} catch {
		return undefined;
	}
}

function tsserverPathIn(toolsDir: string): string {
	return path.join(
		toolsDir,
		"node_modules",
		"typescript",
		"lib",
		"tsserver.js",
	);
}

/**
 * Stage one isolated `PI_LENS_HOME` holding a managed tools tree in the exact
 * shape #1436 reported: typescript-language-server present, TypeScript 7 as the
 * managed compiler, and no `lib/tsserver.js` for the classic wrapper to load.
 *
 * The probe cache entry is not decoration — it IS the reported state. A cold
 * `ensureTool` would take the slow path, where the #589 version-pin drift check
 * re-installs the pinned compiler on its own and the #1436 repair never runs.
 * Real users reach `findTsserverPath` through the probe-cache fast path, which
 * returns the TS 7 `tsc` with no drift re-probe at all.
 */
function stageBrokenHome(label: string): {
	home: string;
	toolsDir: string;
	tscBin: string;
} {
	const home = makeTempDir(`classic-home-${label}`);
	const toolsDir = path.join(home, "tools");
	fs.cpSync(brokenTemplate, toolsDir, { recursive: true });
	const tscBin = path.join(
		toolsDir,
		"node_modules",
		".bin",
		IS_WIN ? "tsc.cmd" : "tsc",
	);
	fs.writeFileSync(
		path.join(home, "probe-cache.json"),
		JSON.stringify(
			{
				typescript: {
					path: tscBin,
					mtimeMs: fs.statSync(tscBin).mtimeMs,
					cachedAt: Date.now(),
				},
			},
			null,
			2,
		),
	);
	return { home, toolsDir, tscBin };
}

/**
 * A project with NO local TypeScript, staged OUTSIDE the repo (unlike the
 * native-TS7 live fixture, which needs the repo's node_modules — see the
 * deviation note in the suite body).
 */
function stageProject(label: string): { root: string; controlFile: string } {
	const root = makeTempDir(`classic-project-${label}`);
	fs.writeFileSync(
		path.join(root, "package.json"),
		`${JSON.stringify({ name: `classic-live-${label}`, version: "1.0.0" }, null, 2)}\n`,
	);
	fs.writeFileSync(
		path.join(root, "tsconfig.json"),
		`${JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2)}\n`,
	);
	const controlFile = path.join(root, "control.ts");
	fs.writeFileSync(controlFile, "export const control: string = 1;\n");
	return { root, controlFile };
}

/**
 * Load a fresh production module graph bound to `home`. The installer resolves
 * `TOOLS_DIR`/`PROBE_CACHE_PATH` from `getGlobalPiLensDir()` at MODULE LOAD, so
 * the env var must be set before the import — and each case needs its own tree,
 * hence `resetModules` rather than one shared graph.
 */
async function importServerBoundTo(home: string): Promise<{
	server: typeof import("../../../clients/lsp/server.js");
	launch: typeof import("../../../clients/lsp/launch.js");
	client: typeof import("../../../clients/lsp/client.js");
}> {
	process.env.PI_LENS_HOME = home;
	// vitest-setup.ts disables tool installs for the ordinary suite; this lane
	// exists to exercise the real installer.
	delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
	vi.resetModules();
	return {
		server: await import("../../../clients/lsp/server.js"),
		launch: await import("../../../clients/lsp/launch.js"),
		client: await import("../../../clients/lsp/client.js"),
	};
}

describe.skipIf(!RUN_LIVE_CLASSIC_REPAIR)(
	"live classic TypeScript repair (#1436)",
	() => {
		const running: Array<() => Promise<void>> = [];

		beforeAll(async () => {
			if (!runNpm(["--version"], os.tmpdir(), 60_000).ok) {
				skipReason = "npm is not available on PATH";
				return;
			}
			const view = runNpm(
				["view", "typescript@7", "version", "--json"],
				os.tmpdir(),
				120_000,
			);
			if (!view.ok) {
				skipReason = `npm registry unreachable: ${view.stderr.trim().slice(0, 200)}`;
				return;
			}
			try {
				const parsed: unknown = JSON.parse(view.stdout || '""');
				ts7Version = Array.isArray(parsed)
					? String(parsed.at(-1) ?? "")
					: String(parsed ?? "");
			} catch {
				ts7Version = "";
			}
			if (!ts7Version.startsWith("7.")) {
				skipReason = "no TypeScript 7 release is published";
				return;
			}

			brokenTemplate = makeTempDir("classic-template");
			fs.writeFileSync(
				path.join(brokenTemplate, "package.json"),
				`${JSON.stringify({ name: "pi-lens-tools", version: "1.0.0" }, null, 2)}\n`,
			);
			const install = runNpm(
				[
					"install",
					"--no-audit",
					"--no-fund",
					"--ignore-scripts",
					`typescript@${ts7Version}`,
					"typescript-language-server",
				],
				brokenTemplate,
				420_000,
			);
			if (!install.ok) {
				skipReason = `seed install failed: ${install.stderr.trim().slice(0, 300)}`;
			}
		}, 600_000);

		afterAll(async () => {
			for (const stop of running.splice(0)) await stop().catch(() => {});
			process.chdir(originalCwd);
			restoreClassicRepairEnv();
			for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
		});

		it("force-reinstalls the pinned compiler once and lands a usable classic launch", async (ctx) => {
			if (skipReason) ctx.skip(skipReason);
			sessionStartLines.length = 0;

			const { home, toolsDir } = stageBrokenHome("repair");
			const { root, controlFile } = stageProject("repair");

			// Fixture must actually carry the #1436 shape (defect shape 7): a TS 7
			// compiler the classic wrapper cannot load.
			expect(typeScriptVersion(toolsDir)?.split(".")[0]).toBe("7");
			expect(fs.existsSync(tsserverPathIn(toolsDir))).toBe(false);

			const { server, client: clientModule } = await importServerBoundTo(home);
			server._resetClassicTsRepairForTests();

			// `findTsserverPath` probes `process.cwd()/node_modules` before the
			// managed tree; from the repo that resolves to pi-lens' OWN TypeScript
			// and the managed path is never reached. Point cwd at the TS-less
			// project for the spawn, then restore immediately.
			process.chdir(root);
			let spawned: Awaited<ReturnType<typeof server.TypeScriptServer.spawn>>;
			try {
				spawned = await server.TypeScriptServer.spawn(root, {
					allowInstall: true,
				});
			} finally {
				process.chdir(originalCwd);
			}
			expect(spawned).toBeDefined();
			if (!spawned) return;
			running.push(() =>
				killProcessTree(spawned.process.process, spawned.process.pid),
			);

			// The repair fired exactly once, naming the TS 7 compiler it replaced.
			const repairLines = sessionStartLines.filter((line) =>
				REPAIR_LOG.test(line),
			);
			console.info(`classic repair log lines: ${JSON.stringify(repairLines)}`);
			expect(repairLines).toHaveLength(1);
			expect(repairLines[0]).toContain(ts7Version);

			// The isolated tree self-healed to the pinned classic compiler.
			expect(typeScriptVersion(toolsDir)).toBe("5.9.3");
			expect(fs.existsSync(tsserverPathIn(toolsDir))).toBe(true);

			// ...and the spawn is the CLASSIC variant carrying that tsserver.
			expect(spawned.launchVariant).toBe("classic");
			const resolvedTsserver = (
				spawned.initialization as { tsserver?: { path?: string } } | undefined
			)?.tsserver?.path;
			expect(typeof resolvedTsserver).toBe("string");
			expect(fs.existsSync(String(resolvedTsserver))).toBe(true);
			expect(
				path
					.resolve(String(resolvedTsserver))
					.startsWith(path.resolve(toolsDir)),
			).toBe(true);

			// End to end: the launch #1436 reported as dead now serves diagnostics.
			const lspClient = await clientModule.createLSPClient({
				serverId: server.TypeScriptServer.id,
				process: spawned.process,
				root,
				initialization: spawned.initialization,
				launchVariant: spawned.launchVariant,
			});
			running.push(() => lspClient.shutdown());
			await lspClient.notify.open(
				controlFile,
				fs.readFileSync(controlFile, "utf8"),
				"typescript",
			);
			await lspClient.waitForDiagnostics(controlFile, 20_000);
			expect(
				lspClient
					.getDiagnostics(controlFile)
					.map((diagnostic) => String(diagnostic.code)),
			).toContain("2322");
		}, 480_000);

		// AC-5 live: discovery must never mutate a managed tree when installs are
		// disallowed. Fresh tree + reset once-guard, so this cannot pass merely
		// because the previous case already consumed the one repair attempt.
		it("never touches the managed tree when installs are disallowed", async (ctx) => {
			if (skipReason) ctx.skip(skipReason);
			sessionStartLines.length = 0;

			const { home, toolsDir } = stageBrokenHome("no-install");
			const { root } = stageProject("no-install");

			// Same pre-spawn shape assertion as the repair case: the control is
			// only meaningful against a genuinely broken tree.
			expect(typeScriptVersion(toolsDir)?.split(".")[0]).toBe("7");
			expect(fs.existsSync(tsserverPathIn(toolsDir))).toBe(false);
			const manifestPath = path.join(
				toolsDir,
				"node_modules",
				"typescript",
				"package.json",
			);
			const beforeMtimeMs = fs.statSync(manifestPath).mtimeMs;

			const { server } = await importServerBoundTo(home);
			server._resetClassicTsRepairForTests();

			process.chdir(root);
			let spawned: Awaited<ReturnType<typeof server.TypeScriptServer.spawn>>;
			try {
				spawned = await server.TypeScriptServer.spawn(root, {
					allowInstall: false,
				});
			} finally {
				process.chdir(originalCwd);
			}
			if (spawned)
				running.push(() =>
					killProcessTree(spawned.process.process, spawned.process.pid),
				);

			expect(
				sessionStartLines.filter((line) => REPAIR_LOG.test(line)),
			).toHaveLength(0);
			expect(typeScriptVersion(toolsDir)).toBe(ts7Version);
			expect(fs.existsSync(tsserverPathIn(toolsDir))).toBe(false);
			expect(fs.statSync(manifestPath).mtimeMs).toBe(beforeMtimeMs);
			// Discovery still resolves the managed wrapper; it simply has no
			// tsserver to hand it.
			expect(spawned?.launchVariant).toBe("classic");
			expect(spawned?.initialization).toBeUndefined();
		}, 180_000);
	},
);
