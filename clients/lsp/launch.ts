/**
 * LSP Process Launch Utilities
 *
 * Handles spawning LSP servers via various methods:
 * - Direct binary execution (using absolute paths on Windows)
 * - Node.js scripts (npx/bun)
 * - Package manager execution
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	type ChildProcess,
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTestMode } from "../env-utils.js";
import { getGlobalPiLensDir } from "../file-utils.js";
import { getGlobalPiLensLogDir } from "../probe-home-state.js";
import { isFullyQualified } from "../path-utils.js";
import { findGlobalBinary, isProjectLocalBinPath } from "../package-manager.js";
import {
	isSessionRepositoryPath,
	isUntrustedProjectPath,
	recordProjectCommandRefusal,
} from "../session-repository.js";
import {
	getDegradationLedgerGeneration,
	recordDegradationOnce,
} from "../degradation-ledger.js";
import { windowsExe } from "../process-snapshot.js";
import { getProjectTrustState } from "../project-trust.js";
import { logExtension } from "../extension-log.js";
import { OWNER_TAG_ENV, ownerTagForChildren } from "../process-snapshot.js";
import { redactSecrets } from "../redact/secrets.js";
import {
	classifySpawnFailure,
	holdOwnChildPid,
	isOwnLiveChild,
	mergeWindowsEnvironment,
	resolveSearchPathCommand,
	resolveWindowsCommandForEnvironment,
	SpawnFailureError,
	safeSpawn,
	statIsFile,
	trustScopedEnvironment,
} from "../safe-spawn.js";
import { getRubyVersionDirNamesAsync } from "./ruby-drive-dirs.js";

export interface LSPProcess {
	process: ChildProcess;
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	pid: number;
	/** The actual resolved command that was spawned (post shim/global-bin/ps1
	 *  resolution) — used by the #449/#472 instance registry to identify and
	 *  re-find this LSP child process. */
	command: string;
	/** The actual resolved args passed to `command` above. */
	args: string[];
}

const isWindows = process.platform === "win32";

/** Bound on the one-time read of this process's start for the owner tag. */
const OWNER_TAG_READ_MS = 5_000;

/**
 * Whether a resolved command must be spawned through a shell on Windows.
 * `.cmd`/`.bat` are scripts cmd.exe must interpret; extensionless or spaced-path
 * commands also go through the shell so cmd resolves/quotes them.
 */
function computeNeedsShell(resolvedCommand: string): boolean {
	return (
		isWindows &&
		(resolvedCommand.includes(" ") ||
			/\.(cmd|bat)$/i.test(resolvedCommand) ||
			!/\.(exe|cmd|bat)$/i.test(resolvedCommand))
	);
}

const DEFAULT_STARTUP_FAILURE_WINDOW_MS = 50;
const WINDOWS_NAV_STARTUP_FAILURE_WINDOW_MS = 500;
const SESSIONSTART_LOG_DIR = getGlobalPiLensLogDir();
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");
const PI_LENS_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");
const PI_LENS_TOOLS_BIN_DIR = path.join(
	getGlobalPiLensDir(),
	"tools",
	"node_modules",
	".bin",
);

function logSessionStart(msg: string): void {
	if (isTestMode()) {
		return;
	}
	// Crash-adjacent: keep this write synchronous so a hard launch failure
	// cannot discard the final diagnostic from an async logger queue.
	const line = redactSecrets(`[${new Date().toISOString()}] ${msg}\n`);
	try {
		fs.mkdirSync(SESSIONSTART_LOG_DIR, { recursive: true });
		fs.appendFileSync(SESSIONSTART_LOG, line);
	} catch {}
}

function compactLogValue(value: string, max = 280): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	return normalized.length > max
		? `${normalized.slice(0, max)}...`
		: normalized;
}

function delimiterForPlatform(platform: NodeJS.Platform): string {
	return platform === "win32" ? ";" : ":";
}

function splitPathEntries(
	value: string | undefined,
	delimiter: string,
): string[] {
	if (!value) return [];
	return value
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Dedupe key for one PATH entry, under `platform`'s rules.
 *
 * #1193 P3: the body used the HOST-DEFAULT `path.normalize` inside a branch
 * already committed to `platform` (AGENTS.md defect shape 2), so on the ubuntu
 * lane the win32 arm lowercased without folding separators or dot segments and
 * `C:\Tools` / `C:/Tools` / `C:\x\..\Tools` were three keys for one directory.
 * Each arm now parses with its own `path` flavor. That is the whole fix: a
 * `toPosix` call on the win32 arm would be INERT — `win32.normalize` already
 * answers backslashes for either input separator (measured: adding it left
 * every case green) — and the POSIX arm must NOT fold separators at all,
 * because a backslash is a legal POSIX filename character and `/opt/a\b` and
 * `/opt/a/b` are two directories there.
 *
 * Ephemeral by construction: the key exists only inside one
 * `combinePathValuesForPlatform` call's `seen` set — the ORIGINAL entry string
 * is what survives into the joined PATH — so it never reaches a persisted or
 * cross-process record and `normalizeEphemeralMapKey`'s `process.platform` read
 * would defeat the explicit-`platform` seam these arms exist for.
 */
function normalizePathEntry(entry: string, platform: NodeJS.Platform): string {
	if (platform !== "win32") return path.posix.normalize(entry);
	return path.win32.normalize(entry).toLowerCase();
}

export function combinePathValuesForPlatform(
	values: Array<string | undefined>,
	platform: NodeJS.Platform = process.platform,
): string {
	const unique: string[] = [];
	const seen = new Set<string>();
	const delimiter = delimiterForPlatform(platform);

	for (const value of values) {
		for (const entry of splitPathEntries(value, delimiter)) {
			const key = normalizePathEntry(entry, platform);
			if (seen.has(key)) continue;
			seen.add(key);
			unique.push(entry);
		}
	}

	return unique.join(delimiter);
}

function resolvePathValue(env: NodeJS.ProcessEnv): string {
	return combinePathValuesForPlatform([env.PATH, env.Path, env.path]);
}

/**
 * Run a probe with the #2095 stderr guard applied, returning `""` on any
 * failure. Exported as a small test seam: production always calls it with the
 * fixed `powershell.exe` command/args below, but a test can pass a command
 * guaranteed to fail with real stderr output (no real Windows or
 * powershell.exe required) to prove the guard is actually reached and not
 * vacuous.
 *
 * #4530: the probe starts through the spawn seam. A raw `execFileSync` of the
 * bare `powershell.exe` was a lookup Windows answers from the cwd FIRST, so a
 * project's own `powershell.exe` ran before any PATH entry; the seam resolves
 * PATH only and judges the result against project trust. The seam also pipes
 * stderr (#2095 sibling: an inherited stderr printed powershell's raw
 * diagnostics into the pi TUI) and bounds the run.
 */
export function runStderrGuardedProbe(command: string, args: string[]): string {
	const result = safeSpawn(command, args, { timeout: 3000 });
	if (result.error || result.status !== 0) return "";
	return result.stdout.trim();
}

/** Read live system+user PATH from Windows registry (bypasses stale process.env.PATH). */
function readWindowsRegistryPath(): string {
	return runStderrGuardedProbe("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')",
	]);
}

let _liveWindowsPath: string | null = null;
function getLiveWindowsPath(): string {
	if (_liveWindowsPath === null) {
		_liveWindowsPath = readWindowsRegistryPath();
	}
	return _liveWindowsPath;
}

async function buildAugmentedPath(basePath?: string): Promise<string> {
	const candidates: string[] = [];
	const nodeDir = path.dirname(process.execPath);
	if (nodeDir) {
		candidates.push(nodeDir);
	}

	if (isWindows) {
		const home = os.homedir();
		const driveRoot = path.parse(home).root; // e.g. "C:\"
		candidates.push(path.join(home, ".cargo", "bin"));
		candidates.push(path.join(home, "go", "bin"));
		candidates.push(path.join(home, ".dotnet", "tools"));
		candidates.push(PI_LENS_BIN_DIR);
		candidates.push(PI_LENS_TOOLS_BIN_DIR);
		candidates.push(path.join(driveRoot, "Program Files", "Go", "bin"));
		candidates.push(path.join(driveRoot, "Go", "bin"));
		// Ruby installer drops versioned dirs (e.g. Ruby34-x64) on the drive root.
		// Read off the event loop and memoized once per process (#1137): a
		// synchronous drive-root enumeration on every LSP spawn blocked the loop
		// for the whole stall on a slow cloud/network-backed drive root.
		for (const entry of await getRubyVersionDirNamesAsync(driveRoot)) {
			candidates.push(path.join(driveRoot, entry, "bin"));
		}
	}

	// On Windows, merge the live registry PATH so newly installed tools are visible
	// even if the pi agent process started before they were installed.
	const effectiveBase = isWindows
		? combinePathValuesForPlatform([basePath, getLiveWindowsPath()])
		: basePath;

	const existing = new Set<string>();
	for (const entry of splitPathEntries(effectiveBase, path.delimiter)) {
		if (!entry) continue;
		existing.add(normalizePathEntry(entry, process.platform));
	}

	const toAppend: string[] = [];
	for (const candidate of candidates) {
		if (!candidate || !fs.existsSync(candidate)) continue;
		const normalized = normalizePathEntry(candidate, process.platform);
		if (existing.has(normalized)) continue;
		toAppend.push(candidate);
		existing.add(normalized);
	}

	if (toAppend.length === 0) return basePath ?? "";
	if (!basePath) return toAppend.join(path.delimiter);
	return `${basePath}${path.delimiter}${toAppend.join(path.delimiter)}`;
}

/**
 * Validate that a .cmd shim's target JS/script exists before attempting to
 * spawn it. npm-generated .cmd files reference the actual script via a path
 * like `"%~dp0\..\yaml-language-server\bin\yaml-language-server"`. If that
 * target is missing the shim will exit immediately with code 1 after a 500ms
 * startup window — pre-checking avoids the delay.
 * Returns true if the shim is valid (or we can't determine), false if the
 * target is definitively missing.
 */
export function isCmdShimValid(cmdPath: string): boolean {
	try {
		const content = fs.readFileSync(cmdPath, "utf-8");
		// npm cmd shim pattern: "%~dp0\..\<relpath>" or "%~dp0/<relpath>"
		// The `-` ends the char class, where it is a literal and needs no escape.
		// oxfmt formats this repository (#1844) and rewrites no regex literal, so
		// this line needs no suppression; the directive oxfmt honors, if one is
		// ever needed here, is `// prettier-ignore`.
		const match = content.match(
			/"%~dp0[/\\]\.\.[/\\]((?:[\w./@-]|\\)+\.(?:mjs|cjs|js))"/i,
		);
		if (!match) return true; // non-npm shim — let it through
		const relPath = match[1].replace(/[/\\]/g, path.sep);
		const target = path.resolve(path.dirname(cmdPath), "..", relPath);
		return fs.existsSync(target);
	} catch {
		return true; // can't read — be permissive
	}
}

/**
 * Whether the launcher ESTABLISHED that the program it spawned exists
 * (#4263, #4532 round 4 — the caller reads this, it is not re-derived).
 *
 * The evidence depends on the spelling. A BARE command is found by a search:
 * `present` when the launcher's in-process PATH scan returned a path, or a
 * managed/global fallback replaced the spelling, and `absent` only when that
 * search came back empty. An EXPLICIT spelling (absolute, or relative to the
 * cwd) names one file and no search applies, so its presence is that file on
 * disk, read before the spawn: the file itself, or the file cmd.exe would run
 * under PATHEXT (`resolveWindowsCommandForEnvironment`, the rule the pre-#4532
 * classifier asked). Round 5 (review F1): this arm used to read "the spelling
 * changed" for both, so an installed absolute `gopls.exe` that exited 1 read
 * `absent` and went to the installer, and a relative spelling that did not
 * exist read `present`. A `.cmd`/`.bat` shim whose npm target the launcher read
 * on disk is present under either spelling.
 *
 * The distinction is the whole rule: the exit code answers "the program
 * failed", never "the program is absent". Windows' shell-backed launches report
 * exit code 1 both for a command cmd.exe never found and for a present tool
 * that failed at startup, and a present binary classified absent is handed to
 * the installer.
 */
function windowsCommandPresence(evidence: {
	command: string;
	spawnCommand: string;
	isBareCommand: boolean;
	scannedCommandPath: string | undefined;
	cwd: string;
	env: NodeJS.ProcessEnv;
}): "present" | "absent" {
	const { command, spawnCommand } = evidence;
	// The shim's own target was read on disk before the spawn.
	if (/\.(cmd|bat)$/i.test(spawnCommand) && isCmdShimValid(spawnCommand)) {
		return "present";
	}
	if (evidence.isBareCommand) {
		// The scan resolved this spelling, or a managed/global fallback replaced it.
		return evidence.scannedCommandPath !== undefined || spawnCommand !== command
			? "present"
			: "absent";
	}
	return statIsFile(spawnCommand) ||
		resolveWindowsCommandForEnvironment(
			spawnCommand,
			evidence.cwd,
			evidence.env,
		)
		? "present"
		: "absent";
}

/**
 * Windows' shell-backed missing commands report exit code 1 instead of ENOENT.
 * Only classify that startup shape as repairable when an npm shim's target is
 * absent, or when the launcher's own search for the command came back empty. A
 * present executable that exits 1 remains a runtime failure (#4263, #1199).
 */
function isMissingWindowsStartupCommand(
	spawnCommand: string,
	presence: "present" | "absent",
): boolean {
	if (!isWindows) return false;
	if (/\.(cmd|bat)$/i.test(spawnCommand) && !isCmdShimValid(spawnCommand)) {
		return true;
	}
	return presence === "absent";
}

/**
 * On Windows, npm creates .ps1 wrappers that hang indefinitely when PowerShell
 * execution policy is Restricted or AllSigned. Bypass by preferring the .cmd
 * sibling (runs under cmd.exe, no execution policy) or falling back to direct
 * Node.js execution of the JS entry point extracted from the PS1 script.
 * Returns undefined if no safe bypass is found.
 */
function bypassPs1OnWindows(
	ps1Path: string,
	args: string[],
): { command: string; args: string[]; needsShell: boolean } | undefined {
	// 1. Prefer the .cmd sibling — cmd.exe handles it without execution policy issues
	const cmdPath = `${ps1Path.slice(0, -4)}.cmd`;
	if (fs.existsSync(cmdPath)) {
		return { command: cmdPath, args, needsShell: true };
	}

	// 2. Parse the .ps1 to find the JS entry point and invoke via node directly.
	// npm-generated PS1 pattern: "$basedir/../<package>/bin/cli.js"
	try {
		const content = fs.readFileSync(ps1Path, "utf-8");
		// Same char class as isCmdShimValid above, and the same note: the trailing
		// `-` is a literal, and oxfmt leaves regex literals alone.
		const match = content.match(
			/"\$basedir[/\\]\.\.[/\\]((?:[\w./@-]|\\)+\.(?:mjs|cjs|js))"/i,
		);
		if (match) {
			const relPath = match[1].replace(/[/\\]/g, path.sep);
			const jsPath = path.resolve(path.dirname(ps1Path), "..", relPath);
			if (fs.existsSync(jsPath)) {
				return {
					command: process.execPath,
					args: [jsPath, ...args],
					needsShell: false,
				};
			}
		}
	} catch {
		// Can't read PS1 — no bypass available
	}

	return undefined;
}

/**
 * Resolve a bare command name against the effective child PATH, IN PROCESS.
 *
 * #4532 round 3 (HIGH-2): this used to spawn `which`/`where`. A spawn resolves
 * its OWN program through the same PATH it is asked to judge, from the cwd the
 * server child is spawned with — so an adopted root that ships
 * `node_modules/.bin/which` executed its own copy of the probe, wrote its
 * marker, and could answer anything. A resolver the classified program can
 * supply classifies nothing. The scan below runs in this process, over the
 * PATH and the child cwd `launchLSP` already resolved, and consults no program
 * the project can put on PATH.
 *
 * The kernel's rule (`execvp`) is the model: entries are searched in order, a
 * RELATIVE entry is resolved against the CHILD's cwd (husky's generated
 * `.husky/_/h` exports exactly `node_modules/.bin` for every git hook, and a
 * caller's own `PATH=bin:$PATH` reaches it too), the first entry holding an
 * executable file wins, and the result is absolute. Classifying where the
 * child will exec is exactly what the analysis-root permission gate below
 * needs; a resolution this function did not perform is one the child performs
 * unclassified (#4248, #4299 R2-F1).
 *
 * Windows keeps its PATHEXT-aware in-process resolver
 * (`resolveWindowsCommandForEnvironment`, the same `where`-equivalent
 * `computeNeedsShell` already asks), so the `.cmd`/`.exe` suffix rules are
 * unchanged. The in-process scan also removes the 5 s child-process bound the
 * spawn needed (#1980): there is no probe binary left to hang.
 */
function findBinaryOnPath(
	command: string,
	env: NodeJS.ProcessEnv,
	cwd: string,
): string | undefined {
	if (isWindows) {
		return resolveWindowsCommandForEnvironment(command, cwd, env)?.resolvedPath;
	}
	// The kernel's rule, shared with the spawn seam's lookup judgment (#4530):
	// a relative entry is joined to the cwd as text, so `link/..` reaches the
	// filesystem unfolded, as it reaches the kernel. An EMPTY entry never
	// reaches this scan: `resolvePathValue`'s `combinePathValuesForPlatform`
	// drops empty entries upstream (#4532 round 4, LOW-1).
	return resolveSearchPathCommand(command, env.PATH, cwd);
}

// #4299 R2-F1: every launcher in one service spawn inherits its file's
// analysis-root permission, including async discovery and repair continuations.
const lspProjectCodePermission = new AsyncLocalStorage<boolean>();

export function withLspProjectCodePermission<T>(
	allowed: boolean,
	spawn: () => Promise<T>,
): Promise<T> {
	return lspProjectCodePermission.run(allowed, spawn);
}

let unknownProjectLocalNoticeGeneration = -1;

type LspExecutionTrustRequest =
	| {
			kind: "project-code-server";
			serverId: string;
			root: string;
	  }
	| {
			kind: "project-local-binary";
			command: string;
			resolvedCommand: string;
			cwd: string;
			/** Effective compiler refusal, including foreign-root ownership. */
			reason?: string;
	  };

/** Record one bounded trust refusal through the shared lsp-registry seam. */
function recordUntrustedLspExecution(
	request: LspExecutionTrustRequest,
	trust: ReturnType<typeof getProjectTrustState>,
): void {
	const generation = getDegradationLedgerGeneration();
	const subject =
		request.kind === "project-code-server"
			? `project-code-server:g${generation}:${request.serverId}:${request.root}`
			: `project-local-binary:g${generation}:${path.basename(request.command)}`;
	const metadata =
		request.kind === "project-code-server"
			? {
					field: request.kind,
					serverId: request.serverId,
					root: request.root,
					trust,
				}
			: {
					field: request.kind,
					trust,
				};
	recordDegradationOnce({
		kind: "lsp-registry-decision",
		subject,
		reason:
			(request.kind === "project-local-binary" ? request.reason : undefined) ??
			`LSP execution refused: ${request.kind} and project trust is ${trust}`,
		metadata,
	});
	if (unknownProjectLocalNoticeGeneration !== generation) {
		unknownProjectLocalNoticeGeneration = generation;
		const label =
			request.kind === "project-code-server"
				? "project-code LSP server"
				: "project-local LSP binary";
		logExtension({
			subsystem: "lsp-registry",
			level: "warn",
			message: `${label} refused: mark the project trusted in pi or upgrade pi`,
			metadata: { field: request.kind },
		});
	}
}

/** Refuse project-code servers and project-local binaries through one trust seam. */
export function refuseUntrustedLspExecution(
	request: LspExecutionTrustRequest,
): void {
	const trust = getProjectTrustState();
	const needsTrust =
		request.kind === "project-code-server"
			? trust !== "trusted"
			: !admitProjectSuppliedTsserver(
					request.resolvedCommand,
					request.cwd,
					true,
				);
	if (!needsTrust) return;

	if (request.kind === "project-code-server")
		recordUntrustedLspExecution(request, trust);
	// #4515: a refused project-local candidate is skipped, not terminal: the
	// resolver still owes the managed and global candidates their turn.
	throw new SpawnFailureError(
		request.kind === "project-local-binary" ? "trust-refused" : "spawn-failed",
		`LSP ${request.kind === "project-code-server" ? "project-code server" : "project-local binary"} refused: project trust is ${trust}`,
		new Error(`project trust is ${trust}`),
	);
}

/**
 * #4296/#4299: admit the effective classic/native compiler or local launcher,
 * never an unset hint that lets the
 * wrapper resolve workspace code. Project code also requires session ownership;
 * pi's trusted answer does not authorize an adopted project's compiler.
 */
export function admitProjectSuppliedTsserver(
	tsserverPath: string | undefined,
	cwd: string,
	projectSupplied: boolean,
	// Outside a spawn scope there is no root permission to read, so deny (#4296 R3-F1).
	projectCodeAllowed = lspProjectCodePermission.getStore() ?? false,
): string | undefined {
	const trust = getProjectTrustState();
	if (
		tsserverPath &&
		(!projectSupplied || (projectCodeAllowed && trust === "trusted"))
	)
		return tsserverPath;
	if (!tsserverPath) {
		recordUnresolvedTypeScriptCompiler(cwd, trust);
		return undefined;
	}
	recordUntrustedLspExecution(
		{
			kind: "project-local-binary",
			command: tsserverPath,
			resolvedCommand: tsserverPath,
			cwd,
			reason:
				"LSP execution refused: project compiler requires trusted session ownership",
		},
		trust,
	);
	return undefined;
}

/**
 * #4414: no admitted absolute compiler is a resolution miss, not a trust
 * refusal (a trusted project with only a PATH `tsc` was told to "mark the
 * project trusted"). The ledger row is per root per generation. The warn shares
 * `unknownProjectLocalNoticeGeneration` with the trust notice, so a generation
 * prints one notice: a genuine trust refusal is never followed by this one.
 */
function recordUnresolvedTypeScriptCompiler(
	cwd: string,
	trust: ReturnType<typeof getProjectTrustState>,
): void {
	const generation = getDegradationLedgerGeneration();
	recordDegradationOnce({
		kind: "lsp-registry-decision",
		subject: `typescript-compiler:g${generation}:${cwd}`,
		reason:
			"LSP not started: no absolute TypeScript compiler (tsserver.js) was resolved",
		metadata: { field: "typescript-compiler", trust },
	});
	if (unknownProjectLocalNoticeGeneration === generation) return;
	unknownProjectLocalNoticeGeneration = generation;
	// #4530: a lookup that refused the project's own compiler (a project PATH
	// entry dropped, a resolved answer refused) already told the user, in this
	// session, that trust is the cause; a resolution notice after it would
	// blame resolution for a compiler pi found and refused (#4414 F1).
	if (trust !== "trusted" && sessionRepositoryHoldsCompiler(cwd)) return;
	logExtension({
		subsystem: "lsp-registry",
		level: "warn",
		message:
			"TypeScript language server not started: no absolute TypeScript compiler (tsserver.js) could be resolved; install typescript in the project or let pi-lens install it",
		metadata: { field: "typescript-compiler" },
	});
}

/**
 * Whether the bare `tsc` lookup, through the search path before trust scoping,
 * answers with the session repository's bytes: the refusal that explains a
 * missing compiler. Any other trust refusal (a project scripts dir dropped
 * from the search path) says nothing about TypeScript, so it never hides the
 * notice (#4776 review F3).
 */
function sessionRepositoryHoldsCompiler(cwd: string): boolean {
	const found = findBinaryOnPath("tsc", process.env, cwd);
	return found !== undefined && isSessionRepositoryPath(found);
}

/**
 * Whether the resolved executable is a project-local installed binary.
 * `launchLSP` is the one seam that has both the final resolved command and its
 * spawn cwd; keep the project-local classifier here so PATH, venv, and shim
 * resolution cannot grow separate trust predicates (#4248).
 */
export function isProjectLocalLspBinary(
	resolvedCommand: string,
	cwd: string,
): boolean {
	return isProjectLocalBinPath(resolvedCommand, cwd);
}

/**
 * #4530: refuse a bare launch whose answer is the session repository's bytes
 * while pi has not trusted the project, with the typed `trust-refused` failure
 * the resolver skips past to its next candidate (#4515).
 *
 * Two answers can be: the file the PATH scan or global-bin lookup resolved
 * (a global entry holding a link into the project, judged by its real
 * target), and, on Windows, the command left unresolved. Windows starts an
 * unresolved bare command through `cmd.exe`, which searches the child's cwd
 * BEFORE PATH: when the scoped PATH answered nothing, the only file that
 * search can find is the cwd's own, so an owned cwd refuses the start.
 */
function refuseProjectLookup(
	command: string,
	spawnCommand: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): void {
	const unresolved = spawnCommand === command;
	if (unresolved && !isWindows) return;
	const owned = unresolved
		? resolveWindowsCommandForEnvironment(
				command,
				cwd,
				mergeWindowsEnvironment(env, { PATH: cwd }),
			)?.resolvedPath
		: spawnCommand;
	if (owned === undefined || !isUntrustedProjectPath(owned)) return;
	recordProjectCommandRefusal(owned);
	throw new SpawnFailureError(
		"trust-refused",
		`LSP lookup refused: ${command} resolved inside the project and project trust is ${getProjectTrustState()}`,
		new Error(`project trust is ${getProjectTrustState()}`),
	);
}

/**
 * Try to spawn a process, throwing immediately if it fails
 */
function trySpawn(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	needsShell: boolean,
): ChildProcess {
	let proc: ChildProcess;

	if (needsShell) {
		// Build a cmd.exe-safe command string: wrap in double quotes, escape internal
		// quotes by doubling them, and escape cmd metacharacters (& | < > ^ ( ) !) with ^
		const escapeCmdArg = (s: string): string => {
			// Escape cmd.exe metacharacters first, then wrap in quotes if needed
			const escaped = s.replace(/([&|<>^()!])/g, "^$1");
			return /[\s"]/.test(escaped)
				? `"${escaped.replace(/"/g, '""')}"`
				: escaped;
		};
		// shell:true justified: Windows .cmd/.bat LSP binaries (e.g. typescript-language-server.cmd)
		// cannot be spawned via execFile — cmd.exe must interpret the script wrapper.
		const shellCommand = `"${command}" ${args.map(escapeCmdArg).join(" ")}`;
		// #2015 class-sweep exemption: this is a LONG-LIVED language-server launch,
		// not a bounded probe - killing it on a timeout would be wrong, and its
		// lifetime is owned by the LSP lifecycle, not the spawner. Exempt from the
		// verifyToolBinary/probe tree-kill migration.
		proc = nodeSpawn(shellCommand, [], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: !isWindows,
			windowsHide: true,
			shell: true,
		});
	} else {
		// Use normal spawn without shell
		proc = nodeSpawn(command, args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: !isWindows,
			windowsHide: isWindows,
		});
	}

	if (!proc.stdin || !proc.stdout || !proc.stderr) {
		throw new Error(`Failed to spawn LSP server: ${command}`);
	}

	// #3091 F1-r2: take ownership HERE, while the child is provably alive. LSP
	// servers are the one long-lived child pi-lens spawns outside
	// `safeSpawnAsync`, so without this their first offer of verification is
	// `stopLSP`'s group kill — by which time, on the `processExiting` path, the
	// leader can already be dead, `/proc` is gone, and the group signal that
	// reaps surviving grandchildren (#2026) is refused. The verdict is released
	// by `killProcessTree` when the shutdown ladder is done with the pid.
	holdOwnChildPid(proc.pid, "lsp-spawn");

	return proc;
}

/**
 * Attach error handler to a spawned process to prevent ENOENT crashes
 * This catches "command not found" errors and other spawn failures
 * Returns a promise that rejects if an immediate error occurs
 */
function unrefLspProcessHandles(proc: ChildProcess): void {
	try {
		proc.unref();
	} catch {
		// best-effort
	}
	for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
		try {
			(stream as { unref?: () => void } | null | undefined)?.unref?.();
		} catch {
			// best-effort
		}
	}
}

function _attachErrorHandler(
	proc: ChildProcess,
	context: string,
	logContext?: {
		command: string;
		args: string[];
		cwd: string;
		pid?: number;
	},
	rejectOnImmediateError?: (err: Error) => void,
): void {
	let stderrPreview = "";
	let closeLogged = false;
	const onStderr = (chunk: Buffer | string): void => {
		if (stderrPreview.length >= 4000) return;
		stderrPreview += chunk.toString();
	};
	proc.stderr?.on("data", onStderr);

	proc.on("error", (err) => {
		if (logContext) {
			logSessionStart(
				"lsp process " +
					context +
					": spawn-error command=" +
					logContext.command +
					" args=" +
					JSON.stringify(logContext.args) +
					" cwd=" +
					logContext.cwd +
					" pid=" +
					(logContext.pid ?? 0) +
					" error=" +
					err.message +
					(stderrPreview ? " stderr=" + compactLogValue(stderrPreview) : ""),
			);
		}

		// Preserve intent at the boundary instead of leaking a raw errno check.
		if (rejectOnImmediateError && logContext) {
			void classifySpawnFailure(err, {
				command: logContext.command,
				cwd: logContext.cwd,
			}).then(rejectOnImmediateError);
		}
	});

	proc.on("close", (code, signal) => {
		if (closeLogged) return;
		closeLogged = true;
		proc.stderr?.off("data", onStderr);
		if (code !== 0 && code !== null) {
			if (logContext) {
				logSessionStart(
					"lsp process " +
						context +
						": closed code=" +
						code +
						(signal ? " signal=" + signal : "") +
						" command=" +
						logContext.command +
						" args=" +
						JSON.stringify(logContext.args) +
						" cwd=" +
						logContext.cwd +
						" pid=" +
						(logContext.pid ?? 0) +
						(stderrPreview ? " stderr=" + compactLogValue(stderrPreview) : ""),
				);
			}
		} else if (signal && logContext) {
			logSessionStart(
				"lsp process " +
					context +
					": closed signal=" +
					signal +
					" command=" +
					logContext.command +
					" args=" +
					JSON.stringify(logContext.args) +
					" cwd=" +
					logContext.cwd +
					" pid=" +
					(logContext.pid ?? 0) +
					(stderrPreview ? " stderr=" + compactLogValue(stderrPreview) : ""),
			);
		}
	});
}

/**
 * Spawn an LSP server process
 *
 * Key fixes for Windows:
 * - Uses absolute paths (relative paths fail in shell mode)
 * - Uses shell: true for .cmd files
 * - Uses windowsHide to prevent console window popup
 * - Detects immediate spawn failures (ENOENT) before returning
 *
 * @param command - Command to run (e.g., "typescript-language-server")
 * @param args - Arguments (e.g., ["--stdio"])
 * @param options - Spawn options including cwd, env
 * @returns LSPProcess handle
 */
export async function launchLSP(
	command: string,
	args: string[] = [],
	options: SpawnOptions & {
		startupFailureWindowMs?: number;
	} = {},
): Promise<LSPProcess> {
	const cwd = String(options.cwd ?? process.cwd());
	const mergedEnv = { ...process.env, ...options.env };
	const augmentedPath = await buildAugmentedPath(resolvePathValue(mergedEnv));
	// #3539: the child names this process's incarnation, so the orphan
	// backstop can tell whose it is after this process dies and the child is
	// reparented. With no tag of our own the child gets none (#3986): the
	// host's inherited PI_LENS_OWNER may name a dead foreign owner, and an
	// untagged server is spared where a wrongly tagged one is reaped.
	const ownerTag = await ownerTagForChildren({ timeoutMs: OWNER_TAG_READ_MS });
	// #4530: the child's search path, and the scan below that reads it, lose
	// the session repository's own directories until pi trusts the project.
	const env: NodeJS.ProcessEnv = trustScopedEnvironment(
		{
			...mergedEnv,
			PATH: augmentedPath,
			...(isWindows ? { Path: augmentedPath } : {}),
		},
		cwd,
	);
	if (ownerTag === undefined) delete env[OWNER_TAG_ENV];
	else env[OWNER_TAG_ENV] = ownerTag;

	// Resolve command path
	// - If already absolute, use as-is
	// - If it's a simple command (no path separators), let system find it via PATH
	// - Otherwise, resolve relative to cwd
	// `isBareCommand` is computed ONCE: the scan, the global-bin fallback and the
	// presence the exit-code classifier reads must all agree on which spelling
	// the launcher is judging (#4532 round 4).
	const isBareCommand =
		!isFullyQualified(command) &&
		!command.includes(path.sep) &&
		!command.includes("/");
	const isRelativePath =
		!isFullyQualified(command) &&
		(command.includes(path.sep) || command.includes("/"));
	const explicitCommand = isRelativePath ? path.resolve(cwd, command) : command;
	const scannedCommandPath = isBareCommand
		? findBinaryOnPath(command, env, cwd)
		: undefined;
	const resolvedCommand = scannedCommandPath ?? explicitCommand;

	// Compute needsShell based on command
	// On Windows, shell: true is needed for .cmd/.bat files and extensionless binaries
	// .exe files can be spawned directly, but .cmd/.bat require shell interpretation
	let needsShell = computeNeedsShell(resolvedCommand);

	// Try to spawn the process
	// If command not found, try npm global as fallback (handles PATH caching after install)
	let spawnCommand = resolvedCommand;

	// First, try to find in npm global if it's a simple command name
	if (isBareCommand) {
		const globalBinPath = await findGlobalBinary(command);
		if (globalBinPath) {
			spawnCommand = globalBinPath;
			// Recompute needsShell for the resolved global path
			needsShell = computeNeedsShell(spawnCommand);
		}
	}

	// AGENTS.md defect shape 58 — a known identity is carried, not re-derived:
	// the presence the exit-code classifier asks about is resolved HERE, once,
	// from the evidence this launch holds, and both classification sites below
	// read it. Nothing re-reads the PATH or the cwd after the spawn.
	const commandPresence: "present" | "absent" = isWindows
		? windowsCommandPresence({
				command,
				spawnCommand,
				isBareCommand,
				scannedCommandPath,
				cwd,
				env,
			})
		: "absent";

	// Built-in server commands have no config provenance to carry into the
	// registry. Once PATH resolution selects a project-local installed binary,
	// trusted session ownership is required (#4248 R2-1, #4299 R2-F1). Global and managed
	// fallbacks remain compatible because they resolve outside the project root.
	if (isProjectLocalLspBinary(spawnCommand, cwd)) {
		refuseUntrustedLspExecution({
			kind: "project-local-binary",
			command,
			resolvedCommand: spawnCommand,
			cwd,
		});
	}

	// #4530: a bare command is a lookup, and a lookup never answers with the
	// session repository's bytes until pi trusts the project. The scoped PATH
	// already holds no project entry, so what is left is a global entry or
	// global bin dir holding a link into the project: judged by the target.
	if (isBareCommand) refuseProjectLookup(command, spawnCommand, cwd, env);

	// Pre-validate .cmd shims only after trust has admitted the candidate: if the
	// underlying script is missing the shim will exit with code 1 after a 500ms
	// wait. Catching this early avoids the delay without probing an untrusted
	// project-local executable.
	if (
		isWindows &&
		/\.(cmd|bat)$/i.test(spawnCommand) &&
		!isCmdShimValid(spawnCommand)
	) {
		logSessionStart(
			`lsp cmd-shim-invalid: ${spawnCommand} target missing — skipping candidate`,
		);
		const cause = Object.assign(
			new Error(`LSP .cmd shim target not found: ${spawnCommand}`),
			{ code: "ENOENT" },
		);
		throw await classifySpawnFailure(cause, { command, cwd });
	}

	// P0 FIX: Never spawn .ps1 wrappers on Windows — they hang when PowerShell
	// execution policy is Restricted/AllSigned. Prefer .cmd or direct node.
	if (isWindows && /\.ps1$/i.test(spawnCommand)) {
		const bypass = bypassPs1OnWindows(spawnCommand, args);
		if (bypass) {
			logSessionStart(
				`lsp ps1-bypass: ${spawnCommand} → ${bypass.command} shell=${bypass.needsShell}`,
			);
			spawnCommand = bypass.command;
			args = bypass.args;
			needsShell = bypass.needsShell;
		} else {
			logSessionStart(
				`lsp ps1-bypass: no .cmd or JS entry found for ${spawnCommand}, spawn may hang`,
			);
		}
	}

	let proc: ChildProcess;

	try {
		proc = trySpawn(spawnCommand, args, cwd, env, needsShell);
	} catch (err) {
		// If spawn failed with simple command, try npm global
		if (isBareCommand) {
			const globalBinPath = await findGlobalBinary(command);
			if (globalBinPath && globalBinPath !== spawnCommand) {
				// Recompute needsShell for the resolved global path
				const needsShellGlobal = computeNeedsShell(globalBinPath);
				proc = trySpawn(globalBinPath, args, cwd, env, needsShellGlobal);
			} else {
				throw await classifySpawnFailure(err, { command, cwd });
			}
		} else {
			throw await classifySpawnFailure(err, { command, cwd });
		}
	}

	if (!proc.stdin || !proc.stdout || !proc.stderr) {
		throw new Error(`Failed to spawn LSP server: ${command}`);
	}

	// Check if process exited immediately (spawn failure - synchronous check)
	if (proc.exitCode !== null || proc.killed) {
		const message =
			`LSP server ${command} exited immediately (code: ${proc.exitCode}). ` +
			`The binary may be missing or corrupted.`;
		const failure = new Error(message);
		if (
			proc.exitCode === 1 &&
			isMissingWindowsStartupCommand(spawnCommand, commandPresence)
		) {
			throw new SpawnFailureError("tool-not-found", message, failure);
		}
		throw failure;
	}

	logSessionStart(
		`lsp launch: command=${command} resolved=${spawnCommand} args=${JSON.stringify(args)} cwd=${cwd} shell=${needsShell ? "true" : "false"} pid=${proc.pid ?? 0}`,
	);

	const formatStartupStderr = (stderr: string): string => {
		const normalized = compactLogValue(stderr);
		if (!normalized) return "";
		return ` stderr=${normalized}`;
	};

	let startupStderr = "";
	const onStartupStderr = (chunk: Buffer | string): void => {
		if (startupStderr.length >= 4000) return;
		startupStderr += chunk.toString();
	};
	proc.stderr?.on("data", onStartupStderr);

	// For Windows and certain spawn failures, the error is async (ENOENT)
	// We need to wait a small tick to catch immediate spawn failures
	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;

			// Attach error handler that can reject for immediate errors
			proc.on("error", (err: Error) => {
				if (!settled) {
					settled = true;
					void classifySpawnFailure(err, { command, cwd }).then((failure) => {
						const detail = formatStartupStderr(startupStderr);
						reject(
							detail
								? new SpawnFailureError(
										failure.kind,
										`${failure.message}${detail}`,
										failure.cause,
									)
								: failure,
						);
					});
				}
			});

			// Also listen for immediate exit
			proc.on("exit", (code: number | null) => {
				if (!settled && code !== null) {
					settled = true;
					// On Windows, .cmd shims fail with code 1 when the underlying binary isn't installed
					// This is different from ENOENT - the shim exists but can't find the binary
					const isWindowsCmd = isWindows && command.endsWith(".cmd");
					const errorMsg =
						isWindowsCmd && code === 1
							? `npm .cmd shim failed (underlying binary not installed). Run 'npm install' in this project or use a global installation.`
							: `The binary may be missing or corrupted.`;
					const message = `LSP server ${command} exited immediately with code ${code}. ${errorMsg}${formatStartupStderr(startupStderr)}`;
					const failure = new Error(message);
					if (
						code === 1 &&
						isMissingWindowsStartupCommand(spawnCommand, commandPresence)
					) {
						reject(new SpawnFailureError("tool-not-found", message, failure));
						return;
					}
					reject(failure);
				}
			});

			const startupFailureWindowMs = ((): number => {
				if (options?.startupFailureWindowMs) {
					return options.startupFailureWindowMs;
				}
				if (isWindows && needsShell) {
					return WINDOWS_NAV_STARTUP_FAILURE_WINDOW_MS;
				}
				return DEFAULT_STARTUP_FAILURE_WINDOW_MS;
			})();

			// Give shell-backed Windows launches a slightly longer window because
			// npm/cmd shims can fail asynchronously after the initial spawn succeeds.
			setTimeout(() => {
				if (!settled) {
					settled = true;
					resolve();
				}
			}, startupFailureWindowMs);
		});
	} finally {
		proc.stderr?.off("data", onStartupStderr);
	}

	// Re-attach the permanent error handler now that we've passed the danger zone
	_attachErrorHandler(proc, command, {
		command: spawnCommand,
		args,
		cwd,
		pid: proc.pid ?? 0,
	});
	unrefLspProcessHandles(proc);

	return {
		process: proc,
		stdin: proc.stdin,
		stdout: proc.stdout,
		stderr: proc.stderr,
		pid: proc.pid ?? 0,
		command: spawnCommand,
		args,
	};
}

/**
 * Spawn via Node.js directly
 */
export async function launchViaNode(
	scriptPath: string,
	args: string[] = [],
	options: SpawnOptions = {},
): Promise<LSPProcess> {
	return launchLSP(process.execPath, [scriptPath, ...args], options);
}

/**
 * Spawn via Python module
 */
export async function launchViaPython(
	moduleName: string,
	args: string[] = [],
	options: SpawnOptions = {},
): Promise<LSPProcess> {
	// On Windows, prefer 'py' launcher, fall back to 'python'
	const pythonCmd = process.platform === "win32" ? "py" : "python3";
	return launchLSP(pythonCmd, ["-m", moduleName, ...args], options);
}

/**
 * Stop an LSP process gracefully
 */
export async function stopLSP(handle: LSPProcess): Promise<void> {
	if (handle.process.exitCode !== null || handle.process.signalCode !== null) {
		return;
	}

	return new Promise((resolve) => {
		let settled = false;
		let forceTimeout: ReturnType<typeof setTimeout> | undefined;
		let giveUpTimeout: ReturnType<typeof setTimeout> | undefined;

		const done = () => {
			if (settled) return;
			settled = true;
			if (forceTimeout) clearTimeout(forceTimeout);
			if (giveUpTimeout) clearTimeout(giveUpTimeout);
			handle.process.off("exit", done);
			handle.process.off("error", done);
			resolve();
		};

		handle.process.once("exit", done);
		handle.process.once("error", done);

		const killWindowsTree = (): boolean => {
			if (!isWindows) return false;
			// If our child has already exited, its PID is dead and the OS may have
			// RECYCLED it to an unrelated process. `taskkill /F /T` on a recycled PID
			// force-kills that process AND its whole tree — in the test suite this
			// occasionally nuked a vitest worker fork ("Worker exited unexpectedly",
			// no fatal dump, e.g. via the "stopLSP after the process already exited"
			// path); in production it could kill an unrelated user process. Never
			// tree-kill a PID we no longer own — fall back to handle.process.kill(),
			// which on Windows signals via the retained process HANDLE (not the raw
			// PID), so it's a safe no-op on an already-exited child.
			//
			// #2042 folded the sign check and this exited check into the one
			// ownership predicate every kill-by-raw-pid now shares; the handle
			// arm below IS this paragraph, and on Windows it is the only
			// ownership evidence available (there is no /proc to read).
			if (!isOwnLiveChild(handle.pid, "lsp-stop-windows-tree", handle.process))
				return false;
			try {
				// Absolute path avoids PATH-resolution substitution on Windows.
				const taskkill = windowsExe("taskkill.exe");
				const killer = nodeSpawn(
					taskkill,
					["/F", "/T", "/PID", String(handle.pid)],
					{
						shell: false,
						windowsHide: true,
					},
				);
				killer.once("error", done);
				return true;
			} catch {
				return false;
			}
		};

		try {
			// On Windows, kill the tree first; killing the direct child can orphan
			// grandchildren (e.g. tsserver.js behind a cmd/npm shim).
			if (!killWindowsTree()) {
				handle.process.kill("SIGTERM");
			}
		} catch {
			done();
			return;
		}

		forceTimeout = setTimeout(() => {
			if (settled) return;
			try {
				if (!killWindowsTree()) {
					handle.process.kill("SIGKILL");
				}
			} catch {
				done();
				return;
			}
			// If the process had already exited before listeners were attached, no
			// exit event will arrive. Resolve rather than hanging test cleanup forever.
			giveUpTimeout = setTimeout(done, 500);
		}, 5000);
	});
}
