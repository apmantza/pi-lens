/**
 * Registered-or-fail guard for a test file's peak resident set (#3058).
 *
 * Recurrence this prevents: `tests/config/bounded-container-guard.test.ts`
 * merged on 2026-09-14 with a 9,226 MB peak — 4.5x the
 * `WORKER_PEAK_RSS_BUDGET_MB` the worker resolver divides the runner's memory
 * by — and nothing in the repo noticed. The suite's memory low-water fell
 * 8,532 MB and the Unit job's SIGKILL rate went 7.1% -> 30.4% over five days
 * before a human read the `[mem-file]` records by hand. `reportPeakRss` now
 * fails that file's own suite at the point the peak is measured; this file is
 * what keeps that gate honest.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WORKER_PEAK_RSS_BUDGET_MB } from "../../scripts/lib/worker-budget.mjs";
import { runTeardownWithMemReport } from "../support/vitest-setup.js";
import {
	PEAK_RSS_ADMISSIONS,
	type PeakRssAdmission,
	peakRssProblem,
	reportPeakRss,
} from "../support/worker-peak-rss.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const OVER_BUDGET = WORKER_PEAK_RSS_BUDGET_MB + 1;

/** A record sink that keeps what the hook wrote. */
function capture(): { lines: string[]; write: (line: string) => void } {
	const lines: string[] = [];
	return { lines, write: (line) => lines.push(line) };
}

function reportOn(
	peakRssMb: number,
	options: {
		file?: string;
		platform?: NodeJS.Platform;
		admissions?: Readonly<Record<string, PeakRssAdmission>>;
	} = {},
): string[] {
	const sink = capture();
	reportPeakRss({
		file: options.file ?? "tests/fixture/heavy.test.ts",
		peakRssMb,
		heapUsedMb: 12,
		externalMb: 3,
		write: sink.write,
		platform: options.platform ?? "linux",
		admissions: options.admissions ?? {},
	});
	return sink.lines;
}

describe("#3058 per-file peak RSS is registered or fails", () => {
	it("fails a file over the budget and passes one under it", () => {
		expect(
			peakRssProblem("tests/fixture/heavy.test.ts", OVER_BUDGET, {}),
		).toContain(`over the ${WORKER_PEAK_RSS_BUDGET_MB} MB per-worker budget`);
		expect(
			peakRssProblem(
				"tests/fixture/heavy.test.ts",
				WORKER_PEAK_RSS_BUDGET_MB,
				{},
			),
		).toBeUndefined();
	});

	it("admits a measured peak and still fails growth past it", () => {
		const admissions = {
			"tests/fixture/heavy.test.ts": {
				peakRssMb: 4000,
				reason: "native grammar arenas, tracked by #3058",
			},
		};
		expect(
			peakRssProblem("tests/fixture/heavy.test.ts", 4000, admissions),
		).toBeUndefined();
		expect(
			peakRssProblem("tests/fixture/heavy.test.ts", 4001, admissions),
		).toContain("above its admitted 4000 MB ceiling");
		// The admission is content-keyed on the FILE: it never lifts the budget
		// for a sibling that merely runs next to it.
		expect(
			peakRssProblem("tests/fixture/other.test.ts", OVER_BUDGET, admissions),
		).toContain(`over the ${WORKER_PEAK_RSS_BUDGET_MB} MB per-worker budget`);
	});

	it("throws for an over-budget file on linux and records it either way", () => {
		expect(() => reportOn(OVER_BUDGET)).toThrow(
			`over the ${WORKER_PEAK_RSS_BUDGET_MB} MB per-worker budget`,
		);
		// The record is written before the throw, so the number that explains
		// the failure is in the log next to it.
		const sink = capture();
		expect(() =>
			reportPeakRss({
				file: "tests/fixture/heavy.test.ts",
				peakRssMb: OVER_BUDGET,
				heapUsedMb: 12,
				externalMb: 3,
				write: sink.write,
				platform: "linux",
				admissions: {},
			}),
		).toThrow();
		expect(sink.lines).toEqual([
			`[mem-file] peakRssMb=${OVER_BUDGET} heapUsedMb=12 externalMb=3 tests/fixture/heavy.test.ts\n`,
		]);
	});

	it("records but does not enforce off linux", () => {
		// worker-budget.mjs's provenance note calls the constant UNVALIDATED on
		// the ~3x heavier Windows profile, and that CI job is advisory over a
		// 40-file subset; the ubuntu Unit lane is the one the budget governs.
		expect(reportOn(OVER_BUDGET, { platform: "win32" })).toEqual([
			`[mem-file] peakRssMb=${OVER_BUDGET} heapUsedMb=12 externalMb=3 tests/fixture/heavy.test.ts\n`,
		]);
		expect(reportOn(10)).toEqual([
			"[mem-file] peakRssMb=10 heapUsedMb=12 externalMb=3 tests/fixture/heavy.test.ts\n",
		]);
	});

	it("emits the record shape the CI failure classifier parses", () => {
		// scripts/lib/ci-failure-classifier.mjs MEM_FILE_PEAK, copied from that
		// file: a format drift here silently blinds every #2042 post-mortem.
		const memFilePeak = /\[mem-file\] peakRssMb=(\d+)[^\r\n]*? (tests\/\S+)/;
		const [line] = reportOn(1234, { file: "tests/config/thing.test.ts" });
		const match = memFilePeak.exec(line ?? "");
		expect(match?.[1]).toBe("1234");
		expect(match?.[2]).toBe("tests/config/thing.test.ts");
	});

	it("keeps every live admission measured, reasoned and non-stale", () => {
		const problems: string[] = [];
		for (const [file, admission] of Object.entries(PEAK_RSS_ADMISSIONS)) {
			if (!fs.existsSync(path.join(REPO_ROOT, file)))
				problems.push(`${file}: admitted but the file does not exist`);
			if (!Number.isInteger(admission.peakRssMb))
				problems.push(`${file}: peakRssMb must be a measured whole number`);
			if (admission.peakRssMb <= WORKER_PEAK_RSS_BUDGET_MB)
				problems.push(
					`${file}: admitted at ${admission.peakRssMb} MB, at or under the ${WORKER_PEAK_RSS_BUDGET_MB} MB budget — delete the dead admission`,
				);
			if (!/#\d+/.test(admission.reason))
				problems.push(
					`${file}: reason names no issue — an admission must point at tracked work (#NNN)`,
				);
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("freezes the admissions table so a test cannot admit itself at runtime (#3067)", () => {
		// #3067 (#3062 review L1): PEAK_RSS_ADMISSIONS was typed Readonly<> but
		// never frozen. `peakRssProblem`'s default parameter reads this exact
		// live object, so a test running inside its own fork could do
		// `PEAK_RSS_ADMISSIONS["self"] = { peakRssMb: 999999, reason: "x" }` and
		// silently raise its own ceiling — the mutation compiled and ran clean.
		// Object.freeze makes that assignment throw instead (every module here
		// runs in ES module strict mode).
		expect(Object.isFrozen(PEAK_RSS_ADMISSIONS)).toBe(true);
		expect(() => {
			(PEAK_RSS_ADMISSIONS as Record<string, PeakRssAdmission>)[
				"tests/fixture/self-admit.test.ts"
			] = { peakRssMb: 999999, reason: "runtime self-admission probe" };
		}).toThrow(TypeError);
	});

	describe("the [mem-file] record survives any other afterAll throwing (#3139, #3137 review)", () => {
		// #3137 registered the mem-report hook first (so Vitest's LIFO afterAll
		// order ran it last), fixing the direction where an over-budget file's
		// own throw preempted the #3083 backstop, tmp-hygiene and kill-guard
		// hooks. That created the inverse: confirmed directly against the
		// installed vitest@5.0.0 source (node_modules/vitest/dist/chunks/
		// run.CQOUYP-x.js:3544-3548 reverses afterAll order for "stack";
		// :3566-3569's execution loop has no try/catch around a hook), any ONE
		// of those three throwing aborted the remaining hooks in that pass —
		// including the mem-report hook, dropping `[mem-file]` for exactly the
		// file worth investigating.
		//
		// The fix (tests/support/vitest-setup.ts) is not a fourth registration
		// position: it collapses to the single `afterAll` below, calling
		// `runTeardownWithMemReport` — the real, exported mechanism under test
		// here, not a stand-in for it. Ordering between multiple top-level
		// afterAll hooks is moot once there is only one, so the old structural
		// "registered before" guard (#3067, #3062 review L2) is replaced by
		// this behavioural pair rather than pinning a position that no longer
		// has meaning.
		it("emits the mem report even when an earlier check throws (red-first: #3139)", () => {
			const emitMemReport = vi.fn();
			const tmpHygieneThrow = () => {
				throw new Error("tmp-hygiene leaked an unadmitted entry");
			};
			expect(() =>
				runTeardownWithMemReport(
					[() => {}, tmpHygieneThrow, () => {}],
					emitMemReport,
				),
			).toThrow("tmp-hygiene leaked an unadmitted entry");
			expect(emitMemReport).toHaveBeenCalledTimes(1);
		});

		it("still runs every check when the mem report itself throws", () => {
			const killGuard = vi.fn();
			const tmpHygiene = vi.fn();
			const backstop = vi.fn();
			const emitMemReport = () => {
				throw new Error("mem report write failed");
			};
			expect(() =>
				runTeardownWithMemReport(
					[killGuard, tmpHygiene, backstop],
					emitMemReport,
				),
			).toThrow("mem report write failed");
			expect(killGuard).toHaveBeenCalledTimes(1);
			expect(tmpHygiene).toHaveBeenCalledTimes(1);
			expect(backstop).toHaveBeenCalledTimes(1);
		});

		it("surfaces both errors when a check and the mem report both throw (#3148)", () => {
			// A plain `finally` that throws replaces the pending exception, so
			// kill-guard's pid+stack report -- which exists nowhere but that
			// Error -- vanished behind a peak-RSS budget failure.
			const killGuardThrow = () => {
				throw new Error("kill-guard: pid 4242 not owned by this test");
			};
			const emitMemReport = () => {
				throw new Error("peakRssMb=2300 exceeds the 2048 MB budget");
			};
			let thrown: unknown;
			try {
				runTeardownWithMemReport([killGuardThrow, () => {}], emitMemReport);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(AggregateError);
			const aggregate = thrown as AggregateError;
			expect(aggregate.errors.map((error: Error) => error.message)).toEqual([
				"kill-guard: pid 4242 not owned by this test",
				"peakRssMb=2300 exceeds the 2048 MB budget",
			]);
			// The message carries both, for a reporter that prints only it.
			expect(aggregate.message).toContain("pid 4242 not owned");
			expect(aggregate.message).toContain("exceeds the 2048 MB budget");
		});

		it("still fails the file — a passing run never re-throws", () => {
			const emitMemReport = vi.fn();
			expect(() =>
				runTeardownWithMemReport([() => {}, () => {}], emitMemReport),
			).not.toThrow();
			expect(emitMemReport).toHaveBeenCalledTimes(1);
		});

		it("registers exactly one top-level afterAll in vitest-setup.ts", () => {
			// Do not add a fifth hook that merely reorders (#3139 brief): pin
			// that the file has collapsed to ONE suite-level afterAll, so a
			// future edit that bolts on a second one — reintroducing the exact
			// ordering hazard this fix removes — reds here instead of waiting
			// for a flaky CI kill to notice.
			const setupSource = fs.readFileSync(
				path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
				"utf8",
			);
			const topLevelAfterAll = setupSource.match(/^afterAll\(/gm) ?? [];
			expect(topLevelAfterAll).toHaveLength(1);
		});
	});
});
