/**
 * Recurrence this guards: #5643. The helm/helm GitHub release holds only `.asc`
 * signature files; the archives live on get.helm.sh. The github strategy for
 * `helm` matched no asset on any platform, so a fresh install could never
 * succeed (the nightly hid it: its runner image already has helm on PATH).
 *
 * Driven through the production entry point (`installTool("helm")`: release
 * lookup, asset pick, derived get.helm.sh URL, download, extraction, move into
 * the managed bin) with platform and arch overridden per cell. Only `node:https`
 * and the process spawn seam are doubled, the way #5624's test does it: the
 * spawn double plays `tar` / `Expand-Archive` by writing the real archive's
 * member layout (`<os>-<arch>/helm`, `LICENSE`, `README.md`) into the
 * destination. The home is pinned under the test's own temp dir.
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

const { httpsGetMock, extractLayout } = vi.hoisted(() => ({
	httpsGetMock: vi.fn(),
	extractLayout: { dir: "", exe: "" },
}));

vi.mock("node:https", () => ({
	default: { get: httpsGetMock },
	get: httpsGetMock,
}));
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: vi.fn(async (command: string, args: string[]) => {
		let destination: string | undefined;
		if (command === "tar") destination = args[args.indexOf("-C") + 1];
		if (command === "powershell")
			destination = /-DestinationPath '([^']+)'/.exec(args[2] ?? "")?.[1];
		if (destination) {
			for (const member of [extractLayout.exe, "LICENSE", "README.md"]) {
				const target = path.join(destination, extractLayout.dir, member);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, `bytes:${member}`);
			}
		}
		return { stdout: "v4.3.2", stderr: "", status: 0 };
	}),
}));

const TAG = "v4.3.2";

/**
 * The helm v4.3.2 release's real asset list (`gh api repos/helm/helm/releases/latest`,
 * 2026-11-15): 12 archives, each published ONLY as `.asc`, `.sha256.asc` and
 * `.sha256sum.asc` signature files. No archive is on the release.
 */
const RELEASE_ASSET_NAMES = [
	"darwin-amd64.tar.gz",
	"darwin-arm64.tar.gz",
	"linux-386.tar.gz",
	"linux-amd64.tar.gz",
	"linux-arm.tar.gz",
	"linux-arm64.tar.gz",
	"linux-loong64.tar.gz",
	"linux-ppc64le.tar.gz",
	"linux-riscv64.tar.gz",
	"linux-s390x.tar.gz",
	"windows-amd64.zip",
	"windows-arm64.zip",
].flatMap((cell) =>
	[".asc", ".sha256.asc", ".sha256sum.asc"].map(
		(suffix) => `helm-${TAG}-${cell}${suffix}`,
	),
);

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
				if (!isApi) downloaded.push(String(url));
				const body = isApi
					? JSON.stringify({
							tag_name: TAG,
							assets: RELEASE_ASSET_NAMES.map((name) => ({
								name,
								browser_download_url: `https://github.com/helm/helm/releases/download/${TAG}/${name}`,
							})),
						})
					: "ARCHIVE-BYTES";
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
const realArch = Object.getOwnPropertyDescriptor(process, "arch");

beforeEach(() => {
	downloaded.length = 0;
	for (const key of ["PI_LENS_HOME", "PI_LENS_DISABLE_TOOL_INSTALL"])
		savedEnv[key] = process.env[key];
	delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
});

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
	if (realArch) Object.defineProperty(process, "arch", realArch);
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

afterAll(() => {
	for (const root of roots) removeTempDirSync(root);
});

function pinnedHome(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5643-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, "bin"), { recursive: true });
	process.env.PI_LENS_HOME = root;
	return root;
}

function setCell(platform: string, arch: string): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
	Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

describe("helm installs from get.helm.sh when the GitHub release holds only signatures (#5643)", () => {
	it.each([
		["linux", "x64", "linux-amd64.tar.gz", "helm"],
		["linux", "arm64", "linux-arm64.tar.gz", "helm"],
		["darwin", "x64", "darwin-amd64.tar.gz", "helm"],
		["darwin", "arm64", "darwin-arm64.tar.gz", "helm"],
		["win32", "x64", "windows-amd64.zip", "helm.exe"],
		["win32", "arm64", "windows-arm64.zip", "helm.exe"],
	])(
		"%s/%s downloads the get.helm.sh archive and lands the nested binary",
		async (platform, arch, cell, exe) => {
			setCell(platform, arch);
			extractLayout.dir = cell.replace(/\.(tar\.gz|zip)$/, "");
			extractLayout.exe = exe;
			const root = pinnedHome();

			vi.resetModules();
			const installer = await import("../../../clients/installer/index.js");
			const installed = await installer.installTool("helm");

			expect(installed).toBe(true);
			// Never a GitHub release URL: the release carries no archive, and a
			// `.asc` download would install a signature file as the binary.
			expect(downloaded).toEqual([`https://get.helm.sh/helm-${TAG}-${cell}`]);
			expect(fs.readdirSync(path.join(root, "bin"))).toEqual([exe]);
		},
	);
});
