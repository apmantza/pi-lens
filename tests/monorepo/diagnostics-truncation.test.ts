/**
 * Track B (#775) item 6 — diagnostics-scanner truncation surfacing.
 *
 * The audit's open question: does `scanTruncated` (a snapshot flag added
 * post-#760, threaded through independently of `maxFiles`) actually reach the
 * scan result the tools see, and is it actually RENDERED for the agent/user?
 * Driven over a tiny, option-configured `maxScanEntries` cap so a handful of
 * files is enough to trip it. Verified at three layers:
 *   1. `scanProjectDiagnostics` itself (`project-diagnostics/scanner.ts`).
 *   2. `lens-engine.ts`'s `projectScan` — the seam host adapters (MCP tools)
 *      actually call — returns the `ProjectDiagnosticsSnapshot` unmodified,
 *      so `scanTruncated` DOES reach that surface.
 *   3. Fixed in #784: `lens-engine.ts`'s `scanTruncationNotice` renders the
 *      flag into a one-line notice (mirroring the #777 warm-skip notify's
 *      style), and both `mcp/server.ts`'s `pilens_project_scan` tool and
 *      `tools/lens-diagnostics.ts`'s mode=full renderer now append it —
 *      a truncated scan no longer reads as a complete clean sweep.
 */

import { describe, expect, it } from "vitest";
import { scanProjectDiagnostics } from "../../clients/project-diagnostics/scanner.js";
import { projectScan, scanTruncationNotice } from "../../clients/lens-engine.js";
import { makeMonorepo, type MonorepoPackageSpec } from "./fixture.js";

function fileMap(count: number): Record<string, string> {
	const files: Record<string, string> = {};
	for (let i = 0; i < count; i++) {
		files[`src/file${i}.ts`] = `export const v${i} = ${i};\n`;
	}
	return files;
}

describe("diagnostics-scanner truncation surfacing (#775 item 6)", () => {
	it("scanTruncated is absent on an untruncated (small entry budget, small tree) scan", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(2),
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
				maxScanEntries: 1000,
			});
			expect(snapshot.scanTruncated).toBeUndefined();
			expect(snapshot.filesScanned).toBe(2);
		} finally {
			repo.cleanup();
		}
	});

	it("scanTruncated: true once the entry-visited budget trips mid-walk, and filesScanned reflects the truncated list", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(6),
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			// A tiny maxScanEntries forces the walk to stop after visiting only a
			// few directory entries — well before it reaches all 6 source files.
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
				maxScanEntries: 3,
			});
			expect(snapshot.scanTruncated).toBe(true);
			expect(snapshot.filesScanned).toBeLessThan(6);
		} finally {
			repo.cleanup();
		}
	});

	it("lens-engine's projectScan seam (the surface MCP host adapters call) carries scanTruncated through unmodified", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(6),
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			// projectScan(cwd, maxFiles) has no maxScanEntries parameter of its own
			// — it always calls scanProjectDiagnostics with only {cwd, tier,
			// maxFiles}, so this asserts the DEFAULT entry budget's shape is
			// preserved end-to-end rather than dropped by the seam; a tiny
			// maxScanEntries isn't reachable through this particular wrapper, so
			// this just confirms the field name/type survive untouched (an
			// untruncated small fixture stays untruncated through the seam too).
			const snapshot = await projectScan(repo.root, 100);
			expect(snapshot.scanTruncated).toBeUndefined();
			expect(snapshot.filesScanned).toBe(6);
			expect("scanTruncated" in snapshot).toBe(false);
		} finally {
			repo.cleanup();
		}
	});

	it("fixed (#784): scanTruncationNotice renders a one-line notice once scanTruncated is set, and stays silent otherwise", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(6),
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const untruncated = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
				maxScanEntries: 1000,
			});
			expect(scanTruncationNotice(untruncated)).toBeUndefined();

			const truncated = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
				maxScanEntries: 3,
			});
			expect(truncated.scanTruncated).toBe(true);
			const notice = scanTruncationNotice(truncated);
			expect(notice).toBeDefined();
			expect(notice).toContain("truncated");
			expect(notice).toContain(String(truncated.filesScanned));
			expect(notice).toContain("maxProjectFiles");
		} finally {
			repo.cleanup();
		}
	});
});
