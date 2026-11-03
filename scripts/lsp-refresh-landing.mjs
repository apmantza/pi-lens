#!/usr/bin/env node
/**
 * #4512 acceptance 5: decide how tonight's LSP-docs refresh lands. Compares the
 * regenerated docs in the working tree with HEAD's (scripts/lib/refresh-flips.mjs
 * owns what counts as a flip), writes the refresh PR body, and prints
 * `flip_free=true|false` (also to $GITHUB_OUTPUT when set).
 *
 * Fail closed: a doc it cannot read, or a git failure, is `flip_free=false`
 * with a body that says the check could not run. The refresh PR still opens.
 *
 *   node scripts/lsp-refresh-landing.mjs --body <out.md> --landing <automerge|ci-only|manual> [--issues-url <url>] [--root <checkout>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { GENERATED_LSP_DOCS } from "./lib/md-matrix.mjs";
import { buildRefreshPrBody, listRefreshFlips } from "./lib/refresh-flips.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

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
 *   root: string,
 *   landing: "automerge" | "ci-only" | "manual",
 *   issuesUrl?: string,
 *   git?: (args: string[], options: { cwd: string }) => string,
 * }} input
 * @returns {{ flipFree: boolean, flips: string[], checkFailed: boolean, body: string }}
 */
export function landRefresh({ root, landing, issuesUrl, git = defaultGit }) {
	let flips = [];
	let checkFailed = false;
	try {
		const headDocs = {};
		const newDocs = {};
		// `ls-tree` answers a path HEAD lacks with exit 0 and no line, so a doc
		// not at HEAD is a flip by name and a nonzero exit is a git failure that
		// reaches the catch below. Only a listed name counts as at HEAD.
		const atHead = new Set(
			git(["ls-tree", "--name-only", "HEAD", "--", ...GENERATED_LSP_DOCS], {
				cwd: root,
			})
				.split("\n")
				.filter(Boolean),
		);
		for (const doc of GENERATED_LSP_DOCS) {
			headDocs[doc] = atHead.has(doc)
				? git(["show", `HEAD:${doc}`], { cwd: root })
				: null;
			const file = path.join(root, doc);
			newDocs[doc] = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
		}
		flips = listRefreshFlips(headDocs, newDocs);
	} catch (error) {
		checkFailed = true;
		console.error(`flip check failed: ${error?.message ?? error}`);
	}
	return {
		flipFree: !checkFailed && flips.length === 0,
		flips,
		checkFailed,
		body: buildRefreshPrBody({ flips, landing, issuesUrl, checkFailed }),
	};
}

if (isMainModule(import.meta.url)) {
	const argv = process.argv.slice(2);
	const flag = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const bodyPath = flag("--body");
	const landing = flag("--landing") ?? "manual";
	if (!bodyPath || !["automerge", "ci-only", "manual"].includes(landing)) {
		console.error(
			"usage: lsp-refresh-landing.mjs --body <out.md> --landing <automerge|ci-only|manual> [--issues-url <url>] [--root <checkout>]",
		);
		process.exit(2);
	}
	// `--root` is the checkout to read; the default is this repository.
	const root = path.resolve(
		flag("--root") ??
			path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
	);
	const result = landRefresh({
		root,
		landing,
		issuesUrl: flag("--issues-url"),
	});
	fs.writeFileSync(bodyPath, result.body);
	console.log(`flips=${result.checkFailed ? "unknown" : result.flips.length}`);
	console.log(`flip_free=${result.flipFree}`);
	if (process.env.GITHUB_OUTPUT)
		fs.appendFileSync(
			process.env.GITHUB_OUTPUT,
			`flip_free=${result.flipFree}\n`,
		);
}
