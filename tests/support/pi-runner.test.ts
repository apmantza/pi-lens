/**
 * The tier-1 helper's own contract (#4632 slice 1): `startPiRunner` hands the
 * built pi-lens extension to pi's real loader and reports what the HOST holds,
 * not what `index.ts` passed to a stand-in.
 *
 * Every assertion below reads a value only pi produces: the source metadata of
 * the loaded entry, a flag definition's owning extension, a command resolved
 * through the host, and the host's handler registry. The declared sets are
 * pinned literally, so a registration that disappears cannot pass on a
 * shrinking roster (#4641 F3).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type PiRunner, startPiRunner } from "./pi-runner.js";

/** The built extension `npm run build` writes; the helper loads this file. */
const BUILT_ENTRY = fileURLToPath(new URL("../../index.js", import.meta.url));

/** Every event `index.ts` registers a handler for. */
const DECLARED_HANDLERS = [
	"resources_discover",
	"session_start",
	"session_tree",
	"tool_call",
	"tool_result",
	"tool_execution_end",
	"turn_start",
	"agent_end",
	"turn_end",
	"agent_settled",
	"session_shutdown",
	"message_end",
	"context",
	// #4631: the 0.87+ request hook. `context` injects on a pre-0.87 host and
	// defers here; the roster is pinned in both directions, so a second
	// registration is a change to this line, never a silent extra.
	"context_with_system",
	// #4687: a model switch re-decides the lazy-tools posture for the new model.
	"model_select",
];

/** Every flag `index.ts` registers: `LENS_FLAGS` plus `no-tool`. */
const DECLARED_FLAGS = [
	"no-lens",
	"no-lsp",
	"no-autoformat",
	"immediate-format",
	"no-autofix",
	"no-tests",
	"no-delta",
	"lens-guard",
	"lens-checkout-guard",
	"no-opengrep",
	"no-ast-grep",
	"no-zizmor",
	"no-typos",
	"lens-spotbugs",
	"no-read-guard",
	"no-read-expansion",
	"no-lens-context",
	"lens-retain-injections",
	"lens-turn-summary",
	"lens-actionable-warnings",
	"lens-actionable-warning-actions",
	"lens-actionable-warning-autofix",
	"lens-actionable-warning-all",
	"lens-compact-tool-line",
	"lens-compact-lsp-status",
	"lens-hide-lsp-status",
	"lens-issues-status",
	"lens-compact-widget",
	"no-lazy-tools",
	"lens-turn-end-madge",
	"lens-fallow",
	"no-knip",
	"no-jscpd",
	"no-madge",
	"no-gitleaks",
	"no-govulncheck",
	"no-dead-code",
	"no-complexity",
	"no-tool",
];

/** Every command `index.ts` registers. */
const DECLARED_COMMANDS = [
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

const sorted = (names: readonly string[]): string[] => [...names].sort();

describe("pi-runner: the built extension in pi's real ExtensionRunner (#4632)", () => {
	let pi: PiRunner;

	beforeAll(async () => {
		pi = await startPiRunner();
	});

	it("loads the built entry with no load error and attributes every registration to it", () => {
		expect(pi.errors).toEqual([]);
		const tools = pi.getAllRegisteredTools();
		expect(tools.length).toBeGreaterThan(0);
		const owners = new Set(
			tools.map((tool) => path.resolve(tool.sourceInfo.path)),
		);
		expect([...owners]).toEqual([BUILT_ENTRY]);
	});

	it("holds every declared flag, and only those, as host flag definitions owned by the built entry", () => {
		expect(sorted(pi.getDeclaredRegistrations().flags)).toEqual(
			sorted(DECLARED_FLAGS),
		);
		const flags = pi.getFlags();
		expect(sorted([...flags.keys()])).toEqual(sorted(DECLARED_FLAGS));
		for (const [name, flag] of flags) {
			expect(flag.name).toBe(name);
			expect(["boolean", "string"]).toContain(flag.type);
			expect(path.resolve(flag.extensionPath)).toBe(BUILT_ENTRY);
		}
	});

	it("resolves every declared command through the host, and only those", () => {
		expect(sorted(pi.getDeclaredRegistrations().commands)).toEqual(
			sorted(DECLARED_COMMANDS),
		);
		const commands = pi.getRegisteredCommands();
		expect(sorted(commands.map((command) => command.name))).toEqual(
			sorted(DECLARED_COMMANDS),
		);
		for (const command of commands) {
			expect(typeof command.handler, `handler: ${command.name}`).toBe(
				"function",
			);
			expect(command.invocationName.length, command.name).toBeGreaterThan(0);
		}
	});

	it("registers the lifecycle handlers the extension declares, and no unknown one", () => {
		const declared = pi.getDeclaredRegistrations().handlers;
		expect(sorted(declared)).toEqual(sorted(DECLARED_HANDLERS));
		for (const event of declared) {
			expect(pi.hasHandlers(event), `handler: ${event}`).toBe(true);
		}
		expect(pi.hasHandlers("pi_runner_no_such_event")).toBe(false);
	});
});
