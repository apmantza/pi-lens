/**
 * #2413: a formatter whose executable is proven absent must surface as a typed
 * `unavailable` outcome — never a code failure. These tests exercise the REAL
 * seams: `formatFile` (resolver-proven absence AND the static-fallback ENOENT
 * belt), `runFormatPhase` (the deferred-drain feeder), and the widget footer.
 *
 * Pre-fix, every one of these paths collapsed an unavailable tool into
 * `success: false` — counted as a failed file, requeued, and rendered with a
 * red `fmt-failed` marker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

// formatters.ts owns a LOCAL `which` (availability-latched) that probes via
// `safeSpawnAsync("where"/"which", [cmd])`, so a not-found tool is simulated by
// making the probe exit nonzero — not by mocking the imported `which`.
const safeSpawnAsync = vi.fn();
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	which: vi.fn(async () => null),
}));

const WHICH_COMMANDS = new Set(["where", "which"]);
const isWhichProbe = (call: unknown[]) => WHICH_COMMANDS.has(call[0] as string);
/** Every real format spawn (i.e. not a `where`/`which` availability probe). */
const formatSpawns = () =>
	safeSpawnAsync.mock.calls.filter((c) => !isWhichProbe(c));

async function loadFormatters() {
	return import("../../clients/formatters.js");
}

describe("formatFile classifies an unavailable tool distinctly from a failure (#2413)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		// Default: every `where`/`which` probe reports the tool absent.
		safeSpawnAsync.mockResolvedValue({ status: 1, stdout: "", stderr: "" });
	});

	it("a resolver returning FORMATTER_UNAVAILABLE never spawns and is not a failure", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-seam-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "const x=1\n");
			const { formatFile, FORMATTER_UNAVAILABLE } = await loadFormatters();
			const formatter = {
				name: "synthetic",
				command: ["synthetic", "$FILE"],
				extensions: [".ts"],
				detect: async () => true,
				resolveCommand: async () => FORMATTER_UNAVAILABLE,
			};

			const result = await formatFile(filePath, formatter);

			expect(result.outcome).toBe("unavailable");
			expect(result.success).toBe(true);
			expect(result.changed).toBe(false);
			// The static fallback must never be spawned after proven absence.
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("real oxfmt with no executable resolves to unavailable, never spawning oxfmt", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-oxfmt-");
		const originalPath = process.env.PATH;
		try {
			// getToolPath also checks PATH without using the mocked which seam.
			// Pin that independent input so npm's script-local node_modules/.bin
			// prefix cannot turn this absence case into a formatter spawn on CI.
			process.env.PATH = path.join(env.tmpDir, "empty-bin");
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "const x=1\n");

			// No node_modules/.bin/oxfmt under the temp dir, and every `where oxfmt`
			// probe exits 1 — the exact reported ENOENT trap. The resolver must now
			// prove the tool unavailable rather than hand bare `oxfmt` to the spawn.
			const { formatFile, oxfmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, oxfmtFormatter);

			expect(result.outcome).toBe("unavailable");
			expect(result.success).toBe(true);
			// A which-probe is allowed; a FORMAT spawn of oxfmt is not.
			expect(formatSpawns()).toEqual([]);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			env.cleanup();
		}
	});

	it("real oxfmt stays unavailable even on a box whose HOME contains its own node_modules/.bin/oxfmt (#2514)", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-oxfmt-home-");
		// Reproduces the exact reported trap without touching the real
		// maintainer HOME: pin HOME/USERPROFILE to a throwaway temp dir that
		// itself carries a `node_modules/.bin/oxfmt` (the shape the home-level
		// pi-extensions manifest installs), then format a file under an
		// UNRELATED project nested inside that fake home. Pre-#2514,
		// `findInNodeModules`'s ancestor walk had no HOME ceiling, so climbing
		// from the project past its own (empty) node_modules found the
		// home-level stray and handed it to `resolveCommand` as "the project's
		// oxfmt" — spawning it instead of declaring the tool unavailable.
		const fakeHome = env.tmpDir;
		const projectDir = path.join(fakeHome, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		const filePath = path.join(projectDir, "a.ts");
		fs.writeFileSync(filePath, "const x=1\n");

		const homeBinDir = path.join(fakeHome, "node_modules", ".bin");
		fs.mkdirSync(homeBinDir, { recursive: true });
		fs.writeFileSync(path.join(homeBinDir, "oxfmt.cmd"), "@ECHO off\r\n");
		fs.writeFileSync(path.join(homeBinDir, "oxfmt"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});

		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		const originalPath = process.env.PATH;
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		// Pin the installer's independent PATH leg as well as HOME. The test
		// mocks which(), but npm test prepends the repository bin to PATH.
		process.env.PATH = path.join(fakeHome, "empty-bin");
		try {
			const { formatFile, oxfmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, oxfmtFormatter);

			expect(result.outcome).toBe("unavailable");
			expect(result.success).toBe(true);
			// The home-level bin must never be spawned as "the project's" oxfmt.
			expect(formatSpawns()).toEqual([]);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			env.cleanup();
		}
	});

	/**
	 * #2544 review F1, through the same production seam as the case above.
	 *
	 * `isAtOrAboveHomeDir` used to compare `dir === home` case-SENSITIVELY and
	 * then demand `path.relative(dir, home) !== ""`. On win32 those two clauses
	 * disagree for the lowercase-drive form VS Code URIs produce (`c:\Users\…`,
	 * the form 46 records of a real `latency.log` carry): equality misses,
	 * `path.relative` folds the case to `""`, and the `rel !== ""` clause then
	 * rejects it — so the ceiling reported "not at home" for HOME itself and
	 * `oxfmtFormatter.resolveCommand` picked up the home-level stray after all.
	 *
	 * No skip: the assertion is two-sided because both platform behaviours are
	 * load-bearing. win32 must fold the re-spelling (or the ceiling is bypassed);
	 * POSIX must NOT fold it, because `<tmp>/HOME` really is a different
	 * directory there and `<tmp>/home`'s `node_modules/.bin` is then an ordinary
	 * project-ancestor install that MUST still resolve.
	 */
	it("a HOME spelled with the other drive-letter case still ceilings oxfmt on win32, and stays case-sensitive on POSIX (#2544 F1)", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-oxfmt-drivecase-");
		const isWin = process.platform === "win32";
		const realHome = env.tmpDir;
		const projectDir = path.join(realHome, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		const filePath = path.join(projectDir, "a.ts");
		fs.writeFileSync(filePath, "const x=1\n");

		const homeBinDir = path.join(realHome, "node_modules", ".bin");
		fs.mkdirSync(homeBinDir, { recursive: true });
		fs.writeFileSync(path.join(homeBinDir, "oxfmt.cmd"), "@ECHO off\r\n");
		fs.writeFileSync(path.join(homeBinDir, "oxfmt"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		const homeBin = path.join(homeBinDir, isWin ? "oxfmt.cmd" : "oxfmt");

		// win32: same directory, other drive-letter case + other separator form.
		// POSIX: no drive letter and case-sensitive paths, so re-casing the last
		// segment names a genuinely DIFFERENT directory.
		const respelledHome = isWin
			? realHome
					.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`)
					.split(path.sep)
					.join("/")
			: path.join(
					path.dirname(realHome),
					path.basename(realHome).toUpperCase(),
				);
		expect(respelledHome).not.toBe(realHome);

		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = respelledHome;
		process.env.USERPROFILE = respelledHome;
		try {
			const { formatFile, oxfmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, oxfmtFormatter);

			if (isWin) {
				expect(result.outcome).toBe("unavailable");
				expect(result.success).toBe(true);
				expect(formatSpawns()).toEqual([]);
			} else {
				expect(result.outcome).not.toBe("unavailable");
				expect(formatSpawns().map((c) => c[0])).toEqual([homeBin]);
			}
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			env.cleanup();
		}
	});

	it("real php-cs-fixer with no vendor/bin and no PATH binary resolves to unavailable, never spawning fix (#2472 review F4)", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-phpcsfixer-");
		try {
			const filePath = path.join(env.tmpDir, "app.php");
			fs.writeFileSync(filePath, "<?php\n");

			// No vendor/bin/php-cs-fixer under the temp dir, and every
			// `where php-cs-fixer` probe exits 1 (the beforeEach default) — both
			// probes `resolveCommand` runs have proven the binary absent. Pre-fix
			// this returned `null`, which falls back to the static bare
			// `php-cs-fixer` command and re-spawns the exact binary just proven
			// missing (one wasted spawn caught by the tool-not-found belt).
			const { formatFile, phpCsFixerFormatter } = await loadFormatters();
			const result = await formatFile(filePath, phpCsFixerFormatter);

			expect(result.outcome).toBe("unavailable");
			expect(result.success).toBe(true);
			// A which-probe is allowed; a FORMAT spawn of php-cs-fixer is not.
			expect(formatSpawns()).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("static-fallback spawn tool-not-found is unavailable, not a failure (belt)", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-belt-");
		try {
			const filePath = path.join(env.tmpDir, "a.py");
			fs.writeFileSync(filePath, "x=1\n");

			// black only probes a venv; with none it returns null and legitimately
			// falls back to the bare static `black`. When that binary is missing,
			// the spawn boundary reports a typed tool-not-found failure — which is
			// unavailable infrastructure, not a formatting failure.
			safeSpawnAsync.mockResolvedValue({
				status: null,
				stdout: "",
				stderr: "",
				error: new Error("spawn black ENOENT"),
				failure: "spawn",
				spawnFailure: {
					kind: "tool-not-found",
					message: "Cannot spawn black: tool not found (spawn black ENOENT)",
				},
			});

			const { formatFile, blackFormatter } = await loadFormatters();
			const result = await formatFile(filePath, blackFormatter);

			expect(safeSpawnAsync).toHaveBeenCalled(); // the static attempt happened
			expect(result.outcome).toBe("unavailable");
			expect(result.success).toBe(true);
			expect(result.changed).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("preserves a real nonzero-exit failure as outcome=failed", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-realfail-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");
			// A tool that RAN and exited nonzero — never an availability problem.
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: 'Error: unknown command "hcl" for "terragrunt"',
			});

			const { formatFile, terragruntHclFormatter } = await loadFormatters();
			const result = await formatFile(filePath, terragruntHclFormatter);

			expect(result.outcome).toBe("failed");
			expect(result.success).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("a clean rewrite is outcome=formatted, an unchanged run is outcome=unchanged", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-ok-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals   {}\n");
			const { formatFile, terragruntHclFormatter } = await loadFormatters();

			safeSpawnAsync.mockImplementation(async () => {
				fs.writeFileSync(filePath, "locals {}\n");
				return { status: 0, stdout: "", stderr: "" };
			});
			const changedResult = await formatFile(filePath, terragruntHclFormatter);
			expect(changedResult.outcome).toBe("formatted");
			expect(changedResult.changed).toBe(true);

			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
			const noopResult = await formatFile(filePath, terragruntHclFormatter);
			expect(noopResult.outcome).toBe("unchanged");
			expect(noopResult.changed).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

describe("runFormatPhase feeds the deferred drain (#2413)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("routes unavailable out of formatFailures and records it once, distinctly", async () => {
		const { runFormatPhase } = await import("../../clients/pipeline.js");
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../clients/degradation-ledger.js");
		resetDegradationLedger();

		const filePath = path.join(process.cwd(), "unavailable-fixture.ts");
		const fakeService = {
			recordRead: () => {},
			formatFile: async () => ({
				filePath,
				formatters: [
					{
						name: "oxfmt",
						success: true,
						changed: false,
						outcome: "unavailable" as const,
						error: "oxfmt: formatter executable not found",
					},
				],
				anyChanged: false,
				allSucceeded: true,
			}),
		};

		const result = await runFormatPhase(
			filePath,
			() => fakeService as never,
			() => {},
		);

		// Never a formatter FAILURE, and never listed as a formatter that ran.
		expect(result.formatFailures).toEqual([]);
		expect(result.formattersUsed).toEqual([]);
		expect(result.formatUnavailable).toEqual([
			{ formatter: "oxfmt", reason: "oxfmt: formatter executable not found" },
		]);

		// Observability: a distinct `formatter-unavailable` ledger kind — NOT the
		// `formatter-failure` bucket (recurring defect shape 10).
		const kinds = getDegradationSummary().map((g) => g.kind);
		expect(kinds).toContain("formatter-unavailable");
		expect(kinds).not.toContain("formatter-failure");
	});

	it("still routes a real failure into formatFailures", async () => {
		const { runFormatPhase } = await import("../../clients/pipeline.js");
		const filePath = path.join(process.cwd(), "failing-fixture.ts");
		const fakeService = {
			recordRead: () => {},
			formatFile: async () => ({
				filePath,
				formatters: [
					{
						name: "biome",
						success: false,
						changed: false,
						outcome: "failed" as const,
						error: "biome exited with status 2",
					},
				],
				anyChanged: false,
				allSucceeded: false,
			}),
		};

		const result = await runFormatPhase(
			filePath,
			() => fakeService as never,
			() => {},
		);

		expect(result.formatUnavailable).toEqual([]);
		expect(result.formatFailures).toEqual([
			"biome: biome exited with status 2",
		]);
	});
});

describe("widget footer never marks an unavailable tool as failed (#2413)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	const theme = { fg: (_color: string, s: string) => s };

	it("never marks an unavailable formatter fmt-failed, even when success is false", async () => {
		const { recordFormatter, renderWidget, clearWidgetState } =
			await import("../../clients/widget-state.js");
		clearWidgetState();

		// The production combo (success:true) already avoids the marker, so to
		// prove the guard is load-bearing this records the harder case: an
		// `unavailable` outcome carried on a success:false record must STILL never
		// earn the red `fmt-failed` marker (recurring defect shape 10).
		const unavailPath = path.join(process.cwd(), "unavail.ts");
		recordFormatter(unavailPath, "oxfmt", false, false, "unavailable");

		// A genuine failure keeps its marker.
		const failedPath = path.join(process.cwd(), "failed.ts");
		recordFormatter(failedPath, "biome", false, false, "failed");

		// Narrow width -> vertical rows, which carry the fmt-failed marker.
		const rendered = renderWidget(60, theme).join("\n");

		expect(rendered).not.toContain("fmt-failed:oxfmt");
		expect(rendered).toContain("fmt-failed:biome");
	});
});
