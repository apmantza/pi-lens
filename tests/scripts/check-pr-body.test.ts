// flake-shape: real-process-spawn — the exact local CLI and shallow checkout are the subject; an in-process call cannot prove either command boundary.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
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
	testCorpus,
	splitMarkdownUnits,
	repairEscapedNewlineBody,
	repairFlattenedBody,
	resolveLivePrBody,
	resolveTouchesTests,
	DETECTION_LAYERS,
	lintDetectionSection,
	resolveBugClosing,
} from "../../scripts/check-pr-body.mjs";
import { blankCommentsAndStrings } from "../../scripts/check-pr-body.mjs";

const body = `## Why\nThe body gate makes review intent explicit.\n\n## Notes for the reviewer\nNone.\n\n## Change outline\n- caller\n  + changed symbol\n    + callee\n\n## Summary\nOpening context.\n\n## Tests\nTargeted tests pass.\n\n## Blast radius\nNo runtime module touched.\n\n## Class sweep\nDefect shape: a body section answered with generic text. Search: \`rg -n "whole-tree grep" scripts\`. Verdict: none outside this fixture.\n\n## Observability\nThe advisory check run is the record.`;
// A synthetic runtime file: `rows` is the whole post-image and `added` lists
// the 1-based post-image lines the diff adds. The harvest reads `rows`, so a
// test that needs the block-comment opener passes real rows — a bare hunk
// cannot say whether a `*`-led line is a comment or a generator head (#3906).
function runtimeFixture(
	file: string,
	rows: string[],
	added: number[] = rows.map((_, index) => index + 1),
) {
	const hunks: string[] = [];
	const sorted = [...added].sort((a, b) => a - b);
	for (let index = 0; index < sorted.length; index += 1) {
		const start = sorted[index];
		let end = start;
		while (sorted[index + 1] === end + 1) end = sorted[++index];
		hunks.push(
			`@@ -${Math.max(0, start - 1)},0 +${start},${end - start + 1} @@`,
		);
		for (let line = start; line <= end; line += 1)
			hunks.push(`+${rows[line - 1] ?? ""}`);
	}
	return {
		diff: [`diff --git a/${file} b/${file}`, ...hunks].join("\n"),
		headFiles: new Map<string, string>([[file, rows.join("\n")]]),
	};
}

// A JSDoc block whose `/**` opener sits directly above the added continuation
// lines, followed by real code lines. The opener is what lets the whole-file
// lexer decide, so a bare-hunk fixture cannot stand in for it.
function docFixture(file: string, doc: string[], code: string[]) {
	const rows = ["/**", ...doc, " */", ...code];
	return runtimeFixture(file, rows, [
		...doc.map((_, index) => index + 2),
		...code.map((_, index) => index + doc.length + 3),
	]);
}

// Rebuild a whole post-image from a hand-built diff whose subject is not the
// lexer's block-comment state: added and context lines land at `+start`, gaps
// are blank. Diffs whose subject IS that state use `runtimeFixture`/`docFixture`
// with real rows instead.
function postImageFromDiff(diff: string) {
	const files: { name: string; rows: string[]; cursor: number }[] = [];
	for (const line of diff.split("\n")) {
		const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (header) {
			files.push({ name: header[2], rows: [], cursor: 1 });
			continue;
		}
		const file = files[files.length - 1];
		if (!file) continue;
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			file.cursor = Number(hunk[1]);
			continue;
		}
		if (line.startsWith("---") || line.startsWith("+++")) continue;
		if (line.startsWith("+") || line.startsWith(" ")) {
			file.rows[file.cursor - 1] = line.slice(1);
			file.cursor += 1;
		}
	}
	const headFiles = new Map<string, string>();
	for (const file of files) {
		headFiles.set(
			file.name,
			Array.from(
				{ length: file.rows.length },
				(_, index) => file.rows[index] ?? "",
			).join("\n"),
		);
	}
	return { diff, headFiles };
}

// Git's blob identity: sha1 over `blob <byteLength>\0` plus the raw bytes.
function gitBlobOid(text: string) {
	const bytes = Buffer.from(text, "utf8");
	return createHash("sha1")
		.update(`blob ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
}

// An archived `--unified=0` fixture records its post-image blob in the `index`
// line. A shallow CI checkout does not carry those historical objects, so the
// bytes are vendored beside the fixture and read back; each is verified against
// the blob oid the diff names. A missing or mismatched vendored image fails
// loudly: there is no reconstruction fallback (#3945).
function fixtureWithBlob(diff: string) {
	const corpusDir = join(repositoryRoot, "tests", "fixtures", "ci-pr-bodies");
	const provenance = JSON.parse(
		readFileSync(join(corpusDir, "pr-3906-hermetic-provenance.json"), "utf8"),
	) as { postImages: Record<string, { path: string; oid: string }> };
	const headFiles = new Map<string, string>();
	let file: string | null = null;
	for (const line of diff.split("\n")) {
		const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (header) {
			file = header[2];
			continue;
		}
		const index = /^index [0-9a-f]+\.\.([0-9a-f]+)/.exec(line);
		if (!index || !file) continue;
		const meta = provenance.postImages[file];
		if (!meta) throw new Error(`no vendored post-image for ${file} (#3945)`);
		const source = readFileSync(join(corpusDir, meta.path), "utf8");
		const oid = gitBlobOid(source);
		if (oid !== meta.oid || !oid.startsWith(index[1]))
			throw new Error(
				`vendored post-image for ${file} does not match ${index[1]} (#3945)`,
			);
		headFiles.set(file, source);
	}
	return { diff, headFiles };
}
const repositoryRoot = process.cwd();
// The stub `clients/new-path.ts` diff several existing-record tests use: a
// single added `catch`, so its whole post-image is that one line. `headFiles`
// lets the harvest verify the diff text against the post-image it reads.
const NEW_PATH_RUNTIME_DIFF =
	"diff --git a/clients/new-path.ts b/clients/new-path.ts\n+catch (error) { resolveToolCwd(error); }";
const NEW_PATH_HEAD_FILES = postImageFromDiff(NEW_PATH_RUNTIME_DIFF).headFiles;
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
	"## Summary Await the first lifecycle run's asynchronous word-index snapshot promotion before reseeding the current-format snapshot for the fallback run. ## Tests - Native master flake justification for the count barrier: 2/10 forced runs reproduced the promotion race. - Fixed lifecycle test: 5/5 tests passed. ### Test assessment - tests/clients/word-index-lifecycle.test.ts uniquely pins the ordering guard. ## Blast radius This change is test-only. ## Class sweep Defect shape: async-persist lifecycle race. Search `rg -n async-persist clients`. Verdict: none outside this fixture. ## Observability The test observes existing project snapshot records.";
const multiRoundFlattenedBody =
	"## Summary Preserve the repair context across multiple review rounds. ## Tests - The repair fixture exercises distinct numbered fix rounds. ### Test assessment - tests/scripts/check-pr-body.test.ts uniquely pins numbered fix-round repair. ## Fix round 1 The first review round records the initial correction. ## Fix round 2 The second review round records the follow-up correction. ## Blast radius This change is test-only. ## Class sweep Numbered fix rounds remain distinct during repair. ## Observability The repaired body is validated by the existing body lint.";
const motivatingFlattenedBodies = [
	"## Summary Fix #2052 R1 by making MCP LSP readiness consult the authoritative session-root registry. When the 128-root registry evicts a root, a later request re-registers it instead of returning from the stale lspReadyCwds memo. Add the remainder matrix cells: one mixed inside/outside batch, and an explicit /Users/... case-boundary fixture whose expected result follows the actual filesystem. ## Tests - Red-first mutation proof against the old memo-only guard: firstRootStillServed=false - npm run lint: passed. - npm run build: passed before every test run. - tests/clients/lsp/root-coalescing.test.ts: 12/12 focused tests passed. ### Test assessment - root-coalescing.test.ts uniquely pins the session-root registry and eviction transition. ## Blast radius MCP server readiness and the LSP session-root registry. ## Class sweep The memo-versus-registry readiness pair is fixed here. ## Observability Evicted roots recover; foreign roots retain the existing bounded decline record.",
	"## Summary Fixes #2104 by making the stale-open-issues detector prove exhaustion for the open-issue population. If the safety bound is reached while a full page remains, the detector throws instead of interpreting a partial population. ## Tests - tests/scripts/stale-open-issues.test.ts adds a page-aware regression. - F1 mutation red after dropping the exhaustive flag. - Green targeted run: 20 tests passed. ### Test assessment - stale-open-issues.test.ts uniquely pins exhaustive pagination and truncation disclosure. ## Blast radius The scheduled stale-open-issues detector and its pagination helper. ## Class sweep Bounded API reads classify truncation before interpreting results. ## Observability Successful comments include the scanned population; a bound hit fails the workflow.",
	flattenedBody,
].map((candidate) => candidate.replaceAll("\\n", " "));

type RuntimePostImageFixture = {
	path: string;
	pre: string[];
	post: string[];
	dirty: string[];
	// Unchanged padding appended to the pre- and post-images (#3906 r5): the
	// committed diff stays one added line while the post-image blob crosses the
	// reader's byte ceiling. Over the shell argv limit it is written with
	// `writeFileSync` and `cp`ed into place instead of a `printf` argument.
	padLines?: number;
};

function shellRows(rows: string[]): string {
	// The fixture rows are single-quote free, so each is a POSIX single-quoted
	// word; joining them with spaces makes one `printf '%s\n' a b c` call.
	return rows.map((row) => `'${row}'`).join(" ");
}

// One shared `git init` call site keeps the file's pinned real-spawn count
// while several fixture tests each need a fresh repository.
function initFixtureRepo(fixtureRepo: string) {
	gitExecFileSync(["init", "-q"], { cwd: fixtureRepo });
}

function createOriginMasterFixture(
	mappedFile?: string,
	postImage?: RuntimePostImageFixture,
) {
	const directory = mkdtempSync(join(repositoryRoot, ".tmp-pr-body-origin-"));
	// `mappedFile` (#3802 F3) commits one extra repo-relative file in the same
	// shell command, so a mapped-path diff costs no additional git spawn.
	const mapped = mappedFile
		? ` && mkdir -p '${directory}/${dirname(mappedFile)}' && printf 'touched\\n' > '${directory}/${mappedFile}' && git -C '${directory}' add '${mappedFile}' && git -C '${directory}' -c user.name=pi-lens-test -c user.email=pi-lens-test@example.com commit --quiet -m fixture-mapped`
		: "";
	// A real runtime post-image (#3906 r4 R3-A): the pre-image is committed as
	// the base, `origin/master` points at it, the post-image is committed as the
	// head so the diff names `index <pre>..<post>`, and the working tree is then
	// dirtied in an unchanged line. The reader must take the named blob; reading
	// the dirty tree would flip the lexical state without changing any added line.
	//
	// A `padLines` post-image (#3906 r5 byte-ceiling witnesses) is over the
	// argv limit, so its bytes come from a fixture-local file and a `cp`; a small
	// image keeps the single-argument `printf` writer.
	const writePostImageContent = (rows: string[], tempName: string) => {
		const destination = `${directory}/${postImage?.path}`;
		if (!postImage?.padLines)
			return `printf '%s\\n' ${shellRows(rows)} > '${destination}'`;
		writeFileSync(
			join(directory, tempName),
			`${rows.join("\n")}\n${"// pad\n".repeat(postImage.padLines)}`,
		);
		return `cp '${directory}/${tempName}' '${destination}'`;
	};
	const preImage = postImage
		? `mkdir -p '${directory}/${dirname(postImage.path)}' && ${writePostImageContent(postImage.pre, ".fixture-pre")} && git -C '${directory}' add '${postImage.path}' && `
		: "";
	const postImageSegment = postImage
		? ` && ${writePostImageContent(postImage.post, ".fixture-post")} && git -C '${directory}' add '${postImage.path}' && git -C '${directory}' -c user.name=pi-lens-test -c user.email=pi-lens-test@example.com commit --quiet -m fixture-post-image && ${writePostImageContent(postImage.dirty, ".fixture-dirty")}`
		: "";
	// Spawn from the repository root: every command in the chain addresses the
	// fixture by absolute path, so the caller's cwd must not decide which
	// repository the commit chain moves. A caller already inside another fixture
	// repo made that fixture's branch the HEAD-moving target of this chain.
	gitExecSync(
		`git init --quiet --initial-branch=main '${directory}' && ${preImage}git -C '${directory}' -c user.name=pi-lens-test -c user.email=pi-lens-test@example.com commit --quiet --allow-empty -m fixture-base && git -C '${directory}' update-ref refs/remotes/origin/master HEAD && printf 'fixture change\n' > '${directory}/fixture.md' && git -C '${directory}' add fixture.md && git -C '${directory}' -c user.name=pi-lens-test -c user.email=pi-lens-test@example.com commit --quiet -m fixture-head${mapped}${postImageSegment}`,
		{ cwd: repositoryRoot },
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
		["plain quoted headings", `${flattenedBody} "## Summary one ## Tests two"`],
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

describe("Markdown claim units", () => {
	it("keeps Markdown blocks atomic and splits ordinary paragraph sentences", () => {
		const units = splitMarkdownUnits(
			"# Heading\n\n| A | B |\n| --- | --- |\n| one | two |\n\n- list item. Still one unit.\n\nA paragraph has 4.1.6 and clients/a.ts:12. It ends here.\nNext question? Yes!\n\n```ts\nvalue();\n```",
		);
		expect(units.map(({ kind, text }) => [kind, text])).toEqual([
			["heading", "# Heading"],
			["table", "| A | B |"],
			["table", "| --- | --- |"],
			["table", "| one | two |"],
			["list", "- list item. Still one unit."],
			["sentence", "A paragraph has 4.1.6 and clients/a.ts:12."],
			["sentence", "It ends here."],
			["sentence", "Next question?"],
			["sentence", "Yes!"],
			["fence", "```ts\nvalue();\n```"],
		]);
	});

	it("keeps code spans, abbreviations, and ellipses inside one sentence", () => {
		expect(
			splitMarkdownUnits(
				"Use `client. value` here. E.g. keep this sentence together... Then finish.",
			),
		).toEqual([
			{ kind: "sentence", text: "Use `client. value` here." },
			{
				kind: "sentence",
				text: "E.g. keep this sentence together... Then finish.",
			},
		]);
	});

	it("starts a sentence after a code span or numeric token", () => {
		expect(
			splitMarkdownUnits(
				"The first sentence ends here. `tests/x.test.ts` already parses that source.\nA second sentence ends here. 4.4.2 is the pinned version.",
			),
		).toEqual([
			{ kind: "sentence", text: "The first sentence ends here." },
			{
				kind: "sentence",
				text: "`tests/x.test.ts` already parses that source.",
			},
			{ kind: "sentence", text: "A second sentence ends here." },
			{ kind: "sentence", text: "4.4.2 is the pinned version." },
		]);
	});

	it("requires a directly following origin/master fence for a master claim", () => {
		const accepted = lintPrBody(
			`${body}\n\nThis is pre-existing.\n\n\`\`\`text\nrun on origin/master: pass\n\`\`\``,
		);
		expect(accepted.errors).not.toContain(
			expect.stringContaining("master/environment"),
		);
		const rejected = lintPrBody(
			`${body}\n\nThis is pre-existing.\n\nEvidence follows.`,
		);
		expect(rejected.errors.join(" ")).toContain("origin/master transcript");
	});

	it("does not inspect master words inside a fenced block", () => {
		expect(
			lintPrBody(
				`${body}\n\n\`\`\`text\npre-existing and red on master\n\`\`\``,
			).valid,
		).toBe(true);
	});
});

describe("head-tree citations", () => {
	const headFiles = new Map([
		[
			"clients/citation.ts",
			Array.from({ length: 40 }, (_, index) =>
				index === 20
					? "const cited = true;"
					: index === 39
						? "const distant = true;"
						: `const line${index + 1} = ${index};`,
			).join("\n"),
		],
	]);

	it("rejects a citation to a missing or out-of-range head file", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/missing.ts:1\`\nAlso: \`clients/citation.ts:41\``,
			{ headFiles },
		);
		expect(result.errors.join(" ")).toContain("clients/missing.ts:1");
		expect(result.errors.join(" ")).toContain("clients/citation.ts:41");
	});

	it("accepts cited source within three and twenty lines", () => {
		for (const line of [1, 4, 21])
			expect(
				lintPrBody(
					`${body}\nEvidence: \`clients/citation.ts:${line}\`\n\`\`\`ts\nconst cited = true;\n\`\`\``,
					{ headFiles },
				).valid,
			).toBe(true);
	});

	it("rejects a fabricated quote outside the twenty-line evidence window", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/citation.ts:1\`\n\`\`\`ts\nconst distant = true;\n\`\`\``,
			{ headFiles },
		);
		expect(result.errors.join(" ")).toContain("within ±20 lines");
	});
});

describe("test-reference shape and placement", () => {
	it("A01", () => {});
	const clean = (extra: string) => lintPrBody(`${body}\n${extra}`);
	const missing = (result: ReturnType<typeof lintPrBody>, value: string) => {
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain(value);
	};

	it("checks short ids only in the test column", () => {
		missing(clean("| Notes | Test |\n| --- | --- |\n| real | `Z99` |"), "Z99");
		expect(clean("The witness is `Z99`.").valid).toBe(true);
		expect(clean("- The witness is `Z99`.").valid).toBe(true);
		expect(
			clean("| Notes | Test |\n| --- | --- |\n| `Z99` | real |").valid,
		).toBe(true);
	});

	it("accepts short ids in a test column when they resolve to test titles", () => {
		const fixtureCwd = mkdtempSync(
			join(repositoryRoot, ".tmp-pr-body-short-id-"),
		);
		try {
			mkdirSync(join(fixtureCwd, "tests"), { recursive: true });
			const source = [
				'it("F1", () => {});',
				'it("V3", () => {});',
				'it("F12", () => {});',
			].join("\n");
			writeFileSync(join(fixtureCwd, "tests", "short-ids.test.ts"), source);
			const git = (args: string[]) => {
				if (args[0] === "rev-parse") return "fixture-head\n";
				if (args[0] === "ls-files") return "tests/short-ids.test.ts\n";
				if (args[0] === "show") return source;
				throw new Error(`unexpected git command: ${args.join(" ")}`);
			};
			const result = lintPrBody(
				`${body}\n| Case | Test |\n| --- | --- |\n| A | \`F1\` |\n| B | \`V3\` |\n| C | \`F12\` |`,
				{ cwd: fixtureCwd, git },
			);
			expect(result).toEqual({ valid: true, errors: [] });
		} finally {
			rmSync(fixtureCwd, { recursive: true, force: true });
		}
	});

	it("checks paths and path-line citations everywhere, including directories", () => {
		for (const extra of [
			"The file is `tests/missing.test.ts`.",
			"- The file is `tests/missing.test.ts:1`.",
			"| Notes | Other |\n| --- | --- |\n| `tests/missing` | text |",
		])
			missing(clean(extra), extra.match(/`([^`]+)`/)?.[1] ?? "tests/");
	});

	it("checks it-form titles in prose, bullets, and test columns", () => {
		for (const extra of [
			"The fabricated test is it('fabricated title').",
			"- The fabricated test is it('fabricated title').",
			"| Notes | Test |\n| --- | --- |\n| text | `fabricated title` |",
		])
			missing(clean(extra), "fabricated title");
	});

	// #3013 (positive recognition): a bare-quoted phrase in prose is quoted
	// output or quoted source, never a test citation. Only the it() call
	// form recognises a title outside a test column.
	it("does not treat bare-quoted prose as a test reference", () => {
		expect(
			clean(`- The output was "a timer that outlives its one-shot settle".`),
		).toEqual({ valid: true, errors: [] });
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
				`| Notes |\n| --- |\n| \`${command}\` |`,
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

	it("keeps historical short ids scoped to named test columns", () => {
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
			initFixtureRepo(fixtureRepo);
			gitExecFileSync(["add", "tests/fixture.test.ts"], { cwd: fixtureRepo });
			// `-C` keeps the path resolution in the fixture; the spawn cwd stays at
			// the repository root so the commit's HEAD-moving target is not the
			// fixture repo's own branch.
			gitExecFileSync(
				[
					"-C",
					fixtureRepo,
					"-c",
					"user.email=pi-lens-test@example.com",
					"-c",
					"user.name=pi-lens-test",
					"commit",
					"-qm",
					"fixture",
				],
				{ cwd: repositoryRoot },
			);
			const direct = lintPrBody(fixture).errors.join(" ");
			const local = lintLocalPrBody(fixture, fixtureRepo).errors.join(" ");
			for (const id of ["Z10", "P01", "P30"]) {
				expect(direct).toContain(id);
				expect(local).toContain(id);
			}
			for (const id of [
				"Z01",
				"Z02",
				"Z03",
				"Z04",
				"Z05",
				"Z06",
				"Z07",
				"Z08",
				"Z09",
			]) {
				expect(direct).not.toContain(id);
				expect(local).not.toContain(id);
			}
		} finally {
			rmSync(fixtureRepo, { recursive: true, force: true });
		}
	});

	it("rejects a local citation of a git-ignored path CI can never resolve (#2904)", () => {
		const fixtureRepo = mkdtempSync(join(repositoryRoot, ".tmp-pr-body-git-"));
		try {
			mkdirSync(join(fixtureRepo, "src"));
			mkdirSync(join(fixtureRepo, "vendor"));
			writeFileSync(join(fixtureRepo, ".gitignore"), "vendor/\n");
			writeFileSync(join(fixtureRepo, "src", "tracked.js"), "tracked\n");
			writeFileSync(join(fixtureRepo, "vendor", "lib.js"), "ignored\n");
			// `git check-ignore` reads .gitignore from the work tree; no commit is
			// needed, so the fixture costs one spawn.
			initFixtureRepo(fixtureRepo);
			const citing = (file: string) =>
				lintLocalPrBody(
					`${body}\nThe helper is at \`${file}:1\`.`,
					fixtureRepo,
					() => "",
				).errors.filter((error) => error.includes("citation"));
			expect(citing("vendor/lib.js")).toEqual([
				"PR body citation vendor/lib.js:1 names a git-ignored path; CI resolves citations with `git show HEAD:<file>`, so it can never pass there.",
			]);
			expect(citing("src/tracked.js")).toEqual([]);
		} finally {
			rmSync(fixtureRepo, { recursive: true, force: true });
		}
	});
});

describe("test-reference positive recognition (#3013)", () => {
	const clean = (extra: string) => lintPrBody(`${body}\n${extra}`);
	const testErrors = (result: ReturnType<typeof lintPrBody>) =>
		result.errors.filter((error) => error.includes("test reference"));

	// Class 1 is catalog shape 34 (a guard that enumerates surface
	// spellings): the discriminator reads the token's shape — a leading
	// argv-like word plus invocation evidence — instead of extending the
	// deleted four-prefix allowlist. Every accept case embeds a fabricated
	// tests/ path, so only the command guard saves it; the first is the
	// issue's own rg spelling, the rest are spellings it never names.
	it.each([
		"rg -l 'lens-map|generateLensMap' tests/",
		"vitest run tests/3013-missing-command-arg.test.ts --reporter=verbose",
		"pytest tests/3013-missing-pytest-arg.test.ts -q",
		"git diff HEAD -- tests/3013-missing-diff-arg.test.ts",
	])("does not read a shell invocation as a test reference: %s", (command) => {
		expect(clean(`Ran \`${command}\` with exit code 0.`)).toEqual({
			valid: true,
			errors: [],
		});
	});

	// Shape 13 reject twins: the same invocation still reds when placement
	// recognises it (a test column), and the bare path it embeds still reds
	// in prose. Together they prove the accept above is the command guard's
	// doing, not a dead exemption.
	it("still checks a command-shaped span in a test column", () => {
		expect(
			clean(
				"| Test |\n| --- |\n| `vitest run tests/3013-missing-command-arg.test.ts --reporter=verbose` |",
			),
		).toEqual({
			valid: false,
			errors: [
				"PR body test reference is missing under tests/: vitest run tests/3013-missing-command-arg.test.ts --reporter=verbose",
			],
		});
	});

	it("still checks the bare path a command would embed", () => {
		expect(
			clean("Ran `tests/3013-missing-command-arg.test.ts` with exit code 0."),
		).toEqual({
			valid: false,
			errors: [
				"PR body test reference is missing under tests/: tests/3013-missing-command-arg.test.ts",
			],
		});
	});

	// Class 3: a trailing slash names a suite directory, never a file. The
	// slash-less tests/config is accepted through the on-disk directory, not
	// the file corpus.
	it.each(["tests/config/", "tests/config"])(
		"does not require a directory path to exist as a file: %s",
		(path) => {
			expect(clean(`Ran the suite in \`${path}\` with exit code 0.`)).toEqual({
				valid: true,
				errors: [],
			});
		},
	);

	// A trailing slash is never a file reference, even when the directory
	// does not exist (yet). This is the half of the directory rule the
	// on-disk check cannot cover, so it gets its own test and mutation.
	it("does not require a not-yet-existing suite directory", () => {
		expect(
			clean("Ran the suite in `tests/3013-no-such-suite/` with exit code 0."),
		).toEqual({ valid: true, errors: [] });
	});

	// Class 2 (positive recognition): prose outside a test column only names
	// a test through it("…"), a concrete tests/ path, or a short id. Quoted
	// tool output, quoted source lines, and plain commands are none of
	// those, so they are never asserted to exist.
	it.each([
		"git rev-parse HEAD",
		"git fetch origin master",
		"npm run fmt:check",
		"npm run lint",
		"node scripts/ci-verdict.mjs 2971",
		"comm -23 a b",
		"taskkill /F /T",
		"npx oxfmt",
		"sed -i",
		"gh pr edit",
		"tsc --noEmit",
		"grep -rn",
		"reduces but does not eliminate residual recreation",
		"[tmp-hygiene] leaked 1 top-level entries: pi-lens-map-5jd2...",
		"leaked 1 top-level entries: pi-lens-map-YHCjRq",
		"keep the real TMPDIR so the final governance ...",
		"Test Files 9 passed (9)",
		"16 passed (16) / 163 passed",
		"process.env.PI_LENS_HOME = testRegistryHome",
		"cleanupTestEnvironmentsDrained(prefix, { beforeDrain })",
		'forcedUnknownReason: "walk-failed"',
		"expected [ '/foreign-worker-root' ] to deeply equal []",
		"return undefined",
		"void tick()",
		"setInterval(() => { void tick(); }, 750)",
		"if (!dispatchOutcome) return",
		"wasWrittenThisSession === false",
		'pending.strategy === "git"',
		'kind: "resource-sampler-tick-overlapped"',
		"a timer that outlives its one-shot settle",
		"a resource bounded on one axis while it grows on another",
		"Refs #2968",
		"(closes #NNN)",
		"+ incrementDegradationCount",
		"timeout + 5s",
		"All matched files use the correct format.",
		"Issue triage (standing rule)",
		'ktlint = "14.2.0"',
		"read the declared version",
		"does not gate",
		'recordDegradationOnce({ kind: "sgconfig-baseline-cap-evict" })',
		"sampleProcesses([host, ...lspChildren])",
		'fields: ["pid","ppid"]',
		"onTimeout: terminateScannerChild",
		'logLatency({phase: "spawn_resource_usage"})',
		"pid, ppid, rssBytes, cpuKernel100ns, cpuUser100ns, startedAt",
		"changelog fragments OK (15 entries in .changelog/)",
		"GH_REPO=${{ github.repository }}",
	])("does not read prose as a test reference: %s", (phrase) => {
		expect(clean(`Noted \`${phrase}\` while reviewing.`)).toEqual({
			valid: true,
			errors: [],
		});
	});

	// A glob or brace expansion names a set, never a file.
	it.each([
		"tests/config/*.test.ts",
		"tests/clients/safe-spawn-{cap-race,close-before-error-race}.test.ts",
	])("does not require a glob to exist as a file: %s", (pattern) => {
		expect(clean(`Ran \`${pattern}\` with exit code 0.`)).toEqual({
			valid: true,
			errors: [],
		});
	});

	// Per-token precision: one span can name two files, and only the missing
	// one is reported. toEqual (not toContain) is the red-first proof:
	// pre-fix code reports the whole span as one reference.
	it("reports only the missing token of a multi-path span", () => {
		expect(
			clean(
				"Ran `tests/scripts/check-pr-body.test.ts tests/3013-missing-multi.test.ts`.",
			),
		).toEqual({
			valid: false,
			errors: [
				"PR body test reference is missing under tests/: tests/3013-missing-multi.test.ts",
			],
		});
	});

	it("checks a tests/ path past the first word of a span", () => {
		expect(
			clean("See `see tests/3013-missing-prose.test.ts for details`."),
		).toEqual({
			valid: false,
			errors: [
				"PR body test reference is missing under tests/: tests/3013-missing-prose.test.ts",
			],
		});
	});

	it("accepts a multi-path span when every token exists", () => {
		expect(
			clean(
				"Ran `tests/index-2992-integration.test.ts tests/index-multi-root-session-start.test.ts`.",
			),
		).toEqual({ valid: true, errors: [] });
	});

	// Shape 47: the detector's corpus must exclude its own fixtures by
	// construction (a path filter in the corpus builder). The tracked
	// listing below proves the exclusion even before these fixtures merge:
	// the fake fixture is reported missing although the injected corpus
	// claims it is tracked.
	it("excludes PR-body fixtures from the corpus even when tracked", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-corpus-"));
		try {
			mkdirSync(join(root, "tests", "fixtures", "ci-pr-bodies"), {
				recursive: true,
			});
			writeFileSync(
				join(root, "tests", "real.test.ts"),
				'it("real corpus title", () => {});\n',
			);
			writeFileSync(
				join(root, "tests", "fixtures", "ci-pr-bodies", "pr-0000.md"),
				"fixture\n",
			);
			const git = (args: string[]) =>
				args[0] === "ls-files"
					? "tests/real.test.ts\ntests/fixtures/ci-pr-bodies/pr-0000.md\n"
					: "";
			expect(
				lintPrBody(`${body}\nSee \`tests/real.test.ts\`.`, {
					cwd: root,
					git,
				}),
			).toEqual({ valid: true, errors: [] });
			expect(
				lintPrBody(`${body}\nSee \`tests/fixtures/ci-pr-bodies/pr-0000.md\`.`, {
					cwd: root,
					git,
				}),
			).toEqual({
				valid: false,
				errors: [
					"PR body test reference is missing under tests/: tests/fixtures/ci-pr-bodies/pr-0000.md",
				],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// #3902: the corpus is a whole-tree `git ls-files` plus a read-and-lex of
	// every test file. A body with no test reference never needs it, so the
	// corpus is computed on first use. The getter counts reads; the TLA+
	// coverage integration cases red on the 5 s default when a plain prose
	// body pays for the scan under CI load.
	it("does not read the test corpus for a body with no test reference", () => {
		let reads = 0;
		const result = lintPrBody(body, {
			cwd: repositoryRoot,
			get testCorpus() {
				reads += 1;
				return { paths: new Set<string>(), titles: new Set<string>() };
			},
		});
		expect(result).toEqual({ valid: true, errors: [] });
		expect(reads).toBe(0);
	});

	it("reads the test corpus when the body names a test reference", () => {
		let reads = 0;
		const result = lintPrBody(`${body}\nSee \`tests/missing-3902.test.ts\`.`, {
			cwd: repositoryRoot,
			get testCorpus() {
				reads += 1;
				return { paths: new Set<string>(), titles: new Set<string>() };
			},
		});
		expect(result.errors).toEqual([
			"PR body test reference is missing under tests/: tests/missing-3902.test.ts",
		]);
		expect(reads).toBe(1);
	});

	// End-to-end proof: three real merged bodies that fail pre-fix pass
	// post-fix. Only test-reference errors are asserted — the citation and
	// master-claim surfaces belong to #2904 and are unaffected.
	it.each(["pr-3008.md", "pr-2979.md", "pr-3006.md"])(
		"passes the fixed checker on real merged body %s",
		(file) => {
			const fixture = readFileSync(
				join(repositoryRoot, "tests", "fixtures", "ci-pr-bodies", file),
				"utf8",
			);
			expect(testErrors(lintPrBody(fixture))).toEqual([]);
		},
	);
});

const escapedNewlineFlattenedBody =
	"## Summary\\nRestore real newlines for the escaped-newline flattening class (#2145).\\n\\n## Tests\\nAdds fixtures pinning literal backslash-n repair outside fences.\\n\\n## Blast radius\\nLimited to the body-lint script.\\n\\n## Class sweep\\nDefect shape: escaped-newline flattening. Search `rg -n backslash-n scripts`. Verdict: sibling of the space-flattening class.\\n\\n## Observability\\nA notice logs the repaired PR number.";

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

	// #3780 (#3688 survivors, check-pr-body.mjs `lintLocalPrBody`): a comma-list
	// close keyword is rejected WITH the line that holds it. `lintCloseKeywords`
	// pins the line in isolation; the local preflight (`--lint-local`) is what a
	// fixer reads before pushing, and dropping the line from its errors kept the
	// suite green.
	it("names the offending close-keyword line in the local lint result", () => {
		const result = lintLocalPrBody(
			`${body}\nCloses #12, #13\n`,
			process.cwd(),
			() => "",
		);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("  offending line: Closes #12, #13");
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
			{ headFiles: postImageFromDiff(runtimeDiff).headFiles },
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
				postImageFromDiff(diff),
			);
			expect(result, name).toEqual({ valid: true, errors: [] });
		},
	);

	describe("record harvest reaches every runtime record shape (#2915)", () => {
		const withObservability = (text: string) =>
			body.replace("The advisory check run is the record.", text);
		// The runtime hunks of #2895's head: two type-list entries under
		// clients/ and the index.ts emitBounded call (trimmed to that hunk).
		const pr2895Diff = readFileSync(
			join(
				repositoryRoot,
				"tests",
				"fixtures",
				"ci-pr-bodies",
				"pr-2895-runtime.diff",
			),
			"utf8",
		);

		it.each(["session_start_duplicate_suppressed", "session-start-duplicate"])(
			"accepts #2895's honest body naming %s from a positional index.ts emitBounded",
			(record) => {
				expect(
					lintPrBody(withObservability(`The bounded record is ${record}.`), {
						...postImageFromDiff(pr2895Diff),
					}),
				).toEqual({ valid: true, errors: [] });
			},
		);

		it("still refuses a record #2895's diff does not add", () => {
			expect(
				lintPrBody(
					withObservability("The bounded record is not-in-diff."),
					postImageFromDiff(pr2895Diff),
				).valid,
			).toBe(false);
		});

		it("requires a record for a failure path added to index.ts", () => {
			const fixture = runtimeFixture("index.ts", [
				"try { start(); } catch { return null; }",
			]);
			const result = lintPrBody(
				withObservability("No new failure path; no record added."),
				fixture,
			);
			expect(result.errors.join(" ")).toContain(
				"not valid when the added lines contain a failure path",
			);
		});

		it("harvests a new call whose closing brace is an unchanged context line", () => {
			// The whole post-image holds the closing brace; only the opening lines
			// are added, so the span test still finds the call (#2915).
			const fixture = runtimeFixture(
				"clients/example.ts",
				["\tlogLatency({", '\t\tphase: "example_context_close",', "\t});", "}"],
				[1, 2],
			);
			expect(
				lintPrBody(
					withObservability("The record is example_context_close."),
					fixture,
				),
			).toEqual({ valid: true, errors: [] });
		});

		it("does not count an untouched record in the post-image as added", () => {
			const fixture = runtimeFixture(
				"clients/example.ts",
				['\trecordDegradationOnce({ kind: "old-kind" });', "\tnext();", "}"],
				[2],
			);
			expect(
				lintPrBody(withObservability("The record is old-kind."), fixture).valid,
			).toBe(false);
		});

		it("harvests a read-time fold row's kind (#3721)", () => {
			const fixture = runtimeFixture("clients/degradation-ledger.ts", [
				"\tsummary.push({",
				'\t\tkind: "fold-row-kind",',
				"\t\tcount: 1,",
				"\t});",
			]);
			expect(
				lintPrBody(withObservability("The record is fold-row-kind."), fixture),
			).toEqual({ valid: true, errors: [] });
			expect(
				lintPrBody(withObservability("The record is not-in-diff."), fixture)
					.valid,
			).toBe(false);
		});

		it("harvests recordDegradation's kind", () => {
			const fixture = runtimeFixture("clients/example.ts", [
				'recordDegradation({ kind: "single-record-kind" });',
			]);
			expect(
				lintPrBody(
					withObservability("The record is single-record-kind."),
					fixture,
				),
			).toEqual({ valid: true, errors: [] });
		});
	});

	// #3906: `git diff --unified=0` hands the runtime scan the hunk, not a file.
	// A JSDoc body's continuation line can look exactly like a generator head
	// (` * name(...) {`), so a hunk-local lexer cannot tell a comment from code.
	// The scan now reads the whole post-image the diff names, lexes it once, and
	// intersects the records with the added POST-image lines. These fixtures
	// carry the real `/**` opener (or the real generator head), so the lexer's
	// block-comment state, not a regex guess, decides.
	describe("block-comment continuations never hide or satisfy a record (#3906)", () => {
		const withObservability = (text: string) =>
			body.replace("The advisory check run is the record.", text);

		it.each([
			["an unbalanced backtick", " * the `findRelocation window"],
			[
				"a balanced backtick and apostrophe",
				" * the `findRelocation`'s window",
			],
			["an unbalanced double quote", ' * the "relocation window'],
		])(
			"finds the record below a JSDoc continuation carrying %s",
			(_name, continuation) => {
				expect(
					lintPrBody(
						withObservability("The record is real-kind."),
						docFixture(
							"clients/widget.ts",
							[continuation],
							['\treturn recordDegradationOnce({ kind: "real-kind" });'],
						),
					),
				).toEqual({ valid: true, errors: [] });
			},
		);

		it("keeps a record's line number when a continuation line sits above it", () => {
			// The record's line must stay the post-image line the diff added, not
			// shift when a continuation line leaves the hunk.
			const fixture = runtimeFixture(
				"clients/widget.ts",
				[
					"\tconst before = 1;",
					"/**",
					" * the `findRelocation window",
					" */",
					'\treturn recordDegradationOnce({ kind: "shift-kind" });',
					"\tconst after = 2;",
				],
				[2, 3, 4, 5],
			);
			expect(
				lintPrBody(withObservability("The record is shift-kind."), fixture),
			).toEqual({ valid: true, errors: [] });
		});

		it("refuses a prose record literal inside a JSDoc continuation", () => {
			expect(
				lintPrBody(
					withObservability("The record is prose-kind."),
					docFixture(
						"clients/widget.ts",
						[
							' * recordDegradationOnce({ kind: "prose-kind" }) is documentation.',
						],
						[],
					),
				).valid,
			).toBe(false);
		});

		// N1 (#3906 r3, AC 5): the ordinary ` * name(...) { ... }` JSDoc form is
		// indistinguishable from a generator head without the opener. A prose
		// `recordDegradationOnce` in it must neither satisfy the check nor set a
		// failure path.
		it("refuses a prose record on a `* example()` JSDoc continuation", () => {
			expect(
				lintPrBody(
					withObservability("The record is doc-example."),
					docFixture(
						"clients/widget.ts",
						[' * example() { recordDegradationOnce({ kind: "doc-example" }) }'],
						[],
					),
				).valid,
			).toBe(false);
		});

		it("accepts the honest sentence when only a `* example()` JSDoc continuation is added", () => {
			expect(
				lintPrBody(
					withObservability("No new failure path; no record added."),
					docFixture(
						"clients/widget.ts",
						[' * example() { recordDegradationOnce({ kind: "doc-example" }) }'],
						[],
					),
				),
			).toEqual({ valid: true, errors: [] });
		});

		it("keeps a record on a generator method line", () => {
			expect(
				lintPrBody(
					withObservability("The record is gen-kind."),
					runtimeFixture("clients/widget.ts", [
						'*entries() { return recordDegradationOnce({ kind: "gen-kind" }); }',
					]),
				),
			).toEqual({ valid: true, errors: [] });
		});

		it("keeps a record on a computed generator method line", () => {
			expect(
				lintPrBody(
					withObservability("The record is computed-kind."),
					runtimeFixture("clients/widget.ts", [
						'*[Symbol.iterator]() { return recordDegradationOnce({ kind: "computed-kind" }); }',
					]),
				),
			).toEqual({ valid: true, errors: [] });
		});

		it("finds the record below a multiline generator head", () => {
			expect(
				lintPrBody(
					withObservability("The record is multi-kind."),
					runtimeFixture("clients/widget.ts", [
						"*multi(",
						"\ta,",
						") {",
						'\treturn recordDegradationOnce({ kind: "multi-kind" });',
						"}",
					]),
				),
			).toEqual({ valid: true, errors: [] });
		});

		// N2 (#3906 r3, AC 7): a comment between the `*` and the method name is
		// what `oxfmt 0.71.0` writes; the real record below the head must not be
		// blanked away, and the honest sentence must be refused because a record
		// really is added.
		it("finds a real record below a `*/* head-comment */ entries()` generator head", () => {
			const fixture = runtimeFixture("clients/widget.ts", [
				"\t*/* head-comment */ entries(): Generator<string> {",
				'\t\tyield "a";',
				'\t\trecordDegradationOnce({ kind: "below-kind" });',
				"\t}",
			]);
			expect(
				lintPrBody(withObservability("The record is below-kind."), fixture),
			).toEqual({ valid: true, errors: [] });
			expect(
				lintPrBody(
					withObservability("No new failure path; no record added."),
					fixture,
				).valid,
			).toBe(false);
		});

		// A `*the`/`**Note:**` continuation with no space after the `*` is a
		// formatter-stable shape; the opener, not the leading run, decides.
		it.each([
			["an unbalanced backtick", " *the `findRelocation window"],
			["a balanced backtick and apostrophe", " *the `findRelocation`'s window"],
			["an unbalanced double quote", ' *the "relocation window'],
			["a doubled star", " **Note:** the `window"],
		])(
			"finds the record below a no-space JSDoc continuation carrying %s",
			(_name, continuation) => {
				expect(
					lintPrBody(
						withObservability("The record is no-space-kind."),
						docFixture(
							"clients/widget.ts",
							[continuation],
							['\treturn recordDegradationOnce({ kind: "no-space-kind" });'],
						),
					),
				).toEqual({ valid: true, errors: [] });
			},
		);

		it.each([
			[
				"a no-space continuation",
				' *the `window` and recordDegradationOnce({ kind: "prose-kind" }) docs',
			],
			[
				"a doubled-star continuation",
				' **recordDegradationOnce({ kind: "prose-kind" })** docs',
			],
			[
				"a bare call at the star",
				'*recordDegradationOnce({ kind: "prose-kind" }) is documented.',
			],
		])("refuses a prose record literal inside %s", (_name, line) => {
			expect(
				lintPrBody(
					withObservability("The record is prose-kind."),
					docFixture("clients/widget.ts", [line], []),
				).valid,
			).toBe(false);
		});

		// A no-space continuation carrying an unbalanced quote used to open a
		// template string that blanked the failure path or seam branch below it,
		// so the bare sentence passed (#3906 F1 false clean).
		it.each([
			[
				"a failure path",
				"clients/widget.ts",
				"\tcatch (error) { warn(error); }",
			],
			[
				"a seam branch",
				"clients/session-scope.ts",
				"\tif (adopt) apply(slot);",
			],
		])(
			"still refuses the no-record sentence when a no-space continuation precedes %s",
			(_name, file, branch) => {
				const result = lintPrBody(
					withObservability("No new failure path; no record added."),
					docFixture(file, [" *the `window"], [branch]),
				);
				expect(result.valid).toBe(false);
			},
		);
	});

	describe("post-image identity and bounds (#3906 r3)", () => {
		const withObservability = (text: string) =>
			body.replace("The advisory check run is the record.", text);

		it("reads a C-quoted Git path with a non-ASCII byte", () => {
			// Git C-quotes the UTF-8 bytes of a non-ASCII path; a byte-wise unquote
			// must still find the file, or the harvest silently skips it. The honest
			// sentence is refused only when the file was actually read.
			const diff = [
				'diff --git "a/clients/caf\\303\\251.ts" "b/clients/caf\\303\\251.ts"',
				"@@ -1 +1 @@",
				"-\texport const a = 1;",
				'+\trecordDegradationOnce({ kind: "cafe-kind" });',
			].join("\n");
			const headFiles = new Map([
				["clients/café.ts", '\trecordDegradationOnce({ kind: "cafe-kind" });'],
			]);
			expect(
				lintPrBody(withObservability("The record is cafe-kind."), {
					diff,
					headFiles,
				}),
			).toEqual({ valid: true, errors: [] });
			expect(
				lintPrBody(withObservability("No new failure path; no record added."), {
					diff,
					headFiles,
				}).valid,
			).toBe(false);
		});

		it("reads a C-quoted Git path with a backslash", () => {
			const diff = [
				'diff --git "a/clients/back\\\\slash.ts" "b/clients/back\\\\slash.ts"',
				"@@ -1 +1 @@",
				"-\texport const c = 1;",
				'+\trecordDegradationOnce({ kind: "back-kind" });',
			].join("\n");
			const headFiles = new Map([
				[
					"clients/back\\slash.ts",
					'\trecordDegradationOnce({ kind: "back-kind" });',
				],
			]);
			expect(
				lintPrBody(withObservability("The record is back-kind."), {
					diff,
					headFiles,
				}),
			).toEqual({ valid: true, errors: [] });
			expect(
				lintPrBody(withObservability("No new failure path; no record added."), {
					diff,
					headFiles,
				}).valid,
			).toBe(false);
		});

		it("reads a real Git C-quoted runtime path with an embedded quote", () => {
			// Recurrence: #3945 mutations 64/66/67 — without the `\\` escape branch
			// in `readQuotedPath`, Git's `"a/clients/we\"ird.ts"` token ends at the
			// escaped quote, `gitHeaderPaths` returns null, the file reads as
			// non-runtime, and the denial body becomes a false clean.
			const fixture = createOriginMasterFixture(undefined, {
				path: 'clients/we"ird.ts',
				pre: ["export let x = 0;"],
				post: [
					"export let x = 0;",
					'\trecordDegradationOnce({ kind: "quote-kind" });',
				],
				dirty: [
					"export let x = 0;",
					'\trecordDegradationOnce({ kind: "quote-kind" });',
				],
			});
			try {
				const diff = localDiff(fixture);
				// The producer must actually C-quote the embedded quote; otherwise the
				// fixture is not the shape this escape branch exists for.
				expect(diff).toContain('"a/clients/we\\"ird.ts"');
				expect(
					lintPrBody(withObservability("The record is quote-kind."), {
						diff,
						cwd: fixture,
						workingTree: true,
					}),
				).toEqual({ valid: true, errors: [] });
				const denied = lintPrBody(
					withObservability("No new failure path; no record added."),
					{ diff, cwd: fixture, workingTree: true },
				);
				expect(denied.valid).toBe(false);
				expect(denied.errors.join(" ")).toContain("failure path");
			} finally {
				rmSync(fixture, { recursive: true, force: true });
			}
		});

		it("reads an unquoted path that contains a space", () => {
			const diff = [
				"diff --git a/clients/brand new.ts b/clients/brand new.ts",
				"@@ -1 +1 @@",
				"-\texport const s = 1;",
				'+\trecordDegradationOnce({ kind: "space-kind" });',
			].join("\n");
			const headFiles = new Map([
				[
					"clients/brand new.ts",
					'\trecordDegradationOnce({ kind: "space-kind" });',
				],
			]);
			expect(
				lintPrBody(withObservability("The record is space-kind."), {
					diff,
					headFiles,
				}),
			).toEqual({ valid: true, errors: [] });
			expect(
				lintPrBody(withObservability("No new failure path; no record added."), {
					diff,
					headFiles,
				}).valid,
			).toBe(false);
		});

		it("follows a rename to a runtime path", () => {
			const diff = [
				"diff --git a/clients/old.ts b/clients/new.ts",
				"similarity index 100%",
				"rename from clients/old.ts",
				"rename to clients/new.ts",
				"@@ -0,0 +1 @@",
				'+\trecordDegradationOnce({ kind: "renamed-kind" });',
			].join("\n");
			const headFiles = new Map([
				[
					"clients/new.ts",
					'\trecordDegradationOnce({ kind: "renamed-kind" });',
				],
			]);
			expect(
				lintPrBody(withObservability("The record is renamed-kind."), {
					diff,
					headFiles,
				}),
			).toEqual({ valid: true, errors: [] });
			expect(
				lintPrBody(withObservability("No new failure path; no record added."), {
					diff,
					headFiles,
				}).valid,
			).toBe(false);
		});

		it("refuses visibly when the post-image is missing", () => {
			const diff = [
				"diff --git a/clients/ghost-post-image.ts b/clients/ghost-post-image.ts",
				"@@ -0,0 +1 @@",
				'+\trecordDegradationOnce({ kind: "ghost-kind" });',
			].join("\n");
			const result = lintPrBody(
				withObservability("The record is ghost-kind."),
				{
					diff,
				},
			);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain("could not classify");
			expect(result.errors.join(" ")).toContain("clients/ghost-post-image.ts");
		});

		it("refuses an unreadable post-image whose only added line is blank", () => {
			// Recurrence: #3945 mutations 140/143 — skipping the unavailable-source
			// guard lets `sourceLines(null)` produce `[""]`, the blank added line
			// "matches" it, and `blankCommentsAndStrings(null)` throws instead of
			// refusing with "could not classify".
			const diff = [
				"diff --git a/clients/unreadable-blank.ts b/clients/unreadable-blank.ts",
				"@@ -1 +1 @@",
				"-export const before = 1;",
				"+",
			].join("\n");
			// The enclosing fixture repository has no such file, so the real
			// working-tree read fails and the post-image is genuinely unavailable.
			const result = lintPrBody(
				withObservability("No new failure path; no record added."),
				{ diff, cwd: process.cwd(), workingTree: true },
			);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain("could not classify");
			expect(result.errors.join(" ")).toContain("clients/unreadable-blank.ts");
		});

		it("refuses visibly when the post-image does not match the diff", () => {
			const diff = [
				"diff --git a/clients/widget.ts b/clients/widget.ts",
				"@@ -1,0 +1 @@",
				'+\trecordDegradationOnce({ kind: "diff-kind" });',
			].join("\n");
			const result = lintPrBody(withObservability("The record is diff-kind."), {
				diff,
				headFiles: new Map([
					["clients/widget.ts", "export const different = 1;"],
				]),
			});
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain("could not classify");
		});

		it("reads the post-image from HEAD, not the citation ref", () => {
			// `ref` is the base revision for `--ref` path citations; the runtime
			// post-image is HEAD or the working tree. Reading the ref instead would
			// classify the added lines from the pre-image.
			const diff = [
				"diff --git a/clients/widget.ts b/clients/widget.ts",
				"@@ -0,0 +1 @@",
				'+\trecordDegradationOnce({ kind: "head-kind" });',
			].join("\n");
			const result = lintPrBody(
				withObservability("No new failure path; no record added."),
				{
					diff,
					ref: "base-ref",
					git: (args: string[]) => {
						if (args[0] !== "show") return "";
						if (args[1] === "HEAD:clients/widget.ts")
							return '\trecordDegradationOnce({ kind: "head-kind" });';
						return "export const pre = 1;";
					},
				},
			);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain("failure path");
		});

		it("refuses a working-tree post-image over the byte ceiling", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-oversize-"));
			try {
				const added = '\trecordDegradationOnce({ kind: "big-kind" });';
				mkdirSync(join(root, "clients"), { recursive: true });
				writeFileSync(
					join(root, "clients", "big.ts"),
					`${added}\n${"x".repeat(17 * 1024 * 1024)}`,
				);
				const diff = [
					"diff --git a/clients/big.ts b/clients/big.ts",
					"@@ -0,0 +1 @@",
					`+${added}`,
				].join("\n");
				const result = lintPrBody(
					withObservability("The record is big-kind."),
					{
						diff,
						cwd: root,
						workingTree: true,
					},
				);
				expect(result.valid).toBe(false);
				expect(result.errors.join(" ")).toContain("could not classify");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		// #3906 r5 F1: the blob branch's byte ceiling is the boundary that keeps a
		// truncated read from being classified. A committed post-image over
		// `MAX_SOURCE_BYTES` must decline visibly (`indeterminate`), and a size
		// between Node's 1 MiB default and the 16 MiB ceiling must read, or the
		// reader drops legitimate records. Both go through production
		// `headFileSource` with the real `git cat-file -p` transport; no
		// `headFiles` override stands in for the blob.
		it("refuses a committed post-image blob over the byte ceiling", () => {
			const fixtureCwd = createOriginMasterFixture(undefined, {
				path: "clients/over-ceiling.ts",
				pre: ["export let x = 0;"],
				post: [
					"export let x = 0;",
					'recordDegradationOnce({ kind: "over-kind" });',
				],
				dirty: [
					"export let x = 0;",
					'recordDegradationOnce({ kind: "over-kind" });',
				],
				padLines: 2_546_542,
			});
			try {
				const bytes = statSync(
					join(fixtureCwd, "clients", "over-ceiling.ts"),
				).size;
				expect(bytes).toBeGreaterThan(16 * 1024 * 1024);
				const diff = localDiff(fixtureCwd);
				expect(diff).toContain("index ");
				const result = lintPrBody(
					withObservability("The record is over-kind."),
					{ diff, cwd: fixtureCwd, workingTree: true },
				);
				expect(result.valid).toBe(false);
				expect(result.errors.join(" ")).toContain("could not classify");
				expect(result.errors.join(" ")).toContain("clients/over-ceiling.ts");
			} finally {
				rmSync(fixtureCwd, { recursive: true, force: true });
			}
		});

		it("reads a committed post-image blob over Node's default buffer", () => {
			const fixtureCwd = createOriginMasterFixture(undefined, {
				path: "clients/mid-ceiling.ts",
				pre: ["export let x = 0;"],
				post: [
					"export let x = 0;",
					'recordDegradationOnce({ kind: "mid-kind" });',
				],
				dirty: [
					"export let x = 0;",
					'recordDegradationOnce({ kind: "mid-kind" });',
				],
				padLines: 299_592,
			});
			try {
				const bytes = statSync(
					join(fixtureCwd, "clients", "mid-ceiling.ts"),
				).size;
				expect(bytes).toBeGreaterThan(1024 * 1024);
				expect(bytes).toBeLessThan(16 * 1024 * 1024);
				const diff = localDiff(fixtureCwd);
				expect(diff).toContain("index ");
				expect(
					lintPrBody(withObservability("The record is mid-kind."), {
						diff,
						cwd: fixtureCwd,
						workingTree: true,
					}),
				).toEqual({ valid: true, errors: [] });
			} finally {
				rmSync(fixtureCwd, { recursive: true, force: true });
			}
		});

		it("reads the diff's immutable post-image blob, not a dirty working tree", () => {
			// R3-A: the diff names `index <pre>..<post>`; the working tree dirties
			// an UNCHANGED line so a block comment would swallow the added record.
			// Every added line still matches, so an added-line-only check passes
			// and the honest sentence becomes a false clean. The named blob holds
			// the real state, so the reader must take it.
			const fixtureCwd = createOriginMasterFixture(undefined, {
				path: "clients/rec.ts",
				pre: ["export let x = 0;"],
				post: [
					"export let x = 0;",
					'recordDegradationOnce({ kind: "real-kind" });',
				],
				dirty: [
					"export let x = 0;/*",
					'recordDegradationOnce({ kind: "real-kind" });',
				],
			});
			try {
				const diff = localDiff(fixtureCwd);
				expect(diff).toContain("index ");
				expect(
					lintPrBody(withObservability("The record is real-kind."), {
						diff,
						cwd: fixtureCwd,
						workingTree: true,
					}),
				).toEqual({ valid: true, errors: [] });
				expect(
					lintPrBody(
						withObservability("No new failure path; no record added."),
						{
							diff,
							cwd: fixtureCwd,
							workingTree: true,
						},
					).valid,
				).toBe(false);
			} finally {
				rmSync(fixtureCwd, { recursive: true, force: true });
			}
		});

		it("prefers a named post-image blob over the mutable working tree", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-blob-"));
			try {
				mkdirSync(join(root, "clients"), { recursive: true });
				writeFileSync(
					join(root, "clients", "dirty.ts"),
					'export let x = 0;/*\nrecordDegradationOnce({ kind: "real-kind" });',
				);
				const diff = [
					"diff --git a/clients/dirty.ts b/clients/dirty.ts",
					"index 0a8fa80..0340955 100644",
					"@@ -1,0 +2 @@ export let x = 0;",
					'+recordDegradationOnce({ kind: "real-kind" });',
				].join("\n");
				const git = (args: string[]) => {
					expect(args).toEqual(["cat-file", "-p", "0340955"]);
					return 'export let x = 0;\nrecordDegradationOnce({ kind: "real-kind" });';
				};
				expect(
					lintPrBody(withObservability("The record is real-kind."), {
						diff,
						cwd: root,
						workingTree: true,
						git,
					}),
				).toEqual({ valid: true, errors: [] });
				expect(
					lintPrBody(
						withObservability("No new failure path; no record added."),
						{
							diff,
							cwd: root,
							workingTree: true,
							git,
						},
					).valid,
				).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("declines when the diff names a blob that cannot be read", () => {
			const diff = [
				"diff --git a/clients/gone.ts b/clients/gone.ts",
				"index 1111111..2222222 100644",
				"@@ -0,0 +1 @@",
				'+recordDegradationOnce({ kind: "gone-kind" });',
			].join("\n");
			const result = lintPrBody(withObservability("The record is gone-kind."), {
				diff,
				git: () => {
					throw new Error("missing object");
				},
			});
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain("could not classify");
		});

		it("harvests an added line whose content starts with `++`", () => {
			// Git emits an added code line `++counter;` as `+++counter;`. Inside a
			// hunk that is content, not a file header, so the record is found
			// (#3906 R3-B). Base and f0 both refused it.
			const fixture = runtimeFixture(
				"clients/incr.ts",
				[
					"export let counter = 0;",
					'++counter; recordDegradationOnce({ kind: "sneaky" });',
				],
				[2],
			);
			expect(
				lintPrBody(withObservability("The record is sneaky."), fixture),
			).toEqual({ valid: true, errors: [] });
			expect(
				lintPrBody(
					withObservability("No new failure path; no record added."),
					fixture,
				).valid,
			).toBe(false);
		});

		it("does not advance the POST cursor on a removed line starting with --", () => {
			// Git emits a removed code line `--old` as `---old`. In the hunk body it
			// is a removal, not a file header, so the added line stays at its POST
			// number.
			const diff = [
				"diff --git a/clients/del.ts b/clients/del.ts",
				"@@ -2,1 +2,1 @@",
				"---old",
				'+recordDegradationOnce({ kind: "del-kind" });',
			].join("\n");
			const headFiles = new Map([
				[
					"clients/del.ts",
					'export let keep = 0;\nrecordDegradationOnce({ kind: "del-kind" });',
				],
			]);
			expect(
				lintPrBody(withObservability("The record is del-kind."), {
					diff,
					headFiles,
				}),
			).toEqual({ valid: true, errors: [] });
		});

		it("ignores a `No newline at end of file` marker without moving the cursor", () => {
			const fixture = runtimeFixture(
				"clients/nonl.ts",
				[
					"export const x = 1;",
					'recordDegradationOnce({ kind: "nonl-kind" });',
				],
				[2],
			);
			const marker = "\\ No newline at end of file";
			expect(
				lintPrBody(withObservability("The record is nonl-kind."), {
					diff: `${fixture.diff}\n${marker}`,
					headFiles: fixture.headFiles,
				}),
			).toEqual({ valid: true, errors: [] });
		});
	});

	describe("decision branches on a session, lifecycle or delivery seam (#3875)", () => {
		const sentence = "No new failure path; no record added.";
		const withObservability = (text: string) =>
			body.replace("The advisory check run is the record.", text);
		const diffAdding = (file: string, ...added: string[]) =>
			[
				`diff --git a/${file} b/${file}`,
				`@@ -1,0 +1,${added.length} @@`,
				...added.map((line) => `+${line}`),
			].join("\n");
		// Recurrence: #3873 — the S2/S3 session-scope fixes (#3819, #3855, #3758,
		// #3759) added adopt/reset/skip branches that are not failure paths, so
		// the exact no-record sentence passed and the records never existed.
		const seamBranch = diffAdding(
			"clients/session-scope.ts",
			"\tif (slot.sessionFile === sessionFile) adoptHandoff(slot);",
		);
		const refusal = "decision branch";

		it("refuses the no-record sentence for a branch added to a seam file", () => {
			const result = lintPrBody(
				withObservability(sentence),
				postImageFromDiff(seamBranch),
			);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(refusal);
			expect(result.errors.join(" ")).toContain("clients/session-scope.ts: 1");
		});

		it.each([
			["if", "\tif (adopt) apply(slot);"],
			["if without a space", "\tif(adopt) apply(slot);"],
			["else", "\t} else {"],
			["switch", "\tswitch (slot.kind) {"],
			["switch without a space", "\tswitch(slot.kind) {"],
			["case", '\t\tcase "adopt":'],
		])("detects a %s branch", (_name, line) => {
			expect(
				lintPrBody(
					withObservability(sentence),
					postImageFromDiff(diffAdding("clients/session-scope.ts", line)),
				).errors.join(" "),
			).toContain(refusal);
		});

		// Recurrence: r1 of #3905 pinned `clients/fix-run-restore.ts` as "the
		// unmodelled row"; the pin decays when a TLA lane models that file. Every
		// row of the real map is the population, so a hub, an `unmodelled` value
		// and a single-family row are all in it with no file named here.
		it("treats every coverage-map row, whatever its value, as a seam", () => {
			const rows = Object.keys(
				JSON.parse(
					readFileSync(
						join(repositoryRoot, "formal", "coverage-map.json"),
						"utf8",
					),
				).map,
			);
			expect(rows.length).toBeGreaterThan(0);
			const missed = rows.filter(
				(file) =>
					!lintPrBody(
						withObservability(sentence),
						postImageFromDiff(diffAdding(file, "\tif (adopt) apply(slot);")),
					)
						.errors.join(" ")
						.includes(refusal),
			);
			expect(missed).toEqual([]);
		});

		it("accepts the same diff when the body names a record literal the diff adds", () => {
			const diff = postImageFromDiff(
				diffAdding(
					"clients/session-scope.ts",
					"\tif (slot.sessionFile === sessionFile) {",
					'\t\tlogLatency({ phase: "session_handoff_adopt" });',
					"\t}",
				),
			);
			expect(
				lintPrBody(
					withObservability("The record is session_handoff_adopt."),
					diff,
				),
			).toEqual({ valid: true, errors: [] });
			expect(
				lintPrBody(withObservability(sentence), diff).errors.join(" "),
			).toContain(refusal);
		});

		// Recurrence: r1 of #3905 F2: `none: yes yes yes` and the template text
		// `none: <reason> goes here` passed, so one throwaway line answered every
		// branch in every file. The reason now names each flagged file.
		const none = (reason: string) =>
			lintPrBody(withObservability(reason), postImageFromDiff(seamBranch));

		it("accepts `none: <reason>` that names the flagged file", () => {
			expect(
				none(
					"none: session-scope.ts only selects between two already-recorded outcomes",
				),
			).toEqual({ valid: true, errors: [] });
		});

		it.each([
			["a bullet", "- none: session-scope.ts only picks a recorded outcome"],
			["bold", "**none:** session-scope.ts only picks a recorded outcome"],
			["upper case", "None: session-scope.ts only picks a recorded outcome"],
			[
				"a later line",
				"Prose first.\nnone: session-scope.ts only picks a recorded one",
			],
			[
				"CRLF",
				"Prose first.\r\nnone: session-scope.ts only picks a recorded one",
			],
			["three words", "none: guards the session-scope.ts"],
			[
				"an honest none-of reason",
				"none: none of session-scope.ts decides delivery",
			],
			[
				"an honest placeholder-word suffix",
				"none: the guard in session-scope.ts is not applicable here",
			],
		])("accepts a reason written as %s", (_name, text) => {
			expect(none(text)).toEqual({ valid: true, errors: [] });
		});

		// R-a (#3905 r2): the file check was a plain substring, so a longer
		// basename satisfied a flagged file. The reviewer's three probes:
		// `lsp-server.ts` satisfied `clients/lsp/server.ts`, a root-prefixed
		// `index.ts` satisfied `clients/lsp/index.ts`, and
		// `tree-sitter-client.ts` satisfied `clients/lsp/client.ts`.
		it.each([
			["clients/lsp/server.ts", "lsp-server.ts"],
			["clients/lsp/index.ts", "rootindex.ts"],
			["clients/lsp/index.ts", "clients/lsp/other-index.ts"],
			["clients/lsp/client.ts", "tree-sitter-client.ts"],
		])("refuses %s when the reason only names %s", (flagged, token) => {
			const diff = postImageFromDiff(
				diffAdding(flagged, "\tif (ready) adopt(slot);"),
			);
			const result = lintPrBody(
				withObservability(
					`none: ${token} only forwards the already-recorded outcome`,
				),
				diff,
			);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(refusal);
		});

		it("accepts the flagged basename at a path boundary", () => {
			const diff = postImageFromDiff(
				diffAdding("clients/lsp/server.ts", "\tif (ready) adopt(slot);"),
			);
			expect(
				lintPrBody(
					withObservability(
						"none: clients/lsp/server.ts only forwards the recorded outcome",
					),
					diff,
				),
			).toEqual({ valid: true, errors: [] });
		});

		it("accepts one none line per flagged file", () => {
			const diff = postImageFromDiff(
				[
					seamBranch,
					diffAdding("clients/agent-nudge.ts", "\tif (queued) flush();"),
				].join("\n"),
			);
			const reasons = (text: string) =>
				lintPrBody(withObservability(text), diff);
			expect(
				reasons(
					"none: session-scope.ts only selects a recorded outcome\nnone: agent-nudge.ts only flushes an already counted queue",
				),
			).toEqual({ valid: true, errors: [] });
			const refused = reasons(
				"none: session-scope.ts only selects a recorded outcome",
			).errors.join(" ");
			expect(refused).toContain(
				"clients/session-scope.ts: 1, clients/agent-nudge.ts: 1",
			);
		});

		it.each([
			["nothing after the colon", "none:"],
			["a bare n/a", "none: n/a"],
			["a bare none", "none: none"],
			["too short", "none: session-scope.ts only"],
			["a trailing space after two words", "none: skips session-scope.ts "],
			["a double space between two words", "none: skips  session-scope.ts"],
			[
				"the template placeholder",
				"none: <reason> goes here in session-scope.ts",
			],
			["no flagged file named", "none: yes yes yes"],
			[
				"a different file named",
				"none: agent-nudge.ts only picks a recorded outcome",
			],
			["n/a repeated", "none: n/a n/a n/a"],
			["na repeated", "none: na na na"],
			["none repeated", "none: none none none"],
			["not applicable", "none: not applicable here"],
			["tbd repeated", "none: tbd tbd tbd"],
			["todo repeated", "none: todo todo todo"],
			[
				"not mid-line",
				"see the none: session-scope.ts only picks a recorded outcome",
			],
		])("refuses a reason that is %s", (_name, text) => {
			expect(none(text).errors.join(" ")).toContain(refusal);
		});

		// With a seam file the basename requirement already refuses placeholder
		// words; on a diff with no flagged file only the placeholder test stands.
		it.each([
			"n/a n/a n/a",
			"na na na",
			"none none none",
			"not applicable here",
			"tbd tbd tbd",
			"todo todo todo",
		])(
			"refuses the placeholder reason %j when no file is flagged",
			(reason) => {
				expect(
					lintPrBody(
						withObservability(`none: ${reason}`),
						postImageFromDiff(
							diffAdding("clients/example.ts", "\tif (ready) go();"),
						),
					).valid,
				).toBe(false);
			},
		);

		it("tells the author to name each flagged file", () => {
			expect(none("none: yes yes yes").errors.join(" ")).toContain(
				"naming each file above by basename",
			);
		});

		it("still requires a record for a failure path, whatever the reason says", () => {
			const diff = postImageFromDiff(
				diffAdding(
					"clients/session-scope.ts",
					"\ttry { adopt(); } catch (error) { warn(error); }",
				),
			);
			expect(
				lintPrBody(
					withObservability("none: the catch only forwards to the host"),
					diff,
				).errors.join(" "),
			).toContain("not valid when the added lines contain a failure path");
		});

		it("leaves a branch in a file outside the coverage map on the old form", () => {
			const diff = postImageFromDiff(
				diffAdding("clients/example.ts", "\tif (ready) go();"),
			);
			expect(lintPrBody(withObservability(sentence), diff)).toEqual({
				valid: true,
				errors: [],
			});
		});

		it("leaves a seam file without an added branch on the old form", () => {
			const diff = postImageFromDiff(
				diffAdding(
					"clients/session-scope.ts",
					"\tconst keyHash = hashKey(slot.sessionFile);",
				),
			);
			expect(lintPrBody(withObservability(sentence), diff)).toEqual({
				valid: true,
				errors: [],
			});
		});

		// Recurrence: r1 of #3905 F1: dropping every `*`-led line also dropped a
		// block's closer, so the blanker read an unterminated comment and hid all
		// later code, which let #3770's `catch` blocks pass the bare sentence.
		it.each([
			[
				"a whole block, then code",
				["/**", " * a note", " */", "\tif (adopt) apply(slot);"],
			],
			[
				"a one-line block, then code",
				["/** a note */", "\tif (adopt) apply(slot);"],
			],
			[
				"an inline block before code",
				["\t/* a note */ if (adopt) apply(slot);"],
			],
			[
				"a block closer sharing a line with code",
				["/**", " * a note", " */ if (adopt) apply(slot);"],
			],
			[
				"a line comment, then code",
				["\t// a note", "\tif (adopt) apply(slot);"],
			],
			["a multiplication line", ["\tconst n = a * b; if (adopt) apply(slot);"]],
		])("still sees a seam branch after %s", (_name, lines) => {
			expect(
				lintPrBody(
					withObservability(sentence),
					runtimeFixture("clients/session-scope.ts", lines),
				).errors.join(" "),
			).toContain(refusal);
		});

		it("still sees a failure path after a whole JSDoc block", () => {
			const diff = postImageFromDiff(
				diffAdding(
					"clients/example.ts",
					"/**",
					" * installs the thing",
					" */",
					"\ttry { install(); } catch (error) { warn(error); }",
				),
			);
			expect(
				lintPrBody(withObservability(sentence), diff).errors.join(" "),
			).toContain("not valid when the added lines contain a failure path");
		});

		it("reads the whole post-image, so an earlier hunk's block close is visible to a later hunk", () => {
			// The `/**` opener is in the first hunk and its closer is an unchanged
			// context line present in the post-image, so the second hunk's branch is
			// real code. A hunk-local lexer could not see the closer.
			const rows = [
				"/**",
				" * an opener whose closer is an unchanged context line",
				" */",
				...Array.from({ length: 38 }, () => ""),
				"\tif (adopt) apply(slot);",
			];
			const fixture = runtimeFixture(
				"clients/session-scope.ts",
				rows,
				[1, 2, 42],
			);
			expect(
				lintPrBody(withObservability(sentence), fixture).errors.join(" "),
			).toContain(refusal);
		});

		// A file's hunks are separate lexing units that sum back to one verdict.
		const twoHunks = (first: string, second: string) =>
			postImageFromDiff(
				[
					"diff --git a/clients/session-scope.ts b/clients/session-scope.ts",
					"@@ -1,0 +1,1 @@",
					`+${first}`,
					"@@ -40,0 +41,1 @@",
					`+${second}`,
				].join("\n"),
			);

		it("keeps a failure path found in an earlier hunk when the last hunk has none", () => {
			expect(
				lintPrBody(
					withObservability(sentence),
					twoHunks("\ttry { adopt(); } catch { warn(); }", "\tnext();"),
				).errors.join(" "),
			).toContain("not valid when the added lines contain a failure path");
		});

		it("sums a file's branches over its hunks", () => {
			expect(
				lintPrBody(
					withObservability(sentence),
					twoHunks("\tif (a) adopt();", "\tif (b) reset();"),
				).errors.join(" "),
			).toContain("clients/session-scope.ts: 2");
		});

		it("reads #3770's real installer diff as a failure path again", () => {
			// Real `--unified=0` diff of #3770: `} catch {` and `.catch(() => {})`
			// follow added JSDoc blocks. origin/master refused it under the bare
			// sentence; the r1 filter accepted it.
			const diff = fixtureWithBlob(
				readFileSync(
					join(
						repositoryRoot,
						"tests",
						"fixtures",
						"ci-pr-bodies",
						"pr-3770-runtime.diff",
					),
					"utf8",
				),
			);
			expect(
				lintPrBody(withObservability(sentence), diff).errors.join(" "),
			).toContain("not valid when the added lines contain a failure path");
		});

		it("reads code, not prose: comments, strings and JSDoc continuations never count", () => {
			expect(
				lintPrBody(
					withObservability(sentence),
					docFixture(
						"clients/session-scope.ts",
						[" * is the unverifiable case above and else nothing"],
						[
							"\t// if (adopt) the other case wins, else reset",
							'\tconst note = "if (adopt) else switch (kind) case";',
						],
					),
				),
			).toEqual({ valid: true, errors: [] });
		});

		// Same lexer, same `--unified=0` blind spot, on the failure-path scan the
		// sentence also depends on: a JSDoc continuation line carries no opener.
		it("does not read a failure path out of a JSDoc continuation line", () => {
			expect(
				lintPrBody(
					withObservability(sentence),
					docFixture(
						"clients/example.ts",
						[" * a retry may throw here and the caller must catch it"],
						[],
					),
				),
			).toEqual({ valid: true, errors: [] });
		});

		it("does not let a backtick in a JSDoc continuation line hide a failure path", () => {
			expect(
				lintPrBody(
					withObservability(sentence),
					docFixture(
						"clients/example.ts",
						[" * the `findRelocation`'s window saturates at"],
						["\ttry { adopt(); } catch (error) { warn(error); }"],
					),
				).errors.join(" "),
			).toContain("not valid when the added lines contain a failure path");
		});

		it("refuses merged #3785's honest sentence over its read-guard branches", () => {
			// Real runtime hunks of #3785: `if (opts?.stampFileTime !== false)` and
			// `if (fileTimeMoved && toolCallId !== undefined)` shipped under this
			// exact sentence with no record of the FileTime decision.
			const diff = fixtureWithBlob(
				readFileSync(
					join(
						repositoryRoot,
						"tests",
						"fixtures",
						"ci-pr-bodies",
						"pr-3785-runtime.diff",
					),
					"utf8",
				),
			);
			expect(
				lintPrBody(withObservability(sentence), diff).errors.join(" "),
			).toContain("clients/read-guard.ts");
		});

		it("does not flag #3774's comment-only edit, whose prose said `case`", () => {
			// The archived `--unified=0` hunk's post-image is vendored beside the
			// fixture and pinned by the blob oid its `index` line names, so the real
			// continuation lines are lexed under their real JSDoc opener. The visible
			// consequence is unchanged: a prose `case` in a comment is not a branch.
			expect(
				lintPrBody(
					withObservability(sentence),
					fixtureWithBlob(
						readFileSync(
							join(
								repositoryRoot,
								"tests",
								"fixtures",
								"ci-pr-bodies",
								"pr-3774-comment-runtime.diff",
							),
							"utf8",
						),
					),
				),
			).toEqual({ valid: true, errors: [] });
		});

		it("reaches the local preflight entry point", () => {
			const result = lintLocalPrBody(
				withObservability(sentence),
				process.cwd(),
				() => seamBranch,
				{ headFiles: postImageFromDiff(seamBranch).headFiles },
			);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(refusal);
		});
	});

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
			() => NEW_PATH_RUNTIME_DIFF,
			{ headFiles: NEW_PATH_HEAD_FILES },
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
			() => NEW_PATH_RUNTIME_DIFF,
			{ headFiles: NEW_PATH_HEAD_FILES },
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
					() => NEW_PATH_RUNTIME_DIFF,
					{ headFiles: NEW_PATH_HEAD_FILES },
				);
				expect(result).toEqual({
					valid: false,
					errors: [
						'PR body Observability must name a record literal from the runtime diff; "No new failure path; no record added." is not valid when the added lines contain a failure path.',
						`PR body citation ${file} does not exist in the HEAD tree.`,
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
			() => NEW_PATH_RUNTIME_DIFF,
			{ headFiles: NEW_PATH_HEAD_FILES },
		);
		expect(result).toEqual({
			valid: false,
			errors: [
				'PR body Observability must name a record literal from the runtime diff; "No new failure path; no record added." is not valid when the added lines contain a failure path.',
				"PR body citation clients/does-not-exist.ts:1 does not exist in the HEAD tree.",
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
				`diff --git a/clients/touched-record.ts b/clients/touched-record.ts\n+catch (error) { resolveToolCwd(error); }`,
			{
				headFiles: postImageFromDiff(
					`diff --git a/clients/touched-record.ts b/clients/touched-record.ts\n+catch (error) { resolveToolCwd(error); }`,
				).headFiles,
			},
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
			() => NEW_PATH_RUNTIME_DIFF,
			{ headFiles: NEW_PATH_HEAD_FILES },
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
			() => NEW_PATH_RUNTIME_DIFF,
			{ headFiles: NEW_PATH_HEAD_FILES },
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
			{ headFiles: postImageFromDiff(runtimeDiff).headFiles },
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
			{
				headFiles: postImageFromDiff(
					`diff --git a/clients/example.ts b/clients/example.ts\n+${line}`,
				).headFiles,
			},
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
			mkdirSync(join(fixtureCwd, "clients"), { recursive: true });
			writeFileSync(
				join(fixtureCwd, "clients", "ref.ts"),
				"const local = true;\n",
			);
			const localBody = `${body}\n\nEvidence: \`clients/ref.ts:1\`\n\`\`\`ts\nconst local = true;\n\`\`\``;
			writeFileSync(
				bodyPath,
				`${localBody}\n\n### Test assessment\nThe targeted test covers the local CLI.`,
			);
			for (const args of [
				[checker, "--lint-local", bodyPath],
				[
					checker,
					"--lint-local",
					bodyPath,
					"--title",
					"ci(test): verify local body lint (refs #2807)",
				],
				[checker, "--body", bodyPath, "--title", titlePath],
			]) {
				execFileSync(process.execPath, args, { cwd: fixtureCwd });
			}
			expect(() =>
				execFileSync(
					process.execPath,
					[
						checker,
						"--lint-local",
						bodyPath,
						"--title",
						"ci(test): verify local body lint (closes #2807)",
					],
					{ cwd: fixtureCwd, stdio: "pipe" },
				),
			).toThrow();
			expect(() =>
				execFileSync(
					process.execPath,
					[checker, "--lint-local", bodyPath, "--ref", "HEAD"],
					{ cwd: fixtureCwd, stdio: "pipe" },
				),
			).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("accepts the required sections", () => {
		expect(lintPrBody(body)).toEqual({ valid: true, errors: [] });
	});

	it("rejects two sentences in Why but accepts one", () => {
		const rejected = lintPrBody(
			body.replace(
				"The body gate makes review intent explicit.",
				"The body gate makes review intent explicit. It keeps the contract strict.",
			),
		);
		expect(rejected.valid).toBe(false);
		expect(rejected.errors.join(" ")).toContain(
			'"## Why" must contain exactly one sentence',
		);
		expect(lintPrBody(body)).toEqual({ valid: true, errors: [] });
	});

	it.each([
		["e.g. abbreviation", "The change handles e.g. ordinary input."],
		["i.e. abbreviation", "The change handles i.e. ordinary input."],
		["etc. abbreviation", "The change handles etc. ordinary input."],
		["vs. abbreviation", "The change handles vs. ordinary input."],
		["cf. abbreviation", "The change handles cf. ordinary input."],
		["version", "The change handles version 4.2.1 correctly."],
		["file path", "The change handles foo.ts correctly."],
		["nested file path", "The change handles scripts/x.mjs correctly."],
		["issue reference", "The change addresses issue #3262 directly."],
		["trailing terminator", "The change needs one clear rule."],
		["question ending", "The change answers the question?"],
		["exclamation ending", "The change works!"],
		["quoted period", 'The change preserves the quoted "foo.bar" string.'],
	])(
		"accepts one Why sentence without counting %s (#3262 F-3262-V1)",
		(_name, whyText) => {
			expect(
				lintPrBody(
					body.replace("The body gate makes review intent explicit.", whyText),
				),
			).toEqual({
				valid: true,
				errors: [],
			});
		},
	);

	it("rejects two real Why sentences (#3262 F-3262-V1)", () => {
		const result = lintPrBody(
			body.replace(
				"The body gate makes review intent explicit.",
				"The body gate makes review intent explicit. It keeps the contract strict.",
			),
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain(
			'"## Why" must contain exactly one sentence',
		);
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

	it("rejects a local body missing Why", () => {
		const result = lintLocalPrBody(body.replace("## Why\n", ""));
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('"## Why"');
	});

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
				body
					.replace("## Why\n", "Opening context.\n\n## Why\n")
					.replace("## Summary\nOpening context.\n\n", ""),
			),
		).toMatchObject({ valid: true });
	});

	it("rejects a body with no Summary or opening paragraph", () => {
		expect(
			lintPrBody(body.replace("Summary\nOpening context.\n\n", "")),
		).toMatchObject({ valid: false });
	});
});

// The archived `--unified=0` fixtures (#3770, #3774, #3785) name their
// post-image blobs in the `index` line. CI checks out at depth 1, so those
// historical objects are unreachable from the checkout that runs this suite.
// The bytes are vendored beside the fixtures
// (`pr-3906-hermetic-provenance.json`) and every one is pinned by the git blob
// oid the diff names (#3945). A missing or byte-flipped sidecar fails loudly;
// `fixtureWithBlob` never reconstructs an authentic archive from its hunks.
describe("archived post-image corpus (#3945)", () => {
	const corpusDir = join(repositoryRoot, "tests", "fixtures", "ci-pr-bodies");
	const provenance = JSON.parse(
		readFileSync(join(corpusDir, "pr-3906-hermetic-provenance.json"), "utf8"),
	) as { postImages: Record<string, { path: string; oid: string }> };

	it("vendors every named post-image and pins it to its blob oid", () => {
		const entries = Object.entries(provenance.postImages);
		expect(entries.length).toBeGreaterThanOrEqual(5);
		for (const [file, meta] of entries) {
			const sidecar = join(corpusDir, meta.path);
			expect(statSync(sidecar).isFile(), `${file} -> ${meta.path}`).toBe(true);
			expect(gitBlobOid(readFileSync(sidecar, "utf8")), `${file} oid`).toBe(
				meta.oid,
			);
		}
	});

	it("fails loudly for a fixture whose post-image is not vendored", () => {
		const diff = [
			"diff --git a/clients/unvendored.ts b/clients/unvendored.ts",
			"index 1111111..2222222 100644",
			"@@ -1,0 +1 @@",
			"+\tif (adopt) apply(slot);",
		].join("\n");
		expect(() => fixtureWithBlob(diff)).toThrow(
			/no vendored post-image for clients\/unvendored\.ts/,
		);
	});

	it("fails loudly when the diff names an oid the vendored bytes do not hash to", () => {
		const diff = [
			"diff --git a/clients/read-guard.ts b/clients/read-guard.ts",
			"index 0000000..deadbeef 100644",
			"@@ -1,0 +1 @@",
			"+\tif (adopt) apply(slot);",
		].join("\n");
		expect(() => fixtureWithBlob(diff)).toThrow(
			/vendored post-image for clients\/read-guard\.ts does not match deadbeef/,
		);
	});
});

// #3906 AC2: the #3799 pull-coverage decision in clients/dispatch/dispatcher.ts
// must be visible to the seam record rule. The corpus is the exact published
// #3799 body + diff and the three post-image sources the diff names, pinned by
// each source's git blob oid. CI's shallow checkout does not carry the 2026
// #3799 objects, so the explicit `headFiles` seam supplies the immutable
// post-image and the source hash proves the fixture is that exact object.
describe("dispatcher seam row (#3906 AC2)", () => {
	const corpusDir = join(repositoryRoot, "tests", "fixtures", "ci-pr-bodies");
	const provenance = JSON.parse(
		readFileSync(join(corpusDir, "pr-3799-provenance.json"), "utf8"),
	) as {
		bodyPath: string;
		bodySha256: string;
		diffPath: string;
		diffSha256: string;
		postImages: Record<string, { path: string; oid: string }>;
	};
	const sha256 = (text: string) =>
		createHash("sha256").update(text, "utf8").digest("hex");
	const readCorpus = (name: string) =>
		readFileSync(join(corpusDir, name), "utf8");
	const body = readCorpus(provenance.bodyPath);
	const diff = readCorpus(provenance.diffPath);
	const headFiles = new Map<string, string>();
	for (const [file, meta] of Object.entries(provenance.postImages)) {
		const source = readCorpus(meta.path);
		expect(gitBlobOid(source), `${file} fixture git blob oid`).toBe(meta.oid);
		headFiles.set(file, source);
	}

	it("pins the archived #3799 body and diff bytes", () => {
		expect(sha256(body)).toBe(provenance.bodySha256);
		expect(sha256(diff)).toBe(provenance.diffSha256);
	});

	it("refuses #3799's no-record sentence over the dispatcher's four branches", () => {
		const result = lintPrBody(body, { diff, headFiles });
		expect(result.valid).toBe(false);
		const refusal = result.errors.find((error) =>
			error.includes("clients/dispatch/dispatcher.ts"),
		);
		expect(refusal).toBeDefined();
		expect(refusal).toContain("decision branch");
		expect(refusal).toContain("(clients/dispatch/dispatcher.ts: 4)");
	});

	it("accepts an honest `none:` naming dispatcher.ts for the same diff", () => {
		const honest = body.replace(
			"No new failure path; no record added.",
			"none: dispatcher.ts keeps no new record kind for its coverage-notice decision yet",
		);
		const result = lintPrBody(honest, { diff, headFiles });
		expect(result.errors.join(" ")).not.toContain("decision branch");
		expect(result.valid).toBe(true);
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

describe("head-tree citations and test references", () => {
	const headFiles = new Map([
		[
			"clients/citation.ts",
			'export const value = "head source";\nexport const second = true;\n',
		],
		[
			"tests/citation.test.ts",
			'it("contains every label this repo\'s rules require to exist", () => {});\n',
		],
	]);
	const options = { headFiles };

	it("emits decoded string spans with quote kinds", () => {
		const result = blankCommentsAndStrings(
			`const single = 'a\\'b'; const double = "a\\\\b"; const template = \`value\`;`,
		);
		expect(result.strings.map(({ quote, text }) => ({ quote, text }))).toEqual([
			{ quote: "'", text: "a'b" },
			{ quote: '"', text: "a\\b" },
			{ quote: "`", text: "value" },
		]);
	});

	// Pins what `prefix` means (the up-to-256 blanked characters before the
	// opening quote, trailing blanks trimmed) so the lexer's single-pass
	// rewrite for #4088 cannot drift: `testCorpus` classifies `it(`/`.each(`
	// titles from exactly this text.
	it("reports each string's blanked 256-character prefix, trailing blanks trimmed", () => {
		const result = blankCommentsAndStrings(
			`it(/* note */ "first");\n${"a".repeat(300)}("second", 'third');`,
		);
		const [first, second, third] = result.strings.map(({ prefix }) => prefix);
		expect(first).toBe("it(");
		// 256 characters end at the blanked opening quote; the trim drops it.
		expect(second).toBe(`${"a".repeat(254)}(`);
		// "second" is blanked to eight spaces, then the comma; the two blanks
		// before the quote are trimmed.
		expect(third).toBe(`${"a".repeat(244)}(${" ".repeat(8)},`);
	});

	// Recurrence: #4088. The lexer sliced its growing output string once per
	// string literal; each slice flattened the whole concatenation and its
	// parent stayed alive through `prefix`, so memory grew with strings x
	// bytes (the PR-body corpus lexed 20 MB of tests into ~900 MB, and
	// check-pr-body.test.ts peaked at 1883 of 2048 MB on CI). Measured on 8000
	// string literals in a worker: 6-24 MB retained on the single-pass lexer,
	// 1533 MB on the quadratic one (an unflagged host kills it at the 128 MB
	// cap with ERR_WORKER_OUT_OF_MEMORY; the suite's own --max-old-space-size
	// lifts that cap, so the retained heap is asserted too).
	it("lexes thousands of string literals within a bounded heap", async () => {
		const lexerUrl = new URL("../../scripts/check-pr-body.mjs", import.meta.url)
			.href;
		const code = `
			const { parentPort, workerData } = require("node:worker_threads");
			import(workerData.lexerUrl).then(({ blankCommentsAndStrings }) => {
				const source = Array.from(
					{ length: 8000 },
					(_, index) => 'it("title ' + index + '", () => { expect(a).toBe(1); });',
				).join("\\n");
				const lexed = blankCommentsAndStrings(source);
				parentPort.postMessage({
					count: lexed.strings.length,
					heapMb: process.memoryUsage().heapUsed / 1048576,
				});
			});
		`;
		const result = await new Promise<{ count: number; heapMb: number }>(
			(resolvePromise, reject) => {
				const worker = new Worker(code, {
					eval: true,
					workerData: { lexerUrl },
					resourceLimits: { maxOldGenerationSizeMb: 128 },
				});
				worker.once("message", (value) => {
					resolvePromise(value);
					void worker.terminate();
				});
				worker.once("error", reject);
			},
		);
		expect(result.count).toBe(8000);
		expect(result.heapMb).toBeLessThan(256);
	});

	it("rejects a citation to a missing or out-of-range head file", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/missing.ts:1\`\n\nAlso: \`clients/citation.ts:4\``,
			options,
		);
		expect(result.errors.join(" ")).toContain("clients/missing.ts:1");
		expect(result.errors.join(" ")).toContain(
			"PR body citation clients/citation.ts:4 is outside the HEAD tree.",
		);
	});

	it("requires an adjacent quote to match source text within twenty lines", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/citation.ts:1\`\n\`\`\`text\nwrong source\n\`\`\``,
			options,
		);
		expect(result.errors.join(" ")).toContain("does not match HEAD source");
	});

	it("accepts a plain citation without a quote", () => {
		expect(
			lintPrBody(`${body}\nEvidence: \`clients/citation.ts:1\``, options),
		).toEqual({ valid: true, errors: [] });
	});

	it("accepts a citation in a table cell without a quote", () => {
		expect(
			lintPrBody(`${body}\n| Evidence | \`clients/citation.ts:1\` |`, options),
		).toEqual({ valid: true, errors: [] });
	});

	it("accepts range citations by their first line", () => {
		expect(
			lintPrBody(`${body}\nEvidence: \`clients/citation.ts:1-2\``, options),
		).toEqual({ valid: true, errors: [] });
	});

	it("rejects a backwards citation range with a malformed-range error", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/citation.ts:2-1\``,
			options,
		);
		expect(result).toEqual({
			valid: false,
			errors: [
				"PR body citation clients/citation.ts:2-1 has a malformed backwards range.",
			],
		});
	});

	it("accepts approximate-line citations by their hinted line", () => {
		expect(
			lintPrBody(`${body}\nEvidence: \`clients/citation.ts:~1\``, options),
		).toEqual({ valid: true, errors: [] });
	});

	it("pins the ±20 citation quote window", () => {
		const source = Array.from({ length: 40 }, (_, index) =>
			index === 20
				? "boundary source line"
				: index === 21
					? "outside source line"
					: `line ${index + 1}`,
		).join("\n");
		const localOptions = {
			headFiles: new Map([["clients/window.ts", source]]),
		};
		const accepted = lintPrBody(
			`${body}\nEvidence: \`clients/window.ts:1\`\n\`\`\`ts\nboundary source line\n\`\`\``,
			localOptions,
		);
		expect(accepted).toEqual({ valid: true, errors: [] });
		const rejected = lintPrBody(
			`${body}\nEvidence: \`clients/window.ts:1\`\n\`\`\`text\noutside source line\n\`\`\``,
			localOptions,
		);
		expect(rejected.errors.join(" ")).toContain("within ±20 lines");
	});

	it("pins both sides of the ±20 window and resolves range hints from the first line", () => {
		const source = Array.from({ length: 60 }, (_, index) =>
			index === 0 ? "first source line" : `line ${index + 1}`,
		).join("\n");
		const localOptions = {
			headFiles: new Map([["clients/window-both-sides.ts", source]]),
		};
		const accepted = lintPrBody(
			`${body}\nEvidence: \`clients/window-both-sides.ts:21-60\`\n\`\`\`ts\nfirst source line\n\`\`\``,
			localOptions,
		);
		expect(accepted).toEqual({ valid: true, errors: [] });
		const approximate = lintPrBody(
			`${body}\nEvidence: \`clients/window-both-sides.ts:~21\`\n\`\`\`ts\nfirst source line\n\`\`\``,
			localOptions,
		);
		expect(approximate).toEqual({ valid: true, errors: [] });
		const rejected = lintPrBody(
			`${body}\nEvidence: \`clients/window-both-sides.ts:22\`\n\`\`\`text\nfirst source line\n\`\`\``,
			localOptions,
		);
		expect(rejected.errors.join(" ")).toContain("within ±20 lines");
	});

	it("checks every repeated citation quote", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/citation.ts:1\`\n\`\`\`ts\nexport const value = "head source";\n\`\`\`\nAgain: \`clients/citation.ts:1\`\n\`\`\`ts\ntotally fabricated\n\`\`\``,
			options,
		);
		expect(result.errors.join(" ")).toContain("does not match HEAD source");
	});

	it("recognizes only real transcript quote shapes", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/citation.ts:1\`\n\`\`\`text\n$ npm test\nTests 1 passed (1)\n\`\`\``,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("does not treat incidental pass or fail words as transcripts", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/citation.ts:1\`\n\`\`\`text\nthis source failed a review\n\`\`\``,
			options,
		);
		expect(result.errors.join(" ")).toContain("does not match HEAD source");
	});

	it("does not treat an origin/master string in source as a transcript", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/citation.ts:1\`\n\`\`\`text\nconst branch = "origin/master";\n\`\`\``,
			options,
		);
		expect(result.errors.join(" ")).toContain("does not match HEAD source");
	});

	it("checks a transcript-looking quote unless its fence is tagged as output", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/citation.ts:1\`\n\`\`\`ts\n$ npm test\nnot source\n\`\`\``,
			options,
		);
		expect(result.errors.join(" ")).toContain("does not match HEAD source");
	});

	it("does not read preflight commands as test references", () => {
		const result = lintPrBody(
			`${body}\n| Gate | Command |\n| --- | --- |\n| typecheck | \`npx tsc --noEmit\` |\n| preflight | \`npm run preflight\` |`,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("rejects fabricated it titles and table identifiers", () => {
		// #3013: the identifier cell sits under a "Test" header because a
		// bare "Evidence" header no longer qualifies as a test column (its
		// "id" substring misclassified claim-matrix evidence cells).
		const result = lintPrBody(
			`${body}\nThe check uses it("fabricated test title").\n\n| Case | Test |\n| --- | --- |\n| A | \`fabricated table test identifier\` |`,
			options,
		);
		expect(result.errors.join(" ")).toContain("fabricated test title");
		expect(result.errors.join(" ")).toContain(
			"fabricated table test identifier",
		);
	});

	it("requires origin/master transcripts for master-red claims", () => {
		const result = lintPrBody(
			`${body}\nThis is pre-existing and red on master.`,
			options,
		);
		expect(result.errors.join(" ")).toContain("origin/master transcript");
	});

	it("accepts real test references and an origin/master transcript", () => {
		const result = lintPrBody(
			`${body}\nThe real title is it("contains every label this repo's rules require to exist").\n\n| Case | Test |\n| --- | --- |\n| A | \`contains every label this repo's rules require to exist\` |\n\nThis is pre-existing.\n\`\`\`text\n$ git log origin/master\n\`\`\``,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("requires the transcript in the next markdown block", () => {
		const result = lintPrBody(
			`${body}\nThis is pre-existing.\n\nUnrelated paragraph.\n\n\`\`\`text\nrun on origin/master\n\`\`\``,
			options,
		);
		expect(result.errors.join(" ")).toContain("origin/master transcript");
	});

	it("accepts a reviewer-attributed pre-existing statement", () => {
		const result = lintPrBody(
			`${body}\nThe reviewer wrote that the failure is pre-existing on the base branch.`,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("keeps dots inside code spans inside the sentence and table block", () => {
		const result = lintPrBody(
			`${body}\n| Convention | The pre-existing file is \`Fixture.Test.php\`. |`,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("ignores citations in fences and accepts the canonical it title in a table", () => {
		const result = lintPrBody(
			`${body}\n\`\`\`text\n\`clients/missing.ts:1\`\n\`\`\`\n\n| Case | Test |\n| --- | --- |\n| A | \`it("contains every label this repo's rules require to exist")\` |`,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("normalizes canonical it titles in table cells", () => {
		const result = lintPrBody(
			`${body}\n| Case | Test |\n| --- | --- |\n| A | \`it("fabricated table title")\` |`,
			options,
		);
		expect(result.errors.join(" ")).toContain("fabricated table title");
	});

	it("checks canonical it titles with trailing table-cell content", () => {
		const result = lintPrBody(
			`${body}\n| Case | Test |\n| --- | --- |\n| A | \`it("fabricated trailing title")\` (regression) |`,
			options,
		);
		expect(result.errors.join(" ")).toContain("fabricated trailing title");
	});

	it("checks canonical it titles in prose", () => {
		const result = lintPrBody(
			`${body}\nThe test is it("fabricated prose title").`,
			options,
		);
		expect(result.errors.join(" ")).toContain("fabricated prose title");
	});

	it("checks bare test titles in table cells", () => {
		const result = lintPrBody(
			`${body}\n| Case | Test |\n| --- | --- |\n| A | \`fabricated bare title\` |`,
			options,
		);
		expect(result.errors.join(" ")).toContain("fabricated bare title");
	});

	it("accepts a test path in a test column", () => {
		const result = lintPrBody(
			`${body}\n| Kind | Test id |\n| --- | --- |\n| path | \`tests/scripts/check-pr-body.test.ts\` |`,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("ignores non-test table cells", () => {
		const result = lintPrBody(
			`${body}\n| Command | Artifact |\n| --- | --- |\n| tool | \`python3 -m pip\` |`,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	// Prevent malformed pipe markup from hiding fabricated references by being
	// treated as a table without the separator that makes columns meaningful.
	it.each([
		["missing separator", "| Test |\n| |\n| `fabricated missing separator` |"],
		["empty separator", "| Test |\n| |\n| `fabricated empty separator` |"],
		[
			"malformed separator",
			"| Test |\n| -- |\n| `fabricated malformed separator` |",
		],
	])("rejects a fabricated title in a %s pipe block", (_name, table) => {
		const result = lintPrBody(`${body}\n${table}`, options);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			`PR body test reference is missing under tests/: ${table.match(/fabricated [^`]+/)?.[0]}`,
		);
	});

	it("accepts a master claim inside a valid table", () => {
		const result = lintPrBody(
			`${body}\n| Evidence | Status |\n| --- | --- |\n| pre-existing and red on master | verified |`,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("keeps valid tables column-aware with CRLF line endings", () => {
		const result = lintPrBody(
			`${body}\r\n| Command | Test | Notes |\r\n| --- | --- | --- |\r\n| \`fabricated command column\` | \`fabricated test column\` | \`fabricated notes column\` |\r\n| \`npm run build\` | \`fabricated build title\` | prose |`,
			options,
		);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"PR body test reference is missing under tests/: fabricated test column",
		);
		expect(result.errors).toContain(
			"PR body test reference is missing under tests/: fabricated build title",
		);
		expect(result.errors).not.toContain(
			"PR body test reference is missing under tests/: fabricated command column",
		);
		expect(result.errors).not.toContain(
			"PR body test reference is missing under tests/: fabricated notes column",
		);
	});

	it("ignores table header cells", () => {
		const result = lintPrBody(
			`${body}\n| \`fabricated header title\` | Test |\n| --- | --- |\n| Case | \`fabricated header value\` |`,
			options,
		);
		expect(result.errors.join(" ")).toContain("fabricated header value");
		expect(result.errors.join(" ")).not.toContain("fabricated header title");
	});

	it("rejects a command-shaped test cell without a real title", () => {
		const result = lintPrBody(
			`${body}\n| Test |\n| --- |\n| \`python3 -m pip\` |`,
			options,
		);
		expect(result.errors.join(" ")).toContain("python3 -m pip");
	});

	it("rejects a fabricated bare test title", () => {
		const result = lintPrBody(
			`${body}\n| Test |\n| --- |\n| \`fabricated bare title\` |`,
			options,
		);
		expect(result.errors.join(" ")).toContain("fabricated bare title");
	});

	it("ignores SHA cells in test columns", () => {
		const result = lintPrBody(
			`${body}\n| Test id |\n| --- |\n| \`deadbeef1234567890\` |`,
			options,
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it.each([["each template title"]])(
		"harvests each declaration titles",
		(_title) => {
			const result = lintPrBody(
				`${body}\n| Test |\n| --- |\n| \`ignores non-test table cells\` |`,
				options,
			);
			expect(result).toEqual({ valid: true, errors: [] });
		},
	);

	it("rejects a fabricated short table identifier", () => {
		const result = lintPrBody(
			`${body}\n| Case | Test |\n| --- | --- |\n| A | \`B01\` |`,
			options,
		);
		expect(result.errors.join(" ")).toContain("B01");
	});

	it("rejects missing one-digit short ids in a test column", () => {
		for (const id of ["F1", "V3"]) {
			const result = lintPrBody(
				`${body}\n| Case | Test |\n| --- | --- |\n| A | \`${id}\` |`,
				options,
			);
			expect(result.errors.join(" ")).toContain(id);
		}
	});

	it("harvests titles after regex literals without confusing division", () => {
		const fixtureCwd = mkdtempSync(join(tmpdir(), "pi-lens-lexer-"));
		try {
			mkdirSync(join(fixtureCwd, "tests"), { recursive: true });
			writeFileSync(
				join(fixtureCwd, "tests", "lexer.test.ts"),
				[
					'const pattern = /[:*?"<>|]/;',
					'it("title after regex literal", () => {});',
					"const returned = (() => { return /quoted/; })();",
					'it("title after regex in a call", () => {});',
					"const typed = typeof /typed/;",
					'it("title after typeof regex", () => {});',
					"const quotient = numerator / denominator;",
					'it("title after division", () => {});',
					'it.each([{ value: fn(1) }])("array each title", () => {});',
				].join("\n"),
			);
			const git = (args: string[]) =>
				args[0] === "ls-files" ? "tests/lexer.test.ts\n" : "";
			expect(
				lintPrBody(
					`${body}\n| Test |\n| --- |\n| \`title after regex literal\` |\n| \`title after regex in a call\` |\n| \`title after typeof regex\` |\n| \`title after division\` |\n| \`array each title\` |`,
					{ cwd: fixtureCwd, git },
				),
			).toEqual({ valid: true, errors: [] });
		} finally {
			rmSync(fixtureCwd, { recursive: true, force: true });
		}
	});

	// Prevent regex literals after expression-start tokens from laundering titles into the census.
	it("rejects titles found inside a regex after an arrow while keeping declarations", () => {
		const fixtureCwd = mkdtempSync(join(tmpdir(), "pi-lens-lexer-arrow-"));
		try {
			mkdirSync(join(fixtureCwd, "tests"), { recursive: true });
			writeFileSync(
				join(fixtureCwd, "tests", "lexer.test.ts"),
				'const factory = () => /it("fabricated from regex")/;\nit("genuine declaration", () => {});\n',
			);
			const git = (args: string[]) =>
				args[0] === "ls-files" ? "tests/lexer.test.ts\n" : "";
			const result = lintPrBody(
				`${body}\nThe tests are it("fabricated from regex") and it("genuine declaration").`,
				{ cwd: fixtureCwd, git },
			);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"PR body test reference is missing under tests/: fabricated from regex",
			);
			expect(result.errors).not.toContain(
				"PR body test reference is missing under tests/: genuine declaration",
			);
		} finally {
			rmSync(fixtureCwd, { recursive: true, force: true });
		}
	});

	// Prevent a mutable working-tree corpus from accepting titles removed after a warm lint.
	it("rebuilds the test corpus after a working-tree file changes", () => {
		const fixtureCwd = mkdtempSync(join(tmpdir(), "pi-lens-corpus-edit-"));
		try {
			mkdirSync(join(fixtureCwd, "tests"), { recursive: true });
			const file = join(fixtureCwd, "tests", "mutable.test.ts");
			writeFileSync(file, 'it("removed title", () => {});\n');
			const git = (args: string[]) =>
				args[0] === "ls-files" ? "tests/mutable.test.ts\n" : "";
			expect(
				lintPrBody(`${body}\nThe test is it("removed title").`, {
					cwd: fixtureCwd,
					git,
				}),
			).toEqual({ valid: true, errors: [] });
			writeFileSync(file, 'it("replacement title", () => {});\n');
			const result = lintPrBody(`${body}\nThe test is it("removed title").`, {
				cwd: fixtureCwd,
				git,
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"PR body test reference is missing under tests/: removed title",
			);
		} finally {
			rmSync(fixtureCwd, { recursive: true, force: true });
		}
	});

	it("reuses the HEAD-tree corpus at one immutable revision", () => {
		const fixtureCwd = mkdtempSync(join(tmpdir(), "pi-lens-corpus-head-"));
		try {
			mkdirSync(join(fixtureCwd, "tests"), { recursive: true });
			writeFileSync(
				join(fixtureCwd, "tests", "immutable.test.ts"),
				'it("immutable HEAD title", () => {});\n',
			);
			const calls: string[][] = [];
			const git = (args: string[]) => {
				calls.push(args);
				if (args[0] === "rev-parse") return "immutable-revision\n";
				return args[0] === "ls-files" ? "tests/immutable.test.ts\n" : "";
			};
			const candidate = `${body}\nThe test is it("immutable HEAD title").`;
			expect(lintPrBody(candidate, { cwd: fixtureCwd, git })).toEqual({
				valid: true,
				errors: [],
			});
			expect(lintPrBody(candidate, { cwd: fixtureCwd, git })).toEqual({
				valid: true,
				errors: [],
			});
			expect(calls.filter(([command]) => command === "ls-files")).toHaveLength(
				1,
			);
		} finally {
			rmSync(fixtureCwd, { recursive: true, force: true });
		}
	});

	it("accepts an injected corpus without rebuilding it", () => {
		const injected = {
			paths: new Set(["tests/injected.test.ts"]),
			titles: new Set(["injected title"]),
		};
		const result = lintPrBody(`${body}\nit("injected title")`, {
			testCorpus: injected,
			git: () => {
				throw new Error("corpus must not be rebuilt");
			},
		});
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("evicts the oldest HEAD-tree corpus beyond its bound", () => {
		const fixtureCwd = mkdtempSync(join(tmpdir(), "pi-lens-corpus-bound-"));
		try {
			mkdirSync(join(fixtureCwd, "tests"), { recursive: true });
			writeFileSync(
				join(fixtureCwd, "tests", "bounded.test.ts"),
				'it("bounded HEAD title", () => {});\n',
			);
			let revision = "revision-0";
			const listings: string[][] = [];
			const git = (args: string[]) => {
				if (args[0] === "rev-parse") return `${revision}\n`;
				if (args[0] === "ls-files") listings.push(args);
				return args[0] === "ls-files" ? "tests/bounded.test.ts\n" : "";
			};
			for (let index = 0; index < 9; index += 1) {
				revision = `revision-${index}`;
				expect(
					lintPrBody(`${body}\nit("bounded HEAD title")`, {
						cwd: fixtureCwd,
						git,
					}),
				).toEqual({ valid: true, errors: [] });
			}
			revision = "revision-0";
			expect(
				lintPrBody(`${body}\nit("bounded HEAD title")`, {
					cwd: fixtureCwd,
					git,
				}),
			).toEqual({
				valid: true,
				errors: [],
			});
			expect(listings).toHaveLength(10);
		} finally {
			rmSync(fixtureCwd, { recursive: true, force: true });
		}
	});

	it("harvests a title containing sixty backslashes", () => {
		const fixtureCwd = mkdtempSync(join(tmpdir(), "pi-lens-lexer-"));
		const title = `${"\\".repeat(60)} title`;
		try {
			mkdirSync(join(fixtureCwd, "tests"), { recursive: true });
			writeFileSync(
				join(fixtureCwd, "tests", "lexer.test.ts"),
				`it("${title.replaceAll("\\", "\\\\")}", () => {});\n`,
			);
			const git = (args: string[]) =>
				args[0] === "ls-files" ? "tests/lexer.test.ts\n" : "";
			const result = lintPrBody(
				`${body}\n| Test |\n| --- |\n| \`${title}\` |`,
				{ cwd: fixtureCwd, git },
			);
			expect(result).toEqual({ valid: true, errors: [] });
		} finally {
			rmSync(fixtureCwd, { recursive: true, force: true });
		}
	});

	it("includes every declaration title found by the test census", () => {
		const runGit = gitExecFileSync;
		const grep = runGit(
			["grep", "-nE", "\\b(it|test|describe)(\\.each)?\\s*\\(", "--", "tests/"],
			{ encoding: "utf8", maxBuffer: 20 * 1024 * 1024 } as never,
		);
		const titles = new Set<string>();
		for (const line of String(grep).split("\n")) {
			const match =
				/^\s*(?:it|test|describe)(?:\.each)?\s*\(\s*(["'`])((?:\\\\.|[^\\\\])*?)\1/.exec(
					line,
				);
			if (match?.[2]?.trim()) titles.add(match[2].trim());
		}
		const corpus = testCorpus();
		const missing = [...titles]
			.filter((title) => !/[`|\r\n]/.test(title))
			.filter((title) => {
				const quote = title.includes('"') ? "'" : '"';
				const escaped = title.replaceAll(quote, `\\${quote}`);
				return lintPrBody(`${body}\nit(${quote}${escaped}${quote})`, {
					testCorpus: corpus,
				}).errors.some((error) => error.includes(title));
			});
		expect(missing).toEqual([]);
	});

	it.each([
		[
			"#2877 round 3 reconstructed retracted section",
			"issue-2877-round-3.md",
			"P01",
		],
	])(
		"keeps the historical red-first fixture red: %s",
		(_name, file, expected) => {
			const fixture = readFileSync(
				join(repositoryRoot, "tests", "fixtures", "ci-pr-bodies", file),
				"utf8",
			);
			const result = lintPrBody(fixture);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(expected);
		},
	);
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

	it("includes untracked test files in local test references", () => {
		mkdirSync(join(fixtureCwd, "tests", "scripts"), { recursive: true });
		writeFileSync(
			join(fixtureCwd, "tests", "scripts", "new.test.ts"),
			'it("untracked working tree title", () => {});\n',
		);
		const result = lintPrBody(
			`${body}\n| Test |\n| --- |\n| \`untracked working tree title\` |`,
			{ cwd: fixtureCwd, workingTree: true },
		);
		expect(result).toEqual({ valid: true, errors: [] });
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
			{
				headFiles: postImageFromDiff(
					'diff --git a/clients/example.ts b/clients/example.ts\n+throw new Error("boom");',
				).headFiles,
			},
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

	it("matches CI close-keyword placement and rejects comma lists (#3681)", () => {
		const withTitle = `${body}\n\nCloses #3680, #3681.`;
		const result = lintLocalPrBody(withTitle, process.cwd(), () => "", {
			title: "fix: tooling (closes #3680)",
		});
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("comma-separated close list");
		const missing = lintLocalPrBody(body, process.cwd(), () => "", {
			title: "fix: tooling (closes #3680)",
		});
		expect(missing.valid).toBe(false);
		expect(missing.errors.join(" ")).toContain("#3680");
		expect(missing.errors.join(" ")).toContain("Alternatively, use refs #3680");
	});

	it("resolves path citations from --ref instead of the working tree (#3681)", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/ref.ts:1\`\n\`\`\`ts\nconst fromRef = true;\n\`\`\``,
			{
				ref: "release-ref",
				git: (args: string[], options?: { maxBuffer?: number }) => {
					expect(args).toEqual(["show", "release-ref:clients/ref.ts"]);
					expect(options?.maxBuffer).toBe(16 * 1024 * 1024);
					return "const fromRef = true;";
				},
			},
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("reports a bad --ref before trying to read its cited file (#3681)", () => {
		const result = lintPrBody(
			`${body}\nEvidence: \`clients/ref.ts:1\`\n\`\`\`ts\nconst ref = true;\n\`\`\``,
			{
				ref: "missing-ref",
				git: () => {
					throw new Error("bad ref");
				},
			},
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain(
			"revision missing-ref does not exist or is not a commit",
		);
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

// #3795 item 1. Recurrence: #3768's Round 3 body shipped with the shell-eaten
// inline code spans and npm-script / oxlint output pasted outside any fence.
// The structural lint passed those two garble symptoms; only the missing
// test references redded it. The fixture below is that body's Round 3 block
// (edit-2 of its userContentEdits, before the orchestrator rewrite).
describe("PR body garble from shell-expanded quotes (#3795)", () => {
	// The real block: emptied spans on the `fixed`/`Red proof` lines, then the
	// pasted `npm run lint` banner and oxlint command line, unfenced.
	const garbledRound3 = [
		"## Round 3",
		"",
		"- N1 fixed: skip-only exit 1 is now scoped to  and ; other smoke lanes retain exit 0.",
		"- Red proof, removing the gated option:  in .",
		"- Targeted tests: 23 passed; ",
		"> pi-lens@4.3.0 lint",
		"> tsc --project tsconfig.json && npm run lint:js && npm run lint:js:tests",
		"",
		"> pi-lens@4.3.0 lint:js",
		"> oxlint --deny-warnings --import-plugin -D block-scoped-var .",
	].join("\n");

	it("rejects the real Round 3 body's pasted npm banner and oxlint line", () => {
		const errors = lintPrBody(`${body}\n\n${garbledRound3}`).errors.join("\n");
		expect(errors).toContain("npm-script");
		expect(errors).toContain("oxlint");
	});

	it("rejects an emptied inline code span outside a fence", () => {
		const errors = lintPrBody(
			`${body}\n\nThe span \`\` lost its name.`,
		).errors.join("\n");
		expect(errors).toContain("empty inline code span");
	});

	it("accepts the same tool output inside a fenced block", () => {
		const fenced = `${body}\n\n## Round 3\n\n\`\`\`text\n> pi-lens@4.3.0 lint\n> oxlint --deny-warnings .\n\`\`\``;
		const errors = lintPrBody(fenced).errors.join("\n");
		expect(errors).not.toContain("npm-script");
		expect(errors).not.toContain("oxlint");
	});

	it("ignores tilde fences and four-space indented code", () => {
		const fenced = `${body}\n\n~~~text\n> pi-lens@4.3.0 lint\n> oxlint --deny-warnings .\n~~~`;
		const indented = `${body}\n\n    > pi-lens@4.3.0 lint\n    > oxlint --deny-warnings .`;
		expect(lintPrBody(fenced).errors.join("\n")).not.toContain("oxlint");
		expect(lintPrBody(indented).errors.join("\n")).not.toContain("oxlint");
	});

	it("ignores tab-indented code and a tilde line inside a backtick fence", () => {
		const tabbed = `${body}\n\n\t> pi-lens@4.3.0 lint`;
		// A `~~~` line does not close a ``` fence, so the banner stays fenced.
		const mixed = `${body}\n\n\`\`\`text\n~~~\n> pi-lens@4.3.0 lint\n\`\`\``;
		expect(lintPrBody(tabbed).errors.join("\n")).not.toContain("npm-script");
		expect(lintPrBody(mixed).errors.join("\n")).not.toContain("npm-script");
	});

	// Verify r3 regression: the indented-code rule landed in the helper that
	// the citation and test-reference lints share, so a fabricated citation in
	// a nested bullet passed. Those lints keep master's backtick-only fences.
	it("still validates citations and test references in nested bullets and tilde fences", () => {
		const headFiles = new Map([
			["clients/citation.ts", "export const a = 1;\n"],
		]);
		const nested = `${body}\n\n- Evidence:\n    - \`clients/missing.ts:1\` holds it.\n    - Pinned by \`tests/missing.test.ts\`.`;
		const tilde = `${body}\n\n~~~text\n\`clients/missing.ts:1\` holds it.\n~~~`;
		const missingCitation =
			"PR body citation clients/missing.ts:1 does not exist in the HEAD tree.";
		const nestedErrors = lintPrBody(nested, { headFiles }).errors;
		expect(nestedErrors).toContain(missingCitation);
		expect(nestedErrors).toContain(
			"PR body test reference is missing under tests/: tests/missing.test.ts",
		);
		expect(lintPrBody(tilde, { headFiles }).errors).toContain(missingCitation);
	});

	it("accepts a legitimate inline mention of the oxlint flag", () => {
		const errors = lintPrBody(
			`${body}\n\nThe \`oxlint --deny-warnings\` flag stays in the transcript.`,
		).errors.join("\n");
		expect(errors).not.toContain("outside a fenced block");
	});
});

describe("TLA+ coverage through the CI entry point (#3802 F3)", () => {
	// The diff touches a runtime file, so the Observability section must carry
	// the literal the runtime-observability lint accepts; the coverage rule is
	// then the only open question.
	const runtimeBody = body.replace(
		"The advisory check run is the record.",
		"No new failure path; no record added.",
	);
	// Recurrence: PR #3864 r1 wired `lintTlaCoverage` into `lintPullRequestEvent`
	// with no test through that entry; deleting the wire left 293 tests green,
	// because the existing coverage case drove only `lintLocalPrBody`.
	let previousCwd: string;
	let fixtureCwd: string;
	beforeEach(() => {
		previousCwd = process.cwd();
		fixtureCwd = createOriginMasterFixture("clients/read-guard.ts");
		process.chdir(fixtureCwd);
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		process.chdir(previousCwd);
		rmSync(fixtureCwd, { recursive: true, force: true });
	});

	it("fails a mapped change with no model move and no declaration", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await lintPullRequestEvent(fetchForEvent(runtimeBody, []), {
			pull_request: { number: 7, body: runtimeBody },
		});
		expect(result.valid).toBe(false);
		expect(errors.mock.calls.flat().join("\n")).toContain("formal/read-guard/");
	});

	it("passes the same diff once the body declares one listed family", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const declared = `${runtimeBody}\n\nTLA+ unaffected: read-guard — only a local helper moved.`;
		const result = await lintPullRequestEvent(fetchForEvent(declared, []), {
			pull_request: { number: 7, body: declared },
		});
		expect(errors.mock.calls.flat().join("\n")).not.toContain("formal/");
		expect(result).toMatchObject({ valid: true });
	});
});

// #3945 recovery: independent reviewer12 reconciled the audit to 27 survivors
// and 15 unsampled ranges (7 EQUIVALENT, 19 production-reachable caller gaps,
// 1 synthetic-only, 2 latent manual-range gaps). These witnesses call the real
// exported `lintPrBody` seam with compile-valid source-identity mutations; each
// block names the survivor `line`, `original`, and `replacement` it reds. The
// seven equivalents (ids 4, 7, 8, 10, 11, 40, 49) and the synthetic-only id 2
// keep their recorded disposition and get no manufactured test.
describe("post-image mutation witnesses (#3945 survivors)", () => {
	const withObservability = (text: string) =>
		body.replace("The advisory check run is the record.", text);

	// ids 36/37 (line 533, `\breturn\s+null\b`): the failure-path scan must
	// match a one-space and a two-space `return null`. A missed failure path
	// turns the honest sentence into a false clean.
	it("refuses the honest sentence for an added one-space `return null` failure path (#3945 id 37)", () => {
		const added = "\treturn null;";
		const diff = [
			"diff --git a/clients/failure.ts b/clients/failure.ts",
			"@@ -0,0 +1 @@",
			`+${added}`,
		].join("\n");
		const result = lintPrBody(
			withObservability("No new failure path; no record added."),
			{ diff, headFiles: new Map([["clients/failure.ts", added]]) },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("failure path");
	});

	it("refuses the honest sentence for an added two-space `return  null` failure path (#3945 id 36)", () => {
		const added = "\treturn  null;";
		const diff = [
			"diff --git a/clients/failure.ts b/clients/failure.ts",
			"@@ -0,0 +1 @@",
			`+${added}`,
		].join("\n");
		const result = lintPrBody(
			withObservability("No new failure path; no record added."),
			{ diff, headFiles: new Map([["clients/failure.ts", added]]) },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("failure path");
	});

	// id 6 (line 430, `/^rename to (.+)$/`): the `rename to` scan must stay
	// anchored. A `+++` header path that contains the words is a header, not a
	// rename directive; an unanchored match rewrites the post path and the
	// harvest reads the wrong file (indeterminate).
	it("keeps a `+++` header path containing `rename to` as the diff header path (#3945 id 6)", () => {
		const diff = [
			"diff --git a/clients/widget.ts b/clients/widget.ts",
			"--- a/clients/widget.ts",
			"+++ b/clients/rename to moved.ts",
			"@@ -0,0 +1 @@",
			'+recordDegradationOnce({ kind: "keep-kind" });',
		].join("\n");
		expect(
			lintPrBody(withObservability("The record is keep-kind."), {
				diff,
				headFiles: new Map([
					[
						"clients/widget.ts",
						'recordDegradationOnce({ kind: "keep-kind" });',
					],
				]),
			}),
		).toEqual({ valid: true, errors: [] });
	});

	// id 12 (line 436, `/^index ([0-9a-f]+)\.\.([0-9a-f]+)/`): an
	// `index ab..cd` token inside a `+++` path is not the post-image blob. The
	// mutant reads the wrong identity; the real working tree is the source here,
	// so no fabricated `headFiles` can mask the divergence.
	it("does not read an `index ab..cd` token inside a `+++` path as the post blob (#3945 id 12)", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-index-token-"));
		try {
			const added = 'recordDegradationOnce({ kind: "index-kind" });';
			mkdirSync(join(root, "clients"), { recursive: true });
			writeFileSync(join(root, "clients", "widget.ts"), added);
			const diff = [
				"diff --git a/clients/widget.ts b/clients/widget.ts",
				"--- a/clients/widget.ts",
				"+++ b/clients/widget.ts index ab..cd",
				"@@ -0,0 +1 @@",
				`+${added}`,
			].join("\n");
			expect(
				lintPrBody(withObservability("The record is index-kind."), {
					diff,
					cwd: root,
					workingTree: true,
				}),
			).toEqual({ valid: true, errors: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// id 20 (line 442, `/^@@ -\d+.../`): an added code line whose content
	// begins with `@@` is content, not a hunk header, so its record is harvested.
	it("harvests an added code line whose content begins with `@@` (#3945 id 20)", () => {
		const source = [
			"@@ -1 +1 @@",
			'recordDegradationOnce({ kind: "hunk-kind" });',
		].join("\n");
		const diff = [
			"diff --git a/clients/hunk.ts b/clients/hunk.ts",
			"@@ -0,0 +1,2 @@",
			"+@@ -1 +1 @@",
			'+recordDegradationOnce({ kind: "hunk-kind" });',
		].join("\n");
		expect(
			lintPrBody(withObservability("The record is hunk-kind."), {
				diff,
				headFiles: new Map([["clients/hunk.ts", source]]),
			}),
		).toEqual({ valid: true, errors: [] });
	});

	// id 24 (line 442, `-\d+(?:,\d+)?`): a two-digit old-hunk count followed
	// by a second hunk must still reset the POST cursor.
	it("maps a two-digit old-hunk count in a second hunk (#3945 id 24)", () => {
		const rows = [
			'recordDegradationOnce({ kind: "first-kind" });',
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			'recordDegradationOnce({ kind: "second-kind" });',
		];
		const diff = [
			"diff --git a/clients/two.ts b/clients/two.ts",
			"@@ -1,1 +1,1 @@",
			'+recordDegradationOnce({ kind: "first-kind" });',
			"@@ -10,20 +10,2 @@",
			'+recordDegradationOnce({ kind: "second-kind" });',
		].join("\n");
		expect(
			lintPrBody(withObservability("The record is first-kind."), {
				diff,
				headFiles: new Map([["clients/two.ts", rows.join("\n")]]),
			}),
		).toEqual({ valid: true, errors: [] });
	});

	// id 60 (line 726, `"utf8"`): a working-tree-only read must be decoded to
	// a string, or a small post-image with no `headFiles` declines.
	it("classifies a small working-tree post-image with no headFiles (#3945 id 60)", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-worktree-small-"));
		try {
			const added = '\trecordDegradationOnce({ kind: "small-kind" });';
			mkdirSync(join(root, "clients"), { recursive: true });
			writeFileSync(join(root, "clients", "small.ts"), `${added}\n`);
			const diff = [
				"diff --git a/clients/small.ts b/clients/small.ts",
				"@@ -0,0 +1 @@",
				`+${added}`,
			].join("\n");
			expect(
				lintPrBody(withObservability("The record is small-kind."), {
					diff,
					cwd: root,
					workingTree: true,
				}),
			).toEqual({ valid: true, errors: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// id 58 (line 725, `>` -> `>=`) and manual range 39-41 (`MAX_SOURCE_BYTES`):
	// a working-tree post-image of exactly the ceiling is classified; only a
	// strictly larger one declines.
	it("classifies a working-tree post-image of exactly MAX_SOURCE_BYTES (#3945 id 58, range 39-41)", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-boundary-"));
		const ceiling = 16 * 1024 * 1024;
		try {
			const added = '\trecordDegradationOnce({ kind: "boundary-kind" });';
			mkdirSync(join(root, "clients"), { recursive: true });
			const head = `${added}\n`;
			const padding = ceiling - Buffer.byteLength(head, "utf8");
			const path = join(root, "clients", "boundary.ts");
			writeFileSync(path, `${head}${"x".repeat(padding)}`);
			expect(statSync(path).size).toBe(ceiling);
			const diff = [
				"diff --git a/clients/boundary.ts b/clients/boundary.ts",
				"@@ -0,0 +1 @@",
				`+${added}`,
			].join("\n");
			expect(
				lintPrBody(withObservability("The record is boundary-kind."), {
					diff,
					cwd: root,
					workingTree: true,
				}),
			).toEqual({ valid: true, errors: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// manual range 383-413 (`gitHeaderPaths` pre/post split): a runtime file
	// renamed AWAY to a non-runtime path must stay in the population through its
	// pre path, or a real failure path becomes a false clean.
	it("keeps a runtime file renamed away to a non-runtime path in the population (#3945 range 383-413)", () => {
		const diff = [
			"diff --git a/clients/moved.ts b/docs/moved.md",
			"similarity index 80%",
			"rename from clients/moved.ts",
			"rename to docs/moved.md",
			"@@ -0,0 +1 @@",
			"+\treturn null;",
		].join("\n");
		const result = lintPrBody(
			withObservability("No new failure path; no record added."),
			{ diff, headFiles: new Map([["docs/moved.md", "\treturn null;"]]) },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("failure path");
	});

	// ids 64, 66, 67, 68, 69, 70, 71, 72, 73, 76 (lines 1365-1373): the
	// indeterminate refusal renders the `file:line` location, the first five
	// entries, its overflow count, the `-` difference, and the `, ` separator.
	it("renders one mismatched post-image line as `file:line` (#3945 ids 66, 67, 69, 73)", () => {
		const diff = [
			"diff --git a/clients/render.ts b/clients/render.ts",
			"@@ -1,0 +2 @@",
			'+recordDegradationOnce({ kind: "render-kind" });',
		].join("\n");
		const result = lintPrBody(withObservability("The record is render-kind."), {
			diff,
			headFiles: new Map([
				["clients/render.ts", "export const a = 1;\nexport const b = 2;"],
			]),
		});
		expect(result.errors).toEqual([
			"PR body Observability could not classify the added lines of clients/render.ts:2: the post-image is missing, could not be read, or does not match the diff, so a record or a decision branch cannot be confirmed. Re-run with the changed files present, or name the record on a line the diff adds.",
		]);
	});

	it("renders the first five indeterminate files and the overflow count (#3945 ids 64, 68, 70, 71, 72, 76)", () => {
		const files = [1, 2, 3, 4, 5, 6].map((n) => `clients/render-${n}.ts`);
		const diff = files
			.map(
				(file) =>
					`diff --git a/${file} b/${file}\n@@ -0,0 +1 @@\n+recordDegradationOnce({ kind: "render-${file}" });`,
			)
			.join("\n");
		const headFiles = new Map(
			files.map((file) => [file, "export const mismatch = 0;"]),
		);
		const result = lintPrBody(
			withObservability("No new failure path; no record added."),
			{ diff, headFiles },
		);
		const shown = files
			.slice(0, 5)
			.map((file) => `${file}:1`)
			.join(", ");
		expect(result.errors).toEqual([
			`PR body Observability could not classify the added lines of ${shown} (+1 more): the post-image is missing, could not be read, or does not match the diff, so a record or a decision branch cannot be confirmed. Re-run with the changed files present, or name the record on a line the diff adds.`,
		]);
	});

	// id 77 (line 1400, `??` -> `&&`): `lintPullRequestEvent` calls `lintPrBody`
	// with no `cwd`, so the existing-record read must default to `process.cwd()`.
	it("resolves an existing-record citation when cwd is omitted (#3945 id 77)", () => {
		const previousCwd = process.cwd();
		const root = mkdtempSync(join(tmpdir(), "pi-lens-pr-body-ci-cwd-"));
		try {
			const source = 'recordDegradationOnce({ kind: "tool-cwd-resolution" });';
			mkdirSync(join(root, "clients"), { recursive: true });
			writeFileSync(join(root, "clients", "existing-record.ts"), `${source}\n`);
			process.chdir(root);
			const result = lintPrBody(
				withObservability(
					"covered by existing record `tool-cwd-resolution` at `clients/existing-record.ts:1`",
				),
				{
					diff: NEW_PATH_RUNTIME_DIFF,
					headFiles: NEW_PATH_HEAD_FILES,
					workingTree: true,
				},
			);
			expect(result).toEqual({ valid: true, errors: [] });
		} finally {
			process.chdir(previousCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// #3085 gap 1. Recurrence: #3033 (#3043) edited workflow steps no pull request
// executed, and AGENTS.md's one-sentence `gh workflow run` rule was the only
// cover. The rule is only real if BOTH CI's entry (`lintPullRequestEvent`) and
// the local preflight (`lintLocalPrBody`) refuse a no-PR-trigger workflow edit
// that quotes no run id; deleting either wire must red here.
describe("workflow edits with no pull request run (#3085 gap 1)", () => {
	const WORKFLOW = ".github/workflows/stryker-nightly.yml";
	const NIGHTLY = [
		"name: nightly",
		"on:",
		"  schedule:",
		"    - cron: '0 3 * * *'",
		"  workflow_dispatch:",
		"jobs:",
		"  a:",
		"    runs-on: ubuntu-latest",
		"",
	].join("\n");
	const runBody = `${body}\n\n\`\`\`text\n$ gh workflow run stryker-nightly.yml --ref test/x\nhttps://github.com/o/r/actions/runs/12345678901\n\`\`\``;
	let previousCwd: string;
	let fixtureCwd: string;
	beforeEach(() => {
		previousCwd = process.cwd();
		fixtureCwd = createOriginMasterFixture(WORKFLOW);
		writeFileSync(join(fixtureCwd, WORKFLOW), NIGHTLY);
		process.chdir(fixtureCwd);
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		process.chdir(previousCwd);
		rmSync(fixtureCwd, { recursive: true, force: true });
	});

	it("fails CI's entry on a schedule-only workflow edit with no quoted run", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await lintPullRequestEvent(fetchForEvent(body, []), {
			pull_request: { number: 7, body },
		});
		expect(result.valid).toBe(false);
		expect(errors.mock.calls.flat().join("\n")).toContain(
			`Changed workflow ${WORKFLOW} has no pull request run of its edit`,
		);
	});

	it("passes CI's entry once the body quotes the branch run with its id", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await lintPullRequestEvent(fetchForEvent(runBody, []), {
			pull_request: { number: 7, body: runBody },
		});
		expect(errors.mock.calls.flat().join("\n")).not.toContain(
			"Changed workflow",
		);
		expect(result).toMatchObject({ valid: true });
	});

	it("fails the local preflight the same way and passes with the run id", () => {
		const bare = lintLocalPrBody(body, fixtureCwd);
		expect(bare.valid).toBe(false);
		expect(bare.errors.join("\n")).toContain(`Changed workflow ${WORKFLOW}`);
		expect(
			lintLocalPrBody(runBody, fixtureCwd).errors.join("\n"),
		).not.toContain("Changed workflow");
	});

	it("does not ask for a run when the edited workflow has a pull_request trigger", () => {
		writeFileSync(
			join(fixtureCwd, WORKFLOW),
			NIGHTLY.replace("  workflow_dispatch:", "  pull_request:"),
		);
		expect(lintLocalPrBody(body, fixtureCwd).errors.join("\n")).not.toContain(
			"Changed workflow",
		);
	});

	it("fails closed, naming the file, when the post-image cannot be read", () => {
		rmSync(join(fixtureCwd, WORKFLOW));
		mkdirSync(join(fixtureCwd, WORKFLOW));
		expect(lintLocalPrBody(body, fixtureCwd).errors.join("\n")).toContain(
			`Changed workflow ${WORKFLOW} could not be read`,
		);
	});
});

// #3085 round 2. Recurrence: round 1 accepted any prose after
// `Workflow run unaffected: <file> —`, so an executable-step edit cleared the
// rule. Through the real merge-base read (`git merge-base` and `git show` in
// `lintWorkflowRunEvidence`) the declaration now clears only a comment-only
// edit or a workflow with no workflow_dispatch trigger.
describe("Workflow run unaffected declaration is verified (#3085 round 2)", () => {
	const WORKFLOW = ".github/workflows/stryker-nightly.yml";
	const rows = (extra: string[] = [], dispatch = true) => [
		"name: nightly",
		"on:",
		"  schedule:",
		'    - cron: "0 3 * * *"',
		...(dispatch ? ["  workflow_dispatch:"] : ["  push:"]),
		"jobs:",
		"  a:",
		"    runs-on: ubuntu-latest",
		...extra,
	];
	const declared = `${body}\n\nWorkflow run unaffected: stryker-nightly.yml \u2014 only a comment moved.`;
	let fixtureCwd = "";
	const useFixture = (pre: string[], post: string[]) => {
		fixtureCwd = createOriginMasterFixture(undefined, {
			path: WORKFLOW,
			pre,
			post,
			dirty: post,
		});
	};
	afterEach(() => {
		rmSync(fixtureCwd, { recursive: true, force: true });
	});
	const errorsFor = (text: string) =>
		lintLocalPrBody(text, fixtureCwd).errors.join("\n");

	it("accepts the declaration for an edit of comments and blank lines only", () => {
		useFixture(rows(), ["# header comment", "", ...rows()]);
		expect(errorsFor(declared)).not.toContain("Changed workflow");
	});

	it("rejects the declaration when an executable step also changed, naming the evidence form", () => {
		useFixture(rows(), [
			"# header comment",
			...rows(["    steps:", "      - run: echo changed"]),
		]);
		const errors = errorsFor(declared);
		expect(errors).toContain('"Workflow run unaffected" line is not accepted');
		expect(errors).toContain(
			"gh workflow run stryker-nightly.yml --ref <branch>",
		);
	});

	// Recurrence: PR #4020 round 2 verify. An added `#!/bin/bash` line inside a
	// `run: |` body is shell payload; through the real merge-base read it must
	// not pass as a comment-only edit.
	it("rejects the declaration when the only change is a # line inside a run: | body", () => {
		const steps = (extra: string[]) => [
			"    steps:",
			"      - run: |",
			"          echo hi",
			...extra,
		];
		useFixture(rows(steps([])), rows(steps(["          #!/bin/bash"])));
		const errors = errorsFor(declared);
		expect(errors).toContain('"Workflow run unaffected" line is not accepted');
	});

	it("still accepts a quoted run id for the same executable edit", () => {
		useFixture(rows(), rows(["    steps:", "      - run: echo changed"]));
		const quoted = `${body}\n\n\`\`\`text\n$ gh workflow run stryker-nightly.yml --ref test/x\nhttps://github.com/o/r/actions/runs/12345678901\n\`\`\``;
		expect(errorsFor(quoted)).not.toContain("Changed workflow");
	});

	it("accepts the declaration for a workflow with no workflow_dispatch trigger", () => {
		useFixture(
			rows([], false),
			rows(["    steps:", "      - run: echo changed"], false),
		);
		expect(errorsFor(declared)).not.toContain("Changed workflow");
	});
});

// #4273 F6: the class-sweep rule is composed into `lintPullRequestEvent`, the
// CI entry point, not only `lintLocalPrBody`/`lintClassSweep`. Without a case
// through the event seam, deleting that wire leaves the suite green.
describe("class sweep reaches the CI event entry (#4273 F6)", () => {
	let previousCwd: string;
	let fixtureCwd: string;
	const classSweepBody = (name: string) =>
		readFileSync(
			join(repositoryRoot, "tests", "fixtures", "ci-pr-bodies", name),
			"utf8",
		);
	beforeEach(() => {
		previousCwd = process.cwd();
		fixtureCwd = createOriginMasterFixture();
		process.chdir(fixtureCwd);
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		process.chdir(previousCwd);
		rmSync(fixtureCwd, { recursive: true, force: true });
	});

	it("refuses the #4248 changed-file sweep on the live body", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const live = classSweepBody("pr-4248-body.md");
			await lintPullRequestEvent(fetchForEvent(live, []), {
				pull_request: { number: 4248, body: live },
			});
			expect(errors.mock.calls.flat().join("\n")).toContain('"## Class sweep"');
		} finally {
			errors.mockRestore();
		}
	});

	it("does not class-sweep-refuse the #4245 named shape, search, and verdict", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const live = classSweepBody("pr-4245-body.md");
			await lintPullRequestEvent(fetchForEvent(live, []), {
				pull_request: { number: 4245, body: live },
			});
			expect(errors.mock.calls.flat().join("\n")).not.toContain(
				'"## Class sweep"',
			);
		} finally {
			errors.mockRestore();
		}
	});
});

// #4288 (docs/pi-lens-merge-policy.md, "Detection retrospective on every
// merged bug fix"): a PR closing a bug-labelled issue names the layer that
// caught the bug, the layer that should have caught it, and the gap. The
// label read is best-effort, so an offline/unreadable label warns and skips.
describe("detection retrospective for bug-closing PRs (#4288)", () => {
	const withDetection = (lines: string) => `${body}\n\n## Detection\n${lines}`;
	const validDetection =
		"- **Caught by:** reviewer probe\n" +
		"- **Should have been caught by:** CI unit\n" +
		"- **Gap:** none: no existing test covered the shape";

	it("exports one layer vocabulary", () => {
		expect(DETECTION_LAYERS).toEqual([
			"external user",
			"reviewer probe",
			"CI unit",
			"governance sweep",
			"smoke",
			"nightly",
			"dogfood",
			"release gate",
		]);
	});

	it("keeps the merge policy pointing at the exported vocabulary", () => {
		// R4: the policy prose named a divergent list (`CI job`,
		// `install/compat/tool smoke`). It now points at DETECTION_LAYERS; this
		// pin fails if a copied list drifts back in.
		const doc = readFileSync(
			resolve(repositoryRoot, "docs/pi-lens-merge-policy.md"),
			"utf8",
		);
		expect(doc).toContain("DETECTION_LAYERS");
		for (const stale of ["CI job", "install/compat/tool smoke"])
			expect(doc).not.toContain(stale);
	});

	it("fails a bug-closing body without the section", () => {
		const result = lintPrBody(body, { bugClosing: true });
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('"## Detection"');
	});

	it("needs no section on a feature PR", () => {
		expect(lintPrBody(body)).toEqual({ valid: true, errors: [] });
	});

	it("accepts the valid three-line lesson with a reasoned none:", () => {
		expect(
			lintPrBody(withDetection(validDetection), { bugClosing: true }),
		).toEqual({ valid: true, errors: [] });
	});

	it("accepts this layer and an issue-reference gap", () => {
		expect(
			lintPrBody(
				withDetection(
					"- Caught by: smoke\n" +
						"- Should have been caught by: this layer\n" +
						"- Gap: #4288",
				),
				{ bugClosing: true },
			),
		).toEqual({ valid: true, errors: [] });
	});

	it("accepts an exists: test path", () => {
		expect(
			lintPrBody(
				withDetection(
					"- Caught by: nightly\n" +
						"- Should have been caught by: governance sweep\n" +
						"- Gap: exists: tests/scripts/check-pr-body.test.ts",
				),
				{ bugClosing: true },
			),
		).toEqual({ valid: true, errors: [] });
	});

	it("fails an unknown layer word", () => {
		const result = lintPrBody(
			withDetection(
				"- Caught by: maintainer\n" +
					"- Should have been caught by: CI unit\n" +
					"- Gap: #1",
			),
			{ bugClosing: true },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('"## Detection"');
	});

	it("does not count a fenced example", () => {
		const result = lintPrBody(
			withDetection(
				"```md\n" +
					"- Caught by: smoke\n" +
					"- Should have been caught by: CI unit\n" +
					"- Gap: #1\n" +
					"```",
			),
			{ bugClosing: true },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('"## Detection"');
	});

	it("does not count a tilde-fenced example", () => {
		const result = lintPrBody(
			withDetection(
				"~~~md\n" +
					"- Caught by: smoke\n" +
					"- Should have been caught by: CI unit\n" +
					"- Gap: #1\n" +
					"~~~",
			),
			{ bugClosing: true },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('"## Detection"');
	});

	it("does not count a four-space indented code block", () => {
		const result = lintPrBody(
			withDetection(
				"    - Caught by: smoke\n" +
					"    - Should have been caught by: CI unit\n" +
					"    - Gap: #1",
			),
			{ bugClosing: true },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('"## Detection"');
	});

	it("accepts a one-word none: reason", () => {
		expect(
			lintPrBody(
				withDetection(
					"- Caught by: smoke\n" +
						"- Should have been caught by: CI unit\n" +
						"- Gap: none: n/a",
				),
				{ bugClosing: true },
			),
		).toEqual({ valid: true, errors: [] });
	});

	it("accepts the Detection retrospective heading", () => {
		expect(
			lintPrBody(`${body}\n\n## Detection retrospective\n${validDetection}`, {
				bugClosing: true,
			}),
		).toEqual({ valid: true, errors: [] });
	});

	it("refuses a non-test exists: path", () => {
		expect(
			lintDetectionSection(
				"## Detection\n" +
					"- Caught by: smoke\n" +
					"- Should have been caught by: CI unit\n" +
					"- Gap: exists: TBD",
			),
		).toEqual([expect.stringContaining('"## Detection"')]);
	});

	it("refuses the template's optional hint as a bug-closing answer", () => {
		const template = readFileSync(
			resolve(repositoryRoot, ".github/PULL_REQUEST_TEMPLATE.md"),
			"utf8",
		);
		const hint = /## Detection\r?\n\r?\n([^#]*)/.exec(template)?.[1] ?? "";
		expect(hint.trim().length).toBeGreaterThan(0);
		const result = lintPrBody(`${body}\n\n## Detection\n${hint}`, {
			bugClosing: true,
		});
		expect(result.valid).toBe(false);
	});
});

describe("bug label resolution (#4288)", () => {
	const closed = "## Summary\nFixes #12 in the detector.\n";
	const labelFetch = (names: string[]) =>
		vi
			.fn()
			.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({ labels: names.map((name) => ({ name })) }),
						{ status: 200 },
					),
			);

	afterEach(() => vi.unstubAllEnvs());

	function stubApi() {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	}

	it("returns true when a closed issue carries the bug label", async () => {
		stubApi();
		expect(await resolveBugClosing(closed, labelFetch(["bug"]))).toBe(true);
	});

	it("returns false when no closed issue carries the bug label", async () => {
		stubApi();
		expect(await resolveBugClosing(closed, labelFetch(["enhancement"]))).toBe(
			false,
		);
	});

	it("returns false with no close keyword and never fetches", async () => {
		const fetchImpl = vi.fn();
		expect(await resolveBugClosing("## Summary\nRefs #12.\n", fetchImpl)).toBe(
			false,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("returns null when no API credentials are available", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		expect(await resolveBugClosing(closed, labelFetch(["bug"]))).toBe(null);
	});

	it("returns null on a failed label read", async () => {
		stubApi();
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("denied", { status: 500 }));
		expect(await resolveBugClosing(closed, fetchImpl)).toBe(null);
	});

	it("returns null on a malformed label body", async () => {
		stubApi();
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("not json", { status: 200 }));
		expect(await resolveBugClosing(closed, fetchImpl)).toBe(null);
	});
});

describe("detection reaches the CI event entry (#4288)", () => {
	const bugBody = `${body}\n\nCloses #4288.`;

	const eventFetch = (bug: boolean | "fail") =>
		vi.fn().mockImplementation(async (url: string) => {
			if (String(url).includes("/files"))
				return new Response(JSON.stringify([]), { status: 200 });
			if (String(url).includes("/issues/"))
				return bug === "fail"
					? new Response("denied", { status: 500 })
					: new Response(
							JSON.stringify({ labels: bug ? [{ name: "bug" }] : [] }),
							{ status: 200 },
						);
			return new Response(JSON.stringify({ body: bugBody }), {
				status: 200,
			});
		});

	beforeEach(() => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("requires Detection when the closed issue is bug-labelled", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// #4288 R1: the CI checkout is shallow, so `git diff origin/master...HEAD`
			// has no merge base and GITHUB_ACTIONS makes that fatal. The detection
			// wires are independent of git, so inject an empty diff and pin the CI
			// environment the unit-test job actually runs in.
			vi.stubEnv("GITHUB_ACTIONS", "true");
			const result = await lintPullRequestEvent(
				eventFetch(true),
				{ pull_request: { number: 4288, body: bugBody } },
				() => "",
			);
			expect(result.valid).toBe(false);
			expect(errors.mock.calls.flat().join("\n")).toContain('"## Detection"');
		} finally {
			errors.mockRestore();
		}
	});

	it("does not require Detection when the closed issue is not a bug", async () => {
		vi.stubEnv("GITHUB_ACTIONS", "true");
		const result = await lintPullRequestEvent(
			eventFetch(false),
			{ pull_request: { number: 4288, body: bugBody } },
			() => "",
		);
		expect(result).toEqual({ valid: true, repaired: false });
	});

	it("warns and skips Detection when the label read fails", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			vi.stubEnv("GITHUB_ACTIONS", "true");
			const result = await lintPullRequestEvent(
				eventFetch("fail"),
				{ pull_request: { number: 4288, body: bugBody } },
				() => "",
			);
			expect(result.valid).toBe(true);
			// R2: the skip must be a visible GitHub Actions annotation on the job
			// log, naming the reason and the issue, not a silent pass.
			expect(warning).toHaveBeenCalledWith(
				expect.stringMatching(/^::warning::.*## Detection.*#4288/s),
			);
		} finally {
			warning.mockRestore();
		}
	});
});

describe("detection on the local preflight (#4288)", () => {
	it("requires the section for a resolved bug", () => {
		const result = lintLocalPrBody(body, process.cwd(), () => "", {
			bugClosing: true,
		});
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('"## Detection"');
	});

	it("warns rather than requiring when the label cannot be read", () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = lintLocalPrBody(
				`${body}\n\nCloses #4288.`,
				process.cwd(),
				() => "",
			);
			expect(result.valid).toBe(true);
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("#4288"));
		} finally {
			warning.mockRestore();
		}
	});
});
