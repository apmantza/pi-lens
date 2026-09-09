import * as os from "node:os";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { logExtension } from "./extension-log.js";
import {
	findNearestMarkerRoot,
	isRealGitMarker,
	isUnderDir,
} from "./path-utils.js";
import {
	getDegradationLedgerGeneration,
	recordDegradationOnce,
} from "./degradation-ledger.js";

export type ToolCwdKind = "runner" | "formatter" | "lsp";

export interface ToolCwdContext {
	cwd?: string;
	rootMarkers?: readonly string[];
	homeDir?: string;
	/** Legacy config-carriage callers may inspect the home-level config itself. */
	allowHomeMarker?: boolean;
	suppressTelemetry?: boolean;
}

const FORMATTER_MARKERS: Readonly<Record<string, readonly string[]>> = {
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
	python: ["pyproject.toml", "requirements.txt", "setup.cfg", ".gitignore"],
	yamllint: [".yamllint", "yamllint.yaml", "yamllint.yml", ".gitignore"],
	"php-cs-fixer": [".php-cs-fixer.php", ".php-cs-fixer.dist.php", ".gitignore"],
	"sqlfluff": [".sqlfluff", "pyproject.toml", "setup.cfg", ".gitignore"],
	"oxfmt": ["oxfmt.toml", ".oxfmtrc.json", "vite-plus.json", "package.json", ".gitignore"],
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

const logged = new Set<string>();
let loggedGeneration = -1;

function markersFor(kind: ToolCwdKind, tool: string, ctx: ToolCwdContext): readonly string[] {
	if (kind === "lsp") return ctx.rootMarkers ?? [];
	return kind === "formatter"
		? (FORMATTER_MARKERS[tool] ?? [".gitignore"])
		: (RUNNER_MARKERS[tool] ?? []);
}

function emitResolution(kind: ToolCwdKind, tool: string, cwd: string, reason: string): void {
	const generation = getDegradationLedgerGeneration();
	if (generation !== loggedGeneration) {
		logged.clear();
		loggedGeneration = generation;
	}
	const key = `${kind}\0${tool}\0${cwd}\0${reason}`;
	if (logged.has(key)) return;
	logged.add(key);
	logExtension({
		subsystem: "tool-cwd",
		level: "debug",
		message: `cwd ${kind} ${tool} cwd=${cwd} reason=${reason}`,
	});
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
	const markers = markersFor(kind, tool, ctx);
	const markerRoot = markers.length
		? findNearestMarkerRoot(fileDir, markers, {
				homeDir: ctx.allowHomeMarker ? path.parse(homeDir).root : homeDir,
			})
		: null;
	if (markerRoot && (insideDispatch ? isUnderDir(markerRoot, dispatchRoot) : true)) {
		const found = markers.find((marker) =>
			existsSync(path.join(markerRoot, marker)),
		);
		const finalReason = `marker:${found ?? markers[0]}`;
		if (!ctx.suppressTelemetry) emitResolution(kind, tool, markerRoot, finalReason);
		return markerRoot;
	}
	const gitRoot = findNearestMarkerRoot(fileDir, [".git"], {
		homeDir,
		markerPredicate: isRealGitMarker,
	});
	if (gitRoot && (insideDispatch ? isUnderDir(gitRoot, dispatchRoot) : true)) {
		if (!ctx.suppressTelemetry) emitResolution(kind, tool, gitRoot, "git-root");
		return gitRoot;
	}
	if (insideDispatch) {
		if (kind === "formatter" || kind === "lsp") {
			if (!ctx.suppressTelemetry) emitResolution(kind, tool, fileDir, "file-dir-fallback");
			if (!ctx.suppressTelemetry && !isUnderDir(fileDir, homeDir)) {
				recordDegradationOnce({
					kind: "tool-cwd-resolution",
					subject: tool,
					reason: `${kind}:home-cap:${absoluteFile}`,
				});
			}
			return fileDir;
		}
		if (!ctx.suppressTelemetry) emitResolution(kind, tool, dispatchRoot, "dispatch-root");
		return dispatchRoot;
	}
	const reason = isUnderDir(fileDir, homeDir) ? "file-dir-fallback" : "home-cap";
	const fallback = isUnderDir(fileDir, homeDir) ? fileDir : homeDir;
	if (!ctx.suppressTelemetry) recordDegradationOnce({
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
