#!/usr/bin/env node
/**
 * scripts/lint-prose-files.mjs (#5249)
 *
 *   node scripts/lint-prose-files.mjs --event <github event name>
 *
 * The file list for lint.yml's `Lint prose` step (Vale, in the `Lint (advisory)`
 * job). On a pull request, Vale reads only the Markdown the PR adds or changes
 * under PROSE_PATHS: `git diff --diff-filter=ACMR origin/master...HEAD`, the
 * merge-base diff, read through `changedFiles` from pre-push-targeted-tests.mjs.
 * Every other doubt lints the whole PROSE_PATHS list (fail closed):
 *
 *   - any event other than pull_request (push, merge_group, workflow_dispatch);
 *   - a diff git cannot compute, such as a shallow checkout without the base;
 *   - a path git quotes (a non-ASCII or control-character name this filter
 *     cannot read, which would otherwise pass unlinted);
 *   - a change to a lint config file (CONFIG_FILES, CONFIG_DIRS): a rule change
 *     re-judges every prose file, so the diff's changed files do not bound it.
 *
 * stdout: one path per line, the arguments for vale. Empty stdout means no
 * Markdown under the prose paths changed, and the step skips with a notice. The
 * reason goes to stderr. A crash exits non-zero, and the step reads that status
 * (an empty list must never come from a failed run).
 */

import { isMainModule } from "./lib/is-main-module.mjs";
import { changedFiles } from "./pre-push-targeted-tests.mjs";

/** The paths the step has always linted, in the order it named them. */
const PROSE_PATHS = [
	"docs",
	"AGENTS.md",
	"CLAUDE.md",
	"README.md",
	"CONTRIBUTING.md",
	".claude/agents",
	".changelog",
];

/** The checkout in lint.yml fetches full history, so the base is present. */
const BASE = "origin/master";

/** The files that configure the lint: Vale's config, its styles, this step and its script. */
const CONFIG_FILES = [
	".vale.ini",
	".github/workflows/lint.yml",
	"scripts/lint-prose-files.mjs",
];
const CONFIG_DIRS = [".vale/styles/"];

/** A file the lint reads for its rules, so a change to it re-judges every file. */
function isConfigPath(file) {
	return (
		CONFIG_FILES.includes(file) ||
		CONFIG_DIRS.some((dir) => file.startsWith(dir))
	);
}

/** A Markdown file that is an exact PROSE_PATHS entry or sits under a directory one. */
function isProsePath(file) {
	return (
		file.endsWith(".md") &&
		PROSE_PATHS.some((entry) => file === entry || file.startsWith(`${entry}/`))
	);
}

/** @returns {{ files: string[], reason: string }} */
function selectProseFiles(event) {
	const whole = (reason) => ({
		files: PROSE_PATHS,
		reason: `${reason}; linting the whole prose list`,
	});
	if (event !== "pull_request") return whole(`${event || "no"} event`);
	const listed = changedFiles(`${BASE}...HEAD`, { diffFilter: "ACMR" });
	if (listed === null) return whole(`cannot diff ${BASE}...HEAD`);
	// Every status, deletions included: a removed config file changes the lint too.
	// No rename detection: a rename lists its old path as well as its new one,
	// so a config file moved out of the config paths still counts (#5249 r2).
	const touched = changedFiles(`${BASE}...HEAD`, { noRenames: true });
	if (touched === null) return whole(`cannot diff ${BASE}...HEAD`);
	if (touched.some(isConfigPath)) return whole("a lint config file changed");
	// A deletion is absent from `listed`, so the quoted-name guard reads both
	// lists (#5249 r2).
	if ([...listed, ...touched].some((file) => file.startsWith('"')))
		return whole("git quoted a changed path name");
	const files = listed.filter(isProsePath);
	return {
		files,
		reason: `${files.length} changed Markdown file(s) under the prose paths`,
	};
}

/** @param {string[]} argv */
function main(argv) {
	if (argv.length !== 2 || argv[0] !== "--event") {
		console.error(
			"usage: node scripts/lint-prose-files.mjs --event <github event name>",
		);
		return 2;
	}
	const { files, reason } = selectProseFiles(argv[1]);
	console.error(`lint-prose: ${reason}`);
	if (files.length > 0) process.stdout.write(`${files.join("\n")}\n`);
	return 0;
}

if (isMainModule(import.meta.url))
	process.exitCode = main(process.argv.slice(2));
