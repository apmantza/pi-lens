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

import type { AnalysedRootSignal } from "./analysed-root.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeSpawnAsync } from "./safe-spawn.js";
import { probeToolAsync } from "./tool-probe.js";
import {
	firstOutputLine,
	spawnFailedWithNoOutput,
} from "./dispatch/runners/utils/spawn-outcome.js";
import { assertInstallAllowed } from "./project-trust.js";
import { SecurityScanClient } from "./security-scan-client.js";
import {
	classifyProbeFailure,
	describeProbeEvidence,
	INSTALL_TRANSIENT_MAX_ATTEMPTS,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";
import { recordDegradationOnce } from "./degradation-ledger.js";

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

export interface GovulncheckResult extends AnalysedRootSignal {
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
/** Budget for the `go install` auto-install, ms. */
const INSTALL_TIMEOUT_MS = 60_000;

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
		if (this.probeWasTransient()) {
			// #1467: a timed-out/killed probe says nothing about whether
			// govulncheck is on PATH. Latching `false` here disabled it for the
			// life of the process; a `go install` here would be a heavyweight
			// reaction to a host hiccup. probeVersion has already recorded the
			// expiring verdict and its retry schedule (#1501) — re-marking it
			// here would double-escalate the cooldown. Retry later.
			this.log("govulncheck probe timed out; retrying later (not installing)");
			return false;
		}
		if (!assertInstallAllowed("govulncheck go install")) {
			// Deliberately NOT latching `available = false` (#1350 delta review):
			// trust denial is policy, not tool absence -- a later trust grant
			// (re-adopted at turn_start) must be able to retry the install, and
			// the cached false in ensureAvailable() would make denial permanent.
			return false;
		}

		// Not on PATH — auto-install via `go install`. This is safe to assume
		// here because the only path reaching `ensureAvailable()` is the
		// session_start task gated on `hasGoModule(analysisRoot)`; if the
		// project has a go.mod the user has the Go toolchain by definition.
		// Same shape as rust-clippy / cargo: lean on the language's own
		// install mechanism rather than adding a new installer strategy.
		const goProbeStartedAt = Date.now();
		const goSampler = startHostStallSampler();
		let goOnPath: Awaited<ReturnType<typeof safeSpawnAsync>>;
		let goHostStallMs: number;
		try {
			goOnPath = await probeToolAsync("go", ["version"], {
				timeout: 5000,
			});
		} finally {
			goHostStallMs = goSampler.stop();
		}
		if (goOnPath.error || goOnPath.status !== 0) {
			const { outcome, cause } = classifyProbeFailure(goOnPath, {
				hostStallMs: goHostStallMs,
			});
			if (outcome === "transient") {
				this.log("`go version` probe timed out; retrying govulncheck later");
				const retryAfterMs = this.markTransientlyUnavailable(cause);
				logAvailabilityDecision({
					tool: "govulncheck",
					verdict: "unavailable",
					outcome,
					cause,
					elapsedMs: Date.now() - goProbeStartedAt,
					latched: false,
					hostStallMs: goHostStallMs,
					...(retryAfterMs > 0 && { retryAfterMs }),
					budgetMs: 5000,
					classifiedBy: "probe",
				});
				return false;
			}
			this.log("go binary not on PATH — cannot auto-install govulncheck");
			// Derived from the `go version` probe above, and recorded with it: a
			// reader can see WHY govulncheck went quiet without re-running it (#1500).
			// The evidence names `go`, because that is what was spawned — a row that
			// carried go's errno unlabelled under `tool: "govulncheck"` invited the
			// exact misreading the field exists to prevent.
			this.noteDurableAbsence({
				...describeProbeEvidence(goOnPath, "go"),
				install: "not-attempted",
			});
			return false;
		}

		this.log("govulncheck not found, attempting auto-install via go install");
		const installStartedAt = Date.now();
		const installSampler = startHostStallSampler();
		let install: Awaited<ReturnType<typeof safeSpawnAsync>>;
		let installHostStallMs: number;
		try {
			install = await safeSpawnAsync(
				"go",
				["install", "golang.org/x/vuln/cmd/govulncheck@latest"],
				{ timeout: INSTALL_TIMEOUT_MS },
			);
		} finally {
			installHostStallMs = installSampler.stop();
		}
		if (install.error || install.status !== 0) {
			this.log(
				`govulncheck auto-install failed: ${(install.stderr ?? "").slice(0, 200)}`,
			);
			// #1476: `go install` runs against a 60 s budget over the network. A
			// timed-out or killed install says nothing about whether govulncheck
			// can ever be installed here, so it must not latch the durable
			// "tool is not installed" verdict the way a real install refusal does.
			// A non-zero exit (module not found, compile error) still latches:
			// that IS evidence about this machine, and retrying it every turn
			// would be a `go install` storm.
			const { outcome, cause } = classifyProbeFailure(install, {
				hostStallMs: installHostStallMs,
			});
			if (outcome === "transient") {
				// #1497: the retried operation here is a ≤60s network compile,
				// not a cheap probe, so it escalates on the install-class
				// schedule and latches at the attempt ceiling instead of
				// re-compiling every few minutes forever.
				const retryAfterMs = this.markTransientlyUnavailable(cause, {
					operationClass: "install",
				});
				const exhausted = retryAfterMs === 0;
				const ceilingReason = `go install timed out ${INSTALL_TRANSIENT_MAX_ATTEMPTS} times; install retries disabled until the next session`;
				if (exhausted) {
					// The symptom a user notices is an unexplained busy core, not a
					// missing tool — so the terminal verdict gets the louder record.
					// Once per session, matching the latch's own lifetime: both re-arm
					// at `session_start` (review F3).
					recordDegradationOnce({
						kind: "install-retry-exhausted",
						subject: "govulncheck",
						reason: ceilingReason,
					});
				}
				// One record per decision, so an install that keeps timing out is
				// readable in latency.log the same day (#1467's forensic trail).
				logAvailabilityDecision({
					tool: "govulncheck",
					verdict: "unavailable",
					outcome,
					// At the ceiling the latch rewrote the cause; a row still saying
					// `probe-timeout` would read as "cooling down" (#1497 review F5).
					cause: exhausted ? (this.latchedCause() ?? cause) : cause,
					elapsedMs: Date.now() - installStartedAt,
					latched: exhausted,
					hostStallMs: installHostStallMs,
					...(retryAfterMs > 0 && { retryAfterMs }),
					budgetMs: INSTALL_TIMEOUT_MS,
					// The ceiling verdict is an ASSERTION by this call site, not a
					// classification of one spawn, and #1534's convention is that such a
					// row says so and carries the install facts behind it. Every retry
					// DID run a `go install` that failed, so `install: "failed"` is
					// earned, and the reason names the ceiling rather than the spawn.
					// Below the ceiling, outcome/cause are fresh off `classifyProbeFailure`
					// above, so that row is still `"probe"` (#2209).
					classifiedBy: exhausted ? "caller" : "probe",
					...(exhausted && {
						evidence: {
							...describeProbeEvidence(install, "go install"),
							install: "failed" as const,
							installReason: ceilingReason,
						},
					}),
				});
				return false;
			}
			// A non-transient install failure (module not found, compile error) IS
			// evidence about this machine, so it latches — but the row says the
			// install was tried and failed, which a plain absence never does (#1500).
			this.noteDurableAbsence(
				{
					...describeProbeEvidence(install, "go install"),
					install: "failed",
				},
				{ elapsedMs: Date.now() - installStartedAt },
			);
			return false;
		}

		// `go install` writes to `$GOBIN` or `$GOPATH/bin`. The user may not
		// have that on `$PATH`. Re-probe by name (works when it is on PATH)
		// then fall back to the canonical bin dirs.
		const reprobeStartedAt = Date.now();
		const reprobeSampler = startHostStallSampler();
		let reprobe: Awaited<ReturnType<typeof safeSpawnAsync>>;
		let reprobeHostStallMs: number;
		try {
			reprobe = await probeToolAsync("govulncheck", ["-version"], {
				timeout: 5000,
			});
		} finally {
			reprobeHostStallMs = reprobeSampler.stop();
		}
		if (!reprobe.error && reprobe.status === 0) {
			this.log("govulncheck auto-installed and found on PATH");
			this.available = true;
			// The initial PATH probe already wrote a latched `unavailable` row
			// (#1500's own assertion doesn't fire here — the reprobe SUCCEEDED —
			// but that first probe's verdict still logged, before `go install`
			// ever ran). Without a compensating row here, the durable record says
			// govulncheck is off when `go install` just put it on PATH (#1606).
			logAvailabilityDecision({
				tool: "govulncheck",
				verdict: "available",
				outcome: "success",
				cause: "ok",
				elapsedMs: Date.now() - reprobeStartedAt,
				latched: true,
				hostStallMs: reprobeHostStallMs,
				budgetMs: 5000,
				classifiedBy: "caller",
				evidence: {
					install: "succeeded",
					binary: "govulncheck",
					source: "go-install",
				},
			});
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
					// Same compensating row as the on-PATH reprobe arm above (#1606):
					// the initial probe already latched `unavailable`, and this arm
					// is the OTHER way to recover — the canonical $GOBIN/$GOPATH walk
					// found it after the on-PATH reprobe missed.
					logAvailabilityDecision({
						tool: "govulncheck",
						verdict: "available",
						outcome: "success",
						cause: "ok",
						elapsedMs: Date.now() - installStartedAt,
						latched: true,
						classifiedBy: "caller",
						evidence: {
							install: "succeeded",
							binary: path.basename(candidate),
							source: "go-install",
						},
					});
					return true;
				}
			} catch {
				// fall through to next candidate
			}
		}

		// The install SUCCEEDED, so the tool is on this machine somewhere. If the
		// re-probe merely timed out, latching "not installed" would be the #1467
		// mistake one step later in the same function (#1476).
		const { outcome, cause } = classifyProbeFailure(reprobe, {
			hostStallMs: reprobeHostStallMs,
		});
		if (outcome === "transient") {
			this.log(
				"govulncheck installed but the re-probe timed out; retrying later",
			);
			const retryAfterMs = this.markTransientlyUnavailable(cause);
			logAvailabilityDecision({
				tool: "govulncheck",
				verdict: "unavailable",
				outcome,
				cause,
				// The re-probe's own wall time. A hard-coded 0 here was the #1474
				// defect verbatim: a duration field that measures nothing.
				elapsedMs: Date.now() - reprobeStartedAt,
				latched: false,
				hostStallMs: reprobeHostStallMs,
				...(retryAfterMs > 0 && { retryAfterMs }),
				budgetMs: 5000,
				classifiedBy: "probe",
			});
			return false;
		}
		// The third silent arm (#1500 review): the install SUCCEEDED and the binary
		// is nowhere the re-probe or the canonical bin dirs could find it. That is a
		// durable, actionable fact — and until now it latched with no record at all,
		// so a $GOBIN misconfiguration was indistinguishable from govulncheck simply
		// not being installed. `install: "succeeded"` also appears on the two success
		// arms above (#1606's compensating `available` rows) — this is the durable
		// FAILURE counterpart, an install that worked but left nothing locatable.
		this.log(
			"govulncheck auto-install succeeded but binary not locatable — check $GOBIN / $GOPATH",
		);
		this.noteDurableAbsence(
			{
				...describeProbeEvidence(reprobe, "govulncheck"),
				install: "succeeded",
				installReason:
					"installed binary not found on PATH, $GOBIN or $GOPATH/bin",
			},
			{ elapsedMs: Date.now() - reprobeStartedAt },
		);
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

			// #2154 v4 F1: this was the one runner client with no `result.error`
			// check before its parse site. `safeSpawnAsync` reports a timeout or
			// an ambient abort as `{status: null, error, stdout: <partial>}`, and
			// the old guard (`!stdout.trim() && status !== 0 && status !== 3`)
			// let that partial stream through as an authoritative scan. Same
			// order as the seven sibling clients: the process first, its output
			// second.
			if (result.error) {
				this.log(`Scan error: ${result.error.message}`);
				return {
					...EMPTY_RESULT,
					scannedAt,
					summary: result.error.message.slice(0, 200),
				};
			}

			// govulncheck exits non-zero (status 3) when vulnerabilities are
			// found — that's success from our perspective. Any other exit code
			// means the scan was not analysed, even if its config preamble or
			// partial stream reached stdout before the failure.
			const rawStdout = result.stdout ?? "";
			if (result.status !== 0 && result.status !== 3) {
				return {
					...EMPTY_RESULT,
					scannedAt,
					summary: firstOutputLine(result.stderr) || "scan failed",
				};
			}
			if (!rawStdout.trim()) {
				// Nothing to parse. `govulncheck -format=json` always writes a
				// stream (a `config` record at minimum), so an empty one is never
				// evidence of "no vulnerabilities" — it must not retire a retained
				// CVE finding, whatever the exit code. `spawnFailedWithNoOutput`
				// is the same shared discriminator knip and dead-code use, in
				// place of this file's hand-rolled status test.
				if (spawnFailedWithNoOutput(result, rawStdout)) {
					this.log(`Scan failed: ${(result.stderr ?? "").slice(0, 200)}`);
					return {
						...EMPTY_RESULT,
						scannedAt,
						summary: firstOutputLine(result.stderr) || "scan failed",
					};
				}
				return {
					...EMPTY_RESULT,
					success: true,
					scannedAt,
					summary: "govulncheck produced no output; nothing parsed",
				};
			}

			const findings = parseGovulncheckJson(rawStdout);
			// #2154: the one govulncheck site that parsed a scan of this root.
			return {
				success: true,
				analyzed: true,
				findings,
				scannedAt,
			};
		} catch (err) {
			this.log(`Scan error: ${err instanceof Error ? err.message : err}`);
			return {
				...EMPTY_RESULT,
				scannedAt,
				summary: err instanceof Error ? err.message.slice(0, 200) : String(err),
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
				url:
					asOsv.osv.database_specific?.url ?? affected?.database_specific?.url,
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
