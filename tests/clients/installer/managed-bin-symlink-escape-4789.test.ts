/**
 * Recurrence this guards: #4789 (the #4780 lane probe, 2026-10-23). A probe
 * home whose `bin` was a symlink into the maintainer's real `~/.pi-lens/bin`
 * let the managed installer write a downloaded binary through the link: the
 * real `~/.pi-lens/bin/opengrep` was overwritten and had to be restored from
 * the v1.30.0 release.
 *
 * Reproduced through the production installer (`installTool("opengrep")`, the
 * github strategy: release lookup, asset download, atomic write into the
 * managed bin), in a fixture under the lane TMPDIR only; the victim is a
 * fixture file, never a real binary:
 *   - `home/bin` a symlink to a directory elsewhere: the install wrote
 *     THROUGH it and replaced the victim (the defect);
 *   - `home/bin/opengrep` a symlink to a file elsewhere: NOT reproduced. The
 *     writer stages a file and renames it over the target, which replaces the
 *     link itself and never opens the victim. Pinned below as a control so a
 *     later "optimisation" to an in-place write reds here.
 *
 * Only `node:https` and the process spawn seam are doubled (true process and
 * network boundaries); the installer, the atomic writer and the degradation
 * ledger run for real. The home is pinned the way a probe pins it:
 * `PI_LENS_HOME`. With no `PI_LENS_HOME` the default `~/.pi-lens/bin` is the
 * user's own and may legitimately be a link (dotfiles); that case is pinned too.
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

const { httpsGetMock } = vi.hoisted(() => ({ httpsGetMock: vi.fn() }));

vi.mock("node:https", () => ({
	default: { get: httpsGetMock },
	get: httpsGetMock,
}));
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: vi.fn(async () => ({
		stdout: "1.0.0",
		stderr: "",
		status: 0,
	})),
}));

const NEW_BYTES = "NEW-BINARY-FROM-THE-INSTALLER\n";
const ORIGINAL = "ORIGINAL-VICTIM\n";

/** Every opengrep asset name, so the case holds on any arch the suite runs on. */
const ASSET_NAMES = [
	"opengrep_linux_x86",
	"opengrep_linux_aarch64",
	"opengrep_osx_x86",
	"opengrep_osx_arm64",
	"opengrep_windows_x86.zip",
];

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
				const body = String(url).startsWith("https://api.github.com/")
					? JSON.stringify({
							tag_name: "v9.9.9",
							assets: ASSET_NAMES.map((name) => ({
								name,
								browser_download_url: `https://github.com/opengrep/opengrep/releases/download/v9.9.9/${name}`,
							})),
						})
					: NEW_BYTES;
				res.emit("data", Buffer.from(body));
				res.emit("end");
			});
		});
		return request;
	},
);

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function fixtureRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4789-bin-"));
	roots.push(root);
	return root;
}

/** Make a directory link; a junction on Windows needs no privilege. */
function linkDir(target: string, link: string): void {
	fs.symlinkSync(
		target,
		link,
		process.platform === "win32" ? "junction" : "dir",
	);
}

/** A victim directory holding `opengrep` with the original bytes. */
function makeVictim(root: string): { dir: string; file: string } {
	const dir = path.join(root, "victim-bin");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(
		dir,
		process.platform === "win32" ? "opengrep.exe" : "opengrep",
	);
	fs.writeFileSync(file, ORIGINAL);
	return { dir, file };
}

/** Load the installer and ledger fresh, bound to the current `PI_LENS_HOME`. */
async function loadFresh() {
	vi.resetModules();
	const installer = await import("../../../clients/installer/index.js");
	const ledger = await import("../../../clients/degradation-ledger.js");
	return { installer, ledger };
}

beforeEach(() => {
	for (const key of [
		"PI_LENS_HOME",
		"PI_LENS_DISABLE_TOOL_INSTALL",
		"PI_LENS_TEST_PLATFORM",
		"HOME",
		"USERPROFILE",
	])
		savedEnv[key] = process.env[key];
	delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
	process.env.PI_LENS_TEST_PLATFORM = "linux";
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

afterAll(() => {
	for (const root of roots) removeTempDirSync(root);
});

describe("the managed installer never writes through a bin directory that leaves a pinned home (#4789)", () => {
	it("a pinned PI_LENS_HOME whose bin is a link to a directory outside it: the victim keeps its bytes and the refusal is recorded once", async () => {
		const root = fixtureRoot();
		const victim = makeVictim(root);
		const home = path.join(root, "home");
		fs.mkdirSync(home, { recursive: true });
		linkDir(victim.dir, path.join(home, "bin"));
		process.env.PI_LENS_HOME = home;

		const { installer, ledger } = await loadFresh();
		const installed = await installer.installTool("opengrep");

		expect(fs.readFileSync(victim.file, "utf8")).toBe(ORIGINAL);
		expect(installed).toBe(false);
		const group = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "managed-tool-install");
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe("opengrep:bin-dir-escape");
		expect(group?.latestReasons[0]?.reason).toContain(
			"escapes the pinned PI_LENS_HOME",
		);
	});

	it("control: a pinned home with an ordinary bin directory installs", async () => {
		const root = fixtureRoot();
		const home = path.join(root, "home");
		fs.mkdirSync(path.join(home, "bin"), { recursive: true });
		process.env.PI_LENS_HOME = home;

		const { installer, ledger } = await loadFresh();
		const installed = await installer.installTool("opengrep");

		expect(installed).toBe(true);
		const binary = fs
			.readdirSync(path.join(home, "bin"))
			.find((name) => name.startsWith("opengrep"));
		expect(binary).toBeDefined();
		expect(fs.readFileSync(path.join(home, "bin", binary!), "utf8")).toBe(
			NEW_BYTES,
		);
		expect(
			ledger
				.getDegradationSummary()
				.some((entry) =>
					entry.latestReasons.some(
						(row) => row.subject === "opengrep:bin-dir-escape",
					),
				),
		).toBe(false);
	});

	// File symlinks need a privilege on Windows, so the case is skipped visibly.
	it.skipIf(process.platform === "win32")(
		"not reproduced, pinned: a symlinked FILE in the bin is replaced by the atomic write, never written through",
		async () => {
			const root = fixtureRoot();
			const victim = makeVictim(root);
			const home = path.join(root, "home");
			fs.mkdirSync(path.join(home, "bin"), { recursive: true });
			fs.symlinkSync(victim.file, path.join(home, "bin", "opengrep"));
			process.env.PI_LENS_HOME = home;

			const { installer } = await loadFresh();
			await installer.installTool("opengrep");

			expect(fs.readFileSync(victim.file, "utf8")).toBe(ORIGINAL);
			expect(
				fs.lstatSync(path.join(home, "bin", "opengrep")).isSymbolicLink(),
			).toBe(false);
		},
	);

	it("scope: with no PI_LENS_HOME the default ~/.pi-lens/bin is the user's own, and a link there is honored", async () => {
		const root = fixtureRoot();
		const victim = makeVictim(root);
		const userHome = path.join(root, "user-home");
		fs.mkdirSync(path.join(userHome, ".pi-lens"), { recursive: true });
		linkDir(victim.dir, path.join(userHome, ".pi-lens", "bin"));
		delete process.env.PI_LENS_HOME;
		process.env.HOME = userHome;
		process.env.USERPROFILE = userHome;

		const { installer } = await loadFresh();
		const installed = await installer.installTool("opengrep");

		expect(installed).toBe(true);
		expect(fs.readFileSync(victim.file, "utf8")).toBe(NEW_BYTES);
	});
});
