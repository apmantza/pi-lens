import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePackagePath } from "./package-root.js";
import { walkUpDirs } from "./path-utils.js";

// ast-grep's root config marker. The `ast-grep lsp` server is workspace-gated:
// it only operates in a project that has an `sgconfig.y[a]ml` at (or above) the
// file. These are the names ast-grep itself looks for as root markers.
export const SGCONFIG_NAMES = ["sgconfig.yml", "sgconfig.yaml"] as const;

/**
 * Nearest `sgconfig.y[a]ml` walking up from `startDir`, or undefined if none.
 * Used both to gate the ast-grep LSP server (no sgconfig ⇒ it never attaches,
 * so the napi runner stays the path) and to decide blocking eligibility (a repo
 * sgconfig is the team's deliberately-authored ruleset, like a curated opengrep
 * config — see clients/dispatch/auxiliary-lsp.ts).
 */
export function findLocalSgconfig(startDir: string): string | undefined {
	for (const dir of walkUpDirs(startDir || process.cwd())) {
		for (const name of SGCONFIG_NAMES) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * The shipped ast-grep rule dirs IN PRECEDENCE ORDER: project (dev cwd) dirs
 * first, then the installed/bundled package dirs. This is the SAME order the
 * in-process NAPI runner walks (clients/dispatch/runners/ast-grep-napi.ts
 * `evaluateAstGrepRules`) — its `seenRuleIds` dedup keeps the first-seen rule
 * for a given id, so listing project dirs first there is what makes a project
 * rule win a same-id collision. The generated raw sgconfig (#497) must derive
 * from the SAME ordered list so both surfaces agree on the winner (rather than
 * each hardcoding its own dir list and silently drifting apart).
 */
export function shippedRuleDirsInPrecedenceOrder(): string[] {
	const candidates = [
		path.join(process.cwd(), "rules", "ast-grep-rules", "rules"),
		path.join(process.cwd(), "rules", "ast-grep-rules", "coderabbit", "rules"),
		resolvePackagePath(import.meta.url, "rules", "ast-grep-rules", "rules"),
		resolvePackagePath(
			import.meta.url,
			"rules",
			"ast-grep-rules",
			"coderabbit",
			"rules",
		),
	];
	// Dedup identical paths (dev loop: cwd === package root) while preserving
	// first-occurrence order — Set preserves insertion order in JS.
	return Array.from(new Set(candidates.filter((d) => fs.existsSync(d))));
}

/** The shipped ast-grep rule dirs (dev cwd first, then the installed package). */
function findShippedRuleDirs(): string[] {
	return shippedRuleDirsInPrecedenceOrder();
}

let cachedBaselinePath: string | undefined;
/** mtimeMs of each source rule dir at the time the merged dir was built, so a
 * later rule-file change (project adds/removes a shadowing rule mid-session)
 * invalidates the cache instead of silently serving a stale winner set
 * (#497 point 7: fresh and cached diagnostics must agree). */
let cachedSourceMtimes: string | undefined;

/**
 * Synthesize (once) an sgconfig that points ast-grep at pi-lens's SHIPPED rules
 * (the native pi-lens rule dir plus vendored CodeRabbit essentials), for the
 * no-project-sgconfig baseline (#239 Phase 2): the ast-grep LSP attaches
 * everywhere and is launched with `lsp --config <this>` so it scans the shipped
 * ruleset just as the napi runner did. `ruleDirs` is absolute (this file lives in
 * a temp dir, not the package) and forward-slashed (ast-grep accepts `/` on
 * Windows; backslashes in a YAML scalar would need escaping). Returns undefined
 * if the shipped rules can't be located — the caller then launches plain `lsp`.
 */
export function resolveBaselineSgconfig(): string | undefined {
	const ruleDirs = findShippedRuleDirs();
	if (ruleDirs.length === 0) return undefined;
	const currentMtimes = sourceMtimesFingerprint(ruleDirs);
	if (
		cachedBaselinePath &&
		fs.existsSync(cachedBaselinePath) &&
		cachedSourceMtimes === currentMtimes
	) {
		return cachedBaselinePath;
	}
	const dir = path.join(os.tmpdir(), "pi-lens-ast-grep");
	fs.mkdirSync(dir, { recursive: true });
	// Per-PROCESS filename (#472): the config path doubles as the orphan
	// reaper's command-line marker, so it must be unique per instance — a
	// shared filename would make the reaper's marker-fallback match every
	// live session's ast-grep on the machine.
	const file = path.join(dir, `baseline-${process.pid}.sgconfig.yml`);
	cleanupStaleBaselines(dir, file);

	// #497: raw ast-grep's `ruleDirs` is directory-granular and errors HARD on
	// any duplicate rule id across the listed dirs (verified against real `sg
	// scan`) — but a project rule dir and the bundled rule dir routinely share
	// ids (a project overriding a bundled rule at the same conventional path).
	// The in-process NAPI runner tolerates this by deduping same-id rules
	// project-first; the generated config must pick the SAME winner rather
	// than handing `sg` both files and getting the whole config rejected.
	// Fix: materialize a single merged rule dir containing only the winning
	// rule per id (project-first, mirroring NAPI's precedence), so `ruleDirs`
	// never has to list more than one directory with overlapping ids.
	const mergedDir = path.join(dir, `baseline-${process.pid}.rules`);
	materializeMergedRuleDir(ruleDirs, mergedDir);

	const ruleDirForYaml = mergedDir.split(path.sep).join("/");
	fs.writeFileSync(file, `ruleDirs:\n  - "${ruleDirForYaml}"\n`);
	cachedBaselinePath = file;
	cachedSourceMtimes = currentMtimes;
	return file;
}

/** Best-effort removal of baseline configs left by dead processes (per-pid
 * filenames accumulate). Age-based (>7 days) so a live long-running session's
 * file is never touched; fs-only, never throws. Also sweeps the per-pid
 * merged-rules directories (#497) alongside the `.sgconfig.yml` files. */
function cleanupStaleBaselines(dir: string, keep: string): void {
	try {
		const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for (const name of fs.readdirSync(dir)) {
			const isConfig = /^baseline(-\d+)?\.sgconfig\.yml$/.test(name);
			const isMergedDir = /^baseline-\d+\.rules$/.test(name);
			if (!isConfig && !isMergedDir) continue;
			const full = path.join(dir, name);
			if (full === keep) continue;
			try {
				if (fs.statSync(full).mtimeMs < cutoff) {
					fs.rmSync(full, { recursive: true, force: true });
				}
			} catch {
				// racing another session — skip
			}
		}
	} catch {
		// missing dir / permission — nothing to clean
	}
}

/**
 * Fingerprint the source rule dirs' mtimes so a rebuilt/edited project rule
 * dir (a rule added/removed mid-session, shadowing or unshadowing a bundled
 * id) invalidates the memoized merged directory instead of silently serving a
 * stale winner set (#497 point 7: fresh and cached diagnostics must agree).
 */
function sourceMtimesFingerprint(ruleDirs: string[]): string {
	return ruleDirs
		.map((d) => {
			try {
				return `${d}:${fs.statSync(d).mtimeMs}`;
			} catch {
				return `${d}:0`;
			}
		})
		.join("|");
}

/**
 * Build a single merged rule directory from `ruleDirs` (already in
 * project-first precedence order) so raw `sg`/the ast-grep LSP never sees two
 * directories with an overlapping rule id (#497).
 *
 * Precedence semantics MUST mirror the in-process NAPI runner
 * (`evaluateAstGrepRules`'s `seenRuleIds` dedup): the first dir in the list to
 * claim an id wins it; later dirs' claims on that same id are dropped.
 *
 * Same-layer duplicates (two files in the SAME source dir sharing an id) are
 * intentionally NOT deduped here — they are copied through verbatim so `sg`
 * still hard-errors on them (#497 point 5: same-layer duplicates must stay
 * visible as errors, never silently hidden).
 *
 * Each source file may contain multiple `---`-separated rule documents
 * (yaml-rule-parser splits per-doc, see slop-style packed rule files) so a
 * naive whole-file copy would either keep or drop a shadowed AND an
 * unshadowed id together. This walks doc-by-doc instead: a file survives
 * unmodified if none of its ids were already claimed by an earlier dir; if
 * some (but not all) of its ids are claimed, only the surviving docs are
 * written through — keeping the merge id-correct without disturbing
 * same-layer duplicate detection.
 */
function materializeMergedRuleDir(ruleDirs: string[], mergedDir: string): void {
	fs.rmSync(mergedDir, { recursive: true, force: true });
	fs.mkdirSync(mergedDir, { recursive: true });

	const claimedByEarlierDir = new Set<string>();

	ruleDirs.forEach((ruleDir, dirIndex) => {
		let entries: string[];
		try {
			entries = fs.readdirSync(ruleDir).filter((f) => f.endsWith(".yml"));
		} catch {
			return;
		}

		// Ids first claimed by files WITHIN this same dir (same layer) — used
		// only to know what to add to `claimedByEarlierDir` for the NEXT dir;
		// same-layer collisions are deliberately left intact for `sg` to catch.
		const idsClaimedThisDir = new Set<string>();

		for (const name of entries) {
			const srcPath = path.join(ruleDir, name);
			let content: string;
			try {
				content = fs.readFileSync(srcPath, "utf-8");
			} catch {
				continue;
			}
			const docs = content.split(/^---$/m);
			const survivingDocs = docs.filter((doc) => {
				const trimmed = doc.trim();
				if (!trimmed) return false;
				const id = extractYamlId(trimmed);
				// No parseable id: pass the doc through untouched — never let a
				// materialization bug silently drop content `sg` might still
				// need (malformed rules are ast-grep's problem to reject, not
				// ours to swallow).
				if (!id) return true;
				if (claimedByEarlierDir.has(id)) return false; // shadowed by a higher-precedence dir
				idsClaimedThisDir.add(id);
				return true;
			});
			if (survivingDocs.length === 0) continue; // fully shadowed — omit the file

			// Namespace by source-dir index (never a bare original filename):
			// two DIFFERENT source dirs can legitimately both ship an unrelated
			// `name.yml` (same basename, disjoint ids) — writing both to the
			// merged dir under the same bare name would silently clobber one.
			// The dir-index prefix keeps every destination path unique while
			// still being stable/readable for debugging.
			const destName = `dir${dirIndex}-${name}`;
			fs.writeFileSync(
				path.join(mergedDir, destName),
				survivingDocs.map((d) => d.trim()).join("\n---\n"),
			);
		}

		for (const id of idsClaimedThisDir) claimedByEarlierDir.add(id);
	});
}

/** Pull just the top-level `id:` scalar out of a rule YAML doc without a full
 * YAML parse (materialization only needs the id to decide shadowing; the full
 * rule body is passed through verbatim either way). Mirrors the `id:` shape
 * `yaml-rule-parser`'s js-yaml load would produce for a well-formed doc. */
function extractYamlId(doc: string): string | undefined {
	const match = doc.match(/^id:\s*(.+)$/m);
	if (!match) return undefined;
	return match[1].trim().replace(/^["']|["']$/g, "");
}

/** Test-only: reset the memoized baseline sgconfig path. */
export function _resetBaselineSgconfigForTests(): void {
	cachedBaselinePath = undefined;
	cachedSourceMtimes = undefined;
}
