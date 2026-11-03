#!/usr/bin/env node
/**
 * scripts/prune-actions-cache.mjs (#4358)
 *
 *   node scripts/prune-actions-cache.mjs [--apply] [--default-branch master]
 *
 * Plans, and with --apply performs, the removal of GitHub Actions caches that
 * can no longer be restored by anything useful. The repository cache is capped
 * at 10 GB; at the cap GitHub evicts by last access, so a freshly saved smoke
 * cache competes with stale CodeQL overlay databases and merged-PR npm caches.
 * Pruning those first keeps the cap free for the caches that still hit.
 *
 * Rules, in this order (a cache matches the first that applies):
 *   1. A pull-request ref (refs/pull/N/merge|head) whose PR is not open:
 *      nothing restores it again, because only that PR's own runs read it.
 *   2. A branch ref other than the default branch whose branch no longer
 *      exists: same reason.
 *   3. The default branch: the newest KEEP caches per key family survive and
 *      the rest are superseded. A family is the key with its content hashes and
 *      run ids replaced, so `codeql-overlay-base-database-1-<digest>-javascript-
 *      2.27.2-<sha>-<run>-<attempt>` is one family across commits, and an ISO
 *      week (`-2026-W42-`) is replaced too, so the weekly tool trees are one
 *      family. CodeQL's overlay base database is ~600 MB per copy and only the
 *      newest is read, so it keeps 1; every other family keeps 2.
 * Any other ref shape (a tag) is left alone.
 *
 * Dry run by default: it lists what --apply would delete and changes nothing.
 * A failed listing (caches, open pull requests or branches) exits 1 before any
 * delete, so an empty or partial list can never read as "everything is stale".
 * A successful but empty open-PR listing while PR-ref caches exist is not
 * trusted either: the PR-ref deletions are skipped (and reported) and the
 * branch and default-branch rules still run.
 * A failed delete is counted and the run exits 1 after the rest were tried.
 * Every deletion is printed with its reason, one line each, and a single
 * summary line closes the run.
 */

import { execFileSync } from "node:child_process";
import { isMainModule } from "./lib/is-main-module.mjs";

export const DEFAULT_KEEP = 2;
/** Key-family prefix -> how many newest default-branch copies survive. */
export const KEEP_BY_PREFIX = Object.freeze({
	"codeql-overlay-base-database": 1,
});
/** `gh cache list --limit` ceiling; a list this long may be truncated. */
export const LIST_LIMIT = 1000;

/**
 * The key with every ISO week (`2026-W42`), 16+ hex digest and trailing run id /
 * attempt replaced, so successive saves of one cache share a family. The week
 * is in the tool-tree keys (#4358); without this strip each week is its own
 * family and keep-N never matches.
 * @param {string} key
 */
export function cacheFamily(key) {
	return key
		.replace(/-\d{4}-W\d{2}(?=-)/g, "-*")
		.replace(/-[0-9a-f]{16,}(?=-|$)/gi, "-*")
		.replace(/-{1,2}\d{6,}-\d+$/, "-*");
}

/** @param {string} family */
function keepFor(family) {
	for (const [prefix, keep] of Object.entries(KEEP_BY_PREFIX))
		if (family.startsWith(prefix)) return keep;
	return DEFAULT_KEEP;
}

/**
 * @typedef {{ id: number, key: string, ref: string, sizeInBytes: number,
 *   createdAt: string }} CacheEntry
 * @param {{ caches: CacheEntry[], openPulls: Iterable<number>,
 *   branches: Iterable<string>, defaultBranch?: string }} input
 * @returns {Array<CacheEntry & { reason: string }>}
 */
export function planPrune({
	caches,
	openPulls,
	branches,
	defaultBranch = "master",
}) {
	const open = new Set(openPulls);
	const live = new Set(branches);
	const defaultRef = `refs/heads/${defaultBranch}`;
	/** @type {Array<CacheEntry & { reason: string }>} */
	const deletions = [];
	/** @type {Map<string, CacheEntry[]>} */
	const families = new Map();
	for (const cache of caches) {
		const pull = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(cache.ref);
		if (pull) {
			if (!open.has(Number(pull[1])))
				deletions.push({ ...cache, reason: `PR #${pull[1]} is not open` });
			continue;
		}
		if (cache.ref === defaultRef) {
			const family = cacheFamily(cache.key);
			families.set(family, [...(families.get(family) ?? []), cache]);
			continue;
		}
		const branch = /^refs\/heads\/(.+)$/.exec(cache.ref);
		if (branch && !live.has(branch[1]))
			deletions.push({ ...cache, reason: `branch ${branch[1]} is gone` });
	}
	for (const [family, members] of families) {
		const newestFirst = [...members].sort(
			(a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
		);
		for (const stale of newestFirst.slice(keepFor(family)))
			deletions.push({
				...stale,
				reason: `superseded in ${family} (keep ${keepFor(family)})`,
			});
	}
	return deletions;
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;

/**
 * @param {(args: string[]) => string} gh
 * @param {{ apply: boolean, defaultBranch: string }} options
 * @returns {{ planned: number, total: number, bytes: number, failed: number }}
 */
export function prune(gh, { apply, defaultBranch }) {
	const caches = JSON.parse(
		gh([
			"cache",
			"list",
			"--limit",
			String(LIST_LIMIT),
			"--json",
			"id,key,ref,sizeInBytes,createdAt",
		]),
	);
	if (!Array.isArray(caches) || caches.length >= LIST_LIMIT)
		throw new Error(
			`cache listing is not a complete array (length ${caches?.length}); refusing to plan against it`,
		);
	const openPulls = JSON.parse(
		gh([
			"pr",
			"list",
			"--state",
			"open",
			"--limit",
			"1000",
			"--json",
			"number",
		]),
	).map((pr) => pr.number);
	const branches = gh([
		"api",
		"--paginate",
		"repos/{owner}/{repo}/branches",
		"--jq",
		".[].name",
	])
		.split("\n")
		.filter(Boolean);
	let plan = planPrune({ caches, openPulls, branches, defaultBranch });
	// A well-formed but empty open-PR listing reads as "no PR is open" and would
	// delete an open PR's cache; a real repository with PR caches has an open PR
	// far more often than it has a wrong listing, so refuse those deletes.
	const pullRef = (entry) => entry.ref.startsWith("refs/pull/");
	const pullCaches = caches.filter(pullRef).length;
	if (openPulls.length === 0 && pullCaches > 0) {
		const skipped = plan.filter(pullRef).length;
		plan = plan.filter((entry) => !pullRef(entry));
		console.log(
			`skipped ${skipped} PR-cache deletions: the open-PR listing is empty while ${pullCaches} PR-ref caches exist`,
		);
	}
	let failed = 0;
	for (const entry of plan) {
		let outcome = apply ? "deleted" : "would delete";
		if (apply) {
			try {
				gh(["cache", "delete", String(entry.id)]);
			} catch (error) {
				failed += 1;
				outcome = `FAILED (${String(error.message).split("\n")[0]})`;
			}
		}
		console.log(
			`${outcome} ${entry.id} ${entry.ref} ${entry.key} ${megabytes(entry.sizeInBytes)}: ${entry.reason}`,
		);
	}
	const bytes = plan.reduce((sum, entry) => sum + entry.sizeInBytes, 0);
	console.log(
		`cache-prune: ${apply ? "applied" : "dry-run"}, ${plan.length} of ${caches.length} caches, ${megabytes(bytes)} of ${megabytes(caches.reduce((sum, entry) => sum + entry.sizeInBytes, 0))}, ${failed} failed`,
	);
	return { planned: plan.length, total: caches.length, bytes, failed };
}

const realGh = (args) =>
	execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 16 * 1024 * 1024,
	});

/**
 * The CLI body: flag parsing, then `prune`. `gh` is injectable so a test drives
 * the real parse without a child process. Returns the exit code.
 * @param {string[]} argv
 * @param {(args: string[]) => string} [gh]
 */
export function main(argv, gh = realGh) {
	const apply = argv.includes("--apply");
	const at = argv.indexOf("--default-branch");
	const defaultBranch = at >= 0 ? argv[at + 1] : "master";
	if (!defaultBranch || defaultBranch.startsWith("-")) {
		console.error("--default-branch needs a branch name");
		return 2;
	}
	try {
		return prune(gh, { apply, defaultBranch }).failed > 0 ? 1 : 0;
	} catch (error) {
		console.error(`cache-prune: ${error.message}`);
		return 1;
	}
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
