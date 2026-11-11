/**
 * Warm side-channel for the push path. The MCP server is a long-lived process
 * with a warm LSP, but its stdio is owned by the MCP client — so the
 * PostToolUse-hook bin can't reach it that way. Instead the server listens on a
 * local IPC endpoint (Unix domain socket / Windows named pipe), and the hook
 * connects to it to get LSP-complete diagnostics from the warm process instead
 * of running its own cold analysis.
 *
 * This module is the CLIENT + the shared path derivation + the one-shot line
 * reader the server wires into its socket (deliberately light: node:net +
 * type-only result, so the bin can try the warm path WITHOUT loading the
 * dispatch graph). The analysis engine lives in mcp/server.ts. If the warm
 * path is unavailable, the client resolves `undefined` and the caller falls
 * back to cold local analysis.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { incrementDegradationCount } from "../degradation-ledger.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../spawn-output-cap.js";
import type { LSPCodeAction, LSPDiagnostic } from "../lsp/client.js";
import type { DiagnosticBinding } from "../lsp/diagnostic-binding.js";
import type { TsserverProjectIdentity } from "../lsp/tsserver-sync.js";
import type { McpAnalyzeResult } from "./analyze.js";

export const WARM_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const WARM_CODE_ACTION_LOOKUP_LIMIT = 6;

/**
 * Stable per-workspace endpoint path. The server (from its launch cwd) and the
 * hook (from the PostToolUse cwd) must resolve the same path — both hash the
 * resolved root (lowercased for case-insensitive filesystems), so when they're
 * the same project they meet. Mismatch → the client just falls back to cold.
 */
export function ipcPathForCwd(
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const hash = workspaceHash(cwd, platform);
	if (platform === "win32") {
		return `\\\\.\\pipe\\pi-lens-mcp-${hash}`;
	}
	return path.join(os.tmpdir(), `pi-lens-mcp-${hash}.sock`);
}

/**
 * The single stable per-workspace id both endpoint derivations key on. Every
 * per-workspace side-channel name (socket/pipe, turn-end status file) must come
 * from HERE, so the hook process and the server process cannot drift apart.
 *
 * #1193 P3 decision: this input is NOT a map key and neither path-utils seam
 * belongs here. Writers and readers of this id, and what each one holds:
 *
 * | process            | site                                          | input |
 * |--------------------|-----------------------------------------------|-------|
 * | MCP server (warm)  | `mcp/server.ts` `IPC_PATH` — listen            | its launch cwd |
 * | pi session (warm)  | `clients/warm-attach.ts` — listen (pid-scoped) | runtime cwd |
 * | PostToolUse hook   | `requestWarmAnalyze` — connect                 | hook cwd |
 * | Stop hook          | `requestWarmTurnEnd` — connect                 | hook cwd |
 * | Stop hook / health | `turnEndStatusPathForCwd` — write + read a file in tmpdir | cwd |
 *
 * Every row is a SEPARATE process that must reproduce the same 16 hex
 * characters with no shared state, and the rows do not run at the same time —
 * the server derives its id at launch, a hook derives its own minutes or hours
 * later. `normalizeMapKey`/`normalizeFilePath` would make the id depend on
 * filesystem state (`realpathSync.native`, on-disk casing) read at two
 * different moments: a case-only rename, a remounted symlink, or a hook running
 * in a different mount namespace than the server would silently stop the two
 * from meeting. That is the exact staleness PR #2193 was rejected for on the
 * LSP seam. `normalizeEphemeralMapKey` is excluded by its own contract — it is
 * scoped to process-local, same-run keys and says so.
 *
 * So the derivation stays pure string math — and #3255 narrowed its case fold
 * to the platforms whose FILESYSTEM folds case, because "pure" and
 * "unconditional" are not the same thing:
 *
 * - case-INSENSITIVE default (`win32`, `darwin` APFS/HFS+): `Alpha` and `alpha`
 *   are ONE directory, so the only failure mode is a MISS. The server row and
 *   the hook rows can hold different spellings of it — the server's cwd can be
 *   a hand-written `--cwd=` / `PI_LENS_MCP_CWD` while the hook's comes from the
 *   payload (see `tests/mcp/turn-end-route.smoke.test.ts`'s win32 case) — so the
 *   fold is what makes them meet, and it stays. `darwin` belongs here for a
 *   reason in this tree, not by analogy: the incumbent selection that decides
 *   two sessions share a root already compares through `normalizeFilePath`
 *   (`clients/instance-registry.ts:837`), whose `realpathSync.native` returns
 *   on-disk casing on Darwin. A pair that SELECTS each other case-insensitively
 *   must be able to MEET.
 * - case-SENSITIVE (Linux, *BSD): `Alpha` and `alpha` are TWO directories, and
 *   two spellings of one workspace cannot occur (a mis-cased `--cwd=` names a
 *   directory that does not exist). Folding there bought nothing and collided
 *   two workspaces onto one socket and one status file — #3255.
 *
 * Known residuals, both fail-safe and both un-closable without a filesystem
 * read this derivation is forbidden to do: a case-insensitive MOUNT on a
 * case-sensitive platform (`nocase` vfat/ntfs3/cifs, ext4 `chattr +F`) now
 * misses instead of meeting — the same blind spot `normalizeFilePath` has
 * there, measured and filed as #3154 — and a case-SENSITIVE APFS volume keeps
 * today's collision.
 *
 * `platform` is an argument, not a `process.platform` read, so every arm is
 * testable from one lane (the seam `normalizePathEntry` uses in
 * `clients/lsp/launch.ts`).
 */
function workspaceHash(
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const resolved = path.resolve(cwd);
	const root =
		platform === "win32" || platform === "darwin"
			? resolved.toLowerCase()
			: resolved;
	// sha256 (not for security — just a stable short id for the IPC socket/pipe
	// name keyed by cwd; sha256 over sha1 keeps SonarCloud's weak-hash check quiet)
	return crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
}

/** PID-scoped endpoint used by pi sessions. The legacy MCP analyze endpoint
 * remains workspace-scoped for compatibility with the PostToolUse hook.
 *
 * POSIX shape `pi-lens-mcp-<pid>-diagnostics-<hash>.sock`: the pid comes BEFORE
 * the hash so it survives the `sun_path` cut (see {@link boundUnixSocketPath}),
 * which removes the tail of a long path. With the pid last, a TMPDIR of 66
 * bytes or more cut it out and every pi session in a workspace bound one name
 * (#4376 review r1, F1). A pid is unique on a host, so the name stays unique
 * while the pid is inside the bound name; the hash is the part that goes first.
 * Consumers: the warm-attach server (`clients/warm-attach.ts`), both pid-scoped
 * clients below, and the harness teardown; they all derive the name here. */
export function diagnosticsIpcPathForCwd(
	cwd: string,
	pid: number,
	platform: NodeJS.Platform = process.platform,
): string {
	const base = ipcPathForCwd(cwd, platform);
	if (platform === "win32") return `${base}-diagnostics-${pid}`;
	const hash = workspaceHash(cwd, platform);
	return path.join(
		path.dirname(base),
		`pi-lens-mcp-${pid}-diagnostics-${hash}.sock`,
	);
}

/**
 * The explicit Unix socket path used at each `listen` and `createConnection`
 * boundary (#4353). Kernel path limits vary: some overlong paths are rejected
 * rather than truncated, so every network operation must use this bounded
 * spelling. Windows pipes and paths that fit come back unchanged.
 *
 * Decision: unlink the bound name rather than move long paths to a short
 * directory. A relocation would change where the server and the hook meet and
 * who may create the entry; the unlink changes neither.
 */
export function boundUnixSocketPath(
	endpoint: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const limit = platform === "darwin" ? 104 : platform === "win32" ? 0 : 108;
	const bytes = Buffer.from(endpoint);
	if (limit === 0 || bytes.length <= limit) return endpoint;
	return bytes.subarray(0, limit).toString();
}

export type StaleSocketOutcome =
	| "absent"
	| "unlinked"
	| "not-a-socket"
	| "shared-name";

/**
 * The one stale-socket unlink for every endpoint a listener is about to bind
 * (#4376 review r1, F1 and F2). It names the BOUND file, and it removes:
 *
 * - only a socket (`lstat`): the cut can land on an unrelated file such as
 *   `$TMPDIR/pi-lens`, and unlinking that destroyed user data;
 * - for a pid-scoped endpoint (`ownerPid`), only a name that still carries the
 *   owner's pid. A truncated name without it is shared by every session, so a
 *   socket there may belong to a LIVE session; clearing it would replace that
 *   listener and orphan it. The listen then fails EADDRINUSE and the caller
 *   falls back cold, as it did before the unlink named the bound file.
 *
 * Windows named pipes have no file to remove. A failed `lstat` or unlink is
 * `absent`: the `listen` that follows reports any real conflict.
 */
export function unlinkStaleUnixSocket(
	endpoint: string,
	options: { ownerPid?: number; platform?: NodeJS.Platform } = {},
): StaleSocketOutcome {
	if ((options.platform ?? process.platform) === "win32") return "absent";
	const bound = boundUnixSocketPath(endpoint, options.platform);
	if (
		options.ownerPid !== undefined &&
		bound !== endpoint &&
		!bound.includes(`${path.sep}pi-lens-mcp-${options.ownerPid}-`)
	)
		return "shared-name";
	try {
		if (!fs.lstatSync(bound).isSocket()) return "not-a-socket";
		fs.unlinkSync(bound);
		return "unlinked";
	} catch {
		return "absent";
	}
}

export interface WarmDiagnosticsRequest {
	route: "diagnostics";
	version: number;
	file: string;
	cwd: string;
	content: string;
	contentHash: string;
	deadlineAt: number;
}

export interface WarmDiagnosticsResponse {
	route: "diagnostics";
	version: number;
	diagnostics: LSPDiagnostic[];
	contentHash: string;
	servedAt: number;
	fresh: boolean;
	inconclusive: boolean;
	/**
	 * #1253: the incumbent's `TouchFileResult.confirmation` — present only when
	 * that touch completed its configured diagnostics/confirmation policy (which
	 * includes the silent-clean gates a `silentOnClean` server like marksman
	 * depends on). `inconclusive: false` alone is NOT the same evidence, so the
	 * flag is carried explicitly rather than inferred. Optional: an incumbent
	 * built before this field simply omits it, and the consumer then falls back
	 * to today's unconfirmed handling.
	 *
	 * #1470/#1493: `"partial"` is the narrowed verdict — the incumbent's touch
	 * completed, but an auxiliary contributed no evidence and `unconfirmedServerIds`
	 * names it. A consumer testing `=== "confirmed"` therefore fails closed for free;
	 * one that wants the narrowing reads the id list.
	 */
	confirmation?: "confirmed" | "partial";
	/**
	 * #1470/#1493: server ids the incumbent's touch carries no evidence for — every
	 * auxiliary that never reported, whether the aux grace timer cut its push wait
	 * off (#1470) or it stayed silent with no stored publication for this content
	 * (#1493). Both shapes cross this boundary under the one name; a consumer must
	 * not assume a hung server. Present only alongside `confirmation: "partial"`.
	 * Re-surfaced as an EXPLICIT enumerable DTO field for the same reason
	 * `inconclusive` is: no side-channel survives `JSON.stringify` of the
	 * diagnostics array.
	 */
	unconfirmedServerIds?: string[];
	/**
	 * #4645: the incumbent's own tsserver answer to "which project owns this
	 * file", asked only when a row could be demoted by it. `diagnostics` stay the
	 * server's raw rows: the reader runs the one demotion pipeline itself with
	 * this answer standing in for the probe it cannot send without spawning, so
	 * its rendered rows and the form its cache stores are a local read's. Absent
	 * when nothing was asked, the probe did not answer, or the probe did not
	 * settle before the reply's send reserve; an incumbent built before this
	 * omits it, and an older reader ignores it and renders the raw rows.
	 */
	projectIdentity?: TsserverProjectIdentity;
	/**
	 * #5030: the incumbent touch's content binding, the verdict on whether
	 * `diagnostics` describe the bytes on disk (`boundToCurrentDisk`) and the
	 * fingerprint of the bytes they describe. Always present on an incumbent that
	 * knows the field (`"unknown"` when its touch composed none), so ABSENCE can
	 * only mean an incumbent built before it. A reader takes the field through
	 * `warmAnswerBinding` (`clients/lsp/diagnostic-binding.ts`), which reads an
	 * absent or unreadable one as `boundToCurrentDisk: false`: not current, never
	 * current. An older reader ignores the field (nothing here validates keys), so
	 * the schema version stays 1.
	 */
	binding?: DiagnosticBinding;
}

export interface WarmCodeActionRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

export interface WarmCodeActionsRequest {
	route: "code-actions";
	version: number;
	file: string;
	cwd: string;
	contentHash: string;
	ranges: WarmCodeActionRange[];
	deadlineAt: number;
}

export interface WarmCodeActionsResponse {
	route: "code-actions";
	version: number;
	contentHash: string;
	servedAt: number;
	actions: LSPCodeAction[][];
}

export type WarmCodeActionsResult =
	| { available: true; response: WarmCodeActionsResponse }
	| { available: false; reason: WarmDiagnosticsFailureReason };

export type WarmDiagnosticsFailureReason =
	| "timeout"
	| "ipc-error"
	/**
	 * Nothing is listening on the endpoint this process derived — the connect
	 * itself never landed. Split out of `ipc-error` by #3255 for the same reason
	 * #1272 split `schema-mismatch` out of it: the remedies differ. An
	 * answering-but-broken server needs a rebuild; an absent one needs a start;
	 * and after #3255 narrowed the case fold, a server that was ALREADY RUNNING
	 * when pi-lens was upgraded still owns the previous endpoint name, so it
	 * needs a restart and nothing else will fix it.
	 */
	| "no-listener"
	| "schema-mismatch"
	| "stale-answer";

/**
 * A connect that never landed, as opposed to a socket that opened and then
 * failed. `ENOENT` is the POSIX "no socket file there"; `ECONNREFUSED` is a
 * socket file (or named pipe) with no live listener behind it.
 */
function isNoListenerError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === "ENOENT" || code === "ECONNREFUSED";
}

export type WarmDiagnosticsResult =
	| { available: true; response: WarmDiagnosticsResponse }
	| { available: false; reason: WarmDiagnosticsFailureReason };

export function contentHash(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

type WarmIpcOutcome<TResponse> =
	| { available: true; response: TResponse }
	| { available: false; reason: WarmDiagnosticsFailureReason };

/**
 * Shared one-shot request/response transport for the tagged IPC routes (#822):
 * connect to `endpoint`, write one JSON line, read one JSON line back,
 * classify. The endpoint is PID-scoped for the warm-attach routes and
 * workspace-scoped for the hook bin's turn-end route. The per-route `validate`
 * callback returns a failure reason for an on-time but unusable reply (schema
 * skew, staleness) or `undefined` to accept it; transport failures map
 * uniformly to timeout/ipc-error. One transport, N routes — the clients cannot
 * drift apart.
 */
function requestOverWarmIpc<TResponse, TRequest extends object = object>(
	endpoint: string,
	timeoutMs: number,
	buildRequest: (deadlineAt: number) => TRequest,
	validate: (
		result: TResponse,
		deadlineAt: number,
	) => WarmDiagnosticsFailureReason | undefined,
): Promise<WarmIpcOutcome<TResponse>> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: WarmIpcOutcome<TResponse>): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const deadlineAt = Date.now() + timeoutMs;
		const socket = net.createConnection(boundUnixSocketPath(endpoint));
		socket.setEncoding("utf8");
		const timer = setTimeout(
			() => finish({ available: false, reason: "timeout" }),
			timeoutMs,
		);
		timer.unref();
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(buildRequest(deadlineAt))}\n`);
		});
		socket.on(
			"data",
			createWarmIpcLineReader(
				(line) => {
					try {
						const message = JSON.parse(line) as {
							result?: TResponse;
							error?: string;
						};
						const result = message.result;
						if (message.error || !result) {
							finish({ available: false, reason: "ipc-error" });
							return;
						}
						const reason = validate(result, deadlineAt);
						if (reason === undefined) {
							finish({ available: true, response: result });
						} else {
							finish({ available: false, reason });
						}
					} catch {
						finish({ available: false, reason: "schema-mismatch" });
					}
				},
				{
					label: "warm-diagnostics-reply",
					onOverflow: () => finish({ available: false, reason: "ipc-error" }),
				},
			),
		);
		socket.on("error", (error) =>
			finish({
				available: false,
				reason: isNoListenerError(error) ? "no-listener" : "ipc-error",
			}),
		);
		socket.on("close", () => finish({ available: false, reason: "ipc-error" }));
	});
}

export function requestWarmDiagnostics(
	cwd: string,
	incumbentPid: number,
	file: string,
	content: string,
	timeoutMs: number,
): Promise<WarmDiagnosticsResult> {
	const expectedHash = contentHash(content);
	return requestOverWarmIpc<WarmDiagnosticsResponse>(
		diagnosticsIpcPathForCwd(cwd, incumbentPid),
		timeoutMs,
		(deadlineAt): WarmDiagnosticsRequest => ({
			route: "diagnostics",
			version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
			file,
			cwd,
			content,
			contentHash: expectedHash,
			deadlineAt,
		}),
		(result, deadlineAt) => {
			if (
				result.route !== "diagnostics" ||
				result.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION
			) {
				return "schema-mismatch";
			}
			if (
				!result.fresh ||
				result.inconclusive ||
				result.contentHash !== expectedHash ||
				result.servedAt > deadlineAt
			) {
				return "stale-answer";
			}
			return undefined;
		},
	);
}

export function requestWarmCodeActions(
	cwd: string,
	incumbentPid: number,
	file: string,
	expectedContentHash: string,
	ranges: WarmCodeActionRange[],
	timeoutMs: number,
): Promise<WarmCodeActionsResult> {
	return requestOverWarmIpc<WarmCodeActionsResponse>(
		diagnosticsIpcPathForCwd(cwd, incumbentPid),
		timeoutMs,
		(deadlineAt): WarmCodeActionsRequest => ({
			route: "code-actions",
			version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
			file,
			cwd,
			contentHash: expectedContentHash,
			ranges,
			deadlineAt,
		}),
		(result, deadlineAt) => {
			if (
				result.route !== "code-actions" ||
				result.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION ||
				!Array.isArray(result.actions) ||
				result.actions.length !== ranges.length ||
				result.actions.some((actions) => !Array.isArray(actions))
			) {
				return "schema-mismatch";
			}
			if (
				result.contentHash !== expectedContentHash ||
				result.servedAt > deadlineAt
			) {
				return "stale-answer";
			}
			return undefined;
		},
	);
}

/** One IPC request: analyze a file in the warm server process. */
export interface WarmAnalyzeRequest {
	file: string;
	cwd: string;
}

// v2 adds an explicit receipt acknowledgement. A v1 server must reject rather
// than consume a pass without the new delivery contract.
export const WARM_TURN_END_SCHEMA_VERSION = 2;

/**
 * Turn-end over the WORKSPACE endpoint, not the PID-scoped one: a Claude Code
 * Stop hook knows its cwd, never the server's pid. Tagged so the untagged
 * analyze request on the same socket keeps working unchanged.
 */
export interface WarmTurnEndRequest {
	route: "turn-end";
	version: number;
	cwd: string;
}

export interface WarmTurnEndResponse {
	route: "turn-end";
	version: number;
	turnEnd?: string;
	tests?: string;
	/** Present when the server admitted a durable findings delivery. */
	deliveryId?: string;
}

interface WarmTurnEndAckRequest {
	route: "turn-end-ack";
	version: number;
	cwd: string;
	deliveryId: string;
}

interface WarmTurnEndAckResponse {
	route: "turn-end-ack";
	version: number;
	acknowledged: boolean;
}

export type WarmTurnEndResult =
	| { available: true; response: WarmTurnEndResponse }
	| { available: false; reason: WarmDiagnosticsFailureReason };

/**
 * Ask the warm server to run pi-lens's real turn-end pass. Execution and
 * delivery are separate: the first one-shot connection returns a capability,
 * then a second one-shot connection acknowledges receipt. If the client
 * deadline or either connection loses, the server leaves the durable finding
 * cache untouched for a later Stop. 55 s expires inside Claude Code's 60 s hook
 * timeout.
 */
export async function requestWarmTurnEnd(
	cwd: string,
	timeoutMs = 55_000,
): Promise<WarmTurnEndResult> {
	const startedAt = Date.now();
	const first = await requestOverWarmIpc<WarmTurnEndResponse>(
		ipcPathForCwd(cwd),
		timeoutMs,
		(): WarmTurnEndRequest => ({
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd,
		}),
		(result) =>
			result.route === "turn-end" &&
			result.version === WARM_TURN_END_SCHEMA_VERSION
				? undefined
				: "schema-mismatch",
	);
	if (!first.available || !first.response.deliveryId) return first;

	const remainingMs = timeoutMs - (Date.now() - startedAt);
	if (remainingMs <= 0) return { available: false, reason: "timeout" };
	const ack = await requestOverWarmIpc<WarmTurnEndAckResponse>(
		ipcPathForCwd(cwd),
		remainingMs,
		(): WarmTurnEndAckRequest => ({
			route: "turn-end-ack",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd,
			deliveryId: first.response.deliveryId!,
		}),
		(result) =>
			result.route === "turn-end-ack" && result.acknowledged === true
				? undefined
				: "ipc-error",
	);
	return ack.available
		? { available: true, response: first.response }
		: { available: false, reason: ack.reason };
}

// --- Turn-end status surface (#1272) ----------------------------------------
// The Stop hook runs in a SEPARATE, short-lived process, so a skip it decides
// (no warm server, timeout, schema skew) leaves no trace the long-lived MCP
// server could report. Before this, that skip was one stderr line the agent
// never sees — the exact invisible-state shape #544 fixed for auto-session.
// The hook records its outcome to a small per-workspace file; `pilens_health`
// reads it. Best-effort throughout: telemetry must never break a hook.

export interface TurnEndStatus {
	ran: number;
	skipped: number;
	failed: number;
	lastSkipReason?: string;
	lastRunAt?: string;
	lastSkipAt?: string;
	lastFailureOperation?: "analyze" | "turn-end";
	lastFailureReason?: string;
	lastFailureAt?: string;
}

/** Per-workspace status file, keyed by the same hash as the IPC endpoint. */
export function turnEndStatusPathForCwd(
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return path.join(
		os.tmpdir(),
		`pi-lens-turn-end-${workspaceHash(cwd, platform)}.json`,
	);
}

export function readTurnEndStatus(
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): TurnEndStatus | undefined {
	try {
		const raw = fs.readFileSync(turnEndStatusPathForCwd(cwd, platform), "utf8");
		const parsed = JSON.parse(raw) as Partial<TurnEndStatus> | null;
		if (!parsed || typeof parsed !== "object") return undefined;
		return {
			ran: typeof parsed.ran === "number" ? parsed.ran : 0,
			skipped: typeof parsed.skipped === "number" ? parsed.skipped : 0,
			failed: typeof parsed.failed === "number" ? parsed.failed : 0,
			lastSkipReason: parsed.lastSkipReason,
			lastRunAt: parsed.lastRunAt,
			lastSkipAt: parsed.lastSkipAt,
			lastFailureOperation: parsed.lastFailureOperation,
			lastFailureReason: parsed.lastFailureReason,
			lastFailureAt: parsed.lastFailureAt,
		};
	} catch {
		// never written, unreadable, or corrupt — "no turn-end activity recorded"
		return undefined;
	}
}

/**
 * Append a turn-end outcome or an unrunnable CLI/hook invocation. Never throws.
 *
 * Read-modify-write against a shared per-workspace tmpdir file: two Stop
 * hooks for the same workspace can race this concurrently (separate
 * processes, no lock). `writeFileAtomic` only closes the *publication* half
 * of that — it guarantees this write's own staging+rename can't torn-read
 * (parse-fail and reset counters) or hit a Windows sharing violation against
 * a concurrent writer's rename. It does NOT fix the read-modify-write race
 * itself: two overlapping calls can still both read the same `previous` and
 * publish from it, silently dropping one increment. That's accepted here —
 * this is bounded best-effort telemetry (self-heals, errors already
 * swallowed below), and a lock on this path isn't worth it.
 */
export function recordTurnEndOutcome(
	cwd: string,
	outcome:
		| { ran: true }
		| { ran: false; reason: string }
		| { failed: true; operation: "analyze" | "turn-end"; reason: string },
	platform: NodeJS.Platform = process.platform,
): void {
	try {
		const now = new Date().toISOString();
		const previous = readTurnEndStatus(cwd, platform) ?? {
			ran: 0,
			skipped: 0,
			failed: 0,
		};
		let next: TurnEndStatus;
		if ("failed" in outcome) {
			next = {
				...previous,
				failed: previous.failed + 1,
				lastFailureOperation: outcome.operation,
				lastFailureReason: outcome.reason,
				lastFailureAt: now,
			};
		} else {
			next = outcome.ran
				? { ...previous, ran: previous.ran + 1, lastRunAt: now }
				: {
						...previous,
						skipped: previous.skipped + 1,
						lastSkipReason: outcome.reason,
						lastSkipAt: now,
					};
		}
		// Writes THIS workspace's file and nothing else. #3255 round 2 also deleted
		// the file at the retired always-fold name; round 3 removed that, because
		// on a case-sensitive host that name is not an orphan — it is the live
		// current file of the case-variant sibling workspace, and the record
		// carries no ownership field that could tell the two apart. The
		// pre-upgrade file is left to the same existence gate every other stale
		// tmp artifact has: nothing derives that name any more, so nothing reads
		// it except a still-running pre-upgrade server, for which it is correct.
		writeFileAtomic(
			turnEndStatusPathForCwd(cwd, platform),
			`${JSON.stringify(next)}\n`,
		);
	} catch {
		// telemetry only — a read-only tmpdir must not break the Stop hook
	}
}

/**
 * Ask the warm server to analyze a file. Resolves the server's result, or
 * `undefined` on ANY failure (no server, refused, stale socket, timeout, bad
 * response) so the caller transparently falls back to cold local analysis.
 */
export function requestWarmAnalyze(
	cwd: string,
	file: string,
	timeoutMs = 30_000,
): Promise<McpAnalyzeResult | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: McpAnalyzeResult | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};

		const socket = net.createConnection(
			boundUnixSocketPath(ipcPathForCwd(cwd)),
		);
		socket.setEncoding("utf8");

		const timer = setTimeout(() => {
			socket.destroy();
			finish(undefined);
		}, timeoutMs);
		timer.unref();

		socket.on("connect", () => {
			const request: WarmAnalyzeRequest = { file, cwd };
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on(
			"data",
			createWarmIpcLineReader(
				(line) => {
					try {
						const message = JSON.parse(line) as {
							result?: McpAnalyzeResult;
							error?: string;
						};
						finish(message.error ? undefined : message.result);
					} catch {
						finish(undefined);
					}
					socket.end();
				},
				{
					label: "warm-analyze-reply",
					// `finish` here only clears the timer and resolves — unlike
					// `requestOverWarmIpc`'s, which destroys the socket itself — so the
					// peer that misframed would otherwise keep an open connection and
					// keep writing into a reader that ignores it.
					onOverflow: () => {
						socket.destroy();
						finish(undefined);
					},
				},
			),
		);
		// No server / connection refused / reset → cold fallback.
		socket.on("error", () => finish(undefined));
		socket.on("close", () => finish(undefined));
	});
}

/**
 * The ceiling on ONE newline-framed line, for every reader below (#3383).
 *
 * Deliberately the same number as the spawn output cap rather than a second one
 * to argue about: the largest legitimate line in this protocol is a
 * `requestWarmDiagnostics` request carrying a file's whole content, or the
 * diagnostics reply to it, and 32 MiB is far above anything the read guard lets
 * through while staying 16x below V8's max string length — so the
 * concatenation that crashed the host in #3375 is unreachable here rather than
 * merely unlikely.
 */
export const MAX_FRAMED_LINE_BYTES = DEFAULT_MAX_OUTPUT_BYTES;

/** Options for {@link createWarmIpcLineReader}. */
export interface WarmIpcLineReaderOptions {
	/**
	 * Which reader this is, as the ledger subject for an over-long line. A fixed
	 * small set (see the `ipc-frame-overflow` kind), never peer-supplied.
	 */
	label: string;
	/**
	 * Keep framing after the first line. Only the MCP host's stdin loop wants
	 * this — every socket reader here is one request per connection, and the
	 * default preserves #1219's one-shot latch.
	 */
	continuous?: boolean;
	/** The caller's own ending for an over-long line (the record is automatic). */
	onOverflow?: () => void;
}

/**
 * Newline-framed line reader for the warm IPC sockets and the MCP host's stdin.
 *
 * One-shot by default (#1219): the clients write exactly one newline-terminated
 * request per connection and read one reply, so the server must dispatch at
 * most one line and ignore anything after it — a `data` handler that keeps
 * re-reading the same buffered line re-dispatches the request on stray bytes.
 *
 * BOUNDED since #3383. Every reader used to be `buffer += chunk` with no
 * ceiling, so a peer that never sent a newline grew one JS string until the
 * request's own timeout fired — measured through `requestWarmAnalyze` against a
 * real socket: 64 MiB of newline-free reply, +929 MiB of heap, 20 s of it. Past
 * {@link MAX_FRAMED_LINE_BYTES} the line is DISCARDED, the overflow is recorded
 * once, and the caller's `onOverflow` decides the ending.
 *
 * The bound is on the FRAME, never on what is left over after a chunk's last
 * newline (#3388 review H3388-1). The first version checked only the
 * newline-free remainder, so a peer whose over-limit frame arrived with its
 * newline in the SAME `data` chunk — which is what a single TCP segment or one
 * `socket.write` produces — had its whole line dispatched, bound bypassed:
 * measured at 33,554,433 bytes delivered, 0 overflow callbacks, 0 records. So
 * each complete line is accounted for BEFORE it is dispatched, retained prefix
 * included, and the remainder check below is now only the unterminated case.
 *
 * RESYNC applies to the unterminated case alone. A discarded UNTERMINATED line
 * has a newline still to come, so framing skips to it and the next well-formed
 * line is read normally rather than parsed as the dropped line's tail. A
 * discarded COMPLETE line is already past its own newline, so framing continues
 * from there — resyncing would eat the next line instead.
 *
 * Returns the handler to attach to the stream's `data` event.
 */
export function createWarmIpcLineReader(
	onLine: (line: string) => void,
	options: WarmIpcLineReaderOptions,
): (chunk: string) => void {
	/** The unterminated head of a line, and its size. */
	let buffer = "";
	let bufferedBytes = 0;
	let dispatched = false;
	let resyncing = false;
	/**
	 * Drop the frame, record it once, and let the caller end the exchange.
	 * `awaitingNewline` is the difference between the two overflow shapes: an
	 * unterminated line must be skipped up to the newline that has not arrived
	 * yet, a complete one must not, because framing is already past its newline.
	 */
	const overflow = (frameBytes: number, awaitingNewline: boolean): void => {
		buffer = "";
		bufferedBytes = 0;
		resyncing = awaitingNewline;
		if (options.continuous !== true) dispatched = true;
		incrementDegradationCount({
			kind: "ipc-frame-overflow",
			subject: options.label,
			reason: `discarded ${
				awaitingNewline ? "an unterminated" : "a complete"
			} line at ${frameBytes} bytes (limit ${MAX_FRAMED_LINE_BYTES})`,
			metadata: {
				limitBytes: MAX_FRAMED_LINE_BYTES,
				overflowBytes: frameBytes,
				terminated: !awaitingNewline,
			},
		});
		options.onOverflow?.();
	};
	return (chunk: string) => {
		if (dispatched) return;
		// Every scan below runs over the NEW chunk at an offset, never over the
		// retained buffer, and the retained bytes are carried rather than
		// re-measured. Both matter once the buffer is allowed to reach the bound:
		// `retained.indexOf()` flattens the accumulated rope on every socket read,
		// and one 36 MiB unframed reply arrives as ~550 reads, so the bound alone
		// would trade an unbounded string for seconds of CPU. Measured on
		// `tests/clients/mcp/ipc-frame-bounds.test.ts`, whose real-socket case
		// sends exactly that: 16.2 s with a rescan per read, 1.2 s with this.
		let from = 0;
		if (resyncing) {
			// Still inside the over-long line: retain nothing until its newline.
			const end = chunk.indexOf("\n");
			if (end === -1) return;
			resyncing = false;
			from = end + 1;
		}
		let newline = chunk.indexOf("\n", from);
		while (newline !== -1) {
			const segment = chunk.slice(from, newline);
			from = newline + 1;
			// H3388-1: the FRAME's length — this chunk's segment plus whatever was
			// retained for it — decided before the line exists as a string.
			const frameBytes = bufferedBytes + Buffer.byteLength(segment);
			if (frameBytes > MAX_FRAMED_LINE_BYTES) {
				overflow(frameBytes, false);
				if (dispatched) return;
				newline = chunk.indexOf("\n", from);
				continue;
			}
			const line = buffer + segment;
			buffer = "";
			bufferedBytes = 0;
			if (options.continuous !== true) {
				dispatched = true;
				onLine(line);
				return;
			}
			onLine(line);
			newline = chunk.indexOf("\n", from);
		}
		if (from < chunk.length) {
			const rest = chunk.slice(from);
			buffer += rest;
			bufferedBytes += Buffer.byteLength(rest);
		}
		if (bufferedBytes <= MAX_FRAMED_LINE_BYTES) return;
		overflow(bufferedBytes, true);
	};
}

export function createWarmIpcRequestQueue(): {
	enqueue<T>(work: () => Promise<T>): Promise<T>;
} {
	let chain: Promise<unknown> = Promise.resolve();
	return {
		enqueue<T>(work: () => Promise<T>): Promise<T> {
			const next = chain.then(work);
			chain = next.catch(() => undefined);
			return next;
		},
	};
}
