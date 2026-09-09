import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Repo convention: conventional-commit-style prefix, then an issue
// reference, BOTH IN THE TITLE. Merges are merge commits from the PR title
// (see AGENTS.md), so a malformed title becomes the permanent commit
// subject -- catch it before merge, not after. A ref that lives only in the
// body doesn't survive into the merge-commit subject line, so it doesn't
// satisfy the convention (policy decision, #1844 PR #1917 review F1): the
// body is never consulted here, on purpose.
const CONVENTIONAL_PREFIX =
	/^(feat|fix|chore|docs|refactor|test|ci|perf)(\([^)]+\))?: .+/;
const ISSUE_REF = /#\d+/;

export const MISSING_PREFIX_MESSAGE =
	'PR title must start with a conventional prefix and a colon, for example "fix: repair the widget cache (refs #123)". ' +
	"Allowed prefixes: feat, fix, chore, docs, refactor, test, ci, perf.";

export const MISSING_ISSUE_REF_MESSAGE =
	'PR title must reference an issue (e.g. "#123"). Use "Closes #123" when the PR fully resolves the issue, or "Refs #123" when work remains. A reference in the PR body alone does not count -- the title becomes the merge-commit subject.';

/**
 * Lint a PR title against the repo's conventional-prefix + issue-ref
 * convention. Both requirements are checked against the TITLE ONLY. `body`
 * is accepted but intentionally never read -- it stays in the signature so
 * a caller can pass it through unchanged, and so the regression test for
 * this policy (#1917 review F1: dropping the old title-or-body fallback)
 * can prove a ref sitting only in the body no longer rescues the title.
 * Pure function so it is unit-testable without a GitHub event payload.
 */
export function lintPrTitle(title = "") {
	const errors = [];
	if (!CONVENTIONAL_PREFIX.test(title.trim())) {
		errors.push(MISSING_PREFIX_MESSAGE);
	}
	if (!ISSUE_REF.test(title)) {
		errors.push(MISSING_ISSUE_REF_MESSAGE);
	}
	return { valid: errors.length === 0, errors };
}

export async function resolveLivePrTitle(
	payloadPr,
	fetchImpl = globalThis.fetch,
) {
	const fallbackTitle = payloadPr.title ?? "";
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.warn(
			"::warning::PR title live fetch failed: GITHUB_TOKEN is missing; using event payload title",
		);
		return fallbackTitle;
	}
	try {
		const apiUrl = process.env.GITHUB_API_URL;
		const repository = process.env.GITHUB_REPOSITORY;
		if (!apiUrl || !repository) {
			throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
		}
		const response = await fetchImpl(
			`${apiUrl}/repos/${repository}/pulls/${payloadPr.number}`,
			{
				signal: AbortSignal.timeout(10_000),
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
				},
			},
		);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const livePr = await response.json();
		if (typeof livePr?.title !== "string") {
			throw new Error("response has no title");
		}
		return livePr.title;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(
			`::warning::PR title live fetch failed: ${reason}; using event payload title`,
		);
		return fallbackTitle;
	}
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

async function lintPullRequestEvent() {
	const pullRequest = eventPayload().pull_request;
	if (!pullRequest) throw new Error("Event payload has no pull_request");
	const title = await resolveLivePrTitle(pullRequest);
	const result = lintPrTitle(title);
	if (!result.valid) {
		for (const error of result.errors) console.error(error);
		process.exitCode = 1;
		return;
	}
	console.log(`PR title OK: "${title}"`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const localTitle =
		process.argv[2] === "--lint-local" && process.argv[3]
			? readFileSync(process.argv[3], "utf8").split(/\r?\n/, 1)[0]
			: null;
	if (localTitle !== null) {
		const result = lintPrTitle(localTitle);
		for (const error of result.errors) console.error(error);
		process.exitCode = result.valid ? 0 : 1;
	} else
		lintPullRequestEvent().catch((error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
