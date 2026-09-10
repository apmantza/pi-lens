/**
 * Biome Client for pi-lens
 *
 * All-in-one: formatting + linting for JS/TS/JSX/TSX/CSS/JSON
 * Replaces Prettier with 15-50x faster Rust-based tool.
 *
 * Requires: npm install @biomejs/biome (or npx @biomejs/biome)
 * Docs: https://biomejs.dev/
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { isFileKind } from "./file-kinds.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { findGlobalBinary } from "./package-manager.js";
import { probeToolAsync, safeSpawnAsync } from "./safe-spawn.js";
import { createSingleFlight } from "./single-flight.js";
import { biomeConfigArgs } from "./tool-policy.js";
import {
	type ClientAvailabilityResult,
	resolveManagedToolClient,
} from "./dispatch/runners/utils/runner-helpers.js";
import {
	type AvailabilityCause,
	type AvailabilityOutcome,
	type ProbeEvidence,
	classifyProbeFailure,
	describeInstallAttempt,
	createAvailabilityLatch,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";

// --- Types ---

export interface BiomeDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	rule?: string;
	category: "lint" | "format";
	fixable: boolean;
}

// --- Client ---

const PROBE_TIMEOUT_MS = 10_000;

export class BiomeClient {
	/**
	 * Availability memo, backed by the shared transient-aware latch (#1476).
	 *
	 * Biome is the hot-path formatter: before this, ANY probe failure — a
	 * timeout included — collapsed to `{ outcome: "missing" }`, which both
	 * triggered an install and latched `false` for the life of the process. One
	 * slow first format then disabled formatting until restart.
	 */
	private readonly availabilityLatch = createAvailabilityLatch();
	/** Cause of the last probe, read when the resolution comes back. */
	private lastProbeCause: AvailabilityCause | null = null;
	/**
	 * Measurements of the last failed probe, held until the latch decides how
	 * long the verdict lasts. The decision record is emitted after that, so it
	 * can carry `retryAfterMs` — a latch you can see is worth little if the
	 * retry schedule is not greppable beside it (#1474).
	 */
	private lastProbeElapsedMs = 0;
	private lastProbeHostStallMs = 0;
	/** Raw facts from the last probe, carried into the decision record (#1500). */
	private lastProbeEvidence: ProbeEvidence | undefined;
	// Per-cwd cache of the resolved biome binary. Keying by cwd matters in
	// monorepos where different sub-packages each ship their own biome
	// installation; sharing one slot across the whole client would cause
	// the first resolution to win and stale across other packages.
	private localBinaryByCwd = new Map<string, string>();
	// The binary path written by `ensureTool("biome")` — genuinely global
	// (lives under ~/.pi-lens/tools), so it's stored separately from the
	// per-cwd cache and used as a final fallback before npx.
	private autoInstalledBinaryPath: string | null = null;
	/**
	 * At-most-one probe/auto-install in flight, via the shared primitive
	 * (#1753). One instance owns one question, so the key is a constant.
	 */
	private readonly ensureFlight = createSingleFlight<boolean>();
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose ? createSubsystemLogger("biome") : () => {};
	}

	/**
	 * Resolve the fastest available biome binary for `cwd`.
	 * Prefers local node_modules/.bin/biome (skip npx overhead ~1s).
	 * Falls back to ~/.pi-lens/tools, then npx.
	 *
	 * In monorepos, callers should pass the project / sub-package root for the
	 * edited file (typically `path.dirname(absolutePath)`). Omitting `cwd`
	 * falls back to `process.cwd()`, which is wrong when pi is invoked from
	 * a different directory than the file being edited.
	 */
	private async getBiomeBinary(
		cwd?: string,
	): Promise<{ cmd: string; args: string[] }> {
		const resolveCwd = cwd ?? process.cwd();
		const cached = this.localBinaryByCwd.get(resolveCwd);
		if (cached) return { cmd: cached, args: [] };

		// Check `<cwd>/node_modules/.bin/biome` BEFORE trusting
		// `autoInstalledBinaryPath` (#1731). NOT a walk, despite what this
		// comment claimed until #2544 review F1 — the candidates below are
		// joined onto `resolveCwd` and nothing climbs. Callers pass the edited
		// file's own project/sub-package root (see above), which is where an
		// npm-workspace install puts the shim; converting this to the shared
		// ancestor walk is a behaviour change with no reported defect behind
		// it, so it is deliberately NOT part of #2514's ceiling fold. That
		// field is set once, the first
		// time `ensureAvailable()` auto-installs for ANY cwd this session, and
		// every later call for every OTHER cwd short-circuited on it — so a
		// project that ships its own biome never won once the session's first
		// managed install had already happened. Project-local-first (discipline
		// B, #1721) means the project's pinned version and config resolution
		// always outrank a managed copy, autoinstalled or not.
		// On Windows prefer .cmd (native batch) over the sh wrapper — 2x faster.
		const isWin = process.platform === "win32";
		const piLensBin = path.join(
			getGlobalPiLensDir(),
			"tools",
			"node_modules",
			".bin",
		);
		const candidates = isWin
			? [
					path.join(resolveCwd, "node_modules", ".bin", "biome.cmd"),
					path.join(resolveCwd, "node_modules", ".bin", "biome"),
				]
			: [path.join(resolveCwd, "node_modules", ".bin", "biome")];
		for (const p of candidates) {
			if (fs.existsSync(p)) {
				this.localBinaryByCwd.set(resolveCwd, p);
				return { cmd: p, args: [] };
			}
		}
		if (this.autoInstalledBinaryPath) {
			return { cmd: this.autoInstalledBinaryPath, args: [] };
		}
		// Also check ~/.pi-lens/tools (where ensureTool("biome") auto-installs),
		// so we avoid the ~1.5s `npx @biomejs/biome --version` fallback when the
		// tool is already installed but not in the project's node_modules.
		const managedCandidates = isWin
			? [path.join(piLensBin, "biome.cmd"), path.join(piLensBin, "biome")]
			: [path.join(piLensBin, "biome")];
		for (const p of managedCandidates) {
			if (fs.existsSync(p)) {
				this.localBinaryByCwd.set(resolveCwd, p);
				return { cmd: p, args: [] };
			}
		}
		// Any package manager's global bin dir (npm/pnpm/yarn/bun) before npx —
		// catches `pnpm add -g @biomejs/biome` installs that PATH misses (#375).
		const global = await findGlobalBinary("biome");
		if (global) {
			this.localBinaryByCwd.set(resolveCwd, global);
			return { cmd: global, args: [] };
		}
		// Fallback: npx (slower but works anywhere)
		return { cmd: "npx", args: ["@biomejs/biome"] };
	}

	private async spawnBiomeAsync(args: string[], timeout = 15000, cwd?: string) {
		const { cmd, args: prefix } = await this.getBiomeBinary(cwd);
		return safeSpawnAsync(cmd, [...prefix, ...args], { timeout, cwd });
	}

	/**
	 * Ensure Biome is available, auto-installing if necessary.
	 * Prefer this over isAvailable() for auto-install behavior.
	 *
	 * Re-entrancy safe: concurrent first-time callers share one flight, so
	 * probing/auto-install isn't duplicated. The share and the clear-in-finally
	 * belong to `singleFlight` (#1753); this method owns only the latch
	 * short-circuit above it. #1690 exists because the hand-rolled clear here
	 * was never exercised by a test.
	 *
	 * The memo returns `null` when the last verdict was transient and its
	 * cooldown expired, which re-enters the probe: "biome is not installed" is a
	 * fact worth caching, "the probe timed out" is a moment worth retrying.
	 */
	async ensureAvailable(): Promise<boolean> {
		const memo = this.availabilityLatch.read();
		if (memo !== null) return memo;
		return this.ensureFlight.run("biome", () => this.doEnsureAvailable());
	}

	/**
	 * Probe `biome --version` and classify the failure through the shared
	 * policy. Only a durable verdict (`missing` / `non-installable`) may reach
	 * the install branch of `resolveManagedToolClient`; a transient one returns
	 * as `transient`, which that seam passes straight back without installing.
	 */
	private async probeBiome(): Promise<ClientAvailabilityResult<true>> {
		// The probe budget is enforced by a HOST-side timer, so a stalled event
		// loop expires it while the child is still healthy. Measure the stall
		// that overlapped the window and let the classifier see it (#1467).
		const sampler = startHostStallSampler();
		const startedAt = Date.now();
		let result: Awaited<ReturnType<typeof this.spawnBiomeAsync>>;
		let hostStallMs: number;
		try {
			// The presence probe asks whether biome answers at all, so it goes
			// through the probe seam (no cwd) rather than through
			// `spawnBiomeAsync`, whose optional `cwd` exists for the analysis
			// spawns that DO resolve a project config (#2894).
			const { cmd, args: prefix } = await this.getBiomeBinary();
			result = await probeToolAsync(cmd, [...prefix, "--version"], {
				timeout: PROBE_TIMEOUT_MS,
			});
		} finally {
			hostStallMs = sampler.stop();
		}
		const elapsedMs = Date.now() - startedAt;

		if (!result.error && result.status === 0) {
			this.lastProbeCause = "ok";
			logAvailabilityDecision({
				tool: "biome",
				verdict: "available",
				outcome: "success",
				cause: "ok",
				elapsedMs,
				latched: true,
				hostStallMs,
				budgetMs: PROBE_TIMEOUT_MS,
				classifiedBy: "probe",
			});
			return { outcome: "success", value: true };
		}

		// `unclassifiedFailureOutcome: "missing"` preserves the pre-#1476
		// meaning of a plain non-zero exit (npx reporting no biome package):
		// still "missing", still installable. Only the timeout/abort arm changes.
		const { outcome, cause, evidence } = classifyProbeFailure(result, {
			hostStallMs,
			unclassifiedFailureOutcome: "missing",
		});
		// `classifyProbeFailure` is typed over the full outcome union but never
		// returns "success" for a failed probe; narrow it for the seam's type.
		const failureOutcome: Exclude<AvailabilityOutcome, "success"> =
			outcome === "success" ? "non-installable" : outcome;
		this.lastProbeCause = cause;
		this.lastProbeElapsedMs = elapsedMs;
		this.lastProbeHostStallMs = hostStallMs;
		this.lastProbeEvidence = evidence;
		// The record is emitted by `doEnsureAvailable`, once the latch has said how
		// long this verdict holds.
		return { outcome: failureOutcome };
	}

	private async doEnsureAvailable(): Promise<boolean> {
		const resolved = await resolveManagedToolClient({
			toolId: "biome",
			cwd: process.cwd(),
			probe: () => this.probeBiome(),
			acceptInstalled: (installedPath) => {
				this.autoInstalledBinaryPath = installedPath;
				return true;
			},
		});
		if (resolved.outcome === "success") {
			this.availabilityLatch.noteAvailable();
			// The probe itself logs a clean hit. This arm is the other way to
			// succeed — the install repaired a durable miss — and it needs its own
			// record, or "biome went missing and came back" reads as silence.
			if (this.lastProbeCause !== null && this.lastProbeCause !== "ok") {
				logAvailabilityDecision({
					tool: "biome",
					verdict: "available",
					outcome: "success",
					cause: "ok",
					elapsedMs: this.lastProbeElapsedMs,
					latched: true,
					hostStallMs: this.lastProbeHostStallMs,
					budgetMs: PROBE_TIMEOUT_MS,
					classifiedBy: "caller",
					evidence: {
						install: "succeeded",
						binary: "biome",
						source: "managed-dir",
					},
				});
			}
			return true;
		}
		// A transient probe expires; a durable verdict is remembered for the
		// session exactly as before.
		const cause = this.lastProbeCause ?? "not-found";
		const retryAfterMs = this.availabilityLatch.noteUnavailable(
			resolved.outcome,
			cause,
		);
		// `missing` IS the install-failure arm (#1500 review). `resolveManagedToolClient`
		// only reaches the installer when the probe said `missing`, so every `missing`
		// verdict here has already been through it — declined, suppressed, or tried
		// and failed, which is what `describeInstallAttempt` separates. The earlier
		// marker sat on the `non-installable` arm instead, and that arm cannot happen
		// for biome at all: its `acceptInstalled` always accepts. So the one row that
		// needed the fact was the one shipping without it.
		let installEvidence: ProbeEvidence | undefined;
		if (resolved.outcome === "missing") {
			const { getInstallAttempt } = await import("./installer/index.js");
			installEvidence = describeInstallAttempt(getInstallAttempt("biome"));
		}
		const evidence = { ...this.lastProbeEvidence, ...installEvidence };
		logAvailabilityDecision({
			tool: "biome",
			verdict: "unavailable",
			outcome: resolved.outcome,
			cause,
			elapsedMs: this.lastProbeElapsedMs,
			latched: resolved.outcome !== "transient",
			hostStallMs: this.lastProbeHostStallMs,
			...(retryAfterMs > 0 && { retryAfterMs }),
			budgetMs: PROBE_TIMEOUT_MS,
			// Per arm: a probe-derived verdict says `probe`, while a verdict asserted
			// by the install seam — or a cause that fell back because no probe ran —
			// says `caller`.
			classifiedBy:
				this.lastProbeCause === null || resolved.outcome === "non-installable"
					? "caller"
					: "probe",
			...(Object.keys(evidence).length > 0 && { evidence }),
		});
		if (resolved.outcome === "transient") {
			this.log(
				"biome availability probe timed out; will retry (not installing)",
			);
		}
		return false;
	}

	/**
	 * Check if a file is supported by Biome
	 */
	isSupportedFile(filePath: string): boolean {
		return isFileKind(filePath, ["jsts", "json", "css"]);
	}

	/**
	 * Async auto-fix variant for pipeline use (non-blocking spawn).
	 * `cwd` is the dispatch language root (used for config discovery); when
	 * omitted it defaults to the file's directory.
	 */
	async fixFileAsync(
		filePath: string,
		cwd?: string,
	): Promise<{
		success: boolean;
		changed: boolean;
		fixed: number;
		error?: string;
	}> {
		if (!(await this.ensureAvailable())) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "Biome not available",
			};
		}

		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: "File not found",
			};
		}

		try {
			const before = await fs.promises.readFile(absolutePath, "utf-8");
			const configCwd = cwd ?? path.dirname(absolutePath);
			// Shared config-args seam (#1247): the lint runner consumes the same
			// builder, so `lint --write` can never drift to biome's default
			// config when a user config or the package fallback exists.
			const result = await this.spawnBiomeAsync(
				["lint", "--write", ...biomeConfigArgs(configCwd), absolutePath],
				15000,
				configCwd,
			);

			if (result.error) {
				return {
					success: false,
					changed: false,
					fixed: 0,
					error: result.error.message,
				};
			}

			const after = await fs.promises.readFile(absolutePath, "utf-8");
			const changed = before !== after;

			if (changed) {
				this.log(`Fixed issue(s) in ${path.basename(filePath)}`);
			}

			return { success: true, changed, fixed: changed ? 1 : 0 };
		} catch (err) {
			return {
				success: false,
				changed: false,
				fixed: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}
