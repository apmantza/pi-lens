/**
 * JVM runtime discovery for language-runtime LSP servers (jdtls #241).
 *
 * jdtls is itself a Java application — its launcher invokes `java`. When `java`
 * is not on PATH (common on Windows, where the Adoptium/Microsoft installers do
 * NOT add themselves to PATH and leave JAVA_HOME unset), the server silently
 * fails to spawn (`no_clients`). Rather than make the user hand-edit PATH, this
 * discovers an already-installed JDK in the canonical per-platform locations and
 * returns a spawn-env overlay (`JAVA_HOME` + `<jdk>/bin` prepended to PATH) that
 * `launchLSP` merges in — so jdtls (and its child `java`) resolve the JDK.
 *
 * This is the discovery half of #241 (runtimeInstall + canonical bin discovery);
 * the download half (fetch a Temurin JDK when none is found) is deferred.
 */
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	classifyProbeFailure,
	createAvailabilityLatch,
	logAvailabilityDecision,
	startHostStallSampler,
} from "../dispatch/runners/utils/availability-policy.js";
import { getGlobalPiLensDir } from "../file-utils.js";
import {
	normalizeSearchPath,
	trustScopedSpawnEnv,
} from "../package-manager.js";
import { safeSpawnAsync } from "../safe-spawn.js";

const JAVA_EXE = process.platform === "win32" ? "java.exe" : "java";
const JAVA_PROBE_TIMEOUT_MS = 5_000;

/** jdtls requires a JDK ≥ 17 to run; recent builds prefer 21. */
const MIN_JAVA_MAJOR = 17;

/**
 * Resolve a directory to a valid JDK home. Accepts either a JDK home directly
 * (`<dir>/bin/java`) or a macOS bundle (`<dir>/Contents/Home/bin/java`).
 */
function jdkHomeFrom(dir: string): string | undefined {
	if (existsSync(path.join(dir, "bin", JAVA_EXE))) return dir;
	const macHome = path.join(dir, "Contents", "Home");
	if (existsSync(path.join(macHome, "bin", JAVA_EXE))) return macHome;
	return undefined;
}

/**
 * Best-effort major-version parse from a JDK directory name, e.g.
 * `jdk-21.0.11.10-hotspot` → 21, `zulu-17` → 17, `jdk1.8.0_402` → 8. Returns 0
 * when unparseable (still a usable candidate, just lowest priority).
 */
function parseMajorVersion(name: string): number {
	// Legacy "1.8.0" scheme (Java 8 and earlier): a "1." NOT preceded by another
	// digit (so it never false-matches inside "21.0.11" or "jdk-11").
	const legacy = name.match(/(?<!\d)1\.(\d+)/);
	if (legacy) return Number.parseInt(legacy[1], 10);
	// Modern scheme: the first 1–2 digit run at a non-digit boundary (jdk-21 → 21).
	const modern = name.match(/(?<!\d)(\d{1,2})/);
	return modern ? Number.parseInt(modern[1], 10) : 0;
}

/** Immediate child directories of `base`, or [] if `base` is absent/unreadable. */
function childDirs(base: string): string[] {
	try {
		return readdirSync(base, { withFileTypes: true })
			.filter((e) => e.isDirectory() || e.isSymbolicLink())
			.map((e) => path.join(base, e.name));
	} catch {
		return [];
	}
}

/** Per-platform roots whose immediate children are individual JDK installs. */
function candidateRoots(): string[] {
	const home = os.homedir();
	const roots: string[] = [];
	// JetBrains and pi-lens managed (Tier 2 download target) — all platforms.
	roots.push(path.join(home, ".jdks"));
	roots.push(path.join(getGlobalPiLensDir(), "tools"));

	if (process.platform === "win32") {
		const progFiles = [
			process.env.ProgramFiles,
			process.env["ProgramFiles(x86)"],
			process.env.ProgramW6432,
			path.join(
				process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
				"Programs",
			),
		].filter((p): p is string => Boolean(p));
		for (const base of progFiles) {
			roots.push(path.join(base, "Eclipse Adoptium"));
			roots.push(path.join(base, "Java"));
			roots.push(path.join(base, "Microsoft"));
			roots.push(path.join(base, "Zulu"));
			roots.push(path.join(base, "Amazon Corretto"));
			roots.push(path.join(base, "BellSoft"));
		}
	} else if (process.platform === "darwin") {
		roots.push("/Library/Java/JavaVirtualMachines");
		roots.push(path.join(home, "Library", "Java", "JavaVirtualMachines"));
		roots.push("/opt/homebrew/opt");
		roots.push("/usr/local/opt");
	} else {
		roots.push("/usr/lib/jvm");
		roots.push("/usr/java");
		roots.push("/opt/java");
	}
	return roots;
}

interface JdkCandidate {
	home: string;
	major: number;
}

/**
 * Scan canonical locations (plus `JAVA_HOME`) for an installed JDK ≥ 17. Returns
 * the highest-version match, or undefined when none is found. Pure filesystem
 * stat/readdir — no spawning, no network.
 */
export function discoverJdkHome(
	roots: string[] = candidateRoots(),
	javaHome: string | undefined = process.env.JAVA_HOME,
): string | undefined {
	const found: JdkCandidate[] = [];

	if (javaHome) {
		const resolved = jdkHomeFrom(javaHome);
		// Trust an explicit JAVA_HOME regardless of how its name parses.
		if (resolved)
			found.push({ home: resolved, major: Number.MAX_SAFE_INTEGER });
	}

	for (const root of roots) {
		for (const dir of childDirs(root)) {
			const resolved = jdkHomeFrom(dir);
			if (!resolved) continue;
			found.push({
				home: resolved,
				major: parseMajorVersion(path.basename(dir)),
			});
		}
	}

	// Require a parseable major ≥ 17 (jdtls's floor). An explicit JAVA_HOME is
	// stamped MAX above, so it always passes regardless of how its name parses.
	const usable = found.filter((c) => c.major >= MIN_JAVA_MAJOR);
	if (usable.length === 0) return undefined;
	usable.sort((a, b) => b.major - a.major);
	return usable[0].home;
}

let _cachedEnv: { value: NodeJS.ProcessEnv | undefined } | undefined;

/**
 * Availability latch for the `java` PATH probe (#1538, the #1467 latch family's
 * benign-direction sibling). A stalled probe is not evidence the tool is
 * missing — only a genuine "not found" (or a genuinely resolvable `java`) is a
 * durable fact worth caching for the session. A transient verdict (timeout,
 * abort, host stall) expires on the shared cooldown and is re-probed on the
 * next demand instead of pinning whatever `JAVA_HOME` happened to be ambient.
 */
const javaAvailabilityLatch = createAvailabilityLatch();

/**
 * Shared spawn while a probe is in flight (#1538 follow-up). Without this, two
 * concurrent `resolveJavaRuntimeEnv` calls — e.g. a multi-root Java project
 * spawning jdtls per root — each fire their own 5 s `where`/`which java`, and
 * every expired cooldown reopens that window for the process's whole
 * lifetime, not just at startup.
 */
let inFlightJavaProbe: Promise<boolean | undefined> | null = null;

export function _resetJvmRuntimeCacheForTests(): void {
	_cachedEnv = undefined;
	javaAvailabilityLatch.reset();
	inFlightJavaProbe = null;
}

/**
 * Probe `java` on PATH, distinguishing a durable verdict (found, or genuinely
 * absent) from a transient probe failure. Returns `true`/`false` for a durable
 * verdict; `undefined` when the probe was transient — including a memo served
 * from mid-cooldown — so the caller must not treat this call as proof `java`
 * is absent.
 *
 * `AvailabilityLatch.read()` returns `false` (not `null`) for BOTH a durable
 * "not found" AND a transient verdict whose cooldown hasn't expired yet — the
 * latch's own contract is "cache a safe fallback answer for this call", not
 * "this is durable". Blindly forwarding that `false` as durable is exactly
 * the #1538 bug moved one call deeper: jdtls's failed-spawn retry
 * (`BROKEN_BASE_COOLDOWN_MS`, `clients/lsp/index.ts`) re-enters
 * `resolveJavaRuntimeEnv` ~15-20 s later — inside this probe's 30 s transient
 * cooldown — so the very first retry after a stall would otherwise still
 * launder into the permanent `_cachedEnv`. Only `javaAvailabilityLatch`'s own
 * `outcome` distinguishes the two; a durable verdict is never `"transient"`.
 */
function probeJavaOnPath(): Promise<boolean | undefined> {
	const memo = javaAvailabilityLatch.read();
	if (memo !== null) {
		if (javaAvailabilityLatch.getOutcome() === "transient") {
			// Served from the memo, but the cooldown from the earlier stall
			// hasn't expired — this is NOT a durable verdict. Log it (otherwise
			// this state leaves zero record in latency.log) and surface
			// `undefined` so the caller never writes the session cache.
			logAvailabilityDecision({
				tool: "java",
				verdict: "unavailable",
				outcome: "transient",
				cause: javaAvailabilityLatch.getCause() ?? "probe-timeout",
				elapsedMs: 0,
				latched: false,
				retryAfterMs: Math.max(
					0,
					javaAvailabilityLatch.getRetryAtMs() - Date.now(),
				),
				budgetMs: JAVA_PROBE_TIMEOUT_MS,
				// No probe ran here: the latch's own remembered cause is replayed
				// as-is, so the call site is the one asserting it (#2209).
				classifiedBy: "caller",
			});
			return Promise.resolve(undefined);
		}
		return Promise.resolve(memo);
	}

	if (inFlightJavaProbe) return inFlightJavaProbe;
	inFlightJavaProbe = runJavaProbe().finally(() => {
		inFlightJavaProbe = null;
	});
	return inFlightJavaProbe;
}

/** The actual `where`/`which java` spawn + classification. Never call this
 * directly — go through `probeJavaOnPath()`, which memoizes and dedupes it. */
async function runJavaProbe(): Promise<boolean | undefined> {
	const finder = process.platform === "win32" ? "where" : "which";
	const startedAt = Date.now();
	const sampler = startHostStallSampler();
	let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
	let hostStallMs: number;
	try {
		result = await safeSpawnAsync(finder, ["java"], {
			timeout: JAVA_PROBE_TIMEOUT_MS,
			env: trustScopedSpawnEnv() ?? process.env,
		});
	} finally {
		hostStallMs = sampler.stop();
	}
	const elapsedMs = Date.now() - startedAt;

	if (result.status === 0 && !result.error) {
		javaAvailabilityLatch.noteAvailable();
		logAvailabilityDecision({
			tool: "java",
			verdict: "available",
			outcome: "success",
			cause: "ok",
			elapsedMs,
			latched: true,
			hostStallMs,
			budgetMs: JAVA_PROBE_TIMEOUT_MS,
			classifiedBy: "probe",
		});
		return true;
	}

	// A `where`/`which` that ran fine and found nothing is a genuine absence,
	// same as a pre-existing #1496/#1467 sibling; anything else (timeout,
	// abort, host stall) is transient and must not latch.
	const { outcome, cause } = classifyProbeFailure(result, {
		hostStallMs,
		unclassifiedFailureOutcome: "missing",
	});
	const retryAfterMs = javaAvailabilityLatch.noteUnavailable(outcome, cause);
	logAvailabilityDecision({
		tool: "java",
		verdict: "unavailable",
		outcome,
		cause,
		elapsedMs,
		latched: outcome !== "transient",
		hostStallMs,
		...(retryAfterMs > 0 && { retryAfterMs }),
		budgetMs: JAVA_PROBE_TIMEOUT_MS,
		classifiedBy: "probe",
	});
	return outcome === "transient" ? undefined : false;
}

/**
 * Spawn-env overlay that makes a JVM-gated server (jdtls) launch when `java`
 * isn't on PATH. Returns undefined when `java` is already resolvable (respect
 * the user's PATH java) or when no JDK can be discovered (fail as before).
 *
 * Memoized per process — but only once the verdict is durable. A JDK found by
 * filesystem discovery is always safe to cache immediately: `discoverJdkHome`
 * is pure stat/readdir, unaffected by the PATH probe's timing. When no JDK is
 * discovered AND the PATH probe was transient, nothing is cached — the next
 * call re-probes (respecting the latch's own cooldown) instead of pinning a
 * "no override" verdict that a stalled probe never earned (#1538).
 */
export async function resolveJavaRuntimeEnv(): Promise<
	NodeJS.ProcessEnv | undefined
> {
	if (_cachedEnv) return _cachedEnv.value;

	// `java` already on PATH — nothing to inject; defer to the user's runtime.
	const javaOnPath = await probeJavaOnPath();
	if (javaOnPath === true) {
		_cachedEnv = { value: undefined };
		return undefined;
	}

	const home = discoverJdkHome();
	if (home) {
		const binDir = path.join(home, "bin");
		const currentPath = process.env.PATH ?? process.env.Path ?? "";
		_cachedEnv = {
			value: {
				JAVA_HOME: home,
				PATH: normalizeSearchPath([binDir, currentPath]),
			},
		};
		return _cachedEnv.value;
	}

	// No JDK discovered. Cache "no override" only when the PATH probe gave a
	// durable "not found" — a transient probe (timeout/host-stall) must not
	// pin this session to `undefined` forever.
	if (javaOnPath === false) {
		_cachedEnv = { value: undefined };
	}
	return undefined;
}
