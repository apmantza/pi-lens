#!/usr/bin/env node
// Refresh .all-contributorsrc + the README table from GitHub (closes #3772).
//
// Population: merged-PR authors (code; doc/test when every changed file is
// docs/tests) and issue authors (bug for bug-labelled or bug-shaped titles,
// ideas for feature/enhancement). The owner and bots are excluded. Only adds
// types, never removes, so a second run is a no-op.
//
// Usage: node scripts/update-contributors.mjs [--dry-run]
//   --dry-run  print planned adds/type changes with the justifying numbers.
// The pure logic is exported and tested (tests/scripts/update-contributors.test.ts)
// with recorded gh JSON; only main() touches gh / all-contributors-cli.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isMainModule } from "./lib/is-main-module.mjs";

const BOT_LOGIN = /^app\/|\[bot\]$/;
const DOC_FILE = /^(docs\/|\.changelog\/)|(^|\/)[^/]*\.(md|mdx)$/i;
const TEST_FILE = /^tests\/|(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/i;
const BUG_TITLE =
	/\b(bug|crash(es)?|error|fail(s|ed|ures?)?|broken|collision|ignores?|kills?|false positives?|leak(s|age)?|stale|wrong|silently|corrupts?|uncaught|blind write)\b/i;
const IDEAS_TITLE =
	/^(add|allow|support|optional|separate|per-|condense|make|inherit|feature|request|proposal)\b|\b(opt-out|denylist)\b/i;

/** gh marks bot authors with `is_bot`; the login patterns cover `app/x` and `x[bot]`. */
export function isBot(login, isBotFlag = false) {
	return isBotFlag === true || BOT_LOGIN.test(login);
}

/** Types earned by one merged PR from its changed file paths. */
export function classifyFiles(paths) {
	if (paths.length === 0) return ["code"];
	if (paths.every((p) => DOC_FILE.test(p) || TEST_FILE.test(p))) {
		const types = [];
		if (paths.some((p) => DOC_FILE.test(p))) types.push("doc");
		if (paths.some((p) => TEST_FILE.test(p))) types.push("test");
		return types;
	}
	return ["code"];
}

/** bug / ideas / null for one issue; labels win, then the title. */
export function classifyIssue({ title = "", labels = [] }) {
	const names = labels.map((l) => (typeof l === "string" ? l : l.name));
	if (names.includes("bug")) return "bug";
	if (names.includes("enhancement") || names.includes("feature"))
		return "ideas";
	if (names.some((n) => /^(nightly-drift|duplicate)$/.test(n))) return null;
	if (/^(bug|fix)\b/i.test(title)) return "bug";
	if (IDEAS_TITLE.test(title)) return "ideas";
	if (BUG_TITLE.test(title)) return "bug";
	return null;
}

/**
 * @param {{prs: {number:number,author:{login:string}}[], issues: {number:number,title:string,author:{login:string},labels:unknown[]}[],
 *   filesByPr: Record<number,string[]>, existing: Record<string,string[]>, owner: string}} input
 * @returns {{login:string,isNew:boolean,add:string[],evidence:Record<string,number[]>}[]}
 */
export function planContributions({ prs, issues, filesByPr, existing, owner }) {
	const skip = (login, author) =>
		!login ||
		login.toLowerCase() === owner.toLowerCase() ||
		isBot(login, author?.is_bot);
	const earned = new Map();
	const earn = (login, type, n) => {
		const e = earned.get(login) ?? {};
		(e[type] ??= []).push(n);
		earned.set(login, e);
	};
	for (const pr of prs) {
		const login = pr.author?.login;
		if (skip(login, pr.author)) continue;
		for (const t of classifyFiles(filesByPr[pr.number] ?? []))
			earn(login, t, pr.number);
	}
	for (const is of issues) {
		const login = is.author?.login;
		if (skip(login, is.author)) continue;
		const t = classifyIssue(is);
		if (t) earn(login, t, is.number);
	}
	const order = ["code", "doc", "test", "bug", "ideas"];
	const have = new Map(
		Object.entries(existing).map(([l, t]) => [l.toLowerCase(), t]),
	);
	const plan = [];
	for (const [login, evidence] of earned) {
		const current = have.get(login.toLowerCase());
		const add = order.filter(
			(t) => evidence[t] && !(current ?? []).includes(t),
		);
		if (add.length === 0) continue;
		plan.push({ login, isNew: !current, add, evidence });
	}
	return plan;
}

export function formatPlan(plan) {
	if (plan.length === 0) return "all-contributors is up to date (no changes)";
	return plan
		.map(
			(p) =>
				`${p.isNew ? "add   " : "update"} ${p.login}: ` +
				p.add.map((t) => `${t} (#${p.evidence[t].join(", #")})`).join("; "),
		)
		.join("\n");
}

const LIST_LIMIT = 5000;

/** A list that comes back exactly at the limit may be truncated; refuse to plan from it. */
export function assertNotTruncated(list, what, limit = LIST_LIMIT) {
	if (list.length >= limit) {
		throw new Error(
			`gh returned ${list.length} ${what} (limit ${limit}); the list may be truncated, raise the limit`,
		);
	}
	return list;
}

function gh(args) {
	return JSON.parse(
		execFileSync("gh", args, {
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		}),
	);
}

/** Both gh lists, each refused when it comes back at the limit. `run` is gh (injectable). */
export function loadLists(run, repo) {
	const prs = assertNotTruncated(
		run([
			"pr",
			"list",
			"-R",
			repo,
			"--state",
			"merged",
			"--limit",
			String(LIST_LIMIT),
			"--json",
			"author,number",
		]),
		"merged PRs",
	);
	const issues = assertNotTruncated(
		run([
			"issue",
			"list",
			"-R",
			repo,
			"--state",
			"all",
			"--limit",
			String(LIST_LIMIT),
			"--json",
			"author,number,title,labels",
		]),
		"issues",
	);
	return { prs, issues };
}

function main(argv) {
	const dry = argv.includes("--dry-run");
	const rc = JSON.parse(readFileSync(".all-contributorsrc", "utf8"));
	const repo = `${rc.projectOwner}/${rc.projectName}`;
	const existing = Object.fromEntries(
		rc.contributors.map((c) => [c.login, c.contributions]),
	);
	const { prs, issues } = loadLists(gh, repo);
	const filesByPr = {};
	for (const pr of prs) {
		const login = pr.author?.login;
		if (!login || isBot(login, pr.author?.is_bot) || login === rc.projectOwner)
			continue;
		filesByPr[pr.number] = gh([
			"pr",
			"view",
			String(pr.number),
			"-R",
			repo,
			"--json",
			"files",
		]).files.map((f) => f.path);
	}
	const plan = planContributions({
		prs,
		issues,
		filesByPr,
		existing,
		owner: rc.projectOwner,
	});
	console.log(formatPlan(plan));
	if (dry || plan.length === 0) return;
	for (const p of plan) {
		execFileSync(
			"npx",
			["--yes", "all-contributors-cli", "add", p.login, p.add.join(",")],
			{ stdio: "inherit" },
		);
	}
	execFileSync("npx", ["--yes", "all-contributors-cli", "generate"], {
		stdio: "inherit",
	});
}

if (isMainModule(import.meta.url)) {
	main(process.argv.slice(2));
}
