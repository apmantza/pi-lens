import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheManager } from "./cache-manager.js";
import { logCascade } from "./cascade-logger.js";
import type { DependencyChecker } from "./dependency-checker.js";
import {
	resolveRunnerPath,
	toRunnerDisplayPath,
} from "./dispatch/runner-context.js";
import { getKnipIgnorePatterns } from "./file-utils.js";
import type { JscpdClient } from "./jscpd-client.js";
import type { KnipClient, KnipIssue } from "./knip-client.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { TestRunnerClient } from "./test-runner-client.js";

interface TurnEndDeps {
	ctxCwd?: string;
	getFlag: (name: string) => boolean | string | undefined;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	jscpdClient: JscpdClient;
	knipClient: KnipClient;
	depChecker: DependencyChecker;
	testRunnerClient: TestRunnerClient;
	resetLSPService: () => void;
	resetFormatService: () => void;
}

// LSP idle reset scheduling — prevents thrashing by delaying shutdown
let lspIdleResetTimeout: ReturnType<typeof setTimeout> | null = null;

function scheduleLSPIdleReset(resetFn: () => void, delayMs: number): void {
	// Clear any pending reset to avoid multiple timers
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
	}
	lspIdleResetTimeout = setTimeout(() => {
		resetFn();
		lspIdleResetTimeout = null;
	}, delayMs);
	// unref so this timer does not prevent the process from exiting naturally
	// (critical for subagent / --mode json -p usage where the process should
	// exit after completing its work, not wait 240 seconds for this to fire)
	lspIdleResetTimeout.unref();
}

export function cancelLSPIdleReset(): void {
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
		lspIdleResetTimeout = null;
	}
}

function capTurnEndMessage(content: string): string {
	const maxLines = RUNTIME_CONFIG.turnEnd.maxLines;
	const maxChars = RUNTIME_CONFIG.turnEnd.maxChars;

	let out = content;
	const lines = out.split("\n");
	if (lines.length > maxLines) {
		out = `${lines.slice(0, maxLines).join("\n")}\n... (truncated)`;
	}
	if (out.length > maxChars) {
		out = `${out.slice(0, maxChars)}\n... (truncated)`;
	}

	return out;
}

export async function handleTurnEnd(deps: TurnEndDeps): Promise<void> {
	const {
		ctxCwd,
		getFlag,
		dbg,
		runtime,
		cacheManager,
		jscpdClient,
		knipClient,
		depChecker,
		testRunnerClient,
		resetLSPService,
		resetFormatService,
	} = deps;

	const cwd = ctxCwd ?? process.cwd();
	const turnState = cacheManager.readTurnState(cwd);
	const files = Object.keys(turnState.files);

	if (files.length === 0) {
		dbg("turn_end: no modified files, scheduling LSP idle reset (240s)");
		if (!getFlag("no-lsp")) {
			scheduleLSPIdleReset(resetLSPService, 240_000);
		}
		resetFormatService();
		return;
	}

	// Cancel any pending idle reset since we're actively working
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
		lspIdleResetTimeout = null;
		dbg("turn_end: cancelled pending LSP idle reset (active editing)");
	}

	dbg(
		`turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}`,
	);

	if (cacheManager.isMaxCyclesExceeded(cwd)) {
		dbg("turn_end: max cycles exceeded, clearing state and forcing through");
		cacheManager.clearTurnState(cwd);
		runtime.fixedThisTurn.clear();
		resetFormatService();
		return;
	}

	const blockerParts: string[] = [];

	// Merge accumulated cascade results from all pipeline runs this turn.
	const cascadeResults = runtime.consumeCascadeResults();
	if (cascadeResults.length > 0) {
		// Deduplicate by neighbor file path (last writer wins — most recent LSP state).
		const mergedNeighbors = new Map<
			string,
			(typeof cascadeResults)[number]["neighbors"][number]
		>();
		for (const result of cascadeResults) {
			for (const neighbor of result.neighbors) {
				if (neighbor.diagnostics.length === 0) continue;
				mergedNeighbors.set(path.resolve(neighbor.filePath), neighbor);
			}
		}
		if (mergedNeighbors.size > 0) {
			let merged = `📐 Cascade errors in ${mergedNeighbors.size} dependent file(s) — fix before finishing turn:`;
			for (const neighbor of mergedNeighbors.values()) {
				const display = toRunnerDisplayPath(cwd, neighbor.filePath);
				merged += `\n<diagnostics file="${display}">`;
				for (const d of neighbor.diagnostics) {
					const line = (d.range?.start?.line ?? 0) + 1;
					const col = (d.range?.start?.character ?? 0) + 1;
					const code = d.code ? ` code=${String(d.code)}` : "";
					merged += `\n  line ${line}, col ${col}${code}: ${d.message.split("\n")[0].slice(0, 100)}`;
				}
				merged += "\n</diagnostics>";
			}
			blockerParts.push(merged);
		}
		logCascade({
			phase: "cascade_turn_end",
			filePath: files[0] ?? cwd,
			neighborCount: cascadeResults.reduce((s, r) => s + r.neighbors.length, 0),
			diagnosticCount: cascadeResults.reduce(
				(s, r) =>
					s + r.neighbors.reduce((ns, n) => ns + n.diagnostics.length, 0),
				0,
			),
			metadata: {
				fileCount: cascadeResults.length,
				mergedNeighbors: mergedNeighbors.size,
			},
		});
	}

	if (runtime.isStartupScanInFlight("jscpd")) {
		dbg("turn_end: skipping jscpd (startup scan still in flight)");
	} else if (await jscpdClient.ensureAvailable()) {
		const jscpdFiles = cacheManager.getFilesForJscpd(cwd);
		if (jscpdFiles.length > 0) {
			dbg(`turn_end: jscpd scanning ${jscpdFiles.length} file(s)`);
			const result = jscpdClient.scan(cwd);
			const jscpdFileSet = new Set(
				jscpdFiles.map((f) => resolveRunnerPath(cwd, f)),
			);
			const filtered = result.clones.filter((clone) => {
				const resolvedA = resolveRunnerPath(cwd, clone.fileA);
				const resolvedB = resolveRunnerPath(cwd, clone.fileB);
				if (!fs.existsSync(resolvedA) || !fs.existsSync(resolvedB)) {
					return false;
				}

				const stateA = cacheManager.getTurnFileState(resolvedA, cwd);
				const stateB = cacheManager.getTurnFileState(resolvedB, cwd);

				const matchA =
					jscpdFileSet.has(resolvedA) &&
					!!stateA &&
					cacheManager.isLineInModifiedRange(
						clone.startA,
						stateA.modifiedRanges,
					);

				const matchB =
					jscpdFileSet.has(resolvedB) &&
					!!stateB &&
					cacheManager.isLineInModifiedRange(
						clone.startB,
						stateB.modifiedRanges,
					);

				return matchA || matchB;
			});
			if (filtered.length > 0) {
				let report = `🔴 New duplicates in modified code:\n`;
				let firstPath: string | null = null;
				for (const clone of filtered.slice(0, 5)) {
					const displayA = toRunnerDisplayPath(cwd, clone.fileA);
					const displayB = toRunnerDisplayPath(cwd, clone.fileB);

					if (!firstPath) {
						const resolvedA = resolveRunnerPath(cwd, clone.fileA);
						const resolvedB = resolveRunnerPath(cwd, clone.fileB);
						const stateA = cacheManager.getTurnFileState(resolvedA, cwd);
						const stateB = cacheManager.getTurnFileState(resolvedB, cwd);
						const matchA =
							!!stateA &&
							cacheManager.isLineInModifiedRange(
								clone.startA,
								stateA.modifiedRanges,
							);
						const matchB =
							!!stateB &&
							cacheManager.isLineInModifiedRange(
								clone.startB,
								stateB.modifiedRanges,
							);
						firstPath = matchB && !matchA ? displayB : displayA;
					}
					report += `  ${displayA}:${clone.startA} ↔ ${displayB}:${clone.startB} (${clone.lines} lines)\n`;
				}
				if (firstPath) {
					report += `  First location: ${firstPath}\n`;
				}
				blockerParts.push(report);
			}
			cacheManager.writeCache("jscpd", result, cwd);
		}
	}

	if (runtime.isStartupScanInFlight("knip")) {
		dbg("turn_end: skipping knip (startup scan still in flight)");
	} else if (await knipClient.ensureAvailable()) {
		const knipResult = knipClient.analyze(cwd, getKnipIgnorePatterns());
		const prevKnip = cacheManager.readCache<ReturnType<KnipClient["analyze"]>>(
			"knip",
			cwd,
		);
		cacheManager.writeCache("knip", knipResult, cwd);

		if (knipResult.success && knipResult.issues.length > 0) {
			const issueKey = (i: KnipIssue) =>
				`${i.type}:${i.file ?? ""}:${i.name}:${i.line ?? 0}:${i.package ?? ""}`;
			const prevKeys = new Set((prevKnip?.data?.issues ?? []).map(issueKey));
			const modifiedSet = new Set(files.map((f) => resolveRunnerPath(cwd, f)));

			const newIssues = knipResult.issues.filter((issue) => {
				if (prevKeys.has(issueKey(issue))) return false;
				if (!issue.file) return false;
				const abs = resolveRunnerPath(cwd, issue.file);
				return modifiedSet.has(abs);
			});

			const blockerIssues = newIssues.filter(
				(i) => i.type === "unlisted" || i.type === "bin",
			);
			if (blockerIssues.length > 0) {
				let report =
					"🔴 New unresolved imports/deps in modified code (Knip):\n";
				let firstPath: string | null = null;
				for (const issue of blockerIssues.slice(0, 5)) {
					const display = issue.file
						? toRunnerDisplayPath(cwd, issue.file)
						: "(unknown)";
					if (!firstPath && display !== "(unknown)") firstPath = display;
					report += `  ${display}${issue.line ? `:${issue.line}` : ""} — ${issue.type}: ${issue.name}\n`;
				}
				if (firstPath) {
					report += `  First location: ${firstPath}\n`;
				}
				blockerParts.push(report);
			}
		}
	}

	if (await depChecker.ensureAvailable()) {
		const madgeFiles = cacheManager.getFilesForMadge(cwd);
		if (madgeFiles.length > 0) {
			dbg(
				`turn_end: madge checking ${madgeFiles.length} file(s) for circular deps`,
			);
			for (const file of madgeFiles) {
				const absPath = path.resolve(cwd, file);
				const depResult = depChecker.checkFile(absPath);
				if (depResult.hasCircular && depResult.circular.length > 0) {
					const circularDeps = depResult.circular
						.flatMap((d) => d.path)
						.filter((p: string) => !absPath.endsWith(path.basename(p)));
					const uniqueDeps = [...new Set(circularDeps)];
					if (uniqueDeps.length > 0) {
						dbg(
							`turn_end: circular dependency note for ${file} (suppressed in blockers-only mode)`,
						);
					}
				}
			}
		}
	}

	// --- Test runner: fire once per turn after all edits are done ---
	// Runs for each unique test target across modified files; results appear
	// in the next turn's context injection alongside jscpd/madge findings.
	if (!getFlag("no-tests") && files.length > 0) {
		const seen = new Set<string>();
		const targets: NonNullable<
			ReturnType<TestRunnerClient["getTestRunTarget"]>
		>[] = [];
		for (const file of files) {
			const abs = resolveRunnerPath(cwd, file);
			const target = testRunnerClient.getTestRunTarget(abs, cwd);
			if (target && !seen.has(target.testFile)) {
				seen.add(target.testFile);
				targets.push(target);
			}
		}
		if (targets.length > 0) {
			dbg(
				`turn_end: firing ${targets.length} test target(s) async (non-blocking)`,
			);
			const firedAtTurn = runtime.turnIndex;
			Promise.allSettled(
				targets.map((t) =>
					testRunnerClient.runTestFileAsync(
						t.testFile,
						cwd,
						t.runner,
						t.config,
					),
				),
			)
				.then((results) => {
					// Drop stale results if the agent has already started a new turn.
					if (runtime.turnIndex !== firedAtTurn) {
						dbg(
							`turn_end: discarding test results — turn advanced while tests ran`,
						);
						return;
					}
					const failures: string[] = [];
					for (const r of results) {
						if (r.status === "fulfilled" && r.value.failed > 0) {
							const formatted = testRunnerClient.formatResult(r.value);
							if (formatted) failures.push(formatted);
						}
					}
					if (failures.length > 0) {
						const content = failures.join("\n\n");
						cacheManager.writeCache("test-runner-findings", { content }, cwd);
						dbg(`turn_end: test failures cached for next context injection`);
					}
				})
				.catch(() => {});
		}
	}

	if (runtime.errorDebtBaseline && files.length > 0) {
		dbg("turn_end: marking error debt check for next session");
		cacheManager.writeCache(
			"errorDebt",
			{
				pendingCheck: true,
				baselineTestsPassed: runtime.errorDebtBaseline.testsPassed,
			},
			cwd,
		);
	}

	// Session summaries are intentionally suppressed at turn_end to avoid
	// distracting the agent with non-blocking telemetry.

	cacheManager.incrementTurnCycle(cwd);

	if (blockerParts.length > 0) {
		dbg(
			`turn_end: ${blockerParts.length} blocker section(s) found, persisting for next context`,
		);
		const content = capTurnEndMessage(blockerParts.join("\n\n"));
		const signature = `${files.slice().sort().join("|")}::${content}`;
		const last = cacheManager.readCache<{ signature: string }>(
			"turn-end-findings-last",
			cwd,
		);
		if (last?.data?.signature === signature) {
			dbg(
				"turn_end: duplicate blocker findings detected, suppressing re-prompt",
			);
			cacheManager.clearTurnState(cwd);
			runtime.fixedThisTurn.clear();
			resetFormatService();
			return;
		}
		cacheManager.writeCache("turn-end-findings", { content }, cwd);
		cacheManager.writeCache("turn-end-findings-last", { signature }, cwd);
	} else {
		cacheManager.clearTurnState(cwd);
	}

	runtime.fixedThisTurn.clear();
	resetFormatService();
}
