/**
 * Cross-file dead-code detection for non-JS/TS ecosystems (#127).
 *
 * Knip (clients/knip-client.ts) gives JS/TS projects project-wide unused
 * exports/files/deps at session_start. Per-file dispatch linters can't do that
 * for other languages — "this exported function is unused anywhere" needs a
 * whole-project scan. This module is the per-language harness that closes the
 * gap, paralleling KnipClient's lifecycle (detect → ensureAvailable → analyze,
 * cached at session_start, surfaced as a turn_end advisory).
 *
 * Phase 1 ships Python via `vulture`. Future phases add Go/Rust/etc. by
 * implementing DeadCodeClient and adding to getDeadCodeClients().
 */

import type { AnalysedRootSignal } from "./analysed-root.js";
import { createSubsystemLogger } from "./extension-log.js";
import { incrementDegradationCount } from "./degradation-ledger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { findLocalBinsAt, VENV_BIN_DIRS } from "./package-manager.js";
import { findNearestMarkerRoot } from "./path-utils.js";
import { getScratchTreeFnmatchPatterns } from "./scratch-tree-policy.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import {
	type ProbeEvidence,
	classifyProbeFailure,
	createAvailabilityLatch,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";
import {
	firstOutputLine,
	spawnFailedWithNoOutput,
} from "./dispatch/runners/utils/spawn-outcome.js";
import { formatToolFailure } from "./dispatch/runners/utils/tool-failure.js";
import { getProjectIgnoreMatcher } from "./file-utils.js";
import { shouldRecurseIntoDir, walkTreeStackSync } from "./source-walker.js";

// --- Types ---

/** A single dead-code finding, normalized across languages/tools. */
export interface DeadCodeIssue {
	/** Uniform bucket so the advisory reads the same regardless of tool. */
	category: "export" | "file" | "dependency" | "unlisted";
	/** Tool-specific kind, e.g. "function" | "class" | "import" (for display). */
	kind: string;
	name: string;
	file?: string;
	line?: number;
	/** 0–100 where the tool reports it (vulture); omitted otherwise. */
	confidence?: number;
}

/** Uniform result shape (mirrors KnipResult's buckets). */
export interface DeadCodeResult extends AnalysedRootSignal {
	success: boolean;
	language: string;
	unusedExports: DeadCodeIssue[];
	unusedFiles: DeadCodeIssue[];
	unusedDeps: DeadCodeIssue[];
	unlistedDeps: DeadCodeIssue[];
	summary: string;
	/** Total wall-clock of the scan; populated by analyze() for telemetry. */
	durationMs?: number;
}

export interface DeadCodeClient {
	/** Stable id used for cache keys + telemetry (e.g. "python"). */
	readonly id: string;
	/** Human-facing language label (e.g. "Python"). */
	readonly language: string;
	/** Cheap synchronous probe: does a project of this language live at cwd? */
	detect(cwd: string): boolean;
	/** Is this file one this client analyzes? Gates the per-turn delta re-scan. */
	owns(filePath: string): boolean;
	/** Resolve the binary (project venv first, then PATH; no auto-install). */
	ensureAvailable(root?: string): Promise<boolean>;
	/** Project-wide scan. Never throws; failures come back as success:false. */
	analyze(cwd: string): Promise<DeadCodeResult>;
}

function emptyResult(language: string): Omit<DeadCodeResult, "summary"> {
	return {
		success: false,
		language,
		unusedExports: [],
		unusedFiles: [],
		unusedDeps: [],
		unlistedDeps: [],
	};
}

const ANALYSIS_TIMEOUT_MS = 30_000;

// Directories never worth scanning for the user's own dead code.
//
// Single-sourced from `scratch-tree-policy.ts`'s `EXCLUDED_DIRS`-derived list
// (#1562 sweep finding: this array had hand-drifted from `EXCLUDED_DIRS` —
// missing `.pi`/`.claude`/`.next`/`.turbo`/etc, the same single-source-of-
// truth defect #883 named for per-language lists). `site-packages`/`.eggs`
// are Python-packaging-specific and have no `EXCLUDED_DIRS` counterpart (no
// other scanner needs them), so they stay as a small local addition rather
// than polluting the shared cross-tool list.
const VULTURE_PYTHON_ONLY_EXCLUDES = ["*/site-packages/*", "*/.eggs/*"];
const VULTURE_EXCLUDES = [
	...getScratchTreeFnmatchPatterns(),
	...VULTURE_PYTHON_ONLY_EXCLUDES,
];

// Decorators whose target is called by a framework, never by name in the tree.
// vulture cannot see those call sites, so every such symbol is a permanent
// false positive that reappears in every scan — the fastest way to teach a
// reader to stop reading the advisory. Glob-matched by vulture itself.
const VULTURE_IGNORE_DECORATORS = [
	"@pytest.fixture",
	"@pytest.fixture(*",
	"@fixture",
	"@fixture(*",
	"@app.*",
	"@router.*",
	"@celery.task*",
	"@task",
	"@shared_task*",
];

// vulture line: `path/to/file.py:12: unused function 'foo' (60% confidence)`
const VULTURE_LINE =
	/^(.*?):(\d+): unused (\w[\w ]*?) '([^']+)' \((\d+)% confidence\)\s*$/;

function pythonAnalyzedFiles(root: string): string[] {
	const files: string[] = [];
	const ignoreMatcher = getProjectIgnoreMatcher(root);
	walkTreeStackSync(root, (entry, fullPath) => {
		if (entry.isDirectory()) {
			return shouldRecurseIntoDir(entry, fullPath, {
				ignoreMatcher,
				followSymlinks: false,
			})
				? "recurse"
				: "skip";
		}
		if (
			entry.isFile() &&
			/\.pyi?$/.test(entry.name) &&
			!ignoreMatcher.isIgnored(fullPath, false)
		) {
			files.push(path.resolve(fullPath));
		}
		return "skip";
	});
	return files;
}

/**
 * Parse vulture's text output into normalized issues. Pure (no spawn/fs) so the
 * parser is unit-testable against captured output. Unrecognized lines (banner,
 * `unreachable code` without a quoted name) are ignored. `root` makes file
 * paths project-relative when possible.
 */
export function parseVultureOutput(
	output: string,
	root: string,
): DeadCodeIssue[] {
	const issues: DeadCodeIssue[] = [];
	for (const raw of output.split(/\r?\n/)) {
		const m = raw.match(VULTURE_LINE);
		if (!m) continue;
		const [, file, line, kind, name, confidence] = m;
		// All map to the "export" bucket (a defined symbol used nowhere); the
		// `kind` preserves function/class/import/etc. for display.
		let rel = file;
		try {
			rel = path.relative(root, file) || file;
		} catch {
			rel = file;
		}
		issues.push({
			category: "export",
			kind: kind.trim(),
			name,
			file: rel,
			line: Number.parseInt(line, 10),
			confidence: Number.parseInt(confidence, 10),
		});
	}
	return issues;
}

/**
 * Python dead-code via vulture (https://github.com/jendrikseipp/vulture).
 *
 * vulture finds unused functions, classes, methods, imports, variables and
 * attributes by static analysis of the whole tree. It has no JSON reporter, so
 * we parse its stable one-line-per-finding text output. A clean run exits 0;
 * found dead code exits 3 with findings on stdout. A non-zero exit with
 * parseable output is success, not failure (see runAnalyze for the table).
 */
export class PythonDeadCodeClient implements DeadCodeClient {
	readonly id = "python";
	readonly language = "Python";

	/**
	 * Transient-aware memo (#1467): only a durable "vulture is not installed"
	 * verdict is remembered for the session. A probe that timed out expires and
	 * is re-probed, so vulture cannot be disabled for the process by one stall.
	 */
	private readonly availabilityLatch = createAvailabilityLatch();
	private resolved: { cmd: string; prefix: string[] } | null = null;
	private ensureInFlight: Promise<boolean> | null = null;
	private inFlight = new Map<string, Promise<DeadCodeResult>>();
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("dead-code:python") : () => {};
	}

	private get minConfidence(): number {
		const raw = Number.parseInt(
			process.env.PI_LENS_VULTURE_MIN_CONFIDENCE ?? "60",
			10,
		);
		return Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 60;
	}

	detect(cwd: string): boolean {
		return this.resolveProjectRoot(cwd) !== null;
	}

	owns(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return ext === ".py" || ext === ".pyi";
	}

	/**
	 * Nearest dir with a Python project marker, never at/above $HOME and never
	 * escaping a VCS boundary — same containment rules as KnipClient so a scan
	 * launched from a bare cwd can't recurse the whole home tree (#250/#296).
	 * Delegates to the shared path-utils helper (refs #625) rather than
	 * hand-rolling the climb; only the marker list differs from KnipClient's.
	 */
	private resolveProjectRoot(
		startDir: string,
		homeDirOverride?: string,
	): string | null {
		return findNearestMarkerRoot(
			startDir,
			[
				"pyproject.toml",
				"setup.py",
				"setup.cfg",
				"requirements.txt",
				"Pipfile",
				"tox.ini",
			],
			{ boundaries: [".git", ".hg", ".svn"], homeDir: homeDirOverride },
		);
	}

	async ensureAvailable(root?: string): Promise<boolean> {
		const memo = this.availabilityLatch.read();
		if (memo !== null) return memo;
		if (this.ensureInFlight) return this.ensureInFlight;
		this.ensureInFlight = this.doEnsureAvailable(root);
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	/**
	 * `<root>/.venv/bin/vulture` (and `venv`/Windows `Scripts` equivalents),
	 * checked by existence only — no spawn. A project's own venv is the vulture
	 * that project's own config and dependency set were written against; the
	 * bare `vulture`/`python -m vulture` PATH probes below only ever see
	 * whatever happens to be active in the CALLING shell, not the project's
	 * (#1731, discipline B — the same venv-first shape sqlfluff's binary
	 * resolution already uses, `runner-helpers.ts` `createVenvFinder`).
	 *
	 * The directory list is the shared `VENV_BIN_DIRS` — this was a third
	 * private spelling of the same four venv directories, with a
	 * `process.platform` branch that meant the ubuntu lane never saw the
	 * `Scripts` half at all (defect shape 30).
	 *
	 * The search is a fixed lookup at `root` ONLY (`findLocalBinsAt`, no
	 * ancestor walk) — #2544 review round 3 folded this onto the shared
	 * ancestor walker, reasoning a monorepo package should find its
	 * repo-root venv, but that was an unrequested behaviour change with no
	 * #2514 defect behind it. Reverted in round 4 F2. `findLocalBinsAt`
	 * returns EVERY match at `root` rather than the first, because
	 * `doEnsureAvailable` probes candidates in order and must keep the
	 * `venv/` fallback when a `.venv/` vulture exists but cannot run.
	 */
	private venvCandidates(
		root: string,
	): Array<{ cmd: string; prefix: string[] }> {
		return findLocalBinsAt(["vulture"], root, {
			windowsExt: ".exe",
			binDirs: VENV_BIN_DIRS,
		}).map((full) => ({ cmd: full, prefix: [] }));
	}

	private async doEnsureAvailable(root?: string): Promise<boolean> {
		// Presence-gated, NOT auto-installed. vulture is a pure-Python package
		// with no standalone binary, so "auto-install" would mean `pip install`
		// into whatever Python environment happens to be active — wrong and
		// intrusive for uv / poetry / conda / pipx users. So we only use vulture
		// when the user already has it, probing the project's own venv first
		// (#1731), then the `vulture` console script and `python -m vulture` on
		// PATH (the script dir is frequently not on PATH even when the package
		// is installed). Mirrors govulncheck's no-install gating.
		const candidates: Array<{ cmd: string; prefix: string[] }> = [
			...(root ? this.venvCandidates(root) : []),
			{ cmd: "vulture", prefix: [] },
			{ cmd: "python", prefix: ["-m", "vulture"] },
			{ cmd: "python3", prefix: ["-m", "vulture"] },
		];
		// A timeout on ANY candidate means the machine, not the tool, answered —
		// the run gets a bounded retry instead of a permanent skip (#1467).
		let sawTransient = false;
		let transientCause: ReturnType<typeof classifyProbeFailure>["cause"] =
			"probe-timeout";
		// Accumulated across ALL candidates, because the failure verdicts below
		// are about the whole sweep rather than any one probe. Reporting zero
		// here would erase the evidence that cracked #1467: four 5s probes and
		// a stalled host look identical to an absent tool without these two
		// numbers.
		const sweepStartedAt = Date.now();
		let sweepHostStallMs = 0;
		/** What the last classified candidate returned (#1500 review): this was
		 * computed and thrown away, so every vulture row said "missing" with no
		 * trace of which candidate reported what. */
		let sweepEvidence: ProbeEvidence | undefined;
		for (const c of candidates) {
			const sampler = startHostStallSampler();
			const startedAt = Date.now();
			let probe: Awaited<ReturnType<typeof safeSpawnAsync>>;
			let hostStallMs: number;
			try {
				probe = await safeSpawnAsync(c.cmd, [...c.prefix, "--version"], {
					timeout: 5000,
				});
			} finally {
				hostStallMs = sampler.stop();
				sweepHostStallMs += hostStallMs;
			}
			if (!probe.error && probe.status === 0) {
				this.resolved = c;
				this.availabilityLatch.noteAvailable();
				this.log(`vulture found: ${[c.cmd, ...c.prefix].join(" ")}`);
				logAvailabilityDecision({
					tool: "vulture",
					verdict: "available",
					outcome: "success",
					cause: "ok",
					elapsedMs: Date.now() - startedAt,
					latched: true,
					hostStallMs,
					budgetMs: 5000,
					classifiedBy: "probe",
				});
				return true;
			}
			const classified = classifyProbeFailure(probe, {
				hostStallMs,
				command: c.cmd,
			});
			sweepEvidence = classified.evidence;
			if (classified.outcome === "transient") {
				sawTransient = true;
				transientCause = classified.cause;
			}
		}
		if (sawTransient) {
			const retryAfterMs = this.availabilityLatch.noteUnavailable(
				"transient",
				transientCause,
			);
			this.log("vulture probe timed out; will retry (not treated as missing)");
			logAvailabilityDecision({
				tool: "vulture",
				verdict: "unavailable",
				outcome: "transient",
				cause: transientCause,
				elapsedMs: Date.now() - sweepStartedAt,
				hostStallMs: sweepHostStallMs,
				latched: false,
				retryAfterMs,
				budgetMs: 5000,
				classifiedBy: "probe",
				...(sweepEvidence !== undefined && { evidence: sweepEvidence }),
			});
			return false;
		}
		this.availabilityLatch.noteUnavailable("missing", "not-found");
		this.log("vulture not installed; skipping (no auto-install)");
		logAvailabilityDecision({
			tool: "vulture",
			verdict: "unavailable",
			outcome: "missing",
			cause: "not-found",
			elapsedMs: Date.now() - sweepStartedAt,
			hostStallMs: sweepHostStallMs,
			latched: true,
			budgetMs: 5000,
			// Every candidate probe was classified, and none was transient (#1500).
			classifiedBy: "probe",
			...(sweepEvidence !== undefined && { evidence: sweepEvidence }),
		});
		return false;
	}

	async analyze(cwd: string): Promise<DeadCodeResult> {
		const root = this.resolveProjectRoot(cwd || process.cwd());
		if (!root) {
			return {
				...emptyResult(this.language),
				success: true,
				summary: "No Python project root found; vulture skipped",
			};
		}
		if (!(await this.ensureAvailable(root))) {
			return {
				...emptyResult(this.language),
				success: true,
				summary:
					"vulture not installed; skipped. Install vulture (pip/uv/pipx) to enable Python dead-code detection.",
			};
		}
		const key = path.resolve(root);
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const promise = this.runAnalyze(key);
		const wrapped = promise.finally(() => {
			// Identity-guarded release (#1968, #1967's pattern): delete only if
			// THIS build is still the registered one. A bare delete-by-key lets
			// a late-settling build A evict a live build B that replaced the
			// entry mid-flight, and the next caller starts a duplicate.
			if (this.inFlight.get(key) === wrapped) this.inFlight.delete(key);
		});
		this.inFlight.set(key, wrapped);
		return wrapped;
	}

	/**
	 * True when `<root>/pyproject.toml` carries a `[tool.vulture]` table.
	 * vulture's own config discovery reads that table, but CLI flags override
	 * it — passing `--min-confidence`/`--exclude` unconditionally silently
	 * overrode a project's own thresholds and ignore list (#1731, discipline A).
	 * Same shape as `hasSqlfluffConfig`/`hasMypyConfig` in `tool-policy.ts`: a
	 * plain string search, no TOML parser, matching the section header only.
	 */
	private hasProjectVultureConfig(root: string): boolean {
		try {
			const content = fs.readFileSync(
				path.join(root, "pyproject.toml"),
				"utf-8",
			);
			return content.includes("[tool.vulture]");
		} catch {
			return false;
		}
	}

	private async runAnalyze(root: string): Promise<DeadCodeResult> {
		const startMs = Date.now();
		const invocation = this.resolved ?? { cmd: "vulture", prefix: [] };
		// Let the project's own [tool.vulture] config win (#1731, discipline A):
		// vulture discovers it unaided, but these two flags override it when
		// passed, so they are omitted whenever the project ships that table.
		const hasConfig = this.hasProjectVultureConfig(root);
		const args = [
			...invocation.prefix,
			".",
			...(hasConfig ? [] : [`--min-confidence=${this.minConfidence}`]),
			...(hasConfig ? [] : [`--exclude=${VULTURE_EXCLUDES.join(",")}`]),
			`--ignore-decorators=${VULTURE_IGNORE_DECORATORS.join(",")}`,
		];
		const result = await safeSpawnAsync(invocation.cmd, args, {
			timeout: ANALYSIS_TIMEOUT_MS,
			cwd: root,
		});
		const durationMs = Date.now() - startMs;

		// Spawn-level failure (ENOENT, timeout) — not a "found issues" exit.
		if (result.error) {
			this.log(`scan error: ${result.error.message}`);
			return {
				...emptyResult(this.language),
				summary: `Error: ${result.error.message}`,
				durationMs,
			};
		}
		// Verified exit-code table (vulture 2.16, probed live during the #1758
		// review): a clean run exits 0 with empty stdout; dead code found exits
		// 3 with findings on stdout; invalid input or a parse error exits 1
		// with empty stdout and the error on stderr. #1736 sweep: the ORIGINAL
		// guard here required non-empty stderr to call it an error, so a
		// nonzero exit with BOTH empty stdout and empty stderr (a silent crash)
		// still fell through to "No dead code found" -- the same
		// empty-distinguishes-clean-from-errored gap the knip fix closes. A
		// nonzero exit with no findings on stdout is never clean now,
		// regardless of whether stderr said anything.
		const output = result.stdout || "";
		const partial =
			result.failure === "timeout" || result.outputTruncated === true;
		if (!output.trim()) {
			const stderr = (result.stderr || "").trim();
			// Same discriminator every dispatch/runners linter uses
			// (`spawnFailedWithNoOutput`) rather than a parallel hand-rolled
			// check (result.error is already handled above, so this reduces to
			// the `status !== 0` half).
			if (spawnFailedWithNoOutput(result, output)) {
				// #1816: one shared wording, one truncation, signal named.
				const reason = formatToolFailure({
					tool: "vulture",
					status: result.status,
					signal: result.signal,
					stderr: result.stderr,
				});
				this.log(reason);
				incrementDegradationCount({
					kind: "runner-empty-result",
					subject: "vulture",
					reason,
				});
				return {
					...emptyResult(this.language),
					summary: stderr
						? `vulture error: ${firstOutputLine(stderr)}`
						: reason,
					durationMs,
				};
			}
			// vulture's verified exit-code table (above): exit 0 with empty
			// stdout IS the clean-run signal, so this ran over the root
			// (#2154) — unlike knip, whose clean run always prints JSON.
			return {
				...emptyResult(this.language),
				success: true,
				analyzed: true,
				analyzedFiles: pythonAnalyzedFiles(root),
				...(partial ? { analysisComplete: false } : {}),
				summary: "No dead code found",
				durationMs,
			};
		}
		return {
			...this.parseOutput(output, root),
			durationMs,
			analyzedFiles: pythonAnalyzedFiles(root),
			...(partial ? { analysisComplete: false } : {}),
		};
	}

	private parseOutput(output: string, root: string): DeadCodeResult {
		const unusedExports = parseVultureOutput(output, root);
		const total = unusedExports.length;
		return {
			...emptyResult(this.language),
			success: true,
			// #2154: parsed vulture output for this root.
			analyzed: true,
			unusedExports,
			summary:
				total === 0
					? "No dead code found"
					: `Found ${total} unused Python symbol(s)`,
		};
	}
}

/**
 * The dead-code clients to run at session_start. Each is offered every project;
 * the orchestrator calls detect() to decide which actually apply (polyglot
 * repos may run several). Phase 1: Python only.
 */
export function getDeadCodeClients(verbose = false): DeadCodeClient[] {
	return [new PythonDeadCodeClient(verbose)];
}

/** Total issue count across all buckets — convenience for advisories/telemetry. */
export function deadCodeIssueCount(result: DeadCodeResult): number {
	return (
		result.unusedExports.length +
		result.unusedFiles.length +
		result.unusedDeps.length +
		result.unlistedDeps.length
	);
}

/** Every bucket flattened — delta diffing and diagnostic mapping want one list. */
export function deadCodeIssues(result: DeadCodeResult): DeadCodeIssue[] {
	return [
		...result.unusedExports,
		...result.unusedFiles,
		...result.unusedDeps,
		...result.unlistedDeps,
	];
}

/**
 * Joins finding-identity parts into a stable key for diffing one scan
 * against the previous one. The string-only signature is load-bearing: a
 * line/column number cannot be passed without a compile error. An edit
 * shifts every line below it, and a scan delta is then filtered to exactly
 * the files the edit touched — so a line in the key turns each shifted
 * pre-existing finding into a "newly unused" report under a heading that
 * blames the agent's own edit for orphaning it. Inserting four lines above
 * one real finding produced four false ones (#1477, #1483). Shared by
 * knip's per-turn delta in runtime-turn.ts so the rule lives in one place.
 */
export function stableFindingKey(...parts: Array<string | undefined>): string {
	return parts.map((part) => part ?? "").join(":");
}

/** Stable identity for diffing one scan against the previous one. */
export function deadCodeIssueKey(issue: DeadCodeIssue): string {
	return stableFindingKey(issue.category, issue.file, issue.name);
}

/**
 * Format this turn's ATTRIBUTABLE delta — symbols that became unused in files
 * the agent just edited — or "" when there is nothing to report. Mirrors the
 * Knip advisory's contract deliberately: the project-wide list is not injected
 * per turn (hundreds of pre-existing findings would drown the blockers and burn
 * context every turn), it stays available on demand via lens_diagnostics.
 */
export function formatDeadCodeDelta(
	issues: DeadCodeIssue[],
	language: string,
	max = 5,
): string {
	if (issues.length === 0) return "";
	let report = `💀 Newly unused ${language} symbols in files you edited — check if callers need updating (dead-code):\n`;
	for (const issue of issues.slice(0, max)) {
		const loc = issue.file
			? `${issue.file}${issue.line ? `:${issue.line}` : ""}`
			: "(unknown)";
		report += `  ${loc} — unused ${issue.kind} ${issue.name}\n`;
	}
	if (issues.length > max) {
		report += `  … and ${issues.length - max} more\n`;
	}
	return report;
}
