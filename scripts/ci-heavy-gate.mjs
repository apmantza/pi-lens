#!/usr/bin/env node
/**
 * scripts/ci-heavy-gate.mjs (#3801)
 *
 *   node scripts/ci-heavy-gate.mjs --repo <owner/repo> --sha <head-sha> \
 *     --context <check name> [--context <check name> ...] \
 *     [--deadline-seconds 300] [--interval-seconds 15]
 *
 * The last step of ci.yml's `heavy-gate` job. The job's own `needs:` already
 * proves the required checks that live in ci.yml passed; `needs:` cannot reach
 * another workflow, so the required checks hosted by lint.yml (`knip`,
 * `oxfmt format check`) are read here from the head's check-runs. Result:
 * `ready=true` on the step output only when every named check's LATEST
 * check-run on the exact head concluded success. Red, absent at the deadline,
 * or a transport failure all give `ready=false` and exit 1: the heavy advisory
 * jobs are then skipped (their `needs:` failed), and the gate row is RED, so a
 * deferred run is a visible, pushed fact a reader tells apart from a dropped
 * one. The row is advisory by name, so red never gates a merge. Bad arguments
 * exit 2; a ready head exits 0.
 *
 * The latest-check-run-per-name choice is scripts/lib/ci-checks.mjs's
 * fail-closed `resolveLatestByName`, the same one ci-verdict and the merge
 * train use, so a superseded success cannot outvote a newer red or pending
 * row for the same name.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveLatestByName } from "./lib/ci-checks.mjs";

export const DEFAULT_DEADLINE_SECONDS = 300;
export const DEFAULT_INTERVAL_SECONDS = 15;

/**
 * @param {Array<{name: string, status?: string|null, conclusion?: string|null}>} checkRuns
 * @param {string[]} required
 * @returns {{ state: "ready"|"wait"|"blocked", detail: string }}
 */
export function decideGate(checkRuns, required) {
	const latest = resolveLatestByName(checkRuns);
	const waiting = [];
	const red = [];
	for (const name of required) {
		const run = latest.get(name);
		if (!run || run.status !== "completed") {
			waiting.push(name);
		} else if (run.conclusion !== "success") {
			red.push(`${name} (${run.conclusion})`);
		}
	}
	// A red row decides at once: waiting longer cannot make it green.
	if (red.length > 0)
		return { state: "blocked", detail: `not green: ${red.join(", ")}` };
	if (waiting.length > 0)
		return { state: "wait", detail: `not finished: ${waiting.join(", ")}` };
	return {
		state: "ready",
		detail: `every named check succeeded: ${required.join(", ")}`,
	};
}

/**
 * Poll `fetchRuns` until the gate decides or the deadline passes. A fetch
 * failure is a not-ready verdict (the heavy jobs are advisory; running them
 * on an unread head is the one wrong answer).
 *
 * @param {object} options
 * @param {() => Array<object>} options.fetchRuns
 * @param {string[]} options.required
 * @param {number} options.deadlineMs
 * @param {number} options.intervalMs
 * @param {() => number} [options.now]
 * @param {(ms: number) => void} [options.sleep]
 * @returns {{ ready: boolean, reason: string }}
 */
export function waitForRequired({
	fetchRuns,
	required,
	deadlineMs,
	intervalMs,
	now = Date.now,
	sleep = sleepSync,
}) {
	const start = now();
	for (;;) {
		let decision;
		try {
			decision = decideGate(fetchRuns(), required);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ready: false,
				reason: `check-runs unreadable: ${message.split("\n")[0]}`,
			};
		}
		if (decision.state === "ready")
			return { ready: true, reason: decision.detail };
		if (decision.state === "blocked")
			return { ready: false, reason: decision.detail };
		if (now() - start + intervalMs > deadlineMs)
			return {
				ready: false,
				reason: `${decision.detail} after ${Math.round((now() - start) / 1000)}s`,
			};
		sleep(intervalMs);
	}
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {string[]} argv */
export function parseArgs(argv) {
	const options = {
		repo: null,
		sha: null,
		required: [],
		deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
		intervalSeconds: DEFAULT_INTERVAL_SECONDS,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[++index];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		if (flag === "--repo") options.repo = value;
		else if (flag === "--sha") options.sha = value;
		else if (flag === "--context") options.required.push(value);
		else if (flag === "--deadline-seconds")
			options.deadlineSeconds = Number(value);
		else if (flag === "--interval-seconds")
			options.intervalSeconds = Number(value);
		else throw new Error(`unknown argument ${flag}`);
	}
	if (!options.repo || !/^[\w.-]+\/[\w.-]+$/.test(options.repo))
		throw new Error("--repo owner/repo is required");
	if (!options.sha || !/^[0-9a-f]{40}$/i.test(options.sha))
		throw new Error("--sha must be a 40-hex commit");
	if (options.required.length === 0)
		throw new Error("at least one --context is needed");
	for (const key of ["deadlineSeconds", "intervalSeconds"]) {
		if (!Number.isFinite(options[key]) || options[key] <= 0)
			throw new Error(
				`--${key === "deadlineSeconds" ? "deadline" : "interval"}-seconds must be positive`,
			);
	}
	return options;
}

function ghCheckRuns(repo, sha) {
	const raw = execFileSync(
		"gh",
		[
			"api",
			"--paginate",
			`repos/${repo}/commits/${sha}/check-runs?per_page=100`,
			"--jq",
			".check_runs[]",
		],
		{ encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
	);
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, fetchRuns?: (repo: string, sha: string) => object[], sleep?: (ms: number) => void, now?: () => number, log?: (line: string) => void }} [io]
 * @returns {number} exit code
 */
export function run(argv, io = {}) {
	const { env = process.env, fetchRuns = ghCheckRuns, log = console.log } = io;
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	const result = waitForRequired({
		fetchRuns: () => fetchRuns(options.repo, options.sha),
		required: options.required,
		deadlineMs: options.deadlineSeconds * 1000,
		intervalMs: options.intervalSeconds * 1000,
		now: io.now,
		sleep: io.sleep,
	});
	const line = result.ready
		? `heavy advisory jobs: START -- ${result.reason}`
		: `heavy advisory jobs: SKIPPED on ${options.sha.slice(0, 9)} -- ${result.reason}`;
	log(result.ready ? line : `::error::${line}`);
	if (env.GITHUB_OUTPUT)
		fs.appendFileSync(env.GITHUB_OUTPUT, `ready=${result.ready}\n`);
	if (env.GITHUB_STEP_SUMMARY)
		fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
	return result.ready ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = run(process.argv.slice(2));
