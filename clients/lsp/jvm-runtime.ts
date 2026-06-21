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
import { getGlobalPiLensDir } from "../file-utils.js";
import { isCommandAvailableAsync } from "../safe-spawn.js";

const JAVA_EXE = process.platform === "win32" ? "java.exe" : "java";

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
			path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs"),
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
		if (resolved) found.push({ home: resolved, major: Number.MAX_SAFE_INTEGER });
	}

	for (const root of roots) {
		for (const dir of childDirs(root)) {
			const resolved = jdkHomeFrom(dir);
			if (!resolved) continue;
			found.push({ home: resolved, major: parseMajorVersion(path.basename(dir)) });
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

export function _resetJvmRuntimeCacheForTests(): void {
	_cachedEnv = undefined;
}

/**
 * Spawn-env overlay that makes a JVM-gated server (jdtls) launch when `java`
 * isn't on PATH. Returns undefined when `java` is already resolvable (respect
 * the user's PATH java) or when no JDK can be discovered (fail as before).
 * Memoized per process — discovery is filesystem-only but stable for a session.
 */
export async function resolveJavaRuntimeEnv(): Promise<
	NodeJS.ProcessEnv | undefined
> {
	if (_cachedEnv) return _cachedEnv.value;
	// `java` already on PATH — nothing to inject; defer to the user's runtime.
	if (await isCommandAvailableAsync("java")) {
		_cachedEnv = { value: undefined };
		return undefined;
	}
	const home = discoverJdkHome();
	if (!home) {
		_cachedEnv = { value: undefined };
		return undefined;
	}
	const binDir = path.join(home, "bin");
	const currentPath = process.env.PATH ?? process.env.Path ?? "";
	_cachedEnv = {
		value: {
			JAVA_HOME: home,
			PATH: binDir + path.delimiter + currentPath,
		},
	};
	return _cachedEnv.value;
}
