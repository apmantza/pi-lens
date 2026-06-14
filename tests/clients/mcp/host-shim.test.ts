/**
 * host-shim: the MCP path's sole host coupling — a `getFlag` resolver backed by
 * global config + per-call overrides (no pi process, no CLI flags).
 */

import { describe, expect, it } from "vitest";
import { createMcpHost } from "../../../clients/mcp/host-shim.js";

describe("createMcpHost", () => {
	it("returns a PiAgentAPI with a getFlag method", () => {
		const host = createMcpHost();
		expect(typeof host.getFlag).toBe("function");
	});

	it("lets a per-call override win over global-config defaults", () => {
		const host = createMcpHost({ "no-lsp": true });
		expect(host.getFlag("no-lsp")).toBe(true);
	});

	it("honors an explicit undefined override (own-property, not fallthrough)", () => {
		// Object.hasOwn — an explicit `undefined` override pins the flag to
		// undefined rather than falling through to config resolution.
		const host = createMcpHost({ "no-autoformat": undefined });
		expect(host.getFlag("no-autoformat")).toBeUndefined();
	});

	it("resolves unknown flags through config without throwing", () => {
		const host = createMcpHost();
		// No override → delegates to resolvePiLensFlag; must not throw and must
		// return a flag-shaped value.
		const value = host.getFlag("definitely-not-a-real-flag");
		expect(["boolean", "string", "undefined"]).toContain(typeof value);
	});

	it("passes a string override through unchanged", () => {
		const host = createMcpHost({ "lens-semgrep-config": "p/security" });
		expect(host.getFlag("lens-semgrep-config")).toBe("p/security");
	});
});
