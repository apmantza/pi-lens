/**
 * Slice 7 of #4632: the turn-end ordering on the REAL host.
 *
 * Every case here was moved out of a file that drove the hand-built pi double
 * (`tests/support/pi-mock.ts`), and every one of them pins the same ORDER: a
 * `tool_result` starts the cascade compute, `turn_end` composes its line, and
 * the NEXT model request carries it. The double could only check the payload
 * `index.ts` handed a handler; a case here reads the transcript pi actually
 * built and sent (`tests/support/pi-session.ts`, tier 2), so a break in the
 * order between those three hooks changes what the model receives.
 *
 * Moved from `tests/clients/cascade-unanswered-primary-4403.test.ts` (7 of its
 * 10 cases: the five cause-matrix cells and two of its three scripts). Three
 * STAY on the double, with the probe that keeps them there:
 *
 * - "delivers the line once: a section the cap cut, then the next turn" and
 *   "delivers the line once: the cascade section leads and the cap cuts it".
 *   CLASS: `internal-seam` — both script `RUNTIME_CONFIG.turnEnd.maxChars`,
 *   which `clients/runtime-config.ts` declares `as const` and
 *   `clients/runtime-turn.ts` reads from its OWN copy of that module. The
 *   loaded copy owns a second object, so a test-side mutation reaches nothing:
 *   probed by setting `maxChars` to 40 here and watching the whole section
 *   deliver anyway (the cap ran at 1000). A cap-bound claim needs a payload
 *   over 1000 chars, which no scripted provider can produce.
 * - "b.ts, then its neighbour c.ts, which nothing imports" is environment-
 *   dependent: it reds in the plegma sandbox (the line rides turn 1, not turn
 *   2) and passes on the orchestrator's host, where 3 of 3 head runs and
 *   master's own copy are green. It stays on the double until that dependence
 *   is understood (#4632 remainder).
 *
 * `runTurns` attributes a delivery to the requests a prompt actually made
 * (`session.requests.length` before and after it), never to the prompt's index
 * in the schedule: pi makes one request per tool-call round trip, so the two
 * arrays do not line up, and an index taken from the prompts array sampled
 * turn 1's write continuation and read plus turn 2's write continuation while
 * turns 2 and 3's reads were never read (#4716 round 1 F2). It also counts
 * each line's occurrences across the whole run, so a section composed twice in
 * one message fails (#4716 round 3 F7).
 *
 * Language servers are the host boundary, as in the file this moves from: each
 * server's command is a project override pointing at a shim that runs the
 * shared fake server, which answers every pull with no findings. A missing
 * server's command points at a path that does not exist. That is why this file
 * runs in the serialized `lsp-spawn-heavy` lane: real children, one of them
 * held 2 s before it answers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getLSPService, resetLSPService } from "../clients/lsp/index.js";
import { endTurn, step } from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiProviderRequest,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const fakeServer = path.join(
	repoRoot,
	"tests",
	"fixtures",
	"fake-lsp-server.mjs",
);

const FALLBACK_CAUSE =
	"it is disabled in config by lsp.disabledServers, and its fallback could not be started, or was still starting";
const DISABLED_CAUSE = "it is disabled in config by lsp.disabledServers";
const UNSTARTED_CAUSE = "it could not be started, or was still starting";

const cascadeLine = (ids: string, cause: string): string =>
	`⚠️ Cascade: no primary language server answered for neighbor files of ${ids} (${cause}), so their cross-file errors were not confirmed (not a clean result).`;

const UNSTARTED_LINE = cascadeLine("typescript", UNSTARTED_CAUSE);

type Case = {
	name: string;
	typescript: "working" | "slow" | "disabled" | "missing";
	deno: "missing" | "disabled";
	/** The cascade lines the first turn shows; later turns show none. */
	firstTurn: string[];
};

const CASES: readonly Case[] = [
	{
		name: "typescript working",
		typescript: "working",
		deno: "disabled",
		firstTurn: [],
	},
	// Still starting when b.ts is written: the cascade defers a cold server's
	// neighbours (clients/lsp/cascade-tier.ts) rather than naming it, so a
	// session's first edit does not report a server that is only warming up.
	// The hold is 2 s (#3801): the cascade touch waits 1-2 s, and a 1 ms wait
	// names the server and reds this case. The former 8 s hold gave the same
	// verdict 5.5 s slower.
	{
		name: "typescript still starting",
		typescript: "slow",
		deno: "disabled",
		firstTurn: [],
	},
	{
		name: "typescript disabled, deno missing",
		typescript: "disabled",
		deno: "missing",
		firstTurn: [cascadeLine("deno, typescript", FALLBACK_CAUSE)],
	},
	{
		name: "typescript disabled, deno disabled",
		typescript: "disabled",
		deno: "disabled",
		// deno stands in only for a disabled typescript, so with both off
		// both are the file's disabled primaries.
		firstTurn: [cascadeLine("typescript, deno", DISABLED_CAUSE)],
	},
	{
		name: "typescript missing, deno disabled",
		typescript: "missing",
		deno: "disabled",
		firstTurn: [UNSTARTED_LINE],
	},
];

/**
 * a.ts and c.ts import b.ts, d.ts imports a.ts, and f.ts imports e.ts, which
 * nothing else touches. g.ts lacks the fake server's clean marker, so a
 * reporting typos (`typos: "reporting"`) gives it a blocker.
 */
const CLEAN = "// fake-lsp-clean\n";
const FILES: Record<string, (n: number) => string> = {
	a: (n) => `import { b } from "./b";\nexport const a = b + ${n};\n${CLEAN}`,
	b: (n) => `export const b = ${n};\n${CLEAN}`,
	c: (n) => `import { b } from "./b";\nexport const c = b + ${n};\n${CLEAN}`,
	d: (n) => `import { a } from "./a";\nexport const d = a + ${n};\n${CLEAN}`,
	e: (n) => `export const e = ${n};\n${CLEAN}`,
	f: (n) => `import { e } from "./e";\nexport const f = e + ${n};\n${CLEAN}`,
	g: (n) => `export const g = ${n};\n`,
};

/** One turn's writes, in order: a file name and the value it is given. */
type Turn = ReadonlyArray<readonly [name: string, n: number]>;

type Setup = Pick<Case, "name" | "typescript" | "deno"> & {
	/** typos answers a file without the clean marker with one error. */
	typos?: "reporting";
};

/**
 * The project this case runs in: its own directory under the file's ONE
 * fixture root (the helper refuses a second root), carrying the project LSP
 * config the loaded copy reads and the servers' shim scripts.
 */
function makeWorkspace(testCase: Setup, slug: string): string {
	const workspace = path.join(fixture.root, slug);
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	const shim = (serverId: string, delayMs = 0, reporting = false): string[] => {
		const file = path.join(workspace, `${serverId}-server.mjs`);
		fs.writeFileSync(
			file,
			[
				`await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
				reporting ? "" : 'process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		return [process.execPath, file];
	};
	const missing = (serverId: string): string[] => [
		path.join(workspace, "missing", serverId),
		"--stdio",
	];
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"synthetic-4632-s7","private":true}\n',
	);
	for (const [name, content] of Object.entries(FILES))
		fs.writeFileSync(path.join(workspace, `${name}.ts`), content(1));
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				typescript: {
					command:
						testCase.typescript === "missing"
							? missing("typescript-language-server")
							: shim("typescript", testCase.typescript === "slow" ? 2_000 : 0),
				},
				deno: { command: missing("deno") },
				typos: {
					command: shim("typos", 0, testCase.typos === "reporting"),
				},
				opengrep: { command: shim("opengrep") },
			},
			disabledServers: [
				"ast-grep",
				"zizmor",
				...(testCase.typescript === "disabled" ? ["typescript"] : []),
				...(testCase.deno === "disabled" ? ["deno"] : []),
			],
			// A configured warm file that does not exist: session_start's
			// dominant-language warm-up would otherwise start servers early.
			warmFiles: ["no-such-warm-file.ts"],
		}),
	);
	return workspace;
}

/** Every text block of one request, as one string. */
function requestText(request: PiProviderRequest): string {
	return request
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: JSON.stringify(message.content),
		)
		.join("\n");
}

/**
 * The cascade lines one request carries, in order and with repeats kept.
 *
 * An injected section rides the request it was composed for and not the next
 * one: measured on this provenance, turn 1's request 1 carried the line and
 * request 2 did not, so a request that carries a line is the request that
 * DELIVERED it — no delta against an earlier request is needed, and a repeat
 * on any later request is a second delivery.
 *
 * Repeats inside ONE request are kept for the same reason (#4716 round 3 F7):
 * a message that carries the line twice composed it twice, and de-duplicating
 * here would hide that from every case below. Callers that want one entry per
 * distinct line union the lists themselves.
 */
function cascadeLinesIn(request: PiProviderRequest): string[] {
	const lines: string[] = [];
	for (const line of requestText(request)
		.split("\n")
		.map((entry) => entry.trim())) {
		if (line.includes("Cascade")) lines.push(line);
	}
	return lines;
}

/** The prompt that opens the next turn; one per turn. */
const READ_TURN = "continue";

/**
 * Run `turns` through one real session and return, for each turn, the cascade
 * lines its requests carried.
 *
 * Every write is one scripted reply (at most one tool call per reply, so its
 * result lands before the next one — #4632 s4), and each turn closes with a
 * text-only reply. The read prompt then opens the next turn, and its first
 * request is the one pi-lens's `context_with_system` injection reaches.
 */
async function runTurns(
	testCase: Setup,
	slug: string,
	turns: readonly Turn[],
): Promise<string[][]> {
	const workspace = makeWorkspace(testCase, slug);
	const responses: PiFauxReply[] = [];
	const prompts: Array<{ text: string; turnIndex: number }> = [];
	for (const [turnIndex, writes] of turns.entries()) {
		for (const [name, n] of writes) {
			responses.push(
				step(
					fauxToolCall("write", {
						path: path.join(workspace, `${name}.ts`),
						content: FILES[name](n),
					}),
					`writing ${name}`,
				),
			);
		}
		responses.push(endTurn(`turn ${turnIndex + 1} done`));
		responses.push(endTurn(`read ${turnIndex + 1}`));
		prompts.push(
			{ text: `turn ${turnIndex + 1}`, turnIndex },
			{ text: READ_TURN, turnIndex },
		);
	}
	const session = await startPiSession({
		root: fixture.root,
		cwd: workspace,
		// The tier's defaults leave the language servers off; this claim IS the
		// turn-end line they produce, so the flag is turned off rather than
		// deleted (`false` removes it from the host's flag map, see `flagMap`).
		flags: new Map<string, boolean>([["no-lsp", false]]),
		responses,
	});
	/** Each turn's half-open request range, taken from the session itself. */
	const requestWindows: Array<{ from: number; to: number }> = turns.map(() => ({
		from: -1,
		to: 0,
	}));
	for (const prompt of prompts) {
		// The request boundary comes from the session, never from the prompt's
		// position: one prompt makes several requests (one per tool-call round
		// trip), so a prompt index is not a request index.
		const before = session.requests.length;
		await session.prompt(prompt.text);
		const window = requestWindows[prompt.turnIndex];
		if (!window) throw new Error(`no request window for turn ${prompt.text}`);
		if (window.from < 0) window.from = before;
		window.to = session.requests.length;
	}
	const perRequest = session.requests.map(cascadeLinesIn);
	expect(
		perRequest[0] ?? [],
		"the first request carries no cascade line",
	).toEqual([]);
	expect(session.errors, "every handler resolved").toEqual([]);
	// Delivered ONCE: the line rides one request and no later request carries
	// it again. #4716 round 1 F1/F2: the previous sampling read requests 1, 3
	// and 5 only, so a re-delivery on turn 3 (request 8) was invisible.
	const firstCarrier = perRequest.findIndex((lines) => lines.length > 0);
	const laterCarriers = perRequest.flatMap((lines, index) =>
		index > firstCarrier && lines.length > 0 ? [index] : [],
	);
	expect(
		laterCarriers,
		`no request after the first one that carries a cascade line (request ${firstCarrier}) carries one again`,
	).toEqual([]);
	// Delivered ONCE per line: a request that composes the same section twice
	// carries the line twice, which no request-level rule above can see.
	// #4716 round 3 F7.
	const lineOccurrences = perRequest
		.flat()
		.reduce<Map<string, number>>(
			(counts, line) => counts.set(line, (counts.get(line) ?? 0) + 1),
			new Map<string, number>(),
		);
	expect(
		[...lineOccurrences],
		"every cascade line is delivered exactly once",
	).toEqual([...lineOccurrences.keys()].map((line) => [line, 1]));
	return requestWindows.map(({ from, to }) => {
		const delivered: string[] = [];
		for (let index = from; index < to; index += 1) {
			for (const line of perRequest[index] ?? []) {
				if (!delivered.includes(line)) delivered.push(line);
			}
		}
		return delivered;
	});
}

const previousInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

beforeAll(() => {
	// A server the project config points at is never installed over: the
	// missing-server cases assert the "could not be started" line, which an
	// installer run would replace with an npm failure.
	process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
});

/**
 * One process-global LSP service (`clients/lsp/service-singleton.ts`, keyed on
 * `globalThis`) serves every activation, so the previous case's warm clients
 * and its project's config stay reachable to the next case's session. This is
 * the SAME reset the production `session_start`/`session_shutdown` handlers
 * call; it carries no assertion, and no case reads the service.
 */
afterEach(async () => {
	await getLSPService().shutdown();
	resetLSPService();
});

afterAll(() => {
	if (previousInstall === undefined)
		delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
	else process.env.PI_LENS_DISABLE_LSP_INSTALL = previousInstall;
});

describe("a cascade neighbour no primary answered for, on the real host (#4403 N2)", () => {
	for (const [index, testCase] of CASES.entries()) {
		it(`${testCase.name}: ${testCase.firstTurn.length > 0 ? "one cause-named line, then none" : "no cascade line"}`, async () => {
			// Two writes of b.ts in the first turn: the first run is superseded
			// at turn_end, so the line must ride the second.
			const turns = await runTurns(testCase, `matrix-${index}`, [
				[
					["b", 2],
					["b", 3],
				],
				[["b", 4]],
				[["b", 5]],
			]);
			expect(turns).toEqual([testCase.firstTurn, [], []]);
		}, 180_000);
	}

	// Round 5 (V1): the server is marked once the line is delivered, so a run
	// that turn_end drops does not use the line up, and two runs that name the
	// same server in one turn show it once. typescript missing, deno disabled.
	const SCRIPTS: ReadonlyArray<{
		name: string;
		firstTurn: Turn;
		expected: string[][];
	}> = [
		{
			// b.ts's run is superseded by the write of its neighbour a.ts, so the
			// line must still reach turn 1's own requests (and nothing later).
			name: "b.ts, then its neighbour a.ts",
			firstTurn: [
				["b", 2],
				["a", 2],
			],
			expected: [[UNSTARTED_LINE], [], []],
		},
		{
			// Both runs survive turn_end and both name typescript.
			name: "b.ts and an unrelated e.ts",
			firstTurn: [
				["b", 2],
				["e", 2],
			],
			expected: [[UNSTARTED_LINE], [], []],
		},
	];

	for (const [index, script] of SCRIPTS.entries()) {
		it(`delivers the line once: ${script.name}`, async () => {
			const turns = await runTurns(
				{
					name: script.name,
					typescript: "missing",
					deno: "disabled",
				},
				`script-${index}`,
				[script.firstTurn, [["b", 4]], [["b", 5]]],
			);
			// `runTurns` reports the lines each turn's OWN requests carried; a
			// section does not persist into the next request, so a later request
			// carrying the line again would be a second delivery and `runTurns`
			// refuses it.
			expect(turns).toEqual(script.expected);
		}, 180_000);
	}
});
