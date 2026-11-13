import * as net from "node:net";
import * as path from "node:path";
import {
	type InstanceEntry,
	readInstanceRegistry,
	selectLivePeerInstances,
} from "./instance-registry.js";
import { realIsPidAlive } from "./instance-reaper.js";
import { withinRemaining } from "./deadline-utils.js";
import { logLatency } from "./latency-logger.js";
import type { LSPDiagnostic } from "./lsp/client.js";
import { touchCoverageGap } from "./lsp/diagnostic-binding.js";
import { hasInferredProjectCandidates } from "./lsp/inferred-project.js";
import {
	fetchTsserverProjectIdentity,
	type TsserverProjectIdentity,
	type TsserverSyncCapableService,
} from "./lsp/tsserver-sync.js";
import { loadLspService } from "./lsp-lazy.js";
import {
	boundUnixSocketPath,
	contentHash,
	createWarmIpcLineReader,
	diagnosticsIpcPathForCwd,
	requestWarmCodeActions,
	requestWarmDiagnostics,
	unlinkStaleUnixSocket,
	type WarmCodeActionRange,
	type WarmCodeActionsResult,
	type WarmCodeActionsRequest,
	type WarmCodeActionsResponse,
	type WarmDiagnosticsRequest,
	type WarmDiagnosticsResult,
	WARM_CODE_ACTION_LOOKUP_LIMIT,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
} from "./mcp/ipc.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { normalizeFilePath } from "./path-utils.js";

interface AttachState {
	cwd?: string;
	incumbentPid?: number;
	local: boolean;
	server?: net.Server;
	servedDiagnosticHashes: Map<string, string>;
}

const state: AttachState = { local: true, servedDiagnosticHashes: new Map() };

function record(
	event: string,
	cwd: string,
	reason?: string,
	pid?: number,
	source?: "per-edit" | "sweep",
): void {
	logLatency({
		type: "phase",
		phase: "lsp_warm_attach",
		filePath: cwd,
		durationMs: 0,
		metadata: { event, reason, incumbentPid: pid, source },
	});
}

/**
 * The oldest live peer on this root, if any. The liveness rule itself lives
 * in `selectLivePeerInstances` (#2007) so warm-attach and the shared-checkout
 * guard cannot drift apart about what "another session is here" means.
 */
export function selectWarmAttachIncumbent(
	entries: readonly InstanceEntry[],
	cwd: string,
	now = Date.now(),
	isPidAlive: (pid: number) => boolean = realIsPidAlive,
): InstanceEntry | undefined {
	return selectLivePeerInstances(entries, cwd, now, isPidAlive)[0];
}

/**
 * #4645: how long before the request's deadline the incumbent stops waiting on
 * the membership probe. The client arms its own timer for that same deadline
 * and refuses a reply served after it, so a probe allowed to run to the
 * deadline made the reply late by timer slack alone, and the client then
 * dropped warm attach for the rest of the session. A chosen margin, not a
 * measurement: it covers the reply's write and one event-loop turn on each
 * side. It is taken from the probe only, never from the touch.
 */
const WARM_REPLY_SEND_RESERVE_MS = 100;

/**
 * The incumbent's membership probe, bounded by `probeDeadlineAt`. Asked only
 * when the answer could change a row (`hasInferredProjectCandidates`, the
 * owner's own precondition). A probe that cannot settle in time is abandoned:
 * the reply goes out without the verdict, the pre-#4645 answer, and one record
 * per session per cause says an attached read got no membership verdict.
 */
function askProjectMembership(
	raw: LSPDiagnostic[],
	file: string,
	service: TsserverSyncCapableService,
	probeDeadlineAt: number,
): Promise<TsserverProjectIdentity | undefined> {
	if (!hasInferredProjectCandidates(raw, file))
		return Promise.resolve(undefined);
	const abandoned = (cause: "probe-timeout" | "no-time-left"): undefined => {
		recordDegradationOnce({
			kind: "warm-attach-membership-probe-abandoned",
			subject: cause,
			reason:
				"the membership probe did not settle before the warm reply's send reserve, so the reply carried no inferred-project verdict and the attached reader rendered the server's raw severity",
			metadata: { file, reserveMs: WARM_REPLY_SEND_RESERVE_MS },
		});
		return undefined;
	};
	if (probeDeadlineAt <= Date.now()) {
		return Promise.resolve(abandoned("no-time-left"));
	}
	return withinRemaining(
		fetchTsserverProjectIdentity(service, file).then((identity) => ({
			identity,
		})),
		probeDeadlineAt,
	).then((settled) =>
		settled === undefined ? abandoned("probe-timeout") : settled.identity,
	);
}

async function serveRequest(
	req: WarmDiagnosticsRequest | WarmCodeActionsRequest,
): Promise<{ result?: unknown; error?: string }> {
	if (req.route === "code-actions") {
		if (
			req.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION ||
			req.ranges.length > WARM_CODE_ACTION_LOOKUP_LIMIT ||
			Date.now() > req.deadlineAt ||
			state.servedDiagnosticHashes.get(normalizeFilePath(req.file)) !==
				req.contentHash
		) {
			return { error: "stale request" };
		}
		try {
			const actions = await Promise.all(
				req.ranges.map(async (range) => {
					if (Date.now() > req.deadlineAt) {
						throw new Error("deadline exceeded");
					}
					return (await loadLspService())
						.getLSPService()
						.codeAction(
							req.file,
							range.start.line,
							range.start.character,
							range.end.line,
							range.end.character,
						)
						.then((actions) => actions ?? []);
				}),
			);
			const servedAt = Date.now();
			if (servedAt > req.deadlineAt) return { error: "deadline exceeded" };
			return {
				result: {
					route: "code-actions",
					version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
					contentHash: req.contentHash,
					servedAt,
					actions,
				} satisfies WarmCodeActionsResponse,
			};
		} catch (error) {
			return { error: String(error) };
		}
	}
	if (
		req.route !== "diagnostics" ||
		req.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION
	) {
		return { error: "schema mismatch" };
	}
	if (
		Date.now() > req.deadlineAt ||
		contentHash(req.content) !== req.contentHash
	) {
		return { error: "stale request" };
	}
	const service = (await loadLspService()).getLSPService();
	const touched = await service.touchFile(req.file, req.content, {
		diagnostics: "document",
		collectDiagnostics: true,
		clientScope: "with-auxiliary",
		maxClientWaitMs: Math.max(1, req.deadlineAt - Date.now()),
		maxDiagnosticsWaitMs: Math.max(1, req.deadlineAt - Date.now()),
		source: "warm-attach-incumbent",
	});
	// #4645: the membership verdict needs this process's live tsserver, so it
	// is asked here, and the answer crosses the socket beside the server's raw
	// rows. The reader runs the one demotion pipeline with it (environment rule
	// first, then membership), so the rows it renders and the form its cache
	// stores are what a local read gives; demoting here would bake the
	// environment verdict, which depends on install state no cache entry keys
	// on, into what an attached batch cache replays.
	const raw = touched?.diags ?? [];
	const projectIdentity = await askProjectMembership(
		raw,
		req.file,
		service,
		req.deadlineAt - WARM_REPLY_SEND_RESERVE_MS,
	);
	const servedAt = Date.now();
	// #1470: the coverage gap is read through the shared helper, never re-derived
	// from `confirmation === "partial"`. The two fields are set together today, so
	// either test passes — which is exactly the coincidence `touchCoverageGap`'s
	// own doc comment warns against. One reader, one rule.
	const coverageGap = touchCoverageGap(touched);
	if (
		servedAt <= req.deadlineAt &&
		touched !== undefined &&
		!touched.inconclusive
	) {
		state.servedDiagnosticHashes.set(
			normalizeFilePath(req.file),
			req.contentHash,
		);
	}
	return {
		result: {
			route: "diagnostics",
			version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
			// #1179: `touchFile` now returns the `{ diags, inconclusive, binding }`
			// wrapper — take the array off `.diags`. This is the canonical shape-5
			// serialization boundary: the diagnostics array crosses the IPC socket
			// and `inconclusive` is re-surfaced below as an EXPLICIT enumerable DTO
			// field (no side-channel survives `JSON.stringify`).
			diagnostics: raw,
			// #4645: an EXPLICIT enumerable field, omitted when unknown, so an older
			// reader parses the same bytes an older incumbent sends.
			...(projectIdentity !== undefined ? { projectIdentity } : {}),
			contentHash: req.contentHash,
			servedAt,
			fresh: servedAt <= req.deadlineAt && touched !== undefined,
			inconclusive: touched?.inconclusive === true,
			// #5030: the touch's content binding, as an explicit enumerable field
			// like `inconclusive` above (a binding hung off the diagnostics array
			// does not survive `JSON.stringify`). Always sent, `"unknown"` for a
			// touch that composed none, so a reader can tell an incumbent that
			// predates the field (absent) from one that has no verdict.
			binding: touched?.binding ?? { boundToCurrentDisk: "unknown" },
			// #1253: carry the touch's own confirmation verdict across the socket
			// as an explicit enumerable field (same doctrine as `inconclusive`) —
			// without it, an incumbent-served empty result from a silent-on-clean
			// server is indistinguishable from "never answered" on the far side.
			...(touched?.confirmation === "confirmed"
				? { confirmation: "confirmed" as const }
				: {}),
			// #1470: a PARTIAL touch crosses the socket as itself rather than as a
			// missing key. Omitting it would still fail closed on the far side, but it
			// would be indistinguishable from an old incumbent that never sent the
			// field — and the whole point of narrowing is that the reader can tell
			// which coverage is real.
			...(coverageGap.length > 0
				? {
						confirmation: "partial" as const,
						unconfirmedServerIds: [...coverageGap],
					}
				: {}),
		},
	};
}

function startServer(cwd: string): void {
	state.server?.close();
	const endpoint = diagnosticsIpcPathForCwd(cwd, process.pid);
	// Only a stale socket at a name that still carries OUR pid: a bounded
	// shared name may be another live session's endpoint (#4376 review r1, F1).
	unlinkStaleUnixSocket(endpoint, { ownerPid: process.pid });
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		// #3389: an ACCEPTED socket with no `error` listener rethrows, and
		// `server.on("error")` below covers only the listener. A client that walks
		// away while this incumbent is answering — every `requestWarmDiagnostics`
		// timeout, schema refusal and validation refusal destroys its socket
		// (`clients/mcp/ipc.ts:312`) — therefore turned a routine
		// `read ECONNRESET` into an uncaught exception in THIS host, the same
		// ending #3375 closed for an unbounded `data` handler. The handler does NOT
		// tear the connection down: a real system failure has already destroyed the
		// stream before this runs (measured: `destroyed` is true at entry), and an
		// `error` emitted with no errno leaves a socket that is still answering
		// (review round 1) — destroying that one would drop a live request. So the
		// handler exists to keep the event catchable and to leave the peer's
		// behavior visible in the ledger.
		socket.on("error", (failure) => {
			incrementDegradationCount({
				// Subject is the errno, so one peer's repeated resets stay one row.
				// No `?? "unknown"` fallback: `normalizeForLedger`
				// (`clients/ledger-bounds.ts:29`) already maps a missing value to
				// `"unknown"`, and a second copy of that rule here was a branch no
				// mutation could red (#3389 review round 1, F3395-01) — an error
				// emitted with no `code` is pinned end-to-end in
				// `tests/clients/warm-attach-socket-error.test.ts`.
				kind: "warm-attach-socket-error",
				subject: (failure as NodeJS.ErrnoException).code,
				reason: String(failure),
			});
		});
		// One-shot per connection (#1219 family): the same defect shape as the
		// MCP warm socket — clients write exactly one request and read one
		// reply, so a handler that kept re-reading the same buffered line
		// re-dispatched the request on stray bytes. The shared reader consumes
		// the line and ignores anything after it.
		socket.on(
			"data",
			createWarmIpcLineReader(
				(line) => {
					void (async () => {
						try {
							const req = JSON.parse(line) as
								| WarmDiagnosticsRequest
								| WarmCodeActionsRequest;
							socket.end(`${JSON.stringify(await serveRequest(req))}\n`);
						} catch (error) {
							socket.end(`${JSON.stringify({ error: String(error) })}\n`);
						}
					})();
				},
				{
					label: "warm-attach-server",
					// #3383: an unterminated request line is answered like any other
					// unusable request rather than buffered without a ceiling.
					onOverflow: () =>
						socket.end(
							`${JSON.stringify({ error: "warm request line exceeded the framing limit" })}\n`,
						),
				},
			),
		);
	});
	server.on("error", (error) => {
		record("listener-error", cwd, String(error));
	});
	server.listen(boundUnixSocketPath(endpoint));
	server.unref();
	state.server = server;
}

export async function configureWarmAttach(cwd: string): Promise<void> {
	state.cwd = path.resolve(cwd);
	state.incumbentPid = undefined;
	state.local = true;
	if (process.env.PI_LENS_WARM_ATTACH !== "1") {
		record("disabled", state.cwd, "opt-in-not-enabled");
		return;
	}
	startServer(state.cwd);
	const incumbent = selectWarmAttachIncumbent(
		await readInstanceRegistry(),
		state.cwd,
	);
	if (!incumbent) {
		record("local", state.cwd, "no-live-incumbent");
		return;
	}
	state.incumbentPid = incumbent.pid;
	state.local = false;
	record("attached", state.cwd, undefined, incumbent.pid);
}

export async function tryWarmAttachedDiagnostics(
	file: string,
	content: string,
	timeoutMs: number,
	source: "per-edit" | "sweep" = "per-edit",
): Promise<WarmDiagnosticsResult | undefined> {
	if (state.local || !state.cwd || !state.incumbentPid) return undefined;
	const entries = await readInstanceRegistry();
	const incumbent = selectWarmAttachIncumbent(entries, state.cwd);
	if (incumbent?.pid !== state.incumbentPid) {
		promoteToLocal("incumbent-stale-or-exited");
		return undefined;
	}
	const result = await requestWarmDiagnostics(
		state.cwd,
		state.incumbentPid,
		file,
		content,
		timeoutMs,
	);
	if (!result.available) {
		// #3255 H1: a confirmed-alive incumbent whose endpoint has no listener is
		// the upgrade-stranded shape — narrowing the workspace-id case fold
		// renamed the socket, so a peer that registered before the upgrade is
		// still serving the previous name. `promoteToLocal` alone left that in the
		// latency log only; this is the entry `/lens-perf` renders. Bounded twice
		// over: once per kind/subject by the ledger, and once per session by
		// `promoteToLocal`'s latch, which returns early on every later call.
		if (result.reason === "no-listener") {
			recordDegradationOnce({
				kind: "warm-ipc-endpoint-missing",
				subject: diagnosticsIpcPathForCwd(state.cwd, state.incumbentPid),
				reason:
					"the registry confirms this incumbent is alive but nothing is listening on its derived endpoint — if pi-lens was upgraded while it was running, restart it",
			});
		}
		promoteToLocal(result.reason);
	} else {
		record("diagnostics-served", file, undefined, state.incumbentPid, source);
	}
	return result;
}

export async function tryWarmAttachedCodeActions(
	file: string,
	expectedContentHash: string,
	ranges: WarmCodeActionRange[],
	timeoutMs: number,
): Promise<WarmCodeActionsResult | undefined> {
	if (state.local || !state.cwd || !state.incumbentPid) return undefined;
	const result = await requestWarmCodeActions(
		state.cwd,
		state.incumbentPid,
		file,
		expectedContentHash,
		ranges,
		timeoutMs,
	);
	if (result.available) {
		record("code-actions-served", file, undefined, state.incumbentPid);
	} else {
		// Quickfixes are optional enrichment. Diagnostics already succeeded, so a
		// code-action failure is deliberately softer and must not trigger takeover.
		record("code-actions-skipped", file, result.reason, state.incumbentPid);
	}
	return result;
}

export function isWarmAttached(): boolean {
	return !state.local && state.incumbentPid !== undefined;
}

function promoteToLocal(reason: string): void {
	if (state.local) return;
	const pid = state.incumbentPid;
	state.local = true;
	state.incumbentPid = undefined;
	record("takeover", state.cwd ?? process.cwd(), reason, pid);
}

export function _resetWarmAttachForTests(): void {
	state.server?.close();
	state.server = undefined;
	state.cwd = undefined;
	state.incumbentPid = undefined;
	state.local = true;
	state.servedDiagnosticHashes.clear();
}

/**
 * The live diagnostics server, exposed for tests (#3389 review round 1,
 * F3395-01). The `error` handler on an ACCEPTED socket has exactly one input
 * channel — an `error` event on that socket — and a test cannot reach the
 * socket any other way: it is created by `net.createServer` inside the closure
 * above, and Node's ESM namespace for `node:net` is not configurable, so the
 * factory cannot be wrapped from a test either. A test observes the server's
 * own `connection` event through this accessor; nothing in production reads it.
 */
export function _warmAttachServerForTests(): net.Server | undefined {
	return state.server;
}

export function _setWarmAttachForTests(
	cwd: string,
	incumbentPid: number,
): void {
	state.cwd = path.resolve(cwd);
	state.incumbentPid = incumbentPid;
	state.local = false;
}

/**
 * The incumbent-side request handler, exposed for tests. The socket wiring
 * around it (`startServer`) can only be exercised by a test that actually
 * binds a unix socket, which is not available in every sandbox — this seam
 * lets the DTO-composition half (notably the #1253 `confirmation` field, whose
 * absence is what a consumer reads as unconfirmed) be pinned directly.
 */
export const _serveWarmRequestForTests = serveRequest;
