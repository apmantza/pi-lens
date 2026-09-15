import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	setProjectTrustState,
	resetProjectTrust,
} from "../../clients/project-trust.js";
import { setupTestEnvironment } from "./test-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const { safeSpawnAsync } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(async () => ({ status: 0, stdout: "", stderr: "" })),
}));
const notifyUserDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));
vi.mock("../../clients/user-notify.js", () => ({ notifyUserDegradation }));

beforeEach(() => {
	resetDegradationLedger();
	safeSpawnAsync.mockClear();
	notifyUserDegradation.mockClear();
});
afterEach(() => resetProjectTrust());

describe("central project-trust install gate (#1334 review)", () => {
	it("gates formatter gem/rustup lazy installs and permits them when trusted", async () => {
		const { tryLazyInstallFormatterTool } =
			await import("../../clients/formatters.js");
		setProjectTrustState("untrusted");
		expect(
			await tryLazyInstallFormatterTool("rubocop", "/trust/fmt-blocked"),
		).toBe(false);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		setProjectTrustState("trusted");
		expect(
			await tryLazyInstallFormatterTool("rubocop", "/trust/fmt-allowed"),
		).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"gem",
			expect.any(Array),
			expect.any(Object),
		);
	});

	it("treats an install-capable formatter npx fallback as a trust-gated skip", async () => {
		const env = setupTestEnvironment("pi-lens-trust-npx-");
		try {
			const file = path.join(env.tmpDir, "x.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			// #3005 fixture recurrence: reach the trust gate with established
			// formatter agreement; absent evidence is a separate unavailable path.
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
			);
			fs.writeFileSync(
				path.join(env.tmpDir, "package-lock.json"),
				JSON.stringify({
					lockfileVersion: 3,
					packages: { "": {}, "node_modules/prettier": { version: "3.0.0" } },
				}),
			);
			const { formatFile } = await import("../../clients/formatters.js");
			const formatter = {
				name: "prettier",
				command: ["npx", "pkg", "$FILE"],
				extensions: [".ts"],
				async detect() {
					return true;
				},
			};
			setProjectTrustState("untrusted");
			// #2413: a trust-gated npx refusal is a `skipped` outcome, NOT
			// `unavailable` — the tool is not proven absent; npx could install it
			// once the project is trusted, so this may converge next turn.
			expect(await formatFile(file, formatter)).toEqual({
				success: true,
				changed: false,
				outcome: "skipped",
			});
			// #1366 review: ONE ledger entry per user-visible degradation — the
			// trust seam records it (with the formatter context); the formatter
			// site must not add a second kind for the same event.
			const summary = getDegradationSummary();
			expect(summary).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "trust-refusal", count: 1 }),
				]),
			);
			expect(summary.find((g) => g.kind === "formatter-skip")).toBeUndefined();
			expect(safeSpawnAsync).not.toHaveBeenCalled();
			setProjectTrustState("trusted");
			await formatFile(file, formatter);
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"npx",
				expect.any(Array),
				expect.any(Object),
			);
		} finally {
			env.cleanup();
		}
	});

	it("gates the runner lazy-installer seam and permits it when trusted", async () => {
		const { tryLazyInstall } =
			await import("../../clients/dispatch/runners/utils/lazy-installer.js");
		setProjectTrustState("untrusted");
		expect(await tryLazyInstall("rust-clippy", "/trust/lazy-blocked")).toBe(
			false,
		);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		setProjectTrustState("trusted");
		expect(await tryLazyInstall("rust-clippy", "/trust/lazy-allowed")).toBe(
			true,
		);
		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"rustup",
			expect.any(Array),
			expect.any(Object),
		);
	});

	// #1350 delta review: trust denial must NOT latch available=false -- a
	// later grant (turn_start re-adoption) retries the install.
	it("govulncheck retries after a trust grant (denial is not sticky)", async () => {
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const { setProjectTrustState } =
			await import("../../clients/project-trust.js");
		const client = new GovulncheckClient() as any;
		vi.spyOn(client, "probeVersion").mockResolvedValue(false);
		setProjectTrustState("untrusted");
		expect(await client.doEnsureAvailable()).toBe(false);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		// SAME instance: the denial must not have latched available=false, so a
		// later trust grant (turn_start re-adoption) re-attempts the install.
		setProjectTrustState("trusted");
		await client.ensureAvailable();
		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"go",
			["version"],
			expect.any(Object),
		);
	});

	it("gates govulncheck go install and permits it when trusted", async () => {
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const blocked = new GovulncheckClient() as any;
		vi.spyOn(blocked, "probeVersion").mockResolvedValue(false);
		setProjectTrustState("untrusted");
		expect(await blocked.doEnsureAvailable()).toBe(false);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		const allowed = new GovulncheckClient() as any;
		vi.spyOn(allowed, "probeVersion").mockResolvedValue(false);
		setProjectTrustState("trusted");
		await allowed.doEnsureAvailable();
		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"go",
			["version"],
			expect.any(Object),
		);
	});

	it("gates missing grammar fetches and notifies, while trusted reaches fetch", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("no", { status: 404 }));
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient() as any;
		setProjectTrustState("untrusted");
		expect(await client.ensureGrammar("tree-sitter-trust-missing.wasm")).toBe(
			false,
		);
		expect(await client.ensureGrammar("tree-sitter-trust-missing.wasm")).toBe(
			false,
		);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		expect(getDegradationSummary()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "grammar-blocked", count: 2 }),
			]),
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		// #1363 delta: dedupe is generation-lazy, not permanent -- a trust
		// TRANSITION re-arms the notification for the same grammar.
		setProjectTrustState("trusted");
		setProjectTrustState("untrusted");
		expect(await client.ensureGrammar("tree-sitter-trust-missing.wasm")).toBe(
			false,
		);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(2);
		setProjectTrustState("trusted");
		await client.ensureGrammar("tree-sitter-trust-allowed.wasm");
		expect(fetchSpy).toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
