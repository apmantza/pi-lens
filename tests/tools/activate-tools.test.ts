import { describe, expect, it } from "vitest";
import {
	createActivateToolsTool,
	type ActivatableToolInfo,
} from "../../tools/activate-tools.js";

const CATALOG: ActivatableToolInfo[] = [
	{ name: "ast_grep_search", summary: "Structural search." },
	{ name: "ast_grep_replace", summary: "Structural replace." },
	{ name: "lsp_navigation", summary: "LSP nav." },
];

describe("pi_lens_activate_tools", () => {
	it("has the expected name and lists every catalog entry in the invalid-call result", async () => {
		const tool = createActivateToolsTool({}, CATALOG);
		expect(tool.name).toBe("pi_lens_activate_tools");
		const result = await tool.execute(
			"metadata-pin",
			{ tools: [] },
			new AbortController().signal,
			null,
		);
		const text = result.content[0]?.text ?? "";
		for (const { name, summary } of CATALOG) {
			expect(text).toContain(name);
			expect(tool.description).not.toContain(summary);
		}
	});

	it("calls setActiveTools additively (merges with the current active set)", async () => {
		let active = ["lens_diagnostics", "ast_grep_search"];
		let setCallArgs: string[] | undefined;
		const pi = {
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				setCallArgs = names;
				active = names;
			},
		};
		const tool = createActivateToolsTool(pi, CATALOG);

		const result = await tool.execute(
			"1",
			{ tools: ["ast_grep_replace", "lsp_navigation"] },
			new AbortController().signal,
			null,
		);

		expect(result.isError).toBeUndefined();
		expect(setCallArgs).toBeDefined();
		// Additive: the previously-active lens_diagnostics/ast_grep_search must
		// survive the call, per the docs' "must be additive" constraint.
		expect(setCallArgs).toEqual(
			expect.arrayContaining([
				"lens_diagnostics",
				"ast_grep_search",
				"ast_grep_replace",
				"lsp_navigation",
			]),
		);
		expect(result.details).toEqual({
			matches: ["ast_grep_replace", "lsp_navigation"],
			added: ["ast_grep_replace", "lsp_navigation"],
		});
	});

	it("mutates once per distinct tool and reports the actual added count", async () => {
		let active = ["lens_diagnostics"];
		const setCalls: string[][] = [];
		const mutations: Array<Record<string, unknown>> = [];
		const pi = {
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				setCalls.push(names);
				active = names;
			},
		};
		const tool = createActivateToolsTool(pi, CATALOG, {
			deferredToolSupport: () => false,
			onMutation: (mutation) => mutations.push(mutation),
		});

		await tool.execute(
			"monotonic-1",
			{ tools: ["ast_grep_search"] },
			undefined,
			null,
		);
		const repeated = await tool.execute(
			"monotonic-2",
			{ tools: ["ast_grep_search"] },
			undefined,
			null,
		);

		expect(setCalls).toHaveLength(1);
		expect(active).toEqual(["lens_diagnostics", "ast_grep_search"]);
		expect(repeated.details).toEqual({
			matches: ["ast_grep_search"],
			added: [],
		});
		expect(mutations).toEqual([
			expect.objectContaining({
				addedCount: 1,
				removedCount: 0,
				reason: "lazy_activation",
				deferralApplies: false,
			}),
		]);
	});

	// #1453: the extension has to remember what the model activated so it can
	// restore that posture after the host rebuilds the session. A tool that is
	// already active still has to be remembered — otherwise the next
	// fork/reload/resume would drop it.
	it("reports every requested tool to onActivated, already-active ones included", async () => {
		let active = ["lens_diagnostics", "ast_grep_search"];
		const activated: string[][] = [];
		const pi = {
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
		};
		const tool = createActivateToolsTool(pi, CATALOG, {
			onActivated: (names) => activated.push(names),
		});

		await tool.execute(
			"remember-1",
			{ tools: ["ast_grep_search", "lsp_navigation"] },
			undefined,
			null,
		);
		// No valid names: nothing to remember.
		await tool.execute("remember-2", { tools: ["nope"] }, undefined, null);

		expect(activated).toEqual([["ast_grep_search", "lsp_navigation"]]);
	});

	it("ignores unknown tool names not in the catalog", async () => {
		const pi = {
			getActiveTools: () => [],
			setActiveTools: (_names: string[]) => {},
		};
		const tool = createActivateToolsTool(pi, CATALOG);

		const result = await tool.execute(
			"2",
			{ tools: ["not_a_real_tool"] },
			new AbortController().signal,
			null,
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain("No valid tool names");
	});

	it("is a no-op that still returns cleanly when the host has no setActiveTools", async () => {
		// Mirrors the feature-detection fallback: on a host without dynamic
		// tooling, index.ts never deactivates these tools in the first place, so
		// this call is unnecessary but must not throw.
		const tool = createActivateToolsTool({}, CATALOG);

		const result = await tool.execute(
			"3",
			{ tools: ["ast_grep_search"] },
			new AbortController().signal,
			null,
		);

		expect(result.isError).toBeUndefined();
		expect(result.details).toEqual({
			matches: ["ast_grep_search"],
			added: ["ast_grep_search"],
		});
	});
});
