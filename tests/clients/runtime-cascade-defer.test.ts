import { describe, expect, it } from "vitest";
import type { CascadeRun } from "../../clients/cascade-types.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

function run(filePath: string, skipReason?: CascadeRun["skipReason"]): CascadeRun {
	return {
		filePath,
		result: undefined,
		neighborCount: 0,
		diagnosticCount: 0,
		skipReason: skipReason ?? "clean",
	};
}

describe("deferred cascade settle (#450)", () => {
	it("appends fulfilled runs and reports settled count", async () => {
		const runtime = new RuntimeCoordinator();
		runtime.appendCascadePromise(Promise.resolve(run("a.ts")));
		runtime.appendCascadePromise(Promise.resolve(run("b.ts")));

		const { settled, timedOut } = await runtime.settleCascadeRuns(1000);
		expect(settled).toBe(2);
		expect(timedOut).toBe(0);

		const runs = runtime.consumeCascadeRuns();
		expect(runs.map((r) => r.filePath).sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("carries a promise that resolves after the cap to the next settle", async () => {
		const runtime = new RuntimeCoordinator();
		let release!: (r: CascadeRun) => void;
		runtime.appendCascadePromise(
			new Promise<CascadeRun>((res) => {
				release = res;
			}),
		);

		// Cap of 0ms: the pending promise cannot settle in time.
		const first = await runtime.settleCascadeRuns(0);
		expect(first.settled).toBe(0);
		expect(first.timedOut).toBe(1);
		expect(runtime.consumeCascadeRuns()).toHaveLength(0);

		// It is still parked; resolving it lets the next settle pick it up.
		release(run("late.ts"));
		const second = await runtime.settleCascadeRuns(1000);
		expect(second.settled).toBe(1);
		expect(runtime.consumeCascadeRuns().map((r) => r.filePath)).toEqual([
			"late.ts",
		]);
	});

	it("settles an error skip-run without an unhandled rejection", async () => {
		const runtime = new RuntimeCoordinator();
		// The pipeline guarantees the stored promise never rejects; a failed compute
		// resolves to an "error" skip-run. Model that here.
		const skip = Promise.reject(new Error("boom")).catch(
			(): CascadeRun => run("err.ts", "error"),
		);
		runtime.appendCascadePromise(skip);

		const { settled } = await runtime.settleCascadeRuns(1000);
		expect(settled).toBe(1);
		const runs = runtime.consumeCascadeRuns();
		expect(runs[0]?.skipReason).toBe("error");
	});

	it("carries an in-flight compute ACROSS beginTurn to the next turn_end", async () => {
		// Pre-#450 a slow cascade was always awaited — findings were never lost.
		// A compute that outlives its turn's settle cap must therefore survive the
		// next beginTurn and surface at the following turn_end.
		const runtime = new RuntimeCoordinator();
		let release!: (r: CascadeRun) => void;
		runtime.appendCascadePromise(
			new Promise<CascadeRun>((res) => {
				release = res;
			}),
		);
		const first = await runtime.settleCascadeRuns(0);
		expect(first.timedOut).toBe(1);

		runtime.beginTurn(); // next turn starts — pending compute must survive
		release(run("slow-graph.ts"));
		const second = await runtime.settleCascadeRuns(1000);
		expect(second.settled).toBe(1);
		expect(runtime.consumeCascadeRuns().map((r) => r.filePath)).toEqual([
			"slow-graph.ts",
		]);
	});

	it("drops pending promises on session reset", async () => {
		const runtime = new RuntimeCoordinator();
		runtime.appendCascadePromise(
			new Promise<CascadeRun>(() => {
				// never resolves
			}),
		);
		runtime.resetForSession();
		const { settled, timedOut } = await runtime.settleCascadeRuns(0);
		expect(settled).toBe(0);
		expect(timedOut).toBe(0);
	});
});
