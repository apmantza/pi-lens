import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getLastGraphBuildInfo,
} from "../../clients/review-graph/builder.js";

// Mock out the expensive file system scanning — we only care about cache behaviour
vi.mock("../../clients/scan-utils.js", () => ({
	getSourceFiles: vi.fn().mockReturnValue([]),
}));

describe("buildOrUpdateGraph — Promise dedup cache", () => {
	beforeEach(() => {
		clearReviewGraphWorkspaceCache();
	});

	it("returns the same Promise for identical cwd+changedFiles", async () => {
		const facts = new FactStore();
		const p1 = buildOrUpdateGraph("/fake/cwd", ["/fake/cwd/a.ts"], facts);
		const p2 = buildOrUpdateGraph("/fake/cwd", ["/fake/cwd/a.ts"], facts);
		expect(p1).toBe(p2);
		await p1;
	});

	it("normalises changedFiles order — same promise regardless of sort order", async () => {
		const facts = new FactStore();
		const p1 = buildOrUpdateGraph("/cwd", ["/cwd/a.ts", "/cwd/b.ts"], facts);
		const p2 = buildOrUpdateGraph("/cwd", ["/cwd/b.ts", "/cwd/a.ts"], facts);
		expect(p1).toBe(p2);
		await p1;
	});

	it("returns distinct Promises for different changedFiles", async () => {
		const facts = new FactStore();
		const p1 = buildOrUpdateGraph("/cwd", ["/cwd/a.ts"], facts);
		const p2 = buildOrUpdateGraph("/cwd", ["/cwd/b.ts"], facts);
		expect(p1).not.toBe(p2);
		await Promise.all([p1, p2]);
	});

	it("returns distinct Promises for different cwd values", async () => {
		const facts = new FactStore();
		const p1 = buildOrUpdateGraph("/project-a", ["/project-a/x.ts"], facts);
		const p2 = buildOrUpdateGraph("/project-b", ["/project-b/x.ts"], facts);
		expect(p1).not.toBe(p2);
		await Promise.all([p1, p2]);
	});

	it("clearGraphCache() forces a fresh build for the same key", async () => {
		const facts = new FactStore();
		const p1 = buildOrUpdateGraph("/cwd", ["/cwd/a.ts"], facts);
		await p1;
		clearGraphCache();
		const p2 = buildOrUpdateGraph("/cwd", ["/cwd/a.ts"], facts);
		expect(p1).not.toBe(p2);
		await p2;
	});

	it("reuses the workspace graph when source signature is unchanged", async () => {
		const facts = new FactStore();
		await buildOrUpdateGraph("/cwd", ["/cwd/a.ts"], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false);
		clearGraphCache();
		await buildOrUpdateGraph("/cwd", ["/cwd/b.ts"], facts);
		expect(getLastGraphBuildInfo()).toEqual({ reused: true, mode: "cached" });
	});

	it("resolves to a ReviewGraph with version and builtAt fields", async () => {
		const facts = new FactStore();
		const graph = await buildOrUpdateGraph("/cwd", [], facts);
		expect(graph).toHaveProperty("version");
		expect(graph).toHaveProperty("builtAt");
	});
});
