/**
 * #3248 — the turn-end delivery seams that rendered structured findings with no
 * disposition stage at all.
 *
 * #3088 wired `lens_diagnostics`, #1617/#1625 the cached security lanes, #3102
 * the late-auxiliary and cascade pushes, #3246 the pre-rendered inline blocker.
 * What was left: five surfaces that NAME an individual finding — knip's blocker
 * and advisory, the dead-code advisory, the call-graph impact advisory, and the
 * late-runner drain — each re-reporting a finding the agent had already marked
 * `false-positive` through `lens_diagnostic_mark`.
 *
 * Every case drives the REAL `handleTurnEnd`, the REAL `RuntimeCoordinator` and
 * `CacheManager`, and the REAL durable disposition store on disk, then reads
 * what the agent would be shown through `consumeTurnEndFindings`. The marks use
 * the identity each lane's OWN `clients/project-diagnostics/runner-adapters/*`
 * adapter derives — the spelling `lens_diagnostics` surfaces and
 * `lens_diagnostic_mark` anchors against — never a second, cloned identity.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import type { ActionableWarningRecord } from "../../clients/actionable-warnings.js";
import type { FunctionCallGraph } from "../../clients/call-graph.js";
import {
	_resetStateCacheForTests,
	markDisposition,
} from "../../clients/diagnostic-dispositions.js";
import {
	deferRunnerFindings,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const lspFixture = vi.hoisted(() => ({
	service: undefined as unknown,
}));
vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/capabilities.js")>();
	return {
		...actual,
		getLSPService: () => lspFixture.service ?? actual.getLSPService(),
	};
});

const SESSION_ID = "turn-end-disposition-seams-session";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: cwd,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
		// biome-ignore lint/suspicious/noExplicitAny: the dep surface is a dozen
		// client interfaces; these tests state only what they exercise.
	} as any;
}

function registerEdit(
	cacheManager: CacheManager,
	cwd: string,
	filePath: string,
): void {
	cacheManager.addModifiedRange(
		filePath,
		{ start: 1, end: 1 },
		false,
		cwd,
		SESSION_ID,
	);
}

function turnEndText(
	cacheManager: CacheManager,
	cwd: string,
	runtime: RuntimeCoordinator,
): string {
	return (
		consumeTurnEndFindings(cacheManager, cwd, runtime)?.messages?.[0]
			?.content ?? ""
	);
}

function latencyRow(phase: string): Record<string, unknown> | undefined {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.find((entry) => entry?.phase === phase)?.metadata;
}

/** Mark through the real durable store with a lane adapter's own identity. */
function markFalsePositive(
	cwd: string,
	target: {
		filePath: string;
		/** Omitted for the spelling a mark made from the RENDERED text carries:
		 * none of these surfaces prints a tool, and `lens_diagnostic_mark`'s
		 * `tool` parameter is optional. */
		tool?: string;
		rule?: string;
		message: string;
		line?: number;
	},
): void {
	let content = "";
	try {
		content = fs.readFileSync(target.filePath, "utf8");
	} catch {
		content = "";
	}
	markDisposition(cwd, { cwd, ...target, content }, "false-positive");
}

afterEach(() => {
	lspFixture.service = undefined;
	cancelLSPIdleReset();
	resetPendingRunnerFindings();
	_resetStateCacheForTests();
	logLatency.mockClear();
	vi.useRealTimers();
});

describe("knip turn-end seams honor dispositions (#3248)", () => {
	/**
	 * knip's turn-end injection is the DELTA against the previous scan, scoped
	 * to files this turn edited — so the fixture needs a previous cache, a new
	 * issue, and that file registered as edited.
	 */
	function knipScenario(issues: unknown[]) {
		return {
			knipClient: {
				ensureAvailable: async () => true,
				analyze: async () => ({
					...EMPTY_KNIP_RESULT,
					success: true,
					issues,
					summary: "ok",
				}),
			},
		};
	}

	it("drops a marked unlisted dependency from the 🔴 knip blocker", async () => {
		const env = setupTestEnvironment("pi-lens-3248-knip-blocker-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "import x from 'missing-dep';\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			// A previous scan with no issues: everything this run finds is new.
			cacheManager.writeCache("knip", { ...EMPTY_KNIP_RESULT }, cwd);
			const issues = [
				{ type: "unlisted", file: filePath, name: "missing-dep", line: 1 },
				{ type: "unlisted", file: filePath, name: "other-dep", line: 1 },
			];
			registerEdit(cacheManager, cwd, filePath);

			// The identity `knipIssuesToProjectDiagnostics` derives, which is what
			// `lens_diagnostics` shows and a mark anchors against.
			markFalsePositive(cwd, {
				filePath,
				tool: "knip",
				rule: "knip:unlisted",
				message: "Unlisted dependency missing-dep",
				line: 1,
			});

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, cwd, knipScenario(issues)),
			);

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("other-dep");
			expect(text).not.toContain("missing-dep");
			expect(latencyRow("knip")).toMatchObject({ dispositionSuppressed: 1 });
		} finally {
			env.cleanup();
		}
	});

	it("emits no knip blocker section when every new issue is marked", async () => {
		const env = setupTestEnvironment("pi-lens-3248-knip-all-marked-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "src", "only.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "import x from 'missing-dep';\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			cacheManager.writeCache("knip", { ...EMPTY_KNIP_RESULT }, cwd);
			registerEdit(cacheManager, cwd, filePath);
			markFalsePositive(cwd, {
				filePath,
				tool: "knip",
				rule: "knip:unlisted",
				message: "Unlisted dependency missing-dep",
				line: 1,
			});

			await handleTurnEnd(
				makeTurnEndDeps(
					runtime,
					cacheManager,
					cwd,
					knipScenario([
						{ type: "unlisted", file: filePath, name: "missing-dep", line: 1 },
					]),
				),
			);

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).not.toContain("New unresolved imports/deps");
			expect(text).not.toContain("missing-dep");
		} finally {
			env.cleanup();
		}
	});

	it("honors a mark that names no tool, the spelling the rendered line carries", async () => {
		// The knip blocker renders `<file>:<line> — <type>: <name>` and names no
		// tool, so a mark made from THAT text carries none. #3088's
		// non-convergence shape: honouring only the canonical spelling leaves the
		// surface unfixable from its own output.
		const env = setupTestEnvironment("pi-lens-3248-knip-bare-identity-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "src", "bare.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "import x from 'missing-dep';\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			cacheManager.writeCache("knip", { ...EMPTY_KNIP_RESULT }, cwd);
			registerEdit(cacheManager, cwd, filePath);
			markFalsePositive(cwd, {
				filePath,
				rule: "knip:unlisted",
				message: "Unlisted dependency missing-dep",
				line: 1,
			});

			await handleTurnEnd(
				makeTurnEndDeps(
					runtime,
					cacheManager,
					cwd,
					knipScenario([
						{ type: "unlisted", file: filePath, name: "missing-dep", line: 1 },
						{ type: "unlisted", file: filePath, name: "other-dep", line: 1 },
					]),
				),
			);

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("other-dep");
			expect(text).not.toContain("missing-dep");
		} finally {
			env.cleanup();
		}
	});

	it("drops a marked unused export from the knip advisory", async () => {
		const env = setupTestEnvironment("pi-lens-3248-knip-advisory-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "src", "exports.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const a = 1;\nexport const b = 2;\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			cacheManager.writeCache("knip", { ...EMPTY_KNIP_RESULT }, cwd);
			registerEdit(cacheManager, cwd, filePath);
			markFalsePositive(cwd, {
				filePath,
				tool: "knip",
				rule: "knip:export",
				message: "Unused export deadExport",
				line: 1,
			});

			await handleTurnEnd(
				makeTurnEndDeps(
					runtime,
					cacheManager,
					cwd,
					knipScenario([
						{ type: "export", file: filePath, name: "deadExport", line: 1 },
						{ type: "export", file: filePath, name: "liveExport", line: 2 },
					]),
				),
			);

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("liveExport");
			expect(text).not.toContain("deadExport");
		} finally {
			env.cleanup();
		}
	});
});

describe("dead-code turn-end advisory honors dispositions (#3248)", () => {
	function deadCodeClient(issues: Record<string, unknown>[]) {
		return {
			id: "vulture",
			language: "python",
			detect: () => true,
			owns: () => true,
			ensureAvailable: async () => true,
			analyze: async () => ({
				success: true,
				language: "python",
				unusedExports: issues,
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "ok",
			}),
		};
	}

	it("drops a marked dead-code finding and keeps the unmarked one", async () => {
		const env = setupTestEnvironment("pi-lens-3248-dead-code-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.py");
			fs.writeFileSync(
				filePath,
				"def marked():\n    pass\ndef live():\n    pass\n",
			);

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			// A previous successful scan with no issues is the baseline the delta
			// is computed against; without it the lane reports nothing at all.
			cacheManager.writeCache(
				"dead-code-vulture",
				{
					success: true,
					language: "python",
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: "ok",
				},
				cwd,
			);
			registerEdit(cacheManager, cwd, filePath);
			markFalsePositive(cwd, {
				filePath,
				tool: "dead-code",
				rule: "dead-code:export",
				message: "Unused function marked",
				line: 1,
			});

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, cwd, {
					deadCodeClients: [
						deadCodeClient([
							{
								category: "export",
								kind: "function",
								name: "marked",
								file: filePath,
								line: 1,
							},
							{
								category: "export",
								kind: "function",
								name: "live",
								file: filePath,
								line: 3,
							},
						]),
					],
				}),
			);

			const text = turnEndText(cacheManager, cwd, runtime);
			// The RENDERED form (`formatDeadCodeDelta`: `unused <kind> <name>`),
			// not the adapter's message — asserting the adapter's wording here
			// would pass against text that never contains it.
			expect(text).toContain("unused function live");
			expect(text).not.toContain("unused function marked");
			expect(latencyRow("dead-code")).toMatchObject({
				dispositionSuppressed: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("honors a mark that names no tool on the dead-code advisory", async () => {
		// `formatDeadCodeDelta` renders `unused <kind> <name>` and names no tool.
		const env = setupTestEnvironment("pi-lens-3248-dead-code-bare-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "bare.py");
			fs.writeFileSync(
				filePath,
				"def marked():\n    pass\ndef live():\n    pass\n",
			);

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			cacheManager.writeCache(
				"dead-code-vulture",
				{
					success: true,
					language: "python",
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: "ok",
				},
				cwd,
			);
			registerEdit(cacheManager, cwd, filePath);
			markFalsePositive(cwd, {
				filePath,
				rule: "dead-code:export",
				message: "Unused function marked",
				line: 1,
			});

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, cwd, {
					deadCodeClients: [
						deadCodeClient([
							{
								category: "export",
								kind: "function",
								name: "marked",
								file: filePath,
								line: 1,
							},
							{
								category: "export",
								kind: "function",
								name: "live",
								file: filePath,
								line: 3,
							},
						]),
					],
				}),
			);

			const text = turnEndText(cacheManager, cwd, runtime);
			// The RENDERED form (`formatDeadCodeDelta`: `unused <kind> <name>`),
			// not the adapter's message — asserting the adapter's wording here
			// would pass against text that never contains it.
			expect(text).toContain("unused function live");
			expect(text).not.toContain("unused function marked");
		} finally {
			env.cleanup();
		}
	});

	it("emits no dead-code advisory at all when every new finding is marked", async () => {
		// A PUSH surface stays silent after a mark rather than rendering an empty
		// advisory header; the count rides this lane's bounded per-turn row.
		const env = setupTestEnvironment("pi-lens-3248-dead-code-silent-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "only.py");
			fs.writeFileSync(filePath, "def marked():\n    pass\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			cacheManager.writeCache(
				"dead-code-vulture",
				{
					success: true,
					language: "python",
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: "ok",
				},
				cwd,
			);
			registerEdit(cacheManager, cwd, filePath);
			markFalsePositive(cwd, {
				filePath,
				tool: "dead-code",
				rule: "dead-code:export",
				message: "Unused function marked",
				line: 1,
			});

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, cwd, {
					deadCodeClients: [
						deadCodeClient([
							{
								category: "export",
								kind: "function",
								name: "marked",
								file: filePath,
								line: 1,
							},
						]),
					],
				}),
			);

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).not.toContain("Newly unused");
			expect(text).not.toContain("Advisory");
			expect(latencyRow("dead-code")).toMatchObject({
				dispositionSuppressed: 1,
			});
		} finally {
			env.cleanup();
		}
	});
});

describe("actionable-warnings turn-end advisory honors dispositions (#3248)", () => {
	function warning(
		filePath: string,
		line: number,
		message: string,
	): ActionableWarningRecord {
		return {
			id: `aw:${line}`,
			filePath,
			displayPath: path.basename(filePath),
			line,
			severity: "warning",
			tool: "ast-grep",
			rule: "no-console",
			message,
			actions: [],
			suppressed: false,
			origin: "dispatch",
		};
	}

	it("filters the built report and keeps its cache raw (#3248)", async () => {
		const env = setupTestEnvironment("pi-lens-3248-actionable-built-");
		try {
			const { tmpDir: cwd } = env;
			const filePath = path.join(cwd, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				filePath,
				"console.log(1);\nconsole.log(2);\nconsole.log(3);\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, filePath);
			runtime.recordActionableWarnings([
				warning(filePath, 1, "marked warning"),
				warning(filePath, 2, "live warning"),
				warning(filePath, 3, "third warning"),
			]);
			markFalsePositive(cwd, {
				filePath,
				tool: "ast-grep",
				rule: "no-console",
				message: "marked warning",
				line: 1,
			});

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, cwd, {
					getFlag: (name: string) => name === "lens-actionable-warnings",
				}),
			);

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("Fixable warnings introduced this turn: 2");
			expect(text).toContain("suppressed by disposition: 1 finding(s).");
			expect(text).not.toContain("Fixable warnings introduced this turn: 3");
			const cached = cacheManager.readCache<any>(
				"actionable-warnings",
				cwd,
			)?.data;
			expect(cached.summary.unsuppressed).toBe(3);
			expect(cached.files[0].warnings).toHaveLength(3);
		} finally {
			env.cleanup();
		}
	});

	it("does not repeat an ast-grep secret at a delivered blocker location (#3270)", async () => {
		const env = setupTestEnvironment("pi-lens-3270-actionable-location-");
		try {
			const { tmpDir: cwd } = env;
			const filePath = path.join(cwd, "src", "secret.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				filePath,
				"const token = 'AKIA...';\nconst other = 'secret';\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, filePath);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: "",
					findings: [
						{
							ruleId: "aws-access-token",
							file: filePath,
							startLine: 1,
							description: "AWS key",
						},
					],
				},
				cwd,
			);
			runtime.recordActionableWarnings([
				{
					...warning(filePath, 1, "hardcoded secret"),
					rule: "no-hardcoded-secret-js",
				},
				{
					...warning(filePath, 2, "other secret"),
					rule: "no-hardcoded-secret-js",
				},
			]);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, cwd, {
					getFlag: (name: string) => name === "lens-actionable-warnings",
				}),
			);
			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("Fixable warnings introduced this turn: 1");
			expect(text).toContain("secret.ts: 1");
		} finally {
			env.cleanup();
		}
	});

	it("filters a marked warning added by the real LSP builder seam (#3248)", async () => {
		// Prevents the round-1 bypass: an input-only filter or an `origin=lsp`
		// escape hatch must not let a disposition-marked builder-added row reach
		// the advisory while the raw published report keeps it.
		const env = setupTestEnvironment("pi-lens-3248-actionable-lsp-built-");
		try {
			const { tmpDir: cwd } = env;
			const filePath = path.join(cwd, "src", "lsp.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "const marked = 1;\nconst live = 2;\n");
			const lspDiagnostic = {
				severity: 2,
				message: "LSP marked warning",
				code: 6133,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
				source: "ts",
			};
			lspFixture.service = makeLspServiceDouble({
				supportsLSP: () => true,
				getLastKnownDiagnostics: () => [lspDiagnostic],
				codeAction: async () => [{ title: "Remove warning", kind: "quickfix" }],
			});
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, filePath);
			runtime.recordActionableWarnings([
				warning(filePath, 2, "dispatch live warning"),
			]);
			markFalsePositive(cwd, {
				filePath,
				tool: "ts",
				rule: "ts:6133",
				message: "LSP marked warning",
				line: 1,
			});

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, cwd, {
					getFlag: (name: string) =>
						name === "lens-actionable-warnings" ||
						name === "lens-actionable-warning-actions",
				}),
			);

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("Fixable warnings introduced this turn: 1");
			expect(text).not.toContain("LSP marked warning");
			const cached = cacheManager.readCache<any>(
				"actionable-warnings",
				cwd,
			)?.data;
			expect(cached.summary.unsuppressed).toBe(2);
			expect(cached.files[0].warnings).toHaveLength(2);
		} finally {
			env.cleanup();
		}
	});
});

describe("call-graph impact advisory honors dispositions (#3248)", () => {
	function graphWith(callee: string, callers: string[]): FunctionCallGraph {
		return {
			callees: new Map(),
			callers: new Map([[callee, new Set(callers)]]),
			edges: callers.map((callerKey) => ({
				callerKey,
				calleeKey: callee,
				weight: 1,
				evidenceCount: 1,
				// biome-ignore lint/suspicious/noExplicitAny: edge carries more
				// fields than this lane reads.
			})) as any,
			inDegree: new Map(),
			unresolvedRefs: 0,
			totalRefs: callers.length,
			coverage: {
				complete: true,
				// biome-ignore lint/suspicious/noExplicitAny: coverage carries more
				// fields than this lane reads.
			} as any,
			builtAt: new Date().toISOString(),
		};
	}

	it("drops a marked caller from the impact line and keeps the unmarked one", async () => {
		const env = setupTestEnvironment("pi-lens-3248-call-graph-");
		try {
			const cwd = env.tmpDir;
			const edited = path.join(cwd, "src", "core.ts");
			const markedCaller = path.join(cwd, "src", "marked.ts");
			const liveCaller = path.join(cwd, "src", "live.ts");
			fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
			for (const f of [edited, markedCaller, liveCaller]) {
				fs.writeFileSync(f, "export const x = 1;\n");
			}

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			runtime.callGraph = graphWith(`${edited}:doThing`, [
				`${markedCaller}:markedCaller`,
				`${liveCaller}:liveCaller`,
			]);
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, edited);
			markFalsePositive(cwd, {
				filePath: markedCaller,
				tool: "call-graph",
				rule: "call-graph:willbreak",
				message:
					"Direct caller of a symbol edited this turn — verify this call site still matches its new signature/behavior. (markedCaller calls edited symbol 'doThing')",
			});

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("liveCaller");
			expect(text).not.toContain("markedCaller");
			expect(latencyRow("call_graph_impact")).toMatchObject({
				dispositionSuppressed: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("honors a mark that names no tool on the impact line", async () => {
		// The impact line renders `<symbol>: <caller> (<file>) ⚠ WillBreak` and
		// names no tool.
		const env = setupTestEnvironment("pi-lens-3248-call-graph-bare-");
		try {
			const cwd = env.tmpDir;
			const edited = path.join(cwd, "src", "core.ts");
			const markedCaller = path.join(cwd, "src", "marked.ts");
			const liveCaller = path.join(cwd, "src", "live.ts");
			fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
			for (const f of [edited, markedCaller, liveCaller]) {
				fs.writeFileSync(f, "export const x = 1;\n");
			}

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			runtime.callGraph = graphWith(`${edited}:doThing`, [
				`${markedCaller}:markedCaller`,
				`${liveCaller}:liveCaller`,
			]);
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, edited);
			markFalsePositive(cwd, {
				filePath: markedCaller,
				rule: "call-graph:willbreak",
				message:
					"Direct caller of a symbol edited this turn — verify this call site still matches its new signature/behavior. (markedCaller calls edited symbol 'doThing')",
			});

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("liveCaller");
			expect(text).not.toContain("markedCaller");
		} finally {
			env.cleanup();
		}
	});

	it("keeps a caller its own adapter cannot map, which is therefore unmarkable", async () => {
		// The adapter drops a caller with no attributable file (and the Review
		// tier) — such a caller can never carry a disposition anchor, so nothing
		// may suppress it. Fail-open: it stays on the line even when its
		// sibling's mark removes that sibling.
		const env = setupTestEnvironment("pi-lens-3248-call-graph-unmappable-");
		try {
			const cwd = env.tmpDir;
			const edited = path.join(cwd, "src", "core.ts");
			const markedCaller = path.join(cwd, "src", "marked.ts");
			fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
			for (const f of [edited, markedCaller]) {
				fs.writeFileSync(f, "export const x = 1;\n");
			}

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			runtime.callGraph = graphWith(`${edited}:doThing`, [
				`${markedCaller}:markedCaller`,
				"bareCaller",
			]);
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, edited);
			markFalsePositive(cwd, {
				filePath: markedCaller,
				tool: "call-graph",
				rule: "call-graph:willbreak",
				message:
					"Direct caller of a symbol edited this turn — verify this call site still matches its new signature/behavior. (markedCaller calls edited symbol 'doThing')",
			});

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("bareCaller");
			expect(text).not.toContain("markedCaller");
		} finally {
			env.cleanup();
		}
	});
});

describe("late-runner drain honors dispositions (#3248)", () => {
	it("drops a marked late finding and keeps the unmarked one", async () => {
		const env = setupTestEnvironment("pi-lens-3248-late-runner-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "late.ts");
			fs.writeFileSync(filePath, "const marked = 1;\nconst live = 2;\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, filePath);
			const diagnostic = (line: number, rule: string, message: string) => ({
				id: `late-${line}`,
				message,
				filePath,
				line,
				column: 1,
				severity: "warning" as const,
				semantic: "warning" as const,
				tool: "eslint",
				rule,
			});
			deferRunnerFindings({
				filePath,
				cwd,
				projectRoot: cwd,
				runnerId: "eslint",
				markedAtMs: Date.now(),
				promise: Promise.resolve({
					status: "ok",
					diagnostics: [
						diagnostic(1, "no-unused-vars", "marked finding"),
						diagnostic(2, "no-unused-vars", "live finding"),
					],
					// biome-ignore lint/suspicious/noExplicitAny: the runner result
					// carries more fields than this lane reads.
				}) as any,
			});
			// The rendered line prints the RULE and no tool, so this mark uses the
			// rule-only spelling `renderedRuleIdentities` expands — the same
			// expansion the late-auxiliary twin applies.
			markFalsePositive(cwd, {
				filePath,
				tool: "eslint",
				rule: "no-unused-vars",
				message: "marked finding",
				line: 1,
			});

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("live finding");
			expect(text).not.toContain("marked finding");
			expect(text).toContain("suppressed by disposition: 1 finding(s)");
			// #1616: the note states what this delivery dropped. A delivery that
			// dropped nothing must not carry a zero — see the sibling case below.
			expect(latencyRow("late_runner_findings")).toMatchObject({
				dispositionSuppressed: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("honors a mark that names no tool on the late-runner line", async () => {
		// The line renders `<file>:<line>:<col> [<rule>] <message>` — the rule,
		// never the tool. `renderedRuleIdentities` expands both spellings.
		const env = setupTestEnvironment("pi-lens-3248-late-runner-bare-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "late.ts");
			fs.writeFileSync(filePath, "const marked = 1;\nconst live = 2;\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, filePath);
			deferRunnerFindings({
				filePath,
				cwd,
				projectRoot: cwd,
				runnerId: "eslint",
				markedAtMs: Date.now(),
				promise: Promise.resolve({
					status: "ok",
					diagnostics: [1, 2].map((line) => ({
						id: `late-${line}`,
						message: line === 1 ? "marked finding" : "live finding",
						filePath,
						line,
						column: 1,
						severity: "warning",
						semantic: "warning",
						tool: "eslint",
						rule: "no-unused-vars",
					})),
					// biome-ignore lint/suspicious/noExplicitAny: partial result.
				}) as any,
			});
			markFalsePositive(cwd, {
				filePath,
				rule: "no-unused-vars",
				message: "marked finding",
				line: 1,
			});

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("live finding");
			expect(text).not.toContain("marked finding");
		} finally {
			env.cleanup();
		}
	});

	it("carries no suppressed-by-disposition note when nothing was marked", async () => {
		// #1616's rule is "a delivery that still has something to say states what
		// it dropped" — not "every delivery states a zero".
		const env = setupTestEnvironment("pi-lens-3248-late-runner-no-note-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "late.ts");
			fs.writeFileSync(filePath, "const live = 1;\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, filePath);
			deferRunnerFindings({
				filePath,
				cwd,
				projectRoot: cwd,
				runnerId: "eslint",
				markedAtMs: Date.now(),
				promise: Promise.resolve({
					status: "ok",
					diagnostics: [
						{
							id: "late-1",
							message: "live finding",
							filePath,
							line: 1,
							column: 1,
							severity: "warning",
							semantic: "warning",
							tool: "eslint",
							rule: "no-unused-vars",
						},
					],
					// biome-ignore lint/suspicious/noExplicitAny: partial result.
				}) as any,
			});

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("live finding");
			expect(text).not.toContain("suppressed by disposition");
			expect(latencyRow("late_runner_findings")).toMatchObject({
				dispositionSuppressed: 0,
				delivered: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("emits no late-runner advisory at all when every finding is marked", async () => {
		const env = setupTestEnvironment("pi-lens-3248-late-runner-silent-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "late.ts");
			fs.writeFileSync(filePath, "const marked = 1;\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, filePath);
			deferRunnerFindings({
				filePath,
				cwd,
				projectRoot: cwd,
				runnerId: "eslint",
				markedAtMs: Date.now(),
				promise: Promise.resolve({
					status: "ok",
					diagnostics: [
						{
							id: "late-1",
							message: "marked finding",
							filePath,
							line: 1,
							column: 1,
							severity: "warning",
							semantic: "warning",
							tool: "eslint",
							rule: "no-unused-vars",
						},
					],
					// biome-ignore lint/suspicious/noExplicitAny: partial result.
				}) as any,
			});
			markFalsePositive(cwd, {
				filePath,
				tool: "eslint",
				rule: "no-unused-vars",
				message: "marked finding",
				line: 1,
			});

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).not.toContain("Late runner diagnostics");
			expect(text).not.toContain("marked finding");
			expect(latencyRow("late_runner_findings")).toMatchObject({
				dispositionSuppressed: 1,
				delivered: 0,
			});
		} finally {
			env.cleanup();
		}
	});
});

describe("code-quality warnings advisory honors dispositions (#3248)", () => {
	it("drops a marked warning from the advisory count AND from the cache mode=delta re-serves", async () => {
		// The cross-surface case: `lens_diagnostics mode=delta` re-applies
		// dispositions when it re-serves this very cache
		// (`tools/lens-diagnostics.ts`'s `visibleWarningFiles`), so before this
		// the turn-end advisory counted warnings the delta view had already
		// dropped. Filtering at the report INPUT makes the advisory, the
		// persisted record and the delta view agree on one set.
		const env = setupTestEnvironment("pi-lens-3248-code-quality-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "quality.ts");
			fs.writeFileSync(filePath, "const marked = 1;\nconst live = 2;\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, filePath);
			runtime.recordCodeQualityWarnings([
				{
					id: "cq-1",
					filePath,
					displayPath: "quality.ts",
					line: 1,
					column: 1,
					severity: "warning",
					tool: "ast-grep",
					rule: "no-magic-number",
					message: "marked quality warning",
					category: "maintainability",
					origin: "dispatch",
				},
				{
					id: "cq-2",
					filePath,
					displayPath: "quality.ts",
					line: 2,
					column: 1,
					severity: "warning",
					tool: "ast-grep",
					rule: "no-magic-number",
					message: "live quality warning",
					category: "maintainability",
					origin: "dispatch",
				},
			]);
			markFalsePositive(cwd, {
				filePath,
				tool: "ast-grep",
				rule: "no-magic-number",
				message: "marked quality warning",
				line: 1,
			});

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain(
				"Code-quality warnings introduced/touched this turn: 1",
			);
			const persisted = cacheManager.readCache<{
				files?: Array<{ warnings?: Array<{ message: string }> }>;
			}>("code-quality-warnings", cwd);
			const messages = (persisted?.data?.files ?? []).flatMap((file) =>
				(file.warnings ?? []).map((w) => w.message),
			);
			expect(messages).toContain("live quality warning");
			expect(messages).not.toContain("marked quality warning");
			expect(latencyRow("code_quality_warnings_report")).toMatchObject({
				dispositionSuppressed: 1,
			});
		} finally {
			env.cleanup();
		}
	});
});
