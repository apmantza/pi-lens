/**
 * Incumbent LSP wait-tier policy for attached sessions (#822).
 *
 * This policy is applied by the incumbent process on behalf of attached
 * sessions. Keep it free of session-local state: no imports from
 * runtime-session, runtime-turn, or warm-attach.
 */

import { getServersForFileWithConfig } from "../config.js";
import type { LSPService } from "../index.js";
import { getStrategy } from "./strategies.js";
import type { LSPCapabilitySnapshot } from "./capability-snapshot.js";

export type CascadeWaitTier =
	| "pull-capable"
	| "tier3-silent"
	| "diagnostics-unsupported"
	| "waits";

/**
 * Classify a SINGLE server (by id, given its live capability snapshot — or
 * `undefined` when none exists yet) as cascade-lane Tier-3 (push-only,
 * silent-on-clean) or not. This is the per-server primitive both
 * `classifyCascadeWaitTier` (file's PRIMARY server only, the cascade lane's
 * original use) and #814's capability-aware AGGREGATE wait (`touchFile`'s
 * `clientScope: "all"` path, `clients/lsp/index.ts`) share — one
 * classification rule, not two copies that could drift. Ambiguous or missing
 * capability data is always `"waits"` (today's behavior) — this function must
 * never be the reason a real answer gets missed.
 */
export function classifyServerWaitTier(
	serverId: string,
	snapshot: LSPCapabilitySnapshot | undefined,
): CascadeWaitTier {
	if (!snapshot) return "waits"; // no live snapshot yet — fail-safe

	const mode = snapshot.workspaceDiagnosticsSupport?.mode;
	if (mode === "pull") return "pull-capable";
	if (
		snapshot.customServer === true &&
		mode === "push-only" &&
		snapshot.diagnosticsPublished !== true
	) {
		return "diagnostics-unsupported";
	}
	if (mode !== "push-only") return "waits";

	const strategy = getStrategy(serverId, snapshot.launchVariant);
	if (strategy.silentOnClean !== true) return "waits"; // 2*/unknown push-only

	// #524/#529/#541/#558: `silentOnClean` on a server-id-keyed strategy is
	// only proven against the variant it was actually measured against.
	// "typescript" today means either classic typescript-language-server
	// (confirmed silent-on-clean, 2026-07-12 dual-environment re-measurement)
	// or TS7's native `tsc --lsp --stdio` (the SAME re-measurement found it
	// publishes 2 version-less diagnostic sets on clean — NOT silent, a
	// drift from the earlier #541 measurement). A native-ts7 snapshot must
	// NOT inherit the classic verdict: fall through to "waits", the same
	// ambiguous/fail-safe path an unmarked or non-push-only server already
	// takes. `launchVariant === "classic"` or absent (older snapshots that
	// predate the marker) keeps today's tier-3 behavior exactly.
	if (snapshot.launchVariant === "native-ts7") return "waits";

	return "tier3-silent";
}

/**
 * Resolve `filePath`'s PRIMARY (non-auxiliary) server id and its live
 * capability snapshot, or `undefined` when the file has no primary server
 * configured. The single place that decides what "this file's server" means
 * for wait-policy purposes — shared by {@link classifyCascadeWaitTier} and the
 * cascade-lane wrapper in `clients/lsp/cascade-tier.ts`, which needs the same
 * id/snapshot pair to apply its one cascade-only override.
 */
export function resolvePrimaryServerForWaitPolicy(
	filePath: string,
	snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
):
	| { serverId: string; snapshot: LSPCapabilitySnapshot | undefined }
	| undefined {
	const servers = getServersForFileWithConfig(filePath).filter(
		(s) => s.role !== "auxiliary",
	);
	const primary = servers[0];
	if (!primary) return undefined;
	return {
		serverId: primary.id,
		snapshot: snapshots.find((s) => s.serverId === primary.id),
	};
}

/**
 * Classify whether `filePath`'s PRIMARY language server is a cascade-lane
 * Tier-3 (push-only, silent-on-clean) server. Ambiguous or missing capability
 * data is always `"waits"` (today's behavior) — this function must never be
 * the reason a real answer gets missed. Thin wrapper over
 * `classifyServerWaitTier` — resolves the file's primary server id/snapshot,
 * then defers to the shared per-server rule.
 */
export function classifyCascadeWaitTier(
	lspService: Pick<LSPService, "getCapabilitySnapshots">,
	filePath: string,
	snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
): CascadeWaitTier {
	void lspService; // kept in the signature for call-site clarity/typing only
	const primary = resolvePrimaryServerForWaitPolicy(filePath, snapshots);
	if (!primary) return "waits";
	return classifyServerWaitTier(primary.serverId, primary.snapshot);
}
