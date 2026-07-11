/**
 * Auto session_start visibility + self-heal smoke (#544).
 *
 * `PI_LENS_MCP_AUTO_SESSION=1` makes the MCP server self-trigger session_start
 * on `initialize` so a long-lived connection warms without a separate
 * SessionStart-hook process. Two gaps this covers:
 *
 *   1. Visibility — `pilens_health` must report whether auto-session actually
 *      ran for this connection (attempted/succeeded/firedAt/error), not just
 *      log to stderr where Claude Code never surfaces it.
 *   2. Self-heal — if auto-session hasn't succeeded by the time the first
 *      `tools/call` lands, the server must retry it there too, so a stale
 *      process / thrown-before-complete scenario doesn't stay cold forever.
 *
 * Drives the real stdio JSON-RPC transport against a tiny synthetic project
 * (like module-report.smoke.test.ts) so session_start's background scans stay
 * cheap. Requires `npm run build` first.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness } from "./harness.js";

interface AutoSessionShape {
	attempted: boolean;
	succeeded: boolean;
	firedAt: string | null;
	error: string | null;
}

function textOf(res: Record<string, unknown>): string {
	return (res.result as { content: { text: string }[] }).content[0].text;
}

function healthPayload(res: Record<string, unknown>): {
	autoSession: AutoSessionShape | null;
} {
	const text = textOf(res);
	return JSON.parse(
		text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
	) as { autoSession: AutoSessionShape | null };
}

function makeTinyProject(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	writeFileSync(
		path.join(dir, "a.ts"),
		["export function foo(): number {", "  return 1;", "}", ""].join("\n"),
	);
	return dir;
}

async function waitForHealth(
	harness: McpHarness,
	nextId: () => number,
	predicate: (autoSession: AutoSessionShape | null) => boolean,
	timeoutMs = 20_000,
): Promise<AutoSessionShape | null> {
	const deadline = Date.now() + timeoutMs;
	let last: AutoSessionShape | null = null;
	while (Date.now() < deadline) {
		const res = await harness.request(nextId(), "tools/call", {
			name: "pilens_health",
			arguments: {},
		});
		last = healthPayload(res).autoSession;
		if (predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return last;
}

describe("MCP auto session_start visibility (PI_LENS_MCP_AUTO_SESSION unset)", () => {
	let harness: McpHarness;
	let projectDir: string;

	beforeAll(async () => {
		projectDir = makeTinyProject("pi-lens-mcp-autosession-off-");
		harness = new McpHarness({ cwd: projectDir });
		await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "smoke-test", version: "0" },
		});
		harness.notify("notifications/initialized");
	});

	afterAll(() => {
		harness.dispose();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("reports autoSession: null when the feature is off", async () => {
		const res = await harness.request(2, "tools/call", {
			name: "pilens_health",
			arguments: {},
		});
		expect(healthPayload(res).autoSession).toBeNull();
	}, 25_000);
});

describe("MCP auto session_start (PI_LENS_MCP_AUTO_SESSION=1)", () => {
	let harness: McpHarness;
	let projectDir: string;
	let nextId = 1;

	beforeAll(() => {
		projectDir = makeTinyProject("pi-lens-mcp-autosession-on-");
		harness = new McpHarness({
			cwd: projectDir,
			env: { PI_LENS_MCP_AUTO_SESSION: "1" },
		});
	});

	afterAll(() => {
		harness.dispose();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("fires session_start on initialize and pilens_health reflects success", async () => {
		await harness.request(nextId++, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "smoke-test", version: "0" },
		});
		harness.notify("notifications/initialized");

		const state = await waitForHealth(
			harness,
			() => nextId++,
			(s) => s !== null && s.attempted && (s.succeeded || s.error !== null),
		);

		expect(state).not.toBeNull();
		expect(state?.attempted).toBe(true);
		expect(state?.firedAt).toBeTruthy();
		// Real session_start against a tiny scratch project should succeed; if
		// this ever flakes to an error, the message is asserted below so a
		// genuine regression is visible instead of silently passing.
		expect(state?.succeeded).toBe(true);
		expect(state?.error).toBeNull();
	}, 30_000);
});
