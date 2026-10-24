/**
 * #4596 — every `catch` handler in the shipped trees either publishes a
 * record for the failure it swallows or states, in a comment, why it needs
 * none.
 *
 * ## The recurrence this guards
 *
 * AGENTS.md shape 31 ("pull-only observability"). The 2026-10-18 audit of 53
 * merged `fix` PRs found four live instances of the same shape shipped in one
 * week: `clients/out-of-band-changes.ts`'s `catch { continue; }` published
 * `deleted: 1` for a file that still existed, `clients/lsp/implicit-scope.ts`'s
 * `catch { return "unknown" }` graded an unreadable module with no row at all,
 * `index.ts`'s `.catch(() => {})` dropped a failed root deregistration, and
 * `clients/lsp/index.ts`'s `.catch(() => {})` left `lsp_touch_file` reporting
 * `failureKind: "success"` for a rejected `didSave`. Each PR's `Observability`
 * section was present and each said the arm was covered. Nothing could have
 * told a reviewer that adding the next silent `catch` was a defect, and no
 * detector saw the population: the tree has row-shaped sweeps for stream
 * handlers, socket listeners and worker messages, and none for `catch`.
 *
 * ## The rule (tests/support/silent-catch-scan.ts)
 *
 * A `catch` clause of a `try`, a `.catch(…)` handler in any spelling
 * (`.catch`, `["catch"]`, `` [`catch`] ``, and the second argument of `.then`),
 * is judged on EVERY path the failure can take: `recorded` only when a record
 * seam (`record…`, `log…`, `increment…` — the repo's logger convention) runs at
 * the handler's top level and before any exit, `rethrows` only when a
 * top-level `throw` runs with no `return`/`continue`/`break` anywhere in the
 * handler, `declared-none` when a `none: <reason>` comment sits inside the
 * handler actually judged (its body, never a sibling argument, the catch
 * parameter or a nested closure the failure cannot reach) or on the line just
 * above it when the handler starts its own line, `silent` otherwise, and `unclassified` (a hard failure, never a
 * skip) when a handler or a statically string-valued key is not a form the
 * scan can follow. An indirect reach of a rejection member
 * (`.catch.call`/`.apply`/`.bind`, a binding of `p.catch` that is then called)
 * is a site too, and `unclassified`: the scan cannot tell which argument is
 * the handler, and shape 69 forbids dropping it. A conditional record or a
 * conditional rethrow leaves the other path swallowing, so it is `silent`.
 * The detector's own state table, one named case per row, is
 * `tests/support/silent-catch-scan.test.ts`.
 *
 * ## Scope
 *
 * The sweep scans `clients/`, `mcp/`, `tools/` and `index.ts`: 529 files and
 * 1,334 `catch` handlers (including seven unresolved delegations), the shipped runtime. Two populations are outside it
 * by decision: `scripts/` (the repo's own gates, ~515 silent handlers in 184
 * files, its own baseline and its own round: #4607) and `tests/` (fixtures and
 * doubles, where a swallow is the fixture's job). A new scope is a new row in
 * this table, never a silent widening.
 *
 * ## The baseline
 *
 * The population this rule finds today predates it: 1,188 handlers across 247
 * files swallow by design or by history, and rewriting them is not this
 * change. Each file's silent count AND the content identity of its admitted
 * handler set are pinned together, so a NEW silent handler reds even when an
 * old one was removed or spent on a `none:` line in the same file (AGENTS.md
 * shape 36: count-based laundering), a silent handler in a new file reds as
 * unlisted, and converting one to a record reds as stale until the row is
 * re-pinned.
 *
 * `PRE_RULE` is the one honest admission for a file this change did not read
 * handler by handler: it says the set may not change and claims nothing about
 * each handler. The four rows with their own text are files where a reader
 * knows better than the class. The registry only shrinks — this change deleted
 * `clients/lsp/implicit-scope.ts`'s row entirely (five records added), took one
 * from `index.ts` and one from `clients/out-of-band-changes.ts` (which also
 * turned one into a `none:` line), retired `clients/atomic-write.ts`'s row
 * (four `none:` lines), and re-pinned the population the stricter path rule
 * found: a handler with a conditional record or a conditional `throw` is
 * `silent`, not `recorded`/`rethrows` (#4603 review F1).
 *
 * Re-pin from this file's own census: `PI_LENS_PRINT_PINS=1` on this suite
 * prints the rows to paste, with each file's silent line numbers as a comment.
 * Re-pin only downward; a row that must grow needs the reason stated here.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
} from "../support/sweep-kit.js";
import {
	type CatchSite,
	scanSilentCatches,
} from "../support/silent-catch-scan.js";
import { currentPeakRssMb, reportPeakRss } from "../support/worker-peak-rss.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The trees the shipped runtime lives in, as #4596 scopes it. */
const SHIPPED_TREES = ["clients", "mcp", "tools"];

interface Admission {
	/** How many silent handlers this file is admitted to hold. */
	silent: number;
	/**
	 * A content identity for the admitted set: 16 hex of the sorted
	 * per-handler identities. A count alone could be kept level by adding one
	 * silent handler and removing another (or spending a `none:` line on it),
	 * so the set itself is pinned (AGENTS.md shape 36).
	 */
	identities: string;
	/** Why those handlers need no record. */
	reason: string;
}

/**
 * The admission for a file this change did not read handler by handler: the
 * count is pinned and may not grow, and the row claims nothing more.
 */
const PRE_RULE =
	"pre-#4596 population admitted at its pinned count; it may not grow, a shrink re-pins it, and this row makes no claim that each handler is harmless";

const SHARP_INSTALL_STAMP =
	"the install-stamp reads: an unreadable lockfile or a root that cannot be listed answers `-`, which the stamp reader takes as no install change; the declaration walk's own unreadable subtree and unreadable file ARE recorded (`lsp-declaration-walk-unreadable`), and its absence races carry `none:` lines";

const SHARP_DID_SAVE =
	"the residual `didSave` gaps after #4575 (which made the rejected save record and retry once) belong to the open save-failure change (#4532); that round re-pins this row";

const SHARP_TOOL_RESULT =
	"this file's remaining silent handlers predate #4596; the prescan change (#4594, issue #4504) merged as `7b83505ad` and left the set unchanged, so it is admitted at its pinned count and content identity rather than owned by an open round";

const SHARP_HOST =
	"the host adapter's best-effort shutdown and teardown arms; the one this change fixed (`deregisterInstanceRoot`'s `.catch`) now records through `recordRootDeregistrationFailure`. Several others record through `surfaceHandlerCrash` or a stale-ctx rethrow plus `recordDegradationOnce`, which this scan cannot follow, so they are pinned here";

/**
 * The population on the merge of `origin/master` (`d7f85d909`) and this change,
 * one row per file: 1,188 silent handlers in 247 files, each row pinned by
 * count and by the content identity of its admitted set. Shrink only.
 */
const BASELINE: Readonly<Record<string, Admission>> = {
	"clients/actionable-warnings.ts": {
		silent: 6,
		identities: "e926d3cd1c334a07",
		reason: PRE_RULE,
	}, // :347, :360, :1169, :1340, :2061, :2272
	"clients/advisory-provenance.ts": {
		silent: 4,
		identities: "4be1802a08b42400",
		reason: PRE_RULE,
	}, // :49, :70, :186, :384
	"clients/agent-nudge.ts": {
		silent: 3,
		identities: "3009ae881ca29582",
		reason: PRE_RULE,
	}, // :427, :431, :615
	"clients/analysis-root.ts": {
		silent: 1,
		identities: "7b52b635719a3045",
		reason: PRE_RULE,
	}, // :50 (2 -> 1, #4689: `realPathOrResolved` folded onto path-utils)
	"clients/ast-grep-client.ts": {
		silent: 5,
		identities: "e0171caad3e9bf11",
		reason: PRE_RULE,
	}, // :486, :596, :632, :637, :684
	"clients/ast-grep-rule-manager.ts": {
		silent: 3,
		identities: "2edc57365ab55761",
		reason: PRE_RULE,
	}, // :48, :59, :126
	"clients/atomic-write-staging.ts": {
		silent: 4,
		identities: "e7ba54e54a59ce82",
		reason: PRE_RULE,
	}, // :50, :74, :79, :82
	"clients/bash-file-access.ts": {
		silent: 3,
		identities: "c6cea2c7ab1fb7de",
		reason: PRE_RULE,
	}, // :505, :707, :729
	"clients/biome-client.ts": {
		silent: 1,
		identities: "857a22d3715ba4a3",
		reason: PRE_RULE,
	}, // :429
	"clients/blocker-freshness.ts": {
		silent: 13,
		identities: "a6bb69bf104bd14d",
		reason: PRE_RULE,
	}, // :347, :378, :510, :559, :571, :663, :683, :773, :782, :932, :1161, :1176, :1448
	"clients/blocker-past-eof.ts": {
		silent: 2,
		identities: "a9196408101956b1",
		reason: PRE_RULE,
	}, // :125, :186
	"clients/bootstrap.ts": {
		silent: 4,
		identities: "36bf6065827c8d53",
		reason: PRE_RULE,
	}, // :237, :263, :275, :654
	"clients/bounded-pid-file-lock.ts": {
		silent: 14,
		identities: "0db0782e5dcad821",
		reason: PRE_RULE,
	}, // :58, :83, :99, :115, :149, :158, :161, :195, :211, :214, :336, :347, :358, :434
	"clients/bounded-telemetry.ts": {
		silent: 2,
		identities: "4830315d8c37f502",
		reason: PRE_RULE,
	}, // :304, :337
	"clients/build-identity.ts": {
		silent: 2,
		identities: "df9a2aab8aac44fa",
		reason: PRE_RULE,
	}, // :73, :81
	"clients/bundled-resource-health.ts": {
		silent: 1,
		identities: "a05799527c99af28",
		reason: PRE_RULE,
	}, // :61
	"clients/bus-publish.ts": {
		silent: 1,
		identities: "5942496acd59b074",
		reason: PRE_RULE,
	}, // :175
	"clients/cache-manager.ts": {
		silent: 6,
		identities: "208b57147636760f",
		reason: PRE_RULE,
	}, // :299, :345, :362, :386, :400, :623
	"clients/cache-observability.ts": {
		silent: 10,
		identities: "765e8cbdadc92783",
		reason: PRE_RULE,
	}, // :507, :837, :862, :882, :1176, :1186, :1239, :1264, :1427, :1587
	"clients/cache/rule-cache.ts": {
		silent: 5,
		identities: "4332dc8628e97e3b",
		reason: PRE_RULE,
	}, // :160, :176, :191, :198, :210
	"clients/call-graph.ts": {
		silent: 2,
		identities: "6d51c4997f27503e",
		reason: PRE_RULE,
	}, // :728, :1122
	"clients/cargo-manifest.ts": {
		silent: 1,
		identities: "cf08efebeaedf178",
		reason: PRE_RULE,
	}, // :56
	"clients/child-unref.ts": {
		silent: 4,
		identities: "66ddd3d8cdeab987",
		reason: PRE_RULE,
	}, // :50, :185, :200, :207
	"clients/code-quality-warnings.ts": {
		silent: 1,
		identities: "e559edc3929478d1",
		reason: PRE_RULE,
	}, // :361
	"clients/codebase-model.ts": {
		silent: 2,
		identities: "06ac97ea35710e74",
		reason: PRE_RULE,
	}, // :214, :244
	"clients/collateral-test-role.ts": {
		silent: 1,
		identities: "7b52b635719a3045",
		reason: PRE_RULE,
	}, // :37
	"clients/complexity-client.ts": {
		silent: 2,
		identities: "47ffa5a721924bd2",
		reason: PRE_RULE,
	}, // :524, :537
	"clients/config-core/normalize.ts": {
		silent: 1,
		identities: "291bdd2b93d8b884",
		reason: PRE_RULE,
	}, // :144
	"clients/config-core/resolve.ts": {
		silent: 2,
		identities: "5bad8c90626e84f4",
		reason: PRE_RULE,
	}, // :82, :108
	"clients/config-core/schema.ts": {
		silent: 1,
		identities: "a37a1b3a1638df7c",
		reason: PRE_RULE,
	}, // :211
	"clients/config-locations.ts": {
		silent: 2,
		identities: "d6cc1d93ed45eb10",
		reason: PRE_RULE,
	}, // :292, :379
	"clients/config-resolve.ts": {
		silent: 2,
		identities: "55e0525579588ef3",
		reason: PRE_RULE,
	}, // :135, :143
	"clients/dead-code-client.ts": {
		silent: 2,
		identities: "0274136cf710a333",
		reason: PRE_RULE,
	}, // :176, :490
	"clients/deadline-utils.ts": {
		silent: 4,
		identities: "097565f30c5331a0",
		reason: PRE_RULE,
	}, // :95, :105, :106, :339
	"clients/debug-handles.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :184
	"clients/debug-heap.ts": {
		silent: 5,
		identities: "e9f923841e24738f",
		reason: PRE_RULE,
	}, // :119, :132, :144, :172, :183
	"clients/deferred-runner-blockers.ts": {
		silent: 1,
		identities: "cf08efebeaedf178",
		reason: PRE_RULE,
	}, // :248
	"clients/degradation-ledger.ts": {
		silent: 4,
		identities: "2ca4fdb81f73c17e",
		reason: PRE_RULE,
	}, // :2018, :2037, :2088, :2389
	"clients/dependency-checker.ts": {
		silent: 3,
		identities: "7769bbb29be70c33",
		reason: PRE_RULE,
	}, // :475, :822, :1161
	"clients/deps/ast-grep-napi.ts": {
		silent: 2,
		identities: "81bebd9fa93a0354",
		reason: PRE_RULE,
	}, // :24, :38
	"clients/deps/web-tree-sitter.ts": {
		silent: 1,
		identities: "93c689d87d20f296",
		reason: PRE_RULE,
	}, // :26
	"clients/diagnostic-dispositions.ts": {
		silent: 5,
		identities: "7578e0c38034b277",
		reason: PRE_RULE,
	}, // :391, :421, :449, :564, :811
	"clients/diagnostic-line-freshness.ts": {
		silent: 5,
		identities: "809dfcb662f6df93",
		reason: PRE_RULE,
	}, // :239, :254, :343, :363, :400
	"clients/disk-change-subscribers.ts": {
		silent: 2,
		identities: "c7b556989b96b5f2",
		reason:
			"#4535 slice 2 moved both here verbatim from `clients/runtime-tool-result.ts`'s held-primary pass, and they are the same two best-effort reads they were there: a document whose disk bytes cannot be read is still a held document whose server view may be stale (the caller reports it as a target), and a primary send that throws is reported to the detector as `failed: true`, which is the row that surfaces it (`bash_write_primary_resync`, `opaque_mutation_head_moved`). Neither is a dropped failure: the first arms the delivery, the second is a classification the caller reads.",
	}, // :193, :207
	"clients/dispatch/dispatcher.ts": {
		silent: 7,
		identities: "fc89485966eea956",
		reason: PRE_RULE,
	}, // :316, :331, :337, :1102, :1807, :1815, :2039
	"clients/dispatch/facts/file-content.ts": {
		silent: 1,
		identities: "f187250a34b04dec",
		reason: PRE_RULE,
	}, // :15
	"clients/dispatch/integration.ts": {
		silent: 7,
		identities: "07e8090abd2c7f84",
		reason: PRE_RULE,
	}, // :323, :976, :1625, :1635, :2320, :3345, :3371
	"clients/dispatch/pending-runner-findings.ts": {
		silent: 2,
		identities: "6376b0d0a47313f2",
		reason: PRE_RULE,
	}, // :93, :104
	"clients/dispatch/rule-id-normalize.ts": {
		silent: 1,
		identities: "d1e59096f06aad20",
		reason: PRE_RULE,
	}, // :20
	"clients/dispatch/runners/actionlint.ts": {
		silent: 2,
		identities: "63bbd1e86b73cec7",
		reason: PRE_RULE,
	}, // :80, :89
	"clients/dispatch/runners/ast-grep-napi.ts": {
		silent: 8,
		identities: "dbd880cb0078760e",
		reason: PRE_RULE,
	}, // :730, :803, :1277, :1357, :1467, :1484, :1492, :1499
	"clients/dispatch/runners/biome-check.ts": {
		silent: 2,
		identities: "b3e55177c465876f",
		reason: PRE_RULE,
	}, // :150, :335
	"clients/dispatch/runners/cpp-check.ts": {
		silent: 1,
		identities: "7b52b635719a3045",
		reason: PRE_RULE,
	}, // :69
	"clients/dispatch/runners/credo.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :75
	"clients/dispatch/runners/cue-vet.ts": {
		silent: 1,
		identities: "4d60a71a5a96d6c7",
		reason: PRE_RULE,
	}, // :395
	"clients/dispatch/runners/eslint.ts": {
		silent: 1,
		identities: "549c430923722149",
		reason: PRE_RULE,
	}, // :122
	"clients/dispatch/runners/golangci-lint.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :142
	"clients/dispatch/runners/hadolint.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :62
	"clients/dispatch/runners/helm-render.ts": {
		silent: 6,
		identities: "b3d28e0fde85e066",
		reason: PRE_RULE,
	}, // :176, :226, :240, :449, :621, :677
	"clients/dispatch/runners/ktlint.ts": {
		silent: 2,
		identities: "053ebe0008169179",
		reason: PRE_RULE,
	}, // :68, :129
	"clients/dispatch/runners/lsp.ts": {
		silent: 2,
		identities: "e86d72685f2857b2",
		reason: PRE_RULE,
	}, // :302, :486
	"clients/dispatch/runners/oxlint.ts": {
		silent: 2,
		identities: "dde1c4039e54cc6c",
		reason: PRE_RULE,
	}, // :370, :462
	"clients/dispatch/runners/phpstan.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :119
	"clients/dispatch/runners/psscriptanalyzer.ts": {
		silent: 2,
		identities: "c5d123c4d9fdb88e",
		reason: PRE_RULE,
	}, // :309, :522
	"clients/dispatch/runners/rubocop.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :98
	"clients/dispatch/runners/ruff.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :70
	"clients/dispatch/runners/rust-clippy.ts": {
		silent: 2,
		identities: "54f10366e74186a5",
		reason: PRE_RULE,
	}, // :169, :374
	"clients/dispatch/runners/shellcheck.ts": {
		silent: 2,
		identities: "a5a5bb709e878c67",
		reason: PRE_RULE,
	}, // :130, :243
	"clients/dispatch/runners/spellcheck.ts": {
		silent: 1,
		identities: "42c395aa7aedc46b",
		reason: PRE_RULE,
	}, // :109
	"clients/dispatch/runners/spotbugs.ts": {
		silent: 4,
		identities: "e4321d0e12805307",
		reason: PRE_RULE,
	}, // :60, :72, :269, :283
	"clients/dispatch/runners/sqlfluff.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :146
	"clients/dispatch/runners/stylelint.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :156
	"clients/dispatch/runners/swiftlint.ts": {
		silent: 1,
		identities: "102fe3fe1a609dfd",
		reason: PRE_RULE,
	}, // :158
	"clients/dispatch/runners/terragrunt.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :78
	"clients/dispatch/runners/tflint.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :89
	"clients/dispatch/runners/tree-sitter.ts": {
		silent: 3,
		identities: "f6b1fdb2bfb03582",
		reason: PRE_RULE,
	}, // :74, :627, :717
	"clients/dispatch/runners/trivy-config.ts": {
		silent: 2,
		identities: "5b5e416ca6eb2754",
		reason: PRE_RULE,
	}, // :120, :196
	"clients/dispatch/runners/utils.ts": {
		silent: 1,
		identities: "cf08efebeaedf178",
		reason: PRE_RULE,
	}, // :20
	"clients/dispatch/runners/utils/candidate-probe.ts": {
		silent: 1,
		identities: "a044ae359f31afb8",
		reason: PRE_RULE,
	}, // :102
	"clients/dispatch/runners/utils/lazy-installer.ts": {
		silent: 1,
		identities: "abe2d56914cef611",
		reason: PRE_RULE,
	}, // :239
	"clients/dispatch/runners/utils/runner-helpers.ts": {
		silent: 7,
		identities: "711a4b4207c2affe",
		reason: PRE_RULE,
	}, // :334, :382, :506, :545, :698, :1328, :1638
	"clients/dispatch/runners/vale.ts": {
		silent: 1,
		identities: "ebc8ac6568c8a7ac",
		reason: PRE_RULE,
	}, // :134
	"clients/dispatch/runners/yaml-rule-parser.ts": {
		silent: 5,
		identities: "eaafa0a2a75a5c2a",
		reason: PRE_RULE,
	}, // :159, :183, :223, :261, :357
	"clients/durable-store.ts": {
		silent: 2,
		identities: "d8fb5fd4d9ec3e87",
		reason: PRE_RULE,
	}, // :49, :103
	"clients/event-loop-hold.ts": {
		silent: 2,
		identities: "255f028624add8ac",
		reason: PRE_RULE,
	}, // :214, :240
	"clients/extension-log.ts": {
		silent: 3,
		identities: "e34ce910fdd5a6f2",
		reason: PRE_RULE,
	}, // :399, :409, :491
	"clients/extension-mode.ts": {
		silent: 1,
		identities: "ef68f1432659cf3b",
		reason: PRE_RULE,
	}, // :55
	"clients/file-mutation-queue.ts": {
		silent: 2,
		identities: "c27b672b48b38606",
		reason: PRE_RULE,
	}, // :104, :141
	"clients/file-time.ts": {
		silent: 2,
		identities: "cef7af043e4732be",
		reason: PRE_RULE,
	}, // :148, :202
	"clients/file-utils.ts": {
		silent: 11,
		identities: "0cb7a41f4e5a5a7a",
		reason: PRE_RULE,
	}, // :265, :285, :303, :307, :310, :362, :437, :863, :1223, :1504, :1535 (#4689 r4: dataDirCanonicalRoot's realpath-probe arm now returns the identity root; the adoption's handlers declare their none)
	"clients/fix-run-restore.ts": {
		silent: 10,
		identities: "24b4689d533166d4",
		reason: PRE_RULE,
	}, // :286, :355, :628, :641, :707, :741, :752, :763, :813, :865
	"clients/fix-worklog.ts": {
		silent: 3,
		identities: "ee7debb7350474e6",
		reason: PRE_RULE,
	}, // :94, :111, :115
	"clients/format-service.ts": {
		silent: 1,
		identities: "f06cadecbefbe5c1",
		reason: PRE_RULE,
	}, // :245
	"clients/formatters.ts": {
		silent: 6,
		identities: "d6645cb458688fe5",
		reason: PRE_RULE,
	}, // :241, :262, :399, :876, :1923, :2523
	"clients/generated-artifacts.ts": {
		silent: 3,
		identities: "a7ec942c4a848e55",
		reason: PRE_RULE,
	}, // :312, :318, :345
	"clients/generation-lock.ts": {
		silent: 10,
		identities: "d0111a1585665525",
		reason: PRE_RULE,
	}, // :47, :57, :73, :117, :152, :192, :215, :243, :282, :310
	"clients/git-guard.ts": {
		silent: 3,
		identities: "20ed3070a07a59a4",
		reason: PRE_RULE,
	}, // :69, :908, :1432
	"clients/git-tracked-ignore.ts": {
		silent: 2,
		identities: "e03578ef6c8bfb42",
		reason: PRE_RULE,
	}, // :108, :205
	"clients/gitleaks-client.ts": {
		silent: 9,
		identities: "a84c4542ebcd6944",
		reason: PRE_RULE,
	}, // :158, :269, :287, :301, :323, :461, :470, :525, :592
	"clients/govulncheck-client.ts": {
		silent: 5,
		identities: "e7742f12d2580226",
		reason: PRE_RULE,
	}, // :124, :382, :535, :663, :706
	"clients/grammar-source.ts": {
		silent: 5,
		identities: "aad8433a62e60775",
		reason: PRE_RULE,
	}, // :312, :318, :407, :478, :605
	"clients/gzip-stage-write.ts": {
		silent: 4,
		identities: "c936f6edb9b0e58b",
		reason: PRE_RULE,
	}, // :186, :299, :367, :371
	"clients/hashline-anchor.ts": {
		silent: 2,
		identities: "516f1dcd20b2d537",
		reason: PRE_RULE,
	}, // :425, :443
	"clients/inline-blocker-dispositions.ts": {
		silent: 1,
		identities: "2af25a7d151017a8",
		reason: PRE_RULE,
	}, // :92
	"clients/install-diagnostics.ts": {
		silent: 2,
		identities: "077a81da84ea60c4",
		reason: PRE_RULE,
	}, // :63, :176
	"clients/installer/index.ts": {
		silent: 57,
		identities: "c856f1adb6cf7d52",
		reason: PRE_RULE,
	}, // :164, :201, :206, :216, :227, :240, :297, :2172, :2479, :2578, :2597, :2732, :2744, :2770, :3105, :3145, :3180, :3192, :3314, :3337, :3359, :3529, :3625, :3693, :3721, :3861, :3869, :4536, :4589, :4780, :4820, :5293, :5328, :5481, :5498, :5523, :5554, :5557, :5563, :5579, :5616, :5619, :5704, :5791, :5892, :5899, :6091, :6114, :6172, :6182, :6186, :6266, :6302, :6339, :6457, :6616, :6686
	"clients/installer/managed-tool-refresh.ts": {
		silent: 4,
		identities: "dbbc0961e686ccc4",
		reason: PRE_RULE,
	}, // :226, :235, :261, :468
	"clients/instance-reaper.ts": {
		silent: 18,
		identities: "89697257f4ce69e2",
		reason: PRE_RULE,
	}, // :364, :647, :653, :656, :679, :1367, :1374, :1494, :1567, :1626, :1631, :1655, :1671, :1775, :1798, :1819, :1822, :1852
	"clients/instance-registry-lock.ts": {
		silent: 3,
		identities: "adf0229e77f6e200",
		reason: PRE_RULE,
	}, // :59, :70, :81
	"clients/instance-registry-tail.ts": {
		silent: 1,
		identities: "8c6a80350bd7ac81",
		reason: PRE_RULE,
	}, // :58
	"clients/instance-registry.ts": {
		silent: 5,
		identities: "7aaac59bf92966d2",
		reason: PRE_RULE,
	}, // :294, :313, :333, :365, :1509
	"clients/io-bridge.ts": {
		silent: 5,
		identities: "3a48a5c9fd94e52d",
		reason: PRE_RULE,
	}, // :362, :477, :521, :528, :611
	"clients/jscpd-client.ts": {
		silent: 5,
		identities: "3950a10dc006ea1a",
		reason: PRE_RULE,
	}, // :107, :118, :507, :513, :571
	"clients/json-cache-read.ts": {
		silent: 4,
		identities: "83a11b3167dae771",
		reason: PRE_RULE,
	}, // :41, :44, :64, :67
	"clients/knip-client.ts": {
		silent: 8,
		identities: "6481d65af921cbbb",
		reason: PRE_RULE,
	}, // :144, :204, :271, :631, :714, :880, :890, :1070
	"clients/language-profile.ts": {
		silent: 2,
		identities: "c893d59f9960490a",
		reason: PRE_RULE,
	}, // :161, :219
	"clients/ledger-bounds.ts": {
		silent: 1,
		identities: "4fc0d0d55f04d765",
		reason: PRE_RULE,
	}, // :42
	"clients/lens-config.ts": {
		silent: 1,
		identities: "d1cd5dba9c378655",
		reason: PRE_RULE,
	}, // :500
	"clients/log-cleanup.ts": {
		silent: 6,
		identities: "a96b760c3e0e1558",
		reason: PRE_RULE,
	}, // :73, :117, :126, :160, :165, :199
	"clients/lsp-budget.ts": {
		silent: 1,
		identities: "288709348a380874",
		reason: PRE_RULE,
	}, // :264
	"clients/lsp-document-symbols.ts": {
		silent: 1,
		identities: "cf08efebeaedf178",
		reason: PRE_RULE,
	}, // :62
	"clients/lsp-mutation.ts": {
		silent: 3,
		identities: "49f289e5cda4ab92",
		reason: PRE_RULE,
	}, // :393, :482, :524
	"clients/lsp/aggregation.ts": {
		silent: 1,
		identities: "6c214f59992042fc",
		reason: PRE_RULE,
	}, // :225
	"clients/lsp/cascade-tier.ts": {
		silent: 1,
		identities: "88f5e75517393215",
		reason: PRE_RULE,
	}, // :342
	"clients/lsp/client-registry.ts": {
		silent: 8,
		identities: "456576ded8218555",
		reason: PRE_RULE,
	}, // :483, :777, :767, :818, :1034, :1369, :1466, :1782
	"clients/lsp/client.ts": {
		silent: 35,
		identities: "cdb169f677809664",
		reason: PRE_RULE,
	}, // :1559, :1617, :1680, :1687, :1775, :3444, :3712, :4105, :4198, :4222, :4268, :4957, :5150, :5350, :5575, :5748, :5815, :5829, :5932, :5982, :6116, :6137, :6259, :6269, :6358, :6431, :6573, :7718, :7721, :7735, :7821, :8104, :8116, :8125, :8139
	"clients/lsp/config.ts": {
		silent: 1,
		identities: "2d7a194222ea5fe3",
		reason: PRE_RULE,
	}, // :984
	"clients/lsp/created-import-targets.ts": {
		silent: 2,
		identities: "48f09842fe4581c6",
		reason: PRE_RULE,
	}, // :118, :174
	"clients/lsp/diagnostic-binding.ts": {
		silent: 2,
		identities: "543891de73d83525",
		reason: PRE_RULE,
	}, // :620, :634
	"clients/lsp/document-drift.ts": {
		silent: 5,
		identities: "c63189f325c29fda",
		reason: PRE_RULE,
	}, // :537, :619, :634, :684, :712
	"clients/lsp/edits.ts": {
		silent: 3,
		identities: "09a1a8f35510f0a5",
		reason: PRE_RULE,
	}, // :1023, :1055, :1103
	// 42, re-pinned (#3734 r3): the willRenameFiles catch in `renameFile`
	// (:7890) now returns its own failed flag; no handler added or removed.
	"clients/lsp/index.ts": {
		silent: 42,
		identities: "375f1ae9e0f9bc6e",
		reason: SHARP_DID_SAVE,
	}, // :239, :356, :385, :1161, :1761, :2018, :2316, :2350, :2586, :2759, :2878, :3607, :3667, :3701, :4134, :4713, :4963, :5092, :5155, :5166, :5212, :5301, :5326, :5351, :5645, :5708, :6063, :6087, :6252, :6329, :6348, :7890, :8475, :8707, :8775, :8897, :8991, :9051, :9288, :9415, :9788, :9839
	"clients/lsp/jvm-runtime.ts": {
		silent: 1,
		identities: "53f0ed4e5a760b9e",
		reason: PRE_RULE,
	}, // :65
	"clients/lsp/launch.ts": {
		silent: 9,
		identities: "eca31a5fa3dd4517",
		reason: PRE_RULE,
	}, // :105, :295, :406, :753, :759, :1012, :1237, :1248, :1259
	"clients/lsp/lombok.ts": {
		silent: 6,
		identities: "a076d98b1826881f",
		reason: PRE_RULE,
	}, // :18, :28, :81, :100, :124, :132
	"clients/lsp/ruby-drive-dirs.ts": {
		silent: 2,
		identities: "143b096dfc935397",
		reason: PRE_RULE,
	}, // :57, :79
	"clients/lsp/server.ts": {
		silent: 28,
		identities: "8d1137f64482cd05",
		reason: PRE_RULE,
	}, // :185, :335, :759, :790, :1019, :1219, :1352, :1484, :1673, :1754, :1776, :2086, :2165, :2180, :2194, :2211, :2229, :2261, :2288, :2301, :2379, :2391, :2412, :2433, :2625, :2633, :2663, :3201
	"clients/lsp/service-singleton.ts": {
		silent: 1,
		identities: "f88b642322d541aa",
		reason: PRE_RULE,
	}, // :50
	"clients/lsp/tsserver-sync.ts": {
		silent: 2,
		identities: "e03578ef6c8bfb42",
		reason: PRE_RULE,
	}, // :308, :446
	"clients/lsp/wait-policy/strategies.ts": {
		silent: 1,
		identities: "cf08efebeaedf178",
		reason: PRE_RULE,
	}, // :73
	"clients/lsp/workspace-diagnostics-cache.ts": {
		silent: 5,
		identities: "1ee0daee82463bab",
		reason: PRE_RULE,
	}, // :370, :531, :548, :565, :1119
	"clients/lsp/workspace-sweep-hold.ts": {
		silent: 1,
		identities: "8e09f7f1ce000f9b",
		reason: PRE_RULE,
	}, // :79
	"clients/mcp/analyze.ts": {
		silent: 5,
		identities: "ee5f67578ae6d3bb",
		reason: PRE_RULE,
	}, // :485, :503, :600, :618, :660
	"clients/mcp/ipc.ts": {
		silent: 6,
		identities: "9306ee39e70c73ca",
		reason: PRE_RULE,
	}, // :207, :382, :630, :696, :743, :922
	"clients/mcp/review.ts": {
		silent: 3,
		identities: "fd3a6c2269932b0b",
		reason: PRE_RULE,
	}, // :77, :124, :149
	"clients/mcp/session.ts": {
		silent: 1,
		identities: "7a22e287f518528b",
		reason: PRE_RULE,
	}, // :320
	"clients/memory-sampler.ts": {
		silent: 2,
		identities: "f46e7245193d13fa",
		reason: PRE_RULE,
	}, // :77, :387
	"clients/metrics-history.ts": {
		silent: 1,
		identities: "27637aebe860adac",
		reason: PRE_RULE,
	}, // :112
	"clients/module-report-lsp.ts": {
		silent: 3,
		identities: "2482911206cf896e",
		reason: PRE_RULE,
	}, // :135, :184, :191
	"clients/module-report.ts": {
		silent: 5,
		identities: "c5963dbdc097fc3c",
		reason: PRE_RULE,
	}, // :552, :1915, :1979, :2498, :2780
	"clients/mutation-attribution.ts": {
		silent: 2,
		identities: "ea2c0a9a5c5916ae",
		reason: PRE_RULE,
	}, // :227, :442
	"clients/mutation-bridge.ts": {
		silent: 2,
		identities: "f705c60981bbbd4f",
		reason: PRE_RULE,
	}, // :594, :624
	"clients/ndjson-logger.ts": {
		silent: 12,
		identities: "6a046743eeec075d",
		reason: PRE_RULE,
	}, // :64, :479, :486, :605, :632, :675, :694, :822, :829, :880, :888, :1001
	"clients/observed-mutation-sources.ts": {
		silent: 4,
		identities: "9a038c965abee7e9",
		reason: PRE_RULE,
	}, // :63, :68, :74, :99
	"clients/observed-mutation.ts": {
		silent: 8,
		identities: "8146e349abd731ab",
		reason: PRE_RULE,
	}, // :459, :581, :633, :978, :1318, :1356, :1424, :1430
	"clients/opaque-mutation-scan.ts": {
		silent: 3,
		identities: "4fe1dce4f3ce2aa7",
		reason: PRE_RULE,
	}, // :224, :257, :843
	"clients/opengrep-client.ts": {
		silent: 3,
		identities: "2062917950cbdb52",
		reason: PRE_RULE,
	}, // :291, :328, :387
	"clients/out-of-band-changes.ts": {
		silent: 3,
		identities: "ec722a49db9a4818",
		reason: SHARP_INSTALL_STAMP,
	}, // :146, :177, :264
	"clients/package-manager.ts": {
		silent: 2,
		identities: "56b6f18636fed761",
		reason: PRE_RULE,
	}, // :113, :468
	"clients/partial-edit-apply.ts": {
		silent: 3,
		identities: "9457f6c639682a54",
		reason: PRE_RULE,
	}, // :304, :457, :477
	"clients/path-birth.ts": {
		silent: 1,
		identities: "b47f07ef1f3c61f0",
		reason: PRE_RULE,
	}, // :97
	"clients/path-utils.ts": {
		silent: 8,
		identities: "a67f7f2c5485dc04",
		reason: PRE_RULE,
	}, // :300, :311, :317, :468, :491, :760, :1283, :1539 (9 -> 8, #4689: the identity walk's catch is a `none:` line)
	"clients/performance-report.ts": {
		silent: 3,
		identities: "9285fe879a302231",
		reason: PRE_RULE,
	}, // :356, :372, :376
	"clients/persistent-reverify.ts": {
		silent: 3,
		identities: "ece0384b1c5b417a",
		reason: PRE_RULE,
	}, // :130, :204, :233
	"clients/pipeline.ts": {
		silent: 10,
		identities: "c6617487a0244394",
		reason: PRE_RULE,
	}, // :194, :216, :877, :1520, :1550, :1621, :1847, :2203, :2357, :2767
	"clients/probe-home-state.ts": {
		silent: 1,
		identities: "0c038fd772637ccb",
		reason: PRE_RULE,
	}, // :281
	"clients/process-snapshot.ts": {
		silent: 1,
		identities: "d86d2439be475af1",
		reason: PRE_RULE,
	}, // :107
	"clients/project-changes.ts": {
		silent: 4,
		identities: "02163780b39ee183",
		reason: PRE_RULE,
	}, // :79, :120, :144, :334
	"clients/project-conventions.ts": {
		silent: 5,
		identities: "a76659ea40c745ae",
		reason: PRE_RULE,
	}, // :36, :53, :63, :170, :181
	"clients/project-diagnostics/cache.ts": {
		silent: 2,
		identities: "9b85b4f2c95abd54",
		reason: PRE_RULE,
	}, // :118, :137
	"clients/project-diagnostics/fresh-fetch.ts": {
		silent: 1,
		identities: "20c1896f3065b063",
		reason: PRE_RULE,
	}, // :967
	"clients/project-diagnostics/scanner.ts": {
		silent: 6,
		identities: "41c098710d199d8d",
		reason: PRE_RULE,
	}, // :243, :262, :290, :320, :344, :383
	"clients/project-lens-config.ts": {
		silent: 2,
		identities: "f735901d17f7af70",
		reason: PRE_RULE,
	}, // :503, :511
	"clients/project-report.ts": {
		silent: 3,
		identities: "7b7b4a6060f610aa",
		reason: PRE_RULE,
	}, // :795, :828, :840
	"clients/project-snapshot-persist-worker.ts": {
		silent: 1,
		identities: "f21a4197b0781a28",
		reason: PRE_RULE,
	}, // :67
	"clients/project-snapshot.ts": {
		silent: 15,
		identities: "8f598baa5563de5d",
		reason: PRE_RULE,
	}, // :520, :532, :573, :701, :1085, :1430, :1460, :1907, :1970, :2007, :2043, :2049, :2083, :2551, :2588
	"clients/python-environment.ts": {
		silent: 2,
		identities: "dcac541cf34d63cd",
		reason: PRE_RULE,
	}, // :86, :338
	"clients/quiet-window.ts": {
		silent: 2,
		identities: "2c704faa2d7cb264",
		reason: PRE_RULE,
	}, // :176, :305
	"clients/read-expansion.ts": {
		silent: 1,
		identities: "cf08efebeaedf178",
		reason: PRE_RULE,
	}, // :345
	"clients/read-guard-branch.ts": {
		silent: 3,
		identities: "2920b445679fa702",
		reason: PRE_RULE,
	}, // :76, :101, :104
	"clients/read-guard-tool-lines.ts": {
		silent: 1,
		identities: "cf08efebeaedf178",
		reason: PRE_RULE,
	}, // :1085
	"clients/read-guard.ts": {
		silent: 11,
		identities: "8047974a7b2f7154",
		reason: PRE_RULE,
	}, // :298, :370, :382, :552, :569, :847, :910, :1926, :2578, :2607, :2832
	"clients/recent-touches.ts": {
		silent: 6,
		identities: "775f4885df22095e",
		reason: PRE_RULE,
	}, // :96, :111, :182, :225, :278, :308
	"clients/resource-sampler.ts": {
		silent: 5,
		identities: "a6c6697ae310d788",
		reason: PRE_RULE,
	}, // :346, :503, :660, :713, :722
	"clients/reverse-deps.ts": {
		silent: 2,
		identities: "9cf67dc750bc40cb",
		reason: PRE_RULE,
	}, // :306, :343
	"clients/review-graph/builder.ts": {
		silent: 19,
		identities: "c13466bb5df2c24b",
		reason: PRE_RULE,
	}, // :1254, :1303, :1399, :1989, :2019, :2025, :2040, :2046, :2138, :2503, :2601, :2727, :2769, :3200, :4676, :5529, :5608, :6031, :6363
	"clients/review-graph/git-identity.ts": {
		silent: 10,
		identities: "719b257b5989f9db",
		reason: PRE_RULE,
	}, // :67, :82, :107, :122, :137, :204, :217, :247, :261, :292
	"clients/review-graph/import-resolvers.ts": {
		silent: 5,
		identities: "11acf9263a41f8fa",
		reason: PRE_RULE,
	}, // :49, :57, :79, :243, :448
	"clients/review-graph/tsconfig-paths.ts": {
		silent: 6,
		identities: "66806015dc2b9e36",
		reason: PRE_RULE,
	}, // :84, :98, :139, :191, :230, :264
	"clients/review-graph/workspace-modules.ts": {
		silent: 11,
		identities: "cdada467484d42e5",
		reason: PRE_RULE,
	}, // :73, :100, :144, :226, :252, :266, :287, :299, :463, :498, :509
	"clients/ruff-client.ts": {
		silent: 2,
		identities: "bb937b302033da40",
		reason: PRE_RULE,
	}, // :182, :247
	"clients/runtime-agent-end.ts": {
		silent: 4,
		identities: "38ca64e7de6ced49",
		reason: PRE_RULE,
	}, // :604, :864, :880, :1030
	"clients/runtime-coordinator.ts": {
		silent: 4,
		identities: "4fdad997e8135617",
		reason: PRE_RULE,
	}, // :1027, :1085, :1531, :2909
	"clients/runtime-session.ts": {
		silent: 25,
		identities: "a7ef9ab6e86045e5",
		reason: PRE_RULE,
	}, // :385, :755, :803, :810, :896, :923, :971, :1005, :1007, :1032, :1062, :1195, :1246, :1389, :1986, :2560, :2592, :2695, :2766, :2771, :2837, :3025, :3355, :3369, :3442
	"clients/runtime-tool-call.ts": {
		silent: 11,
		identities: "9c12ec155c04701f",
		reason: PRE_RULE,
	}, // :286, :461, :485, :799, :960, :966, :1133, :1356, :1705, :1813, :1906
	"clients/runtime-tool-result.ts": {
		silent: 9,
		identities: "b34b5e082d0b70b8",
		reason: SHARP_TOOL_RESULT,
	}, // :399, :919, :1014, :1209, :1661, :2495, :2929, :3507, :3731
	"clients/runtime-turn.ts": {
		silent: 20,
		identities: "d3c52ebe36413a9f",
		reason: PRE_RULE,
	}, // :393, :413, :438, :696, :761, :773, :840, :1066, :3342, :3348, :3354, :4720, :4547, :4668, :4701, :4922, :5055, :5375, :5416, :5671
	"clients/safe-spawn.ts": {
		silent: 18,
		identities: "e64267868c7a0d5b",
		reason: PRE_RULE,
	}, // :192, :201, :229, :465, :511, :603, :660, :674, :677, :1157, :1397, :1866, :1936, :1966, :2012, :2045, :2192, :2249
	"clients/search-read-registration.ts": {
		silent: 1,
		identities: "a37a1b3a1638df7c",
		reason: PRE_RULE,
	}, // :101
	"clients/session-event-guard.ts": {
		silent: 5,
		identities: "ef873da4ad050442",
		reason: PRE_RULE,
	}, // :201, :249, :271, :293, :313
	"clients/session-lifecycle.ts": {
		silent: 2,
		identities: "d671efebf03f8ddc",
		reason: PRE_RULE,
	}, // :344, :388
	"clients/session-state-store.ts": {
		silent: 2,
		identities: "63f7bc4c66d21ffc",
		reason: PRE_RULE,
	}, // :104, :144
	"clients/sg-runner.ts": {
		silent: 5,
		identities: "c770a964abd6f1bd",
		reason: PRE_RULE,
	}, // :171, :579, :608, :904, :1108
	"clients/sgconfig.ts": {
		silent: 9,
		identities: "e709eb6e68b73320",
		reason: PRE_RULE,
	}, // :61, :144, :176, :212, :405, :424, :447, :476, :480
	"clients/single-flight.ts": {
		silent: 1,
		identities: "9b712a522f01e05f",
		reason: PRE_RULE,
	}, // :218
	"clients/slow-fs.ts": {
		silent: 2,
		identities: "9c38681ffe39b677",
		reason: PRE_RULE,
	}, // :87, :105
	"clients/smells-rollup.ts": {
		silent: 4,
		identities: "8a0a16dbf3b7b2e5",
		reason: PRE_RULE,
	}, // :101, :115, :120, :137
	"clients/source-walker.ts": {
		silent: 2,
		identities: "353a61a7a5f28c4e",
		reason: PRE_RULE,
	}, // :48, :73
	"clients/test-runner-client.ts": {
		silent: 16,
		identities: "06aea9d4bef19d77",
		reason: PRE_RULE,
	}, // :325, :734, :749, :1046, :1096, :1112, :1156, :1185, :1230, :1334, :1535, :1914, :1991, :2233, :3368, :3377
	"clients/test-runner-delivery.ts": {
		silent: 2,
		identities: "f4ada83f93d3b6b9",
		reason: PRE_RULE,
	}, // :319, :337
	"clients/todo-scanner.ts": {
		silent: 2,
		identities: "353a61a7a5f28c4e",
		reason: PRE_RULE,
	}, // :123, :130
	"clients/tool-agreement.ts": {
		silent: 5,
		identities: "18f6b0c1def027a3",
		reason: PRE_RULE,
	}, // :318, :498, :504, :571, :696
	"clients/tool-cwd.ts": {
		silent: 1,
		identities: "59e54af7696610f7",
		reason: PRE_RULE,
	}, // :162
	"clients/tool-policy.ts": {
		silent: 29,
		identities: "b5570d8af2930d78",
		reason: PRE_RULE,
	}, // :1969, :1985, :2009, :2047, :2099, :2111, :2127, :2142, :2149, :2163, :2180, :2194, :2201, :2219, :2226, :2240, :2260, :2273, :2284, :2301, :2822, :2878, :2904, :2924, :2960, :3019, :3036, :3055, :3063
	"clients/tool-render.ts": {
		silent: 2,
		identities: "bf1a83100ccaa695",
		reason: PRE_RULE,
	}, // :103, :167
	"clients/tree-sitter-cache.ts": {
		silent: 2,
		identities: "e5a49d8cff6be1f2",
		reason: PRE_RULE,
	}, // :238, :406
	"clients/tree-sitter-client.ts": {
		silent: 29,
		identities: "3871ef6d8dab7e4c",
		reason: PRE_RULE,
	}, // :310, :325, :1017, :1073, :1101, :1117, :1365, :1492, :1906, :2162, :2186, :2314, :2493, :2659, :2699, :2906, :2956, :3807, :3824, :3834, :3853, :3880, :3905, :3956, :4000, :4012, :4075, :5405, :5450
	"clients/tree-sitter-query-loader.ts": {
		silent: 3,
		identities: "849c788bdb73aed7",
		reason: PRE_RULE,
	}, // :261, :269, :286
	"clients/tree-sitter-symbol-extractor.ts": {
		silent: 1,
		identities: "415996e0098221e7",
		reason: PRE_RULE,
	}, // :848
	"clients/trivy-client.ts": {
		silent: 8,
		identities: "184de0f9f29457b3",
		reason: PRE_RULE,
	}, // :165, :186, :220, :403, :412, :442, :496, :539
	"clients/tui-fit.ts": {
		silent: 1,
		identities: "bdb9736abc0aae9d",
		reason: PRE_RULE,
	}, // :37
	"clients/turn-end/delivery-holds.ts": {
		silent: 1,
		identities: "b28b485463e8a792",
		reason: PRE_RULE,
	}, // :141
	"clients/user-notify.ts": {
		silent: 1,
		identities: "05db28b791950627",
		reason: PRE_RULE,
	}, // :79
	"clients/vanished-instance-marker.ts": {
		silent: 1,
		identities: "785638035175ccc4",
		reason: PRE_RULE,
	}, // :74
	"clients/warm-attach.ts": {
		silent: 2,
		identities: "67b382837dbc5a58",
		reason: PRE_RULE,
	}, // :115, :245
	"clients/widget-state.ts": {
		silent: 3,
		identities: "0627f400a0b73f7f",
		reason: PRE_RULE,
	}, // :1503, :1655, :1898
	"clients/word-index.ts": {
		silent: 5,
		identities: "7d9f55557f569789",
		reason: PRE_RULE,
	}, // :846, :847, :1102, :1267, :1421
	"clients/workspace-topology.ts": {
		silent: 5,
		identities: "24eaf0e56c4d43a3",
		reason: PRE_RULE,
	}, // :196, :204, :228, :333, :572
	"index.ts": {
		silent: 49,
		identities: "b48916790863d67b",
		reason: SHARP_HOST,
	}, // :522, :673, :779, :783, :1118, :1141, :1454, :1604, :1761, :1780, :1789, :1832, :1899, :2143, :2154, :2187, :2238, :2268, :2401, :2453, :2543, :2571, :2644, :2745, :2757, :2814, :2820, :2946, :2970, :3047, :3222, :3270, :3369, :3495, :3527, :3603, :3777, :3854, :3959, :3992, :4079, :4116, :4131, :4158, :4193, :4204, :4537, :4544, :4877
	"mcp/analyze-cli.ts": {
		silent: 1,
		identities: "e823b8d7883207bc",
		reason: PRE_RULE,
	}, // :122
	"mcp/build-staleness.ts": {
		silent: 1,
		identities: "cf08efebeaedf178",
		reason: PRE_RULE,
	}, // :44
	"mcp/cli.ts": {
		silent: 2,
		identities: "04f5bd7ee1066cf3",
		reason: PRE_RULE,
	}, // :59, :170
	"mcp/server.ts": {
		silent: 9,
		identities: "e58e51e6b55e02fa",
		reason: PRE_RULE,
	}, // :210, :238, :293, :455, :490, :1629, :1632, :2057, :2100
	"mcp/worker.ts": {
		silent: 2,
		identities: "5798817de4e32a58",
		reason: PRE_RULE,
	}, // :49, :62
	"tools/ast-grep-outline.ts": {
		silent: 1,
		identities: "33a1990d59e82460",
		reason: PRE_RULE,
	}, // :158
	"tools/ast-grep-replace.ts": {
		silent: 1,
		identities: "048676a5706298a4",
		reason: PRE_RULE,
	}, // :198
	"tools/ast-grep-search.ts": {
		silent: 2,
		identities: "a2cf7c73ed7f3754",
		reason: PRE_RULE,
	}, // :517, :524
	"tools/lens-diagnostic-mark.ts": {
		silent: 6,
		identities: "1af53558e8a5be76",
		reason: PRE_RULE,
	}, // :110, :188, :222, :337, :387, :412
	"tools/lens-diagnostics.ts": {
		silent: 7,
		identities: "0939abd4809b0410",
		reason: PRE_RULE,
	}, // :254, :678, :879, :939, :1391, :1471, :2162
	"tools/lsp-diagnostics.ts": {
		silent: 10,
		identities: "2e5c32f96dcee285",
		reason: PRE_RULE,
	}, // :371, :405, :628, :861, :1026, :1084, :1184, :1405, :1452, :2477
	"tools/lsp-navigation.ts": {
		silent: 8,
		identities: "7d261d33eecee18f",
		reason: PRE_RULE,
	}, // :529, :739, :757, :1200, :1569, :1676, :1710, :1898
	"tools/lsp-structured-output.ts": {
		silent: 3,
		identities: "0460d5b535aef4a2",
		reason: PRE_RULE,
	}, // :129, :299, :315
	"tools/module-report.ts": {
		silent: 3,
		identities: "ab30e249637710b7",
		reason: PRE_RULE,
	}, // :146, :302, :462
	"tools/project-report.ts": {
		silent: 1,
		identities: "1a38c8d15d7f5a2f",
		reason: PRE_RULE,
	}, // :94
	"tools/render-compact.ts": {
		silent: 1,
		identities: "4a953c06bc009ed6",
		reason: PRE_RULE,
	}, // :489
	"tools/symbol-search.ts": {
		silent: 1,
		identities: "17d3c06b8822a983",
		reason: PRE_RULE,
	}, // :92
};

/**
 * The total, pinned separately from the rows so a row cannot be swapped for
 * another row's growth. 1,155 at the base commit; this change's records and
 * `none:` lines took it to 1,146. On the merge of `origin/master` (`d7f85d909`)
 * the every-path rule (#4603 review F1) reclassified 20 conditional records and
 * 7 conditional rethrows as `silent`, and reading `.then(ok, onRejected)` made
 * 25 more silent sites visible, so the merged population is 1,188 (1,143 under
 * the old rule on the same tree). #4530 routed the installer's raw starts,
 * the launcher's PATH walk and metrics-history's git probe through the spawn
 * seam, and the merged tree's population is 1,175. It moves only downward
 * from here.
 */
const PINNED_TOTAL = 1175;

interface Census {
	byFile: Map<string, CatchSite[]>;
	recorded: number;
	rethrows: number;
	declaredNone: number;
	silent: number;
	unclassified: Array<{ file: string; site: CatchSite }>;
	scannedFiles: number;
}

async function scanShippedTrees(): Promise<Census> {
	const files = [
		...SHIPPED_TREES.flatMap((dir) =>
			listSourceFiles(path.join(REPO_ROOT, dir), { skipTests: true }),
		),
		path.join(REPO_ROOT, "index.ts"),
	];
	const census: Census = {
		byFile: new Map(),
		recorded: 0,
		rethrows: 0,
		declaredNone: 0,
		silent: 0,
		unclassified: [],
		scannedFiles: 0,
	};
	for (const file of files) {
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		census.scannedFiles++;
		const rel = relativePosix(REPO_ROOT, file);
		for (const site of scanSilentCatches(source)) {
			if (site.verdict === "recorded") census.recorded++;
			else if (site.verdict === "rethrows") census.rethrows++;
			else if (site.verdict === "declared-none") census.declaredNone++;
			else if (site.verdict === "unclassified")
				census.unclassified.push({ file: rel, site });
			else {
				census.silent++;
				const sites = census.byFile.get(rel) ?? [];
				sites.push(site);
				census.byFile.set(rel, sites);
			}
		}
		// #4736: turn the event loop between files. `@ast-grep/napi` frees a
		// dropped tree's native arena from a finalizer that only runs once the
		// loop turns, so the synchronous walk held every one of the ~530 parsed
		// trees at once (1,902 MB peak RSS against 44 MB of V8 heap, 4% under
		// the #3058 budget). One turn per file brings the peak to ~340 MB with
		// the same finding list (the same fix `vi-mock-export-sweep.test.ts`
		// and `flake-shape-scan.ts` took, #3565).
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return census;
}

const census = await scanShippedTrees();
const printPins = process.env.PI_LENS_PRINT_PINS === "1";

function sortedByFile<T>(entries: Iterable<[string, T]>): Array<[string, T]> {
	return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The sorted per-handler identities, with `#2` for an identical repeat. */
function identityList(sites: ReadonlyArray<CatchSite>): string[] {
	const counts = new Map<string, number>();
	for (const site of sites)
		counts.set(site.identity, (counts.get(site.identity) ?? 0) + 1);
	const listed: string[] = [];
	for (const [identity, count] of [...counts].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		listed.push(identity);
		for (let repeat = 2; repeat <= count; repeat += 1)
			listed.push(`${identity}#${repeat}`);
	}
	return listed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The admitted set's content identity: 16 hex over the sorted handler ids. */
function identityDigest(sites: ReadonlyArray<CatchSite>): string {
	return createHash("sha256")
		.update(identityList(sites).join("\n"))
		.digest("hex")
		.slice(0, 16);
}

/** One pasteable `"file": { silent: n, identities: …, reason: … },` line. */
function pins(c: Census): string[] {
	return sortedByFile(c.byFile).map(([file, sites]) => {
		const lines = sites.map((site) => `:${site.line}`).join(", ");
		return `\t"${file}": { silent: ${sites.length}, identities: "${identityDigest(sites)}", reason: PRE_RULE }, // ${lines}`;
	});
}

interface Audit {
	unlisted: string[];
	mismatched: string[];
	dead: string[];
	unreasoned: string[];
	overTotal: boolean;
}

/**
 * The census against the pins, as one pure verdict so each branch has its own
 * case below. `baseline` and `total` are arguments, not the constants, so a
 * fixture can plant the exact violation a branch exists to catch.
 */
function auditSilentCatches(
	c: Census,
	baseline: Readonly<Record<string, Admission>> = BASELINE,
	total = PINNED_TOTAL,
): Audit {
	const unlisted: string[] = [];
	const mismatched: string[] = [];
	for (const [file, sites] of sortedByFile(c.byFile)) {
		const allowed = baseline[file];
		const detail = sites
			.map((site) => `:${site.line} ${site.snippet}`)
			.join(" | ");
		if (!allowed) {
			unlisted.push(`${file}: ${sites.length} silent (${detail})`);
			continue;
		}
		const digest = identityDigest(sites);
		if (allowed.silent !== sites.length || allowed.identities !== digest)
			mismatched.push(
				`${file}: pinned ${allowed.silent} [${allowed.identities}], found ${sites.length} [${digest}] (${detail})`,
			);
	}
	return {
		unlisted,
		mismatched,
		dead: Object.keys(baseline)
			.filter((file) => !c.byFile.has(file))
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		unreasoned: Object.entries(baseline)
			.filter(([, admission]) => admission.reason.trim().length < 40)
			.map(([file]) => file)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		overTotal: c.silent > total,
	};
}

/** A census holding one silent handler per named file, for the branch cases. */
function censusOf(
	files: Record<string, number>,
	/* the audit reads only `byFile` and the silent total */
): Census {
	const byFile = new Map<string, CatchSite[]>();
	let silent = 0;
	for (const [file, count] of Object.entries(files)) {
		byFile.set(
			file,
			Array.from({ length: count }, (_, index) => ({
				line: index + 1,
				form: "catch-clause" as const,
				verdict: "silent" as const,
				records: [],
				snippet: "{}",
				identity: `site${index + 1}`,
			})),
		);
		silent += count;
	}
	return {
		byFile,
		recorded: 0,
		rethrows: 0,
		declaredNone: 0,
		silent,
		unclassified: [],
		scannedFiles: 1,
	};
}

/** The admission a one-handler fixture file gets, with its own identity. */
function admitted(count = 1): Admission {
	const sites = Array.from({ length: count }, (_, index) => ({
		identity: `site${index + 1}`,
	})) as CatchSite[];
	return {
		silent: count,
		identities: identityDigest(sites),
		reason: PRE_RULE,
	};
}

const ADMITTED: Admission = admitted();

describe("silent-catch sweep", () => {
	it("scans the shipped trees", () => {
		assertNonEmptyScan("silent-catch sweep", census.scannedFiles, 300);
	});

	// Recurrence (#4736): the walk parsed ~530 files in one synchronous loop, so
	// `@ast-grep/napi` kept every native tree until the file ended and the
	// worker peaked at 1,902 MB, 4% under the 2,048 MB budget (#3058); +0.34% of
	// source (#4713) crossed it and redded Unit shard 2/5. With the loop turned
	// per file the peak is ~340 MB. This ceiling is the issue's acceptance bar
	// and sits 1,000 MB above the fixed peak, below the first red, so growth
	// of the source cannot walk the sweep back to the budget unseen.
	// The ceiling check belongs to the peak-RSS seam, which enforces on linux
	// only (darwin's `ru_maxrss` is bytes): this case asks it instead of
	// dividing `maxRSS` itself.
	it("holds the walk's peak RSS under 1,600 MB (#4736)", () => {
		expect(() =>
			reportPeakRss({
				file: "tests/config/silent-catch-sweep.test.ts",
				peakRssMb: currentPeakRssMb(),
				heapUsedMb: 0,
				externalMb: 0,
				write: () => {},
				ceilingMb: 1600,
			}),
		).not.toThrow();
	});

	it("pins existing unresolved delegations and refuses every new one", () => {
		expect(
			census.unclassified.map(({ file, site }) => `${file}:${site.identity}`),
		).toEqual([
			// Pre-#4596 delegation sites, formerly silent: reject/release is
			// supplied by another owner. Exact identities admit no new site.
			"clients/file-mutation-queue.ts:02b17661",
			"clients/file-mutation-queue.ts:1e574bad",
			"clients/lsp/index.ts:5c031860",
			"clients/mcp/session.ts:b686230d",
			"clients/runtime-tool-result.ts:ed3d6e88",
			"clients/runtime-tool-result.ts:6e0f90a7",
			"clients/runtime-tool-result.ts:ed3d6e88",
		]);
	});

	it("derives the verdicts this sweep claims to distinguish", () => {
		// Floors, not constants: the point is that every detector still finds a
		// population, so a broken seam regex, rethrow reader or `none:` reader
		// reds here instead of quietly reclassifying the tree.
		assertNonEmptyScan("recorded handlers", census.recorded, 100);
		assertNonEmptyScan("rethrow-only handlers", census.rethrows, 1);
		assertNonEmptyScan("declared-none handlers", census.declaredNone, 1);
	});

	it("admits no silent handler outside the pinned population", () => {
		const audit = auditSilentCatches(census);
		expect({ unlisted: audit.unlisted, mismatched: audit.mismatched }).toEqual({
			unlisted: [],
			mismatched: [],
		});
	});

	it("keeps every pinned row alive and every admission reasoned", () => {
		const audit = auditSilentCatches(census);
		expect({ dead: audit.dead, unreasoned: audit.unreasoned }).toEqual({
			dead: [],
			unreasoned: [],
		});
	});

	it("holds the pinned total, which only shrinks", () => {
		// A row deleted while another grew keeps the per-file check honest only if
		// the total is also pinned: this is the one number a reviewer reads.
		expect(auditSilentCatches(census).overTotal).toBe(false);
		expect(census.byFile.size).toBe(Object.keys(BASELINE).length);
	});

	it("prints the census a future round re-derives", () => {
		const report = {
			scannedFiles: census.scannedFiles,
			recorded: census.recorded,
			rethrows: census.rethrows,
			declaredNone: census.declaredNone,
			silent: census.silent,
			files: census.byFile.size,
			unclassified: census.unclassified.length,
		};
		if (printPins)
			console.log(`${JSON.stringify(report)}\n${pins(census).join("\n")}`);
		expect(report.silent).toBeLessThanOrEqual(PINNED_TOTAL);
	});
});

/** One case per branch of {@link auditSilentCatches}, each planting its own
 *  violation: a branch nothing can red is a branch that does not guard. */
describe("the audit's own branches", () => {
	it("names a silent handler in a file no row admits", () => {
		const audit = auditSilentCatches(
			censusOf({ "clients/new.ts": 2 }),
			{},
			100,
		);
		expect(audit.unlisted).toEqual([
			"clients/new.ts: 2 silent (:1 {} | :2 {})",
		]);
	});

	it("names a file whose silent count grew above its pin", () => {
		const audit = auditSilentCatches(
			censusOf({ "clients/old.ts": 3 }),
			{ "clients/old.ts": ADMITTED },
			100,
		);
		expect(audit.mismatched).toHaveLength(1);
		expect(audit.mismatched[0]).toContain("pinned 1 [");
		expect(audit.mismatched[0]).toContain("found 3 [");
	});

	it("names a file whose silent count fell below its pin", () => {
		const audit = auditSilentCatches(
			censusOf({ "clients/old.ts": 1 }),
			{ "clients/old.ts": admitted(2) },
			100,
		);
		expect(audit.mismatched).toHaveLength(1);
		expect(audit.mismatched[0]).toContain("pinned 2 [");
		expect(audit.mismatched[0]).toContain("found 1 [");
	});

	it("names a file whose handlers were swapped under a level count", () => {
		// #4603 F3: one new silent handler plus one removal (or the same count
		// after a `none:` line) keeps the count level, so the identity set is
		// the pin that reds. AGENTS.md shape 36: count-based laundering.
		const audit = auditSilentCatches(
			censusOf({ "clients/old.ts": 2 }),
			{ "clients/old.ts": admitted(2) },
			100,
		);
		expect(audit.mismatched).toEqual([]);

		const swapped = auditSilentCatches(
			censusWith({ "clients/old.ts": ["site1", "site3"] }),
			{ "clients/old.ts": admitted(2) },
			100,
		);
		expect(swapped.mismatched).toHaveLength(1);
		expect(swapped.mismatched[0]).toContain("pinned 2 [");
		expect(swapped.mismatched[0]).toContain("found 2 [");
	});

	it("names a pinned row with no silent handler left", () => {
		const audit = auditSilentCatches(
			censusOf({}),
			{ "clients/gone.ts": ADMITTED },
			100,
		);
		expect(audit.dead).toEqual(["clients/gone.ts"]);
	});

	it("names an admission with no stated reason", () => {
		const audit = auditSilentCatches(censusOf({ "clients/x.ts": 1 }), {
			"clients/x.ts": { ...admitted(), reason: "because" },
		});
		expect(audit.unreasoned).toEqual(["clients/x.ts"]);
	});

	it("flags a total above the pinned one", () => {
		expect(
			auditSilentCatches(
				censusOf({ "clients/x.ts": 2 }),
				{
					"clients/x.ts": admitted(2),
				},
				1,
			).overTotal,
		).toBe(true);
	});
});

/** A census naming each site's identity directly, for the laundering case. */
function censusWith(files: Record<string, string[]>): Census {
	const byFile = new Map<string, CatchSite[]>();
	let silent = 0;
	for (const [file, identities] of Object.entries(files)) {
		byFile.set(
			file,
			identities.map((identity, index) => ({
				line: index + 1,
				form: "catch-clause" as const,
				verdict: "silent" as const,
				records: [],
				snippet: "{}",
				identity,
			})),
		);
		silent += identities.length;
	}
	return {
		byFile,
		recorded: 0,
		rethrows: 0,
		declaredNone: 0,
		silent,
		unclassified: [],
		scannedFiles: 1,
	};
}
