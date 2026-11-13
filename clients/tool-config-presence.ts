/**
 * The one config-presence seam (#5408): "does the project carry config for
 * tool X, starting at this directory". The policy layer (`tool-policy.ts`
 * `getLinterPolicyForCwd`), the runners' own gates and the
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
 * A spec marked `exactDir` (mix, which never walks up) looks at `startDir`
 * alone: the climb is a property of the tool, so the seam owns it and a caller
 * cannot forget it.
 *
 * ## What counts as config
 *
 * Only the forms a spec names. A file, a TOML table, an INI section, a
 * `package.json` field, a declared dependency (a requirements entry NAME, a
 * `Pipfile` / pyproject / `package.json` dependency key) or an import of the
 * tool's package from a config source file. Comments, look-alike names
 * (`flake8-black`, `sqlfluff-templater-dbt`, `vite-plus-extras`) and every form
 * a spec does not name read as "not configured": the gate admits known-good
 * forms and refuses the rest.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasTomlTable, normalizeToml } from "./cargo-manifest.js";
import { readFileContent } from "./dispatch/runners/utils.js";
import { readJsonCache } from "./json-cache-read.js";
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
	| "editorconfig"
	| "eslint"
	| "biome"
	| "stylelint"
	| "markdownlint"
	| "golangci-lint"
	| "phpstan"
	| "vitePlus"
	| "javaBuild"
	| "vale"
	| "shellcheck"
	| "prettier"
	| "rubocop"
	| "standardrb"
	| "oxfmt"
	| "oxlint"
	| "clang-format"
	| "php-cs-fixer"
	| "stylua"
	| "ocamlformat"
	| "google-java-format"
	| "cljfmt"
	| "cmake-format"
	| "psscriptanalyzer"
	| "csharpier"
	| "ormolu"
	| "taplo"
	| "terraform"
	| "swiftformat"
	| "fantomas"
	| "mixFormat"
	| "ktfmt";

/** Where the config was found, and what kind of evidence it is. */
export interface ToolConfigHit {
	/** The file that carries the evidence. */
	file: string;
	/** The directory it was found in. */
	dir: string;
	source:
		| "file"
		| "toml-table"
		| "ini-section"
		| "json-field"
		| "dependency"
		| "import";
}

export interface ToolConfigOptions {
	/** Overrides `os.homedir()`, for tests. */
	homeDir?: string;
	/**
	 * A directory the climb visits and does not pass: the caller's project root
	 * (the Java descriptor gate asks "inside THIS project"). The home stop still
	 * applies below it.
	 */
	ceiling?: string;
}

type DependencyFile =
	| "requirements.txt"
	| "Pipfile"
	| "pyproject.toml"
	| "package.json"
	| "Gemfile";

interface ToolConfigSpec {
	/** File names (sub-paths allowed): the file existing is the evidence. */
	files?: readonly string[];
	/** A TOML table in a named file; `table` is a regex source (dots escaped). */
	tomlTables?: readonly { file: string; table: string }[];
	/** An INI section in a named file, at a line start (a comment never counts). */
	iniSections?: readonly { file: string; section: string }[];
	/**
	 * The tool runs only in the directory that holds the descriptor and never
	 * walks up (mix: "Could not find a Mix.Project"), so only `startDir` itself
	 * counts. A climb here would report a project the tool cannot open.
	 */
	exactDir?: true;
	/**
	 * A `package.json` field holding a value (`stylelint`, `eslintConfig`).
	 * `anyValue` counts the key being present whatever it holds (prettier reads
	 * `"prettier": false` as the project electing prettier).
	 */
	jsonFields?: readonly {
		file: "package.json";
		field: string;
		anyValue?: true;
	}[];
	/**
	 * Other tools whose evidence also configures this one, asked with the same
	 * stop rule (oxfmt and oxlint run through Vite+). Asking the other spec from
	 * here, not per ancestor of a private climb, is what keeps one stop rule.
	 */
	also?: readonly ToolConfigId[];
	/** The tool's own package named as a dependency of the project. */
	dependency?: { names: readonly string[]; files: readonly DependencyFile[] };
	/**
	 * A source config file that imports one of the tool's packages (`from "x"`,
	 * `import "x"`, `require("x")`, `import("x")`, subpaths included). Comments
	 * are blanked first; a bare mention never counts.
	 */
	sourceImports?: { files: readonly string[]; modules: readonly string[] };
	/**
	 * Evidence that only counts from `startDir` up to and including the nearest
	 * `package.json`: ESLint's legacy `.eslintrc.*` / `eslintConfig` keep the
	 * historic per-package boundary (#3017), while the rest of the spec climbs on.
	 */
	withinNearestPackage?: ToolConfigSpec;
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
		dependency: { names: ["black"], files: ["requirements.txt", "Pipfile"] },
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
			names: ["sqlfluff"],
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
			names: ["yamllint"],
			files: ["requirements.txt", "Pipfile", "pyproject.toml"],
		},
	},
	mypy: {
		files: ["mypy.ini", ".mypy.ini"],
		tomlTables: [{ file: "pyproject.toml", table: String.raw`tool\.mypy` }],
		iniSections: [{ file: "setup.cfg", section: "mypy" }],
	},
	// The Mix project descriptor, the evidence credo and `mix compile` need.
	mix: { files: ["mix.exs"], exactDir: true },
	// shfmt's only config source, and the formatters' indentation opt-out.
	editorconfig: { files: [".editorconfig"] },
	// Flat configs resolve like ESLint itself: every ancestor, past an
	// intermediate package.json (#3017, shape 39); the legacy forms keep the
	// per-package boundary.
	eslint: {
		files: [
			"eslint.config.js",
			"eslint.config.mjs",
			"eslint.config.cjs",
			"eslint.config.ts",
			"eslint.config.mts",
			"eslint.config.cts",
		],
		withinNearestPackage: {
			files: [
				".eslintrc",
				".eslintrc.js",
				".eslintrc.cjs",
				".eslintrc.json",
				".eslintrc.yaml",
				".eslintrc.yml",
			],
			jsonFields: [{ file: "package.json", field: "eslintConfig" }],
		},
	},
	// `biome.jsonc` is probed first, so it wins where both names sit in one
	// directory. No caller reads the biome match's file; presence is the answer.
	biome: { files: ["biome.jsonc", "biome.json"] },
	stylelint: {
		files: [
			".stylelintrc",
			".stylelintrc.json",
			".stylelintrc.jsonc",
			".stylelintrc.yaml",
			".stylelintrc.yml",
			".stylelintrc.js",
			".stylelintrc.cjs",
			"stylelint.config.js",
			"stylelint.config.cjs",
			"stylelint.config.mjs",
		],
		jsonFields: [{ file: "package.json", field: "stylelint" }],
	},
	markdownlint: {
		files: [
			// markdownlint-cli2's built-in config names (keep in sync with the
			// installed CLI's supported configuration file names).
			".markdownlint-cli2.jsonc",
			".markdownlint-cli2.yaml",
			".markdownlint-cli2.yml",
			".markdownlint-cli2.cjs",
			".markdownlint-cli2.mjs",
			".markdownlint.jsonc",
			".markdownlint.json",
			".markdownlint.yaml",
			".markdownlint.yml",
			".markdownlint.cjs",
			".markdownlint.mjs",
			// The legacy name, retained for existing policy behaviour even though
			// current markdownlint-cli2 versions do not prefer it.
			".markdownlintrc",
		],
	},
	"golangci-lint": {
		files: [
			".golangci.yml",
			".golangci.yaml",
			".golangci.toml",
			".golangci.json",
		],
	},
	phpstan: {
		files: ["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"],
	},
	// Vite+ (oxfmt / oxlint through `vp`): its own file, the package as a
	// dependency, or a Vite config importing it.
	vitePlus: {
		files: ["vite-plus.json"],
		dependency: {
			names: ["vite-plus", "@voidzero-dev/vite-plus-core"],
			files: ["package.json"],
		},
		sourceImports: {
			files: [
				"vite.config.ts",
				"vite.config.mts",
				"vite.config.cts",
				"vite.config.js",
				"vite.config.mjs",
				"vite.config.cjs",
			],
			// The core package is Vite+ too: master matched it by substring.
			modules: ["vite-plus", "@voidzero-dev/vite-plus-core"],
		},
	},
	// SpotBugs and javac ask whether a Maven/Gradle descriptor is in scope.
	javaBuild: {
		files: [
			"pom.xml",
			"build.gradle",
			"build.gradle.kts",
			"settings.gradle",
			"settings.gradle.kts",
		],
	},
	vale: { files: [".vale.ini"] },
	shellcheck: { files: [".shellcheckrc"] },
	prettier: {
		files: [
			".prettierrc",
			".prettierrc.json",
			".prettierrc.yml",
			".prettierrc.yaml",
			".prettierrc.js",
			".prettierrc.cjs",
			".prettierrc.mjs",
			"prettier.config.js",
			"prettier.config.cjs",
			"prettier.config.mjs",
			"prettier.config.ts",
		],
		// The key being there is the election, even as `false` or `null`.
		jsonFields: [{ file: "package.json", field: "prettier", anyValue: true }],
	},
	rubocop: {
		files: [".rubocop.yml", ".rubocop.yaml"],
		dependency: { names: ["rubocop"], files: ["Gemfile"] },
	},
	// `standard` is the gem standardrb ships as.
	standardrb: { dependency: { names: ["standard"], files: ["Gemfile"] } },
	// The published package is `oxfmt`; the scoped name does not exist on npm,
	// and stays for forward-compat.
	oxfmt: {
		files: ["oxfmt.toml", ".oxfmtrc.json"],
		dependency: {
			names: ["oxfmt", "@oxc-project/oxfmt"],
			files: ["package.json"],
		},
		also: ["vitePlus"],
	},
	// Per https://oxc.rs/docs/guide/usage/linter/config.html, oxlint
	// auto-discovers these names (`oxlint.json` is the legacy one). Nearest
	// config by location, so a package.json never bounds the walk (#3017).
	oxlint: {
		files: [
			".oxlintrc.json",
			".oxlintrc.jsonc",
			"oxlint.json",
			"oxlint.config.ts",
			"oxlint.config.mts",
		],
		also: ["vitePlus"],
	},
	"clang-format": { files: [".clang-format", "_clang-format"] },
	"php-cs-fixer": { files: [".php-cs-fixer.php", ".php-cs-fixer.dist.php"] },
	stylua: { files: ["stylua.toml", ".stylua.toml"] },
	ocamlformat: { files: [".ocamlformat"] },
	// google-java-format has no config file of its own: `.editorconfig` is the
	// common Java project signal, `.google-java-format` the explicit marker.
	"google-java-format": { files: [".google-java-format", ".editorconfig"] },
	cljfmt: { files: [".cljfmt.edn", "cljfmt.edn", ".cljfmt"] },
	"cmake-format": {
		files: [
			".cmake-format",
			".cmake-format.yaml",
			".cmake-format.yml",
			".cmake-format.json",
			".cmake-format.py",
			"cmake-format.yaml",
			"cmake-format.yml",
		],
	},
	// The settings file `Invoke-Formatter -Settings` takes (#1572); the runner
	// hands the found file over, so the hit's `file` is the path.
	psscriptanalyzer: {
		files: ["PSScriptAnalyzerSettings.psd1", "ScriptAnalyzerSettings.psd1"],
	},
	csharpier: {
		files: [
			".csharpierrc",
			".csharpierrc.json",
			".csharpierrc.yaml",
			".csharpierrc.yml",
		],
	},
	// Ormolu has no general settings file; `.ormolu` carries fixity declarations.
	ormolu: { files: [".ormolu"] },
	taplo: { files: ["taplo.toml", ".taplo.toml"] },
	// `terraform fmt` is unconfigurable; `.terraform.lock.hcl` (written only by
	// `terraform init`) marks a directory the user set up as a Terraform root.
	terraform: { files: [".terraform.lock.hcl"] },
	swiftformat: { files: [".swiftformat"] },
	// Fantomas reads `.editorconfig` (`fsharp_*` keys) and `.fantomasignore`.
	fantomas: { files: [".fantomasignore", ".editorconfig"] },
	// `.formatter.exs` is what `mix format` reads project config from.
	mixFormat: { files: [".formatter.exs"] },
	// ktfmt has no native config file; these are pi-lens opt-in markers. The
	// other ktfmt evidence (a Spotless block, a Gradle mention) is a value read
	// in `tool-policy.ts`, which climbs `toolConfigDirs`.
	ktfmt: { files: [".ktfmt", ".ktfmt.kts"] },
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

/** `Gemfile`: the first string of a line-leading `gem` call, so a comment names nothing. */
function gemfileNames(content: string): string[] {
	return content.split(/\r?\n/).flatMap((line) => {
		const match = /^\s*gem\s*\(?\s*["']([^"']+)["']/.exec(line);
		return match?.[1] ? [match[1]] : [];
	});
}

/** `Pipfile` package tables: the dependency is the key. */
function pipfileNames(content: string): string[] {
	return tomlEntries(content).flatMap(({ table, key }) =>
		table === "packages" || table === "dev-packages"
			? [normalizeDistributionName(key)]
			: [],
	);
}

/** The parsed `package.json` object, or `undefined` for a missing, unreadable or non-object file. */
function readPackageJson(file: string): Record<string, unknown> | undefined {
	return readJsonCache(file, (parsed) =>
		typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: undefined,
	);
}

/** `package.json` `dependencies` and `devDependencies` keys with a value, names as written. */
function packageJsonNames(file: string): string[] {
	const pkg = readPackageJson(file);
	if (!pkg) return [];
	return ["dependencies", "devDependencies"].flatMap((group) => {
		const table = pkg[group];
		return typeof table === "object" && table !== null
			? Object.entries(table).flatMap(([name, spec]) => (spec ? [name] : []))
			: [];
	});
}

/** `source` with line and block comments blanked; string contents are kept. */
function blankJsComments(source: string): string {
	let out = "";
	let quote: string | undefined;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i] ?? "";
		const next = source[i + 1];
		if (quote) {
			out += ch;
			if (ch === "\\") out += source[++i] ?? "";
			else if (ch === quote) quote = undefined;
		} else if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			out += ch;
		} else if (ch === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			out += "\n";
		} else if (ch === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 1;
			out += " ";
		} else out += ch;
	}
	return out;
}

/** Whether `source` imports one of `modules` (or a subpath of it) in a form the runtime resolves. */
function importsModule(source: string, modules: readonly string[]): boolean {
	const alternation = modules
		.map((module) => module.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"))
		.join("|");
	return new RegExp(
		String.raw`(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](?:${alternation})(?:/[^"']*)?["']`,
	).test(blankJsComments(source));
}

function dependencyNames(file: DependencyFile, candidate: string): string[] {
	if (file === "package.json") return packageJsonNames(candidate);
	const content = readFileContent(candidate);
	if (content === undefined) return [];
	switch (file) {
		case "requirements.txt":
			return requirementsNames(content);
		case "Pipfile":
			return pipfileNames(content);
		case "pyproject.toml":
			return pyprojectDependencyNames(content);
		case "Gemfile":
			return gemfileNames(content);
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
	for (const { file, field, anyValue } of spec.jsonFields ?? []) {
		const candidate = path.join(dir, file);
		const pkg = readPackageJson(candidate);
		if (anyValue ? pkg && Object.hasOwn(pkg, field) : pkg?.[field]) {
			return { file: candidate, dir, source: "json-field" };
		}
	}
	if (spec.dependency) {
		for (const file of spec.dependency.files) {
			// A spec writes its names in the form the file is compared in: the
			// PEP 503 name for the Python files, the exact key for `package.json`.
			const wanted = spec.dependency.names;
			const candidate = path.join(dir, file);
			if (
				dependencyNames(file, candidate).some((name) => wanted.includes(name))
			) {
				return { file: candidate, dir, source: "dependency" };
			}
		}
	}
	for (const file of spec.sourceImports?.files ?? []) {
		const candidate = path.join(dir, file);
		const content = readFileContent(candidate);
		if (
			content !== undefined &&
			importsModule(content, spec.sourceImports?.modules ?? [])
		) {
			return { file: candidate, dir, source: "import" };
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
	const own = climbForSpec(spec, startDir, options);
	if (own) return own;
	for (const other of spec.also ?? []) {
		const hit = findToolConfig(other, startDir, options);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * The directories a config climb visits, nearest first, under the stop rule in
 * the header: through `$HOME` inclusive (or the caller's `ceiling`), never past
 * it. {@link findToolConfig} climbs it for the presence evidence a spec names;
 * a reader that must read a VALUE out of the config (the oxfmt `svelte` flag,
 * the Spotless block that elects ktlint or ktfmt, the ktfmt Gradle mention)
 * climbs it for the directories and keeps its own read, so no reader owns a
 * second stop rule (#5408).
 */
export function* toolConfigDirs(
	startDir: string,
	options: ToolConfigOptions = {},
): Generator<string> {
	const home = realpathOrResolve(options.homeDir ?? os.homedir());
	const ceiling =
		options.ceiling === undefined
			? undefined
			: realpathOrResolve(options.ceiling);
	for (const dir of walkUpDirs(startDir)) {
		yield dir;
		if (pathsEqual(dir, home)) return;
		if (ceiling !== undefined && pathsEqual(dir, ceiling)) return;
	}
}

function climbForSpec(
	spec: ToolConfigSpec,
	startDir: string,
	options: ToolConfigOptions,
): ToolConfigHit | undefined {
	if (spec.exactDir) return findInDir(spec, realpathOrResolve(startDir));
	let pastPackage = false;
	for (const dir of toolConfigDirs(startDir, options)) {
		const hit =
			findInDir(spec, dir) ??
			(spec.withinNearestPackage && !pastPackage
				? findInDir(spec.withinNearestPackage, dir)
				: undefined);
		if (hit) return hit;
		if (fs.existsSync(path.join(dir, "package.json"))) pastPackage = true;
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
