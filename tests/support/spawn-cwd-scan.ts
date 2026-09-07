/**
 * #2691 / AGENTS.md defect shape 40 — the scan behind
 * `tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts`.
 *
 * ## What it decides
 *
 * For one runner source: every `safeSpawnAsync`/`safeSpawnSync` call site,
 * plus every call site of a same-file function that ROUTES a spawn's `cwd`,
 * and for each of those whether a `cwd` is actually supplied. A site that
 * does not is a shape-40 defect — the child resolves its project config by
 * walking up from the extension host's `process.cwd()` instead of the
 * dispatch cwd, while the runner's own `hasXConfig(ctx.cwd)` gate says the
 * project config was found.
 *
 * ## Why an AST and not a text scan
 *
 * Rounds 1 and 2 of #2693 hand-rolled this over comment/string-blanked text
 * and shipped a fresh hole each time:
 *
 * - r1 tested `\bcwd\b` against the WHOLE call text, so
 *   `typos.getCommand(ctx.cwd)` in ARGUMENT ONE cleared `spellcheck.ts` —
 *   the sweep never caught 1 of the 6 defects it shipped with.
 * - r2 scoped that to the last top-level `{…}` but still tested RAW text, so
 *   a comment between the braces (`// no cwd here: yamllint resolves config
 *   from the file`) or a string value (`resourceLabel: "yamllint-cwd"`)
 *   satisfied it with #2691's defect fully reintroduced.
 * - r2's wrapper rule — "a `function NAME(…)` whose parameter list has a
 *   `{…}`-shaped parameter naming cwd" — is a syntactic proxy that missed
 *   `helm-lint.ts`'s `lintChart(chartRoot, cwd)` and `helm-render.ts`'s
 *   `renderAndValidate(chartRoot, cwd, filePath)`, both of which take `cwd`
 *   POSITIONALLY and route it straight into a spawn. Replacing `ctx.cwd`
 *   with `process.cwd()` at both callers left the round-2 sweep green.
 *
 * Blanking the slice — the round-2 review's prescribed remedy for the first
 * two — closes the comment and the string and leaves
 * `env: { ...process.env, PWD: cwd }` green: that `cwd` is a real
 * identifier, blanked by nothing, sitting in a property named `env`. No
 * text rule separates it from the options key, because the difference is
 * structural. Every one of these is one mistake in four spellings —
 * AGENTS.md defect shape 34, "a guard that enumerates surface spellings".
 *
 * So the scan asks a parser the two questions that actually decide it:
 *
 * 1. does the options literal have a PROPERTY NAMED `cwd`, and
 * 2. does the `cwd` value inside a spawn resolve to a PARAMETER of an
 *    enclosing named function (which makes that function a spawn-routing
 *    wrapper, and its own callers the sites that must be checked)?
 *
 * `@ast-grep/napi` is already a runtime dependency and already backs a
 * governance sweep in this repo — `tests/support/availability-gate.ts`
 * (#1476), whose header records the same lesson: "the first version of this
 * gate was regexes and a review broke it seven ways in one sitting."
 * (`typescript` is not an option: this repo is on TypeScript 7, whose
 * package exports `version` and nothing else — there is no
 * `ts.createSourceFile` to call.)
 *
 * The full state space — call-site kind × where a `cwd` token can sit, with
 * the expected verdict per cell — is the "Detector state space (round 3)"
 * table on PR #2693, and every cell has a named fixture in
 * `spawn-cwd-scan.test.ts`.
 */

import { loadAstGrepNapi } from "../../clients/deps/ast-grep-napi.js";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";

/** One checked call site. */
export interface SpawnCwdSite {
	/** Caller-supplied label; the sweep passes the runner's file name. */
	file: string;
	/** 1-based line of the call's own callee token. */
	line: number;
	/** `safeSpawnAsync`/`safeSpawnSync`, or the wrapper's name. */
	callee: string;
	kind: "direct" | "wrapper";
	/** Whether this site supplies a cwd (see the two rules in the header). */
	hasCwd: boolean;
	/**
	 * Text after `// cwd-exempt:` on the line DIRECTLY above the call, when
	 * that text is a real reason (see {@link MIN_EXEMPT_REASON_LENGTH}). A tag
	 * with a too-short reason leaves this undefined, so the site is reported
	 * like any other one missing a `cwd`.
	 */
	exemptReason?: string;
}

/**
 * How a wrapper receives the cwd it routes into a spawn, and therefore what
 * its callers are held to. `options`: the argument at {@link paramIndex}
 * must be an object literal with a `cwd` property. `positional`: the
 * argument at {@link paramIndex} must itself be a cwd-bearing expression.
 */
export interface SpawnCwdWrapper {
	name: string;
	mode: "options" | "positional";
	paramIndex: number;
}

export interface SpawnCwdScan {
	sites: SpawnCwdSite[];
	/** Same-file spawn-routing wrappers discovered, sorted by name. */
	wrappers: SpawnCwdWrapper[];
}

const SPAWN_NAMES = new Set(["safeSpawnAsync", "safeSpawnSync"]);
/** `safeSpawn*(command, args, options?)` — the options object is argument 2. */
const SPAWN_OPTIONS_INDEX = 2;
const EXEMPT_TAG = /^\s*\/\/\s*cwd-exempt:\s*(.+)/;
/**
 * An exemption needs a REASON, not a tag. Below this length the tag does not
 * exempt anything and the site is reported like any other missing `cwd` —
 * one rule in one place, so a fixture can prove it. Rounds 1 and 2 spelled
 * this as a separate assertion in the sweep, where it could only ever see the
 * live tree's (all long) reasons and so reverted green under any mutation.
 */
const MIN_EXEMPT_REASON_LENGTH = 15;

const FUNCTION_KINDS = new Set([
	"function_declaration",
	"generator_function_declaration",
	"function_expression",
	"generator_function",
	"arrow_function",
	"method_definition",
]);

function isFunctionNode(node: SgNode): boolean {
	return FUNCTION_KINDS.has(String(node.kind()));
}

/** Named children with comments dropped — a comment is a named node in this
 * grammar, so it would otherwise be counted as an argument or a property. */
function namedParts(node: SgNode | null | undefined): SgNode[] {
	if (!node) return [];
	return node.namedChildren().filter((child) => child.kind() !== "comment");
}

/** Code-unit ordering. The sorted output feeds identity comparisons — the
 * sweep's pinned wrapper list, and `toEqual` over flagged `line:callee`
 * strings — so it must not vary with a locale (SonarCloud S2871). */
function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function unquote(text: string): string {
	return text.replace(/^["'`]|["'`]$/g, "");
}

/** 1-based start line of a node. */
function lineOf(node: SgNode): number {
	return node.range().start.line + 1;
}

/**
 * The simple name a call site would use for this function, or undefined when
 * it is anonymous — an inline arrow handed to another function has no call
 * site in this file and therefore no caller to check. That is precisely the
 * `createCwdCachedProbe((cwd) => safeSpawnAsync(…, { cwd }))` probe closure
 * (state-space row K7): its cwd is supplied per call by shared machinery in
 * `runners/utils/`, not by any caller here.
 */
function functionName(node: SgNode): string | undefined {
	const kind = String(node.kind());
	if (kind === "method_definition") return node.field("name")?.text();
	if (kind !== "arrow_function") {
		const own = node.field("name")?.text();
		if (own) return own;
	}
	const parent = node.parent();
	if (!parent) return undefined;
	const parentKind = String(parent.kind());
	// `const spawnPs = (…) => …` / `const spawnPs = function (…) {…}`
	if (parentKind === "variable_declarator") {
		const value = parent.field("value");
		if (value && value.id() === node.id()) {
			const name = parent.field("name");
			if (name && name.kind() === "identifier") return name.text();
		}
		return undefined;
	}
	// `{ spawnPs: (…) => … }` — an object-literal property holding a function.
	if (parentKind === "pair") {
		const value = parent.field("value");
		if (value && value.id() === node.id()) {
			return unquote(parent.field("key")?.text() ?? "") || undefined;
		}
	}
	return undefined;
}

/** Simple callee name: `f(…)` → `f`, `o.f(…)` → `f`. */
function calleeName(call: SgNode): string | undefined {
	const fn = call.field("function");
	if (!fn) return undefined;
	const kind = String(fn.kind());
	if (kind === "identifier") return fn.text();
	if (kind === "member_expression") return fn.field("property")?.text();
	return undefined;
}

/** Whether the node is literally a `process.cwd()` call. */
function isProcessCwdCall(node: SgNode): boolean {
	if (node.kind() !== "call_expression") return false;
	const fn = node.field("function");
	return (fn?.text() ?? "").replace(/\s+/g, "") === "process.cwd";
}

/** The `cwd` property of an object literal: a `pair` keyed `cwd` or the
 * shorthand `cwd`. Never a comment, a string, a nested object's key, or a
 * spread — which is what makes state-space columns P2/P3/P5 and row K8
 * structurally unreachable rather than merely unmatched. */
function cwdPropertyOf(obj: SgNode): SgNode | undefined {
	for (const prop of namedParts(obj)) {
		const kind = String(prop.kind());
		if (kind === "shorthand_property_identifier" && prop.text() === "cwd") {
			return prop;
		}
		if (kind === "pair" && unquote(prop.field("key")?.text() ?? "") === "cwd") {
			return prop;
		}
	}
	return undefined;
}

/** The expression a `cwd` property carries: a pair's value, or the shorthand
 * identifier itself. */
function cwdValueOf(prop: SgNode): SgNode {
	return prop.kind() === "pair" ? (prop.field("value") ?? prop) : prop;
}

/**
 * The names this expression reads AS THE WHOLE VALUE — a bare identifier
 * reference, not a property plucked off one and not a computed result:
 *
 *   `cwd`                     → ["cwd"]
 *   `cwd ?? projectRoot`      → ["cwd", "projectRoot"]
 *   `cwd || process.cwd()`    → ["cwd"]
 *   `ctx.cwd`                 → []      (a property OF ctx, not ctx)
 *   `process.cwd()`           → []
 *
 * Dropping `ctx.cwd` is deliberate and is what keeps the wrapper rule
 * honest. Every runner in this tree has an `async run(ctx: DispatchContext)`
 * whose spawn's cwd traces back to `ctx`; if `ctx.cwd` counted, `run` itself
 * would be classified a "spawn-routing wrapper taking a cwd at parameter 0"
 * and every in-file `run(ctx)` call would be flagged for not passing a cwd —
 * exactly backwards. A parameter is a routed cwd only when the spawn uses
 * THE PARAMETER as the cwd, which is the reviewer's round-2 separating
 * property stated precisely. A wrapper that instead takes a whole context
 * and reads `.cwd` off it is a stated bound of this scan (state-space
 * table); there is no such wrapper in the tree today, and nothing syntactic
 * distinguishes a caller that passes a good context from one that does not.
 */
function identifierReferences(node: SgNode): string[] {
	const kind = String(node.kind());
	if (kind === "identifier" || kind === "shorthand_property_identifier") {
		return [node.text()];
	}
	// A property access or a call yields a COMPUTED value, never a parameter.
	if (
		kind === "member_expression" ||
		kind === "subscript_expression" ||
		kind === "call_expression"
	) {
		return [];
	}
	return namedParts(node).flatMap(identifierReferences);
}

/** Every name a parameter/variable binding pattern introduces — and only
 * those: a default value (`{ timeoutMs = PS_TIMEOUT_MS, cwd }`) contributes
 * its left side, never the constant on its right. */
function patternNames(node: SgNode): string[] {
	const kind = String(node.kind());
	if (kind === "identifier" || kind === "shorthand_property_identifier_pattern")
		return [node.text()];
	if (kind === "object_assignment_pattern") {
		const left = namedParts(node)[0];
		return left ? patternNames(left) : [];
	}
	if (kind === "pair_pattern") {
		const value = node.field("value") ?? namedParts(node)[1];
		return value ? patternNames(value) : [];
	}
	if (
		kind === "object_pattern" ||
		kind === "array_pattern" ||
		kind === "rest_pattern"
	) {
		return namedParts(node).flatMap(patternNames);
	}
	return [];
}

/** A function's parameters in declaration order, as their binding patterns.
 * Covers `(a, b)`, `(a: T, { cwd }: O)` and the bare single-param arrow
 * `cwd => …` (which has no `formal_parameters` node at all). */
function parameterPatterns(fn: SgNode): SgNode[] {
	const list = fn.field("parameters");
	if (list) {
		return namedParts(list).map((param) => {
			const pattern = param.field("pattern");
			return pattern ?? namedParts(param)[0] ?? param;
		});
	}
	const single = fn.field("parameter");
	return single ? [single] : [];
}

interface ParamBinding {
	paramIndex: number;
	/**
	 * True when the name arrives through an OBJECT SHAPE (a destructured
	 * parameter, or a parameter destructured in the body) rather than as the
	 * parameter itself. That is the difference between checking a caller for
	 * "argument N is an object literal with a `cwd` key" and for "argument N
	 * is a cwd-bearing expression".
	 */
	viaObject: boolean;
}

/** Every `variable_declarator` inside a function's own body, not descending
 * into nested functions (whose declarations belong to their own scope). */
function bodyDeclarators(fn: SgNode): SgNode[] {
	const body = fn.field("body");
	if (!body) return [];
	const found: SgNode[] = [];
	const visit = (node: SgNode): void => {
		if (node.id() !== body.id() && isFunctionNode(node)) return;
		if (node.kind() === "variable_declarator") found.push(node);
		for (const child of node.children()) visit(child);
	};
	visit(body);
	return found;
}

/**
 * Where `name` is bound, if one of `fn`'s OWN parameters binds it. Two
 * shapes count, because both are how this repo's live wrappers are written:
 *
 * 1. A parameter binds it directly — `function lintChart(chartRoot, cwd)`
 *    (positional) or `function w(cmd, args, { cwd })` (destructured).
 * 2. A destructure of a parameter binds it — `function spawnPs(cmd, args,
 *    options) { const { cwd } = options; … }`, which is exactly how
 *    `spawnPs` and `runIacPass` are written. Round 2 read this off the
 *    parameter's TYPE ANNOTATION instead, which is why a wrapper without one
 *    (`lintChart`) was invisible to it.
 */
function findParamBinding(fn: SgNode, name: string): ParamBinding | undefined {
	const patterns = parameterPatterns(fn);
	for (const [index, pattern] of patterns.entries()) {
		if (pattern.kind() === "identifier") {
			if (pattern.text() === name)
				return { paramIndex: index, viaObject: false };
		} else if (patternNames(pattern).includes(name)) {
			return { paramIndex: index, viaObject: true };
		}
	}

	const paramIndexByName = new Map<string, number>();
	for (const [index, pattern] of patterns.entries()) {
		if (pattern.kind() === "identifier")
			paramIndexByName.set(pattern.text(), index);
	}
	for (const declarator of bodyDeclarators(fn)) {
		const target = declarator.field("name");
		const value = declarator.field("value");
		if (!target || !value) continue;
		if (target.kind() === "identifier") continue;
		if (!patternNames(target).includes(name)) continue;
		if (value.kind() !== "identifier") continue;
		const index = paramIndexByName.get(value.text());
		if (index !== undefined) return { paramIndex: index, viaObject: true };
	}
	return undefined;
}

/**
 * The INNERMOST enclosing function that supplies this expression's value
 * through one of its own parameters, or undefined when nothing does (a
 * module constant, an import, `process.cwd()`).
 *
 * Innermost-wins is the whole point. In
 * `createCwdCachedProbe((cwd) => safeSpawnAsync(cmd, args, { timeout, cwd }))`
 * the binder is the ANONYMOUS arrow, not the named factory around it, so the
 * factory is correctly never treated as a spawn-routing wrapper and its own
 * callers are never checked. Rounds 1 and 2 had to exclude those six probe
 * helpers in prose, by hand, because a text scan cannot see a scope.
 */
function findBinder(
	expr: SgNode,
): { fn: SgNode; binding: ParamBinding } | undefined {
	const names = identifierReferences(expr);
	if (names.length === 0) return undefined;
	for (let node = expr.parent(); node; node = node.parent()) {
		if (!isFunctionNode(node)) continue;
		for (const name of names) {
			const binding = findParamBinding(node, name);
			if (binding) return { fn: node, binding };
		}
	}
	return undefined;
}

/**
 * Whether an argument carries a cwd from the CALLER's own context: after
 * every `process.cwd()` sub-expression is skipped, some identifier or
 * property name still matches /cwd/i.
 *
 * `ctx.cwd`, `cwd`, `resolvedCwd`, `ctx.cwd || process.cwd()` → yes.
 * `process.cwd()`, `workspaceRoot`, `projectRoot`, `"a-cwd-string"` → no.
 * Flagging `workspaceRoot` is deliberate, not a false positive — AGENTS.md
 * shape 40: "Prefer `ctx.cwd` to `projectRoot`: the walk-up must start at
 * the dispatch directory so a nested config overrides the repo-level one."
 */
export function isCwdBearingExpression(node: SgNode): boolean {
	if (isProcessCwdCall(node)) return false;
	const kind = String(node.kind());
	if (
		kind === "identifier" ||
		kind === "shorthand_property_identifier" ||
		kind === "property_identifier"
	) {
		return /cwd/i.test(node.text());
	}
	if (kind === "member_expression") {
		const property = node.field("property");
		if (property && /cwd/i.test(property.text())) return true;
		const object = node.field("object");
		return object ? isCwdBearingExpression(object) : false;
	}
	return namedParts(node).some(isCwdBearingExpression);
}

/** The named arguments of a call, in order. */
function argumentsOf(call: SgNode): SgNode[] {
	return namedParts(call.field("arguments"));
}

/** Whether argument `index` is an object literal carrying a `cwd` property.
 * An absent argument, an opaque identifier (`opts`) and a spread-only
 * literal (`{ ...rest }`) all read as "no" — the fail-safe direction: the
 * scan cannot prove conformance, so it flags and the author either makes the
 * `cwd` explicit or registers a `// cwd-exempt:` reason. */
function argumentHasCwdKey(call: SgNode, index: number): boolean {
	const arg = argumentsOf(call)[index];
	if (!arg || arg.kind() !== "object") return false;
	return cwdPropertyOf(arg) !== undefined;
}

function argumentIsCwdBearing(call: SgNode, index: number): boolean {
	const arg = argumentsOf(call)[index];
	return arg !== undefined && isCwdBearingExpression(arg);
}

function allCalls(root: SgNode): SgNode[] {
	const calls: SgNode[] = [];
	const visit = (node: SgNode): void => {
		if (node.kind() === "call_expression") calls.push(node);
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return calls;
}

/**
 * Scan one runner source. `file` is only the label used in the reported
 * `file:line`; nothing is read from disk, so the sweep's unit test drives
 * this on inline fixture strings (one per state-space cell) while the sweep
 * itself drives it on the live tree.
 */
export async function scanSpawnCwd(
	file: string,
	source: string,
): Promise<SpawnCwdScan> {
	const napi = await loadAstGrepNapi();
	const root = napi.parse(napi.Lang.TypeScript, source).root();
	const rawLines = source.split("\n");
	const exemptAbove = (line: number): string | undefined => {
		const reason = EXEMPT_TAG.exec(rawLines[line - 2] ?? "")?.[1]?.trim();
		return reason && reason.length >= MIN_EXEMPT_REASON_LENGTH
			? reason
			: undefined;
	};

	const calls = allCalls(root);
	const sites: SpawnCwdSite[] = [];
	const wrappersByName = new Map<string, SpawnCwdWrapper>();

	/**
	 * If a spawn-routing call's `cwd` value comes from a NAMED same-file
	 * function's own parameters, that function is itself a wrapper and its
	 * callers become checked sites.
	 */
	const registerWrapperFrom = (cwdValue: SgNode): void => {
		const binder = findBinder(cwdValue);
		if (!binder) return;
		const name = functionName(binder.fn);
		if (!name) return; // anonymous closure — no call site to check (K7)
		if (wrappersByName.has(name)) return;
		wrappersByName.set(name, {
			name,
			mode: binder.binding.viaObject ? "options" : "positional",
			paramIndex: binder.binding.paramIndex,
		});
	};

	for (const call of calls) {
		const name = calleeName(call);
		if (!name || !SPAWN_NAMES.has(name)) continue;
		const line = lineOf(call);
		const optionsArg = argumentsOf(call)[SPAWN_OPTIONS_INDEX];
		const cwdProp =
			optionsArg && optionsArg.kind() === "object"
				? cwdPropertyOf(optionsArg)
				: undefined;
		sites.push({
			file,
			line,
			callee: name,
			kind: "direct",
			hasCwd: cwdProp !== undefined,
			exemptReason: exemptAbove(line),
		});
		if (cwdProp) registerWrapperFrom(cwdValueOf(cwdProp));
	}

	// Fixed point: a wrapper's own call site can reveal a further wrapper, so
	// wrapping a wrapper is not an escape.
	for (;;) {
		const before = wrappersByName.size;
		for (const wrapper of [...wrappersByName.values()]) {
			for (const call of calls) {
				if (calleeName(call) !== wrapper.name) continue;
				const arg = argumentsOf(call)[wrapper.paramIndex];
				if (!arg) continue;
				if (wrapper.mode === "options") {
					if (arg.kind() !== "object") continue;
					const prop = cwdPropertyOf(arg);
					if (prop) registerWrapperFrom(cwdValueOf(prop));
				} else {
					registerWrapperFrom(arg);
				}
			}
		}
		if (wrappersByName.size === before) break;
	}

	for (const wrapper of wrappersByName.values()) {
		for (const call of calls) {
			if (calleeName(call) !== wrapper.name) continue;
			const line = lineOf(call);
			sites.push({
				file,
				line,
				callee: wrapper.name,
				kind: "wrapper",
				hasCwd:
					wrapper.mode === "options"
						? argumentHasCwdKey(call, wrapper.paramIndex)
						: argumentIsCwdBearing(call, wrapper.paramIndex),
				exemptReason: exemptAbove(line),
			});
		}
	}

	sites.sort(
		(a, b) =>
			a.line - b.line ||
			byCodeUnit(a.callee, b.callee) ||
			byCodeUnit(a.kind, b.kind),
	);
	return {
		sites,
		wrappers: [...wrappersByName.values()].sort((a, b) =>
			byCodeUnit(a.name, b.name),
		),
	};
}
