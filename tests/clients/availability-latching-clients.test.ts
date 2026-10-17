/**
 * #1467 — the four spawn-probed clients that shared the latching shape all
 * inherit the new semantics: knip and madge through
 * `createAvailabilityChecker`, govulncheck through `SecurityScanClient`, and
 * vulture through the shared availability latch. Each is asserted only for its
 * WIRING to the seam; the policy itself is proved once in
 * `dispatch/runners/availability-latching.test.ts`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	INSTALL_TRANSIENT_BASE_COOLDOWN_MS,
	TRANSIENT_BASE_COOLDOWN_MS,
} from "../../clients/dispatch/runners/utils/availability-policy.js";
import { resetDispatchAvailabilityState } from "../../clients/dispatch/runners/utils/runner-helpers.js";
import { removeTempDirSync } from "./test-utils.js";

const { piLensDirHolder } = vi.hoisted(() => ({
	piLensDirHolder: { dir: "" },
}));

vi.mock("../../clients/file-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/file-utils.js")>()),
	getGlobalPiLensDir: () => piLensDirHolder.dir,
}));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
}));

vi.mock("../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => null),
	findManagedToolBinary: vi.fn(async () => undefined),
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({ ...process.env })),
}));

vi.mock("../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
}));

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

const missingResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const versionOk = { stdout: "6.4.1", stderr: "", status: 0 };

let tmpHome = "";

async function spawnMock() {
	const mod = await import("../../clients/safe-spawn.js");
	return vi.mocked(mod.safeSpawnAsync);
}

beforeEach(async () => {
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1467-home-"));
	piLensDirHolder.dir = tmpHome;
	(await spawnMock()).mockReset();
	resetDispatchAvailabilityState();
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
	vi.useRealTimers();
	removeTempDirSync(tmpHome);
});

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

describe("knip availability (#1467)", () => {
	it("resolves the managed binary with no spawn at all", async () => {
		const binDir = path.join(tmpHome, "tools", "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		const binName = process.platform === "win32" ? "knip.cmd" : "knip";
		fs.writeFileSync(path.join(binDir, binName), "");

		const { KnipClient } = await import("../../clients/knip-client.js");
		const client = new KnipClient(false);

		expect(await client.ensureAvailable()).toBe(true);
		expect(await spawnMock()).not.toHaveBeenCalled();
	});

	it("reports a probe timeout as a timeout, and recovers without a restart", async () => {
		const spawn = await spawnMock();
		spawn.mockResolvedValue(timeoutResult as never);

		const { KnipClient } = await import("../../clients/knip-client.js");
		const client = new KnipClient(false);
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-1467-proj-"),
		);
		try {
			fs.writeFileSync(path.join(projectDir, "package.json"), '{"name":"d"}');

			const failed = await client.analyze(projectDir);
			expect(failed.success).toBe(false);
			expect(failed.failureKind).toBe("unavailable-transient");
			expect(failed.summary).toContain("timed out");
			expect(failed.summary).not.toContain("Install with");

			// Later in the SAME process the probe answers. Pre-fix, `knipAvailable`
			// held `false` for the life of the client and knip stayed dead.
			advancePastCooldown();
			spawn.mockImplementation(async (_cmd, args) =>
				(args as string[]).includes("--version")
					? (versionOk as never)
					: ({ stdout: "", stderr: "", status: 0 } as never),
			);
			expect(await client.ensureAvailable()).toBe(true);
		} finally {
			removeTempDirSync(projectDir);
		}
	});

	// The timeout test above proves the WORDING, not the wiring: it never
	// asserts a duration, so dropping `elapsedMs` on the way from the probe to
	// the message leaves it green. That figure is the whole forensic value of
	// the record — "probe timed out" without it cannot distinguish a tool that
	// answered slowly from a host that never gave it the loop, which is the
	// distinction #1467 turned on. So make the probe cost real time and assert
	// the message reports it.
	it("reports how long the probe actually took, not just that it timed out", async () => {
		const spawn = await spawnMock();
		// `Date` is faked suite-wide, so a real setTimeout would still measure
		// zero. Advance the clock the probe reads, which is both deterministic
		// and closer to what a 5s budget expiring actually looks like.
		spawn.mockImplementation(async () => {
			vi.setSystemTime(new Date(Date.now() + 4800));
			return timeoutResult as never;
		});

		const { KnipClient } = await import("../../clients/knip-client.js");
		const client = new KnipClient(false);
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-1467-elapsed-"),
		);
		try {
			fs.writeFileSync(path.join(projectDir, "package.json"), '{"name":"d"}');

			const failed = await client.analyze(projectDir);
			expect(failed.failureKind).toBe("unavailable-transient");

			const elapsed = failed.summary.match(/after (\d+)ms/);
			expect(elapsed).not.toBeNull();
			expect(Number(elapsed?.[1])).toBe(4800);
		} finally {
			removeTempDirSync(projectDir);
		}
	});

	it("still tells the user to install a genuinely missing knip", async () => {
		(await spawnMock()).mockResolvedValue(missingResult as never);

		const { KnipClient } = await import("../../clients/knip-client.js");
		const client = new KnipClient(false);
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-1467-miss-"),
		);
		try {
			fs.writeFileSync(path.join(projectDir, "package.json"), '{"name":"d"}');
			const result = await client.analyze(projectDir);
			expect(result.failureKind).toBe("unavailable-missing");
			expect(result.summary).toBe(
				"Knip not available. Install with: npm install -D knip",
			);
		} finally {
			removeTempDirSync(projectDir);
		}
	});
});

describe("madge availability (#1467)", () => {
	it("re-probes after a transient failure instead of skipping for the session", async () => {
		const spawn = await spawnMock();
		spawn.mockResolvedValue(timeoutResult as never);

		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const checker = new DependencyChecker(false);
		expect(await checker.ensureAvailable(process.cwd())).toBe(false);

		advancePastCooldown();
		spawn.mockResolvedValue(versionOk as never);
		expect(await checker.ensureAvailable(process.cwd())).toBe(true);
	});
});

describe("govulncheck availability (#1467)", () => {
	it("does not latch — and does not `go install` — on a timed-out probe", async () => {
		const spawn = await spawnMock();
		spawn.mockResolvedValue(timeoutResult as never);

		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const client = new GovulncheckClient(false);
		expect(await client.ensureAvailable()).toBe(false);
		// One probe only: the install path must not be entered on a host hiccup.
		expect(spawn).toHaveBeenCalledTimes(1);

		advancePastCooldown();
		spawn.mockResolvedValue(versionOk as never);
		expect(await client.ensureAvailable()).toBe(true);
	});

	it("stops re-running a repeatedly timing-out `go install` after the ceiling (#1497)", async () => {
		const spawn = await spawnMock();
		// govulncheck missing on PATH; the Go toolchain answers; every
		// `go install` eats its 60s budget without producing the binary.
		spawn.mockImplementation(async (cmd, args) => {
			const argv = Array.isArray(args) ? args.join(" ") : "";
			if (String(cmd) === "go" && argv.startsWith("version"))
				return { stdout: "go1.22.0", stderr: "", status: 0 } as never;
			if (String(cmd) === "go" && argv.startsWith("install"))
				return timeoutResult as never;
			return missingResult as never;
		});
		const installCount = () =>
			spawn.mock.calls.filter(
				([cmd, args]) =>
					String(cmd) === "go" && Array.isArray(args) && args[0] === "install",
			).length;

		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const client = new GovulncheckClient(false);

		// Each attempt is a fresh 60s compile; the install-class schedule spaces
		// them 5/10 minutes apart, and the third timeout is terminal.
		expect(await client.ensureAvailable()).toBe(false);
		expect(installCount()).toBe(1);

		vi.setSystemTime(
			new Date(Date.now() + INSTALL_TRANSIENT_BASE_COOLDOWN_MS + 1),
		);
		expect(await client.ensureAvailable()).toBe(false);
		expect(installCount()).toBe(2);

		vi.setSystemTime(
			new Date(Date.now() + INSTALL_TRANSIENT_BASE_COOLDOWN_MS * 2 + 1),
		);
		expect(await client.ensureAvailable()).toBe(false);
		expect(installCount()).toBe(3);

		// Ceiling reached: no fourth compile, no matter how much time passes.
		vi.setSystemTime(new Date(Date.now() + 3_600_000));
		expect(await client.ensureAvailable()).toBe(false);
		expect(installCount()).toBe(3);
	});
});

describe("vulture availability (#1467)", () => {
	it("re-probes after a transient failure, but latches a real absence", async () => {
		const spawn = await spawnMock();
		spawn.mockResolvedValue(timeoutResult as never);

		const { PythonDeadCodeClient } =
			await import("../../clients/dead-code-client.js");
		const client = new PythonDeadCodeClient(false);
		expect(await client.ensureAvailable()).toBe(false);
		const probesAfterTransient = spawn.mock.calls.length;

		advancePastCooldown();
		spawn.mockResolvedValue(versionOk as never);
		expect(await client.ensureAvailable()).toBe(true);
		expect(spawn.mock.calls.length).toBeGreaterThan(probesAfterTransient);

		const absent = new PythonDeadCodeClient(false);
		spawn.mockResolvedValue(missingResult as never);
		expect(await absent.ensureAvailable()).toBe(false);
		const probesAfterMissing = spawn.mock.calls.length;
		vi.setSystemTime(new Date(Date.now() + 10 * TRANSIENT_BASE_COOLDOWN_MS));
		expect(await absent.ensureAvailable()).toBe(false);
		expect(spawn.mock.calls.length).toBe(probesAfterMissing);
	});
});
