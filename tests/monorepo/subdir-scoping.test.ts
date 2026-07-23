/**
 * Track B (#775) item 4 — session-in-package-subdir scoping.
 *
 * Pins the audit's "already monorepo-correct" verified finding: running the
 * relevant root-resolution helpers from `packages/a` (a subdirectory with its
 * own `package.json`) anchors to the PACKAGE, not the monorepo root — because
 * `findNearestProjectRoot` (startup-scan.ts) and `.pi-lens.json` discovery
 * (`findPiLensProjectConfig`, walking up via `walkUpDirs`) both stop at the
 * FIRST marker found while climbing upward, and a package-local `package.json`
 * is one of `PROJECT_ROOT_MARKERS`.
 */

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { findNearestProjectRoot, resolveStartupScanContext } from "../../clients/startup-scan.js";
import {
	findPiLensProjectConfig,
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import { makeMonorepo, type MonorepoPackageSpec } from "./fixture.js";

describe("session started from a package subdirectory anchors to the package, not the monorepo root (#775 item 4)", () => {
	it("findNearestProjectRoot from packages/a resolves to the package dir, not the repo root", () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: { "src/index.ts": "export const a = 1;\n" },
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const packageDir = repo.packageDir("@scope/a");
			const root = findNearestProjectRoot(packageDir);
			expect(root).toBe(path.resolve(packageDir));
			expect(root).not.toBe(path.resolve(repo.root));
		} finally {
			repo.cleanup();
		}
	});

	it("resolveStartupScanContext started from packages/a scopes canWarmCaches/sourceFileCount to the package subtree only", () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"src/one.ts": "export const one = 1;\n",
				"src/two.ts": "export const two = 2;\n",
			},
		};
		const other: MonorepoPackageSpec = {
			name: "@scope/b",
			dir: "packages/b",
			files: {
				// Many files in a SIBLING package that must NOT be counted when the
				// session starts inside packages/a.
				"src/x1.ts": "export const x1 = 1;\n",
				"src/x2.ts": "export const x2 = 1;\n",
				"src/x3.ts": "export const x3 = 1;\n",
				"src/x4.ts": "export const x4 = 1;\n",
			},
		};
		const repo = makeMonorepo({ packages: [pkg, other] });
		try {
			const packageDir = repo.packageDir("@scope/a");
			const ctx = resolveStartupScanContext(packageDir, {
				homeDir: repo.root + "-not-home",
			});
			expect(ctx.projectRoot).toBe(path.resolve(packageDir));
			expect(ctx.canWarmCaches).toBe(true);
			// Only packages/a's own 2 files — packages/b's 4 files are invisible
			// from this scoped root.
			expect(ctx.sourceFileCount).toBe(2);
		} finally {
			repo.cleanup();
		}
	});

	it("a package-local .pi-lens.json is discovered from within the package, ahead of any root config", () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: { "src/index.ts": "export const a = 1;\n" },
			piLensConfig: { maxProjectFiles: 1234 },
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 9999 },
		});
		try {
			resetProjectLensConfigCache();
			const packageDir = repo.packageDir("@scope/a");
			const info = findPiLensProjectConfig(packageDir);
			expect(info?.dir).toBe(path.resolve(packageDir));
			const config = loadPiLensProjectConfig(packageDir);
			expect(config.maxProjectFiles).toBe(1234);
		} finally {
			resetProjectLensConfigCache();
			repo.cleanup();
		}
	});
});
