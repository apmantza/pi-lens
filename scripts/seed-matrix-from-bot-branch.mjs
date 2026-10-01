#!/usr/bin/env node
/**
 * scripts/seed-matrix-from-bot-branch.mjs (#3401)
 *
 * The nightly's matrix refresh keeps its expiry and hysteresis bookkeeping in
 * docs/lsp-capability-matrix.md itself. Each nightly checks out master, and
 * `peter-evans/create-pull-request` force-rebuilds `bot/lsp-docs-refresh` from
 * master, so an UNMERGED bot PR used to lose its bookkeeping every night and the
 * clock only advanced per merged refresh. This step runs before the doc-writing
 * steps and, when the last nightly's doc is still a fresh, unmerged refresh,
 * starts the night from it instead of from master's copy.
 *
 * It uses the bot branch's doc only when that is safe: the doc differs from
 * master's (the branch is ahead) AND master has not changed the doc since the
 * branch was built (the bot commit's parent holds master's current blob).
 * Anything else falls back to master's doc, which is what the checkout already
 * holds: an absent branch, an unreachable remote, a squash-merged branch (master
 * then carries a newer doc than the branch's base, so the branch is stale and
 * seeding from it would revert master), a hand edit on master since.
 *
 * Fail-open and side-effect-light: it only ever overwrites the one matrix doc,
 * and every error path leaves master's doc in place and exits 0. The fetch is
 * unauthenticated because the repository is public. Git runs through
 * `gitExecFileSync` like `check-generated-docs-diff.mjs` in the same job: the
 * remote URL is repo-local config, which the fixture env leaves alone.
 *
 * Closing the bot PR unmerged does NOT reset the bookkeeping: the branch is not
 * deleted (`delete-branch: false`), stays ahead of master and built on master's
 * current doc, and keeps seeding. Only deleting `bot/lsp-docs-refresh` resets it.
 *
 * Usage: node scripts/seed-matrix-from-bot-branch.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";

export const BOT_BRANCH = "bot/lsp-docs-refresh";
export const MATRIX_DOC = "docs/lsp-capability-matrix.md";
const BOT_REF = `refs/remotes/origin/${BOT_BRANCH}`;

/**
 * Pure decision over the three blob ids (`null` = could not be read).
 *
 * @param {{ masterBlob: string | null, botBlob: string | null, botBaseBlob: string | null }} facts
 * @returns {{ source: "bot" | "master", reason: string }}
 */
export function decideMatrixSeed({ masterBlob, botBlob, botBaseBlob }) {
	if (!botBlob)
		return { source: "master", reason: "no matrix doc on the bot branch" };
	if (botBlob === masterBlob)
		return {
			source: "master",
			reason: "bot doc identical to master's (not ahead)",
		};
	if (!botBaseBlob || botBaseBlob !== masterBlob)
		return {
			source: "master",
			reason: "stale: master's doc changed since the bot branch was built",
		};
	return {
		source: "bot",
		reason: "bot branch is ahead and built on master's current doc",
	};
}

/** @param {string[]} args @param {{ cwd: string }} options */
function defaultGit(args, options) {
	return gitExecFileSync(args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
		...options,
	});
}

/**
 * @param {{
 *   cwd?: string,
 *   git?: (args: string[], options: { cwd: string }) => string,
 *   writeFile?: (file: string, text: string) => void,
 *   log?: (line: string) => void,
 * }} [deps]
 * @returns {{ source: "bot" | "master", reason: string }}
 */
export function seedMatrixFromBotBranch(deps = {}) {
	const cwd = deps.cwd ?? process.cwd();
	const git = deps.git ?? defaultGit;
	const writeFile =
		deps.writeFile ?? ((file, text) => fs.writeFileSync(file, text));
	const log = deps.log ?? ((line) => console.log(line));
	const blob = (spec) => {
		try {
			return (
				git(["rev-parse", "--verify", "--quiet", spec], { cwd }).trim() || null
			);
		} catch {
			return null;
		}
	};
	const done = (decision) => {
		log(`matrix seed: using ${decision.source} doc (${decision.reason})`);
		return decision;
	};
	try {
		// Depth 2: the tip and its parent are all the staleness check reads.
		git(
			[
				"fetch",
				"--no-tags",
				"--depth=2",
				"origin",
				`+refs/heads/${BOT_BRANCH}:${BOT_REF}`,
			],
			{ cwd },
		);
	} catch (error) {
		const firstLine = String(error?.stderr ?? error?.message ?? error).split(
			"\n",
		)[0];
		return done({
			source: "master",
			reason: `bot branch absent or unreachable (${firstLine})`,
		});
	}
	const decision = decideMatrixSeed({
		masterBlob: blob(`HEAD:${MATRIX_DOC}`),
		botBlob: blob(`${BOT_REF}:${MATRIX_DOC}`),
		botBaseBlob: blob(`${BOT_REF}^:${MATRIX_DOC}`),
	});
	if (decision.source === "bot") {
		try {
			const text = git(["show", `${BOT_REF}:${MATRIX_DOC}`], { cwd });
			writeFile(path.join(cwd, MATRIX_DOC), text);
		} catch (error) {
			return done({
				source: "master",
				reason: `bot doc unreadable (${String(error?.message ?? error).split("\n")[0]})`,
			});
		}
	}
	return done(decision);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
	);
	seedMatrixFromBotBranch({ cwd: repoRoot });
}
