// flake-shape: real-process-spawn — the subject is `npm run lane:check`'s own
// process contract: the real CLI drives the real pre-push selector, the real
// red-on-base and real vitest over a real Git fixture, and the verdict and
// exit code are what a delegated lane acts on. An in-process stub would restate
// the transcripts the verdict is parsed from instead of proving the parse.
// lane: ubuntu Unit tests (POSIX sh git shim, TMPDIR-derived scratch root).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	decideLane,
	laneExitCode,
	reportedFailureFiles,
	unattributedFailure,
} from "../../scripts/lane-check.mjs";

import {
	useLaneCleanups,
	FIXTURES,
	packageJson,
	GREEN,
	RED,
	BASE_FILES,
	git,
	makeLane,
	runLane,
	worktreeCount,
	occurrences,
	TIMEOUT,
} from "../support/lane-check-kit.js";

useLaneCleanups();

const scratch = (lane: ReturnType<typeof makeLane>) => {
	const dir = path.join(lane.tmp, "pi-lens-scratch");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe("lane-check verdict table (#4047 round 2)", () => {
	it(
		"rebuilds a missing dist dependency before governance suites (#4239)",
		() => {
			const lane = makeLane({
				base: {
					...BASE_FILES,
					"clients/lsp/server-traits.ts":
						"export const isAuxiliary = () => false;\\n",
				},
				head: { "tests/config/added.test.ts": GREEN },
			});
			const run = runLane(lane);
			expect(run.status).toBe(0);
			expect(run.record.verdict).toBe("clean");
			expect(run.out).toContain(
				"[lane-check] dist/ missing or stale (dist/clients/lsp/server-traits.js); running npm run build:dist...",
			);
			expect(
				fs.existsSync(
					path.join(lane.root, "dist/clients/lsp/server-traits.js"),
				),
			).toBe(true);
			expect(fs.readFileSync(path.join(lane.home, "builds.log"), "utf8")).toBe(
				"b\nd\n",
			);
		},
		TIMEOUT,
	);

	it(
		"all green: clean, exit 0, the summary names the real branch",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "tests/config/added.test.ts": GREEN },
			});
			const run = runLane(lane);
			expect(run.status).toBe(0);
			expect(run.record.verdict).toBe("clean");
			expect(run.record.failedFiles).toEqual([]);
			expect(run.record.checks.build).toBe(0);
			expect(run.record.checks.targeted).toEqual({
				status: 0,
				failed: [],
				selected: 1,
				matched: 1,
				capped: false,
			});
			expect(run.out).toContain(
				"selection: selected 1, matched 1, capped false",
			);
			expect(run.out).toContain("verdict: clean (exit 0)");
			expect(run.out).toContain("branch: lane/fixture");
			// One build for the lane: no red to compare, so red-on-base builds none.
			expect(fs.readFileSync(path.join(lane.home, "builds.log"), "utf8")).toBe(
				"b\n",
			);
			expect(run.out).not.toContain("tools/4047-lane-check");
		},
		TIMEOUT,
	);

	// Recurrence (#4726 review F4): lane-check held its own `origin/master`
	// literal while its child hook resolved `upstream/master`, so the two
	// compared different ranges on a fork checkout.
	it(
		"resolves its base through the hook's resolveBaseRef (#4724)",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "tests/config/added.test.ts": GREEN },
			});
			// An upstream that has commits origin/master lacks.
			git(lane.root, "update-ref", "refs/remotes/upstream/master", "HEAD");
			const run = runLane(lane);
			expect(run.record.base).toBe("upstream/master");
		},
		TIMEOUT,
	);

	// Recurrence: four workers called reds unrelated on 2026-10-07 that
	// red-on-base would have called CAUSED-BY-CHANGE.
	it(
		"red only on HEAD with the base reachable: red-caused, exit 1, one red-on-base run for a file red in both sets",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "tests/config/bad.test.ts": RED },
			});
			const run = runLane(lane);
			expect(run.status).toBe(1);
			expect(run.record.verdict).toBe("red-caused");
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/config/bad.test.ts", verdict: "CAUSED-BY-CHANGE" },
			]);
			// The file reds in the targeted AND the governance run: one batch, one
			// comparison (two builds), not one per set.
			expect(occurrences(run.out, "BASE origin/master")).toBe(1);
			expect(run.out).toContain("CAUSED-BY-CHANGE: tests/config/bad.test.ts");
			expect(worktreeCount(lane)).toBe(1);
			expect(scratch(lane)).toEqual([]);
			// The lane's own TMPDIR is inherited (red-on-base made its scratch root
			// there); the old gate forced a shared `../probes-4047` instead.
			expect(fs.existsSync(path.join(lane.tmp, "pi-lens-scratch"))).toBe(true);
		},
		TIMEOUT,
	);

	it(
		"a file with a base-red test and a change-broken sibling is red-caused (the worst test wins)",
		() => {
			const two = (second: string) =>
				`import { expect, it } from "vitest";\nit("old red", () => {\n\texpect(1).toBe(2);\n});\nit("sibling", () => {\n\texpect(1).toBe(${second});\n});\n`;
			const lane = makeLane({
				base: { ...BASE_FILES, "tests/config/mixed.test.ts": two("1") },
				head: { "tests/config/mixed.test.ts": two("2") },
			});
			const run = runLane(lane);
			expect(run.status).toBe(1);
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/config/mixed.test.ts", verdict: "CAUSED-BY-CHANGE" },
			]);
			expect(run.out).toContain(
				"RED-ON-BASE  tests/config/mixed.test.ts > old red",
			);
		},
		TIMEOUT,
	);

	it(
		"red only on HEAD in a lane that refuses git worktree add: red-caused, exit 1, from the archive base tree",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "tests/config/bad.test.ts": RED },
			});
			const run = runLane(lane, { GUARDED_LANE: "1" });
			expect(run.out).toContain("plegma-guard: git worktree add is refused");
			expect(run.status).toBe(1);
			expect(run.record.verdict).toBe("red-caused");
			expect(run.record.redOnBase.baseTree).toBe("git-archive");
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/config/bad.test.ts", verdict: "CAUSED-BY-CHANGE" },
			]);
			expect(worktreeCount(lane)).toBe(1);
			expect(scratch(lane)).toEqual([]);
		},
		TIMEOUT,
	);

	it(
		"red on the base too: clean, exit 0, listed as RED-ON-BASE",
		() => {
			const lane = makeLane({
				base: { ...BASE_FILES, "tests/config/old-red.test.ts": RED },
				head: { "tests/config/added.test.ts": GREEN },
			});
			const run = runLane(lane);
			expect(run.status).toBe(0);
			expect(run.record.verdict).toBe("clean");
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/config/old-red.test.ts", verdict: "RED-ON-BASE" },
			]);
			expect(run.out).toContain("RED-ON-BASE: tests/config/old-red.test.ts");
		},
		TIMEOUT,
	);

	it(
		"build failure: unproven, exit 3, and no test step runs",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: {
					"package.json": packageJson(1),
					"tests/config/added.test.ts": GREEN,
				},
			});
			const run = runLane(lane);
			expect(run.status).toBe(3);
			expect(run.record.verdict).toBe("unproven");
			expect(run.record.checks.build).toBe(1);
			expect(run.record.checks.targeted).toBeUndefined();
			expect(run.record.findings).toEqual([
				{
					kind: "unproven",
					reason: "build failed (exit 1); no test step ran",
				},
			]);
			expect(run.out).toContain("verdict: unproven (exit 3)");
		},
		TIMEOUT,
	);

	it(
		"dist build failure: unproven, exit 3, and no test step runs",
		() => {
			const lane = makeLane({
				base: {
					...BASE_FILES,
					"clients/lsp/server-traits.ts":
						"export const isAuxiliary = () => false;\\n",
				},
				head: {
					"package.json": packageJson(0, 1),
					"tests/config/added.test.ts": GREEN,
				},
			});
			const run = runLane(lane);
			expect(run.status).toBe(3);
			expect(run.record.verdict).toBe("unproven");
			expect(run.record.checks.build).toBe(0);
			expect(run.record.checks.distBuild).toBe(1);
			expect(run.record.checks.targeted).toBeUndefined();
			expect(run.record.findings).toEqual([
				{
					kind: "unproven",
					reason: "dist build failed (exit 1); no test step ran",
				},
			]);
			expect(run.out).toContain(
				"[lane-check] dist build failed; run `npm run build:dist` to rebuild dist/.",
			);
		},
		TIMEOUT,
	);
});

describe("lane-check transcript parsing", () => {
	const recorded = (name: string) =>
		fs
			.readFileSync(path.join(FIXTURES, name), "utf8")
			.replaceAll("<ESC>", "\u001b");
	const candidates = [
		"tests/scripts/zz-probe-red-a.test.ts",
		"tests/scripts/zz-probe-red-b.test.ts",
		"tests/scripts/zz-probe-green.test.ts",
	];

	// The transcripts are real vitest 5.0.3 output from this repo's config (a
	// `|default|` project prefix), one with FORCE_COLOR=1: ANSI codes in front
	// of `FAIL` hid every red from the old parse, which then read as no red.
	it.each(["lane-check-vitest-red.txt", "lane-check-vitest-red-color.txt"])(
		"names exactly the failing files of the recorded vitest transcript %s",
		(name) => {
			expect(reportedFailureFiles(recorded(name), candidates).sort()).toEqual([
				"tests/scripts/zz-probe-red-a.test.ts",
				"tests/scripts/zz-probe-red-b.test.ts",
			]);
		},
	);

	it("a failed run that names fewer files than vitest counted is unattributed", () => {
		const output = recorded("lane-check-vitest-red.txt");
		const named = reportedFailureFiles(output, candidates.slice(0, 1));
		expect(named).toEqual(["tests/scripts/zz-probe-red-a.test.ts"]);
		expect(unattributedFailure(1, output, named)).toBe(
			"exit 1: vitest counted 2 failing file(s), 1 named",
		);
		expect(
			unattributedFailure(1, output, reportedFailureFiles(output, candidates)),
		).toBeNull();
		expect(unattributedFailure(1, "[pre-push] Error: Command failed", [])).toBe(
			"exit 1 and no failing test file named in the output",
		);
		expect(unattributedFailure(0, output, [])).toBeNull();
	});

	it("only `clean` exits 0; red-caused outranks unproven", () => {
		const caused = { kind: "red-caused", reason: "x" } as const;
		const unproven = { kind: "unproven", reason: "y" } as const;
		expect(decideLane([])).toBe("clean");
		expect(decideLane([unproven])).toBe("unproven");
		expect(decideLane([unproven, caused])).toBe("red-caused");
		expect(
			["clean", "red-caused", "unproven"].map((v) => laneExitCode(v)),
		).toEqual([0, 1, 3]);
		expect(laneExitCode("anything-else")).toBe(3);
	});
});
