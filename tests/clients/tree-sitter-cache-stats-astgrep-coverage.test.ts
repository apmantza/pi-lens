import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeSitterParseCacheStats } from "../../clients/tree-sitter-client.js";

// #1982: every `cache_stats` record must carry the `astGrep` sub-field
// ({durationMs, fileCount}). A caller that runs an ast-grep pass reports the
// real cost there (and subtracts it from `durationMs`, per the logger
// contract); a caller whose scope never runs ast-grep reports zeros. Either
// way the field must be PRESENT — its absence is how all 224 production
// records shipped with `astGrep: undefined` (#1982).
//
// Registered-or-fail: this static sweep enumerates EVERY production call site
// of `logTreeSitterCacheStats({` under clients/ and requires each options
// object to carry `astGrep:` inline. A new scan scope cannot ship without the
// sub-field — omitting it fails this test (and tsc, which enforces the same
// contract through the required option type). There are no exemptions on
// purpose: explicit zeros are honest and keep every record uniformly
// parseable.

const CLIENTS_DIR = path.resolve(__dirname, "../../clients");

interface CallSite {
	rel: string;
	line: number;
	/** The balanced `{ ... }` options-object region of this call. */
	region: string;
}

function findCallSites(rel: string, source: string): CallSite[] {
	const sites: CallSite[] = [];
	const marker = "logTreeSitterCacheStats({";
	let idx = source.indexOf(marker);
	while (idx !== -1) {
		let depth = 0;
		let end = idx + marker.length - 1;
		for (; end < source.length; end++) {
			const ch = source[end];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) break;
			}
		}
		sites.push({
			rel,
			line: source.slice(0, idx).split("\n").length,
			region: source.slice(idx + marker.length - 1, end + 1),
		});
		idx = source.indexOf(marker, end + 1);
	}
	return sites;
}

function zeroStats(): TreeSitterParseCacheStats {
	return {
		size: 0,
		maxSize: 50,
		totalLines: 0,
		totalBytes: 0,
		lookups: 0,
		hits: 0,
		misses: 0,
		coldMisses: 0,
		capacityMisses: 0,
		contentChangedMisses: 0,
		mtimeMisses: 0,
		statFailedMisses: 0,
		sets: 0,
		replacements: 0,
		evictions: 0,
		clears: 0,
		ghostHistoryDrops: 0,
		parserInvocations: 0,
		parserDurationMs: 0,
		parserFailures: 0,
	};
}

describe("cache_stats astGrep sub-field coverage (#1982)", () => {
	it("every production logTreeSitterCacheStats caller passes astGrep", () => {
		const offenders: string[] = [];
		let count = 0;

		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!entry.name.endsWith(".ts")) continue;
				const rel = path.relative(CLIENTS_DIR, full);
				const source = fs.readFileSync(full, "utf-8");
				for (const site of findCallSites(rel, source)) {
					count++;
					if (!site.region.includes("astGrep")) {
						offenders.push(`${site.rel}:${site.line}`);
					}
				}
			}
		};
		walk(CLIENTS_DIR);

		// The sweep must actually see both known callers (project_diagnostics_scan
		// and review_graph_full) — otherwise it is vacuous and protects nothing.
		expect(count).toBeGreaterThanOrEqual(2);
		expect(offenders).toEqual([]);
	});
});

describe("emitter always writes metadata.astGrep (#1982)", () => {
	// Allow the real logger to run under vitest (fs is mocked, so no disk I/O).
	process.env.PI_LENS_TEST_MODE = "0";

	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("node:fs");
		vi.doUnmock("node:os");
	});

	it("writes explicit zeros through to the payload", async () => {
		const appendFile = vi.fn(async (_file: string, _data: string) => {});
		vi.doMock("node:fs", () => ({
			mkdirSync: vi.fn(),
			statSync: () => {
				throw new Error("ENOENT");
			},
			promises: { appendFile },
		}));
		vi.doMock("node:os", () => ({
			homedir: () => "/mock-home",
		}));

		const mod = await import("../../clients/tree-sitter-logger.js");
		mod.logTreeSitterCacheStats({
			scope: "review_graph_full",
			filePath: "/workspace",
			fileCount: 5,
			durationMs: 100,
			stats: zeroStats(),
			astGrep: { durationMs: 0, fileCount: 0 },
		});
		await mod.flushTreeSitterLog();

		const payload = JSON.parse(appendFile.mock.calls[0][1]);
		expect(payload.metadata.astGrep).toEqual({
			durationMs: 0,
			fileCount: 0,
		});
	});

	it("writes real ast-grep cost through to the payload", async () => {
		const appendFile = vi.fn(async (_file: string, _data: string) => {});
		vi.doMock("node:fs", () => ({
			mkdirSync: vi.fn(),
			statSync: () => {
				throw new Error("ENOENT");
			},
			promises: { appendFile },
		}));
		vi.doMock("node:os", () => ({
			homedir: () => "/mock-home",
		}));

		const mod = await import("../../clients/tree-sitter-logger.js");
		mod.logTreeSitterCacheStats({
			scope: "project_diagnostics_scan",
			filePath: "/workspace",
			fileCount: 3,
			durationMs: 25,
			stats: zeroStats(),
			astGrep: { durationMs: 13168, fileCount: 86 },
		});
		await mod.flushTreeSitterLog();

		const payload = JSON.parse(appendFile.mock.calls[0][1]);
		expect(payload.metadata.astGrep).toEqual({
			durationMs: 13168,
			fileCount: 86,
		});
	});
});
