import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	lintPrBody,
	lintLocalPrBody,
	lintPullRequestEvent,
	testCorpus,
} from "../../scripts/check-pr-body.mjs";

const fixture = (pr: number, kind: string) =>
	readFileSync(
		new URL(`../fixtures/pr-body-compliance/${pr}.${kind}`, import.meta.url),
		"utf8",
	);
const corpus = testCorpus({ workingTree: true });
const errors = (body: string, diff: string, headFiles?: Map<string, string>) =>
	lintPrBody(body, {
		diff,
		headFiles,
		testCorpus: corpus,
		git: () => {
			throw new Error("uncaptured historical file");
		},
	}).errors.filter((row: string) => row.startsWith("PR body compliance"));
const image = (file: string, source: string) => ({
	diff: `diff --git a/${file} b/${file}\n@@ -0,0 +1,${source.split("\n").length} @@\n${source
		.split("\n")
		.map((row) => `+${row}`)
		.join("\n")}`,
	headFiles: new Map([[file, source]]),
});

afterEach(() => vi.unstubAllEnvs());

describe("diff-keyed compliance (#4585)", () => {
	it("requires each new test's red or reasoned control (#4577 row 1)", () => {
		expect(
			errors(
				fixture(4577, "body.txt"),
				fixture(4577, "diff"),
				new Map(Object.entries(JSON.parse(fixture(4577, "sources.json")))),
			).some((row) => row.includes("row 1")),
		).toBe(true);
	}, 30_000);
	it("requires a file-scoped mutation transcript (#4575 row 2)", () => {
		expect(
			errors(
				fixture(4575, "body.txt"),
				fixture(4575, "diff"),
				new Map(Object.entries(JSON.parse(fixture(4575, "sources.json")))),
			).some((row) => row.includes("row 2")),
		).toBe(true);
	});
	it("requires Windows evidence rather than a pending promise (#4566 row 4)", () => {
		expect(
			errors(
				fixture(4566, "body.txt"),
				fixture(4566, "diff"),
				new Map(Object.entries(JSON.parse(fixture(4566, "sources.json")))),
			).some((row) => row.includes("row 4")),
		).toBe(true);
	});
	it("accepts quoted red and named control, ignoring prose lookalikes", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			`it(\n"fails for stale bytes", () => {});\ntest.only("fresh control", () => {});\n// it("comment", () => {});`,
		);
		const body =
			"Control: `fresh control` in `tests/a.test.ts` — proves fresh bytes still pass.\n\n```text\nFAIL tests/a.test.ts > fails for stale bytes\nTests 1 failed\n```";
		expect(errors(body, diff, headFiles)).toEqual([]);
		expect(
			errors(
				body.replace(
					"Tests 1 failed",
					"Expected: <!-- literal\nTests 1 failed",
				),
				diff,
				headFiles,
			),
		).toEqual([]);
		expect(
			errors(`<!--\n${body}\n-->`, diff, headFiles).some((row) =>
				row.includes("row 1"),
			),
		).toBe(true);
		expect(
			errors(
				body.replace(/^Control:.*\n\n/, "").replace("```text", "```typescript"),
				diff,
				headFiles,
			).join(),
		).toContain("row 1");
		expect(
			errors(
				body
					.replace(/^Control:.*\n\n/, "")
					.replace("Tests 1 failed", "Tests 1 passed")
					.replace("FAIL", "PASS"),
				diff,
				headFiles,
			).join(),
		).toContain("row 1");
	});
	it("accepts a bare fence around a real transcript (#4585 bare fence)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("bare fence case", () => {});',
		);
		const body = [
			"```",
			" FAIL  |default| tests/a.test.ts > bare fence case",
			"AssertionError: expected true to be false",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("accepts a bare vitest failure list as the red (#4585 glyph red)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("glyph case", () => {});',
		);
		const body = [
			"```text",
			" FAIL  |default| tests/a.test.ts",
			" × glyph case 807ms",
			" × another known red 9ms",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("accepts a failing count whose titles sit outside the fence (#4585 count red)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("count case", () => {});',
		);
		const body = [
			"```text",
			" Test Files  1 failed (1)",
			"      Tests  1 failed | 2 passed (3)",
			" ❯ tests/a.test.ts > count case",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("keeps a later transcript below a literal opener inside a fence (#4585 fence opener)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("after opener case", () => {});',
		);
		const body = [
			"```text",
			"Expected: <!-- literal",
			"an earlier run with no red",
			"```",
			"",
			"```text",
			"FAIL tests/a.test.ts > after opener case",
			"Tests 1 failed",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("keeps evidence below an opener quoted in an inline code span (#4585 quoted opener)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("quoted opener case", () => {});',
		);
		const body = [
			"| shape | result |",
			"| --- | --- |",
			"| `<!-- a (no end, to EOF)` | blanked |",
			"",
			"```text",
			"FAIL tests/a.test.ts > quoted opener case",
			"Tests 1 failed",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("refuses hidden evidence and unreadable or mismatched post-images", () => {
		const { diff, headFiles } = image(
			"clients/path-utils.ts",
			"if (ready) return value;",
		);
		expect(
			errors(
				"<!-- Windows: cannot differ because pure text. -->",
				diff,
				headFiles,
			).join(),
		).toContain("row 4");
		expect(errors("", diff, new Map()).join()).toContain("post-image");
		expect(
			errors("", diff, new Map([["clients/path-utils.ts", "other"]])).join(),
		).toContain("post-image");
	});
	it("refuses a test opener whose post-image cannot be read (#4585 unknown title)", () => {
		const diff = [
			"diff --git a/tests/a.test.ts b/tests/a.test.ts",
			"@@ -0,0 +1,1 @@",
			'+it("unknown case", () => {});',
		].join("\n");
		expect(errors("", diff, new Map()).join()).toContain("post-image");
	});
	it("requires mutation file rows with red output and Windows reasons", () => {
		const { diff, headFiles } = image(
			"clients/path-utils.ts",
			'if (ready) return value;\n// if (ignored) {}\nconst prose = "catch filter";',
		);
		const body =
			"## Mutations\n| File | Mutation | Transcript |\n|---|---|---|\n| `clients/path-utils.ts` | remove ready guard | M1 |\n\n```text\nM1 clients/path-utils.ts\nFAIL tests/a.test.ts > broken guard\nTests 1 failed\n```\n\nWindows: cannot differ because this guard compares booleans without filesystem calls.";
		expect(errors(body, diff, headFiles)).toEqual([]);
		expect(
			errors(
				body.replaceAll("clients/path-utils.ts", "clients/other.ts"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
	});
	// #5026 r4 verify N4: both row readers split cells the way GitHub does.
	// Recurrence: a naive `split("|").slice(1, -1)` drops the last cell of a row
	// with no trailing pipe and splits at an escaped pipe, so a mutation row's
	// label went unread and a one-cell Controls row read as file plus reason.
	it("reads the label of a mutation row with no trailing pipe", () => {
		const { diff, headFiles } = image(
			"clients/path-utils.ts",
			"if (ready) return value;",
		);
		const body =
			"## Mutations\n| File | Mutation | Transcript |\n|---|---|---|\n| `clients/path-utils.ts` | remove ready guard | M1\n\n```text\nM1 clients/path-utils.ts\nFAIL tests/a.test.ts > broken guard\nTests 1 failed\n```\n\nWindows: cannot differ because this guard compares booleans without filesystem calls.";
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("reads Controls cells the way GitHub splits them", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'it("first case", () => {});',
		);
		const control = (row: string) =>
			errors(`| Control | Reason |\n|---|---|\n${row}`, diff, headFiles).join();
		// The reason is the last cell of a row with no trailing pipe.
		expect(control("| `tests/a.test.ts` | the case predates this diff")).toBe(
			"",
		);
		// An escaped pipe keeps one cell: no reason cell, so no control.
		expect(
			control("| `tests/a.test.ts` \\| the case predates this diff |"),
		).toContain("row 1");
	});
	it("finds aliases, indirect calls and titles reached through bindings", () => {
		for (const source of [
			'import { it as check } from "vitest"; check("alias case", () => {});',
			'(0, test)("indirect case", () => {});',
			'const check = it; const title = "bound case"; check(title, () => {});',
		]) {
			const { diff, headFiles } = image("tests/a.test.ts", source);
			expect(errors("", diff, headFiles).join()).toContain("row 1");
		}
	});
	it("accepts a Windows advisory read and refuses an empty reason", () => {
		const { diff, headFiles } = image(
			"clients/lsp/launch.ts",
			"const ready = true;",
		);
		expect(
			errors("Windows advisory lane run 123456789: passed.", diff, headFiles),
		).toEqual([]);
		expect(
			errors("Windows: cannot differ because", diff, headFiles).join(),
		).toContain("row 4");
	});
	it("ignores quoted branch words and regexp test calls (#4585 lexical control)", () => {
		const production = image(
			"clients/a.ts",
			'/* if (ready) catch {} */\nconst prose = "else throw";',
		);
		expect(errors("", production.diff, production.headFiles)).toEqual([]);
		const tests = image("tests/a.test.ts", '/pattern/.test("ordinary value");');
		expect(errors("", tests.diff, tests.headFiles)).toEqual([]);
	});
	it("finds each-table titles and refuses dynamic titles (#4585 title drift)", () => {
		for (const source of [
			'it.each([[1]])("table title", () => {});',
			"it(dynamicTitle(), () => {});",
		]) {
			const { diff, headFiles } = image("tests/a.test.ts", source);
			expect(errors("", diff, headFiles).join()).toContain("row 1");
		}
	});
	// A title the parser cannot resolve is refused by its own name, never by
	// printing `undefined` into the author's face (#4605 unresolved title).
	// A title the parser cannot resolve is refused by its own name, and a red
	// that happens to spell `undefined` does not fabricate a proof for it
	// (#4605 unresolved title).
	it("refuses a declaration whose file no red names (#4605 unresolved title)", () => {
		const { diff, headFiles } = image("tests/a.test.ts", "it.each(cases)();");
		expect(
			errors("```text\n× undefined thing 3ms\n```", diff, headFiles).join(),
		).toContain("tests/a.test.ts adds or edits test declarations");
	});
	it("does not use green mutation output or an unrelated red as proof", () => {
		const { diff, headFiles } = image(
			"clients/a.ts",
			"if (ready) return value;",
		);
		const body =
			"## Mutation proof\nclients/a.ts\n\n```text\nmutation: clients/a.ts\nexit code: 1\nfailed test titles: × broken guard\nRED\n```";
		expect(errors(body, diff, headFiles)).toEqual([]);
		expect(
			errors(
				body
					.replace("exit code: 1", "exit code: 0")
					.replace("failed test titles", "passed test titles"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
		expect(
			errors(
				body.replace("## Mutation proof", "## Red first"),
				diff,
				headFiles,
			),
		).toEqual([]);
		// The transcript names the file it proves, so a body quoting another
		// file's run owes this one's own evidence.
		expect(
			errors(
				body.replaceAll("clients/a.ts", "clients/b.ts"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
	});
	it("accepts prose-led mutation tables and inline quoted output (#4581 dry run)", () => {
		const { diff, headFiles } = image(
			"clients/a.ts",
			"if (ready) return value;",
		);
		const body =
			"Mutations, run against `clients/a.ts`:\n\n| Mutation | Result |\n|---|---|\n| drop ready | RED `AssertionError: expected true to be false`, `Tests 1 failed` |";
		expect(errors(body, diff, headFiles)).toEqual([]);
		expect(
			errors(
				"```text\nmutation: clients/a.ts\nexit code: 1\nfailed test titles: × ready guard\nRED\n```\n\nMutation table (transcript above):\n| File | Change |\n|---|---|\n| clients/a.ts | drop ready |",
				diff,
				headFiles,
			),
		).toEqual([]);
		expect(
			errors(
				body.replace(
					"`AssertionError: expected true to be false`, `Tests 1 failed`",
					"1 failed",
				),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
	});
	it("requires Windows evidence for a deletion-only launch diff (#4585 touch contract)", () => {
		const diff =
			"diff --git a/clients/lsp/launch.ts b/clients/lsp/launch.ts\n@@ -1 +0,0 @@\n-oldCall();";
		expect(errors("", diff, new Map()).join()).toContain("row 4");
		expect(
			errors(
				"Windows: cannot differ because the removed declaration never runs.",
				diff,
				new Map(),
			),
		).toEqual([]);
	});
	it("requires Windows evidence at other trySpawn callers (#4566 row 4 sweep)", () => {
		const { diff, headFiles } = image(
			"clients/other-launch.ts",
			"const child = trySpawn(command);",
		);
		expect(errors("", diff, headFiles).join()).toContain("row 4");
		expect(
			errors(
				"Windows: cannot differ because the command is only inspected as text.",
				diff,
				headFiles,
			),
		).toEqual([]);
		const prose = image("clients/other-launch.ts", "// trySpawn(command)");
		expect(errors("", prose.diff, prose.headFiles)).toEqual([]);
	});
	it("accepts one red naming the file whatever its title (#4584 dry run)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'it.each([["an empty report"]])("reds the step for %s ($5)", () => {});',
		);
		const body =
			"```text\nFAIL tests/a.test.ts > reds the step for an empty report ($5)\nTests 1 failed\n```";
		expect(errors(body, diff, headFiles)).toEqual([]);
		// Row 1 is file-level: the title is not read, so another title from the
		// same file is still that file's failure.
		expect(
			errors(
				body.replace("reds the step for", "other case for"),
				diff,
				headFiles,
			),
		).toEqual([]);
	});
	it("reads a local diff under the shared byte ceiling (#4585 large diff)", () => {
		const calls: Array<[string[], unknown]> = [];
		lintLocalPrBody(
			"## Why\nOne sentence.\n",
			process.cwd(),
			(args, options) => {
				calls.push([args, options]);
				return "";
			},
		);
		// The fixture corpus makes this PR's own diff larger than a default
		// spawn buffer, and a local preflight must read the same range as CI.
		expect(calls[0][1]).toMatchObject({ maxBuffer: 16 * 1024 * 1024 });
	});
	it("refuses an unavailable local diff (#4585 fail-closed preflight)", () => {
		const body =
			"## Why\nRequire evidence before review.\n## Notes for the reviewer\nNone.\n## Change outline\n- static fixture\n## Summary\nLocal preflight contract.\n## Tests\nNo runtime edits.\n## Test assessment\nNo test edits.\n## Blast radius\nNo runtime module touched.\n## Class sweep\nnone: static fixture contains no runtime change.\n## Observability\nNo new failure path; no record added.";
		const result = lintLocalPrBody(body, process.cwd(), (args) => {
			// The base ref resolves; only the range itself cannot be read.
			if (args[0] === "rev-parse") return "deadbeef";
			throw new Error("missing upstream ref");
		});
		expect(result.valid).toBe(false);
		expect(result.errors.join()).toContain(
			"PR body compliance: diff unavailable",
		);
	});
	it("refuses an unavailable event diff outside CI (#4585 fail-closed event)", async () => {
		vi.stubEnv("GITHUB_REPOSITORY", "fixture/repo");
		vi.stubEnv("GITHUB_ACTIONS", "");
		const fetchBoundary: typeof fetch = async (url) =>
			new Response(
				JSON.stringify(
					String(url).includes("/files?") ? [] : { body: "", title: "fixture" },
				),
			);
		await expect(
			lintPullRequestEvent(
				fetchBoundary,
				{ pull_request: { number: 1, body: "" } },
				() => {
					throw new Error("missing upstream ref");
				},
			),
		).rejects.toThrow("diff unavailable");
	});
	it("requires mutation proof for ternary fallbacks (#4575 guard-shape sweep)", () => {
		const { diff, headFiles } = image(
			"clients/a.ts",
			"const answer = ready ? value : fallback;",
		);
		expect(errors("", diff, headFiles).join()).toContain("row 2");
		const typeOnly = image(
			"clients/a.ts",
			"interface Value { ready?: boolean; }",
		);
		expect(errors("", typeOnly.diff, typeOnly.headFiles)).toEqual([]);
		// A catch block is a fallback even with no `if`, `?` or `&&` in the hunk.
		const catchOnly = image(
			"clients/a.ts",
			"try { run(); } catch (error) {\n\treturn null;\n}",
		);
		expect(errors("", catchOnly.diff, catchOnly.headFiles).join()).toContain(
			"row 2",
		);
	});
	it("requires mutation proof for a guard added to a shipped script (#4585 script row)", () => {
		const { diff, headFiles } = image(
			"scripts/sample.mjs",
			"if (ready) return value;",
		);
		expect(errors("", diff, headFiles).join()).toContain("row 2");
		expect(
			errors(
				"## Mutations\n| `scripts/sample.mjs` | drop ready | `Tests 1 failed` |",
				diff,
				headFiles,
			),
		).toEqual([]);
	});
	it("bounds the unclassifiable-post-image notice (#4585 notice bound)", () => {
		const files = [1, 2, 3, 4, 5, 6].map((n) => `clients/miss-${n}.ts`);
		const diff = files
			.map(
				(file) =>
					`diff --git a/${file} b/${file}\n@@ -0,0 +1 @@\n+if (ready) return value;`,
			)
			.join("\n");
		const notice = errors("", diff, new Map()).join();
		expect(notice).toContain("for 6 changed file(s)");
		expect(notice).toContain("clients/miss-5.ts (+1 more)");
	});
	it("leaves a test title the diff does not touch alone (#4585 unchanged title)", () => {
		const diff = [
			"diff --git a/tests/a.test.ts b/tests/a.test.ts",
			"@@ -1 +1,2 @@",
			' it("existing case", () => {});',
			"+// added comment",
		].join("\n");
		const headFiles = new Map([
			["tests/a.test.ts", 'it("existing case", () => {});\n// added comment'],
		]);
		expect(errors("", diff, headFiles)).toEqual([]);
	});

	// #4605 F1: one file, one red. A green row for this file, another file's
	// red, a path that merely starts the same, prose, and a "not run" fence all
	// leave row 2 unproved.
	it("refuses another file's red, a green row and a prose mutation line (#4605 row 2 binding)", () => {
		const { diff, headFiles } = image(
			"clients/a.ts",
			"if (ready) return value;",
		);
		expect(
			errors(
				[
					"## Mutations",
					"| File | Mutation | Verdict |",
					"|---|---|---|",
					"| `clients/a.ts` | drop ready guard | survived (green) |",
					"| `clients/b.ts` | drop other guard | RED `Tests 1 failed` |",
				].join("\n"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
		expect(
			errors(
				"## Mutations\n| `clients/a.ts.backup` | drop | RED `Tests 1 failed` |",
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
		expect(
			errors(
				"mutation: clients/a.ts — dropped the guard, `Tests 2 failed`",
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
		expect(
			errors(
				[
					"```text",
					"mutation: not run (tool unavailable)",
					"guard added in clients/a.ts",
					"FAIL tests/other.test.ts > unrelated",
					"Tests 1 failed",
					"```",
				].join("\n"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
		// A mutation fence that quotes no red at all proves nothing.
		expect(
			errors(
				[
					"```text",
					"mutation: clients/a.ts",
					"no failing run recorded",
					"```",
				].join("\n"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
		// A header that names the file but says the run never happened is not a
		// read: the mutation was proposed, not performed.
		expect(
			errors(
				[
					"```text",
					"mutation: clients/a.ts — not run (tool unavailable)",
					"Tests 1 failed",
					"```",
				].join("\n"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
	});

	// #4605 F2: the declaration chain is structure, not a modifier list, and a
	// row added to a table held in a local binding is a new case.
	it("finds runIf, skipIf and a row added to an external each source (#4605 row 1 discovery)", () => {
		const modifiers = image(
			"tests/a.test.ts",
			'it.runIf(true)("runIf case", () => {});\ntest.skipIf(false)("skipIf case", () => {});',
		);
		expect(errors("", modifiers.diff, modifiers.headFiles).join()).toContain(
			"tests/a.test.ts adds or edits test declarations",
		);
		// A namespace import declares a test through `v.test(...)`; the binding
		// comes from the import, not from the callee's spelling (Greptile P1).
		const namespaced = image(
			"tests/b.test.ts",
			'import * as v from "vitest";\nv.test("namespace case", () => {});',
		);
		expect(errors("", namespaced.diff, namespaced.headFiles).join()).toContain(
			"tests/b.test.ts adds or edits test declarations",
		);
		const after = [
			"const cases = [",
			'  ["old case", 1],',
			'  ["new case", 2],',
			"];",
			'it.each(cases)("handles %s", () => {});',
		].join("\n");
		const diff = [
			"diff --git a/tests/a.test.ts b/tests/a.test.ts",
			"@@ -1,4 +1,5 @@",
			" const cases = [",
			'   ["old case", 1],',
			'+  ["new case", 2],',
			" ];",
			' it.each(cases)("handles %s", () => {});',
		].join("\n");
		const headFiles = new Map([["tests/a.test.ts", after]]);
		// A changed table row is not a changed declaration under the file-level
		// rule, and the file's own red still proves the file either way.
		expect(
			errors(
				"```text\nFAIL tests/a.test.ts > handles old case\nTests 1 failed\n```",
				diff,
				headFiles,
			),
		).toEqual([]);
		expect(
			errors(
				"```text\nFAIL tests/a.test.ts > handles new case\nTests 1 failed\n```",
				diff,
				headFiles,
			),
		).toEqual([]);
	});

	// #4605 F3: a failing line's own title is the only proof, and a Control's
	// backticked title must equal it.
	it("matches a failing line's own title, never a substring or a longer Control (#4605 row 1 exactness)", () => {
		const prefix = image("tests/a.test.ts", 'test("rejects input", () => {});');
		expect(
			errors(
				"```text\nFAIL tests/other.test.ts > rejects input with a warning\nTests 1 failed\n```",
				prefix.diff,
				prefix.headFiles,
			).join(),
		).toContain("row 1");
		const substring = image("tests/a.test.ts", 'test("empty", () => {});');
		expect(
			errors(
				"```text\n× the parser keeps an empty answer 3ms\n```",
				substring.diff,
				substring.headFiles,
			).join(),
		).toContain("row 1");
		const control = image("tests/a.test.ts", 'test("empty", () => {});');
		expect(
			errors(
				"Control: `the empty answer is kept` — an older case.",
				control.diff,
				control.headFiles,
			).join(),
		).toContain("row 1");
		// The same title in another file does not prove this file's declaration.
		const otherFile = image("tests/a.test.ts", 'test("same title", () => {});');
		expect(
			errors(
				"```text\nFAIL tests/other.test.ts > same title\nTests 1 failed\n```",
				otherFile.diff,
				otherFile.headFiles,
			).join(),
		).toContain("row 1");
	});

	// #4605 F4: a Windows read belongs to the file it names, and only a
	// terminal run conclusion is a read.
	it("keys Windows evidence per file and refuses a cancelled run (#4605 row 4 per file)", () => {
		const two = {
			diff: [
				"diff --git a/clients/lsp/launch.ts b/clients/lsp/launch.ts",
				"@@ -0,0 +1,1 @@",
				"+const a = 1;",
				"diff --git a/clients/path-utils.ts b/clients/path-utils.ts",
				"@@ -0,0 +1,1 @@",
				"+const b = 2;",
			].join("\n"),
			headFiles: new Map([
				["clients/lsp/launch.ts", "const a = 1;"],
				["clients/path-utils.ts", "const b = 2;"],
			]),
		};
		expect(
			errors(
				"Windows advisory lane run 123456789: passed.",
				two.diff,
				two.headFiles,
			).join(),
		).toContain("row 4");
		expect(
			errors(
				[
					"clients/lsp/launch.ts Windows advisory lane run 123456789: passed.",
					"clients/path-utils.ts Windows advisory lane run 123456789: passed.",
				].join("\n"),
				two.diff,
				two.headFiles,
			),
		).toEqual([]);
		const one = image("clients/lsp/launch.ts", "const a = 1;");
		expect(
			errors(
				"Windows advisory lane run 12345678: cancelled.",
				one.diff,
				one.headFiles,
			).join(),
		).toContain("row 4");
		// A line that names a terminal word inside a cancelled run is not a read.
		expect(
			errors(
				"Windows advisory lane run 12345678: cancelled after a failed attempt.",
				one.diff,
				one.headFiles,
			).join(),
		).toContain("row 4");
		// The reviewer contract names clients/safe-spawn.ts by path.
		const safeSpawn = image(
			"clients/safe-spawn.ts",
			"const child = spawnTarget(command);",
		);
		expect(errors("", safeSpawn.diff, safeSpawn.headFiles).join()).toContain(
			"clients/safe-spawn.ts",
		);
	});

	// #4605 F5: a tilde fence is a fence, and a quoted `<!--` hides nothing.
	it("reads a tilde fence and a quoted opener's later evidence (#4605 fences)", () => {
		const tilde = image("tests/a.test.ts", 'test("tilde case", () => {});');
		expect(
			errors(
				"~~~text\nFAIL tests/a.test.ts > tilde case\nTests 1 failed\n~~~",
				tilde.diff,
				tilde.headFiles,
			),
		).toEqual([]);
		// A tilde fence reads like any other fence: it proves only its own title
		// in its own file.
		expect(
			errors(
				"~~~text\nFAIL tests/other.test.ts > tilde case\nTests 1 failed\n~~~",
				tilde.diff,
				tilde.headFiles,
			).join(),
		).toContain("row 1");
		const opener = image("tests/a.test.ts", 'test("control case", () => {});');
		expect(
			errors(
				[
					"| shape | result |",
					"| --- | --- |",
					"| `<!--` | literal opener |",
					"",
					"Control: `control case` in `tests/a.test.ts` — proves the old path still passes.",
				].join("\n"),
				opener.diff,
				opener.headFiles,
			),
		).toEqual([]);
		const mutation = image("clients/a.ts", "if (ready) return value;");
		expect(
			errors(
				[
					"| shape | result |",
					"| --- | --- |",
					"| `<!--` | literal opener |",
					"",
					"## Mutations",
					"| `clients/a.ts` | drop ready | `Tests 1 failed` |",
				].join("\n"),
				mutation.diff,
				mutation.headFiles,
			),
		).toEqual([]);
		const windows = image("clients/lsp/launch.ts", "const a = 1;");
		expect(
			errors(
				"```text\nWindows advisory lane run 123456789: passed.\n```",
				windows.diff,
				windows.headFiles,
			),
		).toEqual([]);
	});

	// #4605 F8: a Windows row that names a path is evidence about that path, so
	// it cannot stand in for a generic read of the one seam file.
	it("refuses another file's Windows row as a generic read (#4605 row 4 naming)", () => {
		const two = {
			diff: [
				"diff --git a/clients/lsp/launch.ts b/clients/lsp/launch.ts",
				"@@ -0,0 +1,1 @@",
				"+const a = 1;",
				"diff --git a/tests/b.test.ts b/tests/b.test.ts",
				"@@ -0,0 +1,1 @@",
				"+const b = 2;",
			].join("\n"),
			headFiles: new Map([
				["clients/lsp/launch.ts", "const a = 1;"],
				["tests/b.test.ts", "const b = 2;"],
			]),
		};
		expect(
			errors(
				"`tests/b.test.ts` Windows: cannot differ because only strings change.",
				two.diff,
				two.headFiles,
			).join(),
		).toContain("row 4");
		// The reviewed plant: over a diff whose only seam file is the launch
		// path, a row naming another repository path the diff never touches is
		// still evidence about that path, not a generic read.
		const one = image("clients/lsp/launch.ts", "const a = 1;");
		expect(
			errors(
				"`clients/path-utils.ts` Windows: cannot differ because only string joins change.",
				one.diff,
				one.headFiles,
			).join(),
		).toContain("row 4");
		expect(
			errors(
				"Windows: cannot differ because only string joins change.",
				two.diff,
				two.headFiles,
			),
		).toEqual([]);
		// A run URL is a link to the evidence, not a path in this repository.
		expect(
			errors(
				"Windows advisory lane https://github.com/apmantza/pi-lens/actions/runs/123456789: passed.",
				two.diff,
				two.headFiles,
			),
		).toEqual([]);
		expect(
			errors(
				"clients/lsp/launch.ts Windows advisory lane run 123456789: passed.",
				two.diff,
				two.headFiles,
			),
		).toEqual([]);
	});

	// #4605 F4: a line the diff removes and adds again is a re-indent, not a new
	// declaration; a title it renames still owes its own red.
	it("does not owe a red for a re-indented declaration (#4605 reindent)", () => {
		const reindent = [
			"diff --git a/tests/a.test.ts b/tests/a.test.ts",
			"@@ -1,2 +1,2 @@",
			' describe("old", () => {',
			'-\tit("keeps the old title", () => {});',
			'+\t\tit("keeps the old title", () => {});',
			" });",
		].join("\n");
		expect(
			errors(
				"",
				reindent,
				new Map([
					[
						"tests/a.test.ts",
						'describe("old", () => {\n\t\tit("keeps the old title", () => {});\n});',
					],
				]),
			),
		).toEqual([]);
		const renamed = [
			"diff --git a/tests/a.test.ts b/tests/a.test.ts",
			"@@ -1,2 +1,2 @@",
			' describe("old", () => {',
			'-\tit("keeps the old title", () => {});',
			'+\tit("moved to another name", () => {});',
			" });",
		].join("\n");
		expect(
			errors(
				"",
				renamed,
				new Map([
					[
						"tests/a.test.ts",
						'describe("old", () => {\n\tit("moved to another name", () => {});\n});',
					],
				]),
			).join(),
		).toContain("tests/a.test.ts adds or edits test declarations");
	});

	// #4605 F5: a `mutation:` continuation that says the run did not happen
	// refuses the fence, exactly as the header does.
	it("refuses a mutation fence whose continuation says it did not run (#4605 not run)", () => {
		const { diff, headFiles } = image(
			"scripts/probe-a.mjs",
			"if (ready) return value;",
		);
		const fence = (lines: string[]) => ["```text", ...lines, "```"].join("\n");
		expect(
			errors(
				fence([
					"mutation: scripts/probe-a.mjs guard removed",
					"mutation: not run (tool unavailable)",
					"FAIL tests/a.test.ts > unrelated",
					"Tests 1 failed",
				]),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
		expect(
			errors(
				fence([
					"mutation: scripts/probe-a.mjs (guard -> gone)",
					"FAIL tests/a.test.ts > unrelated",
					"Tests 1 failed",
				]),
				diff,
				headFiles,
			),
		).toEqual([]);
	});

	// #4605 F6: a `trySpawn` caller owes row 4 for a deletion too, so the
	// post-image decides membership rather than the added lines.
	it("requires Windows evidence for a deletion-only trySpawn caller (#4605 deletion caller)", () => {
		const diff = [
			"diff --git a/clients/other-launch.ts b/clients/other-launch.ts",
			"@@ -1,2 +1,1 @@",
			" const child = trySpawn(command);",
			"-const gone = true;",
		].join("\n");
		const headFiles = new Map([
			["clients/other-launch.ts", "const child = trySpawn(command);"],
		]);
		expect(errors("", diff, headFiles).join()).toContain("row 4");
		expect(
			errors(
				"`clients/other-launch.ts` Windows: cannot differ because the command is only inspected as text.",
				diff,
				headFiles,
			),
		).toEqual([]);
		// An unreadable post-image cannot say whether it calls trySpawn, so it is
		// refused as unclassified rather than passed.
		expect(errors("", diff, new Map()).join()).toContain("cannot classify");
	});

	// #4605 V2: a whole-file deletion has no post-image, so it owes no row. The
	// diff states the state explicitly; it is not an unreadable post-image.
	it("owes no row for a whole-file deletion (#4605 deleted file)", () => {
		const production = [
			"diff --git a/clients/obsolete.ts b/clients/obsolete.ts",
			"deleted file mode 100644",
			"index 1234567..0000000",
			"--- a/clients/obsolete.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-export const child = trySpawn(command);",
			"-export const gone = true;",
		].join("\n");
		expect(errors("", production, new Map())).toEqual([]);
		const tests = [
			"diff --git a/tests/obsolete.test.ts b/tests/obsolete.test.ts",
			"deleted file mode 100644",
			"--- a/tests/obsolete.test.ts",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			'-it("gone", () => {});',
		].join("\n");
		expect(errors("", tests, new Map())).toEqual([]);
	});

	// #4605 V3: a removal credits one addition, so a move is free and an extra
	// copy of the same opener is new content.
	it("counts a removal once for each added copy (#4605 duplicate opener)", () => {
		const copy = [
			"diff --git a/tests/a.test.ts b/tests/a.test.ts",
			"@@ -1,3 +1,6 @@",
			' describe("old", () => {',
			'-\tit("keeps the bytes", () => {});',
			'+\tit("keeps the bytes", () => {});',
			" });",
			'+describe("copy", () => {',
			'+\tit("keeps the bytes", () => {});',
			"+});",
		].join("\n");
		const copied = new Map([
			[
				"tests/a.test.ts",
				[
					'describe("old", () => {',
					'\tit("keeps the bytes", () => {});',
					"});",
					'describe("copy", () => {',
					'\tit("keeps the bytes", () => {});',
					"});",
				].join("\n"),
			],
		]);
		expect(errors("", copy, copied).join()).toContain(
			"tests/a.test.ts adds or edits test declarations",
		);
		const move = [
			"diff --git a/tests/b.test.ts b/tests/b.test.ts",
			"@@ -1,3 +1,5 @@",
			' describe("old", () => {',
			'-\tit("keeps the bytes", () => {});',
			" });",
			'+describe("copy", () => {',
			'+\tit("keeps the bytes", () => {});',
			"+});",
		].join("\n");
		const moved = new Map([
			[
				"tests/b.test.ts",
				[
					'describe("old", () => {',
					"});",
					'describe("copy", () => {',
					'\tit("keeps the bytes", () => {});',
					"});",
				].join("\n"),
			],
		]);
		expect(errors("", move, moved)).toEqual([]);
	});

	// #4605 V4: a `mutation:` record proves only when it states the run's own
	// result. No list of `did not run` spellings; the default is inverted.
	it("refuses a mutation fence that states no result (#4605 not run)", () => {
		const { diff, headFiles } = image(
			"scripts/probe-a.mjs",
			"if (ready) return value;",
		);
		const fence = (lines: string[]) => ["```text", ...lines, "```"].join("\n");
		for (const continuation of [
			"mutation: unable to run",
			"mutation: n/a - the harness could not be run",
			"mutation: did not execute",
		]) {
			expect(
				errors(
					fence([
						"mutation: scripts/probe-a.mjs (guard -> gone)",
						continuation,
						"FAIL tests/a.test.ts > unrelated",
						"Tests 1 failed",
					]),
					diff,
					headFiles,
				).join(),
			).toContain("row 2");
		}
		// A continuation that states the result is part of the same record.
		expect(
			errors(
				fence([
					"mutation: scripts/probe-a.mjs (guard -> gone)",
					"mutation: RED (Tests 1 failed)",
					"FAIL tests/a.test.ts > unrelated",
					"Tests 1 failed",
				]),
				diff,
				headFiles,
			),
		).toEqual([]);
		// The header cannot claim the run did not happen either.
		expect(
			errors(
				fence([
					"mutation: scripts/probe-a.mjs — could not execute",
					"Tests 1 failed",
				]),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
	});

	// #4605 V5: a bare basename that ends in a source extension names a file, so
	// it is evidence about that path rather than a generic read.
	it("refuses a bare basename Windows row as a generic read (#4605 row 4 basename)", () => {
		const one = image("clients/lsp/launch.ts", "const a = 1;");
		expect(
			errors(
				"`path-utils.ts` Windows: cannot differ because only string joins change.",
				one.diff,
				one.headFiles,
			).join(),
		).toContain("row 4");
		expect(
			errors(
				"Windows: cannot differ because only string joins change.",
				one.diff,
				one.headFiles,
			),
		).toEqual([]);
	});

	// #4585 as amended (issuecomment-6252599595): row 1 is file-level. One red
	// that names the file proves it; a red naming another file, or prose, does
	// not.
	it("proves a changed test file by one red naming it (#4585 file-level row 1)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'it("first case", () => {});\nit("second case", () => {});',
		);
		expect(
			errors(
				"```text\nFAIL tests/a.test.ts > first case\nTests 1 failed\n```",
				diff,
				headFiles,
			),
		).toEqual([]);
		// A failure from the same file, with a title the diff never touched, is
		// still this file's evidence.
		expect(
			errors(
				"```text\nFAIL tests/a.test.ts > second case\nTests 1 failed\n```",
				diff,
				headFiles,
			),
		).toEqual([]);
		// Another file's red proves nothing here.
		expect(
			errors(
				"```text\nFAIL tests/other.test.ts > first case\nTests 1 failed\n```",
				diff,
				headFiles,
			).join(),
		).toContain("row 1");
		// A fence that merely mentions this file, then quotes another file's
		// failure, is not this file's red.
		expect(
			errors(
				"```text\nRunning tests/a.test.ts\nFAIL tests/other.test.ts > first case\nTests 1 failed\n```",
				diff,
				headFiles,
			).join(),
		).toContain("row 1");
		// Prose names the title and the file but quotes no failure.
		expect(
			errors(
				"The new `first case` in `tests/a.test.ts` reds before the fix.",
				diff,
				headFiles,
			).join(),
		).toContain("row 1");
		// A Controls row naming the file with a reason proves it.
		expect(
			errors(
				"| Control | File | Reason |\n|---|---|---|\n| pre-existing | `tests/a.test.ts` | the case predates this diff |",
				diff,
				headFiles,
			),
		).toEqual([]);
		// A Controls row with no reason, or naming no file, proves nothing.
		expect(
			errors("Control: `tests/a.test.ts` —", diff, headFiles).join(),
		).toContain("row 1");
		expect(
			errors(
				"Control: `first case` — the case predates this diff.",
				diff,
				headFiles,
			).join(),
		).toContain("row 1");
	});
});

// #4717 F1: a row belongs to the section the reader sees, so both row scanners
// take their heading lines from the lexer. Recurrence: each scanner ran
// `HEADING.exec(row)`, a column-0 `## ` regex, so a setext or an indented ATX
// heading never ended a table's section and a later section's row proved the
// mutation (or Controls) evidence the section above it did not. `marked`'s own
// gfm render hides nothing there: the heading is a heading.
describe("row scanners read the lexer's headings (#4717 F1)", () => {
	const ended = [
		["a setext heading", "Blast radius\n------------"],
		["an indented ATX heading", "   ## Blast radius"],
	];
	const evidenceTable = (file: string, evidence: string) =>
		[
			"| file | evidence |",
			"| --- | --- |",
			`| \`${file}\` | ${evidence} |`,
		].join("\n");

	it.each(ended)("does not credit a mutation row past %s", (_name, heading) => {
		const { diff, headFiles } = image(
			"scripts/sample.mjs",
			"if (ready) return value;",
		);
		const body = [
			"## Mutations",
			evidenceTable("scripts/other.mjs", "`Tests 1 failed`"),
			"",
			heading,
			"",
			evidenceTable("scripts/sample.mjs", "`Tests 1 failed`"),
		].join("\n");
		expect(errors(body, diff, headFiles).join()).toContain("row 2");
		// The same row inside its own section still proves the mutation.
		expect(
			errors(
				[
					"## Mutations",
					evidenceTable("scripts/sample.mjs", "`Tests 1 failed`"),
				].join("\n"),
				diff,
				headFiles,
			),
		).toEqual([]);
	});

	it.each(ended)("does not credit a Controls row past %s", (_name, heading) => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			`it("fails for stale bytes", () => {});`,
		);
		const control = evidenceTable(
			"tests/a.test.ts",
			"the case predates this diff",
		);
		const body = [
			"## Controls",
			"No control is named here.",
			"",
			heading,
			"",
			control,
		].join("\n");
		expect(errors(body, diff, headFiles).join()).toContain("row 1");
		expect(
			errors(["## Controls", control].join("\n"), diff, headFiles),
		).toEqual([]);
	});
});
