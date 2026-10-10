import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BiomeClient } from "../../clients/biome-client.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir && fs.existsSync(dir)) {
			removeTempDirSync(dir);
		}
	}
	vi.restoreAllMocks();
});

function setupMonorepo(): {
	workspaceRoot: string;
	subPackageRoot: string;
	subBiomeBin: string;
} {
	const workspaceRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-biome-monorepo-"),
	);
	tmpDirs.push(workspaceRoot);
	const subPackageRoot = path.join(workspaceRoot, "packages", "app");
	fs.mkdirSync(subPackageRoot, { recursive: true });

	const isWin = process.platform === "win32";
	const subBin = path.join(subPackageRoot, "node_modules", ".bin");
	fs.mkdirSync(subBin, { recursive: true });
	const subBiomeBin = path.join(subBin, isWin ? "biome.cmd" : "biome");
	fs.writeFileSync(subBiomeBin, "#!/bin/sh\necho mock biome\n");
	if (!isWin) fs.chmodSync(subBiomeBin, 0o755);

	return { workspaceRoot, subPackageRoot, subBiomeBin };
}

describe("BiomeClient — per-cwd binary resolution (#121)", () => {
	// This suite plants per-cwd project binaries on purpose; the trust gate is
	// witnessed in `project-local-bin-trust.test.ts`.
	beforeEach(() => setProjectTrustState("trusted"));

	it("resolves the sub-package's biome when cwd points there, not process.cwd()'s", async () => {
		const { workspaceRoot, subPackageRoot, subBiomeBin } = setupMonorepo();
		// Anchor process.cwd() at the workspace root, which has NO biome.
		const previousCwd = process.cwd();
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workspaceRoot);
		try {
			const client = new BiomeClient();
			// Without cwd → resolves against the workspace root, which has no
			// local biome in node_modules. It may still find an auto-installed
			// binary in ~/.pi-lens/tools or a manager's global bin, so the only
			// invariant we can assert is that it is NOT the sub-package's binary.
			const noCwd = await (
				client as unknown as {
					getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
				}
			).getBiomeBinary();
			expect(noCwd.cmd).not.toBe(subBiomeBin);

			// With cwd pointing at the sub-package → finds the local binary
			// before any pi-lens-global fallback.
			const withCwd = await (
				client as unknown as {
					getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
				}
			).getBiomeBinary(subPackageRoot);
			expect(withCwd.cmd).toBe(subBiomeBin);
		} finally {
			cwdSpy.mockRestore();
			// Sanity: spy restored.
			expect(process.cwd()).toBe(previousCwd);
		}
	});

	it("caches the resolved binary per cwd so two sub-packages do not collide", async () => {
		const workspaceRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-biome-twopkg-"),
		);
		tmpDirs.push(workspaceRoot);
		const isWin = process.platform === "win32";
		const binName = isWin ? "biome.cmd" : "biome";

		const pkgA = path.join(workspaceRoot, "packages", "a");
		const pkgB = path.join(workspaceRoot, "packages", "b");
		const aBin = path.join(pkgA, "node_modules", ".bin", binName);
		const bBin = path.join(pkgB, "node_modules", ".bin", binName);
		fs.mkdirSync(path.dirname(aBin), { recursive: true });
		fs.mkdirSync(path.dirname(bBin), { recursive: true });
		fs.writeFileSync(aBin, "#!/bin/sh\necho a\n");
		fs.writeFileSync(bBin, "#!/bin/sh\necho b\n");
		if (!isWin) {
			fs.chmodSync(aBin, 0o755);
			fs.chmodSync(bBin, 0o755);
		}

		const client = new BiomeClient();
		const resolveA = await (
			client as unknown as {
				getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
			}
		).getBiomeBinary(pkgA);
		const resolveB = await (
			client as unknown as {
				getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
			}
		).getBiomeBinary(pkgB);
		expect(resolveA.cmd).toBe(aBin);
		expect(resolveB.cmd).toBe(bBin);
		// Re-resolving against pkgA still returns pkgA's binary, not bBin.
		const resolveAgain = await (
			client as unknown as {
				getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
			}
		).getBiomeBinary(pkgA);
		expect(resolveAgain.cmd).toBe(aBin);
	});

	// #1731 discipline B: `getBiomeBinary` returned `autoInstalledBinaryPath`
	// (set once, session-wide, the first time ANY cwd auto-installs biome)
	// before it ever looked at THIS cwd's own node_modules/.bin/biome. Once one
	// project in the session triggered an auto-install, every other project's
	// own biome install stopped mattering.
	it("prefers this cwd's own biome over a managed binary auto-installed for a different cwd", async () => {
		const { subPackageRoot, subBiomeBin } = setupMonorepo();

		const client = new BiomeClient();
		// Simulate what `doEnsureAvailable()` sets after auto-installing for some
		// EARLIER cwd this session — a real absolute path, unrelated to
		// `subPackageRoot`.
		(
			client as unknown as { autoInstalledBinaryPath: string | null }
		).autoInstalledBinaryPath = path.join(
			os.tmpdir(),
			"pi-lens-managed-biome",
			"biome",
		);

		const resolved = await (
			client as unknown as {
				getBiomeBinary(cwd?: string): Promise<{ cmd: string }>;
			}
		).getBiomeBinary(subPackageRoot);

		expect(resolved.cmd).toBe(subBiomeBin);
	});
});
