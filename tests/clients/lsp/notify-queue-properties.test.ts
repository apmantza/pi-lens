/**
 * #3530: properties of the per-path notify queue (`enqueueDocumentNotify`)
 * over the interleavings fast-check's scheduler picks, instead of one
 * hand-written replay per interleaving.
 *
 * Recurrence this file prevents: three regressions of this one queue in one
 * day, each caught only by a replay of the interleaving it was written for —
 * #3481 (an older read sent after a newer one), #3477 (a touch queued before
 * rename's close re-opened the path after didClose) and the #3491 verify-round
 * close-stamp drop (a close inherited a stale touch's read stamp and was
 * dropped with it, so no didClose went out). The property reds on each of
 * them re-applied as a mutation of the built client; the #3530 PR body quotes
 * the shrunk counterexamples.
 *
 * Production chain: the REAL `handleNotifyOpen` / `handleNotifyChange` /
 * `closeDocument` over `createMockState`. Two awaits are handed to the
 * scheduler: the JSON-RPC `sendNotification` (the process boundary) and the
 * `access` existence probe (the file system; `closedAndGone` and the
 * first-open watcher notify). Both answer from the test's model at call time
 * and resolve when the scheduler releases them, so the scheduler, not I/O
 * timing, decides every interleaving and a seed replays exactly.
 *
 * The oracle is the test's own: which touch holds the newest read, what the
 * server holds, and when a close settled come from the command log and the
 * recorded wire, never from the queue's state.
 *
 * How to write one of these: `tests/support/scheduler-properties.md`.
 */

import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const fsProbe = vi.hoisted(() => ({
	access: undefined as undefined | ((file: string) => Promise<void>),
}));

// ESM builtins cannot be spied at runtime, so `access` is replaced at load
// time. It stays the real implementation until a run installs the model.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const access = (...args: Parameters<typeof actual.access>) =>
		fsProbe.access ? fsProbe.access(String(args[0])) : actual.access(...args);
	const mocked = { ...actual, access };
	return { ...mocked, default: mocked };
});

import {
	closeDocument,
	handleNotifyChange,
	handleNotifyOpen,
} from "../../../clients/lsp/client.js";
import { createMockState } from "./mock-client-state.js";

const FILE = path.join(os.tmpdir(), "pi-lens-notify-properties", "doc.ts");

/**
 * Budget: one run is a few milliseconds of microtasks (no timers, no I/O), so
 * this many runs of all properties take about two seconds. The seed is fixed
 * so the lane is deterministic; raise NUM_RUNS or drop SEED locally to explore.
 */
const NUM_RUNS = 600;
const SEED = 3530;

// --- Generated commands --------------------------------------------------

type Command =
	| { t: "open"; stamp: number | undefined; saved: boolean; silent: boolean }
	| { t: "change" }
	| { t: "close" }
	| { t: "gone" }
	| { t: "back" }
	| { t: "die" };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			t: fc.constant("open" as const),
			// Read time; made unique per run by the command index.
			stamp: fc.option(fc.integer({ min: 0, max: 9 }), { nil: undefined }),
			saved: fc.boolean(),
			silent: fc.boolean(),
		}),
	},
	{ weight: 2, arbitrary: fc.constant({ t: "change" as const }) },
	{ weight: 2, arbitrary: fc.constant({ t: "close" as const }) },
	{ weight: 1, arbitrary: fc.constant({ t: "gone" as const }) },
	{ weight: 1, arbitrary: fc.constant({ t: "back" as const }) },
	{ weight: 1, arbitrary: fc.constant({ t: "die" as const }) },
);

const scenarioArb = fc.record({
	commands: fc.array(commandArb, { minLength: 1, maxLength: 8 }),
	saveOptions: fc.boolean(),
});

// --- Recorded run --------------------------------------------------------

interface Touch {
	id: number;
	kind: "open" | "change";
	/** Unique per touch, so a wire message names the touch it came from. */
	content: string;
	/** Unique across the run: generated value * 100 + command index. */
	stamp: number | undefined;
	saved: boolean;
	/** Event-log position when the touch was issued / settled. */
	issuedAt: number;
	settledAt?: number;
	result?: boolean | "rejected";
}

interface Close {
	id: number;
	issuedAt: number;
	settledAt?: number;
	/** What the server held (from the wire) when the close settled. */
	serverAtSettle?: ServerDoc;
	rejected?: boolean;
}

interface WireMessage {
	method: "didOpen" | "didChange" | "didClose" | "didSave";
	text?: string;
	/** Event-log position when `sendNotification` was called. */
	at: number;
	/** The transport was alive at the call, so the server received it. */
	delivered: boolean;
}

type ServerDoc = { open: false } | { open: true; content: string };

interface Run {
	saveOptions: boolean;
	touches: Touch[];
	closes: Close[];
	wire: WireMessage[];
	/** Event-log positions of the model's `gone` / `back` commands. */
	gone: number[];
	back: number[];
	diedAt: number | undefined;
	log: string[];
	unsettled: string[];
}

function serverDoc(wire: readonly WireMessage[]): ServerDoc {
	let doc: ServerDoc = { open: false };
	for (const m of wire) {
		if (!m.delivered) continue;
		if (m.method === "didClose") doc = { open: false };
		else if (m.method === "didOpen" || m.method === "didChange")
			doc = { open: true, content: m.text ?? "" };
	}
	return doc;
}

async function execute(
	s: fc.Scheduler,
	commands: readonly Command[],
	saveOptions: boolean,
): Promise<Run> {
	const run: Run = {
		saveOptions,
		touches: [],
		closes: [],
		wire: [],
		gone: [],
		back: [],
		diedAt: undefined,
		log: [],
		unsettled: [],
	};
	const note = (line: string) => run.log.push(line);
	let fileExists = true;
	let alive = true;
	const state = createMockState({ root: path.dirname(FILE) });
	if (saveOptions) state.saveOptions = { includeText: false };

	fsProbe.access = (file) => {
		const exists = fileExists;
		note(`access ${exists ? "found" : "ENOENT"}`);
		return s.schedule(Promise.resolve(), `access:${exists}`).then(() => {
			if (exists) return;
			throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
		});
	};
	vi.mocked(state.connection.sendNotification).mockImplementation(((
		method: unknown,
		params: unknown,
	) => {
		const name = String(method);
		if (!name.startsWith("textDocument/")) return Promise.resolve();
		const short = name.slice("textDocument/".length) as WireMessage["method"];
		const p = params as {
			textDocument?: { text?: string };
			contentChanges?: Array<{ text: string }>;
		};
		const text = p.textDocument?.text ?? p.contentChanges?.at(-1)?.text;
		const delivered = alive;
		run.wire.push({ method: short, text, at: run.log.length, delivered });
		note(`send ${short}${text ? `:${text}` : ""}${delivered ? "" : " (dead)"}`);
		return s.schedule(Promise.resolve(), short).then(() => {
			// A destroyed transport rejects the write; safeSendNotification
			// reads this message as a stream error.
			if (!delivered) throw new Error("write after end: stream destroyed");
		});
	}) as never);

	const issueTouch = (command: Command, index: number) => {
		if (command.t !== "open" && command.t !== "change") return;
		const touch: Touch = {
			id: index,
			kind: command.t,
			content: `c${index}`,
			stamp:
				command.t === "open" && command.stamp !== undefined
					? command.stamp * 100 + index
					: undefined,
			saved: command.t === "open" && command.saved,
			issuedAt: run.log.length,
		};
		run.touches.push(touch);
		note(
			`issue ${command.t} ${touch.content}` +
				(touch.stamp !== undefined ? ` read=${touch.stamp}` : "") +
				(touch.saved ? " saved" : "") +
				(command.t === "open" && command.silent ? " silent" : ""),
		);
		const pending =
			command.t === "open"
				? handleNotifyOpen(
						state,
						FILE,
						touch.content,
						"typescript",
						false,
						command.silent,
						touch.saved,
						touch.stamp,
					)
				: handleNotifyChange(state, FILE, touch.content);
		void pending.then(
			(sent) => {
				touch.result = sent;
				touch.settledAt = run.log.length;
				note(`settle ${touch.content} -> ${sent}`);
			},
			() => {
				touch.result = "rejected";
				touch.settledAt = run.log.length;
				note(`settle ${touch.content} -> rejected`);
			},
		);
	};

	const issueClose = (index: number) => {
		const close: Close = { id: index, issuedAt: run.log.length };
		run.closes.push(close);
		note(`issue close#${index}`);
		void closeDocument(state, FILE).then(
			() => {
				close.settledAt = run.log.length;
				close.serverAtSettle = serverDoc(run.wire);
				note(`settle close#${index}`);
			},
			() => {
				close.rejected = true;
				note(`settle close#${index} -> rejected`);
			},
		);
	};

	// Commands are issued in generated order; the scheduler decides how many
	// sends and probes it releases between two of them.
	const issued = s.scheduleSequence(
		commands.map((command, index) => ({
			label: `cmd${index}`,
			builder: async () => {
				if (command.t === "open" || command.t === "change")
					issueTouch(command, index);
				else if (command.t === "close") issueClose(index);
				else if (command.t === "gone") {
					fileExists = false;
					run.gone.push(run.log.length);
					note("file gone");
				} else if (command.t === "back") {
					fileExists = true;
					run.back.push(run.log.length);
					note("file back");
				} else {
					alive = false;
					state.isConnected = false;
					run.diedAt ??= run.log.length;
					note("client dies");
				}
			},
		})),
	);

	// Release scheduled awaits until every command is issued and the scheduler
	// idles with nothing left. A waiter that never settles is then reported,
	// not awaited: bounded rounds, no timer.
	const unsettled = () => [
		...run.touches.filter((t) => t.result === undefined).map((t) => t.content),
		...run.closes
			.filter((c) => c.settledAt === undefined && !c.rejected)
			.map((c) => `close#${c.id}`),
	];
	await s.waitFor(issued.task);
	for (
		let round = 0;
		round < 50 && (s.count() > 0 || unsettled().length > 0);
		round++
	)
		await s.waitIdle();
	run.unsettled = unsettled();
	return run;
}

// --- The oracle ----------------------------------------------------------

function touchOf(run: Run, text: string | undefined): Touch | undefined {
	return run.touches.find((t) => t.content === text);
}

/** The model's file existence at event-log position `at`. */
function existsAt(run: Run, at: number): boolean {
	const lastGone = Math.max(-1, ...run.gone.filter((g) => g <= at));
	const lastBack = Math.max(-1, ...run.back.filter((b) => b <= at));
	return lastGone === -1 || lastBack > lastGone;
}

function newestStamped(touches: readonly Touch[]): Touch | undefined {
	let newest: Touch | undefined;
	for (const t of touches)
		if (
			t.stamp !== undefined &&
			(newest === undefined || t.stamp > newest.stamp!)
		)
			newest = t;
	return newest;
}

/** Every waiter settles, and none rejects. */
function liveness(run: Run): string[] {
	const out = run.unsettled.map((what) => `${what} never settled`);
	for (const t of run.touches)
		if (t.result === "rejected") out.push(`${t.content} rejected`);
	for (const c of run.closes)
		if (c.rejected) out.push(`close#${c.id} rejected`);
	return out;
}

/**
 * #3481, safety: within one open lifetime on the server, no read reaches it
 * after a newer read did.
 */
function newestReadOrder(run: Run): string[] {
	const out: string[] = [];
	let newest: Touch | undefined;
	for (const m of run.wire) {
		if (!m.delivered) continue;
		if (m.method === "didClose") newest = undefined;
		if (m.method !== "didOpen" && m.method !== "didChange") continue;
		const t = touchOf(run, m.text);
		if (t?.stamp === undefined) continue;
		if (newest !== undefined && t.stamp < newest.stamp!)
			out.push(
				`${t.content} (read ${t.stamp}) sent after ${newest.content} (read ${newest.stamp})`,
			);
		else newest = t;
	}
	return out;
}

/**
 * Finding F2 (#3530): a stale read displaces an unstamped touch. An unstamped
 * entry replacing a pending stale read inherits its stamp, and a stale read
 * replacing a pending unstamped entry takes its place; either way the runner
 * then drops the entry and the unstamped content is never sent. Carved out of
 * `newestReadHeld` only; the replay below fails until it is fixed.
 */
function staleReadDisplacesUnstamped(
	segment: readonly Touch[],
	newest: Touch,
	expected: Touch,
): boolean {
	return (
		expected.stamp === undefined &&
		segment.some(
			(t) =>
				t.stamp !== undefined &&
				t.stamp < newest.stamp! &&
				t.issuedAt > newest.issuedAt,
		)
	);
}

/**
 * #3481, no-drop: at quiescence the server holds the newest read, or an
 * unstamped touch issued after it. "Newest" spans every read since the server
 * last dropped the document (a delivered didClose); the touches that may
 * answer are those issued after the last close settled. Judged only where the
 * model says nothing may refuse them: the client never died, and no close is
 * involved or the file was there from the last close on.
 */
function newestReadHeld(run: Run): string[] {
	if (run.diedAt !== undefined) return [];
	const lastClose = run.closes.at(-1);
	const from = lastClose?.settledAt ?? -1;
	if (lastClose && (!existsAt(run, from) || run.gone.some((g) => g > from)))
		return [];
	const segment = run.touches.filter((t) => t.issuedAt > from);
	if (segment.length === 0) return [];
	const reset = Math.max(
		-1,
		...run.wire
			.filter((m) => m.delivered && m.method === "didClose")
			.map((m) => m.at),
	);
	const newest = newestStamped(run.touches.filter((t) => t.issuedAt > reset));
	const candidates = newest
		? [
				...(segment.includes(newest) ? [newest] : []),
				...segment.filter(
					(t) => t.stamp === undefined && t.issuedAt > newest.issuedAt,
				),
			]
		: segment;
	// Every touch since is older than a read the client already knew of.
	if (candidates.length === 0) return [];
	const expected = candidates.reduce((a, b) =>
		b.issuedAt > a.issuedAt ? b : a,
	);
	if (newest && staleReadDisplacesUnstamped(segment, newest, expected))
		return [];
	const doc = serverDoc(run.wire);
	if (!doc.open) return [`server holds nothing; expected ${expected.content}`];
	if (doc.content !== expected.content)
		return [`server holds ${doc.content}; expected ${expected.content}`];
	return [];
}

/**
 * #3477: after a didClose the path is re-opened only by a touch issued after
 * that didClose, and only when a file existed there again.
 */
function nothingAfterClose(run: Run): string[] {
	const out: string[] = [];
	let closedAt: number | undefined;
	for (const m of run.wire) {
		if (!m.delivered) continue;
		if (m.method === "didClose") {
			closedAt = m.at;
			continue;
		}
		if (closedAt === undefined) continue;
		if (m.method !== "didOpen" && m.method !== "didChange") continue;
		const t = touchOf(run, m.text);
		if (!t || t.issuedAt < closedAt)
			out.push(`${m.method}:${m.text} after didClose, issued before it`);
		const since = closedAt;
		if (!existsAt(run, since) && !run.back.some((b) => b > since))
			out.push(`${m.method}:${m.text} re-opened a path whose file is gone`);
		closedAt = undefined;
	}
	return out;
}

/**
 * Close-stamp drop (#3491 verify round) and #3477 trace B: when a close
 * settles on a live client, the server holds no document for the path.
 */
function queuedCloseSent(run: Run): string[] {
	const out: string[] = [];
	for (const c of run.closes) {
		if (c.settledAt === undefined) continue;
		if (run.diedAt !== undefined && run.diedAt < c.settledAt) continue;
		if (c.serverAtSettle?.open)
			out.push(
				`close#${c.id} settled while the server holds ${c.serverAtSettle.content}`,
			);
	}
	return out;
}

/**
 * #3405 / #3481 round-1 B1: a save produces a didSave after it was issued,
 * even when its content was superseded; and no didSave goes out for a
 * document the server does not hold. The save is owed only while nothing
 * legitimately ends it: a live client, no close after it or pending when it
 * was issued, a file there throughout, and no later `change` (a change drops
 * an inherited save by design, #3405).
 */
function saveSurvives(run: Run): string[] {
	const out: string[] = [];
	for (const [i, m] of run.wire.entries()) {
		if (m.method !== "didSave" || !m.delivered) continue;
		if (!serverDoc(run.wire.slice(0, i)).open)
			out.push(`didSave for a document the server does not hold`);
	}
	if (!run.saveOptions || run.diedAt !== undefined) return out;
	for (const save of run.touches) {
		if (!save.saved) continue;
		// A close issued after the save, or still pending when it was issued.
		const endedByClose = run.closes.some(
			(c) => (c.settledAt ?? Number.POSITIVE_INFINITY) > save.issuedAt,
		);
		if (endedByClose) continue;
		if (
			!existsAt(run, save.issuedAt) ||
			run.gone.some((g) => g > save.issuedAt)
		)
			continue;
		if (
			run.touches.some((t) => t.kind === "change" && t.issuedAt > save.issuedAt)
		)
			continue;
		const saved = run.wire.some(
			(m) => m.method === "didSave" && m.delivered && m.at > save.issuedAt,
		);
		if (!saved) out.push(`save of ${save.content} produced no didSave`);
	}
	return out;
}

/**
 * Finding F1 (#3530): on a dead client a touch resolves `true` without
 * sending — `handleNotifyOpen`/`handleNotifyChange` return `true` up front,
 * and a queued entry whose run finds the client dead returns `undefined`,
 * which the runner reads as sent. Teardown's own cancel resolves `false` for
 * the same "never sent" state (#3481 round 1). Carved out of `waiterTruth`
 * only; the replay below fails until it is fixed.
 */
function deadClientResolvesTrue(run: Run, t: Touch): boolean {
	return run.diedAt !== undefined && run.diedAt < (t.settledAt ?? 0);
}

/**
 * Every waiter's result: `true` whenever its content reached the server, and
 * `true` otherwise only when a touch issued after it reached the server (a
 * superseded caller waits on its replacement, #2113). A stale read is issued
 * after the entry that keeps it out, so it has no such replacement.
 */
function waiterTruth(run: Run): string[] {
	const out: string[] = [];
	const delivered = run.wire.filter(
		(m) => m.delivered && (m.method === "didOpen" || m.method === "didChange"),
	);
	for (const t of run.touches) {
		const sent = delivered.some((m) => m.text === t.content);
		if (sent && t.result !== true)
			out.push(`${t.content} was sent but resolved ${t.result}`);
		if (sent || t.result !== true) continue;
		const replaced = delivered.some(
			(m) => (touchOf(run, m.text)?.issuedAt ?? -1) > t.issuedAt,
		);
		if (!replaced && !deadClientResolvesTrue(run, t))
			out.push(
				`${t.content} resolved true, but neither it nor a newer touch was sent`,
			);
	}
	return out;
}

const PROPERTIES = {
	liveness,
	newestReadOrder,
	newestReadHeld,
	nothingAfterClose,
	queuedCloseSent,
	saveSurvives,
	waiterTruth,
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

describe("#3530 — notify queue properties over scheduled interleavings", () => {
	beforeEach(() => {
		// The first-open path arms the watched-files debounce timer; fake
		// timers keep it from firing into a later run.
		vi.useFakeTimers();
	});
	afterEach(() => {
		fsProbe.access = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("holds every property for any command sequence and ordering", async () => {
		await fc.assert(
			fc.asyncProperty(fc.scheduler(), scenarioArb, async (s, scenario) => {
				assertHolds(
					await execute(s, scenario.commands, scenario.saveOptions),
					ALL,
				);
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});

	/**
	 * Findings on master, each replayed over every ordering of its shrunk
	 * counterexample's commands. `it.fails`: green while the finding stands; a
	 * fix turns it red. F1 and F2 are carved out of the property above by name
	 * (`deadClientResolvesTrue`, `staleReadDisplacesUnstamped`), and the
	 * carve-out goes with the fix. F3 has none: the fixed seed never reaches it,
	 * other seeds do.
	 */
	describe("findings on master (#3530), pinned until fixed", () => {
		const replay = (
			commands: Command[],
			saveOptions: boolean,
			check: (run: Run) => string[],
		) =>
			fc.assert(
				fc.asyncProperty(fc.scheduler(), async (s) => {
					const run = await execute(s, commands, saveOptions);
					const found = check(run);
					if (found.length > 0)
						throw new Error(`${found.join("\n")}\n${run.log.join("\n")}`);
				}),
				{ numRuns: 200, seed: SEED },
			);
		const open = (stamp?: number, saved = false): Command => ({
			t: "open",
			stamp,
			saved,
			silent: true,
		});

		it.fails("F1: a touch on a dead client resolves true without sending", () =>
			replay([open(), open(), { t: "die" }], false, (run) =>
				run.touches
					.filter(
						(t) =>
							t.result === true &&
							!run.wire.some((m) => m.delivered && m.text === t.content),
					)
					.map((t) => `${t.content} resolved true, never sent`),
			));

		it.fails("F2: a stale read makes the queue drop an unstamped touch issued after the newest read", () =>
			replay([open(6), open(), open(0)], false, (run) => {
				const doc = serverDoc(run.wire);
				return doc.open && doc.content === "c1"
					? []
					: [`server holds ${doc.open ? doc.content : "nothing"}, not c1`];
			}));

		it.fails("F3: a stale saved read kept out behind a pending change sends no didSave", () =>
			replay([open(0), open(3), { t: "change" }, open(2, true)], true, (run) =>
				run.wire.some((m) => m.method === "didSave")
					? []
					: ["no didSave for the save of c3"],
			));
	});
});
