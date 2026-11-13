// flake-shape: real-process-spawn — the advisory scope (#3684) is the wrapper's own `git diff` against a real throwaway fixture repo, reached through its real argv/env; an in-process call cannot prove either boundary.
// #1718: the self-scan (scripts/run-astgrep-pi-lens.mjs) used to hardcode a
// single author's nonexistent machine paths as both scan target and rule
// source, so it silently scanned nothing in CI, ever. This is the
// registered-or-fail guard: it runs the REAL scan mechanism (the same
// scripts/lib/astgrep-self-scan.mjs the CLI wrapper uses) against a
// synthetic violation, independent of what pi-lens's own tree currently
// contains, so a future regression that makes the scan a no-op again fails
// HERE instead of dying silently a second time.
//
// The CLI is opt-in, mirroring ast-grep-catalog-rules.test.ts: if `ast-grep`
// is not on PATH the whole describe is skipped. `npm test`/`npm run` put
// node_modules/.bin on PATH, which is how the CLI resolves in CI and locally
// without a global install.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeSpawn } from "../../clients/safe-spawn.js";
import { envFor, gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import { copyFixtureGitHelper } from "../support/fixture-git-copy.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import {
	findingSignature,
	findingSignatures,
	findingsInTrackedFiles,
	findUnreasonedIgnores,
	loadBaseline,
	repoRoot,
	runRuleTests,
	runSelfScan,
	selfScanRuleIds,
	SUITES,
	suiteByName,
	trackedSelfScanFileSet,
	writeBaseline,
} from "../../scripts/lib/astgrep-self-scan.mjs";
import { setProjectTrustState } from "../../clients/project-trust.js";
import {
	expectPlantedStaleRow,
	rowsWithoutLiveMember,
} from "../support/baseline-staleness.js";

// #4530: the ast-grep CLI under test is this checkout's own devDependency, found
// through the test runner's `node_modules/.bin` PATH entry. That entry is the
// session repository's own bytes, which a bare lookup refuses until pi trusts
// the project. This file tests the tool, not trust, so it adopts trust the way
// the maintenance hosts do; the trust rule has its own suite.
setProjectTrustState("trusted");

const WRAPPER_PATH = path.join(
	repoRoot(),
	"scripts",
	"run-astgrep-pi-lens.mjs",
);

interface WrapperRun {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * Spawns the REAL CLI wrapper (`node scripts/run-astgrep-pi-lens.mjs`), not
 * scripts/lib/astgrep-self-scan.mjs's functions directly. #1729 review: the
 * lib-level tests above proved runSelfScan()'s return value is correct, but
 * left the wrapper's own control flow -- its try/catch around runSelfScan,
 * its process.exit() calls -- completely uncovered. A reviewer mutated the
 * catch block to `process.exit(0)` (the literal C:/Users/R3LiC hardcoded-path
 * defect this issue fixes: a scan that fails internally but reports success)
 * and the existing suite stayed green, because nothing exercised the
 * wrapper's own exit code. execFileSync spawns the actual file Node runs in
 * production/CI, so a regression in the wrapper's exit-code plumbing can
 * only be caught here.
 */
function runWrapper(
	args: string[],
	env?: Record<string, string>,
	cwd: string = repoRoot(),
): WrapperRun {
	try {
		const stdout = execFileSync(process.execPath, [WRAPPER_PATH, ...args], {
			cwd,
			encoding: "utf-8",
			env: { ...process.env, ...env },
		});
		return { status: 0, stdout, stderr: "" };
	} catch (e) {
		const err = e as {
			status?: number | null;
			stdout?: string;
			stderr?: string;
		};
		return {
			status: err.status ?? 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
		};
	}
}

function probeCli(): boolean {
	const result = safeSpawn("ast-grep", ["--version"]);
	return result.status === 0 && !result.error;
}

const cliAvailable = probeCli();
const d = cliAvailable ? describe : describe.skip;

// #448-style CI-loud guard: a describe.skip on a missing CLI must not vanish
// silently in CI.
it("ast-grep CLI is installed in CI", () => {
	if (process.env.CI) expect(cliAvailable).toBe(true);
});

d("pi-lens self-scan (#1718)", () => {
	it("at least one rule is tagged category: pi-lens-self-scan", () => {
		// A guard against the tag silently disappearing (e.g. a rule file
		// rewrite that drops the field): an empty rule set is a hard error
		// from runSelfScan, but this pins the count as a mutation-proof
		// symptom check independent of that throw.
		expect(selfScanRuleIds().length).toBeGreaterThan(0);
	});

	it("clients/ + tests/ scan has no untriaged finding", () => {
		const result = runSelfScan();
		const baseline = loadBaseline();
		const untriaged = result.findings.filter(
			(f) => !baseline.has(findingSignature(f)),
		);
		expect(untriaged, JSON.stringify(untriaged, null, 2)).toEqual([]);
	});

	it("scans a nonzero file count (a dead scan must not read as clean)", () => {
		const result = runSelfScan();
		expect(result.scannedFileCount).toBeGreaterThan(0);
	});

	// ── Mutation-proof probe: the scan itself must actually CATCH the shape
	// it claims to, on synthetic source outside pi-lens's own tree, so this
	// keeps failing even on a day pi-lens's own code happens to be clean. ──
	it("flags a synthetic no-raw-json-store-write violation outside the repo tree", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pilens-selfscan-"),
		);
		try {
			fs.writeFileSync(
				path.join(dir, "violation.ts"),
				[
					'import { writeFileSync } from "node:fs";',
					"function f(file: string, data: unknown) {",
					"  writeFileSync(file, JSON.stringify(data));",
					"}",
					"",
				].join("\n"),
				"utf-8",
			);
			const result = runSelfScan({
				root: repoRoot(),
				scanPaths: [dir],
				ruleIds: ["no-raw-json-store-write"],
			});
			expect(result.scannedFileCount).toBe(1);
			expect(result.findings.length).toBeGreaterThan(0);
			expect(result.findings[0]?.ruleId).toBe("no-raw-json-store-write");
		} finally {
			removeTempDirSync(dir);
		}
	});

	it("does not flag the atomic-write seam itself on the same synthetic snippet, negative control", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pilens-selfscan-"),
		);
		try {
			fs.writeFileSync(
				path.join(dir, "clean.ts"),
				[
					'import { writeFileAtomic } from "./atomic-write.js";',
					"function f(file: string, data: unknown) {",
					"  writeFileAtomic(file, JSON.stringify(data));",
					"}",
					"",
				].join("\n"),
				"utf-8",
			);
			const result = runSelfScan({
				root: repoRoot(),
				scanPaths: [dir],
				ruleIds: ["no-raw-json-store-write"],
			});
			expect(result.findings).toEqual([]);
		} finally {
			removeTempDirSync(dir);
		}
	});

	// #3684 r2: the registry-subset rule declares `severity: info` and the
	// spec says it must never gate. Recurrence guarded: a self-scan-tagged
	// advisory rule silently becoming a CI gate (r1: any unbaselined hit
	// exited 1 because the wrapper never consulted severity).
	it("reports an info-severity rule hit as advisory, not as a gating finding", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pilens-selfscan-advisory-"),
		);
		try {
			fs.writeFileSync(
				path.join(dir, "subset.ts"),
				'export const s = ["typescript", "python"];\n',
				"utf-8",
			);
			fs.writeFileSync(
				path.join(dir, "violation.ts"),
				[
					'import { writeFileSync } from "node:fs";',
					"function f(file: string, data: unknown) {",
					"  writeFileSync(file, JSON.stringify(data));",
					"}",
					"",
				].join("\n"),
				"utf-8",
			);
			const result = runSelfScan({
				root: repoRoot(),
				scanPaths: [dir],
				ruleIds: ["advisory-registry-subset", "no-raw-json-store-write"],
			});
			expect(result.findings.map((f) => f.ruleId)).toEqual([
				"no-raw-json-store-write",
			]);
			expect(result.advisoryFindings.map((f) => f.ruleId)).toEqual([
				"advisory-registry-subset",
			]);
		} finally {
			removeTempDirSync(dir);
		}
	});

	it("throws (never reads as a clean 0-finding scan) when ruleIds resolves empty", () => {
		expect(() => runSelfScan({ ruleIds: [] })).toThrow(/nothing to run/);
	});

	// ── Wrapper-process coverage (#1729 review round): exercises the actual
	// CLI entry point via execFileSync, not just the lib function it calls. ──
	describe("CLI wrapper process exit codes", () => {
		it("exits 0 on the real clients/ + tests/ scan", () => {
			const run = runWrapper([]);
			expect(run.status, run.stdout + run.stderr).toBe(0);
		});

		it("exits NONZERO when ast-grep itself fails (a broken sgconfig)", () => {
			const run = runWrapper([], {
				PI_LENS_SELF_SCAN_SGCONFIG: "does-not-exist.yml",
			});
			expect(run.status).not.toBe(0);
			expect(run.stderr).toMatch(/scan failed to run/);
		});

		it("exits NONZERO through the wrapper on a synthetic untriaged violation", () => {
			const dir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-pilens-selfscan-wrapper-"),
			);
			try {
				fs.writeFileSync(
					path.join(dir, "violation.ts"),
					[
						'import { writeFileSync } from "node:fs";',
						"function f(file: string, data: unknown) {",
						"  writeFileSync(file, JSON.stringify(data));",
						"}",
						"",
					].join("\n"),
					"utf-8",
				);
				const run = runWrapper([dir]);
				expect(run.status).not.toBe(0);
				expect(run.stderr).toMatch(/no-raw-json-store-write/);
			} finally {
				removeTempDirSync(dir);
			}
		});

		// #3684 option B (maintainer decision): the advisory registry-subset rule
		// reports only in files changed relative to a diff base. Recurrence
		// guarded: 26 pre-existing hits printing on every CI run (r2 head) and
		// burying the one hit a PR introduced.
		describe("advisory scope: files changed against a base", () => {
			const SUBSET = 'export const s = ["typescript", "python"];\n';
			const VIOLATION = [
				'import { writeFileSync } from "node:fs";',
				"function f(file: string, data: unknown) {",
				"  writeFileSync(file, JSON.stringify(data));",
				"}",
				"",
			].join("\n");
			// No inherited base: CI pull_request runs export GITHUB_BASE_REF.
			const NO_BASE_ENV = { GITHUB_BASE_REF: "" };

			function git(dir: string, ...args: string[]): string {
				return String(gitExecFileSync(args, { cwd: dir })).trim();
			}

			function commit(dir: string, message: string): string {
				git(dir, "add", "-A");
				git(
					dir,
					"-c",
					"user.email=pi-lens-test@example.com",
					"-c",
					"user.name=pi-lens-test",
					"commit",
					"-qm",
					message,
				);
				return git(dir, "rev-parse", "HEAD");
			}

			/** Base commit holds subset hits in changed.ts and unchanged.ts (plus
			 * a gating violation in gating.ts when asked); the head commit
			 * edits only changed.ts. Returns the temp repo and the base sha. */
			function makeRepo(withGating: boolean): { dir: string; base: string } {
				const dir = fs.mkdtempSync(
					path.join(os.tmpdir(), "pi-lens-pilens-selfscan-diff-"),
				);
				git(dir, "init", "-q");
				fs.writeFileSync(path.join(dir, "changed.ts"), SUBSET, "utf-8");
				fs.writeFileSync(path.join(dir, "unchanged.ts"), SUBSET, "utf-8");
				if (withGating) {
					fs.writeFileSync(path.join(dir, "gating.ts"), VIOLATION, "utf-8");
				}
				const base = commit(dir, "base");
				fs.appendFileSync(path.join(dir, "changed.ts"), "// touched\n");
				commit(dir, "head");
				return { dir, base };
			}

			it("prints an advisory hit in a changed file and exits 0", () => {
				const { dir, base } = makeRepo(false);
				try {
					const run = runWrapper(["--base", base, dir], NO_BASE_ENV, dir);
					expect(run.status, run.stdout + run.stderr).toBe(0);
					expect(run.stdout).toMatch(
						/advisory advisory-registry-subset .*changed\.ts:1/,
					);
				} finally {
					removeTempDirSync(dir);
				}
			});

			it("stays silent for an advisory hit in an unchanged file", () => {
				const { dir, base } = makeRepo(false);
				try {
					const run = runWrapper(["--base", base, dir], NO_BASE_ENV, dir);
					expect(run.status, run.stdout + run.stderr).toBe(0);
					// The scan ran (not a vacuous pass on a failed run) ...
					expect(run.stdout).toMatch(/scanned \d+ file\(s\)/);
					// ... and the unchanged file's hit is not reported.
					expect(run.stdout).not.toMatch(/unchanged\.ts/);
				} finally {
					removeTempDirSync(dir);
				}
			});

			it("reports every advisory hit with --all-advisory and no base", () => {
				const { dir } = makeRepo(false);
				try {
					const run = runWrapper(["--all-advisory", dir], NO_BASE_ENV, dir);
					expect(run.status, run.stdout + run.stderr).toBe(0);
					expect(run.stdout).toMatch(/advisory .*changed\.ts:1/);
					expect(run.stdout).toMatch(/advisory .*unchanged\.ts:1/);
				} finally {
					removeTempDirSync(dir);
				}
			});

			it("reports nothing, and says why, when there is no diff base", () => {
				const { dir } = makeRepo(false);
				try {
					const run = runWrapper([dir], NO_BASE_ENV, dir);
					expect(run.status, run.stdout + run.stderr).toBe(0);
					expect(run.stdout).not.toMatch(/advisory advisory-registry-subset/);
					expect(run.stdout).toMatch(/advisory hit\(s\) not reported/);
				} finally {
					removeTempDirSync(dir);
				}
			});

			// Recurrence guarded: macOS tmpdirs (/var -> /private/var) make the
			// scanned path and git's cwd-relative path differ as strings.
			it("matches a changed file scanned through a symlinked path", () => {
				const { dir, base } = makeRepo(false);
				const alias = `${dir}-alias`;
				try {
					fs.symlinkSync(dir, alias, "dir");
					const run = runWrapper(["--base", base, alias], NO_BASE_ENV, dir);
					expect(run.stdout).toMatch(/advisory .*changed\.ts:1/);
					expect(run.stdout).not.toMatch(/unchanged\.ts/);
				} finally {
					fs.rmSync(alias, { force: true });
					removeTempDirSync(dir);
				}
			});

			it("takes the base from GITHUB_BASE_REF as origin/<ref>", () => {
				const { dir, base } = makeRepo(false);
				try {
					git(dir, "update-ref", "refs/remotes/origin/main", base);
					const run = runWrapper([dir], { GITHUB_BASE_REF: "main" }, dir);
					expect(run.stdout).toMatch(/advisory .*changed\.ts:1/);
					expect(run.stdout).not.toMatch(/unchanged\.ts/);
				} finally {
					removeTempDirSync(dir);
				}
			});

			it("warns and still exits 0 when the base cannot be diffed", () => {
				const { dir } = makeRepo(false);
				try {
					const run = runWrapper(
						["--base", "no-such-ref", dir],
						NO_BASE_ENV,
						dir,
					);
					expect(run.status, run.stdout + run.stderr).toBe(0);
					expect(run.stdout + run.stderr).toMatch(/could not diff against/);
				} finally {
					removeTempDirSync(dir);
				}
			});

			it("still exits NONZERO for a gating hit in an unchanged file", () => {
				const { dir, base } = makeRepo(true);
				try {
					const run = runWrapper(["--base", base, dir], NO_BASE_ENV, dir);
					expect(run.status).not.toBe(0);
					expect(run.stderr).toMatch(/1 NEW finding/);
					expect(run.stderr).toMatch(/gating\.ts/);
					expect(run.stderr).not.toMatch(/advisory-registry-subset/);
				} finally {
					removeTempDirSync(dir);
				}
			});
		});
	});

	// Recurrence: a self-scan baseline row whose finding was fixed stayed
	// admitted, so a new hit with the same signature would pass silently. Only
	// the governance suite asserted this (planted row: the wrapper printed
	// "46 finding(s) ... (47 allowed entries)" and exited 0).
	it("every self-scan baseline row has a live finding", () => {
		const result = runSelfScan({});
		const tracked = trackedSelfScanFileSet(
			repoRoot(),
			suiteByName("self-scan").scanPaths,
		);
		const live = new Set(
			findingSignatures(findingsInTrackedFiles(result.findings, tracked)),
		);
		expect(rowsWithoutLiveMember(loadBaseline(), live)).toEqual([]);
		expect(result.scannedFileCount).toBeGreaterThan(1000);
	});
});

// #3886 r3: the wrapper passes the directory roots CI uses -- never a file
// list, so Windows' cmd.exe/CreateProcess line limits cannot fail a push --
// and drops findings whose file is not in `git ls-files`. A stub `ast-grep`
// records the argv it receives and emits findings only for the paths it was
// asked to scan, so both the argv shape and the tracked filter are observable
// without the real binary. An untracked plant must not gate; --update-baseline
// must keep the whole tree so triaging before `git add` writes a complete
// baseline.
describe("self-scan argv and tracked filter (#3886 r3)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			fs.rmSync(root, { recursive: true, force: true });
	});

	function git(root: string, ...args: string[]): string {
		return String(
			gitExecFileSync(
				[
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.com",
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ cwd: root, encoding: "utf8" },
			),
		).trim();
	}

	function put(root: string, rel: string, content: string) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf8");
	}

	// Emits a finding only for a spec file that a directory root contains or
	// that is named directly in argv, so a pre-fix file-list invocation cannot
	// see an untracked file and a directory invocation can.
	const STUB = [
		"#!/usr/bin/env node",
		'import fs from "node:fs";',
		"const args = process.argv.slice(2);",
		"fs.writeFileSync(process.env.STUB_ASTGREP_ARGV_FILE, JSON.stringify(args));",
		'const filterIdx = args.indexOf("--filter");',
		'const jsonIdx = args.indexOf("--json=compact");',
		"const paths = args.slice(filterIdx + 2, jsonIdx);",
		'const spec = JSON.parse(process.env.STUB_ASTGREP_FINDINGS || "[]");',
		"const out = [];",
		"for (const f of spec) {",
		"  const scanned = paths.some((p) => {",
		"    try {",
		'      if (fs.statSync(p).isDirectory()) return f.file === p || f.file.startsWith(p.endsWith("/") ? p : p + "/");',
		"    } catch {}",
		"    return p === f.file;",
		"  });",
		'  if (scanned) out.push({ ruleId: "no-raw-json-store-write", file: f.file, range: { start: { line: (f.line || 0) } }, severity: "warning", message: "stub" });',
		"}",
		'process.stderr.write("scannedFileCount=" + Math.max(paths.length, 1) + "\\neffectiveRuleCount=1\\n");',
		"process.stdout.write(JSON.stringify(out));",
	].join("\n");

	function makeFixture() {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-selfscan-stub-"),
		);
		roots.push(root);
		for (const rel of [
			"scripts/run-astgrep-pi-lens.mjs",
			"scripts/lib/astgrep-self-scan.mjs",
		])
			put(root, rel, fs.readFileSync(path.join(repoRoot(), rel), "utf8"));
		// The helper resolves the maintenance policy relative to its own module, so
		// the policy file is copied with it (#4552 R2).
		copyFixtureGitHelper(root);
		// The wrapper adopts project trust itself (#4530), so the trust module
		// it imports is linked too; Node resolves each link to its real path, so
		// the wrapper and the spawn seam share one trust state.
		for (const rel of [
			"clients/project-trust.js",
			"clients/safe-spawn.js",
			"clients/string-utils.js",
		]) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.symlinkSync(path.join(repoRoot(), rel), path.join(root, rel));
		}
		put(root, "rules/ast-grep-rules/.sgconfig.yml", "ruleDirs:\n  - ./rules\n");
		put(
			root,
			"rules/ast-grep-rules/rules/no-raw-json-store-write.yml",
			[
				"id: no-raw-json-store-write",
				"language: TypeScript",
				"severity: warning",
				"metadata:",
				"  category: pi-lens-self-scan",
				"message: stub",
				"rule:",
				"  pattern: writeFileSync($$$A)",
				"",
			].join("\n"),
		);
		put(root, "clients/tracked.ts", "export const tracked = 1;\n");
		put(root, "tests/clean.test.ts", "export const t = 1;\n");
		put(root, "clients/untracked.ts", "export const untracked = 1;\n");
		put(root, "bin/ast-grep", STUB);
		fs.chmodSync(path.join(root, "bin/ast-grep"), 0o755);
		git(root, "init", "-q");
		git(
			root,
			"add",
			"rules",
			"scripts",
			"clients/tracked.ts",
			"tests/clean.test.ts",
		);
		git(root, "commit", "-q", "-m", "base");
		return { root, argvFile: path.join(root, "argv.json") };
	}

	function runStubWrapper(
		root: string,
		findings: Array<{ file: string; line?: number }>,
		args: string[] = [],
	) {
		return spawnSync(
			process.execPath,
			[path.join(root, "scripts/run-astgrep-pi-lens.mjs"), ...args],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...envFor(root),
					PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
					STUB_ASTGREP_ARGV_FILE: path.join(root, "argv.json"),
					STUB_ASTGREP_FINDINGS: JSON.stringify(findings),
					PI_LENS_SELF_SCAN_SGCONFIG: path.join(
						root,
						"rules/ast-grep-rules/.sgconfig.yml",
					),
				},
			},
		);
	}

	it("passes directory roots to ast-grep, never a file list", () => {
		const fx = makeFixture();
		const run = runStubWrapper(fx.root, [{ file: "clients/tracked.ts" }]);
		const argv = JSON.parse(fs.readFileSync(fx.argvFile, "utf8")) as string[];
		expect(argv).toContain("clients");
		expect(argv).toContain("tests");
		expect(argv.filter((arg) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(arg))).toEqual(
			[],
		);
		// The scan really ran (not a dead scan) and the tracked finding gated.
		expect(run.status).toBe(1);
		expect(run.stderr).toMatch(/no-raw-json-store-write clients\/tracked\.ts/);
	});

	it("gates a tracked finding and ignores an untracked one", () => {
		const findings = [
			{ file: "clients/tracked.ts" },
			{ file: "clients/untracked.ts" },
		];
		const fx = makeFixture();
		const run = runStubWrapper(fx.root, findings);
		expect(run.status).toBe(1);
		expect(run.stderr).toMatch(/no-raw-json-store-write clients\/tracked\.ts/);
		expect(`${run.stdout}\n${run.stderr}`).not.toMatch(
			/clients\/untracked\.ts/,
		);
	});

	it("matches tracked findings across path spellings", () => {
		// ast-grep emits Windows-shaped paths on Windows; git ls-files always
		// emits forward slashes. The filter must match both.
		const tracked = new Set(["clients/tracked.ts"]);
		const findings = [
			{ file: "clients/tracked.ts" },
			{ file: "clients\\tracked.ts" },
			{ file: "./clients/tracked.ts" },
			{ file: "clients/untracked.ts" },
		];
		expect(
			findingsInTrackedFiles(findings, tracked).map((f) => f.file),
		).toEqual([
			"clients/tracked.ts",
			"clients\\tracked.ts",
			"./clients/tracked.ts",
		]);
	});

	it("--update-baseline includes untracked findings from the whole-tree scan", () => {
		const findings = [{ file: "clients/untracked.ts", line: 2 }];
		const fx = makeFixture();
		const run = runStubWrapper(fx.root, findings, ["--update-baseline"]);
		expect(run.status, run.stdout + run.stderr).toBe(0);
		const baseline = JSON.parse(
			fs.readFileSync(
				path.join(fx.root, "rules/ast-grep-rules/self-scan-baseline.json"),
				"utf8",
			),
		) as { allowed: string[] };
		expect(baseline.allowed).toContain(
			"no-raw-json-store-write::clients/untracked.ts::2",
		);
	});
});

// #4865: the governance suite (scripts/governance-rules/) runs through the same
// runner and baseline machinery. Recurrence guarded: shape 86, a test that waits
// for real I/O by counting turns (#4850 and #4830, fixed by #4852; #4969's
// shared persist helper; #4977's sequence-read test), each found by a flaky red
// or a bot review because no detector read the shape.
d("governance suite: turn-count-wait (#4865)", () => {
	const governance = suiteByName("governance");
	const GOVERNANCE_SGCONFIG = path.join(
		repoRoot(),
		"scripts",
		"governance-rules",
		"sgconfig.yml",
	);

	/** A scratch root holding `tests/<name>` with `source`, scanned the way the
	 * wrapper scans the tree: cwd at the root, a relative `tests` path, so the
	 * rule's `files: tests/**` population applies. */
	function scanScratch(name: string, source: string) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gov-scan-"));
		try {
			fs.mkdirSync(path.join(root, "tests"));
			fs.writeFileSync(path.join(root, "tests", name), source, "utf-8");
			const result = runSelfScan({
				root,
				suite: governance,
				scanPaths: ["tests"],
				ruleIds: selfScanRuleIds(repoRoot(), governance),
				sgConfigPath: GOVERNANCE_SGCONFIG,
			});
			return {
				lines: result.findings.map(
					(f) => `${f.ruleId}:${(f.range?.start?.line ?? -1) + 1}`,
				),
				scanned: result.scannedFileCount,
				offenders: findUnreasonedIgnores([`tests/${name}`], root),
			};
		} finally {
			removeTempDirSync(root);
		}
	}

	it("the rule tests pass: every planted member reds and every admitted form stays clean", () => {
		const run = runRuleTests(repoRoot(), governance);
		const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		expect(run.status, out).toBe(0);
		expect(out).toMatch(/PASS turn-count-wait /);
		expect(out).toMatch(/PASS turn-count-wait-test-hook /);
	});

	it("the tree has no untriaged member, and every baseline row has a reason and a live member", () => {
		const result = runSelfScan({ suite: governance });
		const tracked = trackedSelfScanFileSet(repoRoot(), governance.scanPaths);
		const findings = findingsInTrackedFiles(result.findings, tracked);
		const signatures = findingSignatures(findings, governance);
		// loadBaseline throws on a row without a reason.
		const baseline = loadBaseline(repoRoot(), governance);
		const untriaged = findings.filter((_f, i) => !baseline.has(signatures[i]));
		expect(untriaged, JSON.stringify(untriaged, null, 2)).toEqual([]);
		const live = new Set(signatures);
		expect(rowsWithoutLiveMember(baseline, live)).toEqual([]);
		expect(result.scannedFileCount).toBeGreaterThan(1000);
	});

	it("flags the pre-#4852 cells and an aliased pump through the real scan", () => {
		const { lines, scanned } = scanScratch(
			"cells.test.ts",
			[
				"async function cells(file: string) {",
				"	for (let i = 0; i < 5000 && !fs.existsSync(file); i++)",
				"		await new Promise<void>((resolve) => setImmediate(resolve));",
				"	for (let i = 0; i < 100 && vi.getTimerCount() === 0; i++)",
				"		await Promise.resolve();",
				"	const pump = () => new Promise((resolve) => setImmediate(resolve));",
				"	let turns = 0;",
				"	while (accepted.length === 0) {",
				"		await pump();",
				"		if (turns++ > 400) throw new Error('never accepted');",
				"	}",
				"	await waitFor(() => fs.existsSync(file), Boolean, { timeoutMs: 4_000 });",
				"}",
				"",
			].join("\n"),
		);
		expect(scanned).toBe(1);
		expect(lines).toEqual([
			"turn-count-wait:2",
			"turn-count-wait:4",
			"turn-count-wait:8",
		]);
	});

	it("a reasoned ignore exempts its loop; a bare one is refused on its own line and trailing", () => {
		const { lines, offenders } = scanScratch(
			"ignores.test.ts",
			[
				"async function ignores() {",
				"	// ast-grep-ignore: turn-count-wait -- fake connection releases one pull per turn",
				"	for (let i = 0; i < 50 && pending.length === 0; i++) await tick();",
				"	// ast-grep-ignore",
				"	for (let i = 0; i < 50 && pending.length === 0; i++) await tick();",
				"	for (let i = 0; i < 50 && pending.length === 0; i++) await tick(); // ast-grep-ignore",
				"	// ast-grep-ignore: turn-count-wait",
				"	for (let i = 0; i < 50 && pending.length === 0; i++) await tick();",
				"	const text = '// ast-grep-ignore';",
				"}",
				"",
			].join("\n"),
		);
		// The reasoned ignore hid line 3; the bare ones hid lines 5, 6 and 8
		// from the scan, which is why the comment check exists.
		expect(lines).toEqual([]);
		expect(offenders.map((o) => o.line)).toEqual([4, 6, 7]);
	});

	it("the wrapper exits NONZERO on a trailing bare ignore", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gov-wrapper-"));
		try {
			fs.writeFileSync(
				path.join(dir, "bare.ts"),
				"async function f() {\n\tfor (let i = 0; i < 9 && !d; i++) await t(); // ast-grep-ignore\n}\n",
				"utf-8",
			);
			const run = runWrapper(["--suite", "governance", dir]);
			expect(run.status).not.toBe(0);
			expect(run.stderr).toMatch(/without a rule id and a reason/);
			expect(run.stderr).toMatch(/bare\.ts:2/);
		} finally {
			removeTempDirSync(dir);
		}
	});

	it("loadBaseline refuses a governance row without a reason", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gov-base-"));
		try {
			const dir = path.join(root, "scripts", "governance-rules");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, "baseline.json"),
				JSON.stringify({
					allowed: [
						{ signature: "turn-count-wait::tests/a.ts::abc#0", reason: " " },
					],
				}),
				"utf-8",
			);
			expect(() => loadBaseline(root, governance)).toThrow(
				/without a signature and a reason/,
			);
		} finally {
			removeTempDirSync(root);
		}
	});
});

// #5072: the row-without-producer direction of both ledgers, on a row each
// cell plants. The two live-finding cases above run the same comparison over
// the real scan; these run without the CLI, so the CI job that skips the
// binary still checks the direction.
describe("ast-grep baselines red on a planted row with no live finding (#5072)", () => {
	it("self-scan: a planted row no finding produces is reported", () => {
		const rows = loadBaseline();
		const planted = "5072-gone-rule:tests/clients/5072-gone.test.ts:1";
		expectPlantedStaleRow({
			baseline: "rules/ast-grep-rules/self-scan-baseline.json",
			rowKey: planted,
			verdict: rowsWithoutLiveMember([...rows, planted], rows),
		});
	});

	it("governance: a planted row no finding produces is reported", () => {
		const governance = suiteByName("governance");
		const rows = loadBaseline(repoRoot(), governance);
		const planted =
			"turn-count-wait::tests/clients/5072-gone.test.ts::000000000000#0";
		expectPlantedStaleRow({
			baseline: "scripts/governance-rules/baseline.json",
			rowKey: planted,
			verdict: rowsWithoutLiveMember([...rows, planted], rows),
		});
	});
});

// #4983 r2: the self-scan baseline told people to run
// `npm run astgrep:self-scan -- --update-baseline`, but that script chains two
// commands and npm appends the extra args to the last one only, so it rewrote
// the governance baseline and left the self-scan one stale. Every regenerate
// command a baseline names must be one npm script that updates that suite.
describe("baseline regenerate commands (#4983)", () => {
	const scripts: Record<string, string> = JSON.parse(
		fs.readFileSync(path.join(repoRoot(), "package.json"), "utf-8"),
	).scripts;

	for (const name of Object.keys(SUITES)) {
		it(`the ${name} baseline names a script that updates the ${name} suite`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-regen-"));
			try {
				const suite = suiteByName(name);
				fs.mkdirSync(path.join(root, ...suite.dir), { recursive: true });
				const written = writeBaseline([], root, suite);
				const comment: string = JSON.parse(
					fs.readFileSync(written, "utf-8"),
				)._comment;
				const named = [...comment.matchAll(/`npm run ([^`]+)`/g)].map(
					(m) => m[1],
				);
				expect(named.length, comment).toBeGreaterThan(0);
				// The first command named is the one that regenerates this suite.
				const [scriptName, ...extra] = named[0].split(/\s+/);
				expect(extra, `${named[0]}: no appended args`).toEqual([]);
				const command = scripts[scriptName];
				expect(command, `package.json script ${scriptName}`).toBeDefined();
				expect(command).not.toMatch(/&&|;|\|\|/);
				expect(command).toMatch(/ --update-baseline\b/);
				const suiteArg = command.match(/--suite[ =](\S+)/)?.[1] ?? "self-scan";
				expect(suiteArg).toBe(name);
			} finally {
				removeTempDirSync(root);
			}
		});
	}
});
