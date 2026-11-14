/**
 * Shared runner utilities for pi-lens dispatch system
 *
 * Extracted common patterns from multiple runners to reduce duplication:
 * - Venv-aware command finders
 * - Availability checkers with caching
 * - Config file finders
 */

import { emitBounded } from "../../../bounded-telemetry.js";
import { resolveAnalysisRootPath } from "../../../analysis-root.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { delimiter, resolve as resolveCommandPath } from "node:path";
import { logSessionStart } from "../../../sessionstart-logger.js";
import { incrementDegradationCount } from "../../../degradation-ledger.js";
import { isToolInstallDisabled } from "../../../env-utils.js";
import { getGlobalPiLensDir } from "../../../file-utils.js";
import {
	getProjectTrustGeneration,
	getProjectTrustState,
} from "../../../project-trust.js";
import {
	createGenerationSource,
	type GenerationHandle,
} from "../../../generation-guard.js";
import { PathKeyedMap } from "../../../path-keyed-map.js";
import {
	isUnderDir,
	normalizeEphemeralMapKey,
	normalizeMapKey,
} from "../../../path-utils.js";
import {
	ensureTool,
	findManagedToolBinary,
	getInstallAttempt,
	getLastEnsureResolutionSource,
	getToolInstallStrategy,
	isSpawnableCommand,
	resetPathWalkMemo,
	type InstallAttempt,
} from "../../../installer/index.js";
import { getServersForFileWithConfig } from "../../../lsp/config.js";
// The covers-fact LEAF, not the server registry: importing clients/lsp/server.js
// here closes a dependency cycle through the installer's graph
// (`no-client-cycles`, dependency-cruiser #2125).
import { BUILTIN_SERVER_RUNNER_COVERS } from "../../../lsp/server-covers.js";
// Also a leaf: the role vocabulary imports nothing, so the ONE auxiliary
// predicate (#1488) costs this file no edge into the registry graph.
import { isAuxiliary } from "../../../lsp/server-traits.js";
import {
	findGlobalBinary,
	findLocalBinAt,
	findLocalBinUpwards,
	isLocalBinTrustRefusal,
	type LocalBinLookup,
	localBinPath,
	NODE_MODULES_BIN_DIRS,
	VENDOR_BIN_DIRS,
	VENV_BIN_DIRS,
} from "../../../package-manager.js";
import {
	safeSpawnAsync,
	resolveWindowsCommandForEnvironment,
} from "../../../safe-spawn.js";
import { probeToolAsync } from "../../../tool-probe.js";
import { compareOrdinal } from "../../../string-utils.js";
import {
	getToolCommandSpec,
	shouldAutoInstallTool,
} from "../../../tool-policy.js";
import {
	skipped,
	type DispatchContext,
	type RunnerClaimSource,
	type RunnerResult,
} from "../../types.js";
import { isInSpawnTimeoutCooldown } from "../../../spawn-timeout-cooldown.js";
import { resolveToolCwd } from "../../../tool-cwd.js";
import { createAvailabilityProbeFlight } from "../../../availability-probe-flight.js";
import {
	type AvailabilityCause,
	type AvailabilityLatch,
	type AvailabilityOutcome,
	type ProbeEvidence,
	type ProbeFailureShape,
	classifyProbeFailure,
	createAvailabilityLatch,
	describeInstallAttempt,
	describeProbeEvidence,
	isLatchingOutcome,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./availability-policy.js";

export type {
	AvailabilityCause,
	AvailabilityDecision,
	AvailabilityLatch,
	AvailabilityOutcome,
} from "./availability-policy.js";
export {
	createAvailabilityLatch,
	classifyProbeFailure,
	describeProbeEvidence,
	describeUnavailability,
	isTransientDecision,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./availability-policy.js";

/** The part of a verdict a tool-unusable skip reads (#5258). */
export type ToolVerdict = Pick<AvailabilityVerdict, "outcome" | "cause">;

/** What a runner's resolution of its tool decided, for its skip (#5258). */
export interface ToolVerdictSource {
	getVerdict(cwd: string): AvailabilityVerdict;
	/**
	 * Whether pi project trust refused the project-local binary this checker's
	 * own ladder looks up at `cwd` (its command, extension and bin dirs). Only a
	 * checker with a project rung has one.
	 */
	projectBinaryRefused?(cwd: string): boolean;
}

/**
 * What a runner read to learn its tool was unusable (#5258). The skip reads
 * only the resolution the runner used: a checker it did not probe says nothing
 * about why its own lookup failed.
 */
export interface ToolSkipSource {
	/**
	 * The registry tool id. It names the managed install, so `install-disabled`
	 * is said only of a tool the installer could have supplied. Omit it for a
	 * PATH-only toolchain.
	 */
	id?: string;
	/**
	 * The checker or cwd probe the runner resolved its tool through. With `id`
	 * alone it is the registry ladder, so `{ id }` means the runner called
	 * `resolveToolCommandWithInstallFallback(cwd, id)`. Omit both for a finder
	 * that returns only a path: its null is a plain absence.
	 */
	checker?: ToolVerdictSource;
	/**
	 * The verdict of a resolution made outside any checker (rubocop's own
	 * `--version` spawn, the PowerShell module probe), `null` when it reached
	 * none. When present it is the only verdict read, never a checker's.
	 */
	verdict?: ToolVerdict | null;
	/**
	 * A project-binary lookup the runner made outside its checker (taplo's
	 * upward walk, phpstan's `vendor/bin` walk) was refused by trust.
	 */
	trustRefused?: boolean;
	/**
	 * The checker probes a runtime the tool needs (Java for SpotBugs), so its
	 * absence reads `runtime-missing`, never as the tool's own.
	 */
	runtime?: boolean;
}

/**
 * The skip a runner returns when its tool could not be used (#5258), worded
 * by the typed verdict of the resolution the runner used, so the cause the
 * notice and the `runner-skip-cause` record state is the one the probe found,
 * never "not installed" for a tool that merely timed out or was refused:
 *
 * | verdict | reason |
 * | --- | --- |
 * | transient (probe timeout, host stall, unspawnable finder, retries spent), or a bad workspace | `probe-incomplete` |
 * | non-installable (found, rejected its version probe) | `probe-rejected` |
 * | cause `policy-denied`, or trust refused the project binary the runner's own lookup found | `trust-refused` |
 * | missing otherwise, or no verdict, for a runtime the tool needs | `runtime-missing` |
 * | missing otherwise, or no verdict, the managed install is off and the installer would install the tool | `install-disabled` |
 * | missing otherwise, or no verdict (a finder) | `not-installed` |
 */
export function toolAbsentSkip(
	cwd: string,
	tool: ToolSkipSource = {},
): RunnerResult {
	const ownVerdict = "verdict" in tool;
	const checker = ownVerdict
		? undefined
		: (tool.checker ??
			(tool.id
				? (toolBinaryChecker(tool.id, "managed-first") ?? undefined)
				: undefined));
	const verdict = ownVerdict ? tool.verdict : checker?.getVerdict(cwd);
	if (verdict?.outcome === "transient" || verdict?.cause === "bad-cwd")
		return skipped("probe-incomplete");
	if (verdict?.outcome === "non-installable") return skipped("probe-rejected");
	if (
		verdict?.cause === "policy-denied" ||
		tool.trustRefused === true ||
		checker?.projectBinaryRefused?.(cwd) === true
	)
		return skipped("trust-refused");
	if (tool.runtime === true) return skipped("runtime-missing");
	return skipped(
		isToolInstallDisabled() &&
			tool.id !== undefined &&
			shouldAutoInstallTool(tool.id)
			? "install-disabled"
			: "not-installed",
	);
}

/**
 * The covering lane a runner should defer to: the file's SELECTED PRIMARY
 * server claims one of its declared runner capabilities, with the gate
 * commands the caller must probe (`DispatchContext.hasTool`) before honoring
 * the fact — a covering lane that cannot run never defers, so coverage never
 * regresses.
 */
export interface PrimaryRunnerCoverage {
	/** The covering server's id (the file's selected primary). */
	serverId: string;
	/**
	 * Probeable commands gating the covering lane. A builtin fact gates on
	 * the fact's own commands; a CUSTOM row's declared claim gates on that
	 * row's own command (projected from `CustomServerConfig.command`),
	 * symmetric with the builtin facts — an absent custom binary means the
	 * claim is not honored and the CLI runner runs, so coverage never
	 * silently drops to a config typo (#3968 F2). A builtin-shaped row whose
	 * claim comes only from a config-declared `covers` (never produced by the
	 * real pipeline) carries none.
	 */
	gateCommands: readonly string[];
	/**
	 * Which fact source supplied the claim — row provenance, never an id
	 * lookup (#3968 F2). The runners stamp it on the skip so the durable
	 * latency row shows who claimed (`covered-by-primary` + `claimSource`).
	 */
	claimSource: RunnerClaimSource;
}

/**
 * The capability question behind the #233 self-skip: does the file's selected
 * PRIMARY LSP server subsume `runnerId` (a dispatch runner id — the RUNNER
 * capability, never a server id)? Used by CLI runners that duplicate a linter
 * a warm LSP already wraps (shcheck → the `bash`/`shuck` LSPs embed
 * shellcheck; taplo CLI → the `toml` LSP embeds the taplo linter) so they
 * SELF-SKIP and stop double-reporting the same findings.
 *
 * The claim has two sources, read in one place: the server row's own
 * `covers` field (config-declared, the stacked PR's channel) and the builtin
 * facts table `BUILTIN_SERVER_RUNNER_COVERS` (clients/lsp/server-covers.ts —
 * the importable leaf, not the registry), which additionally carries the
 * availability gate commands. Callers gate with `coveringLaneAvailable` so a
 * missing covering lane never skips.
 *
 * The old spelling — `lspPrimaryCoversFile(ctx, "bash")`, a literal SERVER id
 * at a call site asking about a RUNNER's capability — was #3968's defect: a
 * custom/covers-capable shell LSP could not defer the runner (the zdot
 * workaround needed `disabledServers: ["bash"]` to make `bash` NOT the
 * primary). Non-spawning and conservative: honors the `no-lsp` kill switch;
 * the primary itself is availability-independent BY SELECTION (disabled
 * servers never select), and availability gate work happens in
 * `coveringLaneAvailable`.
 */
export function lspPrimaryCoversFile(
	ctx: DispatchContext,
	runnerId: string,
): PrimaryRunnerCoverage | undefined {
	if (ctx.pi?.getFlag?.("no-lsp")) return undefined;
	const primary = getServersForFileWithConfig(ctx.filePath).find(
		(s) => !isAuxiliary(s),
	);
	if (!primary) return undefined;
	// Claim provenance is resolved by ROW provenance, never by id lookup
	// (#3968 F2): a custom row (`lsp.servers.<id>`) shares its id's namespace
	// with the builtin table, so an id-keyed fact lookup would inherit a
	// claim the declared server never made — a `lsp.servers.bash` overlay is
	// NOT the builtin bash server, and its bare registration must never
	// suppress the CLI runner. eab4bcc12 dropped the false claim; this also
	// scopes the GATE, which that round left ungated (a custom row's declared
	// skip carried no probe at all).
	const fact = primary.custom
		? undefined
		: BUILTIN_SERVER_RUNNER_COVERS.get(primary.id);
	const covers = primary.covers ?? fact?.runnerIds;
	if (!covers?.includes(runnerId)) return undefined;
	// The gate follows the claim's source. A builtin fact probes the fact's
	// commands; a custom claim probes the covering lane's own binary — the
	// same shape `launchLSP` resolves, `command` being the binary token with
	// args a separate field. A custom row whose command projection is absent
	// (an older released writer's shape) cannot name a gate binary, so the
	// claim is not honored at all: fail closed to the CLI runner.
	const gateCommands = fact
		? fact.gateCommands
		: primary.custom
			? primary.command
				? [primary.command]
				: undefined
			: [];
	if (gateCommands === undefined) return undefined;
	return {
		serverId: primary.id,
		gateCommands,
		claimSource: fact ? "builtin-fact" : "declared",
	};
}

/**
 * The availability half of the seam: every gate command the covering fact
 * names must probe present (`ctx.hasTool`), else the runner must NOT skip —
 * coverage never regresses (#3968's "when the covering lane is absent, no
 * skip").
 */
export async function coveringLaneAvailable(
	ctx: DispatchContext,
	cover: PrimaryRunnerCoverage,
): Promise<boolean> {
	for (const gate of cover.gateCommands) {
		if (!(await ctx.hasTool(gate))) return false;
	}
	return true;
}

/**
 * Managed-shim candidates for a Node CLI tool, in the installer's own
 * preference order (`getToolPath`'s managed-first branch: `.cmd`, then `.exe`,
 * then extensionless on Windows; extensionless elsewhere).
 *
 * The pi-lens dir is read per call, never memoized at module load, so tests that
 * point `getGlobalPiLensDir` at a temp home still see their own tree.
 */
function managedNodeToolCandidates(tool: string): string[] {
	const base = path.join(
		getGlobalPiLensDir(),
		"tools",
		"node_modules",
		".bin",
		tool,
	);
	return process.platform === "win32"
		? [`${base}.cmd`, `${base}.exe`, base]
		: [base];
}

type ManagedVerdict = "absent" | "ok" | "broken" | "unverified";

type ManagedVerdictMemo =
	| { verdict: "ok" | "broken" }
	/**
	 * A probe that never got a fair run. Held under a cooldown, not forever: a
	 * cold-cache host can blow the budget on a perfectly good shim, and one slow
	 * first touch must not pin "cannot verify" for the whole session.
	 */
	| { verdict: "unverified"; retryAtMs: number; attempts: number };

/**
 * Verification verdicts for managed shims, keyed by path + mtime + size, so a
 * reinstall re-verifies and a session start re-arms.
 *
 * A plain `Map`, not a `PathKeyedMap`: every path keyed here is produced by
 * `path.join` from one of two producers — `managedNodeToolCandidates` and the
 * installer's `findManagedToolBinary` (#2140) — so the write and read forms are
 * the same string by construction and cannot diverge on case or separator.
 */
const managedBinaryVerdicts = new Map<string, ManagedVerdictMemo>();
/**
 * Verifications in progress, keyed the same way. Concurrent first touches of
 * one shim share the single probe instead of each spawning their own — the
 * same in-flight-share shape `resolveInstallInFlightByCwd` uses for installs
 * (#1674 review F2).
 */
const managedVerifyInFlight = new Map<string, Promise<ManagedVerdict>>();

/**
 * Budget for the managed-shim verification spawn.
 *
 * 5s, not the checker's default probe budget: a cold npm shim on a cold file
 * cache measured just over 2s in the #1674 review, so a tighter budget spends
 * the whole wait and still learns nothing. This runs once per shim per session
 * on the success path, and the installer's own verification keeps its more
 * generous 10s.
 */
const MANAGED_VERIFY_TIMEOUT_MS = 5000;
/** First cooldown after a verification that never got a fair run. */
const MANAGED_VERIFY_COOLDOWN_MS = 60_000;
/**
 * Ceiling for the cooldown ladder — a shim that keeps stalling is still
 * re-probed every 15 minutes.
 */
const MANAGED_VERIFY_COOLDOWN_MAX_MS = 15 * 60_000;

function managedVerifyCooldownMs(attempts: number): number {
	return Math.min(
		MANAGED_VERIFY_COOLDOWN_MAX_MS,
		MANAGED_VERIFY_COOLDOWN_MS * 2 ** (attempts - 1),
	);
}

async function runManagedVerification(
	candidate: string,
	stamp: string,
	priorAttempts: number,
	generation: GenerationHandle,
	verificationArgs: string[] = ["--version"],
): Promise<ManagedVerdict> {
	let transient = false;
	let ok: boolean;
	try {
		const { verifyToolBinary } = await import("../../../installer/index.js");
		ok = await verifyToolBinary(
			candidate,
			undefined,
			() => {
				transient = true;
			},
			MANAGED_VERIFY_TIMEOUT_MS,
			verificationArgs,
		);
	} catch {
		// The verifier itself could not run — installer-isolated unit tests mock
		// this module without it, and a throw here says nothing about the shim.
		// "Cannot verify" is not "broken": keep the on-disk answer.
		transient = true;
		ok = false;
	}
	// An unspawnable prober is never a durable verdict (#1569): a timeout or a
	// spawn-boundary failure says nothing about the shim, so it never demotes
	// the candidate. It IS remembered, under a cooldown, so the wait is paid
	// once per window rather than on every resolve (#1674 review F1).
	// A verification that straddles a session boundary answers ITS caller, but
	// its verdict belongs to the session that asked. Writing it into the fresh
	// session would hand the new session the old one's cooldown — the exact
	// re-arm this state clears at `session_start` (#1674 review F5). Same guard
	// the install seam's in-flight share uses.
	if (!ok && transient) {
		const attempts = priorAttempts + 1;
		generation.guardedWrite(stamp, () => {
			managedBinaryVerdicts.set(stamp, {
				verdict: "unverified",
				attempts,
				retryAtMs: Date.now() + managedVerifyCooldownMs(attempts),
			});
		});
		return "unverified";
	}
	generation.guardedWrite(stamp, () => {
		managedBinaryVerdicts.set(stamp, { verdict: ok ? "ok" : "broken" });
	});
	if (!ok) {
		// Once per shim per session, at the moment the verdict is reached — the
		// memo answers every later call, so this cannot become per-dispatch spam.
		logSessionStart(
			`dispatch availability: managed shim ${candidate} exists but does not run; falling through to PATH`,
		);
	}
	return ok ? "ok" : "broken";
}

async function verifyManagedCandidate(
	candidate: string,
	verificationArgs: string[] = ["--version"],
): Promise<ManagedVerdict> {
	let stamp: string;
	try {
		const stat = fs.statSync(candidate);
		stamp = `${candidate}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "absent";
	}
	const memo = managedBinaryVerdicts.get(stamp);
	let priorAttempts = 0;
	if (memo) {
		if (memo.verdict !== "unverified") return memo.verdict;
		if (Date.now() < memo.retryAtMs) return "unverified";
		priorAttempts = memo.attempts;
	}
	const existing = managedVerifyInFlight.get(stamp);
	if (existing) return existing;
	const generation = availabilityGeneration.capture();
	const probe = runManagedVerification(
		candidate,
		stamp,
		priorAttempts,
		generation,
		verificationArgs,
	).finally(() => {
		// A settling old-session probe must not evict the live entry a new
		// session already started for the same shim (#1674 review F5).
		generation.guardedWrite(stamp, () => {
			if (managedVerifyInFlight.get(stamp) === probe) {
				managedVerifyInFlight.delete(stamp);
			}
		});
	});
	managedVerifyInFlight.set(stamp, probe);
	return probe;
}

/**
 * The managed shim for a Node CLI tool (`~/.pi-lens/tools/node_modules/.bin/<tool>`),
 * or null when no candidate on disk actually runs.
 *
 * Verification uses the installer's own `verifyToolBinary`, the same check its
 * managed-first branch runs before returning a managed path. A bare
 * `existsSync` let a broken shim shadow a working PATH binary — the on-disk
 * file wins the race and then fails every spawn behind it (#1657). knip and
 * jscpd each carried a line-for-line copy of this resolver; #1476 folds them
 * into one definition so the next managed tool inherits the fast path instead
 * of a fourth copy.
 *
 * A settled verdict is memoized per file identity for the session, so the fast
 * path answers without a spawn after the first call (#1467). A probe that
 * cannot run keeps the optimistic answer rather than turning a stall into a
 * "missing tool", and is memoized under a bounded cooldown ladder so the wait
 * is paid once per window instead of on every resolve — while a shim that
 * stalls on a cold cache still gets re-probed later (#1674 review F1).
 * Concurrent first touches share one probe (#1674 review F2).
 */
export async function findManagedNodeToolBinary(
	tool: string,
	verificationArgs: string[] = ["--version"],
): Promise<string | null> {
	for (const candidate of managedNodeToolCandidates(tool)) {
		const verdict = await verifyManagedCandidate(candidate, verificationArgs);
		if (verdict === "ok" || verdict === "unverified") return candidate;
	}
	return null;
}

/**
 * The release-managed binary for a tool (`~/.pi-lens/bin/<tool>`), or null when
 * the registry does not put this tool there / nothing on disk actually runs.
 *
 * `findManagedToolBinary` is the INSTALLER's own lookup — the one `getToolPath`
 * runs before PATH for every github/maven/archive-strategy tool, and the one
 * `getToolEnvironment` puts at the front of a spawn's PATH. Calling it here is
 * what makes probe and spawn resolve through a single definition instead of two
 * (#2140): before this, the probe fell straight to the bare command name, missed
 * PATH, and latched `missing` — while the install fallback a few hundred ms
 * later handed the caller the very binary sitting in that directory. Every
 * session, for every tool the user already had (7 unavailable/available pairs in
 * one 3h dogfood window).
 *
 * Verification is the same `verifyManagedCandidate` the npm-shim rung above
 * uses, for the same reason (#1657): `findManagedToolBinary` answers from a bare
 * `fs.access`, and an on-disk binary that cannot run must not shadow a working
 * PATH binary — it falls through instead.
 */
async function findManagedReleaseBinary(
	tool: string,
	verificationArgs: string[] = ["--version"],
): Promise<string | null> {
	const candidate = await findManagedToolBinary(tool);
	if (!candidate) return null;
	const verdict = await verifyManagedCandidate(candidate, verificationArgs);
	return verdict === "ok" || verdict === "unverified" ? candidate : null;
}

/**
 * #4309: resolve every adopted-runner binary before any probe or spawn.
 * PATH entries are interpreted at the runner cwd and the chosen absolute path
 * is retained, so a relative PATH cannot select a different executable later.
 * Managed shims and symlinks obey the same adopted/session containment rule.
 */
export function resolveAdoptedRootCommand(
	command: string,
	ctx: DispatchContext,
	cwd: string,
): string | null {
	// Neither admitted command has a release installer; use the managed shim
	// candidates and PATH without probing either before containment.
	const candidates = managedNodeToolCandidates(command);
	let selected = candidates.find(
		(candidate) => candidate && fs.existsSync(candidate),
	);
	if (!selected) {
		if (process.platform === "win32") {
			selected = resolveWindowsCommandForEnvironment(
				command,
				cwd,
				process.env,
			)?.resolvedPath;
		} else {
			selected = (process.env.PATH ?? "")
				.split(delimiter)
				.map((dir) => resolveCommandPath(cwd, dir, command))
				.find((candidate) => {
					try {
						fs.accessSync(candidate, fs.constants.X_OK);
						return fs.statSync(candidate).isFile();
					} catch {
						return false;
					}
				});
		}
	}
	if (!selected) return null;
	try {
		const binary = fs.realpathSync.native(selected);
		const session = ctx.projectRoot ?? ctx.cwd;
		const adopted = resolveAnalysisRootPath(ctx.filePath, session);
		if (!adopted) return null;
		const roots = [adopted, session].map((root) =>
			fs.realpathSync.native(root),
		);
		if (
			roots.some(
				(root) =>
					binary === root ||
					isUnderDir(binary, root) ||
					isUnderDir(selected, root),
			)
		) {
			emitBounded(
				"adopted_root_binary_refused",
				`${ctx.filePath}:${command}:${binary}`,
				{
					filePath: ctx.filePath,
					durationMs: 0,
					metadata: { command, binary },
				},
				{
					ledgerKind: "adopted-root-binary-refused",
					risingEdgePer: "identity",
				},
			);
			return null;
		}
		return binary;
	} catch {
		// An unreadable identity cannot prove that executing it is safe.
		return null;
	}
}

// =============================================================================
// VENV-AWARE COMMAND FINDER
// =============================================================================

/**
 * Find a command in venv first, then fall back to global.
 * Checks common venv locations (.venv, venv) before trying global.
 *
 * The resolved path is returned verbatim: every spawn consumer runs with
 * `shell: false` (safe-spawn, #817), so wrapping it in quotes would make it
 * a literal filename that ENOENTs on every platform (#1508).
 *
 * The venv directory list is `VENV_BIN_DIRS` (`package-manager.ts`), shared
 * with `dead-code-client.ts`'s vulture candidates and, through
 * `resolveInstalledToolCommand`, every formatter — three independent spellings
 * of the same four directories before #2544 review F1.
 *
 * Resolution is a fixed lookup at `cwd` ONLY (`findLocalBinAt`, no ancestor
 * walk). #2544 review round 3 folded this onto the shared ANCESTOR walker,
 * on the reasoning that a monorepo package should find its repo-root venv —
 * but that was an unrequested behaviour change with no #2514 defect behind
 * it (#2514 is about the HOME ceiling, not about climbing at all), and the
 * inversion is real: `~/code/app` with no venv of its own would resolve
 * `~/code/.venv/bin/ruff` — an unrelated SIBLING project's interpreter —
 * ahead of PATH. Reverted in round 4 F2. The HOME ceiling is moot here: a
 * lookup at exactly `cwd` can never climb past it.
 */
export function createVenvFinder(
	command: string,
	windowsExt = "",
	verificationArgs: string[] = ["--version"],
	/**
	 * Adopted-root policy (#4242): when `false`, the project-local `.venv` rung is
	 * skipped entirely, so a project-local interpreter is neither probed nor run.
	 * The default (`true`) preserves every session-root caller unchanged.
	 */
	allowProjectLocal = true,
	/**
	 * The project-local bin dirs looked up at exactly `cwd`, in order (#5410).
	 * The registry-driven resolver passes the venv dirs then
	 * `node_modules/.bin`, so an npm-strategy tool's project shim is found
	 * without the memo-less second probe that used to look for it.
	 */
	projectBinDirs: readonly string[] = VENV_BIN_DIRS,
): (cwd: string) => Promise<VenvResolution> {
	return async (cwd: string): Promise<VenvResolution> => {
		if (allowProjectLocal) {
			const venvBin = localBinPath(
				findLocalBinAt(command, cwd, {
					windowsExt,
					binDirs: projectBinDirs,
				}),
			);
			if (venvBin) return { path: venvBin, rung: "venv" };
		}

		const managed = await findManagedRung(command, verificationArgs);
		if (managed) return managed;

		// Fall back to global
		return { path: command, rung: "path" };
	};
}

/**
 * The managed rungs of the ladder: the npm shim, then the release binary.
 *
 * Managed-dir install (~/.pi-lens/tools/node_modules/.bin/<command>) — the
 * same shim `ensureTool()` installs npm-strategy tools into. Checked BEFORE
 * the bare-name PATH fallback (#1638): without this, a tool that only
 * exists in the managed dir never resolves here, so `resolveAvailableOrInstall`
 * clears the checker's cache on every install recovery for nothing — the
 * very next probe misses PATH again, spawns a doomed `--version` process,
 * and only THEN falls through to `ensureTool`'s own cache. One managed-dir
 * check settles it without a spawn — after one verification per shim per
 * session, so a shim that cannot run falls through to PATH instead of
 * shadowing a working binary (#1657).
 *
 * Release-managed install (`~/.pi-lens/bin/<command>`) — where `ensureTool`
 * puts every github/maven/archive-strategy tool. Same rung, same reason as
 * the npm shim above, for the other half of the managed families (#2140).
 */
async function findManagedRung(
	command: string,
	verificationArgs: string[],
): Promise<VenvResolution | null> {
	const managed = await findManagedNodeToolBinary(command, verificationArgs);
	if (managed) return { path: managed, rung: "managed-dir" };
	const release = await findManagedReleaseBinary(command, verificationArgs);
	if (release) return { path: release, rung: "managed-release" };
	return null;
}

// =============================================================================
// AVAILABILITY CHECKER FACTORY
// =============================================================================

export type ClientAvailabilityResult<T> =
	| { outcome: "success"; value: T }
	| { outcome: Exclude<AvailabilityOutcome, "success">; value?: undefined };

/** Typed client-facing install seam for ordered/custom candidate probes. */
export async function resolveManagedToolClient<T>(options: {
	toolId: string;
	cwd: string;
	probe: () => Promise<ClientAvailabilityResult<T>>;
	acceptInstalled: (path: string) => Promise<T | null> | T | null;
}): Promise<ClientAvailabilityResult<T>> {
	const probed = await options.probe();
	if (probed.outcome !== "missing") return probed;
	if (!shouldAutoInstallTool(options.toolId)) return probed;
	const state = installStateFor(options.cwd, options.toolId);
	if (state.suppressed) return probed;
	const installed = await ensureTool(options.toolId);
	if (!installed) {
		noteInstallFailure(options.toolId, options.cwd);
		return probed;
	}
	const value = await options.acceptInstalled(installed);
	if (value === null) {
		noteInstallFailure(options.toolId, options.cwd);
		return { outcome: "non-installable" };
	}
	noteInstallSuccess(options.toolId, options.cwd);
	return { outcome: "success", value };
}

/**
 * One cwd's verdict (#5410). The verdict, its cooldown ladder and its trust
 * stamp live in the shared latch (#4530), so a trust change drops it at the
 * next read; the checker keeps only the command the verdict resolved and the
 * probe's elapsed time for the unavailable message.
 */
type AvailabilityCache = {
	latch: AvailabilityLatch;
	command: string | null;
	/** How long the last probe took, ms — surfaced in the unavailable message. */
	elapsedMs: number;
	/**
	 * Bounded output of the probe that rejected a present binary (cause
	 * `probe-rejected`), so a consumer can say the tool is present but failed
	 * its version check, with the evidence; unset for any other verdict.
	 */
	rejectedOutput?: string | undefined;
};

/** Longest probe output kept for a rejected binary, chars from the end. */
const REJECTED_OUTPUT_CHARS = 2000;

export interface AvailabilityCheckerOptions {
	probeTimeout?: number;
	fastPath?: () => string | null | Promise<string | null>;
	/** Environment used by both the availability probe and later client spawns. */
	environment?: (cwd: string) => Promise<NodeJS.ProcessEnv>;
	/** Compatibility for legacy probes whose test doubles carry no failure kind. */
	unclassifiedFailureOutcome?: AvailabilityOutcome;
	/**
	 * Adopted-root policy (#4242): `false` resolves only managed or PATH binaries,
	 * never a project-local `.venv` one. Omitted keeps the session default.
	 */
	allowProjectLocal?: boolean;
	/** Project-local bin dirs at exactly `cwd`; see `createVenvFinder`. */
	projectBinDirs?: readonly string[];
	/**
	 * Resolve the bare command on PATH only, for a caller that spawns it by
	 * that bare name (`DispatchContext.hasTool`, #5410): a managed or venv
	 * answer would pass a binary the caller then cannot find.
	 */
	pathOnly?: boolean;
	/**
	 * Rung order after the project (#5492 r2). `managed-first` (the default,
	 * every runner): managed installs, then PATH. `path-first` (formatters): the
	 * version of a formatter decides the bytes it writes, so a PATH binary that
	 * passes its version check outranks the managed copy; one that fails falls
	 * through to managed.
	 */
	order?: "managed-first" | "path-first";
}

/**
 * Child environment for managed-installable tools. Keeping this beside the
 * probe/install seam makes managed npm shims visible to every standalone
 * client, rather than only to Knip (#1289).
 */
export async function getManagedToolEnvironment(
	_toolId: string,
	cwd?: string,
): Promise<NodeJS.ProcessEnv> {
	let env: NodeJS.ProcessEnv;
	try {
		const { getToolEnvironment } = await import("../../../installer/index.js");
		env = await getToolEnvironment();
	} catch {
		// Installer-isolated unit tests historically mock only ensureTool. The
		// ambient fallback preserves that isolation; production always exports it.
		env = { ...process.env };
	}
	if (!cwd) return env;
	// A project-local bin dir on PATH can execute the project's own shim for the
	// managed tool's dependencies, so it carries the same trust gate as the
	// direct lookups (#4268). Global and managed tools still run; only the path
	// augmentation that reaches INTO the project is withheld.
	if (getProjectTrustState() !== "trusted") return env;
	const separator = process.platform === "win32" ? ";" : ":";
	const currentPath = env.PATH || env.Path || process.env.PATH || "";
	const localBin = path.join(cwd, "node_modules", ".bin");
	const augmentedPath = `${localBin}${separator}${currentPath}`;
	return {
		...env,
		PATH: augmentedPath,
		...(process.platform === "win32" ? { Path: augmentedPath } : {}),
	};
}

/** Read-only managed/PATH discovery for spawn-time resolution memos. */
export async function discoverManagedTool(
	toolId: string,
): Promise<string | null> {
	return (await ensureTool(toolId, { allowInstall: false })) ?? null;
}

type InstallAttemptState = {
	attempts: number;
	suppressed: boolean;
};

// This is session-scoped state, not a process-global tool/path cache. The cwd
// key is normalized by PathKeyedMap and is cleared at session_start. A failed
// install must not become an install attempt on every eligible file/turn.
const installAttemptsByCwd = new PathKeyedMap<Map<string, InstallAttemptState>>(
	normalizeMapKey,
);
const resolveInstallInFlightByCwd = new PathKeyedMap<
	Map<string, Promise<string | null>>
>(normalizeEphemeralMapKey);
// Which (cwd, toolId) pairs already got their ONE compensating `available`
// row this session for a GENUINE correction (#1612 review F2).
// `checker.reset()` clears the checker's own cache on every install recovery,
// so the NEXT call re-probes PATH from scratch — and that probe keeps missing
// for a managed-dir-only install (createVenvFinder never searches the managed
// tools dir; tracked separately as its own bug). Without this memo, every one
// of those repeat probe failures looks like a fresh correction and re-logs
// "available", even though only the first call actually ran an install.
//
// A correction is genuine only when a latched `unavailable` row for the same
// pair stood before it. `verifyOrInstallCommand` also emits through this seam
// with NO prior latch behind it (the bundler-form
// `resolveCommandArgsWithInstallFallback` reaches it with no checker probe at
// all), and burning this memo on such a row silences the
// LATER genuine latch-then-recover for the same pair — the #1606 defect back
// through the #1612 seam (#1657). Those rows dedupe against
// `uncorrectedEmissionsByCwd` instead, so repeats stay suppressed without
// pre-empting the real correction.
const correctedAvailabilityByCwd = new PathKeyedMap<Set<string>>(
	normalizeMapKey,
);
// Which (cwd, toolId) pairs already emitted an `available` row that corrected
// nothing (no latched `unavailable` stood before it). Same one-row-per-session
// bound as the memo above, kept in a SEPARATE scope so it cannot answer for a
// correction that has not happened yet (#1657).
const uncorrectedEmissionsByCwd = new PathKeyedMap<Set<string>>(
	normalizeMapKey,
);
// Which (cwd, tool) pairs currently stand latched `unavailable` in the durable
// log. Recorded where such a row is actually written, so "was there anything
// to correct" is read from the log's own history rather than assumed by the
// caller. Session-scoped: `resetDispatchAvailabilityState` clears it, so a new
// session re-arms instead of inheriting the last one's latches (#1657).
const latchedUnavailableByCwd = new PathKeyedMap<Set<string>>(normalizeMapKey);
// Checkers are created by runner modules and may also be created dynamically.
// Keep the session reset as a generation rather than retaining every checker
// reset closure forever.
//
// #1754: the counter itself is now the shared `GenerationSource` primitive, so
// the capture-before-await/check-after guards below are one implementation
// instead of five hand-rolled ones, and a dropped straddling write is visible
// in the degradation ledger instead of silent.
const availabilityGeneration = createGenerationSource("dispatch-availability");
export const getDispatchAvailabilityGeneration = (): number =>
	availabilityGeneration.current();

const checkerProbeFlights = createAvailabilityProbeFlight<
	Awaited<ReturnType<typeof safeSpawnAsync>>
>({ generation: getDispatchAvailabilityGeneration });

export function recordAvailabilityProbeOverrun(
	tool: string,
	key: string,
	elapsedMs: number,
	budgetMs: number | undefined,
	failure?: ProbeFailureShape["failure"],
): void {
	if (budgetMs === undefined || elapsedMs <= budgetMs) return;
	if (failure === "timeout" && elapsedMs <= budgetMs * 2) return;
	incrementDegradationCount({
		kind: "availability-probe-overrun",
		subject: `${tool}:${key}`,
		reason: `probe took ${Math.round(elapsedMs)}ms; budget was ${Math.round(budgetMs)}ms`,
	});
}

function installStateFor(cwd: string, toolId: string): InstallAttemptState {
	let states = installAttemptsByCwd.get(cwd);
	if (!states) {
		states = new Map();
		installAttemptsByCwd.set(cwd, states);
	}
	let state = states.get(toolId);
	if (!state) {
		state = { attempts: 0, suppressed: false };
		states.set(toolId, state);
	}
	return state;
}

function noteInstallFailure(toolId: string, cwd: string): void {
	const state = installStateFor(cwd, toolId);
	state.attempts += 1;
	state.suppressed = true;
	logSessionStart(
		`dispatch availability ${toolId}: install attempt ${state.attempts} failed; suppressing retries until the next session or a successful install`,
	);
}

function noteInstallSuccess(toolId: string, cwd: string): void {
	const states = installAttemptsByCwd.get(cwd);
	states?.delete(toolId);
	if (states?.size === 0) installAttemptsByCwd.delete(cwd);
}

function hasId(
	map: PathKeyedMap<Set<string>>,
	cwd: string,
	id: string,
): boolean {
	return map.get(cwd)?.has(id) ?? false;
}

function addId(map: PathKeyedMap<Set<string>>, cwd: string, id: string): void {
	let ids = map.get(cwd);
	if (!ids) {
		ids = new Set();
		map.set(cwd, ids);
	}
	ids.add(id);
}

function deleteIds(
	map: PathKeyedMap<Set<string>>,
	cwd: string,
	ids: string[],
): void {
	const existing = map.get(cwd);
	if (!existing) return;
	for (const id of ids) existing.delete(id);
	if (existing.size === 0) map.delete(cwd);
}

/**
 * True once a compensating `available` row has already fired for this
 * (cwd, toolId) pair this session; `noteAvailabilityCorrected` records it the
 * first time. #1612 review F2's "once per correction" — see
 * `correctedAvailabilityByCwd`'s comment for why repeats need suppressing.
 */
function hasCorrectedAvailability(cwd: string, toolId: string): boolean {
	return hasId(correctedAvailabilityByCwd, cwd, toolId);
}

function noteAvailabilityCorrected(cwd: string, toolId: string): void {
	addId(correctedAvailabilityByCwd, cwd, toolId);
}

/**
 * Record that a latched `unavailable` row now stands for this pair. Called
 * from each seam that writes one (the availability checker and the shared
 * probe latch), so a later compensating row can tell a genuine correction
 * from a no-op emission (#1657).
 */
function noteLatchedUnavailable(cwd: string, tool: string): void {
	addId(latchedUnavailableByCwd, cwd, tool);
}

/**
 * Drop the latch record for a pair, because the row it described no longer
 * stands. Called on every `available` verdict as well as on the compensating
 * row itself, so a latch cannot outlive the state it describes and later back
 * a "correction" that corrects nothing (#1674 review F3).
 */
function clearLatchedUnavailable(cwd: string, ...tools: string[]): void {
	deleteIds(latchedUnavailableByCwd, cwd, tools);
}

/**
 * Every name a latched row for this pair could have been written under. A
 * checker logs its COMMAND (sometimes a resolved absolute path), the install
 * seam knows a toolId, and the two are not always the same string. One
 * derivation feeds BOTH the lookup and the clear, so the two can never
 * disagree about which key the latch lives under (#1674 review F3).
 */
function latchKeysFor(toolId: string, command?: string): string[] {
	const keys = [toolId];
	if (command) keys.push(command, path.basename(command));
	return keys;
}

/**
 * True when a latched `unavailable` row stands for any of these keys. A false
 * positive only restores the pre-#1657 behavior (the row emits and burns the
 * correction memo); a false negative still emits the row, under the
 * uncorrected scope. Neither can swallow a genuine correction.
 */
function hasLatchedUnavailable(cwd: string, tools: string[]): boolean {
	return tools.some((tool) => hasId(latchedUnavailableByCwd, cwd, tool));
}

/**
 * Which installer family resolved a tool, for the compensating row's
 * `evidence.source` (#1612 review F1). Reads the registry's own
 * `installStrategy` rather than hand-mapping per toolId — the two cannot
 * drift apart because there is only one list.
 */
function sourceTagForToolId(toolId: string): ProbeEvidence["source"] {
	switch (getToolInstallStrategy(toolId)) {
		case "npm":
			return "managed-dir";
		case "pip":
			return "pip-user";
		case "github":
			return "github-release";
		case "archive":
			return "archive-dist";
		case "maven":
			return "maven-jar";
		case "gem":
		case undefined:
		default:
			// "gem" has no CLI runner behind this seam yet, and an unknown toolId
			// means the registry lookup itself missed — either way, no tag beats
			// a guessed one.
			return undefined;
	}
}

/** Which rung in `createVenvFinder` supplied the command for this probe. */
type VenvResolution = {
	path: string;
	rung: "venv" | "managed-dir" | "managed-release" | "path";
};

/**
 * Add managed-binary evidence from the exact rung that resolved the command
 * (#2140, #2660). Re-checking the installer here repeated the resolution and
 * could disagree with the answer the probe actually launched.
 *
 * `binary` present IS the managed hit; `source` names the family whenever the
 * command is a registry id (`sourceTagForToolId` reads the registry's own
 * `installStrategy`). A managed shim whose COMMAND is not itself a registry id
 * — `markdownlint-cli2`, installed under registry id `markdownlint` — carries
 * `binary` alone rather than a guessed family. Venv and PATH answers have no
 * managed-binary evidence. `binary` is a BASENAME, never an absolute path
 * (#1568 review).
 */
function describeManagedResolution(
	tool: string,
	resolution: VenvResolution,
): ProbeEvidence {
	if (
		resolution.rung !== "managed-dir" &&
		resolution.rung !== "managed-release"
	) {
		return {};
	}
	const source = sourceTagForToolId(tool);
	return {
		binary: path.basename(resolution.path),
		...(source !== undefined && { source }),
	};
}

/**
 * How to tag a not-fresh install resolution in the compensating row's
 * evidence (#1636 review, carried over from #1615's verify). `getInstallAttempt`
 * answers `undefined` for BOTH a genuine cache hit and a plain PATH/managed-dir
 * discovery, and answers `declined`/`skipped` for a policy refusal that still
 * hands back whatever discovery found — three different facts a single
 * `"cache"` tag used to flatten into one. `declined`/`skipped` take priority
 * over the source map: a project-trust decline overwrites whatever the
 * discovery pass underneath it found (see `ensureTool`'s trust-gate branch in
 * installer/index.ts), so by the time this reads it, "declined" is the honest
 * answer regardless of how the binary was actually found.
 */
function resolvedTagForAttempt(
	toolId: string,
	attempt: InstallAttempt | undefined,
): "cache" | "path" | "declined" {
	if (attempt?.outcome === "declined" || attempt?.outcome === "skipped") {
		return "declined";
	}
	return getLastEnsureResolutionSource(toolId) === "path" ? "path" : "cache";
}

/**
 * Emit the ONE compensating `available` row for a (cwd, toolId) correction,
 * after a latched unavailable probe recovers via `ensureTool`. This is the
 * SINGLE row constructor for every caller behind this seam —
 * `resolveAvailableOrInstallUnshared` (#1612) and `verifyOrInstallCommand`
 * (#1636) both call it rather than each hand-rolling their own, which is
 * exactly the drift #1610's own review caught the first time this shape
 * shipped twice.
 *
 * Gated on the once-per-correction memo (`correctedAvailabilityByCwd`,
 * #1612 review F2): `checker.reset()` / a cleared probe cache means the NEXT
 * call for the same (cwd, toolId) can resolve the same tool again with no
 * fresh attempt behind it, and that must not re-log a "fresh correction"
 * every time.
 *
 * `latchKeys` are every name a latched `unavailable` row for this pair could
 * carry. A row that clears one of them is a genuine correction and burns the
 * correction memo; a row with nothing to correct dedupes in its own scope, so
 * it cannot silence the genuine latch-then-recover that follows it for the
 * same pair (#1657).
 */
function emitCompensatingAvailableRow(
	cwd: string,
	toolId: string,
	installStartedAt: number,
	installedPath: string,
	latchKeys: string[],
): void {
	if (hasCorrectedAvailability(cwd, toolId)) return;
	const correctsLatchedRow = hasLatchedUnavailable(cwd, latchKeys);
	if (correctsLatchedRow) {
		noteAvailabilityCorrected(cwd, toolId);
		// Clear every key the latch could live under, not just the toolId: the
		// checker records the row under its COMMAND, and a leftover entry would
		// later back a "correction" with nothing behind it (#1674 review F3).
		clearLatchedUnavailable(cwd, ...latchKeys);
	} else {
		if (hasId(uncorrectedEmissionsByCwd, cwd, toolId)) return;
		addId(uncorrectedEmissionsByCwd, cwd, toolId);
	}
	// `installed`/`installedPath` can come back truthy WITHOUT ensureTool
	// running an install this call — its in-memory cache, its on-disk probe
	// cache, getToolPath finding it already present, or a concurrent peer's
	// install all return a path with no fresh attempt recorded. Deriving from
	// `getInstallAttempt` (rather than asserting "succeeded" because the path
	// is truthy, or hand-rolling a second mapping) is what #1610's OWN
	// failure-path mirror bug was caught on review; read the REAL outcome
	// through the one function that already knows how, don't assume it. Hard
	// import, no `typeof` guard (#1636 review): a genuinely removed export
	// must throw here, not silently read as "not attempted".
	const attempt = getInstallAttempt(toolId);
	const installEvidence = describeInstallAttempt(attempt);
	const evidence: ProbeEvidence = {
		...installEvidence,
		binary: path.basename(installedPath),
		source: sourceTagForToolId(toolId),
		// Set alongside any non-"succeeded" outcome: the path is truthy but
		// nothing ran this call, so it came from an already-known-good answer
		// rather than a fresh attempt (#1612 review F2).
		...(installEvidence.install !== "succeeded" && {
			resolved: resolvedTagForAttempt(toolId, attempt),
		}),
		// The whole point of the memo split, on the record: a reader can tell a
		// row that cleared a latched `unavailable` from one that corrected
		// nothing, without re-deriving it from the surrounding rows (#1674
		// review F4).
		correctsLatchedRow,
	};
	logAvailabilityDecision(
		{
			tool: toolId,
			verdict: "available",
			outcome: "success",
			cause: "ok",
			elapsedMs: Date.now() - installStartedAt,
			// `checker.reset()`/a fresh probe just cleared whatever cache stood
			// behind this call, so nothing is actually held pinned the instant
			// this row is written — the very next probe starts fresh
			// (#1612 review F3). Writing `true` here would claim a durability
			// this call doesn't have.
			latched: false,
			classifiedBy: "caller",
			evidence,
		},
		cwd,
	);
}

/** Reset availability/install suppression at the session boundary. */
export function resetDispatchAvailabilityState(): void {
	installAttemptsByCwd.clear();
	resolveInstallInFlightByCwd.clear();
	correctedAvailabilityByCwd.clear();
	uncorrectedEmissionsByCwd.clear();
	latchedUnavailableByCwd.clear();
	managedBinaryVerdicts.clear();
	managedVerifyInFlight.clear();
	resetPathWalkMemo();
	availabilityGeneration.bump();
	checkerProbeFlights.clear();
	cwdProbeFlights.clear();
}

/** What the last probe for a cwd decided, for messaging and telemetry (#1467). */
export interface AvailabilityVerdict {
	outcome: AvailabilityOutcome | null;
	cause: AvailabilityCause | null;
	elapsedMs: number;
	/** True when the verdict is remembered until the next session reset. */
	latched: boolean;
	/** Epoch ms after which a transient verdict may be re-probed; 0 = latched. */
	retryAtMs: number;
	/** Probe output of a present binary that rejected its version check. */
	rejectedOutput?: string;
}

/**
 * Create a cached availability checker for a command.
 * The checker will look for the command in venv first, then global.
 *
 * `versionArgs` defaults to `["--version"]` but some tools reject that flag and
 * expose version under a subcommand instead (e.g. `zig version`, not
 * `zig --version`). Passing the wrong probe makes the runner silently skip on
 * every machine, so toolchains with a non-standard version command must override
 * this.
 *
 * ## Latch policy (#1467)
 *
 * A `missing` / `non-installable` verdict is durable and is cached for the
 * session. A `transient` verdict — timeout, abort, EAGAIN — is NOT: it is
 * cached only for a bounded cooldown, after which the next caller re-probes.
 * An installed tool therefore recovers on its own, without a host restart.
 */
export function createAvailabilityChecker(
	command: string,
	windowsExt = "",
	versionArgs: string[] = ["--version"],
	options: AvailabilityCheckerOptions = {},
): {
	isAvailableAsync: (cwd?: string) => Promise<boolean>;
	getCommand: (cwd?: string) => string | null;
	getOutcome: (cwd?: string) => AvailabilityOutcome | null;
	getVerdict: (cwd?: string) => AvailabilityVerdict;
	projectBinaryRefused: (cwd: string) => boolean;
	reset: () => void;
} {
	const cacheByCwd = new PathKeyedMap<AvailabilityCache>(
		normalizeEphemeralMapKey,
	);
	// The trust the probe started under rides with it: a caller that arrives
	// after pi's trust answer changed starts its own probe instead of joining
	// one whose search path was scoped for the old answer (#4776).
	const inFlightByCwd = new PathKeyedMap<{
		trustGeneration: number;
		promise: Promise<boolean>;
	}>(normalizeEphemeralMapKey);
	let checkerGeneration = availabilityGeneration.current();
	let checkerFlightGeneration = 0;

	const pathFirst = options.order === "path-first";
	const allowProjectLocal = options.allowProjectLocal !== false;
	const pathRung = (): VenvResolution => ({ path: command, rung: "path" });
	// The project rung at exactly `cwd`, the same lookup `createVenvFinder` makes.
	const projectRung = (cwd: string) =>
		findLocalBinAt(command, cwd, {
			windowsExt,
			binDirs: options.projectBinDirs ?? VENV_BIN_DIRS,
		});
	const findCommand = options.pathOnly
		? async (): Promise<VenvResolution> => pathRung()
		: pathFirst
			? async (cwd: string): Promise<VenvResolution> => {
					const project = allowProjectLocal
						? localBinPath(projectRung(cwd))
						: undefined;
					return project ? { path: project, rung: "venv" } : pathRung();
				}
			: createVenvFinder(
					command,
					windowsExt,
					versionArgs,
					allowProjectLocal,
					options.projectBinDirs,
				);
	// The rungs beyond the project: where a broken project shim falls through.
	const findBeyondProject = createVenvFinder(
		command,
		windowsExt,
		versionArgs,
		false,
	);
	/**
	 * Where a rung that failed for good falls through to, or `null` when the
	 * ladder is spent. Managed-first: a project shim falls to managed then PATH.
	 * Path-first: project, then PATH, then managed.
	 */
	async function nextRung(
		from: VenvResolution["rung"],
		cwd: string,
	): Promise<VenvResolution | null> {
		if (!pathFirst) return from === "venv" ? findBeyondProject(cwd) : null;
		if (from === "venv") return pathRung();
		if (from === "path") return findManagedRung(command, versionArgs);
		return null;
	}

	function ensureCurrentGeneration(): void {
		if (checkerGeneration === availabilityGeneration.current()) return;
		cacheByCwd.clear();
		inFlightByCwd.clear();
		checkerGeneration = availabilityGeneration.current();
		checkerFlightGeneration++;
	}

	const reset = (): void => {
		cacheByCwd.clear();
		inFlightByCwd.clear();
		checkerGeneration = availabilityGeneration.current();
		checkerFlightGeneration++;
	};

	function getCache(cwd: string): AvailabilityCache {
		ensureCurrentGeneration();
		const key = path.resolve(cwd || process.cwd());
		const existing = cacheByCwd.get(key);
		if (existing) return existing;
		const created: AvailabilityCache = {
			latch: createAvailabilityLatch(),
			command: null,
			elapsedMs: 0,
		};
		cacheByCwd.set(key, created);
		return created;
	}

	/** Record a verdict on the cache and emit exactly one decision record. */
	function noteDecision(
		cache: AvailabilityCache,
		resolvedCwd: string,
		verdict: {
			available: boolean;
			outcome: AvailabilityOutcome;
			cause: AvailabilityCause;
			elapsedMs: number;
			hostStallMs?: number;
			/** How the outcome was reached, and the facts behind it (#1500). */
			classifiedBy?: "probe" | "caller" | "joined";
			evidence?: ProbeEvidence;
			/** Probe output of a present binary that failed its version check. */
			rejectedOutput?: string;
		},
	): void {
		cache.elapsedMs = verdict.elapsedMs;
		cache.rejectedOutput = verdict.available
			? undefined
			: verdict.rejectedOutput;
		let retryAfterMs: number | undefined;
		if (verdict.available) {
			cache.latch.noteAvailable(verdict.cause);
		} else {
			cache.command = null;
			const delay = cache.latch.noteUnavailable(verdict.outcome, verdict.cause);
			if (delay > 0) retryAfterMs = delay;
		}
		const latched = verdict.available || isLatchingOutcome(verdict.outcome);
		// Remember the pair whose durable row now says "unavailable and staying
		// that way" — that is the row a later compensating `available` row
		// corrects, and the only thing that makes such a row a correction
		// (#1657).
		if (!verdict.available && latched) {
			noteLatchedUnavailable(resolvedCwd, command);
		} else if (verdict.available) {
			// The latched row this pair carried no longer stands: THIS row says
			// the tool is back. Dropping the record here keeps a stale latch from
			// backing a later "correction" that corrects nothing (#1674 F3).
			clearLatchedUnavailable(resolvedCwd, ...latchKeysFor(command));
		}
		logAvailabilityDecision(
			{
				tool: command,
				verdict: verdict.available ? "available" : "unavailable",
				outcome: verdict.outcome,
				cause: verdict.cause,
				elapsedMs: verdict.elapsedMs,
				latched,
				// Every caller passes this (#2209); a direct key, not a conditional
				// spread, keeps it visible to the call-shaped classifiedBy sweep.
				classifiedBy: verdict.classifiedBy,
				...(verdict.evidence !== undefined && { evidence: verdict.evidence }),
				...(verdict.hostStallMs !== undefined && {
					hostStallMs: verdict.hostStallMs,
				}),
				...(retryAfterMs !== undefined && { retryAfterMs }),
				budgetMs: options.probeTimeout ?? 5000,
			},
			resolvedCwd,
		);
	}

	async function isAvailableAsync(cwd?: string): Promise<boolean> {
		ensureCurrentGeneration();
		const resolvedCwd = cwd || process.cwd();
		const cache = getCache(resolvedCwd);
		// A durable "this machine does not have the tool" stays cached; a
		// transient probe failure only holds until its cooldown expires, so an
		// installed tool cannot be disabled for the life of the process by one
		// slow second at warm-up (#1467). A verdict written under another pi
		// trust answer reads as `null` and is probed again (#4530, #5410): the
		// project venv rung is refused or admitted by trust.
		const answer = cache.latch.read();
		if (answer === false) return false;
		if (answer === true) {
			if (cache.command && (await isSpawnableCommand(cache.command))) {
				return true;
			}
			// Cached-positive spawn feedback: a removed absolute path or vanished
			// PATH command must fall through to a fresh probe immediately.
			cache.latch.reset();
			cache.command = null;
		}

		const key = path.resolve(resolvedCwd);
		const trustGeneration = getProjectTrustGeneration();
		const existing = inFlightByCwd.get(key);
		if (existing?.trustGeneration === trustGeneration) return existing.promise;

		const promiseGeneration = checkerGeneration;
		let promise: Promise<boolean>;
		promise = (async () => {
			const fastPath = await options.fastPath?.();
			if (fastPath) {
				cache.command = fastPath;
				noteDecision(cache, resolvedCwd, {
					available: true,
					outcome: "success",
					cause: "fast-path",
					elapsedMs: 0,
					// Caller-asserted, and justifiably: an on-disk shim IS the tool, so
					// there is no spawn to derive anything from (#1500).
					classifiedBy: "caller",
				});
				return true;
			}

			// A bad/removed workspace must not be mistaken for a missing tool and
			// trigger an install. This async probe stays off the synchronous dispatch
			// burst and makes the failure taxonomy explicit at the seam.
			try {
				const cwdStat = await fs.promises.stat(resolvedCwd);
				if (!cwdStat.isDirectory()) {
					noteDecision(cache, resolvedCwd, {
						available: false,
						outcome: "non-installable",
						cause: "bad-cwd",
						elapsedMs: 0,
						// The workspace is gone. Asserted from a stat, not a probe, and it
						// must never read as "the tool is missing" (#1500).
						classifiedBy: "caller",
					});
					return false;
				}
			} catch {
				noteDecision(cache, resolvedCwd, {
					available: false,
					outcome: "non-installable",
					cause: "bad-cwd",
					elapsedMs: 0,
					classifiedBy: "caller",
				});
				return false;
			}

			// Resolution is measured separately from the spawn (#2140 review F2).
			// It is no longer free — the managed rungs stat two directories and,
			// on a first touch, pay their own verification spawn — and it runs
			// BEFORE `startedAt`, so neither `durationMs` nor
			// `recordAvailabilityProbeOverrun` can see it. Folding it into
			// `durationMs` would instead charge the probe budget for work that
			// budget does not govern, so the two spans are reported side by side.
			const resolveStartedAt = Date.now();
			let resolution = await findCommand(resolvedCwd);
			let resolveMs = Date.now() - resolveStartedAt;
			// A rung whose probe says it is broken for good (missing or
			// non-installable: a stale venv interpreter, a PATH tool whose
			// interpreter is gone) falls through to the next rung, as a managed
			// shim does (#1657, #5437 F1): managed-first, a project shim goes to
			// managed then PATH; path-first, project to PATH to managed. A
			// transient answer stays on its rung and retries. No rung is
			// revisited, so the loop is bounded by the ladder and still writes
			// one verdict and one row.
			for (;;) {
				const cmd = resolution.path;
				// #1995: a command cooling down after a RUNTIME timeout (lint or
				// autofix lane blew its real budget) must not re-probe on every
				// edit - the positive verdict is effectively cooled. Consult-only:
				// probe timeouts do NOT arm the cooldown here, because a single
				// slow --version under host stall (#1467) is transient evidence,
				// and session-long suppression from it would contradict the
				// #1494 retry ladder this classification exists for.
				if (isInSpawnTimeoutCooldown(cmd)) {
					noteDecision(cache, resolvedCwd, {
						available: false,
						outcome: "transient",
						cause: "probe-timeout",
						elapsedMs: 0,
						classifiedBy: "caller",
						evidence: {
							command: cmd,
							status: null,
						},
					});
					return false;
				}
				const env = await options.environment?.(resolvedCwd);
				// The probe budget is enforced by a HOST-side timer, so host event-loop
				// stalls are charged to the child. Measure the stall that overlapped the
				// window and hand it to the classifier (#1467).
				const stallSampler = startHostStallSampler();
				const startedAt = Date.now();
				let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
				let hostStallMs: number;
				let probeJoined = false;
				try {
					const shared = checkerProbeFlights.run(
						`checker:${command}|${versionArgs.join("|")}|${key}|${trustGeneration}|${checkerFlightGeneration}|${windowsExt}|${cmd}|${JSON.stringify(Object.entries(env ?? {}).sort(([a], [b]) => compareOrdinal(a, b)))}`,
						() =>
							// A bare PATH-only probe goes through the cwd-less probe seam
							// (#2894): nothing it answers is read out of a project.
							options.pathOnly
								? probeToolAsync(cmd, versionArgs, {
										timeout: options.probeTimeout ?? 5000,
										...(env !== undefined && { env }),
										input: "",
									})
								: safeSpawnAsync(cmd, versionArgs, {
										timeout: options.probeTimeout ?? 5000,
										cwd: resolvedCwd,
										env,
										input: "",
									}),
					);
					probeJoined = shared.joined;
					result = await shared.promise;
				} finally {
					hostStallMs = stallSampler.stop();
				}
				const elapsedMs = Date.now() - startedAt;
				recordAvailabilityProbeOverrun(
					command,
					resolvedCwd,
					elapsedMs,
					options.probeTimeout ?? 5000,
					result.failure,
				);

				if (!result.error && result.status === 0) {
					cache.command = cmd;
					noteDecision(cache, resolvedCwd, {
						available: true,
						outcome: "success",
						cause: "ok",
						elapsedMs,
						hostStallMs,
						classifiedBy: probeJoined ? "joined" : "probe",
						evidence: {
							...describeProbeEvidence(result),
							...describeManagedResolution(command, resolution),
							resolveMs,
						},
					});
					return true;
				}

				const { outcome, cause, evidence } = classifyProbeFailure(result, {
					hostStallMs,
					unclassifiedFailureOutcome: options.unclassifiedFailureOutcome,
				});
				if (isLatchingOutcome(outcome)) {
					const fallStartedAt = Date.now();
					const next = await nextRung(resolution.rung, resolvedCwd);
					resolveMs += Date.now() - fallStartedAt;
					if (next) {
						resolution = next;
						continue;
					}
				}
				// Only a TYPED tool-not-found invalidates the PATH walk memo; an
				// `unclassifiedFailureOutcome: "missing"` compatibility verdict is a
				// guess, not evidence that PATH changed.
				if (result.spawnFailure?.kind === "tool-not-found") resetPathWalkMemo();
				noteDecision(cache, resolvedCwd, {
					available: false,
					outcome,
					cause,
					elapsedMs,
					hostStallMs,
					classifiedBy: probeJoined ? "joined" : "probe",
					evidence,
					...(cause === "probe-rejected" && {
						rejectedOutput: (result.stderr || result.stdout || "").slice(
							-REJECTED_OUTPUT_CHARS,
						),
					}),
				});
				return false;
			}
		})().finally(() => {
			// A session reset clears this map and a caller may immediately start a
			// replacement probe for the same cwd. The old promise must not delete
			// that newer-generation entry when it settles.
			if (
				checkerGeneration === promiseGeneration &&
				inFlightByCwd.get(key)?.promise === promise
			) {
				inFlightByCwd.delete(key);
			}
		});
		inFlightByCwd.set(key, { trustGeneration, promise });
		return promise;
	}

	function getCommand(cwd?: string): string | null {
		ensureCurrentGeneration();
		const cache = getCache(cwd || process.cwd());
		return cache.command;
	}

	function getOutcome(cwd?: string): AvailabilityOutcome | null {
		ensureCurrentGeneration();
		return getCache(cwd || process.cwd()).latch.getOutcome();
	}

	function getVerdict(cwd?: string): AvailabilityVerdict {
		ensureCurrentGeneration();
		const { latch, elapsedMs, rejectedOutput } = getCache(cwd || process.cwd());
		const outcome = latch.getOutcome();
		return {
			outcome,
			cause: latch.getCause(),
			elapsedMs,
			latched: outcome === null || isLatchingOutcome(outcome),
			retryAtMs: latch.getRetryAtMs(),
			...(rejectedOutput !== undefined && { rejectedOutput }),
		};
	}

	/**
	 * #5258: whether trust refused the project binary this ladder's own project
	 * rung looks up, so a skip states the refusal and not an absence. A ladder
	 * without that rung (PATH only, or no project rung) refused nothing.
	 */
	function projectBinaryRefused(cwd: string): boolean {
		return (
			!options.pathOnly &&
			allowProjectLocal &&
			isLocalBinTrustRefusal(projectRung(cwd))
		);
	}

	return {
		isAvailableAsync,
		getCommand,
		getOutcome,
		getVerdict,
		projectBinaryRefused,
		reset,
	};
}

/** What a `createCwdCachedProbe` probe hands back for classification (#1494). */
export interface CwdProbeResult extends ProbeFailureShape {
	status?: number | null;
}

const cwdProbeFlights = createAvailabilityProbeFlight<CwdProbeResult>({
	generation: getDispatchAvailabilityGeneration,
});

export interface CwdCachedProbeOptions {
	/** Tool name used in the `availability_decision` record. */
	tool: string;
	/** Identity of the resolved probe binary, or a caller-owned freshness token. */
	flightKeyComponent?: string;
	/** Probe budget the verdict was measured against, ms; overruns enter the bounded ledger. */
	budgetMs?: number;
	/** Outcome for a failure the taxonomy cannot classify. Default non-installable. */
	unclassifiedFailureOutcome?: AvailabilityOutcome;
}

export interface CwdCachedProbe {
	(cwd: string): Promise<boolean>;
	/** The last verdict for a cwd, for messaging and telemetry. */
	getVerdict(cwd: string): AvailabilityVerdict;
	reset(): void;
}

/**
 * Per-cwd cached availability probe for spawn signatures that don't fit
 * `createAvailabilityChecker` — multi-arg subcommands like `cargo clippy
 * --version` and `mix credo --version`, or a dynamically-resolved
 * `<cmd> --version` such as eslint's local-then-global binary. Each cwd is
 * probed at most once per verdict; concurrent first-time callers share the
 * in-flight promise.
 *
 * Those three ARE the consumers. `npx biome --version` used to be named here as
 * one and never was: biome resolves through `resolveManagedToolClient` and its
 * own latch in `biome-client.ts`.
 *
 * ## Latch policy (#1494)
 *
 * This used to cache the boolean forever, so one stalled `eslint --version`
 * disabled eslint for that cwd until the process restarted. The verdict now
 * goes through `availability-policy.ts`: the probe returns the SPAWN RESULT,
 * the policy classifies it, and only a durable outcome (`missing` /
 * `non-installable`) latches. A timeout, abort or host stall expires on a
 * bounded cooldown and the next caller re-probes.
 */
export function createCwdCachedProbe(
	probe: (cwd: string) => Promise<CwdProbeResult>,
	options: CwdCachedProbeOptions,
): CwdCachedProbe {
	const latchByCwd = new PathKeyedMap<AvailabilityLatch>(
		normalizeEphemeralMapKey,
	);
	const inFlightByCwd = new PathKeyedMap<Promise<boolean>>(
		normalizeEphemeralMapKey,
	);
	let probeGeneration = availabilityGeneration.current();

	function clear(): void {
		latchByCwd.clear();
		inFlightByCwd.clear();
	}

	function ensureCurrentGeneration(): void {
		if (probeGeneration === availabilityGeneration.current()) return;
		clear();
		probeGeneration = availabilityGeneration.current();
	}

	function latchFor(key: string): AvailabilityLatch {
		const existing = latchByCwd.get(key);
		if (existing) return existing;
		const created = createAvailabilityLatch();
		latchByCwd.set(key, created);
		return created;
	}

	function note(
		latch: AvailabilityLatch,
		key: string,
		verdict: {
			available: boolean;
			outcome: AvailabilityOutcome;
			cause: AvailabilityCause;
			elapsedMs: number;
			hostStallMs: number;
			/** What the spawn returned, for the record's audit trail (#1500). */
			evidence?: ProbeEvidence;
			classifiedBy?: "probe" | "joined";
		},
	): void {
		let retryAfterMs: number | undefined;
		if (verdict.available) {
			latch.noteAvailable(verdict.cause);
		} else {
			const delay = latch.noteUnavailable(verdict.outcome, verdict.cause);
			if (delay > 0) retryAfterMs = delay;
		}
		const latched = verdict.available || isLatchingOutcome(verdict.outcome);
		// Same correction bookkeeping as the checker seam above (#1657).
		if (!verdict.available && latched) {
			noteLatchedUnavailable(key, options.tool);
		} else if (verdict.available) {
			clearLatchedUnavailable(key, ...latchKeysFor(options.tool));
		}
		logAvailabilityDecision(
			{
				tool: options.tool,
				verdict: verdict.available ? "available" : "unavailable",
				outcome: verdict.outcome,
				cause: verdict.cause,
				elapsedMs: verdict.elapsedMs,
				latched,
				hostStallMs: verdict.hostStallMs,
				...(retryAfterMs !== undefined && { retryAfterMs }),
				...(options.budgetMs !== undefined && { budgetMs: options.budgetMs }),
				// Every verdict here is derived from the probe this seam just ran.
				classifiedBy: verdict.classifiedBy ?? "probe",
				...(verdict.evidence !== undefined && { evidence: verdict.evidence }),
			},
			key,
		);
	}

	const run = (cwd: string): Promise<boolean> => {
		ensureCurrentGeneration();
		const key = path.resolve(cwd || process.cwd());
		const latch = latchFor(key);
		const memo = latch.read();
		if (memo !== null) return Promise.resolve(memo);

		const existing = inFlightByCwd.get(key);
		if (existing) return existing;

		const promiseGeneration = probeGeneration;
		let promise: Promise<boolean>;
		promise = (async () => {
			// The probe budget is enforced by a HOST-side timer, so a stalled event
			// loop expires it while the child is still healthy. Measure the stall
			// that overlapped the window and hand it to the classifier (#1467).
			const stallSampler = startHostStallSampler();
			const startedAt = Date.now();
			let result: CwdProbeResult | undefined;
			let thrown: unknown;
			let probeJoined = false;
			try {
				const shared = cwdProbeFlights.run(
					`cwd:${options.tool}|${options.flightKeyComponent ?? ""}|${key}`,
					() => probe(key),
				);
				probeJoined = shared.joined;
				result = await shared.promise;
			} catch (error) {
				thrown = error;
			}
			const hostStallMs = stallSampler.stop();
			const elapsedMs = Date.now() - startedAt;
			const shape: CwdProbeResult = result ?? {
				error: thrown instanceof Error ? thrown : new Error(String(thrown)),
			};
			recordAvailabilityProbeOverrun(
				options.tool,
				key,
				elapsedMs,
				options.budgetMs,
				shape.failure,
			);
			// A probe that threw carries its errno in the Error, which is exactly
			// what the taxonomy reads — so a thrown EAGAIN stays transient instead
			// of collapsing into an untyped `false`.

			if (result && !result.error && result.status === 0) {
				note(latch, key, {
					available: true,
					outcome: "success",
					cause: "ok",
					elapsedMs,
					hostStallMs,
					classifiedBy: probeJoined ? "joined" : "probe",
					evidence: describeProbeEvidence(result, options.tool),
				});
				return true;
			}

			const { outcome, cause, evidence } = classifyProbeFailure(shape, {
				hostStallMs,
				command: options.tool,
				unclassifiedFailureOutcome: options.unclassifiedFailureOutcome,
			});
			note(latch, key, {
				available: false,
				outcome,
				cause,
				elapsedMs,
				hostStallMs,
				classifiedBy: probeJoined ? "joined" : "probe",
				evidence,
			});
			return false;
		})().finally(() => {
			// A session reset clears the map and a caller may immediately start a
			// replacement probe for the same cwd; the old promise must not delete
			// that newer-generation entry when it settles.
			if (
				probeGeneration === promiseGeneration &&
				inFlightByCwd.get(key) === promise
			) {
				inFlightByCwd.delete(key);
			}
		});
		inFlightByCwd.set(key, promise);
		return promise;
	};

	const cached = run as CwdCachedProbe;
	cached.getVerdict = (cwd: string): AvailabilityVerdict => {
		ensureCurrentGeneration();
		const latch = latchFor(path.resolve(cwd || process.cwd()));
		const outcome = latch.getOutcome();
		return {
			outcome,
			cause: latch.getCause(),
			elapsedMs: 0,
			// Read the OUTCOME, never `read()`: `read()` answers `null` both for a
			// cwd that was never probed and for a transient verdict whose cooldown
			// expired, and `!== false` turned both of those into `latched: true` —
			// the opposite of the truth in the expired case.
			latched: outcome !== null && isLatchingOutcome(outcome),
			retryAtMs: latch.getRetryAtMs(),
		};
	};
	cached.reset = (): void => {
		clear();
		probeGeneration = availabilityGeneration.current();
	};
	return cached;
}

export function resolveNodeToolCommand(
	cwd: string,
	toolName: string,
	windowsExt = ".cmd",
): string {
	// THE shared construction seam (#4268 HIGH-1): this used to build
	// `<cwd>/node_modules/.bin/<tool>` itself and return it under ANY trust
	// state, so every runner reaching it executed the project's shim. Routing
	// through the trust-gated lookup means an untrusted project falls through to
	// the bare name (a global/PATH binary), never the project's own.
	const local = localBinPath(findLocalBinAt(toolName, cwd, { windowsExt }));
	if (local) return local;
	return toolName;
}

export function resolveToolCommand(cwd: string, toolId: string): string | null {
	const spec = getToolCommandSpec(toolId);
	if (!spec) return null;
	return resolveNodeToolCommand(cwd, spec.command, spec.windowsExt ?? ".cmd");
}

/**
 * Composer's `vendor/bin/<tool>` from the nearest ancestor that has one.
 *
 * Delegates to THE shared bin walker (#2544 review F1): this was a fifth
 * private copy of that climb, unceilinged, so a `vendor/bin` at or above
 * `$HOME` — which can never be this project's own Composer install — was
 * resolved as the project's tool (#2514, same class as `findInVendorBin`,
 * which had already been folded). Returns the lookup, so a trust refusal
 * stays distinct from an absence (#5258).
 */
export function resolveVendorToolCommand(
	cwd: string,
	toolName: string,
	windowsExt = ".bat",
): LocalBinLookup | null {
	return (
		findLocalBinUpwards(toolName, cwd, {
			windowsExt,
			binDirs: VENDOR_BIN_DIRS,
		}) ?? null
	);
}

type AvailabilityChecker = ReturnType<typeof createAvailabilityChecker>;

/**
 * One checker per registry tool id (#5410), shared by every runner and
 * autofix lane that resolves the tool by id. It holds only per-cwd latches,
 * which the session generation and the trust generation clear.
 */
const toolBinaryCheckers = new Map<string, AvailabilityChecker>();

/**
 * `path-only` is not a ladder order: the bare command on PATH and nothing
 * else, for a caller whose child spawns it by that name (`toolOnPath`).
 */
type ToolBinaryOrder =
	| NonNullable<AvailabilityCheckerOptions["order"]>
	| "path-only";

/**
 * One checker per (tool id, order): a runner (managed before PATH) and a
 * formatter (PATH before managed) can reach different answers for the same
 * tool, so they must not share a cached one (#5492 r2).
 */
function toolBinaryChecker(
	toolId: string,
	order: ToolBinaryOrder,
): AvailabilityChecker | null {
	const key = `${toolId}|${order}`;
	const existing = toolBinaryCheckers.get(key);
	if (existing) return existing;
	const spec = getToolCommandSpec(toolId);
	if (!spec) return null;
	const checker = createAvailabilityChecker(
		spec.command,
		spec.windowsExt ?? "",
		spec.versionArgs ?? ["--version"],
		{
			projectBinDirs: [...VENV_BIN_DIRS, ...NODE_MODULES_BIN_DIRS],
			...(order === "path-only" ? { pathOnly: true } : { order }),
		},
	);
	toolBinaryCheckers.set(key, checker);
	return checker;
}

/**
 * THE tool-binary resolver for a registry tool id (#5410): the project's own
 * venv or `node_modules/.bin` at exactly `cwd` (trust-gated, never an
 * ancestor, #2544 r4 F2), then the managed installs, then PATH, each answer
 * proven by a version probe, the verdict held in the shared latch (#4530), and
 * an install only for a typed `missing` verdict. Runners and autofix lanes
 * call this once; a second probe of their own is the double probe #5410
 * removed.
 */
export async function resolveToolCommandWithInstallFallback(
	cwd: string,
	toolId: string,
): Promise<string | null> {
	const checker = toolBinaryChecker(toolId, "managed-first");
	if (!checker) return null;
	return resolveAvailableOrInstall(
		checker,
		getToolCommandSpec(toolId)?.managedToolId ?? toolId,
		cwd,
	);
}

/**
 * Does `toolId`'s bare command run on PATH right now (#5410)? For a caller
 * that hands the name to a child it does not control, where a project or
 * managed binary is no answer: the LSP launcher starting jdtls asks this of
 * `java`. `true` and `false` are durable (the version probe passed, or the
 * command is absent or rejects it); `undefined` is a probe that never got a
 * fair hearing (timeout, abort, host stall), so the caller must not treat the
 * call as proof the tool is absent. The verdict, its cooldown and the trust
 * stamp are the shared checker's.
 */
export async function toolOnPath(toolId: string): Promise<boolean | undefined> {
	const checker = toolBinaryChecker(toolId, "path-only");
	if (!checker) return false;
	if (await checker.isAvailableAsync()) return true;
	return checker.getOutcome() === "transient" ? undefined : false;
}

/** What a ladder that never probed (or an id with no spec) reports. */
const UNPROBED_VERDICT: AvailabilityVerdict = {
	outcome: null,
	cause: null,
	elapsedMs: 0,
	latched: false,
	retryAtMs: 0,
};

/**
 * What the registry ladder last decided for `toolId` at `cwd`, for a runner
 * that words its own failure from the typed verdict (the helm and trivy
 * passes) instead of returning `toolAbsentSkip`. Reads the checker
 * `resolveToolCommandWithInstallFallback` probed through, so it never triggers
 * a probe of its own; an id with no spec reads as never probed (#5410).
 */
export function toolBinaryVerdict(
	toolId: string,
	cwd: string,
): AvailabilityVerdict {
	return (
		toolBinaryChecker(toolId, "managed-first")?.getVerdict(cwd) ??
		UNPROBED_VERDICT
	);
}

/**
 * What a formatter's lookup of a tool found: the binary, or `null`. When the
 * tool is present but failed its version check and no later rung replaced it,
 * `rejected` carries the probe's bounded output (possibly empty), so the
 * caller can report "present but failed" with its evidence instead of "not
 * found".
 */
export interface InstalledToolResolution {
	command: string | null;
	rejected?: string;
}

/**
 * The formatter ladder without the install (#5410, #5492 r2): the project's
 * own venv or `node_modules/.bin` at exactly `cwd`, then PATH with a version
 * check, then the managed installs. The formatter's version decides the bytes
 * it writes, so a working PATH binary outranks the managed copy; the runners
 * keep managed before PATH in `resolveToolCommandWithInstallFallback`. A
 * formatter calls this where its own install opt-in
 * (`AUTO_INSTALLABLE_DEFAULT_FORMATTERS`) stays a separate decision.
 */
export async function resolveInstalledToolCommand(
	cwd: string,
	toolId: string,
): Promise<InstalledToolResolution> {
	const checker = toolBinaryChecker(toolId, "path-first");
	if (!checker) return { command: null };
	if (await checker.isAvailableAsync(cwd)) {
		return { command: checker.getCommand(cwd) };
	}
	const { cause, rejectedOutput } = checker.getVerdict(cwd);
	return cause === "probe-rejected"
		? { command: null, rejected: rejectedOutput ?? "" }
		: { command: null };
}

async function verifyOrInstallCommand(
	command: string,
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
	onUnusable: (verdict: ToolVerdict) => void = () => {},
): Promise<string | null> {
	// Skip the --version spawn when the command isn't even on disk — the ~μs
	// stat/PATH walk beats a guaranteed-to-fail spawn round-trip.
	const spawnable = await isSpawnableCommand(command);
	if (spawnable) {
		const versionCheck = await safeSpawnAsync(command, versionArgs, {
			timeout,
			cwd,
			input: "",
			cooldown: false,
		});
		if (!versionCheck.error && versionCheck.status === 0) {
			return command;
		}
		// A command that was found but rejected its probe is not fixed by a
		// reinstall. This also covers permissions and malformed shims; a probe
		// that timed out or that trust refused is classified as what it is.
		const { outcome, cause } = classifyProbeFailure(versionCheck, { command });
		onUnusable({ outcome, cause });
		return null;
	}
	if (!shouldAutoInstallTool(toolId)) return null;

	const state = installStateFor(cwd, toolId);
	if (state.suppressed) return null;
	const installStartedAt = Date.now();
	const installed = await ensureTool(toolId);
	if (installed) {
		noteInstallSuccess(toolId, cwd);
		// A latched `unavailable` row MAY stand here, written by whatever probe
		// the caller ran first — but not always. The on-disk pre-check above
		// logs nothing, and the bundler form (rubocop's
		// `resolveCommandArgsWithInstallFallback`) reaches this seam with no
		// checker probe at all (#1657). So the row is
		// emitted either way, and only a call that really clears a latched row is
		// recorded as a correction. Without the row, the durable log keeps saying
		// the tool is off after the installer just brought it back — the third
		// seam of #1606/#1610/#1612 (#1636).
		emitCompensatingAvailableRow(
			cwd,
			toolId,
			installStartedAt,
			installed,
			latchKeysFor(toolId, command),
		);
		return installed;
	}
	noteInstallFailure(toolId, cwd);
	return null;
}

/**
 * The bundler-form resolver (`bundle exec rubocop`): a `--version` spawn of the
 * argv, then the on-disk verify or install of its command. It holds no
 * checker, so a caller that must say why it got `null` reads `onUnusable`: it
 * is called with the verdict of a command that is on disk and failed its
 * probe, and not called for a command that is not on disk, an absence
 * (#5258).
 */
export async function resolveCommandArgsWithInstallFallback(
	command: { cmd: string; args: string[] },
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
	onUnusable?: (verdict: ToolVerdict) => void,
): Promise<{ cmd: string; args: string[] } | null> {
	const versionCheck = await safeSpawnAsync(
		command.cmd,
		[...command.args, ...versionArgs],
		{ timeout, cwd, input: "", cooldown: false },
	);
	if (!versionCheck.error && versionCheck.status === 0) {
		return command;
	}
	const installed = await verifyOrInstallCommand(
		command.cmd,
		toolId,
		cwd,
		versionArgs,
		timeout,
		onUnusable,
	);
	if (!installed) {
		return null;
	}
	if (installed === command.cmd) {
		return command;
	}
	return { cmd: installed, args: [] };
}

async function resolveAvailableOrInstallUnshared(
	checker: {
		isAvailableAsync: (cwd?: string) => Promise<boolean>;
		getCommand: (cwd?: string) => string | null;
		getOutcome?: (cwd?: string) => AvailabilityOutcome | null;
		reset?: () => void;
	},
	toolId: string,
	cwd: string,
): Promise<string | null> {
	const available = await checker.isAvailableAsync(cwd);
	if (available) {
		return checker.getCommand(cwd);
	}
	// Only a typed ENOENT/missing-command result is repairable by installing.
	// Probe failures caused by bad cwd, permissions, rejected flags, aborts, and
	// timeouts are unavailable/non-installable and must not enter an install loop.
	if (checker.getOutcome?.(cwd) !== "missing") return null;
	if (!shouldAutoInstallTool(toolId)) return null;

	const state = installStateFor(cwd, toolId);
	if (state.suppressed) {
		return null;
	}
	const installStartedAt = Date.now();
	const installed = await ensureTool(toolId);
	if (installed) {
		noteInstallSuccess(toolId, cwd);
		checker.reset?.();
		// The PATH probe above already wrote a latched `unavailable` row via
		// `checker.isAvailableAsync`. Without a compensating row here, the durable
		// log keeps saying the tool is off after the installer just brought it
		// back — the shape #1606/PR #1610 fixed in `ensureViaInstaller`, shared
		// here by ~16 runners behind this helper (#1612), and by
		// `verifyOrInstallCommand` for the third seam (#1636).
		//
		// `checker.reset()` above clears the checker's cache, so the NEXT call
		// re-probes PATH from scratch — and for a managed-dir-only install that
		// probe misses again unless `createVenvFinder` finds it first (#1638).
		// Left unguarded, every one of those repeat misses would re-fire this
		// row, claiming a fresh install each time — `emitCompensatingAvailableRow`
		// gates on the once-per-correction memo to prevent that.
		//
		// The probe above returned the latching `missing` outcome, so a latched
		// `unavailable` row stands for this pair right now — recorded under the
		// checker's own command name. Record it under the toolId too, so the
		// emitter can READ that a correction is happening from the same ledger
		// every other caller reads, instead of being told so by an argument
		// (#1674 review F3).
		noteLatchedUnavailable(cwd, toolId);
		// This IS a genuine correction: the probe above returned the latching
		// `missing` outcome, so a latched `unavailable` row stands for this pair
		// right now (#1657).
		emitCompensatingAvailableRow(
			cwd,
			toolId,
			installStartedAt,
			installed,
			latchKeysFor(toolId, checker.getCommand(cwd) ?? undefined),
		);
		return installed;
	}
	noteInstallFailure(toolId, cwd);
	return null;
}

/** Share the complete probe/install transaction for each cwd/tool pair. */
export function resolveAvailableOrInstall(
	checker: {
		isAvailableAsync: (cwd?: string) => Promise<boolean>;
		getCommand: (cwd?: string) => string | null;
		getOutcome?: (cwd?: string) => AvailabilityOutcome | null;
		reset?: () => void;
	},
	toolId: string,
	cwd: string,
): Promise<string | null> {
	const key = normalizeEphemeralMapKey(cwd);
	let byTool = resolveInstallInFlightByCwd.get(key);
	if (!byTool) {
		byTool = new Map();
		resolveInstallInFlightByCwd.set(key, byTool);
	}
	const existing = byTool.get(toolId);
	if (existing) return existing;

	// Same capture-before-await guard as the managed-verify seam, via the same
	// primitive (#1754): a settling old-session transaction must not evict the
	// entry a NEW session already installed for this (cwd, tool).
	const generation = availabilityGeneration.capture();
	const promise = resolveAvailableOrInstallUnshared(
		checker,
		toolId,
		cwd,
	).finally(() => {
		generation.guardedWrite(`${toolId}@${key}`, () => {
			const current = resolveInstallInFlightByCwd.get(key);
			if (current?.get(toolId) === promise) {
				current.delete(toolId);
				if (current.size === 0) resolveInstallInFlightByCwd.delete(key);
			}
		});
	});
	byTool.set(toolId, promise);
	return promise;
}

// =============================================================================
// LOCAL-FIRST BINARY RESOLUTION
// =============================================================================

/**
 * Find a tool binary preferring local node_modules/.bin, then any installed
 * package manager's global bin dir (npm/pnpm/yarn/bun), then global PATH. Only
 * falls back to `npx --no` as a last resort — the universal cache-only exec
 * (npx ships with node and never silently downloads), so this stays
 * manager-agnostic without risking a surprise `dlx` fetch on pnpm/yarn/bun.
 *
 * Returns: { cmd, args } where args may include the `["--no", toolName]` npx
 * preamble.
 */
export async function resolveLocalFirstAsync(
	toolName: string,
	cwd: string,
	windowsExt = ".cmd",
): Promise<{ cmd: string; args: string[] }> {
	// 1. Local node_modules/.bin (project-installed) — through the trust-gated
	//    shared lookup, never a private join (#4268 HIGH-1).
	const local = localBinPath(findLocalBinAt(toolName, cwd, { windowsExt }));
	if (local) return { cmd: local, args: [] };

	// 2. Global bin dir of ANY installed manager (npm/pnpm/yarn/bun) — direct
	//    file lookup, so it finds tools installed via `pnpm add -g` / `bun add -g`
	//    (whose bin dirs are often off PATH) and survives PATH staleness after an
	//    `install -g`. No spawn.
	const globalBin = await findGlobalBinary(toolName, windowsExt);
	if (globalBin) return { cmd: globalBin, args: [] };

	// 3. Global PATH (already installed system-wide, on PATH)
	const globalCheck = await probeToolAsync(toolName, ["--version"], {
		timeout: 3000,
	});
	if (!globalCheck.error && globalCheck.status === 0) {
		return { cmd: toolName, args: [] };
	}

	// 4. npx --no fallback — universal cache-only exec (no silent download)
	return { cmd: "npx", args: ["--no", toolName] };
}

// =============================================================================
// PRE-BUILT CHECKERS FOR COMMON TOOLS
// =============================================================================

export const pyright = createAvailabilityChecker("pyright", ".exe");
export const ruff = createAvailabilityChecker("ruff", ".exe");
export const biome = createAvailabilityChecker("biome");

/** Shared cwd seam for runner probes and analysis children (#2777). */
export function resolveRunnerCwd(ctx: DispatchContext, tool: string): string {
	return resolveToolCwd("runner", tool, ctx.filePath, ctx).cwd;
}
