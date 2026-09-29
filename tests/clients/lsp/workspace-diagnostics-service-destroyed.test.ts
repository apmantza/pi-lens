/**
 * #1618: `handleTurnEnd` (clients/runtime-turn.ts) arms a detached 240s
 * `scheduleLSPIdleReset` on any file-less turn. Nothing previously stopped
 * that timer from firing WHILE a `lens_diagnostics mode=full` sweep
 * (`LSPService.runWorkspaceDiagnostics`) was still in flight — the timer
 * called `resetLSPService`, which tears down the very service the sweep was
 * touching, and every file the sweep had not yet reached failed with a bare
 * `timedOut: true` indistinguishable from a real budget timeout.
 *
 * This drives a real `runWorkspaceDiagnostics` sweep over five files and
 * calls the real `resetLSPService({ reason: "idle" })` mid-sweep (from
 * inside the third file's `waitForDiagnostics` resolution — the same shape
 * as the detached timer firing while `touchFile` is in flight). The files
 * the sweep had not yet reached must come back with the discriminated
 * `unconfirmedReason: "service_destroyed"` — never a bare `timedOut` that
 * reads identically to a budget timeout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeTsServer(root: string) {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

describe("runWorkspaceDiagnostics — service destroyed mid-sweep (#1618)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wsd-destroyed-"));
	});
	afterEach(() => removeTempDirSync(tmp));

	it("marks every file after the destroy point as service_destroyed, never a bare timedOut", async () => {
		const fileNames = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
		for (const name of fileNames) {
			fs.writeFileSync(path.join(tmp, name), "const x = 1;\n");
		}
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);

		const { resetLSPService } = await import("../../../clients/lsp/index.js");

		// The project walk's admission order isn't guaranteed to be alphabetical
		// (raw directory-read order), and the sweep's own pre-loop warm-up
		// (#667's `ensureWarmForSweep`) pays one extra touch against the first
		// file before the real per-file loop starts — so this destroys on the
		// THIRD `waitForDiagnostics` call, whichever file(s) that resolves to,
		// rather than assuming a fixed file/index.
		const DESTROY_AFTER_CALLS = 3;
		let waitCalls = 0;
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			getAdvertisedCommands: () => [],
			getRawCapabilityKeys: () => [],
			serverId: "typescript",
			root: tmp,
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async () => {
				waitCalls += 1;
				if (waitCalls === DESTROY_AFTER_CALLS) {
					// Same shape as the detached idle-reset timer firing while this
					// sweep is in flight: tears down the singleton `LSPService` the
					// sweep is actively touching.
					resetLSPService({ reason: "idle" });
				}
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		};
		createLSPClient.mockResolvedValue(client);

		const { getLSPService } = await import("../../../clients/lsp/index.js");
		const service = getLSPService();
		const results = await service.runWorkspaceDiagnostics(tmp, {});

		expect(results.length).toBe(5);
		const destroyed = results.filter(
			(r) => r.unconfirmedReason === "service_destroyed",
		);
		const notDestroyed = results.filter(
			(r) => r.unconfirmedReason !== "service_destroyed",
		);
		// The sweep must have stopped for AT LEAST one file — otherwise this
		// test proves nothing about the destroy-mid-sweep path.
		expect(destroyed.length).toBeGreaterThan(0);
		// Every file the sweep never reached is explicitly service_destroyed —
		// never a bare `timedOut: true` that a caller could confuse with a
		// budget timeout.
		for (const result of destroyed) {
			expect(result.timedOut).toBe(true);
			expect(result.error).toBeUndefined();
		}
		// Files the sweep confirmed before the destroy point must NOT carry
		// the destroyed reason (they completed a real touch).
		for (const result of notDestroyed) {
			expect(result.unconfirmedReason).not.toBe("service_destroyed");
		}
	});
});
