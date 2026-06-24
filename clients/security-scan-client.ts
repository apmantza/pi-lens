/**
 * Shared machinery for pi-lens's session-scan security clients
 * (gitleaks #130, govulncheck #132, trivy #131).
 *
 * Each of those surfaces findings from an external CLI scanner with the same
 * lifecycle plumbing: a one-time availability resolution (PATH probe, optionally
 * followed by an auto-install) shared across concurrent first-time callers, plus
 * per-target scan re-entrancy so concurrent scans of the same root share a single
 * process. That plumbing was copy-pasted three times; this base owns it once and
 * lets each subclass supply only the tool-specific probe/install
 * (`doEnsureAvailable`) and the scan invocation.
 *
 * Refs: #130, #131, #132
 */

import { safeSpawnAsync } from "./safe-spawn.js";

export abstract class SecurityScanClient<TResult> {
	protected available: boolean | null = null;
	private ensureInFlight: Promise<boolean> | null = null;
	protected readonly inFlight = new Map<string, Promise<TResult>>();
	protected binaryPath: string | null = null;
	protected readonly log: (msg: string) => void;

	/**
	 * @param toolName binary / installer id used for probes, logs and auto-install
	 * @param verbose  when true, diagnostics are written to stderr
	 */
	protected constructor(
		protected readonly toolName: string,
		verbose = false,
	) {
		this.log = verbose
			? (msg: string) => console.error(`[${toolName}] ${msg}`)
			: () => {};
	}

	/**
	 * Resolve (once) whether the scanner is usable, sharing the probe promise
	 * across concurrent first-time callers. The tool-specific probe + optional
	 * install lives in `doEnsureAvailable`.
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

	/** Tool-specific PATH probe + optional auto-install. Sets `this.available`. */
	protected abstract doEnsureAvailable(): Promise<boolean>;

	/**
	 * Spawn `toolName <versionArgs>` and report whether it answered cleanly.
	 * Does NOT mutate `this.available` — callers decide what a hit/miss means.
	 */
	protected async probeVersion(versionArgs: string[]): Promise<boolean> {
		const probe = await safeSpawnAsync(this.toolName, versionArgs, {
			timeout: 5000,
		});
		if (!probe.error && probe.status === 0) {
			this.log(`${this.toolName} found: ${probe.stdout.trim().split("\n")[0]}`);
			return true;
		}
		return false;
	}

	/**
	 * Standard availability path for the GitHub-release tools (gitleaks, trivy):
	 * PATH probe first, then fall back to the pi-lens installer's `ensureTool`.
	 * Records the resolved binary path and sets `this.available`.
	 */
	protected async ensureViaInstaller(versionArgs: string[]): Promise<boolean> {
		if (await this.probeVersion(versionArgs)) {
			this.available = true;
			return true;
		}
		this.log(`${this.toolName} not found, attempting auto-install`);
		const { ensureTool } = await import("./installer/index.js");
		const installed = await ensureTool(this.toolName);
		if (!installed) {
			this.log(`${this.toolName} auto-install failed`);
			this.available = false;
			return false;
		}
		this.binaryPath = installed;
		this.available = true;
		this.log(`${this.toolName} auto-installed at ${installed}`);
		return true;
	}

	/**
	 * Per-target scan re-entrancy: when a scan for `key` is already running, the
	 * concurrent caller shares the in-flight promise instead of spawning a second
	 * process. The entry is cleared when the run settles.
	 */
	protected dedupeScan(
		key: string,
		run: () => Promise<TResult>,
	): Promise<TResult> {
		const existing = this.inFlight.get(key);
		if (existing) {
			this.log(`Scan already in flight for ${key}; sharing result`);
			return existing;
		}
		const promise = run().finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, promise);
		return promise;
	}
}
