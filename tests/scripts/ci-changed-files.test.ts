// #3801: scripts/ci-changed-files.mjs decides whether ci.yml's heavy jobs skip
// (a docs-only pull request) and whether TLA+ runs. Every case names the
// recurrence it keeps out; the direction of every doubt must be the FULL suite.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyChangedFiles,
	parseArgs,
	pathsFromPrFiles,
	PR_FILES_API_CAP,
	ghPrFiles,
	run,
} from "../../scripts/ci-changed-files.mjs";

const docsOnly = (paths: string[]) =>
	classifyChangedFiles(paths).code === false;

describe("classifyChangedFiles: the strict docs allowlist", () => {
	it.each([
		["README.md"],
		["AGENTS.md"],
		["CHANGELOG.md"],
		["docs/pi-lens-fixer.md"],
		["docs/img/diagram.png"],
		[".changelog/3801-heavy.md"],
	])("treats %s as docs", (file) => {
		expect(docsOnly([file])).toBe(true);
	});

	// Recurrence: an over-wide glob. `*.md` is ROOT-level only, because agent
	// contracts (.claude/agents/*.md), shipped skills (skills/**/SKILL.md) and
	// rule docs are behavior, not prose; a docs-only read of them skips every
	// test that reads them.
	it.each([
		[".claude/agents/pi-lens-fixer.md"],
		["skills/pi-lens/SKILL.md"],
		["rules/ast-grep-rules/README.md"],
		["tests/fixtures/notes.md"],
		[".github/workflows/ci.yml"],
		["formal/file-locks/FileLock.tla"],
		["scripts/ci-verdict.mjs"],
		["clients/index.ts"],
		["package.json"],
		["package-lock.json"],
		["docs-extra/file.md"],
		[".changelogx/file.md"],
		["README.MD"],
		["notes.markdown"],
	])("treats %s as code", (file) => {
		expect(docsOnly([file])).toBe(false);
	});

	// Recurrence: one code file hiding among docs. A single non-docs path makes
	// the whole diff code.
	it("makes a diff code when one path is not docs", () => {
		const result = classifyChangedFiles([
			"docs/a.md",
			"README.md",
			".changelog/x.md",
			"scripts/lib/ci-checks.mjs",
		]);
		expect(result.code).toBe(true);
		expect(result.reason).toContain("scripts/lib/ci-checks.mjs");
	});

	// Recurrence: a path that walks out of an allowlisted prefix.
	it.each([["docs/../clients/index.ts"], ["docs/./../package.json"]])(
		"does not let %s ride the docs prefix",
		(file) => {
			expect(docsOnly([file])).toBe(false);
		},
	);

	// Recurrence: doubt must run everything (AGENTS.md shape 48): a truncated or
	// empty listing is not evidence of a docs-only diff.
	it("runs everything for an empty list and for a list at the API cap", () => {
		expect(classifyChangedFiles([])).toMatchObject({
			code: true,
			formal: true,
		});
		const capped = Array.from(
			{ length: PR_FILES_API_CAP },
			(_, i) => `docs/f${i}.md`,
		);
		expect(classifyChangedFiles(capped)).toMatchObject({
			code: true,
			formal: true,
		});
		expect(
			classifyChangedFiles(capped.slice(0, PR_FILES_API_CAP - 1)).code,
		).toBe(false);
	});

	// Recurrence: TLA+ skipped when only what runs it changed (checker, job).
	it.each([
		[["formal/file-locks/FileLock.tla"], true],
		[["formal/x/y.cfg", "docs/a.md"], true],
		[["scripts/check-tla-models.mjs"], true],
		[[".github/workflows/ci.yml"], true],
		[["clients/index.ts"], false],
		[["docs/formal-notes.md"], false],
		[["README.md"], false],
	])("formal for %j is %s", (paths, formal) => {
		expect(classifyChangedFiles(paths as string[]).formal).toBe(formal);
	});
});

// N2 (#3861): the per-line parse `ghPrFiles` wraps is the ONE place a
// `pulls/{n}/files` body is read; a malformed `--jq` line must throw (the
// full-suite direction) rather than read as an empty list. `exec` is the
// process boundary, so the fake stands in for `gh`, not for the parse.
describe("ghPrFiles: one JSON object per gh --jq line (#3861 N2)", () => {
	it("parses every non-empty line and carries a rename's previous path", () => {
		const exec = () =>
			'{"filename":"clients/a.ts"}\n\n{"filename":"docs/b.md","previous_filename":"clients/c.ts"}\n';
		expect(ghPrFiles("acme/repo", "1", exec)).toEqual([
			"clients/a.ts",
			"docs/b.md",
			"clients/c.ts",
		]);
	});

	it("throws on a malformed line, never reads it as an empty file list", () => {
		const exec = () => '{"filename":"clients/a.ts"}\nnot json\n';
		expect(() => ghPrFiles("acme/repo", "1", exec)).toThrow(
			/malformed gh api --jq line/,
		);
	});

	// #3861 A1: only a whitespace-only line is a blank `--jq` separator; the
	// trim must catch tabs and a bare carriage return too, so none of them
	// reaches `JSON.parse`.
	it("skips whitespace-only and carriage-return-only lines", () => {
		const exec = () =>
			'{"filename":"clients/a.ts"}\n   \n\t\n\r\n{"filename":"docs/b.md"}\n';
		expect(ghPrFiles("acme/repo", "1", exec)).toEqual([
			"clients/a.ts",
			"docs/b.md",
		]);
	});

	// #3861 A2: the error excerpt is bounded to 200 characters; a longer
	// malformed line must not carry its tail into the message.
	it("caps the malformed-line excerpt at 200 characters", () => {
		const exec = () => `${"Z".repeat(250)}TRAILING\n`;
		let message = "";
		try {
			ghPrFiles("acme/repo", "1", exec);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("malformed gh api --jq line");
		expect(message.endsWith("Z".repeat(200))).toBe(true);
	});
});

describe("run (the CLI the changes job calls)", () => {
	function withOutput(
		test: (files: { output: string; summary: string }) => void,
	) {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-changed-files-"),
		);
		try {
			test({
				output: path.join(dir, "output"),
				summary: path.join(dir, "summary"),
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	const prArgs = [
		"--event",
		"pull_request",
		"--repo",
		"apmantza/pi-lens",
		"--pr",
		"3807",
	];
	const outputs = (file: string) =>
		Object.fromEntries(
			fs
				.readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => line.split("=")),
		);

	it("writes code=false for a docs-only pull request and reads the PR it was given", () => {
		withOutput((files) => {
			const seen: string[][] = [];
			const code = run(prArgs, {
				env: {
					GITHUB_OUTPUT: files.output,
					GITHUB_STEP_SUMMARY: files.summary,
				},
				fetchFiles: (repo: string, pr: string) => {
					seen.push([repo, pr]);
					return ["docs/a.md", ".changelog/b.md"];
				},
				log: () => {},
			});
			expect(code).toBe(0);
			expect(seen).toEqual([["apmantza/pi-lens", "3807"]]);
			expect(outputs(files.output)).toEqual({ code: "false", formal: "false" });
			expect(fs.readFileSync(files.summary, "utf8")).toMatch(
				/^changes: code=false formal=false -- docs-only diff/,
			);
		});
	});

	// Recurrence: master losing the full suite when a non-PR event was read as
	// docs-only. Only a pull_request is ever classified; every other event runs
	// everything and never reads the API.
	it.each(["push", "merge_group", "workflow_dispatch"])(
		"runs everything for a %s event without reading the API",
		(event) => {
			withOutput((files) => {
				const code = run(["--event", event], {
					env: { GITHUB_OUTPUT: files.output },
					fetchFiles: () => {
						throw new Error("must not be called");
					},
					log: () => {},
				});
				expect(code).toBe(0);
				expect(outputs(files.output)).toEqual({ code: "true", formal: "true" });
			});
		},
	);

	// Recurrence: an API failure reading as docs-only (skipping the suite on an
	// unread diff) or crashing the job red. It must run everything and exit 0.
	it("runs everything when the file list cannot be read", () => {
		withOutput((files) => {
			const code = run(prArgs, {
				env: { GITHUB_OUTPUT: files.output },
				fetchFiles: () => {
					throw new Error("HTTP 502: bad gateway\nsecond line");
				},
				log: () => {},
			});
			expect(code).toBe(0);
			expect(outputs(files.output)).toEqual({ code: "true", formal: "true" });
		});
	});

	// Recurrence: a rename CODE -> docs deleting a code file. The API lists the
	// new path as `filename` and the old one only as `previous_filename`.
	it("counts a rename's previous path", () => {
		const paths = pathsFromPrFiles([
			{ filename: "docs/moved.md", previous_filename: "clients/old-name.ts" },
			{ filename: "docs/plain.md" },
		]);
		expect(paths).toEqual([
			"docs/moved.md",
			"clients/old-name.ts",
			"docs/plain.md",
		]);
		expect(classifyChangedFiles(paths).code).toBe(true);
		expect(classifyChangedFiles(["docs/moved.md", "docs/plain.md"]).code).toBe(
			false,
		);
	});

	it("rejects bad arguments with exit 2 and writes nothing", () => {
		withOutput((files) => {
			for (const args of [
				[],
				["--event", "pull_request"],
				["--event", "pull_request", "--repo", "nope", "--pr", "1"],
				["--event", "pull_request", "--repo", "a/b", "--pr", "x1"],
				["--event", "push", "--bogus", "1"],
			]) {
				expect(
					run(args, {
						env: { GITHUB_OUTPUT: files.output },
						fetchFiles: () => ["docs/a.md"],
						log: () => {},
					}),
				).toBe(2);
			}
			expect(fs.existsSync(files.output)).toBe(false);
		});
	});

	it("parses the workflow's exact argument shape (an empty --pr on a push)", () => {
		expect(
			parseArgs(["--event", "push", "--repo", "apmantza/pi-lens", "--pr", ""]),
		).toEqual({
			event: "push",
			repo: "apmantza/pi-lens",
			pr: "",
		});
	});
});
