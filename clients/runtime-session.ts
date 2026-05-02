import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { AstGrepClient } from "./ast-grep-client.js";
import type { BiomeClient } from "./biome-client.js";
import type { CacheManager } from "./cache-manager.js";
import type { DependencyChecker } from "./dependency-checker.js";
import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import { getKnipIgnorePatterns } from "./file-utils.js";
import type { GoClient } from "./go-client.js";
import type { JscpdClient } from "./jscpd-client.js";
import type { KnipClient } from "./knip-client.js";
import { canRunStartupHeavyScans } from "./language-policy.js";
import {
	detectProjectLanguageProfile,
	getDefaultStartupTools,
} from "./language-profile.js";
import { runLogCleanup } from "./log-cleanup.js";
import { initLSPConfig, loadLSPConfig } from "./lsp/config.js";
import { getLSPService } from "./lsp/index.js";
import type { MetricsClient } from "./metrics-client.js";
import {
	buildProjectIndex,
	isIndexFresh,
	loadIndex,
	saveIndex,
} from "./project-index.js";
import type { RuffClient } from "./ruff-client.js";
import { scanProjectRules } from "./rules-scanner.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { RustClient } from "./rust-client.js";

import { getSourceFiles } from "./scan-utils.js";
import { resolveStartupScanContext } from "./startup-scan.js";
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
	typeCoverageClient: TypeCoverageClient;
	depChecker: DependencyChecker;
	testRunnerClient: TestRunnerClient;
	goClient: GoClient;
	rustClient: RustClient;
	ensureTool: (name: string) => Promise<string | null | undefined>;
	cleanStaleTsBuildInfo: (cwd: string) => string[];
	resetDispatchBaselines: () => void;
	resetLSPService: () => void;
}

type StartupMode = "full" | "minimal" | "quick";

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

// Fire off heavy scans as background tasks — don't block session start.
// Each consumer already handles the "not ready yet" case gracefully
// (cachedExports.size > 0, cachedProjectIndex != null, cache miss paths).
function scheduleStartupScans(
	deps: SessionStartDeps,
	runtime: RuntimeCoordinator,
	sessionGeneration: number,
	analysisRoot: string,
	languageProfile: ReturnType<typeof detectProjectLanguageProfile>,
	dbg: SessionStartDeps["dbg"],
): void {
	const { todoScanner, cacheManager, knipClient, jscpdClient, astGrepClient } =
		deps;

	const runTask = (name: string, task: () => Promise<void>): void => {
		const startedAt = Date.now();
		dbg(`session_start task ${name}: start`);
		runtime.markStartupScanInFlight(name, sessionGeneration);
		void task()
			.then(() => {
				dbg(
					`session_start task ${name}: success (${Date.now() - startedAt}ms)`,
				);
			})
			.catch((err) => {
				dbg(`session_start: ${name} background scan failed: ${err}`);
				dbg(`session_start task ${name}: failed (${Date.now() - startedAt}ms)`);
			})
			.finally(() => {
				runtime.clearStartupScanInFlight(name, sessionGeneration);
				dbg(`session_start task ${name}: end`);
			});
	};

	const canRunJsTsHeavyScans = canRunStartupHeavyScans(languageProfile, "jsts");
	const scanNames = ["todo"];
	if (canRunJsTsHeavyScans) {
		scanNames.push("knip", "jscpd", "ast-grep exports", "project index");
	}
	dbg(`session_start: launching background scans (${scanNames.join(", ")})`);

	runTask("todo", async () => {
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const todoResult = todoScanner.scanDirectory(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		dbg(
			`session_start TODO scan: ${todoResult.items.length} items (baseline stored)`,
		);
		cacheManager.writeCache(
			"todo-baseline",
			{ items: todoResult.items },
			analysisRoot,
		);
	});

	if (!canRunJsTsHeavyScans) {
		dbg(
			"session_start: skipping JS/TS startup scans (requires JS/TS language + project config)",
		);
		return;
	}

	// Knip — dead code / unused exports
	runTask("knip", async () => {
		if (await knipClient.ensureAvailable()) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			const cached = cacheManager.readCache<ReturnType<KnipClient["analyze"]>>(
				"knip",
				analysisRoot,
			);
			if (cached) {
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				dbg(
					`session_start Knip: cache hit (${Math.round((Date.now() - new Date(cached.meta.timestamp).getTime()) / 1000)}s ago)`,
				);
			} else {
				const startMs = Date.now();
				const knipResult = knipClient.analyze(
					analysisRoot,
					getKnipIgnorePatterns(),
				);
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				cacheManager.writeCache("knip", knipResult, analysisRoot, {
					scanDurationMs: Date.now() - startMs,
				});
				dbg(`session_start Knip scan done (${Date.now() - startMs}ms)`);
			}
		} else {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start Knip: not available");
		}
	});

	// jscpd — duplicate code detection
	runTask("jscpd", async () => {
		if (await jscpdClient.ensureAvailable()) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			const cached = cacheManager.readCache<ReturnType<JscpdClient["scan"]>>(
				"jscpd",
				analysisRoot,
			);
			if (cached) {
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				dbg("session_start jscpd: cache hit");
			} else {
				const startMs = Date.now();
				const jscpdResult = jscpdClient.scan(analysisRoot);
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				cacheManager.writeCache("jscpd", jscpdResult, analysisRoot, {
					scanDurationMs: Date.now() - startMs,
				});
				dbg(`session_start jscpd scan done (${Date.now() - startMs}ms)`);
			}
		} else {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start jscpd: not available");
		}
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
		}
	});

	// Project index — structural similarity detection
	runTask("project-index", async () => {
		const existing = await loadIndex(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		if (
			existing &&
			existing.entries.size > 0 &&
			(await isIndexFresh(analysisRoot))
		) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			runtime.cachedProjectIndex = existing;
			dbg(
				`session_start: loaded fresh project index (${existing.entries.size} entries)`,
			);
		} else {
			const sourceFiles = getSourceFiles(analysisRoot, true);
			const tsFiles = sourceFiles.filter(
				(f) => f.endsWith(".ts") || f.endsWith(".tsx"),
			);
			if (tsFiles.length > 0 && tsFiles.length <= 500) {
				runtime.cachedProjectIndex = await buildProjectIndex(
					analysisRoot,
					tsFiles,
				);
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				await saveIndex(runtime.cachedProjectIndex, analysisRoot);
				dbg(
					`session_start: built project index (${runtime.cachedProjectIndex.entries.size} entries from ${tsFiles.length} files)`,
				);
			} else {
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				dbg(`session_start: skipped project index (${tsFiles.length} files)`);
			}
		}
	});
}

export async function handleSessionStart(
	deps: SessionStartDeps,
): Promise<void> {
	const sessionStartMs = Date.now();
	const startupMode = resolveStartupMode();
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
		biomeClient,
		ruffClient,
		knipClient,
		jscpdClient,
		typeCoverageClient: _typeCoverageClient,
		depChecker,
		testRunnerClient,
		goClient,
		rustClient,
		astGrepClient,
		ensureTool,
		cleanStaleTsBuildInfo,
		resetDispatchBaselines,
		resetLSPService,
	} = deps;

	metricsClient.reset();
	getDiagnosticTracker().reset();
	runtime.complexityBaselines.clear();
	resetDispatchBaselines();
	runtime.resetForSession();

	// Run log cleanup early in session start (non-blocking)
	const logCleanup = runLogCleanup(dbg);
	if (logCleanup.cleaned > 0 || logCleanup.rotated > 0) {
		notify(`🧹 ${logCleanup.report}`, "info");
	}
	dbg(`session_start startup mode: ${startupMode}`);

	if (!getFlag("no-lsp")) {
		resetLSPService();
		dbg("session_start: LSP service reset");
		dbg(
			"session_start: phase0 workspace diagnostics observation enabled (capability probe only)",
		);
	}

	const hasWorkspaceCwd = typeof ctxCwd === "string" && ctxCwd.length > 0;
	const cwd = ctxCwd ?? process.cwd();
	if (quickMode) {
		runtime.projectRoot = cwd;
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
		dbg(`session_start total: ${Date.now() - sessionStartMs}ms`);
		return;
	}

	const tools: string[] = [];
	if (!getFlag("no-lsp")) tools.push("LSP Service");

	// Warm tool availability caches off the critical startup path. The previous
	// version used `setImmediate` + sync `isAvailable()`, which still blocked
	// the Node event loop (each `isAvailable()` runs `spawnSync` — and six of
	// the seven probes fall back to `npx <tool> --version` at ~1.5-2s each,
	// summing to ~8-10s of main-thread freeze during session_start).
	//
	// We now run each probe through the client's async `ensureAvailable()`
	// (which uses a fast bare-name PATH probe, falling back to `ensureTool`
	// async install) inside a fire-and-forget IIFE. No main-thread blocking.
	//
	// Notes:
	// - `typeCoverageClient` has no async probe and is only used by
	//   `/lens-booboo`, so we let it probe lazily when first needed.
	// - `ensureAvailable()` can auto-install missing tools into `~/.pi-lens/tools`.
	//   This matches `firePreinstallDefaults`' existing behaviour for biome /
	//   typescript-language-server.
	void (async () => {
		const warmStart = Date.now();
		const [biomeReady, sgReady, ruffReady] = await Promise.all([
			biomeClient.ensureAvailable().catch((err) => {
				dbg(`session_start: biome availability check failed: ${err}`);
				return false;
			}),
			astGrepClient.ensureAvailable().catch((err) => {
				dbg(`session_start: ast-grep availability check failed: ${err}`);
				return false;
			}),
			ruffClient.ensureAvailable().catch((err) => {
				dbg(`session_start: ruff availability check failed: ${err}`);
				return false;
			}),
		]);
		await Promise.allSettled([
			knipClient.ensureAvailable().catch((err) => {
				dbg(`session_start: knip availability check failed: ${err}`);
				return false;
			}),
			depChecker.ensureAvailable().catch((err) => {
				dbg(`session_start: dep-checker availability check failed: ${err}`);
				return false;
			}),
			jscpdClient.ensureAvailable().catch((err) => {
				dbg(`session_start: jscpd availability check failed: ${err}`);
				return false;
			}),
		]);
		dbg(
			`session_start tools (deferred probes complete, ${Date.now() - warmStart}ms): biome=${biomeReady} ast-grep=${sgReady} ruff=${ruffReady}`,
		);
	})();

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

	const startupScan = resolveStartupScanContext(cwd);
	const scanRoot = startupScan.projectRoot ?? cwd;
	const useScanRootForSignals =
		startupScan.canWarmCaches || startupScan.reason === "too-many-source-files";
	const analysisRoot = useScanRootForSignals ? scanRoot : cwd;
	runtime.projectRoot = cwd;
	const languageProfile = detectProjectLanguageProfile(analysisRoot);
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

	if (allowBootstrapTasks) {
		// Fire-and-forget like other tool probes
		void probePrettierInstall(ensureTool, dbg, analysisRoot);
	} else {
		dbg("session_start: skipping prettier preinstall probe (startup mode)");
	}

	const detectedRunner = testRunnerClient.detectRunner(analysisRoot);
	if (detectedRunner) tools.push(`Test runner (${detectedRunner.runner})`);
	if (goClient.isGoAvailable()) tools.push("Go (go vet)");
	if (rustClient.isAvailable()) tools.push("Rust (cargo)");
	log(`Active tools: ${tools.join(", ")}`);
	dbg(`session_start tools: ${tools.join(", ")}`);

	const agentStartupGuidance = [
		"📌 pi-lens active — automated checks run on your edits and writes. Blocking errors will be shown inline; you must fix all errors including pre-existing ones. Prefer: lsp_navigation for definitions/references, ast_grep_search for code patterns, grep for text/TODO search.",
	];

	runtime.projectRulesScan = scanProjectRules(analysisRoot);
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
			languageProfile,
			dbg,
		);
	}

	dbg("session_start: background scans launched");

	// LSP warm files — read config synchronously on the startup path (cheap file
	// walk), then fire-and-forget the LSP touchFile loop so session start is not
	// blocked by per-file LSP waits.
	if (!getFlag("no-lsp") && allowBootstrapTasks) {
		const lspConfig = await loadLSPConfig(cwd);
		const warmFiles = lspConfig.warmFiles ?? [];
		if (warmFiles.length > 0) {
			igniteWarmFiles(cwd, warmFiles, runtime, sessionGeneration, dbg).catch((err) =>
				dbg(`session_start lsp-warm: unhandled error: ${err}`),
			);
		}
	}

	dbg(`session_start total: ${Date.now() - sessionStartMs}ms`);
}
