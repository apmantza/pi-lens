import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	PROJECT_SNAPSHOT_VERSION,
	buildProjectSnapshotFromRuntime,
	getProjectSnapshotMetaPath,
	getProjectSnapshotPath,
	hydrateRuntimeFromProjectSnapshot,
	isProjectSnapshotFresh,
	loadProjectSnapshot,
	saveProjectSnapshot,
	saveRuntimeProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { buildWordIndex, searchWordIndex } from "../../clients/word-index.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

function withProjectDataDir<T>(fn: (cwd: string) => T): T {
	const env = setupTestEnvironment("project-snapshot-");
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	try {
		return fn(path.join(env.tmpDir, "project"));
	} finally {
		if (previousDataDir === undefined) {
			delete process.env.PILENS_DATA_DIR;
		} else {
			process.env.PILENS_DATA_DIR = previousDataDir;
		}
		env.cleanup();
	}
}

describe("project snapshot", () => {
	it("builds, saves, and loads a runtime snapshot", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			runtime.cachedExports.set("makeThing", path.join(cwd, "src", "a.ts"));
			runtime.projectRulesScan = {
				hasCustomRules: true,
				rules: [
					{
						source: "root",
						name: "AGENTS.md",
						filePath: path.join(cwd, "AGENTS.md"),
						relativePath: "AGENTS.md",
					},
				],
			};

			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, snapshot);

			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(true);
			expect(fs.existsSync(getProjectSnapshotMetaPath(cwd))).toBe(true);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded).toMatchObject({
				version: PROJECT_SNAPSHOT_VERSION,
				seq: 7,
				cachedExports: [["makeThing", path.join(cwd, "src", "a.ts")]],
			});
			expect(isProjectSnapshotFresh(loaded, 7)).toBe(true);
		}));

	it("persists the word index and hydrates a searchable copy", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			runtime.wordIndex = buildWordIndex([
				{
					path: path.join(cwd, "src", "auth.ts"),
					content: "export function authenticateUser() {}",
				},
			]);

			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime }),
			);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.wordIndex).toBeDefined();

			// Hydrate a fresh runtime → its word index must be searchable.
			const target = new RuntimeCoordinator();
			hydrateRuntimeFromProjectSnapshot(target, loaded!);
			expect(target.wordIndex).not.toBeNull();
			const results = searchWordIndex(target.wordIndex!, "authenticate user");
			expect(results[0]?.file).toBe(path.join(cwd, "src", "auth.ts"));
		}));

	it("preserves a previously-persisted word index when the runtime has none", () =>
		withProjectDataDir((cwd) => {
			const withIndex = new RuntimeCoordinator();
			withIndex.seedProjectSequence(2);
			withIndex.wordIndex = buildWordIndex([
				{ path: path.join(cwd, "a.ts"), content: "function keepMe() {}" },
			]);
			saveRuntimeProjectSnapshot({ cwd, runtime: withIndex });

			// A later save from a runtime whose word-index task hasn't finished
			// must not clobber the persisted index.
			const without = new RuntimeCoordinator();
			without.seedProjectSequence(2);
			saveRuntimeProjectSnapshot({ cwd, runtime: without });

			expect(loadProjectSnapshot(cwd)?.wordIndex).toBeDefined();
		}));

	it("does NOT launder a stale word index into looking fresh across a seq bump (#348 seq-laundering guard)", () =>
		withProjectDataDir((cwd) => {
			// Persist a word index at seq=2.
			const withIndex = new RuntimeCoordinator();
			withIndex.seedProjectSequence(2);
			withIndex.wordIndex = buildWordIndex([
				{ path: path.join(cwd, "a.ts"), content: "function staleOnly() {}" },
			]);
			saveRuntimeProjectSnapshot({ cwd, runtime: withIndex });
			expect(loadProjectSnapshot(cwd)?.seq).toBe(2);
			expect(loadProjectSnapshot(cwd)?.wordIndex).toBeDefined();

			// A later save at a NEW seq (project moved on), from a runtime whose
			// word-index task hasn't (re)built yet. Without the guard, this save
			// would re-stamp the seq=2 index as seq=3 — making a stale index look
			// fresh to isProjectSnapshotFresh's seq check, even though it predates
			// the seq bump and its rebuild hasn't happened. The guard (existing.seq
			// === snapshot.seq) must instead DROP the stale index here.
			const without = new RuntimeCoordinator();
			without.seedProjectSequence(3);
			saveRuntimeProjectSnapshot({ cwd, runtime: without });

			const laundered = loadProjectSnapshot(cwd);
			expect(laundered?.seq).toBe(3);
			expect(laundered?.wordIndex).toBeUndefined();
		}));

	it("rejects wrong-version, stale, and future snapshots", () =>
		withProjectDataDir((cwd) => {
			const badPath = getProjectSnapshotPath(cwd);
			fs.mkdirSync(path.dirname(badPath), { recursive: true });
			fs.writeFileSync(
				badPath,
				JSON.stringify({
					version: 999,
					projectRoot: cwd,
					generatedAt: new Date().toISOString(),
					seq: 1,
					cachedExports: [],
				}),
			);
			expect(loadProjectSnapshot(cwd)).toBeNull();

			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(3);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			expect(isProjectSnapshotFresh(snapshot, 2)).toBe(false);
			expect(isProjectSnapshotFresh(snapshot, 4)).toBe(false);
			expect(isProjectSnapshotFresh(snapshot, 3)).toBe(true);
		}));

	it("persists startup scan context and language profile", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(9);
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
				startupScan: {
					cwd,
					scanRoot: cwd,
					projectRoot: cwd,
					canWarmCaches: true,
					sourceFileCount: 2,
				},
				languageProfile: {
					present: { jsts: true } as never,
					configured: { jsts: true },
					counts: { jsts: 2 },
					detectedKinds: ["jsts"],
				},
			});
			saveProjectSnapshot(cwd, snapshot);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.startupScan).toMatchObject({
				canWarmCaches: true,
				sourceFileCount: 2,
			});
			expect(loaded?.languageProfile?.detectedKinds).toEqual(["jsts"]);
		}));

	it("roundtrips project conventions through build + save + load", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(11);
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
				conventions: {
					frameworks: [
						{
							id: "react",
							confidence: "high",
							signals: [
								"package.json:dependencies.react",
								"package.json:dependencies.react-dom",
							],
						},
						{
							id: "vite",
							confidence: "high",
							signals: ["vite.config.ts"],
						},
					],
					testRunners: ["vitest"],
					buildTools: ["vite"],
					agentDocs: [{ filePath: "AGENTS.md", lineCount: 42 }],
				},
			});
			saveProjectSnapshot(cwd, snapshot);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.conventions?.frameworks.map((f) => f.id).sort()).toEqual([
				"react",
				"vite",
			]);
			expect(loaded?.conventions?.testRunners).toEqual(["vitest"]);
			expect(loaded?.conventions?.buildTools).toEqual(["vite"]);
			expect(loaded?.conventions?.agentDocs).toEqual([
				{ filePath: "AGENTS.md", lineCount: 42 },
			]);
		}));

	it("auto-detects conventions inside saveRuntimeProjectSnapshot when none are passed", () =>
		withProjectDataDir((cwd) => {
			fs.mkdirSync(cwd, { recursive: true });
			createTempFile(
				cwd,
				"package.json",
				JSON.stringify({
					dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
					devDependencies: { vite: "^5.0.0", vitest: "^1.0.0" },
				}),
			);
			createTempFile(cwd, "vite.config.ts", "export default {};\n");

			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			saveRuntimeProjectSnapshot({ cwd, runtime });

			const loaded = loadProjectSnapshot(cwd);
			const ids = loaded?.conventions?.frameworks.map((f) => f.id).sort();
			expect(ids).toEqual(["react", "vite", "vitest"]);
			expect(loaded?.conventions?.buildTools).toEqual(["vite"]);
		}));

	it("preserves existing conventions across a snapshot rewrite that does not supply them", () =>
		withProjectDataDir((cwd) => {
			fs.mkdirSync(cwd, { recursive: true });
			// First write — explicit conventions object.
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(2);
			const first = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
				conventions: {
					frameworks: [
						{ id: "next", confidence: "high", signals: ["next.config.js"] },
					],
					testRunners: [],
					buildTools: ["next"],
					agentDocs: [],
				},
			});
			saveProjectSnapshot(cwd, first);

			// Second write via saveRuntimeProjectSnapshot WITHOUT any package.json
			// nor a conventions arg — should inherit the previously-saved value
			// rather than overwriting it with the empty auto-detect result.
			saveRuntimeProjectSnapshot({ cwd, runtime });

			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.conventions?.frameworks.map((f) => f.id)).toEqual(["next"]);
		}));

	it("hydrates cached exports and rules into a new runtime", () =>
		withProjectDataDir((cwd) => {
			const source = new RuntimeCoordinator();
			source.seedProjectSequence(1);
			source.cachedExports.set("fromSnapshot", path.join(cwd, "src", "a.ts"));
			source.projectRulesScan = { hasCustomRules: true, rules: [] };
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime: source,
			});

			const target = new RuntimeCoordinator();
			target.cachedExports.set("stale", path.join(cwd, "src", "old.ts"));
			hydrateRuntimeFromProjectSnapshot(target, snapshot);

			expect([...target.cachedExports.entries()]).toEqual([
				["fromSnapshot", path.join(cwd, "src", "a.ts")],
			]);
			expect(target.projectRulesScan.hasCustomRules).toBe(true);
		}));
});
