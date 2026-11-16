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
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

export const BOT_BRANCH = "bot/lsp-docs-refresh";
export const MATRIX_DOC = "docs/lsp-capability-matrix.md";
export const IDLE_DOC = "docs/lsp-idle-eviction.md";
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
	// One doc's decision and, when the bot branch wins, its restore. Fail-open:
	// an unreadable bot doc leaves master's.
	const seedDoc = (doc) => {
		const decision = decideMatrixSeed({
			masterBlob: blob(`HEAD:${doc}`),
			botBlob: blob(`${BOT_REF}:${doc}`),
			botBaseBlob: blob(`${BOT_REF}^:${doc}`),
		});
		if (decision.source !== "bot") return decision;
		try {
			writeFile(
				path.join(cwd, doc),
				git(["show", `${BOT_REF}:${doc}`], { cwd }),
			);
		} catch (error) {
			return {
				source: "master",
				reason: `bot doc unreadable (${String(error?.message ?? error).split("\n")[0]})`,
			};
		}
		return decision;
	};
	const decision = seedDoc(MATRIX_DOC);
	// #5667: the idle-eviction doc is the published row the matrix's pending
	// `idle-eviction-doc` flips are held against, so it is restored on its own
	// decision, never gated on the matrix's. The flip-commit night clears the
	// pending flip and leaves the matrix at master's exact bytes: the next
	// night's matrix decision is `master`, and a restore gated on it would
	// drop the committed row and flip it back every other night while the
	// refresh PR stays unmerged. Its staleness check stays: a bot branch built
	// before master's idle doc changed (merged, hand-edited) must not revert it.
	const idle = seedDoc(IDLE_DOC);
	log(`idle-eviction doc seed: using ${idle.source} doc (${idle.reason})`);
	return done(decision);
}

if (isMainModule(import.meta.url)) {
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
	);
	seedMatrixFromBotBranch({ cwd: repoRoot });
}
