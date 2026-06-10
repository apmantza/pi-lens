/**
 * Guards LSPService.getAllDiagnostics' prune step (#197): it must drop
 * diagnostics for files that no longer exist on disk (and TTL-stale ones),
 * using an ASYNC existence check (was a blocking existsSync per file inside the
 * prune predicate). Behavior must be identical to the sync version — a file is
 * pruned iff it's missing OR older than the cascade TTL — only now the FS work
 * happens off the event loop. We inject a minimal fake client into the service
 * so we can exercise the real getAllDiagnostics without spawning a server.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

type Entry = { diags: LSPDiagnostic[]; ts: number };

function makeFakeClient(initial: Map<string, Entry>) {
	const store = new Map(initial);
	return {
		store,
		getTrackedDiagnosticPaths: () => [...store.keys()],
		pruneDiagnostics: (
			predicate: (filePath: string, ts: number, diags: LSPDiagnostic[]) => boolean,
		) => {
			let removed = 0;
			for (const [key, value] of [...store]) {
				if (predicate(key, value.ts, value.diags)) {
					store.delete(key);
					removed++;
				}
			}
			return removed;
		},
		getAllDiagnostics: () => new Map(store),
	};
}

let dir: string;
let existingPath: string;
let missingPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-lens-prune-"));
	existingPath = normalizeMapKey(join(dir, "exists.ts"));
	missingPath = normalizeMapKey(join(dir, "gone.ts"));
	writeFileSync(existingPath, "export const a = 1;\n");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("LSPService.getAllDiagnostics prune (#197 async existence)", () => {
	it("prunes diagnostics for a missing file but keeps a fresh existing file", async () => {
		const now = Date.now();
		const fake = makeFakeClient(
			new Map<string, Entry>([
				[existingPath, { diags: [], ts: now }],
				[missingPath, { diags: [], ts: now }],
			]),
		);

		const svc = new LSPService();
		// state is private; inject the fake client to drive the real prune path.
		(svc as unknown as { state: { clients: Map<string, unknown> } }).state.clients.set(
			"fake:root",
			fake,
		);

		await svc.getAllDiagnostics();

		// The missing file was pruned via the async existence check; the existing,
		// non-stale file was retained.
		expect(fake.store.has(missingPath)).toBe(false);
		expect(fake.store.has(existingPath)).toBe(true);
	});

	it("prunes a TTL-stale entry even when the file still exists", async () => {
		const stale = Date.now() - 1000 * 60 * 60 * 24; // 24h ago, well past TTL
		const fake = makeFakeClient(
			new Map<string, Entry>([[existingPath, { diags: [], ts: stale }]]),
		);

		const svc = new LSPService();
		(svc as unknown as { state: { clients: Map<string, unknown> } }).state.clients.set(
			"fake:root",
			fake,
		);

		await svc.getAllDiagnostics();

		expect(fake.store.has(existingPath)).toBe(false);
	});
});
