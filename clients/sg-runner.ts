/**
 * SgRunner - encapsulates ast-grep subprocess management
 *
 * Extracted from AstGrepClient to simplify the main client.
 * Handles: spawn, spawnSync, temp dir management, JSON parsing.
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getSgCommand,
	resolveManagedToolClient,
} from "./dispatch/runners/utils/runner-helpers.js";
import { getProjectIgnoreGlobs } from "./file-utils.js";
import { findGlobalBinary } from "./package-manager.js";
import { safeSpawnAsync, type SpawnResult } from "./safe-spawn.js";
import { probeToolAsync } from "./tool-probe.js";
import { truncatedByOutputCap } from "./spawn-output-cap.js";
import { createSingleFlight } from "./single-flight.js";
import {
	type AvailabilityCause,
	type ProbeEvidence,
	classifyProbeFailure,
	describeInstallAttempt,
	createAvailabilityLatch,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";

/**
 * Build the `bash -c` argv that runs `cmd` with `allArgs` as POSITIONAL
 * parameters. The script is the constant `"$0" "$@"`, so bash re-emits the
 * command and every arg verbatim — no parameter expansion, no word-splitting.
 *
 * Two properties this guarantees, neither of which string-interpolation could:
 *  - ast-grep `$METAVAR` patterns reach the binary literally (not shell-expanded).
 *  - an environment-derived command path (PATH-resolved `ast-grep`/`sg`/`npx`)
 *    cannot inject shell — it's argv[0], never part of the script string
 *    (CodeQL js/shell-command-injection-from-environment).
 */
export function buildBashRunArgs(cmd: string, allArgs: string[]): string[] {
	return ["-c", '"$0" "$@"', cmd, ...allArgs];
}

function sgExcludeArgsForProject(rootDir: string): string[] {
	return getProjectIgnoreGlobs(rootDir).flatMap((glob) => [
		"--globs",
		`!${glob}`,
	]);
}

interface SgMetaVarNode {
	text: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
}

export interface SgMatch {
	file: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	text: string;
	lines?: string;
	language?: string;
	replacement?: string;
	// Present when the match came from a `scan` against a rule config (not a raw
	// `run -p` pattern): the matched rule's id and its `severity`. Real fields of
	// `sg scan --json` output.
	ruleId?: string;
	severity?: string;
	metaVariables?: {
		single: Record<string, SgMetaVarNode>;
		multi: Record<string, SgMetaVarNode[]>;
		transformed: Record<string, string>;
	};
}

export interface SgResult {
	matches: SgMatch[];
	totalMatches: number;
	truncated: boolean;
	error?: string;
}

export type SgFailureKind =
	| "cli-failure"
	| "unavailable"
	| "timeout"
	| "aborted"
	| "parse-failure";

export interface SgExecutionOptions {
	signal?: AbortSignal;
	/** Absolute wall-clock deadline shared by a multi-path search. */
	deadlineAt?: number;
}

export interface SgRawResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: string;
	failure?: SgFailureKind;
	outputTruncated?: boolean;
}

/** Detailed result for generated-rule scans. An empty match list is only a
 * no-match when `failure` is absent; callers that need backwards compatibility
 * can continue using `tempScanAsync`, which returns just `matches`. */
export interface SgScanResult {
	matches: SgMatch[];
	status: number | null;
	error?: string;
	failure?: SgFailureKind;
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** Budget for a single `--version` candidate probe, ms. */
const PROBE_TIMEOUT_MS = 5_000;
const MAX_SG_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Format metavariable captures for display below a match line.
 * Single captures: $VAR=x  $NAME=foo
 * Multi captures:  $$$ARGS=a,b,c
 * Returns undefined when there are no meaningful captures.
 */
function formatMetaVarCaptures(
	mv: SgMatch["metaVariables"],
): string | undefined {
	if (!mv) return undefined;
	const parts: string[] = [];

	for (const [name, node] of Object.entries(mv.single)) {
		if (node.text) parts.push(`$${name}=${node.text}`);
	}
	for (const [name, nodes] of Object.entries(mv.multi)) {
		if (nodes.length > 0) {
			const joined = nodes.map((n) => n.text).join("");
			if (joined) parts.push(`$$$${name}=${joined}`);
		}
	}
	for (const [name, value] of Object.entries(mv.transformed)) {
		if (value) parts.push(`@${name}=${value}`);
	}

	if (parts.length === 0) return undefined;
	return `  ${parts.join("  ")}`;
}

/**
 * Parse ast-grep `--json` stdout into a match array, or return `null` when the
 * text is not a match payload. ast-grep emits either a JSON array or (rarely) a
 * single object; both are normalized to an array. A JSON scalar/`null` is
 * rejected (returns `null`) so a hypothetical error-report scalar on stdout can
 * never be misread as a phantom match.
 */
function tryParseSgMatches(stdout: string): SgMatch[] | null {
	try {
		const parsed = JSON.parse(stdout);
		if (Array.isArray(parsed)) return parsed;
		if (parsed !== null && typeof parsed === "object") return [parsed];
		return null;
	} catch {
		return null;
	}
}

// The truncation veto lives at the head of `exec`/`interpretScanResult` now
// (#2100), so this stays a pure parser rather than re-asking a settled question.
function tryParseNonZeroSgMatches(
	result: Pick<SpawnResult, "stdout">,
): SgMatch[] | null {
	if (!result.stdout.trim()) return null;
	// Trimmed on purpose: a leading BOM survives JSON.parse's whitespace
	// tolerance but String.trim() strips it (matches the pre-refactor guard).
	return tryParseSgMatches(result.stdout.trim());
}

export class SgRunner {
	private log: (msg: string) => void;
	private sgPath: string | null = null;
	private sgArgsPrefix: string[] = [];
	/**
	 * Availability memo, backed by the shared transient-aware latch (#1476).
	 *
	 * Before this, one failed sweep over every candidate — timeouts included —
	 * latched `false` for the life of the process AND ran a full auto-install
	 * first. A host stall during warm-up therefore both disabled ast-grep until
	 * restart and paid for an install nobody needed.
	 */
	private readonly availabilityLatch = createAvailabilityLatch();
	/**
	 * At-most-one sweep in flight, via the shared primitive (#1753). One
	 * instance owns one question, so the key is a constant.
	 */
	private readonly ensureFlight = createSingleFlight<boolean>();
	/**
	 * Whether a DIRECT candidate — one that would have been ast-grep itself —
	 * failed for a transient reason in the current sweep. Only these block the
	 * install: a slow `npx` says nothing about whether ast-grep is on this
	 * machine, and letting it block turned "ast-grep is genuinely absent on a
	 * slow host" into "ast-grep is never installed and npx is re-spawned every
	 * sweep, forever".
	 */
	private sweepSawTransient = false;
	private sweepTransientCause: AvailabilityCause = "probe-timeout";
	/**
	 * The DIRECT candidates that were unreachable, in ask order (#1568).
	 *
	 * The sweep returns at the first candidate that answers, so at the moment of
	 * a win this is exactly the set of preferred tiers the winner did not beat on
	 * the merits. Fallbacks are excluded on purpose: `npx` is asked before the
	 * global-bin and platform-package tiers, and a slow `npx` says nothing about
	 * a winner that is a real binary.
	 *
	 * Basenames, because a candidate can be an absolute global-bin or
	 * platform-package path and this list is written to latency.log (#1568
	 * review F3).
	 */
	private sweepUnreachable: string[] = [];
	/** A transient on the npx fallback: not evidence, but not nothing either. */
	private sweepFallbackTransient = false;
	private sweepFallbackCause: AvailabilityCause = "probe-timeout";
	/** Host stall summed over every probe of the current sweep, ms. */
	private sweepHostStallMs = 0;
	/**
	 * Candidates — direct or fallback — that this sweep probed and found
	 * DURABLY missing (real ENOENT/non-installable, not a stall) (#1593). The
	 * retained-arm fallback below only sees whether SOME candidate stalled; this
	 * list lets it also check whether the memoized winner itself is one of the
	 * candidates this very sweep just disproved, rather than re-serving a
	 * command that ENOENTed a moment ago because an unrelated sibling stalled.
	 */
	private sweepDurablyMissing: string[] = [];

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("sg-runner") : () => {};
	}

	/**
	 * Check if ast-grep CLI is available, auto-install if not.
	 *
	 * Re-entrancy safe: concurrent first-time callers share one flight, so
	 * probing/auto-install isn't duplicated across session-start tasks. The
	 * share and the clear-in-finally belong to `singleFlight` (#1753); this
	 * method owns only the latch short-circuit above it. The sweep-local
	 * bookkeeping `doEnsureAvailable` resets on entry is untouched — it is
	 * per-sweep state, not concurrency state.
	 */
	async ensureAvailable(): Promise<boolean> {
		// Fast path: already decided. `read()` returns null when the last verdict
		// was transient and its cooldown expired, which re-enters the sweep.
		const memo = this.availabilityLatch.read();
		if (memo !== null) return memo;
		return this.ensureFlight.run("ast-grep", () => this.doEnsureAvailable());
	}

	private async doEnsureAvailable(): Promise<boolean> {
		const startedAt = Date.now();
		this.sweepSawTransient = false;
		this.sweepTransientCause = "probe-timeout";
		this.sweepUnreachable = [];
		this.sweepFallbackTransient = false;
		this.sweepFallbackCause = "probe-timeout";
		this.sweepHostStallMs = 0;
		this.sweepDurablyMissing = [];

		// Step 1: PATH — canonical binary names + npx fallback.
		// Prefer ast-grep over sg on Linux: /usr/bin/sg is util-linux, not ast-grep.
		const pathCommand = await this.probeCommandCandidates([
			{ cmd: "ast-grep", argsPrefix: [] },
			{ cmd: "sg", argsPrefix: [] },
			// `npx --no -- ast-grep` starts a Node process before it can answer, so
			// it is the candidate most likely to blow a 5 s budget on a cold or busy
			// box. Marked a fallback so its timeout cannot veto the install.
			{ cmd: "npx", argsPrefix: ["--no", "--", "ast-grep"], fallback: true },
		]);
		if (pathCommand) {
			this.sgPath = pathCommand.cmd;
			this.sgArgsPrefix = pathCommand.argsPrefix;
			this.noteAvailable(
				startedAt,
				`ast-grep found on PATH: ${pathCommand.cmd}`,
			);
			return true;
		}

		// Step 1b: any package manager's global bin dir (npm/pnpm/yarn/bun).
		// Catches a `pnpm add -g @ast-grep/cli` shim whose bin dir is off PATH (so
		// Step 1 misses) and which is a global — not a local node_modules platform
		// package — so Step 2 misses it too (#375).
		for (const name of ["ast-grep", "sg"]) {
			const globalBin = await findGlobalBinary(name);
			if (globalBin && (await this.probeCommand(globalBin, []))) {
				this.sgPath = globalBin;
				this.sgArgsPrefix = [];
				this.noteAvailable(
					startedAt,
					`ast-grep found in global bin: ${globalBin}`,
				);
				return true;
			}
		}

		// Step 2: platform-specific npm package binaries.
		// Covers setups where @ast-grep/cli-{os}-{arch} is installed but the binary
		// directory is not on PATH (common with pnpm, Yarn PnP, or isolated installs).
		const platformBinary = await this.probePlatformPackageBinary();
		if (platformBinary) {
			this.sgPath = platformBinary;
			this.sgArgsPrefix = [];
			this.noteAvailable(
				startedAt,
				`ast-grep found via platform package: ${platformBinary}`,
			);
			return true;
		}

		// Step 3: Homebrew (macOS only).
		if (process.platform === "darwin") {
			const brewBinary = await this.probeHomebrew();
			if (brewBinary) {
				this.sgPath = brewBinary;
				this.sgArgsPrefix = [];
				this.noteAvailable(
					startedAt,
					`ast-grep found via Homebrew: ${brewBinary}`,
				);
				return true;
			}
		}

		// A timeout on a DIRECT candidate means the machine answered, not the tool
		// (#1476). Installing ast-grep because the host event loop stalled is a
		// heavyweight reaction to a hiccup, and latching the result disabled the
		// tool until restart. Retry the sweep later instead.
		//
		// The npx fallback is deliberately NOT part of this test. Gating the
		// install on it regressed the very host this change targets: a slow box
		// with no ast-grep timed out `npx --no -- ast-grep` every sweep, so the
		// install below was never reached and the slow npx was re-spawned on each
		// escalating retry instead — worse than the latch it replaced.
		if (this.sweepSawTransient) {
			// Nothing answered, transiently, while we are still holding a command a
			// previous provisional sweep proved working. Discarding it here would
			// run #1476 backwards — a timeout erasing a positive result — and it
			// would send the sweep on to Step 4 to install a tool that is already
			// runnable. Keep the winner and re-arm the cooldown (#1568 review F1).
			// #1593: a sibling tier stalling this sweep is not license to re-serve
			// a winner that THIS SAME sweep just proved durably missing.
			if (
				this.availabilityLatch.isProvisional() &&
				this.sgPath &&
				!this.sweepDurablyMissing.includes(this.sgPath)
			) {
				this.noteAvailable(
					startedAt,
					`ast-grep re-probe stalled; keeping ${this.sgPath}`,
					{ retained: true },
				);
				return true;
			}
			this.log(
				"ast-grep availability probe timed out; will retry (not installing)",
			);
			return this.noteUnavailable(
				startedAt,
				"transient",
				this.sweepTransientCause,
			);
		}

		// Step 4: install via the typed shared seam, then validate the returned
		// absolute binary before publishing it.
		const installed = await resolveManagedToolClient({
			toolId: "ast-grep",
			cwd: process.cwd(),
			probe: async () => ({ outcome: "missing" as const }),
			acceptInstalled: async (installedPath) =>
				(await this.probeCommand(installedPath, [])) ? installedPath : null,
		});

		if (installed.outcome === "success") {
			this.sgPath = installed.value;
			this.sgArgsPrefix = [];
			this.noteAvailable(
				startedAt,
				`ast-grep auto-installed: ${installed.value}`,
			);
			return true;
		}

		// The install failed AND the npx fallback never got a fair hearing, so
		// "ast-grep is not installed" is not a fact yet. Expire the verdict.
		if (this.sweepFallbackTransient) {
			return this.noteUnavailable(
				startedAt,
				"transient",
				this.sweepFallbackCause,
			);
		}
		// #1500: ASSERTED, not derived — and justified, because every candidate
		// probe answered "not found", so the absence is real. What the install did
		// is recorded as evidence rather than folded into the verdict: it is the one
		// fact separating "never installable here" from "the download failed", and
		// from "no install was attempted at all" (auto-install off, trust denied,
		// or an attempt already suppressed this session).
		const { getInstallAttempt } = await import("./installer/index.js");
		return this.noteUnavailable(
			startedAt,
			"missing",
			"not-found",
			describeInstallAttempt(getInstallAttempt("ast-grep"), {
				installedButRejected: installed.outcome === "non-installable",
			}),
			"caller",
		);
	}

	/**
	 * Record a successful sweep, with one decision record.
	 *
	 * The win is latched for the session UNLESS a direct candidate ahead of it
	 * was unreachable (#1568). `sweepSawTransient` is set only by candidates the
	 * sweep already asked, and the sweep returns at the first one that answers,
	 * so at this point the flag means "a tier the winner is supposed to lose to
	 * never got a fair hearing". Latching that pinned the session to
	 * `npx --no -- ast-grep` — a Node start per invocation — over a healthy
	 * ast-grep on PATH, until the next restart. Provisional instead: served now,
	 * re-swept once the stalled tier's cooldown expires.
	 *
	 * The install arm cannot reach here provisionally: `doEnsureAvailable`
	 * returns before Step 4 whenever `sweepSawTransient` is set.
	 *
	 * `retained` marks the other provisional case (#1568 review F1): no candidate
	 * answered at all, and the winner being reported is the one the previous
	 * sweep found, kept rather than discarded on a timeout.
	 */
	private noteAvailable(
		startedAt: number,
		message: string,
		opts: { retained?: boolean } = {},
	): void {
		const provisional = this.sweepSawTransient;
		let retryAfterMs = 0;
		if (provisional) {
			retryAfterMs = this.availabilityLatch.noteProvisionallyAvailable(
				this.sweepTransientCause,
			);
		} else {
			this.availabilityLatch.noteAvailable();
		}
		this.log(message);
		logAvailabilityDecision({
			tool: "ast-grep",
			verdict: "available",
			outcome: "success",
			cause: provisional ? this.sweepTransientCause : "ok",
			elapsedMs: Date.now() - startedAt,
			latched: !provisional,
			classifiedBy: "probe",
			hostStallMs: this.sweepHostStallMs,
			budgetMs: PROBE_TIMEOUT_MS,
			...(provisional && {
				provisional: true,
				unreachablePreferred: [...this.sweepUnreachable],
				...(opts.retained === true && { retained: true }),
				...(retryAfterMs > 0 && { retryAfterMs }),
			}),
		});
	}

	/**
	 * Record a failed sweep. A `transient` outcome expires after a bounded
	 * cooldown; anything else is remembered for the session, as before. The
	 * elapsed/stall numbers describe the WHOLE sweep, because the verdict is
	 * about the sweep rather than any single candidate — reporting zero here
	 * would erase the evidence that cracked #1467.
	 */
	private noteUnavailable(
		startedAt: number,
		outcome: "missing" | "transient",
		cause: AvailabilityCause,
		evidence?: ProbeEvidence,
		/**
		 * How this arm reached its verdict. Per arm on purpose (#1500 review): the
		 * sweep's own transient/missing conclusions ARE derived from candidate
		 * probes, but the post-install assertion is not, and hardcoding `"probe"`
		 * here labelled an assertion as a derivation — the exact confusion the
		 * field was added to remove.
		 */
		classifiedBy: "probe" | "caller" = "probe",
	): false {
		const retryAfterMs = this.availabilityLatch.noteUnavailable(outcome, cause);
		logAvailabilityDecision({
			tool: "ast-grep",
			verdict: "unavailable",
			outcome,
			cause,
			elapsedMs: Date.now() - startedAt,
			latched: outcome !== "transient",
			hostStallMs: this.sweepHostStallMs,
			...(retryAfterMs > 0 && { retryAfterMs }),
			budgetMs: PROBE_TIMEOUT_MS,
			classifiedBy,
			...(evidence !== undefined && { evidence }),
		});
		return false;
	}

	/**
	 * Probe platform-specific @ast-grep/cli-{os}-{arch} npm packages.
	 * These ship the binary at the package root (sg / sg.exe).
	 */
	private async probePlatformPackageBinary(): Promise<string | undefined> {
		const { platform, arch } = process;
		const exeName = platform === "win32" ? "sg.exe" : "sg";

		// Map Node.js platform/arch to @ast-grep/cli package suffix.
		const pkgSuffixes: string[] = [];
		if (platform === "linux" && arch === "x64")
			pkgSuffixes.push("linux-x64-gnu");
		if (platform === "linux" && arch === "arm64")
			pkgSuffixes.push("linux-arm64-gnu");
		if (platform === "darwin" && arch === "arm64")
			pkgSuffixes.push("darwin-arm64");
		if (platform === "darwin" && arch === "x64") pkgSuffixes.push("darwin-x64");
		if (platform === "win32" && arch === "x64")
			pkgSuffixes.push("win32-x64-msvc");
		if (platform === "win32" && arch === "arm64")
			pkgSuffixes.push("win32-arm64-msvc");

		// Search roots: local node_modules and any parent node_modules directories.
		const searchRoots: string[] = [];
		let dir = process.cwd();
		for (let depth = 0; depth < 5; depth++) {
			searchRoots.push(path.join(dir, "node_modules"));
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		for (const suffix of pkgSuffixes) {
			const pkgName = `@ast-grep/cli-${suffix}`;
			for (const root of searchRoots) {
				const candidate = path.join(root, pkgName, exeName);
				try {
					if (
						fs.existsSync(candidate) &&
						(await this.probeCommand(candidate, []))
					) {
						return candidate;
					}
				} catch {
					// not found or not executable — try next
				}
			}
		}
		return undefined;
	}

	/**
	 * Probe Homebrew installation (macOS only).
	 * Runs `brew --prefix ast-grep` and checks the resulting bin directory.
	 */
	private async probeHomebrew(): Promise<string | undefined> {
		try {
			const result = await safeSpawnAsync("brew", ["--prefix", "ast-grep"], {
				timeout: 3000,
			});
			if (result.error || result.status !== 0) return undefined;
			const prefix = result.stdout.trim();
			if (!prefix) return undefined;
			for (const name of ["ast-grep", "sg"]) {
				const candidate = path.join(prefix, "bin", name);
				if (
					fs.existsSync(candidate) &&
					(await this.probeCommand(candidate, []))
				) {
					return candidate;
				}
			}
		} catch {
			// brew not installed or timed out
		}
		return undefined;
	}

	private isAstGrepVersionOutput(output: string): boolean {
		return /\bast[- ]grep\b/i.test(output);
	}

	/**
	 * Probe one candidate. A failure is CLASSIFIED, not merely counted: a
	 * timeout/abort marks the whole sweep transient so the caller retries later
	 * instead of installing and latching. A command that answers but is not
	 * ast-grep (Linux `/usr/bin/sg` is util-linux) is a durable no.
	 */
	private async probeCommand(
		cmd: string,
		argsPrefix: string[],
		fallback = false,
	): Promise<boolean> {
		// Host-side budget: measure the loop stall that overlapped the window so
		// the classifier can tell "the tool is slow" from "the host was busy".
		const sampler = startHostStallSampler();
		let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
		let hostStallMs: number;
		try {
			result = await probeToolAsync(cmd, [...argsPrefix, "--version"], {
				timeout: PROBE_TIMEOUT_MS,
			});
		} finally {
			hostStallMs = sampler.stop();
			this.sweepHostStallMs += hostStallMs;
		}
		if (
			!result.error &&
			result.status === 0 &&
			this.isAstGrepVersionOutput(`${result.stdout}\n${result.stderr}`)
		) {
			return true;
		}
		const { outcome, cause } = classifyProbeFailure(result, { hostStallMs });
		if (outcome === "transient") {
			if (fallback) {
				this.sweepFallbackTransient = true;
				this.sweepFallbackCause = cause;
			} else {
				this.sweepSawTransient = true;
				this.sweepTransientCause = cause;
				const name = path.basename(cmd);
				if (!this.sweepUnreachable.includes(name)) {
					this.sweepUnreachable.push(name);
				}
			}
		} else if (!this.sweepDurablyMissing.includes(cmd)) {
			this.sweepDurablyMissing.push(cmd);
		}
		return false;
	}

	private async probeCommandCandidates(
		candidates: Array<{
			cmd: string;
			argsPrefix: string[];
			fallback?: boolean;
		}>,
	): Promise<{ cmd: string; argsPrefix: string[] } | undefined> {
		for (const candidate of candidates) {
			if (
				await this.probeCommand(
					candidate.cmd,
					candidate.argsPrefix,
					candidate.fallback ?? false,
				)
			) {
				return candidate;
			}
		}
		return undefined;
	}

	/**
	 * Get the ast-grep command to use, plus any npx prefix arguments.
	 */
	private getSgCommand(): { cmd: string; argsPrefix: string[] } {
		return {
			cmd: this.sgPath || "ast-grep",
			argsPrefix: this.sgArgsPrefix,
		};
	}

	private failureForSpawnResult(result: {
		error?: Error;
		failure?: string;
		spawnFailure?: SpawnResult["spawnFailure"];
	}): SgFailureKind | undefined {
		if (result.failure === "aborted") return "aborted";
		switch (result.spawnFailure?.kind) {
			case "tool-not-found":
				return "unavailable";
			case "timeout":
				return "timeout";
			case "killed":
				return result.failure === "aborted" ? "aborted" : "cli-failure";
			case "cwd-unresolvable":
			case "permission-denied":
			case "spawn-failed":
			case undefined:
				return result.error ? "cli-failure" : undefined;
		}
	}

	private formatPatternError(stderr: string, args: string[]): string {
		if (stderr.includes("Multiple AST nodes are detected")) {
			return (
				`Invalid AST pattern: The pattern appears to contain multiple AST nodes or is malformed.\n` +
				`Common causes:\n` +
				`  1. Missing parentheses: use it($TEST) not it"test"\n` +
				`  2. Raw text without structure: use console.log($MSG) not just "console.log"\n` +
				`  3. Unclosed quotes or brackets\n\n` +
				`Original error: ${stderr}`
			);
		}
		if (stderr.includes("Cannot parse query")) {
			return (
				`Pattern syntax error: The pattern could not be parsed as valid code.\n` +
				`Tips:\n` +
				`  - Patterns must be valid ${args.includes("--lang") ? args[args.indexOf("--lang") + 1] : "language"} syntax\n` +
				`  - Use metavariables like $NAME, $ARGS for variable parts\n` +
				`  - Example: 'function $NAME($$$PARAMS) { $$$BODY }'\n\n` +
				`Original error: ${stderr}`
			);
		}
		return stderr;
	}

	async execRaw(
		args: string[],
		timeout = DEFAULT_EXEC_TIMEOUT_MS,
		options: SgExecutionOptions = {},
	): Promise<SgRawResult> {
		const command = this.getSgCommand();
		const result = await safeSpawnAsync(
			command.cmd,
			[...command.argsPrefix, ...args],
			{
				timeout,
				deadlineAt: options.deadlineAt,
				signal: options.signal,
				maxOutputBytes: MAX_SG_OUTPUT_BYTES,
			},
		);
		const failure = this.failureForSpawnResult(result);
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			status: result.status,
			error: result.error?.message,
			failure,
			...(result.outputTruncated ? { outputTruncated: true } : {}),
		};
	}

	/**
	 * Run ast-grep asynchronously, return parsed matches. The Windows Git
	 * Bash/MSYS path deliberately remains positional-argument based, but the
	 * child itself now goes through safeSpawnAsync so cancellation, deadlines,
	 * tree-kill, and output caps are shared with every other CLI runner.
	 */
	async exec(
		args: string[],
		options: SgExecutionOptions = {},
	): Promise<SgResult> {
		const command = this.getSgCommand();
		const allArgs = [...command.argsPrefix, ...args];
		const isWindows = process.platform === "win32";
		const hasBash = Boolean(process.env.MSYSTEM || process.env.GIT_SHELL);
		const useBash = isWindows && hasBash;
		const result = await safeSpawnAsync(
			useBash ? "bash" : command.cmd,
			useBash ? buildBashRunArgs(command.cmd, allArgs) : allArgs,
			{
				timeout: DEFAULT_EXEC_TIMEOUT_MS,
				deadlineAt: options.deadlineAt,
				signal: options.signal,
				maxOutputBytes: MAX_SG_OUTPUT_BYTES,
			},
		);
		const empty = (): SgResult => ({
			matches: [],
			totalMatches: 0,
			truncated: false,
		});
		// FIRST (#2100): hitting the cap makes safe-spawn SIGTERM ast-grep, so a
		// truncated run also classifies as a killed spawn. Read after the two
		// gates below, this guard could only ever describe a run that exited
		// before the signal reached it. A timed-out or aborted run carries the
		// flag too and keeps its own classification below.
		if (truncatedByOutputCap(result)) {
			return {
				...empty(),
				error: "Failed to parse output: output was truncated",
			};
		}
		const spawnFailure = this.failureForSpawnResult(result);
		if (spawnFailure) {
			return {
				...empty(),
				error:
					spawnFailure === "unavailable"
						? "ast-grep CLI not found. Install: npm i -D @ast-grep/cli"
						: result.error?.message || "ast-grep CLI failed to start",
			};
		}
		if (result.status !== 0) {
			const stdout = result.stdout.trim();
			const stderr = result.stderr.trim();
			// ast-grep's linter-style contract: a rule with `severity: error`
			// that MATCHES exits 1 with valid JSON matches on stdout (stderr
			// carries "Scan succeeded and found error level diagnostics"). An
			// exit code that means "scan succeeded with findings" must never be
			// classified as a CLI failure — parse the matches. Only fall through
			// to failure when the JSON isn't parseable (a real diagnostic).
			if (result.status === 1 && stdout) {
				const matches = tryParseNonZeroSgMatches(result);
				if (matches) {
					return {
						matches,
						totalMatches: matches.length,
						truncated: false,
					};
				}
			}
			// ast-grep uses status 1 with no output for a genuine no-match in
			// some CLI versions. Preserve that historical empty-result behavior;
			// any stderr (including an invalid kind/YAML diagnostic) is a failure.
			if (result.status === 1 && !stdout && !stderr) return empty();
			return {
				...empty(),
				error: this.formatPatternError(
					stderr || `Command failed with exit code ${result.status}`,
					args,
				),
			};
		}
		if (!result.stdout.trim()) return empty();
		{
			const matches = tryParseSgMatches(result.stdout);
			if (matches) {
				return {
					matches,
					totalMatches: matches.length,
					truncated: false,
				};
			}
			return { ...empty(), error: "Failed to parse output" };
		}
	}

	// --- Shared helpers for temp-dir rule scans ---

	private prepareTempScan(
		ruleId: string,
		ruleYaml: string,
	): {
		sessionDir: string;
		configFile: string;
	} {
		const sessionDir = fs.mkdtempSync(
			path.join(os.tmpdir(), `pi-lens-temp-${ruleId}-`),
		);
		const rulesSubdir = path.join(sessionDir, "rules");
		const configFile = path.join(sessionDir, ".sgconfig.yml");
		fs.mkdirSync(rulesSubdir, { recursive: true });
		fs.writeFileSync(configFile, `ruleDirs:\n  - ./rules\n`);
		fs.writeFileSync(path.join(rulesSubdir, `${ruleId}.yml`), ruleYaml);
		return { sessionDir, configFile };
	}

	private cleanupTempScan(sessionDir: string): void {
		try {
			fs.rmSync(sessionDir, { recursive: true, force: true });
		} catch (err) {
			this.log(`Cleanup failed: ${(err as Error).message}`);
		}
	}

	private interpretScanResult(
		result: SpawnResult,
		args: string[],
	): SgScanResult {
		// FIRST (#2100): same reason as `exec` above — the cap kill is our own
		// SIGTERM, so `failureForSpawnResult` answers "cli-failure" for it and
		// the truncation guard below never speaks.
		if (truncatedByOutputCap(result)) {
			return {
				matches: [],
				status: result.status,
				error: "Failed to parse ast-grep scan output: output was truncated",
				failure: "parse-failure",
			};
		}
		const failure = this.failureForSpawnResult(result);
		if (failure) {
			return {
				matches: [],
				status: result.status,
				error: result.error?.message || "ast-grep CLI failed to start",
				failure,
			};
		}
		if (result.status !== 0) {
			const stdout = result.stdout.trim();
			const stderr = result.stderr.trim();
			// ast-grep's linter-style contract: a rule with `severity: error`
			// that MATCHES exits 1 with valid JSON matches on stdout (stderr
			// carries "Scan succeeded and found error level diagnostics"). An
			// exit code that means "scan succeeded with findings" must never be
			// classified as a CLI failure — parse the matches. Only fall through
			// to failure when the JSON isn't parseable (a real diagnostic).
			if (result.status === 1 && stdout) {
				const matches = tryParseNonZeroSgMatches(result);
				if (matches) {
					return { matches, status: result.status };
				}
			}
			// Preserve ast-grep's status-1/no-output no-match convention. A
			// diagnostic on stderr is never treated as a no-match.
			if (result.status === 1 && !stdout && !stderr) {
				return { matches: [], status: result.status };
			}
			return {
				matches: [],
				status: result.status,
				error: this.formatPatternError(
					stderr || `ast-grep scan failed with exit code ${result.status}`,
					args,
				),
				failure: "cli-failure",
			};
		}
		if (!result.stdout.trim()) return { matches: [], status: result.status };
		{
			const matches = tryParseSgMatches(result.stdout);
			if (matches) {
				return { matches, status: result.status };
			}
			return {
				matches: [],
				status: result.status,
				error: "Failed to parse ast-grep scan output: invalid JSON",
				failure: "parse-failure",
			};
		}
	}

	async tempScanDetailedAsync(
		dir: string,
		ruleId: string,
		ruleYaml: string,
		timeout = DEFAULT_EXEC_TIMEOUT_MS,
		options: SgExecutionOptions = {},
	): Promise<SgScanResult> {
		let sessionDir: string | undefined;
		try {
			({ sessionDir } = this.prepareTempScan(ruleId, ruleYaml));
			const configFile = path.join(sessionDir, ".sgconfig.yml");
			const { cmd: sgCmd, args: sgPre } = getSgCommand();
			const result = await safeSpawnAsync(
				sgCmd,
				[
					...sgPre,
					"scan",
					"--config",
					configFile,
					"--json",
					...sgExcludeArgsForProject(dir),
					dir,
				],
				{
					timeout,
					deadlineAt: options.deadlineAt,
					signal: options.signal,
					maxOutputBytes: MAX_SG_OUTPUT_BYTES,
				},
			);
			return this.interpretScanResult(result, ["scan"]);
		} finally {
			if (sessionDir) this.cleanupTempScan(sessionDir);
		}
	}

	/** Backwards-compatible match-only wrapper for existing session scanners. */
	async tempScanAsync(
		dir: string,
		ruleId: string,
		ruleYaml: string,
		timeout = DEFAULT_EXEC_TIMEOUT_MS,
		options: SgExecutionOptions = {},
	): Promise<SgMatch[]> {
		const result = await this.tempScanDetailedAsync(
			dir,
			ruleId,
			ruleYaml,
			timeout,
			options,
		);
		return result.matches;
	}

	/**
	 * Run a rule scan with optional fix application.
	 * Dry-run: --json (returns matches for preview).
	 * Apply:   --update-all (writes fixes defined in the YAML `fix:` field).
	 */
	async tempScanWithFixAsync(
		dir: string,
		ruleId: string,
		ruleYaml: string,
		applyFixes: boolean,
		timeout = DEFAULT_EXEC_TIMEOUT_MS,
		options: SgExecutionOptions = {},
	): Promise<{ matches: SgMatch[]; error?: string }> {
		let sessionDir: string | undefined;
		try {
			({ sessionDir } = this.prepareTempScan(ruleId, ruleYaml));
			const configFile = path.join(sessionDir, ".sgconfig.yml");
			const { cmd: sgCmd, args: sgPre } = getSgCommand();
			const scanArgs = [
				...sgPre,
				"scan",
				"--config",
				configFile,
				"--json",
				...sgExcludeArgsForProject(dir),
				dir,
			];
			const spawnOptions = {
				timeout,
				deadlineAt: options.deadlineAt,
				signal: options.signal,
				maxOutputBytes: MAX_SG_OUTPUT_BYTES,
			};
			if (!applyFixes) {
				const result = await safeSpawnAsync(sgCmd, scanArgs, spawnOptions);
				const scan = this.interpretScanResult(result, ["scan"]);
				return scan.failure || scan.error
					? { matches: [], error: scan.error }
					: { matches: scan.matches };
			}
			// Apply: capture matches BEFORE writing — once --update-all applies
			// the fix the rule no longer matches, so a post-apply json pass would
			// report zero even on a successful apply. Count first, then write.
			const jsonResult = await safeSpawnAsync(sgCmd, scanArgs, spawnOptions);
			const scan = this.interpretScanResult(jsonResult, ["scan"]);
			if (scan.failure || scan.error) {
				return { matches: [], error: scan.error };
			}
			const applyResult = await safeSpawnAsync(
				sgCmd,
				[
					...sgPre,
					"scan",
					"--config",
					configFile,
					"--update-all",
					...sgExcludeArgsForProject(dir),
					dir,
				],
				spawnOptions,
			);
			if (
				applyResult.error ||
				applyResult.failure ||
				applyResult.status !== 0
			) {
				return {
					matches: [],
					error:
						applyResult.error?.message ||
						`ast-grep apply failed with exit code ${applyResult.status}`,
				};
			}
			return { matches: scan.matches };
		} catch (err) {
			return { matches: [], error: String(err) };
		} finally {
			if (sessionDir) this.cleanupTempScan(sessionDir);
		}
	}

	/**
	 * Format matches for display
	 */
	formatMatches(
		matches: SgMatch[],
		isDryRun = false,
		maxItems = 50,
		showModeIndicator = false,
	): string {
		if (matches.length === 0) {
			if (showModeIndicator) {
				return isDryRun
					? "[DRY-RUN] No matches found."
					: "[NOT APPLIED] No matches found — nothing was changed. Run ast_grep_search to confirm the pattern matches before applying.";
			}
			return "No matches found";
		}

		const shown = matches.slice(0, maxItems);
		const lines = shown.map((m) => {
			const loc = `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}`;
			const text = m.text.length > 100 ? `${m.text.slice(0, 100)}...` : m.text;
			const langSuffix = m.language ? `  [${m.language}]` : "";
			const base =
				isDryRun && m.replacement
					? `${loc}\n  - ${text}\n  + ${m.replacement}`
					: `${loc}: ${text}${langSuffix}`;
			const captures = formatMetaVarCaptures(m.metaVariables);
			return captures ? `${base}\n${captures}` : base;
		});

		if (matches.length > maxItems) {
			lines.unshift(
				`Found ${matches.length} matches (showing first ${maxItems}):`,
			);
		}

		if (showModeIndicator) {
			const prefix = isDryRun ? "[DRY-RUN]" : "[APPLIED]";
			const suffix = isDryRun
				? "\n\n(Dry run — use apply=true to apply changes)"
				: "";
			return `${prefix} ${matches.length} replacement(s):\n\n${lines.join("\n")}${suffix}`;
		}

		return lines.join("\n");
	}
}
