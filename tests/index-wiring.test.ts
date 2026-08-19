import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../clients/cache-manager.js";
import { snapshotAdvisoryProvenance } from "../clients/advisory-provenance.js";
import { getLatencyLogPath } from "../clients/latency-logger.js";
import { LENS_FLAGS } from "../clients/lens-flag-registry.js";
import extension from "../index.js";
import {
	_resetForTests as resetBusPublishForTests,
	publishFilesTouched,
	wireBusEmitter,
} from "../clients/bus-publish.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

// #643: the dynamic-tool-deactivation call now runs inside the session_start
// handler rather than synchronously at registration time (see index.ts), so
// the tests below that need to observe it must actually fire session_start.
// Mock out the two heavy real-work seams the same way
// tests/index-integration.test.ts does, so firing session_start here stays a
// fast, deterministic wiring check rather than a real scan/LSP-bootstrap.
vi.mock("../clients/bootstrap.js", () => ({
	loadBootstrapClients: async () => ({
		metricsClient: { reset: () => {} },
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: {
			recordToolCall: () => {},
			formatWarnings: () => "",
		},
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: () => null,
		},
	}),
}));
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async () => {},
}));

// The contract index.ts wires into the host. If a registration is dropped or
// renamed, this catches it — the kind of glue that was previously untested
// (#171) and that the dist-packaging breakage showed we need to guard.
// Flags are DERIVED from the registry rather than restated (#166): the old
// hand-written list had already drifted (it was missing `lens-turn-summary`),
// which is the same drift class the registry exists to make impossible.
const EXPECTED_FLAGS = LENS_FLAGS.map((spec) => spec.name);
const EXPECTED_COMMANDS = [
	"lens-toggle",
	"lens-context-toggle",
	"lens-widget-toggle",
	"lens-tdi",
	"lens-map",
	"lens-health",
	"lens-perf",
	"lens-tools",
	"lens-allow-edit",
];
const EXPECTED_TOOLS = [
	"ast_grep_search",
	"ast_grep_replace",
	"ast_grep_outline",
	"ast_grep_dump",
	"pi_lens_activate_tools",
	"lens_diagnostics",
	"lsp_diagnostics",
	"lsp_navigation",
	"lens_diagnostic_mark",
	"symbol_search",
	"project_report",
	"module_report",
	"read_symbol",
	"read_enclosing",
];
const EXPECTED_HOOKS = [
	"resources_discover",
	"session_start",
	"session_before_fork",
	"tool_call",
	"tool_result",
	"turn_start",
	"agent_end",
	"turn_end",
	"context",
];

describe("index.ts extension wiring", () => {
	it("re-wires a recovered bus on a #473-guarded subagent session_start (#1383)", async () => {
		_resetSessionLifecycleForTests();
		resetBusPublishForTests();
		resetDegradationLedger();
		try {
			const parent = createPiMock();
			const parentApi = parent.asExtensionAPI();
			(
				parentApi as unknown as { events: { emit: ReturnType<typeof vi.fn> } }
			).events = {
				emit: vi.fn(),
			};
			extension(parentApi);
			await parent.emit(
				"session_start",
				{ reason: "startup" },
				makeCtx({ cwd: process.cwd(), sessionId: "parent" }),
			);

			const dbg = vi.fn();
			wireBusEmitter(() => {
				throw new Error(
					"This extension ctx is stale after session replacement or reload",
				);
			});
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/stale.ts"],
				cwd: "/repo",
				dbg,
			});
			expect(dbg).toHaveBeenCalledTimes(1);
			expect(getDegradationSummary()).toEqual([
				expect.objectContaining({ kind: "bus-stale", count: 1 }),
			]);

			const recoveredEmit = vi.fn();
			const subagent = createPiMock();
			const subagentApi = subagent.asExtensionAPI();
			(
				subagentApi as unknown as { events: { emit: typeof recoveredEmit } }
			).events = {
				emit: recoveredEmit,
			};
			extension(subagentApi);
			// Model another activation winning the module singleton after factory
			// load. The guarded session_start itself must reclaim the wiring.
			wireBusEmitter(() => {
				throw new Error(
					"This extension ctx is stale after session replacement or reload",
				);
			});
			await subagent.emit(
				"session_start",
				{ reason: "startup" },
				makeCtx({ cwd: process.cwd(), sessionId: "subagent" }),
			);
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/recovered.ts"],
				cwd: "/repo",
				dbg,
			});

			expect(recoveredEmit).toHaveBeenCalledWith(
				"pilens:files:touched",
				expect.objectContaining({
					paths: [expect.stringContaining("recovered.ts")],
				}),
			);
			expect(dbg).toHaveBeenCalledTimes(1);
		} finally {
			_resetSessionLifecycleForTests();
			resetBusPublishForTests();
			resetDegradationLedger();
		}
	});

	it("probes the ctx owned by the activation whose emitter is selected", async () => {
		_resetSessionLifecycleForTests();
		resetBusPublishForTests();
		try {
			const liveCtx = makeCtx({ cwd: process.cwd(), sessionId: "live-owner" });
			const staleCtx = makeCtx({ cwd: process.cwd(), sessionId: "stale-sibling" });
			staleCtx.isIdle = () => {
				throw new Error("This extension ctx is stale after session replacement");
			};

			const ownerEmit = vi.fn();
			const owner = createPiMock();
			const ownerApi = owner.asExtensionAPI();
			(ownerApi as unknown as { events: { emit: typeof ownerEmit } }).events = {
				emit: ownerEmit,
			};
			extension(ownerApi);
			await owner.emit("session_start", { reason: "startup" }, liveCtx);

			const sibling = createPiMock();
			extension(sibling.asExtensionAPI());
			// Reclaim the process-global publisher for the owner, then let a stale
			// sibling handler overwrite only the process-global fallback ctx.
			await owner.emit("session_start", { reason: "resume" }, liveCtx);
			await sibling.emit("turn_start", {}, staleCtx);
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/live-owner.ts"],
				cwd: "/repo",
			});

			expect(
				ownerEmit.mock.calls.filter(([event]) => event === "pilens:files:touched"),
			).toHaveLength(1);
		} finally {
			_resetSessionLifecycleForTests();
			resetBusPublishForTests();
		}
	});

	it("skips a stale owning ctx even when the global fallback is fresh", async () => {
		_resetSessionLifecycleForTests();
		resetBusPublishForTests();
		try {
			const staleOwnerCtx = makeCtx({
				cwd: process.cwd(),
				sessionId: "stale-owner",
			});
			staleOwnerCtx.isIdle = () => {
				throw new Error("This extension ctx is stale after session replacement");
			};
			const freshGlobalCtx = makeCtx({
				cwd: process.cwd(),
				sessionId: "fresh-sibling",
			});
			const ownerEmit = vi.fn();
			const owner = createPiMock();
			const ownerApi = owner.asExtensionAPI();
			(ownerApi as unknown as { events: { emit: typeof ownerEmit } }).events = {
				emit: ownerEmit,
			};
			extension(ownerApi);
			await owner.emit("session_start", { reason: "startup" }, staleOwnerCtx);

			const sibling = createPiMock();
			extension(sibling.asExtensionAPI());
			await owner.emit("session_start", { reason: "resume" }, staleOwnerCtx);
			await sibling.emit("turn_start", {}, freshGlobalCtx);
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/stale-owner.ts"],
				cwd: "/repo",
			});

			expect(
				ownerEmit.mock.calls.filter(([event]) => event === "pilens:files:touched"),
			).toHaveLength(0);
		} finally {
			_resetSessionLifecycleForTests();
			resetBusPublishForTests();
		}
	});

	it("delivers through its own boot window without borrowing a stale sibling's ctx (H2, #1415)", async () => {
		// Pins the boot-window behavior directly, replacing a test that
		// asserted delivery via `ownEventCtx ?? latestEventCtx` -- the
		// reviewer proved that assertion vacuous, since it passes exactly
		// the same way with the fallback arm removed (an unset ownEventCtx
		// probes as inconclusive and falls through to "ready" either way).
		//
		// This version proves the fallback's ABSENCE actually matters: a
		// sibling activation ("A") sets the process-global latest-ctx to a
		// CONFIRMED-STALE ctx. Under the old `?? latestEventCtx` fallback, a
		// fresh boot activation ("B") with no ctx of its own would have
		// paired its live emitter with A's stale ctx and been silently
		// DROPPED (stale-session). With the fallback removed, B's own unset
		// `ownEventCtx` correctly probes as undefined (inconclusive) rather
		// than confirmed-stale, so delivery is still attempted.
		_resetSessionLifecycleForTests();
		resetBusPublishForTests();
		try {
			const staleSiblingCtx = makeCtx({
				cwd: process.cwd(),
				sessionId: "stale-sibling",
			});
			staleSiblingCtx.isIdle = () => {
				throw new Error("This extension ctx is stale after session replacement");
			};
			const sibling = createPiMock();
			extension(sibling.asExtensionAPI());
			// Sets the process-global `latestEventCtx` to a confirmed-stale ctx
			// belonging to a DIFFERENT activation than the one created below.
			await sibling.emit("turn_start", {}, staleSiblingCtx);

			const bootEmit = vi.fn();
			const boot = createPiMock();
			const bootApi = boot.asExtensionAPI();
			(bootApi as unknown as { events: { emit: typeof bootEmit } }).events = {
				emit: bootEmit,
			};
			extension(bootApi);
			// Boot activation never receives an event of its own -- its
			// `ownEventCtx` closure variable stays unset.
			publishFilesTouched({
				reason: "autofix",
				paths: ["/repo/boot.ts"],
				cwd: "/repo",
			});

			expect(
				bootEmit.mock.calls.filter(([event]) => event === "pilens:files:touched"),
			).toHaveLength(1);
		} finally {
			_resetSessionLifecycleForTests();
			resetBusPublishForTests();
		}
	});

	describe("registration", () => {
		it("registers every expected flag, command, tool, and lifecycle hook", () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());

			for (const f of EXPECTED_FLAGS) {
				expect(pi.flags.has(f), `flag: ${f}`).toBe(true);
			}
			for (const c of EXPECTED_COMMANDS) {
				expect(pi.getCommand(c), `command: ${c}`).toBeDefined();
			}
			for (const t of EXPECTED_TOOLS) {
				expect(pi.getTool(t), `tool: ${t}`).toBeDefined();
			}
			for (const h of EXPECTED_HOOKS) {
				expect(pi.getHandlers(h).length, `hook: ${h}`).toBeGreaterThan(0);
			}
		});

		// #166: EXACTLY the registry, in registry order, with each spec's own
		// description and default. A flag registered outside the registry (or a
		// registry entry that never reaches the host) is the drift this closes.
		it("registers exactly the flag registry, description and default included", () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());

			expect([...pi.flags.keys()]).toEqual(EXPECTED_FLAGS);
			for (const spec of LENS_FLAGS) {
				expect(pi.flags.get(spec.name), `flag: ${spec.name}`).toEqual({
					description: spec.description,
					type: "boolean",
					default: spec.default,
				});
			}
		});

		// #771: symbol_search's ergonomics additions (paths/lang filters) must
		// actually be registered on the tool's parameter schema, not just
		// present in the tool's implementation.
		it("registers symbol_search's paths/lang params (#771)", () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());

			const tool = pi.getTool("symbol_search") as
				| { parameters?: { properties?: Record<string, unknown> } }
				| undefined;
			expect(tool).toBeDefined();
			const properties = tool?.parameters?.properties ?? {};
			expect(properties).toHaveProperty("paths");
			expect(properties).toHaveProperty("lang");
			expect(properties).toHaveProperty("query");
			expect(properties).toHaveProperty("limit");
		});

		// #dynamic-tooling: 6 situational tools are registered but start
		// inactive on a host that supports pi's dynamic tool loading
		// (pi.getActiveTools/setActiveTools); the 6 always-active tools plus
		// the loader itself stay active. Newly-activated tools only need to
		// be visible from the NEXT turn, so this only asserts load-time state.
		// #643: the deactivation call moved from synchronous registration into
		// the session_start handler (the correct lifecycle point — see
		// index.ts), so this test now fires session_start before asserting.
		it("registers the 6 situational tools inactive and everything else active on a dynamic-tooling host", async () => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-wiring-session-start-"),
			);
			const prevDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(tmp, "data");
			try {
				const pi = createPiMock();
				extension(pi.asExtensionAPI());
				await pi.emit("session_start", {}, makeCtx({ cwd: tmp }));

				const LAZY_TOOLS = [
					"ast_grep_search",
					"ast_grep_replace",
					"ast_grep_outline",
					"ast_grep_dump",
					"lsp_navigation",
					"lens_diagnostic_mark",
				];
				const ALWAYS_ACTIVE = [
					"lens_diagnostics",
					"lsp_diagnostics",
					"symbol_search",
					"project_report",
					"module_report",
					"read_symbol",
					"read_enclosing",
					"pi_lens_activate_tools",
				];

				for (const t of LAZY_TOOLS) {
					expect(pi.getTool(t), `tool registered: ${t}`).toBeDefined();
					expect(pi.activeTools.has(t), `should start inactive: ${t}`).toBe(false);
				}
				for (const t of ALWAYS_ACTIVE) {
					expect(pi.getTool(t), `tool registered: ${t}`).toBeDefined();
					expect(pi.activeTools.has(t), `should start active: ${t}`).toBe(true);
				}
			} finally {
				if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = prevDataDir;
				removeTempDirSync(tmp);
			}
		});

		// Feature-detection fallback: a host without getActiveTools/setActiveTools
		// (older pi, or any host not implementing dynamic tooling) must not throw,
		// and every tool — including the 6 normally-lazy ones — stays statically
		// active, matching pi-lens's behavior before this feature existed.
		// #643: assert through session_start, the call's new (correct) home.
		it("falls back to all tools statically active on a host without dynamic-tooling support", async () => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-wiring-session-start-fallback-"),
			);
			const prevDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(tmp, "data");
			try {
				const pi = createPiMock({}, { supportsActiveTools: false });

				expect(() => extension(pi.asExtensionAPI())).not.toThrow();
				await pi.emit("session_start", {}, makeCtx({ cwd: tmp }));

				for (const t of EXPECTED_TOOLS) {
					expect(pi.getTool(t), `tool registered: ${t}`).toBeDefined();
					// Every tool — including the normally-lazy 6 — stays active because
					// index.ts never found getActiveTools/setActiveTools to call, so it
					// skipped the deactivation step entirely (the graceful fallback).
					expect(pi.activeTools.has(t), `should stay active: ${t}`).toBe(true);
				}
			} finally {
				if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = prevDataDir;
				removeTempDirSync(tmp);
			}
		});

		// #1453: fork/reload/resume are session REBUILDS. The host constructs a
		// fresh AgentSession with every registered extension tool active
		// (`simulateSessionRebuild`) before emitting the event, so pi-lens must
		// RESTORE the parent's posture — the always-active baseline plus exactly
		// the lazy tools the model activated. Skipping the mutation would leave
		// all six lazy tools active; a plain baseline shrink would drop the
		// model's activation. These assertions catch both.
		it.each(["fork", "reload", "resume"])(
			"restores the parent's tool posture on %s session_start",
			async (reason) => {
				const tmp = fs.mkdtempSync(
					path.join(os.tmpdir(), `pi-lens-wiring-${reason}-`),
				);
				const prevDataDir = process.env.PILENS_DATA_DIR;
				process.env.PILENS_DATA_DIR = path.join(tmp, "data");
				try {
					_resetSessionLifecycleForTests();
					const pi = createPiMock();
					extension(pi.asExtensionAPI());
					const ctx = makeCtx({ cwd: tmp, sessionId: `cache-${reason}` });
					await pi.emit("session_start", { reason: "startup" }, ctx);
					const loader = pi.getTool("pi_lens_activate_tools") as {
						execute: (...args: unknown[]) => Promise<unknown>;
					};
					await loader.execute(
						"activate",
						{ tools: ["ast_grep_search"] },
						undefined,
						undefined,
						ctx,
					);
					const parentPosture = new Set(pi.activeTools);
					expect(parentPosture.has("ast_grep_search")).toBe(true);
					expect(parentPosture.has("ast_grep_replace")).toBe(false);

					// The host re-activates EVERYTHING before the rebuilt session
					// announces itself.
					pi.simulateSessionRebuild();
					for (const tool of EXPECTED_TOOLS) {
						expect(pi.activeTools.has(tool), tool).toBe(true);
					}

					await pi.emit("session_start", { reason }, ctx);

					// Character-for-character the parent's set: the advertised tool
					// list still matches the cached prompt prefix AND the model's
					// activation survived.
					expect([...pi.activeTools].sort()).toEqual([...parentPosture].sort());
					expect(pi.activeTools.has("ast_grep_search")).toBe(true);
					expect(pi.activeTools.has("ast_grep_replace")).toBe(false);
					expect(pi.activeTools.has("lsp_navigation")).toBe(false);
				} finally {
					if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
					else process.env.PILENS_DATA_DIR = prevDataDir;
					removeTempDirSync(tmp);
				}
			},
		);

		// A genuinely new conversation drops the activation memory: the rebuilt
		// all-active set shrinks back to the bare baseline.
		it("forgets the previous conversation's activations on a new session", async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wiring-new-"));
			const prevDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(tmp, "data");
			try {
				_resetSessionLifecycleForTests();
				const pi = createPiMock();
				extension(pi.asExtensionAPI());
				const ctx = makeCtx({ cwd: tmp, sessionId: "cache-new" });
				await pi.emit("session_start", { reason: "startup" }, ctx);
				const loader = pi.getTool("pi_lens_activate_tools") as {
					execute: (...args: unknown[]) => Promise<unknown>;
				};
				await loader.execute(
					"activate",
					{ tools: ["ast_grep_search"] },
					undefined,
					undefined,
					ctx,
				);
				expect(pi.activeTools.has("ast_grep_search")).toBe(true);

				pi.simulateSessionRebuild();
				await pi.emit("session_start", { reason: "new" }, ctx);

				expect(pi.activeTools.has("ast_grep_search")).toBe(false);
				expect(pi.activeTools.has("lens_diagnostics")).toBe(true);
			} finally {
				if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = prevDataDir;
				removeTempDirSync(tmp);
			}
		});

		// #473: the active tool set is process-shared runtime state. A
		// concurrently-live secondary's session_start must not rewrite it out
		// from under the still-live primary (last writer would win).
		it("leaves the tool set alone on a concurrent secondary session_start", async () => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-wiring-secondary-tools-"),
			);
			const prevDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(tmp, "data");
			try {
				_resetSessionLifecycleForTests();
				const pi = createPiMock();
				extension(pi.asExtensionAPI());
				await pi.emit(
					"session_start",
					{ reason: "startup" },
					makeCtx({ cwd: tmp, sessionId: "primary" }),
				);
				// A subagent binds in-process; the host hands it an all-active
				// runtime just like any other session construction.
				pi.simulateSessionRebuild();

				await pi.emit(
					"session_start",
					{ reason: "startup" },
					makeCtx({ cwd: tmp, sessionId: "secondary" }),
				);

				// Untouched: the secondary returned at the #473 guard, above the
				// tool-set mutation.
				for (const tool of EXPECTED_TOOLS) {
					expect(pi.activeTools.has(tool), tool).toBe(true);
				}
			} finally {
				if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = prevDataDir;
				removeTempDirSync(tmp);
			}
		});

		it("keeps every tool statically active when lazy tooling is disabled", async () => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-wiring-static-tools-"),
			);
			const prevDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(tmp, "data");
			try {
				_resetSessionLifecycleForTests();
				const pi = createPiMock({ "no-lazy-tools": true });
				extension(pi.asExtensionAPI());
				const ctx = makeCtx({ cwd: tmp, sessionId: "static" });
				await pi.emit("session_start", { reason: "startup" }, ctx);

				for (const tool of EXPECTED_TOOLS) {
					expect(pi.activeTools.has(tool), tool).toBe(true);
				}

				// Still all-active after a rebuild: under the opt-out pi-lens never
				// touches the set, on any reason.
				pi.simulateSessionRebuild();
				await pi.emit("session_start", { reason: "fork" }, ctx);

				for (const tool of EXPECTED_TOOLS) {
					expect(pi.activeTools.has(tool), tool).toBe(true);
				}
			} finally {
				if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = prevDataDir;
				removeTempDirSync(tmp);
			}
		});

		// #1327: opt-in compact one-line tool rendering, gated by
		// `lens-compact-tool-line` / `ui.compactToolLine`. Off by default — the
		// off path must register the ORIGINAL tool definitions untouched (no
		// renderCall added to tools that never had one; renderResult is the
		// pre-existing #345 per-tool summarizer, not the #1327 wrapper).
		describe("compact tool line (#1327)", () => {
			it("flag off (default): no renderCall is added; renderResult is the tool's own, unwrapped", () => {
				const pi = createPiMock();
				extension(pi.asExtensionAPI());

				for (const t of ["lens_diagnostics", "lsp_diagnostics", "module_report"]) {
					const tool = pi.getTool(t) as
						| { renderCall?: unknown; renderResult?: unknown }
						| undefined;
					expect(tool, `tool: ${t}`).toBeDefined();
					expect(
						tool?.renderCall,
						`${t}.renderCall should be absent when off`,
					).toBeUndefined();
					expect(
						tool?.renderResult,
						`${t}.renderResult should still exist`,
					).toBeTypeOf("function");
				}
			});

			it("flag on: wraps tools that have renderResult with a compact renderCall + one-line renderResult", async () => {
				const pi = createPiMock({ "lens-compact-tool-line": true });
				extension(pi.asExtensionAPI());

				const tool = pi.getTool("lens_diagnostics") as {
					renderCall?: (...a: unknown[]) => { render: (w: number) => string[] };
					renderResult?: (...a: unknown[]) => { render: (w: number) => string[] };
				};
				expect(tool.renderCall).toBeTypeOf("function");
				expect(tool.renderResult).toBeTypeOf("function");

				const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
				const ctx = {
					args: { mode: "all" },
					toolCallId: "x",
					invalidate: () => {},
					lastComponent: undefined,
					state: {},
					cwd: "/repo",
					executionStarted: true,
					argsComplete: true,
					isPartial: false,
					expanded: false,
					showImages: false,
					isError: false,
				};

				// Call row blanks out once a settled result exists (collapsed).
				const callComponent = tool.renderCall?.({ mode: "all" }, theme, ctx);
				expect(callComponent?.render(80)).toEqual([]);

				const resultComponent = tool.renderResult?.(
					{
						content: [],
						details: { mode: "all", totalBlocking: 0, filesWithIssues: 0 },
					},
					{ expanded: false, isPartial: false },
					theme,
					ctx,
				);
				const lines = resultComponent?.render(200) ?? [];
				expect(lines).toHaveLength(1);
				expect(lines[0]).toContain("lens_diagnostics");
			});

			it("registers the lens-compact-tool-line flag from the registry (name + description + default false)", () => {
				const pi = createPiMock();
				extension(pi.asExtensionAPI());

				const spec = LENS_FLAGS.find((s) => s.name === "lens-compact-tool-line");
				expect(spec).toBeDefined();
				expect(pi.flags.get("lens-compact-tool-line")).toEqual({
					description: spec?.description,
					type: "boolean",
					default: false,
				});
			});
		});

		// #205: resources_discover must point at the real skills/ dir, which lives
		// at the package root in BOTH the source and the compiled dist/ layouts.
		// The previous module-relative join landed on dist/skills/ (nonexistent) so
		// skills silently failed to load.
		it("resolves skillPaths to an existing skills/ directory at the package root", async () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());

			const result = (await pi.emit("resources_discover")) as {
				skillPaths: string[];
			};
			expect(result?.skillPaths).toHaveLength(1);
			const skillsDir = result.skillPaths[0];
			expect(skillsDir.replace(/\\/g, "/")).toMatch(/\/skills$/);
			expect(skillsDir.replace(/\\/g, "/")).not.toMatch(/\/dist\/skills$/);
			expect(fs.existsSync(skillsDir), `skills dir exists: ${skillsDir}`).toBe(
				true,
			);
			// #519: all bundled skills are namespaced with a `pi-lens-` prefix so
			// they don't collide with independently installed user skills that
			// share a generic name (discovery is by frontmatter `name`, and a
			// collision causes one copy to be silently skipped).
			const NAMESPACED_SKILLS = [
				"pi-lens-ast-grep",
				"pi-lens-lsp-navigation",
				"pi-lens-write-ast-grep-rule",
				"pi-lens-write-tree-sitter-rule",
			];
			const GENERIC_SKILL_NAMES = [
				"ast-grep",
				"lsp-navigation",
				"write-ast-grep-rule",
				"write-tree-sitter-rule",
			];
			for (const name of NAMESPACED_SKILLS) {
				expect(
					fs.existsSync(path.join(skillsDir, name)),
					`namespaced skill dir exists: ${name}`,
				).toBe(true);
			}
			for (const name of GENERIC_SKILL_NAMES) {
				expect(
					fs.existsSync(path.join(skillsDir, name)),
					`generic skill dir must not exist (regression guard against rename-back): ${name}`,
				).toBe(false);
			}
		});
	});

	describe("context injection gating + toggle", () => {
		let tmp: string;
		let prevDataDir: string | undefined;

		beforeEach(() => {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wiring-"));
			prevDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(tmp, "data");
		});

		afterEach(() => {
			if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = prevDataDir;
			removeTempDirSync(tmp);
		});

		function seedTurnEndFindings(
			cwd: string,
			content: string,
			sessionId: string,
		): void {
			const file = path.join(cwd, "unchanged.ts");
			fs.writeFileSync(file, "export const unchanged = true;\n");
			const provenance = snapshotAdvisoryProvenance({
				cwd,
				runtime: { telemetrySessionId: sessionId, projectSeq: 0, turnIndex: 0 },
				generation: 1,
				files: [{ path: file, role: "affected" }],
			});
			new CacheManager().writeCache(
				"turn-end-findings",
				{ content, provenance },
				cwd,
			);
		}

		it("suppresses injection when --no-lens-context is set, then injects after /lens-context-toggle", async () => {
			// Start OFF deterministically via the CLI flag (env → CLI → config).
			_resetSessionLifecycleForTests();
			const pi = createPiMock({ "no-lens-context": true });
			extension(pi.asExtensionAPI());
			await pi.emit(
				"session_start",
				{ sessionId: "wiring-session" },
				makeCtx({ cwd: tmp, sessionId: "wiring-session" }),
			);
			seedTurnEndFindings(tmp, "TESTFINDINGS_XYZZY", "wiring-session");

			const existing = [{ role: "system", content: "orig" }];

			// Gated off: the context hook returns nothing and leaves findings intact.
			const off = await pi.emit(
				"context",
				{ messages: existing },
				makeCtx({ cwd: tmp }),
			);
			expect(off).toBeUndefined();

			// Flip it on through the real command handler.
			await pi.runCommand("lens-context-toggle", "inject", makeCtx({ cwd: tmp }));

			// Now the same hook injects the cached findings into the transcript.
			// The lone existing message is a `system` message (not a plain user
			// prompt), so the #1016 placement guard appends the findings after it
			// rather than prepending — the original message stays first (so a real
			// user prompt / system preamble keeps its position and the prompt-cache
			// prefix), and the findings land at the tail.
			const on = (await pi.emit(
				"context",
				{ messages: existing },
				makeCtx({ cwd: tmp }),
			)) as { messages: Array<{ role: string; content: string }> } | undefined;

			expect(on?.messages, "expected injected messages").toBeDefined();
			expect(on?.messages[0]).toEqual({ role: "system", content: "orig" });
			expect(on?.messages.at(-1)?.content).toMatch(/TESTFINDINGS_XYZZY/);
			expect(on?.messages.at(-1)?.content).toContain("Address 🔴 blockers");
		});

		it("shows submenu with options via /lens-context-toggle", async () => {
			_resetSessionLifecycleForTests();
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			await pi.emit(
				"session_start",
				{ sessionId: "wiring-session" },
				makeCtx({ cwd: tmp, sessionId: "wiring-session" }),
			);

			const ctx = makeCtx({ cwd: tmp });

			// No argument: shows submenu explaining options.
			await pi.runCommand("lens-context-toggle", "", ctx);
			const notifications = ctx.notifications.map((n) => n.message);
			expect(notifications.some((n) => n.includes("**Options:**"))).toBe(true);
			expect(notifications.some((n) => n.includes("**Inject**"))).toBe(true);
			expect(notifications.some((n) => n.includes("**Steer**"))).toBe(true);
			expect(notifications.some((n) => n.includes("**Off**"))).toBe(true);
		});

		it("sets steer mode via /lens-context-toggle steer", async () => {
			_resetSessionLifecycleForTests();
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			await pi.emit(
				"session_start",
				{ sessionId: "wiring-session" },
				makeCtx({ cwd: tmp, sessionId: "wiring-session" }),
			);

			const ctx = makeCtx({ cwd: tmp });

			// Set steer mode explicitly.
			await pi.runCommand("lens-context-toggle", "steer", ctx);
			const notifications = ctx.notifications.map((n) => n.message);
			expect(notifications.some((n) => n.includes("steer mode"))).toBe(true);
		});

		it("sets off mode via /lens-context-toggle off", async () => {
			_resetSessionLifecycleForTests();
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			await pi.emit(
				"session_start",
				{ sessionId: "wiring-session" },
				makeCtx({ cwd: tmp, sessionId: "wiring-session" }),
			);

			const ctx = makeCtx({ cwd: tmp });

			// Set off mode explicitly.
			await pi.runCommand("lens-context-toggle", "off", ctx);
			const notifications = ctx.notifications.map((n) => n.message);
			expect(notifications.some((n) => n.includes("disabled"))).toBe(true);
		});

		it("sets inject mode via /lens-context-toggle inject", async () => {
			_resetSessionLifecycleForTests();
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			await pi.emit(
				"session_start",
				{ sessionId: "wiring-session" },
				makeCtx({ cwd: tmp, sessionId: "wiring-session" }),
			);

			const ctx = makeCtx({ cwd: tmp });

			// Set inject mode explicitly.
			await pi.runCommand("lens-context-toggle", "inject", ctx);
			const notifications = ctx.notifications.map((n) => n.message);
			expect(notifications.some((n) => n.includes("enabled (inject mode)"))).toBe(
				true,
			);
		});

		it("sends findings via sendUserMessage in steer mode", async () => {
			_resetSessionLifecycleForTests();
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			await pi.emit(
				"session_start",
				{ sessionId: "wiring-session" },
				makeCtx({ cwd: tmp, sessionId: "wiring-session" }),
			);
			seedTurnEndFindings(tmp, "STEER_CONTENT_ABC", "wiring-session");

			const ctx = makeCtx({ cwd: tmp });

			// Set steer mode explicitly.
			await pi.runCommand("lens-context-toggle", "steer", ctx);

			const existing = [{ role: "user", content: "hello" }];
			// Steer mode: context hook returns undefined (no transcript modification)
			// and calls sendUserMessage instead.
			const result = await pi.emit("context", { messages: existing }, ctx);
			expect(result).toBeUndefined();

			// Verify sendUserMessage was called with steer delivery.
			expect(pi.sentUserMessages).toHaveLength(1);
			expect(pi.sentUserMessages[0].options?.deliverAs).toBe("steer");
			expect(pi.sentUserMessages[0].content).toMatch(/STEER_CONTENT_ABC/);
		});

		it("persists steer mode in global config across sessions", async () => {
			const prevConfigPath = process.env.PI_LENS_CONFIG_PATH;
			const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-config-"));
			const configPath = path.join(configDir, "config.json");
			process.env.PI_LENS_CONFIG_PATH = configPath;

			try {
				_resetSessionLifecycleForTests();
				const pi = createPiMock();
				extension(pi.asExtensionAPI());
				await pi.emit(
					"session_start",
					{ sessionId: "persist-session" },
					makeCtx({ cwd: tmp, sessionId: "persist-session" }),
				);

				const ctx = makeCtx({ cwd: tmp });

				// Set steer mode explicitly.
				await pi.runCommand("lens-context-toggle", "steer", ctx);

				// Read back the config file to verify persistence.
				const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
				expect(rawConfig.contextInjection?.mode).toBe("steer");
			} finally {
				if (prevConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
				else process.env.PI_LENS_CONFIG_PATH = prevConfigPath;
				removeTempDirSync(configDir);
			}
		});

		it("respects persisted steer mode on fresh session start", async () => {
			const prevConfigPath = process.env.PI_LENS_CONFIG_PATH;
			const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-config-"));
			const configPath = path.join(configDir, "config.json");
			process.env.PI_LENS_CONFIG_PATH = configPath;

			try {
				// Pre-write steer mode into config.
				fs.writeFileSync(
					configPath,
					JSON.stringify({ contextInjection: { mode: "steer" } }),
				);

				_resetSessionLifecycleForTests();
				const pi = createPiMock();
				extension(pi.asExtensionAPI());
				await pi.emit(
					"session_start",
					{ sessionId: "fresh-session" },
					makeCtx({ cwd: tmp, sessionId: "fresh-session" }),
				);
				seedTurnEndFindings(tmp, "PERSIST_TEST", "fresh-session");

				const ctx = makeCtx({ cwd: tmp });
				const existing = [{ role: "user", content: "hello" }];

				// Should use steer mode from config — no transcript modification.
				const result = await pi.emit("context", { messages: existing }, ctx);
				expect(result).toBeUndefined();

				// And sendUserMessage should have been called.
				expect(pi.sentUserMessages).toHaveLength(1);
				expect(pi.sentUserMessages[0].options?.deliverAs).toBe("steer");
			} finally {
				if (prevConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
				else process.env.PI_LENS_CONFIG_PATH = prevConfigPath;
				removeTempDirSync(configDir);
			}
		});
	});

	describe("/lens-health surfaces event-loop occupancy (#192)", () => {
		it("includes the event-loop line in the health report", async () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			const ctx = makeCtx();

			await pi.runCommand("lens-health", "", ctx);

			const out = ctx.notifications.map((n) => n.message).join("\n");
			expect(out).toContain("🩺 PI-LENS HEALTH");
			// #1122: the session worst is now the worst *genuine* (non-stall) block,
			// tracked outside the per-turn histogram window.
			expect(out).toContain("Event loop: worst genuine block");
		});
	});

	describe("/lens-health surfaces memory attribution (#1123 item 2)", () => {
		it("includes the memory line (RSS/heap/external + review-graph counts)", async () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			const ctx = makeCtx();

			await pi.runCommand("lens-health", "", ctx);

			const out = ctx.notifications.map((n) => n.message).join("\n");
			expect(out).toContain("Memory: RSS");
			expect(out).toMatch(/review-graph \d+n\/\d+e/);
		});
	});

	describe("/lens-perf surfaces latency-log phase percentiles (#767)", () => {
		// The command reads getLatencyLogPath() with no seam, so seed that exact
		// file (inside the per-worker PI_LENS_HOME) or the report is empty and the
		// parse/rank path goes untested.
		afterEach(() => {
			fs.rmSync(getLatencyLogPath(), { force: true });
		});

		it("ranks phases read from the latency log", async () => {
			fs.mkdirSync(path.dirname(getLatencyLogPath()), { recursive: true });
			const fixture = [100, 100, 100]
				.map((durationMs) =>
					JSON.stringify({
						type: "phase",
						phase: "wiring-fixture",
						filePath: "fixture.ts",
						durationMs,
						pid: process.pid,
						ts: new Date().toISOString(),
					}),
				)
				.join("\n");
			fs.writeFileSync(getLatencyLogPath(), `${fixture}\n`);
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			const ctx = makeCtx();

			await pi.runCommand("lens-perf", "", ctx);

			const out = ctx.notifications.map((n) => n.message).join("\n");
			expect(out).toContain("⏱️ PI-LENS PERFORMANCE");
			expect(out).toContain("Current process session");
			expect(out).toContain("Machine-wide active log window");
			expect(out).toContain("wiring-fixture: p50 100ms, p99 100ms, n=3");
		});
	});
});
