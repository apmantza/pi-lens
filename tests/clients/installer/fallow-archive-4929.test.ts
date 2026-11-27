/**
 * #4929: the pinned `fallow-lsp` archive row.
 *
 * Recurrences this guards: an archive installed without its pin (the #3400
 * class: a download that is not the pinned release must install nothing), a
 * `latest` URL slipping in so the opt-in server changes under the user, and a
 * Windows marker spelled `fallow-lsp` (the zip carries `fallow-lsp.exe`), which
 * would make every Windows install look failed.
 *
 * The extraction and the refusal go through the real installer entry point
 * (`ensureTool`) with the real extractor; only the HTTPS transport is doubled
 * (a true process boundary), serving a tiny stand-in tar.gz.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createArchivePinScope } from "../../support/archive-pin.js";
import { drainRegisteredBackgroundWritesForTests } from "../../support/background-write-drains.js";
import { removeTempDirSync } from "../test-utils.js";

const HOME = vi.hoisted(() => {
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-4929-"),
	);
	vi.stubEnv("PI_LENS_HOME", dir);
	vi.stubEnv("PILENS_DATA_DIR", nodePath.join(dir, "data"));
	vi.stubEnv("PI_LENS_INSTALL_LOG", nodePath.join(dir, "logs", "install.log"));
	return dir;
});

// A flat tar.gz like the release's: `fallow-lsp` and `fallow` at the archive
// root, no wrapping directory.
const fixture = vi.hoisted(() => ({
	archive: Buffer.from(
		"H4sIAAAAAAAAA+3TwQrCMAzG8Z73FBXPsmY17nkmOBwUK+tEH9+yi+BB8dDJ4P+7BJJAcvn6LoR434V0NcW4rFWda/ZenWvEiEqjXg5+n/siqt5YV+6ll1uautFaM8Y4fdr7Nl+p7aY+Dpc6navTY5isq/79EBbVz/kve+P3/Of1lvwvgfwDAAAAAAAAAAAAAACs2xOguLIUACgAAA==",
		"base64",
	),
}));

vi.mock("node:https", () => ({
	default: {
		get: (
			_url: string,
			_options: unknown,
			callback: (response: EventEmitter) => void,
		) => {
			const response = new EventEmitter() as EventEmitter & {
				statusCode: number;
				headers: Record<string, string>;
			};
			response.statusCode = 200;
			response.headers = {};
			callback(response);
			queueMicrotask(() => {
				response.emit("data", fixture.archive);
				response.emit("end");
			});
			return new EventEmitter();
		},
	},
}));

vi.unmock("../../../clients/installer/index.js");
import {
	ensureTool,
	flushProbeCache,
	resolveArchiveKind,
	resolveArchiveUrl,
	TOOLS,
} from "../../../clients/installer/index.js";

const fallow = TOOLS.find((tool) => tool.id === "fallow-lsp");
const pins = createArchivePinScope({ TOOLS, resolveArchiveUrl });

beforeEach(() => {
	process.env.PI_LENS_TEST_PLATFORM = "linux";
	vi.stubEnv("PI_LENS_DISABLE_TOOL_INSTALL", undefined);
	fs.rmSync(path.join(HOME, "tools", "fallow-lsp"), {
		recursive: true,
		force: true,
	});
});
afterEach(() => {
	pins.restoreAll();
});
afterAll(async () => {
	try {
		// #5657: a successful `ensureTool` leaves a dirty probe-cache entry whose
		// 300 ms debounced flush writes `probe-cache.json` and its `.locks`
		// directory under HOME. Removed first, the flush re-created the root, and
		// the serialized tmp-fixture hygiene owner redded shard 5 on master run
		// 43798942706 (`pi-lens-4929-*`, present-at-sweep(held)). Settle the
		// writer through the registry the hygiene-clean files already join
		// (#5024), then prove nothing is left pending: `flushProbeCache` is idle
		// only when the drain landed the write.
		await drainRegisteredBackgroundWritesForTests();
		expect(await flushProbeCache()).toBe("idle");
	} finally {
		removeTempDirSync(HOME);
		delete process.env.PI_LENS_TEST_PLATFORM;
		vi.unstubAllEnvs();
	}
});

describe("fallow-lsp archive row (#4929)", () => {
	const targets: Array<[string, string, string, "tgz" | "zip", string]> = [
		[
			"linux",
			"x64",
			"fallow-x86_64-unknown-linux-gnu.tar.gz",
			"tgz",
			"fallow-lsp",
		],
		[
			"linux",
			"arm64",
			"fallow-aarch64-unknown-linux-gnu.tar.gz",
			"tgz",
			"fallow-lsp",
		],
		["darwin", "x64", "fallow-x86_64-apple-darwin.tar.gz", "tgz", "fallow-lsp"],
		[
			"darwin",
			"arm64",
			"fallow-aarch64-apple-darwin.tar.gz",
			"tgz",
			"fallow-lsp",
		],
		[
			"win32",
			"x64",
			"fallow-x86_64-pc-windows-msvc.zip",
			"zip",
			"fallow-lsp.exe",
		],
		[
			"win32",
			"arm64",
			"fallow-aarch64-pc-windows-msvc.zip",
			"zip",
			"fallow-lsp.exe",
		],
	];

	it.each(targets)(
		"%s/%s resolves the pinned v3.37.0 archive, its format and its marker",
		(platform, arch, asset, kind, marker) => {
			const spec = fallow?.archive;
			expect(spec, "fallow-lsp archive spec").toBeDefined();
			const url = resolveArchiveUrl(spec as never, platform, arch);
			expect(url).toBe(
				`https://github.com/fallow-rs/fallow/releases/download/v3.37.0/${asset}`,
			);
			expect(resolveArchiveKind(spec as never, platform, arch)).toBe(kind);
			expect(
				typeof spec?.treeMarker === "function"
					? spec.treeMarker(platform)
					: spec?.treeMarker,
			).toBe(marker);
			// Every resolvable URL carries a 64-hex pin: no unpinned install.
			expect(spec?.sha256?.[url as string]).toMatch(/^[0-9a-f]{64}$/);
		},
	);

	it("declines an architecture the release does not build", () => {
		const spec = fallow?.archive;
		expect(resolveArchiveUrl(spec as never, "linux", "ia32")).toBeUndefined();
		expect(resolveArchiveUrl(spec as never, "freebsd", "x64")).toBeUndefined();
	});

	it("installs the pinned archive flat and finds the binary at the bundle root", async () => {
		pins.pin("fallow-lsp", fixture.archive, { platform: "linux" });
		const installed = await ensureTool("fallow-lsp", { forceReinstall: true });
		expect(installed).toBe(path.join(HOME, "tools", "fallow-lsp"));
		expect(
			fs.existsSync(path.join(HOME, "tools", "fallow-lsp", "fallow-lsp")),
		).toBe(true);
	});

	it("refuses bytes that are not the pinned release and installs nothing", async () => {
		// The REAL registry pin stands: the stand-in archive hashes to something
		// else, as a tampered or swapped download would.
		await expect(
			ensureTool("fallow-lsp", { forceReinstall: true }),
		).resolves.toBeUndefined();
		expect(fs.existsSync(path.join(HOME, "tools", "fallow-lsp"))).toBe(false);
	});
});
