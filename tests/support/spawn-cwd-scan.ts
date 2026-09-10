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
 * So the scan asks a parser the three questions that actually decide it:
 *
 * 1. does the options literal have a PROPERTY NAMED `cwd`, and is its value
 *    usable,
 * 2. does that value trace back to `resolveToolCwd` imported from the shared
 *    seam (the #2777 origin rule), and
 * 3. does the `cwd` value inside a spawn resolve to a PARAMETER of an
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
import { createCallSiteScanner } from "./sweep-kit.js";

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
	/** Whether the cwd value is proven to originate at resolveToolCwd. */
	resolvedFromToolCwd: boolean;
	/**
	 * The enclosing named functions and classes, outermost first
	 * (`SgRunner.probeVersion`), or undefined at module scope. Read off the
	 * AST because the text heuristic in `sweep-kit`'s `findEnclosingSymbol`
	 * only matches COLUMN-ZERO declarations: in a class-shaped file every
	 * method resolved to the same symbol, and three `sg-runner.ts` spawns
	 * whose call line is the stereotyped `const result = await
	 * safeSpawnAsync(` collided on one admission key (round-4 v3-F3).
	 */
	symbol?: string;
	/**
	 * The 1-based source lines whose CONTENT decides the cwd this site passes:
	 * the `cwd` property itself, plus the declaration of every local the value
	 * hops through. Empty when the site passes no cwd.
	 *
	 * The sweep hashes them into the admission key, so an admitted site whose
	 * cwd VALUE changes — `cwd: fileDir` edited to `cwd: ctx.cwd`, #2691's own
	 * defect — retires its admission instead of inheriting it (round-4 v3-F2:
	 * the key hashed the `safeSpawnAsync(` call line, which no cwd edit
	 * touches).
	 */
	cwdLines: number[];
	/**
	 * The 1-based source lines the call expression itself spans — callee, argv
	 * and options. The sweep hashes them into the admission key so a row names
	 * ONE call rather than a stereotyped first line: three `sg-runner.ts`
	 * spawns all open `const result = await safeSpawnAsync(`.
	 */
	callLines: number[];
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

/** The seam's own wrappers: recognised by the callee's simple name, because
 * every one of them is a pi-lens export nothing else in the tree is called. */
const SPAWN_NAMES = new Set([
	"safeSpawnAsync",
	"safeSpawnSync",
	"safeSpawn",
	"spawnSupervised",
	"execa",
]);
/**
 * `node:child_process` itself, recognised only when the file IMPORTS the name
 * unaliased. A simple-name match would read `server.spawn(root, …)` — an LSP
 * server definition's own method — as a child spawn, which is how
 * `clients/lsp/index.ts` entered the population as a phantom site when the
 * population filter and this list were reconciled (round-5 v4-N3).
 *
 * Stated bound: an ALIASED import (`import { spawn as nodeSpawn }`) is not a
 * site here — `clients/lsp/client.ts`, `clients/instance-reaper.ts` and
 * `clients/child-unref.ts` each spawn that way and are outside this sweep's
 * reach. Tracked by #2888.
 */
const NODE_SPAWN_NAMES = new Set(["spawn", "execFile"]);
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

/** The `node:child_process` names this file imports unaliased. */
function importedNodeSpawnNames(root: SgNode): Set<string> {
	const names = new Set<string>();
	const visit = (node: SgNode): void => {
		if (String(node.kind()) === "import_statement") {
			const source = node
				.field("source")
				?.text()
				.replace(/^['"]|['"]$/g, "");
			if (source === "node:child_process" || source === "child_process") {
				for (const child of node.children()) {
					if (String(child.kind()) !== "import_clause") continue;
					for (const spec of child.children()) {
						for (const named of spec.children()) {
							const text = named.text();
							// `spawn as nodeSpawn` is an import_specifier with an alias;
							// only the unaliased form is matched by simple name below.
							if (NODE_SPAWN_NAMES.has(text) && !/\bas\b/.test(named.text())) {
								names.add(text);
							}
						}
					}
				}
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return names;
}

/** Resolver bindings imported from the shared tool-cwd seam (or its one-hop
 * runner helper). Names alone are deliberately insufficient: a local helper
 * named `resolveToolCwd` is ordinary application code, not the seam. */
function importedResolverNames(root: SgNode): Set<string> {
	const names = new Set<string>();
	const visit = (node: SgNode): void => {
		if (String(node.kind()) === "import_statement") {
			const source = node
				.field("source")
				?.text()
				.replace(/^['"]|['"]$/g, "");
			const shared =
				source?.endsWith("/tool-cwd.js") ||
				source?.endsWith("/runner-helpers.js");
			if (shared) {
				for (const child of node.children()) {
					if (String(child.kind()) !== "import_clause") continue;
					for (const spec of child.children()) {
						const text = spec.text();
						const match = text.match(
							/\b(resolve(?:Tool|Runner|Formatter)Cwd)\b/,
						);
						if (match) {
							const alias = text.match(/\bas\s+([A-Za-z_$][\w$]*)/);
							names.add(alias?.[1] ?? match[1]);
						}
					}
				}
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return names;
}

/** The `cwd` property of an object literal: a `pair` keyed `cwd` or the
 * shorthand `cwd`. Never a comment, a string, a nested object's key, or a
 * spread — which is what makes state-space columns P2/P3/P5 and row K8
 * structurally unreachable rather than merely unmatched. */
function cwdPropertyOf(obj: SgNode, index: BindingIndex): SgNode | undefined {
	for (const prop of namedParts(obj)) {
		const kind = String(prop.kind());
		if (kind === "shorthand_property_identifier" && prop.text() === "cwd") {
			return prop;
		}
		if (kind === "pair" && unquote(prop.field("key")?.text() ?? "") === "cwd") {
			return prop;
		}
		if (kind === "spread_element") {
			const spread = namedParts(prop)[0];
			if (spread?.kind() === "object") {
				const nested = cwdPropertyOf(spread, index);
				if (nested) return nested;
			}
			if (spread?.kind() === "identifier") {
				const local = resolveLocalInitializer(spread, spread.text(), index);
				if (local?.init?.kind() === "object") {
					const nested = cwdPropertyOf(local.init, index);
					if (nested) return nested;
				}
			}
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
 * Whether a `cwd` property's VALUE actually supplies a working directory —
 * round-4 R3-F1. Rounds 1-3 decided the direct path on the KEY alone and
 * never read the value, so four worthless values all passed:
 *
 * | value | what Node does | verdict |
 * |---|---|---|
 * | `undefined` | option absent; the child INHERITS the host cwd | #2691 exactly |
 * | `null` | same inheritance | #2691 exactly |
 * | `""` | `spawn` fails ENOENT; the lint never runs | worse than #2691 |
 * | `process.cwd()` | the host cwd, spelled out | the cheapest red-to-green edit (shape 38); shape 40 says prefer `ctx.cwd` |
 *
 * Everything else is accepted. This deliberately does NOT apply
 * {@link isCwdBearingExpression}: on a keyed property the key `cwd:` already
 * states what the value is for, so the value's own NAME carries no extra
 * information and `cwd: resolvedRoot` must not be flagged. The
 * positional-wrapper path has no key, which is the reason it does read the
 * name — the asymmetry is the information available, not an oversight.
 */
function carriesUsableCwdLiteral(value: SgNode): boolean {
	if (isProcessCwdCall(value)) return false;
	const kind = String(value.kind());
	if (kind === "undefined" || kind === "null") return false;
	if (kind === "identifier" && value.text() === "undefined") return false;
	// An empty `""`/`''`/`` `` `` has no `string_fragment` child at all.
	if (
		(kind === "string" || kind === "template_string") &&
		namedParts(value).length === 0
	) {
		return false;
	}
	return true;
}

function carriesUsableCwd(value: SgNode, index: BindingIndex): boolean {
	const kind = String(value.kind());
	// One hop (R3-F4's helper, applied here too): `{ cwd: hostCwd }` with
	// `const hostCwd = process.cwd()` is `{ cwd: process.cwd() }` laundered
	// through a local, and `{ cwd }` with `const cwd = process.cwd()` is the
	// same laundering through a shorthand. The canonical
	// `const cwd = ctx.cwd || process.cwd()` is a binary expression and passes.
	if (kind === "identifier" || kind === "shorthand_property_identifier") {
		const local = resolveLocalInitializer(value, value.text(), index);
		if (local) {
			return local.init !== undefined && carriesUsableCwdLiteral(local.init);
		}
	}
	return carriesUsableCwdLiteral(value);
}

/**
 * Whether `expr` IS what `fn` hands back: the argument of a `return` inside it
 * (through `await`/parentheses), or a concise arrow's body. A seam call used
 * for a log line or a side effect does not make its function a resolver.
 */
function returnsExpression(
	fn: SgNode,
	expr: SgNode,
	resolverNames: Set<string>,
	returnCache: Map<string, SgNode[]>,
): boolean {
	const unwrap = (node: SgNode): SgNode => {
		let current = node;
		for (;;) {
			const kind = String(current.kind());
			if (kind !== "await_expression" && kind !== "parenthesized_expression") {
				return current;
			}
			const inner = namedParts(current)[0];
			if (!inner) return current;
			current = inner;
		}
	};
	const body = fn.field("body");
	if (!body) return false;
	const cacheKey = String(fn.id());
	let returns = returnCache.get(cacheKey);
	if (!returns) {
		if (String(body.kind()) !== "statement_block") {
			returns = [unwrap(body)];
		} else {
			returns = [];
			const visit = (node: SgNode): void => {
				if (node.id() !== fn.id() && isFunctionNode(node)) return;
				if (String(node.kind()) === "return_statement") {
					const returned = namedParts(node)[0];
					if (returned) returns?.push(unwrap(returned));
					return;
				}
				for (const child of node.children()) visit(child);
			};
			visit(body);
		}
		returnCache.set(cacheKey, returns);
	}
	return (
		returns.length > 0 &&
		returns.every(
			(returned) =>
				returned.kind() === "call_expression" &&
				isResolveToolCwdCall(returned, resolverNames),
		) &&
		returns.some((returned) => returned.id() === expr.id())
	);
}

/** Whether an expression is the resolver result, including one local/object hop. */
function isResolveToolCwdCall(
	node: SgNode,
	resolverNames: Set<string>,
): boolean {
	if (node.kind() !== "call_expression") return false;
	return resolverNames.has(
		(node.field("function")?.text() ?? "").replace(/\s+/g, ""),
	);
}

function resolvesFromToolCwd(
	node: SgNode,
	resolverNames: Set<string>,
	seen = new Set<string>(),
	index: BindingIndex,
): boolean {
	if (isResolveToolCwdCall(node, resolverNames)) return true;
	if (
		node.kind() === "identifier" ||
		node.kind() === "shorthand_property_identifier"
	) {
		if (seen.has(node.text())) return false;
		seen.add(node.text());
		const local = resolveLocalInitializer(node, node.text(), index);
		return local?.init
			? resolvesFromToolCwd(local.init, resolverNames, seen, index)
			: false;
	}
	if (node.kind() !== "object") return false;
	for (const prop of namedParts(node)) {
		if (String(prop.kind()) === "spread_element") {
			const value = namedParts(prop)[0];
			if (value && resolvesFromToolCwd(value, resolverNames, seen, index)) {
				return true;
			}
			continue;
		}
		if (
			cwdPropertyOf(node, index) === prop &&
			resolvesFromToolCwd(cwdValueOf(prop), resolverNames, seen, index)
		)
			return true;
	}
	return false;
}

/** Whether an object literal supplies a usable `cwd`: the property is present
 * AND its value is not one of the four worthless ones. */
function suppliesCwd(obj: SgNode, index: BindingIndex): boolean {
	const prop = cwdPropertyOf(obj, index);
	return prop !== undefined && carriesUsableCwd(cwdValueOf(prop), index);
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
 * Dropping a property access is deliberate and is what keeps the wrapper rule
 * honest. **It drops `options.cwd` off the wrapper's OWN parameter for the
 * same reason it drops `ctx.cwd`** (round-4 R3-F3): a helper written
 * `function w(opts) { safeSpawnAsync(c, a, { cwd: opts.cwd }) }` is NOT
 * treated as a spawn-routing wrapper, so its callers are never checked. That
 * is a real, stated bound, not an oversight — `w(x)` gives the scan an
 * argument that is a whole options object, and nothing syntactic separates a
 * caller that fills in `cwd` from one that does not. The reviewer signal for
 * such a helper is the direct-site count bump its own spawn produces; there is
 * no live instance in `clients/dispatch/runners/` today. To be followed, a
 * wrapper must take the cwd itself — positionally, destructured, or
 * destructured from an options parameter in its body, all three of which the
 * live wrappers use. Every runner in this tree has an `async run(ctx: DispatchContext)`
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

/** Every `variable_declarator` inside a function's own body, used only for
 * parameter destructuring ({@link findParamBinding}). */
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
 * ## Lexical scope, taken from the grammar instead of from a list of kinds
 *
 * Rounds 1-3 answered "which binding does this `cwd` refer to?" by scanning
 * declarators inside the nearest enclosing FUNCTION (r1), then inside
 * "a function or a `statement_block`" (r2/r3). Each spelling closed the
 * launderer it was shown and left the next scope node open: r3 shipped with a
 * dead `switch` case and a `for` head still able to hand the real yamllint
 * spawn a `ctx.cwd` with the sweep green (review v3 F1). Adding `switch_body`
 * and a `for` head to that list would be the fourth spelling of the same
 * mistake — AGENTS.md defect shape 34, a guard that enumerates surface
 * spellings.
 *
 * So this asks the tree. A `const`/`let` binding's scope is the node that OWNS
 * its declaration statement, whatever the grammar calls it; a `var` binding's
 * scope is the enclosing function, wherever inside it the statement sits. The
 * grammar's own node-type table — `@ast-grep/napi/lang/TypeScript.d.ts`,
 * header "Auto-generated from tree-sitter TypeScript v0.23.2", the
 * `node-types.json` tree-sitter generates — lists exactly fourteen node types
 * that can own a declaration:
 *
 *   ambient_declaration · do_statement · else_clause · export_statement ·
 *   for_in_statement · for_statement · if_statement · labeled_statement ·
 *   program · statement_block · switch_case · switch_default ·
 *   while_statement · with_statement
 *
 * Twelve of them ARE the scope, and need no mention here because
 * {@link scopeOfDeclarator} reads whichever one the parse produced. Two are
 * not, and are the only kinds this file has to name:
 *
 * - `export_statement` and `ambient_declaration` wrap a declaration without
 *   scoping it (`export const cwd = …` is module-scoped, not
 *   export-statement-scoped), so they are transparent; without this, a
 *   module-level `export const cwd = resolveToolCwd(…)` would false-red.
 * - `switch_case` / `switch_default` own the statement syntactically, but JS
 *   scopes a case's declarations to the whole `switch_body`, so the scope
 *   widens by one node.
 *
 * `spawn-cwd-scan.test.ts` regenerates the list of fourteen from that same
 * file and fails unless every kind has a launderer fixture, so a grammar bump
 * that adds a scope-owning node type reds there instead of silently opening
 * the hole this comment describes.
 */
const TRANSPARENT_DECLARATION_WRAPPERS = new Set([
	"export_statement",
	"ambient_declaration",
]);
const SWITCH_CASE_KINDS = new Set(["switch_case", "switch_default"]);

/** The `lexical_declaration` (`const`/`let`) or `variable_declaration` (`var`)
 * statement a declarator belongs to. */
function declarationStatementOf(decl: SgNode): SgNode | undefined {
	for (let node = decl.parent(); node; node = node.parent()) {
		const kind = String(node.kind());
		if (kind === "lexical_declaration" || kind === "variable_declaration") {
			return node;
		}
		if (isFunctionNode(node)) return undefined;
	}
	return undefined;
}

/** The node whose extent IS this declarator's lexical scope. */
function scopeOfDeclarator(decl: SgNode): SgNode | undefined {
	const statement = declarationStatementOf(decl);
	if (!statement) return undefined;
	if (String(statement.kind()) === "variable_declaration") {
		// `var` is function-scoped and hoisted, so a sibling block cannot hide
		// it. The three boundaries are a function, a class static block — whose
		// body is a plain `statement_block`, so the grammar's declaration-owner
		// table cannot name it (round-5 v4-N1) — and the module itself.
		for (let node = statement.parent(); node; node = node.parent()) {
			if (isFunctionNode(node)) return node.field("body") ?? node;
			const kind = String(node.kind());
			if (kind === "class_static_block") return node.field("body") ?? node;
			if (kind === "program") return node;
		}
		return undefined;
	}
	let owner = statement.parent();
	while (owner && TRANSPARENT_DECLARATION_WRAPPERS.has(String(owner.kind()))) {
		owner = owner.parent();
	}
	if (owner && SWITCH_CASE_KINDS.has(String(owner.kind()))) {
		owner = owner.parent();
	}
	return owner ?? undefined;
}

/** Whether a declarator's own statement is a hoisted `var`. */
function isHoistedDeclarator(decl: SgNode): boolean {
	return (
		String(declarationStatementOf(decl)?.kind() ?? "") ===
		"variable_declaration"
	);
}

/**
 * One binding, flattened to numbers at index time so a use can be resolved
 * without touching the tree again.
 */
interface BindingRecord {
	/** Source range of the node whose extent IS this binding's scope. */
	scopeStart: number;
	scopeEnd: number;
	/** Where the binding becomes readable. A `var`, a parameter, a `catch`
	 * binding and a `for…of` head are readable throughout their scope, so they
	 * carry the scope's own start; a `const`/`let` carries its declaration. */
	declStart: number;
	/** End of the declarator, so a later assignment can be told from the
	 * initializer itself. */
	declEnd: number;
	/** The initializer, when the value is readable from the declaration. */
	init?: SgNode;
	/**
	 * True when the binding says nothing about its value: a parameter, a
	 * `catch` clause, a `for…of` head, or a destructuring pattern. Such a
	 * binding SHADOWS — a use it covers resolves to "not proven", never to an
	 * outer binding's proof.
	 */
	opaque: boolean;
}

/**
 * Every binding and every rebinding in one file, built in a single walk.
 *
 * Round 4's first version answered each use by walking the tree again — once
 * per ancestor level per use, with `scopeOfDeclarator` recomputed inside a sort
 * comparator and the whole resolution repeated to build the admission key. The
 * verify measured the result: `clients/installer/index.ts` parses in 11.7 ms
 * and walks in 40.7 ms, but scanning it cost 1,941.8 ms for its 14 sites, and
 * the sweep's `beforeAll` timed out at CI's 10 s hook budget with all seven
 * assertions skipped. The index is the same model — the grammar decides each
 * binding's scope, exactly as {@link scopeOfDeclarator} did — computed once.
 */
interface BindingIndex {
	byName: Map<string, BindingRecord[]>;
	/**
	 * Start index of every REBINDING of a name, whatever shape the left side
	 * takes. Round 4 tested `left.text() === name`, which is one spelling of
	 * five: `({ cwd } = ctx)`, `({ dir: cwd } = ctx)`, `[cwd] = […]`,
	 * `(cwd) = ctx.cwd` and `for (cwd of dirs)` all rebound the name with the
	 * sweep green, and the verify shipped the literal #2691 defect into
	 * `yamllint.ts` that way (round-5 v4-F3). AGENTS.md defect shape 34, on the
	 * one axis round 4 did not rewrite.
	 */
	assignmentsByName: Map<string, number[]>;
}

/** `(cwd) = …` — the grammar keeps the parentheses, so unwrap before reading
 * what the target binds. */
function unwrapParens(node: SgNode): SgNode {
	let current = node;
	while (String(current.kind()) === "parenthesized_expression") {
		const inner = namedParts(current)[0];
		if (!inner) return current;
		current = inner;
	}
	return current;
}

/** The names an assignment target BINDS. A member expression (`o.cwd = …`)
 * binds nothing: it writes a property, it does not rebind the local. */
function assignmentTargetNames(left: SgNode): string[] {
	return patternNames(unwrapParens(left));
}

function pushRecord(
	index: BindingIndex,
	name: string,
	record: BindingRecord,
): void {
	const records = index.byName.get(name);
	if (records) records.push(record);
	else index.byName.set(name, [record]);
}

/** Whether a `for…of` / `for…in` head declares its binding (`for (const x of …)`)
 * rather than rebinding an existing one (`for (x of …)`). */
function forHeadDeclares(node: SgNode): boolean {
	return node
		.children()
		.some((child) => ["const", "let", "var"].includes(child.text()));
}

/** Build {@link BindingIndex} for one parsed file, in a single walk. */
function buildBindingIndex(root: SgNode): BindingIndex {
	const index: BindingIndex = {
		byName: new Map(),
		assignmentsByName: new Map(),
	};
	const addAssignment = (name: string, at: number): void => {
		const spots = index.assignmentsByName.get(name);
		if (spots) spots.push(at);
		else index.assignmentsByName.set(name, [at]);
	};
	const visit = (node: SgNode): void => {
		const kind = String(node.kind());
		if (kind === "variable_declarator") {
			const scope = scopeOfDeclarator(node);
			const target = node.field("name");
			if (scope && target) {
				const scopeRange = scope.range();
				const declRange = node.range();
				const readable = target.kind() === "identifier";
				const hoisted = isHoistedDeclarator(node);
				for (const name of patternNames(target)) {
					pushRecord(index, name, {
						scopeStart: scopeRange.start.index,
						scopeEnd: scopeRange.end.index,
						declStart: hoisted ? scopeRange.start.index : declRange.start.index,
						declEnd: declRange.end.index,
						init: readable ? (node.field("value") ?? undefined) : undefined,
						opaque: !readable,
					});
				}
			}
		} else if (isFunctionNode(node)) {
			const range = node.range();
			for (const pattern of parameterPatterns(node)) {
				for (const name of patternNames(pattern)) {
					pushRecord(index, name, {
						scopeStart: range.start.index,
						scopeEnd: range.end.index,
						declStart: range.start.index,
						declEnd: range.start.index,
						opaque: true,
					});
				}
			}
		} else if (kind === "catch_clause") {
			const parameter = node.field("parameter");
			const range = node.range();
			for (const name of parameter ? patternNames(parameter) : []) {
				pushRecord(index, name, {
					scopeStart: range.start.index,
					scopeEnd: range.end.index,
					declStart: range.start.index,
					declEnd: range.start.index,
					opaque: true,
				});
			}
		} else if (kind === "for_in_statement") {
			const left = node.field("left");
			const range = node.range();
			if (left && forHeadDeclares(node)) {
				for (const name of patternNames(left)) {
					pushRecord(index, name, {
						scopeStart: range.start.index,
						scopeEnd: range.end.index,
						declStart: range.start.index,
						declEnd: range.start.index,
						opaque: true,
					});
				}
			} else if (left) {
				// `for (cwd of dirs)` rebinds an existing binding on every pass.
				for (const name of assignmentTargetNames(left)) {
					addAssignment(name, range.start.index);
				}
			}
		} else if (
			kind === "assignment_expression" ||
			kind === "augmented_assignment_expression"
		) {
			const left = node.field("left");
			for (const name of left ? assignmentTargetNames(left) : []) {
				addAssignment(name, node.range().start.index);
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return index;
}

/**
 * ONE hop of local resolution — round-4 R3-F4. Reports what the binding of
 * `name` VISIBLE AT `from` was assigned, so a check can judge the value
 * instead of the name.
 *
 * It exists because the positional-wrapper check has only the argument's own
 * text to go on: `lintChart(root, hostCwd)` with `const hostCwd =
 * process.cwd()` reads as conforming under `/cwd/i`, and `lintChart(root, c)`
 * with `const c = ctx.cwd` reads as a defect. One hop fixes both directions.
 *
 * Three results, and the difference between the last two is what keeps the
 * launderers closed (round-4 v3-F1):
 *
 * - `{ init }` — declared here, with this initializer.
 * - `{ init: undefined }` — declared, value unknown (`let cwd;`, a `var`
 *   redeclared twice in one scope, or a REBINDING before the use in any of its
 *   five spellings). Callers treat it as "supplies no usable cwd", the
 *   fail-safe direction.
 * - `undefined` — no readable declaration binds the name at this use: either
 *   nothing does, or a parameter / `catch` / `for…of` head / destructuring
 *   pattern does. Callers then judge the expression on its own, and the ORIGIN
 *   rule stays unproven — a shadowing binder can never inherit an outer
 *   binding's proof.
 *
 * Exactly one hop, deliberately: `const a = b; const b = ctx.cwd` is not
 * followed.
 */
function resolveLocalInitializer(
	from: SgNode,
	name: string,
	index: BindingIndex,
): { init?: SgNode } | undefined {
	const useIndex = from.range().start.index;
	const visible = (index.byName.get(name) ?? []).filter(
		(record) =>
			record.scopeStart <= useIndex &&
			useIndex < record.scopeEnd &&
			record.declStart <= useIndex,
	);
	if (visible.length === 0) return undefined;
	// Innermost scope wins.
	let innermost = visible[0].scopeStart;
	for (const record of visible) {
		if (record.scopeStart > innermost) innermost = record.scopeStart;
	}
	const winners = visible.filter((record) => record.scopeStart === innermost);
	// Two declarations of one name in ONE scope is `var` redeclaration —
	// `if (a) { var cwd = ctx.cwd } else { var cwd = resolveToolCwd(…) }`.
	// Either can be the value at the spawn, so neither is proof: fail closed
	// rather than crediting the one that happens to sit last.
	if (winners.length > 1) return { init: undefined };
	const winner = winners[0];
	// A parameter, a `catch` binding, a `for…of` head or a destructuring
	// pattern binds the name without saying what it holds.
	if (winner.opaque) return undefined;
	// A later assignment changes the binding's value. Fail closed rather than
	// attributing the spawn to the declaration's old initializer.
	const rebound = (index.assignmentsByName.get(name) ?? []).some(
		(at) =>
			at > winner.declEnd && at >= winner.scopeStart && at < winner.scopeEnd,
	);
	if (rebound) return { init: undefined };
	return { init: winner.init };
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
function findParamBinding(
	fn: SgNode,
	name: string,
	declaratorCache: Map<string, SgNode[]>,
): ParamBinding | undefined {
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
	const cacheKey = String(fn.id());
	let declarators = declaratorCache.get(cacheKey);
	if (!declarators) {
		declarators = bodyDeclarators(fn);
		declaratorCache.set(cacheKey, declarators);
	}
	for (const declarator of declarators) {
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
	declaratorCache: Map<string, SgNode[]>,
): { fn: SgNode; binding: ParamBinding } | undefined {
	const names = identifierReferences(expr);
	if (names.length === 0) return undefined;
	for (let node = expr.parent(); node; node = node.parent()) {
		if (!isFunctionNode(node)) continue;
		for (const name of names) {
			const binding = findParamBinding(node, name, declaratorCache);
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
function isCwdBearingExpression(node: SgNode): boolean {
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

/** The 1-based lines a node spans. */
function spanLines(node: SgNode): number[] {
	const range = node.range();
	const lines: number[] = [];
	for (let line = range.start.line; line <= range.end.line; line++) {
		lines.push(line + 1);
	}
	return lines;
}

/** Every enclosing named function and class, outermost first. An anonymous
 * arrow contributes nothing, which is what keeps a probe closure's key tied
 * to the factory around it rather than to a name that does not exist. */
function enclosingSymbolPath(node: SgNode): string | undefined {
	const parts: string[] = [];
	for (let current = node.parent(); current; current = current.parent()) {
		if (isFunctionNode(current)) {
			const name = functionName(current);
			if (name) parts.push(name);
			continue;
		}
		if (String(current.kind()).endsWith("class_declaration")) {
			const name = current.field("name")?.text();
			if (name) parts.push(name);
		}
	}
	return parts.length > 0 ? parts.reverse().join(".") : undefined;
}

/**
 * The 1-based lines whose content decides a cwd value: the node's own span,
 * plus the declaration span of every local it hops through (the same hops
 * {@link resolvesFromToolCwd} follows, so the key covers exactly what the
 * verdict was read from).
 */
function cwdValueLines(
	node: SgNode,
	seen = new Set<string>(),
	index: BindingIndex,
): number[] {
	const lines = new Set<number>();
	const addSpan = (target: SgNode): void => {
		const range = target.range();
		for (let line = range.start.line; line <= range.end.line; line++) {
			lines.add(line + 1);
		}
	};
	addSpan(node);
	const kind = String(node.kind());
	if (kind === "identifier" || kind === "shorthand_property_identifier") {
		if (!seen.has(node.text())) {
			seen.add(node.text());
			const local = resolveLocalInitializer(node, node.text(), index);
			if (local?.init) {
				for (const line of cwdValueLines(local.init, seen, index))
					lines.add(line);
			}
		}
	} else if (kind === "object") {
		const prop = cwdPropertyOf(node, index);
		if (prop) {
			for (const line of cwdValueLines(cwdValueOf(prop), seen, index)) {
				lines.add(line);
			}
		}
	} else {
		// Any other expression — a call, a member expression, a template string
		// — is opaque to the hops above, so descend and let every identifier it
		// READS contribute its declaration. Round 4 stopped here, and
		// `rust-clippy.ts`'s admitted `cwd: cargoToml.replace("Cargo.toml", "")`
		// could have `cargoToml` repointed at `ctx.cwd` with the key unchanged
		// (round-5 v4-F4).
		for (const part of namedParts(node)) {
			for (const line of cwdValueLines(part, seen, index)) lines.add(line);
		}
	}
	return [...lines].sort((a, b) => a - b);
}

/** The named arguments of a call, in order. */
function argumentsOf(call: SgNode): SgNode[] {
	return namedParts(call.field("arguments"));
}

/** Whether argument `index` is an object literal that SUPPLIES a `cwd` — the
 * property present and its value usable ({@link carriesUsableCwd}; round-4
 * R3-F1 covered this path with the same change as the direct one, since it
 * was the only other key-only acceptance). An absent argument, an opaque
 * identifier (`opts`) and a spread-only literal (`{ ...rest }`) all read as
 * "no" — the fail-safe direction: the scan cannot prove conformance, so it
 * flags and the author either makes the `cwd` explicit or registers a
 * `// cwd-exempt:` reason. */
function argumentSuppliesCwd(
	call: SgNode,
	argIndex: number,
	index: BindingIndex,
): boolean {
	const arg = argumentsOf(call)[argIndex];
	if (!arg || arg.kind() !== "object") return false;
	return suppliesCwd(arg, index);
}

/** Whether the argument at `index` is cwd-bearing, judging a bare local by
 * what it was ASSIGNED rather than what it was NAMED (round-4 R3-F4). */
function argumentIsCwdBearing(
	call: SgNode,
	argIndex: number,
	index: BindingIndex,
): boolean {
	const arg = argumentsOf(call)[argIndex];
	if (!arg) return false;
	if (arg.kind() === "identifier") {
		const local = resolveLocalInitializer(arg, arg.text(), index);
		if (local) {
			return local.init !== undefined && isCwdBearingExpression(local.init);
		}
	}
	return isCwdBearingExpression(arg);
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

	// One pass for the call census: every later rule filters this list instead
	// of re-deriving `calleeName` per call. On `clients/installer/index.ts`
	// (6,150 lines, ~4,000 call expressions) the re-derivation cost 1.5 s of
	// the sweep's 5.7 s and timed the CI `beforeAll` hook out at 10 s.
	const calls = allCalls(root).map((call) => ({
		call,
		name: calleeName(call),
	}));
	const resolverNames = importedResolverNames(root);
	const returnCache = new Map<string, SgNode[]>();
	// One list decides what a site is, for the shared census below and for the
	// loop that reads the sites: two copies of the rule meant a mutation of
	// either one left the other enforcing it.
	const siteNames = new Set([...SPAWN_NAMES, ...importedNodeSpawnNames(root)]);
	// A same-file function that RETURNS the seam's result is itself a seam
	// resolver — `test-runner-client.ts`'s `resolveSpawnCwd` (#2879),
	// `tool-cwd.ts`'s `resolveRunnerCwd`, `formatters.ts`'s
	// `resolveFormatterCwd`. Round 4 matched two of those BY NAME, which is
	// the enumerate-the-spellings shape one layer up: #2879 migrated
	// `test-runner-client.ts` onto the seam through a differently named
	// method and the sweep still called it non-seam. Iterated to a fixed
	// point, so a resolver that returns another resolver's result counts too.
	for (let grew = true; grew;) {
		grew = false;
		for (const { call } of calls) {
			if (!isResolveToolCwdCall(call, resolverNames)) continue;
			for (let node = call.parent(); node; node = node.parent()) {
				if (!isFunctionNode(node)) continue;
				const name = functionName(node);
				if (
					!name ||
					resolverNames.has(name) ||
					(String(node.kind()) === "method_definition" &&
						resolverNames.has(`this.${name}`))
				)
					break;
				// Only a RETURNED seam call makes the function a resolver; one used
				// for a log line or a side effect does not.
				if (!returnsExpression(node, call, resolverNames, returnCache)) break;
				// A method is reached as `this.m(...)`; nothing else in the file
				// is that method, and any other receiver stays unproven.
				if (String(node.kind()) === "method_definition") {
					resolverNames.add(`this.${name}`);
				} else {
					resolverNames.add(name);
				}
				grew = true;
				break;
			}
		}
	}
	// `callSites` owns the generic call-site boundary. Keep the AST nodes here
	// for the runner-specific cwd dataflow, but use the shared census to ensure
	// direct spawn sites are identified by the same seam as sibling sweeps.
	// The parsed root is handed over so the shared scanner does not re-parse,
	// and one alternation over SPAWN_NAMES replaces one `find` per name — each
	// `find` strips the whole source before it looks.
	const callSiteScanner = createCallSiteScanner(source, root);
	const directSiteKeys = new Set(
		callSiteScanner
			.find(new RegExp(`^(?:${[...siteNames].join("|")})$`))
			.map((site) => `${site.line}:${site.callee}`),
	);
	const sites: SpawnCwdSite[] = [];
	const wrappersByName = new Map<string, SpawnCwdWrapper>();

	/**
	 * If a spawn-routing call's `cwd` value comes from a NAMED same-file
	 * function's own parameters, that function is itself a wrapper and its
	 * callers become checked sites.
	 */
	// One body walk per function per scan: `findParamBinding` looks for a
	// `const { cwd } = options` destructure, and without this every site
	// re-walked every enclosing function's body — 1.3 s of
	// `clients/installer/index.ts`'s 1.7 s.
	const declaratorCache = new Map<string, SgNode[]>();
	const index = buildBindingIndex(root);
	const registerWrapperFrom = (cwdValue: SgNode): void => {
		const binder = findBinder(cwdValue, declaratorCache);
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

	for (const { call, name } of calls) {
		if (!name || !siteNames.has(name)) continue;
		const line = lineOf(call);
		if (!directSiteKeys.has(`${line}:${name}`)) continue;
		const optionsArg = argumentsOf(call)[SPAWN_OPTIONS_INDEX];
		const cwdProp =
			optionsArg && optionsArg.kind() === "object"
				? cwdPropertyOf(optionsArg, index)
				: undefined;
		sites.push({
			file,
			line,
			callee: name,
			kind: "direct",
			// R3-F1: the KEY is not the answer; the value has to supply one.
			hasCwd:
				cwdProp !== undefined && carriesUsableCwd(cwdValueOf(cwdProp), index),
			resolvedFromToolCwd:
				cwdProp !== undefined &&
				resolvesFromToolCwd(
					cwdValueOf(cwdProp),
					resolverNames,
					new Set<string>(),
					index,
				),
			symbol: enclosingSymbolPath(call),
			cwdLines: cwdProp ? cwdValueLines(cwdProp, new Set<string>(), index) : [],
			callLines: spanLines(call),
			exemptReason: exemptAbove(line),
		});
		if (cwdProp) registerWrapperFrom(cwdValueOf(cwdProp));
	}

	// Fixed point: a wrapper's own call site can reveal a further wrapper, so
	// wrapping a wrapper is not an escape.
	for (;;) {
		const before = wrappersByName.size;
		for (const wrapper of [...wrappersByName.values()]) {
			for (const { call, name } of calls) {
				if (name !== wrapper.name) continue;
				const arg = argumentsOf(call)[wrapper.paramIndex];
				if (!arg) continue;
				if (wrapper.mode === "options") {
					if (arg.kind() !== "object") continue;
					const prop = cwdPropertyOf(arg, index);
					if (prop) registerWrapperFrom(cwdValueOf(prop));
				} else {
					registerWrapperFrom(arg);
				}
			}
		}
		if (wrappersByName.size === before) break;
	}

	for (const wrapper of wrappersByName.values()) {
		for (const { call, name } of calls) {
			if (name !== wrapper.name) continue;
			const line = lineOf(call);
			sites.push({
				file,
				line,
				callee: wrapper.name,
				kind: "wrapper",
				hasCwd:
					wrapper.mode === "options"
						? argumentSuppliesCwd(call, wrapper.paramIndex, index)
						: argumentIsCwdBearing(call, wrapper.paramIndex, index),
				resolvedFromToolCwd:
					wrapper.mode === "options"
						? (() => {
								const arg = argumentsOf(call)[wrapper.paramIndex];
								const prop =
									arg?.kind() === "object"
										? cwdPropertyOf(arg, index)
										: undefined;
								return prop
									? resolvesFromToolCwd(
											cwdValueOf(prop),
											resolverNames,
											new Set<string>(),
											index,
										)
									: false;
							})()
						: (() => {
								const arg = argumentsOf(call)[wrapper.paramIndex];
								return arg
									? resolvesFromToolCwd(
											arg,
											resolverNames,
											new Set<string>(),
											index,
										)
									: false;
							})(),
				symbol: enclosingSymbolPath(call),
				callLines: spanLines(call),
				cwdLines: (() => {
					const arg = argumentsOf(call)[wrapper.paramIndex];
					if (!arg) return [];
					if (wrapper.mode === "positional") {
						return cwdValueLines(arg, new Set<string>(), index);
					}
					const prop =
						arg.kind() === "object" ? cwdPropertyOf(arg, index) : undefined;
					return prop ? cwdValueLines(prop, new Set<string>(), index) : [];
				})(),
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
