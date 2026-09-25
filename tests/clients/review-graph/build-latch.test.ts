/**
 * #1962 — the `_buildCache` dedupe entry must live only while its build is
 * PENDING.
 *
 * It used to be deleted on rejection only, so a settled promise for a SKIPPED
 * or COMPLETED build answered every later `buildOrUpdateGraph` for the same key
 * for the rest of the process. The only thing that ever removed it was
 * `clearGraphCache()` from the dispatch pipeline, and the background build
 * `project_report` kicks off never goes through the pipeline. The investigation
 * transcript: four `project_report` calls over 37s, one `build_started` record,
 * and three "A retry was started." messages with no retry behind them.
 *
 * That is the process-lifetime-latch shape from AGENTS.md — dedupe state whose
 * lifetime must be the operation's, not the process's.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	_resetProjectReportBuildGuardForTests,
	projectReport,
} from "../../../clients/project-report.js";
import {
	_resetReviewGraphBuildAttemptsForTests,
	_resetReviewGraphSizeSkipTtlForTests,
	_resetReviewGraphSizeSkipVerdictsForTests,
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getLastReviewGraphBuildAttempt,
	flushReviewGraphPersistsForTests,
	isGraphBuildInFlight,
	waitForReviewGraphPersistsForTests,
} from "../../../clients/review-graph/builder.js";
import * as scanPolicy from "../../../clients/project-scan-policy.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

const savedEnv = new Map<string, string | undefined>();

function tmpProject(fileCount = 2): string {
	const dir = setupTestEnvironment("pi-lens-build-latch-").tmpDir;
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	for (let i = 0; i < fileCount; i += 1) {
		fs.writeFileSync(
			path.join(dir, "src", `mod_${i}.ts`),
			`export function fn_${i}() {\n\treturn ${i};\n}\n`,
		);
	}
	return dir;
}

function setEnv(name: string, value: string | undefined): void {
	if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** The build id of the most recent attempt — the "did a build actually run?" probe. */
function lastBuildId(cwd: string): number | undefined {
	return getLastReviewGraphBuildAttempt(cwd)?.buildId;
}

beforeEach(() => {
	clearReviewGraphWorkspaceCache();
	_resetReviewGraphBuildAttemptsForTests();
	_resetReviewGraphSizeSkipVerdictsForTests();
	_resetReviewGraphSizeSkipTtlForTests();
	_resetProjectReportBuildGuardForTests();
});

afterEach(async () => {
	// A build queues a persist into the project's data dir; let it land
	// before the root is removed, or it recreates the root afterwards.
	flushReviewGraphPersistsForTests();
	await waitForReviewGraphPersistsForTests();
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	savedEnv.clear();
	_resetReviewGraphSizeSkipTtlForTests();
	clearReviewGraphWorkspaceCache();
	await cleanupTestEnvironmentsDrained("pi-lens-build-latch-");
	vi.restoreAllMocks();
});

describe("buildOrUpdateGraph in-flight dedupe (#1962)", () => {
	it("a settled build does not suppress the next build for the same key", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));

		await buildOrUpdateGraph(cwd, [], new FactStore());
		const first = lastBuildId(cwd);
		expect(first).toBeDefined();

		// PRE-FIX: the settled promise is still in `_buildCache`, so this returns
		// it without starting anything and the build id never moves.
		await buildOrUpdateGraph(cwd, [], new FactStore());
		expect(lastBuildId(cwd)).toBeGreaterThan(first as number);
	});

	it("a settled SKIPPED build does not suppress the next build either", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));
		// One file over a cap of 1 → the `too_many_files` skip, the exact outcome
		// in the investigation transcript.
		setEnv("PI_LENS_REVIEW_GRAPH_MAX_FILES", "1");

		await buildOrUpdateGraph(cwd, [], new FactStore());
		expect(getLastReviewGraphBuildAttempt(cwd)).toMatchObject({
			outcome: "skipped",
			reason: "too_many_files",
		});
		const first = lastBuildId(cwd) as number;

		await buildOrUpdateGraph(cwd, [], new FactStore());
		expect(lastBuildId(cwd)).toBeGreaterThan(first);
	});

	it("the key is released once the build settles", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));

		const inFlight = buildOrUpdateGraph(cwd, [], new FactStore());
		expect(isGraphBuildInFlight(cwd)).toBe(true);
		await inFlight;
		expect(isGraphBuildInFlight(cwd)).toBe(false);
	});

	it("still dedupes genuinely CONCURRENT calls for the same key", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));

		// Both calls happen before either settles: one build, one id, and the very
		// same promise instance. Deleting on settle must not weaken this.
		const a = buildOrUpdateGraph(cwd, [], new FactStore());
		// `recordBuildAttempt("running")` runs synchronously inside the call, so
		// this id belongs to the build the first call started.
		const idAfterFirst = lastBuildId(cwd);
		const b = buildOrUpdateGraph(cwd, [], new FactStore());
		expect(a).toBe(b);
		expect(lastBuildId(cwd)).toBe(idAfterFirst);
		await Promise.all([a, b]);
		expect(lastBuildId(cwd)).toBe(idAfterFirst);
	});

	it("a failed build still releases the key", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));
		const facts = new FactStore();
		vi.spyOn(facts, "setSessionFact").mockImplementation(() => {
			throw new Error("synthetic graph build death");
		});

		await expect(buildOrUpdateGraph(cwd, [], facts)).rejects.toThrow(
			"synthetic graph build death",
		);
		expect(isGraphBuildInFlight(cwd)).toBe(false);
		const first = lastBuildId(cwd) as number;
		await buildOrUpdateGraph(cwd, [], new FactStore());
		expect(lastBuildId(cwd)).toBeGreaterThan(first);
	});
});

describe("dedupe key folds every caller's cwd spelling (#1962 review F2)", () => {
	/**
	 * A textual variant of `dir` that the FILESYSTEM agrees is the same
	 * directory, or `undefined` when this filesystem has no such variant.
	 *
	 * Probed, never derived from `process.platform` (catalog shape 2). On
	 * Windows the separator is interchangeable, so the backslash spelling is a
	 * real second spelling of one directory — the one `runtime-session.ts:1562`,
	 * `lens-map.ts:1243`, and `mcp/cli.ts:59` actually hand in. On POSIX a
	 * backslash is an ordinary filename character, so that spelling names a
	 * DIFFERENT path and asserting on it would be wrong, not merely useless.
	 */
	function separatorVariant(dir: string): string | undefined {
		// Try BOTH spellings and keep whichever differs from what we were handed
		// and still resolves to a directory. `mkdtempSync` returns the host's
		// native separator, so hardcoding one direction would compare a string
		// with itself and assert nothing.
		for (const candidate of [
			dir.replaceAll("\\", "/"),
			dir.replaceAll("/", "\\"),
		]) {
			if (candidate === dir) continue;
			try {
				if (fs.statSync(candidate).isDirectory()) return candidate;
			} catch {
				// Not a path on this filesystem — try the other spelling.
			}
		}
		return undefined;
	}

	it("a dot-segment spelling lands on the same in-flight key", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));
		// Built by CONCATENATION, not `path.join` — join collapses `..` itself,
		// which would make this assertion true without the fix doing anything.
		// `<dir>/src/..` names the same directory on every OS, so this half runs
		// on Linux CI as well as Windows and cannot pass by being skipped.
		const detour = `${cwd}/src/..`;
		expect(detour).not.toBe(cwd);
		expect(fs.statSync(detour).isDirectory()).toBe(true);

		const build = buildOrUpdateGraph(cwd, [], new FactStore());
		expect(isGraphBuildInFlight(detour)).toBe(true);
		// The same fold in the other direction: a build STARTED under the detour
		// spelling is the one a normalized caller joins.
		expect(buildOrUpdateGraph(detour, [], new FactStore())).toBe(build);
		await build;
		expect(isGraphBuildInFlight(detour)).toBe(false);
	});

	it("a separator variant lands on the same in-flight key when the filesystem says it is one directory", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));
		const variant = separatorVariant(cwd);
		if (variant === undefined) {
			// No second spelling exists on this filesystem, so there is nothing to
			// fold. Assert the premise rather than passing vacuously — and the
			// dot-segment case above still covers this OS.
			expect(path.sep).toBe("/");
			return;
		}
		expect(variant).not.toBe(cwd);

		// PRE-FIX: the raw callers' spelling and project_report's normalized one
		// produced two keys, so one workspace held two live `_buildCache` entries
		// — two concurrent full builds, the #256 OOM shape — and the in-flight
		// probe answered about a key no other caller used.
		const build = buildOrUpdateGraph(variant, [], new FactStore());
		expect(isGraphBuildInFlight(cwd)).toBe(true);
		expect(buildOrUpdateGraph(cwd, [], new FactStore())).toBe(build);
		await build;
		expect(isGraphBuildInFlight(variant)).toBe(false);
	});
});

describe("project_report retry claim (#1962)", () => {
	/** Wait until the fire-and-forget background build has reached a verdict. */
	async function settleBackgroundBuild(cwd: string): Promise<void> {
		await vi.waitFor(
			() => {
				expect(getLastReviewGraphBuildAttempt(cwd)?.outcome).toBe("skipped");
				expect(isGraphBuildInFlight(cwd)).toBe(false);
			},
			{ timeout: 10_000, interval: 10 },
		);
	}

	it("reproduces the four-call transcript: every call after the first retries for real", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));
		setEnv("PI_LENS_REVIEW_GRAPH_MAX_FILES", "1");
		// The investigation's reproduction knob: expire the size-skip verdict
		// immediately, so `projectReport` takes the generic cold branch that makes
		// the retry claim instead of the "graph disabled" branch.
		setEnv("PI_LENS_REVIEW_GRAPH_SIZE_SKIP_TTL_MS", "1");
		_resetReviewGraphSizeSkipTtlForTests();

		const buildIds: Array<number | undefined> = [];
		const hints: Array<string | undefined> = [];
		for (let call = 0; call < 4; call += 1) {
			const report = await projectReport(cwd);
			hints.push(report.hint);
			await settleBackgroundBuild(cwd);
			buildIds.push(lastBuildId(cwd));
			_resetReviewGraphSizeSkipVerdictsForTests();
		}

		// PRE-FIX: one build ever ran, so every entry here is the same id.
		expect(new Set(buildIds).size).toBe(4);
		// Calls 2-4 saw the previous skip and claimed a retry — now truthfully.
		for (const hint of hints.slice(1)) {
			expect(hint).toContain("too_many_files");
			expect(hint).toContain("A retry was started.");
		}
	});

	it("reports the CURRENT attempt, not the frozen prior one", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));
		setEnv("PI_LENS_REVIEW_GRAPH_MAX_FILES", "1");
		setEnv("PI_LENS_REVIEW_GRAPH_SIZE_SKIP_TTL_MS", "1");
		_resetReviewGraphSizeSkipTtlForTests();

		await projectReport(cwd);
		await settleBackgroundBuild(cwd);
		const firstAttempt = getLastReviewGraphBuildAttempt(cwd);
		_resetReviewGraphSizeSkipVerdictsForTests();

		// #2441: pin the clock so the retry's `recordBuildAttempt` lands in the
		// SAME millisecond as `firstAttempt` — reproducing "two build attempts
		// recorded the same ISO timestamp" (CI, ms-resolution flake) on every
		// run instead of only when two real attempts happen to race into one
		// ms. `when` is wall-clock and MUST be allowed to collide; `buildId` is
		// the latch's actual identity (a process-wide monotonic counter,
		// `builder.ts`'s `_buildIdCounter`) and is the field that must move.
		vi.spyOn(Date.prototype, "toISOString").mockReturnValue(
			firstAttempt?.when as string,
		);
		const report = await projectReport(cwd);
		// The hint still names the previous failure, but the reported attempt is
		// the retry this call started — not the earlier record replayed as if it
		// were current.
		expect(report.hint).toContain("A retry was started.");
		expect(report.lastBuildAttempt?.outcome).toBe("running");
		expect(report.lastBuildAttempt?.when).toBe(firstAttempt?.when);
		expect(report.lastBuildAttempt?.buildId).not.toBe(firstAttempt?.buildId);
		vi.restoreAllMocks();
		await settleBackgroundBuild(cwd);
	});

	it("says a build is already running when an EXTERNAL build absorbed the call (#1962 review F1)", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));
		setEnv("PI_LENS_REVIEW_GRAPH_MAX_FILES", "1");
		setEnv("PI_LENS_REVIEW_GRAPH_SIZE_SKIP_TTL_MS", "1");
		_resetReviewGraphSizeSkipTtlForTests();

		// Establish a terminal prior attempt, so the hint takes the branch that
		// names the previous failure.
		await projectReport(cwd);
		await settleBackgroundBuild(cwd);
		_resetReviewGraphSizeSkipVerdictsForTests();
		expect(getLastReviewGraphBuildAttempt(cwd)?.outcome).toBe("skipped");

		// A build started OUTSIDE project_report — the edit pipeline, lens-map, or
		// the MCP CLI — and is still pending. project_report's own
		// `inFlightGraphBuilds` guard knows nothing about it, so only the
		// builder's in-flight probe can tell the truth here.
		const gate = deferSourceWalk();
		const external = buildOrUpdateGraph(cwd, [], new FactStore());
		await gate.waitForCalls(1);
		_resetProjectReportBuildGuardForTests();
		expect(isGraphBuildInFlight(cwd)).toBe(true);

		const report = await projectReport(cwd);
		// MUTATION PROOF for `deduped ? "already_running" : "started"`: force it
		// to "started" and this call claims it kicked off a build that it did not.
		expect(report.hint).toContain("A build is already running");
		expect(report.hint).not.toContain("A retry was started.");
		expect(report.hint).not.toContain("kicked off");

		gate.release(0);
		await external;
	});
});

describe("dedupe-key identity guard (#1962)", () => {
	it("an older build's release does not evict a newer build's entry", async () => {
		const cwd = tmpProject();
		setEnv("PILENS_DATA_DIR", path.join(cwd, "data"));

		// Hold BOTH builds open at their source-walk seam, so the older one can
		// settle while the newer one is still pending. `clearGraphCache()` is the
		// dispatch pipeline's per-invocation reset — the real way a pending entry
		// is removed out from under its own build.
		const gate = deferSourceWalk();
		const first = buildOrUpdateGraph(cwd, [], new FactStore());
		await gate.waitForCalls(1);
		clearGraphCache();

		const second = buildOrUpdateGraph(cwd, [], new FactStore());
		await gate.waitForCalls(2);
		expect(isGraphBuildInFlight(cwd)).toBe(true);

		gate.release(0);
		await first;
		// MUTATION PROOF for the `_buildCache.get(cacheKey) === promise` guard:
		// without it, the older build's release deletes the NEWER build's entry
		// and the next caller starts a duplicate build alongside it.
		expect(isGraphBuildInFlight(cwd)).toBe(true);

		gate.release(1);
		await second;
		expect(isGraphBuildInFlight(cwd)).toBe(false);
	});
});

/**
 * Suspend every source walk at its async seam
 * (`collectProjectSourceFilesWithBudgetAsync`), so a test can hold a build in
 * a genuinely PENDING state and release builds one at a time.
 */
function deferSourceWalk(): {
	waitForCalls: (count: number) => Promise<void>;
	release: (index: number) => void;
} {
	const releases: Array<() => void> = [];
	const original = scanPolicy.collectProjectSourceFilesWithBudgetAsync;
	vi.spyOn(
		scanPolicy,
		"collectProjectSourceFilesWithBudgetAsync",
	).mockImplementation(async (...args: Parameters<typeof original>) => {
		await new Promise<void>((resolve) => {
			releases.push(resolve);
		});
		return original(...args);
	});
	return {
		waitForCalls: (count) =>
			vi.waitFor(() => {
				expect(releases.length).toBeGreaterThanOrEqual(count);
			}),
		release: (index) => releases[index]?.(),
	};
}
