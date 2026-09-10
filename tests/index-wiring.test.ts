import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activationToolFactoryOverride = vi.hoisted(() => ({
	enabled: false,
	description: undefined as string | undefined,
}));
const symbolSearchExecution = vi.hoisted(() => ({
	mode: "normal" as "normal" | "reject" | "throw",
}));
const deliveryObservations = vi.hoisted(() => ({
	rows: [] as Array<{ bytes: number; truncated: boolean }>,
}));
/**
 * #2884: which `index.ts` catch site the current test wants to see crash. Each
 * seam below throws only for its own site and otherwise delegates to the real
 * export, so every other test in this file drives the unmodified path.
 */
const handlerCrashInjection = vi.hoisted(() => ({
	site: undefined as
		| undefined
		| "session_start"
		| "session_before_fork"
		| "observed_settled_sweep"
		| "observed_ledger_refresh"
		| "deferred_mutation_drain"
		| "quiet_window",
}));

vi.mock("../tools/activate-tools.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../tools/activate-tools.js")>();
	return {
		...actual,
		createActivateToolsTool: (
			...args: Parameters<typeof actual.createActivateToolsTool>
		) => {
			const tool = actual.createActivateToolsTool(...args);
			if (!activationToolFactoryOverride.enabled) return tool;
			return {
				...tool,
				description: activationToolFactoryOverride.description,
			};
		},
	};
});

vi.mock("../tools/symbol-search.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../tools/symbol-search.js")>();
	return {
		...actual,
		createSymbolSearchTool: (
			...args: Parameters<typeof actual.createSymbolSearchTool>
		) => {
			const tool = actual.createSymbolSearchTool(...args);
			return {
				...tool,
				execute: async (...executeArgs: Parameters<typeof tool.execute>) => {
					if (symbolSearchExecution.mode === "throw")
						throw new Error("probe sync boom");
					if (symbolSearchExecution.mode === "reject")
						throw new Error("probe boom");
					return tool.execute(...executeArgs);
				},
			};
		},
	};
});

vi.mock("../clients/cache-observability.js", async (importOriginal) => {
	const actual =
		(await importOriginal()) as typeof import("../clients/cache-observability.js");
	return {
		...(await importOriginal()),
		...actual,
		recordToolResultDelivery: (args: { bytes: number; truncated: boolean }) => {
			deliveryObservations.rows.push(args);
			actual.recordToolResultDelivery(args);
		},
	};
});

vi.mock("../clients/widget-state.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/widget-state.js")>();
	return {
		...actual,
		exportWidgetState: (
			...args: Parameters<typeof actual.exportWidgetState>
		) => {
			if (handlerCrashInjection.site === "session_before_fork")
				throw new Error("probe: session_before_fork boom");
			return actual.exportWidgetState(...args);
		},
	};
});

vi.mock("../clients/observed-mutation.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/observed-mutation.js")>();
	return {
		...actual,
		runObservedSettledSweep: async (
			...args: Parameters<typeof actual.runObservedSettledSweep>
		) => {
			if (handlerCrashInjection.site === "observed_settled_sweep")
				throw new Error("probe: observed_settled_sweep boom");
			return actual.runObservedSettledSweep(...args);
		},
		refreshObservedMutationLedger: async (
			...args: Parameters<typeof actual.refreshObservedMutationLedger>
		) => {
			if (handlerCrashInjection.site === "observed_ledger_refresh")
				throw new Error("probe: observed_ledger_refresh boom");
			return actual.refreshObservedMutationLedger(...args);
		},
	};
});

vi.mock("../clients/runtime-agent-end.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/runtime-agent-end.js")>();
	return {
		...actual,
		handleAgentEnd: async (
			...args: Parameters<typeof actual.handleAgentEnd>
		) => {
			if (handlerCrashInjection.site === "deferred_mutation_drain")
				throw new Error("probe: deferred_mutation_drain boom");
			return actual.handleAgentEnd(...args);
		},
	};
});

vi.mock("../clients/quiet-window.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/quiet-window.js")>();
	return {
		...actual,
		runQuietWindow: async (
			...args: Parameters<typeof actual.runQuietWindow>
		) => {
			if (handlerCrashInjection.site === "quiet_window")
				throw new Error("probe: quiet_window boom");
			return actual.runQuietWindow(...args);
		},
	};
});

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
	recordDegradation,
	renderDegradationLines,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx, makeStaleCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

// #643: the dynamic-tool-deactivation call now runs inside the session_start
// handler rather than synchronously at registration time (see index.ts), so
// the tests below that need to observe it must actually fire session_start.
// Mock out the two heavy real-work seams the same way
// tests/index-integration.test.ts does, so firing session_start here stays a
// fast, deterministic wiring check rather than a real scan/LSP-bootstrap.
vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
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
	}));
});
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async () => {
		if (handlerCrashInjection.site === "session_start")
			throw new Error("probe: session_start boom");
	},
}));

// The contract index.ts wires into the host. If a registration is dropped or
// renamed, this catches it — the kind of glue that was previously untested
// (#171) and that the dist-packaging breakage showed we need to guard.
// Flags are DERIVED from the registry rather than restated (#166): the old
// hand-written list had already drifted (it was missing `lens-turn-summary`),
// which is the same drift class the registry exists to make impossible.
const EXPECTED_FLAGS = [...LENS_FLAGS.map((spec) => spec.name), "no-tool"];
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
	"pi_lens_activate_tools",
	"lens_diagnostics",
	"lsp_navigation",
	"lens_diagnostic_mark",
	"symbol_search",
	"project_report",
	"module_report",
	"read_symbol",
	"read_enclosing",
];
const ALWAYS_ACTIVE_TOOLS = [
	"lens_diagnostics",
	"symbol_search",
	"project_report",
	"module_report",
	"read_symbol",
	"read_enclosing",
];
const ACTIVATION_TOOLS = ["pi_lens_activate_tools"];
const LAZY_TOOLS = [
	"ast_grep_search",
	"ast_grep_replace",
	"ast_grep_outline",
	"lsp_navigation",
	"lens_diagnostic_mark",
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
	it.each(["reject", "throw"])(
		"returns a top-level bounded error result when symbol_search %s",
		async (mode) => {
			symbolSearchExecution.mode = mode as "reject" | "throw";
			deliveryObservations.rows.length = 0;
			try {
				const pi = createPiMock();
				extension(pi.asExtensionAPI());
				const tool = pi.getTool("symbol_search") as any;
				const result = await tool.execute(
					"probe",
					{ query: "x" },
					new AbortController().signal,
					undefined,
					makeCtx({ cwd: process.cwd(), sessionId: "f1" }),
				);
				const text = result.content?.[0]?.text ?? "";
				expect(result.content).toBeDefined();
				expect(result.isError).toBe(true);
				expect(text).toContain("result error");
				expect(text.match(/^result error$/gm) ?? []).toHaveLength(1);
				expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(40 * 1024);
				const footerBytes = Number(
					text.match(/bytes=(\d+)/)?.[1] ?? Number.NaN,
				);
				expect(deliveryObservations.rows).toEqual([
					expect.objectContaining({ bytes: footerBytes, truncated: false }),
				]);
			} finally {
				symbolSearchExecution.mode = "normal";
			}
		},
	);

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
			const staleCtx = makeCtx({
				cwd: process.cwd(),
				sessionId: "stale-sibling",
			});
			staleCtx.isIdle = () => {
				throw new Error(
					"This extension ctx is stale after session replacement",
				);
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
				ownerEmit.mock.calls.filter(
					([event]) => event === "pilens:files:touched",
				),
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
				throw new Error(
					"This extension ctx is stale after session replacement",
				);
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
				ownerEmit.mock.calls.filter(
					([event]) => event === "pilens:files:touched",
				),
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
				throw new Error(
					"This extension ctx is stale after session replacement",
				);
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
				bootEmit.mock.calls.filter(
					([event]) => event === "pilens:files:touched",
				),
			).toHaveLength(1);
		} finally {
			_resetSessionLifecycleForTests();
			resetBusPublishForTests();
		}
	});

	describe("registration", () => {
		// #1988: validate metadata at the same host boundary that exposed the
		// failure. Keep the matrix across both registration-time feature flags and
		// assert each registration group so a bypassed group cannot hide behind a
		// passing helper-only test.
		it.each([
			{ compactToolLine: false, supportsActiveTools: false },
			{ compactToolLine: false, supportsActiveTools: true },
			{ compactToolLine: true, supportsActiveTools: false },
			{ compactToolLine: true, supportsActiveTools: true },
		])(
			"registers non-empty descriptions through the host seam (compact=$compactToolLine, dynamic=$supportsActiveTools)",
			({ compactToolLine, supportsActiveTools }) => {
				activationToolFactoryOverride.enabled = true;
				activationToolFactoryOverride.description = undefined;
				try {
					const pi = createPiMock(
						compactToolLine ? { "lens-compact-tool-line": true } : {},
						{ supportsActiveTools },
					);
					extension(pi.asExtensionAPI());
					expect(
						(pi.getTool("pi_lens_activate_tools") as { description?: unknown })
							.description,
					).toBe("Use the pi_lens_activate_tools tool.");

					for (const [group, names] of Object.entries({
						alwaysActive: ALWAYS_ACTIVE_TOOLS,
						activation: ACTIVATION_TOOLS,
						lazy: LAZY_TOOLS,
					})) {
						for (const name of names) {
							expect(pi.getTool(name), `${group} tool: ${name}`).toBeDefined();
						}
					}

					for (const [name, tool] of pi.tools) {
						const description = (tool as { description?: unknown }).description;
						expect(description, `description: ${name}`).toBeTypeOf("string");
						expect(
							(description as string).trim(),
							`description: ${name}`,
						).not.toBe("");
					}
				} finally {
					activationToolFactoryOverride.enabled = false;
					activationToolFactoryOverride.description = undefined;
				}
			},
		);

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
			expect(pi.flags.get("no-tool")).toEqual({
				description: "Disable a lens tool for this session (repeatable).",
				type: "string",
			});
		});

		it("does not register a tool disabled by project config through the real path", () => {
			const tempDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-tool-config-"),
			);
			const configPath = path.join(tempDir, "config.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					tools: { ast_grep_replace: { enabled: false } },
				}),
			);
			const prior = process.env.PI_LENS_CONFIG_PATH;
			process.env.PI_LENS_CONFIG_PATH = configPath;
			try {
				const pi = createPiMock();
				extension(pi.asExtensionAPI());
				expect(pi.getTool("ast_grep_replace")).toBeUndefined();
				expect(pi.getTool("pi_lens_activate_tools")).toBeDefined();
			} finally {
				if (prior === undefined) delete process.env.PI_LENS_CONFIG_PATH;
				else process.env.PI_LENS_CONFIG_PATH = prior;
				removeTempDirSync(tempDir);
			}
		});

		it("does not register a tool disabled by --no-tool through the real path", () => {
			const pi = createPiMock({ "no-tool": "ast_grep_replace" });
			extension(pi.asExtensionAPI());
			expect(pi.getTool("ast_grep_replace")).toBeUndefined();
			expect(pi.getTool("ast_grep_search")).toBeDefined();
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

		// #dynamic-tooling: 5 situational tools are registered but start
		// inactive on a host that supports pi's dynamic tool loading
		// (pi.getActiveTools/setActiveTools); the 6 always-active tools plus
		// the loader itself stay active. Newly-activated tools only need to
		// be visible from the NEXT turn, so this only asserts load-time state.
		// #643: the deactivation call moved from synchronous registration into
		// the session_start handler (the correct lifecycle point — see
		// index.ts), so this test now fires session_start before asserting.
		it("registers the 5 situational tools inactive and everything else active on a dynamic-tooling host", async () => {
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
					"lsp_navigation",
					"lens_diagnostic_mark",
				];
				const ALWAYS_ACTIVE = [
					"lens_diagnostics",
					"symbol_search",
					"project_report",
					"module_report",
					"read_symbol",
					"read_enclosing",
					"pi_lens_activate_tools",
				];

				for (const t of LAZY_TOOLS) {
					expect(pi.getTool(t), `tool registered: ${t}`).toBeDefined();
					expect(pi.activeTools.has(t), `should start inactive: ${t}`).toBe(
						false,
					);
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

		// #1453: this mock models the host's all-active handoff, but it does not
		// re-run the extension factory. Real-pi integration tests cover that
		// factory boundary; this test covers the restore plan for a live closure.
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

					// The mock re-activates EVERYTHING before the rebuilt session
					// announces itself.
					await pi.simulateSessionShutdownAndRebuild(
						reason as "fork" | "reload" | "resume",
						ctx,
					);
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

				await pi.simulateSessionShutdownAndRebuild("new", ctx);

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
				for (const name of pi.tools.keys()) pi.activeTools.add(name);

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
				for (const name of pi.tools.keys()) pi.activeTools.add(name);
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

				for (const t of ["lens_diagnostics", "module_report"]) {
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
					renderResult?: (...a: unknown[]) => {
						render: (w: number) => string[];
					};
				};
				expect(tool.renderCall).toBeTypeOf("function");
				expect(tool.renderResult).toBeTypeOf("function");

				const theme = {
					fg: (_c: string, t: string) => t,
					bold: (t: string) => t,
				};
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

				const spec = LENS_FLAGS.find(
					(s) => s.name === "lens-compact-tool-line",
				);
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
			resetDegradationLedger();
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
			// #2626: the standard layout (this repo's own skills/ beside
			// package.json) must produce NO "skills-dir-missing" degradation —
			// the negative case for the silent-zero-skills fix, driven through
			// the real resources_discover handler rather than the resolver in
			// isolation.
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "skills-dir-missing",
				),
			).toBeUndefined();
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
			// #1681: the host never puts sessionId on the session_start event — see
			// index.ts's own comment at the `stableSessionId` read ("the event
			// carries none"). It belongs on ctx, via makeCtx below.
			await pi.emit(
				"session_start",
				makeSessionStartEvent(),
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
			await pi.runCommand("lens-context-toggle", "", makeCtx({ cwd: tmp }));

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

		it("renders degradations through the shared renderDegradationLines seam, agreeing with pilens_health (#2515 S3)", async () => {
			resetDegradationLedger();
			try {
				// `log-sink-rotated` is an INFORMATIONAL kind (see
				// `INFORMATIONAL_DEGRADATION_KINDS` in degradation-ledger.ts): the
				// shared renderer prints it as a bare count with no subject/reason.
				// A hand-rolled renderer that always interpolates
				// `latestReasons.at(-1)` (the pre-fix shape here) would print a
				// fabricated "(subject: reason)" suffix even for this kind — the
				// exact divergence from the MCP `pilens_health` path (which already
				// uses `renderDegradationLines`) that #2515 S3 flags.
				recordDegradation({
					kind: "log-sink-rotated",
					subject: "test.log",
					reason: "rotated",
				});

				const pi = createPiMock();
				extension(pi.asExtensionAPI());
				const ctx = makeCtx();

				await pi.runCommand("lens-perf", "", ctx);

				const out = ctx.notifications.map((n) => n.message).join("\n");
				const expectedLines = renderDegradationLines(getDegradationSummary());
				expect(expectedLines).toEqual([
					"Degradations:",
					"  log-sink-rotated: 1",
				]);
				for (const line of expectedLines) {
					expect(out).toContain(line);
				}
				expect(out).not.toContain("log-sink-rotated: 1 (test.log: rotated)");
			} finally {
				resetDegradationLedger();
			}
		});
	});
});

/**
 * #1925 — class siblings of the `agent_settled` stale-ctx crash (#1924/PR
 * #1921).
 *
 * pi invalidates a captured event ctx when the session is replaced
 * (`newSession`/`fork`/`switchSession`/`reload`). An event already queued when
 * that happens still reaches pi-lens, carrying the DEAD ctx. Four handlers read
 * a ctx property before any guard, so the SDK's `assertActive()` throw escaped
 * into the host.
 *
 * Each test below drives one real registration through `createPiMock` with a
 * ctx whose every accessor throws the SDK message, and asserts two things: the
 * handler resolves rather than rejecting, and the skip is VISIBLE in the
 * degradation ledger. Together they prove the shared wrapper
 * (`clients/session-event-guard.ts`) is actually applied to each `pi.on` site —
 * an unwrapped registration reds its own case. The ledger half is what keeps
 * each guard mutation-proof: a guard that swallowed the throw silently would
 * still pass the "does not reject" half.
 */
describe("stale extension ctx tolerance in event handlers (#1925)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
		resetBusPublishForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		_resetSessionLifecycleForTests();
		resetBusPublishForTests();
		resetDegradationLedger();
	});

	/** The ledger entry a stale-ctx skip must leave behind, for one handler. */
	function expectStaleSkipRecorded(handler: string): void {
		const group = getDegradationSummary().find(
			(entry) => entry.kind === "extension-ctx-stale",
		);
		expect(
			group,
			`${handler} skipped a stale ctx without recording it in the degradation ledger`,
		).toBeDefined();
		expect(group?.latestReasons.map((reason) => reason.subject)).toContain(
			handler,
		);
	}

	const CASES: Array<{ event: string; payload: unknown }> = [
		{
			event: "tool_result",
			payload: { toolName: "edit", input: { path: "a.ts" } },
		},
		{ event: "turn_start", payload: {} },
		{ event: "agent_end", payload: { messages: [] } },
		{ event: "turn_end", payload: {} },
		{ event: "agent_settled", payload: {} },
		// #1929: both of these already SURVIVED a stale ctx before the fix — each
		// had a total try/catch — so the "resolves" half passes either way. The
		// ledger half is the whole test. Without the wrapper the skip is logged as
		// `session_start crashed: …` / `context event error: …` and counted
		// nowhere, so `expectStaleSkipRecorded` is what reds on pre-fix code.
		{ event: "session_start", payload: makeSessionStartEvent() },
		{ event: "context", payload: { messages: [] } },
	];

	for (const { event, payload } of CASES) {
		it(`tolerates and records a stale ctx delivered to ${event}`, async () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());

			await expect(
				pi.emit(event, payload, makeStaleCtx()),
			).resolves.not.toThrow();

			expectStaleSkipRecorded(event);
		});
	}

	it("hands the host its own message list back when context gets a stale ctx (#1929)", async () => {
		// `context` is the one wrapped handler whose return value the host
		// consumes. The stale path must answer `undefined` — pi's "this extension
		// contributed nothing" — so the host keeps the transcript it already had.
		// Any other value (a partial injection, an echoed array) would change what
		// pi builds the request from at the exact moment pi-lens knows least.
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const existing = [{ role: "user", content: "keep me" }];

		const result = await pi.emit(
			"context",
			{ messages: existing },
			makeStaleCtx(),
		);

		expect(result).toBeUndefined();
		expect(existing).toEqual([{ role: "user", content: "keep me" }]);
		expectStaleSkipRecorded("context");
	});

	/**
	 * A ctx that PASSES the pre-dispatch probe and dies afterwards (#1929).
	 *
	 * `makeStaleCtx` is dead on arrival, so the wrapper's probe catches it and
	 * the handler never runs. The other half of the race is a swap that lands
	 * while the handler is already inside its own body. `session_start` and
	 * `context` each wrap their body in a total catch, so without an explicit
	 * rethrow that catch eats the stale throw and the wrapper never sees it.
	 */
	function makeCtxThatDiesMidHandler() {
		const ctx = makeCtx({ sessionId: "dies-mid-handler" });
		ctx.isIdle = () => true;
		Object.defineProperty(ctx, "cwd", {
			configurable: true,
			get() {
				throw new Error(
					"This extension ctx is stale after session replacement or reload",
				);
			},
		});
		return ctx;
	}

	for (const { event, payload } of [
		{ event: "session_start", payload: makeSessionStartEvent() },
		{ event: "context", payload: { messages: [] } },
	]) {
		it(`hands a MID-handler stale throw to the wrapper from ${event} (#1929)`, async () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());

			await expect(
				pi.emit(event, payload, makeCtxThatDiesMidHandler()),
			).resolves.not.toThrow();

			// Without the rethrow this passes the "resolves" half and records
			// nothing: the handler's own catch logs `… crashed` / `… event error`
			// and the class stays invisible.
			expectStaleSkipRecorded(event);
			expect(
				getDegradationSummary().find(
					(entry) => entry.kind === "extension-ctx-stale",
				)?.latestReasons[0]?.reason,
			).toContain("mid-handler");
		});
	}

	it("keeps a NON-stale handler failure loud instead of absorbing it", async () => {
		// The guard classifies by message. An unrelated throw must still escape,
		// and must never be counted as a stale-ctx skip — that would turn every
		// handler bug into silence.
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const ctx = makeCtx();
		Object.defineProperty(ctx, "signal", {
			configurable: true,
			get() {
				throw new Error("boom: not a stale ctx");
			},
		});

		await expect(
			pi.emit("tool_result", { toolName: "edit" }, ctx),
		).rejects.toThrow("boom: not a stale ctx");
		expect(
			getDegradationSummary().find(
				(entry) => entry.kind === "extension-ctx-stale",
			),
		).toBeUndefined();
	});
});

/**
 * #2884 — a crashed hook handler must not be invisible under the test runner.
 *
 * Recurrence this guards: #2859. `index.ts` swallows a crashed handler into
 * `dbg(...)` so a pi-lens bug can never take down the host's session, and `dbg`
 * writes nothing under vitest — so fourteen `session_start` awaits in
 * `tests/index-integration.test.ts` rejected into that catch, every assertion
 * after them was vacuous, and the file stayed green. #2866 closed the hole for
 * `session_start` alone; seven sibling catches still swallowed silently, and
 * `turn_end`'s swallow had already hidden a partial `read-guard` mock in a live
 * test. Each case below drives ONE real registration through `createPiMock`
 * with a crash injected into the seam that catch site wraps, and asserts two
 * independent effects: the crash reaches the caller under the runner, and
 * production's swallow leaves one bounded `hook-handler-crash` ledger row that
 * names the handler.
 */
describe("hook handler crash surfacing (#2884)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-crash-surface-"));
		handlerCrashInjection.site = undefined;
		_resetSessionLifecycleForTests();
		resetBusPublishForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		handlerCrashInjection.site = undefined;
		_resetSessionLifecycleForTests();
		resetBusPublishForTests();
		resetDegradationLedger();
		removeTempDirSync(tmp);
	});

	/** The bounded production record every swallowed crash must leave. */
	function crashLedgerGroup() {
		return getDegradationSummary().find(
			(entry) => entry.kind === "hook-handler-crash",
		);
	}

	function expectCrashRecorded(handler: string): void {
		const group = crashLedgerGroup();
		expect(
			group,
			`${handler} crashed without a hook-handler-crash ledger record`,
		).toBeDefined();
		expect(group?.latestReasons.map((reason) => reason.subject)).toContain(
			handler,
		);
	}

	/** A live ctx whose `signal` read throws something that is NOT a stale ctx. */
	function makeCtxWhoseSignalCrashes(sessionId: string) {
		const ctx = makeCtx({ cwd: tmp, sessionId });
		Object.defineProperty(ctx, "signal", {
			configurable: true,
			get() {
				throw new Error(`probe: ${sessionId} boom`);
			},
		});
		return ctx;
	}

	it("surfaces a crashed session_start under the test runner and records it", async () => {
		handlerCrashInjection.site = "session_start";
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await expect(
			pi.emit("session_start", makeSessionStartEvent(), makeCtx({ cwd: tmp })),
		).rejects.toThrow("probe: session_start boom");

		expectCrashRecorded("session_start");
	});

	it("surfaces a crashed session_before_fork under the test runner and records it", async () => {
		handlerCrashInjection.site = "session_before_fork";
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await expect(
			pi.emit("session_before_fork", {}, makeCtx({ cwd: tmp })),
		).rejects.toThrow("probe: session_before_fork boom");

		expectCrashRecorded("session_before_fork");
	});

	it("surfaces a crashed observed_settled_sweep under the test runner and records it", async () => {
		handlerCrashInjection.site = "observed_settled_sweep";
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await expect(
			pi.emit("agent_settled", {}, makeCtx({ cwd: tmp, sessionId: "sweep" })),
		).rejects.toThrow("probe: observed_settled_sweep boom");

		expectCrashRecorded("observed_settled_sweep");
	});

	it("surfaces a crashed observed_ledger_refresh under the test runner and records it", async () => {
		handlerCrashInjection.site = "observed_ledger_refresh";
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await expect(
			pi.emit("agent_settled", {}, makeCtx({ cwd: tmp, sessionId: "refresh" })),
		).rejects.toThrow("probe: observed_ledger_refresh boom");

		expectCrashRecorded("observed_ledger_refresh");
	});

	it("surfaces a crashed agent_settled deferred_mutation_drain under the test runner and records it", async () => {
		handlerCrashInjection.site = "deferred_mutation_drain";
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await expect(
			pi.emit("agent_settled", {}, makeCtx({ cwd: tmp, sessionId: "drain" })),
		).rejects.toThrow("probe: deferred_mutation_drain boom");

		expectCrashRecorded("agent_settled deferred_mutation_drain");
	});

	it("surfaces a crashed agent_end under the test runner and records it", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await expect(
			pi.emit("agent_end", { messages: [] }, makeCtxWhoseSignalCrashes("ae")),
		).rejects.toThrow("probe: ae boom");

		expectCrashRecorded("agent_end");
	});

	it("surfaces a crashed turn_end under the test runner and records it", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await expect(
			pi.emit("turn_end", {}, makeCtxWhoseSignalCrashes("te")),
		).rejects.toThrow("probe: te boom");

		expectCrashRecorded("turn_end");
	});

	it("surfaces a crashed quiet_window under the test runner as an unhandled rejection", async () => {
		// The one fire-and-forget site of the eight: nothing awaits
		// `runQuietWindow`, so the runner rethrow can only surface as an
		// unhandled rejection. Vitest fails a run on one (`Errors 1 error`,
		// exit 1) — this test takes its own listener so the assertion is
		// deterministic instead of relying on the runner's end-of-run report,
		// and hands vitest's listeners straight back.
		const savedListeners = process.listeners("unhandledRejection");
		process.removeAllListeners("unhandledRejection");
		const seen: unknown[] = [];
		const capture = (reason: unknown) => {
			seen.push(reason);
		};
		process.on("unhandledRejection", capture);
		try {
			handlerCrashInjection.site = "quiet_window";
			const pi = createPiMock();
			extension(pi.asExtensionAPI());

			await pi.emit(
				"agent_settled",
				{},
				makeCtx({ cwd: tmp, sessionId: "quiet" }),
			);
			await vi.waitFor(() => {
				expect(seen).toHaveLength(1);
			});
		} finally {
			process.off("unhandledRejection", capture);
			for (const listener of savedListeners)
				process.on("unhandledRejection", listener as never);
		}

		expect(String(seen[0])).toContain("probe: quiet_window boom");
		expectCrashRecorded("quiet_window");
	});

	it("keeps swallowing a crashed turn_end off the test runner, with one bounded record", async () => {
		// The production direction, and the only one the `if (process.env.VITEST)`
		// guard's `if (true)` mutation can red: with no runner present the host's
		// turn must still resolve, and the crash must still be counted exactly
		// once per handler per session however many turns crash.
		const savedVitest = process.env.VITEST;
		process.env.VITEST = undefined as unknown as string;
		delete process.env.VITEST;
		try {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());

			await expect(
				pi.emit("turn_end", {}, makeCtxWhoseSignalCrashes("te")),
			).resolves.toBeUndefined();
			await expect(
				pi.emit("turn_end", {}, makeCtxWhoseSignalCrashes("te")),
			).resolves.toBeUndefined();
		} finally {
			if (savedVitest === undefined) delete process.env.VITEST;
			else process.env.VITEST = savedVitest;
		}

		expectCrashRecorded("turn_end");
		expect(crashLedgerGroup()?.count).toBe(1);
	});
});
