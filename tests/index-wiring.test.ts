import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../clients/cache-manager.js";
import extension from "../index.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

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
			analyze: async () => ({ success: false, summary: "unavailable", issues: [] }),
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
const EXPECTED_FLAGS = [
	"no-lens",
	"no-lsp",
	"no-autoformat",
	"immediate-format",
	"no-autofix",
	"no-tests",
	"no-delta",
	"lens-guard",
	"no-opengrep",
	"no-read-guard",
	"no-lens-context",
];
const EXPECTED_COMMANDS = [
	"lens-toggle",
	"lens-context-toggle",
	"lens-widget-toggle",
	"lens-tdi",
	"lens-health",
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
	"symbol_search",
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
					"ast_grep_dump",
					"lsp_navigation",
				];
				const ALWAYS_ACTIVE = [
					"lens_diagnostics",
					"lsp_diagnostics",
					"symbol_search",
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
					expect(pi.activeTools.has(t), `should start active: ${t}`).toBe(
						true,
					);
				}
			} finally {
				if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = prevDataDir;
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		});

		// Feature-detection fallback: a host without getActiveTools/setActiveTools
		// (older pi, or any host not implementing dynamic tooling) must not throw,
		// and every tool — including the 5 normally-lazy ones — stays statically
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
					// Every tool — including the normally-lazy 5 — stays active because
					// index.ts never found getActiveTools/setActiveTools to call, so it
					// skipped the deactivation step entirely (the graceful fallback).
					expect(pi.activeTools.has(t), `should stay active: ${t}`).toBe(
						true,
					);
				}
			} finally {
				if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = prevDataDir;
				fs.rmSync(tmp, { recursive: true, force: true });
			}
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
			fs.rmSync(tmp, { recursive: true, force: true });
		});

		function seedTurnEndFindings(cwd: string, content: string): void {
			new CacheManager().writeCache("turn-end-findings", { content }, cwd);
		}

		it("suppresses injection when --no-lens-context is set, then injects after /lens-context-toggle", async () => {
			// Start OFF deterministically via the CLI flag (env → CLI → config).
			const pi = createPiMock({ "no-lens-context": true });
			extension(pi.asExtensionAPI());
			seedTurnEndFindings(tmp, "TESTFINDINGS_XYZZY");

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

			// Now the same hook prepends the cached findings ahead of existing messages.
			const on = (await pi.emit(
				"context",
				{ messages: existing },
				makeCtx({ cwd: tmp }),
			)) as { messages: Array<{ role: string; content: string }> } | undefined;

			expect(on?.messages, "expected injected messages").toBeDefined();
			expect(on?.messages[0].content).toMatch(/TESTFINDINGS_XYZZY/);
			expect(on?.messages.at(-1)).toEqual({ role: "system", content: "orig" });
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
			expect(out).toContain("Event loop (session):");
		});
	});
});
