import { describe, expect, it, vi } from "vitest";
import { resolveArchiveUrl, TOOLS } from "../../../clients/installer/index.ts";

// Use the real installer module, not any mock another test file registered.
vi.unmock("../../../clients/installer/index.ts");

/**
 * Platform-matched archive URLs (#241). `ArchiveSpec.url` may be a resolver
 * `(platform, arch) => url | undefined` so a server can ship a per-platform (and
 * per-arch) archive — clangd is the first consumer. `resolveArchiveUrl` is what
 * `installArchiveTool` calls; this guards the contract + clangd's specific matrix.
 */
describe("resolveArchiveUrl (#241 platform-matched archives)", () => {
	it("passes a string url through unchanged on every platform", () => {
		const spec = { url: "https://example.com/x.zip", kind: "zip" } as const;
		expect(resolveArchiveUrl(spec, "linux", "x64")).toBe(spec.url);
		expect(resolveArchiveUrl(spec, "win32", "arm64")).toBe(spec.url);
	});

	it("invokes a resolver url with the given platform/arch", () => {
		const spec = {
			url: (p: string, a: string) => `https://example.com/${p}-${a}.zip`,
			kind: "zip",
		} as const;
		expect(resolveArchiveUrl(spec, "darwin", "arm64")).toBe(
			"https://example.com/darwin-arm64.zip",
		);
	});

	it("propagates a resolver's undefined (unsupported platform → skip)", () => {
		const spec = {
			url: (p: string) => (p === "linux" ? "https://x/l.zip" : undefined),
			kind: "zip",
		} as const;
		expect(resolveArchiveUrl(spec, "linux", "x64")).toMatch(/^https:/);
		expect(resolveArchiveUrl(spec, "win32", "x64")).toBeUndefined();
	});

	describe("clangd tool def", () => {
		const clangd = TOOLS.find((t) => t.id === "clangd");

		it("is a registered archive tree-bundle", () => {
			expect(clangd?.installStrategy).toBe("archive");
			expect(clangd?.archive?.launcher).toBeUndefined();
			expect(clangd?.archive?.treeMarker).toBe("bin");
			expect(clangd?.archive?.stripComponents).toBe(1);
		});

		it.each([
			["linux", "x64", /clangd-linux-[\d.]+\.zip$/],
			["darwin", "x64", /clangd-mac-[\d.]+\.zip$/],
			["darwin", "arm64", /clangd-mac-[\d.]+\.zip$/], // x64 build via Rosetta
			["win32", "x64", /clangd-windows-[\d.]+\.zip$/],
			["win32", "arm64", /clangd-windows-[\d.]+\.zip$/], // x64 via emulation
		])("resolves %s/%s to the matching asset", (platform, arch, pattern) => {
			const url = resolveArchiveUrl(clangd!.archive!, platform, arch);
			expect(url).toMatch(/^https:\/\/github\.com\/clangd\/clangd\/releases\//);
			expect(url).toMatch(pattern);
		});

		it("has no official build for linux/arm64 or unknown platforms", () => {
			expect(resolveArchiveUrl(clangd!.archive!, "linux", "arm64")).toBeUndefined();
			expect(resolveArchiveUrl(clangd!.archive!, "freebsd", "x64")).toBeUndefined();
		});
	});

	describe("lua-language-server tool def (#564)", () => {
		const lua = TOOLS.find((t) => t.id === "lua-language-server");

		it("is a registered archive tree-bundle", () => {
			expect(lua?.installStrategy).toBe("archive");
			expect(lua?.archive?.launcher).toBeUndefined();
			expect(lua?.archive?.treeMarker).toBe("bin");
			// Unlike clangd, LuaLS releases have no wrapping version dir.
			expect(lua?.archive?.stripComponents).toBe(0);
		});

		it.each([
			["linux", "x64", /lua-language-server-[\d.]+-linux-x64\.tar\.gz$/],
			["linux", "arm64", /lua-language-server-[\d.]+-linux-arm64\.tar\.gz$/],
			["darwin", "x64", /lua-language-server-[\d.]+-darwin-x64\.tar\.gz$/],
			["darwin", "arm64", /lua-language-server-[\d.]+-darwin-arm64\.tar\.gz$/],
			["win32", "x64", /lua-language-server-[\d.]+-win32-x64\.zip$/],
		])("resolves %s/%s to the matching asset", (platform, arch, pattern) => {
			const url = resolveArchiveUrl(lua!.archive!, platform, arch);
			expect(url).toMatch(
				/^https:\/\/github\.com\/LuaLS\/lua-language-server\/releases\//,
			);
			expect(url).toMatch(pattern);
		});

		it("has no official win32/arm64 build or support for unknown platforms", () => {
			expect(resolveArchiveUrl(lua!.archive!, "win32", "arm64")).toBeUndefined();
			expect(resolveArchiveUrl(lua!.archive!, "freebsd", "x64")).toBeUndefined();
		});
	});
});
