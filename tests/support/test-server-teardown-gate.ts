/**
 * #4589: a test that starts a real listening server must close it, and await
 * the close, before the case or file ends.
 *
 * The 2026-10-17 audit of Greptile's reviews counted the same test-hygiene
 * leak seven times (#4563, #4572, #4573, #4574, #4581, #4582, #4586): a case
 * binds a port or a socket path, and a later case in the same worker finds it
 * held. Rule A (`test-env-restore-gate.ts`) covers unrestored environment
 * writes; this module covers the listener.
 *
 * ## The start population is hatched, and it fails closed (shape 69)
 *
 * A start is a start VERB on a handle the scan can read, or any `.listen(...)`
 * call whatever its receiver was built from:
 *
 * - `listen` counts on any receiver. The receiver may be an identifier, a
 *   chain, or an optional chain; an identifier is resolved to a binding set.
 *   A computed member (`server["listen"](0)`) is the same verb (shape 34).
 * - `bind` counts on a receiver the scan can read as a socket or server
 *   handle (`dgram.createSocket(...)`, `new WebSocketServer(...)`, a
 *   `create*Server` call), inline or through a variable. `Function.prototype
 *   .bind` is the same spelling on a value that is not a handle, so a `bind`
 *   whose receiver the scan cannot read is a declared gap below, not a
 *   report. The computed spelling is the same verb; a computed key the scan
 *   cannot read, on a handle it can, reports rather than passing.
 * - `serve` counts on a runtime global (`Bun.serve`, `Deno.serve`) and on any
 *   name bound to one (`const runtime = Bun; runtime.serve(...)`, the
 *   destructured `const { serve } = Bun; serve(...)`, a renamed
 *   `const { serve: start } = Bun; start(...)`, or a bare `serve(...)` in a
 *   file that declares no `serve` of its own), which binds a port with no
 *   handle the detector can follow. A destructured member is bound only when
 *   its KEY is a start verb: `const { serve, sleep } = Bun` binds `serve`, and
 *   `sleep(...)` is an ordinary call (P2, shape 69).
 * - An indirect invocation is the same start: `<handle>.bind.apply(handle, [0])`,
 *   `<handle>.listen.call(handle, 0)`, `Reflect.apply(handle.bind, handle, [0])`,
 *   and a verb held in a local first (`const bind = socket["bind"];
 *   bind.apply(socket, [0])`) all read the verb from the member value. The
 *   HANDLE is the receiver the call supplies (`call`/`apply` argument 0,
 *   `Reflect.apply` argument 1), never the object the verb was read from, so
 *   `a.bind.call(b, 0)` is a start on `b` (R2, shape 69). An indirect
 *   invocation whose verb the walk cannot place, or whose supplied receiver it
 *   cannot read at all, reports as `unresolvable` rather than passing. A
 *   supplied receiver the scan can read as NO handle — a function, a literal
 *   (`null`, `undefined`), or an identifier whose every binding this file
 *   declares and none of which is a construction — is `Function.prototype.bind`
 *   on that value, not a start (F2): `socket.bind.call(fn, 0)` starts nothing,
 *   even though `socket` is a handle, and `a.bind.call()` with no receiver at
 *   all binds the caller's own `this`, which names no handle, so it reports.
 *
 * Every server CONSTRUCTION the file contains (`createServer`,
 * `net.createServer`, `http.createServer`, `new WebSocketServer`, ... — any
 * call or constructor whose name ends in `Server`) must either be one of those
 * resolved bindings or be reported, and a start whose receiver or construction
 * the scan cannot attribute is reported as `unresolvable`. A new spelling of
 * "start a server" therefore reds instead of passing when it is one of the
 * three verbs, and a server construction with no attributed start always
 * reds.
 *
 * The seeds and the close are matched through AST identity, not through a list
 * of spellings: the receiver is an identifier; `C.push(receiver)` links it to
 * an array container whose elements are closed in a loop or callback; a
 * `let server; server = local` alias joins the same binding set; a `finally`,
 * an `afterEach`/`afterAll` callback, or the start's own function are the
 * accepted teardown placements, and a teardown hook that holds a same-file
 * function BY REFERENCE (`afterEach(closeServer)`) invokes and awaits it.
 *
 * ## Settling is a proof about the awaited value, where that await runs
 *
 * A close inside a `new Promise(executor)` is settled when the awaited VALUE
 * is that promise: `await new Promise(...)`, `await Promise.all([...])`,
 * `await Promise.all(xs.map(...))`, `await p.then(cb)` (the FULFILLMENT
 * callback's value chains into the awaited promise, and `p.finally(cb)`
 * likewise; a second `.then` argument or a `.catch` callback runs only on
 * rejection and settles nothing, R1), `await (async () => { ... })()` (the
 * call IS the function), a hook that returns the promise
 * (`afterEach(() => new Promise(...))`), a teardown hook that holds a helper
 * by reference (`afterEach(closeServer)`), and a variable bound to the promise
 * whose every reference settles (`const closed = ...; await closed;`, with a
 * logical assignment counted as a conditional step).
 * `await x.forEach(...)` and `await x.map(...)` settle nothing: `forEach`
 * discards its callback's value and awaiting an array of promises awaits
 * nothing. `Promise.race`/`any` can settle on another value, so they are not
 * credited. A helper settles only when it RETURNS the promise and every caller
 * settles the call: a helper that creates the promise and drops it settles
 * nothing. A close reached through a returned `close` closure is reported as
 * `helper` rather than credited: the detector does not follow a handle across
 * a function's return value. `await server.close()` is not credited either:
 * `net.Server#close` returns the server, so awaiting the call waits for
 * nothing.
 *
 * Reachability is part of the proof (shape 43): an `await` credits settlement
 * only where it runs on the hook's or helper's own straight-line path, under
 * branches that also enclose the close, and, inside a nested function, only
 * when that function's own completion is settled (the same proof a returned
 * promise gets). An `await` in a function nobody calls, in a callback the hook
 * does not await, or under a branch that may never run waits for nothing, so
 * the row reports instead of passing.
 *
 * ## Declared gaps (fail-open directions, each named)
 *
 * - **Name-based identity.** Two bindings that share a name in different
 *   scopes are one identity: a close of the sibling's `server` credits this
 *   start. The tree's files are small and one-server-per-file; a future file
 *   with a shadowed receiver needs the detector extended, not just admitted.
 * - **Returned handles.** A factory that returns `{ close }` is reported as
 *   `helper`, never followed into its callers. Every caller awaiting
 *   `handle.close()` is a reason to admit the row, not a proof.
 * - **Cross-file helpers.** A start or a close inside an imported helper is
 *   invisible; a `tests/support/` helper that closes its own listener is a
 *   start and a close in the same function, so it is clean.
 * - **`bind`/`serve` on a dot-form unreadable receiver.** A socket factory
 *   whose name the scan cannot read (`const s = mkSock(); s.bind(0)`) is
 *   treated as `Function.prototype.bind` and not followed: the population is
 *   the handle creation plus the verb. The tree holds dozens of those
 *   spellings, and the sweep's `bind` census case measures that population
 *   rather than pinning a hand-written number. `new Worker(...)`,
 *   `net.connect` and a client socket that never binds are outside it by
 *   design. The computed spelling does not widen this gap: on a handle the
 *   scan reads, it reports.
 * - **Indirect invocation, unreadable verb.** `.apply`/`.call` on a function
 *   value whose start verb the scan cannot read AND whose arguments name no
 *   handle it can read: nothing attributes the call, and nothing can. The
 *   handle-receiver form reports `unresolvable`; this residue is a plain
 *   function value handed to `.call` (`vi.doMock.apply(...)`), which starts no
 *   listener.
 * - **Computed indirect invocations.** The indirect form is read from a
 *   `.call`/`.apply` MEMBER (`a.bind.call(...)`, `Reflect.apply(...)`). A
 *   computed key never enters that walk, so `a.bind["call"](b, 0)`,
 *   `a["bind"]["call"](b, 0)`, `Reflect["apply"](a.bind, b, [0])`,
 *   `globalThis.Reflect.apply(a.bind, b, [0])` and a comma invocation
 *   (`(0, a.bind)(0)`) read clean (silent, pre-existing; no live member in
 *   `tests/**`, so the population is the admitted-form census, not a report).
 * - **Then-chains and multi-binding variables.** A promise consumed through a
 *   rejected or rejected-only branch (`.catch`, a second `.then` argument)
 *   settles nothing, and a variable with one reference that settles and
 *   another that does not is reported rather than reasoned about.
 * - **Timers.** This gate decides listeners only. `setInterval`/`setTimeout`
 *   ownership is a different seam with its own ownership rules.
 */

import { Lang, parse } from "@ast-grep/napi";

import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { stripSource } from "./sweep-kit.js";

/** Why a start is not provably closed and awaited. */
export type ServerTeardownVerdict =
	/** No close call reaches the started binding. */
	| "unclosed"
	/** A close runs, but its promise is never awaited. */
	| "unawaited"
	/** A settled close runs somewhere no teardown rule accepts. */
	| "misplaced"
	/** A settled close lives in a returned closure the detector does not follow. */
	| "helper"
	/** The receiver, or a server construction, is not readable here. */
	| "unresolvable";

/** Where the close evidence sits, for the admission guard (#4589 shape 38). */
export type ServerTeardownMechanism =
	| "teardown"
	| "finally"
	| "helper"
	| "none";

/** One started server that is not provably closed and awaited. */
export interface ServerTeardownFinding {
	/** Repo-relative path, supplied by the caller. */
	file: string;
	/** The receiver's binding identity, or a construction's callee. */
	server: string;
	/** 1-based line of the start (or of the unclassified construction). */
	line: number;
	verdict: ServerTeardownVerdict;
	/** The close evidence's own placement, re-checked by the admissions guard. */
	mechanism: ServerTeardownMechanism;
	text: string;
	reason: string;
}

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_expression",
	"function_declaration",
	"generator_function_declaration",
	"method_definition",
]);

/** Callbacks whose body runs as a test or a hook (not a transparent callback). */
const HOOK_CALLEES = new Set([
	"it",
	"test",
	"describe",
	"beforeEach",
	"afterEach",
	"beforeAll",
	"afterAll",
]);

const TEARDOWN_HOOKS = new Set(["afterEach", "afterAll"]);

/** Two wrappers over the same AST node (ast-grep returns a new object each). */
const sameNode = (
	left: SgNode | null | undefined,
	right: SgNode | null | undefined,
): boolean => {
	if (!left || !right) return false;
	const a = left.range();
	const b = right.range();
	return a.start.index === b.start.index && a.end.index === b.end.index;
};

/** The identifier a binding or parameter pattern names. */
function bindingName(node: SgNode | undefined): string | undefined {
	if (!node) return undefined;
	if (node.kind() === "identifier") return node.text();
	const pattern = node.field("pattern") ?? node.field("name");
	return pattern?.kind() === "identifier" ? pattern.text() : undefined;
}

const within = (inner: SgNode, outer: SgNode): boolean =>
	outer.range().start.index <= inner.range().start.index &&
	inner.range().end.index <= outer.range().end.index;

/** Does an expression name the identifier `name` as a whole token? */
function referencesName(text: string, name: string): boolean {
	const tokens = text.split(/[^\w$]+/);
	return tokens.includes(name);
}

function isFunction(node: SgNode): boolean {
	return FUNCTION_KINDS.has(String(node.kind()));
}

/** The call a callback function is the argument of, if it is one. */
function invokingCall(fn: SgNode): SgNode | undefined {
	// `(async () => {})()`: the callee is the parenthesized function (E3).
	let callee: SgNode = fn;
	while (callee.parent()?.kind() === "parenthesized_expression")
		callee = callee.parent() as SgNode;
	const parent = callee.parent();
	if (parent?.kind() === "call_expression") return parent;
	if (parent?.kind() !== "arguments") return undefined;
	const owner = parent.parent();
	if (owner?.kind() === "call_expression") return owner;
	// `new Promise((resolve) => ...)`: the executor is invoked by the
	// constructor, so the promise expression is the invocation site.
	if (owner?.kind() === "new_expression") return owner;
	return undefined;
}

/** Is `fn` the function this call invokes directly (`(async () => {})()`)? */
function isOwnCallee(call: SgNode, fn: SgNode): boolean {
	let callee = call.field("function");
	while (callee?.kind() === "parenthesized_expression")
		callee = callee.namedChildren()[0];
	return callee !== undefined && sameNode(callee, fn);
}

/** The expression an argument node holds, through parentheses. */
function argumentValue(node: SgNode | undefined): SgNode | undefined {
	let current = node;
	while (current?.kind() === "parenthesized_expression")
		current = current.namedChildren()[0];
	return current;
}

/** The nearest call whose callee is `name` (a member call counts). */
function calleeName(call: SgNode): string | undefined {
	const fn = call.field("function");
	if (fn?.kind() === "identifier") return fn.text();
	if (fn?.kind() === "member_expression") {
		const object = fn.field("object");
		const objectName = object?.kind() === "identifier" ? object.text() : "";
		if (HOOK_CALLEES.has(objectName)) return objectName;
		return fn.field("property")?.text();
	}
	if (fn?.kind() === "call_expression") return calleeName(fn);
	return undefined;
}

/** The name a function binds, or the variable it is assigned to. */
function functionName(fn: SgNode): string | undefined {
	if (fn.kind() === "function_declaration") return fn.field("name")?.text();
	if (fn.kind() !== "arrow_function" && fn.kind() !== "function_expression")
		return fn.field("name")?.text();
	const parent = fn.parent();
	if (parent?.kind() !== "variable_declarator") return undefined;
	const name = parent.field("name");
	return name?.kind() === "identifier" ? name.text() : undefined;
}

/** The object property a function expression is the value of, if it is one. */
function propertyKey(fn: SgNode): string | undefined {
	const parent = fn.parent();
	if (parent?.kind() !== "pair") return undefined;
	const key = parent.field("key");
	return key ? key.text() : undefined;
}

/**
 * The function a node's body belongs to: its test/hook callback when there is
 * one, else the nearest named function. A `new Promise(...)` executor or a
 * `.map(...)` callback is not an owner; it runs inside one.
 */
function ownerFunction(node: SgNode): SgNode | undefined {
	const hook = enclosingHook(node);
	if (hook) return hook;
	let fallback: SgNode | undefined;
	let current = node.parent();
	while (current) {
		if (isFunction(current)) {
			fallback ??= current;
			if (functionName(current)) return current;
		}
		current = current.parent();
	}
	return fallback;
}

/** `new Promise(...)`: the expression whose completion a close can be awaited on. */
function isPromiseConstruction(node: SgNode): boolean {
	if (node.kind() !== "new_expression") return false;
	const ctor = node.field("constructor");
	return ctor?.kind() === "identifier" && /Promise$/.test(ctor.text());
}

/**
 * The promise a close call is wrapped in, crossing only its own executor.
 * `server.close()` returns the server, so awaiting the CALL settles nothing:
 * only the callback form, wrapped in a promise, has a completion to await.
 */
function enclosingPromise(node: SgNode): SgNode | undefined {
	let current = node;
	for (;;) {
		const parent = current.parent();
		if (!parent) return undefined;
		if (isFunction(parent)) {
			const call = invokingCall(parent);
			return call && isPromiseConstruction(call) ? call : undefined;
		}
		current = parent;
	}
}

/**
 * The nearest enclosing test or hook callback, crossing callbacks the start
 * does not have to wait on (`new Promise(...)` executors, `.map(...)`
 * callbacks). A function declaration at file scope is not a hook.
 */
function enclosingHook(node: SgNode): SgNode | undefined {
	let current = node.parent();
	while (current) {
		if (isFunction(current)) {
			const call = invokingCall(current);
			if (call?.kind() === "call_expression") {
				const name = calleeName(call);
				if (name && HOOK_CALLEES.has(name)) return current;
			}
			if (call) {
				current = call.parent();
				continue;
			}
		}
		current = current.parent();
	}
	return undefined;
}

/** Does a `finally` clause enclose the node inside its own function? */
function insideFinally(node: SgNode): boolean {
	let current = node.parent();
	while (current) {
		if (current.kind() === "finally_clause") return true;
		if (isFunction(current)) return false;
		current = current.parent();
	}
	return false;
}

/** The nearest enclosing function of any kind. */
function nearestFunction(node: SgNode): SgNode | undefined {
	let current = node.parent();
	while (current && !isFunction(current)) current = current.parent();
	return current ?? undefined;
}

/** Is `node` on `owner`'s own path (no nested function in between)? */
function onOwnPath(node: SgNode, owner: SgNode): boolean {
	let current: SgNode | null = node;
	while (current) {
		if (sameNode(current, owner)) return true;
		if (isFunction(current)) return false;
		current = current.parent();
	}
	return false;
}

/**
 * Constructs under which the code below runs only sometimes (N1, shape 43).
 * A `finally` is absent on purpose: it runs however its `try` exits.
 */
const CONDITIONAL_STEPS = new Set([
	"if_statement",
	"else_clause",
	"ternary_expression",
	"switch_case",
	"switch_default",
	"for_statement",
	"for_in_statement",
	"while_statement",
	"do_statement",
	"catch_clause",
]);

/**
 * Does every branch above `node` also enclose `pair`? Both halves of a
 * settlement have to sit under the same guards: the accepted
 * `if (server) await new Promise(...)` holds both under one `if`, while
 * `const closed = ...; if (flag) await closed;` holds the await under a guard
 * the close is not in, so that await may never run.
 */
function runsWhenever(node: SgNode, pair: SgNode): boolean {
	let current = node;
	for (;;) {
		const parent = current.parent();
		if (!parent || isFunction(parent)) return true;
		const kind = String(parent.kind());
		if (kind === "binary_expression") {
			const operator = parent.field("operator")?.text() ?? "";
			if (/^(?:&&|\|\||\?\?)$/.test(operator) && !within(pair, parent))
				return false;
		} else if (kind === "if_statement" || kind === "ternary_expression") {
			const condition = parent.field("condition");
			// The condition itself always runs.
			const isCondition =
				condition !== undefined && sameNode(current, condition);
			if (!isCondition && !within(pair, parent)) return false;
		} else if (kind === "augmented_assignment_expression") {
			// `k ||= await closed`: a logical assignment evaluates its right side
			// only when its operator's condition holds (E4, shape 69).
			const operator = parent.field("operator")?.text() ?? "";
			if (/^(?:&&=|\|\|=|\?\?=)$/.test(operator) && !within(pair, parent))
				return false;
		} else if (CONDITIONAL_STEPS.has(kind) && !within(pair, parent))
			return false;
		current = parent;
	}
}

/** The START members an object pattern binds: `{ serve }`, `{ serve: s }`. */
function patternMembers(node: SgNode | undefined): string[] {
	if (!node || node.kind() !== "object_pattern") return [];
	return node.namedChildren().flatMap((child) => {
		if (child.kind() === "shorthand_property_identifier_pattern")
			return START_VERBS.has(child.text()) ? [child.text()] : [];
		if (child.kind() === "pair_pattern") {
			// The KEY decides: `{ serve: start }` binds a start, `{ write: save }`
			// binds an ordinary helper (P2, shape 69).
			const key = child.field("key")?.text() ?? "";
			const value = child.field("value");
			return START_VERBS.has(key) && value?.kind() === "identifier"
				? [value.text()]
				: [];
		}
		return [];
	});
}
/** Does an expression name a runtime global that binds a port itself? */
function namesRuntimeGlobal(node: SgNode): boolean {
	if (node.kind() === "identifier")
		return RUNTIME_BIND_OBJECTS.has(node.text());
	if (node.kind() === "member_expression") {
		const object = node.field("object");
		return (
			object?.kind() === "identifier" && RUNTIME_BIND_OBJECTS.has(object.text())
		);
	}
	return false;
}

interface Binding {
	name: string;
	value: SgNode;
}

/** Verbs that bind a started handle to a port, path, or socket. */
const START_VERBS = new Set(["listen", "bind", "serve"]);

/** Members that invoke a function VALUE: `socket.bind.apply(...)`, `.call(...)`. */
const INDIRECT_INVOKE = new Set(["apply", "call"]);

/** Runtime globals whose `serve(...)` binds a port with no readable handle. */
const RUNTIME_BIND_OBJECTS = new Set(["Bun", "Deno"]);

/** Promise combinators that settle only when every input does. */
const PROMISE_ALL = new Set(["all", "allSettled"]);

/** Callback-driven calls that carry their callback's value into an array. */
const PROMISE_CALLBACK_METHODS = new Set(["map", "flatMap"]);

/** The construction forms a start may be built from (a morphological rule). */
function isServerConstruction(node: SgNode): boolean {
	if (node.kind() === "call_expression") {
		const name = calleeName(node);
		return name !== undefined && /create\w*Server$|^createServer$/.test(name);
	}
	if (node.kind() === "new_expression") {
		const ctor = node.field("constructor");
		const name =
			ctor?.kind() === "identifier"
				? ctor.text()
				: ctor?.kind() === "member_expression"
					? (ctor.field("property")?.text() ?? "")
					: "";
		return /Server$/.test(name);
	}
	return false;
}

/**
 * A socket handle (`dgram.createSocket`, `new dgram.Socket`, ...): the same
 * morphological rule as a server construction, on the `Socket` noun.
 */
function isSocketConstruction(node: SgNode): boolean {
	let name: string | undefined;
	if (node.kind() === "call_expression") name = calleeName(node);
	else if (node.kind() === "new_expression") {
		const ctor = node.field("constructor");
		name =
			ctor?.kind() === "identifier"
				? ctor.text()
				: ctor?.field("property")?.text();
	}
	return name !== undefined && /Socket$/.test(name);
}

/** The callee text of a construction, for a report that names it. */
function constructionName(node: SgNode): string {
	if (node.kind() === "call_expression") return calleeName(node) ?? node.text();
	const ctor = node.field("constructor");
	return ctor?.text().replace(/\s+/g, "") ?? node.text().replace(/\s+/g, "");
}

/**
 * A settled close: the promise that wraps it is awaited as a value before its
 * hook or case completes. Placement (where the close sits) is decided
 * separately, by `placementsOf`.
 */
interface CloseEvidence {
	node: SgNode;
	settled: boolean;
	placements: Set<
		"teardown" | "finally" | "same-function" | "helper" | "other"
	>;
}

/** A binding set's scalar name plus every identifier joined to it by `=`. */
function identityNames(
	receiver: string,
	bindings: readonly Binding[],
): string[] {
	const names = new Set([receiver]);
	for (let pass = 0; pass < 4; pass++) {
		for (const binding of bindings) {
			const right = binding.value;
			if (right?.kind() !== "identifier") continue;
			const other = right.text();
			if (names.has(binding.name)) names.add(other);
			if (names.has(other)) names.add(binding.name);
		}
	}
	return [...names];
}

export function findUnclosedServerStarts(
	file: string,
	source: string,
): ServerTeardownFinding[] {
	const blanked = stripSource(source);
	// Cheap admission: no start verb and no handle construction means nothing
	// to parse.
	if (
		!/\b(?:listen|bind|serve)\b/.test(blanked) &&
		!/\b\w*(?:Server|Socket)\s*\(/.test(blanked)
	) {
		return [];
	}

	const root = parse(Lang.TypeScript, source).root();
	const calls = root.findAll({ rule: { kind: "call_expression" } });
	const news = root.findAll({ rule: { kind: "new_expression" } });
	const lines = source.split("\n");

	const bindings: Binding[] = [];
	for (const declarator of root.findAll({
		rule: { kind: "variable_declarator" },
	})) {
		const name = declarator.field("name");
		const value = declarator.field("value");
		if (name?.kind() === "identifier" && value) {
			bindings.push({ name: name.text(), value });
		}
	}
	for (const assignment of root.findAll({
		rule: { kind: "assignment_expression" },
	})) {
		const left = assignment.field("left");
		const right = assignment.field("right");
		if (left?.kind() === "identifier" && right) {
			bindings.push({ name: left.text(), value: right });
		}
	}

	/** A construction whose value is a handle the scan can read. */
	const isHandleConstruction = (node: SgNode): boolean =>
		isServerConstruction(node) || isSocketConstruction(node);

	/** Is this receiver a socket/server handle the scan can read? */
	const bindsOnHandle = (receiver: SgNode): boolean => {
		if (receiver.kind() !== "identifier") return isHandleConstruction(receiver);
		const names = identityNames(receiver.text(), bindings);
		return bindings.some(
			(binding) =>
				names.includes(binding.name) && isHandleConstruction(binding.value),
		);
	};

	/** A value this scan can read as PROVEN not a socket or server handle. */
	const isPlainValue = (node: SgNode, depth = 0): boolean => {
		const kind = String(node.kind());
		if (
			kind === "null" ||
			kind === "undefined" ||
			kind === "true" ||
			kind === "false" ||
			kind === "number" ||
			kind === "string" ||
			kind === "regex" ||
			kind === "class"
		)
			return true;
		if (isFunction(node)) return true;
		if (kind !== "identifier" || depth >= 3) return false;
		const names = identityNames(node.text(), bindings);
		const own = bindings.filter((binding) => names.includes(binding.name));
		// EVERY binding must be plain: one unknown value (`const b = makeHandle()`)
		// may be a socket, and this walk may not assume otherwise (r6 P1).
		return own.length > 0 && own.every((b) => isPlainValue(b.value, depth + 1));
	};

	/**
	 * A supplied receiver the scan can READ as a value that binds no port: a
	 * literal, a function, or an identifier whose every binding this file
	 * declares is itself plain. `Function.prototype.bind.call(fn, null)` and
	 * `socket.bind.call(fn, 0)` are `fn.bind(...)` -- a bind on a value that is
	 * not a handle -- so neither starts a listener (F2, shape 69). Saying
	 * "indirect, therefore a start" made every `.call`/`.apply` on a function
	 * value report, which the dot form does not. A receiver the scan cannot read
	 * stays reportable: an unknown factory may return a socket, so
	 * `const b = makeHandle(); socket.bind.call(b, 0)` still reports (r6 P1).
	 */
	const bindsOnPlainValue = (receiver: SgNode): boolean =>
		isPlainValue(receiver);

	const starts: Array<{
		receiver: SgNode;
		node: SgNode;
		unreadableVerb?: boolean;
	}> = [];

	/** Names bound to a runtime global: `const { serve } = Bun`, `= Bun`. */
	const runtimeNames = new Set<string>(RUNTIME_BIND_OBJECTS);
	/** Functions and values this file declares, so a bare `serve()` is local. */
	const localNames = new Set<string>();
	for (const declarator of root.findAll({
		rule: { kind: "variable_declarator" },
	})) {
		const value = declarator.field("value");
		const name = declarator.field("name");
		if (!name) continue;
		if (value && namesRuntimeGlobal(value)) {
			if (name.kind() === "identifier")
				for (const alias of identityNames(name.text(), bindings))
					runtimeNames.add(alias);
			for (const member of patternMembers(name)) runtimeNames.add(member);
			continue;
		}
		if (name.kind() === "identifier") localNames.add(name.text());
	}
	for (const fn of root.findAll({
		rule: { any: [...FUNCTION_KINDS].map((kind) => ({ kind })) },
	})) {
		const name = functionName(fn);
		if (name) localNames.add(name);
	}

	/**
	 * The receiver and the verb a member expression starts with (N3, shape 34). A
	 * computed member (`socket["bind"](0)`) is that same verb; `verb` is
	 * undefined when the scan cannot read the key, and `computed` records it so a
	 * start spelling nobody can read reports instead of passing.
	 */
	const targetOf = (
		node: SgNode | undefined,
	): { receiver: SgNode; verb?: string; computed: boolean } | undefined => {
		if (node?.kind() === "member_expression") {
			const receiver = node.field("object");
			const property = node.field("property");
			if (!receiver || !property) return undefined;
			return { receiver, verb: property.text(), computed: false };
		}
		if (node?.kind() === "subscript_expression") {
			const receiver = node.field("object");
			if (!receiver) return undefined;
			const index = node.field("index");
			const verb =
				index?.kind() === "string" ? index.text().slice(1, -1) : undefined;
			return { receiver, verb, computed: true };
		}
		return undefined;
	};

	/** The member a local identifier holds, through `const bind = socket.bind`. */
	const boundTarget = (node: SgNode | undefined) => {
		if (node?.kind() !== "identifier") return undefined;
		const binding = bindings.find((b) => b.name === node.text());
		return binding ? targetOf(binding.value) : undefined;
	};

	/**
	 * The start an `.apply`/`.call` invocation reaches (shape 69, R2): the start
	 * VERB comes from the function value (`socket.bind`), and the HANDLE is the
	 * receiver the call SUPPLIES -- `Function.prototype.call`'s first argument,
	 * `Reflect.apply`'s second -- never the object the verb was read from.
	 * `a.bind.call(b, 0)` invokes `a`'s verb with `b` bound, so the start is on
	 * `b`; the object `a` is closed only when it is the supplied receiver.
	 * `undefined` when the scan cannot place the verb at all.
	 */
	const indirectTarget = (call: SgNode) => {
		const fn = call.field("function");
		if (fn?.kind() !== "member_expression") return undefined;
		const object = fn.field("object") ?? undefined;
		const args = call.field("arguments")?.namedChildren() ?? [];
		// `Reflect.apply(fnValue, thisArg, args)`: the function value is
		// argument 0 and the supplied receiver argument 1. `.call`/`.apply` on
		// the function value itself read the verb from it and take the receiver
		// as argument 0.
		const reflect =
			object?.kind() === "identifier" && object.text() === "Reflect";
		const verbTarget =
			targetOf(reflect ? args[0] : object) ??
			boundTarget(reflect ? args[0] : object);
		if (!verbTarget) return undefined;
		// A call that supplies no receiver (`fn.call()`) binds the caller's own
		// `this`, which no handle here names: the call node reports instead.
		const supplied = reflect ? args[1] : args[0];
		return {
			receiver: supplied ?? call,
			verb: verbTarget.verb,
			computed: verbTarget.computed,
		};
	};

	/** The handle an indirect invocation is handed, when the scan can read one. */
	const indirectHandle = (call: SgNode): SgNode | undefined =>
		(call.field("arguments")?.namedChildren() ?? []).find((argument) =>
			bindsOnHandle(argument),
		);

	for (const call of calls) {
		const fn = call.field("function");
		// A runtime global's own `serve`, on an identifier the scan cannot read
		// through: destructured (`const { serve } = Bun`), renamed
		// (`const { serve: startServer } = Bun`), or an alias of the global. A
		// file that declares its own function of that name is a helper, not a
		// start.
		if (
			fn?.kind() === "identifier" &&
			(fn.text() === "serve" || runtimeNames.has(fn.text())) &&
			!localNames.has(fn.text())
		) {
			starts.push({ receiver: fn, node: call });
			continue;
		}
		const indirectVerb = INDIRECT_INVOKE.has(
			fn?.kind() === "member_expression"
				? (fn.field("property")?.text() ?? "")
				: "",
		);
		const target = indirectVerb
			? indirectTarget(call)
			: targetOf(fn ?? undefined);
		if (!target) {
			// An indirect invocation the walk cannot place, on a handle it can read:
			// the start spelling is unreadable, so it reports (shape 69).
			const handle = indirectVerb ? indirectHandle(call) : undefined;
			if (handle)
				starts.push({ receiver: handle, node: call, unreadableVerb: true });
			continue;
		}
		const { receiver, verb, computed } = target;
		// `listen` binds whatever its receiver is. `bind`/`serve` share their
		// spelling with `Function.prototype.bind` and with plain helper calls,
		// so they count only on a receiver this scan can read as a socket or
		// server handle, or on a runtime global whose `serve` binds a port
		// (`Bun.serve`, `runtime.serve`). A dot-form receiver the scan cannot
		// read is the declared gap: the tree holds dozens of
		// `Function.prototype.bind` calls, and the sweep's `bind` census case
		// measures that population rather than pinning a hand-written number.
		const runtimeBind =
			receiver.kind() === "identifier" && runtimeNames.has(receiver.text());
		const readable = bindsOnHandle(receiver);
		if (verb !== undefined && START_VERBS.has(verb)) {
			// `listen` always reports. `bind`/`serve` report on a runtime global, on a
			// receiver the scan reads as a handle, or -- for an INDIRECT invocation --
			// on a supplied receiver it cannot place at all; a receiver it can read as
			// no handle is the same `Function.prototype.bind` the dot form admits
			// (F2, shape 69).
			if (
				verb === "listen" ||
				runtimeBind ||
				readable ||
				(indirectVerb && !bindsOnPlainValue(receiver))
			)
				starts.push({ receiver, node: call });
			continue;
		}
		// A computed key the scan cannot read, on a handle the scan can: the
		// start spelling is unreadable, so it reports (shape 69). A readable
		// key that is not a start verb (`server["close"]()`) is not one.
		if (computed && verb === undefined && (readable || runtimeBind))
			starts.push({ receiver, node: call, unreadableVerb: true });
	}
	const constructions = [...calls, ...news].filter(isServerConstruction);

	// Every construction a resolved start was built from is accounted for; the
	// rest are reported below, so a start spelling the detector cannot read is
	// never counted clean (shape 69). Keyed by range: two walks return distinct
	// wrapper objects for the same node.
	const covered = new Set<string>();
	const rangeKey = (node: SgNode): string => {
		const range = node.range();
		return `${range.start.index}:${range.end.index}`;
	};
	const findings: ServerTeardownFinding[] = [];

	const closeCalls: SgNode[] = [];
	for (const call of calls) {
		const fn = call.field("function");
		if (fn?.kind() !== "member_expression") continue;
		if (fn.field("property")?.text() !== "close") continue;
		const receiver = fn.field("object");
		if (receiver?.kind() === "identifier") closeCalls.push(call);
	}
	/** Every function parameter or loop binding fed by a container. */
	function elementBindings(container: string): string[] {
		const names: string[] = [];
		for (const call of calls) {
			const fn = call.field("function");
			if (fn?.kind() !== "member_expression") continue;
			const object = fn.field("object");
			if (!object || !referencesName(object.text(), container)) continue;
			const args = call.field("arguments")?.namedChildren() ?? [];
			for (const arg of args) {
				if (!isFunction(arg)) continue;
				const parameter = bindingName(
					arg.field("parameters")?.namedChildren()[0],
				);
				if (parameter) names.push(parameter);
			}
		}
		for (const loop of root.findAll({ rule: { kind: "for_in_statement" } })) {
			const right = loop.field("right");
			if (!right || !referencesName(right.text(), container)) continue;
			const left = loop.field("left");
			const binding =
				left?.kind() === "identifier"
					? left
					: left?.kind() === "variable_declaration"
						? left
								.namedChildren()
								.find((child) => child.kind() === "variable_declarator")
						: undefined;
			const name =
				binding?.kind() === "identifier"
					? binding.text()
					: binding?.field("name")?.text();
			if (name) names.push(name);
		}
		return names;
	}

	function containersFedBy(names: readonly string[]): string[] {
		const containers: string[] = [];
		for (const call of calls) {
			const fn = call.field("function");
			if (fn?.kind() !== "member_expression") continue;
			const property = fn.field("property")?.text();
			if (property !== "push" && property !== "unshift") continue;
			const receiver = fn.field("object");
			if (receiver?.kind() !== "identifier") continue;
			const args = call.field("arguments")?.namedChildren() ?? [];
			const feeds = args.some(
				(arg) => arg.kind() === "identifier" && names.includes(arg.text()),
			);
			if (feeds) containers.push(receiver.text());
		}
		return containers;
	}

	/** The name a call invokes, when the callee is a plain identifier. */
	const calleeIdentifier = (call: SgNode): string | undefined => {
		const fn = call.field("function");
		return fn?.kind() === "identifier" ? fn.text() : undefined;
	};

	/** `Promise.all(...)`, `Promise.allSettled(...)`: settles iff all do. */
	const isCombinator = (call: SgNode): boolean => {
		const fn = call.field("function");
		if (fn?.kind() !== "member_expression") return false;
		const object = fn.field("object");
		if (object?.kind() !== "identifier" || object.text() !== "Promise")
			return false;
		return PROMISE_ALL.has(fn.field("property")?.text() ?? "");
	};

	/** Every identifier naming `name` outside the node that declares it. */
	function referencesTo(name: string, exclude: SgNode): SgNode[] {
		const start = exclude.range().start.index;
		const end = exclude.range().end.index;
		return root.findAll({ rule: { kind: "identifier" } }).filter((node) => {
			if (node.text() !== name) return false;
			const at = node.range().start.index;
			return !(start <= at && at < end);
		});
	}

	/**
	 * A teardown hook that holds this function BY REFERENCE: `afterEach(fn)`
	 * invokes `fn` and awaits the value it returns, so its promise settles.
	 */
	function teardownHolding(name: string, owner: SgNode): string | undefined {
		for (const reference of referencesTo(name, owner)) {
			const parent = reference.parent();
			if (parent?.kind() !== "arguments") continue;
			const call = parent.parent();
			if (call?.kind() !== "call_expression") continue;
			const hook = calleeName(call);
			if (hook && TEARDOWN_HOOKS.has(hook)) return hook;
		}
		return undefined;
	}

	/** The value a named binding or assignment holds, settled at every read. */
	function settleBinding(
		binding: SgNode,
		depth: number,
		collection: boolean,
	): boolean {
		const name = binding.field("name") ?? binding.field("left");
		if (name?.kind() !== "identifier") return false;
		if (depth >= 3) return false;
		const value = binding.field("value") ?? binding.field("right") ?? undefined;
		const refs = referencesTo(name.text(), name);
		if (refs.length === 0) return false;
		return refs.every((ref) => settleFrom(ref, depth + 1, collection, value));
	}

	/**
	 * An `await` credits settlement only where the hook or helper actually runs
	 * it (N1, shape 43): on the owner's own straight-line path, under branches
	 * that also enclose the close, and, inside a nested function, only when that
	 * function's own completion is settled. A nested function nobody calls, a
	 * callback the hook does not await, and a branch that may never run all
	 * wait for nothing.
	 */
	function creditedAwait(
		awaitNode: SgNode,
		close: SgNode,
		depth: number,
	): boolean {
		if (!runsWhenever(awaitNode, close)) return false;
		const owner = nearestFunction(awaitNode);
		// Module scope: a top-level await runs straight-line; only its placement
		// is judged, by `placementsOf`.
		if (!owner) return true;
		const hook = enclosingHook(awaitNode);
		// Nothing the test runs encloses this await: a module-level helper that
		// closes what it starts proves the wait where it runs, and a caller in
		// another file is the declared cross-file gap.
		if (!hook) return true;
		if (onOwnPath(awaitNode, hook)) return true;
		return settleFunctionReturn(owner, depth, false);
	}

	/** The value a function returns, settled by whoever consumes the function. */
	function settleFunctionReturn(
		fn: SgNode,
		depth: number,
		collection: boolean,
	): boolean {
		const call = invokingCall(fn);
		if (call) {
			if (call.kind() === "new_expression") return false;
			const name = calleeName(call);
			// A test or hook callback: vitest awaits what it returns.
			if (name && HOOK_CALLEES.has(name)) return !collection;
			if (name && PROMISE_CALLBACK_METHODS.has(name))
				return settleFrom(call, depth + 1, true);
			// `p.then(cb)` credits only its FULFILLMENT callback: that value chains
			// into the promise the call returns, so awaiting the call awaits it
			// (E3). A SECOND `.then` argument and a `.catch` callback run only on
			// rejection, so neither pays for a close that may never be awaited
			// (R1). `p.finally(cb)` always runs and chains the same way.
			if (name === "then" || name === "finally") {
				const first = call.field("arguments")?.namedChildren()[0];
				return (
					sameNode(argumentValue(first), fn) &&
					settleFrom(call, depth + 1, false)
				);
			}
			if (name === "catch") return false;
			// An IIFE: the call IS this function, so awaiting it awaits the function.
			if (isOwnCallee(call, fn)) return settleFrom(call, depth + 1, false);
			// `forEach` and every other callee discard the callback's value.
			return false;
		}
		const name = functionName(fn);
		if (!name || depth >= 2) return false;
		if (teardownHolding(name, fn)) return true;
		const sites = calls.filter(
			(site) => calleeIdentifier(site) === name && !within(site, fn),
		);
		if (sites.length === 0) return false;
		return sites.every((site) => settleFrom(site, depth + 1, false));
	}

	/**
	 * Does the value at `node` settle before its hook or case completes?
	 *
	 * Only an await whose VALUE is the promise settles it (F1): awaiting a
	 * `forEach` result (undefined) or a `.map` result (an array) awaits nothing.
	 * `collection` follows a value that has become a collection of promises on
	 * the way up, so `await [promise]` is not credited and
	 * `await Promise.all([promise])` is. `close` is the node whose settlement is
	 * being proven, so an await under a branch that does not also enclose it is
	 * not credited (N1).
	 */
	function settleFrom(
		node: SgNode,
		depth: number,
		collection = false,
		close: SgNode | undefined = undefined,
	): boolean {
		const origin = close ?? node;
		let current = node;
		for (;;) {
			const parent = current.parent();
			if (!parent) return false;
			const kind = String(parent.kind());
			if (
				kind === "parenthesized_expression" ||
				kind === "as_expression" ||
				kind === "satisfies_expression" ||
				kind === "non_null_expression"
			) {
				current = parent;
				continue;
			}
			if (kind === "await_expression")
				return !collection && creditedAwait(parent, origin, depth);
			if (kind === "array") {
				collection = true;
				current = parent;
				continue;
			}
			if (kind === "arguments") {
				const call = parent.parent();
				if (call?.kind() !== "call_expression") return false;
				if (!isCombinator(call)) return false;
				collection = false;
				current = call;
				continue;
			}
			if (kind === "variable_declarator")
				return (
					sameNode(current, parent.field("value")) &&
					settleBinding(parent, depth, collection)
				);
			if (kind === "assignment_expression")
				return (
					sameNode(current, parent.field("right")) &&
					settleBinding(parent, depth, collection)
				);
			if (kind === "return_statement") {
				let owner = parent.parent();
				while (owner && !isFunction(owner)) owner = owner.parent();
				return owner ? settleFunctionReturn(owner, depth, collection) : false;
			}
			if (isFunction(parent) && sameNode(current, parent.field("body")))
				return settleFunctionReturn(parent, depth, collection);
			// A promise created and dropped in a body, a member access, or an
			// expression statement settles nothing.
			return false;
		}
	}

	function settlementsOf(node: SgNode, depth: number): boolean {
		const promise = enclosingPromise(node);
		if (!promise) return false;
		return settleFrom(promise, depth, false);
	}

	function placementsOf(
		node: SgNode,
		startFunction: SgNode | undefined,
		depth: number,
	): CloseEvidence["placements"] {
		const placements: CloseEvidence["placements"] = new Set();
		const hook = enclosingHook(node);
		if (hook) {
			const call = invokingCall(hook);
			const name =
				call?.kind() === "call_expression" ? calleeName(call) : undefined;
			if (name && TEARDOWN_HOOKS.has(name)) {
				placements.add("teardown");
				return placements;
			}
		}
		if (insideFinally(node)) {
			placements.add("finally");
			return placements;
		}
		let current = node;
		for (;;) {
			const parent = current.parent();
			if (!parent) {
				placements.add("other");
				return placements;
			}
			if (!isFunction(parent)) {
				current = parent;
				continue;
			}
			if (sameNode(parent, startFunction)) {
				placements.add("same-function");
				return placements;
			}
			const call = invokingCall(parent);
			if (call) {
				current = call;
				continue;
			}
			// A returned `close` closure: a helper the detector does not follow.
			if (propertyKey(parent)) {
				placements.add("helper");
				return placements;
			}
			const name = functionName(parent);
			if (name && depth < 2) {
				const sites = calls.filter((site) => {
					const fn = site.field("function");
					return (
						fn?.kind() === "identifier" &&
						fn.text() === name &&
						!within(site, parent)
					);
				});
				for (const site of sites) {
					for (const placement of placementsOf(site, startFunction, depth + 1))
						placements.add(placement);
				}
				if (placements.size > 0) return placements;
				// A teardown hook that holds the function BY REFERENCE
				// (`afterEach(closeServer)`) invokes it and awaits its value.
				if (teardownHolding(name, parent)) {
					placements.add("teardown");
					return placements;
				}
			}
			placements.add("other");
			return placements;
		}
	}

	for (const start of starts) {
		const receiver = start.receiver;
		const line = start.node.range().start.line + 1;
		const text = lines[line - 1]?.trim() ?? "";
		if (start.unreadableVerb) {
			findings.push({
				file,
				server: receiver.text().replace(/\s+/g, ""),
				line,
				verdict: "unresolvable",
				mechanism: "none",
				text,
				reason: `the start verb on \`${receiver.text().replace(/\s+/g, " ")}\` is a computed key this scan cannot read, so the call cannot be attributed`,
			});
			continue;
		}
		if (receiver.kind() !== "identifier") {
			// The receiver itself is reported, and any construction it wraps is
			// part of that same report (no second row for one defect).
			covered.add(rangeKey(receiver));
			findings.push({
				file,
				server: receiver.text().replace(/\s+/g, ""),
				line,
				verdict: "unresolvable",
				mechanism: "none",
				text,
				reason: `the start's receiver is not a plain identifier (${receiver.text().replace(/\s+/g, " ")}), so no close can be attributed to it`,
			});
			continue;
		}
		const names = identityNames(receiver.text(), bindings);
		const built = bindings.filter(
			(binding) =>
				names.includes(binding.name) && isHandleConstruction(binding.value),
		);
		if (built.length === 0) {
			findings.push({
				file,
				server: receiver.text(),
				line,
				verdict: "unresolvable",
				mechanism: "none",
				text,
				reason: `receiver \`${receiver.text()}\` is bound to ${
					bindings
						.find((binding) => binding.name === receiver.text())
						?.value.text()
						.replace(/\s+/g, " ") ?? "nothing declared here"
				}, which this detector cannot read as a server or socket construction`,
			});
			continue;
		}
		for (const binding of built) covered.add(rangeKey(binding.value));

		const containers = containersFedBy(names);
		const elements = containers.flatMap((container) =>
			elementBindings(container),
		);
		const receivers = new Set([...names, ...elements]);
		const startOwner = ownerFunction(start.node);
		const stray: CloseEvidence[] = [];
		const evidence: CloseEvidence[] = closeCalls
			.filter((call) => {
				const fn = call.field("function");
				if (fn?.kind() !== "member_expression") return false;
				const object = fn.field("object");
				return object?.kind() === "identifier" && receivers.has(object.text());
			})
			.map((call) => ({
				node: call,
				settled: settlementsOf(call, 0),
				placements: placementsOf(call, startOwner, 0),
			}));
		const candidates: CloseEvidence[] = evidence.filter((candidate) => {
			// A close is this start's evidence when it is a teardown/finally (it
			// applies to the whole file or describe), when a helper chain reaches
			// it from the start's own function, or when it lives in that function.
			// A closure inside an unrelated named function closes THAT function's
			// server, not this one, even when the binding name is the same.
			if (
				candidate.placements.has("teardown") ||
				candidate.placements.has("finally") ||
				candidate.placements.has("same-function")
			)
				return true;
			const evidenceOwner = ownerFunction(candidate.node);
			if (!evidenceOwner || !functionName(evidenceOwner)) return true;
			if (sameNode(evidenceOwner, startOwner)) return true;
			// A close this file runs in another function is not credited, but it is
			// not silent either: a start whose only close lives there reports that
			// close rather than "no close reaches it" (F1).
			stray.push(candidate);
			return false;
		});

		const acceptedPlacement = (evidence: CloseEvidence): boolean =>
			evidence.placements.has("teardown") ||
			evidence.placements.has("finally") ||
			evidence.placements.has("same-function");
		const accepted = candidates.find(
			(evidence) => evidence.settled && acceptedPlacement(evidence),
		);
		if (accepted) continue;

		const mechanismOf = (evidence: CloseEvidence): ServerTeardownMechanism => {
			if (evidence.placements.has("teardown")) return "teardown";
			if (evidence.placements.has("finally")) return "finally";
			if (evidence.placements.has("helper")) return "helper";
			return "none";
		};
		const settledElsewhere = candidates.find((evidence) => evidence.settled);
		const helper = candidates.find((evidence) =>
			evidence.placements.has("helper"),
		);
		// A close that runs in another function of this file: not credited, but
		// not "nothing reaches it" either.
		const escaped = stray[0];
		const mechanism = helper
			? mechanismOf(helper)
			: settledElsewhere
				? mechanismOf(settledElsewhere)
				: candidates.length > 0
					? mechanismOf(candidates[0])
					: escaped
						? mechanismOf(escaped)
						: "none";
		const verdict: ServerTeardownVerdict = helper
			? "helper"
			: settledElsewhere
				? "misplaced"
				: candidates.length > 0 || escaped
					? "unawaited"
					: "unclosed";
		const reason =
			verdict === "helper"
				? `\`${receiver.text()}.close()\` runs inside a returned closure; the detector does not follow the handle into its callers, so the row needs an admission that names the caller`
				: verdict === "misplaced"
					? `\`${receiver.text()}.close()\` is settled, but not in a teardown hook, a \`finally\`, the start's own function, or a helper every call site settles`
					: verdict === "unawaited"
						? escaped && candidates.length === 0
							? `\`${receiver.text()}.close()\` runs in \`${functionName(ownerFunction(escaped.node) ?? escaped.node) ?? "another function"}\`, which is not this start's function and is not a teardown placement, so nothing here settles this start`
							: `\`${receiver.text()}.close()\` runs, but its promise is never awaited, so the handle can outlive the case`
						: `no \`close\` call reaches \`${receiver.text()}\``;
		findings.push({
			file,
			server: receiver.text(),
			line,
			verdict,
			mechanism,
			text,
			reason,
		});
	}

	// Fail closed on a construction the detector never attributed to a start:
	// `new WebSocketServer({ port })` binds without a `.listen` call, and a
	// factory the binding scan misread must report rather than pass.
	for (const construction of constructions) {
		if (covered.has(rangeKey(construction))) continue;
		const line = construction.range().start.line + 1;
		findings.push({
			file,
			server: constructionName(construction),
			line,
			verdict: "unresolvable",
			mechanism: "none",
			text: lines[line - 1]?.trim() ?? "",
			reason:
				"a server construction with no resolvable start: either it never calls `.listen` here (a port the detector cannot see) or the binding is not readable, so it needs an admission",
		});
	}

	return findings;
}

/** One row's identity: the file and the started binding. Never a line. */
export function serverTeardownKey(finding: ServerTeardownFinding): string {
	return `${finding.file}:${finding.server}`;
}

/** Escapes a row key so a computed construction name cannot break the guard. */
export function escapeRowKey(key: string): string {
	return key.replace(/%/g, "%25").replace(/\s+/g, "%20");
}

/**
 * The close-evidence mechanisms a classification recorded for the named
 * servers. The admissions guard requires the admitted mechanism to be one of
 * these, so a row cannot claim `teardown` for a close that only appears in a
 * `helper`.
 *
 * The caller passes the classification it already holds rather than the source
 * (#5508): the mechanisms are the `mechanism` the classifier recorded on these
 * very findings, so re-running {@link findUnclosedServerStarts} over the source
 * here classified the same file a second time per admission row, which is what
 * made the guard's re-check a multi-second test. Passing the classification
 * keeps the derivation inside this module — the guard does not read
 * `finding.mechanism` beside it — and leaves one classifier run per file.
 */
export function serverTeardownMechanisms(
	classification: readonly ServerTeardownFinding[],
	servers: Iterable<string>,
): ServerTeardownMechanism[] {
	const wanted = new Set(servers);
	const mechanisms = new Set<ServerTeardownMechanism>();
	for (const finding of classification) {
		if (wanted.has(finding.server)) mechanisms.add(finding.mechanism);
	}
	return [...mechanisms].sort();
}
