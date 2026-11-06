/**
 * Incumbent LSP wait policy for attached sessions (#822).
 *
 * The incumbent process applies this policy on behalf of every attached
 * session. Keep this module free of session-local state: it must not import
 * runtime-session, runtime-turn, or warm-attach.
 *
 * Per-Server Diagnostic Strategies for pi-lens LSP
 *
 * Codifies known server behavior so timing decisions (debounce, retry budget,
 * first-push seeding) are automatic rather than one-size-fits-all.
 *
 * Env var overrides (PI_LENS_LSP_*) always take precedence over strategy values.
 */

import { createRequire } from "node:module";
import {
	isTsgoLaunchVariant,
	type LspLaunchVariant,
} from "../server-traits.js";

const _require = createRequire(import.meta.url);

/**
 * Platform/arch → `@ast-grep/cli-<platform>-<arch>[-msvc|-gnu]` native
 * package name, mirroring @ast-grep/cli's own `optionalDependencies` matrix
 * (checked directly against node_modules/@ast-grep/cli/package.json). Each
 * package ships the native `ast-grep`/`ast-grep.exe` binary at its package
 * root (no `bin/` subdir) — see node_modules/@ast-grep/cli-win32-x64-msvc/.
 */
function astGrepNativePackageName(
	platform: NodeJS.Platform,
	arch: string,
): string | undefined {
	// oxlint-disable-next-line typescript/switch-exhaustiveness-check -- ast-grep ships native packages only for win32, darwin and linux (the @ast-grep/cli optionalDependencies); every other platform returns undefined by design, and a case for each of the eight others would add eight `return undefined` lines with no decision behind them.
	switch (platform) {
		case "win32":
			if (arch === "x64") return "@ast-grep/cli-win32-x64-msvc";
			if (arch === "arm64") return "@ast-grep/cli-win32-arm64-msvc";
			if (arch === "ia32") return "@ast-grep/cli-win32-ia32-msvc";
			return undefined;
		case "darwin":
			if (arch === "arm64") return "@ast-grep/cli-darwin-arm64";
			if (arch === "x64") return "@ast-grep/cli-darwin-x64";
			return undefined;
		case "linux":
			if (arch === "x64") return "@ast-grep/cli-linux-x64-gnu";
			if (arch === "arm64") return "@ast-grep/cli-linux-arm64-gnu";
			return undefined;
		default:
			return undefined;
	}
}

/**
 * Resolve ast-grep's platform-native exe DIRECTLY, skipping the node-bin
 * wrapper (`ast-grep.cmd`/shim → node → cli.js → spawn native exe). One less
 * orphanable process layer (#472): a wrapper's direct child is the node/cmd
 * process, so on abnormal exit the actual ast-grep binary is a grandchild the
 * #234 teardown path never reaches — resolving straight to the native exe
 * means the LSP's direct child IS the real server.
 *
 * `require.resolve` is wrapped in try/catch (ESM-safe via createRequire, same
 * pattern as clients/deps/ast-grep-napi.ts) — returns undefined so the caller
 * falls back to the existing wrapper-based resolution when the platform
 * package isn't installed (it's an optionalDependency; native builds can be
 * absent on unsupported platforms/arches or a partial install).
 */
export function resolveAstGrepNativeExe(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string | undefined {
	const pkgName = astGrepNativePackageName(platform, arch);
	if (!pkgName) return undefined;
	const binaryName = platform === "win32" ? "ast-grep.exe" : "ast-grep";
	try {
		return _require.resolve(`${pkgName}/${binaryName}`);
	} catch {
		return undefined;
	}
}

export interface DiagnosticStrategy {
	/** Seed the push cache on the very first publishDiagnostics notification.
	 *  True for servers whose first push is known to be complete. */
	seedFirstPush: boolean;
	/** Maximum ms to spend retrying pull diagnostics when the first pull returns
	 *  empty. 0 = skip pull retry entirely, rely on push. */
	pullRetryBudgetMs: number;
	/** Debounce window for push diagnostics (ms). Applied in both the notification
	 *  handler and the waitForDiagnostics listener. */
	debounceMs: number;
	/** The aggregate timeout for waitForDiagnostics per this server (ms).
	 *  Overrides the global DIAGNOSTICS_AGGREGATE_WAIT_MS in the service layer. */
	aggregateWaitMs: number;
	/** Whether this server benefits from a second pull after an empty fast first
	 *  pull. TypeScript: no (rely on push). rust-analyzer: yes (incremental). */
	expectSemanticSecondPush: boolean;
	/** Re-sync a re-edited document with didClose+didOpen instead of didChange.
	 *  Default false (language servers re-analyze on didChange). True for scanners
	 *  that only re-scan on a fresh open — e.g. opengrep ignores didChange, so an
	 *  incremental sync silently yields zero findings on every edit-after-first. */
	reopenOnResync?: boolean;
	/** #3482: `textDocument/didSave` makes this server scan the document again
	 *  and publish once more, an answer to no send (opengrep@1a5fd9d
	 *  `Notification_handler.on_notification`: `DidSaveTextDocument` ->
	 *  `Scan_helpers.scan_file`). The client expects that publication. */
	rescansOnSave?: boolean;
	/** #4763: until this server sends `semgrep/rulesRefreshed`, an EMPTY publish
	 *  is not an answer. Opengrep with `--config auto` loads its rules after
	 *  `didOpen`; a scan before that logs "Rules not loaded yet, not scanning
	 *  anything" and publishes `[]` (opengrep@60ed3b3 `Scan_helpers.run_semgrep`
	 *  `when not session.cached_session.initialized`), then
	 *  `Scan_helpers.refresh_rules` sends `semgrep/rulesRefreshed` and
	 *  republishes every open document. Measured 3/3 on 1.30.0 and 2/2 on 1.32.0
	 *  (docs/lsp-capability-matrix.md, opengrep): `[]` at +10..20 ms, the
	 *  notification at +0.7..1.0 s, the findings 0.25..0.5 s later. The client
	 *  holds that `[]` (not cached, no stamp, no emit), so it can neither end the
	 *  wait nor read as "answered". With a local rule file the notification
	 *  arrives before the first publish and nothing is held. A non-empty publish
	 *  is a scan result and is never held. */
	emptyUntilRulesRefreshed?: boolean;
	/** #3548: `textDocument/didClose` makes this server publish once more, an
	 *  empty, version-less set that answers no send (tekumara/typos-lsp
	 *  `crates/typos-lsp/src/lsp.rs` `did_close`:
	 *  `self.client.publish_diagnostics(uri, Vec::new(), None).await` — sent
	 *  UNCONDITIONALLY on every close, to clear stale diagnostics on the
	 *  editor side, never as an answer to an outstanding scan). Without this
	 *  marker that publish is counted as a scan the closed lifetime was owed
	 *  (client.ts's `closedDocuments` branch), which can consume the slot a
	 *  REAL in-flight scan should consume: a rename that closes the path
	 *  while a scan is still running lets that close-publish satisfy the
	 *  backlog early, so the real (stale) scan lands later with nothing left
	 *  to distinguish it from a fresh answer to the reopened file's send
	 *  (#3548's failing sequence). Marked here, the client skips counting
	 *  exactly one publish per close for this server, leaving a genuine
	 *  backlog publish (from any server) to count as before. */
	publishesOnClose?: boolean;
	/**
	 * Tier-3 marker (#458): true only for a `mode: "push-only"` server that is
	 * known to publish NOTHING on a clean→clean transition (silent on clean —
	 * see docs/lsp-capability-matrix.md's `clean-behavior` column, measured by
	 * `scripts/probe-clean-signal.mjs`). Combined with the live capability
	 * snapshot's `mode === "push-only"`, this is what the cascade lane's tier
	 * gate (`clients/lsp/wait-policy/classification.ts`) uses to decide whether an in-lane
	 * diagnostic wait can be skipped and reconciled later at the quiet window
	 * instead. Undefined/false is the fail-safe default — a server not marked
	 * here always gets the full in-lane wait, same as before #458. Do NOT set
	 * this for `2*`/publishes-unversioned servers (opengrep, yaml, taplo, …):
	 * they DO resolve the wait early at runtime, just without a proven version,
	 * so shortening their in-lane wait would be a behavior change, not a no-op.
	 *
	 * #524/#529/#541/#558/#5348: this table is keyed by server ID, but
	 * "typescript" can launch as the classic typescript-language-server (what
	 * this flag was measured against), TS7's native `tsc --lsp --stdio`
	 * (PR #526) or `effect-tsgo` (#4914), which run the typescript-go server.
	 * The flag is CLASSIC-ONLY: `getStrategy` answers the typescript-go
	 * launches with `NATIVE_TS7_DIAGNOSTIC_STRATEGY` (`silentOnClean: false`)
	 * and `wait-policy/classification.ts` also refuses a native-ts7 snapshot.
	 * Native TS7 7.0.2 and `effect-tsgo` are PULL servers (`diagnosticProvider`
	 * advertised, `mode=pull`): `classifyServerWaitTier` returns before it reads
	 * this marker, so it does not apply to them whichever way it is set. The
	 * nightly `silent` readings for `typescript7` (2026-10-21 to 2026-11-06)
	 * were classic's data: the probe never ran the fixture's `setup`, so the
	 * registry launched the classic server (#5348). It stays unmarked for a
	 * push-only TS7 build, where silence on a clean file would not show that the
	 * server publishes a file's errors within the wait: the marker turns a
	 * lapsed wait into a confirmed clean.
	 */
	silentOnClean?: boolean;
	/**
	 * #3310 — the MEASURED first-publish class of a push server, the
	 * `first-publish` column of docs/lsp-capability-matrix.md.
	 *
	 * `"indexing"` means: this server answers `didOpen` with an EMPTY diagnostic
	 * set while its one-time whole-workspace index builds, and publishes again
	 * once indexing ends. Its first publish is therefore not an answer at all,
	 * and the publish handler holds it (see `setupIncomingHandlers` in
	 * clients/lsp/client.ts) instead of letting it resolve the push wait — the
	 * #3310 false clean, where `lsp_diagnostics` reported a php file with an
	 * undefined-variable error as "confirmed clean" because intelephense's
	 * empty pre-index publish ended the wait seconds before the real set
	 * arrived.
	 *
	 * Absent (the default, and every Tier 2/2\* server) means the first publish
	 * IS an answer: a server that publishes `[]` once for a genuinely clean file
	 * keeps resolving the wait on it with no added latency. That distinction is
	 * the whole difficulty of #3310's AC2, and it is why this is a measured
	 * class rather than a blanket "empty publishes are provisional" rule.
	 *
	 * Measured, never assumed: `scripts/probe-clean-signal.mjs` classifies the
	 * dirty-phase publish trace per server and writes the `first-publish`
	 * column; `tests/config/lsp-first-publish-census.test.ts` reds when that
	 * column and this marker disagree, which is the expiry check that keeps the
	 * class from going stale when a server's behavior changes.
	 *
	 * Mutually exclusive with `seedFirstPush` by construction — "the first push
	 * is complete" and "the first push is provisional" cannot both hold; the
	 * census pins that too.
	 */
	emptyFirstPublish?: "indexing";
	/**
	 * #3484 — the MEASURED order in which a push server that publishes WITHOUT
	 * a version answers a `textDocument/documentSymbol` request sent in the
	 * same tick as a content notification, relative to its publish for that new
	 * content.
	 *
	 * `"reply-first"` means the reply comes first, so the client may drop the
	 * path's version-less publishes until it (the diagnostics fence in
	 * clients/lsp/client.ts `armDiagnosticsFence`): anything published before
	 * the reply was computed before the server read the change.
	 *
	 * Absent (the default) means no fence. That is the only safe default: a
	 * server that publishes the new content BEFORE answering (docker-langserver,
	 * 2-3 ms after didChange, and it never republishes) would have its only
	 * fresh answer dropped. Versioned servers need no fence; their publishes are
	 * checked by version.
	 *
	 * Measured with a raw JSON-RPC session (didChange then documentSymbol in
	 * one write, then publish vs reply order), 2026-09-26, linux:
	 *   yaml-language-server  reply +3..6 ms, publish +207..242 ms  (3/3)
	 *   intelephense          reply +2..4 ms, publish +1005 ms      (3/3)
	 *   docker-langserver     publish +2..3 ms BEFORE reply +2..4 ms (3/3)
	 *   @prisma/language-server reply +5..7 ms, publish +6..10 ms  (23/23), a
	 *     1-4 ms margin, so it is NOT marked: an event-loop hiccup flips it.
	 * Not measured (no binary here): taplo, zls, dart, gleam, clojure-lsp.
	 */
	diagnosticsFence?: "reply-first";
	/**
	 * True for a push-only server whose value depends on a ONE-TIME whole-
	 * workspace index build rather than a per-file cost — e.g. marksman's
	 * cross-file link/anchor graph (#645). A full-tree sweep
	 * (`runWorkspaceDiagnostics`, the engine behind `lens_diagnostics
	 * mode=full`) fires a `didOpen` for every matching file in the project;
	 * without this flag every one of those touches independently pays the
	 * server's full `aggregateWaitMs` racing the SAME cold index build, so on
	 * a real project (34 markdown files in one dogfooded sweep) ALL of them
	 * time out — not because the server is slow per file, but because the
	 * one-time index cost gets charged once per file instead of once per
	 * sweep. When set, `runWorkspaceDiagnostics` pays the full
	 * `aggregateWaitMs` budget only for the FIRST file that touches this
	 * server in one sweep; every subsequent same-sweep touch to the same
	 * server uses `workspaceIndexingWarmWaitMs` instead (the index only needs
	 * to finish once). Undefined/false is the fail-safe default: every touch
	 * — sweep or not — keeps paying the full budget, identical to pre-#645
	 * behavior. Per-edit (non-sweep, `clientScope !== "all"`) touches are
	 * NEVER affected by this flag regardless of its value — the "first
	 * touch"/"warm touch" distinction only exists within one
	 * `runWorkspaceDiagnostics` call (see `createSweepIndexGate` in
	 * `clients/lsp/index.ts`), so a normal per-edit touch always resolves as
	 * a "first" touch and gets the full budget, matching this server's
	 * documented single-touch strategy exactly as before.
	 */
	workspaceIndexing?: boolean;
	/**
	 * Wait budget (ms) for a same-sweep touch to this server AFTER an earlier
	 * touch in the SAME `runWorkspaceDiagnostics` sweep already paid the full
	 * `aggregateWaitMs` cost. Only consulted when `workspaceIndexing` is
	 * true; ignored otherwise. Should be short — once the one-time workspace
	 * index has had a full `aggregateWaitMs` window to build, a per-file
	 * push-only server with a fast native parser (marksman) is expected to
	 * publish quickly, so this is a much smaller ceiling than
	 * `aggregateWaitMs`, not a second full wait. If a genuine timeout still
	 * occurs at this shorter budget the touch is still marked
	 * `diagnosticsTimedOut`/`inconclusive` exactly as before (#634's
	 * unconfirmed rendering is unaffected) — this only shrinks the wasted
	 * wait, it never changes the confirmed/unconfirmed contract.
	 */
	workspaceIndexingWarmWaitMs?: number;
}

/** @public — loaded by scripts/probe-clean-signal.mjs through a dynamic import wrapper knip cannot see. */
export const SERVER_DIAGNOSTIC_STRATEGIES: Record<string, DiagnosticStrategy> =
	{
		typescript: {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 50,
			aggregateWaitMs: 1000,
			expectSemanticSecondPush: false,
			// #4615: NO `emptyFirstPublish` marker. Measured 2026-10-20 over a raw
			// JSON-RPC wire against typescript-language-server@5.3.0 with
			// typescript@5.9.3: the DIRTY fixture's first publish already carries
			// the finding (code 2322) — `direct`, so holding it can only delay the
			// answer — and a CLEAN file's only publish is an EMPTY settled answer
			// (one publish, nothing after it, nothing on the edit). The hold
			// swallows that answer, so a first clean touch stays unconfirmed and
			// spends the full `aggregateWaitMs` budget for a verdict the server had
			// already sent. The `empty-first` this row used to carry was measured on
			// the `typescript-clean` fixture, whose publish trace was scoped by
			// server id alone while five live fixtures share "typescript": a foreign
			// client's late publish decided the class (#4615). The axis is defined on
			// a DIRTY file and docs/lsp-capability-matrix.md now records this row's
			// measured `direct`; a `clean: true` fixture can never be its source.
			// Tier 3 (#458): typescript-language-server publishes nothing on a
			// clean→clean edit (docs/lsp-capability-matrix.md, re-confirmed
			// 2026-07-12). It's the lone core-set tier-3 server, which is exactly
			// why the cascade lane's in-lane wait is worth skipping for it
			// specifically. Applies to the CLASSIC server only (#524/#529/#558/#5348)
			// — TS7's native `tsc --lsp --stdio` variant shares this
			// "typescript" server id; `getStrategy` answers it with
			// NATIVE_TS7_DIAGNOSTIC_STRATEGY and wait-policy/classification.ts's
			// classifier checks the live snapshot's launchVariant, so neither
			// applies this flag to a native-ts7 instance.
			silentOnClean: true,
		},
		"rust-analyzer": {
			seedFirstPush: false,
			pullRetryBudgetMs: 500,
			debounceMs: 150,
			aggregateWaitMs: 3000,
			expectSemanticSecondPush: true,
		},
		// PythonServer (pyright / basedpyright) — openFilesOnly mode: lazy per-file
		// analysis, startup similar to jedi. seedFirstPush: true because pyright's
		// first publishDiagnostics after didOpen is the complete result for that file.
		python: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 100,
			aggregateWaitMs: 1500,
			expectSemanticSecondPush: false,
		},
		// jedi-language-server is push-only (no pull diagnostics) and its FIRST
		// publishDiagnostics is the complete result (seedFirstPush). But that first
		// push lands just after didOpen+~1s on cold start (Python/parso import) —
		// measured ~1011ms — so a 1000ms aggregate budget misses it by a hair and
		// returns zero. 3000ms gives cold-start headroom without stalling the warm path.
		"python-jedi": {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 100,
			aggregateWaitMs: 3000,
			expectSemanticSecondPush: false,
		},
		eslint: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 200,
			aggregateWaitMs: 2000,
			expectSemanticSecondPush: false,
		},
		// Opengrep security scanner (cross-language LSP). It pushes an EMPTY result
		// during the one-time rule-load window at startup, then the real scan after
		// `semgrep/rulesRefreshed` — so never seed the first push, and hold that
		// empty publish (`emptyUntilRulesRefreshed`, #4763): without the hold it
		// ended the touch as "answered" and the findings arrived after the wait.
		// Push-only (no pull
		// diagnostics). Warm per-file scan ~1.3s; the first touch in a session may
		// also pay rule-load (~3.5s cold). aggregateWaitMs is 3500: it's this
		// server's OWN deadline, bounded by the per-edit caller cap as a ceiling
		// (#242), so on a 2500ms-capped edit opengrep waits min(2500, 3500)=2500
		// and on uncapped paths it gets its full 3500. 3500 covers warm and most
		// cold; a cold scan that overruns isn't lost — late diagnostics are cached
		// and surface on the next unchanged-content read through the content-bound
		// auxiliary carry-over path.
		opengrep: {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 250,
			aggregateWaitMs: 3500,
			expectSemanticSecondPush: false,
			// Opengrep re-scans only on a fresh didOpen — didChange is a no-op for it.
			reopenOnResync: true,
			rescansOnSave: true,
			emptyUntilRulesRefreshed: true,
		},
		// ast-grep structural linter (sgconfig-gated auxiliary LSP). Push-only,
		// compiles the project rules on the first scan of a session, and — like
		// Opengrep — is re-synced via didClose+didOpen so edits trigger a re-scan.
		// Conservative budget until measured against real projects (#239).
		// ast-grep re-scans on didChange (verified: toggling the violation count
		// 3→1→4→2 returns the correct fresh count each touch, with matching doc
		// versions), so reopen isn't needed and didChange is the lighter path.
		// aggregateWaitMs is 1800: its warm scan is ~1.3s, so 1000 was under-budgeted
		// (only masked before because the old with-auxiliary deadline was a global
		// max() floor; now each server has its own caller-cap-bounded deadline, #242,
		// so the budget must actually cover the scan).
		"ast-grep": {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 1800,
			expectSemanticSecondPush: false,
			reopenOnResync: false,
		},
		// zizmor (GitHub Actions security scanner, auxiliary LSP #272). Push-only
		// (no pull diagnostics). Its audit set is compiled-in — there's no rule-load
		// window like Opengrep — so the FIRST publishDiagnostics after didOpen IS the
		// complete result: seedFirstPush. It re-scans on didChange (FULL sync), so no
		// reopen-on-resync. A native single-workflow audit is sub-second offline;
		// online mode may add a GitHub-API round-trip, so 2000ms gives headroom
		// (bounded by the per-edit caller cap as a ceiling, #242), and any late online
		// finding can surface on the next unchanged-content read through the
		// content-bound auxiliary carry-over path.
		zizmor: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 2000,
			expectSemanticSecondPush: false,
			reopenOnResync: false,
			// #3548: zizmor@main `crates/zizmor/src/lsp.rs` `initialized()`
			// registers `textDocument/didSave` DYNAMICALLY (`include_text: true`),
			// and `did_save` re-audits and republishes with `version: None` — the
			// same surplus shape as opengrep's static save rescan (#3482). This is
			// presently INERT: `applyDynamicCapabilities` (client.ts) does not map
			// a dynamic didSave registration to anything, and `negotiateSaveOptions`
			// (sync-kind.ts) reads only the static `initialize` reply, so
			// `state.saveOptions` never gets set for zizmor and `sendDidSave` never
			// fires (its `if (!save) return;` guard). Set now anyway, measured
			// fact style (like `silentOnClean`'s launch-variant scoping above): the
			// day dynamic registration is honoured, this is the correct value with
			// no further plumbing, and `expectSaveRescan`/`rescansOnSave`'s
			// counting logic does not care how `saveOptions` got set — proven by
			// `ZIZMOR-SAVE-RESCAN-EXPECTED` in
			// tests/clients/lsp/late-auxiliary-findings.test.ts, which sets
			// `state.saveOptions` directly (the same shape as the pre-existing
			// `SAVE-RESCAN-EXPECTED` opengrep test) rather than through the
			// unbuilt dynamic-capability path.
			rescansOnSave: true,
		},
		// typos (source-code spell checker, auxiliary LSP #283). Push-only (no pull
		// diagnostics). Its dictionary is compiled in — there's NO rule-load window
		// like Opengrep — so the FIRST publishDiagnostics after didOpen IS the
		// complete result: seedFirstPush. It re-scans on didChange (FULL sync), so no
		// reopen-on-resync. A native single-file spell scan is sub-100ms, so the seed
		// arrives near-instantly; aggregateWaitMs is a generous ceiling (bounded by
		// the per-edit caller cap, #242) that the early seed resolves well under.
		typos: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 1500,
			expectSemanticSecondPush: false,
			reopenOnResync: false,
			// #3548: see `publishesOnClose`'s doc comment above — typos'
			// `did_close` always publishes an empty, version-less set.
			publishesOnClose: true,
		},
		// marksman (Markdown LSP, #274). Push-based; native binary so the per-file
		// parse is fast, but its value is CROSS-file (broken intra-repo links,
		// missing anchors/heading refs) which needs the workspace index — so the
		// first push after didOpen can be empty before indexing completes. Don't
		// seed it (like opengrep/rust-analyzer); a modest 1500ms aggregate covers
		// warm edits, and any late cross-file finding surfaces on the next touch.
		marksman: {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 1500,
			expectSemanticSecondPush: false,
			// #645: a full-tree sweep opens every markdown file, all racing the
			// SAME one-time workspace index build — pay the 1500ms budget once
			// per sweep (the first markdown file touched), not once per file.
			// 250ms covers a warm per-file publish (native binary, fast parse)
			// once the index has already had a full aggregateWaitMs window.
			workspaceIndexing: true,
			workspaceIndexingWarmWaitMs: 250,
			// #799 / run 35914033696: marksman is push-only and publishes NOTHING on
			// a clean transition — there is no pull fallback and no sync-confirm protocol (unlike
			// typescript's tsserver commands), so a clean markdown file's touch
			// waits its full budget with zero signal either way. Marking it
			// `silentOnClean` lets the generic push-only clean-confirm gate
			// (`touchFile`, the `classifyCascadeWaitTier`-driven fallback next to
			// the tsserver sync-confirm block) treat "no publish within budget,
			// notify succeeded" as CONFIRMED clean instead of inconclusive/timed
			// out — closing the observed 2x20s-per-sweep burn on clean markdown
			// (evidence: agents.md timed out at 20009ms/20014ms on both the
			// warm-up attempt and its retry, with zero diagnostics either time).
			silentOnClean: true,
		},
		// cue lsp serve (#1522, #1519, #1520). Measured directly against the real
		// v0.17.1 binary (`getWorkspaceDiagnosticsSupport` reports
		// `mode: "push-only"`; no pull support advertised).
		//
		// It reports load/parse (syntax) errors as you type, but leaves
		// conflicting-value/constraint-failure (evaluation) errors to `cue vet`
		// — the #1522 cue-vet auxiliary runner covers that gap. So the syntax
		// diagnostics this strategy governs are a REAL but PARTIAL signal, not
		// full CUE validation.
		//
		// The repaired clean-signal probe measured cue as publishing a versioned
		// clean-transition set (run 35914033696), so this marker stays absent:
		// the cascade must retain its normal early-publish path.
		//
		// seedFirstPush: true — the one cold-open case that DOES publish (a
		// file that is already broken) sends the complete single diagnostic on
		// its first push; there is no observed partial-then-complete sequence to
		// wait out.
		//
		// aggregateWaitMs: 2000 covers the measured warm edit-to-publish latency
		// (~930ms, syntax reparse) with margin; a cold spawn's first push (~2.1s
		// end-to-end including process start) is bounded separately by
		// maxClientWaitMs, not this per-diagnostics budget.
		// intelephense (php, #3310). Measured directly against the real v1.18.5
		// binary over a raw JSON-RPC session answering `workspace/configuration`
		// the way pi-lens does (2026-09-23, linux):
		//
		//   +284ms  initialize response — NO diagnosticProvider (push-only)
		//   +295ms  publishDiagnostics diags=0  version=undefined   <- pre-index
		//   +301ms  indexingStarted
		//   +689ms  indexingEnded
		//   +696ms  publishDiagnostics diags=2  version=undefined   <- the answer
		//
		// so `emptyFirstPublish: "indexing"`: the first publish is an artifact of
		// the cold index, not an answer. The same session on a genuinely CLEAN
		// file publishes `[]` at +304ms and `[]` AGAIN at +663ms (right after
		// `indexingEnded`), which is what lets the held publish be released by
		// the server's own second publish instead of by a timer — and a WARM
		// touch (a second file, index already built) publishes the real set
		// FIRST at +5ms, so the hold costs nothing once the session is warm.
		//
		// seedFirstPush: false — the measurement above is the direct refutation
		// of "the first push is complete" for this server.
		// pullRetryBudgetMs: 0 — no pull provider is advertised at all.
		// aggregateWaitMs: 8000 — the budget must cover the cold index window,
		// which is what the second (real) publish waits on: ~0.4s for a 139-file
		// index on the dev box, ~5s on the nightly ubuntu runner (#3217's
		// transcript). Per-edit callers cap this as a CEILING (#242), so an
		// interactive edit still waits only its own cap; the uncapped paths (the
		// tool-smoke LSP gate, which itself caps at 8000ms) get the full budget,
		// and the cold index is paid once per session, not once per touch.
		php: {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 8000,
			expectSemanticSecondPush: false,
			emptyFirstPublish: "indexing",
			// #3484: the fence reply (+2..4 ms) precedes the publish (~+1 s).
			diagnosticsFence: "reply-first",
		},
		// terraform-ls: NO `emptyFirstPublish` marker (#4615). The earlier
		// `empty-first` reading (2026-09-27..29, and the nightlies 2026-10-17..20)
		// came from a probe that counted terraform-ls's EMPTY set for the
		// WORKSPACE DIRECTORY URI. terraform-ls publishes that set in the same
		// ~1 ms burst as the file's own finding, and the probe's drainer kept rows
		// by server id only, so the directory row was read as the file's first
		// publish. Scoped to the fixture's own document, the first publish carries
		// the finding: `direct` (terraform-ls 0.39.0, 16/16 cold runs). The hold
		// was also a no-op for a dirty file: the one-shot hold is spent on the
		// directory row or an unrelated `.tf` file, never on the finding. On a
		// clean `.tf` file it could swallow the file's own `[]`, which costs a
		// wait to the ceiling (inferred from code, not probed).
		terraform: {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 1500,
			expectSemanticSecondPush: false,
		},
		// yaml-language-server (#3484): the default strategy plus the measured
		// fence order — reply +3..6 ms, publish +207..242 ms after didChange.
		yaml: {
			seedFirstPush: false,
			pullRetryBudgetMs: 250,
			debounceMs: 150,
			aggregateWaitMs: 1500,
			expectSemanticSecondPush: false,
			diagnosticsFence: "reply-first",
		},
		// Svelte's pull diagnostics settle after the default 1500ms budget on a
		// cold server. The tool-smoke gate caps waits at 8000ms, so give this
		// server enough aggregate budget to return its seeded findings (#3311).
		svelte: {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 4000,
			expectSemanticSecondPush: false,
		},
		// csharp-ls loads (design-time-builds) the restored project AFTER
		// `initialize` returns, so the publish for a seeded CS0029 lands inside
		// `waitForDiagnostics`, not inside the client wait. MEASURED A/B over two
		// nightly Tool-smoke runs of the same fixture with `dotnet restore` already
		// done — the ONLY difference between them was this budget:
		//   * `aggregateWaitMs` 1500 (the default): run 36054901266 →
		//     `[csharp] touched=0`, 4.05s after `Restored …/toolsmoke.csproj`.
		//     A real compiler error read as clean.
		//   * 8000: run 36058292424 → `[csharp] touched=1`, 6.49s after the same
		//     line; gate run 36059988117 → `lsp_diagnostics returned 1 primary
		//     finding`, 4.86s after it.
		// Both windows INCLUDE workspace bootstrap + spawn + initialize, so they
		// bound the wait from above: the required budget is in (1500, 4860] ms.
		// 6000 covers the measured gate window with margin and stays under the
		// tool-smoke gate's own 8000ms ceiling (that relation is pinned by
		// tests/config/lsp-gate-population.test.ts), so the gate can still witness
		// this budget. CONFIRMED at 6000 by run 36064829436: `✓ csharp csharp-ls 1
		// lsp_diagnostics returned 1 primary finding`, 4.78s after `Restored
		// …csproj`, census unchanged at gated 31 / handshake-only 8 / unavailable 6
		// — so 6000 is measured as sufficient, not merely inferred from the 8000
		// runs above. It is deliberately NOT the ceiling: an `lsp_diagnostics` call
		// that passes no `waitMs` pays this budget in full on a file the server never
		// publishes for (`tools/lsp-diagnostics.ts` leaves `maxClientWaitMs`
		// undefined → `perServerTimeout` has no caller cap), so every 1000ms here
		// is 1000ms of turn latency on the no-publication path (#3402 review r2).
		// Every other field is DEFAULT_STRATEGY's value on purpose: csharp-ls is
		// `mode=pull`/tier-1 authoritative-clean (#3311 investigator table), and
		// nothing has measured its pull retry, so this entry moves the one field
		// that was measured and no other (pinned in
		// tests/clients/lsp/server-strategies.test.ts).
		// fsharp/expert/vue deliberately have NO entry: the same two runs show
		// `touched=0` at BOTH 1500 and 8000, so the budget is not what stops them
		// publishing and an 8000 entry would buy nothing while costing every
		// uncapped production call 6.5 extra seconds. Their fixture rows carry the
		// observed-behavior exemption instead (`scripts/smoke-tools.mjs`), and a
		// probe that wants a long window sets `PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS`
		// — a flat harness override that needs no production budget.
		csharp: {
			seedFirstPush: false,
			pullRetryBudgetMs: 250,
			debounceMs: 150,
			aggregateWaitMs: 6000,
			expectSemanticSecondPush: false,
		},
		cue: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 2000,
			expectSemanticSecondPush: false,
			reopenOnResync: false,
		},
		// lua-language-server is push-only and was silent on clean transitions in
		// the repaired probe (run 35914033696). Keep the marker on the measured
		// server id so the cascade can skip its in-lane wait safely.
		lua: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 2000,
			expectSemanticSecondPush: false,
			silentOnClean: true,
		},
	};

/** Native TS7 can publish multiple versionless partial-program snapshots for a
 * single open. Its first push is therefore provisional; a quiet window, rather
 * than a protocol-unstable publication count, establishes the settled push. */
const NATIVE_TS7_DIAGNOSTIC_STRATEGY: DiagnosticStrategy = {
	...SERVER_DIAGNOSTIC_STRATEGIES.typescript,
	seedFirstPush: false,
	// #5348: the classic-only marker must not leak through the shared server id.
	// It turns a wait that lapses with no publish into a confirmed clean, and
	// nothing measures that a push-only TS7 build publishes a file's errors
	// inside the budget. Native TS7 7.0.2 and `effect-tsgo` (this strategy is
	// also its) are pull servers, so the marker is not read for them today (see
	// `silentOnClean`).
	silentOnClean: false,
};

/** Fallback for unknown servers. Conservative defaults. */
const DEFAULT_STRATEGY: DiagnosticStrategy = {
	seedFirstPush: false,
	pullRetryBudgetMs: 250,
	debounceMs: 150,
	aggregateWaitMs: 1500,
	expectSemanticSecondPush: false,
};

/** One strategy field's treatment on a command-override launch (#4833). */
interface OverrideStrategyDecision {
	/**
	 * `inherit` = the override keeps the row's value; `reset` = the default;
	 * `longer` = the longer of the row's budget and the default.
	 */
	readonly keep: "inherit" | "reset" | "longer";
	readonly why: string;
}

/**
 * #4833: what a `serverOverrides.<id>.command` launch does with EVERY
 * {@link DiagnosticStrategy} field of the row keyed by its catalog server id.
 * The row was measured on the catalog binary, but `DEFAULT_STRATEGY` is the
 * default for a server nobody measured, not the fail-safe value of each field:
 * resetting a protocol workaround reads a file sooner (a false clean).
 *
 * Direction of the default, per field. FAIL-SAFE = it waits longer or reads
 * unconfirmed; FAIL-OPEN = it reads clean sooner.
 *   - `inherit` = the row's value is the restrictive direction (it adds work, a
 *     hold or a drop whose worst case is a timeout); resetting would be
 *     fail-open.
 *   - `longer` = a wait budget: never shorter than the default.
 *   - `reset` = an optimistic claim (skip a wait, trust a first push); the
 *     default is fail-safe.
 *
 * Mapped over `keyof DiagnosticStrategy`, so a new field fails to compile until
 * decided; `tests/config/lsp-override-copy-census.test.ts` reads the interface
 * and checks the effect of each decision on every catalog row.
 */
export const OVERRIDE_STRATEGY_FIELDS: {
	readonly [K in keyof DiagnosticStrategy]-?: OverrideStrategyDecision;
} = {
	seedFirstPush: {
		keep: "reset",
		why: "True takes the first push as complete (optimistic); the default waits for the settle.",
	},
	pullRetryBudgetMs: {
		keep: "longer",
		why: "A retry budget; zero skips the pull retry, so never shorter than the default.",
	},
	debounceMs: {
		keep: "longer",
		why: "A settle window; a shorter one reads sooner, so never shorter than the default.",
	},
	aggregateWaitMs: {
		keep: "longer",
		why: "A wait budget measured on the catalog binary (opengrep cold scan 3.5 s); never shorter than the default.",
	},
	expectSemanticSecondPush: {
		keep: "inherit",
		why: "Adds a second pull after an empty fast first pull; the default reads that empty answer.",
	},
	reopenOnResync: {
		keep: "inherit",
		why: "Re-opens an edited document for a scanner that ignores didChange; dropping it loses every later finding.",
	},
	rescansOnSave: {
		keep: "inherit",
		why: "Expects the publish a save triggers; at worst the wait times out as unconfirmed.",
	},
	emptyUntilRulesRefreshed: {
		keep: "inherit",
		why: "Holds the empty publish before the rules load; dropping it reads that empty as clean.",
	},
	publishesOnClose: {
		keep: "inherit",
		why: "Drops the version-less close-time empty publish; dropping it lets a stale empty overwrite a real answer.",
	},
	emptyFirstPublish: {
		keep: "inherit",
		why: "Holds the empty pre-index first publish (#3310); dropping it reads that empty as clean.",
	},
	diagnosticsFence: {
		keep: "inherit",
		why: "Drops version-less publishes that predate the edit; the worst case is a timeout, never a false clean.",
	},
	silentOnClean: {
		keep: "reset",
		why: "True skips the in-lane wait on a clean transition (optimistic); the default waits in full.",
	},
	workspaceIndexing: {
		keep: "reset",
		why: "True shortens later same-sweep waits (optimistic); the default pays the full budget every touch.",
	},
	workspaceIndexingWarmWaitMs: {
		keep: "reset",
		why: "Read only with workspaceIndexing, so it resets with it.",
	},
};

/**
 * The row for a command-override launch: the default strategy with the row's
 * `inherit` fields and the longer of its `longer` budgets applied. A field the
 * table does not name resets (fail closed); an id with no row is the default.
 */
function overrideStrategy(serverId: string): DiagnosticStrategy {
	const row = SERVER_DIAGNOSTIC_STRATEGIES[serverId];
	if (!row) return DEFAULT_STRATEGY;
	const strategy: DiagnosticStrategy = { ...DEFAULT_STRATEGY };
	for (const [field, value] of Object.entries(row)) {
		if (!Object.hasOwn(OVERRIDE_STRATEGY_FIELDS, field)) continue;
		const keep =
			OVERRIDE_STRATEGY_FIELDS[field as keyof DiagnosticStrategy].keep;
		if (keep === "inherit") Object.assign(strategy, { [field]: value });
		else if (keep === "longer" && typeof value === "number") {
			const floor = DEFAULT_STRATEGY[field as keyof DiagnosticStrategy];
			if (typeof floor === "number") {
				Object.assign(strategy, { [field]: Math.max(value, floor) });
			}
		}
	}
	return strategy;
}

export function getStrategy(
	serverId: string,
	launchVariant?: LspLaunchVariant,
): DiagnosticStrategy {
	if (serverId === "typescript" && isTsgoLaunchVariant(launchVariant)) {
		return NATIVE_TS7_DIAGNOSTIC_STRATEGY;
	}
	// #4833: a `serverOverrides.<id>.command` launch runs another binary, so the
	// catalog row's optimistic claims reset and its restrictive fields stay.
	if (launchVariant === "override") return overrideStrategy(serverId);
	return SERVER_DIAGNOSTIC_STRATEGIES[serverId] ?? DEFAULT_STRATEGY;
}
