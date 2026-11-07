/**
 * read_enclosing maxLines pi/MCP parity (#5372) — real stdio smoke: the
 * `max(1, floor)` clamp lived only in the MCP adapter, so the same call gave
 * different answers on the two surfaces: maxLines 0 returned the whole body on
 * pi and an error on MCP; -5 reported "above maxLines -5" on pi and 1 on MCP;
 * 2.5 reported 2.5 vs 2. The clamp now lives in `readEnclosing`
 * (clients/module-report.ts), so both surfaces must return the same claim for
 * the same out-of-range value.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadEnclosingTool } from "../../tools/module-report.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

// Spawns the MCP server as a real stdio subprocess; the established retry: 2
// absorbs the CPU-starvation race in the full parallel suite (passes in
// isolation), like the sibling smokes in this directory.
describe("read_enclosing maxLines pi/MCP parity (#5372)", { retry: 2 }, () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let harness: McpHarness;

	// A 7-line function; line 4 is inside it, so any clamp below 7 is oversize.
	const SAMPLE = [
		"export function seven(a: number) {",
		"  const b = a + 1;",
		"  const c = b + 1;",
		"  const d = c + 1;",
		"  const e = d + 1;",
		"  return e;",
		"}",
	].join("\n");

	beforeAll(async () => {
		env = setupTestEnvironment("pi-lens-readenc-parity-");
		createTempFile(env.tmpDir, "sample.ts", SAMPLE);
		harness = new McpHarness({ cwd: env.tmpDir });
		const init = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "readenc-parity", version: "0" },
		});
		expect((init.result as { protocolVersion: string }).protocolVersion).toBe(
			"2025-06-18",
		);
		harness.notify("notifications/initialized");
	});

	afterAll(() => {
		harness.dispose();
		env.cleanup();
	});

	/** The oversize claim a surface made, or null when it served the body. */
	function claim(text: string): string | null {
		const match = /above maxLines \S+/.exec(text);
		return match ? match[0] : null;
	}

	async function callPi(maxLines: number): Promise<string> {
		const tool = createReadEnclosingTool(
			() => env.tmpDir,
			() => undefined,
		);
		const result = await tool.execute(
			"read-enclosing",
			{ path: "sample.ts", line: 4, maxLines },
			undefined,
			null,
			{ cwd: env.tmpDir },
		);
		return String(result.content[0]?.text);
	}

	async function callMcp(maxLines: number): Promise<string> {
		let id = 10;
		const res = await harness.request(id++, "tools/call", {
			name: "pilens_read_enclosing",
			arguments: { path: "sample.ts", line: 4, maxLines },
		});
		const result = res.result as {
			content?: { type: string; text?: string }[];
		};
		return String(result.content?.[0]?.text ?? "");
	}

	it("reports the same clamped maxLines claim on both surfaces", async () => {
		const cases: Array<[number, string]> = [
			[0, "above maxLines 1"],
			[-5, "above maxLines 1"],
			[2.5, "above maxLines 2"],
		];
		for (const [maxLines, expected] of cases) {
			const piText = await callPi(maxLines);
			const mcpText = await callMcp(maxLines);
			expect(claim(piText)).toBe(expected);
			expect(claim(mcpText)).toBe(expected);
			// Parity is the acceptance criterion: identical claims, not just the
			// tabled expectation.
			expect(claim(mcpText)).toBe(claim(piText));
		}
	}, 60_000);

	it("maxLines above the body size: both surfaces serve the body", async () => {
		const piText = await callPi(20);
		const mcpText = await callMcp(20);
		expect(claim(piText)).toBeNull();
		expect(claim(mcpText)).toBeNull();
		expect(piText).toContain("return e;");
		expect(mcpText).toContain("return e;");
	}, 60_000);
});
