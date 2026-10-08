/**
 * Compile-guard for every shipped tree-sitter rule (#884).
 *
 * A rule whose query fails to compile against its grammar is silently dead:
 * `compileQueryBatch` drops it from the batch and `compileRawQuery` returns
 * null, so `runQueryOnFile`/`runQueriesOnFile` report zero matches forever —
 * indistinguishable from "this rule found nothing". #884 found 32 enabled
 * rules in exactly this state. This test compiles every non-disabled rule
 * against its language's real grammar so a newly-broken query fails CI
 * instead of silently returning nothing forever.
 *
 * It sweeps the rule set each language is actually DISPATCHED (
 * `queriesForLanguage`), not the raw loader map, so a rule is also compiled
 * against every grammar that inherits it — the typescript set is handed to tsx,
 * and a rule that compiles against typescript but not tsx is dead on every
 * `.tsx` file with nothing else to notice.
 *
 * KNOWN_BROKEN is the exact list of rules broken at the time #884 was filed
 * (recorded by running this same compile sweep). It exists ONLY so this test
 * can ship before the (in-progress, parallel) rule fixes land — every entry
 * is a rule this test currently expects to FAIL, not an accepted exception.
 * The contract for those follow-up PRs: fix the rule's query, then remove its
 * id from KNOWN_BROKEN in this file. If you don't remove it, the "still
 * broken" assertion below fails once the query starts compiling — the list
 * can only shrink, never grow silently.
 */
import { describe, expect, it } from "vitest";
import { LANGUAGE_TO_GRAMMAR } from "../../clients/grammar-source.js";
import {
	isDisabledQueryFilePath,
	queriesForLanguage,
	TreeSitterQueryLoader,
} from "../../clients/tree-sitter-query-loader.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";

/**
 * Rule ids known to be broken as of #884, keyed by `language:id`. Populated
 * by running the compile sweep in this test against master at the time the
 * issue was filed — do not add new entries without also filing/linking an
 * issue; do not leave entries here once their fix PR lands (the "still
 * broken" assertion enforces this).
 */
const KNOWN_BROKEN = new Set<string>([
	// Empty since the #884 merge train (PRs #897, #898, #900, #901, #903)
	// repaired all 32 rules this list was seeded with. Every shipped rule now
	// compiles; a new entry here requires a linked issue.
]);

/**
 * Languages with tree-sitter query directories but no grammar wasm mapping
 * in LANGUAGE_TO_GRAMMAR (clients/grammar-source.ts). All of their rules are
 * ALSO fully disabled (`<language>-disabled/`), so this is currently a no-op
 * in production — but whether pi-lens should ever add real grammar support
 * for them (vs. keeping them permanently disabled) is an open decision
 * tracked in #884, not something this test should silently paper over.
 */
const LANGUAGES_WITHOUT_GRAMMAR = ["abap", "cobol", "plsql"];

type PrivateCompile = {
	compileRawQuery(
		queryId: string,
		queryStr: string,
		metavars: string[],
		languageId: string,
		postFilter?: string,
		postFilterParams?: unknown,
		// biome-ignore lint/suspicious/noExplicitAny: return shape is an internal compiled-query record
	): Promise<any | null>;
};

describe("tree-sitter rule compile guard (#884)", () => {
	// #4141: CI shard load puts this full cross-grammar sweep above Vitest's
	// 5-second default. The last ten shard-1 runs measured 2.652–4.345s;
	// 18s is approximately 4x the observed p95 without weakening the sweep.
	it("compiles every shipped, non-disabled rule against its grammar (or is a documented, shrinking known-broken exception)", async () => {
		const loader = new TreeSitterQueryLoader();
		const queries = await loader.loadQueries(process.cwd());

		const client = getSharedTreeSitterClient();
		if (!client) throw new Error("shared TreeSitterClient unavailable");
		expect(await client.init()).toBe(true);
		const compile = (client as unknown as PrivateCompile).compileRawQuery.bind(
			client,
		);

		const stillBroken = new Set<string>();
		const uncheckedLanguages = new Set<string>();
		let checked = 0;

		// Sweep the DISPATCHED rule set per language, not the raw loader map: a rule
		// is also run against every language that inherits it (`queriesForLanguage`
		// hands the whole typescript set to tsx), and a rule that compiles against
		// its own grammar but not against an inheriting one is silently dead in
		// exactly the way this guard exists to catch. Union in the loader's own keys
		// so a language with rules but no grammar mapping is still surfaced below.
		const languageKeys = new Set([
			...queries.keys(),
			...Object.keys(LANGUAGE_TO_GRAMMAR),
		]);

		for (const languageKey of languageKeys) {
			const enabled = queriesForLanguage(queries, languageKey);
			if (enabled.length === 0) continue;

			if (!(languageKey in LANGUAGE_TO_GRAMMAR)) {
				uncheckedLanguages.add(languageKey);
				continue;
			}

			for (const query of enabled) {
				checked++;
				const key = `${languageKey}:${query.id}`;
				const compiled = await compile(
					query.id,
					query.query,
					query.metavars,
					languageKey,
					query.post_filter,
					query.post_filter_params,
				);

				if (compiled === null) {
					stillBroken.add(key);
					if (!KNOWN_BROKEN.has(key)) {
						expect.fail(
							`${key} failed to compile against its grammar and is NOT in KNOWN_BROKEN. ` +
								`Either this is a newly-broken rule (fix the query), or it's a legitimate ` +
								`cross-grammar skip (e.g. a shared rule set that doesn't apply to every ` +
								`language it's loaded for) that needs a KNOWN_BROKEN entry with an explanation.`,
						);
					}
				} else if (KNOWN_BROKEN.has(key)) {
					expect.fail(
						`${key} is listed in KNOWN_BROKEN but now compiles cleanly — remove its entry ` +
							`from KNOWN_BROKEN in tests/clients/tree-sitter-rule-compile-guard.test.ts. ` +
							`The list only shrinks as fix PRs land (refs #884).`,
					);
				}
			}
		}

		// Sanity: we actually exercised rules, and every KNOWN_BROKEN entry
		// corresponds to a rule we saw (no stale ids referring to renamed/
		// removed/re-enabled rules that this run never touched).
		expect(checked).toBeGreaterThan(0);
		for (const key of KNOWN_BROKEN) {
			expect(stillBroken.has(key)).toBe(true);
		}

		// Languages present in the query loader but outside LANGUAGE_TO_GRAMMAR
		// should be exactly the fully-disabled ones — surfaced here instead of
		// silently skipped, so a language gaining a real (enabled) rule set
		// without a grammar mapping doesn't slip past this guard unnoticed.
		expect([...uncheckedLanguages].sort()).toEqual([]);
	}, 18_000);

	it("documents languages with rule directories but no grammar mapping (#884 open decision)", async () => {
		const loader = new TreeSitterQueryLoader();
		const queries = await loader.loadQueries(process.cwd());

		for (const languageKey of LANGUAGES_WITHOUT_GRAMMAR) {
			expect(languageKey in LANGUAGE_TO_GRAMMAR).toBe(false);
			const langQueries = queries.get(languageKey) ?? [];
			const enabled = langQueries.filter(
				(q) => !isDisabledQueryFilePath(q.filePath),
			);
			// Every rule under these languages is currently shipped disabled —
			// that's the reason the first test above never has to skip a language
			// with live rules. If this ever goes non-zero, #884's open question
			// (add a grammar mapping, or leave these disabled for good) needs an
			// answer before the rules can ship enabled.
			expect(enabled.length).toBe(0);
		}
	});
});
