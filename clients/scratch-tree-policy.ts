/**
 * Single source of truth for "scratch/cache tree" exclusion, shared by every
 * runner that hands a DIRECTORY to an external binary and lets that binary do
 * its own tree walk.
 *
 * pi-lens's own in-process walkers (`source-filter.ts`/`source-walker.ts`,
 * `getProjectIgnoreMatcher`) already route every entry through
 * `isExcludedDirName`/`EXCLUDED_DIRS` (`file-utils.ts`) — that's how knip,
 * jscpd, and the tree-sitter project scan skip `.pi/`, `node_modules/`, etc.
 * But a runner that shells out with `cwd`/`--source <dir>` and lets the
 * EXTERNAL tool walk (gitleaks `detect --source`, `trivy fs`, `opengrep scan
 * <dir>`) bypasses that walker entirely — the tool sees the raw tree,
 * including pi-ecosystem scratch/data directories that were never meant to be
 * scan targets (#1562: `.pi/greedysearch-sources/` — a gitignored web-research
 * cache — served a `YOUR_API_KEY` doc-example placeholder to the agent as a
 * "leaked secret").
 *
 * This module derives each such runner's native exclude syntax from the SAME
 * `EXCLUDED_DIRS` list `file-utils.ts` already uses for the in-process walk,
 * rather than hand-maintaining a parallel per-tool list (the single-source-of-
 * truth rule that #883 encodes — a hand-copied list is a defect in itself:
 * `dead-code-client.ts`'s `VULTURE_EXCLUDES` had drifted from `EXCLUDED_DIRS`
 * before this fix, e.g. missing `.pi`/`.claude`/`.next`).
 *
 * Deliberately NOT `.gitignore`-based: a secrets scanner (gitleaks, trivy's
 * `secret` scanner) must still see an untracked `.env` with a real credential
 * — `.env` is commonly gitignored, so blanket "respect .gitignore" would hide
 * exactly the file classes these scanners exist to catch (#1562 design note).
 * `EXCLUDED_DIRS` is a narrower, deliberate list of scratch/cache/vendor
 * directory NAMES (`.pi`, `.claude`, `node_modules`, `dist`, …), not a
 * gitignore pattern set.
 *
 * TWO exclusion tiers, not one (#1562 review-round F1) — `EXCLUDED_DIRS`
 * itself conflates two different questions:
 *   - "don't bother INDEXING/LINTING/DEDUPING this" (the walker-parity
 *     exports below, `getScratchTreeGlobPatterns`/`getScratchTreeDirNames`/
 *     `getScratchTreeFnmatchPatterns`) — correctly broad: build output
 *     (`dist`, `build`, `out`, `target`, `coverage`), vendored source
 *     (`vendor`, `third_party`, `vendors`), and editor config (`.vscode`)
 *     are all noise for knip/jscpd/vulture.
 *   - "don't bother looking for SECRETS here" — a much narrower question.
 *     The first cut of this fix reused the walker-parity list for gitleaks's
 *     secrets-lane exclusion too, and a review probe caught it silently
 *     dropping real AWS-shaped secrets seeded in `dist/`, `vendor/`,
 *     `.vscode/`, `build/`, `out/`, `target/`, `third_party/`,
 *     `third-party/`, `coverage/` (0/9 kept, unlogged) — a bundler can bake
 *     a real key into `dist/`, `.vscode/launch.json` commonly carries a
 *     committed debug token, and a vendored tree can carry an upstream
 *     leak. `SECRETS_LANE_SCRATCH_DIR_NAMES`/`getSecretsLaneAllowlistPaths`/
 *     `isUnderSecretsLaneScratchTree` are the narrow tier gitleaks (or any
 *     future gitleaks-shaped secret scanner) must use instead — pi-ecosystem/
 *     agent data dirs, `node_modules`, `.git`, and generic build/package-
 *     manager CACHES only; every real-leak-surface directory above stays
 *     fully in scope.
 */

import { EXCLUDED_DIRS, getExcludedDirGlobs } from "./file-utils.js";
import { escapeRegExp } from "./string-utils.js";

/** Directory-name entries only — drops glob entries (e.g. `*.dSYM`) that a
 * bare directory-name/regex exclude can't express. */
function literalExcludedDirNames(): string[] {
	return EXCLUDED_DIRS.filter(
		(name) => !name.includes("*") && !name.includes("?"),
	);
}

/**
 * `**\/name/**` glob patterns for tools that take doublestar globs
 * (trivy `--skip-dirs`, opengrep/semgrep `--exclude`). Reuses
 * `file-utils.ts`'s own glob derivation so both walkers and shell-out runners
 * stay byte-for-byte in sync.
 */
export function getScratchTreeGlobPatterns(): string[] {
	return getExcludedDirGlobs();
}

/** Bare directory names, for tools (opengrep/semgrep `--exclude`) that treat a
 * slash-free pattern as "this directory name, anywhere in the tree". */
export function getScratchTreeDirNames(): string[] {
	return literalExcludedDirNames();
}

/**
 * Fnmatch-style glob patterns (`star/name/star`, not doublestar) for
 * vulture's `--exclude` — the format `dead-code-client.ts` needs.
 */
export function getScratchTreeFnmatchPatterns(): string[] {
	return literalExcludedDirNames().map((name) => `*/${name}/*`);
}

// --- Secrets-lane tier (#1562 review-round F1) ---
//
// Deliberately curated, NOT `EXCLUDED_DIRS`-derived: every name here must be
// individually justified as "never intentionally holds a first-party
// credential", not merely "not worth linting". See the module doc above for
// the walker-parity-vs-secrets-lane distinction and the 9-path probe that
// caught the original (too-broad) version of this fix.
export const SECRETS_LANE_SCRATCH_DIR_NAMES: readonly string[] = [
	// pi-ecosystem / coding-agent data + cache directories.
	".pi",
	".pi-lens",
	".claude",
	".codex",
	".agents",
	".worktrees",
	".rescue",
	".gstack",
	".superpowers",
	".guardrails",
	".playwright-cli",
	".playwright-mcp",
	// git's own internal object storage — binary/compressed, not readable
	// source; a byte-regex scan of it produces garbage, not real findings.
	".git",
	// Vendored/installed npm packages — third-party noise, not a first-party
	// leak surface (unlike `vendor`/`third_party`, which are vendored SOURCE
	// a project can carry an upstream leak in and stays in scope).
	"node_modules",
	// Generic build/package-manager CACHES — regenerated from source on every
	// build/install, never a place a human commits a credential on purpose.
	// Deliberately excludes build OUTPUT (`dist`/`build`/`out`/`target`/
	// `coverage`) — a bundler/compiler CAN bake a real secret into output.
	".turbo",
	".cache",
	".parcel-cache",
	".svelte-kit",
	".nuxt",
	".yarn",
	".pnpm-store",
	".gradle",
	".next",
	".ruff_cache",
	".tox",
	".pytest_cache",
	"venv",
	".venv",
	"__pycache__",
];

/**
 * Regex patterns for gitleaks's `[allowlist] paths` config array, scoped to
 * the narrow secrets-lane tier above (NOT the walker-parity list — see the
 * module doc). Matched against the finding's relative path.
 *
 * #1562 review-round F4: gitleaks's `File` field preserves the OS-native
 * separator from Go's directory walk — on Windows that's `\`, not `/` — so
 * an anchor of only `(?:^|/)` never matches there. Both separators are
 * accepted in the anchor and in the "rest of path" tail.
 */
export function getSecretsLaneAllowlistPaths(): string[] {
	return SECRETS_LANE_SCRATCH_DIR_NAMES.map((name) => {
		const escaped = escapeRegExp(name);
		return `(?:^|[/\\\\])${escaped}(?:[/\\\\].*)?$`;
	});
}

/**
 * True when any path segment of `relPath` (forward- or back-slash separated)
 * is a secrets-lane scratch dir name. Used for the TS-side post-filter that
 * backstops the generated gitleaks config — belt-and-suspenders because we
 * can't exercise gitleaks's own TOML-regex engine in unit tests, only assert
 * the config we hand it.
 */
export function isUnderSecretsLaneScratchTree(relPath: string): boolean {
	const names = new Set(
		SECRETS_LANE_SCRATCH_DIR_NAMES.map((n) => n.toLowerCase()),
	);
	const segments = relPath.split(/[/\\]/).filter(Boolean);
	return segments.some((segment) => names.has(segment.toLowerCase()));
}
