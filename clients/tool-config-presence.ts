/**
 * The one config-presence seam (#5408): "does the project carry config for
 * tool X, starting at this directory". The policy layer (`tool-policy.ts`
 * `hasXConfig`, `getLinterPolicyForCwd`), the runners' own gates and the
 * formatter selector all ask THIS module, so they cannot disagree on where to
 * look, how far to climb, or what counts as config.
 *
 * Shape fixed (AGENTS.md shape 83, rule re-derived beside its owner): before
 * this module the policy walked up unbounded, detekt's runner checked only its
 * cwd, tflint's runner stopped before `$HOME`, and the Python gates matched
 * substrings (`flake8-black` read as black, a commented `[tool.ruff]` as ruff).
 *
 * ## Stop rule
 *
 * Climb from `startDir` on the path-identity axis (`walkUpDirs`), visit the
 * home directory itself, and never visit anything above it. A start outside
 * `$HOME` climbs to the filesystem root, as every config climb here already
 * did. Inclusive of `$HOME` on purpose: the tools read a home-level config
 * themselves (tflint's own fallback is `~/.tflint.hcl`; `findLocalToolConfig`
 * documents the same for the other config finders), so the project-root
 * ceiling (`isAtOrAboveHomeDir`, exclusive) would hide a file the tool will
 * read. What sits above `$HOME` is never project config. `homeDir` is
 * injectable for tests; the default is `os.homedir()`, read per call.
 *
 * ## What counts as config
 *
 * Only the forms a spec names. A file, a TOML table, an INI section, or a
 * declared dependency (a requirements entry NAME, a `Pipfile` / pyproject
 * dependency key). Comments, look-alike names (`flake8-black`,
 * `sqlfluff-templater-dbt`) and every form a spec does not name read as "not
 * configured": the gate admits known-good forms and refuses the rest.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasTomlTable, normalizeToml } from "./cargo-manifest.js";
import { readFileContent } from "./dispatch/runners/utils.js";
import { pathsEqual, realpathOrResolve, walkUpDirs } from "./path-utils.js";

export type ToolConfigId =
	| "detekt"
	| "tflint"
	| "black"
	| "ruff"
	| "sqlfluff"
	| "yamllint"
	| "mypy"
	| "mix"
	| "editorconfig";

/** Where the config was found, and what kind of evidence it is. */
export interface ToolConfigHit {
	/** The file that carries the evidence. */
	file: string;
	/** The directory it was found in. */
	dir: string;
	source: "file" | "toml-table" | "ini-section" | "dependency";
}

export interface ToolConfigOptions {
	/** Overrides `os.homedir()`, for tests. */
	homeDir?: string;
}

type DependencyFile = "requirements.txt" | "Pipfile" | "pyproject.toml";

interface ToolConfigSpec {
	/** File names (sub-paths allowed): the file existing is the evidence. */
	files?: readonly string[];
	/** A TOML table in a named file; `table` is a regex source (dots escaped). */
	tomlTables?: readonly { file: string; table: string }[];
	/** An INI section in a named file, at a line start (a comment never counts). */
	iniSections?: readonly { file: string; section: string }[];
	/** The tool's own package named as a dependency of the project. */
	dependency?: { name: string; files: readonly DependencyFile[] };
}

const TOOL_CONFIG_SPECS: Readonly<Record<ToolConfigId, ToolConfigSpec>> = {
	detekt: {
		files: [
			"detekt.yml",
			".detekt.yml",
			path.join("config", "detekt", "detekt.yml"),
			path.join("detekt", "detekt.yml"),
		],
	},
	// tflint ships built-in rules and runs without config, so `.tflint.hcl` is
	// the project electing it, not a prerequisite. It resolves config from its
	// own working directory and never walks parents, so the runner hands the
	// found file over with `--config`.
	tflint: { files: [".tflint.hcl"] },
	black: {
		tomlTables: [{ file: "pyproject.toml", table: String.raw`tool\.black` }],
		dependency: { name: "black", files: ["requirements.txt", "Pipfile"] },
	},
	// Ruff ignores a `pyproject.toml` without `[tool.ruff]` (measured, see
	// `python-environment.ts`), so the table is the evidence.
	ruff: {
		files: ["ruff.toml", ".ruff.toml"],
		tomlTables: [{ file: "pyproject.toml", table: String.raw`tool\.ruff` }],
	},
	sqlfluff: {
		files: [".sqlfluff"],
		tomlTables: [{ file: "pyproject.toml", table: String.raw`tool\.sqlfluff` }],
		iniSections: [
			{ file: "setup.cfg", section: "sqlfluff" },
			{ file: "tox.ini", section: "sqlfluff" },
		],
		dependency: {
			name: "sqlfluff",
			files: ["requirements.txt", "Pipfile", "pyproject.toml"],
		},
	},
	yamllint: {
		files: [".yamllint", ".yamllint.yml", ".yamllint.yaml"],
		tomlTables: [{ file: "pyproject.toml", table: String.raw`tool\.yamllint` }],
		iniSections: [
			{ file: "setup.cfg", section: "yamllint" },
			{ file: "tox.ini", section: "yamllint" },
		],
		dependency: {
			name: "yamllint",
			files: ["requirements.txt", "Pipfile", "pyproject.toml"],
		},
	},
	mypy: {
		files: ["mypy.ini", ".mypy.ini"],
		tomlTables: [{ file: "pyproject.toml", table: String.raw`tool\.mypy` }],
		iniSections: [{ file: "setup.cfg", section: "mypy" }],
	},
	// The Mix project descriptor, the evidence credo and `mix compile` need.
	mix: { files: ["mix.exs"] },
	// shfmt's only config source, and the formatters' indentation opt-out.
	editorconfig: { files: [".editorconfig"] },
};

/** PEP 503 name: case-insensitive, runs of `-`, `_`, `.` are one. */
function normalizeDistributionName(name: string): string {
	return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const REQUIREMENT_NAME =
	/^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(?:$|[<>=!~;@(,\s])/;

/** The distribution name a PEP 508 requirement string starts with. */
function requirementName(requirement: string): string | undefined {
	const match = REQUIREMENT_NAME.exec(requirement);
	return match ? normalizeDistributionName(match[1] ?? "") : undefined;
}

/** `requirements.txt`: one requirement per line; `#` comments and `-` options skipped. */
function requirementsNames(content: string): string[] {
	const names: string[] = [];
	for (const raw of content.replace(/^﻿/, "").split(/\r?\n/)) {
		const line = raw.replace(/(^|\s)#.*$/, "").trim();
		if (line === "" || line.startsWith("-")) continue;
		const name = requirementName(line);
		if (name) names.push(name);
	}
	return names;
}

interface TomlEntry {
	table: string;
	key: string;
	/** The raw value text, a multi-line array joined. */
	value: string;
}

const TOML_TABLE_HEADING = /^[ \t]*\[([^[\]]+)\][ \t]*$/;
const TOML_KEY_LINE =
	/^[ \t]*("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)[ \t]*=[ \t]*(.*)$/;

/** Net `[`/`]` depth change of `text`, ignoring brackets inside strings. */
function bracketDelta(text: string): number {
	let depth = 0;
	let quote: string | undefined;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = undefined;
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "[") depth += 1;
		else if (ch === "]") depth -= 1;
	}
	return depth;
}

/**
 * `key = value` entries by table, over comment-stripped text. A value that
 * opens a `[` array runs to its matching `]`, so a multi-line dependency list
 * is one entry. `[[array.tables]]` headings reset the table to "".
 */
function tomlEntries(content: string): TomlEntry[] {
	const entries: TomlEntry[] = [];
	const lines = normalizeToml(content).split("\n");
	let table = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^[ \t]*\[\[/.test(line)) {
			table = "";
			continue;
		}
		const heading = TOML_TABLE_HEADING.exec(line);
		if (heading) {
			table = (heading[1] ?? "").replace(/["'\s]/g, "");
			continue;
		}
		const keyLine = TOML_KEY_LINE.exec(line);
		if (!keyLine) continue;
		let value = keyLine[2] ?? "";
		let depth = bracketDelta(value);
		while (depth > 0 && i + 1 < lines.length) {
			i += 1;
			value += `\n${lines[i] ?? ""}`;
			depth += bracketDelta(lines[i] ?? "");
		}
		entries.push({
			table,
			key: (keyLine[1] ?? "").replace(/^["']|["']$/g, ""),
			value,
		});
	}
	return entries;
}

function quotedStrings(value: string): string[] {
	return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(
		(m) => m[1] ?? m[2] ?? "",
	);
}

const POETRY_DEPENDENCY_TABLE =
	/^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/;

/** Distribution names a pyproject declares as dependencies, in the forms PEP 621, PEP 735, uv and poetry use. */
function pyprojectDependencyNames(content: string): string[] {
	const names: string[] = [];
	for (const { table, key, value } of tomlEntries(content)) {
		if (POETRY_DEPENDENCY_TABLE.test(table)) {
			names.push(normalizeDistributionName(key));
		} else if (
			(table === "project" && key === "dependencies") ||
			(table === "tool.uv" && key === "dev-dependencies") ||
			table === "project.optional-dependencies" ||
			table === "dependency-groups"
		) {
			for (const text of quotedStrings(value)) {
				const name = requirementName(text);
				if (name) names.push(name);
			}
		}
	}
	return names;
}

/** `Pipfile` package tables: the dependency is the key. */
function pipfileNames(content: string): string[] {
	return tomlEntries(content).flatMap(({ table, key }) =>
		table === "packages" || table === "dev-packages"
			? [normalizeDistributionName(key)]
			: [],
	);
}

function dependencyNames(file: DependencyFile, content: string): string[] {
	switch (file) {
		case "requirements.txt":
			return requirementsNames(content);
		case "Pipfile":
			return pipfileNames(content);
		case "pyproject.toml":
			return pyprojectDependencyNames(content);
	}
}

function hasIniSection(content: string, section: string): boolean {
	return new RegExp(`^[ \\t]*\\[${section}\\][ \\t]*(?:[#;].*)?$`, "m").test(
		content,
	);
}

function findInDir(
	spec: ToolConfigSpec,
	dir: string,
): ToolConfigHit | undefined {
	for (const name of spec.files ?? []) {
		const candidate = path.join(dir, name);
		if (fs.existsSync(candidate)) {
			return { file: candidate, dir, source: "file" };
		}
	}
	for (const { file, table } of spec.tomlTables ?? []) {
		const candidate = path.join(dir, file);
		const content = readFileContent(candidate);
		if (content !== undefined && hasTomlTable(content, table)) {
			return { file: candidate, dir, source: "toml-table" };
		}
	}
	for (const { file, section } of spec.iniSections ?? []) {
		const candidate = path.join(dir, file);
		const content = readFileContent(candidate);
		if (content !== undefined && hasIniSection(content, section)) {
			return { file: candidate, dir, source: "ini-section" };
		}
	}
	if (spec.dependency) {
		const wanted = normalizeDistributionName(spec.dependency.name);
		for (const file of spec.dependency.files) {
			const candidate = path.join(dir, file);
			const content = readFileContent(candidate);
			if (
				content !== undefined &&
				dependencyNames(file, content).includes(wanted)
			) {
				return { file: candidate, dir, source: "dependency" };
			}
		}
	}
	return undefined;
}

/**
 * The nearest evidence that `tool` is configured for `startDir`, with the file
 * it sits in and why it counts; `undefined` when there is none within the stop
 * rule above.
 */
export function findToolConfig(
	tool: ToolConfigId,
	startDir: string,
	options: ToolConfigOptions = {},
): ToolConfigHit | undefined {
	const spec = TOOL_CONFIG_SPECS[tool];
	const home = realpathOrResolve(options.homeDir ?? os.homedir());
	for (const dir of walkUpDirs(startDir)) {
		const hit = findInDir(spec, dir);
		if (hit) return hit;
		if (pathsEqual(dir, home)) return undefined;
	}
	return undefined;
}

/** Whether `tool` is configured for `startDir`: {@link findToolConfig} as a boolean. */
export function hasToolConfig(
	tool: ToolConfigId,
	startDir: string,
	options: ToolConfigOptions = {},
): boolean {
	return findToolConfig(tool, startDir, options) !== undefined;
}
