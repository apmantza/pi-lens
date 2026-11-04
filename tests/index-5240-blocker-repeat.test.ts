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
import {
	AUTOMATION_FRAMING,
	BLOCKER_REPEAT_HEADING,
} from "../clients/runtime-context.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GUARDED_FLAGS,
	endTurn,
	openGuardedSession,
	seed,
	step,
	textBlocks,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
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
				// p1 delivers the blocker itself; p2, p3 and p4 each repeat it once.
				expect(found.map(openedBy)).toEqual([
					expect.stringContaining("p2"),
					expect.stringContaining("p3"),
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

describe("#5240: retained injections (--lens-retain-injections)", () => {
	const RETAIN: ReadonlyArray<[string, boolean]> = [
		...UNGUARDED_FLAGS,
		["lens-retain-injections", true],
	];

	it(
		"repeats nothing while the blocker is retained and re-injects when the set changes",
		async () => {
			// RECURRENCE GUARDED: #5240's retain clause. A per-prompt repeat would be
			// retained as a new entry each time and reach the 64-entry cap.
			const { handle } = await openCell("retain", RETAIN, (proj) => [
				...write(proj, "bad.ts", BLOCKING_FILE),
				...listen(),
				...listen(),
				...listen(),
				...write(proj, "second.ts", BLOCKING_FILE),
				...listen(),
			]);
			await run(handle, 6);
			expect(repeats(handle)).toHaveLength(0);
			const bad = `${SECTION}${path.join("src", "bad.ts")}`;
			const second = `${SECTION}${path.join("src", "second.ts")}`;
			// Retained, the original delivery is re-sent unchanged, once per request.
			const request = handle.requests[3] as PiProviderRequest;
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
