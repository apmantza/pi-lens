import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { ArchitectClient } from "./architect-client.js";
import type { AstGrepClient } from "./ast-grep-client.js";
import type { BiomeClient } from "./biome-client.js";
import type { CacheManager } from "./cache-manager.js";
import type { DependencyChecker } from "./dependency-checker.js";
import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import { getKnipIgnorePatterns } from "./file-utils.js";
import type { GoClient } from "./go-client.js";
import type { JscpdClient } from "./jscpd-client.js";
import type { KnipClient } from "./knip-client.js";
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
	architectClient: ArchitectClient;
	testRunnerClient: TestRunnerClient;
	goClient: GoClient;
	rustClient: RustClient;
	ensureTool: (name: string) => Promise<string | null | undefined>;
	cleanStaleTsBuildInfo: (cwd: string) => string[];
	resetDispatchBaselines: () => void;
	resetLSPService: () => void;
}

export async function handleSessionStart(
	deps: SessionStartDeps,
): Promise<void> {
	const {
		ctxCwd,
		getFlag,
		notify,
		dbg,
		log,
		runtime,
		metricsClient,
		cacheManager,
		todoScanner,
		astGrepClient,
		biomeClient,
		ruffClient,
		knipClient,
		jscpdClient,
		typeCoverageClient,
		depChecker,
		architectClient,
		testRunnerClient,
		goClient,
		rustClient,
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

	if (getFlag("lens-lsp") && !getFlag("no-lsp")) {
		resetLSPService();
		dbg("session_start: LSP service reset");
	}

	if (getFlag("auto-install")) {
		process.env.PI_LENS_AUTO_INSTALL = "1";
		dbg("session_start: LSP auto-install enabled (PI_LENS_AUTO_INSTALL=1)");
	} else {
		delete process.env.PI_LENS_AUTO_INSTALL;
	}

	const tools: string[] = [];
	if (getFlag("lens-lsp") && !getFlag("no-lsp")) {
		tools.push("LSP Service");
	}
	if (biomeClient.isAvailable()) tools.push("Biome");
	if (astGrepClient.isAvailable()) tools.push("ast-grep");
	if (ruffClient.isAvailable()) tools.push("Ruff");
	if (knipClient.isAvailable()) tools.push("Knip");
	if (depChecker.isAvailable()) tools.push("Madge");
	if (jscpdClient.isAvailable()) tools.push("jscpd");
	if (typeCoverageClient.isAvailable()) tools.push("type-coverage");

	log(`Active tools: ${tools.join(", ")}`);
	dbg(`session_start tools: ${tools.join(", ")}`);

	if (getFlag("lens-lsp") && !getFlag("no-lsp")) {
		const cleaned = cleanStaleTsBuildInfo(ctxCwd ?? process.cwd());
		if (cleaned.length > 0) {
			notify(
				`🧹 Deleted stale TypeScript build cache (${cleaned.map((f) => path.basename(f)).join(", ")}) — phantom errors suppressed.`,
				"warning",
			);
			dbg(`session_start: cleaned stale tsbuildinfo: ${cleaned.join(", ")}`);
		}
	}

	if (getFlag("lens-lsp") && !getFlag("no-lsp")) {
		dbg("session_start: pre-installing TypeScript LSP...");
		ensureTool("typescript-language-server")
			.then((toolPath) => {
				if (toolPath) {
					dbg(`session_start: TypeScript LSP ready at ${toolPath}`);
				} else {
					console.error("[lens] TypeScript LSP installation failed");
				}
			})
			.catch((err) => {
				console.error("[lens] TypeScript LSP pre-install error:", err);
			});
	}

	const cwd = ctxCwd ?? process.cwd();
	const startupScan = resolveStartupScanContext(cwd);
	const scanRoot = startupScan.projectRoot ?? cwd;
	const analysisRoot = scanRoot;
	runtime.projectRoot = scanRoot;
	dbg(`session_start cwd: ${cwd}`);
	dbg(
		`session_start scan root: ${scanRoot} (warmCaches=${startupScan.canWarmCaches}${startupScan.reason ? `, reason=${startupScan.reason}` : ""})`,
	);
	if (analysisRoot !== cwd) {
		dbg(`session_start: monorepo analysis root override -> ${analysisRoot}`);
	}

	{
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

	const hasArchitectRules = architectClient.loadConfig(analysisRoot);
	if (hasArchitectRules) tools.push("Architect rules");

	const detectedRunner = testRunnerClient.detectRunner(analysisRoot);
	if (detectedRunner) {
		tools.push(`Test runner (${detectedRunner.runner})`);
	}
	if (goClient.isGoAvailable()) tools.push("Go (go vet)");
	if (rustClient.isAvailable()) tools.push("Rust (cargo)");
	log(`Active tools: ${tools.join(", ")}`);
	dbg(`session_start tools: ${tools.join(", ")}`);

	const startupNotes: string[] = [];
	startupNotes.push(
		"📌 pi-lens active — fix any errors you find (including pre-existing). Prefer: lsp_navigation for definitions/references, ast_grep_search for code patterns, grep for text/TODO search.",
	);

	runtime.projectRulesScan = scanProjectRules(analysisRoot);
	if (runtime.projectRulesScan.hasCustomRules) {
		const ruleCount = runtime.projectRulesScan.rules.length;
		const sources = [
			...new Set(runtime.projectRulesScan.rules.map((r) => r.source)),
		];
		dbg(
			`session_start: found ${ruleCount} project rule(s) from ${sources.join(", ")}`,
		);
		startupNotes.push(
			`📋 Project rules found: ${ruleCount} file(s) in ${sources.join(", ")}. These apply alongside pi-lens defaults.`,
		);
	} else {
		dbg("session_start: no project rules found");
	}

	const sessionGeneration = runtime.sessionGeneration;
	const runStartupTask = (name: string, task: () => Promise<void>): void => {
		runtime.markStartupScanInFlight(name, sessionGeneration);
		void task()
			.catch((err) => dbg(`session_start: ${name} background scan failed: ${err}`))
			.finally(() => {
				runtime.clearStartupScanInFlight(name, sessionGeneration);
			});
	};

	// Fire off all heavy scans as background tasks — don't block session start.
	// Each consumer already handles the "not ready yet" case gracefully
	// (cachedExports.size > 0, cachedProjectIndex != null, cache miss paths).

	// TODO scan is lightweight and synchronous — run in background via promise
	runStartupTask("todo", async () => {
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

	if (!startupScan.canWarmCaches) {
		dbg(
			`session_start: skipping heavy scans (${startupScan.reason ?? "unknown"})`,
		);
	} else {
		dbg(
			"session_start: launching background scans (knip, jscpd, ast-grep exports, project index)",
		);

		// Knip — dead code / unused exports
		runStartupTask("knip", async () => {
			if (await knipClient.ensureAvailable()) {
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				const cached = cacheManager.readCache<
					ReturnType<KnipClient["analyze"]>
				>("knip", analysisRoot);
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
		runStartupTask("jscpd", async () => {
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
		runStartupTask("ast-grep-exports", async () => {
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
		runStartupTask("project-index", async () => {
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

	dbg(
		`session_start: background scans launched (${startupNotes.length} startup note(s))`,
	);

	const errorDebtEnabled = getFlag("error-debt");
	const pendingDebt = cacheManager.readCache<{
		pendingCheck: boolean;
		baselineTestsPassed: boolean;
	}>("errorDebt", analysisRoot);

	if (errorDebtEnabled && detectedRunner && pendingDebt?.data?.pendingCheck) {
		dbg("session_start: running pending error debt check");
		const testResult = testRunnerClient.runTestFile(
			".",
			analysisRoot,
			detectedRunner.runner,
			detectedRunner.config,
		);
		const testsPassed = testResult.failed === 0 && !testResult.error;
		const baselinePassed = pendingDebt.data.baselineTestsPassed;

		if (baselinePassed && !testsPassed) {
			const msg = `🔴 ERROR DEBT: Tests were passing but now failing (${testResult.failed} failure(s)). Fix before continuing.`;
			dbg(`session_start ERROR DEBT: ${msg}`);
			notify(msg, "warning");
		}

		runtime.errorDebtBaseline = {
			testsPassed,
			buildPassed: true,
		};
		cacheManager.writeCache(
			"errorDebt",
			{
				pendingCheck: false,
				baselineTestsPassed: testsPassed,
			},
			analysisRoot,
		);
	} else if (errorDebtEnabled && detectedRunner) {
		dbg("session_start: establishing fresh error debt baseline");
		const testResult = testRunnerClient.runTestFile(
			".",
			analysisRoot,
			detectedRunner.runner,
			detectedRunner.config,
		);
		const testsPassed = testResult.failed === 0 && !testResult.error;
		runtime.errorDebtBaseline = {
			testsPassed,
			buildPassed: true,
		};
		dbg(
			`session_start error debt baseline: testsPassed=${runtime.errorDebtBaseline.testsPassed}`,
		);
	}

	if (startupNotes.length > 0) {
		notify(startupNotes.join("\n"), "info");
	}
}
