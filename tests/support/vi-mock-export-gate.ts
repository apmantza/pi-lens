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

function unquote(text: string): string | undefined {
	if (!/^['"`]/.test(text)) return undefined;
	try {
		return JSON.parse(text.replace(/^`|`$/g, '"')) as string;
	} catch {
		return text.slice(1, -1);
	}
}

/**
 * Semantic `vi.mock` call check: the object must be `vi` and the property
 * must name `mock`, whether written dot (`vi.mock`), bracket
 * (`vi["mock"]` — a `subscript_expression`, not a `member_expression`), or
 * spaced (`vi . mock`). Checking `callee.text() === "vi.mock"` enumerates one
 * surface spelling and misses the others (shape 34); structural fields do
 * not.
 */
function isViMockCall(callee: SgNode | undefined | null): boolean {
	if (!callee) return false;
	if (callee.kind() === "member_expression") {
		if (callee.field("object")?.text() !== "vi") return false;
		const property = callee.field("property");
		if (!property) return false;
		if (property.kind() === "property_identifier")
			return property.text() === "mock";
		return unquote(property.text()) === "mock";
	}
	if (callee.kind() === "subscript_expression") {
		const named = callee.children().filter((child) => child.isNamed());
		if (named.length < 2 || named[0].text() !== "vi") return false;
		return unquote(named[1].text()) === "mock";
	}
	return false;
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
function unwrapExpression(node: SgNode): SgNode {
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

function isSameModulePassThrough(
	object: SgNode,
	factory: SgNode,
	_specifier: string,
): boolean {
	const parameters = factory.field("parameters");
	const actualBindings = new Set(
		(parameters?.findAll({ rule: { kind: "identifier" } }) ?? [])
			.map((parameter) => parameter.text())
			.filter((name) => /^(?:importActual|importOriginal)$/.test(name)),
	);
	if (actualBindings.size === 0) return false;
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
					isAwaitedBinding(value, actualBindings, statement)
				)
					awaitedAliases.add(name.text());
			}
		}
	}
	return object.children().some((child) => {
		if (child.kind() !== "spread_element") return false;
		const content = namedParts(child)[0];
		if (!content) return false;
		if (isAwaitedBinding(content, actualBindings, child)) return true;
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
	const relative = path.relative(process.cwd(), file).replaceAll(path.sep, "/");
	// Synthetic detector fixtures live outside the checkout and are allowed to
	// model production modules without pretending their paths are repository roots.
	return relative.startsWith("../")
		? true
		: relative.startsWith(".probe-vi-mock-")
			? true
			: /^(?:clients|tools|mcp|scripts)(?:\/|$)/.test(relative);
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

function importedValues(root: SgNode, specifier: string): Set<string> {
	const names = new Set<string>();
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		if (/^\s*import\s+type\b/.test(statement.text())) continue;
		const source = statement
			.namedChildren()
			.find((child) => child.kind() === "string");
		if (!source || unquote(source.text()) !== specifier) continue;
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
		if (!argument || unquote(argument.text()) !== specifier) continue;
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
	return names;
}

interface ModuleImport {
	specifier: string;
	values: Set<string>;
	resolved: string | undefined;
}

const moduleImportCache = new Map<string, ModuleImport[]>();

function moduleImports(file: string, source?: string): ModuleImport[] {
	const cached = moduleImportCache.get(file);
	if (cached) return cached;
	const root = parse(
		Lang.TypeScript,
		source ?? fs.readFileSync(file, "utf8"),
	).root();
	const imports: ModuleImport[] = [];
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
			values: importedValues(root, specifier),
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
			values: importedValues(root, specifier),
			resolved: resolved && isProductionModule(resolved) ? resolved : undefined,
		});
	}
	moduleImportCache.set(file, imports);
	return imports;
}

function requiredValues(
	file: string,
	source: string,
	specifier: string,
	options: ViMockExportOptions = {},
): Set<string> {
	const target = resolveProduction(file, specifier);
	const testImports = moduleImports(file, source);
	const testRoot = parse(Lang.TypeScript, source).root();
	const mockedSpecifiers = new Set<string>();
	for (const call of testRoot.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (!isViMockCall(callee)) continue;
		const mocked = call.field("arguments")?.namedChildren()[0];
		const mockedSpecifier = mocked ? unquote(mocked.text()) : undefined;
		if (mockedSpecifier) mockedSpecifiers.add(mockedSpecifier);
	}
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
		.filter(
			(imported) =>
				imported.resolved && !mockedSpecifiers.has(imported.specifier),
		)
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
	if (names.has("*")) return exportedValues(fs.readFileSync(target, "utf8"));
	return names;
}

export function findViMockExportGaps(
	file: string,
	source: string,
	mode: ViMockExportMode = "imported",
	options: ViMockExportOptions = {},
): ViMockExportFinding[] {
	const root = parse(Lang.TypeScript, source).root();
	const findings: ViMockExportFinding[] = [];
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (!isViMockCall(callee)) continue;
		const args = call.field("arguments")?.namedChildren() ?? [];
		const specifier = args[0] ? unquote(args[0].text()) : undefined;
		const rawFactory = args[1];
		if (!specifier || isSkippedSpecifier(specifier) || !rawFactory) continue;
		const factory = resolveFactoryNode(rawFactory, root);
		if (!factory) {
			const productionFile = resolveProduction(file, specifier);
			if (!productionFile) continue;
			const required =
				mode === "all"
					? exportedValues(fs.readFileSync(productionFile, "utf8"))
					: requiredValues(file, source, specifier, options);
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
				? exportedValues(fs.readFileSync(productionFile, "utf8"))
				: requiredValues(file, source, specifier, options);
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
