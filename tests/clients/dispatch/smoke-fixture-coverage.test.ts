/**
 * Smoke-fixture coverage drift guard (#209, requirement 4).
 *
 * `dispatch-coverage` proves every runner is wired into a PLAN. This proves every
 * runner is also exercised by the live tool-smoke harness (`scripts/smoke-tools.mjs`)
 * — i.e. has a real fixture — OR is explicitly exempted with a reason. Without
 * this, a newly-added runner gets ZERO live coverage and nothing complains
 * (the harness fixtures are hand-maintained). Adding a runner now forces a
 * decision: give it a fixture, or exempt it here.
 */

import { describe, expect, it } from "vitest";
import { RunnerRegistry } from "../../../clients/dispatch/dispatcher.js";
import { registerDefaultRunners } from "../../../clients/dispatch/runners/index.js";
// Typed via scripts/smoke-tools.d.mts (the harness itself is plain ESM JS).
import { FIXTURES } from "../../../scripts/smoke-tools.mjs";

// Runners NOT covered by a live tool-smoke fixture, each with why. Shrinking this
// set is the backlog for closing out #209's live coverage (see the follow-up
// issues). Standalone analysis clients (knip/jscpd/madge/type-coverage) aren't
// dispatch runners, so they don't appear here — tracked in their own follow-up.
const EXEMPT = new Map<string, string>([
	// Structural — run on every dispatch incidentally and/or covered by unit tests;
	// not a per-tool live target.
	["tree-sitter", "structural; runs on every dispatch"],
	["fact-rules", "structural; runs on every dispatch"],
	["ast-grep-napi", "structural; covered by ast-grep-napi unit tests"],
	["spotbugs", "dynamic group (withSpotbugsGroup); opt-in, JVM bytecode + flag-gated"],
	// Per-language ALTERNATES whose primary IS covered for that language.
	["eslint", "JS alt; oxlint covered in lint, eslint covered in --autofix"],
	["biome-check-json", "JSON biome alt"],
	["credo", "Elixir alt; elixir-check covered"],
	["detekt", "Kotlin alt to ktlint; wired+consistency-tested, live CI-deferred"],
	["golangci-lint", "Go; go-vet covered in lint, golangci-lint in --autofix"],
	// Covered via the --lsp handshake layer rather than a dispatch fixture.
	["lsp", "covered as the target across LSP fixtures"],
	["pyright", "covered via --lsp python"],
	["prisma-validate", "covered via --lsp prisma"],
	// Config-gated checkers with no fixture yet.
	["mypy", "config-gated type-checker; no fixture yet"],
	["phpstan", "config-gated; no fixture yet"],
	[
		"trivy-config",
		"IaC misconfig; trivy.enabled-gated (off by default), needs trivy + opt-in fixture",
	],
	// No live fixture yet — the remaining-linters backlog.
	["actionlint", "no fixture yet"],
	["vale", "no fixture yet"],
	["spellcheck", "no fixture yet"],
	["cpp-check", "no lint fixture yet (cpp only in --format)"],
	["fish-indent", "fish; no fixture yet"],
	// No installable Windows binary; CI-only.
	["swiftlint", "no Windows binary; CI-only"],
]);

function liveFixtureRunnerIds(): Set<string> {
	const ids = new Set<string>();
	for (const fx of FIXTURES) {
		for (const target of fx.targets ?? []) ids.add(target);
	}
	return ids;
}

function registeredRunnerIds(): string[] {
	const registry = new RunnerRegistry();
	registerDefaultRunners(registry);
	return registry.list().map((r) => r.id);
}

describe("smoke-fixture coverage", () => {
	it("every registered runner has a live tool-smoke fixture or an explicit exemption", () => {
		const covered = liveFixtureRunnerIds();
		const uncovered = registeredRunnerIds().filter(
			(id) => !covered.has(id) && !EXEMPT.has(id),
		);
		expect(
			uncovered,
			`registered runner(s) with no tool-smoke fixture and no exemption — add a fixture in scripts/smoke-tools.mjs or exempt with a reason: ${uncovered.join(", ")}`,
		).toEqual([]);
	});

	it("no stale exemptions (every exempted id is still a registered runner)", () => {
		const registered = new Set(registeredRunnerIds());
		const stale = [...EXEMPT.keys()].filter((id) => !registered.has(id));
		expect(stale, `exemption(s) for non-existent runner(s): ${stale.join(", ")}`).toEqual([]);
	});
});
