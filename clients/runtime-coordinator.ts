import * as path from "node:path";
import type { FileComplexity } from "./complexity-client.js";
import type { RuleScanResult } from "./rules-scanner.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import type { ProjectIndex } from "./project-index.js";
import { normalizeMapKey } from "./path-utils.js";

export interface ErrorDebtBaseline {
	testsPassed: boolean;
	buildPassed: boolean;
}

export class RuntimeCoordinator {
	private _projectRoot = normalizeMapKey(process.cwd());
	private _sessionGeneration = 0;
	private _errorDebtBaseline: ErrorDebtBaseline | null = null;
	private _pipelineCrashCounts = new Map<string, number>();
	private _cachedExports = new Map<string, string>();
	private _cachedProjectIndex: ProjectIndex | null = null;
	private _startupScansInFlight = new Map<string, number>();
	private _lastCascadeOutput = "";
	private _lastImpactCascadeOutput = "";
	private _complexityBaselines = new Map<string, FileComplexity>();
	private _fixedThisTurn = new Set<string>();
	private _projectRulesScan: RuleScanResult = {
		rules: [],
		hasCustomRules: false,
	};
	private _telemetrySessionId = `lens-${Date.now().toString(36)}`;
	private _telemetryModel = "unknown";
	private _turnIndex = 0;
	private _writeIndex = 0;
	private _gitGuardHasBlockers = false;
	private _gitGuardSummary = "";

	resetForSession(): void {
		this._sessionGeneration += 1;
		this._complexityBaselines.clear();
		this._pipelineCrashCounts.clear();
		this._cachedExports.clear();
		this._cachedProjectIndex = null;
		this._startupScansInFlight.clear();
		this._lastCascadeOutput = "";
		this._lastImpactCascadeOutput = "";
		this._fixedThisTurn.clear();
		this._telemetrySessionId =
			`lens-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this._telemetryModel = "unknown";
		this._turnIndex = 0;
		this._writeIndex = 0;
		this._gitGuardHasBlockers = false;
		this._gitGuardSummary = "";
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
		this._lastCascadeOutput = "";
		this._lastImpactCascadeOutput = "";
		this._turnIndex += 1;
		this._writeIndex = 0;
	}

	nextWriteIndex(): number {
		this._writeIndex += 1;
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

	get lastCascadeOutput(): string {
		return this._lastCascadeOutput;
	}

	set lastCascadeOutput(value: string) {
		this._lastCascadeOutput = value;
	}

	consumeLastCascadeOutput(): string {
		const current = this._lastCascadeOutput;
		this._lastCascadeOutput = "";
		return current;
	}

	get lastImpactCascadeOutput(): string {
		return this._lastImpactCascadeOutput;
	}

	set lastImpactCascadeOutput(value: string) {
		this._lastImpactCascadeOutput = value;
	}

	consumeLastImpactCascadeOutput(): string {
		const current = this._lastImpactCascadeOutput;
		this._lastImpactCascadeOutput = "";
		return current;
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
}
