// scripts/lib/knip-runner.mjs (#2698).
//
// Orchestrates one `npm run knip` invocation: purge the gitignored compiled
// `.js` siblings (scripts/lib/knip-sibling-purge.mjs), then spawn knip's
// real bin entry (scripts/lib/knip-command.mjs). Split out from
// scripts/run-knip.mjs so the control flow -- especially "a purge failure
// must abort loudly, never fall through to spawning knip" -- is unit-
// testable without a real git repo or a real knip install.
//
// #2698 review round 2:
// - F3: a purge failure (buffer overflow, git timeout, anything) now ABORTS
//   with a non-zero exit and a printed message -- an `::error::` line too
//   under CI -- instead of warning and running knip against a tree that is
//   still fully built. Silently degrading here regenerates exactly the
//   false "unused files" report this wrapper exists to prevent.
// - F5: the purge is skipped for `--help`/`--version` (a read-only,
//   informational invocation has no business mutating the tree), and a
//   successful purge that actually removed files prints a reminder that the
//   tree now needs `npm run build` before `npm test` (the CLAUDE.md
//   non-negotiable, but easy to forget immediately after this script just
//   deleted the build's own output).
//
// #2698 review round 3, R2-F1: knip's actual short version flag is `-V`
// (capital) -- `-v` is "Unknown option" to knip itself (verified:
// `node_modules/.bin/knip -v` errors, `-V`/`--version` both print the
// version). Round 2 listed `-v`, so `npm run knip -- -V` still purged.
import { spawnSync } from "node:child_process";
import { purgeCompiledSiblings } from "./knip-sibling-purge.mjs";
import { resolveKnipCommand } from "./knip-command.mjs";

const SKIP_PURGE_ARGS = new Set(["--help", "-h", "--version", "-V"]);

/**
 * @typedef {{
 *   purge?: typeof purgeCompiledSiblings,
 *   resolveCommand?: typeof resolveKnipCommand,
 *   spawn?: typeof spawnSync,
 *   log?: (message: string) => void,
 *   logError?: (message: string) => void,
 *   isCI?: boolean,
 * }} RunKnipDeps
 */

/**
 * @param {string[]} argv `process.argv.slice(2)`
 * @param {string} repoRoot
 * @param {RunKnipDeps} [deps]
 * @returns {number} the process exit code to use.
 */
export function runKnip(argv, repoRoot, deps = {}) {
	const purge = deps.purge ?? purgeCompiledSiblings;
	const resolveCommand = deps.resolveCommand ?? resolveKnipCommand;
	const spawn = deps.spawn ?? spawnSync;
	const log = deps.log ?? ((message) => console.log(message));
	const logError = deps.logError ?? ((message) => console.error(message));
	const isCI = deps.isCI ?? Boolean(process.env.CI);

	if (!argv.some((arg) => SKIP_PURGE_ARGS.has(arg))) {
		let purged;
		try {
			purged = purge(repoRoot);
		} catch (err) {
			const message =
				`compiled-sibling purge failed (${err.message}); refusing to run ` +
				`knip against a possibly still-built tree -- that would silently ` +
				`regenerate the false "unused files" report this wrapper exists ` +
				`to prevent.`;
			logError(`[run-knip] ${message}`);
			if (isCI) logError(`::error::${message}`);
			return 1;
		}
		log(
			`[run-knip] purged ${purged.length} compiled .js sibling(s) before analysis.`,
		);
		if (purged.length > 0) {
			log(`[run-knip] this tree needs "npm run build" before "npm test" now.`);
		}
	}

	const { command, args } = resolveCommand(argv);
	const result = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });

	if (result.error) {
		logError(`[run-knip] failed to start knip: ${result.error.message}`);
		return 1;
	}
	if (typeof result.status === "number") return result.status;
	// Killed by a signal (e.g. SIGTERM from a CI timeout) — mirror the
	// non-zero-but-not-a-status-code shape other wrappers in this repo use.
	return 1;
}
