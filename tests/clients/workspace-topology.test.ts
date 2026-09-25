import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRESHNESS_CADENCE_MS } from "../../clients/freshness-cadence.js";
import * as latencyLogger from "../../clients/latency-logger.js";

// `vi.spyOn(fs, "readdirSync")` cannot redefine a node: built-in's ESM
// namespace export directly, so wrap it via vi.mock instead — keeps the
// real implementation (via importOriginal) but lets tests assert call
// counts to verify the "one readdir pass per directory visit" invariant.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: vi.fn(actual.readdirSync),
		statSync: vi.fn(actual.statSync),
	};
});
import {
	findGoverningTsconfigDir,
	findNearestDirWithAnyBasename,
	findNearestDirWithMarker,
	findPiLensConfigMarkerInDir,
	getDirectoryMarkers,
	getWorkspaceManifestMarkers,
	resetWorkspaceTopology,
} from "../../clients/workspace-topology.js";
import { setupTestEnvironment } from "./test-utils.js";

let root: string;
let cleanup: () => void;

beforeEach(() => {
	const env = setupTestEnvironment("pi-lens-workspace-topology-");
	root = env.tmpDir;
	cleanup = env.cleanup;
	resetWorkspaceTopology();
	vi.mocked(fs.readdirSync).mockClear();
});

afterEach(() => {
	resetWorkspaceTopology();
	cleanup();
	vi.restoreAllMocks();
});

function write(rel: string, content = "{}"): string {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

describe("getDirectoryMarkers — marker index correctness", () => {
	it("collects all markers in one directory visit, incl both .pi-lens.json basenames", () => {
		write(".pi-lens.json");
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBe(path.join(root, ".pi-lens.json"));
	});

	it("falls back to the no-dot pi-lens.json basename when .pi-lens.json is absent", () => {
		write("pi-lens.json");
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBe(path.join(root, "pi-lens.json"));
	});

	it("prefers .pi-lens.json over pi-lens.json when both exist", () => {
		write(".pi-lens.json");
		write("pi-lens.json");
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBe(path.join(root, ".pi-lens.json"));
	});

	it("collects tsconfig.json and workspace-manifest markers alongside the pi-lens config", () => {
		write(".pi-lens.json");
		write("tsconfig.json");
		write("package.json", '{"name":"demo"}');
		write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
		write("Cargo.toml", "[workspace]\n");
		write("go.work", "go 1.21\n");
		write("Chart.yaml", "apiVersion: v2\n");
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBe(path.join(root, ".pi-lens.json"));
		expect(markers.tsconfigPath).toBe(path.join(root, "tsconfig.json"));
		expect(markers.packageJsonPath).toBe(path.join(root, "package.json"));
		expect(markers.pnpmWorkspaceYamlPath).toBe(
			path.join(root, "pnpm-workspace.yaml"),
		);
		expect(markers.cargoTomlPath).toBe(path.join(root, "Cargo.toml"));
		expect(markers.goWorkPath).toBe(path.join(root, "go.work"));
		expect(markers.chartYamlPath).toBe(path.join(root, "Chart.yaml"));
	});

	it("returns undefined markers for an empty directory", () => {
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBeUndefined();
		expect(markers.tsconfigPath).toBeUndefined();
		expect(markers.packageJsonPath).toBeUndefined();
		expect(markers.pnpmWorkspaceYamlPath).toBeUndefined();
		expect(markers.cargoTomlPath).toBeUndefined();
		expect(markers.goWorkPath).toBeUndefined();
	});

	it("tolerates a directory that does not exist", () => {
		const markers = getDirectoryMarkers(
			path.join(root, "does", "not", "exist"),
		);
		expect(markers.piLensConfigPath).toBeUndefined();
		expect(markers.dirMtimeMs).toBe(-1);
	});
});

describe("getDirectoryMarkers — single readdir pass per directory visit", () => {
	it("collects ALL markers from one readdirSync call, not one per marker", () => {
		write(".pi-lens.json");
		write("tsconfig.json");
		write("package.json", "{}");

		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBeDefined();
		expect(markers.tsconfigPath).toBeDefined();
		expect(markers.packageJsonPath).toBeDefined();
		// Exactly one directory listing for the visit that populated all three.
		expect(fs.readdirSync).toHaveBeenCalledTimes(1);
	});

	it("does not re-list the directory on a cache hit (dir mtime unchanged)", () => {
		write("tsconfig.json");
		getDirectoryMarkers(root); // populate cache
		vi.mocked(fs.readdirSync).mockClear();
		getDirectoryMarkers(root);
		getDirectoryMarkers(root);
		expect(fs.readdirSync).not.toHaveBeenCalled();
	});
});

describe("getDirectoryMarkers — mtime invalidation", () => {
	it("re-scans when a file is added to the directory (dir mtime bumps)", async () => {
		const before = getDirectoryMarkers(root);
		expect(before.tsconfigPath).toBeUndefined();

		// Sleep so the directory's mtime measurably advances across filesystems.
		await new Promise((r) => setTimeout(r, 20));
		write("tsconfig.json");

		const after = getDirectoryMarkers(root);
		expect(after.tsconfigPath).toBe(path.join(root, "tsconfig.json"));
	});

	it("findPiLensConfigMarkerInDir picks up a content-only rewrite via a fresh file stat", async () => {
		const configPath = write(".pi-lens.json", '{"ignore":["a"]}');
		const marker1 = findPiLensConfigMarkerInDir(root);
		expect(marker1?.mtimeMs).toBeDefined();

		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(configPath, '{"ignore":["a","b"]}');

		const marker2 = findPiLensConfigMarkerInDir(root);
		expect(marker2?.mtimeMs).toBeGreaterThan(marker1!.mtimeMs);
	});
});

describe("findNearestDirWithMarker / findGoverningTsconfigDir", () => {
	it("walks up to the nearest ancestor carrying the marker", () => {
		write("tsconfig.json");
		const sub = path.join(root, "src", "lib");
		fs.mkdirSync(sub, { recursive: true });
		expect(findGoverningTsconfigDir(sub, "/nonexistent-home-zzz")).toBe(root);
	});

	it("returns undefined when no ancestor carries the marker", () => {
		const sub = path.join(root, "src", "lib");
		fs.mkdirSync(sub, { recursive: true });
		expect(
			findGoverningTsconfigDir(sub, "/nonexistent-home-zzz"),
		).toBeUndefined();
	});

	it("never resolves a marker at or above the home-dir ceiling", () => {
		write("tsconfig.json");
		const project = path.join(root, "project", "src");
		fs.mkdirSync(project, { recursive: true });
		// homeDir === root: the marker lives exactly at the ceiling directory,
		// so the walk must refuse it (mirrors the #253 isAtOrAboveHomeDir rule).
		expect(findGoverningTsconfigDir(project, root)).toBeUndefined();
	});
});

describe("#2560: cached walk misses have bounded, cadence-based freshness", () => {
	it("checks only startDir on warm misses instead of statting the full chain", () => {
		const startDir = path.join(root, "a", "b", "c", "project");
		fs.mkdirSync(startDir, { recursive: true });
		const homeDir = path.dirname(root);

		expect(
			findNearestDirWithMarker(startDir, "tsconfigPath", homeDir),
		).toBeUndefined();
		vi.mocked(fs.statSync).mockClear();

		const warmLookups = 25;
		for (let i = 0; i < warmLookups; i++) {
			expect(
				findNearestDirWithMarker(startDir, "tsconfigPath", homeDir),
			).toBeUndefined();
		}

		expect(fs.statSync).toHaveBeenCalledTimes(warmLookups);
	});

	it("immediately re-walks when startDir itself changes after a miss", () => {
		const startDir = path.join(root, "project");
		fs.mkdirSync(startDir, { recursive: true });
		const homeDir = path.dirname(root);
		expect(
			findNearestDirWithMarker(startDir, "tsconfigPath", homeDir),
		).toBeUndefined();

		// A miss is still invalidated immediately by the start directory's own
		// mtime; only changes above it wait for the cadence.
		const oldMtimeMs = fs.statSync(startDir).mtimeMs;
		fs.writeFileSync(path.join(startDir, "tsconfig.json"), "{}");
		const changedMtimeMs = Math.max(
			fs.statSync(startDir).mtimeMs,
			oldMtimeMs + 10_000,
		);
		fs.utimesSync(startDir, changedMtimeMs / 1000, changedMtimeMs / 1000);
		expect(findNearestDirWithMarker(startDir, "tsconfigPath", homeDir)).toBe(
			startDir,
		);
	});

	it("notices a marker two levels above startDir only after the cadence", () => {
		const repoRoot = path.join(root, "repo");
		const startDir = path.join(repoRoot, "worktrees", "wt1");
		fs.mkdirSync(startDir, { recursive: true });

		vi.useFakeTimers();
		try {
			const startedAt = Date.now();
			const homeDir = path.dirname(root);
			expect(
				findNearestDirWithMarker(startDir, "tsconfigPath", homeDir),
			).toBeUndefined();

			// #2560 recurrence: a configless worktree must not inherit unrelated
			// ancestor churn as invalidation, but a new repo-root marker must not
			// remain hidden permanently either.
			fs.writeFileSync(path.join(repoRoot, "tsconfig.json"), "{}");
			vi.setSystemTime(startedAt + FRESHNESS_CADENCE_MS - 1);
			expect(
				findNearestDirWithMarker(startDir, "tsconfigPath", homeDir),
				"picked up the ancestor marker inside the freshness window",
			).toBeUndefined();

			vi.setSystemTime(startedAt + FRESHNESS_CADENCE_MS + 1);
			expect(findNearestDirWithMarker(startDir, "tsconfigPath", homeDir)).toBe(
				repoRoot,
			);
		} finally {
			resetWorkspaceTopology();
			vi.useRealTimers();
		}
	});

	it("keeps hits path-invalidated without forcing a cadence re-walk", () => {
		const previousIdle = process.env.PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS;
		process.env.PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS = "10";
		const repoRoot = path.join(root, "repo");
		const startDir = path.join(repoRoot, "pkg");
		fs.mkdirSync(startDir, { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "tsconfig.json"), "{}");

		vi.useFakeTimers();
		try {
			const homeDir = path.dirname(root);
			expect(findNearestDirWithMarker(startDir, "tsconfigPath", homeDir)).toBe(
				repoRoot,
			);
			vi.mocked(fs.readdirSync).mockClear();

			// Keep the walk memo warm while letting its per-directory marker entries
			// idle out. A cadence-only hit expiry would then have to re-list the
			// directories; the hit path must remain governed by its recorded mtimes.
			for (let elapsed = 0; elapsed <= FRESHNESS_CADENCE_MS; elapsed += 5) {
				vi.advanceTimersByTime(5);
				expect(
					findNearestDirWithMarker(startDir, "tsconfigPath", homeDir),
				).toBe(repoRoot);
			}
			expect(fs.readdirSync).not.toHaveBeenCalled();

			const oldMtimeMs = fs.statSync(startDir).mtimeMs;
			fs.writeFileSync(path.join(startDir, "tsconfig.json"), "{}");
			const changedMtimeMs = Math.max(
				fs.statSync(startDir).mtimeMs,
				oldMtimeMs + 10_000,
			);
			fs.utimesSync(startDir, changedMtimeMs / 1000, changedMtimeMs / 1000);
			expect(findNearestDirWithMarker(startDir, "tsconfigPath", homeDir)).toBe(
				startDir,
			);
		} finally {
			resetWorkspaceTopology();
			vi.useRealTimers();
			if (previousIdle === undefined)
				delete process.env.PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS;
			else process.env.PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS = previousIdle;
		}
	});
});

describe("findNearestDirWithMarker — walk cap + latency logging", () => {
	it("caps the climb and logs a phase entry instead of truncating silently", () => {
		const logSpy = vi
			.spyOn(latencyLogger, "logLatency")
			.mockImplementation(() => {});

		// Synthetic (non-existent) deep path — walkUpDirs only does string
		// manipulation via path.dirname, so no real directories are needed.
		const segments = Array.from({ length: 100 }, (_, i) => `level${i}`);
		const deepStart = path.join(
			path.parse(root).root,
			"synthetic-workspace-topology-cap-test",
			...segments,
		);
		// A homeDir far outside the synthetic tree so isAtOrAboveHomeDir never
		// short-circuits the walk before the depth cap does.
		const result = findNearestDirWithMarker(
			deepStart,
			"tsconfigPath",
			path.join(path.parse(root).root, "definitely-not-a-real-home-zzz"),
		);

		expect(result).toBeUndefined();
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "phase",
				phase: "workspace-topology-walk-cap",
			}),
		);
	});
});

describe("DirectoryMarkers.entryNames — raw readdir names (#807)", () => {
	it("exposes every immediate-child entry name, file and directory alike", () => {
		write("tsconfig.json");
		write("Cargo.toml");
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		const markers = getDirectoryMarkers(root);
		expect(markers.entryNames.has("tsconfig.json")).toBe(true);
		expect(markers.entryNames.has("Cargo.toml")).toBe(true);
		expect(markers.entryNames.has("src")).toBe(true);
		expect(markers.entryNames.has("does-not-exist.txt")).toBe(false);
	});

	it("is empty for a directory that does not exist", () => {
		const markers = getDirectoryMarkers(path.join(root, "nope"));
		expect(markers.entryNames.size).toBe(0);
	});

	it("comes from the same single readdir pass as the typed marker fields", () => {
		write("tsconfig.json");
		getDirectoryMarkers(root);
		expect(fs.readdirSync).toHaveBeenCalledTimes(1);
	});
});

describe("findNearestDirWithAnyBasename (#807)", () => {
	it("walks up to the nearest ancestor containing any basename in the list", () => {
		write("pyproject.toml");
		const sub = path.join(root, "apps", "svc");
		fs.mkdirSync(sub, { recursive: true });
		expect(
			findNearestDirWithAnyBasename(
				sub,
				["package.json", "pyproject.toml", "setup.py"],
				"/nonexistent-home-zzz",
			),
		).toBe(root);
	});

	it("returns undefined when none of the basenames are found before the fs root", () => {
		const sub = path.join(root, "apps", "svc");
		fs.mkdirSync(sub, { recursive: true });
		expect(
			findNearestDirWithAnyBasename(
				sub,
				["Cargo.toml"],
				"/nonexistent-home-zzz",
			),
		).toBeUndefined();
	});

	it("resolves a multi-segment (nested path) marker via a confirming existsSync, not entryNames", () => {
		write(path.join("prisma", "schema.prisma"), "datasource db {}\n");
		const sub = path.join(root, "src");
		fs.mkdirSync(sub, { recursive: true });
		expect(
			findNearestDirWithAnyBasename(
				sub,
				["prisma/schema.prisma"],
				"/nonexistent-home-zzz",
			),
		).toBe(root);
	});

	it("never resolves a marker at or above the home-dir ceiling", () => {
		write("package.json");
		const project = path.join(root, "project", "src");
		fs.mkdirSync(project, { recursive: true });
		expect(
			findNearestDirWithAnyBasename(project, ["package.json"], root),
		).toBeUndefined();
	});

	it("returns undefined immediately for an empty basenames list", () => {
		const sub = path.join(root, "src");
		fs.mkdirSync(sub, { recursive: true });
		expect(
			findNearestDirWithAnyBasename(sub, [], "/nonexistent-home-zzz"),
		).toBeUndefined();
	});

	it("shares the per-directory readdir cache with findNearestDirWithMarker (no re-listing)", () => {
		write("tsconfig.json");
		const sub = path.join(root, "src");
		fs.mkdirSync(sub, { recursive: true });

		// Warm the per-directory cache via the typed-field walker first.
		expect(findGoverningTsconfigDir(sub, "/nonexistent-home-zzz")).toBe(root);

		vi.mocked(fs.readdirSync).mockClear();
		expect(
			findNearestDirWithAnyBasename(
				sub,
				["tsconfig.json"],
				"/nonexistent-home-zzz",
			),
		).toBe(root);
		// Same directories, same cache — no fresh readdir needed.
		expect(fs.readdirSync).not.toHaveBeenCalled();
	});

	it("caps the climb and logs a phase entry instead of truncating silently", () => {
		const logSpy = vi
			.spyOn(latencyLogger, "logLatency")
			.mockImplementation(() => {});

		const segments = Array.from({ length: 100 }, (_, i) => `level${i}`);
		const deepStart = path.join(
			path.parse(root).root,
			"synthetic-any-basename-cap-test",
			...segments,
		);
		const result = findNearestDirWithAnyBasename(
			deepStart,
			["package.json"],
			path.join(path.parse(root).root, "definitely-not-a-real-home-zzz"),
		);

		expect(result).toBeUndefined();
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "phase",
				phase: "workspace-topology-walk-cap",
			}),
		);
	});
});

describe("getWorkspaceManifestMarkers", () => {
	it("reports presence of each workspace manifest marker", () => {
		write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
		const markers = getWorkspaceManifestMarkers(root);
		expect(markers.hasPnpmWorkspaceYaml).toBe(true);
		expect(markers.hasGoWork).toBe(false);
		expect(markers.hasCargoToml).toBe(false);
		expect(markers.hasPackageJson).toBe(false);
	});
});

describe("resetWorkspaceTopology", () => {
	it("clears the per-directory marker cache so the next access re-scans", () => {
		write("tsconfig.json");
		getDirectoryMarkers(root); // populate cache

		vi.mocked(fs.readdirSync).mockClear();
		getDirectoryMarkers(root);
		expect(fs.readdirSync).not.toHaveBeenCalled();

		resetWorkspaceTopology();

		vi.mocked(fs.readdirSync).mockClear();
		getDirectoryMarkers(root);
		expect(fs.readdirSync).toHaveBeenCalledTimes(1);
	});

	it("clears the upward-walk cache so a reset forces a fresh climb", () => {
		write("tsconfig.json");
		const sub = path.join(root, "src");
		fs.mkdirSync(sub, { recursive: true });
		expect(findGoverningTsconfigDir(sub, "/nonexistent-home-zzz")).toBe(root);

		// Cache hit: neither the walk cache nor the per-dir marker cache is
		// touched, so no directory gets re-listed.
		vi.mocked(fs.readdirSync).mockClear();
		findGoverningTsconfigDir(sub, "/nonexistent-home-zzz");
		expect(fs.readdirSync).not.toHaveBeenCalled();

		resetWorkspaceTopology();

		// Post-reset: both caches are empty, so the climb re-lists every
		// directory it visits on the way to (and including) `root`.
		vi.mocked(fs.readdirSync).mockClear();
		expect(findGoverningTsconfigDir(sub, "/nonexistent-home-zzz")).toBe(root);
		expect(fs.readdirSync).toHaveBeenCalled();
	});
});
describe("workspace-topology Tier-2 idle recovery (#1389)", () => {
	it("evicts an idle marker entry and rebuilds it on the next access", () => {
		const previous = process.env.PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS;
		process.env.PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS = "10";
		vi.useFakeTimers();
		try {
			write("tsconfig.json");
			getDirectoryMarkers(root);
			vi.mocked(fs.readdirSync).mockClear();
			vi.advanceTimersByTime(11);
			getDirectoryMarkers(root);
			expect(fs.readdirSync).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
			if (previous === undefined)
				delete process.env.PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS;
			else process.env.PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS = previous;
		}
	});
});
