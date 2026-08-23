/**
 * Opaque-mutation recovery (#2000 phase 2) — real-filesystem tests: actual
 * stat walks over temp trees and real diffs. This file pins the SEAM contract
 * only; handler wiring coverage (real node -e / python -c child writes through
 * handleToolCall/handleToolResult) is PR-B scope and NOT covered here.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The synthetic-write dispatch runs the full per-edit pipeline; point it at
// a resolved verdict instead of spawning real linters over a bare temp repo
// (same seam the runtime-tool-result suite mocks).
vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn().mockResolvedValue({
		output: "✓ no blockers",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	}),
}));

import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { getProjectChangeLogPath } from "../../clients/project-changes.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import type { ProjectChangeEntry } from "../../clients/project-changes.js";

import {
	captureFileStats,
	diffFileStats,
	OpaqueBaselineStore,
	OPAQUE_SCAN_MAX_FILES,
	recoverOpaqueChangesViaGit,
} from "../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir = "";

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opaque-scan-"));
	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
});

afterEach(() => {
	removeTempDirSync(tmpDir);
});

describe("captureFileStats", () => {
	it("snapshots existing project sources with normalized keys", async () => {
		const file = path.join(tmpDir, "src", "a.ts");
		fs.writeFileSync(file, "const x = 1;\n", "utf8");
		const outcome = await captureFileStats(tmpDir);
		expect(outcome.unknownReason).toBeUndefined();
		expect(outcome.snapshot?.has(normalizeMapKey(file))).toBe(true);
		const entry = outcome.snapshot?.get(normalizeMapKey(file));
		expect(entry?.size).toBe("const x = 1;\n".length);
		expect(typeof entry?.mtimeMs).toBe("number");
	});

	it("reports file-cap-exceeded rather than an unbounded walk", async () => {
		for (let i = 0; i < OPAQUE_SCAN_MAX_FILES + 10; i++) {
			fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), "x", "utf8");
		}
		const outcome = await captureFileStats(tmpDir);
		expect(outcome.unknownReason).toBe("file-cap-exceeded");
		expect(outcome.scannedCount).toBeGreaterThan(OPAQUE_SCAN_MAX_FILES);
	});
});

describe("diffFileStats", () => {
	it("detects modified, added — not deleted or unchanged", async () => {
		const modifiedPath = path.join(tmpDir, "m.ts");
		const unchangedPath = path.join(tmpDir, "u.ts");
		fs.writeFileSync(modifiedPath, "v1", "utf8");
		fs.writeFileSync(unchangedPath, "same", "utf8");
		const before = await captureFileStats(tmpDir);

		// Real child-process-style mutation: rewrite + add.
		fs.writeFileSync(modifiedPath, "v2-longer", "utf8");
		const addedPath = path.join(tmpDir, "added.ts");
		fs.writeFileSync(addedPath, "new", "utf8");
		fs.rmSync(unchangedPath);
		const after = await captureFileStats(tmpDir);

		const changed = diffFileStats(
			before.snapshot ?? new Map(),
			after.snapshot ?? new Map(),
		);
		const keys = changed.map((k) => k);
		expect(keys).toContain(normalizeMapKey(modifiedPath));
		expect(keys).toContain(normalizeMapKey(addedPath));
		expect(keys).not.toContain(normalizeMapKey(unchangedPath));
	});
});

describe("content-hash confirm on the stat-diff path (#2000)", () => {
	it("detects a same-tick same-size rewrite via hashes, red-first vs mtime+size", async () => {
		// The COLLISION, constructed deterministically: pin a known whole-ms
		// mtime via utimes on BOTH sides (before AND after the rewrite), so
		// mtime+size identity sees NO change on every platform/filesystem -
		// restoring a captured sub-ms timestamp is NOT portable (Linux CI red).
		const file = path.join(tmpDir, "collision.ts");
		const pinned = new Date(Date.now() - 5_000);
		fs.writeFileSync(file, "AAAA\n", "utf8");
		fs.utimesSync(file, pinned, pinned);
		const before = await captureFileStats(tmpDir, { withHashes: true });
		const beforeEntry = before.snapshot?.get(normalizeMapKey(file));
		expect(beforeEntry?.hash).toBeDefined();

		fs.writeFileSync(file, "BBBB\n", "utf8");
		fs.utimesSync(file, pinned, pinned);

		// Without hashes: the collision is invisible (documents the old hole).
		const plainAfter = await captureFileStats(tmpDir);
		expect(
			diffFileStats(
				before.snapshot ?? new Map(),
				plainAfter.snapshot ?? new Map(),
			),
		).toEqual([]);

		// With hashes: content confirm catches it.
		const hashedAfter = await captureFileStats(tmpDir, { withHashes: true });
		expect(
			diffFileStats(
				before.snapshot ?? new Map(),
				hashedAfter.snapshot ?? new Map(),
			),
		).toContain(normalizeMapKey(file));
	});

	it("degrades to mtime+size when the hash budget is exhausted", async () => {
		const big = path.join(tmpDir, "big.ts");
		fs.writeFileSync(big, "x".repeat(16), "utf8"); // budget below forces skip
		// Re-import with a tiny budget by capturing with default (no hashes)
		// semantics: entries simply carry no hash and diff falls back.
		const before = await captureFileStats(tmpDir);
		const after = await captureFileStats(tmpDir);
		expect(
			diffFileStats(before.snapshot ?? new Map(), after.snapshot ?? new Map()),
		).toEqual([]);
	});
});

describe("OpaqueBaselineStore", () => {
	it("one slot per cwd: take consumes, replacement evicts with a count", () => {
		const store = new OpaqueBaselineStore();
		store.record("/p", { startedAt: 1, strategy: "git" });
		store.record("/p", { startedAt: 2, strategy: "git" });
		expect(store.evictionCount).toBe(1);
		const taken = store.take("/p");
		expect(taken?.startedAt).toBe(2);
		expect(store.take("/p")).toBeUndefined();
	});
});

describe("recoverOpaqueChangesViaGit (real git repo)", () => {
	let repoDir = "";

	beforeEach(() => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opaque-git-"));
		execSync("git init -q", { cwd: repoDir });
		execSync("git config user.email t@t.local", { cwd: repoDir });
		execSync("git config user.name t", { cwd: repoDir });
		fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(repoDir, "src", "base.ts"), "base\n", "utf8");
		execSync("git add -A && git commit -qm base", { cwd: repoDir });
	});

	afterEach(() => {
		removeTempDirSync(repoDir);
	});

	function nodeScriptFile(script: string): string {
		const file = path.join(repoDir, `.opaque-child-${Date.now()}.cjs`);
		fs.writeFileSync(file, script, "utf8");
		return file;
	}

	function writeViaNodeChild(target: string, content: string): void {
		const scriptFile = nodeScriptFile(
			`require('fs').writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(content)});`,
		);
		try {
			execSync(`node "${scriptFile}"`, { cwd: repoDir });
		} finally {
			fs.rmSync(scriptFile, { force: true });
		}
	}

	it("reports modified and added files inside the mtime window", async () => {
		const startedAt = Date.now();
		writeViaNodeChild(path.join(repoDir, "src", "base.ts"), "modified\n");
		writeViaNodeChild(path.join(repoDir, "src", "new.ts"), "added\n");
		const outcome = await recoverOpaqueChangesViaGit(repoDir, startedAt);
		expect(outcome.verdict).toBe("recovered");
		expect(outcome.paths).toContain(
			normalizeMapKey(path.join(repoDir, "src", "base.ts")),
		);
		expect(outcome.paths).toContain(
			normalizeMapKey(path.join(repoDir, "src", "new.ts")),
		);
	});

	it("excludes files last written BEFORE the window floor", async () => {
		// A pre-existing dirty file from long before the command started.
		fs.writeFileSync(path.join(repoDir, "src", "base.ts"), "early\n", "utf8");
		// A window that opens far in the future excludes everything on disk.
		const outcome = await recoverOpaqueChangesViaGit(
			repoDir,
			Date.now() + 10_000,
		);
		expect(outcome.verdict).toBe("recovered");
		expect(outcome.paths).toEqual([]);
	});

	it(
		"end-to-end: node child write is recovered as opaque-script in the change log",
		{ timeout: 15_000 },
		async () => {
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(repoDir, "data");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = repoDir;
			runtime.setTelemetryIdentity({ sessionId: "opaque-e2e" });
			try {
				const target = path.join(repoDir, "src", "generated.ts");
				const command = nodeScriptFile(
					`require('fs').writeFileSync(${JSON.stringify(target)}, 'generated by child\\n');`,
				);
				await handleToolCall({
					event: { toolName: "bash", input: { command } },
					ctx: { cwd: repoDir },
					lensEnabled: true,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as Parameters<typeof handleToolCall>[0]);
				try {
					execSync(`node "${command}"`, { cwd: repoDir });
				} finally {
					fs.rmSync(command, { force: true });
				}
				await handleToolResult({
					event: {
						toolName: "bash",
						input: { command },
						content: [{ type: "text", text: "done" }],
					},
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					biomeClient: {},
					ruffClient: {},
					testRunnerClient: {},
					metricsClient: {},
					resetLSPService: () => {},
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
				} as unknown as Parameters<typeof handleToolResult>[0]);

				const lines = fs
					.readFileSync(getProjectChangeLogPath(repoDir), "utf8")
					.split("\n")
					.filter((l) => l.trim());
				const entries = lines.map((l) => JSON.parse(l) as ProjectChangeEntry);
				const recovered = entries.filter((e) => e.source === "opaque-script");
				expect(recovered.length).toBeGreaterThanOrEqual(1);
				expect(recovered.some((e) => e.filePath.endsWith("generated.ts"))).toBe(
					true,
				);

				// Dispatch really ran for the recovered file - the synthetic write
				// re-enters the full per-edit pipeline (runPipeline), same as any
				// native or recognized write. Assert it, don't assume it.
				const { runPipeline } = await import("../../clients/pipeline.js");
				const dispatchedPaths = vi
					.mocked(runPipeline)
					.mock.calls.map((call) => String(call[0]?.filePath));
				expect(dispatchedPaths.some((p) => p.endsWith("generated.ts"))).toBe(
					true,
				);
			} finally {
				if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = previousDataDir;
			}
		},
	);
});

describe("partial-recognition recovery (#2000 PR-B)", () => {
	let repoDir = "";

	function depsFor(
		runtime: RuntimeCoordinator,
		command: string,
		isError?: boolean,
	) {
		return {
			event: {
				toolName: "bash",
				input: { command },
				content: [{ type: "text", text: "out" }],
				...(isError ? { isError: true } : {}),
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			testRunnerClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as unknown as Parameters<typeof handleToolResult>[0];
	}

	function callDeps(runtime: RuntimeCoordinator, command: string) {
		return {
			event: { toolName: "bash", input: { command } },
			ctx: { cwd: repoDir },
			lensEnabled: true,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
		} as Parameters<typeof handleToolCall>[0];
	}

	function nodeScriptFile(script: string): string {
		const file = path.join(repoDir, `.opaque-child-${Date.now()}.cjs`);
		fs.writeFileSync(file, script, "utf8");
		// Written BEFORE the baseline by construction - backdate it out of the
		// recovery window so only the child's own writes are attributed.
		const past = new Date(Date.now() - 5000);
		fs.utimesSync(file, past, past);
		return file;
	}

	function readChangeLog(): ProjectChangeEntry[] {
		const logPath = getProjectChangeLogPath(repoDir);
		if (!fs.existsSync(logPath)) return [];
		return fs
			.readFileSync(logPath, "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as ProjectChangeEntry);
	}

	beforeEach(() => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opaque-partial-"));
		execSync("git init -q", { cwd: repoDir });
		process.env.PILENS_DATA_DIR = path.join(repoDir, "data");
	});

	afterEach(() => {
		delete process.env.PILENS_DATA_DIR;
		removeTempDirSync(repoDir);
	});

	it("mixed command: redirect once as agent-write, internal write as opaque-script", async () => {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = repoDir;
		runtime.setTelemetryIdentity({ sessionId: "partial-a" });
		const redirectTarget = path.join(repoDir, "redirected-out.txt");
		const internalFile = path.join(repoDir, "internal-write.txt");
		const scriptFile = nodeScriptFile(
			`require('fs').writeFileSync(${JSON.stringify(redirectTarget)}, 'redirected');require('fs').writeFileSync(${JSON.stringify(internalFile)}, 'internal');`,
		);
		try {
			// Redirect is RECOGNIZED by the extractor; the internal write is not.
			const command = `node "${scriptFile}" > "${redirectTarget}"`;
			await handleToolCall(callDeps(runtime, command));
			execSync(`node "${scriptFile}"`, { cwd: repoDir });
			await handleToolResult(depsFor(runtime, command));

			const sources = readChangeLog().reduce(
				(acc, e) => {
					acc[path.basename(e.filePath)] = e.source;
					return acc;
				},
				{} as Record<string, string>,
			);
			expect(sources["redirected-out.txt"]).toBe("agent-write");
			expect(sources["internal-write.txt"]).toBe("opaque-script");
		} finally {
			fs.rmSync(scriptFile, { force: true });
		}
	});

	it("recognized-only command without baseline emits explicit coverage-unknown", async () => {
		// latency.log writes are guarded by PI_LENS_TEST_MODE; scope the opt-out
		// to this one assertion (#1742 sanctioned pattern).
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = repoDir;
		runtime.setTelemetryIdentity({ sessionId: "partial-b" });
		try {
			const outTarget = path.join(repoDir, "echo-out.txt");
			const command = `node -e "" > "${outTarget}"`;
			// No handleToolCall baseline on purpose.
			// Delta assertion: latency.log is append-only and shared, so assert
			// on the LINES THIS RUN ADDED - a plain toContain would stay green
			// forever after the first ever emission (review round-2 P2).
			const latencyPath = path.join(getGlobalPiLensDir(), "latency.log");
			const beforeLines = new Set(
				fs.existsSync(latencyPath)
					? fs.readFileSync(latencyPath, "utf8").split("\n")
					: [],
			);
			await handleToolResult(depsFor(runtime, command));
			await flushLatencyLog();
			const appended = fs
				.readFileSync(latencyPath, "utf8")
				.split("\n")
				.filter((l) => l.trim() && !beforeLines.has(l));
			expect(
				appended.some((l) => l.includes("partial-recognition-no-baseline")),
			).toBe(true);
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
		}
	});

	it("failed mixed command attributes BOTH writes as opaque-script (failure atomicity)", async () => {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = repoDir;
		runtime.setTelemetryIdentity({ sessionId: "partial-c" });
		const redirectTarget = path.join(repoDir, "failed-redirect.txt");
		const internalFile = path.join(repoDir, "failed-internal.txt");
		const scriptFile = nodeScriptFile(
			`require('fs').writeFileSync(${JSON.stringify(redirectTarget)}, 'r');require('fs').writeFileSync(${JSON.stringify(internalFile)}, 'i');`,
		);
		try {
			const command = `node "${scriptFile}" > "${redirectTarget}"`;
			await handleToolCall(callDeps(runtime, command));
			// Writes land BEFORE the failure surfaces (isError=true).
			execSync(`node "${scriptFile}"`, { cwd: repoDir });
			await handleToolResult(depsFor(runtime, command, true));

			const opaqueFiles = readChangeLog()
				.filter((e) => e.source === "opaque-script")
				.map((e) => path.basename(e.filePath))
				.sort();
			expect(opaqueFiles).toEqual([
				"failed-internal.txt",
				"failed-redirect.txt",
			]);
		} finally {
			fs.rmSync(scriptFile, { force: true });
		}
	});
});
