// flake-shape: real-process-spawn — the subject is the scripts' own CLI entry
// points (argv wiring, stdout and the exit code the release roll and release.yml
// act on, and the body the backfill hands `gh`); the pure functions behind them
// are covered in changelog-duplicates.test.ts and changelog-highlights.test.ts,
// and an in-process call cannot prove the argv or exit-code boundary.
// lane: ubuntu Unit tests (node, a POSIX sh stand-in for gh, no network).
//
// Recurrences (#5351, review r1 of #5357): a `--duplicates` reading the wrong
// argument or exiting 0 on a missing version survived mutation, and the release
// body had no test that `--summary` carries the approved highlights block.
// Recurrence (#5357 r2, F8): backfill-github-releases.mjs wrote every body from
// the summary alone, so a backfill run dropped the approved highlights block.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeSection } from "../../scripts/lib/changelog.mjs";

const REPO_ROOT = path.resolve("");
const HIGHLIGHTS = [
	"### Highlights",
	"",
	"- Rules now report their fix hint.",
	"- Install updates show counts.",
	"- Groovy is a file kind.",
	"",
].join("\n");
const SECTION =
	"### Fixed\n\n- **Stop reading stale files.** Body text here. (refs #1)\n";

describe("rollup-changelog.mjs --duplicates", () => {
	const run = (...args: string[]) =>
		spawnSync(
			process.execPath,
			[
				path.join(REPO_ROOT, "scripts/rollup-changelog.mjs"),
				"--duplicates",
				...args,
			],
			{ encoding: "utf8", timeout: 30_000 },
		);

	it("prints the checklist for the version named after the flag, exit 0", () => {
		const result = run("4.4.9");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("(4.4.9)");
		expect(result.stdout).toMatch(/^- \[ \] /m);
	});

	it("exits 1 with the section named when the version has none", () => {
		const result = run("9.9.9");
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/no \[9\.9\.9\] section/);
		expect(result.stdout).toBe("");
	});

	it("exits 1 when no version follows the flag", () => {
		expect(run().status).toBe(1);
	});
});

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);

// The CLIs read CHANGELOG.md and .changelog/ relative to their own location, so
// only a copy of the scripts can sit beside a fixture highlights file. The copy
// imports node: modules only, so it resolves no node_modules.
function fixtureRoot(scripts: string[], highlights: string | null) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cli-"));
	roots.push(root);
	fs.writeFileSync(
		path.join(root, "CHANGELOG.md"),
		`# Changelog\n\n## [Unreleased]\n\n## [2.0.0] - 2026-01-01\n\n${SECTION}`,
	);
	if (highlights !== null) {
		fs.mkdirSync(path.join(root, ".changelog/highlights"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".changelog/highlights/2.0.0.md"),
			highlights,
		);
	}
	fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
	for (const f of [...scripts, "lib/changelog.mjs"])
		fs.copyFileSync(
			path.join(REPO_ROOT, "scripts", f),
			path.join(root, "scripts", f),
		);
	return root;
}

function runScript(
	root: string,
	script: string,
	args: string[],
	env?: Record<string, string | undefined>,
) {
	return spawnSync(
		process.execPath,
		[path.join(root, "scripts", script), ...args],
		{
			encoding: "utf8",
			timeout: 30_000,
			env,
		},
	);
}

describe("changelog-extract.mjs --summary", () => {
	function extract(highlights: string | null, args: string[]) {
		return runScript(
			fixtureRoot(["changelog-extract.mjs"], highlights),
			"changelog-extract.mjs",
			args,
		);
	}

	it("puts the highlights block on top of the summary", () => {
		const run = extract(HIGHLIGHTS, ["2.0.0", "--summary"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toBe(
			`${HIGHLIGHTS.trimEnd()}\n\n${summarizeSection(SECTION)}\n`,
		);
	});

	it("leaves the summary bytes unchanged when no file exists", () => {
		const run = extract(null, ["2.0.0", "--summary"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toBe(`${summarizeSection(SECTION)}\n`);
	});

	it("does not add highlights to the full, non-summary body", () => {
		const run = extract(HIGHLIGHTS, ["2.0.0"]);
		expect(run.stdout).not.toContain("Highlights");
	});

	it("fails the release on a malformed file", () => {
		const run = extract("### Highlights\n\n- One.\n", ["2.0.0", "--summary"]);
		expect(run.status).not.toBe(0);
		expect(run.stderr).toMatch(/must be "### Highlights"/);
	});
});

// The `gh` stand-in is a process boundary: `release list` serves one release,
// v2.0.0, and `release edit` copies its notes file where the test can read it.
const FAKE_GH = [
	'import { copyFileSync } from "node:fs";',
	'import { join } from "node:path";',
	"const [cmd, sub, tag, ...rest] = process.argv.slice(2);",
	'if (cmd === "release" && sub === "list")',
	'\tprocess.stdout.write(JSON.stringify([{ tagName: "v2.0.0" }]));',
	'else if (cmd === "release" && sub === "edit")',
	'\tcopyFileSync(rest[rest.indexOf("--notes-file") + 1], join(process.env.FAKE_GH_OUT, `${tag}.md`));',
	"else {",
	'\tprocess.stderr.write(`fake gh: unexpected ${process.argv.slice(2).join(" ")}\\n`);',
	"\tprocess.exit(1);",
	"}",
	"",
].join("\n");

// #5357 F8: the backfill is a second writer of a release body. Recurrence: it
// built every body from summarizeSection alone, so a backfill run overwrote a
// published release's approved highlights block. The malformed-file case pins
// that the backfill fails closed on the same check the release does.
describe.skipIf(process.platform === "win32")(
	"backfill-github-releases.mjs --apply",
	() => {
		function backfill(highlights: string | null) {
			const root = fixtureRoot(["backfill-github-releases.mjs"], highlights);
			const bin = path.join(root, "bin");
			const out = path.join(root, "edited");
			fs.mkdirSync(bin, { recursive: true });
			fs.mkdirSync(out);
			fs.writeFileSync(path.join(root, "fake-gh.mjs"), FAKE_GH);
			fs.writeFileSync(
				path.join(bin, "gh"),
				`#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "fake-gh.mjs")}" "$@"\n`,
			);
			fs.chmodSync(path.join(bin, "gh"), 0o755);
			const result = runScript(
				root,
				"backfill-github-releases.mjs",
				["--apply"],
				{
					...process.env,
					PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
					FAKE_GH_OUT: out,
					TMPDIR: root,
					TMP: root,
					TEMP: root,
				},
			);
			const notes = path.join(out, "v2.0.0.md");
			return {
				result,
				body: fs.existsSync(notes) ? fs.readFileSync(notes, "utf8") : null,
			};
		}

		it("writes the approved highlights block on top of the release body", () => {
			const { result, body } = backfill(HIGHLIGHTS);
			expect(result.status).toBe(0);
			expect(body).toBe(
				`${HIGHLIGHTS.trimEnd()}\n\n${summarizeSection(SECTION)}\n`,
			);
		});

		it("leaves the summary body unchanged when the version has no file", () => {
			const { result, body } = backfill(null);
			expect(result.status).toBe(0);
			expect(body).toBe(`${summarizeSection(SECTION)}\n`);
		});

		it("writes no release body when the highlights file is malformed", () => {
			const { result, body } = backfill("### Highlights\n\n- One.\n");
			expect(result.status).not.toBe(0);
			expect(result.stderr).toMatch(/must be "### Highlights"/);
			expect(body).toBeNull();
		});
	},
);
