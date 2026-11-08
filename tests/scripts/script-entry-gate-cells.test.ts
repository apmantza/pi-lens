// flake-shape: real-process-spawn — the subject is each script's own entry
// decision: whether `main` runs when node starts the file, runs through a
// symlinked path, and stays quiet when the file is only imported. That decision
// is made from the real `process.argv[1]` and the real module URL of a real
// node process; an in-process call of `isMainModule` cannot show that a script
// routes through it.
// lane: wall-clock-budget (serialized); no wall-clock assertion. The runs go
// through a width-8 pool in beforeAll and each case asserts its own settled run.
/**
 * Fold of AGENTS.md shape 44 (entry-module detection) onto
 * `scripts/lib/is-main-module.mjs`. 65 scripts carried a private copy of the
 * gate; every copy compared the module URL with the symlink-preserving
 * `process.argv[1]`, so a script started through a linked path silently did
 * nothing and exited 0. That includes `scripts/check-changelog-fragments.mjs`
 * (a check that "passes") and the `guard-bash` PreToolUse hook (a hook that
 * allows `git stash`). Recurrence: #4096, which fixed the same defect for three
 * scripts and left the other copies.
 *
 * One cell per script, through its production caller (`node <script>`):
 *   1. entered      — a started run shows its main ran: a non-zero exit or
 *                     output (each script is given an argv that makes `main`
 *                     answer without side effects).
 *   2. linked       — the same run through a symlinked `scripts` directory
 *                     gives the same exit code and output.
 *   3. imported     — `import()` of the file under `node -e` runs no main.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import {
	scaledTestTimeout,
	TREE_WALK_TIMEOUT_MS,
} from "../support/test-timeout-scale.js";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPTS = path.join(ROOT, "scripts");
const POOL_WIDTH = 8;
const RUN_TIMEOUT_MS = 20_000;

type Cell = { args?: string[]; stdin?: string; env?: Record<string, string> };

const PROBE = "--entry-gate-cell-probe";
const NO_SUCH_FILE = path.join(os.tmpdir(), "pi-lens-entry-gate-cell-absent");

/**
 * Scripts whose argv, given a started run, makes `main` answer without a write,
 * a network call or a long job. The default argv is an option no script knows,
 * which every parser answers with a usage line or an error.
 */
const CELLS: Record<string, Cell> = {
	"assert-evaluated.mjs": {},
	"build-dist-tsc.mjs": {},
	"capture-runner-fixtures.mjs": {},
	"capture-runner-output.mjs": {},
	// The default run resolves every pinned tag over the GitHub API, so two runs
	// see different rate-limit answers (CI run 41607001195). `GITHUB_API_URL` is
	// the script's own base-URL seam: a base with no scheme makes every request
	// fail to parse before any socket opens, the same way in every run.
	"check-action-pins.mjs": { env: { GITHUB_API_URL: "offline.invalid" } },
	// Runs its real check over the checked-in fragments; read-only.
	"check-changelog-fragments.mjs": { args: [] },
	"check-ci-job-p90.mjs": {},
	"check-close-keywords.mjs": {},
	"check-hot-path-latency.mjs": {},
	"check-pr-body.mjs": {},
	"check-pr-title.mjs": {},
	// Silent on a clean read, so it is started on a body file that is absent.
	"check-prose.mjs": { args: ["--body-file", NO_SUCH_FILE] },
	"check-shard-verdict.mjs": {},
	"check-snapshot-persist-ratio.mjs": {},
	"check-tla-models.mjs": {},
	"ci-changed-files.mjs": {},
	"ci-shuffle-census.mjs": {},
	"ci-shuffle-changed-tests.mjs": {},
	"ci-test-diff.mjs": {},
	"dispatch-safety.mjs": {},
	"download-test-history-artifacts.mjs": {},
	"extract-vitest-failures.mjs": {},
	"gen-test-shard-weights.mjs": {},
	"gen-tla-model-costs.mjs": {},
	"guard-bash-probe.mjs": {},
	// The PreToolUse hook reads its verdict from stdin: a `git stash` write is
	// refused with exit 2, so a hook that never ran allows it with exit 0.
	"hooks/guard-bash.mjs": {
		args: [],
		stdin: JSON.stringify({
			tool_name: "Bash",
			tool_input: { command: "git stash" },
		}),
	},
	"lib/lockfile-completeness.mjs": {},
	"lib/win32-gate-population.mjs": {},
	"lib/windows-vitest-failure-count.mjs": {},
	// Default argv is an unknown flag: the usage line and exit 2, no write.
	"lint-prose-files.mjs": {},
	"lsp-refresh-landing.mjs": {},
	"npm-retry.mjs": { args: [] },
	"playground-verify-rule.mjs": { args: ["--help"] },
	"pr-preflight.mjs": {},
	"pr-worktree.mjs": {},
	"prune-agent-worktrees.mjs": {},
	"red-on-base.mjs": {},
	"rekey-hook-await-exemptions.mjs": {},
	"release-qa.mjs": {},
	"resolve-newest-in-range-host.mjs": {},
	"rollup-changelog.mjs": {},
	"smoke-tools.mjs": {},
	"strip-dev-deps-for-pack.mjs": {},
	"stryker-nightly.mjs": {},
	"stryker-pertest.mjs": {},
	"symbol-search-query-metrics.mjs": {},
	"test-history-rollup.mjs": {},
	"update-contributors.mjs": {},
	"upsert-tracking-issue.mjs": {},
};

/**
 * Entry scripts with no started-run cell, each with the fact that rules out a
 * side-effect-free argv. The tree-wide scan in
 * `tests/config/script-entry-portability.test.ts` still refuses a private gate
 * in every one of them.
 */
const NO_CELL: Record<string, string> = {
	"audit-prod-deps.mjs": "runs `npm audit` against the registry on any argv",
	"bench-snapshot-persist.mjs": "runs its benchmark to completion on any argv",
	"bundle-dist.mjs": "bundles `dist/index.js` in place when it is unbundled",
	"ci-verdict.mjs": "calls the GitHub API through `gh` on any argv",
	"complexity-report.mjs": "analyses the whole tree on any argv",
	"download-grammars.js": "downloads the grammar set on any argv",
	"download-grammars.ts": "downloads the grammar set on any argv",
	"gen-cargo-modules-snapshot.mjs": "rewrites a tracked fixture on any argv",
	"gen-language-snapshot.mjs": "rewrites a tracked fixture on any argv",
	"lane-check.mjs": "runs `npm` in the working directory on any argv",
	"lib/mutation-touch-build.mjs": "touches build mtimes and prints nothing",
	"lint-js-advisory.mjs": "runs oxlint over the tree on any argv",
	"promote-lsp-idle-eviction.mjs": "rewrites the capability docs on any argv",
	"prune-actions-cache.mjs": "calls the GitHub API through `gh` on any argv",
	"seed-matrix-from-bot-branch.mjs": "runs `git` over the checkout on any argv",
	"stamp-package-lock.mjs": "writes the install stamp and prints nothing",
	"strictness-report.mjs": "runs a tree-wide type analysis on any argv",
};

/**
 * Scripts that already used the seam before the fold. Each has a witness of
 * its own (`tests/scripts/with-test-lock.test.ts`,
 * `warm-loader-cache.test.ts`, `rpc-load-check-spawn.test.ts` and
 * `pre-push-targeted-tests.test.ts`); the scripts below them are imported by
 * those or run only under a pi host.
 */
const SEAM_BEFORE_FOLD = new Set([
	"pre-push-targeted-tests.mjs",
	"probe-pi-host-tiers.mjs",
	"rpc-load-check.mjs",
	"trace-validate-session-lifecycle.mjs",
	"warm-loader-cache.mjs",
	"with-test-lock.mjs",
	"worktree-remove.mjs",
]);

const CALL =
	/\b(?:isMainModule|isEntryPoint)\s*\(\s*import\s*\.\s*meta\s*\.\s*url\s*\)/;

/** Scripts (scripts-relative posix) whose entry gate calls the shared seam. */
export function scriptsOnTheSeam(root: string): string[] {
	const dir = path.join(root, "scripts");
	return listSourceFiles(dir, { extensions: [".mjs", ".js", ".ts"] })
		.filter((file) => {
			const rel = relativePosix(dir, file);
			if (rel === "lib/is-main-module.mjs") return false;
			return CALL.test(stripSource(fs.readFileSync(file, "utf8")));
		})
		.map((file) => relativePosix(dir, file))
		.sort();
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-entry-gate-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const LINKED = path.join(tmpRoot, "linked-scripts");
fs.symlinkSync(SCRIPTS, LINKED, "junction");
const CWD = path.join(tmpRoot, "cwd");
fs.mkdirSync(CWD);
const HOME = path.join(tmpRoot, "home");
fs.mkdirSync(HOME);

type Settled = { code: number | null; out: string };
const entered = new Map<string, Settled>();
const linked = new Map<string, Settled>();
const imported = new Map<string, Settled>();

// The ambient VITEST variables belong to the outer worker, and the child gets
// its home pinned under the scratch root (the harness keeps the real home out of reach).
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME,
		USERPROFILE: HOME,
		PI_LENS_HOME: path.join(HOME, ".pi-lens"),
		PILENS_DATA_DIR: path.join(HOME, ".pi-lens"),
		TMPDIR: tmpRoot,
	};
	for (const [key, value] of Object.entries(extra)) env[key] = value;
	for (const key of Object.keys(env))
		if (env[key] === undefined) delete env[key];
	return env;
}

// Both streams settle into one string; a killed or failed child is a result.
async function settle(
	args: string[],
	stdin: string | undefined,
	extraEnv?: Record<string, string>,
): Promise<Settled> {
	const child = run(process.execPath, args, {
		cwd: CWD,
		env: childEnv(extraEnv),
		timeout: RUN_TIMEOUT_MS,
	});
	child.child.stdin?.end(stdin ?? "");
	try {
		const { stdout, stderr } = await child;
		return { code: 0, out: stdout + stderr };
	} catch (err) {
		const failure = err as {
			code?: number | string;
			stdout?: string;
			stderr?: string;
		};
		return {
			code: typeof failure.code === "number" ? failure.code : null,
			out: (failure.stdout ?? "") + (failure.stderr ?? ""),
		};
	}
}

const normalize = (text: string) => text.split(LINKED).join(SCRIPTS);

async function runPool(): Promise<void> {
	const queue = Object.entries(CELLS);
	await Promise.all(
		Array.from({ length: POOL_WIDTH }, async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				const [script, cell] = next;
				const args = cell.args ?? [PROBE];
				entered.set(
					script,
					await settle(
						[path.join(SCRIPTS, script), ...args],
						cell.stdin,
						cell.env,
					),
				);
				const viaLink = await settle(
					[path.join(LINKED, script), ...args],
					cell.stdin,
					cell.env,
				);
				linked.set(script, { ...viaLink, out: normalize(viaLink.out) });
				const url = JSON.stringify(
					pathToFileURL(path.join(SCRIPTS, script)).href,
				);
				imported.set(
					script,
					await settle(
						["--input-type=module", "-e", `await import(${url});`],
						"",
					),
				);
			}
		}),
	);
}

beforeAll(runPool, scaledTestTimeout(180_000));

describe("scripts/ entry-gate cells (shape 44 fold onto isMainModule)", () => {
	// Recurrence: a script added to the fold with no cell and no named reason
	// would carry its own untested gate again (the 65 private copies #4096 left).
	it(
		"every script on the seam has a cell, a named reason, or its own witness",
		() => {
			// The `guard-bash` hook keeps a standalone gate (see
			// tests/config/script-entry-portability.test.ts); its cell stays.
			const onSeam = [...scriptsOnTheSeam(ROOT), "hooks/guard-bash.mjs"].sort();
			const accounted = new Set([
				...Object.keys(CELLS),
				...Object.keys(NO_CELL),
				...SEAM_BEFORE_FOLD,
			]);
			expect(onSeam.filter((s) => !accounted.has(s))).toEqual([]);
			expect([...accounted].filter((s) => !onSeam.includes(s)).sort()).toEqual(
				[],
			);
			// Calibration: 72 scripts on the seam on 2026-11-03; half is 36.
			assertNonEmptyScan("script entry seam census", onSeam.length, 36);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence: CI run 41607001195 (shard 2/5) reddened the linked-path cell of
	// `check-action-pins.mjs`. Its default argv ran the real check, which
	// resolves every pinned action tag over the GitHub API; the direct and the
	// linked run saw different rate-limit answers, so their outputs differed for
	// a reason that has nothing to do with the entry gate.
	it("check-action-pins resolves no tag over the network", () => {
		const result = entered.get("check-action-pins.mjs");
		expect(result?.out, "no settled run").toBeDefined();
		expect(result?.out).not.toMatch(/GitHub API \d{3}|All pinned/);
		expect(result?.out).toContain("cannot resolve");
	});

	for (const script of Object.keys(CELLS)) {
		describe(script, () => {
			// Recurrence: master before the fold, where a started run of every
			// one of these scripts was silent through a symlinked path.
			it("runs its main when node starts the file", () => {
				const result = entered.get(script);
				expect(result, `no settled run for ${script}`).toBeDefined();
				// A timed-out run settles with `code: null`, which is not 0, so
				// without the type check a hang would read as "main ran".
				expect(
					typeof result?.code === "number" &&
						(result.code !== 0 || result.out.trim().length > 0),
					`main did not run: exit ${result?.code}, output ${JSON.stringify(result?.out)}`,
				).toBe(true);
			});

			it("answers the same through a symlinked path", () => {
				const result = linked.get(script);
				const direct = entered.get(script);
				expect(result?.code).toBe(direct?.code);
				expect(result?.out).toBe(direct?.out);
			});

			// Recurrence: an always-true gate runs every script's main on a mere
			// import, which a test or `check-shard-verdict`'s wrapper does.
			it("runs no main when the file is only imported", () => {
				const result = imported.get(script);
				expect(result?.out, `import of ${script} produced output`).toBe("");
				expect(result?.code).toBe(0);
			});
		});
	}
});
