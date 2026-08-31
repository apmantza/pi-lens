/**
 * LSP Server Definitions for pi-lens
 *
 * Defines 40+ language servers with:
 * - Root detection (monorepo support)
 * - Auto-installation strategies
 * - Platform-specific handling
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	getGlobalPiLensDir,
	getProjectIgnoreGlobs,
	isPathIgnoredByProject,
} from "../file-utils.js";
import {
	augmentPythonEnvironment,
	detectPythonEnvironment,
	detectPythonVenv,
	pythonEnvironmentToolCandidates,
} from "../python-environment.js";

export { detectPythonVenv };
import { STAGE_TMP_PATTERN } from "../atomic-write-staging.js";
import {
	DOTNET_CSHARP_ROOT_MARKERS,
	DOTNET_FSHARP_ROOT_MARKERS,
	KIND_EXTENSIONS,
} from "../file-kinds.js";
import {
	direntsHaveMarkerGlobMatch,
	isAtOrAboveHomeDir,
	isFullyQualified,
	isWindowsPath,
	pathsEqual,
} from "../path-utils.js";
import {
	ensureTool,
	findManagedToolBinary,
	getToolEnvironment,
	getToolPath,
} from "../installer/index.js";
import * as installer from "../installer/index.js";
import {
	classifyProbeFailure,
	describeInstallAttempt,
	logAvailabilityDecision,
} from "../dispatch/runners/utils/availability-policy.js";
import { resolveOpengrepConfig } from "../opengrep-config.js";
import {
	isZizmorAuditTarget,
	resolveZizmorGitHubToken,
} from "../zizmor-config.js";
import { logLatency } from "../latency-logger.js";
import { logSessionStart } from "../sessionstart-logger.js";
import { findLocalSgconfig, resolveBaselineSgconfig } from "../sgconfig.js";
import { findLocalTyposConfig } from "../typos-config.js";
import { resolvePackagePath } from "../package-root.js";
import { resolveAstGrepNativeExe } from "./wait-policy/index.js";
import {
	hasSpawnFailureKind,
	isCommandAvailableAsync,
	safeSpawnAsync,
} from "../safe-spawn.js";
import { type LSPProcess, launchLSP } from "./launch.js";
import { createLombokJdtlsArgs } from "./lombok.js";
import { resolveJavaRuntimeEnv } from "./jvm-runtime.js";
import { normalizeMapKey } from "./path-utils.js";
import { getRubyVersionDirNamesSync } from "./ruby-drive-dirs.js";
import { getProcessSingleton } from "../process-singletons.js";
import {
	createGenerationSource,
	type GenerationHandle,
} from "../generation-guard.js";

// --- Types ---

export type RootFunction = (file: string) => Promise<string | undefined>;

const FIXTURE_ROOT_SEGMENTS = new Set(["__fixtures__", "testdata"]);
const FALLBACK_PROJECT_MARKERS = [
	".git",
	"package.json",
	"go.work",
	"go.mod",
	"Cargo.toml",
	"pyproject.toml",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"mix.exs",
	"pubspec.yaml",
	"Package.swift",
] as const;

/**
 * Markers that make a nested root an independently hosted project rather than
 * a config-only directory that should share an ancestor's LSP client.
 */
const PROJECT_BOUNDARY_MARKERS = [
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"go.work",
	"go.mod",
	"Cargo.toml",
	"Cargo.lock",
	"pyproject.toml",
	"uv.lock",
	"poetry.lock",
	"Pipfile",
	"Pipfile.lock",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"settings.gradle.kts",
	"mix.exs",
	"pubspec.yaml",
	"Package.swift",
] as const;

// This is process-global state, so each candidate pair is logged once per
// process (not once per session). Keep the root-boundary marker below aligned
// with FALLBACK_PROJECT_MARKERS, the shared fallback root-policy marker set.
const loggedRootCeilingClamps = new Set<string>();
const posixCaseInsensitiveByPath = new Map<string, boolean>();

export type IsSameOrWithinDeps = {
	caseInsensitiveProbe?: (root: string) => boolean;
};

function posixFilesystemIsCaseInsensitive(root: string): boolean {
	const resolved = path.resolve(root);
	const cached = posixCaseInsensitiveByPath.get(resolved);
	if (cached !== undefined) return cached;
	if (!existsSync(resolved)) {
		return false;
	}
	const name = path.basename(resolved);
	const alternate =
		name.toLowerCase() === name ? name.toUpperCase() : name.toLowerCase();
	let insensitive = false;
	const alternatePath = path.join(path.dirname(resolved), alternate);
	if (alternate !== name && existsSync(alternatePath)) {
		try {
			const actual = statSync(resolved);
			const alternateStat = statSync(alternatePath);
			insensitive =
				actual.dev === alternateStat.dev && actual.ino === alternateStat.ino;
		} catch {
			insensitive = false;
		}
	}
	posixCaseInsensitiveByPath.set(resolved, insensitive);
	return insensitive;
}

export function resetLSPCaseSensitivityState(): void {
	posixCaseInsensitiveByPath.clear();
}

export function _getPosixCaseSensitivityCacheSizeForTests(): number {
	return posixCaseInsensitiveByPath.size;
}

/**
 * Path-shape-aware containment test: is `candidate` the same path as
 * `ancestor`, or inside it?
 *
 * Exported so the session-cwd registry (`clients/lsp/config.ts`) and the
 * foreign-root decline gate (`clients/lsp/index.ts`) test containment with the
 * SAME comparator the root ceiling uses. A second hand-rolled `path.relative`
 * helper alongside this one is how the two drift apart on Windows-shaped
 * paths (shape 2 / #1150): `path.isAbsolute("C:\\repo")` is false on POSIX, so
 * a host-default comparator silently mis-answers a win32 path on Linux CI.
 */
export function isSameOrWithin(
	ancestor: string,
	candidate: string,
	deps: IsSameOrWithinDeps = {},
): boolean {
	const windowsShaped = isWindowsPath(ancestor) || isWindowsPath(candidate);
	const pathApi = windowsShaped ? path.win32 : path;
	const resolvedAncestor = pathApi.resolve(ancestor);
	const resolvedCandidate = pathApi.resolve(candidate);
	let caseInsensitive = false;
	if (!windowsShaped) {
		if (deps.caseInsensitiveProbe) {
			const cached = posixCaseInsensitiveByPath.get(resolvedAncestor);
			caseInsensitive = cached ?? deps.caseInsensitiveProbe(resolvedAncestor);
			if (cached === undefined) {
				posixCaseInsensitiveByPath.set(resolvedAncestor, caseInsensitive);
			}
		} else {
			caseInsensitive = posixFilesystemIsCaseInsensitive(resolvedAncestor);
		}
	}
	const relative = pathApi.relative(
		caseInsensitive ? resolvedAncestor.toLowerCase() : resolvedAncestor,
		caseInsensitive ? resolvedCandidate.toLowerCase() : resolvedCandidate,
	);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !pathApi.isAbsolute(relative))
	);
}

/** Enforce the session cwd as the hard boundary for LSP client root selection. */
export function enforceLspRootCeiling(
	root: string,
	sessionCwd: string,
	filePath?: string,
): string {
	const windowsShaped = isWindowsPath(root) || isWindowsPath(sessionCwd);
	const pathApi = windowsShaped ? path.win32 : path;
	const resolvedRoot = pathApi.resolve(root);
	const resolvedCwd = pathApi.resolve(sessionCwd);
	// Callers may explicitly inspect an out-of-session file (notably isolated
	// tests and API consumers). The cwd ceiling governs roots for files that are
	// actually inside the declared session project.
	if (filePath && !isSameOrWithin(resolvedCwd, pathApi.resolve(filePath))) {
		return resolvedRoot;
	}
	if (isSameOrWithin(resolvedCwd, resolvedRoot)) return resolvedRoot;

	const logKey = `${normalizeMapKey(resolvedCwd)}:${normalizeMapKey(resolvedRoot)}`;
	if (!loggedRootCeilingClamps.has(logKey)) {
		loggedRootCeilingClamps.add(logKey);
		logSessionStart(
			`lsp root clamped to session cwd: candidate=${resolvedRoot} cwd=${resolvedCwd}`,
		);
	}
	return resolvedCwd;
}

export async function hasProjectBoundaryMarker(dir: string): Promise<boolean> {
	// A nested Git checkout is an independently hosted project even when it has
	// no language manifest. Keep this directory boundary aligned with the shared
	// FALLBACK_PROJECT_MARKERS policy used by nearestNonExcludedFallbackRoot.
	if (await markerExists(dir, ".git")) return true;
	for (const marker of PROJECT_BOUNDARY_MARKERS) {
		if (await markerExists(dir, marker)) return true;
	}
	return false;
}

function pathSegments(dir: string): string[] {
	const parsed = path.parse(path.resolve(dir));
	return path
		.relative(parsed.root, path.resolve(dir))
		.split(path.sep)
		.filter(Boolean)
		.map((segment) => segment.toLowerCase());
}

function hasFixtureConvention(dir: string): boolean {
	const segments = pathSegments(dir);
	// Go treats any directory named testdata as fixture data by convention. The
	// exclusion is intentionally ancestor-wide so nested fixture projects cannot
	// become independent LSP roots, but the segment match itself stays exact.
	if (segments.some((segment) => FIXTURE_ROOT_SEGMENTS.has(segment)))
		return true;
	return segments.some(
		(segment, index) =>
			segment === "tests" && segments[index + 1] === "fixtures",
	);
}

function hasAtomicStageSegment(dir: string): boolean {
	return pathSegments(dir).some((segment) => STAGE_TMP_PATTERN.test(segment));
}

async function findGitBoundary(dir: string): Promise<string | undefined> {
	let current = path.resolve(dir);
	const fsRoot = path.parse(current).root;
	while (true) {
		if (await markerExists(current, ".git")) return current;
		if (current === fsRoot) return undefined;
		current = path.dirname(current);
	}
}

async function isExcludedLspRoot(dir: string): Promise<boolean> {
	const candidate = path.resolve(dir);
	if (hasFixtureConvention(candidate) || hasAtomicStageSegment(candidate))
		return true;
	const gitRoot = await findGitBoundary(candidate);
	if (!gitRoot || gitRoot === candidate) return false;
	// Avoid constructing the matcher when the project has no positive ignore rules.
	// The matcher remains authoritative (including anchored rules and directory form).
	if (getProjectIgnoreGlobs(gitRoot).length === 0) return false;
	return isPathIgnoredByProject(candidate, gitRoot, true);
}

async function nearestNonExcludedFallbackRoot(
	candidate: string,
): Promise<string> {
	if (!(await isExcludedLspRoot(candidate))) return path.resolve(candidate);
	let current = path.dirname(path.resolve(candidate));
	const fsRoot = path.parse(current).root;
	let nearestAllowed: string | undefined;
	while (true) {
		if (!(await isExcludedLspRoot(current))) {
			nearestAllowed ??= current;
			for (const marker of FALLBACK_PROJECT_MARKERS) {
				if (await markerExists(current, marker)) return current;
			}
		}
		if (current === fsRoot) break;
		current = path.dirname(current);
	}
	// No project marker was available. Keep the file attached to a stable,
	// non-excluded ancestor rather than minting a client inside the fixture/stage.
	return nearestAllowed ?? fsRoot;
}

export interface LSPSpawnOptions {
	allowInstall?: boolean;
}

export interface LSPServerInfo {
	id: string;
	name: string;
	extensions: readonly string[];
	root: RootFunction;
	/**
	 * "language" (default) = the file's primary language server (one is chosen per
	 * file). "auxiliary" = a cross-cutting, diagnostic-only server (security,
	 * spelling, …) that attaches across many languages and runs ALONGSIDE the
	 * primary — never selected as primary, collected only on the with-auxiliary
	 * diagnostics path. See clients/dispatch/auxiliary-lsp.ts.
	 */
	role?: "language" | "auxiliary";
	/**
	 * ID of the preferred language server this server backs up. Primary selection
	 * already tries language servers in registry order; this marker prevents an
	 * aggregate `clientScope: "all"` diagnostics pass from launching the fallback
	 * alongside a working preferred server.
	 */
	fallbackFor?: string;
	/** Simple command name whose absence disables spawn attempts briefly across roots. */
	availabilityKey?: string;
	/**
	 * Optional extra candidacy gate beyond `extensions`. When present, a file
	 * must ALSO satisfy this predicate to be a candidate server for it — for a
	 * server whose extension match is necessarily broader than what it can
	 * actually do useful work on (e.g. zizmor attaches to the "yaml" extension
	 * set but only ever reports on GitHub Actions workflow/action/dependabot
	 * paths, #636). Keeps a guaranteed-no-op file out of the candidate list
	 * entirely — no spawn, no notify, no diagnostics-wait budget spent.
	 */
	pathFilter?: (filePath: string) => boolean;
	/**
	 * Optional per-server initialize timeout.
	 * Useful for servers like Ruby LSP that do real project bootstrap work
	 * before they can answer initialize.
	 */
	initializeTimeoutMs?: number;
	/**
	 * Optional per-server wait budget for navigation requests that need a client
	 * to become ready first.
	 */
	clientWaitTimeoutMs?: number;
	/**
	 * #1714: how many document notifies this AUXILIARY server may hold
	 * unacknowledged before the next notify has to prove the server drained its
	 * input (`awaitAuxNotifyDrain`, clients/lsp/index.ts). Ignored for primaries —
	 * they serve one file per touch and are not the fan-out target a project
	 * sweep floods.
	 *
	 * Omit to take the shared auxiliary default. Set it only for a server class
	 * with evidence of a lower ceiling.
	 */
	notifyInflightLimit?: number;
	/**
	 * Server recomputes/pushes dependent-file diagnostics after primary file changes.
	 * Cascade can read its passive snapshot instead of actively touching neighbors.
	 */
	autoPropagateDiagnostics?: boolean;
	spawn(
		root: string,
		options?: LSPSpawnOptions,
	): Promise<
		| {
				process: LSPProcess;
				initialization?: Record<string, unknown>;
				source?: "direct" | "managed" | "package-manager" | "interactive";
				/**
				 * Which concrete binary/protocol variant was launched for this server
				 * id, when a single `LSPServerInfo.id` can mean more than one actual
				 * server (e.g. "typescript" = classic typescript-language-server OR
				 * TS7's native `tsc --lsp --stdio`). Per-server behavioral knowledge
				 * keyed by server id (`wait-policy/strategies.ts`'s `silentOnClean` etc.)
				 * is only proven for the variant it was measured against — this lets
				 * such knowledge-consumers (the #458 cascade tier classifier) tell
				 * the variants apart. Undefined = single-variant server, or a
				 * variant-carrying server that hasn't been updated to report one yet;
				 * treat as the classic/default behavior (fail-safe).
				 */
				launchVariant?: "classic" | "native-ts7";
		  }
		| undefined
	>;
	autoInstall?: () => Promise<boolean>;
}

function isLspInstallDisabled(): boolean {
	return process.env.PI_LENS_DISABLE_LSP_INSTALL === "1";
}

function canInstall(allowInstall?: boolean): boolean {
	return allowInstall !== false && !isLspInstallDisabled();
}

const DIRECT_LSP_NEGATIVE_TTL_MS = Math.max(
	30_000,
	Number.parseInt(
		process.env.PI_LENS_DIRECT_LSP_NEGATIVE_TTL_MS ?? "600000",
		10,
	) || 600_000,
);
const directLspCommandUnavailableUntil = new Map<string, number>();
const directLspCommandSkipLoggedUntil = new Map<string, number>();

// Availability rows are emitted from the same async launch path that owns the
// live LSP generation. A session reset can retire that generation while a
// managed lookup, install, or launch is still awaiting; stale work must not
// publish into the replacement session (#2351, shape 22).
const lspLaunchAvailabilityGeneration = createGenerationSource(
	"lsp-launch-availability",
);

export function resetLspLaunchAvailabilityGeneration(): void {
	lspLaunchAvailabilityGeneration.bump();
}

function staleLaunch(
	generation: GenerationHandle,
	subject: string,
	proc?: LSPProcess,
): boolean {
	if (generation.isCurrent()) return false;
	try {
		proc?.process?.kill();
	} catch {
		// Best-effort cleanup for a process returned after service retirement.
	}
	generation.guardedWrite(subject, () => undefined);
	return true;
}

async function installEvidenceForLaunch(
	toolId: string,
	installed: string,
	attempt: Parameters<typeof describeInstallAttempt>[0],
): Promise<Record<string, unknown>> {
	const evidence = describeInstallAttempt(attempt);
	const confirmedManagedPath = await findManagedToolBinary(toolId);
	return {
		...evidence,
		binary: path.basename(installed),
		...(confirmedManagedPath !== undefined &&
			pathsEqual(confirmedManagedPath, installed) && {
				source: "managed-dir",
			}),
	};
}

function captureInstallAttempt(
	toolId: string,
): Parameters<typeof describeInstallAttempt>[0] {
	try {
		// Capture synchronously after ensureTool resolves. Reading this later, after
		// launch/evidence awaits, can observe another concurrent ensure's outcome.
		return installer.getInstallAttempt?.(toolId);
	} catch {
		// Older test doubles do not expose this production export.
	}
	return undefined;
}

/** Re-arm direct-command availability for the next session. */
export function resetDirectLspCommandAvailability(): void {
	directLspCommandUnavailableUntil.clear();
	directLspCommandSkipLoggedUntil.clear();
}

/** Test seam for seeding the real negative-cache path. */
export function _markDirectLspCommandUnavailableForTests(
	command: string,
): void {
	markDirectLspCommandUnavailable(command);
}

function pruneExpiredDirectLspNegativeEntries(now = Date.now()): void {
	for (const [command, until] of directLspCommandUnavailableUntil) {
		if (until <= now) {
			directLspCommandUnavailableUntil.delete(command);
			directLspCommandSkipLoggedUntil.delete(command);
		}
	}
	for (const [command, until] of directLspCommandSkipLoggedUntil) {
		if (until <= now) directLspCommandSkipLoggedUntil.delete(command);
	}
}

function isSimpleCommand(command: string): boolean {
	return (
		!isFullyQualified(command) &&
		!command.includes("/") &&
		!command.includes("\\")
	);
}

export function isDirectLspCommandTemporarilyUnavailable(
	command: string,
): boolean {
	const now = Date.now();
	pruneExpiredDirectLspNegativeEntries(now);
	const until = directLspCommandUnavailableUntil.get(command);
	if (!until || until <= now) {
		directLspCommandUnavailableUntil.delete(command);
		return false;
	}
	const loggedUntil = directLspCommandSkipLoggedUntil.get(command) ?? 0;
	if (loggedUntil <= now) {
		logSessionStart(
			`lsp direct command ${command}: skipped by negative availability cache (${Math.max(0, until - now)}ms remaining)`,
		);
		directLspCommandSkipLoggedUntil.set(command, until);
	}
	return true;
}

function markDirectLspCommandUnavailable(command: string): void {
	if (!isSimpleCommand(command)) return;
	directLspCommandUnavailableUntil.set(
		command,
		Date.now() + DIRECT_LSP_NEGATIVE_TTL_MS,
	);
	directLspCommandSkipLoggedUntil.delete(command);
}

const PI_LENS_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");

// ---------------------------------------------------------------------------
// Unified binary resolution + launch
// ---------------------------------------------------------------------------
//
// Replaces the four ad-hoc patterns (launchWithDirectOrPackageManager,
// spawnWithInteractiveInstall, manual ensureTool chains, installPolicy enum).
//
// Resolution chain (first match wins):
//   1. Explicit candidates (project node_modules, full paths)
//   2. System PATH (bare command name)
//   3. ensureTool() — managed npm/pip install via installer registry
//   4. runtimeInstall — language-native install (go install, gem install, …)
//   5. [future] github — platform binary download
//
// All steps are silent and gated by canInstall(). Returns undefined if no
// binary can be found or installed.

export interface ResolveAndLaunchSpec {
	/** Ordered list of full paths / bare commands to try first */
	candidates: string[];
	/** LSP args to pass on launch */
	args: string[];
	/** Working directory */
	cwd: string;
	/** Optional env overrides */
	env?: NodeJS.ProcessEnv;
	/** installer tool ID — checked/installed via ensureTool() */
	managedToolId?: string;
	/** Runtime install: check this command is on PATH, then run installer */
	runtimeInstall?: {
		runtimeCommand: string;
		install: () => Promise<boolean>;
		/** After a successful install, retry these candidates (defaults to spec.candidates) */
		retryCandidates?: string[];
	};
}

export async function resolveAndLaunch(
	spec: ResolveAndLaunchSpec,
	allowInstall: boolean | undefined,
): Promise<
	| { process: LSPProcess; source: "direct" | "managed" | "package-manager" }
	| undefined
> {
	const generation = lspLaunchAvailabilityGeneration.capture();
	const toolLabel =
		spec.managedToolId ??
		spec.candidates[spec.candidates.length - 1] ??
		"unknown";
	let lastRuntimeFailure: Error | undefined;
	const trackRuntimeFailure = (err: unknown): void => {
		const message = err instanceof Error ? err.message : String(err);
		if (!hasSpawnFailureKind(err, "tool-not-found")) {
			lastRuntimeFailure = err instanceof Error ? err : new Error(message);
		}
	};

	// #2140: consult the release-managed binary directory (~/.pi-lens/bin)
	// BEFORE the bare-PATH candidates below. A bare `candidates: ["opengrep"]`
	// entry only ever resolves through the OS's own PATH lookup — never that
	// directory — so a github/maven/archive-strategy tool installed there with
	// no PATH entry ENOENTs every direct candidate first, only to have the
	// managed-install step further down find the very same binary a few
	// hundred ms later. `findManagedToolBinary` does a bare `fs.access`, no
	// spawn, so this costs at most a few stat calls per server launch attempt
	// (not per file/dispatch — launches are session-scoped). Mirrors
	// `findManagedNodeToolBinary`'s npm-managed fast path (runner-helpers.ts)
	// and `SecurityScanClient.probeVersion`'s equivalent fix for the CLI-scan
	// half of this same issue (#2140, landed in PR #2148/#2137).
	const managedProbeStartedAt = Date.now();
	const managedCandidate = spec.managedToolId
		? await findManagedToolBinary(spec.managedToolId)
		: undefined;
	if (staleLaunch(generation, `${toolLabel}:findManagedToolBinary`)) {
		return undefined;
	}
	const candidates =
		managedCandidate && !spec.candidates.includes(managedCandidate)
			? [managedCandidate, ...spec.candidates]
			: spec.candidates;

	// A candidate that fails while a LATER candidate (or managed install)
	// succeeds is just fallback, not a failure — logging each immediately floods
	// the logs with scary "candidate failed / npm shim failed / Run npm install"
	// lines that read as smells even though the launch succeeded. Collect them and
	// surface only if ALL direct candidates fail.
	const candidateFailures: Array<{
		index: number;
		command: string;
		message: string;
		err: unknown;
	}> = [];

	// Step 1 & 2 — try all explicit candidates (includes bare command = PATH lookup)
	for (const [index, command] of candidates.entries()) {
		logLatency({
			type: "phase",
			phase: "lsp_launch_candidate_attempt",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: toolLabel,
				command,
				index,
				totalCandidates: candidates.length,
				allowInstall: canInstall(allowInstall),
			},
		});
		logSessionStart(
			`lsp launch candidate attempt tool=${toolLabel} idx=${index}/${candidates.length - 1} command=${command} cwd=${spec.cwd}`,
		);
		try {
			const proc = await launchLSP(command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
			});
			if (staleLaunch(generation, `${toolLabel}:launchLSP:${command}`, proc)) {
				return undefined;
			}
			logLatency({
				type: "phase",
				phase: "lsp_launch_candidate_success",
				filePath: spec.cwd,
				durationMs: 0,
				metadata: {
					tool: toolLabel,
					command,
					index,
					source: "direct",
				},
			});
			logSessionStart(
				`lsp launch candidate success tool=${toolLabel} idx=${index} command=${command} source=direct`,
			);
			// The managed-dir fast path (#2140) IS the availability probe for a
			// release-managed tool: a real spawn just confirmed the binary
			// findManagedToolBinary resolved actually launches. Gated on the exact
			// managed candidate (never a later bare-PATH fallback), so a session
			// start with the binary present emits exactly one decision and a
			// developer-PATH-resolved copy (no managed binary at all) emits none —
			// unchanged from before this fix.
			if (managedCandidate !== undefined && command === managedCandidate) {
				logAvailabilityDecision({
					tool: toolLabel,
					verdict: "available",
					outcome: "success",
					cause: "ok",
					elapsedMs: Date.now() - managedProbeStartedAt,
					latched: false,
					producer: "lsp-launch",
					classifiedBy: "probe",
					evidence: {
						binary: path.basename(managedCandidate),
						source: "managed-dir",
						correctsLatchedRow: false,
					},
				});
			}
			return { process: proc, source: "direct" };
		} catch (err) {
			if (staleLaunch(generation, `${toolLabel}:launchLSP:${command}`)) {
				return undefined;
			}
			const message = err instanceof Error ? err.message : String(err);
			// Defer logging: only a failure if no later candidate/install succeeds.
			candidateFailures.push({ index, command, message, err });
			// try next
		}
	}

	// All direct candidates failed (a successful one returns above). Surface the
	// deferred failures now so the all-failed case stays fully diagnosable.
	for (const failure of candidateFailures) {
		logLatency({
			type: "phase",
			phase: "lsp_launch_candidate_failed",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: toolLabel,
				command: failure.command,
				index: failure.index,
				error: failure.message,
			},
		});
		logSessionStart(
			`lsp launch candidate failed tool=${toolLabel} idx=${failure.index} command=${failure.command} error=${failure.message}`,
		);
		trackRuntimeFailure(failure.err);
	}
	const hasOnlyRepairableCandidateFailures = candidateFailures.every(
		(failure) => hasSpawnFailureKind(failure.err, "tool-not-found"),
	);
	if (!hasOnlyRepairableCandidateFailures) {
		if (lastRuntimeFailure) throw lastRuntimeFailure;
		return undefined;
	}

	if (!canInstall(allowInstall)) {
		logSessionStart(
			`lsp launch install blocked tool=${toolLabel} cwd=${spec.cwd} allowInstall=${allowInstall !== false} globalDisabled=${isLspInstallDisabled()}`,
		);
		logLatency({
			type: "phase",
			phase: "lsp_launch_install_blocked",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: toolLabel,
				allowInstall,
				globalInstallDisabled: isLspInstallDisabled(),
			},
		});
		return undefined;
	}

	// Step 3 — managed install via installer registry
	if (spec.managedToolId) {
		// Neither the managed-dir stat (#2140) nor any bare-PATH candidate
		// resolved this tool — the negative counterpart to the fast-path
		// "available" decision above, mirroring `SecurityScanClient.probeVersion`'s
		// failure record so the negative case is visible in latency.log rather
		// than swallowed by going straight to the install attempt.
		const failedCandidate = candidateFailures.at(-1);
		const classifiedFailure = classifyProbeFailure(
			{
				error:
					failedCandidate?.err instanceof Error
						? failedCandidate.err
						: undefined,
				spawnFailure: {
					kind: hasSpawnFailureKind(failedCandidate?.err, "tool-not-found")
						? "tool-not-found"
						: undefined,
				},
			},
			{ command: failedCandidate?.command },
		);
		logAvailabilityDecision({
			tool: spec.managedToolId,
			verdict: "unavailable",
			outcome: classifiedFailure.outcome,
			cause: classifiedFailure.cause,
			elapsedMs: Date.now() - managedProbeStartedAt,
			latched: false,
			classifiedBy: "probe",
			producer: "lsp-launch",
			evidence: classifiedFailure.evidence,
		});
		logSessionStart(
			`lsp launch ensure-tool start tool=${spec.managedToolId} cwd=${spec.cwd}`,
		);
		const installStartedAt = Date.now();
		const installed = await ensureTool(spec.managedToolId);
		const installAttempt = captureInstallAttempt(spec.managedToolId);
		if (staleLaunch(generation, `${toolLabel}:ensureTool`)) {
			return undefined;
		}
		logSessionStart(
			`lsp launch ensure-tool result tool=${spec.managedToolId} installed=${installed ? "yes" : "no"} path=${installed ?? ""}`,
		);
		logLatency({
			type: "phase",
			phase: "lsp_launch_ensure_tool_result",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: spec.managedToolId,
				installed: Boolean(installed),
				path: installed,
			},
		});
		if (installed) {
			try {
				const proc = await launchLSP(installed, spec.args, {
					cwd: spec.cwd,
					env: spec.env,
				});
				if (staleLaunch(generation, `${toolLabel}:launchLSP:managed`, proc)) {
					return undefined;
				}
				logSessionStart(
					`lsp launch managed success tool=${spec.managedToolId} command=${installed} source=managed`,
				);
				logLatency({
					type: "phase",
					phase: "lsp_launch_managed_success",
					filePath: spec.cwd,
					durationMs: 0,
					metadata: {
						tool: spec.managedToolId,
						command: installed,
					},
				});
				// Compensating row for the "unavailable" decision logged above (#1606
				// shape): the install fixed exactly what the fast path found missing,
				// so the durable record must not be left saying the tool is off.
				// `source` is only asserted when a fresh managed-dir lookup confirms
				// the install actually landed in ~/.pi-lens/bin (github/maven/archive
				// strategies) rather than an npm/pip/gem install elsewhere, so the
				// evidence never claims a resolution this call didn't derive.
				const evidence = await installEvidenceForLaunch(
					spec.managedToolId,
					installed,
					installAttempt,
				);
				if (staleLaunch(generation, `${toolLabel}:managed-evidence`, proc)) {
					return undefined;
				}
				logAvailabilityDecision({
					tool: spec.managedToolId,
					verdict: "available",
					outcome: "success",
					cause: "ok",
					elapsedMs: Date.now() - installStartedAt,
					latched: false,
					classifiedBy: "caller",
					producer: "lsp-launch",
					evidence: {
						...evidence,
						correctsLatchedRow: false,
					},
				});
				return { process: proc, source: "managed" };
			} catch (err) {
				if (
					staleLaunch(generation, `${toolLabel}:launchLSP:managed-rejection`)
				) {
					return undefined;
				}
				const message = err instanceof Error ? err.message : String(err);
				logSessionStart(
					`lsp launch managed failed tool=${spec.managedToolId} command=${installed} error=${message}`,
				);
				logLatency({
					type: "phase",
					phase: "lsp_launch_managed_failed",
					filePath: spec.cwd,
					durationMs: 0,
					metadata: {
						tool: spec.managedToolId,
						command: installed,
						error: message,
					},
				});
				trackRuntimeFailure(err);

				// force-reinstall: when a PATH-resolved tool (bare command name)
				// fails to launch (e.g. broken symlink, missing .dll), nuke the
				// caches and download a managed copy from the registry.
				const looksPathResolved =
					!installed.includes("/") && !installed.includes("\\");
				if (looksPathResolved && hasSpawnFailureKind(err, "tool-not-found")) {
					logSessionStart(
						`lsp launch managed retry force-reinstall tool=${spec.managedToolId}`,
					);
					const reinstalled = await ensureTool(spec.managedToolId, {
						forceReinstall: true,
					});
					const reinstallAttempt = captureInstallAttempt(spec.managedToolId);
					if (staleLaunch(generation, `${toolLabel}:forceReinstall`)) {
						return undefined;
					}
					if (reinstalled) {
						try {
							const proc = await launchLSP(reinstalled, spec.args, {
								cwd: spec.cwd,
								env: spec.env,
							});
							if (
								staleLaunch(
									generation,
									`${toolLabel}:launchLSP:forceReinstall`,
									proc,
								)
							) {
								return undefined;
							}
							logSessionStart(
								`lsp launch managed force-reinstall success tool=${spec.managedToolId} command=${reinstalled}`,
							);
							logLatency({
								type: "phase",
								phase: "lsp_launch_managed_force_reinstall_success",
								filePath: spec.cwd,
								durationMs: 0,
								metadata: {
									tool: spec.managedToolId,
									command: reinstalled,
								},
							});
							const evidence = await installEvidenceForLaunch(
								spec.managedToolId,
								reinstalled,
								reinstallAttempt,
							);
							if (
								staleLaunch(
									generation,
									`${toolLabel}:forceReinstall-evidence`,
									proc,
								)
							) {
								return undefined;
							}
							logAvailabilityDecision({
								tool: spec.managedToolId,
								verdict: "available",
								outcome: "success",
								cause: "ok",
								elapsedMs: Date.now() - installStartedAt,
								latched: false,
								classifiedBy: "caller",
								producer: "lsp-launch",
								evidence: {
									...evidence,
									correctsLatchedRow: false,
								},
							});
							return { process: proc, source: "managed" };
						} catch (retryErr) {
							logSessionStart(
								`lsp launch managed force-reinstall failed tool=${spec.managedToolId} error=${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
							);
						}
					}
				}
				// fall through
			}
		}
	}

	// Step 4 — language-native runtime install (go install, gem install, …)
	const runtimeInstall = spec.runtimeInstall;
	const runtimeAvailable = runtimeInstall
		? await isOnPath(runtimeInstall.runtimeCommand)
		: false;
	if (staleLaunch(generation, `${toolLabel}:runtimeAvailability`)) {
		return undefined;
	}
	if (runtimeInstall && runtimeAvailable) {
		const ok = await runtimeInstall.install();
		if (staleLaunch(generation, `${toolLabel}:runtimeInstall`)) {
			return undefined;
		}
		if (ok) {
			const retry = runtimeInstall.retryCandidates ?? spec.candidates;
			for (const command of retry) {
				try {
					const proc = await launchLSP(command, spec.args, {
						cwd: spec.cwd,
						env: spec.env,
					});
					if (staleLaunch(generation, `${toolLabel}:launchLSP:runtime`, proc)) {
						return undefined;
					}
					return { process: proc, source: "managed" };
				} catch (err) {
					if (staleLaunch(generation, `${toolLabel}:launchLSP:runtime`)) {
						return undefined;
					}
					trackRuntimeFailure(err);
					// try next
				}
			}
		}
	}

	if (lastRuntimeFailure) {
		throw lastRuntimeFailure;
	}

	return undefined;
}

interface BundledServerLaunchSpec {
	/** Runtime interpreters to try, in order (first on PATH wins), e.g.
	 *  ["pwsh", "powershell"]. The bundle is launched THROUGH this runtime. */
	runtimeCandidates: string[];
	/** Managed archive TREE-BUNDLE tool id (installStrategy "archive", no
	 *  launcher); resolves to the extracted bundle directory. */
	bundleToolId: string;
	cwd: string;
	/** Build the runtime args from the resolved bundle directory. */
	args: (bundleDir: string) => string[];
	env?: Record<string, string>;
}

/**
 * Launch a language server that ships as a multi-folder MODULE BUNDLE driven by a
 * separate runtime (e.g. PowerShell Editor Services via `pwsh ...
 * Start-EditorServices.ps1 -Stdio`), rather than a single executable on PATH.
 *
 * Resolution order: (1) a runtime interpreter must be on PATH — else GRACEFUL
 * SKIP (returns undefined → the runner's coverage notice, never a hard fail);
 * (2) the bundle must be installed (already-extracted, or installed now when
 * `allowInstall`) — else graceful skip; (3) launch the runtime against the
 * bundle over stdio. A launch failure is logged and also degrades to a skip.
 */
async function resolveAndLaunchBundle(
	spec: BundledServerLaunchSpec,
	allowInstall: boolean | undefined,
): Promise<{ process: LSPProcess; source: "managed" } | undefined> {
	// 1. Resolve the runtime interpreter on PATH (don't spawn it bare — that would
	// hang; just probe). No runtime → graceful skip (coverage notice).
	let runtime: string | undefined;
	for (const candidate of spec.runtimeCandidates) {
		if (await isOnPath(candidate)) {
			runtime = candidate;
			break;
		}
	}
	if (!runtime) {
		logSessionStart(
			`lsp launch bundle skip tool=${spec.bundleToolId}: no runtime on PATH (tried ${spec.runtimeCandidates.join(", ")})`,
		);
		return undefined;
	}

	// 2. Resolve the bundle directory: already installed, else install when allowed.
	let bundleDir = await getToolPath(spec.bundleToolId);
	if (!bundleDir && canInstall(allowInstall)) {
		bundleDir = await ensureTool(spec.bundleToolId);
	}
	if (!bundleDir) {
		logSessionStart(
			`lsp launch bundle skip tool=${spec.bundleToolId}: bundle not installed (allowInstall=${allowInstall !== false})`,
		);
		return undefined;
	}

	// 3. Launch the runtime against the bundle over stdio.
	try {
		const proc = await launchLSP(runtime, spec.args(bundleDir), {
			cwd: spec.cwd,
			env: spec.env,
		});
		logSessionStart(
			`lsp launch bundle success tool=${spec.bundleToolId} runtime=${runtime} bundle=${bundleDir}`,
		);
		return { process: proc, source: "managed" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logSessionStart(
			`lsp launch bundle failed tool=${spec.bundleToolId} runtime=${runtime} error=${message}`,
		);
		return undefined;
	}
}

interface TreeBinaryLaunchSpec {
	/** PATH candidates to try FIRST — a user/system install wins (fast, already
	 *  on PATH), e.g. ["clangd"]. */
	candidates: string[];
	/** Managed archive TREE-BUNDLE tool id (installStrategy "archive", no
	 *  launcher); resolves to the extracted bundle directory. */
	bundleToolId: string;
	/** Path to the executable INSIDE the bundle, relative + POSIX-separated,
	 *  WITHOUT the platform suffix (".exe" is appended on win32), e.g.
	 *  "bin/clangd". */
	binRelPath: string;
	cwd: string;
	args: string[];
	env?: Record<string, string>;
}

/**
 * Launch a language server that ships as a self-contained native TREE BUNDLE with
 * its executable INSIDE the extracted tree (e.g. clangd: `<bundle>/bin/clangd`
 * plus the bundled libclang headers under `lib/`), as opposed to a single binary
 * on PATH or a runtime-driven module bundle (see {@link resolveAndLaunchBundle}).
 *
 * Resolution order: (1) PATH candidates first — a system install wins; (2) the
 * managed bundle (already-extracted, or installed now when `allowInstall`), then
 * launch the bin within it. No external runtime. Anything missing → GRACEFUL SKIP
 * (returns undefined → the runner's coverage notice, never a hard fail).
 */
async function resolveAndLaunchTreeBinary(
	spec: TreeBinaryLaunchSpec,
	allowInstall: boolean | undefined,
): Promise<{ process: LSPProcess; source: "direct" | "managed" } | undefined> {
	// 1. PATH-first — a system install wins (user-managed, no 150MB download).
	for (const command of spec.candidates) {
		try {
			const proc = await launchLSP(command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
			});
			return { process: proc, source: "direct" };
		} catch {
			// not on PATH (or broken) — fall through to the managed bundle
		}
	}

	// 2. Managed tree bundle: already-extracted, else install when allowed.
	let bundleDir = await getToolPath(spec.bundleToolId);
	if (!bundleDir && canInstall(allowInstall)) {
		bundleDir = await ensureTool(spec.bundleToolId);
	}
	if (!bundleDir) {
		logSessionStart(
			`lsp launch tree-bin skip tool=${spec.bundleToolId}: not on PATH and bundle not installed (allowInstall=${allowInstall !== false})`,
		);
		return undefined;
	}

	const suffix = process.platform === "win32" ? ".exe" : "";
	const binPath = path.join(bundleDir, ...spec.binRelPath.split("/")) + suffix;
	try {
		const proc = await launchLSP(binPath, spec.args, {
			cwd: spec.cwd,
			env: spec.env,
		});
		logSessionStart(
			`lsp launch tree-bin success tool=${spec.bundleToolId} bin=${binPath}`,
		);
		return { process: proc, source: "managed" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logSessionStart(
			`lsp launch tree-bin failed tool=${spec.bundleToolId} bin=${binPath} error=${message}`,
		);
		return undefined;
	}
}

function nodeBinLocalCandidates(root: string, baseName: string): string[] {
	const localBase = path.join(root, "node_modules", ".bin", baseName);
	if (process.platform === "win32") {
		return [`${localBase}.cmd`, `${localBase}.exe`];
	}
	return [localBase];
}

function nodeBinCandidates(root: string, baseName: string): string[] {
	return [...nodeBinLocalCandidates(root, baseName), baseName];
}

function normalizeSlashKey(value: string): string {
	const normalized = path.resolve(value).replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function piAgentExtensionsRootKey(file: string): string | undefined {
	const dirKey = normalizeSlashKey(path.dirname(path.resolve(file)));
	const marker = "/.pi/agent/extensions";
	const index = dirKey.indexOf(marker);
	if (index === -1) return undefined;
	return dirKey.slice(0, index + marker.length);
}

function normalizeRootKey(root: string): string {
	return process.platform === "win32"
		? path.resolve(root).toLowerCase()
		: path.resolve(root);
}

function IgnoreHomeRoot(primary: RootFunction): RootFunction {
	const homeKey = normalizeRootKey(os.homedir());
	return async (file: string): Promise<string | undefined> => {
		const root = await primary(file);
		if (!root) return undefined;
		return normalizeRootKey(root) === homeKey ? undefined : root;
	};
}

function rubyBinCandidates(baseName: string): string[] {
	const candidates: string[] = [];
	const home = os.homedir();
	const isWin = process.platform === "win32";
	const ext = isWin ? ".bat" : "";

	// mise and asdf version managers — same layout on all platforms
	candidates.push(
		path.join(
			home,
			".local",
			"share",
			"mise",
			"installs",
			"ruby",
			"bin",
			`${baseName}${ext}`,
		),
	);
	candidates.push(
		path.join(home, ".asdf", "installs", "ruby", "bin", `${baseName}${ext}`),
	);

	if (isWin) {
		// Ruby installer drops versioned dirs on C: by convention, but the drive
		// and version suffix vary — scan what's actually present instead of
		// hardcoding. Memoized once per process (#1137): a synchronous drive-root
		// enumeration per LSP spawn was an event-loop offender.
		const driveRoot = path.parse(home).root; // e.g. "C:\"
		for (const entry of getRubyVersionDirNamesSync(driveRoot)) {
			candidates.push(path.join(driveRoot, entry, "bin", `${baseName}.bat`));
			candidates.push(path.join(driveRoot, entry, "bin", baseName));
		}
	}

	return candidates;
}

type InitializationConfig = Record<string, unknown>;

interface InteractiveServerSpec {
	id: string;
	name: string;
	extensions: readonly string[];
	root: RootFunction;
	language: string;
	fallbackFor?: string;
	command: string | ((root: string) => string);
	args?: string[] | ((root: string) => string[]);
	initialization?:
		| InitializationConfig
		| ((root: string) => InitializationConfig);
	/**
	 * Language-runtime dependency to resolve before launch (#241). The server's
	 * binary is itself run by this runtime (jdtls → java); when the runtime isn't
	 * on PATH, a discovered install is injected into the spawn env instead of
	 * silently failing. Currently only "java" (jdtls).
	 */
	runtime?: "java";
}

function createInteractiveServer(spec: InteractiveServerSpec): LSPServerInfo {
	return {
		id: spec.id,
		name: spec.name,
		extensions: spec.extensions,
		root: spec.root,
		fallbackFor: spec.fallbackFor,
		availabilityKey:
			typeof spec.command === "string" && isSimpleCommand(spec.command)
				? spec.command
				: undefined,
		async spawn(root) {
			const command =
				typeof spec.command === "function" ? spec.command(root) : spec.command;
			const args =
				typeof spec.args === "function" ? spec.args(root) : spec.args || [];
			// Try to launch directly — no auto-install for language-runtime tools
			// (C#, Java, Swift, etc. require their SDK; cannot npm/pip install them)
			if (
				isSimpleCommand(command) &&
				isDirectLspCommandTemporarilyUnavailable(command)
			) {
				return undefined;
			}
			// #241: the server binary is run by a language runtime (jdtls → java).
			// When that runtime isn't on PATH, inject a discovered install's env so
			// it launches instead of silently failing with no_clients.
			const runtimeEnv =
				spec.runtime === "java" ? await resolveJavaRuntimeEnv() : undefined;
			try {
				const proc = await launchLSP(command, args, {
					cwd: root,
					...(runtimeEnv ? { env: runtimeEnv } : {}),
				});
				const initialization =
					typeof spec.initialization === "function"
						? spec.initialization(root)
						: spec.initialization;
				return { process: proc, source: "direct", initialization };
			} catch (err) {
				if (hasSpawnFailureKind(err, "tool-not-found")) {
					markDirectLspCommandUnavailable(command);
				}
				return undefined;
			}
		},
	};
}

export function PriorityRoot(
	markerGroups: string[][],
	excludePatterns?: string[],
	stopDir?: string,
): RootFunction {
	const resolvers = markerGroups.map((markers) =>
		NearestRoot(markers, excludePatterns, stopDir),
	);
	return async (file: string) => {
		for (const resolve of resolvers) {
			const root = await resolve(file);
			if (root) return root;
		}
		return undefined;
	};
}

export const FileDirRoot: RootFunction = async (file: string) => {
	const candidate = path.resolve(path.dirname(file));
	return nearestNonExcludedFallbackRoot(candidate);
};

export function RootWithFallback(
	primary: RootFunction,
	fallback: RootFunction = FileDirRoot,
): RootFunction {
	return async (file: string): Promise<string | undefined> => {
		const primaryRoot = await primary(file);
		if (primaryRoot) return primaryRoot;
		return fallback(file);
	};
}

export function WorkspacePriorityRoot(
	markerGroups: string[][],
	excludePatterns?: string[],
): RootFunction {
	return async (file: string) =>
		PriorityRoot(markerGroups, excludePatterns, process.cwd())(file);
}

function isPermissionFsError(err: unknown): boolean {
	const code = (err as { code?: unknown })?.code;
	return code === "EACCES" || code === "EPERM";
}

async function markerExists(dir: string, pattern: string): Promise<boolean> {
	if (!pattern.includes("*")) {
		try {
			await stat(path.join(dir, pattern));
			return true;
		} catch (err) {
			if (isPermissionFsError(err)) {
				logSessionStart(
					`lsp root marker skipped: permission error stat ${path.join(dir, pattern)}`,
				);
			}
			return false;
		}
	}

	const normalized = pattern.replace(/\\/g, "/");
	const slash = normalized.lastIndexOf("/");
	const parentPattern = slash >= 0 ? normalized.slice(0, slash) : "";
	const basenamePattern = slash >= 0 ? normalized.slice(slash + 1) : normalized;
	if (!basenamePattern) return false;
	const targetDir = parentPattern
		? path.join(dir, ...parentPattern.split("/").filter(Boolean))
		: dir;
	try {
		const entries = await readdir(targetDir, { withFileTypes: true });
		// Match files/symlinks only — a directory named like the marker (e.g. a
		// `Foo.csproj/` dir) is not a project file. Case-insensitive on win32 to
		// match the filesystem (and the project ignore matcher), via the shared
		// marker-glob helper.
		return direntsHaveMarkerGlobMatch(entries, basenamePattern);
	} catch (err) {
		if (isPermissionFsError(err)) {
			logSessionStart(
				`lsp root marker skipped: permission error read ${targetDir}`,
			);
		}
		return false;
	}
}

// --- Root Detection Helpers ---

// --- Interactive Install Helper ---

/**
 * Walk up the directory tree looking for project root markers.
 *
 * NearestRoot(includePatterns, excludePatterns?) → RootFunction
 *
 * - includePatterns: file/dir names that signal the project root (e.g. ["package.json"])
 * - excludePatterns: if any of these exist in a directory, SKIP that directory and
 *   keep walking up toward stopDir — it does not abort resolution. A directory that
 *   matches an exclude pattern is simply never returned as a root; the walk still
 *   continues past it looking for an include-pattern hit higher up (#1671).
 * - stopDir: walk stops here (defaults to filesystem root; set to project cwd for safety)
 *
 * Equivalent to createRootDetector; exported under both names for clarity.
 */
export function NearestRoot(
	includePatterns: string[],
	excludePatterns?: string[],
	stopDir?: string,
): RootFunction {
	// Per-instance caches — each NearestRoot(markers) call gets its own Map so
	// different servers (e.g. TypeScript vs Go) with different marker sets never
	// share entries. vi.resetModules() in tests resets module state between cases.
	const cache = new Map<string, string>();
	// Only cache successful hits. Undefined results are NOT cached so that a
	// newly-created root marker (e.g. package.json or tsconfig.json scaffolded
	// mid-session by the agent) is detected on the next call — the absent →
	// present transition must work without a process restart. The uncached
	// re-walk cost for configless repos is a known trade-off; bounding the
	// walk with stopDir for in-cwd files is the tracked optimization (#1412).
	const inFlight = new Map<string, Promise<string | undefined>>();

	return async (file: string): Promise<string | undefined> => {
		// Cache key is the resolved directory — all files in the same dir share a root.
		const startDir = path.resolve(path.dirname(file));
		const dirKey = normalizeMapKey(startDir);

		// Fast path: already resolved for this directory.
		const cached = cache.get(dirKey);
		if (cached !== undefined) return cached;

		// In-flight deduplication: if N parallel pipelines edit files in the same
		// directory simultaneously, only one stat-walk runs; the rest await the same
		// promise. This is the main fix for parallel-turn LSP timeout spikes.
		const flying = inFlight.get(dirKey);
		if (flying) return flying;

		const promise = (async (): Promise<string | undefined> => {
			let currentDir = startDir;
			const fsRoot = path.parse(currentDir).root;
			const stop = stopDir ? path.resolve(stopDir) : fsRoot;

			while (true) {
				if (
					stop !== fsRoot &&
					currentDir.startsWith(stop + path.sep) === false &&
					currentDir !== stop
				) {
					break;
				}

				// Check exclude patterns — skip this dir (but keep walking up)
				if (excludePatterns) {
					let excluded = false;
					for (const pattern of excludePatterns) {
						if (await markerExists(currentDir, pattern)) {
							excluded = true;
							break;
						}
					}
					if (excluded) {
						currentDir = path.dirname(currentDir);
						continue;
					}
				}

				// Check include patterns. Exact marker names stay cheap (`stat`), while
				// glob markers like `*.csproj` match real project filenames (#201).
				for (const pattern of includePatterns) {
					if (
						(await markerExists(currentDir, pattern)) &&
						!(await isExcludedLspRoot(currentDir))
					) {
						return enforceLspRootCeiling(currentDir, process.cwd(), file);
					}
				}

				if (currentDir === stop || currentDir === fsRoot) {
					break;
				}

				currentDir = path.dirname(currentDir);
			}

			return undefined;
		})();

		inFlight.set(dirKey, promise);
		try {
			const result = await promise;
			if (result !== undefined) cache.set(dirKey, result);
			return result;
		} finally {
			inFlight.delete(dirKey);
		}
	};
}

/** Alias kept for backward compatibility */
export const createRootDetector = NearestRoot;

// --- Runtime Tool Helpers ---

/**
 * Check if a command is available on system PATH.
 *
 * Async (was a blocking `spawnSync("where"/"which")`): runs on the spawn
 * fall-through path (Step 4, runtime-install gate). The shared
 * `isCommandAvailableAsync` spawns the same finder via `safeSpawnAsync` with a
 * 5s timeout, so a stalled finder can no longer freeze the loop. Semantics are
 * preserved: true iff the finder exits 0.
 */
function isOnPath(command: string): Promise<boolean> {
	return isCommandAvailableAsync(command);
}

/**
 * Try to install gopls via `go install`. Resolves true if the install succeeded.
 *
 * Async (was a blocking `spawnSync`): runs on the LSP runtime-install gate, off
 * the event loop. `ignoreAmbientSignal` keeps the install running to completion
 * even if the agent turn is interrupted, matching the old uncancellable sync
 * behaviour. Success semantics preserved: true iff the process exits 0.
 */
export async function tryGoInstallGopls(): Promise<boolean> {
	const isWindows = process.platform === "win32";
	const result = await safeSpawnAsync(
		isWindows ? "go.exe" : "go",
		["install", "golang.org/x/tools/gopls@latest"],
		{ timeout: 180000, ignoreAmbientSignal: true },
	);
	return !result.error && result.status === 0;
}

export async function tryDotnetToolInstall(tool: string): Promise<boolean> {
	mkdirSync(PI_LENS_BIN_DIR, { recursive: true });
	const result = await safeSpawnAsync(
		"dotnet",
		["tool", "install", "--tool-path", PI_LENS_BIN_DIR, tool],
		{ timeout: 180000, ignoreAmbientSignal: true },
	);
	if (!result.error && result.status === 0) return true;

	const stderr = result.stderr ?? "";
	if (stderr.includes("No NuGet sources are defined or enabled")) {
		logSessionStart(
			`lsp dotnet-install: NuGet sources missing — cannot install ${tool}. ` +
				`Run: dotnet nuget add source https://api.nuget.org/v3/index.json -n nuget.org`,
		);
		return false;
	}

	const updateResult = await safeSpawnAsync(
		"dotnet",
		["tool", "update", "--tool-path", PI_LENS_BIN_DIR, tool],
		{ timeout: 180000, ignoreAmbientSignal: true },
	);
	return !updateResult.error && updateResult.status === 0;
}

/**
 * #1412 M1: walk up from `startDir` (inclusive) looking for a file at
 * `startDir/<relativeSegments>`, `dirname(startDir)/<relativeSegments>`, and so
 * on — the same ancestor walk `findNativeTypeScriptLsp` uses, bounded the same
 * way (`isAtOrAboveHomeDir`). A nested config root (e.g. a `cypress/tsconfig.json`
 * LSP root inside a repo whose `node_modules` only exists at the repo root) must
 * still resolve tooling installed at an ancestor, not just directly under the
 * LSP root — mirrors how node module resolution itself walks up.
 */
async function findAncestorFile(
	startDir: string,
	...relativeSegments: string[]
): Promise<string | undefined> {
	return findAncestorFileAmong(startDir, [relativeSegments]);
}

/**
 * Same ancestor walk as `findAncestorFile`, but checks every candidate
 * relative-path in `candidateSegmentLists` AT EACH LEVEL before moving up —
 * so the nearest ancestor wins regardless of which candidate name matched
 * there, matching normal node_modules resolution priority (nearest install
 * shadows a further one, never the reverse).
 */
async function findAncestorFileAmong(
	startDir: string,
	candidateSegmentLists: string[][],
): Promise<string | undefined> {
	const fs = await import("node:fs/promises");
	let currentDir = path.resolve(startDir);
	while (!isAtOrAboveHomeDir(currentDir)) {
		for (const segments of candidateSegmentLists) {
			const candidate = path.join(currentDir, ...segments);
			try {
				await fs.access(candidate);
				return candidate;
			} catch {
				/* not found at this level */
			}
		}
		const parent = path.dirname(currentDir);
		if (parent === currentDir) break;
		currentDir = parent;
	}
	return undefined;
}

/**
 * A failed classic-compiler repair must not repeat within a session.
 * `ensureTool` caches successful installs, so a repair that works
 * short-circuits later calls on its own. A repair that fails leaves nothing
 * behind, and `findTsserverPath` has three call sites (TypeScript, Vue,
 * Svelte). Without this guard an offline or partial install re-runs a 120 s
 * forced reinstall on every spawn.
 *
 * The guard is process-singleton state, so without an explicit re-arm it
 * would latch for the whole extension-host process — a repair that failed
 * once (transient registry hiccup) would stay unrepairable for every later
 * session in that process. `resetClassicTsRepairGuard` re-arms it; callers
 * wire that into `session_start` alongside the other per-session resets
 * (#1570).
 */
const CLASSIC_TS_REPAIR_FAMILY = "lsp.classic-ts-repair-guard";
const CLASSIC_TS_REPAIR_VERSION = 1;

function classicTsRepairState(): { attempted: boolean } {
	return getProcessSingleton(
		CLASSIC_TS_REPAIR_FAMILY,
		CLASSIC_TS_REPAIR_VERSION,
		() => ({ attempted: false }),
	);
}

/** Re-arm the classic-repair guard so a new session gets its own attempt. */
export function resetClassicTsRepairGuard(): void {
	classicTsRepairState().attempted = false;
}

/** Test hook — clears the process-singleton classic-repair guard. */
export function _resetClassicTsRepairForTests(): void {
	resetClassicTsRepairGuard();
}

/**
 * Directories that may hold the TypeScript package next to a resolved `tsc`
 * binary: `<bin>/../typescript` (npm-global layout) and
 * `<bin>/../../typescript` (managed `node_modules/.bin` layout).
 */
function typescriptDirsForTsc(tscPath: string): string[] {
	const binDir = path.dirname(tscPath);
	return [
		path.join(binDir, "..", "typescript"),
		path.join(binDir, "..", "..", "typescript"),
	];
}

/**
 * Read the major version of the TypeScript package that backs a resolved
 * `tsc` binary. Returns undefined when the version is unknowable: `ensureTool`
 * returns the bare string `"tsc"` for a PATH hit, and `path.dirname("tsc")` is
 * `"."`, so the candidates would go cwd-relative. Callers must not repair on
 * an unknown version — a healthy global TypeScript 5.x would be reinstalled
 * for nothing.
 */
async function typescriptVersionForTsc(
	tscPath: string,
): Promise<{ version: string; major: number } | undefined> {
	if (!path.isAbsolute(tscPath)) return undefined;
	for (const dir of typescriptDirsForTsc(tscPath)) {
		let manifest: string;
		try {
			manifest = await readFile(path.join(dir, "package.json"), "utf8");
		} catch {
			continue;
		}
		let version: string;
		try {
			const parsed: unknown = JSON.parse(manifest);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("version" in parsed) ||
				typeof parsed.version !== "string"
			) {
				return undefined;
			}
			version = parsed.version;
		} catch {
			return undefined;
		}
		const majorText = version.split(".", 1)[0] ?? "";
		const major = /^\d+$/.test(majorText) ? Number(majorText) : Number.NaN;
		if (!Number.isFinite(major)) return undefined;
		return { version, major };
	}
	return undefined;
}

/**
 * Locate tsserver.js — tries local project (walking up from root, #1412 M1),
 * then process.cwd() as a last-resort fallback, then pi-lens managed
 * TypeScript. Returns the path to tsserver.js, or undefined if not found.
 */
async function findTsserverPath(
	root: string,
	allowInstall: boolean | undefined,
): Promise<string | undefined> {
	const fs = await import("node:fs/promises");
	const ancestorHit = await findAncestorFile(
		root,
		"node_modules",
		"typescript",
		"lib",
		"tsserver.js",
	);
	if (ancestorHit) return ancestorHit;
	const cwdCandidate = path.join(
		process.cwd(),
		"node_modules",
		"typescript",
		"lib",
		"tsserver.js",
	);
	try {
		await fs.access(cwdCandidate);
		return cwdCandidate;
	} catch {
		/* not found */
	}
	const tsserverForTsc = async (
		tscPath: string | undefined,
	): Promise<string | undefined> => {
		if (!tscPath) return undefined;
		for (const dir of typescriptDirsForTsc(tscPath)) {
			const candidate = path.join(dir, "lib", "tsserver.js");
			try {
				await fs.access(candidate);
				return candidate;
			} catch {
				/* not found */
			}
		}
		return undefined;
	};

	// Discover the TypeScript install (PATH / npm-global) even when installation
	// is disabled; only the download is gated by allowInstall.
	const installAllowed = canInstall(allowInstall);
	const discoveredTsc = await ensureTool("typescript", {
		allowInstall: installAllowed,
	});
	const discoveredTsserver = await tsserverForTsc(discoveredTsc);
	if (
		discoveredTsserver ||
		!discoveredTsc ||
		!installAllowed ||
		classicTsRepairState().attempted
	) {
		return discoveredTsserver;
	}

	// Repair only a compiler we can prove is TypeScript 7+. TypeScript 7 dropped
	// lib/tsserver.js, so the classic wrapper cannot start against it. Any other
	// version — or a version we cannot read, such as a bare PATH `tsc` — is left
	// alone rather than force-reinstalled.
	const discoveredVersion = await typescriptVersionForTsc(discoveredTsc);
	if (!discoveredVersion || discoveredVersion.major < 7) return undefined;

	// An older managed tree took `latest` before the registry pinned the classic
	// compiler. Reinstall the pinned version once so that tree self-heals,
	// without deleting user or project-local TypeScript installations.
	classicTsRepairState().attempted = true;
	logSessionStart(
		`lsp typescript: managed compiler resolved to TypeScript ${discoveredVersion.version}, which ships no tsserver.js; reinstalling pinned classic fallback`,
	);
	const repairedTsc = await ensureTool("typescript", {
		allowInstall: true,
		forceReinstall: true,
	});
	return tsserverForTsc(repairedTsc);
}

interface NativeTypeScriptLsp {
	command: string;
	version: string;
}

/**
 * TypeScript 7+ ships the native typescript-go language server through the
 * workspace-local `tsc --lsp --stdio` entrypoint and no longer includes
 * `lib/tsserver.js`. Resolve the nearest TypeScript package using normal
 * node_modules ancestor semantics so a monorepo package can use its hoisted
 * compiler, while never falling through to a PATH/global `tsc`.
 */
async function findNativeTypeScriptLsp(
	root: string,
): Promise<NativeTypeScriptLsp | undefined> {
	let currentDir = path.resolve(root);

	while (!isAtOrAboveHomeDir(currentDir)) {
		const typescriptDir = path.join(currentDir, "node_modules", "typescript");
		const packageJsonPath = path.join(typescriptDir, "package.json");

		let packageJsonText: string;
		try {
			packageJsonText = await readFile(packageJsonPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return undefined;
			}
			// A `node_modules/typescript/` directory that exists but has no
			// `package.json` is a malformed/partial install at THIS level, not an
			// absent one — stop here (fall back to classic) rather than walking up
			// to an ancestor, or a broken nearest install would let an unrelated
			// ancestor TS 7 binary silently shadow it (Copilot review, PR #526).
			try {
				const dirStat = await stat(typescriptDir);
				if (dirStat.isDirectory()) return undefined;
			} catch {
				/* typescript dir itself doesn't exist here — keep walking up */
			}
			const parent = path.dirname(currentDir);
			if (parent === currentDir) return undefined;
			currentDir = parent;
			continue;
		}

		let version: string;
		try {
			const parsed: unknown = JSON.parse(packageJsonText);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("version" in parsed) ||
				typeof parsed.version !== "string"
			) {
				return undefined;
			}
			version = parsed.version;
		} catch {
			return undefined;
		}

		// The nearest installed package shadows any ancestor TypeScript package,
		// matching Node/package-manager resolution. Never skip a local TS <=6 or
		// malformed install just to select an unrelated ancestor TS 7 binary.
		const majorText = version.split(".", 1)[0] ?? "";
		const major = /^\d+$/.test(majorText) ? Number(majorText) : Number.NaN;
		if (!Number.isFinite(major) || major < 7) return undefined;

		const localTsc = path.join(currentDir, "node_modules", ".bin", "tsc");
		const candidates =
			process.platform === "win32"
				? [`${localTsc}.cmd`, `${localTsc}.exe`, localTsc]
				: [localTsc];

		for (const command of candidates) {
			try {
				await access(command);
				return { command, version };
			} catch {
				/* not found */
			}
		}
		return undefined;
	}
	return undefined;
}

function dotnetToolCandidates(tool: string): string[] {
	const home = os.homedir();
	return [
		path.join(PI_LENS_BIN_DIR, `${tool}.exe`),
		path.join(PI_LENS_BIN_DIR, tool),
		path.join(home, ".dotnet", "tools", `${tool}.exe`),
		path.join(home, ".dotnet", "tools", tool),
		tool,
	].filter(Boolean);
}

/**
 * Both filename forms for a tool in a directory (`.exe` first on Windows). A
 * managed binary may carry the extension or not depending on how the toolchain
 * dropped it, so we try both.
 */
function binExeVariants(dir: string, tool: string): string[] {
	return process.platform === "win32"
		? [path.join(dir, `${tool}.exe`), path.join(dir, tool)]
		: [path.join(dir, tool)];
}

/**
 * Canonical-bin discovery (#241): a runtime-managed server can be installed yet
 * absent from the shell PATH — the toolchain drops it in a well-known dir the
 * user's PATH often omits (fresh installs, Windows, non-login shells). Returning
 * the bare command FIRST keeps PATH authoritative when it resolves; the explicit
 * dir paths are the fallback (and the post-`go install` retry target).
 *
 * Go: `$GOPATH/bin` (first GOPATH entry) or `~/go/bin` — where `go install` lands.
 */
export function goBinCandidates(tool: string): string[] {
	const gopath =
		process.env.GOPATH?.split(path.delimiter)[0] ||
		path.join(os.homedir(), "go");
	return [tool, ...binExeVariants(path.join(gopath, "bin"), tool)];
}

/** Rust: `$CARGO_HOME/bin` or `~/.cargo/bin` — cargo/rustup binaries + proxies. */
export function cargoBinCandidates(tool: string): string[] {
	const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
	return [tool, ...binExeVariants(path.join(cargoHome, "bin"), tool)];
}

/**
 * Try to install a gem to the pi-lens bin dir. Resolves true if the install succeeded.
 */
export async function tryGemInstall(gem: string): Promise<boolean> {
	const { join } = await import("node:path");
	const binDir = join(getGlobalPiLensDir(), "bin");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(binDir, { recursive: true });

	const result = await safeSpawnAsync(
		"gem",
		["install", gem, "--bindir", binDir, "--no-document"],
		{ timeout: 180000, ignoreAmbientSignal: true },
	);
	const ok = !result.error && result.status === 0;
	// Add binDir to PATH so subsequent lookups find the installed gem
	if (ok) {
		const sep = process.platform === "win32" ? ";" : ":";
		if (!process.env.PATH?.includes(binDir)) {
			process.env.PATH = `${binDir}${sep}${process.env.PATH ?? ""}`;
		}
	}
	return ok;
}

/**
 * Wraps a root function so it returns undefined for files inside a Deno project.
 * Prevents TypeScript LSP from being spawned alongside Deno LSP for the same file,
 * which would produce false diagnostics for Deno-specific APIs.
 */
export function DenoExcludeRoot(primary: RootFunction): RootFunction {
	const denoDetector = createRootDetector(["deno.json", "deno.jsonc"]);
	return async (file: string): Promise<string | undefined> => {
		const denoRoot = await denoDetector(file);
		if (denoRoot) return undefined;
		return primary(file);
	};
}

// --- Server Definitions ---

const JS_TS_LSP_EXTENSIONS = KIND_EXTENSIONS["jsts"].filter(
	(ext) => ext !== ".svelte" && ext !== ".vue",
);

// TypeScript identity and tooling discovery deliberately use separate marker
// families. A governing config wins even when a package directory supplies
// hoisted binaries. Keep configs out of PROJECT_BOUNDARY_MARKERS: #1373 still
// coalesces a config-only nested root when an ancestor client was hosted first
// (nested-config-first remains intentionally open-order-sensitive). #1412
// accepted risk (M2, not fixed here): honoring nested config roots at all
// enlarges the population of directories that can independently coalesce or
// diverge under #1373's open-order sensitivity — the same pre-existing
// blast-radius, just triggered by more roots than before.
const TS_CONFIG_MARKERS = ["tsconfig.json", "jsconfig.json"] as const;
const TS_TOOLING_MARKERS = [
	"package-lock.json",
	"bun.lockb",
	"bun.lock",
	"pnpm-lock.yaml",
	"yarn.lock",
	"package.json",
] as const;

// #1412 M3: tsserver associates jsconfig.json with JS files only (its identity
// probe reports a jsconfig-governed .ts file as unassociated) — so a TS-family
// file under a jsconfig-only directory must NOT root there; keep walking up
// for a real tsconfig.json. A JS-family file accepts either: tsconfig also
// governs plain JS via `allowJs`, so accepting tsconfig for a .js file is
// correct, and jsconfig obviously is too.
const TS_FAMILY_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function isTsFamilyFile(file: string): boolean {
	return TS_FAMILY_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function tsConfigMarkersForFile(file: string): readonly string[] {
	return isTsFamilyFile(file)
		? (["tsconfig.json"] as const)
		: TS_CONFIG_MARKERS;
}

// Two detector instances (not one parameterized by file) so each keeps its own
// per-directory NearestRoot cache valid for its fixed marker set — a shared
// cache keyed only by directory would conflate the TS-only and either-config
// answers for the same directory.
const TypeScriptConfigRootTsOnly = IgnoreHomeRoot(
	createRootDetector(["tsconfig.json"]),
);
const TypeScriptConfigRootEither = IgnoreHomeRoot(
	createRootDetector([...TS_CONFIG_MARKERS]),
);
const TypeScriptToolingRoot = IgnoreHomeRoot(
	createRootDetector([...TS_TOOLING_MARKERS]),
);

async function findTypeScriptProjectRoot(
	file: string,
): Promise<string | undefined> {
	const configDetector = isTsFamilyFile(file)
		? TypeScriptConfigRootTsOnly
		: TypeScriptConfigRootEither;
	const [configRoot, toolingRoot] = await Promise.all([
		configDetector(file),
		TypeScriptToolingRoot(file),
	]);
	if (!configRoot) return toolingRoot;
	if (!toolingRoot) return configRoot;
	// A config inside (or beside) the nearest package governs its files. A
	// config above a nearer package must not erase that topology boundary.
	return isSameOrWithin(toolingRoot, configRoot) ? configRoot : toolingRoot;
}

/**
 * Walk up from the file's directory looking for a TypeScript project marker
 * (a governing config first, per-directory, per #1412 M3's extension-family
 * filter; else a tooling/lockfile marker), but stop at `extensionRootKey` so
 * we never escape the .pi/agent/extensions boundary into a higher-up project
 * (e.g. ~/.pi/agent/package.json which would pull every extension in the
 * directory into one LSP workspace).
 *
 * #1412 L4: each directory returns immediately on its first match (config or
 * tooling) — there is no cross-level "nearest tooling root" to carry forward,
 * since a match always wins on the spot. Returns the nearest directory
 * containing a marker, or undefined if none is found between the file and the
 * extensions root inclusive.
 */
async function findExtensionBoundedRoot(
	file: string,
	extensionRootKey: string,
): Promise<string | undefined> {
	const startDir = path.resolve(path.dirname(file));
	let currentDir = startDir;
	const configMarkers = tsConfigMarkersForFile(file);
	while (true) {
		for (const pattern of configMarkers) {
			try {
				await stat(path.join(currentDir, pattern));
				return currentDir;
			} catch {
				/* not found, try next marker */
			}
		}
		for (const pattern of TS_TOOLING_MARKERS) {
			try {
				await stat(path.join(currentDir, pattern));
				return currentDir;
			} catch {
				/* not found, try next marker */
			}
		}
		// Stop at or beyond the extensions root — never walk into the
		// pi-agent-wide scope.
		const currentKey = normalizeSlashKey(currentDir);
		if (currentKey === extensionRootKey) return undefined;
		const parent = path.dirname(currentDir);
		if (parent === currentDir) return undefined;
		currentDir = parent;
	}
}

/**
 * Check whether the directory immediately containing the extensions folder
 * (i.e. `.pi/agent/`) holds any TypeScript project marker. This narrowly
 * detects the #123 scenario — pi itself installs a package.json at
 * `~/.pi/agent/` and the user's extension has none of its own — without
 * picking up accidental markers further up the filesystem.
 */
async function hasAgentLevelProjectMarker(
	extensionRootKey: string,
): Promise<boolean> {
	const agentDir = path.dirname(extensionRootKey);
	if (!agentDir || agentDir === extensionRootKey) return false;
	for (const pattern of [...TS_CONFIG_MARKERS, ...TS_TOOLING_MARKERS]) {
		try {
			await stat(path.join(agentDir, pattern));
			return true;
		} catch {
			/* not found, try next */
		}
	}
	return false;
}

const TypeScriptRoot: RootFunction = DenoExcludeRoot(async (file) => {
	const extensionRootKey = piAgentExtensionsRootKey(file);
	if (extensionRootKey) {
		// Bounded walk so we never adopt a parent (e.g. ~/.pi/agent/) as the
		// LSP root.
		const bounded = await findExtensionBoundedRoot(file, extensionRootKey);
		if (bounded) return bounded;
		// No marker inside the extension boundary. If pi itself has a
		// package.json at ~/.pi/agent/ (the #123 setup), the previous code
		// returned undefined and the LSP silently failed to start. Fall
		// back to a per-file scope so the LSP at least runs.
		if (await hasAgentLevelProjectMarker(extensionRootKey)) {
			return FileDirRoot(file);
		}
		// Truly loose extension file with no project context anywhere
		// relevant — preserve the existing skip behavior (LSP shouldn't
		// analyze a lone .ts file with no package.json above or below).
		return undefined;
	}
	const projectRoot = await findTypeScriptProjectRoot(file);
	if (projectRoot) return projectRoot;
	return FileDirRoot(file);
});

export const TypeScriptServer: LSPServerInfo = {
	id: "typescript",
	name: "TypeScript Language Server",
	extensions: JS_TS_LSP_EXTENSIONS,
	autoPropagateDiagnostics: true,
	root: TypeScriptRoot,
	async spawn(root, options) {
		const fs = await import("node:fs/promises");
		const nativeLsp = await findNativeTypeScriptLsp(root);
		if (nativeLsp) {
			const env = await getToolEnvironment();
			logSessionStart(
				`lsp typescript-native: version=${nativeLsp.version} command=${nativeLsp.command}`,
			);
			const proc = await launchLSP(nativeLsp.command, ["--lsp", "--stdio"], {
				cwd: root,
				env,
			});
			return { process: proc, source: "direct", launchVariant: "native-ts7" };
		}

		let source: "direct" | "managed" = "direct";

		// TypeScript <=6 uses typescript-language-server + tsserver.js. Prefer a
		// project-local wrapper, then fall back to discovered/managed tooling.
		// #1412 M1: walk up from root (Windows .cmd first, then Unix at each
		// level) — a nested config root's node_modules/.bin lives at an ancestor,
		// not necessarily directly under the LSP root.
		let lspPath: string | undefined = await findAncestorFileAmong(root, [
			["node_modules", ".bin", "typescript-language-server.cmd"],
			["node_modules", ".bin", "typescript-language-server"],
		]);

		// Fall back to a discovered or managed install. ensureTool() runs PATH /
		// npm-global discovery even when install is disabled (only the download is
		// gated by canInstall), so a globally-installed typescript-language-server
		// resolves even without a per-project node_modules/.bin entry.
		if (!lspPath) {
			lspPath = await ensureTool("typescript-language-server", {
				allowInstall: canInstall(options?.allowInstall),
			});
			if (lspPath) source = "managed";
			if (!lspPath) {
				return undefined;
			}
		}

		// Find tsserver.js — also try relative to the LSP binary for local installs
		let tsserverPath = await findTsserverPath(root, options?.allowInstall);
		if (!tsserverPath) {
			const localCandidate = path.join(
				path.dirname(lspPath),
				"..",
				"typescript",
				"lib",
				"tsserver.js",
			);
			try {
				await fs.access(localCandidate);
				tsserverPath = localCandidate;
			} catch {
				/* not found */
			}
		}
		if (tsserverPath) source = "managed";

		// Use absolute path and proper environment
		const env = await getToolEnvironment();
		const proc = await launchLSP(lspPath, ["--stdio"], {
			cwd: root,
			env: {
				...env,
				TSSERVER_PATH: tsserverPath,
			},
		});

		return {
			process: proc,
			source,
			initialization: tsserverPath
				? { tsserver: { path: tsserverPath } }
				: undefined,
			launchVariant: "classic",
		};
	},
};

export const DenoServer: LSPServerInfo = {
	id: "deno",
	name: "Deno Language Server",
	fallbackFor: "typescript",
	extensions: JS_TS_LSP_EXTENSIONS,
	autoPropagateDiagnostics: true,
	root: createRootDetector(["deno.json", "deno.jsonc"]),
	async spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["deno"],
				args: ["lsp"],
				cwd: root,
				managedToolId: "deno",
			},
			options?.allowInstall,
		);
	},
};

export const PythonServer: LSPServerInfo = {
	id: "python",
	name: "Pyright Language Server",
	extensions: KIND_EXTENSIONS["python"],
	root: RootWithFallback(
		createRootDetector([
			".git",
			"pyproject.toml",
			"setup.py",
			"setup.cfg",
			"requirements.txt",
			"Pipfile",
			"poetry.lock",
		]),
	),
	async spawn(root, options) {
		const pythonEnvironment = await detectPythonEnvironment(root);
		const env = augmentPythonEnvironment(
			await getToolEnvironment(),
			pythonEnvironment,
		);
		let source: "direct" | "managed" | "package-manager" = "direct";

		// openFilesOnly: true — analyse only open files rather than the full workspace.
		// Avoids the 5–14 s cold-start on large projects caused by workspace-wide
		// analysis on startup. Deep type checking is still available via the standalone
		// pyright CLI runner that runs in parallel.
		const pyrightInit = (pythonPath?: string): Record<string, unknown> => ({
			...(pythonPath ? { pythonPath } : {}),
			openFilesOnly: true,
		});

		// Project ownership outranks checker preference: exhaust explicit project
		// candidates before a bare command can resolve to pi-lens's managed bin or
		// the host PATH. Within the project tier, preserve the established
		// pyright → basedpyright → ty preference.
		const projectPyright = await resolveAndLaunch(
			{
				candidates: [
					...pythonEnvironmentToolCandidates(
						pythonEnvironment,
						"pyright-langserver",
					),
					...nodeBinLocalCandidates(root, "pyright-langserver"),
					...pythonEnvironmentToolCandidates(
						pythonEnvironment,
						"basedpyright-langserver",
					),
					...nodeBinLocalCandidates(root, "basedpyright-langserver"),
				],
				args: ["--stdio"],
				cwd: root,
				env,
			},
			false,
		);
		if (projectPyright) {
			return {
				process: projectPyright.process,
				source: projectPyright.source,
				initialization: pyrightInit(pythonEnvironment?.pythonPath),
			};
		}

		// ty uses `ty server`, so it needs a separate launch phase from the
		// Pyright-compatible servers. It has no stable initializationOptions
		// equivalent to pyright's `pythonPath` (astral-sh/ty#2032); the child
		// environment and cwd provide interpreter discovery instead.
		const projectTy = await resolveAndLaunch(
			{
				candidates: pythonEnvironmentToolCandidates(pythonEnvironment, "ty"),
				args: ["server"],
				cwd: root,
				env,
			},
			false,
		);
		if (projectTy) {
			return { process: projectTy.process, source: projectTy.source };
		}

		// With no project-owned checker, retain the existing PATH preference and
		// keep ty opt-in: pyright, then basedpyright, then ty. The augmented child
		// PATH includes pi-lens-managed bins before the inherited global PATH.
		const pathPyright = await resolveAndLaunch(
			{
				candidates: ["pyright-langserver", "basedpyright-langserver"],
				args: ["--stdio"],
				cwd: root,
				env,
			},
			false,
		);
		if (pathPyright) {
			return {
				process: pathPyright.process,
				source: pathPyright.source,
				initialization: pyrightInit(pythonEnvironment?.pythonPath),
			};
		}

		const pathTy = await resolveAndLaunch(
			{
				candidates: ["ty"],
				args: ["server"],
				cwd: root,
				env,
			},
			false,
		);
		if (pathTy) {
			return { process: pathTy.process, source: pathTy.source };
		}

		// Discover a globally-installed pyright even when install is disabled;
		// only the download is gated by canInstall.
		const pyrightPath = await ensureTool("pyright", {
			allowInstall: canInstall(options?.allowInstall),
		});
		if (!pyrightPath) return undefined;
		source = "managed";

		const binDir = path.dirname(pyrightPath);
		const isWindows = process.platform === "win32";
		const managedCandidates = isWindows
			? [
					path.join(binDir, "pyright-langserver.cmd"),
					path.join(binDir, "pyright-langserver"),
					"pyright-langserver",
				]
			: [path.join(binDir, "pyright-langserver"), "pyright-langserver"];

		const resolved = await resolveAndLaunch(
			{ candidates: managedCandidates, args: ["--stdio"], cwd: root, env },
			false,
		);
		if (!resolved) return undefined;

		return {
			process: resolved.process,
			source,
			initialization: pyrightInit(pythonEnvironment?.pythonPath),
		};
	},
};

export const PythonJediServer: LSPServerInfo = {
	id: "python-jedi",
	name: "Jedi Language Server",
	fallbackFor: "python",
	extensions: KIND_EXTENSIONS["python"],
	root: RootWithFallback(
		createRootDetector([
			".git",
			"pyproject.toml",
			"setup.py",
			"setup.cfg",
			"requirements.txt",
			"Pipfile",
			"poetry.lock",
		]),
	),
	async spawn(root, options) {
		const launched = await resolveAndLaunch(
			{
				candidates: ["jedi-language-server"],
				args: [],
				cwd: root,
				managedToolId: "jedi-language-server",
			},
			options?.allowInstall,
		);
		if (!launched) return undefined;
		const pythonPath = await detectPythonVenv(root);
		return {
			...launched,
			initialization: pythonPath
				? { workspace: { environmentPath: pythonPath } }
				: {},
		};
	},
};

export const GoServer: LSPServerInfo = {
	id: "go",
	name: "gopls",
	extensions: KIND_EXTENSIONS["go"],
	root: RootWithFallback(
		WorkspacePriorityRoot([["go.work"], ["go.mod", "go.sum"], [".git"]]),
	),
	async spawn(root, options) {
		const result = await resolveAndLaunch(
			{
				// Canonical-bin discovery (#241): include $GOPATH/bin so a gopls that
				// `go install` dropped there resolves even when it isn't on PATH —
				// which is also the retry target after the runtimeInstall below.
				candidates: goBinCandidates("gopls"),
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "go",
					install: tryGoInstallGopls,
				},
			},
			options?.allowInstall,
		);
		if (!result) return undefined;
		return { ...result, initialization: { ui: { semanticTokens: true } } };
	},
};

async function readTextFileOrUndefined(
	filePath: string,
): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Slice out ONE top-level TOML table's raw body — from its `[name]` heading
 * to the next top-level `[...]`/`[[...]]` heading or EOF. `members`/`exclude`
 * must be read from the `[workspace]` table specifically: `[package]` has its
 * OWN `exclude` key (the standard cargo-publish exclude list, conventionally
 * written above `[workspace]` in a virtual-manifest-less root crate), and a
 * whole-file regex would misread it as workspace membership (#1671 F4).
 */
function extractTomlTableSection(content: string, tableName: string): string {
	const heading = new RegExp(`^\\[${tableName}\\][ \\t]*(?:#.*)?$`, "m");
	const match = heading.exec(content);
	if (!match) return "";
	const rest = content.slice(match.index + match[0].length);
	const nextHeading = rest.match(/^\[{1,2}[^\]]+\]{1,2}[ \t]*(?:#.*)?$/m);
	return nextHeading?.index !== undefined
		? rest.slice(0, nextHeading.index)
		: rest;
}

function parseTomlStringArray(content: string, key: string): string[] {
	const match = content.match(
		new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[([\\s\\S]*?)\\]`, "m"),
	);
	if (!match) return [];
	return [...match[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) =>
		(m[1] ?? m[2] ?? "").trim(),
	);
}

/** Turn one `/`-delimited glob SEGMENT into a regex source: `*` matches any
 * run of characters within the segment, `?` matches exactly one character,
 * everything else is escaped and literal. */
function segmentGlobToRegExpSource(segment: string): string {
	let out = "";
	for (const ch of segment) {
		if (ch === "*") out += "[^/]*";
		else if (ch === "?") out += "[^/]";
		else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return out;
}

/**
 * A `members`/`exclude` entry names a path exactly, or globs it segment by
 * segment: `*` and `?` inside a segment work at any depth — one wildcard
 * segment (`crates/*`), a bare `*`, or several chained together for a
 * deeper fixed-depth layout — matching cargo's own `glob`-crate semantics
 * for a fixed number of path components.
 *
 * KNOWN LIMITATION (#1671 F6, documented rather than implemented): a
 * recursive `**` segment (matching a variable number of path components) is
 * NOT supported and never matches — cargo workspaces that rely on `**` to
 * pull in an arbitrarily-nested crate tree will under-hoist (the crate stays
 * independently rooted instead of joining the workspace). This is
 * deliberately out of #1671's scope: the common, and the issue's fixture,
 * shape is an explicit fixed-depth `members` list.
 */
function matchesCargoWorkspacePattern(
	pattern: string,
	relativePath: string,
): boolean {
	const normalized = pattern.replace(/\/+$/, "");
	if (normalized.includes("**")) return false;
	const patternSegments = normalized.split("/");
	const pathSegments = relativePath.split("/");
	if (patternSegments.length !== pathSegments.length) return false;
	return patternSegments.every((segment, i) =>
		new RegExp(`^${segmentGlobToRegExpSource(segment)}$`).test(pathSegments[i]),
	);
}

/**
 * Given an ancestor Cargo.toml's raw contents that already contains a
 * `[workspace]` table, decide whether it actually claims `childDir` as a
 * member. Cargo's own default is that a bare `[workspace]` with no `members`
 * key claims only the manifest's own package — a nested crate is NOT
 * implicitly swept in just because it sits underneath the workspace root on
 * disk. Without this check any Cargo.toml with a `[workspace]` table would
 * hoist every crate below it, including ones the workspace never declared
 * (#1671) — the same defect shape as an undeclared Maven sibling module.
 *
 * KNOWN LIMITATION (#1671 F7, documented rather than implemented): cargo also
 * treats a crate as an implicit workspace member when the workspace root's
 * OWN `[package]` has a `path = "..."` dependency on it and no explicit
 * `members` key is present at all. That dependency-graph inference is not
 * evaluated here — a workspace relying on it alone (no `members` key) reads
 * as claiming nothing, so its crates stay independently rooted rather than
 * being (correctly, per cargo) swept in. An explicit `members` list — the
 * common case and the one #1671's fixtures exercise — is unaffected.
 */
function cargoWorkspaceDeclaresMember(
	workspaceContent: string,
	parentDir: string,
	childDir: string,
): boolean {
	const relativePath = path
		.relative(parentDir, childDir)
		.split(path.sep)
		.join("/");
	if (relativePath === "" || relativePath.startsWith("..")) return false;
	const workspaceSection = extractTomlTableSection(
		workspaceContent,
		"workspace",
	);
	const excluded = parseTomlStringArray(workspaceSection, "exclude");
	if (
		excluded.some((pattern) =>
			matchesCargoWorkspacePattern(pattern, relativePath),
		)
	) {
		return false;
	}
	const members = parseTomlStringArray(workspaceSection, "members");
	return members.some((pattern) =>
		matchesCargoWorkspacePattern(pattern, relativePath),
	);
}

/**
 * Bound a monorepo-hoist walk-up by the session ceiling: when `file` is inside
 * the session cwd, the walk must stop AT the cwd rather than climb past it —
 * matching enforceLspRootCeiling's clamp semantics but avoiding the wasted stat
 * calls of walking past a boundary we would clamp back down anyway. When
 * `file` is outside the session (isolated tests, out-of-session API callers),
 * enforceLspRootCeiling is a no-op, so the walk is left unbounded (`undefined`).
 */
function sessionHoistCeiling(
	sessionCwd: string,
	file: string,
): string | undefined {
	return isSameOrWithin(path.resolve(sessionCwd), path.resolve(file))
		? path.resolve(sessionCwd)
		: undefined;
}

function RustWorkspaceRoot(): RootFunction {
	const crateRoot = createRootDetector(["Cargo.toml", "Cargo.lock"]);
	return async (file: string): Promise<string | undefined> => {
		const root = await crateRoot(file);
		if (!root) return undefined;

		const sessionCwd = process.cwd();
		// The walk-up for an ancestor Cargo.toml with a [workspace] table stays
		// bounded by the same session ceiling the crate-root lookup above already
		// enforces (enforceLspRootCeiling) — a monorepo hoist must never cross the
		// session boundary just because a workspace manifest happens to sit above
		// it (#1671).
		const stop = sessionHoistCeiling(sessionCwd, file);

		let current = root;
		const fsRoot = path.parse(current).root;
		while (true) {
			if (stop !== undefined && current === stop) break;
			const parent = path.dirname(current);
			if (parent === current || parent === fsRoot) break;
			const parentCargoPath = path.join(parent, "Cargo.toml");
			const parentCargoContent = await readTextFileOrUndefined(parentCargoPath);
			if (
				parentCargoContent !== undefined &&
				/^\s*\[workspace\]/m.test(parentCargoContent)
			) {
				// Test membership against the ORIGINAL crate dir (`root`), never the
				// walk cursor (`current`, which may already have climbed through
				// gap directories that have no Cargo.toml of their own) — a
				// `members = ["crates/foo"]` or `["crates/*"]` entry is relative to
				// the workspace root, spanning the whole gap in one hop (#1671 F1).
				if (cargoWorkspaceDeclaresMember(parentCargoContent, parent, root)) {
					return enforceLspRootCeiling(parent, sessionCwd, file);
				}
				// A workspace root exists here but its `members`/`exclude` tables do
				// not claim this crate — stop climbing; the crate stays independently
				// rooted rather than being swept into a workspace it opted out of.
				break;
			}
			current = parent;
		}
		return root;
	};
}

/**
 * Resolve whether `parentPomPath`'s <modules> block declares `childDir` as one
 * of its member modules. Maven multi-module hoisting must only chain through
 * poms that actually declare the child (an undeclared sibling directory that
 * merely happens to sit next to a parent pom stays independently rooted) —
 * this is the "Maven module-chain verification" #1671 asks for, as opposed to
 * rust-analyzer's simpler "any ancestor [workspace] wins" hoist.
 */
/**
 * Strip XML comments to a fixed point rather than in one pass: a single
 * `.replace()` can leave a residual `<!--` behind on adversarially-nested
 * input (CodeQL flags this class as "incomplete multi-character
 * sanitization" — the removal of one comment can expose a delimiter that
 * was itself inside another). Looping until nothing changes closes that gap.
 */
function stripXmlComments(content: string): string {
	let result = content;
	let previous: string;
	do {
		previous = result;
		result = result.replace(/<!--[\s\S]*?-->/g, "");
	} while (result !== previous);
	return result;
}

async function declaresMavenModule(
	parentDir: string,
	parentPomPath: string,
	childDir: string,
): Promise<boolean> {
	try {
		const content = stripXmlComments(await readFile(parentPomPath, "utf-8"));
		const modulesBlock = content.match(/<modules>([\s\S]*?)<\/modules>/);
		if (!modulesBlock) return false;
		const resolvedChild = path.resolve(childDir);
		for (const match of modulesBlock[1].matchAll(
			/<module>\s*([^<]+?)\s*<\/module>/g,
		)) {
			// Case-insensitive / realpath-aware compare (#1671 F8): a declared
			// `<module>Foo</module>` must still match a directory actually named
			// `foo` on a case-insensitive filesystem, the same class of check the
			// rest of this codebase does via `pathsEqual` (#1139/#1150).
			if (pathsEqual(path.resolve(parentDir, match[1]), resolvedChild))
				return true;
		}
		return false;
	} catch {
		return false;
	}
}

function JavaWorkspaceRoot(): RootFunction {
	const moduleRoot = createRootDetector([
		"pom.xml",
		"build.gradle",
		".classpath",
	]);
	return async (file: string): Promise<string | undefined> => {
		const root = await moduleRoot(file);
		if (!root) return undefined;
		// Only a Maven (pom.xml) module chain-hoists here — Gradle/.classpath module
		// roots are returned as found; multi-module Gradle wiring (settings.gradle)
		// is a different shape and out of scope for #1671.
		if (!(await markerExists(root, "pom.xml"))) return root;

		const sessionCwd = process.cwd();
		const stop = sessionHoistCeiling(sessionCwd, file);

		// `current` is the walk CURSOR — it climbs over gap directories (ones
		// with no pom.xml of their own, e.g. a `<module>sub/dir</module>` entry
		// spanning more than one filesystem level). `lastHop` is the last
		// CONFIRMED module boundary; it is what the next ancestor pom's
		// <modules> must declare, and it is what actually gets returned — never
		// the cursor, which can land on a bare gap directory that is not itself
		// a valid module root (#1671 F2).
		let current = root;
		let lastHop = root;
		const fsRoot = path.parse(current).root;
		while (true) {
			if (stop !== undefined && current === stop) break;
			const parent = path.dirname(current);
			if (parent === current || parent === fsRoot) break;
			if (await markerExists(parent, "pom.xml")) {
				const parentPom = path.join(parent, "pom.xml");
				if (!(await declaresMavenModule(parent, parentPom, lastHop))) break;
				current = parent;
				lastHop = parent;
				continue;
			}
			// No pom.xml here — a gap directory, not a module boundary. Keep
			// climbing without advancing `lastHop`.
			current = parent;
		}
		return enforceLspRootCeiling(lastHop, sessionCwd, file);
	};
}

export const RustServer: LSPServerInfo = {
	id: "rust",
	name: "rust-analyzer",
	extensions: KIND_EXTENSIONS["rust"],
	// No FileDirRoot fallback (#201): rust-analyzer is a heavy workspace server
	// that is useless without a Cargo manifest. With the fallback, every .rs file
	// written before a Cargo.toml exists resolved to its OWN directory as the
	// root, and since clients dedup by `${serverId}:${root}`, each directory
	// spawned a separate rust-analyzer (one per file/dir during scaffolding).
	// Returning undefined here skips the spawn until a Cargo.toml gives a stable,
	// shared crate root — then all files share one server.
	root: RustWorkspaceRoot(),
	async spawn(root, options) {
		// Prefer rustup-installed rust-analyzer; fall back to GitHub-downloaded
		// managed copy. Canonical-bin discovery (#241): include ~/.cargo/bin so a
		// cargo/rustup-managed rust-analyzer resolves before paying for a download
		// even when ~/.cargo/bin isn't on PATH.
		const result = await resolveAndLaunch(
			{
				candidates: cargoBinCandidates("rust-analyzer"),
				args: [],
				cwd: root,
				managedToolId: "rust-analyzer",
			},
			options?.allowInstall,
		);
		if (!result) return undefined;
		return {
			...result,
			initialization: {
				cargo: { buildScripts: { enable: true } },
				procMacro: { enable: true },
				diagnostics: { enable: true },
			},
		};
	},
};

export const RubyServer: LSPServerInfo = {
	id: "ruby",
	name: "Ruby LSP",
	extensions: KIND_EXTENSIONS["ruby"],
	root: RootWithFallback(
		PriorityRoot([["Gemfile", ".ruby-version"], [".git"]]),
	),
	// Ruby LSP may need extra time to finish composed-bundle setup before it can
	// answer initialize/documentSymbol on cold start.
	initializeTimeoutMs: 30_000,
	clientWaitTimeoutMs: 30_000,
	async spawn(root, options) {
		// Try ruby-lsp first, then solargraph, then rubocop --lsp
		// Each has different args so we can't use a single resolveAndLaunch call
		const rubylsp = await resolveAndLaunch(
			{
				candidates: ["ruby-lsp", ...rubyBinCandidates("ruby-lsp")],
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "gem",
					install: () => tryGemInstall("ruby-lsp"),
					retryCandidates: ["ruby-lsp", ...rubyBinCandidates("ruby-lsp")],
				},
			},
			options?.allowInstall,
		);
		if (rubylsp) return rubylsp;

		// Solargraph fallback
		const solargraph = await resolveAndLaunch(
			{
				candidates: ["solargraph", ...rubyBinCandidates("solargraph")],
				args: ["stdio"],
				cwd: root,
			},
			false, // don't install solargraph — already tried gem install above
		);
		if (solargraph) return solargraph;

		// rubocop --lsp fallback
		return resolveAndLaunch(
			{
				candidates: ["rubocop", ...rubyBinCandidates("rubocop")],
				args: ["--lsp"],
				cwd: root,
			},
			false,
		);
	},
};

// NOTE: Ruby's Solargraph + RuboCop fallbacks live INSIDE RubyServer.spawn
// (ruby-lsp → solargraph → rubocop --lsp). Primary selection is first-success-
// wins (one server per file, see LSPService.getClientForFile), so a separate
// solargraph sibling server could never be reached — RubyServer only returns
// undefined when solargraph is also absent. A standalone RubySolargraphServer
// would therefore be dead code; it intentionally does not exist. If a future
// user-selectable preferred-server config lands, refactor RubyServer to a
// single binary and register the alternatives as siblings (cf. python/jedi).

export const PHPServer: LSPServerInfo = {
	id: "php",
	name: "Intelephense",
	extensions: KIND_EXTENSIONS["php"],
	root: RootWithFallback(
		createRootDetector(["composer.json", "composer.lock"]),
	),
	async spawn(root, options) {
		const result = await resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "intelephense"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "intelephense",
			},
			options?.allowInstall,
		);
		if (!result) return undefined;
		return {
			...result,
			initialization: {
				storagePath: path.join(getGlobalPiLensDir(), "intelephense"),
			},
		};
	},
};

// PowerShell Editor Services bootstrap (#278). Builds the `pwsh`/`powershell`
// args that launch the bundled Start-EditorServices.ps1 over stdio. Param set
// verified against the PSES v4.6.0 bundle. Each spawn gets a private session dir
// for the required Log/SessionDetails paths.
function buildPsesArgs(bundleDir: string): string[] {
	const script = path.join(
		bundleDir,
		"PowerShellEditorServices",
		"Start-EditorServices.ps1",
	);
	const sessionDir = path.join(
		getGlobalPiLensDir(),
		"pses",
		`${process.pid}-${Date.now()}`,
	);
	mkdirSync(sessionDir, { recursive: true });
	const logPath = path.join(sessionDir, "pses.log");
	const sessionDetailsPath = path.join(sessionDir, "session.json");
	// Use -File with each PSES parameter as a SEPARATE argv element (the canonical
	// editor launch form). This deliberately avoids `-Command "& '...'"`: pwsh.exe
	// commonly lives under "C:\Program Files\…" (a space), which forces launchLSP's
	// Windows shell path, and an embedded `&`/quotes in a single -Command string
	// gets mangled by cmd.exe. Plain argv tokens survive shell escaping (our paths
	// are under ~/.pi-lens, no spaces). -Stdio makes PSES speak LSP over this
	// process's stdin/stdout; -LanguageServiceOnly skips the debug adapter.
	return [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		// Unsigned bundled script + mark-of-the-web on Windows — Bypass so it runs;
		// ignored by non-Windows pwsh.
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		script,
		"-HostName",
		"pi-lens",
		"-HostProfileId",
		"pi-lens",
		"-HostVersion",
		"1.0.0",
		"-BundledModulesPath",
		bundleDir,
		"-LogPath",
		logPath,
		"-LogLevel",
		"Warning",
		"-SessionDetailsPath",
		sessionDetailsPath,
		"-Stdio",
		"-LanguageServiceOnly",
	];
}

export const PowerShellServer: LSPServerInfo = {
	id: "powershell",
	name: "PowerShell Editor Services",
	extensions: KIND_EXTENSIONS["powershell"],
	// Index at the workspace (script modules reference siblings); fall back to the
	// file dir.
	root: RootWithFallback(createRootDetector([".git"])),
	spawn(root, options) {
		// PSES is a module bundle launched via pwsh, not a binary on PATH. Resolve
		// pwsh/powershell + the managed bundle, then launch the bootstrap over
		// stdio. Graceful skip (→ coverage notice) when pwsh or the bundle is
		// unavailable; psscriptanalyzer remains the fallback in the dispatch group.
		return resolveAndLaunchBundle(
			{
				runtimeCandidates: ["pwsh", "powershell"],
				bundleToolId: "powershell-editor-services",
				cwd: root,
				args: buildPsesArgs,
			},
			options?.allowInstall,
		);
	},
};

export const CSharpServer: LSPServerInfo = {
	id: "csharp",
	name: "csharp-ls",
	extensions: KIND_EXTENSIONS["csharp"],
	// No FileDirRoot fallback (#201): csharp-ls is a workspace server and should
	// not spawn once per source directory before a .sln/.csproj exists. Glob root
	// markers match real project filenames such as `App.csproj` / `App.sln`
	// (shared marker list — see file-kinds.ts, refs #895).
	root: createRootDetector([...DOTNET_CSHARP_ROOT_MARKERS]),
	async spawn(root, options) {
		const candidates = dotnetToolCandidates("csharp-ls");

		return resolveAndLaunch(
			{
				candidates,
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "dotnet",
					install: () => tryDotnetToolInstall("csharp-ls"),
					retryCandidates: candidates,
				},
			},
			options?.allowInstall,
		);
	},
};

export const OmniSharpServer = createInteractiveServer({
	id: "omnisharp",
	name: "OmniSharp",
	fallbackFor: "csharp",
	extensions: KIND_EXTENSIONS["csharp"],
	root: createRootDetector([...DOTNET_CSHARP_ROOT_MARKERS]),
	language: "csharp",
	command: "OmniSharp",
	args: ["--languageserver"],
});

export const FSharpServer: LSPServerInfo = {
	id: "fsharp",
	name: "FSAutocomplete",
	extensions: KIND_EXTENSIONS["fsharp"],
	root: createRootDetector([...DOTNET_FSHARP_ROOT_MARKERS]),
	async spawn(root, options) {
		// fsautocomplete is a `dotnet tool` (#241), exactly like csharp-ls: prefer a
		// managed/.dotnet-tools copy, else `dotnet tool install` when the .NET SDK
		// is on PATH. dotnetToolCandidates covers the install target so the retry
		// resolves it.
		const candidates = dotnetToolCandidates("fsautocomplete");
		return resolveAndLaunch(
			{
				candidates,
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "dotnet",
					install: () => tryDotnetToolInstall("fsautocomplete"),
					retryCandidates: candidates,
				},
			},
			options?.allowInstall,
		);
	},
};

export const JavaServer = createInteractiveServer({
	id: "java",
	name: "JDT Language Server",
	extensions: KIND_EXTENSIONS["java"],
	root: RootWithFallback(JavaWorkspaceRoot()),
	language: "java",
	command: () => process.env.JDTLS_PATH || "jdtls",
	args: (root) => createLombokJdtlsArgs(root),
	runtime: "java",
});

export const KotlinServer: LSPServerInfo = {
	id: "kotlin",
	name: "Kotlin Language Server",
	extensions: KIND_EXTENSIONS["kotlin"],
	root: RootWithFallback(
		createRootDetector(["build.gradle.kts", "build.gradle", "pom.xml"]),
	),
	async spawn(root, options) {
		// Prefer the newer official Kotlin LSP CLI when available, but keep
		// compatibility with the older fwcd kotlin-language-server command.
		return resolveAndLaunch(
			{
				candidates: ["kotlin-lsp", "kotlin-language-server"],
				args: [],
				cwd: root,
			},
			options?.allowInstall,
		);
	},
};

export const SwiftServer = createInteractiveServer({
	id: "swift",
	name: "SourceKit-LSP",
	extensions: KIND_EXTENSIONS["swift"],
	root: createRootDetector(["Package.swift"]),
	language: "swift",
	command: "sourcekit-lsp",
});

export const DartServer = createInteractiveServer({
	id: "dart",
	name: "Dart Analysis Server",
	extensions: KIND_EXTENSIONS["dart"],
	root: RootWithFallback(createRootDetector(["pubspec.yaml"])),
	language: "dart",
	command: "dart",
	args: ["language-server", "--protocol=lsp"],
});

/**
 * Build an {@link LSPServerInfo} for a language server that ships as a
 * self-contained native TREE BUNDLE (single archive, `bin/<binary>` inside,
 * no external runtime — clangd #241, lua-language-server #564, and the
 * kotlin-language-server/elixir-ls follow-on #565). Extracted once both
 * `CppServer` and `LuaServer` turned out to be a near-verbatim structural
 * copy of each other (same `resolveAndLaunchTreeBinary` call shape) —
 * flagged by SonarCloud's new-code duplication gate on PR #567 — so a third
 * and fourth server of this shape (#565) can call this instead of
 * copy-pasting a `spawn` again. Each server's own "why archive-tree, why
 * stripComponents differs, etc." explanation stays as a comment at its own
 * call site below, since that reasoning is genuinely per-server.
 */
function createTreeBinaryServer(spec: {
	id: string;
	name: string;
	extensions: readonly string[];
	root: RootFunction;
	/** PATH candidate + managed bundle tool id, e.g. "clangd", "lua-language-server". */
	binaryName: string;
	/** Path to the executable inside the extracted bundle, e.g. "bin/clangd". */
	binRelPath: string;
	args?: string[];
}): LSPServerInfo {
	return {
		id: spec.id,
		name: spec.name,
		extensions: spec.extensions,
		root: spec.root,
		spawn(root, options) {
			return resolveAndLaunchTreeBinary(
				{
					candidates: [spec.binaryName],
					bundleToolId: spec.binaryName,
					binRelPath: spec.binRelPath,
					cwd: root,
					args: spec.args ?? [],
				},
				options?.allowInstall,
			);
		},
	};
}

// lua-language-server ships the same self-contained native TREE BUNDLE shape
// as clangd (#241/#564): bin/lua-language-server + bundled locale/meta files,
// no external runtime. Prefer a system install on PATH; else auto-install the
// managed bundle and launch bin/lua-language-server within it. Graceful skip
// when neither is available (→ coverage notice).
export const LuaServer: LSPServerInfo = createTreeBinaryServer({
	id: "lua",
	name: "Lua Language Server",
	extensions: KIND_EXTENSIONS["lua"],
	root: createRootDetector([".luarc.json", ".luacheckrc"]),
	binaryName: "lua-language-server",
	binRelPath: "bin/lua-language-server",
});

// clangd ships a self-contained native tree bundle (bin/clangd + bundled
// libclang headers). Prefer a system clangd on PATH; else auto-install the
// managed bundle (#241) and launch bin/clangd within it. Graceful skip when
// neither is available (→ coverage notice); cpp-check stays the fallback.
export const CppServer: LSPServerInfo = createTreeBinaryServer({
	id: "cpp",
	name: "clangd",
	extensions: KIND_EXTENSIONS["cxx"],
	root: RootWithFallback(
		createRootDetector([
			"compile_commands.json",
			".clangd",
			"CMakeLists.txt",
			"Makefile",
		]),
	),
	binaryName: "clangd",
	binRelPath: "bin/clangd",
	args: ["--background-index"],
});

export const ZigServer: LSPServerInfo = {
	id: "zig",
	name: "ZLS",
	extensions: KIND_EXTENSIONS["zig"],
	root: RootWithFallback(createRootDetector(["build.zig"])),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["zls"],
				args: [],
				cwd: root,
				managedToolId: "zls",
			},
			options?.allowInstall,
		);
	},
};

export const HaskellServer = createInteractiveServer({
	id: "haskell",
	name: "Haskell Language Server",
	extensions: KIND_EXTENSIONS["haskell"],
	root: createRootDetector(["stack.yaml", "cabal.project", "*.cabal"]),
	language: "haskell",
	command: "haskell-language-server-wrapper",
	args: ["--lsp"],
});

export const ElixirServer = createInteractiveServer({
	id: "elixir",
	name: "ElixirLS",
	extensions: KIND_EXTENSIONS["elixir"],
	root: RootWithFallback(createRootDetector(["mix.exs"])),
	language: "elixir",
	command: "elixir-ls",
});

export const ElixirExpertServer: LSPServerInfo = {
	id: "expert",
	name: "Expert",
	fallbackFor: "elixir",
	extensions: KIND_EXTENSIONS["elixir"],
	root: RootWithFallback(createRootDetector(["mix.exs"])),
	availabilityKey: "expert",
	async spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["expert"],
				args: ["--stdio"],
				cwd: root,
				managedToolId: "expert",
			},
			options?.allowInstall,
		);
	},
	autoInstall: async () => Boolean(await ensureTool("expert")),
};

export const GleamServer: LSPServerInfo = {
	id: "gleam",
	name: "Gleam LSP",
	extensions: KIND_EXTENSIONS["gleam"],
	root: RootWithFallback(createRootDetector(["gleam.toml"])),
	async spawn(root, options) {
		// Prefer a PATH `gleam` (full toolchain); fall back to the managed
		// GitHub-release binary. `gleam lsp` is the server entrypoint either way.
		return resolveAndLaunch(
			{
				candidates: ["gleam"],
				args: ["lsp"],
				cwd: root,
				managedToolId: "gleam",
			},
			options?.allowInstall,
		);
	},
};

export const MarksmanServer: LSPServerInfo = {
	id: "marksman",
	name: "Marksman",
	extensions: KIND_EXTENSIONS["markdown"],
	// Index at the workspace root so cross-file checks (broken intra-repo links,
	// missing/renamed anchors, heading refs) see the whole tree; fall back to the
	// file's directory when there's no project marker.
	root: RootWithFallback(createRootDetector([".marksman.toml", ".git"])),
	spawn(root, options) {
		// Prefer a PATH `marksman`; fall back to the managed GitHub-release binary.
		// `marksman server` is the stdio LSP entrypoint either way.
		return resolveAndLaunch(
			{
				candidates: ["marksman"],
				args: ["server"],
				cwd: root,
				managedToolId: "marksman",
			},
			options?.allowInstall,
		);
	},
};

export const OCamlServer = createInteractiveServer({
	id: "ocaml",
	name: "ocamllsp",
	extensions: KIND_EXTENSIONS["ocaml"],
	root: createRootDetector(["dune-project", "opam"]),
	language: "ocaml",
	command: "ocamllsp",
});

export const ClojureServer: LSPServerInfo = {
	id: "clojure",
	name: "Clojure LSP",
	extensions: KIND_EXTENSIONS["clojure"],
	root: createRootDetector(["deps.edn", "project.clj"]),
	async spawn(root, options) {
		// Prefer a PATH `clojure-lsp`; fall back to the managed self-contained
		// native (GraalVM) GitHub-release binary — no JVM needed either way.
		return resolveAndLaunch(
			{
				candidates: ["clojure-lsp"],
				args: [],
				cwd: root,
				managedToolId: "clojure-lsp",
			},
			options?.allowInstall,
		);
	},
};

export const CueServer: LSPServerInfo = {
	id: "cue",
	name: "CUE Language Server",
	extensions: KIND_EXTENSIONS["cue"],
	root: RootWithFallback(createRootDetector(["cue.mod", ".git"])),
	async spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["cue"],
				args: ["lsp", "serve"],
				cwd: root,
				managedToolId: "cue",
			},
			options?.allowInstall,
		);
	},
};

export const TerraformServer: LSPServerInfo = {
	id: "terraform",
	name: "Terraform LSP",
	extensions: KIND_EXTENSIONS["terraform"],
	root: RootWithFallback(
		createRootDetector([".terraform.lock.hcl", ".terraform"]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["terraform-ls"],
				args: ["serve"],
				cwd: root,
				managedToolId: "terraform-ls",
			},
			options?.allowInstall,
		);
	},
};

export const NixServer = createInteractiveServer({
	id: "nix",
	name: "nixd",
	extensions: KIND_EXTENSIONS["nix"],
	root: createRootDetector(["flake.nix"]),
	language: "nix",
	command: "nixd",
});

export const BashServer: LSPServerInfo = {
	id: "bash",
	name: "Bash Language Server",
	extensions: [".bash", ".sh", ".zsh"],
	root: FileDirRoot,
	// #2194 bounded the installer's own verification at 20s; the dispatch
	// touch's client-wait floor stayed at the shared 5s default, so a cold
	// spawn could still race that budget and read as unavailable even after
	// installer verification cleared it. Match the installer bound (#2169).
	// `initializeTimeoutMs` matches it too: the measured cold start
	// (9,667ms, #2194) has headroom under the unraised 15s default, but
	// leaving the two fields mismatched is the same latent shape that made
	// the Prisma/Vue raise a no-op (fix-round F1, #2233) — a slower host
	// than the one measured would still hit the 15s inner kill despite the
	// caller being willing to wait 20s. Equalizing costs nothing on the
	// success path and removes the mismatch outright.
	clientWaitTimeoutMs: 20_000,
	initializeTimeoutMs: 20_000,
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "bash-language-server"),
				args: ["start"],
				cwd: root,
				managedToolId: "bash-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const FishServer: LSPServerInfo = {
	id: "fish",
	name: "Fish Language Server",
	extensions: KIND_EXTENSIONS["fish"],
	root: RootWithFallback(createRootDetector([".git"])),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "fish-lsp"),
				args: ["start"],
				cwd: root,
				managedToolId: "fish-lsp",
			},
			options?.allowInstall,
		);
	},
};

export const CMakeServer: LSPServerInfo = {
	id: "cmake",
	name: "CMake Language Server",
	// CMake's canonical project file has no .cmake suffix. The configured-server
	// matcher supports exact basenames as well as extensions.
	extensions: [...KIND_EXTENSIONS["cmake"], "CMakeLists.txt"],
	root: RootWithFallback(createRootDetector(["CMakeLists.txt", ".git"])),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["cmake-language-server"],
				args: [],
				cwd: root,
				managedToolId: "cmake-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const DockerServer: LSPServerInfo = {
	id: "docker",
	name: "Dockerfile Language Server",
	extensions: [".dockerfile", "Dockerfile"],
	root: RootWithFallback(
		PriorityRoot([
			[
				"docker-compose.yml",
				"docker-compose.yaml",
				"compose.yml",
				"compose.yaml",
			],
			[".git"],
		]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "docker-langserver"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "dockerfile-language-server-nodejs",
			},
			options?.allowInstall,
		);
	},
};

export const YamlServer: LSPServerInfo = {
	id: "yaml",
	name: "YAML Language Server",
	extensions: KIND_EXTENSIONS["yaml"],
	root: RootWithFallback(
		PriorityRoot([
			[".yamllint", "yamllint.yml", "yamllint.yaml", "pyproject.toml"],
			[".git"],
		]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "yaml-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "yaml-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const JsonServer: LSPServerInfo = {
	id: "json",
	name: "VSCode JSON Language Server",
	extensions: KIND_EXTENSIONS["json"],
	root: RootWithFallback(
		WorkspacePriorityRoot([
			["package.json", "tsconfig.json", "jsconfig.json"],
			[".git"],
		]),
	),
	// See BashServer above: the installer's 20s verification bound (#2194)
	// does not, on its own, raise the dispatch touch's cold-spawn wait floor.
	// Mirror it here so a cold spawn cannot lose that race either (#2169).
	// `initializeTimeoutMs` matches it for the same reason as BashServer
	// above (fix-round F1, #2233).
	clientWaitTimeoutMs: 20_000,
	initializeTimeoutMs: 20_000,
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["vscode-json-language-server"],
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-json-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const HtmlServer: LSPServerInfo = {
	id: "html",
	name: "VSCode HTML Language Server",
	extensions: KIND_EXTENSIONS["html"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			PriorityRoot([["package.json", "index.html", "vite.config.ts"]]),
		),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vscode-html-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-html-languageserver-bin",
			},
			options?.allowInstall,
		);
	},
};

export const TomlServer: LSPServerInfo = {
	id: "toml",
	name: "Taplo",
	extensions: KIND_EXTENSIONS["toml"],
	root: RootWithFallback(
		PriorityRoot([["pyproject.toml", "Cargo.toml", "taplo.toml"], [".git"]]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["taplo"],
				args: ["lsp", "stdio"],
				cwd: root,
				managedToolId: "taplo",
			},
			options?.allowInstall,
		);
	},
};

export const PrismaServer: LSPServerInfo = {
	id: "prisma",
	name: "Prisma Language Server",
	extensions: KIND_EXTENSIONS["prisma"],
	root: RootWithFallback(
		createRootDetector(["prisma/schema.prisma", "schema.prisma"]),
	),
	// Matches the installer's 40s verification bound above (#2169): the
	// dispatch touch's cold-spawn wait floor defaults to 5s and would
	// otherwise time the client out well before the binary answers.
	// `initializeTimeoutMs` MUST be set alongside it (RubyServer's own
	// precedent below): unset, it falls back to the 15s
	// `INITIALIZE_TIMEOUT_MS` default in `clients/lsp/client.ts`, which
	// hard-kills the child mid-handshake — a real cold Prisma run measured
	// up to 27.3s, so the spawn would die there before this wait ever gets
	// a chance to matter (fix-round F1, #2233).
	clientWaitTimeoutMs: 40_000,
	initializeTimeoutMs: 40_000,
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "prisma-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "@prisma/language-server",
			},
			options?.allowInstall,
		);
	},
};

// --- Web Framework & Styling Servers ---

export const VueServer: LSPServerInfo = {
	id: "vue",
	name: "Vue Language Server",
	extensions: [".vue"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			createRootDetector([
				"package.json",
				"package-lock.json",
				"bun.lockb",
				"bun.lock",
				"pnpm-lock.yaml",
				"yarn.lock",
			]),
		),
	),
	// Vue's launcher loads the full language-service bundle before answering,
	// matching the installer's 30s verification bound (#2176). The dispatch
	// touch's cold-spawn wait floor defaults to 5s and needs the same raise so
	// a cold spawn cannot time out there instead. `initializeTimeoutMs` MUST
	// match: unset, it falls back to the 15s default in `clients/lsp/client.ts`
	// and hard-kills a cold spawn (measured up to 22.6s in #2188, 16.2s here)
	// mid-handshake before this wait can matter (fix-round F1, #2233).
	clientWaitTimeoutMs: 30_000,
	initializeTimeoutMs: 30_000,
	async spawn(root, options) {
		const tsserverPath = await findTsserverPath(root, options?.allowInstall);

		// Vue Language Server needs Vue dependencies installed to resolve types.
		// Without node_modules, navigation requests will timeout or return empty.
		const hasPackageJson = existsSync(path.join(root, "package.json"));
		const hasNodeModules = existsSync(path.join(root, "node_modules"));
		if (hasPackageJson && !hasNodeModules) {
			logSessionStart(
				`lsp vue: node_modules missing in ${root} — Vue navigation may be limited. ` +
					`Run: npm install (or pnpm/yarn install) in this project.`,
			);
		}

		const proc = await resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vue-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "@vue/language-server",
			},
			options?.allowInstall,
		);
		if (!proc) return undefined;
		return {
			process: proc.process,
			source: proc.source,
			initialization: tsserverPath
				? { typescript: { tsdk: path.dirname(tsserverPath) } }
				: undefined,
		};
	},
};

export const SvelteServer: LSPServerInfo = {
	id: "svelte",
	name: "Svelte Language Server",
	extensions: [".svelte"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			createRootDetector([
				"package.json",
				"package-lock.json",
				"bun.lockb",
				"bun.lock",
				"pnpm-lock.yaml",
				"yarn.lock",
			]),
		),
	),
	// Matches the installer's 20s verification bound above (#2169): the
	// dispatch touch's cold-spawn wait floor defaults to 5s and would
	// otherwise time the client out well before the binary answers.
	// `initializeTimeoutMs` matches it for the same reason as BashServer
	// above (fix-round F1, #2233).
	clientWaitTimeoutMs: 20_000,
	initializeTimeoutMs: 20_000,
	async spawn(root, options) {
		const tsserverPath = await findTsserverPath(root, options?.allowInstall);
		const proc = await resolveAndLaunch(
			{
				candidates: [
					...nodeBinCandidates(root, "svelteserver"),
					...nodeBinCandidates(root, "svelte-language-server"),
				],
				args: ["--stdio"],
				cwd: root,
				managedToolId: "svelte-language-server",
			},
			options?.allowInstall,
		);
		if (!proc) return undefined;
		return {
			process: proc.process,
			source: proc.source,
			initialization: tsserverPath
				? { typescript: { tsdk: path.dirname(tsserverPath) } }
				: undefined,
		};
	},
};

export const CssServer: LSPServerInfo = {
	id: "css",
	name: "CSS Language Server",
	extensions: KIND_EXTENSIONS["css"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			PriorityRoot([
				[
					"package.json",
					"postcss.config.js",
					"tailwind.config.js",
					"vite.config.ts",
				],
			]),
		),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vscode-css-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-css-languageserver",
			},
			options?.allowInstall,
		);
	},
};

// --- Registry ---

// Opengrep — a cross-language security scanner that speaks LSP. Unlike the
// per-language servers it attaches to MANY file kinds (the aggregation layer
// merges its diagnostics with the file's real language server). Running it as a
// warm LSP server compiles the ruleset once per session instead of paying it on
// every file (the ~8s CLI-per-file cost #111), bringing per-file scans to ~1.3s.
// Rules load via `initializationOptions.scan.configuration` (a local rule file
// if the repo has one, else Opengrep's login-free `auto` set).
const OPENGREP_KINDS = [
	"csharp",
	"css",
	"cxx",
	"dart",
	"docker",
	"go",
	"html",
	"java",
	"json",
	"jsts",
	"kotlin",
	"lua",
	"php",
	"python",
	"ruby",
	"rust",
	"shell",
	"swift",
	"terraform",
	"yaml",
] as const;
const OPENGREP_EXTENSIONS: readonly string[] = Array.from(
	new Set(
		OPENGREP_KINDS.flatMap(
			(k) => (KIND_EXTENSIONS as Record<string, readonly string[]>)[k] ?? [],
		),
	),
);

function opengrepInitialization(root: string): Record<string, unknown> {
	// As an always-on LSP server, enablement is structural (the server is
	// registered); resolveOpengrepConfig here only chooses WHICH rules — a local
	// rule file if present, otherwise `auto`.
	const resolved = resolveOpengrepConfig(root, { enabled: true });
	return {
		scan: {
			configuration: [resolved.configArg ?? "auto"],
			onlyGitDirty: false,
			jobs: 16,
		},
		metrics: { enabled: false },
		doHover: false,
	};
}

export const OpengrepServer: LSPServerInfo = {
	id: "opengrep",
	name: "Opengrep Security Scanner",
	role: "auxiliary",
	extensions: OPENGREP_EXTENSIONS,
	// Stable per-repo root so ONE warm server serves the whole project (a
	// per-directory root would spawn a fresh server — and re-pay rule load —
	// for every folder).
	root: RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
	availabilityKey: "opengrep",
	// Rule compilation can take a few seconds on the first scan of a session.
	initializeTimeoutMs: 15000,
	async spawn(root, options) {
		const launched = await resolveAndLaunch(
			{
				candidates: ["opengrep"],
				args: ["lsp", "--experimental"],
				cwd: root,
				managedToolId: "opengrep",
			},
			options?.allowInstall,
		);
		if (!launched) return undefined;
		return { ...launched, initialization: opengrepInitialization(root) };
	},
	autoInstall: async () => Boolean(await ensureTool("opengrep")),
};

// ast-grep — a polyglot structural linter that speaks LSP. Like Opengrep it is a
// cross-cutting, diagnostic-only auxiliary (never a file's primary language
// server). It attaches EVERYWHERE (#239 Phase 2): a project `sgconfig.y[a]ml`
// surfaces the team's OWN curated rules (auto-discovered), and absent one it
// launches with `--config <shipped baseline>` so pi-lens's bundled ruleset runs
// anyway — superseding the in-process napi runner, which steps aside when this
// server's binary is available (and resumes as the fallback when it isn't —
// Gate B). NOTE: the napi runner is NOT a subset — it delegates to napi's native
// engine via root.findAll({rule}) (#206), the SAME Rust core as this LSP and the
// ast-grep CLI, so rule semantics are identical across all three. The LSP's edge
// is engine-driven codeAction fixes, not faithfulness of matching. #2347 closed
// the one known divergence under Gate B: the LSP/CLI resolve embedded `<script>`
// bodies in HTML and run `language: JavaScript` rules inside them, and the napi
// fallback now mirrors that (each script body is reparsed as JS and findings are
// translated back to file coordinates). A future ast-grep embedded-content
// surface (for example `<style>` bodies, which 0.45.1 does NOT inject) must land
// on both routes together or be recorded here as an accepted divergence.
const AST_GREP_KINDS = [
	"csharp",
	"cxx",
	"css",
	"elixir",
	"go",
	"haskell",
	"html",
	"java",
	"json",
	"jsts",
	"kotlin",
	"lua",
	"nix",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"shell",
	"solidity",
	"swift",
	"yaml",
] as const;
const AST_GREP_EXTENSIONS: readonly string[] = Array.from(
	new Set(
		AST_GREP_KINDS.flatMap(
			(k) => (KIND_EXTENSIONS as Record<string, readonly string[]>)[k] ?? [],
		),
	),
);

export const AstGrepServer: LSPServerInfo = {
	id: "ast-grep",
	name: "ast-grep structural linter",
	role: "auxiliary",
	extensions: AST_GREP_EXTENSIONS,
	// Attaches everywhere (#239 Phase 2): prefer a project `sgconfig.y[a]ml` root,
	// else the repo root (.git) or cwd — like Opengrep. When there's no project
	// sgconfig the spawn launches with `--config <shipped baseline>` so the team's
	// rules still run; the napi runner steps aside when this server is available
	// (it falls back to napi when the ast-grep binary is absent — Gate B).
	root: RootWithFallback(
		createRootDetector(["sgconfig.yml", "sgconfig.yaml"]),
		RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
	),
	availabilityKey: "ast-grep",
	// #1714: the one auxiliary with a measured wedge ceiling. A `lens_diagnostics
	// mode=full` sweep of 225 files drove this server into an unrecoverable stall
	// twice in two exposures (writes outstanding 5.9 s and 9.4 s, then a forced
	// shutdown that timed out both the request and the exit notify). It re-parses
	// the whole file on every didOpen, so it absorbs a sweep more slowly than the
	// other scanners — hold it to half the shared default.
	notifyInflightLimit: 4,
	// First scan of a session compiles the rules.
	initializeTimeoutMs: 15000,
	async spawn(root, options) {
		// A project sgconfig wins (the team's curated ruleset, auto-discovered from
		// cwd). Otherwise point `--config` at pi-lens's shipped baseline ruleset.
		const projectSgconfig = findLocalSgconfig(root);
		let args = ["lsp"];
		if (!projectSgconfig) {
			const baseline = resolveBaselineSgconfig(root);
			if (baseline) args = ["lsp", "--config", baseline];
		}
		// #472: prefer the platform-native exe directly (one less orphanable
		// node-bin-wrapper layer). Prepended as the first candidate; falls back
		// to the existing "ast-grep" PATH/global-bin resolution when the
		// optional native package isn't installed for this platform/arch.
		const nativeExe = resolveAstGrepNativeExe();
		const candidates = nativeExe ? [nativeExe, "ast-grep"] : ["ast-grep"];
		return resolveAndLaunch(
			{
				candidates,
				args,
				cwd: root,
				managedToolId: "ast-grep",
			},
			options?.allowInstall,
		);
	},
	autoInstall: async () => Boolean(await ensureTool("ast-grep")),
};

// zizmor — a GitHub Actions workflow-security scanner that speaks LSP (#272).
// Like Opengrep/ast-grep it is a cross-cutting, diagnostic-only auxiliary. Its
// extension match (any YAML) is intentionally broad — actual candidacy is
// narrowed by `pathFilter` (`isZizmorAuditTarget`, #636) to the exact paths
// zizmor's own input collection audits (`.github/workflows/*`, `action.yml`,
// `.github/dependabot.yaml`); every other YAML file is a guaranteed no-op —
// measured directly against a real `zizmor --lsp` process, a non-matching
// file gets NO `publishDiagnostics` at all, so without the path gate every
// edit of e.g. a `docker-compose.yml` would burn zizmor's full
// diagnostics-wait budget for zero signal. Its audit set ("regular" persona)
// is compiled-in and runs with NO config; a repo `zizmor.yml` only
// tunes/ignores rules (the blocking opt-in, see the auxiliary profile).
// Online audits (known-vulnerable-actions, unpinned-uses, …) need a GitHub
// token — resolveZizmorGitHubToken forwards one (env, else `gh auth token`);
// without it zizmor runs its offline audit subset.
const ZIZMOR_EXTENSIONS: readonly string[] = KIND_EXTENSIONS["yaml"];

export const ZizmorServer: LSPServerInfo = {
	id: "zizmor",
	name: "zizmor Actions Security Scanner",
	role: "auxiliary",
	extensions: ZIZMOR_EXTENSIONS,
	pathFilter: isZizmorAuditTarget,
	// Stable per-repo root so ONE warm server serves the whole project (like
	// Opengrep) — config + workflow discovery is repo-relative.
	root: RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
	availabilityKey: "zizmor",
	async spawn(root, options) {
		// Forward a token so the online audits run; absent one, zizmor self-selects
		// offline mode (the env vars + `gh auth token` are resolved once and merged
		// over process.env by launchLSP).
		const ghToken = await resolveZizmorGitHubToken();
		return resolveAndLaunch(
			{
				candidates: ["zizmor"],
				args: ["--lsp"],
				cwd: root,
				managedToolId: "zizmor",
				...(ghToken ? { env: { GH_TOKEN: ghToken } } : {}),
			},
			options?.allowInstall,
		);
	},
	autoInstall: async () => Boolean(await ensureTool("zizmor")),
};

// typos — a source-code spell checker that speaks LSP (#283). Cross-cutting,
// diagnostic-only auxiliary like Opengrep/ast-grep/zizmor: it attaches to many
// code kinds AND markdown/docs (option B — a spell checker that skips prose
// misses its highest-value target; typos is ALLOW-LIST based, so it only flags
// known misspellings with a known correction, keeping the false-positive rate on
// technical vocab low). Its built-in dictionary is compiled in — NO config needed
// to run; a repo `typos.toml`/`_typos.toml`/`.typos.toml` only tunes the
// dictionary/severity (and is the blocking opt-in, see the auxiliary profile).
// `typos-lsp` takes NO subcommand/flag — it wires stdin/stdout straight into the
// LSP server. Default severity is WARNING, so findings are advisory by default.
const TYPOS_EXTENSIONS: readonly string[] = Array.from(
	new Set([...OPENGREP_EXTENSIONS, ...KIND_EXTENSIONS["markdown"]]),
);

// #967: typos-lsp's `initializationOptions.config` is a filesystem PATH to a
// config file (confirmed against upstream source — crates/typos-lsp/src/lsp.rs
// reads `config` as a string and tilde-expands it into a PathBuf; it is never
// an inline TOML string nor a parsed table). typos-lsp then MERGES that config
// with any repo-local one it discovers itself, with the injected config
// taking precedence on key collisions — so a project's own config must never
// be injected alongside ours (see findLocalTyposConfig below): honoring an
// existing project config means injecting NOTHING, letting typos-lsp read the
// project's file untouched.
function typosInitialization(
	root: string,
): Record<string, unknown> | undefined {
	const localConfig = findLocalTyposConfig(root);
	if (localConfig) {
		logLatency({
			type: "phase",
			phase: "typos_config_resolved",
			filePath: root,
			durationMs: 0,
			metadata: { mode: "project_config", configPath: localConfig },
		});
		logSessionStart(
			`typos config resolved mode=project_config configPath=${localConfig}`,
		);
		return undefined;
	}
	const configPath = resolvePackagePath(
		import.meta.url,
		"rules",
		"typos",
		"_typos.toml",
	);
	logLatency({
		type: "phase",
		phase: "typos_config_resolved",
		filePath: root,
		durationMs: 0,
		metadata: { mode: "injected_default", configPath },
	});
	logSessionStart(
		`typos config resolved mode=injected_default configPath=${configPath}`,
	);
	return { config: configPath };
}

export const TyposServer: LSPServerInfo = {
	id: "typos",
	name: "typos Spell Checker",
	role: "auxiliary",
	extensions: TYPOS_EXTENSIONS,
	// Stable per-repo root so ONE warm server serves the whole project (like the
	// other auxiliaries) — typos.toml discovery is repo-relative.
	root: RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
	availabilityKey: "typos-lsp",
	async spawn(root, options) {
		const launched = await resolveAndLaunch(
			{
				candidates: ["typos-lsp"],
				args: [],
				cwd: root,
				managedToolId: "typos-lsp",
			},
			options?.allowInstall,
		);
		if (!launched) return undefined;
		const initialization = typosInitialization(root);
		return initialization ? { ...launched, initialization } : launched;
	},
	autoInstall: async () => Boolean(await ensureTool("typos-lsp")),
};

export const LSP_SERVERS: LSPServerInfo[] = [
	TypeScriptServer,
	DenoServer,
	PythonServer, // pyright / basedpyright — preferred; openFilesOnly avoids cold-start; ty (#717) is a local-only opt-in fallback
	PythonJediServer, // fallback when neither pyright nor basedpyright is available
	GoServer,
	RustServer,
	RubyServer,
	PHPServer,
	PowerShellServer, // PowerShell Editor Services — pwsh-bootstrapped module bundle (#278)
	CSharpServer,
	OmniSharpServer,
	FSharpServer,
	JavaServer,
	KotlinServer,
	SwiftServer,
	DartServer,
	LuaServer,
	CppServer,
	ZigServer,
	HaskellServer,
	ElixirServer,
	ElixirExpertServer,
	GleamServer,
	MarksmanServer,
	OCamlServer,
	ClojureServer,
	CueServer,
	TerraformServer,
	NixServer,
	BashServer,
	FishServer,
	CMakeServer,
	DockerServer,
	YamlServer,
	JsonServer,
	HtmlServer,
	TomlServer,
	PrismaServer,
	// Web frameworks & styling
	VueServer,
	SvelteServer,
	CssServer,
	// Auxiliary (cross-cutting, diagnostic-only) servers go last — never primary.
	OpengrepServer,
	AstGrepServer,
	ZizmorServer,
	TyposServer,
];

/**
 * Get server for a file extension
 */
export function getServerForExtension(ext: string): LSPServerInfo | undefined {
	return LSP_SERVERS.find((server) => server.extensions.includes(ext));
}

/**
 * Get server by ID
 */
export function getServerById(id: string): LSPServerInfo | undefined {
	return LSP_SERVERS.find((server) => server.id === id);
}

/**
 * Get all servers for a file (may have multiple matches)
 */
export function getServersForFile(filePath: string): LSPServerInfo[] {
	const ext = path.extname(filePath).toLowerCase();
	return LSP_SERVERS.filter((server) => server.extensions.includes(ext));
}
