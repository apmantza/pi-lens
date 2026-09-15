import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const HOME = vi.hoisted(() => {
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-3020-"),
	);
	process.env.PI_LENS_HOME = dir;
	process.env.PILENS_DATA_DIR = nodePath.join(dir, "data");
	process.env.PI_LENS_INSTALL_LOG = nodePath.join(dir, "logs", "install.log");
	return dir;
});

const archives = vi.hoisted(() => ({
	clangd: Buffer.from(
		"UEsDBAoAAAAAAM96Ll0AAAAAAAAAAAAAAAAKABwAY2xhbmdkXzIyL1VUCQADBuenagbnp2p1eAsAAQToAwAABOgDAABQSwMECgAAAAAAz3ouXQAAAAAAAAAAAAAAAA4AHABjbGFuZ2RfMjIvYmluL1VUCQADBuenagbnp2p1eAsAAQToAwAABOgDAABQSwMECgAAAAAAz3ouXR2d+wQKAAAACgAAABQAHABjbGFuZ2RfMjIvYmluL2NsYW5nZFVUCQADBuenagbnp2p1eAsAAQToAwAABOgDAAAjIS9iaW4vc2gKUEsBAh4DCgAAAAAAz3ouXQAAAAAAAAAAAAAAAAoAGAAAAAAAAAAQAP1BAAAAAGNsYW5nZF8yMi9VVAUAAwbnp2p1eAsAAQToAwAABOgDAABQSwECHgMKAAAAAADPei5dAAAAAAAAAAAAAAAADgAYAAAAAAAAABAA/UFEAAAAY2xhbmdkXzIyL2Jpbi9VVAUAAwbnp2p1eAsAAQToAwAABOgDAABQSwECHgMKAAAAAADPei5dHZ37BAoAAAAKAAAAFAAYAAAAAAABAAAAtIGMAAAAY2xhbmdkXzIyL2Jpbi9jbGFuZ2RVVAUAAwbnp2p1eAsAAQToAwAABOgDAABQSwUGAAAAAAMAAwD+AAAA5AAAAAAA",
		"base64",
	),
	lua: Buffer.from(
		"H4sIAAAAAAAAA+3SSwqDMBSF4Yy7ipSOxSTmsZ4IYqXiwNSuv2YglIItBaWU/t/kDnIhB86tu6EUO1OzEFyeOjj1OBdCO+N08NbYeU+rSlVCur2DZVO6xlFKES9derX37v1H1XP//RSLPg7tFNumSM14a8ZN/8gFe2/X+9fmqX+rvBNSbZpixZ/3fzqW+QTS+fDtJAAAAAAAAAAAAAAAAAA+dQdTCUwIACgAAA==",
		"base64",
	),
	powershell: Buffer.from(
		"UEsDBAoAAAAAANd6Ll0AAAAAAAAAAAAAAAAZABwAUG93ZXJTaGVsbEVkaXRvclNlcnZpY2VzL1VUCQADFeenahXnp2p1eAsAAQToAwAABOgDAABQSwMECgAAAAAA13ouXYymR1AFAAAABQAAADEAHABQb3dlclNoZWxsRWRpdG9yU2VydmljZXMvU3RhcnQtRWRpdG9yU2VydmljZXMucHMxVVQJAAMV56dqFeenanV4CwABBOgDAAAE6AMAACMgcHMKUEsBAh4DCgAAAAAA13ouXQAAAAAAAAAAAAAAABkAGAAAAAAAAAAQAP1BAAAAAFBvd2VyU2hlbGxFZGl0b3JTZXJ2aWNlcy9VVAUAAxXnp2p1eAsAAQToAwAABOgDAABQSwECHgMKAAAAAADXei5djKZHUAUAAAAFAAAAMQAYAAAAAAABAAAAtIFTAAAAUG93ZXJTaGVsbEVkaXRvclNlcnZpY2VzL1N0YXJ0LUVkaXRvclNlcnZpY2VzLnBzMVVUBQADFeenanV4CwABBOgDAAAE6AMAAFBLBQYAAAAAAgACANYAAADDAAAAAAA=",
		"base64",
	),
}));

vi.mock("node:https", () => ({
	default: {
		get: (
			url: string,
			_options: unknown,
			callback: (response: EventEmitter) => void,
		) => {
			const response = new EventEmitter() as EventEmitter & {
				statusCode: number;
				headers: Record<string, string>;
			};
			response.statusCode = 200;
			response.headers = {};
			const body = url.includes("clangd")
				? archives.clangd
				: url.includes("lua-language-server")
					? archives.lua
					: archives.powershell;
			callback(response);
			queueMicrotask(() => {
				response.emit("data", body);
				response.emit("end");
			});
			const request = new EventEmitter();
			return request;
		},
	},
}));

vi.unmock("../../../clients/installer/index.js");
vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
	flushSessionStartLog: async () => {},
	flushSessionStartLogSync: () => {},
	SESSIONSTART_LOG_FILE: "",
}));
import { ensureTool } from "../../../clients/installer/index.js";

afterAll(() => {
	// #2912: this module-scoped HOME is a real /tmp fixture, including the
	// installer's data and log trees. Remove the whole root so archive coverage
	// cannot leave a top-level pi-lens-3020-* entry for hygiene to report.
	removeTempDirSync(HOME);
	delete process.env.PI_LENS_TEST_PLATFORM;
});

beforeEach(() => {
	process.env.PI_LENS_TEST_PLATFORM = "linux";
	delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
});

describe("archive installer fixture path (#3020)", () => {
	it("installs clangd ZIP through ensureTool and strips its wrapper", async () => {
		const installed = await ensureTool("clangd", { forceReinstall: true });
		expect(installed).toContain(path.join("tools", "clangd"));
		expect(fs.existsSync(path.join(HOME, "tools", "clangd", "bin"))).toBe(true);
	});

	it("installs the Lua tar.gz tree through the same seam", async () => {
		const installed = await ensureTool("lua-language-server", {
			forceReinstall: true,
		});
		expect(installed).toContain(path.join("tools", "lua-language-server"));
		expect(
			fs.existsSync(path.join(HOME, "tools", "lua-language-server", "bin")),
		).toBe(true);
	});

	it("installs the PowerShell Editor Services ZIP tree marker", async () => {
		const installed = await ensureTool("powershell-editor-services", {
			forceReinstall: true,
		});
		expect(installed).toContain(
			path.join("tools", "powershell-editor-services"),
		);
		expect(
			fs.existsSync(
				path.join(
					HOME,
					"tools",
					"powershell-editor-services",
					"PowerShellEditorServices",
					"Start-EditorServices.ps1",
				),
			),
		).toBe(true);
	});

	it("keeps a verified clangd tree when a replacement ZIP is bad", async () => {
		await expect(
			ensureTool("clangd", { forceReinstall: true }),
		).resolves.toContain(path.join("tools", "clangd"));
		const marker = path.join(HOME, "tools", "clangd", "bin");
		archives.clangd = Buffer.from("not a zip archive");
		await expect(
			ensureTool("clangd", { forceReinstall: true }),
		).resolves.toBeUndefined();
		expect(fs.existsSync(marker)).toBe(true);
	});
});
