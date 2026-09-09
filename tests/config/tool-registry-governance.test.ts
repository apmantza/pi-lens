import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import extension from "../../index.js";
import {
	TOOL_REGISTRY,
	toolRegistryEntryForMcp,
	toolRegistryEntryForPi,
} from "../../clients/tool-config.js";
import { McpHarness } from "../mcp/harness.js";
import { createPiMock } from "../support/pi-mock.js";

describe("model-facing tool registry governance (#2800)", () => {
	let piNames: string[];
	let mcp: McpHarness;
	let mcpNames: string[];

	beforeAll(async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		piNames = [...pi.tools.keys()];
		mcp = new McpHarness();
		const listed = await mcp.request(1, "tools/list");
		mcpNames = (
			(listed.result as { tools: { name: string }[] }).tools ?? []
		).map((tool) => tool.name);
	});

	afterAll(() => mcp?.dispose());

	it("covers every pi and MCP registration, including the five MCP-only tools", () => {
		const piEntries = TOOL_REGISTRY.filter((entry) => entry.piName);
		const mcpEntries = TOOL_REGISTRY.filter((entry) => entry.mcpName);
		expect(new Set(piNames)).toEqual(
			new Set(piEntries.map((entry) => entry.piName)),
		);
		expect(new Set(mcpNames)).toEqual(
			new Set(mcpEntries.map((entry) => entry.mcpName)),
		);
		for (const name of [
			"pilens_health",
			"pilens_latency",
			"pilens_project_scan",
			"pilens_session_start",
			"pilens_turn_end",
		]) {
			expect(
				toolRegistryEntryForMcp(name),
				`missing registry entry for ${name}`,
			).toBeDefined();
		}
		for (const name of piNames) {
			expect(
				toolRegistryEntryForPi(name),
				`missing registry entry for ${name}`,
			).toBeDefined();
		}
		for (const name of mcpNames) {
			expect(
				toolRegistryEntryForMcp(name),
				`missing registry entry for ${name}`,
			).toBeDefined();
		}
	});

	it("applies registry filtering to an MCP-only tool and preserves lifecycle tools", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-tool-registry-"),
		);
		fs.writeFileSync(
			path.join(cwd, ".pi-lens.json"),
			JSON.stringify({
				tools: {
					health: { enabled: false },
					session_start: { enabled: false },
				},
			}),
		);
		const isolated = new McpHarness({ cwd });
		try {
			const listed = await isolated.request(2, "tools/list");
			const names = (
				(listed.result as { tools: { name: string }[] }).tools ?? []
			).map((tool) => tool.name);
			expect(names).not.toContain("pilens_health");
			expect(names).toContain("pilens_session_start");
		} finally {
			isolated.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 25_000);
});
