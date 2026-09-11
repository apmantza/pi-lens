// flake-shape: real-process-spawn — the exact local CLI and shallow checkout are the subject; an in-process call cannot prove either command boundary.
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, afterEach, vi } from "vitest";
import {
	gitExecFileSync,
	gitExecSync,
} from "../../scripts/lib/git-fixture-env.mjs";
import {
	detectEscapedNewlineBody,
	detectFlattenedBody,
	lintPullRequestEvent,
	lintLocalPrBody,
	localDiff,
	lintPrBody,
	repairEscapedNewlineBody,
	repairFlattenedBody,
	resolveLivePrBody,
	resolveTouchesTests,
} from "../../scripts/check-pr-body.mjs";

const body = `Summary\nOpening context.\n\n## Tests\nTargeted tests pass.\n\n## Blast radius\nNo runtime module touched.\n\n## Class sweep\nWhole-tree grep completed.\n\n## Observability\nThe advisory check run is the record.`;
const repositoryRoot = process.cwd();
type MergedRuntimeRecord = { name: string; kind: string; diff: string };
const mergedRuntimeRecords = JSON.parse(
	readFileSync(
		join(
			repositoryRoot,
			"tests",
			"fixtures",
			"ci-pr-bodies",
			"merged-runtime-records.json",
		),
		"utf8",
	),
) as MergedRuntimeRecord[];
// Regenerated from `gh pr diff 2860`, `gh pr diff 2823`, and `gh pr diff 2846`;
// the snippets retain the real runtime paths and record literals from those diffs.

function fetchForEvent(bodyText: string, files: unknown) {
	return vi.fn().mockImplementation(async (url: string | URL | Request) => {
		if (String(url).includes("/files")) {
			if (files instanceof Error) throw files;
			return new Response(JSON.stringify(files), { status: 200 });
		}
		return new Response(JSON.stringify({ body: bodyText }), { status: 200 });
	});
}
const flattenedBody =
	"## Summary Await the first lifecycle run's asynchronous word-index snapshot promotion before reseeding the current-format snapshot for the fallback run. ## Tests - Native master flake justification for the count barrier: 2/10 forced runs reproduced the promotion race. - Fixed lifecycle test: 5/5 tests passed. ### Test assessment - tests/clients/word-index-lifecycle.test.ts uniquely pins the ordering guard. ## Blast radius This change is test-only. ## Class sweep The async-persist lifecycle race is fully covered. ## Observability The test observes existing project snapshot records.";
const multiRoundFlattenedBody =
	"## Summary Preserve the repair context across multiple review rounds. ## Tests - The repair fixture exercises distinct numbered fix rounds. ### Test assessment - tests/scripts/check-pr-body.test.ts uniquely pins numbered fix-round repair. ## Fix round 1 The first review round records the initial correction. ## Fix round 2 The second review round records the follow-up correction. ## Blast radius This change is test-only. ## Class sweep Numbered fix rounds remain distinct during repair. ## Observability The repaired body is validated by the existing body lint.";
const motivatingFlattenedBodies = [
	"## Summary Fix #2052 R1 by making MCP LSP readiness consult the authoritative session-root registry. When the 128-root registry evicts a root, a later request re-registers it instead of returning from the stale lspReadyCwds memo. Add the remainder matrix cells: one mixed inside/outside batch, and an explicit /Users/... case-boundary fixture whose expected result follows the actual filesystem. ## Tests - Red-first mutation proof against the old memo-only guard: firstRootStillServed=false - npm run lint: passed. - npm run build: passed before every test run. - tests/clients/lsp/root-coalescing.test.ts: 12/12 focused tests passed. ### Test assessment - root-coalescing.test.ts uniquely pins the session-root registry and eviction transition. ## Blast radius MCP server readiness and the LSP session-root registry. ## Class sweep The memo-versus-registry readiness pair is fixed here. ## Observability Evicted roots recover; foreign roots retain the existing bounded decline record.",
	"## Summary Fixes #2104 by making the stale-open-issues detector prove exhaustion for the open-issue population. If the safety bound is reached while a full page remains, the detector throws instead of interpreting a partial population. ## Tests - tests/scripts/stale-open-issues.test.ts adds a page-aware regression. - F1 mutation red after dropping the exhaustive flag. - Green targeted run: 20 tests passed. ### Test assessment - stale-open-issues.test.ts uniquely pins exhaustive pagination and truncation disclosure. ## Blast radius The scheduled stale-open-issues detector and its pagination helper. ## Class sweep Bounded API reads classify truncation before interpreting results. ## Observability Successful comments include the scanned population; a bound hit fails the workflow.",
	flattenedBody,
].map((candidate) => candidate.replaceAll("\\n", " "));

function createOriginMasterFixture() {
	const directory = mkdtempSync(join(repositoryRoot, ".tmp-pr-body-origin-"));
	gitExecSync(
		`git init --quiet --initial-branch=main '${directory}' && git -C '${directory}' -c user.name=pi-lens-test -c user.email=pi-lens-test@example.com commit --quiet --allow-empty -m fixture-base && git -C '${directory}' update-ref refs/remotes/origin/master HEAD && printf 'fixture change\n' > '${directory}/fixture.md' && git -C '${directory}' add fixture.md && git -C '${directory}' -c user.name=pi-lens-test -c user.email=pi-lens-test@example.com commit --quiet -m fixture-head`,
	);
	return directory;
}

describe("flattened PR body repair", () => {
	it("detects the clearly flattened real-world shape and repairs it", () => {
		expect(lintPrBody(flattenedBody)).toMatchObject({ valid: false });
		expect(detectFlattenedBody(flattenedBody)).toBe(true);
		const repaired = repairFlattenedBody(flattenedBody);
		expect(lintPrBody(repaired, { requireTestAssessment: true })).toEqual({
			valid: true,
			errors: [],
		});
	});

	it("repairs flattened bodies with distinct numbered fix rounds", () => {
		expect(detectFlattenedBody(multiRoundFlattenedBody)).toBe(true);
		const repaired = repairFlattenedBody(multiRoundFlattenedBody);
		expect(repaired).not.toBe(multiRoundFlattenedBody);
		expect(lintPrBody(repaired, { requireTestAssessment: true })).toEqual({
			valid: true,
			errors: [],
		});
	});

	it.each([
		body,
		"Summary\nShort body.\n\n## Tests\nDone.\n\n## Blast radius\nNone.\n\n## Class sweep\nDone.\n\n## Observability\nRecorded.",
	])("does not detect a normal or short valid body", (candidate) => {
		expect(detectFlattenedBody(candidate)).toBe(false);
		expect(repairFlattenedBody(candidate)).toBe(candidate);
	});

	it("does not classify a long valid body with incidental inline headings", () => {
		const incidental = `${body}\n\nExtra context.\n\n\nThe text mentions ## Tests and ## Blast radius as examples.`;
		expect(lintPrBody(incidental)).toMatchObject({ valid: true });
		expect(detectFlattenedBody(incidental)).toBe(false);
	});

	it("rejects the minimum-length boundary", () => {
		const boundary = "x ## Summary x ## Tests x".padEnd(199, "x");
		expect(boundary).toHaveLength(199);
		expect(
			boundary.match(/(?<!^)\s#{2,4}\s+(?:Summary|Tests)(?=\s|$)/g),
		).toHaveLength(2);
		expect(detectFlattenedBody(boundary)).toBe(false);
	});

	it("requires at least two inline headings", () => {
		const oneHeading = `x ## Summary ${"x".repeat(220)}`;
		expect(oneHeading).not.toMatch(/\r?\n/);
		expect(
			oneHeading.match(/(?<!^)\s#{2,4}\s+(?:Summary|Tests)(?=\s|$)/g),
		).toHaveLength(1);
		expect(detectFlattenedBody(oneHeading)).toBe(false);
	});

	it.each([
		[
			"form feed",
			flattenedBody.replace("word-index", "\fetchOpenPullRequests"),
		],
		["tab", flattenedBody.replace("word-index", "\tpx")],
		["lone carriage return", flattenedBody.replace("word-index", "\retch")],
		["escaped form feed", `${flattenedBody} \\fetchOpenPullRequests`],
		["escaped tab", `${flattenedBody} \\tpx`],
		["escaped carriage return", `${flattenedBody} \\retch`],
		[
			"escaped newline",
			flattenedBody.replace("word-index", "`fetch\\nOpenPullRequests`"),
		],
		[
			"missing heading letter",
			flattenedBody.replace("## Summary", "## ummary"),
		],
		["missing identifier letter", `${flattenedBody} etchOpenPullRequests`],
	])("refuses data-loss marker: %s", (_name, candidate) => {
		expect(detectFlattenedBody(candidate)).toBe(false);
		expect(repairFlattenedBody(candidate)).toBe(candidate);
	});

	it.each(motivatingFlattenedBodies)(
		"repairs a flattened motivating body shape",
		(candidate) => {
			expect(detectFlattenedBody(candidate)).toBe(true);
			expect(
				lintPrBody(repairFlattenedBody(candidate), {
					requireTestAssessment: true,
				}),
			).toMatchObject({ valid: true });
		},
	);

	it.each([
		[
			"plain quoted headings",
			`${flattenedBody} \"## Summary one ## Tests two\"`,
		],
		[
			"fenced quoted headings",
			`${flattenedBody} \`\`\`text ## Summary one ## Tests two \`\`\``,
		],
	])("refuses structurally corrupted headings: %s", (_name, candidate) => {
		expect(detectFlattenedBody(candidate)).toBe(true);
		expect(repairFlattenedBody(candidate)).toBe(candidate);
	});

	it.each(
		[
			[
				"quoted Test assessment mid-sentence",
				"## Summary Opening context. Workers keep writing the ## Test assessment heading inline inside the Tests prose. ## Tests Targeted coverage. ## Blast radius Runtime impact. ## Class sweep Covered. ## Observability Recorded.",
			],
			[
				"quoted Fix round mid-sentence",
				"## Summary Opening context. Workers carried a ## Fix round 1 heading inline in the evidence. ## Tests Targeted coverage. ## Blast radius Runtime impact. ## Class sweep Covered. ## Observability Recorded.",
			],
		].map(([name, candidate]) => [name, candidate.padEnd(220, " ")]),
	)("refuses a mid-sentence quoted heading: %s", (_name, candidate) => {
		expect(detectFlattenedBody(candidate)).toBe(true);
		expect(repairFlattenedBody(candidate)).toBe(candidate);
	});

	it("refuses duplicate template headings through the count check", () => {
		const duplicate =
			"## Summary Opening context. ## Tests First report. ## Tests Second report. ## Blast radius Runtime impact. ## Class sweep Covered. ## Observability Recorded.".padEnd(
				220,
				" ",
			);
		expect(detectFlattenedBody(duplicate)).toBe(true);
		expect(repairFlattenedBody(duplicate)).toBe(duplicate);
	});

	it("refuses an extra repaired heading through the count check", () => {
		const extraHeading =
			"## Summary Opening context. ## Tests Targeted coverage.\n### Existing nested heading\n## Blast radius Runtime impact. ## Class sweep Covered. ## Observability Recorded.".padEnd(
				220,
				" ",
			);
		expect(detectFlattenedBody(extraHeading)).toBe(true);
		expect(repairFlattenedBody(extraHeading)).toBe(extraHeading);
	});

	it("is idempotent", () => {
		const repaired = repairFlattenedBody(flattenedBody);
		expect(repairFlattenedBody(repaired)).toBe(repaired);
	});
});

describe("test-reference shape and placement", () => {
	const clean = (extra: string) => lintPrBody(`${body}\n${extra}`);
	const missing = (result: ReturnType<typeof lintPrBody>, value: string) => {
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain(value);
	};

	it("checks short ids in prose, bullets, and every table column", () => {
		for (const extra of [
			"The witness is `Z99`.",
			"- The witness is `Z99`.",
			"| Notes | Test |\n| --- | --- |\n| `Z99` | real |",
			"| Notes | Test |\n| --- | --- |\n| real | `Z99` |",
		])
			missing(clean(extra), "Z99");
	});

	it("accepts short ids in the same placements when they are real", () => {
		for (const extra of [
			"The witness is `A01`.",
			"- The witness is `A01`.",
			"| Notes | Test |\n| --- | --- |\n| `A01` | real |",
		])
			expect(clean(extra).errors.join(" ")).not.toContain("A01");
	});

	it("checks paths and path-line citations everywhere, including directories", () => {
		for (const extra of [
			"The file is `tests/missing.test.ts`.",
			"- The file is `tests/missing.test.ts:1`.",
			"| Notes | Other |\n| --- | --- |\n| `tests/missing` | text |",
		])
			missing(clean(extra), extra.match(/`([^`]+)`/)?.[1] ?? "tests/");
	});

	it("checks free-text titles in prose, bullets, and test columns", () => {
		for (const extra of [
			"The fabricated test is it('fabricated title').",
			"- The fabricated test is 'fabricated title'.",
			"| Notes | Test |\n| --- | --- |\n| text | `fabricated title` |",
		])
			missing(clean(extra), "fabricated title");
	});

	it("ignores free-text titles under Notes and header cells", () => {
		expect(
			clean("| Notes | Other |\n| --- | --- |\n| `fabricated title` | text |")
				.valid,
		).toBe(true);
		expect(
			clean("| `fabricated title` | Test |\n| --- | --- |\n| text | real |")
				.valid,
		).toBe(true);
	});

	it("ignores commands in code spans in every placement", () => {
		for (const command of [
			"npx tsc --noEmit",
			"npm run preflight",
			"python3 -m pip",
		])
			for (const extra of [
				`The command is \`${command}\`.`,
				`- Run \`${command}\`.`,
				`| Test |\n| --- |\n| \`${command}\` |`,
			])
				expect(clean(extra)).toEqual({ valid: true, errors: [] });
		expect(
			clean("| python3 -m pip | Notes |\n| --- | --- |\n| text | text |").valid,
		).toBe(true);
	});

	it("accepts a real wrapped title and strips a trailing annotation", () => {
		expect(
			clean(
				"| Test |\n| --- |\n| `it('strings: \"keep\" still blanks BLOCK comments')` (NEW) |",
			),
		).toEqual({ valid: true, errors: [] });
	});

	it("rejects all eleven historical fabricated ids through both readers", () => {
		const fixture = readFileSync(
			join(
				repositoryRoot,
				"tests",
				"fixtures",
				"ci-pr-bodies",
				"issue-2877-round-3.md",
			),
			"utf8",
		);
		const fixtureRepo = mkdtempSync(join(repositoryRoot, ".tmp-pr-body-git-"));
		try {
			mkdirSync(join(fixtureRepo, "tests"));
			writeFileSync(join(fixtureRepo, "tests", "fixture.test.ts"), "fixture\n");
			gitExecFileSync(["init", "-q"], { cwd: fixtureRepo });
			gitExecFileSync(["add", "tests/fixture.test.ts"], { cwd: fixtureRepo });
			gitExecFileSync(
				[
					"-c",
					"user.email=pi-lens-test@example.com",
					"-c",
					"user.name=pi-lens-test",
					"commit",
					"-qm",
					"fixture",
				],
				{ cwd: fixtureRepo },
			);
			const direct = lintPrBody(fixture).errors.join(" ");
			const local = lintLocalPrBody(fixture, fixtureRepo).errors.join(" ");
			for (let index = 1; index <= 11; index += 1) {
				const id = `Z${String(index).padStart(2, "0")}`;
				expect(direct).toContain(id);
				expect(local).toContain(id);
			}
		} finally {
			rmSync(fixtureRepo, { recursive: true, force: true });
		}
	});
});

const escapedNewlineFlattenedBody =
	"## Summary\\nRestore real newlines for the escaped-newline flattening class (#2145).\\n\\n## Tests\\nAdds fixtures pinning literal backslash-n repair outside fences.\\n\\n## Blast radius\\nLimited to the body-lint script.\\n\\n## Class sweep\\nEscaped-newline flattening is the sibling of the space-flattening class already handled.\\n\\n## Observability\\nA notice logs the repaired PR number.";

const escapedNewlineWithFence =
	'## Summary\\nRestore real newlines outside fences only (#2145).\\n\\n## Tests\\n```json\\n{"note": "line1\\nline2"}\\n```\\nThe JSON example above documents a genuine escaped newline.\\n\\n## Blast radius\\nLimited to the body-lint script.\\n\\n## Class sweep\\nFence content must never be rewritten during escaped-newline repair.\\n\\n## Observability\\nA notice logs the repaired PR number.';

const escapedNewlineWithTildeFence =
	"## Summary\\nRestore real newlines outside fences only (#2145).\\n\\n## Tests\\n~~~text\\nexample fenced content\\n~~~\\nThe tilde fence above must not be repaired.\\n\\n## Blast radius\\nLimited to the body-lint script.\\n\\n## Class sweep\\nTilde fences are valid CommonMark and GitHub renders them.\\n\\n## Observability\\nA notice logs the repaired PR number.";

// #2145 review F1: a Windows path carries a genuine "\n" substring (inside
// "\node_modules") that is real content, not a flattening artifact. A blind
// global replace would split it into "C:" + a real newline + "ode_modules\pi"
// while the repaired body still validates, so this must refuse outright.
const escapedNewlineWithWindowsPath =
	"## Summary\\nRestore real newlines for the escaped-newline flattening class (#2145).\\n\\n## Tests\\nInstall under C:\\node_modules\\pi and confirm the smoke test passes.\\n\\n## Blast radius\\nLimited to the body-lint script.\\n\\n## Class sweep\\nEscaped-newline flattening is the sibling of the space-flattening class already handled.\\n\\n## Observability\\nA notice logs the repaired PR number.";

// #2145 review F3: pins the realNewlines cap directly. This body is already
// correctly formatted (real headings on their own real lines) and merely
// documents the "\n" escape in prose. Without the cap, the later checks
// (literal count >= 2, headings >= 2) all still pass on this body's existing
// structure, so the cap is the only thing standing between this and a false
// positive on an ordinary valid PR body.
const healthyBodyWithProseEscapes = `${body}\n\nNote: this fixture documents the \\n escape three times: \\n and \\n appear here for illustration.`;

// #2145 review F3: pins the literalNewlines < 2 gate directly. Exactly one
// literal join converts into two heading-only lines ("## Summary" already
// sits on its own real line; "## Tests" appears only after the one literal
// join is converted), so the heading-count check alone cannot reject this —
// only the minimum-occurrence gate can.
const singleLiteralNewlineTwoHeadings = `## Summary\n${"Padding prose to reach the two-hundred character minimum length threshold so the detector's length gate does not short-circuit this fixture before reaching the guard actually under test here now, today.".padEnd(170, ".")}\\n## Tests`;

// #2145 review F3: pins the candidateHeadingLines >= 2 gate directly. Two
// literal joins pass the minimum-occurrence gate, but neither resulting line
// is a template heading, so only the heading-count check can reject this.
const twoLiteralNewlinesNoHeadings =
	"Plain narrative text with no headings at all, just prose that keeps going for a while so the length threshold is comfortably satisfied here.\\nA second paragraph continues the narrative without introducing any heading syntax whatsoever, staying safely non-heading.\\nA third paragraph closes out the fixture with more filler text to be safe about the length floor.";

describe("escaped-newline PR body repair", () => {
	it("detects and repairs the literal backslash-n flattened shape", () => {
		expect(escapedNewlineFlattenedBody).not.toMatch(/\r?\n/);
		expect(detectEscapedNewlineBody(escapedNewlineFlattenedBody)).toBe(true);
		const repaired = repairEscapedNewlineBody(escapedNewlineFlattenedBody);
		expect(repaired).toContain("## Summary\nRestore real newlines");
		expect(lintPrBody(repaired)).toEqual({ valid: true, errors: [] });
	});

	it("does not detect or touch a normal valid body", () => {
		expect(detectEscapedNewlineBody(body)).toBe(false);
		expect(repairEscapedNewlineBody(body)).toBe(body);
	});

	it("refuses a flattened body that carries a backtick fence, leaving it untouched", () => {
		expect(detectEscapedNewlineBody(escapedNewlineWithFence)).toBe(false);
		expect(repairEscapedNewlineBody(escapedNewlineWithFence)).toBe(
			escapedNewlineWithFence,
		);
	});

	it("refuses a flattened body that carries a tilde fence, leaving it untouched", () => {
		expect(detectEscapedNewlineBody(escapedNewlineWithTildeFence)).toBe(false);
		expect(repairEscapedNewlineBody(escapedNewlineWithTildeFence)).toBe(
			escapedNewlineWithTildeFence,
		);
	});

	it("leaves a correct multi-line body with a fenced literal backslash-n untouched", () => {
		const validWithFence = `${body}\n\n\`\`\`json\n{"note": "line1\\nline2"}\n\`\`\``;
		expect(lintPrBody(validWithFence)).toMatchObject({ valid: true });
		expect(detectEscapedNewlineBody(validWithFence)).toBe(false);
		expect(repairEscapedNewlineBody(validWithFence)).toBe(validWithFence);
	});

	it("refuses a body whose only literal backslash-n sits inside a real path (F1)", () => {
		expect(detectEscapedNewlineBody(escapedNewlineWithWindowsPath)).toBe(false);
		expect(repairEscapedNewlineBody(escapedNewlineWithWindowsPath)).toBe(
			escapedNewlineWithWindowsPath,
		);
	});

	it("does not misfire on a healthy body that merely documents the \\n escape (F3 cap)", () => {
		expect(lintPrBody(healthyBodyWithProseEscapes)).toMatchObject({
			valid: true,
		});
		expect(detectEscapedNewlineBody(healthyBodyWithProseEscapes)).toBe(false);
		expect(repairEscapedNewlineBody(healthyBodyWithProseEscapes)).toBe(
			healthyBodyWithProseEscapes,
		);
	});

	it("refuses a single literal join even when it lands between two headings (F3 count gate)", () => {
		expect(singleLiteralNewlineTwoHeadings.length).toBeGreaterThanOrEqual(200);
		expect(detectEscapedNewlineBody(singleLiteralNewlineTwoHeadings)).toBe(
			false,
		);
	});

	it("refuses two literal joins that never produce a template heading (F3 heading gate)", () => {
		expect(twoLiteralNewlinesNoHeadings.length).toBeGreaterThanOrEqual(200);
		expect(detectEscapedNewlineBody(twoLiteralNewlinesNoHeadings)).toBe(false);
	});

	it("is idempotent", () => {
		const repaired = repairEscapedNewlineBody(escapedNewlineFlattenedBody);
		expect(repairEscapedNewlineBody(repaired)).toBe(repaired);
	});
});

describe("flattened body CI entrypoint", () => {
	let previousCwd: string;
	let fixtureCwd: string;
	beforeEach(() => {
		previousCwd = process.cwd();
		fixtureCwd = createOriginMasterFixture();
		process.chdir(fixtureCwd);
	});
	afterEach(() => vi.unstubAllEnvs());
	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(fixtureCwd, { recursive: true, force: true });
	});

	function stubApi() {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	}

	it("checks the repaired body and reports a warning without writing", async () => {
		stubApi();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (String(url).includes("/files"))
				return new Response(
					JSON.stringify([{ filename: "tests/foo.test.ts" }]),
					{ status: 200 },
				);
			return new Response(JSON.stringify({ body: flattenedBody }), {
				status: 200,
			});
		});
		expect(
			await lintPullRequestEvent(fetchImpl, {
				pull_request: { number: 2144, body: flattenedBody },
			}),
		).toEqual({ valid: true, repaired: true });
		expect(fetchImpl).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ method: "PATCH" }),
		);
		expect(log).toHaveBeenCalledWith("PR body OK: 2144");
		log.mockRestore();
	});

	it("checks an escaped-newline flattened body and reports a warning", async () => {
		stubApi();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (String(url).includes("/files"))
				return new Response(JSON.stringify([]), { status: 200 });
			return new Response(
				JSON.stringify({ body: escapedNewlineFlattenedBody }),
				{ status: 200 },
			);
		});
		expect(
			await lintPullRequestEvent(fetchImpl, {
				pull_request: { number: 2145, body: escapedNewlineFlattenedBody },
			}),
		).toEqual({ valid: true, repaired: true });
		expect(fetchImpl).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ method: "PATCH" }),
		);
		expect(log).toHaveBeenCalledWith("PR body OK: 2145");
		log.mockRestore();
	});

	it("reports no repair when the payload is flattened but the live body is clean", async () => {
		stubApi();
		const fetchImpl = vi
			.fn()
			.mockImplementation(async (url: string) =>
				String(url).includes("/files")
					? new Response(JSON.stringify([]), { status: 200 })
					: new Response(JSON.stringify({ body }), { status: 200 }),
			);

		expect(
			await lintPullRequestEvent(fetchImpl, {
				pull_request: { number: 2145, body: flattenedBody },
			}),
		).toEqual({ valid: true, repaired: false });
	});

	it("refuses a flattened fenced template and preserves lint errors", async () => {
		stubApi();
		const fencedBody =
			flattenedBody + " ```text ## Summary one ## Tests two ```";
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockImplementation(async (url: string) =>
				String(url).includes("/files")
					? new Response(JSON.stringify([]), { status: 200 })
					: new Response(JSON.stringify({ body: fencedBody }), { status: 200 }),
			);
		expect(
			await lintPullRequestEvent(fetchImpl, {
				pull_request: { number: 2144, body: fencedBody },
			}),
		).toEqual({ valid: false, repaired: false });
		expect(fetchImpl).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ method: "PATCH" }),
		);
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});

	it("reports original errors and does not write when repair remains invalid", async () => {
		stubApi();
		const invalidFlattenedBody = flattenedBody.replace(
			"## Blast radius This change is test-only.",
			"## Blast radius",
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
			String(url).includes("/files")
				? new Response("[]", { status: 200 })
				: new Response(JSON.stringify({ body: invalidFlattenedBody }), {
						status: 200,
					}),
		);
		const result = await lintPullRequestEvent(fetchImpl, {
			pull_request: { number: 2144, body: invalidFlattenedBody },
		});
		expect(result).toMatchObject({ valid: false, repaired: false });
		expect(errors).toHaveBeenCalledWith(
			expect.stringContaining("PR body is missing a Summary section"),
		);
		expect(fetchImpl).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ method: "PATCH" }),
		);
		errors.mockRestore();
	});
});

describe("PR body lint (#1844)", () => {
	let previousCwd: string;
	let fixtureCwd: string;
	beforeEach(() => {
		previousCwd = process.cwd();
		fixtureCwd = createOriginMasterFixture();
		process.chdir(fixtureCwd);
	});
	afterEach(() => vi.unstubAllEnvs());
	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(fixtureCwd, { recursive: true, force: true });
	});

	it("requires a diff record literal for runtime changes", () => {
		const runtimeDiff = [
			"diff --git a/clients/example.ts b/clients/example.ts",
			"@@ -1,0 +2,3 @@",
			'+recordDegradationOnce({ kind: "runtime-example" });',
		].join("\n");
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"A runtime record is present.",
			),
			process.cwd(),
			() => runtimeDiff,
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("runtime-example");
	});

	it.each(mergedRuntimeRecords)(
		"accepts the added-line record from merged runtime body %s",
		({ name, kind, diff }) => {
			expect(diff).toContain(kind);
			const result = lintPrBody(
				body.replace(
					"The advisory check run is the record.",
					`The bounded record is ${kind}.`,
				),
				{ diff },
			);
			expect(result, name).toEqual({ valid: true, errors: [] });
		},
	);

	it("accepts an existing record named with its source location", () => {
		const source = join(process.cwd(), "clients", "existing-record.ts");
		mkdirSync(join(process.cwd(), "clients"), { recursive: true });
		writeFileSync(
			source,
			'recordDegradationOnce({ kind: "tool-cwd-resolution" });\n',
		);
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"covered by existing record `tool-cwd-resolution` at `clients/existing-record.ts:1`",
			),
			process.cwd(),
			() =>
				"diff --git a/clients/new-path.ts b/clients/new-path.ts\n+catch (error) { resolveToolCwd(error); }",
		);
		expect(result.valid).toBe(true);
	});

	it("rejects an existing-record claim pointing to a test file", () => {
		const source = join(process.cwd(), "tests", "existing-record.test.ts");
		mkdirSync(join(process.cwd(), "tests"), { recursive: true });
		writeFileSync(source, 'recordDegradationOnce({ kind: "test-record" });\n');
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"covered by existing record `test-record` at `tests/existing-record.test.ts:1`",
			),
			process.cwd(),
			() =>
				"diff --git a/clients/new-path.ts b/clients/new-path.ts\n+catch (error) { resolveToolCwd(error); }",
		);
		expect(result).toEqual({
			valid: false,
			errors: [
				'PR body Observability must name a record literal from the runtime diff; "No new failure path; no record added." is not valid when the added lines contain a failure path.',
			],
		});
	});

	it.each([
		[
			"tests file",
			"runner-unavailable",
			"clients/../tests/support/session-state-registry.ts:429",
		],
		["scripts probe", "script-probe", "clients/../scripts/probe-record.mjs:1"],
	])(
		"rejects a traversal existing-record citation to a %s",
		(_name, kind, file) => {
			// The probe lives under a throwaway root, never the live repository
			// (#2865 v5 N1: a probe written into scripts/ reds lint-js on a hard kill).
			const root = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-traversal-"));
			mkdirSync(join(root, "scripts"));
			const probe = join(root, "scripts", "probe-record.mjs");
			writeFileSync(
				probe,
				'recordDegradationOnce({ kind: "script-probe" });\n',
			);
			try {
				const result = lintLocalPrBody(
					body.replace(
						"The advisory check run is the record.",
						`covered by existing record \`${kind}\` at \`${file}\``,
					),
					root,
					() =>
						"diff --git a/clients/new-path.ts b/clients/new-path.ts\n+catch (error) { resolveToolCwd(error); }",
				);
				expect(result).toEqual({
					valid: false,
					errors: [
						'PR body Observability must name a record literal from the runtime diff; "No new failure path; no record added." is not valid when the added lines contain a failure path.',
					],
				});
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("rejects a stale existing-record citation without throwing", () => {
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"covered by existing record `missing-record` at `clients/does-not-exist.ts:1`",
			),
			process.cwd(),
			() =>
				"diff --git a/clients/new-path.ts b/clients/new-path.ts\n+catch (error) { resolveToolCwd(error); }",
		);
		expect(result).toEqual({
			valid: false,
			errors: [
				'PR body Observability must name a record literal from the runtime diff; "No new failure path; no record added." is not valid when the added lines contain a failure path.',
			],
		});
	});

	it("does not accept a record literal from a touched runtime file without an explicit claim", () => {
		const source = join(process.cwd(), "clients", "touched-record.ts");
		mkdirSync(join(process.cwd(), "clients"), { recursive: true });
		writeFileSync(
			source,
			'recordDegradationOnce({ kind: "touched-record" });\n',
		);
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"The touched-record is the record.",
			),
			process.cwd(),
			() =>
				"diff --git a/clients/touched-record.ts b/clients/touched-record.ts\n+catch (error) { resolveToolCwd(error); }",
		);
		expect(result.valid).toBe(false);
	});

	it.each([
		["wrong literal", "missing-record", "1"],
		["line too far", "tool-cwd-resolution", "100"],
	])("rejects an invalid explicit record claim (%s)", (_case, kind, line) => {
		const source = join(process.cwd(), "clients", "located-record.ts");
		mkdirSync(join(process.cwd(), "clients"), { recursive: true });
		writeFileSync(
			source,
			'recordDegradationOnce({ kind: "tool-cwd-resolution" });\n',
		);
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				`covered by existing record \`${kind}\` at \`clients/located-record.ts:${line}\``,
			),
			process.cwd(),
			() =>
				"diff --git a/clients/new-path.ts b/clients/new-path.ts\\n+catch (error) { resolveToolCwd(error); }",
		);
		expect(result.valid).toBe(false);
	});

	it("rejects the right line when it contains the wrong record kind", () => {
		const source = join(process.cwd(), "clients", "wrong-kind-record.ts");
		mkdirSync(join(process.cwd(), "clients"), { recursive: true });
		writeFileSync(
			source,
			'recordDegradationOnce({ kind: "different-record" });\n',
		);
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"covered by existing record `tool-cwd-resolution` at `clients/wrong-kind-record.ts:1`",
			),
			process.cwd(),
			() =>
				"diff --git a/clients/new-path.ts b/clients/new-path.ts\n+catch (error) { resolveToolCwd(error); }",
		);
		expect(result.valid).toBe(false);
	});

	it("rejects a comment at the cited line when the real record is elsewhere", () => {
		const source = join(process.cwd(), "clients", "comment-record.ts");
		mkdirSync(join(process.cwd(), "clients"), { recursive: true });
		writeFileSync(
			source,
			[
				'// recordDegradationOnce({ kind: "comment-record" });',
				...Array.from({ length: 498 }, () => "export const filler = 1;"),
				'recordDegradationOnce({ kind: "comment-record" });',
			].join("\n") + "\n",
		);
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"covered by existing record `comment-record` at `clients/comment-record.ts:1`",
			),
			process.cwd(),
			() =>
				"diff --git a/clients/new-path.ts b/clients/new-path.ts\n+catch (error) { resolveToolCwd(error); }",
		);
		expect(result.valid).toBe(false);
	});

	it("rejects an existing-record claim when the named file has no matching literal", () => {
		const source = join(process.cwd(), "clients", "missing-record.ts");
		mkdirSync(join(process.cwd(), "clients"), { recursive: true });
		writeFileSync(source, "export const value = 1;\n");
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"covered by existing record `tool-cwd-resolution` at `clients/missing-record.ts:42`",
			),
			process.cwd(),
			() =>
				"diff --git a/clients/new-path.ts b/clients/new-path.ts\n+catch (error) { resolveToolCwd(error); }",
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("record literal");
	});

	it("rejects a no-failure claim when the runtime diff adds a catch", () => {
		const runtimeDiff = [
			"diff --git a/clients/example.ts b/clients/example.ts",
			"@@ -1,0 +2,3 @@",
			"+try { run(); } catch (error) { report(error); }",
		].join("\n");
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"No new failure path; no record added.",
			),
			process.cwd(),
			() => runtimeDiff,
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("failure path");
	});

	it("does not apply the runtime rule to a docs-only diff", () => {
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"Documentation explains the change.",
			),
			process.cwd(),
			() => "diff --git a/docs/example.md b/docs/example.md\n+docs",
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it.each([
		["test file", "tools/example.test.ts"],
		["__tests__ file", "tools/__tests__/example.ts"],
		["declaration file", "tools/example.d.ts"],
		["declaration module", "tools/example.d.mts"],
	])("ignores runtime markers in a %s", (_name, file) => {
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"No new failure path; no record added.",
			),
			process.cwd(),
			() =>
				`diff --git a/${file} b/${file}\n+try { run(); } catch (error) { report(error); }`,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it.each([
		["comment", '// recordDegradationOnce({ kind: "comment-record" });'],
		[
			"template literal",
			'const text = `recordDegradationOnce({ kind: "template-record" });`;',
		],
	])("rejects an apparent record call in a %s", (_name, line) => {
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"The apparent discriminator is named: comment-record template-record.",
			),
			process.cwd(),
			() => `diff --git a/clients/example.ts b/clients/example.ts\n+${line}`,
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("record literal");
	});

	it("rejects a missing diff in CI from a real shallow clone", async () => {
		const repository = process.cwd();
		const shallow = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-shallow-"));
		const previousCwd = process.cwd();
		const previousActions = process.env.GITHUB_ACTIONS;
		try {
			vi.stubEnv("GITHUB_TOKEN", "test-token");
			vi.stubEnv("GITHUB_API_URL", "https://api.example");
			vi.stubEnv("GITHUB_REPOSITORY", "o/r");
			gitExecFileSync(
				["clone", "--depth", "1", `file://${repository}`, shallow],
				{
					stdio: "ignore",
				},
			);
			process.chdir(shallow);
			process.env.GITHUB_ACTIONS = "true";
			await expect(
				lintPullRequestEvent(fetchForEvent(body, []), {
					pull_request: { number: 2807, body },
				}),
			).rejects.toThrow(/^diff unavailable:/);
		} finally {
			process.chdir(previousCwd);
			if (previousActions === undefined) delete process.env.GITHUB_ACTIONS;
			else process.env.GITHUB_ACTIONS = previousActions;
			vi.unstubAllEnvs();
			rmSync(shallow, { recursive: true, force: true });
		}
	});

	it("accepts the exact preflight --lint-local command and the title form", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-cli-"));
		const bodyPath = join(directory, "PR_BODY.md");
		const titlePath = join(directory, "COMMIT_MSG.txt");
		const checker = resolve(repositoryRoot, "scripts/check-pr-body.mjs");
		try {
			writeFileSync(
				bodyPath,
				`${body}\n\n### Test assessment\nThe targeted test covers the local CLI.`,
			);
			writeFileSync(
				titlePath,
				"ci(test): verify local body lint (refs #2807)\n",
			);
			for (const args of [
				[checker, "--lint-local", bodyPath],
				[checker, "--body", bodyPath, "--title", titlePath],
			]) {
				execFileSync(process.execPath, args, { cwd: fixtureCwd });
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("accepts the required sections", () => {
		expect(lintPrBody(body)).toEqual({ valid: true, errors: [] });
	});

	it.each(["Tests", "Blast radius", "Class sweep", "Observability"])(
		"rejects a missing %s section",
		(section) => {
			const result = lintPrBody(body.replace(`## ${section}\n`, ""));
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(`## ${section}`);
		},
	);

	it.each(["Tests", "Blast radius", "Class sweep", "Observability"])(
		"rejects an empty %s section",
		(section) => {
			const result = lintPrBody(
				body.replace(new RegExp(`## ${section}\\n[^#]*`), `## ${section}\n`),
			);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(`## ${section}`);
		},
	);

	it("accepts not applicable with a reason", () => {
		expect(
			lintPrBody(
				body.replace(
					"No runtime module touched.",
					"Not applicable: no runtime module changed.",
				),
			),
		).toMatchObject({ valid: true });
	});

	it("does not let Fix round headings satisfy required sections", () => {
		expect(
			lintPrBody("## Fix round 1\nOnly review history here."),
		).toMatchObject({
			valid: false,
		});
	});

	it("rejects the unfilled template", () => {
		const template = readFileSync(
			resolve(repositoryRoot, ".github/PULL_REQUEST_TEMPLATE.md"),
			"utf8",
		);
		expect(lintPrBody(template)).toMatchObject({ valid: false });
	});

	it("accepts case-insensitive fleet synonyms", () => {
		expect(
			lintPrBody(
				"## WHAT CHANGED AND WHY\nReal summary.\n\n## verification\nRan tests.\n\n## BLAST RADIUS\nNone.\n\n## CLASS SWEEP\nDone.\n\n## OBSERVABILITY\nRecorded.",
			),
		).toMatchObject({ valid: true });
	});

	it("ignores fenced headings and fenced template instructions", () => {
		expect(lintPrBody("```md\n## Tests\nInstructions\n```\n")).toMatchObject({
			valid: false,
		});
	});

	it("counts a fenced red-run transcript as Tests content", () => {
		const transcript = body.replace(
			"Targeted tests pass.",
			"```text\nFAIL tests/scripts/check-pr-body.test.ts\n```",
		);
		expect(lintPrBody(transcript)).toMatchObject({ valid: true });
	});

	it("does not count a fenced heading as a required section", () => {
		expect(
			lintPrBody(
				"Summary\nOpening context.\n\n```md\n## Tests\nquoted heading\n```\n\n## Blast radius\nNone.\n\n## Class sweep\nDone.\n\n## Observability\nRecorded.",
			),
		).toMatchObject({ valid: false });
	});

	it.each([
		["unchecked", "- [ ] item", false],
		["checked", "- [x] item", true],
	])("handles %s-only sections", (_name, item, valid) => {
		const result = lintPrBody(body.replace("Targeted tests pass.", item));
		expect(result.valid).toBe(valid);
	});

	it("accepts H3 and H4 section headings", () => {
		const h3 = body.replaceAll("## ", "### ");
		expect(lintPrBody(h3)).toMatchObject({ valid: true });
	});

	it("keeps headings before an unterminated fence visible", () => {
		const unclosed = body + "\n\n```text\nunterminated transcript";
		expect(lintPrBody(unclosed)).toMatchObject({ valid: true });
	});

	it("guards null body input", () => {
		const result = lintPrBody(null as unknown as string);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"PR body is missing a Summary section. See .github/PULL_REQUEST_TEMPLATE.md.",
		);
	});

	it("accepts an opening paragraph instead of a Summary heading", () => {
		expect(
			lintPrBody(
				body.replace("Summary\nOpening context.\n\n", "Opening context.\n\n"),
			),
		).toMatchObject({ valid: true });
	});

	it("rejects a body with no Summary or opening paragraph", () => {
		expect(
			lintPrBody(body.replace("Summary\nOpening context.\n\n", "")),
		).toMatchObject({ valid: false });
	});
});

describe("live PR body resolution (#2085)", () => {
	const payloadPr = { number: 2085, body: "fallback" };
	const flattenedCloseKeywordBody =
		"## Summary\\nThis worker body references Closes #2145 while preserving the complete report.\\n\\n## Tests\\nThe real flattened fixture reaches the body lint as literal newline soup.\\n\\n## Blast radius\\nOnly checking behavior changes.\\n\\n## Class sweep\\nThe shared live-body seam covers sibling readers.\\n\\n## Observability\\nA warning records that checking used normalized text.";

	afterEach(() => vi.unstubAllEnvs());

	it("uses the live body and API URL", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ body: "live" }), { status: 200 }),
			);
		expect(await resolveLivePrBody(payloadPr, fetchImpl)).toEqual({
			body: "live",
			normalized: false,
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.test/repos/apmantza/pi-lens/pulls/2085",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("normalizes flattened live bodies for checking and warns without writing", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ body: flattenedCloseKeywordBody }), {
				status: 200,
			}),
		);

		const normalized = await resolveLivePrBody(
			{ number: 2145, body: flattenedCloseKeywordBody },
			fetchImpl,
		);

		expect(normalized).toMatchObject({ normalized: true });
		expect(normalized.body).toContain("## Tests\n");
		expect(normalized.body).toContain("Closes #2145");
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("Normalized flattened PR body"),
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		warning.mockRestore();
	});

	it("does not mangle a genuine backslash-n inside a code span", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const codeSpanBody = `${escapedNewlineFlattenedBody.replace(
			"literal backslash-n repair outside fences.",
			"literal `line1\\nline2` repair outside fences.",
		)}`;
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ body: codeSpanBody }), { status: 200 }),
			);

		const normalized = await resolveLivePrBody(payloadPr, fetchImpl);
		expect(normalized).toMatchObject({ normalized: true });
		expect(normalized.body).toContain("## Summary\n");
		expect(codeSpanBody).toContain("`line1\\nline2`");
		expect(normalized.body).toContain("`line1\\nline2`");
		warning.mockRestore();
	});

	it("treats a null live body as an empty body", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ body: null }), { status: 200 }),
			);

		try {
			expect(await resolveLivePrBody(payloadPr, fetchImpl)).toEqual({
				body: "",
				normalized: false,
			});
			expect(warning).not.toHaveBeenCalled();
		} finally {
			warning.mockRestore();
		}
	});

	it.each([
		[
			"non-2xx",
			new Response("denied", { status: 403 }),
			"GitHub API returned 403",
		],
		[
			"malformed shape",
			new Response(JSON.stringify({ body: 42 }), { status: 200 }),
			"no body",
		],
	])("falls back and warns for %s", async (_name, response, reason) => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(response);
		expect(await resolveLivePrBody(payloadPr, fetchImpl)).toEqual({
			body: "fallback",
			normalized: false,
		});
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining(reason));
		warning.mockRestore();
	});

	it("falls back without a token and does not fetch", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn();
		expect(await resolveLivePrBody(payloadPr, fetchImpl)).toEqual({
			body: "fallback",
			normalized: false,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("GITHUB_TOKEN is not set"),
		);
		warning.mockRestore();
	});
});

describe("conditional Test assessment section (value discipline)", () => {
	const assessed = `${body}

### Test assessment
foo.test.ts uniquely pins the retry ladder; nothing made redundant.`;

	it("does not require the section by default", () => {
		expect(lintPrBody(body)).toMatchObject({ valid: true });
	});

	it("requires the section when the PR touches tests/", () => {
		const result = lintPrBody(body, { requireTestAssessment: true });
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("Test assessment");
	});

	it("accepts an answered section when required", () => {
		expect(lintPrBody(assessed, { requireTestAssessment: true })).toMatchObject(
			{ valid: true },
		);
	});

	it("rejects an empty section when required", () => {
		const result = lintPrBody(
			`${body}

### Test assessment
`,
			{
				requireTestAssessment: true,
			},
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("Test assessment");
	});

	it("rejects the template placeholder as content", () => {
		const template = readFileSync(".github/PULL_REQUEST_TEMPLATE.md", "utf8");
		const placeholder =
			/### Test assessment\r?\n\r?\n([^#]*)/.exec(template)?.[1] ?? "";
		expect(placeholder.trim().length).toBeGreaterThan(0);
		const result = lintPrBody(
			`${body}

### Test assessment
${placeholder}`,
			{ requireTestAssessment: true },
		);
		expect(result.valid).toBe(false);
	});
});

describe("local lint parity", () => {
	let previousCwd: string;
	let fixtureCwd: string;
	beforeEach(() => {
		previousCwd = process.cwd();
		fixtureCwd = createOriginMasterFixture();
		process.chdir(fixtureCwd);
	});
	afterEach(() => vi.unstubAllEnvs());
	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(fixtureCwd, { recursive: true, force: true });
	});

	it("acquires a non-empty origin/master...HEAD diff in a full checkout", () => {
		const diff = localDiff();
		expect(diff).toContain("diff --git a/");
	});

	it("rejects a runtime-shaped body that names no record", () => {
		const result = lintLocalPrBody(
			body.replace(
				"The advisory check run is the record.",
				"No new failure path; no record added.",
			),
			process.cwd(),
			() =>
				'diff --git a/clients/example.ts b/clients/example.ts\n+throw new Error("boom");',
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("record literal");
	});

	it("requires Test assessment when the local diff touches tests/", () => {
		const result = lintLocalPrBody(
			body,
			process.cwd(),
			() => "tests/scripts/example.test.ts\n",
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("Test assessment");
	});
	it("falls back to HEAD~1 when the upstream range is unavailable", () => {
		const ranges: string[][] = [];
		const result = lintLocalPrBody(body, process.cwd(), (args) => {
			ranges.push(args);
			if (args.includes("origin/master...HEAD"))
				throw new Error("missing upstream");
			return "tests/scripts/example.test.ts\n";
		});
		expect(result.valid).toBe(false);
		expect(ranges).toEqual([
			["diff", "--unified=0", "--no-color", "origin/master...HEAD"],
			["diff", "--name-only", "origin/master...HEAD"],
			["diff", "--name-only", "HEAD~1"],
		]);
	});
});

describe("resolveTouchesTests", () => {
	const payloadPr = { number: 7, body: "fallback" };

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns true when a tests/ file is in the list", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify([
						{ filename: "clients/foo.ts" },
						{ filename: "tests/clients/foo.test.ts" },
					]),
					{ status: 200 },
				),
			);
		expect(await resolveTouchesTests(payloadPr, fetchImpl)).toBe(true);
	});

	it("returns false for a production-only PR", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([{ filename: "clients/foo.ts" }]), {
				status: 200,
			}),
		);
		expect(await resolveTouchesTests(payloadPr, fetchImpl)).toBe(false);
	});

	it("returns null and warns when the list is paginated", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response("[]", {
				status: 200,
				headers: { link: '<next>; rel="next"' },
			}),
		);
		expect(await resolveTouchesTests(payloadPr, fetchImpl)).toBe(null);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		warning.mockRestore();
	});

	it("returns null and warns on a fetch failure", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("boom", { status: 500 }));
		expect(await resolveTouchesTests(payloadPr, fetchImpl)).toBe(null);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		warning.mockRestore();
	});
});

describe("nested headings are structure, not content (#2124 F1)", () => {
	it("still flags an empty Tests section that carries only the nested heading", () => {
		const result = lintPrBody(
			body.replace(
				"## Tests\nTargeted tests pass.",
				"## Tests\n### Test assessment",
			),
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("## Tests");
	});

	it("rejects a required Test assessment satisfied only by a deeper heading", () => {
		const result = lintPrBody(
			`${body}

### Test assessment
#### sub`,
			{
				requireTestAssessment: true,
			},
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("Test assessment");
	});
});

describe("renames out of tests/ still require the assessment (#2124 F3)", () => {
	// #2223: the unstub used to run only after the assertion below, so a
	// failing assertion left GITHUB_TOKEN/GITHUB_API_URL/GITHUB_REPOSITORY
	// stubbed for every later test in this file.
	afterEach(() => vi.unstubAllEnvs());

	it("counts previous_filename", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						filename: "attic/foo.test.ts",
						previous_filename: "tests/clients/foo.test.ts",
					},
				]),
				{ status: 200 },
			),
		);
		expect(await resolveTouchesTests({ number: 7 }, fetchImpl)).toBe(true);
	});
});

describe("the event entrypoint consumes the tri-state (#2124 F2)", () => {
	const assessedBody = `${body}

### Test assessment
foo.test.ts uniquely pins the retry ladder.`;

	let previousCwd: string;
	let fixtureCwd: string;
	beforeEach(() => {
		previousCwd = process.cwd();
		fixtureCwd = createOriginMasterFixture();
		process.chdir(fixtureCwd);
	});

	afterEach(() => vi.unstubAllEnvs());
	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(fixtureCwd, { recursive: true, force: true });
	});

	function stubApi() {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	}

	function fetchFor(bodyText: string, files: unknown) {
		return vi.fn().mockImplementation(async (url: string | URL | Request) => {
			if (String(url).includes("/files")) {
				if (files instanceof Error) throw files;
				return new Response(JSON.stringify(files), { status: 200 });
			}
			return new Response(JSON.stringify({ body: bodyText }), { status: 200 });
		});
	}

	it("requires the section when the live file list touches tests/", async () => {
		stubApi();
		const result = await lintPullRequestEvent(
			fetchFor(body, [{ filename: "tests/clients/foo.test.ts" }]),
			{ pull_request: { number: 7, body } },
		);
		expect(result.valid).toBe(false);
	});

	it("accepts the assessed body when required", async () => {
		stubApi();
		const result = await lintPullRequestEvent(
			fetchFor(assessedBody, [{ filename: "tests/clients/foo.test.ts" }]),
			{ pull_request: { number: 7, body: assessedBody } },
		);
		expect(result).toMatchObject({ valid: true });
	});

	it("skips the section for production-only PRs", async () => {
		stubApi();
		const result = await lintPullRequestEvent(
			fetchFor(body, [{ filename: "clients/foo.ts" }]),
			{ pull_request: { number: 7, body } },
		);
		expect(result).toMatchObject({ valid: true });
	});

	it("skips the section on file-list fetch trouble", async () => {
		stubApi();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await lintPullRequestEvent(
			fetchFor(body, new Error("boom")),
			{ pull_request: { number: 7, body } },
		);
		expect(result).toMatchObject({ valid: true });
		warning.mockRestore();
	});
});
