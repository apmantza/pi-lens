/**
 * Warm build-staleness guard (#535) — real end-to-end smoke: spawns the actual
 * server subprocess, then bumps an isolated "entry" file's mtime (simulating a
 * rebuild that lands while the server keeps running with its OLD in-memory
 * code), and asserts the next `tools/call` visibly flags it — either via
 * `pilens_analyze` force-routing to `mode=fresh` (`servedBy` marker) or via
 * the honest-degrade `warmCodeStale: true` warning on a warm-only tool
 * (`pilens_health`/`pilens_latency`).
 *
 * The server's staleness stamp is pointed at a dedicated temp file via
 * `PI_LENS_MCP_STALENESS_STAT_PATH` rather than the real `mcp/server.js` —
 * bumping the REAL file's mtime would leak into every OTHER concurrently-
 * spawned server process in the same parallel vitest run (they all stat the
 * same shared file), which is exactly what happened the first time this test
 * was written: it made `server.smoke.test.ts`'s unrelated warm-mode assertion
 * flip to `[fresh]` under `npm test`'s full parallel suite despite passing in
 * isolation.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness, repoRoot } from "./harness.js";

describe("warm build-staleness guard (real spawn)", { retry: 2 }, () => {
	let harness: McpHarness;
	let stampDir: string;
	let stampFile: string;

	beforeAll(() => {
		stampDir = mkdtempSync(path.join(tmpdir(), "pi-lens-staleness-stamp-"));
		stampFile = path.join(stampDir, "entry-stamp.txt");
		writeFileSync(stampFile, "initial\n");
		harness = new McpHarness({
			env: { PI_LENS_MCP_STALENESS_STAT_PATH: stampFile },
		});
	});

	afterAll(() => {
		harness.dispose();
		rmSync(stampDir, { recursive: true, force: true });
	});

	it("completes the handshake before the mtime bump", async () => {
		const res = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "smoke-test", version: "0" },
		});
		expect((res.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
			"pi-lens-mcp",
		);
		harness.notify("notifications/initialized");
	}, 25_000);

	it("force-routes pilens_analyze to fresh once the stamp file's mtime advances", async () => {
		// Simulate a rebuild landing while this server keeps running: bump the
		// isolated stamp file's mtime forward. The gate re-stats at most once per
		// second, so push it comfortably past both that throttle and filesystem
		// mtime-resolution granularity (some Windows filesystems only resolve to
		// ~2s).
		const future = new Date(Date.now() + 5 * 60_000);
		utimesSync(stampFile, future, future);
		await new Promise((resolve) => setTimeout(resolve, 1200));

		const target = path.join(repoRoot, "clients", "mcp", "host-shim.ts");
		const res = await harness.request(2, "tools/call", {
			name: "pilens_analyze",
			arguments: { file: target, mode: "warm", flags: { "no-lsp": true } },
		});
		const result = res.result as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		// Forced to fresh (not warm) and tagged — even though `mode: "warm"` was
		// requested, a stale warm build must never silently answer as warm.
		expect(result.content[0].text).toContain("[fresh]");
		expect(result.content[0].text).toContain("servedBy");
		expect(result.content[0].text).toContain("warm code stale");
	}, 60_000);

	it("appends a warmCodeStale warning to a warn-only tool once stale", async () => {
		const res = await harness.request(3, "tools/call", {
			name: "pilens_health",
			arguments: {},
		});
		const result = res.result as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("warmCodeStale: true");
	}, 25_000);

	it("also warns on pilens_latency (a second warn-only tool, confirms the set isn't a single hardcoded name)", async () => {
		const res = await harness.request(4, "tools/call", {
			name: "pilens_latency",
			arguments: { limit: 1 },
		});
		const result = res.result as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("warmCodeStale: true");
	}, 25_000);
});
