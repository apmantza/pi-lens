// flake-shape: real-process-spawn — live-client accounting is read from real clients registered across module evaluations; a stubbed process never enters that registry
/**
 * #2130 criterion 2: `memory_sample.subsystems.lsp.clients` must count every
 * live client, including the ones running under a SECONDARY root.
 *
 * The live symptom was a host reporting `clients: 1` while its own
 * `instances.json` entry listed `lspChildCount: 2` with two tsservers alive.
 * The registry set of `activeLspClients` is what the sampler reads, and it was
 * a module-scope `Set`. pi evaluates the pi-lens module graph up to nine times
 * per process (#2146, measured `host_boot` = 9), and each evaluation builds its
 * own `LSPService` and therefore its own fleet — usually one per root, since a
 * secondary root's session binds through a later evaluation. The sampler runs
 * in ONE evaluation, so it counted one evaluation's clients and the other
 * root's servers were invisible.
 *
 * These tests drive the real seam: two evaluations of `client.js`, one live
 * client each, under two different roots, and the snapshot read from the FIRST
 * evaluation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stopLSP } from "../../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";

type ClientModule = typeof import("../../../clients/lsp/client.js");

describe("live client accounting spans module evaluations (#2130)", () => {
	const cleanups: Array<() => Promise<void>> = [];
	const dirs: string[] = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
		for (const dir of dirs.splice(0)) removeTempDirSync(dir);
		vi.resetModules();
	});

	function makeRoot(tag: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-${tag}-`));
		dirs.push(dir);
		return dir;
	}

	async function spawnClient(mod: ClientModule, root: string): Promise<void> {
		const proc = await spawnFakeLspServer({
			cwd: root,
			env: { ...process.env, FAKE_LSP_SYNC_KIND: "2" },
		});
		const client = await mod.createLSPClient({
			serverId: `fake-${path.basename(root)}`,
			process: proc,
			root,
		});
		cleanups.push(async () => {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		});
	}

	it("a snapshot taken in evaluation 1 counts evaluation 2's client and its root", async () => {
		const first =
			(await import("../../../clients/lsp/client.js")) as ClientModule;
		const before = first.getLspDocumentTextRetentionSnapshot();

		const rootA = makeRoot("cliroot-a");
		await spawnClient(first, rootA);

		vi.resetModules();
		const second =
			(await import("../../../clients/lsp/client.js")) as ClientModule;
		// A genuinely separate evaluation — otherwise this test proves nothing
		// about cross-evaluation visibility.
		expect(second).not.toBe(first);

		const rootB = makeRoot("cliroot-b");
		await spawnClient(second, rootB);

		// Read from the FIRST evaluation, which is where the memory sampler that
		// reported `clients: 1` was running.
		const snapshot = first.getLspDocumentTextRetentionSnapshot();
		expect(snapshot.clients).toBe(before.clients + 2);
		expect(snapshot.roots).toBe(before.roots + 2);

		// And both evaluations agree, so no caller depends on which one asks.
		expect(second.getLspDocumentTextRetentionSnapshot().clients).toBe(
			snapshot.clients,
		);
	}, 30_000);

	it("a client shut down in evaluation 2 stops being counted in evaluation 1", async () => {
		// Mutation guard on the shared registry's DELETE side: sharing the add
		// site without sharing the delete site would grow a set that never
		// shrinks, which is a worse leak than the undercount it replaced.
		const first =
			(await import("../../../clients/lsp/client.js")) as ClientModule;
		const before = first.getLspDocumentTextRetentionSnapshot();

		vi.resetModules();
		const second =
			(await import("../../../clients/lsp/client.js")) as ClientModule;

		const rootB = makeRoot("cliroot-gone");
		const proc = await spawnFakeLspServer({
			cwd: rootB,
			env: { ...process.env, FAKE_LSP_SYNC_KIND: "2" },
		});
		const client = await second.createLSPClient({
			serverId: "fake-gone",
			process: proc,
			root: rootB,
		});
		expect(first.getLspDocumentTextRetentionSnapshot().clients).toBe(
			before.clients + 1,
		);

		await client.shutdown().catch(() => {});
		await stopLSP(proc).catch(() => {});

		await vi.waitFor(
			() => {
				expect(first.getLspDocumentTextRetentionSnapshot().clients).toBe(
					before.clients,
				);
			},
			{ timeout: 5000 },
		);
	}, 30_000);
});
