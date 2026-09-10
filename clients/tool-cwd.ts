import * as os from "node:os";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { type ExtensionLogLevel, logExtension } from "./extension-log.js";
import {
	isRealGitMarker,
	isAtOrAboveHomeDir,
	isUnderDir,
	isWindowsPath,
	nameMatchesMarkerGlob,
	normalizeEphemeralMapKey,
} from "./path-utils.js";
import {
	getDegradationLedgerGeneration,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import {
	createGenerationMap,
	createGenerationSource,
} from "./generation-guard.js";

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
};

const RUNNER_MARKERS: Readonly<Record<string, readonly string[]>> = {
	yamllint: [".yamllint", "yamllint.yaml", "yamllint.yml", "pyproject.toml"],
	ruff: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
	"spellcheck/typos": ["_typos.toml", "typos.toml"],
	biome: ["biome.json", "biome.jsonc", "package.json"],
	oxlint: [".oxlintrc.json", "oxlint.config.js", "package.json"],
	sqlfluff: [".sqlfluff", "pyproject.toml", "setup.cfg"],
	prettier: [".prettierignore", "package.json"],
};

const toolCwdGeneration = createGenerationSource("tool-cwd");
const logged = createGenerationMap("tool-cwd-resolution-log");
const markerWalks = new Map<string, { root: string | null; marker?: string }>();
const markerWalkGenerations = createGenerationMap("tool-cwd-marker-walks");
let markerWalkCount = 0;

/** Pure key seam for ephemeral tool-cwd memo and log identity. */
export function _toolCwdEphemeralKey(parts: readonly string[]): string {
	return parts.map(normalizeEphemeralMapKey).join("\0");
}

/** Test probe for the per-generation walk memo; not part of runtime behavior. */
export function _getToolCwdMarkerWalkCount(): number {
	return markerWalkCount;
}

function syncGeneration(): void {
	if (toolCwdGeneration.current() === getDegradationLedgerGeneration()) return;
	markerWalks.clear();
	markerWalkGenerations.clear();
	logged.clear();
	while (toolCwdGeneration.current() < getDegradationLedgerGeneration()) {
		toolCwdGeneration.bump();
	}
}

function findMarkerRoot(
	startDir: string,
	markers: readonly string[],
	homeDir: string,
): { root: string | null; marker?: string } {
	syncGeneration();
	const key = _toolCwdEphemeralKey([
		path.resolve(startDir),
		...markers,
		path.resolve(homeDir),
	]);
	const cached = markerWalks.get(key);
	if (cached && markerWalkGenerations.current(key) !== 0) {
		if (!cached.marker || !cached.root) return cached;
		// #2777: a marker can disappear during a session; do not reuse a stale root.
		if (existsSync(path.join(cached.root, cached.marker))) return cached;
		markerWalks.delete(key);
		markerWalkGenerations.forget(key);
	}
	markerWalkCount++;
	let current = path.resolve(startDir);
	let result: { root: string | null; marker?: string } = { root: null };
	for (let depth = 0; depth < 64; depth++) {
		if (isAtOrAboveHomeDir(current, homeDir)) break;
		for (const marker of markers) {
			const slash = marker.replace(/\\/g, "/").lastIndexOf("/");
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
			if (found) {
				result = { root: current, marker };
				markerWalks.set(key, result);
				markerWalkGenerations.bump(key);
				return result;
			}
		}
		const parentDir = path.dirname(current);
		if (parentDir === current) break;
		current = parentDir;
	}
	markerWalks.set(key, result);
	markerWalkGenerations.bump(key);
	return result;
}

function markersFor(
	kind: ToolCwdKind,
	tool: string,
	ctx: ToolCwdContext,
): readonly string[] {
	if (kind === "lsp") return ctx.rootMarkers ?? [];
	return kind === "formatter"
		? (FORMATTER_MARKERS[tool] ?? [".gitignore"])
		: (RUNNER_MARKERS[tool] ?? []);
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

/** Resolve every child process cwd/root through one bounded, synchronous seam. */
export function resolveToolCwd(
	kind: ToolCwdKind,
	tool: string,
	file: string,
	ctx: ToolCwdContext,
): string {
	const dispatchRoot = path.resolve(ctx.cwd ?? process.cwd());
	const absoluteFile = path.resolve(file);
	const fileDir = path.dirname(absoluteFile);
	const homeDir = ctx.homeDir ?? os.homedir();
	const insideDispatch = isUnderDir(absoluteFile, dispatchRoot);
	if (ctx.serverRoot) {
		const rootPath = isWindowsPath(ctx.serverRoot) ? path.win32 : path;
		const serverRoot = rootPath.resolve(ctx.serverRoot);
		if (!ctx.suppressTelemetry)
			emitResolution(kind, tool, serverRoot, "server-root");
		return serverRoot;
	}
	const markers = markersFor(kind, tool, ctx);
	const markerResult = markers.length
		? findMarkerRoot(
				fileDir,
				markers,
				ctx.allowHomeMarker ? path.parse(homeDir).root : homeDir,
			)
		: { root: null };
	const markerRoot = markerResult.root;
	if (
		markerRoot &&
		(insideDispatch ? isUnderDir(markerRoot, dispatchRoot) : true)
	) {
		const finalReason = `marker:${markerResult.marker ?? markers[0]}`;
		if (!ctx.suppressTelemetry)
			emitResolution(kind, tool, markerRoot, finalReason);
		return markerRoot;
	}
	const gitResult = findMarkerRoot(fileDir, [".git"], homeDir);
	const gitRoot =
		gitResult.root && isRealGitMarker(path.join(gitResult.root, ".git"))
			? gitResult.root
			: null;
	if (gitRoot && (insideDispatch ? isUnderDir(gitRoot, dispatchRoot) : true)) {
		if (!ctx.suppressTelemetry) emitResolution(kind, tool, gitRoot, "git-root");
		return gitRoot;
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
			return fileDir;
		}
		if (!ctx.suppressTelemetry)
			emitResolution(kind, tool, dispatchRoot, "dispatch-root");
		return dispatchRoot;
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
	return fallback;
}

/** Runner-shaped adapter kept at the same seam for every runner consumer. */
export function resolveRunnerCwd(
	ctx: { cwd: string; filePath: string },
	tool: string,
): string {
	return resolveToolCwd("runner", tool, ctx.filePath, ctx);
}
