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

interface ParsedImportBinding {
	source: string;
	local: string;
}

interface ParsedImportStatement {
	kind: "from" | "plain" | "unknown";
	moduleName: string | undefined;
	bindings: ParsedImportBinding[];
	unknown: boolean;
	star: boolean;
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

const FROM_IMPORT_PROVENANCE = new Map<string, PythonProvenance>([
	["sqlalchemy.orm:Session", "sqlalchemy-session"],
	["psycopg:sql", "psycopg-sql-module"],
	["psycopg2:sql", "psycopg-sql-module"],
	["psycopg.sql:SQL", "psycopg-sql-constructor"],
	["psycopg2.sql:SQL", "psycopg-sql-constructor"],
	["psycopg.sql:Identifier", "psycopg-identifier-constructor"],
	["psycopg2.sql:Identifier", "psycopg-identifier-constructor"],
]);
const PLAIN_PACKAGE_PROVENANCE = new Map<string, PythonProvenance>([
	["psycopg", "psycopg-package"],
	["psycopg2", "psycopg-package"],
]);

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

type BindingNameClassifier = (node: PythonSyntaxNode) => BindingNameDecision;

type BindingNameDecision =
	| { kind: "record" }
	| { kind: "stop" }
	| { kind: "unknown" }
	| { kind: "descend"; children: PythonSyntaxNode[] }
	| {
			kind: "delegate";
			node: PythonSyntaxNode | undefined;
			classifier: BindingNameClassifier;
	  };

const BINDING_TARGET_CONTAINER_TYPES = new Set([
	"tuple",
	"pattern_list",
	"list",
	"list_pattern",
	"tuple_pattern",
	"starred_expression",
	"list_splat_pattern",
	"dictionary_splat_pattern",
]);
const BINDING_TARGET_REFERENCE_TYPES = new Set(["attribute", "subscript"]);
const BINDING_PATTERN_CONTAINER_TYPES = new Set([
	"case_pattern",
	"as_pattern",
	"union_pattern",
	"list_pattern",
	"tuple_pattern",
	"list_splat_pattern",
	"dictionary_splat_pattern",
	"class_pattern",
]);
const BINDING_PATTERN_REFERENCE_TYPES = new Set([
	"attribute",
	"qualified_pattern",
]);

function collectBindingNames(
	root: PythonSyntaxNode | undefined,
	classifier: BindingNameClassifier,
): { names: string[]; unknown: boolean } {
	if (!root) return { names: [], unknown: true };
	const names: string[] = [];
	const stack: Array<{
		node: PythonSyntaxNode;
		classifier: BindingNameClassifier;
	}> = [{ node: root, classifier }];
	let unknown = false;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		const decision = current.classifier(current.node);
		if (decision.kind === "record") {
			if (current.node.text !== "_") names.push(current.node.text);
			continue;
		}
		if (decision.kind === "stop") continue;
		if (decision.kind === "unknown") {
			unknown = true;
			continue;
		}
		if (decision.kind === "descend") {
			for (const child of decision.children) {
				stack.push({ node: child, classifier: current.classifier });
			}
			continue;
		}
		if (!decision.node) {
			unknown = true;
			continue;
		}
		stack.push({
			node: decision.node,
			classifier: decision.classifier,
		});
	}
	return { names, unknown };
}

function classifyBindingTarget(node: PythonSyntaxNode): BindingNameDecision {
	if (node.type === "identifier") return { kind: "record" };
	// These contain references, never binding positions.
	if (BINDING_TARGET_REFERENCE_TYPES.has(node.type)) return { kind: "stop" };
	if (BINDING_TARGET_CONTAINER_TYPES.has(node.type)) {
		return { kind: "descend", children: namedChildren(node) };
	}
	return { kind: "unknown" };
}

function classifyAsPatternTarget(node: PythonSyntaxNode): BindingNameDecision {
	if (node.type === "as_pattern_target") {
		return {
			kind: "delegate",
			node: namedChildren(node)[0],
			classifier: classifyBindingTarget,
		};
	}
	return { kind: "descend", children: namedChildren(node) };
}

function classifyBindingPattern(node: PythonSyntaxNode): BindingNameDecision {
	if (node.type === "identifier") return { kind: "record" };
	if (node.type === "dotted_name") {
		return node.text.includes(".") ? { kind: "stop" } : { kind: "record" };
	}
	if (BINDING_PATTERN_REFERENCE_TYPES.has(node.type)) return { kind: "stop" };
	if (node.type === "keyword_pattern") {
		// The first named child is the keyword field; only its value pattern
		// may introduce captures (`Wrapper(field=capture)`).
		const value = namedChildren(node).slice(1);
		return value.length === 1
			? {
					kind: "delegate",
					node: value[0],
					classifier: classifyBindingPattern,
				}
			: { kind: "unknown" };
	}
	if (BINDING_PATTERN_CONTAINER_TYPES.has(node.type)) {
		return { kind: "descend", children: namedChildren(node) };
	}
	if (node.type === "as_pattern_target") {
		return {
			kind: "delegate",
			node,
			classifier: classifyBindingTarget,
		};
	}
	return { kind: "unknown" };
}

/** Extract only identifiers in Python binding positions. */
function bindingTargetNames(node: PythonSyntaxNode | undefined): {
	names: string[];
	unknown: boolean;
} {
	return collectBindingNames(node, classifyBindingTarget);
}

function asPatternTargetNames(node: PythonSyntaxNode): {
	names: string[];
	unknown: boolean;
} {
	return collectBindingNames(node, classifyAsPatternTarget);
}

function bindingPatternNames(node: PythonSyntaxNode | undefined): {
	names: string[];
	unknown: boolean;
} {
	return collectBindingNames(node, classifyBindingPattern);
}

function parseAliasedImport(
	node: PythonSyntaxNode,
): ParsedImportBinding | undefined {
	const children = namedChildren(node);
	const source = children[0]?.text;
	const local = children.at(-1);
	if (!source || local?.type !== "identifier") return undefined;
	return { source, local: local.text };
}

function parseFromBinding(
	node: PythonSyntaxNode,
): ParsedImportBinding | undefined {
	if (node.type === "aliased_import") return parseAliasedImport(node);
	if (node.type !== "dotted_name" && node.type !== "identifier") {
		return undefined;
	}
	return { source: node.text, local: node.text };
}

function parsePlainBinding(
	node: PythonSyntaxNode,
): ParsedImportBinding | undefined {
	if (node.type === "aliased_import") return parseAliasedImport(node);
	if (node.type !== "dotted_name" && node.type !== "identifier") {
		return undefined;
	}
	const [local] = node.text.split(".");
	return local ? { source: node.text, local } : undefined;
}

function parseFromImport(node: PythonSyntaxNode): ParsedImportStatement {
	const children = namedChildren(node);
	const moduleName = children[0]?.text;
	const bindings: ParsedImportBinding[] = [];
	let unknown = !moduleName;
	for (const part of children.slice(1)) {
		const binding = parseFromBinding(part);
		if (binding) bindings.push(binding);
		else unknown = true;
	}
	return {
		kind: "from",
		moduleName,
		bindings,
		unknown,
		star: node.text.includes("*"),
	};
}

function parsePlainImport(node: PythonSyntaxNode): ParsedImportStatement {
	const bindings: ParsedImportBinding[] = [];
	let unknown = false;
	for (const part of namedChildren(node)) {
		const binding = parsePlainBinding(part);
		if (binding) bindings.push(binding);
		else unknown = true;
	}
	return {
		kind: "plain",
		moduleName: undefined,
		bindings,
		unknown,
		star: node.text.includes("*"),
	};
}

function parseImportStatement(node: PythonSyntaxNode): ParsedImportStatement {
	if (node.type === "import_from_statement") return parseFromImport(node);
	if (node.type === "import_statement") return parsePlainImport(node);
	return {
		kind: "unknown",
		moduleName: undefined,
		bindings: [],
		unknown: true,
		star: node.text.includes("*"),
	};
}

function importedNames(statement: ParsedImportStatement): {
	names: string[];
	unknown: boolean;
	star: boolean;
} {
	return {
		names: statement.bindings.map((binding) => binding.local),
		unknown: statement.unknown,
		star: statement.star,
	};
}

function eligibleImports(
	statement: ParsedImportStatement,
	endIndex: number,
): EligibleImport[] {
	if (statement.kind === "plain") {
		return statement.bindings.flatMap((binding) => {
			const provenance = PLAIN_PACKAGE_PROVENANCE.get(binding.source);
			return provenance ? [{ name: binding.local, provenance, endIndex }] : [];
		});
	}
	if (statement.kind !== "from" || !statement.moduleName) return [];
	return statement.bindings.flatMap((binding) => {
		const provenance = FROM_IMPORT_PROVENANCE.get(
			`${statement.moduleName}:${binding.source}`,
		);
		return provenance ? [{ name: binding.local, provenance, endIndex }] : [];
	});
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

interface SummaryBuildState {
	imports: Map<string, EligibleImport>;
	bindingCounts: Map<string, number>;
	functionBindings: Map<string, Map<string, number>>;
	functionAnnotations: Map<string, Map<string, string>>;
	invalid: boolean;
	visits: number;
	functionChain: PythonSyntaxNode[];
	parentFunctionChain: PythonSyntaxNode[];
	moduleDirect: boolean;
}

type SummaryNodeRecorder = (
	node: PythonSyntaxNode,
	state: SummaryBuildState,
) => void;

function markInvalid(state: SummaryBuildState): void {
	state.invalid = true;
}

function addBinding(
	state: SummaryBuildState,
	name: string,
	functionChain: PythonSyntaxNode[],
): void {
	state.bindingCounts.set(name, (state.bindingCounts.get(name) ?? 0) + 1);
	for (const fn of functionChain) {
		const key = nodeKey(fn);
		const bindings =
			state.functionBindings.get(key) ?? new Map<string, number>();
		bindings.set(name, (bindings.get(name) ?? 0) + 1);
		state.functionBindings.set(key, bindings);
	}
}

function addTarget(
	state: SummaryBuildState,
	target: PythonSyntaxNode | undefined,
	functionChain: PythonSyntaxNode[],
): void {
	const extracted = bindingTargetNames(target);
	if (extracted.unknown) markInvalid(state);
	for (const name of extracted.names) addBinding(state, name, functionChain);
}

function recordFunctionParameters(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	const annotations = new Map<string, string>();
	const parameters = directNamedChild(node, "parameters");
	for (const parameter of namedChildren(parameters ?? node)) {
		const name = parameterName(parameter);
		if (!name) {
			if (parameter.type !== "list_splat_pattern") markInvalid(state);
			continue;
		}
		addBinding(state, name, state.functionChain);
		const annotation = directAnnotationName(parameter);
		if (annotation) annotations.set(name, annotation);
	}
	state.functionAnnotations.set(nodeKey(node), annotations);
}

function recordFunctionDefinition(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	recordFunctionParameters(node, state);
	recordDefinitionBinding(node, state);
}

function recordLambdaParameters(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	const parameters = directNamedChild(node, "lambda_parameters");
	for (const parameter of namedChildren(parameters ?? node)) {
		const name = parameterName(parameter);
		if (name) addBinding(state, name, state.functionChain);
		else markInvalid(state);
	}
}

function recordImportBindings(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	const statement = parseImportStatement(node);
	const imported = importedNames(statement);
	if (imported.unknown || imported.star) markInvalid(state);
	for (const name of imported.names)
		addBinding(state, name, state.functionChain);
	if (!state.moduleDirect) return;
	for (const candidate of eligibleImports(statement, node.endIndex)) {
		state.imports.set(candidate.name, candidate);
	}
}

function recordTargetBinding(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	addTarget(
		state,
		node.childForFieldName?.("left") ?? namedChildren(node)[0],
		state.functionChain,
	);
}

function recordAsPatternBinding(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	const extracted = asPatternTargetNames(node);
	if (extracted.unknown) markInvalid(state);
	for (const name of extracted.names)
		addBinding(state, name, state.functionChain);
}

function recordDeleteTargets(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	for (const child of namedChildren(node)) {
		addTarget(state, child, state.functionChain);
	}
}

function recordCaseBindings(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	const extracted = bindingPatternNames(directNamedChild(node, "case_pattern"));
	if (extracted.unknown) markInvalid(state);
	for (const name of extracted.names)
		addBinding(state, name, state.functionChain);
}

function recordDefinitionBinding(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	const name = directNamedChild(node, "identifier")?.text;
	if (name) addBinding(state, name, state.parentFunctionChain);
	else markInvalid(state);
}

function recordTypeAliasBinding(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	const name = directNamedChild(node, "type")?.children?.find(
		(child) => child.type === "identifier",
	)?.text;
	if (name) addBinding(state, name, state.functionChain);
	else markInvalid(state);
}

function recordDeclarationBindings(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	for (const child of namedChildren(node)) {
		addBinding(state, child.text, state.functionChain);
	}
}

function recordTypeParameterBindings(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	for (const child of namedChildren(node)) {
		if (child.type === "identifier") {
			addBinding(state, child.text, state.functionChain);
		}
	}
}

function hasDynamicNamespaceHazard(node: PythonSyntaxNode): boolean {
	if (node.type !== "call") return false;
	const callee = node.childForFieldName?.("function") ?? namedChildren(node)[0];
	return (
		callee?.type === "identifier" &&
		["exec", "eval", "globals", "locals", "vars"].includes(callee.text)
	);
}

function recordDynamicNamespaceHazard(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	if (hasDynamicNamespaceHazard(node)) markInvalid(state);
}

const SUMMARY_NODE_RECORDERS: Readonly<Record<string, SummaryNodeRecorder>> =
	Object.freeze({
		function_definition: recordFunctionDefinition,
		class_definition: recordDefinitionBinding,
		lambda: recordLambdaParameters,
		import_from_statement: recordImportBindings,
		import_statement: recordImportBindings,
		assignment: recordTargetBinding,
		augmented_assignment: recordTargetBinding,
		named_expression: recordTargetBinding,
		for_statement: recordTargetBinding,
		for_in_clause: recordTargetBinding,
		with_item: recordAsPatternBinding,
		except_clause: recordAsPatternBinding,
		except_group_clause: recordAsPatternBinding,
		delete_statement: recordDeleteTargets,
		case_clause: recordCaseBindings,
		type_alias_statement: recordTypeAliasBinding,
		global_statement: recordDeclarationBindings,
		nonlocal_statement: recordDeclarationBindings,
		type_parameter: recordTypeParameterBindings,
		type_parameter_list: recordTypeParameterBindings,
		call: recordDynamicNamespaceHazard,
	});

class Summary implements PythonProvenanceSummary {
	readonly invalid: boolean;
	private readonly imports: ReadonlyMap<string, EligibleImport>;
	private readonly tainted: ReadonlySet<string>;
	private readonly functions: ReadonlyMap<string, FunctionSummary>;

	constructor(root: PythonSyntaxNode) {
		const state: SummaryBuildState = {
			imports: new Map(),
			bindingCounts: new Map(),
			functionBindings: new Map(),
			functionAnnotations: new Map(),
			invalid: false,
			visits: 0,
			functionChain: [],
			parentFunctionChain: [],
			moduleDirect: false,
		};
		const visit = (
			node: PythonSyntaxNode,
			depth: number,
			moduleDirect: boolean,
			activeFunctions: PythonSyntaxNode[],
		): void => {
			if (++state.visits > TRAVERSAL_VISIT_CAP || depth > TRAVERSAL_DEPTH_CAP) {
				markInvalid(state);
				return;
			}
			if (node.hasError || node.type === "ERROR" || node.type === "MISSING") {
				markInvalid(state);
				return;
			}
			const functionChain =
				node.type === "function_definition"
					? [...activeFunctions, node]
					: activeFunctions;
			state.functionChain = functionChain;
			state.parentFunctionChain = activeFunctions;
			state.moduleDirect = moduleDirect;
			const recorder = SUMMARY_NODE_RECORDERS[node.type];
			if (recorder) recorder(node, state);
			for (const child of node.children ?? []) {
				visit(child, depth + 1, node === root, functionChain);
			}
		};
		visit(root, 0, false, []);

		const tainted = new Set<string>();
		for (const [name, count] of state.bindingCounts) {
			if (count !== 1 || !state.imports.has(name)) tainted.add(name);
		}
		for (const name of state.imports.keys()) {
			if ((state.bindingCounts.get(name) ?? 0) !== 1) tainted.add(name);
		}
		this.invalid = state.invalid;
		this.imports = state.imports;
		this.tainted = tainted;
		this.functions = new Map(
			[...state.functionAnnotations.entries()].map(([key, annotations]) => [
				key,
				{
					parameterAnnotations: annotations,
					bindingCounts: state.functionBindings.get(key) ?? new Map(),
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
	if (node?.type !== "call" || !root) return false;
	const summary = getPythonProvenanceSummary(root);
	if (summary.invalid) return false;
	const formatCallee =
		node.childForFieldName?.("function") ?? namedChildren(node)[0];
	if (formatCallee?.type !== "attribute") return false;
	const formatChildren = namedChildren(formatCallee);
	const hasFormatMethod = formatChildren.some(
		(child) => child.text === "format",
	);
	const sqlConstructor = formatChildren.find((child) => child.type === "call");
	if (!hasFormatMethod || !sqlConstructor) return false;
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
