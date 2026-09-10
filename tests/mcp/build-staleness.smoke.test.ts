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
import { MAX_RESULT_BYTES } from "../../tools/render-compact.js";
import { McpHarness, repoRoot } from "./harness.js";

// Fixed allowance over MAX_RESULT_BYTES for the JSON-RPC envelope and the JSON
// escaping (\" \n \t) of the bounded text inside the serialized wire result.
// The pre-fix #2852 N1 regression measured ~211 KB wire bytes against this
// ceiling, so the allowance only absorbs envelope/escaping growth, never a
// payload duplicate.
const MCP_RESULT_ENVELOPE_ALLOWANCE_BYTES = 16 * 1024;

describe("warm build-staleness guard (real spawn)", { retry: 2 }, () => {
	let harness: McpHarness;
	let stampDir: string;
	let stampFile: string;
	let workspace: string;

	beforeAll(() => {
		stampDir = mkdtempSync(path.join(tmpdir(), "pi-lens-staleness-stamp-"));
		stampFile = path.join(stampDir, "entry-stamp.txt");
		writeFileSync(stampFile, "initial\n");
		// Oversized fixture (refs #2852 N1/N2): 1,200 symbols whose full
		// module_report payload exceeds MAX_RESULT_BYTES, so the delivery bound
		// has to engage and the wire shape is observable at scale.
		workspace = mkdtempSync(path.join(tmpdir(), "pi-lens-staleness-ws-"));
		const lines = [
			"// Oversized fixture: the symbols below must exceed MAX_RESULT_BYTES.",
		];
		for (let i = 0; i < 1200; i++) {
			lines.push(`export function sym${i}(): number {\n\treturn ${i};\n}`);
		}
		writeFileSync(
			path.join(workspace, "big-source.ts"),
			`${lines.join("\n")}\n`,
		);
		harness = new McpHarness({
			cwd: workspace,
			env: {
				PI_LENS_MCP_STALENESS_STAT_PATH: stampFile,
				// Disables the gate's re-stat throttle so the mtime bump below is
				// visible on the very next call, instead of this test having to
				// sleep out a full checkIntervalMs (default 1000ms).
				PI_LENS_MCP_STALENESS_INTERVAL_MS: "0",
			},
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
		expect(
			(res.result as { serverInfo: { name: string } }).serverInfo.name,
		).toBe("pi-lens-mcp");
		harness.notify("notifications/initialized");
	}, 25_000);

	it("force-routes pilens_analyze to fresh once the stamp file's mtime advances", async () => {
		// Simulate a rebuild landing while this server keeps running: bump the
		// isolated stamp file's mtime forward. The harness disables the gate's
		// re-stat throttle above, so a short settle is enough to clear the wire
		// round-trip — comfortably past filesystem mtime-resolution granularity
		// too (some Windows filesystems only resolve to ~2s), since the mtime is
		// pushed 5 minutes forward.
		const future = new Date(Date.now() + 5 * 60_000);
		utimesSync(stampFile, future, future);
		await new Promise((resolve) => setTimeout(resolve, 50));

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
		expect(
			Buffer.byteLength(result.content[0].text, "utf8"),
		).toBeLessThanOrEqual(MAX_RESULT_BYTES);
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

	it("delivers an oversized stale result bounded, warning intact, without the details duplicate", async () => {
		// Complete the handshake first so the server has booted and captured its
		// staleness stamp BEFORE the bump below — otherwise running this test
		// alone (-t) races the boot and the stamp can be captured after the
		// bump, reading fresh. Then arm staleness here too so this test is
		// independent of the bump in the earlier test when run alone: with the
		// gate's re-stat throttle disabled above, the very next call sees the
		// advanced mtime. The fixture body exceeds MAX_RESULT_BYTES, making
		// this the one configuration in which the bound-vs-warning ordering is
		// observable (refs #2852 N2): binding before warning would deliver
		// 40,960 bytes PLUS the warning.
		await harness.request(10, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "smoke-test-oversized", version: "0" },
		});
		harness.notify("notifications/initialized");
		const bumped = new Date(Date.now() + 5 * 60_000);
		utimesSync(stampFile, bumped, bumped);
		const res = await harness.request(11, "tools/call", {
			name: "pilens_module_report",
			arguments: { file: path.join(workspace, "big-source.ts"), view: "full" },
		});
		const result = res.result as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		const text = result.content[0].text;
		expect(text).toContain("warmCodeStale: true");
		expect(text).toContain("characters omitted");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
			MAX_RESULT_BYTES,
		);
		// N1: the wire result must not carry the unbounded `details` duplicate —
		// the whole serialized result stays within the text budget plus the
		// fixed envelope/escaping allowance.
		const wire = res.result as Record<string, unknown>;
		expect("details" in wire).toBe(false);
		const wireBytes = Buffer.byteLength(JSON.stringify(wire), "utf8");
		expect(wireBytes).toBeLessThanOrEqual(
			MAX_RESULT_BYTES + MCP_RESULT_ENVELOPE_ALLOWANCE_BYTES,
		);
	}, 60_000);
});
