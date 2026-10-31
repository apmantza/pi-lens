/**
 * Flake-shape ratchet — #2547.
 *
 * Three deflake PRs in two days (#2531 alone fixed three shared-slot races)
 * and nothing counted the contention surface those PRs kept fixing, so the
 * set only grew. This ratchet counts it: `tests/support/flake-shape-scan.ts`
 * runs seven detectors over every `tests/**\/*.test.ts` file —
 *
 * 1. `real-process-spawn` — a real child process (`child_process` import,
 *    `execFileSync`/`spawnSync`/`execSync`, a support spawn-helper call, or a
 *    spawn whose argv mentions `vitest`).
 * 2. `elapsed-time-assertion` — a DELTA of two clock reads flowing into a
 *    numeric matcher (`toBeLessThan`/`toBeGreaterThan`/…).
 * 3. `raw-timer-wait` — a raw `setTimeout`/`setInterval` wait outside a
 *    `vi.useFakeTimers()` scope.
 * 4. `ungoverned-wait-for` — a `vi.waitFor` call outside a fake-timer scope.
 * 5. `never-settling-wait` — a `new Promise` with an empty executor outside a
 *    fake-timer scope (#2885): only a real timer, often a production helper's
 *    budget the other detectors cannot read, ends an await on it. Minted with
 *    37 files / 73 hits.
 * 6. `in-process-mock` — a `vi.mock`/`vi.doMock` of a module that is not a
 *    process or host boundary (`PROCESS_BOUNDARY_MODULES`), keyed
 *    `<file>::<module>` so the baseline pins which modules a file mocks, not
 *    only how many (#4362). Minted with 480 files / 1,002 modules.
 * 7. `service-double` — an object literal that hand-rolls a registered
 *    in-process service (`SERVICE_SURFACES`: `LSPClientInfo`, `LSPService`),
 *    keyed `<file>::<service>` (#4362). Minted with 83 files / 151 objects.
 *
 * Detectors 6 and 7 exist because #4344 round 3 (G5) added one method to
 * `LSPClientInfo` and `LSPService` and then had to add it by hand to doubles
 * in 40 test files: every in-process double is a copy of an interface that
 * the next interface change must find. Their admission is the header and the
 * `ADMITTED_AFTER_BASELINE` entry; a mock adds no contention, so they need no
 * serialized lane (`MOCK_DETECTORS`).
 *
 * `FLAKE_SHAPE_BASELINE` (`tests/support/flake-shape-baseline.json`) is
 * today's population, content-keyed as `file → count` per detector — the
 * exact floor, kept in lockstep with the live scan, not a one-way ratchet
 * that only ever tightens on its own. The ratchet is TWO-SIDED and fails on:
 *
 * - a NEW file the scan flags that the baseline does not name, in any
 *   detector;
 * - an allowlisted file whose count in a detector RISES above its pinned
 *   value;
 * - an allowlisted file whose count in a detector FALLS below its pinned
 *   value — a stale ceiling. Left unpinned, a pinned-5/live-2 file can
 *   regrow to 4 new instances of the flake shape without ever tripping the
 *   RISES check above (2 < 5, then 4 < 5): the pin silently re-admits
 *   everything the improvement burned down. Every other ratchet in this repo
 *   refuses a stale entry the same way (`single-flight-ratchet.test.ts`,
 *   `sweep-kit.ts`'s `auditRegistry`) — a fall is fixed by editing the
 *   baseline down to the live count, not left to drift.
 *
 * Admission of a genuinely NEW entry (a new file, or a risen count in an
 * existing one) is a two-part gate, both required: the file carries a
 * `// flake-shape: <detector> — <reason>` header naming why a mock is not
 * faithful, AND the file is listed in `vitest.config.ts`'s
 * `wallClockBudgetInclude` project (so it runs in the fully serialized
 * lane). `ADMITTED_AFTER_BASELINE` below is the running list of entries
 * admitted this way since the baseline was minted.
 *
 * #1767's `tests/clients/runtime-session.test.ts` (a real recurring flake,
 * fixed with `vi.waitFor` timeouts and a wider `describe`/`it` budget, not a
 * raw clock delta, a raw timer, or a spawn) was checked by hand against all
 * three detectors while writing this ratchet and matches NONE of them — it
 * is the #1767 vi.waitFor/testTimeout contention-budget flake shape, a real
 * but DIFFERENT shape than the three this ratchet counts, so it correctly
 * does not appear in the baseline. Recorded here rather than silently
 * absent, so a future reader does not conclude the file was missed.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import vitestConfig, { realHarnessInclude } from "../../vitest.config.ts";
import {
	admissionHeader,
	countsByDetector,
	type DetectorName,
	DETECTOR_NAMES,
	declaredMembers,
	DETECTORS,
	hitKey,
	IDENTITY_SEPARATOR,
	MOCK_DETECTORS,
	mockTarget,
	NON_LITERAL_MOCK_TARGET,
	PROCESS_BOUNDARY_MODULES,
	repoRoot,
	scanElapsedTimeAssertion,
	scanInProcessMock,
	scanNeverSettlingWait,
	scanRawTimerWait,
	scanRealProcessSpawn,
	scanServiceDouble,
	scanUngovernedWaitFor,
	SERVICE_DOUBLE_MIN_MEMBERS,
	SERVICE_SURFACES,
	surfaceMembers,
} from "../support/flake-shape-scan.js";
import { testSourceFiles as allTestSourceFiles } from "../support/module-instance-scan.js";
import { localImportTargets } from "../support/hook-await-scan.js";
import { assertSortedRegistry } from "../support/sweep-kit.js";

// ── The baseline ─────────────────────────────────────────────────────────

type Baseline = Record<DetectorName, Record<string, number>>;

const FLAKE_SHAPE_BASELINE: Baseline = JSON.parse(
	fs.readFileSync(
		path.join(repoRoot, "tests/support/flake-shape-baseline.json"),
		"utf8",
	),
);

// ── The frozen mint (#4383 review F1) ────────────────────────────────────
//
// Recurrence: a planted `vi.mock` plus ONLY its baseline row, or a planted
// `execFileSync` plus only its real-process-spawn row, passed the ratchet
// with no header and no ADMITTED_AFTER_BASELINE entry. The failure message
// asked for both; nothing enforced them, because the live scan is compared
// with the baseline and the baseline is plain data anyone can grow.
//
// `flake-shape-baseline-frozen.json` is the baseline as round 1 of #4383
// shipped it, written once. A baseline row the mint does not cover (a new
// key, or a count above the minted count) must have an ADMITTED entry, and
// the existing admission test then demands its header (and, for a timing or
// spawn detector, its serialized lane). The mint is digest-pinned so growing
// it is a reviewed code change here, never a quiet data edit. CI's unit jobs
// check out shallow, so the mint cannot be a git-history diff.

const FROZEN_BASELINE_PATH = "tests/support/flake-shape-baseline-frozen.json";

/** sha256 of the mint's canonical JSON (formatting and line endings do not count). */
const FROZEN_BASELINE_DIGEST =
	"db2450d7da2f0123a5bd4d366156598e709aea5a356073095ccc27ce0c9afbc2";

const FROZEN_BASELINE_SOURCE = fs.readFileSync(
	path.join(repoRoot, FROZEN_BASELINE_PATH),
	"utf8",
);

const FROZEN_BASELINE: Baseline = JSON.parse(FROZEN_BASELINE_SOURCE);

/** Problems with the mint's content against its pinned digest. */
function frozenDigestProblems(
	source: string,
	digest: string = FROZEN_BASELINE_DIGEST,
): string[] {
	const actual = createHash("sha256")
		.update(JSON.stringify(JSON.parse(source)))
		.digest("hex");
	if (actual === digest) return [];
	return [
		`${FROZEN_BASELINE_PATH} changed (sha256 ${actual}, pinned ${digest}). ` +
			"The mint is write-once: admit a new row with an ADMITTED_AFTER_BASELINE " +
			'entry and its "// flake-shape: <detector> — <reason>" header instead. ' +
			"Only a deliberate re-mint (a renamed module behind hundreds of rows) " +
			"edits the mint, and then FROZEN_BASELINE_DIGEST changes in the same PR " +
			"with the reason in its description.",
	];
}

/**
 * Every baseline row the frozen mint does not cover needs an ADMITTED
 * entry, and every ADMITTED entry needs a baseline row (a stale admission
 * excuses nothing). The header and lane of each ADMITTED entry are the
 * admission test's job (`validateAdmission`).
 */
function auditAgainstMint(
	baseline: Readonly<Baseline> = FLAKE_SHAPE_BASELINE,
	frozen: Readonly<Baseline> = FROZEN_BASELINE,
	admitted: Readonly<
		Record<string, { detector: DetectorName; reason: string }>
	> = ADMITTED_AFTER_BASELINE,
): string[] {
	const problems: string[] = [];
	for (const detector of DETECTOR_NAMES) {
		for (const [key, count] of Object.entries(baseline[detector] ?? {})) {
			const minted = frozen[detector]?.[key];
			if (minted !== undefined && count <= minted) continue;
			if (Object.hasOwn(admitted, `${detector}:${key}`)) continue;
			problems.push(
				`${detector}:${key}: baseline row ${count} is past the frozen mint ` +
					`(${minted === undefined ? "absent" : `minted ${minted}`}) and has no ` +
					"ADMITTED_AFTER_BASELINE entry; add the entry and its " +
					`"// flake-shape: ${detector} — <reason>" header ` +
					"(if the key only moved with a renamed file, re-mint the frozen file and its digest instead)",
			);
		}
	}
	for (const [admittedKey, entry] of Object.entries(admitted)) {
		const key = admittedKey.slice(entry.detector.length + 1);
		if (!Object.hasOwn(baseline[entry.detector] ?? {}, key)) {
			problems.push(
				`${admittedKey}: stale admission, no baseline row; remove the entry`,
			);
		}
	}
	return problems;
}

/**
 * Entries admitted to a detector's baseline AFTER it was minted — a merge-
 * window device, same shape and same cost profile as
 * `single-flight-ratchet.test.ts`'s `FORWARD_DECLARED`.
 */
const ADMITTED_AFTER_BASELINE: Readonly<
	Record<string, { detector: DetectorName; reason: string }>
> = {
	// 2026-10-08 (#4148): blank-heavy YAML language extraction is a synchronous
	// event-loop path, so only a real-clock assertion sees its quadratic stall.
	"elapsed-time-assertion:clients/ast-grep-rule-regex-budget.test.ts": {
		detector: "elapsed-time-assertion",
		reason:
			"the defect is wall-clock only (super-linear ast-grep rule YAML language extraction); a fake clock measures nothing",
	},
	// 2026-09-11 (#2886 round 2): the /lens-perf occupancy row keeps one
	// real-clock sampler assertion alongside its deterministic yield count —
	// event-loop occupancy has no deterministic proxy; the yield count is
	// O(input) and cannot see per-chunk block growth.
	"elapsed-time-assertion:clients/performance-report-occupancy.test.ts": {
		detector: "elapsed-time-assertion",
		reason:
			"event-loop occupancy has no deterministic proxy; the sampler row guards per-chunk block size the yield count cannot see",
	},
	// 2026-10-08 (#4148): 100K blank lines expose the real event-loop stall in
	// pytest traceback and go.mod regex parsing; a fake clock cannot measure it.
	"elapsed-time-assertion:clients/pytest-gomod-regex-budget.test.ts": {
		detector: "elapsed-time-assertion",
		reason:
			"the defect is wall-clock only (quadratic pytest traceback and go.mod regex backtracking); a fake clock measures nothing",
	},
	// 2026-09-08 (#2622): the defect is wall-clock only — 2^N regex
	// backtracking in both glob compilers; a fake clock measures nothing.
	"elapsed-time-assertion:clients/read-guard-glob-nonbacktracking.test.ts": {
		detector: "elapsed-time-assertion",
		reason:
			"the defect is wall-clock only (2^N regex backtracking); a fake clock measures nothing",
	},
	"elapsed-time-assertion:clients/sgconfig-scratch-bound.test.ts": {
		detector: "elapsed-time-assertion",
		reason:
			"#3403 measures real scratch-tree filesystem latency; fake timers cannot observe cold CI disk work",
	},
	// 2026-10-08 (#3871 r2, moved to its own file in r3): depth-30 runner
	// paths, 100K blank runs and 100K tokens are real event-loop occupancy
	// witnesses for super-linear location-regex backtracking.
	"elapsed-time-assertion:clients/test-runner-location-regex-budget.test.ts": {
		detector: "elapsed-time-assertion",
		reason:
			"the defect is wall-clock only (super-linear runner-location regex backtracking); a fake clock measures nothing",
	},
	// 2026-09-06 (#2603, was #2591 review round 2, F1): the defect is 2^N regex
	// backtracking through detectPythonEnvironment — the ANSWER was always
	// right, only the time was wrong, so no non-clock assertion separates
	// fixed from broken; header on the file states why.
	"elapsed-time-assertion:clients/workspace-glob-nonbacktracking-budget.test.ts":
		{
			detector: "elapsed-time-assertion",
			reason:
				"the defect is wall-clock only (2^N globstar backtracking); a fake clock measures nothing",
		},
	// 2026-10-29 (#4965 round 1): the cache observability's session state moved
	// onto the session's scope; the summary and baseline rows are only visible in
	// the logLatency call, as in cache-observability.test.ts.
	"in-process-mock:clients/cache-observability-session-scope.test.ts::clients/latency-logger":
		{
			detector: "in-process-mock",
			reason:
				"the cache_usage_summary and baseline rows go through logLatency and test mode skips the file sink, so a passed-through spy is the only reader; the scope store under test is real",
		},
	// 2026-10-15 (#1712/#4485): the cascade's live twin over a real classic
	// TypeScript server. Installation is the external tool boundary: the stub
	// hands the real wrapper and a classic compiler to the real launcher.
	"in-process-mock:clients/cascade-classic-ts-live.test.ts::clients/installer/index":
		{
			detector: "in-process-mock",
			reason:
				"tool installation and discovery are the host boundary; the stub hands the real typescript-language-server wrapper and a classic compiler to the real launcher, service, client and cascade",
		},
	// 2026-10-30 (#5040): the acceptance cell drives the REAL cascade and the
	// REAL touchFile, so only the language-server client, the graph edges it
	// walks, the logger it writes and the quiet-window scheduler stand in.
	"in-process-mock:clients/cascade-pre-edit-answer-5040.test.ts::clients/cascade-logger":
		{
			detector: "in-process-mock",
			reason:
				"the cell asserts the neighbour_touch row that records WHY a neighbour is unconfirmed; test mode skips the file sink, so the call itself is the only read-back",
		},
	"in-process-mock:clients/cascade-pre-edit-answer-5040.test.ts::clients/lsp/client":
		{
			detector: "in-process-mock",
			reason:
				"a language server is a spawned process; the subject is a push-only server that publishes an importer once and then stays silent, which no real server can be asked to do on demand. Everything above the client — the service, the notify-skip gate, the merge — is real",
		},
	"in-process-mock:clients/cascade-pre-edit-answer-5040.test.ts::clients/quiet-window":
		{
			detector: "in-process-mock",
			reason:
				"the quiet window is a session scheduler the unit lane must not arm; the cell's claim is the run verdict, not the sweep",
		},
	"in-process-mock:clients/cascade-pre-edit-answer-5040.test.ts::clients/review-graph/service":
		{
			detector: "in-process-mock",
			reason:
				"the review graph is a separate subsystem with its own suite; its file-level edges are the fixture here, and the cascade's own neighbour walk is what the cell proves",
		},
	// 2026-10-16 (#4495 round 3): the cascade's pending gate runs the shared
	// freshness gate quiet; whether its rows were written is only visible in
	// the logLatency call, since turn_end overruns the five-phase ring.
	"in-process-mock:clients/cascade-turn-merge.test.ts::clients/latency-logger":
		{
			detector: "in-process-mock",
			reason:
				"the freshness gate writes its rows through logLatency; turn_end logs more phases after the gate than the five the getRecentLoggedPhases ring keeps, and test mode skips the file sink, so a passed-through spy is the only reader",
		},
	// 2026-10-29 (#4990): the demoted channel's policy pass writes its
	// inline_blocker_policy row through logLatency; turn_end logs more phases
	// after it than the five-phase ring keeps, and test mode skips the file
	// sink, so a passed-through spy is the only reader.
	"in-process-mock:clients/demoted-finding-4990.test.ts::clients/latency-logger":
		{
			detector: "in-process-mock",
			reason:
				"the inline_blocker_policy row goes through logLatency; turn_end logs more phases after it than the five the getRecentLoggedPhases ring keeps, and test mode skips the file sink, so a passed-through spy is the only reader",
		},
	// 2026-10-21 (#4638 review): the behaviour under test is the post-write
	// runner admission of a server answer, so the capability seam hands it a
	// doubled service and everything downstream of the runner stays production.
	"in-process-mock:clients/dispatch/runners/lsp-python-compile-target-e2e.test.ts::clients/lsp/capabilities":
		{
			detector: "in-process-mock",
			reason:
				"the post-write lane must receive a controlled server answer; the service is seeded from the shared double and only getLSPService is replaced",
		},
	// 2026-10-16 (#4476): the same fake auxiliary, seen from the role lookup
	// the registry's dependency restart asks; getServerById knows only the
	// built-in catalog, so the auxiliary added above answers there too.
	"in-process-mock:clients/head-move-resync-4493.test.ts::clients/lsp/server": {
		detector: "in-process-mock",
		reason:
			"getServerById reads only the built-in catalog, so the auxiliary fake the config lookup adds is answered there too; the restart then keeps it, and every server is still a real child process",
	},
	// 2026-10-22 (#4760): the launched language-server process is the boundary;
	// the subject is the registry's root choice and its five-attempt failure
	// ladder, which need a rejecting initialize handshake at a chosen root.
	"in-process-mock:clients/lsp/aux-loose-file-root-4760.test.ts::clients/lsp/client":
		{
			detector: "in-process-mock",
			reason:
				"the LSP client is a spawned language-server process; the root function and the spawn ladder are the subject, and only a handshake that never answers reaches the permanent latch",
		},
	// 2026-10-15 (#4449): the registry's skip and respawn records go to
	// logLatency. Its in-process ring drops the fields the test asserts, and
	// test mode never reaches the file sink, so the captured call is the seam.
	"in-process-mock:clients/lsp/client-registry-direct.test.ts::clients/latency-logger":
		{
			detector: "in-process-mock",
			reason:
				"the ring getRecentLoggedPhases reads keeps only phase and metadata, and test mode skips the file sink; the registry's filePath and durationMs fields are asserted from the captured call",
		},
	// 2026-10-15 (#4449): createLSPClient wraps the language-server child
	// process; the extracted ClientRegistry's spawn bookkeeping is driven
	// directly, so the client factory is the one boundary stood in for.
	"in-process-mock:clients/lsp/client-registry-direct.test.ts::clients/lsp/client":
		{
			detector: "in-process-mock",
			reason:
				"createLSPClient wraps the language-server child process; the registry's spawn bookkeeping is the subject",
		},
	// 2026-10-24 (#1712 slice 2): the same real classic TypeScript server, now
	// driven through the rename and watched-files paths; the stub is the same
	// tool-installation boundary as its cascade sibling above.
	"in-process-mock:clients/lsp/crossfile-classic-ts-live.test.ts::clients/installer/index":
		{
			detector: "in-process-mock",
			reason:
				"tool installation and discovery are the host boundary; the stub hands the real typescript-language-server wrapper and a classic compiler to the real launcher, service, client and rename/watched-files paths",
		},
	// 2026-10-27 (#4914): the effect-tsgo selection cells drive the real
	// TypeScriptServer.spawn and the real project-trust gate; the installer is
	// the host boundary and the launcher the child-process boundary, so nothing
	// here starts a language server.
	"in-process-mock:clients/lsp/effect-tsgo-lsp.test.ts::clients/installer/index":
		{
			detector: "in-process-mock",
			reason:
				"tool installation and discovery are the host boundary; the stub answers no managed tool so the selection under test comes only from the fixture node_modules tree",
		},
	"in-process-mock:clients/lsp/effect-tsgo-lsp.test.ts::clients/lsp/launch": {
		detector: "in-process-mock",
		reason:
			"launchLSP is the child-process boundary and records which command and arguments the production spawn chose; the trust gate beside it in the same module is the real one",
	},
	// 2026-10-14 (#4346): the ast-grep native addon's load is the host
	// boundary, and `loadAstGrepNapiSync` is its only seam; no host lane
	// lacks the addon, so the fail-closed record has no real driver.
	"in-process-mock:clients/lsp/implicit-scope-napi-unavailable-4346.test.ts::clients/deps/ast-grep-napi":
		{
			detector: "in-process-mock",
			reason:
				"the native addon's load is the host boundary; its sync loader is the only seam to make it fail",
		},
	// 2026-10-16 (#4515): the fixture proves a trust-refused project-local
	// candidate no longer ends the launch. The refusal, the installer and the
	// candidate loop are real; only a store binary's launch is doubled.
	"in-process-mock:clients/lsp/managed-fallback-after-trust-refusal-4515.test.ts::clients/lsp/launch":
		{
			detector: "in-process-mock",
			reason:
				"spawning the managed language server is the process boundary; the wrapper delegates every other command, the refused project-local candidate included, to the real launchLSP",
		},
	// 2026-10-23 (#4763): the per-touch published counts and the held-publish
	// counter are written through logLatency rows the five-phase ring excludes.
	"in-process-mock:clients/lsp/opengrep-pre-rules-publish-4763.test.ts::clients/latency-logger":
		{
			detector: "in-process-mock",
			reason:
				"the lsp_aux_wait_outcome and lsp_rules_refreshed rows are outside the getRecentLoggedPhases ring (LAST_PHASE_EXCLUDED) and test mode skips the file sink, so a passed-through logLatency spy is the only reader of the per-touch published counts and held-publish counter (#4763)",
		},
	// 2026-10-28 (#4929): the fallow opt-in cells drive the real registry, config
	// selection, trust gate and LSPService acquisition; the launcher, the
	// transport and the installer are the process and network boundaries.
	"in-process-mock:clients/lsp/opt-in-auxiliary-4929.test.ts::clients/installer/index":
		{
			detector: "in-process-mock",
			reason:
				"tool installation and discovery are the host boundary; the stub records whether the opt-in server's install was reached and never downloads",
		},
	"in-process-mock:clients/lsp/opt-in-auxiliary-4929.test.ts::clients/lsp/client":
		{
			detector: "in-process-mock",
			reason:
				"createLSPClient is the JSON-RPC transport boundary; the acquisition, selection and trust gate around it are the real ones",
		},
	"in-process-mock:clients/lsp/opt-in-auxiliary-4929.test.ts::clients/lsp/launch":
		{
			detector: "in-process-mock",
			reason:
				"launchLSP is the child-process boundary and records which command and arguments the production spawn chose; the trust gate beside it in the same module is the real one",
		},
	// 2026-10-23 (#4785 F4): the touch's verdict over the real wait, publish
	// handler and clear; only the client factory, which spawns the server, is
	// replaced by a client over a real state.
	"in-process-mock:clients/lsp/touch-cleared-deferred-wait-4785.test.ts::clients/lsp/client":
		{
			detector: "in-process-mock",
			reason:
				"createLSPClient spawns a language-server process; the double it returns runs the real clientWaitForDiagnostics, publish handler and clearDiagnosticsForPath, and a real server cannot be made to publish twice and receive a refresh clear inside one quiet window on demand",
		},
	// 2026-10-20 (#4638): tool availability is resolved so the spawn seam records the
	// real argv (cwd + config args) without probing or installing ruff; only that
	// resolver is doubled, and resolveToolCwd, ruffConfigArgs, safe-spawn stay real.
	"in-process-mock:clients/ruff-target-version-argv.test.ts::clients/dispatch/runners/utils/runner-helpers":
		{
			detector: "in-process-mock",
			reason:
				"the argv case must not probe or install ruff: the resolver stands in for the availability probe and the spawn boundary is doubled to record argv, while resolveToolCwd and ruffConfigArgs run for real",
		},
	// 2026-10-17 (#4504): the witness runs the real session_start / tool_call /
	// tool_result handlers and only the per-file dispatch is stood in for, so
	// the run observes what the opaque prescan recorded and recovered, not a
	// linter's verdict.
	"in-process-mock:index-4504-opaque-prescan-root-witness.test.ts::clients/pipeline":
		{
			detector: "in-process-mock",
			reason:
				"the synthetic dispatch of a recovered opaque write is not the subject; a resolved pipeline verdict keeps a linter child out of a witness about the prescan's own record",
		},
	// 2026-10-17 (#4554, reason corrected in #4709): two activations in one
	// process each assert their own module-level `resetLSPService` spy. The
	// singleton lifecycle keeps one `beforeReset` at a time, so installing the
	// second activation's spy hides the first's (the r7 cell reads it after).
	"in-process-mock:index-4554-last-member-teardown.test.ts::clients/lsp/capabilities":
		{
			detector: "in-process-mock",
			reason:
				"two activations in one process each assert their own module-level resetLSPService spy, and the singleton lifecycle holds one beforeReset at a time, so the seam cannot tell the activations apart; the stand-in spawns no language server",
		},
	// 2026-10-31 (#5108): pass-through wrapper that holds the real handler open.
	"in-process-mock:index-5108-opaque-blocker-disclosure-witness.test.ts::clients/runtime-tool-result":
		{
			detector: "in-process-mock",
			reason:
				"a pass-through wrapper holds the real handler open past the host bound and records its return value; dispatch, pipeline, advisory queue and the pi session stay real (precedent: index-2939-tool-result-budget-witness.test.ts)",
		},
	// 2026-10-21 (#4675 r2): the format smoke runs the REAL FormatService and
	// formatter selection; installation is the network boundary, so the stub
	// answers `ensureTool`/`getToolPath` and the child process is doubled below
	// it (AGENTS.md shape 66).
	"in-process-mock:scripts/smoke-tools-format-install.test.ts::clients/installer/index":
		{
			detector: "in-process-mock",
			reason:
				"tool installation and discovery are the network boundary; the stub hands the real formatter resolution a managed path while the FormatService, selection and formatFile stay real and only the formatter child is doubled",
		},
	// 2026-10-21 (#4638 review F10): the owner is wrapped, not replaced — every
	// other export stays real — so the edit path's walks can be counted per file
	// instead of inferred from the delivery result.
	"in-process-mock:tools/lens-diagnostics-declaration-walk.test.ts::clients/python-environment":
		{
			detector: "in-process-mock",
			reason:
				"the wrapper spreads the actual module and only counts calls to the declaration resolver, which is the behaviour under test (zero I/O for a file without jedi's row)",
		},
	"in-process-mock:tools/lsp-diagnostics-opengrep-pre-rules-4763.test.ts::clients/latency-logger":
		{
			detector: "in-process-mock",
			reason:
				"the lsp_aux_wait_outcome and lsp_rules_refreshed rows are outside the getRecentLoggedPhases ring (LAST_PHASE_EXCLUDED) and test mode skips the file sink, so a passed-through logLatency spy is the only reader of the per-touch published counts and held-publish counter (#4763)",
		},
	// 2026-10-21 (#4638 review F10): the wrapper spreads the actual owner module
	// and counts only the declaration resolver, so the snapshot filter's effect on
	// the walk is observed rather than inferred.
	"in-process-mock:tools/lsp-navigation.test.ts::clients/python-environment": {
		detector: "in-process-mock",
		reason:
			"the real export still answers each call; the wrapper exists to prove a file without jedi's row is never walked",
	},

	"never-settling-wait:scripts/mutate-fixture.test.ts": {
		detector: "never-settling-wait",
		reason:
			"the interrupt witness must hold a real child open until SIGINT; replacing the wait with a settled promise would erase the lifecycle under test",
	},
	// 2026-09-07 (#2703 review r1): an unhandled derived-promise rejection is
	// only observable through Node's `unhandledRejection` event, which fires
	// on a real macrotask; the file drains one real `setImmediate` tick.
	"raw-timer-wait:clients/lsp/push-wait-settle-rejection.test.ts": {
		detector: "raw-timer-wait",
		reason:
			"unhandledRejection is delivered on a real macrotask; one real setImmediate drain, assertion on the captured list",
	},
	// 2026-09-08 (#2765 round 3): the hook remainder is the subject; fake timers
	// drive the delayed pre-snapshot work and the bounded lookup.
	"raw-timer-wait:clients/lsp/service-inconclusive-per-server.test.ts": {
		detector: "raw-timer-wait",
		reason:
			"the hook remainder is the defect; fake timers isolate the delayed pre-snapshot work from scheduler contention",
	},
	// #3176 F4: the budget test's contract is REAL elapsed time —
	// `bounded()` races the touch against a live wall deadline; fake timers
	// would settle the bound instantly and the budget semantics would be
	// unmeasurable. The assertion is on outcomes and counts, never elapsed ms.
	"raw-timer-wait:clients/persistent-reverify.test.ts": {
		detector: "raw-timer-wait",
		reason:
			"bounded() races the touch against a live wall budget; fake timers settle the bound instantly and the budget semantics are unmeasurable",
	},
	// 2026-10-23 (#4780 R3 review): the case's ASSERTION IS A NEGATIVE — a
	// `/reload` cancelled the previous activation's refresh timer, so nothing is
	// fetched, validated or cached. There is no event to await, so a bounded real
	// window is the only observer; the assertions are the fetch count, the shim's
	// call count and the stamp, never elapsed ms.
	"raw-timer-wait:clients/runtime-session-opengrep-refresh-timer-4780.test.ts":
		{
			detector: "raw-timer-wait",
			reason:
				"a cancelled timer produces no event to await; a bounded real window observes the absence, and every assertion is a count, never elapsed ms",
		},
	// 2026-10-31 (#5108): the read-only bound is a live wall deadline.
	"raw-timer-wait:index-5108-opaque-blocker-disclosure-witness.test.ts": {
		detector: "raw-timer-wait",
		reason:
			"the read-only bound is a live wall deadline racing a held handler; a fake clock settles the race instantly and the abandonment under test never happens",
	},
	// 2026-09-15 (#2042 cheapest probe): the sample-tail file is written by the
	// wrapper's own real setInterval loop in a separate process; a poll waits
	// for that file's first write rather than a fixed sleep, and one case kills
	// the wrapper's real process to prove the tail survives that exact victim
	// shape (master 1701d01). 2026-09-16 (#3110 round 2 S1): the same shape
	// from two more angles -- a slow reader's resume cadence has to be a real
	// timer against a real OS pipe's backpressure (no fake clock drains a
	// kernel buffer), and the note-write retry cap and the hang/exit-code
	// bound both wait on a real, separately spawned process's real exit.
	"raw-timer-wait:scripts/with-memory-watch.test.ts": {
		detector: "raw-timer-wait",
		reason:
			"real interval loop / real pipe backpressure / real spawned-process exit in a separate process; polls, resume cadences, and hang bounds are the subject, not fakeable",
	},
	"raw-timer-wait:support/fault-injection.ts": {
		detector: "raw-timer-wait",
		reason:
			"fault injection must model real timer and child teardown timing; fake timers cannot reproduce the boundary",
	},
	// 2026-10-27 (#4913): a spawn by the loaded extension copy, or its absence
	// over a bounded window, is joinable only by polling the file the real
	// child writes.
	"raw-timer-wait:support/marker-lsp-project.ts": {
		detector: "raw-timer-wait",
		reason:
			"the marker server is a real child the extension spawns on its own schedule, so a spawn or its absence over a bounded window is joinable only by polling the file it writes",
	},
	"raw-timer-wait:support/real-pi-harness.ts": {
		detector: "raw-timer-wait",
		reason:
			"the harness timeout models real child-process progress and must remain bounded across teardown",
	},
	// 2026-09-16 (#3082): a recursive fs.watch event arrives on the kernel's
	// schedule, in another process than the one that wrote the file. There is
	// no fake clock for inotify, and a stubbed watcher would prove only that
	// the stub calls its own callback.
	"raw-timer-wait:support/tests-tree-write-guard.test.ts": {
		detector: "raw-timer-wait",
		reason:
			"a real recursive fs.watch delivery is the subject; no fake clock delivers an inotify event and a stubbed watcher proves nothing",
	},
	"real-process-spawn:clients/analysis-root-writers.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git worktree metadata is written and registered by Git; an in-process double cannot prove linked-worktree ownership",
	},
	// 2026-10-21 (#4713 R11): real `bash -c` is the oracle for which
	// directory each generated spelling enters and where its redirect lands;
	// the generator exists because hand-written expectations missed spellings.
	"real-process-spawn:clients/bash-word-composition.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real bash decides which directory each generated spelling enters and where its write lands; a stubbed shell answers neither",
	},
	"real-process-spawn:clients/biome-config-decorator-metadata.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real Biome children resolve decorator metadata that in-process calls cannot observe",
	},
	"real-process-spawn:clients/build-identity.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children establish build identity from repository state unavailable to an in-process stub",
	},
	"real-process-spawn:clients/config-diagnostic-codes.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children enumerate tracked diagnostic files, which a mocked repository cannot resolve",
	},
	// 2026-10-18 (#4535 slice 2): a HEAD move exists only in a real repository
	// that git checks out; a stubbed git could not rewrite the files the look
	// lists in its delta, and the publish is about what git actually reports.
	"real-process-spawn:clients/disk-change-detectors-4535.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a clean-tree HEAD move is a real git checkout; a stubbed git cannot produce the delta the look publishes",
	},
	"real-process-spawn:clients/dispatch/runners/ast-grep-playground-verify.test.ts":
		{
			detector: "real-process-spawn",
			reason:
				"a real ast-grep playground child parses fixture syntax beyond the runner's in-process state",
		},
	"real-process-spawn:clients/dispatch/runners/ast-grep-rule-ignores.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real ast-grep child applies ignore rules through its own file matcher",
	},
	// #4522: the census must know which fixture inputs git hides; its
	// collectUntrackedIgnoredIds call spawns the real `git ls-files` that
	// decides, and no stub reproduces git's own index state.
	"real-process-spawn:clients/dispatch/smoke-fixture-coverage.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the fixture-input census needs git's own tracked-versus-ignored decision through collectUntrackedIgnoredIds; no stub reproduces the index state that decides whether a fixture survives a fresh checkout",
	},
	"real-process-spawn:clients/format-service-tab-width-real-biome.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real Biome binary's wrapping at the 80-column boundary is the subject; a mocked spawn can only restate the argv the fix chose",
	},
	// 2026-10-22 (#4739): real `bash -c` is the oracle for whether each
	// spelling of git or its verb runs `git commit` or `git push`; the gate
	// read token text no shell reads, and a stubbed shell decodes nothing.
	"real-process-spawn:clients/git-guard-decoded-word.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real bash decides which generated spelling runs git commit or git push; a stubbed shell decodes no word",
	},
	// 2026-10-27 (#4930): the child's own environment and a real git's write to
	// .git/index are the observations; the lock lives ~40 ms, so the witness
	// reads the index a stat-dirty `git status` would rewrite.
	"real-process-spawn:clients/git-optional-locks-4930.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real git decides whether a stat-dirty index is rewritten and a real child reads its environment; a stub sees neither",
	},
	"real-process-spawn:clients/git-tracked-ignore.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children decide tracked-versus-ignored files from index state no stub reproduces",
	},
	"real-process-spawn:clients/head-move-resync-4493.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a clean-tree HEAD move only exists in a real repository that git checks out, rebases or resets; a stubbed git cannot rewrite the files the server holds",
	},
	"real-process-spawn:clients/installer/pip-pep668.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real installer subprocesses prove PEP 668 strategy selection and binary resolution across executable package-manager boundaries",
	},
	"real-process-spawn:clients/installer/posix-group-kill.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real POSIX shell descendants prove process-group termination across OS process state",
	},
	"real-process-spawn:clients/installer/verify-binary-semantics.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real binary children write and survive teardown, behavior an in-process installer stub cannot expose",
	},
	// 2026-09-06 (#2619 review F1, then N1/N3 in round 3): three real spawns,
	// each pinning something no in-process double can reach. (1) a `node -e`
	// child reports what IT resolved for HOME/PI_LENS_INSTALL_LOG — `os.homedir()`
	// in the test process can only ever report the ambient home. (2) `npm pack`
	// of a two-line fixture package whose `prepare` writes through
	// `os.homedir()`: the runner's defect was npm IGNORING the env it was
	// handed, which an assertion on the env object cannot see. (3) the real
	// release-qa CLI run out of a throwaway dirty tree, because main()'s call to
	// the dirty-checkout refusal — as opposed to the pure refusal itself — is
	// only reachable through the process entry point.
	// 2026-09-06 (#2507): the defect IS a child process's own exit decision —
	// libuv finding no referenced handle mid `lsp_diagnostics` and Node exiting
	// 0. A process cannot watch its own loop decide to drain, so the exit code
	// and stdout of a real headless child are the only faithful observation.
	// #3538/#3539: the reaper's kill decision reads a pid's command line and
	// kernel start time, and its POSIX backstop reads a child's inherited
	// environment. Only a real process carries all three.
	"real-process-spawn:clients/instance-reaper-pid-reuse.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the reaper's evidence is a real pid's command line, kernel start time and inherited environment; a double would encode the very identity guess the fix removes",
	},
	// #4046 interim: six real Node writers rendezvous on an OS barrier and
	// persist registrations through the production cross-process lock; an
	// in-process double cannot reproduce the race, and serialization prevents
	// it from overlapping the timing-sensitive occupancy sampler.
	"real-process-spawn:clients/instance-registry-race.test.ts": {
		detector: "real-process-spawn",
		reason:
			"six real Node writers must rendezvous on an OS barrier and contend through the production cross-process lock; an in-process double cannot reproduce the race",
	},
	"real-process-spawn:clients/lsp/headless-tool-call-keepalive.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real child's exit code is the observation; no in-process double can watch an event loop decide to drain",
	},
	"real-process-spawn:clients/lsp/kill-process-tree-real-child.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real, live direct child is the only pid whose /proc PPid is this process, so the Linux ownership arm of the kill-by-pid predicate cannot be observed through any double",
	},
	"real-process-spawn:clients/lsp/lean-real-smoke.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real Lean elaboration and diagnostic publication require Lake and elan across the child-process boundary; the serialized wall-clock lane isolates the handshake and diagnostic wait",
	},
	"real-process-spawn:clients/lsp/unheld-module-pyright-4742.integration.test.ts":
		{
			detector: "real-process-spawn",
			reason:
				"a clean-tree HEAD move needs a real git checkout and a closed module's stale bytes live only in a real pyright-langserver child; no double reproduces what the server kept",
		},
	// 2026-10-31 (#5119): markdownlint-cli2's own directory-config merge and fix
	// pass are the behaviour under test (`"fix": true` made a lint run write the
	// file); the real module's bytes are the witness and its CLI is the parity
	// reference; serialized in the wall-clock lane.
	// 2026-11-01 (#5119 review r1): the no-fix wrapper runs cli2's `main` in a
	// child so the spawn budget can kill a spinning rule; the kill, the late-throw
	// exit and the fresh import of an edited config are properties of a real
	// node process, driven through the runner's own spawn seam.
	"real-process-spawn:clients/markdownlint-api.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a spinning rule is killed at the budget, a late throw ends only the child and an edited config is imported fresh; each exists only in a real node child",
	},
	"real-process-spawn:clients/markdownlint-no-fix-real.test.ts": {
		detector: "real-process-spawn",
		reason:
			"markdownlint-cli2's config merge and fix pass decide whether a lint run writes; a fake module would encode the guess that no option was missing",
	},
	"real-process-spawn:clients/mcp/review-rebuild.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the resolver verdict runRebuild acts on comes from the real package-manager lookup spawning the real which and executable stand-in managers on PATH; a doubled resolver hands each case the manager it then asserts on",
	},
	"real-process-spawn:clients/metrics-history-stderr.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children emit stderr bytes whose metrics classification cannot be observed in-process",
	},
	// 2026-10-22 (#4732): the cost under test is how many real `git status`
	// children each tool call spawns; a stubbed git answers the count it is
	// told.
	"real-process-spawn:clients/opaque-any-tool-4732.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the subject is the real git status children a captured tool call spawns, counted at the spawn boundary; a stubbed git answers only the count it was given",
	},
	"real-process-spawn:clients/project-data-dir-slug.test.ts": {
		detector: "real-process-spawn",
		reason:
			"two real Node children must contend on the production rename; an in-process mock cannot expose the cross-process ENOENT",
	},
	"real-process-spawn:clients/project-snapshot-cross-process.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the sibling snapshot writer must be a second real process: the stage sweep keys on its pid, and a second module instance here shares ours",
	},
	// 2026-10-20 (#4638): ruff's own config discovery and target-gated fixes are the
	// behaviour under test, so the case runs the real binary and its outcome
	// (fixed/changed) is the witness; it is serialized in the wall-clock lane.
	"real-process-spawn:clients/ruff-target-version-real.test.ts": {
		detector: "real-process-spawn",
		reason:
			"ruff's config discovery and target-gated fixes are the behaviour under test; a fake binary would encode the guess this ticket removed",
	},
	"real-process-spawn:clients/safe-spawn-ambient-signal.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real children receive ambient abort signals through the OS boundary, not an in-process double; #3375 adds two more - the default output cap needs a real pipe delivering tens of megabytes, and killTree's POSIX group arm is selected by /proc verifying that a REAL pid is this process's child, which no fabricated pid can satisfy",
	},
	"real-process-spawn:clients/safe-spawn-failure-taxonomy.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real child exit, timeout, and kill outcomes supply taxonomy facts unavailable from a stub",
	},
	"real-process-spawn:clients/safe-spawn-input.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real child reads stdin bytes through the pipe that safeSpawnAsync must close correctly",
	},
	// #5064: the ownership guard reads the live child's /proc ppid, so the
	// child is real; the mock beside it on the same module would hide it.
	"real-process-spawn:clients/safe-spawn-kill-ownership.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the kill-ownership cases need a real live child of this process: the ownership guard reads its /proc ppid, which no double carries; the child starts through vi.importActual beside the file's own child_process mock",
	},
	"real-process-spawn:clients/safe-spawn-resource-usage.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real child CPU and RSS samples prove usage bracketing around the spawn boundary",
	},
	"real-process-spawn:clients/safe-spawn-timeout-teardown.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a wedged real child proves timeout teardown and descendant cleanup across the process boundary",
	},
	"real-process-spawn:clients/safe-spawn-windows-command.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real Windows command-line parsing decides argument boundaries no in-process parser can validate",
	},
	// 2026-10-22 (#4530): whether the kernel ran a planted project executable
	// is only observable from a real child writing its marker file.
	"real-process-spawn:clients/session-repository-trust-4530.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real child writing a marker file is the only evidence of which bytes a lookup started; a stubbed spawn cannot show the kernel ran the project's file",
	},
	"real-process-spawn:clients/shared-checkout-guard.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children expose shared-checkout branch-switch races that an in-process model cannot reach",
	},
	// #5064: taskkill's pid is the real child this file starts through
	// vi.importActual beside its own child_process mock, so the census reads it.
	"real-process-spawn:clients/system32-exe-seam-fold.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the taskkill tree-kill case needs a real live child of this process: safeSpawnAsync's ownership guard reads its /proc ppid, which no double carries; the child starts through vi.importActual beside the file's own child_process mock",
	},
	"real-process-spawn:clients/test-runner-resolve-exec.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the global-bin and fallback arms of resolveExec are decided by the real package-manager lookup, which spawns the real which and executable stand-in managers; a doubled findGlobalBinary returns the path the case then asserts on",
	},
	// 2026-10-23 (#4789): a child process is the only observer of the HOME and
	// XDG directories a spawned tool inherits from the worker.
	"real-process-spawn:clients/worker-home-pin-hermeticity.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the claim is what a CHILD process sees of the worker's environment, the inheritance the #4780 opengrep writes into the real home depended on; an in-process read of process.env proves the worker, not the child, and the probe child only prints its environment",
	},
	"real-process-spawn:config/gitignore-tracked-shadow.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real gitignore rules and index entries decide shadow files outside the test process",
	},
	"real-process-spawn:config/heavy-advisory-gate-workflow.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the subject is the real `Record Windows Vitest outcome` bash block under GitHub's bash flags (a fixture Node program at the population-script path runs under the real `node`, so no PATH, delimiter, or executable name is mocked) and the ref-deleted Git fetch form through the git-fixture-env seam",
	},
	"real-process-spawn:config/oxlint-advisory-rule-floor-gate.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real advisory argv and counter process are the only faithful proof that CI sees a nonzero type-aware rule population",
	},
	"real-process-spawn:config/tracked-control-bytes.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git emits control bytes from its index, which a hand-built output cannot certify",
	},
	// 2026-10-17 (#4504): the first host-level witness admitted for a real
	// spawn. The production state it reproduces is a concurrent secondary
	// session whose cwd is a LINKED WORKTREE — a `.git` file, a shared object
	// store, a worktree-local toplevel — and `git worktree add` is the only way
	// to make one. The prescan's own recovery is git's `status --porcelain`, so
	// a stubbed git would answer neither question.
	// 2026-10-19 (#2050): a real linked worktree (`git worktree add`), pi's own
	// `bash` tool running the script, and the real tree-sitter dispatch are the
	// subject; a stubbed shell or git could not answer whether the worktree's
	// own `git status` saw the write.
	"real-process-spawn:index-2050-worktree-bash-dispatch-witness.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the subject is what a real bash command does to a real linked worktree, detected by git's own status; a stubbed shell or git answers neither",
	},
	"real-process-spawn:index-4504-opaque-prescan-root-witness.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a linked worktree exists only when real git creates one, and the opaque prescan under test recovers through git's own status; a stub proves only that the stub answers",
	},
	// 2026-10-22 (#4732): a tool another extension registers writes into a real
	// checkout through pi's own tool loop, and git's own status is the detector.
	"real-process-spawn:index-4732-opaque-any-tool-witness.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the subject is what a real non-bash tool writes into a real git checkout, detected by git's own status; a stubbed git answers only what it was told",
	},
	// 2026-10-31 (#5108): a script-written file's blocker must reach the model
	// through a real bash tool call, and the abandonment is a real 500 ms wall
	// bound racing a handler held open past it.
	"real-process-spawn:index-5108-opaque-blocker-disclosure-witness.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the subject is what a real bash tool call writes into a real git checkout and what the model receives for it, detected by git's own status; a stubbed shell answers only what it was told",
	},
	// 2026-09-03: the published-manifest guard must run the real `npm pack`
	// (prepack/postpack are npm lifecycle hooks); header on the file states why.
	"real-process-spawn:packaging-pack-manifest.test.ts": {
		detector: "real-process-spawn",
		reason:
			"observes the real npm pack lifecycle (prepack/postpack), and unpacks that real tarball to check what ships (#3219); no in-process double is faithful",
	},
	// #4169: the TypeScript-source entry (`pi -e index.ts`) is transpiled by the
	// real host's jiti loader rather than native-imported, so /reload re-evaluates
	// the pi-lens graph and only a real child reaches the orphaned module-scope
	// runtime; no in-process double produces a fresh module instance.
	"real-process-spawn:real-harness/bridge-reload-ts.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real pi host must transpile the TypeScript-source pi-lens entry, re-evaluate its module graph on /reload, and keep a third-party v1 bridge read connected to the live runtime (#4169)",
	},
	"real-process-spawn:real-harness/bridge-reload.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the shipped real pi host must reload the built extension and keep a third-party v1 bridge read connected to the live runtime across that lifecycle boundary (#4169)",
	},
	// 2026-10-07 (#4081): 1 -> 3. Whether teardown waits for, tree-kills and
	// bounds a real child and its detached grandchildren, and whether removal
	// outlasts a live writer, are only observable against real processes: an
	// EventEmitter double has no pid, no reparenting and no files to write.
	// 3 -> 7 in #4082 round 3: four child scripts build the process trees the
	// tree kill and the kill guard are tested against (a self-exiting mid
	// process, a root forking during the kill, a reparented orphan); the
	// guard's verdict reads the kernel's PPid, which no double has.
	"real-process-spawn:real-harness/child-exit.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real pi child death is the process-boundary failure that must reject a governed waiter promptly; real child/grandchild processes are the only evidence that teardown reaps a process tree, that the kill guard admits exactly that tree, and that removal outlasts a live writer (#4081)",
	},
	// 2026-09-15 (#2154 AC1): 1 -> 3, then 3 -> 7 in #3060 round 2 (review F1 +
	// F2). The reported defect needs TWO LIVE pi sessions over one project root
	// and one PI_LENS_HOME — the durable stores they share are keyed by exactly
	// that pair, so one child (or a pair of in-process doubles) cannot reach
	// the crossing at all. Round 2 adds two more pairs: the same two sessions
	// with the clean edit's mtime preserved (the edit-during-scan state), and
	// the reporter's own two-WORKTREE configuration, which needs two roots
	// under one home and therefore two more children.
	"real-process-spawn:real-harness/diagnostic-provenance.test.ts": {
		detector: "real-process-spawn",
		reason:
			"two concurrent real pi children must share one project root and one PI_LENS_HOME; the cross-session stores are keyed by that pair",
	},
	// 2026-10-16 (#4513): 3 -> 4. pi 1.3 restores a resumed session's active tools
	// from the transcript while pi-lens re-plans its lazy-tool set at
	// session_start; which of the two decides, and whether the first request after
	// a `--continue` restart advertises the same roster, is observable only on a
	// real second pi process reading the first one's session file and sidecar.
	"real-process-spawn:real-harness/lifecycle.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the first request after a real pi restart on a persisted session must advertise the lazy-tool roster pi restored and pi-lens planned; no in-process double runs the host's restore",
	},
	"real-process-spawn:real-harness/negative.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real pi must surface provider exhaustion and malformed tool arguments across the process boundary",
	},
	"real-process-spawn:real-harness/outside-root.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real pi host must deliver the out-of-root advisory and degradation record through the process boundary, including the second edit and owned-path exemptions; #4292 also kills a real startup jscpd scan with caller TMPDIR overrides to prove scanner-root cleanup",
	},
	"real-process-spawn:real-harness/provider-compatibility.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the installed pi host must load the built extension and expose its provider roster across the process boundary",
	},
	// 2026-10-08 (#4138, #3831, #4185 round 2): the branch a read record is
	// admitted to is pi's own session branch after a real RPC clone rebinds the
	// extension, and the nested ids (`c1/1`, parent `c1`) and the toolResult pi
	// persists for a codemode call exist only in the real host. Round 4 adds
	// four: pi's own agent loop decides that a call a later extension blocked
	// gets tool_execution_end and no tool_result, in what order, top-level,
	// parallel and nested. Round 5 adds one: a later extension's tool_result
	// hook rewrites a failed read's isError after pi-lens saw it, which only
	// pi's own hook chain produces.
	"real-process-spawn:real-harness/read-guard-moves.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the read guard's branch admission after a real RPC clone, the nested-call ids pi mints, and the tool_execution_end pi's agent loop emits for a call a later extension blocked cannot be produced by an in-process double",
	},
	"real-process-spawn:real-harness/scenario-1.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real pi RPC host and extension lifecycle cannot be certified by an in-process double",
	},
	"real-process-spawn:real-harness/scenario-2.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the expired successor hand-off and activation roster must cross the real pi process boundary",
	},
	"real-process-spawn:real-harness/scenario-3.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real host tool handler and read guard must cross the pi process boundary",
	},
	// 2026-09-10 (#2800): the tools.<name>.enabled roster is what pi's provider
	// receives on the wire; a mocked host cannot certify which tools the real
	// extension registered. Header on the file states why.
	"real-process-spawn:real-harness/tools-enabled.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the provider wire roster and session-start log are produced by a real pi host loading the built extension; an in-process double cannot certify tools.<name>.enabled (#1416)",
	},
	// #3870: the detector tests drive the analyzer's real CLI entry point as a
	// real node subprocess over redacted fixture logs; an in-process call could
	// not prove the --root/--json/--since argv or the JSON report boundary.
	"real-process-spawn:scripts/analyze-pi-lens-logs-detectors.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the tests spawn the analyzer's real CLI over fixture logs; an in-process call cannot prove the --root/--json argv or the JSON report boundary (same seam as analyze-pi-lens-logs.test.ts)",
	},
	// #3684: the advisory scope is the wrapper's own `git diff` against a real
	// throwaway fixture repo; an in-process call cannot prove the git boundary
	// or the wrapper's argv/env (GITHUB_BASE_REF) handling.
	"real-process-spawn:scripts/astgrep-self-scan.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the wrapper's advisory scope runs a real `git diff` in a throwaway fixture repo and reads argv/env; an in-process double proves neither boundary",
	},
	// #3795: the one-fragment-per-PR check diffs a real fixture repo through
	// real `git` (`git diff` plus `git ls-files --others`); that command
	// boundary is the subject, and no in-process double reproduces git's own
	// tracked-vs-untracked split.
	"real-process-spawn:scripts/changelog-entries.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the PR-diff fragment count shells out to real `git` against a fixture repo; an in-process double cannot prove git's tracked-vs-untracked split",
	},
	// #2807 review F1/F4: the local CLI's exact argv and a shallow checkout's
	// missing diff are the subjects; an in-process call cannot prove either.
	// 2026-10-24 (#4691): the nightly CLI is the subject; it runs as a real child
	// process whose PATH holds a gh stand-in, so no in-process double reproduces its
	// argv, annotation output or exit codes.
	"real-process-spawn:scripts/check-ci-job-p90.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the nightly CLI runs as a real child with PATH at a recorded gh stand-in; an in-process double would not prove its annotation escapes or exit codes",
	},
	"real-process-spawn:scripts/check-pr-body.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the exact local CLI, shallow checkout, `git check-ignore` (#2904) and the gh label read behind `--lint-local` (#4288, PATH stub) are the subjects; an in-process double cannot prove any of those command boundaries",
	},
	// 2026-10-14 (#4397): the changed-test shuffle job's exit code is the contract;
	// only a real vitest start reorders the cases of a fixture that shares state.
	"real-process-spawn:scripts/ci-shuffle-changed-tests-spawn.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the job's exit code is the contract; an injected exec restates the flags the script builds instead of proving real vitest reorders and reds a file that shares state. Also one throwaway-repo case (#4456): the default diff and added lists are real `git diff --diff-filter=A` calls whose add/modify/rename meaning is git's, so a double would restate it",
	},
	// 2026-10-07 (#4072 review F2): the executable CLI's exit status is the
	// contract; an in-process main() call cannot prove the entry-point boundary.
	"real-process-spawn:scripts/ci-test-diff.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the executable CLI exit status is the contract; an in-process main call cannot prove the entry-point boundary",
	},
	"real-process-spawn:scripts/ci-verdict.test.ts": {
		detector: "real-process-spawn",
		reason:
			"#3883 F3: the final exit line and process status live at the real main() boundary; only a spawned CLI observes them",
	},
	"real-process-spawn:scripts/download-test-history-artifacts.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real gh child is required to prove transient API failure recovery, persistent failure, and a ZIP over the default spawn buffer at the process boundary",
	},
	// #4518: the evaluated-floor steps of grammar-health.yml, ci.yml and lint.yml
	// are shell text; the exit-code mapping, `set +e`, a step output read by the
	// next step and `| tee` under pipefail are observable only by running bash.
	"real-process-spawn:scripts/floor-steps-executed.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the evaluated-floor steps are shell text from the workflows; only a real bash running the extracted run: shows that a swallowed status, a renamed step id or a pipe without pipefail reds or lies on the nightly",
	},
	"real-process-spawn:scripts/git-fixture-env.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children prove both fixture envs resolve repository metadata (HEAD, root) from a sanitized process.env and, since #4552, fork no detached auto-maintenance child: the .mjs commit and the TypeScript-twin commit are the two witnesses, and a relocated copy of the .mjs helper must refuse to run without its policy file",
	},
	// 2026-09-07 (#2699): the PreToolUse guard's own stdin/exit-code/stderr
	// contract is the subject under test; an in-process call to the exported
	// classify functions cannot see a drift in what Claude Code actually
	// invokes.
	"real-process-spawn:scripts/guard-bash-hook.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the hook's real stdin/exit-code/stderr contract is unobservable from an in-process call to the exported classify functions",
	},
	"real-process-spawn:scripts/guard-bash-probe.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real hook stdin/exit-code contract and head-to-head differential are unobservable through an in-process classifier call",
	},
	// #4291: the handshake and report steps of install-smoke.yml are shell text;
	// pipefail and the crash line are observable only by running the real bash.
	"real-process-spawn:scripts/install-smoke-handshake-steps.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the pipefail pipe into tee and the failing-row report are shell text from the workflow; only a real bash running the extracted run: shows that a red handshake exits non-zero and that a crash with no rows is not reported as clean",
	},
	// #2698: gitignore/tracked-vs-untracked resolution (git init/add/commit/
	// ls-files against a throwaway fixture repo) is the exact mechanism
	// scripts/lib/knip-sibling-purge.mjs depends on and this file tests.
	"real-process-spawn:scripts/knip-sibling-purge.test.ts": {
		detector: "real-process-spawn",
		reason:
			"gitignore/tracked-vs-untracked resolution is the mechanism under test; no mock reproduces git's own resolution faithfully",
	},
	// #4047: the CLI's verdict and exit code are what a delegated lane acts on;
	// they come from parsing the real selector, red-on-base and vitest
	// transcripts over a real Git fixture, which an in-process stub restates.
	"real-process-spawn:scripts/lane-check.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's verdict and exit code are parsed from the real selector, red-on-base and vitest transcripts over a real Git fixture; an in-process stub restates the transcript instead of proving the parse",
	},
	// 2026-09-07 (#2700): the gating/advisory subset test resolves oxlint's
	// REAL `--print-config` for both npm scripts (never a hand-copied rule
	// list) so a change to either script's flags is caught automatically; an
	// in-process double would just restate the test author's assumption
	// about which rules each tier enables.
	"real-process-spawn:scripts/lint-js.test.ts": {
		detector: "real-process-spawn",
		reason:
			"resolves oxlint's real --print-config for lint:js and lint:js:advisory; no in-process double is faithful",
	},
	"real-process-spawn:scripts/lockfile-completeness.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real pinned npm child is required to reproduce lockfile optional-binding rewrites; a process double cannot validate npm behavior",
	},
	// 2026-10-21 (#4717): two CI jobs import the PR-body script with no
	// install; only a fresh node over a scripts copy with no node_modules
	// proves the lexer's lazy marked load keeps them resolvable.
	"real-process-spawn:scripts/markdown-lexer-entry-points.test.ts": {
		detector: "real-process-spawn",
		reason:
			"what a fresh node resolves from a scripts tree with no node_modules is the boundary under test; an in-process import shares vitest's resolved modules",
	},
	// 2026-10-16 (#4510): the killed-runner witness ends its own vitest
	// launcher from outside the worker (the kill guard refuses process.kill).
	"real-process-spawn:scripts/mutate-fixture.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the fixture kills its parent vitest launcher through kill(1), because the kill guard refuses process.kill on a pid the file does not own; no in-process call ends the runner",
	},
	// 2026-09-26 (#3531): the CLI smoke test spawns a real node child to prove
	// scripts/mutation-report.mjs's own argv parsing (--report/--out) and
	// file I/O; an in-process call would just re-exercise the exported render
	// function the other describe block already covers.
	"real-process-spawn:scripts/mutate.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the mutation CLI's child Vitest process and signal path are the process boundary; an in-process call cannot prove restoration after SIGINT",
	},
	"real-process-spawn:scripts/mutation-report-render.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI entry script's own argv parsing and file I/O is the subject; an in-process call re-tests only the exported render function",
	},
	// 2026-09-07 (#2613 review S2/T3): --dry-run env-reading/report-building
	// wiring is the subject; the real `gh` calls stay untested, same
	// documented exception as the sibling scripts/notify-clean-signal-drift.mjs.
	"real-process-spawn:scripts/notify-install-smoke-drift.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's env-to-report wiring in --dry-run mode is unobservable from an in-process stub",
	},
	// 2026-09-07 (#2723): the second, independent tool-smoke red-notifier
	// CLI's --dry-run env-to-report wiring and real (stubbed) `gh`
	// create/edit/comment/close subcommands are the subject; same documented
	// exception as its sibling notify-install-smoke-drift.test.ts above.
	"real-process-spawn:scripts/notify-tool-smoke-red.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's env-to-report wiring and real gh subcommand invocations are unobservable from an in-process stub",
	},
	// 2026-09-07 (#2613 review S3a): the retry wrapper's real exit code and
	// distinct ::error::infra: label on exhaustion are the subject.
	"real-process-spawn:scripts/npm-retry.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's real exit code and distinct infra label on exhaustion are unobservable from an in-process stub",
	},
	// #3723: the open/close CLI's own process entry against a real git
	// fixture -- the worktree registry, the on-disk node_modules symlink, the
	// #3173 unlink-before-remove ordering, and the exit code decide the run;
	// no in-process double reaches those command boundaries.
	"real-process-spawn:scripts/pr-worktree.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's real git fixture, node_modules symlink state, unlink-before-remove ordering, and exit code are the subject; an in-process double restates none of them",
	},
	// #3451: the hook's format step is a shell pipeline (git diff | xargs
	// oxfmt); the bug was xargs turning oxfmt's exit 2 into 123 at the process
	// boundary, which only the real hook run shows.
	"real-process-spawn:scripts/pre-commit-hook.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real hook pipes git through xargs into the pinned oxfmt; the exit-123 refusal and handoff refusal are process-boundary facts",
	},
	"real-process-spawn:scripts/pre-push-targeted-tests.test.ts": {
		detector: "real-process-spawn",
		reason:
			"git's pre-push stdin and the hook script's exit/skip/lock-timeout contract are the subject; the union and lock-admission witnesses need a real git fixture and the real hook chain",
	},
	"real-process-spawn:scripts/prune-agent-worktrees.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git worktree commands own pruning locks and exit status beyond in-process filesystem state",
	},
	// #3724: the real CLI and Git worktree lifecycle are the behavior under test;
	// an in-process substitute cannot prove child argv, cwd, or cleanup ordering.
	"real-process-spawn:scripts/red-on-base.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the real CLI and Git worktree lifecycle are the behavior under test; an in-process substitute cannot prove child argv, cwd, or cleanup ordering",
	},
	"real-process-spawn:scripts/release-qa.test.ts": {
		detector: "real-process-spawn",
		reason:
			"npm ignoring a handed env, a child's own os.homedir(), and main()'s CLI pack call site and exit code are each unobservable in-process",
	},
	// 2026-09-07 (#2613): the CLI's real exit code (2 vs. 4) and its
	// GITHUB_OUTPUT write are the subject under test; header on the file
	// states why.
	"real-process-spawn:scripts/resolve-newest-in-range-host.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's real exit code (2 vs. 4) and GITHUB_OUTPUT side effect are unobservable from an in-process stub",
	},
	// 2026-10-14 (#4401): the RPC session smoke's exit code is the contract; only
	// a real child (a stand-in pi at the process boundary) can exit, or write a
	// signal on stdout, and turn that code red.
	"real-process-spawn:scripts/rpc-load-check-spawn.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the smoke's exit code is the contract; an in-process call of the classifier cannot prove that a pi child that exits, or a signal on its stdout, turns the exit code red",
	},
	// 2026-10-24 (#4789): the child-report cases read the HOME and XDG dirs a
	// REAL child inherits from the shared scratch home pin; an in-process read of
	// the env object cannot show what the child process sees.
	"real-process-spawn:scripts/scratch-home-env.test.ts": {
		detector: "real-process-spawn",
		reason:
			"what a spawned child inherits (HOME, USERPROFILE, XDG dirs) is only observable in the child process",
	},
	// #3401: the seed script's default git argv (depth-2 fetch, refspec, blob
	// specs) only means something against a real repo and a depth-1 clone.
	"real-process-spawn:scripts/seed-matrix-from-bot-branch-real-git.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the fetch depth, refspec and rev-parse specs are the subject; an in-memory git restates them instead of proving them against real git",
	},
	// #3674: git's own per-worktree resolution of core.hooksPath and the real
	// husky binary are the subject; a double would restate the path it wrote.
	"real-process-spawn:scripts/setup-git-hooks.test.ts": {
		detector: "real-process-spawn",
		reason:
			"git resolves core.hooksPath per worktree at its own process boundary; the real script and husky binary are the subject",
	},
	// 2026-09-06 (#2369): the fixture-ordering defect (an earlier LSP_FIXTURES
	// entry registering a foreign session root, declining a later one) lives
	// in the CLI's own module-load order; only a real child process is the
	// script under test.
	"real-process-spawn:scripts/smoke-tools-lsp-fixture-registration.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the fixture-ordering defect lives in the CLI's own module-load order; no in-process call is the script under test",
	},
	"real-process-spawn:scripts/sonar-master-gate.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the CLI's exit codes and rendered stdout/stderr are the process-boundary contract; an in-process fetch call cannot certify the real entry point",
	},
	// 2026-09-27 (#3592 round 2 F1): the driver's temporal-dead-zone crash
	// (`baseMeta` reading a `let costEstimate` still in the TDZ from four
	// early-exit call sites) only exists in the real module's own top-level
	// execution order; a source-text assertion on the driver already passed
	// under the crash, so only spawning the actual script against a real,
	// throwaway git fixture reproduces it. The count moved 3 -> 4 with the
	// #3853 lock test: whether the real driver waits behind a live exclusive
	// holder (and refuses to fork vitest) is only observable by spawning the
	// real script, since the lock lives in the driver's own top-level order.
	// The count moved 4 -> 8 with #3856 F3: the heartbeat/refusal behind a live
	// exclusive holder, the budget-signal abort, the absent and partial
	// coverage reports, and the skipped/corrupt compiled source are each only
	// observable by spawning the real driver against the throwaway fixture.
	"real-process-spawn:scripts/stryker-diff.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the defect is a temporal-dead-zone crash in the driver's own top-level execution order; the #3853 lock wait/refusal and the #3856 F3 stage dispositions (heartbeat/refusal behind a live holder, the budget-signal abort, the absent and partial coverage reports, the skipped/corrupt compiled source) are only observable by spawning the real script, and no source-text or in-process substitute reproduces them",
	},
	// 2026-10-07 (#4038 r5): run 37601788256's publish step crashed in the
	// script's process-entry block, which only a real `node` process runs;
	// the in-process `main()` tests never reached it.
	"real-process-spawn:scripts/stryker-nightly.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the defect lived in the CLI entry block (`import.meta.url === argv[1]`), which only a real node process executes",
	},
	// 2026-09-06 (#2586 review F1): proves the actual delimiter
	// supply-host-provided-deps.mjs prints in its own stdout bytes; an
	// in-process double would just re-assert the test author's assumption.
	"real-process-spawn:scripts/supply-host-provided-deps.test.ts": {
		detector: "real-process-spawn",
		reason:
			"observes the script's real stdout bytes (newline- vs. space-delimited); no in-process double is faithful",
	},
	// 2026-09-08 (#2628): the warm's install-log home resolution is the
	// subject — a child whose env is fully pinned decides where the record
	// lands, and its own `os.homedir()` fallback is unobservable in-process.
	"real-process-spawn:scripts/warm-loader-cache.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the record's landing spot is decided by a child's own env-pinned os.homedir() fallback; unobservable in-process",
	},
	// #5111: the worktree-removal helper's decision over a real git fixture --
	// the worktree registry, the on-disk node_modules symlink-or-directory
	// state, and the unlink-before-remove ordering decide the run.
	"real-process-spawn:scripts/worktree-remove.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the helper's real git fixture, node_modules symlink state, and unlink-before-remove ordering are the subject; an in-process double restates none of them",
	},
	"real-process-spawn:support/fault-injection.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a genuinely wedged child proves pipe and kill behavior that a resolved promise cannot model",
	},
	"real-process-spawn:support/git-config-guard.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git config reads resolve worktree-local policy through Git's own config precedence",
	},
	"real-process-spawn:support/git-fixture-env.test.ts": {
		detector: "real-process-spawn",
		reason:
			"real git children prove the support-side fixture scrubs GIT_DIR/GIT_WORK_TREE and pins cwd before a test spawns git",
	},
	"real-process-spawn:support/path-probe-stub.test.ts": {
		detector: "real-process-spawn",
		reason:
			"the stub exists so production lookups spawn real executable stand-ins; its fidelity (hermetic PATH, the served query, restore) is only observable through a real child",
	},
	// 2026-09-17 (#3179): the race is cross-process by construction —
	// readdirSync/statSync inside node's own recursive-watch polyfill are
	// blocking syscalls on one thread, so only a separately spawned process
	// removing the watched directory can land inside that window.
	"real-process-spawn:support/tests-tree-write-guard-race.test.ts": {
		detector: "real-process-spawn",
		reason:
			"a real cross-process directory removal races node's own recursive-watch readdirSync; no in-process stand-in can occupy the other side of that window",
	},
	"real-process-spawn:support/vitest-setup-registry-teardown.test.ts": {
		detector: "real-process-spawn",
		reason:
			"#3617: the subject is Vitest's own fork teardown (the pool SIGTERMs the worker after the shared afterAll); no in-process double reproduces that kill or a hook timeout",
	},
	// 2026-10-15 (#4485): the cascade's silent-push wait, turn_end's registry
	// peek and the expiry read each read a language-server client's publish
	// state; a real server cannot be made to publish or stay silent on demand.
	"service-double:clients/cascade-compute.test.ts::LSPClientInfo": {
		detector: "service-double",
		reason:
			"a language-server client is a spawned process; the cascade's silent-push wait is driven by its per-file publish version and its wait, which a real server cannot be made to answer or leave silent on demand",
	},
	"service-double:clients/cascade-pre-edit-answer-5040.test.ts::LSPClientInfo":
		{
			detector: "service-double",
			reason:
				"a language-server client is a spawned process; the cell drives the real touchFile's reuse decision, which reads the client's per-file publish stamp and its wait, and needs a server that answers once and then never again",
		},
	"service-double:clients/cascade-turn-merge.test.ts::LSPClientInfo": {
		detector: "service-double",
		reason:
			"a language-server client is a spawned process; turn_end's registry peek is driven by what the client an outstanding touch holds has published",
	},
	"service-double:clients/lsp/cascade-tier-backlog.test.ts::LSPClientInfo": {
		detector: "service-double",
		reason:
			"a language-server client is a spawned process; the expiry and peek reads are driven by what the client an outstanding touch holds has published",
	},
	// 2026-10-15 (#4449): the registry's capacity, lease and idle paths read a
	// client's liveness and busy answers; a real language server cannot be made
	// to give them on demand.
	"service-double:clients/lsp/client-registry-direct.test.ts::LSPClientInfo": {
		detector: "service-double",
		reason:
			"a language-server client is a spawned process; the registry's lease, capacity and idle paths are driven by its liveness and busy answers",
	},
	"service-double:clients/lsp/opt-in-auxiliary-4929.test.ts::LSPClientInfo": {
		detector: "service-double",
		reason:
			"the transport double hands back a client that stands in for a running language server; which ids start, and whether an untrusted project may, is decided by the real acquisition",
	},
	// 2026-10-23 (#4785 F4): see the in-process-mock entry for this file.
	"service-double:clients/lsp/touch-cleared-deferred-wait-4785.test.ts::LSPClientInfo":
		{
			detector: "service-double",
			reason:
				"a language-server client is a spawned process; this client's wait, store and clear are the real ones over a real state, and only the publish order and the mid-wait clear are scripted",
		},
	// 2026-10-15 (#4485): see the cascade entries above.
	"service-double:clients/quiet-window-session-straddle.test.ts::LSPClientInfo":
		{
			detector: "service-double",
			reason:
				"a language-server client is a spawned process; the straddle needs it silent through the cascade's bounded wait so the touch is recorded outstanding",
		},
	// 2026-09-26 (#3511 review round 3): the quick-mode warmup witness must
	// run the real warmup timer and background word-index save, which no
	// test hook awaits.
	// 2026-10-16 (#4528 r1 F3): the spawn-gate window of a dependency restart
	// exists only between real server processes, and the tool_call hook bounds
	// its look, so the restart finishes after the hook returns.
	"ungoverned-wait-for:clients/head-move-resync-4493.test.ts": {
		detector: "ungoverned-wait-for",
		reason:
			"the restart's spawn-gate window is between real server processes: one server's shutdown, the cache clock, and a restart that ends after the bounded tool_call hook returns expose no awaitable, so vi.waitFor joins them",
	},
	// 2026-10-23 (#4776 review H1): a formatter selection written after a trust
	// change is observable only while a real detection is held open in its
	// child process, and the child's start is visible only as the file it
	// writes.
	"ungoverned-wait-for:clients/session-repository-trust-4530.test.ts": {
		detector: "ungoverned-wait-for",
		reason:
			"the late-write cell holds a real formatter detection open in a child `go` until trust changes; the child's start exposes no awaitable, only the file it writes",
	},
	"ungoverned-wait-for:clients/word-index-lifecycle.test.ts": {
		detector: "ungoverned-wait-for",
		reason:
			"session_start's background tasks and the quick-mode warmup timer expose no awaitable, so a real-time vi.waitFor is the only join on their snapshot save",
	},
	// 2026-10-18 (#4583): a cold word-index build is fire-and-forget (its
	// `triggerBackgroundWordIndexBuild` status is not joinable), so a witness
	// that must observe the published snapshot has only vi.waitFor.
	"ungoverned-wait-for:clients/word-index.test.ts": {
		detector: "ungoverned-wait-for",
		reason:
			"the cold build's completion exposes no awaitable, so the adoption witness joins the snapshot it publishes with vi.waitFor",
	},
	// 2026-10-23 (#4316): the session-start LSP warm is a floating promise
	// inside the loaded extension copy, so its record is joinable only by
	// polling the log the copy writes.
	"ungoverned-wait-for:index-4316-lsp-warm-record.test.ts": {
		detector: "ungoverned-wait-for",
		reason:
			"the session-start LSP warm is a fire-and-forget promise inside the loaded extension copy and exposes no awaitable, so vi.waitFor joins the record it writes",
	},
	// 2026-10-28 (#4943): a collect-later runner's answer settles inside the
	// loaded extension copy; the dispatcher logs a row when it lands.
	"ungoverned-wait-for:index-4943-telemetry-session-stamp.test.ts": {
		detector: "ungoverned-wait-for",
		reason:
			"a collect-later runner answer settles inside the loaded extension copy and exposes no awaitable, so vi.waitFor joins the latency row the dispatcher logs when it lands",
	},
	"ungoverned-wait-for:tools/symbol-search.test.ts": {
		detector: "ungoverned-wait-for",
		reason:
			"the cold build's completion exposes no awaitable, so the tool witness joins the snapshot it publishes with vi.waitFor",
	},
};

/** The `wallClockBudgetInclude` project's `include` list, read from the live config — not a hand-copied mirror of it (single-source-of-truth). */
function wallClockBudgetInclude(): string[] {
	const projects: unknown = (vitestConfig as { test?: { projects?: unknown } })
		.test?.projects;
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
		.find((test) => test?.name === "wall-clock-budget");
	if (!project) {
		throw new Error(
			'vitest.config.ts has no project named "wall-clock-budget"',
		);
	}
	const include = project.include;
	if (!Array.isArray(include)) {
		throw new Error('"wall-clock-budget" project has no include list');
	}
	return include.map(String);
}

// #3546: `supportHelperHasLaneProof` re-walks the whole `tests/**/*.test.ts`
// import graph, from scratch, once per admitted/pinned `support/` entry the
// caller asks about — and `localImportTargets` (hook-await-scan.mjs:291) has
// no cache of its own, so every candidate file it touches is re-read and
// re-parsed on every call. Same shape as #3514/PR #3542: a per-file walk's
// shared cost, billed to a single test's own budget instead of a budget
// sized for the walk. `cachedTestFiles`/`importTargetsCache` memoize the two
// per-file costs (the file list, and each file's import targets) across
// every call this test file makes, keyed by absolute path, so the second
// admitted entry (and any repeated BFS visit inside one entry's own walk)
// pays nothing beyond a Map lookup.
let cachedTestFiles: string[] | undefined;
function cachedAllTestFiles(): string[] {
	if (cachedTestFiles === undefined) {
		cachedTestFiles = allTestSourceFiles().filter((file) =>
			file.endsWith(".test.ts"),
		);
	}
	return cachedTestFiles;
}

const importTargetsCache = new Map<string, string[]>();
function cachedLocalImportTargets(absolute: string): string[] {
	let targets = importTargetsCache.get(absolute);
	if (targets === undefined) {
		targets = localImportTargets(absolute);
		importTargetsCache.set(absolute, targets);
	}
	return targets;
}

/** Support helpers inherit the serialized lane from an importing test. */
function supportHelperHasLaneProof(
	relativePath: string,
	included: ReadonlySet<string>,
): boolean {
	const target = path.join(repoRoot, "tests", relativePath);
	const files = cachedAllTestFiles();
	const visited = new Set<string>();
	const walk = (absolute: string): boolean => {
		if (visited.has(absolute)) return false;
		visited.add(absolute);
		const relative = path
			.relative(repoRoot, absolute)
			.replaceAll(path.sep, "/");
		if (absolute.endsWith(".test.ts") && included.has(relative)) return true;
		return files.some(
			(candidate) =>
				cachedLocalImportTargets(candidate).includes(absolute) &&
				walk(candidate),
		);
	};
	return files.some(
		(candidate) =>
			cachedLocalImportTargets(candidate).includes(target) && walk(candidate),
	);
}

interface RatchetProblem {
	file: string;
	detector: DetectorName;
	kind: "new-file" | "count-risen" | "stale-ceiling";
	before?: number;
	after: number;
}

/**
 * Compare today's live counts against the pinned baseline for one detector.
 * Three directions are problems: a file the baseline has never seen, an
 * allowlisted file whose count exceeds its pin, and — two-sided — an
 * allowlisted file whose count FALLS below its pin (a stale ceiling: left
 * alone it silently re-admits regrowth up to the old, higher pin without
 * ever tripping the RISES check). A file that drops out of the live scan
 * entirely is handled separately (see "the baseline names no file that has
 * vanished" below); this function only walks `live`, so a file no longer
 * flagged at all is not iterated here.
 */
function auditAgainstBaseline(
	detector: DetectorName,
	live: Readonly<Record<string, number>>,
	baseline: Readonly<Baseline> = FLAKE_SHAPE_BASELINE,
): RatchetProblem[] {
	const pinned = baseline[detector] ?? {};
	const problems: RatchetProblem[] = [];
	for (const [file, count] of Object.entries(live)) {
		const before = pinned[file];
		if (before === undefined) {
			problems.push({ file, detector, kind: "new-file", after: count });
		} else if (count > before) {
			problems.push({
				file,
				detector,
				kind: "count-risen",
				before,
				after: count,
			});
		} else if (count < before) {
			problems.push({
				file,
				detector,
				kind: "stale-ceiling",
				before,
				after: count,
			});
		}
	}
	return problems;
}

function describeProblem(p: RatchetProblem): string {
	const admitted = ADMITTED_AFTER_BASELINE[`${p.detector}:${p.file}`];
	const admittedNote = admitted
		? ` (admitted: ${admitted.reason})`
		: MOCK_DETECTORS.has(p.detector)
			? " — mock only a process boundary (PROCESS_BOUNDARY_MODULES) or drive " +
				"the real seam or the shared double factory; to admit it, add a " +
				"`// flake-shape: <detector> — <reason>` header, an " +
				"ADMITTED_AFTER_BASELINE entry and the baseline row"
			: " — admit it with a `// flake-shape: <detector> — <reason>` header " +
				"and add the file to vitest.config.ts's wallClockBudgetInclude, or " +
				"remove the real spawn / wall-clock assertion / raw timer wait";
	if (p.kind === "new-file") {
		return `${p.detector}: NEW flagged file ${p.file} (${p.after} hit(s))${admittedNote}`;
	}
	if (p.kind === "stale-ceiling") {
		return (
			`${p.detector}: ${p.file} fell from ${p.before} to ${p.after} hit(s) ` +
			`— tighten the baseline to ${p.after}`
		);
	}
	return `${p.detector}: ${p.file} rose from ${p.before} to ${p.after} hit(s)${admittedNote}`;
}

// #3514: `countsByDetector` already shares one walk + one parse per file
// across every detector (`countsPromise`, flake-shape-scan.ts) — the walk
// itself is not redone. But that shared cost is only PAID on the first call,
// and `it.each(DETECTOR_NAMES)` below calls it in DETECTOR_NAMES order, so
// whichever detector is first (`real-process-spawn`) absorbed the FULL
// all-detector cost inside its own 30s per-test budget, not just its own
// share. Measured on this box (4 cores, load average ~27, run 2026-09-26):
// real-process-spawn's own detector work is ~22s of a ~117s total — raw-
// timer-wait's AST walk (`timerBindings` + its own call-site visit) is the
// biggest single share at ~84s. Paying the whole thing once here, under its
// own budget decoupled from any one detector's timeout, means no single
// "detector %s" case is billed for work that belongs to all of them (seven
// since #4362; the two mock detectors added ~2.5 s to the shared walk).
const WALK_TIMEOUT_MS = 180_000;

describe("flake-shape ratchet (#2547)", () => {
	beforeAll(async () => {
		for (const detector of DETECTOR_NAMES) await countsByDetector(detector);
	}, WALK_TIMEOUT_MS);

	it("keeps every admission map sorted", () => {
		// #2671 recurrence: an unsorted admission is a merge-conflict magnet.
		expect(() => assertSortedRegistry("fixture", ["b", "a"])).toThrow(
			"entries must be sorted",
		);
		for (const detector of DETECTOR_NAMES) {
			assertSortedRegistry(
				`flake-shape-baseline:${detector}`,
				Object.keys(FLAKE_SHAPE_BASELINE[detector]),
			);
		}
		assertSortedRegistry(
			"ADMITTED_AFTER_BASELINE",
			Object.keys(ADMITTED_AFTER_BASELINE),
		);
		assertSortedRegistry("wallClockBudgetInclude", wallClockBudgetInclude());
	});
	it.each(DETECTOR_NAMES)(
		"detector %s: no new files, no risen counts vs. the baseline",
		async (detector) => {
			const problems = auditAgainstBaseline(
				detector,
				await countsByDetector(detector),
			);
			expect(problems.map(describeProblem)).toEqual([]);
		},
		30_000,
	);

	// Whole-tree scan performs AST parsing and can exceed Vitest's default under
	// CI contention (run 34195211598, head 5c0aa5a4).
	it("the baseline names no file that has vanished from the live scan", async () => {
		// Stated asymmetrically on purpose (see module doc): a count FALLING is
		// not a failure above, but a baseline entry for a file the scan no
		// longer touches AT ALL is dead weight worth flagging here, same as
		// `auditRegistry`'s stale-exemption check one layer up.
		const stale: string[] = [];
		for (const detector of DETECTOR_NAMES) {
			const live = await countsByDetector(detector);
			for (const file of Object.keys(FLAKE_SHAPE_BASELINE[detector] ?? {})) {
				if (!(file in live)) stale.push(`${detector}:${file}`);
			}
		}
		expect(stale).toEqual([]);
	}, 30_000);

	it("carries the three counts in this header (informational, kept in sync)", () => {
		// Not asserted against a hardcoded number — this test's job is only to
		// prove the header comment above stays readable-and-current; the real
		// gate is the two tests above.
		for (const detector of DETECTOR_NAMES) {
			expect(FLAKE_SHAPE_BASELINE[detector]).toBeDefined();
		}
	});
});

describe("flake-shape ratchet — the compare function", () => {
	it("ATTACK: a fixture file that adds a raw setTimeout wait is a NEW flagged file — RED", () => {
		// The acceptance-criterion scenario, driven through the real detector:
		// a file the baseline has never seen, containing exactly the shape
		// detector 3 exists to catch.
		const fixtureSource = [
			'it("waits on a raw timer, never allowlisted", async () => {',
			"\tawait new Promise((resolve) => setTimeout(resolve, 30));",
			"});",
		].join("\n");
		const hits = scanRawTimerWait(
			"clients/never-baselined-fixture.test.ts",
			fixtureSource,
		);
		const live = { "clients/never-baselined-fixture.test.ts": hits.length };
		const problems = auditAgainstBaseline("raw-timer-wait", live);
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(
				"NEW flagged file clients/never-baselined-fixture.test.ts",
			),
		]);
	});

	it("ATTACK: a fixture file that adds an ungoverned vi.waitFor is a NEW flagged file — RED", () => {
		// Same acceptance-criterion shape as above, for detector 4: a real-timers
		// vi.waitFor in a file the baseline has never seen.
		const fixtureSource = [
			'it("polls until ready, never allowlisted", async () => {',
			"\tawait vi.waitFor(() => expect(client.isReady()).toBe(true));",
			"});",
		].join("\n");
		const hits = scanUngovernedWaitFor(
			"clients/never-baselined-waitfor-fixture.test.ts",
			fixtureSource,
		);
		const live = {
			"clients/never-baselined-waitfor-fixture.test.ts": hits.length,
		};
		const problems = auditAgainstBaseline("ungoverned-wait-for", live);
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(
				"NEW flagged file clients/never-baselined-waitfor-fixture.test.ts",
			),
		]);

		// GREEN under vi.useFakeTimers(): the same call, governed, produces no
		// hit at all, so nothing reaches the ratchet in the first place.
		const governedSource = [
			'it("polls under fake time", async () => {',
			"\tvi.useFakeTimers();",
			"\tconst p = vi.waitFor(() => expect(client.isReady()).toBe(true));",
			"\tawait vi.advanceTimersByTimeAsync(100);",
			"\tawait p;",
			"});",
		].join("\n");
		expect(
			scanUngovernedWaitFor(
				"clients/never-baselined-waitfor-fixture.test.ts",
				governedSource,
			),
		).toEqual([]);
	});

	it("does not flag a file already at its pinned count — GREEN on the allowlist", () => {
		const [firstFile, firstCount] = Object.entries(
			FLAKE_SHAPE_BASELINE["raw-timer-wait"],
		)[0];
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[firstFile]: firstCount,
		});
		expect(problems).toEqual([]);
	});

	it("flags a pinned file whose count rose", () => {
		const [firstFile, firstCount] = Object.entries(
			FLAKE_SHAPE_BASELINE["raw-timer-wait"],
		)[0];
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[firstFile]: firstCount + 1,
		});
		expect(problems).toHaveLength(1);
		expect(problems[0].kind).toBe("count-risen");
	});

	it("flags a pinned file whose count fell — a stale ceiling, not a free pass", () => {
		// Two-sided ratchet (reviewer probe): a fall is NOT silently accepted.
		// Left unpinned it is a stale ceiling that later re-admits regrowth
		// without ever tripping the count-risen check.
		const [firstFile, firstCount] = Object.entries(
			FLAKE_SHAPE_BASELINE["raw-timer-wait"],
		).find(([, count]) => count > 1)!;
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[firstFile]: firstCount - 1,
		});
		expect(problems).toHaveLength(1);
		expect(problems[0].kind).toBe("stale-ceiling");
		expect(describeProblem(problems[0])).toContain(
			`tighten the baseline to ${firstCount - 1}`,
		);
	});

	it("ATTACK (reviewer probe): pinned 5, live drops to 2, regrows to 4 — still flagged, never silently re-admitted", () => {
		// Drives the REAL auditAgainstBaseline via its injectable baseline
		// param, not a re-derived copy of its logic.
		const file = "clients/probe-fixture.test.ts";
		const pinned5: Baseline = {
			"real-process-spawn": {},
			"elapsed-time-assertion": {},
			"raw-timer-wait": { [file]: 5 },
			"ungoverned-wait-for": {},
			"never-settling-wait": {},
			"in-process-mock": {},
			"service-double": {},
		};

		// Drops to 2 (an improvement — but the ceiling is now stale at 5).
		const dropped = auditAgainstBaseline(
			"raw-timer-wait",
			{ [file]: 2 },
			pinned5,
		);
		expect(dropped).toHaveLength(1);
		expect(dropped[0].kind).toBe("stale-ceiling");

		// Regrows to 4 — still under the stale pin of 5, so the RISES check
		// alone (pre-fix) would say nothing; the two-sided check still flags
		// it because 4 < 5.
		const regrown = auditAgainstBaseline(
			"raw-timer-wait",
			{ [file]: 4 },
			pinned5,
		);
		expect(regrown).toHaveLength(1);
		expect(regrown[0].kind).toBe("stale-ceiling");
		expect(regrown[0].after).toBe(4);
	});
});

/**
 * Both admission-gate requirements for one `ADMITTED_AFTER_BASELINE` entry:
 * the file's own `// flake-shape: <detector> — <reason>` header, AND the
 * file's membership in `vitest.config.ts`'s `wallClockBudgetInclude`
 * project. Pulled out as its own function so it is unit-testable against
 * fixtures directly — the attack cases below keep this logic mutation-sensitive
 * even when the admission map is empty in a later steady state.
 */
function validateAdmission(
	key: string,
	entry: { detector: DetectorName; reason: string },
	source: string | undefined,
	serializedLaneIncluded: ReadonlySet<string>,
	relativeTestsPath: string,
): string[] {
	const problems: string[] = [];
	if (source === undefined) {
		return [`${key}: file does not exist`];
	}
	// #4362: the header for THIS detector, so a file admitted under a spawn
	// and a mock detector carries one header per detector.
	const header = admissionHeader(source, entry.detector);
	const otherHeader = header ? undefined : admissionHeader(source);
	if (otherHeader) {
		problems.push(
			`${key}: header names detector "${otherHeader.detector}", expected "${entry.detector}"`,
		);
	} else if (!header) {
		problems.push(
			`${key}: missing "// flake-shape: <detector> — <reason>" header`,
		);
	} else if (header.reason.length < 15) {
		problems.push(`${key}: header reason too short to be real`);
	}
	const laneProof =
		MOCK_DETECTORS.has(entry.detector) ||
		serializedLaneIncluded.has(`tests/${relativeTestsPath}`) ||
		(relativeTestsPath.startsWith("support/") &&
			supportHelperHasLaneProof(relativeTestsPath, serializedLaneIncluded));
	if (!laneProof) {
		problems.push(
			`${key}: not listed in vitest.config.ts wallClockBudgetInclude or real-harness lane`,
		);
	}
	if (entry.reason.trim().length < 15) {
		problems.push(`${key}: ADMITTED_AFTER_BASELINE reason too short`);
	}
	return problems;
}

// #3546: the import-graph walk `supportHelperHasLaneProof` drives (see its
// own comment above) is billed to this describe block's single 30s `it`
// budget even though it is a whole-tests-tree walk, not that test's own
// work. Pre-warm the shared cache here, under its own measured timeout,
// decoupled from the `it` below the same way `WALK_TIMEOUT_MS` decouples
// `countsByDetector`'s pre-warm from each `detector %s` case's 30s budget.
const SUPPORT_LANE_WALK_TIMEOUT_MS = 180_000;

describe("flake-shape ratchet — admission gate", () => {
	beforeAll(() => {
		for (const file of cachedAllTestFiles()) cachedLocalImportTargets(file);
	}, SUPPORT_LANE_WALK_TIMEOUT_MS);

	// #2857: the admission sweep reads every admitted file's source and timed
	// out at vitest's 5 s default under full-suite load; give it a real budget.
	it("ADMITTED_AFTER_BASELINE entries carry the header and wallClockBudgetInclude membership", () => {
		const included = new Set([
			...wallClockBudgetInclude(),
			...realHarnessInclude,
		]);
		const problems: string[] = [];
		for (const [key, entry] of Object.entries(ADMITTED_AFTER_BASELINE)) {
			const file = key
				.slice(entry.detector.length + 1)
				.split(IDENTITY_SEPARATOR)[0];
			if (file.startsWith("support/") && !file.endsWith(".test.ts")) continue;
			const absolute = path.join(repoRoot, "tests", file);
			const source = fs.existsSync(absolute)
				? fs.readFileSync(absolute, "utf8")
				: undefined;
			problems.push(...validateAdmission(key, entry, source, included, file));
		}
		for (const detector of DETECTOR_NAMES) {
			for (const file of Object.keys(FLAKE_SHAPE_BASELINE[detector] ?? {})) {
				if (!file.startsWith("support/") || file.endsWith(".test.ts")) continue;
				const key = `${detector}:${file}`;
				const entry = ADMITTED_AFTER_BASELINE[key];
				if (!entry) {
					problems.push(`${key}: missing ADMITTED_AFTER_BASELINE entry`);
					continue;
				}
				const source = fs.readFileSync(
					path.join(repoRoot, "tests", file),
					"utf8",
				);
				problems.push(...validateAdmission(key, entry, source, included, file));
			}
		}
		expect(problems).toEqual([]);
	}, 30_000);

	// #3546: the caching above is a behaviour-preserving refactor — every
	// value it returns must equal what the uncached production calls
	// (`allTestSourceFiles`, `localImportTargets`) return for the same
	// input. Old-vs-new probe through the real seam, not a re-derived copy
	// of the caching logic, per the behaviour-preserving-refactor proof
	// shape.
	it("(#3546) the cached file list and import targets equal the uncached scan", () => {
		const uncachedFiles = allTestSourceFiles().filter((file) =>
			file.endsWith(".test.ts"),
		);
		expect(cachedAllTestFiles()).toEqual(uncachedFiles);
		for (const file of uncachedFiles) {
			expect(cachedLocalImportTargets(file)).toEqual(localImportTargets(file));
		}
	});

	// #3546 MUTATION: the cache must be load-bearing, not dead code — poison
	// it and show `supportHelperHasLaneProof`'s answer for a REAL admitted
	// entry flips, then show it flips back once the cache is restored. This
	// is the guard's own red-on-neuter proof (docs/engineering-principles.md "Mutation output is quoted, not ticked").
	it("MUTATION (#3546): a poisoned import-targets cache flips supportHelperHasLaneProof's answer", () => {
		const included = new Set([
			...wallClockBudgetInclude(),
			...realHarnessInclude,
		]);
		expect(
			supportHelperHasLaneProof("support/fault-injection.ts", included),
		).toBe(true);

		const saved = new Map(importTargetsCache);
		for (const key of importTargetsCache.keys())
			importTargetsCache.set(key, []);
		try {
			expect(
				supportHelperHasLaneProof("support/fault-injection.ts", included),
			).toBe(false);
		} finally {
			importTargetsCache.clear();
			for (const [key, value] of saved) importTargetsCache.set(key, value);
		}
		expect(
			supportHelperHasLaneProof("support/fault-injection.ts", included),
		).toBe(true);
	});

	// #3546 planted offender: a target nothing imports must be flagged
	// (no lane proof) — same conclusion the uncached walk would reach, since
	// the equivalence test above proves the cache returns identical data.
	it("ATTACK (#3546): a support/ target no test imports has no lane proof — planted offender", () => {
		const included = new Set([
			...wallClockBudgetInclude(),
			...realHarnessInclude,
		]);
		expect(
			supportHelperHasLaneProof(
				"support/__3546-planted-offender-never-imported.ts",
				included,
			),
		).toBe(false);
	});

	// `ADMITTED_AFTER_BASELINE` is empty in steady state, so the test above
	// alone never proves `validateAdmission` catches anything. These fixtures
	// drive it directly, one requirement at a time.
	const GOOD_SOURCE =
		"// flake-shape: real-process-spawn — the real CLI's exit-code " +
		"contract is under test; a mock cannot reproduce it faithfully\n" +
		"execFileSync(cmd);\n";
	const GOOD_ENTRY = {
		detector: "real-process-spawn" as const,
		reason: "the real CLI's exit-code contract is under test",
	};
	const INCLUDED = new Set(["tests/clients/some-admitted-fixture.test.ts"]);

	it("ATTACK: passes when the header, detector match, and membership all hold", () => {
		expect(
			validateAdmission(
				"real-process-spawn:clients/some-admitted-fixture.test.ts",
				GOOD_ENTRY,
				GOOD_SOURCE,
				INCLUDED,
				"clients/some-admitted-fixture.test.ts",
			),
		).toEqual([]);
	});

	it("ATTACK: a missing header is caught", () => {
		const problems = validateAdmission(
			"real-process-spawn:clients/some-admitted-fixture.test.ts",
			GOOD_ENTRY,
			"execFileSync(cmd); // no header at all\n",
			INCLUDED,
			"clients/some-admitted-fixture.test.ts",
		);
		expect(problems).toEqual([expect.stringContaining("missing")]);
	});

	it("ATTACK: a header naming the WRONG detector is caught", () => {
		const wrongDetectorSource =
			"// flake-shape: raw-timer-wait — this reason talks about the wrong detector\n" +
			"execFileSync(cmd);\n";
		const problems = validateAdmission(
			"real-process-spawn:clients/some-admitted-fixture.test.ts",
			GOOD_ENTRY,
			wrongDetectorSource,
			INCLUDED,
			"clients/some-admitted-fixture.test.ts",
		);
		expect(problems).toEqual([
			expect.stringContaining('names detector "raw-timer-wait"'),
		]);
	});

	it("ATTACK: missing wallClockBudgetInclude membership is caught even with a good header", () => {
		const problems = validateAdmission(
			"real-process-spawn:clients/some-admitted-fixture.test.ts",
			GOOD_ENTRY,
			GOOD_SOURCE,
			new Set<string>(), // empty: file is not in the include list
			"clients/some-admitted-fixture.test.ts",
		);
		expect(problems).toEqual([
			expect.stringContaining("wallClockBudgetInclude"),
		]);
	});

	it("ATTACK: a nonexistent file is caught", () => {
		expect(
			validateAdmission(
				"real-process-spawn:clients/does-not-exist.test.ts",
				GOOD_ENTRY,
				undefined,
				INCLUDED,
				"clients/does-not-exist.test.ts",
			),
		).toEqual([expect.stringContaining("does not exist")]);
	});
});

describe("flake-shape ratchet — frozen mint (#4383 review F1)", () => {
	// Recurrence: a baseline row alone admitted a planted vi.mock or
	// execFileSync with no header and no ADMITTED entry. Rows below follow
	// the state table in PR #4383 ("F1 state table").
	const file = "clients/__4383-mint-fixture.test.ts";
	const mockKey = `${file}::clients/latency-logger`;
	const baselineWith = (
		detector: DetectorName,
		rows: Record<string, number>,
	): Baseline => {
		const baseline = Object.fromEntries(
			DETECTOR_NAMES.map((name) => [name, {}]),
		) as Baseline;
		baseline[detector] = rows;
		return baseline;
	};
	const mint = {
		mock: baselineWith("in-process-mock", { [mockKey]: 1 }),
		spawn: baselineWith("real-process-spawn", { [file]: 2 }),
	};
	const none = {};
	const admittedSpawn = {
		[`real-process-spawn:${file}`]: {
			detector: "real-process-spawn" as const,
			reason: "the real CLI exit code is under test",
		},
	};
	const admittedMock = {
		[`in-process-mock:${mockKey}`]: {
			detector: "in-process-mock" as const,
			reason: "the logger's own flush order is under test",
		},
	};

	it("passes the live baseline: every row past the mint is admitted, every admission has a row", () => {
		expect(auditAgainstMint()).toEqual([]);
	});

	it("keeps the mint at its pinned digest, whatever its formatting", () => {
		expect(frozenDigestProblems(FROZEN_BASELINE_SOURCE)).toEqual([]);
		// Row 15: reformatting or CRLF is not an edit; a new row is.
		expect(
			frozenDigestProblems(
				JSON.stringify(FROZEN_BASELINE, null, 2).replaceAll("\n", "\r\n"),
			),
		).toEqual([]);
		const grown = structuredClone(FROZEN_BASELINE);
		grown["in-process-mock"][mockKey] = 1;
		expect(frozenDigestProblems(JSON.stringify(grown))).toEqual([
			expect.stringContaining("write-once"),
		]);
	});

	it("rows 1-2: a minted row at or below its minted count needs no admission", () => {
		expect(auditAgainstMint(mint.spawn, mint.spawn, none)).toEqual([]);
		expect(
			auditAgainstMint(
				baselineWith("real-process-spawn", { [file]: 1 }),
				mint.spawn,
				none,
			),
		).toEqual([]);
	});

	it("rows 3-4: ATTACK a minted row raised above the mint without an ADMITTED entry is refused", () => {
		const raised = baselineWith("real-process-spawn", { [file]: 3 });
		expect(auditAgainstMint(raised, mint.spawn, none)).toEqual([
			expect.stringContaining(
				`real-process-spawn:${file}: baseline row 3 is past the frozen mint (minted 2)`,
			),
		]);
		// Row 6: the same raise with its admission passes here (the header and
		// lane are validateAdmission's half).
		expect(auditAgainstMint(raised, mint.spawn, admittedSpawn)).toEqual([]);
	});

	it("rows 9-10: ATTACK the reviewer's probes, a new row with no ADMITTED entry, are refused", () => {
		const empty = baselineWith("in-process-mock", {});
		// Probe A: a planted in-process vi.mock plus only its row.
		expect(auditAgainstMint(mint.mock, empty, none)).toEqual([
			expect.stringContaining(
				`in-process-mock:${mockKey}: baseline row 1 is past the frozen mint (absent)`,
			),
		]);
		// Probe B: a planted execFileSync plus only its spawn row.
		expect(
			auditAgainstMint(
				mint.spawn,
				baselineWith("real-process-spawn", {}),
				none,
			),
		).toEqual([
			expect.stringContaining(
				"(absent) and has no ADMITTED_AFTER_BASELINE entry",
			),
		]);
		// Row 12: admitted, the new row passes.
		expect(auditAgainstMint(mint.mock, empty, admittedMock)).toEqual([]);
	});

	it("row 14: ATTACK an ADMITTED entry with no baseline row is a stale admission", () => {
		expect(
			auditAgainstMint(
				baselineWith("in-process-mock", {}),
				mint.mock,
				admittedMock,
			),
		).toEqual([expect.stringContaining("stale admission")]);
	});
});

// ── The scan itself — fixtures, self-tests, mutation-proof ────────────────

describe("flake-shape scan — real-process-spawn", () => {
	it("ATTACK named spelling: child_process import + execFileSync + vitest-in-argv", () => {
		const source = [
			'import { execFileSync } from "node:child_process";',
			"",
			'it("runs the suite as a child", () => {',
			'\texecFileSync("npx", ["vitest", "run", "--reporter=json"]);',
			"});",
		].join("\n");
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual([
			"child_process import",
			"execFileSync( real sync spawn",
		]);
	});

	it("ATTACK novel spelling: require() + async spawn() with a vitest bin path in argv", () => {
		const source = [
			'const { spawn } = require("child_process");',
			"",
			'it("relaunches vitest asynchronously", () => {',
			'\tspawn(process.execPath, ["node_modules/.bin/vitest", "run"]);',
			"});",
		].join("\n");
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual([
			"child_process import",
			'spawn( vitest-in-vitest (argv mentions "vitest")',
		]);
	});

	it("does not flag an async spawn() whose argv never mentions vitest", () => {
		const source = [
			'import { spawn } from "node:child_process";',
			'it("spawns something unrelated", () => {',
			'\tspawn(process.execPath, ["git", "status"]);',
			"});",
		].join("\n");
		// The import line still counts (a real child_process import is itself
		// the shape); the plain spawn() call does not add a second hit because
		// it is neither the sync triad nor vitest-in-argv.
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual(["child_process import"]);
	});

	it("does not flag a comment that merely names the calls", () => {
		const source = [
			"// This test used to call execFileSync(cmd) directly.",
			'it("no longer spawns", () => {',
			"\texpect(1).toBe(1);",
			"});",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toEqual([]);
	});

	it("flags support spawn helpers called from a test, but not quoted names", () => {
		const source = [
			'const prose = "gitFixtureSpawnAsync(cwd, args)";',
			"// safeSpawnAsync(command, args) is intentionally only documentation.",
			'it("uses the fixture boundary", async () => {',
			"	await gitFixtureSpawnAsync(cwd, args);",
			"	await safeSpawnAsync(command, args);",
			"});",
		].join("\n");
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual([
			"gitFixtureSpawnAsync( support spawn helper",
			"safeSpawnAsync( support spawn helper",
		]);
	});

	it("flags the collectUntrackedIgnoredIds production seam, and its mocked-module escape", () => {
		const source = [
			'import { collectUntrackedIgnoredIds } from "../../clients/git-tracked-ignore.js";',
			'it("census", async () => {',
			"	await collectUntrackedIgnoredIds(root);",
			"});",
		].join("\n");
		expect(
			scanRealProcessSpawn("fixture.test.ts", source).map((h) => h.reason),
		).toEqual(["collectUntrackedIgnoredIds( support spawn helper"]);

		// Mocking the helper's own module closes the spawn, so the call is not
		// counted — the same escape the support helpers get (#4598).
		const mocked = [
			'import { collectUntrackedIgnoredIds } from "../../clients/git-tracked-ignore.js";',
			'vi.mock("../../clients/git-tracked-ignore.js");',
			"await collectUntrackedIgnoredIds(root);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", mocked)).toEqual([]);
	});

	it("flags installPathProbeStub as a support spawn helper, and its mocked-module escape (#4709)", () => {
		// Recurrence: the stub spawns nothing itself, so the files that use it
		// ran real `which` and stand-in package managers with no baseline row,
		// header or serialized lane (#4709 slice 3b).
		const source = [
			'const prose = "installPathProbeStub(root)";',
			"// installPathProbeStub(root) is only documentation here.",
			'it("looks up a planted binary", async () => {',
			"	const stub = installPathProbeStub(root);",
			"});",
		].join("\n");
		expect(
			scanRealProcessSpawn("fixture.test.ts", source).map((h) => h.reason),
		).toEqual(["installPathProbeStub( support spawn helper"]);

		const mocked = [
			'vi.mock("../support/path-probe-stub.js");',
			"const stub = installPathProbeStub(root);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", mocked)).toEqual([]);
	});

	it("does not count a helper whose module is mocked", () => {
		const source = [
			'import { safeSpawnAsync } from "../../clients/safe-spawn.js";',
			'vi.mock("../../clients/safe-spawn.js");',
			"await safeSpawnAsync(command, args);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toEqual([]);
	});

	it("does not let a string-only mock declaration suppress a real helper", () => {
		const source = [
			"const prose = 'vi.mock(\"../../clients/safe-spawn.js\")';",
			"await safeSpawnAsync(command, args);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toHaveLength(1);
	});

	it("does not let a commented mock declaration suppress a real helper", () => {
		const source = [
			'// vi.mock("../../clients/safe-spawn.js");',
			"await safeSpawnAsync(command, args);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toHaveLength(1);
	});

	it("does not count sync spawns behind a mocked child_process module", () => {
		const source = [
			'import { execFileSync } from "node:child_process";',
			'vi.mock("node:child_process");',
			'execFileSync(process.execPath, ["git", "status"]);',
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toEqual([]);
	});

	it("ATTACK (#5064): vi.importActual of child_process behind a same-file mock is a real spawn", () => {
		// Recurrence: the system32 seam fold's taskkill case started a real node
		// child through vi.importActual("node:child_process") beside a
		// vi.doMock of the same module, and the census counted nothing for it.
		const source = [
			'vi.doMock("node:child_process", () => ({ spawn: vi.fn() }));',
			'it("kills a real child", async () => {',
			'\tconst { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>(',
			'\t\t"node:child_process",',
			"\t);",
			'\trealSpawn(process.execPath, ["-e", "0"]);',
			"});",
		].join("\n");
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.line)).toEqual([3]);
		expect(hits[0]?.reason).toBe(
			"importActual( reaches the real child_process module",
		);
	});

	it("ATTACK (#5064): importActual with a non-literal specifier is read; a literal other module is not", () => {
		// A variable specifier is refused, not passed: the census cannot prove the
		// module is not child_process. A literal naming another module is proven.
		const variable = [
			'vi.mock("node:child_process");',
			'const name = "node:child_process";',
			"const cp = await vi.importActual(name);",
		].join("\n");
		expect(
			scanRealProcessSpawn("fixture.test.ts", variable).map((h) => h.line),
		).toEqual([3]);

		const otherModule = [
			'vi.mock("node:child_process");',
			'const os = await vi.importActual<typeof import("node:os")>("node:os");',
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", otherModule)).toEqual([]);
	});

	it("ATTACK (#5064 r3): importActual spelled as a literal prefix plus concatenation is read", () => {
		// Recurrence: PRRT_kwDORt8rec6yQNSu (Greptile) and PRRT_kwDORt8rec6yQOAE
		// (CodeRabbit). The reader took the first string literal as the whole
		// specifier, so "node:" in `"node:" + "child_process"` named another module.
		const source = [
			'vi.mock("node:child_process");',
			'const cp = await vi.importActual("node:" + "child_process");',
		].join("\n");
		expect(
			scanRealProcessSpawn("fixture.test.ts", source).map((h) => h.line),
		).toEqual([2]);
	});

	it("ATTACK (#5064 r3): importActual spelled by concatenation with the split inside the name is read", () => {
		// Recurrence: PRRT_kwDORt8rec6yQNSu and PRRT_kwDORt8rec6yQOAE. The reader
		// saw only the first literal, "node:child_", and passed it as another module.
		const source = [
			'vi.mock("node:child_process");',
			'const cp = await vi.importActual("node:child_" + "process");',
		].join("\n");
		expect(
			scanRealProcessSpawn("fixture.test.ts", source).map((h) => h.line),
		).toEqual([2]);
	});

	it("ATTACK (#5064 r3): importActual of a template literal with an interpolation is read", () => {
		// Recurrence: PRRT_kwDORt8rec6yQOAE's template case. The reader matched the
		// template text "node:${n}" as the specifier, so an interpolated module name
		// named no child_process and the real child was not counted.
		const source = [
			'vi.mock("node:child_process");',
			'const n = "child_process";',
			"const cp = await vi.importActual(`node:${n}`);",
		].join("\n");
		expect(
			scanRealProcessSpawn("fixture.test.ts", source).map((h) => h.line),
		).toEqual([3]);
	});

	it("ATTACK (#5064 r3): importActual of an escaped literal is read", () => {
		// Recurrence: an escape spells the module name without the literal text
		// child_process. The reader cannot prove it is another module, so it reads
		// the call (fail closed on an unplanned spelling).
		const source = [
			'vi.mock("node:child_process");',
			'const cp = await vi.importActual("node:child\\u005fprocess");',
		].join("\n");
		expect(
			scanRealProcessSpawn("fixture.test.ts", source).map((h) => h.line),
		).toEqual([2]);
	});

	it("does not read a zero-argument importActual() of another module beside a child_process mock (#5064)", () => {
		// Recurrence: tests/clients/lsp/windows-startup-repair.test.ts calls
		// importActual<...>() with no argument inside a package-manager mock factory
		// in a file that also mocks child_process; that is the mocked module's own
		// original, not a child_process reach.
		const source = [
			'vi.mock("node:child_process", () => ({ spawn: vi.fn() }));',
			'vi.doMock("../../../clients/package-manager.js", async (importActual) => ({',
			'\t...(await importActual<typeof import("../../../clients/package-manager.js")>()),',
			"}));",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toEqual([]);
	});

	it("does not read a child_process string passed to an ordinary call (#5064 over-read)", () => {
		// Recurrence: the first draft of the #5064 read flagged any call whose first
		// argument was the child_process specifier, which fired on
		// JSON.stringify("node:child_process") and includes("child_process") in
		// runner-spawn-cwd-sweep and spawn-chokepoint-sweep. Only importActual reads
		// the real module.
		const source = [
			'vi.mock("node:child_process");',
			'const literal = JSON.stringify("node:child_process");',
			'if (text.includes("child_process")) run(literal);',
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toEqual([]);
	});

	it("keeps helper calls when an unrelated module is mocked", () => {
		const source = [
			'vi.mock("../../clients/unrelated.js");',
			"await safeSpawnAsync(command, args);",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toHaveLength(1);
	});
});

describe("flake-shape scan — elapsed-time-assertion", () => {
	it("ATTACK named spelling: Date.now() delta via a variable, toBeLessThan", () => {
		const source = [
			'it("finishes fast", () => {',
			"\tconst start = Date.now();",
			"\tdoWork();",
			"\tconst elapsed = Date.now() - start;",
			"\texpect(elapsed).toBeLessThan(500);",
			"});",
		].join("\n");
		const hits = scanElapsedTimeAssertion("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(5);
	});

	it("ATTACK novel spelling: inline performance.now() delta, toBeGreaterThanOrEqual", () => {
		const source = [
			'it("takes at least this long", () => {',
			"\tconst t0 = performance.now();",
			"\tdoSlowWork();",
			"\texpect(performance.now() - t0).toBeGreaterThanOrEqual(10);",
			"});",
		].join("\n");
		const hits = scanElapsedTimeAssertion("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(4);
	});

	it("SEMANTIC not token: a clock read and a numeric matcher in the same file, unrelated, does not fire", () => {
		// shape 34: token co-occurrence of Date.now() and toBeLessThan must NOT
		// be enough — only an actual delta flowing into the matcher counts.
		const source = [
			'it("reads the clock for a log line, asserts something unrelated", () => {',
			"\tconst start = Date.now();",
			'\tlogEvent("start", start);',
			"\texpect(result.items.length).toBeLessThan(5);",
			"});",
		].join("\n");
		expect(scanElapsedTimeAssertion("fixture.test.ts", source)).toEqual([]);
	});

	it("does not flag a non-clock subtraction feeding a numeric matcher", () => {
		const source = [
			'it("checks a count", () => {',
			"\tconst remaining = total - consumed;",
			"\texpect(remaining).toBeLessThan(10);",
			"});",
		].join("\n");
		expect(scanElapsedTimeAssertion("fixture.test.ts", source)).toEqual([]);
	});
});

describe("flake-shape scan — raw-timer-wait", () => {
	// #4397 (recurrence #3514, #4385): the two (#2563) cases below read the
	// whole-tree scan. Only the `flake-shape ratchet (#2547)` describe warmed it,
	// so run first (a shuffle, or `-t`) they billed the ~12 s cold scan to the 5 s
	// default. This describe pays it once, under the walk's own budget.
	beforeAll(async () => {
		await countsByDetector("raw-timer-wait");
		await countsByDetector("real-process-spawn");
	}, WALK_TIMEOUT_MS);

	it("ATTACK named spelling: raw setTimeout wait via a Promise", () => {
		const source = [
			'it("waits a bit", async () => {',
			"\tawait new Promise((resolve) => setTimeout(resolve, 50));",
			"\texpect(state.ready).toBe(true);",
			"});",
		].join("\n");
		const hits = scanRawTimerWait("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("setTimeout");
	});

	it("ATTACK novel spelling: raw setInterval poll", () => {
		const source = [
			'it("polls until ready", () => {',
			"\tconst id = setInterval(() => checkReady(), 25);",
			"\treturn stopWhenReady(id);",
			"});",
		].join("\n");
		const hits = scanRawTimerWait("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("setInterval");
	});

	it("does not flag a raw wait governed by vi.useFakeTimers()", () => {
		const source = [
			'it("advances fake time", () => {',
			"\tvi.useFakeTimers();",
			"\tconst p = new Promise((resolve) => setTimeout(resolve, 1000));",
			"\tvi.advanceTimersByTime(1000);",
			"\tvi.useRealTimers();",
			"\treturn p;",
			"});",
		].join("\n");
		expect(scanRawTimerWait("fixture.test.ts", source)).toEqual([]);
	});

	it("flags a raw wait AFTER vi.useRealTimers() restores real timers", () => {
		const source = [
			'it("goes back to real timers, then waits raw", async () => {',
			"\tvi.useFakeTimers();",
			"\tvi.advanceTimersByTime(0);",
			"\tvi.useRealTimers();",
			"\tawait new Promise((resolve) => setTimeout(resolve, 20));",
			"});",
		].join("\n");
		const hits = scanRawTimerWait("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(5);
	});

	it("exempts interleaving-kit.ts by name", () => {
		const source =
			"export function realWait(ms) {\n\treturn new Promise((r) => setTimeout(r, ms));\n}\n";
		expect(scanRawTimerWait("interleaving-kit.ts", source)).toEqual([]);
	});

	it("(#2563) the live scan walks tests/support helpers: fault-injection.ts sits in the population", async () => {
		// Mutation-sensitive population proof: dropping the support walk from
		// countsByDetector makes this red. fault-injection.ts is the one
		// existing helper the extended scan flags (its sanctioned delayInside
		// timer + teardown failsafe are baselined, not admitted).
		expect(await countsByDetector("raw-timer-wait")).toHaveProperty(
			"support/fault-injection.ts",
		);
	});

	it("(#2563) the spawn detector stays test-file-only: support helpers are the sanctioned spawn boundary", async () => {
		// git-fixture-env.ts / fake-child.ts / spawn-shapes.ts import
		// node:child_process by design — they are the fixture boundary the
		// test-side detector routes callers toward, not a flake shape.
		const spawnCounts = await countsByDetector("real-process-spawn");
		expect(spawnCounts["support/git-fixture-env.ts"]).toBeUndefined();
		expect(spawnCounts["support/fake-child.ts"]).toBeUndefined();
	});

	it("ATTACK (#2563): a raw timer inside a tests/support helper is a NEW flagged file", () => {
		// The acceptance-criterion scenario for the new population: a helper
		// file the baseline has never seen, containing exactly the shape
		// detector 3 exists to catch.
		const fixtureSource = [
			"export function tick(ms: number): void {",
			"\tsetTimeout(() => {}, ms);",
			"}",
		].join("\n");
		const file = "support/_fixture-raw-timer.ts";
		const hits = scanRawTimerWait(file, fixtureSource);
		expect(hits).toHaveLength(1);
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[file]: hits.length,
		});
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(`NEW flagged file ${file}`),
		]);
	});

	it("ATTACK (#2563): a delay clone DEFINED in a tests/support helper is flagged even when its timer is hidden", () => {
		// The evasion the issue names: the clone's timer text is never
		// `setTimeout(` (aliased import), so only the definition shape sees
		// it — the raw-timer call regex alone would pass the clone silently.
		const fixtureSource = [
			'import { setTimeout as sleep } from "node:timers";',
			"",
			"export const delay = (ms: number) =>",
			"\tnew Promise<void>((resolve) => sleep(resolve, ms));",
		].join("\n");
		const file = "support/_fixture-hidden-timer-delay.ts";
		const hits = scanRawTimerWait(file, fixtureSource);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("delay/sleep helper definition");
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[file]: hits.length,
		});
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(`NEW flagged file ${file}`),
		]);
	});

	it.each([
		[
			"local alias",
			"export function pause(ms: number) { const t = setTimeout; t(() => {}, ms); }",
		],
		[
			"destructured globalThis alias",
			"const { setTimeout: t } = globalThis; export function pause(ms: number) { t(() => {}, ms); }",
		],
		[
			"destructured globalThis shorthand",
			"const { setTimeout } = globalThis; export function pause(ms: number) { setTimeout(() => {}, ms); }",
		],
		[
			"named timers/promises import",
			'import { setTimeout as timer } from "node:timers/promises"; export function pause(ms: number) { return timer(ms); }',
		],
		[
			"namespace timers/promises import",
			'import * as timers from "timers/promises"; export function pause(ms: number) { return timers.setTimeout(ms); }',
		],
	])("flags a %s timer alias", (_name, source) => {
		// #2563 recurrence: a pause/tick helper must not hide a real timer
		// behind a binding that evades both the delay-name and raw-call passes.
		expect(
			scanRawTimerWait("support/_fixture-aliased-timer.ts", source),
		).toHaveLength(1);
	});

	it("does not treat a destructured non-timer object as a timer alias", () => {
		const source =
			"const { setTimeout: t } = unrelated; export function pause(ms: number) { t(() => {}, ms); }";
		expect(
			scanRawTimerWait("support/_fixture-aliased-timer.ts", source),
		).toEqual([]);
	});

	it("(#2563) the delay/sleep definition shape is support-scoped: a non-support file is not flagged for it", () => {
		// In a .test.ts file the shape is redundant (the timer call itself is
		// already governed), so the definition check must not widen the
		// population there.
		const fixtureSource =
			"export const delay = (ms: number) =>\n" +
			"\tnew Promise<void>((resolve) => sleep(resolve, ms));\n";
		expect(
			scanRawTimerWait("clients/uses-delay.test.ts", fixtureSource),
		).toEqual([]);
	});
});

describe("flake-shape scan — ungoverned-wait-for", () => {
	it("ATTACK: a real-timers vi.waitFor is flagged", () => {
		const source = [
			'it("eventually settles", async () => {',
			"\tawait vi.waitFor(() => expect(client.isReady()).toBe(true));",
			"});",
		].join("\n");
		const hits = scanUngovernedWaitFor("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("vi.waitFor");
	});

	it("does not flag a vi.waitFor governed by vi.useFakeTimers()", () => {
		const source = [
			'it("advances fake time to settle", async () => {',
			"\tvi.useFakeTimers();",
			"\tconst p = vi.waitFor(() => expect(ready).toBe(true));",
			"\tawait vi.advanceTimersByTimeAsync(100);",
			"\tawait p;",
			"\tvi.useRealTimers();",
			"});",
		].join("\n");
		expect(scanUngovernedWaitFor("fixture.test.ts", source)).toEqual([]);
	});

	it("flags a vi.waitFor AFTER vi.useRealTimers() restores real timers", () => {
		const source = [
			'it("goes back to real timers, then waits ungoverned", async () => {',
			"\tvi.useFakeTimers();",
			"\tvi.advanceTimersByTime(0);",
			"\tvi.useRealTimers();",
			"\tawait vi.waitFor(() => expect(ready).toBe(true));",
			"});",
		].join("\n");
		const hits = scanUngovernedWaitFor("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(5);
	});

	it("does not flag a comment that merely names vi.waitFor", () => {
		const source = [
			"// This test used to call vi.waitFor(cond) directly.",
			'it("no longer polls", () => {',
			"\texpect(1).toBe(1);",
			"});",
		].join("\n");
		expect(scanUngovernedWaitFor("fixture.test.ts", source)).toEqual([]);
	});
});

describe("flake-shape scan — mutation-proof self-test", () => {
	it("has exactly the declared detectors, each catching its own canonical fixture", () => {
		const canonicalFixtures: Record<DetectorName, string> = {
			"real-process-spawn": 'execFileSync("npx", ["vitest", "run"]);\n',
			"elapsed-time-assertion":
				"const start = Date.now();\nexpect(Date.now() - start).toBeLessThan(1);\n",
			"raw-timer-wait": "setTimeout(() => {}, 10);\n",
			"ungoverned-wait-for":
				"await vi.waitFor(() => expect(ready).toBe(true));\n",
			"never-settling-wait":
				"await expect(run(() => new Promise(() => {}))).rejects.toThrow();\n",
			"in-process-mock": 'vi.mock("../clients/latency-logger.js");\n',
			"service-double":
				"const service = { touchFile: vi.fn(), hasLSP: vi.fn(), getStatus: vi.fn() };\n",
		};
		expect(Object.keys(canonicalFixtures).sort()).toEqual(
			[...DETECTOR_NAMES].sort(),
		);
		for (const name of DETECTOR_NAMES) {
			const detector = DETECTORS[name];
			expect(detector, `detector "${name}" must exist in DETECTORS`).toBeTypeOf(
				"function",
			);
			const hits = detector("fixture.test.ts", canonicalFixtures[name]);
			expect(
				hits.length,
				`detector "${name}" must flag its own canonical fixture`,
			).toBeGreaterThan(0);
		}
	});
});

describe("flake-shape scan — never-settling-wait (#2885)", () => {
	const hitsIn = (body: string) =>
		scanNeverSettlingWait(
			"fixture.test.ts",
			`it("x", async () => {\n${body}\n});\n`,
		);

	it.each([
		["an empty arrow executor", "await run(() => new Promise(() => {}));"],
		[
			"a typed executor with an unused param",
			"await run(() => new Promise<never>((_resolve) => {}));",
		],
		[
			"a comment-only executor body",
			"await run(() => new Promise<void>(() => {\n// never resolves\n}));",
		],
		["a function executor", "await run(() => new Promise(function () {}));"],
		[
			"an undefined expression body",
			"await run(() => new Promise(() => undefined));",
		],
	])("ATTACK: flags %s", (_name, body) => {
		expect(hitsIn(body)).toHaveLength(1);
	});

	it("does not flag an executor that can settle", () => {
		expect(
			hitsIn("await new Promise<void>((resolve) => queueMicrotask(resolve));"),
		).toEqual([]);
	});

	it("does not flag a never-settling promise under fake timers", () => {
		expect(
			hitsIn(
				"vi.useFakeTimers();\nconst p = run(() => new Promise(() => {}));\nawait vi.advanceTimersByTimeAsync(5000);",
			),
		).toEqual([]);
	});

	it("does not flag the shape named in a comment or a string", () => {
		expect(
			hitsIn(
				'// new Promise(() => {}) would hang\nconst s = "new Promise(() => {})";',
			),
		).toEqual([]);
	});
});

describe("flake-shape scan — admission header parsing", () => {
	it("parses a well-formed header", () => {
		const source =
			"// flake-shape: real-process-spawn — the real npm CLI's exit-code " +
			"contract is the thing under test; a mock cannot reproduce it\n" +
			"execFileSync(cmd);\n";
		const header = admissionHeader(source);
		expect(header?.detector).toBe("real-process-spawn");
		expect(header?.reason).toContain("exit-code");
	});

	it("returns undefined with no header", () => {
		expect(admissionHeader("execFileSync(cmd);\n")).toBeUndefined();
	});

	it("(#4362) finds the header for the asked detector when a file carries two", () => {
		// Recurrence: a mock admission in a file that already admits a spawn.
		// Read by first header only, the spawn header would answer for the
		// mock detector and the admission could never validate.
		const source =
			"// flake-shape: real-process-spawn — the real CLI exit code is under test\n" +
			"// flake-shape: in-process-mock — the module's own timer is the subject\n";
		expect(admissionHeader(source)?.detector).toBe("real-process-spawn");
		expect(admissionHeader(source, "in-process-mock")).toEqual({
			detector: "in-process-mock",
			reason: "the module's own timer is the subject",
		});
		expect(admissionHeader(source, "service-double")).toBeUndefined();
	});

	it("does not count a header-shaped string literal", () => {
		expect(
			admissionHeader('"// flake-shape: real-process-spawn — quoted";\n'),
		).toBeUndefined();
		expect(
			admissionHeader(
				"const prose = `\n// flake-shape: real-process-spawn — quoted`\n",
			),
		).toBeUndefined();
		expect(
			admissionHeader(
				"// flake-shape: real-process-spawn — a real comment reason\n",
			)?.detector,
		).toBe("real-process-spawn");
	});
});

// ── In-process mocks and service doubles (#4362) ─────────────────────────
//
// Recurrence: #4344 round 3 (G5). One method added to `LSPClientInfo` and
// `LSPService` had to be added by hand to doubles in 40 test files (34
// client, 6 service), because nothing stopped in-process doubles from
// multiplying. Every test below guards one way that population could grow
// again without an admission.

/** `tests/`-relative fixture name no baseline row will ever name. */
const MOCK_FIXTURE = "clients/__4362-never-baselined.test.ts";

function liveCounts(
	file: string,
	hits: ReturnType<typeof scanInProcessMock>,
): Record<string, number> {
	const live: Record<string, number> = {};
	for (const hit of hits) {
		const key = hitKey(file, hit);
		live[key] = (live[key] ?? 0) + 1;
	}
	return live;
}

describe("flake-shape ratchet — in-process mocks and doubles (#4362)", () => {
	it("ATTACK: a planted in-process vi.mock is a NEW flagged entry — RED", () => {
		// The acceptance scenario through the real detector and the real
		// baseline: an in-process module mocked in a file no row names.
		const source = 'vi.mock("../../clients/latency-logger.js");\n';
		const problems = auditAgainstBaseline(
			"in-process-mock",
			liveCounts(MOCK_FIXTURE, scanInProcessMock(MOCK_FIXTURE, source)),
		);
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(
				`NEW flagged file ${MOCK_FIXTURE}::clients/latency-logger`,
			),
		]);
		expect(describeProblem(problems[0])).toContain("PROCESS_BOUNDARY_MODULES");
	});

	it("a process-boundary vi.mock passes — GREEN", () => {
		// The other half of the acceptance: the same file mocking only
		// boundaries produces no entry, so nothing reaches the baseline.
		const source = [
			'vi.mock("node:child_process", () => ({ spawn: vi.fn() }));',
			'vi.mock("../../clients/safe-spawn.js");',
			'vi.doMock("node:fs/promises");',
		].join("\n");
		const hits = scanInProcessMock(MOCK_FIXTURE, source);
		expect(hits).toEqual([]);
		expect(
			auditAgainstBaseline("in-process-mock", liveCounts(MOCK_FIXTURE, hits)),
		).toEqual([]);
	});

	it("ATTACK: swapping one mocked module for another in a pinned file is a NEW entry", () => {
		// Shape 36 (count-based laundering): a file pinned at one mocked
		// module that trades it for another keeps its count. The key carries
		// the module, so the trade is a new entry, not a free pass.
		const [pinnedKey] = Object.keys(FLAKE_SHAPE_BASELINE["in-process-mock"]);
		const [file, target] = pinnedKey.split(IDENTITY_SEPARATOR);
		const swapped = `${file}${IDENTITY_SEPARATOR}clients/__4362-swapped`;
		expect(target).not.toBe("clients/__4362-swapped");
		const problems = auditAgainstBaseline("in-process-mock", { [swapped]: 1 });
		expect(problems).toEqual([
			expect.objectContaining({ file: swapped, kind: "new-file" }),
		]);
	});

	it("ATTACK: a pinned file whose hand-rolled double count rose is flagged", () => {
		const [key, count] = Object.entries(
			FLAKE_SHAPE_BASELINE["service-double"],
		)[0];
		const problems = auditAgainstBaseline("service-double", {
			[key]: count + 1,
		});
		expect(problems).toEqual([
			expect.objectContaining({ kind: "count-risen", before: count }),
		]);
	});

	it("keys every mock and double baseline row as <file>::<identity>", () => {
		// A row without the identity would pin a bare count again and let a
		// swap through (the test above). Floors: the population minted with
		// 1,002 mocked modules and 151 doubles; a scan that matched nothing
		// would read as clean.
		for (const detector of MOCK_DETECTORS) {
			const keys = Object.keys(FLAKE_SHAPE_BASELINE[detector]);
			expect(keys.length).toBeGreaterThan(50);
			expect(
				keys.filter((key) => key.split(IDENTITY_SEPARATOR).length !== 2),
			).toEqual([]);
		}
	});

	it("ATTACK: a mock admission needs its header but no serialized lane", () => {
		const key = `in-process-mock:${MOCK_FIXTURE}::clients/latency-logger`;
		const entry = {
			detector: "in-process-mock" as const,
			reason: "the logger's own flush order is the behaviour under test",
		};
		const header =
			"// flake-shape: in-process-mock — the logger's own flush order is under test\n";
		const body = 'vi.mock("../../clients/latency-logger.js");\n';
		// Good header, no lane: admitted (a mock adds no contention).
		expect(
			validateAdmission(key, entry, header + body, new Set(), MOCK_FIXTURE),
		).toEqual([]);
		// No header: refused.
		expect(
			validateAdmission(key, entry, body, new Set(), MOCK_FIXTURE),
		).toEqual([expect.stringContaining("missing")]);
		// A header quoted in a comment of prose, or in a string, is no header.
		expect(
			validateAdmission(
				key,
				entry,
				`const s = "${header.trim()}";\n${body}`,
				new Set(),
				MOCK_FIXTURE,
			),
		).toEqual([expect.stringContaining("missing")]);
		// A spawn header first and the mock header second: both validate.
		const twoHeaders =
			"// flake-shape: real-process-spawn — the real CLI exit code is under test\n" +
			header +
			body;
		expect(
			validateAdmission(key, entry, twoHeaders, new Set(), MOCK_FIXTURE),
		).toEqual([]);
		// Only the spawn header: the mock entry names the wrong detector.
		expect(
			validateAdmission(
				key,
				entry,
				"// flake-shape: real-process-spawn — the real CLI exit code is under test\n" +
					body,
				new Set(),
				MOCK_FIXTURE,
			),
		).toEqual([expect.stringContaining('names detector "real-process-spawn"')]);
	});
});

describe("flake-shape scan — in-process-mock (#4362)", () => {
	const targetsIn = (source: string, file = MOCK_FIXTURE) =>
		scanInProcessMock(file, source).map((hit) => hit.identity);

	it("keys a relative specifier by its repo path, whatever the test file's depth", () => {
		expect(targetsIn('vi.mock("../clients/x.js");\n', "top.test.ts")).toEqual([
			"clients/x",
		]);
		expect(
			targetsIn('vi.mock("../../../clients/x.js");\n', "clients/lsp/a.test.ts"),
		).toEqual(["clients/x"]);
		// Shape 34: the script extension is spelling, not identity. (The
		// fixture module sits under tests/ so module-instance-coverage, which
		// reads specifiers inside strings, sees no compiled-module .ts import.)
		expect(
			targetsIn(
				'vi.mock("../x.ts");\nvi.doMock("../x");\nvi.doMock("../x.js");\n',
			),
		).toEqual(["tests/x"]);
		expect(mockTarget("clients/a.test.ts", "fs")).toBe("node:fs");
		expect(mockTarget("clients/a.test.ts", "node:path")).toBe("node:path");
		expect(mockTarget("clients/a.test.ts", "@scope/pkg/sub")).toBe(
			"@scope/pkg/sub",
		);
	});

	it.each([
		["vi.mock", 'vi.mock("../../clients/x.js", () => ({}));'],
		["vi.doMock", 'vi.doMock("../../clients/x.js");'],
		["bracket access", 'vi["mock"]("../../clients/x.js");'],
		["spaced member access", 'vi . mock("../../clients/x.js");'],
		["a template literal", "vi.mock(`../../clients/x.js`);"],
		["vitest's typed import() form", 'vi.mock(import("../../clients/x.js"));'],
	])("ATTACK spelling: flags %s", (_name, source) => {
		// Shape 34: the call is read structurally, so an unlisted spelling
		// of the same mock is the same entry.
		expect(targetsIn(source)).toEqual(["clients/x"]);
	});

	it("counts each mocked module once, however many times it is mocked", () => {
		const source = [
			'vi.mock("../../clients/x.js");',
			'it("a", () => { vi.doMock("../../clients/x.js"); });',
			'it("b", () => { vi.doMock("../../clients/y.js"); });',
		].join("\n");
		expect(targetsIn(source)).toEqual(["clients/x", "clients/y"]);
		// The entry points at the module's first mock, where a reader starts.
		expect(scanInProcessMock(MOCK_FIXTURE, source)[0].line).toBe(1);
	});

	it("counts a specifier it cannot read as in-process (fails closed)", () => {
		expect(targetsIn("const m = '../../clients/x.js';\nvi.mock(m);\n")).toEqual(
			[NON_LITERAL_MOCK_TARGET],
		);
		expect(targetsIn("vi.mock(`../../clients/${name}.js`);\n")).toEqual([
			NON_LITERAL_MOCK_TARGET,
		]);
	});

	it("never counts or excuses vi.mock( quoted in a comment or a string", () => {
		// Detector rule (AGENTS.md "Test requirements"): prose is not code.
		const prose = [
			'// vi.mock("../../clients/x.js")',
			'/* vi.doMock("../../clients/y.js") */',
			"const s = 'vi.mock(\"../../clients/z.js\")';",
			'const t = `vi.mock("../../clients/w.js")`;',
		].join("\n");
		expect(targetsIn(prose)).toEqual([]);
		// A comment naming a boundary module does not excuse a real call.
		expect(
			targetsIn(
				'// vi.mock("node:child_process") — only a boundary here\nvi.mock("../../clients/x.js");\n',
			),
		).toEqual(["clients/x"]);
	});

	it("does not read vi.fn, vi.spyOn or vi.hoisted as a module mock", () => {
		expect(
			targetsIn(
				'const f = vi.fn();\nvi.spyOn(obj, "m");\nconst h = vi.hoisted(() => ({}));\n',
			),
		).toEqual([]);
	});

	it("admits every PROCESS_BOUNDARY_MODULES entry, each with a real reason", () => {
		// Shape 38: each allowlisted boundary is crossed by a fixture, and
		// the list stays sorted and reasoned.
		assertSortedRegistry(
			"PROCESS_BOUNDARY_MODULES",
			Object.keys(PROCESS_BOUNDARY_MODULES),
		);
		for (const [target, reason] of Object.entries(PROCESS_BOUNDARY_MODULES)) {
			expect(reason.trim().length, target).toBeGreaterThanOrEqual(15);
			const specifier = target.startsWith("clients/")
				? `../../${target}`
				: target;
			expect(
				scanInProcessMock(MOCK_FIXTURE, `vi.mock("${specifier}");\n`),
				target,
			).toEqual([]);
		}
		// A bare builtin is the same boundary as its node: spelling.
		expect(targetsIn('vi.mock("child_process");\n')).toEqual([]);
		// An in-process builtin is not a boundary.
		expect(targetsIn('vi.mock("node:path");\n')).toEqual(["node:path"]);
	});
});

describe("flake-shape scan — service-double (#4362)", () => {
	const doubles = (source: string) =>
		scanServiceDouble(MOCK_FIXTURE, source).map((hit) => hit.identity);

	it("reads each surface's members from the production declaration", () => {
		const service = surfaceMembers(
			SERVICE_SURFACES.find((s) => s.name === "LSPService")!,
		);
		const client = surfaceMembers(
			SERVICE_SURFACES.find((s) => s.name === "LSPClientInfo")!,
		);
		// The G5 methods, one per surface.
		expect(service.has("announceCreatedFiles")).toBe(true);
		expect(client.has("notify")).toBe(true);
		// Declared after the first inline type import in the class body; the
		// raw grammar closed the class early and dropped both.
		expect(service.has("hasLSP")).toBe(true);
		expect(service.has("getStatus")).toBe(true);
		// Not the public surface: constructor and private methods.
		expect(service.has("constructor")).toBe(false);
		expect(service.has("noteAuxiliaryWait")).toBe(false);
		expect(() =>
			surfaceMembers({
				name: "NoSuchService",
				file: "clients/lsp/index.ts",
				factories: [],
			}),
		).toThrow("is not declared");
	});

	it("reads past an inline type import, and refuses a declaration that does not parse", () => {
		// Recurrence: tree-sitter misparses `import("…").T` in a type and
		// closed `LSPService` 2,300 lines early, silently shrinking its
		// vocabulary. A partial member list must red, never pass.
		const withTypeImport = [
			"class S {",
			'\ta(): Promise<import("./c.js").T[]> { return f(); }',
			"\tb(): void {}",
			"}",
		].join("\n");
		expect([...declaredMembers(withTypeImport, "S", "fixture.ts")]).toEqual([
			"a",
			"b",
		]);
		expect(() =>
			declaredMembers(
				"class S {\n\ta() { return ) }\n\tb() {}\n}\n",
				"S",
				"fixture.ts",
			),
		).toThrow("does not parse cleanly");
	});

	it("ATTACK: flags the G5 client double in every key spelling", () => {
		const source = [
			"createLSPClient.mockResolvedValue({",
			"\tisAlive: () => true,",
			'\t"getDiagnostics": vi.fn(() => []),',
			"\tshutdown() {},",
			"\tnotify: { open: vi.fn() },",
			"});",
		].join("\n");
		expect(doubles(source)).toEqual(["LSPClientInfo"]);
	});

	it("ATTACK: flags a hand-rolled service double handed over by injection", () => {
		const source = [
			"function makeService() {",
			"\treturn {",
			"\t\tannounceCreatedFiles: vi.fn(),",
			"\t\ttouchFile: vi.fn(async () => ({ diags: [] })),",
			"\t\tgetCapabilitySnapshots: vi.fn(async () => []),",
			"\t};",
			"}",
		].join("\n");
		expect(doubles(source)).toEqual(["LSPService"]);
	});

	it("does not flag objects seeded from the shared factory", () => {
		const source = [
			"makeLspServiceDouble({ touchFile: vi.fn(), hasLSP: vi.fn(), getDiagnostics: vi.fn() });",
			"const s = { ...makeLspServiceDouble(), touchFile: vi.fn(), hasLSP: vi.fn(), getStatus: vi.fn() };",
			// #4709: the seam hands this argument to the factory, so it is seeded.
			"await installLspServiceDouble({ touchFile: vi.fn(), hasLSP: vi.fn(), getDiagnostics: vi.fn() });",
		].join("\n");
		expect(doubles(source)).toEqual([]);
	});

	it("ATTACK: counts a spread of the async installer's Promise as a hand-rolled double", () => {
		// Recurrence (#4720 review F3, Greptile P2): `installLspServiceDouble`
		// is async, so `{ ...installLspServiceDouble(), … }` spreads a Promise and
		// seeds nothing. Registering it as an argument-only seed is what refuses
		// this spelling; before that fix the same spread produced 0 hits.
		const source = [
			"const a = { ...installLspServiceDouble(), touchFile: vi.fn(), hasLSP: vi.fn(), getStatus: vi.fn() };",
			// A cast around the same callee resolves to the registered name and is
			// still refused, because the result is a Promise whichever way it is
			// spelled.
			"const b = { ...(installLspServiceDouble as any)(), touchFile: vi.fn(), hasLSP: vi.fn(), getStatus: vi.fn() };",
		].join("\n");
		expect(doubles(source)).toEqual(["LSPService", "LSPService"]);
	});

	it("ATTACK: counts a seed reached through an alias, or through another binding", () => {
		// The safe direction for a ratchet: a callee that is not a bare
		// registered identifier, or a spread operand that is not a call, keeps
		// the object counted.
		const source = [
			"const alias = installLspServiceDouble;",
			"const a = { ...alias(), touchFile: vi.fn(), hasLSP: vi.fn(), getStatus: vi.fn() };",
			"const d = await installLspServiceDouble();",
			"const b = { ...d, touchFile: vi.fn(), hasLSP: vi.fn(), getStatus: vi.fn() };",
		].join("\n");
		expect(doubles(source)).toEqual(["LSPService", "LSPService"]);
	});

	it("does not flag a data record that reuses the names", () => {
		// A capability shape asserted with toMatchObject is not called by the
		// code under test.
		expect(
			doubles(
				"expect(support).toMatchObject({ definition: true, references: true, hover: false });\n",
			),
		).toEqual([]);
	});

	it(`does not flag an object below ${SERVICE_DOUBLE_MIN_MEMBERS} shared members`, () => {
		expect(
			doubles(
				"const c = { isAlive: () => true, shutdown: vi.fn(), other: 1 };\n",
			),
		).toEqual([]);
	});

	it("never counts a double quoted in a comment or a string", () => {
		const prose = [
			"// { isAlive: () => true, shutdown() {}, getDiagnostics: vi.fn() }",
			'const s = "{ isAlive: () => true, shutdown() {}, getDiagnostics: vi.fn() }";',
		].join("\n");
		expect(doubles(prose)).toEqual([]);
	});
});
