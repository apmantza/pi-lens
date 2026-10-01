// #3779: the advisory MUTATION line `scripts/ci-verdict.mjs` prints from the
// `Mutation diff` sticky comment. Every test drives the real CLI entry,
// `run()`, with a `gh` double that replays RECORDED comment lists: the raw
// `gh api repos/apmantza/pi-lens/issues/<n>/comments --paginate` output of
// #3755, #3757 and #3741 (tests/fixtures/ci-verdict/mutation-comments, fetched
// 2026-09-30), and no network.
//
// Recurrences this file guards:
//  - survivors on added lines merged unread (#3755 `value > 0` -> `>= 0`,
//    #3757 eight survivors on the `why === "cap"` branch) because nothing in
//    the verdict read the Mutation diff comment;
//  - the sticky can describe an older or cancelled head, so the line must say
//    which head it covers (STALE);
//  - the line is advisory: a survivor count must never move an exit code
//    (scripts/ci-verdict.mjs's advisory split, #3700);
//  - the `--watch-open --stream` poll runs for hours; the comment is read at
//    an event, never per poll.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EXIT_FAILURE,
	JOB_LOG_MAX_BUFFER,
	EXIT_PENDING,
	EXIT_SUCCESS,
	run,
	WATCH_POLL_INTERVAL_SECONDS,
} from "../../scripts/ci-verdict.mjs";
import {
	renderMutationMarkdown,
	renderStaleMarkdown,
} from "../../scripts/lib/mutation-report-render.mjs";

interface Comment {
	id: number;
	body: string;
	user: { login: string };
}
const recorded = (pr: number): Comment[] =>
	JSON.parse(
		readFileSync(
			join(
				process.cwd(),
				`tests/fixtures/ci-verdict/mutation-comments/pr-${pr}-comments.json`,
			),
			"utf8",
		),
	);

// The full head SHAs of the heads those three comments cover.
const HEAD_3755 = "9cf3972f942168a847fd53bdd86e8d843427f566";
const HEAD_3757 = "695957036fb649fd1944bddb2a66f5a8a290253f";
const HEAD_3741 = "67d1d2939e16c4d35207cb78bb2ecb62de7eb60e";
const OTHER_HEAD = "b".repeat(40);
const PREFIX = "MUTATION (advisory, never gates):";

const check = (
	name: string,
	conclusion: string | null,
	status = "completed",
) => ({
	name,
	status,
	conclusion,
	started_at: "2026-09-30T11:00:00Z",
	id: name.length,
	html_url: `https://github.com/apmantza/pi-lens/actions/runs/1/job/${name.length}`,
	details_url: `https://github.com/apmantza/pi-lens/actions/runs/1/job/${name.length}`,
});
const GREEN = [
	check("Unit tests", "success"),
	check("Lint & type-check", "success"),
];

interface World {
	sha: string;
	checkRuns: unknown[];
	comments: unknown[] | "throws";
	mergeable?: string;
	calls: string[];
	commentOptions: { timeoutMs?: number; maxBuffer?: number }[];
	prs?: { number: number }[];
}

/** A `gh` that answers from a World and refuses anything unrecorded. */
function ghFor(w: World) {
	return (
		args: string[],
		options: { timeoutMs?: number; maxBuffer?: number } = {},
	) => {
		w.calls.push(args.join(" "));
		if (args[0] === "repo") return "apmantza/pi-lens";
		if (args[0] === "pr" && args[1] === "list")
			return JSON.stringify(
				(w.prs ?? []).map((p) => ({
					number: p.number,
					author: { login: "apmantza" },
					headRefOid: w.sha,
					autoMergeRequest: null,
				})),
			);
		if (args[0] === "pr" && args[1] === "view")
			return JSON.stringify({
				headRefOid: w.sha,
				mergeable: w.mergeable ?? "MERGEABLE",
				labels: [],
				comments: [],
			});
		if (args[0] === "api" && args[1] === "user") throw new Error("HTTP 401");
		const endpoint = args[1] ?? "";
		if (endpoint.endsWith("/branches/master/protection"))
			throw new Error("HTTP 404: Not Found");
		if (/\/commits\/[0-9a-f]+\/check-runs/.test(endpoint))
			return JSON.stringify({
				total_count: w.checkRuns.length,
				check_runs: w.checkRuns,
			});
		if (/\/issues\/[^/]+\/comments$/.test(endpoint)) {
			if (!args.includes("--paginate"))
				throw new Error("comment read without --paginate");
			w.commentOptions.push(options);
			if (w.comments === "throws") throw new Error("HTTP 502: Bad Gateway");
			return JSON.stringify(w.comments);
		}
		throw new Error(`unmocked gh call: ${args.join(" ")}`);
	};
}
const world = (partial: Partial<World> & Pick<World, "sha">): World => ({
	checkRuns: GREEN,
	comments: [],
	calls: [],
	commentOptions: [],
	...partial,
});
const commentCalls = (w: World) =>
	w.calls.filter((call) => /issues\/[^/]+\/comments/.test(call));

async function cli(argv: string[], w: World) {
	const lines: string[] = [];
	const { code: exitCode } = await run({
		argv,
		ghExec: ghFor(w),
		stdout: (line: string) => lines.push(line),
		stderr: () => {},
		now: () => Date.parse("2026-09-30T12:00:00Z"),
		sleepImpl: async () => {},
	});
	return {
		exitCode,
		lines,
		mutation: lines.filter((line) => line.startsWith("MUTATION")),
	};
}

describe("run — the MUTATION line over recorded Mutation diff comments (#3779)", () => {
	it("#3755: two survivors on the head the comment covers", async () => {
		const out = await cli(
			["3755"],
			world({ sha: HEAD_3755, comments: recorded(3755) }),
		);
		expect(out.mutation).toEqual([`${PREFIX} 2 survivors, head 9cf3972f9421`]);
		expect(out.exitCode).toBe(EXIT_SUCCESS);
	});

	it("#3757: eight survivors, and the truncated test population is named", async () => {
		const out = await cli(
			["3757"],
			world({ sha: HEAD_3757, comments: recorded(3757) }),
		);
		expect(out.mutation).toEqual([
			`${PREFIX} 8 survivors, truncated test population, head 695957036fb6`,
		]);
	});

	it("#3741: six survivors on a sampled, truncated run", async () => {
		const out = await cli(
			["3741"],
			world({ sha: HEAD_3741, comments: recorded(3741) }),
		);
		expect(out.mutation).toEqual([
			`${PREFIX} 6 survivors, truncated test population, head 67d1d2939e16`,
		]);
	});

	it("prints the line before the verdict reason, which stays the last line", async () => {
		const out = await cli(
			["3755"],
			world({ sha: HEAD_3755, comments: recorded(3755) }),
		);
		expect(out.lines.at(-1)).toBe("every gating check concluded success");
		expect(out.lines.indexOf(out.mutation[0])).toBe(out.lines.length - 2);
	});

	it("STALE: a comment for an older head is reported with both heads", async () => {
		const out = await cli(
			["3755"],
			world({ sha: OTHER_HEAD, comments: recorded(3755) }),
		);
		expect(out.mutation).toEqual([
			`${PREFIX} 2 survivors, head 9cf3972f9421, STALE (PR head is ${OTHER_HEAD.slice(0, 12)})`,
		]);
	});

	it("is not STALE when the PR head merely extends the comment's short head", async () => {
		const out = await cli(
			["3755"],
			world({ sha: HEAD_3755, comments: recorded(3755) }),
		);
		expect(out.mutation[0]).not.toContain("STALE");
	});

	it("PENDING: no Mutation diff comment yet", async () => {
		const others = recorded(3755).filter(
			(c) => c.user.login === "sonarqubecloud[bot]",
		);
		const out = await cli(
			["3755"],
			world({ sha: HEAD_3755, comments: others }),
		);
		expect(out.mutation).toEqual([
			`${PREFIX} PENDING -- no Mutation diff comment on this PR yet`,
		]);
	});

	// Recurrence (round 2, F3): with no sticky and a COMPLETED job (it failed,
	// was cancelled, or the comment job never ran: `--stale` posts nothing when
	// no sticky exists) the line read PENDING forever.
	it.each(["failure", "cancelled", "success"])(
		"no comment although the mutation job completed (%s) is a finished job with no report, not PENDING",
		async (conclusion) => {
			const out = await cli(
				["3755"],
				world({
					sha: HEAD_3755,
					comments: [],
					checkRuns: [...GREEN, check("mutation (advisory)", conclusion)],
				}),
			);
			expect(out.mutation).toEqual([
				`${PREFIX} no report (job ${conclusion}) -- no Mutation diff comment on this PR`,
			]);
			expect(out.exitCode).toBe(EXIT_SUCCESS);
		},
	);

	it("PENDING: no comment while the mutation job is still running", async () => {
		const out = await cli(
			["3755"],
			world({
				sha: HEAD_3755,
				comments: [],
				checkRuns: [...GREEN, check("mutation (advisory)", null, "queued")],
			}),
		);
		expect(out.mutation).toEqual([
			`${PREFIX} PENDING -- no Mutation diff comment on this PR yet`,
		]);
	});

	it("PENDING: the mutation job is still running on this head, even with an older comment", async () => {
		const out = await cli(
			["3755"],
			world({
				sha: OTHER_HEAD,
				comments: recorded(3755),
				checkRuns: [
					...GREEN,
					check("mutation (advisory)", null, "in_progress"),
				],
			}),
		);
		expect(out.mutation).toEqual([
			`${PREFIX} PENDING -- the mutation job is in_progress on PR head ${OTHER_HEAD.slice(0, 12)}; the last comment covers 9cf3972f9421`,
		]);
	});

	it("ignores a marker-bearing comment a human pasted (the sticky is the bot's)", async () => {
		const pasted = recorded(3755).map((c) => ({
			...c,
			user: { login: "someone-else" },
		}));
		const out = await cli(
			["3755"],
			world({ sha: HEAD_3755, comments: pasted }),
		);
		expect(out.mutation[0]).toContain("PENDING -- no Mutation diff comment");
	});

	it("an unreadable comment list is named and does not turn into a transport failure", async () => {
		const out = await cli(
			["3755"],
			world({ sha: HEAD_3755, comments: "throws" }),
		);
		expect(out.mutation).toEqual([
			`${PREFIX} unreadable -- HTTP 502: Bad Gateway`,
		]);
		expect(out.exitCode).toBe(EXIT_SUCCESS);
	});

	it("reads the comments with one call, and none for a bare-SHA target", async () => {
		const pr = world({ sha: HEAD_3755, comments: recorded(3755) });
		await cli(["3755"], pr);
		expect(commentCalls(pr)).toEqual([
			"api repos/apmantza/pi-lens/issues/3755/comments --paginate",
		]);
		// A PR with long review comments overflows execFileSync's 1 MB default.
		expect(pr.commentOptions).toEqual([
			{ timeoutMs: expect.any(Number), maxBuffer: JOB_LOG_MAX_BUFFER },
		]);
		const bare = world({ sha: HEAD_3755, comments: recorded(3755) });
		await cli([HEAD_3755], bare);
		expect(commentCalls(bare)).toEqual([]);
	});
});

describe("run --wait — the MUTATION read is charged to the --wait budget (#3779 round 2)", () => {
	// Recurrence: the post-verdict read took the startup timeout (up to 60 s)
	// however much of --wait the polls had already spent, so a hung api call
	// could overshoot the budget it was armed with.
	it("gets only what the poll left of --wait, not the startup allowance", async () => {
		const w = world({ sha: HEAD_3755, comments: recorded(3755) });
		const gh = ghFor(w);
		let reads = 0;
		let clock = Date.parse("2026-09-30T12:00:00Z");
		const { code: exitCode } = await run({
			argv: ["3755", "--wait", "40"],
			ghExec: (args: string[], options?: { timeoutMs?: number }) => {
				if (/check-runs/.test(args[1] ?? "") && (reads += 1) === 1)
					w.checkRuns = [check("Unit tests", null, "in_progress"), GREEN[1]];
				else if (/check-runs/.test(args[1] ?? "")) w.checkRuns = GREEN;
				return gh(args, options);
			},
			stdout: () => {},
			stderr: () => {},
			now: () => clock,
			sleepImpl: async (ms: number) => {
				clock += ms;
			},
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(w.commentOptions).toEqual([
			{ timeoutMs: 40_000 - 30_000, maxBuffer: JOB_LOG_MAX_BUFFER },
		]);
	});
});

describe("run — the MUTATION line never changes an exit code (#3779)", () => {
	const twenty = (head: string): Comment[] => [
		{
			id: 1,
			user: { login: "github-actions[bot]" },
			body: `<!-- pi-lens-mutation-diff -->\n### Mutation diff (advisory)\n\n**Score: 1.00%** -- 0 killed, 20 survived, 0 timeout, 0 no coverage (20 total)\n\n#### Survivors (20)\n\n- **Base:** origin/master\n- **Head:** \`${head.slice(0, 12)}\`\n`,
		},
	];

	it("20 survivors on a green head still exits 0", async () => {
		const out = await cli(
			["3755"],
			world({ sha: HEAD_3755, comments: twenty(HEAD_3755) }),
		);
		expect(out.mutation).toEqual([`${PREFIX} 20 survivors, head 9cf3972f9421`]);
		expect(out.exitCode).toBe(EXIT_SUCCESS);
	});

	it("a clean comment on a red head still exits 1", async () => {
		const clean = twenty(HEAD_3755).map((c) => ({
			...c,
			body: c.body.replace(/#### Survivors \(20\)/, "No survivors."),
		}));
		const out = await cli(
			["3755"],
			world({
				sha: HEAD_3755,
				comments: clean,
				checkRuns: [check("Unit tests", "failure"), GREEN[1]],
			}),
		);
		expect(out.mutation).toEqual([`${PREFIX} 0 survivors, head 9cf3972f9421`]);
		expect(out.exitCode).toBe(EXIT_FAILURE);
	});

	it("20 survivors on a pending head still exits 3", async () => {
		const out = await cli(
			["3755"],
			world({
				sha: HEAD_3755,
				comments: twenty(HEAD_3755),
				checkRuns: [check("Unit tests", null, "in_progress"), GREEN[1]],
			}),
		);
		expect(out.exitCode).toBe(EXIT_PENDING);
	});

	it("a STALE comment on a green head still exits 0", async () => {
		const out = await cli(
			["3755"],
			world({ sha: OTHER_HEAD, comments: twenty(HEAD_3755) }),
		);
		expect(out.mutation[0]).toContain("STALE");
		expect(out.exitCode).toBe(EXIT_SUCCESS);
	});
});

describe("the MUTATION line — every body form the renderer writes (#3779)", () => {
	// Pins the parser to its real producer: a wording change in
	// scripts/lib/mutation-report-render.mjs would otherwise turn every line
	// into "unparsed comment" while the recorded fixtures above stayed green.
	const HEAD = "c".repeat(40);
	const SHORT = "c".repeat(12);
	const report = (meta: Record<string, unknown>, survived: number) => ({
		piLensMutationDiff: {
			base: "origin/master",
			headSha: HEAD,
			score: "50.00",
			counts: { Killed: 1, Survived: survived },
			...meta,
		},
		files: {
			"clients/x.js": {
				mutants: [
					{
						status: "Killed",
						mutatorName: "X",
						location: { start: { line: 1 } },
					},
					...Array.from({ length: survived }, () => ({
						status: "Survived",
						mutatorName: "X",
						original: "a",
						replacement: "b",
						location: { start: { line: 2 } },
					})),
				],
			},
		},
	});
	const lineFor = async (body: string) => {
		const out = await cli(
			["1"],
			world({
				sha: HEAD,
				comments: [{ id: 7, body, user: { login: "github-actions[bot]" } }],
			}),
		);
		return out.mutation[0];
	};

	it("a scored run with survivors", async () => {
		expect(await lineFor(renderMutationMarkdown(report({}, 3)))).toBe(
			`${PREFIX} 3 survivors, head ${SHORT}`,
		);
	});

	it("a scored run with none", async () => {
		expect(await lineFor(renderMutationMarkdown(report({}, 0)))).toBe(
			`${PREFIX} 0 survivors, head ${SHORT}`,
		);
	});

	it("a partial run is flagged", async () => {
		const body = renderMutationMarkdown(
			report({ partial: { evaluated: 2, total: 9, reason: "budget" } }, 1),
		);
		expect(await lineFor(body)).toBe(
			`${PREFIX} 1 survivors, partial run, head ${SHORT}`,
		);
	});

	it("a zero-mutant run is not read as a clean pass", async () => {
		const body = renderMutationMarkdown({
			piLensMutationDiff: {
				base: "origin/master",
				headSha: HEAD,
				zeroMutants: { reason: "nothing to mutate" },
			},
			files: {},
		});
		expect(await lineFor(body)).toBe(
			`${PREFIX} 0 mutants evaluated (not a clean pass), head ${SHORT}`,
		);
	});

	it("an incomplete run is not read as a clean pass", async () => {
		const body = renderMutationMarkdown(report({ measuredTotalMutants: 9 }, 0));
		expect(await lineFor(body)).toBe(
			`${PREFIX} incomplete run (not a clean pass), head ${SHORT}`,
		);
	});

	it("the stale marker for a head that produced no report", async () => {
		expect(await lineFor(renderStaleMarkdown({ headSha: HEAD }))).toBe(
			`${PREFIX} no report for that head (crash, cancel or time cap), head ${SHORT}`,
		);
	});

	// Recurrence (round 2, F4): a survivor cell quotes source text, and this
	// repo's own renderer literals are source text (the workflow mutates
	// scripts/**/*.mjs). An unanchored match read "0 mutants evaluated" or "no
	// report" for a body that carried real survivors.
	it.each([
		"**0 mutants evaluated.** x",
		"**Stale.** This head (`dddddddddddd`) produced no mutation report",
		"**Incomplete run.** x",
		"**Partial run** -- x",
		"truncated test population",
		"- **Head:** `dddddddddddd`",
	])(
		"a survivor cell quoting %j does not change the reading",
		async (quoted) => {
			const base = report({}, 2);
			const body = renderMutationMarkdown({
				...base,
				files: {
					"clients/x.js": {
						mutants: [
							...base.files["clients/x.js"].mutants,
							{
								status: "Survived",
								mutatorName: "StringLiteral",
								original: quoted,
								replacement: quoted,
								location: { start: { line: 3 } },
							},
						],
					},
				},
			});
			expect(await lineFor(body)).toBe(`${PREFIX} 3 survivors, head ${SHORT}`);
		},
	);

	it("a body with no recognisable form is named, not guessed", async () => {
		const body = "<!-- pi-lens-mutation-diff -->\nsomething else entirely";
		expect(await lineFor(body)).toBe(
			`${PREFIX} unparsed comment, head unknown, STALE (PR head is ${SHORT})`,
		);
	});
});

describe("run --watch-open --stream — the MUTATION line is not part of an event (#3779 round 2)", () => {
	// Recurrence: round 1 appended a second line to each event and read the
	// comments at an event. An event is never a mergeable head, so the read
	// decided nothing, it broke the documented one-line-per-event stream, and
	// it redded master's "deduplicates one CANCELLED-NOT-REPLACED hint" test
	// on the merge ref (an unmocked /comments call).
	const watch = async (w: World, onSleep: (sleeps: number) => void) => {
		const lines: string[] = [];
		let sleeps = 0;
		await run({
			argv: [
				"--watch-open",
				"--stream",
				"--wait",
				String(WATCH_POLL_INTERVAL_SECONDS * 3),
			],
			ghExec: ghFor(w),
			stdout: (line: string) => lines.push(line),
			stderr: () => {},
			now: () =>
				Date.parse("2026-09-30T12:00:00Z") +
				sleeps * WATCH_POLL_INTERVAL_SECONDS * 1000,
			sleepImpl: async () => {
				sleeps += 1;
				onSleep(sleeps);
			},
		});
		return lines;
	};

	it("a DIRTY event is exactly one line, and no poll or event reads the comments", async () => {
		const w = world({
			sha: HEAD_3755,
			comments: recorded(3755),
			prs: [{ number: 3755 }],
		});
		const lines = await watch(w, (sleeps) => {
			if (sleeps === 2) w.mergeable = "CONFLICTING";
		});
		const headReads = w.calls.filter((call) =>
			call.startsWith("pr view 3755"),
		).length;
		expect(headReads).toBeGreaterThanOrEqual(3);
		expect(lines.filter((line) => line.startsWith("DIRTY #3755"))).toHaveLength(
			1,
		);
		expect(lines.some((line) => line.includes("MUTATION"))).toBe(false);
		expect(commentCalls(w)).toEqual([]);
	});
});
