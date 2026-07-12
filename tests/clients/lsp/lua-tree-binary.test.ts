/**
 * Lua Language Server Tree-Binary Launch (#564, split from #241)
 *
 * lua-language-server now reuses the archive-tree auto-install machinery built
 * for clangd: `resolveAndLaunchTreeBinary` — PATH-first, then the managed
 * bundle extracted under ~/.pi-lens/tools/lua-language-server, launching
 * bin/lua-language-server within it. This mocks the download/extract layer
 * (`getToolPath`/`ensureTool`) and the process spawn (`launchLSP`) so the test
 * never hits the network or a real binary — it only verifies the resolution
 * order and the bundle bin path that LuaServer.spawn constructs.
 */

import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { launchLSP } = vi.hoisted(() => ({ launchLSP: vi.fn() }));
const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
const { getToolPath, ensureTool } = vi.hoisted(() => ({
	getToolPath: vi.fn(),
	ensureTool: vi.fn(),
}));

vi.mock("../../../clients/lsp/launch.js", () => ({ launchLSP }));
vi.mock("../../../clients/latency-logger.js", () => ({ logLatency }));
vi.mock("../../../clients/installer/index.js", () => ({
	getToolPath,
	ensureTool,
	getToolEnvironment: () => ({}),
}));

import { LuaServer } from "../../../clients/lsp/server.ts";

const fakeProc = { stdout: {}, stderr: {} } as never;
const ROOT = "/tmp/lua-project";

describe("LuaServer.spawn — tree-binary resolution (#564)", () => {
	beforeEach(() => {
		launchLSP.mockReset();
		logLatency.mockReset();
		getToolPath.mockReset();
		ensureTool.mockReset();
	});

	it("prefers a system lua-language-server on PATH (source: direct)", async () => {
		launchLSP.mockResolvedValueOnce(fakeProc);

		const result = await LuaServer.spawn(ROOT, { allowInstall: true });

		expect(result?.source).toBe("direct");
		expect(launchLSP).toHaveBeenCalledTimes(1);
		expect(launchLSP).toHaveBeenCalledWith(
			"lua-language-server",
			[],
			expect.objectContaining({ cwd: ROOT }),
		);
		// PATH succeeded — the managed bundle must never be consulted.
		expect(getToolPath).not.toHaveBeenCalled();
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("falls back to an already-extracted managed bundle when PATH fails", async () => {
		launchLSP
			.mockRejectedValueOnce(new Error("ENOENT")) // PATH candidate fails
			.mockResolvedValueOnce(fakeProc); // managed bin launches
		getToolPath.mockResolvedValueOnce("/home/user/.pi-lens/tools/lua-language-server");

		const result = await LuaServer.spawn(ROOT, { allowInstall: true });

		expect(result?.source).toBe("managed");
		expect(ensureTool).not.toHaveBeenCalled(); // already extracted, no (re)install
		const suffix = process.platform === "win32" ? ".exe" : "";
		const expectedBin =
			path.join(
				"/home/user/.pi-lens/tools/lua-language-server",
				"bin",
				"lua-language-server",
			) + suffix;
		expect(launchLSP).toHaveBeenLastCalledWith(
			expectedBin,
			[],
			expect.objectContaining({ cwd: ROOT }),
		);
	});

	it("installs the managed bundle when not yet extracted and allowInstall is true", async () => {
		launchLSP
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(fakeProc);
		getToolPath.mockResolvedValueOnce(undefined); // not yet extracted
		ensureTool.mockResolvedValueOnce("/home/user/.pi-lens/tools/lua-language-server");

		const result = await LuaServer.spawn(ROOT, { allowInstall: true });

		expect(result?.source).toBe("managed");
		expect(ensureTool).toHaveBeenCalledWith("lua-language-server");
	});

	it("gracefully skips (returns undefined) when PATH fails and allowInstall is false", async () => {
		launchLSP.mockRejectedValueOnce(new Error("ENOENT"));
		getToolPath.mockResolvedValueOnce(undefined);

		const result = await LuaServer.spawn(ROOT, { allowInstall: false });

		expect(result).toBeUndefined();
		expect(ensureTool).not.toHaveBeenCalled(); // install gated off
	});
});
