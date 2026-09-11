/**
 * #1490 — psscriptanalyzer was the last unmigrated instance of the #1467 latch.
 *
 * Its hand-rolled `spawnPs` returned `status: null` for a timeout, a synchronous
 * `spawn UNKNOWN` and a missing binary alike, so the call site had no taxonomy
 * to classify and remembered every failure as "PowerShell analysis is not
 * available" for the session. Two changes, asserted here: the spawn goes
 * through `safeSpawnAsync`, and the verdict goes through the availability
 * policy.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../../../clients/dispatch/runners/utils/availability-policy.js";

const {
	safeSpawnAsync,
	logLatencySpy,
	recordDegradationSpy,
	incrementDegradationCountSpy,
} = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	logLatencySpy: vi.fn(),
	recordDegradationSpy: vi.fn(),
	incrementDegradationCountSpy: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
}));
vi.mock("../../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));
vi.mock(
	"../../../../clients/degradation-ledger.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/degradation-ledger.js")
		>()),
		recordDegradation: recordDegradationSpy,
		recordDegradationOnce: vi.fn(),
		incrementDegradationCount: incrementDegradationCountSpy,
	}),
);

/**
 * Fresh module state per test. The memoized verdicts live at module scope, and
 * reloading the module is the one reset that works against BOTH the pre-fix
 * code (which exposes no reset seam) and the migrated code — so the red-first
 * run fails on the latch, not on missing test scaffolding.
 */
async function loadRunner(): Promise<{
	run: (ctx: never) => Promise<{ status: string; diagnostics: unknown[] }>;
}> {
	vi.resetModules();
	const mod =
		await import("../../../../clients/dispatch/runners/psscriptanalyzer.js");
	return mod.default;
}

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 30000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

const notFoundResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn pwsh ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const ok = (stdout = "") => ({ stdout, stderr: "", status: 0 });
/** `Get-Module -ListAvailable` ran and found nothing: the module is absent. */
const moduleMissing = { stdout: "", stderr: "", status: 1 };

/** The child never started. Windows' `spawn UNKNOWN`, the #533 class. */
const spawnUnknownResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn UNKNOWN"), { code: "UNKNOWN" }),
	failure: "spawn",
	spawnFailure: { kind: "spawn-failed" },
};

/** PowerShell is present and refuses the probe: durable, but not missing. */
const rejectedResult = { stdout: "", stderr: "not authorized", status: 5 };

type Call = [string, string[], Record<string, unknown> | undefined];

const callsMatching = (needle: string): Call[] =>
	(safeSpawnAsync.mock.calls as Call[]).filter((call) =>
		call[1].some((arg) => arg.includes(needle)),
	);

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

function ctx(): never {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-psa-"));
	const filePath = path.join(cwd, "script.ps1");
	fs.writeFileSync(filePath, "Write-Output 'hi'\n");
	return { cwd, filePath } as never;
}

/** pwsh answers, the module is present, the analysis finds nothing. */
function healthyHost(): void {
	safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
		args.includes("-File") ? ok("[]") : ok(),
	);
}

/**
 * A real `-File` run under `Restricted`/`AllSigned`: exit 1, empty stdout, a
 * `SecurityError`/`UnauthorizedAccess` on stderr. Reproduced live on Windows
 * (`powershell -ExecutionPolicy Restricted -File ...`) -- see the #1540 PR
 * body for the transcript.
 */
const executionPolicyBlockedResult = {
	stdout: "",
	stderr:
		"File repro.ps1 cannot be loaded because running scripts is disabled on this system. " +
		"For more information, see about_Execution_Policies.\n" +
		"    + CategoryInfo          : SecurityError: (:) [], ParentContainsErrorRecordException\n" +
		"    + FullyQualifiedErrorId : UnauthorizedAccess",
	status: 1,
};

/** The `-File` child crashed or was signal-killed: no exit status at all. */
const fileRunStatusNullResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 30000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/** Both `-Command` probes answer; only the `-File` analysis run differs. */
function hostWithFileResult(fileResult: {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error;
	failure?: string;
	spawnFailure?: { kind?: string };
}): void {
	safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
		args.includes("-File") ? fileResult : ok(),
	);
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	logLatencySpy.mockReset();
	recordDegradationSpy.mockReset();
	incrementDegradationCountSpy.mockReset();
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => vi.useRealTimers();
});

describe("psscriptanalyzer availability (#1490)", () => {
	it("probes through safeSpawnAsync with a budget and a resource label", async () => {
		const runner = await loadRunner();
		healthyHost();
		expect((await runner.run(ctx())).status).toBe("succeeded");

		const probe = callsMatching("exit 0")[0];
		expect(probe?.[0]).toBe("pwsh");
		expect(probe?.[2]).toMatchObject({
			timeout: 30000,
			resourceLabel: "psscriptanalyzer",
		});
	});

	it("re-probes the interpreter after a timeout once the cooldown expires", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async () => timeoutResult);
		expect((await runner.run(ctx())).status).toBe("skipped");
		// Both candidates were tried; neither answered.
		expect(callsMatching("exit 0")).toHaveLength(2);
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "powershell",
			outcome: "transient",
			cause: "probe-timeout",
			latched: false,
		});

		// Inside the cooldown the verdict is reused rather than re-probed.
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("exit 0")).toHaveLength(2);

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		healthyHost();
		expect((await runner.run(ctx())).status).toBe("succeeded");
	});

	it("latches a genuinely absent interpreter", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async () => notFoundResult);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "powershell",
			outcome: "missing",
			cause: "not-found",
			latched: true,
		});

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 4));
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("exit 0")).toHaveLength(2);
	});

	it("keeps the verdict transient when one candidate stalls and the other is absent", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async (cmd: string) =>
			cmd === "pwsh" ? timeoutResult : notFoundResult,
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(decisions()[0]?.metadata).toMatchObject({
			outcome: "transient",
			latched: false,
		});
	});

	it("re-probes the module after a timeout once the cooldown expires", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.some((arg) => arg.includes("Get-Module")) ? timeoutResult : ok(),
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("Get-Module")).toHaveLength(1);
		expect(
			decisions().find((entry) => entry.metadata?.tool === "psscriptanalyzer")
				?.metadata,
		).toMatchObject({ outcome: "transient", latched: false });

		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("Get-Module")).toHaveLength(1);

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		healthyHost();
		expect((await runner.run(ctx())).status).toBe("succeeded");
	});

	it("does not read a failed module spawn as a missing module", async () => {
		const runner = await loadRunner();
		// `spawn UNKNOWN` is the #533 Windows class: the child never started, so
		// nothing was learned about the module. Latching it as "not installed"
		// disabled PowerShell analysis for the session on hosts that had it.
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.some((arg) => arg.includes("Get-Module"))
				? spawnUnknownResult
				: ok(),
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(
			decisions().find((entry) => entry.metadata?.tool === "psscriptanalyzer")
				?.metadata,
		).toMatchObject({ outcome: "transient", latched: false });

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		healthyHost();
		expect((await runner.run(ctx())).status).toBe("succeeded");
	});

	it("reports a present-but-rejecting interpreter as rejected, not missing", async () => {
		const runner = await loadRunner();
		// pwsh is absent, powershell answers and refuses. Collapsing both to
		// not-found tells the user to install PowerShell they already have, and
		// fabricates the cause in the telemetry.
		safeSpawnAsync.mockImplementation(async (cmd: string) =>
			cmd === "pwsh" ? notFoundResult : rejectedResult,
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "powershell",
			outcome: "non-installable",
			cause: "probe-rejected",
			latched: true,
		});
	});

	it("latches a genuinely missing module", async () => {
		const runner = await loadRunner();
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.some((arg) => arg.includes("Get-Module")) ? moduleMissing : ok(),
		);
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(
			decisions().find((entry) => entry.metadata?.tool === "psscriptanalyzer")
				?.metadata,
		).toMatchObject({ outcome: "missing", cause: "not-found", latched: true });

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 4));
		expect((await runner.run(ctx())).status).toBe("skipped");
		expect(callsMatching("Get-Module")).toHaveLength(1);
	});
});

describe("psscriptanalyzer execution-policy-blocked -File run (#1540)", () => {
	it("never reads an execution-policy-blocked -File run as clean", async () => {
		const runner = await loadRunner();
		hostWithFileResult(executionPolicyBlockedResult);

		const result = await runner.run(ctx());
		// The pre-fix bug: empty stdout from a failed run parses to zero
		// diagnostics, and the runner reports "succeeded" -- a blocked analyzer
		// masquerading as a clean file.
		expect(result.status).not.toBe("succeeded");

		const execDecision = decisions().find(
			(entry) => entry.metadata?.tool === "psscriptanalyzer-exec",
		);
		expect(execDecision?.metadata).toMatchObject({
			outcome: "non-installable",
			cause: "policy-denied",
			latched: true,
		});
		expect(incrementDegradationCountSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "grammar-blocked",
				subject: "psscriptanalyzer",
				reason: expect.stringMatching(/execution polic/i),
			}),
		);
	});

	it("latches the policy block so a later save does not re-spawn -File", async () => {
		const runner = await loadRunner();
		hostWithFileResult(executionPolicyBlockedResult);
		await runner.run(ctx());
		expect(callsMatching("-File")).toHaveLength(1);

		expect((await runner.run(ctx())).status).not.toBe("succeeded");
		// Still latched -- no second -File spawn for the same session.
		expect(callsMatching("-File")).toHaveLength(1);
	});

	it("does not silently skip when the -File run's status is null", async () => {
		const runner = await loadRunner();
		hostWithFileResult(fileRunStatusNullResult);

		const result = await runner.run(ctx());
		expect(result.status).not.toBe("succeeded");

		// The pre-fix bug: `status === null` returned `skipped` with no
		// availability_decision at all -- indistinguishable from a project with
		// no PowerShell files.
		const execDecision = decisions().find(
			(entry) => entry.metadata?.tool === "psscriptanalyzer-exec",
		);
		expect(execDecision).toBeDefined();
		expect(execDecision?.metadata).toMatchObject({ outcome: "transient" });
		expect(incrementDegradationCountSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "grammar-blocked",
				subject: "psscriptanalyzer",
			}),
		);
	});

	it("does not latch a spawn-UNKNOWN -File run off for the session (#1556 review F1)", async () => {
		const runner = await loadRunner();
		// The child never started -- the #533 Windows `spawn UNKNOWN` class,
		// reused from the module-availability suite above. Nothing was learned
		// about the execution policy, so this must decay the same way the
		// nonzero-exit branch already does, not latch `-File` off durably.
		hostWithFileResult(spawnUnknownResult);

		const result = await runner.run(ctx());
		expect(result.status).not.toBe("succeeded");

		const execDecision = decisions().find(
			(entry) => entry.metadata?.tool === "psscriptanalyzer-exec",
		);
		expect(execDecision?.metadata).toMatchObject({
			outcome: "transient",
			cause: "probe-rejected",
			latched: false,
		});

		// Pre-fix bug: a spawn-UNKNOWN on this run passed classified.outcome
		// through raw, which classifyProbeFailure calls "non-installable" and
		// the latch treats as durable -- permanently disabling PSScriptAnalyzer
		// for the session. A transient verdict still has a cooldown of its own
		// (unlike a latching one, it is never permanent) so advance past it and
		// confirm a later save re-spawns -File instead of reusing a stale
		// "unavailable" verdict forever.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		hostWithFileResult(spawnUnknownResult);
		await runner.run(ctx());
		expect(callsMatching("-File")).toHaveLength(2);
	});

	it("still reports a genuinely clean -File run as succeeded", async () => {
		const runner = await loadRunner();
		healthyHost();
		const result = await runner.run(ctx());
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toHaveLength(0);
	});

	// #2691: the `-File` analysis spawn passed no `cwd`, so it ran under the
	// extension host's `process.cwd()` instead of `ctx.cwd` -- same shape as
	// #1731 (sqlfluff). `Invoke-ScriptAnalyzer -Path $FilePath` with no
	// `-Settings` only auto-discovers `PSScriptAnalyzerSettings.psd1` in the
	// directory of the `-Path` argument itself (PSScriptAnalyzer's
	// `FindSettingsMode` derives `directory` from `Path.GetDirectoryName`
	// of the `-Path` value, with no upward walk and no cwd fallback), and
	// `$FilePath` here is already the absolute `path.resolve(cwd,
	// ctx.filePath)`, so this is a consistency fix (matching the two
	// `-Command` probes' cwd) rather than a config-resolution behavior
	// change.
	it("spawns the -File analysis run with ctx.cwd, not the host's (#2691)", async () => {
		const runner = await loadRunner();
		const testCtx = ctx();
		healthyHost();
		await runner.run(testCtx);
		const fileCalls = callsMatching("-File");
		expect(fileCalls).toHaveLength(1);
		const [, , options] = fileCalls[0];
		expect(options?.cwd).toBe((testCtx as unknown as { cwd: string }).cwd);
	});

	/**
	 * #1604 N1 -- the #1556 F4 review tightened `policyDenied` from a bare
	 * `securityerror|execution polic(y|ies)|running scripts is disabled|
	 * unauthorizedaccess` alternation to requiring `securityerror` paired with
	 * one of the other three, but shipped with no test proving the false
	 * positive it was meant to close. Both tests below reproduce a stderr
	 * shape that matches exactly one side of the old OR and confirm it no
	 * longer latches `-File` off as a policy block. Reverting the regex to
	 * the pre-#1556 OR alternation turns both red.
	 */
	it("does not classify a bare UnauthorizedAccess file-permission error as policy-denied (#1604 N1)", async () => {
		const runner = await loadRunner();
		// A real .NET UnauthorizedAccessException from a locked/permission-denied
		// file read -- PowerShell files this under CategoryInfo "PermissionDenied",
		// never "SecurityError". No execution-policy phrase appears either.
		hostWithFileResult({
			stdout: "",
			stderr:
				"Access to the path 'C:\\locked-repro.ps1' is denied.\n" +
				"    + CategoryInfo          : PermissionDenied: (:) [], UnauthorizedAccessException\n" +
				"    + FullyQualifiedErrorId : UnauthorizedAccess",
			status: 1,
		});

		const result = await runner.run(ctx());
		expect(result.status).not.toBe("succeeded");

		const execDecision = decisions().find(
			(entry) => entry.metadata?.tool === "psscriptanalyzer-exec",
		);
		expect(execDecision?.metadata).toMatchObject({
			outcome: "transient",
			cause: "probe-rejected",
			latched: false,
		});
	});

	it("does not classify a bare execution-policy mention without SecurityError as policy-denied (#1604 N1)", async () => {
		const runner = await loadRunner();
		// Some unrelated failure whose stderr happens to name "execution policy"
		// (e.g. a module-load warning) but carries no SecurityError -- not
		// evidence that PowerShell's execution policy blocked this run.
		hostWithFileResult({
			stdout: "",
			stderr:
				"WARNING: The current execution policy only affects the current user " +
				"scope and does not apply here.\n" +
				"Analysis failed for an unrelated reason.",
			status: 1,
		});

		const result = await runner.run(ctx());
		expect(result.status).not.toBe("succeeded");

		const execDecision = decisions().find(
			(entry) => entry.metadata?.tool === "psscriptanalyzer-exec",
		);
		expect(execDecision?.metadata).toMatchObject({
			outcome: "transient",
			cause: "probe-rejected",
			latched: false,
		});
	});
});

describe("psscriptanalyzer exit-0 with unreadable stdout (#1598)", () => {
	it("does not read an exit-0 run with empty stdout as a clean file", async () => {
		const runner = await loadRunner();
		// PS_SCRIPT always writes either the literal `[]` marker or a JSON
		// diagnostics array before it exits 0 -- empty stdout on an exit-0 run
		// is a lost or truncated write, not a genuine "nothing to report".
		hostWithFileResult(ok(""));

		const result = await runner.run(ctx());
		// The pre-fix bug: empty stdout parses to `[]`, and the runner reports
		// "succeeded" with zero diagnostics -- identical to a real clean file.
		expect(result.status).not.toBe("succeeded");
		expect(incrementDegradationCountSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "grammar-blocked",
				subject: "psscriptanalyzer",
				reason: expect.stringMatching(/empty/i),
			}),
		);
		const stdoutDecision = decisions().find(
			(entry) => entry.metadata?.tool === "psscriptanalyzer-stdout",
		);
		expect(stdoutDecision?.metadata).toMatchObject({
			outcome: "transient",
			latched: false,
		});
	});

	it("does not read an exit-0 run with malformed JSON stdout as a clean file", async () => {
		const runner = await loadRunner();
		// Truncated JSON: a real repro shape for a pipe cut mid-write.
		hostWithFileResult(ok('[{"RuleName":"PSAvoidUsingCmdletAliases","Line":'));

		const result = await runner.run(ctx());
		expect(result.status).not.toBe("succeeded");
		expect(incrementDegradationCountSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "grammar-blocked",
				subject: "psscriptanalyzer",
				reason: expect.stringMatching(/unparseable/i),
			}),
		);
	});

	it("does not latch -File off for the session on an unreadable-stdout run", async () => {
		const runner = await loadRunner();
		hostWithFileResult(ok(""));
		await runner.run(ctx());

		// A single bad read is not durable evidence -File itself is broken --
		// the very next save with a healthy host must still analyze normally.
		healthyHost();
		const result = await runner.run(ctx());
		expect(result.status).toBe("succeeded");
		expect(callsMatching("-File")).toHaveLength(2);
	});

	it("still reports a genuine literal `[]` clean run as succeeded", async () => {
		const runner = await loadRunner();
		healthyHost();
		const result = await runner.run(ctx());
		expect(result.status).toBe("succeeded");
		expect(result.diagnostics).toHaveLength(0);
	});
});
