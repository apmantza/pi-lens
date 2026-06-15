import { describe, expect, it } from "vitest";
import { getDispatchGroupsForKind } from "../../../clients/dispatch/integration.js";

describe("dispatch integration groups", () => {
	it("keeps centralized css primary group when lens-lsp is enabled", () => {
		const groups = getDispatchGroupsForKind("css", {
			getFlag: (name: string) => name === "lens-lsp",
		});

		expect(groups.length).toBeGreaterThan(0);
		expect(groups[0].runnerIds).toEqual(["lsp", "stylelint"]);
		expect(groups[0].filterKinds).toEqual(["css"]);
	});

	it("returns yaml primary group plus a separate actionlint group", () => {
		const groups = getDispatchGroupsForKind("yaml", {
			getFlag: (name: string) => name === "lens-lsp",
		});

		expect(groups).toHaveLength(2);
		expect(groups[0].runnerIds).toEqual(["lsp", "yamllint"]);
		// mode:"all" — yamllint (smart-default) runs alongside the LSP rather than
		// being suppressed when the LSP succeeds (#209 fallback→all fix).
		expect(groups[0].mode).toBe("all");
		expect(groups[0].filterKinds).toEqual(["yaml"]);
		expect(groups[1].runnerIds).toEqual(["actionlint"]);
		expect(groups[1].mode).toBe("all");
		expect(groups[1].filterKinds).toEqual(["yaml"]);
	});

	it("does not duplicate lsp group when plan already includes lsp", () => {
		const groups = getDispatchGroupsForKind("python", {
			getFlag: (name: string) => name === "lens-lsp",
		});

		const lspGroups = groups.filter((g) => g.runnerIds.includes("lsp"));
		expect(lspGroups).toHaveLength(1);
	});

	it("strips lsp from css group when no-lsp is enabled", () => {
		const groups = getDispatchGroupsForKind("css", {
			getFlag: (name: string) => name === "no-lsp",
		});

		expect(groups).toHaveLength(1);
		expect(groups[0].runnerIds).toEqual(["stylelint"]);
	});
});
