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
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey } from "../path-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TsserverSyncRawDiagnostic {
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
	/**
	 * #1640: the non-spawning, non-mutating probe channel
	 * (`LSPService.executeReadOnlyCommandOnLiveClient`). Optional so older test
	 * doubles keep working — but a caller that NEEDS probe semantics must treat
	 * its absence as "unknown" rather than falling back to `executeCommand`,
	 * which is the mutation channel and spawns a server fleet to answer.
	 */
	executeReadOnlyCommandOnLiveClient?: (
		filePath: string,
		command: string,
		args?: unknown[],
	) => Promise<{ executed: boolean; result?: unknown; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";

export interface TsserverProjectIdentityCommandChannel {
	executeCommand?: (
		command: string,
		args?: unknown[],
	) => Promise<{ executed: boolean; result?: unknown; reason?: string }>;
}

export interface TsserverProjectIdentityProbeOptions {
	serverId: string;
	launchVariant?: "classic" | "native-ts7";
	clientRoot: string;
	file: string;
	/**
	 * #1412 L2: caller-supplied `normalizeMapKey(file)`. `handleNotifyOpen`
	 * already computes this before calling in (client.ts) — recomputing it here
	 * would just repeat the same normalization for every first open. Falls back
	 * to normalizing `file` locally if a caller (e.g. an older test) omits it.
	 */
	normalizedFile?: string;
	probedFiles: Set<string>;
	commandChannel: TsserverProjectIdentityCommandChannel;
}

export interface TsserverProjectIdentity {
	projectKind: "configured" | "inferred" | "unassociated";
	configFile?: string;
	association: "associated" | "unassociated" | "language-service-disabled";
}

/**
 * tsserver's synthetic inferred-project name, as its own source builds it:
 * `"/dev/null/inferredProject" + counter + "*"`. `/dev/null` is a deliberate
 * sentinel prefix — no real config file can live there — and matching the WHOLE
 * string against it is the only safe test.
 *
 * #1645 review F4: an earlier version also matched an UNANCHORED
 * `/inferred[-_ ]?project/i` anywhere in the string. That inverted the verdict
 * for a real project in a directory a human happened to name that way —
 * `/repo/inferred-project/tsconfig.json` classified as INFERRED, which demoted
 * its genuine blocking errors. A classifier that gates authority must never key
 * off user-controlled directory names.
 *
 * The optional drive-letter/backslash arm covers a host that normalizes the
 * sentinel through win32 path handling before it reaches us; the `/dev/null`
 * prefix is still required.
 */
const INFERRED_PROJECT_SENTINEL =
	/^(?:[A-Za-z]:)?[/\\]dev[/\\]null[/\\]inferredProject\d*\*?$/i;

/**
 * Classify one tsserver `projectInfo` response body.
 *
 * `configFileName` is tsserver's own answer to "which project owns this file".
 * A real project answers with a `tsconfig.json`/`jsconfig.json` path; a file
 * that matches no project's `include`/`files` lands in tsserver's synthetic
 * inferred project, whose `configFileName` is a `/dev/null/inferredProject1*`
 * placeholder. The two are the same field, so the placeholder shape is the only
 * thing that separates "checked against the project's real compiler options"
 * from "checked against defaults nobody configured" (#1640).
 *
 * Exported so the diagnostic-demotion seam (`inferred-project.ts`) and the
 * #1412 telemetry probe share ONE classifier — a second hand-rolled
 * configFileName test would be a parallel source of truth for the same verdict.
 */
export function classifyProjectInfo(body: unknown): TsserverProjectIdentity {
	if (!body || typeof body !== "object") {
		return { projectKind: "unassociated", association: "unassociated" };
	}
	const info = body as Record<string, unknown>;
	const configFile =
		typeof info.configFileName === "string" && info.configFileName.length > 0
			? info.configFileName
			: undefined;
	const inferred = configFile
		? INFERRED_PROJECT_SENTINEL.test(configFile)
		: false;
	const projectKind = configFile
		? inferred
			? "inferred"
			: /(?:^|[/\\])(?:tsconfig|jsconfig)\.json$/i.test(configFile)
				? "configured"
				: "unassociated"
		: "unassociated";
	return {
		projectKind,
		...(configFile ? { configFile } : {}),
		association:
			info.languageServiceDisabled === true
				? "language-service-disabled"
				: projectKind === "unassociated"
					? "unassociated"
					: "associated",
	};
}

/**
 * #1412: after classic TypeScript's first successful didOpen, sample the
 * tsserver project association without delaying diagnostics. The supplied
 * executeCommand channel owns the existing bounded anti-deadlock backstop.
 */
export async function probeTsserverProjectIdentity(
	options: TsserverProjectIdentityProbeOptions,
): Promise<void> {
	const normalizedFile =
		options.normalizedFile ?? normalizeMapKey(options.file);
	const startedAt = Date.now();
	// Logging starts only once a probe is actually eligible and attempted:
	// ineligible servers (wrong serverId/launchVariant, no command channel) and
	// already-probed dedupe are both routine, high-volume, and per-server — a
	// bare return keeps them out of the telemetry stream entirely instead of
	// writing an `lsp_typescript_project_identity` row per didOpen on every
	// server (python, go, opengrep, ...).
	const logOutcome = (
		outcome: "ok" | "not-executed" | "no-response" | "unsuccessful" | "threw",
		metadata: Record<string, unknown> = {},
	) =>
		logLatency({
			type: "phase",
			phase: "lsp_typescript_project_identity",
			filePath: normalizedFile,
			durationMs: Date.now() - startedAt,
			metadata: {
				serverId: options.serverId,
				launchVariant: options.launchVariant,
				clientRoot: options.clientRoot,
				outcome,
				...metadata,
			},
		});
	if (
		options.serverId !== "typescript" ||
		options.launchVariant !== "classic" ||
		typeof options.commandChannel.executeCommand !== "function"
	) {
		return;
	}
	if (options.probedFiles.has(normalizedFile)) return;
	// Claim before yielding so concurrent opens cannot issue duplicate probes.
	options.probedFiles.add(normalizedFile);
	try {
		const outcome = await options.commandChannel.executeCommand(
			TSSERVER_REQUEST_COMMAND,
			["projectInfo", { file: options.file, needFileNameList: false }],
		);
		if (!outcome.executed) {
			logOutcome("not-executed");
			return;
		}
		const response = outcome.result as
			| { success?: boolean; body?: unknown }
			| undefined;
		if (!response) {
			logOutcome("no-response");
			return;
		}
		if (response.success !== true) {
			logOutcome("unsuccessful");
			return;
		}
		const identity = classifyProjectInfo(response.body);
		logLatency({
			type: "phase",
			phase: "lsp_typescript_project_identity",
			filePath: normalizedFile,
			durationMs: Date.now() - startedAt,
			metadata: {
				outcome: "ok",
				serverId: options.serverId,
				launchVariant: options.launchVariant,
				clientRoot: options.clientRoot,
				projectKind: identity.projectKind,
				configFile: identity.configFile,
				association: identity.association,
			},
		});
	} catch {
		logOutcome("threw");
		// Best-effort telemetry: command errors/timeouts never reach diagnostics.
	}
}

/**
 * #1640: ask tsserver which project owns `file`, on demand, through the same
 * `typescript.tsserverRequest` escape hatch the sync-diagnostics helpers use.
 *
 * Unlike {@link probeTsserverProjectIdentity} — fire-and-forget telemetry
 * sampled once per didOpen — this is a request/response call a caller awaits
 * because it needs the answer to decide how to RENDER a diagnostic.
 *
 * Routed through `executeReadOnlyCommandOnLiveClient` ONLY, never
 * `executeCommand` (#1645 review F1/F2). The mutation channel would open the
 * `workspace/applyEdit` acceptance window, clobber a concurrent command's
 * `activeMutationContext`, carry the 30s mutation backstop instead of the short
 * probe one, and spawn a language-server fleet to answer. All four are wrong for
 * a passive render-path question. A service without the read-only channel is
 * UNKNOWN, not a reason to fall back.
 *
 * Returns `undefined` for every "we do not know" path: no read-only channel, no
 * live server for the file, the command is not advertised (non-classic server,
 * older typescript-language-server), the command was not executed, the response
 * envelope is not `{success:true}`, or the call threw/timed out. `undefined`
 * must never be treated as "inferred" — an unanswered probe is not a verdict
 * (AGENTS.md shape 10: an empty result must distinguish clean from unavailable).
 */
export async function fetchTsserverProjectIdentity(
	svc: TsserverSyncCapableService,
	file: string,
): Promise<TsserverProjectIdentity | undefined> {
	try {
		if (typeof svc.executeReadOnlyCommandOnLiveClient !== "function") {
			return undefined;
		}
		// No `getAdvertisedCommands` pre-flight: that helper routes through
		// `getClientForFile`, which SPAWNS. The read-only channel already enforces
		// allowlist-by-advertisement server-side and answers `executed:false` for
		// a server that never advertised the command.
		const outcome = await svc.executeReadOnlyCommandOnLiveClient(
			file,
			TSSERVER_REQUEST_COMMAND,
			["projectInfo", { file, needFileNameList: false }],
		);
		if (!outcome.executed) return undefined;
		const response = outcome.result as
			| { success?: boolean; body?: unknown }
			| undefined;
		if (!response || response.success !== true) return undefined;
		return classifyProjectInfo(response.body);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTsserverSyncRawDiagnostic(
	value: unknown,
): value is TsserverSyncRawDiagnostic {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.message === "string" && typeof v.category === "string";
}

function tsserverSeverityFromCategory(category: string): 1 | 2 | 3 | 4 {
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
function tsserverSyncDiagnosticToLsp(
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
async function runTsserverSyncCommand(
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
 *
 * #2598: `getAdvertisedCommands` is REQUIRED here rather than probed for. The
 * real `LSPService` defines it unconditionally (clients/lsp/index.ts), and both
 * production callers hand this function that service, so the former
 * `typeof … !== "function"` bail was reachable only from a partial test double
 * (AGENTS.md shape 7). It was also unobservable even there: an absent method
 * throws a `TypeError` that this function's own catch turns into the same
 * `undefined` the bail returned. `executeCommand` stays optional on
 * {@link TsserverSyncCapableService} — see {@link runTsserverSyncCommand}.
 */
export async function attemptTsserverSyncDiagnostics(
	file: string,
	svc: TsserverSyncCapableService &
		Required<Pick<TsserverSyncCapableService, "getAdvertisedCommands">>,
): Promise<LSPDiagnostic[] | undefined> {
	try {
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
