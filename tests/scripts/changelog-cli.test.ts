// flake-shape: real-process-spawn — the subject is the two scripts' own CLI
// entry points (argv wiring, stdout and the exit code the release roll and
// release.yml act on); the pure functions behind them are covered in
// changelog-duplicates.test.ts and changelog-highlights.test.ts, and an
// in-process call cannot prove the argv or exit-code boundary.
// lane: ubuntu Unit tests (node only, no network).
//
// Recurrences (#5351, review r1 of #5357): a `--duplicates` reading the wrong
// argument or exiting 0 on a missing version survived mutation, and the release
// body had no test that `--summary` carries the approved highlights block.
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

describe("changelog-extract.mjs --summary", () => {
	const roots: string[] = [];
	afterEach(() =>
		roots
			.splice(0)
			.forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
	);

	// The CLI reads CHANGELOG.md and .changelog/ relative to its own location, so
	// only a copy of the two scripts can sit beside a fixture highlights file.
	// The copy imports node: modules only, so it resolves no node_modules.
	function extract(highlights: string | null, args: string[]) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-extract-"));
		roots.push(root);
		fs.writeFileSync(
			path.join(root, "CHANGELOG.md"),
			`# Changelog\n\n## [Unreleased]\n\n## [2.0.0] - 2026-01-01\n\n${SECTION}`,
		);
		if (highlights !== null) {
			fs.mkdirSync(path.join(root, ".changelog/highlights"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(root, ".changelog/highlights/2.0.0.md"),
				highlights,
			);
		}
		fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
		for (const f of ["changelog-extract.mjs", "lib/changelog.mjs"])
			fs.copyFileSync(
				path.join(REPO_ROOT, "scripts", f),
				path.join(root, "scripts", f),
			);
		return spawnSync(
			process.execPath,
			[path.join(root, "scripts/changelog-extract.mjs"), ...args],
			{ encoding: "utf8", timeout: 30_000 },
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
