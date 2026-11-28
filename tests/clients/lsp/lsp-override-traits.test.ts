import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-override-traits-"),
	);
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	const trust = await import("../../../clients/project-trust.js");
	trust.resetProjectTrust();
});

/**
 * #4833: the real path. A `.pi-lens.json` that overrides EVERY catalog row's
 * command, read by `loadLSPConfig` and compiled by `compileLspRegistry`. The
 * recurrence is #4829's `resendRecheck`: a measured trait of the catalog binary
 * rode the `{...server}` copy onto another binary.
 */
async function compileEveryOverride() {
	const { LSP_SERVERS } = await import("../../../clients/lsp/server.js");
	const project = tempDir();
	fs.writeFileSync(
		path.join(project, ".pi-lens.json"),
		JSON.stringify({
			lsp: {
				serverOverrides: Object.fromEntries(
					LSP_SERVERS.map((server) => [
						server.id,
						{ command: [`other-${server.id}-lsp`, "--stdio"] },
					]),
				),
			},
		}),
	);
	const trust = await import("../../../clients/project-trust.js");
	trust.setProjectTrustState("trusted");
	const { loadLSPConfig, compileLspRegistry } =
		await import("../../../clients/lsp/config.js");
	const config = await loadLSPConfig(project);
	const copies = compileLspRegistry(
		config,
		config.__provenance,
	).registeredServers;
	return {
		LSP_SERVERS,
		project,
		copies: new Map(copies.map((c) => [c.id, c])),
	};
}

describe("a command override keeps only the traits it is allowed to (#4833)", () => {
	it("resets every optimistic measured claim of the catalog binary", async () => {
		const { LSP_SERVERS, copies } = await compileEveryOverride();
		// Non-vacuous: the catalog must actually carry the measured values, or
		// the loop below passes on a catalog that lost them.
		expect(
			LSP_SERVERS.filter((s) => s.idleEviction === "transparent").length,
		).toBeGreaterThanOrEqual(10);
		expect(
			LSP_SERVERS.filter((s) => s.replyOrdering !== undefined).length,
		).toBeGreaterThanOrEqual(1);
		expect(
			LSP_SERVERS.filter((s) => s.autoPropagateDiagnostics === true).length,
		).toBeGreaterThanOrEqual(1);
		expect(
			LSP_SERVERS.filter((s) => s.resendRecheck !== undefined).length,
		).toBeGreaterThanOrEqual(1);

		for (const server of LSP_SERVERS) {
			const copy = copies.get(server.id);
			expect(copy, server.id).toBeDefined();
			expect(copy, server.id).not.toBe(server);
			expect(copy?.idleEviction, `${server.id} idleEviction`).toBe(
				"unmeasured",
			);
			expect(copy?.orphanProcess, `${server.id} orphanProcess`).toBeUndefined();
			expect(copy?.replyOrdering, `${server.id} replyOrdering`).toBeUndefined();
			expect(copy?.resendRecheck, `${server.id} resendRecheck`).toBeUndefined();
			expect(
				copy?.autoPropagateDiagnostics,
				`${server.id} autoPropagateDiagnostics`,
			).toBeUndefined();
			expect(copy?.autoInstall, `${server.id} autoInstall`).toBeUndefined();
		}
	});

	it("keeps routing identity, protective guards and wait budgets", async () => {
		const { LSP_SERVERS, copies } = await compileEveryOverride();
		for (const server of LSP_SERVERS) {
			const copy = copies.get(server.id);
			expect(copy?.name, server.id).toBe(server.name);
			expect(copy?.extensions, server.id).toBe(server.extensions);
			expect(copy?.role, server.id).toBe(server.role);
			expect(copy?.root, server.id).toBe(server.root);
			expect(copy?.rootMarkers, server.id).toBe(server.rootMarkers);
			expect(copy?.fallbackFor, server.id).toBe(server.fallbackFor);
			expect(copy?.pathFilter, server.id).toBe(server.pathFilter);
			expect(copy?.trustAllowed, server.id).toBe(true);
		}
		const kept = (id: string) => ({
			catalog: LSP_SERVERS.find((s) => s.id === id)!,
			copy: copies.get(id)!,
		});
		// ast-grep declares the tightest notify ceiling and a 15 s initialize.
		expect(kept("ast-grep").catalog.notifyInflightLimit).toBe(4);
		expect(kept("ast-grep").copy.notifyInflightLimit).toBe(4);
		expect(kept("ast-grep").copy.initializeTimeoutMs).toBe(15000);
		// Ruby LSP's composed-bundle bootstrap budget.
		expect(kept("ruby").catalog.initializeTimeoutMs).toBe(30_000);
		expect(kept("ruby").copy.initializeTimeoutMs).toBe(30_000);
		expect(kept("ruby").copy.clientWaitTimeoutMs).toBe(30_000);
		// Protective guards keep declining.
		expect(kept("opengrep").catalog.looseFileRoot).toBe("decline");
		expect(kept("opengrep").copy.looseFileRoot).toBe("decline");
		const projectCode = LSP_SERVERS.filter((s) => s.executesProjectCode);
		expect(projectCode.length).toBeGreaterThanOrEqual(1);
		for (const server of projectCode) {
			expect(copies.get(server.id)?.executesProjectCode, server.id).toBe(true);
		}
		const needsProject = LSP_SERVERS.filter((s) => s.spawnNeedsProjectFile);
		expect(needsProject.length).toBeGreaterThanOrEqual(1);
		for (const server of needsProject) {
			expect(copies.get(server.id)?.spawnNeedsProjectFile, server.id).toBe(
				true,
			);
		}
		// #4758: the settings section stays with the server across `spawn`.
		const withSection = LSP_SERVERS.filter((s) => s.settingsSection);
		expect(withSection.length).toBeGreaterThanOrEqual(1);
		for (const server of withSection) {
			expect(copies.get(server.id)?.settingsSection, server.id).toBe(
				server.settingsSection,
			);
		}
	});
});
