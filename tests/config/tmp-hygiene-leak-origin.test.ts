import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { stripSource } from "../support/sweep-kit.js";
import {
	diagnoseTmpHygieneLeak,
	diagnoseTmpHygieneLeaks,
	formatTmpHygieneLeakOrigin,
	tmpHygieneSweepRecords,
	TMP_HYGIENE_DIAGNOSIS_LIMIT,
	type TmpHygieneSweepRecord,
} from "../support/vitest-setup.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * #4591: the census names a leaked root but not when it appeared or what it
 * holds, so `pi-lens-4577-resolver-cqF0yk` could not be attributed to a HOME
 * writer or a `cwd` writer after it reappeared post-sweep. One bounded line per
 * leaked entry closes that: birth time (comparable to the owning file's
 * `[tmp-hygiene-sweep]` line) and the entry's first-level children.
 */
describe("tmp-hygiene leak origin record (#4591)", () => {
	it("names the entry, its birth time and its first-level children", () => {
		const env = setupTestEnvironment("pi-lens-4591-origin-");
		const leaked = path.join(env.tmpDir, "leaked-entry");
		try {
			fs.mkdirSync(path.join(leaked, "home"), { recursive: true });
			fs.mkdirSync(path.join(leaked, "workspace"));
			const born = fs.statSync(leaked).birthtimeMs;
			const line = formatTmpHygieneLeakOrigin(leaked, born + 181_000);
			expect(line.startsWith("[tmp-hygiene-origin] leaked-entry ")).toBe(true);
			expect(line).toContain("first-level children: home,workspace");
			// A filesystem that reports no creation time says so; NTFS and the
			// Linux filesystems this suite runs on report one, and both arms are
			// asserted through the same seam.
			if (born > 0) {
				expect(line).toContain("born 181000ms before this line");
				expect(line).toContain(`created at ${new Date(born).toISOString()}`);
			} else {
				expect(line).toContain("birth time unavailable");
			}
			expect(line.endsWith("\n")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("bounds the children it names and counts the rest", () => {
		const env = setupTestEnvironment("pi-lens-4591-origin-many-");
		const leaked = path.join(env.tmpDir, "many-children");
		try {
			fs.mkdirSync(leaked);
			for (const name of ["c1", "c2", "c3", "c4", "c5", "c6"])
				fs.mkdirSync(path.join(leaked, name));
			const line = formatTmpHygieneLeakOrigin(leaked);
			expect(line).toContain("first-level children: c1,c2,c3,c4 (+2 more)");
			expect(line).not.toContain("c5");
		} finally {
			env.cleanup();
		}
	});

	it("names an empty entry as holding nothing and floors a future birth time at zero", () => {
		const env = setupTestEnvironment("pi-lens-4591-origin-empty-");
		const empty = path.join(env.tmpDir, "empty-entry");
		try {
			fs.mkdirSync(empty);
			expect(formatTmpHygieneLeakOrigin(empty)).toContain(
				"first-level children: none",
			);
			// A filesystem timestamp microseconds ahead of the process clock is a
			// negative age, which reads as `born 0ms`, never as a negative one. The
			// birth time is passed explicitly so this cell drives the floor on a
			// filesystem that reports no creation time instead of failing the
			// formatter's correct "unavailable" arm (the sibling cell above takes
			// the same axis from `stat` and guards it).
			const line = formatTmpHygieneLeakOrigin(empty, 1_000, {
				birthtimeMs: 6_000,
				children: [],
			});
			expect(line).toContain("born 0ms before this line");
		} finally {
			env.cleanup();
		}
	});

	it("reports a zero birth time as unavailable, never as 1970", () => {
		// The arm a filesystem that keeps no creation time takes: `stat` answered,
		// and the birth time it answered with is 0. No filesystem on this host
		// produces it, so the facts are injected — the same explicit-input shape
		// `removeRunBackstopDirs(home)` and `unadmittedRootBackstopEntries(before)`
		// take for their own unreachable-on-this-host arms.
		const line = formatTmpHygieneLeakOrigin("/nowhere/zero-born", 1_000, {
			birthtimeMs: 0,
			children: ["home"],
		});
		expect(line).toBe(
			"[tmp-hygiene-origin] zero-born birth time unavailable (first-level children: home)\n",
		);
	});

	it("reports an entry that cannot be read instead of a fabricated birth time", () => {
		const env = setupTestEnvironment("pi-lens-4591-origin-gone-");
		const gone = path.join(env.tmpDir, "already-removed");
		try {
			const line = formatTmpHygieneLeakOrigin(gone);
			expect(line).toBe(
				`[tmp-hygiene-origin] already-removed birth time unavailable (first-level children unavailable)\n`,
			);
		} finally {
			env.cleanup();
		}
	});

	it("records the origin before the destructive owner removes the entry", () => {
		// The runtime path cannot be driven from a test: the only caller,
		// `cleanupTmpHygiene`, sweeps the LIVE run's tmp root, so invoking it here
		// would perform this run's own cleanup and delete a sibling worker's
		// entries. The wiring is pinned as source, the shape the census suite
		// already uses for the same function's backstop call.
		// `stripSource` blanks comments and string literals first, so a comment
		// naming the call can never satisfy this and a commented-out record reds
		// (#4591 F1): the same idiom the census suite uses for the backstop call.
		const source = stripSource(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
				"utf8",
			),
		);
		const body =
			/export function cleanupTmpHygiene\([\s\S]*?\n\}/.exec(source)?.[0] ?? "";
		expect(
			body,
			"cleanupTmpHygiene is no longer declared as expected",
		).not.toBe("");
		const record = body.indexOf(
			"process.stderr.write(formatTmpHygieneLeakOrigin(entryDir))",
		);
		expect(record).toBeGreaterThan(-1);
		expect(record).toBeLessThan(body.indexOf("removeTempDirSync(entryDir)"));
	});
});

/**
 * #4591: the census failure message tells the two producer candidates apart.
 * Candidate 1 is a deferred writer that recreates a `registered` root after the
 * sweep removed it; candidate 2 is a root the interposer never recorded, so the
 * sweep never owned it. The Windows lane reds about one run in ten and cannot be
 * run locally, so the message itself is the probe: it must name the candidate and
 * the facts behind the name. The facts are injected here (times, sweep records)
 * because the arms are decided by an ordering of clocks no local run can stage on
 * demand; the real hooks that WRITE the sweep record are driven in
 * `tests/support/tmp-root-teardown.test.ts`.
 */
describe("tmp-hygiene census diagnosis (#4591)", () => {
	const SWEEP_AT = Date.parse("2026-10-31T12:00:00.000Z");
	const sweep = (
		over: Partial<TmpHygieneSweepRecord> = {},
	): TmpHygieneSweepRecord => ({
		via: "afterAll",
		kind: "registered",
		outcome: "removed",
		at: SWEEP_AT,
		...over,
	});

	it("names candidate 1: a registered root born after its sweep, with the HOME child", () => {
		const line = diagnoseTmpHygieneLeak(
			"pi-lens-x-AbC123",
			"clients/x.test.ts",
			[sweep()],
			{
				birthtimeMs: SWEEP_AT + 9_034,
				mtimeMs: SWEEP_AT + 9_040,
				ctimeMs: SWEEP_AT + 9_041,
				children: ["home"],
			},
		);
		expect(line).toBe(
			"pi-lens-x-AbC123 [recreated-after-sweep] in the registry at sweep time; sweeps: afterAll registered removed at 2026-10-31T12:00:00.000Z; vs last sweep: birth +9034ms, mtime +9040ms, ctime +9041ms; first-level children: home",
		);
	});

	it("names candidate 2: no creator on record and no sweep record", () => {
		const line = diagnoseTmpHygieneLeak("pi-lens-y-Zz9", undefined, [], {
			birthtimeMs: SWEEP_AT,
			children: [],
		});
		expect(line).toBe(
			"pi-lens-y-Zz9 [unrecorded] not in the registry (no creator on record); no sweep record; first-level children: none",
		);
	});

	it("keeps the remaining cells explicit instead of folding them into a candidate", () => {
		const times = { birthtimeMs: SWEEP_AT - 500, children: ["workspace"] };
		// Recorded by the interposer but never a sweep root (an mkdir sibling).
		expect(
			diagnoseTmpHygieneLeak("pi-lens-s", "clients/s.test.ts", [], times),
		).toContain("[recorded-not-swept] creator on record, never a sweep root");
		// Born BEFORE the sweep that listed it: the sweep had it and it survived.
		expect(
			diagnoseTmpHygieneLeak(
				"pi-lens-p",
				"clients/p.test.ts",
				[sweep({ kind: "observed", outcome: "held" })],
				times,
			),
		).toContain("[present-at-sweep(held)]");
		// A filesystem that withholds the birth time cannot place it.
		expect(
			diagnoseTmpHygieneLeak("pi-lens-o", "clients/o.test.ts", [sweep()], {
				birthtimeMs: 0,
				mtimeMs: SWEEP_AT + 5,
			}),
		).toBe(
			"pi-lens-o [order-unknown] in the registry at sweep time; sweeps: afterAll registered removed at 2026-10-31T12:00:00.000Z; vs last sweep: birth unavailable, mtime +5ms, ctime unavailable; first-level children unavailable",
		);
	});

	it("measures against the LAST sweep when a root was swept through both hooks", () => {
		const line = diagnoseTmpHygieneLeak(
			"pi-lens-m",
			"clients/m.test.ts",
			[
				sweep({ at: SWEEP_AT }),
				sweep({ via: "SIGTERM", at: SWEEP_AT + 20_000 }),
			],
			{ birthtimeMs: SWEEP_AT + 10_000, children: ["home"] },
		);
		// Born between the two sweeps: the SIGTERM sweep came after it was born and
		// still listed it, so it is not a recreation after the last sweep.
		expect(line).toContain("[present-at-sweep(removed)]");
		expect(line).toContain("birth -10000ms");
	});

	it("reads the sweep records back from the creators map and drops a line it does not recognise", () => {
		const records = tmpHygieneSweepRecords(
			new Map([
				["pi-lens-x", "clients/x.test.ts"],
				["sweep:afterAll:pi-lens-x", `registered,removed,${SWEEP_AT}`],
				["sweep:SIGTERM:pi-lens-x", `registered,absent,${SWEEP_AT + 1}`],
				["sweep:afterAll:pi-lens-bad-kind", `weird,removed,${SWEEP_AT}`],
				[
					"sweep:afterAll:pi-lens-bad-outcome",
					`registered,vanished,${SWEEP_AT}`,
				],
				["sweep:afterAll:pi-lens-bad-time", "registered,removed,soon"],
				["sweep:afterAll:pi-lens-no-time", "registered,removed,"],
				["sweep:afterAll:pi-lens-extra", `registered,removed,${SWEEP_AT},more`],
				["sweep:hook:pi-lens-bad-via", `registered,removed,${SWEEP_AT}`],
				["sweep:pi-lens-no-via", `registered,removed,${SWEEP_AT}`],
				["sweep:afterAll:", `registered,removed,${SWEEP_AT}`],
			]),
		);
		expect([...records.keys()]).toEqual(["pi-lens-x"]);
		expect(records.get("pi-lens-x")).toEqual([
			{ via: "afterAll", kind: "registered", outcome: "removed", at: SWEEP_AT },
			{
				via: "SIGTERM",
				kind: "registered",
				outcome: "absent",
				at: SWEEP_AT + 1,
			},
		]);
	});

	it("diagnoses a real directory through the shipped reader and bounds the list", () => {
		const env = setupTestEnvironment("pi-lens-4591-diagnosis-");
		try {
			const names: string[] = [];
			for (let i = 0; i < TMP_HYGIENE_DIAGNOSIS_LIMIT + 2; i++) {
				const name = `pi-lens-4591-leak-${i}`;
				fs.mkdirSync(path.join(env.tmpDir, name, "home"), { recursive: true });
				names.push(name);
			}
			const creators = new Map([
				[
					`sweep:afterAll:${names[0]}`,
					`registered,removed,${Date.now() - 60_000}`,
				],
				[names[0], "config/x.test.ts"],
			]);
			const text = diagnoseTmpHygieneLeaks(names, creators, env.tmpDir);
			// The first entry has a sweep record from a minute ago and was born now.
			expect(text).toContain(`${names[0]} [recreated-after-sweep] `);
			expect(text).toContain("first-level children: home");
			// No creator and no record: candidate 2, from the same real directory.
			expect(text).toContain(`${names[1]} [unrecorded] `);
			expect(text.split(" | ")).toHaveLength(TMP_HYGIENE_DIAGNOSIS_LIMIT + 1);
			expect(text.endsWith(" | (+2 more)")).toBe(true);
			// An entry that is gone since the census listed it reports itself so.
			expect(
				diagnoseTmpHygieneLeaks(["pi-lens-4591-gone"], new Map(), env.tmpDir),
			).toBe(
				"pi-lens-4591-gone [unrecorded] not in the registry (no creator on record); no sweep record; first-level children unavailable",
			);
		} finally {
			env.cleanup();
		}
	});

	it("puts the diagnosis in the census failure message, where the Windows log shows it", () => {
		// The wiring is a source pin, the idiom this file already uses for the
		// destructive owner: the assertion that reds is inside an `afterAll` of the
		// serialized census, and driving it for real would sweep the live run.
		// Comments blanked (a docblock naming the call never satisfies it); strings
		// kept, because the call sits inside the message's template literal.
		const source = fs.readFileSync(
			path.join(REPO_ROOT, "tests/config/tmp-fixture-hygiene.test.ts"),
			"utf8",
		);
		expect(stripSource(source, { strings: "keep" })).toContain(
			"diagnosis (#4591): ${diagnoseTmpHygieneLeaks(attributable, creators)}",
		);
	});
});
