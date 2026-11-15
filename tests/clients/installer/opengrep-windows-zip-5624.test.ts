/**
 * Recurrence this guards: #5624. opengrep v2.0.0 ships Windows as
 * `opengrep_windows_x86.zip` holding `opengrep.exe` plus the mingw DLLs the exe
 * imports (libstdc++-6, libgmp-10, libpcre2-8-0, libzstd-1, and their own
 * dependencies; `objdump -p opengrep.exe` on the real zip lists them). The
 * zip branch of the github strategy moved only the exe into the managed bin,
 * so the exe sat next to no DLLs and could not load.
 *
 * Driven through the production entry point (`installTool("opengrep")`: release
 * lookup, asset pick, download, extraction, move into the managed bin) with the
 * platform set to win32. Only `node:https` and the process spawn seam are
 * doubled, the way #4789's test does it: the spawn double plays PowerShell's
 * `Expand-Archive` by writing the real zip's member list into the destination.
 * The home is pinned under the test's own temp dir.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
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
import { removeTempDirSync } from "../test-utils.js";

vi.unmock("../../../clients/installer/index.js");

const { httpsGetMock, extractedMembers } = vi.hoisted(() => ({
	httpsGetMock: vi.fn(),
	extractedMembers: [] as string[],
}));

vi.mock("node:https", () => ({
	default: { get: httpsGetMock },
	get: httpsGetMock,
}));
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: vi.fn(async (command: string, args: string[]) => {
		if (command === "powershell") {
			const destination = /-DestinationPath '([^']+)'/.exec(args[2] ?? "")?.[1];
			if (!destination) throw new Error("no -DestinationPath in the argv");
			for (const member of extractedMembers) {
				fs.writeFileSync(path.join(destination, member), `bytes:${member}`);
			}
		}
		return { stdout: "2.0.0", stderr: "", status: 0 };
	}),
}));

/** The member list of the real opengrep_windows_x86.zip (v2.0.0, `unzip -l`). */
const ZIP_MEMBERS = [
	"libgcc_s_seh-1.dll",
	"libgmp-10.dll",
	"libpcre2-8-0.dll",
	"libstdc++-6.dll",
	"libwinpthread-1.dll",
	"libzstd-1.dll",
	"opengrep.exe",
];

/** The v2.0.0 asset list, siblings included. */
const ASSET_NAMES = [
	"opengrep_linux_aarch64",
	"opengrep_linux_aarch64.cert",
	"opengrep_linux_aarch64.sig",
	"opengrep_linux_x86",
	"opengrep_linux_x86.cert",
	"opengrep_linux_x86.sig",
	"opengrep_osx_arm64",
	"opengrep_osx_arm64.cert",
	"opengrep_osx_arm64.sig",
	"opengrep_osx_x86",
	"opengrep_osx_x86.cert",
	"opengrep_osx_x86.sig",
	"opengrep_windows_x86.zip",
	"opengrep_windows_x86.zip.cert",
	"opengrep_windows_x86.zip.sig",
	"tflint_windows_amd64.zip",
];

const downloaded: string[] = [];

httpsGetMock.mockImplementation(
	(url: string, _options: unknown, callback: (res: EventEmitter) => void) => {
		const request = new EventEmitter();
		queueMicrotask(() => {
			const res = new EventEmitter() as EventEmitter & {
				statusCode: number;
				headers: Record<string, string>;
				resume: () => void;
			};
			res.statusCode = 200;
			res.headers = {};
			res.resume = () => {};
			callback(res);
			queueMicrotask(() => {
				const isApi = String(url).startsWith("https://api.github.com/");
				if (!isApi) downloaded.push(String(url).split("/").pop() ?? "");
				const body = isApi
					? JSON.stringify({
							tag_name: "v2.0.0",
							assets: ASSET_NAMES.map((name) => ({
								name,
								browser_download_url: `https://github.com/opengrep/opengrep/releases/download/v2.0.0/${name}`,
							})),
						})
					: "ZIP-BYTES";
				res.emit("data", Buffer.from(body));
				res.emit("end");
			});
		});
		return request;
	},
);

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
	downloaded.length = 0;
	extractedMembers.splice(0, extractedMembers.length, ...ZIP_MEMBERS);
	for (const key of ["PI_LENS_HOME", "PI_LENS_DISABLE_TOOL_INSTALL"])
		savedEnv[key] = process.env[key];
	delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
	Object.defineProperty(process, "platform", {
		value: "win32",
		configurable: true,
	});
});

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

afterAll(() => {
	for (const root of roots) removeTempDirSync(root);
});

function pinnedHome(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5624-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, "bin"), { recursive: true });
	process.env.PI_LENS_HOME = root;
	return root;
}

describe("opengrep on Windows installs from the v2.0.0 zip with its DLLs (#5624)", () => {
	it("downloads the .zip (never a .cert/.sig) and lands opengrep.exe beside every DLL it ships", async () => {
		const root = pinnedHome();

		vi.resetModules();
		const installer = await import("../../../clients/installer/index.js");
		const installed = await installer.installTool("opengrep");

		expect(installed).toBe(true);
		expect(downloaded).toEqual(["opengrep_windows_x86.zip"]);
		expect(fs.readdirSync(path.join(root, "bin")).sort()).toEqual(
			[...ZIP_MEMBERS].sort(),
		);
	});

	// The DLL move is opt-in (`bundleArchiveDlls`): any other zip tool's
	// sibling DLLs stay behind rather than landing in the shared managed bin.
	it("a zip tool that does not opt in leaves its sibling DLLs out of the bin", async () => {
		extractedMembers.splice(0, extractedMembers.length, "tflint.exe", "x.dll");
		const root = pinnedHome();

		vi.resetModules();
		const installer = await import("../../../clients/installer/index.js");
		expect(await installer.installTool("tflint")).toBe(true);
		expect(downloaded).toEqual(["tflint_windows_amd64.zip"]);
		expect(fs.readdirSync(path.join(root, "bin"))).toEqual(["tflint.exe"]);
	});

	it("a zip that carries no DLLs still installs the exe alone", async () => {
		extractedMembers.splice(0, extractedMembers.length, "opengrep.exe");
		const root = pinnedHome();

		vi.resetModules();
		const installer = await import("../../../clients/installer/index.js");
		expect(await installer.installTool("opengrep")).toBe(true);
		expect(fs.readdirSync(path.join(root, "bin"))).toEqual(["opengrep.exe"]);
	});
});
