import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { AstGrepClient } from "./ast-grep-client.js";
import type { BiomeClient } from "./biome-client.js";
import type { CacheManager } from "./cache-manager.js";
import type {
	DeadCodeClient,
	DeadCodeResult,
} from "./dead-code-client.js";
import { deadCodeIssueCount } from "./dead-code-client.js";
import { logDeadCodeScan } from "./dead-code-logger.js";
import type { DependencyChecker } from "./dependency-checker.js";
import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import { clearAllSessions as clearFileTimeSessions } from "./file-time.js";
import { getKnipIgnorePatterns } from "./file-utils.js";
import { GitleaksClient, type GitleaksResult } from "./gitleaks-client.js";
import { TrivyClient, type TrivyResult } from "./trivy-client.js";
import type { GoClient } from "./go-client.js";
import {
	GovulncheckClient,
	type GovulncheckResult,
} from "./govulncheck-client.js";
import type { JscpdClient } from "./jscpd-client.js";
import type { KnipClient, KnipResult } from "./knip-client.js";
import { canRunStartupHeavyScans } from "./language-policy.js";
import {
	detectProjectLanguageProfile,
	getDefaultStartupTools,
} from "./language-profile.js";
import { runLogCleanup } from "./log-cleanup.js";
import { setSessionLanguages } from "./widget-state.js";
import { initLSPConfig, loadLSPConfig } from "./lsp/config.js";
import { getLSPService } from "./lsp/index.js";
import type { LSPShutdownOptions } from "./lsp/client.js";
import type { MetricsClient } from "./metrics-client.js";
import { readLatestProjectSequence } from "./project-changes.js";
import {
	getProjectSnapshotPath,
	hydrateRuntimeFromProjectSnapshot,
	isProjectSnapshotFresh,
	loadProjectSnapshot,
	saveRuntimeProjectSnapshot,
	type ProjectSnapshot,
} from "./project-snapshot.js";
import type { RuffClient } from "./ruff-client.js";
import { scanProjectRules } from "./rules-scanner.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { RustClient } from "./rust-client.js";

import { isAtOrAboveHomeDir } from "./path-utils.js";
import {
	findNearestProjectRoot,
	resolveStartupScanContext,
	type StartupScanContext,
} from "./startup-scan.js";
import type { TestRunnerClient } from "./test-runner-client.js";
import type { TodoScanner } from "./todo-scanner.js";
import type { TypeCoverageClient } from "./type-coverage-client.js";

interface SessionStartDeps {
	ctxCwd?: string;
	getFlag: (name: string) => boolean | string | undefined;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	dbg: (msg: string) => void;
	log: (msg: string) => void;
	runtime: RuntimeCoordinator;
	metricsClient: MetricsClient;
	cacheManager: CacheManager;
	todoScanner: TodoScanner;
	astGrepClient: AstGrepClient;
	biomeClient: BiomeClient;
	ruffClient: RuffClient;
	knipClient: KnipClient;
	jscpdClient: JscpdClient;
	deadCodeClients: DeadCodeClient[];
	govulncheckClient: GovulncheckClient;
	gitleaksClient: GitleaksClient;
	trivyClient: TrivyClient;
	typeCoverageClient: TypeCoverageClient;
	depChecker: DependencyChecker;
	testRunnerClient: TestRunnerClient;
	goClient: GoClient;
	rustClient: RustClient;
	ensureTool: (name: string) => Promise<string | null | undefined>;
	cleanStaleTsBuildInfo: (cwd: string) => string[];
	resetDispatchBaselines: (cwd?: string) => void;
	resetLSPService: (options?: LSPShutdownOptions) => void;
}

type StartupMode = "full" | "minimal" | "quick";

function resolveSnapshotRoot(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	const nearest = findNearestProjectRoot(resolvedCwd);
	// Reject a root at — or above — $HOME (the #250/#253 escape); fall back to
	// the cwd so the snapshot stays scoped to the actual workspace.
	if (!nearest || isAtOrAboveHomeDir(nearest)) {
		return resolvedCwd;
	}
	return nearest;
}

function describeSnapshotMiss(
	snapshot: ProjectSnapshot | null,
	currentProjectSeq: number,
): string {
	if (!snapshot) return "missing";
	if (snapshot.seq !== currentProjectSeq) {
		return `stale(seq=${snapshot.seq}, current=${currentProjectSeq})`;
	}
	return "incompatible";
}

function logProjectSnapshotProbe(args: {
	dbg: (msg: string) => void;
	root: string;
	currentProjectSeq: number;
	snapshot: ProjectSnapshot | null;
}): void {
	args.dbg(
		`project_snapshot: probe root=${args.root} path=${getProjectSnapshotPath(args.root)} currentSeq=${args.currentProjectSeq}`,
	);
	if (isProjectSnapshotFresh(args.snapshot, args.currentProjectSeq)) {
		args.dbg(
			`project_snapshot: loaded seq=${args.snapshot.seq} exports=${args.snapshot.cachedExports.length} files=${Object.keys(args.snapshot.files ?? {}).length} reverseDeps=${Object.keys(args.snapshot.reverseDeps ?? {}).length} startupScan=${Boolean(args.snapshot.startupScan)} languageProfile=${Boolean(args.snapshot.languageProfile)}`,
		);
	} else {
		args.dbg(
			`project_snapshot: miss reason=${describeSnapshotMiss(args.snapshot, args.currentProjectSeq)}`,
		);
	}
}

function resolveStartupMode(): StartupMode {
	const envMode = (process.env.PI_LENS_STARTUP_MODE ?? "").trim().toLowerCase();
	if (envMode === "full" || envMode === "minimal" || envMode === "quick") {
		return envMode;
	}

	const argv = process.argv;
	if (argv.includes("--print") || argv.includes("-p")) {
		return "quick";
	}

	return "full";
}

// --- Session-start helpers ---

async function igniteWarmFiles(
	cwd: string,
	warmFiles: string[],
	runtime: RuntimeCoordinator,
	sessionGeneration: number,
	dbg: (msg: string) => void,
): Promise<void> {
	try {
		dbg(`session_start lsp-warm: ${warmFiles.length} warm file(s) configured`);

		await initLSPConfig(cwd);
		if (!runtime.isCurrentSession(sessionGeneration)) return;

		const lspService = getLSPService();
		const total = warmFiles.length;
		let loaded = 0;
		let errors = 0;

		for (const relPath of warmFiles) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			const filePath = path.isAbsolute(relPath)
				? relPath
				: path.resolve(cwd, relPath);
			if (!nodeFs.existsSync(filePath)) {
				dbg(`session_start lsp-warm: not found: ${relPath}`);
				errors++;
				continue;
			}
			try {
				const content = nodeFs.readFileSync(filePath, "utf-8");
				await lspService.touchFile(filePath, content, {
					diagnostics: "none",
					source: "startup-warm",
					clientScope: "primary",
					maxClientWaitMs: 2000,
				});
				loaded++;
			} catch (err) {
				dbg(`session_start lsp-warm: error ${relPath}: ${err}`);
				errors++;
			}
		}

		dbg(`session_start lsp-warm: ${loaded}/${total} opened (${errors} err)`);
	} catch (err) {
		dbg(`session_start lsp-warm: config/init error: ${err}`);
	}
}

/**
 * Fallback warm when a project has no explicit `warmFiles`: pre-spawn the LSP
 * for the project's *dominant* language (highest source-file count) by opening
 * one representative file. This eliminates the cold-spawn stall the first edit
 * would otherwise pay (`lsp_client_wait_timeout`, observed up to 5s on
 * TypeScript/Deno). Only a single server is warmed — launching every detected
 * language's server at once (rust-analyzer + gopls + tsserver …) would spike CPU
 * and the event loop at startup, working against the very latency we protect.
 * Projects that want more pre-warming can list explicit `warmFiles` (#203).
 */
async function igniteDominantLanguageWarm(
	cwd: string,
	runtime: RuntimeCoordinator,
	sessionGeneration: number,
	dbg: (msg: string) => void,
): Promise<void> {
	try {
		await initLSPConfig(cwd);
		if (!runtime.isCurrentSession(sessionGeneration)) return;

		const lspService = getLSPService();
		const { collectSourceFilesAsync } = await import("./source-filter.js");
		const { detectFileKind } = await import("./file-kinds.js");
		// Async, event-loop-yielding walk (deferred off the interactive path).
		// inspectGeneratedHeaders:false keeps the walk to directory reads only — no
		// per-file content opens — so we never hold a file handle (cheaper, and it
		// can't collide with concurrent fs teardown). Picking a representative file
		// doesn't need generated-banner filtering.
		const files = await collectSourceFilesAsync(cwd, {
			inspectGeneratedHeaders: false,
		});
		if (!runtime.isCurrentSession(sessionGeneration)) return;

		// Rank languages by source-file count. Computed here from the scan rather
		// than reused from languageProfile.counts, which is left empty on the
		// no-warm-caches startup path (detectProjectLanguageProfile is called with
		// an empty file list there).
		const counts = new Map<string, number>();
		for (const f of files) {
			const kind = detectFileKind(f);
			if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
		}
		if (counts.size === 0) {
			dbg("session_start lsp-warm: no detected languages to auto-warm");
			return;
		}
		const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

		// Walk languages by descending count; warm the first that has both an LSP
		// server and a representative on-disk file.
		for (const [kind] of ranked) {
			const sample = files.find(
				(f) => detectFileKind(f) === kind && lspService.supportsLSP(f),
			);
			if (!sample) continue;
			const content = await nodeFs.promises.readFile(sample, "utf-8");
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			await lspService.touchFile(sample, content, {
				diagnostics: "none",
				source: "startup-warm-dominant",
				clientScope: "primary",
				maxClientWaitMs: 2000,
			});
			dbg(
				`session_start lsp-warm: dominant=${kind} via ${path.basename(sample)}`,
			);
			return;
		}
		dbg("session_start lsp-warm: no dominant-language LSP file found to warm");
	} catch (err) {
		dbg(`session_start lsp-warm: dominant warm error: ${err}`);
	}
}

function firePreinstallDefaults(
	ensureTool: SessionStartDeps["ensureTool"],
	dbg: SessionStartDeps["dbg"],
	startupDefaults: string[],
): void {
	for (const tool of startupDefaults) {
		const startedAt = Date.now();
		dbg(`session_start preinstall ${tool}: start`);
		ensureTool(tool)
			.then((toolPath) => {
				if (toolPath) {
					dbg(`session_start: ${tool} ready at ${toolPath}`);
					dbg(
						`session_start preinstall ${tool}: success (${Date.now() - startedAt}ms)`,
					);
				} else {
					dbg(`session_start: ${tool} installation unavailable`);
					dbg(
						`session_start preinstall ${tool}: unavailable (${Date.now() - startedAt}ms)`,
					);
				}
			})
			.catch((err) => {
				dbg(`session_start: ${tool} pre-install error: ${err}`);
				dbg(
					`session_start preinstall ${tool}: error (${Date.now() - startedAt}ms)`,
				);
			});
	}
}

async function probePrettierInstall(
	ensureTool: SessionStartDeps["ensureTool"],
	dbg: SessionStartDeps["dbg"],
	analysisRoot: string,
): Promise<void> {
	const pkgPath = path.join(analysisRoot, "package.json");
	try {
		const raw = await nodeFs.promises.readFile(pkgPath, "utf-8");
		const pkg = JSON.parse(raw) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			prettier?: unknown;
		};
		const usesPrettier =
			!!pkg.devDependencies?.prettier ||
			!!pkg.dependencies?.prettier ||
			pkg.prettier !== undefined;
		if (usesPrettier) {
			dbg("session_start: project uses prettier, ensuring install...");
			ensureTool("prettier")
				.then((p) => {
					if (p) dbg(`session_start: prettier ready at ${p}`);
					else dbg("session_start: prettier install failed silently");
				})
				.catch((err) => dbg(`session_start: prettier install error: ${err}`));
		}
	} catch {
		// no package.json at cwd root
	}
}

/** A todo scanner that may expose a per-file API (newer) or only the
 * directory walk (older / mocked). `scanFile` returns the items array directly
 * (`TodoItem[]`); `scanDirectory` returns a `{ items }` result. */
type TodoScannerLike = {
	scanDirectory: (root: string) => { items: unknown[] };
	scanFile?: (filePath: string) => unknown[];
};

/** Scan one file via the per-file API, pushing any items. Tolerates an
 * unreadable file and a scanner without `scanFile` (no-op). */
function scanOneTodoFile(
	scanner: TodoScannerLike,
	filePath: string,
	items: unknown[],
): void {
	if (typeof scanner.scanFile !== "function") return;
	try {
		// scanFile returns TodoItem[] directly (not a { items } result).
		const result = scanner.scanFile(filePath);
		if (Array.isArray(result)) items.push(...result);
	} catch {
		// Per-file error: skip and continue (matches scanDirectory's tolerance).
	}
}

/** Collect the TODO baseline without blocking: enumerate source files and scan
 * them per-file, yielding to the event loop every 30 files. Falls back to the
 * blocking `scanDirectory` if the chunked path can't run (import error or a
 * scanner without `scanFile`). */
async function collectTodoBaselineItems(
	scanner: TodoScannerLike,
	analysisRoot: string,
	stillCurrent: () => boolean,
): Promise<unknown[]> {
	const items: unknown[] = [];
	try {
		const { getSourceFilesAsync } = await import("./scan-utils.js");
		// Enumerate with the chunked-yield walker so the file collection itself
		// (the previously-synchronous ~1.5s burst on a 2k-file tree) no longer
		// blocks the event loop before the per-file scan loop below even starts.
		const files = await getSourceFilesAsync(analysisRoot, true);
		if (!stillCurrent()) return items;
		let processedSinceYield = 0;
		for (const file of files) {
			if (!stillCurrent()) return items;
			scanOneTodoFile(scanner, file, items);
			if (++processedSinceYield % 30 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}
	} catch {
		const todoResult = scanner.scanDirectory(analysisRoot);
		items.push(...todoResult.items);
	}
	return items;
}

// Fire off heavy scans as background tasks — don't block session start.
// Each consumer already handles the "not ready yet" case gracefully
// (cachedExports.size > 0, cache miss paths).
function scheduleStartupScans(
	deps: SessionStartDeps,
	runtime: RuntimeCoordinator,
	sessionGeneration: number,
	analysisRoot: string,
	snapshotRoot: string,
	languageProfile: ReturnType<typeof detectProjectLanguageProfile>,
	dbg: SessionStartDeps["dbg"],
): void {
	const {
		todoScanner,
		cacheManager,
		knipClient,
		jscpdClient,
		deadCodeClients,
		govulncheckClient,
		gitleaksClient,
		trivyClient,
		astGrepClient,
	} = deps;

	// Some background scans are CPU-heavy and arrive on the event loop
	// just as the user is most likely typing (right after /new). Defer
	// those by a few seconds so the perceptible 50-100ms sync bursts they
	// contain land during LLM streaming idle time instead. All other
	// tasks (those not listed here) run on the next `setImmediate` tick
	// as before. The delays are deliberately staggered (200ms apart) so
	// two heavy tasks don't both run on the same macrotask.
	const taskDeferMsByName: Record<string, number> = {
		"call-graph": 5000,
		"codebase-model": 5200,
		"ast-grep exports": 5400,
		"project index": 5400,
	};
	const runTask = (name: string, task: () => Promise<void>): void => {
		const queuedAt = Date.now();
		dbg(`session_start task ${name}: scheduled`);
		runtime.markStartupScanInFlight(name, sessionGeneration);
		const fire = (): void => {
			const startedAt = Date.now();
			dbg(`session_start task ${name}: start queuedMs=${startedAt - queuedAt}`);
			void task()
				.then(() => {
					dbg(
						`session_start task ${name}: success runMs=${Date.now() - startedAt} queuedMs=${startedAt - queuedAt}`,
					);
				})
				.catch((err) => {
					dbg(`session_start: ${name} background scan failed: ${err}`);
					dbg(
						`session_start task ${name}: failed runMs=${Date.now() - startedAt} queuedMs=${startedAt - queuedAt}`,
					);
				})
				.finally(() => {
					runtime.clearStartupScanInFlight(name, sessionGeneration);
					dbg(`session_start task ${name}: end`);
				});
		};
		const delay = taskDeferMsByName[name] ?? 0;
		if (delay > 0) {
			setTimeout(fire, delay);
		} else {
			setImmediate(fire);
		}
	};

	const canRunJsTsHeavyScans = canRunStartupHeavyScans(languageProfile, "jsts");
	const scanNames = ["todo", "dead-code"];
	if (canRunJsTsHeavyScans) {
		scanNames.push("knip", "jscpd", "ast-grep exports", "project index");
	}
	dbg(`session_start: launching background scans (${scanNames.join(", ")})`);

	runTask("todo", async () => {
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		// The original implementation called todoScanner.scanDirectory(), which
		// walks the project synchronously and freezes the TUI for ~3s on a 2k-file
		// project. collectTodoBaselineItems re-implements the walk in async chunks
		// (per-file scan, yielding every 30 files), falling back to scanDirectory.
		const items = await collectTodoBaselineItems(
			todoScanner as TodoScannerLike,
			analysisRoot,
			() => runtime.isCurrentSession(sessionGeneration),
		);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		dbg(`session_start TODO scan: ${items.length} items (baseline stored)`);
		cacheManager.writeCache("todo-baseline", { items }, analysisRoot);
	});

	if (!canRunJsTsHeavyScans) {
		dbg(
			"session_start: skipping JS/TS startup scans (requires JS/TS language + project config)",
		);
		return;
	}

	// Knip — dead code / unused exports
	runTask("knip", async () => {
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<KnipResult>("knip", analysisRoot);
		if (cached) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				`session_start Knip: cache hit (${Math.round((Date.now() - new Date(cached.meta.timestamp).getTime()) / 1000)}s ago)`,
			);
		} else {
			// KnipClient skips before probing/installing when analysisRoot is not a real
			// JS/Knip project. This avoids running knip from Unity/C#/generic repos.
			const startMs = Date.now();
			const knipResult = await knipClient.analyze(
				analysisRoot,
				getKnipIgnorePatterns(),
			);
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			cacheManager.writeCache("knip", knipResult, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			dbg(`session_start Knip scan done (${Date.now() - startMs}ms)`);
		}
	});

	// jscpd — duplicate code detection
	runTask("jscpd", async () => {
		if (await jscpdClient.ensureAvailable()) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			// Detect TS projects by tsconfig.json at the analysis root. When
			// set, JscpdClient.scan adds **/*.js and **/*.jsx to its ignore
			// pattern so compiled artifacts under dist/ aren't flagged as
			// duplicates of their TypeScript sources (closes #126's latent
			// dist/-as-duplicate bug). Cache scanner key varies by this flag
			// so a stale cache built with the wrong setting invalidates on
			// first read.
			const isTsProject = nodeFs.existsSync(
				path.join(analysisRoot, "tsconfig.json"),
			);
			const scannerKey = isTsProject ? "jscpd-ts" : "jscpd";
			const cached = cacheManager.readCache<
				Awaited<ReturnType<JscpdClient["scan"]>>
			>(scannerKey, analysisRoot);
			if (cached) {
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				dbg(`session_start jscpd: cache hit (${scannerKey})`);
			} else {
				const startMs = Date.now();
				const jscpdResult = await jscpdClient.scan(
					analysisRoot,
					undefined,
					undefined,
					isTsProject,
				);
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				cacheManager.writeCache(scannerKey, jscpdResult, analysisRoot, {
					scanDurationMs: Date.now() - startMs,
				});
				dbg(
					`session_start jscpd scan done (${Date.now() - startMs}ms, isTsProject=${isTsProject})`,
				);
			}
		} else {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start jscpd: not available");
		}
	});

	// dead-code — cross-file dead-code for non-JS/TS languages (#127). Each
	// client self-gates via detect() (a cheap fs marker probe), so only a
	// matching-language project incurs the whole-tree scan cost. Knip remains
	// the JS/TS path (above); these run alongside it for polyglot repos.
	runTask("dead-code", async () => {
		const applicable = deadCodeClients.filter((c) => c.detect(analysisRoot));
		if (applicable.length === 0) return;
		await Promise.all(
			applicable.map(async (client) => {
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				const cacheKey = `dead-code-${client.id}`;
				const cached = cacheManager.readCache<DeadCodeResult>(
					cacheKey,
					analysisRoot,
				);
				if (cached) {
					dbg(`session_start dead-code(${client.id}): cache hit`);
					return;
				}
				const startMs = Date.now();
				const result = await client.analyze(analysisRoot);
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				cacheManager.writeCache(cacheKey, result, analysisRoot, {
					scanDurationMs: Date.now() - startMs,
				});
				logDeadCodeScan({
					language: client.language,
					success: result.success,
					cached: false,
					unusedExports: result.unusedExports.length,
					unusedFiles: result.unusedFiles.length,
					unusedDeps: result.unusedDeps.length,
					unlistedDeps: result.unlistedDeps.length,
					durationMs: result.durationMs ?? Date.now() - startMs,
					...(!result.success && { reason: result.summary }),
				});
				dbg(
					`session_start dead-code(${client.id}) done (${Date.now() - startMs}ms, ${deadCodeIssueCount(result)} issues)`,
				);
			}),
		);
	});

	// govulncheck — Go module CVE detection (#132)
	// Skipped silently when the project isn't a Go module or when
	// `govulncheck` isn't installed (no auto-install in this slice).
	runTask("govulncheck", async () => {
		if (!GovulncheckClient.hasGoModule(analysisRoot)) {
			dbg("session_start govulncheck: no go.mod — skipped");
			return;
		}
		if (!(await govulncheckClient.ensureAvailable())) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				"session_start govulncheck: not installed (go install golang.org/x/vuln/cmd/govulncheck@latest)",
			);
			return;
		}
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<GovulncheckResult>(
			"govulncheck",
			analysisRoot,
		);
		if (cached) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				`session_start govulncheck: cache hit (${cached.data.findings.length} findings)`,
			);
			return;
		}
		const startMs = Date.now();
		const result = await govulncheckClient.analyze(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		cacheManager.writeCache("govulncheck", result, analysisRoot, {
			scanDurationMs: Date.now() - startMs,
		});
		dbg(
			`session_start govulncheck: ${result.findings.length} reachable findings (${Date.now() - startMs}ms)`,
		);
	});

	// gitleaks — committed-secrets detection (#130)
	// Config-gated: opts in via .gitleaks.toml / .gitleaksignore / git
	// hook / gitleaks dep. Cross-language by design.
	runTask("gitleaks", async () => {
		if (!GitleaksClient.hasGitleaksSignal(analysisRoot)) {
			dbg("session_start gitleaks: no opt-in signal — skipped");
			return;
		}
		if (!(await gitleaksClient.ensureAvailable())) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start gitleaks: not available (install failed?)");
			return;
		}
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<GitleaksResult>(
			"gitleaks",
			analysisRoot,
		);
		if (cached) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				`session_start gitleaks: cache hit (${cached.data.findings.length} findings)`,
			);
			return;
		}
		const startMs = Date.now();
		const result = await gitleaksClient.scan(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		cacheManager.writeCache("gitleaks", result, analysisRoot, {
			scanDurationMs: Date.now() - startMs,
		});
		dbg(
			`session_start gitleaks: ${result.findings.length} findings (${Date.now() - startMs}ms)`,
		);
	});

	// trivy — dependency CVE detection (#131, Phase 1)
	// Explicit opt-in: `trivy.enabled: true` in .pi-lens.json AND a dependency
	// manifest present. The first run downloads Trivy's vuln DB (~30-200 MB);
	// harmless here since this whole task runs in the background session_start
	// wrapper.
	runTask("trivy", async () => {
		if (!TrivyClient.shouldScan(analysisRoot)) {
			dbg("session_start trivy: not enabled / no dependency manifest — skipped");
			return;
		}
		if (!(await trivyClient.ensureAvailable())) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start trivy: not available (install failed?)");
			return;
		}
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<TrivyResult>("trivy", analysisRoot);
		if (cached) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				`session_start trivy: cache hit (${cached.data.findings.length} findings)`,
			);
			return;
		}
		const startMs = Date.now();
		const result = await trivyClient.scan(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		cacheManager.writeCache("trivy", result, analysisRoot, {
			scanDurationMs: Date.now() - startMs,
		});
		dbg(
			`session_start trivy: ${result.findings.length} CVE findings (${Date.now() - startMs}ms)`,
		);
	});

	// call-graph — build function-level call graph from review graph data
	runTask("call-graph", async () => {
		const { FactStore } = await import("./dispatch/fact-store.js");
		const {
			buildOrUpdateGraph,
			extractSymbolsAndRefsFromGraph,
			isReviewGraphMigrationNeeded,
		} = await import("./review-graph/builder.js");
		const {
			buildCallGraph,
			saveCallGraph,
			loadCallGraph,
			staleFiles,
			readMtimes,
		} = await import("./call-graph.js");
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const startMs = Date.now();
		// Try loading from cache first
		const cached = loadCallGraph(snapshotRoot);
		if (cached) {
			const cachedFiles = [...cached.fileMtimes.keys()];
			const stale = staleFiles(cached.fileMtimes, cachedFiles);
			// #260: a stale REVIEW-graph version must force a rebuild even when the
			// (separate) call-graph cache is fresh — otherwise an upgrade that
			// invalidated the persisted graph (e.g. v2→v3 test exclusion) leaves
			// reads cold until the next edit. The version check is cheap (file head).
			if (
				stale.length === 0 &&
				cachedFiles.length > 0 &&
				!isReviewGraphMigrationNeeded(analysisRoot)
			) {
				runtime.callGraph = cached.graph;
				dbg(
					`session_start call-graph: loaded from cache (${cached.graph.edges.length} edges, ${Date.now() - startMs}ms)`,
				);
				return;
			}
		}
		// Build from the review graph (reuses already-parsed data, no re-parse)
		const sessionFacts = new FactStore();
		const graph = await buildOrUpdateGraph(analysisRoot, [], sessionFacts);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const { allSymbols, allRefs } = extractSymbolsAndRefsFromGraph(graph);
		const callGraph = buildCallGraph(allSymbols, allRefs);
		runtime.callGraph = callGraph;
		const mtimes = readMtimes([...allSymbols.keys()]);
		saveCallGraph(snapshotRoot, callGraph, mtimes);
		dbg(
			`session_start call-graph: built ${callGraph.edges.length} edges, ${callGraph.callers.size} callee entries (${Date.now() - startMs}ms)`,
		);
	});

	// codebase-model — build mental model from call graph (internal-only until validated)
	runTask("codebase-model", async () => {
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		if (!runtime.callGraph) return; // call-graph task may not have completed yet
		const { buildCodebaseModel, saveCodebaseModel } = await import(
			"./codebase-model.js"
		);
		const model = buildCodebaseModel(runtime.callGraph, analysisRoot);
		saveCodebaseModel(snapshotRoot, model);
		const top3 = model.entries
			.slice(0, 3)
			.map((e) => e.name)
			.join(", ");
		dbg(
			`session_start codebase-model: ${model.entries.length} entries, ` +
				`${model.totalTokens} tokens, top symbols: ${top3 || "(none)"}`,
		);
	});

	// ast-grep — export scan for duplicate detection
	runTask("ast-grep-exports", async () => {
		if (await astGrepClient.ensureAvailable()) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			const exports = await astGrepClient.scanExports(
				analysisRoot,
				"typescript",
			);
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(`session_start exports scan: ${exports.size} functions found`);
			for (const [name, file] of exports) {
				runtime.cachedExports.set(name, file);
			}
			saveRuntimeProjectSnapshot({ cwd: snapshotRoot, runtime, dbg });
		}
	});

	// word-index — identifier inverted index + BM25 for ranked symbol search (#162)
	runTask("word-index", async () => {
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const { collectSourceFilesAsync } = await import("./source-filter.js");
		const { buildWordIndex } = await import("./word-index.js");
		const startMs = Date.now();
		// Bounds keep the build off the critical path on large repos: cap the file
		// count and skip files too large to be hand-written source (generated /
		// bundled output the source filter didn't already exclude).
		const MAX_FILES = 6000;
		const MAX_BYTES = 512 * 1024;
		const files = await collectSourceFilesAsync(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const docs: Array<{ path: string; content: string }> = [];
		let processed = 0;
		for (const file of files.slice(0, MAX_FILES)) {
			try {
				const stat = nodeFs.statSync(file);
				if (stat.size <= MAX_BYTES) {
					docs.push({
						path: file,
						content: nodeFs.readFileSync(file, "utf-8"),
					});
				}
			} catch {
				// unreadable / vanished file — skip
			}
			if (++processed % 100 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (!runtime.isCurrentSession(sessionGeneration)) return;
			}
		}
		runtime.wordIndex = buildWordIndex(docs);
		saveRuntimeProjectSnapshot({ cwd: snapshotRoot, runtime, dbg });
		dbg(
			`session_start word-index: ${runtime.wordIndex.docCount} files, ` +
				`${runtime.wordIndex.postings.size} tokens (${Date.now() - startMs}ms)`,
		);
	});
}

function scheduleDeferredToolProbes(
	deps: SessionStartDeps,
	languageProfile: ReturnType<typeof detectProjectLanguageProfile>,
	startupDefaults: string[],
	startupScansWillRun: boolean,
	dbg: SessionStartDeps["dbg"],
): void {
	const { biomeClient, ruffClient, depChecker } = deps;
	const defaultTools = new Set(startupDefaults);
	const probes: Array<[name: string, run: () => Promise<boolean>]> = [];

	// Do not probe tools already covered by startup preinstall or startup scans.
	// This keeps session_start logs from showing duplicate "ensure X: start" lines
	// while preserving lazy checks for tools that are actually relevant.
	if (languageProfile.present.jsts && !defaultTools.has("biome")) {
		probes.push(["biome", () => biomeClient.ensureAvailable()]);
	}
	if (languageProfile.present.python && !defaultTools.has("ruff")) {
		probes.push(["ruff", () => ruffClient.ensureAvailable()]);
	}
	if (startupScansWillRun) {
		probes.push(["madge", () => depChecker.ensureAvailable()]);
	}

	if (probes.length === 0) {
		dbg("session_start tools: no deferred availability probes needed");
		return;
	}

	void (async () => {
		const warmStart = Date.now();
		const results = await Promise.all(
			probes.map(async ([name, run]) => {
				try {
					return [name, await run()] as const;
				} catch (err) {
					dbg(`session_start: ${name} availability check failed: ${err}`);
					return [name, false] as const;
				}
			}),
		);
		const summary = results
			.map(([name, ready]) => `${name}=${ready}`)
			.join(" ");
		dbg(
			`session_start tools (deferred probes complete, ${Date.now() - warmStart}ms): ${summary}`,
		);
	})();
}

/**
 * Session-start orientation prepended as a context message (gated by the
 * context-injection toggle). Deliberately lean: it names the high-value tools
 * and the one non-obvious behaviour (mode=all resurfaces stale blocking errors)
 * — per-tool argument detail lives in each tool's own registered description, so
 * re-documenting it here would just pay the tokens twice every session.
 */
export const SESSION_START_GUIDANCE: string[] = [
	"📌 pi-lens active — automated checks run on every edit/write; blocking errors (including pre-existing) show inline and must be fixed.\n" +
		"Key tools (see each tool's own description for args):\n" +
		"• lens_diagnostics — session-wide diagnostic state; mode=all resurfaces stale blocking errors that dropped from turn context.\n" +
		"• module_report + read_symbol — navigable file outline + single-symbol body; cheaper than reading a whole file before editing.\n" +
		"• lsp_navigation / lsp_diagnostics — definitions/references/rename; probe LSP for errors in a file/folder/workspace.\n" +
		"• ast_grep_search / ast_grep_replace — structural code patterns (ast_dump to discover node kinds).",
];

export async function handleSessionStart(
	deps: SessionStartDeps,
): Promise<void> {
	const sessionStartMs = Date.now();
	// Cold-start input-latency mitigation. The first `session_start` of
	// the process — i.e. the one that fires immediately after the user
	// launches `pi` — must return as fast as possible so the TUI input
	// box becomes responsive. The full startup mode runs several
	// expensive synchronous walks (resolveStartupScanContext,
	// detectProjectLanguageProfile, scanProjectRules, scheduleStartupScans)
	// that together can block the event loop for 3-6s on a 2k-file
	// project, during which keystrokes are dropped or batched.
	//
	// Strategy:
	//   - Force the very first invocation to "quick" mode, which exits
	//     after a minimal runtime reset and snapshot hydration.
	//   - 2 seconds later, schedule a background warmup that walks the
	//     project asynchronously (yielding every 100 entries) and
	//     populates the in-process memo caches
	//     (startupScanContextCache + languageProfileCache).
	//   - The user's first /new (or any subsequent session_start) sees
	//     a cache hit on both walks and finishes the full path in <50ms.
	//
	// Opt-out: PI_LENS_COLD_START_QUICK=0 disables this behaviour.
	// Override: PI_LENS_STARTUP_MODE explicitly set wins (we honour it).
	// Tunable: PI_LENS_WARMUP_DELAY_MS adjusts the warmup delay.
	let startupMode = resolveStartupMode();
	const processGlobals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	const isFirstSessionOfProcess = !processGlobals.__piLensFirstSessionDone;
	if (
		isFirstSessionOfProcess &&
		process.env.PI_LENS_COLD_START_QUICK !== "0" &&
		!process.env.PI_LENS_STARTUP_MODE
	) {
		startupMode = "quick";
	}
	processGlobals.__piLensFirstSessionDone = true;

	if (
		startupMode === "quick" &&
		process.env.PI_LENS_COLD_START_QUICK !== "0" &&
		!processGlobals.__piLensWarmupScheduled
	) {
		processGlobals.__piLensWarmupScheduled = true;
		const warmupDelayMs = Number(process.env.PI_LENS_WARMUP_DELAY_MS ?? 2000);
		const warmupCwd = deps.ctxCwd ?? process.cwd();
		const warmupDbg = deps.dbg;
		setTimeout(() => {
			const warmupStartedAt = Date.now();
			void (async () => {
				try {
					warmupDbg("warmup: starting background warmup");
					// Dynamic imports keep the warmup pipeline off the hot
					// startup path — these modules don't load until the timer
					// fires, well after the TUI is interactive.
					const startupScanModule = await import("./startup-scan.js");
					const languageProfileModule = await import("./language-profile.js");
					const scan =
						await startupScanModule.resolveStartupScanContextAsync(warmupCwd);
					warmupDbg(
						`warmup: scan-context done in ${Date.now() - warmupStartedAt}ms (canWarm=${scan.canWarmCaches})`,
					);
					// Respect the startup-scan guard (#250): canWarmCaches is false for
					// home-dir / no-project-root / too-many-source-files. Proceeding into
					// the language-profile source walk in those cases lets it root at an
					// ancestor (e.g. a marker in $HOME when pi runs in ~/tmp) and traverse
					// the entire home tree — multi-hour scans. Nothing to warm anyway when
					// the guard says caches can't be warmed.
					if (!scan.canWarmCaches) {
						warmupDbg(
							`warmup: skipping language-profile (canWarm=false, reason=${scan.reason ?? "unknown"})`,
						);
						return;
					}
					const languageRoot = scan.projectRoot ?? warmupCwd;
					const languageProfileStartedAt = Date.now();
					await languageProfileModule.detectProjectLanguageProfileAsync(
						languageRoot,
					);
					warmupDbg(
						`warmup: language-profile done in ${Date.now() - languageProfileStartedAt}ms`,
					);
					warmupDbg(`warmup: total ${Date.now() - warmupStartedAt}ms`);
				} catch (err) {
					warmupDbg(`warmup: error ${err}`);
					// Allow a future session to retry the warmup.
					processGlobals.__piLensWarmupScheduled = false;
				}
			})();
		}, warmupDelayMs);
	}

	const allowBootstrapTasks = startupMode === "full";
	const quickMode = startupMode === "quick";
	const {
		ctxCwd,
		getFlag,
		notify,
		dbg,
		log,
		runtime,
		metricsClient,
		cacheManager,
		typeCoverageClient: _typeCoverageClient,
		testRunnerClient,
		goClient,
		rustClient,
		ensureTool,
		cleanStaleTsBuildInfo,
		resetDispatchBaselines,
		resetLSPService,
	} = deps;

	// Lightweight phase timer — resets after each call so each log line shows
	// the cost of that phase alone, not cumulative time from session start.
	let _phaseT = Date.now();
	const phase = (name: string): void => {
		dbg(`session_start phase ${name}: ${Date.now() - _phaseT}ms`);
		_phaseT = Date.now();
	};

	metricsClient.reset();
	getDiagnosticTracker().reset();
	clearFileTimeSessions();
	runtime.complexityBaselines.clear();
	resetDispatchBaselines(ctxCwd);
	runtime.resetForSession();

	// Run log cleanup early in session start (non-blocking)
	const logCleanup = runLogCleanup(dbg);
	if (logCleanup.cleaned > 0 || logCleanup.rotated > 0) {
		notify(`🧹 ${logCleanup.report}`, "info");
	}
	dbg(`session_start startup mode: ${startupMode}`);

	if (!getFlag("no-lsp")) {
		resetLSPService({ fast: true });
		dbg("session_start: LSP service reset");
		dbg(
			"session_start: phase0 workspace diagnostics observation enabled (capability probe only)",
		);
	}

	const hasWorkspaceCwd = typeof ctxCwd === "string" && ctxCwd.length > 0;
	const cwd = ctxCwd ?? process.cwd();
	if (quickMode) {
		runtime.projectRoot = cwd;
		const snapshotRoot = resolveSnapshotRoot(cwd);
		const latestSeq = readLatestProjectSequence(snapshotRoot);
		runtime.seedProjectSequence?.(
			latestSeq.projectSeq,
			latestSeq.fileSeqByPath,
		);
		const effectiveSeq = runtime.projectSeq ?? latestSeq.projectSeq;
		dbg(
			`session_start sequence: projectSeq=${effectiveSeq} fileSeqEntries=${latestSeq.fileSeqByPath.size}`,
		);
		const snapshot = loadProjectSnapshot(snapshotRoot);
		logProjectSnapshotProbe({
			dbg,
			root: snapshotRoot,
			currentProjectSeq: effectiveSeq,
			snapshot,
		});
		if (isProjectSnapshotFresh(snapshot, effectiveSeq)) {
			hydrateRuntimeFromProjectSnapshot(runtime, snapshot);
		}
		const quickTools: string[] = [];
		if (!getFlag("no-lsp")) {
			quickTools.push("LSP Service");
		}
		log(`Active tools: ${quickTools.join(", ")}`);
		dbg(
			`session_start tools: ${quickTools.join(", ") || "deferred (quick mode)"}`,
		);
		dbg(
			"session_start: quick mode active - skipping slow tool probes, language profiling, preinstall, scans, and error debt baseline",
		);
		dbg(
			`session_start total: ${Date.now() - sessionStartMs}ms (interactive path)`,
		);
		return;
	}

	const tools: string[] = [];
	if (!getFlag("no-lsp")) tools.push("LSP Service");

	if (allowBootstrapTasks && !getFlag("no-lsp")) {
		const cleaned = cleanStaleTsBuildInfo(ctxCwd ?? process.cwd());
		if (cleaned.length > 0) {
			notify(
				`🧹 Deleted stale TypeScript build cache (${cleaned.map((f) => path.basename(f)).join(", ")}) — phantom errors suppressed.`,
				"warning",
			);
			dbg(`session_start: cleaned stale tsbuildinfo: ${cleaned.join(", ")}`);
		}
	}

	const snapshotRoot = resolveSnapshotRoot(cwd);
	const latestSeq = readLatestProjectSequence(snapshotRoot);
	runtime.seedProjectSequence?.(latestSeq.projectSeq, latestSeq.fileSeqByPath);
	const effectiveSeq = runtime.projectSeq ?? latestSeq.projectSeq;
	dbg(
		`session_start sequence: projectSeq=${effectiveSeq} fileSeqEntries=${latestSeq.fileSeqByPath.size}`,
	);

	const snapshot = loadProjectSnapshot(snapshotRoot);
	logProjectSnapshotProbe({
		dbg,
		root: snapshotRoot,
		currentProjectSeq: effectiveSeq,
		snapshot,
	});
	const freshSnapshot = isProjectSnapshotFresh(snapshot, effectiveSeq)
		? snapshot
		: null;
	if (freshSnapshot) {
		hydrateRuntimeFromProjectSnapshot(runtime, freshSnapshot);
	}

	const startupScanSource = freshSnapshot?.startupScan
		? "snapshot"
		: "computed";
	const startupScan: StartupScanContext = freshSnapshot?.startupScan
		? { ...freshSnapshot.startupScan, cwd: path.resolve(cwd) }
		: resolveStartupScanContext(cwd);
	phase("scan-context");
	dbg(`session_start scan-context source=${startupScanSource}`);
	const scanRoot = startupScan.projectRoot ?? cwd;
	const useScanRootForSignals =
		startupScan.canWarmCaches || startupScan.reason === "too-many-source-files";
	const analysisRoot = useScanRootForSignals ? scanRoot : cwd;
	runtime.projectRoot = cwd;
	const languageProfileSource = freshSnapshot?.languageProfile
		? "snapshot"
		: "computed";
	const languageProfile = freshSnapshot?.languageProfile
		? freshSnapshot.languageProfile
		: detectProjectLanguageProfile(
				analysisRoot,
				startupScan.canWarmCaches ? undefined : [],
			);
	phase("language-profile");
	dbg(`session_start language-profile source=${languageProfileSource}`);
	dbg(`session_start cwd: ${cwd}`);
	dbg(
		`session_start scan root: ${scanRoot} (warmCaches=${startupScan.canWarmCaches}${startupScan.reason ? `, reason=${startupScan.reason}` : ""})`,
	);
	dbg(`session_start analysis root: ${analysisRoot}`);
	dbg(`session_start workspace root: ${runtime.projectRoot}`);
	dbg(
		`session_start language profile: ${languageProfile.detectedKinds.join(", ") || "none"}`,
	);
	dbg(
		`session_start language counts: ${JSON.stringify(languageProfile.counts)} configured=${JSON.stringify(languageProfile.configured)}`,
	);
	dbg(`session_start workspace cwd available: ${hasWorkspaceCwd}`);
	if (useScanRootForSignals && analysisRoot !== cwd) {
		dbg(`session_start: monorepo analysis root override -> ${analysisRoot}`);
	}

	const lensLspEnabled = !getFlag("no-lsp");
	const startupDefaults = getDefaultStartupTools(languageProfile).filter(
		(tool) => {
			if (
				(tool === "typescript-language-server" || tool === "pyright") &&
				!lensLspEnabled
			) {
				return false;
			}
			return true;
		},
	);

	if (!allowBootstrapTasks) {
		dbg("session_start: skipping tool preinstall (startup mode)");
	} else if (startupDefaults.length > 0) {
		dbg(`session_start: pre-install defaults -> ${startupDefaults.join(", ")}`);
		firePreinstallDefaults(ensureTool, dbg, startupDefaults);
	} else {
		dbg("session_start: no language defaults selected for pre-install");
	}

	const startupScansWillRun = allowBootstrapTasks && startupScan.canWarmCaches;
	const jstsHeavyScansWillRun =
		startupScansWillRun && canRunStartupHeavyScans(languageProfile, "jsts");
	if (allowBootstrapTasks) {
		scheduleDeferredToolProbes(
			deps,
			languageProfile,
			startupDefaults,
			jstsHeavyScansWillRun,
			dbg,
		);
	}

	if (allowBootstrapTasks) {
		// Fire-and-forget like other tool probes
		void probePrettierInstall(ensureTool, dbg, analysisRoot);
	} else {
		dbg("session_start: skipping prettier preinstall probe (startup mode)");
	}

	const detectedRunner = testRunnerClient.detectRunner(analysisRoot);
	phase("test-runner-detect");
	if (detectedRunner) tools.push(`Test runner (${detectedRunner.runner})`);
	if (await goClient.isGoAvailableAsync()) tools.push("Go (go vet)");
	if (await rustClient.isAvailableAsync()) tools.push("Rust (cargo)");
	log(`Active tools: ${tools.join(", ")}`);
	dbg(`session_start tools: ${tools.join(", ")}`);

	const agentStartupGuidance = SESSION_START_GUIDANCE;

	runtime.projectRulesScan = scanProjectRules(analysisRoot);
	saveRuntimeProjectSnapshot({
		cwd: snapshotRoot,
		runtime,
		startupScan,
		languageProfile,
		dbg,
	});
	phase("project-rules");
	if (runtime.projectRulesScan.hasCustomRules) {
		const ruleCount = runtime.projectRulesScan.rules.length;
		const sources = [
			...new Set(runtime.projectRulesScan.rules.map((r) => r.source)),
		];
		dbg(
			`session_start: found ${ruleCount} project rule(s) from ${sources.join(", ")}`,
		);
	} else {
		dbg("session_start: no project rules found");
	}

	cacheManager.writeCache(
		"session-start-guidance",
		{ content: agentStartupGuidance.join("\n") },
		analysisRoot,
	);

	const sessionGeneration = runtime.sessionGeneration;
	if (!allowBootstrapTasks) {
		dbg("session_start: skipping startup background scans (startup mode)");
	} else if (!startupScan.canWarmCaches) {
		dbg(
			`session_start: skipping heavy scans (${startupScan.reason ?? "unknown"})`,
		);
		dbg(
			`session_start: skipping TODO scan (${startupScan.reason ?? "unknown"})`,
		);
	} else {
		scheduleStartupScans(
			deps,
			runtime,
			sessionGeneration,
			analysisRoot,
			snapshotRoot,
			languageProfile,
			dbg,
		);
	}

	// LSP warm files — deferred to the next event-loop turn so the config walk
	// (several ENOENT readFile calls up the directory tree) never runs on the
	// interactive path. setImmediate guarantees handleSessionStart has already
	// resolved before loadLSPConfig is even called.
	if (!getFlag("no-lsp") && allowBootstrapTasks) {
		setImmediate(() => {
			void loadLSPConfig(cwd).then((lspConfig) => {
				const warmFiles = lspConfig.warmFiles ?? [];
				dbg(
					`session_start lsp-config: loaded (${warmFiles.length} warm file(s) configured)`,
				);
				if (warmFiles.length > 0) {
					igniteWarmFiles(
						cwd,
						warmFiles,
						runtime,
						sessionGeneration,
						dbg,
					).catch((err) =>
						dbg(`session_start lsp-warm: unhandled error: ${err}`),
					);
				} else if (startupScan.canWarmCaches) {
					// No explicit warmFiles — pre-spawn just the dominant language's
					// LSP so the first edit doesn't pay the cold-spawn stall (#203).
					// Only do the auto-discovery warm on guarded real project roots; on
					// home/no-project/too-large roots this source walk can become the same
					// delayed background tree scan that the startup-scan guard prevents.
					igniteDominantLanguageWarm(
						analysisRoot,
						runtime,
						sessionGeneration,
						dbg,
					).catch((err) =>
						dbg(`session_start lsp-warm: unhandled dominant error: ${err}`),
					);
				} else {
					dbg(
						`session_start lsp-warm: skipping dominant-language auto-warm (${startupScan.reason ?? "unknown"})`,
					);
				}
			});
		});
		phase("lsp-config");
	}

	setSessionLanguages(languageProfile.detectedKinds);

	dbg(
		`session_start total: ${Date.now() - sessionStartMs}ms (interactive path; background tasks may continue)`,
	);
}
