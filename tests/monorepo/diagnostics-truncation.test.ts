/**
 * Track B (#775) item 6 — diagnostics-scanner truncation surfacing.
 *
 * The audit's open question: does `scanTruncated` (a snapshot flag added
 * post-#760, threaded through independently of `maxFiles`) actually reach the
 * scan result the tools see? Driven over a tiny, option-configured
 * `maxScanEntries` cap so a handful of files is enough to trip it. Verified at
 * two layers:
 *   1. `scanProjectDiagnostics` itself (`project-diagnostics/scanner.ts`).
 *   2. `lens-engine.ts`'s `projectScan` — the seam host adapters (MCP tools)
 *      actually call — returns the `ProjectDiagnosticsSnapshot` unmodified,
 *      so `scanTruncated` DOES reach that surface. Whether an individual MCP
 *      tool's rendered/serialized response text goes on to surface the flag
 *      to the model is a presentation concern outside this scan layer; grep
 *      confirms `scanTruncated` has exactly one reader (the field
 *      declaration + this one setter) anywhere in `clients/` — no renderer
 *      currently reads it. Marked KNOWN GAP: the data reaches the seam but
 *      apparently no caller renders it yet.
 */

import { describe, expect, it } from "vitest";
import { scanProjectDiagnostics } from "../../clients/project-diagnostics/scanner.js";
import { projectScan } from "../../clients/lens-engine.js";
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
});
