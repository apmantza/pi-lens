/**
 * Project-level rule policy (`.pi-lens.json` `rules.<id>.disable` /
 * `rules.<id>.select`) — output-only filtering of dispatches, so the project's
 * own policy narrows what the user actually sees without widening the trusted
 * surface area (widget state, baseline, dedup, and per-edit record stay
 * authoritative).
 *
 * Matching is PROJECT-WIDE. The outer `rules.<key>` is a grouping label only —
 * it does not scope which diagnostics a `disable`/`select` list under it can
 * match. Every `disable` entry across every key is unioned into one drop list,
 * and every `select` entry across every key is unioned into one allowlist.
 * Disable is checked first, so it wins globally regardless of which key it's
 * configured under.
 *
 * Match normalization is consolidated with the rest of the rule-id surfaces:
 * `inline-suppressions.ts` and `lens-diagnostics.ts`'s `normalizeRuleId`
 * both strip the `ast-grep:` prefix and the `-js` suffix, so a user listing
 * `no-eval` once under `disable` covers both the LSP tag (`ast-grep:no-eval`)
 * and the napi tag (`no-eval` / `no-eval-js`). Sharing the normalization keeps
 * the three surfaces from drifting.
 */
import * as nodePath from "node:path";
import { normalizeRuleId } from "./rule-id-normalize.js";
import { resolveSessionConfigRoot } from "../analysis-root.js";
import {
	type ConfigDocument,
	type PiLensConfigResolution,
	resolveOnePiLensConfigDocument,
	resolvePiLensConfig,
} from "../config-resolve.js";
import { getPiLensGlobalConfigPath } from "../lens-config.js";
import {
	getGlobalPiLensDir,
	isIgnoredByGitignoreLines,
} from "../file-utils.js";
import {
	isUnderDir,
	isWindowsPath,
	pathsEqual,
	toProjectRelativePath,
} from "../path-utils.js";

/**
 * The `ignorePaths` lines ONE config file declared, with that file's directory.
 * A leading `/` roots a line at `baseDir`, and a slashless line matches below it
 * at any depth, as in the `ignore` field (#783, #5029).
 */
export interface RuleIgnoreScope {
	readonly baseDir: string;
	readonly patterns: readonly string[];
}

interface RulePolicyEntry {
	disable?: string[];
	select?: string[];
	/**
	 * Bare strings are gitignore lines relative to the workspace root; a
	 * {@link RuleIgnoreScope} is one config file's lines, relative to its own
	 * directory.
	 */
	ignorePaths?: (string | RuleIgnoreScope)[];
}

/**
 * A project's rule-config-key -> policy map (the same shape
 * `PiLensProjectConfig.rules` already uses for `threshold`). The key is only
 * a grouping label (e.g. `"security"`, `"my-rule-set"`) — it does not scope
 * matching, which is project-wide across every key's `disable`/`select`
 * lists (see the module doc comment). `Partial<>` so a threshold-only entry
 * passes the type checker even though only `disable`/`select` are consulted
 * at filter time.
 */
export type RulePolicyMap = Record<string, RulePolicyEntry | undefined>;

/** The global+project resolution a dispatch policy key is read from. */
export function resolveDispatchPolicyConfig(
	root: string,
): PiLensConfigResolution {
	return resolvePiLensConfig({
		cwd: root,
		globalDir: getGlobalPiLensDir(),
		globalConfigPath: getPiLensGlobalConfigPath(),
	});
}

/**
 * The directory whose config governs `filePath` under the workspace `root`:
 * the nearest directory at or above the file that holds a project config,
 * never above `root` (`resolveSessionConfigRoot`), else `root` itself. The
 * resolver layers upward from this owner, so its resolution carries the
 * global tier, the workspace root's file, and every nested file between.
 */
export function configOwnerFor(filePath: string, root: string): string {
	return (
		resolveSessionConfigRoot(nodePath.resolve(root, filePath), root).register ??
		root
	);
}

/**
 * The resolution every dispatch policy key (`rules`, `dispatch.disabledRunners`)
 * reads for one file: its config owner's, so a nested `.pi-lens.json` governs
 * the files under it. One resolution per file, shared by every reader.
 */
export function resolveDispatchPolicyConfigForFile(
	filePath: string,
	root: string,
): PiLensConfigResolution {
	return resolveDispatchPolicyConfig(configOwnerFor(filePath, root));
}

/**
 * The rule policy map of one resolution, ready to match paths against the
 * workspace `root`.
 *
 * `ignorePaths` entries are gitignore lines, as the `ignore` field reads them
 * (#783, #5029): last match wins, `!` re-includes, a leading `/` roots a line
 * at the declaring file's directory, a trailing `/` matches directories only.
 * They are relative to the directory of the config file that declares them. A
 * global entry, and an entry in the workspace root's own file, are relative to
 * `root`; an entry from a nested `.pi-lens.json` is relative to that file's
 * directory, so `generated/**` in `pkg/.pi-lens.json` carves out
 * `pkg/generated/**` and nothing at the root. Each file is its own scope and a
 * path is carved out when ANY scope ignores it (`array-union`): a nearer file
 * adds carve-outs and never lifts one, so a `!` re-includes only against the
 * lines of its own file.
 */
export function rulePolicyMapFromResolution(
	resolution: PiLensConfigResolution,
	root: string,
): RulePolicyMap | undefined {
	const rules = resolution.value.rules as Record<string, unknown> | undefined;
	const map = rulePolicyMapFromConfig(rules);
	if (!map || !Object.values(map).some((entry) => entry?.ignorePaths)) {
		return map;
	}
	const anchored = anchoredIgnorePaths(resolution.documents, root);
	for (const [key, entry] of Object.entries(map)) {
		if (!entry?.ignorePaths) continue;
		const paths = anchored.get(key);
		if (paths && paths.length > 0) entry.ignorePaths = paths;
	}
	return map;
}

/**
 * Every document's `rules.<key>.ignorePaths`, each validated on its own and
 * kept as its own {@link RuleIgnoreScope}, in document order. Read per document
 * because the merged array loses which file a member came from, and the same
 * text means a different path in each.
 */
function anchoredIgnorePaths(
	documents: readonly ConfigDocument[],
	root: string,
): Map<string, RuleIgnoreScope[]> {
	const byKey = new Map<string, RuleIgnoreScope[]>();
	for (const document of documents) {
		// An LSP-scoped legacy file's root keys are LSP settings, not `rules`.
		if (document.location.lspScoped) continue;
		const rules = resolveOnePiLensConfigDocument(document).value.rules;
		if (!rules || typeof rules !== "object" || Array.isArray(rules)) continue;
		const prefix =
			document.tier === "global" ? undefined : anchorPrefix(document, root);
		const baseDir = prefix ? nodePath.resolve(root, prefix) : root;
		for (const [key, rawEntry] of Object.entries(rules)) {
			const ignorePaths = (rawEntry as { ignorePaths?: unknown } | undefined)
				?.ignorePaths;
			if (!Array.isArray(ignorePaths)) continue;
			const patterns: string[] = [];
			for (const pattern of ignorePaths) {
				if (typeof pattern === "string") patterns.push(pattern);
			}
			const scopes = byKey.get(key) ?? [];
			scopes.push({ baseDir, patterns });
			byKey.set(key, scopes);
		}
	}
	return byKey;
}

/**
 * The forward-slashed path from `root` to the directory `document` configures,
 * or `undefined` when that directory is `root` itself or lies outside it (its
 * globs keep matching against `root`, as they always have).
 */
function anchorPrefix(
	document: ConfigDocument,
	root: string,
): string | undefined {
	const pathApi =
		isWindowsPath(root) || isWindowsPath(document.file)
			? nodePath.win32
			: nodePath.posix;
	let dir = document.file;
	for (const _segment of document.location.relativePath.split("/")) {
		dir = pathApi.dirname(dir);
	}
	if (pathsEqual(dir, root) || !isUnderDir(dir, root)) return undefined;
	// Config discovery records `document.file` under its real path, and `root`
	// may be the caller's link spelling: the relative is lexical when the two
	// spellings agree and taken on the identity axis when they do not, so a
	// symlinked root anchors `pkg/`, never `../real/pkg/` (#5011 r8, F25).
	return toProjectRelativePath(dir, root);
}

/**
 * The rule policy of every file under one workspace root: each file reads its
 * config owner's map ({@link rulePolicyMapFromResolution}), so a nested
 * `.pi-lens.json` governs the files under it on every surface that filters by
 * it. Owners and maps are memoized for the life of the object; build one per
 * sweep or per call so a config edit applies on the next one. `known` is a map
 * already resolved for one file's owner (the dispatcher's `ctx.rulePolicy`):
 * that owner reads it instead of resolving again, and every other owner still
 * resolves its own.
 */
export interface ProjectRulePolicy {
	readonly root: string;
	forFile(filePath: string): RulePolicyMap | undefined;
}

export function projectRulePolicy(
	root: string,
	known?: { filePath: string; map: RulePolicyMap | undefined },
): ProjectRulePolicy {
	const ownerByDir = new Map<string, string>();
	const mapByOwner = new Map<string, RulePolicyMap | undefined>();
	const ownerOf = (filePath: string): string => {
		const dir = nodePath.dirname(nodePath.resolve(root, filePath));
		let owner = ownerByDir.get(dir);
		if (owner === undefined) {
			owner = configOwnerFor(filePath, root);
			ownerByDir.set(dir, owner);
		}
		return owner;
	};
	// Seeded on the first lookup, so a dispatch with no findings walks nothing.
	let unseeded = known;
	return {
		root,
		forFile(filePath) {
			if (unseeded) {
				mapByOwner.set(ownerOf(unseeded.filePath), unseeded.map);
				unseeded = undefined;
			}
			const owner = ownerOf(filePath);
			if (!mapByOwner.has(owner)) {
				mapByOwner.set(
					owner,
					rulePolicyMapFromResolution(resolveDispatchPolicyConfig(owner), root),
				);
			}
			return mapByOwner.get(owner);
		},
	};
}

/** What a rule-policy filter accepts: one file's map, or a whole project's. */
export type RulePolicy = RulePolicyMap | ProjectRulePolicy;

function isProjectRulePolicy(
	policy: RulePolicy | Record<string, unknown>,
): policy is ProjectRulePolicy {
	return typeof (policy as { forFile?: unknown }).forFile === "function";
}

export function ruleIgnoredForPath(
	ruleId: string,
	filePath: string,
	root: string,
	policyMap: RulePolicyMap | undefined,
): boolean {
	const normalized = normalizeRuleId(ruleId);
	const scopes: RuleIgnoreScope[] = [];
	for (const [configuredId, entry] of Object.entries(policyMap ?? {})) {
		if (normalizeRuleId(configuredId) !== normalized || !entry?.ignorePaths)
			continue;
		const rootLines: string[] = [];
		for (const item of entry.ignorePaths) {
			if (typeof item === "string") rootLines.push(item);
			else scopes.push(item);
		}
		if (rootLines.length > 0)
			scopes.push({ baseDir: root, patterns: rootLines });
	}
	// The policy is intentionally project-wide like disable/select: a global
	// denial cannot be removed by a nearer project entry, so each scope answers
	// alone and any one of them ignoring the path carves it out.
	const absolute = nodePath.resolve(root, filePath);
	return scopes.some((scope) =>
		isIgnoredByGitignoreLines(scope.patterns, scope.baseDir, absolute),
	);
}

/**
 * Decide whether a rule id (in the form it's emitted on a diagnostic — e.g.
 * `ast-grep:no-eval`, `no-eval-js`, `no-eval`, `ts:2322`) should be filtered
 * out under a project's rule policy map. Returns `dropped: true` when the
 * diagnostic would be hidden from output.
 *
 * Project-wide: every `disable` entry across every configured key is checked
 * first (disable wins globally over select). Then every `select` entry
 * across every key is unioned into one allowlist — a non-empty union that
 * the rule doesn't match also drops it. An absent/empty union across all
 * keys means "no restriction". Matching uses the same normalization as
 * inline suppression so a configured `no-eval` entry covers
 * `ast-grep:no-eval` and `no-eval-js`.
 */
export function evaluateRulePolicy(
	ruleId: string,
	policyMap: RulePolicyMap | undefined,
): { dropped: boolean } {
	if (!policyMap) return { dropped: false };
	const raw = ruleId || "";
	const norm = normalizeRuleId(raw);

	if (scanList(policyMap, (e) => e.disable, raw, norm).matched) {
		return { dropped: true };
	}
	const select = scanList(policyMap, (e) => e.select, raw, norm);
	return { dropped: select.sawEntry && !select.matched };
}

/**
 * Union one list (`disable` or `select`) across every key in the map and test
 * the rule against it. `sawEntry` reports whether the union was non-empty,
 * which is what makes a `select` union restrictive rather than absent.
 */
function scanList(
	policyMap: RulePolicyMap,
	pick: (entry: RulePolicyEntry) => string[] | undefined,
	raw: string,
	norm: string,
): { matched: boolean; sawEntry: boolean } {
	let sawEntry = false;
	for (const entry of Object.values(policyMap)) {
		for (const candidate of (entry && pick(entry)) ?? []) {
			sawEntry = true;
			if (matchesRule(candidate, raw, norm)) return { matched: true, sawEntry };
		}
	}
	return { matched: false, sawEntry };
}

function matchesRule(entry: string, raw: string, normalized: string): boolean {
	if (entry === raw) return true;
	return normalizeRuleId(entry) === normalized;
}

/**
 * Filter an array of diagnostics (returns a new array) by the project rule
 * policy map. `rule` is preferred; code-only diagnostics use `code` as their
 * policy key so project-diagnostics details and rendered summaries cannot
 * disagree about a finding that has no explicit rule field. `Diagnostic.id`
 * remains a dedup key (`eslint:unknown:12`), not a policy key, so id-only
 * findings (including blocking parse errors) remain exempt.
 *
 * Used by both the per-edit dispatcher and the `lens-diagnostics` tool's
 * `mode=delta`/`mode=all`/`mode=full` paths so a project's own policy
 * applies consistently across every output surface. `policy` is one file's
 * map, applied to every diagnostic, or a {@link ProjectRulePolicy}, which
 * every surface that can see several files passes (the dispatcher included)
 * so each diagnostic reads its own file's config owner.
 */
export function applyRulePolicy<T extends { rule?: string; code?: string }>(
	diagnostics: T[],
	policy: RulePolicy | Record<string, unknown> | undefined,
	options: { root: string; filePath: string },
): T[] {
	if (!policy) return diagnostics;
	const project = isProjectRulePolicy(policy) ? policy : undefined;
	if (!project && !hasOutputFilter(policy as RulePolicyMap)) return diagnostics;
	// A project policy reads each diagnostic's own file's owner, matched against
	// the root the owner's map was anchored to.
	const anchored = project ? { ...options, root: project.root } : options;
	return diagnostics.filter((d) => {
		const map = project
			? project.forFile(
					(d as T & { filePath?: string }).filePath ?? options.filePath,
				)
			: (policy as RulePolicyMap);
		return !map || !hasOutputFilter(map) || keptByRulePolicy(d, map, anchored);
	});
}

/**
 * Fast-path: if every entry has neither disable nor select nor ignorePaths,
 * there is no output filter to apply. Keeps the hot path (most projects have
 * only thresholds) cheap.
 */
function hasOutputFilter(policyMap: Record<string, unknown>): boolean {
	for (const rawEntry of Object.values(policyMap)) {
		if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
			continue;
		}
		const entry = rawEntry as {
			disable?: string[];
			select?: string[];
			ignorePaths?: string[];
		};
		if (
			(entry.disable?.length ?? 0) > 0 ||
			(entry.select?.length ?? 0) > 0 ||
			(entry.ignorePaths?.length ?? 0) > 0
		) {
			return true;
		}
	}
	return false;
}

function keptByRulePolicy<T extends { rule?: string; code?: string }>(
	d: T,
	policyMap: RulePolicyMap,
	options: { root: string; filePath: string },
): boolean {
	const ruleId = d.rule ?? d.code;
	if (!ruleId) return true;
	const filePath =
		(d as T & { filePath?: string }).filePath ?? options.filePath;
	if (filePath && ruleIgnoredForPath(ruleId, filePath, options.root, policyMap))
		return false;
	const { dropped } = evaluateRulePolicy(ruleId, policyMap);
	return !dropped;
}

/**
 * Build the policy map from a `PiLensProjectConfig.rules`-shaped value. Returns
 * undefined when there's nothing to filter (the hot path), or a map suitable
 * for `applyRulePolicy` otherwise. Excludes entries whose only field is
 * `threshold` (a threshold is a separate concern handled elsewhere) so the
 * filter step doesn't repeat the work.
 */
export function rulePolicyMapFromConfig(
	rules: Record<string, unknown> | undefined,
): RulePolicyMap | undefined {
	if (!rules) return undefined;
	// `disable` and `select` members are read as the project parser reads them
	// (#5250): a string is trimmed, and a blank or non-string member is dropped.
	const members = (list: unknown): string[] =>
		Array.isArray(list)
			? list.flatMap((member) => {
					const trimmed = typeof member === "string" ? member.trim() : "";
					return trimmed.length > 0 ? [trimmed] : [];
				})
			: [];
	let built: RulePolicyMap | undefined;
	for (const [key, rawEntry] of Object.entries(rules)) {
		if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
			continue;
		}
		const entry = rawEntry as {
			disable?: unknown;
			select?: unknown;
			ignorePaths?: string[];
		};
		// A list that is blank after trimming is no list: an all-blank `select`
		// must not become an allowlist that matches no rule and hides every one.
		const disable = members(entry.disable);
		const select = members(entry.select);
		const hasIgnorePaths = (entry.ignorePaths?.length ?? 0) > 0;
		if (disable.length === 0 && select.length === 0 && !hasIgnorePaths) {
			continue;
		}
		built ??= {};
		built[key] = {
			...(disable.length > 0 ? { disable } : {}),
			...(select.length > 0 ? { select } : {}),
			...(hasIgnorePaths ? { ignorePaths: entry.ignorePaths } : {}),
		};
	}
	return built;
}
