/**
 * Dependency Checker for pi-local
 *
 * Real-time circular dependency detection.
 * Caches the dependency graph and only re-scans when imports change.
 * Runs in the tool_result hook like ast-grep and Biome.
 *
 * Requires: npm install -D madge
 * Docs: https://github.com/pahen/madge
 */

import type { AnalysedRootSignal } from "./analysed-root.js";
import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { mapWithConcurrency } from "./map-with-concurrency.js";
import { findNodeToolBinary } from "./package-manager.js";
import { isFullyQualified } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { compareOrdinal } from "./string-utils.js";
import {
	createAvailabilityChecker,
	discoverManagedTool,
	getManagedToolEnvironment,
	resolveAvailableOrInstall,
} from "./dispatch/runners/utils/runner-helpers.js";
import {
	type AvailabilityCause,
	type AvailabilityOutcome,
	createAvailabilityLatch,
} from "./dispatch/runners/utils/availability-policy.js";

// --- Types ---

export interface CircularDep {
	file: string;
	path: string[]; // The cycle path
}

/**
 * Build madge's argv for a circular-dependency scan.
 *
 * Two correctness levers beyond the bare `--circular`:
 *   - `mjs,cjs` extensions: without them madge ignores explicit ESM/CJS files,
 *     dropping their edges from the graph.
 *   - `--ts-config <tsconfig.json>`: madge can only resolve TypeScript `paths`
 *     aliases (`@/foo`, `~/bar`) when pointed at the tsconfig. Without it those
 *     imports are silently unresolved, so cycles that route through an alias are
 *     MISSED (false negatives). Passed only when a tsconfig actually exists, so
 *     non-TS / alias-free projects are unaffected.
 */
export function buildMadgeArgs(target: string, projectRoot: string): string[] {
	const args = ["--circular", "--extensions", "ts,tsx,js,jsx,mjs,cjs"];
	const tsConfig = path.join(projectRoot, "tsconfig.json");
	if (fs.existsSync(tsConfig)) {
		args.push("--ts-config", tsConfig);
	}
	// --warning surfaces files madge couldn't resolve into the graph (to stderr;
	// stdout JSON is unaffected). Without it those skips are SILENT — and a
	// skipped *local* file could hide a real cycle. We log them (see
	// parseMadgeSkips) instead of discarding stderr.
	args.push("--warning", "--json", target);
	return args;
}

/**
 * Parse madge's `--warning` stderr for skipped (unresolvable) files. External
 * package specifiers (bare names / subpaths like `web-tree-sitter`,
 * `vitest/config`) are expected — madge doesn't traverse node_modules. We flag
 * only **local** skips (relative/absolute paths), which are the ones that could
 * silently drop an internal edge and hide a cycle.
 *
 * @returns total skip count and the subset that look local.
 */
export function parseMadgeSkips(stderr: string): {
	total: number;
	local: string[];
} {
	const lines = (stderr || "").split(/\r?\n/);
	const headerIdx = lines.findIndex((l) => /Skipped\s+\d+\s+file/i.test(l));
	if (headerIdx === -1) return { total: 0, local: [] };
	const total =
		Number.parseInt(
			lines[headerIdx].match(/Skipped\s+(\d+)/i)?.[1] ?? "0",
			10,
		) || 0;
	const specifiers = lines
		.slice(headerIdx + 1)
		.map((l) => l.trim())
		.filter(Boolean);
	const local = specifiers.filter(
		(s) => s.startsWith(".") || s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s),
	);
	return { total, local };
}

export interface DepCheckResult {
	hasCircular: boolean;
	circular: CircularDep[];
	checked: boolean;
	cacheHit: boolean;
	/** Count of LOCAL files madge skipped (couldn't resolve) — a potential
	 * silent cycle-miss. Undefined when not checked. */
	localSkips?: number;
}

/**
 * Which madge invocation a project root resolved to. Classified from the
 * resolved STRING rather than the resolution step that produced it: the
 * installer's discovery can hand back the managed install, an npm-global path
 * or a bare PATH name, and only `"npx"` pays module resolution on every spawn.
 */
export type MadgeCommandKind = "local" | "managed" | "global" | "path" | "npx";

interface ResolvedMadge {
	cmd: string;
	prefix: string[];
	kind: MadgeCommandKind;
}

/**
 * Per-batch madge telemetry, attached to the turn-end `phase: "madge"` latency
 * entry so a slow turn can be attributed to spawn count, a single slow target,
 * or command resolution — the p99 tail #766 is about.
 *
 * A type alias rather than an interface because it is passed straight through
 * as `LatencyEntry.metadata` (`Record<string, unknown>`), which an interface is
 * not assignable to.
 */
export type MadgeBatchStats = {
	requested: number;
	missing: number;
	cacheHits: number;
	spawned: number;
	failed: number;
	/** Absent when the batch resolved nothing — no misses, or madge unavailable. */
	commandKind?: MadgeCommandKind;
	/** Command-resolution cost; ~0 once memoized for this project root. */
	resolveMs: number;
	/** Slow per-spawn timings in array order, capped at `MADGE_STATS_TARGET_CAP`. */
	targets: Array<{ file: string; durationMs: number; ok: boolean }>;
	/** Set when the cap dropped entries, so capping is never silent. */
	targetsTruncated: boolean;
};

// --- Graph Cache ---

interface FileImports {
	imports: Set<string>;
	timestamp: number;
	/**
	 * File byte size at cache time (#1105). The mtime fast-path below is a stale
	 * signal on its own: a content change that PRESERVES mtime (git checkout
	 * timestamp restoration, a formatter preserving mtime, a same-second write)
	 * would let `importsChanged` return false and skip the madge circular-dep
	 * re-check against edited imports. Size is free (the stat already ran) and is
	 * the review-graph gold-standard second axis — an import edit almost always
	 * changes byte length, so this closes the common case at zero I/O cost.
	 */
	size: number;
}

/**
 * Defensive cap on concurrent madge spawns for a single `checkFilesBatch`
 * call. A turn usually only touches 1-3 import-changed files, so this rarely
 * binds — it just guards against a pathological turn (bulk rename/move) from
 * fork-bombing subprocesses.
 */
const MADGE_BATCH_CONCURRENCY = 6;

/**
 * Cap on per-target timings kept in `MadgeBatchStats`. A bulk rename can hand
 * the batch hundreds of files; the latency log is a diagnostic breadcrumb, not
 * a transcript, and the aggregate counts stay exact either way.
 */
const MADGE_STATS_TARGET_CAP = 12;

/**
 * Fast madge targets are not useful enough to justify widening the shared
 * latency.log records. Aggregate counts remain unconditional; retain a
 * target breadcrumb only when the spawn itself was slow enough to explain a
 * turn-end tail.
 */
const MADGE_STATS_TARGET_MIN_DURATION_MS = 100;

/** Is `target` inside `dir`? */
function isWithin(dir: string, target: string): boolean {
	const rel = path.relative(dir, target);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Classify a resolved madge command for `MadgeCommandKind`. Both resolution
 * steps feed this: `findNodeToolBinary` walks up to the project's
 * `node_modules/.bin` but ALSO probes the npm/pnpm/yarn/bun global bins, so
 * "which step answered" says nothing about where the binary actually lives.
 */
function classifyMadgeKind(
	resolved: string,
	managedToolsDir: string,
	projectRoot: string,
): MadgeCommandKind {
	if (!isFullyQualified(resolved)) return "path";
	if (isWithin(managedToolsDir, resolved)) return "managed";
	if (isWithin(projectRoot, resolved)) return "local";
	return "global";
}

/**
 * Has the memoized resolution stopped being reachable? An absolute path is
 * checked with a plain `existsSync` (madge uninstalled, the managed tree
 * wiped). `"npx"` is the deliberate no-memo fallback (already dropped from
 * the cache the moment it's produced — see `resolveUnlessNpx`) and is never
 * itself stale. Everything else is a bare PATH name (`"madge"`, a shell
 * alias resolved via `findNodeToolBinary`'s global-bin probes, …) — #1276:
 * `existsSync` can't check those, so without this they were never
 * revalidated and a PATH change or removed global install kept serving the
 * old answer for the rest of the process.
 *
 * `spawnableCache` memoizes the bare-command branch per checker instance
 * (P2 fix, #1276 review): `isSpawnableCommand` does a synchronous PATH walk,
 * and without this it re-ran on every single cached `madgeCommand` hit —
 * once per file when callers resolve per-file instead of via
 * `checkFilesBatch`'s single per-batch resolution. The cache is cleared by
 * `resetMadgeMemo()` alongside `madgeCommand`, so it stays exactly as fresh
 * as the memo it's revalidating.
 */
async function resolvedCommandIsStale(
	resolved: ResolvedMadge,
	spawnableCache: Map<string, boolean>,
): Promise<boolean> {
	if (resolved.kind === "npx") return false;
	if (isFullyQualified(resolved.cmd)) return !fs.existsSync(resolved.cmd);
	const cached = spawnableCache.get(resolved.cmd);
	if (cached !== undefined) return !cached;
	const { isSpawnableCommand } = await import("./installer/index.js");
	const spawnable = await isSpawnableCommand(resolved.cmd);
	spawnableCache.set(resolved.cmd, spawnable);
	return !spawnable;
}

/**
 * Run `mapper` over `items` with at most `concurrency` in flight at once.
 *
 * Exported (#1810 review F6) so `clients/dispatch/runners/biome-check.ts`'s
 * `resolveBiomeFixKinds` can reuse this exact worker-pool shape for its
 * `biome explain` fan-out instead of carrying a second copy. #2504 moved the
 * VALUE to the zero-dependency `map-with-concurrency.js` leaf — a third caller
 * (`runtime-turn.ts`) needs the pool without pulling this analyzer client into
 * the eager startup graph — and re-exports it here so every existing importer
 * keeps its specifier. This stays the helper's documented home.
 */
export { mapWithConcurrency };

// --- Client ---

export class DependencyChecker {
	private readonly madgeAvailability = createAvailabilityChecker(
		"madge",
		".cmd",
		["--version"],
		{
			environment: (cwd) => getManagedToolEnvironment("madge", cwd),
			unclassifiedFailureOutcome: "missing",
		},
	);
	/** Transient-aware availability memo — see `ensureAvailable` (#1467). */
	private readonly availabilityLatch = createAvailabilityLatch();
	private ensureInFlight: Promise<boolean> | null = null;
	private checkInFlight = new Map<string, Promise<DepCheckResult>>();
	private scanInFlight = new Map<
		string,
		Promise<{ circular: CircularDep[]; count: number }>
	>();
	private log: (msg: string) => void;

	// Cache: file path -> its imports
	private importCache = new Map<string, FileImports>();

	// Circular deps: last known circular deps
	private lastCircular: CircularDep[] = [];

	// Files that are part of a circular dependency
	private circularFiles = new Set<string>();

	// Newest-classification-wins guard over the two fields above — see the
	// cross-operation contract on `checkFilesBatch`.
	private opGeneration = 0;
	private stateGeneration = 0;

	// projectRoot -> resolved madge command
	private madgeCommand = new Map<string, Promise<ResolvedMadge>>();

	// Bare command -> last-known spawnability (#1276 revalidation, P2 fix). A
	// cache hit on `madgeCommand` used to re-run `isSpawnableCommand`'s
	// synchronous PATH walk on EVERY resolution — unbounded FS work on a path
	// that can run once per file in a batch. Memoized here instead, and
	// invalidated by the exact same `resetMadgeMemo()` call the madge-command
	// memo uses, so a madge removed/reinstalled mid-session is still detected
	// on the next resolution after an install completes.
	private spawnableCache = new Map<string, boolean>();

	// #1276: every live checker registers itself so `resetMadgeManagedPathMemo`
	// (called from installer's `finishInstallAttempt`, mirroring
	// `resetSafeSpawnWindowsCommandCache`) can drop every instance's memo, not
	// just whichever one happened to run the install. Held via `WeakRef` (not a
	// strong `Set<DependencyChecker>`) so a checker that's no longer referenced
	// anywhere else (test/reinit instances; production only ever constructs one
	// in `bootstrap.ts`) can still be garbage-collected instead of being
	// retained for the rest of the process — dead refs are pruned lazily the
	// next time the registry is walked.
	private static readonly instances = new Set<WeakRef<DependencyChecker>>();

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("deps") : () => {};
		DependencyChecker.instances.add(new WeakRef(this));
	}

	/** Drop this instance's memoized madge resolution for every project root. */
	private resetMadgeMemo(): void {
		this.madgeCommand.clear();
		this.spawnableCache.clear();
	}

	/**
	 * Reset hook for #1276: the madge managed-path memo is keyed only by
	 * `projectRoot`, but the memoized resolution reads PATH/PATHEXT, local/
	 * global tool discovery, and managed-install state — all of which a
	 * completed install can change. Call this from `finishInstallAttempt()`
	 * right alongside `resetSafeSpawnWindowsCommandCache()` so a mid-session
	 * install is picked up instead of serving the pre-install answer for the
	 * rest of the process.
	 */
	static resetMadgeManagedPathMemo(): void {
		for (const ref of DependencyChecker.instances) {
			const checker = ref.deref();
			if (!checker) {
				// Garbage-collected since registration — prune the dead ref instead
				// of leaving it around forever.
				DependencyChecker.instances.delete(ref);
				continue;
			}
			checker.resetMadgeMemo();
		}
	}

	/**
	 * Resolve how to invoke madge for `projectRoot`: a project-local/global
	 * binary (npm/pnpm/yarn/bun) if found, else whatever the installer already
	 * has on disk, else `npx madge` (#375). `prefix` is prepended to the madge
	 * args (empty for a resolved binary, `["madge"]` for the npx fallback).
	 *
	 * Memoized per project root: `findNodeToolBinary` falls through to
	 * `npm config get prefix` / `pnpm bin -g` / `yarn global bin` spawns that
	 * nothing caches, and this used to run once per file inside the batch
	 * mapper (#766). The memo must not become one-way, though: resolution used
	 * to re-probe on every spawn and so healed itself, and both escapes below
	 * buy that back.
	 */
	private async resolveMadge(projectRoot: string): Promise<ResolvedMadge> {
		const cached = this.madgeCommand.get(projectRoot);
		if (cached) {
			// One stat per resolution: a binary that has since been uninstalled or
			// moved must re-resolve, not fail every spawn for the rest of the
			// session.
			const resolved = await cached;
			if (!(await resolvedCommandIsStale(resolved, this.spawnableCache)))
				return resolved;
			// Several callers may have observed the same stale promise before any
			// continuation ran. Only remove the entry if it is still the promise
			// this caller observed; otherwise join the newer resolution already in
			// flight instead of deleting it and starting a duplicate probe.
			const current = this.madgeCommand.get(projectRoot);
			if (current === cached) {
				this.madgeCommand.delete(projectRoot);
			} else {
				// An npx result may have resolved and removed itself already. In that
				// case falling through starts the intended fresh probe.
				if (current) return current;
			}
		}

		const resolving = this.resolveUnlessNpx(projectRoot);
		this.madgeCommand.set(projectRoot, resolving);
		return resolving;
	}

	/**
	 * Resolve, and drop the memo entry again if all we found was `npx` — pinning
	 * it would pin precisely the slow path #766 removes, and a transient
	 * installer failure would disable managed resolution for the whole session.
	 * Callers already in flight still coalesce on this promise; only the next
	 * one re-probes.
	 */
	private async resolveUnlessNpx(projectRoot: string): Promise<ResolvedMadge> {
		const resolved = await this.doResolveMadge(projectRoot);
		if (resolved.kind === "npx") this.madgeCommand.delete(projectRoot);
		return resolved;
	}

	/**
	 * `allowInstall: false` is load-bearing: discovery here must never trigger a
	 * download, because installation is `ensureAvailable()`'s job and this runs
	 * on the spawn path. Resolution also never rejects — a throwing probe would
	 * otherwise poison the memo with a rejected promise for the whole session.
	 */
	private async doResolveMadge(projectRoot: string): Promise<ResolvedMadge> {
		try {
			const { getManagedToolsDir } = await import("./installer/index.js");
			const classify = (cmd: string): ResolvedMadge => ({
				cmd,
				prefix: [],
				kind: classifyMadgeKind(cmd, getManagedToolsDir(), projectRoot),
			});

			const bin = await findNodeToolBinary("madge", projectRoot);
			if (bin) return classify(bin);

			const discovered = await discoverManagedTool("madge");
			if (discovered) return classify(discovered);
		} catch (err) {
			this.log(`Madge resolution failed, falling back to npx: ${String(err)}`);
		}
		return { cmd: "npx", prefix: ["madge"], kind: "npx" };
	}

	/**
	 * Apply a circular-dep state update on behalf of the operation that took
	 * generation `gen`. See the cross-operation contract on `checkFilesBatch`:
	 * an operation that classified EARLIER but finished later carries a smaller
	 * generation, and its write is dropped rather than resurrecting its stale
	 * view over newer state.
	 */
	private publishState(
		gen: number,
		circular: CircularDep[],
		circularFiles: Set<string>,
	): void {
		if (gen < this.stateGeneration) return;
		this.stateGeneration = gen;
		this.lastCircular = circular;
		this.circularFiles = circularFiles;
	}

	/**
	 * Check if madge is available, auto-install if not.
	 *
	 * Shares knip's latch policy (#1467): only a durable verdict is memoized, so
	 * a probe that timed out — madge's `--version` is ~0.7 s today, but a host
	 * event-loop stall can expire any budget — does not disable madge for the
	 * life of the process.
	 */
	async ensureAvailable(cwd = process.cwd()): Promise<boolean> {
		const memo = this.availabilityLatch.read();
		if (memo !== null) return memo;
		if (this.ensureInFlight) return this.ensureInFlight;

		this.ensureInFlight = this.doEnsureAvailable(cwd);
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(cwd: string): Promise<boolean> {
		const resolved = await resolveAvailableOrInstall(
			this.madgeAvailability,
			"madge",
			cwd,
		);
		if (resolved !== null) {
			this.availabilityLatch.noteAvailable();
			return true;
		}
		const verdict = this.madgeAvailability.getVerdict(cwd);
		this.availabilityLatch.noteUnavailable(
			verdict.outcome ?? "missing",
			verdict.cause ?? "not-found",
		);
		return false;
	}

	/**
	 * #1623: public availability verdict for callers outside the dispatch
	 * graph (mode=full's fresh-fetch) that need to say WHY `ensureAvailable()`
	 * most recently returned false, using the SAME outcome/cause this class
	 * already latched above — not a re-guessed "madge binary unavailable"
	 * that can't tell a transient retry-cooldown probe from a durable
	 * absence.
	 */
	getAvailabilityVerdict(): {
		outcome: AvailabilityOutcome | null;
		cause: AvailabilityCause | null;
		retryAtMs: number;
	} {
		return {
			outcome: this.availabilityLatch.getOutcome(),
			cause: this.availabilityLatch.getCause(),
			retryAtMs: this.availabilityLatch.getRetryAtMs(),
		};
	}

	/**
	 * Check if a file is part of a circular dependency (from cache)
	 */
	isInCircular(filePath: string): boolean {
		const normalized = path.resolve(filePath);
		return this.circularFiles.has(normalized);
	}

	/**
	 * Get circular deps for a specific file
	 */
	getCircularForFile(filePath: string): string[] {
		const normalized = path.resolve(filePath);
		const deps: string[] = [];

		for (const dep of this.lastCircular) {
			if (dep.file === normalized || dep.path.includes(normalized)) {
				// Add the other files in the cycle
				for (const f of dep.path) {
					if (f !== normalized) {
						deps.push(path.relative(process.cwd(), f));
					}
				}
			}
		}

		return Array.from(new Set(deps));
	}

	/**
	 * Extract imports from a TypeScript/JavaScript file
	 */
	extractImports(filePath: string): Set<string> {
		const content = fs.readFileSync(filePath, "utf-8");
		const imports = new Set<string>();

		// Match import statements: import ... from '...'
		const importPattern =
			/(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
		const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

		let match;
		while ((match = importPattern.exec(content)) !== null) {
			if (match[1].startsWith(".")) {
				imports.add(match[1]);
			}
		}

		while ((match = requirePattern.exec(content)) !== null) {
			if (match[1].startsWith(".")) {
				imports.add(match[1]);
			}
		}

		return imports;
	}

	/**
	 * Check if imports have changed for a file
	 */
	importsChanged(filePath: string): boolean {
		const normalized = path.resolve(filePath);

		if (!fs.existsSync(normalized)) {
			this.importCache.delete(normalized);
			return true;
		}

		const stat = fs.statSync(normalized);
		const cached = this.importCache.get(normalized);

		// Fast path: neither mtime NOR size moved (#1105 — size guards the
		// mtime-preserving content change that mtime alone would miss).
		if (
			cached &&
			cached.timestamp >= stat.mtimeMs &&
			cached.size === stat.size
		) {
			return false;
		}

		// Compare actual imports
		const newImports = this.extractImports(normalized);
		const hasChanged = !cached || !this.setsEqual(cached.imports, newImports);

		// Update cache
		this.importCache.set(normalized, {
			imports: newImports,
			timestamp: stat.mtimeMs,
			size: stat.size,
		});
		return hasChanged;
	}

	/**
	 * Check if two sets have the same elements
	 */
	private setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
		if (a.size !== b.size) return false;
		for (const item of a) {
			if (!b.has(item)) return false;
		}
		return true;
	}

	/**
	 * Quick circular dependency check using DFS on cached graph.
	 * Only re-runs full madge check when imports change.
	 */
	async checkFile(filePath: string, cwd?: string): Promise<DepCheckResult> {
		const normalized = path.resolve(filePath);

		// Return early for non-existent files without running availability check
		if (!fs.existsSync(normalized)) {
			return {
				hasCircular: false,
				circular: [],
				checked: false,
				cacheHit: false,
			};
		}

		const projectRoot = path.resolve(cwd || process.cwd());

		// Check if imports changed before probing/installing madge.
		const importsChanged = this.importsChanged(normalized);

		if (!importsChanged) {
			// Return cached result
			return {
				hasCircular: this.circularFiles.has(normalized),
				circular: this.lastCircular.filter(
					(d) => d.file === normalized || d.path.includes(normalized),
				),
				checked: true,
				cacheHit: true,
			};
		}

		// Taken at classification time, not at publish time (see checkFilesBatch).
		const gen = ++this.opGeneration;

		if (!(await this.ensureAvailable(projectRoot))) {
			return {
				hasCircular: false,
				circular: [],
				checked: false,
				cacheHit: false,
			};
		}

		const key = `${projectRoot}:${normalized}`;
		const existing = this.checkInFlight.get(key);
		if (existing) return existing;

		// Identity-guarded release (#1968's pattern): delete only if THIS run is
		// still the registered one. A bare delete-by-key lets a late-settling run
		// evict a live successor a second writer registered under the same key
		// mid-flight, after which the next caller starts a duplicate check.
		const promise = this.runCheckFile(normalized, projectRoot, gen).finally(
			() => {
				if (this.checkInFlight.get(key) === promise) {
					this.checkInFlight.delete(key);
				}
			},
		);
		this.checkInFlight.set(key, promise);
		return promise;
	}

	private async runCheckFile(
		normalized: string,
		projectRoot: string,
		gen: number,
	): Promise<DepCheckResult> {
		const resolved = await this.resolveMadge(projectRoot);
		const spawnResult = await this.runMadgeSpawn(
			normalized,
			projectRoot,
			resolved,
		);
		if (!spawnResult.ok) {
			return {
				hasCircular: false,
				circular: [],
				checked: false,
				cacheHit: false,
			};
		}

		this.publishState(gen, spawnResult.circular, spawnResult.circularFiles);

		return {
			hasCircular: spawnResult.circular.length > 0,
			circular: spawnResult.circular.filter(
				(d) => d.file === normalized || d.path.includes(normalized),
			),
			checked: true,
			cacheHit: false,
			localSkips: spawnResult.localSkips,
		};
	}

	/**
	 * Run madge on a single file and parse its cycle output. Pure: unlike
	 * `runCheckFile`, this does NOT mutate `lastCircular`/`circularFiles` — it
	 * hands the parsed result back so callers can apply the shared-state update
	 * themselves (`runCheckFile` does so immediately; `checkFilesBatch` defers
	 * it so concurrent spawns can't clobber each other's writes, see #766).
	 */
	private async runMadgeSpawn(
		normalized: string,
		projectRoot: string,
		{ cmd, prefix }: ResolvedMadge,
	): Promise<
		| {
				ok: true;
				circular: CircularDep[];
				circularFiles: Set<string>;
				localSkips: number;
		  }
		| { ok: false }
	> {
		this.log(
			`Imports changed for ${path.basename(normalized)}, checking dependencies...`,
		);

		// Run madge on the specific file (fast)
		try {
			const result = await safeSpawnAsync(
				cmd,
				[...prefix, ...buildMadgeArgs(normalized, projectRoot)],
				{
					timeout: 15000,
					cwd: projectRoot,
				},
			);

			if (result.error) {
				this.log(`Check error: ${result.error.message}`);
				return { ok: false };
			}

			const output = result.stdout || "[]";
			const parsed = JSON.parse(output);

			// Madge --circular --json returns array of cycle arrays: [["a.ts", "b.ts"], ...]
			const cycles: string[][] = Array.isArray(parsed) ? parsed : [];
			const circular: CircularDep[] = [];
			const circularFiles = new Set<string>();

			for (const cycle of cycles) {
				const resolvedPaths = cycle.map((f: string) =>
					path.resolve(projectRoot, f),
				);
				for (const f of resolvedPaths) {
					circularFiles.add(f);
				}
				circular.push({
					file: resolvedPaths[0],
					path: resolvedPaths,
				});
			}

			const skips = parseMadgeSkips(result.stderr || "");
			if (skips.local.length > 0) {
				this.log(
					`madge skipped ${skips.local.length} local file(s) (possible silent cycle-miss): ${skips.local.slice(0, 5).join(", ")}`,
				);
			}

			return {
				ok: true,
				circular,
				circularFiles,
				localSkips: skips.local.length,
			};
		} catch (err: any) {
			this.log(`Check error: ${err.message}`);
			return { ok: false };
		}
	}

	/** Build the cache-hit `DepCheckResult` for `normalized` from a state snapshot. */
	private buildCachedResult(
		normalized: string,
		circular: CircularDep[],
		circularFiles: Set<string>,
	): DepCheckResult {
		return {
			hasCircular: circularFiles.has(normalized),
			circular: circular.filter(
				(d) => d.file === normalized || d.path.includes(normalized),
			),
			checked: true,
			cacheHit: true,
		};
	}

	/**
	 * Batch-check multiple files for circular deps in one turn-end pass,
	 * running the madge subprocess spawns concurrently (bounded by
	 * `MADGE_BATCH_CONCURRENCY`) instead of one at a time (#766).
	 *
	 * `lastCircular`/`circularFiles` are shared instance state that every madge
	 * run OVERWRITES wholesale, so ordering has to be pinned on two axes.
	 *
	 * WITHIN a batch — equivalence with the sequential `for…await
	 * checkFile(file)` loop this replaces:
	 *  - Classification (existence + `importsChanged`) runs synchronously in
	 *    original array order first — identical to what each sequential
	 *    `checkFile()` call would do, including the `importCache` side effect.
	 *  - Only the actual madge spawns for import-changed ("miss") files run
	 *    concurrently; each one's parsed result stays LOCAL (no shared-state
	 *    write) until every spawn has settled.
	 *  - The miss results are then folded in ORIGINAL array order (not
	 *    completion order) into a BATCH-LOCAL copy of the state, so each
	 *    cache-hit file's result reads the state as of its own position in the
	 *    array — byte-for-byte what the sequential last-write-wins loop
	 *    returned. The fold is synchronous, so the instance-state write is one
	 *    atomic assignment at the end; no concurrent spawn can interleave into
	 *    it, and the returned map is unaffected by whether that write survives
	 *    the rule below.
	 *
	 * ACROSS operations — newest classification wins:
	 *  - `checkFile`, `checkFilesBatch` and `scanProject` all write the same
	 *    shared state and genuinely overlap (turn-end vs. the background scans
	 *    in runtime-session and project-diagnostics/fresh-fetch). Each takes a
	 *    generation when it classifies, and `publishState` drops a write whose
	 *    generation is no longer the newest — so an operation that started
	 *    against OLDER file content cannot resurrect that view over a newer
	 *    operation that already published, whatever order the spawns finish in.
	 *  - ONLY the shared-state write is gated. Every per-file result handed back
	 *    to the caller is built from that file's own spawn output, so a dropped
	 *    publish never fabricates or hides a cycle for the caller.
	 *  - No result cache is introduced (#533, "when in doubt, re-run"): changed
	 *    content still re-runs madge every time, and the guard only skips writes
	 *    that a newest-wins sequential interleaving would also have discarded.
	 */
	async checkFilesBatch(
		filePaths: string[],
		cwd?: string,
	): Promise<{ results: Map<string, DepCheckResult>; stats: MadgeBatchStats }> {
		const projectRoot = path.resolve(cwd || process.cwd());
		const results = new Map<string, DepCheckResult>();
		const gen = ++this.opGeneration;

		type Entry =
			| { kind: "missing"; file: string }
			| { kind: "hit"; file: string; normalized: string }
			| { kind: "miss"; file: string; normalized: string };

		const entries: Entry[] = [];
		for (const file of filePaths) {
			const normalized = path.resolve(projectRoot, file);
			if (!fs.existsSync(normalized)) {
				entries.push({ kind: "missing", file });
				continue;
			}
			entries.push(
				this.importsChanged(normalized)
					? { kind: "miss", file, normalized }
					: { kind: "hit", file, normalized },
			);
		}

		const missEntries = entries.filter(
			(e): e is Extract<Entry, { kind: "miss" }> => e.kind === "miss",
		);

		const notAvailableResult: DepCheckResult = {
			hasCircular: false,
			circular: [],
			checked: false,
			cacheHit: false,
		};

		const stats: MadgeBatchStats = {
			requested: filePaths.length,
			missing: entries.filter((e) => e.kind === "missing").length,
			cacheHits: entries.filter((e) => e.kind === "hit").length,
			spawned: 0,
			failed: 0,
			resolveMs: 0,
			targets: [],
			targetsTruncated: false,
		};

		if (missEntries.length > 0 && !(await this.ensureAvailable(projectRoot))) {
			// madge unavailable: mirrors checkFile()'s "not available" branch for
			// every miss; hits still read whatever shared state already exists.
			// The miss set counts as failed — reporting it as zero-of-everything
			// would read as a clean turn that simply had nothing to do.
			stats.failed = missEntries.length;
			for (const entry of entries) {
				if (entry.kind === "hit") {
					results.set(
						entry.file,
						this.buildCachedResult(
							entry.normalized,
							this.lastCircular,
							this.circularFiles,
						),
					);
				} else {
					results.set(entry.file, notAvailableResult);
				}
			}
			return { results, stats };
		}

		// Run the concurrent (bounded) madge spawns for the miss set only. Each
		// result stays local — keyed by normalized path — until folded below.
		const spawnResults = new Map<
			string,
			Awaited<ReturnType<DependencyChecker["runMadgeSpawn"]>>
		>();
		const spawnDurations = new Map<string, number>();
		if (missEntries.length > 0) {
			const resolveStart = Date.now();
			const resolved = await this.resolveMadge(projectRoot);
			stats.resolveMs = Date.now() - resolveStart;
			stats.commandKind = resolved.kind;
			await mapWithConcurrency(
				missEntries,
				MADGE_BATCH_CONCURRENCY,
				async (entry) => {
					stats.spawned++;
					const startedAt = Date.now();
					spawnResults.set(
						entry.normalized,
						await this.runMadgeSpawn(entry.normalized, projectRoot, resolved),
					);
					spawnDurations.set(entry.normalized, Date.now() - startedAt);
				},
			);
		}

		// Fold in original order into a batch-local view: each miss overwrites it
		// exactly as the sequential loop would overwrite the shared state, and
		// each hit is resolved against the view as folded up to (but not past)
		// its own position.
		let foldedCircular = this.lastCircular;
		let foldedCircularFiles = this.circularFiles;
		let folded = false;
		for (const entry of entries) {
			if (entry.kind === "missing") {
				results.set(entry.file, notAvailableResult);
				continue;
			}
			if (entry.kind === "hit") {
				results.set(
					entry.file,
					this.buildCachedResult(
						entry.normalized,
						foldedCircular,
						foldedCircularFiles,
					),
				);
				continue;
			}
			const spawnResult = spawnResults.get(entry.normalized);
			const durationMs = spawnDurations.get(entry.normalized) ?? 0;
			if (
				durationMs >= MADGE_STATS_TARGET_MIN_DURATION_MS &&
				stats.targets.length < MADGE_STATS_TARGET_CAP
			) {
				stats.targets.push({
					file: path.relative(projectRoot, entry.normalized),
					durationMs,
					ok: spawnResult?.ok === true,
				});
			} else if (durationMs >= MADGE_STATS_TARGET_MIN_DURATION_MS) {
				stats.targetsTruncated = true;
			}
			if (!spawnResult || !spawnResult.ok) {
				stats.failed++;
				results.set(entry.file, notAvailableResult);
				continue;
			}
			foldedCircular = spawnResult.circular;
			foldedCircularFiles = spawnResult.circularFiles;
			folded = true;
			results.set(entry.file, {
				hasCircular: spawnResult.circular.length > 0,
				circular: spawnResult.circular.filter(
					(d) =>
						d.file === entry.normalized || d.path.includes(entry.normalized),
				),
				checked: true,
				cacheHit: false,
				localSkips: spawnResult.localSkips,
			});
		}

		// A batch that learned nothing publishes nothing — advancing the
		// generation on an unchanged view would suppress an older operation's
		// still-legitimate write for free.
		if (folded) {
			this.publishState(gen, foldedCircular, foldedCircularFiles);
		}

		return { results, stats };
	}

	/**
	 * Format circular dependency warning for LLM
	 */
	formatWarning(filePath: string, deps: string[]): string {
		if (deps.length === 0) return "";

		const filename = path.basename(filePath);
		const depNames = deps.map((d) => path.basename(d));

		let output = `[Circular Deps] ${filename} is in a cycle:\n`;
		output += `  ${filename} ↔ ${depNames.join(", ")}\n`;
		output += `\n  Consider extracting shared code to a separate module.\n`;

		return output;
	}

	/**
	 * Full project scan (for /check-deps command)
	 */
	async scanProject(
		cwd?: string,
	): Promise<{ circular: CircularDep[]; count: number } & AnalysedRootSignal> {
		const projectRoot = path.resolve(cwd || process.cwd());

		// Return early for non-existent or empty directories before probing/installing.
		if (!fs.existsSync(projectRoot)) {
			return { circular: [], count: 0 };
		}
		const entries = fs.readdirSync(projectRoot);
		const hasSourceFiles = entries.some(
			(e) => /\.(ts|tsx|js|jsx)$/.test(e) && !e.endsWith(".d.ts"),
		);
		if (!hasSourceFiles) {
			return { circular: [], count: 0 };
		}

		if (!(await this.ensureAvailable(projectRoot))) {
			return { circular: [], count: 0 };
		}

		const existing = this.scanInFlight.get(projectRoot);
		if (existing) return existing;

		// A whole-project scan writes the same shared state a turn-end batch
		// does, and the two overlap (runtime-session, fresh-fetch), so it takes a
		// generation too — claimed before the spawn, as late as a scan can.
		const gen = ++this.opGeneration;
		// Identity-guarded release (#1968's pattern): delete only if THIS run is
		// still the registered one. A bare delete-by-key lets a late-settling run
		// evict a live successor a second writer registered under the same key
		// mid-flight, after which the next caller starts a duplicate scan.
		const promise = this.runScanProject(projectRoot, gen).finally(() => {
			if (this.scanInFlight.get(projectRoot) === promise) {
				this.scanInFlight.delete(projectRoot);
			}
		});
		this.scanInFlight.set(projectRoot, promise);
		return promise;
	}

	private async runScanProject(
		projectRoot: string,
		gen: number,
	): Promise<{ circular: CircularDep[]; count: number } & AnalysedRootSignal> {
		try {
			const { cmd, prefix } = await this.resolveMadge(projectRoot);
			const result = await safeSpawnAsync(
				cmd,
				[...prefix, ...buildMadgeArgs(projectRoot, projectRoot)],
				{
					timeout: 30000,
					cwd: projectRoot,
				},
			);

			if (result.error) {
				this.log(`Scan error: ${result.error.message}`);
				return { circular: [], count: 0 };
			}

			const output = result.stdout || "{}";
			const data = JSON.parse(output);

			const circular: CircularDep[] = [];
			const circularFiles = new Set<string>();

			for (const [file, deps] of Object.entries(data)) {
				if (Array.isArray(deps) && deps.length > 0) {
					const resolvedFile = path.resolve(file);
					circularFiles.add(resolvedFile);

					circular.push({
						file: resolvedFile,
						path: [resolvedFile, ...deps.map((d: string) => path.resolve(d))],
					});
				}
			}

			this.publishState(gen, circular, circularFiles);

			// #2154: the one madge site that parsed a graph for this root. Every
			// other return here (missing root, no top-level source file, madge
			// unavailable, spawn error, parse throw) is the SAME empty shape and
			// must not be read as "no cycles in this project".
			return {
				circular,
				count: circular.length,
				analyzed: true,
			};
		} catch (err: any) {
			this.log(`Scan error: ${err.message}`);
			return { circular: [], count: 0 };
		}
	}

	/**
	 * Format full scan results
	 */
	formatScanResult(circular: CircularDep[]): string {
		if (circular.length === 0) return "";

		// Group by cycle to avoid duplicate entries
		const seen = new Set<string>();
		let output = `[Circular Deps] ${circular.length} cycle(s) found:\n`;

		for (const dep of circular) {
			// Copy before sorting: `dep.path` is rendered verbatim below (and by
			// other CircularDep consumers, e.g. madge.ts's diagnostic renderer),
			// so the dedupe key must not reorder — let alone mutate in place —
			// the path a user reads.
			const cycleKey = [...dep.path].sort(compareOrdinal).join("→");
			if (seen.has(cycleKey)) continue;
			seen.add(cycleKey);

			const names = dep.path.map((p) => path.relative(process.cwd(), p));
			output += `  • ${names.join(" → ")}\n`;
		}

		output += "\n  Consider extracting shared code to break cycles.\n";

		return output;
	}
}

/**
 * Reset the madge managed-path memo on every live `DependencyChecker`.
 * Free-function wrapper (matching `resetSafeSpawnWindowsCommandCache`'s
 * shape) so callers reset without needing a checker instance in hand — see
 * `DependencyChecker.resetMadgeManagedPathMemo` for why this exists (#1276).
 */
export function resetMadgeManagedPathMemo(): void {
	DependencyChecker.resetMadgeManagedPathMemo();
}
