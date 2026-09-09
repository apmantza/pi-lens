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
}

export type ViMockExportMode = "imported" | "all";

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
					if (item.kind() === "import_specifier" && !/^type\b/.test(item.text())) {
						const imported = item.field("name");
						if (imported) names.add(imported.text());
						continue;
					}
				}
			} else if (child.kind() === "namespace_import") {
				const local = child.namedChildren()[0]?.text();
				if (!local) continue;
				for (const member of root.findAll({
					rule: { kind: "member_expression" },
				})) {
					if (member.field("object")?.text() !== local) continue;
					const property = member.field("property");
					if (property) names.add(property.text());
				}
			} else if (child.kind() === "identifier") {
				names.add("default");
			}
		}
	}
	return names;
}

function requiredValues(
	file: string,
	source: string,
	specifier: string,
): Set<string> {
	const root = parse(Lang.TypeScript, source).root();
	const names = importedValues(root, specifier);
	const target = resolveProduction(file, specifier);
	if (!target) return names;
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		if (/^\s*import\s+type\b/.test(statement.text())) continue;
		const moduleText = statement
			.namedChildren()
			.find((child) => child.kind() === "string");
		const importer = moduleText
			? resolveProduction(file, unquote(moduleText.text()) ?? "")
			: undefined;
		if (!importer) continue;
		const importerRoot = parse(
			Lang.TypeScript,
			fs.readFileSync(importer, "utf8"),
		).root();
		const relative = path
			.relative(path.dirname(importer), target)
			.replaceAll(path.sep, "/")
			.replace(/\.ts$/, ".js");
		const importerSpecifier = relative.startsWith(".")
			? relative
			: `./${relative}`;
		for (const name of importedValues(importerRoot, importerSpecifier))
			names.add(name);
	}
	return names;
}

export function findViMockExportGaps(
	file: string,
	source: string,
	mode: ViMockExportMode = "imported",
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
				: requiredValues(file, source, specifier);
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
			});
		}
	}
	return findings;
}
