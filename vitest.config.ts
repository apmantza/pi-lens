import * as os from "node:os";
import { defineConfig } from "vitest/config";
import {
	formatTestWorkerBudget,
	resolveTestWorkerBudget,
} from "./scripts/lib/worker-budget.mjs";

// Applies to globalSetup as well as workers: ordinary tests never install tools.
process.env.PI_LENS_DISABLE_TOOL_INSTALL ??= "1";

// Background coding agents get worktrees under .claude/worktrees/ — vitest's
// default exclude covers node_modules/.git/dist but NOT those, so a "full
// suite" run in the main tree silently swept every agent's IN-PROGRESS
// worktree tests too (seen 2026-07-11: 40+ phantom failures, all from
// half-finished branches in sibling worktrees).
const sharedExclude = [
	"**/node_modules/**",
	"**/dist/**",
	"**/.{git,cache,output,temp}/**",
	"**/.claude/**",
	// Fixture projects carry *.test.ts files that belong to the FIXTURE's own
	// toolchain (e.g. the native-TS7/Vitest fixture the live integration suite
	// copies out and type-checks) — they are inputs, not repo tests, and fail
	// when collected here (#1412 PR #1433 CI).
	"tests/fixtures/**",
	// The live suite's copied-out temp projects (gitignored, cleaned in
	// afterAll, but a mid-run collection race must not pick them up).
	"tests/native-ts7-live-*/**",
];

// The two slow real-process files `npm run test:integration` runs on their own.
// `npm run test:unit` is the complement, and the switch has to live here: every
// project below sets its own `exclude`, which REPLACES the root/CLI value
// outright, so a `vitest run --exclude <file>` on the command line is silently
// ignored (it was, from #1101 until 2026-08-06). npm exports the script name it
// is running, and that survives the with-test-lock wrapper identically on every
// OS — unlike an inline `FOO=1 …` prefix, which cmd.exe cannot parse.
// `test:integration` names these same two files positionally in package.json
// (a positional filter DOES survive) — keep the two lists in step.
const integrationInclude = [
	"tests/index-integration.test.ts",
	"tests/clients/lsp/integration.test.ts",
];
const unitOnlyExclude =
	process.env.npm_lifecycle_event === "test:unit" ? integrationInclude : [];

const sharedGlobalSetup = [
	"./tests/support/check-build-freshness.ts",
	"./tests/support/prewarm-grammars.ts",
	// After check-build-freshness: the seed analyze runs the in-place build.
	"./tests/support/prewarm-tool-home.ts",
	"./tests/support/git-config-guard-setup.ts",
];

const sharedSetupFiles = ["./tests/support/vitest-setup.ts"];

// Fork concurrency and per-fork heap ceiling both come from ONE resolver
// (scripts/lib/worker-budget.mjs), which sizes them against the host's
// real memory. Before #2042 they were two constants tuned on a 32-core / 68 GB
// dev host and applied verbatim to CI, where `maxWorkers` fell back to
// vitest's `availableParallelism() - 1` and bounded worker COUNT while per-fork
// peak RSS — the axis that actually grows, and native rather than V8 heap — was
// bounded by nothing. That is how the Unit-tests job got SIGKILLed (exit 137)
// with no failing assertion. Local runs keep the measured 2026-07-29 posture
// (8 forks ≈ 40s / 9-11 GB peak RSS; 6 forks ≈ 44s / 8 GB); memory-constrained
// local runs still use PI_LENS_TEST_MAX_WORKERS=6.
const testHost = {
	totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
	cpus: os.availableParallelism?.() ?? os.cpus().length,
	ci: Boolean(process.env.CI),
	workerOverride: Number(process.env.PI_LENS_TEST_MAX_WORKERS) || undefined,
	heapOverride: Number(process.env.PI_LENS_TEST_WORKER_HEAP_MB) || undefined,
};
const testBudget = resolveTestWorkerBudget(testHost);
if (testHost.ci) {
	// One line naming the host and the decision. Without it an exit 137 says
	// nothing about what the run was allowed to use.
	console.log(formatTestWorkerBudget(testHost, testBudget));
}

const sharedMaxWorkers = testBudget.maxWorkers;

// Worker heap headroom (#2042 note first: this ceiling is now DERIVED from the
// host by the budget resolver above, not the flat 4096 that the paragraph below
// describes — on a 68 GB dev host it still resolves to 4096, so the reasoning
// stands unchanged there; on a small CI runner it shrinks, and a fork that
// blows the smaller ceiling dies with Node's own heap-limit report naming the
// FILE, which is a far better failure than the OS killing the whole run).
//
// The full suite occasionally died with a "Worker
// exited unexpectedly" + a `node::GetNodeReport` dump. That report is emitted
// by Node's OWN fatal-error handler (V8 heap-limit reached) — an external OS
// OOM-kill SIGKILLs with no dump — so the crash is a single long-lived worker
// hitting its own V8 heap ceiling, not system memory exhaustion (32-core /
// 68 GB host). With `isolate: true` (vitest's default) each worker's module
// registry is reset per file, so the native addons (the many tree-sitter
// grammars + @ast-grep/napi) are re-loaded and re-compiled file after file.
// CORRECTION (#2042, measured 2026-08-25): this paragraph used to say those
// buffers "accumulate in the reused worker". They do not — Vitest 4's forks
// pool with `isolate: true` spawns a FRESH child process per test file (20
// files at `maxWorkers: 1` produced 20 distinct pids), so a fork's peak is its
// own file's peak and nothing carries over. The cost is per-file, not
// cumulative; it is simply large for the tail (p99 1405 MB, max 2267 MB).
// `execArgv` passes --max-old-space-size to every spawned worker.
// Tune via PI_LENS_TEST_WORKER_HEAP_MB. NOTE: Vitest 4
// flattened the config — `execArgv` is a direct `test` field (the v3
// `poolOptions.forks.execArgv` nesting no longer exists and is silently
// ignored).
const sharedExecArgv = [`--max-old-space-size=${testBudget.heapMb}`];

// Tier 1 fix (#902): these files all transitively drive real tree-sitter
// grammar parses (via clients/review-graph/builder.js or the project-diagnostics
// scanner), and `isolate: true` (required — see above, and removing it
// reintroduces the V8 heap-ceiling crash) means each test FILE gets a fresh
// module registry, so the native grammar addons get re-loaded/re-compiled
// per file rather than once per worker. Grammar prewarm
// (tests/support/prewarm-grammars.ts) only pre-fetches the wasm BYTES to
// disk — it does nothing to stop several of these files re-compiling their
// grammars concurrently once spread across forks under the default
// `maxWorkers: "50%"`. That contention was intermittently blowing past the
// fork teardown deadline ("Timeout terminating forks worker") even though
// every test in the file had already passed. Carving this glob into its own
// project with a small capped `maxWorkers` bounds how many of these heavy
// files compile grammars at once, without reducing parallelism for the rest
// of the suite (which keeps its existing `maxWorkers: "50%"` in the
// "default" project below).
const grammarHeavyInclude = [
	"tests/clients/review-graph/shared-extraction-ir.test.ts",
	"tests/clients/review-graph/tsconfig-paths.test.ts",
	"tests/clients/review-graph/extract-symbols.test.ts",
	"tests/clients/project-diagnostics/scanner.test.ts",
	// #1089: these two co-load most of the grammar set (incl. the heavy
	// swift/cpp/kotlin/csharp four) for the call-graph fixture matrices —
	// the exact #255/#902 contention shape this project exists to bound.
	"tests/clients/tree-sitter-call-graph.test.ts",
	"tests/clients/module-report-call-graph.test.ts",
	// #2074: builds several synthetic TypeScript projects end-to-end through the
	// review-graph extractor. Measured peak RSS 1,417 MB — the same class as its
	// review-graph siblings above (1,394-1,396 MB) — and the CI unit job was
	// killed at exit 137 the first time this file ran as a default-project
	// co-resident.
	"tests/clients/review-graph/rebuild-cost.test.ts",
];

// Tier 2 fix (#902): event-loop *occupancy* guards (measureMaxSyncBlockMs —
// see tests/support/perf-harness.ts) measure the longest synchronous stretch
// the code under test holds the loop, via an independent setImmediate
// sampler. That sampler is a real event-loop citizen: it only gets scheduled
// when the OS actually gives this process a turn. Under the "default"
// project's `maxWorkers: "50%"` — dozens of sibling forks doing grammar
// compiles, `ast-grep`/biome child-process spawns, and LSP server smoke
// tests all competing for cores — the sampler itself can be descheduled for
// a while, which the guard cannot tell apart from the code under test
// actually blocking. That's a scheduling-jitter false positive, not the
// regression the guard exists to catch (confirmed 2026-07-31: both files
// pass cleanly and repeatedly run solo; they only fail mid-"default"-project
// full-suite runs, alongside grammar/CLI-heavy sibling files). Widening the
// ms threshold can't absorb this without also hiding the real ~800ms+
// non-yielding-walk regression the tests guard against (#188/#191/#192) —
// so, same fix shape as the grammar-heavy project above: reduce how much
// sibling-fork noise coincides with the *measurement window* itself, not
// how tolerant the measurement is. A capped, phased-last project means by
// the time these run, the default project's fork storm (and grammar-heavy's
// smaller one) has already fully drained, so the sampler only ever
// contends with (at most) one other file in this group.
const timingSensitiveInclude = [
	// Real node child-process barrier race for #2173; process scheduling makes
	// this unsuitable for the default fork storm.
	"tests/clients/instance-registry-race.test.ts",
	"tests/clients/instance-registry-lock.test.ts",
	"tests/clients/review-graph-retention.test.ts",
	"tests/clients/source-walk-occupancy.test.ts",
	"tests/clients/source-filter-async.test.ts",
	// Workspace-edit planning also uses the independent occupancy sampler; keep
	// its measurement window out of the default fork storm while the guard still
	// catches a genuinely non-yielding planner. #1081 additionally showed the
	// sampler gap alone could not tell a descheduled worker apart from a real
	// block, so the test now asserts a CPU-time budget as well — but CPU time is
	// NOT contention-proof here either: on Windows this payload is ~400
	// realpathSync.native calls (clients/path-utils.ts normalizeFilePath) whose
	// SYSTEM time is charged to this process and does inflate under load. Both
	// numbers therefore need this project's quiet measurement window.
	"tests/clients/lsp/edits.test.ts",
	// Same measureMaxSyncBlockMs sampler + same contention-starvation flake
	// (observed 2026-07-31: cold buildOrUpdateGraph blew the 300ms budget at
	// ~82s under a full-suite fork storm, exhausting its retry:2). Its
	// existing retry isn't enough on its own; phasing it here removes the
	// sibling-fork noise the sampler was actually measuring.
	"tests/clients/cascade-graph-occupancy.test.ts",
	// 2026-08-12 (#1230): the remaining measureMaxSyncBlockMs users. The list
	// above had drifted — these files run the SAME independent setImmediate
	// sampler under the SAME default-project fork storm, so they carry the same
	// scheduling-jitter false-positive risk and belong in the same quiet phase;
	// they were simply never added. tests/config/timing-sensitive-coverage.test.ts
	// now derives the expected membership from the sampler import itself and
	// fails if a new sampler test lands outside this list (or an entry here goes
	// stale), so the drift cannot silently recur. Each entry below was verified
	// to import measureMaxSyncBlockMs from tests/support/perf-harness.ts:
	//   - lens-diagnostics-occupancy: diagnostics-run loop occupancy.
	//   - workspace-diagnostics-occupancy: workspace-wide diagnostics fan-out.
	//   - performance-report-occupancy / pipeline-snapshot-occupancy: report and
	//     snapshot assembly walks.
	//   - word-index-async-build: the async word-index build's yield behaviour.
	//   - ruby-drive-dirs: not named "-occupancy", but runs two sampler-based
	//     fail-then-pass screens over the Ruby drive-dir walk (#902 pattern).
	//   - review-graph-superseded-persist: holds a worker generation in a 400ms
	//     test-only suspension window while admitting its replacement. Two #1318
	//     CI flakes under the default fork storm showed that deterministic
	//     admission alone (#1329) does not make that window contention-proof.
	"tests/tools/lens-diagnostics-occupancy.test.ts",
	"tests/clients/lsp/workspace-diagnostics-occupancy.test.ts",
	"tests/clients/lsp/ruby-drive-dirs.test.ts",
	"tests/clients/performance-report-occupancy.test.ts",
	"tests/clients/pipeline-snapshot-occupancy.test.ts",
	"tests/clients/word-index-async-build.test.ts",
	"tests/clients/word-index-cooperative-occupancy.test.ts",
	"tests/clients/word-index-persist-occupancy.test.ts",
	//   - cooperative-budget: #1215 acceptance screens — sampler-based
	//     occupancy at 800-item scale plus the abort-latency bound.
	"tests/clients/cooperative-budget.test.ts",
	"tests/clients/review-graph-superseded-persist.test.ts",
	// #1137: the shared walk engine's directory-read occupancy screen. Same
	// sampler, and its fail-then-pass pair injects a busy-wait stall, so it
	// must not compete with a fork storm for CPU turns.
	"tests/clients/source-walker-io-occupancy.test.ts",
	// #1980: blocks the real event loop twice (a parked-thread futex wait, then
	// a busy spin of the same length) and asserts the two classify differently
	// on the CPU axis, reading process.cpuUsage through getEventLoopStats.
	// Under the default fork storm a busy spin gets descheduled and burns less
	// CPU than the wall time it held, which would make the compute case read as
	// a stall — contention, not a regression, so the cure is a quiet host, not
	// a looser assertion. timing-sensitive-coverage.test.ts derives this
	// membership from the process.cpuUsage marker and fails if it is absent.
	//
	// Read the `maxWorkers: 2` note below together with this entry. That note
	// says the lane's heavy neighbour is gone; this file is a NEW one — three
	// cases that busy-spin a core for ~4.8s in total, which is exactly the
	// shape that starved a sibling's sampler at cap 2 before. Measured rather
	// than assumed when this landed: the full lane ran clean 4/4 at cap 2 with
	// this file in it (19 files, 118 tests, ~49s). If a sampler-based sibling
	// starts flaking here, this file is the first suspect and the cap is the
	// first lever.
	"tests/clients/loop-block-stall-discrimination.test.ts",
];

// #1022 fix: the "workspace LSP winner" case in this file spawns a REAL
// ast-grep LSP child process and waits on its `initialize` handshake plus
// its first-document diagnostics — both bounded by ast-grep's own
// deliberately-generous initializeTimeoutMs (~15s, see clients/lsp/server.ts)
// because the first scan of a session compiles the full rule set (~350
// files incl. the CodeRabbit catalog). `client.waitForDiagnostics`
// (clients/lsp/client.ts) resolves SILENTLY on timeout rather than throwing,
// so under the "default" project's `maxWorkers: "50%"` fork storm — dozens
// of sibling forks doing grammar compiles and their own process spawns —
// CPU contention can starve this real spawn past its budget, and that
// starvation surfaces not as a timeout but as a false "diagnostic not
// found" assertion failure (confirmed via 2026-08-01 repro: solo run green
// every time, full-suite run intermittently red on exactly this case).
// Same fix shape as grammar-heavy/timing-sensitive above: phase this file
// into its own low-concurrency, last-running project so its real-LSP-spawn
// budget window never has to compete with the rest of the suite's fork
// storm for CPU turns. This removes the CONTENTION rather than just
// widening the timeout (see the companion budget-alignment fix in the test
// file itself, which corrects the timeout values to match ast-grep's own
// declared budget instead of a shorter invented constant — belt-and-braces,
// not a substitute for phasing).
// Membership is enforced, not conventional (#2344): tests/config/
// lsp-spawn-heavy-coverage.test.ts derives candidates from the real spawn
// seams (a bare `launchLSP(` call, a `getServerById(` registry spawn, or an
// import of the fake-LSP fixture) and fails when a spawning test lands
// outside this list without a documented exemption — or a member here
// silently goes stale.
const lspSpawnHeavyInclude = [
	"tests/clients/ast-grep-rule-precedence-followups.test.ts",
	// #2344: npm test leaves this real-child integration suite in the default
	// project unless it is explicitly phased here. `test:integration` still
	// selects the same file positionally, while `test:unit` excludes it below.
	"tests/clients/lsp/integration.test.ts",
	"tests/clients/lsp/workspace-diagnostics-sweep-attribution.integration.test.ts",
	// #873/#448: the dispatch LSP runner against a real stdio JSON-RPC server
	// — a real child spawn through the production LSPService plus a
	// `.pi-lens/lsp.json` custom server, waiting on real first-document
	// diagnostics. Same #1022/#2332 contention class as its lane siblings.
	"tests/clients/dispatch/runners/lsp-real-runner.test.ts",
];

// #1920: files that assert REAL wall-clock elapsed-time budgets (Date.now()
// deltas around awaited work, or a self-reported span whose window contains
// deschedulable real work). Unlike the timing-sensitive list above, these do
// not use the occupancy sampler — the timing-sensitive project's charter
// deliberately excludes plain wall-clock budgets (see
// tests/config/timing-sensitive-coverage.test.ts) — but they fail the same
// way under the default project's fork storm: the budget ends up measuring
// scheduler contention, not code speed (startup-overhead measured 659–2321ms
// against a 500ms budget under load, green solo every time). Same cure, one
// phase later: fully serial, dead last, so each budget window gets a quiet
// host. Sweep coverage for other members lives in this list; new entries must
// carry a wall-clock budget assertion, not just slowness.
const wallClockBudgetInclude = [
	"tests/clients/startup-overhead.test.ts",
	"tests/clients/runtime-session-scan-cache.test.ts",
	"tests/clients/cascade-turn-merge.test.ts",
	"tests/clients/read-expansion-enrichment.test.ts",
	"tests/clients/pipeline-lsp-sync.test.ts",
	// #2358: the flat-server discriminator asserts the real outstanding wedge
	// window. Keep child-process CPU sampling and this wall-clock lower bound in
	// the fully serialized, dead-last phase.
	"tests/clients/lsp/service-notify-cpu-liveness.test.ts",
];

export default defineConfig({
	test: {
		exclude: sharedExclude,
		// Root-config-only in Vitest 4 (see the grammar-heavy project's comment
		// below) — applies to every project's fork teardown, not just the
		// grammar-heavy one, which is strictly more forgiving everywhere else.
		teardownTimeout: 30_000,
		projects: [
			{
				test: {
					name: "default",
					exclude: [
						...sharedExclude,
						...unitOnlyExclude,
						...grammarHeavyInclude,
						...timingSensitiveInclude,
						...lspSpawnHeavyInclude,
						...wallClockBudgetInclude,
					],
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					maxWorkers: sharedMaxWorkers,
					execArgv: sharedExecArgv,
					// Vitest 4 requires distinct groupOrder whenever projects have
					// different `maxWorkers` — see the "grammar-heavy" project below
					// for why that's actually desirable here, not just a workaround.
					sequence: { groupOrder: 0 },
				},
			},
			{
				test: {
					name: "grammar-heavy",
					include: grammarHeavyInclude,
					exclude: sharedExclude,
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					execArgv: sharedExecArgv,
					// Cap, don't serialize: bounds concurrent grammar re-compiles to
					// 2-at-a-time instead of whatever `maxWorkers: "50%"` would give
					// them (the root cause above), without going fully sequential.
					// NOTE: Vitest 4 removed `poolOptions.forks.maxForks` — pool
					// concurrency knobs were unified into the top-level
					// `maxWorkers` (applies to whichever pool is active; this repo
					// uses the default `forks` pool everywhere).
					// #2042: 2 locally, but derived on CI — these files carry the
					// suite's largest native footprints (measured 3345 MB and 3853 MB
					// peak RSS), so two at once is a bigger bite than a small runner
					// has to give.
					maxWorkers: testBudget.heavyMaxWorkers,
					// Distinct groupOrder is required whenever projects have
					// different `maxWorkers` (Vitest 4 throws otherwise). Side
					// effect: scheduling groups run as sequential PHASES (group 0
					// fully drains, then group 1 starts) rather than interleaved —
					// a feature here, not a cost: it guarantees these 4
					// grammar-heavy files never share fork-scheduling time with the
					// rest of the suite, so they can never race a batch of OTHER
					// files' concurrent grammar compiles either.
					sequence: { groupOrder: 1 },
					// Supplement, not a substitute for the maxForks cap above: give
					// fork teardown more headroom in case a heavy grammar compile is
					// still finishing when a test file's hooks wrap up.
					// NOTE: Vitest 4's per-project `ProjectConfig` type excludes
					// `teardownTimeout` (it moved to root-config-only), so the 30s
					// bump lives on the top-level `test` block below instead —
					// applies to both projects, which only makes the default
					// project's teardown MORE forgiving, never less.
					hookTimeout: 60_000,
				},
			},
			{
				test: {
					name: "timing-sensitive",
					include: timingSensitiveInclude,
					exclude: sharedExclude,
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					execArgv: sharedExecArgv,
					// At most two at a time so the event-loop-occupancy sampler in each
					// (measureMaxSyncBlockMs, see perf-harness.ts) contends with at most
					// one sibling fork for CPU turns while it's mid-measurement, not the
					// full-suite fork storm. This lane briefly ran at 1 while
					// word-index-per-edit lived here: that file rebuilt a 401-document
					// index (~1.2s, retry: 2) and at cap 2 starved
					// performance-report-occupancy's sampler on a loaded runner (107ms
					// against a 75ms budget, 3/3 retries). #2254 converted that guard to
					// a load-invariant clock-read count and moved it out of this lane, so
					// the heavy neighbour is gone and the cap returns to 2.
					maxWorkers: 2,
					// Its own phase, after both "default" and "grammar-heavy" drain
					// (required anyway once maxWorkers differs from "default" — see
					// the grammar-heavy project above). By running last and alone,
					// these occupancy guards get a (near-)quiet host for their
					// measurement window instead of racing the full-suite fork storm
					// that was intermittently starving their sampler and tripping the
					// budget on ambient scheduling delay, not a real regression.
					sequence: { groupOrder: 2 },
					hookTimeout: 60_000,
				},
			},
			{
				test: {
					name: "lsp-spawn-heavy",
					include: lspSpawnHeavyInclude,
					exclude: [...sharedExclude, ...unitOnlyExclude],
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					execArgv: sharedExecArgv,
					// Full serialization, not just a cap: four files, but the point
					// is to guarantee zero overlap with the "default" project's
					// fork storm (the actual contention source, see #1022/#2332
					// above), not to bound intra-project concurrency.
					maxWorkers: 1,
					// Last phase: by the time this runs, "default", "grammar-heavy",
					// and "timing-sensitive" have all fully drained, so the real
					// ast-grep LSP spawn's initialize/diagnostics budget window gets
					// a quiet host instead of racing the rest of the suite.
					sequence: { groupOrder: 3 },
					// Real LSP process spawn + rule-set compile can legitimately use
					// most of its declared ~15s budget twice over (initialize, then
					// first-document diagnostics) before shutdown; give teardown the
					// same headroom as the other heavy projects.
					hookTimeout: 60_000,
				},
			},
			{
				test: {
					name: "wall-clock-budget",
					include: wallClockBudgetInclude,
					exclude: sharedExclude,
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					execArgv: sharedExecArgv,
					// Fully serialized (#1920): these files' budgets measure real
					// elapsed time around awaited work, so even ONE concurrent
					// sibling can inflate them. One at a time, after every other
					// project has drained.
					maxWorkers: 1,
					sequence: { groupOrder: 4 },
					hookTimeout: 60_000,
				},
			},
		],
	},
});
