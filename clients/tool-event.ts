/**
 * Local re-implementation of the host SDK's `isToolCallEventType`.
 *
 * Why this exists instead of importing from `@earendil-works/pi-coding-agent`:
 * pi installs extension dependencies with `npm install --omit=dev`, so the host
 * coding-agent package is NOT present in the extension's `node_modules` at
 * runtime. Importing a *runtime value* from it therefore fails to resolve on a
 * clean install. Pulling it in as a real dependency is worse — it drags a huge
 * transitive tree (LLM provider SDKs) whose deeply nested paths exceed Windows'
 * MAX_PATH, which breaks `git clean -fdx` during `pi update`.
 *
 * The SDK function is a one-line discriminant check, so we inline it and keep
 * every `@earendil-works/pi-coding-agent` import type-only (types compile away).
 * `tests/host-sdk-type-only.test.ts` pins that invariant.
 *
 * ## S6 audit: the per-tool `is*ToolResult` discriminators (#1334)
 *
 * The SDK also exports seven `tool_result` discriminators — `isBashToolResult`,
 * `isReadToolResult`, `isEditToolResult`, `isWriteToolResult`,
 * `isGrepToolResult`, `isFindToolResult`, `isLsToolResult`. pi-lens does NOT
 * consolidate onto them, and the reasons are worth recording so the question
 * isn't relitigated:
 *
 * 1. **They are runtime values, not types.** Same `--omit=dev` constraint as
 *    above — importing them would break on a clean user install. Inlining them
 *    is the only option, and each one's entire body is verbatim
 *    `e.toolName === "<name>"` (checked against the pinned SDK's `types.js`).
 * 2. **`isToolCallEventType` already subsumes all seven.** It is the SDK's own
 *    generic form of the same check, and it is already inlined below and used
 *    at pi-lens's `tool_call` sites. Adding seven fixed-name aliases of a
 *    generic we already have would be indirection, not consolidation.
 * 3. **The seven cover strictly fewer tools than pi-lens intercepts.** They
 *    enumerate the built-ins only; pi-lens's `tool_call`/`tool_result` paths
 *    also key off `lsp_navigation` and pi-lens's own registered tools, which no
 *    host discriminator names.
 * 4. **The host union is narrower than the events pi-lens handles.** The host
 *    `ToolResultEvent` declares `toolCallId`/`input`/`content`/`isError`/
 *    `details`/`usage`; pi-lens's local `ToolResultEvent`
 *    (`clients/runtime-tool-result.ts`) declares the subset it reads. It used
 *    to additionally carry `id`/`callId`/`requestId`/`provider`/`model`/
 *    `sessionId`/`session` "for the telemetry-identity path" — #1655 item 2
 *    deleted all seven, because pi's `afterToolCall` builds the event with
 *    exactly `type`/`toolName`/`toolCallId`/`input`/`content`/`details`/
 *    `isError`/`usage` (`dist/core/agent-session.js:243-256`, source
 *    `src/core/agent-session.ts:502-516`), so the branch reading them was dead
 *    code. The standing reason not to narrow is point 3: pi-lens also
 *    synthesizes its OWN `tool_result` payloads (bash-derived writes,
 *    partial-apply) that no host discriminator would admit.
 *
 * What IS consolidated is the part that costs nothing: the host's `details`
 * SHAPES are type-only exports, so `EditToolDetails` & co. are imported as
 * types rather than re-declared ad hoc. Genuinely pi-lens-specific `details`
 * payloads (`searchReads`, `piLensPartialApply`) stay hand-declared — no host
 * type describes them.
 */
import { sanitizeCorrelationId } from "./read-guard-logger.js";

export function isToolCallEventType<T extends string>(
	toolName: T,
	event: unknown,
): boolean {
	return (
		!!event &&
		typeof event === "object" &&
		(event as { toolName?: unknown }).toolName === toolName
	);
}

/**
 * Resolve a STABLE correlation id shared between a `tool_call` and its
 * paired `tool_result`, checking every field name a host is known to use
 * (#1642 F4) — the SDK declares `toolCallId` (see the file header above for
 * why pi-lens can't import the SDK's own type at runtime), but
 * `read-guard-logger.ts`'s `getReadGuardCorrelationId` already had to widen
 * to `callId`/`requestId`/`id` for hosts that populate one of those instead.
 * Single source of truth for that field list — do not hand-roll a narrower
 * `event.toolCallId` read at a new call site.
 *
 * Deliberately does NOT fall back to a generated id the way
 * `getReadGuardCorrelationId` does: that fallback is minted fresh on EVERY
 * call (a bare per-invocation counter), which is exactly right for grouping
 * one call's own log lines but useless — actively misleading — for
 * correlating two SEPARATE events (a `tool_call` and its `tool_result`)
 * against each other. `undefined` means the host supplies no stable
 * identity at all under any known field; callers decide their own safe
 * default for that case rather than treat a generated id as a match.
 */
export function resolveToolCallCorrelationId(
	event: unknown,
): string | undefined {
	const value = (event ?? {}) as Record<string, unknown>;
	for (const candidate of [
		value.toolCallId,
		value.callId,
		value.requestId,
		// Widest rung, only reached when toolCallId/callId/requestId are all
		// absent (#1678 item 2): this assumes a host's `id` field identifies
		// one TOOL CALL. A host that instead populates `id` per MESSAGE (one
		// id shared by every tool call in that message) would cross two
		// parallel calls in the same turn under the same id. Stated plainly:
		// real pi builds `tool_call`/`tool_result` events with exactly
		// `toolCallId` and no bare `id` field at all (see the file header
		// above, #1655 item 2, `src/core/agent-session.ts:502-516`), so this
		// rung is dead code against today's host — kept only in case a
		// different host shape needs it; drop it once #1655's audit confirms
		// none does.
		value.id,
	]) {
		const sanitized = sanitizeCorrelationId(candidate);
		if (sanitized) return sanitized;
	}
	return undefined;
}

/**
 * Resolve the identity that owns read evidence. Nested codemode calls are
 * visible in the live event stream with their own ids, but their tool result
 * is carried by the parent codemode result on a conversation branch. Using
 * the parent when present keeps the same branch-retention rule for top-level
 * and nested reads (#3831).
 */
export function resolveReadEvidenceCorrelationId(
	event: unknown,
): string | undefined {
	const parent = resolveToolCallCorrelationId({
		toolCallId: (event as { parentToolCallId?: unknown } | undefined)
			?.parentToolCallId,
	});
	return parent ?? resolveToolCallCorrelationId(event);
}
