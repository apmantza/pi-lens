/**
 * Tree-sitter Query Loader
 *
 * Loads tree-sitter queries from YAML files in rules/tree-sitter-queries/
 * and provides them to the TreeSitterClient.
 */

import { logTreeSitterDiagnostic } from "./tree-sitter-logger.js";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import {
	type BundledResourceHealth,
	classifyBundledResourceDir,
	reportBundledResourceDirHealth,
} from "./bundled-resource-health.js";
import {
	getDegradationLedgerGeneration,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import yaml from "./deps/js-yaml.js";
import { resolvePackagePath } from "./package-root.js";
import {
	getUserRuleRoot,
	ruleCorpusFingerprintForCycle,
} from "./custom-rule-locations.js";
import { compareOrdinal } from "./string-utils.js";

/**
 * The bundled `rules/tree-sitter-queries` root — the ONE spelling of this
 * path, imported by `clients/cache/rule-cache.ts` (re-exported there as
 * `BUNDLED_RULES_ROOT`, #2636 review F4) rather than computed a second time,
 * so the "one ledger row, not two" claim for `tree-sitter-queries-dir-missing`
 * rests on reference equality, not merely two independently-resolved strings
 * that happen to match.
 */
export const BUNDLED_QUERIES_ROOT = resolvePackagePath(
	import.meta.url,
	"rules",
	"tree-sitter-queries",
);

let cachedBundledQueriesRootHealth: BundledResourceHealth | undefined;
let cachedBundledQueriesRootHealthGeneration: number | undefined;

/**
 * #2636 review F6/round-2 F3: memoized, but keyed on the degradation
 * ledger's OWN generation counter (bumped by `resetDegradationLedger`, wired
 * into `handleSessionStart`) rather than "compute once, forever" — round 1's
 * version overclaimed that the underlying fact "cannot change mid-process
 * any more than the package's own install location can", but a managed
 * extension cache RELOCATING a live install mid-process is exactly the
 * failure #2587/#2626 investigated: a permanently-cached "absent" verdict
 * from the FIRST probe would never notice the directory coming back (or
 * disappearing later), the same silent-zero shape this issue exists to end.
 * Re-probing once per SESSION (not once per call) is the right middle
 * ground: a real, measured `readdirSync` cost (4.2 µs) is paid once per
 * session rather than on every dispatched file — same generation-keyed
 * pattern `clients/ast-grep-client.ts`'s `ensureRulesHealthReported` uses
 * for its own per-instance re-check.
 */
export function getBundledQueriesRootHealth(): BundledResourceHealth {
	const generation = getDegradationLedgerGeneration();
	if (
		cachedBundledQueriesRootHealth === undefined ||
		cachedBundledQueriesRootHealthGeneration !== generation
	) {
		cachedBundledQueriesRootHealthGeneration = generation;
		cachedBundledQueriesRootHealth =
			classifyBundledResourceDir(BUNDLED_QUERIES_ROOT);
	}
	return cachedBundledQueriesRootHealth;
}

/** Test-only: clear the memo so a scenario can simulate a different install layout. */
export function _resetBundledQueriesRootHealthForTests(): void {
	cachedBundledQueriesRootHealth = undefined;
	cachedBundledQueriesRootHealthGeneration = undefined;
}

export function isDisabledQueryDirectoryName(name: string): boolean {
	return name.endsWith("-disabled");
}

export function getQueryLanguageKey(directoryName: string): string {
	return isDisabledQueryDirectoryName(directoryName)
		? directoryName.slice(0, -"-disabled".length)
		: directoryName;
}

/**
 * Languages that inherit the typescript rule set on top of their own.
 *
 * ONLY `tsx`: verified rule-for-rule identical on the same source parsed under
 * both grammars (console-statement 16/16, ts-path-traversal 277/277, …), which
 * makes sense — tsx IS typescript plus JSX. `javascript` is deliberately NOT
 * here. It looks like it should be, and the merge existed for years, but the
 * queries were compiled against the typescript grammar and run against
 * javascript trees, so they matched nothing and nobody noticed. Compiled
 * correctly they misfire: JS parameters are bare `(identifier)` where
 * typescript has `required_parameter`, so `duplicate-function-arg` alone
 * reports 59 phantom duplicates across 60 files. Re-enabling it needs the
 * typescript rules validated against the javascript grammar first.
 */
const TYPESCRIPT_RULE_HEIRS = new Set(["tsx"]);

/**
 * The rule-source languages whose directories make up the effective rule set
 * for a file parsed as `languageId`. This is the SINGLE SOURCE OF TRUTH for
 * rule-set composition: `queriesForLanguage` (selection) and
 * `ruleFilesForLanguage` (the RuleCache fingerprint, #878) both derive from
 * it, so the cache key can never drift from the rules the runner actually runs.
 */
export function ruleSourceLanguages(languageId: string): string[] {
	return TYPESCRIPT_RULE_HEIRS.has(languageId)
		? [languageId, "typescript"]
		: [languageId];
}

/**
 * Every rule file contributing to the effective rule set for `languageId`,
 * from BOTH the project's own `rules/tree-sitter-queries/` tree and the
 * bundled built-ins, across every rule-source language.
 *
 * The dispatch runner hashes this list into the RuleCache key. Fingerprinting
 * only the language's OWN directory missed inherited rule sets — tsx runs the
 * typescript rules too, so editing a typescript rule never invalidated the tsx
 * cache and stale compiled rules kept firing until the process restarted or a
 * tsx rule happened to change (#878).
 */
export function ruleFilesForLanguage(
	languageId: string,
	rootDir = process.cwd(),
): string[] {
	const resolvedRoot = path.resolve(rootDir);
	const files = new Set<string>();
	for (const lang of ruleSourceLanguages(languageId)) {
		for (const dir of [
			path.join(resolvedRoot, "rules", "tree-sitter-queries", lang),
			path.join(getUserRuleRoot(), "tree-sitter-queries", lang),
			path.join(BUNDLED_QUERIES_ROOT, lang),
		]) {
			if (!fs.existsSync(dir)) continue;
			for (const f of fs.readdirSync(dir)) {
				if (f.endsWith(".yml")) files.add(path.join(dir, f));
			}
		}
	}
	// #2636 (review F2): a language resolving zero files here is NORMAL when
	// nobody has authored bundled/project queries for it — seven REACHABLE
	// grammars have none by design: bash, dart, elixir, lua, ocaml, swift, zig
	// (`.sh`/`.bash`, `.dart`, `.ex`/`.exs`, `.lua`, `.ml`/`.mli`, `.swift`,
	// `.zig` — see `language-registry.ts`'s `EXTENSION_TO_GRAMMAR`). cobol and
	// plsql are NOT in that registry at all — only their `-disabled` query
	// directories exist — so `ruleFilesForLanguage` never actually resolves
	// those two languageIds in production; they are not examples of this
	// case. A BUG looks identical from an empty `files` set alone: the
	// bundled root itself relocated out from under the package (same
	// managed-cache-relocation shape #2626 fixed for skills/). Only pay for
	// the extra classification in this COLD branch (never on the common,
	// non-empty path), key it on the shared ROOT rather than this call's
	// `languageId` (every language hitting an actually-missing root collapses
	// into the SAME ledger row instead of one per language), and only RECORD
	// when the root is actually unhealthy — one of the seven by-design-empty
	// languages is touched routinely (any `.sh`/`.lua` edit).
	//
	// #2636 review round 2, F2: NO separate phase/latency row here (unlike
	// the ast-grep/skills sibling sites, which log one PER CONSTRUCTION or
	// PER REQUEST — a bounded cardinality). This branch runs on EVERY
	// dispatched file while the root stays broken (AGENTS.md's "no raw
	// per-occurrence log for repeats"): 200 touches of a by-design-empty
	// language against a broken root would otherwise write 200 raw
	// `latency.log` rows. `reportBundledResourceDirHealth`'s
	// `incrementDegradationCount` already answers "did this run" AND "how
	// many times" in a BOUNDED way — one row per session at count 1, then
	// only at power-of-two milestones (1, 2, 4, 8, … so 200 occurrences write
	// exactly 8 durable rows) — so a second, unbounded record here would add
	// nothing the ledger row lacks.
	if (files.size === 0) {
		const health = getBundledQueriesRootHealth();
		if (health.status !== "healthy") {
			reportBundledResourceDirHealth(
				"tree-sitter-queries-dir-missing",
				BUNDLED_QUERIES_ROOT,
				health,
				"bundled tree-sitter query rules",
			);
		}
	}
	return [...files];
}

/**
 * Content fingerprint for the effective tree-sitter rule set. This is the
 * DISK RuleCache identity (cross-process): it content-hashes the mutable
 * rule files (project + user roots), because a rule edit that preserves both
 * mtime and size (a same-length tweak, a checkout that restores timestamps)
 * must not replay a stale compiled set from disk under the still-matching
 * fingerprint (#1118, the v7 bump). Bundled files are immutable within a
 * process, so mtime+size is sufficient for them (#2636-era invariant, same
 * standing as `bundledSnapshots` in `clients/sgconfig.ts`).
 *
 * The in-process loader memo does NOT call this on its warm path. #4212 round
 * 2 did exactly that and re-walked and re-hashed the whole corpus on EVERY warm
 * call (100 warm `loadQueries` calls measured 134.98 ms vs master's 18.03).
 * The loader gates its memo on `computeMutableRuleFingerprint` instead — the
 * same content-hash strength over a smaller population (the two mutable roots,
 * never the bundled one), computed at most once per dispatch cycle by
 * `ruleCorpusFingerprintForCycle`. This helper stays the DISK identity: it is
 * what `RuleCache` re-derives per dispatched file, so a miss there forces a
 * reload no in-process memo can suppress.
 */
export function computeRuleFilesFingerprint(ruleFiles: string[]): string {
	const hash = crypto.createHash("sha256");
	for (const file of [...ruleFiles].sort(compareOrdinal)) {
		const resolved = path.resolve(file);
		if (!fs.existsSync(resolved)) continue;
		const stat = fs.statSync(resolved);
		hash.update(`${file}:${stat.mtimeMs}:${stat.size}`);
		if (
			resolved !== BUNDLED_QUERIES_ROOT &&
			!resolved.startsWith(BUNDLED_QUERIES_ROOT + path.sep)
		) {
			hash.update(fs.readFileSync(resolved));
		}
	}
	return hash.digest("hex").slice(0, 16);
}

/**
 * Content fingerprint of the MUTABLE tree-sitter rule corpus — the project
 * root's `rules/tree-sitter-queries/` and the user-level root — used to gate
 * the in-process loader memo. It walks those two roots and content-hashes each
 * `.yml` file's path and bytes; it never touches the bundled root (immutable
 * per process; the dispatch-side RuleCache v7 fingerprint above still observes
 * bundled-file metadata on every dispatched file, and the bundled health seam
 * reports relocation per session).
 *
 * Content rather than stat, because #4212 round 3's stat-only signature
 * (path + mtime + size) demonstrably missed an in-place same-length rewrite
 * whose mtime was restored with `touch`: the round-3 verify wrote `AAAA` →
 * `BBBB`, restored the nanosecond mtime, and the next no-`force` load still
 * returned `AAAA`. Bytes cannot be forged that way.
 *
 * It runs at most once per dispatch cycle — `ruleCorpusFingerprintForCycle`
 * memoizes it on the turn identity — because per-call is what rounds 2 and 3
 * each measured as a regression. The consequence, stated plainly: a rule edit
 * made DURING a cycle is seen by the next cycle, or earlier by any dispatch
 * (whose `force: true` recomputes and republishes into this cycle).
 */
function computeMutableRuleFingerprint(rootDir: string): string {
	const files: string[] = [];
	for (const queriesDir of [
		path.join(path.resolve(rootDir), "rules", "tree-sitter-queries"),
		path.join(getUserRuleRoot(), "tree-sitter-queries"),
	]) {
		if (!fs.existsSync(queriesDir)) continue;
		let languages: fs.Dirent[];
		try {
			languages = fs.readdirSync(queriesDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const language of languages) {
			if (!language.isDirectory()) continue;
			let names: string[];
			try {
				names = fs.readdirSync(path.join(queriesDir, language.name));
			} catch {
				continue;
			}
			for (const name of names) {
				if (name.endsWith(".yml")) {
					files.push(path.join(queriesDir, language.name, name));
				}
			}
		}
	}
	const hash = crypto.createHash("sha256");
	for (const filePath of files.sort(compareOrdinal)) {
		hash.update(filePath);
		hash.update("\0");
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			// Vanished between the listing and the read (editor churn): the
			// sentinel still perturbs the fingerprint, so this cycle reloads
			// instead of serving a memo built from a different corpus.
			hash.update("missing");
			hash.update("\0");
			continue;
		}
		hash.update(content);
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 16);
}

/**
 * The rule set that applies to a file parsed as `languageId`, in a stable order.
 *
 * Excludes `<language>-disabled/` rules. `getQueriesForLanguage` filtered these
 * for the per-edit runner, but the project scanner read the raw loader map and
 * ran them anyway — 1,936 of a scan's 2,590 tree-sitter findings came from
 * rules somebody had explicitly switched off.
 */
export function queriesForLanguage(
	queries: Map<string, TreeSitterQuery[]>,
	languageId: string,
): TreeSitterQuery[] {
	const enabled = (langId: string): TreeSitterQuery[] =>
		(queries.get(langId) ?? []).filter(
			(q) => !isDisabledQueryFilePath(q.filePath),
		);
	return ruleSourceLanguages(languageId).flatMap((langId) => enabled(langId));
}

/**
 * Coerce a parsed YAML scalar to a string, refusing a mapping or array.
 * `String({})`/`String([])` silently produce the literal text
 * `"[object Object]"`/`"a,b"` — SonarCloud typescript:S6551 flagged this at
 * every scalar field in `parseQueryFile` once `parseYaml` widened to
 * `Record<string, unknown>` (#3054 review F2). Returns `undefined` for
 * `null`/`undefined`/a non-scalar so call sites keep using `||`/`??` for
 * defaults exactly as the old `String(x || fallback)` calls did.
 */
function str(value: unknown): string | undefined {
	return typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
		? String(value)
		: undefined;
}

export function isDisabledQueryFilePath(filePath: string): boolean {
	const normalized = filePath.replaceAll("\\", "/");
	const parts = normalized.split("/").filter(Boolean);
	const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
	return isDisabledQueryDirectoryName(parent);
}

export interface TreeSitterQuery {
	id: string;
	name: string;
	severity: "error" | "warning" | "info";
	category: string;
	language: string;
	message: string;
	description?: string;
	query: string;
	metavars: string[];
	post_filter?: string;
	post_filter_params?: Record<string, unknown>;
	/**
	 * Native tree-sitter predicates for filtering (#eq?, #match?)
	 * These run in WASM and are faster than post-filters
	 */
	predicates?: Array<{
		type: "eq" | "match" | "any-of";
		var: string;
		value: string | string[];
	}>;
	tags?: string[];
	cwe?: string[];
	owasp?: string[];
	confidence?: "low" | "medium" | "high";
	defect_class?: string;
	inline_tier?: "blocking" | "warning" | "review";
	/**
	 * Skip this rule on test files (isTestFile). For advisories that are noise in
	 * tests — e.g. `python-assert-production`: `assert` is the idiomatic test
	 * assertion, so firing there just trains users to ignore the rule (#440).
	 * The tree-sitter runner otherwise runs on test files (structural issues
	 * matter there), so this is a deliberate per-rule carve-out.
	 */
	skip_test_files?: boolean;
	/**
	 * Skip this rule on files whose path (relative to the project root,
	 * forward-slashed) matches any of these glob patterns — e.g. a
	 * `scripts` directory glob plus a `logger.ts` basename glob for a
	 * debug-output rule that's expected to fire in CLI entry points and the
	 * logging sink itself (#965). Same shape/matching as the ast-grep YAML
	 * rule `ignores` field (`clients/dispatch/runners/yaml-rule-parser.ts`)
	 * — kept as a separate opt-in field (not reusing `skip_test_files`'s
	 * boolean) since "is a test file" and "is a CLI script / logger" are
	 * unrelated axes a rule may need independently.
	 */
	ignore_paths?: string[];
	has_fix: boolean;
	fix_action?: string;
	examples?: {
		bad?: string;
		good?: string;
	};
	filePath: string;
}

export class TreeSitterQueryLoader {
	private queries: Map<string, TreeSitterQuery[]> = new Map();
	private loaded = false;
	private loadedRoot: string | null = null;
	private loadedRuleFingerprint: string | null = null;
	private verbose: boolean;
	/**
	 * This root's per-file parse failures, remembered across the memoized
	 * (no-`force`) `loadQueries` path so a later session's ledger can carry
	 * the same row without re-parsing every file (#3070 N1).
	 */
	private readonly parseFailures = new Map<string, string>();
	/**
	 * Generation (`getDegradationLedgerGeneration()`) at which `parseFailures`
	 * was last replayed into the ledger — the same generation-keyed memo
	 * idiom `getBundledQueriesRootHealth` above uses, applied here so a
	 * memoized `loadQueries` return still re-arms `recordDegradationOnce` once
	 * per session rather than only in the session that actually parsed.
	 */
	private parseFailuresReplayedGeneration: number | undefined;

	constructor(verbose = false) {
		this.verbose = verbose;
	}

	/** Debug logging helper */
	private dbg(msg: string): void {
		if (this.verbose) {
			// #1333: verbose gate preserved, sink moved to tree-sitter.log.
			logTreeSitterDiagnostic({
				subsystem: "query-loader",
				level: "debug",
				message: msg,
			});
		}
	}

	/**
	 * One degradation-ledger record per malformed rule file per session
	 * (#3054 review F1). The old hand-rolled scanner tolerated almost any
	 * line-level mistake and still produced SOME parsed shape; `yaml.load`
	 * correctly throws on realistic authoring mistakes the scanner shrugged
	 * off (a colon in an unquoted scalar, a tab in list indentation, a
	 * duplicate key, an unclosed quote, a bare `@` value — fuzzed over 800
	 * corruptions of one shipped query: 139 that loaded before now skip, 0
	 * the other way). Before this, the only sink on that skip path was
	 * `dbg()`, gated behind `verbose` — both production instantiations
	 * (this file's `queryLoader` singleton and `tree-sitter-client.ts`'s
	 * `new TreeSitterQueryLoader()`) construct with the `verbose = false`
	 * default — so a silently-dropped custom rule had no surviving signal.
	 */
	private recordQueryParseFailure(filePath: string, reason: string): void {
		this.parseFailures.set(filePath, reason);
		recordDegradationOnce({
			kind: "tree-sitter-query-parse-failed",
			subject: filePath,
			reason,
		});
	}

	/**
	 * Replay every remembered per-file parse failure into the CURRENT
	 * session's ledger, at most once per ledger generation (#3070 N1). A
	 * memoized `loadQueries` return skips `parseQueryFile` entirely, so
	 * without this replay the `tree-sitter-query-parse-failed` record only
	 * ever reached the FIRST session that actually parsed — `resetDegradationLedger`
	 * (wired into `handleSessionStart`) clears the once-keys every session,
	 * but the loader instance and its `parseFailures` memo are kept across
	 * sessions (`clients/tree-sitter-shared.ts:39`), the same shape
	 * `getBundledQueriesRootHealth` above already re-probes per generation.
	 */
	private replayQueryParseFailures(): void {
		const generation = getDegradationLedgerGeneration();
		if (this.parseFailuresReplayedGeneration === generation) return;
		this.parseFailuresReplayedGeneration = generation;
		for (const [filePath, reason] of this.parseFailures) {
			recordDegradationOnce({
				kind: "tree-sitter-query-parse-failed",
				subject: filePath,
				reason,
			});
		}
	}

	/**
	 * Load all queries from the rules/tree-sitter-queries directory.
	 *
	 * Returns the in-memory memo when the same root is already loaded and the
	 * mutable corpus's content fingerprint is unchanged. That fingerprint is
	 * computed at most once per dispatch cycle and reused by every later call
	 * in the cycle (`ruleCorpusFingerprintForCycle`), so routine re-scans and
	 * structural searches do no filesystem work at all on the warm path
	 * (#4212 round 4; rounds 2 and 3 each paid for per-call detection). An edit
	 * made during a cycle is therefore seen by the NEXT cycle — or earlier, by
	 * any `force: true` call, which republishes the fresh value into the cycle.
	 *
	 * `force: true` re-reads from disk regardless — the dispatch runner's
	 * RuleCache-miss path: a miss means the content fingerprint moved, so
	 * without `force` the memo could hand back pre-edit rules to be persisted
	 * under the fresh fingerprint (#878).
	 */
	async loadQueries(
		rootDir = process.cwd(),
		options: { force?: boolean } = {},
	): Promise<Map<string, TreeSitterQuery[]>> {
		const resolvedRoot = path.resolve(rootDir);
		// Captured synchronously, before any await, so the identity is this
		// call's cycle and not whatever cycle resumes it (AGENTS.md shape 22).
		// `computeMutableRuleFingerprint` is passed by reference rather than
		// wrapped, and `force` is positional: this is the hot path, and the
		// per-call closure plus options object were measurable against a warm
		// call whose whole budget is ~0.9 us.
		const ruleFingerprint = ruleCorpusFingerprintForCycle(
			"tree-sitter",
			resolvedRoot,
			computeMutableRuleFingerprint,
			options.force,
		);
		if (
			!options.force &&
			this.loaded &&
			this.loadedRoot === resolvedRoot &&
			this.loadedRuleFingerprint === ruleFingerprint
		) {
			this.replayQueryParseFailures();
			return this.queries;
		}

		this.queries.clear();
		this.parseFailures.clear();
		this.loaded = false;

		// Load from user's project rules AND package built-in rules (coexist)
		const queryDirs = [
			...new Set([
				path.join(resolvedRoot, "rules", "tree-sitter-queries"),
				path.join(getUserRuleRoot(), "tree-sitter-queries"),
				resolvePackagePath(import.meta.url, "rules", "tree-sitter-queries"),
			]),
		];

		for (const queriesDir of queryDirs) {
			if (!fs.existsSync(queriesDir)) {
				this.dbg(`Queries directory not found: ${queriesDir}`);
				continue;
			}

			const languageDirs = fs
				.readdirSync(queriesDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name);

			for (const lang of languageDirs) {
				const langDir = path.join(queriesDir, lang);
				const languageKey = getQueryLanguageKey(lang);
				const queryFiles = fs
					.readdirSync(langDir)
					.filter((f) => f.endsWith(".yml"));

				const langQueries = this.queries.get(languageKey) ?? [];

				for (const file of queryFiles) {
					const filePath = path.join(langDir, file);
					const query = this.parseQueryFile(filePath, languageKey);
					if (query) {
						if (!langQueries.some((existing) => existing.id === query.id)) {
							langQueries.push(query);
						}
					}
				}

				if (langQueries.length > 0) {
					this.queries.set(languageKey, langQueries);
					this.dbg(`Loaded ${langQueries.length} queries for ${languageKey}`);
				}
			}
		}

		this.loaded = true;
		this.loadedRoot = resolvedRoot;
		// The reload above is synchronous end to end, so the corpus observed
		// here is the corpus the fingerprint was computed from — reuse it.
		this.loadedRuleFingerprint = ruleFingerprint;
		// Every failure hit above was recorded into THIS generation's ledger
		// directly (via recordQueryParseFailure); mark it replayed so a
		// same-generation memoized call right after this one doesn't redo the
		// (harmless but pointless) replay loop.
		this.parseFailuresReplayedGeneration = getDegradationLedgerGeneration();
		return this.queries;
	}

	/**
	 * Parse a single YAML query file
	 */
	private parseQueryFile(
		filePath: string,
		language: string,
	): TreeSitterQuery | null {
		try {
			const content = fs.readFileSync(filePath, "utf-8");

			const parsed = this.parseYaml(content);

			// #3054 review F2: type-checked, not just truthy. `yaml.load` widened
			// `parsed` to `Record<string, unknown>`, so a mapping- or
			// array-valued `id`/`query` (a plausible authoring slip: forgetting
			// the `|` on `query:` turns the block into a nested mapping) is
			// truthy and used to sail through the old `!parsed.id || !parsed.query`
			// check, then `String(...)` turned it into the literal text
			// `"[object Object]"` — which for `query` reached the Query
			// constructor (SonarCloud typescript:S6551 flagged every such
			// stringification in this function; fixed below via `str()`).
			const id = str(parsed.id);
			const query = typeof parsed.query === "string" ? parsed.query : undefined;
			if (!id || !query) {
				this.dbg(`Invalid query file: ${filePath}`);
				this.recordQueryParseFailure(
					filePath,
					!id
						? `'id' is missing or not a scalar (got ${typeof parsed.id})`
						: `'query' is missing or not a string (got ${typeof parsed.query})`,
				);
				return null;
			}

			return {
				id,
				name: str(parsed.name) || id,
				severity: this.parseSeverity(parsed.severity),
				category: str(parsed.category) || "general",
				language: str(parsed.language) || language,
				message: str(parsed.message) || `Pattern: ${id}`,
				description: str(parsed.description) || undefined,
				query,
				metavars: Array.isArray(parsed.metavars)
					? parsed.metavars.map(String)
					: this.extractMetavars(query),
				post_filter: str(parsed.post_filter) || undefined,
				// biome-ignore lint/suspicious/noExplicitAny: Post filter params
				post_filter_params: parsed.post_filter_params as any,
				defect_class: str(parsed.defect_class) || undefined,
				inline_tier: (str(parsed.inline_tier) || undefined) as
					| "blocking"
					| "warning"
					| "review"
					| undefined,
				skip_test_files: parsed.skip_test_files === true,
				ignore_paths: Array.isArray(parsed.ignore_paths)
					? parsed.ignore_paths.map(String)
					: undefined,
				// Parse predicates if present
				predicates: Array.isArray(parsed.predicates)
					? parsed.predicates.map((p: any) => ({
							type: p.type,
							var: p.var,
							value: p.value,
						}))
					: undefined,
				tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : undefined,
				cwe: Array.isArray(parsed.cwe) ? parsed.cwe.map(String) : undefined,
				owasp: Array.isArray(parsed.owasp)
					? parsed.owasp.map(String)
					: undefined,
				confidence: (str(parsed.confidence) || undefined) as
					| "low"
					| "medium"
					| "high"
					| undefined,
				has_fix: parsed.has_fix === true || parsed.has_fix === "true",
				fix_action: str(parsed.fix_action) || undefined,
				filePath,
			};
		} catch (err) {
			this.dbg(`Failed to parse ${filePath}: ${err}`);
			this.recordQueryParseFailure(
				filePath,
				err instanceof Error ? err.message : String(err),
			);
			return null;
		}
	}

	/**
	 * Parse a query file's YAML with `js-yaml` — the same real parser
	 * `clients/dispatch/runners/yaml-rule-parser.ts` uses for ast-grep rules
	 * (#206: a hand-rolled line scanner flattened nested structures there; the
	 * hand-rolled scanner this loader carried made the identical mistake,
	 * twice over — its inline `[a, b]` array branch unquoted list items but
	 * its multi-line `- item` branch did not, so `console-statement.yml`'s
	 * quoted `ignore_paths` glob parsed with the quote marks attached and the
	 * #965 carve-out never matched a path, #3041/#3046). A genuine syntax
	 * error throws, caught by `parseQueryFile`'s `try`/`catch`; a
	 * syntactically valid but wrong-shaped document (a bare scalar, a list,
	 * `null`) is cast here and skipped by `parseQueryFile`'s `id`/`query`
	 * type check below — property access on a non-object primitive never
	 * throws in JS, so no separate `typeof parsed !== "object"` guard is
	 * needed here (#3054 review F3: that guard was vacuous — deleting it
	 * reds nothing, every case it caught was already caught one frame up).
	 */
	private parseYaml(content: string): Record<string, unknown> {
		return yaml.load(content) as Record<string, unknown>;
	}

	/**
	 * Parse severity string to valid type
	 */
	private parseSeverity(value: unknown): "error" | "warning" | "info" {
		if (value === "error") return "error";
		if (value === "warning") return "warning";
		if (value === "info") return "info";
		return "warning"; // default
	}

	/**
	 * Extract @VAR patterns from query string
	 */
	private extractMetavars(query: string): string[] {
		const matches = query.match(/@([A-Z_][A-Z0-9_]*)/g);
		if (!matches) return [];
		return [...new Set(matches.map((m) => m.slice(1)))];
	}

	/**
	 * Get queries for a specific language
	 */
	getQueriesForLanguage(language: string): TreeSitterQuery[] {
		const all = this.queries.get(language) || [];
		// Exclude queries from <language>-disabled/ directories.
		// Disabled rules are loaded (needed by tests via getAllQueries)
		// but excluded from production dispatch.
		return all.filter((q) => !isDisabledQueryFilePath(q.filePath));
	}

	/**
	 * Get a specific query by ID
	 */
	getQueryById(id: string): TreeSitterQuery | undefined {
		for (const langQueries of this.queries.values()) {
			const query = langQueries.find((q) => q.id === id);
			if (query) return query;
		}
		return undefined;
	}

	/**
	 * Find matching query for a pattern string
	 */
	findMatchingQuery(
		pattern: string,
		language: string,
	): TreeSitterQuery | undefined {
		const langQueries = this.getQueriesForLanguage(language);

		// Check for pattern keywords
		for (const query of langQueries) {
			// Match by ID
			if (pattern.includes(query.id)) return query;

			// Match by keywords in pattern
			switch (query.id) {
				case "empty-catch":
					if (pattern.includes("empty-catch") || pattern.includes("catch {}"))
						return query;
					break;
				case "debugger-statement":
					if (pattern.includes("debugger")) return query;
					break;
				case "await-in-loop":
					if (pattern.includes("await-in-loop") || pattern.includes("await"))
						return query;
					break;
				case "hardcoded-secrets":
					if (
						pattern.includes("hardcoded") ||
						pattern.includes("api_key") ||
						pattern.includes("password")
					)
						return query;
					break;
				case "dangerously-set-inner-html":
					if (pattern.includes("dangerously") || pattern.includes("innerHTML"))
						return query;
					break;
				case "nested-ternary":
					if (pattern.includes("ternary") || pattern.includes("? :"))
						return query;
					break;
				case "no-eval":
					if (pattern.includes("eval") && !pattern.includes("console"))
						return query;
					break;
				case "deep-promise-chain":
					if (pattern.includes(".then") && pattern.includes(".catch"))
						return query;
					break;
				case "console-statement":
					if (pattern.includes("console") && !pattern.includes("test"))
						return query;
					break;
				case "long-parameter-list":
					if (pattern.includes("PARAMS")) return query;
					break;
				// Python queries
				case "bare-except":
					if (pattern.includes("bare-except") || pattern.includes("except:"))
						return query;
					break;
				case "mutable-default-arg":
					if (pattern.includes("mutable") || pattern.includes("default"))
						return query;
					break;
				case "wildcard-import":
					if (pattern.includes("wildcard") || pattern.includes("import *"))
						return query;
					break;
				case "eval-exec":
					if (pattern.includes("eval") || pattern.includes("exec"))
						return query;
					break;
				case "is-vs-equals":
					if (pattern.includes("is") || pattern.includes("equals"))
						return query;
					break;
				case "unreachable-except":
					if (pattern.includes("unreachable") || pattern.includes("except"))
						return query;
					break;
			}
		}

		return undefined;
	}

	/**
	 * Get all loaded queries
	 */
	getAllQueries(): TreeSitterQuery[] {
		const all: TreeSitterQuery[] = [];
		for (const queries of this.queries.values()) {
			all.push(...queries);
		}
		return all;
	}

	/**
	 * Reload queries from disk
	 */
	async reload(): Promise<void> {
		this.queries.clear();
		this.loaded = false;
		await this.loadQueries();
	}
}

// Singleton instance
export const queryLoader = new TreeSitterQueryLoader();
