import type { ExtensionAPI, ToolCallEventResult } from "@mariozechner/pi-coding-agent";

const clients = import("./clients/index.js");
const commands = import("./commands/index.js");
const i18n = import("./i18n.js");
const tools = import("./tools/index.js");
const utils = import("./utils.js");

export default async function (pi: ExtensionAPI): Promise<void> {
	// Immediately begin initializing components without blocking.
	const promise = {
		clients,
		commands,
		tools,
		utils,
		astGrepClient: (async () => {
			return (await clients).astGrep.AstGrepClient.create();
		})(),
		cacheManager: (async () => {
			return (await clients).cacheManager.CacheManager.create();
		})(),
		i18n: (async () => {
			(await i18n).initI18n(pi);
			return i18n;
		})(),
		runtime: (async () => {
			return (await clients).runtime.RuntimeCoordinator.create();
		})(),
		_readExpansionClient: (async () => {
			return (await clients).treeSitter.TreeSitterClient.create();
		})(),
	};

	const LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS = Math.max(
		0,
		Number.parseInt(
			process.env.PI_LENS_TOOLCALL_NAV_TOUCH_MS ??
				process.env.PI_LENS_LSP_NAV_CLIENT_WAIT_MS ??
				"1500",
			10,
		) || 1500,
	);
	const LSP_TOOLCALL_TOUCH_BUDGET_MS = Math.max(
		0,
		Number.parseInt(process.env.PI_LENS_TOOLCALL_TOUCH_MS ?? "750", 10) || 750,
	);

	// --- Flags ---

	pi.registerFlag("no-lens", {
		description:
			"Start pi-lens disabled for this session. Re-enable with /lens-toggle.",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-lsp", {
		description:
			"Disable unified LSP diagnostics and use language-specific fallbacks (for example ts-lsp, pyright)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-autoformat", {
		description:
			"Disable automatic formatting entirely (deferred format runs at agent_end by default)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("immediate-format", {
		description:
			"Run automatic formatting immediately after each write/edit instead of deferring to agent_end",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-autofix", {
		description: "Disable auto-fixing of lint issues (Biome, Ruff, ESLint)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-tests", {
		description: "Disable test runner on write",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-delta", {
		description: "Disable delta mode (show all diagnostics, not just new ones)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-guard", {
		description:
			"Experimental: block git commit/push when unresolved pi-lens blockers exist",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-semgrep", {
		description:
			"Enable Semgrep dispatch when a Semgrep config is available (or with --lens-semgrep-config)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-semgrep-config", {
		description:
			"Semgrep config for dispatch: local path, auto, p/<pack>, or r/<rule>. Requires --lens-semgrep.",
		type: "string",
		default: "",
	});

	pi.registerFlag("no-read-guard", {
		description: "Disable read-before-edit behavior monitor",
		type: "boolean",
		default: false,
	});

	// --- Commands ---

	pi.registerCommand("lens-toggle", {
		description:
			"Toggle pi-lens on/off for the current session. Usage: /lens-toggle",
		handler: async (_args, ctx) => {
			const clients = await promise.clients;
			clients.widget.setLensEnabled(!clients.widget.getLensEnabled());
			let lensEnabled = clients.widget.getLensEnabled();
			ctx.ui.notify(
				lensEnabled
					? "pi-lens enabled for this session."
					: "pi-lens disabled for this session. Run /lens-toggle again to resume.",
				lensEnabled ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("lens-widget-toggle", {
		description:
			"Show or hide the pi-lens diagnostics widget below the editor. Usage: /lens-widget-toggle",
		handler: async (_args, ctx) => {
			const clients = await promise.clients;
			const nextVisible = !clients.widget.getLensWidgetVisible();
			const changed = nextVisible
				? clients.widget.mountLensWidget(ctx.ui)
				: clients.widget.unmountLensWidget(ctx.ui);
			if (!changed) {
				ctx.ui.notify(
					"pi-lens widget is not supported by this pi version.",
					"warning",
				);
				return;
			}

			clients.widget.setLensWidgetVisible(nextVisible);
			ctx.ui.notify(
				clients.widget.getLensWidgetVisible()
					? "pi-lens widget shown. Run /lens-widget-toggle to hide it."
					: "pi-lens widget hidden. Run /lens-widget-toggle to show it.",
				"info",
			);
		},
	});

	pi.registerCommand("lens-semgrep", {
		description:
			"Manage Semgrep dispatch. Usage: /lens-semgrep status | enable [--config <auto|p/pack|path>] | disable | init",
		handler: async (args, ctx) => {
			const clients = await promise.clients;
			const utils = await promise.utils;

			const runtime = await promise.runtime;

			const parts = utils.normalizeCommandArgs(args);
			const action = parts[0] ?? "status";
			const cwd = ctx.cwd ?? runtime.projectRoot;

			function readConfigArg(): string | undefined {
				const flagIndex = parts.findIndex(
					(part) => part === "--config" || part === "-c",
				);
				if (flagIndex >= 0) return parts[flagIndex + 1];
				return parts[1] && !parts[1].startsWith("-") ? parts[1] : undefined;
			}

			if (action === "enable") {
				const config = readConfigArg();
				const localConfig = clients.semgrep.findLocalSemgrepConfig(cwd);
				if (!config && !localConfig) {
					ctx.ui.notify(
						[
							"Semgrep dispatch not enabled yet: no local .semgrep.yml was found.",
							"Use `/lens-semgrep init` to create a starter local config, or `/lens-semgrep enable --config auto` / `p/<pack>` if you want Semgrep registry/platform configuration.",
							"pi-lens will not auto-install Semgrep; install it with pipx/uv/brew first and login only if your chosen Semgrep config requires it.",
						].join("\n"),
						"warning",
					);
					return;
				}

				const savedPath = clients.semgrep.savePiLensSemgrepConfig(cwd, {
					enabled: true,
					...(config ? { config } : {}),
				});
				ctx.ui.notify(
					`Semgrep dispatch enabled (${config ? `config: ${config}` : `local config: ${localConfig}`}). Saved ${savedPath}`,
					"info",
				);
				return;
			}

			if (action === "disable") {
				const savedPath = clients.semgrep.savePiLensSemgrepConfig(cwd, { enabled: false });
				ctx.ui.notify(`Semgrep dispatch disabled. Saved ${savedPath}`, "info");
				return;
			}

			if (action === "clear") {
				const removed = clients.semgrep.removePiLensSemgrepConfig(cwd);
				ctx.ui.notify(
					removed
						? "Removed .pi-lens/semgrep.json; Semgrep now auto-enables only when local .semgrep.yml exists."
						: "No .pi-lens/semgrep.json found.",
					"info",
				);
				return;
			}

			if (action === "init") {
				const configPath = clients.semgrep.createStarterSemgrepConfig(cwd);
				const savedPath = clients.semgrep.savePiLensSemgrepConfig(cwd, { enabled: true });
				ctx.ui.notify(
					`Created starter Semgrep config at ${configPath} and enabled Semgrep dispatch (${savedPath}).`,
					"info",
				);
				return;
			}

			if (action !== "status") {
				ctx.ui.notify(
					"Usage: /lens-semgrep status | enable [--config <auto|p/pack|path>] | disable | clear | init",
					"warning",
				);
				return;
			}

			const localConfig = clients.semgrep.findLocalSemgrepConfig(cwd);
			const piLensConfig = clients.semgrep.loadPiLensSemgrepConfig(cwd);
			const resolved = clients.semgrep.resolveSemgrepConfig(cwd, {
				enabled: Boolean(pi.getFlag("lens-semgrep")),
				config: pi.getFlag("lens-semgrep-config"),
			});
			const version = await clients.spawn.safeSpawnAsync("semgrep", ["--version"], {
				cwd,
				timeout: 5000,
			});
			const lines = [
				"🔎 SEMGREP DISPATCH",
				`CLI: ${!version.error && version.status === 0 ? `installed (${(version.stdout || version.stderr).trim()})` : "not found on PATH"}`,
				`Local config: ${localConfig ?? "none"}`,
				`pi-lens config: ${piLensConfig ? JSON.stringify(piLensConfig) : "none"}`,
				`Effective: ${resolved.enabled ? "enabled" : "disabled"}`,
				`Config arg: ${resolved.configArg ?? "none"}`,
			];
			if (resolved.reason) lines.push(`Reason: ${resolved.reason}`);
			lines.push(
				"",
				"No auto-install. Token/login is only needed for Semgrep AppSec/Pro/managed configs; local .semgrep.yml scans do not require a token.",
			);
			ctx.ui.notify(lines.join("\n"), resolved.enabled ? "info" : "warning");
		},
	});

	pi.registerCommand("lens-booboo", {
		description:
			"Full codebase review: design smells, complexity, AI slop detection, TODOs, dead code, duplicates, type coverage. Results saved to .pi-lens/reviews/. Usage: /lens-booboo [path]",
		handler: async (args, ctx) => {
			const clients = await promise.clients;
			const commands = await promise.commands;

			const astGrep = await promise.astGrepClient;
			const {
				complexityClient,
				todoScanner,
				knipClient,
				jscpdClient,
				typeCoverageClient,
				depChecker,
			} = await clients.bootstrap.loadBootstrapClients();

			return commands.booboo.handleBooboo(
				args,
				ctx,
				{
					astGrep,
					complexity: complexityClient,
					todo: todoScanner,
					knip: knipClient,
					jscpd: jscpdClient,
					typeCoverage: typeCoverageClient,
					depChecker,
				},
				pi,
			);
		},
	});

	// DISABLED: lens-booboo-fix command - disabled per user request

	pi.registerCommand("lens-tdi", {
		description:
			"Show Technical Debt Index (TDI) and project health trend. Usage: /lens-tdi",
		handler: async (_args, ctx) => {
			const clients = await promise.clients;
			const history = clients.metrics.loadHistory();
			const tdi = clients.metrics.computeTDI(history);

			let summary = "🔴 High debt - run /lens-booboo-refactor";
			if (tdi.score <= 30) {
				summary = "✅ Codebase is healthy!";
			} else if (tdi.score <= 60) {
				summary = "⚠️ Moderate debt - consider refactoring";
			}
			const lines = [
				`📊 TECHNICAL DEBT INDEX: ${tdi.score}/100 (${tdi.grade})`,
				``,
				`Files analyzed: ${tdi.filesAnalyzed}`,
				`Files with debt: ${tdi.filesWithDebt}`,
				`Avg MI: ${tdi.avgMI}`,
				`Total cognitive complexity: ${tdi.totalCognitive}`,
				``,
				`Debt breakdown:`,
				`  Maintainability: ${tdi.byCategory.maintainability}% (MI-based)`,
				`  Cognitive: ${tdi.byCategory.cognitive}%`,
				`  Nesting: ${tdi.byCategory.nesting}%`,
				`  Max Cyclomatic: ${tdi.byCategory.maxCyclomatic}% (worst function)`,
				`  Entropy: ${tdi.byCategory.entropy}% (code unpredictability)`,
				``,
				summary,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-health", {
		description:
			"Show pi-lens runtime health: pipeline crashes, slow runners, and last dispatch latency. Usage: /lens-health",
		handler: async (_args, ctx) => {
			const path = await import("node:path");
			const clients = await promise.clients;
			const i18n = await promise.i18n;

			const runtime = await promise.runtime;

			const crashEntries = runtime
				.getCrashEntries()
				.sort((a, b) => b[1] - a[1]);
			const totalCrashes = crashEntries.reduce(
				(sum, [, count]) => sum + count,
				0,
			);

			const reports = clients.dispatch.integration.getLatencyReports();
			const last = reports.length > 0 ? reports[reports.length - 1] : undefined;
			const diagStats = clients.diagnostics.getDiagnosticTracker().getStats();
			const slowRunners = last
				? [...last.runners]
						.sort((a, b) => b.durationMs - a.durationMs)
						.slice(0, 3)
				: [];

			// Session duration
			const sessionAge = Date.now() - runtime.sessionStartedAt;
			const sessionMins = Math.floor(sessionAge / 60_000);
			const sessionHrs = Math.floor(sessionMins / 60);
			const sessionAgeStr =
				sessionHrs > 0
					? `${sessionHrs}h ${sessionMins % 60}m`
					: `${sessionMins}m`;
			const startedAt = new Date(runtime.sessionStartedAt).toLocaleTimeString(
				[],
				{ hour: "2-digit", minute: "2-digit" },
			);

			const lines: string[] = [
				i18n.t("lens.health.title", "🩺 PI-LENS HEALTH"),
				`Session started: ${startedAt} (${sessionAgeStr} ago)`,
				"",
				i18n.t("lens.health.crashes", "Pipeline crashes (session): {count}", {
					count: totalCrashes,
				}),
				i18n.t("lens.health.files", "Files affected: {count}", {
					count: crashEntries.length,
				}),
			];
			const slopScoreLine = clients.dispatch.integration.getDispatchSlopScoreLine();

			if (crashEntries.length > 0) {
				lines.push("", i18n.t("lens.health.topCrashFiles", "Top crash files:"));
				for (const [file, count] of crashEntries.slice(0, 5)) {
					lines.push(`  ${path.basename(file)}: ${count}`);
				}
			}

			if (last) {
				lines.push(
					"",
					`Last dispatch: ${path.basename(last.filePath)} (${last.totalDurationMs}ms, ${last.totalDiagnostics} diagnostics)`,
				);
				if (slowRunners.length > 0) {
					lines.push("Top runners (last dispatch):");
					for (const runner of slowRunners) {
						lines.push(
							`  ${runner.runnerId}: ${runner.durationMs}ms (${runner.status})`,
						);
					}
				}
			} else {
				lines.push(
					"",
					i18n.t("lens.health.noLatency", "No dispatch latency reports yet."),
				);
			}

			lines.push(
				"",
				i18n.t("lens.health.diagnosticsShown", "Diagnostics shown: {count}", {
					count: diagStats.totalShown,
				}),
				i18n.t("lens.health.autoFixed", "Auto-fixed: {count}", {
					count: diagStats.totalAutoFixed,
				}),
				i18n.t("lens.health.agentFixed", "Agent-fixed: {count}", {
					count: diagStats.totalAgentFixed,
				}),
				i18n.t("lens.health.unresolved", "Unresolved carryover: {count}", {
					count: diagStats.totalUnresolved,
				}),
			);

			if (diagStats.repeatOffenders.length > 0) {
				lines.push(i18n.t("lens.health.repeatOffenders", "Repeat offenders:"));
				for (const offender of diagStats.repeatOffenders.slice(0, 5)) {
					lines.push(
						`  ${path.basename(offender.filePath)}:${offender.line} ${offender.ruleId} (${offender.count}x)`,
					);
				}
			}

			if (diagStats.topViolations.length > 0) {
				lines.push(i18n.t("lens.health.topNoisyRules", "Top noisy rules:"));
				for (const v of diagStats.topViolations.slice(0, 5)) {
					const samplePath =
						v.samplePaths.length > 0
							? path
									.relative(runtime.projectRoot, v.samplePaths[0])
									.replace(/\\/g, "/")
							: "";
					const pathSuffix = samplePath ? ` (e.g. ${samplePath})` : "";
					lines.push(`  ${v.ruleId}: ${v.count}${pathSuffix}`);
				}
			}

			// LSP status
			const lspClients = clients.lsp.getLSPService().getStatus();
			if (lspClients.length > 0) {
				lines.push("", "LSP servers:");
				for (const { serverId, root, connected } of lspClients) {
					const state = connected ? "✓" : "✗";
					const rootLabel = path.relative(runtime.projectRoot, root) || ".";
					lines.push(`  ${state} ${serverId} (${rootLabel})`);
				}
			} else {
				lines.push("", "LSP servers: none started");
			}

			// Cascade summary
			const cascadeStats = clients.dispatch.integration.getCascadeSessionStats();
			if (cascadeStats.runs > 0) {
				lines.push(
					"",
					`Cascade runs: ${cascadeStats.runs}`,
					`Cascade diagnostics surfaced: ${cascadeStats.diagnosticsSurfaced}`,
				);
				if (cascadeStats.coldSnapshotTouches > 0) {
					lines.push(
						`Cold-snapshot touches: ${cascadeStats.coldSnapshotTouches}`,
					);
				}
			}

			if (slopScoreLine) {
				lines.push("", slopScoreLine);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-tools", {
		description:
			"Show pi-lens tool installation status: globally installed, auto-installed, or npx fallback. Usage: /lens-tools",
		handler: async (_args, ctx) => {
			const clients = await promise.clients;

			const statuses = await clients.installer.getAllToolStatuses();

			const bySource = {
				"global-path": statuses.filter((s) => s.source === "global-path"),
				"npm-global": statuses.filter((s) => s.source === "npm-global"),
				"pip-user": statuses.filter((s) => s.source === "pip-user"),
				"pi-lens-auto": statuses.filter((s) => s.source === "pi-lens-auto"),
				"github-release": statuses.filter((s) => s.source === "github-release"),
				"npx-fallback": statuses.filter((s) => s.source === "npx-fallback"),
				"not-installed": statuses.filter((s) => s.source === "not-installed"),
			};

			const lines: string[] = [
				"🔧 PI-LENS TOOLS STATUS",
				"",
				`Installed: ${statuses.filter((s) => s.installed).length}/${statuses.length}`,
			];

			// Global PATH tools
			if (bySource["global-path"].length > 0) {
				lines.push("", `📍 Global PATH (${bySource["global-path"].length}):`);
				for (const tool of bySource["global-path"]) {
					const version = tool.version ? ` (${tool.version})` : "";
					lines.push(`  ✓ ${tool.name}${version}`);
				}
			}

			// npm global tools
			if (bySource["npm-global"].length > 0) {
				lines.push("", `📦 npm global (${bySource["npm-global"].length}):`);
				for (const tool of bySource["npm-global"]) {
					lines.push(`  ✓ ${tool.name}`);
				}
			}

			// pip user tools
			if (bySource["pip-user"].length > 0) {
				lines.push("", `🐍 pip user (${bySource["pip-user"].length}):`);
				for (const tool of bySource["pip-user"]) {
					lines.push(`  ✓ ${tool.name}`);
				}
			}

			// GitHub releases
			if (bySource["github-release"].length > 0) {
				lines.push(
					"",
					`⬇️ GitHub releases (${bySource["github-release"].length}):`,
				);
				for (const tool of bySource["github-release"]) {
					lines.push(`  ✓ ${tool.name}`);
				}
			}

			// pi-lens auto-installed
			if (bySource["pi-lens-auto"].length > 0) {
				lines.push(
					"",
					`🤖 Auto-installed (${bySource["pi-lens-auto"].length}):`,
				);
				for (const tool of bySource["pi-lens-auto"]) {
					lines.push(`  ✓ ${tool.name}`);
				}
			}

			// npx fallback
			if (bySource["npx-fallback"].length > 0) {
				lines.push(
					"",
					`📦 npx fallback (${bySource["npx-fallback"].length} - on-demand install):`,
				);
				for (const tool of bySource["npx-fallback"]) {
					lines.push(`  ⬜ ${tool.name}`);
				}
			}

			// Not installed (should be empty for npm tools, they'll use npx)
			const trulyMissing = bySource["not-installed"].filter(
				(s) => s.strategy !== "npm",
			);
			if (trulyMissing.length > 0) {
				lines.push("", `❌ Missing (${trulyMissing.length}):`);
				for (const tool of trulyMissing) {
					lines.push(`  ✗ ${tool.name} (${tool.strategy})`);
				}
				lines.push(
					"",
					"Note: GitHub-release tools auto-install when you open files of those languages",
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-allow-edit", {
		description:
			"Allow one edit to a file without a prior read. Usage: /lens-allow-edit <path>",
		handler: async (args, ctx) => {
			const path = await import("node:path");
			const utils = await promise.utils;

			const runtime = await promise.runtime;

			const [rawTarget] = utils.normalizeCommandArgs(args);
			if (!rawTarget) {
				ctx.ui.notify("Usage: /lens-allow-edit <path>", "warning");
				return;
			}

			const targetPath = path.isAbsolute(rawTarget)
				? rawTarget
				: path.resolve(ctx.cwd ?? runtime.projectRoot, rawTarget);
			runtime.readGuard.addExemption(targetPath);
			ctx.ui.notify(
				`Read guard override armed for next edit: ${targetPath}`,
				"info",
			);
		},
	});

	// REMOVED: ~450 lines of inline tool definitions moved to tools/
	// See tools/ast-grep-search.ts, tools/ast-grep-replace.ts, tools/lsp-navigation.ts

	// Runtime state is managed by RuntimeCoordinator.

	// Project rules scan result and per-turn state live in RuntimeCoordinator.

	// --- Register skills with pi ---
	pi.on("resources_discover", async (_event, _ctx) => {
		const clients = await promise.clients;
		const tools = await promise.tools;
		const skillsDir = clients.packageRoot.resolvePackagePath(import.meta.url, "skills");

		// --- Tools (extracted to tools/) ---
		pi.registerTool(tools.astGrep.createAstGrepSearchTool(promise.astGrepClient) as any);
		pi.registerTool(tools.astGrep.createAstGrepReplaceTool(promise.astGrepClient) as any);
		pi.registerTool(tools.lspNavigation.createLspNavigationTool((name) => pi.getFlag(name)) as any);

		clients.widget.setLensEnabled(!pi.getFlag("no-lens"));

		return {
			skillPaths: [skillsDir],
		};
	});

	// --- Events ---

	pi.on("session_start", async (event, ctx) => {
		const clients = await promise.clients;
		const utils = await promise.utils;

		const runtime = await promise.runtime;
		const astGrepClient = await promise.astGrepClient;
		const cacheManager = await promise.cacheManager;

		try {
			utils.dbg("session_start fired");
			runtime.updateIdentityFromEvent(event);
			try {
				await clients.lsp.config.ensureLSPConfigInitialized(ctx.cwd ?? process.cwd());
			} catch (cfgErr) {
				utils.dbg(`lsp config init failed: ${cfgErr}`);
			}

			const {
				metricsClient,
				todoScanner,
				biomeClient,
				ruffClient,
				knipClient,
				jscpdClient,
				typeCoverageClient,
				depChecker,
				testRunnerClient,
				goClient,
				rustClient,
			} = await clients.bootstrap.loadBootstrapClients();
			await clients.runtime.handleSessionStart({
				ctxCwd: ctx.cwd,
				getFlag: (name: string) => pi.getFlag(name),
				notify: (msg, level) => ctx.ui.notify(msg, level),
				dbg: utils.dbg,
				log: utils.log,
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
				testRunnerClient,
				goClient,
				rustClient,
				ensureTool: async (name: string) => clients.installer.ensureTool(name),
				cleanStaleTsBuildInfo: utils.cleanStaleTsBuildInfo,
				resetDispatchBaselines: clients.dispatch.integration.resetDispatchBaselines,
				resetLSPService: clients.lsp.resetLSPService,
			});
			ctx.ui && clients.lsp.updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
			clients.widget.clearWidgetState();
			if (ctx.ui?.setWidget) {
				ctx.ui.setWidget(
					"pi-lens",
					(tui: any, theme: any) => {
						clients.widget.setRenderCallback(() => tui.requestRender());
						return {
							render: (width: number) => clients.widget.renderWidget(width, theme),
							invalidate: () => clients.widget.setRenderCallback(() => {}),
						};
					},
					{ placement: "belowEditor" },
				);
			}
		} catch (sessionErr) {
			utils.dbg(`session_start crashed: ${sessionErr}`);
			utils.dbg(`session_start crash stack: ${(sessionErr as Error).stack}`);
		}
	});

	// type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | void> => {
		const nodeFs = await import("node:fs");
		const path = await import("node:path");
		const piCodingAgent = await import("@mariozechner/pi-coding-agent");
		const clients = await promise.clients;
		const tools = await promise.tools;
		const utils = await promise.utils;

		const runtime = await promise.runtime;
		const cacheManager = await promise.cacheManager;

		const toolName = (event as { toolName?: string }).toolName ?? "";
		if (!clients.widget.getLensEnabled()) return;
		if (
			pi.getFlag("lens-guard") &&
			clients.git.isGitCommitOrPushAttempt(toolName, event.input)
		) {
			const guard = clients.git.evaluateGitGuard(
				runtime,
				cacheManager,
				ctx.cwd ?? runtime.projectRoot,
			);
			if (guard.block) {
				return {
					block: true,
					reason: guard.reason,
				};
			}
		}

		const rawFilePath = utils.getToolCallRawFilePath(toolName, event);
		const filePath = utils.resolveToolCallFilePath(
			rawFilePath,
			ctx.cwd,
			runtime.projectRoot,
		);

		if (!pi.getFlag("no-lsp")) {
			try {
				const configCwd = filePath
					? path.dirname(filePath)
					: (ctx.cwd ?? runtime.projectRoot ?? process.cwd());
				await clients.lsp.config.ensureLSPConfigInitialized(configCwd);
			} catch (cfgErr) {
				utils.dbg(`lsp config init failed during tool_call: ${cfgErr}`);
			}
		}

		if (!filePath) return;

		utils.dbg(
			`tool_call fired for: ${filePath} (exists: ${nodeFs.existsSync(filePath)})`,
		);
		if (!nodeFs.existsSync(filePath)) return;

		const isExternalOrVendor = clients.path.isExternalOrVendorFile(
			filePath,
			runtime.projectRoot,
		);

		const lspCapableFile = clients.file.isLspCapableFile(filePath);
		const lspAutoTouchSkipped = clients.path.shouldSkipLspAutoTouch(
			filePath,
			runtime.projectRoot,
		);
		const lspAutoTouchEligible = lspCapableFile && !lspAutoTouchSkipped;
		const shouldWarmReadLsp =
			toolName === "read" &&
			lspAutoTouchEligible &&
			runtime.shouldWarmLspOnRead(filePath);
		const shouldAutoTouch =
			(toolName === "write" ||
				toolName === "edit" ||
				toolName === "lsp_navigation" ||
				shouldWarmReadLsp) &&
			!pi.getFlag("no-lsp") &&
			lspAutoTouchEligible;
		if (!lspCapableFile && !pi.getFlag("no-lsp")) {
			utils.dbg(
				`lsp auto-touch skipped: ${path.basename(filePath)} (file kind not LSP-capable)`,
			);
		} else if (lspAutoTouchSkipped && !pi.getFlag("no-lsp")) {
			utils.dbg(
				`lsp auto-touch skipped: ${path.basename(filePath)} (internal/support artifact)`,
			);
		}
		if (toolName === "read" && !pi.getFlag("no-lsp") && !shouldWarmReadLsp) {
			const readSkipReason = !lspAutoTouchEligible
				? "file not eligible for LSP warm"
				: "already warming or warmed recently";
			utils.dbg(
				`lsp read warm skipped: ${path.basename(filePath)} (${readSkipReason})`,
			);
		}
		if (shouldAutoTouch) {
			try {
				const fileContent = nodeFs.readFileSync(filePath, "utf-8");
				const maxClientWaitMs =
					toolName === "lsp_navigation"
						? LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS
						: LSP_TOOLCALL_TOUCH_BUDGET_MS;
				if (toolName === "read") {
					runtime.markLspReadWarmStarted(filePath);
					utils.dbg(`lsp read warm started: ${path.basename(filePath)}`);
				}
				void clients.lsp.getLSPService()
					.touchFile(filePath, fileContent, {
						diagnostics: "none",
						source: `tool_call:${toolName}`,
						clientScope: "primary",
						maxClientWaitMs,
					})
					.then(() => {
						if (toolName === "read") {
							runtime.markLspReadWarmCompleted(filePath);
							utils.dbg(`lsp read warm completed: ${path.basename(filePath)}`);
						}
						if (ctx.ui) {
							ctx.ui && clients.lsp.updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
						}
					})
					.catch((err) => {
						if (toolName === "read") {
							runtime.clearLspReadWarmState(filePath);
						}
						utils.dbg(`lsp auto-touch failed for ${filePath}: ${err}`);
					});
			} catch {
				if (toolName === "read") {
					runtime.clearLspReadWarmState(filePath);
				}
				// Best effort only; never block tool calls.
			}
		}

		const readInput = tools.read.getReadToolInput(toolName, event.input);
		const requestedReadOffset = readInput?.offset ?? 1;
		const requestedReadLimit = readInput?.limit;
		let effectiveReadOffset = requestedReadOffset;
		let effectiveReadLimit = clients.read.getEffectiveReadLimit(filePath, readInput);

		// --- Opportunistic read expansion via tree-sitter ---
		// For partial reads (small limit, not from line 1), find the enclosing
		// symbol and expand the read range to cover it. This gives the read guard
		// accurate symbol-level coverage without requiring an LSP server.
		let expandedByLsp = false;
		let enclosingSymbol:
			| {
					name: string;
					kind: string;
					startLine: number;
					endLine: number;
			  }
			| undefined;

		if (
			toolName === "read" &&
			!pi.getFlag("no-lsp") &&
			!isExternalOrVendor &&
			filePath &&
			readInput &&
			requestedReadLimit != null &&
			requestedReadLimit <= clients.read.EXPANSION_LIMIT_LINES
		) {
			const _readExpansionClient = await promise._readExpansionClient;
			const totalLines =
				effectiveReadLimit != null && requestedReadLimit == null
					? effectiveReadLimit
					: clients.read.countFileLines(filePath);
			try {
				const expansion = await clients.read.tryExpandRead(
					filePath,
					requestedReadOffset,
					requestedReadLimit,
					totalLines,
					_readExpansionClient,
				);
				if (expansion) {
					readInput.offset = expansion.newOffset;
					readInput.limit = expansion.newLimit;
					effectiveReadOffset = expansion.newOffset;
					effectiveReadLimit = expansion.newLimit;
					expandedByLsp = true;
					enclosingSymbol = expansion.enclosingSymbol;
					clients.read.logReadGuardEvent({
						event: "ts_range_expanded",
						sessionId: runtime.telemetrySessionId,
						filePath,
						requestedOffset: requestedReadOffset,
						requestedLimit: requestedReadLimit,
						effectiveOffset: expansion.newOffset,
						effectiveLimit: expansion.newLimit,
						symbol: expansion.enclosingSymbol.name,
						symbolKind: expansion.enclosingSymbol.kind,
						symbolStartLine: expansion.enclosingSymbol.startLine,
						symbolEndLine: expansion.enclosingSymbol.endLine,
						metadata: {
							durationMs: expansion.durationMs,
							budgetMs: clients.read.EXPANSION_BUDGET_MS,
						},
					});
					utils.dbg(
						`ts expanded read: ${path.basename(filePath)} ` +
							`lines ${requestedReadOffset}–${requestedReadOffset + requestedReadLimit - 1} ` +
							`→ ${expansion.enclosingSymbol.name} ` +
							`(${expansion.newOffset}–${expansion.newOffset + expansion.newLimit - 1})`,
					);
				}
			} catch {
				// Best-effort only.
			}
		}

		// --- Read-Before-Edit Guard: record reads ---
		if (toolName === "read" && filePath && !isExternalOrVendor) {
			const totalLines = clients.read.countFileLines(filePath);
			const deliveredLimit = effectiveReadLimit ?? 1;
			clients.read.logReadGuardEvent({
				event: "read_pattern",
				sessionId: runtime.telemetrySessionId,
				filePath,
				requestedOffset: requestedReadOffset,
				requestedLimit: requestedReadLimit ?? deliveredLimit,
				effectiveOffset: effectiveReadOffset,
				effectiveLimit: deliveredLimit,
				metadata: {
					totalLines,
					isPartial:
						requestedReadLimit != null && requestedReadLimit < totalLines,
					fileKind: clients.file.detectFileKind(filePath) ?? "unknown",
					fractionRead:
						totalLines > 0
							? Math.round((deliveredLimit / totalLines) * 100) / 100
							: 1,
					expandedByTs: expandedByLsp,
				},
			});
			runtime.readGuard.recordRead({
				filePath,
				requestedOffset: requestedReadOffset,
				requestedLimit: requestedReadLimit ?? deliveredLimit,
				effectiveOffset: effectiveReadOffset,
				effectiveLimit: deliveredLimit,
				expandedByLsp,
				enclosingSymbol,
				turnIndex: runtime.turnIndex,
				writeIndex: runtime.peekWriteIndex(),
				timestamp: Date.now(),
			});
		}

		const { complexityClient } = await clients.bootstrap.loadBootstrapClients();
		// Record complexity baseline for historical tracking (booboo/tdi).
		// Not shown inline - just captured for delta analysis.
		if (
			!isExternalOrVendor &&
			complexityClient.isSupportedFile(filePath) &&
			!runtime.complexityBaselines.has(filePath)
		) {
			const baseline = complexityClient.analyzeFile(filePath);
			if (baseline) {
				runtime.complexityBaselines.set(filePath, baseline);
				clients.metrics.captureSnapshot(filePath, {
					maintainabilityIndex: baseline.maintainabilityIndex,
					cognitiveComplexity: baseline.cognitiveComplexity,
					maxNestingDepth: baseline.maxNestingDepth,
					linesOfCode: baseline.linesOfCode,
					maxCyclomatic: baseline.maxCyclomaticComplexity,
					entropy: baseline.codeEntropy,
				});
			}
		}

		// --- Read-Before-Edit Guard: check edits ---
		// write = full replacement; no prior read needed (you're starting fresh).
		// edit = partial modification; guard enforced to prevent blind overwrites.
		const isEditOnly = piCodingAgent.isToolCallEventType("edit", event);
		const isWriteOrEdit = piCodingAgent.isToolCallEventType("write", event) || isEditOnly;

		// --- Indentation mismatch correction ---
		// Some models output spaces in oldText when the file uses tabs (or vice versa).
		// Detect this before the read guard runs so a recoverable mismatch does not
		// degrade into a no-line-info allow path.
		if (isEditOnly && filePath) {
			const editInput = (event as { input?: unknown }).input as {
				oldText?: string;
				edits?: Array<{ oldText?: string }>;
			};
			const oldTexts = editInput.oldText
				? [{ label: "oldText", value: editInput.oldText }]
				: (editInput.edits ?? [])
						.map((e, i) =>
							e.oldText
								? { label: `edits[${i}].oldText`, value: e.oldText }
								: null,
						)
						.filter(
							(
								entry,
							): entry is {
								label: string;
								value: string;
							} => entry !== null,
						);
			const correctedOldTexts = oldTexts
				.map(({ label, value }) => ({
					label,
					value,
					corrected: clients.read.tryCorrectIndentationMismatch(value, filePath),
				}))
				.filter(
					(
						entry,
					): entry is {
						label: string;
						value: string;
						corrected: string;
					} => entry.corrected !== undefined,
				);
			if (correctedOldTexts.length > 0) {
				const details = correctedOldTexts
					.map(({ label, value, corrected }) => {
						const preview = value.trimStart().slice(0, 60).replace(/\n/g, "↵");
						return (
							`${label} ("${preview}…") has mismatched indentation (tabs vs spaces).\n` +
							`Replace ${label} with this verbatim (do not shorten, do not change newText):\n\n${corrected}`
						);
					})
					.join("\n\n");
				return {
					block: true,
					reason:
						`🔄 RETRYABLE — Indentation mismatch detected\n\n` +
						`The file uses a different indentation style than your oldText. ` +
						`Retry the same edit call immediately with the corrected oldText shown below — copy it exactly as-is.\n\n` +
						details,
				};
			}
		}
		if (isEditOnly && filePath && !pi.getFlag("no-read-guard")) {
			const readGuard = runtime.readGuard;
			const isExistingFile =
				typeof readGuard?.isNewFile !== "function" ||
				!readGuard.isNewFile(filePath);
			if (readGuard && isExistingFile) {
				const { touchedLines, editRanges, preflightError } = clients.read.getTouchedLinesForGuard(
					event,
					filePath,
					runtime.telemetrySessionId,
				);
				if (preflightError) {
					return { block: true, reason: preflightError };
				}
				clients.read.logReadGuardEvent({
					event: "edit_check_started",
					sessionId: runtime.telemetrySessionId,
					filePath,
					metadata: {
						tool: piCodingAgent.isToolCallEventType("write", event) ? "write" : "edit",
						touchedLines: touchedLines ?? null,
						isExistingFile,
					},
				});
				const verdict =
					typeof readGuard.checkEdit === "function"
						? readGuard.checkEdit(filePath, touchedLines, editRanges)
						: { action: "allow" as const };
				if (verdict.action === "block") {
					return {
						block: true,
						reason: verdict.reason,
					};
				}
			}
		}

		// --- Pre-write duplicate detection ---
		// Check if new content redefines functions that already exist elsewhere.
		// Uses cachedExports (populated at session_start via ast-grep scan).
		if (isWriteOrEdit && runtime.cachedExports.size > 0) {
			const newContent = utils.getNewContentFromToolCall(event);
			if (newContent) {
				const INLINE_SIMILARITY_THRESHOLD = 0.9;
				const INLINE_SIMILARITY_MAX_HINTS = 3;
				const INLINE_SIMILARITY_MAX_CHARS = 700;
				const dupeWarnings: string[] = [];
				const exportRe =
					/export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g;
				// Read current on-disk content once so we can check whether the file
				// being written already owns a given export (e.g. it IS the source and
				// another file merely re-exports from it). cachedExports only tracks one
				// file per name — whichever was scanned first — so a re-exporter can
				// win the slot and incorrectly shadow the original definition.
				let currentFileExports: Set<string> | undefined;
				if (filePath && nodeFs.existsSync(filePath)) {
					try {
						const currentContent = nodeFs.readFileSync(filePath, "utf-8");
						currentFileExports = new Set<string>();
						for (const m of currentContent.matchAll(exportRe)) {
							currentFileExports.add(m[1]);
						}
					} catch {
						// non-fatal — fall back to no current-export knowledge
					}
				}
				for (const match of newContent.matchAll(exportRe)) {
					const name = match[1];
					const existingFile = runtime.cachedExports.get(name);
					if (
						existingFile &&
						path.resolve(existingFile) !== path.resolve(filePath) &&
						!currentFileExports?.has(name)
					) {
						dupeWarnings.push(
							`\`${name}\` already exists in ${path.relative(runtime.projectRoot, existingFile)}`,
						);
					}
				}
				if (dupeWarnings.length > 0) {
					return {
						block: true,
						reason:
							"🔴 STOP - Redefining existing export(s). Import instead:\n" +
							dupeWarnings.map((w) => "  • " + w).join("\n"),
					};
				}

				// --- Structural similarity check (Phase 7b) ---
				// If the project index was built at session_start, check new
				// functions against it for structural clones (~50ms).
				if (
					runtime.cachedProjectIndex &&
					runtime.cachedProjectIndex.entries.size > 0 &&
					/\.(ts|tsx)$/.test(filePath)
				) {
					try {
						const ts = await import("typescript");
						const sourceFile = ts.createSourceFile(
							filePath,
							newContent,
							ts.ScriptTarget.Latest,
							true,
						);
						const newFunctions = clients.dispatch.runners.similarity.extractFunctions(ts, sourceFile, newContent);
						const simWarnings: string[] = [];
						let simHintsTruncated = false;
						const relPath = path.relative(runtime.projectRoot, filePath);

						for (const func of newFunctions) {
							if (simWarnings.length >= INLINE_SIMILARITY_MAX_HINTS) {
								simHintsTruncated = true;
								break;
							}
							if (func.transitionCount < 20) continue;
							const matches = clients.projectIndex.findSimilarFunctions(
								func.matrix,
								runtime.cachedProjectIndex,
								INLINE_SIMILARITY_THRESHOLD,
								1,
							);
							for (const match of matches) {
								if (simWarnings.length >= INLINE_SIMILARITY_MAX_HINTS) {
									simHintsTruncated = true;
									break;
								}
								const targetPathMatch = String(match.targetLocation).match(
									/^(.*):\d+$/,
								);
								const targetPath =
									targetPathMatch?.[1] ?? String(match.targetLocation);
								const resolvedTarget = path.isAbsolute(targetPath)
									? targetPath
									: path.join(runtime.projectRoot, targetPath);
								if (!nodeFs.existsSync(resolvedTarget)) continue;

								// Skip self-matches
								if (match.targetId === `${relPath}:${func.name}`) continue;
								const pct = Math.round(match.similarity * 100);
								simWarnings.push(
									`\`${func.name}\` is ${pct}% similar to \`${match.targetName}\` at \`${String(match.targetLocation).replace(/\\/g, "/")}\``,
								);
							}
						}

						if (simWarnings.length > 0) {
							let reason = `⚠️ Potential structural similarity (advisory):\n${simWarnings.map((w) => `  • ${w}`).join("\n")}`;
							if (simHintsTruncated) {
								reason += "\n  • ... additional similar candidates omitted";
							}
							reason +=
								"\nUse this only as a hint; verify behavior before refactoring.";
							if (reason.length > INLINE_SIMILARITY_MAX_CHARS) {
								reason = `${reason.slice(0, INLINE_SIMILARITY_MAX_CHARS)}\n... (truncated)`;
							}
							return {
								block: false,
								reason,
							};
						}
					} catch {
						// Parsing failed - skip similarity check silently
					}
				}
			}
		}
	});

	// Real-time feedback on file writes/edits
	// biome-ignore lint/suspicious/noExplicitAny: pi.on overload mismatch for tool_result event type
	(pi as any).on("tool_result", async (event: any) => {
		const clients = await promise.clients;
		const utils = await promise.utils;

		const runtime = await promise.runtime;
		const cacheManager = await promise.cacheManager;

		if (!clients.widget.getLensEnabled()) return;
		runtime.updateIdentityFromEvent(event);
		const { biomeClient, ruffClient, metricsClient, agentBehaviorClient } =
			await clients.bootstrap.loadBootstrapClients();
		return clients.runtime.handleToolResult({
			event: event as any,
			getFlag: (name: string) => pi.getFlag(name),
			dbg: utils.dbg,
			runtime,
			cacheManager,
			biomeClient,
			ruffClient,
			metricsClient,
			resetLSPService: clients.lsp.resetLSPService,
			agentBehaviorRecord: (toolName, filePath) =>
				agentBehaviorClient.recordToolCall(toolName, filePath),
			formatBehaviorWarnings: (warnings) =>
				agentBehaviorClient.formatWarnings(warnings as any),
		});
	});

	// --- Turn end: batch jscpd/madge on collected files, then clear state ---
	// Clear cascade snapshot at start of each new turn so stale data never leaks
	pi.on("turn_start", async (_event: any) => {
		const clients = await promise.clients;
		const runtime = await promise.runtime;
		runtime.beginTurn();
		clients.runtime.clearLastAnalyzedStateCache();
	});

	pi.on("agent_end", async (_event, ctx) => {
		const clients = await promise.clients;
		const utils = await promise.utils;

		const runtime = await promise.runtime;
		const cacheManager = await promise.cacheManager;

		if (!clients.widget.getLensEnabled()) return;
		try {
			await clients.runtime.handleAgentEnd({
				ctxCwd: ctx.cwd,
				getFlag: (name: string) => pi.getFlag(name),
				notify: (msg, level) => ctx.ui.notify(msg, level),
				dbg: utils.dbg,
				runtime,
				cacheManager,
				getFormatService: () =>
					clients.format.getFormatService(runtime.telemetrySessionId, true),
			});
			ctx.ui && clients.lsp.updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
		} catch (agentEndErr) {
			utils.dbg(`agent_end crashed: ${agentEndErr}`);
			utils.dbg(`agent_end crash stack: ${(agentEndErr as Error).stack}`);
		}
	});

	pi.on("turn_end", async (_event: any, ctx) => {
		const clients = await promise.clients;
		const utils = await promise.utils;

		const runtime = await promise.runtime;
		const cacheManager = await promise.cacheManager;

		if (!clients.widget.getLensEnabled()) return;
		try {
			const { knipClient, depChecker, testRunnerClient } =
				await clients.bootstrap.loadBootstrapClients();
			await clients.runtime.handleTurnEnd({
				ctxCwd: ctx.cwd,
				getFlag: (name: string) => pi.getFlag(name),
				dbg: utils.dbg,
				runtime,
				cacheManager,
				knipClient,
				depChecker,
				testRunnerClient,
				resetLSPService: clients.lsp.resetLSPService,
				resetFormatService: clients.format.resetFormatService,
			});
			ctx.ui && clients.lsp.updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
		} catch (turnEndErr) {
			utils.dbg(`turn_end crashed: ${turnEndErr}`);
			utils.dbg(`turn_end crash stack: ${(turnEndErr as Error).stack}`);
		}
	});

	// --- Session shutdown: release all handles so subagent processes exit cleanly ---
	// The LSP idle-reset timer (240s) is unref'd but we cancel it explicitly here
	// so it does not fire after shutdown. resetLSPService shuts down any live clients.
	pi.on("session_shutdown", async () => {
		const clients = await promise.clients;
		clients.runtime.cancelLSPIdleReset();
		clients.lsp.resetLSPService();
	});

	// --- Inject turn-end findings into next agent turn ---
	// jscpd, madge, and turn-end delta results are cached at turn_end and consumed here
	// via the context event, which fires before each provider request.
	// Important: keep the user's prompt as the trailing message. Some provider bridges
	// treat the final message as the active user action, so pi-lens context must be
	// prepended instead of appended.
	// biome-ignore lint/suspicious/noExplicitAny: pi.on("context") overload has TS resolution bug
	pi.on("context", async (event, ctx): Promise<any | void> => {
			const clients = await promise.clients;
			const utils = await promise.utils;

			const cacheManager = await promise.cacheManager;
			if (!clients.widget.getLensEnabled()) return;
			try {
				const cwd = ctx.cwd ?? process.cwd();
				const turnEndFindings = clients.runtime.consumeTurnEndFindings(cacheManager, cwd);
				const sessionGuidance = clients.runtime.consumeSessionStartGuidance(cacheManager, cwd);
				const testFindings = clients.runtime.consumeTestFindings(cacheManager, cwd);
				const injectedMessages = [
					...(sessionGuidance?.messages ?? []),
					...(turnEndFindings?.messages ?? []),
					...(testFindings?.messages ?? []),
				];
				if (injectedMessages.length === 0) return;

				const existingMessages =
					(event as { messages?: Array<{ role: string; content: unknown }> })
						?.messages ?? [];

				return {
					messages: [...injectedMessages, ...existingMessages],
				};
			} catch (err) {
				utils.dbg(`context event error: ${err}`);
			}
		},
	);
}
