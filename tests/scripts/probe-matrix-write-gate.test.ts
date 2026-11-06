// flake-shape: real-process-spawn — scripts/probe-clean-signal.mjs executes on import (it spawns language servers and ends in process.exit), so the write gate is observable only by running the real script and reading the doc it leaves; a source scan restated the gate's text and stayed green with the call removed (#5348).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { requireBuiltDist } from "../support/require-built-dist.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const DOC = path.join("docs", "lsp-capability-matrix.md");
const FOOTNOTE_HEADING = "## silentOnClean drift (nightly-generated)";
const STALE_FOOTNOTE = "STALE-FOOTNOTE-SENTINEL";

// The script derives its repo root from its own file URL, so it runs from a
// scratch root that holds a real copy of the script, links to everything else
// it imports (scripts/lib, smoke-tools, dist) and its own copy of the doc.
// The roots, the pinned homes and the tmpdir all sit under one scratch dir:
// the run writes a drift summary and stale-cell files to os.tmpdir().
describe.skipIf(process.platform === "win32")(
	"the probe leaves the tracked matrix alone unless asked (#5348)",
	() => {
		// Recurrence it prevents: the first run of scripts/probe-clean-signal.mjs
		// in a checkout rewrote the tracked docs/lsp-capability-matrix.md (the
		// measurement lane had to `git checkout --` it). The write is now behind
		// `--write-matrix`; a source scan of that gate stayed green with the
		// `updateMatrix(rows)` call removed, which would stop the nightly refresh
		// PR without a red anywhere.
		let scratch = "";
		let seed = "";

		beforeAll(() => {
			requireBuiltDist(
				repoRoot,
				"clients/lsp/index.js",
				"clients/lsp/config.js",
				"clients/path-utils.js",
				"clients/project-trust.js",
				"clients/lsp/wait-policy/strategies.js",
			);
			scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-write-gate-"));
			fs.mkdirSync(path.join(scratch, "scripts"));
			fs.mkdirSync(path.join(scratch, "docs"));
			fs.mkdirSync(path.join(scratch, "tmp"));
			fs.copyFileSync(
				path.join(repoRoot, "scripts", "probe-clean-signal.mjs"),
				path.join(scratch, "scripts", "probe-clean-signal.mjs"),
			);
			for (const rel of ["scripts/lib", "scripts/smoke-tools.mjs", "dist"]) {
				fs.symlinkSync(
					path.join(repoRoot, rel),
					path.join(scratch, rel),
					rel === "scripts/smoke-tools.mjs" ? "file" : "dir",
				);
			}
			// The committed footnote varies with the last nightly; a sentinel in
			// its place makes "the flagged run rewrote the doc" independent of it.
			const tracked = fs.readFileSync(path.join(repoRoot, DOC), "utf8");
			const at = tracked.indexOf(FOOTNOTE_HEADING);
			seed = `${at < 0 ? tracked : tracked.slice(0, at)}${FOOTNOTE_HEADING}\n\n${STALE_FOOTNOTE}\n`;
		});

		afterAll(() => {
			fs.rmSync(scratch, { recursive: true, force: true });
		});

		// A lang no fixture has: the run spawns no language server, reaches the
		// real report and `updateMatrix`, and exits 0.
		const runProbe = (flags: string[]) => {
			fs.writeFileSync(path.join(scratch, DOC), seed);
			const result = spawnSync(
				process.execPath,
				[
					path.join(scratch, "scripts", "probe-clean-signal.mjs"),
					"no-such-lang",
					...flags,
				],
				{
					cwd: scratch,
					encoding: "utf8",
					timeout: 120_000,
					env: {
						...process.env,
						PI_LENS_HOME: path.join(scratch, "home"),
						PILENS_DATA_DIR: path.join(scratch, "home"),
						TMPDIR: path.join(scratch, "tmp"),
						TEMP: path.join(scratch, "tmp"),
						TMP: path.join(scratch, "tmp"),
					},
				},
			);
			return {
				status: result.status,
				stderr: result.stderr,
				doc: fs.readFileSync(path.join(scratch, DOC), "utf8"),
			};
		};

		it("leaves the doc byte-identical and says so when the flag is absent", () => {
			const run = runProbe([]);
			expect(run.status).toBe(0);
			expect(run.stderr).toContain(
				"matrix update skipped: docs/lsp-capability-matrix.md is written only with --write-matrix",
			);
			expect(run.stderr).not.toContain("Updated docs/lsp-capability-matrix.md");
			expect(run.doc).toBe(seed);
		}, 130_000);

		it("rewrites the doc when --write-matrix is passed", () => {
			const run = runProbe(["--write-matrix"]);
			expect(run.status).toBe(0);
			expect(run.stderr).toContain("Updated docs/lsp-capability-matrix.md");
			expect(run.doc).not.toBe(seed);
			expect(run.doc).not.toContain(STALE_FOOTNOTE);
		}, 130_000);
	},
);

describe("the nightly passes the write flag (#5348)", () => {
	it("keeps the nightly step on --write-matrix", () => {
		// Recurrence it prevents: gating the write without passing the flag in
		// the nightly would leave the refresh PR carrying no matrix.
		const workflow = yaml.load(
			fs.readFileSync(
				path.join(repoRoot, ".github/workflows/tool-smoke.yml"),
				"utf8",
			),
		) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
		const probeRuns = workflow.jobs["tool-smoke"].steps
			.map((step) => step.run ?? "")
			.filter((run) => run.includes("probe-clean-signal.mjs"));
		expect(probeRuns).toHaveLength(1);
		expect(probeRuns[0]).toContain("--write-matrix");
	});
});
