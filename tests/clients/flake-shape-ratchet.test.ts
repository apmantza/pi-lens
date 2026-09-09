/**
 * Flake-shape ratchet — #2547.
 *
 * Three deflake PRs in two days (#2531 alone fixed three shared-slot races)
 * and nothing counted the contention surface those PRs kept fixing, so the
 * set only grew. This ratchet counts it: `tests/support/flake-shape-scan.ts`
 * runs four detectors over every `tests/**\/*.test.ts` file and — since #2563
 * — over every non-test helper under `tests/support/**\/*.ts` (the time
 * detectors only; support helpers are the sanctioned spawn boundary) —
 *
 * 1. `real-process-spawn` — a real child process (`child_process` import,
 *    `execFileSync`/`spawnSync`/`execSync`, a support spawn-helper call, or a
 *    spawn whose argv mentions `vitest`).
 * 2. `elapsed-time-assertion` — a DELTA of two clock reads flowing into a
 *    numeric matcher (`toBeLessThan`/`toBeGreaterThan`/…).
 * 3. `raw-timer-wait` — a raw `setTimeout`/`setInterval` wait outside a
 *    `vi.useFakeTimers()` scope; in a `tests/support/` helper, also any
 *    `delay`/`sleep` helper definition (#2563 — the shared-primitive reuse
 *    vector that hides a raw wait from every `.test.ts` call site).
 * 4. `ungoverned-wait-for` — a `vi.waitFor` call outside a fake-timer scope.
 *
 * `FLAKE_SHAPE_BASELINE` (`tests/support/flake-shape-baseline.json`) is
 * today's population, content-keyed as `file → count` per detector — the
 * exact floor, kept in lockstep with the live scan, not a one-way ratchet
 * that only ever tightens on its own. The ratchet is TWO-SIDED and fails on:
 *
 * - a NEW file the scan flags that the baseline does not name, in any
 *   detector;
 * - an allowlisted file whose count in a detector RISES above its pinned
 *   value;
 * - an allowlisted file whose count in a detector FALLS below its pinned
 *   value — a stale ceiling. Left unpinned, a pinned-5/live-2 file can
 *   regrow to 4 new instances of the flake shape without ever tripping the
 *   RISES check above (2 < 5, then 4 < 5): the pin silently re-admits
 *   everything the improvement burned down. Every other ratchet in this repo
 *   refuses a stale entry the same way (`single-flight-ratchet.test.ts`,
 *   `sweep-kit.ts`'s `auditRegistry`) — a fall is fixed by editing the
 *   baseline down to the live count, not left to drift.
 *
 * Admission of a genuinely NEW entry (a new file, or a risen count in an
 * existing one) is a two-part gate, both required: the file carries a
 * `// flake-shape: <detector> — <reason>` header naming why a mock is not
 * faithful, AND the file is listed in `vitest.config.ts`'s
 * `wallClockBudgetInclude` project (so it runs in the fully serialized
 * lane). `ADMITTED_AFTER_BASELINE` below is the running list of entries
 * admitted this way since the baseline was minted.
 *
 * #1767's `tests/clients/runtime-session.test.ts` (a real recurring flake,
 * fixed with `vi.waitFor` timeouts and a wider `describe`/`it` budget, not a
 * raw clock delta, a raw timer, or a spawn) was checked by hand against all
 * three detectors while writing this ratchet and matches NONE of them — it
 * is the #1767 vi.waitFor/testTimeout contention-budget flake shape, a real
 * but DIFFERENT shape than the three this ratchet counts, so it correctly
 * does not appear in the baseline. Recorded here rather than silently
 * absent, so a future reader does not conclude the file was missed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import vitestConfig from "../../vitest.config.ts";
import {
	admissionHeader,
	countsByDetector,
	type DetectorName,
	DETECTOR_NAMES,
	DETECTORS,
	repoRoot,
	scanElapsedTimeAssertion,
	scanRawTimerWait,
	scanRealProcessSpawn,
	scanUngovernedWaitFor,
} from "../support/flake-shape-scan.js";
import { testSourceFiles as allTestSourceFiles } from "../support/module-instance-scan.js";
import { localImportTargets } from "../support/hook-await-scan.js";
import { assertSortedKeys } from "../support/sweep-kit.js";

// ── The baseline ─────────────────────────────────────────────────────────

type Baseline = Record<DetectorName, Record<string, number>>;

const FLAKE_SHAPE_BASELINE: Baseline = JSON.parse(
	fs.readFileSync(
		path.join(repoRoot, "tests/support/flake-shape-baseline.json"),
		"utf8",
	),
);

/**
 * Entries admitted to a detector's baseline AFTER it was minted — a merge-
 * window device, same shape and same cost profile as
 * `single-flight-ratchet.test.ts`'s `FORWARD_DECLARED`.
 */
const ADMITTED_AFTER_BASELINE: Readonly<
	Record<string, { detector: DetectorName; reason: string }>
> = {
	// 2026-09-08 (#2622): the defect is wall-clock only — 2^N regex
	// backtracking in both glob compilers; a fake clock measures nothing.
	"elapsed-time-assertion:clients/read-guard-glob-nonbacktracking.test.ts": {
		detector: "elapsed-time-assertion",
		reason:
			"the defect is wall-clock only (2^N regex backtracking); a fake clock measures nothing",
	},
	// 2026-09-06 (#2603, was #2591 review round 2, F1): the defect is 2^N regex
	// backtracking through detectPythonEnvironment — the ANSWER was always
	// right, only the time was wrong, so no non-clock assertion separates
	// fixed from broken; header on the file states why.
	"elapsed-time-assertion:clients/workspace-glob-nonbacktracking-budget.test.ts":
		{
			detector: "elapsed-time-assertion",
			reason:
				"the defect is wall-clock only (2^N globstar backtracking); a fake clock measures nothing",
		},
	// 2026-09-07 (#2703 review r1): an unhandled derived-promise rejection is
	// only observable through Node's `unhandledRejection` event, which fires
	// on a real macrotask; the file drains one real `setImmediate` tick.
	"raw-timer-wait:clients/lsp/push-wait-settle-rejection.test.ts": {
		detector: "raw-timer-wait",
		reason:
			"unhandledRejection is delivered on a real macrotask; one real setImmediate drain, assertion on the captured list",
	},
	// 2026-09-08 (#2765 round 3): the hook remainder is the subject; fake timers
	// drive the delayed pre-snapshot work and the bounded lookup.
	"raw-timer-wait:clients/lsp/service-inconclusive-per-server.test.ts": {
		detector: "raw-timer-wait",
		reason:
			"the hook remainder is the defect; fake timers isolate the delayed pre-snapshot work from scheduler contention",
	},
	"raw-timer-wait:support/fault-injection.ts": {
		detector: "raw-timer-wait",
		reason:
			"fault injection must model real timer and child teardown timing; fake timers cannot reproduce the boundary",
	},
	"real-process-spawn:clients/biome-config-decorator-metadata.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real Biome children resolve decorator metadata that in-process calls cannot observe",
	},
	"real-process-spawn:clients/build-identity.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children establish build identity from repository state unavailable to an in-process stub",
	},
	"real-process-spawn:clients/config-diagnostic-codes.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children enumerate tracked diagnostic files, which a mocked repository cannot resolve",
	},
	"real-process-spawn:clients/dispatch/runners/ast-grep-playground-verify.test.ts":
		{
			detector: "real-process-spawn",
			reason:
				"a real ast-grep playground child parses fixture syntax beyond the runner's in-process state",
		},
	"real-process-spawn:clients/dispatch/runners/ast-grep-rule-ignores.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real ast-grep child applies ignore rules through its own file matcher",
	},
	"real-process-spawn:clients/git-tracked-ignore.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children decide tracked-versus-ignored files from index state no stub reproduces",
	},
	"real-process-spawn:clients/installer/posix-group-kill.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real POSIX shell descendants prove process-group termination across OS process state",
	},
	"real-process-spawn:clients/installer/verify-binary-semantics.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real binary children write and survive teardown, behavior an in-process installer stub cannot expose",
	},
	// 2026-09-06 (#2619 review F1, then N1/N3 in round 3): three real spawns,
	// each pinning something no in-process double can reach. (1) a `node -e`
	// child reports what IT resolved for HOME/PI_LENS_INSTALL_LOG — `os.homedir()`
	// in the test process can only ever report the ambient home. (2) `npm pack`
	// of a two-line fixture package whose `prepare` writes through
	// `os.homedir()`: the runner's defect was npm IGNORING the env it was
	// handed, which an assertion on the env object cannot see. (3) the real
	// release-qa CLI run out of a throwaway dirty tree, because main()'s call to
	// the dirty-checkout refusal — as opposed to the pure refusal itself — is
	// only reachable through the process entry point.
	// 2026-09-06 (#2507): the defect IS a child process's own exit decision —
	// libuv finding no referenced handle mid `lsp_diagnostics` and Node exiting
	// 0. A process cannot watch its own loop decide to drain, so the exit code
	// and stdout of a real headless child are the only faithful observation.
	"real-process-spawn:clients/lsp/headless-tool-call-keepalive.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real child's exit code is the observation; no in-process double can watch an event loop decide to drain",
	},
	"real-process-spawn:clients/metrics-history-stderr.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children emit stderr bytes whose metrics classification cannot be observed in-process",
	},
	"real-process-spawn:clients/safe-spawn-ambient-signal.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real children receive ambient abort signals through the OS boundary, not an in-process double",
	},
	"real-process-spawn:clients/safe-spawn-failure-taxonomy.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real child exit, timeout, and kill outcomes supply taxonomy facts unavailable from a stub",
	},
	"real-process-spawn:clients/safe-spawn-input.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real child reads stdin bytes through the pipe that safeSpawnAsync must close correctly",
	},
	"real-process-spawn:clients/safe-spawn-resource-usage.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real child CPU and RSS samples prove usage bracketing around the spawn boundary",
	},
	"real-process-spawn:clients/safe-spawn-timeout-teardown.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a wedged real child proves timeout teardown and descendant cleanup across the process boundary",
	},
	"real-process-spawn:clients/safe-spawn-windows-command.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real Windows command-line parsing decides argument boundaries no in-process parser can validate",
	},
	"real-process-spawn:clients/shared-checkout-guard.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children expose shared-checkout branch-switch races that an in-process model cannot reach",
	},
	"real-process-spawn:config/gitignore-tracked-shadow.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real gitignore rules and index entries decide shadow files outside the test process",
	},
	"real-process-spawn:config/tracked-control-bytes.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git emits control bytes from its index, which a hand-built output cannot certify",
	},
	// 2026-09-03: the published-manifest guard must run the real `npm pack`
	// (prepack/postpack are npm lifecycle hooks); header on the file states why.
	"real-process-spawn:packaging-pack-manifest.test.ts": {
		detector: "real-process-spawn",
		reason:
			"observes the real npm pack lifecycle (prepack/postpack); no in-process double is faithful",
	},
	// #2807 review F1/F4: the local CLI's exact argv and a shallow checkout's
	// missing diff are the subjects; an in-process call cannot prove either.
	"real-process-spawn:scripts/check-pr-body.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the exact local CLI and shallow checkout are the subjects; an in-process call cannot prove either command boundary",
	},
	"real-process-spawn:scripts/git-fixture-env.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children prove the script-side fixture env resolves repository metadata (HEAD, root) from a sanitized process.env",
	},
	// 2026-09-07 (#2699): the PreToolUse guard's own stdin/exit-code/stderr
	// contract is the subject under test; an in-process call to the exported
	// classify functions cannot see a drift in what Claude Code actually
	// invokes.
	"real-process-spawn:scripts/guard-bash-hook.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the hook's real stdin/exit-code/stderr contract is unobservable from an in-process call to the exported classify functions",
	},
	// #2698: gitignore/tracked-vs-untracked resolution (git init/add/commit/
	// ls-files against a throwaway fixture repo) is the exact mechanism
	// scripts/lib/knip-sibling-purge.mjs depends on and this file tests.
	"real-process-spawn:scripts/knip-sibling-purge.test.ts": {
		detector: "real-process-spawn",
		reason:
			"gitignore/tracked-vs-untracked resolution is the mechanism under test; no mock reproduces git's own resolution faithfully",
	},
	// 2026-09-07 (#2700): the gating/advisory subset test resolves oxlint's
	// REAL `--print-config` for both npm scripts (never a hand-copied rule
	// list) so a change to either script's flags is caught automatically; an
	// in-process double would just restate the test author's assumption
	// about which rules each tier enables.
	"real-process-spawn:scripts/lint-js.test.ts": {
		detector: "real-process-spawn",
		reason:
			"resolves oxlint's real --print-config for lint:js and lint:js:advisory; no in-process double is faithful",
	},
	// 2026-09-07 (#2613 review S2/T3): --dry-run env-reading/report-building
	// wiring is the subject; the real `gh` calls stay untested, same
	// documented exception as the sibling scripts/notify-clean-signal-drift.mjs.
	"real-process-spawn:scripts/notify-install-smoke-drift.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's env-to-report wiring in --dry-run mode is unobservable from an in-process stub",
	},
	// 2026-09-07 (#2723): the second, independent tool-smoke red-notifier
	// CLI's --dry-run env-to-report wiring and real (stubbed) `gh`
	// create/edit/comment/close subcommands are the subject; same documented
	// exception as its sibling notify-install-smoke-drift.test.ts above.
	"real-process-spawn:scripts/notify-tool-smoke-red.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's env-to-report wiring and real gh subcommand invocations are unobservable from an in-process stub",
	},
	// 2026-09-07 (#2613 review S3a): the retry wrapper's real exit code and
	// distinct ::error::infra: label on exhaustion are the subject.
	"real-process-spawn:scripts/npm-retry.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's real exit code and distinct infra label on exhaustion are unobservable from an in-process stub",
	},
	"real-process-spawn:scripts/prune-agent-worktrees.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git worktree commands own pruning locks and exit status beyond in-process filesystem state",
	},
	"real-process-spawn:scripts/release-qa.test.ts": {
		detector: "real-process-spawn",
		reason:
			"npm ignoring a handed env, a child's own os.homedir(), and main()'s CLI exit code are each unobservable in-process",
	},
	// 2026-09-07 (#2613): the CLI's real exit code (2 vs. 4) and its
	// GITHUB_OUTPUT write are the subject under test; header on the file
	// states why.
	"real-process-spawn:scripts/resolve-newest-in-range-host.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's real exit code (2 vs. 4) and GITHUB_OUTPUT side effect are unobservable from an in-process stub",
	},
	// 2026-09-06 (#2369): the fixture-ordering defect (an earlier LSP_FIXTURES
	// entry registering a foreign session root, declining a later one) lives
	// in the CLI's own module-load order; only a real child process is the
	// script under test.
	"real-process-spawn:scripts/smoke-tools-lsp-fixture-registration.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the fixture-ordering defect lives in the CLI's own module-load order; no in-process call is the script under test",
	},
	// 2026-09-06 (#2586 review F1): proves the actual delimiter
	// supply-host-provided-deps.mjs prints in its own stdout bytes; an
	// in-process double would just re-assert the test author's assumption.
	"real-process-spawn:scripts/supply-host-provided-deps.test.ts": {
		detector: "real-process-spawn",
		reason:
			"observes the script's real stdout bytes (newline- vs. space-delimited); no in-process double is faithful",
	},
	// 2026-09-08 (#2628): the warm's install-log home resolution is the
	// subject — a child whose env is fully pinned decides where the record
	// lands, and its own `os.homedir()` fallback is unobservable in-process.
	"real-process-spawn:scripts/warm-loader-cache.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the record's landing spot is decided by a child's own env-pinned os.homedir() fallback; unobservable in-process",
	},
	"real-process-spawn:support/fault-injection.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a genuinely wedged child proves pipe and kill behavior that a resolved promise cannot model",
	},
	"real-process-spawn:support/git-config-guard.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git config reads resolve worktree-local policy through Git's own config precedence",
	},
	"real-process-spawn:support/git-fixture-env.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children prove the support-side fixture scrubs GIT_DIR/GIT_WORK_TREE and pins cwd before a test spawns git",
	},
};

/** The `wallClockBudgetInclude` project's `include` list, read from the live config — not a hand-copied mirror of it (single-source-of-truth). */
function wallClockBudgetInclude(): string[] {
	const projects: unknown = (vitestConfig as { test?: { projects?: unknown } })
		.test?.projects;
	if (!Array.isArray(projects)) {
		throw new Error(
			"vitest.config.ts default export has no test.projects array",
		);
	}
	const project = projects
		.map(
			(entry) =>
				(entry as { test?: { name?: unknown; include?: unknown } })?.test,
		)
		.find((test) => test?.name === "wall-clock-budget");
	if (!project) {
		throw new Error(
			'vitest.config.ts has no project named "wall-clock-budget"',
		);
	}
	const include = project.include;
	if (!Array.isArray(include)) {
		throw new Error('"wall-clock-budget" project has no include list');
	}
	return include.map(String);
}

/** Support helpers inherit the serialized lane from an importing test. */
function supportHelperHasLaneProof(
	relativePath: string,
	included: ReadonlySet<string>,
): boolean {
	const target = path.join(repoRoot, "tests", relativePath);
	const files = allTestSourceFiles().filter((file) =>
		file.endsWith(".test.ts"),
	);
	const visited = new Set<string>();
	const walk = (absolute: string): boolean => {
		if (visited.has(absolute)) return false;
		visited.add(absolute);
		const relative = path
			.relative(repoRoot, absolute)
			.replaceAll(path.sep, "/");
		if (absolute.endsWith(".test.ts") && included.has(relative)) return true;
		return files.some(
			(candidate) =>
				localImportTargets(candidate).includes(absolute) && walk(candidate),
		);
	};
	return files.some(
		(candidate) =>
			localImportTargets(candidate).includes(target) && walk(candidate),
	);
}

interface RatchetProblem {
	file: string;
	detector: DetectorName;
	kind: "new-file" | "count-risen" | "stale-ceiling";
	before?: number;
	after: number;
}

/**
 * Compare today's live counts against the pinned baseline for one detector.
 * Three directions are problems: a file the baseline has never seen, an
 * allowlisted file whose count exceeds its pin, and — two-sided — an
 * allowlisted file whose count FALLS below its pin (a stale ceiling: left
 * alone it silently re-admits regrowth up to the old, higher pin without
 * ever tripping the RISES check). A file that drops out of the live scan
 * entirely is handled separately (see "the baseline names no file that has
 * vanished" below); this function only walks `live`, so a file no longer
 * flagged at all is not iterated here.
 */
function auditAgainstBaseline(
	detector: DetectorName,
	live: Readonly<Record<string, number>>,
	baseline: Readonly<Baseline> = FLAKE_SHAPE_BASELINE,
): RatchetProblem[] {
	const pinned = baseline[detector] ?? {};
	const problems: RatchetProblem[] = [];
	for (const [file, count] of Object.entries(live)) {
		const before = pinned[file];
		if (before === undefined) {
			problems.push({ file, detector, kind: "new-file", after: count });
		} else if (count > before) {
			problems.push({
				file,
				detector,
				kind: "count-risen",
				before,
				after: count,
			});
		} else if (count < before) {
			problems.push({
				file,
				detector,
				kind: "stale-ceiling",
				before,
				after: count,
			});
		}
	}
	return problems;
}

function describeProblem(p: RatchetProblem): string {
	const admitted = ADMITTED_AFTER_BASELINE[`${p.detector}:${p.file}`];
	const admittedNote = admitted
		? ` (admitted: ${admitted.reason})`
		: " — admit it with a `// flake-shape: <detector> — <reason>` header " +
			"and add the file to vitest.config.ts's wallClockBudgetInclude, or " +
			"remove the real spawn / wall-clock assertion / raw timer wait";
	if (p.kind === "new-file") {
		return `${p.detector}: NEW flagged file ${p.file} (${p.after} hit(s))${admittedNote}`;
	}
	if (p.kind === "stale-ceiling") {
		return (
			`${p.detector}: ${p.file} fell from ${p.before} to ${p.after} hit(s) ` +
			`— tighten the baseline to ${p.after}`
		);
	}
	return `${p.detector}: ${p.file} rose from ${p.before} to ${p.after} hit(s)${admittedNote}`;
}

describe("flake-shape ratchet (#2547)", () => {
	it("keeps every admission map sorted", () => {
		// #2671 recurrence: an unsorted admission is a merge-conflict magnet.
		expect(() => assertSortedKeys("fixture", ["b", "a"])).toThrow(
			"entries must be sorted",
		);
		for (const detector of DETECTOR_NAMES) {
			assertSortedKeys(
				`flake-shape-baseline:${detector}`,
				Object.keys(FLAKE_SHAPE_BASELINE[detector]),
			);
		}
		assertSortedKeys(
			"ADMITTED_AFTER_BASELINE",
			Object.keys(ADMITTED_AFTER_BASELINE),
		);
		assertSortedKeys("wallClockBudgetInclude", wallClockBudgetInclude());
	});
	it.each(DETECTOR_NAMES)(
		"detector %s: no new files, no risen counts vs. the baseline",
		(detector) => {
			const problems = auditAgainstBaseline(
				detector,
				countsByDetector(detector),
			);
			expect(problems.map(describeProblem)).toEqual([]);
		},
		30_000,
	);

	// Whole-tree scan performs AST parsing and can exceed Vitest's default under
	// CI contention (run 34195211598, head 5c0aa5a4).
	it("the baseline names no file that has vanished from the live scan", () => {
		// Stated asymmetrically on purpose (see module doc): a count FALLING is
		// not a failure above, but a baseline entry for a file the scan no
		// longer touches AT ALL is dead weight worth flagging here, same as
		// `auditRegistry`'s stale-exemption check one layer up.
		const stale: string[] = [];
		for (const detector of DETECTOR_NAMES) {
			const live = countsByDetector(detector);
			for (const file of Object.keys(FLAKE_SHAPE_BASELINE[detector] ?? {})) {
				if (!(file in live)) stale.push(`${detector}:${file}`);
			}
		}
		expect(stale).toEqual([]);
	}, 30_000);

	it("carries the three counts in this header (informational, kept in sync)", () => {
		// Not asserted against a hardcoded number — this test's job is only to
		// prove the header comment above stays readable-and-current; the real
		// gate is the two tests above.
		for (const detector of DETECTOR_NAMES) {
			expect(FLAKE_SHAPE_BASELINE[detector]).toBeDefined();
		}
	});
});

describe("flake-shape ratchet — the compare function", () => {
	it("ATTACK: a fixture file that adds a raw setTimeout wait is a NEW flagged file — RED", () => {
		// The acceptance-criterion scenario, driven through the real detector:
		// a file the baseline has never seen, containing exactly the shape
		// detector 3 exists to catch.
		const fixtureSource = [
			'it("waits on a raw timer, never allowlisted", async () => {',
			"\tawait new Promise((resolve) => setTimeout(resolve, 30));",
			"});",
		].join("\n");
		const hits = scanRawTimerWait(
			"clients/never-baselined-fixture.test.ts",
			fixtureSource,
		);
		const live = { "clients/never-baselined-fixture.test.ts": hits.length };
		const problems = auditAgainstBaseline("raw-timer-wait", live);
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(
				"NEW flagged file clients/never-baselined-fixture.test.ts",
			),
		]);
	});

	it("ATTACK: a fixture file that adds an ungoverned vi.waitFor is a NEW flagged file — RED", () => {
		// Same acceptance-criterion shape as above, for detector 4: a real-timers
		// vi.waitFor in a file the baseline has never seen.
		const fixtureSource = [
			'it("polls until ready, never allowlisted", async () => {',
			"\tawait vi.waitFor(() => expect(client.isReady()).toBe(true));",
			"});",
		].join("\n");
		const hits = scanUngovernedWaitFor(
			"clients/never-baselined-waitfor-fixture.test.ts",
			fixtureSource,
		);
		const live = {
			"clients/never-baselined-waitfor-fixture.test.ts": hits.length,
		};
		const problems = auditAgainstBaseline("ungoverned-wait-for", live);
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(
				"NEW flagged file clients/never-baselined-waitfor-fixture.test.ts",
			),
		]);

		// GREEN under vi.useFakeTimers(): the same call, governed, produces no
		// hit at all, so nothing reaches the ratchet in the first place.
		const governedSource = [
			'it("polls under fake time", async () => {',
			"\tvi.useFakeTimers();",
			"\tconst p = vi.waitFor(() => expect(client.isReady()).toBe(true));",
			"\tawait vi.advanceTimersByTimeAsync(100);",
			"\tawait p;",
			"});",
		].join("\n");
		expect(
			scanUngovernedWaitFor(
				"clients/never-baselined-waitfor-fixture.test.ts",
				governedSource,
			),
		).toEqual([]);
	});

	it("does not flag a file already at its pinned count — GREEN on the allowlist", () => {
		const [firstFile, firstCount] = Object.entries(
			FLAKE_SHAPE_BASELINE["raw-timer-wait"],
		)[0];
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[firstFile]: firstCount,
		});
		expect(problems).toEqual([]);
	});

	it("flags a pinned file whose count rose", () => {
		const [firstFile, firstCount] = Object.entries(
			FLAKE_SHAPE_BASELINE["raw-timer-wait"],
		)[0];
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[firstFile]: firstCount + 1,
		});
		expect(problems).toHaveLength(1);
		expect(problems[0].kind).toBe("count-risen");
	});

	it("flags a pinned file whose count fell — a stale ceiling, not a free pass", () => {
		// Two-sided ratchet (reviewer probe): a fall is NOT silently accepted.
		// Left unpinned it is a stale ceiling that later re-admits regrowth
		// without ever tripping the count-risen check.
		const [firstFile, firstCount] = Object.entries(
			FLAKE_SHAPE_BASELINE["raw-timer-wait"],
		).find(([, count]) => count > 1)!;
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[firstFile]: firstCount - 1,
		});
		expect(problems).toHaveLength(1);
		expect(problems[0].kind).toBe("stale-ceiling");
		expect(describeProblem(problems[0])).toContain(
			`tighten the baseline to ${firstCount - 1}`,
		);
	});

	it("ATTACK (reviewer probe): pinned 5, live drops to 2, regrows to 4 — still flagged, never silently re-admitted", () => {
		// Drives the REAL auditAgainstBaseline via its injectable baseline
		// param, not a re-derived copy of its logic.
		const file = "clients/probe-fixture.test.ts";
		const pinned5: Baseline = {
			"real-process-spawn": {},
			"elapsed-time-assertion": {},
			"raw-timer-wait": { [file]: 5 },
			"ungoverned-wait-for": {},
		};

		// Drops to 2 (an improvement — but the ceiling is now stale at 5).
		const dropped = auditAgainstBaseline(
			"raw-timer-wait",
			{ [file]: 2 },
			pinned5,
		);
		expect(dropped).toHaveLength(1);
		expect(dropped[0].kind).toBe("stale-ceiling");

		// Regrows to 4 — still under the stale pin of 5, so the RISES check
		// alone (pre-fix) would say nothing; the two-sided check still flags
		// it because 4 < 5.
		const regrown = auditAgainstBaseline(
			"raw-timer-wait",
			{ [file]: 4 },
			pinned5,
		);
		expect(regrown).toHaveLength(1);
		expect(regrown[0].kind).toBe("stale-ceiling");
		expect(regrown[0].after).toBe(4);
	});
});

/**
 * Both admission-gate requirements for one `ADMITTED_AFTER_BASELINE` entry:
 * the file's own `// flake-shape: <detector> — <reason>` header, AND the
 * file's membership in `vitest.config.ts`'s `wallClockBudgetInclude`
 * project. Pulled out as its own function so it is unit-testable against
 * fixtures directly — the attack cases below keep this logic mutation-sensitive
 * even when the admission map is empty in a later steady state.
 */
function validateAdmission(
	key: string,
	entry: { detector: DetectorName; reason: string },
	source: string | undefined,
	wallClockBudgetIncluded: ReadonlySet<string>,
	relativeTestsPath: string,
): string[] {
	const problems: string[] = [];
	if (source === undefined) {
		return [`${key}: file does not exist`];
	}
	const header = admissionHeader(source);
	if (!header) {
		problems.push(
			`${key}: missing "// flake-shape: <detector> — <reason>" header`,
		);
	} else if (header.detector !== entry.detector) {
		problems.push(
			`${key}: header names detector "${header.detector}", expected "${entry.detector}"`,
		);
	} else if (header.reason.length < 15) {
		problems.push(`${key}: header reason too short to be real`);
	}
	const laneProof =
		wallClockBudgetIncluded.has(`tests/${relativeTestsPath}`) ||
		(relativeTestsPath.startsWith("support/") &&
			supportHelperHasLaneProof(relativeTestsPath, wallClockBudgetIncluded));
	if (!laneProof) {
		problems.push(
			`${key}: not listed in vitest.config.ts wallClockBudgetInclude`,
		);
	}
	if (entry.reason.trim().length < 15) {
		problems.push(`${key}: ADMITTED_AFTER_BASELINE reason too short`);
	}
	return problems;
}

describe("flake-shape ratchet — admission gate", () => {
	it("ADMITTED_AFTER_BASELINE entries carry the header and wallClockBudgetInclude membership", () => {
		const included = new Set(wallClockBudgetInclude());
		const problems: string[] = [];
		for (const [key, entry] of Object.entries(ADMITTED_AFTER_BASELINE)) {
			const file = key.slice(entry.detector.length + 1);
			if (file.startsWith("support/") && !file.endsWith(".test.ts")) continue;
			const absolute = path.join(repoRoot, "tests", file);
			const source = fs.existsSync(absolute)
				? fs.readFileSync(absolute, "utf8")
				: undefined;
			problems.push(...validateAdmission(key, entry, source, included, file));
		}
		for (const detector of DETECTOR_NAMES) {
			for (const file of Object.keys(FLAKE_SHAPE_BASELINE[detector] ?? {})) {
				if (!file.startsWith("support/") || file.endsWith(".test.ts")) continue;
				const key = `${detector}:${file}`;
				const entry = ADMITTED_AFTER_BASELINE[key];
				if (!entry) {
					problems.push(`${key}: missing ADMITTED_AFTER_BASELINE entry`);
					continue;
				}
				const source = fs.readFileSync(
					path.join(repoRoot, "tests", file),
					"utf8",
				);
				problems.push(...validateAdmission(key, entry, source, included, file));
			}
		}
		expect(problems).toEqual([]);
	});

	// `ADMITTED_AFTER_BASELINE` is empty in steady state, so the test above
	// alone never proves `validateAdmission` catches anything. These fixtures
	// drive it directly, one requirement at a time.
	const GOOD_SOURCE =
		"// flake-shape: real-process-spawn — the real CLI's exit-code " +
		"contract is under test; a mock cannot reproduce it faithfully\n" +
		"execFileSync(cmd);\n";
	const GOOD_ENTRY = {
		detector: "real-process-spawn" as const,
		reason: "the real CLI's exit-code contract is under test",
	};
	const INCLUDED = new Set(["tests/clients/some-admitted-fixture.test.ts"]);

	it("ATTACK: passes when the header, detector match, and membership all hold", () => {
		expect(
			validateAdmission(
				"real-process-spawn:clients/some-admitted-fixture.test.ts",
				GOOD_ENTRY,
				GOOD_SOURCE,
				INCLUDED,
				"clients/some-admitted-fixture.test.ts",
			),
		).toEqual([]);
	});

	it("ATTACK: a missing header is caught", () => {
		const problems = validateAdmission(
			"real-process-spawn:clients/some-admitted-fixture.test.ts",
			GOOD_ENTRY,
			"execFileSync(cmd); // no header at all\n",
			INCLUDED,
			"clients/some-admitted-fixture.test.ts",
		);
		expect(problems).toEqual([expect.stringContaining("missing")]);
	});

	it("ATTACK: a header naming the WRONG detector is caught", () => {
		const wrongDetectorSource =
			"// flake-shape: raw-timer-wait — this reason talks about the wrong detector\n" +
			"execFileSync(cmd);\n";
		const problems = validateAdmission(
			"real-process-spawn:clients/some-admitted-fixture.test.ts",
			GOOD_ENTRY,
			wrongDetectorSource,
			INCLUDED,
			"clients/some-admitted-fixture.test.ts",
		);
		expect(problems).toEqual([
			expect.stringContaining('names detector "raw-timer-wait"'),
		]);
	});

	it("ATTACK: missing wallClockBudgetInclude membership is caught even with a good header", () => {
		const problems = validateAdmission(
			"real-process-spawn:clients/some-admitted-fixture.test.ts",
			GOOD_ENTRY,
			GOOD_SOURCE,
			new Set<string>(), // empty: file is not in the include list
			"clients/some-admitted-fixture.test.ts",
		);
		expect(problems).toEqual([
			expect.stringContaining("wallClockBudgetInclude"),
		]);
	});

	it("ATTACK: a nonexistent file is caught", () => {
		expect(
			validateAdmission(
				"real-process-spawn:clients/does-not-exist.test.ts",
				GOOD_ENTRY,
				undefined,
				INCLUDED,
				"clients/does-not-exist.test.ts",
			),
		).toEqual([expect.stringContaining("does not exist")]);
	});
});

// ── The scan itself — fixtures, self-tests, mutation-proof ────────────────

describe("flake-shape scan — real-process-spawn", () => {
	it("ATTACK named spelling: child_process import + execFileSync + vitest-in-argv", () => {
		const source = [
			'import { execFileSync } from "node:child_process";',
			"",
			'it("runs the suite as a child", () => {',
			'\texecFileSync("npx", ["vitest", "run", "--reporter=json"]);',
			"});",
		].join("\n");
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual([
			"child_process import",
			"execFileSync( real sync spawn",
		]);
	});

	it("ATTACK novel spelling: require() + async spawn() with a vitest bin path in argv", () => {
		const source = [
			'const { spawn } = require("child_process");',
			"",
			'it("relaunches vitest asynchronously", () => {',
			'\tspawn(process.execPath, ["node_modules/.bin/vitest", "run"]);',
			"});",
		].join("\n");
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual([
			"child_process import",
			'spawn( vitest-in-vitest (argv mentions "vitest")',
		]);
	});

	it("does not flag an async spawn() whose argv never mentions vitest", () => {
		const source = [
			'import { spawn } from "node:child_process";',
			'it("spawns something unrelated", () => {',
			'\tspawn(process.execPath, ["git", "status"]);',
			"});",
		].join("\n");
		// The import line still counts (a real child_process import is itself
		// the shape); the plain spawn() call does not add a second hit because
		// it is neither the sync triad nor vitest-in-argv.
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual(["child_process import"]);
	});

	it("does not flag a comment that merely names the calls", () => {
		const source = [
			"// This test used to call execFileSync(cmd) directly.",
			'it("no longer spawns", () => {',
			"\texpect(1).toBe(1);",
			"});",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toEqual([]);
	});

	it("flags support spawn helpers called from a test, but not quoted names", () => {
		const source = [
			'const prose = "gitFixtureSpawnAsync(cwd, args)";',
			"// safeSpawnAsync(command, args) is intentionally only documentation.",
			'it("uses the fixture boundary", async () => {',
			"	await gitFixtureSpawnAsync(cwd, args);",
			"	await safeSpawnAsync(command, args);",
			"});",
		].join("\n");
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual([
			"gitFixtureSpawnAsync( support spawn helper",
			"safeSpawnAsync( support spawn helper",
		]);
	});

	it("does not count a helper whose module is mocked", () => {
		const source = [
			'import { safeSpawnAsync } from "../../clients/safe-spawn.js";',
			'vi.mock("../../clients/safe-spawn.js");',
			"await safeSpawnAsync(command, args);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toEqual([]);
	});

	it("does not let a string-only mock declaration suppress a real helper", () => {
		const source = [
			"const prose = 'vi.mock(\"../../clients/safe-spawn.js\")';",
			"await safeSpawnAsync(command, args);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toHaveLength(1);
	});

	it("does not let a commented mock declaration suppress a real helper", () => {
		const source = [
			'// vi.mock("../../clients/safe-spawn.js");',
			"await safeSpawnAsync(command, args);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toHaveLength(1);
	});

	it("does not count sync spawns behind a mocked child_process module", () => {
		const source = [
			'import { execFileSync } from "node:child_process";',
			'vi.mock("node:child_process");',
			'execFileSync(process.execPath, ["git", "status"]);',
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toEqual([]);
	});

	it("keeps helper calls when an unrelated module is mocked", () => {
		const source = [
			'vi.mock("../../clients/unrelated.js");',
			"await safeSpawnAsync(command, args);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toHaveLength(1);
	});
});

describe("flake-shape scan — elapsed-time-assertion", () => {
	it("ATTACK named spelling: Date.now() delta via a variable, toBeLessThan", () => {
		const source = [
			'it("finishes fast", () => {',
			"\tconst start = Date.now();",
			"\tdoWork();",
			"\tconst elapsed = Date.now() - start;",
			"\texpect(elapsed).toBeLessThan(500);",
			"});",
		].join("\n");
		const hits = scanElapsedTimeAssertion("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(5);
	});

	it("ATTACK novel spelling: inline performance.now() delta, toBeGreaterThanOrEqual", () => {
		const source = [
			'it("takes at least this long", () => {',
			"\tconst t0 = performance.now();",
			"\tdoSlowWork();",
			"\texpect(performance.now() - t0).toBeGreaterThanOrEqual(10);",
			"});",
		].join("\n");
		const hits = scanElapsedTimeAssertion("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(4);
	});

	it("SEMANTIC not token: a clock read and a numeric matcher in the same file, unrelated, does not fire", () => {
		// shape 34: token co-occurrence of Date.now() and toBeLessThan must NOT
		// be enough — only an actual delta flowing into the matcher counts.
		const source = [
			'it("reads the clock for a log line, asserts something unrelated", () => {',
			"\tconst start = Date.now();",
			'\tlogEvent("start", start);',
			"\texpect(result.items.length).toBeLessThan(5);",
			"});",
		].join("\n");
		expect(scanElapsedTimeAssertion("fixture.test.ts", source)).toEqual([]);
	});

	it("does not flag a non-clock subtraction feeding a numeric matcher", () => {
		const source = [
			'it("checks a count", () => {',
			"\tconst remaining = total - consumed;",
			"\texpect(remaining).toBeLessThan(10);",
			"});",
		].join("\n");
		expect(scanElapsedTimeAssertion("fixture.test.ts", source)).toEqual([]);
	});
});

describe("flake-shape scan — raw-timer-wait", () => {
	it("ATTACK named spelling: raw setTimeout wait via a Promise", () => {
		const source = [
			'it("waits a bit", async () => {',
			"\tawait new Promise((resolve) => setTimeout(resolve, 50));",
			"\texpect(state.ready).toBe(true);",
			"});",
		].join("\n");
		const hits = scanRawTimerWait("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("setTimeout");
	});

	it("ATTACK novel spelling: raw setInterval poll", () => {
		const source = [
			'it("polls until ready", () => {',
			"\tconst id = setInterval(() => checkReady(), 25);",
			"\treturn stopWhenReady(id);",
			"});",
		].join("\n");
		const hits = scanRawTimerWait("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("setInterval");
	});

	it("does not flag a raw wait governed by vi.useFakeTimers()", () => {
		const source = [
			'it("advances fake time", () => {',
			"\tvi.useFakeTimers();",
			"\tconst p = new Promise((resolve) => setTimeout(resolve, 1000));",
			"\tvi.advanceTimersByTime(1000);",
			"\tvi.useRealTimers();",
			"\treturn p;",
			"});",
		].join("\n");
		expect(scanRawTimerWait("fixture.test.ts", source)).toEqual([]);
	});

	it("flags a raw wait AFTER vi.useRealTimers() restores real timers", () => {
		const source = [
			'it("goes back to real timers, then waits raw", async () => {',
			"\tvi.useFakeTimers();",
			"\tvi.advanceTimersByTime(0);",
			"\tvi.useRealTimers();",
			"\tawait new Promise((resolve) => setTimeout(resolve, 20));",
			"});",
		].join("\n");
		const hits = scanRawTimerWait("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(5);
	});

	it("exempts interleaving-kit.ts by name", () => {
		const source =
			"export function realWait(ms) {\n\treturn new Promise((r) => setTimeout(r, ms));\n}\n";
		expect(scanRawTimerWait("interleaving-kit.ts", source)).toEqual([]);
	});

	it("(#2563) the live scan walks tests/support helpers: fault-injection.ts sits in the population", () => {
		// Mutation-sensitive population proof: dropping the support walk from
		// countsByDetector makes this red. fault-injection.ts is the one
		// existing helper the extended scan flags (its sanctioned delayInside
		// timer + teardown failsafe are baselined, not admitted).
		expect(countsByDetector("raw-timer-wait")).toHaveProperty(
			"support/fault-injection.ts",
		);
	});

	it("(#2563) the spawn detector stays test-file-only: support helpers are the sanctioned spawn boundary", () => {
		// git-fixture-env.ts / fake-child.ts / spawn-shapes.ts import
		// node:child_process by design — they are the fixture boundary the
		// test-side detector routes callers toward, not a flake shape.
		expect(
			countsByDetector("real-process-spawn")["support/git-fixture-env.ts"],
		).toBeUndefined();
		expect(
			countsByDetector("real-process-spawn")["support/fake-child.ts"],
		).toBeUndefined();
	});

	it("ATTACK (#2563): a raw timer inside a tests/support helper is a NEW flagged file", () => {
		// The acceptance-criterion scenario for the new population: a helper
		// file the baseline has never seen, containing exactly the shape
		// detector 3 exists to catch.
		const fixtureSource = [
			"export function tick(ms: number): void {",
			"\tsetTimeout(() => {}, ms);",
			"}",
		].join("\n");
		const file = "support/_fixture-raw-timer.ts";
		const hits = scanRawTimerWait(file, fixtureSource);
		expect(hits).toHaveLength(1);
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[file]: hits.length,
		});
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(`NEW flagged file ${file}`),
		]);
	});

	it("ATTACK (#2563): a delay clone DEFINED in a tests/support helper is flagged even when its timer is hidden", () => {
		// The evasion the issue names: the clone's timer text is never
		// `setTimeout(` (aliased import), so only the definition shape sees
		// it — the raw-timer call regex alone would pass the clone silently.
		const fixtureSource = [
			'import { setTimeout as sleep } from "node:timers";',
			"",
			"export const delay = (ms: number) =>",
			"\tnew Promise<void>((resolve) => sleep(resolve, ms));",
		].join("\n");
		const file = "support/_fixture-hidden-timer-delay.ts";
		const hits = scanRawTimerWait(file, fixtureSource);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("delay/sleep helper definition");
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[file]: hits.length,
		});
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(`NEW flagged file ${file}`),
		]);
	});

	it.each([
		[
			"local alias",
			"export function pause(ms: number) { const t = setTimeout; t(() => {}, ms); }",
		],
		[
			"destructured globalThis alias",
			"const { setTimeout: t } = globalThis; export function pause(ms: number) { t(() => {}, ms); }",
		],
		[
			"destructured globalThis shorthand",
			"const { setTimeout } = globalThis; export function pause(ms: number) { setTimeout(() => {}, ms); }",
		],
		[
			"named timers/promises import",
			'import { setTimeout as timer } from "node:timers/promises"; export function pause(ms: number) { return timer(ms); }',
		],
		[
			"namespace timers/promises import",
			'import * as timers from "timers/promises"; export function pause(ms: number) { return timers.setTimeout(ms); }',
		],
	])("flags a %s timer alias", (_name, source) => {
		// #2563 recurrence: a pause/tick helper must not hide a real timer
		// behind a binding that evades both the delay-name and raw-call passes.
		expect(
			scanRawTimerWait("support/_fixture-aliased-timer.ts", source),
		).toHaveLength(1);
	});

	it("does not treat a destructured non-timer object as a timer alias", () => {
		const source =
			"const { setTimeout: t } = unrelated; export function pause(ms: number) { t(() => {}, ms); }";
		expect(
			scanRawTimerWait("support/_fixture-aliased-timer.ts", source),
		).toEqual([]);
	});

	it("(#2563) the delay/sleep definition shape is support-scoped: a non-support file is not flagged for it", () => {
		// In a .test.ts file the shape is redundant (the timer call itself is
		// already governed), so the definition check must not widen the
		// population there.
		const fixtureSource =
			"export const delay = (ms: number) =>\n" +
			"\tnew Promise<void>((resolve) => sleep(resolve, ms));\n";
		expect(
			scanRawTimerWait("clients/uses-delay.test.ts", fixtureSource),
		).toEqual([]);
	});
});

describe("flake-shape scan — ungoverned-wait-for", () => {
	it("ATTACK: a real-timers vi.waitFor is flagged", () => {
		const source = [
			'it("eventually settles", async () => {',
			"\tawait vi.waitFor(() => expect(client.isReady()).toBe(true));",
			"});",
		].join("\n");
		const hits = scanUngovernedWaitFor("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("vi.waitFor");
	});

	it("does not flag a vi.waitFor governed by vi.useFakeTimers()", () => {
		const source = [
			'it("advances fake time to settle", async () => {',
			"\tvi.useFakeTimers();",
			"\tconst p = vi.waitFor(() => expect(ready).toBe(true));",
			"\tawait vi.advanceTimersByTimeAsync(100);",
			"\tawait p;",
			"\tvi.useRealTimers();",
			"});",
		].join("\n");
		expect(scanUngovernedWaitFor("fixture.test.ts", source)).toEqual([]);
	});

	it("flags a vi.waitFor AFTER vi.useRealTimers() restores real timers", () => {
		const source = [
			'it("goes back to real timers, then waits ungoverned", async () => {',
			"\tvi.useFakeTimers();",
			"\tvi.advanceTimersByTime(0);",
			"\tvi.useRealTimers();",
			"\tawait vi.waitFor(() => expect(ready).toBe(true));",
			"});",
		].join("\n");
		const hits = scanUngovernedWaitFor("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(5);
	});

	it("does not flag a comment that merely names vi.waitFor", () => {
		const source = [
			"// This test used to call vi.waitFor(cond) directly.",
			'it("no longer polls", () => {',
			"\texpect(1).toBe(1);",
			"});",
		].join("\n");
		expect(scanUngovernedWaitFor("fixture.test.ts", source)).toEqual([]);
	});
});

describe("flake-shape scan — mutation-proof self-test", () => {
	it("has exactly the three declared detectors, each catching its own canonical fixture", () => {
		const canonicalFixtures: Record<DetectorName, string> = {
			"real-process-spawn": 'execFileSync("npx", ["vitest", "run"]);\n',
			"elapsed-time-assertion":
				"const start = Date.now();\nexpect(Date.now() - start).toBeLessThan(1);\n",
			"raw-timer-wait": "setTimeout(() => {}, 10);\n",
			"ungoverned-wait-for":
				"await vi.waitFor(() => expect(ready).toBe(true));\n",
		};
		expect(Object.keys(canonicalFixtures).sort()).toEqual(
			[...DETECTOR_NAMES].sort(),
		);
		for (const name of DETECTOR_NAMES) {
			const detector = DETECTORS[name];
			expect(detector, `detector "${name}" must exist in DETECTORS`).toBeTypeOf(
				"function",
			);
			const hits = detector("fixture.test.ts", canonicalFixtures[name]);
			expect(
				hits.length,
				`detector "${name}" must flag its own canonical fixture`,
			).toBeGreaterThan(0);
		}
	});
});

describe("flake-shape scan — admission header parsing", () => {
	it("parses a well-formed header", () => {
		const source =
			"// flake-shape: real-process-spawn — the real npm CLI's exit-code " +
			"contract is the thing under test; a mock cannot reproduce it\n" +
			"execFileSync(cmd);\n";
		const header = admissionHeader(source);
		expect(header?.detector).toBe("real-process-spawn");
		expect(header?.reason).toContain("exit-code");
	});

	it("returns undefined with no header", () => {
		expect(admissionHeader("execFileSync(cmd);\n")).toBeUndefined();
	});

	it("does not count a header-shaped string literal", () => {
		expect(
			admissionHeader('"// flake-shape: real-process-spawn — quoted";\n'),
		).toBeUndefined();
		expect(
			admissionHeader(
				"const prose = `\n// flake-shape: real-process-spawn — quoted`\n",
			),
		).toBeUndefined();
		expect(
			admissionHeader(
				"// flake-shape: real-process-spawn — a real comment reason\n",
			)?.detector,
		).toBe("real-process-spawn");
	});
});
