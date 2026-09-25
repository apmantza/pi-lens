/**
 * Analyzer-bootstrap warm/first-use liveness — #2467, extending #1394.
 *
 * The #1394 lesson this file exists for: a lazified subsystem that silently
 * stops firing is worse than a slow one. So every "did NOT load" assertion
 * here is paired with a "still loads when a consumer needs it" assertion
 * against the same seam, and both run through `index.ts`'s real registrations
 * — the extension the host actually activates, not a hand-built handler.
 *
 * The seam is spied rather than replaced: the double resolves the same client
 * set through the same loader, so a case cannot pass because the double
 * quietly answered differently from production.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import { removeTempDirSync } from "./test-utils.js";

/** Every demand made on the bootstrap seam, in order, with its stated reason. */
const demands: string[] = [];

/**
 * The demands that were actually SERVED with clients.
 *
 * A demand that answers `null` still appears in `demands` — the caller asked
 * — but the analyzers behind it never ran. Distinguishing the two is the
 * whole point of #1394's lesson: "the scan was requested" and "the scan
 * happened" are different facts, and only the second one is liveness.
 */
const served: string[] = [];

/** Stub clients that answer "nothing available" for every analyzer. */
function stubClients(): Record<string, unknown> {
	return {
		metricsClient: { reset: () => {} },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		biomeClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		knipClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			analyze: async () => ({ success: false, summary: "", issues: [] }),
		},
		jscpdClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		govulncheckClient: { ensureAvailable: async () => false },
		gitleaksClient: { ensureAvailable: async () => false },
		trivyClient: { ensureAvailable: async () => false },
		opengrepClient: { ensureAvailable: async () => false },
		deadCodeClients: [],
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: { recordToolCall: () => [], formatWarnings: () => "" },
		complexityClient: {
			// Supported, so the tool_call baseline branch is genuinely armed: a
			// double that answered "unsupported" would make the liveness case
			// pass without the branch ever asking for a client.
			isSupportedFile: (file: string) => file.endsWith(".ts"),
			analyzeFile: async () => null,
		},
	};
}

/** Install the counting seam and load a fresh `index.ts` behind it. */
async function activateWithSpiedBootstrap(): Promise<
	ReturnType<typeof createPiMock>
> {
	vi.resetModules();
	demands.length = 0;
	served.length = 0;
	vi.doMock("../../clients/bootstrap.js", async () => {
		const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
		const seam = bootstrapSeamMock(async () => stubClients());
		return {
			...seam,
			loadBootstrapClients: () => {
				demands.push("load");
				return seam.loadBootstrapClients();
			},
			requestBootstrapClients: async (options?: {
				reason?: string;
				signal?: AbortSignal;
			}) => {
				const reason = options?.reason ?? "?";
				demands.push(`request:${reason}`);
				// The double honours the signal exactly as production does, so a
				// caller that binds the wrong one is visible HERE rather than
				// only in production.
				const clients = await seam.requestBootstrapClients(
					options as { reason: string; signal?: AbortSignal },
				);
				if (clients) served.push(reason);
				return clients;
			},
		};
	});
	// The concurrent-session registry lives behind `getProcessSingleton`, so
	// `vi.resetModules()` does NOT clear it (AGENTS.md shape 25). Without this,
	// the second case's session_start in a different temp cwd classifies
	// `secondary-root`, declines, and never runs the handler at all — every
	// "did not load" assertion would then pass for the wrong reason.
	const { _resetSessionLifecycleForTests } =
		await import("../../clients/session-lifecycle.js");
	_resetSessionLifecycleForTests();
	const { default: registerExtension } = await import("../../index.js");
	const pi = createPiMock({ "no-autoformat": true, "no-lsp": true });
	registerExtension(pi.asExtensionAPI());
	return pi;
}

afterEach(() => {
	delete process.env.PI_LENS_STARTUP_MODE;
	// resetModules does not clear the mock registry (#2883).
	vi.doUnmock("../../clients/bootstrap.js");
	vi.resetModules();
});

describe("#2467 — activation never loads the analyzer bootstrap", () => {
	it("registers every host surface without one demand on the seam", async () => {
		const pi = await activateWithSpiedBootstrap();
		// The registrations really happened — otherwise "no demands" would be
		// satisfied by an activation that did nothing at all (shape 7).
		expect(pi.tools.size).toBeGreaterThan(0);
		expect(pi.handlers.size).toBeGreaterThan(0);
		expect(demands).toEqual([]);
	}, 30_000);
});

describe("#2467 — session start pays only for what it uses", () => {
	it("quick mode completes without loading the analyzer graph", async () => {
		process.env.PI_LENS_STARTUP_MODE = "quick";
		const pi = await activateWithSpiedBootstrap();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2467-quick-"));
		try {
			await pi.emit("session_start", {}, makeCtx({ cwd }));
			// Quick mode is the process's FIRST session — the start the user is
			// waiting on — and it uses none of these clients.
			expect(demands).toEqual([]);
		} finally {
			removeTempDirSync(cwd);
		}
	}, 30_000);

	it("full mode still reaches the analyzers, on demand", async () => {
		process.env.PI_LENS_STARTUP_MODE = "full";
		const pi = await activateWithSpiedBootstrap();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2467-full-"));
		fs.writeFileSync(path.join(cwd, "index.ts"), "export const a = 1;\n");
		try {
			await pi.emit("session_start", {}, makeCtx({ cwd }));
			// The liveness half: lazification must not mean "never".
			expect(demands.some((d) => d.startsWith("request:session-start"))).toBe(
				true,
			);
		} finally {
			removeTempDirSync(cwd);
		}
	}, 60_000);
});

describe("#2467 — session-start demands are not turn-scoped", () => {
	it("a leftover aborted turn signal does not cancel the startup scans", async () => {
		process.env.PI_LENS_STARTUP_MODE = "full";
		const pi = await activateWithSpiedBootstrap();
		// A `session_start` can land mid-turn (sequential replacement, /new), so
		// the ambient signal of the turn that is being torn down is still
		// installed when the handler runs. Binding it to the deferred scans
		// meant the whole session silently ran with no todo/dead-code/knip/jscpd
		// scan and no retry — #1394's exact lesson.
		const { setAmbientAbortSignal } =
			await import("../../clients/safe-spawn.js");
		const stale = new AbortController();
		stale.abort();
		setAmbientAbortSignal(stale.signal);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2467-stale-"));
		fs.writeFileSync(path.join(cwd, "index.ts"), "export const a = 1;\n");
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ name: "stale-signal-fixture", version: "0.0.0" }),
		);
		try {
			await pi.emit("session_start", {}, makeCtx({ cwd }));
			// Not merely "the demand was made" — EVERY demand was SERVED, so the
			// scan and probe bodies behind them actually ran. Pre-fix the demands
			// are identical and `served` is empty: the aborted signal made every
			// one of them answer `null`, and nothing retries.
			const requested = demands
				.filter((d) => d.startsWith("request:"))
				.map((d) => d.slice("request:".length));
			expect(requested.length).toBeGreaterThan(0);
			expect(served).toEqual(requested);
			expect(served).toContain("session-start-tool-probes");
		} finally {
			setAmbientAbortSignal(undefined);
			removeTempDirSync(cwd);
		}
	}, 60_000);
});

describe("#2467 — tool_call loads only for a branch that needs it", () => {
	it("an irrelevant tool call neither loads nor awaits the graph", async () => {
		process.env.PI_LENS_STARTUP_MODE = "quick";
		const pi = await activateWithSpiedBootstrap();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2467-bash-"));
		try {
			await pi.emit("session_start", {}, makeCtx({ cwd }));
			await pi.emit("turn_start", {}, makeCtx({ cwd }));
			demands.length = 0;
			await pi.emit(
				"tool_call",
				{ toolName: "bash", input: { command: "echo hi" } },
				makeCtx({ cwd }),
			);
			expect(demands).toEqual([]);
		} finally {
			removeTempDirSync(cwd);
		}
	}, 30_000);

	it("a read of a vendored file neither loads nor awaits the graph", async () => {
		process.env.PI_LENS_STARTUP_MODE = "quick";
		const pi = await activateWithSpiedBootstrap();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2467-vendor-"));
		// A `node_modules` read is the shape the pre-fix code paid the whole
		// seventeen-module load for and then threw away: `isExternalOrVendor` is
		// the very next check after the load it used to sit above. The bash case
		// above returns before that point, so it cannot see this defect at all.
		const vendorDir = path.join(cwd, "node_modules", "left-pad");
		fs.mkdirSync(vendorDir, { recursive: true });
		const filePath = path.join(vendorDir, "index.ts");
		fs.writeFileSync(filePath, "export const pad = 1;\n");
		try {
			await pi.emit("session_start", {}, makeCtx({ cwd }));
			await pi.emit("turn_start", {}, makeCtx({ cwd }));
			demands.length = 0;
			await pi.emit(
				"tool_call",
				{ toolName: "read", input: { path: filePath } },
				makeCtx({ cwd }),
			);
			expect(demands).toEqual([]);
		} finally {
			removeTempDirSync(cwd);
		}
	}, 30_000);

	it("a read of an unsupported file type never demands the graph", async () => {
		process.env.PI_LENS_STARTUP_MODE = "quick";
		const pi = await activateWithSpiedBootstrap();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2467-md-"));
		// A markdown read resolves to a real, in-project, non-vendored path, so
		// every cheap guard admits it — and then the complexity client answers
		// "unsupported" and no baseline is ever produced. Because a baseline is
		// what memoizes the file, the demand fires again on EVERY later read of
		// it. Docs, JSON, YAML, CSS, Java, shell: the whole non-analyzed
		// majority of a repo used to pay the seventeen-module load per read.
		const filePath = path.join(cwd, "README.md");
		fs.writeFileSync(filePath, "# readme\n");
		try {
			await pi.emit("session_start", {}, makeCtx({ cwd }));
			await pi.emit("turn_start", {}, makeCtx({ cwd }));
			demands.length = 0;
			await pi.emit(
				"tool_call",
				{ toolName: "read", input: { path: filePath } },
				makeCtx({ cwd }),
			);
			// Twice, because the never-cached half of the defect only shows on
			// the second read.
			await pi.emit(
				"tool_call",
				{ toolName: "read", input: { path: filePath } },
				makeCtx({ cwd }),
			);
			expect(demands).toEqual([]);
		} finally {
			removeTempDirSync(cwd);
		}
	}, 30_000);

	it("a bootstrap-dependent tool call does demand the clients", async () => {
		process.env.PI_LENS_STARTUP_MODE = "quick";
		const pi = await activateWithSpiedBootstrap();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2467-read-"));
		const filePath = path.join(cwd, "sample.ts");
		fs.writeFileSync(filePath, "export const sample = 1;\n");
		try {
			await pi.emit("session_start", {}, makeCtx({ cwd }));
			await pi.emit("turn_start", {}, makeCtx({ cwd }));
			demands.length = 0;
			await pi.emit(
				"tool_call",
				{ toolName: "read", input: { path: filePath } },
				makeCtx({ cwd }),
			);
			expect(demands).toContain("request:tool-call-complexity-baseline");
		} finally {
			removeTempDirSync(cwd);
		}
	}, 30_000);
});
