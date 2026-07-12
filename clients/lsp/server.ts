/**
 * LSP Server Definitions for pi-lens
 *
 * Defines 40+ language servers with:
 * - Root detection (monorepo support)
 * - Auto-installation strategies
 * - Platform-specific handling
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import {
	access,
	appendFile,
	mkdir,
	readFile,
	readdir,
	stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "../deps/minimatch.js";
import { isTestMode } from "../env-utils.js";
import { getGlobalPiLensDir } from "../file-utils.js";
import { KIND_EXTENSIONS } from "../file-kinds.js";
import { isAtOrAboveHomeDir } from "../path-utils.js";
import {
	ensureTool,
	getToolEnvironment,
	getToolPath,
} from "../installer/index.js";
import { resolveOpengrepConfig } from "../opengrep-config.js";
import { resolveZizmorGitHubToken } from "../zizmor-config.js";
import { logLatency } from "../latency-logger.js";
import { findLocalSgconfig, resolveBaselineSgconfig } from "../sgconfig.js";
import { resolveAstGrepNativeExe } from "./server-strategies.js";
import { isCommandAvailableAsync, safeSpawnAsync } from "../safe-spawn.js";
import { type LSPProcess, launchLSP } from "./launch.js";
import { createLombokJdtlsArgs } from "./lombok.js";
import { resolveJavaRuntimeEnv } from "./jvm-runtime.js";
import { normalizeMapKey } from "./path-utils.js";

// --- Types ---

export type RootFunction = (file: string) => Promise<string | undefined>;

export interface LSPSpawnOptions {
	allowInstall?: boolean;
}

export interface LSPServerInfo {
	id: string;
	name: string;
	extensions: readonly string[];
	root: RootFunction;
	/**
	 * "language" (default) = the file's primary language server (one is chosen per
	 * file). "auxiliary" = a cross-cutting, diagnostic-only server (security,
	 * spelling, …) that attaches across many languages and runs ALONGSIDE the
	 * primary — never selected as primary, collected only on the with-auxiliary
	 * diagnostics path. See clients/dispatch/auxiliary-lsp.ts.
	 */
	role?: "language" | "auxiliary";
	/** Simple command name whose absence disables spawn attempts briefly across roots. */
	availabilityKey?: string;
	/**
	 * Optional per-server initialize timeout.
	 * Useful for servers like Ruby LSP that do real project bootstrap work
	 * before they can answer initialize.
	 */
	initializeTimeoutMs?: number;
	/**
	 * Optional per-server wait budget for navigation requests that need a client
	 * to become ready first.
	 */
	clientWaitTimeoutMs?: number;
	/**
	 * Server recomputes/pushes dependent-file diagnostics after primary file changes.
	 * Cascade can read its passive snapshot instead of actively touching neighbors.
	 */
	autoPropagateDiagnostics?: boolean;
	spawn(
		root: string,
		options?: LSPSpawnOptions,
	): Promise<
		| {
				process: LSPProcess;
				initialization?: Record<string, unknown>;
				source?: "direct" | "managed" | "package-manager" | "interactive";
				/**
				 * Which concrete binary/protocol variant was launched for this server
				 * id, when a single `LSPServerInfo.id` can mean more than one actual
				 * server (e.g. "typescript" = classic typescript-language-server OR
				 * TS7's native `tsc --lsp --stdio`). Per-server behavioral knowledge
				 * keyed by server id (`server-strategies.ts`'s `silentOnClean` etc.)
				 * is only proven for the variant it was measured against — this lets
				 * such knowledge-consumers (the #458 cascade tier classifier) tell
				 * the variants apart. Undefined = single-variant server, or a
				 * variant-carrying server that hasn't been updated to report one yet;
				 * treat as the classic/default behavior (fail-safe).
				 */
				launchVariant?: "classic" | "native-ts7";
		  }
		| undefined
	>;
	autoInstall?: () => Promise<boolean>;
}

function isLspInstallDisabled(): boolean {
	return process.env.PI_LENS_DISABLE_LSP_INSTALL === "1";
}

function canInstall(allowInstall?: boolean): boolean {
	return allowInstall !== false && !isLspInstallDisabled();
}

function isCommandNotFoundError(error: unknown): boolean {
	const msg = String(error);
	return (
		msg.includes("not found") ||
		msg.includes("ENOENT") ||
		msg.includes("not recognized")
	);
}

const DIRECT_LSP_NEGATIVE_TTL_MS = Math.max(
	30_000,
	Number.parseInt(
		process.env.PI_LENS_DIRECT_LSP_NEGATIVE_TTL_MS ?? "600000",
		10,
	) || 600_000,
);
const directLspCommandUnavailableUntil = new Map<string, number>();
const directLspCommandSkipLoggedUntil = new Map<string, number>();

function isSimpleCommand(command: string): boolean {
	return (
		!path.isAbsolute(command) &&
		!command.includes("/") &&
		!command.includes("\\")
	);
}

export function isDirectLspCommandTemporarilyUnavailable(
	command: string,
): boolean {
	const until = directLspCommandUnavailableUntil.get(command);
	if (!until || until <= Date.now()) {
		directLspCommandUnavailableUntil.delete(command);
		return false;
	}
	const loggedUntil = directLspCommandSkipLoggedUntil.get(command) ?? 0;
	if (loggedUntil <= Date.now()) {
		logSessionStart(
			`lsp direct command ${command}: skipped by negative availability cache (${Math.max(0, until - Date.now())}ms remaining)`,
		);
		directLspCommandSkipLoggedUntil.set(command, until);
	}
	return true;
}

function markDirectLspCommandUnavailable(command: string): void {
	if (!isSimpleCommand(command)) return;
	directLspCommandUnavailableUntil.set(
		command,
		Date.now() + DIRECT_LSP_NEGATIVE_TTL_MS,
	);
	directLspCommandSkipLoggedUntil.delete(command);
}

const SESSIONSTART_LOG_DIR = getGlobalPiLensDir();
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");
const PI_LENS_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");

function logSessionStart(message: string): void {
	if (isTestMode()) {
		return;
	}
	const line = `[${new Date().toISOString()}] ${message}\n`;
	mkdir(SESSIONSTART_LOG_DIR, { recursive: true })
		.then(() => appendFile(SESSIONSTART_LOG, line))
		.catch(() => {
			// best-effort logging
		});
}

// ---------------------------------------------------------------------------
// Unified binary resolution + launch
// ---------------------------------------------------------------------------
//
// Replaces the four ad-hoc patterns (launchWithDirectOrPackageManager,
// spawnWithInteractiveInstall, manual ensureTool chains, installPolicy enum).
//
// Resolution chain (first match wins):
//   1. Explicit candidates (project node_modules, full paths)
//   2. System PATH (bare command name)
//   3. ensureTool() — managed npm/pip install via installer registry
//   4. runtimeInstall — language-native install (go install, gem install, …)
//   5. [future] github — platform binary download
//
// All steps are silent and gated by canInstall(). Returns undefined if no
// binary can be found or installed.

export interface ResolveAndLaunchSpec {
	/** Ordered list of full paths / bare commands to try first */
	candidates: string[];
	/** LSP args to pass on launch */
	args: string[];
	/** Working directory */
	cwd: string;
	/** Optional env overrides */
	env?: NodeJS.ProcessEnv;
	/** installer tool ID — checked/installed via ensureTool() */
	managedToolId?: string;
	/** Runtime install: check this command is on PATH, then run installer */
	runtimeInstall?: {
		runtimeCommand: string;
		install: () => Promise<boolean>;
		/** After a successful install, retry these candidates (defaults to spec.candidates) */
		retryCandidates?: string[];
	};
}

export async function resolveAndLaunch(
	spec: ResolveAndLaunchSpec,
	allowInstall: boolean | undefined,
): Promise<
	| { process: LSPProcess; source: "direct" | "managed" | "package-manager" }
	| undefined
> {
	const toolLabel =
		spec.managedToolId ??
		spec.candidates[spec.candidates.length - 1] ??
		"unknown";
	let lastRuntimeFailure: Error | undefined;
	const trackRuntimeFailure = (err: unknown): void => {
		const message = err instanceof Error ? err.message : String(err);
		if (!isCommandNotFoundError(message)) {
			lastRuntimeFailure = err instanceof Error ? err : new Error(message);
		}
	};

	// A candidate that fails while a LATER candidate (or managed install)
	// succeeds is just fallback, not a failure — logging each immediately floods
	// the logs with scary "candidate failed / npm shim failed / Run npm install"
	// lines that read as smells even though the launch succeeded. Collect them and
	// surface only if ALL direct candidates fail.
	const candidateFailures: Array<{
		index: number;
		command: string;
		message: string;
		err: unknown;
	}> = [];

	// Step 1 & 2 — try all explicit candidates (includes bare command = PATH lookup)
	for (const [index, command] of spec.candidates.entries()) {
		logLatency({
			type: "phase",
			phase: "lsp_launch_candidate_attempt",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: toolLabel,
				command,
				index,
				totalCandidates: spec.candidates.length,
				allowInstall: canInstall(allowInstall),
			},
		});
		logSessionStart(
			`lsp launch candidate attempt tool=${toolLabel} idx=${index}/${spec.candidates.length - 1} command=${command} cwd=${spec.cwd}`,
		);
		try {
			const proc = await launchLSP(command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
			});
			logLatency({
				type: "phase",
				phase: "lsp_launch_candidate_success",
				filePath: spec.cwd,
				durationMs: 0,
				metadata: {
					tool: toolLabel,
					command,
					index,
					source: "direct",
				},
			});
			logSessionStart(
				`lsp launch candidate success tool=${toolLabel} idx=${index} command=${command} source=direct`,
			);
			return { process: proc, source: "direct" };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Defer logging: only a failure if no later candidate/install succeeds.
			candidateFailures.push({ index, command, message, err });
			// try next
		}
	}

	// All direct candidates failed (a successful one returns above). Surface the
	// deferred failures now so the all-failed case stays fully diagnosable.
	for (const failure of candidateFailures) {
		logLatency({
			type: "phase",
			phase: "lsp_launch_candidate_failed",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: toolLabel,
				command: failure.command,
				index: failure.index,
				error: failure.message,
			},
		});
		logSessionStart(
			`lsp launch candidate failed tool=${toolLabel} idx=${failure.index} command=${failure.command} error=${failure.message}`,
		);
		trackRuntimeFailure(failure.err);
	}

	if (!canInstall(allowInstall)) {
		logSessionStart(
			`lsp launch install blocked tool=${toolLabel} cwd=${spec.cwd} allowInstall=${allowInstall !== false} globalDisabled=${isLspInstallDisabled()}`,
		);
		logLatency({
			type: "phase",
			phase: "lsp_launch_install_blocked",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: toolLabel,
				allowInstall,
				globalInstallDisabled: isLspInstallDisabled(),
			},
		});
		return undefined;
	}

	// Step 3 — managed install via installer registry
	if (spec.managedToolId) {
		logSessionStart(
			`lsp launch ensure-tool start tool=${spec.managedToolId} cwd=${spec.cwd}`,
		);
		const installed = await ensureTool(spec.managedToolId);
		logSessionStart(
			`lsp launch ensure-tool result tool=${spec.managedToolId} installed=${installed ? "yes" : "no"} path=${installed ?? ""}`,
		);
		logLatency({
			type: "phase",
			phase: "lsp_launch_ensure_tool_result",
			filePath: spec.cwd,
			durationMs: 0,
			metadata: {
				tool: spec.managedToolId,
				installed: Boolean(installed),
				path: installed,
			},
		});
		if (installed) {
			try {
				const proc = await launchLSP(installed, spec.args, {
					cwd: spec.cwd,
					env: spec.env,
				});
				logSessionStart(
					`lsp launch managed success tool=${spec.managedToolId} command=${installed} source=managed`,
				);
				logLatency({
					type: "phase",
					phase: "lsp_launch_managed_success",
					filePath: spec.cwd,
					durationMs: 0,
					metadata: {
						tool: spec.managedToolId,
						command: installed,
					},
				});
				return { process: proc, source: "managed" };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logSessionStart(
					`lsp launch managed failed tool=${spec.managedToolId} command=${installed} error=${message}`,
				);
				logLatency({
					type: "phase",
					phase: "lsp_launch_managed_failed",
					filePath: spec.cwd,
					durationMs: 0,
					metadata: {
						tool: spec.managedToolId,
						command: installed,
						error: message,
					},
				});
				trackRuntimeFailure(err);

				// force-reinstall: when a PATH-resolved tool (bare command name)
				// fails to launch (e.g. broken symlink, missing .dll), nuke the
				// caches and download a managed copy from the registry.
				const looksPathResolved =
					!installed.includes("/") && !installed.includes("\\");
				if (looksPathResolved) {
					logSessionStart(
						`lsp launch managed retry force-reinstall tool=${spec.managedToolId}`,
					);
					const reinstalled = await ensureTool(spec.managedToolId, {
						forceReinstall: true,
					});
					if (reinstalled) {
						try {
							const proc = await launchLSP(reinstalled, spec.args, {
								cwd: spec.cwd,
								env: spec.env,
							});
							logSessionStart(
								`lsp launch managed force-reinstall success tool=${spec.managedToolId} command=${reinstalled}`,
							);
							logLatency({
								type: "phase",
								phase: "lsp_launch_managed_force_reinstall_success",
								filePath: spec.cwd,
								durationMs: 0,
								metadata: {
									tool: spec.managedToolId,
									command: reinstalled,
								},
							});
							return { process: proc, source: "managed" };
						} catch (retryErr) {
							logSessionStart(
								`lsp launch managed force-reinstall failed tool=${spec.managedToolId} error=${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
							);
						}
					}
				}
				// fall through
			}
		}
	}

	// Step 4 — language-native runtime install (go install, gem install, …)
	if (
		spec.runtimeInstall &&
		(await isOnPath(spec.runtimeInstall.runtimeCommand))
	) {
		const ok = await spec.runtimeInstall.install();
		if (ok) {
			const retry = spec.runtimeInstall.retryCandidates ?? spec.candidates;
			for (const command of retry) {
				try {
					const proc = await launchLSP(command, spec.args, {
						cwd: spec.cwd,
						env: spec.env,
					});
					return { process: proc, source: "managed" };
				} catch (err) {
					trackRuntimeFailure(err);
					// try next
				}
			}
		}
	}

	if (lastRuntimeFailure) {
		throw lastRuntimeFailure;
	}

	return undefined;
}

interface BundledServerLaunchSpec {
	/** Runtime interpreters to try, in order (first on PATH wins), e.g.
	 *  ["pwsh", "powershell"]. The bundle is launched THROUGH this runtime. */
	runtimeCandidates: string[];
	/** Managed archive TREE-BUNDLE tool id (installStrategy "archive", no
	 *  launcher); resolves to the extracted bundle directory. */
	bundleToolId: string;
	cwd: string;
	/** Build the runtime args from the resolved bundle directory. */
	args: (bundleDir: string) => string[];
	env?: Record<string, string>;
}

/**
 * Launch a language server that ships as a multi-folder MODULE BUNDLE driven by a
 * separate runtime (e.g. PowerShell Editor Services via `pwsh ...
 * Start-EditorServices.ps1 -Stdio`), rather than a single executable on PATH.
 *
 * Resolution order: (1) a runtime interpreter must be on PATH — else GRACEFUL
 * SKIP (returns undefined → the runner's coverage notice, never a hard fail);
 * (2) the bundle must be installed (already-extracted, or installed now when
 * `allowInstall`) — else graceful skip; (3) launch the runtime against the
 * bundle over stdio. A launch failure is logged and also degrades to a skip.
 */
async function resolveAndLaunchBundle(
	spec: BundledServerLaunchSpec,
	allowInstall: boolean | undefined,
): Promise<{ process: LSPProcess; source: "managed" } | undefined> {
	// 1. Resolve the runtime interpreter on PATH (don't spawn it bare — that would
	// hang; just probe). No runtime → graceful skip (coverage notice).
	let runtime: string | undefined;
	for (const candidate of spec.runtimeCandidates) {
		if (await isOnPath(candidate)) {
			runtime = candidate;
			break;
		}
	}
	if (!runtime) {
		logSessionStart(
			`lsp launch bundle skip tool=${spec.bundleToolId}: no runtime on PATH (tried ${spec.runtimeCandidates.join(", ")})`,
		);
		return undefined;
	}

	// 2. Resolve the bundle directory: already installed, else install when allowed.
	let bundleDir = await getToolPath(spec.bundleToolId);
	if (!bundleDir && canInstall(allowInstall)) {
		bundleDir = await ensureTool(spec.bundleToolId);
	}
	if (!bundleDir) {
		logSessionStart(
			`lsp launch bundle skip tool=${spec.bundleToolId}: bundle not installed (allowInstall=${allowInstall !== false})`,
		);
		return undefined;
	}

	// 3. Launch the runtime against the bundle over stdio.
	try {
		const proc = await launchLSP(runtime, spec.args(bundleDir), {
			cwd: spec.cwd,
			env: spec.env,
		});
		logSessionStart(
			`lsp launch bundle success tool=${spec.bundleToolId} runtime=${runtime} bundle=${bundleDir}`,
		);
		return { process: proc, source: "managed" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logSessionStart(
			`lsp launch bundle failed tool=${spec.bundleToolId} runtime=${runtime} error=${message}`,
		);
		return undefined;
	}
}

interface TreeBinaryLaunchSpec {
	/** PATH candidates to try FIRST — a user/system install wins (fast, already
	 *  on PATH), e.g. ["clangd"]. */
	candidates: string[];
	/** Managed archive TREE-BUNDLE tool id (installStrategy "archive", no
	 *  launcher); resolves to the extracted bundle directory. */
	bundleToolId: string;
	/** Path to the executable INSIDE the bundle, relative + POSIX-separated,
	 *  WITHOUT the platform suffix (".exe" is appended on win32), e.g.
	 *  "bin/clangd". */
	binRelPath: string;
	cwd: string;
	args: string[];
	env?: Record<string, string>;
}

/**
 * Launch a language server that ships as a self-contained native TREE BUNDLE with
 * its executable INSIDE the extracted tree (e.g. clangd: `<bundle>/bin/clangd`
 * plus the bundled libclang headers under `lib/`), as opposed to a single binary
 * on PATH or a runtime-driven module bundle (see {@link resolveAndLaunchBundle}).
 *
 * Resolution order: (1) PATH candidates first — a system install wins; (2) the
 * managed bundle (already-extracted, or installed now when `allowInstall`), then
 * launch the bin within it. No external runtime. Anything missing → GRACEFUL SKIP
 * (returns undefined → the runner's coverage notice, never a hard fail).
 */
async function resolveAndLaunchTreeBinary(
	spec: TreeBinaryLaunchSpec,
	allowInstall: boolean | undefined,
): Promise<{ process: LSPProcess; source: "direct" | "managed" } | undefined> {
	// 1. PATH-first — a system install wins (user-managed, no 150MB download).
	for (const command of spec.candidates) {
		try {
			const proc = await launchLSP(command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
			});
			return { process: proc, source: "direct" };
		} catch {
			// not on PATH (or broken) — fall through to the managed bundle
		}
	}

	// 2. Managed tree bundle: already-extracted, else install when allowed.
	let bundleDir = await getToolPath(spec.bundleToolId);
	if (!bundleDir && canInstall(allowInstall)) {
		bundleDir = await ensureTool(spec.bundleToolId);
	}
	if (!bundleDir) {
		logSessionStart(
			`lsp launch tree-bin skip tool=${spec.bundleToolId}: not on PATH and bundle not installed (allowInstall=${allowInstall !== false})`,
		);
		return undefined;
	}

	const suffix = process.platform === "win32" ? ".exe" : "";
	const binPath = path.join(bundleDir, ...spec.binRelPath.split("/")) + suffix;
	try {
		const proc = await launchLSP(binPath, spec.args, {
			cwd: spec.cwd,
			env: spec.env,
		});
		logSessionStart(
			`lsp launch tree-bin success tool=${spec.bundleToolId} bin=${binPath}`,
		);
		return { process: proc, source: "managed" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logSessionStart(
			`lsp launch tree-bin failed tool=${spec.bundleToolId} bin=${binPath} error=${message}`,
		);
		return undefined;
	}
}

function nodeBinCandidates(root: string, baseName: string): string[] {
	const localBase = path.join(root, "node_modules", ".bin", baseName);
	if (process.platform === "win32") {
		return [`${localBase}.cmd`, `${localBase}.exe`, baseName];
	}
	return [localBase, baseName];
}

function normalizeSlashKey(value: string): string {
	const normalized = path.resolve(value).replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function piAgentExtensionsRootKey(file: string): string | undefined {
	const dirKey = normalizeSlashKey(path.dirname(path.resolve(file)));
	const marker = "/.pi/agent/extensions";
	const index = dirKey.indexOf(marker);
	if (index === -1) return undefined;
	return dirKey.slice(0, index + marker.length);
}

function normalizeRootKey(root: string): string {
	return process.platform === "win32"
		? path.resolve(root).toLowerCase()
		: path.resolve(root);
}

function IgnoreHomeRoot(primary: RootFunction): RootFunction {
	const homeKey = normalizeRootKey(os.homedir());
	return async (file: string): Promise<string | undefined> => {
		const root = await primary(file);
		if (!root) return undefined;
		return normalizeRootKey(root) === homeKey ? undefined : root;
	};
}

function rubyBinCandidates(baseName: string): string[] {
	const candidates: string[] = [];
	const home = os.homedir();
	const isWin = process.platform === "win32";
	const ext = isWin ? ".bat" : "";

	// mise and asdf version managers — same layout on all platforms
	candidates.push(
		path.join(
			home,
			".local",
			"share",
			"mise",
			"installs",
			"ruby",
			"bin",
			`${baseName}${ext}`,
		),
	);
	candidates.push(
		path.join(home, ".asdf", "installs", "ruby", "bin", `${baseName}${ext}`),
	);

	if (isWin) {
		// Ruby installer drops versioned dirs on C: by convention, but the drive
		// and version suffix vary — scan what's actually present instead of hardcoding
		const driveRoot = path.parse(home).root; // e.g. "C:\"
		try {
			const entries = readdirSync(driveRoot);
			for (const entry of entries) {
				if (/^ruby\d/i.test(entry)) {
					candidates.push(
						path.join(driveRoot, entry, "bin", `${baseName}.bat`),
					);
					candidates.push(path.join(driveRoot, entry, "bin", baseName));
				}
			}
		} catch {
			// drive root not readable — skip
		}
	}

	return candidates;
}

type InitializationConfig = Record<string, unknown>;

interface InteractiveServerSpec {
	id: string;
	name: string;
	extensions: readonly string[];
	root: RootFunction;
	language: string;
	command: string | ((root: string) => string);
	args?: string[] | ((root: string) => string[]);
	initialization?:
		| InitializationConfig
		| ((root: string) => InitializationConfig);
	/**
	 * Language-runtime dependency to resolve before launch (#241). The server's
	 * binary is itself run by this runtime (jdtls → java); when the runtime isn't
	 * on PATH, a discovered install is injected into the spawn env instead of
	 * silently failing. Currently only "java" (jdtls).
	 */
	runtime?: "java";
}

function createInteractiveServer(spec: InteractiveServerSpec): LSPServerInfo {
	return {
		id: spec.id,
		name: spec.name,
		extensions: spec.extensions,
		root: spec.root,
		availabilityKey:
			typeof spec.command === "string" && isSimpleCommand(spec.command)
				? spec.command
				: undefined,
		async spawn(root) {
			const command =
				typeof spec.command === "function" ? spec.command(root) : spec.command;
			const args =
				typeof spec.args === "function" ? spec.args(root) : spec.args || [];
			// Try to launch directly — no auto-install for language-runtime tools
			// (C#, Java, Swift, etc. require their SDK; cannot npm/pip install them)
			if (
				isSimpleCommand(command) &&
				isDirectLspCommandTemporarilyUnavailable(command)
			) {
				return undefined;
			}
			// #241: the server binary is run by a language runtime (jdtls → java).
			// When that runtime isn't on PATH, inject a discovered install's env so
			// it launches instead of silently failing with no_clients.
			const runtimeEnv =
				spec.runtime === "java" ? await resolveJavaRuntimeEnv() : undefined;
			try {
				const proc = await launchLSP(command, args, {
					cwd: root,
					...(runtimeEnv ? { env: runtimeEnv } : {}),
				});
				const initialization =
					typeof spec.initialization === "function"
						? spec.initialization(root)
						: spec.initialization;
				return { process: proc, source: "direct", initialization };
			} catch (err) {
				if (isCommandNotFoundError(err)) {
					markDirectLspCommandUnavailable(command);
				}
				return undefined;
			}
		},
	};
}

export function PriorityRoot(
	markerGroups: string[][],
	excludePatterns?: string[],
	stopDir?: string,
): RootFunction {
	const resolvers = markerGroups.map((markers) =>
		NearestRoot(markers, excludePatterns, stopDir),
	);
	return async (file: string) => {
		for (const resolve of resolvers) {
			const root = await resolve(file);
			if (root) return root;
		}
		return undefined;
	};
}

export const FileDirRoot: RootFunction = async (file: string) =>
	path.resolve(path.dirname(file));

export function RootWithFallback(
	primary: RootFunction,
	fallback: RootFunction = FileDirRoot,
): RootFunction {
	return async (file: string): Promise<string | undefined> => {
		const primaryRoot = await primary(file);
		if (primaryRoot) return primaryRoot;
		return fallback(file);
	};
}

export function WorkspacePriorityRoot(
	markerGroups: string[][],
	excludePatterns?: string[],
): RootFunction {
	return async (file: string) =>
		PriorityRoot(markerGroups, excludePatterns, process.cwd())(file);
}

function isPermissionFsError(err: unknown): boolean {
	const code = (err as { code?: unknown })?.code;
	return code === "EACCES" || code === "EPERM";
}

async function markerExists(dir: string, pattern: string): Promise<boolean> {
	if (!pattern.includes("*")) {
		try {
			await stat(path.join(dir, pattern));
			return true;
		} catch (err) {
			if (isPermissionFsError(err)) {
				logSessionStart(
					`lsp root marker skipped: permission error stat ${path.join(dir, pattern)}`,
				);
			}
			return false;
		}
	}

	const normalized = pattern.replace(/\\/g, "/");
	const slash = normalized.lastIndexOf("/");
	const parentPattern = slash >= 0 ? normalized.slice(0, slash) : "";
	const basenamePattern = slash >= 0 ? normalized.slice(slash + 1) : normalized;
	if (!basenamePattern) return false;
	const targetDir = parentPattern
		? path.join(dir, ...parentPattern.split("/").filter(Boolean))
		: dir;
	try {
		const entries = await readdir(targetDir, { withFileTypes: true });
		// Match files/symlinks only — a directory named like the marker (e.g. a
		// `Foo.csproj/` dir) is not a project file. Case-insensitive on win32 to
		// match the filesystem (and the project ignore matcher), via minimatch.
		return entries.some(
			(entry) =>
				(entry.isFile() || entry.isSymbolicLink()) &&
				minimatch(entry.name, basenamePattern, {
					dot: true,
					nocase: process.platform === "win32",
				}),
		);
	} catch (err) {
		if (isPermissionFsError(err)) {
			logSessionStart(
				`lsp root marker skipped: permission error read ${targetDir}`,
			);
		}
		return false;
	}
}

// --- Root Detection Helpers ---

// --- Interactive Install Helper ---

/**
 * Walk up the directory tree looking for project root markers.
 *
 * NearestRoot(includePatterns, excludePatterns?) → RootFunction
 *
 * - includePatterns: file/dir names that signal the project root (e.g. ["package.json"])
 * - excludePatterns: if any of these exist in a directory, skip it (e.g. ["node_modules"])
 * - stopDir: walk stops here (defaults to filesystem root; set to project cwd for safety)
 *
 * Equivalent to createRootDetector; exported under both names for clarity.
 */
export function NearestRoot(
	includePatterns: string[],
	excludePatterns?: string[],
	stopDir?: string,
): RootFunction {
	// Per-instance caches — each NearestRoot(markers) call gets its own Map so
	// different servers (e.g. TypeScript vs Go) with different marker sets never
	// share entries. vi.resetModules() in tests resets module state between cases.
	const cache = new Map<string, string>();
	const inFlight = new Map<string, Promise<string | undefined>>();

	return async (file: string): Promise<string | undefined> => {
		// Cache key is the resolved directory — all files in the same dir share a root.
		const startDir = path.resolve(path.dirname(file));
		const dirKey = normalizeMapKey(startDir);

		// Fast path: already resolved for this directory.
		const cached = cache.get(dirKey);
		if (cached !== undefined) return cached;

		// In-flight deduplication: if N parallel pipelines edit files in the same
		// directory simultaneously, only one stat-walk runs; the rest await the same
		// promise. This is the main fix for parallel-turn LSP timeout spikes.
		const flying = inFlight.get(dirKey);
		if (flying) return flying;

		const promise = (async (): Promise<string | undefined> => {
			let currentDir = startDir;
			const fsRoot = path.parse(currentDir).root;
			const stop = stopDir ? path.resolve(stopDir) : fsRoot;

			while (true) {
				if (
					stop !== fsRoot &&
					currentDir.startsWith(stop + path.sep) === false &&
					currentDir !== stop
				) {
					break;
				}

				// Check exclude patterns — skip this dir (but keep walking up)
				if (excludePatterns) {
					let excluded = false;
					for (const pattern of excludePatterns) {
						if (await markerExists(currentDir, pattern)) {
							excluded = true;
							break;
						}
					}
					if (excluded) {
						currentDir = path.dirname(currentDir);
						continue;
					}
				}

				// Check include patterns. Exact marker names stay cheap (`stat`), while
				// glob markers like `*.csproj` match real project filenames (#201).
				for (const pattern of includePatterns) {
					if (await markerExists(currentDir, pattern)) return currentDir;
				}

				if (currentDir === stop || currentDir === fsRoot) {
					break;
				}

				currentDir = path.dirname(currentDir);
			}

			return undefined;
		})();

		inFlight.set(dirKey, promise);
		try {
			const result = await promise;
			// Only cache successful hits. Undefined results are not cached so that
			// a newly-created root marker (e.g. package.json added mid-session) is
			// detected on the next call.
			if (result !== undefined) cache.set(dirKey, result);
			return result;
		} finally {
			inFlight.delete(dirKey);
		}
	};
}

/** Alias kept for backward compatibility */
export const createRootDetector = NearestRoot;

// --- Runtime Tool Helpers ---

/**
 * Check if a command is available on system PATH.
 *
 * Async (was a blocking `spawnSync("where"/"which")`): runs on the spawn
 * fall-through path (Step 4, runtime-install gate). The shared
 * `isCommandAvailableAsync` spawns the same finder via `safeSpawnAsync` with a
 * 5s timeout, so a stalled finder can no longer freeze the loop. Semantics are
 * preserved: true iff the finder exits 0.
 */
function isOnPath(command: string): Promise<boolean> {
	return isCommandAvailableAsync(command);
}

/**
 * Try to install gopls via `go install`. Resolves true if the install succeeded.
 *
 * Async (was a blocking `spawnSync`): runs on the LSP runtime-install gate, off
 * the event loop. `ignoreAmbientSignal` keeps the install running to completion
 * even if the agent turn is interrupted, matching the old uncancellable sync
 * behaviour. Success semantics preserved: true iff the process exits 0.
 */
export async function tryGoInstallGopls(): Promise<boolean> {
	const isWindows = process.platform === "win32";
	const result = await safeSpawnAsync(
		isWindows ? "go.exe" : "go",
		["install", "golang.org/x/tools/gopls@latest"],
		{ timeout: 180000, ignoreAmbientSignal: true },
	);
	return !result.error && result.status === 0;
}

export async function tryDotnetToolInstall(tool: string): Promise<boolean> {
	mkdirSync(PI_LENS_BIN_DIR, { recursive: true });
	const result = await safeSpawnAsync(
		"dotnet",
		["tool", "install", "--tool-path", PI_LENS_BIN_DIR, tool],
		{ timeout: 180000, ignoreAmbientSignal: true },
	);
	if (!result.error && result.status === 0) return true;

	const stderr = result.stderr ?? "";
	if (stderr.includes("No NuGet sources are defined or enabled")) {
		logSessionStart(
			`lsp dotnet-install: NuGet sources missing — cannot install ${tool}. ` +
				`Run: dotnet nuget add source https://api.nuget.org/v3/index.json -n nuget.org`,
		);
		return false;
	}

	const updateResult = await safeSpawnAsync(
		"dotnet",
		["tool", "update", "--tool-path", PI_LENS_BIN_DIR, tool],
		{ timeout: 180000, ignoreAmbientSignal: true },
	);
	return !updateResult.error && updateResult.status === 0;
}

/**
 * Locate tsserver.js — tries local project, then pi-lens managed TypeScript.
 * Returns the path to tsserver.js, or undefined if not found.
 */
async function findTsserverPath(
	root: string,
	allowInstall: boolean | undefined,
): Promise<string | undefined> {
	const fs = await import("node:fs/promises");
	const candidates = [
		path.join(root, "node_modules", "typescript", "lib", "tsserver.js"),
		path.join(
			process.cwd(),
			"node_modules",
			"typescript",
			"lib",
			"tsserver.js",
		),
	];
	for (const p of candidates) {
		try {
			await fs.access(p);
			return p;
		} catch {
			/* not found */
		}
	}
	// Discover the typescript install (PATH / npm-global) even when install is
	// disabled; only the download is gated by allowInstall.
	const tscPath = await ensureTool("typescript", {
		allowInstall: canInstall(allowInstall),
	});
	if (tscPath) {
		for (const p of [
			path.join(
				path.dirname(tscPath),
				"..",
				"typescript",
				"lib",
				"tsserver.js",
			),
			path.join(
				path.dirname(tscPath),
				"..",
				"..",
				"typescript",
				"lib",
				"tsserver.js",
			),
		]) {
			try {
				await fs.access(p);
				return p;
			} catch {
				/* not found */
			}
		}
	}
	return undefined;
}

interface NativeTypeScriptLsp {
	command: string;
	version: string;
}

/**
 * TypeScript 7+ ships the native typescript-go language server through the
 * workspace-local `tsc --lsp --stdio` entrypoint and no longer includes
 * `lib/tsserver.js`. Resolve the nearest TypeScript package using normal
 * node_modules ancestor semantics so a monorepo package can use its hoisted
 * compiler, while never falling through to a PATH/global `tsc`.
 */
async function findNativeTypeScriptLsp(
	root: string,
): Promise<NativeTypeScriptLsp | undefined> {
	let currentDir = path.resolve(root);

	while (!isAtOrAboveHomeDir(currentDir)) {
		const typescriptDir = path.join(currentDir, "node_modules", "typescript");
		const packageJsonPath = path.join(typescriptDir, "package.json");

		let packageJsonText: string;
		try {
			packageJsonText = await readFile(packageJsonPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return undefined;
			}
			// A `node_modules/typescript/` directory that exists but has no
			// `package.json` is a malformed/partial install at THIS level, not an
			// absent one — stop here (fall back to classic) rather than walking up
			// to an ancestor, or a broken nearest install would let an unrelated
			// ancestor TS 7 binary silently shadow it (Copilot review, PR #526).
			try {
				const dirStat = await stat(typescriptDir);
				if (dirStat.isDirectory()) return undefined;
			} catch {
				/* typescript dir itself doesn't exist here — keep walking up */
			}
			const parent = path.dirname(currentDir);
			if (parent === currentDir) return undefined;
			currentDir = parent;
			continue;
		}

		let version: string;
		try {
			const parsed: unknown = JSON.parse(packageJsonText);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("version" in parsed) ||
				typeof parsed.version !== "string"
			) {
				return undefined;
			}
			version = parsed.version;
		} catch {
			return undefined;
		}

		// The nearest installed package shadows any ancestor TypeScript package,
		// matching Node/package-manager resolution. Never skip a local TS <=6 or
		// malformed install just to select an unrelated ancestor TS 7 binary.
		const majorText = version.split(".", 1)[0] ?? "";
		const major = /^\d+$/.test(majorText) ? Number(majorText) : Number.NaN;
		if (!Number.isFinite(major) || major < 7) return undefined;

		const localTsc = path.join(currentDir, "node_modules", ".bin", "tsc");
		const candidates =
			process.platform === "win32"
				? [`${localTsc}.cmd`, `${localTsc}.exe`, localTsc]
				: [localTsc];

		for (const command of candidates) {
			try {
				await access(command);
				return { command, version };
			} catch {
				/* not found */
			}
		}
		return undefined;
	}
	return undefined;
}

function dotnetToolCandidates(tool: string): string[] {
	const home = os.homedir();
	return [
		path.join(PI_LENS_BIN_DIR, `${tool}.exe`),
		path.join(PI_LENS_BIN_DIR, tool),
		path.join(home, ".dotnet", "tools", `${tool}.exe`),
		path.join(home, ".dotnet", "tools", tool),
		tool,
	].filter(Boolean);
}

/**
 * Both filename forms for a tool in a directory (`.exe` first on Windows). A
 * managed binary may carry the extension or not depending on how the toolchain
 * dropped it, so we try both.
 */
function binExeVariants(dir: string, tool: string): string[] {
	return process.platform === "win32"
		? [path.join(dir, `${tool}.exe`), path.join(dir, tool)]
		: [path.join(dir, tool)];
}

/**
 * Canonical-bin discovery (#241): a runtime-managed server can be installed yet
 * absent from the shell PATH — the toolchain drops it in a well-known dir the
 * user's PATH often omits (fresh installs, Windows, non-login shells). Returning
 * the bare command FIRST keeps PATH authoritative when it resolves; the explicit
 * dir paths are the fallback (and the post-`go install` retry target).
 *
 * Go: `$GOPATH/bin` (first GOPATH entry) or `~/go/bin` — where `go install` lands.
 */
export function goBinCandidates(tool: string): string[] {
	const gopath =
		process.env.GOPATH?.split(path.delimiter)[0] ||
		path.join(os.homedir(), "go");
	return [tool, ...binExeVariants(path.join(gopath, "bin"), tool)];
}

/** Rust: `$CARGO_HOME/bin` or `~/.cargo/bin` — cargo/rustup binaries + proxies. */
export function cargoBinCandidates(tool: string): string[] {
	const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
	return [tool, ...binExeVariants(path.join(cargoHome, "bin"), tool)];
}

/**
 * Try to install a gem to the pi-lens bin dir. Resolves true if the install succeeded.
 */
export async function tryGemInstall(gem: string): Promise<boolean> {
	const { join } = await import("node:path");
	const binDir = join(getGlobalPiLensDir(), "bin");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(binDir, { recursive: true });

	const result = await safeSpawnAsync(
		"gem",
		["install", gem, "--bindir", binDir, "--no-document"],
		{ timeout: 180000, ignoreAmbientSignal: true },
	);
	const ok = !result.error && result.status === 0;
	// Add binDir to PATH so subsequent lookups find the installed gem
	if (ok) {
		const sep = process.platform === "win32" ? ";" : ":";
		if (!process.env.PATH?.includes(binDir)) {
			process.env.PATH = `${binDir}${sep}${process.env.PATH ?? ""}`;
		}
	}
	return ok;
}

/**
 * Wraps a root function so it returns undefined for files inside a Deno project.
 * Prevents TypeScript LSP from being spawned alongside Deno LSP for the same file,
 * which would produce false diagnostics for Deno-specific APIs.
 */
export function DenoExcludeRoot(primary: RootFunction): RootFunction {
	const denoDetector = createRootDetector(["deno.json", "deno.jsonc"]);
	return async (file: string): Promise<string | undefined> => {
		const denoRoot = await denoDetector(file);
		if (denoRoot) return undefined;
		return primary(file);
	};
}

/**
 * Find the active Python interpreter inside the nearest virtual environment.
 * Search order: VIRTUAL_ENV → CONDA_PREFIX → .venv → venv (all under root).
 * Returns undefined when no venv python binary is found.
 */
export async function detectPythonVenv(
	root: string,
): Promise<string | undefined> {
	const isWin = process.platform === "win32";
	const candidates = [
		process.env.VIRTUAL_ENV,
		process.env.CONDA_PREFIX,
		path.join(root, ".venv"),
		path.join(root, "venv"),
	].filter((v): v is string => Boolean(v));

	for (const venv of candidates) {
		const pythonPath = isWin
			? path.join(venv, "Scripts", "python.exe")
			: path.join(venv, "bin", "python");
		try {
			await access(pythonPath);
			return pythonPath;
		} catch {
			// not found — try next candidate
		}
	}
	return undefined;
}

// --- Server Definitions ---

const JS_TS_LSP_EXTENSIONS = KIND_EXTENSIONS["jsts"].filter(
	(ext) => ext !== ".svelte" && ext !== ".vue",
);

// Marker set used for both the unbounded TypeScriptProjectRoot walk and the
// extension-bounded walk below. Kept in one place so both code paths look
// for the same project signals.
const TS_PROJECT_MARKERS = [
	"package-lock.json",
	"bun.lockb",
	"bun.lock",
	"pnpm-lock.yaml",
	"yarn.lock",
	"package.json",
] as const;

const TypeScriptProjectRoot = IgnoreHomeRoot(
	createRootDetector([...TS_PROJECT_MARKERS]),
);

/**
 * Walk up from the file's directory looking for a TypeScript project marker,
 * but stop at `extensionRootKey` so we never escape the .pi/agent/extensions
 * boundary into a higher-up project (e.g. ~/.pi/agent/package.json which
 * would pull every extension in the directory into one LSP workspace).
 *
 * Returns the nearest directory containing a marker, or undefined if none
 * is found between the file and the extensions root inclusive.
 */
async function findExtensionBoundedRoot(
	file: string,
	extensionRootKey: string,
): Promise<string | undefined> {
	const startDir = path.resolve(path.dirname(file));
	let currentDir = startDir;
	while (true) {
		for (const pattern of TS_PROJECT_MARKERS) {
			try {
				await stat(path.join(currentDir, pattern));
				return currentDir;
			} catch {
				/* not found, try next marker */
			}
		}
		// Stop at or beyond the extensions root — never walk into the
		// pi-agent-wide scope.
		const currentKey = normalizeSlashKey(currentDir);
		if (currentKey === extensionRootKey) return undefined;
		const parent = path.dirname(currentDir);
		if (parent === currentDir) return undefined;
		currentDir = parent;
	}
}

/**
 * Check whether the directory immediately containing the extensions folder
 * (i.e. `.pi/agent/`) holds any TypeScript project marker. This narrowly
 * detects the #123 scenario — pi itself installs a package.json at
 * `~/.pi/agent/` and the user's extension has none of its own — without
 * picking up accidental markers further up the filesystem.
 */
async function hasAgentLevelProjectMarker(
	extensionRootKey: string,
): Promise<boolean> {
	const agentDir = path.dirname(extensionRootKey);
	if (!agentDir || agentDir === extensionRootKey) return false;
	for (const pattern of TS_PROJECT_MARKERS) {
		try {
			await stat(path.join(agentDir, pattern));
			return true;
		} catch {
			/* not found, try next */
		}
	}
	return false;
}

const TypeScriptRoot: RootFunction = DenoExcludeRoot(async (file) => {
	const extensionRootKey = piAgentExtensionsRootKey(file);
	if (extensionRootKey) {
		// Bounded walk so we never adopt a parent (e.g. ~/.pi/agent/) as the
		// LSP root.
		const bounded = await findExtensionBoundedRoot(file, extensionRootKey);
		if (bounded) return bounded;
		// No marker inside the extension boundary. If pi itself has a
		// package.json at ~/.pi/agent/ (the #123 setup), the previous code
		// returned undefined and the LSP silently failed to start. Fall
		// back to a per-file scope so the LSP at least runs.
		if (await hasAgentLevelProjectMarker(extensionRootKey)) {
			return FileDirRoot(file);
		}
		// Truly loose extension file with no project context anywhere
		// relevant — preserve the existing skip behavior (LSP shouldn't
		// analyze a lone .ts file with no package.json above or below).
		return undefined;
	}
	const projectRoot = await TypeScriptProjectRoot(file);
	if (projectRoot) return projectRoot;
	return FileDirRoot(file);
});

export const TypeScriptServer: LSPServerInfo = {
	id: "typescript",
	name: "TypeScript Language Server",
	extensions: JS_TS_LSP_EXTENSIONS,
	autoPropagateDiagnostics: true,
	root: TypeScriptRoot,
	async spawn(root, options) {
		const fs = await import("node:fs/promises");
		const nativeLsp = await findNativeTypeScriptLsp(root);
		if (nativeLsp) {
			const env = await getToolEnvironment();
			logSessionStart(
				`lsp typescript-native: version=${nativeLsp.version} command=${nativeLsp.command}`,
			);
			const proc = await launchLSP(nativeLsp.command, ["--lsp", "--stdio"], {
				cwd: root,
				env,
			});
			return { process: proc, source: "direct", launchVariant: "native-ts7" };
		}

		let source: "direct" | "managed" = "direct";

		// TypeScript <=6 uses typescript-language-server + tsserver.js. Prefer a
		// project-local wrapper, then fall back to discovered/managed tooling.
		let lspPath: string | undefined;
		const localLsp = path.join(
			root,
			"node_modules",
			".bin",
			"typescript-language-server",
		);
		const localLspCmd = path.join(
			root,
			"node_modules",
			".bin",
			"typescript-language-server.cmd",
		);

		// Check for local version first (Windows .cmd first, then Unix)
		for (const checkPath of [localLspCmd, localLsp]) {
			try {
				await fs.access(checkPath);
				lspPath = checkPath;
				break;
			} catch {
				/* not found */
			}
		}

		// Fall back to a discovered or managed install. ensureTool() runs PATH /
		// npm-global discovery even when install is disabled (only the download is
		// gated by canInstall), so a globally-installed typescript-language-server
		// resolves even without a per-project node_modules/.bin entry.
		if (!lspPath) {
			lspPath = await ensureTool("typescript-language-server", {
				allowInstall: canInstall(options?.allowInstall),
			});
			if (lspPath) source = "managed";
			if (!lspPath) {
				return undefined;
			}
		}

		// Find tsserver.js — also try relative to the LSP binary for local installs
		let tsserverPath = await findTsserverPath(root, options?.allowInstall);
		if (!tsserverPath) {
			const localCandidate = path.join(
				path.dirname(lspPath),
				"..",
				"typescript",
				"lib",
				"tsserver.js",
			);
			try {
				await fs.access(localCandidate);
				tsserverPath = localCandidate;
			} catch {
				/* not found */
			}
		}
		if (tsserverPath) source = "managed";

		// Use absolute path and proper environment
		const env = await getToolEnvironment();
		const proc = await launchLSP(lspPath, ["--stdio"], {
			cwd: root,
			env: {
				...env,
				TSSERVER_PATH: tsserverPath,
			},
		});

		return {
			process: proc,
			source,
			initialization: tsserverPath
				? { tsserver: { path: tsserverPath } }
				: undefined,
			launchVariant: "classic",
		};
	},
};

export const DenoServer: LSPServerInfo = {
	id: "deno",
	name: "Deno Language Server",
	extensions: JS_TS_LSP_EXTENSIONS,
	autoPropagateDiagnostics: true,
	root: createRootDetector(["deno.json", "deno.jsonc"]),
	async spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["deno"],
				args: ["lsp"],
				cwd: root,
				managedToolId: "deno",
			},
			options?.allowInstall,
		);
	},
};

export const PythonServer: LSPServerInfo = {
	id: "python",
	name: "Pyright Language Server",
	extensions: KIND_EXTENSIONS["python"],
	root: RootWithFallback(
		createRootDetector([
			".git",
			"pyproject.toml",
			"setup.py",
			"setup.cfg",
			"requirements.txt",
			"Pipfile",
			"poetry.lock",
		]),
	),
	async spawn(root, options) {
		const env = await getToolEnvironment();
		let source: "direct" | "managed" | "package-manager" = "direct";

		// openFilesOnly: true — analyse only open files rather than the full workspace.
		// Avoids the 5–14 s cold-start on large projects caused by workspace-wide
		// analysis on startup. Deep type checking is still available via the standalone
		// pyright CLI runner that runs in parallel.
		const pyrightInit = (pythonPath?: string): Record<string, unknown> => ({
			...(pythonPath ? { pythonPath } : {}),
			openFilesOnly: true,
		});

		// Prefer pyright-langserver; basedpyright-langserver is a drop-in fork with
		// the same --stdio protocol and additional rules (e.g. reportUnusedExpression).
		const localCandidates = [
			...nodeBinCandidates(root, "pyright-langserver"),
			...nodeBinCandidates(root, "basedpyright-langserver"),
		];
		const direct = await resolveAndLaunch(
			{ candidates: localCandidates, args: ["--stdio"], cwd: root, env },
			false,
		);
		if (direct) {
			const pythonPath = await detectPythonVenv(root);
			return {
				process: direct.process,
				source: direct.source,
				initialization: pyrightInit(pythonPath),
			};
		}

		// Discover a globally-installed pyright even when install is disabled;
		// only the download is gated by canInstall.
		const pyrightPath = await ensureTool("pyright", {
			allowInstall: canInstall(options?.allowInstall),
		});
		if (!pyrightPath) return undefined;
		source = "managed";

		const binDir = path.dirname(pyrightPath);
		const isWindows = process.platform === "win32";
		const managedCandidates = isWindows
			? [
					path.join(binDir, "pyright-langserver.cmd"),
					path.join(binDir, "pyright-langserver"),
					"pyright-langserver",
				]
			: [path.join(binDir, "pyright-langserver"), "pyright-langserver"];

		const resolved = await resolveAndLaunch(
			{ candidates: managedCandidates, args: ["--stdio"], cwd: root, env },
			false,
		);
		if (!resolved) return undefined;

		const pythonPath = await detectPythonVenv(root);
		return {
			process: resolved.process,
			source,
			initialization: pyrightInit(pythonPath),
		};
	},
};

export const PythonJediServer: LSPServerInfo = {
	id: "python-jedi",
	name: "Jedi Language Server",
	extensions: KIND_EXTENSIONS["python"],
	root: RootWithFallback(
		createRootDetector([
			".git",
			"pyproject.toml",
			"setup.py",
			"setup.cfg",
			"requirements.txt",
			"Pipfile",
			"poetry.lock",
		]),
	),
	async spawn(root, options) {
		const launched = await resolveAndLaunch(
			{
				candidates: ["jedi-language-server"],
				args: [],
				cwd: root,
				managedToolId: "jedi-language-server",
			},
			options?.allowInstall,
		);
		if (!launched) return undefined;
		const pythonPath = await detectPythonVenv(root);
		return {
			...launched,
			initialization: pythonPath
				? { workspace: { environmentPath: pythonPath } }
				: {},
		};
	},
};

export const GoServer: LSPServerInfo = {
	id: "go",
	name: "gopls",
	extensions: KIND_EXTENSIONS["go"],
	root: RootWithFallback(
		WorkspacePriorityRoot([["go.work"], ["go.mod", "go.sum"], [".git"]]),
	),
	async spawn(root, options) {
		const result = await resolveAndLaunch(
			{
				// Canonical-bin discovery (#241): include $GOPATH/bin so a gopls that
				// `go install` dropped there resolves even when it isn't on PATH —
				// which is also the retry target after the runtimeInstall below.
				candidates: goBinCandidates("gopls"),
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "go",
					install: tryGoInstallGopls,
				},
			},
			options?.allowInstall,
		);
		if (!result) return undefined;
		return { ...result, initialization: { ui: { semanticTokens: true } } };
	},
};

async function hasWorkspaceSection(cargoPath: string): Promise<boolean> {
	try {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(cargoPath, "utf-8");
		return /^\s*\[workspace\]/m.test(content);
	} catch {
		return false;
	}
}

function RustWorkspaceRoot(): RootFunction {
	const crateRoot = createRootDetector(["Cargo.toml", "Cargo.lock"]);
	return async (file: string): Promise<string | undefined> => {
		const root = await crateRoot(file);
		if (!root) return undefined;
		let current = root;
		const fsRoot = path.parse(current).root;
		while (true) {
			const parent = path.dirname(current);
			if (parent === current || parent === fsRoot) break;
			const parentCargo = path.join(parent, "Cargo.toml");
			if (await hasWorkspaceSection(parentCargo)) {
				return parent;
			}
			current = parent;
		}
		return root;
	};
}

export const RustServer: LSPServerInfo = {
	id: "rust",
	name: "rust-analyzer",
	extensions: KIND_EXTENSIONS["rust"],
	// No FileDirRoot fallback (#201): rust-analyzer is a heavy workspace server
	// that is useless without a Cargo manifest. With the fallback, every .rs file
	// written before a Cargo.toml exists resolved to its OWN directory as the
	// root, and since clients dedup by `${serverId}:${root}`, each directory
	// spawned a separate rust-analyzer (one per file/dir during scaffolding).
	// Returning undefined here skips the spawn until a Cargo.toml gives a stable,
	// shared crate root — then all files share one server.
	root: RustWorkspaceRoot(),
	async spawn(root, options) {
		// Prefer rustup-installed rust-analyzer; fall back to GitHub-downloaded
		// managed copy. Canonical-bin discovery (#241): include ~/.cargo/bin so a
		// cargo/rustup-managed rust-analyzer resolves before paying for a download
		// even when ~/.cargo/bin isn't on PATH.
		const result = await resolveAndLaunch(
			{
				candidates: cargoBinCandidates("rust-analyzer"),
				args: [],
				cwd: root,
				managedToolId: "rust-analyzer",
			},
			options?.allowInstall,
		);
		if (!result) return undefined;
		return {
			...result,
			initialization: {
				cargo: { buildScripts: { enable: true } },
				procMacro: { enable: true },
				diagnostics: { enable: true },
			},
		};
	},
};

export const RubyServer: LSPServerInfo = {
	id: "ruby",
	name: "Ruby LSP",
	extensions: KIND_EXTENSIONS["ruby"],
	root: RootWithFallback(
		PriorityRoot([["Gemfile", ".ruby-version"], [".git"]]),
	),
	// Ruby LSP may need extra time to finish composed-bundle setup before it can
	// answer initialize/documentSymbol on cold start.
	initializeTimeoutMs: 30_000,
	clientWaitTimeoutMs: 30_000,
	async spawn(root, options) {
		// Try ruby-lsp first, then solargraph, then rubocop --lsp
		// Each has different args so we can't use a single resolveAndLaunch call
		const rubylsp = await resolveAndLaunch(
			{
				candidates: ["ruby-lsp", ...rubyBinCandidates("ruby-lsp")],
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "gem",
					install: () => tryGemInstall("ruby-lsp"),
					retryCandidates: ["ruby-lsp", ...rubyBinCandidates("ruby-lsp")],
				},
			},
			options?.allowInstall,
		);
		if (rubylsp) return rubylsp;

		// Solargraph fallback
		const solargraph = await resolveAndLaunch(
			{
				candidates: ["solargraph", ...rubyBinCandidates("solargraph")],
				args: ["stdio"],
				cwd: root,
			},
			false, // don't install solargraph — already tried gem install above
		);
		if (solargraph) return solargraph;

		// rubocop --lsp fallback
		return resolveAndLaunch(
			{
				candidates: ["rubocop", ...rubyBinCandidates("rubocop")],
				args: ["--lsp"],
				cwd: root,
			},
			false,
		);
	},
};

// NOTE: Ruby's Solargraph + RuboCop fallbacks live INSIDE RubyServer.spawn
// (ruby-lsp → solargraph → rubocop --lsp). Primary selection is first-success-
// wins (one server per file, see LSPService.getClientForFile), so a separate
// solargraph sibling server could never be reached — RubyServer only returns
// undefined when solargraph is also absent. A standalone RubySolargraphServer
// would therefore be dead code; it intentionally does not exist. If a future
// user-selectable preferred-server config lands, refactor RubyServer to a
// single binary and register the alternatives as siblings (cf. python/jedi).

export const PHPServer: LSPServerInfo = {
	id: "php",
	name: "Intelephense",
	extensions: KIND_EXTENSIONS["php"],
	root: RootWithFallback(
		createRootDetector(["composer.json", "composer.lock"]),
	),
	async spawn(root, options) {
		const result = await resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "intelephense"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "intelephense",
			},
			options?.allowInstall,
		);
		if (!result) return undefined;
		return {
			...result,
			initialization: {
				storagePath: path.join(getGlobalPiLensDir(), "intelephense"),
			},
		};
	},
};

// PowerShell Editor Services bootstrap (#278). Builds the `pwsh`/`powershell`
// args that launch the bundled Start-EditorServices.ps1 over stdio. Param set
// verified against the PSES v4.6.0 bundle. Each spawn gets a private session dir
// for the required Log/SessionDetails paths.
function buildPsesArgs(bundleDir: string): string[] {
	const script = path.join(
		bundleDir,
		"PowerShellEditorServices",
		"Start-EditorServices.ps1",
	);
	const sessionDir = path.join(
		getGlobalPiLensDir(),
		"pses",
		`${process.pid}-${Date.now()}`,
	);
	mkdirSync(sessionDir, { recursive: true });
	const logPath = path.join(sessionDir, "pses.log");
	const sessionDetailsPath = path.join(sessionDir, "session.json");
	// Use -File with each PSES parameter as a SEPARATE argv element (the canonical
	// editor launch form). This deliberately avoids `-Command "& '...'"`: pwsh.exe
	// commonly lives under "C:\Program Files\…" (a space), which forces launchLSP's
	// Windows shell path, and an embedded `&`/quotes in a single -Command string
	// gets mangled by cmd.exe. Plain argv tokens survive shell escaping (our paths
	// are under ~/.pi-lens, no spaces). -Stdio makes PSES speak LSP over this
	// process's stdin/stdout; -LanguageServiceOnly skips the debug adapter.
	return [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		// Unsigned bundled script + mark-of-the-web on Windows — Bypass so it runs;
		// ignored by non-Windows pwsh.
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		script,
		"-HostName",
		"pi-lens",
		"-HostProfileId",
		"pi-lens",
		"-HostVersion",
		"1.0.0",
		"-BundledModulesPath",
		bundleDir,
		"-LogPath",
		logPath,
		"-LogLevel",
		"Warning",
		"-SessionDetailsPath",
		sessionDetailsPath,
		"-Stdio",
		"-LanguageServiceOnly",
	];
}

export const PowerShellServer: LSPServerInfo = {
	id: "powershell",
	name: "PowerShell Editor Services",
	extensions: KIND_EXTENSIONS["powershell"],
	// Index at the workspace (script modules reference siblings); fall back to the
	// file dir.
	root: RootWithFallback(createRootDetector([".git"])),
	spawn(root, options) {
		// PSES is a module bundle launched via pwsh, not a binary on PATH. Resolve
		// pwsh/powershell + the managed bundle, then launch the bootstrap over
		// stdio. Graceful skip (→ coverage notice) when pwsh or the bundle is
		// unavailable; psscriptanalyzer remains the fallback in the dispatch group.
		return resolveAndLaunchBundle(
			{
				runtimeCandidates: ["pwsh", "powershell"],
				bundleToolId: "powershell-editor-services",
				cwd: root,
				args: buildPsesArgs,
			},
			options?.allowInstall,
		);
	},
};

export const CSharpServer: LSPServerInfo = {
	id: "csharp",
	name: "csharp-ls",
	extensions: KIND_EXTENSIONS["csharp"],
	// No FileDirRoot fallback (#201): csharp-ls is a workspace server and should
	// not spawn once per source directory before a .sln/.csproj exists. Glob root
	// markers match real project filenames such as `App.csproj` / `App.sln`.
	root: createRootDetector(["*.sln", "*.csproj", "*.slnx"]),
	async spawn(root, options) {
		const candidates = dotnetToolCandidates("csharp-ls");

		return resolveAndLaunch(
			{
				candidates,
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "dotnet",
					install: () => tryDotnetToolInstall("csharp-ls"),
					retryCandidates: candidates,
				},
			},
			options?.allowInstall,
		);
	},
};

export const OmniSharpServer = createInteractiveServer({
	id: "omnisharp",
	name: "OmniSharp",
	extensions: KIND_EXTENSIONS["csharp"],
	root: createRootDetector(["*.sln", "*.csproj", "*.slnx"]),
	language: "csharp",
	command: "OmniSharp",
	args: ["--languageserver"],
});

export const FSharpServer: LSPServerInfo = {
	id: "fsharp",
	name: "FSAutocomplete",
	extensions: KIND_EXTENSIONS["fsharp"],
	root: createRootDetector(["*.sln", "*.fsproj"]),
	async spawn(root, options) {
		// fsautocomplete is a `dotnet tool` (#241), exactly like csharp-ls: prefer a
		// managed/.dotnet-tools copy, else `dotnet tool install` when the .NET SDK
		// is on PATH. dotnetToolCandidates covers the install target so the retry
		// resolves it.
		const candidates = dotnetToolCandidates("fsautocomplete");
		return resolveAndLaunch(
			{
				candidates,
				args: [],
				cwd: root,
				runtimeInstall: {
					runtimeCommand: "dotnet",
					install: () => tryDotnetToolInstall("fsautocomplete"),
					retryCandidates: candidates,
				},
			},
			options?.allowInstall,
		);
	},
};

export const JavaServer = createInteractiveServer({
	id: "java",
	name: "JDT Language Server",
	extensions: KIND_EXTENSIONS["java"],
	root: RootWithFallback(
		createRootDetector(["pom.xml", "build.gradle", ".classpath"]),
	),
	language: "java",
	command: () => process.env.JDTLS_PATH || "jdtls",
	args: (root) => createLombokJdtlsArgs(root),
	runtime: "java",
});

export const KotlinServer: LSPServerInfo = {
	id: "kotlin",
	name: "Kotlin Language Server",
	extensions: KIND_EXTENSIONS["kotlin"],
	root: RootWithFallback(
		createRootDetector(["build.gradle.kts", "build.gradle", "pom.xml"]),
	),
	async spawn(root, options) {
		// Prefer the newer official Kotlin LSP CLI when available, but keep
		// compatibility with the older fwcd kotlin-language-server command.
		return resolveAndLaunch(
			{
				candidates: ["kotlin-lsp", "kotlin-language-server"],
				args: [],
				cwd: root,
			},
			options?.allowInstall,
		);
	},
};

export const SwiftServer = createInteractiveServer({
	id: "swift",
	name: "SourceKit-LSP",
	extensions: KIND_EXTENSIONS["swift"],
	root: createRootDetector(["Package.swift"]),
	language: "swift",
	command: "sourcekit-lsp",
});

export const DartServer = createInteractiveServer({
	id: "dart",
	name: "Dart Analysis Server",
	extensions: KIND_EXTENSIONS["dart"],
	root: RootWithFallback(createRootDetector(["pubspec.yaml"])),
	language: "dart",
	command: "dart",
	args: ["language-server", "--protocol=lsp"],
});

/**
 * Build an {@link LSPServerInfo} for a language server that ships as a
 * self-contained native TREE BUNDLE (single archive, `bin/<binary>` inside,
 * no external runtime — clangd #241, lua-language-server #564, and the
 * kotlin-language-server/elixir-ls follow-on #565). Extracted once both
 * `CppServer` and `LuaServer` turned out to be a near-verbatim structural
 * copy of each other (same `resolveAndLaunchTreeBinary` call shape) —
 * flagged by SonarCloud's new-code duplication gate on PR #567 — so a third
 * and fourth server of this shape (#565) can call this instead of
 * copy-pasting a `spawn` again. Each server's own "why archive-tree, why
 * stripComponents differs, etc." explanation stays as a comment at its own
 * call site below, since that reasoning is genuinely per-server.
 */
function createTreeBinaryServer(spec: {
	id: string;
	name: string;
	extensions: readonly string[];
	root: RootFunction;
	/** PATH candidate + managed bundle tool id, e.g. "clangd", "lua-language-server". */
	binaryName: string;
	/** Path to the executable inside the extracted bundle, e.g. "bin/clangd". */
	binRelPath: string;
	args?: string[];
}): LSPServerInfo {
	return {
		id: spec.id,
		name: spec.name,
		extensions: spec.extensions,
		root: spec.root,
		spawn(root, options) {
			return resolveAndLaunchTreeBinary(
				{
					candidates: [spec.binaryName],
					bundleToolId: spec.binaryName,
					binRelPath: spec.binRelPath,
					cwd: root,
					args: spec.args ?? [],
				},
				options?.allowInstall,
			);
		},
	};
}

// lua-language-server ships the same self-contained native TREE BUNDLE shape
// as clangd (#241/#564): bin/lua-language-server + bundled locale/meta files,
// no external runtime. Prefer a system install on PATH; else auto-install the
// managed bundle and launch bin/lua-language-server within it. Graceful skip
// when neither is available (→ coverage notice).
export const LuaServer: LSPServerInfo = createTreeBinaryServer({
	id: "lua",
	name: "Lua Language Server",
	extensions: KIND_EXTENSIONS["lua"],
	root: createRootDetector([".luarc.json", ".luacheckrc"]),
	binaryName: "lua-language-server",
	binRelPath: "bin/lua-language-server",
});

// clangd ships a self-contained native tree bundle (bin/clangd + bundled
// libclang headers). Prefer a system clangd on PATH; else auto-install the
// managed bundle (#241) and launch bin/clangd within it. Graceful skip when
// neither is available (→ coverage notice); cpp-check stays the fallback.
export const CppServer: LSPServerInfo = createTreeBinaryServer({
	id: "cpp",
	name: "clangd",
	extensions: KIND_EXTENSIONS["cxx"],
	root: RootWithFallback(
		createRootDetector([
			"compile_commands.json",
			".clangd",
			"CMakeLists.txt",
			"Makefile",
		]),
	),
	binaryName: "clangd",
	binRelPath: "bin/clangd",
	args: ["--background-index"],
});

export const ZigServer: LSPServerInfo = {
	id: "zig",
	name: "ZLS",
	extensions: KIND_EXTENSIONS["zig"],
	root: RootWithFallback(createRootDetector(["build.zig"])),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["zls"],
				args: [],
				cwd: root,
				managedToolId: "zls",
			},
			options?.allowInstall,
		);
	},
};

export const HaskellServer = createInteractiveServer({
	id: "haskell",
	name: "Haskell Language Server",
	extensions: KIND_EXTENSIONS["haskell"],
	root: createRootDetector(["stack.yaml", "cabal.project", "*.cabal"]),
	language: "haskell",
	command: "haskell-language-server-wrapper",
	args: ["--lsp"],
});

export const ElixirServer = createInteractiveServer({
	id: "elixir",
	name: "ElixirLS",
	extensions: KIND_EXTENSIONS["elixir"],
	root: RootWithFallback(createRootDetector(["mix.exs"])),
	language: "elixir",
	command: "elixir-ls",
});

export const ElixirExpertServer: LSPServerInfo = {
	id: "expert",
	name: "Expert",
	extensions: KIND_EXTENSIONS["elixir"],
	root: RootWithFallback(createRootDetector(["mix.exs"])),
	availabilityKey: "expert",
	async spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["expert"],
				args: ["--stdio"],
				cwd: root,
				managedToolId: "expert",
			},
			options?.allowInstall,
		);
	},
	autoInstall: async () => Boolean(await ensureTool("expert")),
};

export const GleamServer: LSPServerInfo = {
	id: "gleam",
	name: "Gleam LSP",
	extensions: KIND_EXTENSIONS["gleam"],
	root: RootWithFallback(createRootDetector(["gleam.toml"])),
	async spawn(root, options) {
		// Prefer a PATH `gleam` (full toolchain); fall back to the managed
		// GitHub-release binary. `gleam lsp` is the server entrypoint either way.
		return resolveAndLaunch(
			{
				candidates: ["gleam"],
				args: ["lsp"],
				cwd: root,
				managedToolId: "gleam",
			},
			options?.allowInstall,
		);
	},
};

export const MarksmanServer: LSPServerInfo = {
	id: "marksman",
	name: "Marksman",
	extensions: KIND_EXTENSIONS["markdown"],
	// Index at the workspace root so cross-file checks (broken intra-repo links,
	// missing/renamed anchors, heading refs) see the whole tree; fall back to the
	// file's directory when there's no project marker.
	root: RootWithFallback(createRootDetector([".marksman.toml", ".git"])),
	spawn(root, options) {
		// Prefer a PATH `marksman`; fall back to the managed GitHub-release binary.
		// `marksman server` is the stdio LSP entrypoint either way.
		return resolveAndLaunch(
			{
				candidates: ["marksman"],
				args: ["server"],
				cwd: root,
				managedToolId: "marksman",
			},
			options?.allowInstall,
		);
	},
};

export const OCamlServer = createInteractiveServer({
	id: "ocaml",
	name: "ocamllsp",
	extensions: KIND_EXTENSIONS["ocaml"],
	root: createRootDetector(["dune-project", "opam"]),
	language: "ocaml",
	command: "ocamllsp",
});

export const ClojureServer: LSPServerInfo = {
	id: "clojure",
	name: "Clojure LSP",
	extensions: KIND_EXTENSIONS["clojure"],
	root: createRootDetector(["deps.edn", "project.clj"]),
	async spawn(root, options) {
		// Prefer a PATH `clojure-lsp`; fall back to the managed self-contained
		// native (GraalVM) GitHub-release binary — no JVM needed either way.
		return resolveAndLaunch(
			{
				candidates: ["clojure-lsp"],
				args: [],
				cwd: root,
				managedToolId: "clojure-lsp",
			},
			options?.allowInstall,
		);
	},
};

export const TerraformServer: LSPServerInfo = {
	id: "terraform",
	name: "Terraform LSP",
	extensions: KIND_EXTENSIONS["terraform"],
	root: RootWithFallback(
		createRootDetector([".terraform.lock.hcl", ".terraform"]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["terraform-ls"],
				args: ["serve"],
				cwd: root,
				managedToolId: "terraform-ls",
			},
			options?.allowInstall,
		);
	},
};

export const NixServer = createInteractiveServer({
	id: "nix",
	name: "nixd",
	extensions: KIND_EXTENSIONS["nix"],
	root: createRootDetector(["flake.nix"]),
	language: "nix",
	command: "nixd",
});

export const BashServer: LSPServerInfo = {
	id: "bash",
	name: "Bash Language Server",
	extensions: [".bash", ".sh", ".zsh"],
	root: FileDirRoot,
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "bash-language-server"),
				args: ["start"],
				cwd: root,
				managedToolId: "bash-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const DockerServer: LSPServerInfo = {
	id: "docker",
	name: "Dockerfile Language Server",
	extensions: [".dockerfile", "Dockerfile"],
	root: RootWithFallback(
		PriorityRoot([
			[
				"docker-compose.yml",
				"docker-compose.yaml",
				"compose.yml",
				"compose.yaml",
			],
			[".git"],
		]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "docker-langserver"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "dockerfile-language-server-nodejs",
			},
			options?.allowInstall,
		);
	},
};

export const YamlServer: LSPServerInfo = {
	id: "yaml",
	name: "YAML Language Server",
	extensions: KIND_EXTENSIONS["yaml"],
	root: RootWithFallback(
		PriorityRoot([
			[".yamllint", "yamllint.yml", "yamllint.yaml", "pyproject.toml"],
			[".git"],
		]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "yaml-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "yaml-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const JsonServer: LSPServerInfo = {
	id: "json",
	name: "VSCode JSON Language Server",
	extensions: KIND_EXTENSIONS["json"],
	root: RootWithFallback(
		WorkspacePriorityRoot([
			["package.json", "tsconfig.json", "jsconfig.json"],
			[".git"],
		]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["vscode-json-language-server"],
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-json-language-server",
			},
			options?.allowInstall,
		);
	},
};

export const HtmlServer: LSPServerInfo = {
	id: "html",
	name: "VSCode HTML Language Server",
	extensions: KIND_EXTENSIONS["html"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			PriorityRoot([["package.json", "index.html", "vite.config.ts"]]),
		),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vscode-html-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-html-languageserver-bin",
			},
			options?.allowInstall,
		);
	},
};

export const TomlServer: LSPServerInfo = {
	id: "toml",
	name: "Taplo",
	extensions: KIND_EXTENSIONS["toml"],
	root: RootWithFallback(
		PriorityRoot([["pyproject.toml", "Cargo.toml", "taplo.toml"], [".git"]]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["taplo"],
				args: ["lsp", "stdio"],
				cwd: root,
				managedToolId: "taplo",
			},
			options?.allowInstall,
		);
	},
};

export const PrismaServer: LSPServerInfo = {
	id: "prisma",
	name: "Prisma Language Server",
	extensions: KIND_EXTENSIONS["prisma"],
	root: RootWithFallback(
		createRootDetector(["prisma/schema.prisma", "schema.prisma"]),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "prisma-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "@prisma/language-server",
			},
			options?.allowInstall,
		);
	},
};

// --- Web Framework & Styling Servers ---

export const VueServer: LSPServerInfo = {
	id: "vue",
	name: "Vue Language Server",
	extensions: [".vue"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			createRootDetector([
				"package.json",
				"package-lock.json",
				"bun.lockb",
				"bun.lock",
				"pnpm-lock.yaml",
				"yarn.lock",
			]),
		),
	),
	async spawn(root, options) {
		const tsserverPath = await findTsserverPath(root, options?.allowInstall);

		// Vue Language Server needs Vue dependencies installed to resolve types.
		// Without node_modules, navigation requests will timeout or return empty.
		const hasPackageJson = existsSync(path.join(root, "package.json"));
		const hasNodeModules = existsSync(path.join(root, "node_modules"));
		if (hasPackageJson && !hasNodeModules) {
			logSessionStart(
				`lsp vue: node_modules missing in ${root} — Vue navigation may be limited. ` +
					`Run: npm install (or pnpm/yarn install) in this project.`,
			);
		}

		const proc = await resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vue-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "@vue/language-server",
			},
			options?.allowInstall,
		);
		if (!proc) return undefined;
		return {
			process: proc.process,
			source: proc.source,
			initialization: tsserverPath
				? { typescript: { tsdk: path.dirname(tsserverPath) } }
				: undefined,
		};
	},
};

export const SvelteServer: LSPServerInfo = {
	id: "svelte",
	name: "Svelte Language Server",
	extensions: [".svelte"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			createRootDetector([
				"package.json",
				"package-lock.json",
				"bun.lockb",
				"bun.lock",
				"pnpm-lock.yaml",
				"yarn.lock",
			]),
		),
	),
	async spawn(root, options) {
		const tsserverPath = await findTsserverPath(root, options?.allowInstall);
		const proc = await resolveAndLaunch(
			{
				candidates: [
					...nodeBinCandidates(root, "svelteserver"),
					...nodeBinCandidates(root, "svelte-language-server"),
				],
				args: ["--stdio"],
				cwd: root,
				managedToolId: "svelte-language-server",
			},
			options?.allowInstall,
		);
		if (!proc) return undefined;
		return {
			process: proc.process,
			source: proc.source,
			initialization: tsserverPath
				? { typescript: { tsdk: path.dirname(tsserverPath) } }
				: undefined,
		};
	},
};

export const CssServer: LSPServerInfo = {
	id: "css",
	name: "CSS Language Server",
	extensions: KIND_EXTENSIONS["css"],
	root: RootWithFallback(
		IgnoreHomeRoot(
			PriorityRoot([
				[
					"package.json",
					"postcss.config.js",
					"tailwind.config.js",
					"vite.config.ts",
				],
			]),
		),
	),
	spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: nodeBinCandidates(root, "vscode-css-language-server"),
				args: ["--stdio"],
				cwd: root,
				managedToolId: "vscode-css-languageserver",
			},
			options?.allowInstall,
		);
	},
};

// --- Registry ---

// Opengrep — a cross-language security scanner that speaks LSP. Unlike the
// per-language servers it attaches to MANY file kinds (the aggregation layer
// merges its diagnostics with the file's real language server). Running it as a
// warm LSP server compiles the ruleset once per session instead of paying it on
// every file (the ~8s CLI-per-file cost #111), bringing per-file scans to ~1.3s.
// Rules load via `initializationOptions.scan.configuration` (a local rule file
// if the repo has one, else Opengrep's login-free `auto` set).
const OPENGREP_KINDS = [
	"csharp",
	"css",
	"cxx",
	"dart",
	"docker",
	"go",
	"html",
	"java",
	"json",
	"jsts",
	"kotlin",
	"lua",
	"php",
	"python",
	"ruby",
	"rust",
	"shell",
	"swift",
	"terraform",
	"yaml",
] as const;
const OPENGREP_EXTENSIONS: readonly string[] = Array.from(
	new Set(
		OPENGREP_KINDS.flatMap(
			(k) => (KIND_EXTENSIONS as Record<string, readonly string[]>)[k] ?? [],
		),
	),
);

function opengrepInitialization(root: string): Record<string, unknown> {
	// As an always-on LSP server, enablement is structural (the server is
	// registered); resolveOpengrepConfig here only chooses WHICH rules — a local
	// rule file if present, otherwise `auto`.
	const resolved = resolveOpengrepConfig(root, { enabled: true });
	return {
		scan: {
			configuration: [resolved.configArg ?? "auto"],
			onlyGitDirty: false,
			jobs: 16,
		},
		metrics: { enabled: false },
		doHover: false,
	};
}

export const OpengrepServer: LSPServerInfo = {
	id: "opengrep",
	name: "Opengrep Security Scanner",
	role: "auxiliary",
	extensions: OPENGREP_EXTENSIONS,
	// Stable per-repo root so ONE warm server serves the whole project (a
	// per-directory root would spawn a fresh server — and re-pay rule load —
	// for every folder).
	root: RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
	availabilityKey: "opengrep",
	// Rule compilation can take a few seconds on the first scan of a session.
	initializeTimeoutMs: 15000,
	async spawn(root, options) {
		const launched = await resolveAndLaunch(
			{
				candidates: ["opengrep"],
				args: ["lsp", "--experimental"],
				cwd: root,
				managedToolId: "opengrep",
			},
			options?.allowInstall,
		);
		if (!launched) return undefined;
		return { ...launched, initialization: opengrepInitialization(root) };
	},
	autoInstall: async () => Boolean(await ensureTool("opengrep")),
};

// ast-grep — a polyglot structural linter that speaks LSP. Like Opengrep it is a
// cross-cutting, diagnostic-only auxiliary (never a file's primary language
// server). It attaches EVERYWHERE (#239 Phase 2): a project `sgconfig.y[a]ml`
// surfaces the team's OWN curated rules (auto-discovered), and absent one it
// launches with `--config <shipped baseline>` so pi-lens's bundled ruleset runs
// anyway — superseding the in-process napi runner, which steps aside when this
// server's binary is available (and resumes as the fallback when it isn't —
// Gate B). NOTE: the napi runner is NOT a subset — it delegates to napi's native
// engine via root.findAll({rule}) (#206), the SAME Rust core as this LSP and the
// ast-grep CLI, so rule semantics are identical across all three. The LSP's edge
// is engine-driven codeAction fixes, not faithfulness of matching.
const AST_GREP_KINDS = [
	"csharp",
	"cxx",
	"css",
	"elixir",
	"go",
	"haskell",
	"html",
	"java",
	"json",
	"jsts",
	"kotlin",
	"lua",
	"nix",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"shell",
	"solidity",
	"swift",
	"yaml",
] as const;
const AST_GREP_EXTENSIONS: readonly string[] = Array.from(
	new Set(
		AST_GREP_KINDS.flatMap(
			(k) => (KIND_EXTENSIONS as Record<string, readonly string[]>)[k] ?? [],
		),
	),
);

export const AstGrepServer: LSPServerInfo = {
	id: "ast-grep",
	name: "ast-grep structural linter",
	role: "auxiliary",
	extensions: AST_GREP_EXTENSIONS,
	// Attaches everywhere (#239 Phase 2): prefer a project `sgconfig.y[a]ml` root,
	// else the repo root (.git) or cwd — like Opengrep. When there's no project
	// sgconfig the spawn launches with `--config <shipped baseline>` so the team's
	// rules still run; the napi runner steps aside when this server is available
	// (it falls back to napi when the ast-grep binary is absent — Gate B).
	root: RootWithFallback(
		createRootDetector(["sgconfig.yml", "sgconfig.yaml"]),
		RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
	),
	availabilityKey: "ast-grep",
	// First scan of a session compiles the rules.
	initializeTimeoutMs: 15000,
	async spawn(root, options) {
		// A project sgconfig wins (the team's curated ruleset, auto-discovered from
		// cwd). Otherwise point `--config` at pi-lens's shipped baseline ruleset.
		const projectSgconfig = findLocalSgconfig(root);
		let args = ["lsp"];
		if (!projectSgconfig) {
			const baseline = resolveBaselineSgconfig(root);
			if (baseline) args = ["lsp", "--config", baseline];
		}
		// #472: prefer the platform-native exe directly (one less orphanable
		// node-bin-wrapper layer). Prepended as the first candidate; falls back
		// to the existing "ast-grep" PATH/global-bin resolution when the
		// optional native package isn't installed for this platform/arch.
		const nativeExe = resolveAstGrepNativeExe();
		const candidates = nativeExe ? [nativeExe, "ast-grep"] : ["ast-grep"];
		return resolveAndLaunch(
			{
				candidates,
				args,
				cwd: root,
				managedToolId: "ast-grep",
			},
			options?.allowInstall,
		);
	},
	autoInstall: async () => Boolean(await ensureTool("ast-grep")),
};

// zizmor — a GitHub Actions workflow-security scanner that speaks LSP (#272).
// Like Opengrep/ast-grep it is a cross-cutting, diagnostic-only auxiliary: it
// attaches to YAML and only ever emits findings for actual workflow/action
// files (`.github/workflows/*`, `action.yml`, `dependabot.yaml`) — other YAML
// is a quiet no-op. Its audit set ("regular" persona) is compiled-in and runs
// with NO config; a repo `zizmor.yml` only tunes/ignores rules (the blocking
// opt-in, see the auxiliary profile). Online audits (known-vulnerable-actions,
// unpinned-uses, …) need a GitHub token — resolveZizmorGitHubToken forwards one
// (env, else `gh auth token`); without it zizmor runs its offline audit subset.
const ZIZMOR_EXTENSIONS: readonly string[] = KIND_EXTENSIONS["yaml"];

export const ZizmorServer: LSPServerInfo = {
	id: "zizmor",
	name: "zizmor Actions Security Scanner",
	role: "auxiliary",
	extensions: ZIZMOR_EXTENSIONS,
	// Stable per-repo root so ONE warm server serves the whole project (like
	// Opengrep) — config + workflow discovery is repo-relative.
	root: RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
	availabilityKey: "zizmor",
	async spawn(root, options) {
		// Forward a token so the online audits run; absent one, zizmor self-selects
		// offline mode (the env vars + `gh auth token` are resolved once and merged
		// over process.env by launchLSP).
		const ghToken = await resolveZizmorGitHubToken();
		return resolveAndLaunch(
			{
				candidates: ["zizmor"],
				args: ["--lsp"],
				cwd: root,
				managedToolId: "zizmor",
				...(ghToken ? { env: { GH_TOKEN: ghToken } } : {}),
			},
			options?.allowInstall,
		);
	},
	autoInstall: async () => Boolean(await ensureTool("zizmor")),
};

// typos — a source-code spell checker that speaks LSP (#283). Cross-cutting,
// diagnostic-only auxiliary like Opengrep/ast-grep/zizmor: it attaches to many
// code kinds AND markdown/docs (option B — a spell checker that skips prose
// misses its highest-value target; typos is ALLOW-LIST based, so it only flags
// known misspellings with a known correction, keeping the false-positive rate on
// technical vocab low). Its built-in dictionary is compiled in — NO config needed
// to run; a repo `typos.toml`/`_typos.toml`/`.typos.toml` only tunes the
// dictionary/severity (and is the blocking opt-in, see the auxiliary profile).
// `typos-lsp` takes NO subcommand/flag — it wires stdin/stdout straight into the
// LSP server. Default severity is WARNING, so findings are advisory by default.
const TYPOS_EXTENSIONS: readonly string[] = Array.from(
	new Set([...OPENGREP_EXTENSIONS, ...KIND_EXTENSIONS["markdown"]]),
);

export const TyposServer: LSPServerInfo = {
	id: "typos",
	name: "typos Spell Checker",
	role: "auxiliary",
	extensions: TYPOS_EXTENSIONS,
	// Stable per-repo root so ONE warm server serves the whole project (like the
	// other auxiliaries) — typos.toml discovery is repo-relative.
	root: RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
	availabilityKey: "typos-lsp",
	async spawn(root, options) {
		return resolveAndLaunch(
			{
				candidates: ["typos-lsp"],
				args: [],
				cwd: root,
				managedToolId: "typos-lsp",
			},
			options?.allowInstall,
		);
	},
	autoInstall: async () => Boolean(await ensureTool("typos-lsp")),
};

export const LSP_SERVERS: LSPServerInfo[] = [
	TypeScriptServer,
	DenoServer,
	PythonServer, // pyright / basedpyright — preferred; openFilesOnly avoids cold-start
	PythonJediServer, // fallback when neither pyright nor basedpyright is available
	GoServer,
	RustServer,
	RubyServer,
	PHPServer,
	PowerShellServer, // PowerShell Editor Services — pwsh-bootstrapped module bundle (#278)
	CSharpServer,
	OmniSharpServer,
	FSharpServer,
	JavaServer,
	KotlinServer,
	SwiftServer,
	DartServer,
	LuaServer,
	CppServer,
	ZigServer,
	HaskellServer,
	ElixirServer,
	ElixirExpertServer,
	GleamServer,
	MarksmanServer,
	OCamlServer,
	ClojureServer,
	TerraformServer,
	NixServer,
	BashServer,
	DockerServer,
	YamlServer,
	JsonServer,
	HtmlServer,
	TomlServer,
	PrismaServer,
	// Web frameworks & styling
	VueServer,
	SvelteServer,
	CssServer,
	// Auxiliary (cross-cutting, diagnostic-only) servers go last — never primary.
	OpengrepServer,
	AstGrepServer,
	ZizmorServer,
	TyposServer,
];

/**
 * Get server for a file extension
 */
export function getServerForExtension(ext: string): LSPServerInfo | undefined {
	return LSP_SERVERS.find((server) => server.extensions.includes(ext));
}

/**
 * Get server by ID
 */
export function getServerById(id: string): LSPServerInfo | undefined {
	return LSP_SERVERS.find((server) => server.id === id);
}

/**
 * Get all servers for a file (may have multiple matches)
 */
export function getServersForFile(filePath: string): LSPServerInfo[] {
	const ext = path.extname(filePath).toLowerCase();
	return LSP_SERVERS.filter((server) => server.extensions.includes(ext));
}
