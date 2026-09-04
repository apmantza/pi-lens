/**
 * Conservative Python import provenance for tree-sitter post-filters.
 *
 * This is intentionally not a Python name resolver. It proves only a small,
 * direct module-level import vocabulary, and rejects every ambiguous binding.
 */
export interface PythonSyntaxNode {
	type: string;
	text: string;
	startIndex: number;
	endIndex: number;
	parent?: PythonSyntaxNode | null;
	children?: PythonSyntaxNode[];
	isNamed?: boolean;
	hasError?: boolean;
	childForFieldName?: (field: string) => PythonSyntaxNode | null;
}

type PythonProvenance =
	| "sqlalchemy-session"
	| "psycopg-package"
	| "psycopg-sql-module"
	| "psycopg-sql-constructor"
	| "psycopg-identifier-constructor";

interface EligibleImport {
	name: string;
	provenance: PythonProvenance;
	endIndex: number;
}

interface FunctionSummary {
	parameterAnnotations: ReadonlyMap<string, string>;
	bindingCounts: ReadonlyMap<string, number>;
}

export interface PythonProvenanceSummary {
	readonly invalid: boolean;
	provenanceFor(
		name: string,
		reference: PythonSyntaxNode,
	): PythonProvenance | null;
	isSqlAlchemySessionReceiver(receiver: PythonSyntaxNode): boolean;
}

const SUMMARY_BY_ROOT = new WeakMap<
	PythonSyntaxNode,
	PythonProvenanceSummary
>();
const TRAVERSAL_VISIT_CAP = 50_000;
const TRAVERSAL_DEPTH_CAP = 128;
const EXPRESSION_DEPTH_CAP = 8;
const ANCESTOR_DEPTH_CAP = 64;

const PSYCOPG_MODULES = new Set(["psycopg", "psycopg2"]);
const PSYCOPG_SQL_MODULES = new Set(["psycopg.sql", "psycopg2.sql"]);

function nodeKey(node: PythonSyntaxNode): string {
	return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

function namedChildren(node: PythonSyntaxNode): PythonSyntaxNode[] {
	return (node.children ?? []).filter((child) => child.isNamed);
}

function directNamedChild(
	node: PythonSyntaxNode,
	type: string,
): PythonSyntaxNode | undefined {
	return namedChildren(node).find((child) => child.type === type);
}

/** Extract only identifiers in Python binding positions. */
function bindingTargetNames(node: PythonSyntaxNode | undefined): {
	names: string[];
	unknown: boolean;
} {
	if (!node) return { names: [], unknown: true };
	const names: string[] = [];
	const stack = [node];
	let unknown = false;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		if (current.type === "identifier") {
			if (current.text !== "_") names.push(current.text);
			continue;
		}
		// These contain references, never binding positions.
		if (current.type === "attribute" || current.type === "subscript") continue;
		if (
			current.type === "tuple" ||
			current.type === "pattern_list" ||
			current.type === "list" ||
			current.type === "list_pattern" ||
			current.type === "tuple_pattern" ||
			current.type === "starred_expression" ||
			current.type === "list_splat_pattern" ||
			current.type === "dictionary_splat_pattern"
		) {
			stack.push(...namedChildren(current));
			continue;
		}
		unknown = true;
	}
	return { names, unknown };
}

function asPatternTargetNames(node: PythonSyntaxNode): {
	names: string[];
	unknown: boolean;
} {
	const names: string[] = [];
	let unknown = false;
	const stack = [node];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		if (current.type === "as_pattern_target") {
			const extracted = bindingTargetNames(namedChildren(current)[0]);
			names.push(...extracted.names);
			unknown ||= extracted.unknown;
			continue;
		}
		stack.push(...namedChildren(current));
	}
	return { names, unknown };
}

function bindingPatternNames(node: PythonSyntaxNode | undefined): {
	names: string[];
	unknown: boolean;
} {
	if (!node) return { names: [], unknown: true };
	const names: string[] = [];
	const stack = [node];
	let unknown = false;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		if (current.type === "identifier") {
			if (current.text !== "_") names.push(current.text);
			continue;
		}
		if (current.type === "dotted_name") {
			if (!current.text.includes(".") && current.text !== "_") {
				names.push(current.text);
			}
			continue;
		}
		if (current.type === "attribute") continue;
		if (current.type === "keyword_pattern") {
			// The first named child is the keyword field; only its value pattern
			// may introduce captures (`Wrapper(field=capture)`).
			const value = namedChildren(current).slice(1);
			if (value.length !== 1) {
				unknown = true;
			} else {
				stack.push(value[0]!);
			}
			continue;
		}
		if (
			current.type === "case_pattern" ||
			current.type === "as_pattern" ||
			current.type === "union_pattern" ||
			current.type === "list_pattern" ||
			current.type === "tuple_pattern" ||
			current.type === "list_splat_pattern" ||
			current.type === "dictionary_splat_pattern" ||
			current.type === "class_pattern"
		) {
			for (const child of namedChildren(current)) stack.push(child);
			continue;
		}
		if (current.type === "as_pattern_target") {
			const target = bindingTargetNames(current);
			names.push(...target.names);
			unknown ||= target.unknown;
			continue;
		}
		unknown = true;
	}
	return { names, unknown };
}

function importedNames(node: PythonSyntaxNode): {
	names: string[];
	unknown: boolean;
	star: boolean;
} {
	const children = namedChildren(node);
	const names: string[] = [];
	let unknown = false;
	let star = node.text.includes("*");
	if (node.type === "import_from_statement") {
		for (const part of children.slice(1)) {
			if (part.type === "aliased_import") {
				const alias = namedChildren(part).at(-1);
				if (alias?.type === "identifier") names.push(alias.text);
				else unknown = true;
			} else if (part.type === "dotted_name" || part.type === "identifier") {
				names.push(part.text);
			} else {
				unknown = true;
			}
		}
	} else if (node.type === "import_statement") {
		for (const part of children) {
			if (part.type === "aliased_import") {
				const alias = namedChildren(part).at(-1);
				if (alias?.type === "identifier") names.push(alias.text);
				else unknown = true;
			} else if (part.type === "dotted_name" || part.type === "identifier") {
				names.push(part.text.split(".")[0]!);
			} else {
				unknown = true;
			}
		}
	} else {
		unknown = true;
	}
	return { names, unknown, star };
}

function eligibleImports(node: PythonSyntaxNode): EligibleImport[] {
	const children = namedChildren(node);
	const candidates: EligibleImport[] = [];
	if (node.type === "import_from_statement") {
		const moduleName = children[0]?.text;
		for (const part of children.slice(1)) {
			const source =
				part.type === "aliased_import"
					? namedChildren(part)[0]?.text
					: part.text;
			const local =
				part.type === "aliased_import"
					? namedChildren(part).at(-1)?.text
					: source;
			if (!source || !local) continue;
			let provenance: PythonProvenance | undefined;
			if (moduleName === "sqlalchemy.orm" && source === "Session") {
				provenance = "sqlalchemy-session";
			} else if (PSYCOPG_MODULES.has(moduleName ?? "") && source === "sql") {
				provenance = "psycopg-sql-module";
			} else if (
				PSYCOPG_SQL_MODULES.has(moduleName ?? "") &&
				source === "SQL"
			) {
				provenance = "psycopg-sql-constructor";
			} else if (
				PSYCOPG_SQL_MODULES.has(moduleName ?? "") &&
				source === "Identifier"
			) {
				provenance = "psycopg-identifier-constructor";
			}
			if (provenance)
				candidates.push({ name: local, provenance, endIndex: node.endIndex });
		}
	} else if (node.type === "import_statement") {
		for (const part of children) {
			const moduleName =
				part.type === "aliased_import"
					? namedChildren(part)[0]?.text
					: part.text;
			const local =
				part.type === "aliased_import"
					? namedChildren(part).at(-1)?.text
					: moduleName?.split(".")[0];
			if (moduleName && local && PSYCOPG_MODULES.has(moduleName)) {
				candidates.push({
					name: local,
					provenance: "psycopg-package",
					endIndex: node.endIndex,
				});
			}
		}
	}
	return candidates;
}

function directAnnotationName(parameter: PythonSyntaxNode): string | undefined {
	if (parameter.type !== "typed_parameter") return undefined;
	const type = directNamedChild(parameter, "type");
	const children = type ? namedChildren(type) : [];
	return children.length === 1 && children[0]?.type === "identifier"
		? children[0].text
		: undefined;
}

function parameterName(parameter: PythonSyntaxNode): string | undefined {
	if (parameter.type === "identifier") return parameter.text;
	return directNamedChild(parameter, "identifier")?.text;
}

class Summary implements PythonProvenanceSummary {
	readonly invalid: boolean;
	private readonly imports: ReadonlyMap<string, EligibleImport>;
	private readonly tainted: ReadonlySet<string>;
	private readonly functions: ReadonlyMap<string, FunctionSummary>;

	constructor(root: PythonSyntaxNode) {
		const imports = new Map<string, EligibleImport>();
		const bindingCounts = new Map<string, number>();
		const functionBindings = new Map<string, Map<string, number>>();
		const functionAnnotations = new Map<string, Map<string, string>>();
		let invalid = false;
		let visits = 0;

		const addBinding = (name: string, activeFunctions: PythonSyntaxNode[]) => {
			bindingCounts.set(name, (bindingCounts.get(name) ?? 0) + 1);
			for (const fn of activeFunctions) {
				const bindings =
					functionBindings.get(nodeKey(fn)) ?? new Map<string, number>();
				bindings.set(name, (bindings.get(name) ?? 0) + 1);
				functionBindings.set(nodeKey(fn), bindings);
			}
		};
		const addTarget = (
			target: PythonSyntaxNode | undefined,
			functions: PythonSyntaxNode[],
		) => {
			const extracted = bindingTargetNames(target);
			invalid ||= extracted.unknown;
			for (const name of extracted.names) addBinding(name, functions);
		};
		const visit = (
			node: PythonSyntaxNode,
			depth: number,
			moduleDirect: boolean,
			activeFunctions: PythonSyntaxNode[],
		): void => {
			if (++visits > TRAVERSAL_VISIT_CAP || depth > TRAVERSAL_DEPTH_CAP) {
				invalid = true;
				return;
			}
			if (node.hasError || node.type === "ERROR" || node.type === "MISSING") {
				invalid = true;
				return;
			}
			const functions =
				node.type === "function_definition"
					? [...activeFunctions, node]
					: activeFunctions;
			if (node.type === "function_definition") {
				const annotations = new Map<string, string>();
				const parameters = directNamedChild(node, "parameters");
				for (const parameter of namedChildren(parameters ?? node)) {
					const name = parameterName(parameter);
					if (!name) {
						if (parameter.type !== "list_splat_pattern") invalid = true;
						continue;
					}
					addBinding(name, functions);
					const annotation = directAnnotationName(parameter);
					if (annotation) annotations.set(name, annotation);
				}
				functionAnnotations.set(nodeKey(node), annotations);
			}
			if (node.type === "lambda") {
				const params = directNamedChild(node, "lambda_parameters");
				for (const parameter of namedChildren(params ?? node)) {
					const name = parameterName(parameter);
					if (name) addBinding(name, functions);
					else invalid = true;
				}
			}
			if (
				node.type === "import_from_statement" ||
				node.type === "import_statement"
			) {
				const imported = importedNames(node);
				invalid ||= imported.unknown || imported.star;
				for (const name of imported.names) addBinding(name, functions);
				if (moduleDirect) {
					for (const candidate of eligibleImports(node))
						imports.set(candidate.name, candidate);
				}
			}
			if (
				node.type === "assignment" ||
				node.type === "augmented_assignment" ||
				node.type === "named_expression"
			) {
				addTarget(
					node.childForFieldName?.("left") ?? namedChildren(node)[0],
					functions,
				);
			}
			if (node.type === "for_statement" || node.type === "for_in_clause") {
				addTarget(
					node.childForFieldName?.("left") ?? namedChildren(node)[0],
					functions,
				);
			}
			if (
				node.type === "with_item" ||
				node.type === "except_clause" ||
				node.type === "except_group_clause"
			) {
				const extracted = asPatternTargetNames(node);
				invalid ||= extracted.unknown;
				for (const name of extracted.names) addBinding(name, functions);
			}
			if (node.type === "delete_statement") {
				for (const child of namedChildren(node)) addTarget(child, functions);
			}
			if (node.type === "case_clause") {
				const extracted = bindingPatternNames(
					directNamedChild(node, "case_pattern"),
				);
				invalid ||= extracted.unknown;
				for (const name of extracted.names) addBinding(name, functions);
			}
			if (
				node.type === "function_definition" ||
				node.type === "class_definition"
			) {
				const name = directNamedChild(node, "identifier")?.text;
				if (name) addBinding(name, activeFunctions);
				else invalid = true;
			}
			if (node.type === "type_alias_statement") {
				const name = directNamedChild(node, "type")?.children?.find(
					(child) => child.type === "identifier",
				)?.text;
				if (name) addBinding(name, functions);
				else invalid = true;
			}
			if (
				node.type === "global_statement" ||
				node.type === "nonlocal_statement"
			) {
				for (const child of namedChildren(node))
					addBinding(child.text, functions);
			}
			if (
				node.type === "type_parameter" ||
				node.type === "type_parameter_list"
			) {
				for (const child of namedChildren(node)) {
					if (child.type === "identifier") addBinding(child.text, functions);
				}
			}
			if (node.type === "call") {
				const callee =
					node.childForFieldName?.("function") ?? namedChildren(node)[0];
				if (
					callee?.type === "identifier" &&
					["exec", "eval", "globals", "locals", "vars"].includes(callee.text)
				) {
					invalid = true;
				}
			}
			for (const child of node.children ?? []) {
				visit(child, depth + 1, node === root, functions);
			}
		};
		visit(root, 0, false, []);

		const tainted = new Set<string>();
		for (const [name, count] of bindingCounts) {
			if (count !== 1 || !imports.has(name)) tainted.add(name);
		}
		for (const name of imports.keys()) {
			if ((bindingCounts.get(name) ?? 0) !== 1) tainted.add(name);
		}
		this.invalid = invalid;
		this.imports = imports;
		this.tainted = tainted;
		this.functions = new Map(
			[...functionAnnotations.entries()].map(([key, annotations]) => [
				key,
				{
					parameterAnnotations: annotations,
					bindingCounts: functionBindings.get(key) ?? new Map(),
				},
			]),
		);
	}

	provenanceFor(
		name: string,
		reference: PythonSyntaxNode,
	): PythonProvenance | null {
		if (this.invalid || this.tainted.has(name)) return null;
		const candidate = this.imports.get(name);
		return candidate && candidate.endIndex <= reference.startIndex
			? candidate.provenance
			: null;
	}

	isSqlAlchemySessionReceiver(receiver: PythonSyntaxNode): boolean {
		if (this.invalid || receiver.type !== "identifier") return false;
		let current: PythonSyntaxNode | null | undefined = receiver.parent;
		for (let depth = 0; current && depth < ANCESTOR_DEPTH_CAP; depth++) {
			if (current.type === "function_definition") {
				const summary = this.functions.get(nodeKey(current));
				if (!summary) return false;
				const annotation = summary.parameterAnnotations.get(receiver.text);
				return (
					annotation !== undefined &&
					(summary.bindingCounts.get(receiver.text) ?? 0) === 1 &&
					this.provenanceFor(annotation, receiver) === "sqlalchemy-session"
				);
			}
			current = current.parent;
		}
		return false;
	}
}

export function getPythonProvenanceSummary(
	root: PythonSyntaxNode,
): PythonProvenanceSummary {
	const cached = SUMMARY_BY_ROOT.get(root);
	if (cached) return cached;
	const summary = new Summary(root);
	SUMMARY_BY_ROOT.set(root, summary);
	return summary;
}

function expressionProvenance(
	node: PythonSyntaxNode | undefined,
	summary: PythonProvenanceSummary,
	depth = 0,
): PythonProvenance | null {
	if (!node || depth > EXPRESSION_DEPTH_CAP) return null;
	if (node.type === "identifier") return summary.provenanceFor(node.text, node);
	if (node.type !== "attribute") return null;
	const object = node.childForFieldName?.("object") ?? namedChildren(node)[0];
	const attribute =
		node.childForFieldName?.("attribute") ?? namedChildren(node).at(-1);
	const provenance = expressionProvenance(object, summary, depth + 1);
	if (provenance === "psycopg-package" && attribute?.text === "sql") {
		return "psycopg-sql-module";
	}
	if (provenance === "psycopg-sql-module") {
		if (attribute?.text === "SQL") return "psycopg-sql-constructor";
		if (attribute?.text === "Identifier")
			return "psycopg-identifier-constructor";
	}
	return null;
}

/** Exact static SQL(...).format(Identifier(...), ...) proof. */
export function isSafePsycopgIdentifierComposition(
	node: PythonSyntaxNode | undefined,
	root: PythonSyntaxNode | undefined,
): boolean {
	if (!node || node.type !== "call" || !root) return false;
	const summary = getPythonProvenanceSummary(root);
	if (summary.invalid) return false;
	const formatCallee =
		node.childForFieldName?.("function") ?? namedChildren(node)[0];
	if (formatCallee?.type !== "attribute") return false;
	const formatChildren = namedChildren(formatCallee);
	const formatName = formatChildren.find((child) => child.text === "format");
	const sqlConstructor = formatChildren.find((child) => child.type === "call");
	if (!formatName || !sqlConstructor) return false;
	const constructorCallee =
		sqlConstructor.childForFieldName?.("function") ??
		namedChildren(sqlConstructor)[0];
	if (
		expressionProvenance(constructorCallee, summary) !==
		"psycopg-sql-constructor"
	)
		return false;
	const templateArgs = namedChildren(
		directNamedChild(sqlConstructor, "argument_list") ?? sqlConstructor,
	).filter((child) => child.type !== "comment");
	if (
		templateArgs.length !== 1 ||
		templateArgs[0]?.type !== "string" ||
		namedChildren(templateArgs[0]).some(
			(child) => child.type === "interpolation",
		)
	)
		return false;
	const formatArgs = namedChildren(
		directNamedChild(node, "argument_list") ?? node,
	).filter((child) => child.type !== "comment");
	if (formatArgs.length === 0) return false;
	return formatArgs.every((argument) => {
		if (argument.type !== "call") return false;
		const callee =
			argument.childForFieldName?.("function") ?? namedChildren(argument)[0];
		return (
			expressionProvenance(callee, summary) === "psycopg-identifier-constructor"
		);
	});
}

export function isProvenSqlAlchemySessionReceiver(
	receiver: PythonSyntaxNode | undefined,
	root: PythonSyntaxNode | undefined,
): boolean {
	return (
		!!receiver &&
		!!root &&
		getPythonProvenanceSummary(root).isSqlAlchemySessionReceiver(receiver)
	);
}
