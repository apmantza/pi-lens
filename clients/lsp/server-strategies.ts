/**
 * Per-Server Diagnostic Strategies for pi-lens LSP
 *
 * Codifies known server behavior so timing decisions (debounce, retry budget,
 * first-push seeding) are automatic rather than one-size-fits-all.
 *
 * Env var overrides (PI_LENS_LSP_*) always take precedence over strategy values.
 */

import { createRequire } from "node:module";

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
	/**
	 * Tier-3 marker (#458): true only for a `mode: "push-only"` server that is
	 * known to publish NOTHING on a clean→clean transition (silent on clean —
	 * see docs/lsp-capability-matrix.md's `clean-behavior` column, measured by
	 * `scripts/probe-clean-signal.mjs`). Combined with the live capability
	 * snapshot's `mode === "push-only"`, this is what the cascade lane's tier
	 * gate (`clients/lsp/cascade-tier.ts`) uses to decide whether an in-lane
	 * diagnostic wait can be skipped and reconciled later at the quiet window
	 * instead. Undefined/false is the fail-safe default — a server not marked
	 * here always gets the full in-lane wait, same as before #458. Do NOT set
	 * this for `2*`/publishes-unversioned servers (opengrep, yaml, taplo, …):
	 * they DO resolve the wait early at runtime, just without a proven version,
	 * so shortening their in-lane wait would be a behavior change, not a no-op.
	 *
	 * #524/#529/#541/#558: this table is keyed by server ID, but "typescript"
	 * can now launch as either the classic typescript-language-server (what
	 * this flag was measured against) or TS7's native `tsc --lsp --stdio`
	 * (PR #526), a different Go-native binary. PR #526 originally scoped this
	 * flag to the classic server only; #541 (2026-07-11) briefly lifted that
	 * scoping after a probe run appeared to show native-ts7 silent too. A
	 * 2026-07-12 dual-environment re-measurement (nightly CI on Linux + a
	 * live local run on Windows dev, same `typescript@7.0.2` both times)
	 * found native-ts7 now publishes 2 version-less diagnostic sets on the
	 * clean transition — it is NOT silent, a drift from the #541
	 * measurement. Classic was re-confirmed silent in the same run,
	 * unaffected. This flag is therefore effectively CLASSIC-ONLY again:
	 * `cascade-tier.ts`'s classifier checks the live snapshot's
	 * `launchVariant` and does not apply it to a native-ts7 instance (falls
	 * back to the fail-safe full-wait path instead). The value here stays
	 * `true` unchanged — only the runtime scoping in cascade-tier.ts and the
	 * probe-clean-signal.mjs drift-check expectation change.
	 */
	silentOnClean?: boolean;
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

export const SERVER_DIAGNOSTIC_STRATEGIES: Record<string, DiagnosticStrategy> =
	{
		typescript: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 50,
			aggregateWaitMs: 1000,
			expectSemanticSecondPush: false,
			// Tier 3 (#458): typescript-language-server publishes nothing on a
			// clean→clean edit (docs/lsp-capability-matrix.md, re-confirmed
			// 2026-07-12). It's the lone core-set tier-3 server, which is exactly
			// why the cascade lane's in-lane wait is worth skipping for it
			// specifically. Applies to the CLASSIC server only (#524/#529/#558)
			// — TS7's native `tsc --lsp --stdio` variant shares this
			// "typescript" server id but the 2026-07-12 dual-environment
			// re-measurement found it now publishes on clean (a drift from the
			// #541 measurement); cascade-tier.ts's classifier checks the live
			// snapshot's launchVariant and never applies this flag to a
			// native-ts7 instance.
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
		// `semgrep/rulesRefreshed` — so never seed the first push. Push-only (no pull
		// diagnostics). Warm per-file scan ~1.3s; the first touch in a session may
		// also pay rule-load (~3.5s cold). aggregateWaitMs is 3500: it's this
		// server's OWN deadline, bounded by the per-edit caller cap as a ceiling
		// (#242), so on a 2500ms-capped edit opengrep waits min(2500, 3500)=2500
		// and on uncapped paths it gets its full 3500. 3500 covers warm and most
		// cold; a cold scan that overruns isn't lost — late diagnostics are cached
		// and surface on the next edit.
		opengrep: {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 250,
			aggregateWaitMs: 3500,
			expectSemanticSecondPush: false,
			// Opengrep re-scans only on a fresh didOpen — didChange is a no-op for it.
			reopenOnResync: true,
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
		// finding is cached and surfaces on the next edit.
		zizmor: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 2000,
			expectSemanticSecondPush: false,
			reopenOnResync: false,
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
		},
	};

/** Fallback for unknown servers. Conservative defaults. */
export const DEFAULT_STRATEGY: DiagnosticStrategy = {
	seedFirstPush: false,
	pullRetryBudgetMs: 250,
	debounceMs: 150,
	aggregateWaitMs: 1500,
	expectSemanticSecondPush: false,
};

export function getStrategy(serverId: string): DiagnosticStrategy {
	return SERVER_DIAGNOSTIC_STRATEGIES[serverId] ?? DEFAULT_STRATEGY;
}
