// mutation-lane: exclude
/**
 * Real MCP session-end telemetry probe (#2800).
 *
 * The child process drives the production stdio server, registry filtering,
 * tool dispatcher, lifecycle handler, and extension-log writer. This catches
 * wire-name observations that a direct canonical-name unit test cannot see.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness } from "./harness.js";
import { waitFor } from "../clients/interleaving-kit.js";

async function readDeadWeight(home: string): Promise<Record<string, unknown>> {
	// One poll loop for both readers (flake-shape ratchet: one raw timer wait
	// per file); the single-row reader is the first row of the multi-row one.
	const [row] = await readDeadWeightRows(home);
	return row as Record<string, unknown>;
}

/**
 * The dead-weight rows the child wrote, waiting for the first one to land.
 * Shape 86 (#4865): this was a 40 x 25 ms sleep count; the read is now split
 * out of the loop so `waitFor` owns a real-clock deadline that follows
 * `PI_LENS_TEST_TIMEOUT_SCALE` and names this caller when it gives up.
 */
async function readDeadWeightRows(
	home: string,
): Promise<Record<string, unknown>[]> {
	return waitFor(
		() => deadWeightRowsIn(home),
		(rows) => rows.length > 0,
		{
			timeoutMs: 1_000,
			intervalMs: 25,
		},
	);
}

/** Every dead-weight row in the child's log; empty until the log exists. */
function deadWeightRowsIn(home: string): Record<string, unknown>[] {
	const logPath = path.join(home, "extension.log");
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((row) => row.message === "situational tool dead weight");
}

describe("MCP situational dead-weight session end", () => {
	let harness: McpHarness;
	let home: string;

	beforeAll(async () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-log-"));
		harness = new McpHarness({
			env: { PI_LENS_HOME: home, PI_LENS_TEST_MODE: "0" },
		});
		await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "dead-weight-smoke", version: "0" },
		});
		await harness.request(2, "tools/call", {
			name: "pilens_session_start",
			arguments: {},
		});
		await harness.request(3, "tools/call", {
			name: "pilens_ast_grep_search",
			arguments: { pattern: "const $A = $B", cwd: process.cwd() },
		});
	});

	afterAll(() => {
		harness.dispose();
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("reports one canonical remainder after one real situational call", async () => {
		await harness.request(4, "tools/call", {
			name: "pilens_session_end",
			arguments: {},
		});
		const row = await readDeadWeight(home);
		expect(Object.keys(row).sort()).toEqual([
			"level",
			"message",
			"metadata",
			"pid",
			"subsystem",
			"ts",
			"turnId",
		]);
		expect(row).toEqual(
			expect.objectContaining({
				subsystem: "tools",
				level: "debug",
				message: "situational tool dead weight",
				metadata: {
					tools: [
						"ast_grep_replace",
						"ast_grep_outline",
						"lsp_navigation",
						"lens_diagnostic_mark",
					],
				},
			}),
		);
	});
});

describe("MCP connection-scoped situational dead-weight lifecycle", () => {
	it("treats a second session_start as refresh without losing calls", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-refresh-"));
		const harness = new McpHarness({
			env: { PI_LENS_HOME: home, PI_LENS_TEST_MODE: "0" },
		});
		try {
			await harness.request(1, "initialize");
			await harness.request(2, "tools/call", {
				name: "pilens_session_start",
				arguments: {},
			});
			await harness.request(3, "tools/call", {
				name: "pilens_ast_grep_search",
				arguments: { pattern: "const $A = $B" },
			});
			await harness.request(4, "tools/call", {
				name: "pilens_session_start",
				arguments: {},
			});
			await harness.request(5, "tools/call", {
				name: "pilens_session_end",
				arguments: {},
			});
			const rows = await readDeadWeightRows(home);
			expect(rows).toHaveLength(1);
			const row = rows[0];
			expect(row).toBeDefined();
			expect((row!.metadata as { tools: string[] }).tools).not.toContain(
				"ast_grep_search",
			);
		} finally {
			harness.dispose();
			fs.rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);

	it("opens on a call and emits at session_end without session_start", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-nostart-"));
		const harness = new McpHarness({
			env: { PI_LENS_HOME: home, PI_LENS_TEST_MODE: "0" },
		});
		try {
			await harness.request(1, "initialize");
			await harness.request(2, "tools/call", {
				name: "pilens_ast_grep_search",
				arguments: { pattern: "const $A = $B" },
			});
			await harness.request(3, "tools/call", {
				name: "pilens_session_end",
				arguments: {},
			});
			expect(await readDeadWeightRows(home)).toHaveLength(1);
		} finally {
			harness.dispose();
			fs.rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);

	it("emits on stdin close when session_end is omitted", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-close-"));
		const harness = new McpHarness({
			env: { PI_LENS_HOME: home, PI_LENS_TEST_MODE: "0" },
		});
		try {
			await harness.request(1, "initialize");
			await harness.request(2, "tools/call", {
				name: "pilens_ast_grep_search",
				arguments: { pattern: "const $A = $B" },
			});
			await harness.closeInput();
			expect(await readDeadWeightRows(home)).toHaveLength(1);
		} finally {
			harness.dispose();
			fs.rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);

	it("flushes once when session_end is followed by stdin close", async () => {
		const home = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mcp-end-close-"),
		);
		const harness = new McpHarness({
			env: { PI_LENS_HOME: home, PI_LENS_TEST_MODE: "0" },
		});
		try {
			await harness.request(1, "initialize");
			await harness.request(2, "tools/call", {
				name: "pilens_session_end",
				arguments: {},
			});
			await harness.request(3, "tools/call", {
				name: "pilens_ast_grep_search",
				arguments: { pattern: "const $A = $B" },
			});
			await harness.closeInput();
			expect(await readDeadWeightRows(home)).toHaveLength(1);
		} finally {
			harness.dispose();
			fs.rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);
});
