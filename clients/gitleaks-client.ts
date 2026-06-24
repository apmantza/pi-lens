/**
 * gitleaks client for pi-lens
 *
 * Surfaces committed secrets (API keys, tokens, passwords, certificates)
 * detected by Aaron Vargas's `gitleaks` scanner. Cross-language by design
 * — gitleaks operates on bytes via regex + entropy, not AST.
 *
 * Lifecycle:
 *   - session_start scan (via the existing `runTask(setImmediate)` wrapper)
 *   - turn_end advisory reads the cached result and surfaces top N findings
 *   - per-edit scope: skipped — secrets either are or aren't in a file;
 *     re-scanning every keystroke is wasteful when the cache is hot
 *
 * Detection gate (config-first per #130 default):
 *   - `.gitleaks.toml` / `.gitleaks.yaml` / `.gitleaksignore` at the
 *     project root, OR
 *   - `gitleaks` reference in `package.json` deps, OR
 *   - a git pre-commit hook (.husky/, .git/hooks/) referencing gitleaks
 *
 * If the gate trips, the runner auto-installs gitleaks from GitHub releases
 * (installer entry registered in clients/installer/index.ts) and runs
 * `gitleaks detect --no-git --report-format json` against the analysis root.
 *
 * Refs: #130
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { safeSpawnAsync } from "./safe-spawn.js";
import { SecurityScanClient } from "./security-scan-client.js";

// --- Types ---

/**
 * Subset of fields gitleaks emits per finding in its JSON report.
 * Schema reference: https://github.com/gitleaks/gitleaks/wiki/Reports
 */
export interface GitleaksFinding {
	ruleId: string;
	description?: string;
	file: string;
	startLine: number;
	endLine?: number;
	match?: string;
	secret?: string;
	tags?: string[];
	commit?: string;
	author?: string;
	date?: string;
}

export interface GitleaksResult {
	success: boolean;
	findings: GitleaksFinding[];
	scannedAt: string;
	summary?: string;
}

const EMPTY_RESULT: Omit<GitleaksResult, "scannedAt"> = {
	success: false,
	findings: [],
};

const SCAN_TIMEOUT_MS = 120_000;

// --- Detection ---

/**
 * Detect whether the project root has opted in to gitleaks via any of the
 * standard signals. Config-first gating per the #130 default — gitleaks
 * runs when the user has given us any indication they want it.
 *
 * Exported for tests and for callers that want the gate without instantiating
 * the client.
 */
export function hasGitleaksSignal(cwd: string): boolean {
	const candidates = [
		".gitleaks.toml",
		".gitleaks.yaml",
		".gitleaks.yml",
		".gitleaksignore",
	];
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(path.join(cwd, candidate))) return true;
		} catch {
			// non-fatal
		}
	}
	// Check package.json devDependencies / dependencies for any `gitleaks*`
	// reference. Catches `gitleaks`, `lint-staged-gitleaks`, etc.
	const pkgJsonPath = path.join(cwd, "package.json");
	try {
		if (fs.existsSync(pkgJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
				dependencies?: Record<string, unknown>;
				devDependencies?: Record<string, unknown>;
			};
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			for (const name of Object.keys(deps)) {
				if (name.toLowerCase().includes("gitleaks")) return true;
			}
		}
	} catch {
		// malformed package.json — don't treat as signal
	}
	// husky / git hooks referencing gitleaks
	const hookCandidates = [
		path.join(cwd, ".husky", "pre-commit"),
		path.join(cwd, ".husky", "_", "pre-commit"),
		path.join(cwd, ".git", "hooks", "pre-commit"),
	];
	for (const hook of hookCandidates) {
		try {
			if (!fs.existsSync(hook)) continue;
			const content = fs.readFileSync(hook, "utf-8");
			if (content.includes("gitleaks")) return true;
		} catch {
			// non-fatal
		}
	}
	return false;
}

// --- Client ---

export class GitleaksClient extends SecurityScanClient<GitleaksResult> {
	constructor(verbose = false) {
		super("gitleaks", verbose);
	}

	/**
	 * Static detection helper so callers can gate before constructing
	 * (matches `GovulncheckClient.hasGoModule` shape).
	 */
	static hasGitleaksSignal(cwd: string): boolean {
		return hasGitleaksSignal(cwd);
	}

	/**
	 * Auto-install via the GitHub-release path (registered in
	 * `clients/installer/index.ts`) when gitleaks isn't already on PATH.
	 * gitleaks uses `version` (no leading dashes) as its CLI verb.
	 */
	protected doEnsureAvailable(): Promise<boolean> {
		return this.ensureViaInstaller(["version"]);
	}

	/**
	 * Scan a directory tree for secrets.
	 *
	 * Skips early when the directory shows no gitleaks opt-in signal. When
	 * gitleaks is unavailable, returns an empty result with an explanatory
	 * summary rather than failing the session_start task.
	 *
	 * Re-entrancy safe: concurrent calls against the same root share a
	 * single gitleaks process (mirrors `KnipClient` / `JscpdClient` /
	 * `GovulncheckClient`).
	 */
	async scan(cwd: string): Promise<GitleaksResult> {
		const targetDir = path.resolve(cwd);
		const scannedAt = new Date().toISOString();

		if (!GitleaksClient.hasGitleaksSignal(targetDir)) {
			return {
				...EMPTY_RESULT,
				success: true,
				scannedAt,
				summary: "no gitleaks opt-in signal at project root",
			};
		}

		if (!(await this.ensureAvailable())) {
			return {
				...EMPTY_RESULT,
				scannedAt,
				summary: "gitleaks not installed",
			};
		}

		return this.dedupeScan(targetDir, () => this.runScan(targetDir));
	}

	private async runScan(cwd: string): Promise<GitleaksResult> {
		const scannedAt = new Date().toISOString();
		const bin = this.binaryPath ?? "gitleaks";
		const outDir = mkdtempSync(path.join(os.tmpdir(), "pi-lens-gitleaks-"));
		const reportPath = path.join(outDir, "gitleaks-report.json");
		try {
			const result = await safeSpawnAsync(
				bin,
				[
					"detect",
					"--no-git",
					"--source",
					cwd,
					"--report-format",
					"json",
					"--report-path",
					reportPath,
					"--exit-code",
					"0",
					"--no-banner",
				],
				{ cwd, timeout: SCAN_TIMEOUT_MS },
			);

			if (result.error) {
				this.log(`Scan error: ${result.error.message}`);
				return {
					...EMPTY_RESULT,
					scannedAt,
					summary: result.error.message.slice(0, 200),
				};
			}

			if (!fs.existsSync(reportPath)) {
				// gitleaks writes the report file even when nothing is found.
				// If the file is missing the scan likely errored before
				// writing it — surface a summary line from stderr.
				return {
					...EMPTY_RESULT,
					success: true,
					scannedAt,
					summary:
						(result.stderr ?? "").trim().split("\n")[0] || "no report produced",
				};
			}

			const findings = parseGitleaksReport(
				fs.readFileSync(reportPath, "utf-8"),
			);
			return {
				success: true,
				findings,
				scannedAt,
			};
		} catch (err) {
			return {
				...EMPTY_RESULT,
				scannedAt,
				summary:
					err instanceof Error ? err.message.slice(0, 200) : String(err),
			};
		} finally {
			try {
				fs.rmSync(outDir, { recursive: true, force: true });
			} catch {
				// non-fatal
			}
		}
	}
}

// --- Parser ---

/**
 * Map gitleaks's JSON report (a flat array of finding objects) to our
 * structured `GitleaksFinding[]` shape. Exported for unit tests.
 *
 * Gitleaks emits `null` (or `[]`) when no findings are present. Malformed
 * input returns `[]` rather than throwing — gitleaks itself is occasionally
 * truncated by upstream pipe failures.
 */
export function parseGitleaksReport(raw: string): GitleaksFinding[] {
	if (!raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const findings: GitleaksFinding[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const ruleId = typeof e.RuleID === "string" ? e.RuleID : undefined;
		const file = typeof e.File === "string" ? e.File : undefined;
		const startLine =
			typeof e.StartLine === "number"
				? e.StartLine
				: Number.parseInt(String(e.StartLine ?? ""), 10);
		if (!ruleId || !file || !Number.isFinite(startLine)) continue;
		findings.push({
			ruleId,
			description:
				typeof e.Description === "string" ? e.Description : undefined,
			file,
			startLine,
			endLine:
				typeof e.EndLine === "number"
					? e.EndLine
					: Number.isFinite(Number(e.EndLine))
						? Number(e.EndLine)
						: undefined,
			match: typeof e.Match === "string" ? e.Match : undefined,
			secret: typeof e.Secret === "string" ? e.Secret : undefined,
			tags: Array.isArray(e.Tags)
				? e.Tags.filter((t): t is string => typeof t === "string")
				: undefined,
			commit: typeof e.Commit === "string" ? e.Commit : undefined,
			author: typeof e.Author === "string" ? e.Author : undefined,
			date: typeof e.Date === "string" ? e.Date : undefined,
		});
	}
	return findings;
}
