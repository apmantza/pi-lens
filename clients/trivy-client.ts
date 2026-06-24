/**
 * Trivy client for pi-lens — dependency CVE detection (Phase 1 of #131).
 *
 * Surfaces known vulnerabilities (CVE / GHSA) in a project's declared
 * dependencies, across every ecosystem Trivy understands (npm, PyPI, Maven,
 * Gradle, Go modules, Cargo, Composer, RubyGems, NuGet, …) from a single
 * filesystem walk. pi-lens has zero dependency-CVE coverage otherwise.
 *
 * Lifecycle (mirrors the gitleaks / govulncheck session-scan clients):
 *   - session_start scan (via the `runTask(setImmediate)` background wrapper)
 *   - turn_end advisory reads the cached result and surfaces top-N findings;
 *     CRITICAL is treated as a blocker, the rest as advisory
 *   - per-edit scope: skipped — CVE data is daily-ish and the scan is whole-tree;
 *     re-running per keystroke is wasteful. Re-scan is driven by the cache layer
 *     (keyed on lockfile mtimes by the caller).
 *
 * Detection gate (config-first per #131): presence of ANY dependency manifest
 * at the analysis root. Trivy ships sensible defaults (bundled vuln DB), so the
 * gate is about consent + cost, not missing config.
 *
 * When the gate trips, the client auto-installs trivy from GitHub releases
 * (installer entry registered in clients/installer/index.ts) and runs
 * `trivy fs --scanners vuln`. The first run downloads Trivy's vuln DB
 * (~30-200 MB); because the scan runs in the background session_start task it
 * never blocks an edit.
 *
 * Scope note: this slice is dependency CVEs only. IaC misconfig (per-edit),
 * secrets (pending dedup vs gitleaks), and license compliance are follow-ups
 * tracked on #131.
 *
 * Refs: #131
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { loadPiLensProjectConfig } from "./project-lens-config.js";
import { safeSpawnAsync } from "./safe-spawn.js";

// --- Types ---

/** Subset of Trivy's per-vulnerability JSON fields that we surface. */
export interface TrivyFinding {
	vulnerabilityId: string;
	pkgName: string;
	installedVersion?: string;
	fixedVersion?: string;
	severity: TrivySeverity;
	title?: string;
	primaryUrl?: string;
	/** The manifest/lockfile the vulnerable package was found in. */
	target?: string;
}

export interface TrivyResult {
	success: boolean;
	findings: TrivyFinding[];
	scannedAt: string;
	summary?: string;
}

export type TrivySeverity =
	| "CRITICAL"
	| "HIGH"
	| "MEDIUM"
	| "LOW"
	| "UNKNOWN";

const EMPTY_RESULT: Omit<TrivyResult, "scannedAt"> = {
	success: false,
	findings: [],
};

// Generous: the FIRST run downloads the vuln DB (~30-200 MB). This runs in the
// background session_start task, so a slow cold start never blocks an edit.
const SCAN_TIMEOUT_MS = 180_000;

// --- Detection ---

/**
 * Dependency manifests / lockfiles whose presence at the analysis root opts the
 * project in to CVE scanning. Mirrors the ecosystem coverage Trivy's SCA walk
 * understands (#131).
 */
const DEPENDENCY_MANIFESTS = [
	// JS / TS
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	// Python
	"pyproject.toml",
	"requirements.txt",
	"poetry.lock",
	"Pipfile.lock",
	// Java / JVM
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"gradle.lockfile",
	// Go
	"go.mod",
	"go.sum",
	// Rust
	"Cargo.toml",
	"Cargo.lock",
	// .NET
	"packages.lock.json",
	// PHP
	"composer.json",
	"composer.lock",
	// Ruby
	"Gemfile",
	"Gemfile.lock",
] as const;

/**
 * Detect whether the analysis root declares any dependencies Trivy can scan.
 * Root-level check (fast, synchronous) — the same shape as `hasGitleaksSignal`.
 * Nested-only manifests in deep monorepo packages are a known follow-up; the
 * gate intentionally errs toward not auto-pulling a 100 MB DB for a project that
 * shows no dependency surface at its root.
 *
 * Exported for tests and gate-before-construct callers.
 */
export function hasAnyDependencyManifest(cwd: string): boolean {
	for (const manifest of DEPENDENCY_MANIFESTS) {
		try {
			if (fs.existsSync(path.join(cwd, manifest))) return true;
		} catch {
			// non-fatal — keep probing the remaining manifests
		}
	}
	return false;
}

// --- Severity floor ---

const SEVERITY_RANK: Record<string, number> = {
	LOW: 0,
	MEDIUM: 1,
	HIGH: 2,
	CRITICAL: 3,
};

/**
 * Resolve the `--severity` list from the project's `pi-lens.trivy.minSeverity`
 * (default HIGH). The floor can be LOWERED (MEDIUM / LOW = see more) but is
 * clamped so it can never be raised above HIGH — a CRITICAL or HIGH CVE must
 * always surface regardless of config (#131 non-goal: no bypassing criticals).
 */
export function resolveSeverityFloor(cwd: string): TrivySeverity[] {
	let raw: unknown;
	try {
		const config = loadPiLensProjectConfig(cwd);
		raw = (config.raw as { trivy?: { minSeverity?: unknown } } | undefined)
			?.trivy?.minSeverity;
	} catch {
		raw = undefined;
	}
	const requested =
		typeof raw === "string" ? SEVERITY_RANK[raw.toUpperCase()] : undefined;
	// Default HIGH; never stricter than HIGH so HIGH/CRITICAL are never hidden.
	const floor = Math.min(requested ?? SEVERITY_RANK.HIGH, SEVERITY_RANK.HIGH);
	return (["LOW", "MEDIUM", "HIGH", "CRITICAL"] as TrivySeverity[]).filter(
		(s) => SEVERITY_RANK[s] >= floor,
	);
}

// --- Client ---

export class TrivyClient {
	private available: boolean | null = null;
	private ensureInFlight: Promise<boolean> | null = null;
	private inFlight = new Map<string, Promise<TrivyResult>>();
	private binaryPath: string | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[trivy] ${msg}`)
			: () => {};
	}

	/** Static gate so callers can skip before constructing. */
	static hasAnyDependencyManifest(cwd: string): boolean {
		return hasAnyDependencyManifest(cwd);
	}

	/**
	 * Check if trivy is available, auto-installing via the GitHub-release path
	 * (registered in `clients/installer/index.ts`) when missing. Concurrent
	 * first-time callers share the same probe promise.
	 */
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
		const probe = await safeSpawnAsync("trivy", ["--version"], {
			timeout: 5000,
		});
		if (!probe.error && probe.status === 0) {
			this.log(`trivy found: ${probe.stdout.trim().split("\n")[0]}`);
			this.available = true;
			return true;
		}

		this.log("trivy not found, attempting auto-install");
		const { ensureTool } = await import("./installer/index.js");
		const installed = await ensureTool("trivy");
		if (!installed) {
			this.log("trivy auto-install failed");
			this.available = false;
			return false;
		}
		this.binaryPath = installed;
		this.available = true;
		this.log(`trivy auto-installed at ${installed}`);
		return true;
	}

	/**
	 * Scan a directory tree for dependency CVEs.
	 *
	 * Skips early when no dependency manifest is present. When trivy is
	 * unavailable, returns an empty (but successful) result rather than failing
	 * the session_start task. Re-entrancy safe: concurrent calls against the
	 * same root share a single process.
	 */
	async scan(cwd: string): Promise<TrivyResult> {
		const targetDir = path.resolve(cwd);
		const scannedAt = new Date().toISOString();

		if (!hasAnyDependencyManifest(targetDir)) {
			return {
				...EMPTY_RESULT,
				success: true,
				scannedAt,
				summary: "no dependency manifest at analysis root",
			};
		}

		if (!(await this.ensureAvailable())) {
			return { ...EMPTY_RESULT, scannedAt, summary: "trivy not installed" };
		}

		const existing = this.inFlight.get(targetDir);
		if (existing) {
			this.log(`Scan already in flight for ${targetDir}; sharing result`);
			return existing;
		}
		const promise = this.runScan(targetDir).finally(() => {
			this.inFlight.delete(targetDir);
		});
		this.inFlight.set(targetDir, promise);
		return promise;
	}

	private async runScan(cwd: string): Promise<TrivyResult> {
		const scannedAt = new Date().toISOString();
		const bin = this.binaryPath ?? "trivy";
		const severities = resolveSeverityFloor(cwd);
		const outDir = mkdtempSync(path.join(os.tmpdir(), "pi-lens-trivy-"));
		const reportPath = path.join(outDir, "trivy-report.json");
		try {
			const result = await safeSpawnAsync(
				bin,
				[
					"fs",
					"--scanners",
					"vuln",
					"--severity",
					severities.join(","),
					"--format",
					"json",
					"--output",
					reportPath,
					"--quiet",
					"--no-progress",
					cwd,
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
				return {
					...EMPTY_RESULT,
					success: true,
					scannedAt,
					summary:
						(result.stderr ?? "").trim().split("\n")[0] || "no report produced",
				};
			}

			const findings = parseTrivyReport(fs.readFileSync(reportPath, "utf-8"));
			return { success: true, findings, scannedAt };
		} catch (err) {
			return {
				...EMPTY_RESULT,
				scannedAt,
				summary: err instanceof Error ? err.message.slice(0, 200) : String(err),
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

function normalizeSeverity(raw: unknown): TrivySeverity {
	const s = typeof raw === "string" ? raw.toUpperCase() : "";
	if (s === "CRITICAL" || s === "HIGH" || s === "MEDIUM" || s === "LOW") {
		return s;
	}
	return "UNKNOWN";
}

/**
 * Map Trivy's `fs --format json` report to our `TrivyFinding[]`. The report is
 * `{ Results: [{ Target, Vulnerabilities: [{ VulnerabilityID, PkgName, … }] }] }`;
 * `Results` / `Vulnerabilities` are often `null` when nothing is found.
 *
 * Defensive: malformed / truncated input returns `[]` rather than throwing —
 * the session_start task must never crash the session. Exported for unit tests.
 */
export function parseTrivyReport(raw: string): TrivyFinding[] {
	if (!raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const results = (parsed as { Results?: unknown })?.Results;
	if (!Array.isArray(results)) return [];

	const findings: TrivyFinding[] = [];
	for (const resultEntry of results) {
		if (!resultEntry || typeof resultEntry !== "object") continue;
		const r = resultEntry as Record<string, unknown>;
		const target = typeof r.Target === "string" ? r.Target : undefined;
		const vulns = r.Vulnerabilities;
		if (!Array.isArray(vulns)) continue;
		for (const vulnEntry of vulns) {
			if (!vulnEntry || typeof vulnEntry !== "object") continue;
			const v = vulnEntry as Record<string, unknown>;
			const vulnerabilityId =
				typeof v.VulnerabilityID === "string" ? v.VulnerabilityID : undefined;
			const pkgName = typeof v.PkgName === "string" ? v.PkgName : undefined;
			if (!vulnerabilityId || !pkgName) continue;
			findings.push({
				vulnerabilityId,
				pkgName,
				installedVersion:
					typeof v.InstalledVersion === "string"
						? v.InstalledVersion
						: undefined,
				fixedVersion:
					typeof v.FixedVersion === "string" && v.FixedVersion.trim()
						? v.FixedVersion
						: undefined,
				severity: normalizeSeverity(v.Severity),
				title: typeof v.Title === "string" ? v.Title : undefined,
				primaryUrl:
					typeof v.PrimaryURL === "string" ? v.PrimaryURL : undefined,
				target,
			});
		}
	}
	return findings;
}
