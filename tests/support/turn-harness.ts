/**
 * Deterministic turn-simulation harness — #1635 item 1.
 *
 * The bug family this exists for is multi-turn state evolution: a scan runs at
 * turn 1, the agent edits at turn 2, and turn 3 replays a verdict that is no
 * longer true. Every 2026-08-18 staleness incident (#1622 gitleaks, #1630 knip,
 * #1631 dependency drift, the advisory-provenance file-set blind spot) has that
 * shape, and none of them is expressible as a single-shot unit test: the defect
 * only exists in the RELATIONSHIP between turn N's cache and turn N+1's render.
 *
 * So the harness scripts turns, not calls. A scenario writes files, records
 * scans, ends a turn, edits again, ends another turn — and asserts on what the
 * AGENT SEES at each turn end: the composed turn-end message, split into its
 * real tiers (blocker / action-needed / advisory).
 *
 * ## What is deterministic here, and what is not
 *
 * - **Clock.** {@link ScenarioClock} is a LOGICAL clock, not a global `Date`
 *   replacement. Every timestamp the staleness logic actually compares — a
 *   file's mtime and a scan's `scannedAt` — is stamped from it, so a scenario
 *   controls the whole "was this file touched after the scan" relation exactly.
 *   `Date.now()` inside `handleTurnEnd` is deliberately left alone: it feeds
 *   duration telemetry only, and monkey-patching it would fight vitest's own
 *   timer handling for no assertion gain. Nothing in this harness asserts on a
 *   duration.
 * - **Filesystem.** A real temp dir, not an in-memory fake. The code under
 *   test calls `fs.statSync`/`fs.readFileSync` on cited paths directly (see
 *   `advisory-provenance.ts`), so a fake FS would have to intercept node:fs
 *   globally — more fragile, and it would stop exercising the real mtime
 *   comparison that every one of these bugs turns on. Determinism comes from
 *   `utimesSync` with clock-derived times, not from replacing the FS.
 * - **Scanners.** Never spawned. A scenario states a scanner's RESULT
 *   (`h.scan(...)`, `h.knip(...)`); the harness feeds it through the same
 *   cache/dep seams `handleTurnEnd` reads in production.
 *
 * ## Writing a scenario
 *
 * A scenario is metadata plus a short async body — roughly ten lines:
 *
 * ```ts
 * defineTurnScenario({
 *   id: "gitleaks-stale-replay",
 *   incident: "2026-08-18 — gitleaks kept citing a line the agent had edited",
 *   issue: "#1622",
 *   async run(h) {
 *     const file = h.write("src/config.ts", "const k = 'AKIA…';");
 *     h.scan("gitleaks", { findings: [{ ruleId: "aws-access-token", file, startLine: 397 }] });
 *     h.advance(5_000);
 *     h.edit("src/config.ts", "const k = process.env.KEY;");
 *     const view = await h.turnEnd();
 *     expect(view.blockers).toEqual([]);
 *     expect(view.text).toContain("src/config.ts");
 *   },
 * });
 * ```
 *
 * `pendingOn` marks a scenario whose fix is not on master yet. It is SKIPPED,
 * never softened into an assertion of the buggy behavior — see
 * {@link TurnScenario.pendingOn}.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import {
	AUTOMATION_FRAMING,
	consumeTurnEndFindings,
} from "../../clients/runtime-context.js";
import {
	snapshotAdvisoryProvenance,
	validateAdvisoryProvenance,
	type AdvisoryFileRole,
} from "../../clients/advisory-provenance.js";
import type { KnipResult } from "../../clients/knip-client.js";
import { setupTestEnvironment } from "../clients/test-utils.js";

/**
 * The scenario's logical clock. Advancing it does not move wall time; it moves
 * the timestamp the harness stamps onto the next file write or scan record.
 * Scenarios therefore read as a story ("scan, then five seconds later the agent
 * edits") while producing the same RELATIVE ordering on every run.
 *
 * It starts at `Date.now()`, not at a fixed epoch. Review round R1 (S2) caught
 * why that matters: the production code the harness drives stamps some of its
 * own records with the real `Date.now()` — `recordInlineBlockers`' capture
 * time, which #1633's gate compares file mtimes against. With the clock pinned
 * to a fixed 2026-08-18 epoch, every scenario file was written a day or more
 * BEFORE those records, so the era gap between the two clocks decided the
 * comparison instead of the scenario's own `advance()` calls. Anchoring at
 * construction puts both on one timeline; determinism then comes from the
 * relative offsets a scenario asks for, which is the only thing any of these
 * assertions depend on.
 */
interface ScenarioClock {
	now(): number;
	advance(ms: number): void;
}

/** The label the turn-end composer puts on every advisory section. */
const ADVISORY_LABEL = "ℹ️ Advisory — no action required this turn:";
/** The preamble the stale-secret tier ships with (#1622 review M2). */
const ACTION_NEEDED_PREFIX = "🔑 ACTION NEEDED";

/**
 * What the agent sees at one turn end, split into the three real tiers.
 *
 * The split is derived from the composed message the way the composer builds
 * it (`findingParts.join("\n\n")` in `runtime-turn.ts`), not from a
 * hand-maintained copy of the section list: sections are `\n\n`-separated, and
 * each tier carries its own recognizable preamble. That matters for the tier
 * assertions this harness exists to make — "the finding survived but left the
 * blocker tier" is the exact claim #1622's fix makes, and it is unassertable
 * from a flat string.
 */
interface TurnEndView {
	/** The full composed message, exactly as it reaches the agent. */
	text: string;
	/**
	 * The framing header `consumeTurnEndFindings` prepends (`AUTOMATION_FRAMING`
	 * plus either the imperative "Address 🔴 blockers" line or the historical
	 * preamble a superseded provenance record earns). Held separately so it
	 * cannot be mistaken for a blocker section — it is a wrapper, not a finding.
	 */
	framing: string;
	/** STOP-tier sections: the agent is told to fix these before finishing. */
	blockers: string[];
	/** The between-tier sections (`🔑 ACTION NEEDED`, #1622's demotion target). */
	actionNeeded: string[];
	/** Sections explicitly labelled "no action required this turn". */
	advisories: string[];
	/** True when this turn produced no agent-facing message at all. */
	silent: boolean;
	/** Every section, in composed order — for whole-message assertions. */
	sections: string[];
}

function splitTurnEndView(text: string): TurnEndView {
	const all = text
		? text
				.split("\n\n")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
	// `consumeTurnEndFindings` prepends its framing header as its own
	// `\n\n`-separated block. Peel it off before tiering, or every turn appears
	// to carry one extra blocker section that no composer ever pushed.
	const framing = all[0]?.startsWith(AUTOMATION_FRAMING) ? all[0] : "";
	const sections = framing ? all.slice(1) : all;
	return {
		text,
		framing,
		sections,
		blockers: sections.filter(
			(s) =>
				!s.startsWith(ADVISORY_LABEL) && !s.startsWith(ACTION_NEEDED_PREFIX),
		),
		actionNeeded: sections.filter((s) => s.startsWith(ACTION_NEEDED_PREFIX)),
		advisories: sections.filter((s) => s.startsWith(ADVISORY_LABEL)),
		silent: sections.length === 0,
	};
}

/** A knip run's result, minus the fields no scenario has ever needed to state. */
type ScenarioKnipResult = Partial<KnipResult> & Pick<KnipResult, "issues">;

const EMPTY_KNIP: KnipResult = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
} as KnipResult;

interface TurnHarness {
	/** The scenario's project root (a real temp dir). */
	cwd: string;
	clock: ScenarioClock;
	/** Advance the logical clock. Shorthand for `clock.advance`. */
	advance(ms: number): void;

	/**
	 * Create or overwrite a file WITHOUT telling pi-lens about it — the
	 * out-of-band change shape (#1631 case B: a bash script edits a file that
	 * the dispatch pipeline never sees). Returns the absolute path.
	 */
	write(relative: string, content: string): string;

	/**
	 * The agent edits a file through the tool pipeline: writes it AND registers
	 * it as a modified range for this turn, which is how `handleTurnEnd` learns
	 * which files the turn touched. Returns the absolute path.
	 */
	edit(relative: string, content: string): string;

	/** Delete a file (the #1460 existence-gate shape). */
	remove(relative: string): void;

	/** Absolute path for a scenario-relative path, without touching the disk. */
	pathOf(relative: string): string;

	/**
	 * Record a scanner's cached result, stamped `scannedAt` at the current
	 * logical clock. This is the seam every replay bug lives behind: the cache
	 * is written once and re-read at every later turn end.
	 */
	scan(store: string, result: Record<string, unknown>): void;

	/** What knip returns from its next `analyze` call this turn. */
	knip(result: ScenarioKnipResult): void;

	/**
	 * Record an inline blocker for a file exactly as a dispatch does (#1631).
	 *
	 * Production's ONE call site (`runtime-tool-result.ts`) always passes both
	 * the write token and the blocker's tool provenance, and #1561's retirement
	 * seam fails CLOSED on a record with no `sources` — an unprovenanced entry
	 * can never be retired or, under #1633's gate, revalidated. A helper that
	 * omitted `sources` therefore produced blockers every gate silently skips,
	 * so a scenario would pass without the logic under test ever running
	 * (review round R1, S3).
	 *
	 * The VALUES matter as much as their presence. `sources` holds the tool tag
	 * each blocking diagnostic carried (`pipeline.ts` derives it from
	 * `d.tool`), and gates branch on it: #1633's freshness sweep demotes only
	 * an entry whose sources are ALL `"lsp"`, because an ast-grep secret match
	 * does not stop being true when a file it imports is edited. Hence the
	 * default `["lsp"]` — a language-server blocker, the shape every one of
	 * #1631's live instances had.
	 */
	blocker(relative: string, summary: string, sources?: readonly string[]): void;

	/** Run one turn end and return what the agent sees. */
	turnEnd(): Promise<TurnEndView>;

	/**
	 * Snapshot advisory provenance over a file set, then ask whether it still
	 * holds. Scenario 4's seam: a whole-graph claim (an "unused export") is
	 * validated only against the files the snapshot captured, so a change
	 * OUTSIDE that set leaves the verdict reading "current".
	 */
	provenanceStatus(
		files: Array<{ relative: string; role?: AdvisoryFileRole }>,
		mutate: () => void,
	): { status: string; reasons: string[] };

	/** The underlying pieces, for a scenario that needs an escape hatch. */
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	/**
	 * The knip client this harness hands `handleTurnEnd` — the real one when
	 * {@link TurnHarnessOptions.knipClient} supplied it. A scenario uses this to
	 * prime the client's own cache out of band, before any turn runs.
	 */
	knipClient: unknown;
}

interface TurnHarnessOptions {
	/** Temp-dir prefix, so a failing scenario's leftovers are identifiable. */
	prefix?: string;
	/**
	 * Logical start time. Defaults to `Date.now()` at harness construction —
	 * see {@link ScenarioClock} for why a fixed epoch was wrong.
	 */
	startMs?: number;
	/** Session id used for telemetry identity and provenance revision checks. */
	sessionId?: string;
	/**
	 * Knip client for the turn's `analyze` call. Defaults to a stub that
	 * returns whatever `h.knip(...)` last stated.
	 *
	 * Pass the REAL `KnipClient` when the behavior under test lives inside it —
	 * #1637's fix is glob-cache pruning inside `KnipClient.analyze`, so a
	 * scenario that stubs the whole client cannot fail the way that bug fails
	 * (review round R1, S4).
	 */
	knipClient?: unknown;
}

/**
 * Build a harness. Callers must call the returned `cleanup` in a `finally`;
 * {@link runTurnScenario} does that for them.
 */
function createTurnHarness(options: TurnHarnessOptions = {}): {
	harness: TurnHarness;
	cleanup: () => void;
} {
	const env = setupTestEnvironment(options.prefix ?? "pi-lens-turn-scenario-");
	const sessionId = options.sessionId ?? "turn-harness-session";
	let currentMs = options.startMs ?? Date.now();

	const runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId });
	const cacheManager = new CacheManager(false);
	let knipResult: KnipResult = EMPTY_KNIP;
	const knipClient = options.knipClient ?? {
		ensureAvailable: async () => knipResult !== EMPTY_KNIP,
		analyze: async () => knipResult,
	};

	const clock: ScenarioClock = {
		now: () => currentMs,
		advance: (ms) => {
			currentMs += ms;
		},
	};

	const pathOf = (relative: string) => path.join(env.tmpDir, relative);

	/** Write at the logical clock's time, so mtime is scenario-controlled. */
	function writeAt(relative: string, content: string): string {
		const absolute = pathOf(relative);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, content);
		const when = new Date(currentMs);
		fs.utimesSync(absolute, when, when);
		return absolute;
	}

	const harness: TurnHarness = {
		cwd: env.tmpDir,
		clock,
		runtime,
		cacheManager,
		knipClient,
		advance: (ms) => clock.advance(ms),
		pathOf,
		write: writeAt,
		edit(relative, content) {
			const absolute = writeAt(relative, content);
			cacheManager.addModifiedRange(
				absolute,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				sessionId,
			);
			return absolute;
		},
		remove(relative) {
			fs.rmSync(pathOf(relative), { force: true });
		},
		scan(store, result) {
			cacheManager.writeCache(
				store,
				{
					success: true,
					scannedAt: new Date(currentMs).toISOString(),
					...result,
				},
				env.tmpDir,
			);
		},
		knip(result) {
			knipResult = { ...EMPTY_KNIP, ...result } as KnipResult;
		},
		blocker(relative, summary, sources = ["lsp"]) {
			runtime.recordInlineBlockers(
				pathOf(relative),
				summary,
				runtime.nextWriteIndex(),
				sources,
			);
		},
		async turnEnd() {
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient,
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
				// biome-ignore lint/suspicious/noExplicitAny: the dep surface is a
				// dozen client interfaces; scenarios state only what they exercise.
			} as any);
			// `runtime` is passed exactly as `index.ts` and the MCP Stop hook pass
			// it, so provenance validation (and the historical framing a
			// superseded record earns) runs the same way it does in production.
			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir, runtime)?.messages?.[0]
					?.content ?? "";
			return splitTurnEndView(content);
		},
		provenanceStatus(files, mutate) {
			const provenance = snapshotAdvisoryProvenance({
				cwd: env.tmpDir,
				runtime,
				generation: 1,
				files: files.map((f) => ({
					path: pathOf(f.relative),
					role: f.role ?? "source",
				})),
				capturedAt: currentMs,
			});
			mutate();
			const validation = validateAdvisoryProvenance(
				{ provenance },
				env.tmpDir,
				runtime,
			);
			return { status: validation.status, reasons: validation.reasons };
		},
	};

	return { harness, cleanup: env.cleanup };
}

/**
 * A replayable dogfood incident.
 *
 * The metadata is the point as much as the body: an incident that reaches this
 * file stops being a story in a chat log and becomes a named, re-runnable
 * assertion with a provenance trail back to the issue that reported it.
 */
export interface TurnScenario {
	/** Stable slug, used in the test name and in failure output. */
	id: string;
	/** One line: what the agent actually saw, on the day it happened. */
	incident: string;
	/** The issue that reported it. */
	issue: string;
	/**
	 * Set when the fix is NOT on master yet. The scenario is skipped rather
	 * than weakened: an unfixed defect must never be encoded as an expectation,
	 * or the suite starts defending the bug. The value names the blocking issue
	 * or PR so the skip is a pointer, not a shrug. Removing this line is the
	 * whole of the work needed to turn the scenario on once the fix lands.
	 */
	pendingOn?: string;
	/** Temp-dir prefix override. */
	prefix?: string;
	/**
	 * Harness options this scenario needs — most usefully `knipClient`, for a
	 * scenario whose defect lives inside a real client rather than in the turn
	 * pipeline. Built per run so a scenario can construct a fresh client.
	 */
	harnessOptions?: () => TurnHarnessOptions;
	/**
	 * Skip this scenario when its preconditions are absent, e.g. a real tool
	 * binary the scenario shells out to. Returning a string skips and says why;
	 * `undefined` runs. Distinct from {@link pendingOn}, which is about a fix
	 * not existing yet rather than an environment not having a tool.
	 */
	skipWhen?: () => string | undefined;
	run(harness: TurnHarness): Promise<void>;
}

/** Identity helper: gives a scenario literal its type without a cast. */
export function defineTurnScenario(scenario: TurnScenario): TurnScenario {
	return scenario;
}

/** Run a scenario against a fresh harness, cleaning up whatever it fails at. */
export async function runTurnScenario(scenario: TurnScenario): Promise<void> {
	const { harness, cleanup } = createTurnHarness({
		prefix: scenario.prefix ?? `pi-lens-scenario-${scenario.id}-`,
		...scenario.harnessOptions?.(),
	});
	try {
		await scenario.run(harness);
	} finally {
		cleanup();
	}
}
