import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { ActionableWarningRecord } from "./actionable-warnings.js";
import type { CascadeResult } from "./cascade-types.js";
import type { CodeQualityWarningRecord } from "./code-quality-warnings.js";
import type { FileComplexity } from "./complexity-client.js";
import { normalizeMapKey } from "./path-utils.js";
import type { ProjectIndex } from "./project-index.js";
import { ReadGuard } from "./read-guard.js";
import type { RuleScanResult } from "./rules-scanner.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";

export interface ErrorDebtBaseline {
	testsPassed: boolean;
	buildPassed: boolean;
}

export interface CascadeSessionStats {
	runs: number;
	diagnosticsSurfaced: number;
	coldSnapshotTouches: number;
}

export interface DeferredFormatRecord {
	filePath: string;
	/** Formatter/language cwd captured when the edit was analyzed. */
	cwd: string;
	/** Workspace/project cwd used for turn-state and change-log bookkeeping. */
	turnStateCwd?: string;
	firstTouchedAt: number;
	lastTouchedAt: number;
	toolNames: Set<"write" | "edit">;
}

export class RuntimeCoordinator {
	private _projectRoot = normalizeMapKey(process.cwd());
	private _sessionGeneration = 0;
	private _sessionStartedAt = Date.now();
	private _errorDebtBaseline: ErrorDebtBaseline | null = null;
	private _pipelineCrashCounts = new Map<string, number>();
	private _cachedExports = new Map<string, string>();
	private _cachedProjectIndex: ProjectIndex | null = null;
	private _startupScansInFlight = new Map<string, number>();
	private _cascadeResults: CascadeResult[] = [];
	private _cascadeSessionStats: CascadeSessionStats = {
		runs: 0,
		diagnosticsSurfaced: 0,
		coldSnapshotTouches: 0,
	};
	private _complexityBaselines = new Map<string, FileComplexity>();
	private _fixedThisTurn = new Set<string>();
	private readonly _reportedThisTurn = new Set<string>();
	private _projectRulesScan: RuleScanResult = {
		rules: [],
		hasCustomRules: false,
	};
	private _telemetrySessionId = `lens-${Date.now().toString(36)}`;
	private _telemetryModel = "unknown";
	private _turnIndex = 0;
	private _writeIndex = 0;
	private _projectSeq = 0;
	private _turnStartProjectSeq = 0;
	private readonly _fileSeq = new Map<string, number>();
	private _gitGuardHasBlockers = false;
	private _gitGuardSummary = "";
	private _readGuard: ReadGuard | null = null;
	private readonly _pendingDeferredFormatFiles = new Map<
		string,
		DeferredFormatRecord
	>();
	private readonly _lspReadWarmState = new Map<
		string,
		{ status: "warming" | "ready"; ts: number }
	>();
	private readonly _pendingInlineBlockers = new Map<
		string,
		{ filePath: string; summary: string }
	>();
	private readonly _actionableWarningsThisTurn = new Map<
		string,
		ActionableWarningRecord
	>();
	private readonly _codeQualityWarningsThisTurn = new Map<
		string,
		CodeQualityWarningRecord
	>();

	resetForSession(): void {
		this._sessionGeneration += 1;
		this._sessionStartedAt = Date.now();
		this._complexityBaselines.clear();
		this._pipelineCrashCounts.clear();
		this._cachedExports.clear();
		this._cachedProjectIndex = null;
		this._startupScansInFlight.clear();
		this._cascadeResults = [];
		this._cascadeSessionStats = {
			runs: 0,
			diagnosticsSurfaced: 0,
			coldSnapshotTouches: 0,
		};
		this._fixedThisTurn.clear();
		this._reportedThisTurn.clear();
		this._telemetrySessionId = `lens-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
		this._telemetryModel = "unknown";
		this._turnIndex = 0;
		this._writeIndex = 0;
		this._projectSeq = 0;
		this._turnStartProjectSeq = 0;
		this._fileSeq.clear();
		this._gitGuardHasBlockers = false;
		this._gitGuardSummary = "";
		this._readGuard = null;
		this._pendingDeferredFormatFiles.clear();
		this._lspReadWarmState.clear();
		this._pendingInlineBlockers.clear();
		this._actionableWarningsThisTurn.clear();
		this._codeQualityWarningsThisTurn.clear();
	}

	get sessionStartedAt(): number {
		return this._sessionStartedAt;
	}

	get cascadeSessionStats(): CascadeSessionStats {
		return this._cascadeSessionStats;
	}

	recordCascadeRun(
		diagnosticsSurfaced: number,
		coldSnapshotTouches: number,
	): void {
		this._cascadeSessionStats.runs += 1;
		this._cascadeSessionStats.diagnosticsSurfaced += diagnosticsSurfaced;
		this._cascadeSessionStats.coldSnapshotTouches += coldSnapshotTouches;
	}

	updateGitGuardStatus(hasBlockers: boolean, output: string): void {
		this._gitGuardHasBlockers = hasBlockers;
		if (!hasBlockers) {
			this._gitGuardSummary = "";
			return;
		}
		const firstLine = output
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		this._gitGuardSummary = (firstLine ?? "Unresolved blockers detected").slice(
			0,
			160,
		);
	}

	get gitGuardHasBlockers(): boolean {
		return this._gitGuardHasBlockers;
	}

	get gitGuardSummary(): string {
		return this._gitGuardSummary;
	}

	beginTurn(): void {
		this._cascadeResults = [];
		this._pendingInlineBlockers.clear();
		this._actionableWarningsThisTurn.clear();
		this._codeQualityWarningsThisTurn.clear();
		this._turnStartProjectSeq = this._projectSeq;
		this._turnIndex += 1;
		this._writeIndex = 0;
		this._reportedThisTurn.clear();
	}

	get reportedThisTurn(): Set<string> {
		return this._reportedThisTurn;
	}

	nextWriteIndex(): number {
		this._writeIndex += 1;
		return this._writeIndex;
	}

	peekWriteIndex(): number {
		return this._writeIndex;
	}

	setTelemetryIdentity(identity: {
		sessionId?: string;
		model?: string;
		provider?: string;
	}): void {
		if (identity.sessionId && identity.sessionId.trim()) {
			this._telemetrySessionId = identity.sessionId.trim();
		}
		const model = identity.model?.trim();
		const provider = identity.provider?.trim();
		if (model && provider) {
			this._telemetryModel = `${provider}/${model}`;
		} else if (model) {
			this._telemetryModel = model;
		} else if (provider) {
			this._telemetryModel = provider;
		}
	}

	get telemetrySessionId(): string {
		return this._telemetrySessionId;
	}

	get telemetryModel(): string {
		return this._telemetryModel;
	}

	get turnIndex(): number {
		return this._turnIndex;
	}

	get projectSeq(): number {
		return this._projectSeq;
	}

	get turnStartProjectSeq(): number {
		return this._turnStartProjectSeq;
	}

	seedProjectSequence(
		projectSeq: number,
		fileSeqByPath?: Map<string, number>,
	): void {
		this._projectSeq = Math.max(0, Math.floor(projectSeq));
		this._turnStartProjectSeq = this._projectSeq;
		this._fileSeq.clear();
		for (const [filePath, seq] of fileSeqByPath ?? []) {
			this._fileSeq.set(
				normalizeMapKey(path.resolve(filePath)),
				Math.max(0, seq),
			);
		}
	}

	bumpFileSeq(filePath: string): { projectSeq: number; fileSeq: number } {
		const key = normalizeMapKey(path.resolve(filePath));
		this._projectSeq += 1;
		const fileSeq = (this._fileSeq.get(key) ?? 0) + 1;
		this._fileSeq.set(key, fileSeq);
		return { projectSeq: this._projectSeq, fileSeq };
	}

	getFileSeq(filePath: string): number {
		return this._fileSeq.get(normalizeMapKey(path.resolve(filePath))) ?? 0;
	}

	getFileSeqEntries(): Array<[string, number]> {
		return [...this._fileSeq.entries()];
	}

	get sessionGeneration(): number {
		return this._sessionGeneration;
	}

	isCurrentSession(generation: number): boolean {
		return this._sessionGeneration === generation;
	}

	markStartupScanInFlight(name: string, generation: number): void {
		this._startupScansInFlight.set(name, generation);
	}

	clearStartupScanInFlight(name: string, generation: number): void {
		const owner = this._startupScansInFlight.get(name);
		if (owner === generation) {
			this._startupScansInFlight.delete(name);
		}
	}

	isStartupScanInFlight(name: string): boolean {
		return this._startupScansInFlight.has(name);
	}

	formatPipelineCrashNotice(filePath: string, err: unknown): string {
		const key = path.resolve(filePath);
		const count = (this._pipelineCrashCounts.get(key) ?? 0) + 1;
		this._pipelineCrashCounts.set(key, count);

		const message = err instanceof Error ? err.message : String(err);
		const shortMessage = message.split("\n")[0].slice(0, 220);
		const shouldSurface =
			count <= RUNTIME_CONFIG.crashNotice.alwaysShowFirstN ||
			count % RUNTIME_CONFIG.crashNotice.showEveryNth === 0;
		if (!shouldSurface) return "";

		return [
			"⚠️ pi-lens pipeline crashed while analyzing this write.",
			`File: ${path.basename(filePath)} | crash count this session: ${count}`,
			`Error: ${shortMessage}`,
			"Recovery: LSP service was reset. If this repeats, rerun with --no-lsp and report the file + stack.",
		].join("\n");
	}

	getCrashEntries(): Array<[string, number]> {
		return Array.from(this._pipelineCrashCounts.entries());
	}

	get projectRoot(): string {
		return this._projectRoot;
	}

	set projectRoot(value: string) {
		this._projectRoot = normalizeMapKey(value);
	}

	get errorDebtBaseline(): ErrorDebtBaseline | null {
		return this._errorDebtBaseline;
	}

	set errorDebtBaseline(value: ErrorDebtBaseline | null) {
		this._errorDebtBaseline = value;
	}

	get cachedExports(): Map<string, string> {
		return this._cachedExports;
	}

	get cachedProjectIndex(): ProjectIndex | null {
		return this._cachedProjectIndex;
	}

	set cachedProjectIndex(value: ProjectIndex | null) {
		this._cachedProjectIndex = value;
	}

	appendCascadeResult(result: CascadeResult): void {
		this._cascadeResults.push(result);
	}

	consumeCascadeResults(): CascadeResult[] {
		const results = this._cascadeResults;
		this._cascadeResults = [];
		return results;
	}

	recordInlineBlockers(filePath: string, summary: string): void {
		this._pendingInlineBlockers.set(path.resolve(filePath), {
			filePath,
			summary,
		});
	}

	clearInlineBlockers(filePath: string): void {
		this._pendingInlineBlockers.delete(path.resolve(filePath));
	}

	consumeInlineBlockers(): Array<{ filePath: string; summary: string }> {
		const entries = [...this._pendingInlineBlockers.values()];
		this._pendingInlineBlockers.clear();
		return entries;
	}

	recordActionableWarnings(warnings: ActionableWarningRecord[]): void {
		for (const warning of warnings) {
			this._actionableWarningsThisTurn.set(warning.id, warning);
		}
	}

	peekActionableWarnings(): ActionableWarningRecord[] {
		return [...this._actionableWarningsThisTurn.values()];
	}

	clearActionableWarnings(): void {
		this._actionableWarningsThisTurn.clear();
	}

	recordCodeQualityWarnings(warnings: CodeQualityWarningRecord[]): void {
		for (const warning of warnings) {
			this._codeQualityWarningsThisTurn.set(warning.id, warning);
		}
	}

	peekCodeQualityWarnings(): CodeQualityWarningRecord[] {
		return [...this._codeQualityWarningsThisTurn.values()];
	}

	clearCodeQualityWarnings(): void {
		this._codeQualityWarningsThisTurn.clear();
	}

	get complexityBaselines(): Map<string, FileComplexity> {
		return this._complexityBaselines;
	}

	get fixedThisTurn(): Set<string> {
		return this._fixedThisTurn;
	}

	get projectRulesScan(): RuleScanResult {
		return this._projectRulesScan;
	}

	set projectRulesScan(value: RuleScanResult) {
		this._projectRulesScan = value;
	}

	get readGuard(): ReadGuard {
		this._readGuard ??= new ReadGuard(this._telemetrySessionId);
		return this._readGuard;
	}

	deferFormat(
		filePath: string,
		cwd: string,
		toolName: "write" | "edit",
		turnStateCwd?: string,
	): void {
		const key = path.resolve(filePath);
		const now = Date.now();
		const existing = this._pendingDeferredFormatFiles.get(key);
		if (existing) {
			existing.lastTouchedAt = now;
			existing.cwd = cwd;
			existing.turnStateCwd = turnStateCwd ?? existing.turnStateCwd;
			existing.toolNames.add(toolName);
			return;
		}
		this._pendingDeferredFormatFiles.set(key, {
			filePath: key,
			cwd,
			turnStateCwd,
			firstTouchedAt: now,
			lastTouchedAt: now,
			toolNames: new Set([toolName]),
		});
	}

	get pendingDeferredFormatCount(): number {
		return this._pendingDeferredFormatFiles.size;
	}

	consumeDeferredFormatFiles(): DeferredFormatRecord[] {
		const records = [...this._pendingDeferredFormatFiles.values()];
		this._pendingDeferredFormatFiles.clear();
		return records;
	}

	shouldWarmLspOnRead(filePath: string, maxAgeMs = 120_000): boolean {
		const state = this._lspReadWarmState.get(path.resolve(filePath));
		if (!state) return true;
		if (state.status === "warming") return false;
		return Date.now() - state.ts > maxAgeMs;
	}

	markLspReadWarmStarted(filePath: string): void {
		this._lspReadWarmState.set(path.resolve(filePath), {
			status: "warming",
			ts: Date.now(),
		});
	}

	markLspReadWarmCompleted(filePath: string): void {
		this._lspReadWarmState.set(path.resolve(filePath), {
			status: "ready",
			ts: Date.now(),
		});
	}

	clearLspReadWarmState(filePath: string): void {
		this._lspReadWarmState.delete(path.resolve(filePath));
	}
}
