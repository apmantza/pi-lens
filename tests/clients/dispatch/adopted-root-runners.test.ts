/**
 * #4242 phase A (per-file linters): an adopted analysis root runs only the
 * explicit allowlist of config-free, code-free dispatch runners, and only from
 * global or pi-lens-managed binaries.
 *
 * The witnesses go through the real dispatch entry and the real `php-lint`
 * runner. Only the external child process (`safe-spawn`) is doubled; the trust
 * seam and `createVenvFinder` are the real modules.
 */

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
		async (cmd: string, args: readonly string[] = []) => {
			spawnCalls.push({ cmd: String(cmd), args });
			if (args.includes("--version")) {
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
	const sessionEnv = setupTestEnvironment("pi-lens-adopted-session-");
	const adoptedEnv = setupTestEnvironment("pi-lens-adopted-project-");
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
	beforeEach(() => {
		spawnCalls.length = 0;
		safeSpawnAsync.mockClear();
		clearCoverageNoticeState();
		clearLatencyReports();
	});
	afterEach(() => {
		resetProjectTrust();
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
			expect(spawnCalls.some((call) => call.cmd === "php")).toBe(true);
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
});
