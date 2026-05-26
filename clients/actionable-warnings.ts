import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheManager, ModifiedRange } from "./cache-manager.js";
import type { Diagnostic } from "./dispatch/types.js";
import type { LSPCodeAction, LSPDiagnostic } from "./lsp/client.js";
import { applyWorkspaceEdit } from "./lsp/edits.js";
import { getLSPService } from "./lsp/index.js";
import { normalizeMapKey } from "./path-utils.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import { logActionableWarningsEvent } from "./actionable-warnings-logger.js";

export interface ActionableWarningAction {
	title: string;
	kind?: string;
	isPreferred?: boolean;
	hasEdit: boolean;
	hasCommand: boolean;
	autoFixEligible: boolean;
	skipReason?: string;
}

export interface ActionableWarningRecord {
	id: string;
	filePath: string;
	displayPath: string;
	line?: number;
	column?: number;
	severity: "warning" | "error" | "info" | "hint";
	tool: string;
	source?: string;
	code?: string;
	rule?: string;
	message: string;
	fixSuggestion?: string;
	fixKind?: string;
	autoFixAvailable?: boolean;
	actions: ActionableWarningAction[];
	suppressed: boolean;
	suppressionReason?: string;
	origin: "dispatch" | "lsp" | "merged";
}

export interface ActionableWarningsReport {
	generatedAt: string;
	scope: "turn_delta";
	sessionId: string;
	turnIndex: number;
	projectSeqStart?: number;
	projectSeqEnd?: number;
	deltaOnly: boolean;
	includeLspCodeActions: boolean;
	files: Array<{
		filePath: string;
		displayPath: string;
		fileSeq?: number;
		warnings: ActionableWarningRecord[];
	}>;
	summary: {
		warnings: number;
		unsuppressed: number;
		suppressed: number;
		files: number;
		actions: number;
		autoFixEligible: number;
	};
}

interface WarningSuppressionEntry {
	status?: "suppressed" | "active" | "resolved";
	reason?: string;
	firstSeenAt?: string;
	lastSeenAt?: string;
	resolvedAt?: string;
	seenCount?: number;
}

interface WarningStateFile {
	warnings?: Record<string, WarningSuppressionEntry>;
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

export function createActionableWarningId(args: {
	cwd: string;
	filePath: string;
	tool?: string;
	source?: string;
	code?: string | number;
	rule?: string;
	message: string;
	line?: number;
}): string {
	const parts = [
		relativeFile(args.filePath, args.cwd),
		args.tool ?? "",
		args.source ?? "",
		String(args.code ?? ""),
		args.rule ?? "",
		normalizeMessage(args.message),
		String(args.line ?? ""),
	];
	return `aw:${hashText(parts.join("|"))}`;
}

function actionSafety(action: LSPCodeAction): {
	eligible: boolean;
	reason?: string;
} {
	const kind = action.kind ?? "";
	if (!kind.startsWith("quickfix"))
		return { eligible: false, reason: "not_quickfix" };
	if (!action.isPreferred) return { eligible: false, reason: "not_preferred" };
	if (!action.edit) return { eligible: false, reason: "no_edit" };
	if (action.command) return { eligible: false, reason: "has_command" };
	return { eligible: true };
}

function serializeAction(action: LSPCodeAction): ActionableWarningAction {
	const safety = actionSafety(action);
	return {
		title: action.title,
		kind: action.kind,
		isPreferred: action.isPreferred,
		hasEdit: Boolean(action.edit),
		hasCommand: Boolean(action.command),
		autoFixEligible: safety.eligible,
		skipReason: safety.reason,
	};
}

function readSuppressionState(cwd: string): WarningStateFile {
	const statePath = path.join(
		cwd,
		".pi-lens",
		"cache",
		"actionable-warning-state.json",
	);
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as WarningStateFile)
			: {};
	} catch {
		return {};
	}
}

function updateWarningState(
	cwd: string,
	warnings: ActionableWarningRecord[],
): void {
	const statePath = path.join(
		cwd,
		".pi-lens",
		"cache",
		"actionable-warning-state.json",
	);
	const now = new Date().toISOString();
	const state = readSuppressionState(cwd);
	state.warnings ??= {};
	for (const warning of warnings) {
		const existing = state.warnings[warning.id] ?? {};
		state.warnings[warning.id] = {
			...existing,
			status: existing.status ?? "active",
			firstSeenAt: existing.firstSeenAt ?? now,
			lastSeenAt: now,
			seenCount: (existing.seenCount ?? 0) + 1,
		};
	}
	fs.mkdirSync(path.dirname(statePath), { recursive: true });
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function suppressionFor(
	cwd: string,
	id: string,
): { suppressed: boolean; reason?: string } {
	const entry = readSuppressionState(cwd).warnings?.[id];
	return {
		suppressed: entry?.status === "suppressed",
		reason: entry?.reason,
	};
}

export function recordFromDispatchDiagnostic(
	diagnostic: Diagnostic,
	cwd: string,
): ActionableWarningRecord | undefined {
	if (diagnostic.semantic !== "warning" || diagnostic.severity !== "warning")
		return undefined;
	if (!diagnostic.fixable && !diagnostic.fixSuggestion) return undefined;
	const filePath = path.resolve(cwd, diagnostic.filePath);
	const id = createActionableWarningId({
		cwd,
		filePath,
		tool: diagnostic.tool,
		code: diagnostic.code,
		rule: diagnostic.rule,
		message: diagnostic.message,
		line: diagnostic.line,
	});
	const suppression = suppressionFor(cwd, id);
	return {
		id,
		filePath,
		displayPath: toRunnerDisplayPath(cwd, filePath),
		line: diagnostic.line,
		column: diagnostic.column,
		severity: "warning",
		tool: diagnostic.tool,
		code: diagnostic.code,
		rule: diagnostic.rule,
		message: diagnostic.message,
		fixSuggestion: diagnostic.fixSuggestion,
		fixKind: diagnostic.fixKind,
		autoFixAvailable: diagnostic.autoFixAvailable,
		actions: [],
		suppressed: suppression.suppressed,
		suppressionReason: suppression.reason,
		origin: "dispatch",
	};
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

function recordFromLspDiagnostic(
	diag: LSPDiagnostic,
	filePath: string,
	cwd: string,
): ActionableWarningRecord {
	const line = diag.range.start.line + 1;
	const column = diag.range.start.character + 1;
	const source = diag.source ?? "lsp";
	const code = diag.code === undefined ? undefined : String(diag.code);
	const id = createActionableWarningId({
		cwd,
		filePath,
		tool: "lsp",
		source,
		code,
		message: diag.message,
		line,
	});
	const suppression = suppressionFor(cwd, id);
	return {
		id,
		filePath,
		displayPath: toRunnerDisplayPath(cwd, filePath),
		line,
		column,
		severity: "warning",
		tool: "lsp",
		source,
		code,
		rule: code ? `${source}:${code}` : source,
		message: diag.message,
		actions: [],
		suppressed: suppression.suppressed,
		suppressionReason: suppression.reason,
		origin: "lsp",
	};
}

function mergeWarnings(
	records: ActionableWarningRecord[],
): ActionableWarningRecord[] {
	const byId = new Map<string, ActionableWarningRecord>();
	for (const record of records) {
		const existing = byId.get(record.id);
		if (!existing) {
			byId.set(record.id, { ...record, actions: [...record.actions] });
			continue;
		}
		existing.origin =
			existing.origin === record.origin ? existing.origin : "merged";
		existing.fixSuggestion ??= record.fixSuggestion;
		existing.fixKind ??= record.fixKind;
		existing.autoFixAvailable ||= record.autoFixAvailable;
		const seenActions = new Set(
			existing.actions.map((a) => `${a.kind ?? ""}|${a.title}`),
		);
		for (const action of record.actions) {
			const key = `${action.kind ?? ""}|${action.title}`;
			if (!seenActions.has(key)) {
				existing.actions.push(action);
				seenActions.add(key);
			}
		}
	}
	return [...byId.values()].sort(
		(a, b) =>
			a.displayPath.localeCompare(b.displayPath) ||
			(a.line ?? 0) - (b.line ?? 0),
	);
}

export async function buildActionableWarningsReport(args: {
	cwd: string;
	sessionId: string;
	turnIndex: number;
	files: string[];
	modifiedRangesByFile: Map<string, ModifiedRange[]>;
	dispatchWarnings: ActionableWarningRecord[];
	includeLspCodeActions: boolean;
	projectSeqStart?: number;
	projectSeqEnd?: number;
	fileSeqByPath?: Map<string, number>;
	deltaOnly?: boolean;
	dbg?: (msg: string) => void;
}): Promise<ActionableWarningsReport> {
	const cwd = path.resolve(args.cwd);
	const records: ActionableWarningRecord[] = [...args.dispatchWarnings];
	const lspService = getLSPService();

	logActionableWarningsEvent({
		event: "report_started",
		sessionId: args.sessionId,
		metadata: {
			turnIndex: args.turnIndex,
			filesCount: args.files.length,
			dispatchWarningsCount: args.dispatchWarnings.length,
			deltaOnly: args.deltaOnly !== false,
			includeLspCodeActions: args.includeLspCodeActions,
		},
	});

	if (args.includeLspCodeActions) {
		for (const file of args.files) {
			const filePath = path.resolve(cwd, file);
			if (!lspService.supportsLSP(filePath)) {
				logActionableWarningsEvent({
					event: "lsp_file_skipped",
					sessionId: args.sessionId,
					filePath,
					metadata: { reason: "no_lsp_support" },
				});
				continue;
			}
			let diags: LSPDiagnostic[] = [];
			try {
				const content = fs.existsSync(filePath)
					? fs.readFileSync(filePath, "utf-8")
					: undefined;
				if (content) await lspService.openFile(filePath, content);
				diags = await lspService.getDiagnostics(filePath);
			} catch (err) {
				args.dbg?.(
					`actionable_warnings: LSP diagnostics failed for ${filePath}: ${err}`,
				);
				logActionableWarningsEvent({
					event: "lsp_file_skipped",
					sessionId: args.sessionId,
					filePath,
					metadata: { reason: "lsp_error", error: String(err) },
				});
				continue;
			}
			const ranges =
				args.modifiedRangesByFile.get(normalizeMapKey(filePath)) ?? [];
			const diagsWarning = diags.filter((d) => d.severity === 2);
			let deltaFiltered = 0;
			let enriched = 0;
			for (const diag of diagsWarning) {
				const line = diag.range.start.line + 1;
				if (args.deltaOnly !== false && !lineInModifiedRanges(line, ranges)) {
					deltaFiltered++;
					continue;
				}
				const record = recordFromLspDiagnostic(diag, filePath, cwd);
				try {
					const actions = await lspService.codeAction(
						filePath,
						diag.range.start.line,
						diag.range.start.character,
						diag.range.end.line,
						diag.range.end.character,
					);
					record.actions = actions.map(serializeAction).slice(0, 5);
				} catch (err) {
					args.dbg?.(
						`actionable_warnings: LSP codeAction failed for ${filePath}: ${err}`,
					);
				}
				if (record.actions.length > 0) {
					records.push(record);
					enriched++;
				}
			}
			logActionableWarningsEvent({
				event: "lsp_file_checked",
				sessionId: args.sessionId,
				filePath,
				metadata: {
					diagsTotal: diags.length,
					diagsWarning: diagsWarning.length,
					deltaFiltered,
					enriched,
					modifiedRangesCount: ranges.length,
				},
			});
		}
	}

	const merged = mergeWarnings(records);
	updateWarningState(cwd, merged);
	const byFile = new Map<string, ActionableWarningRecord[]>();
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
	const allActions = merged.flatMap((warning) => warning.actions);
	const summary = {
		warnings: merged.length,
		unsuppressed: merged.filter((warning) => !warning.suppressed).length,
		suppressed: merged.filter((warning) => warning.suppressed).length,
		files: files.length,
		actions: allActions.length,
		autoFixEligible: allActions.filter((action) => action.autoFixEligible)
			.length,
	};

	logActionableWarningsEvent({
		event: "report_complete",
		sessionId: args.sessionId,
		metadata: { turnIndex: args.turnIndex, summary },
	});

	return {
		generatedAt: new Date().toISOString(),
		scope: "turn_delta",
		sessionId: args.sessionId,
		turnIndex: args.turnIndex,
		projectSeqStart: args.projectSeqStart,
		projectSeqEnd: args.projectSeqEnd,
		deltaOnly: args.deltaOnly !== false,
		includeLspCodeActions: args.includeLspCodeActions,
		files,
		summary,
	};
}

export function writeActionableWarningsReport(
	cacheManager: CacheManager,
	cwd: string,
	report: ActionableWarningsReport,
): void {
	cacheManager.writeCache("actionable-warnings", report, cwd);
}

export interface ActionableWarningsAutofixSummary {
	considered: number;
	applied: number;
	changedFiles: string[];
	skipped: Array<{ id: string; reason: string }>;
}

export interface ActionableWarningsFreshnessResult {
	fresh: boolean;
	reason?: string;
	reportProjectSeqEnd?: number;
	currentProjectSeq: number;
	filePath?: string;
	reportFileSeq?: number;
	currentFileSeq?: number;
}

export function checkActionableWarningsReportFresh(args: {
	report: ActionableWarningsReport;
	currentProjectSeq: number;
	getFileSeq?: (filePath: string) => number;
}): ActionableWarningsFreshnessResult {
	const reportProjectSeqEnd = args.report.projectSeqEnd;
	if (typeof reportProjectSeqEnd !== "number") {
		return {
			fresh: false,
			reason: "missing_project_seq",
			currentProjectSeq: args.currentProjectSeq,
		};
	}
	if (reportProjectSeqEnd !== args.currentProjectSeq) {
		return {
			fresh: false,
			reason: "project_seq_mismatch",
			reportProjectSeqEnd,
			currentProjectSeq: args.currentProjectSeq,
		};
	}
	if (args.getFileSeq) {
		for (const file of args.report.files) {
			if (typeof file.fileSeq !== "number") continue;
			const currentFileSeq = args.getFileSeq(file.filePath);
			if (currentFileSeq !== file.fileSeq) {
				return {
					fresh: false,
					reason: "file_seq_mismatch",
					reportProjectSeqEnd,
					currentProjectSeq: args.currentProjectSeq,
					filePath: file.filePath,
					reportFileSeq: file.fileSeq,
					currentFileSeq,
				};
			}
		}
	}
	return {
		fresh: true,
		reportProjectSeqEnd,
		currentProjectSeq: args.currentProjectSeq,
	};
}

export async function applyConservativeActionableWarningFixes(args: {
	cwd: string;
	report: ActionableWarningsReport;
	maxFixes?: number;
	dbg?: (msg: string) => void;
}): Promise<ActionableWarningsAutofixSummary> {
	const summary: ActionableWarningsAutofixSummary = {
		considered: 0,
		applied: 0,
		changedFiles: [],
		skipped: [],
	};
	const changedFiles = new Set<string>();
	const lspService = getLSPService();
	const maxFixes = Math.max(0, args.maxFixes ?? 5);
	for (const file of args.report.files) {
		if (summary.applied >= maxFixes) break;
		for (const warning of file.warnings) {
			if (summary.applied >= maxFixes) break;
			if (warning.suppressed) continue;
			const eligibleActions = warning.actions.filter(
				(action) => action.autoFixEligible,
			);
			if (eligibleActions.length !== 1) {
				if (eligibleActions.length > 1)
					summary.skipped.push({
						id: warning.id,
						reason: "multiple_eligible_actions",
					});
				continue;
			}
			summary.considered++;
			if (!warning.line || !warning.column) {
				summary.skipped.push({ id: warning.id, reason: "missing_position" });
				continue;
			}
			if (!lspService.supportsLSP(warning.filePath)) {
				summary.skipped.push({ id: warning.id, reason: "no_lsp" });
				continue;
			}
			try {
				const content = fs.existsSync(warning.filePath)
					? fs.readFileSync(warning.filePath, "utf-8")
					: undefined;
				if (content) await lspService.openFile(warning.filePath, content);
				const line = warning.line - 1;
				const character = warning.column - 1;
				const actions = await lspService.codeAction(
					warning.filePath,
					line,
					character,
					line,
					character,
				);
				const title = eligibleActions[0]?.title;
				const selected = actions.find((action) => action.title === title);
				if (!selected) {
					summary.skipped.push({ id: warning.id, reason: "action_not_found" });
					continue;
				}
				const safety = actionSafety(selected);
				if (!safety.eligible) {
					summary.skipped.push({
						id: warning.id,
						reason: safety.reason ?? "not_safe",
					});
					continue;
				}
				const edit = selected.edit as Parameters<typeof applyWorkspaceEdit>[0];
				const applied = await applyWorkspaceEdit(edit, args.cwd);
				for (const changedFile of applied.files) changedFiles.add(changedFile);
				summary.applied++;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				args.dbg?.(
					`actionable_warnings_autofix failed for ${warning.id}: ${message}`,
				);
				summary.skipped.push({ id: warning.id, reason: "apply_failed" });
			}
		}
	}
	summary.changedFiles = [...changedFiles];
	return summary;
}

export function formatActionableWarningsAdvisory(
	report: ActionableWarningsReport,
): string | undefined {
	if (report.summary.unsuppressed === 0) return undefined;
	const files = report.files.filter((file) =>
		file.warnings.some((warning) => !warning.suppressed),
	);
	const fileList = files
		.slice(0, 5)
		.map(
			(file) =>
				`  ${file.displayPath}: ${file.warnings.filter((warning) => !warning.suppressed).length}`,
		)
		.join("\n");
	const more =
		files.length > 5 ? `\n  ... and ${files.length - 5} more file(s)` : "";
	const safe =
		report.summary.autoFixEligible > 0
			? ` ${report.summary.autoFixEligible} appear to have conservative preferred quickfixes.`
			: "";
	return [
		`🟡 Fixable warnings introduced this turn: ${report.summary.unsuppressed}.${safe}`,
		`Details written to .pi-lens/cache/actionable-warnings.json`,
		fileList ? `Files:\n${fileList}${more}` : undefined,
		"If continuing in these files, read that JSON and resolve warnings that are safe and relevant. Do not apply broad refactors unless requested.",
	]
		.filter(Boolean)
		.join("\n");
}
