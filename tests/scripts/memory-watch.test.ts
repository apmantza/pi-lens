import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatSampleLine,
	formatVerdict,
	parseMeminfo,
	readCgroupSample,
	resolveCgroupDir,
	shouldPrint,
} from "../../scripts/lib/memory-watch.mjs";

const MEMINFO = [
	"MemTotal:       16376464 kB",
	"MemFree:          204908 kB",
	"MemAvailable:    9481512 kB",
	"Buffers:          151876 kB",
	"Cached:          8724180 kB",
].join("\n");

describe("memory watch sampling (#2042)", () => {
	it("reads MemAvailable, not MemFree", () => {
		// MemFree excludes reclaimable page cache and reads alarmingly low on a
		// healthy runner. MemAvailable is the number that tracks real pressure, so
		// reading the wrong field would make every sample look like an emergency.
		const sample = parseMeminfo(MEMINFO);
		expect(sample.totalMb).toBe(Math.round(16_376_464 / 1024));
		expect(sample.availableMb).toBe(Math.round(9_481_512 / 1024));
		expect(sample.availableMb).not.toBe(Math.round(204_908 / 1024));
	});

	it("refuses to invent numbers from an unparseable meminfo", () => {
		expect(() => parseMeminfo("MemTotal: not-a-number\n")).toThrow();
	});
});

describe("memory watch print policy (#2042)", () => {
	const state = (lastPrintedMb: number | null) => ({
		lastPrintedMb,
		thresholdMb: 1024,
		stepMb: 1024,
	});

	it("always prints the first sample", () => {
		expect(shouldPrint({ availableMb: 12_000 }, state(null))).toBe(true);
	});

	it("stays quiet while memory is plentiful and steady", () => {
		// A line every two seconds for a five-minute suite would bury the test
		// output it is meant to annotate.
		expect(shouldPrint({ availableMb: 11_800 }, state(12_000))).toBe(false);
	});

	it("prints once memory falls a full step", () => {
		expect(shouldPrint({ availableMb: 10_900 }, state(12_000))).toBe(true);
	});

	it("prints every sample below the low-water threshold", () => {
		// Past the threshold each sample is evidence: the last one before a kill
		// is the whole point of the watch.
		expect(shouldPrint({ availableMb: 900 }, state(1000))).toBe(true);
	});
});

describe("memory watch verdict (#2042)", () => {
	const watch = { totalMb: 15_992, lowWaterMb: 143, lowWaterAt: "20:09:27" };

	it("calls a SIGKILL what it is, with the low-water mark", () => {
		const line = formatVerdict({ code: null, signal: "SIGKILL" }, watch);
		expect(line).toContain("KILLED");
		expect(line).toContain("no failing assertion");
		expect(line).toContain("lowWaterAvailableMb=143");
		expect(line).toContain("lowWaterAt=20:09:27");
	});

	it("treats a bare exit 137 as the same shape", () => {
		// A shell between the wrapper and the killed process reports 137 rather
		// than forwarding the signal; both must reach the same verdict.
		expect(formatVerdict({ code: 137, signal: null }, watch)).toContain(
			"KILLED",
		);
	});

	it("does not cry OOM over an ordinary test failure", () => {
		const line = formatVerdict({ code: 1, signal: null }, watch);
		expect(line).not.toContain("KILLED");
		expect(line).toContain("exitCode=1");
	});

	it("reports the low-water mark on success too", () => {
		// The headroom on a passing run is what says whether the next one is safe.
		const line = formatVerdict({ code: 0, signal: null }, watch);
		expect(line).toContain("lowWaterAvailableMb=143");
	});

	it("names the process it was watching, so the kernel's victim pid matches", () => {
		// `dmesg` says "Killed process 2477 (npm)". That is only attributable
		// next to the pid the wrapper was watching.
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ ...watch, childPid: 2477 },
		);
		expect(line).toContain("childPid=2477");
	});
});

/**
 * The verdict must be a reading of its own numbers, not a fixed conclusion.
 *
 * Every exit-137 in this repo's CI history carried the "the OS reclaimed
 * memory" sentence, including three whose own low-water mark said 13 GB of
 * 16 GB was still available (runs 33010136296, 32975604997, 32943340609) —
 * while the green run beside them went LOWER, to 13,096 MB (run 33012307631).
 * Four rounds of diagnosis inherited that false sentence.
 */
describe("memory watch verdict classifies from its own numbers (#2042)", () => {
	// Verbatim from run 33010136296's own verdict line.
	const realKill = {
		totalMb: 15_990,
		lowWaterMb: 13_260,
		lowWaterAt: "20:24:08",
		childPid: 2477,
	};

	it("refuses to blame memory when the box was never short of it", () => {
		const line = formatVerdict({ code: null, signal: "SIGKILL" }, realKill);
		expect(line).not.toContain("the OS reclaimed memory");
		expect(line).toContain("HEADROOM");
		expect(line).toContain("13260 MB of 15990 MB");
		expect(line).toContain("lowWaterAvailableMb=13260");
	});

	it("still blames memory when the mark says the box ran out", () => {
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 15_990, lowWaterMb: 102, lowWaterAt: "12:00:00" },
		);
		expect(line).toContain("the OS reclaimed memory");
		expect(line).not.toContain("HEADROOM");
	});

	it("keeps the [mem-watch] KILLED prefix on both verdicts", () => {
		// scripts/lib/ci-failure-classifier.mjs matches `[mem-watch] KILLED` and
		// quotes the whole line as its posted detail. Both heads must keep the
		// prefix, or a headroom kill silently loses its classification.
		for (const w of [realKill, { ...realKill, lowWaterMb: 102 }]) {
			expect(formatVerdict({ code: null, signal: "SIGKILL" }, w)).toContain(
				"[mem-watch] KILLED",
			);
		}
	});

	it("scales the exhaustion threshold with the box, not a fixed MB", () => {
		// 700 MB left is comfortable on a 16 GB runner and terminal on a 4 GB one.
		const onBigBox = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 15_990, lowWaterMb: 700, lowWaterAt: null },
		);
		const onSmallBox = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 4096, lowWaterMb: 700, lowWaterAt: null },
		);
		expect(onBigBox).toContain("the OS reclaimed memory");
		expect(onSmallBox).toContain("HEADROOM");
	});

	it("defaults to the memory verdict when the numbers are unreadable", () => {
		// Never quieter than the evidence supports: an unparsed meminfo must not
		// turn into a confident "not memory" claim.
		for (const total of [0, Number.NaN]) {
			expect(
				formatVerdict(
					{ code: null, signal: "SIGKILL" },
					{ totalMb: total, lowWaterMb: 13_260, lowWaterAt: null },
				),
			).toContain("the OS reclaimed memory");
		}
	});

	// Round-2 review F3. The fraction alone is not the rule: on a 2 GB box a
	// tenth is 205 MB, so a genuinely starved run with 300 MB left would be
	// called roomy. EXHAUSTION_AVAILABLE_FLOOR_MB is what stops that, and it was
	// unpinned — setting it to 0 left all 17 tests green.
	it("keeps a small box from being called roomy by the fraction alone", () => {
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 2048, lowWaterMb: 300, lowWaterAt: null },
		);
		expect(line).toContain("the OS reclaimed memory");
		expect(line).not.toContain("HEADROOM");
	});

	// Round-2 review F5: `<=` vs `<` at the boundary was unpinned too.
	it("counts a mark exactly at the limit as exhausted", () => {
		// 15,990 * 0.1 = 1599, above the 512 MB floor, so the limit is 1599.
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ totalMb: 15_990, lowWaterMb: 1599, lowWaterAt: null },
		);
		expect(line).toContain("the OS reclaimed memory");
		expect(line).not.toContain("HEADROOM");
	});

	// Round-2 review F4: a 2s sampler cannot rule out a faster spike, and a
	// systemd-oomd pressure kill is memory-shaped and invisible to it. The
	// verdict must state what it measured, not conclude past it.
	it("names the sampling cadence it could not see past", () => {
		const line = formatVerdict(
			{ code: null, signal: "SIGKILL" },
			{ ...realKill, intervalMs: 2000 },
		);
		expect(line).toContain("no sample fell below");
		expect(line).toContain("2000ms sampling");
		expect(line).toContain("systemd-oomd");
		expect(line).not.toContain("a worker or heap knob will not fix it");
	});

	it("leaves an ordinary failure alone whatever the headroom", () => {
		const line = formatVerdict({ code: 1, signal: null }, realKill);
		expect(line).not.toContain("HEADROOM");
		expect(line).not.toContain("the OS reclaimed memory");
		expect(line).toContain("exitCode=1");
	});
});

/**
 * #2042 2026-09-15 diagnosis, section A / (4): a 2s (now 200ms) MemAvailable
 * poll cannot see per-process RSS, PID-count churn, or PSI stall; cgroup v2
 * can. These tests build a fake `/sys/fs/cgroup` + `/proc/self/cgroup` tree so
 * the walk and the parsing are pinned without touching the real filesystem.
 */
describe("cgroup resolution (#2042 2026-09-15)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	function makeRoot(): string {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cgroup-fixture-"),
		);
		roots.push(root);
		return root;
	}

	it("walks up from /proc/self/cgroup to the first ancestor with a readable memory.events", () => {
		const root = makeRoot();
		const procCgroup = path.join(root, "proc-self-cgroup");
		fs.writeFileSync(
			procCgroup,
			"0::/system.slice/hosted-compute-agent.service/deep/leaf\n",
		);
		const cgroupRoot = path.join(root, "sys-fs-cgroup");
		const ancestorDir = path.join(
			cgroupRoot,
			"system.slice/hosted-compute-agent.service",
		);
		fs.mkdirSync(ancestorDir, { recursive: true });
		fs.writeFileSync(path.join(ancestorDir, "memory.events"), "oom 0\n");
		// The leaf itself has no memory.events (the shape cgroup v2 actually
		// produces for a delegated slice) -- only the walk finds the ancestor.
		expect(resolveCgroupDir(cgroupRoot, procCgroup)).toBe(ancestorDir);
	});

	it("returns null rather than the root when no ancestor has memory.events", () => {
		// This is the exact defect the "Runner capacity" step had: reading the
		// literal root prints nothing, because cgroup v2 never populates it. A
		// mutant that returned the root here instead of null would silently
		// resurrect that defect.
		const root = makeRoot();
		const procCgroup = path.join(root, "proc-self-cgroup");
		fs.writeFileSync(procCgroup, "0::/system.slice/some.service\n");
		const cgroupRoot = path.join(root, "sys-fs-cgroup");
		fs.mkdirSync(cgroupRoot, { recursive: true });
		expect(resolveCgroupDir(cgroupRoot, procCgroup)).toBeNull();
	});

	it("returns null when /proc/self/cgroup itself is unreadable", () => {
		const root = makeRoot();
		expect(
			resolveCgroupDir(
				path.join(root, "sys-fs-cgroup"),
				path.join(root, "does-not-exist"),
			),
		).toBeNull();
	});
});

describe("cgroup sample reading (#2042 2026-09-15)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	function makeCgroupDir(files: Record<string, string>): string {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cgroup-sample-"),
		);
		roots.push(dir);
		for (const [name, content] of Object.entries(files)) {
			fs.writeFileSync(path.join(dir, name), content);
		}
		return dir;
	}

	it("reads memory.current and memory.peak as MB, not bytes", () => {
		const dir = makeCgroupDir({
			"memory.current": `${3_251_634_176}\n`, // ~3102 MB
			"memory.peak": `${9_678_290_944}\n`, // ~9229 MB
		});
		const sample = readCgroupSample(dir);
		expect(sample.memCurrentMb).toBe(Math.round(3_251_634_176 / (1024 * 1024)));
		expect(sample.memPeakMb).toBe(Math.round(9_678_290_944 / (1024 * 1024)));
	});

	it("reads pids.current as a plain integer", () => {
		const dir = makeCgroupDir({ "pids.current": "42\n" });
		expect(readCgroupSample(dir).pidsCurrent).toBe(42);
	});

	it("reads PSI's cumulative 'some' total, not the instantaneous avg", () => {
		// A stall between two 200ms samples still shows up in the next sample
		// because `total` only ever grows -- that is the whole point of using it
		// instead of avg10, which a short spike can fall in and out of unseen.
		const dir = makeCgroupDir({
			"memory.pressure":
				"some avg10=0.00 avg60=1.50 avg300=0.80 total=123456\n" +
				"full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
			"cpu.pressure": "some avg10=12.50 avg60=8.00 avg300=2.00 total=987654\n",
		});
		const sample = readCgroupSample(dir);
		expect(sample.memPressureSomeTotal).toBe(123456);
		expect(sample.cpuPressureSomeTotal).toBe(987654);
	});

	it("reports every field as null, never throws, for a missing cgroup dir", () => {
		const sample = readCgroupSample(null);
		expect(sample).toEqual({
			memCurrentMb: null,
			memPeakMb: null,
			pidsCurrent: null,
			pidsMax: null,
			memPressureSomeTotal: null,
			cpuPressureSomeTotal: null,
		});
	});

	it("reports one missing file as null without failing the other fields", () => {
		const dir = makeCgroupDir({ "memory.current": "1048576\n" }); // 1 MB
		const sample = readCgroupSample(dir);
		expect(sample.memCurrentMb).toBe(1);
		expect(sample.memPeakMb).toBeNull();
		expect(sample.pidsCurrent).toBeNull();
	});
});

describe("sample line formatting (#2042 2026-09-15, round 2)", () => {
	it("formats every field with the millisecond stamp and a distinct [mem-sample] prefix", () => {
		// Round-2 review F1: the real 2026-09-15 CI run's tail carried 58
		// wall-clock seconds each shared by 4-5 samples at the 200ms cadence --
		// indistinguishable without milliseconds. Round-2 review F3: the prefix
		// is distinct from `[mem-watch]` on purpose (see the function's own
		// comment) -- `ci-failure-classifier.mjs` does not match it.
		const line = formatSampleLine(
			"19:02:48.203",
			{ availableMb: 4077, totalMb: 15990 },
			{
				memCurrentMb: 3102,
				memPeakMb: 9226,
				pidsCurrent: 41,
				pidsMax: "max",
				memPressureSomeTotal: 123,
				cpuPressureSomeTotal: null,
			},
			{ pidMax: 4194304, nsLastPid: 2471, fileNrAllocated: 3808 },
		);
		expect(line).toBe(
			"[mem-sample] 19:02:48.203 availableMb=4077 totalMb=15990 memCurrentMb=3102 memPeakMb=9226 " +
				"pids=41 pidsMax=max memPressureSomeTotal=123 cpuPressureSomeTotal=? " +
				"pidMax=4194304 nsLastPid=2471 fileNrAllocated=3808",
		);
	});
});
