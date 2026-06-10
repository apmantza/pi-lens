import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../clients/cache-manager.js";
import extension from "../index.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

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
	"lens-semgrep",
	"lens-semgrep-config",
	"no-read-guard",
	"no-lens-context",
];
const EXPECTED_COMMANDS = [
	"lens-toggle",
	"lens-context-toggle",
	"lens-widget-toggle",
	"lens-semgrep",
	"lens-booboo",
	"lens-tdi",
	"lens-health",
	"lens-tools",
	"lens-allow-edit",
];
const EXPECTED_TOOLS = [
	"ast_grep_search",
	"ast_grep_replace",
	"ast_dump",
	"lens_diagnostics",
	"lsp_diagnostics",
	"lsp_navigation",
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
