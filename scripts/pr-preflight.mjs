#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CI_JOB_NAMES } from "./lib/ci-checks.mjs";

export const GATES = [
	["build", ["npm", "run", "build"], CI_JOB_NAMES.LINT_AND_TYPECHECK],
	["lint", ["npm", "run", "lint"], CI_JOB_NAMES.LINT_AND_TYPECHECK],
	["fmt:check", ["npm", "run", "fmt:check"], "oxfmt format check (advisory)"],
	["changelog:check", ["npm", "run", "changelog:check"], "Unit tests"],
	[
		"check-changelog-fragments",
		[process.execPath, "scripts/check-changelog-fragments.mjs"],
		CI_JOB_NAMES.CHANGELOG_FRAGMENT,
	],
	[
		"check:lockfile",
		["npm", "run", "check:lockfile"],
		CI_JOB_NAMES.LINT_AND_TYPECHECK,
	],
	[
		"lockfile:complete",
		["npm", "run", "check:lockfile", "--", "--complete"],
		CI_JOB_NAMES.LINT_AND_TYPECHECK,
	],
	["tests/config", ["tests/config/"], CI_JOB_NAMES.UNIT_TESTS],
	[
		"generation-guard",
		["tests/clients/generation-guard-sweep.test.ts"],
		CI_JOB_NAMES.UNIT_TESTS,
	],
	[
		"flake-shape-ratchet",
		["tests/clients/flake-shape-ratchet.test.ts"],
		CI_JOB_NAMES.UNIT_TESTS,
	],
	[
		"lsp-spawn-heavy-coverage",
		["tests/config/lsp-spawn-heavy-coverage.test.ts"],
		CI_JOB_NAMES.UNIT_TESTS,
	],
	["ci-verdict", ["tests/scripts/ci-verdict.test.ts"], CI_JOB_NAMES.UNIT_TESTS],
];
const TEST_GATE_NAMES = new Set([
	"tests/config",
	"generation-guard",
	"flake-shape-ratchet",
	"lsp-spawn-heavy-coverage",
	"ci-verdict",
]);
const HARD_GATE_SKIP_REASON =
	"hard gate: unformatted files merged and redded master twice on 2026-09-09";

export function parseArgs(argv) {
	const result = { only: undefined, skip: undefined };
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--only") result.only = argv[++index];
		else if (argv[index] === "--skip") result.skip = argv[++index];
		else throw new Error(`Unknown argument: ${argv[index]}`);
	}
	if (!result.only && !result.skip) return result;
	if (result.only === "" || result.skip === "")
		throw new Error("--only and --skip require a gate name");
	if (result.skip === "fmt:check" || result.skip === "build")
		throw new Error(
			`--skip ${result.skip} is not allowed: ${HARD_GATE_SKIP_REASON}`,
		);
	return result;
}

function validateSelectors({ only, skip }, gates) {
	const validNames = gates.map(({ name }) => name);
	for (const [selector, value] of [
		["--only", only],
		["--skip", skip],
	]) {
		if (value && !validNames.includes(value))
			throw new Error(
				`${selector} ${value} is not a gate; valid gate names: ${validNames.join(", ")}`,
			);
	}
}

function firstRedLine(output) {
	const lines = String(output ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return (
		lines.find((line) =>
			/\b(?:FAIL|error|failed|failure|assertion)\b/i.test(line),
		) ??
		lines[0] ??
		"(no output)"
	);
}

function runChild(command, cwd, env, spawn) {
	const [file, ...args] = command;
	let result;
	try {
		result = spawn(
			file === "npm" && process.platform === "win32" ? "npm.cmd" : file,
			args,
			{
				cwd,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		return {
			code: 1,
			firstRed: error instanceof Error ? error.message : String(error),
		};
	}
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	return {
		code: typeof result.status === "number" ? result.status : 1,
		firstRed: firstRedLine(output),
	};
}

function makeLocalEvent(cwd, env) {
	const titlePath = resolve(cwd, "COMMIT_MSG.txt");
	const bodyPath = resolve(cwd, "PR_BODY.md");
	if (!existsSync(titlePath) || !existsSync(bodyPath)) return env;
	const probeHome = resolve(cwd, ".probe-home");
	mkdirSync(probeHome, { recursive: true });
	const eventPath = resolve(probeHome, "preflight-event.json");
	writeFileSync(
		eventPath,
		JSON.stringify({
			pull_request: {
				number: 1,
				title: readFileSync(titlePath, "utf8").split(/\r?\n/, 1)[0],
				body: readFileSync(bodyPath, "utf8"),
			},
		}),
	);
	return {
		...env,
		GITHUB_EVENT_PATH: eventPath,
		GITHUB_REPOSITORY: env.GITHUB_REPOSITORY ?? "local/preflight",
	};
}

export function formatSummary(rows) {
	const headers = ["gate", "mirrored CI job", "pass/fail", "first red line"];
	const values = rows.map((row) => [
		row.gate,
		row.job,
		row.code === 0 ? "pass" : "FAIL",
		row.code === 0 ? "" : row.firstRed,
	]);
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...values.map((row) => row[index].length)),
	);
	const line = (row) =>
		`| ${row.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
	return [
		line(headers),
		`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
		...values.map(line),
	].join("\n");
}

export function runPreflight({
	cwd = process.cwd(),
	argv = [],
	spawn = spawnSync,
	env = process.env,
} = {}) {
	const { only, skip } = parseArgs(argv);
	const childEnv = {
		...env,
		PI_LENS_HOME: env.PI_LENS_HOME ?? resolve(cwd, ".probe-home"),
	};
	const gates = GATES.map(([name, command, job]) => ({
		name,
		command: TEST_GATE_NAMES.has(name)
			? [
					process.execPath,
					"scripts/with-test-lock.mjs",
					"--shared",
					"--",
					"node_modules/.bin/vitest",
					"run",
					...command,
					"--configLoader",
					"runner",
				]
			: command,
		job,
	}));
	const localEnv = makeLocalEvent(cwd, childEnv);
	if (localEnv.GITHUB_EVENT_PATH) {
		gates.push(
			{
				name: "check-pr-title",
				command: [
					process.execPath,
					"scripts/check-pr-title.mjs",
					"--lint-local",
					"COMMIT_MSG.txt",
				],
				job: "PR title",
			},
			{
				name: "check-close-keywords",
				command: [
					process.execPath,
					"scripts/check-close-keywords.mjs",
					"--lint-local",
					"COMMIT_MSG.txt",
					"PR_BODY.md",
				],
				job: "Close-keyword syntax",
			},
			{
				name: "check-pr-body",
				command: [
					process.execPath,
					"scripts/check-pr-body.mjs",
					"--lint-local",
					"PR_BODY.md",
				],
				job: "PR body (advisory)",
			},
		);
	}
	validateSelectors({ only, skip }, gates);
	const rows = gates
		.filter(({ name }) => (!only || name === only) && name !== skip)
		.map(({ name, command, job }) => ({
			gate: name,
			job,
			...runChild(command, cwd, localEnv, spawn),
		}));
	console.log(formatSummary(rows));
	return rows.some((row) => row.code !== 0) ? 1 : 0;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
	try {
		process.exitCode = runPreflight({ argv: process.argv.slice(2) });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
