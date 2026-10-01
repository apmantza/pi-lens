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
import { removeTempDirSync } from "../clients/test-utils.js";
import {
	findingSignature,
	findingsInTrackedFiles,
	loadBaseline,
	repoRoot,
	runSelfScan,
	selfScanRuleIds,
} from "../../scripts/lib/astgrep-self-scan.mjs";

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
			"scripts/lib/git-fixture-env.mjs",
		])
			put(root, rel, fs.readFileSync(path.join(repoRoot(), rel), "utf8"));
		for (const rel of ["clients/safe-spawn.js", "clients/string-utils.js"]) {
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
