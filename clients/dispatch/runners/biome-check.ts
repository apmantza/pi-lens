/**
 * Biome check runner for dispatch system
 *
 * Dispatch mode is diagnostics-only.
 * Autofix is handled earlier by the post-write pipeline to avoid
 * mutating files mid-dispatch after LSP sync has already happened.
 */

import * as path from "node:path";
import { incrementDegradationCount } from "../../degradation-ledger.js";
import { mapWithConcurrency } from "../../dependency-checker.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import {
	biomeConfigArgs,
	getAutofixCapability,
	getJstsLintPolicyForCwd,
} from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

import { resolveToolCommandWithInstallFallback } from "./utils/runner-helpers.js";
import { finishParsedRun } from "./utils/tool-failure.js";

interface BiomeDiagnostic {
	severity: "error" | "warning" | "info" | "hint";
	category: string;
	message: string;
	// Real `biome lint --reporter=json` output (probed against the shipped
	// 2.5.x binary for #1810) carries `location.path`, never `location.source`
	// — the field the parser and its fixtures assumed. There is also no
	// `tags` field on a real diagnostic; `d.tags?.includes("fixable")` always
	// missed, so `fixable`/`autoFixAvailable`/`fixKind` were permanently
	// false. See `resolveBiomeFixKinds` for the real fixability signal.
	location: {
		path: string;
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
}

/**
 * Map biome's own severity vocabulary onto the four-tier `Diagnostic.severity`
 * (clients/dispatch/types.ts), the same way `normalizeRuleSeverity` does for
 * ast-grep-napi post-#1787. Biome's real `lint --reporter=json` output
 * (re-probed live for #1810's review round) spells its info tier `"info"`,
 * not `"information"` — the value this switch matched before, which meant a
 * real info-tier diagnostic fell through the `default` and was silently
 * promoted to `"warning"`, one tier too loud. Every other tier is a direct
 * pass-through; an unrecognized value still falls back to `"warning"` — the
 * tier every biome diagnostic reported at before this fix, so reviving
 * hint/info never silently demotes an existing finding.
 */
export function normalizeBiomeSeverity(
	raw: BiomeDiagnostic["severity"] | undefined,
): Diagnostic["severity"] {
	switch (raw) {
		case "error":
			return "error";
		case "info":
			return "info";
		case "hint":
			return "hint";
		case "warning":
			return "warning";
		default:
			return "warning";
	}
}

/** Biome's own fix-safety tier for a rule (`biome explain <rule>`'s "Fix:" line). */
export type BiomeFixKind = "safe" | "unsafe" | "none";

/**
 * A diagnostic's `category` is `"lint/<group>/<ruleName>"` — extracts the
 * bare rule name `biome explain` expects. Returns `undefined` for anything
 * that isn't a `lint/` category (e.g. a parse-error pseudo-category), so
 * callers never look up fixability for a rule that was never a real rule.
 */
export function biomeRuleNameFromCategory(
	category: string | undefined,
): string | undefined {
	if (!category?.startsWith("lint/")) return undefined;
	const parts = category.split("/");
	return parts[parts.length - 1] || undefined;
}

export function parseBiomeJson(
	raw: string,
	filePath: string,
	fixKindByRule?: ReadonlyMap<string, BiomeFixKind>,
): { diagnostics: Diagnostic[]; parseError?: string } {
	try {
		const result = JSON.parse(raw);
		const diagnostics: BiomeDiagnostic[] = result.diagnostics || [];
		const autofix = getAutofixCapability("biome");

		return {
			diagnostics: diagnostics.map((d) => {
				const ruleName = biomeRuleNameFromCategory(d.category);
				const fixKind = ruleName ? fixKindByRule?.get(ruleName) : undefined;
				const isFixable = fixKind === "safe" || fixKind === "unsafe";

				return {
					id: `biome:${d.category}:${d.location.start.line}`,
					message: d.message,
					filePath,
					line: d.location.start.line,
					column: d.location.start.column,
					severity: normalizeBiomeSeverity(d.severity),
					semantic: d.severity === "error" ? "blocking" : ("warning" as const),
					tool: "biome",
					rule: d.category,
					fixable: isFixable,
					// Mirrors `biomeClient.fixFileAsync`'s own `lint --write` call
					// (no `--unsafe`, clients/biome-client.ts): the pipeline only
					// ever applies SAFE fixes, so only "safe" earns autoFixAvailable.
					autoFixAvailable:
						fixKind === "safe" && (autofix?.safePipelineAutofix ?? false),
					fixKind:
						isFixable && autofix?.fixKind !== "none"
							? autofix?.fixKind
							: undefined,
				};
			}),
		};
	} catch (err) {
		return {
			diagnostics: [],
			parseError: err instanceof Error ? err.message : String(err),
		};
	}
}

// Process-lifetime cache: a rule's fix kind is a static property of the
// (biome binary, rule name) pair, not of any one diagnostic occurrence, so
// it's resolved once and reused. Keyed on the resolved `cmd` so a different
// biome binary (e.g. a different project's pinned version) never reuses
// another binary's answer. Registered in
// tests/support/session-state-registry.ts as `process_lifetime` — the
// answer cannot change without a different biome binary, which is a
// different cache key, so there is nothing for a session boundary to
// invalidate.
const biomeFixKindCache = new Map<string, BiomeFixKind>();

/** Test-only: drop every cached verdict so a test starts from a clean cache. */
export function _resetBiomeFixKindCacheForTests(): void {
	biomeFixKindCache.clear();
}

const BIOME_FIX_KIND_PATTERN = /^-\s*Fix:\s*(safe|unsafe)\s*$/m;
// The explicit "no fix" statement `biome explain` prints for a rule with no
// autofix at all (e.g. `noConstantCondition`). Matching this SEPARATELY from
// "the safe/unsafe pattern didn't match" is the point (#1810 review F1/F2):
// only a POSITIVE read — either a stated fix tier or this explicit negative
// — is trustworthy enough to cache. Anything else (a differently-shaped
// `explain` output, e.g. a biome 1.x install) is a parse failure, not a
// verdict, and must never be cached as one.
const BIOME_NO_FIX_PATTERN = /^-\s*No fix available\.\s*$/m;

/** At most this many `biome explain` spawns run concurrently (#1810 review F6). */
const EXPLAIN_CONCURRENCY = 4;

/**
 * Resolves each rule referenced by `categories` to its fix kind via
 * `biome explain <rule>` — the one place biome's shipped CLI states
 * fixability as structured text (`- Fix: safe|unsafe`, or `- No fix
 * available.` when absent), sourced live from the running binary's own rule
 * registry rather than a hand-maintained table (#1810; real diagnostics
 * carry no per-occurrence fixability field — see `BiomeDiagnostic`).
 *
 * Only a POSITIVE read is cached: either `- Fix: safe|unsafe` or the
 * explicit `- No fix available.` statement. A spawn failure, a nonzero
 * exit, or output that matches NEITHER pattern (e.g. a biome 1.x install —
 * its `explain` text differs and would otherwise poison every rule as
 * permanently unfixable, #1810 review F1) resolves to `"none"` for THIS
 * call only and is never written to the cache — caching an unparsed result
 * would permanently under-report a genuinely fixable rule for the rest of
 * the process's life (the never-cache-a-transient-failure screen).
 */
export async function resolveBiomeFixKinds(
	cmd: string,
	cwd: string,
	categories: Iterable<string | undefined>,
): Promise<Map<string, BiomeFixKind>> {
	const resolved = new Map<string, BiomeFixKind>();
	const ruleNames = new Set<string>();
	for (const category of categories) {
		const ruleName = biomeRuleNameFromCategory(category);
		if (ruleName) ruleNames.add(ruleName);
	}
	const toResolve: string[] = [];
	for (const ruleName of ruleNames) {
		const cacheKey = `${cmd}::${ruleName}`;
		const cached = biomeFixKindCache.get(cacheKey);
		if (cached === undefined) {
			toResolve.push(ruleName);
		} else {
			resolved.set(ruleName, cached);
		}
	}

	await mapWithConcurrency(toResolve, EXPLAIN_CONCURRENCY, async (ruleName) => {
		const cacheKey = `${cmd}::${ruleName}`;

		const spawned = await safeSpawnAsync(cmd, ["explain", ruleName], {
			timeout: 10000,
			cwd,
		});
		if (spawned.error || spawned.status !== 0) {
			incrementDegradationCount({
				kind: "biome-explain-unavailable",
				subject: ruleName,
				reason: spawned.error
					? `spawn failed: ${spawned.error}`
					: `explain exited ${spawned.status}`,
			});
			resolved.set(ruleName, "none");
			return;
		}

		const stdout = spawned.stdout || "";
		const fixMatch = stdout.match(BIOME_FIX_KIND_PATTERN);
		if (fixMatch) {
			const kind: BiomeFixKind = fixMatch[1] === "safe" ? "safe" : "unsafe";
			biomeFixKindCache.set(cacheKey, kind);
			resolved.set(ruleName, kind);
			return;
		}
		if (BIOME_NO_FIX_PATTERN.test(stdout)) {
			biomeFixKindCache.set(cacheKey, "none");
			resolved.set(ruleName, "none");
			return;
		}

		// Neither pattern matched — an unrecognized `explain` output shape, not
		// a confirmed negative. Resolve to "none" for this call, but leave the
		// cache untouched so the next batch retries against real output.
		incrementDegradationCount({
			kind: "biome-explain-unavailable",
			subject: ruleName,
			reason: "explain output matched neither the Fix nor No-fix pattern",
		});
		resolved.set(ruleName, "none");
	});

	return resolved;
}

const biomeCheckJsonRunner: RunnerDefinition = {
	id: "biome-check-json",
	appliesTo: ["jsts"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || path.dirname(ctx.filePath);
		const policy = getJstsLintPolicyForCwd(cwd);

		// Defer to ESLint/oxlint if the project has explicitly configured one —
		// biome runs as the default linter only when no alternative is present.
		if (!policy.hasBiomeConfig && policy.hasExplicitNonBiomeLinter) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = await resolveToolCommandWithInstallFallback(cwd, "biome");
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Shared config-args seam (#1247): `biomeClient.fixFileAsync` consumes
		// the same builder, so the user's config / package fallback applies on
		// `lint --write` too.
		const configArg = biomeConfigArgs(cwd);

		// Run biome lint (diagnostics only - format is handled separately)
		const checkResult = await safeSpawnAsync(
			cmd,
			[
				"lint",
				"--reporter=json",
				"--no-errors-on-unmatched",
				...configArg,
				ctx.filePath,
			],
			{ timeout: 30000, cwd },
		);

		// Handle spawn errors (e.g., binary not found)
		if (checkResult.error) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let fixKindByRule: Map<string, BiomeFixKind> | undefined;
		if (checkResult.status === 0 || checkResult.status === 1) {
			// Cheap pre-parse just to collect rule categories — the real parse
			// (with parseError handling) happens below via parseBiomeJson. A
			// malformed-JSON pre-parse simply yields no categories, and
			// `resolveBiomeFixKinds` no-ops on an empty list (no spawn, an
			// immediately-resolved empty map) — the real parse still surfaces
			// the parseError diagnostic as before.
			let categories: (string | undefined)[] = [];
			try {
				const preParsed = JSON.parse(checkResult.stdout || "{}");
				categories = (preParsed.diagnostics || []).map(
					(d: { category?: string }) => d.category,
				);
			} catch {
				categories = [];
			}
			fixKindByRule = await resolveBiomeFixKinds(cmd, cwd, categories);
		}

		const parsed =
			checkResult.status === 0 || checkResult.status === 1
				? parseBiomeJson(checkResult.stdout || "", ctx.filePath, fixKindByRule)
				: { diagnostics: [] as Diagnostic[] };

		if (parsed.parseError) {
			const raw = checkResult.stdout || checkResult.stderr || "";
			const preview = raw.replace(/\s+/g, " ").slice(0, 160);
			return {
				status: "failed",
				diagnostics: [
					{
						id: "biome:parse-error:1",
						message:
							"Biome JSON parse failed: " +
							parsed.parseError +
							(preview ? " (output preview: " + preview + ")" : ""),
						filePath: ctx.filePath,
						line: 1,
						column: 1,
						severity: "warning",
						semantic: "warning",
						tool: "biome",
					},
				],
				semantic: "warning",
			};
		}

		return finishParsedRun({
			tool: "biome",
			ctx,
			result: checkResult,
			diagnostics: parsed.diagnostics,
		});
	},
};

export default biomeCheckJsonRunner;
