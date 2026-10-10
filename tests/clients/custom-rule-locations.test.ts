import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	_resetRuleCorpusCycleFingerprintsForTests,
	getUserRuleRoot,
	type RuleCorpusFamily,
	ruleCorpusFingerprintForCycle,
} from "../../clients/custom-rule-locations.js";
import {
	beginTurnContext,
	runWithTurnContext,
} from "../../clients/turn-context.js";

/**
 * The shared per-dispatch-cycle rule-corpus fingerprint memo (#4212 round 4).
 *
 * Both rule families gate an in-process memo on it — the tree-sitter loader
 * (`clients/tree-sitter-query-loader.ts`) and the ast-grep source fingerprint
 * (`clients/sgconfig.ts`) — so the properties that make that safe are asserted
 * here once, at the seam, rather than twice through each caller: one compute
 * per cycle, a recompute on the next cycle, a `force` that republishes, a
 * discriminator that keeps the two families apart, and a bound that evicts
 * without ever returning a wrong value.
 */

/** Run `fn` in a fresh cycle, entered the way the pi host enters a turn. */
let cycleSessions = 0;
function inCycle<T>(fn: () => T): T {
	cycleSessions += 1;
	const session = `rule-corpus-cycle-${cycleSessions}`;
	beginTurnContext(session);
	return runWithTurnContext(session, fn);
}

/** A compute that counts its own invocations and returns a distinct value. */
function countingCompute(prefix: string): {
	fn: (root: string) => string;
	calls: () => number;
} {
	let calls = 0;
	return {
		fn: (root: string) => `${prefix}:${calls++}:${path.basename(root)}`,
		calls: () => calls,
	};
}

beforeEach(() => {
	_resetRuleCorpusCycleFingerprintsForTests();
});

describe("ruleCorpusFingerprintForCycle", () => {
	it("computes once per cycle and serves every later call in that cycle from the memo", () => {
		const compute = countingCompute("ts");
		inCycle(() => {
			const first = ruleCorpusFingerprintForCycle(
				"tree-sitter",
				"/rules-root",
				compute.fn,
			);
			for (let i = 0; i < 50; i += 1) {
				expect(
					ruleCorpusFingerprintForCycle(
						"tree-sitter",
						"/rules-root",
						compute.fn,
					),
				).toBe(first);
			}
			expect(compute.calls()).toBe(1);
		});
	});

	it("recomputes on the next cycle so a rule edit cannot outlive its turn", () => {
		const compute = countingCompute("ts");
		const first = inCycle(() =>
			ruleCorpusFingerprintForCycle("tree-sitter", "/rules-root", compute.fn),
		);
		const second = inCycle(() =>
			ruleCorpusFingerprintForCycle("tree-sitter", "/rules-root", compute.fn),
		);
		expect(compute.calls()).toBe(2);
		expect(second).not.toBe(first);
	});

	it("keeps the two rule families apart on one root", () => {
		// AGENTS.md shape 24: two writers composing one store need a
		// discriminator, or the ast-grep fingerprint would answer a tree-sitter
		// question on the same root.
		const families: RuleCorpusFamily[] = ["tree-sitter", "ast-grep"];
		const computes = new Map(families.map((f) => [f, countingCompute(f)]));
		const seen = inCycle(() =>
			families.map((family) => {
				const compute = computes.get(family) as ReturnType<
					typeof countingCompute
				>;
				return ruleCorpusFingerprintForCycle(family, "/one-root", compute.fn);
			}),
		);
		expect(seen[0]).not.toBe(seen[1]);
		for (const family of families) {
			expect(computes.get(family)?.calls()).toBe(1);
		}
	});

	it("gives each root in one cycle its own fingerprint", () => {
		const compute = countingCompute("ts");
		inCycle(() => {
			const a = ruleCorpusFingerprintForCycle(
				"tree-sitter",
				"/root-a",
				compute.fn,
			);
			const b = ruleCorpusFingerprintForCycle(
				"tree-sitter",
				"/root-b",
				compute.fn,
			);
			expect(a).not.toBe(b);
			expect(compute.calls()).toBe(2);
			expect(
				ruleCorpusFingerprintForCycle("tree-sitter", "/root-a", compute.fn),
			).toBe(a);
			expect(compute.calls()).toBe(2);
		});
	});

	it("recomputes and republishes on force, and the cycle then serves the forced value", () => {
		const compute = countingCompute("ts");
		inCycle(() => {
			const first = ruleCorpusFingerprintForCycle(
				"tree-sitter",
				"/rules-root",
				compute.fn,
			);
			// The dispatch runner forces on a RuleCache miss, which means the
			// corpus demonstrably moved: the fresh value must become the
			// cycle's value for every later consumer, not just the forcer's.
			const forced = ruleCorpusFingerprintForCycle(
				"tree-sitter",
				"/rules-root",
				compute.fn,
				true,
			);
			expect(forced).not.toBe(first);
			expect(compute.calls()).toBe(2);
			expect(
				ruleCorpusFingerprintForCycle("tree-sitter", "/rules-root", compute.fn),
			).toBe(forced);
			expect(compute.calls()).toBe(2);
		});
	});

	it("evicts past its entry cap and recomputes the evicted key correctly", () => {
		const compute = countingCompute("ts");
		inCycle(() => {
			const first = ruleCorpusFingerprintForCycle(
				"tree-sitter",
				"/root-00",
				compute.fn,
			);
			// The cap is 16 (RULE_CORPUS_CYCLE_ENTRIES): fill past it so
			// `/root-00` is the oldest entry out.
			for (let i = 1; i <= 20; i += 1) {
				ruleCorpusFingerprintForCycle(
					"tree-sitter",
					`/root-${String(i).padStart(2, "0")}`,
					compute.fn,
				);
			}
			const again = ruleCorpusFingerprintForCycle(
				"tree-sitter",
				"/root-00",
				compute.fn,
			);
			// Eviction costs a recompute; it must never hand back another
			// root's value.
			expect(again).not.toBe(first);
			expect(again).toContain("root-00");
			expect(compute.calls()).toBe(22);
		});
	});
});

describe("getUserRuleRoot", () => {
	it("resolves under PI_LENS_HOME so a relocated machine state relocates user rules", () => {
		const previous = process.env.PI_LENS_HOME;
		const home = path.join(os.tmpdir(), "pi-lens-user-rule-root-probe");
		process.env.PI_LENS_HOME = home;
		try {
			expect(getUserRuleRoot()).toBe(path.join(home, "rules"));
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previous;
		}
	});
});
