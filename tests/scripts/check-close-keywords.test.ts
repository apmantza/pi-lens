import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	INVALID_CLOSE_KEYWORD_MESSAGE,
	lintCloseKeywords,
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
import { fetchLivePrBody } from "../../scripts/check-pr-body.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

afterEach(() => {
	vi.unstubAllEnvs();
});

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
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ body: "Closes #123. Closes #456." }), {
				status: 200,
			}),
		);
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
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ body: flattened }), { status: 200 }),
			);

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
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					title: "fix: repair placement (closes #2602)",
					body: "Summary.\n\nCloses #2602.",
				}),
				{ status: 200 },
			),
		);

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
		const workflowPath = path.join(REPO_ROOT, ".github/workflows/ci.yml");
		type WorkflowStep = { run?: string; env?: Record<string, string> };
		type Workflow = {
			jobs: { "close-keyword-lint": { steps: WorkflowStep[] } };
		};
		const workflow = yaml.load(
			fs.readFileSync(workflowPath, "utf8"),
		) as Workflow;
		const step = workflow.jobs["close-keyword-lint"].steps.find((s) =>
			(s.run ?? "").includes("check-close-keywords.mjs"),
		);
		if (!step) throw new Error("syntax-lint step not found in ci.yml");
		// Mutation-proof: without this workflow wiring the strict live fetch
		// fails before it can inspect the current PR body.
		expect(step.env?.GITHUB_TOKEN).toBeTruthy();
		expect(step.run).toContain("--lint-pr");
	});
});
