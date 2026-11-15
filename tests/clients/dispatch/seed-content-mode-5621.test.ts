// flake-shape: real-process-spawn — whether given bytes reach a real linter
// through stdin, and whether a sibling copy of them ever exists beside the
// file, are facts of the tool and the tree; a double encodes the premise.
// lane: `ruff` and `eslint` come from the real-bytes tool tree
// (`captured-real-output`); a runner without one skips its cells with the
// reason named in the cell.
/**
 * #5621: a seed of bytes that are not on disk (a credited script write's HEAD
 * copy, the commit gate's staged blob) is linted through the tool's stdin when
 * every lane of the run takes content, so no sibling copy exists for
 * `git add -A` to stage.
 *
 * Recurrence prevented: #5619 seeded a disk linter by writing HEAD's bytes
 * beside the file under a `pi-lens-seed-` name; a concurrent `git add -A`
 * while the copy existed staged it, and the next commit was refused naming it
 * (#5619 verify r3, reproduced). The first describe drives the production
 * entries (`capturePreEditLinterFindings`, `gateStagedDelta`) and samples the
 * project directory for the whole run. The second pins, per tool, that content
 * mode and path mode give the same findings, and records the two tools whose
 * CLI cannot lint stdin (biome, oxlint): they stay on the copy.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	capturePreEditLinterFindings,
	resetDispatchBaselines,
} from "../../../clients/dispatch/integration.js";
import biomeRunner from "../../../clients/dispatch/runners/biome-check.js";
import eslintRunner from "../../../clients/dispatch/runners/eslint.js";
import oxlintRunner from "../../../clients/dispatch/runners/oxlint.js";
import ruffRunner from "../../../clients/dispatch/runners/ruff.js";
import type { RunnerResult } from "../../../clients/dispatch/types.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { setProjectTrustState } from "../../../clients/project-trust.js";
import { gateStagedDelta } from "../../../clients/staged-delta.js";
import { execFileSync } from "../../support/git-fixture-env.js";
import { makeRunnerCtx } from "../../support/runner-ctx.js";
import { removeTempDirSync, setupTestEnvironment } from "../test-utils.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

/** The first line of `command --version`, or undefined when it does not run. */
function versionOf(command: string): string | undefined {
	try {
		const ran = spawnSync(command, ["--version"], { encoding: "utf8" });
		return ran.status === 0 ? ran.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

const hasRuff = versionOf("ruff") !== undefined;
// The runner passes `--no-error-on-unmatched-pattern`, which ESLint 6 refuses.
const eslintMajor = Number(/(\d+)\./.exec(versionOf("eslint") ?? "")?.[1] ?? 0);
const hasEslint = eslintMajor >= 8;
const repoBin = (name: string): string =>
	path.join(repoRoot, "node_modules", ".bin", name);
const hasBiome = fs.existsSync(repoBin("biome"));
const hasOxlint = fs.existsSync(repoBin("oxlint"));
// A read-only directory stops a write only for a user who is not root, and
// Windows does not model directory permissions this way.
const canLockDirectory =
	process.platform !== "win32" && process.getuid?.() !== 0;

const env = setupTestEnvironment("pi-lens-5621-seed-");
const ROOT = env.tmpDir;
const pi = { getFlag: () => undefined };

function git(args: string[], cwd = ROOT): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: "pipe",
	});
}

beforeAll(() => {
	setProjectTrustState("trusted");
	fs.writeFileSync(path.join(ROOT, "ruff.toml"), '[lint]\nselect = ["F"]\n');
	fs.writeFileSync(path.join(ROOT, "pyproject.toml"), "[project]\nname='x'\n");
	git(["init", "-q"]);
	git(["config", "user.name", "t"]);
	git(["config", "user.email", "t@t.local"]);
});
afterAll(() => removeTempDirSync(ROOT));

/**
 * Names created in `dir` while `during` runs, from the directory's own change
 * events: a copy that exists for even one tool spawn is seen.
 */
async function namesSeenWhile<T>(
	dir: string,
	during: () => Promise<T>,
): Promise<{ result: T; seen: string[] }> {
	const seen = new Set<string>();
	const watcher = fs.watch(dir, (_event, name) => {
		if (name) seen.add(name.toString());
	});
	try {
		return { result: await during(), seen: [...seen] };
	} finally {
		watcher.close();
	}
}

// `pi-lens-staged-` is the name the commit gate's own copy had before #5621.
const copies = (names: string[]): string[] =>
	names.filter(
		(n) => n.startsWith("pi-lens-seed-") || n.startsWith("pi-lens-staged-"),
	);

/** HEAD's bytes: one old finding (F401 on L1). */
const HEAD_BYTES = "import os\n\nx = 1\n";
/** What the credited write left on disk: the finding gone. */
const WRITTEN_BYTES = "x = 1\n";

describe.skipIf(!hasRuff)(
	"#5621 a seed of bytes not on disk leaves no copy beside the file when every lane takes content (real ruff)",
	() => {
		it("seeds the credited write's HEAD finding with no copy beside the file at any moment", async () => {
			const file = path.join(ROOT, "seeded.py");
			fs.writeFileSync(file, HEAD_BYTES);
			git(["add", "seeded.py"]);
			git(["commit", "-qm", "base"]);
			fs.writeFileSync(file, WRITTEN_BYTES);
			resetDispatchBaselines();
			const { result, seen } = await namesSeenWhile(ROOT, () =>
				capturePreEditLinterFindings(
					file,
					ROOT,
					pi,
					{ isCurrent: () => true },
					undefined,
					true,
					async () => ({ content: HEAD_BYTES }),
				),
			);
			// The old finding is seeded from HEAD's bytes, not the written ones.
			expect(result).toMatchObject({ outcome: "seeded", seeded: 1 });
			expect(result.outcome === "seeded" && result.runners).toContain(
				"ruff-lint",
			);
			// The case under test: no sibling file existed during the run.
			expect(copies(seen)).toEqual([]);
			expect(
				git(["status", "--porcelain", "--untracked-files=all"]),
			).not.toContain("pi-lens-");
			// The write on disk is untouched by the seed.
			expect(fs.readFileSync(file, "utf8")).toBe(WRITTEN_BYTES);
		});

		it("judges the commit gate's staged blob with no copy beside the file at any moment", async () => {
			const file = path.join(ROOT, "staged.py");
			fs.writeFileSync(file, "x = 1\n");
			git(["add", "staged.py"]);
			git(["commit", "-qm", "staged base"]);
			// The index holds a blob the working file no longer holds.
			fs.writeFileSync(file, HEAD_BYTES);
			git(["add", "staged.py"]);
			fs.writeFileSync(file, "x = 2\n");
			const { result, seen } = await namesSeenWhile(ROOT, () =>
				gateStagedDelta(
					"bash",
					{ command: 'git commit -m "wip"' },
					{ cwd: ROOT, projectRoot: ROOT, getFlag: () => undefined },
					undefined,
				),
			);
			// The blob's finding, not the working file's, refuses the commit.
			expect(result.block).toBe(true);
			expect(result.reason).toContain("staged.py:");
			expect(result.reason).toContain("imported but unused");
			expect(copies(seen)).toEqual([]);
		});
	},
);

describe("#5621 a run with a lane that reads the disk still gets the copy", () => {
	// Recurrence prevented: a TypeScript file's lanes include biome, oxlint and
	// ast-grep, none of which lint stdin; dropping the copy for the run seeded
	// them nothing and brought back #5619's false STOP on a credited rewrite of
	// a file that held an old finding. Here the copy cannot be written, so the
	// gate must refuse the blob it could not judge, never pass it.
	it("refuses to pass an unjudged staged blob when its copy cannot be written beside the file", async (ctx) => {
		ctx.skip(
			!canLockDirectory,
			"a read-only directory stops no write for root or on Windows",
		);
		const locked = path.join(ROOT, "locked");
		fs.mkdirSync(locked);
		const file = path.join(locked, "a.ts");
		fs.writeFileSync(file, "export const a = 1;\n");
		git(["add", "locked/a.ts"]);
		git(["commit", "-qm", "locked base"]);
		fs.writeFileSync(file, "export const a = 2;\n");
		git(["add", "locked/a.ts"]);
		fs.writeFileSync(file, "export const a = 3;\n");
		fs.chmodSync(locked, 0o555);
		try {
			const decision = await gateStagedDelta(
				"bash",
				{ command: 'git commit -m "wip"' },
				{ cwd: ROOT, projectRoot: ROOT, getFlag: () => undefined },
				undefined,
			);
			expect(decision.block).toBe(true);
			expect(decision.unknown).toBe(true);
			expect(decision.reason).toContain("staged_delta_lane_incomplete");
			expect(decision.reason).toContain("could not be written beside it");
		} finally {
			fs.chmodSync(locked, 0o755);
		}
	});
});

/** One runner's diagnostics, compared by what the agent reads. */
function findings(result: RunnerResult): unknown[] {
	return result.diagnostics.map((d) => ({
		id: d.id,
		rule: d.rule,
		line: d.line,
		column: d.column,
		severity: d.severity,
		message: d.message,
		filePath: d.filePath,
	}));
}

/**
 * The runner lints the bytes it is given as it lints a file holding them. The
 * dirty bytes sit in the file for the path run; the clean ones replace them for
 * the content run, so a content run that read the disk finds nothing.
 */
async function sameFindingsByContent(cell: {
	name: string;
	file: string;
	dirty: string;
	clean: string;
	project: Record<string, string>;
	run: (file: string, content?: string) => Promise<RunnerResult>;
}): Promise<void> {
	const dir = path.join(ROOT, cell.name + "-cell");
	fs.mkdirSync(dir);
	for (const [name, bytes] of Object.entries(cell.project))
		fs.writeFileSync(path.join(dir, name), bytes);
	const file = path.join(dir, cell.file);
	fs.writeFileSync(file, cell.dirty);
	const byPath = findings(await cell.run(file));
	// The control: the dirty bytes raise findings, so silence cannot pass.
	expect(byPath.length).toBeGreaterThan(1);
	fs.writeFileSync(file, cell.clean);
	const byContent = findings(await cell.run(file, cell.dirty));
	expect(byContent).toEqual(byPath);
	// The given bytes are not written: the file still holds the clean ones.
	expect(fs.readFileSync(file, "utf8")).toBe(cell.clean);
}

describe("#5621 content mode and path mode give the same findings", () => {
	// Recurrence prevented: a content mode that lints the wrong bytes (the file's
	// own, left on disk) or reports another filename reads as a clean seed.
	it("ruff: the given bytes give the findings a file holding them gives", async (ctx) => {
		ctx.skip(!hasRuff, "ruff is not on PATH");
		await sameFindingsByContent({
			name: "ruff",
			file: "m.py",
			dirty: "import os\nimport sys\n\nx = 1\n",
			clean: "x = 1\n",
			project: { "ruff.toml": '[lint]\nselect = ["F"]\n' },
			run: (file, givenContent) =>
				ruffRunner.run(
					makeRunnerCtx(file, path.dirname(file), {
						kind: "python",
						givenContent,
					}) as never,
				),
		});
	}, 60_000);

	it("eslint: the given bytes give the findings a file holding them gives", async (ctx) => {
		ctx.skip(
			!hasEslint,
			"no ESLint 8+ on PATH (the runner passes --no-error-on-unmatched-pattern, which ESLint 6 refuses)",
		);
		await sameFindingsByContent({
			name: "eslint",
			file: "m.js",
			dirty: "debugger;\nvar a = 1;\ndebugger;\n",
			clean: "var a = 1;\n",
			project: {
				"package.json": '{"type":"commonjs"}\n',
				"eslint.config.js":
					'module.exports = [{ rules: { "no-debugger": "error", "no-var": "warn" } }];\n',
			},
			run: (file, givenContent) =>
				eslintRunner.run(
					makeRunnerCtx(file, path.dirname(file), {
						kind: "jsts",
						givenContent,
					}) as never,
				),
		});
	}, 60_000);
});

describe("#5621 the tools whose CLI cannot lint stdin stay on the copy", () => {
	// Recurrence prevented: the issue proposed `biome --stdin-file-path` and left
	// oxlint's stdin open; adopting either runner into content mode on that
	// premise would seed a run with no findings and read it as clean. Each cell
	// asks the real CLI, so a release that gains stdin linting reds here and
	// the runner can be moved to content mode on evidence.
	const dirty = "debugger;\n";

	it("biome lint --stdin-file-path prints the bytes back and reports no finding that the path run reports", (ctx) => {
		ctx.skip(!hasBiome, "biome is not installed in this checkout");
		const dir = path.join(ROOT, "biome-cell");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "biome.json"), "{}\n");
		fs.writeFileSync(path.join(dir, "a.ts"), dirty);
		const args = ["lint", "--reporter=json", "--colors=off"];
		const byPath = spawnSync(repoBin("biome"), [...args, "a.ts"], {
			cwd: dir,
			encoding: "utf8",
		});
		expect(byPath.stdout).toContain("lint/suspicious/noDebugger");
		const byStdin = spawnSync(
			repoBin("biome"),
			[...args, "--stdin-file-path=a.ts"],
			{ cwd: dir, encoding: "utf8", input: dirty },
		);
		expect(byStdin.stdout + byStdin.stderr).not.toContain("noDebugger");
		expect(byStdin.stdout).not.toContain('"diagnostics"');
		expect(biomeRunner.lintsGivenContent).toBeUndefined();
	}, 60_000);

	it("oxlint has no stdin mode: a dash lints no file and --stdin-filename is refused", (ctx) => {
		ctx.skip(!hasOxlint, "oxlint is not installed in this checkout");
		const dir = path.join(ROOT, "oxlint-cell");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "a.js"), dirty);
		const run = (args: string[]) =>
			spawnSync(repoBin("oxlint"), ["--format", "json", ...args], {
				cwd: dir,
				encoding: "utf8",
				input: dirty,
			});
		expect(run(["a.js"]).stdout).toContain("no-debugger");
		const dash = run(["-"]);
		expect(dash.status).not.toBe(0);
		expect(dash.stdout + dash.stderr).toContain("No files found");
		const named = run(["--stdin-filename", "a.js"]);
		expect(named.status).not.toBe(0);
		expect(named.stderr).toContain("not expected in this context");
		expect(oxlintRunner.lintsGivenContent).toBeUndefined();
	}, 60_000);
});

/**
 * #5621: a run with a disk-reading lane still writes the copy. The copy is
 * excluded from `git add -A` first, through the repository's local exclude
 * file (`info/exclude` of the common dir, so linked worktrees share it).
 *
 * Recurrence prevented: #5619's seed copy (`pi-lens-seed-<hex>.<name>`) beside
 * a TypeScript file, with biome and oxlint selected, was staged by a
 * concurrent `git add -A` and the next commit was refused naming it (#5621,
 * reproduced).
 */
const SEED_PATTERN = "pi-lens-seed-*";
const TS_HEAD = "debugger;\n";
const TS_WRITTEN = "export const a = 1;\n";

describe("#5621 the seed copy is excluded from git before it is written", () => {
	const cells = setupTestEnvironment("pi-lens-5621-exclude-");

	afterAll(() => removeTempDirSync(cells.tmpDir));

	/** A repo with one committed TypeScript file whose write is credited. */
	function tsRepo(name: string): { dir: string; file: string } {
		const dir = path.join(cells.tmpDir, name);
		fs.mkdirSync(dir, { recursive: true });
		git(["init", "-q"], dir);
		git(["config", "user.name", "t"], dir);
		git(["config", "user.email", "t@t.local"], dir);
		fs.writeFileSync(path.join(dir, "biome.json"), "{}\n");
		fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
		fs.symlinkSync(
			path.join(repoRoot, "node_modules"),
			path.join(dir, "node_modules"),
			"dir",
		);
		const file = path.join(dir, "a.ts");
		fs.writeFileSync(file, TS_HEAD);
		git(["add", "-A"], dir);
		git(["commit", "-qm", "base"], dir);
		fs.writeFileSync(file, TS_WRITTEN);
		return { dir, file };
	}

	/** The production seed of a credited write whose HEAD copy is `TS_HEAD`. */
	function seed(dir: string, file: string) {
		resetDispatchBaselines();
		return capturePreEditLinterFindings(
			file,
			dir,
			pi,
			{ isCurrent: () => true },
			undefined,
			true,
			async () => ({ content: TS_HEAD }),
		);
	}

	const exclude = (gitDir: string): string => {
		const file = path.join(gitDir, "info", "exclude");
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	};

	it("keeps a concurrent git add -A from staging the copy while it exists", async () => {
		const { dir, file } = tsRepo("add-all");
		const staged: string[] = [];
		let copySeen = false;
		const watcher = fs.watch(dir, (_event, name) => {
			if (!name?.toString().startsWith("pi-lens-seed-")) return;
			copySeen = true;
			// The reproduced case: another tool stages the whole tree meanwhile.
			git(["add", "-A"], dir);
			staged.push(...git(["diff", "--cached", "--name-only"], dir).split("\n"));
		});
		try {
			await seed(dir, file);
		} finally {
			watcher.close();
		}
		// The copy existed (a vacuous run cannot pass) and was not staged.
		expect(copySeen).toBe(true);
		expect(staged.filter((n) => n.includes("pi-lens-seed-"))).toEqual([]);
		// The commit that follows is not refused for the copy.
		const gate = await gateStagedDelta(
			"bash",
			{ command: 'git commit -m "wip"' },
			{ cwd: dir, projectRoot: dir, getFlag: () => undefined },
			undefined,
		);
		expect(gate.reason ?? "").not.toContain("pi-lens-seed-");
	}, 60_000);

	it("writes the line once for two seeds and leaves a tracked .gitignore alone", async () => {
		const { dir, file } = tsRepo("twice");
		await seed(dir, file);
		await seed(dir, file);
		const lines = exclude(path.join(dir, ".git"))
			.split("\n")
			.filter((l) => l === SEED_PATTERN);
		expect(lines).toEqual([SEED_PATTERN]);
		expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(
			"node_modules\n",
		);
		expect(git(["status", "--porcelain"], dir)).not.toContain("pi-lens-");
	}, 60_000);

	it("keeps what the exclude file already holds, with and without a final newline", async () => {
		const first = tsRepo("keep-newline");
		fs.mkdirSync(path.join(first.dir, ".git", "info"), { recursive: true });
		fs.writeFileSync(
			path.join(first.dir, ".git", "info", "exclude"),
			"# mine\n*.bak\n",
		);
		await seed(first.dir, first.file);
		expect(exclude(path.join(first.dir, ".git"))).toBe(
			"# mine\n*.bak\n" + SEED_PATTERN + "\n",
		);
		const second = tsRepo("keep-bare");
		fs.mkdirSync(path.join(second.dir, ".git", "info"), { recursive: true });
		fs.writeFileSync(path.join(second.dir, ".git", "info", "exclude"), "*.bak");
		await seed(second.dir, second.file);
		expect(exclude(path.join(second.dir, ".git"))).toBe(
			"*.bak\n" + SEED_PATTERN + "\n",
		);
	}, 60_000);

	it("writes the line into the common dir for a linked worktree", async () => {
		const main = tsRepo("wt-main");
		const linked = path.join(cells.tmpDir, "wt-linked");
		git(["worktree", "add", "-q", linked, "-b", "wt"], main.dir);
		fs.symlinkSync(
			path.join(repoRoot, "node_modules"),
			path.join(linked, "node_modules"),
			"dir",
		);
		const file = path.join(linked, "a.ts");
		fs.writeFileSync(file, TS_WRITTEN);
		await seed(linked, file);
		expect(exclude(path.join(main.dir, ".git"))).toContain(SEED_PATTERN + "\n");
		// The worktree's own git dir holds no second copy of the rule.
		const own = git(["rev-parse", "--absolute-git-dir"], linked).trim();
		expect(exclude(own)).toBe("");
	}, 60_000);

	it("still writes the copy and records one failure per session when the exclude cannot be written", async () => {
		const { dir, file } = tsRepo("unwritable");
		// A directory where the file belongs: neither read nor appended to, for
		// root as well.
		const held = path.join(dir, ".git", "info", "exclude");
		fs.rmSync(held, { force: true });
		fs.mkdirSync(held, { recursive: true });
		resetDegradationLedger();
		let copySeen = false;
		const watcher = fs.watch(dir, (_event, name) => {
			if (name?.toString().startsWith("pi-lens-seed-")) copySeen = true;
		});
		try {
			await seed(dir, file);
			await seed(dir, file);
		} finally {
			watcher.close();
		}
		expect(copySeen).toBe(true);
		const rows = getDegradationSummary().filter(
			(row) => row.kind === "seed-exclude-unwritable",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.count).toBe(1);
	}, 60_000);

	it("does nothing outside a git repository", async () => {
		const dir = path.join(cells.tmpDir, "no-repo");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "biome.json"), "{}\n");
		const file = path.join(dir, "a.ts");
		fs.writeFileSync(file, TS_WRITTEN);
		resetDegradationLedger();
		await seed(dir, file);
		expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
		expect(
			getDegradationSummary().filter(
				(row) => row.kind === "seed-exclude-unwritable",
			),
		).toEqual([]);
	}, 60_000);
});
