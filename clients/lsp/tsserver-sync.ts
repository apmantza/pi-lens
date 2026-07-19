/**
 * #611/#707: classic typescript-language-server tsserver sync diagnostic
 * commands — shared between the `lsp_diagnostics` tool (where the escape hatch
 * was first introduced in #611) and the per-edit `touchFile` dispatch path
 * (wired in #707 to avoid burning the full wait budget on clean TS files).
 *
 * These are a genuine synchronous request/response tsserver protocol extension
 * exposed via `workspace/executeCommand` with command
 * `typescript.tsserverRequest`. Unlike the push-only LSP surface, calling them
 * gives a definitive answer: empty array = confirmed clean, non-empty = real
 * diagnostics the server had computed but never published on the push surface.
 *
 * Empirically verified live (2026-07, typescript-language-server 5.9.3, this
 * repo's own tsconfig.json as the fixture project):
 *
 *   workspace/executeCommand {
 *     command: "typescript.tsserverRequest",
 *     arguments: [
 *       "semanticDiagnosticsSync" | "syntacticDiagnosticsSync",
 *       { file: "<absolute path>", includeLinePosition: true }
 *     ]
 *   }
 *
 * resolves { executed: true, result: { seq, type: "response", command,
 * request_seq, success, body: [...] } }, where each body entry is tsserver's
 * NATIVE protocol diagnostic shape — `message`, `category`
 * ("error"|"warning"|"suggestion"), `code`, `startLocation`/`endLocation` as
 * `{ line, offset }` — NOT the LSP `Diagnostic` shape, and both `line`/`offset`
 * are 1-based (LSP is 0-based).
 *
 * All helpers here are pure-function and never throw (every error path returns
 * `undefined`). The caller must handle `undefined` as "sync path unavailable,
 * fall back to existing unconfirmed/timed-out behavior".
 */

import type { LSPDiagnostic } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TsserverSyncRawDiagnostic {
	message: string;
	category: string;
	code?: number;
	startLocation?: { line: number; offset: number };
	endLocation?: { line: number; offset: number };
}

/** Minimal LSP-service-shaped interface this module needs — avoids importing
 * the full LSPService class and keeps the extracted module test-friendly. */
export interface TsserverSyncCapableService {
	getAdvertisedCommands?: (filePath?: string) => Promise<string[]>;
	executeCommand?: (
		filePath: string | undefined,
		command: string,
		args?: unknown[],
	) => Promise<{ executed: boolean; result?: unknown; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isTsserverSyncRawDiagnostic(
	value: unknown,
): value is TsserverSyncRawDiagnostic {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.message === "string" && typeof v.category === "string";
}

export function tsserverSeverityFromCategory(category: string): 1 | 2 | 3 | 4 {
	switch (category) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "suggestion":
			return 4; // Hint
		default:
			return 3; // "message" or unrecognized -> Info
	}
}

/**
 * Convert a tsserver-protocol sync diagnostic into pi-lens's LSP-shaped
 * `LSPDiagnostic`. Both `line`/`offset` are 1-based in tsserver's protocol
 * and 0-based in LSP — this conversion handles that.
 */
export function tsserverSyncDiagnosticToLsp(
	d: TsserverSyncRawDiagnostic,
): LSPDiagnostic {
	const startLine = Math.max(0, (d.startLocation?.line ?? 1) - 1);
	const startChar = Math.max(0, (d.startLocation?.offset ?? 1) - 1);
	const endLine = Math.max(
		0,
		(d.endLocation?.line ?? d.startLocation?.line ?? 1) - 1,
	);
	const endChar = Math.max(
		0,
		(d.endLocation?.offset ?? d.startLocation?.offset ?? 1) - 1,
	);
	return {
		severity: tsserverSeverityFromCategory(d.category),
		message: d.message,
		range: {
			start: { line: startLine, character: startChar },
			end: { line: endLine, character: endChar },
		},
		code: d.code,
		source: "typescript",
	};
}

/**
 * Run a single tsserver sync diagnostic command via the LSP service's
 * `executeCommand`. Returns the raw diagnostic array from the response body,
 * or `undefined` if: the service has no `executeCommand`, the command wasn't
 * executed, the response envelope isn't `{success:true, body:[...]}`, or
 * any error is thrown.
 */
export async function runTsserverSyncCommand(
	svc: TsserverSyncCapableService,
	file: string,
	command: "semanticDiagnosticsSync" | "syntacticDiagnosticsSync",
): Promise<TsserverSyncRawDiagnostic[] | undefined> {
	if (typeof svc.executeCommand !== "function") return undefined;
	const outcome = await svc.executeCommand(file, TSSERVER_REQUEST_COMMAND, [
		command,
		{ file, includeLinePosition: true },
	]);
	if (!outcome.executed) return undefined;
	const result = outcome.result as
		| { success?: boolean; body?: unknown }
		| undefined;
	if (!result || result.success !== true || !Array.isArray(result.body)) {
		return undefined;
	}
	return result.body.filter(isTsserverSyncRawDiagnostic);
}

/**
 * #611/#707: attempt classic typescript-language-server's
 * `typescript.tsserverRequest` escape hatch — a genuine synchronous
 * request/response tsserver command, not push/timing-dependent — to get a
 * definitive answer for a Tier-3 silent server's empty push-based result.
 * Runs BOTH `semanticDiagnosticsSync` and `syntacticDiagnosticsSync`
 * (mirroring what the server itself publishes on a dirty file) so a
 * syntax-only error isn't missed.
 *
 * Returns `undefined` (never throws, never hangs beyond the existing
 * `executeCommand` anti-deadlock backstop) when: the command isn't advertised
 * by this server (older/different server/config), `executeCommand` throws
 * (live-verified case: tsserver rejects with a `ResponseError` — "No
 * Project." — for a file outside any tsconfig project) or times out, or the
 * response shape isn't the expected `{success:true, body:[...]}` envelope.
 * Every one of these must fall through to the existing "unconfirmed" behavior
 * in the caller.
 *
 * `confirmed: true` with an empty `diagnostics` array = genuinely confirmed
 * clean. `confirmed: true` with a non-empty array = real diagnostics the
 * server had computed but never published (silentOnClean) — these must be
 * surfaced to the caller, not discarded. `confirmed: false` = sync path
 * unavailable, fall through to existing behavior.
 */
export async function attemptTsserverSyncDiagnostics(
	file: string,
	svc: TsserverSyncCapableService,
): Promise<LSPDiagnostic[] | undefined> {
	try {
		if (typeof svc.getAdvertisedCommands !== "function") return undefined;
		const advertised = await svc.getAdvertisedCommands(file);
		if (!advertised.includes(TSSERVER_REQUEST_COMMAND)) return undefined;

		const [semantic, syntactic] = await Promise.all([
			runTsserverSyncCommand(svc, file, "semanticDiagnosticsSync"),
			runTsserverSyncCommand(svc, file, "syntacticDiagnosticsSync"),
		]);
		if (semantic === undefined || syntactic === undefined) return undefined;

		return [...syntactic, ...semantic].map(tsserverSyncDiagnosticToLsp);
	} catch {
		return undefined;
	}
}
