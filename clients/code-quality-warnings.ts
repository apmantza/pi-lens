import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheManager, ModifiedRange } from "./cache-manager.js";
import type { Diagnostic } from "./dispatch/types.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import { getProjectDataDir } from "./file-utils.js";
import { normalizeMapKey } from "./path-utils.js";

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

export interface CodeQualityWarningsHistoryEntry {
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
		topRules: Array<{ rule: string; count: number }>;
	};
}

function normalizeMessage(message: string): string {
	return message.replace(/\s+/g, " ").trim().toLowerCase();
}

function hashText(value: string, length = 10): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function relativeFile(filePath: string, cwd: string): string {
	const rel = path.relative(cwd, filePath).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") ? rel : normalizeMapKey(filePath);
}

function createCodeQualityWarningId(args: {
	cwd: string;
	filePath: string;
	tool?: string;
	rule?: string;
	code?: string | number;
	message: string;
	line?: number;
}): string {
	const parts = [
		relativeFile(args.filePath, args.cwd),
		args.tool ?? "",
		args.rule ?? "",
		String(args.code ?? ""),
		normalizeMessage(args.message),
		String(args.line ?? ""),
	];
	return `cq:${hashText(parts.join("|"))}`;
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
	const merged = [...byId.values()]
		.sort(
			(a, b) =>
				a.displayPath.localeCompare(b.displayPath) ||
				(a.line ?? 0) - (b.line ?? 0) ||
				a.message.localeCompare(b.message),
		)
		.slice(0, maxWarnings);

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
			topRules,
		},
	};
}

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
		file.warnings.map(
			(warning): CodeQualityWarningsHistoryEntry => ({
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
			}),
		),
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

export function formatCodeQualityWarningsAdvisory(
	report: CodeQualityWarningsReport,
): string | undefined {
	if (report.summary.warnings === 0) return undefined;
	const topRules = report.summary.topRules
		.slice(0, 3)
		.map((entry) => `${entry.rule}×${entry.count}`)
		.join(", ");
	return [
		`Code-quality warnings introduced/touched this turn: ${report.summary.warnings} across ${report.summary.files} file(s).`,
		topRules ? `Top rules: ${topRules}` : undefined,
		"Details written to .pi-lens/cache/code-quality-warnings.json",
		"No action required unless you are already refactoring these areas.",
	]
		.filter(Boolean)
		.join("\n");
}
