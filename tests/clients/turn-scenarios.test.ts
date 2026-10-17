/**
 * The turn-simulation harness's seed scenarios — #1635 item 1.
 *
 * Four dogfood incidents from 2026-08-18, each replayed as a scripted turn
 * sequence against `handleTurnEnd`, asserting what the AGENT SEES.
 *
 * ## Why some of these are skipped
 *
 * A scenario asserts the CORRECT behavior, always. When the fix for that
 * incident is not on master yet, the scenario carries `pendingOn` and is
 * skipped. It is never rewritten to assert the buggy behavior — a suite that
 * encodes today's bug as today's expectation defends the bug, and the fix then
 * arrives looking like a regression.
 *
 * That also makes the redness proof trivial and honest for the pending ones:
 * delete the `pendingOn` line, run the file, and the scenario fails on current
 * master because the defect is still there. See the PR body for the captured
 * output of each.
 *
 * `skipWhen` is a different thing and says so: the fix exists and the scenario
 * runs, but this host does not have the tool it drives (scenario 2 shells out
 * to a real knip).
 *
 * Live as of this revision: scenario 1 (#1627 merged), scenario 2 (#1637
 * merged 2026-08-18) and scenario 3 (#1633 merged 2026-08-19). Pending:
 * scenario 4 on nothing — that blind spot has no fix in flight.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KnipClient } from "../../clients/knip-client.js";
import { resetProjectTrust } from "../../clients/project-trust.js";
import {
	defineTurnScenario,
	runTurnScenario,
	type TurnScenario,
} from "../support/turn-harness.js";

// ── Scenario 1 — gitleaks stale replay (#1622, fixed by PR #1627) ────────────

const gitleaksStaleReplay = defineTurnScenario({
	id: "gitleaks-stale-replay",
	incident:
		"gitleaks flagged src:397, the agent edited that file, and the STOP blocker kept citing 397 for the rest of the 30-minute TTL",
	issue: "#1622",
	async run(h) {
		h.write("src/config.ts", "const key = 'AKIA0000000000000000';\n");
		h.advance(1_000);
		h.edit("src/app.ts", "export const app = 1;\n");
		h.scan("gitleaks", {
			findings: [
				{
					ruleId: "aws-access-token",
					file: h.pathOf("src/config.ts"),
					startLine: 397,
					description: "AWS key",
				},
			],
		});

		// Turn 1: nothing has moved since the scan, so the credential is a
		// full-severity blocker with its coordinate intact.
		const first = await h.turnEnd();
		expect(first.blockers.join("\n")).toContain("hardcoded secrets detected");
		expect(first.text).toContain("src/config.ts:397");

		// Turn 2: the agent edits the cited file. The line number is now a claim
		// about a file revision that no longer exists.
		h.advance(5_000);
		h.edit("src/config.ts", "const key = process.env.AWS_KEY;\n");
		const second = await h.turnEnd();

		// Demoted, not dropped: an edit must never mute a real credential.
		expect(second.blockers.join("\n")).not.toContain(
			"hardcoded secrets detected",
		);
		expect(second.actionNeeded.join("\n")).toContain("src/config.ts");
		expect(second.text).not.toContain(":397");
	},
});

// ── Scenario 2 — knip stale cache (#1630, fixed by PR #1637) ─────────────────

/**
 * knip is a real binary this scenario shells out to, through the REAL
 * `KnipClient`. Review round R1 (S4) was right that the first cut could never
 * fail the way #1630 fails: it replaced the whole client with a stub, and
 * #1637's fix — pruning knip's glob cache before each run — lives inside
 * `KnipClient.analyze`, the layer the stub removed.
 *
 * The availability probe mirrors `tests/clients/knip-cache-consumer-staleness.ts`'s:
 * the suite redirects `PI_LENS_HOME` to a per-worker temp dir, so the managed
 * install has to be found through the real home directory and put on PATH.
 */
const managedKnipBinDir = (() => {
	const dir = path.join(
		os.homedir(),
		".pi-lens",
		"tools",
		"node_modules",
		".bin",
	);
	return fs.existsSync(dir) ? dir : null;
})();

// CI and the pre-push hook have no managed install, and their only knip is this
// checkout's own devDependency: a bare `knip` reaches it only when
// `node_modules/.bin` is on PATH, which `npm test` arranges and a direct vitest
// run does not. Name it so both environments drive the same binary (#4566 CI red).
const checkoutKnipBinDir = (() => {
	const dir = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"node_modules",
		".bin",
	);
	return fs.existsSync(path.join(dir, "knip")) ? dir : null;
})();

const knipBinDir = managedKnipBinDir ?? checkoutKnipBinDir;

/**
 * Probe the BINARY, not the directory that usually holds it.
 *
 * The managed-tools directory can exist while knip itself is absent — a host
 * that installed some other managed tool, or a first run that has not lazily
 * installed knip yet. A directory-existence check calls that "available", the
 * scenario then runs against a client whose `analyze` returns an availability
 * failure with no findings, and the baseline assertion fails for a reason that
 * has nothing to do with the defect. Spawning `knip --version` with the same
 * PATH the scenario will use answers the question that actually matters.
 */
function knipUnavailableReason(): string | undefined {
	const env = { ...process.env };
	if (knipBinDir) {
		env.PATH = `${knipBinDir}${path.delimiter}${env.PATH ?? ""}`;
	}
	try {
		if (
			spawnSync("knip", ["--version"], {
				shell: process.platform === "win32",
				encoding: "utf8",
				env,
			}).status === 0
		) {
			return undefined;
		}
	} catch {
		// fall through to the skip reason
	}
	return "knip is not runnable on this host";
}

const knipStaleCache = defineTurnScenario({
	id: "knip-stale-unused-export",
	incident:
		"pi-lens warned that assertSafeForCmdShell was unused while a test in the same tree imported it; a direct knip run returned 0 hits",
	issue: "#1630",
	skipWhen: knipUnavailableReason,
	harnessOptions: () => ({ knipClient: new KnipClient(false) }),
	async run(h) {
		const originalPath = process.env.PATH;
		if (knipBinDir) {
			process.env.PATH = `${knipBinDir}${path.delimiter}${originalPath ?? ""}`;
		}
		// #4566 F6: keep unknown trust on the fixture; the test toolchain
		// belongs to the checkout outside it.
		const originalCwd = process.cwd();
		process.chdir(h.cwd);
		try {
			h.write(
				"package.json",
				JSON.stringify({
					name: "knip-1630-scenario",
					version: "1.0.0",
					private: true,
					type: "module",
				}),
			);
			h.write(
				"knip.json",
				JSON.stringify({
					entry: ["src/index.ts", "tests/**/*.test.ts"],
					project: ["src/**/*.ts", "tests/**/*.ts"],
				}),
			);
			h.write(
				"src/util.ts",
				"export function assertSafeForCmdShell(s: string): string { return s; }\n" +
					'export function used(): string { return "x"; }\n',
			);
			h.write(
				"src/index.ts",
				'import { used } from "./util.js";\nconsole.log(used());\n',
			);
			// `tests/` exists but matches nothing when the cache is written — the
			// exact shape knip's glob cache failed to revalidate.
			fs.mkdirSync(h.pathOf("tests"), { recursive: true });

			// Prime knip's own incremental cache while nothing imports the symbol.
			// This is the session's earlier scan, out of band from any turn.
			const client = h.knipClient as KnipClient;
			const primed = await client.analyze(h.cwd);
			expect(
				primed.unusedExports.map((e) => e.name),
				`baseline: knip should flag the export while nothing imports it (success=${primed.success}, summary=${primed.summary})`,
			).toContain("assertSafeForCmdShell");

			// The consumer appears AFTER that scan. The declaring file's mtime does
			// not move, which is why #1622's per-cited-path freshness gate cannot
			// see this: "unused export" is a whole-graph property.
			h.advance(10_000);
			h.write(
				"tests/consumer.test.ts",
				'import { assertSafeForCmdShell } from "../src/util.js";\n' +
					'export const t = assertSafeForCmdShell("a");\n',
			);

			// The agent edits the declaring file, and the turn re-runs knip.
			h.advance(1_000);
			h.edit(
				"src/util.ts",
				"export function assertSafeForCmdShell(s: string): string { return s.trim(); }\n" +
					'export function used(): string { return "x"; }\n',
			);
			const view = await h.turnEnd();

			// The agent must not be told a symbol is unused when the current source
			// tree contains an importer of it.
			expect(view.text).not.toContain("assertSafeForCmdShell");
		} finally {
			process.env.PATH = originalPath;
			process.chdir(originalCwd);
			resetProjectTrust();
		}
	},
});

// ── Scenario 3 — dependency-drift replay (#1631, fixed by PR #1633) ──────────

const dependencyDriftReplay = defineTurnScenario({
	id: "dependency-drift-replay",
	incident:
		"a blocker on the consumer file replayed for 50 minutes after the missing export was added to its dependency by a bash script",
	issue: "#1631",
	async run(h) {
		h.write("src/worktree.ts", "export const other = 1;\n");
		h.edit(
			"tests/git-env.test.ts",
			"import { gitEnv } from '../src/worktree.js';\ngitEnv();\n",
		);
		h.blocker(
			"tests/git-env.test.ts",
			"TS2305: Module '\"../src/worktree\"' has no exported member 'gitEnv'.",
		);

		// Turn 1: the blocker is true at this instant.
		const first = await h.turnEnd();
		expect(first.blockers.join("\n")).toContain("gitEnv");

		// The export lands via a bash script — the dependency file is never
		// dispatched, so no existing invalidation event can fire.
		h.advance(17_000);
		h.write(
			"src/worktree.ts",
			"export const other = 1;\nexport function gitEnv() {}\n",
		);

		// Turn 2: an unrelated edit ends the turn.
		h.advance(1_000);
		h.edit("src/unrelated.ts", "export const x = 1;\n");
		const second = await h.turnEnd();

		// The consumer's cached verdict is a claim about its import closure. That
		// closure changed, so the verdict must be revalidated or demoted — never
		// re-served verbatim as a STOP-tier blocker.
		expect(second.blockers.join("\n")).not.toContain(
			"has no exported member 'gitEnv'",
		);
	},
});

// ── Scenario 4 — advisory-provenance file-set blind spot ─────────────────────

const provenanceFileSetBlindSpot = defineTurnScenario({
	id: "advisory-provenance-file-set",
	incident:
		'a whole-graph advisory kept validating as "current" because provenance only captured the declaring file, never the consumer set whose change made the claim false',
	issue: "#1630 (analysis section); no fix issue of its own yet",
	pendingOn:
		"unfixed — provenance validates only the captured file set, so a change outside it cannot be seen",
	async run(h) {
		h.edit("src/cmd.ts", "export function assertSafeForCmdShell() {}\n");

		// The advisory is "assertSafeForCmdShell is unused" — a claim about every
		// file in the project. Provenance captures the declaring file alone.
		const verdict = h.provenanceStatus([{ relative: "src/cmd.ts" }], () => {
			h.advance(10_000);
			h.write(
				"tests/cmd.test.ts",
				"import { assertSafeForCmdShell } from '../src/cmd.js';\n",
			);
		});

		// A file the claim depends on changed. "current" is a false statement of
		// freshness, not a true one about the captured set.
		expect(verdict.status).not.toBe("current");
	},
});

/** Every seed scenario, in incident order. */
export const SEED_SCENARIOS: TurnScenario[] = [
	gitleaksStaleReplay,
	knipStaleCache,
	dependencyDriftReplay,
	provenanceFileSetBlindSpot,
];

describe("turn-simulation harness seed scenarios (#1635 item 1)", () => {
	for (const scenario of SEED_SCENARIOS) {
		const title = `${scenario.id} (${scenario.issue}) — ${scenario.incident}`;
		if (scenario.pendingOn) {
			it.skip(`${title} [pending: ${scenario.pendingOn}]`, async () => {
				await runTurnScenario(scenario);
			});
			continue;
		}
		// `skipWhen` is evaluated at collection time so the reason reaches the
		// report. It answers a different question from `pendingOn`: the fix
		// exists, this host just lacks the tool the scenario drives.
		const absent = scenario.skipWhen?.();
		it.skipIf(absent !== undefined)(
			absent ? `${title} [skipped: ${absent}]` : title,
			async () => {
				await runTurnScenario(scenario);
			},
			120_000,
		);
	}

	// The skip list is the honest part of this file, so it is itself asserted:
	// a scenario is either live or carries a reason naming what blocks it.
	it("every pending scenario names what blocks it", () => {
		for (const scenario of SEED_SCENARIOS) {
			if (!scenario.pendingOn) continue;
			expect(scenario.pendingOn.length).toBeGreaterThan(20);
			expect(scenario.pendingOn).toMatch(/#\d+|unfixed/);
		}
	});

	it("seeds all four 2026-08-18 incidents", () => {
		expect(SEED_SCENARIOS.map((s) => s.id)).toEqual([
			"gitleaks-stale-replay",
			"knip-stale-unused-export",
			"dependency-drift-replay",
			"advisory-provenance-file-set",
		]);
	});
});
