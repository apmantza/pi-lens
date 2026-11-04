/**
 * #4242 phase A (per-file linters): an adopted analysis root runs only the
 * explicit allowlist of config-free, code-free dispatch runners, and only from
 * global or pi-lens-managed binaries.
 *
 * The witnesses go through the real dispatch entry and the real `php-lint`
 * runner. Only the external child process (`safe-spawn`) is doubled; the trust
 * seam and `createVenvFinder` are the real modules.
 */

import { uncheckedReason } from "../../support/dispatch-verdict.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ADOPTED_ROOT_RUNNER_ALLOWLIST,
	filterGroupsForAdoptedRoot,
	isAdoptedRootRunnerAdmitted,
} from "../../../clients/dispatch/adopted-root-runners.js";
import {
	RunnerRegistry,
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	dispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";

import { BiomeClient } from "../../../clients/biome-client.js";
import { getGlobalPiLensDir } from "../../../clients/file-utils.js";
import { FormatService } from "../../../clients/format-service.js";
import { clearFormatterRuntimeState } from "../../../clients/formatters.js";
import { RuffClient } from "../../../clients/ruff-client.js";
import {
	acquireWarmWordIndex,
	analyzeFile,
} from "../../../clients/mcp/analyze.js";
import {
	buildWordIndex,
	serializeWordIndex,
	wordIndexPostingHits,
} from "../../../clients/word-index.js";
import {
	flushProjectSnapshotPersistsForTests,
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../../clients/project-snapshot.js";
import {
	runAutofix,
	runFormatPhase,
	runPipeline,
} from "../../../clients/pipeline.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { RunnerDefinition } from "../../../clients/dispatch/types.js";
import { isExcludedTestTarget } from "../../../clients/test-runner-client.js";
import {
	setProjectTrustState,
	resetProjectTrust,
} from "../../../clients/project-trust.js";
import { setupTestEnvironment } from "../test-utils.js";

// The external child process is the only double: a "binary" that writes a
// marker when it runs is still the real runner's spawn call, so a marker's
// presence proves which command pi-lens actually executed.
const { safeSpawnAsync, spawnCalls } = vi.hoisted(() => {
	const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];
	const safeSpawnAsync = vi.fn(
		async (
			cmd: string,
			args: readonly string[] = [],
			options?: { cwd?: string },
		) => {
			spawnCalls.push({ cmd: String(cmd), args });
			const fs = await import("node:fs");
			const path = await import("node:path");
			const executable = path.isAbsolute(cmd)
				? cmd
				: (process.env.PATH ?? "")
						.split(path.delimiter)
						.map((dir) => path.resolve(options?.cwd ?? process.cwd(), dir, cmd))
						.find((file) => fs.existsSync(file));
			if (executable && fs.existsSync(executable)) {
				const marker = fs
					.readFileSync(executable, "utf8")
					.match(/# marker: (.+)/)?.[1];
				if (marker) fs.writeFileSync(marker, "executed");
			}
			if (args.some((arg) => arg.includes("version"))) {
				return { error: null, status: 0, stdout: "fake 1.0\n", stderr: "" };
			}
			// `php -l` syntax-error wire (PHP exits 255 for a parse error).
			return {
				error: null,
				status: 255,
				stdout: "",
				stderr: "PHP Parse error:  syntax error, unexpected token on line 1\n",
			};
		},
	);
	return { safeSpawnAsync, spawnCalls };
});
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

function adoptedFixture(): {
	sessionRoot: string;
	adoptedRoot: string;
	file: string;
	cleanup: () => void;
} {
	const sessionEnv = setupTestEnvironment("adopted-session-");
	const adoptedEnv = setupTestEnvironment("adopted-project-");
	const sessionRoot = sessionEnv.tmpDir;
	const adoptedRoot = adoptedEnv.tmpDir;
	// A marker makes the sibling a real project root for the analysis-root seam,
	// and `composer.json` anchors `php-lint`'s runner cwd to it.
	fs.writeFileSync(path.join(adoptedRoot, "package.json"), "{}\n");
	fs.writeFileSync(path.join(adoptedRoot, "composer.json"), "{}\n");
	const file = path.join(adoptedRoot, "broken.php");
	fs.writeFileSync(file, "<?php function (\n");
	return {
		sessionRoot,
		adoptedRoot,
		file,
		cleanup: () => {
			adoptedEnv.cleanup();
			sessionEnv.cleanup();
		},
	};
}

function formatterFixture(fixture: ReturnType<typeof adoptedFixture>) {
	setProjectTrustState("trusted");
	const file = path.join(fixture.adoptedRoot, "broken.sh");
	fs.writeFileSync(file, "#!/bin/sh\necho   hello\n");
	fs.writeFileSync(
		path.join(fixture.adoptedRoot, ".editorconfig"),
		"root = true\n[*]\nindent_style = space\nindent_size = 2\n",
	);
	const bin = path.join(fixture.adoptedRoot, "bin");
	fs.mkdirSync(bin);
	const marker = path.join(fixture.adoptedRoot, "formatter-ran");
	fs.writeFileSync(path.join(bin, "shfmt"), `#!/bin/sh\n# marker: ${marker}\n`);
	fs.chmodSync(path.join(bin, "shfmt"), 0o755);
	vi.stubEnv("PATH", bin);
	return { file, marker };
}

async function decisionRows(file: string, phase: string) {
	await flushLatencyLog();
	return fs
		.readFileSync(getLatencyLogPath(), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((row) => row.filePath === file && row.phase === phase);
}

function makeCtx(file: string, sessionRoot: string) {
	return createDispatchContext(
		file,
		sessionRoot,
		{ getFlag: () => false },
		new FactStore(),
		undefined,
		undefined,
		sessionRoot,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		"adopted",
	);
}

describe("#4242 adopted-root runner allowlist", () => {
	let globalEnv: ReturnType<typeof setupTestEnvironment>;
	beforeEach(() => {
		globalEnv = setupTestEnvironment("pi-lens-global-php-");
		const binary = path.join(
			globalEnv.tmpDir,
			process.platform === "win32" ? "php.exe" : "php",
		);
		fs.writeFileSync(binary, "#!/bin/sh\n");
		fs.chmodSync(binary, 0o755);
		vi.stubEnv("PATH", globalEnv.tmpDir);
		clearFormatterRuntimeState();
		spawnCalls.length = 0;
		safeSpawnAsync.mockClear();
		clearCoverageNoticeState();
		clearLatencyReports();
	});
	afterEach(() => {
		globalEnv.cleanup();
		resetProjectTrust();
		vi.unstubAllEnvs();
	});

	// #4309 F1: the real pull facade must carry the classifier's decision.
	it("admits only php-lint through the real MCP analyze facade", async () => {
		const fixture = adoptedFixture();
		try {
			const result = await analyzeFile(fixture.file, fixture.sessionRoot, {
				warmLsp: false,
				record: false,
				flags: { "no-lsp": true, "no-autofix": true },
			});
			expect(result.latency?.runners.map((r) => r.runnerId)).toEqual([
				"php-lint",
			]);
		} finally {
			fixture.cleanup();
		}
	});

	// #4309 F2: PATH, including relative entries, is a binary source too.
	it.each(["adopted", "session", "relative", "symlink"])(
		"refuses a hostile %s PATH executable before probing it",
		async (source) => {
			const fixture = adoptedFixture();
			try {
				vi.stubEnv("PI_LENS_TEST_MODE", "0");
				setProjectTrustState("trusted");
				const root =
					source === "session" ? fixture.sessionRoot : fixture.adoptedRoot;
				const bin = path.join(root, "hostile");
				fs.mkdirSync(bin);
				const marker = path.join(root, "path-php-ran");
				const executable = path.join(
					bin,
					process.platform === "win32" ? "php.exe" : "php",
				);
				fs.writeFileSync(executable, `#!/bin/sh\n# marker: ${marker}\n`);
				fs.chmodSync(executable, 0o755);
				let entry = source === "relative" ? "./hostile" : bin;
				if (source === "symlink") {
					const alias = path.join(fixture.sessionRoot, "alias");
					fs.symlinkSync(bin, alias, "junction");
					entry = alias;
				}
				vi.stubEnv("PATH", entry);
				const registry = new RunnerRegistry();
				registry.register(
					(await import("../../../clients/dispatch/runners/php-lint.js"))
						.default,
				);
				await dispatchForFile(
					makeCtx(fixture.file, fixture.sessionRoot),
					[{ mode: "all", runnerIds: ["php-lint"] }],
					registry,
				);
				expect(fs.existsSync(marker)).toBe(false);
				expect(spawnCalls).toEqual([]);
				expect(
					(await decisionRows(fixture.file, "adopted_root_binary_refused"))[0]
						?.metadata.command,
				).toBe("php");
			} finally {
				fixture.cleanup();
			}
		},
	);

	// #4309 F2: the binary containment rule applies to every resolution rung.
	it.each([false, true])(
		"checks a managed shim's real target (local=%s)",
		async (local) => {
			const fixture = adoptedFixture();
			const managed = path.join(
				getGlobalPiLensDir(),
				"tools",
				"node_modules",
				".bin",
				process.platform === "win32" ? "php.cmd" : "php",
			);
			try {
				fs.mkdirSync(path.dirname(managed), { recursive: true });
				const marker = path.join(fixture.adoptedRoot, "managed-php-ran");
				if (local) {
					const target = path.join(fixture.adoptedRoot, "php");
					fs.writeFileSync(target, `#!/bin/sh\n# marker: ${marker}\n`);
					fs.chmodSync(target, 0o755);
					fs.symlinkSync(target, managed, "file");
				} else {
					fs.writeFileSync(managed, "#!/bin/sh\n");
					fs.chmodSync(managed, 0o755);
				}
				const registry = new RunnerRegistry();
				registry.register(
					(await import("../../../clients/dispatch/runners/php-lint.js"))
						.default,
				);
				const result = await dispatchForFile(
					makeCtx(fixture.file, fixture.sessionRoot),
					[{ mode: "all", runnerIds: ["php-lint"] }],
					registry,
				);
				expect(fs.existsSync(marker)).toBe(false);
				if (local) expect(spawnCalls).toEqual([]);
				else {
					expect(result.blockers[0]?.tool).toBe("php-lint");
					expect(spawnCalls[0]?.cmd).toBe(fs.realpathSync(managed));
				}
			} finally {
				fs.rmSync(managed, { force: true });
				fixture.cleanup();
			}
		},
	);

	it("runs fish-indent from an external executable and refuses its local PATH replacement", async () => {
		const fixture = adoptedFixture();
		try {
			const file = path.join(fixture.adoptedRoot, "broken.fish");
			fs.writeFileSync(file, "if\n");
			const name =
				process.platform === "win32" ? "fish_indent.exe" : "fish_indent";
			const external = path.join(globalEnv.tmpDir, name);
			fs.writeFileSync(external, "#!/bin/sh\n");
			fs.chmodSync(external, 0o755);
			const registry = new RunnerRegistry();
			registry.register(
				(await import("../../../clients/dispatch/runners/fish-indent.js"))
					.default,
			);
			await dispatchForFile(
				makeCtx(file, fixture.sessionRoot),
				[{ mode: "all", runnerIds: ["fish-indent"] }],
				registry,
			);
			expect(spawnCalls[0]?.cmd).toBe(fs.realpathSync(external));
			spawnCalls.length = 0;
			const marker = path.join(fixture.adoptedRoot, "fish-ran");
			const hostile = path.join(fixture.adoptedRoot, name);
			fs.writeFileSync(hostile, `#!/bin/sh\n# marker: ${marker}\n`);
			fs.chmodSync(hostile, 0o755);
			vi.stubEnv("PATH", fixture.adoptedRoot);
			await dispatchForFile(
				makeCtx(file, fixture.sessionRoot),
				[{ mode: "all", runnerIds: ["fish-indent"] }],
				registry,
			);
			expect(fs.existsSync(marker)).toBe(false);
			expect(spawnCalls).toEqual([]);
		} finally {
			fixture.cleanup();
		}
	});

	it("runs the fish syntax step from an external fish and refuses its local PATH replacement", async () => {
		const fixture = adoptedFixture();
		try {
			const file = path.join(fixture.adoptedRoot, "broken.fish");
			fs.writeFileSync(file, "if\n");
			const mk = (dir: string, name: string, extra = "") => {
				const p = path.join(dir, name);
				fs.writeFileSync(p, `#!/bin/sh\n${extra}`);
				fs.chmodSync(p, 0o755);
				return p;
			};
			const ext = globalEnv.tmpDir;
			const extFish = mk(ext, "fish");
			const extIndent = mk(ext, "fish_indent");
			const registry = new RunnerRegistry();
			registry.register(
				(await import("../../../clients/dispatch/runners/fish-indent.js"))
					.default,
			);
			await dispatchForFile(
				makeCtx(file, fixture.sessionRoot),
				[{ mode: "all", runnerIds: ["fish-indent"] }],
				registry,
			);
			const real = (p: string) => fs.realpathSync(p);
			const cmds = spawnCalls.map((c) => c.cmd);
			expect(cmds).toContain(real(extFish));
			expect(cmds).toContain(real(extIndent));
			spawnCalls.length = 0;
			const marker = path.join(fixture.adoptedRoot, "fish-ran");
			mk(fixture.adoptedRoot, "fish", `# marker: ${marker}\n`);
			vi.stubEnv("PATH", `${fixture.adoptedRoot}${path.delimiter}${ext}`);
			await dispatchForFile(
				makeCtx(file, fixture.sessionRoot),
				[{ mode: "all", runnerIds: ["fish-indent"] }],
				registry,
			);
			expect(fs.existsSync(marker)).toBe(false);
			expect(spawnCalls.map((c) => c.cmd)).not.toContain(
				path.join(fixture.adoptedRoot, "fish"),
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("skips an adopted checker when no executable resolves", async () => {
		const fixture = adoptedFixture();
		try {
			vi.stubEnv("PATH", fixture.adoptedRoot);
			const registry = new RunnerRegistry();
			registry.register(
				(await import("../../../clients/dispatch/runners/php-lint.js")).default,
			);
			const result = await dispatchForFile(
				makeCtx(fixture.file, fixture.sessionRoot),
				[{ mode: "all", runnerIds: ["php-lint"] }],
				registry,
			);
			expect(result.latencyReport?.runners[0]?.status).toBe("skipped");
			expect(spawnCalls).toEqual([]);
		} finally {
			fixture.cleanup();
		}
	});

	// #4309 F2: unavailable or indeterminate executable identities stay off.
	it.each(["not-executable", "directory", "unreadable", "unknown-root"])(
		"declines an adopted executable with %s identity",
		async (fault) => {
			const fixture = adoptedFixture();
			let restore: (() => void) | undefined;
			try {
				const binary = path.join(
					globalEnv.tmpDir,
					process.platform === "win32" ? "php.exe" : "php",
				);
				if (fault === "directory") {
					fs.rmSync(binary);
					fs.mkdirSync(binary);
				}
				if (fault === "not-executable") {
					if (process.platform === "win32") fs.rmSync(binary);
					else fs.chmodSync(binary, 0o644);
				}
				if (fault === "unreadable") {
					const native = fs.realpathSync.native;
					const injected = vi
						.spyOn(fs.realpathSync, "native")
						.mockImplementation((file, options) => {
							if (file === binary)
								throw new Error("filesystem identity unreadable");
							return native(file, options);
						});
					restore = () => injected.mockRestore();
				}
				const file =
					fault === "unknown-root"
						? path.join(globalEnv.tmpDir, "broken.php")
						: fixture.file;
				if (fault === "unknown-root")
					fs.writeFileSync(file, "<?php function (\n");
				const registry = new RunnerRegistry();
				registry.register(
					(await import("../../../clients/dispatch/runners/php-lint.js"))
						.default,
				);
				const result = await dispatchForFile(
					makeCtx(file, fixture.sessionRoot),
					[{ mode: "all", runnerIds: ["php-lint"] }],
					registry,
				);
				expect(result.latencyReport?.runners[0]?.status).toBe("skipped");
				expect(spawnCalls).toEqual([]);
			} finally {
				restore?.();
				fixture.cleanup();
			}
		},
	);

	it("refuses a project PATH symlink even when its real target is external", async () => {
		const fixture = adoptedFixture();
		try {
			const alias = path.join(fixture.adoptedRoot, "bin");
			fs.symlinkSync(globalEnv.tmpDir, alias, "junction");
			vi.stubEnv("PATH", alias);
			const registry = new RunnerRegistry();
			registry.register(
				(await import("../../../clients/dispatch/runners/php-lint.js")).default,
			);
			await dispatchForFile(
				makeCtx(fixture.file, fixture.sessionRoot),
				[{ mode: "all", runnerIds: ["php-lint"] }],
				registry,
			);
			expect(spawnCalls).toEqual([]);
		} finally {
			fixture.cleanup();
		}
	});

	it("keeps an external relative PATH executable admitted", async () => {
		const fixture = adoptedFixture();
		try {
			vi.stubEnv("PATH", path.relative(fixture.adoptedRoot, globalEnv.tmpDir));
			const registry = new RunnerRegistry();
			registry.register(
				(await import("../../../clients/dispatch/runners/php-lint.js")).default,
			);
			const result = await dispatchForFile(
				makeCtx(fixture.file, fixture.sessionRoot),
				[{ mode: "all", runnerIds: ["php-lint"] }],
				registry,
			);
			expect(result.blockers[0]?.tool).toBe("php-lint");
		} finally {
			fixture.cleanup();
		}
	});

	// #4309 F3: both immediate and deferred callers use these writer seams.
	it("disables adopted autofix before consulting clients or project config", async () => {
		const fixture = adoptedFixture();
		try {
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			const file = path.join(fixture.adoptedRoot, "broken.py");
			fs.writeFileSync(file, "x = 1\n");
			const result = await runAutofix(
				file,
				fixture.sessionRoot,
				() => false,
				() => {},
				{
					biomeClient: new BiomeClient(),
					ruffClient: new RuffClient(),
					fixedThisTurn: new Set(),
				},
			);
			expect(result.skipReason).toBe("adopted_root");
			expect(
				(await decisionRows(file, "adopted_root_writer_skipped"))[0]?.metadata
					.writer,
			).toBe("autofix");
			expect(result.attemptedTools).toEqual([]);
		} finally {
			fixture.cleanup();
		}
	});

	it("disables adopted formatting through the real format service", async () => {
		const fixture = adoptedFixture();
		try {
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			const { file, marker } = formatterFixture(fixture);
			const result = await runFormatPhase(
				file,
				() => new FormatService("adopted-r2"),
				() => {},
				undefined,
				undefined,
				undefined,
				undefined,
				fixture.sessionRoot,
			);
			expect(fs.existsSync(marker)).toBe(false);
			expect(
				(await decisionRows(file, "adopted_root_writer_skipped"))[0]?.metadata
					.writer,
			).toBe("format");
			expect(result.formattersUsed).toEqual([]);
			expect(result.formatChanged).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	// #4309 F3: a language cwd inside the adopted root is not the trust root.
	it.each([true, false])(
		"disables immediate=%s formatting in the real write pipeline",
		async (immediate) => {
			const fixture = adoptedFixture();
			try {
				vi.stubEnv("PI_LENS_TEST_MODE", "0");
				const { file, marker } = formatterFixture(fixture);
				const result = await runPipeline(
					{
						filePath: file,
						cwd: fixture.adoptedRoot,
						projectRoot: fixture.sessionRoot,
						analysisRootMode: "adopted",
						toolName: "write",
						dbg: () => {},
						getFlag: (name) =>
							name === "immediate-format"
								? immediate
								: name === "no-lsp" || name === "no-cascade",
					},
					{
						biomeClient: new BiomeClient(),
						ruffClient: new RuffClient(),
						fixedThisTurn: new Set(),
						getFormatService: () => new FormatService("adopted-pipeline-r2"),
					},
				);
				expect(result.formattersUsed).toEqual([]);
				expect(result.fileModified).toBe(false);
				expect(fs.existsSync(marker)).toBe(false);
				expect((await decisionRows(file, "format"))[0]?.metadata.deferred).toBe(
					false,
				);
			} finally {
				fixture.cleanup();
			}
		},
	);

	// #4309 r2 pre-push: repeat policy refusals count without repeated log rows.
	it("bounds repeated adopted binary and writer decisions in the real sink", async () => {
		const fixture = adoptedFixture();
		try {
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			vi.stubEnv("PATH", fixture.adoptedRoot);
			const binary = path.join(
				fixture.adoptedRoot,
				process.platform === "win32" ? "php.exe" : "php",
			);
			fs.writeFileSync(binary, "#!/bin/sh\n");
			fs.chmodSync(binary, 0o755);
			const registry = new RunnerRegistry();
			registry.register(
				(await import("../../../clients/dispatch/runners/php-lint.js")).default,
			);
			for (let attempt = 0; attempt < 2; attempt++) {
				await dispatchForFile(
					makeCtx(fixture.file, fixture.sessionRoot),
					[{ mode: "all", runnerIds: ["php-lint"] }],
					registry,
				);
				await runAutofix(
					fixture.file,
					fixture.sessionRoot,
					() => false,
					() => {},
					{
						biomeClient: new BiomeClient(),
						ruffClient: new RuffClient(),
						fixedThisTurn: new Set(),
					},
				);
				await runFormatPhase(
					fixture.file,
					() => new FormatService("bounded-adopted-r2"),
					() => {},
					undefined,
					undefined,
					undefined,
					undefined,
					fixture.sessionRoot,
				);
			}
			expect(
				await decisionRows(fixture.file, "adopted_root_binary_refused"),
			).toHaveLength(1);
			const writers = await decisionRows(
				fixture.file,
				"adopted_root_writer_skipped",
			);
			expect(writers).toHaveLength(2);
			expect(writers.map((row) => row.metadata.writer).sort()).toEqual([
				"autofix",
				"format",
			]);
		} finally {
			fixture.cleanup();
		}
	});

	// #4309 F4: flush and read the production NDJSON sink, never a logger mock.
	it("records admitted and refused runner ids with an accurate empty-plan field", async () => {
		const fixture = adoptedFixture();
		try {
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			await dispatchForFile(
				makeCtx(fixture.file, fixture.sessionRoot),
				[{ mode: "all", runnerIds: ["tflint"] }],
				new RunnerRegistry(),
			);
			await flushLatencyLog();
			const rows = fs
				.readFileSync(getLatencyLogPath(), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const row = rows
				.reverse()
				.find(
					(row) =>
						row.phase === "dispatch_adopted_root_allowlist" &&
						row.filePath === fixture.file,
				);
			expect(row.metadata).toMatchObject({
				admitted: "",
				refused: "tflint",
				noAdmittedRunner: true,
			});
			const registry = new RunnerRegistry();
			registry.register(
				(await import("../../../clients/dispatch/runners/php-lint.js")).default,
			);
			await dispatchForFile(
				makeCtx(fixture.file, fixture.sessionRoot),
				[{ mode: "all", runnerIds: ["php-lint", "tflint"] }],
				registry,
			);
			const mixed = (
				await decisionRows(fixture.file, "dispatch_adopted_root_allowlist")
			).pop();
			expect(mixed.metadata).toMatchObject({
				admitted: "php-lint",
				refused: "tflint",
				noAdmittedRunner: false,
			});
		} finally {
			fixture.cleanup();
		}
	});

	// Recurrence this guards (PR #5238 review r3, coderabbit): the empty-group
	// return carried no `unconfirmedStatus`, so a write to a file whose every
	// planned runner the adopted root refuses read "✓ <Kind> clean" (master did
	// the same for Python and TypeScript). Nothing checked the file.
	it("reads an adopted file whose planned runners are all refused as not analyzed", async () => {
		const fixture = adoptedFixture();
		try {
			for (const [name, label] of [
				["Jenkinsfile", "Groovy"],
				["main.py", "Python"],
				["main.ts", "JavaScript/TypeScript"],
			] as const) {
				const file = path.join(fixture.adoptedRoot, name);
				fs.writeFileSync(file, "x\n");
				const result = await runPipeline(
					{
						filePath: file,
						cwd: fixture.adoptedRoot,
						projectRoot: fixture.sessionRoot,
						analysisRootMode: "adopted",
						toolName: "write",
						dbg: () => {},
						getFlag: () => false,
					},
					{
						biomeClient: new BiomeClient(),
						ruffClient: new RuffClient(),
						fixedThisTurn: new Set(),
						getFormatService: () => new FormatService("adopted-not-analyzed"),
					},
				);
				expect(result.output, name).toContain(
					`${label} unconfirmed — not analyzed (adopted analysis root`,
				);
				expect(result.output, name).not.toContain("clean");
			}
			// A plan of nothing refused nothing, and checked nothing either (#5258:
			// it used to claim nothing, which the all-clear line read as clean).
			const unplanned = await dispatchForFile(
				makeCtx(fixture.file, fixture.sessionRoot),
				[],
				new RunnerRegistry(),
			);
			expect(uncheckedReason(unplanned)).toBe(
				"no runner is planned for this file",
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("admits only the explicit allowlist and refuses an unlisted runner", () => {
		expect(ADOPTED_ROOT_RUNNER_ALLOWLIST).toContain("php-lint");
		expect(isAdoptedRootRunnerAdmitted("php-lint")).toBe(true);
		expect(isAdoptedRootRunnerAdmitted("fish-indent")).toBe(true);
		expect(isAdoptedRootRunnerAdmitted("eslint")).toBe(false);
		expect(isAdoptedRootRunnerAdmitted("tflint")).toBe(false);

		const filtered = filterGroupsForAdoptedRoot([
			{ mode: "all", runnerIds: ["eslint", "php-lint"] },
			{ mode: "all", runnerIds: ["eslint"] },
		]);
		expect(filtered).toEqual([{ mode: "all", runnerIds: ["php-lint"] }]);
	});

	it("narrows a partly admitted group to a copy and passes a fully admitted group through as the same object", () => {
		// Pins the partial-group split in `filterGroupsForAdoptedRoot` (#4365
		// batch 1 survivor: the `runnerIds.length === group.runnerIds.length`
		// test forced `false`, so every kept group was rebuilt as
		// `{ ...group, runnerIds }`). A group the admission list leaves whole must
		// reach dispatch untouched; a partly admitted group must keep its mode,
		// kind filter and semantic override, and must not change the caller's
		// plan in place.
		const whole = {
			mode: "fallback" as const,
			runnerIds: ["php-lint", "fish-indent"],
			semantic: "warning" as const,
		};
		const partial = {
			mode: "all" as const,
			runnerIds: ["eslint", "fish-indent", "tflint"],
			filterKinds: ["shell"] as const,
			semantic: "blocking" as const,
		};
		const plan = [whole, partial];

		const [keptWhole, keptPartial] = filterGroupsForAdoptedRoot(plan);

		expect(keptWhole).toBe(whole);
		expect(keptPartial).not.toBe(partial);
		expect(keptPartial).toEqual({
			mode: "all",
			runnerIds: ["fish-indent"],
			filterKinds: ["shell"],
			semantic: "blocking",
		});
		expect(partial.runnerIds).toEqual(["eslint", "fish-indent", "tflint"]);
		expect(plan).toEqual([whole, partial]);
	});

	it("runs an allowlisted runner for an adopted root and refuses a config-as-code linter", async () => {
		const fixture = adoptedFixture();
		try {
			const registry = new RunnerRegistry();
			const eslintMarker = path.join(fixture.adoptedRoot, "eslint-ran");
			const eslintRun = vi.fn(async () => {
				fs.writeFileSync(eslintMarker, "ran");
				return {
					status: "succeeded" as const,
					diagnostics: [],
					semantic: "none" as const,
				};
			});
			// `appliesTo` includes the file kind, so the ONLY reason this runner does
			// not run is the adopted-root allowlist (not a kind mismatch).
			registry.register({
				id: "eslint",
				appliesTo: ["php"],
				priority: 1,
				run: eslintRun,
			});
			// The real allowlisted runner, loaded after the safe-spawn mock.
			const { default: phpLintRunner } =
				await import("../../../clients/dispatch/runners/php-lint.js");
			registry.register(phpLintRunner);

			const ctx = makeCtx(fixture.file, fixture.sessionRoot);
			const result = await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["php-lint", "eslint"] }],
				registry,
			);

			// Allowlisted runner reached the file and its finding surfaced.
			expect(result.blockers.length).toBeGreaterThan(0);
			expect(result.blockers[0]?.tool).toBe("php-lint");
			// The config-as-code linter never ran.
			expect(eslintRun).not.toHaveBeenCalled();
			expect(fs.existsSync(eslintMarker)).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	it("never probes or runs a project-local binary for an adopted root, even when the session is trusted", async () => {
		const fixture = adoptedFixture();
		try {
			setProjectTrustState("trusted");
			// A project-local interpreter that would write a marker if executed.
			const venvBinDir = path.join(fixture.adoptedRoot, ".venv", "bin");
			fs.mkdirSync(venvBinDir, { recursive: true });
			const marker = path.join(fixture.adoptedRoot, "project-local-php-ran");
			const localPhp = path.join(venvBinDir, "php");
			fs.writeFileSync(
				localPhp,
				`#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
			);
			fs.chmodSync(localPhp, 0o755);

			const registry = new RunnerRegistry();
			const { default: phpLintRunner } =
				await import("../../../clients/dispatch/runners/php-lint.js");
			registry.register(phpLintRunner);

			const ctx = makeCtx(fixture.file, fixture.sessionRoot);
			await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["php-lint"] }],
				registry,
			);

			expect(fs.existsSync(marker)).toBe(false);
			expect(
				spawnCalls.some((call) =>
					call.cmd.includes(`${path.sep}.venv${path.sep}`),
				),
			).toBe(false);
			// The global PATH binary was the one resolved.
			expect(
				spawnCalls.some(
					(call) => call.cmd === "php" || call.cmd.startsWith(globalEnv.tmpDir),
				),
			).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});

	it("keeps the trusted session path unchanged for a session-root file", async () => {
		const env = setupTestEnvironment("pi-lens-adopted-runners-session-");
		try {
			setProjectTrustState("trusted");
			const file = path.join(env.tmpDir, "broken.php");
			fs.writeFileSync(file, "<?php function (\n");
			const registry = new RunnerRegistry();
			const { default: phpLintRunner } =
				await import("../../../clients/dispatch/runners/php-lint.js");
			registry.register(phpLintRunner);
			const ctx = createDispatchContext(
				file,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
				undefined,
				undefined,
				env.tmpDir,
			);
			expect(ctx.analysisRootMode).not.toBe("adopted");
			const result = await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["php-lint"] }],
				registry,
			);
			expect(result.blockers[0]?.tool).toBe("php-lint");
		} finally {
			env.cleanup();
		}
	});

	it("excludes an adopted-root file from turn-end automatic test selection", () => {
		const fixture = adoptedFixture();
		try {
			expect(isExcludedTestTarget(fixture.file, fixture.sessionRoot)).toBe(
				true,
			);
			// Existing in-session behavior is untouched.
			fs.mkdirSync(path.join(fixture.sessionRoot, "src"), { recursive: true });
			const sessionFile = path.join(
				fixture.sessionRoot,
				"src",
				"index.test.ts",
			);
			fs.writeFileSync(sessionFile, "it('x', () => {});\n");
			expect(isExcludedTestTarget(sessionFile, fixture.sessionRoot)).toBe(
				false,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("writes no project-data record under the adopted root", async () => {
		const fixture = adoptedFixture();
		try {
			const registry = new RunnerRegistry();
			const { default: phpLintRunner } =
				await import("../../../clients/dispatch/runners/php-lint.js");
			registry.register(phpLintRunner);
			const ctx = makeCtx(fixture.file, fixture.sessionRoot);
			await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["php-lint"] }],
				registry,
			);
			expect(fs.existsSync(path.join(fixture.adoptedRoot, ".pi-lens"))).toBe(
				false,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("refuses every runner when the adopted allowlist admits none", async () => {
		const fixture = adoptedFixture();
		try {
			const registry = new RunnerRegistry();
			const run = vi.fn(async () => ({
				status: "succeeded" as const,
				diagnostics: [],
				semantic: "none" as const,
			}));
			registry.register({
				id: "tflint",
				appliesTo: ["php"],
				priority: 1,
				run,
			} as RunnerDefinition);
			const ctx = makeCtx(fixture.file, fixture.sessionRoot);
			const result = await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["tflint"] }],
				registry,
			);
			expect(run).not.toHaveBeenCalled();
			expect(result.diagnostics).toEqual([]);
		} finally {
			fixture.cleanup();
		}
	});

	// #4242 remainder, MCP half: `pilens_analyze` (and the warm hook route) keeps a
	// per-cwd warm word index, so the same refusal applies when the analyzed file
	// lives in an adopted root — the index belongs to `cwd`, not to the file.
	it("leaves the warm word index of the workspace unchanged for an adopted-root analyze", async () => {
		const fixture = adoptedFixture();
		try {
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			const sessionFile = path.join(fixture.sessionRoot, "session-widget.sh");
			const sessionContent = "session_widget() { echo widget; }\n";
			fs.writeFileSync(sessionFile, sessionContent);
			saveProjectSnapshot(fixture.sessionRoot, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: fixture.sessionRoot,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
				wordIndex: serializeWordIndex(
					buildWordIndex([{ path: sessionFile, content: sessionContent }]),
				),
			});
			flushProjectSnapshotPersistsForTests();

			const adoptedFile = path.join(fixture.adoptedRoot, "adopted-widget.sh");
			fs.writeFileSync(adoptedFile, "adopted_widget() { echo widget; }\n");
			const result = await analyzeFile(adoptedFile, fixture.sessionRoot, {
				warmLsp: false,
				record: false,
				updateGraph: true,
				flags: { "no-lsp": true, "no-autofix": true },
			});
			expect(result.hasBlockers).toBe(false);

			const lease = acquireWarmWordIndex(fixture.sessionRoot);
			try {
				expect(lease.index?.docCount).toBe(1);
				expect(
					wordIndexPostingHits(lease.index!, "widget").map((hit) => hit.file),
				).toEqual([sessionFile]);
			} finally {
				lease.release();
			}
			expect(
				(await decisionRows(adoptedFile, "adopted_root_writer_skipped")).map(
					(row) => row.metadata.writer,
				),
			).toContain("word-index");

			// The allow direction: a file of the workspace itself still enters the
			// warm index. Recurrence: an over-refusing gate (inverted or always
			// refusing) stops the warm index receiving every in-workspace file and
			// stays green when only the refusal is asserted (#4775 F2).
			const gadgetFile = path.join(fixture.sessionRoot, "session-gadget.md");
			fs.writeFileSync(gadgetFile, "# Gadget notes\n");
			await analyzeFile(gadgetFile, fixture.sessionRoot, {
				warmLsp: false,
				record: false,
				updateGraph: true,
				flags: { "no-lsp": true, "no-autofix": true },
			});
			const afterSession = acquireWarmWordIndex(fixture.sessionRoot);
			try {
				expect(afterSession.index?.docCount).toBe(2);
				expect(
					wordIndexPostingHits(afterSession.index!, "gadget").map(
						(hit) => hit.file,
					),
				).toEqual([gadgetFile]);
			} finally {
				afterSession.release();
			}
		} finally {
			fixture.cleanup();
		}
	});

	// Recurrence (#4775 F1): the refusal record was written before asking whether
	// a warm index exists, so a cold process logged a skipped write that had no
	// target and spent the file's first rising-edge record on it.
	it("records no word-index refusal for an adopted-root analyze when no warm index exists", async () => {
		const fixture = adoptedFixture();
		try {
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			const adoptedFile = path.join(fixture.adoptedRoot, "adopted-cold.sh");
			fs.writeFileSync(adoptedFile, "adopted_cold() { echo cold; }\n");
			await analyzeFile(adoptedFile, fixture.sessionRoot, {
				warmLsp: false,
				record: false,
				updateGraph: true,
				flags: { "no-lsp": true, "no-autofix": true },
			});
			const lease = acquireWarmWordIndex(fixture.sessionRoot);
			try {
				expect(lease.index).toBeUndefined();
			} finally {
				lease.release();
			}
			expect(
				(await decisionRows(adoptedFile, "adopted_root_writer_skipped")).map(
					(row) => row.metadata.writer,
				),
			).not.toContain("word-index");
		} finally {
			fixture.cleanup();
		}
	});

	// #4242 remainder, pi half: the per-edit cascade's word-index update is
	// SESSION state, so a file in an adopted (read-only) root must not enter it.
	// Driven through the real write pipeline, whose deferred cascade the host
	// runs unawaited.
	it("leaves the session word index unchanged for an adopted-root edit", async () => {
		const fixture = adoptedFixture();
		try {
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			const sessionFile = path.join(fixture.sessionRoot, "session-widget.ts");
			const sessionContent = "export function sessionWidget() { return 1; }\n";
			fs.writeFileSync(sessionFile, sessionContent);
			const wordIndex = buildWordIndex([
				{ path: sessionFile, content: sessionContent },
			]);
			expect(wordIndex.docCount).toBe(1);

			const adoptedFile = path.join(fixture.adoptedRoot, "adopted-widget.sh");
			fs.writeFileSync(adoptedFile, "adopted_widget() { echo widget; }\n");
			const onWordIndexUpdated = vi.fn();

			const result = await runPipeline(
				{
					filePath: adoptedFile,
					cwd: fixture.adoptedRoot,
					projectRoot: fixture.sessionRoot,
					analysisRootMode: "adopted",
					toolName: "write",
					dbg: () => {},
					getFlag: () => false,
					wordIndex,
					onWordIndexUpdated,
				},
				{
					biomeClient: new BiomeClient(),
					ruffClient: new RuffClient(),
					fixedThisTurn: new Set(),
					getFormatService: () => new FormatService("adopted-word-index"),
				},
			);
			await result.cascadePromise;

			expect(wordIndex.docCount).toBe(1);
			expect(
				wordIndexPostingHits(wordIndex, "widget").map((hit) => hit.file),
			).toEqual([sessionFile]);
			expect(onWordIndexUpdated).not.toHaveBeenCalled();
			expect(
				(await decisionRows(adoptedFile, "adopted_root_writer_skipped")).map(
					(row) => row.metadata.writer,
				),
			).toContain("word-index");
		} finally {
			fixture.cleanup();
		}
	});
});
