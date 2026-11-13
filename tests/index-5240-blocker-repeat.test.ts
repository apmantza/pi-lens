/**
 * #5240: a 🔴 blocker the model was told about once and has not fixed names
 * itself again at the first request of each later prompt.
 *
 * Recurrence prevented: the turn-end check reaches the model in one provider
 * request only, and pi rebuilds the next prompt's request from its transcript.
 * A nested write's STOP note never enters that transcript (the codemode
 * script drops it), so after one unheeded request nothing showed the blocker
 * again until a commit attempt or a `lens_diagnostics` pull (#5236 item 4).
 * #4921's dedupe (one delivery per blocker set) stays for the requests inside
 * one prompt.
 *
 * Tier 2 (#4632): the BUILT extension in a real pi `AgentSession`, the model
 * scripted at the provider boundary. What the model received is read from the
 * provider requests; no store, cache or composer is replaced.
 *
 * Lane: ubuntu Unit tests.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_RETAINED_ENTRIES } from "../clients/context-injection-ledger.js";
import {
	AUTOMATION_FRAMING,
	BLOCKER_REPEAT_HEADING,
} from "../clients/runtime-context.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	GUARDED_FLAGS,
	MARKED_FILE,
	RAN_MARKER,
	activateMarkTool,
	commitAttempt,
	endTurn,
	markFalsePositive,
	openGuardedSession,
	seed,
	step,
	textBlocks,
	toolResults,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	fauxToolCall,
	type PiProviderRequest,
	type PiSession,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

const LONG_SESSION_TIMEOUT_MS = 120_000;

/** The header of one blocker section of a turn-end delivery. */
const SECTION = "Unresolved from this turn — ";

const UNGUARDED_FLAGS: ReadonlyArray<[string, boolean]> = GUARDED_FLAGS.filter(
	([name]) => name !== "lens-guard",
);

function write(
	proj: string,
	name: string,
	content = CLEAN_FILE,
): PiFauxReply[] {
	return [
		step(writeTarget(path.join(proj, "src", name), content), "writing"),
		endTurn("turn done"),
	];
}

const listen = (): PiFauxReply[] => [endTurn("listening")];

/** Every injected pi-lens text of one request, in order. */
function injections(request: PiProviderRequest): string[] {
	return request.flatMap((message) =>
		textBlocks(message).filter((text) => text.includes(AUTOMATION_FRAMING)),
	);
}

/** The requests that carry a repeat, by the heading it opens with. */
function repeats(handle: PiSession): PiProviderRequest[] {
	return handle.requests.filter((request) =>
		injections(request).some((text) => text.includes(BLOCKER_REPEAT_HEADING)),
	);
}

/** The text of the prompt that opened this request (the last plain user text). */
function openedBy(request: PiProviderRequest): string {
	const last = request[request.length - 1];
	return last?.role === "user" ? textBlocks(last).join("\n") : "<mid-run>";
}

/** Requests whose injections name `needle`. */
function naming(handle: PiSession, needle: string): number {
	return handle.requests.filter((request) =>
		injections(request).some((text) => text.includes(needle)),
	).length;
}

async function openCell(
	name: string,
	flags: ReadonlyArray<[string, boolean]> | undefined,
	build: (proj: string) => PiFauxReply[],
): Promise<{ handle: PiSession; proj: string }> {
	const { proj } = seed(fixture.root, name, CLEAN_FILE);
	const responses = build(proj);
	const handle =
		flags === undefined
			? await openGuardedSession(fixture.root, proj, responses)
			: await startPiSession({
					root: fixture.root,
					cwd: proj,
					flags: new Map(flags),
					responses,
				});
	return { handle, proj };
}

async function run(handle: PiSession, prompts: number): Promise<void> {
	for (let turn = 1; turn <= prompts; turn++) await handle.prompt(`p${turn}`);
}

describe.each([
	{ tag: "guard", flags: undefined },
	{ tag: "plain", flags: UNGUARDED_FLAGS },
])(
	"#5240: an unresolved blocker repeats once per prompt ($tag)",
	({ tag, flags }) => {
		it(
			"names the blocker at the first request of each later prompt and nowhere else",
			async () => {
				// RECURRENCE GUARDED: #5240 (#5236 item 4): prompt 2's request carried no
				// blocker text. Prompt 3 has a mid-run write step, so a repeat on every
				// request (rather than the prompt's first) would show up twice there.
				const { handle } = await openCell(`repeat-${tag}`, flags, (proj) => [
					...write(proj, "bad.ts", BLOCKING_FILE),
					...listen(),
					...write(proj, "clean.ts"),
					...listen(),
				]);
				await run(handle, 4);
				const found = repeats(handle);
				// p1 delivers the blocker itself (its 1st full delivery); p2 and p3
				// repeat it (the 2nd and 3rd, #5532's cap); p4 gets only the pointer.
				expect(found.map(openedBy)).toEqual([
					expect.stringContaining("p2"),
					expect.stringContaining("p3"),
				]);
				expect(pointers(handle).map(openedBy)).toEqual([
					expect.stringContaining("p4"),
				]);
				for (const request of found) {
					const repeat = injections(request).filter((text) =>
						text.includes(BLOCKER_REPEAT_HEADING),
					);
					expect(repeat).toHaveLength(1);
					expect(repeat[0]).toContain(
						`${SECTION}${path.join("src", "bad.ts")}`,
					);
					// "Historical finding" means the workspace changed; this did not.
					expect(repeat[0]).not.toContain("Historical finding");
					// The repeat is capped, so its last line says where the full list is.
					expect(repeat[0]?.trimEnd().split("\n").at(-1)).toContain(
						'lens_diagnostics {source: "session", mode: "all", severity: "error"}',
					);
				}
				// The blocker's own delivery is not a repeat: exactly one request names
				// the section without the heading.
				expect(
					handle.requests.filter((request) =>
						injections(request).some(
							(text) =>
								text.includes(`${SECTION}${path.join("src", "bad.ts")}`) &&
								!text.includes(BLOCKER_REPEAT_HEADING),
						),
					),
				).toHaveLength(1);
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"stops repeating once the blocker is fixed",
			async () => {
				// RECURRENCE GUARDED: a repeat that outlives its blocker pressures the
				// model about a file it already fixed (the resolved direction of #5240).
				const { handle } = await openCell(`resolved-${tag}`, flags, (proj) => [
					...write(proj, "bad.ts", BLOCKING_FILE),
					...listen(),
					...write(proj, "bad.ts", CLEAN_FILE),
					...listen(),
					...listen(),
				]);
				await run(handle, 5);
				// p2 and p3 open before the fix lands (p3 writes it). p4 and p5 follow
				// the fix and repeat nothing.
				expect(repeats(handle).map(openedBy)).toEqual([
					expect.stringContaining("p2"),
					expect.stringContaining("p3"),
				]);
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);
	},
);

describe.each([
	{ tag: "guard", flags: undefined },
	{ tag: "plain", flags: UNGUARDED_FLAGS },
])(
	"#5240: a repeat staged for the next prompt dies with its blocker ($tag)",
	({ tag, flags }) => {
		it(
			"is not delivered after the model marks the blocker false-positive",
			async () => {
				// RECURRENCE GUARDED: #5240. A read-only turn now stages a repeat, and a
				// mark silences the blocker with no resolved line to overwrite it. A
				// repeat left staged would name a blocker the model just dismissed.
				const { handle } = await openCell(`marked-${tag}`, flags, (proj) => [
					step(
						writeTarget(path.join(proj, "src", "target.ts"), MARKED_FILE),
						"writing",
					),
					endTurn("turn done"),
					step(activateMarkTool()),
					step(markFalsePositive(path.join(proj, "src", "target.ts"))),
					endTurn("marked"),
					endTurn("listening"),
				]);
				await run(handle, 3);
				// Only p2's first request repeats; the mark lands after it.
				expect(repeats(handle).map(openedBy)).toEqual([
					expect.stringContaining("p2"),
				]);
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"is not delivered after the mark while another session holds a blocker",
			async () => {
				// RECURRENCE GUARDED: #5254 review r1 F1. The consume-time check asked
				// whether ANY session held a blocker (the commit-gate latch), so the
				// primary's live blocker let the secondary's staged repeat of the
				// blocker it had just marked through at its next prompt.
				const proj = seed(fixture.root, `marked-two-${tag}`, CLEAN_FILE).proj;
				const sessionFlags = new Map(flags ?? GUARDED_FLAGS);
				const theirs = path.join(proj, "src", "theirs.ts");
				const primary = await startPiSession({
					root: fixture.root,
					cwd: proj,
					flags: sessionFlags,
					responses: [...write(proj, "mine.ts", BLOCKING_FILE), ...listen()],
				});
				const secondary = await startPiSession({
					root: fixture.root,
					cwd: proj,
					flags: sessionFlags,
					responses: [
						step(writeTarget(theirs, MARKED_FILE), "writing"),
						endTurn("turn done"),
						...listen(),
						step(activateMarkTool()),
						step(markFalsePositive(theirs)),
						endTurn("marked"),
						...listen(),
						...listen(),
					],
				});
				try {
					await primary.prompt("p1");
					await run(secondary, 5);
					// p2 and p3 open before the mark lands (p3 makes it); p4 and p5
					// follow it and repeat nothing, though mine.ts is still live.
					expect(repeats(secondary).map(openedBy)).toEqual([
						expect.stringContaining("p2"),
						expect.stringContaining("p3"),
					]);
					expect(naming(primary, "mine.ts")).toBeGreaterThan(0);
					expect(primary.errors).toEqual([]);
					expect(secondary.errors).toEqual([]);
				} finally {
					await secondary.dispose();
					await primary.dispose();
				}
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"keeps telling the model about the unmarked blocker after the other one is marked",
			async () => {
				// RECURRENCE GUARDED: #5240. A mark changes the surviving set on a
				// read-only turn; a turn end that stages nothing for a changed set
				// would end the repeat of the blocker the model has not dismissed.
				const { handle } = await openCell(`partial-${tag}`, flags, (proj) => [
					step(
						writeTarget(path.join(proj, "src", "target.ts"), MARKED_FILE),
						"writing",
					),
					endTurn("turn done"),
					...write(proj, "bad.ts", BLOCKING_FILE),
					step(activateMarkTool()),
					step(markFalsePositive(path.join(proj, "src", "target.ts"))),
					endTurn("marked"),
					...listen(),
					...listen(),
				]);
				await run(handle, 5);
				const target = `${SECTION}${path.join("src", "target.ts")}`;
				const later = handle.requests.filter((request) =>
					/p4|p5/.test(openedBy(request)),
				);
				// The mark (in p3) changes the set, so bad.ts is delivered afresh in p3
				// (its 3rd full delivery); p4 and p5 carry its pointer and never target.ts.
				expect(later).toHaveLength(2);
				for (const request of later) {
					const text = injections(request).join("\n");
					expect(text).toContain(`${path.join("src", "bad.ts")}: ${POINTER}`);
					expect(text).not.toContain(BLOCKER_REPEAT_HEADING);
					expect(text).not.toContain(target);
				}
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);
	},
);

/** What a capped blocker says in place of its full section. */
const POINTER = "older blocker still open";

/** Two debuggers: the same file with other blocking content than `BLOCKING_FILE`. */
const CHANGED_BLOCKING_FILE =
	"const a = 1;\nexport function f() {\n\tdebugger;\n\tdebugger;\n\treturn a;\n}\n";

/** Requests whose injections carry the capped pointer. */
function pointers(handle: PiSession): PiProviderRequest[] {
	return handle.requests.filter((request) =>
		injections(request).some((text) => text.includes(POINTER)),
	);
}

/** Requests that deliver `src/<name>`'s blocker section in full (heading or not). */
function fullDeliveries(handle: PiSession, name: string): PiProviderRequest[] {
	const section = `${SECTION}${path.join("src", name)}`;
	return handle.requests.filter((request) =>
		injections(request).some((text) => text.includes(section)),
	);
}

/**
 * The `blocker-repeat-capped` `degradation_ledger` rows, as their metadata.
 * The latency log is shared by every case of this file, so a case reads the
 * rows it added: those after the `before` it took ahead of its first prompt.
 */
async function cappedRows(
	handle: PiSession,
	before = 0,
): Promise<Array<Record<string, unknown>>> {
	const read = await handle.latencyRows();
	expect(read.skipped).toBe(0);
	return read.rows
		.filter((row) => row.phase === "degradation_ledger")
		.map((row) => row.metadata as Record<string, unknown>)
		.filter((metadata) => metadata.kind === "blocker-repeat-capped")
		.slice(before);
}

const prompted = (...prompts: number[]) =>
	prompts.map((prompt) => expect.stringContaining(`p${prompt}`));

describe.each([
	{ tag: "guard", flags: undefined },
	{ tag: "plain", flags: UNGUARDED_FLAGS },
])(
	"#5532: a blocker the session cannot clear is delivered in full at most 3 times ($tag)",
	({ tag, flags }) => {
		it(
			"turns the 4th and later deliveries into a one-line pointer, keeping the blocker in lens_diagnostics and the commit gate",
			async () => {
				// RECURRENCE GUARDED: #5532. A blocker raised in a worktree the session
				// cannot write to (pi-dev-flow) repeated in full at 8 of 9 later prompts.
				// p6 pulls lens_diagnostics and attempts a commit AFTER the cap.
				const { handle } = await openCell(`cap-${tag}`, flags, (root) => [
					...write(root, "bad.ts", BLOCKING_FILE),
					...Array.from({ length: 4 }, listen).flat(),
					step(
						fauxToolCall("lens_diagnostics", {
							source: "session",
							mode: "all",
							severity: "error",
						}),
						"listing",
					),
					step(commitAttempt(), "committing"),
					endTurn("p6 done"),
					...Array.from({ length: 3 }, listen).flat(),
				]);
				const rowsBefore = (await cappedRows(handle)).length;
				await run(handle, 9);
				// p1 delivers it (1st), p2 and p3 repeat it in full (2nd, 3rd); every
				// later prompt gets the pointer.
				expect(repeats(handle).map(openedBy)).toEqual(prompted(2, 3));
				expect(fullDeliveries(handle, "bad.ts")).toHaveLength(3);
				const pointed = pointers(handle);
				expect(pointed.map(openedBy)).toEqual(prompted(4, 5, 6, 7, 8, 9));
				for (const request of pointed) {
					const texts = injections(request);
					expect(texts).toHaveLength(1);
					const pointer = texts[0] as string;
					expect(pointer).toContain(POINTER);
					expect(pointer).toContain(path.join("src", "bad.ts"));
					expect(pointer).toContain("lens_diagnostics");
					// One line, and none of the blocker's own text.
					expect(pointer.trim().split("\n")).toHaveLength(1);
					expect(pointer).not.toContain(BLOCKER_REPEAT_HEADING);
					expect(pointer).not.toContain("Debugger statement");
				}
				// The blocker itself stands after the cap: the pull still lists it ...
				const last = handle.requests.at(-1) ?? [];
				const [listed] = toolResults(last, "lens_diagnostics");
				expect(listed?.text).toContain("bad.ts");
				expect(listed?.text).toContain("[debugger-statement]");
				// ... and the commit gate still holds it (the plain cell never gates).
				const [commit] = toolResults(last, "bash");
				if (tag === "guard") {
					expect(commit?.text).toContain(GATE_BLOCK);
					expect(commit?.text).not.toContain(RAN_MARKER);
				} else {
					expect(commit?.text).toContain(RAN_MARKER);
				}
				// Retiring a full delivery leaves ONE counted row, not one per prompt.
				const rows = await cappedRows(handle, rowsBefore);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.count).toBe(1);
				expect(String(rows[0]?.subject)).toContain(path.join("src", "bad.ts"));
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"keeps a stuck blocker collapsed while the session raises and fixes other blockers",
			async () => {
				// RECURRENCE GUARDED: #5532 review r1 F1. The cap sat on the repeat only,
				// so every set change re-sent the stuck blocker in full: 28 full
				// deliveries in 21 prompts (8 write-and-fix cycles of a transient one).
				const { handle } = await openCell(`cycles-${tag}`, flags, (proj) => [
					...write(proj, "bad.ts", BLOCKING_FILE),
					...Array.from({ length: 8 }, () => [
						...write(proj, "a.ts", BLOCKING_FILE),
						...write(proj, "a.ts", CLEAN_FILE),
					]).flat(),
					...Array.from({ length: 4 }, listen).flat(),
				]);
				await run(handle, 21);
				expect(fullDeliveries(handle, "bad.ts")).toHaveLength(3);
				expect(pointers(handle).length).toBeGreaterThan(8);
				// The transient blocker is its own count: in full on every raise.
				expect(fullDeliveries(handle, "a.ts").length).toBeGreaterThanOrEqual(8);
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"shows an unrelated new blocker in full without restarting the capped one",
			async () => {
				// RECURRENCE GUARDED: #5532 review r1 Q1. A per-set count let a joiner
				// lift the cap from the blocker the model had been told 3 times.
				const { handle } = await openCell(`joiner-${tag}`, flags, (proj) => [
					...write(proj, "bad.ts", BLOCKING_FILE),
					...Array.from({ length: 4 }, listen).flat(),
					...write(proj, "second.ts", BLOCKING_FILE),
					...Array.from({ length: 4 }, listen).flat(),
				]);
				await run(handle, 10);
				// bad.ts: 3 full in all. second.ts: its own 3 (raised p6, repeats p7, p8).
				expect(fullDeliveries(handle, "bad.ts")).toHaveLength(3);
				expect(fullDeliveries(handle, "second.ts")).toHaveLength(3);
				expect(repeats(handle).map(openedBy)).toEqual(prompted(2, 3, 7, 8));
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"restarts the count when the blocker is re-raised with changed content",
			async () => {
				// RECURRENCE GUARDED: #5532. A cap that outlived its blocker's content
				// would pointer a NEW blocker the model has never been told about.
				const { handle } = await openCell(`restart-${tag}`, flags, (proj) => [
					...write(proj, "bad.ts", BLOCKING_FILE),
					...Array.from({ length: 5 }, listen).flat(),
					...write(proj, "bad.ts", CHANGED_BLOCKING_FILE),
					...Array.from({ length: 4 }, listen).flat(),
				]);
				const rowsBefore = (await cappedRows(handle)).length;
				await run(handle, 11);
				// p2, p3 repeat; p4-p6 and p7 (which re-raises) open on the pointer; the
				// changed content is delivered in-run at p7 and repeats at p8 and p9,
				// then the pointer returns.
				expect(repeats(handle).map(openedBy)).toEqual(prompted(2, 3, 8, 9));
				expect(pointers(handle).map(openedBy)).toEqual(
					prompted(4, 5, 6, 7, 10, 11),
				);
				// Each blocker's cap is its own event: two rows, counted 1 then 2.
				const rows = await cappedRows(handle, rowsBefore);
				expect(rows.map((row) => row.count)).toEqual([1, 2]);
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"stops the pointer at once when the blocker is fixed after the cap",
			async () => {
				// RECURRENCE GUARDED: #5532. A pointer that outlived the fix would
				// tell the model about a blocker it already cleared.
				const { handle } = await openCell(`fixed-${tag}`, flags, (proj) => [
					...write(proj, "bad.ts", BLOCKING_FILE),
					...Array.from({ length: 4 }, listen).flat(),
					...write(proj, "bad.ts", CLEAN_FILE),
					...Array.from({ length: 2 }, listen).flat(),
				]);
				await run(handle, 8);
				// p4, p5 and p6 (which fixes it) open on the pointer; p7 and p8 say nothing.
				expect(pointers(handle).map(openedBy)).toEqual(prompted(4, 5, 6));
				for (const request of handle.requests.filter((r) =>
					/p7|p8/.test(openedBy(r)),
				))
					expect(injections(request)).toEqual([]);
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"writes the cap row once per blocker, though another blocker leaves before its own cap",
			async () => {
				// RECURRENCE GUARDED: #5532 review r1 F2. The set-level row was skipped
				// when the lowest-count member left; each blocker now writes its own.
				const { handle } = await openCell(`rows-${tag}`, flags, (proj) => [
					...write(proj, "bad.ts", BLOCKING_FILE),
					...Array.from({ length: 2 }, listen).flat(),
					...write(proj, "second.ts", BLOCKING_FILE),
					...listen(),
					...write(proj, "second.ts", CLEAN_FILE),
					...Array.from({ length: 4 }, listen).flat(),
				]);
				const rowsBefore = (await cappedRows(handle)).length;
				await run(handle, 10);
				const rows = await cappedRows(handle, rowsBefore);
				expect(rows).toHaveLength(1);
				expect(String(rows[0]?.subject)).toContain(path.join("src", "bad.ts"));
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"names each capped blocker and drops one the model marks",
			async () => {
				// RECURRENCE GUARDED: #5532 review r1 F3 (survivors). A pointer that
				// miscounted files, or kept naming a marked blocker, goes unnoticed.
				const bad = path.join("src", "bad.ts");
				const target = path.join("src", "target.ts");
				const { handle } = await openCell(`capmark-${tag}`, flags, (proj) => [
					...write(proj, "bad.ts", BLOCKING_FILE),
					step(
						writeTarget(path.join(proj, "src", "target.ts"), MARKED_FILE),
						"writing",
					),
					endTurn("turn done"),
					...Array.from({ length: 3 }, listen).flat(),
					step(activateMarkTool()),
					step(markFalsePositive(path.join(proj, "src", "target.ts"))),
					endTurn("marked"),
					...listen(),
					...listen(),
				]);
				await run(handle, 8);
				// p5 and p6 carry both capped blockers; p7 and p8 follow the mark.
				for (const request of handle.requests.filter((r) =>
					/p5|p6/.test(openedBy(r)),
				)) {
					const text = injections(request).join("\n");
					expect(text).toContain(`${bad}: ${POINTER}`);
					expect(text).toContain(`${target}: ${POINTER}`);
				}
				for (const request of handle.requests.filter((r) =>
					/p7|p8/.test(openedBy(r)),
				)) {
					const text = injections(request).join("\n");
					expect(text).toContain(`${bad}: ${POINTER}`);
					expect(text).not.toContain(target);
				}
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);

		it(
			"writes no cap row for a blocker the model marks at its cap",
			async () => {
				// RECURRENCE GUARDED: the consume loop that counts a repeat read every
				// record of the session, so a marked blocker (policy-suppressed) at its
				// 3rd delivery was counted collapsed and wrote a cap row for a blocker
				// the agent is no longer told about.
				const bad = path.join("src", "bad.ts");
				const { handle } = await openCell(
					`capmarkrow-${tag}`,
					flags,
					(proj) => [
						...write(proj, "bad.ts", BLOCKING_FILE),
						step(
							writeTarget(path.join(proj, "src", "target.ts"), MARKED_FILE),
							"writing",
						),
						endTurn("turn done"),
						...listen(),
						step(activateMarkTool()),
						step(markFalsePositive(path.join(proj, "src", "target.ts"))),
						endTurn("marked"),
						...listen(),
						...listen(),
					],
				);
				const rowsBefore = (await cappedRows(handle)).length;
				await run(handle, 7);
				const rows = await cappedRows(handle, rowsBefore);
				expect(rows.map((row) => row.subject)).toEqual([
					`inline-blocker-repeat:${bad}`,
				]);
				expect(handle.errors).toEqual([]);
			},
			LONG_SESSION_TIMEOUT_MS,
		);
	},
);

describe("#5240: retained injections (--lens-retain-injections)", () => {
	const RETAIN: ReadonlyArray<[string, boolean]> = [
		...UNGUARDED_FLAGS,
		["lens-retain-injections", true],
	];
	/** Past MAX_RETAINED_ENTRIES (64): one retained repeat per prompt would hit it. */
	const LISTENING_PROMPTS = MAX_RETAINED_ENTRIES + 6;

	it(
		"repeats nothing while the blocker is retained, spends none of the cap, and re-injects when the set changes",
		async () => {
			// RECURRENCE GUARDED: #5240's retain clause. A per-prompt repeat would be
			// retained as a new entry each time, reach the 64-entry cap, and record
			// `context-injection-retain-declined`.
			const { handle } = await openCell("retain", RETAIN, (proj) => [
				...write(proj, "bad.ts", BLOCKING_FILE),
				...Array.from({ length: LISTENING_PROMPTS }, listen).flat(),
				...write(proj, "second.ts", BLOCKING_FILE),
				...listen(),
			]);
			await run(handle, LISTENING_PROMPTS + 3);
			expect(repeats(handle)).toHaveLength(0);
			const bad = `${SECTION}${path.join("src", "bad.ts")}`;
			const second = `${SECTION}${path.join("src", "second.ts")}`;
			const rows = await handle.latencyRows();
			expect(rows.skipped).toBe(0);
			expect(JSON.stringify(rows.rows)).not.toContain(
				"context-injection-retain-declined",
			);
			// Retained, the original delivery is re-sent unchanged, once per request.
			const request = handle.requests[LISTENING_PROMPTS] as PiProviderRequest;
			expect(JSON.stringify(request).split(bad).length - 1).toBe(1);
			// A new blocker is a changed set: delivered, and carried by the last
			// request alongside the first.
			expect(naming(handle, second)).toBeGreaterThan(0);
			const last = handle.requests.at(-1) as PiProviderRequest;
			expect(JSON.stringify(last)).toContain(second);
			expect(JSON.stringify(last)).toContain(bad);
			expect(handle.errors).toEqual([]);
		},
		LONG_SESSION_TIMEOUT_MS,
	);
});

describe("#5240: context injection off", () => {
	it(
		"repeats nothing when contextInjection is disabled",
		async () => {
			// RECURRENCE GUARDED: `contextInjection.enabled: false` (`--no-lens-context`)
			// must stay byte-silent; the repeat is an injection like the others.
			const { handle } = await openCell(
				"disabled",
				[...UNGUARDED_FLAGS, ["no-lens-context", true]],
				(proj) => [
					...write(proj, "bad.ts", BLOCKING_FILE),
					...listen(),
					...listen(),
				],
			);
			await run(handle, 3);
			for (const request of handle.requests)
				expect(injections(request)).toEqual([]);
			expect(handle.errors).toEqual([]);
		},
		LONG_SESSION_TIMEOUT_MS,
	);
});
