/**
 * #703: `getProjectIgnoreMatcher` must honor git's "a tracked file is never
 * ignored" rule for the `global`/`gitignore` layers, while still letting a
 * `.pi-lens.json` (`pilens` layer) pattern exclude a tracked file — that
 * layer is pi-lens-native intent, not a git emulation.
 *
 * These are real-git-repo tests (execFileSync git init/add/commit), following
 * the same fixture shape as `git-tracked-ignore.test.ts` (#701).
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetTrackedFilesCacheForTests,
	parseTrackedFilesOutput,
} from "../../clients/git-tracked-ignore.js";
import {
	createProjectIgnoreMatcher,
	getProjectIgnoreMatcher,
} from "../../clients/file-utils.js";
import { collectSourceFilesAsync } from "../../clients/source-filter.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

function initGitRepo(cwd: string): void {
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
}

function commitFile(cwd: string, relativePath: string): void {
	// `-f`: a file matching `.gitignore` (this suite's whole point) needs
	// force-add to get tracked at all — exactly the "force-tracked despite a
	// matching ignore pattern" scenario #703 describes.
	execFileSync("git", ["add", "-f", relativePath], { cwd });
	execFileSync("git", ["commit", "-q", "-m", `add ${relativePath}`], { cwd });
}

describe("tracked-aware ignore matcher (#703)", () => {
	beforeEach(() => {
		_resetTrackedFilesCacheForTests();
		resetProjectLensConfigCache();
	});
	afterEach(() => {
		_resetTrackedFilesCacheForTests();
		resetProjectLensConfigCache();
	});

	it("does NOT ignore a tracked file matching a .gitignore pattern once primed", async () => {
		const env = setupTestEnvironment("pi-lens-tracked-ignore-");
		try {
			initGitRepo(env.tmpDir);
			const trackedPath = createTempFile(
				env.tmpDir,
				"clients/test-runner-client.ts",
				"export const x = 1;\n",
			);
			commitFile(env.tmpDir, "clients/test-runner-client.ts");
			createTempFile(env.tmpDir, ".gitignore", "test-*.ts\n");

			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			// Sanity: the pattern really does match syntactically.
			expect(matcher.isIgnored(trackedPath, false)).toBe(true);

			await matcher.ensureTrackedIndex();
			expect(matcher.isIgnored(trackedPath, false)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("ignores the same tracked file when the matcher is never primed (fail-open, documents degrade-to-pattern-only)", async () => {
		const env = setupTestEnvironment("pi-lens-tracked-ignore-unprimed-");
		try {
			initGitRepo(env.tmpDir);
			const trackedPath = createTempFile(
				env.tmpDir,
				"clients/test-runner-client.ts",
				"export const x = 1;\n",
			);
			commitFile(env.tmpDir, "clients/test-runner-client.ts");
			createTempFile(env.tmpDir, ".gitignore", "test-*.ts\n");

			// Fresh matcher instance, `ensureTrackedIndex()` deliberately never
			// awaited — sync callers that never prime must keep today's
			// pattern-only behavior.
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(trackedPath, false)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("still ignores a tracked file matching a .pi-lens.json pattern (pilens layer excludes regardless of tracked status)", async () => {
		const env = setupTestEnvironment("pi-lens-tracked-ignore-pilens-");
		try {
			initGitRepo(env.tmpDir);
			const trackedPath = createTempFile(
				env.tmpDir,
				"clients/test-runner-client.ts",
				"export const x = 1;\n",
			);
			createTempFile(
				env.tmpDir,
				".pi-lens.json",
				JSON.stringify({ ignore: ["test-*.ts"] }),
			);
			commitFile(env.tmpDir, "clients/test-runner-client.ts");

			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			await matcher.ensureTrackedIndex();
			// Unlike the .gitignore-layer case above, a .pi-lens.json match keeps
			// excluding even though the file is primed-and-tracked.
			expect(matcher.isIgnored(trackedPath, false)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("still ignores an untracked file matching .gitignore (unchanged behavior)", async () => {
		const env = setupTestEnvironment("pi-lens-tracked-ignore-untracked-");
		try {
			initGitRepo(env.tmpDir);
			createTempFile(env.tmpDir, ".gitignore", "test-*.ts\n");
			const untrackedPath = createTempFile(
				env.tmpDir,
				"clients/test-scratch.ts",
				"export const y = 1;\n",
			);

			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			await matcher.ensureTrackedIndex();
			expect(matcher.isIgnored(untrackedPath, false)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("negation still wins last-match-wins across layers once primed", async () => {
		const env = setupTestEnvironment("pi-lens-tracked-ignore-negation-");
		try {
			initGitRepo(env.tmpDir);
			createTempFile(env.tmpDir, ".gitignore", "fixtures/**\n");
			createTempFile(
				env.tmpDir,
				".pi-lens.json",
				JSON.stringify({ ignore: ["!fixtures/keep.ts"] }),
			);
			const keepPath = createTempFile(
				env.tmpDir,
				"fixtures/keep.ts",
				"export const z = 1;\n",
			);
			const noisePath = createTempFile(
				env.tmpDir,
				"fixtures/noise.ts",
				"export const w = 1;\n",
			);
			// Only `keep.ts` is tracked. The negation must win regardless of
			// tracked status here — the LAST matching pattern (the pilens
			// negation) determines the verdict, and a negated match is never
			// "ignored" in the first place, tracked or not. `noise.ts` stays
			// untracked so its `.gitignore`-layer match is unaffected by #703's
			// tracked-rescue (which only applies to files git actually knows
			// about) and still gets excluded as before.
			commitFile(env.tmpDir, "fixtures/keep.ts");

			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			await matcher.ensureTrackedIndex();
			expect(matcher.isIgnored(keepPath, false)).toBe(false);
			expect(matcher.isIgnored(noisePath, false)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("degrades to pattern-only, no throw, outside a git repo", async () => {
		const env = setupTestEnvironment("pi-lens-tracked-ignore-nogit-");
		try {
			createTempFile(env.tmpDir, ".gitignore", "test-*.ts\n");
			const filePath = createTempFile(
				env.tmpDir,
				"clients/test-runner-client.ts",
				"export const x = 1;\n",
			);

			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			await expect(matcher.ensureTrackedIndex()).resolves.toBeUndefined();
			// No git repo ⇒ tracked status is unknowable ⇒ pattern-only verdict.
			expect(matcher.isIgnored(filePath, false)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("cross-separator paths resolve to the same tracked-rescue verdict", async () => {
		const env = setupTestEnvironment("pi-lens-tracked-ignore-sep-");
		try {
			initGitRepo(env.tmpDir);
			createTempFile(
				env.tmpDir,
				"clients/nested/test-deep.ts",
				"export const x = 1;\n",
			);
			commitFile(env.tmpDir, "clients/nested/test-deep.ts");
			createTempFile(env.tmpDir, ".gitignore", "test-*.ts\n");

			const matcher = createProjectIgnoreMatcher(env.tmpDir);
			await matcher.ensureTrackedIndex();

			// One separator form recorded via path.join (native), the other forced
			// to the opposite style — both must resolve to the same tracked-rescue
			// verdict (refs #703 constraint 6 / #210's normalizeMapKey precedent).
			const forwardSlashPath = `${env.tmpDir.replace(/\\/g, "/")}/clients/nested/test-deep.ts`;
			const backslashPath = path.join(
				env.tmpDir,
				"clients",
				"nested",
				"test-deep.ts",
			);

			expect(matcher.isIgnored(forwardSlashPath, false)).toBe(false);
			expect(matcher.isIgnored(backslashPath, false)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("Windows-cased lookup path still resolves the tracked-rescue verdict (#703 perf follow-up: normalizeEphemeralMapKey, not realpath)", async () => {
		// The tracked-set switched from `normalizeMapKey` (realpath-backed) to
		// `normalizeEphemeralMapKey` (cheap slash-fold + Windows-lowercase, no
		// fs I/O) for perf — this pins that an upper-cased lookup path still
		// finds the (lowercase-folded) tracked entry on win32, and is a no-op
		// assertion elsewhere (POSIX never folds case).
		const env = setupTestEnvironment("pi-lens-tracked-ignore-case-");
		try {
			initGitRepo(env.tmpDir);
			createTempFile(
				env.tmpDir,
				"clients/test-runner-client.ts",
				"export const x = 1;\n",
			);
			commitFile(env.tmpDir, "clients/test-runner-client.ts");
			createTempFile(env.tmpDir, ".gitignore", "test-*.ts\n");

			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			await matcher.ensureTrackedIndex();

			const upperCasedPath = path.join(
				env.tmpDir.toUpperCase(),
				"CLIENTS",
				"TEST-RUNNER-CLIENT.TS",
			);
			if (process.platform === "win32") {
				// The tracked-rescue must still apply: the syntactic fold
				// case-normalizes both sides of the comparison.
				expect(matcher.isIgnored(upperCasedPath, false)).toBe(false);
			} else {
				// POSIX is case-sensitive end to end (no fold applied, and
				// path.relative treats the differently-cased root as outside the
				// matcher's root entirely) — nothing meaningful to assert about
				// tracked-rescue here beyond "does not throw".
				expect(() => matcher.isIgnored(upperCasedPath, false)).not.toThrow();
			}
		} finally {
			env.cleanup();
		}
	});

	it("integration: a walk over the fixture repo includes the tracked pattern-matched file", async () => {
		const env = setupTestEnvironment("pi-lens-tracked-ignore-walk-");
		try {
			initGitRepo(env.tmpDir);
			createTempFile(
				env.tmpDir,
				"clients/test-runner-client.ts",
				"export const x = 1;\n",
			);
			commitFile(env.tmpDir, "clients/test-runner-client.ts");
			createTempFile(env.tmpDir, ".gitignore", "test-*.ts\n");
			createTempFile(env.tmpDir, "clients/real.ts", "export const y = 1;\n");

			const files = await collectSourceFilesAsync(env.tmpDir);
			const rel = files
				.map((f) => path.relative(env.tmpDir, f).replace(/\\/g, "/"))
				.sort();
			expect(rel).toContain("clients/test-runner-client.ts");
			expect(rel).toContain("clients/real.ts");
		} finally {
			env.cleanup();
		}
	});

	it("parseTrackedFilesOutput parses repo-relative lines into normalized ids, skipping blanks and excluded dirs", () => {
		const cwd = process.cwd();
		const ids = parseTrackedFilesOutput(
			["clients/tracked.ts", "", "node_modules/dep/index.js", "scripts/tmp.mjs"].join(
				"\n",
			),
			cwd,
		);
		expect(ids.size).toBe(2);
	});
});
