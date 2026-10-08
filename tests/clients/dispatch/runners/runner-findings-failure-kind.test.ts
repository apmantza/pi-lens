/**
 * #3781: population test for the runner status contract. When a registered
 * runner reports `status: "failed"` because the check ran and its findings
 * failed it, the result carries `failureKind: "blocking_diagnostics"`. With
 * that kind, "found problems" and "the runner broke" can be told apart by the
 * log analyzer, the latency.log row, and the MCP `pilens_analyze` row.
 *
 * Recurrence prevented: #3751/#3781. Forty-two runners reported findings as a
 * bare `failed`. `pilens_analyze` rows exposed only `status`, so an agent
 * could not tell a broken runner from a successful run with findings.
 * `clients/dispatch/types.ts` documented the kind, but only lsp.ts set it.
 *
 * The table is keyed on the LIVE registry (`registerDefaultRunners`) in both
 * directions. A new runner reds here until it gets a driver. A driver for a
 * runner that is no longer registered also reds.
 *
 * Each driver enters through the real `createDispatchContext`, `RunnerRegistry`
 * and `dispatchForFile`. Only the process and host boundaries are doubled:
 * `safeSpawnAsync`, the availability probes, the language servers, and the go
 * and cargo lookups. Every driver produces a real finding (a `lens3781` marker
 * in the tool's output, or the rule id for the in-process analyzers), so a row
 * cannot pass on a parse-error diagnostic. The shapes come from suites that
 * already pin them against real output: `reported-path-attribution.test.ts`,
 * `captured-real-output.test.ts`, and each runner's own suite.
 *
 * Each row pins its status, so adding the kind can never move a runner between
 * `succeeded` and `failed`. That would change which runners a fallback group
 * runs (`clients/dispatch/dispatcher.ts` runGroup), a non-goal of #3781.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import {
	hasUsableResult,
	type RunnerResult,
} from "../../../../clients/dispatch/types.js";
import { makeLspServiceDouble } from "../../../support/lsp-service-double.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, lspTouch, logLatency } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	lspTouch: vi.fn(),
	logLatency: vi.fn(),
}));

// The latency.log runner row is what scripts/analyze-pi-lens-logs.mjs reads
// `metadata.failureKind` from.
vi.mock("../../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

// psscriptanalyzer's interpreter and module probes go through `probeToolAsync`.
vi.mock("../../../../clients/tool-probe.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/tool-probe.js")
	>()),
	probeToolAsync: async () => ({
		status: 0,
		stdout: "",
		stderr: "",
		error: null,
	}),
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => true,
			isAvailableAsync: async () => true,
			getCommand: () => command,
			getOutcome: () => "success",
		}),
		resolveAvailableOrInstall: async (_checker: unknown, toolId: string) =>
			toolId,
		resolveToolCommandWithInstallFallback: async (
			_cwd: string,
			toolId: string,
		) => toolId,
		resolveLocalFirstAsync: async (toolName: string) => ({
			cmd: toolName,
			args: [],
		}),
		createCwdCachedProbe: () =>
			Object.assign(async () => true, {
				getVerdict: () => ({ outcome: "ok" as const }),
			}),
		lspPrimaryCoversFile: () => false,
	}),
);

// Config gates are not under test here. Open them so each runner reaches its
// findings arm (the same set captured-real-output.test.ts opens).
vi.mock("../../../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/tool-policy.js")
	>()),
	getLinterPolicyForCwd: () => null,
	markdownlintConfigArgs: () => [],
	hasEslintConfig: () => true,
	hasMypyConfig: () => true,
	hasPhpstanConfig: () => true,
	hasStylelintConfig: () => true,
	hasYamllintConfig: () => true,
}));

vi.mock("../../../../clients/rust-client.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/rust-client.js")
	>()),
	rustClient: { findCargoPathAsync: async () => "/usr/bin/cargo" },
}));

vi.mock("../../../../clients/go-client.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/go-client.js")
	>()),
	goClient: { findGoPathAsync: async () => "/usr/local/bin/go" },
}));

vi.mock("../../../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/lsp/index.js")
	>()),
	getLSPService: () =>
		makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			openFile: async () => undefined,
			touchFile: lspTouch,
			getDiagnostics: async () => [],
			codeAction: async () => [],
		}),
}));

vi.mock("../../../../clients/warm-attach.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/warm-attach.js")
	>()),
	tryWarmAttachedDiagnostics: async () => undefined,
	tryWarmAttachedCodeActions: async () => undefined,
}));

// tree-sitter's entity diff fires background blast-radius work on a non-empty
// diff (tests/support/real-runner-ctx.ts documents the race). Keep it empty.
vi.mock(
	"../../../../clients/review-graph/service.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/review-graph/service.js")
		>()),
		recordEntitySnapshotDiff: () => ({ added: [], removed: [], modified: [] }),
	}),
);

// The napi runner stands down when the ast-grep binary can back the LSP.
vi.mock(
	"../../../../clients/lsp/wait-policy/index.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/lsp/wait-policy/index.js")
		>()),
		resolveAstGrepNativeExe: () => undefined,
	}),
);

// Registers the production fact rules (cors-wildcard among them), exactly as
// the extension does at load.
await import("../../../../clients/dispatch/integration.js");
const { createDispatchContext, dispatchForFile, RunnerRegistry } =
	await import("../../../../clients/dispatch/dispatcher.js");
const { registerDefaultRunners } =
	await import("../../../../clients/dispatch/runners/index.js");

const MARKER = "lens3781";
const FIXTURES = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../fixtures",
);

interface SpawnCall {
	cmd: string;
	args: string[];
	/** The dispatched file, absolute and normalized (`ctx.filePath`). */
	filePath: string;
}

interface SpawnReply {
	status: number | null;
	stdout?: string;
	stderr?: string;
}

interface Driver {
	/** The dispatched file, POSIX-relative to the project root. */
	file: string;
	content: string;
	/** Config files and markers the runner's own gates need. */
	prepare?(root: string): void;
	/** The tool's reply; absent for the in-process runners. */
	reply?(call: SpawnCall): SpawnReply;
	/** Content facts, for the fact-rule pipeline. */
	seedFacts?: boolean;
	/** The status this runner reports for these findings, on master and after. */
	status: "succeeded" | "failed";
	/** Identifies the tool's own finding when the output cannot carry MARKER. */
	finding?: (diagnostic: RunnerResult["diagnostics"][number]) => boolean;
}

const json = (value: unknown) => JSON.stringify(value);

/** gleam's own codespan rendering (see reported-path-attribution.test.ts). */
function gleamStderr(reported: string): string {
	const upstream = fs.readFileSync(
		path.join(
			FIXTURES,
			"gleam-codespan/gleam-v1.18.1-assert-mismatched-types.snap.txt",
		),
		"utf8",
	);
	const marker = "----- ERROR\n";
	const rendered = upstream.slice(upstream.indexOf(marker) + marker.length);
	return rendered.replace(
		/^(\s*┌─ )(\S.*):(\d+):(\d+)$/m,
		(_all, gutter, _file, line, column) =>
			`${gutter}${reported}:${line}:${column}`,
	);
}

const DRIVERS: Record<string, Driver> = {
	actionlint: {
		file: ".github/workflows/ci.yml",
		content: "on: push\njobs: {}\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json([
				{
					message: MARKER,
					filepath: filePath,
					line: 4,
					column: 5,
					kind: "syntax-check",
				},
			]),
		}),
	},
	"ast-grep-napi": {
		// The same fixture ast-grep-napi-html-embed.test.ts drives through the
		// real addon: `eval` in an inline script is a blocking finding.
		file: "src/embed.html",
		content: [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<script>",
			'  eval("x");',
			"</script>",
			"</body>",
			"</html>",
		].join("\n"),
		status: "failed",
		finding: (d) => d.rule === "no-global-eval-js",
	},
	"biome-check-json": {
		file: "src/app.ts",
		content: "export const a = 1;\n",
		prepare: (root) => fs.writeFileSync(path.join(root, "biome.json"), "{}"),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json({
				diagnostics: [
					{
						severity: "error",
						category: "lint/suspicious/noDebugger",
						message: MARKER,
						location: {
							path: filePath,
							start: { line: 4, column: 5 },
							end: { line: 4, column: 6 },
						},
					},
				],
			}),
		}),
	},
	"cpp-check": {
		file: "src/a.c",
		content: "int main(void){return 0;}\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stderr: `${filePath}:4:5: error: 'q' undeclared (${MARKER})\n`,
		}),
	},
	credo: {
		file: "lib/app.ex",
		content: "defmodule App do\nend\n",
		prepare: (root) =>
			fs.writeFileSync(
				path.join(root, "mix.exs"),
				"defmodule Demo.MixProject do end\n",
			),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json({
				issues: [
					{
						filename: filePath,
						line_no: 4,
						column: 5,
						message: MARKER,
						category: "warning",
						check: "Credo.Check.Warning.IoInspect",
						priority: 10,
					},
				],
			}),
		}),
	},
	"cue-vet": {
		file: "config.cue",
		content: "package demo\n\na: int\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stderr: `a: conflicting values int and "hello" (${MARKER}):\n    ${filePath}:4:5\n`,
		}),
	},
	"dart-analyze": {
		file: "lib/main.dart",
		content: "void main() {}\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stderr: `ERROR|COMPILE_TIME_ERROR|UNDEFINED_IDENTIFIER|${filePath}|4|5|3|Undefined name 'q' (${MARKER})\n`,
		}),
	},
	detekt: {
		file: "src/Main.kt",
		content: "fun main() {}\n",
		prepare: (root) =>
			fs.writeFileSync(
				path.join(root, "detekt.yml"),
				"build:\n  maxIssues: 0\n",
			),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: `${filePath}:4:5: error: magic number (${MARKER}) [MagicNumber]\n`,
		}),
	},
	"dotnet-build": {
		file: "Program.cs",
		content: "class Program {}\n",
		prepare: (root) =>
			fs.writeFileSync(
				path.join(root, "Demo.csproj"),
				'<Project Sdk="Microsoft.NET.Sdk" />\n',
			),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: `${filePath}(4,5): error CS0103: The name 'q' does not exist (${MARKER})\n`,
		}),
	},
	"elixir-check": {
		file: "lib/app.ex",
		content: "defmodule App do\n",
		prepare: (root) =>
			fs.writeFileSync(
				path.join(root, "mix.exs"),
				"defmodule Demo.MixProject do end\n",
			),
		status: "failed",
		reply: () => ({
			status: 1,
			stderr: `** (SyntaxError) lib/app.ex:1:1: unexpected end of file ${MARKER}`,
		}),
	},
	eslint: {
		file: "src/app.ts",
		content: "export const a = 1;\n",
		prepare: (root) =>
			fs.writeFileSync(
				path.join(root, "eslint.config.js"),
				"export default [];\n",
			),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json([
				{
					filePath,
					messages: [
						{
							ruleId: "no-debugger",
							severity: 2,
							message: MARKER,
							line: 4,
							column: 5,
						},
					],
				},
			]),
		}),
	},
	"fact-rules": {
		file: "src/server.ts",
		content: 'res.setHeader("Access-Control-Allow-Origin", "*");\n',
		seedFacts: true,
		status: "failed",
		finding: (d) => d.rule === "cors-wildcard",
	},
	"fish-indent": {
		file: "config.fish",
		content: "echo 'unterminated\n",
		status: "failed",
		reply: () => ({
			status: 1,
			stderr: `config.fish (line 4): Unexpected end of string, quotes are not balanced ${MARKER}\n`,
		}),
	},
	"gleam-check": {
		file: "src/app.gleam",
		content: "pub fn main() {\n  assert 10\n}\n",
		prepare: (root) =>
			fs.writeFileSync(path.join(root, "gleam.toml"), 'name = "demo"\n'),
		status: "failed",
		// gleam's located finding is upstream's own bytes, so no MARKER; the
		// nonzero-no-diagnostics fault row is excluded by id.
		finding: (d) => d.id !== "gleam-check-nonzero-no-diagnostics",
		reply: ({ filePath }) => ({ status: 1, stderr: gleamStderr(filePath) }),
	},
	"go-vet": {
		file: "main.go",
		content: "package main\n",
		prepare: (root) =>
			fs.writeFileSync(path.join(root, "go.mod"), "module demo\n"),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stderr: `${filePath}:4:5: printf: wrong type (${MARKER})\n`,
		}),
	},
	"golangci-lint": {
		file: "main.go",
		content: "package main\n",
		prepare: (root) => {
			fs.writeFileSync(path.join(root, "go.mod"), "module demo\n");
			fs.writeFileSync(
				path.join(root, ".golangci.yml"),
				"run:\n  timeout: 1m\n",
			);
		},
		status: "failed",
		reply: ({ args, filePath }) =>
			args.includes("run")
				? {
						status: 1,
						stdout: json({
							Issues: [
								{
									FromLinter: "govet",
									Text: MARKER,
									Severity: "error",
									Pos: { Filename: filePath, Line: 4, Column: 5 },
								},
							],
						}),
					}
				: { status: 0, stdout: "ok" },
	},
	hadolint: {
		file: "Dockerfile",
		content: "FROM alpine\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json([
				{
					file: filePath,
					line: 4,
					column: 5,
					level: "error",
					code: "DL3000",
					message: MARKER,
				},
			]),
		}),
	},
	"helm-lint": {
		file: "chart/templates/deployment.yaml",
		content: "value\n",
		prepare: (root) =>
			fs.writeFileSync(
				path.join(root, "chart", "Chart.yaml"),
				"apiVersion: v2\nname: test\nversion: 0.1.0\n",
			),
		status: "succeeded",
		reply: () => ({
			status: 1,
			stdout: `[ERROR] templates/deployment.yaml:3: invalid template ${MARKER}\n`,
			stderr: "Error: 1 chart(s) linted, 1 chart(s) failed",
		}),
	},
	"helm-render": {
		file: "broken-chart/templates/deployment.yaml",
		content: "",
		prepare: (root) => {
			fs.cpSync(
				path.join(FIXTURES, "helm-render", "broken-chart"),
				path.join(root, "broken-chart"),
				{ recursive: true },
			);
			fs.writeFileSync(
				path.join(root, ".pi-lens.json"),
				json({ helm: { renderValidation: { enabled: true } } }),
			);
		},
		status: "succeeded",
		reply: ({ args }) =>
			args[0] === "template"
				? {
						status: 1,
						stderr: `Error: template: pi-lens-render-broken/templates/deployment.yaml:12:20: executing "pi-lens-render-broken/templates/deployment.yaml" at <.Values.image.registry.host>: nil pointer evaluating interface {}.host ${MARKER}`,
					}
				: { status: 0, stdout: "{}" },
	},
	htmlhint: {
		file: "src/app.html",
		content: "<div>\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: `${filePath}:4:5: ${MARKER} [error/tag-pair]\n`,
		}),
	},
	javac: {
		file: "src/App.java",
		content: "class App {}\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stderr: `${filePath}:4: error: cannot find symbol (${MARKER})\n`,
		}),
	},
	ktlint: {
		// ktlint's parser emits only `warning`, so its findings never fail.
		file: "src/App.kt",
		content: "val a = 1\n",
		status: "succeeded",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json([
				{
					file: filePath,
					errors: [
						{ line: 4, col: 5, detail: MARKER, ruleId: "standard:indent" },
					],
				},
			]),
		}),
	},
	lsp: {
		file: "src/main.ts",
		content: "const a: string = 1;\n",
		status: "failed",
	},
	markdownlint: {
		file: "docs/app.md",
		content: "# hello\n",
		status: "succeeded",
		reply: ({ filePath }) => ({
			status: 1,
			stderr: `${filePath}:4:5 MD013/line-length ${MARKER}\n`,
		}),
	},
	mypy: {
		file: "src/app.py",
		content: "x: int = 'a'\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: `${filePath}:4:5: error: Incompatible types (${MARKER})  [assignment]\n`,
		}),
	},
	oxlint: {
		file: "src/app.js",
		content: "debugger;\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json({
				diagnostics: [
					{
						message: MARKER,
						code: "eslint(no-debugger)",
						severity: "error",
						filename: filePath,
						labels: [{ span: { line: 4, column: 5 } }],
					},
				],
				number_of_files: 1,
				number_of_rules: 1,
				threads_count: 1,
				start_time: 0,
			}),
		}),
	},
	"php-lint": {
		file: "src/app.php",
		content: "<?php\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 255,
			stdout: `PHP Parse error:  ${MARKER} in ${filePath} on line 4\n`,
		}),
	},
	phpstan: {
		file: "src/app.php",
		content: "<?php\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json({
				totals: { errors: 0, file_errors: 1 },
				files: {
					[filePath]: {
						errors: 1,
						messages: [{ message: MARKER, line: 4, ignorable: true }],
					},
				},
				errors: [],
			}),
		}),
	},
	"prisma-validate": {
		file: "schema.prisma",
		content: "model User {\n  id Int @id\n  posts Post[]\n}\n",
		status: "failed",
		// prisma 6.16.2's own report, captured from `prisma validate` on a pipe
		// (colour codes included); only the unknown type's name carries MARKER.
		reply: () => ({
			status: 1,
			stdout: "Prisma schema loaded from schema.prisma\n",
			stderr: [
				"",
				"Error: Prisma schema validation - (validate wasm)",
				"Error code: P1012",
				`\u001b[1;91merror\u001b[0m: \u001b[1mType "Post${MARKER}" is neither a built-in type, nor refers to another model, composite type, or enum.\u001b[0m`,
				"  \u001b[1;94m-->\u001b[0m  \u001b[4mschema.prisma:3\u001b[0m",
				"",
				"Validation Error Count: 1",
				"[Context: validate]",
				"",
				"Prisma CLI Version : 6.16.2",
				"",
			].join("\n"),
		}),
	},
	psscriptanalyzer: {
		file: "script.ps1",
		content: "Write-Host 'x'\n",
		status: "failed",
		reply: () => ({
			status: 0,
			stdout: json([
				{
					Message: MARKER,
					Line: 4,
					Column: 5,
					Severity: "Error",
					RuleName: "PSAvoidUsingCmdletAliases",
				},
			]),
		}),
	},
	pyright: {
		file: "src/app.py",
		content: "x: int = 'a'\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json({
				generalDiagnostics: [
					{
						file: filePath,
						severity: "error",
						message: MARKER,
						range: { start: { line: 3, character: 4 } },
						rule: "reportAssignmentType",
					},
				],
			}),
		}),
	},
	rubocop: {
		file: "src/app.rb",
		content: "puts 1\n",
		status: "failed",
		// The first spawn is the `--version` probe in
		// resolveCommandArgsWithInstallFallback.
		reply: ({ args, filePath }) =>
			args.includes("--version")
				? { status: 0, stdout: "1.66.0" }
				: {
						status: 1,
						stdout: json({
							files: [
								{
									path: filePath,
									offenses: [
										{
											severity: "error",
											message: MARKER,
											cop_name: "Lint/Syntax",
											correctable: false,
											location: { line: 4, column: 5 },
										},
									],
								},
							],
						}),
					},
	},
	"ruff-lint": {
		file: "src/app.py",
		content: "x = y\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json([
				{
					code: "F821",
					message: MARKER,
					filename: filePath,
					location: { row: 4, column: 5 },
					severity: "error",
				},
			]),
		}),
	},
	"rust-clippy": {
		// #3775: clippy reports the run outcome, so a deny-level lint is
		// `succeeded` with blocking diagnostics. The contract allows that for a
		// runner outside a multi-member fallback group.
		file: "src/main.rs",
		content: "fn main() {}\n",
		prepare: (root) =>
			fs.writeFileSync(
				path.join(root, "Cargo.toml"),
				'[package]\nname = "demo"\nversion = "0.1.0"\n',
			),
		status: "succeeded",
		reply: ({ filePath }) => ({
			status: 101,
			stdout: `${[
				json({
					reason: "compiler-message",
					message: {
						code: { code: "clippy::eq_op" },
						message: `equal expressions as operands to \`==\` (${MARKER})`,
						level: "error",
						spans: [
							{
								file_name: filePath,
								line_start: 4,
								column_start: 5,
								is_primary: true,
							},
						],
					},
				}),
				json({ reason: "build-finished", success: false }),
			].join("\n")}\n`,
		}),
	},
	shellcheck: {
		file: "src/app.sh",
		content: "echo $x\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json([
				{
					file: filePath,
					line: 4,
					column: 5,
					level: "error",
					code: 1000,
					message: MARKER,
				},
			]),
		}),
	},
	shfmt: {
		// exit >1 is shfmt's parse error: the file does not parse, a finding.
		file: "src/app.sh",
		content: "echo 'unterminated\n",
		status: "failed",
		reply: () => ({
			status: 2,
			stderr: `src/app.sh:4:5: reached EOF without closing quote ' ${MARKER}\n`,
		}),
	},
	spellcheck: {
		file: "docs/app.md",
		content: "# hello\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 2,
			stdout: json({
				path: filePath,
				line_num: 4,
				byte_offset: 5,
				typo: MARKER,
				corrections: ["marker"],
			}),
		}),
	},
	spotbugs: {
		file: "src/Foo.java",
		content: "class Foo {}\n",
		prepare: (root) => {
			const classes = path.join(root, "target", "classes");
			fs.mkdirSync(classes, { recursive: true });
			fs.writeFileSync(
				path.join(classes, "Foo.class"),
				Buffer.from([0xca, 0xfe]),
			);
		},
		status: "succeeded",
		reply: ({ args }) => {
			const out = args.indexOf("-output");
			if (out >= 0) {
				fs.writeFileSync(
					args[out + 1],
					`<BugCollection>
  <BugInstance type="NP_ALWAYS_NULL" priority="1" category="CORRECTNESS">
    <ShortMessage>Null pointer dereference ${MARKER}</ShortMessage>
    <LongMessage>Null pointer dereference of x in Foo.bar()</LongMessage>
    <SourceLine primary="true" start="7" end="7" sourcefile="Foo.java" sourcepath="Foo.java"/>
  </BugInstance>
</BugCollection>`,
				);
			}
			return { status: 0 };
		},
	},
	sqlfluff: {
		file: "src/app.sql",
		content: "select 1\n",
		prepare: (root) =>
			fs.writeFileSync(
				path.join(root, ".sqlfluff"),
				"[sqlfluff]\ndialect = ansi\n",
			),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json([
				{
					filepath: filePath,
					violations: [
						{ code: "LT01", description: MARKER, line_no: 4, line_pos: 5 },
					],
				},
			]),
		}),
	},
	stylelint: {
		file: "src/app.css",
		content: "a { color: red }\n",
		prepare: (root) =>
			fs.writeFileSync(path.join(root, ".stylelintrc.json"), "{}"),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 2,
			stdout: json([
				{
					source: filePath,
					warnings: [
						{
							line: 4,
							column: 5,
							rule: "color-no-invalid-hex",
							severity: "error",
							text: MARKER,
						},
					],
				},
			]),
		}),
	},
	swiftlint: {
		file: "src/app.swift",
		content: "let a = 1\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 2,
			stdout: json([
				{
					file: filePath,
					line: 4,
					character: 5,
					severity: "Error",
					reason: MARKER,
					rule_id: "force_cast",
				},
			]),
		}),
	},
	taplo: {
		file: "src/app.toml",
		content: "[package\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stderr: `error: invalid TOML ${MARKER}\n  ┌─ ${filePath}:4:5\n  │\n4 │ [package\n`,
		}),
	},
	terragrunt: {
		file: "terragrunt.hcl",
		content: "inputs = {\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json([
				{
					summary: MARKER,
					severity: "error",
					range: { filename: filePath, start: { line: 4, column: 5 } },
				},
			]),
		}),
	},
	tflint: {
		file: "src/main.tf",
		content: 'resource "x" "y" {}\n',
		status: "failed",
		reply: ({ filePath }) => ({
			status: 2,
			stdout: json({
				issues: [
					{
						rule: { name: "terraform_typed_variables", severity: "error" },
						message: MARKER,
						range: { filename: filePath, start: { line: 4, column: 5 } },
					},
				],
				errors: [],
			}),
		}),
	},
	"tree-sitter": {
		file: "src/app.py",
		content: [
			"class Widget:",
			"    def __init__(self):",
			"        self.value = 1",
			"        return self.value",
			"",
		].join("\n"),
		status: "failed",
		finding: (d) => d.rule === "return-in-init",
	},
	"trivy-config": {
		file: "src/main.tf",
		content: 'resource "x" "y" {}\n',
		prepare: (root) =>
			fs.writeFileSync(
				path.join(root, ".pi-lens.json"),
				json({ trivy: { enabled: true } }),
			),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 0,
			stdout: json({
				Results: [
					{
						Target: filePath,
						Misconfigurations: [
							{
								ID: "AVD-AWS-0001",
								Title: MARKER,
								Severity: "CRITICAL",
								CauseMetadata: { StartLine: 4 },
							},
						],
					},
				],
			}),
		}),
	},
	vale: {
		file: "docs/app.md",
		content: "# hello\n",
		prepare: (root) =>
			fs.writeFileSync(path.join(root, ".vale.ini"), "StylesPath = styles\n"),
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: json({
				[filePath]: [
					{
						Check: "Vale.Spelling",
						Message: MARKER,
						Line: 4,
						Span: [5, 6],
						Severity: "error",
					},
				],
			}),
		}),
	},
	yamllint: {
		file: "src/app.yaml",
		content: "name: a\nname: b\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stdout: `${filePath}:4:5: [error] ${MARKER} (key-duplicates)\n`,
		}),
	},
	"zig-check": {
		file: "src/main.zig",
		content: "pub fn main() void {}\n",
		status: "failed",
		reply: ({ filePath }) => ({
			status: 1,
			stderr: `${filePath}:4:5: error: expected type 'u8' (${MARKER})\n`,
		}),
	},
};

interface Observed {
	result: RunnerResult | undefined;
	row:
		| { status: string; failureKind?: string; diagnosticCount: number }
		| undefined;
	/** The latency.log runner row's metadata, as the log analyzer reads it. */
	logged: { failureKind?: string } | undefined;
}

async function drive(runnerId: string, driver: Driver): Promise<Observed> {
	safeSpawnAsync.mockReset();
	lspTouch.mockReset();
	logLatency.mockClear();
	const env = setupTestEnvironment(`pi-lens-3781-${runnerId}-`);
	try {
		const root = path.join(env.tmpDir, "workspace");
		const absFile = path.join(root, ...driver.file.split("/"));
		fs.mkdirSync(path.dirname(absFile), { recursive: true });
		fs.writeFileSync(absFile, driver.content);
		driver.prepare?.(root);

		const registry = new RunnerRegistry();
		registerDefaultRunners(registry);
		const facts = new FactStore();
		const ctx = createDispatchContext(
			absFile,
			root,
			{ getFlag: () => false } as never,
			facts,
		);
		if (driver.seedFacts) {
			facts.setFileFact(ctx.filePath, "file.content", driver.content);
		}
		safeSpawnAsync.mockImplementation(
			async (cmd: string, args: string[] = []) => ({
				error: null,
				stdout: "",
				stderr: "",
				...driver.reply?.({ cmd, args, filePath: ctx.filePath }),
			}),
		);
		// The LSP runner's language server answers with one error-severity
		// diagnostic (LSP severity 1), the shape runner-status-semantics uses.
		lspTouch.mockResolvedValue({
			diags: [
				{
					severity: 1,
					message: MARKER,
					range: {
						start: { line: 0, character: 6 },
						end: { line: 0, character: 7 },
					},
					code: "2322",
				},
			],
		});

		let result: RunnerResult | undefined;
		const dispatched = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: [runnerId] }],
			registry,
			(id, runnerResult) => {
				if (id === runnerId) result = runnerResult;
			},
		);
		return {
			result,
			row: dispatched.latencyReport?.runners.find(
				(runner) => runner.runnerId === runnerId,
			),
			logged: logLatency.mock.calls
				.map(([entry]) => entry)
				.find(
					(entry) => entry?.type === "runner" && entry.runnerId === runnerId,
				)?.metadata,
		};
	} finally {
		env.cleanup();
	}
}

describe("runner findings carry failureKind when they fail the check (#3781)", () => {
	it("has exactly one findings driver per registered runner", () => {
		const registry = new RunnerRegistry();
		registerDefaultRunners(registry);
		const registered = registry
			.list()
			.map((runner) => runner.id)
			.sort();
		expect(
			registered,
			"registered runners without a DRIVERS row fail first; a DRIVERS row for an unregistered runner fails the other way",
		).toEqual(Object.keys(DRIVERS).sort());
	});

	it.each(Object.entries(DRIVERS))(
		"%s reports its findings as succeeded, or failed with blocking_diagnostics",
		async (runnerId, driver) => {
			const observed = await drive(runnerId, driver);
			const result = observed.result;
			expect(result, `${runnerId} never ran`).toBeDefined();
			if (!result) return;

			const isFinding =
				driver.finding ??
				((d: RunnerResult["diagnostics"][number]) =>
					d.message.includes(MARKER));
			expect(
				result.diagnostics.some(isFinding),
				`${runnerId} did not surface the tool's finding: ${JSON.stringify(result)}`,
			).toBe(true);

			expect(result.status).toBe(driver.status);
			expect(result.failureKind).toBe(
				driver.status === "failed" ? "blocking_diagnostics" : undefined,
			);

			// The in-memory latency row MCP reads carries the same answer (F7),
			// and so does the latency.log row the log analyzer reads.
			expect(observed.row?.status).toBe(result.status);
			expect(observed.row?.failureKind).toBe(result.failureKind);
			expect(observed.logged?.failureKind).toBe(result.failureKind);
		},
		30_000,
	);

	// A hand-rolled ternary's other arm: findings below the runner's threshold
	// stay `succeeded` and carry no kind (Stryker survivor on detekt.ts:203,
	// `"succeeded"` → `""`, #3800).
	it("keeps a warning-only detekt run succeeded without failureKind", async () => {
		const observed = await drive("detekt", {
			...DRIVERS.detekt,
			reply: ({ filePath }) => ({
				status: 1,
				stdout: `${filePath}:4:5: warning: magic number (${MARKER}) [MagicNumber]\n`,
			}),
		});
		expect(observed.result?.status).toBe("succeeded");
		expect(observed.result?.semantic).toBe("warning");
		expect(observed.result?.failureKind).toBeUndefined();
	});

	// The dangerous inverse (F4): a run that produced no usable result must never
	// read as findings. One row per fault arm that returns `failed`: stamping
	// blocking_diagnostics on any of them would tell the analyzer and the MCP
	// consumer "the file has problems" when nothing was checked (#3800 review
	// F1: four of these arms took the stamp with the whole suite green).
	const FAULT_ARMS: ReadonlyArray<
		readonly [
			name: string,
			runnerId: string,
			reply: Driver["reply"],
			ids: string[],
			// #3796: an arm that returns a synthetic diagnostic names its fault.
			kind: string | undefined,
		]
	> = [
		[
			"finishParsedRun parse-error (eslint)",
			"eslint",
			() => ({ status: 2, stdout: "Oops! Something went wrong" }),
			["eslint:parse-error:1"],
			"parser_error",
		],
		[
			"biome JSON parse error",
			"biome-check-json",
			() => ({ status: 1, stdout: `not json ${MARKER}` }),
			["biome:parse-error:1"],
			"parser_error",
		],
		[
			"pyright JSON catch",
			"pyright",
			() => ({ status: 1, stdout: `Traceback ${MARKER}` }),
			[],
			undefined,
		],
		[
			"cue-vet unattributable output",
			"cue-vet",
			() => ({ status: 1, stderr: `cue: internal failure ${MARKER}\n` }),
			["cue-vet-unparsed"],
			"unconfirmed_output",
		],
		[
			"gleam nonzero exit with no diagnostics",
			"gleam-check",
			() => ({
				status: 1,
				stderr: `gleam: could not load project ${MARKER}\n`,
			}),
			["gleam-check-nonzero-no-diagnostics"],
			"unconfirmed_output",
		],
		[
			"spotbugs with no report file",
			"spotbugs",
			() => ({ status: 2, stderr: `spotbugs crashed ${MARKER}` }),
			[],
			undefined,
		],
		[
			"rust-clippy unparsable output",
			"rust-clippy",
			() => ({ status: 101, stdout: `garbage ${MARKER}\n` }),
			[],
			undefined,
		],
		[
			// Real npm 9.2.0 bytes for `npx --no prisma` with nothing to run
			// (#3800 review F2): a tool that never validated the schema.
			"prisma-validate npm E404",
			"prisma-validate",
			() => ({
				status: 1,
				stderr: [
					"npm ERR! code E404",
					"npm ERR! 404 Not Found - GET https://registry.npmjs.org/prisma - Not found",
					"npm ERR! 404 ",
					"npm ERR! 404  'prisma@*' is not in this registry.",
					"",
				].join("\n"),
			}),
			["prisma-validate:parse-error:1"],
			"parser_error",
		],
	];

	it.each(FAULT_ARMS)(
		"%s stays failed without blocking_diagnostics",
		async (_name, runnerId, reply, ids, kind) => {
			const driver = DRIVERS[runnerId];
			if (!driver) throw new Error(`no driver for ${runnerId}`);
			const observed = await drive(runnerId, { ...driver, reply });
			expect(observed.result?.status).toBe("failed");
			expect(observed.result?.diagnostics.map((d) => d.id)).toEqual(ids);
			expect(observed.result?.failureKind).not.toBe("blocking_diagnostics");
			expect(observed.row?.failureKind).not.toBe("blocking_diagnostics");
			// The coverage rule's owner reads it as no usable result.
			expect(hasUsableResult(observed.result as RunnerResult)).toBe(false);
			if (kind !== undefined) {
				expect(observed.result?.failureKind).toBe(kind);
				expect(observed.row?.failureKind).toBe(kind);
				expect(observed.logged?.failureKind).toBe(kind);
				expect(observed.result?.failureMessage).toBeTruthy();
			}
		},
	);
});
