/**
 * scripts/lib/test-timeout-headroom.mjs (#5311): the rule behind
 * `scripts/check-test-timeout-headroom.mjs`, which reads a shard's vitest JSON
 * report and names every test whose measured duration took more than a share
 * of the timeout that would have killed it.
 *
 * Why the cap is not in the report. Vitest's JSON reporter serialises each
 * assertion's `duration` and no budget at all: the runner resolves the budget
 * internally (`options.timeout ?? runner.config.testTimeout`, `createTest` in
 * the installed `vitest/dist/chunks/run.*.js`) and never writes it out. So the
 * cap comes back from the source that declared the test, under the runner's own
 * inheritance rules, which are (in that chunk's `parseArguments` and
 * `createSuite`):
 *
 *   1. the test's own timeout — a trailing number (`it(name, fn, 4 * 60_000)`),
 *      or `timeout:` in the options object (`it(name, { timeout }, fn)`) whether
 *      the object is written inline or is a name the file declares
 *      (`const LANE = { timeout: 180_000 }; it(name, LANE, fn)`). A trailing
 *      number wins over the object, because `parseArguments` assigns it after
 *      the object branch.
 *   2. else the nearest enclosing `describe` that declares one — a suite
 *      inherits its parent suite's options
 *      (`options = assignDefined({ ...parentOptions }, options)`), so the
 *      nearest declaration is the effective one at any depth.
 *   3. else the file's `vi.setConfig({ testTimeout })`, which mutates the
 *      runtime config for that file. Only a module-scope statement is that
 *      default: vitest reads it while it collects the module, so the same call
 *      inside a hook, a test body or a branch sets no budget any test runs
 *      under, and a file that calls it only there has no provable default.
 *   4. else the project default. `vitest.config.ts` sets no `testTimeout`, so
 *      that is vitest's own resolved default of 5000 ms (`DEFAULT_TEST_TIMEOUT_MS`).
 *
 * A cap this module cannot resolve is `unresolved` with a reason, never the
 * default: guessing the default would report a slow test under a wide explicit
 * timeout as passing (#5311 acceptance, and defect shape 10). `assessReports`
 * classifies every test it judges before it filters any, so the summary's
 * `N with an unresolved cap` is that whole population and not the subset the
 * ratio happened to emit (r1 F4: 419 unresolved tests on one real run printed
 * as a clean `0`).
 *
 * What the numbers mean. A row is emitted when a test that ran took more than
 * `ratio` of its own resolved cap, or — for an unresolved cap — more than
 * `ratio` of the smallest cap its file could plausibly impose
 * (`fileFloorMs`). Skipped, pending and todo assertions never ran, so they
 * have no budget story and are excluded.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "@ast-grep/napi";
import { escapeRegExp } from "../../clients/string-utils.js";
import { normalizeTestFile } from "../test-history-rollup.mjs";

/** Vitest's resolved default `testTimeout` for a non-browser project. */
export const DEFAULT_TEST_TIMEOUT_MS = 5000;
/** The share of its cap at which a test's headroom is reported (#5311). */
export const HEADROOM_RATIO = 0.6;
/** The baseline document's schema version. */
export const BASELINE_SCHEMA = 1;
/** The committed baseline, relative to the repository root. */
export const DEFAULT_BASELINE_RELATIVE =
	"scripts/test-timeout-headroom-baseline.json";

/** Statuses whose assertion ran and therefore spent budget. */
const NOT_RUN = new Set(["skipped", "pending", "todo"]);
const SUITE_KINDS = new Set(["describe"]);
const TEST_KINDS = new Set(["it", "test"]);
/** `scaledTestTimeout`/`testTimeoutScale` live in one support module (#4592). */
const SCALE_FUNCTIONS = new Set(["scaledTestTimeout", "testTimeoutScale"]);
/** How deep an identifier's import chain may be folded. */
const MAX_FOLD_DEPTH = 6;
/** How many extra source files one file's folding may pull in. */
const MAX_FOLD_FILES = 24;

/** A bounded failure with the report or file it came from. */
export class TimeoutHeadroomError extends Error {}

function numberLiteral(node) {
	if (!node || node.kind() !== "number") return undefined;
	const text = node.text().replaceAll("_", "");
	// A BigInt literal is not a vitest timeout; an unparseable number is not a
	// budget either.
	if (text.endsWith("n")) return undefined;
	const value = Number(text);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * A declaration title: the exact string vitest will report, a pattern when the
 * title interpolates (`${…}`) or templates (`it.each` writes `%s` into the
 * title), or `unresolved` when the title comes from an expression.
 */
function titleOf(node) {
	if (!node) return { kind: "unresolved" };
	if (node.kind() === "string")
		return { kind: "exact", value: node.text().slice(1, -1) };
	if (node.kind() === "template_string") {
		const raw = node.text().slice(1, -1);
		if (!raw.includes("${")) return { kind: "exact", value: raw };
		// A nested template or a `}` inside the substitution defeats the split;
		// leave that title unresolved rather than guess a pattern.
		const parts = raw.split(/\$\{[^}]*\}/);
		if (parts.join("").includes("${")) return { kind: "unresolved" };
		return {
			kind: "pattern",
			regex: new RegExp(
				`^${parts.map((part) => escapeRegExp(part)).join("[\\s\\S]+?")}$`,
			),
		};
	}
	if (node.kind() === "string_fragment")
		return { kind: "exact", value: node.text() };
	return { kind: "unresolved" };
}

/**
 * Turn an `each` title's placeholders into wildcards: vitest fills `%s %d %i %f
 * %j %o %#` from the row and `$name` from an object row (`%%` is a literal
 * percent), so the reported title is the declaration with those holes filled.
 */
function eachPattern(title) {
	if (title.kind !== "exact") return title;
	if (!/%[sdifjo#]|%%|\$[A-Za-z_$][\w$]*/.test(title.value)) return title;
	const parts = title.value.split(/%[sdifjo#]|%%|\$[A-Za-z_$][\w$]*/);
	return {
		kind: "pattern",
		regex: new RegExp(
			`^${parts.map((part) => escapeRegExp(part)).join("[\\s\\S]+?")}$`,
		),
	};
}

function titleMatches(title, testTitle) {
	if (title.kind === "exact") return title.value === testTitle;
	if (title.kind === "pattern") return title.regex.test(testTitle);
	return false;
}

/** The value node of a `timeout`/`testTimeout` pair, or null for any other pair. */
function timeoutPairValue(pairNode) {
	if (pairNode.kind() !== "pair") return null;
	const named = pairNode.children().filter(isArgumentNode);
	const key = named[0];
	if (!key || (key.kind() !== "property_identifier" && key.kind() !== "string"))
		return null;
	const name = key.text().replace(/^["']|["']$/g, "");
	return name === "timeout" || name === "testTimeout"
		? (named[1] ?? null)
		: null;
}

/**
 * The budget member an object literal declares: the LAST `timeout`/`testTimeout`
 * pair, because a later key wins in JavaScript, and null when the object declares
 * none.
 */
function timeoutPair(objNode) {
	if (!objNode || objNode.kind() !== "object") return null;
	let value = null;
	for (const pair of objNode.children()) {
		const candidate = timeoutPairValue(pair);
		if (candidate) value = candidate;
	}
	return value;
}

const isHandler = (node) =>
	node &&
	(node.kind() === "arrow_function" ||
		node.kind() === "function_expression" ||
		node.kind() === "generator_function" ||
		node.kind() === "function");

/**
 * The timeout expression the runner would read from a test call, in the order
 * `parseArguments` reads it: the options or budget expression in the second slot,
 * or the expression that follows the handler. A slot the runner does not read for
 * a budget -- the handler itself, or options written after it -- declares none.
 */
function timeoutExpressionOf(argNodes) {
	const second = argNodes[1];
	const third = argNodes[2];
	// `it(title, fn, budget)` and `it(title, { timeout }, fn)` both carry the cap;
	// in either shape an object is read for its `timeout:` member, because the
	// object itself is not a number and `it(title, fn, { retry: 2 })` has no
	// budget of its own.
	// A handler in the second slot means a trailing budget: `it(title, fn, 30_000)`.
	// The runner still takes a trailing number -- probed against the pinned vitest
	// 5.1.0, the file collects and enforces it (a 600 ms test under `it(name, fn,
	// 300)` fails "Test timed out in 300ms"), and
	// `tests/clients/dispatch/fact-store-session-bound.test.ts` uses that shape
	// today. A trailing OBJECT is the half of the signature the runner refuses:
	// `it(name, fn, { timeout })` and `describe(name, fn, { timeout })` are rejected
	// at collection and report zero tests, so there is no row whose cap could come
	// from it and the object is not read here (r2 F8).
	if (third !== undefined && isHandler(second))
		return objectTimeout(third) === null ? { node: third } : null;
	// A second argument that is not the handler, with a handler after it, is the
	// options slot: `it(name, LANE, fn)`. Read it as options rather than skipping
	// to the file chain, so a name bound to `{ timeout: 180_000 }` resolves and a
	// name this file cannot read lands unresolved at `foldMs` instead of at the
	// 5000 ms default (r1 CR2: 16 declarations folded 5000 against a real 180000).
	if (second !== undefined && third !== undefined)
		return objectTimeout(second) ?? { node: second };
	if (second !== undefined) return objectTimeout(second);
	return null;
}

/**
 * The options object a budget slot holds, or null when the slot holds something
 * else (the handler, a number, a name). Whether that object declares a budget is
 * `foldObjectTimeout`'s read alone: an object with no reachable `timeout:` pair
 * folds to nothing, and the test is then reported unresolved against the file
 * floor rather than quietly taking a default its declaration never named. The
 * pair-and-spread test this function used to carry decided nothing at either
 * call site, so the read lives in one place (r2 F7).
 */
function objectTimeout(node) {
	if (!node || node.kind() !== "object") return null;
	return { node };
}

// Comments are named nodes in the tree but are never arguments to the runner,
// so they must not shift the positional read of a test call or stand in as the
// value of a `timeout:` member.
// `range()` answers `{ start, end }`, each `{ line, column, index }`; the
// character offsets are the ones this module compares, so they are spelled once
// here (a `.range().startIndex` read is `undefined` and every comparison that
// consumes it fails quietly).
const startIndex = (node) => node.range().start.index;
const endIndex = (node) => node.range().end.index;

const isArgumentNode = (c) =>
	c.isNamed() && c.kind() !== "type_arguments" && c.kind() !== "comment";

function callArgumentNodes(args) {
	return args ? args.children().filter(isArgumentNode) : [];
}

/** One `it`/`describe` call node read as a declaration of a title and a budget. */
function declarationFromCall({ callee, isSuite, stack, argNodes }) {
	const timeout = timeoutExpressionOf(argNodes);
	return {
		kind: isSuite ? "suite" : "test",
		callee,
		title: /\.each\b/.test(callee)
			? eachPattern(titleOf(argNodes[0]))
			: titleOf(argNodes[0]),
		stack,
		timeoutNode: timeout?.node,
		hasTimeout: timeout != null,
	};
}

/**
 * One parsed source file: its test and suite declarations, its module-scope
 * constants, its relative imports, and its file-level `vi.setConfig` budgets.
 */
function indexSource(text, { scale }) {
	const root = parse("typescript", text).root();
	const declarations = [];
	const consts = new Map();
	const imports = new Map();
	const setConfigs = [];
	// `vi.setConfig` calls that sit inside a hook, a test body or a branch. They
	// are not the file default (vitest reads the config while it collects the
	// module), and they make the default unpredictable for some tests, so they
	// leave the file's default unresolved rather than widening it (r1 F5).
	const nestedSetConfigs = [];
	// Names the file re-binds with a plain assignment. A name with more than one
	// value over the file's run has no foldable budget, so a cap read through it
	// stays unresolved rather than taking whichever initializer came first (r1 CR2).
	const reassigned = new Set();

	// A name maps to every initializer that binds it in this file. Two bindings of
	// one name are common (`const timeout = …` in two test bodies), so folding an
	// identifier prefers the declaration that lexically encloses the use and only
	// falls back to agreement across all of them (`foldIdentifier`).
	const recordConst = (node) => {
		for (const declarator of node
			.children()
			.filter((c) => c.kind() === "variable_declarator")) {
			const children = declarator.children();
			const name = children.find(
				(c) => c.kind() === "identifier" || c.kind() === "property_identifier",
			);
			if (!name) continue;
			// The initializer is the named node after the `=` token: the children
			// before it are the name and its type annotation, and a comment between
			// `=` and the value is a named node too.
			const equals = children.findIndex(
				(c) => !c.isNamed() && c.text() === "=",
			);
			if (equals === -1) continue;
			const initializer = children
				.slice(equals + 1)
				.find(
					(c) =>
						c.isNamed() &&
						c.kind() !== "comment" &&
						c.kind() !== "type_annotation",
				);
			if (!initializer) continue;
			const bound = consts.get(name.text());
			if (bound) bound.push(initializer);
			else consts.set(name.text(), [initializer]);
		}
	};

	// A test or suite may be reached through a one-name alias, the tree's shape
	// for a capability gate (`const d = cliAvailable ? describe : describe.skip;`,
	// `const d = it.skipIf(process.platform === "win32")`). Only consulted for a
	// callee that is not itself a runner name, and it accepts a binding whose text
	// has a runner name at a property root, so a helper that merely mentions `it`
	// in a string cannot turn an unrelated call into a declaration.
	const aliasBase = (name) => {
		const bindings = consts.get(name);
		if (!bindings || bindings.length !== 1) return name;
		const matched = /(?:^|[^.\w$])(describe|it|test)(?=$|[.\s(])/.exec(
			bindings[0].text(),
		);
		return matched ? matched[1] : name;
	};

	// The `testTimeout` values of the `vi.setConfig` calls that sit at module
	// scope, read straight off the module's statement list: vitest evaluates the
	// module before it collects, so only these are the file's default budget.
	const moduleSetConfigValues = new Set(
		root
			.children()
			.filter((child) => child.kind() === "expression_statement")
			.flatMap((statement) => {
				const call = statement
					.children()
					.find((child) => child.kind() === "call_expression");
				if (
					!call ||
					!/^(?:vi\.)?setConfig$/.test(call.field("function")?.text() ?? "")
				)
					return [];
				const args = call.field("arguments");
				return (
					args ? args.children().filter((c) => c.kind() === "object") : []
				)
					.map((obj) => timeoutPair(obj))
					.filter(Boolean)
					.map(startIndex);
			}),
	);

	// `stack` is the chain of enclosing suite declarations, innermost last.
	const walk = (node, stack) => {
		for (const child of node.children()) {
			switch (child.kind()) {
				case "lexical_declaration": {
					recordConst(child);
					walk(child, stack);
					continue;
				}
				case "import_statement": {
					recordImport(child, imports);
					continue;
				}
				case "assignment_expression": {
					// The grammar carries no `operator` field through the napi binding (the
					// token is anonymous), so the operator is the first anonymous node that
					// starts at or after the target ends. `==`, `=>` and `+=` are not a
					// re-binding; only a plain `=` makes a name multi-valued (r1 CR2).
					const left = child.field("left");
					const operator = left
						? child
								.children()
								.find((c) => !c.isNamed() && startIndex(c) >= endIndex(left))
						: undefined;
					if (operator?.text() === "=") {
						const targets =
							left.kind() === "identifier"
								? [left]
								: left.children().filter((c) => c.kind() === "identifier");
						for (const target of targets) reassigned.add(target.text());
					}
					walk(child, stack);
					continue;
				}
				case "call_expression":
					break;
				default:
					walk(child, stack);
					continue;
			}
			const callee = child.field("function")?.text() ?? "";
			const base = aliasBase(callee.split(/[.([]/)[0]);
			const args = child.field("arguments");
			if (/^(?:vi\.)?setConfig$/.test(callee) && args) {
				for (const obj of args
					.children()
					.filter((c) => c.kind() === "object")) {
					const value = timeoutPair(obj);
					if (!value) continue;
					if (moduleSetConfigValues.has(startIndex(value)))
						setConfigs.push(value);
					else nestedSetConfigs.push(value);
				}
				walk(child, stack);
				continue;
			}
			const isSuite = SUITE_KINDS.has(base);
			const isTest = TEST_KINDS.has(base);
			if (!isSuite && !isTest) {
				walk(child, stack);
				continue;
			}
			const argNodes = callArgumentNodes(args);
			const declaration = declarationFromCall({
				callee,
				isSuite,
				stack,
				argNodes,
			});
			declarations.push(declaration);
			// Only the factory body holds the nested declarations; walking the whole
			// call would also descend into the timeout expression and the title. A
			// chained `it.each(cases)("title", fn, timeout)` puts the title and the
			// budget on the INNER call, so the callee chain is walked at the same
			// nesting level, not as a suite of its own.
			const factory = argNodes.find((c) => isHandler(c));
			if (factory) walk(factory, isSuite ? [...stack, declaration] : stack);
			else if (!isSuite) for (const a of argNodes) walk(a, stack);
			const chained = child.field("function");
			if (chained && chained.kind() === "call_expression") walk(chained, stack);
		}
	};
	walk(root, []);

	return {
		declarations,
		consts,
		imports,
		setConfigs,
		nestedSetConfigs,
		reassigned,
		scale,
	};
}

function recordImport(node, imports) {
	const source = node.children().find((c) => c.kind() === "string");
	if (!source) return;
	const specifier = source.text().slice(1, -1);
	if (!specifier.startsWith(".")) return;
	for (const clause of node
		.children()
		.filter((c) => c.kind() === "import_clause")) {
		for (const named of clause
			.children()
			.filter(
				(c) => c.kind() === "named_imports" || c.kind() === "namespace_import",
			)) {
			for (const spec of named
				.children()
				.filter((c) => c.kind() === "import_specifier")) {
				const named2 = spec.children().filter((c) => c.isNamed());
				const imported = named2.find(
					(c) => c.kind() === "identifier" && c !== named2[named2.length - 1],
				);
				const local = named2[named2.length - 1];
				if (!local || local.kind() !== "identifier") continue;
				imports.set(local.text(), {
					module: specifier,
					exported: imported ? imported.text() : local.text(),
				});
			}
		}
	}
}

/**
 * One fold's context. `opened` bounds how many imported files a single fold may
 * read and breaks an import cycle; it belongs to one fold, not to a table, and
 * every cap resolution starts a fresh one (#5311: a counter kept on the cached
 * table starves the later tests of the same file).
 */
const createFoldContext = () => ({ opened: new Set() });

/**
 * Fold a timeout expression to milliseconds. Admits the forms the tree's
 * declarations actually use (census over `tests/**`): a number literal, `+ - *
 * / %` of folded values, a unary sign, an identifier bound to one folded
 * constant in the same file or one relative import, and `scaledTestTimeout(n)`
 * / `testTimeoutScale()` scaled by `scale`. Anything else is `undefined`, and
 * the caller reports the row as unresolved rather than assuming a budget.
 */
function foldMs(node, table, depth, ctx = createFoldContext()) {
	if (!node || depth > MAX_FOLD_DEPTH) return undefined;
	const direct = numberLiteral(node);
	if (direct !== undefined) return direct;
	switch (node.kind()) {
		case "unary_expression": {
			const value = foldMs(operandOfUnary(node), table, depth + 1, ctx);
			if (value === undefined) return undefined;
			return node.children()[0]?.text() === "-" ? -value : value;
		}
		case "binary_expression": {
			const named = node.children().filter((c) => c.isNamed());
			const left = foldMs(named[0], table, depth + 1, ctx);
			const right = foldMs(named[1], table, depth + 1, ctx);
			if (left === undefined || right === undefined) return undefined;
			const operator = node
				.children()
				.find((c) => !c.isNamed())
				?.text();
			return applyOperator(operator, left, right);
		}
		case "identifier":
		case "shorthand_property_identifier_pattern":
			return foldIdentifier(node.text(), table, depth, ctx);
		case "call_expression":
			return foldScaleCall(node, table, depth, ctx);
		case "object":
			return foldObjectTimeout(node, table, depth, ctx);
		default:
			return undefined;
	}
}

/**
 * The budget an options-object node declares. A spread placed after the
 * `timeout:` pair can overwrite it with a value this file cannot read, so that
 * budget is not provable (`{ timeout: 400, ...lane }`).
 */
function foldObjectTimeout(node, table, depth, ctx) {
	const value = timeoutPair(node);
	if (!value) return undefined;
	const declaredAt = startIndex(value);
	if (
		node
			.children()
			.some((c) => c.kind() === "spread_element" && startIndex(c) > declaredAt)
	)
		return undefined;
	return foldMs(value, table, depth + 1, ctx);
}

/** The one meaningful operand of a unary expression. */
function operandOfUnary(node) {
	return node
		.children()
		.filter(
			(c) =>
				c.isNamed() && c.kind() !== "type_annotation" && c.kind() !== "comment",
		)[0];
}

function applyOperator(operator, left, right) {
	switch (operator) {
		case "+":
			return left + right;
		case "-":
			return left - right;
		case "*":
			return left * right;
		case "/":
			return right === 0 ? undefined : left / right;
		case "%":
			return right === 0 ? undefined : left % right;
		default:
			return undefined;
	}
}

/** `scaledTestTimeout(n)` / `testTimeoutScale()`, the tree's scaled-budget pair. */
function foldScaleCall(node, table, depth, ctx) {
	const callee = node.field("function")?.text() ?? "";
	if (!SCALE_FUNCTIONS.has(callee)) return undefined;
	if (callee === "testTimeoutScale") return table.scale;
	const args = node.field("arguments");
	const argNodes = args
		? args.children().filter((c) => c.isNamed() && c.kind() !== "comment")
		: [];
	// An argument that does not fold stays unresolved; the row is then reported
	// against its file's floor, never against a guess.
	const base = foldMs(argNodes[0], table, depth + 1, ctx);
	return base === undefined ? undefined : base * table.scale;
}

function foldIdentifier(name, table, depth, ctx) {
	if (table.reassigned.has(name)) return undefined;
	const bindings = table.consts.get(name) ?? [];
	if (bindings.length > 0) {
		// Several bindings of one name fold only when all of them fold and all of
		// them agree. Which binding a use reads is a scope question (a shadowed
		// `const BUDGET_MS` inside a suite), and this module reads the file
		// flatly, so a disagreement stays unresolved and visible rather than
		// naming whichever binding came first.
		const values = bindings.map((node) => foldMs(node, table, depth + 1, ctx));
		const folded = values.filter((ms) => ms !== undefined);
		return folded.length === bindings.length && new Set(folded).size === 1
			? folded[0]
			: undefined;
	}
	const bound = table.imports.get(name);
	if (!bound || ctx.opened.size >= MAX_FOLD_FILES) return undefined;
	const other = table.openImported(bound.module);
	if (!other || ctx.opened.has(other.file)) return undefined;
	ctx.opened.add(other.file);
	return foldIdentifier(bound.exported, other, depth + 1, ctx);
}

/**
 * A file's declarations plus the fold context: the file's own table and the
 * lazily parsed tables of its relative imports, keyed by resolved path.
 */
export function indexTestFile(file, { scale = 1, readFile, tables } = {}) {
	const read =
		readFile ??
		((abs) => {
			try {
				return fs.readFileSync(abs, "utf8");
			} catch {
				return undefined;
			}
		});
	const registry = tables ?? new Map();
	return buildTable(file, { scale, read, registry });
}

function resolveImportedPath(fromFile, specifier) {
	const joined = path.resolve(path.dirname(fromFile), specifier);
	const candidates = [
		joined,
		joined.replace(/\.js$/, ".ts"),
		joined.replace(/\.mjs$/, ".mts"),
		`${joined}.ts`,
	];
	for (const candidate of candidates) {
		if (candidate.endsWith(".ts") || candidate.endsWith(".mts")) {
			if (fs.existsSync(candidate)) return candidate;
			continue;
		}
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

function buildTable(file, { scale, read, registry }) {
	const key = path.resolve(file);
	const cached = registry.get(key);
	if (cached) return cached;
	const text = read(key);
	if (text === undefined) {
		registry.set(key, null);
		return null;
	}
	let indexed;
	try {
		indexed = indexSource(text, { scale });
	} catch {
		registry.set(key, null);
		return null;
	}
	const table = {
		file: key,
		...indexed,
		openImported: (specifier) => {
			const target = resolveImportedPath(key, specifier);
			if (!target) return null;
			return buildTable(target, { scale, read, registry });
		},
	};
	registry.set(key, table);
	return table;
}

/** The file's own `vi.setConfig` budget, or vitest's default. */
export function fileDefaultMs(table) {
	if (!table) return { ms: undefined, reason: "source-unreadable" };
	// A `vi.setConfig` that is not a module-scope statement is not the file's
	// default, and it leaves the budget some later test runs under unpredictable,
	// so the file has no provable default rather than a wide one (r1 F5).
	if (table.nestedSetConfigs.length > 0)
		return { ms: undefined, reason: "file-timeout-nested-setConfig" };
	if (table.setConfigs.length === 0)
		return { ms: DEFAULT_TEST_TIMEOUT_MS, reason: "project-default" };
	const folded = table.setConfigs.map((node) => foldMs(node, table, 0));
	const distinct = new Set(folded.filter((ms) => ms !== undefined));
	if (folded.some((ms) => ms === undefined) || distinct.size !== 1)
		return { ms: undefined, reason: "file-timeout-unresolved" };
	return { ms: [...distinct][0], reason: "file-setConfig" };
}

/**
 * The smallest cap a file could impose on a test whose own cap is unresolved:
 * its file default when any declaration there relies on the default, else the
 * narrowest declared cap in the file, because every test in such a file
 * overrides and an unresolvable one most likely does too.
 */
export function fileFloorMs(table) {
	const base = fileDefaultMs(table);
	if (!table) return { ms: undefined, reason: "source-unreadable" };
	if (base.ms === undefined) return base;
	let smallest = base.ms;
	let sawAbsent = false;
	let smallestDeclared = base.ms;
	for (const declaration of table.declarations) {
		if (!declaration.hasTimeout) {
			if (declaration.kind === "test") sawAbsent = true;
			continue;
		}
		const ms = foldMs(declaration.timeoutNode, table, 0);
		if (ms === undefined) continue;
		smallestDeclared = Math.min(smallestDeclared, ms);
	}
	if (sawAbsent) return { ms: smallest, reason: base.reason };
	return { ms: Math.min(base.ms, smallestDeclared), reason: "file-narrowest" };
}

/**
 * Whether a suite declaration sits at one level of a reported ancestor chain. A
 * suite whose title this module cannot read (a `describe(expr)`) matches by
 * position: whichever instance it is, the declaration and therefore the budget
 * are the same one.
 */
function suiteMatchesChain(declaration, chain) {
	if (declaration.stack.length !== chain.length) return false;
	return declaration.stack.every(
		(suite, index) =>
			suite.title.kind === "unresolved" ||
			titleMatches(suite.title, chain[index]),
	);
}

/** The cap one declaration resolves to, or why it does not. */
function capOfDeclaration(table, declaration) {
	if (declaration.hasTimeout) {
		const ms = foldMs(declaration.timeoutNode, table, 0);
		return ms === undefined
			? { status: "unresolved", reason: "timeout-unfoldable" }
			: { status: "resolved", capMs: ms };
	}
	// Nearest enclosing suite that declares a budget, walking inward-out: the
	// runner copies the parent suite's options down every level, so the nearest
	// declaration is the effective one.
	for (let index = declaration.stack.length - 1; index >= 0; index -= 1) {
		const suite = declaration.stack[index];
		if (!suite.hasTimeout) continue;
		const ms = foldMs(suite.timeoutNode, table, 0);
		return ms === undefined
			? { status: "unresolved", reason: "suite-timeout-unfoldable" }
			: { status: "resolved", capMs: ms };
	}
	const fallback = fileDefaultMs(table);
	return fallback.ms === undefined
		? { status: "unresolved", reason: fallback.reason }
		: { status: "resolved", capMs: fallback.ms };
}

const capKey = (cap) =>
	cap.status === "resolved" ? `r:${cap.capMs}` : `u:${cap.reason}`;

/**
 * The declarations that could have produced one reported title under its
 * ancestor chain. The runner shortens a long `each` title with a trailing
 * ellipsis, so a prefix match is attempted only after the exact and pattern pass
 * found nothing, and only while it stays unique.
 */
function matchDeclarations(table, chain, title) {
	const underChain = (d) => d.kind === "test" && suiteMatchesChain(d, chain);
	const aligned = table.declarations.filter(
		(d) => underChain(d) && titleMatches(d.title, title),
	);
	if (aligned.length > 0) return { declarations: aligned };
	if (!title.endsWith("…")) return { reason: "declaration-not-found" };
	const prefix = title.slice(0, -1);
	const prefixed = table.declarations.filter(
		(d) =>
			underChain(d) &&
			(d.title.kind === "exact"
				? d.title.value.startsWith(prefix)
				: d.title.kind === "pattern" && prefixMatchesPattern(d.title, prefix)),
	);
	if (prefixed.length === 1) return { declarations: prefixed, truncated: true };
	return {
		reason:
			prefixed.length === 0
				? "declaration-not-found"
				: "declaration-truncation-ambiguous",
	};
}

/** Whether a pattern title could begin with this text (a truncated report). */
function prefixMatchesPattern(title, prefix) {
	return new RegExp(title.regex.source.slice(0, -1)).test(prefix);
}

/**
 * The cap the runner would apply to one reported test.
 *
 * `{ status: "resolved", capMs }` names the budget; `{ status: "unresolved",
 * reason }` says why no budget is provable, and the caller never treats the test
 * as under budget. Two declarations may match one reported title (an exact `it`
 * and a loop-generated `` it(`… ${name}`) ``); that is ambiguous only when they
 * disagree about the budget.
 */
export function resolveCap(table, { chain, title }) {
	if (!table) return { status: "unresolved", reason: "source-unreadable" };
	const match = matchDeclarations(table, chain, title);
	if (match.reason) return { status: "unresolved", reason: match.reason };
	const caps = match.declarations.map((d) => capOfDeclaration(table, d));
	if (new Set(caps.map(capKey)).size !== 1)
		return { status: "unresolved", reason: "declaration-ambiguous" };
	return {
		...caps[0],
		...(match.truncated ? { titleMatch: "truncated" } : {}),
	};
}

/** Every ran assertion of one vitest JSON report, with its repo-relative file. */
export function parseTestReport(value, { source = "<report>" } = {}) {
	if (!value || typeof value !== "object" || !Array.isArray(value.testResults))
		throw new TimeoutHeadroomError(
			`${source}: not a vitest JSON report (no testResults array)`,
		);
	const rows = [];
	// Every identity the report carries, including the assertions that never ran:
	// a baseline row whose test has gone is stale whether the test was skipped or
	// deleted, and the two look the same from the judged rows alone.
	const reported = new Map();
	let undated = 0;
	for (const result of value.testResults) {
		if (!result || typeof result !== "object") continue;
		const file = normalizeTestFile(String(result.name ?? ""));
		for (const assertion of result.assertionResults ?? []) {
			if (!assertion || typeof assertion !== "object") continue;
			const chain = Array.isArray(assertion.ancestorTitles)
				? assertion.ancestorTitles.map(String)
				: [];
			if (typeof assertion.title !== "string") continue;
			const labels = reported.get(file) ?? new Set();
			labels.add(testLabel(chain, assertion.title));
			reported.set(file, labels);
			if (NOT_RUN.has(assertion.status)) continue;
			if (!Number.isFinite(assertion.duration)) {
				undated += 1;
				continue;
			}
			rows.push({
				file,
				chain,
				title: assertion.title,
				status: assertion.status,
				durationMs: assertion.duration,
			});
		}
	}
	return { rows, undated, reported };
}

/**
 * Baseline rows that name a test the reports did not carry. A row whose test has
 * been renamed or deleted excuses nothing, and a ledger of such rows is a ratchet
 * that has stopped measuring: the row is reported only when its own file was in
 * the run, so a partial shard never calls a row stale.
 */
export function staleBaselineEntries(baseline, reported) {
	const stale = [];
	for (const entry of baseline.entries.values()) {
		const labels = reported.get(entry.file);
		if (!labels || labels.has(entry.test)) continue;
		stale.push(entry);
	}
	return stale;
}

/** How a report spells one test: its suite chain and title, joined. */
function testLabel(chain, title) {
	return [...chain, title].join(" > ");
}

/** The stable identity a baseline entry admits. */
export function rowId({ file, chain, title, capLabel }) {
	return `${file}\u0000${testLabel(chain, title)}\u0000${capLabel}`;
}

export function capLabelOf(resolution) {
	return resolution.status === "resolved"
		? `cap:${String(resolution.capMs)}`
		: `unresolved:${resolution.reason}`;
}

/**
 * Assess reports against the ratio. Returns the emitted rows (sorted), the
 * counts behind the summary line (including `unresolved`, how many of the
 * judged tests have no provable cap, and `floored`, how many of those were
 * emitted against their file's floor), and every identity the reports carried
 * per file, which is what tells a stale baseline row from a shard that never
 * ran its file.
 */
export function assessReports({
	reportValues,
	root,
	ratio = HEADROOM_RATIO,
	scale = 1,
	readFile,
}) {
	if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1)
		throw new TimeoutHeadroomError(
			`ratio must be a fraction in (0, 1): ${ratio}`,
		);
	const tables = new Map();
	const rows = [];
	const reported = new Map();
	const byReason = {};
	let tests = 0;
	let undated = 0;
	let unresolved = 0;
	for (const { value, source } of reportValues) {
		const parsed = parseTestReport(value, { source });
		tests += parsed.rows.length;
		undated += parsed.undated;
		for (const [file, labels] of parsed.reported) {
			const into = reported.get(file) ?? new Set();
			for (const label of labels) into.add(label);
			reported.set(file, into);
		}
		for (const row of parsed.rows) {
			const tableFile = path.resolve(root, row.file);
			const table =
				tables.get(tableFile) ??
				indexTestFile(tableFile, { scale, readFile, tables });
			const resolution = resolveCap(table, row);
			// Counted before the ratio filter, so a test under the floor is visible
			// as unmeasured instead of joining the passing population (r1 F4).
			if (resolution.status === "unresolved") {
				unresolved += 1;
				byReason[resolution.reason] = (byReason[resolution.reason] ?? 0) + 1;
			}
			const label = capLabelOf(resolution);
			const floor = fileFloorMs(table);
			const limit =
				resolution.status === "resolved" ? resolution.capMs : floor.ms;
			if (limit === undefined || !(row.durationMs > ratio * limit)) continue;
			rows.push({
				...row,
				capStatus: resolution.status,
				capMs: resolution.capMs,
				reason: resolution.reason,
				floorMs: floor.ms,
				capLabel: label,
				ratio: row.durationMs / limit,
				id: rowId({ ...row, capLabel: label }),
			});
		}
	}
	rows.sort((a, b) =>
		a.ratio === b.ratio ? (a.id < b.id ? -1 : 1) : b.ratio - a.ratio,
	);
	// Rows whose cap did not resolve were still judged, against the file's floor;
	// `unresolved` is the whole judged population, `floored` the emitted subset.
	const floored = rows.filter((r) => r.capStatus === "unresolved").length;
	return {
		rows,
		reported,
		counts: {
			tests,
			undated,
			emitted: rows.length,
			floored,
			unresolved,
			byReason,
			maxRatio: rows.length ? rows[0].ratio : 0,
		},
	};
}

/** Read a baseline document, or an empty one when the file is absent. */
export function loadBaseline(file) {
	if (!fs.existsSync(file)) return { entries: new Map(), missing: true, file };
	let value;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new TimeoutHeadroomError(
			`baseline ${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { entries: baselineEntries(value, file), missing: false, file };
}

/** Validate a baseline document and key its entries. */
export function baselineEntries(value, source = "<baseline>") {
	if (!value || typeof value !== "object" || !Array.isArray(value.entries))
		throw new TimeoutHeadroomError(
			`${source}: not a timeout-headroom baseline (no entries array)`,
		);
	if (value.schema !== BASELINE_SCHEMA)
		throw new TimeoutHeadroomError(
			`${source}: unsupported schema ${String(value.schema)}, expected ${BASELINE_SCHEMA}`,
		);
	const entries = new Map();
	for (const entry of value.entries) {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.file !== "string" ||
			typeof entry.test !== "string" ||
			(entry.capStatus !== "resolved" && entry.capStatus !== "unresolved") ||
			(entry.capStatus === "resolved" && !Number.isFinite(entry.capMs)) ||
			(entry.capStatus === "unresolved" && typeof entry.reason !== "string")
		)
			throw new TimeoutHeadroomError(`${source}: malformed baseline entry`);
		const capLabel =
			entry.capStatus === "resolved"
				? `cap:${String(entry.capMs)}`
				: `unresolved:${entry.reason}`;
		const chain = entry.test.split(" > ");
		const key = rowId({
			file: entry.file,
			chain: chain.slice(0, -1),
			title: chain[chain.length - 1],
			capLabel,
		});
		if (entries.has(key))
			throw new TimeoutHeadroomError(
				`${source}: duplicate baseline entry for ${entry.file} > ${entry.test}`,
			);
		entries.set(key, entry);
	}
	return entries;
}

/**
 * The baseline document for a run's rows (`--write-baseline`).
 *
 * One entry per reader identity (`file`, `test`, cap label): two reports can
 * carry the same test, an overlapping shard or the same file passed twice, and
 * `baselineEntries` refuses a duplicate identity, which would make the whole
 * written file unreadable and read every offender back as new. The rows arrive
 * sorted slowest-first, so keeping the first keeps the highest ratio (r1 Q4).
 */
export function buildBaselineDocument({ rows, generatedFrom, ratio, scale }) {
	const unique = [];
	const identities = new Set();
	for (const row of rows) {
		if (identities.has(row.id)) continue;
		identities.add(row.id);
		unique.push(row);
	}
	return {
		schema: BASELINE_SCHEMA,
		generatedAt: new Date().toISOString(),
		generatedFrom,
		ratio,
		scale,
		entries: unique
			.map((row) => ({
				file: row.file,
				test: [...row.chain, row.title].join(" > "),
				capStatus: row.capStatus,
				...(row.capStatus === "resolved"
					? { capMs: row.capMs }
					: { reason: row.reason }),
				durationMs: Math.round(row.durationMs),
			}))
			.sort(
				(a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test),
			),
	};
}

/** One row, one line: what it took, against what would have killed it. */
export function formatRow(row) {
	const cap =
		row.capStatus === "resolved"
			? `${Math.round(row.capMs)} ms cap`
			: `cap unresolved (${row.reason}, floor ${Math.round(row.floorMs)} ms)`;
	return `${row.file} > ${[...row.chain, row.title].join(" > ")}: ${Math.round(
		row.durationMs,
	)} ms is ${Math.round(row.ratio * 100)}% of the ${cap}`;
}

export function formatSummary(counts, { known, added, ratio, scale }) {
	const reasons = Object.entries(counts.byReason)
		.map(([reason, n]) => `${reason} ${n}`)
		.join(", ");
	return `timeout-headroom: ${counts.tests} tests read, ${counts.emitted} over ${Math.round(
		ratio * 100,
	)}% (${known} known, ${added} new), ${counts.unresolved} with an unresolved cap${
		reasons ? ` (${reasons})` : ""
	}${counts.undated ? `, ${counts.undated} without a duration` : ""}, scale ${scale}`;
}
