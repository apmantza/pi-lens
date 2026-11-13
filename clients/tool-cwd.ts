import * as os from "node:os";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { type ExtensionLogLevel, logExtension } from "./extension-log.js";
import {
	isRealGitMarker,
	isUnderDir,
	isWindowsPath,
	nameMatchesMarkerGlob,
	normalizeEphemeralMapKey,
	pathsEqual,
	realpathOrResolve,
	toPosix,
	walkUpDirs,
} from "./path-utils.js";
import {
	getDegradationLedgerGeneration,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import {
	createGenerationMap,
	createGenerationSource,
} from "./generation-guard.js";
import { rootMarkersForFile } from "./language-profile.js";
import {
	findToolConfig,
	type ToolConfigHit,
	type ToolConfigId,
} from "./tool-config-presence.js";

export type ToolCwdKind = "runner" | "formatter" | "lsp";

export interface ToolCwdContext {
	cwd?: string;
	rootMarkers?: readonly string[];
	/** Root already computed by a caller-owned resolver. */
	serverRoot?: string;
	homeDir?: string;
	/** Legacy config-carriage callers may inspect the home-level config itself. */
	allowHomeMarker?: boolean;
	suppressTelemetry?: boolean;
	/** One synchronous dispatch's reusable `.git` fallback result. */
	toolCwdMemo?: { gitRoot?: string | null };
}

export interface ToolCwdResolution {
	cwd: string;
	marker?: string;
}

export const FORMATTER_MARKERS: Readonly<Record<string, readonly string[]>> = {
	biome: ["biome.json", "biome.jsonc", "package.json", ".gitignore"],
	prettier: [
		".prettierrc",
		".prettierrc.json",
		".prettierrc.yaml",
		".prettierrc.yml",
		".prettierrc.js",
		".prettierrc.cjs",
		".prettierrc.mjs",
		"prettier.config.js",
		"prettier.config.cjs",
		"prettier.config.mjs",
		".prettierignore",
		"package.json",
		".gitignore",
	],
	ruff: ["pyproject.toml", "ruff.toml", ".ruff.toml", ".gitignore"],
	black: ["pyproject.toml", "black.toml", ".black", ".gitignore"],
	"php-cs-fixer": [".php-cs-fixer.php", ".php-cs-fixer.dist.php", ".gitignore"],
	sqlfluff: [".sqlfluff", "pyproject.toml", "setup.cfg", ".gitignore"],
	oxfmt: [
		"oxfmt.toml",
		".oxfmtrc.json",
		"vite-plus.json",
		"package.json",
		".gitignore",
	],
	rustfmt: ["rustfmt.toml", ".rustfmt.toml", "Cargo.toml", ".gitignore"],
	rubocop: [".rubocop.yml", ".rubocop.yaml", ".gitignore"],
	standardrb: [".standard.yml", ".standard.yaml", ".gitignore"],
	"clang-format": [".clang-format", "_clang-format", ".gitignore"],
	stylua: ["stylua.toml", ".stylua.toml", ".gitignore"],
	ocamlformat: [".ocamlformat", ".gitignore"],
	"google-java-format": [".google-java-format", ".editorconfig", ".gitignore"],
	cljfmt: [".cljfmt.edn", "cljfmt.edn", ".cljfmt", ".gitignore"],
	"cmake-format": [
		".cmake-format",
		".cmake-format.yaml",
		".cmake-format.yml",
		".cmake-format.json",
		".cmake-format.py",
		"cmake-format.yaml",
		"cmake-format.yml",
		".editorconfig",
		".gitignore",
	],
	"psscriptanalyzer-format": [
		"PSScriptAnalyzerSettings.psd1",
		"ScriptAnalyzerSettings.psd1",
		".gitignore",
	],
	csharpier: [
		".csharpierrc",
		".csharpierrc.json",
		".csharpierrc.yaml",
		".csharpierrc.yml",
		".gitignore",
	],
	ormolu: [".ormolu", ".gitignore"],
	taplo: ["taplo.toml", ".taplo.toml", ".gitignore"],
	terraform: [".terraform.lock.hcl", ".gitignore"],
	swiftformat: [".swiftformat", ".gitignore"],
	fantomas: [".fantomasignore", ".editorconfig", ".gitignore"],
	mix: [".formatter.exs", ".gitignore"],
	shfmt: [".editorconfig", ".gitignore"],
	ktlint: [".editorconfig", ".gitignore"],
	ktfmt: [
		".editorconfig",
		".ktfmt",
		".ktfmt.kts",
		"build.gradle",
		"build.gradle.kts",
		"settings.gradle",
		"settings.gradle.kts",
		".gitignore",
	],
	typstyle: [".gitignore"],
};

const toolCwdGeneration = createGenerationSource("tool-cwd");
const logged = createGenerationMap("tool-cwd-resolution-log");

/** Pure key seam for resolution-log and runner-advisory identity. */
export function _toolCwdEphemeralKey(parts: readonly string[]): string {
	return parts.map(normalizeEphemeralMapKey).join("\0");
}

function syncGeneration(): void {
	if (toolCwdGeneration.current() === getDegradationLedgerGeneration()) return;
	logged.clear();
	while (toolCwdGeneration.current() < getDegradationLedgerGeneration()) {
		toolCwdGeneration.bump();
	}
}

/**
 * `walkUpDirs` resolves `startDir` and `homeDir` to path identities itself, so
 * the climb names the parents the kernel opens and a caller may pass a
 * spelling (#4689 item 6, #4966). `resolveToolCwd` hands over the directory
 * of the file's resolved target.
 */
function walkMarkerRoot(
	startDir: string,
	markers: readonly string[],
	homeDir: string,
): { root: string | null; marker?: string } {
	for (const current of walkUpDirs(startDir, { homeDir, maxDepth: 64 })) {
		for (const marker of markers) {
			const slash = toPosix(marker).lastIndexOf("/");
			const parent = slash >= 0 ? marker.slice(0, slash) : "";
			const basename = slash >= 0 ? marker.slice(slash + 1) : marker;
			const target = parent
				? path.join(current, ...parent.split("/").filter(Boolean))
				: current;
			let found = false;
			if (basename.includes("*")) {
				try {
					found = readdirSync(target, { withFileTypes: true }).some(
						(entry) =>
							(entry.isFile() || entry.isSymbolicLink()) &&
							nameMatchesMarkerGlob(entry.name, basename),
					);
				} catch {
					found = false;
				}
			} else {
				found = existsSync(path.join(target, basename));
			}
			if (found) return { root: current, marker };
		}
	}
	return { root: null };
}

function findMarkerRoot(
	startDir: string,
	markers: readonly string[],
	homeDir: string,
): { root: string | null; marker?: string } {
	syncGeneration();
	return walkMarkerRoot(startDir, markers, homeDir);
}

function markersFor(
	kind: ToolCwdKind,
	tool: string,
	file: string,
	ctx: ToolCwdContext,
): readonly string[] {
	if (kind === "lsp") return ctx.rootMarkers ?? [];
	// #2965: runner fallback uses the language table that also anchors the
	// dispatch context. A caller-owned table remains an explicit override.
	if (kind === "runner")
		return ctx.rootMarkers ?? rootMarkersForFile(file, tool);
	return FORMATTER_MARKERS[tool] ?? [".gitignore"];
}

function emitResolution(
	kind: ToolCwdKind,
	tool: string,
	cwd: string,
	reason: string,
): void {
	syncGeneration();
	const key = _toolCwdEphemeralKey([kind, tool, cwd, reason]);
	if (logged.current(key) !== 0) return;
	logged.bump(key);
	logExtension({
		subsystem: "tool-cwd",
		level: "debug",
		message: `cwd ${kind} ${tool} cwd=${cwd} reason=${reason}`,
	});
}

/**
 * Emit a constant runner advisory once per (tool, resolved root) per session
 * (#2811): the yamllint/stylelint/sqlfluff "no config detected" lines and
 * markdownlint's spawn-timeout cooldown notice logged once PER FILE at error
 * level — 17 lines in one session for one tool. The throttle shares the
 * resolution-log map and its ledger-generation reset, so `session_start`
 * re-arms it like every once-latch in this module. The message rides
 * `ctx.log` at debug level so the dispatch seam stays the one sink for
 * runner lines, with its own filePath/kind metadata.
 */
export function logRunnerAdvisoryOnce(
	ctx: { log(message: string, level?: ExtensionLogLevel): void },
	tool: string,
	root: string,
	message: string,
): void {
	syncGeneration();
	const key = _toolCwdEphemeralKey(["runner-advisory", tool, root]);
	if (logged.current(key) !== 0) return;
	logged.bump(key);
	ctx.log(message, "debug");
}

/**
 * Runners whose config can sit above the nearest package manifest and holds a
 * path the tool resolves from the process cwd (a plugin's `settings` entry), so
 * the child runs in that config's directory (#5541). The tool-config seam owns
 * where the config is, so the policy and this spawn cannot disagree (#5408).
 * Biome is not listed: it resolves a config's paths from the config file.
 */
const CONFIG_ANCHORED_RUNNERS = [
	"oxlint",
	"eslint",
] as const satisfies readonly ToolConfigId[];

function configAnchorOf(
	tool: string,
	fromDir: string,
	options: { homeDir: string; ceiling: string | undefined },
): ToolConfigHit | undefined {
	const anchored = CONFIG_ANCHORED_RUNNERS.find((id) => id === tool);
	return anchored ? findToolConfig(anchored, fromDir, options) : undefined;
}

/** Resolve every child process cwd/root through one bounded, synchronous seam. */
export function resolveToolCwd(
	kind: ToolCwdKind,
	tool: string,
	file: string,
	ctx: ToolCwdContext,
): ToolCwdResolution {
	if (ctx.serverRoot) {
		const rootPath = isWindowsPath(ctx.serverRoot) ? path.win32 : path;
		const serverRoot = rootPath.resolve(ctx.serverRoot);
		if (!ctx.suppressTelemetry)
			emitResolution(kind, tool, serverRoot, "server-root");
		return { cwd: serverRoot };
	}
	const dispatchRoot = path.resolve(ctx.cwd ?? process.cwd());
	// #4689 item 6: the child's project is the one the file LIVES in. A link
	// spelling (`pkg-a/src/blink.ts` -> `pkg-b/b.ts`) climbs `pkg-a`'s parents
	// and ran the other package's tool config; the identity's parents are the
	// ones the kernel opens. One resolution per call, and the home ceiling the
	// walks compare against is resolved with it so both sit on one axis.
	const absoluteFile = realpathOrResolve(file);
	const fileDir = path.dirname(absoluteFile);
	const homeDir = ctx.homeDir ?? os.homedir();
	const homeCeiling = realpathOrResolve(homeDir);
	const insideDispatch = isUnderDir(absoluteFile, dispatchRoot);
	const markers = markersFor(kind, tool, absoluteFile, ctx);
	const markerResult = markers.length
		? findMarkerRoot(
				fileDir,
				markers,
				ctx.allowHomeMarker ? path.parse(homeCeiling).root : homeCeiling,
			)
		: { root: null };
	const markerRoot = markerResult.root;
	if (
		markerRoot &&
		(insideDispatch ? isUnderDir(markerRoot, dispatchRoot) : true)
	) {
		// #5541: a caller-owned marker table still decides; a config outside the
		// dispatch root is not the session's, so the climb stops at that root. The
		// config seam climbs through `$HOME`, but the ceiling here is exclusive: a
		// home-level config is the user's, never this project's.
		const anchor =
			kind === "runner" && !ctx.rootMarkers
				? configAnchorOf(tool, markerRoot, {
						homeDir,
						ceiling: insideDispatch ? dispatchRoot : undefined,
					})
				: undefined;
		if (
			anchor &&
			!pathsEqual(anchor.dir, markerRoot) &&
			!pathsEqual(anchor.dir, homeCeiling)
		) {
			const anchorMarker = path.basename(anchor.file);
			if (!ctx.suppressTelemetry)
				emitResolution(kind, tool, anchor.dir, `marker:${anchorMarker}`);
			return { cwd: anchor.dir, marker: anchorMarker };
		}
		const finalReason = `marker:${markerResult.marker ?? markers[0]}`;
		if (!ctx.suppressTelemetry)
			emitResolution(kind, tool, markerRoot, finalReason);
		return {
			cwd: markerRoot,
			...(markerResult.marker !== undefined
				? { marker: markerResult.marker }
				: {}),
		};
	}
	const memo = ctx.toolCwdMemo;
	if (memo && memo.gitRoot === undefined) {
		const gitResult = findMarkerRoot(fileDir, [".git"], homeCeiling);
		memo.gitRoot =
			gitResult.root && isRealGitMarker(path.join(gitResult.root, ".git"))
				? gitResult.root
				: null;
	}
	const gitRoot =
		memo && memo.gitRoot !== undefined
			? memo.gitRoot
			: (() => {
					const gitResult = findMarkerRoot(fileDir, [".git"], homeCeiling);
					return gitResult.root &&
						isRealGitMarker(path.join(gitResult.root, ".git"))
						? gitResult.root
						: null;
				})();
	if (gitRoot && (insideDispatch ? isUnderDir(gitRoot, dispatchRoot) : true)) {
		if (!ctx.suppressTelemetry) emitResolution(kind, tool, gitRoot, "git-root");
		return { cwd: gitRoot, marker: ".git" };
	}
	if (insideDispatch) {
		if (kind === "formatter") {
			if (!ctx.suppressTelemetry)
				emitResolution(kind, tool, fileDir, "file-dir-fallback");
			if (!ctx.suppressTelemetry && !isUnderDir(fileDir, homeDir)) {
				recordDegradationOnce({
					kind: "tool-cwd-resolution",
					subject: tool,
					reason: `${kind}:home-cap:${absoluteFile}`,
				});
			}
			return { cwd: fileDir };
		}
		if (!ctx.suppressTelemetry)
			emitResolution(kind, tool, dispatchRoot, "dispatch-root");
		return { cwd: dispatchRoot };
	}
	const reason = isUnderDir(fileDir, homeDir)
		? "file-dir-fallback"
		: "home-cap";
	const fallback = isUnderDir(fileDir, homeDir) ? fileDir : homeDir;
	if (!ctx.suppressTelemetry)
		recordDegradationOnce({
			kind: "tool-cwd-resolution",
			subject: tool,
			reason: `${kind}:${reason}:${absoluteFile}`,
		});
	if (!ctx.suppressTelemetry) emitResolution(kind, tool, fallback, reason);
	return { cwd: fallback };
}

/** Runner-shaped adapter kept at the same seam for every runner consumer. */
export function resolveRunnerCwd(
	ctx: { cwd: string; filePath: string },
	tool: string,
): string {
	return resolveToolCwd("runner", tool, ctx.filePath, ctx).cwd;
}

export function resolveRunnerCwdWithReason(
	ctx: { cwd: string; filePath: string },
	tool: string,
): ToolCwdResolution {
	return resolveToolCwd("runner", tool, ctx.filePath, ctx);
}
