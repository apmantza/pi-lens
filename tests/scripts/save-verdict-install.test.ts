/**
 * #4999 R3-1: a FAILED install must reach the save-verdict row as a cause.
 *
 * The driver (`scripts/probe-save-verdict.mjs`) wraps `ensureTool` in a
 * `try/catch`, and the round-2 case pinned that path with the string
 * `"install failed for clangd: getaddrinfo EAI_AGAIN"` — a throw the installer
 * does not produce. `ensureTool` answers `undefined` on every install failure it
 * owns (failed download, policy decline, held lock), so the catch never fired,
 * `row.failures` stayed empty, and the fixture was filed as
 * `server never spawned (no capability snapshot)`. On the 2026-10 run that line
 * covered nine fixtures a night with no way to tell an absent toolchain from a
 * failed download from a crashed server.
 *
 * These cases drive the REAL installer (`clients/installer/index.js`, the same
 * artifact the driver's `dist/` build comes from) with only the spawn boundary
 * mocked, and assert the exact cause line the driver records — so the guard is
 * proven against the failure mode it was written for, not against a fabricated
 * throw (#4999 R3-1; AGENTS shape 50).
 *
 * Limit, named: the driver itself is not spawned here, because it imports
 * `dist/`, which the Unit shards job does not build. The driver's install block
 * is one call to `installCauses` plus a join of its result, so the decision
 * under test is the one below.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	detailWithInstallCauses,
	installCauses,
	saveVerdictCells,
} from "../../scripts/lib/save-verdict.mjs";
import { drainRegisteredBackgroundWritesForTests } from "../support/background-write-drains.js";
import { withEnv } from "../support/with-env.js";

// `clients/safe-spawn` is pi-lens's single child-process seam, so the mocked
// call stands in for the spawned `npm` and needs no admission (AGENTS.md "Test
// requirements"). No child is spawned, no timer is real, and the installer under
// test is the real module.
const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal()),
	safeSpawnAsync,
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	resetSafeSpawnWindowsCommandCache: vi.fn(),
	isCommandAvailableAsync: vi.fn(async () => false),
}));

const FIXTURE = { lang: "fish", tools: ["fish-lsp"] };
// An id the installer does not manage: gopls, csharp-ls and fsautocomplete are
// supplied by the runner's own toolchain, and `ensureTool` answers `undefined`
// for each while the installer records `declined: unknown tool id` (#4999 R4-1).
const GO_FIXTURE = { lang: "go", tools: ["gopls"] };

const npmOk = { stdout: "", stderr: "", status: 0 };
const npmFailed = {
	stdout: "",
	stderr: "npm error 404 Not Found - GET https://registry.npmjs.org/fish-lsp",
	status: 1,
};

let piLensHome: string;
let restoreEnv: () => void;

/** The real installer, loaded fresh so its tools dir picks up `PI_LENS_HOME`. */
async function installer(): Promise<
	typeof import("../../clients/installer/index.js")
> {
	vi.resetModules();
	return import("../../clients/installer/index.js");
}

/** Plant the binary a successful npm install is expected to leave behind. */
function plantFishLspBinary(): void {
	const binDir = path.join(piLensHome, "tools", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const names =
		process.platform === "win32" ? ["fish-lsp.cmd", "fish-lsp"] : ["fish-lsp"];
	for (const name of names) {
		fs.writeFileSync(path.join(binDir, name), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
	}
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	piLensHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sv-install-"));
	restoreEnv = withEnv({
		PI_LENS_HOME: piLensHome,
		PI_LENS_DISABLE_TOOL_INSTALL: undefined,
	});
});

afterEach(async () => {
	try {
		// #5657: a successful install leaves a dirty probe-cache entry, and its
		// 300 ms debounced flush writes into this per-test root. Each test removes
		// its root here, so the drain runs first, before the removal, and the
		// flush must read idle after it.
		await drainRegisteredBackgroundWritesForTests();
		const { flushProbeCache } =
			await import("../../clients/installer/index.js");
		expect(await flushProbeCache()).toBe("idle");
	} finally {
		(await import("../../clients/project-trust.js")).resetProjectTrust();
		restoreEnv();
		fs.rmSync(piLensHome, { recursive: true, force: true });
	}
});

describe("installCauses: the cause a failed ensureTool leaves (#4999 R3-1)", () => {
	it("records the installer's own failure, which never throws", async () => {
		safeSpawnAsync.mockResolvedValue(npmFailed);
		const { ensureTool, getInstallAttempt } = await installer();

		// The pre-round shape: a throw is the only thing the driver's catch sees.
		await expect(ensureTool("fish-lsp")).resolves.toBeUndefined();
		expect(getInstallAttempt("fish-lsp")?.outcome).toBe("failed");

		const causes = await installCauses(FIXTURE, {
			ensureTool,
			getInstallAttempt,
		});
		expect(causes).toHaveLength(1);
		expect(causes[0]).toMatch(/^install failed for fish-lsp: .*404/);
		// The registry's own text, not the generic fallback: an operator reading
		// the nightly line can tell a 404 from a refused connection.
		expect(causes[0]).toContain("registry.npmjs.org/fish-lsp");
	});

	it("records a policy decline, which also resolves nothing", async () => {
		const restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
		try {
			safeSpawnAsync.mockResolvedValue(npmFailed);
			const { ensureTool, getInstallAttempt } = await installer();

			await ensureTool("fish-lsp");
			const causes = await installCauses(FIXTURE, {
				ensureTool,
				getInstallAttempt,
			});
			expect(causes).toHaveLength(1);
			expect(causes[0]).toContain("install declined for fish-lsp:");
			expect(causes[0]).toContain("PI_LENS_DISABLE_TOOL_INSTALL");
		} finally {
			restore();
		}
	});

	it("blames nothing when the toolchain resolved, whatever the attempt says", async () => {
		// A resolved path is the answer to "is the toolchain here?" — the arms can
		// run on it. `ensureTool` records `declined` on its trust-gated DISCOVERY
		// branch and still returns the binary it found, so reading the attempt
		// alone would suppress a measurement the run actually made.
		safeSpawnAsync.mockImplementation(async () => {
			plantFishLspBinary();
			return npmOk;
		});
		const { ensureTool, getInstallAttempt } = await installer();

		// One call, the driver's own shape: `installCauses` is the only caller.
		expect(
			await installCauses(FIXTURE, { ensureTool, getInstallAttempt }),
		).toEqual([]);
		// The install genuinely ran and succeeded, so this is the guard's real
		// cell: an attempt record exists and still blames nothing.
		expect(getInstallAttempt("fish-lsp")?.outcome).toBe("succeeded");
	});

	it("still records a throw, which is the only path the old case covered", async () => {
		const causes = await installCauses(FIXTURE, {
			ensureTool: async () => {
				throw new Error("getaddrinfo EAI_AGAIN");
			},
			getInstallAttempt: () => undefined,
		});
		expect(causes).toEqual([
			"install failed for fish-lsp: getaddrinfo EAI_AGAIN",
		]);
	});
});

/**
 * #4999 R4-1, one case per row of the state table in the PR body: what an
 * install state leaves on the row.
 *
 * Three writers own three axes. `installCauses` COLLECTS the cause the installer
 * recorded. The arms decide the verdict. `detailWithInstallCauses` joins a cause
 * into the row detail ONLY where the arms left the row unmeasured. Round 3
 * returned from `probeFixture` the moment `installCauses` reported anything, so
 * a fixture whose tool the installer does not manage — `gopls`, `csharp-ls`,
 * `fsautocomplete` record `declined: unknown tool id` while the runner's
 * toolchain still supplies the binary — was filed not measured. go, csharp and
 * fsharp regressed from measured to `install declined for …` in `tool-smoke` run
 * 40978934098 attempt 2 against 40971037638 (#4999 R4-1).
 *
 * The arms themselves cannot run here (they spawn a language server), so each
 * case supplies the state the arms leave — `cells` when they measured,
 * `undefined` when they did not — through the same `saveVerdictCells` the driver
 * calls, and asserts the row's verdict and detail.
 */

const MEASURED_ARMS = {
	mode: "push-only",
	noSave: { nonEmpty: 1, ms: 97 },
	silence: { nonEmpty: 0, ms: null },
	saveAlone: { nonEmpty: 0, ms: null },
	savedWrite: { nonEmpty: 0, ms: null },
};

/** The row the driver builds before the install step runs. */
interface ProbeRowFixture {
	fixture: { lang: string; tools?: string[] };
	server: string;
	save: string;
	mode: string;
	arms: typeof MEASURED_ARMS;
	waitMs: number;
	failures: string[];
	install: string[];
	detail: string;
	cells?: Record<string, string>;
}

function rowFor(overrides: Partial<ProbeRowFixture> = {}): ProbeRowFixture {
	return {
		fixture: FIXTURE,
		server: "fish-lsp",
		save: "save",
		mode: "push-only",
		arms: MEASURED_ARMS,
		waitMs: 6000,
		failures: [],
		install: [],
		detail: "",
		...overrides,
	};
}

/** A row whose first arm threw, so no arm could measure it (#4999 F8). */
function unmeasuredRow(
	overrides: Partial<ProbeRowFixture> = {},
): ProbeRowFixture {
	return rowFor({
		failures: ["no-save arm failed: spawn gopls ENOENT"],
		detail: "server never spawned (no capability snapshot)",
		...overrides,
	});
}

describe("the row an install state produces (#4999 R4-1 state table)", () => {
	it("row 1: measures a resolved path, whatever the attempt recorded", async () => {
		// The installer's trust-gated DISCOVERY branch: it refuses to install, finds
		// the managed binary anyway, and records `declined` against a resolved tool.
		// `installer()` resets the module registry, so the trust latch must be set on
		// the copy the installer itself imports (shape 14) — not a static import.
		safeSpawnAsync.mockResolvedValue(npmOk);
		plantFishLspBinary();
		const { ensureTool, getInstallAttempt } = await installer();
		const { setProjectTrustState } =
			await import("../../clients/project-trust.js");
		setProjectTrustState("untrusted");

		const row = rowFor();
		row.install = await installCauses(FIXTURE, {
			ensureTool,
			getInstallAttempt,
		});
		expect(getInstallAttempt("fish-lsp")?.outcome).toBe("declined");
		expect(row.install).toEqual([]);
		expect(saveVerdictCells(row)).toBeDefined();
		row.cells = saveVerdictCells(row);
		expect(detailWithInstallCauses(row)).not.toContain("install ");
	});

	it("row 2: installCauses reports a decline and the detail omits it on a measured row (R4-1; the driver probe witnesses the wiring)", async () => {
		// The regression itself: gopls is on PATH (the runner's toolchain), the
		// installer declines the unknown id, and round 3 filed the row not
		// measured instead of letting the arms decide.
		const { ensureTool, getInstallAttempt } = await installer();
		await expect(ensureTool("gopls")).resolves.toBeUndefined();
		expect(getInstallAttempt("gopls")).toMatchObject({
			outcome: "declined",
			reason: "unknown tool id",
		});

		const row = rowFor({
			fixture: GO_FIXTURE,
			server: "gopls",
			detail: "mode=push-only no-save=1@97ms",
		});
		row.install = await installCauses(GO_FIXTURE, {
			ensureTool,
			getInstallAttempt,
		});
		expect(row.install).toEqual([
			"install declined for gopls: unknown tool id",
		]);
		row.cells = saveVerdictCells(row);
		expect(row.cells).toBeDefined();
		expect(detailWithInstallCauses(row)).toBe(row.detail);
	});

	it("row 3: names a failed install on a row no arm could measure", async () => {
		safeSpawnAsync.mockResolvedValue(npmFailed);
		const { ensureTool, getInstallAttempt } = await installer();

		const row = unmeasuredRow();
		row.install = await installCauses(FIXTURE, {
			ensureTool,
			getInstallAttempt,
		});
		expect(row.install).toHaveLength(1);
		expect(row.install[0]).toMatch(/^install failed for fish-lsp: .*404/);
		expect(saveVerdictCells(row)).toBeUndefined();
		// Both facts reach the line: the cause the installer owns, then why no arm
		// measured. Dropping either would send an operator back to the same
		// ambiguous "server never spawned".
		const detail = detailWithInstallCauses(row);
		expect(detail.startsWith(row.install[0])).toBe(true);
		expect(
			detail.endsWith("server never spawned (no capability snapshot)"),
		).toBe(true);
	});

	it("row 4: names a declined install and the spawn failure when nothing spawned", async () => {
		const { ensureTool, getInstallAttempt } = await installer();

		const row = unmeasuredRow();
		row.install = await installCauses(GO_FIXTURE, {
			ensureTool,
			getInstallAttempt,
		});
		expect(row.install).toEqual([
			"install declined for gopls: unknown tool id",
		]);
		expect(saveVerdictCells(row)).toBeUndefined();
		expect(detailWithInstallCauses(row)).toBe(
			"install declined for gopls: unknown tool id — server never spawned (no capability snapshot)",
		);
	});

	it("row 5: says so when the installer recorded no attempt at all", async () => {
		const row = unmeasuredRow();
		row.install = await installCauses(GO_FIXTURE, {
			ensureTool: async () => undefined,
			getInstallAttempt: () => undefined,
		});
		expect(row.install).toEqual([
			"install not attempted for gopls: no reason recorded",
		]);
		expect(detailWithInstallCauses(row)).toContain(
			"install not attempted for gopls: no reason recorded",
		);
	});

	it("row 6: measures a server the runner supplies despite a thrown ensure", async () => {
		const row = rowFor({ detail: "mode=push-only no-save=1@97ms" });
		row.install = await installCauses(GO_FIXTURE, {
			ensureTool: async () => {
				throw new Error("getaddrinfo EAI_AGAIN");
			},
			getInstallAttempt: () => undefined,
		});
		expect(row.install).toEqual([
			"install failed for gopls: getaddrinfo EAI_AGAIN",
		]);
		row.cells = saveVerdictCells(row);
		expect(row.cells).toBeDefined();
		expect(detailWithInstallCauses(row)).toBe(row.detail);
	});

	it("row 7: names a thrown ensure on a row no arm could measure", async () => {
		const row = unmeasuredRow();
		row.install = await installCauses(GO_FIXTURE, {
			ensureTool: async () => {
				throw new Error("getaddrinfo EAI_AGAIN");
			},
			getInstallAttempt: () => undefined,
		});
		expect(saveVerdictCells(row)).toBeUndefined();
		expect(detailWithInstallCauses(row)).toBe(
			"install failed for gopls: getaddrinfo EAI_AGAIN — server never spawned (no capability snapshot)",
		);
	});

	it("row 8: a fixture that declares no tool carries no cause either way", async () => {
		const { ensureTool, getInstallAttempt } = await installer();
		const install = await installCauses(
			{ lang: "cpp", tools: [] },
			{ ensureTool, getInstallAttempt },
		);
		expect(install).toEqual([]);

		const measured = rowFor({
			install,
			detail: "mode=push-only no-save=1@97ms",
		});
		measured.cells = saveVerdictCells(measured);
		expect(measured.cells).toBeDefined();
		expect(detailWithInstallCauses(measured)).toBe(measured.detail);

		const unmeasured = unmeasuredRow({ install });
		expect(detailWithInstallCauses(unmeasured)).toBe(unmeasured.detail);
	});
});
