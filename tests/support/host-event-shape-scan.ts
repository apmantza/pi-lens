/**
 * Mechanical scan for `session_start` / `tool_call` / `tool_result` /
 * `agent_end` / `agent_settled` test fixtures that put fields on the EVENT
 * object the real pi host never puts there — #1681.
 *
 * Ground truth is the host source (earendil-works/pi), not this repo's own
 * assumptions. Each of the five events pi-lens registers a handler for
 * (`index.ts`'s `EXPECTED_HOOKS`), by its full field list in
 * `packages/coding-agent/src/core/extensions/types.ts`:
 *
 * - `SessionStartEvent` (561-568): `type`, `reason`, `previousSessionFile`.
 *   Every construction site (`agent-session.ts:393,2725`,
 *   `agent-session-runtime.ts:218,251,305,328,347,391`) builds only those.
 * - `ToolCallEventBase` (869-872) plus its per-tool variants: `type`,
 *   `toolCallId`, `toolName`, `input`.
 * - `ToolResultEventBase` (930-939): `type`, `toolCallId`, `input`, `content`,
 *   `isError`, `usage?`, plus a per-tool `details`/`toolName`. The one
 *   construction site (`agent-session.ts:503-516`) builds only those — also
 *   pinned against the host's own compiled build by
 *   `tests/clients/pi-host-contract.test.ts`'s `HOST_TOOL_RESULT_KEYS`.
 * - `AgentEndEvent` (733-736): `type`, `messages`.
 * - `AgentSettledEvent` (739-741): `type` only.
 *
 * None of the five carries `sessionId`, `provider`, or `model` — a handler
 * that wants any of those reads them off `ctx`
 * (`ctx.sessionManager.getSessionId()`, `ctx.model`), never off the event.
 * `tests/support/pi-mock.ts`'s `makeCtx` already encodes this correctly; this
 * scan is what stops a fixture from drifting back to putting them on the
 * event instead (the #1681 index-wiring instance:
 * `{ sessionId: "wiring-session" }` as the SECOND arg to
 * `pi.emit("session_start", ...)`).
 *
 * Unlike `session-state-scan.ts`'s registry, this needs no hand-maintained
 * exemption list: there is no legitimate reason for any of these five
 * fixtures to carry any of these three fields, so any hit is a violation. A
 * suite that genuinely needs an off-contract shape to test defensive
 * handling should construct it by hand with a comment saying so, not through
 * `.emit(...)` with one of these five event-type strings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { toPosix } from "../../clients/path-utils.js";
import { stripCommentsAndStrings } from "./session-state-scan.ts";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const TESTS_ROOT = path.join(repoRoot, "tests");

/** Every `.ts`/`.mjs` file under `tests/`. */
function testFiles(dir = TESTS_ROOT): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) return testFiles(entryPath);
		if (!/\.(ts|mjs)$/.test(entry.name)) return [];
		return [entryPath];
	});
}

/** `tests/`-relative posix path for an absolute path under `tests/`. */
function testsRelative(absolute: string): string {
	return toPosix(path.relative(TESTS_ROOT, absolute));
}

const EVENT_TYPES = [
	"session_start",
	"tool_call",
	"tool_result",
	"agent_end",
	"agent_settled",
] as const;

/** Fields the real host never puts on any of the {@link EVENT_TYPES} events. */
const FORBIDDEN_EVENT_FIELDS = ["sessionId", "provider", "model"] as const;

/** One event-literal object that carries a field the real host never sends. */
export interface HostEventShapeViolation {
	/** `tests/`-relative posix path of the file containing the literal. */
	file: string;
	/** 1-based line number the literal starts on. */
	line: number;
	/** Which event type the literal was built for. */
	eventType: (typeof EVENT_TYPES)[number];
	/** Which forbidden field was found inside it. */
	field: (typeof FORBIDDEN_EVENT_FIELDS)[number];
}

/**
 * Find the object literal passed as `.emit("<eventType>", <HERE>, ...)`, by
 * brace-matching from the first `{` after the event-type argument's comma.
 * `source` must already be {@link stripCommentsAndStrings}-processed so a
 * `{`/`}` inside a comment or string cannot throw off the depth counter.
 */
function eventArgLiteral(
	source: string,
	matchEnd: number,
): { text: string; start: number } | undefined {
	const openBrace = source.indexOf("{", matchEnd);
	if (openBrace < 0) return undefined;
	// The event-type argument and the payload argument must be adjacent
	// (only whitespace/comma between them) — otherwise this `{` belongs to a
	// later, unrelated argument (e.g. a third `ctx` argument's own literal).
	const between = source.slice(matchEnd, openBrace);
	if (!/^[\s,]*$/.test(between)) return undefined;
	let depth = 0;
	for (let i = openBrace; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0)
				return { text: source.slice(openBrace, i + 1), start: openBrace };
		}
	}
	return undefined;
}

/**
 * The forbidden-field violations in a single file's already-read source.
 * Pure (no filesystem access) so the mutation-proof probes in
 * `host-event-shape-scan.test.ts` can exercise the real detection logic
 * against synthetic source, without writing throwaway files under `tests/`.
 */
export function scanSourceForHostEventShapeViolations(
	file: string,
	raw: string,
): HostEventShapeViolation[] {
	const violations: HostEventShapeViolation[] = [];
	const stripped = stripCommentsAndStrings(raw);
	// The event-type name itself is a quoted string literal, so it must be
	// matched against the RAW source — `stripCommentsAndStrings` blanks quoted
	// content by design (that's what keeps a `sessionId` mentioned only in a
	// comment or string from being mistaken for a real field, below) and would
	// blank "session_start"/"tool_result" right along with it. `stripped` has
	// the same LENGTH and line breaks as `raw` (that invariant is the whole
	// point of the shared stripper), so an index found in one lines up in the
	// other — the brace match and field search below run on `stripped`.
	const callSite =
		/\.emit\(\s*["'](session_start|tool_call|tool_result|agent_end|agent_settled)["']/g;
	for (const match of raw.matchAll(callSite)) {
		const eventType = match[1] as (typeof EVENT_TYPES)[number];
		const literal = eventArgLiteral(stripped, match.index + match[0].length);
		if (!literal) continue;
		for (const field of FORBIDDEN_EVENT_FIELDS) {
			const fieldPattern = new RegExp(`\\b${field}\\s*:`);
			if (fieldPattern.test(literal.text)) {
				const line = raw.slice(0, literal.start).split("\n").length;
				violations.push({ file, line, eventType, field });
			}
		}
	}
	return violations;
}

/** Every fixture literal, across the five {@link EVENT_TYPES}, carrying a forbidden field. */
export function scanHostEventShapeViolations(): HostEventShapeViolation[] {
	const violations: HostEventShapeViolation[] = [];
	for (const absolute of testFiles()) {
		const raw = fs.readFileSync(absolute, "utf8");
		violations.push(
			...scanSourceForHostEventShapeViolations(testsRelative(absolute), raw),
		);
	}
	return violations;
}

/** Number of test source files visited by the production walk. */
export function hostEventShapeScanFileCount(): number {
	return testFiles().length;
}
