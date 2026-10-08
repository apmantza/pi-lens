import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	LOCAL_WORKER_CAP,
	MAX_WORKER_HEAP_MB,
	MIN_WORKER_HEAP_MB,
	NON_WORKER_RESERVE_MB,
	WORKER_PEAK_RSS_BUDGET_MB,
	formatTestWorkerBudget,
	resolveTestWorkerBudget,
} from "../../scripts/lib/worker-budget.mjs";
// The REAL config object, not its source text — same reasoning as
// tests/config/timing-sensitive-coverage.test.ts, including the explicit `.ts`:
// the `.js` spelling resolves to the gitignored COMPILED vitest.config.js that
// `npm run build` emits, so this guard would read a stale config.
import vitestConfig from "../../vitest.config.ts";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The same host object vitest.config.ts builds, so the resolution matches. */
function currentHost() {
	return {
		totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
		cpus: os.availableParallelism?.() ?? os.cpus().length,
		ci: Boolean(process.env.CI),
		workerOverride: Number(process.env.PI_LENS_TEST_MAX_WORKERS) || undefined,
		heapOverride: Number(process.env.PI_LENS_TEST_WORKER_HEAP_MB) || undefined,
	};
}

function project(name: string) {
	const projects: unknown = vitestConfig.test?.projects;
	if (!Array.isArray(projects)) {
		throw new Error("vitest.config.ts default export has no test.projects");
	}
	const found = projects
		.map(
			(entry) =>
				(
					entry as {
						test?: {
							name?: unknown;
							maxWorkers?: unknown;
							execArgv?: unknown;
						};
					}
				)?.test,
		)
		.find((test) => test?.name === name);
	if (!found) throw new Error(`vitest.config.ts has no project "${name}"`);
	return found;
}

describe("test worker budget (#2042)", () => {
	it("lets the memory budget bind when a host has more cores than RAM", () => {
		// 8 GB, 16 cores. Vitest's own default would hand this host 15 forks; the
		// suite's measured p99 peak is 1405 MB per fork, so 15 of them is a
		// SIGKILL. Memory, not core count, has to win.
		const budget = resolveTestWorkerBudget({
			totalMemMb: 8192,
			cpus: 16,
			ci: true,
		});
		expect(budget.cpuCap).toBe(15);
		expect(budget.memCap).toBe(
			Math.floor((8192 - NON_WORKER_RESERVE_MB) / WORKER_PEAK_RSS_BUDGET_MB),
		);
		expect(budget.maxWorkers).toBe(budget.memCap);
		expect(budget.maxWorkers).toBeLessThan(budget.cpuCap);
	});

	it("never raises concurrency above vitest's own core-derived default", () => {
		// 256 GB, 4 cores. Plenty of memory must not buy extra forks: the cap is
		// the MINIMUM of the two, never the memory figure alone.
		const budget = resolveTestWorkerBudget({
			totalMemMb: 262_144,
			cpus: 4,
			ci: true,
		});
		expect(budget.memCap).toBeGreaterThan(budget.cpuCap);
		expect(budget.maxWorkers).toBe(budget.cpuCap);
		expect(budget.maxWorkers).toBe(3);
	});

	it("resolves a CI number, never undefined (the #2042 regression)", () => {
		// Pre-fix, vitest.config.ts set `maxWorkers: undefined` under CI and let
		// vitest fall back to `availableParallelism() - 1`, so nothing in the repo
		// expressed a memory budget at all. Any host must now produce a number.
		for (const [totalMemMb, cpus] of [
			[7168, 2],
			[16_384, 4],
			[65_536, 32],
		]) {
			const budget = resolveTestWorkerBudget({ totalMemMb, cpus, ci: true });
			expect(typeof budget.maxWorkers, `${totalMemMb}MB/${cpus}cpu`).toBe(
				"number",
			);
			expect(budget.maxWorkers).toBeGreaterThanOrEqual(1);
		}
	});

	it("keeps at least one worker on a host too small for the budget", () => {
		const budget = resolveTestWorkerBudget({
			totalMemMb: 2048,
			cpus: 1,
			ci: true,
		});
		expect(budget.maxWorkers).toBe(1);
		expect(budget.heavyMaxWorkers).toBe(1);
	});

	it("runs the heavy phase at or below the general concurrency", () => {
		for (const [totalMemMb, cpus] of [
			[7168, 2],
			[16_384, 4],
			[32_768, 8],
		]) {
			const budget = resolveTestWorkerBudget({ totalMemMb, cpus, ci: true });
			expect(
				budget.heavyMaxWorkers,
				`${totalMemMb}MB/${cpus}cpu`,
			).toBeLessThanOrEqual(budget.maxWorkers as number);
			expect(budget.heavyMaxWorkers).toBeGreaterThanOrEqual(1);
		}
	});

	it("runs the heavy phase STRICTLY below the general cap when it can", () => {
		// The ordering test above accepts equality, so it passes for a resolver
		// that never halves anything. This one pins the halving itself: wherever
		// the general cap is 2 or more, the heavy phase must be strictly smaller.
		// Mutating `Math.floor(ciWorkers / 2)` to `ciWorkers` reds exactly here.
		for (const [totalMemMb, cpus] of [
			[16_384, 4],
			[16_384, 3],
			[32_768, 8],
			[65_536, 32],
		]) {
			const budget = resolveTestWorkerBudget({ totalMemMb, cpus, ci: true });
			const where = `${totalMemMb}MB/${cpus}cpu`;
			expect(budget.maxWorkers, where).toBeGreaterThanOrEqual(2);
			expect(budget.heavyMaxWorkers, where).toBeLessThan(
				budget.maxWorkers as number,
			);
		}
	});

	it("keeps the local heavy phase at 2 on any core count", () => {
		// Deriving this from core count silently moved a 1-3 core dev box to 1.
		// The local posture is the pre-#2042 literal, and it does not vary.
		for (const cpus of [1, 2, 3, 4, 8, 16]) {
			expect(
				resolveTestWorkerBudget({ totalMemMb: 65_536, cpus, ci: false })
					.heavyMaxWorkers,
				`${cpus}cpu`,
			).toBe(2);
		}
	});

	it("holds the per-fork heap ceiling between its correctness floor and cap", () => {
		for (const [totalMemMb, cpus] of [
			[2048, 1],
			[7168, 2],
			[16_384, 4],
			[65_536, 32],
			[262_144, 64],
		]) {
			const budget = resolveTestWorkerBudget({ totalMemMb, cpus, ci: true });
			const where = `${totalMemMb}MB/${cpus}cpu`;
			// The floor is not a budget number: one real file holds 2067 MB of live
			// V8 heap, so a smaller ceiling turns a green suite red.
			expect(budget.heapMb, where).toBeGreaterThanOrEqual(MIN_WORKER_HEAP_MB);
			expect(budget.heapMb, where).toBeLessThanOrEqual(MAX_WORKER_HEAP_MB);
		}
	});

	it("drops the heap ceiling below its cap on a memory-tight CI host", () => {
		// The pre-#2042 value was a flat 4096 MB per fork on every host, with the
		// comment "4 GB x workers << host RAM" — true on the 68 GB dev host it was
		// measured on, false on a CI runner. A 16 GB / 4-core runner must now come
		// out lower.
		const budget = resolveTestWorkerBudget({
			totalMemMb: 16_384,
			cpus: 4,
			ci: true,
		});
		expect(budget.heapMb).toBeLessThan(MAX_WORKER_HEAP_MB);
	});

	it("keeps the full ceiling when the host has room for it", () => {
		// >= 2 x MAX_WORKER_HEAP_MB of memory per concurrent fork.
		const budget = resolveTestWorkerBudget({
			totalMemMb: 65_536,
			cpus: 5,
			ci: true,
		});
		expect(budget.maxWorkers).toBe(4);
		expect(budget.heapMb).toBe(MAX_WORKER_HEAP_MB);
	});

	it("leaves the local posture unchanged", () => {
		// The measured 2026-07-29 local settings, which #2042 must not disturb:
		// "50%" forks, 4096 MB heap, heavy phase capped at 2.
		const budget = resolveTestWorkerBudget({
			totalMemMb: 65_536,
			cpus: 16,
			ci: false,
		});
		expect(budget.maxWorkers).toBe("50%");
		expect(budget.heapMb).toBe(4096);
		expect(budget.heavyMaxWorkers).toBe(2);
	});

	it("caps a local host whose half is above the measured fork count", () => {
		// "50%" was 8 forks on the 16-thread host above. On a wider host it
		// counts hyperthreads and efficiency cores as if they were fast cores.
		for (const cpus of [17, 24, 32, 64]) {
			expect(
				resolveTestWorkerBudget({ totalMemMb: 65_536, cpus, ci: false })
					.maxWorkers,
				`${cpus}cpu`,
			).toBe(LOCAL_WORKER_CAP);
		}
	});

	it("never raises a smaller local host to the cap", () => {
		for (const cpus of [1, 2, 4, 8, 16]) {
			expect(
				resolveTestWorkerBudget({ totalMemMb: 65_536, cpus, ci: false })
					.maxWorkers,
				`${cpus}cpu`,
			).toBe("50%");
		}
	});

	it("lets the explicit override exceed the local cap", () => {
		expect(
			resolveTestWorkerBudget({
				totalMemMb: 65_536,
				cpus: 24,
				ci: false,
				workerOverride: 12,
			}).maxWorkers,
		).toBe(12);
	});

	it("pins the local cap to its measurement", () => {
		const measurement = JSON.parse(
			fs.readFileSync(
				path.join(repoRoot, "tests/fixtures/local-worker-cap-measurement.json"),
				"utf8",
			),
		) as {
			recommendedLocalWorkerCap: number;
			runs: Array<{
				workers: number;
				wallSeconds: number;
				cpuSeconds: number;
				peakBusyCores: number;
			}>;
		};
		expect(LOCAL_WORKER_CAP).toBe(measurement.recommendedLocalWorkerCap);
		const at = (pick: (workers: number) => boolean) => {
			const row = measurement.runs.find((run) => pick(run.workers));
			if (!row) throw new Error("the measurement lost a row the cap rests on");
			return row;
		};
		const cap = at((workers) => workers === LOCAL_WORKER_CAP);
		const more = at((workers) => workers > LOCAL_WORKER_CAP);
		const fewer = at((workers) => workers < LOCAL_WORKER_CAP);
		// More forks: a higher peak and more CPU for the wall time they save.
		expect(more.peakBusyCores).toBeGreaterThan(cap.peakBusyCores);
		expect(more.cpuSeconds).toBeGreaterThan(cap.cpuSeconds);
		// Fewer forks: no lower peak, and a longer run.
		expect(fewer.peakBusyCores).toBeGreaterThanOrEqual(cap.peakBusyCores);
		expect(fewer.wallSeconds).toBeGreaterThan(cap.wallSeconds);
	});

	it("honours the explicit local overrides", () => {
		const budget = resolveTestWorkerBudget({
			totalMemMb: 65_536,
			cpus: 16,
			ci: false,
			workerOverride: 6,
			heapOverride: 3500,
		});
		expect(budget.maxWorkers).toBe(6);
		expect(budget.heapMb).toBe(3500);
	});

	it("names the host and the decision in one line", () => {
		const host = { totalMemMb: 16_384, cpus: 4 };
		const line = formatTestWorkerBudget(
			host,
			resolveTestWorkerBudget({ ...host, ci: true }),
		);
		expect(line).toMatch(/^\[test-budget\] /);
		for (const field of [
			"cpus=",
			"totalMemMb=",
			"maxWorkers=",
			"heavyMaxWorkers=",
			"workerHeapMb=",
		]) {
			expect(line, `line must carry ${field}`).toContain(field);
		}
	});
});

describe("vitest.config.ts wiring (#2042)", () => {
	// Asserting the ambient resolution would be vacuous on a developer's machine:
	// off CI the resolver returns exactly the pre-#2042 values ("50%", 4096, 2),
	// so a config that never called it would still pass. Re-import the config
	// with CI forced on, where the pre-fix and post-fix values differ.
	async function ciConfig() {
		vi.stubEnv("CI", "1");
		vi.resetModules();
		try {
			const loaded = await import("../../vitest.config.ts");
			return loaded.default;
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	}

	function ciProject(config: unknown, name: string) {
		const projects = (config as { test?: { projects?: unknown[] } })?.test
			?.projects;
		if (!Array.isArray(projects)) throw new Error("no test.projects");
		const found = projects
			.map(
				(entry) =>
					(
						entry as {
							test?: {
								name?: unknown;
								maxWorkers?: unknown;
								execArgv?: unknown;
							};
						}
					)?.test,
			)
			.find((test) => test?.name === name);
		if (!found) throw new Error(`no project "${name}"`);
		return found;
	}

	it("takes both worker caps from the resolver under CI", async () => {
		const host = { ...currentHost(), ci: true };
		const budget = resolveTestWorkerBudget(host);
		const config = await ciConfig();
		// Pre-fix this was `undefined` — vitest's own core-derived fallback, with
		// no memory budget expressed anywhere.
		expect(ciProject(config, "default").maxWorkers).toEqual(budget.maxWorkers);
		expect(typeof ciProject(config, "default").maxWorkers).toBe("number");
		// Pre-fix this was a hardcoded 2 on every host.
		expect(ciProject(config, "grammar-heavy").maxWorkers).toEqual(
			budget.heavyMaxWorkers,
		);
	});

	it("gives every project the derived heap ceiling under CI", async () => {
		const budget = resolveTestWorkerBudget({ ...currentHost(), ci: true });
		const config = await ciConfig();
		const expected = [`--max-old-space-size=${budget.heapMb}`];
		for (const name of [
			"default",
			"grammar-heavy",
			"timing-sensitive",
			"lsp-spawn-heavy",
			"wall-clock-budget",
		]) {
			expect(ciProject(config, name).execArgv, name).toEqual(expected);
		}
	});

	it("matches the resolver on whatever host is running it", () => {
		// The ambient resolution, CI or not. Deliberately NOT forced to `ci: false`
		// — the config reads the real `process.env.CI`, so pinning the expectation
		// to the local branch asserts a posture the config was never asked for and
		// fails on CI (it did, run 32899910007: expected 3 to equal "50%"). The
		// local posture itself is asserted against the resolver directly, above.
		const budget = resolveTestWorkerBudget(currentHost());
		expect(project("default").maxWorkers).toEqual(budget.maxWorkers);
		expect(project("default").execArgv).toEqual([
			`--max-old-space-size=${budget.heapMb}`,
		]);
	});
});

describe("CI memory attribution (#2042)", () => {
	const ci = fs.readFileSync(
		path.join(repoRoot, ".github/workflows/ci.yml"),
		"utf8",
	);

	it("runs the Unit-tests suite under the memory watch", () => {
		// Without the wrapper an OOM kill prints `Killed` and exit 137 and names
		// nothing, which is what made this class read as infrastructure noise.
		expect(ci).toContain("node scripts/with-memory-watch.mjs -- npm test");
	});

	it("records the runner's capacity before the suite runs", () => {
		expect(ci).toContain("Runner capacity");
		expect(ci).toContain("free -m");
		expect(ci).toContain("nproc");
	});

	// #2042 round 2: the low-water mark proved the box was not short of memory
	// on three real kills, but it cannot name what sent the SIGKILL. The kernel
	// can, and only while the runner is still alive — so the record has to be
	// taken inside the job, on failure.
	it("asks the kernel who sent the kill when the job fails", () => {
		expect(ci).toContain("Kernel kill evidence");
		expect(ci).toContain("dmesg");
		expect(ci).toContain("systemd-oomd");
	});

	it("gates the kernel evidence on failure, so a green run stays quiet", () => {
		const step = ci.slice(ci.indexOf("Kernel kill evidence"));
		expect(step.slice(0, 200)).toContain("if: failure()");
	});

	// Round-2 review F1: `cat /sys/fs/cgroup/memory.events` reads the ROOT
	// cgroup, which cgroup v2 never populates. It printed nothing whether or not
	// an event had occurred, so no reading of it could support a claim either
	// way. The step has to resolve the job's own cgroup.
	it("reads the job's own cgroup, not the unpopulated root", () => {
		expect(ci).toContain("/proc/self/cgroup");
		expect(ci).not.toContain("cat /sys/fs/cgroup/memory.events");
	});

	// Round-2 review F1/F2: every arm must distinguish "asked, nothing there"
	// from "could not ask". Silence reads as the first and can be the second.
	it("marks each evidence arm when it could not be read", () => {
		const step = ci.slice(ci.indexOf("Kernel kill evidence"));
		expect(step).toContain("dmesg unavailable or empty");
		expect(step).toContain("zero OOM/kill records");
		expect(step).toContain("journalctl unavailable");
		expect(step).toContain("memory.events absent or unreadable");
	});
});

// #2042 2026-09-15 diagnosis, section A: the cheapest probe.
describe("CI cheapest-probe wiring (#2042 2026-09-15)", () => {
	const ci = fs.readFileSync(
		path.join(repoRoot, ".github/workflows/ci.yml"),
		"utf8",
	);
	const tailStepMarker = "- name: Memory sample tail";
	const runTestsStep = ci.slice(
		ci.indexOf("- name: Run tests"),
		ci.indexOf(tailStepMarker),
	);
	// Bounded to this ONE step's own body, not left open to end-of-file --
	// round-2 review self-catch: an earlier version of this slice ran to EOF
	// and a `not.toContain('cat "$f"')` assertion tripped on an unrelated
	// `cat "$f"` in a wholly different job later in ci.yml.
	const tailStep = ci.slice(
		ci.indexOf(tailStepMarker),
		ci.indexOf("- name: Kernel kill evidence"),
	);

	it("samples five times faster than the 2s default that could miss a spike", () => {
		// The env var already existed (PI_LENS_MEM_WATCH_INTERVAL_MS); only the
		// CI value is new. A 2s poll cannot see a sub-2-second spike -- that gap
		// is exactly what every "H4 untested" line in the diagnosis names.
		expect(runTestsStep).toContain("PI_LENS_MEM_WATCH_INTERVAL_MS: '200'");
	});

	it("shares one sample-file path between the writer and the reader step", () => {
		const pathPattern = /PI_LENS_MEM_WATCH_SAMPLE_FILE:\s*(.+)/;
		const writerPath = pathPattern.exec(runTestsStep)?.[1]?.trim();
		const readerPath = pathPattern.exec(tailStep)?.[1]?.trim();
		expect(writerPath, "Run tests must set the sample file path").toBeTruthy();
		expect(writerPath).toBe(readerPath);
	});

	// The master 1701d01 red lost its low-water line entirely because the
	// WRAPPER was the process killed -- a step gated on failure() alone would
	// never run if the job never reaches a later step in some future reorder,
	// but `if: always()` is what makes it survive that AND a cancelled job.
	it("tails the sample file from an if: always() step, so a killed run still yields it", () => {
		expect(ci).toContain(tailStepMarker);
		expect(tailStep.slice(0, 120)).toContain("if: always()");
	});

	// #2230 round 2 F1 fixed the identical defect on "Kernel kill evidence"
	// four lines away; this is the sibling that stayed broken until 2026-09-15
	// (the diagnosis's own "(4) what it cannot prove" section).
	it("resolves Runner capacity's memory.max through the job's own cgroup, not the unpopulated root", () => {
		const step = ci.slice(
			ci.indexOf("Runner capacity"),
			ci.indexOf("- name: Run tests"),
		);
		expect(step).toContain("/proc/self/cgroup");
		expect(step).not.toContain(
			"cat /sys/fs/cgroup/memory.max 2>/dev/null || true",
		);
	});

	// Round-2 review F2: the sample file is append-only and therefore
	// unbounded on disk (deliberately -- see scripts/with-memory-watch.mjs's
	// own comment), so the ONLY place output volume is bounded is this read
	// step. `cat` on an hours-long run would flood the job log; `tail` is the
	// bound.
	it("bounds what the tail step PRINTS with tail -n, not what the sampler writes", () => {
		expect(tailStep).toContain('tail -n 300 "$f"');
		expect(tailStep).not.toContain('cat "$f"');
	});
});
