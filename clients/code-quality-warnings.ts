import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheManager, ModifiedRange } from "./cache-manager.js";
import type { Diagnostic } from "./dispatch/types.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import { displayProjectDataPath, getProjectDataDir } from "./file-utils.js";
import { normalizeMessage, stableFindingId } from "./finding-identity.js";
import { normalizeMapKey } from "./path-utils.js";
import { resolveLensToolName, type LensToolHost } from "./tool-config.js";

export interface CodeQualityWarningRecord {
	id: string;
	filePath: string;
	displayPath: string;
	line?: number;
	column?: number;
	severity: "warning" | "info" | "hint";
	tool: string;
	rule?: string;
	code?: string;
	message: string;
	category:
		| "maintainability"
		| "type-safety"
		| "duplication"
		| "style"
		| "other";
	origin: "dispatch";
}

interface CodeQualityWarningsHistoryEntry {
	timestamp: string;
	sessionId: string;
	turnIndex: number;
	projectSeq?: number;
	filePath: string;
	displayPath: string;
	fileSeq?: number;
	line?: number;
	column?: number;
	severity: "warning" | "info" | "hint";
	tool: string;
	rule?: string;
	code?: string;
	message: string;
	category: CodeQualityWarningRecord["category"];
	warningId: string;
}

export interface CodeQualityWarningsReport {
	generatedAt: string;
	scope: "turn_delta";
	sessionId: string;
	turnIndex: number;
	projectSeqStart?: number;
	projectSeqEnd?: number;
	deltaOnly: true;
	files: Array<{
		filePath: string;
		displayPath: string;
		fileSeq?: number;
		warnings: CodeQualityWarningRecord[];
	}>;
	summary: {
		warnings: number;
		files: number;
		/**
		 * Per-tier split of `warnings` (#1777). The dispatch path preserves a
		 * rule's declared severity, so the quiet tiers are countable instead of
		 * being folded into `warning`.
		 *
		 * OPTIONAL on purpose: this report is persisted to
		 * `<project-data-dir>/cache/code-quality-warnings.json` and read back by
		 * `tools/lens-diagnostics.ts`, which can find a file written by a
		 * pi-lens build that predates the field. Readers must tolerate absence.
		 */
		byTier?: { warning: number; info: number; hint: number };
		topRules: Array<{ rule: string; count: number }>;
	};
}

/**
 * Report-budget precedence (#1777). A hint is an opinion; a warning is a
 * finding. When the report is capped, warnings must be spent first, or an
 * alphabetically-early file's hints can push every real warning out of the
 * agent's view — the exact "hints dominate the stream" failure the hint tier
 * exists to prevent.
 */
const TIER_BUDGET_ORDER: Array<CodeQualityWarningRecord["severity"]> = [
	"warning",
	"info",
	"hint",
];

/** #1816: was a local `relativeFile|tool|rule|code|normalizedMessage|line`
 * hash (raw, non-canonicalized `relativeFile`, 10-char hash), independently
 * hand-rolled from `actionable-warnings.ts`'s twin and
 * `diagnostic-dispositions.ts`'s canonicalizing original. Now the shared
 * `finding-identity.js` builder (canonicalizes `cwd`/`filePath` through
 * `normalizeMapKey`, hashes to 12 chars). No back-compat migration needed
 * here: `cq:` ids are never a keyed lookup — `buildCodeQualityWarningsReport`
 * regenerates the whole report fresh every turn, callers only ever cache and
 * replay the report wholesale (`tools/lens-diagnostics.ts` reads it via
 * `cacheManager.readCache<CodeQualityWarningsReport>`, never by `id`), and
 * `appendCodeQualityWarningsHistory` just append-only-logs the id for
 * observability, never look it back up. Contrast `actionable-warnings.ts`,
 * whose `actionable-warning-state.json` DOES key a persisted suppression
 * store on `aw:` — that one migrates. */
function createCodeQualityWarningId(args: {
	cwd: string;
	filePath: string;
	tool?: string;
	rule?: string;
	code?: string | number;
	message: string;
	line?: number;
}): string {
	return stableFindingId("cq:", {
		cwd: args.cwd,
		filePath: args.filePath,
		parts: [
			args.tool,
			args.rule,
			args.code,
			normalizeMessage(args.message),
			args.line,
		],
	});
}

function categorize(
	diagnostic: Diagnostic,
): CodeQualityWarningRecord["category"] {
	const haystack =
		`${diagnostic.tool} ${diagnostic.rule ?? ""} ${diagnostic.code ?? ""} ${diagnostic.message}`.toLowerCase();
	if (haystack.includes("type") || haystack.includes("any"))
		return "type-safety";
	if (
		haystack.includes("complex") ||
		haystack.includes("fan-out") ||
		haystack.includes("fanout")
	)
		return "maintainability";
	if (haystack.includes("duplicate") || haystack.includes("similar"))
		return "duplication";
	if (haystack.includes("style") || haystack.includes("format")) return "style";
	return "other";
}

function lineInModifiedRanges(
	line: number | undefined,
	ranges: ModifiedRange[],
): boolean {
	if (line === undefined) return true;
	if (ranges.length === 0) return true;
	return ranges.some(
		(range) => line >= range.start - 2 && line <= range.end + 2,
	);
}

export function recordFromCodeQualityDiagnostic(
	diagnostic: Diagnostic,
	cwd: string,
): CodeQualityWarningRecord | undefined {
	if (diagnostic.semantic !== "warning" && diagnostic.semantic !== "none")
		return undefined;
	if (diagnostic.severity === "error") return undefined;
	if (
		diagnostic.fixable ||
		diagnostic.fixSuggestion ||
		diagnostic.autoFixAvailable
	)
		return undefined;

	const filePath = path.resolve(cwd, diagnostic.filePath);
	return {
		id: createCodeQualityWarningId({
			cwd,
			filePath,
			tool: diagnostic.tool,
			rule: diagnostic.rule,
			code: diagnostic.code,
			message: diagnostic.message,
			line: diagnostic.line,
		}),
		filePath,
		displayPath: toRunnerDisplayPath(cwd, filePath),
		line: diagnostic.line,
		column: diagnostic.column,
		severity:
			diagnostic.severity === "hint"
				? "hint"
				: diagnostic.severity === "info"
					? "info"
					: "warning",
		tool: diagnostic.tool,
		rule: diagnostic.rule,
		code: diagnostic.code,
		message: diagnostic.message,
		category: categorize(diagnostic),
		origin: "dispatch",
	};
}

export function buildCodeQualityWarningsReport(args: {
	cwd: string;
	sessionId: string;
	turnIndex: number;
	warnings: CodeQualityWarningRecord[];
	modifiedRangesByFile: Map<string, ModifiedRange[]>;
	projectSeqStart?: number;
	projectSeqEnd?: number;
	fileSeqByPath?: Map<string, number>;
	maxWarnings?: number;
}): CodeQualityWarningsReport {
	const cwd = path.resolve(args.cwd);
	const maxWarnings = Math.max(1, args.maxWarnings ?? 50);
	const byId = new Map<string, CodeQualityWarningRecord>();
	for (const warning of args.warnings) {
		const ranges =
			args.modifiedRangesByFile.get(normalizeMapKey(warning.filePath)) ?? [];
		if (!lineInModifiedRanges(warning.line, ranges)) continue;
		byId.set(warning.id, warning);
	}
	const byDisplayOrder = (
		a: CodeQualityWarningRecord,
		b: CodeQualityWarningRecord,
	): number =>
		a.displayPath.localeCompare(b.displayPath) ||
		(a.line ?? 0) - (b.line ?? 0) ||
		a.message.localeCompare(b.message);

	// Spend the budget tier by tier (see TIER_BUDGET_ORDER), then restore
	// display order so the report still reads file by file, line by line.
	const candidates = [...byId.values()].sort(byDisplayOrder);
	const merged: CodeQualityWarningRecord[] = [];
	for (const tier of TIER_BUDGET_ORDER) {
		for (const warning of candidates) {
			if (merged.length >= maxWarnings) break;
			if (warning.severity === tier) merged.push(warning);
		}
	}
	merged.sort(byDisplayOrder);

	const byFile = new Map<string, CodeQualityWarningRecord[]>();
	for (const warning of merged) {
		const arr = byFile.get(warning.filePath) ?? [];
		arr.push(warning);
		byFile.set(warning.filePath, arr);
	}
	const files = [...byFile.entries()].map(([filePath, warnings]) => ({
		filePath,
		displayPath: toRunnerDisplayPath(cwd, filePath),
		fileSeq: args.fileSeqByPath?.get(normalizeMapKey(filePath)),
		warnings,
	}));
	const ruleCounts = new Map<string, number>();
	for (const warning of merged) {
		const rule = warning.rule ?? warning.tool;
		ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
	}
	const topRules = [...ruleCounts.entries()]
		.map(([rule, count]) => ({ rule, count }))
		.sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule))
		.slice(0, 8);

	return {
		generatedAt: new Date().toISOString(),
		scope: "turn_delta",
		sessionId: args.sessionId,
		turnIndex: args.turnIndex,
		projectSeqStart: args.projectSeqStart,
		projectSeqEnd: args.projectSeqEnd,
		deltaOnly: true,
		files,
		summary: {
			warnings: merged.length,
			files: files.length,
			byTier: {
				warning: merged.filter((w) => w.severity === "warning").length,
				info: merged.filter((w) => w.severity === "info").length,
				hint: merged.filter((w) => w.severity === "hint").length,
			},
			topRules,
		},
	};
}

/**
 * #557 audit (same race class as #555's LSP client fix and #560's
 * `widget-state.ts` `recordDiagnostics` fix): pi-lens deliberately allows
 * concurrent pipeline runs for the SAME file across DIFFERENT same-turn
 * edits (dedupe key is `filePath + contentHash`, not just `filePath` — see
 * `clients/runtime-tool-result.ts`), so a per-key cache fed directly from
 * those concurrent pipeline runs needs an ordering guard (`WriteOrderingGuard`
 * from `clients/write-ordering-guard.ts`) or an older edit's slower pipeline
 * can silently overwrite a newer edit's fresher write.
 *
 * This call site is NOT exposed to that race. Unlike `widget-state.ts`'s
 * `recordDiagnostics` (called directly from `clients/pipeline.ts`, once per
 * pipeline run — i.e. potentially several times per turn, out of completion
 * order), `writeCodeQualityWarningsReport` has exactly one caller:
 * `handleTurnEnd` in `clients/runtime-turn.ts`, which per-edit pipeline runs
 * never call directly — they only feed `runtime.recordCodeQualityWarnings`
 * (an accumulating, order-independent Map). `handleTurnEnd` itself reads that
 * accumulator once via `runtime.peekCodeQualityWarnings()` and writes the
 * aggregate report exactly once per turn-end invocation — the same single
 * sequential turn-end-only shape already confirmed safe for
 * `writeActionableWarningsReport` in `clients/actionable-warnings.ts`, right
 * next to this call site in `handleTurnEnd`. No second writer, so no
 * ordering token to guard against — see
 * `tests/clients/code-quality-warnings.test.ts`'s
 * "single sequential caller" test, which pins this invariant so a future
 * change that adds a second call site has a better chance of being caught.
 */
export function writeCodeQualityWarningsReport(
	cacheManager: CacheManager,
	cwd: string,
	report: CodeQualityWarningsReport,
): void {
	cacheManager.writeCache("code-quality-warnings", report, cwd);
}

export function getCodeQualityWarningsHistoryPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "code-quality-warnings.jsonl");
}

export function appendCodeQualityWarningsHistory(
	cwd: string,
	report: CodeQualityWarningsReport,
): void {
	const warnings = report.files.flatMap((file) =>
		file.warnings.map((warning): CodeQualityWarningsHistoryEntry => ({
			timestamp: report.generatedAt,
			sessionId: report.sessionId,
			turnIndex: report.turnIndex,
			projectSeq: report.projectSeqEnd,
			filePath: warning.filePath,
			displayPath: warning.displayPath,
			fileSeq: file.fileSeq,
			line: warning.line,
			column: warning.column,
			severity: warning.severity,
			tool: warning.tool,
			rule: warning.rule,
			code: warning.code,
			message: warning.message,
			category: warning.category,
			warningId: warning.id,
		})),
	);
	if (warnings.length === 0) return;
	const historyPath = getCodeQualityWarningsHistoryPath(cwd);
	try {
		fs.mkdirSync(path.dirname(historyPath), { recursive: true });
		fs.appendFileSync(
			historyPath,
			`${warnings.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			"utf8",
		);
	} catch {
		// Non-fatal — history write failure should never surface to the agent.
	}
}

/**
 * The turn-end advisory for this report.
 *
 * `cwd` is REQUIRED for the same reason as
 * {@link formatActionableWarningsAdvisory} (#2521): this advisory carried the
 * identical hardcoded-legacy-path defect, one cache key over.
 */
export function formatCodeQualityWarningsAdvisory(
	report: CodeQualityWarningsReport,
	cwd: string,
	host: LensToolHost = "pi",
): string | undefined {
	if (report.summary.warnings === 0) return undefined;
	const topRules = report.summary.topRules
		.slice(0, 3)
		.map((entry) => `${entry.rule}×${entry.count}`)
		.join(", ");
	// #1777: name the tiers, in the same descending-loudness order the on-demand
	// ast-grep surface uses (`formatDiagnostics`, clients/ast-grep-client.ts).
	// A tier with no findings is omitted rather than printed as zero.
	const byTier = report.summary.byTier ?? { warning: 0, info: 0, hint: 0 };
	// The line is worth its space only when a quiet tier is present; an
	// all-warning turn already says everything in the count above.
	const tiers =
		byTier.hint || byTier.info
			? [
					byTier.warning ? `${byTier.warning} warning` : undefined,
					byTier.info ? `${byTier.info} info` : undefined,
					byTier.hint ? `${byTier.hint} hint` : undefined,
				]
					.filter(Boolean)
					.join(", ")
			: "";
	return [
		`Code-quality warnings introduced/touched this turn: ${report.summary.warnings} across ${report.summary.files} file(s).`,
		tiers
			? `By tier: ${tiers}. Hint and info are style opinions, not defects.`
			: undefined,
		topRules ? `Top rules: ${topRules}` : undefined,
		// #2521: tool route first (`mode=delta` covers the code-quality cache
		// as well as the actionable one), resolved path second.
		`Use ${resolveLensToolName("lens_diagnostics", host)} with mode=delta to inspect these warnings.`,
		"No action required unless you are already refactoring these areas.",
		`Raw report (only if you need the JSON): ${displayProjectDataPath(
			cwd,
			"cache",
			"code-quality-warnings.json",
		)}`,
	]
		.filter(Boolean)
		.join("\n");
}
