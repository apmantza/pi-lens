/**
 * #3576 (G5, maintainer addition): the session generation guard over the
 * interleavings fast-check's scheduler picks, instead of one replay per
 * interleaving.
 *
 * Recurrence this file prevents: the session-straddle defects of one day
 * (#3499, #3512, #3528, #3568, #3576), each a writer that captured its
 * session, awaited, and landed after the next session's `session_start`.
 * Each was caught by a replay of the interleaving it was written for; the
 * property below states the guard's contract for every interleaving of
 * session starts, session shutdowns and writer completions.
 *
 * Production chain: a REAL `RuntimeCoordinator` and the real writers whose
 * guard takes the captured handle as an argument:
 * - `appendCascadePromise` (#3512: the deferred cascade's admission, then its
 *   compute settles under the scheduler and the turn end's settle appends it);
 * - `deferRunnerFindings` (#3568: a collect-later runner's deferral into the
 *   turn-end store, whose compute also settles under the scheduler);
 * - `recordLspMutation` with a session on its context (#3576: the quickfix
 *   pass's bookkeeping into the read guard and turn state; its change-log
 *   receipt and file seq are facts about the bytes and stay, #3763 r2, so
 *   the oracle reads the turn-state writes and the session each landed in).
 * - the widget's write guard (#3540 r2: `recordDiagnostics` under the order
 *   token `runtime.nextWriteOrderToken()` draws when the writer is issued).
 *   The widget is not session-guarded: a `/reload` keeps it and its guard,
 *   `/new` clears both, and a stale write that lands after the clear stays
 *   (#3596). What the property pins is that a token drawn later always
 *   outranks one drawn earlier, across session resets.
 * A writer captures `runtime.captureSessionGeneration()` when it is issued,
 * awaits its work (a scheduled promise: the pipeline, the formatter, the code
 * action), then writes. `session_start` is the production pair that runs in
 * one tick (`resetPendingRunnerFindings`, then `runtime.resetForSession`,
 * `runtime-session.ts`), and `session_shutdown` is `resetLSPService`, which
 * retires the LSP service and leaves the runtime session alone.
 *
 * The oracle is the test's own: which session each writer was issued in comes
 * from the command log, never from the coordinator's generation.
 *
 * How to write one of these: `tests/support/scheduler-properties.md`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	it,
	vi,
} from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import type { CascadeRun } from "../../clients/cascade-types.js";
import {
	deferRunnerFindings,
	drainPendingRunnerFindings,
	peekSettledRunnerFindings,
	requeueRunnerFindings,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import type { RunnerResult } from "../../clients/dispatch/types.js";
import { recordLspMutation } from "../../clients/lsp-mutation.js";
import { resetLSPService } from "../../clients/lsp/index.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	clearWidgetState,
	getFileDiagnostics,
	recordDiagnostics,
} from "../../clients/widget-state.js";

/**
 * Budget: a run is microtasks plus one synchronous change-log append per
 * bookkeeping writer and one widget write per widget writer; NUM_RUNS take
 * about 1.2 s here (measured, #3540 r2). The seed is
 * fixed so the lane is deterministic; raise NUM_RUNS or drop SEED locally to
 * explore. Seeds 1-100 at this NUM_RUNS were green before landing.
 */
const NUM_RUNS = 1000;
const SEED = 3576;
const PROPERTY_TIMEOUT_MS = 20_000;

// --- Generated commands --------------------------------------------------

type WriterKind = "cascade" | "runner" | "runnerBare" | "bookkeep" | "widget";
type Command =
	| { t: "write"; kind: WriterKind }
	| { t: "turn" }
	/** The #3813 delivery hold: drain, then requeue the cut settled answer. */
	| { t: "collect" }
	/** `keepWidget`: a `/reload` (the widget and its guard survive) or `/new`. */
	| { t: "start"; keepWidget: boolean }
	| { t: "shutdown" }
	/**
	 * #3813/#3824: a turn end whose delivery cap cut the late-runner part, so
	 * the drain-then-restore hold hands every settled answer it drained back to
	 * the store for the next turn. It models the worst case (every part cut).
	 */
	| { t: "cap" }
	/**
	 * A raw generation bump with no store clear: the window between a scope's
	 * retirement and the next `session_start`'s `resetPendingRunnerFindings`
	 * (#3758). `start` clears and bumps in one tick; this models the gap a
	 * concurrent secondary's turn end drains in.
	 */
	| { t: "retire" };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			t: fc.constant("write" as const),
			kind: fc.constantFrom<WriterKind>(
				"cascade",
				"runner",
				"runnerBare",
				"bookkeep",
				"widget",
			),
		}),
	},
	{ weight: 2, arbitrary: fc.constant({ t: "turn" as const }) },
	{ weight: 2, arbitrary: fc.constant({ t: "collect" as const }) },
	{
		weight: 2,
		arbitrary: fc.record({
			t: fc.constant("start" as const),
			keepWidget: fc.boolean(),
		}),
	},
	{ weight: 1, arbitrary: fc.constant({ t: "shutdown" as const }) },
	{ weight: 2, arbitrary: fc.constant({ t: "cap" as const }) },
	{ weight: 1, arbitrary: fc.constant({ t: "retire" as const }) },
);

const commandsArb = fc.array(commandArb, { minLength: 1, maxLength: 10 });

// --- Recorded run --------------------------------------------------------

interface Writer {
	id: number;
	kind: WriterKind;
	/** The file the writer writes; its name identifies the writer. */
	file: string;
	/** The test's own session count when the writer was issued. */
	session: number;
	settled: boolean;
	/** Widget writers: the order token drawn at issue. */
	token?: number;
	/** Widget writers: the run's step at which the write ran. */
	wroteAt?: number;
}

interface Run {
	writers: Writer[];
	/** The session count at quiescence. */
	finalSession: number;
	/** Writer files each store holds at quiescence. */
	cascade: string[];
	runner: string[];
	/** The commit gate's non-draining view, read before the final drain. */
	peek: string[];
	bookkeep: string[];
	/** The widget file's message at quiescence (the writer's name). */
	widget: string | undefined;
	/** Widget writers' ids that wrote after the last `/new` cleared it. */
	widgetSinceClear: number[];
	log: string[];
	unsettled: string[];
}

let root: string;

async function execute(
	s: fc.Scheduler,
	commands: readonly Command[],
): Promise<Run> {
	const run: Run = {
		writers: [],
		finalSession: 1,
		cascade: [],
		runner: [],
		peek: [],
		bookkeep: [],
		widget: undefined,
		widgetSinceClear: [],
		log: [],
		unsettled: [],
	};
	const note = (line: string) => run.log.push(line);
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = root;
	const cacheManager = new CacheManager(false);
	// Observed, not replaced: each turn-state write and the session it landed in.
	const turnStateWrites: Array<{ file: string; session: number }> = [];
	const addModifiedRange = cacheManager.addModifiedRange.bind(cacheManager);
	vi.spyOn(cacheManager, "addModifiedRange").mockImplementation(
		(filePath, ...rest) => {
			turnStateWrites.push({ file: normalizeMapKey(filePath), session });
			return addModifiedRange(filePath, ...rest);
		},
	);
	resetPendingRunnerFindings();
	clearWidgetState();
	let session = 1;
	let step = 0;
	let clearedAt = 0;
	// The host runs a tool only inside a turn: turn_start (`beginTurn`) comes
	// before any writer a session issues.
	let turnOpen = false;
	const widgetFile = path.join(root, "widget.ts");

	const write = (
		writer: Writer,
		handle:
			| ReturnType<RuntimeCoordinator["captureSessionGeneration"]>
			| undefined,
	) => {
		// Only a runnerBare writer (a released producer, shape 57) may arrive
		// without a handle; every other kind captured one at issue.
		const handleFor = () => {
			if (handle === undefined)
				throw new Error(`${writer.kind} w${writer.id} has no captured handle`);
			return handle;
		};
		if (writer.kind === "cascade") {
			const computed: CascadeRun = {
				filePath: writer.file,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
			};
			runtime.appendCascadePromise(
				s.schedule(Promise.resolve(computed), `compute:${writer.id}`),
				handleFor(),
				writer.file,
			);
		} else if (writer.kind === "widget") {
			recordDiagnostics(
				widgetFile,
				[{ severity: "error", tool: "tsserver", message: `w${writer.id}` }],
				writer.token,
			);
			writer.wroteAt = ++step;
		} else if (writer.kind === "runner" || writer.kind === "runnerBare") {
			const result: RunnerResult = {
				status: "succeeded",
				diagnostics: [],
				semantic: "warning",
			};
			// runnerBare is shape 57: a released writer with no captured handle.
			// The deferral must be admitted fail-open, and both readers must not
			// fence it out. Omitting `session` (rather than passing `undefined`)
			// keeps the call assignable under exactOptionalPropertyTypes.
			deferRunnerFindings({
				filePath: writer.file,
				cwd: root,
				projectRoot: root,
				runnerId: `runner-${writer.id}`,
				markedAtMs: 0,
				promise: s.schedule(Promise.resolve(result), `runner:${writer.id}`),
				...(handle !== undefined && { session: handle }),
			});
		} else {
			recordLspMutation(
				{
					cwd: root,
					correlationId: `3576-property-${writer.id}`,
					tool: "lsp-quickfix",
					source: "autofix",
					runtime,
					cacheManager,
					readGuard: runtime.readGuard,
					session: handleFor(),
					emitSummary: false,
				},
				{
					bookkeep: true,
					results: [
						{
							descriptions: [],
							files: [writer.file],
							operationTotal: 1,
							appliedOperationTotal: 1,
							appliedOperationIndexes: [0],
							operationCounts: {
								textEdits: 1,
								create: 0,
								rename: 0,
								delete: 0,
							},
							fileDetails: [
								{
									filePath: writer.file,
									range: { start: 1, end: 1 },
									importsChanged: false,
								},
							],
						},
					],
				},
			);
		}
	};

	const issueWriter = (kind: WriterKind, id: number) => {
		if (!turnOpen) {
			runtime.beginTurn();
			turnOpen = true;
		}
		const writer: Writer = {
			id,
			kind,
			file: path.join(root, `w${id}.ts`),
			session,
			settled: false,
		};
		fs.writeFileSync(writer.file, `export const w${id} = ${id};\n`);
		run.writers.push(writer);
		// The production capture, taken when the writer starts. A runnerBare
		// writer (a released producer) never captured one (shape 57).
		const handle =
			kind === "runnerBare" ? undefined : runtime.captureSessionGeneration();
		// The widget order token, drawn when the writer starts (#3540 r2).
		if (kind === "widget") writer.token = runtime.nextWriteOrderToken();
		note(`issue ${kind} w${id} in session ${session}`);
		void s.schedule(Promise.resolve(), `work:${id}`).then(() => {
			write(writer, handle);
			writer.settled = true;
			note(`write ${kind} w${id} (session now ${session})`);
		});
	};

	const issued = s.scheduleSequence(
		commands.map((command, index) => ({
			label: `cmd${index}`,
			builder: async () => {
				if (command.t === "write") issueWriter(command.kind, index);
				else if (command.t === "cap") {
					// The drain removes every settled answer; the cap cut the part, so
					// `onHeld` hands each one back for the next turn end (#3813). The
					// requeue carries the producer's captured handle (#3824).
					const drained = await drainPendingRunnerFindings(0);
					for (const entry of drained) {
						if (entry.result)
							requeueRunnerFindings({ ...entry, result: entry.result });
					}
					note(`turn-end cap: drained ${drained.length}, requeued`);
				} else if (command.t === "collect") {
					// The #3813 delivery hold: a settled answer the turn-end cap cut
					// re-enters the store. The requeue is scheduled, so it may land on
					// either side of a session start: a raw store clear leaves the
					// snapshot to be re-added, and the next reader must fence the
					// retired producer it carried (the stale-peek direction, #3758).
					const collected = await drainPendingRunnerFindings(0);
					for (const entry of collected) {
						if (!entry.result) continue;
						void s
							.schedule(Promise.resolve(), `requeue:${entry.runnerId}`)
							.then(() => {
								requeueRunnerFindings({ ...entry, result: entry.result! });
								note(`requeue ${entry.runnerId}`);
							});
					}
					note("collect");
				} else if (command.t === "retire") {
					// A raw generation bump with NO store clear: the retirement window
					// #3758's drain fence defends, before the next session_start clears.
					runtime.resetForSession();
					turnOpen = false;
					session += 1;
					note(`session retire (no store clear) -> session ${session}`);
				} else if (command.t === "turn") {
					runtime.beginTurn();
					turnOpen = true;
					note("turn_start");
				} else if (command.t === "start") {
					resetPendingRunnerFindings();
					runtime.resetForSession();
					if (!command.keepWidget) {
						clearWidgetState();
						clearedAt = ++step;
					}
					turnOpen = false;
					session += 1;
					note(
						`session_start (${command.keepWidget ? "/reload" : "/new"}) -> session ${session}`,
					);
				} else {
					resetLSPService({ reason: "session_shutdown" });
					note("session_shutdown");
				}
			},
		})),
	);

	const unsettled = () =>
		run.writers.filter((w) => !w.settled).map((w) => `w${w.id}`);
	await s.waitFor(issued.task);
	for (
		let round = 0;
		round < 50 && (s.count() > 0 || unsettled().length > 0);
		round++
	)
		await s.waitIdle();
	run.unsettled = unsettled();
	run.finalSession = session;

	// The final session's turn end reads each store.
	await runtime.settleCascadeRuns(0);
	run.cascade = runtime.consumeCascadeRuns().map((r) => r.filePath);
	// The commit gate's non-draining read runs before the drain consumes it.
	run.peek = peekSettledRunnerFindings().map((e) => e.filePath);
	run.runner = (await drainPendingRunnerFindings(0)).map((e) => e.filePath);
	const bookkept = new Set(
		turnStateWrites
			.filter((write) => write.session === session)
			.map((write) => write.file),
	);
	run.bookkeep = run.writers
		.filter((w) => bookkept.has(normalizeMapKey(w.file)))
		.map((w) => w.file);
	run.widget = getFileDiagnostics(widgetFile)?.[0]?.message;
	run.widgetSinceClear = run.writers
		.filter((w) => w.wroteAt !== undefined && w.wroteAt > clearedAt)
		.map((w) => w.id);
	return run;
}

// --- The oracle ----------------------------------------------------------

function heldBy(run: Run, kind: Exclude<WriterKind, "widget">): string[] {
	return kind === "cascade"
		? run.cascade
		: kind === "runner" || kind === "runnerBare"
			? run.runner
			: run.bookkeep;
}

/** Every writer settles. */
function liveness(run: Run): string[] {
	return run.unsettled.map((what) => `${what} never wrote`);
}

/**
 * Safety: no writer issued in a superseded session is in the final session's
 * state, whichever order its write and the session starts came in.
 */
function noStaleWrite(run: Run): string[] {
	const out: string[] = [];
	for (const w of run.writers) {
		// runnerBare carries no handle, so it is unfenced by design (shape 57);
		// `noHandleDelivered` is its no-drop direction.
		if (
			w.kind === "widget" ||
			w.kind === "runnerBare" ||
			w.session === run.finalSession
		)
			continue;
		if (heldBy(run, w.kind).includes(w.file))
			out.push(
				`${w.kind} w${w.id} from session ${w.session} is in session ${run.finalSession}'s state`,
			);
	}
	return out;
}

/**
 * Shape 57 (released writer, no captured handle): a runner deferred without a
 * handle is unfenced by design, so every no-handle writer of the final session
 * must still reach its state, whether or not the cap drained and requeued it.
 * The drain's absence of a `guardedWrite` is the no-drop direction of the
 * `session === undefined` branch.
 */
function noHandleDelivered(run: Run): string[] {
	return run.writers
		.filter((w) => w.kind === "runnerBare" && w.session === run.finalSession)
		.filter((w) => !run.runner.includes(w.file))
		.map((w) => `runnerBare w${w.id} of the final session was dropped`);
}

/**
 * No-drop (shape 54): every writer issued in the final session is in its
 * state, whether or not a session_shutdown retired the LSP service meanwhile.
 */
function noOwnDrop(run: Run): string[] {
	const out: string[] = [];
	for (const w of run.writers) {
		if (w.kind === "widget" || w.session !== run.finalSession) continue;
		if (!heldBy(run, w.kind).includes(w.file))
			out.push(`${w.kind} w${w.id} of the final session was dropped`);
	}
	return out;
}

/**
 * Safety (shape 54): the fence never lets a superseded session's own runner
 * answer into the commit gate's peek. The drain side is `noStaleWrite`; this
 * pins the non-draining reader across the #3813 requeue round-trip. A
 * `runnerBare` writer carries no handle, so it is unfenced by design (shape 57)
 * and is not this fence's to reject.
 */
function peekNoStale(run: Run): string[] {
	const out: string[] = [];
	for (const w of run.writers) {
		if (w.kind !== "runner" || w.session === run.finalSession) continue;
		if (run.peek.includes(w.file))
			out.push(
				`runner w${w.id} from session ${w.session} is in session ${run.finalSession}'s peek`,
			);
	}
	return out;
}

/**
 * No-drop (shape 54): the fence never drops the final session's own answer, nor
 * a released writer's no-handle deferral (a `runnerBare`, shape 57), from the
 * gate's peek, across the #3813 requeue round-trip.
 */
function peekNoOwnDrop(run: Run): string[] {
	const out: string[] = [];
	for (const w of run.writers) {
		if (w.kind !== "runner" && w.kind !== "runnerBare") continue;
		if (w.session !== run.finalSession) continue;
		if (!run.peek.includes(w.file))
			out.push(
				`${w.kind} w${w.id} of the final session was dropped by the peek`,
			);
	}
	return out;
}

/**
 * #3540 r2: order tokens rise with issue order across session resets, so the
 * widget holds the latest-issued writer among those that wrote since the last
 * `/new`, whatever order the writes landed in. A turn half that restarts at
 * `resetForSession` leaves a `/reload`ed widget, or a stale write that landed
 * after `/new`, outranking the next session's writes.
 */
function widgetLatest(run: Run): string[] {
	const latest = Math.max(...run.widgetSinceClear);
	const expected = Number.isFinite(latest) ? `w${latest}` : undefined;
	return run.widget === expected
		? []
		: [
				`widget holds ${run.widget ?? "nothing"}, expected ${expected ?? "nothing"}`,
			];
}

const PROPERTIES = {
	liveness,
	noStaleWrite,
	peekNoStale,
	noOwnDrop,
	peekNoOwnDrop,
	noHandleDelivered,
	widgetLatest,
} satisfies Record<string, (run: Run) => string[]>;
type PropertyName = keyof typeof PROPERTIES;
const ALL = Object.keys(PROPERTIES) as PropertyName[];

function assertHolds(run: Run, names: readonly PropertyName[]): void {
	const found = names.flatMap((name) =>
		PROPERTIES[name](run).map((v) => `${name}: ${v}`),
	);
	if (found.length > 0)
		throw new Error(`${found.join("\n")}\n--- trace\n${run.log.join("\n")}`);
}

describe("#3576 — the session generation guard over scheduled interleavings", () => {
	let previousDataDir: string | undefined;
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3576-property-"));
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(root, "data");
	});
	afterAll(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		fs.rmSync(root, { recursive: true, force: true });
	});
	beforeEach(() => {
		// Nothing here waits on a timer; fake timers keep any a writer arms from
		// firing into a later run.
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		resetPendingRunnerFindings();
		clearWidgetState();
	});

	it(
		"no superseded writer reaches the new session, and no current writer is dropped, for any ordering",
		{ timeout: PROPERTY_TIMEOUT_MS },
		async () => {
			await fc.assert(
				fc.asyncProperty(fc.scheduler(), commandsArb, async (s, commands) => {
					assertHolds(await execute(s, commands), ALL);
				}),
				{ numRuns: NUM_RUNS, seed: SEED },
			);
		},
	);
});
