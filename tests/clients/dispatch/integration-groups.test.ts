import { describe, expect, it } from "vitest";
import { getDispatchGroupsForKind } from "../../../clients/dispatch/integration.js";

	describe("dispatch integration groups", () => {
	it("keeps centralized css primary group when lens-lsp is enabled", () => {
		const groups = getDispatchGroupsForKind("css", {
			getFlag: (name: string) => name === "lens-lsp",
		});

		expect(groups.length).toBeGreaterThan(0);
		expect(groups[0].runnerIds).toEqual(["lsp", "stylelint", "prettier-check"]);
		expect(groups[0].filterKinds).toEqual(["css"]);
	});

	it("uses centralized yaml primary fallback group", () => {
		const groups = getDispatchGroupsForKind("yaml", {
			getFlag: (name: string) => name === "lens-lsp",
		});

		expect(groups).toHaveLength(1);
		expect(groups[0].runnerIds).toEqual(["lsp", "yamllint"]);
		expect(groups[0].filterKinds).toEqual(["yaml"]);
	});

	it("does not duplicate lsp group when plan already includes lsp", () => {
		const groups = getDispatchGroupsForKind("python", {
			getFlag: (name: string) => name === "lens-lsp",
		});

		const lspGroups = groups.filter((g) => g.runnerIds.includes("lsp"));
		expect(lspGroups).toHaveLength(1);
	});

	it("strips lsp from css group when lens-lsp is disabled", () => {
		const groups = getDispatchGroupsForKind("css", {
			getFlag: () => false,
		});

		expect(groups).toHaveLength(1);
		expect(groups[0].runnerIds).toEqual(["stylelint", "prettier-check"]);
	});
});
