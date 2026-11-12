/**
 * AST detector for partial whole-module `vi.mock` factories.
 *
 * #2272 and #2782 repeated the same failure: a production export was added,
 * but a test's object-literal mock silently dropped it. This detector only
 * accepts direct object-literal factory returns and treats an
 * `importActual`/`importOriginal` spread for the same specifier as complete.
 *
 * Out-of-line factories (`const factory = () => ({...}); vi.mock(m, factory)`)
 * resolve to their local definition and are checked with the same body rule;
 * a factory that cannot be resolved locally (imported, member access, call
 * result) fails closed as an unresolved finding rather than passing silently
 * (#2959 round 1 MEDIUM, shape 34). The latency target selector below is the
 * single source for the #2281 latency surface; the sweep consumes it so the
 * discriminator lives in one tested place.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { bareIdentifier } from "./lsp-double-gate.js";
import { namedParts, unwrapParens } from "./spawn-cwd-scan.js";
import { firstCommentMatch } from "./sweep-kit.js";

export interface ViMockExportFinding {
	file: string;
	line: number;
	specifier: string;
	productionFile: string;
	missing: string[];
	factoryProperties: string[];
}

export type ViMockExportMode = "imported" | "all";

export interface ViMockExportOptions {
	/** Maximum number of production-importer hops after the test file. */
	importerDepth?: number;
}

export function unquote(text: string): string | undefined {
	if (!/^['"`]/.test(text)) return undefined;
	try {
		return JSON.parse(text.replace(/^`|`$/g, '"')) as string;
	} catch {
		return text.slice(1, -1);
	}
}

/**
 * The module a `vi.mock`/`vi.doMock` call names: a string, a template with no
 * substitution, or vitest's typed `import("…")` form. Anything else (a
 * variable, a computed template) is unreadable and returns `undefined`, which
 * every caller treats as unknown and fails closed on: the flake-shape scan
 * counts it as an in-process mock, and the project-trust seam ratchet reports
 * it as an unclassified spelling (#4429).
 */
export function mockSpecifier(arg: SgNode | undefined): string | undefined {
	if (!arg) return undefined;
	const node = unwrapParens(arg);
	if (node.kind() === "string") return unquote(node.text());
	if (node.kind() === "template_string") {
		return node
			.children()
			.some((child) => child.kind() === "template_substitution")
			? undefined
			: unquote(node.text());
	}
	if (
		node.kind() === "call_expression" &&
		node.field("function")?.kind() === "import"
	) {
		return mockSpecifier(node.field("arguments")?.namedChildren()[0]);
	}
	return undefined;
}

/**
 * Vitest's utils object. Vitest hoists `vitest.mock` exactly like `vi.mock`
 * (`utilsObjectNames = ["vi", "vitest"]` in `@vitest/mocker`'s hoister), so
 * both names are the object, as globals or imported from `"vitest"`.
 */
const VITEST_UTILS: ReadonlySet<string> = new Set(["vi", "vitest"]);

/**
 * Vitest's module-double registrations: `mock` is hoisted, `doMock` is its
 * un-hoisted twin (`registerConsoleMockers` in `@vitest/mocker` exposes both
 * on the utils object), and both take the same `(specifier, factory)` shape,
 * so a whole-module `doMock` double drops a production export exactly the way
 * a `mock` double does. #5256: the export gate read only `mock`, so the
 * `vi.doMock` of `clients/env-utils.js` in `tests/clients/lsp/launch.test.ts`
 * stayed green while the Windows unit lane threw on the export a static
 * `clients/safe-spawn.ts` import needed. `doUnmock` is excluded: it names no
 * factory, so it replaces no export surface.
 */
const MOCK_REGISTRATION_NAMES: readonly string[] = ["mock", "doMock"];

/**
 * Semantic mock-call check: the callee is one of `names` on vitest's utils
 * object written directly, `vi` or `vitest` (through parentheses, `as`,
 * `satisfies` or `!`), with a dot, spaced or literal bracket key
 * (`vi["mock"]`, a `subscript_expression`). Checking
 * `callee.text() === "vi.mock"` enumerates one surface spelling and misses
 * the others (shape 34). It follows no values (an alias, a destructure, a
 * helper's parameter): the fail-closed consumer, the project-trust seam
 * ratchet, keys on the mocked specifier instead (#4429 round 3). It reads
 * the callee alone, so a caller looping over every call pays no per-file
 * cost (#4457 review F8). `names` defaults to `["mock"]`, so the
 * whole-module export gate keeps its existing population; a caller that
 * also owns the non-hoisted `vi.doMock` passes both names.
 */
export function isViMockCall(
	callee: SgNode | undefined | null,
	names: readonly string[] = ["mock"],
): boolean {
	if (!callee) return false;
	const node = unwrapExpression(callee);
	const member = node.kind() === "member_expression";
	if (!member && node.kind() !== "subscript_expression") return false;
	const object = node.field("object");
	if (!object) return false;
	const owner = unwrapExpression(object);
	if (owner.kind() !== "identifier" || !VITEST_UTILS.has(owner.text()))
		return false;
	const key = node.field(member ? "property" : "index") ?? undefined;
	const name =
		key?.kind() === "property_identifier" ? key.text() : mockSpecifier(key);
	return name !== undefined && names.includes(name);
}

function objectReturns(factory: SgNode): SgNode | undefined {
	let body = factory.field("body");
	if (body) body = unwrapParens(body);
	if (body?.kind() === "object") return body;
	if (body?.kind() !== "statement_block") return undefined;
	const returned = factory.findAll({ rule: { kind: "return_statement" } });
	for (const statement of returned) {
		const expression = statement.children().find((child) => child.isNamed());
		if (expression?.kind() === "object") return expression;
	}
	return undefined;
}

/**
 * Strip `as`/`satisfies` casts and non-null assertions down to the awaited
 * call, reusing the shared `unwrapParens` (parens) and `namedParts`
 * (comment-filtered first child) seams instead of a local loop. A comment is
 * a named child in this grammar, so `await // why\n f()` would otherwise
 * resolve its operand to the comment. `bareIdentifier` (imported) answers
 * the leaf "which binding" question; this answers the structural one, which
 * a text-only helper cannot carry because the zero-argument and await
 * requirements live on the nodes it returns.
 */
export function unwrapExpression(node: SgNode): SgNode {
	let current = unwrapParens(node);
	while (
		current?.kind() === "as_expression" ||
		current?.kind() === "satisfies_expression" ||
		current?.kind() === "non_null_expression"
	) {
		const inner = namedParts(current)[0];
		if (!inner) break;
		current = unwrapParens(inner);
	}
	return current;
}

/**
 * The tree-sitter TypeScript grammar misparses
 * `await importOriginal<typeof import("…")>()` as `<`/`>` binary
 * comparisons (`await_expression(await importOriginal)` beside a `typeof`
 * unary, with `as`/`satisfies` folded into the same binary chain as bare
 * identifiers), so no `call_expression` exists for it. The structural proof
 * has two halves: the left spine of those binaries ends at the awaited
 * binding with at least one real `<` operator on the way down (a bare
 * `...(await importOriginal)` written literally spreads the factory function
 * itself, so the `<` level is required, not optional), AND the trailing call
 * parentheses prove themselves through the grammar's own error recovery —
 * the `>()` the parser cannot place lands in an `ERROR` node wrapping an
 * empty `formal_parameters`. A value argument (`…>("./other.js")`) parses
 * cleanly with no `ERROR`, and a missing call (`…<typeof …>` with no `()`)
 * recovers as a bare `>` with no parameters, so both reject exactly like
 * the no-argument form rejects `importOriginal("./other.js")`. The proof is
 * read off `proofScope` — the spread element or the enclosing declaration —
 * never off the unwrapped spine, which drops the `ERROR` sibling when it
 * descends to the binary.
 */
function isMisparsedGenericAwait(
	node: SgNode,
	bindings: Set<string>,
	proofScope: SgNode,
): boolean {
	let current = node;
	let sawComparison = false;
	while (current.kind() === "binary_expression") {
		if (
			current
				.children()
				.some((child) => !child.isNamed() && child.text() === "<")
		)
			sawComparison = true;
		const left = namedParts(current)[0];
		if (!left) return false;
		current = unwrapParens(left);
	}
	if (!sawComparison || current.kind() !== "await_expression") return false;
	const awaitedOperand = namedParts(current)[0];
	if (!awaitedOperand) return false;
	const operand = unwrapExpression(awaitedOperand);
	if (
		!operand ||
		operand.kind() !== "identifier" ||
		!bindings.has(operand.text())
	)
		return false;
	return proofScope
		.findAll({ rule: { kind: "ERROR" } })
		.some((error) =>
			error
				.findAll({ rule: { kind: "formal_parameters" } })
				.some((parameters) => namedParts(parameters).length === 0),
		);
}

function isAwaitedBinding(
	node: SgNode,
	bindings: Set<string>,
	proofScope: SgNode = node,
): boolean {
	const unwrapped = unwrapExpression(node);
	if (unwrapped.kind() === "await_expression") {
		const operandNode = namedParts(unwrapped)[0];
		if (!operandNode) return false;
		const operand = unwrapExpression(operandNode);
		if (operand.kind() !== "call_expression") return false;
		const fn = operand.field("function");
		if (!fn || !bindings.has(bareIdentifier(fn) ?? "")) return false;
		return namedParts(operand.field("arguments")).length === 0;
	}
	if (unwrapped.kind() === "call_expression") {
		// `await f<T>()`: the grammar nests the await inside the callee.
		const callee = unwrapped.field("function");
		if (callee?.kind() !== "await_expression") return false;
		const awaitedOperand = namedParts(callee)[0];
		if (!awaitedOperand) return false;
		const inner = unwrapParens(awaitedOperand);
		return (
			bindings.has(bareIdentifier(inner) ?? "") &&
			namedParts(unwrapped.field("arguments")).length === 0
		);
	}
	if (unwrapped.kind() === "binary_expression") {
		return isMisparsedGenericAwait(unwrapped, bindings, proofScope);
	}
	return false;
}

/**
 * `await vi.importActual(spec)` / `await vi.importActual<T>(spec)` for the
 * SAME module the factory mocks (#4427 review F5): runtime-complete exactly
 * like the factory-parameter `importOriginal()`. Reuses `isViMockCall` for the
 * `vi` member match. The generic form arrives misparsed as
 * `(await vi.importActual) < typeof import(..) > (spec)` comparisons (the
 * `isMisparsedGenericAwait` grammar quirk), so that spine is read here too.
 * A spec that names another module is not a pass-through.
 */
function isAwaitedViImportActual(node: SgNode, specifier: string): boolean {
	const unwrapped = unwrapExpression(node);
	const sameModule = (argument: SgNode | undefined): boolean => {
		const text = argument ? unquote(argument.text()) : undefined;
		return text !== undefined && text === specifier;
	};
	if (unwrapped.kind() === "await_expression") {
		const call = namedParts(unwrapped)[0];
		const operand = call ? unwrapExpression(call) : undefined;
		if (operand?.kind() !== "call_expression") return false;
		if (!isViMockCall(operand.field("function"), ["importActual"]))
			return false;
		const args = namedParts(operand.field("arguments"));
		return args.length === 1 && sameModule(args[0]);
	}
	if (unwrapped.kind() !== "binary_expression") return false;
	// Left spine: ... < ... then the trailing `> (spec)`.
	let current = unwrapped;
	let sawComparison = false;
	let trailing: SgNode | undefined;
	while (current.kind() === "binary_expression") {
		const operator = current.children().find((child) => !child.isNamed());
		if (operator?.text() === "<") sawComparison = true;
		if (operator?.text() === ">" && !trailing)
			trailing = namedParts(current).at(-1);
		const left = namedParts(current)[0];
		if (!left) return false;
		current = unwrapParens(left);
	}
	if (!sawComparison || !trailing || current.kind() !== "await_expression")
		return false;
	const awaited = namedParts(current)[0];
	if (!awaited || !isViMockCall(unwrapExpression(awaited), ["importActual"]))
		return false;
	if (trailing.kind() !== "parenthesized_expression") return false;
	const spec = unwrapParens(trailing);
	return spec.kind() === "string" && sameModule(spec);
}

function isSameModulePassThrough(
	object: SgNode,
	factory: SgNode,
	specifier: string,
): boolean {
	const parameters = factory.field("parameters");
	const actualBindings = new Set(
		(parameters?.findAll({ rule: { kind: "identifier" } }) ?? [])
			.map((parameter) => parameter.text())
			.filter((name) => /^(?:importActual|importOriginal)$/.test(name)),
	);
	// Two-statement factories bind the awaited module first:
	// `const actual = await importOriginal<T>(); return { ...actual };`
	// Only the factory body's OWN top-level declarations qualify: a binding
	// with the same name inside a nested helper must not launder an
	// unrelated same-named spread in the returned object.
	const awaitedAliases = new Set<string>();
	const body = factory.field("body");
	if (body?.kind() === "statement_block") {
		for (const statement of namedParts(body)) {
			if (
				statement.kind() !== "lexical_declaration" &&
				statement.kind() !== "variable_declaration"
			)
				continue;
			for (const declarator of namedParts(statement)) {
				if (declarator.kind() !== "variable_declarator") continue;
				const name = declarator.field("name");
				const value = declarator.field("value");
				if (
					name?.kind() === "identifier" &&
					value &&
					(isAwaitedBinding(value, actualBindings, statement) ||
						isAwaitedViImportActual(value, specifier))
				)
					awaitedAliases.add(name.text());
			}
		}
	}
	return object.children().some((child) => {
		if (child.kind() !== "spread_element") return false;
		const content = namedParts(child)[0];
		if (!content) return false;
		if (
			isAwaitedBinding(content, actualBindings, child) ||
			isAwaitedViImportActual(content, specifier)
		)
			return true;
		const target = unwrapExpression(content);
		return target.kind() === "identifier" && awaitedAliases.has(target.text());
	});
}

function isSkippedSpecifier(specifier: string): boolean {
	return specifier.startsWith("node:") || /(?:\.mjs|\.d\.mts)$/.test(specifier);
}

/**
 * The #2281 latency target selector — the single source the sweep consumes.
 * A specifier selects the latency surface exactly when it ends with
 * `latency-logger.js`, regardless of how deep the relative path is. Tested in
 * both directions; the sweep must not re-derive this predicate inline.
 */
export function isLatencyLoggerSpecifier(specifier: string): boolean {
	return specifier.endsWith("latency-logger.js");
}

const LATENCY_ADMISSION_HEADER =
	/^[ \t]*\/\/[ \t]*latency-logger-mock:[ \t]*(.+)$/gm;

/**
 * A real `// latency-logger-mock: <reason>` comment, never a string literal.
 * Reuses `firstCommentMatch` (the same comment-vs-string discriminator the
 * `lsp-double` header uses) instead of a second raw-text match.
 */
export function latencyAdmissionHeader(source: string): string | undefined {
	return firstCommentMatch(source, LATENCY_ADMISSION_HEADER)?.[1].trim();
}

/**
 * Resolve an out-of-line `vi.mock` factory to the function that defines its
 * body. Inline arrows/functions return as-is; an identifier resolves to its
 * local `const`/`let`/`var` arrow/function value or to a top-level
 * `function` declaration. Anything else (imported binding, member access,
 * call result) returns `undefined` so the caller fails closed. This is the
 * semantic rule behind the #2959 round-1 MEDIUM fix: the question is "can the
 * returned property set be proven complete", never "which spelling defined
 * it".
 */
function resolveFactoryNode(factory: SgNode, root: SgNode): SgNode | undefined {
	if (
		factory.kind() === "arrow_function" ||
		factory.kind() === "function_expression" ||
		factory.kind() === "function_declaration"
	)
		return factory;
	if (factory.kind() !== "identifier") return undefined;
	const name = factory.text();
	for (const declarator of root.findAll({
		rule: { kind: "variable_declarator" },
	})) {
		const declName = declarator.field("name");
		const value = declarator.field("value");
		if (declName?.kind() === "identifier" && declName.text() === name) {
			if (
				value?.kind() === "arrow_function" ||
				value?.kind() === "function_expression"
			)
				return value;
			return undefined;
		}
	}
	for (const fn of root.findAll({ rule: { kind: "function_declaration" } })) {
		if (fn.field("name")?.text() === name) return fn;
	}
	return undefined;
}

function propertyNames(object: SgNode): Set<string> {
	const names = new Set<string>();
	for (const child of object.children()) {
		if (
			child.kind() !== "pair" &&
			child.kind() !== "shorthand_property_identifier"
		)
			continue;
		if (child.kind() === "pair") {
			const key = child.field("key");
			if (key) names.add(unquote(key.text()) ?? key.text());
		} else {
			names.add(child.text());
		}
	}
	return names;
}

function resolveProduction(
	testFile: string,
	specifier: string,
): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = path.resolve(path.dirname(testFile), specifier);
	const candidates = [
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.js$/, ".tsx"),
		path.join(base, "index.ts"),
	];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

function isProductionModule(file: string): boolean {
	return isProductionModulePath(path.relative(process.cwd(), file));
}

/**
 * The gate's verdict for one already-relative path: may the module it names
 * stand in for a production module?
 *
 * Synthetic detector fixtures live outside the checkout -- since #4867 under
 * `os.tmpdir()`, so they never sit at the checkout root #4864 guards -- and
 * are allowed to model production modules without pretending their paths are
 * repository roots. Inside the checkout only a source root qualifies.
 * `pathImpl` is a parameter so that a win32 drive pair can be driven on every
 * lane (AGENTS.md shape 35).
 */
export function isProductionModulePath(
	relative: string,
	pathImpl: Pick<typeof path, "isAbsolute" | "sep"> = path,
): boolean {
	// A path on another drive never turns into `../…`: win32 `path.relative`
	// leaves it absolute, so it is the same "outside" the `../` arm names
	// (#4878 F1: reading it as inside made every positive control assert `[]`
	// on the Windows lane).
	if (pathImpl.isAbsolute(relative)) return true;
	const posix = relative.replaceAll(pathImpl.sep, "/");
	if (posix.startsWith("../")) return true;
	return /^(?:clients|tools|mcp|scripts)(?:\/|$)/.test(posix);
}

function exportedValues(source: string): Set<string> {
	const root = parse(Lang.TypeScript, source).root();
	const names = new Set<string>();
	for (const statement of root.findAll({
		rule: { kind: "export_statement" },
	})) {
		for (const child of statement.namedChildren()) {
			if (
				child.kind() === "function_declaration" ||
				child.kind() === "class_declaration" ||
				child.kind() === "lexical_declaration"
			) {
				const name = child.field("name");
				if (name) names.add(name.text());
				for (const declarator of child.namedChildren()) {
					if (declarator.kind() !== "variable_declarator") continue;
					const declaratorName = declarator.field("name");
					if (declaratorName?.kind() === "identifier")
						names.add(declaratorName.text());
				}
			} else if (child.kind() === "export_clause") {
				for (const specifier of child.namedChildren()) {
					if (specifier.kind() !== "export_specifier") continue;
					const name = specifier.field("alias") ?? specifier.field("name");
					if (name) names.add(name.text());
				}
			}
		}
	}
	return names;
}

function importedValuesBySpecifier(root: SgNode): Map<string, Set<string>> {
	const all = new Map<string, Set<string>>();
	const namesFor = (specifier: string): Set<string> => {
		let names = all.get(specifier);
		if (!names) {
			names = new Set<string>();
			all.set(specifier, names);
		}
		return names;
	};
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		if (/^\s*import\s+type\b/.test(statement.text())) continue;
		const source = statement
			.namedChildren()
			.find((child) => child.kind() === "string");
		const specifier = source ? unquote(source.text()) : undefined;
		if (!source || specifier === undefined) continue;
		const names = namesFor(specifier);
		const clause = statement
			.namedChildren()
			.find((child) => child.kind() === "import_clause");
		for (const child of clause?.namedChildren() ?? []) {
			if (child.kind() === "named_imports") {
				for (const item of child.namedChildren()) {
					if (
						item.kind() === "import_specifier" &&
						!/^type\b/.test(item.text())
					) {
						const imported = item.field("name");
						if (imported) names.add(imported.text());
						continue;
					}
				}
			} else if (child.kind() === "namespace_import") {
				// A namespace object exposes every export. The caller expands this
				// marker against the mocked module's actual exports.
				names.add("*");
			} else if (child.kind() === "identifier") {
				names.add("default");
			}
		}
	}
	for (const importNode of root.findAll({ rule: { kind: "import" } })) {
		const call = importNode.parent();
		if (call?.kind() !== "call_expression") continue;
		const argument = call.field("arguments")?.namedChildren()[0];
		const specifier = argument ? unquote(argument.text()) : undefined;
		if (!argument || specifier === undefined) continue;
		const names = namesFor(specifier);
		const declarator = call.parent()?.parent();
		const binding =
			declarator?.kind() === "variable_declarator"
				? declarator.field("name")
				: undefined;
		if (binding?.kind() === "object_pattern") {
			for (const property of binding.namedChildren()) {
				if (property.kind() === "shorthand_property_identifier_pattern")
					names.add(property.text());
				else if (property.kind() === "pair") {
					const key = property.field("key");
					if (key) names.add(unquote(key.text()) ?? key.text());
				}
			}
		} else {
			names.add("*");
		}
	}
	return all;
}

interface ModuleImport {
	specifier: string;
	values: Set<string>;
	resolved: string | undefined;
}

const moduleImportCache = new Map<string, ModuleImport[]>();

/**
 * #3058: `exportedValues` was re-read and re-parsed once per `vi.mock` call
 * naming the module -- 781 parses of 133 MB of production source over the
 * 1,152-file sweep, against a few hundred distinct files. Memoised by path
 * the same way `moduleImportCache` above already memoises the import side;
 * every caller resolves a repository path or a `mkdtemp` fixture path, so a
 * key is never reused within a process.
 */
const exportedValuesCache = new Map<string, Set<string>>();

function exportedValuesOf(file: string): Set<string> {
	const cached = exportedValuesCache.get(file);
	if (cached) return cached;
	const values = exportedValues(fs.readFileSync(file, "utf8"));
	exportedValuesCache.set(file, values);
	return values;
}

function moduleImports(file: string, source?: string): ModuleImport[] {
	const cached = moduleImportCache.get(file);
	if (cached) return cached;
	const root = parse(
		Lang.TypeScript,
		source ?? fs.readFileSync(file, "utf8"),
	).root();
	const imports: ModuleImport[] = [];
	const valuesBySpecifier = importedValuesBySpecifier(root);
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		if (/^\s*import\s+type\b/.test(statement.text())) continue;
		const sourceNode = statement
			.namedChildren()
			.find((child) => child.kind() === "string");
		if (!sourceNode) continue;
		const specifier = unquote(sourceNode.text());
		if (!specifier || !specifier.startsWith(".")) continue;
		const resolved = resolveProduction(file, specifier);
		imports.push({
			specifier,
			values: new Set(valuesBySpecifier.get(specifier) ?? []),
			resolved: resolved && isProductionModule(resolved) ? resolved : undefined,
		});
	}
	for (const importNode of root.findAll({ rule: { kind: "import" } })) {
		const call = importNode.parent();
		if (call?.kind() !== "call_expression") continue;
		const argument = call.field("arguments")?.namedChildren()[0];
		const specifier = argument ? unquote(argument.text()) : undefined;
		if (!specifier || !specifier.startsWith(".")) continue;
		const resolved = resolveProduction(file, specifier);
		imports.push({
			specifier,
			values: new Set(valuesBySpecifier.get(specifier) ?? []),
			resolved: resolved && isProductionModule(resolved) ? resolved : undefined,
		});
	}
	moduleImportCache.set(file, imports);
	return imports;
}

/**
 * One parse, and one `call_expression` materialisation, per distinct source
 * text. The sweep runs the whole 1,152-file `tests/` population through the
 * detector twice -- once in `imported` mode, once in `all` mode for the
 * latency surface -- so each test file was parsed and its call expressions
 * materialised twice over (#3058). Keyed by SOURCE TEXT rather than path, so
 * a fixture that rewrites a path inside one process can never read back a
 * stale tree.
 */
const parsedSourceCache = new Map<string, { root: SgNode; calls: SgNode[] }>();

function parsedSource(source: string): { root: SgNode; calls: SgNode[] } {
	const cached = parsedSourceCache.get(source);
	if (cached) return cached;
	const root = parse(Lang.TypeScript, source).root();
	// Only the mock registrations: `isViMockCall` is a pure function of the
	// callee, so the `imported` and `all` passes (and `mockedSpecifiers`) share
	// one answer per call instead of each re-walking every call expression. The
	// names cover `vi.mock` and the un-hoisted `vi.doMock` twin (#5256).
	const entry = {
		root,
		calls: root
			.findAll({ rule: { kind: "call_expression" } })
			.filter((call) =>
				isViMockCall(call.field("function"), MOCK_REGISTRATION_NAMES),
			),
	};
	parsedSourceCache.set(source, entry);
	return entry;
}

/**
 * Every specifier the test file mocks. A per-FILE fact, so it is computed
 * once from the call expressions `findViMockExportGaps` already materialised
 * and handed to `requiredValues`, which used to re-parse the whole test
 * source on every `vi.mock` occurrence (#3058).
 */
function mockedSpecifiers(calls: readonly SgNode[]): Set<string> {
	const specifiers = new Set<string>();
	for (const call of calls) {
		const mocked = call.field("arguments")?.namedChildren()[0];
		const mockedSpecifier = mockSpecifier(mocked);
		if (mockedSpecifier) specifiers.add(mockedSpecifier);
	}
	return specifiers;
}

function requiredValues(
	file: string,
	source: string,
	specifier: string,
	mocked: ReadonlySet<string>,
	options: ViMockExportOptions = {},
): Set<string> {
	const target = resolveProduction(file, specifier);
	const testImports = moduleImports(file, source);
	const names = new Set<string>();
	const add = (values: Set<string>) => {
		for (const name of values) names.add(name);
	};
	for (const imported of testImports) {
		if (imported.resolved === target) add(imported.values);
	}
	if (!target) return names;

	const maxDepth = options.importerDepth ?? Number.POSITIVE_INFINITY;
	const queue = testImports
		.filter((imported) => imported.resolved && !mocked.has(imported.specifier))
		.map((imported) => ({ file: imported.resolved as string, depth: 1 }));
	const visited = new Set<string>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || visited.has(current.file) || current.depth > maxDepth)
			continue;
		visited.add(current.file);
		for (const imported of moduleImports(current.file)) {
			if (imported.resolved === target) add(imported.values);
			if (imported.resolved && current.depth < maxDepth)
				queue.push({ file: imported.resolved, depth: current.depth + 1 });
		}
	}
	if (names.has("*")) return exportedValuesOf(target);
	return names;
}

export function findViMockExportGaps(
	file: string,
	source: string,
	mode: ViMockExportMode = "imported",
	options: ViMockExportOptions = {},
): ViMockExportFinding[] {
	const { root, calls } = parsedSource(source);
	let mockedOnce: Set<string> | undefined;
	const mocked = () => (mockedOnce ??= mockedSpecifiers(calls));
	const findings: ViMockExportFinding[] = [];
	for (const call of calls) {
		const args = call.field("arguments")?.namedChildren() ?? [];
		const specifier = mockSpecifier(args[0]);
		const rawFactory = args[1];
		if (!specifier || isSkippedSpecifier(specifier) || !rawFactory) continue;
		const factory = resolveFactoryNode(rawFactory, root);
		if (!factory) {
			const productionFile = resolveProduction(file, specifier);
			if (!productionFile) continue;
			const required =
				mode === "all"
					? exportedValuesOf(productionFile)
					: requiredValues(file, source, specifier, mocked(), options);
			if (required.size === 0) continue;
			findings.push({
				file,
				line: call.range().start.line + 1,
				specifier,
				productionFile,
				missing: [...required].sort(),
				factoryProperties: [],
			});
			continue;
		}
		const object = objectReturns(factory);
		if (!object || isSameModulePassThrough(object, factory, specifier))
			continue;
		const productionFile = resolveProduction(file, specifier);
		if (!productionFile) continue;
		const required =
			mode === "all"
				? exportedValuesOf(productionFile)
				: requiredValues(file, source, specifier, mocked(), options);
		if (required.size === 0) continue;
		const missing = [...required]
			.filter((name) => !propertyNames(object).has(name))
			.sort();
		if (missing.length > 0) {
			findings.push({
				file,
				line: call.range().start.line + 1,
				specifier,
				productionFile,
				missing,
				factoryProperties: [...propertyNames(object)].sort(),
			});
		}
	}
	return findings;
}

/**
 * The latency pipeline the sweep consumes: every `all`-mode gap whose
 * specifier selects the latency surface. The sweep calls this (never an
 * inline `endsWith` filter) so the discriminator lives in one tested place.
 */
export function findLatencyLoggerGapsForFile(
	file: string,
	source: string,
): ViMockExportFinding[] {
	return findViMockExportGaps(file, source, "all").filter((finding) =>
		isLatencyLoggerSpecifier(finding.specifier),
	);
}
