/**
 * AST detector for partial whole-module `vi.mock` factories.
 *
 * #2272 and #2782 repeated the same failure: a production export was added,
 * but a test's object-literal mock silently dropped it. This detector only
 * accepts direct object-literal factory returns and treats an
 * `importActual`/`importOriginal` spread for the same specifier as complete.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";

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

function objectReturns(factory: SgNode): SgNode | undefined {
	let body = factory.field("body");
	while (body?.kind() === "parenthesized_expression") {
		body = body.namedChildren()[0];
	}
	if (body?.kind() === "object") return body;
	if (body?.kind() !== "statement_block") return undefined;
	const returned = factory.findAll({ rule: { kind: "return_statement" } });
	for (const statement of returned) {
		const expression = statement.children().find((child) => child.isNamed());
		if (expression?.kind() === "object") return expression;
	}
	return undefined;
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
	return object.children().some((child) => {
		if (child.kind() !== "spread_element") return false;
		return child.findAll({ rule: { kind: "call_expression" } }).some((call) => {
			const callee = call.field("function");
			const args = call.field("arguments")?.namedChildren() ?? [];
			return (
				callee?.kind() === "identifier" &&
				actualBindings.has(callee.text()) &&
				args.length === 0 &&
				/\bawait\s+/.test(child.text())
			);
		});
	});
}

function isSkippedSpecifier(specifier: string): boolean {
	return specifier.startsWith("node:") || /(?:\.mjs|\.d\.mts)$/.test(specifier);
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
		if (callee?.kind() !== "member_expression" || callee.text() !== "vi.mock")
			continue;
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
		if (callee?.kind() !== "member_expression" || callee.text() !== "vi.mock")
			continue;
		const args = call.field("arguments")?.namedChildren() ?? [];
		const specifier = args[0] ? unquote(args[0].text()) : undefined;
		const factory = args[1];
		if (
			!specifier ||
			isSkippedSpecifier(specifier) ||
			!factory ||
			(factory.kind() !== "arrow_function" &&
				factory.kind() !== "function_expression")
		)
			continue;
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
