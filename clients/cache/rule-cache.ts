/**
 * Rule Cache for pi-lens
 *
 * Provides disk-based caching for parsed tree-sitter rules with
 * automatic invalidation based on rule file modification times.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { reportBundledResourceDirHealth } from "../bundled-resource-health.js";
import { getProjectDataDir } from "../file-utils.js";
import { readJsonCache } from "../json-cache-read.js";
import {
	BUNDLED_QUERIES_ROOT,
	getBundledQueriesRootHealth,
} from "../tree-sitter-query-loader.js";
import { writeFileAtomic } from "../atomic-write.js";
import { compareOrdinal } from "../string-utils.js";

// v4: cache skip_test_files + fix_action — v3 entries silently dropped them,
// and ruleHash (rule-file mtimes) never invalidates on a code-only fix.
// v5 (#675): rule SELECTION changed in code — javascript no longer inherits the
// typescript rule set and tsx now does. A v4 entry holds the old merge, and
// queries now compile against the file's parse language, so replaying it would
// fire typescript rules on javascript trees for real this time.
// v6 (#878): the ruleHash FINGERPRINT now covers the full effective rule set —
// inherited rule-source directories (tsx also runs typescript rules), not just
// the language's own. A v5 tsx entry was hashed over tsx files only, so a
// typescript-rule edit never invalidated it; v5 entries self-miss anyway (the
// hash input set changed), the bump just makes the semantics break explicit.
// v7 (#1118): computeRuleHash now CONTENT-hashes project-local rule files
// instead of trusting mtime+size alone. mtime+size is the review-graph
// first-filter, not the full gold standard (size:mtimeMs + confirmContentChanged)
// — a rule-file edit that preserves both (git checkout timestamp restoration, a
// same-length tweak, a formatter that preserves mtime) replayed a stale
// compiled set from disk and re-persisted it under the still-matching
// fingerprint, poisoning every future process. The bump forces every v6 entry
// (hashed under the old metadata-only formula) to miss once on upgrade, so a
// silently-poisoned v6 entry can't be trusted by the new code.
export const CACHE_VERSION = "v7";

/**
 * Bundled rule files ship with the extension and are immutable within a
 * process — they can't change mid-session, so the cheap mtime+size
 * fingerprint (v6's whole-set formula) is sufficient for them, and there are
 * ~705 of them across all languages, so unconditionally reading+hashing their
 * bytes on every edit would be the unconditional hot-path hashing the
 * event-loop discipline forbids (RuleCache.get runs on the per-edit
 * tree-sitter runner hot path).
 *
 * Project-local rule files (under `<project>/rules/tree-sitter-queries/`,
 * see `ruleFilesForLanguage`) are the opposite: mutable, and a SMALL set (the
 * handful a developer actually maintains) — cheap to content-hash. Splitting
 * on this prefix mirrors the split `yaml-rule-parser.ts`/`ast-grep-napi.ts`
 * already use for the ast-grep side of the same class (#1105): project-origin
 * trees get a content-hash CONFIRM, bundled trees stay mtime-cheap.
 *
 * #2636 review F4: re-exported from `tree-sitter-query-loader.ts`'s
 * `BUNDLED_QUERIES_ROOT` rather than computed a second time here — the two
 * modules read the IDENTICAL physical directory, and the "one ledger row"
 * claim below rests on that being reference equality, not two independently
 * `resolvePackagePath`-resolved strings that happen to match.
 */
export { BUNDLED_QUERIES_ROOT as BUNDLED_RULES_ROOT } from "../tree-sitter-query-loader.js";

function isBundledRuleFile(resolvedFile: string): boolean {
	return (
		resolvedFile === BUNDLED_QUERIES_ROOT ||
		resolvedFile.startsWith(BUNDLED_QUERIES_ROOT + path.sep)
	);
}

/**
 * #2636 (the #2626 class sweep's tree-sitter leg): the bundled
 * tree-sitter-queries root above was used unconditionally with no existence
 * check — same managed-cache-relocation gap #2626 fixed for `skills/`.
 * Purely observational (never gates `isBundledRuleFile`'s classification):
 * records a bounded `tree-sitter-queries-dir-missing` degradation only when
 * the bundled root is absent, unreadable, or (uncommonly) present but empty.
 * Shares the exact kind + subject `clients/tree-sitter-query-loader.ts`'s
 * `ruleFilesForLanguage` reports under — both read the SAME physical
 * directory (`getBundledQueriesRootHealth`'s process-lifetime memo, #2636
 * review F6 — this constructor runs per dispatched file, so an unmemoized
 * `readdirSync` here would be the same unconditional hot-path cost the
 * class doc comment above forbids for rule-file hashing), so the ledger's
 * own (kind, subject) dedup collapses whichever call site observes it first
 * into ONE row rather than two duplicates.
 */
function reportBundledRulesRootHealth(): void {
	reportBundledResourceDirHealth(
		"tree-sitter-queries-dir-missing",
		BUNDLED_QUERIES_ROOT,
		getBundledQueriesRootHealth(),
		"bundled tree-sitter query rules",
	);
}

export interface QueryCacheEntry {
	version: string;
	timestamp: number;
	ruleHash: string;
	queries: Array<{
		id: string;
		name: string;
		severity: string;
		language: string;
		message: string;
		query: string;
		metavars: string[];
		post_filter?: string;
		post_filter_params?: Record<string, unknown>;
		defect_class?: string;
		inline_tier?: "blocking" | "warning" | "review";
		skip_test_files?: boolean;
		has_fix?: boolean;
		fix_action?: string;
		filePath?: string;
	}>;
}

export class RuleCache {
	private cacheFile: string;
	private cacheDir: string;
	private language: string;

	constructor(language: string, rootDir = process.cwd()) {
		this.language = language;
		reportBundledRulesRootHealth();
		this.cacheDir = path.join(getProjectDataDir(rootDir), "cache");
		this.cacheFile = path.join(
			this.cacheDir,
			`${language}-rules-${CACHE_VERSION}.json`,
		);
	}

	private ensureCacheDir(): void {
		if (!fs.existsSync(this.cacheDir)) {
			fs.mkdirSync(this.cacheDir, { recursive: true });
		}
	}

	private computeRuleHash(ruleFiles: string[]): string {
		const hash = crypto.createHash("sha256");
		for (const file of ruleFiles.sort(compareOrdinal)) {
			const resolved = path.resolve(file);
			if (!fs.existsSync(resolved)) continue;
			const stat = fs.statSync(resolved);
			hash.update(`${file}:${stat.mtimeMs}:${stat.size}`);
			// Content-CONFIRM only the project-local, mutable subset (a handful of
			// files) — mtime+size alone is a first filter, not proof of freshness,
			// and a preserved-mtime+size edit here would otherwise replay (and
			// re-persist) a stale compiled set. Bundled files (~705, immutable
			// within a process) skip this: the metadata fingerprint stays their
			// whole story, keeping the common no-project-rules case as cheap as v6.
			if (!isBundledRuleFile(resolved)) {
				hash.update(fs.readFileSync(resolved));
			}
		}
		return hash.digest("hex").slice(0, 16);
	}

	get(ruleFiles: string[]): QueryCacheEntry | null {
		try {
			this.ensureCacheDir();
			if (!fs.existsSync(this.cacheFile)) return null;

			const currentHash = this.computeRuleHash(ruleFiles);
			const cached = readJsonCache<QueryCacheEntry>(
				this.cacheFile,
				(parsed) => {
					const entry = parsed as QueryCacheEntry;
					if (
						entry.version !== CACHE_VERSION ||
						entry.ruleHash !== currentHash
					) {
						return undefined; // Cache invalid
					}
					return entry;
				},
			);
			return cached ?? null;
		} catch {
			return null;
		}
	}

	set(ruleFiles: string[], queries: QueryCacheEntry["queries"]): void {
		try {
			this.ensureCacheDir();
			const entry: QueryCacheEntry = {
				version: CACHE_VERSION,
				timestamp: Date.now(),
				ruleHash: this.computeRuleHash(ruleFiles),
				queries,
			};
			writeFileAtomic(this.cacheFile, JSON.stringify(entry, null, 2));
			this.pruneStaleVersions();
		} catch {
			// Cache write failure is non-fatal
		}
	}

	// Orphaned `<language>-rules-v<N>.json` files from a prior CACHE_VERSION
	// (e.g. v3 entries left behind by the #448 v3→v4 bump) never got cleaned up
	// on their own — nothing ever read or removed them again once the version
	// bumped. Delete every sibling for this language that isn't the current file.
	private pruneStaleVersions(): void {
		const currentName = path.basename(this.cacheFile);
		const pattern = new RegExp(`^${this.language}-rules-v\\d+\\.json$`);
		let dirents: string[];
		try {
			dirents = fs.readdirSync(this.cacheDir);
		} catch {
			return;
		}
		for (const name of dirents) {
			if (name === currentName || !pattern.test(name)) continue;
			try {
				fs.unlinkSync(path.join(this.cacheDir, name));
			} catch {
				// Best-effort; ENOENT (already gone) or any other removal failure
				// shouldn't undo the write that already succeeded above.
			}
		}
	}

	clear(): void {
		try {
			if (fs.existsSync(this.cacheFile)) {
				fs.unlinkSync(this.cacheFile);
			}
		} catch {
			// Ignore
		}
	}
}
