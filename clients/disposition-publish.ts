/**
 * Publishes `pilens:diagnostic:disposition` on pi's shared `pi.events` bus
 * (#690).
 *
 * Sibling to `clients/diagnostics-publish.ts` (#502) rather than a new export
 * inside it, per the "owns nothing in common" rule spelled out in
 * format-events-publish.ts's header: the event is diagnostic-DOMAIN, but it
 * shares none of diagnostics-publish's module state or contract —
 * dispositions are point-in-time FACTS ("a mark just happened"), not
 * full-replace state snapshots, so the seq counter, the
 * previously-reported-dirty set, and the whole staleness/replace consumer
 * contract over there simply don't apply here. Only the emit plumbing shape
 * and the `PI_LENS_BUS_PUBLISH` kill switch (`isBusPublishEnabled`, imported
 * from bus-publish.ts) are shared, same as every other producer sibling.
 *
 * Fire-and-forget: publishing must never affect the mark path's success or
 * latency. Any failure is swallowed; `dbg` fires at most once per process on
 * first failure so a wired caller can log it without spamming.
 *
 * Versioning policy: frozen-additive, same discipline as #482/#502. New
 * optional fields may be added under `v: 1`; a breaking change to an existing
 * field's meaning must bump `v`.
 */
import { logBusEvent } from "./bus-events-logger.js";
import { isBusPublishEnabled } from "./bus-publish.js";
import { normalizeFilePath } from "./path-utils.js";

export const BUS_DISPOSITION_EVENT = "pilens:diagnostic:disposition";
export const BUS_DISPOSITION_VERSION = 1;

export interface PilensDispositionPayload {
	v: typeof BUS_DISPOSITION_VERSION;
	source: "pi-lens";
	cwd: string;
	/** Absolute, normalized path (forward slashes — same normalization as #482 `paths`). */
	filePath: string;
	disposition: string;
	tool?: string;
	rule?: string;
	line?: number;
	anchor: string;
	reason?: string;
}

type BusEmitFn = (channel: string, data: unknown) => void;

let busEmit: BusEmitFn | undefined;
let hasLoggedFailure = false;
let hasLoggedUnwired = false;
let hasLoggedDisabled = false;

/**
 * Wire the emit function from pi's `pi.events` bus. Called once at extension
 * factory time from index.ts, same call as `wireDiagnosticsBusEmitter` (#502)
 * — both producers share the identical `pi.events.emit` binding. Never called
 * ⇒ `publishDisposition` no-ops, which is exactly the state unit tests and
 * the MCP server path run in (no pi host, no `pi.events`).
 */
export function wireDispositionBusEmitter(emitFn: BusEmitFn | undefined): void {
	busEmit = emitFn;
}

/** Test-only: reset module state between test files. */
export function _resetDispositionPublishForTests(): void {
	busEmit = undefined;
	hasLoggedFailure = false;
	hasLoggedUnwired = false;
	hasLoggedDisabled = false;
}

export interface PublishDispositionArgs {
	cwd: string;
	/** Absolute path (pre-normalization — this function normalizes). */
	filePath: string;
	disposition: string;
	tool?: string;
	rule?: string;
	line?: number;
	anchor: string;
	reason?: string;
	dbg?: (msg: string) => void;
}

/**
 * Publish one `pilens:diagnostic:disposition` event for a mark (one event per
 * markDisposition call). Fire-and-forget: never throws, never awaited.
 */
export function publishDisposition(args: PublishDispositionArgs): void {
	if (!isBusPublishEnabled()) {
		if (!hasLoggedDisabled) {
			hasLoggedDisabled = true;
			logBusEvent({
				event: BUS_DISPOSITION_EVENT,
				outcome: "skipped_disabled",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}
	if (!busEmit) {
		if (!hasLoggedUnwired) {
			hasLoggedUnwired = true;
			logBusEvent({
				event: BUS_DISPOSITION_EVENT,
				outcome: "skipped_unwired",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}

	try {
		const payload: PilensDispositionPayload = {
			v: BUS_DISPOSITION_VERSION,
			source: "pi-lens",
			cwd: normalizeFilePath(args.cwd),
			filePath: normalizeFilePath(args.filePath),
			disposition: args.disposition,
			tool: args.tool,
			rule: args.rule,
			line: args.line,
			anchor: args.anchor,
			reason: args.reason,
		};
		busEmit(BUS_DISPOSITION_EVENT, payload);
		logBusEvent({
			event: BUS_DISPOSITION_EVENT,
			outcome: "emitted",
			cwd: payload.cwd,
		});
	} catch (err) {
		logBusEvent({
			event: BUS_DISPOSITION_EVENT,
			outcome: "emit_failed",
			cwd: normalizeFilePath(args.cwd),
			error: String(err),
		});
		if (!hasLoggedFailure) {
			hasLoggedFailure = true;
			args.dbg?.(
				`disposition-publish: pilens:diagnostic:disposition emit failed (further failures suppressed): ${err}`,
			);
		}
	}
}
