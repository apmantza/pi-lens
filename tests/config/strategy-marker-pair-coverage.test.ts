/**
 * Composition census for per-server diagnostic strategy markers (#3491's CI
 * red, 2026-09-26).
 *
 * ## The recurrence this guards
 *
 * Each behaviour marker in `SERVER_DIAGNOSTIC_STRATEGIES`
 * (clients/lsp/wait-policy/strategies.ts) changes how the client treats one
 * server's publishes, and each one ships with its own tests. #3484 marked
 * intelephense `diagnosticsFence: "reply-first"`; intelephense already carried
 * #3310's `emptyFirstPublish: "indexing"`. The fence dropped the empty first
 * publish, the one-shot hold then held the real answer, and three #3310 tests
 * timed out in CI on `b937ff0a9` (run 36213835455). No test drove both markers
 * on one server, so the targeted local runs were green.
 *
 * This census makes the second marker the moment to write that test: every
 * server carrying two behaviour markers names a test that drives both on that
 * server, or an exemption that says why the two never meet. A new pair, a
 * renamed test, or a stale row reds here.
 *
 * What it cannot see: whether the named test actually exercises the
 * interaction. It checks that a test with that title exists as code in the
 * named file and names the server; the reviewer judges the rest.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type DiagnosticStrategy,
	SERVER_DIAGNOSTIC_STRATEGIES,
} from "../../clients/lsp/wait-policy/strategies.js";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** Optional markers that change how one server's publishes are handled. */
export const BEHAVIOUR_MARKERS = [
	"diagnosticsFence",
	"emptyFirstPublish",
	"reopenOnResync",
	"silentOnClean",
	"workspaceIndexing",
] as const satisfies readonly (keyof DiagnosticStrategy)[];

export interface PairTest {
	/** Repo-relative test file. */
	file: string;
	/** The test's title, exactly as its `it`/`it.each` call spells it. */
	title: string;
}

/** `server:markerA+markerB` (sorted) → the test that drives both. */
const PAIR_TESTS: Record<string, PairTest> = {
	"php:diagnosticsFence+emptyFirstPublish": {
		file: "tests/clients/lsp/diagnostics-fence.test.ts",
		title:
			"a fence-dropped $shape on the indexing server leaves the hold spent=$spent",
	},
};

/** `server:markerA+markerB` → why the two markers never meet. */
const PAIR_EXEMPTIONS: Record<string, string> = {
	"marksman:silentOnClean+workspaceIndexing":
		'workspaceIndexing is read only under a runWorkspaceDiagnostics sweepIndexGate (clientScope "all"), and both silentOnClean reads in LSPService.touchFile require clientScope "primary", so no touch reads both.',
};

export function markerPairs(
	table: Record<string, Partial<DiagnosticStrategy>>,
): string[] {
	const pairs: string[] = [];
	for (const server of Object.keys(table).sort()) {
		const strategy = table[server] as Record<string, unknown>;
		const on = BEHAVIOUR_MARKERS.filter(
			(marker) => strategy[marker] !== undefined && strategy[marker] !== false,
		);
		for (let i = 0; i < on.length; i++)
			for (let j = i + 1; j < on.length; j++)
				pairs.push(`${server}:${on[i]}+${on[j]}`);
	}
	return pairs;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function auditPairCoverage(
	pairs: readonly string[],
	tests: Record<string, PairTest>,
	exemptions: Record<string, string>,
	read: (file: string) => string | null,
): string[] {
	const problems: string[] = [];
	const live = new Set(pairs);
	for (const pair of pairs) {
		const tested = Object.hasOwn(tests, pair);
		const exempt = Object.hasOwn(exemptions, pair);
		if (!tested && !exempt)
			problems.push(
				`UNREGISTERED ${pair}: name a test that drives both markers on this server in PAIR_TESTS, or say in PAIR_EXEMPTIONS why they never meet`,
			);
		if (tested && exempt) problems.push(`DOUBLE ${pair}: tested and exempt`);
	}
	for (const pair of [...Object.keys(tests), ...Object.keys(exemptions)])
		if (!live.has(pair))
			problems.push(`STALE ${pair}: no server carries this pair any more`);
	for (const [pair, reason] of Object.entries(exemptions))
		if (reason.trim().length < 40)
			problems.push(`REASONLESS ${pair}: an exemption states why`);
	for (const [pair, { file, title }] of Object.entries(tests)) {
		const source = read(file);
		if (source === null) {
			problems.push(`MISSING ${pair}: ${file} does not exist`);
			continue;
		}
		// Comments blanked, strings kept: the title and the server id must be
		// literals in code, not in a comment.
		const code = stripSource(source, { strings: "keep" });
		const titleCall = new RegExp(`\\(\\s*(["'\`])${escapeRegExp(title)}\\1`);
		if (!titleCall.test(code))
			problems.push(`NO TEST ${pair}: ${file} has no test titled "${title}"`);
		const server = pair.slice(0, pair.indexOf(":"));
		if (!new RegExp(`(["'\`])${escapeRegExp(server)}\\1`).test(code))
			problems.push(`SERVER ${pair}: ${file} never names "${server}"`);
	}
	return problems;
}

function readRepoFile(file: string): string | null {
	const full = path.join(repoRoot, file);
	return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
}

describe("strategy marker pair coverage (#3491)", () => {
	it("every server with two behaviour markers names a test that drives both", () => {
		const table = SERVER_DIAGNOSTIC_STRATEGIES as Record<
			string,
			Partial<DiagnosticStrategy>
		>;
		// Dead-sweep floors: the table and the pair population are real.
		assertNonEmptyScan("strategy table servers", Object.keys(table).length, 10);
		const pairs = markerPairs(table);
		assertNonEmptyScan("strategy marker pairs", pairs.length, 1);

		expect(
			auditPairCoverage(pairs, PAIR_TESTS, PAIR_EXEMPTIONS, readRepoFile),
		).toEqual([]);
	});

	describe("the audit itself", () => {
		const fenceAndHold = {
			php: {
				emptyFirstPublish: "indexing",
				diagnosticsFence: "reply-first",
			},
			yaml: { diagnosticsFence: "reply-first" },
			opengrep: { reopenOnResync: false, diagnosticsFence: "reply-first" },
		} as Record<string, Partial<DiagnosticStrategy>>;
		const pair = "php:diagnosticsFence+emptyFirstPublish";
		const title = "drives the fence and the hold on php";
		const file = "tests/x.test.ts";
		const reads =
			(source: string) =>
			(name: string): string | null =>
				name === file ? source : null;

		it("pairs only servers with two markers set, and ignores a false one", () => {
			expect(markerPairs(fenceAndHold)).toEqual([pair]);
		});

		it("reds the #3491 shape: a second marker on a server with no pair test", () => {
			expect(
				auditPairCoverage([pair], {}, {}, reads("")).map((p) =>
					p.slice(0, p.indexOf(" ")),
				),
			).toEqual(["UNREGISTERED"]);
		});

		it("reds a registered title that is only a comment, or a file that never names the server", () => {
			const tests = { [pair]: { file, title } };
			expect(
				auditPairCoverage(
					[pair],
					tests,
					{},
					reads(`// it("${title}")\nit("other", () => { "php"; });\n`),
				),
			).toEqual([`NO TEST ${pair}: ${file} has no test titled "${title}"`]);
			expect(
				auditPairCoverage(
					[pair],
					tests,
					{},
					reads(`it("${title}", () => { "yaml"; });\n`),
				),
			).toEqual([`SERVER ${pair}: ${file} never names "php"`]);
			expect(
				auditPairCoverage(
					[pair],
					tests,
					{},
					reads(`it.each([1])(\n\t"${title}",\n\t() => { "php"; },\n);\n`),
				),
			).toEqual([]);
		});

		it("reds a stale row, a missing file, and a reasonless exemption", () => {
			expect(
				auditPairCoverage(
					[],
					{ [pair]: { file: "tests/gone.test.ts", title } },
					{ "lua:a+b": "short" },
					reads(""),
				).map((p) => p.slice(0, p.indexOf(" "))),
			).toEqual(["STALE", "STALE", "REASONLESS", "MISSING"]);
		});
	});
});
