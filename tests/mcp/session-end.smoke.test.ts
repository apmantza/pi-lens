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
						"ast_grep_dump",
						"lsp_navigation",
						"lens_diagnostic_mark",
					],
				},
			}),
		);
	});
});
