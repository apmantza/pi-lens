/**
 * Periodic refresh for the NON-npm managed-tool strategies (#1747).
 *
 * #1730/PR #1746 unfroze the npm entries. The other five strategies stayed
 * frozen on day-one versions because `installTool` only runs when a tool is
 * absent: 27 github entries kept the release they resolved on first install, 6
 * pip entries kept whatever `pip install --user` picked, and the archive/maven
 * entries kept whatever pin was in the registry the day they landed — even
 * after this repo bumped it.
 *
 * These tests pin the policy per strategy, in the shape #1730's tests pin the
 * npm one:
 *   - a stale stamp produces exactly ONE refresh attempt;
 *   - a fresh stamp produces none;
 *   - a failed refresh degrades once, keeps the installed copy serving, and
 *     does not poison the next attempt;
 *   - github re-resolution is bounded: an unchanged tag or a 304 downloads
 *     nothing, and the ETag is replayed as `If-None-Match`;
 *   - archive/maven compare the REGISTRY pin and touch the network only when
 *     it moved.
 *
 * `node:https` and `safeSpawnAsync` are mocked so network calls and spawns can
 * be counted exactly. Everything else — the stamp file, the presence checks,
 * the cadence arithmetic — runs for real against a temp `PI_LENS_HOME`.
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
import { withEnv } from "../../support/with-env.js";

vi.unmock("../../../clients/installer/index.js");

const TEST_HOME = vi.hoisted(() => {
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-1747-"),
	);
	// TOOLS_DIR / GITHUB_BIN_DIR are module-level consts, so the override must
	// land before the installer module is imported.
	process.env.PI_LENS_HOME = dir;
	return dir;
});

const { spawnMock, sessionLogSpy, httpsGetMock, renameMock } = vi.hoisted(
	() => ({
		spawnMock: vi.fn(),
		sessionLogSpy: vi.fn(),
		httpsGetMock: vi.fn(),
		renameMock: vi.fn(),
	}),
);

// Every method delegates to the REAL `node:fs/promises` except `rename`,
// which defaults to the real implementation too but is reconfigurable per
// test (#1759 review R3/R4). ESM builtins can't be `vi.spyOn`'d at runtime
// ("Module namespace is not configurable" — ESM's live-binding rule), so the
// only way to make ONE rename call fail on demand is to mock the module at
// load time and keep the mock a controllable passthrough by default.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	renameMock.mockImplementation((...args: Parameters<typeof actual.rename>) =>
		actual.rename(...args),
	);
	const mocked = { ...actual, rename: renameMock };
	return { ...mocked, default: mocked };
});

vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: spawnMock,
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

vi.mock("node:https", () => ({
	default: { get: httpsGetMock },
	get: httpsGetMock,
}));

vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: sessionLogSpy,
	flushSessionStartLog: async () => {},
	flushSessionStartLogSync: () => {},
	SESSIONSTART_LOG_FILE: "",
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	checkProbeCache,
	getRefreshableManagedTools,
	resetProbeCacheStateForTesting,
	swapExtractedDir,
	TOOLS,
	updateProbeCache,
} from "../../../clients/installer/index.js";
import {
	getManagedToolRefreshStatePath,
	runManagedToolRefresh,
} from "../../../clients/installer/managed-tool-refresh.js";
import { resetManagedToolRefreshSession } from "../../../clients/installer/managed-tool-refresh-session.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";

const TOOLS_DIR = path.join(TEST_HOME, "tools");
const BIN_DIR = path.join(TEST_HOME, "bin");
const PROBE_CACHE_PATH = path.join(TEST_HOME, "probe-cache.json");
const STATE_PATH = getManagedToolRefreshStatePath();
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const SPOTBUGS_PIN =
	"https://github.com/spotbugs/spotbugs/releases/download/4.10.2/spotbugs-4.10.2.tgz";
const KTFMT_PIN =
	"https://repo1.maven.org/maven2:com.facebook:ktfmt:0.63:with-dependencies";

// --- fixtures -------------------------------------------------------------

/** Put a managed-bin artifact where `findGitHubToolPath` looks for it. */
function installManagedBin(binaryName: string): void {
	fs.mkdirSync(BIN_DIR, { recursive: true });
	for (const name of [binaryName, `${binaryName}.exe`]) {
		fs.writeFileSync(path.join(BIN_DIR, name), "#!/bin/sh\nexit 0\n");
	}
}

/** Record a pip/gem tool in the persisted probe cache, pointing at a real file. */
function installProbeCached(toolId: string): void {
	fs.mkdirSync(TEST_HOME, { recursive: true });
	const binPath = path.join(TEST_HOME, `${toolId}-bin`);
	fs.writeFileSync(binPath, "");
	const existing = fs.existsSync(PROBE_CACHE_PATH)
		? JSON.parse(fs.readFileSync(PROBE_CACHE_PATH, "utf-8"))
		: {};
	existing[toolId] = { path: binPath, mtimeMs: 1, cachedAt: NOW };
	fs.writeFileSync(PROBE_CACHE_PATH, JSON.stringify(existing));
	resetProbeCacheStateForTesting();
}

function writeState(tools: Record<string, unknown>): void {
	fs.mkdirSync(TOOLS_DIR, { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify({ version: 1, tools }, null, 2));
}

function readState(): Record<
	string,
	{
		checkedAt: number;
		version?: string;
		resolutionId?: string;
		etag?: string;
		failed?: boolean;
	}
> {
	return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")).tools;
}

// --- https mock -----------------------------------------------------------

interface FakeResponse {
	statusCode: number;
	headers?: Record<string, string>;
	body?: Buffer | string;
}

let httpsRoutes: Array<{
	match: (url: string) => boolean;
	respond: (
		url: string,
		headers: Record<string, string>,
	) => FakeResponse | "error";
}> = [];

function httpsUrls(): string[] {
	return httpsGetMock.mock.calls.map(([url]) => String(url));
}

function httpsHeadersFor(urlFragment: string): Record<string, string> {
	const call = httpsGetMock.mock.calls.find(([url]) =>
		String(url).includes(urlFragment),
	);
	return (call?.[1]?.headers ?? {}) as Record<string, string>;
}

httpsGetMock.mockImplementation(
	(
		url: string,
		options: { headers?: Record<string, string> },
		callback: (res: unknown) => void,
	) => {
		const request = new EventEmitter();
		const route = httpsRoutes.find((candidate) => candidate.match(url));
		queueMicrotask(() => {
			if (!route) {
				request.emit("error", new Error(`no route for ${url}`));
				return;
			}
			const outcome = route.respond(url, options.headers ?? {});
			if (outcome === "error") {
				request.emit("error", new Error(`network down for ${url}`));
				return;
			}
			const res = new EventEmitter() as EventEmitter & {
				statusCode: number;
				headers: Record<string, string>;
				resume: () => void;
			};
			res.statusCode = outcome.statusCode;
			res.headers = outcome.headers ?? {};
			res.resume = () => {};
			callback(res);
			queueMicrotask(() => {
				if (outcome.body !== undefined) {
					res.emit("data", Buffer.from(outcome.body));
				}
				res.emit("end");
			});
		});
		return request;
	},
);

/** A `releases/latest` route for shfmt returning `tag`, plus its asset. */
function routeGitHubRelease(
	tag: string,
	options: { etag?: string; notModified?: boolean } = {},
): void {
	httpsRoutes.push({
		match: (url) => url.startsWith("https://api.github.com/"),
		respond: (_url, headers) => {
			if (options.notModified && headers["If-None-Match"]) {
				return {
					statusCode: 304,
					headers: options.etag
						? { etag: options.etag }
						: ({} as Record<string, string>),
				};
			}
			return {
				statusCode: 200,
				headers: options.etag
					? { etag: options.etag }
					: ({} as Record<string, string>),
				body: JSON.stringify({
					tag_name: tag,
					assets: [
						{
							name: `shfmt_${tag}_linux_amd64`,
							browser_download_url: `https://github.com/mvdan/sh/releases/download/${tag}/shfmt_${tag}_linux_amd64`,
						},
						{
							name: `shfmt_${tag}_windows_amd64.exe`,
							browser_download_url: `https://github.com/mvdan/sh/releases/download/${tag}/shfmt_${tag}_windows_amd64.exe`,
						},
						{
							name: `shfmt_${tag}_darwin_amd64`,
							browser_download_url: `https://github.com/mvdan/sh/releases/download/${tag}/shfmt_${tag}_darwin_amd64`,
						},
					],
				}),
			};
		},
	});
	httpsRoutes.push({
		match: (url) => url.includes("github.com/mvdan/sh/releases/download"),
		respond: () => ({ statusCode: 200, body: Buffer.from("fake-binary") }),
	});
}

function assetDownloads(): string[] {
	return httpsUrls().filter((url) => url.includes("/releases/download/"));
}

function apiCalls(): string[] {
	return httpsUrls().filter((url) => url.startsWith("https://api.github.com/"));
}

// --- spawn mock -----------------------------------------------------------

/**
 * Answer every spawn with `status: 0` unless the command matches `failing`.
 * Recorded so the test can assert exactly which package-manager invocations ran.
 */
function stubSpawn(options: { fail?: RegExp } = {}): void {
	spawnMock.mockImplementation(async (command: string, args: string[]) => {
		const line = `${command} ${(args ?? []).join(" ")}`;
		if (options.fail?.test(line)) {
			return { stdout: "", stderr: `boom: ${line}`, status: 1 };
		}
		return { stdout: "1.2.3", stderr: "", status: 0 };
	});
}

function spawnLines(): string[] {
	return spawnMock.mock.calls.map(
		([command, args]) => `${command} ${(args ?? []).join(" ")}`,
	);
}

/** Spawns that are a package-manager install/upgrade, not a version probe. */
function installSpawns(): string[] {
	return spawnLines().filter((line) =>
		/\binstall\b|\bupdate\b|\bupgrade\b/.test(line),
	);
}

function degradationCount(): number {
	return (
		getDegradationSummary().find((g) => g.kind === "managed-tool-refresh")
			?.count ?? 0
	);
}

function degradationSubjects(): string[] {
	return (
		getDegradationSummary()
			.find((g) => g.kind === "managed-tool-refresh")
			?.latestReasons.map((r) => r.subject) ?? []
	);
}

function logRows(): string[] {
	return sessionLogSpy.mock.calls.map(([message]) => String(message));
}

/**
 * Every OTHER refreshable tool gets a fresh stamp, so a test that installs one
 * fixture is asserting about that fixture and not racing 60 registry entries
 * for the single per-session slot.
 */
function freshenAllExcept(
	toolId: string,
	extra: Record<string, unknown> = {},
): void {
	const tools: Record<string, unknown> = {};
	for (const tool of getRefreshableManagedTools()) {
		if (tool.toolId === toolId) continue;
		tools[tool.toolId] = { checkedAt: NOW };
	}
	writeState({ ...tools, ...extra });
}

let originalPath: string | undefined;
let restoreDisableToolInstall: () => void;

beforeEach(() => {
	fs.rmSync(TOOLS_DIR, { recursive: true, force: true });
	fs.rmSync(BIN_DIR, { recursive: true, force: true });
	fs.rmSync(PROBE_CACHE_PATH, { force: true });
	fs.mkdirSync(TOOLS_DIR, { recursive: true });
	httpsRoutes = [];
	httpsGetMock.mockClear();
	spawnMock.mockReset();
	sessionLogSpy.mockReset();
	resetDegradationLedger();
	resetManagedToolRefreshSession();
	resetProbeCacheStateForTesting();
	stubSpawn();
	// `installMavenTool` gates on a JRE via a PATH walk, so give it one.
	originalPath = process.env.PATH;
	const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1747-java-"));
	for (const name of ["java", "java.exe"]) {
		fs.writeFileSync(path.join(fakeBin, name), "x");
	}
	process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
	delete process.env.PI_LENS_DISABLE_TOOL_REFRESH;
	delete process.env.PI_LENS_TOOL_REFRESH_MAX_PER_SESSION;
	// `vitest.config.*` defaults this to "1" globally so an ordinary test run
	// can never trigger a real install. `refreshManagedTool` now honors that
	// same kill switch (#1759 review F2), so these tests — which deliberately
	// exercise the archive/maven/github/pip/gem refresh-and-install paths
	// against mocked https/spawn — have to opt back in, the same way
	// `installer-lifecycle.integration.test.ts` does for its child process.
	restoreDisableToolInstall = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "0" });
});

afterEach(() => {
	if (originalPath !== undefined) process.env.PATH = originalPath;
	restoreDisableToolInstall();
	delete process.env.PI_LENS_INSTALL_LOCK_TIMEOUT_MS;
	resetProjectTrust();
	vi.unstubAllEnvs();
});

afterAll(() => {
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// --- candidate derivation -------------------------------------------------

describe("candidate derivation covers every strategy", () => {
	it("derives all six strategies from the registry, not a hand-kept list", () => {
		const byStrategy = new Map<string, number>();
		for (const tool of getRefreshableManagedTools()) {
			byStrategy.set(tool.strategy, (byStrategy.get(tool.strategy) ?? 0) + 1);
		}
		// The five strategies #1730/#1746 left frozen.
		expect(byStrategy.get("github")).toBeGreaterThan(0);
		expect(byStrategy.get("pip")).toBeGreaterThan(0);
		expect(byStrategy.get("archive")).toBeGreaterThan(0);
		expect(byStrategy.get("maven")).toBeGreaterThan(0);
		expect(byStrategy.get("gem")).toBeGreaterThan(0);
		expect(byStrategy.get("npm")).toBeGreaterThan(0);
	});

	it("admits every registry entry whose coordinate can move on this platform", () => {
		const derived = new Set(
			getRefreshableManagedTools().map((tool) => tool.toolId),
		);
		const expected = TOOLS.filter(
			(tool) =>
				tool.installStrategy === "github" ||
				tool.installStrategy === "pip" ||
				tool.installStrategy === "gem" ||
				tool.installStrategy === "maven",
		).map((tool) => tool.id);
		// A single missing id here is the single-source-of-truth defect this
		// derivation exists to prevent.
		expect(expected.filter((id) => !derived.has(id))).toEqual([]);
	});

	it("records the registry pin as the resolution identity for archive and maven", () => {
		const byId = new Map(
			getRefreshableManagedTools().map((tool) => [tool.toolId, tool]),
		);
		expect(byId.get("spotbugs")?.pinnedCoordinate).toBe(SPOTBUGS_PIN);
		expect(byId.get("ktfmt")?.pinnedCoordinate).toBe(KTFMT_PIN);
		// github/pip/gem/npm resolve inside their own registry, so they carry none.
		expect(byId.get("shfmt")?.pinnedCoordinate).toBeUndefined();
		expect(byId.get("ruff")?.pinnedCoordinate).toBeUndefined();
	});

	it("never refreshes a tool pi-lens has not installed", async () => {
		// The registry offers plenty of refreshable entries...
		expect(getRefreshableManagedTools().length).toBeGreaterThan(30);
		// ...but nothing is on disk: no bin artifact, no probe cache, no
		// node_modules. A refresh here would be an unrequested install.
		const outcome = await runManagedToolRefresh(NOW);
		expect(outcome.skipped).toBe("no-candidates");
		expect(httpsUrls()).toEqual([]);
		expect(installSpawns()).toEqual([]);
	});
});

// --- github ---------------------------------------------------------------

describe("github strategy", () => {
	it("re-resolves a stale release and installs the new tag", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: { checkedAt: NOW - 8 * DAY_MS, resolutionId: "v3.7.0" },
		});
		routeGitHubRelease("v3.12.0", { etag: 'W/"abc"' });

		const outcome = await runManagedToolRefresh(NOW);

		expect(apiCalls()).toHaveLength(1);
		expect(assetDownloads()).toHaveLength(1);
		expect(outcome.refreshed).toHaveLength(1);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "shfmt",
			strategy: "github",
			previousVersion: undefined,
			currentVersion: "v3.12.0",
			changed: true,
			ok: true,
		});
		expect(readState().shfmt).toMatchObject({
			checkedAt: NOW,
			resolutionId: "v3.12.0",
			etag: 'W/"abc"',
		});
	});

	it("downloads nothing when the release tag has not moved", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: { checkedAt: NOW - 8 * DAY_MS, resolutionId: "v3.12.0" },
		});
		routeGitHubRelease("v3.12.0", { etag: 'W/"same"' });

		const outcome = await runManagedToolRefresh(NOW);

		expect(apiCalls()).toHaveLength(1);
		expect(assetDownloads()).toEqual([]);
		expect(outcome.refreshed[0]).toMatchObject({ changed: false, ok: true });
	});

	it("replays the stored ETag and treats 304 as unchanged", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.12.0",
				etag: 'W/"cached"',
			},
		});
		routeGitHubRelease("v3.99.0", { etag: 'W/"cached"', notModified: true });

		const outcome = await runManagedToolRefresh(NOW);

		expect(httpsHeadersFor("api.github.com")["If-None-Match"]).toBe(
			'W/"cached"',
		);
		expect(assetDownloads()).toEqual([]);
		expect(outcome.refreshed[0]).toMatchObject({ changed: false, ok: true });
		expect(readState().shfmt).toMatchObject({ resolutionId: "v3.12.0" });
	});

	it("refreshes nothing when the stamp is still fresh", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: { checkedAt: NOW - DAY_MS, resolutionId: "v3.12.0" },
		});
		routeGitHubRelease("v3.99.0");

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("nothing-due");
		expect(httpsUrls()).toEqual([]);
	});

	it("degrades once and keeps serving when the release query fails", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.7.0",
				version: "v3.7.0",
				etag: 'W/"old"',
			},
		});
		httpsRoutes.push({
			match: (url) => url.startsWith("https://api.github.com/"),
			respond: () => "error",
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		expect(assetDownloads()).toEqual([]);
		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("shfmt");
		// The managed binary is untouched: availability never depends on refresh.
		expect(fs.existsSync(path.join(BIN_DIR, "shfmt"))).toBe(true);
		const stamp = readState().shfmt;
		expect(stamp.failed).toBe(true);
		expect(stamp.resolutionId).toBe("v3.7.0");
		// A failed run must not persist a validator: replaying it would make the
		// retry a 304 and skip the install that never happened.
		expect(stamp.etag).toBeUndefined();
	});

	it("drops the cached resolved path after a failed refresh, so a stale answer is not served (#1759 review R5)", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.7.0",
				version: "v3.7.0",
			},
		});
		// Seed the on-disk resolved-path cache with a decoy path — as if an
		// earlier, unrelated resolution had cached it — so this test can prove
		// the failure branch actually EVICTS it, not just that it exists.
		const decoyPath = path.join(TEST_HOME, "shfmt-decoy-stale-path");
		fs.writeFileSync(decoyPath, "decoy");
		await updateProbeCache("shfmt", decoyPath);
		expect(await checkProbeCache("shfmt")).toBe(decoyPath);

		httpsRoutes.push({
			match: (url) => url.startsWith("https://api.github.com/"),
			respond: () => "error",
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false });
		// The pin: a failed refresh must not leave the stale decoy path cached —
		// the next resolution has to re-probe rather than trust a claim this
		// attempt just proved outdated.
		expect(await checkProbeCache("shfmt")).toBeUndefined();
	});

	it("degrades and stamps a failure — not a throw — when the release body has no assets array (#1759 review F3)", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.7.0",
				version: "v3.7.0",
			},
		});
		// A 200 with a tag but no `assets` field — not a network error, and not
		// a shape `JSON.parse` rejects, but one `pickReleaseAsset` used to throw
		// on (`.assets.find` on `undefined`), uncaught, skipping every stamp
		// write this candidate would otherwise get.
		httpsRoutes.push({
			match: (url) => url.startsWith("https://api.github.com/"),
			respond: () => ({
				statusCode: 200,
				body: JSON.stringify({ tag_name: "v3.12.0" }),
			}),
		});

		const outcome = await runManagedToolRefresh(NOW);

		// The run itself never throws out of `runManagedToolRefresh` — it is
		// reported as an ordinary failed attempt.
		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		expect(assetDownloads()).toEqual([]);
		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("shfmt");
		// The starvation this closes: a FAILURE stamp applies the 24h retry
		// cooldown, so the next SESSION does not re-take the one-per-session
		// slot on the same permanently-malformed release.
		const stamp = readState().shfmt;
		expect(stamp).toBeDefined();
		expect(stamp.failed).toBe(true);

		// One session later (within the 24h retry window), the tool must NOT be
		// selected again — proving the stamp actually suppresses the retry, not
		// just that a stamp exists.
		resetManagedToolRefreshSession();
		httpsGetMock.mockClear();
		const nextSessionOutcome = await runManagedToolRefresh(NOW + 60_000);
		expect(nextSessionOutcome.skipped).toBe("nothing-due");
		expect(apiCalls()).toEqual([]);
	});

	it.each([
		["null", "null"],
		["an array", "[]"],
		["a bare string", '"just a string"'],
	])(
		"degrades and stamps a failure — not a throw — when the release body is %s (#1759 review R5)",
		async (_label, body) => {
			installManagedBin("shfmt");
			freshenAllExcept("shfmt", {
				shfmt: {
					checkedAt: NOW - 8 * DAY_MS,
					resolutionId: "v3.7.0",
					version: "v3.7.0",
				},
			});
			// `JSON.parse` accepts any of these — none is a parse error — but
			// `.tag_name` would throw reading off `null`/an array/a string,
			// uncaught, the same starvation shape F3 already closed for a missing
			// `assets` array on an otherwise-valid object.
			httpsRoutes.push({
				match: (url) => url.startsWith("https://api.github.com/"),
				respond: () => ({ statusCode: 200, body }),
			});

			const outcome = await runManagedToolRefresh(NOW);

			expect(outcome.refreshed[0]).toMatchObject({
				ok: false,
				changed: false,
			});
			expect(degradationCount()).toBe(1);
			expect(degradationSubjects()).toContain("shfmt");
			const stamp = readState().shfmt;
			expect(stamp).toBeDefined();
			expect(stamp.failed).toBe(true);
		},
	);

	it("degrades when the refreshed binary does not run", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.7.0",
				version: "v3.7.0",
			},
		});
		routeGitHubRelease("v3.12.0", { etag: 'W/"new"' });
		// The download succeeds, the asset is written, and the binary is broken.
		// (#2015: the post-refresh verification runs through `safeSpawnAsync`,
		// the same seam as every other spawn, so the broken-binary scenario
		// overrides it directly: the refreshed artifact's --version probe exits
		// nonzero while any other spawn keeps the beforeEach default.)
		const baseSpawn = spawnMock.getMockImplementation();
		spawnMock.mockImplementation(async (command: string, args: string[]) => {
			if ((args ?? []).includes("--version")) {
				return { stdout: "", stderr: "cannot execute", status: 126 };
			}
			return baseSpawn?.(command, args) ?? { stdout: "1.2.3", stderr: "", status: 0 };
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false });
		expect(degradationCount()).toBe(1);
		const stamp = readState().shfmt;
		expect(stamp.failed).toBe(true);
		// The new tag is NOT recorded: recording it would make the next refresh
		// think the broken release is the installed one and never retry.
		expect(stamp.resolutionId).toBe("v3.7.0");
		expect(stamp.etag).toBeUndefined();
	});

	it("names the version it kept serving in the session log", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.7.0",
				version: "v3.7.0",
			},
		});
		httpsRoutes.push({
			match: (url) => url.startsWith("https://api.github.com/"),
			respond: () => "error",
		});

		await runManagedToolRefresh(NOW);

		expect(
			logRows().some(
				(row) =>
					row.includes("managed-tool-refresh shfmt") &&
					row.includes("keeping v3.7.0"),
			),
		).toBe(true);
	});
});

// --- pip / gem ------------------------------------------------------------

describe("pip strategy", () => {
	it("upgrades a stale package with -U, exactly once", async () => {
		installProbeCached("ruff");
		freshenAllExcept("ruff", {
			ruff: { checkedAt: NOW - 8 * DAY_MS, version: "0.5.0" },
		});

		const outcome = await runManagedToolRefresh(NOW);

		const upgrades = installSpawns().filter((line) => line.includes("ruff"));
		expect(upgrades).toHaveLength(1);
		// `-U` is the whole fix: without it pip leaves the installed copy alone.
		expect(upgrades[0]).toMatch(/install -U --user ruff/);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "ruff",
			strategy: "pip",
			ok: true,
		});
	});

	it("refreshes nothing when the stamp is fresh", async () => {
		installProbeCached("ruff");
		freshenAllExcept("ruff", {
			ruff: { checkedAt: NOW - DAY_MS, version: "0.5.0" },
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("nothing-due");
		expect(installSpawns()).toEqual([]);
	});

	it("degrades when the upgrade leaves a binary that cannot report a version", async () => {
		installProbeCached("ruff");
		freshenAllExcept("ruff", {
			ruff: { checkedAt: NOW - 8 * DAY_MS, version: "0.5.0" },
		});
		// The version probe answers before the upgrade and fails after it: the
		// upgrade replaced a working copy with one that cannot run.
		let probes = 0;
		spawnMock.mockImplementation(async (_command: string, args: string[]) => {
			if ((args ?? []).includes("install")) {
				return { stdout: "", stderr: "", status: 0 };
			}
			probes += 1;
			return probes === 1
				? { stdout: "0.5.0", stderr: "", status: 0 }
				: { stdout: "", stderr: "cannot execute", status: 126 };
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false });
		expect(degradationCount()).toBe(1);
		expect(readState().ruff).toMatchObject({ failed: true, version: "0.5.0" });
	});

	it("degrades once and keeps the recorded version when pip fails", async () => {
		installProbeCached("ruff");
		freshenAllExcept("ruff", {
			ruff: { checkedAt: NOW - 8 * DAY_MS, version: "0.5.0" },
		});
		stubSpawn({ fail: /install -U --user ruff/ });

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("ruff");
		const stamp = readState().ruff;
		expect(stamp.failed).toBe(true);
		expect(stamp.version).toBe("0.5.0");
	});
});

describe("gem strategy", () => {
	it("re-runs the install command, which is gem's upgrade command", async () => {
		installProbeCached("rubocop");
		freshenAllExcept("rubocop", {
			rubocop: { checkedAt: NOW - 8 * DAY_MS, version: "1.60.0" },
		});

		const outcome = await runManagedToolRefresh(NOW);

		const installs = installSpawns().filter((line) => line.includes("rubocop"));
		expect(installs).toHaveLength(1);
		expect(installs[0]).toMatch(/^gem install rubocop --no-document$/);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "rubocop",
			strategy: "gem",
			ok: true,
		});
	});

	it("degrades once when gem fails", async () => {
		installProbeCached("rubocop");
		freshenAllExcept("rubocop", {
			rubocop: { checkedAt: NOW - 8 * DAY_MS, version: "1.60.0" },
		});
		stubSpawn({ fail: /gem install rubocop/ });

		await runManagedToolRefresh(NOW);

		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("rubocop");
		expect(readState().rubocop.failed).toBe(true);
	});
});

// --- archive / maven ------------------------------------------------------

describe("archive and maven strategies compare the registry pin", () => {
	it("touches the network for archive only when the pin moved", async () => {
		installManagedBin("spotbugs");
		freshenAllExcept("spotbugs", {
			spotbugs: { checkedAt: NOW - 8 * DAY_MS, resolutionId: SPOTBUGS_PIN },
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(httpsUrls()).toEqual([]);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "spotbugs",
			strategy: "archive",
			changed: false,
			ok: true,
		});
		expect(readState().spotbugs).toMatchObject({
			checkedAt: NOW,
			resolutionId: SPOTBUGS_PIN,
		});
	});

	it("reinstalls archive exactly once when the recorded pin is stale", async () => {
		installManagedBin("spotbugs");
		freshenAllExcept("spotbugs", {
			spotbugs: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: `${SPOTBUGS_PIN}-old`,
			},
		});
		httpsRoutes.push({
			match: (url) => url.includes("spotbugs"),
			respond: () => ({ statusCode: 200, body: Buffer.from("archive-bytes") }),
		});

		await runManagedToolRefresh(NOW);

		expect(httpsUrls().filter((url) => url === SPOTBUGS_PIN)).toHaveLength(1);
	});

	it("degrades once and keeps the old pin when the archive reinstall fails", async () => {
		installManagedBin("spotbugs");
		freshenAllExcept("spotbugs", {
			spotbugs: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: `${SPOTBUGS_PIN}-old`,
			},
		});
		httpsRoutes.push({
			match: (url) => url.includes("spotbugs"),
			respond: () => "error",
		});

		await runManagedToolRefresh(NOW);

		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("spotbugs");
		const stamp = readState().spotbugs;
		expect(stamp.failed).toBe(true);
		expect(stamp.resolutionId).toBe(`${SPOTBUGS_PIN}-old`);
		// The shim is still there — a failed refresh never removes the tool.
		expect(fs.existsSync(path.join(BIN_DIR, "spotbugs"))).toBe(true);
	});

	it("touches the network for maven only when the GAV moved", async () => {
		installManagedBin("ktfmt");
		freshenAllExcept("ktfmt", {
			ktfmt: { checkedAt: NOW - 8 * DAY_MS, resolutionId: KTFMT_PIN },
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(httpsUrls()).toEqual([]);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "ktfmt",
			strategy: "maven",
			changed: false,
			ok: true,
		});
	});

	it("redownloads the maven JAR when the registry bumps the version", async () => {
		installManagedBin("ktfmt");
		freshenAllExcept("ktfmt", {
			ktfmt: { checkedAt: NOW - 8 * DAY_MS, resolutionId: `${KTFMT_PIN}-old` },
		});
		httpsRoutes.push({
			match: (url) => url.startsWith("https://repo1.maven.org/"),
			respond: () => ({ statusCode: 200, body: Buffer.from("jar-bytes") }),
		});

		await runManagedToolRefresh(NOW);

		expect(
			httpsUrls().filter((url) => url.includes("ktfmt-0.63")),
		).toHaveLength(1);
		expect(readState().ktfmt).toMatchObject({ resolutionId: KTFMT_PIN });
	});
});

// --- archive refresh never destroys a working install (#1759 review F1) --
//
// The reviewer's exact probe: a working extracted tree, a refresh whose
// replacement archive is corrupt, and the assertion that the OLD tree
// survives. The pre-fix code cleared `extractDir` (the live install) before
// extracting the replacement, so a corrupt download or a failed `tar` left
// the tool gone — even though the result and the log both claimed the
// installed version was kept.

describe("archive refresh preserves the working install on failure", () => {
	it("does not delete the working extracted tree when the replacement archive fails to extract", async () => {
		// A REAL working install at the final location `installArchiveTool` uses
		// — not just the `BIN_DIR` shim fixture, which the old code never touched
		// either and so would not have caught this bug.
		const extractDir = path.join(TOOLS_DIR, "spotbugs");
		const launcherPath = path.join(extractDir, "bin", "spotbugs");
		fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
		fs.writeFileSync(launcherPath, "WORKING-SPOTBUGS-BINARY");
		installManagedBin("spotbugs");
		freshenAllExcept("spotbugs", {
			spotbugs: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: `${SPOTBUGS_PIN}-old`,
			},
		});
		httpsRoutes.push({
			match: (url) => url === SPOTBUGS_PIN,
			respond: () => ({
				statusCode: 200,
				body: Buffer.from("truncated-corrupt-archive-bytes"),
			}),
		});
		// Simulate `tar` refusing a corrupt/truncated archive: the extraction
		// spawn itself is the one that fails, before any verification step runs.
		spawnMock.mockImplementation(async (command: string, args: string[]) => {
			if (
				/tar(\.exe)?$/i.test(command) ||
				(args ?? []).some((a) => /\.tgz$|\.zip$/.test(a))
			) {
				return {
					stdout: "",
					stderr: "tar: unexpected end of file",
					status: 1,
				};
			}
			return { stdout: "1.2.3", stderr: "", status: 0 };
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "spotbugs",
			ok: false,
			changed: false,
		});
		// The critical assertion: the pre-existing working binary is still there,
		// byte-for-byte, not just "some file exists at that path".
		expect(fs.existsSync(launcherPath)).toBe(true);
		expect(fs.readFileSync(launcherPath, "utf-8")).toBe(
			"WORKING-SPOTBUGS-BINARY",
		);
		expect(
			logRows().some(
				(l) => l.includes("spotbugs") && l.includes("keeping installed"),
			),
		).toBe(true);
		// No leftover scratch directory either.
		expect(fs.existsSync(`${extractDir}.refresh-tmp`)).toBe(false);
	});

	it("does not delete the working extracted tree when the replacement archive is missing its launcher", async () => {
		const extractDir = path.join(TOOLS_DIR, "spotbugs");
		const launcherPath = path.join(extractDir, "bin", "spotbugs");
		fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
		fs.writeFileSync(launcherPath, "WORKING-SPOTBUGS-BINARY");
		installManagedBin("spotbugs");
		freshenAllExcept("spotbugs", {
			spotbugs: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: `${SPOTBUGS_PIN}-old`,
			},
		});
		httpsRoutes.push({
			match: (url) => url === SPOTBUGS_PIN,
			respond: () => ({
				statusCode: 200,
				body: Buffer.from("wrong-platform-archive-bytes"),
			}),
		});
		// `tar` "succeeds" (a wrong-platform or empty archive is still a valid
		// archive) but writes nothing useful — the launcher this tool needs is
		// never on disk afterward, in the tmp extraction dir or anywhere else.
		spawnMock.mockImplementation(async () => ({
			stdout: "",
			stderr: "",
			status: 0,
		}));

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "spotbugs",
			ok: false,
			changed: false,
		});
		expect(fs.existsSync(launcherPath)).toBe(true);
		expect(fs.readFileSync(launcherPath, "utf-8")).toBe(
			"WORKING-SPOTBUGS-BINARY",
		);
	});
});

// --- swapExtractedDir rollback (#1759 review R3/R4) -----------------------
//
// `installArchiveTool`'s swap has two renames: the live tree out of the way,
// then the verified tmp tree into place. A full `installArchiveTool` run has
// no test-controlled pause point between them, so these tests drive
// `swapExtractedDir` directly and force the SECOND rename to fail by
// spying on `node:fs/promises`'s `rename` — the same module object
// `clients/installer/index.ts` calls through.

describe("swapExtractedDir rollback", () => {
	it("restores the live directory byte-for-byte when the second rename fails (reviewer V2)", async () => {
		const finalDir = path.join(TOOLS_DIR, "swap-test-r3");
		const tmpDir = path.join(TOOLS_DIR, "swap-test-r3-tmp-missing");
		fs.mkdirSync(finalDir, { recursive: true });
		fs.writeFileSync(path.join(finalDir, "marker.txt"), "WORKING-CONTENT");
		// `tmpDir` is deliberately never created: `fs.rename(tmpDir, finalDir)`
		// (the second rename) throws ENOENT, exactly as a genuine mid-swap
		// failure would (a killed process, a disk error, a permissions flip).

		await expect(
			swapExtractedDir("swap-test-tool", tmpDir, finalDir),
		).rejects.toThrow();

		// The critical assertion: finalDir is back, byte-for-byte, not just
		// "some directory exists at that path".
		expect(fs.existsSync(finalDir)).toBe(true);
		expect(fs.readFileSync(path.join(finalDir, "marker.txt"), "utf-8")).toBe(
			"WORKING-CONTENT",
		);
		// The rollback succeeded, so no orphan is left behind.
		expect(fs.existsSync(`${finalDir}.rollback`)).toBe(false);
		expect(degradationCount()).toBe(0);
	});

	it("records a degradation and logs the orphan path when BOTH renames fail (double-failure worst case, #1759 review R4)", async () => {
		const finalDir = path.join(TOOLS_DIR, "swap-test-r4");
		const backupDir = `${finalDir}.rollback`;
		const tmpDir = path.join(TOOLS_DIR, "swap-test-r4-tmp-missing");
		fs.mkdirSync(finalDir, { recursive: true });
		fs.writeFileSync(path.join(finalDir, "marker.txt"), "WORKING-CONTENT");

		// `swapExtractedDir` makes exactly three rename calls in this order:
		// (1) finalDir -> backupDir — let it succeed for real; (2) tmpDir ->
		// finalDir, the second rename — fail; (3) the rollback, backupDir ->
		// finalDir — fail too, reproducing the double-failure worst case.
		// `mockImplementationOnce` consumes each in order, then falls back to
		// `renameMock`'s base (real passthrough) implementation for any later
		// test.
		renameMock
			.mockImplementationOnce((...args: [fs.PathLike, fs.PathLike]) =>
				fs.promises.rename(...args),
			)
			.mockImplementationOnce(async () => {
				throw new Error("simulated: volume went read-only mid-swap");
			})
			.mockImplementationOnce(async () => {
				throw new Error("simulated: rollback rename also failed");
			});

		await expect(
			swapExtractedDir("swap-test-tool-r4", tmpDir, finalDir),
		).rejects.toThrow();

		// The worst case, stated plainly: finalDir is genuinely gone, and the
		// only surviving copy is the orphan at backupDir.
		expect(fs.existsSync(finalDir)).toBe(false);
		expect(fs.existsSync(backupDir)).toBe(true);
		expect(fs.readFileSync(path.join(backupDir, "marker.txt"), "utf-8")).toBe(
			"WORKING-CONTENT",
		);
		// The pin: a swallowed catch here would make the orphan invisible, not
		// just inconvenient.
		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("swap-test-tool-r4");
		expect(
			logRows().some(
				(row) => row.includes("orphaned") && row.includes(backupDir),
			),
		).toBe(true);
	});
});

// --- archive tree-bundle refresh records a fresh probe-cache mtime -------
// (#1759 review F7)
//
// `verifyRefreshedArtifact`'s tree-bundle branch has no single binary to run,
// so it returns `true` without a `--version` probe — but it still has to
// record the new mtime, or the persisted probe entry keeps the PRE-refresh
// mtime and forces a full re-resolution on the next dispatch anyway, which
// defeats the point of caching it.

describe("archive tree-bundle refresh updates the probe cache", () => {
	it("records a fresh probe-cache entry after a successful tree-bundle reinstall", async () => {
		const toolId = "powershell-editor-services";
		const treeMarkerRel = [
			"PowerShellEditorServices",
			"Start-EditorServices.ps1",
		];
		const extractDir = path.join(TOOLS_DIR, toolId);
		const markerPath = path.join(extractDir, ...treeMarkerRel);
		fs.mkdirSync(path.dirname(markerPath), { recursive: true });
		fs.writeFileSync(markerPath, "# stale bootstrap");

		freshenAllExcept(toolId, {
			[toolId]: { checkedAt: NOW - 8 * DAY_MS, resolutionId: "stale-url" },
		});

		const archiveTool = TOOLS.find((t) => t.id === toolId);
		const pinnedUrl = archiveTool?.archive?.url as string;
		httpsRoutes.push({
			match: (url) => url === pinnedUrl,
			respond: () => ({
				statusCode: 200,
				body: Buffer.from("fake-zip-bytes"),
			}),
		});
		// Simulate `tar` genuinely writing the tree marker into whatever `-C`
		// target the code extracted into — decoupled from any tmp-dir naming
		// convention, so this exercises the real extract → verify → swap path.
		spawnMock.mockImplementation(async (_command: string, args: string[]) => {
			const cIndex = (args ?? []).indexOf("-C");
			if (cIndex !== -1) {
				const targetDir = args[cIndex + 1];
				const written = path.join(TOOLS_DIR, targetDir, ...treeMarkerRel);
				fs.mkdirSync(path.dirname(written), { recursive: true });
				fs.writeFileSync(written, "# fresh bootstrap");
				return { stdout: "", stderr: "", status: 0 };
			}
			return { stdout: "1.2.3", stderr: "", status: 0 };
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({
			toolId,
			strategy: "archive",
			ok: true,
			changed: true,
		});
		expect(fs.readFileSync(markerPath, "utf-8")).toBe("# fresh bootstrap");
		// The pin: a probe-cache entry now exists for this tool, pointing at the
		// (post-swap) extract dir.
		expect(await checkProbeCache(toolId)).toBe(extractDir);
	});
});

// --- shared budget --------------------------------------------------------

describe("one budget across all strategies", () => {
	it("spends a single slot even when every strategy has a stale tool", async () => {
		installManagedBin("shfmt");
		installManagedBin("spotbugs");
		installManagedBin("ktfmt");
		installProbeCached("ruff");
		installProbeCached("rubocop");
		routeGitHubRelease("v3.12.0");
		httpsRoutes.push({ match: () => true, respond: () => "error" });
		// No stamps at all: everything is due.

		const outcome = await runManagedToolRefresh(NOW);

		// Exactly one refresh happened across five stale strategies — not none,
		// and not one per strategy.
		expect(outcome.refreshed).toHaveLength(1);
		expect(apiCalls().length + installSpawns().length).toBeLessThanOrEqual(1);
	});

	it("re-arms across sessions rather than latching for the process", async () => {
		installProbeCached("ruff");
		installProbeCached("rubocop");

		await runManagedToolRefresh(NOW);
		const first = installSpawns().length;
		resetManagedToolRefreshSession();
		await runManagedToolRefresh(NOW);

		expect(installSpawns().length).toBe(first + 1);
	});
});

// --- install kill-switch, trust gate, and install lock (#1759 review F2) --
//
// `refreshManagedTool` used to call the strategy install functions directly,
// bypassing every guard `installTool`/`ensureTool` honor: the kill switch,
// the project-trust gate, and the shared install lock. These tests prove the
// refresh path now goes through the same three gates BEFORE any strategy
// runs, and that a refusal is a skip — no network call, no degradation, and
// no stamp write, so the tool is retried plainly once the block lifts rather
// than throttled by a 24h failure cooldown that has nothing to do with it.

describe("install kill-switch, trust gate, and install lock", () => {
	function staleGithubShfmt(): void {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: { checkedAt: NOW - 8 * DAY_MS, resolutionId: "v3.7.0" },
		});
		routeGitHubRelease("v3.12.0");
	}

	it("declines and touches nothing when PI_LENS_DISABLE_TOOL_INSTALL=1", async () => {
		staleGithubShfmt();
		process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		expect(apiCalls()).toEqual([]);
		expect(assetDownloads()).toEqual([]);
		expect(degradationCount()).toBe(0);
		// The pre-existing stamp is untouched — no failure stamp, no retry
		// cooldown burned on a refusal that has nothing to do with the tool.
		expect(readState().shfmt).toEqual({
			checkedAt: NOW - 8 * DAY_MS,
			resolutionId: "v3.7.0",
		});
		expect(
			logRows().some((l) => l.includes("shfmt") && l.includes("declined")),
		).toBe(true);
	});

	it("declines and touches nothing when the host denies project trust", async () => {
		staleGithubShfmt();
		setProjectTrustState("untrusted");

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		expect(apiCalls()).toEqual([]);
		expect(assetDownloads()).toEqual([]);
		expect(degradationCount()).toBe(0);
		expect(readState().shfmt).toEqual({
			checkedAt: NOW - 8 * DAY_MS,
			resolutionId: "v3.7.0",
		});
	});

	it('proceeds normally on a host with no trust surface ("unknown", the default)', async () => {
		staleGithubShfmt();

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: true });
		expect(apiCalls().length).toBeGreaterThan(0);
	});

	it("declines rather than racing a concurrent install holding the shared lock", async () => {
		staleGithubShfmt();
		// Short timeout so the test does not wait out the real 150s default.
		process.env.PI_LENS_INSTALL_LOCK_TIMEOUT_MS = "150";
		const lockPath = path.join(TOOLS_DIR, ".install.lock");
		// This process's own pid is always "alive" to the liveness check, and a
		// fresh createdAt is never judged stale — so the lock holds for the
		// whole retry window, the same as a genuinely concurrent installer.
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
		);

		try {
			const outcome = await runManagedToolRefresh(NOW);

			expect(outcome.refreshed[0]).toMatchObject({
				ok: false,
				changed: false,
			});
			expect(apiCalls()).toEqual([]);
			expect(degradationCount()).toBe(0);
		} finally {
			fs.rmSync(lockPath, { force: true });
		}
	});
});
