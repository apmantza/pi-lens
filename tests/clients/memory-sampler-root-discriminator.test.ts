// flake-shape: real-process-spawn — Real child transport and lifecycle are the subject; a process stub cannot exercise the wire and teardown behavior.
/**
 * #2130: `memory_sample` must be attributable to a root.
 *
 * Two gaps the live forensics exposed on a multi-root host:
 *  - `subsystems.lsp.clients` is a bare count. Two live tsservers could mean
 *    one root running two servers or one host serving two roots, and nothing
 *    in the record said which — so the sample could not be reconciled against
 *    `instances.json`'s `lspChildCount`.
 *  - `turnIndex` restarts at 0 on every session reset, so one host emitted
 *    `turnIndex: 10` twice with no discriminator between the two roots.
 *
 * Both are covered here with REAL clients against the fake LSP server: a
 * mocked state never enters `activeLspClients`, so a mock would report 0
 * whether the plumbing works or not.
 */

import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { createLSPClient } from "../../clients/lsp/client.js";
import { stopLSP } from "../../clients/lsp/launch.js";
import {
	buildMemorySample,
	collectMemorySampleSubsystems,
} from "../../clients/memory-sampler.js";
import { spawnFakeLspServer } from "../support/fake-lsp-server.js";

function fakeMem(): NodeJS.MemoryUsage {
	return {
		rss: 100 * 1024 * 1024,
		heapTotal: 50 * 1024 * 1024,
		heapUsed: 25 * 1024 * 1024,
		external: 1024,
		arrayBuffers: 512,
	};
}

async function spawnClientAt(root: string, serverId: string) {
	const proc = await spawnFakeLspServer({
		cwd: root,
		env: { ...process.env },
	});
	const client = await createLSPClient({ serverId, process: proc, root });
	return { client, proc };
}

describe("memory_sample root discriminator (#2130)", () => {
	it("reports the DISTINCT root count across live clients, not just a total", async () => {
		const rootA = process.cwd();
		const rootB = os.tmpdir();
		const a = await spawnClientAt(rootA, "mem-root-a");
		const b = await spawnClientAt(rootB, "mem-root-b");
		try {
			const subsystems = collectMemorySampleSubsystems(null);
			// Both clients are visible...
			expect(subsystems.lsp.clients).toBeGreaterThanOrEqual(2);
			// ...and the record now says they span two roots, which is what makes
			// the count reconcilable against instances.json's projectRoots.
			expect(subsystems.lsp.clientRoots).toBeGreaterThanOrEqual(2);
		} finally {
			await a.client.shutdown().catch(() => {});
			await stopLSP(a.proc).catch(() => {});
			await b.client.shutdown().catch(() => {});
			await stopLSP(b.proc).catch(() => {});
		}
	}, 20_000);

	it("two clients in ONE root report one root, not two", async () => {
		// Mutation guard on the distinct-root Set: a `clientRoots` that simply
		// mirrored `clients` would pass the test above and fail here.
		const root = process.cwd();
		const a = await spawnClientAt(root, "mem-same-root-a");
		const b = await spawnClientAt(root, "mem-same-root-b");
		try {
			const subsystems = collectMemorySampleSubsystems(null);
			expect(subsystems.lsp.clients).toBeGreaterThanOrEqual(2);
			expect(subsystems.lsp.clientRoots).toBe(1);
		} finally {
			await a.client.shutdown().catch(() => {});
			await stopLSP(a.proc).catch(() => {});
			await b.client.shutdown().catch(() => {});
			await stopLSP(b.proc).catch(() => {});
		}
	}, 20_000);

	it("session context carries the root that owns this turnIndex", () => {
		const sample = buildMemorySample(null, fakeMem(), undefined, {
			sessionAgeMs: 1000,
			sessionStartedAt: 1,
			turnCount: 10,
			root: "/repo/plegma",
		});
		expect(sample.session?.root).toBe("/repo/plegma");
	});

	it("an absent root stays absent — never guessed from process.cwd()", () => {
		const sample = buildMemorySample(null, fakeMem(), undefined, {
			sessionAgeMs: 1000,
			sessionStartedAt: 1,
			turnCount: 10,
		});
		expect(sample.session?.root).toBeUndefined();
	});
});
