#!/usr/bin/env node
/**
 * scripts/ci-changed-files.mjs (#3801)
 *
 *   node scripts/ci-changed-files.mjs --event <github event name> \
 *     [--repo <owner/repo> --pr <number>]
 *
 * The `changes` job of ci.yml, the `scope` job of install-smoke.yml and the
 * first step of hot-path-latency.yml. Writes four step outputs:
 *
 *   code=true|false    false ONLY for a pull_request whose every changed path
 *                      is on the strict docs allowlist below: the heavy advisory
 *                      job (CodeQL) then skips. Every test job, the Windows
 *                      unit leg included, still runs (#4518).
 *   formal=true|false  true when the diff touches the TLA+ models or what runs
 *                      them; `TLA+ models` model-checks only then.
 *   smoke=true|false   true when the diff touches PR_SMOKE_PATHS (RPC, install,
 *                      LSP launch, trust; #4291). install-smoke.yml reads it:
 *                      true runs every pi-load cell and the LSP handshake on
 *                      the pull request, false keeps the one pnpm-global cell.
 *                      ci.yml ignores it.
 *   hotpath=true|false true when the diff touches HOT_PATH_PATHS (#4363).
 *                      hot-path-latency.yml reads it: false makes the run pass
 *                      without timing, so the lane can be a required check
 *                      (a path-filtered required workflow leaves a docs-only
 *                      PR at "Expected" forever). Only the pull_request
 *                      trigger is classified here; the workflow's own
 *                      `on.push.paths` is the push-side filter, pinned equal
 *                      to HOT_PATH_PATHS by tests/config/hot-path-latency-workflow.test.ts.
 *
 * Direction of every doubt is FULL SUITE (AGENTS.md shape 48): a non-PR event
 * (push to master, merge_group), an unreadable file list,
 * an empty list, a list at GitHub's 3000-file cap, or any path this file does
 * not recognise as docs all give code=true, and the same doubts give
 * smoke=true and hotpath=true. The script exits 0 in each of
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

/**
 * The paths that decide the deep install smoke (#4291). One list drives both
 * the all-cells pi-load matrix and the LSP handshake job of install-smoke.yml,
 * through `smoke` below. An entry is a file or a `dir/**` prefix, nothing else;
 * every entry must also sit verbatim in install-smoke.yml's pull_request
 * `paths:`, or a PR touching only that path never starts the workflow
 * (tests/config/pr-smoke-paths.test.ts pins both).
 */
export const PR_SMOKE_PATHS = [
	// RPC driver and its fake host.
	"scripts/rpc-load-check.mjs",
	"scripts/lib/latency-log-phases.mjs",
	"tests/fixtures/rpc-load-check/**",
	// Host-crash seams the RPC smoke exists to catch (#4401).
	"scripts/bundle-dist.mjs",
	"clients/project-snapshot.ts",
	"clients/project-snapshot-persist-worker.ts",
	"clients/gzip-stage-write.ts",
	"clients/review-graph/builder.ts",
	"clients/review-graph/persist-worker.ts",
	// Install: manifests, selftest, installer registry, bootstrap.
	"package.json",
	"package-lock.json",
	"scripts/install-selftest.mjs",
	"scripts/download-grammars.js",
	"clients/installer/**",
	"clients/bootstrap.ts",
	// LSP launch, and the handshake harness itself (#4291 asks for it).
	"scripts/smoke-tools.mjs",
	"scripts/lib/git-fixture-env.mjs",
	"scripts/lib/lsp-fixture-session-guard.mjs",
	"scripts/lib/lsp-fixture-workspace.mjs",
	"scripts/lib/safe-rm.mjs",
	"scripts/lib/scratch-dir.mjs",
	"scripts/lib/touch-result.mjs",
	"clients/lsp-lazy.ts",
	// The only `.spawn(` call site and the trust backstop (#4374), and the JVM
	// launch runtime.
	"clients/lsp/client-registry.ts",
	"clients/lsp/jvm-runtime.ts",
	"clients/lsp/launch.ts",
	"clients/lsp/server.ts",
	"clients/lsp/config.ts",
	"clients/lsp/resolved-config.ts",
	"clients/safe-spawn.ts",
	// Trust.
	"clients/project-trust.ts",
	// The workflow itself: its edited lines must run all of the above.
	".github/workflows/install-smoke.yml",
];

/**
 * The paths hot-path-latency.yml times (#4363): what session_start, dispatch
 * and the diagnostics-cache replay read, the sampler and gate script, and the
 * workflow itself. An entry is a file, a `dir/**` prefix, or a file name with
 * `*` standing for any run of characters inside one path segment
 * (`tsconfig*.json`). GitHub's `on.push.paths` cannot read this list, so the
 * workflow repeats it for the push trigger and
 * tests/config/hot-path-latency-workflow.test.ts pins the two equal.
 */
export const HOT_PATH_PATHS = [
	"clients/**",
	"tools/**",
	"rules/**",
	"index.ts",
	"vendor/**",
	"tsconfig*.json",
	"scripts/hot-path-sample.mjs",
	"scripts/check-hot-path-latency.mjs",
	"scripts/lib/latency-stats.mjs",
	".github/workflows/hot-path-latency.yml",
];

/** Paths that run or define the TLA+ models. */
const FORMAL_TRIGGERS = [
	(path) => path.startsWith("formal/"),
	(path) => path === "scripts/check-tla-models.mjs",
	// #4714: the recorded state counts decide the verdict, so a table-only
	// (regeneration) diff runs the model shards too.
	(path) => path === "scripts/tla-model-costs.json",
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
 * A `dir/**` entry matches by prefix, a name with `*` by one path segment
 * (`*` never crosses a `/`), any other entry exactly.
 *
 * @param {string} path
 * @param {readonly string[]} list
 */
function matchesPathList(path, list) {
	if (path.split("/").includes("..")) return false;
	return list.some((entry) => {
		if (entry.endsWith("/**")) return path.startsWith(entry.slice(0, -2));
		if (!entry.includes("*")) return path === entry;
		const pattern = entry
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join("[^/]*");
		return new RegExp(`^${pattern}$`).test(path);
	});
}

/**
 * @param {string[]} paths every path the diff touches (a rename contributes
 *   both its old and new path)
 * @returns {{ code: boolean, formal: boolean, smoke: boolean, hotpath: boolean, reason: string }}
 */
export function classifyChangedFiles(paths) {
	if (!Array.isArray(paths) || paths.length === 0)
		return {
			code: true,
			formal: true,
			smoke: true,
			hotpath: true,
			reason: "no changed files listed",
		};
	if (paths.length >= PR_FILES_API_CAP)
		return {
			code: true,
			formal: true,
			smoke: true,
			hotpath: true,
			reason: `${paths.length} files reaches the API listing cap`,
		};
	const smoke = paths.some((path) => matchesPathList(path, PR_SMOKE_PATHS));
	const hotpath = paths.some((path) => matchesPathList(path, HOT_PATH_PATHS));
	const nonDocs = paths.filter((path) => !isDocsPath(path));
	const formal = paths.some((path) =>
		FORMAL_TRIGGERS.some((matches) => matches(path)),
	);
	if (nonDocs.length > 0)
		return {
			code: true,
			formal,
			smoke,
			hotpath,
			reason: `code paths in the diff: ${nonDocs.slice(0, 3).join(", ")}${nonDocs.length > 3 ? `, +${nonDocs.length - 3} more` : ""}`,
		};
	return {
		code: false,
		formal,
		smoke,
		hotpath,
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
			smoke: true,
			hotpath: true,
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
				smoke: true,
				hotpath: true,
				reason: `changed files unreadable (${message.split("\n")[0]})`,
			};
		}
	}
	const line = `changes: code=${result.code} formal=${result.formal} smoke=${result.smoke} hotpath=${result.hotpath} -- ${result.reason}`;
	log(line);
	if (env.GITHUB_OUTPUT)
		fs.appendFileSync(
			env.GITHUB_OUTPUT,
			`code=${result.code}\nformal=${result.formal}\nsmoke=${result.smoke}\nhotpath=${result.hotpath}\n`,
		);
	if (env.GITHUB_STEP_SUMMARY)
		fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = run(process.argv.slice(2));
