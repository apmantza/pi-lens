/**
 * govulncheck client for pi-lens
 *
 * Surfaces Go module CVEs that are actually reachable from the build graph.
 * Complements trivy-style \"all CVEs in any dep\" scanning by filtering to
 * vulnerabilities whose vulnerable function is called from the analyzed code.
 *
 * Lifecycle:
 *   - session_start scan + cache (keyed by go.sum mtime via cacheManager)
 *   - turn_end delta vs cached findings (mirrors KnipClient)
 *   - skipped silently if `govulncheck` is not on PATH (no auto-install in this
 *     slice — see issue #132 for the deferred `go-install` installer strategy)
 *
 * Invocation: `govulncheck -mode=source -format=json ./...` from the module root.
 *
 * Docs: https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck
 * Refs: #132
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeSpawnAsync } from "./safe-spawn.js";
import { SecurityScanClient } from "./security-scan-client.js";

// --- Types ---

export interface GovulncheckTraceFrame {
	module?: string;
	packageName?: string;
	functionName?: string;
	filename?: string;
	line?: number;
}

export interface GovulncheckFinding {
	osv: string;
	module?: string;
	packageName?: string;
	fixedVersion?: string;
	severity?: string;
	summary?: string;
	url?: string;
	trace: GovulncheckTraceFrame[];
}

export interface GovulncheckResult {
	success: boolean;
	findings: GovulncheckFinding[];
	scannedAt: string;
	summary?: string;
}

const EMPTY_RESULT: Omit<GovulncheckResult, "scannedAt"> = {
	success: false,
	findings: [],
};

const SCAN_TIMEOUT_MS = 120_000;

// --- Internal: raw record shapes from govulncheck's JSON stream ---

interface RawTraceEntry {
	module?: string;
	package?: string;
	function?: string;
	position?: { filename?: string; line?: number };
}

interface RawFindingRecord {
	finding?: {
		osv?: string;
		fixed_version?: string;
		trace?: RawTraceEntry[];
	};
}

interface RawOsvRecord {
	osv?: {
		id?: string;
		summary?: string;
		details?: string;
		database_specific?: { url?: string };
		affected?: Array<{
			package?: { name?: string };
			database_specific?: { url?: string };
			ranges?: Array<{
				events?: Array<{ fixed?: string }>;
			}>;
		}>;
	};
}

// --- Client ---

export class GovulncheckClient extends SecurityScanClient<GovulncheckResult> {
	constructor(verbose = false) {
		super("govulncheck", verbose);
	}

	/**
	 * Detect whether the project root is a Go module. Cheap filesystem check.
	 */
	static hasGoModule(cwd: string): boolean {
		try {
			return fs.existsSync(path.join(cwd, "go.mod"));
		} catch {
			return false;
		}
	}

	/**
	 * Resolve `govulncheck`: PATH probe, then auto-install via `go install`
	 * (not the GitHub-release installer the other security clients use — the
	 * toolchain is present by definition when there's a go.mod).
	 */
	protected async doEnsureAvailable(): Promise<boolean> {
		// PATH probe first.
		if (await this.probeVersion(["-version"])) {
			this.available = true;
			return true;
		}

		// Not on PATH — auto-install via `go install`. This is safe to assume
		// here because the only path reaching `ensureAvailable()` is the
		// session_start task gated on `hasGoModule(analysisRoot)`; if the
		// project has a go.mod the user has the Go toolchain by definition.
		// Same shape as rust-clippy / cargo: lean on the language's own
		// install mechanism rather than adding a new installer strategy.
		const goOnPath = await safeSpawnAsync("go", ["version"], {
			timeout: 5000,
		});
		if (goOnPath.error || goOnPath.status !== 0) {
			this.log("go binary not on PATH — cannot auto-install govulncheck");
			this.available = false;
			return false;
		}

		this.log("govulncheck not found, attempting auto-install via go install");
		const install = await safeSpawnAsync(
			"go",
			["install", "golang.org/x/vuln/cmd/govulncheck@latest"],
			{ timeout: 60_000 },
		);
		if (install.error || install.status !== 0) {
			this.log(
				`govulncheck auto-install failed: ${(install.stderr ?? "").slice(0, 200)}`,
			);
			this.available = false;
			return false;
		}

		// `go install` writes to `$GOBIN` or `$GOPATH/bin`. The user may not
		// have that on `$PATH`. Re-probe by name (works when it is on PATH)
		// then fall back to the canonical bin dirs.
		const reprobe = await safeSpawnAsync("govulncheck", ["-version"], {
			timeout: 5000,
		});
		if (!reprobe.error && reprobe.status === 0) {
			this.log("govulncheck auto-installed and found on PATH");
			this.available = true;
			return true;
		}

		// Look in the canonical install locations and remember the absolute
		// path so subsequent invocations spawn against it directly.
		const homeDir = os.homedir();
		const isWin = process.platform === "win32";
		const ext = isWin ? ".exe" : "";
		const candidates = [
			process.env.GOBIN,
			process.env.GOPATH ? path.join(process.env.GOPATH, "bin") : undefined,
			path.join(homeDir, "go", "bin"),
		]
			.filter((d): d is string => Boolean(d))
			.map((d) => path.join(d, `govulncheck${ext}`));
		for (const candidate of candidates) {
			try {
				if (fs.existsSync(candidate)) {
					this.binaryPath = candidate;
					this.available = true;
					this.log(`govulncheck auto-installed at ${candidate}`);
					return true;
				}
			} catch {
				// fall through to next candidate
			}
		}

		this.log(
			"govulncheck auto-install succeeded but binary not locatable — check $GOBIN / $GOPATH",
		);
		this.available = false;
		return false;
	}

	/**
	 * Scan a Go module for reachable CVEs.
	 *
	 * Re-entrancy safe: concurrent calls against the same root share a single
	 * govulncheck process. Mirrors the in-flight dedupe pattern used by
	 * KnipClient / JscpdClient.
	 */
	async analyze(cwd: string): Promise<GovulncheckResult> {
		const targetDir = path.resolve(cwd);

		if (!GovulncheckClient.hasGoModule(targetDir)) {
			return {
				...EMPTY_RESULT,
				success: true,
				scannedAt: new Date().toISOString(),
				summary: "No go.mod found at analysis root; govulncheck skipped",
			};
		}

		if (!(await this.ensureAvailable())) {
			return {
				...EMPTY_RESULT,
				scannedAt: new Date().toISOString(),
				summary: "govulncheck not installed",
			};
		}

		return this.dedupeScan(targetDir, () => this.runScan(targetDir));
	}

	private async runScan(cwd: string): Promise<GovulncheckResult> {
		const scannedAt = new Date().toISOString();
		const bin = this.binaryPath ?? "govulncheck";
		try {
			const result = await safeSpawnAsync(
				bin,
				["-mode=source", "-format=json", "./..."],
				{ cwd, timeout: SCAN_TIMEOUT_MS },
			);

			// govulncheck exits non-zero (status 3) when vulnerabilities are
			// found — that's success from our perspective. Genuine failures
			// produce empty stdout + a stderr message.
			const rawStdout = result.stdout ?? "";
			if (!rawStdout.trim() && result.status !== 0 && result.status !== 3) {
				this.log(`Scan failed: ${(result.stderr ?? "").slice(0, 200)}`);
				return {
					...EMPTY_RESULT,
					scannedAt,
					summary: (result.stderr ?? "").trim().split("\n")[0] || "scan failed",
				};
			}

			const findings = parseGovulncheckJson(rawStdout);
			return {
				success: true,
				findings,
				scannedAt,
			};
		} catch (err) {
			this.log(`Scan error: ${err instanceof Error ? err.message : err}`);
			return {
				...EMPTY_RESULT,
				scannedAt,
				summary:
					err instanceof Error ? err.message.slice(0, 200) : String(err),
			};
		}
	}
}

// --- Parser ---

/**
 * Parse govulncheck's `-format=json` stream into a clean finding list.
 *
 * The stream is a series of newline-or-brace-separated JSON objects of
 * mixed type:
 *   - `{"config": {...}}`     — DB / Go version
 *   - `{"progress": {...}}`   — scan progress
 *   - `{"osv": {...}}`        — vulnerability metadata (we extract module +
 *                                fixed version + summary + URL here)
 *   - `{"finding": {...}}`    — actual reachable finding (we extract the
 *                                osv id + trace)
 *
 * We extract OSV metadata first and then enrich each Finding with the
 * matching osv's `summary` / `fixed_version` / `url`. A single Finding
 * record from govulncheck has only the OSV id + trace, so this two-pass
 * approach is required to produce the structured shape the runner / UI
 * consumes.
 *
 * Exported for unit tests.
 */
export function parseGovulncheckJson(stream: string): GovulncheckFinding[] {
	if (!stream.trim()) return [];

	const records = splitJsonStream(stream);
	const osvMeta = new Map<
		string,
		{
			module?: string;
			fixedVersion?: string;
			summary?: string;
			url?: string;
		}
	>();
	const findings: GovulncheckFinding[] = [];

	for (const record of records) {
		const asOsv = record as RawOsvRecord;
		if (asOsv.osv && typeof asOsv.osv.id === "string") {
			const affected = asOsv.osv.affected?.[0];
			const packageName = affected?.package?.name;
			const fixedVersion = affected?.ranges
				?.flatMap((r) => r.events ?? [])
				.find((e) => typeof e.fixed === "string")?.fixed;
			osvMeta.set(asOsv.osv.id, {
				module: packageName,
				fixedVersion,
				summary: asOsv.osv.summary ?? asOsv.osv.details,
				url: asOsv.osv.database_specific?.url ?? affected?.database_specific?.url,
			});
		}
	}

	for (const record of records) {
		const asFinding = record as RawFindingRecord;
		const f = asFinding.finding;
		if (!f || typeof f.osv !== "string") continue;
		const trace: GovulncheckTraceFrame[] = (f.trace ?? []).map((t) => ({
			module: t.module,
			packageName: t.package,
			functionName: t.function,
			filename: t.position?.filename,
			line: t.position?.line,
		}));
		const meta = osvMeta.get(f.osv);
		findings.push({
			osv: f.osv,
			module: meta?.module,
			packageName: trace.find((t) => t.packageName)?.packageName,
			fixedVersion: f.fixed_version ?? meta?.fixedVersion,
			summary: meta?.summary,
			url: meta?.url,
			trace,
		});
	}

	// Dedupe: govulncheck may emit multiple finding records per OSV when the
	// vulnerable function is called from several call sites. Collapse to one
	// finding per OSV ID, preserving the *first* trace (deepest call-site
	// attribution is what the agent needs).
	const seen = new Set<string>();
	const deduped: GovulncheckFinding[] = [];
	for (const f of findings) {
		if (seen.has(f.osv)) continue;
		seen.add(f.osv);
		deduped.push(f);
	}
	return deduped;
}

/**
 * Parse govulncheck's JSON-stream output into structured records.
 *
 * govulncheck's `-format=json` emits one top-level JSON object per logical
 * record, but the framing is informal: most records arrive on their own
 * line, some are concatenated on one line, and corrupt / truncated lines
 * can appear when the scan is interrupted.
 *
 * Strategy:
 *  1. Try a fast line-by-line `JSON.parse` first — handles the dominant
 *     newline-delimited case and rejects malformed lines without letting
 *     them poison downstream records.
 *  2. If any line fails to parse cleanly, fall back to a brace-depth
 *     scanner over that line — handles records that have been
 *     concatenated together without newlines.
 *  3. Malformed slices are dropped rather than failing the whole scan.
 */
function splitJsonStream(stream: string): unknown[] {
	const records: unknown[] = [];
	for (const rawLine of stream.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			records.push(JSON.parse(line));
			continue;
		} catch {
			// Fall through to the multi-object brace scanner.
		}
		for (const obj of extractBalancedObjects(line)) {
			records.push(obj);
		}
	}
	return records;
}

function extractBalancedObjects(input: string): unknown[] {
	const found: unknown[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escape = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (escape) {
			escape = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") escape = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start !== -1) {
				const slice = input.slice(start, i + 1);
				try {
					found.push(JSON.parse(slice));
				} catch {
					// Drop the malformed slice; keep scanning for the next
					// balanced object so a corrupt prefix doesn't poison the
					// remainder of the line.
				}
				start = -1;
			} else if (depth < 0) {
				// Stray `}` — reset and resume.
				depth = 0;
				start = -1;
			}
		}
	}

	return found;
}
