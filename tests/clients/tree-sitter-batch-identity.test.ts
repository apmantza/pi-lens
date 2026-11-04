/**
 * #5260: the identity a combined query batch is cached under.
 *
 * Recurrence (red on origin/master f11775b35): the identity hashed the whole
 * rule object, so the loader's full object and the RuleCache's projection of
 * the same rule (no description, tags, category, cwe, owasp, confidence) got
 * two batches, and the second dispatch recompiled. The identity now ignores
 * those fields (documentation no result consumer reads) and the order the
 * keys were written in.
 *
 * Invalidation rule, one test per axis: a new batch is built when the
 * language id, a rule's query text, or any field the results carry (message,
 * severity, metavars, post-filter, ...) changes. The grammar axis is the
 * client instance: `languages` is set once per language per client and never
 * replaced, so a batch cannot outlive the grammar it compiled against; a
 * second client loads its own grammar and builds its own batch.
 *
 * Every test drives a real client, real grammars and real compiled queries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";
import {
	_resetSharedTreeSitterClientForTests,
	getSharedTreeSitterClient,
} from "../../clients/tree-sitter-shared.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
// Each case gets a fresh warmed shared client, so its batch cache starts empty
// and its build counts are its own. Real grammar and rule tests use the warmed
// shared client (docs/invariants/caches-stores.md; Greptile on #5278).
beforeEach(() => _resetSharedTreeSitterClientForTests());
afterEach(() => {
	vi.restoreAllMocks();
	_resetSharedTreeSitterClientForTests();
	while (cleanups.length) cleanups.pop()?.();
});

const SOURCE = "function alpha(a: number) { return a; }\nconst b = alpha(1);\n";

const full = (id: string, query: string): TreeSitterQuery => ({
	id,
	name: id,
	severity: "warning",
	category: "slop",
	language: "typescript",
	message: `${id} message`,
	description: "long documentation text",
	tags: ["typescript", "slop"],
	cwe: ["CWE-1"],
	owasp: ["A01"],
	confidence: "high",
	query,
	metavars: [],
	has_fix: false,
	filePath: `rules/${id}.yml`,
});

/** What RuleCache persists and hands back (runners/tree-sitter.ts). */
const projected = (def: TreeSitterQuery): TreeSitterQuery =>
	({
		id: def.id,
		name: def.name,
		severity: def.severity,
		language: def.language,
		message: def.message,
		query: def.query,
		metavars: def.metavars,
		has_fix: def.has_fix ?? false,
		filePath: def.filePath ?? "",
	}) as TreeSitterQuery;

const RULES = [
	full("calls", "(call_expression) @CALL"),
	full("functions", "(function_declaration) @FN"),
];

async function liveClient(
	client: TreeSitterClient | null = getSharedTreeSitterClient(),
): Promise<{
	client: TreeSitterClient;
	file: string;
	builds: ReturnType<typeof vi.spyOn>;
}> {
	if (!client) throw new Error("tree-sitter unavailable");
	const env = setupTestEnvironment("pi-lens-batch-identity-");
	cleanups.push(env.cleanup);
	const file = createTempFile(env.tmpDir, "a.ts", SOURCE);
	expect(await client.init()).toBe(true);
	const builds = vi.spyOn(
		client as unknown as {
			compileQueryBatchOnce: (...args: unknown[]) => Promise<unknown>;
		},
		"compileQueryBatchOnce",
	);
	return { client, file, builds };
}

describe("tree-sitter batch identity (#5260)", () => {
	it("serves one batch for the loader's rules and the cache's projection of them", async () => {
		const { client, file, builds } = await liveClient();
		const fromLoader = await client.runQueriesOnFile(RULES, file, "typescript");
		const fromCache = await client.runQueriesOnFile(
			RULES.map(projected),
			file,
			"typescript",
		);
		expect(builds).toHaveBeenCalledTimes(1);
		expect(fromCache.map((r) => [r.queryDef.id, r.match.line])).toEqual(
			fromLoader.map((r) => [r.queryDef.id, r.match.line]),
		);
		expect(fromLoader.length).toBeGreaterThan(0);
	});

	it("serves one batch whatever order the rule keys were written in", async () => {
		const { client, file, builds } = await liveClient();
		await client.runQueriesOnFile(RULES, file, "typescript");
		const reordered = RULES.map(
			(def) =>
				Object.fromEntries(
					Object.entries(def).reverse(),
				) as unknown as TreeSitterQuery,
		);
		await client.runQueriesOnFile(reordered, file, "typescript");
		expect(builds).toHaveBeenCalledTimes(1);
	});

	it("builds a new batch when a rule's query text changes (query-source axis)", async () => {
		const { client, file, builds } = await liveClient();
		const before = await client.runQueriesOnFile(RULES, file, "typescript");
		const edited = [RULES[0], full("functions", "(identifier) @FN")];
		const after = await client.runQueriesOnFile(edited, file, "typescript");
		expect(builds).toHaveBeenCalledTimes(2);
		const lines = (rows: typeof before, id: string) =>
			rows.filter((r) => r.queryDef.id === id).length;
		expect(lines(after, "functions")).not.toBe(lines(before, "functions"));
	});

	it("builds a new batch when a field the results carry changes (message, severity)", async () => {
		const { client, file, builds } = await liveClient();
		await client.runQueriesOnFile(RULES, file, "typescript");
		const reworded = [{ ...RULES[0], message: "new message" }, RULES[1]];
		const rows = await client.runQueriesOnFile(reworded, file, "typescript");
		expect(builds).toHaveBeenCalledTimes(2);
		expect(rows.find((r) => r.queryDef.id === "calls")?.queryDef.message).toBe(
			"new message",
		);
		await client.runQueriesOnFile(
			[{ ...reworded[0], severity: "error" }, RULES[1]],
			file,
			"typescript",
		);
		expect(builds).toHaveBeenCalledTimes(3);
	});

	it("builds a batch per language for the same rules (language axis)", async () => {
		const { client, file, builds } = await liveClient();
		await client.runQueriesOnFile(RULES, file, "typescript");
		await client.runQueriesOnFile(RULES, file, "tsx");
		expect(builds).toHaveBeenCalledTimes(2);
		await client.runQueriesOnFile(RULES, file, "tsx");
		expect(builds).toHaveBeenCalledTimes(2);
	});

	it("builds its own batch per client, which loads its own grammar (grammar axis)", async () => {
		// The second client is the isolation check: the shared client and a
		// fresh one each hold their own grammar and batch cache.
		const first = await liveClient();
		const second = await liveClient(new TreeSitterClient());
		await first.client.runQueriesOnFile(RULES, first.file, "typescript");
		await second.client.runQueriesOnFile(RULES, second.file, "typescript");
		expect(first.builds).toHaveBeenCalledTimes(1);
		expect(second.builds).toHaveBeenCalledTimes(1);
	});
});
