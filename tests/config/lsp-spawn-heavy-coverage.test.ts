/**
 * #2344 — lsp-spawn-heavy Vitest project coverage.
 *
 * The `lsp-spawn-heavy` project (vitest.config.ts, maxWorkers: 1, dead-last
 * phase) exists for tests that spawn a REAL LSP child process and wait on its
 * initialize handshake or first diagnostics — budgets the default project's
 * fork storm can starve (#1022: ast-grep's first-scan rule-set compile lands
 * inside the wait; #2332/#2340: nine contention failures on the real-wire
 * workspace-sweep bracket). Its membership was CONVENTION until the #2340
 * review: nothing mechanically stopped a new spawning test from landing in the
 * default project at `maxWorkers: "50%"`, which is exactly how #2340 shipped
 * and "cured" its failures with a serialized re-run instead of the lane.
 *
 * This file is that sweep, registered-or-fail in the #2088 floor family. It
 * derives candidacy from the real test-source seams, never from a
 * hand-maintained list:
 *
 *  - a call-shaped `launchLSP(` — the child boundary in
 *    `clients/lsp/launch.js`. Tests that `vi.mock` the launch module never
 *    contain a bare call (they stub the seam), so they stay out of the census
 *    for free;
 *  - a `getServerById(` registry lookup that spawns a registered production
 *    server (the ast-grep LSP case);
 *  - an import of the `tests/fixtures/fake-lsp-server.mjs` fixture, whose only
 *    purpose is being launched — every current importer launches it.
 *
 * Every candidate must be in `lspSpawnHeavyInclude` or carry a documented
 * exemption ([SPAWN_EXEMPTIONS]) stating why it stays in the default project:
 * already-routed-out (integrationInclude), a seam's own unit test, or a wire
 * interaction with no handshake-plus-first-diagnostics budget for contention
 * to flip. `auditRegistry` supplies the two floors (an empty walk or an empty
 * census fails loud, defect shape 10), requires a real reason per exemption,
 * and reds a stale exemption (#1735).
 *
 * Known marker gap, named rather than papered over: the opt-in live suites
 * (`*.integration.test.ts` that strays outside `integrationInclude`, e.g.
 * typescript-classic-repair / typescript-document-symbol / typescript-native-
 * vitest) spawn a REAL TypeScript server through `TypeScriptServer.spawn(...)`
 * with NO `launchLSP(`/`getServerById(`/fixture reference, so neither marker
 * catches them. They run only with `PI_LENS_INTEGRATION=1` and skip otherwise;
 * their membership target belongs to a live-suite owner, not this lane.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toPosix } from "../../clients/path-utils.js";
// The REAL config object, not its source text (same rule and reason as
// tests/config/timing-sensitive-coverage.test.ts: the `.js` spelling resolves
// to the gitignored compiled `vitest.config.js`, and the sweep would silently
// guard a stale config). Allowlisted in module-instance-coverage.test.ts.
import vitestConfig from "../../vitest.config.ts";
import {
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// Self-exclusion: this meta-test searches for the very markers that define a
// spawning test, so the marker literals are split and re-joined at runtime —
// spelled in full, this file would report itself as an unphased candidate
// (same trick as timing-sensitive-coverage.test.ts's samplerHelper).
const launchCall = "launchLSP" + "(";
const registryLookup = "getServer" + "ById(";
const fixtureName = "fake-lsp-" + "server";

// Each case contains exactly one marker. These are direct detector probes,
// not census fixtures: deleting any one marker arm must turn its own case red.
const syntheticMarkerCases = [
	{
		name: "launch seam",
		source: `await ${launchCall}(process.execPath, []);`,
	},
	{
		name: "server registry",
		source: `const server = ${registryLookup}"ast-grep";`,
	},
	{
		name: "fake server fixture",
		source: `const fixture = "tests/fixtures/${fixtureName}.mjs";`,
	},
] as const;

/** The `include` list of the "lsp-spawn-heavy" project, read from the live config. */
function lspSpawnHeavyInclude(): string[] {
	const projects: unknown = vitestConfig.test?.projects;
	if (!Array.isArray(projects)) {
		throw new Error(
			"vitest.config.ts default export has no test.projects array",
		);
	}
	const project = projects
		.map(
			(entry) =>
				(entry as { test?: { name?: unknown; include?: unknown } })?.test,
		)
		.find((test) => test?.name === "lsp-spawn-heavy");
	if (!project)
		throw new Error('vitest.config.ts has no project named "lsp-spawn-heavy"');
	const include = project.include;
	if (!Array.isArray(include) || include.length === 0) {
		throw new Error('the "lsp-spawn-heavy" project has no include list');
	}
	return include.map((entry) => toPosix(String(entry)));
}

/**
 * Detect by SPAWN SEAM USE, not by assertion shape. `strings: "keep"` keeps
 * string contents (the fixture is reached through an import/path string) while
 * still blanking comments, so a fixture mention in prose never flags a file.
 */
function isLspSpawnHeavy(source: string): boolean {
	const stripped = stripSource(source, { strings: "keep" });
	return (
		stripped.includes(launchCall) ||
		stripped.includes(registryLookup) ||
		stripped.includes(fixtureName)
	);
}

/**
 * Deliberate, reason-carrying exceptions (#2344 census, 2026-08-29). The
 * pre-existing population of real-child tests is 19; 4 are phased and 15 are
 * exempted. Each reason names the structural reason it does not carry the
 * lane's budget shape (already-routed-out, seam-self-test, or no contended
 * first-diagnostics wait). `auditRegistry` enforces the reason length and
 * reds any exemption whose file stops being a candidate (#1735).
 */
const SPAWN_EXEMPTIONS: Readonly<Record<string, string>> = {
	"tests/clients/lsp/clangd-lazy-indexing.test.ts":
		"launches a real clangd child only when the binary is present (skipped otherwise); asserts lazy-indexing flags, not a contended diagnostics budget",
	"tests/clients/lsp/client-crash-logging.test.ts":
		"drives real client-crash/exit handling against the instantly-answering fixture; assertions read the crash record, not a spawn-window budget",
	"tests/clients/lsp/client-exit-cause-ledger.test.ts":
		"real child exit-cause ledger cases; the fixture self-exits on a short delay, no handshake-then-diagnostics wait to starve",
	"tests/clients/lsp/client-retention-process-scope.test.ts":
		"real clients across two module instances to prove process-scope retention; handshake only against the instant fixture, no contention budget",
	"tests/clients/lsp/service-notify-cpu-liveness.test.ts":
		"real wedged child and CPU sampling run in the serialized wall-clock-budget phase; the lower-bound wedge assertion needs that quiet phase",
	"tests/clients/lsp/initialize-timeout-backstop.test.ts":
		"POSIX-only real-child initialize-timeout backstop; waits on a 50ms timeout firing then sleeps past kill escalation — deterministic and short",
	"tests/clients/lsp/launch.test.ts":
		"unit-tests the launchLSP seam itself over real binaries; asserts spawn/exit/failure shapes, never an LSP handshake under a timing budget",
	"tests/clients/lsp/lifecycle.test.ts":
		"launchLSP lifecycle cases over real scripts (spawn/exit/stop); no initialize-plus-diagnostics wait, so no fork-storm starvation window",
	"tests/clients/lsp/liveness-probe-capability-gate.test.ts":
		"real probe round-trips against the instantly-answering fixture under a 2s per-call budget; wire-shape assertions, historically contention-free",
	"tests/clients/lsp/refresh-and-sync-kind.test.ts":
		"real-wire sync-kind negotiation and didChange echo; the fixture answers instantly, no first-diagnostics wait that contention can starve",
	"tests/clients/lsp/service-notify-inflight-throttle-real-stream.test.ts":
		"exercises the notify-write throttle against a deliberately CPU-burning wedged fixture; the assertions describe the wedge, not a timing budget",
	"tests/clients/lsp/service-rename-file.test.ts":
		"real rename-file operations against the instant fixture over one fixed handshake; no diagnostics budget to lose to a fork storm",
	"tests/clients/lsp/shutdown-live-wedged-process.test.ts":
		"real wedged-child shutdown boundedness; 300ms budgets with a 5s ceiling and a 280ms floor — a starved host passes the floor and stays under the wide ceiling",
	"tests/clients/lsp/teardown-logging.test.ts":
		"asserts lsp_client_shutdown/lsp_service_reset log phases over real children; a 250ms shutdown budget against the instant fixture, no diagnostics wait",
	"tests/clients/memory-sampler.test.ts":
		"one real handshake proving lsp client byte attribution; asserts the memory table, never a contended wire transaction",
	"tests/clients/memory-sampler-root-discriminator.test.ts":
		"real handshakes at two roots proving per-root client attribution; the assertion is the side table, not a timing budget",
};

describe("lsp-spawn-heavy Vitest project coverage", () => {
	it.each(syntheticMarkerCases)(
		"detects the $name marker independently",
		({ source }) => {
			expect(isLspSpawnHeavy(source)).toBe(true);
		},
	);

	it("phases or documents every test that spawns a real LSP child", () => {
		const included = lspSpawnHeavyInclude();
		const files = listSourceFiles(path.join(repoRoot, "tests"), {
			extensions: [".ts"],
			// Fixture projects carry *.test.ts inputs belonging to the fixture's
			// own toolchain; vitest's sharedExclude never runs them, so the sweep
			// must not count them as candidates either.
			exclude: (rel) => rel.startsWith("tests/fixtures/"),
		}).filter((file) => file.endsWith(".test.ts"));

		const candidates = files
			.map((file) => relativePosix(repoRoot, file))
			.filter((file) =>
				isLspSpawnHeavy(fs.readFileSync(path.join(repoRoot, file), "utf8")),
			);

		const audit = auditRegistry({
			sweepName: "lsp-spawn-heavy lane coverage",
			flagged: candidates,
			registered: included,
			exemptions: SPAWN_EXEMPTIONS,
			minReasonLength: 20,
			// Calibration: 858 test files scanned on 2026-08-29 (tests/fixtures
			// excluded); half rounded up is 429, documented floor 430.
			scannedCount: files.length,
			minScanned: 430,
			// Calibration: 19 spawning-test candidates on 2026-08-30 (4 phased,
			// 15 exempted); half rounded up is 10.
			minFlagged: 10,
			remediation:
				"A test that spawns a real LSP child must run in the lsp-spawn-heavy " +
				"lane (vitest.config.ts lspSpawnHeavyInclude) or carry a documented " +
				"exemption in this file, or it shares the default project's fork storm " +
				"and can starve its own handshake/diagnostics budget without any gate.",
		});

		expect(audit.problems, audit.problems.join("\n")).toEqual([]);

		// Reverse check: a renamed or deleted member must not leave a dead glob
		// behind — the lane silently stops phasing anything at all.
		const dead = included.filter(
			(file) => !fs.existsSync(path.join(repoRoot, file)),
		);
		expect(dead, "lspSpawnHeavyInclude entries must exist on disk").toEqual([]);
	});
});
