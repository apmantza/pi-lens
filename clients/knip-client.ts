/**
 * Knip Client for pi-local
 *
 * Detects unused exports, files, dependencies, and more.
 * Essential for safe refactoring — I need to know what's dead code
 * before I can clean it up.
 *
 * Requires: npm install -D knip
 * Docs: https://knip.dev/
 */

import type { AnalysedRootSignal } from "./analysed-root.js";
import { createSubsystemLogger } from "./extension-log.js";
import { incrementDegradationCount } from "./degradation-ledger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { findNearestMarkerRoot } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import {
	createAvailabilityChecker,
	findManagedNodeToolBinary,
	getManagedToolEnvironment,
	resolveAvailableOrInstall,
} from "./dispatch/runners/utils/runner-helpers.js";
import {
	createAvailabilityLatch,
	describeUnavailability,
} from "./dispatch/runners/utils/availability-policy.js";
import { spawnFailedWithNoOutput } from "./dispatch/runners/utils/spawn-outcome.js";
import { formatToolFailure } from "./dispatch/runners/utils/tool-failure.js";
import { findLocalBinUpwards } from "./package-manager.js";
import { logSessionStart } from "./sessionstart-logger.js";

// --- Types ---

export interface KnipIssue {
	type:
		| "export"
		| "file"
		| "dependency"
		| "devDependency"
		| "unlisted"
		| "bin"
		| "enumMember";
	name: string;
	file?: string;
	line?: number;
	package?: string;
}

export interface KnipResult extends AnalysedRootSignal {
	success: boolean;
	issues: KnipIssue[];
	unusedExports: KnipIssue[];
	unusedFiles: KnipIssue[];
	unusedDeps: KnipIssue[];
	unlistedDeps: KnipIssue[];
	summary: string;
	/**
	 * Why an unsuccessful run failed, in a form readers can branch on without
	 * pattern-matching prose (#1467). `unavailable-transient` marks a result the
	 * cache must NOT keep over a good one and the turn loop must not treat as a
	 * hard knip failure — the tool is installed, the probe just timed out.
	 */
	failureKind?: "unavailable-transient" | "unavailable-missing";
	/** Whether this call executed knip or reused the same project's successful
	 * result at the supplied project sequence. */
	execution?: "executed" | "cache";
}

export interface KnipAnalyzeOptions {
	/** Monotonic content generation supplied by RuntimeCoordinator. Calls that
	 * cannot prove a generation omit it and retain the explicit fresh-run path. */
	projectSeq?: number;
}

interface KnipMemoFileSignal {
	path: string;
	mtimeMs: number;
	size: number;
}

interface KnipMemoSignal {
	packageJson: KnipMemoFileSignal | null;
	config: KnipMemoFileSignal | null;
}

const EMPTY_RESULT: Omit<KnipResult, "summary"> = {
	success: false,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
};

const ANALYSIS_TIMEOUT_MS = 30_000;

/**
 * Every package name referenced as a KEY (at any nesting depth — npm's
 * `overrides` and pnpm's `pnpm.overrides` allow nested "for this dependency's
 * sub-dependency" overrides) in `package.json`'s `overrides`, `resolutions`
 * (Yarn's equivalent), or `pnpm.overrides` fields. These are the project's
 * own explicit signal that a package is deliberately present to pin a
 * resolution — not a source-imported dependency knip's import graph can see.
 * Missing/malformed `package.json` degrades to an empty set (never throws) —
 * this is a best-effort narrowing, not a required input.
 */
export function readOverridePinnedPackageNames(targetDir: string): Set<string> {
	const names = new Set<string>();
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(
			fs.readFileSync(path.join(targetDir, "package.json"), "utf-8"),
		);
	} catch {
		return names;
	}

	const collectKeys = (value: unknown): void => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		for (const [key, nested] of Object.entries(
			value as Record<string, unknown>,
		)) {
			names.add(key);
			collectKeys(nested);
		}
	};

	collectKeys(pkg.overrides);
	collectKeys(pkg.resolutions);
	collectKeys((pkg.pnpm as { overrides?: unknown } | undefined)?.overrides);

	return names;
}

/**
 * knip's own config-file names, in knip's discovery order (knip 6
 * `configFilesLookup`). Used for REPORTING which config a run resolved — the
 * runner never passes `--config`, so knip still does its own discovery from the
 * spawn cwd. Reading the same list here keeps the recorded answer honest
 * instead of guessing "knip.json or nothing".
 */
const KNIP_CONFIG_FILENAMES = [
	"knip.json",
	"knip.jsonc",
	"knip.ts",
	"knip.js",
	"knip.config.ts",
	"knip.config.js",
	".knip.json",
	".knip.jsonc",
	".knip.ts",
	".knip.js",
];

/**
 * The knip config this project ships, relative to `targetDir`, or null when the
 * project ships none (knip then runs on its built-in defaults).
 *
 * `package.json` is reported last and only when it carries a `knip` field —
 * knip reads that field as a config source, and a project that configures knip
 * there is just as configured as one with a `knip.json`.
 */
export function resolveProjectKnipConfig(targetDir: string): string | null {
	for (const name of KNIP_CONFIG_FILENAMES) {
		if (fs.existsSync(path.join(targetDir, name))) return name;
	}
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(targetDir, "package.json"), "utf-8"),
		);
		if (pkg && typeof pkg === "object" && pkg.knip !== undefined) {
			return "package.json#knip";
		}
	} catch {
		// No/malformed package.json — "no project config" is the honest answer.
	}
	return null;
}

/** Where a resolved knip shim came from, as named in the toolchain record. */
export type KnipBinarySource = "project" | "global" | "managed-or-path";

/**
 * The knip the PROJECT itself would run: its own `node_modules/.bin/knip`,
 * walking up so a workspace package finds the monorepo's hoisted copy. Null
 * when the project installs no knip and pi-lens's managed shim is all there is.
 *
 * A project that installs knip pins the version its config is written against,
 * and that version is what the project's `npx knip` / `npm run knip` runs.
 * Preferring pi-lens's managed shim instead makes the lens report a DIFFERENT
 * tool's verdict under the project's config (#1721): a managed knip 6.4.1
 * flagged 62 unused type exports on a tree that knip 6.32.2 leaves clean, and
 * every one of those flags is destructive advice.
 *
 * The walk is the shared `findLocalBinUpwards`, the same one behind jscpd's
 * (`clients/jscpd-client.ts:269`) and madge's
 * (`clients/dependency-checker.ts:420`) resolution, rather than a fourth copy.
 * It stops at the filesystem half deliberately: the global-bin step those two
 * add spawns a probe per package manager, and this runs on every analyze().
 */
export function resolveProjectKnipBinary(targetDir: string): string | null {
	return findLocalBinUpwards("knip", targetDir) ?? null;
}

/**
 * Classify a resolved shim for the toolchain record: inside the project tree,
 * elsewhere on the user's machine, or pi-lens's own managed/PATH fallback.
 */
export function classifyKnipBinary(
	binary: string | null,
	targetDir: string,
): KnipBinarySource {
	if (binary === null) return "managed-or-path";
	const relative = path.relative(path.resolve(targetDir), path.resolve(binary));
	return relative === "" ||
		relative.startsWith("..") ||
		path.isAbsolute(relative)
		? "global"
		: "project";
}

/**
 * The version of the knip package behind a resolved shim, read from disk (no
 * spawn — a `--version` probe per project root would add a process to a hot
 * path for a telemetry field). Returns null for a bare PATH command, whose
 * package location is unknown.
 */
function readKnipShimVersion(binary: string): string | null {
	if (!path.isAbsolute(binary)) return null;
	const binDir = path.dirname(binary);
	if (path.basename(binDir) !== ".bin") return null;
	try {
		const pkg = JSON.parse(
			fs.readFileSync(
				path.join(path.dirname(binDir), "knip", "package.json"),
				"utf-8",
			),
		);
		const version = (pkg as { version?: unknown }).version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

/** Distinct toolchain records kept per client instance (bounded telemetry). */
const MAX_RECORDED_TOOLCHAINS = 32;

// --- Client ---

export class KnipClient {
	private readonly knipAvailability = createAvailabilityChecker(
		"knip",
		".cmd",
		["--version"],
		{
			environment: (cwd) => getManagedToolEnvironment("knip", cwd),
			unclassifiedFailureOutcome: "missing",
			fastPath: () => findManagedNodeToolBinary("knip"),
		},
	);
	/**
	 * Client-side memo. Only a DURABLE verdict is latched — a transient probe
	 * failure expires, so an installed knip becomes available again without a
	 * host restart (#1467).
	 */
	private readonly availabilityLatch = createAvailabilityLatch();
	private knipCommand = "knip";
	private ensureInFlight: Promise<boolean> | null = null;
	private log: (msg: string) => void;

	/**
	 * De-dupe concurrent `analyze()` calls against the same project root.
	 *
	 * Without this guard, two back-to-back turn_end events (or a turn_end
	 * firing while the session_start scan is still in flight) can each spawn
	 * a fresh `knip` process over the same tree. Two concurrent knip
	 * runs are CPU-bound and cause the exact pathology we're fixing: load
	 * averages >5, TUI freezes, and zombie processes reparented to init
	 * after pi exits mid-scan.
	 *
	 * Key: canonicalised project root (not the caller's cwd). Value is the
	 * in-flight promise; completing clears the slot.
	 */
	private inFlight = new Map<string, Promise<KnipResult>>();

	/** Last successful result per project and runtime content generation. */
	private completedByProject = new Map<
		string,
		{ projectSeq: number; result: KnipResult; signal: KnipMemoSignal }
	>();

	/**
	 * (project root, binary, config) triples already recorded, so the toolchain
	 * row is written once per distinct resolution instead of once per run.
	 */
	private readonly recordedToolchains = new Set<string>();

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("knip") : () => {};
	}

	/** Re-arm content-keyed reuse at the session boundary. */
	resetSessionState(): void {
		this.completedByProject.clear();
	}

	/**
	 * Find the nearest directory with a project/knip config marker.
	 *
	 * Returns `null` when no marker is found up to the filesystem root.
	 * Callers MUST treat a null return as "no project here, skip knip" —
	 * previously this fell back to `startDir`, which on a bare cwd like
	 * `/home/v` caused knip to recurse through every project and balloon
	 * memory/CPU.
	 *
	 * Delegates to the shared path-utils helper (refs #625) — never treats a
	 * package/knip config at or above $HOME as the project (escapes the
	 * workspace, #296/#250), and never walks past a `.git`/`.hg`/`.svn`
	 * boundary to pick up an unrelated parent's package.json (Unity/non-JS
	 * repos often have no package.json at their own root).
	 */
	private resolveProjectRoot(
		startDir: string,
		homeDirOverride?: string,
	): string | null {
		return findNearestMarkerRoot(
			startDir,
			[
				"package.json",
				"knip.json",
				"knip.ts",
				"knip.config.js",
				"knip.config.ts",
			],
			{ boundaries: [".git", ".hg", ".svn"], homeDir: homeDirOverride },
		);
	}

	/**
	 * Check if knip CLI is available, auto-install if not.
	 *
	 * The memo returns `null` when the last verdict was transient and its
	 * cooldown has expired, which re-enters the probe. That is the difference
	 * between "knip is missing" (a fact worth caching) and "the probe timed out"
	 * (a moment worth retrying).
	 */
	async ensureAvailable(): Promise<boolean> {
		const memo = this.availabilityLatch.read();
		if (memo !== null) return memo;
		if (this.ensureInFlight) return this.ensureInFlight;

		this.ensureInFlight = this.doEnsureAvailable();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(): Promise<boolean> {
		const cwd = process.cwd();
		const resolved = await resolveAvailableOrInstall(
			this.knipAvailability,
			"knip",
			cwd,
		);
		if (resolved !== null) {
			this.knipCommand = resolved;
			this.availabilityLatch.noteAvailable();
			return true;
		}
		const verdict = this.knipAvailability.getVerdict(cwd);
		this.availabilityLatch.noteUnavailable(
			verdict.outcome ?? "missing",
			verdict.cause ?? "not-found",
		);
		return false;
	}

	/**
	 * The single place a knip-unavailable result is worded. A transient probe
	 * failure must never be reported as "install knip" — knip is on disk.
	 */
	private unavailableResult(): KnipResult {
		const verdict = this.knipAvailability.getVerdict(process.cwd());
		const transient = verdict.outcome === "transient";
		const retryAfterMs = verdict.retryAtMs
			? Math.max(0, verdict.retryAtMs - Date.now())
			: undefined;
		return {
			...EMPTY_RESULT,
			failureKind: transient ? "unavailable-transient" : "unavailable-missing",
			summary: describeUnavailability({
				tool: "Knip",
				installHint: "npm install -D knip",
				outcome: verdict.outcome,
				cause: verdict.cause,
				elapsedMs: verdict.elapsedMs,
				retryAfterMs,
			}),
		};
	}

	/**
	 * Run knip analysis on the project.
	 *
	 * Async (uses `safeSpawnAsync`) so it never blocks the event loop —
	 * knip scans on large monorepos can take tens of seconds, and the
	 * previous `spawnSync` implementation froze the TUI for the entire
	 * duration.
	 *
	 * Re-entrancy safe: concurrent calls resolving to the same project
	 * root share a single knip process via `inFlight`.
	 *
	 * Successful memo hits validate package.json and the resolved Knip config
	 * with bounded metadata checks. The two statSync calls replace a 10-23
	 * second project scan. Source-only external edits remain undetected until
	 * pi observes a write or the session resets.
	 */
	async analyze(
		cwd?: string,
		_ignore?: string[],
		options: KnipAnalyzeOptions = {},
	): Promise<KnipResult> {
		const targetDir = this.resolveProjectRoot(cwd || process.cwd());
		if (!targetDir) {
			// No package.json / knip config anywhere up the tree. Running knip
			// from an arbitrary cwd (e.g. $HOME) has no defined meaning and in
			// practice walks huge irrelevant trees — bail early.
			this.log(
				`No project root found from ${cwd || process.cwd()}; skipping knip`,
			);
			return {
				...EMPTY_RESULT,
				success: true,
				summary: "No project root found; knip skipped",
			};
		}

		const key = path.resolve(targetDir);
		const completed = this.completedByProject.get(key);
		if (
			options.projectSeq !== undefined &&
			completed?.projectSeq === options.projectSeq &&
			this.matchesMemoSignal(targetDir, completed.signal)
		) {
			this.log(
				`Analysis cache hit for ${key} at projectSeq ${options.projectSeq}`,
			);
			// #2154: a memo hit did not scan the root during THIS call, so it
			// carries no authority to retire a retained finding — the flag is
			// cleared even though the memoised result set it when it ran.
			return { ...completed.result, execution: "cache", analyzed: false };
		}

		// A project that ships its own knip needs no managed install and no
		// managed probe — the shim is already on disk, and gating on
		// `ensureAvailable()` would tell such a project to "npm install -D knip"
		// whenever the MANAGED copy is missing (#1721).
		if (
			resolveProjectKnipBinary(targetDir) === null &&
			!(await this.ensureAvailable())
		) {
			return this.unavailableResult();
		}

		const existing = this.inFlight.get(key);
		if (existing) {
			this.log(`Analysis already in flight for ${key}; sharing result`);
			return existing;
		}

		const promise = this.runAnalyze(key).then((result) => {
			const executed = { ...result, execution: "executed" as const };
			if (result.success && options.projectSeq !== undefined) {
				this.completedByProject.set(key, {
					projectSeq: options.projectSeq,
					result: executed,
					signal: this.readMemoSignal(key),
				});
			}
			return executed;
		});
		// Identity-guarded release (#1968, #1967's pattern): delete only if
		// THIS build is still the registered one. A bare delete-by-key lets a
		// late-settling build A evict a live build B that replaced the entry
		// mid-flight, and the next caller starts a duplicate.
		const wrapped = promise.finally(() => {
			if (this.inFlight.get(key) === wrapped) this.inFlight.delete(key);
		});
		this.inFlight.set(key, wrapped);
		return wrapped;
	}

	private readMemoFileSignal(filePath: string): KnipMemoFileSignal | null {
		try {
			const stat = fs.statSync(filePath);
			return { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size };
		} catch {
			return null;
		}
	}

	private readMemoSignal(targetDir: string): KnipMemoSignal {
		const config = resolveProjectKnipConfig(targetDir);
		return {
			packageJson: this.readMemoFileSignal(
				path.join(targetDir, "package.json"),
			),
			config:
				config && config !== "package.json#knip"
					? this.readMemoFileSignal(path.join(targetDir, config))
					: null,
		};
	}

	private matchesMemoSignal(
		targetDir: string,
		signal: KnipMemoSignal,
	): boolean {
		const current = {
			packageJson: this.readMemoFileSignal(
				path.join(targetDir, "package.json"),
			),
			config: signal.config
				? this.readMemoFileSignal(signal.config.path)
				: null,
		};
		return (
			JSON.stringify(current.packageJson) ===
				JSON.stringify(signal.packageJson) &&
			JSON.stringify(current.config) === JSON.stringify(signal.config)
		);
	}

	private async runAnalyze(targetDir: string): Promise<KnipResult> {
		// Cache dir is routed through pi-lens's project-data-dir convention (NOT
		// knip's own default `./node_modules/.cache/knip`) so it lives alongside
		// every other project cache (see cache-manager.ts, call-graph.ts) and is
		// covered by the existing `.pi-lens/` gitignore entry.
		//
		// Documented cache-invalidation gaps (both live in knip's own cache, not
		// in pi-lens):
		//
		// 1. `.gitignore` (per knip's docs): a cached run does NOT pick up
		//    newly-added `.gitignore` files automatically — the cache must be
		//    deleted to detect them. Not auto-handled here; documented tradeoff.
		// 2. Consumer-side imports (#1630): knip's glob cache records the mtime of
		//    every directory that CONTRIBUTED a matched path, and revalidates
		//    against those. A directory that matched nothing at cache time is not
		//    recorded, so a file later added to it is invisible to the cached
		//    glob. A new test that imports an export therefore never reaches the
		//    graph, and knip keeps reporting that export as unused — a stale
		//    verdict pi-lens then renders as fresh. Fixed upstream in knip 6.28.0
		//    (glob cache now tracks every directory it reads), but the managed
		//    install floats and older versions are common in the field, so
		//    `pruneStaleGlobCache()` below drops the glob cache on every run
		//    regardless of version. Measured on this repo with knip 6.4.1:
		//    uncached 3.3s, fully cached 1.3s, glob-cache-dropped 1.4s. The glob
		//    cache is worth ~0.1s of the ~2.0s the cache saves, so dropping it
		//    buys correctness for almost nothing.
		const cacheLocation = path.join(
			getProjectDataDir(targetDir),
			"cache",
			"knip",
		);

		// knip (verified against 6.26.0) silently fails to persist the cache when
		// `--cache-location` points at a directory that doesn't exist yet: its
		// internal auto-mkdir throws ENOENT (swallowed internally, debug-logged
		// only) on Windows, so the very first run — and every run after, since the
		// dir never gets created — degrades to an uncached scan with no error
		// surfaced. Pre-creating the dir avoids that path entirely; matches the
		// mkdirSync-before-spawn convention call-graph.ts already uses for its
		// cache file's parent dir.
		try {
			fs.mkdirSync(cacheLocation, { recursive: true });
		} catch (err) {
			this.log(`Failed to pre-create knip cache dir ${cacheLocation}: ${err}`);
		}

		this.pruneStaleGlobCache(cacheLocation);

		const args = [
			"--reporter=json",
			"--include",
			// enumMembers surfaces unused enum members — finer-grained than
			// file-level exports. (knip 6.x has NO `classMembers` issue type; passing
			// it makes knip exit 2 with zero output, silently disabling the scan —
			// verified against knip 6.20. Valid member-level type here is enumMembers.)
			"files,exports,types,dependencies,unlisted,enumMembers",
			"--cache",
			"--cache-location",
			cacheLocation,
		];

		// Project toolchain first. #1199 already put `<targetDir>/node_modules/.bin`
		// at the front of the child PATH for exactly this preference, but the spawn
		// command is an ABSOLUTE managed path, so PATH order never got a say
		// (#1721). Resolving the command here is what makes that intent real.
		const projectBinary = resolveProjectKnipBinary(targetDir);
		const command = projectBinary ?? this.knipCommand;
		this.recordToolchain(
			targetDir,
			command,
			classifyKnipBinary(projectBinary, targetDir),
		);

		const result = await safeSpawnAsync(command, args, {
			timeout: ANALYSIS_TIMEOUT_MS,
			cwd: targetDir,
			env: await getManagedToolEnvironment("knip", targetDir),
		});

		if (result.error) {
			this.log(`Analysis error: ${result.error.message}`);
			return {
				...EMPTY_RESULT,
				summary: `Error: ${result.error.message}`,
			};
		}

		// Empirical exit-code table (knip 6.4.1, verified live for #1736): 0 =
		// clean run, JSON stdout `{"issues":[]}`; 1 = clean run WITH findings,
		// JSON stdout `{"issues":[...]}`; 2 = config/load error, empty or
		// non-JSON stdout with the error on stderr. A genuinely clean run's
		// stdout is therefore NEVER empty — knip always prints at least
		// `{"issues":[]}` on exit 0. Empty stdout only ever shows up paired
		// with a NONZERO exit (a broken shim, a crash, or knip's own load
		// error), so `status !== 0 && !output.trim()` is unambiguous evidence
		// of a failed run, never a clean one.
		const output = result.stdout || "";
		this.log(
			`Knip output length: ${output.length}, exit status: ${result.status}`,
		);
		if (output.length < 500) {
			this.log(`Knip output sample: ${output}`);
		}
		if (!output.trim()) {
			// Reuses the SAME discriminator every dispatch/runners linter uses
			// (`spawnFailedWithNoOutput`, `clients/dispatch/runners/utils/
			// spawn-outcome.ts`) rather than a parallel hand-rolled check — a
			// nonzero exit with nothing to parse is never a clean run, here or
			// there.
			if (spawnFailedWithNoOutput(result, output)) {
				if (result.failure === "timeout") {
					return {
						...EMPTY_RESULT,
						success: true,
						analyzed: true,
						analysisComplete: false,
						summary: "Knip timed out after partial execution",
					};
				}
				// #1816: one shared wording, one truncation, signal named. The
				// binary-source discriminator (#1721's whole point — WHICH knip
				// ran) survives as a named field rather than as prose.
				const reason = formatToolFailure({
					tool: "knip",
					status: result.status,
					signal: result.signal,
					stderr: result.stderr,
					fields: {
						command,
						source: classifyKnipBinary(projectBinary, targetDir),
					},
				});
				this.log(reason);
				incrementDegradationCount({
					kind: "runner-empty-result",
					subject: "knip",
					reason,
				});
				return {
					...EMPTY_RESULT,
					summary: `Knip exited ${result.status} with no output; run skipped`,
				};
			}
			// status === 0 with empty stdout has never been observed against a
			// real knip binary (a genuine clean run still prints
			// `{"issues":[]}`), but a defensive fallback is cheap insurance
			// against a future knip release that changes this. Deliberately NOT
			// `analyzed` (#2154): nothing was parsed, so this shape must not
			// retire a retained knip finding — it is reported cold instead.
			return {
				...EMPTY_RESULT,
				success: true,
				summary: "No issues found",
			};
		}

		return this.dropOverridePinnedDeps(
			this.parseOutput(output, targetDir),
			targetDir,
		);
	}

	/**
	 * Record WHICH knip a run used and WHICH config it ran under (#1721).
	 *
	 * The dogfood failure this fixes was invisible from the outside: the lens
	 * reported 62 unused type exports and the project's own `npx knip` reported
	 * none, with nothing in any log to say the two ran different binaries. This
	 * row is that missing evidence — it names the shim, its version, the config
	 * knip will discover, and whether the shim came from the project or from
	 * pi-lens.
	 *
	 * Bounded twice over: one row per distinct (project root, binary, config)
	 * triple, and at most `MAX_RECORDED_TOOLCHAINS` distinct triples per client.
	 * Steady-state cost is therefore one line per project per session, not one
	 * per turn_end.
	 */
	private recordToolchain(
		targetDir: string,
		command: string,
		source: KnipBinarySource,
	): void {
		const config = resolveProjectKnipConfig(targetDir);
		const key = `${targetDir} ${command} ${config ?? ""}`;
		if (this.recordedToolchains.has(key)) return;
		if (this.recordedToolchains.size >= MAX_RECORDED_TOOLCHAINS) return;
		this.recordedToolchains.add(key);

		const version = readKnipShimVersion(command);
		logSessionStart(
			`knip toolchain ${targetDir}: binary=${command}` +
				`${version ? ` version=${version}` : ""}` +
				` source=${source}` +
				` config=${config ?? "none (knip defaults)"}`,
		);
	}

	/**
	 * Delete knip's glob cache (`glob-<version>.cache`) before every run (#1630).
	 *
	 * knip revalidates a cached glob against the mtimes of the directories that
	 * contributed a matched path. Directories that matched nothing are never
	 * recorded, so files later added to them stay invisible and knip keeps
	 * reporting an export as unused after a new consumer imports it. Removing
	 * this one file forces a fresh file walk while the module and plugin caches —
	 * which carry nearly all of the cache's speed — survive.
	 *
	 * Failures are logged and ignored: a glob cache we could not delete degrades
	 * to the pre-#1630 behavior, which is stale but not fatal.
	 */
	private pruneStaleGlobCache(cacheLocation: string): void {
		let entries: string[];
		try {
			entries = fs.readdirSync(cacheLocation);
		} catch (err) {
			this.log(`Failed to read knip cache dir ${cacheLocation}: ${err}`);
			return;
		}

		for (const entry of entries) {
			if (!entry.startsWith("glob-") || !entry.endsWith(".cache")) continue;
			try {
				fs.rmSync(path.join(cacheLocation, entry), { force: true });
				this.log(`Pruned knip glob cache ${entry}`);
			} catch (err) {
				this.log(`Failed to prune knip glob cache ${entry}: ${err}`);
			}
		}
	}

	/**
	 * Drop `dependency`/`devDependency` issues for a package that's also
	 * referenced as an npm `overrides` (or Yarn `resolutions` / pnpm
	 * `pnpm.overrides`) key in this project's `package.json` (#968).
	 *
	 * A direct devDependency whose only job is pinning a vulnerable
	 * transitive/peer resolution has no source import — that's WORKING AS
	 * INTENDED, not dead code, and knip has no concept of "this dependency
	 * exists only to satisfy an overrides entry" (it only sees imports).
	 * `overrides`/`resolutions` are the project's own explicit, unambiguous
	 * signal that the package is deliberately present — the same class of
	 * signal `hardcoded-url`'s `SCREAMING_SNAKE_CASE` constant-name carve-out
	 * and `ts-ssrf`'s constant-identifier carve-out lean on elsewhere in this
	 * codebase — so this narrows the finding rather than suppressing
	 * `dependency`/`devDependency` issues wholesale: a devDependency that
	 * ISN'T also an overrides/resolutions key is still reported.
	 */
	private dropOverridePinnedDeps(
		result: KnipResult,
		targetDir: string,
	): KnipResult {
		if (result.unusedDeps.length === 0) return result;
		const pinned = readOverridePinnedPackageNames(targetDir);
		if (pinned.size === 0) return result;

		const isPinnedDepIssue = (issue: KnipIssue): boolean =>
			(issue.type === "dependency" || issue.type === "devDependency") &&
			(pinned.has(issue.name) ||
				(!!issue.package && pinned.has(issue.package)));

		const issues = result.issues.filter((issue) => !isPinnedDepIssue(issue));
		const unusedDeps = result.unusedDeps.filter(
			(issue) => !isPinnedDepIssue(issue),
		);
		return unusedDeps.length === result.unusedDeps.length
			? result
			: { ...result, issues, unusedDeps };
	}

	/**
	 * Find unused exports in a specific file
	 */
	async findUnusedExports(filePath: string): Promise<string[]> {
		const result = await this.analyze(path.dirname(filePath));
		const basename = path.basename(filePath);

		return result.unusedExports
			.filter((e) => e.file?.includes(basename))
			.map((e) => e.name);
	}

	/**
	 * Format results for LLM consumption. Delegates to the pure
	 * `formatKnipResult` so callers (e.g. turn-end) can format without a live
	 * client instance.
	 */
	formatResult(result: KnipResult, maxItems = 20): string {
		return formatKnipResult(result, maxItems);
	}

	// --- Internal ---

	private parseOutput(output: string, root = process.cwd()): KnipResult {
		try {
			const data = JSON.parse(output);
			const issues: KnipIssue[] = [];
			const unusedExports: KnipIssue[] = [];
			const unusedFiles: KnipIssue[] = [];
			const unusedDeps: KnipIssue[] = [];
			const unlistedDeps: KnipIssue[] = [];

			const addIssue = (issue: KnipIssue) => {
				issues.push(issue);
				if (issue.type === "export" || issue.type === "enumMember") {
					unusedExports.push(issue);
				}
				if (issue.type === "file") unusedFiles.push(issue);
				if (issue.type === "dependency" || issue.type === "devDependency") {
					unusedDeps.push(issue);
				}
				if (issue.type === "unlisted" || issue.type === "bin") {
					unlistedDeps.push(issue);
				}
			};

			// Knip JSON format (grouped): { issues: [ { file, exports:[], files:[], dependencies:[], ... } ] }
			const fileEntries: any[] = Array.isArray(data?.issues) ? data.issues : [];
			const analyzedFiles = fileEntries
				.map((entry) => entry?.file)
				.filter(
					(file): file is string => typeof file === "string" && file.length > 0,
				)
				.map((file) => path.resolve(root, file));

			for (const entry of fileEntries) {
				const file: string = entry.file ?? "";

				const push = (
					arr: any[],
					type: KnipIssue["type"],
					_target: KnipIssue[],
				) => {
					for (const item of arr) {
						addIssue({
							type,
							name: item.name ?? item.symbol ?? String(item),
							file,
							line: item.line,
							package: item.package,
						});
					}
				};

				push(entry.exports ?? [], "export", unusedExports);
				push(entry.types ?? [], "export", unusedExports);
				push(entry.enumMembers ?? [], "enumMember", unusedExports);
				push(entry.files ?? [], "file", unusedFiles);
				push(entry.dependencies ?? [], "dependency", unusedDeps);
				push(entry.devDependencies ?? [], "devDependency", unusedDeps);
				push(entry.unlisted ?? [], "unlisted", unlistedDeps);
				push(entry.binaries ?? [], "bin", unlistedDeps);
			}

			// Fallback format: flat list of issue objects
			if (issues.length === 0 && Array.isArray(data)) {
				for (const item of data) {
					if (!item || typeof item !== "object") continue;
					const rawType = String(
						item.type ?? item.issueType ?? item.kind ?? "file",
					).toLowerCase();
					const type: KnipIssue["type"] =
						rawType === "export" || rawType === "exports"
							? "export"
							: rawType === "dependency"
								? "dependency"
								: rawType === "devdependency"
									? "devDependency"
									: rawType === "unlisted"
										? "unlisted"
										: rawType === "bin" || rawType === "binaries"
											? "bin"
											: "file";
					addIssue({
						type,
						name: String(
							item.name ??
								item.symbol ??
								item.package ??
								item.message ??
								"unknown",
						),
						file: item.file ?? item.path ?? item.location?.file,
						line: item.line ?? item.location?.line,
						package: item.package,
					});
				}
			}

			return {
				success: true,
				// #2154: the one knip site that parsed a scan of this root.
				analyzed: true,
				...(analyzedFiles.length > 0 ? { analyzedFiles } : {}),
				issues,
				unusedExports,
				unusedFiles,
				unusedDeps,
				unlistedDeps,
				summary: `Found ${issues.length} issues`,
			};
		} catch (err) {
			void err;
			this.log("Failed to parse knip JSON output");
			return {
				...EMPTY_RESULT,
				summary: "Failed to parse output",
			};
		}
	}
}

/**
 * Format a KnipResult for the agent (the FULL dead-code picture: all unused
 * exports/members, files, and deps — not a delta). Pure: no client instance or
 * `this`, so turn-end can surface findings without depending on the injected
 * client exposing the method. Returns "" when there is nothing to report.
 * Unlisted deps are intentionally omitted here — they're surfaced as a
 * delta-gated blocker (newly broken imports), not as cleanup advice.
 */
export function formatKnipResult(result: KnipResult, maxItems = 20): string {
	if (!result.success) return `[Knip] ${result.summary}`;
	if (result.issues.length === 0) return "";

	let output = `[Knip] ${result.issues.length} issue(s)`;
	if (result.unusedExports.length)
		output += ` — ${result.unusedExports.length} unused export(s)`;
	if (result.unusedFiles.length)
		output += ` — ${result.unusedFiles.length} unused file(s)`;
	if (result.unusedDeps.length)
		output += ` — ${result.unusedDeps.length} unused dep(s)`;
	if (result.unlistedDeps.length)
		output += ` — ${result.unlistedDeps.length} unlisted dep(s)`;
	output += ":\n";

	// Show unused exports first (most useful for refactoring)
	if (result.unusedExports.length > 0) {
		output += "\n  Unused exports:\n";
		for (const issue of result.unusedExports.slice(0, maxItems)) {
			const loc = issue.file ? ` (${path.basename(issue.file)})` : "";
			output += `    - ${issue.name}${loc}\n`;
		}
		if (result.unusedExports.length > maxItems) {
			output += `    ... and ${result.unusedExports.length - maxItems} more\n`;
		}
	}

	// Show unused files
	if (result.unusedFiles.length > 0) {
		output += "\n  Unused files:\n";
		for (const issue of result.unusedFiles.slice(0, 10)) {
			output += `    - ${issue.name}\n`;
		}
	}

	// Show unused deps (might be worth removing)
	if (result.unusedDeps.length > 0) {
		output += "\n  Unused dependencies:\n";
		for (const issue of result.unusedDeps) {
			output += `    - ${issue.package || issue.name}\n`;
		}
	}

	return output;
}
