// flake-shape: raw-timer-wait — poll the real child extension-log writer after session_end
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

async function readDeadWeight(home: string): Promise<Record<string, unknown>> {
	const logPath = path.join(home, "extension.log");
	for (let attempt = 0; attempt < 40; attempt++) {
		if (fs.existsSync(logPath)) {
			const rows = fs
				.readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const row = rows.find(
				(candidate) => candidate.message === "situational tool dead weight",
			);
			if (row) return row;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("MCP dead-weight row was not written");
}

async function readDeadWeightRows(
	home: string,
): Promise<Record<string, unknown>[]> {
	for (let attempt = 0; attempt < 40; attempt++) {
		const logPath = path.join(home, "extension.log");
		if (fs.existsSync(logPath)) {
			const rows = fs
				.readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((row) => row.message === "situational tool dead weight");
			if (rows.length > 0) return rows;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("MCP dead-weight rows were not written");
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
			expect((rows[0]?.metadata as { tools: string[] }).tools).not.toContain(
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
});
