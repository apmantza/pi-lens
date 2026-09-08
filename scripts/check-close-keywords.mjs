import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchLivePrBody } from "./check-pr-body.mjs";

const CLOSE_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi;
const CLOSE_ISSUE = /\s*:?[ \t]*#(\d+)/y;
const COMMA_ISSUE = /\s*,\s*#(\d+)/y;

export const INVALID_CLOSE_KEYWORD_MESSAGE =
	'Invalid close-keyword syntax: GitHub only applies the first issue in a comma-separated close list. Use one close keyword per issue, for example "Closes #123. Closes #456." (not "Closes #123, #456").';

/**
 * Remove markdown regions where a close keyword is quotation, not intent
 * (#1355 review): fenced code blocks, inline code spans, and blockquote
 * lines. A PR body QUOTING the bad form as documentation must not fail its
 * own check. GitHub does not apply close keywords inside these regions, so the
 * lint follows the platform's observed model.
 */
export function stripNonSemanticMarkdown(body = "") {
	return body
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]*`/g, "")
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");
}

function scanCloseIssues(scanned = "") {
	const issues = [];
	const commaLists = [];
	const offendingLines = [];

	for (const match of scanned.matchAll(CLOSE_KEYWORD)) {
		const rest = scanned.slice(match.index + match[0].length);
		CLOSE_ISSUE.lastIndex = 0;
		const issue = CLOSE_ISSUE.exec(rest);
		if (!issue) continue;

		const number = Number(issue[1]);
		if (!issues.includes(number)) issues.push(number);

		COMMA_ISSUE.lastIndex = 0;
		if (COMMA_ISSUE.exec(rest.slice(issue[0].length))) {
			commaLists.push(number);
			const lineStart = scanned.lastIndexOf("\n", match.index) + 1;
			const lineEnd = scanned.indexOf("\n", match.index);
			offendingLines.push(
				scanned.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
			);
		}
	}

	return { issues, commaLists, offendingLines };
}

/**
 * Parse same-repository issues named by GitHub close keywords.
 * Cross-repository references (owner/repo#123) and URL forms intentionally do
 * not match. The body keeps GitHub's first-issue-only comma-list semantics;
 * title placement expands every number so no title-only target escapes the
 * post-merge backstop.
 * The body is scanned AFTER stripNonSemanticMarkdown so quoted examples in
 * code fences/blockquotes are not linted as real syntax.
 */
export function parseCloseKeywords(body = "") {
	return scanCloseIssues(stripNonSemanticMarkdown(body));
}

export function lintCloseKeywordPlacement(title = "", body = "") {
	const scannedTitle = String(title);
	const titleIssues = [...scanCloseIssues(scannedTitle).issues];
	for (const match of scannedTitle.matchAll(CLOSE_KEYWORD)) {
		const rest = scannedTitle.slice(match.index + match[0].length);
		CLOSE_ISSUE.lastIndex = 0;
		const issue = CLOSE_ISSUE.exec(rest);
		if (!issue) continue;
		const commaTail = rest.slice(issue[0].length).match(/^(?:\s*,\s*#\d+)+/);
		for (const number of commaTail?.[0].matchAll(/#(\d+)/g) ?? []) {
			const value = Number(number[1]);
			if (!titleIssues.includes(value)) titleIssues.push(value);
		}
	}
	if (titleIssues.length === 0)
		return { valid: true, titleIssues, missingBodyIssues: [] };
	const bodyIssues = parseCloseKeywords(body).issues;
	const missingBodyIssues = titleIssues.filter(
		(number) => !bodyIssues.includes(number),
	);
	return {
		valid: missingBodyIssues.length === 0,
		titleIssues,
		missingBodyIssues,
	};
}

export function closeKeywordPlacementMessage(missing) {
	const repairs = missing.map((number) => `Closes #${number}.`).join(" ");
	const alternatives = missing.map((number) => `refs #${number}`).join(", ");
	return `Invalid close-keyword placement: GitHub only honours closing keywords in the PR body, never in the title. Add the matching body keyword(s): ${repairs} Alternatively, use ${alternatives} in the title.`;
}

export function lintCloseKeywords(body = "") {
	const parsed = parseCloseKeywords(body);
	return {
		...parsed,
		valid: parsed.commaLists.length === 0,
	};
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

export async function lintPullRequest(
	fetchImpl = globalThis.fetch,
	event = eventPayload(),
) {
	const pullRequest = event.pull_request;
	if (!pullRequest || !process.env.GITHUB_REPOSITORY)
		throw new Error("Pull request event and GITHUB_REPOSITORY are required");
	// Same fail-closed reporting contract as verifyMergedPullRequest: a fetch
	// failure states plainly that the check did not run, instead of surfacing
	// as a bare thrown message that reads like a broken script (worst for
	// fork PRs hitting a transient 5xx).
	let body;
	let title;
	try {
		({ body, title } = await fetchLivePrBody(pullRequest, fetchImpl));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(
			`::error::Close-keyword syntax check could not fetch the live PR body, so it did not run: ${reason}`,
		);
		process.exitCode = 1;
		return;
	}
	const result = lintCloseKeywords(body);
	if (!result.valid) {
		console.error(INVALID_CLOSE_KEYWORD_MESSAGE);
		for (const line of result.offendingLines) {
			console.error(`  offending line: ${line}`);
		}
		process.exitCode = 1;
		return;
	}
	const placement = lintCloseKeywordPlacement(title, body);
	if (!placement.valid) {
		console.error(closeKeywordPlacementMessage(placement.missingBodyIssues));
		process.exitCode = 1;
		return;
	}
	console.log(
		`Close-keyword syntax OK (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"} referenced).`,
	);
}

function issueState(repository, number) {
	try {
		return execFileSync(
			"gh",
			["api", `repos/${repository}/issues/${number}`, "--jq", ".state"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		).trim();
	} catch {
		return "not found";
	}
}

/**
 * @param {typeof fetch} [fetchImpl]
 * @param {object} [event] injectable event payload (tests only; defaults to
 *   the real GITHUB_EVENT_PATH payload)
 * @param {(repository: string, number: number) => string} [getIssueState]
 *   injectable issue-state lookup (tests only; defaults to the real `gh api`
 *   call)
 */
export async function verifyMergedPullRequest(
	fetchImpl = globalThis.fetch,
	event = eventPayload(),
	getIssueState = issueState,
) {
	const pullRequest = event.pull_request;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!pullRequest || !repository)
		throw new Error("Pull request event and GITHUB_REPOSITORY are required");

	// #2086: the closed-event payload's body is a snapshot from when the PR
	// closed. A rerun of this check after the body was edited post-merge must
	// see the edit, not replay the stale snapshot. Reuses check-pr-body.mjs's
	// fetchLivePrBody (PR #2085/#2086's own root-cause sibling) rather than
	// hand-rolling a second live-body fetch -- same env vars, same request
	// shape.
	//
	// #2267 F2: uses the STRICT fetchLivePrBody here, not resolveLivePrBody's
	// warn-and-fall-back-to-stale-payload wrapper. That wrapper is right for
	// the advisory body LINTER (check-pr-body.mjs), where degrading to the
	// stale body on a fetch hiccup is an acceptable trade. It is wrong for
	// this post-merge verification GATE: a gate that silently falls back and
	// reports "OK" on a fetch failure is indistinguishable from a gate that
	// actually checked and found nothing wrong -- the exact "fails open"
	// shape #2086 was filed to close, just moved one level up. A fetch
	// failure here fails the check LOUD instead.
	let liveBody;
	let liveTitle;
	try {
		({ body: liveBody, title: liveTitle } = await fetchLivePrBody(
			pullRequest,
			fetchImpl,
		));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(
			`::error::Post-merge close verification could not fetch the live PR body, so it did not run: ${reason}`,
		);
		process.exitCode = 1;
		return;
	}
	const titleIssues = lintCloseKeywordPlacement(liveTitle, "").titleIssues;
	const unresolvedTitle = titleIssues
		.map((number) => ({ number, state: getIssueState(repository, number) }))
		.filter(({ state }) => state !== "closed");
	if (unresolvedTitle.length > 0) {
		const details = unresolvedTitle
			.map(({ number, state }) => `#${number} (${state})`)
			.join(", ");
		console.error(
			`Post-merge close verification found title issue(s) that were not closed: ${details}.`,
		);
		process.exitCode = 1;
		return;
	}
	const { issues } = parseCloseKeywords(liveBody);
	const unresolved = issues
		.map((number) => ({ number, state: getIssueState(repository, number) }))
		.filter(({ state }) => state !== "closed");
	if (unresolved.length === 0) {
		console.log(
			`Post-merge close verification OK (${issues.length} issue${issues.length === 1 ? "" : "s"} closed).`,
		);
		return;
	}

	const details = unresolved
		.map(({ number, state }) => `#${number} (${state})`)
		.join(", ");
	const marker = "<!-- close-keyword-verifier -->";
	const message = `${marker}
Post-merge close verification found issue(s) that were not closed: ${details}. GitHub only applies the first issue in a comma-separated close list; use one close keyword per issue (for example, "Closes #123. Closes #456.").`;
	console.error(message);
	// Idempotence (#1355 review): a rerun must not stack duplicate comments.
	let alreadyCommented = false;
	try {
		const existing = execFileSync(
			"gh",
			[
				"pr",
				"view",
				String(pullRequest.number),
				"--repo",
				repository,
				"--json",
				"comments",
				"--jq",
				".comments[].body",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		alreadyCommented = existing.includes(marker);
	} catch {
		// listing failed -- fall through and comment rather than stay silent
	}
	if (!alreadyCommented) {
		execFileSync(
			"gh",
			[
				"pr",
				"comment",
				String(pullRequest.number),
				"--repo",
				repository,
				"--body",
				message,
			],
			{
				stdio: "inherit",
			},
		);
	}
	process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	(async () => {
		if (process.argv[2] === "--lint-pr") await lintPullRequest();
		else if (process.argv[2] === "--verify-merged")
			await verifyMergedPullRequest();
		else
			throw new Error(
				"Usage: node scripts/check-close-keywords.mjs --lint-pr|--verify-merged",
			);
	})().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
