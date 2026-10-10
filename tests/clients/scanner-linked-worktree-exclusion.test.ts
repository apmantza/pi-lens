// flake-shape: real-process-spawn — real `git worktree add` children write the linked-worktree `.git` files and the `worktrees/*/gitdir` registry that `listLinkedWorktreeRoots` reads; a hand-built skeleton would only restate the on-disk format the production reader is meant to be tested against

/**
 * #4117: vulture and jscpd leave every linked worktree under the scanned root
 * out of their scan, whatever the worktree directory is called and whether or
 * not the project ships its own scanner config.
 *
 * Recurrence prevented (found by #3872's fixer, measured for this PR with the
 * real binaries -- vulture 2.16 and jscpd 5.4.0 -- on a fixture with one linked
 * worktree at `trees/alpha`, a name no exclusion list knows): both scanners
 * excluded worktrees only through the hard-coded `.worktrees` directory name,
 * and a project config made the client pass NO exclusion at all, so each
 * worktree doubled the file set: vulture reported 96 000 issues over 800 files
 * (400 of them in the worktree) where the checkout has 48 000 over 400, and
 * jscpd paired the checkout's clones with their copies in the worktree.
 *
 * Every case drives the real client against REAL git worktrees; the scanner
 * process is the one boundary faked (`safeSpawnAsync`), and only to capture
 * its argv. Whether the argv excludes what it claims is shown by the real-binary
 * transcripts in the PR body, not by restating the pattern here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ensureTool, findNodeToolBinary } = vi.hoisted(() => ({
	ensureTool: vi.fn(),
	findNodeToolBinary: vi.fn(),
}));
vi.mock("../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/installer/index.js")
	>()),
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	getInstallAttempt: vi.fn(() => undefined),
	getLastEnsureResolutionSource: vi.fn(() => undefined),
	getToolInstallStrategy: vi.fn(() => undefined),
	resetPathWalkMemo: vi.fn(),
	isSpawnableCommand: vi.fn(async () => true),
}));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));
const safeSpawnAsync = vi.hoisted(() =>
	vi.fn(
		async (..._args: unknown[]) =>
			({ error: undefined, status: 0, stdout: "", stderr: "" }) as {
				error?: Error;
				status: number | null;
				stdout: string;
				stderr: string;
			},
	),
);
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { PythonDeadCodeClient } from "../../clients/dead-code-client.js";
import {
	classifyAndFilterFindings,
	GitleaksClient,
	type GitleaksFinding,
} from "../../clients/gitleaks-client.js";
import { JscpdClient } from "../../clients/jscpd-client.js";
import { OpengrepClient } from "../../clients/opengrep-client.js";
import { listNestedLinkedWorktreeRoots } from "../../clients/review-graph/git-identity.js";
import { TrivyClient, worktreeSkipDirs } from "../../clients/trivy-client.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { setupTestEnvironment } from "./test-utils.js";

let env: ReturnType<typeof setupTestEnvironment>;
let main: string;

function git(cwd: string, ...args: string[]): void {
	gitExecFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function write(dir: string, relative: string, content: string): string {
	const file = path.join(dir, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

function realPath(p: string): string {
	return fs.realpathSync.native(p);
}

function initRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "t");
	write(dir, "pyproject.toml", '[project]\nname = "fixture"\n');
	write(dir, "pkg/mod.py", "def unused():\n    return 1\n");
	write(dir, "src/a.js", "export const a = 1;\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "init");
}

/** `git worktree add` at a path relative to the repository (any name, any depth). */
function addWorktree(relative: string, repo = main): string {
	const dir = path.join(repo, relative);
	git(
		repo,
		"worktree",
		"add",
		"-q",
		"-b",
		relative.replace(/[^\w]/g, "-"),
		dir,
	);
	return dir;
}

function pyproject(vultureTable: string): void {
	write(
		main,
		"pyproject.toml",
		`[project]\nname = "fixture"\n\n[tool.vulture]\n${vultureTable}`,
	);
}

/** The argv of the scanner run (the call that scans `.`), not an availability probe. */
function scanArgs(): string[] {
	const call = safeSpawnAsync.mock.calls.find((c) => {
		const args = c[1] as string[] | undefined;
		return Array.isArray(args) && args.includes(".");
	});
	return (call?.[1] as string[] | undefined) ?? [];
}

function optionValue(args: string[], flag: string): string | undefined {
	const joined = args.find((a) => a.startsWith(`${flag}=`));
	if (joined !== undefined) return joined.slice(flag.length + 1);
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

function exclusionRows() {
	return getDegradationSummary().find(
		(group) => group.kind === "scan-worktree-exclusion-skipped",
	);
}

beforeEach(() => {
	resetDegradationLedger();
	safeSpawnAsync.mockClear();
	ensureTool.mockReset();
	findNodeToolBinary.mockReset();
	findNodeToolBinary.mockResolvedValue(null);
	env = setupTestEnvironment("pi-lens-4117-exclusion-");
	main = path.join(env.tmpDir, "main");
	initRepo(main);
});
afterEach(() => {
	env.cleanup();
});

describe("#4117 listNestedLinkedWorktreeRoots", () => {
	it("lists the linked worktrees strictly under the scan root, by real path, and nothing else", () => {
		const alpha = addWorktree("trees/alpha");
		const sibling = path.join(env.tmpDir, "sibling");
		git(main, "worktree", "add", "-q", "-b", "sib", sibling);

		expect(listNestedLinkedWorktreeRoots(main)).toEqual([realPath(alpha)]);
		// The scan root is never its own nested worktree, and the main checkout is
		// not "nested" in a linked worktree that sits inside it.
		expect(listNestedLinkedWorktreeRoots(alpha)).toEqual([]);
		expect(listNestedLinkedWorktreeRoots(sibling)).toEqual([]);
	});

	it("answers [] for a directory that is not a git checkout", () => {
		expect(listNestedLinkedWorktreeRoots(env.tmpDir)).toEqual([]);
	});

	it("resolves a symlinked spelling of the scan root to the same nested roots", () => {
		const alpha = addWorktree("trees/alpha");
		const link = path.join(env.tmpDir, "main-link");
		fs.symlinkSync(main, link, "dir");

		expect(listNestedLinkedWorktreeRoots(link)).toEqual([realPath(alpha)]);
	});
});

describe("#4117 vulture excludes every linked worktree under the scanned root", () => {
	let lastResult: Awaited<ReturnType<PythonDeadCodeClient["analyze"]>>;
	async function vultureArgs(root = main): Promise<string[]> {
		const client = new PythonDeadCodeClient(false);
		lastResult = await client.analyze(root);
		return scanArgs();
	}

	it("excludes a worktree under a name no list knows, next to the built-in exclusions", async () => {
		const alpha = addWorktree("trees/alpha");

		const exclude = optionValue(await vultureArgs(), "--exclude") ?? "";

		expect(exclude.split(",")).toContain(`${realPath(alpha)}/*`);
		expect(exclude.split(",")).toContain("*/.worktrees/*");
		expect(optionValue(scanArgs(), "--min-confidence")).toBeDefined();
		// The record the turn_end row and the dead-code log carry (#4117).
		expect(lastResult.excludedWorktrees).toBe(1);
	});

	it("reports no excluded worktree when the root has none", async () => {
		await vultureArgs();

		expect(lastResult.excludedWorktrees).toBe(0);
	});

	it("excludes it under the project's own [tool.vulture] without touching its thresholds", async () => {
		pyproject("min_confidence = 80\n");
		const alpha = addWorktree("trees/alpha");

		const args = await vultureArgs();

		expect(optionValue(args, "--exclude")).toBe(`${realPath(alpha)}/*`);
		expect(optionValue(args, "--min-confidence")).toBeUndefined();
	});

	it("merges the project's own exclude list instead of replacing it", async () => {
		pyproject('exclude = ["gen/", "*/migrations/*"]\n');
		const alpha = addWorktree("trees/alpha");
		const beta = addWorktree("wt-beta");

		const exclude = optionValue(await vultureArgs(), "--exclude") ?? "";

		expect(exclude.split(",")).toEqual([
			"gen/",
			"*/migrations/*",
			`${realPath(alpha)}/*`,
			`${realPath(beta)}/*`,
		]);
	});

	it("keeps every entry of a project exclude list whose patterns hold a glob class", async () => {
		// Recurrence prevented (review of #4120, F2): the list was cut at the first
		// `]` inside a pattern, so "*/skip/*" and everything after a class came
		// back into the scan.
		pyproject('exclude = ["*/gen/*", "*/legacy_[ab]*", "*/skip/*"]\n');
		const alpha = addWorktree("trees/alpha");

		const exclude = optionValue(await vultureArgs(), "--exclude") ?? "";

		expect(exclude.split(",")).toEqual([
			"*/gen/*",
			"*/legacy_[ab]*",
			"*/skip/*",
			`${realPath(alpha)}/*`,
		]);
	});

	it("does not split a project exclude entry that holds a comma, and counts the leak", async () => {
		// Recurrence prevented (review of #4120, F4): vulture's --exclude is a
		// comma list, so `a,b/*` would have become two patterns and widened the
		// user's exclusion.
		pyproject('exclude = ["a,b/*", "*/gen/*"]\n');
		addWorktree("trees/alpha");

		const args = await vultureArgs();

		expect(optionValue(args, "--exclude")).toBeUndefined();
		expect(JSON.stringify(exclusionRows())).toContain(
			"config-exclude-unreadable",
		);
	});

	it("passes the project's config through untouched when it has no worktree to exclude", async () => {
		pyproject('exclude = ["gen/"]\n');

		const args = await vultureArgs();

		expect(optionValue(args, "--exclude")).toBeUndefined();
	});

	it("does not override an exclude it cannot read, and counts the leak", async () => {
		pyproject('exclude = "gen/"\n');
		addWorktree("trees/alpha");

		const args = await vultureArgs();

		expect(optionValue(args, "--exclude")).toBeUndefined();
		const row = exclusionRows();
		expect(row?.count).toBe(1);
		expect(JSON.stringify(row)).toContain("vulture");
		expect(JSON.stringify(row)).toContain("config-exclude-unreadable");
	});

	it("escapes glob metacharacters in a worktree path and drops, with a count, one a comma would split", async () => {
		const odd = addWorktree("we[ird]");
		addWorktree("a,b");

		const exclude = (optionValue(await vultureArgs(), "--exclude") ?? "").split(
			",",
		);

		expect(exclude).toContain(`${realPath(odd).replaceAll("[", "[[]")}/*`);
		expect(exclude.some((p) => p.includes("a,b") || p.endsWith("a"))).toBe(
			false,
		);
		expect(JSON.stringify(exclusionRows())).toContain("comma-in-path");
	});

	it("leaves a worktree outside the scanned root alone", async () => {
		const sibling = path.join(env.tmpDir, "sibling");
		git(main, "worktree", "add", "-q", "-b", "sib", sibling);

		const exclude = optionValue(await vultureArgs(), "--exclude") ?? "";

		expect(exclude).not.toContain("sibling");
	});

	it("excludes a worktree nested under a package subdirectory that is the scan root", async () => {
		write(main, "services/api/pyproject.toml", '[project]\nname = "api"\n');
		write(main, "services/api/app.py", "x = 1\n");
		git(main, "add", "-A");
		git(main, "commit", "-qm", "api");
		const pkg = path.join(main, "services", "api");
		const nested = addWorktree("services/api/trees/x");

		const exclude = optionValue(await vultureArgs(pkg), "--exclude") ?? "";

		expect(exclude.split(",")).toContain(`${realPath(nested)}/*`);
	});
});

describe("#4117 jscpd excludes every linked worktree under the scanned root", () => {
	async function jscpdArgs(): Promise<string[]> {
		write(main, "src/b.ts", "export const b = 2;\n");
		const client = new JscpdClient(false);
		await client.ensureAvailable();
		safeSpawnAsync.mockClear();
		await client.scan(main, 5, 50, false);
		await client.shutdown();
		return scanArgs();
	}

	it("ignores a worktree under a name no list knows, next to the built-in ignores", async () => {
		addWorktree("trees/alpha");

		const ignore = (optionValue(await jscpdArgs(), "--ignore") ?? "").split(
			",",
		);

		expect(ignore).toContain("trees/alpha/**");
		expect(ignore).toContain("**/node_modules/**");
	});

	it("merges a worktree into the ignore list of the project's own .jscpd.json", async () => {
		write(
			main,
			".jscpd.json",
			JSON.stringify({ minLines: 10, ignore: ["**/vendor/**"] }),
		);
		addWorktree("trees/alpha");

		const args = await jscpdArgs();

		expect(optionValue(args, "--ignore")?.split(",")).toEqual([
			"**/vendor/**",
			"trees/alpha/**",
		]);
		expect(args).not.toContain("--min-lines");
		expect(args).not.toContain("--min-tokens");
	});

	it("merges a worktree into the ignore list of a package.json jscpd field", async () => {
		write(
			main,
			"package.json",
			JSON.stringify({ name: "x", jscpd: { ignore: ["**/gen/**"] } }),
		);
		addWorktree("wt-beta");

		expect(optionValue(await jscpdArgs(), "--ignore")?.split(",")).toEqual([
			"**/gen/**",
			"wt-beta/**",
		]);
	});

	it("reads only .jscpd.json when both it and package.json carry a config, as jscpd does", async () => {
		write(main, ".jscpd.json", JSON.stringify({ ignore: ["**/one/**"] }));
		write(
			main,
			"package.json",
			JSON.stringify({ name: "x", jscpd: { ignore: ["**/two/**"] } }),
		);
		addWorktree("wt-beta");

		expect(optionValue(await jscpdArgs(), "--ignore")?.split(",")).toEqual([
			"**/one/**",
			"wt-beta/**",
		]);
	});

	it("ignores only the worktree when the project's config sets no ignore list", async () => {
		write(main, ".jscpd.json", JSON.stringify({ minLines: 10 }));
		addWorktree("trees/alpha");

		expect(optionValue(await jscpdArgs(), "--ignore")).toBe("trees/alpha/**");
	});

	it("passes the project's config through untouched when it has no worktree to ignore", async () => {
		write(main, ".jscpd.json", JSON.stringify({ ignore: ["**/vendor/**"] }));

		expect(await jscpdArgs()).not.toContain("--ignore");
	});

	it("does not override a config it cannot parse, and counts the leak", async () => {
		write(main, ".jscpd.json", "{ not json");
		addWorktree("trees/alpha");

		expect(await jscpdArgs()).not.toContain("--ignore");
		const row = exclusionRows();
		expect(row?.count).toBe(1);
		expect(JSON.stringify(row)).toContain("jscpd");
		expect(JSON.stringify(row)).toContain("config-ignore-unreadable");
	});

	it("drops, with a count, a worktree whose path a glob or a comma would misread", async () => {
		addWorktree("we[ird]");
		addWorktree("a,b");
		addWorktree("trees/alpha");

		const ignore = (optionValue(await jscpdArgs(), "--ignore") ?? "").split(
			",",
		);

		expect(ignore).toContain("trees/alpha/**");
		expect(ignore.some((p) => p.includes("we[ird]") || p === "b/**")).toBe(
			false,
		);
		expect(exclusionRows()?.count).toBe(2);
	});
});

describe("#4132 gitleaks, trivy and opengrep leave every linked worktree under the scanned root out of their scan", () => {
	const okSpawn = async () => ({
		error: undefined,
		status: 0,
		stdout: "",
		stderr: "",
	});

	beforeEach(() => {
		safeSpawnAsync.mockImplementation(okSpawn);
	});

	/** The argv of the run that starts with `verb` (`fs`, `scan`, `detect`). */
	function callWith(verb: string): string[] {
		const call = safeSpawnAsync.mock.calls.find(
			(c) => (c[1] as string[] | undefined)?.[0] === verb,
		);
		return (call?.[1] as string[] | undefined) ?? [];
	}

	function flagValues(args: string[], flag: string): string[] {
		return args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
	}

	function symlinkedMain(): string {
		const link = path.join(env.tmpDir, "main-link");
		fs.symlinkSync(main, link, "dir");
		return link;
	}

	async function trivyArgs(root = main): Promise<string[]> {
		const client = new TrivyClient(false) as unknown as {
			runScan: (cwd: string) => Promise<unknown>;
		};
		await client.runScan(root);
		return callWith("fs");
	}

	async function opengrepArgs(root = main): Promise<string[]> {
		const client = new OpengrepClient(false) as unknown as {
			runScan: (cwd: string) => Promise<unknown>;
		};
		await client.runScan(root);
		return callWith("scan");
	}

	/** Every `[allowlist] paths` entry of the config gitleaks was started with, and the findings it was given back. */
	async function gitleaksRun(
		root: string,
		report: Array<{ File: string }> = [],
	): Promise<{ paths: string[]; findings: GitleaksFinding[] }> {
		let paths: string[] = [];
		safeSpawnAsync.mockImplementation(async (...call: unknown[]) => {
			const args = call[1] as string[];
			if (args[0] === "detect") {
				const toml = fs.readFileSync(
					args[args.indexOf("--config") + 1] as string,
					"utf-8",
				);
				const block = toml.match(/paths = \[\n([\s\S]*?)\n\]/)?.[1] ?? "";
				paths = block
					.split("\n")
					.map((line) => JSON.parse(line.trim().replace(/,$/, "")) as string);
				fs.writeFileSync(
					args[args.indexOf("--report-path") + 1] as string,
					JSON.stringify(
						report.map((f) => ({
							RuleID: "generic-api-key",
							StartLine: 1,
							...f,
						})),
					),
				);
			}
			return okSpawn();
		});
		const client = new GitleaksClient(false) as unknown as {
			runScan: (cwd: string) => Promise<{ findings: GitleaksFinding[] }>;
		};
		const result = await client.runScan(root);
		return { paths, findings: result.findings };
	}

	function allowlisted(paths: string[], file: string): boolean {
		return paths.some((p) => new RegExp(p).test(file));
	}

	describe("trivy fs --skip-dirs", () => {
		it("skips a worktree under a name no list knows, next to the scratch-tree globs", async () => {
			addWorktree("trees/alpha");
			addWorktree("wt-beta");

			const skips = flagValues(await trivyArgs(), "--skip-dirs");

			expect(skips).toContain("trees/alpha");
			expect(skips).toContain("wt-beta");
			expect(skips).toContain("**/node_modules/**");
		});

		it("adds nothing when the root holds no linked worktree", async () => {
			const skips = flagValues(await trivyArgs(), "--skip-dirs");

			expect(skips.every((s) => s.startsWith("**/"))).toBe(true);
		});

		it("names the worktree relative to the root through a symlinked spelling of it", async () => {
			addWorktree("trees/alpha");

			const skips = flagValues(await trivyArgs(symlinkedMain()), "--skip-dirs");

			expect(skips).toContain("trees/alpha");
			expect(skips.some((s) => s.includes(".."))).toBe(false);
		});

		it("drops, with a count, a worktree whose path trivy would split or read as a glob", async () => {
			addWorktree("trees/alpha");
			addWorktree("a,b");
			addWorktree("we[ird]");
			addWorktree('q"x');
			addWorktree("br{a}ce");

			const skips = flagValues(await trivyArgs(), "--skip-dirs");

			expect(skips).toContain("trees/alpha");
			expect(skips.some((s) => /[,"[\]{}]/.test(s))).toBe(false);
			const row = exclusionRows();
			expect(row?.count).toBe(4);
			expect(JSON.stringify(row)).toContain("trivy");
		});

		it("uses Windows separator rules and caps command-line growth", () => {
			addWorktree("trees/alpha");
			addWorktree("trees/beta");

			const skips = worktreeSkipDirs(main, "\\", 20);

			expect(skips).toEqual([]);
			expect(exclusionRows()?.count).toBe(2);
			expect(JSON.stringify(exclusionRows())).toContain(
				"windows-command-line-cap",
			);
		});
	});

	describe("opengrep scan --exclude", () => {
		it("does not add one wcmatch pattern per linked worktree", async () => {
			addWorktree("trees/alpha");

			const excludes = flagValues(await opengrepArgs(), "--exclude");

			expect(excludes).toContain("node_modules");
			expect(excludes.some((entry) => entry.includes("trees/alpha"))).toBe(
				false,
			);
		});

		it("adds nothing when the root holds no linked worktree", async () => {
			const excludes = flagValues(await opengrepArgs(), "--exclude");

			expect(excludes.some((e) => e.includes("/"))).toBe(false);
		});
	});

	describe("gitleaks [allowlist] paths and the nested-repository backstop", () => {
		it("does not let a prunable registration hide a plain directory at its old path", async () => {
			const stale = addWorktree("trees/stale");
			fs.rmSync(stale, { recursive: true, force: true });
			fs.mkdirSync(stale, { recursive: true });
			write(stale, ".env", "k=1\n");

			const { findings, paths } = await gitleaksRun(main, [
				{ File: path.join(stale, ".env") },
			]);
			// This is a plain directory after pruning, so the existing
			// `nested-repository` backstop must not suppress its finding.
			expect(allowlisted(paths, path.join(stale, ".env"))).toBe(false);
			expect(findings[0]?.pathStatus).toBe("untracked");
		});

		it("allowlists everything under a worktree under a name no list knows, and nothing beside it", async () => {
			addWorktree("trees/alpha");

			const { paths } = await gitleaksRun(main);

			expect(allowlisted(paths, path.join(main, "trees/alpha/.env"))).toBe(
				true,
			);
			expect(allowlisted(paths, path.join(main, "trees/alpha"))).toBe(true);
			expect(allowlisted(paths, path.join(main, "trees/alphabet/.env"))).toBe(
				false,
			);
			expect(allowlisted(paths, path.join(main, "pkg/trees/alpha/.env"))).toBe(
				false,
			);
			expect(allowlisted(paths, path.join(main, "src/.env"))).toBe(false);
			// Anchored at the start: the same tail under another root is not it.
			expect(
				allowlisted(paths, path.join("/elsewhere", main, "trees/alpha/.env")),
			).toBe(false);
		});

		it("adds nothing beyond the secrets-lane names when the root holds no linked worktree", async () => {
			const { paths } = await gitleaksRun(main);

			expect(paths.every((p) => p.startsWith("(?:^|[/\\\\])"))).toBe(true);
		});

		it("builds the entry from the root's own spelling when the root is a symlink", async () => {
			addWorktree("trees/alpha");
			const link = symlinkedMain();

			const { paths } = await gitleaksRun(link);

			expect(allowlisted(paths, path.join(link, "trees/alpha/.env"))).toBe(
				true,
			);
			expect(allowlisted(paths, path.join(link, "trees/alphabet/.env"))).toBe(
				false,
			);
		});

		it("matches a worktree path with regex metacharacters literally", async () => {
			addWorktree("we[ird]+(x)");

			const { paths } = await gitleaksRun(main);

			expect(allowlisted(paths, path.join(main, "we[ird]+(x)/.env"))).toBe(
				true,
			);
			expect(allowlisted(paths, path.join(main, "weird+(x)/.env"))).toBe(false);
			expect(allowlisted(paths, path.join(main, "wee/.env"))).toBe(false);
		});

		it("demotes a finding that still comes back from inside a worktree, with the reason on the record", async () => {
			// Also pins the pre-existing `nested-repository` backstop.
			addWorktree("trees/alpha");
			write(main, "src/.env", "k=1\n");

			const { findings } = await gitleaksRun(main, [
				{ File: path.join(main, "trees/alpha/.env") },
				{ File: path.join(main, "src/.env") },
			]);

			expect(findings.map((f) => f.pathStatus)).toEqual([
				"nested-repository",
				"untracked",
			]);
		});

		it("classifies a finding in a worktree under a symlinked spelling of the root the same way", async () => {
			// Also pins the pre-existing `nested-repository` backstop.
			addWorktree("trees/alpha");
			const link = symlinkedMain();
			const finding: GitleaksFinding = {
				ruleId: "generic-api-key",
				file: path.join(link, "trees/alpha/.env"),
				startLine: 1,
			};

			const [classified] = await classifyAndFilterFindings([finding], link);

			expect(classified?.pathStatus).toBe("nested-repository");
		});
	});
});
