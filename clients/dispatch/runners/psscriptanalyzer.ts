import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { incrementDegradationCount } from "../../degradation-ledger.js";
import { safeSpawnAsync, type SpawnResult } from "../../safe-spawn.js";
import { probeToolAsync } from "../../tool-probe.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";
import {
	type AvailabilityCause,
	type AvailabilityOutcome,
	classifyProbeFailure,
	createAvailabilityLatch,
	isLatchingOutcome,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./utils/availability-policy.js";

interface PSAnalyzerResult {
	RuleName?: string;
	Severity?: string;
	Line?: number;
	Column?: number;
	Message?: string;
}

// The PS script written to a temp file each run. `-File` with a temp script
// keeps the analysis argv free of embedded script text; safe-spawn itself never
// uses a shell (#817), so nothing here is quoting-sensitive.
const PS_SCRIPT = `
param([string]$FilePath)
Import-Module PSScriptAnalyzer -ErrorAction Stop
$results = @(Invoke-ScriptAnalyzer -Path $FilePath | Select-Object RuleName,@{N='Severity';E={$_.Severity.ToString()}},Line,Column,Message)
if ($results.Count -eq 0) { Write-Output '[]'; exit 0 }
$results | ConvertTo-Json -Depth 3 -Compress
`.trim();

const PS_TIMEOUT_MS = 30000;

/**
 * PowerShell spawns go through `safeSpawnAsync` (#1490).
 *
 * The hand-rolled version returned `status: null` for a timeout, a synchronous
 * `spawn UNKNOWN` and a missing binary alike, so the call site had nothing to
 * classify and remembered every one of them as "PowerShell analysis is not
 * available". `safeSpawnAsync` carries the standard taxonomy — `failure`,
 * `spawnFailure.kind` and the errno on `error` — which is what lets the
 * availability policy tell a stall from an absence.
 *
 * The two presence probes that used to share this wrapper now go through
 * `probeToolAsync` (#2894), so the only spawn left here is the ANALYSIS pass
 * — which always has a project to resolve `PSScriptAnalyzerSettings.psd1`
 * against. `cwd` is required to keep it that way.
 */
function spawnPs(
	cmd: string,
	args: string[],
	options: { timeoutMs?: number; cwd: string },
): Promise<SpawnResult> {
	const { timeoutMs = PS_TIMEOUT_MS, cwd } = options;
	return safeSpawnAsync(cmd, args, {
		cwd,
		timeout: timeoutMs,
		resourceLabel: "psscriptanalyzer",
	});
}

/**
 * The two verdicts this runner memoizes, both owned by the shared policy.
 *
 * The availability-policy coverage gate never flagged either of them, and the
 * reason is not a bug in the gate: it recognises a probe by a quoted VERSION
 * FLAG, and neither probe below asks for a version. One runs `exit 0` to see if
 * an interpreter answers; the other asks `Get-Module -ListAvailable`. A
 * capability probe with no version flag is invisible to that pre-filter, so this
 * file was skipped before any unit was analysed. The residual gate blindness is
 * tracked with #1489's gate work; the migration here does not depend on it.
 */
const psCmdLatch = createAvailabilityLatch();
const psAnalyzerLatchByCmd = new Map<
	string,
	ReturnType<typeof createAvailabilityLatch>
>();
/**
 * Whether `-File` actually executes, keyed by interpreter (#1540).
 *
 * Neither probe above asks `-File` a question -- both use `-Command`, which
 * PowerShell's execution policy does not gate. Under `Restricted`/`AllSigned`
 * that lets both probes report "available" while the real analysis spawn
 * (which DOES go through `-File`) gets a policy `SecurityError` on stderr and
 * exits nonzero with empty stdout. This latch is deliberately populated by
 * the real analysis run rather than a third `-Command`-shaped probe, so the
 * verdict it records is direct evidence about `-File`, not an inference from
 * a proxy that has already been shown to disagree with it.
 */
const psExecLatchByCmd = new Map<
	string,
	ReturnType<typeof createAvailabilityLatch>
>();
let psCmd: string | null = null;

/** Record one decision, and report whether the caller may retry later. */
function notePsDecision(
	latch: ReturnType<typeof createAvailabilityLatch>,
	tool: string,
	verdict:
		| { available: true; elapsedMs: number; hostStallMs: number }
		| {
				available: false;
				outcome: AvailabilityOutcome;
				cause: AvailabilityCause;
				elapsedMs: number;
				hostStallMs: number;
		  },
): void {
	let retryAfterMs: number | undefined;
	if (verdict.available) {
		latch.noteAvailable();
	} else {
		const delay = latch.noteUnavailable(verdict.outcome, verdict.cause);
		if (delay > 0) retryAfterMs = delay;
	}
	logAvailabilityDecision({
		tool,
		verdict: verdict.available ? "available" : "unavailable",
		outcome: verdict.available ? "success" : verdict.outcome,
		cause: verdict.available ? "ok" : verdict.cause,
		elapsedMs: verdict.elapsedMs,
		latched: verdict.available || isLatchingOutcome(verdict.outcome),
		classifiedBy: "probe",
		hostStallMs: verdict.hostStallMs,
		...(retryAfterMs !== undefined && { retryAfterMs }),
		budgetMs: PS_TIMEOUT_MS,
	});
}

/**
 * Drop both verdicts at the session boundary (#1490 review).
 *
 * Every other runner gets this for free through
 * `resetDispatchAvailabilityState`'s generation counter; these latches are local
 * to the module, so `session_start` clears them explicitly. Without it, a
 * PowerShell or module install performed mid-process is invisible until the host
 * restarts — the same "suppression outliving its session" defect #1222 fixed for
 * install attempts.
 */
export function resetPsScriptAnalyzerAvailability(): void {
	psCmdLatch.reset();
	psAnalyzerLatchByCmd.clear();
	psExecLatchByCmd.clear();
	psCmd = null;
}

/**
 * Resolve the PowerShell binary, once per session per verdict.
 *
 * A candidate that times out is NOT evidence that PowerShell is absent, so the
 * loop only concludes "missing" when every candidate answered with a durable
 * failure. One transient candidate makes the whole verdict transient, and the
 * next turn after the cooldown probes again.
 */
async function resolvePowerShellCmd(): Promise<string | null> {
	const memo = psCmdLatch.read();
	if (memo !== null) return memo ? psCmd : null;

	// Rank what the candidates said, rather than collapsing every failure to
	// "not-found" (#1490 review). A stall outranks everything: it means we never
	// got an answer. A present-but-rejecting interpreter (nonzero exit, EACCES)
	// is durable but is NOT a missing install, and reporting it as one both sends
	// the user to install PowerShell they already have and fabricates the cause in
	// `availability_decision`. Only an all-candidates ENOENT sweep is `missing`.
	let transient: {
		outcome: AvailabilityOutcome;
		cause: AvailabilityCause;
	} | null = null;
	let rejected: {
		outcome: AvailabilityOutcome;
		cause: AvailabilityCause;
	} | null = null;
	let elapsedTotalMs = 0;
	let stallTotalMs = 0;
	for (const candidate of ["pwsh", "powershell"]) {
		const sampler = startHostStallSampler();
		const startedAt = Date.now();
		const result = await probeToolAsync(
			candidate,
			["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
			{ timeout: PS_TIMEOUT_MS, resourceLabel: "psscriptanalyzer" },
		);
		const hostStallMs = sampler.stop();
		const elapsedMs = Date.now() - startedAt;
		elapsedTotalMs += elapsedMs;
		stallTotalMs += hostStallMs;
		if (!result.error && result.status === 0) {
			psCmd = candidate;
			notePsDecision(psCmdLatch, "powershell", {
				available: true,
				elapsedMs,
				hostStallMs,
			});
			return candidate;
		}
		const classified = classifyProbeFailure(result, { hostStallMs });
		if (classified.outcome === "transient") transient ??= classified;
		else if (classified.outcome !== "missing") rejected ??= classified;
	}

	psCmd = null;
	const verdict = transient ??
		rejected ?? {
			outcome: "missing" as AvailabilityOutcome,
			cause: "not-found" as AvailabilityCause,
		};
	notePsDecision(psCmdLatch, "powershell", {
		available: false,
		outcome: verdict.outcome,
		cause: verdict.cause,
		elapsedMs: elapsedTotalMs,
		hostStallMs: stallTotalMs,
	});
	return null;
}

async function checkModuleAvailable(cmd: string): Promise<boolean> {
	let latch = psAnalyzerLatchByCmd.get(cmd);
	if (!latch) {
		latch = createAvailabilityLatch();
		psAnalyzerLatchByCmd.set(cmd, latch);
	}
	const memo = latch.read();
	if (memo !== null) return memo;

	const sampler = startHostStallSampler();
	const startedAt = Date.now();
	const result = await probeToolAsync(
		cmd,
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"if (Get-Module -ListAvailable PSScriptAnalyzer) { exit 0 } else { exit 1 }",
		],
		{ timeout: PS_TIMEOUT_MS, resourceLabel: "psscriptanalyzer" },
	);
	const hostStallMs = sampler.stop();
	const elapsedMs = Date.now() - startedAt;
	if (!result.error && result.status === 0) {
		notePsDecision(latch, "psscriptanalyzer", {
			available: true,
			elapsedMs,
			hostStallMs,
		});
		return true;
	}
	// A CLEAN `exit 1` is the module genuinely not being installed — the one
	// outcome an install fixes, so that alone earns the `missing` override.
	//
	// Everything else did not answer the question (#1490 review). A `spawn
	// UNKNOWN`, an EMFILE, an EACCES, or a PowerShell that vanished between the
	// two probes all arrive with an error and no status, and calling those
	// "PSScriptAnalyzer is not installed" latched PowerShell analysis off for the
	// session on hosts where the module was present the whole time.
	const moduleAbsent = result.status === 1 && !result.failure && !result.error;
	const classified = classifyProbeFailure(result, {
		hostStallMs,
		...(moduleAbsent && { unclassifiedFailureOutcome: "missing" as const }),
	});
	let { outcome, cause } = classified;
	if (!moduleAbsent && outcome !== "transient") {
		// Nothing here is evidence about the module, so the verdict must expire.
		outcome = "transient";
		cause = "probe-rejected";
	}
	notePsDecision(latch, "psscriptanalyzer", {
		available: false,
		outcome,
		cause,
		elapsedMs,
		hostStallMs,
	});
	return false;
}

/**
 * `null` means "unreadable" (#1598): empty stdout, or stdout that fails to
 * parse as JSON. `PS_SCRIPT` always writes either the literal `[]` marker or
 * a `ConvertTo-Json` array/object on a genuine run, so anything else on an
 * exit-0 run is not a clean-file answer -- it is a lost or truncated write
 * between the child and us. The caller must not read `null` the same way it
 * reads a real `[]`.
 */
function parsePSAnalyzerOutput(
	raw: string,
	filePath: string,
): Diagnostic[] | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed === "[]") return [];
	let parsed: PSAnalyzerResult | PSAnalyzerResult[];
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const items = Array.isArray(parsed) ? parsed : [parsed];
	return items
		.filter((item) => item.Message && item.Line)
		.map((item) => {
			const sev = (item.Severity ?? "Warning").toLowerCase();
			const severity: "error" | "warning" | "info" =
				sev === "error" || sev === "parseerror"
					? "error"
					: sev === "information"
						? "info"
						: "warning";
			const rule = item.RuleName ?? "PSScriptAnalyzer";
			return {
				id: `psscriptanalyzer-${rule}-${item.Line}`,
				message: `[${rule}] ${item.Message}`,
				filePath,
				line: item.Line!,
				column: item.Column ?? 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "psscriptanalyzer",
				rule,
				fixable: false,
			};
		});
}

const psScriptAnalyzerRunner: RunnerDefinition = {
	id: "psscriptanalyzer",
	appliesTo: ["powershell"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cmd = await resolvePowerShellCmd();
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		if (!(await checkModuleAvailable(cmd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let execLatch = psExecLatchByCmd.get(cmd);
		if (!execLatch) {
			execLatch = createAvailabilityLatch();
			psExecLatchByCmd.set(cmd, execLatch);
		}
		// A durably blocked `-File` execution (an execution policy, typically) is
		// a fact about the interpreter, not about any one file -- re-spawning on
		// every save would just re-confirm the same policy every time (#1540).
		if (execLatch.read() === false) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cwd = resolveRunnerCwd(ctx, "psscriptanalyzer");
		const absPath = path.resolve(cwd, ctx.filePath);

		// Write script to temp file so we avoid cmd.exe quoting entirely
		const tmpScript = path.join(os.tmpdir(), `pi-lens-psa-${process.pid}.ps1`);
		await fs.writeFile(tmpScript, PS_SCRIPT, "utf-8");

		try {
			const sampler = startHostStallSampler();
			const startedAt = Date.now();
			const result = await spawnPs(
				cmd,
				[
					"-NoProfile",
					"-NonInteractive",
					"-File",
					tmpScript,
					"-FilePath",
					absPath,
				],
				{ timeoutMs: PS_TIMEOUT_MS, cwd },
			);
			const hostStallMs = sampler.stop();
			const elapsedMs = Date.now() - startedAt;

			// The two probes above use `-Command`, which PowerShell's execution
			// policy does not gate; this run uses `-File`, which it does. A
			// crashed/signal-killed process (#1540 second gap) or a blocked/
			// erroring run (#1540 primary gap) must both produce a recorded,
			// legible availability_decision -- never a silent "clean" read of
			// empty stdout, and never a silent skip.
			if (result.status === null) {
				const classified = classifyProbeFailure(result, { hostStallMs });
				let { outcome, cause } = classified;
				// A `spawn UNKNOWN`/EMFILE/crash never ran the script, so it is not
				// evidence that `-File` is broken (mirrors the nonzero-exit guard
				// below, and checkModuleAvailable's own guard against over-latching
				// an unclassified failure). Latching an unspawnable prober's
				// verdict would durably disable analysis for the whole session on
				// a host where `-File` works fine.
				if (outcome !== "transient") {
					outcome = "transient";
					cause = "probe-rejected";
				}
				notePsDecision(execLatch, "psscriptanalyzer-exec", {
					available: false,
					outcome,
					cause,
					elapsedMs,
					hostStallMs,
				});
				incrementDegradationCount({
					kind: "grammar-blocked",
					subject: "psscriptanalyzer",
					reason: `PowerShell (${cmd}) -File analysis exited with no status -- crash or signal-killed process`,
				});
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}

			if (result.status !== 0) {
				const stderrText = result.stderr ?? "";
				// Require the SecurityError/UnauthorizedAccess pairing that a real
				// script-load block produces, not a bare "unauthorizedaccess"
				// match (#1556 review F4) -- that word alone also appears in
				// unrelated file-permission and access-denied stderr that has
				// nothing to do with the execution policy, and misclassifying it
				// as `policy-denied` would latch analysis off durably for a
				// transient, per-file permission error.
				const policyDenied =
					/securityerror/i.test(stderrText) &&
					(/execution polic(y|ies)/i.test(stderrText) ||
						/running scripts is disabled/i.test(stderrText) ||
						/unauthorizedaccess/i.test(stderrText));
				const classified = classifyProbeFailure(result, { hostStallMs });
				let { outcome, cause } = classified;
				if (policyDenied) {
					// Direct, unambiguous evidence: PowerShell's own execution
					// policy refused to load the script. Durable until the policy
					// changes, so this is the one case allowed to latch.
					outcome = "non-installable";
					cause = "policy-denied";
				} else if (outcome !== "transient") {
					// A single nonzero exit is not durable evidence that `-File`
					// is broken for every file (mirrors checkModuleAvailable's own
					// guard against over-latching an unclassified failure).
					outcome = "transient";
					cause = "probe-rejected";
				}
				notePsDecision(execLatch, "psscriptanalyzer-exec", {
					available: false,
					outcome,
					cause,
					elapsedMs,
					hostStallMs,
				});
				incrementDegradationCount({
					kind: "grammar-blocked",
					subject: "psscriptanalyzer",
					reason: policyDenied
						? `PowerShell execution policy blocked -File analysis for ${cmd}: ${stderrText.trim().split("\n")[0] || "SecurityError"}`
						: `PowerShell -File analysis for ${cmd} exited ${result.status}: ${stderrText.trim().slice(0, 200) || "no stderr"}`,
				});
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}

			// `-File` ran and exited 0: direct proof it works. Log the decision
			// once (memoized by the latch) rather than on every save.
			if (execLatch.read() === null) {
				notePsDecision(execLatch, "psscriptanalyzer-exec", {
					available: true,
					elapsedMs,
					hostStallMs,
				});
			}

			const diagnostics = parsePSAnalyzerOutput(result.stdout, ctx.filePath);

			if (diagnostics === null) {
				// Exit 0 proves `-File` itself ran, so this does NOT reuse the
				// exec latch above -- one bad read says nothing durable about the
				// interpreter (mirrors the nonzero-exit branch's own guard against
				// over-latching an unclassified failure), and it is logged rather
				// than latched. It must still never be read as a clean file
				// (#1598): empty/malformed stdout on a successful exit is a lost
				// or truncated write, not evidence of zero diagnostics.
				const unreadableReason = result.stdout.trim() ? "unparseable" : "empty";
				logAvailabilityDecision({
					tool: "psscriptanalyzer-stdout",
					verdict: "unavailable",
					outcome: "transient",
					cause: "empty-result",
					elapsedMs,
					latched: false,
					hostStallMs,
					budgetMs: PS_TIMEOUT_MS,
					// A read of the process's own stdout, not classifyProbeFailure, is
					// what decided this (#2209).
					classifiedBy: "caller",
				});
				incrementDegradationCount({
					kind: "grammar-blocked",
					subject: "psscriptanalyzer",
					reason: `PowerShell -File analysis for ${cmd} exited 0 but stdout was ${unreadableReason}`,
				});
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}

			if (diagnostics.length === 0) {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			}

			const hasErrors = diagnostics.some((d) => d.severity === "error");
			return {
				status: hasErrors ? "failed" : "succeeded",
				diagnostics,
				semantic: hasErrors ? "blocking" : "warning",
			};
		} finally {
			await fs.unlink(tmpScript).catch(() => {});
		}
	},
};

export default psScriptAnalyzerRunner;
