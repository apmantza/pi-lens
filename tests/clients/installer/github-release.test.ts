import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Ensure the real installer module is used, not any mock registered by other test files
vi.unmock("../../../clients/installer/index.ts");

const GITHUB_TOOLS = [
	"shellcheck",
	"shfmt",
	"rust-analyzer",
	"golangci-lint",
	"ktlint",
	"tflint",
	"terraform-ls",
] as const;
type GitHubToolId = (typeof GITHUB_TOOLS)[number];

const SUPPORTED_PLATFORMS = ["linux", "darwin", "win32"] as const;
const COMMON_ARCHES = ["x64", "arm64"] as const;

describe("GitHub release asset selection", () => {
	it("every github tool has an asset for all supported platform/arch combos", async () => {
		const { resolveGitHubAsset } = await import("../../../clients/installer/index.ts");

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
		const { resolveGitHubAsset } = await import("../../../clients/installer/index.ts");

		for (const toolId of GITHUB_TOOLS) {
			expect(resolveGitHubAsset(toolId, "freebsd", "x64")).toBeUndefined();
			expect(resolveGitHubAsset(toolId, "sunos", "x64")).toBeUndefined();
		}
	});

	it("returns undefined for unknown tool id", async () => {
		const { resolveGitHubAsset } = await import("../../../clients/installer/index.ts");
		expect(resolveGitHubAsset("nonexistent-tool", "linux", "x64")).toBeUndefined();
	});

	describe("shellcheck asset patterns", () => {
		it.each([
			["linux", "x64", "linux.x86_64.tar.xz"],
			["linux", "arm64", "linux.aarch64.tar.xz"],
			["darwin", "x64", "darwin.x86_64.tar.xz"],
			["darwin", "arm64", "darwin.aarch64.tar.xz"],
			["win32", "x64", "zip"],
		] as const)("%s/%s → %s", async (platform, arch, expected) => {
			const { resolveGitHubAsset } = await import("../../../clients/installer/index.ts");
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
			const { resolveGitHubAsset } = await import("../../../clients/installer/index.ts");
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
			const { resolveGitHubAsset } = await import("../../../clients/installer/index.ts");
			expect(resolveGitHubAsset("rust-analyzer", platform, arch)).toBe(expected);
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
			const { resolveGitHubAsset } = await import("../../../clients/installer/index.ts");
			expect(resolveGitHubAsset("golangci-lint", platform, arch)).toBe(expected);
		});
	});

	describe("windows archive binary names", () => {
		it("resolves shellcheck/tflint zip binaries to .exe on Windows", async () => {
			const {
				resolveGitHubArchiveBinaryCandidates,
				resolveGitHubInstalledBinaryName,
			} = await import("../../../clients/installer/index.ts");

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
			} = await import("../../../clients/installer/index.ts");

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
			const { resolveDerivedHashiCorpReleaseAsset } = await import(
				"../../../clients/installer/index.ts"
			);

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
});

describe("getToolEnvironment PATH", () => {
	it("prepends ~/.pi-lens/bin to PATH", async () => {
		const { getToolEnvironment } = await import("../../../clients/installer/index.ts");
		const env = await getToolEnvironment();
		const githubBin = path.join(os.homedir(), ".pi-lens", "bin");
		const separator = process.platform === "win32" ? ";" : ":";
		expect(env.PATH?.startsWith(githubBin + separator)).toBe(true);
	});

	it("also includes local npm tools dir in PATH", async () => {
		const { getToolEnvironment } = await import("../../../clients/installer/index.ts");
		const env = await getToolEnvironment();
		const localBin = path.join(os.homedir(), ".pi-lens", "tools", "node_modules", ".bin");
		expect(env.PATH).toContain(localBin);
	});

	it("includes current Node runtime directory in PATH", async () => {
		const { getToolEnvironment } = await import("../../../clients/installer/index.ts");
		const env = await getToolEnvironment();
		expect(env.PATH).toContain(path.dirname(process.execPath));
	});
});
