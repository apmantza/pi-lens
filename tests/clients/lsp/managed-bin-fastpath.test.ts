/**
 * #2140 (LSP-server remainder): `resolveAndLaunch`'s candidate walk resolves
 * a bare command (`candidates: ["opengrep"]`) through the OS's own PATH
 * lookup only. A release-managed binary (opengrep, marksman, typos-lsp,
 * zizmor — every `installStrategy: "github"` tool) installed under
 * `~/.pi-lens/bin` with no PATH entry therefore ENOENTs every direct
 * candidate first, only for the `ensureTool()` step further down to find the
 * very same binary a few hundred ms later — the paired
 * unavailable-then-available shape #2140's evidence quotes. `SecurityScanClient`
 * (gitleaks/trivy/govulncheck/opengrep's CLI-scan path) already got this fix
 * in PR #2148/#2137; this is the sibling for the LSP-server launch path,
 * `OpengrepServer`/`MarksmanServer`/`TyposLspServer`/`ZizmorServer`'s shared
 * `resolveAndLaunch` call site.
 */
import * as fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { suspendAt, waitFor } from "../interleaving-kit.js";

vi.hoisted(() => {
	// This suite verifies the same NDJSON bytes a production reader consumes.
	// Keep the opt-out scoped to this worker; the repository test setup defaults
	// to test mode so ordinary suites do not write telemetry.
	process.env.PI_LENS_TEST_MODE = "0";
});

const { launchLSP, safeSpawnAsync } = vi.hoisted(() => ({
	launchLSP: vi.fn(),
	safeSpawnAsync: vi.fn(),
}));
const { findManagedToolBinary, ensureTool, getInstallAttempt } = vi.hoisted(
	() => ({
		findManagedToolBinary: vi.fn(
			async (_toolId: string) => undefined as string | undefined,
		),
		ensureTool: vi.fn(async () => null as string | null),
		getInstallAttempt: vi.fn(),
	}),
);
vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	admitProjectSuppliedTsserver: (tsserverPath: string) => tsserverPath,
}));
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));
vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment: () => ({}),
	findManagedToolBinary,
	getInstallAttempt,
}));

import {
	resetLspLaunchAvailabilityGeneration,
	resolveAndLaunch,
} from "../../../clients/lsp/server.js";
import { SecurityScanClient } from "../../../clients/security-scan-client.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";

const fakeProc = { stdout: {}, stderr: {} } as never;

class CompositionScanClient extends SecurityScanClient<string> {
	constructor() {
		super("opengrep");
	}
	protected doEnsureAvailable(): Promise<boolean> {
		return this.probeVersion(["--version"]).then((available) => {
			this.available = available;
			return available;
		});
	}
}

describe("resolveAndLaunch — managed-bin fast path (#2140)", () => {
	beforeEach(() => {
		launchLSP.mockReset();
		findManagedToolBinary.mockReset();
		findManagedToolBinary.mockResolvedValue(undefined);
		ensureTool.mockReset();
		getInstallAttempt.mockReset();
		getInstallAttempt.mockReturnValue({ outcome: "succeeded", at: Date.now() });
	});

	it("tries the managed release binary BEFORE the bare PATH candidate", async () => {
		const managedPath = "/home/user/.pi-lens/bin/opengrep";
		findManagedToolBinary.mockImplementation(async (toolId: string) =>
			toolId === "opengrep" ? managedPath : undefined,
		);
		launchLSP.mockResolvedValueOnce(fakeProc);

		const result = await resolveAndLaunch(
			{
				candidates: ["opengrep"],
				args: ["lsp", "--experimental"],
				cwd: "/tmp/proj",
				managedToolId: "opengrep",
			},
			false,
		);

		expect(result?.source).toBe("direct");
		// The managed path must be the FIRST (and here, only-needed) candidate
		// tried — never a bare-PATH ENOENT first.
		expect(launchLSP).toHaveBeenCalledTimes(1);
		expect(launchLSP).toHaveBeenCalledWith(
			managedPath,
			["lsp", "--experimental"],
			expect.anything(),
		);
	});

	it("does not duplicate the bare candidate when it already equals the managed path", async () => {
		findManagedToolBinary.mockImplementation(async (toolId: string) =>
			toolId === "marksman" ? "marksman" : undefined,
		);
		// #2140 fix-round F2: EVERY attempt rejects (tool-not-found), so
		// resolveAndLaunch walks its whole candidate list rather than
		// short-circuiting on the first success. Without the dedup guard, the
		// prepended managed path ("marksman") and the original bare candidate
		// ("marksman") would both be tried — two identical, both-failing
		// attempts instead of one. A `mockResolvedValueOnce` on the first call
		// would mask that: resolveAndLaunch returns after the first SUCCESS
		// regardless of whether a duplicate entry was ever reached.
		const toolNotFound = Object.assign(new Error("marksman not found"), {
			kind: "tool-not-found" as const,
		});
		launchLSP.mockRejectedValue(toolNotFound);

		await resolveAndLaunch(
			{
				candidates: ["marksman"],
				args: ["server"],
				cwd: "/tmp/proj",
				managedToolId: "marksman",
			},
			false,
		);

		expect(launchLSP).toHaveBeenCalledTimes(1);
	});

	it("falls back to the bare PATH candidate when no managed binary is resolved", async () => {
		launchLSP.mockResolvedValueOnce(fakeProc);

		const result = await resolveAndLaunch(
			{
				candidates: ["typos-lsp"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "typos-lsp",
			},
			false,
		);

		expect(result?.source).toBe("direct");
		expect(launchLSP).toHaveBeenCalledWith("typos-lsp", [], expect.anything());
	});
});

/** availability_decision records emitted for `tool`, oldest first (#2140). */
async function decisionsFor(
	tool: string,
): Promise<Array<Record<string, unknown>>> {
	await flushLatencyLog();
	let text = "";
	try {
		text = await fs.readFile(getLatencyLogPath(), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter(
			(entry) =>
				entry?.phase === "availability_decision" &&
				(entry.metadata as Record<string, unknown> | undefined)?.tool === tool,
		);
}

function metadataOf(record: Record<string, unknown>): Record<string, unknown> {
	return record.metadata as Record<string, unknown>;
}

describe("resolveAndLaunch — managed-bin availability telemetry (#2140)", () => {
	beforeEach(async () => {
		launchLSP.mockReset();
		findManagedToolBinary.mockReset();
		findManagedToolBinary.mockResolvedValue(undefined);
		ensureTool.mockReset();
		clearLatencyLog();
		await flushLatencyLog();
	});

	it("emits exactly ONE availability_decision (verdict=available) when the managed binary is present", async () => {
		const managedPath = "/home/user/.pi-lens/bin/opengrep";
		findManagedToolBinary.mockImplementation(async (toolId: string) =>
			toolId === "opengrep" ? managedPath : undefined,
		);
		launchLSP.mockResolvedValueOnce(fakeProc);

		const result = await resolveAndLaunch(
			{
				candidates: ["opengrep"],
				args: ["lsp"],
				cwd: "/tmp/proj",
				managedToolId: "opengrep",
			},
			false,
		);

		expect(result?.source).toBe("direct");
		const decisions = await decisionsFor("opengrep");
		expect(decisions).toHaveLength(1);
		expect(metadataOf(decisions[0])).toMatchObject({
			verdict: "available",
			outcome: "success",
			cause: "ok",
			classifiedBy: "probe",
			evidence: { source: "managed-dir", binary: "opengrep" },
		});
	});

	it("attributes one managed-tool row to each active producer", async () => {
		const managedPath = "/home/user/.pi-lens/bin/opengrep";
		findManagedToolBinary
			.mockResolvedValueOnce(undefined)
			.mockResolvedValue(managedPath);
		safeSpawnAsync.mockResolvedValue({
			stdout: "opengrep 1.0.0",
			stderr: "",
			status: 0,
		} as never);
		const scanner = new CompositionScanClient();
		expect(await scanner.ensureAvailable()).toBe(true);
		// The security producer owns its latch, so a second caller does not
		// duplicate the same session decision.
		expect(await scanner.ensureAvailable()).toBe(true);

		launchLSP.mockResolvedValueOnce(fakeProc);
		expect(
			await resolveAndLaunch(
				{
					candidates: ["opengrep"],
					args: ["lsp"],
					cwd: "/tmp/proj",
					managedToolId: "opengrep",
				},
				false,
			),
		).toMatchObject({ source: "direct" });

		const rows = await decisionsFor("opengrep");
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => metadataOf(row).producer).sort()).toEqual([
			"lsp-launch",
			"security-scan",
		]);
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					metadata: expect.objectContaining({
						producer: "security-scan",
						latched: true,
					}),
				}),
				expect.objectContaining({
					metadata: expect.objectContaining({
						producer: "lsp-launch",
						latched: false,
					}),
				}),
			]),
		);
	});

	it("does not swallow the negative case: unavailable then the install-path override both emit when the binary is absent", async () => {
		const installedPath = "/home/user/.pi-lens/bin/typos-lsp";
		// Absent at first resolution; present once the install below "lands" it.
		findManagedToolBinary.mockImplementation(async (toolId: string) =>
			toolId === "typos-lsp" && ensureTool.mock.calls.length > 0
				? installedPath
				: undefined,
		);
		const toolNotFound = Object.assign(new Error("typos-lsp not found"), {
			kind: "tool-not-found" as const,
		});
		launchLSP.mockRejectedValueOnce(toolNotFound);
		launchLSP.mockResolvedValueOnce(fakeProc);
		ensureTool.mockResolvedValueOnce(installedPath);

		const result = await resolveAndLaunch(
			{
				candidates: ["typos-lsp"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "typos-lsp",
			},
			true,
		);

		expect(result?.source).toBe("managed");
		const decisions = await decisionsFor("typos-lsp");
		expect(decisions).toHaveLength(2);
		expect(metadataOf(decisions[0])).toMatchObject({
			verdict: "unavailable",
			outcome: "missing",
			cause: "not-found",
			classifiedBy: "probe",
		});
		expect(metadataOf(decisions[1])).toMatchObject({
			verdict: "available",
			outcome: "success",
			cause: "ok",
			classifiedBy: "caller",
			evidence: {
				install: "succeeded",
				binary: "typos-lsp",
				source: "managed-dir",
			},
		});
	});

	it("does not assert evidence.source when the install lands outside ~/.pi-lens/bin (npm/pip-strategy servers)", async () => {
		// findManagedToolBinary short-circuits to undefined for every non-github/
		// maven/archive strategy (installer/index.ts), before AND after install —
		// there is nothing to re-confirm, so the compensating row must not claim
		// managed-dir source it never derived (recurring-defect shape 13).
		findManagedToolBinary.mockResolvedValue(undefined);
		const toolNotFound = Object.assign(
			new Error("bash-language-server not found"),
			{
				kind: "tool-not-found" as const,
			},
		);
		launchLSP.mockRejectedValueOnce(toolNotFound);
		launchLSP.mockResolvedValueOnce(fakeProc);
		ensureTool.mockResolvedValueOnce(
			"/home/user/.pi-lens/tools/bash-language-server/bin/bash-language-server",
		);

		const result = await resolveAndLaunch(
			{
				candidates: ["bash-language-server"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "bash-language-server",
			},
			true,
		);

		expect(result?.source).toBe("managed");
		const decisions = await decisionsFor("bash-language-server");
		expect(decisions).toHaveLength(2);
		expect(metadataOf(decisions[1]).evidence).not.toHaveProperty("source");
	});

	it("only confirms managed-dir source when the installed path matches the fresh managed resolution", async () => {
		const staleManagedPath = "/home/user/.pi-lens/bin/typos-lsp-old";
		const installedPath = "/home/user/.pi-lens/bin/typos-lsp";
		const toolNotFound = Object.assign(new Error("typos-lsp not found"), {
			kind: "tool-not-found" as const,
		});
		findManagedToolBinary
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(staleManagedPath);
		launchLSP.mockRejectedValueOnce(toolNotFound);
		launchLSP.mockResolvedValueOnce(fakeProc);
		ensureTool.mockResolvedValueOnce(installedPath);

		await resolveAndLaunch(
			{
				candidates: ["typos-lsp"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "typos-lsp",
			},
			true,
		);

		const rows = await decisionsFor("typos-lsp");
		expect(metadataOf(rows[1]).evidence).not.toHaveProperty("source");
	});

	it("emits no availability_decision when a bare-PATH copy resolves and no managed binary exists", async () => {
		launchLSP.mockResolvedValueOnce(fakeProc);

		await resolveAndLaunch(
			{
				candidates: ["typos-lsp"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "typos-lsp",
			},
			false,
		);

		expect(await decisionsFor("typos-lsp")).toHaveLength(0);
	});

	it("does not claim a fresh install when ensureTool only returns a cached path", async () => {
		const cachedPath = "/home/user/.pi-lens/bin/opengrep";
		const toolNotFound = Object.assign(new Error("opengrep not found"), {
			kind: "tool-not-found" as const,
		});
		findManagedToolBinary.mockResolvedValue(undefined);
		launchLSP.mockRejectedValueOnce(toolNotFound);
		launchLSP.mockResolvedValueOnce(fakeProc);
		ensureTool.mockResolvedValueOnce(cachedPath);
		getInstallAttempt.mockReturnValue(undefined);

		await resolveAndLaunch(
			{
				candidates: ["opengrep"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "opengrep",
			},
			true,
		);

		const rows = await decisionsFor("opengrep");
		expect(metadataOf(rows[1]).evidence).toMatchObject({
			install: "not-attempted",
		});
		expect(metadataOf(rows[1]).evidence).not.toHaveProperty("source");
	});

	it("compensates force-reinstall success with the same honest install evidence", async () => {
		const managedPath = "/home/user/.pi-lens/bin/rust-analyzer";
		const toolNotFound = Object.assign(new Error("rust-analyzer not found"), {
			kind: "tool-not-found" as const,
		});
		findManagedToolBinary.mockResolvedValue(undefined);
		launchLSP.mockRejectedValueOnce(toolNotFound);
		launchLSP.mockRejectedValueOnce(toolNotFound);
		launchLSP.mockResolvedValueOnce(fakeProc);
		ensureTool
			.mockResolvedValueOnce("rust-analyzer")
			.mockResolvedValueOnce(managedPath);
		getInstallAttempt.mockReturnValue({
			outcome: "succeeded",
			at: Date.now(),
		});

		await resolveAndLaunch(
			{
				candidates: ["rust-analyzer"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "rust-analyzer",
			},
			true,
		);

		const rows = await decisionsFor("rust-analyzer");
		expect(rows).toHaveLength(2);
		expect(metadataOf(rows[1])).toMatchObject({
			producer: "lsp-launch",
			latched: false,
			evidence: {
				install: "succeeded",
				binary: "rust-analyzer",
				correctsLatchedRow: false,
			},
		});
	});

	it("keeps the ensure invocation's evidence across a concurrent overwrite", async () => {
		const installedPath = "/home/user/.pi-lens/bin/opengrep";
		const toolNotFound = Object.assign(new Error("opengrep not found"), {
			kind: "tool-not-found" as const,
		});
		findManagedToolBinary
			.mockResolvedValueOnce(undefined)
			.mockResolvedValue(installedPath);
		let ensureCalls = 0;
		ensureTool.mockImplementation(async () => {
			ensureCalls++;
			if (ensureCalls === 1) {
				getInstallAttempt.mockReturnValue({
					outcome: "succeeded",
					at: Date.now(),
				});
				return installedPath;
			}
			getInstallAttempt.mockReturnValue({
				outcome: "failed",
				reason: "concurrent attempt",
				at: Date.now(),
			});
			return null;
		});
		launchLSP.mockRejectedValueOnce(toolNotFound);
		const launch = suspendAt(launchLSP, async () => fakeProc, { calls: 1 });
		try {
			const launching = resolveAndLaunch(
				{
					candidates: ["opengrep"],
					args: [],
					cwd: "/tmp/proj",
					managedToolId: "opengrep",
				},
				true,
			);
			await launch.admitted;
			// A second ensure overwrites the installer's process-global last-attempt
			// state while the first LSP launch is still airborne.
			const concurrentEnsure = ensureTool as unknown as (
				toolId: string,
			) => Promise<string | null>;
			expect(await concurrentEnsure("opengrep")).toBeNull();
			launch.release();
			expect(await launching).toMatchObject({ source: "managed" });
			const rows = await decisionsFor("opengrep");
			expect(metadataOf(rows[1]).evidence).toMatchObject({
				install: "succeeded",
			});
			expect(metadataOf(rows[1]).evidence).not.toMatchObject({
				install: "failed",
			});
		} finally {
			launch.restore();
		}
	});

	it("does not publish managed availability when managed launch fails but PATH fallback succeeds", async () => {
		const managedPath = "/home/user/.pi-lens/bin/opengrep";
		const toolNotFound = Object.assign(new Error("managed binary failed"), {
			kind: "tool-not-found" as const,
		});
		findManagedToolBinary.mockResolvedValue(managedPath);
		launchLSP.mockRejectedValueOnce(toolNotFound);
		launchLSP.mockResolvedValueOnce(fakeProc);

		const result = await resolveAndLaunch(
			{
				candidates: ["opengrep"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "opengrep",
			},
			false,
		);

		expect(result?.source).toBe("direct");
		expect(launchLSP).toHaveBeenNthCalledWith(
			2,
			"opengrep",
			[],
			expect.anything(),
		);
		expect(await decisionsFor("opengrep")).toHaveLength(0);
	});

	it("drops a managed lookup that settles after the LSP generation resets", async () => {
		let release!: (value: string | undefined) => void;
		const pending = new Promise<string | undefined>((resolve) => {
			release = resolve;
		});
		findManagedToolBinary.mockReturnValueOnce(pending);
		const launching = resolveAndLaunch(
			{
				candidates: ["opengrep"],
				args: [],
				cwd: "/tmp/proj",
				managedToolId: "opengrep",
			},
			true,
		);
		resetLspLaunchAvailabilityGeneration();
		release(undefined);

		expect(await launching).toBeUndefined();
		expect(launchLSP).not.toHaveBeenCalled();
		expect(await decisionsFor("opengrep")).toHaveLength(0);
	});

	it("drops a rejected launch after reset before force reinstall can start", async () => {
		const toolNotFound = Object.assign(new Error("opengrep not found"), {
			kind: "tool-not-found" as const,
		});
		findManagedToolBinary.mockResolvedValue(undefined);
		launchLSP.mockRejectedValueOnce(toolNotFound);
		ensureTool.mockResolvedValueOnce("opengrep");
		const launch = suspendAt(launchLSP, async () => {
			throw toolNotFound;
		});
		try {
			const launching = resolveAndLaunch(
				{
					candidates: ["opengrep"],
					args: [],
					cwd: "/tmp/proj",
					managedToolId: "opengrep",
				},
				true,
			);
			await launch.admitted;
			resetLspLaunchAvailabilityGeneration();
			launch.release();
			expect(await launching).toBeUndefined();
			expect(ensureTool).toHaveBeenCalledTimes(1);
			const rows = await decisionsFor("opengrep");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toMatchObject({
				verdict: "unavailable",
				producer: "lsp-launch",
			});
		} finally {
			launch.restore();
		}
	});

	it("drops an ensureTool completion after the LSP generation resets", async () => {
		const toolNotFound = Object.assign(new Error("opengrep not found"), {
			kind: "tool-not-found" as const,
		});
		findManagedToolBinary.mockResolvedValue(undefined);
		launchLSP.mockRejectedValueOnce(toolNotFound);
		const ensure = suspendAt(ensureTool, async () => "/managed/opengrep");
		try {
			const launching = resolveAndLaunch(
				{
					candidates: ["opengrep"],
					args: [],
					cwd: "/tmp/proj",
					managedToolId: "opengrep",
				},
				true,
			);
			await ensure.admitted;
			resetLspLaunchAvailabilityGeneration();
			ensure.release();
			expect(await launching).toBeUndefined();
			const rows = await decisionsFor("opengrep");
			expect(rows).toHaveLength(1);
			expect(metadataOf(rows[0])).toMatchObject({
				verdict: "unavailable",
				producer: "lsp-launch",
			});
		} finally {
			ensure.restore();
		}
	});

	it("drops a launchLSP completion after the LSP generation resets", async () => {
		findManagedToolBinary.mockResolvedValue(undefined);
		const launch = suspendAt(launchLSP, async () => fakeProc, { calls: 1 });
		try {
			const launching = resolveAndLaunch(
				{
					candidates: ["opengrep"],
					args: [],
					cwd: "/tmp/proj",
					managedToolId: "opengrep",
				},
				false,
			);
			await waitFor(
				() => launchLSP.mock.calls.length,
				(calls) => calls === 1,
			);
			resetLspLaunchAvailabilityGeneration();
			launch.release();
			expect(await launching).toBeUndefined();
			expect(await decisionsFor("opengrep")).toHaveLength(0);
		} finally {
			launch.restore();
		}
	});
});
