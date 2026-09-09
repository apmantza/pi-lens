import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	GITHUB_TOOLS,
	GitHubToolId,
	resolveGitHubAssetLauncher,
} from "../../../clients/installer/index.js";

// Ensure the real installer module is used, not any mock registered by other test files
vi.unmock("../../../clients/installer/index.js");

const SUPPORTED_PLATFORMS = ["linux", "darwin", "win32"] as const;
const COMMON_ARCHES = ["x64", "arm64"] as const;

describe("GitHub release asset selection", () => {
	it.each([
		["php-cs-fixer", "linux", "x64", "php-cs-fixer.phar", "php"],
		["php-cs-fixer", "win32", "x64", "php-cs-fixer.phar", "php"],
		["cljfmt", "darwin", "arm64", "standalone.jar", "java"],
		["cljfmt", "linux", "arm64", "standalone.jar", "java"],
		["cljfmt", "linux", "x64", "linux-amd64-static.tar.gz", undefined],
	] as const)(
		"maps %s %s/%s asset %s to launcher %s",
		(toolId, platform, _arch, asset, launcher) => {
			expect(resolveGitHubAssetLauncher(toolId, platform, asset)).toBe(
				launcher,
			);
		},
	);
	it("every github tool has an asset for all supported platform/arch combos", async () => {
		const { resolveGitHubAsset } =
			await import("../../../clients/installer/index.js");

		const missing: string[] = [];
		for (const toolId of GITHUB_TOOLS) {
			for (const platform of SUPPORTED_PLATFORMS) {
				for (const arch of COMMON_ARCHES) {
					const asset = resolveGitHubAsset(toolId, platform, arch);
					if (!asset) {
						missing.push(`${toolId} / ${platform} / ${arch}`);
					}
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it("returns undefined for unsupported platforms", async () => {
		const { resolveGitHubAsset } =
			await import("../../../clients/installer/index.js");

		for (const toolId of GITHUB_TOOLS) {
			expect(resolveGitHubAsset(toolId, "freebsd", "x64")).toBeUndefined();
			expect(resolveGitHubAsset(toolId, "sunos", "x64")).toBeUndefined();
		}
	});

	// Table-driven entries (archAssetMatch) only carry x64/arm64 assets, so an
	// exotic arch must resolve to nothing rather than to the x64 substring.
	it("returns undefined for a non-x64/arm64 arch on table-driven tools", async () => {
		const { resolveGitHubAsset } =
			await import("../../../clients/installer/index.js");

		for (const toolId of ["gitleaks", "terragrunt"] as const) {
			expect(resolveGitHubAsset(toolId, "linux", "ia32")).toBeUndefined();
			expect(resolveGitHubAsset(toolId, "win32", "ia32")).toBeUndefined();
		}
	});

	// Bare-binary tools (terragrunt/marksman/expert) resolve to the FULL asset
	// name, which is a strict prefix of every signature/checksum sibling — a
	// plain `includes` scan installs the sidecar it happens to see first.
	describe("pickReleaseAsset", () => {
		it("prefers the exact asset over a signature sibling listed first", async () => {
			const { pickReleaseAsset } =
				await import("../../../clients/installer/index.js");
			const assets = [
				{ name: "terragrunt_linux_amd64.asc" },
				{ name: "terragrunt_linux_amd64" },
			];
			expect(pickReleaseAsset(assets, "terragrunt_linux_amd64")?.name).toBe(
				"terragrunt_linux_amd64",
			);
		});

		it("skips sidecars when only a substring match exists", async () => {
			const { pickReleaseAsset } =
				await import("../../../clients/installer/index.js");
			const assets = [
				{ name: "tflint_linux_amd64.zip.sha256" },
				{ name: "tflint_linux_amd64.zip" },
			];
			expect(pickReleaseAsset(assets, "linux_amd64.zip")?.name).toBe(
				"tflint_linux_amd64.zip",
			);
		});

		it("returns undefined when every match is a sidecar", async () => {
			const { pickReleaseAsset } =
				await import("../../../clients/installer/index.js");
			expect(
				pickReleaseAsset(
					[{ name: "expert_linux_amd64.sig" }],
					"expert_linux_amd64",
				),
			).toBeUndefined();
		});

		it("still matches a plain substring asset with no sidecars present", async () => {
			const { pickReleaseAsset } =
				await import("../../../clients/installer/index.js");
			expect(
				pickReleaseAsset([{ name: "marksman-linux-x64" }], "marksman-linux-x64")
					?.name,
			).toBe("marksman-linux-x64");
		});
	});

	it("returns undefined for unknown tool id", async () => {
		const { resolveGitHubAsset } =
			await import("../../../clients/installer/index.js");
		expect(
			resolveGitHubAsset("nonexistent-tool" as GitHubToolId, "linux", "x64"),
		).toBeUndefined();
	});

	describe("shellcheck asset patterns", () => {
		it.each([
			["linux", "x64", "linux.x86_64.tar.xz"],
			["linux", "arm64", "linux.aarch64.tar.xz"],
			["darwin", "x64", "darwin.x86_64.tar.xz"],
			["darwin", "arm64", "darwin.aarch64.tar.xz"],
			["win32", "x64", "zip"],
		] as const)("%s/%s → %s", async (platform, arch, expected) => {
			const { resolveGitHubAsset } =
				await import("../../../clients/installer/index.js");
			expect(resolveGitHubAsset("shellcheck", platform, arch)).toBe(expected);
		});
	});

	describe("shfmt asset patterns", () => {
		it.each([
			["linux", "x64", "linux_amd64"],
			["linux", "arm64", "linux_arm64"],
			["darwin", "x64", "darwin_amd64"],
			["darwin", "arm64", "darwin_arm64"],
			["win32", "x64", "windows_amd64.exe"],
			["win32", "arm64", "windows_arm64.exe"],
		] as const)("%s/%s → %s", async (platform, arch, expected) => {
			const { resolveGitHubAsset } =
				await import("../../../clients/installer/index.js");
			expect(resolveGitHubAsset("shfmt", platform, arch)).toBe(expected);
		});
	});

	describe("rust-analyzer asset patterns", () => {
		it.each([
			["linux", "x64", "x86_64-unknown-linux-gnu.gz"],
			["linux", "arm64", "aarch64-unknown-linux-gnu.gz"],
			["darwin", "x64", "x86_64-apple-darwin.gz"],
			["darwin", "arm64", "aarch64-apple-darwin.gz"],
			["win32", "x64", "x86_64-pc-windows-msvc.zip"],
		] as const)("%s/%s → %s", async (platform, arch, expected) => {
			const { resolveGitHubAsset } =
				await import("../../../clients/installer/index.js");
			expect(resolveGitHubAsset("rust-analyzer", platform, arch)).toBe(
				expected,
			);
		});
	});

	describe("golangci-lint asset patterns", () => {
		it.each([
			["linux", "x64", "linux-amd64.tar.gz"],
			["linux", "arm64", "linux-arm64.tar.gz"],
			["darwin", "x64", "darwin-amd64.tar.gz"],
			["darwin", "arm64", "darwin-arm64.tar.gz"],
			["win32", "x64", "windows-amd64.zip"],
			["win32", "arm64", "windows-arm64.zip"],
		] as const)("%s/%s → %s", async (platform, arch, expected) => {
			const { resolveGitHubAsset } =
				await import("../../../clients/installer/index.js");
			expect(resolveGitHubAsset("golangci-lint", platform, arch)).toBe(
				expected,
			);
		});
	});

	// Terragrunt ships bare per-platform binaries; win32/arm64 falls back to the
	// x64 binary (Windows emulation) because no arm64 asset exists upstream.
	describe("terragrunt asset patterns", () => {
		it.each([
			["linux", "x64", "terragrunt_linux_amd64"],
			["linux", "arm64", "terragrunt_linux_arm64"],
			["darwin", "x64", "terragrunt_darwin_amd64"],
			["darwin", "arm64", "terragrunt_darwin_arm64"],
			["win32", "x64", "terragrunt_windows_amd64.exe"],
			["win32", "arm64", "terragrunt_windows_amd64.exe"],
		] as const)("%s/%s → %s", async (platform, arch, expected) => {
			const { resolveGitHubAsset } =
				await import("../../../clients/installer/index.js");
			expect(resolveGitHubAsset("terragrunt", platform, arch)).toBe(expected);
		});
	});

	describe("windows archive binary names", () => {
		it("resolves shellcheck/tflint zip binaries to .exe on Windows", async () => {
			const {
				resolveGitHubArchiveBinaryCandidates,
				resolveGitHubInstalledBinaryName,
			} = await import("../../../clients/installer/index.js");

			expect(
				resolveGitHubArchiveBinaryCandidates(
					"shellcheck",
					"win32",
					"shellcheck-v0.11.0.zip",
				),
			).toContain("shellcheck.exe");
			expect(
				resolveGitHubArchiveBinaryCandidates(
					"tflint",
					"win32",
					"tflint_windows_amd64.zip",
				),
			).toContain("tflint.exe");
			expect(
				resolveGitHubInstalledBinaryName(
					"shellcheck",
					"win32",
					"shellcheck-v0.11.0.zip",
				),
			).toBe("shellcheck.exe");
			expect(
				resolveGitHubInstalledBinaryName(
					"tflint",
					"win32",
					"tflint_windows_amd64.zip",
				),
			).toBe("tflint.exe");
			expect(
				resolveGitHubArchiveBinaryCandidates(
					"terraform-ls",
					"win32",
					"terraform-ls_0.38.2_windows_amd64.zip",
				),
			).toContain("terraform-ls.exe");
			expect(
				resolveGitHubInstalledBinaryName(
					"terraform-ls",
					"win32",
					"terraform-ls_0.38.2_windows_amd64.zip",
				),
			).toBe("terraform-ls.exe");
		});

		it("preserves batch launchers like ktlint.bat on Windows", async () => {
			const {
				resolveGitHubArchiveBinaryCandidates,
				resolveGitHubInstalledBinaryName,
			} = await import("../../../clients/installer/index.js");

			expect(
				resolveGitHubArchiveBinaryCandidates("ktlint", "win32", "ktlint.bat"),
			).toContain("ktlint.bat");
			expect(
				resolveGitHubInstalledBinaryName("ktlint", "win32", "ktlint.bat"),
			).toBe("ktlint.bat");
		});
	});

	describe("HashiCorp release fallback", () => {
		it("derives terraform-ls download URLs from the release tag when GitHub assets are absent", async () => {
			const { resolveDerivedHashiCorpReleaseAsset } =
				await import("../../../clients/installer/index.js");

			expect(
				resolveDerivedHashiCorpReleaseAsset(
					"terraform-ls",
					"v0.38.2",
					"win32",
					"x64",
				),
			).toEqual({
				name: "terraform-ls_0.38.2_windows_amd64.zip",
				browser_download_url:
					"https://releases.hashicorp.com/terraform-ls/0.38.2/terraform-ls_0.38.2_windows_amd64.zip",
			});
		});
	});

	describe("zls asset patterns", () => {
		it.each([
			["linux", "x64", "x86_64-linux.tar.xz"],
			["linux", "arm64", "aarch64-linux.tar.xz"],
			["darwin", "x64", "x86_64-macos.tar.xz"],
			["darwin", "arm64", "aarch64-macos.tar.xz"],
			["win32", "x64", "x86_64-windows.zip"],
			["win32", "arm64", "aarch64-windows.zip"],
		] as const)("%s/%s → %s", async (platform, arch, expected) => {
			const { resolveGitHubAsset } =
				await import("../../../clients/installer/index.js");
			expect(resolveGitHubAsset("zls", platform, arch)).toBe(expected);
		});
	});

	// #274: marksman ships BARE (uncompressed) per-platform binaries. macOS is a
	// universal binary (same asset for x64/arm64); Windows ships only x64.
	describe("marksman asset patterns", () => {
		it.each([
			["linux", "x64", "marksman-linux-x64"],
			["linux", "arm64", "marksman-linux-arm64"],
			["darwin", "x64", "marksman-macos"],
			["darwin", "arm64", "marksman-macos"],
			["win32", "x64", "marksman.exe"],
			["win32", "arm64", "marksman.exe"],
		] as const)("%s/%s → %s", async (platform, arch, expected) => {
			const { resolveGitHubAsset } =
				await import("../../../clients/installer/index.js");
			expect(resolveGitHubAsset("marksman", platform, arch)).toBe(expected);
		});

		it("installs as marksman.exe on Windows (bare binary, no archive)", async () => {
			const { resolveGitHubInstalledBinaryName } =
				await import("../../../clients/installer/index.js");
			expect(
				resolveGitHubInstalledBinaryName("marksman", "win32", "marksman.exe"),
			).toBe("marksman.exe");
			expect(
				resolveGitHubInstalledBinaryName(
					"marksman",
					"linux",
					"marksman-linux-x64",
				),
			).toBe("marksman");
		});
	});

	describe("Expert asset patterns", () => {
		it.each([
			["linux", "x64", "expert_linux_amd64"],
			["linux", "arm64", "expert_linux_arm64"],
			["darwin", "x64", "expert_darwin_amd64"],
			["darwin", "arm64", "expert_darwin_arm64"],
			["win32", "x64", "expert_windows_amd64.exe"],
			["win32", "arm64", "expert_windows_amd64.exe"],
		] as const)("%s/%s → %s", async (platform, arch, expected) => {
			const { resolveGitHubAsset } =
				await import("../../../clients/installer/index.js");
			expect(resolveGitHubAsset("expert", platform, arch)).toBe(expected);
		});

		it("installs as expert.exe on Windows (bare binary, no archive)", async () => {
			const { resolveGitHubInstalledBinaryName } =
				await import("../../../clients/installer/index.js");
			expect(
				resolveGitHubInstalledBinaryName(
					"expert",
					"win32",
					"expert_windows_amd64.exe",
				),
			).toBe("expert.exe");
			expect(
				resolveGitHubInstalledBinaryName(
					"expert",
					"linux",
					"expert_linux_amd64",
				),
			).toBe("expert");
		});

		it("does not select an incompatible release binary", async () => {
			const { resolveGitHubAsset } =
				await import("../../../clients/installer/index.js");
			expect(resolveGitHubAsset("expert", "linux", "ppc64")).toBeUndefined();
			expect(resolveGitHubAsset("expert", "win32", "ia32")).toBeUndefined();
		});
	});
});

describe("getToolEnvironment PATH", () => {
	it("prepends the managed pi-lens bin dir (~/.pi-lens/bin by default) to PATH", async () => {
		const { getToolEnvironment } =
			await import("../../../clients/installer/index.js");
		const { getGlobalPiLensDir } =
			await import("../../../clients/file-utils.js");
		const env = await getToolEnvironment();
		// Asserts against the actual machine-global root (respects #525's
		// PI_LENS_HOME test override) rather than hardcoding os.homedir().
		const githubBin = path.join(getGlobalPiLensDir(), "bin");
		const separator = process.platform === "win32" ? ";" : ":";
		expect(env.PATH?.startsWith(githubBin + separator)).toBe(true);
	});

	it("also includes local npm tools dir in PATH", async () => {
		const { getToolEnvironment } =
			await import("../../../clients/installer/index.js");
		const { getGlobalPiLensDir } =
			await import("../../../clients/file-utils.js");
		const env = await getToolEnvironment();
		const localBin = path.join(
			getGlobalPiLensDir(),
			"tools",
			"node_modules",
			".bin",
		);
		expect(env.PATH).toContain(localBin);
	});

	it("includes current Node runtime directory in PATH", async () => {
		const { getToolEnvironment } =
			await import("../../../clients/installer/index.js");
		const env = await getToolEnvironment();
		expect(env.PATH).toContain(path.dirname(process.execPath));
	});
});
