/**
 * #2423 acceptance 3 — `ast_grep_replace apply:true` records through the seam.
 *
 * `--update-all` rewrites files on disk with no `tool_result` describing it, so
 * pi-lens's OWN tool was as invisible to the mutation bookkeeping as any
 * third-party one: no read-guard stamp, no turn state, no deferred format.
 *
 * This file imports nothing new. It mounts a capture bridge under the public
 * `Symbol.for("pi-lens:mutation-bridge")` key exactly the way a co-process
 * extension would read it, so the assertion below fails on pre-fix code rather
 * than on a missing module.
 */
import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { AstGrepClient } from "../../clients/ast-grep-client.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import type { LineageHandle } from "../../clients/session-scope.js";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";

const MUTATION_BRIDGE_KEY = Symbol.for("pi-lens:mutation-bridge");

type Recorded = {
	filePath: string;
	kind: string;
	editRanges?: [number, number][];
	consumer?: string;
	provenance?: string;
	toolCallId?: string;
	lineage?: LineageHandle;
};

const recorded: Recorded[] = [];

Object.defineProperty(globalThis, MUTATION_BRIDGE_KEY, {
	value: Object.freeze({
		version: 1 as const,
		recordMutation(entry: Recorded): boolean {
			recorded.push(entry);
			return true;
		},
	}),
	writable: false,
	configurable: false,
	enumerable: false,
});

function clientWithExec(exec: (args: string[]) => unknown): AstGrepClient {
	const client = new AstGrepClient();
	(client as unknown as { runner: { exec: typeof exec } }).runner = { exec };
	return client;
}

/**
 * ast-grep reports 0-based lines. The two matches below sit on source lines 5
 * and 21, so a correct record carries `[[5, 5], [21, 21]]`.
 */
const MATCHES = [
	{
		file: "src/a.ts",
		range: { start: { line: 4, column: 0 }, end: { line: 4, column: 5 } },
		text: "var x",
	},
	{
		file: "src/a.ts",
		range: { start: { line: 20, column: 0 }, end: { line: 20, column: 5 } },
		text: "var y",
	},
	{
		file: "src/b.ts",
		range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
		text: "var z",
	},
];

function execFor(matches: typeof MATCHES) {
	return vi.fn(async (args: string[]) => {
		if (args.includes("--update-all"))
			return { matches: [], totalMatches: 0, truncated: false };
		return { matches, totalMatches: matches.length, truncated: false };
	});
}

describe("#2423 ast_grep_replace records its applied rewrites", () => {
	it("records one mutation per rewritten file, with 1-based ranges", async () => {
		recorded.length = 0;
		const client = clientWithExec(execFor(MATCHES));

		const result = await client.replace(
			"var $X",
			"let $X",
			"typescript",
			["src"],
			true,
		);

		expect(result.applied).toBe(true);
		expect(recorded).toHaveLength(2);
		expect(recorded[0]).toMatchObject({
			filePath: path.resolve(process.cwd(), "src/a.ts"),
			kind: "edit",
			consumer: "ast_grep_replace",
			editRanges: [
				[5, 5],
				[21, 21],
			],
		});
		expect(recorded[1]).toMatchObject({
			filePath: path.resolve(process.cwd(), "src/b.ts"),
			kind: "edit",
			editRanges: [[1, 1]],
		});
	});

	it("records nothing for a dry run", async () => {
		recorded.length = 0;
		const client = clientWithExec(execFor(MATCHES));
		await client.replace("var $X", "let $X", "typescript", ["src"], false);
		expect(recorded).toHaveLength(0);
	});

	it("records nothing when the stale-preview check finds no matches", async () => {
		recorded.length = 0;
		const client = clientWithExec(execFor([]));
		const result = await client.replace(
			"var $X",
			"let $X",
			"typescript",
			["src"],
			true,
		);
		expect(result.stalePreview).toBe(true);
		expect(recorded).toHaveLength(0);
	});
});

/**
 * #4140 (F9 of #4185 round 1): the structural apply (`replaceWithRule`, the
 * `insideKind`/`hasKind`/`follows` options) rewrites files with `--update-all`
 * through `tempScanWithFixAsync` and never reached the bridge: no stamp, no
 * turn state, no deferred format, whatever the path spelling. The runner is
 * the ast-grep process boundary; the matches it reports before the write are
 * the ones recorded, as in the pattern apply.
 */
describe("#4140 the structural ast_grep_replace apply records through the bridge", () => {
	const RULE =
		"id: agent-rule\nlanguage: typescript\nrule:\n  pattern: var $X\nfix: let $X\n";
	function clientWithRunner(matches: typeof MATCHES): {
		client: AstGrepClient;
		runner: { tempScanWithFixAsync: ReturnType<typeof vi.fn> };
	} {
		const runner = {
			tempScanDetailedAsync: vi.fn(async () => ({ matches, status: 0 })),
			tempScanWithFixAsync: vi.fn(async () => ({ matches })),
		};
		const client = new AstGrepClient();
		(client as unknown as { runner: unknown }).runner = runner;
		return { client, runner };
	}

	it("records one mutation per rewritten file with 1-based ranges, like the pattern apply", async () => {
		recorded.length = 0;
		const { client, runner } = clientWithRunner(MATCHES);
		const result = await client.replaceWithRule(RULE, ["src"], true);
		expect(result.applied).toBe(true);
		expect(runner.tempScanWithFixAsync).toHaveBeenCalledWith(
			"src",
			"agent-rule",
			RULE,
			true,
		);
		expect(recorded).toEqual([
			expect.objectContaining({
				filePath: path.resolve(process.cwd(), "src/a.ts"),
				kind: "edit",
				consumer: "ast_grep_replace",
				editRanges: [
					[5, 5],
					[21, 21],
				],
			}),
			expect.objectContaining({
				filePath: path.resolve(process.cwd(), "src/b.ts"),
				kind: "edit",
				editRanges: [[1, 1]],
			}),
		]);
	});

	it("records nothing for a structural dry run", async () => {
		recorded.length = 0;
		const { client } = clientWithRunner(MATCHES);
		const result = await client.replaceWithRule(RULE, ["src"], false);
		expect(result.applied).toBe(false);
		expect(recorded).toHaveLength(0);
	});
});

/**
 * #3763 item 4: the bridge fences a replay by the lineage its producer
 * captured (S3), and an entry without one stays fail-open. ast_grep_replace
 * sent none, so an apply that finished after `/new` stamped, listed and
 * queued session 1's rewrite in session 2. The recurrence: a producer that
 * records without the session it was called in, or captures it only after
 * its first await (the apply spawn), when it is already the next session's.
 */
describe("#3763 ast_grep_replace records under the session it was called in", () => {
	it("tags every rewritten file with the scope captured before its first await", async () => {
		recorded.length = 0;
		const runtime = new RuntimeCoordinator();
		const entered = runtime.captureSessionGeneration();
		const client = clientWithExec(execFor(MATCHES));
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		vi.spyOn(client, "formatMatches").mockReturnValue("");
		const tool = createAstGrepReplaceTool(client, () =>
			runtime.captureSessionGeneration(),
		);

		const run = tool.execute(
			"call-3763-ast-grep",
			{ pattern: "var $X", rewrite: "let $X", lang: "typescript", apply: true },
			new AbortController().signal,
			undefined,
			{ cwd: "." },
		);
		// `/new` while the call awaits its first spawn: the preview, the apply
		// and the record all land after it.
		runtime.resetForSession();
		await run;

		expect(
			recorded.map((entry) => ({
				scopeId: entry.lineage?.scopeId,
				current: entry.lineage?.isCurrent(),
			})),
		).toEqual([
			{ scopeId: entered.scopeId, current: false },
			{ scopeId: entered.scopeId, current: false },
		]);
	});
});

// #4187 R4-1, R4-3 (T5): `--update-all` rewrites files no `tool_result`
// describes, so this record is the write's only evidence. The read guard
// advances the authorship of a file the call NAMED only when the entry says it
// was observed and names that call: without `provenance` the record can only
// end an authorship (the file the agent wrote costs a re-read), and without
// `toolCallId` it cannot be licensed at all. The guard half of the rule, and
// the folder/project-wide applies that must advance nothing, are pinned by
// tests/clients/runtime-tool-call.test.ts.
describe("#4187 R4-1 ast_grep_replace's apply record names its call", () => {
	it("sends provenance observed and the tool call id it ran under", async () => {
		recorded.length = 0;
		const runtime = new RuntimeCoordinator();
		const client = clientWithExec(execFor(MATCHES));
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		vi.spyOn(client, "formatMatches").mockReturnValue("");
		const tool = createAstGrepReplaceTool(client, () =>
			runtime.captureSessionGeneration(),
		);

		await tool.execute(
			"call-4187-ast-grep",
			{
				pattern: "var $X",
				rewrite: "let $X",
				lang: "typescript",
				paths: ["src"],
				apply: true,
			},
			new AbortController().signal,
			undefined,
			{ cwd: "." },
		);

		expect(recorded.length).toBeGreaterThan(0);
		for (const entry of recorded)
			expect(entry).toMatchObject({
				consumer: "ast_grep_replace",
				provenance: "observed",
				toolCallId: "call-4187-ast-grep",
			});
	});
});
