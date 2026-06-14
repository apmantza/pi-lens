import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	const dirs: string[] = [];

	beforeEach(() => {
		clearReviewGraphWorkspaceCache();
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function tmpDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-graph-cache-"));
		dirs.push(dir);
		return dir;
	}

	it("returns the same Promise for identical cwd+changedFiles", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		const p2 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		expect(p1).toBe(p2);
		await p1;
	});

	it("normalises changedFiles order — same promise regardless of sort order", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(
			cwd,
			[path.join(cwd, "a.ts"), path.join(cwd, "b.ts")],
			facts,
		);
		const p2 = buildOrUpdateGraph(
			cwd,
			[path.join(cwd, "b.ts"), path.join(cwd, "a.ts")],
			facts,
		);
		expect(p1).toBe(p2);
		await p1;
	});

	it("returns distinct Promises for different changedFiles", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		const p2 = buildOrUpdateGraph(cwd, [path.join(cwd, "b.ts")], facts);
		expect(p1).not.toBe(p2);
		await Promise.all([p1, p2]);
	});

	it("returns distinct Promises for different cwd values", async () => {
		const facts = new FactStore();
		const p1 = buildOrUpdateGraph(
			tmpDir(),
			[path.join(tmpDir(), "x.ts")],
			facts,
		);
		const p2 = buildOrUpdateGraph(
			tmpDir(),
			[path.join(tmpDir(), "x.ts")],
			facts,
		);
		expect(p1).not.toBe(p2);
		await Promise.all([p1, p2]);
	});

	it("clearGraphCache() forces a fresh build for the same key", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		await p1;
		clearGraphCache();
		const p2 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		expect(p1).not.toBe(p2);
		await p2;
	});

	it("reuses the workspace graph when source signature is unchanged", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		await buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false);
		clearGraphCache();
		await buildOrUpdateGraph(cwd, [path.join(cwd, "b.ts")], facts);
		expect(getLastGraphBuildInfo()).toEqual({ reused: true, mode: "cached" });
	});

	it("reuses the cached graph when mtime drifts but content is unchanged (#202)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const file = path.join(cwd, "drift.ts");
		fs.writeFileSync(file, "export function driftExample() {\n\treturn 1;\n}\n");

		await buildOrUpdateGraph(cwd, [file], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false); // full build

		// Bump mtime into the future WITHOUT changing content → size/mtime
		// signature differs, but the content hash matches.
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(file, future, future);

		clearGraphCache(); // drop the promise-dedup cache so the call re-executes
		// changedFiles=[] — the caller did NOT declare drift.ts changed. Pre-#202
		// this fell through to a full rebuild; now the content-hash confirm proves
		// nothing changed and the cached graph is reused.
		await buildOrUpdateGraph(cwd, [], facts);
		const info = getLastGraphBuildInfo();
		expect(info.reused).toBe(true);
		expect(info.mode).toBe("cached");
	});

	it("resolves to a ReviewGraph with version and builtAt fields", async () => {
		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(tmpDir(), [], facts);
		expect(graph).toHaveProperty("version");
		expect(graph).toHaveProperty("builtAt");
	});
});
