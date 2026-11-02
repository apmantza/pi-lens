import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	commitCloseKeywordErrors,
	INVALID_CLOSE_KEYWORD_MESSAGE,
	lintCloseKeywords,
	lintCommitCloseKeywords,
	NEGATED_CLOSE_KEYWORD_MESSAGE,
	lintPullRequest,
	parseCloseKeywords,
	verifyMergedPullRequest,
} from "../../scripts/check-close-keywords.mjs";
// Reused, not reimplemented (#2086): check-close-keywords.mjs imports this
// straight from check-pr-body.mjs. Deliberately the STRICT fetchLivePrBody,
// not the advisory resolveLivePrBody wrapper (#2267 F2) -- see the comment
// at its call site in check-close-keywords.mjs for why a post-merge GATE
// must fail closed on a fetch problem instead of falling back to stale
// data. resolveLivePrBody's own fallback paths (missing token, non-2xx,
// malformed body) are covered by check-pr-body.test.ts's "live PR body
// resolution (#2085)" suite; this file exercises fetchLivePrBody's THROWING
// behavior directly, since that's the behavior check-close-keywords.mjs
// actually depends on.
import { COMMIT_CLOSE_KEYWORD_MESSAGE } from "../../scripts/lib/close-keywords.mjs";
import { fetchLivePrBody } from "../../scripts/check-pr-body.mjs";

// True process boundary: the post-merge path shells out to `gh` to read and
// post PR comments; no test may reach the real GitHub.
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFileSync: vi.fn(() => ""),
}));

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

afterEach(() => {
	vi.unstubAllEnvs();
});

// A GitHub API double that routes by URL: the PR itself, and its commit list
// (#4371). Anything but a 2xx JSON answer is a real transport double, never a
// mock of the lint.
function prFetch(
	pr: { title?: string; body: string },
	commits: Array<{ sha: string; message: string; parents?: number }> = [],
	onCommits?: (url: string) => Response | undefined,
) {
	return vi.fn(async (url: string | URL | Request) => {
		if (String(url).includes("/commits")) {
			const custom = onCommits?.(String(url));
			if (custom) return custom;
			const page = Number(new URL(String(url)).searchParams.get("page"));
			return new Response(
				JSON.stringify(
					commits.slice((page - 1) * 100, page * 100).map((commit) => ({
						sha: commit.sha,
						commit: { message: commit.message },
						parents: Array.from({ length: commit.parents ?? 1 }, () => ({})),
					})),
				),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify(pr), { status: 200 });
	});
}

describe("close-keyword parser (#1320)", () => {
	it("parses one close keyword", () => {
		expect(parseCloseKeywords("Closes #123")).toMatchObject({
			issues: [123],
			commaLists: [],
		});
	});

	it("parses multiple correctly separated close keywords", () => {
		expect(
			parseCloseKeywords("Fixes #1. resolves #2; CLOSED #3"),
		).toMatchObject({
			issues: [1, 2, 3],
			commaLists: [],
		});
	});

	it("flags a comma-separated close list", () => {
		expect(lintCloseKeywords("Closes #123, #456")).toMatchObject({
			issues: [123],
			commaLists: [123],
			valid: false,
		});
	});

	it("accepts comma punctuation between separately keyworded issues", () => {
		expect(lintCloseKeywords("Closes #123, fixes #456").valid).toBe(true);
	});

	it("does not treat refs as close keywords", () => {
		expect(parseCloseKeywords("Refs #123, relates to #456")).toMatchObject({
			issues: [],
			commaLists: [],
		});
	});

	it("handles case variants and optional colon", () => {
		expect(
			parseCloseKeywords("CLOSES: #7; FiXeD #8; ResolveD #9").issues,
		).toEqual([7, 8, 9]);
	});

	it("ignores cross-repository references", () => {
		expect(
			parseCloseKeywords("Closes owner/repo#123; fixes #456"),
		).toMatchObject({
			issues: [456],
			commaLists: [],
		});
	});

	it("deduplicates repeated issue references", () => {
		expect(parseCloseKeywords("Closes #12. Fixes #12").issues).toEqual([12]);
	});

	it("exposes the exact lint failure message", () => {
		expect(INVALID_CLOSE_KEYWORD_MESSAGE).toBe(
			'Invalid close-keyword syntax: GitHub only applies the first issue in a comma-separated close list. Use one close keyword per issue, for example "Closes #123. Closes #456." (not "Closes #123, #456").',
		);
	});

	// #1355 review: quoted examples are documentation, not intent.
	it("ignores close keywords inside fenced code blocks", () => {
		const result = lintCloseKeywords(
			"Real.\n```\nCloses #1, #2\n```\nCloses #99.",
		);
		expect(result.valid).toBe(true);
		expect(result.issues).toEqual([99]);
	});

	it("ignores close keywords in blockquotes and inline code", () => {
		expect(lintCloseKeywords("> Closes #1, #2\nCloses #99.").valid).toBe(true);
		expect(
			lintCloseKeywords("Use `Closes #1, #2` never. Closes #7.").valid,
		).toBe(true);
	});

	it("reports the offending line for a comma list", () => {
		const result = lintCloseKeywords("Intro.\nCloses #12, #13\nOutro.");
		expect(result.valid).toBe(false);
		expect(result.offendingLines).toEqual(["Closes #12, #13"]);
	});
});

describe("close-keyword syntax lint reads the live body (#2086)", () => {
	afterEach(() => {
		process.exitCode = undefined;
	});

	it("uses the live body when a rerun receives a stale event payload", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = prFetch({ body: "Closes #123. Closes #456." });
		const event = {
			pull_request: { number: 2086, body: "Closes #123, #456" },
		};

		await lintPullRequest(fetchImpl, event);

		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.test/repos/apmantza/pi-lens/pulls/2086",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(log).toHaveBeenCalledWith(
			"Close-keyword syntax OK (2 issues referenced).",
		);
		log.mockRestore();
	});

	it("sees close keywords in a normalized literal-newline body", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const flattened =
			"## Summary\\nThis is a complete worker-authored body that says Closes #2145.\\n\\n## Tests\\nThe section heading and issue reference are buried in literal newline soup.\\n\\n## Blast radius\\nChecking only.\\n\\n## Class sweep\\nShared seam.\\n\\n## Observability\\nWarn on normalization.";
		const fetchImpl = prFetch({ body: flattened });

		await lintPullRequest(fetchImpl, {
			pull_request: { number: 2145, body: flattened },
		});

		expect(log).toHaveBeenCalledWith(
			"Close-keyword syntax OK (1 issue referenced).",
		);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("checking only"),
		);
		warning.mockRestore();
		log.mockRestore();
	});

	// #2086 criterion 3: the lint path carries the same fail-closed guard set
	// the verify path got in #2267 -- missing token, non-2xx, malformed
	// response. Each states that the check did not run instead of surfacing
	// a bare throw that reads like a broken script.
	it("fails closed with an ::error record when GITHUB_TOKEN is unset", async () => {
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi.fn();
		const event = { pull_request: { number: 2086, body: "Closes #1, #2" } };

		await lintPullRequest(fetchImpl, event);

		expect(process.exitCode).toBe(1);
		expect(fetchImpl).not.toHaveBeenCalled();
		// Mutation-proof: letting the fetch error escape to the CLI .catch
		// prints the bare reason with no ::error:: and no did-not-run
		// statement; linting the stale payload instead would call log.
		expect(log).not.toHaveBeenCalled();
		expect(errorLog).toHaveBeenCalledWith(
			expect.stringContaining(
				"::error::Close-keyword syntax check could not fetch the live PR body, so it did not run:",
			),
		);
		errorLog.mockRestore();
		log.mockRestore();
	});

	it("fails closed with an ::error record on a non-2xx response", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("service unavailable", { status: 503 }));
		const event = { pull_request: { number: 2086, body: "Closes #1" } };

		await lintPullRequest(fetchImpl, event);

		expect(process.exitCode).toBe(1);
		expect(log).not.toHaveBeenCalled();
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("::error::"));
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("503"));
		errorLog.mockRestore();
		log.mockRestore();
	});

	it("fails closed with an ::error record on a malformed response", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
		const event = { pull_request: { number: 2086, body: "Closes #1" } };

		await lintPullRequest(fetchImpl, event);

		expect(process.exitCode).toBe(1);
		expect(log).not.toHaveBeenCalled();
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("::error::"));
		errorLog.mockRestore();
		log.mockRestore();
	});
});

describe("close-keyword placement reads the live title (#2640)", () => {
	afterEach(() => {
		process.exitCode = undefined;
	});

	it("fails the #2610 incident when the title keyword is absent from the body", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					title:
						'test: rename legacy "should" test names to behavior statements (closes #2602)',
					body: "Summary: rename legacy should test names to behavior statements.",
				}),
				{ status: 200 },
			),
		);

		await lintPullRequest(fetchImpl, { pull_request: { number: 2610 } });

		expect(process.exitCode).toBe(1);
		expect(errorLog).toHaveBeenCalledWith(
			expect.stringContaining("Invalid close-keyword placement"),
		);
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("#2602"));
		expect(errorLog).toHaveBeenCalledWith(
			expect.stringContaining("Closes #2602."),
		);
		expect(log).not.toHaveBeenCalled();
		errorLog.mockRestore();
		log.mockRestore();
	});

	it("accepts the repaired incident", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = prFetch({
			title: "fix: repair placement (closes #2602)",
			body: "Summary.\n\nCloses #2602.",
		});

		await lintPullRequest(fetchImpl, { pull_request: { number: 2610 } });

		expect(process.exitCode).toBeUndefined();
		expect(log).toHaveBeenCalledWith(
			"Close-keyword syntax OK (1 issue referenced).",
		);
		log.mockRestore();
	});

	it("reports syntax before placement", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					title: "fixes #1 and closes #3",
					body: "Closes #1, #2",
				}),
				{ status: 200 },
			),
		);

		await lintPullRequest(fetchImpl, { pull_request: { number: 2640 } });

		expect(errorLog).toHaveBeenCalledWith(INVALID_CLOSE_KEYWORD_MESSAGE);
		expect(errorLog).not.toHaveBeenCalledWith(
			expect.stringContaining("Invalid close-keyword placement"),
		);
		errorLog.mockRestore();
	});

	it("preserves the live title in fetchLivePrBody", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ title: "fix: title", body: "Summary" }), {
				status: 200,
			}),
		);
		expect(await fetchLivePrBody({ number: 2640 }, fetchImpl)).toMatchObject({
			title: "fix: title",
		});
	});
});

// #2086: verifyMergedPullRequest read pullRequest.body straight off the
// closed-event payload, so a rerun after the body was edited post-merge
// always relinted the STALE body. It now reuses check-pr-body.mjs's
// resolveLivePrBody (shipped for #2085) instead of a second implementation;
// that file's own "live PR body resolution (#2085)" suite already
// mutation-proves the fallback paths (missing token, non-2xx, malformed
// body), so this file only proves the regression case parseCloseKeywords
// actually cares about: an edited body changes the lint verdict.
describe("live PR body resolution (#2086)", () => {
	const payloadPr = { number: 2086, body: "Closes #123, #456" };

	it("uses the live body when it differs from the event payload", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ body: "Closes #123. Closes #456." }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const { body } = await fetchLivePrBody(payloadPr, fetchImpl);
		expect(body).toBe("Closes #123. Closes #456.");
		expect(lintCloseKeywords(body).valid).toBe(true);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.test/repos/apmantza/pi-lens/pulls/2086",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	// The regression case this issue exists for: an edit that FIXES the
	// comma-list problem must be seen on rerun, not masked by the stale
	// payload the closed event carried.
	it("sees a post-merge edit that fixes an invalid comma list", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ body: "Closes #123. Closes #456." }), {
				status: 200,
			}),
		);

		const { body } = await fetchLivePrBody(payloadPr, fetchImpl);
		expect(lintCloseKeywords(payloadPr.body).valid).toBe(false);
		expect(lintCloseKeywords(body).valid).toBe(true);
	});

	// The mirror case: an edit that INTRODUCES a comma list must be seen too,
	// not masked by a stale payload that looked clean at close time.
	it("sees a post-merge edit that introduces an invalid comma list", async () => {
		const cleanPayloadPr = { number: 2086, body: "Closes #123" };
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ body: "Closes #123, #456" }), {
				status: 200,
			}),
		);

		const { body } = await fetchLivePrBody(cleanPayloadPr, fetchImpl);
		expect(lintCloseKeywords(cleanPayloadPr.body).valid).toBe(true);
		expect(lintCloseKeywords(body).valid).toBe(false);
	});
});

// The actual regression this issue is about, exercised end to end through
// verifyMergedPullRequest itself (not just fetchLivePrBody in isolation):
// a rerun of --verify-merged must lint the LIVE body's issue references, not
// the ones frozen into the closed-event payload. Both fixture bodies name
// issues getIssueState reports as already closed, so the run always takes
// the "OK" branch and never touches the real `gh pr comment` side effects --
// the only difference under test is WHICH body's issue count gets logged.
describe("verifyMergedPullRequest reads the live body, not the stale payload (#2086)", () => {
	it("logs the live body's issue count, proving it did not use the stale payload's", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ body: "Closes #1. Closes #2." }), // live: 2 issues
				{ status: 200 },
			),
		);
		const event = {
			pull_request: { number: 2086, body: "Closes #1" }, // stale: 1 issue
		};
		const getIssueState = vi.fn().mockReturnValue("closed");

		await verifyMergedPullRequest(fetchImpl, event, getIssueState);

		// Mutation-proof: if verifyMergedPullRequest reverted to reading
		// pullRequest.body directly, this would report "1 issue" (the stale
		// payload) instead -- this exact assertion is what pins the fix, and
		// it needs no `gh` CLI, no comment-posting side effect.
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("2 issues closed"),
		);
		expect(getIssueState).toHaveBeenCalledWith("apmantza/pi-lens", 1);
		expect(getIssueState).toHaveBeenCalledWith("apmantza/pi-lens", 2);
		log.mockRestore();
	});
});

// #2267 F2 (fix round): a post-merge verification GATE must fail LOUD on a
// fetch problem, not warn-and-fall-back like the advisory body linter does.
// Reproduces the reviewer's exact production scenario: GITHUB_TOKEN unset
// (F1's shape) or the API returning non-2xx -- either way, the check used
// to log a ::warning:: and report "OK" on the stale payload. It must now
// set exitCode=1 with an ::error:: annotation and never reach the
// success-path console.log or the gh-CLI comment path.
describe("verifyMergedPullRequest fails closed on a live-fetch problem (#2267 F2)", () => {
	afterEach(() => {
		process.exitCode = undefined;
	});

	it("fails closed when GITHUB_TOKEN is unset (the F1 production shape)", async () => {
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi.fn();
		const event = { pull_request: { number: 2267, body: "Closes #1, #2" } };
		const getIssueState = vi.fn().mockReturnValue("open");

		await verifyMergedPullRequest(fetchImpl, event, getIssueState);

		expect(process.exitCode).toBe(1);
		expect(fetchImpl).not.toHaveBeenCalled();
		// Mutation-proof: reverting to resolveLivePrBody's swallow-and-warn
		// behavior would call console.warn (not console.error) and go on to
		// log a success/failure message from the STALE payload instead of
		// short-circuiting here -- this asserts neither happened.
		expect(log).not.toHaveBeenCalled();
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("::error::"));
		expect(errorLog).toHaveBeenCalledWith(
			expect.stringContaining("GITHUB_TOKEN is not set"),
		);
		expect(getIssueState).not.toHaveBeenCalled();
		errorLog.mockRestore();
		log.mockRestore();
	});

	it("fails closed when the GitHub API returns a non-2xx response", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("service unavailable", { status: 503 }));
		const event = { pull_request: { number: 2267, body: "Closes #1" } };
		const getIssueState = vi.fn();

		await verifyMergedPullRequest(fetchImpl, event, getIssueState);

		expect(process.exitCode).toBe(1);
		expect(getIssueState).not.toHaveBeenCalled();
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("503"));
		errorLog.mockRestore();
	});
});

// #2267 F1 (fix round, BLOCKING): the fix never fired in production because
// the workflow step set GH_TOKEN (for the gh CLI calls) but not
// GITHUB_TOKEN (which fetchLivePrBody/resolveLivePrBody read specifically)
// -- every real run threw "GITHUB_TOKEN is not set" before any fetch and
// silently used the stale payload, the exact bug #2086 exists to fix, under
// a different name. A source-level unit test can prove the function reads
// process.env.GITHUB_TOKEN, but nothing short of reading the workflow YAML
// itself proves the WIRING is correct in the one place it actually runs.
describe("close-keyword-verification.yml carries GITHUB_TOKEN (#2267 F1)", () => {
	it("sets both GH_TOKEN and GITHUB_TOKEN on the verify step", () => {
		const workflowPath = path.join(
			REPO_ROOT,
			".github/workflows/close-keyword-verification.yml",
		);
		type WorkflowStep = { run?: string; env?: Record<string, string> };
		type Workflow = { jobs: { verify: { steps: WorkflowStep[] } } };
		const workflow = yaml.load(
			fs.readFileSync(workflowPath, "utf8"),
		) as Workflow;
		const step = workflow.jobs.verify.steps.find((s) =>
			(s.run ?? "").includes("check-close-keywords.mjs"),
		);
		if (!step)
			throw new Error(
				"verify step not found in close-keyword-verification.yml",
			);
		// Mutation-proof: removing either line reds this. GH_TOKEN feeds the
		// `gh` CLI calls (issue-state lookups, the PR comment); GITHUB_TOKEN
		// feeds fetchLivePrBody -- check-pr-body.mjs reads that exact name,
		// not GH_TOKEN, so the two are NOT interchangeable here even though
		// they carry the same secret value.
		expect(step.env?.GH_TOKEN).toBeTruthy();
		expect(step.env?.GITHUB_TOKEN).toBeTruthy();
	});

	it("sets GITHUB_TOKEN on the syntax-lint step", () => {
		const workflowPath = path.join(
			REPO_ROOT,
			".github/workflows/pr-metadata.yml",
		);
		type WorkflowStep = { run?: string; env?: Record<string, string> };
		type Workflow = {
			jobs: { "pr-metadata": { steps: WorkflowStep[] } };
		};
		const workflow = yaml.load(
			fs.readFileSync(workflowPath, "utf8"),
		) as Workflow;
		const step = workflow.jobs["pr-metadata"].steps.find((s) =>
			(s.run ?? "").includes("check-close-keywords.mjs"),
		);
		if (!step) throw new Error("syntax-lint step not found in pr-metadata.yml");
		// Mutation-proof: without this workflow wiring the strict live fetch
		// fails before it can inspect the current PR body.
		expect(step.env?.GITHUB_TOKEN).toBeTruthy();
		expect(step.run).toContain("--lint-pr");
	});
});

describe("verifyMergedPullRequest checks title close keywords (#2640)", () => {
	it("fails when a title-only close target remains open", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					title: "fix: title-only close (closes #2640)",
					body: "Summary.",
				}),
				{ status: 200 },
			),
		);
		const getIssueState = vi.fn().mockReturnValue("open");

		await verifyMergedPullRequest(
			fetchImpl,
			{ pull_request: { number: 2744, body: "Summary." } },
			getIssueState,
		);

		expect(process.exitCode).toBe(1);
		expect(getIssueState).toHaveBeenCalledWith("apmantza/pi-lens", 2640);
		expect(errorLog).toHaveBeenCalledWith(
			"Post-merge close verification found title issue(s) that were not closed: #2640 (open).",
		);
		errorLog.mockRestore();
		process.exitCode = undefined;
	});
});

// #4371 recurrence: #4344's body had the table cell below, GitHub read
// "fixed: #4346" as a close and closed #4346 with its work undone; #4021's
// "Whether this closes #1513" linked #1513 the same way. The parser mirrors
// GitHub's adjacency rule, so a hedge or a table row does not stop it.
describe("negated and hedged close keywords (#4371)", () => {
	const TABLE_CELL =
		"| review graph incremental update (importer edge) | not fixed: #4346 |";
	const WHETHER =
		"Whether this closes #1513 is for the orchestrator: every named criterion is met.";

	it("flags the exact #4344 table cell", () => {
		const result = lintCloseKeywords(TABLE_CELL);
		expect(result.valid).toBe(false);
		expect(result.negatedLines).toEqual([TABLE_CELL]);
		expect(result.negatedIssues).toEqual([4346]);
	});

	it("flags the exact #4021 sentence", () => {
		const result = lintCloseKeywords(WHETHER);
		expect(result.valid).toBe(false);
		expect(result.negatedIssues).toEqual([1513]);
	});

	it.each([
		["a table row with no hedge", "| F4 | Closes #7 |"],
		["not", "This is not fixed: #7"],
		["never", "It never resolves #7"],
		["partially", "Partially closes #7"],
		["no longer", "The bug no longer fixes #7"],
		["a contraction", "It doesn't close #7"],
		// F1 recurrence: Word, macOS and LLM output write U+2019.
		["a curly-apostrophe contraction", "It doesn\u2019t close #7"],
		["neither", "Neither fixes #7"],
		["nor", "Nor closes #7"],
		["hardly", "It hardly resolves #7"],
	])("flags %s", (_name, line) => {
		expect(lintCloseKeywords(line).valid).toBe(false);
	});

	it.each([
		[
			"a closing sentence after prose",
			"The code and changelog are complete. Closes #3939",
		],
		["an unclosed parenthesis", "fix: thing (closes #4281"],
		["a bare keyword", "Closes #123"],
		["a clause after a hedge", "Not a regression, so this closes #5"],
		["a sentence after a negation", "Nothing else changes.\nFixes #9."],
		["a semicolon list", "Fixes #1. resolves #2; CLOSED #3"],
		["a heading line", "## Why\nCloses #8."],
		// F2 recurrence: a hedge earlier in the sentence must not flag a plain
		// close that has its own clause.
		["a coordinated clause", "This PR is not a draft and closes #12"],
		["a but clause", "Not a draft but closes #12"],
		["an em dash", "Not a breaking change \u2014 Closes #12"],
		["an en dash", "Not a breaking change \u2013 Closes #12"],
		["a spaced hyphen", "No new deps - fixes #12"],
	])("keeps %s clean", (_name, body) => {
		const result = lintCloseKeywords(body);
		expect(result.negatedLines).toEqual([]);
		expect(result.valid).toBe(true);
	});

	// F6 recurrence: removing any one boundary character left the suite green.
	// Each case puts the hedge BEFORE the boundary, so only the boundary keeps
	// the close clean.
	it.each([".", ",", ":", ";", "!", "?", "(", ")"])(
		"treats %s as a clause boundary",
		(boundary) => {
			expect(lintCloseKeywords(`not x${boundary} closes #9`).valid).toBe(true);
		},
	);

	// F3 recurrence (#3583): table rows named an issue another line closes
	// plainly; the lint blocked a body with no behaviour change.
	it("accepts an issue named in a table row that another line closes plainly", () => {
		const result = lintCloseKeywords("Closes #4.\n| pre-fix | fixes #4 |");
		expect(result.negatedIssues).toEqual([]);
		expect(result.negatedLines).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("still rejects an issue whose only close is hedged, beside a plain close of another", () => {
		const result = lintCloseKeywords("Closes #4.\nNot fixed: #5 elsewhere.");
		expect(result.negatedIssues).toEqual([5]);
		expect(result.negatedLines).toEqual(["Not fixed: #5 elsewhere."]);
		expect(result.valid).toBe(false);
	});

	// F4 recurrence (#2121): "It does not close\n#2074" linked nothing on
	// GitHub, yet the parser read across the newline and blocked the body.
	it("does not read a keyword and a number across a newline", () => {
		expect(parseCloseKeywords("It does not close\n#2074").issues).toEqual([]);
		expect(lintCloseKeywords("It does not close\n#2074").valid).toBe(true);
		expect(parseCloseKeywords("Closes: #3\nFixes   #4").issues).toEqual([3, 4]);
	});

	it("explains the rephrase in the lint error", () => {
		expect(NEGATED_CLOSE_KEYWORD_MESSAGE).toContain("not directly followed");
	});

	it("verify-merged reports a closed issue named only on a hedged line", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const body = `Closes #4320.\n${TABLE_CELL}`;
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ title: "fix: x", body }), {
				status: 200,
			}),
		);
		const getIssueState = vi.fn().mockReturnValue("closed");
		await verifyMergedPullRequest(
			fetchImpl,
			{ pull_request: { number: 4344, body } },
			getIssueState,
			() => 4344,
		);
		expect(process.exitCode).toBe(1);
		expect(errorLog.mock.calls[0]?.[0]).toContain(
			"closed only through a table row or hedged close keyword: #4346",
		);
		errorLog.mockRestore();
		process.exitCode = undefined;
	});

	// F5 recurrence: a hedged issue closed earlier by someone else, or a lookup
	// that failed, must not read as this PR's accident (or hide it).
	it.each([
		["another PR closed it", () => 4000, undefined],
		["a non-PR closer", () => null, undefined],
		["the closer lookup failed", () => undefined, 1],
	])("verify-merged when %s", async (_name, closer, exitCode) => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const body = `Closes #4320.\n${TABLE_CELL}`;
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ title: "fix: x", body }), {
				status: 200,
			}),
		);
		await verifyMergedPullRequest(
			fetchImpl,
			{ pull_request: { number: 4344, body } },
			vi.fn().mockReturnValue("closed"),
			closer,
		);
		expect(process.exitCode).toBe(exitCode);
		expect(errorLog.mock.calls.length > 0).toBe(exitCode === 1);
		errorLog.mockRestore();
		logSpy.mockRestore();
		process.exitCode = undefined;
	});

	it("verify-merged still reports an open clean issue beside a hedged accident", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const body = `Closes #4320.\n${TABLE_CELL}`;
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ title: "fix: x", body }), {
				status: 200,
			}),
		);
		const getIssueState = vi.fn((_repo: string, n: number) =>
			n === 4320 ? "open" : "closed",
		);
		await verifyMergedPullRequest(
			fetchImpl,
			{ pull_request: { number: 4344, body } },
			getIssueState,
			() => 4344,
		);
		const output = errorLog.mock.calls
			.map((call) => String(call[0]))
			.join("\n");
		expect(output).toContain("hedged close keyword: #4346");
		expect(output).toContain("#4320 (open)");
		expect(vi.mocked(childProcess.execFileSync)).toHaveBeenCalledWith(
			"gh",
			expect.arrayContaining(["comment", "4344"]),
			expect.anything(),
		);
		errorLog.mockRestore();
		process.exitCode = undefined;
	});

	it("verify-merged does not expect an open hedged issue to be closed", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const body = `Closes #4320.\n${TABLE_CELL}`;
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ title: "fix: x", body }), {
				status: 200,
			}),
		);
		const getIssueState = vi.fn((_repo: string, n: number) =>
			n === 4320 ? "closed" : "open",
		);
		await verifyMergedPullRequest(
			fetchImpl,
			{ pull_request: { number: 4344, body } },
			getIssueState,
		);
		expect(process.exitCode).toBeUndefined();
		expect(errorLog).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			"Post-merge close verification OK (1 issue closed).",
		);
		errorLog.mockRestore();
		logSpy.mockRestore();
	});
});

// #4371: GitHub closes an issue for a close keyword in a COMMIT message that
// reaches master. f40ac6c28 (#4375 itself) quoted two hedged keywords in its
// message and merging it closed both issues; the title/body lint never read it.
describe("close keywords in commit messages (#4371)", () => {
	// The exact message of f40ac6c28, as the commits API returns it.
	const F40AC6C28 = `ci: flag negated and hedged close keywords

GitHub closes an issue for any "keyword #N" or "keyword: #N", whatever
words precede it. #4344's table cell "not fixed: #4346" closed #4346
with its work undone, and #4021's "Whether this closes #1513" linked
#1513. The lint now marks a closing match offending when its line is a
table row or its clause (since the last sentence or clause boundary)
holds a negation or hedge. Closes on their own clause, such as
"... complete. Closes #N" and "(closes #N", stay clean.

One closeKeywordErrors helper replaces the three copies of the
comma-list message printer. --verify-merged stops expecting a hedged
issue to be closed and fails when one was.

Refs #4371

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`;
	const TITLE = "ci: flag negated and hedged close keywords (refs #4371)";
	const BODY = "## Why\n\nRefs #4371.";
	const commit = (message: string, sha = "a".repeat(40)) => ({ sha, message });
	const offended = (
		commits: Array<{ sha: string; message: string }>,
		title = TITLE,
		body = BODY,
	) =>
		lintCommitCloseKeywords(commits, title, body).offenses.map(
			({ number }) => number,
		);

	afterEach(() => {
		process.exitCode = undefined;
	});

	it("flags f40ac6c28's hedged keywords, and only those", () => {
		const result = lintCommitCloseKeywords(
			[commit(F40AC6C28, "f40ac6c28" + "0".repeat(31))],
			TITLE,
			BODY,
		);
		expect(result.valid).toBe(false);
		expect(result.offenses.map(({ number }) => number)).toEqual([4346, 1513]);
		expect(result.offenses[0]).toMatchObject({
			sha: "f40ac6c28" + "0".repeat(31),
			line: expect.stringContaining("not fixed: #4346"),
		});
		// "Refs #4371" is not a closing keyword.
		expect(commitCloseKeywordErrors(result).join("\n")).not.toContain(
			"would close #4371",
		);
	});

	// #4422 review F1: a line-leading keyword is not intent. Each message below
	// closes #7 on GitHub, and a body that only refs #7 never asked for that.
	it.each([
		[
			"a hard-wrapped sentence",
			"fix: x\n\nrewrapped so it\nfixes #7 and similar text",
		],
		["a negated line", "fix: x\n\nCloses #7 is NOT what this commit does."],
		["a bare trailer", "fix: x\n\nCloses #7\n\nCo-Authored-By: A <a@b>"],
		["a colon trailer in CRLF", "fix: x\r\n\r\n  FIXES: #7\r\n"],
	])("flags %s when the PR only refs the issue", (_name, message) => {
		expect(offended([commit(message)], "fix: x (refs #7)", "Refs #7.")).toEqual(
			[7],
		);
	});

	it("accepts any form of the keyword once the PR body closes the issue", () => {
		for (const message of [
			"fix: x\n\nCloses #7",
			"fix: x\n\nit\nfixes #7 in prose",
			"fix: x (closes #7)",
		])
			expect(offended([commit(message)], "fix: x", "Closes #7.")).toEqual([]);
	});

	// #4422 review F4: a headline "(closes #N)" is not intent either, and a
	// parenthesis that does not close right after the number never was.
	it("flags a headline keyword the PR does not close", () => {
		for (const headline of [
			"fix: x (closes #12)",
			"fix: thing (fixes #12 was wrong)",
		])
			expect(offended([commit(headline)], TITLE, BODY)).toEqual([12]);
	});

	it("flags a mid-sentence keyword and one quoted in backticks or a fence", () => {
		expect(offended([commit("fix: x\n\nthis closes #7 on merge")])).toEqual([
			7,
		]);
		// Fail closed: nothing proves GitHub ignores a quoted keyword in a commit.
		expect(offended([commit("fix: x\n\nsaid `closes #8` once")])).toEqual([8]);
		expect(
			offended([commit("fix: x\n\n```\ncloses #9\n```\nafter\n\n> fixes #10")]),
		).toEqual([9, 10]);
	});

	it("takes the PR title (closes #N) and a clean body keyword as intent", () => {
		const hedged = commit("fix: x\n\nWhether this closes #1513 is open");
		expect(offended([hedged])).toEqual([1513]);
		expect(offended([hedged], "fix: x (closes #1513)")).toEqual([]);
		expect(offended([hedged], TITLE, "Closes #1513.")).toEqual([]);
		// A body line that is itself negated never vouches for the commit.
		expect(offended([hedged], TITLE, "| not fixed: #1513 |")).toEqual([1513]);
	});

	it("keeps the commit's sha and the offending line in the error lines", () => {
		const errors = commitCloseKeywordErrors(
			lintCommitCloseKeywords(
				[commit(F40AC6C28, "f40ac6c28" + "0".repeat(31))],
				TITLE,
				BODY,
			),
		);
		expect(errors).toEqual([
			COMMIT_CLOSE_KEYWORD_MESSAGE,
			`  commit f40ac6c28 would close #4346: words precede it. #4344's table cell "not fixed: #4346" closed #4346`,
			`  commit f40ac6c28 would close #1513: with its work undone, and #4021's "Whether this closes #1513" linked`,
		]);
	});

	describe("--lint-pr", () => {
		const env = () => {
			vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
			vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
			vi.stubEnv("GITHUB_TOKEN", "test-token");
		};

		it("exits 1 on f40ac6c28's message and prints the sha", async () => {
			env();
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const fetchImpl = prFetch({ title: TITLE, body: BODY }, [
				commit("ci: x\n\nbody", "1".repeat(40)),
				commit(F40AC6C28, "f40ac6c28" + "0".repeat(31)),
			]);

			await lintPullRequest(fetchImpl, { pull_request: { number: 4375 } });

			expect(process.exitCode).toBe(1);
			expect(log).not.toHaveBeenCalled();
			const output = errorLog.mock.calls.map((call) => String(call[0]));
			expect(output).toContain(COMMIT_CLOSE_KEYWORD_MESSAGE);
			expect(output.join("\n")).toContain("commit f40ac6c28 would close #4346");
			expect(output.join("\n")).not.toContain("111111111");
			expect(fetchImpl).toHaveBeenCalledWith(
				"https://api.github.test/repos/apmantza/pi-lens/pulls/4375/commits?per_page=100&page=1",
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			errorLog.mockRestore();
			log.mockRestore();
		});

		it("stays green for commits whose keyword the PR intends", async () => {
			env();
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const fetchImpl = prFetch(
				{ title: "fix: x (closes #4371)", body: "Why.\n\nCloses #4371" },
				[
					commit("fix: x\n\nCloses #4371"),
					commit("test: y\n\nrefs #4371"),
					commit("Merge branch 'master' into ci/4371-x", "b".repeat(40)),
				],
			);

			await lintPullRequest(fetchImpl, { pull_request: { number: 4376 } });

			expect(process.exitCode).toBeUndefined();
			expect(log).toHaveBeenCalledWith(
				"Close-keyword syntax OK (1 issue referenced).",
			);
			log.mockRestore();
		});

		it("scans a merge commit like any other", async () => {
			env();
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			const fetchImpl = prFetch({ title: TITLE, body: BODY }, [
				{ ...commit("Merge branch 'master'\n\nso it fixes #44"), parents: 2 },
			]);

			await lintPullRequest(fetchImpl, { pull_request: { number: 4377 } });

			expect(process.exitCode).toBe(1);
			expect(errorLog.mock.calls.flat().join("\n")).toContain(
				"would close #44",
			);
			errorLog.mockRestore();
		});

		it("reads every page of a long PR", async () => {
			env();
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			const many = Array.from({ length: 120 }, (_, i) =>
				commit(
					i === 119 ? "x\n\nit closes #55" : "x",
					String(i).padStart(40, "0"),
				),
			);
			const fetchImpl = prFetch({ title: TITLE, body: BODY }, many);

			await lintPullRequest(fetchImpl, { pull_request: { number: 4378 } });

			expect(process.exitCode).toBe(1);
			expect(errorLog.mock.calls.flat().join("\n")).toContain(
				"would close #55",
			);
			errorLog.mockRestore();
		});

		it.each([
			["a non-2xx answer", () => new Response("nope", { status: 403 }), "403"],
			[
				"a non-list answer",
				() => new Response("{}", { status: 200 }),
				"no commit list",
			],
			[
				"a commit without a message",
				() => new Response(JSON.stringify([{ sha: "a" }]), { status: 200 }),
				"without a message",
			],
		])("fails closed on %s", async (_name, answer, reason) => {
			env();
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const fetchImpl = prFetch({ title: TITLE, body: BODY }, [], answer);

			await lintPullRequest(fetchImpl, { pull_request: { number: 4379 } });

			expect(process.exitCode).toBe(1);
			expect(log).not.toHaveBeenCalled();
			expect(errorLog.mock.calls[0]?.[0]).toContain(
				"::error::Close-keyword syntax check could not read the PR commits",
			);
			expect(errorLog.mock.calls[0]?.[0]).toContain(reason);
			errorLog.mockRestore();
			log.mockRestore();
		});

		it("fails closed on a PR at GitHub's 250-commit listing cap", async () => {
			env();
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			const full = Array.from({ length: 250 }, (_, i) =>
				commit("x", String(i).padStart(40, "0")),
			);
			const fetchImpl = prFetch({ title: TITLE, body: BODY }, full);

			await lintPullRequest(fetchImpl, { pull_request: { number: 4380 } });

			expect(process.exitCode).toBe(1);
			expect(errorLog.mock.calls[0]?.[0]).toContain("250 or more commits");
			errorLog.mockRestore();
		});
	});
});
