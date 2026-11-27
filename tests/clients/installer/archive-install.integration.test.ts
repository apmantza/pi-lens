import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { drainRegisteredBackgroundWritesForTests } from "../../support/background-write-drains.js";
import { createArchivePinScope } from "../../support/archive-pin.js";
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
	// #3400: a real zip shaped like fwcd's server.zip — one `server/` wrapper
	// holding `bin/kotlin-language-server` (mode 755) and `lib/`.
	kotlin: Buffer.from(
		"UEsDBBQAAAAAAAAAMloAAAAAAAAAAAAAAAAHAAAAc2VydmVyL1BLAwQUAAAAAAAAADJaAAAAAAAAAAAAAAAACwAAAHNlcnZlci9iaW4vUEsDBBQAAAAAAAAAMlrihkXDEQAAABEAAAAhAAAAc2VydmVyL2Jpbi9rb3RsaW4tbGFuZ3VhZ2Utc2VydmVyIyEvYmluL3NoCmV4aXQgMApQSwMEFAAAAAAAAAAyWgAAAAAAAAAAAAAAAAsAAABzZXJ2ZXIvbGliL1BLAwQUAAAAAAAAADJaEt3seAMAAAADAAAAFQAAAHNlcnZlci9saWIvc2VydmVyLmphcmphclBLAQIUAxQAAAAAAAAAMloAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAADtQQAAAABzZXJ2ZXIvUEsBAhQDFAAAAAAAAAAyWgAAAAAAAAAAAAAAAAsAAAAAAAAAAAAAAO1BJQAAAHNlcnZlci9iaW4vUEsBAhQDFAAAAAAAAAAyWuKGRcMRAAAAEQAAACEAAAAAAAAAAAAAAO2BTgAAAHNlcnZlci9iaW4va290bGluLWxhbmd1YWdlLXNlcnZlclBLAQIUAxQAAAAAAAAAMloAAAAAAAAAAAAAAAALAAAAAAAAAAAAAADtQZ4AAABzZXJ2ZXIvbGliL1BLAQIUAxQAAAAAAAAAMloS3ex4AwAAAAMAAAAVAAAAAAAAAAAAAACkgccAAABzZXJ2ZXIvbGliL3NlcnZlci5qYXJQSwUGAAAAAAUABQA5AQAA/QAAAAAA",
		"base64",
	),
	powershell: Buffer.from(
		"UEsDBAoAAAAAANd6Ll0AAAAAAAAAAAAAAAAZABwAUG93ZXJTaGVsbEVkaXRvclNlcnZpY2VzL1VUCQADFeenahXnp2p1eAsAAQToAwAABOgDAABQSwMECgAAAAAA13ouXYymR1AFAAAABQAAADEAHABQb3dlclNoZWxsRWRpdG9yU2VydmljZXMvU3RhcnQtRWRpdG9yU2VydmljZXMucHMxVVQJAAMV56dqFeenanV4CwABBOgDAAAE6AMAACMgcHMKUEsBAh4DCgAAAAAA13ouXQAAAAAAAAAAAAAAABkAGAAAAAAAAAAQAP1BAAAAAFBvd2VyU2hlbGxFZGl0b3JTZXJ2aWNlcy9VVAUAAxXnp2p1eAsAAQToAwAABOgDAABQSwECHgMKAAAAAADXei5djKZHUAUAAAAFAAAAMQAYAAAAAAABAAAAtIFTAAAAUG93ZXJTaGVsbEVkaXRvclNlcnZpY2VzL1N0YXJ0LUVkaXRvclNlcnZpY2VzLnBzMVVUBQADFeenanV4CwABBOgDAAAE6AMAAFBLBQYAAAAAAgACANYAAADDAAAAAAA=",
		"base64",
	),
}));

// #5701: which TLS-peer fault the next archive request replays. `none` serves
// the fixture archive; `reset` drops the socket mid-body; `oversize` sends one
// chunk past the downloader's 512 MiB cap.
const peer = vi.hoisted(() => ({
	fault: "none" as "none" | "reset" | "oversize",
	pulls: 0,
}));
const OVERSIZE_CHUNK_BYTES = 64 * 1024 * 1024;
const OVERSIZE_CHUNKS = 9;

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
			if (peer.fault !== "none") {
				const chunk = Buffer.alloc(
					peer.fault === "oversize" ? OVERSIZE_CHUNK_BYTES : 4096,
				);
				const stream = new Readable({
					read() {
						peer.pulls += 1;
						if (peer.fault === "oversize") {
							this.push(peer.pulls > OVERSIZE_CHUNKS ? null : chunk);
							return;
						}
						if (peer.pulls > 1) return;
						this.push(chunk);
						setImmediate(() => this.destroy(new Error("read ECONNRESET")));
					},
				});
				Object.assign(stream, { statusCode: 200, headers: {} });
				queueMicrotask(() => callback(stream as never));
				return new EventEmitter();
			}
			const body = url.includes("clangd")
				? archives.clangd
				: url.includes("lua-language-server")
					? archives.lua
					: url.includes("kotlin-language-server")
						? archives.kotlin
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
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	ensureTool,
	flushProbeCache,
	resolveArchiveUrl,
	TOOLS,
} from "../../../clients/installer/index.js";

// #3400: the registry pins the sha256 of each REAL release archive, so these
// hand-built fixture archives are pinned for the test, the same way the test
// supplies the bytes: the assertion (installed / refused) is the production
// check's, not the fixture's.
const pins = createArchivePinScope({ TOOLS, resolveArchiveUrl });
function pinFixture(toolId: string, body: Buffer): void {
	pins.pin(toolId, body, { platform: "linux" });
}
afterEach(() => {
	pins.restoreAll();
	peer.fault = "none";
});

afterAll(async () => {
	try {
		// #5657: a successful `ensureTool` leaves a dirty probe-cache entry. Its
		// 300 ms debounced flush writes `probe-cache.json` and its `.locks` under
		// this root, and a flush after removal re-creates the root. Settle the
		// writer through the registry, then prove the flush landed: it reads idle
		// only when nothing is pending.
		await drainRegisteredBackgroundWritesForTests();
		expect(await flushProbeCache()).toBe("idle");
	} finally {
		// #2912: this module-scoped HOME is a real /tmp fixture, including the
		// installer's data and log trees. Remove the whole root so archive coverage
		// cannot leave a top-level pi-lens-3020-* entry for hygiene to report.
		removeTempDirSync(HOME);
		delete process.env.PI_LENS_TEST_PLATFORM;
	}
});

beforeEach(() => {
	process.env.PI_LENS_TEST_PLATFORM = "linux";
	delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
});

describe("archive installer fixture path (#3020)", () => {
	it("installs clangd ZIP through ensureTool and strips its wrapper", async () => {
		pinFixture("clangd", archives.clangd);
		const installed = await ensureTool("clangd", { forceReinstall: true });
		expect(installed).toContain(path.join("tools", "clangd"));
		expect(fs.existsSync(path.join(HOME, "tools", "clangd", "bin"))).toBe(true);
	});

	it("installs the Lua tar.gz tree through the same seam", async () => {
		pinFixture("lua-language-server", archives.lua);
		const installed = await ensureTool("lua-language-server", {
			forceReinstall: true,
		});
		expect(installed).toContain(path.join("tools", "lua-language-server"));
		expect(
			fs.existsSync(path.join(HOME, "tools", "lua-language-server", "bin")),
		).toBe(true);
	});

	it("installs the PowerShell Editor Services ZIP tree marker", async () => {
		pinFixture("powershell-editor-services", archives.powershell);
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
		pinFixture("clangd", archives.clangd);
		await expect(
			ensureTool("clangd", { forceReinstall: true }),
		).resolves.toContain(path.join("tools", "clangd"));
		const marker = path.join(HOME, "tools", "clangd", "bin");
		// `archives` is shared module state: the next case pins whatever bytes
		// are here, so restore the good ZIP however this case ends (#4561 L9).
		const goodClangd = archives.clangd;
		try {
			archives.clangd = Buffer.from("not a zip archive");
			// Pinned on purpose: this case is the EXTRACTION failure (bytes match
			// the pin, the extractor rejects them), not the integrity refusal below.
			pinFixture("clangd", archives.clangd);
			await expect(
				ensureTool("clangd", { forceReinstall: true }),
			).resolves.toBeUndefined();
			expect(fs.existsSync(marker)).toBe(true);
		} finally {
			archives.clangd = goodClangd;
		}
	});
	// #5706 F1 recurrence: the first regression test imported the new downloader
	// module, so on the merge base it failed on the missing import, not on
	// behaviour. These two drive the production archive caller, which master
	// buffered with `httpsGet`, so restoring master's source reds on the
	// assertions below.
	describe("archive payload streaming (#5701)", () => {
		function downloadRows(): Array<{ subject: string; reason: string }> {
			return (
				getDegradationSummary().find((g) => g.kind === "managed-tool-download")
					?.latestReasons ?? []
			);
		}
		function partialDownloads(): string[] {
			const tools = path.join(HOME, "tools");
			return fs.existsSync(tools)
				? fs
						.readdirSync(tools)
						.filter((name) => name.includes(".clangd.archive-"))
				: [];
		}
		beforeEach(() => {
			resetDegradationLedger();
			peer.pulls = 0;
		});

		it("records a typed download failure and leaves no partial file on a mid-body peer reset", async () => {
			peer.fault = "reset";
			await expect(
				ensureTool("clangd", { forceReinstall: true }),
			).resolves.toBeUndefined();
			const rows = downloadRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.subject).toBe("clangd");
			expect(rows[0]?.reason).toMatch(/download stream failed.*ECONNRESET/);
			expect(partialDownloads()).toEqual([]);
		});

		it("rejects a body past the byte cap, records it, and leaves no partial file", async () => {
			peer.fault = "oversize";
			await expect(
				ensureTool("clangd", { forceReinstall: true }),
			).resolves.toBeUndefined();
			const rows = downloadRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.reason).toMatch(/exceeds 536870912 bytes/);
			expect(partialDownloads()).toEqual([]);
		});
	});

	// #3400 through the production entry point with the REAL extractor: a zip
	// shaped like fwcd's server.zip installs, and the same zip with one byte
	// flipped never reaches the extractor.
	describe("kotlin-language-server (#3400)", () => {
		let restorePath: string;
		let javaDir: string;
		beforeEach(() => {
			restorePath = process.env.PATH ?? "";
			javaDir = path.join(HOME, "java-bin");
			fs.mkdirSync(javaDir, { recursive: true });
			fs.writeFileSync(path.join(javaDir, "java"), "x");
			process.env.PATH = `${restorePath}${path.delimiter}${javaDir}`;
			fs.rmSync(path.join(HOME, "tools", "kotlin-language-server"), {
				recursive: true,
				force: true,
			});
			fs.rmSync(path.join(HOME, "bin", "kotlin-language-server"), {
				force: true,
			});
		});
		afterEach(() => {
			process.env.PATH = restorePath;
		});

		it("installs the server zip, strips its wrapper and shims the launcher", async () => {
			pinFixture("kotlin-language-server", archives.kotlin);
			const installed = await ensureTool("kotlin-language-server", {
				forceReinstall: true,
			});
			expect(installed).toBe(path.join(HOME, "bin", "kotlin-language-server"));
			const launcher = path.join(
				HOME,
				"tools",
				"kotlin-language-server",
				"bin",
				"kotlin-language-server",
			);
			expect(fs.existsSync(launcher)).toBe(true);
			expect(fs.statSync(launcher).mode & 0o100).toBe(0o100);
		});

		it("refuses a tampered server zip and installs nothing", async () => {
			pinFixture("kotlin-language-server", archives.kotlin);
			const tampered = Buffer.from(archives.kotlin);
			tampered[tampered.length - 1] ^= 0xff;
			archives.kotlin = tampered;
			try {
				await expect(
					ensureTool("kotlin-language-server", { forceReinstall: true }),
				).resolves.toBeUndefined();
			} finally {
				archives.kotlin = Buffer.from(tampered);
				archives.kotlin[archives.kotlin.length - 1] ^= 0xff;
			}
			expect(
				fs.existsSync(path.join(HOME, "tools", "kotlin-language-server")),
			).toBe(false);
			expect(
				fs.existsSync(path.join(HOME, "bin", "kotlin-language-server")),
			).toBe(false);
		});
	});
});
