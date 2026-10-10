#!/usr/bin/env node
// One pre-handback gate for delegated lanes (#4047).
//
// The result is one tri-state verdict and the exit code derives from it:
//   clean       exit 0  every step ran and no red is caused by the change
//   red-caused  exit 1  a failing test (or a tracked handoff file) is the change's
//   unproven    exit 3  a step failed or a red could not be attributed; it says
//                       nothing about the change and is never "unrelated"
// Only `clean` exits 0. A red that fails on the base too (RED-ON-BASE) is not
// caused by the change and stays `clean`; it is listed in the record.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVitestSummary } from "./lib/vitest-summary.mjs";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import {
	changedFiles as committedChangedFiles,
	findStaleDistFiles,
	worktreeChangedFiles,
} from "./pre-push-targeted-tests.mjs";

const BASE = "origin/master";
// Room for a 137-file governance batch: spawnSync's 1 MiB default kills the
// child and turns a long transcript into a lost verdict.
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const HANDOFF_FILES = ["PR_BODY.md", "COMMIT_MSG.txt"];

export const LANE_EXIT = { clean: 0, "red-caused": 1, unproven: 3 };
const USAGE_EXIT = 2;
const CAPPED_REMEDY =
	"selection capped: run the full suite or narrow the change";

// A red-on-base per-test line: `<VERDICT>  <file> > <test name>`.
const PER_TEST_LINE =
	/^(CAUSED-BY-CHANGE|RED-ON-BASE|INCONCLUSIVE)  (\S+?) > /gm;
const SEVERITY = { "RED-ON-BASE": 0, INCONCLUSIVE: 1, "CAUSED-BY-CHANGE": 2 };

/** The verdict of the whole lane: `red-caused` outranks `unproven`. */
export function decideLane(findings) {
	if (findings.some((finding) => finding.kind === "red-caused"))
		return "red-caused";
	if (findings.some((finding) => finding.kind === "unproven"))
		return "unproven";
	return "clean";
}

export function laneExitCode(verdict) {
	return LANE_EXIT[verdict] ?? LANE_EXIT.unproven;
}

/**
 * Per-file verdict from one `red-on-base` transcript: the worst per-test line
 * of that file. A failing file with no line (the red did not reproduce, a build
 * failure, a usage error) is INCONCLUSIVE, never RED-ON-BASE.
 */
export function classifyFailureFiles(files, redOnBaseOutput) {
	const worst = {};
	for (const [, verdict, file] of redOnBaseOutput.matchAll(PER_TEST_LINE))
		if (!(file in worst) || SEVERITY[verdict] > SEVERITY[worst[file]])
			worst[file] = verdict;
	return files.map((file) => ({
		file,
		verdict: worst[file] ?? "INCONCLUSIVE",
	}));
}

/** Test files a vitest transcript names as failing, limited to `candidates`. */
export function reportedFailureFiles(output, candidates) {
	return parseVitestSummary(output).failedFiles.filter((file) =>
		candidates.includes(file),
	);
}

/**
 * Why a failed test run cannot be pinned on named files, or null. A run that
 * exits non-zero with no failing file named (a build or self-scan failure, a
 * lock timeout, a crash), or that names fewer failing files than vitest
 * counted, is `unproven`; it is never "no reds".
 */
export function unattributedFailure(status, output, files) {
	if (status === 0) return null;
	if (!files.length)
		return `exit ${status} and no failing test file named in the output`;
	const { filesFailed } = parseVitestSummary(output);
	if (filesFailed !== null && files.length < filesFailed)
		return `exit ${status}: vitest counted ${filesFailed} failing file(s), ${files.length} named`;
	return null;
}

function run(root, commandName, args) {
	const result = spawnSync(commandName, args, {
		cwd: root,
		encoding: "utf8",
		input: "",
		maxBuffer: MAX_OUTPUT_BYTES,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}\n` : ""}`;
	process.stdout.write(output);
	return { status: result.status ?? 1, output };
}

function governanceFiles(root) {
	const words =
		/(sweep|ratchet|conformance|coverage|gate|governance|silence|hermeticity|invariant|contract)/;
	const listing = (dir, keep) =>
		readdirSync(path.join(root, dir), { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
			.filter((entry) => keep(entry.name))
			.map((entry) => `${dir}/${entry.name}`);
	return [
		...new Set([
			...listing("tests/clients", (name) => words.test(name)),
			...listing("tests/config", () => true),
		]),
	].sort();
}

const git = (root, args) =>
	gitExecFileSync(args, { cwd: root, encoding: "utf8" }).trim();

export function main(argv = process.argv.slice(2)) {
	const root = process.cwd();
	// Both `--body <path>` and `--body=<path>`. A `--body*` argument with no
	// usable path, an unknown spelling or a missing file must not read as "no
	// body": the lint would be skipped and the lane could still come out clean.
	let body = null;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--body")) continue;
		let value;
		if (arg === "--body") {
			value = argv[index + 1];
			index += 1;
		} else if (arg.startsWith("--body=")) value = arg.slice("--body=".length);
		else {
			console.error(`lane-check: unknown argument ${arg}`);
			return USAGE_EXIT;
		}
		if (!value || value.startsWith("--")) {
			console.error("lane-check: --body needs a file path");
			return USAGE_EXIT;
		}
		if (!existsSync(path.resolve(root, value))) {
			console.error(`lane-check: --body file does not exist: ${value}`);
			return USAGE_EXIT;
		}
		body = value;
	}
	const findings = [];
	const unproven = (reason) => findings.push({ kind: "unproven", reason });
	const record = { base: BASE, checks: {}, failedFiles: [], redOnBase: null };

	const build = run(root, "npm", ["run", "build"]);
	record.checks.build = build.status;
	if (build.status !== 0) {
		// Nothing below is meaningful on a stale or missing build.
		unproven(`build failed (exit ${build.status}); no test step ran`);
		return report(root, record, findings, { governance: 0, changed: 0 });
	}
	const staleDist = findStaleDistFiles(root);
	if (staleDist.length > 0) {
		console.log(
			`[lane-check] dist/ missing or stale (${staleDist.map(({ output }) => output).join(", ")}); running npm run build:dist...`,
		);
		const distBuild = run(root, "npm", ["run", "build:dist"]);
		record.checks.distBuild = distBuild.status;
		if (distBuild.status !== 0) {
			console.error(
				"[lane-check] dist build failed; run `npm run build:dist` to rebuild dist/.",
			);
			unproven(
				`dist build failed (exit ${distBuild.status}); no test step ran`,
			);
			return report(root, record, findings, { governance: 0, changed: 0 });
		}
	}

	const committed = committedChangedFiles(`${BASE}...HEAD`);
	const uncommitted = worktreeChangedFiles();
	if (committed === null || uncommitted === null)
		unproven(`could not compute the changed set against ${BASE}`);
	const changed = [
		...new Set([...(committed ?? []), ...(uncommitted ?? [])]),
	].sort();

	const targeted = run(root, process.execPath, [
		"scripts/pre-push-targeted-tests.mjs",
		"--skip-build",
		"--include-worktree",
	]);
	const selected = [
		...targeted.output.matchAll(/^\s+- (tests\/[^\s]+\.test\.ts)$/gm),
	].map((match) => match[1]);
	const targetedFailing = reportedFailureFiles(targeted.output, selected);
	// Over the selector's cap only the governance registries and history picks
	// ran, and the selector still exits 0: that is not a clean targeted run.
	const cap = targeted.output.match(
		/selection too broad \((\d+) test files matched/,
	);
	const capped = cap !== null;
	const matched = capped ? Number(cap[1]) : selected.length;
	record.checks.targeted = {
		status: targeted.status,
		failed: targetedFailing,
		selected: selected.length,
		matched,
		capped,
	};
	if (capped)
		unproven(
			`selection capped: ${matched} test files matched, ${selected.length} ran; run the full suite or narrow the change`,
		);
	const targetedGap = unattributedFailure(
		targeted.status,
		targeted.output,
		targetedFailing,
	);
	if (targetedGap) unproven(`targeted run: ${targetedGap}`);

	const governance = governanceFiles(root);
	console.log(`\n[lane-check] governance batch (${governance.length} files)`);
	const governanceRun = run(root, "npm", [
		"run",
		"test:targeted",
		"--",
		...governance,
	]);
	const governanceFailing = reportedFailureFiles(
		governanceRun.output,
		governance,
	);
	record.checks.governance = {
		status: governanceRun.status,
		failed: governanceFailing,
	};
	const governanceGap = unattributedFailure(
		governanceRun.status,
		governanceRun.output,
		governanceFailing,
	);
	if (governanceGap) unproven(`governance run: ${governanceGap}`);

	// One red-on-base run for every failing file: a file red in both sets is
	// built and compared once, not twice.
	const failing = [...new Set([...targetedFailing, ...governanceFailing])];
	if (failing.length) {
		const compared = run(root, process.execPath, [
			"scripts/red-on-base.mjs",
			...failing,
			"--base",
			BASE,
		]);
		record.redOnBase = {
			status: compared.status,
			baseTree: compared.output.includes("BASE-TREE git-archive")
				? "git-archive"
				: "worktree",
		};
		record.failedFiles = classifyFailureFiles(failing, compared.output);
		for (const { file, verdict } of record.failedFiles) {
			console.log(`${verdict}: ${file}`);
			if (verdict === "CAUSED-BY-CHANGE")
				findings.push({
					kind: "red-caused",
					reason: `${file} reds on the change`,
				});
			else if (verdict === "INCONCLUSIVE")
				unproven(`${file}: red-on-base could not attribute the red`);
		}
	}

	const touched = changed.filter((file) => existsSync(path.join(root, file)));
	const checks = {
		body: body
			? run(root, process.execPath, [
					"scripts/check-pr-body.mjs",
					"--lint-local",
					body,
				])
			: null,
		changelog: run(root, process.execPath, [
			"scripts/check-changelog-fragments.mjs",
			"--base",
			BASE,
		]),
		format: touched.length
			? run(root, "npx", [
					"oxfmt",
					"--check",
					// a change of only formatter-ignored files (docs, JSON) leaves no
					// target and oxfmt exits 2 (the pre-commit hook passes the same, #3451)
					"--no-error-on-unmatched-pattern",
					...touched,
				])
			: null,
		astgrep: run(root, "npm", ["run", "astgrep:self-scan"]),
	};
	for (const [name, result] of Object.entries(checks)) {
		record.checks[name] = result ? result.status : null;
		// Never compared against the base, so a failed check is not `red-caused`.
		if (result && result.status !== 0)
			unproven(`check ${name} failed (exit ${result.status})`);
	}

	const tracked = git(root, ["ls-files", "--", ...HANDOFF_FILES]);
	if (tracked)
		findings.push({
			kind: "red-caused",
			reason: `root handoff file is tracked: ${tracked.split("\n").join(", ")}`,
		});
	return report(root, record, findings, {
		governance: governance.length,
		changed: changed.length,
	});
}

function report(root, record, findings, { governance, changed }) {
	const verdict = decideLane(findings);
	const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const head = git(root, ["rev-parse", "HEAD"]);
	const uncommitted = git(root, ["status", "--porcelain"])
		.split("\n")
		.filter(Boolean).length;
	const count = (kind) =>
		record.failedFiles.filter((entry) => entry.verdict === kind).length;
	const ran = Object.values(record.checks).filter((value) => value !== null);
	const exit = laneExitCode(verdict);
	Object.assign(record, {
		changed,
		governance,
		head,
		uncommitted,
		findings,
		verdict,
		exit,
	});
	console.log(JSON.stringify(record));
	console.log("ORCHESTRATOR SUMMARY");
	console.log(`branch: ${branch === "HEAD" ? "(detached)" : branch}`);
	console.log(`head: ${head}`);
	console.log(`verdict: ${verdict} (exit ${exit})`);
	console.log(
		`red files: ${record.failedFiles.length}; CAUSED-BY-CHANGE: ${count("CAUSED-BY-CHANGE")}; RED-ON-BASE: ${count("RED-ON-BASE")}; INCONCLUSIVE: ${count("INCONCLUSIVE")} (not evidence of unrelated)`,
	);
	console.log(`governance files: ${governance}; steps run: ${ran.length}`);
	const selection = record.checks.targeted;
	if (selection) {
		console.log(
			`selection: selected ${selection.selected}, matched ${selection.matched}, capped ${selection.capped}`,
		);
		if (selection.capped) console.log(CAPPED_REMEDY);
	}
	for (const finding of findings)
		console.log(`${finding.kind}: ${finding.reason}`);
	console.log(`uncommitted: ${uncommitted} file(s)`);
	return exit;
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
	process.exitCode = main();
