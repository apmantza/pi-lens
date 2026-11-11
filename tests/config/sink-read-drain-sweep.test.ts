/**
 * Governance: a test never reads a log sink before draining it (#4381).
 *
 * Every pi-lens log sink is a `createNdjsonLogger` writer: `log`/`append` only
 * ENQUEUE, and the queue drains through `fs.promises.appendFile`
 * (`clients/ndjson-logger.ts`). A test that takes a byte offset or a line
 * count of the sink file while one of its own writes is still queued counts
 * those late bytes on the wrong side of its window. #4381 is the third time:
 * `config-resolved-phase.test.ts` loaded config (two sessionstart lines
 * enqueued), then took `statSync(SESSIONSTART_LOG_FILE).size` with no
 * `flushSessionStartLog()`, and master run 38515888889 read "expected 0
 * lines, got 2". Earlier members of the class: #3682 (PR #3720), #3721 (PR
 * #3892), #3193. AGENTS.md "Data directories and logs" states the rule
 * ("Flush the specific logger before reading its file"); this sweep makes it
 * a check.
 *
 * The rule, per read: every `stat` / `statSync` / `lstat` / `lstatSync` /
 * `open` / `openSync` / `readFileSync` / `readFile` / `createReadStream` call
 * in `tests/**` whose first argument names an in-process sink needs a drain
 * OF THAT SINK before it, with no other `await` on the read's own scope's
 * straight-line path between the drain and the read (an await lets the code
 * under test enqueue more). A drain is the sink module's own `flush*` export
 * (awaited, or a `*Sync` variant), `flushAllNdjsonWriters()`, or an awaited
 * call to a local helper whose body ends drained. A drain counts only where it
 * DOMINATES the read: it must run
 * unconditionally in a block that encloses the read and lies inside the
 * read's scope. A drain under an `if`, a ternary, a `&&`/`||`/`??` operand, a
 * loop, a `catch`, or an inner function does not count; one in a `try` body
 * with no `catch` does (a throw before it skips the read). The scope is the
 * nearest enclosing function that is a declaration, a method, or a test/hook
 * callback; inline callbacks (`.map(...)`, `withHome(() => ...)`) are
 * transparent. A read inside a local helper with no drain of its own is
 * drained when every call site of the helper is — but only while the helper
 * runs to the read without suspending: an `await` ON THE HELPER'S OWN PATH
 * lets the code under test enqueue more bytes after the caller's drain, so the
 * read is judged undrained. An `await` inside a function the helper never
 * calls, in a callback nothing waits on, or under a branch the read is not in
 * runs never (shape 43), so it is no suspension. A read a helper drains
 * itself is credited at the read, whatever its callers do.
 *
 * A sink path that reaches a read through a SAME-FILE helper's parameter is
 * attributed at every parameter position: the parameter's name, a destructured
 * member of it, a local alias of it, and the parameter's own default when the
 * caller omits the argument. The read is judged where it runs (`rowsFor`),
 * and the drain that decides it is the one at the call site that SUPPLIED the
 * sink (shape 58): a caller that passed another path is never blamed for this
 * read.
 *
 * Detectors match code, not prose (#4381 acceptance; principles §2):
 * - The DRAIN needles run over `stripSource` text with strings and comments
 *   blanked, so a comment or string naming `flushSessionStartLog()` cannot
 *   satisfy a read (the self-excuse direction).
 * - The SINK needles are of two kinds. Exported path symbols
 *   (`SESSIONSTART_LOG_FILE`, `getLatencyLogPath()`) and local aliases of
 *   them match blanked text. Basename literals (`"latency.log"`) are string
 *   evidence by nature, so that one needle reads the comment-blanked,
 *   string-kept text, and counts only when the same expression names an
 *   in-process log root (`LOG_ROOT_SYMBOLS`): a comment naming a sink file
 *   creates no requirement, and a child process's `path.join(childHome,
 *   "latency.log")` is not an in-process sink.
 *
 * Both populations are DERIVED, not listed: the sink modules are every
 * `clients/` file that calls `createNdjsonLogger(` in code, and their path
 * symbols, flush exports, and basenames are read from those modules. A new
 * sink joins the sweep without an edit here (AGENTS.md shape 34).
 *
 * Known limits, named (all false negatives):
 * - A read whose path reaches the sink through a value computed in another
 *   module, or a directory a `vi.doMock` redirected
 *   (`tests/clients/lsp/launch.test.ts`), is invisible. A SAME-FILE helper
 *   whose path parameter is read is attributed to its call sites' arguments
 *   (see below), so `rows(getLatencyLogPath())` is a sink read of the caller's
 *   drain order.
 * - A parameter passed THROUGH a second helper (`outer(file)` calls
 *   `inner(file)`) is not followed: the inner read has no call site naming the
 *   sink. The parameter rule is one hop wide, and the read's own helper must
 *   be the one declared in this file.
 * - Path shapes the needles do not see: a shell read (`wc -l ${file}`), a
 *   template or concatenated path (`${dir}/latency.log`, `dir +
 *   "/latency.log"`), a basename held in a variable, a root held in any
 *   variable that is not an alias of `LOG_ROOT_SYMBOLS`, and
 *   `fstatSync(fd)` on a descriptor opened elsewhere.
 * - A helper parameter the file only *conditionally* passes a sink to
 *   (`rows(flag ? getLatencyLogPath() : other)`): the argument expression names
 *   the sink, so the call site is judged like any other read — the direction
 *   is a loud false positive, never a silent pass.
 * - Sinks with no path evidence. `clients/diagnostic-logger.ts` exports no
 *   path symbol, no `flush*`, and builds a dated file name, so no read of it
 *   can match: it is pinned in `BLIND_SINKS`, and a new blind sink reds the
 *   "every blind sink is named" case. Seven sinks are basename-only with no
 *   flush export (actionable-warnings, ast-grep-tools, bus-events, cascade,
 *   dead-code, dispositions, word-index): a read is seen only through a
 *   quoted basename under a recognised root, and only `flushAllNdjsonWriters`
 *   drains them.
 * - A synchronous write between the drain and the read is not modelled. It
 *   cannot flake: its append needs a loop turn, so the read never sees it
 *   and a test that depends on it reds every run.
 * - A reader helper passed by reference (not called) has no call sites to
 *   check, so it is judged on its own body.
 * - A same-file alias of a read callee (`const read = fs.readFileSync;
 *   read(sink)`, `import { readFileSync as read }`) is a read: the alias is
 *   read from its own binding, so a named spelling of the call is not a
 *   silent pass (shape 69). A declarator, function name or parameter is
 *   visible only in the SCOPE that declares it — `var`'s enclosing function,
 *   `let`/`const`'s enclosing block, the program for both — and an inner
 *   declaration of the same name shadows an outer alias (R3, F1, shape 69).
 *   Three limits stay, all pre-existing: an IMPORT alias has one module scope
 *   and is matched before any declarator, so a local `function read` of the
 *   same name does NOT shadow it (loud false positive only); a name that only
 *   an ASSIGNMENT reaches (`var read; read = fs.readFileSync`) is not an
 *   alias at all (silent), while the reverse spelling (`const read =
 *   fs.readFileSync; read = (file) => file`) keeps the alias (loud); and a
 *   DESTRUCTURED alias (`const { readFileSync: read } = fs`) binds no name,
 *   because the walk records only identifier declarators (silent).
 * - Suspension is judged FAIL-CLOSED (shape 69). An `await` that can run
 *   between the drain and the read lets the code under test enqueue more
 *   bytes, so it suspends the read wherever it sits: a loop body (a loop
 *   runs when it is iterated), a `finally` (it runs however its `try`
 *   exits), a nested function that also holds the read, an awaited
 *   callback's body, and any spelling the walk cannot place. Only a PROVEN
 *   unreachable await is skipped: one under an `if`/ternary/short-circuit
 *   whose branch does not hold the read, one in a `switch` case, default or
 *   `catch` block the read is not in (those kinds stay skipped; a `case`
 *   that falls through into the read's own case is not proven either way,
 *   and a throw after the drain can take a `catch` whose await then runs
 *   first), one in a function this file never calls, and one in a callback
 *   nothing awaits (`setTimeout`, `forEach`).
 *   A read after `if (flag) await tick();` is judged clean (the conditional
 *   rule, shape 43; the alternative reds every correct ordered read behind
 *   an optional setup step).
 * - Drain forms the matcher does not credit (loud false positives, not
 *   silent passes): `Promise.all([flush...()])`, a dynamic-import flush, and
 *   two drains in sequence before a read of the first sink (the second's
 *   await voids the first). `flushAllNdjsonWriters()` serves all three.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";

import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import {
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLIENTS_ROOT = path.join(REPO_ROOT, "clients");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const SELF = "tests/config/sink-read-drain-sweep.test.ts";

/** One in-process sink module and the evidence a test can name it by. */
interface SinkModule {
	module: string;
	/** Exported path constants/getters, e.g. `SESSIONSTART_LOG_FILE`. */
	pathSymbols: string[];
	/** Exported drains, e.g. `flushSessionStartLog`. */
	flushSymbols: string[];
	/** File basenames the module writes, e.g. `sessionstart.log`. */
	basenames: string[];
}

/** Drains every registered writer at once (`clients/ndjson-logger.ts`). */
const GLOBAL_DRAINS = ["flushAllNdjsonWriters"];

/**
 * The in-process log roots. A basename literal names an in-process sink only
 * when its path expression also names one of these (directly or through a
 * local alias); `path.join(childHome, "latency.log")` names a child process's
 * file, which no in-process flush can drain. Pinned against drift by the
 * "every sink module roots its path in LOG_ROOT_SYMBOLS" case below.
 */
/**
 * Sink modules with no path evidence at all: no exported path symbol and no
 * basename literal, so the sweep can match no read of them. Each is named
 * with its reason; the "every blind sink is named" case reds on a new one.
 */
const BLIND_SINKS: Record<string, string> = {
	"clients/diagnostic-logger.ts":
		"dated file name (logs/<date>.jsonl) and an instance `.flush()`; its one reader, tests/index-3190-inline-blocker-deleted-path-witness.test.ts, drains by hand",
};

const LOG_ROOT_SYMBOLS = [
	"getGlobalPiLensLogDir",
	"getGlobalPiLensDir",
	"PI_LENS_HOME",
];

const EXPORTED_NAME =
	/\bexport\s+(?:async\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/g;
const PATH_SYMBOL = /(?:_FILE|_PATH)$|^get\w*Path$/;
const FLUSH_SYMBOL = /^flush\w*$/;
const BASENAME_LITERAL = /["'`]([\w-][\w.-]*\.(?:log|jsonl))["'`]/g;

function sinkModuleFromSource(
	module: string,
	source: string,
): SinkModule | undefined {
	const blanked = stripSource(source);
	if (!/\bcreateNdjsonLogger\s*\(/.test(blanked)) return undefined;
	// The factory's own module defines it; it is not a sink.
	if (/\bfunction\s+createNdjsonLogger\b/.test(blanked)) return undefined;
	const exported = [...blanked.matchAll(EXPORTED_NAME)].map((m) => m[1]);
	const kept = stripSource(source, { strings: "keep" });
	return {
		module,
		pathSymbols: exported.filter((name) => PATH_SYMBOL.test(name)),
		flushSymbols: exported.filter((name) => FLUSH_SYMBOL.test(name)),
		basenames: [
			...new Set([...kept.matchAll(BASENAME_LITERAL)].map((m) => m[1])),
		],
	};
}

function discoverSinkModules(): Array<SinkModule & { source: string }> {
	const sinks: Array<SinkModule & { source: string }> = [];
	for (const absolute of listSourceFiles(CLIENTS_ROOT, {
		extensions: [".ts"],
		skipTests: true,
	})) {
		const source = fs.readFileSync(absolute, "utf8");
		const sink = sinkModuleFromSource(
			relativePosix(REPO_ROOT, absolute),
			source,
		);
		if (sink) sinks.push({ ...sink, source });
	}
	return sinks;
}

/** One sink read with no drain of its sink before it. */
interface UndrainedRead {
	line: number;
	callee: string;
	sinks: string[];
	text: string;
	/** Lines of the undrained call sites, when the read sits in a local helper. */
	undrainedCallers: number[];
}

// `open`/`openSync` count because `fstatSync(fd).size` carries no path: the
// open of the sink is where its offset is taken.
const READ_CALLEES = new Set([
	"stat",
	"statSync",
	"lstat",
	"lstatSync",
	"open",
	"openSync",
	"readFileSync",
	"readFile",
	"createReadStream",
]);
const SCOPE_CALLEES = new Set([
	"it",
	"test",
	"describe",
	"beforeEach",
	"afterEach",
	"beforeAll",
	"afterAll",
]);
const FUNCTION_KINDS = [
	"arrow_function",
	"function_expression",
	"function_declaration",
	"generator_function_declaration",
	"method_definition",
];
const CALLER_DEPTH = 3;

function calleeName(call: SgNode): string | undefined {
	const fn = call.field("function");
	if (fn?.kind() === "identifier") return fn.text();
	if (fn?.kind() === "member_expression") {
		const object = fn.field("object");
		// `it.each(...)`, `it.skipIf(...)`: the scope callee is the object.
		const objectName = object?.kind() === "identifier" ? object.text() : "";
		if (SCOPE_CALLEES.has(objectName)) return objectName;
		return fn.field("property")?.text();
	}
	if (fn?.kind() === "call_expression") return calleeName(fn);
	return undefined;
}

function isFunction(node: SgNode): boolean {
	return FUNCTION_KINDS.includes(String(node.kind()));
}

/**
 * The nearest enclosing function that owns a drain-ordering scope: a
 * declaration, a method, or a test/hook callback. A callback passed to any
 * other call (`.map`, `waitFor`, `withHome`) runs inside its caller's
 * ordering, so it is transparent.
 */
function scopeOf(node: SgNode): SgNode | undefined {
	let current = node.parent();
	while (current) {
		if (isFunction(current)) {
			const parent = current.parent();
			const call = parent?.kind() === "arguments" ? parent.parent() : null;
			const transparent =
				call?.kind() === "call_expression" &&
				!SCOPE_CALLEES.has(calleeName(call) ?? "");
			if (!transparent) return current;
		}
		current = current.parent();
	}
	return undefined;
}

/** The nearest enclosing function of any kind: a binding's lexical scope. */
function lexicalScopeOf(node: SgNode): SgNode | undefined {
	let current = node.parent();
	while (current && !isFunction(current)) current = current.parent();
	return current ?? undefined;
}

/**
 * A node that scopes a `let`/`const` binding: a block, or the program. A
 * function body is a block, so a body-level declaration stops there.
 */
function isBlockScope(node: SgNode): boolean {
	const kind = String(node.kind());
	return kind === "statement_block" || kind === "program";
}

/** The name a function is called by, when it is a local helper. */
function declaredName(fn: SgNode): string | undefined {
	if (fn.kind() !== "arrow_function" && fn.kind() !== "function_expression") {
		return fn.field("name")?.text();
	}
	const parent = fn.parent();
	if (parent?.kind() !== "variable_declarator") return undefined;
	const name = parent.field("name");
	return name?.kind() === "identifier" ? name.text() : undefined;
}

/**
 * Kinds a drain may not sit under on its way up to its block: under any of
 * them it runs conditionally, late, or never (state table D3, D4, D5).
 */
const CONDITIONAL_KINDS = new Set([
	...FUNCTION_KINDS,
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
	"finally_clause",
]);
const SHORT_CIRCUIT = /^(?:&&|\|\||\?\?)$/;

/** A call that can drain: awaited, or a `*Sync` call that needs no await. */
interface DrainCall {
	name: string;
	/** The block it runs in unconditionally, or undefined (see drainBlock). */
	block: SgNode | undefined;
	end: number;
}

/** Every awaited or `*Sync` call in `calls`, with its name and drain block. */
function drainCalls(calls: readonly SgNode[]): DrainCall[] {
	const out: DrainCall[] = [];
	for (const call of calls) {
		const fn = call.field("function");
		const name =
			fn?.kind() === "identifier"
				? fn.text()
				: fn?.kind() === "member_expression"
					? fn.field("property")?.text()
					: undefined;
		if (!name) continue;
		if (!name.endsWith("Sync") && call.parent()?.kind() !== "await_expression")
			continue;
		out.push({ name, block: drainBlock(call), end: call.range().end.index });
	}
	return out;
}

/**
 * The block a drain call runs in unconditionally: the nearest enclosing
 * `statement_block` (or the program), reached without passing a condition, a
 * loop, a short-circuit operand, or a function boundary. `undefined` when
 * the drain is conditional or nested (state table D3, D4).
 */
function drainBlock(call: SgNode): SgNode | undefined {
	let node = call;
	for (;;) {
		const parent = node.parent();
		if (!parent) return undefined;
		const kind = String(parent.kind());
		// A `try` body with no `catch` dominates the code after the try: if it
		// throws before the drain, the finally rethrows and the read never runs
		// (D7). A `catch` can swallow that throw, so its body does not (D8).
		const owner = parent.parent();
		if (
			kind === "statement_block" &&
			owner?.kind() === "try_statement" &&
			owner.field("body")?.range().start.index === parent.range().start.index &&
			!owner.field("handler")
		) {
			node = owner;
			continue;
		}
		if (kind === "statement_block" || kind === "program") return parent;
		if (CONDITIONAL_KINDS.has(kind)) return undefined;
		if (
			kind === "binary_expression" &&
			SHORT_CIRCUIT.test(parent.field("operator")?.text() ?? "")
		)
			return undefined;
		node = parent;
	}
}

const within = (inner: SgNode, outer: SgNode): boolean =>
	outer.range().start.index <= inner.range().start.index &&
	inner.range().end.index <= outer.range().end.index;

const sameRange = (left: SgNode, right: SgNode): boolean =>
	left.range().start.index === right.range().start.index &&
	left.range().end.index === right.range().end.index;

/**
 * Kinds above an `await` or a drain under which it may never run, so it cannot
 * suspend a read the same guard does not hold (the conditional rule, shape
 * 43). A loop body runs when the loop is iterated and a `finally` runs however
 * its `try` exits, so neither is here (E1, shape 69). `drainBlock` keeps them
 * in `CONDITIONAL_KINDS`, because for a DRAIN they decide whether it ran at
 * all. A `switch_case` that falls through into the read's case and a `catch`
 * that swallows a throw from after the drain are NOT proven unreachable; both
 * are skipped today, and the module docstring names that residue.
 */
const MAY_NOT_RUN_KINDS = new Set([
	"if_statement",
	"else_clause",
	"ternary_expression",
	"switch_case",
	"switch_default",
	"catch_clause",
]);

/** The read callee a value names: `fs.readFileSync`, `fs["readFileSync"]`. */
function readCalleeOf(node: SgNode): string | undefined {
	if (node.kind() === "member_expression") {
		const name = node.field("property")?.text();
		return name && READ_CALLEES.has(name) ? name : undefined;
	}
	if (node.kind() === "subscript_expression") {
		const index = node.field("index");
		if (index?.kind() !== "string") return undefined;
		const name = index.text().slice(1, -1);
		return READ_CALLEES.has(name) ? name : undefined;
	}
	return undefined;
}

/**
 * Does every branch above `node` also enclose `pair`? An `await` under a guard
 * the read is not in may never run, so it cannot let bytes onto disk, and must
 * not void the caller's drain (N1, shape 43).
 */
function guardedAlike(node: SgNode, pair: SgNode): boolean {
	let current = node;
	for (;;) {
		const parent = current.parent();
		if (!parent || isFunction(parent)) return true;
		const kind = String(parent.kind());
		if (kind === "binary_expression") {
			if (
				SHORT_CIRCUIT.test(parent.field("operator")?.text() ?? "") &&
				!within(pair, parent)
			)
				return false;
		} else if (kind === "if_statement" || kind === "ternary_expression") {
			const condition = parent.field("condition");
			const isCondition = condition != null && sameRange(current, condition);
			if (!isCondition && !within(pair, parent)) return false;
		} else if (MAY_NOT_RUN_KINDS.has(kind) && !within(pair, parent))
			return false;
		current = parent;
	}
}

const nameNeedleOf = (name: string, member: boolean): RegExp =>
	new RegExp(`${member ? "\\b" : "(?<![\\w$.])"}${escapeRegExp(name)}\\b`);

const nameNeedle = nameNeedleOf;

interface Binding {
	name: string;
	start: number;
	end: number;
	owners: ReadonlySet<string>;
}

function scanUndrainedSinkReads(
	source: string,
	sinks: readonly SinkModule[],
): UndrainedRead[] {
	const blanked = stripSource(source);
	const kept = stripSource(source, { strings: "keep" });
	const symbolOwner = new Map<string, string>();
	const basenameOwner = new Map<string, string>();
	for (const sink of sinks) {
		for (const symbol of sink.pathSymbols) symbolOwner.set(symbol, sink.module);
		for (const base of sink.basenames) basenameOwner.set(base, sink.module);
	}
	// Needles are pure in their arguments; build each once per scan, not once
	// per `sinksIn` call.
	const literalNeedles = new Map<string, RegExp>();
	const literalNeedle = (base: string): RegExp => {
		let needle = literalNeedles.get(base);
		if (!needle) {
			needle = new RegExp(`["'\`]${escapeRegExp(base)}["'\`]`);
			literalNeedles.set(base, needle);
		}
		return needle;
	};
	const nameNeedles = new Map<string, RegExp>();
	const nameNeedle = (name: string, member: boolean): RegExp => {
		const key = `${member ? "m" : "b"}${name}`;
		let needle = nameNeedles.get(key);
		if (!needle) {
			needle = nameNeedleOf(name, member);
			nameNeedles.set(key, needle);
		}
		return needle;
	};
	// Cheap admission on code text: no sink named, nothing to parse.
	if (
		![...symbolOwner.keys()].some((s) => nameNeedle(s, true).test(blanked)) &&
		![...basenameOwner.keys()].some((b) => literalNeedle(b).test(kept))
	) {
		return [];
	}

	const root = parse(Lang.TypeScript, source).root();
	// Read callees this file binds: `import { readFileSync as read }` and
	// `const read = fs.readFileSync`. A named spelling of a read is the same read
	// (shape 69). An IMPORT has one module scope and is matched before any
	// declarator, so an inner declaration does not shadow it; a declarator,
	// function name or parameter is visible only in the scope that declares it,
	// and an inner declaration of the same name SHADOWS an outer alias, so
	// another test's `const read = (file) => file` helper is not a sink read
	// (R3, F1). A destructured declarator (`const { readFileSync: read } = fs`)
	// binds no name: the walk records identifier declarators only.
	const importReadAliases = new Set<string>(READ_CALLEES);
	for (const specifier of root.findAll({
		rule: { kind: "import_specifier" },
	})) {
		const imported = specifier.field("name")?.text();
		const local = specifier.field("alias")?.text() ?? imported;
		if (imported && local && READ_CALLEES.has(imported))
			importReadAliases.add(local);
	}
	interface ReadAliasDecl {
		name: string;
		/** The declaration's own position; `at` is what decides before a read. */
		declaredAt: number;
		/** The scope the name binds in; see `bindingScopeSpan`. */
		scopeStart: number;
		scopeEnd: number;
		/** A `function` declaration binds at scope entry, before any read. */
		hoisted: boolean;
		read: boolean;
	}
	// Indexed by name: `readAliasAt` is asked about every call's callee, and
	// almost none of those names is declared at all. Insertion order inside a
	// name is the declaration order the unindexed array had.
	const readAliasDecls = new Map<string, ReadAliasDecl[]>();
	const addReadAliasDecl = (decl: ReadAliasDecl): void => {
		const known = readAliasDecls.get(decl.name);
		if (known) known.push(decl);
		else readAliasDecls.set(decl.name, [decl]);
	};
	const rootRange = root.range();
	const spanOf = (
		node: SgNode | null | undefined,
	): { start: number; end: number } => {
		const range = node?.range() ?? rootRange;
		return { start: range.start.index, end: range.end.index };
	};
	/** A span under the field names a declaration record carries. */
	const scopeFields = (span: { start: number; end: number }) => ({
		scopeStart: span.start,
		scopeEnd: span.end,
	});
	/**
	 * The SCOPE a declarator binds in: `var` hoists to the enclosing function,
	 * `let`/`const` bind in the nearest enclosing block, and the program binds
	 * what nothing closer declares. The scope decides a shadowed name, never a
	 * document-order tie: every declarator in one function used to share that
	 * function's span, so an inner block's read alias lost to an earlier non-read
	 * declaration of the same name and a real sink read read clean (F1, shape 69).
	 */
	const bindingScopeSpan = (
		declarator: SgNode,
	): { start: number; end: number } => {
		const varScoped = declarator.parent()?.kind() === "variable_declaration";
		let current = declarator.parent();
		while (
			current &&
			!(varScoped ? isFunction(current) : isBlockScope(current))
		) {
			current = current.parent();
		}
		return spanOf(current);
	};
	/**
	 * The declaration that decides `name` at `at`: in the innermost enclosing
	 * scope that declares it, the nearest declaration IN FORCE at the read. Two
	 * questions decide, and they are different: the scope (a block or a
	 * function, see `bindingScopeSpan`) says whether the name is in force at
	 * all, and the execution path to the read says which of two same-named
	 * declarations it is. A declaration in a block the read is not inside is a
	 * sibling's name. Lexical position decides only on the declaring scope's own
	 * straight line, where a declaration below the read has not run yet
	 * (Greptile r6: a later `var read = helper` used to hide an earlier read).
	 * A read inside a NESTED function runs when that function is called, which
	 * is after the enclosing scope initialized, so position does not disqualify
	 * a declaration there (Greptile r6 P1: a helper read went silent). A
	 * `function` declaration is installed at scope entry, so it is the binding's
	 * STARTING value: it decides the read only when nothing else wrote before it,
	 * because an earlier initializer overwrites it at that initializer's own
	 * position (Greptile r7 P1: a `var` alias before the read was hidden).
	 */
	const readAliasAt = (name: string, at: SgNode): ReadAliasDecl | undefined => {
		const named = readAliasDecls.get(name);
		if (named === undefined) return undefined;
		const position = at.range().start.index;
		let crossedFunction = false;
		for (let current = at.parent(); current; current = current.parent()) {
			const span = spanOf(current);
			const here = named.filter(
				(decl) =>
					decl.scopeStart === span.start &&
					decl.scopeEnd === span.end &&
					(crossedFunction || decl.hoisted || decl.declaredAt <= position),
			);
			if (here.length > 0) {
				const written = here.filter((decl) => !decl.hoisted);
				const pool = written.length > 0 ? written : here;
				return pool.reduce((a, b) => (b.declaredAt >= a.declaredAt ? b : a));
			}
			if (isFunction(current)) crossedFunction = true;
		}
		return undefined;
	};
	const isReadCallee = (name: string, at: SgNode): boolean =>
		importReadAliases.has(name) || (readAliasAt(name, at)?.read ?? false);
	for (const declarator of root.findAll({
		rule: { kind: "variable_declarator" },
	})) {
		const name = declarator.field("name");
		const value = declarator.field("value") ?? undefined;
		if (name?.kind() !== "identifier") continue;
		const callee =
			value === undefined
				? undefined
				: value.kind() === "identifier"
					? isReadCallee(value.text(), value)
						? value.text()
						: undefined
					: readCalleeOf(value);
		addReadAliasDecl({
			name: name.text(),
			declaredAt: declarator.range().start.index,
			...scopeFields(bindingScopeSpan(declarator)),
			hoisted: false,
			read: callee !== undefined,
		});
	}
	// A same-named function or parameter hides an outer read alias.
	for (const fn of root.findAll({
		rule: {
			any: [
				{ kind: "function_declaration" },
				{ kind: "function_expression" },
				{ kind: "arrow_function" },
				{ kind: "method_definition" },
			],
		},
	})) {
		const name = fn.field("name");
		if (name?.kind() === "identifier")
			addReadAliasDecl({
				name: name.text(),
				declaredAt: fn.range().start.index,
				...scopeFields(spanOf(lexicalScopeOf(fn))),
				hoisted: fn.kind() === "function_declaration",
				read: false,
			});
		for (const parameter of fn.field("parameters")?.namedChildren() ?? []) {
			const pattern = parameter.field("pattern") ?? parameter;
			if (pattern.kind() !== "identifier") continue;
			addReadAliasDecl({
				name: pattern.text(),
				declaredAt: parameter.range().start.index,
				...scopeFields(spanOf(lexicalScopeOf(parameter))),
				hoisted: false,
				read: false,
			});
		}
	}
	const sinkAliases: Binding[] = [];
	const rootAliases: Binding[] = [];
	const visible = (
		bindings: Binding[],
		start: number,
		end: number,
	): Binding[] =>
		bindings.filter(
			(b) =>
				b.start <= start &&
				end <= b.end &&
				nameNeedle(b.name, false).test(blanked.slice(start, end)),
		);
	const namesRoot = (start: number, end: number): boolean =>
		LOG_ROOT_SYMBOLS.some((s) =>
			nameNeedle(s, true).test(blanked.slice(start, end)),
		) || visible(rootAliases, start, end).length > 0;
	const sinksIn = (start: number, end: number): Set<string> => {
		const owners = new Set<string>();
		const code = blanked.slice(start, end);
		for (const [symbol, owner] of symbolOwner) {
			if (nameNeedle(symbol, true).test(code)) owners.add(owner);
		}
		for (const alias of visible(sinkAliases, start, end)) {
			for (const owner of alias.owners) owners.add(owner);
		}
		const literal = kept.slice(start, end);
		for (const [base, owner] of basenameOwner) {
			if (literalNeedle(base).test(literal) && namesRoot(start, end)) {
				owners.add(owner);
			}
		}
		return owners;
	};
	const readsInside = (node: SgNode): boolean =>
		node
			.findAll({ rule: { kind: "call_expression" } })
			.some((call) => READ_CALLEES.has(calleeName(call) ?? ""));
	const bind = (
		into: Binding[],
		name: string,
		at: SgNode,
		owners: ReadonlySet<string>,
	): void => {
		const scope = lexicalScopeOf(at);
		const start = scope?.range().start.index ?? 0;
		const end = scope?.range().end.index ?? source.length;
		if (!into.some((b) => b.name === name && b.start === start)) {
			into.push({ name, start, end, owners });
		}
	};

	// Path aliases, lexically scoped: `const file = getLatencyLogPath()`,
	// `const dir = getGlobalPiLensLogDir()`, `const logFile = () =>
	// path.join(dir, "latency.log")`, `function logPath() { return ...; }`.
	const declarators = root.findAll({ rule: { kind: "variable_declarator" } });
	const functionDecls = root.findAll({
		rule: { kind: "function_declaration" },
	});
	// What the three passes ask of each declarator and function never changes
	// between passes (only the alias tables grow), so read it from the tree
	// once: the name, the value's span, and the non-reading returns' spans.
	const aliasCandidates: Array<{
		decl: SgNode;
		name: string;
		start: number;
		end: number;
	}> = [];
	for (const decl of declarators) {
		const name = decl.field("name");
		const value = decl.field("value");
		if (name?.kind() !== "identifier" || !value || readsInside(value)) continue;
		const range = value.range();
		aliasCandidates.push({
			decl,
			name: name.text(),
			start: range.start.index,
			end: range.end.index,
		});
	}
	const functionCandidates: Array<{
		fn: SgNode;
		name: string;
		returns: Array<{ start: number; end: number }>;
	}> = [];
	for (const fn of functionDecls) {
		const name = fn.field("name")?.text();
		if (!name) continue;
		const returns: Array<{ start: number; end: number }> = [];
		for (const ret of fn.findAll({ rule: { kind: "return_statement" } })) {
			if (readsInside(ret)) continue;
			const range = ret.range();
			returns.push({ start: range.start.index, end: range.end.index });
		}
		functionCandidates.push({ fn, name, returns });
	}
	for (let pass = 0; pass < 3; pass++) {
		for (const { decl, name, start, end } of aliasCandidates) {
			const owners = sinksIn(start, end);
			if (owners.size > 0) bind(sinkAliases, name, decl, owners);
			else if (namesRoot(start, end)) bind(rootAliases, name, decl, new Set());
		}
		for (const { fn, name, returns } of functionCandidates) {
			const owners = new Set<string>();
			for (const ret of returns) {
				for (const owner of sinksIn(ret.start, ret.end)) {
					owners.add(owner);
				}
			}
			if (owners.size > 0) bind(sinkAliases, name, fn, owners);
		}
	}

	// Drains per sink: its flush exports, the global drain, and every local
	// helper whose body ends drained (`await configResolvedRows()`): a drain
	// that is a direct statement of the helper's body, with no await after it
	// (state table D11, D12).
	const drainNames = new Map<string, string[]>();
	for (const sink of sinks) {
		drainNames.set(sink.module, [...sink.flushSymbols, ...GLOBAL_DRAINS]);
	}
	const calls = root.findAll({ rule: { kind: "call_expression" } });
	const awaits = root.findAll({ rule: { kind: "await_expression" } });
	const drains = drainCalls(calls);
	const bodies: Array<{ name: string; start: number; end: number }> = [];
	for (const fn of root.findAll({
		rule: { any: FUNCTION_KINDS.map((kind) => ({ kind })) },
	})) {
		const name = declaredName(fn);
		const body = fn.field("body");
		if (!name || body?.kind() !== "statement_block") continue;
		bodies.push({
			name,
			start: body.range().start.index,
			end: body.range().end.index,
		});
	}
	for (let pass = 0; pass < 3; pass++) {
		for (const body of bodies) {
			for (const names of drainNames.values()) {
				if (names.includes(body.name)) continue;
				const last = drains
					.filter(
						(drain) =>
							names.includes(drain.name) &&
							drain.block?.range().start.index === body.start,
					)
					.at(-1);
				if (!last) continue;
				const after = blanked.slice(last.end, body.end);
				if (!/\bawait\b/.test(after)) names.push(body.name);
			}
		}
	}

	const callsTo = (name: string, inside: SgNode): SgNode[] => {
		const start = inside.range().start.index;
		const end = inside.range().end.index;
		return calls.filter((call) => {
			const fn = call.field("function");
			const at = call.range().start.index;
			return (
				fn?.kind() === "identifier" &&
				fn.text() === name &&
				!(start <= at && at < end)
			);
		});
	};

	/**
	 * Drained at `node` for `owner`: the last credited drain of that sink
	 * precedes it with no other await in between (any await lets the code
	 * under test enqueue more). A drain is credited when the block it runs in
	 * unconditionally encloses `node` and lies inside `node`'s scope (state
	 * table D1, D2). With no credited drain, a local helper is drained when
	 * every call site it reads the sink at is (D13); `suppliers` narrows that
	 * to the call sites that passed a sink for a parameter read (N2).
	 */
	const undrainedAt = (
		node: SgNode,
		owner: string,
		depth: number,
		suppliers?: readonly SgNode[],
	): number[] => {
		const scope = scopeOf(node);
		const names = drainNames.get(owner) ?? GLOBAL_DRAINS;
		const line = node.range().start.line + 1;
		const at = node.range().start.index;
		const last = drains
			.filter(
				({ name, block, end }) =>
					end <= at &&
					names.includes(name) &&
					block !== undefined &&
					within(node, block) &&
					(scope === undefined || within(block, scope)),
			)
			.at(-1);
		if (last) return suspendsBetween(scope, node, last.end) ? [line] : [];
		const helper = scope ? declaredName(scope) : undefined;
		const sites = suppliers ?? (scope && helper ? callsTo(helper, scope) : []);
		if (!scope || depth >= CALLER_DEPTH || sites.length === 0) return [line];
		// A caller's drain dominates the read only while the helper runs to the
		// read without suspending (shape 67).
		if (suspendsBefore(scope, node)) return [line];
		return sites.flatMap((site) => undrainedAt(site, owner, depth + 1));
	};

	/**
	 * Does `scope` run an `await` between `from` and `node`? Fail-closed (shape
	 * 69): an await that CAN run lets the code under test enqueue more bytes, so
	 * it voids the drain wherever it sits — a loop body, a `finally`, an awaited
	 * callback's interior (E1, E2). Only a proven-unreachable await and one under
	 * a guard the read is not in are skipped (N1, shape 43).
	 */
	const suspendsBetween = (
		scope: SgNode | undefined,
		node: SgNode,
		from = scope?.range().start.index ?? 0,
	): boolean => {
		if (!scope) return false;
		const at = node.range().start.index;
		return awaits.some((awaitNode) => {
			const start = awaitNode.range().start.index;
			if (start < from || start >= at) return false;
			// The read's own await settles after the read, not before it.
			if (within(node, awaitNode)) return false;
			if (!reachable(awaitNode, node)) return false;
			return guardedAlike(awaitNode, node);
		});
	};

	/**
	 * Can `awaitNode` run before the read at all? A nested function's awaits run
	 * only when something invokes it, so a function this file never calls and a
	 * callback nothing awaits are the two shapes the walk may skip (N1). Every
	 * other placement is treated as running (E1, E2, shape 69).
	 */
	const reachable = (awaitNode: SgNode, node: SgNode): boolean => {
		let current: SgNode = awaitNode;
		for (;;) {
			const parent = current.parent();
			if (!parent) return true;
			// The read inside this function is on the await's own path (E2).
			if (isFunction(parent) && !within(node, parent)) {
				if (!invokedBefore(parent, node)) return false;
			}
			current = parent;
		}
	};

	/**
	 * Does the file run `fn` before `node`? A named helper counts when it has a
	 * call site before the read; a callback counts when the call it is an
	 * argument of is awaited before the read. A callback nothing awaits
	 * (`setTimeout`, `forEach`, a dropped `.map`) never runs before the read, and
	 * neither does a function with no call site.
	 */
	const invokedBefore = (fn: SgNode, node: SgNode): boolean => {
		const at = node.range().start.index;
		const name = declaredName(fn);
		if (name)
			return callsTo(name, fn).some((site) => site.range().start.index < at);
		const parent = fn.parent();
		if (parent?.kind() !== "arguments") return false;
		const call = parent.parent();
		if (call?.kind() !== "call_expression") return false;
		return (
			call.parent()?.kind() === "await_expression" &&
			call.range().start.index < at
		);
	};

	/** Does `scope` suspend (await) between its entry and `node`? */
	const suspendsBefore = (scope: SgNode, node: SgNode): boolean =>
		suspendsBetween(scope, node);

	/** The names a parameter pattern introduces (object, array, alias, default). */
	const patternNames = (node: SgNode | undefined): string[] => {
		if (!node) return [];
		const kind = String(node.kind());
		if (
			kind === "identifier" ||
			kind === "shorthand_property_identifier_pattern"
		)
			return [node.text()];
		if (kind === "required_parameter" || kind === "optional_parameter")
			return patternNames(node.field("pattern") ?? undefined);
		if (
			kind === "object_pattern" ||
			kind === "array_pattern" ||
			kind === "pair_pattern" ||
			kind === "rest_pattern" ||
			kind === "assignment_pattern"
		)
			return node.namedChildren().flatMap((child) => patternNames(child));
		return [];
	};

	/** The default expression a parameter falls back to, if it has one. */
	const defaultValue = (param: SgNode | undefined): SgNode | undefined => {
		if (!param) return undefined;
		const value = param.field("value");
		if (value) return value;
		return String(param.kind()) === "assignment_pattern"
			? param.namedChildren().at(-1)
			: undefined;
	};

	/**
	 * The parameter positions the read's path names: the parameter itself, a
	 * destructured member of it, or a local alias of it. A read of parameter 2
	 * is attributed to argument 2 (F3).
	 */
	const parameterIndices = (fn: SgNode, pathText: string): number[] => {
		const params = fn.field("parameters")?.namedChildren() ?? [];
		const owners = new Map<string, number>();
		params.forEach((param, index) => {
			for (const name of patternNames(param)) owners.set(name, index);
		});
		// Local aliases of a parameter: `const p = f;`.
		const declarators = fn.findAll({ rule: { kind: "variable_declarator" } });
		for (let pass = 0; pass < 3; pass++) {
			for (const decl of declarators) {
				const name = decl.field("name");
				const value = decl.field("value");
				if (name?.kind() !== "identifier" || value?.kind() !== "identifier")
					continue;
				const index = owners.get(value.text());
				if (index !== undefined) owners.set(name.text(), index);
			}
		}
		const indices = new Set<number>();
		for (const [name, index] of owners) {
			if (nameNeedle(name, false).test(pathText)) indices.add(index);
		}
		return [...indices].sort((left, right) => left - right);
	};

	const hits: UndrainedRead[] = [];
	const lines = source.split("\n");
	/**
	 * A read whose path argument is a parameter of a same-file helper: the
	 * sink is named at each call site, so the VALUE decides (#4589 F3). The
	 * parameter may sit inside a `path.join(...)` argument, be destructured,
	 * be aliased, or be omitted in favour of its own default. The read is
	 * judged where it runs; the call site that SUPPLIED the sink is the one
	 * whose drain decides (N2, shape 58), so a caller passing another path is
	 * never blamed for this sink.
	 */
	const parameterReads = (
		call: SgNode,
		first: SgNode,
	): Array<{ owner: string; at: SgNode; site: SgNode }> => {
		const fn = scopeOf(call);
		if (!fn) return [];
		const name = declaredName(fn);
		if (!name) return [];
		const params = fn.field("parameters")?.namedChildren() ?? [];
		const pathText = blanked.slice(
			first.range().start.index,
			first.range().end.index,
		);
		const indices = parameterIndices(fn, pathText);
		if (indices.length === 0) return [];
		const out: Array<{ owner: string; at: SgNode; site: SgNode }> = [];
		const seen = new Set<string>();
		for (const site of callsTo(name, fn)) {
			const args = site.field("arguments")?.namedChildren() ?? [];
			for (const index of indices) {
				// The value read is the positional argument, or the parameter's own
				// default when the caller omits it.
				const value = args[index] ?? defaultValue(params[index]);
				if (!value) continue;
				const range = value.range();
				for (const owner of sinksIn(range.start.index, range.end.index)) {
					const key = `${owner}@${site.range().start.index}`;
					if (seen.has(key)) continue;
					seen.add(key);
					out.push({ owner, at: call, site });
				}
			}
		}
		return out;
	};
	for (const call of calls) {
		const callee = calleeName(call);
		if (!callee || !isReadCallee(callee, call)) continue;
		const first = call.field("arguments")?.namedChildren()[0];
		if (!first) continue;
		const owners = sinksIn(first.range().start.index, first.range().end.index);
		// Sink named at the read, or named by the callers of a helper whose
		// parameter is the path it reads.
		const reads: Array<{ owner: string; at: SgNode; site?: SgNode }> =
			owners.size > 0
				? [...owners].map((owner) => ({ owner, at: call }))
				: parameterReads(call, first);
		const undrained: string[] = [];
		const callers = new Set<number>();
		const line = call.range().start.line + 1;
		for (const { owner, at: readAt, site } of reads) {
			const at = undrainedAt(readAt, owner, 0, site ? [site] : undefined);
			if (at.length === 0) continue;
			undrained.push(owner);
			for (const siteLine of at) if (siteLine !== line) callers.add(siteLine);
		}
		if (undrained.length === 0) continue;
		hits.push({
			line,
			callee,
			sinks: [...new Set(undrained)].sort(),
			text: lines[line - 1]?.trim() ?? "",
			undrainedCallers: [...callers].sort((a, b) => a - b),
		});
	}
	return hits;
}

/** Fixture sinks: the shape of the two real modules #4381 involves. */
const FIXTURE_SINKS: SinkModule[] = [
	{
		module: "clients/sessionstart-logger.ts",
		pathSymbols: ["SESSIONSTART_LOG_FILE"],
		flushSymbols: ["flushSessionStartLog", "flushSessionStartLogSync"],
		basenames: ["sessionstart.log"],
	},
	{
		module: "clients/latency-logger.ts",
		pathSymbols: ["getLatencyLogPath"],
		flushSymbols: ["flushLatencyLog"],
		basenames: ["latency.log"],
	},
];

const scanFixture = (source: string): UndrainedRead[] =>
	scanUndrainedSinkReads(source, FIXTURE_SINKS);

describe("sink reads drain first (#4381)", () => {
	// Recurrence: #4381 (master run 38515888889), after #3682, #3721 and #3193.
	it(
		"no test reads an in-process log sink before draining it",
		() => {
			const sinks = discoverSinkModules();
			// Dead-scan floors (sweep-kit, #1718): the sink discovery and the tree
			// walk each have to find something before an empty result means clean.
			assertNonEmptyScan("ndjson sink modules", sinks.length, 10);
			const files = listSourceFiles(TESTS_ROOT, {
				extensions: [".ts"],
				exclude: (rel) => rel.startsWith("fixtures/"),
			});
			assertNonEmptyScan("tests/ source files", files.length, 1000);
			const violations: string[] = [];
			let sinkFiles = 0;
			for (const absolute of files) {
				const rel = relativePosix(REPO_ROOT, absolute);
				if (rel === SELF) continue;
				const source = readWalkedFile(absolute);
				if (source === undefined) continue;
				if (
					sinks.some((sink) => sink.pathSymbols.some((s) => source.includes(s)))
				)
					sinkFiles += 1;
				for (const hit of scanUndrainedSinkReads(source, sinks)) {
					const callers = hit.undrainedCallers.length
						? ` (undrained call sites: ${hit.undrainedCallers.map((line) => `:${line}`).join(", ")})`
						: "";
					violations.push(
						`${rel}:${hit.line} ${hit.callee} of ${hit.sinks.join(", ")}${callers}: ${hit.text}`,
					);
				}
			}
			assertNonEmptyScan("test files naming a sink path symbol", sinkFiles, 20);
			expect(
				violations,
				"a test reads a log sink while its own writes may still be queued (#4381). " +
					"Await the sink's flush (flushSessionStartLog, flushLatencyLog, ..., or " +
					"flushAllNdjsonWriters) in the same scope right before the read, with no " +
					"other await in between, or inside the helper that reads. " +
					"Promise.all([flush...]), a dynamic-import flush, and sequential drains " +
					"are not recognised; use flushAllNdjsonWriters().",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every sink module roots its path in LOG_ROOT_SYMBOLS (drift pin)",
		() => {
			// A sink that moves to another root would make the basename evidence
			// above silently stop matching its in-process reads.
			const unrooted = discoverSinkModules()
				.filter(
					({ source }) =>
						!LOG_ROOT_SYMBOLS.some((symbol) =>
							nameNeedle(symbol, true).test(stripSource(source)),
						),
				)
				.map(({ module }) => module);
			expect(unrooted).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every blind sink is named (no path symbol, no basename)",
		() => {
			// Recurrence: review r1 of #4384 F1. diagnostic-logger.ts matched
			// nothing, the drift pin above still passed, and its one undrained
			// offset read (index-3190 witness) was in neither sweep table.
			const blind = discoverSinkModules()
				.filter((s) => s.pathSymbols.length === 0 && s.basenames.length === 0)
				.map(({ module }) => module)
				.sort();
			expect(blind).toEqual(Object.keys(BLIND_SINKS).sort());
		},
		TREE_WALK_TIMEOUT_MS,
	);

	describe("sink discovery", () => {
		it("reads path symbols, drains and basenames from a sink module", () => {
			const sink = sinkModuleFromSource(
				"clients/x-logger.ts",
				[
					'const X_LOG_FILE = path.join(getGlobalPiLensLogDir(), "x.log");',
					"const writer = createNdjsonLogger({ filePath: X_LOG_FILE });",
					"export function getXLogPath(): string { return X_LOG_FILE; }",
					"export function flushXLog(): Promise<void> { return writer.flush(); }",
					"export function logX(): void {}",
				].join("\n"),
			);
			expect(sink).toEqual({
				module: "clients/x-logger.ts",
				pathSymbols: ["getXLogPath"],
				flushSymbols: ["flushXLog"],
				basenames: ["x.log"],
			});
		});

		it("a module naming the factory only in a comment or string is no sink", () => {
			expect(
				sinkModuleFromSource(
					"clients/y.ts",
					'// createNdjsonLogger({ filePath })\nconst s = "createNdjsonLogger(";',
				),
			).toBeUndefined();
		});
	});

	describe("detector", () => {
		const offsetHelper = [
			"function sessionStartOffset(): number {",
			"\treturn fs.statSync(SESSIONSTART_LOG_FILE).size;",
			"}",
		].join("\n");

		it("flags the #4381 shape: an offset helper with no drain, called after a write", () => {
			const hits = scanFixture(
				[
					offsetHelper,
					'it("x", async () => {',
					"\tawait loadLSPConfig(dir, home);",
					"\tawait flushLatencyLog();",
					"\tconst offset = sessionStartOffset();",
					"});",
				].join("\n"),
			);
			expect(hits).toEqual([
				{
					line: 2,
					callee: "statSync",
					sinks: ["clients/sessionstart-logger.ts"],
					text: "return fs.statSync(SESSIONSTART_LOG_FILE).size;",
					undrainedCallers: [7],
				},
			]);
		});

		it("accepts the fixed helper: it drains its own sink before the offset", () => {
			expect(
				scanFixture(
					[
						"async function sessionStartOffset(): Promise<number> {",
						"\tawait flushSessionStartLog();",
						"\treturn fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"}",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a drain named only in a comment or a string does not count", () => {
			for (const launder of [
				"\t// await flushSessionStartLog();",
				'\tconst note = "await flushSessionStartLog();";',
				"\tconst note = `await flushSessionStartLog();`;",
			]) {
				const hits = scanFixture(
					[
						'it("x", async () => {',
						launder,
						"\tconst size = fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"});",
					].join("\n"),
				);
				expect(
					hits.map((hit) => hit.line),
					launder,
				).toEqual([3]);
			}
		});

		it("a drain of a different sink does not count", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tconst size = fs.statSync(SESSIONSTART_LOG_FILE).size;",
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.sinks)).toEqual([
				["clients/sessionstart-logger.ts"],
			]);
		});

		it("an await between the drain and the read voids the drain", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tawait new Promise((resolve) => setImmediate(resolve));",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([4]);
		});

		it("accepts a sync Sync-drain, the global drain, and a local draining helper", () => {
			expect(
				scanFixture(
					[
						"async function rows(): Promise<string> {",
						"\tawait flushLatencyLog();",
						'\treturn fs.readFileSync(getLatencyLogPath(), "utf8");',
						"}",
						'it("x", async () => {',
						"\tflushSessionStartLogSync();",
						"\tconst a = fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"\tawait flushAllNdjsonWriters();",
						"\tconst b = fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"\tawait rows();",
						'\tconst c = fs.readFileSync(getLatencyLogPath(), "utf8");',
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a helper that awaits more work after its drain is no drain", () => {
			const hits = scanFixture(
				[
					"async function settle(): Promise<void> {",
					"\tawait flushLatencyLog();",
					"\tawait runTurn();",
					"}",
					'it("x", async () => {',
					"\tawait settle();",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([7]);
		});

		it("a read through a helper parameter is judged at the caller's drain (#4586)", () => {
			// #4586's recurrence (the adoption row existed, and only a real-log
			// read could prove it), one step out: the helper owns the read and the
			// CALLER owns the sink path, so the caller's order is the one that
			// decides whether the bytes are on disk yet.
			const reader = [
				"function rowsFor(file: string): string {",
				'\treturn fs.readFileSync(file, "utf8");',
				"}",
			];
			const hits = scanFixture(
				[
					...reader,
					'it("x", async () => {',
					"\tawait loadLSPConfig(dir, home);",
					"\tconst text = rowsFor(getLatencyLogPath());",
					"});",
				].join("\n"),
			);
			expect(
				hits.map((hit) => [hit.line, hit.sinks, hit.undrainedCallers]),
			).toEqual([[2, ["clients/latency-logger.ts"], [6]]]);
			// The same call with the drain in front is clean: the sink may reach
			// the helper through a local alias as well.
			expect(
				scanFixture(
					[
						...reader,
						'it("x", async () => {',
						"\tconst file = getLatencyLogPath();",
						"\tawait flushLatencyLog();",
						"\tconst text = rowsFor(file);",
						"});",
					].join("\n"),
				),
			).toEqual([]);
			// A caller that passes a path which is not a sink creates no finding:
			// the parameter rule follows the value, not the parameter's name.
			expect(
				scanFixture(
					[
						...reader,
						'it("x", async () => {',
						'\tconst text = rowsFor(path.join(dir, "notes.txt"));',
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("stat, lstat, open and openSync of a sink are reads (A2, A4)", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait loadLSPConfig(dir, home);",
					"\tconst a = (await fs.promises.stat(getLatencyLogPath())).size;",
					"\tconst b = (await fsp.lstat(getLatencyLogPath())).size;",
					'\tconst fd = fs.openSync(SESSIONSTART_LOG_FILE, "r");',
					"\tconst c = fs.fstatSync(fd).size;",
					'\tconst handle = await fs.promises.open(SESSIONSTART_LOG_FILE, "r");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => [hit.line, hit.callee])).toEqual([
				[3, "stat"],
				[4, "lstat"],
				[5, "openSync"],
				[7, "open"],
			]);
		});

		it("a drain that does not dominate the read is not credited (A19, A20)", () => {
			// Each case is a drain the read cannot rely on: it sits behind a
			// condition, inside a function nothing calls, inside a callback the
			// read does not wait on, or inside a try block whose catch can
			// swallow a throw raised before the drain.
			const cases: Array<[string, string[]]> = [
				[
					"if block (A19)",
					["\tif (cond) {", "\t\tawait flushLatencyLog();", "\t}"],
				],
				["braceless if", ["\tif (cond) await flushLatencyLog();"]],
				["ternary", ["\tcond ? await flushLatencyLog() : undefined;"]],
				["logical and", ["\tcond && (await flushLatencyLog());"]],
				[
					"uncalled inner function, block body (A20)",
					[
						"\tconst unused = async () => {",
						"\t\tawait flushLatencyLog();",
						"\t};",
					],
				],
				[
					"uncalled inner function, expression body",
					["\tconst unused = async () => await flushLatencyLog();"],
				],
				[
					"callback the read does not wait on",
					[
						"\tsetImmediate(async () => {",
						"\t\tawait flushLatencyLog();",
						"\t});",
					],
				],
				[
					"try block with a catch the read follows",
					["\ttry {", "\t\tawait flushLatencyLog();", "\t} catch {}"],
				],
			];
			const verdicts = cases.map(([label, drain]) => {
				const source = [
					'it("x", async () => {',
					...drain,
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				];
				const flagged = scanFixture(source.join("\n")).map((hit) => hit.line);
				return `${label}: ${flagged.includes(source.length - 1) ? "flagged" : "credited"}`;
			});
			expect(verdicts).toEqual(cases.map(([label]) => `${label}: flagged`));
		});

		it("a helper whose drain is conditional is no draining helper", () => {
			const hits = scanFixture(
				[
					"async function maybeDrain(): Promise<void> {",
					"\tif (cond) await flushLatencyLog();",
					"}",
					'it("x", async () => {',
					"\tawait maybeDrain();",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([6]);
		});

		it("a helper whose drain sits in an inner function it never calls is no draining helper", () => {
			// The drain's block is the inner arrow's body, not the helper's, so
			// the helper does not end drained (state table D11).
			const hits = scanFixture(
				[
					"async function notADrain(): Promise<void> {",
					"\tconst later = async () => {",
					"\t\tawait flushLatencyLog();",
					"\t};",
					"}",
					'it("x", async () => {',
					"\tawait notADrain();",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([8]);
		});

		it("a drain outside a reader helper's scope does not credit its read", () => {
			// The drain dominates the helper's declaration, not its call: the
			// helper runs after `await write()` (state table D2, D13).
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tfunction offset(): number {",
					"\t\treturn fs.statSync(getLatencyLogPath()).size;",
					"\t}",
					"\tawait write();",
					"\tconst before = offset();",
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => [hit.line, hit.undrainedCallers])).toEqual([
				[4, [7]],
			]);
		});

		it("a drain in a try body with no catch credits the read after the try", () => {
			// The tree's shape (runtime-turn-test-runner-bounds, result-contract-
			// governance): the drain ends a try whose finally restores an env
			// var; a throw before it skips the read, so it dominates.
			expect(
				scanFixture(
					[
						'it("x", async () => {',
						"	try {",
						"		await flushLatencyLog();",
						"	} finally {",
						"		restore();",
						"	}",
						'	const rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a drain in an enclosing block credits a read nested below it", () => {
			expect(
				scanFixture(
					[
						'it("x", async () => {',
						"\tawait flushLatencyLog();",
						"\tif (cond) {",
						'\t\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
						"\t}",
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("an inline callback reads inside its caller's drain order; aliases resolve", () => {
			expect(
				scanFixture(
					[
						'it("x", async () => {',
						"\tconst file = getLatencyLogPath();",
						"\tawait flushLatencyLog();",
						"\tconst sizes = [file].map((f) => fs.statSync(file).size);",
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("an alias is visible only in the scope that declares it", () => {
			// `file` names the latency sink inside `writerSide` only; the same name
			// as another function's parameter is an unrelated path.
			expect(
				scanFixture(
					[
						"function writerSide(): string {",
						"\tconst file = getLatencyLogPath();",
						"\treturn file;",
						"}",
						"function unrelated(file: string): number {",
						"\treturn fs.statSync(file).size;",
						"}",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a sync reader helper is drained only when every call site drains", () => {
			const reader = [
				"function rowsFor(): string {",
				"\tconst file = getLatencyLogPath();",
				'\treturn fs.readFileSync(file, "utf8");',
				"}",
			];
			const drained = [
				'it("a", async () => {',
				"\tawait flushLatencyLog();",
				'\texpect(rowsFor()).toBe("");',
				"});",
			];
			expect(scanFixture([...reader, ...drained].join("\n"))).toEqual([]);
			const hits = scanFixture(
				[
					...reader,
					...drained,
					'it("b", async () => {',
					'\texpect(rowsFor()).toBe("");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => [hit.line, hit.undrainedCallers])).toEqual([
				[3, [10]],
			]);
		});

		it("a basename literal names an in-process sink only under an in-process root", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					'\tconst child = fs.readFileSync(path.join(childHome, "latency.log"), "utf8");',
					'\tconst notes = fs.statSync(path.join(dir, "notes.txt")).size;',
					"\tconst root = getGlobalPiLensLogDir();",
					'\tconst own = fs.readFileSync(path.join(root, "latency.log"), "utf8");',
					'\tconst env = fs.readFileSync(path.join(process.env.PI_LENS_HOME ?? "", "latency.log"), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([5, 6]);
		});

		it("a helper's own await voids the caller's drain (F2)", () => {
			// The helper suspends before its read: any bytes the code under test
			// enqueues after the caller's drain land before the read.
			const hits = scanFixture(
				[
					"async function rowsFor(file: string): Promise<string> {",
					"\tawait tick();",
					'\treturn fs.readFileSync(file, "utf8");',
					"}",
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tconst text = await rowsFor(getLatencyLogPath());",
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => [hit.line, hit.undrainedCallers])).toEqual([
				[3, []],
			]);
		});

		it("a helper that drains its own sink before its read is clean (F2)", () => {
			// The caller does not drain, and does not have to: the helper's own
			// drain precedes its read with no await in between.
			const reader = [
				"async function rowsFor(file: string): Promise<string> {",
				"\tawait flushLatencyLog();",
				'\treturn fs.readFileSync(file, "utf8");',
				"}",
			];
			expect(
				scanFixture(
					[
						...reader,
						'it("x", async () => {',
						"\tconst text = await rowsFor(getLatencyLogPath());",
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a sink param at any position, destructured, aliased or defaulted is read (F3)", () => {
			const cases: Array<[string, string[], number]> = [
				[
					"second parameter, inside path.join",
					[
						"function rowsFor(fallback: string, file: string): string {",
						'\treturn fs.readFileSync(path.join(fallback, file), "utf8");',
						"}",
						'it("x", async () => {',
						'\tconst text = rowsFor("notes", getLatencyLogPath());',
						"});",
					],
					2,
				],
				[
					"destructured parameter",
					[
						"function rowsFor({ file }: { file: string }): string {",
						'\treturn fs.readFileSync(file, "utf8");',
						"}",
						'it("x", async () => {',
						"\tconst text = rowsFor({ file: getLatencyLogPath() });",
						"});",
					],
					2,
				],
				[
					"aliased parameter",
					[
						"function rowsFor(f: string): string {",
						"\tconst p = f;",
						'\treturn fs.readFileSync(p, "utf8");',
						"}",
						'it("x", async () => {',
						"\tconst text = rowsFor(getLatencyLogPath());",
						"});",
					],
					3,
				],
				[
					"defaulted parameter, argument omitted",
					[
						"function rowsFor(file: string = getLatencyLogPath()): string {",
						'\treturn fs.readFileSync(file, "utf8");',
						"}",
						'it("x", async () => {',
						"\tconst text = rowsFor();",
						"});",
					],
					2,
				],
			];
			for (const [label, source, line] of cases) {
				const hits = scanFixture(source.join("\n"));
				expect(
					hits.map((hit) => [hit.line, hit.sinks, hit.undrainedCallers]),
					label,
				).toEqual([[line, ["clients/latency-logger.ts"], [line + 3]]]);
			}
		});

		it("an await the helper never runs does not void a caller's drain (N1, shape 43)", () => {
			// Suspension is a property of the helper's own straight-line path. An
			// `await` inside a function the helper does not call, inside a callback
			// nothing waits on, or under a branch the read does not sit in lets no
			// bytes onto disk, so the caller's drain still covers the read.
			const cases: Array<[string, string[]]> = [
				[
					"uncalled nested function",
					["\tconst later = async () => { await tick(); };", "\tvoid later;"],
				],
				["dead branch", ["\tif (process.env.NEVER_SET) await tick();"]],
				[
					"short-circuit operand",
					["\tprocess.env.NEVER_SET && (await tick());"],
				],
				[
					"callback nothing awaits",
					["\tsetTimeout(async () => { await tick(); }, 0);"],
				],
			];
			for (const [label, body] of cases) {
				const hits = scanFixture(
					[
						"function rowsFor(file: string): string {",
						...body,
						'\treturn fs.readFileSync(file, "utf8");',
						"}",
						'it("x", async () => {',
						"\tawait flushLatencyLog();",
						"\tconst text = rowsFor(getLatencyLogPath());",
						"\tvoid text;",
						"});",
					].join("\n"),
				);
				expect(
					hits.map((hit) => hit.line),
					label,
				).toEqual([]);
			}
			// The same rule on the helper's own-drain path: an uncalled `await`
			// between the helper's drain and its read does not void that drain.
			expect(
				scanFixture(
					[
						"async function rowsFor(file: string): Promise<string> {",
						"\tawait flushLatencyLog();",
						"\tconst later = async () => { await tick(); };",
						"\tvoid later;",
						'\treturn fs.readFileSync(file, "utf8");',
						"}",
						'it("x", async () => {',
						"\tconst text = await rowsFor(getLatencyLogPath());",
						"\tvoid text;",
						"});",
					].join("\n"),
				),
			).toEqual([]);
			// An await the helper DOES run still voids the drain, including one in
			// the branch the read sits in (a plant nobody listed).
			const guarded = scanFixture(
				[
					"async function rowsFor(file: string): Promise<string> {",
					"\tif (flag) {",
					"\t\tawait tick();",
					'\t\treturn fs.readFileSync(file, "utf8");',
					"\t}",
					'\treturn fs.readFileSync(file, "utf8");',
					"}",
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tconst text = await rowsFor(getLatencyLogPath());",
					"\tvoid text;",
					"});",
				].join("\n"),
			);
			expect(guarded.map((hit) => [hit.line, hit.undrainedCallers])).toEqual([
				[4, []],
			]);
		});

		it("suspends the read on a loop, a finally, or an awaited callback (E1, E2)", () => {
			// Rule C is fail-closed: an await that CAN run between the drain and the
			// read lets the code under test enqueue more bytes. A loop body runs when
			// its iterable is non-empty, a `finally` runs however its `try` exits, and
			// an awaited callback's awaits run while the read waits for it.
			const between: Array<[string, string[]]> = [
				["for-of loop", ["\tfor (const item of [1]) { await tick(); }"]],
				["while loop", ["\tlet n = 1;", "\twhile (n-- > 0) await tick();"]],
				["finally", ["\ttry { tick(); } finally { await tick(); }"]],
			];
			const observed: Array<[string, number[]]> = between.map(
				([label, body]) => [
					label,
					scanFixture(
						[
							'it("x", async () => {',
							"\tawait flushLatencyLog();",
							...body,
							'\tconst text = fs.readFileSync(getLatencyLogPath(), "utf8");',
							"\tvoid text;",
							"});",
						].join("\n"),
					).map((hit) => hit.line),
				],
			);
			// The awaited callback (Greptile P1): the read sits INSIDE the callback,
			// so the enclosing `await Promise.all(...)` is not "the read's own
			// await", and the tick before the read is a real suspension.
			observed.push([
				"awaited callback",
				scanFixture(
					[
						'it("x", async () => {',
						"\tawait flushLatencyLog();",
						"\tawait Promise.all([1].map(async (item) => {",
						"\t\tawait tick();",
						'\t\treturn fs.readFileSync(getLatencyLogPath(), "utf8");',
						"\t}));",
						"});",
					].join("\n"),
				).map((hit) => hit.line),
			]);
			expect(observed).toEqual([
				["for-of loop", [4]],
				["while loop", [5]],
				["finally", [4]],
				["awaited callback", [5]],
			]);
			// A callback nothing awaits still cannot suspend the read (N1's rule,
			// kept): its promise is dropped, so no turn of it precedes the read.
			expect(
				scanFixture(
					[
						'it("x", async () => {',
						"\tawait flushLatencyLog();",
						"\t[1].forEach(async () => { await tick(); });",
						'\tconst text = fs.readFileSync(getLatencyLogPath(), "utf8");',
						"\tvoid text;",
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a read through a same-file alias of a read callee is a read (shape 69)", () => {
			// The population is read CALLEES, so a binding of one is the same read.
			const reads = [
				["bound alias", "const read = fs.readFileSync;"],
				["import alias", 'import { readFileSync as read } from "node:fs";'],
			].map(([label, header]) => [
				label,
				scanFixture(
					[
						header,
						'it("x", async () => {',
						'\tconst text = read(getLatencyLogPath(), "utf8");',
						"\tvoid text;",
						"});",
					].join("\n"),
				).map((hit) => [hit.line, hit.sinks]),
			]);
			expect(reads).toEqual([
				["bound alias", [[3, ["clients/latency-logger.ts"]]]],
				["import alias", [[3, ["clients/latency-logger.ts"]]]],
			]);
		});

		it("a declarator read alias is visible only in the scope that declares it (R3, shape 69)", () => {
			// Two cases, one declaration in the first test and an unrelated local
			// helper of the same name in the second. Only the aliased call is a read:
			// the file-wide set made every `read(...)` in the file a sink read, and
			// the helper's own definition was blamed at its call site.
			const aliased = [
				'it("one", async () => {',
				"\tconst read = fs.readFileSync;",
				'\tconst text = read(getLatencyLogPath(), "utf8");',
				"\tvoid text;",
				"});",
			];
			const helper = [
				'it("two", () => {',
				"\tconst read = (file: string) => file;",
				"\tvoid read(getLatencyLogPath());",
				"});",
			];
			expect(
				scanFixture([...aliased, ...helper].join("\n")).map((hit) => [
					hit.line,
					hit.callee,
				]),
			).toEqual([[3, "read"]]);
			expect(
				scanFixture([...helper, ...aliased].join("\n")).map((hit) => [
					hit.line,
					hit.callee,
				]),
			).toEqual([[7, "read"]]);
			// The helper alone is not a read callee in any scope.
			expect(scanFixture(helper.join("\n"))).toEqual([]);
			// A module-scope alias IS visible in every scope, except where a nearer
			// declaration of the same name shadows it.
			expect(
				scanFixture(["const read = fs.readFileSync;", ...helper].join("\n")),
			).toEqual([]);
			// An alias of an alias resolves through the same declarations.
			expect(
				scanFixture(
					[
						'it("x", async () => {',
						"\tconst read = fs.readFileSync;",
						"\tconst load = read;",
						'\tconst text = load(getLatencyLogPath(), "utf8");',
						"\tvoid text;",
						"});",
					].join("\n"),
				).map((hit) => [hit.line, hit.callee]),
			).toEqual([[4, "load"]]);
		});

		it("resolves a read alias against the innermost block that declares it (F1, shape 69)", () => {
			// Every declarator in one function shares that function's span, so a
			// document-order tie used to decide the name: an inner block's read
			// alias lost to an earlier non-read declaration of the same name and the
			// sink read went silent (Greptile, sink:543). The innermost enclosing
			// SCOPE decides it.
			const cases: Array<[string, string[], Array<[number, string]>]> = [
				[
					"a read alias in a block under an outer non-read helper",
					[
						'it("x", () => {',
						"\tconst read = (file: string) => file;",
						"\t{",
						"\t\tconst read = fs.readFileSync;",
						"\t\tvoid read(getLatencyLogPath());",
						"\t}",
						"});",
					],
					[[5, "read"]],
				],
				[
					"the same under an `if` block",
					[
						'it("x", () => {',
						"\tconst read = (file: string) => file;",
						"\tif (flag) {",
						"\t\tconst read = fs.readFileSync;",
						'\t\tvoid read(getLatencyLogPath(), "utf8");',
						"\t}",
						"});",
					],
					[[5, "read"]],
				],
				[
					"two sibling blocks, one of them a read alias",
					[
						'it("x", () => {',
						"\t{",
						"\t\tconst read = (file: string) => file;",
						"\t\tvoid read(getLatencyLogPath());",
						"\t}",
						"\t{",
						"\t\tconst read = fs.readFileSync;",
						'\t\tvoid read(getLatencyLogPath(), "utf8");',
						"\t}",
						"});",
					],
					[[8, "read"]],
				],
				[
					"a block-local non-read helper hides an outer read alias",
					[
						'it("x", () => {',
						"\tconst read = fs.readFileSync;",
						"\t{",
						"\t\tconst read = (file: string) => file;",
						"\t\tvoid read(getLatencyLogPath());",
						"\t}",
						"});",
					],
					[],
				],
				[
					"two `var` declarations of one name in one function: the later wins",
					[
						'it("x", () => {',
						"\tvar read;",
						"\tvar read = fs.readFileSync;",
						"\tvoid read(getLatencyLogPath());",
						"});",
					],
					[[4, "read"]],
				],
				[
					"a later re-declaration does not shadow an earlier read",
					[
						'it("x", () => {',
						"\tvar read = fs.readFileSync;",
						"\tvoid read(getLatencyLogPath());",
						"\tvar read = (file: string) => file;",
						"});",
					],
					[[3, "read"]],
				],
				[
					"an earlier non-read helper is not displaced by a later alias",
					[
						'it("x", () => {',
						"\tvar read = (file: string) => file;",
						"\tvoid read(getLatencyLogPath());",
						"\tvar read = fs.readFileSync;",
						"});",
					],
					[],
				],
				[
					"a block-local alias does not reach a read outside its block",
					[
						'it("x", () => {',
						"\t{",
						"\t\tconst read = fs.readFileSync;",
						"\t}",
						"\tvoid read(getLatencyLogPath());",
						"});",
					],
					[],
				],
				[
					"`var` hoists, so a block-level `var` alias binds the function",
					[
						'it("x", () => {',
						"\t{",
						"\t\tvar read = fs.readFileSync;",
						"\t}",
						"\tvoid read(getLatencyLogPath());",
						"});",
					],
					[[5, "read"]],
				],
			];
			for (const [label, lines, expected] of cases) {
				expect(
					scanFixture(lines.join("\n")).map((hit): [number, string] => [
						hit.line,
						hit.callee,
					]),
					label,
				).toEqual(expected);
			}
		});

		it("resolves a read inside a nested function against an enclosing alias (r6 P1, shape 69)", () => {
			// Lexical position decides on the declaring scope's own straight line
			// only. A read inside a nested function runs at that function's call
			// time, after an enclosing declaration initialized, so a later alias is
			// in force there: `393a92a34` reported `[[2, "read"]]` and the round-6
			// position filter silenced it (Greptile r6 P1, sink:606).
			//
			// A `function` declaration is the binding's STARTING value: it is
			// installed at scope entry, so an initializer that runs before the read
			// overwrites it (Greptile r7 P1, sink:620). Every row here is code the
			// engine accepts: a `const` and a `function` of one name in one scope is
			// a redeclaration error, so the hoisting rows use `var`.
			const cases: Array<[string, string[], Array<[number, string]>]> = [
				[
					"a helper read resolved against an alias declared below it",
					[
						"function rows(): string {",
						'\treturn read(getLatencyLogPath(), "utf8");',
						"}",
						"const read = fs.readFileSync;",
						'it("x", () => { void rows(); });',
					],
					[[2, "read"]],
				],
				[
					"a `var` initializer overwrites the hoisted function before the read",
					[
						"function rows(): void {",
						"\tvar read = fs.readFileSync;",
						"\tread(getLatencyLogPath());",
						"\tfunction read(file: string): string { return file; }",
						"}",
					],
					[[3, "read"]],
				],
				[
					"a hoisted function hides the outer alias on its own straight line",
					[
						"const read = fs.readFileSync;",
						"function shadowed(): void {",
						"\tvoid read(getLatencyLogPath());",
						"\tfunction read(file: string): string { return file; }",
						"}",
					],
					[],
				],
			];
			for (const [label, lines, expected] of cases) {
				expect(
					scanFixture(lines.join("\n")).map((hit): [number, string] => [
						hit.line,
						hit.callee,
					]),
					label,
				).toEqual(expected);
			}
			// The hoisting row above is live, not vacuous: drop the declaration and
			// the same call resolves to the outer sink alias.
			expect(
				scanFixture(
					[
						"const read = fs.readFileSync;",
						"function shadowed(): void {",
						"\tvoid read(getLatencyLogPath());",
						"}",
					].join("\n"),
				).map((hit): [number, string] => [hit.line, hit.callee]),
			).toEqual([[3, "read"]]);
		});

		it("attributes a helper read to the call site that supplied the sink (N2, shape 58)", () => {
			const reader = [
				"function rowsFor(file: string): string {",
				'\treturn fs.readFileSync(file, "utf8");',
				"}",
			];
			// The caller that passes a non-sink path is never blamed for another
			// caller's sink read, in either order.
			expect(
				scanFixture(
					[
						...reader,
						'it("x", async () => {',
						"\tawait flushLatencyLog();",
						"\tconst text = rowsFor(getLatencyLogPath());",
						"\tvoid text;",
						"});",
						'it("y", async () => {',
						'\tconst text = rowsFor("notes.txt");',
						"\tvoid text;",
						"});",
					].join("\n"),
				),
			).toEqual([]);
			expect(
				scanFixture(
					[
						...reader,
						'it("y", async () => {',
						'\tconst text = rowsFor("notes.txt");',
						"\tvoid text;",
						"});",
						'it("x", async () => {',
						"\tawait flushLatencyLog();",
						"\tconst text = rowsFor(getLatencyLogPath());",
						"\tvoid text;",
						"});",
					].join("\n"),
				),
			).toEqual([]);
			// Two callers that DO pass the sink: only the undrained one is named,
			// and the owner appears once per read.
			const hits = scanFixture(
				[
					...reader,
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tconst text = rowsFor(getLatencyLogPath());",
					"\tvoid text;",
					"});",
					'it("y", async () => {',
					"\tconst text = rowsFor(getLatencyLogPath());",
					"\tvoid text;",
					"});",
				].join("\n"),
			);
			expect(
				hits.map((hit) => [hit.line, hit.sinks, hit.undrainedCallers]),
			).toEqual([[2, ["clients/latency-logger.ts"], [10]]]);
			// Two undrained callers of the same parameter: the read reports once
			// and names the owner once (the review's duplicate-owner row, N2).
			const both = scanFixture(
				[
					...reader,
					'it("x", async () => {',
					"\tconst text = rowsFor(getLatencyLogPath());",
					"\tvoid text;",
					"});",
					'it("y", async () => {',
					"\tconst text = rowsFor(getLatencyLogPath());",
					"\tvoid text;",
					"});",
				].join("\n"),
			);
			expect(
				both.map((hit) => [hit.line, hit.sinks, hit.undrainedCallers]),
			).toEqual([[2, ["clients/latency-logger.ts"], [5, 9]]]);
		});

		it("a helper's own await voids the caller's drain through the alias path (F2)", () => {
			// The pre-existing same-file alias route (`const file =
			// getLatencyLogPath()`) inherits the same rule: the helper's `await`
			// sits between the caller's drain and the read.
			const hits = scanFixture(
				[
					"async function rowsFor(): Promise<string> {",
					"\tconst file = getLatencyLogPath();",
					"\tawait tick();",
					'\treturn fs.readFileSync(file, "utf8");',
					"}",
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tconst text = await rowsFor();",
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => [hit.line, hit.undrainedCallers])).toEqual([
				[4, []],
			]);
		});
	});
});
