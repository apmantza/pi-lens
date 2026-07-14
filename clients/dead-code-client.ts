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

import * as path from "node:path";
import { findNearestMarkerRoot } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";

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
export interface DeadCodeResult {
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
	/** Resolve the binary (PATH first, then auto-install). */
	ensureAvailable(): Promise<boolean>;
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
const VULTURE_EXCLUDES = [
	"*/.venv/*",
	"*/venv/*",
	"*/.tox/*",
	"*/build/*",
	"*/dist/*",
	"*/node_modules/*",
	"*/.git/*",
	"*/site-packages/*",
	"*/__pycache__/*",
	"*/.eggs/*",
];

// vulture line: `path/to/file.py:12: unused function 'foo' (60% confidence)`
const VULTURE_LINE =
	/^(.*?):(\d+): unused (\w[\w ]*?) '([^']+)' \((\d+)% confidence\)\s*$/;

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
 * we parse its stable one-line-per-finding text output. It exits 1 when it
 * FINDS dead code (linter convention), so a non-zero exit with parseable
 * output is success, not failure.
 */
export class PythonDeadCodeClient implements DeadCodeClient {
	readonly id = "python";
	readonly language = "Python";

	private available: boolean | null = null;
	private resolved: { cmd: string; prefix: string[] } | null = null;
	private ensureInFlight: Promise<boolean> | null = null;
	private inFlight = new Map<string, Promise<DeadCodeResult>>();
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[dead-code:python] ${msg}`)
			: () => {};
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

	async ensureAvailable(): Promise<boolean> {
		if (this.available !== null) return this.available;
		if (this.ensureInFlight) return this.ensureInFlight;
		this.ensureInFlight = this.doEnsureAvailable();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(): Promise<boolean> {
		// Presence-gated, NOT auto-installed. vulture is a pure-Python package
		// with no standalone binary, so "auto-install" would mean `pip install`
		// into whatever Python environment happens to be active — wrong and
		// intrusive for uv / poetry / conda / pipx users. So we only use vulture
		// when the user already has it, probing both the `vulture` console script
		// and `python -m vulture` (the script dir is frequently not on PATH even
		// when the package is installed). Mirrors govulncheck's no-install gating.
		const candidates: Array<{ cmd: string; prefix: string[] }> = [
			{ cmd: "vulture", prefix: [] },
			{ cmd: "python", prefix: ["-m", "vulture"] },
			{ cmd: "python3", prefix: ["-m", "vulture"] },
		];
		for (const c of candidates) {
			const probe = await safeSpawnAsync(c.cmd, [...c.prefix, "--version"], {
				timeout: 5000,
			});
			if (!probe.error && probe.status === 0) {
				this.resolved = c;
				this.available = true;
				this.log(`vulture found: ${[c.cmd, ...c.prefix].join(" ")}`);
				return true;
			}
		}
		this.available = false;
		this.log("vulture not installed; skipping (no auto-install)");
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
		if (!(await this.ensureAvailable())) {
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
		const promise = this.runAnalyze(key).finally(() =>
			this.inFlight.delete(key),
		);
		this.inFlight.set(key, promise);
		return promise;
	}

	private async runAnalyze(root: string): Promise<DeadCodeResult> {
		const startMs = Date.now();
		const invocation = this.resolved ?? { cmd: "vulture", prefix: [] };
		const args = [
			...invocation.prefix,
			".",
			`--min-confidence=${this.minConfidence}`,
			`--exclude=${VULTURE_EXCLUDES.join(",")}`,
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
		// vulture writes parse/usage errors to stderr and exits 1 with no
		// stdout findings; distinguish that from "found dead code" (exit 1 WITH
		// findings on stdout).
		const output = result.stdout || "";
		if (!output.trim()) {
			const stderr = (result.stderr || "").trim();
			if (result.status !== 0 && stderr) {
				return {
					...emptyResult(this.language),
					summary: `vulture error: ${stderr.split("\n")[0]}`,
					durationMs,
				};
			}
			return {
				...emptyResult(this.language),
				success: true,
				summary: "No dead code found",
				durationMs,
			};
		}
		return { ...this.parseOutput(output, root), durationMs };
	}

	private parseOutput(output: string, root: string): DeadCodeResult {
		const unusedExports = parseVultureOutput(output, root);
		const total = unusedExports.length;
		return {
			...emptyResult(this.language),
			success: true,
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

/**
 * Format cached dead-code results into one turn_end advisory, or "" when there
 * is nothing to report. Merges multiple languages (polyglot repos) under one
 * `[Dead code]` heading so it reads consistently next to the Knip advisory.
 * Advisory-only: these are project-wide signals, never blockers.
 */
export function formatDeadCodeAdvisory(
	results: DeadCodeResult[],
	maxPerLang = 10,
): string {
	const withFindings = results.filter(
		(r) => r.success && deadCodeIssueCount(r) > 0,
	);
	if (withFindings.length === 0) return "";

	const lines: string[] = [];
	for (const r of withFindings) {
		const count = deadCodeIssueCount(r);
		lines.push(`${r.language}: ${count} unused symbol(s)`);
		for (const issue of r.unusedExports.slice(0, maxPerLang)) {
			const loc = issue.file
				? ` (${issue.file}${issue.line ? `:${issue.line}` : ""})`
				: "";
			lines.push(`    - unused ${issue.kind} '${issue.name}'${loc}`);
		}
		if (r.unusedExports.length > maxPerLang) {
			lines.push(`    … and ${r.unusedExports.length - maxPerLang} more`);
		}
	}
	return (
		"💀 [Dead code] project-wide unused symbols — verify before removing:\n  " +
		lines.join("\n  ")
	);
}
