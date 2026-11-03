#!/usr/bin/env node
/**
 * Re-capture the real-bytes runner fixtures (#1937).
 *
 * `capture-runner-output.mjs` captures ONE tool. This is the manifest of which
 * tools, against which committed workspace, with which argv — so a fixture can
 * be refreshed against a newer binary without anyone reconstructing the
 * invocation from a fixture's provenance header.
 *
 * Each entry's `argv` MUST mirror the argv its runner spawns, in order. The
 * argv-tie assertion in runners/captured-real-output.test.ts compares the two,
 * so an entry that drifts from its runner fails the suite rather than quietly
 * capturing bytes no runner would ever receive.
 *
 * Usage:
 *   node scripts/capture-runner-fixtures.mjs [runnerId ...] [--bin-dir DIR]
 *   node scripts/capture-runner-fixtures.mjs --records-only [runnerId ...]
 *
 * Binaries are resolved as, in order: `<bin-dir>/<tool>[.exe|.bat]`, pi-lens's
 * own managed tool dirs, then bare `<tool>` on PATH. A tool that resolves
 * nowhere is REPORTED AND SKIPPED, never silently omitted: a capture run that
 * found no binaries must not look like a successful refresh.
 *
 * `--records-only` is the retrofit for fixtures captured before #4473 and
 * #4522: it re-runs only the availability probe and the clean run against the
 * real binary and merges those records into the existing envelopes, leaving the
 * recorded work bytes byte-identical. Re-capturing the work bytes from a newer
 * build would silently retarget the parser evidence a version-specific fixture
 * (fish 3.3.1's `~`-prefixed argv header) exists to hold.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBin } from "./capture-runner-output.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const smoke = (dir) => `tests/fixtures/tool-smoke/${dir}`;

/** `--output.<format>.path=` for every golangci-lint format except json. */
const GOLANGCI_OTHER_FORMATS_OFF = [
	"text",
	"tab",
	"html",
	"checkstyle",
	"code-climate",
	"junit-xml",
	"teamcity",
	"sarif",
].map((format) => `--output.${format}.path=`);

/**
 * The availability probes a runner's checker sends, when they are not the
 * default `[<tool> --version]`. The capture runs each one against the real
 * binary and records the answer, so the replay never has to guess whether the
 * tool accepted its own probe (#4473).
 */
const PROBE_OVERRIDES = {
	"cue-vet": [{ command: "cue", argv: ["version"] }],
	"go-vet": [{ command: "go", argv: ["version"] }],
	"zig-check": [{ command: "zig", argv: ["version"] }],
	"rust-clippy": [
		// The runner resolves the PATH candidate by spawning `cargo --version`
		// before it asks clippy anything (clients/rust-client.ts), and a host
		// without a Rust toolchain reds the replay when that probe is unrecorded
		// (#4522 F7). Both probes are recorded, each answered by its own command.
		{ command: "cargo", argv: ["--version"] },
		{ command: "cargo", argv: ["clippy", "--version"] },
	],
	"helm-lint": [{ command: "helm", argv: ["version", "--short"] }],
	markdownlint: [{ command: "markdownlint-cli2", argv: ["--no-globs", "-"] }],
	// fish-indent probes the formatter for every case, and `fish` itself for the
	// syntax cases its `fish --no-execute` lane drives.
	"fish-indent": [
		{ command: "fish_indent", argv: ["--version"] },
		{ command: "fish", argv: ["--version"] },
	],
	// biome explains one rule before it lints (a second probe, and not a
	// version one).
	"biome-check-json": [
		{ command: "biome", argv: ["--version"] },
		{ command: "biome", argv: ["explain", "noUnusedVariables"] },
	],
	// cpp-check probes its compiler candidates in order until one answers, so
	// the record carries each candidate's real answer on the capture host.
	"cpp-check": [
		{ command: "clang++", argv: ["--version"] },
		{ command: "g++", argv: ["--version"] },
		{ command: "clang", argv: ["--version"] },
		{ command: "gcc", argv: ["--version"] },
		{ command: "cc", argv: ["--version"] },
		{ command: "c++", argv: ["--version"] },
		{ command: "cl", argv: ["--version"] },
	],
};

/** Where a runner's clean capture workspace lives. */
export function cleanWorkspaceFor(runner) {
	return `tests/fixtures/runner-output-clean/${runner}`;
}

/**
 * One capture. `argv` mirrors the runner's own invocation; `file` is the
 * workspace-relative path the runner is pointed at.
 */
export const CAPTURES = [
	{
		runner: "actionlint",
		tool: "actionlint",
		workspace: smoke("actionlint"),
		file: ".github/workflows/ci.yml",
		argv: ["-format", "{{json .}}", ".github/workflows/ci.yml"],
	},
	{
		runner: "biome-check-json",
		tool: "biome",
		workspace: smoke("javascript"),
		file: "bad.js",
		argv: ["lint", "--reporter=json", "--no-errors-on-unmatched", "bad.js"],
	},
	{
		runner: "hadolint",
		tool: "hadolint",
		workspace: smoke("dockerfile"),
		file: "Dockerfile",
		argv: ["--format", "json", "--no-fail", "Dockerfile"],
	},
	{
		// #1839/#1994 — pins the CORRECTED --rules argv (comma-separated ruleid
		// list) producing findings on exit 1. The pre-fix runner fed --rules a
		// JSON object, which left zero rules enabled and exited 0 clean on any
		// file.
		runner: "htmlhint",
		tool: "htmlhint",
		workspace: smoke("html"),
		file: "bad.html",
		argv: [
			"--rules",
			"tag-pair,attr-no-duplication,tagname-lowercase,spec-char-escape,id-unique",
			"--format",
			"unix",
			"bad.html",
		],
	},
	{
		// The runner prefers clang++, then g++, then c++; any of them emits the
		// `file:line:col: error:` shape, so a host with g++ captures it.
		runner: "cpp-check",
		tool: "g++",
		workspace: smoke("cpp"),
		file: "main.cpp",
		argv: ["-fsyntax-only", "main.cpp"],
	},
	{
		runner: "cue-vet",
		tool: "cue",
		versionArgs: "version",
		workspace: smoke("cue-vet"),
		file: "bad.cue",
		argv: ["vet", "-c=false", "."],
	},
	{
		runner: "dotnet-build",
		tool: "dotnet",
		workspace: smoke("csharp"),
		file: "Program.cs",
		argv: ["build", "toolsmoke.csproj", "--nologo", "--verbosity", "minimal"],
	},
	{
		runner: "dart-analyze",
		tool: "dart",
		workspace: smoke("dart"),
		file: "bad.dart",
		argv: ["analyze", "--format=machine", "bad.dart"],
	},
	{
		runner: "javac",
		tool: "javac",
		versionArgs: "-version",
		workspace: smoke("java"),
		file: "Bad.java",
		argv: ["-Xlint:none", "-proc:none", "Bad.java"],
	},
	{
		// ktlint is a launcher script over `java -jar`, so a JDK must be on PATH.
		runner: "ktlint",
		tool: "ktlint",
		workspace: smoke("kotlin"),
		file: "Bad.kt",
		argv: ["--reporter=json", "Bad.kt"],
	},
	{
		// detekt emits TEXT reports with no severity token (`file:line:col:
		// message [Rule]`), and its default ruleset is off once a config is
		// passed, so the smoke workspace's detekt.yml activates one rule.
		runner: "detekt",
		tool: "detekt",
		workspace: smoke("detekt"),
		file: "Bad.kt",
		argv: [
			"--input",
			"__WORKSPACE__/Bad.kt",
			"--config",
			"__WORKSPACE__/detekt.yml",
		],
	},
	{
		// Needs Ruby on PATH; the gem's launcher is a Ruby script.
		runner: "rubocop",
		tool: "rubocop",
		workspace: smoke("ruby"),
		file: "bad.rb",
		argv: ["--format", "json", "--no-color", "bad.rb"],
	},
	{
		runner: "rust-clippy",
		tool: "cargo",
		workspace: smoke("rust"),
		file: "src/main.rs",
		argv: ["clippy", "--message-format=json", "-q"],
	},
	{
		// Needs Erlang on PATH: gleam shells out to `escript` even for `check`.
		runner: "gleam-check",
		tool: "gleam",
		workspace: smoke("gleam"),
		file: "src/smoke.gleam",
		argv: ["check"],
	},
	{
		// The Mix path (`mix.exs` present). tool-smoke/elixir keeps bad.ex at the
		// project root, which `mix compile` never reads, so this capture uses
		// tool-smoke/elixir-mix, whose file sits under lib/. `mix --version`
		// leads with the Erlang banner, so the version comes from Elixir itself.
		runner: "elixir-check",
		tool: "mix",
		// Mix's own banner. The former probe ran a project expression and needed a
		// compiled project; a capture host with only a bare Mix could not record it.
		versionArgs: "--version",
		workspace: smoke("elixir-mix"),
		file: "lib/bad.ex",
		argv: ["compile", "--warnings-as-errors"],
	},
	{
		runner: "fish-indent",
		tool: "fish_indent",
		workspace: smoke("fish-indent"),
		file: "unformatted.fish",
		argv: ["--check", "unformatted.fish"],
	},
	{
		// #4454 — the fish-lsp smoke fixture also has to be something fish_indent
		// objects to. It was already formatted, so exit 0 and no finding.
		runner: "fish-indent",
		case: "smoke-bad",
		tool: "fish_indent",
		workspace: smoke("fish"),
		file: "bad.fish",
		argv: ["--check", "bad.fish"],
	},
	// #4454 — fish_indent --check never reports a syntax error (a missing `end`
	// or an unterminated quote exits 0 with no output), so the runner also asks
	// `fish --no-execute`, which parses without running anything. These four
	// capture its real bytes for the three defects and for the fish-lsp smoke
	// fixture. The file is already formatted in each, so fish_indent is silent.
	{
		runner: "fish-indent",
		case: "syntax-missing-end",
		tool: "fish",
		workspace: smoke("fish-syntax"),
		file: "missing-end.fish",
		argv: ["--no-config", "--no-execute", "missing-end.fish"],
	},
	{
		runner: "fish-indent",
		case: "syntax-unterminated-quote",
		tool: "fish",
		workspace: smoke("fish-syntax"),
		file: "unterminated-quote.fish",
		argv: ["--no-config", "--no-execute", "unterminated-quote.fish"],
	},
	{
		runner: "fish-indent",
		case: "syntax-stray-end",
		tool: "fish",
		workspace: smoke("fish-syntax"),
		file: "stray-end.fish",
		argv: ["--no-config", "--no-execute", "stray-end.fish"],
	},
	{
		// Production hands fish an ABSOLUTE path, and fish 3.3.1 (Ubuntu 22.04)
		// then prints the header as `~` + that path. Captured with a 3.3.1
		// binary only: `--bin-dir` selects one fish for every fish-indent
		// entry, so run this entry alone with that binary and keep the other
		// fixtures from the newer one.
		runner: "fish-indent",
		case: "syntax-stray-end-fish-3.3.1",
		tool: "fish",
		workspace: smoke("fish-syntax"),
		file: "stray-end.fish",
		argv: ["--no-config", "--no-execute", "__WORKSPACE__/stray-end.fish"],
	},
	{
		runner: "fish-indent",
		case: "syntax-smoke-bad",
		tool: "fish",
		workspace: smoke("fish"),
		file: "bad.fish",
		argv: ["--no-config", "--no-execute", "bad.fish"],
	},
	{
		// #4455 — golangci-lint v2 removed `--out-format`; JSON now comes from
		// `--output.json.path`, and the run stats it prints to stdout would
		// otherwise trail the JSON document.
		runner: "golangci-lint",
		tool: "golangci-lint",
		workspace: smoke("golangci-lint"),
		file: "bad.go",
		argv: [
			"run",
			"--output.json.path=stdout",
			...GOLANGCI_OTHER_FORMATS_OFF,
			"--show-stats=false",
			"bad.go",
		],
	},
	{
		// A project config that prints a text format to stdout puts that text beside
		// the JSON unless the runner switches the other formats off.
		runner: "golangci-lint",
		case: "config-text-stdout",
		tool: "golangci-lint",
		workspace: smoke("golangci-lint-text-stdout"),
		file: "bad.go",
		argv: [
			"run",
			"--output.json.path=stdout",
			...GOLANGCI_OTHER_FORMATS_OFF,
			"--show-stats=false",
			"bad.go",
		],
	},
	{
		// #4453 — the runner lints the chart ROOT by absolute path, so the capture
		// spawns with the workspace (the token) and the file is the template the
		// replay points the runner at.
		runner: "helm-lint",
		tool: "helm",
		versionArgs: "version --short",
		workspace: smoke("helm"),
		file: "templates/bad.yaml",
		argv: ["lint", "__WORKSPACE__"],
	},
	{
		// A template whose file name holds a space: helm prints the name unquoted
		// inside `(<chart>/templates/my file.yaml:5)`.
		runner: "helm-lint",
		case: "space-in-name",
		tool: "helm",
		versionArgs: "version --short",
		workspace: smoke("helm-space-name"),
		file: "templates/my file.yaml",
		argv: ["lint", "__WORKSPACE__"],
	},
	{
		// The static build: the dynamic `swiftlint` needs libxml2 and SourceKit.
		runner: "swiftlint",
		tool: "swiftlint",
		// A clean run exists: the binary lints a formatted file and reports `[]`,
		// warning only that one SourceKit-gated rule was skipped (#4522 F8
		// measured it; the earlier `cleanUnavailable` fact claimed it aborts on
		// any file, which its own dirty capture contradicts).
		workspace: smoke("swiftlint"),
		file: "bad.swift",
		argv: ["--reporter", "json", "bad.swift"],
	},
	{
		runner: "go-vet",
		case: "type-error",
		tool: "go",
		versionArgs: "version",
		workspace: smoke("go"),
		file: "bad.go",
		argv: ["vet", "."],
		// #4451 — a Go type error prints `vet: ./bad.go:8:21: ...`, the prefixed
		// shape the runner dropped. tool-smoke/go holds a type error, so go never
		// reaches its analyzers there.
		note: "type error: go vet prefixes the line with `vet: `",
	},
	{
		// #4451 — the analyzer shape (`bad.go:9:14: ...`, no prefix), from a file
		// that type-checks.
		runner: "go-vet",
		case: "printf-analyzer",
		tool: "go",
		versionArgs: "version",
		workspace: smoke("go-vet-printf"),
		file: "bad.go",
		argv: ["vet", "."],
	},
	{
		runner: "markdownlint",
		tool: "markdownlint",
		bin: "markdownlint-cli2",
		workspace: smoke("markdown"),
		file: "bad.md",
		argv: ["bad.md"],
	},
	{
		runner: "mypy",
		tool: "mypy",
		workspace: smoke("python-types"),
		file: "bad.py",
		argv: ["--no-error-summary", "--show-column-numbers", "bad.py"],
	},
	{
		runner: "oxlint",
		tool: "oxlint",
		workspace: smoke("js-oxlint-error"),
		file: "bad.js",
		argv: ["--format", "json", "bad.js"],
	},
	{
		// #1947 — oxlint exits 0 when every finding is warning severity (its
		// default). No .oxlintrc.json override here, unlike js-oxlint-error,
		// so the capture pins the exit-0-with-findings case #1946 deliberately
		// left uncaptured.
		runner: "oxlint",
		case: "warning-exit-zero",
		tool: "oxlint",
		workspace: smoke("js-oxlint-warning"),
		file: "bad.js",
		argv: ["--format", "json", "bad.js"],
	},
	{
		// #1954 — ESLint also exits 0 when every finding is warning severity
		// (--max-warnings unset). No rule in modern @eslint/js recommended
		// ships at "warn" anymore, so js-eslint-warning's config downgrades
		// no-unused-vars explicitly — still the exit-0-with-findings shape.
		runner: "eslint",
		case: "warning-exit-zero",
		tool: "eslint",
		workspace: smoke("js-eslint-warning"),
		file: "bad.js",
		argv: ["--format", "json", "--no-error-on-unmatched-pattern", "bad.js"],
	},
	{
		runner: "php-lint",
		tool: "php",
		workspace: smoke("php"),
		file: "syntax-error.php",
		argv: ["-l", "syntax-error.php"],
	},
	{
		runner: "phpstan",
		tool: "phpstan",
		workspace: smoke("phpstan"),
		file: "bad.php",
		argv: ["analyse", "--error-format=json", "--no-progress", "bad.php"],
	},
	{
		runner: "phpstan",
		case: "top-level-errors",
		tool: "phpstan",
		workspace: smoke("phpstan-internal"),
		file: "clean.php",
		note: "an unmatched ignore pattern: a finding phpstan reports outside files{}",
		argv: ["analyse", "--error-format=json", "--no-progress"],
	},
	{
		runner: "pyright",
		tool: "pyright",
		workspace: smoke("python-types"),
		file: "bad.py",
		argv: ["--outputjson", "bad.py"],
	},
	{
		runner: "ruff-lint",
		tool: "ruff",
		workspace: smoke("python"),
		file: "bad.py",
		argv: ["check", "--output-format", "json", "bad.py"],
	},
	{
		runner: "shellcheck",
		tool: "shellcheck",
		workspace: smoke("shell"),
		file: "bad.sh",
		// #3968: bad.sh is shebang'd, so the runner passes NO --shell override —
		// ShellCheck parses the shebang itself (bash-lsp@5.8.1 mirror).
		argv: ["--format", "json", "--severity", "info", "bad.sh"],
	},
	{
		runner: "shfmt",
		tool: "shfmt",
		workspace: smoke("shell"),
		file: "bad.sh",
		argv: ["--diff", "bad.sh"],
	},
	{
		runner: "spellcheck",
		tool: "typos",
		workspace: smoke("typos-aux"),
		file: "notes.md",
		argv: ["--format", "json", "notes.md"],
	},
	{
		// No .sqlfluff in this workspace, so the runner appends `--dialect
		// ansi` AFTER `--format json`. Capturing the configured order instead
		// would hide #1937's argv bug, which put `--dialect` between `--format`
		// and its value.
		runner: "sqlfluff",
		tool: "sqlfluff",
		workspace: smoke("sql"),
		file: "bad.sql",
		argv: ["lint", "--format", "json", "--dialect", "ansi", "bad.sql"],
	},
	{
		runner: "stylelint",
		tool: "stylelint",
		workspace: smoke("css"),
		file: "bad.css",
		argv: ["--formatter", "json", "bad.css"],
	},
	{
		runner: "taplo",
		tool: "taplo",
		workspace: smoke("toml"),
		file: "bad.toml",
		argv: ["check", "--colors", "never", "bad.toml"],
	},
	{
		runner: "terragrunt",
		tool: "terragrunt",
		workspace: smoke("terragrunt"),
		file: "terragrunt.hcl",
		argv: ["hcl", "validate", "--json", "--non-interactive"],
	},
	{
		runner: "trivy-config",
		tool: "trivy",
		workspace: smoke("trivy-config"),
		file: "bad.yaml",
		// The floor `resolveSeverityFloor` defaults to (HIGH, never stricter), so
		// the capture and the runner ask trivy the same question.
		argv: [
			"config",
			"--quiet",
			"--format",
			"json",
			"--severity",
			"HIGH,CRITICAL",
			"bad.yaml",
		],
		// A clean run exists: a manifest with no kubernetes resources gives the
		// ruleset nothing to check, and trivy exits 0 with no results (#4522 F8
		// measured it; the earlier `cleanUnavailable` fact claimed no clean
		// manifest exists at all).
	},
	{
		runner: "tflint",
		tool: "tflint",
		workspace: smoke("terraform"),
		file: "bad.tf",
		argv: ["--format=json", "--no-color", "--filter=bad.tf"],
	},
	{
		runner: "vale",
		tool: "vale",
		workspace: smoke("vale"),
		file: "bad.md",
		argv: ["--output", "JSON", "bad.md"],
	},
	{
		runner: "yamllint",
		tool: "yamllint",
		workspace: smoke("yaml"),
		file: "bad.yaml",
		argv: ["-f", "parsable", "bad.yaml"],
	},
	{
		runner: "zig-check",
		tool: "zig",
		versionArgs: "version",
		workspace: smoke("zig"),
		file: "bad.zig",
		argv: ["build-exe", "bad.zig", "-fno-emit-bin"],
	},
];

function main() {
	const argv = process.argv.slice(2);
	let binDir = null;
	let recordsOnly = false;
	const only = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--bin-dir") binDir = argv[++i];
		else if (argv[i] === "--records-only") recordsOnly = true;
		else only.push(argv[i]);
	}

	const selected = only.length
		? CAPTURES.filter((c) => only.includes(c.runner))
		: CAPTURES;
	if (selected.length === 0) {
		console.error(`no capture matched: ${only.join(", ")}`);
		process.exit(2);
	}

	let captured = 0;
	const skipped = [];
	const scratch = [];
	const tempWorkspace = (source, label) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-capture-"));
		scratch.push(dir);
		fs.cpSync(path.join(repoRoot, source), dir, { recursive: true });
		return { dir, label };
	};

	try {
		for (const entry of selected) {
			const bin = resolveBin(entry.bin ?? entry.tool, binDir);
			const probes = entry.probe ??
				PROBE_OVERRIDES[entry.runner] ?? [
					{ command: entry.tool, argv: ["--version"] },
				];
			const cleanWorkspace = entry.clean ?? cleanWorkspaceFor(entry.runner);

			// The records a fixture cannot be replayed without (#4473, #4522).
			const recordArgs = [
				...(entry.versionArgs ? ["--version-args", entry.versionArgs] : []),
				...(entry.shell ? ["--shell", entry.shell] : []),
				...(binDir ? ["--bin-dir", binDir] : []),
				...probes.flatMap((probe) => [
					"--probe",
					JSON.stringify({ command: probe.command, argv: probe.argv }),
				]),
			];

			if (recordsOnly) {
				// Key on the entry's OWN case. Iterating the directory instead merged
				// one entry's clean run into every fixture of its runner, so
				// fish-indent's formatter fixture replayed an entry that ran
				// `fish --no-execute`, and the clean half of six fixtures was
				// evidence about an invocation they never send (#4522 F3).
				const caseName = entry.case ?? "real";
				const dest = path.join(
					repoRoot,
					"tests/fixtures/runner-output",
					entry.runner,
					`${caseName}.captured.json`,
				);
				if (!fs.existsSync(dest)) {
					skipped.push(`${entry.runner}/${caseName}: no fixture to merge into`);
					continue;
				}
				const workspace = tempWorkspace(entry.workspace, "dirty").dir;
				const clean = tempWorkspace(cleanWorkspace, "clean").dir;
				try {
					execFileSync(
						process.execPath,
						[
							path.join(__dirname, "capture-runner-output.mjs"),
							"--runner",
							entry.runner,
							"--tool",
							entry.tool,
							"--bin",
							bin,
							"--cwd",
							workspace,
							"--file",
							entry.file,
							"--merge-into",
							dest,
							"--clean-cwd",
							clean,
							"--clean-workspace",
							cleanWorkspace,
							"--clean-file",
							entry.file,
							...recordArgs,
							"--",
							...entry.argv,
						],
						{ stdio: "inherit" },
					);
					captured++;
				} catch (err) {
					skipped.push(`${entry.runner}/${caseName}: ${err?.message ?? err}`);
				}
				continue;
			}

			const workspace = tempWorkspace(entry.workspace, "dirty").dir;
			const clean = tempWorkspace(cleanWorkspace, "clean").dir;
			try {
				execFileSync(
					process.execPath,
					[
						path.join(__dirname, "capture-runner-output.mjs"),
						"--runner",
						entry.runner,
						"--tool",
						entry.tool,
						"--bin",
						bin,
						"--cwd",
						workspace,
						"--workspace",
						entry.workspace,
						"--file",
						entry.file,
						"--case",
						entry.case ?? "real",
						...(entry.note ? ["--note", entry.note] : []),
						"--clean-cwd",
						clean,
						"--clean-workspace",
						cleanWorkspace,
						"--clean-file",
						entry.file,
						...recordArgs,
						"--",
						...entry.argv,
					],
					{ stdio: "inherit" },
				);
				captured++;
			} catch (err) {
				skipped.push(`${entry.runner}: ${err?.message ?? err}`);
			}
		}
	} finally {
		for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
	}

	console.log(`\n${captured} captured, ${skipped.length} skipped`);
	for (const reason of skipped) console.log(`  skipped ${reason}`);
	// A run that captured nothing is a failed refresh, not a quiet success.
	process.exit(captured === 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
	main();
}
