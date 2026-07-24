/**
 * host-shim: the MCP path's sole host coupling — a `getFlag` resolver backed by
 * global config + per-call overrides (no pi process, no CLI flags).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
		const host = createMcpHost({ "lens-opengrep-config": "p/security" });
		expect(host.getFlag("lens-opengrep-config")).toBe("p/security");
	});

	it("resolves flags scoped to a per-call cwd, not a frozen module-load cwd (#792)", () => {
		// Mirrors the fix in mcp/server.ts: `lspNavigationTool`'s getFlag used to
		// be built ONCE at module load via `createMcpHost().getFlag` (defaulting
		// to the server's own launch directory), so a project-config-gated flag
		// consulted through that tool could never see the CALLER's project. The
		// fix rebuilds the host per call: `(name, cwd) =>
		// createMcpHost(undefined, cwd).getFlag(name)`. This test pins that a
		// getFlag built this way resolves against whichever project root a given
		// call passes, not whatever directory happened to be current when the
		// closure was first created.
		const projectA = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mcp-cwd-a-"),
		);
		const projectB = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mcp-cwd-b-"),
		);
		try {
			fs.writeFileSync(
				path.join(projectA, ".pi-lens.json"),
				JSON.stringify({ autofix: { enabled: false } }),
			);
			// projectB has no .pi-lens.json — no project override.

			const getFlag = (name: string, cwd?: string) =>
				createMcpHost(undefined, cwd).getFlag(name);

			expect(getFlag("no-autofix", projectA)).toBe(true);
			expect(getFlag("no-autofix", projectB)).toBe(false);
		} finally {
			fs.rmSync(projectA, { recursive: true, force: true });
			fs.rmSync(projectB, { recursive: true, force: true });
		}
	});

	it("resolves mutation flags from project config", () => {
		const projectRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mcp-project-config-"),
		);
		try {
			fs.writeFileSync(
				path.join(projectRoot, ".pi-lens.json"),
				JSON.stringify({
					format: { enabled: false },
					autofix: { enabled: false },
					actionableWarnings: { autoFix: { enabled: false } },
				}),
			);
			const host = createMcpHost(undefined, projectRoot);

			expect(host.getFlag("no-autoformat")).toBe(true);
			expect(host.getFlag("no-autofix")).toBe(true);
			expect(host.getFlag("lens-actionable-warning-autofix")).toBe(false);
		} finally {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
