/**
 * The inbound mutation-classification seam (#2423).
 *
 * ## Why this module exists
 *
 * Before this seam, every producer in pi-lens decided "is this event a file
 * mutation?" by comparing `event.toolName` against the string literals
 * `"write"` and `"edit"`. Fifteen call sites across `runtime-tool-call.ts`,
 * `runtime-tool-result.ts`, `read-guard-tool-lines.ts`,
 * `runtime-coordinator.ts`, `read-guard.ts` and `agent-behavior-client.ts` each
 * made that decision on their own, so a host or extension that registered an
 * edit tool under ANY other name was dropped before the first bookkeeping
 * call: no read-guard preflight, no `turn-state.json` entry, no deferred
 * autofix, no format at `agent_settled`, no change-log receipt.
 *
 * The READ side already solved the same problem twice — `details.searchReads`
 * is consumed by SHAPE for any tool (#169), and `clients/read-bridge.ts` lets
 * an out-of-band producer record a read directly (#1265). This module plus
 * `clients/mutation-bridge.ts` is the mutation-side equivalent.
 *
 * ## The contract
 *
 * `classifyMutatingTool(event, ctx)` is THE way to ask whether an event mutates
 * a file. It answers with a {@link MutatingToolClassification} or `undefined`;
 * no consumer compares a tool name to `"write"` or `"edit"` itself.
 * `tests/clients/mutating-tool-classification.test.ts` greps `clients/` and
 * fails when such a literal comparison reappears outside this file.
 *
 * Three recognition tiers, applied in this order:
 *
 * 1. **The built-in table** — pi's own `write` and `edit`. Behavior is
 *    unchanged, and `write` short-circuits because its shape is unambiguous.
 * 2. **The shape-adapter registry** ({@link MUTATION_SHAPE_ADAPTERS}), promoted
 *    out of `resolveHashlineEditInput`. An adapter recognizes an INPUT SHAPE,
 *    not a name, so a third-party tool called `replace` or `insert` is
 *    classified on the strength of its arguments. Order is deterministic and
 *    the first non-`undefined` result wins.
 * 3. **The mutation bridge** (`clients/mutation-bridge.ts`) — an in-process
 *    producer that already knows it mutated a file calls `recordMutation` and
 *    gets a `provenance: "bridge"` classification from
 *    {@link classifyBridgeMutation}.
 *
 * ## Telemetry
 *
 * Every adapter stamps its own `source` discriminator into the existing
 * `touched_lines_detected` and `edit_preflight_blocked` read-guard events, so a
 * production log says WHICH shape resolved a range. Adapters log only when the
 * caller supplies `ctx.filePath`. A path-resolution call runs before the path
 * is known, passes no context, and stays silent, exactly as the pre-seam code
 * did.
 *
 * ## Deliberately not here
 *
 * A declarative `tools.mutating` catalog entry and the `FormatQueuedPayload.tool`
 * widening are public-API decisions and belong to the #2421 and #2415 program.
 *
 * ## The fourth tier lives elsewhere (#2430)
 *
 * Recognition tiers 1–3 are finite; the population of third-party edit tools is
 * not. `clients/observed-mutation.ts` therefore WATCHES an unclassified call —
 * a bounded disk diff around it — and `clients/mutation-attribution.ts`
 * remembers what that watching proved. This module consults that memory as tier
 * 4 ({@link MutationProvenance} `"learned"`), so a tool observed once is
 * classified by name from then on with no snapshot at all. The observation
 * itself, and the `agent_settled` sweep for tools that name no path, stay in
 * those modules: this one is the classifier, not the observer.
 */
import { BoundedFifoMap } from "./bounded-cache.js";
import {
	type HashlineAnchorFailure,
	resolveHashlineAnchor,
} from "./hashline-anchor.js";
import { lookupLearnedMutatingTool } from "./mutation-attribution.js";
import {
	boundedIndexesForCount,
	createReadGuardEditBatchSummary,
	logReadGuardEvent,
	type ReadGuardEditBatchSummary,
} from "./read-guard-logger.js";

/**
 * What the mutation does to the file, independent of the tool's name.
 *
 * - `write` — the whole file is authored or replaced. No prior read is
 *   required, and the autofix pass may run immediately.
 * - `edit` — part of the file changes. The read-before-edit guard applies and
 *   the autofix pass is DEFERRED to `agent_settled`, because a partial edit is
 *   usually one of several and formatting between them fights the agent.
 *
 * An edit-shaped tool pi-lens does not otherwise know defaults to `edit`, the
 * safe timing.
 */
export type MutationKind = "write" | "edit";

/** How the classification was reached. */
type MutationProvenance =
	/** `event.toolName` is in the built-in table. */
	| "builtin"
	/** A synthetic write pi-lens derived from a bash command (#168, #2000). */
	| "bash-derived"
	/** A shape adapter recognized the input of a tool pi-lens does not name. */
	| "declared"
	/** An in-process producer recorded it through `clients/mutation-bridge.ts`. */
	| "bridge"
	/**
	 * #2430: nothing recognized the tool, but the observational net diffed the
	 * disk around the call and SAW the change. This is the first-call verdict —
	 * evidence, not recognition.
	 */
	| "observed"
	/**
	 * #2430: a previous observation attributed this tool name as mutating, in
	 * this session or in a persisted attribution from an earlier one, so the
	 * call is classified with no snapshot at all.
	 */
	| "learned"
	/**
	 * #2430: no tool call could be blamed. The `agent_settled` sweep found the
	 * file's content had drifted from the last baseline pi-lens took.
	 */
	| "settled-sweep";

/**
 * Line information an adapter resolved from a tool's input.
 *
 * Structurally a subset of `GuardLineResult` (`read-guard-tool-lines.ts`), so
 * an adapter result reaches the guard verbatim. It is declared here rather than
 * imported so this module has no dependency, not even a type one, on the
 * consumer that imports it.
 */
interface MutationLineResult {
	touchedLines: [number, number] | undefined;
	/** Individual ranges for a multi-range edit; the guard checks each one. */
	editRanges?: [number, number][];
	preflightError?: string;
	editBatchSummary?: ReadGuardEditBatchSummary;
	/**
	 * Why an adapter that RECOGNIZED the shape could not name the lines. It is a
	 * report, not a verdict: the mutation is still classified, and the caller
	 * proceeds exactly as it does for a host edit whose schema it cannot read.
	 */
	unresolvedReason?: string;
}

/** Optional context an adapter uses for telemetry and file probing. */
export interface MutatingToolContext {
	/** Resolved absolute path. When it is absent, adapters do not log. */
	filePath?: string;
	sessionId?: string;
	correlationId?: string;
	/**
	 * "Answer the shape question only." An adapter must not read the file and
	 * must not log.
	 *
	 * The `tool_result` side sets this (#2423 review round 1, finding F5). By
	 * then the edit HAS been applied, so resolving an anchor against the file on
	 * disk would resolve it against post-edit content — and re-running the
	 * adapter's telemetry there logged a second `touched_lines_detected` for
	 * every edit, plus an `edit_preflight_blocked` for edits that were never
	 * blocked. The ranges the tool_call side resolved are carried forward by
	 * `toolCallId` instead.
	 */
	recognizeOnly?: boolean;
}

/**
 * Recognizes one tool-input SHAPE. Returns `undefined` when the input is not
 * its shape, so the registry falls through to the next adapter.
 */
type ShapeAdapter = (
	input: Record<string, unknown>,
	ctx: MutatingToolContext,
) => MutationLineResult | undefined;

/** One registry entry. */
export interface MutationShapeAdapter {
	/** Stable identity, used by the mutation-proof tests and in reports. */
	readonly name: string;
	/** What a match means for timing and for the read-before-edit guard. */
	readonly kind: MutationKind;
	readonly resolve: ShapeAdapter;
}

/** The answer `classifyMutatingTool` gives. */
export interface MutatingToolClassification {
	/** The tool name as the host reported it. */
	toolName: string;
	/** Path the tool targets, unresolved, as the tool spelled it. */
	path: string | undefined;
	kind: MutationKind;
	touchedLines?: [number, number];
	editRanges?: [number, number][];
	preflightError?: string;
	editBatchSummary?: ReadGuardEditBatchSummary;
	/** Set when an adapter recognized the shape but could not name the lines. */
	unresolvedReason?: string;
	provenance: MutationProvenance;
	/** Adapter that resolved the lines. `undefined` for a built-in shape. */
	source?: string;
}

/**
 * pi's own mutating tools. This table is the ONLY place those two names are
 * compared against an event.
 */
const BUILTIN_MUTATING_TOOLS: ReadonlyMap<string, MutationKind> = new Map<
	string,
	MutationKind
>([
	["write", "write"],
	["edit", "edit"],
]);

/**
 * Header marker for an adapter's blocking verdict. Identical to the marker the
 * promoted `resolveHashlineEditInput` used, so the agent-facing text does not
 * change. It is a constant because this module's delivery surface is registered
 * in `clients/finding-delivery-gate.ts`.
 */
const BLOCKED_MARKER = "\u{1F534} BLOCKED —";

/**
 * `true` when the NAME alone identifies a pi built-in mutating tool.
 *
 * Name-only consumers use this: the agent-behavior heuristics see a tool name
 * and a path but never the event. It cannot see a third-party tool, because
 * that needs the input shape, so a consumer takes `classifyMutatingTool`'s
 * answer wherever the event is in hand.
 */
export function isMutatingToolName(toolName: string): boolean {
	return BUILTIN_MUTATING_TOOLS.has(toolName);
}

/** Built-in mutating tool names, for reports and tests. */
export function getBuiltinMutatingToolNames(): string[] {
	return [...BUILTIN_MUTATING_TOOLS.keys()];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Path field, in a fixed order. `path` is pi's spelling; `filePath` and
 * `file_path` are the two spellings third-party edit tools use in practice.
 *
 * Exported for #2430: the observational net arms only for a call whose input
 * carries a path-shaped field, and it must ask that question with the SAME
 * field list the seam classifies with — a second spelling list would arm on
 * inputs the seam cannot resolve, and miss ones it can.
 */
function resolveMutationPath(
	input: Record<string, unknown>,
): string | undefined {
	for (const key of ["path", "filePath", "file_path"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * The path-shaped field on an event's input, or `undefined` (#2430).
 *
 * This is the arming predicate for the observational net. It deliberately
 * answers only "does this input name a file", never "does this tool mutate" —
 * the whole point of the net is that the second question has no static answer.
 */
export function readMutationPathField(event: unknown): string | undefined {
	return resolveMutationPath(asRecord((event as { input?: unknown })?.input));
}

/**
 * Parse a `pi-hashline-readmap` anchor (`"42"` or `"42: some code"`) to its
 * 1-based line. Moved here from `read-guard-tool-lines.ts` with the adapters
 * that use it.
 *
 * This is the READMAP form and it is decimal. `pi-hashline-edit-pro` is a
 * different extension with a different addressing scheme — a bare three-char
 * base62 anchor — handled by `clients/hashline-anchor.ts`. Do not reach for
 * this function there.
 */
function parseHashlineAnchor(anchor: unknown): number | undefined {
	if (typeof anchor !== "string") return undefined;
	const trimmed = anchor.trim();
	const separator = trimmed.indexOf(":");
	const lineText = separator === -1 ? trimmed : trimmed.slice(0, separator);
	if (!/^\d+$/.test(lineText)) return undefined;
	const line = Number(lineText);
	return Number.isInteger(line) && line > 0 ? line : undefined;
}

/** Bounding box plus per-range detail for a multi-range edit. */
function combineRanges(ranges: [number, number][]): MutationLineResult {
	const starts = ranges.map(([start]) => start);
	const ends = ranges.map(([, end]) => end);
	return {
		touchedLines: [Math.min(...starts), Math.max(...ends)],
		editRanges: ranges.length > 1 ? ranges : undefined,
	};
}

/**
 * Shared blocking result for an adapter that recognized its shape but could not
 * resolve every operation to a range. Blocking is the safe outcome: an edit
 * whose target lines are unknown cannot be checked against what the agent read.
 *
 * Every blocking verdict ends with one concrete next-action line so the agent
 * recovers in a single turn (#328).
 */
function blockedByAdapter(args: {
	adapterSource: string;
	reasonKind: string;
	title: string;
	errors: string[];
	operationCount: number;
	retryHint: string;
	ctx: MutatingToolContext;
}): MutationLineResult {
	const indexes = boundedIndexesForCount(args.operationCount);
	const editBatchSummary = createReadGuardEditBatchSummary({
		requestedIndexes: indexes,
		requestedTotal: args.operationCount,
		rejectedReasons: indexes.map((index) => ({
			index,
			code: "preflight_blocked" as const,
		})),
		rejectedTotal: args.operationCount,
		durationMs: 0,
		terminalStatus: "blocked",
	});
	if (args.ctx.filePath && !args.ctx.recognizeOnly) {
		logReadGuardEvent({
			event: "edit_preflight_blocked",
			correlationId: args.ctx.correlationId,
			sessionId: args.ctx.sessionId,
			filePath: args.ctx.filePath,
			metadata: {
				tool: "edit",
				source: args.adapterSource,
				reasonKind: args.reasonKind,
				operationCount: args.operationCount,
				errorCount: args.errors.length,
				errors: args.errors.slice(0, 10),
			},
		});
		logReadGuardEvent({
			event: "edit_batch_summary",
			correlationId: args.ctx.correlationId,
			filePath: args.ctx.filePath,
			metadata: { tool: "edit", editBatchSummary },
		});
	}
	return {
		touchedLines: undefined,
		preflightError: `${BLOCKED_MARKER} ${args.title}\n\n${args.errors.join("\n")}\n\n${args.retryHint}`,
		editBatchSummary,
	};
}

function logTouchedLines(args: {
	adapterSource: string;
	result: MutationLineResult;
	operationCount: number;
	ctx: MutatingToolContext;
	extra?: Record<string, unknown>;
}): void {
	if (!args.ctx.filePath || args.ctx.recognizeOnly) return;
	logReadGuardEvent({
		event: "touched_lines_detected",
		correlationId: args.ctx.correlationId,
		sessionId: args.ctx.sessionId,
		filePath: args.ctx.filePath,
		metadata: {
			tool: "edit",
			source: args.adapterSource,
			touchedLines: args.result.touchedLines,
			editRanges: args.result.editRanges,
			operationCount: args.operationCount,
			...args.extra,
		},
	});
}

// ---------------------------------------------------------------------------
// Adapter: hashline-readmap (the shape `resolveHashlineEditInput` recognized)
// ---------------------------------------------------------------------------

/**
 * One recognized hashline operation: a record carrying one of the three
 * operation keys the readmap tool defines.
 *
 * This is what separates RECOGNIZING the shape from RESOLVING the range
 * (#2423 review round 1, finding F2). `operations` and `ops` are generic enough
 * that an unrelated tool carries them — a batch runner, a refactoring tool, a
 * migration tool — and claiming those and then BLOCKING turned the seam into a
 * denial-of-service for any tool that happened to name an array `operations`.
 */
function isHashlineOperation(value: unknown): boolean {
	const op = asRecord(value);
	return (
		op.set_line !== undefined ||
		op.replace_lines !== undefined ||
		op.replace_symbol !== undefined
	);
}

/**
 * The readmap batch, or `undefined` when this input is not one. A batch is
 * claimed only when at least one entry is a recognized hashline operation.
 */
function getHashlineOperations(
	input: Record<string, unknown>,
): unknown[] | undefined {
	const operations = Array.isArray(input.operations)
		? input.operations
		: Array.isArray(input.ops)
			? input.ops
			: isHashlineOperation(input)
				? [input]
				: undefined;
	if (operations === undefined || operations.length === 0) return undefined;
	return operations.some(isHashlineOperation) ? operations : undefined;
}

const hashlineReadmapAdapter: ShapeAdapter = (input, ctx) => {
	const operations = getHashlineOperations(input);
	if (operations === undefined) return undefined;
	const ranges: [number, number][] = [];
	const errors: string[] = [];

	for (let index = 0; index < operations.length; index += 1) {
		const op = asRecord(operations[index]);
		if (op.set_line) {
			const payload = asRecord(op.set_line);
			const line = parseHashlineAnchor(payload.anchor);
			if (!line) {
				errors.push(`operation[${index}].set_line.anchor is malformed`);
				continue;
			}
			ranges.push([line, line]);
			continue;
		}
		if (op.replace_lines) {
			const payload = asRecord(op.replace_lines);
			const start = parseHashlineAnchor(payload.start_anchor);
			const end = parseHashlineAnchor(payload.end_anchor);
			if (!start || !end) {
				errors.push(`operation[${index}].replace_lines anchors are malformed`);
				continue;
			}
			if (start > end) {
				errors.push(`operation[${index}].replace_lines range is inverted`);
				continue;
			}
			ranges.push([start, end]);
			continue;
		}
		if (op.replace_symbol) {
			errors.push(
				`operation[${index}].replace_symbol cannot be resolved safely yet; use line anchors or a native ranged edit`,
			);
			continue;
		}
		errors.push(`operation[${index}] is not a recognized hashline edit`);
	}

	if (errors.length > 0) {
		const target = ctx.filePath ? `\`${ctx.filePath}\`` : "the file";
		return blockedByAdapter({
			adapterSource: "hashline_edit",
			reasonKind: "unsupported_hashline_edit_target",
			title: "Unsupported hashline edit target",
			errors,
			operationCount: operations.length,
			retryHint: `Re-read ${target} to get current #line anchors, then retry using set_line / replace_lines with those anchors — or use a native ranged edit.`,
			ctx,
		});
	}
	if (ranges.length === 0) return undefined;
	const result = combineRanges(ranges);
	logTouchedLines({
		adapterSource:
			ranges.length === 1 && ranges[0][0] === ranges[0][1]
				? "hashline_set_line"
				: "hashline_replace_lines",
		result,
		operationCount: operations.length,
		ctx,
	});
	return result;
};

// ---------------------------------------------------------------------------
// Adapter: hashline-edit-pro
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === "string")
	);
}

/**
 * The `replace` request, or `undefined` when this is not one.
 *
 * Recognition needs ALL THREE required fields of the upstream schema
 * (`src/payload-contract.ts` `ROOT_KS` / `assertReq`): two anchor strings and a
 * `replacement_lines` array of strings. `remove_from` alone is not enough
 * (#2423 review round 1, finding F2) — the fields are common English and a
 * navigation or query tool can carry one without editing anything.
 */
function readHashlineProReplace(
	input: Record<string, unknown>,
): { removeFrom: string; removeTo: string } | undefined {
	if (
		typeof input.remove_from !== "string" ||
		typeof input.remove_to !== "string" ||
		!isStringArray(input.replacement_lines)
	) {
		return undefined;
	}
	return { removeFrom: input.remove_from, removeTo: input.remove_to };
}

/**
 * The `insert` request, or `undefined` when this is not one.
 *
 * `assertInsertReq` in `src/insert.ts` requires a non-empty `anchor` string, a
 * `direction` that is exactly `"before"` or `"after"`, and `lines` as an array
 * of strings. An `anchor` + `direction` pair alone is a shape plenty of
 * non-mutating tools carry (a scroll, a cursor move, a jump-to-symbol), so all
 * three are required here too.
 */
function readHashlineProInsert(
	input: Record<string, unknown>,
): { anchor: string; direction: "before" | "after" } | undefined {
	if (typeof input.anchor !== "string" || input.anchor.length === 0)
		return undefined;
	if (input.direction !== "before" && input.direction !== "after")
		return undefined;
	if (!isStringArray(input.lines)) return undefined;
	return { anchor: input.anchor, direction: input.direction };
}

/** One `unresolvedReason` string, so the telemetry vocabulary stays fixed. */
function anchorUnresolved(
	field: string,
	failure: HashlineAnchorFailure,
): string {
	return `${field}:${failure}`;
}

/**
 * `hashline-edit-pro` ships two operations, both addressed by a bare three-char
 * base62 ANCHOR — `"aB3"`, never a line number:
 *
 * - `replace`: `{path, remove_from, remove_to, replacement_lines}` — the two
 *   anchors bound an inclusive line range.
 * - `insert`: `{path, anchor, direction, lines}` — a zero-width insertion
 *   before or after one anchor line. The anchor line itself is the range the
 *   guard checks, because that is the line the agent must have read to name it.
 *
 * A drifted edit-pro anchor gets NO relocation (review round 3, finding F5).
 * The #505 auto-apply runs through `relocateEditRange`, which rewrites the
 * line numbers inside a `oldRange` or an `edits[].range` — neither of which an
 * edit-pro request has. So for `{anchor, direction, lines}` the relocation
 * call is a structural no-op, and this adapter deliberately does not build a
 * second search to cover it: re-deriving "where did that content go" from a
 * hash pi-lens cannot verify is exactly the guessing that finding F1 removed.
 * A drifted anchor stays unresolved and observable; giving that shape a real
 * net is #2430's job.
 *
 * Anchors are resolved by `clients/hashline-anchor.ts`, which reproduces the
 * extension's own hash function against the file's current content and answers
 * only when the match is unique AND the matched line's content occurs once in
 * the file. An anchor that does not resolve leaves the mutation classified
 * with its lines unknown — never a block. See that module's header for the
 * measurement behind the content-uniqueness gate, and for why blocking on
 * pi-lens's disagreement with a third-party tool would be wrong.
 *
 * Upstream `swapReversedRanges` (`src/hashline/resolve.ts`) AUTOCORRECTS a
 * reversed pair rather than refusing it, so a resolved pair is normalized here
 * the same way instead of being treated as an error.
 */
const hashlineEditProAdapter: ShapeAdapter = (input, ctx) => {
	const replace = readHashlineProReplace(input);
	if (replace) {
		if (ctx.recognizeOnly || !ctx.filePath) {
			return {
				touchedLines: undefined,
				unresolvedReason: ctx.recognizeOnly
					? "replace:recognize_only"
					: "replace:no_file_path",
			};
		}
		const from = resolveHashlineAnchor(ctx.filePath, replace.removeFrom);
		const to = resolveHashlineAnchor(ctx.filePath, replace.removeTo);
		if (from.line === undefined || to.line === undefined) {
			return {
				touchedLines: undefined,
				unresolvedReason:
					from.line === undefined
						? anchorUnresolved(
								"remove_from",
								from.failure ?? "anchor_not_found",
							)
						: anchorUnresolved("remove_to", to.failure ?? "anchor_not_found"),
			};
		}
		const result = combineRanges([
			[Math.min(from.line, to.line), Math.max(from.line, to.line)],
		]);
		logTouchedLines({
			adapterSource: "hashline_pro_replace",
			result,
			operationCount: 1,
			ctx,
			extra: {
				anchors: [replace.removeFrom, replace.removeTo],
				swapped: from.line > to.line,
			},
		});
		return result;
	}

	const insert = readHashlineProInsert(input);
	if (insert) {
		if (ctx.recognizeOnly || !ctx.filePath) {
			return {
				touchedLines: undefined,
				unresolvedReason: ctx.recognizeOnly
					? "insert:recognize_only"
					: "insert:no_file_path",
			};
		}
		const anchor = resolveHashlineAnchor(ctx.filePath, insert.anchor);
		if (anchor.line === undefined) {
			return {
				touchedLines: undefined,
				unresolvedReason: anchorUnresolved(
					"anchor",
					anchor.failure ?? "anchor_not_found",
				),
			};
		}
		const result = combineRanges([[anchor.line, anchor.line]]);
		logTouchedLines({
			adapterSource: "hashline_pro_insert",
			result,
			operationCount: 1,
			ctx,
			extra: { direction: insert.direction, anchors: [insert.anchor] },
		});
		return result;
	}

	return undefined;
};

// ---------------------------------------------------------------------------
// Carrying a tool_call resolution to its tool_result
// ---------------------------------------------------------------------------

/**
 * Ranges an adapter resolved on the `tool_call` side, keyed by `toolCallId`.
 *
 * By `tool_result` the edit has ALREADY been applied, so an anchor can no
 * longer be resolved against the file: the lines a `replace` named are gone,
 * and an `insert`'s anchor has moved. The classification still needs those
 * ranges — they are what `runtime-tool-result.ts` hands to
 * `cacheManager.addModifiedRange`, i.e. the `turn-state.json` entry whose
 * absence is the bug #2423 reports.
 *
 * Reads do not consume the entry: several call sites classify the same event,
 * and a consuming read would hand the ranges to whichever asked first. The map
 * drains by capacity instead.
 */
const RESOLVED_RANGE_CARRY_LIMIT = 64;
const RESOLVED_RANGE_CARRY = new BoundedFifoMap<
	string,
	{ touchedLines: [number, number]; editRanges?: [number, number][] }
>(RESOLVED_RANGE_CARRY_LIMIT);

function readToolCallId(event: unknown): string | undefined {
	const id = (event as { toolCallId?: unknown } | undefined)?.toolCallId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function carryResolvedRanges(event: unknown, result: MutationLineResult): void {
	const toolCallId = readToolCallId(event);
	if (!toolCallId || result.touchedLines === undefined) return;
	RESOLVED_RANGE_CARRY.set(toolCallId, {
		touchedLines: result.touchedLines,
		editRanges: result.editRanges,
	});
}

function readCarriedRanges(
	event: unknown,
):
	| { touchedLines: [number, number]; editRanges?: [number, number][] }
	| undefined {
	const toolCallId = readToolCallId(event);
	return toolCallId ? RESOLVED_RANGE_CARRY.get(toolCallId) : undefined;
}

/** Test seam: the carry map is process-global, so a suite must be able to clear it. */
export function _resetMutationRangeCarryForTests(): void {
	RESOLVED_RANGE_CARRY.clear();
}

/** #2442 test seam: exercise RESOLVED_RANGE_CARRY's capacity eviction through
 *  the exact production write/read paths. */
export function _carryResolvedRangesForTests(
	toolCallId: string,
	touchedLines: [number, number],
): void {
	carryResolvedRanges({ toolCallId }, { touchedLines, editRanges: undefined });
}
export function _hasCarriedRangeForTests(toolCallId: string): boolean {
	return readCarriedRanges({ toolCallId }) !== undefined;
}
export const RESOLVED_RANGE_CARRY_LIMIT_FOR_TESTS = RESOLVED_RANGE_CARRY_LIMIT;

/**
 * The registry. ORDER IS THE CONTRACT: adapters run top to bottom and the first
 * non-`undefined` result wins, so a narrower shape must precede a broader one.
 * `hashline-readmap` is first because it keys off explicit `operations`,
 * `set_line` and `replace_lines` fields that no other shape carries.
 *
 * Each entry is covered by its own case in
 * `tests/clients/mutating-tool-classification.test.ts`; deleting an entry turns
 * that case red.
 */
export const MUTATION_SHAPE_ADAPTERS: readonly MutationShapeAdapter[] = [
	{ name: "hashline-readmap", kind: "edit", resolve: hashlineReadmapAdapter },
	{ name: "hashline-edit-pro", kind: "edit", resolve: hashlineEditProAdapter },
];

function readToolName(event: unknown): string | undefined {
	const name = (event as { toolName?: unknown } | undefined)?.toolName;
	return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * pi-lens's own marker on a `tool_result` it SYNTHESIZED from a bash command
 * (`runtime-tool-result.ts`'s recognized-write and opaque-recovery dispatch).
 * The event carries `toolName: "write"` so the pipeline treats it as one, but
 * the provenance is not the host's write tool, and a consumer that attributes
 * changes to the model must be able to tell them apart.
 */
export const PI_LENS_SYNTHETIC_MUTATION_FIELD = "piLensSyntheticMutation";

/**
 * Classify an inbound `tool_call` or `tool_result` event.
 *
 * Returns `undefined` for every event that is not a file mutation pi-lens
 * recognizes. That is the "not our business" answer every consumer keys off.
 *
 * Cost: one map lookup for `write`, plus at most one shallow shape probe per
 * registered adapter for everything else. The PR body carries the measurement.
 */
export function classifyMutatingTool(
	event: unknown,
	ctx: MutatingToolContext = {},
): MutatingToolClassification | undefined {
	const toolName = readToolName(event);
	if (toolName === undefined) return undefined;
	const input = asRecord((event as { input?: unknown }).input);
	const builtinKind = BUILTIN_MUTATING_TOOLS.get(toolName);
	const syntheticSource = (event as Record<string, unknown>)[
		PI_LENS_SYNTHETIC_MUTATION_FIELD
	];
	const builtinProvenance: MutationProvenance =
		syntheticSource === "bash" ? "bash-derived" : "builtin";

	// A full-file write has no shape ambiguity, so it never pays for the
	// adapter probes.
	if (builtinKind === "write") {
		return {
			toolName,
			path: resolveMutationPath(input),
			kind: "write",
			provenance: builtinProvenance,
		};
	}

	for (const adapter of MUTATION_SHAPE_ADAPTERS) {
		let resolved = adapter.resolve(input, ctx);
		if (resolved === undefined) continue;
		if (resolved.touchedLines !== undefined) {
			carryResolvedRanges(event, resolved);
		} else if (!resolved.preflightError) {
			// The tool_result side cannot re-resolve an anchor against a file the
			// edit has already rewritten; reuse what the tool_call side resolved.
			const carried = readCarriedRanges(event);
			if (carried)
				resolved = { ...resolved, ...carried, unresolvedReason: undefined };
		}
		return {
			toolName,
			path: resolveMutationPath(input),
			kind: adapter.kind,
			touchedLines: resolved.touchedLines,
			editRanges: resolved.editRanges,
			preflightError: resolved.preflightError,
			editBatchSummary: resolved.editBatchSummary,
			unresolvedReason: resolved.unresolvedReason,
			// A built-in name that an adapter resolved is still built-in; only a
			// name pi-lens does not know is a declared third-party shape.
			provenance: builtinKind !== undefined ? builtinProvenance : "declared",
			source: adapter.name,
		};
	}

	if (builtinKind !== undefined) {
		return {
			toolName,
			path: resolveMutationPath(input),
			kind: builtinKind,
			provenance: builtinProvenance,
		};
	}

	// #2430, tier 4: nothing NAMED or SHAPED this tool, but a previous
	// observation attributed it. `edit` is the kind, because a partial rewrite
	// is the safe timing assumption for a tool whose semantics are unknown, and
	// the deferred pass is what a wrong guess costs least.
	//
	// A path field is required. Without one there is no target to record, and
	// the settled sweep — not this branch — is the net for that shape.
	const learnedPath = resolveMutationPath(input);
	if (learnedPath !== undefined) {
		const learned = lookupLearnedMutatingTool(toolName);
		if (learned !== undefined) {
			return {
				toolName,
				path: learnedPath,
				kind: "edit",
				provenance: "learned",
				source: `attribution:${learned}`,
			};
		}
	}

	return undefined;
}

/** Payload the mutation bridge validates and hands to the seam. */
export interface BridgeMutationEntry {
	filePath: string;
	kind: MutationKind;
	touchedLines?: [number, number];
	editRanges?: [number, number][];
	/** Producer identity, surfaced as the tool name on the classification. */
	consumer?: string;
	/**
	 * Whether this write changed the file's import/require statements —
	 * gates `cache-manager.ts`'s madge re-scan filter (#2450 review round 2,
	 * F1). Omitted defaults to `false`, matching every bridge producer's
	 * behavior before this field existed (e.g. `ast_grep_replace`, which does
	 * not compute this and should not change behavior by omission). A
	 * producer that DOES know the real value (the LSP mutation-bridge
	 * fallback, `clients/lsp-mutation.ts`, threads the same
	 * `AppliedWorkspaceEdit.fileDetails[].importsChanged` its direct path
	 * uses) should pass it explicitly.
	 */
	importsChanged?: boolean;
	/**
	 * Whether this write should queue a deferred autofix/format pass at
	 * `agent_settled` (#2450 review round 2, F3). Omitted defaults to `true`
	 * — every existing bridge producer (`ast_grep_replace`, a third-party
	 * extension) still gets the deferred pass it always has. The LSP
	 * mutation-bridge fallback passes `false`: `bookkeepLspMutation`'s direct
	 * path never enqueues a deferred pass for an LSP-applied edit (that is
	 * not this seam's job), so the fallback must not either — the two
	 * branches have to be behaviorally equivalent for the same write.
	 */
	deferAutofix?: boolean;
	/**
	 * #2430: how the producer knows. The observational net replays through the
	 * bridge and its evidence is a disk diff, not a producer's own statement, so
	 * the classification must not claim `"bridge"` for it — a report that says
	 * "an extension told us" about something pi-lens INFERRED is a lie about
	 * provenance. Only the two observational values are accepted; anything else
	 * falls back to `"bridge"`.
	 */
	provenance?: "observed" | "settled-sweep";
}

/**
 * Build the classification for a mutation an in-process producer recorded
 * directly. The bridge does not guess a shape, because the producer states the
 * kind, so this is a construction rather than a recognition.
 */
export function classifyBridgeMutation(
	entry: BridgeMutationEntry,
): MutatingToolClassification {
	const provenance: MutationProvenance =
		entry.provenance === "observed" || entry.provenance === "settled-sweep"
			? entry.provenance
			: "bridge";
	return {
		toolName: entry.consumer ?? "unknown",
		path: entry.filePath,
		kind: entry.kind,
		touchedLines: entry.touchedLines,
		editRanges: entry.editRanges,
		provenance,
		source: provenance === "bridge" ? "mutation-bridge" : "observed-mutation",
	};
}
