/**
 * Dispatch-coverage guard (#209).
 *
 * Catches the "markdownlint class" of regression: a runner that is registered
 * (and installs/runs fine) but is wired into NO dispatch plan, so it silently
 * never runs on a file write. The live tool-smoke harness only shows such a tool
 * as an ambiguous "not executed"; this deterministic, per-PR test fails loudly
 * and names the dead runner. Also catches the inverse — a plan referencing a
 * runner id that no longer exists (a silent no-op).
 *
 * Source of truth: the registry (`registerDefaultRunners`) vs the static plans.
 * Reachability is the per-write plans (`TOOL_PLANS`). Runners reached only by a
 * dynamic, non-static path are listed in DYNAMIC_OR_EXEMPT with the reason.
 */

import { describe, expect, it } from "vitest";
import { RunnerRegistry } from "../../../clients/dispatch/dispatcher.js";
import { TOOL_PLANS } from "../../../clients/dispatch/plan.js";
import { registerDefaultRunners } from "../../../clients/dispatch/runners/index.js";

// Runners reachable by a path the static plans don't capture.
const DYNAMIC_OR_EXEMPT = new Set<string>([
	// Injected by withSpotbugsGroup when --lens-spotbugs + a Java build descriptor
	// + compiled .class dir are present — never in the static plan (#133).
	"spotbugs",
]);

function registeredRunnerIds(): string[] {
	const registry = new RunnerRegistry();
	registerDefaultRunners(registry);
	return registry.list().map((r) => r.id);
}

function plannedRunnerIds(): Set<string> {
	const ids = new Set<string>();
	for (const plan of Object.values(TOOL_PLANS)) {
		for (const group of plan.groups) {
			for (const id of group.runnerIds) ids.add(id);
		}
	}
	return ids;
}

describe("dispatch coverage", () => {
	it("every registered runner is reachable by some dispatch plan (no dead runners)", () => {
		const planned = plannedRunnerIds();
		const dead = registeredRunnerIds().filter(
			(id) => !planned.has(id) && !DYNAMIC_OR_EXEMPT.has(id),
		);
		expect(
			dead,
			`registered but wired into no dispatch plan (markdownlint-class regression): ${dead.join(", ")}`,
		).toEqual([]);
	});

	it("every runner id referenced by a plan is actually registered (no phantom runners)", () => {
		const registered = new Set(registeredRunnerIds());
		const phantom = [...plannedRunnerIds()].filter(
			(id) => !registered.has(id),
		);
		expect(
			phantom,
			`plan references unregistered runner id(s): ${phantom.join(", ")}`,
		).toEqual([]);
	});
});
