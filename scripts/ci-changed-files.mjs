#!/usr/bin/env node
/**
 * scripts/ci-changed-files.mjs (#3801)
 *
 *   node scripts/ci-changed-files.mjs --event <github event name> \
 *     [--repo <owner/repo> --pr <number>]
 *
 * The `changes` job of ci.yml. Writes two step outputs:
 *
 *   code=true|false    false ONLY for a pull_request whose every changed path
 *                      is on the strict docs allowlist below: the heavy jobs
 *                      (Unit shards, Install tests, Windows advisory, mutation,
 *                      ...) then skip.
 *   formal=true|false  true when the diff touches the TLA+ models or what runs
 *                      them; `TLA+ models` model-checks only then.
 *
 * Direction of every doubt is FULL SUITE (AGENTS.md shape 48): a non-PR event
 * (push to master, merge_group), an unreadable file list,
 * an empty list, a list at GitHub's 3000-file cap, or any path this file does
 * not recognise as docs all give code=true. The script exits 0 in each of
 * those cases; only bad arguments exit 2.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** GitHub's `pulls/{n}/files` returns at most this many files. */
export const PR_FILES_API_CAP = 3000;

/**
 * The docs allowlist. `*.md` is ROOT-level only: `.claude/agents/*.md` and
 * `skills/**\/*.md` are agent contracts and shipped skills, i.e. code.
 */
const DOCS_ALLOWLIST = [
	(path) => /^[^/]+\.md$/.test(path),
	(path) => path.startsWith("docs/"),
	(path) => path.startsWith(".changelog/"),
];

/** Paths that run or define the TLA+ models. */
const FORMAL_TRIGGERS = [
	(path) => path.startsWith("formal/"),
	(path) => path === "scripts/check-tla-models.mjs",
	(path) => path === ".github/workflows/ci.yml",
];

/**
 * A path is docs only if it is on the allowlist and does not walk back out of
 * its prefix (`docs/../clients/x.ts` starts with `docs/` and is code).
 */
function isDocsPath(path) {
	if (path.split("/").includes("..")) return false;
	return DOCS_ALLOWLIST.some((matches) => matches(path));
}

/**
 * @param {string[]} paths every path the diff touches (a rename contributes
 *   both its old and new path)
 * @returns {{ code: boolean, formal: boolean, reason: string }}
 */
export function classifyChangedFiles(paths) {
	if (!Array.isArray(paths) || paths.length === 0)
		return { code: true, formal: true, reason: "no changed files listed" };
	if (paths.length >= PR_FILES_API_CAP)
		return {
			code: true,
			formal: true,
			reason: `${paths.length} files reaches the API listing cap`,
		};
	const nonDocs = paths.filter((path) => !isDocsPath(path));
	const formal = paths.some((path) =>
		FORMAL_TRIGGERS.some((matches) => matches(path)),
	);
	if (nonDocs.length > 0)
		return {
			code: true,
			formal,
			reason: `code paths in the diff: ${nonDocs.slice(0, 3).join(", ")}${nonDocs.length > 3 ? `, +${nonDocs.length - 3} more` : ""}`,
		};
	return {
		code: false,
		formal,
		reason: `docs-only diff (${paths.length} files)`,
	};
}

/** @param {string[]} argv */
export function parseArgs(argv) {
	const options = { event: null, repo: null, pr: null };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[++index];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		if (flag === "--event") options.event = value;
		else if (flag === "--repo") options.repo = value;
		else if (flag === "--pr") options.pr = value;
		else throw new Error(`unknown argument ${flag}`);
	}
	if (!options.event) throw new Error("--event is required");
	if (options.event === "pull_request") {
		if (!options.repo || !/^[\w.-]+\/[\w.-]+$/.test(options.repo))
			throw new Error("--repo owner/repo is required for a pull_request");
		if (!options.pr || !/^\d+$/.test(options.pr))
			throw new Error("--pr <number> is required for a pull_request");
	}
	return options;
}

/**
 * Every path a `pulls/{n}/files` payload touches. A rename carries its OLD
 * path in `previous_filename`; a code file renamed into docs/ deletes code, so
 * that old path is a changed path too.
 *
 * @param {Array<{ filename: string, previous_filename?: string }>} files
 * @returns {string[]}
 */
export function pathsFromPrFiles(files) {
	const paths = [];
	for (const file of files) {
		paths.push(file.filename);
		if (file.previous_filename) paths.push(file.previous_filename);
	}
	return paths;
}

/**
 * One `pulls/{n}/files` read: `gh api --jq '.[]'` prints one JSON object per
 * line. A malformed line is an unreadable file list, not an empty one, so it
 * throws and `run()` falls back to the full suite (AGENTS.md shape 48). `exec`
 * is injectable so a test can prove the malformed-line direction without a
 * real `gh`.
 *
 * @param {string} repo
 * @param {string} pr
 * @param {(file: string, args: string[], options: { encoding: string; timeout: number; maxBuffer: number }) => string} [exec]
 * @returns {string[]}
 */
export function ghPrFiles(repo, pr, exec = execFileSync) {
	const raw = exec(
		"gh",
		[
			"api",
			"--paginate",
			`repos/${repo}/pulls/${pr}/files?per_page=100`,
			"--jq",
			".[]",
		],
		{ encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
	);
	const files = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			files.push(JSON.parse(line));
		} catch (error) {
			// `gh api --jq '.[]'` prints one JSON object per line; malformed
			// output is an unreadable file list, and `run()` falls back to the
			// full suite rather than guessing (AGENTS.md shape 48).
			throw new Error(
				`malformed gh api --jq line (${error instanceof Error ? error.message : String(error)}): ${line.slice(0, 200)}`,
			);
		}
	}
	return pathsFromPrFiles(files);
}

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, fetchFiles?: (repo: string, pr: string) => string[], log?: (line: string) => void }} [io]
 * @returns {number} exit code
 */
export function run(argv, io = {}) {
	const { env = process.env, fetchFiles = ghPrFiles, log = console.log } = io;
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	let result;
	if (options.event !== "pull_request") {
		result = {
			code: true,
			formal: true,
			reason: `${options.event} runs the full suite`,
		};
	} else {
		try {
			result = classifyChangedFiles(fetchFiles(options.repo, options.pr));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = {
				code: true,
				formal: true,
				reason: `changed files unreadable (${message.split("\n")[0]})`,
			};
		}
	}
	const line = `changes: code=${result.code} formal=${result.formal} -- ${result.reason}`;
	log(line);
	if (env.GITHUB_OUTPUT)
		fs.appendFileSync(
			env.GITHUB_OUTPUT,
			`code=${result.code}\nformal=${result.formal}\n`,
		);
	if (env.GITHUB_STEP_SUMMARY)
		fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = run(process.argv.slice(2));
