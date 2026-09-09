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
	| "sqlalchemy-module"
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

interface FunctionSummary {
	parameterAnnotations: ReadonlyMap<string, string>;
	bindingCounts: ReadonlyMap<string, number>;
}

interface PythonProvenanceSummary {
	readonly invalid: boolean;
	provenanceFor(
		name: string,
		reference: PythonSyntaxNode,
	): PythonProvenance | null;
	isSqlAlchemySessionReceiver(receiver: PythonSyntaxNode): boolean;
	/**
	 * True when the reference resolves to a binding introduced by an enclosing
	 * function (a parameter or a local): an opaque runtime value, never a
	 * module-level entity class. Fails closed (true) when nothing is proven.
	 */
	isFunctionLocalName(reference: PythonSyntaxNode): boolean;
	/** The value assigned to `name`, iff `name` is bound exactly once. */
	singleAssignmentValue(
		name: string,
		reference: PythonSyntaxNode,
	): PythonSyntaxNode | null;
}

const SUMMARY_BY_ROOT = new WeakMap<
	PythonSyntaxNode,
	PythonProvenanceSummary
>();
const TRAVERSAL_VISIT_CAP = 50_000;
const TRAVERSAL_DEPTH_CAP = 128;
const EXPRESSION_DEPTH_CAP = 8;
const BINDING_SCAN_DEPTH_CAP = 32;
const ANCESTOR_DEPTH_CAP = 64;

/**
 * Receiver names conventionally bound to a SQLAlchemy session. The pre-existing
 * `session.execute(...)` exemption keys off these; structural provenance below
 * proves the annotated case.
 */
export const PYTHON_SQLALCHEMY_RECEIVER_NAMES: ReadonlySet<string> = new Set([
	"session",
	"db_session",
	"async_session",
	"sync_session",
]);
/** Statement constructors whose result is an expression object, never a string. */
export const PYTHON_SQLALCHEMY_STATEMENT_BUILDERS: ReadonlySet<string> =
	new Set(["select", "insert", "update", "delete"]);

const FROM_IMPORT_PROVENANCE = new Map<string, PythonProvenance>([
	["sqlalchemy.orm:Session", "sqlalchemy-session"],
	["sqlalchemy.ext.asyncio:AsyncSession", "sqlalchemy-session"],
	["psycopg:sql", "psycopg-sql-module"],
	["psycopg2:sql", "psycopg-sql-module"],
	["psycopg.sql:SQL", "psycopg-sql-constructor"],
	["psycopg2.sql:SQL", "psycopg-sql-constructor"],
	["psycopg.sql:Identifier", "psycopg-identifier-constructor"],
	["psycopg2.sql:Identifier", "psycopg-identifier-constructor"],
]);
const PLAIN_PACKAGE_PROVENANCE = new Map<string, PythonProvenance>([
	["sqlalchemy", "sqlalchemy-module"],
	["psycopg", "psycopg-package"],
	["psycopg2", "psycopg-package"],
]);

function nodeKey(node: PythonSyntaxNode): string {
	return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

function namedChildren(node: PythonSyntaxNode): PythonSyntaxNode[] {
	return (node.children ?? []).filter((child) => child.isNamed);
}

function calleeNode(call: PythonSyntaxNode): PythonSyntaxNode | undefined {
	if (call.type !== "call") return undefined;
	return call.childForFieldName?.("function") ?? namedChildren(call)[0];
}

function directNamedChild(
	node: PythonSyntaxNode,
	type: string,
): PythonSyntaxNode | undefined {
	return namedChildren(node).find((child) => child.type === type);
}

/**
 * Where a name may be introduced. `target` is an assignment/for/walrus target,
 * `pattern` a `match` case pattern, `as` a `with`/`except` clause whose binder
 * is its `as_pattern_target`. Anything unrecognized sets `unknown`, which
 * invalidates the whole summary — this analysis fails closed.
 */
type BindingScanMode = "target" | "pattern" | "as";

interface BindingScan {
	names: string[];
	unknown: boolean;
}

// Containers hold further binding positions; reference types (`a.b`, `a[b]`,
// `Mod.Case`) never introduce a name.
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

function scanBindingNames(
	node: PythonSyntaxNode | undefined,
	mode: BindingScanMode,
	scan: BindingScan,
	depth = 0,
): void {
	if (!node || depth > BINDING_SCAN_DEPTH_CAP) {
		scan.unknown = true;
		return;
	}
	const descend = (
		child: PythonSyntaxNode | undefined,
		next: BindingScanMode,
	) => scanBindingNames(child, next, scan, depth + 1);
	if (node.type === "as_pattern_target") {
		descend(namedChildren(node)[0], "target");
		return;
	}
	if (mode === "as") {
		// `with ctx() as name` / `except E as name`: only the as-target binds.
		for (const child of namedChildren(node)) descend(child, "as");
		return;
	}
	if (node.type === "identifier") {
		if (node.text !== "_") scan.names.push(node.text);
		return;
	}
	if (mode === "pattern") {
		if (node.type === "dotted_name") {
			// A bare `case name` captures; `case Mod.CONST` is a value reference.
			if (!node.text.includes(".") && node.text !== "_") {
				scan.names.push(node.text);
			}
			return;
		}
		if (BINDING_PATTERN_REFERENCE_TYPES.has(node.type)) return;
		if (node.type === "keyword_pattern") {
			// `Wrapper(field=capture)`: the keyword itself is not a binder.
			const value = namedChildren(node).slice(1);
			if (value.length !== 1) scan.unknown = true;
			else descend(value[0], "pattern");
			return;
		}
		if (BINDING_PATTERN_CONTAINER_TYPES.has(node.type)) {
			for (const child of namedChildren(node)) descend(child, "pattern");
			return;
		}
		scan.unknown = true;
		return;
	}
	if (BINDING_TARGET_REFERENCE_TYPES.has(node.type)) return;
	if (BINDING_TARGET_CONTAINER_TYPES.has(node.type)) {
		for (const child of namedChildren(node)) descend(child, "target");
		return;
	}
	scan.unknown = true;
}

/** Extract only identifiers in Python binding positions. */
function collectBindingNames(
	node: PythonSyntaxNode | undefined,
	mode: BindingScanMode,
): BindingScan {
	const scan: BindingScan = { names: [], unknown: false };
	scanBindingNames(node, mode, scan);
	return scan;
}

/**
 * One import clause. `source` is the name as written in the module
 * (`sql` in `from psycopg import sql`, `psycopg.sql` in `import psycopg.sql`);
 * `local` is the name it binds.
 */
function parseImportBinding(
	node: PythonSyntaxNode,
	isFrom: boolean,
): ParsedImportBinding | undefined {
	if (node.type === "aliased_import") {
		const children = namedChildren(node);
		const source = children[0]?.text;
		const local = children.at(-1);
		return source && local?.type === "identifier"
			? { source, local: local.text }
			: undefined;
	}
	if (node.type !== "dotted_name" && node.type !== "identifier") {
		return undefined;
	}
	if (isFrom) return { source: node.text, local: node.text };
	const local = node.text.split(".")[0];
	return local ? { source: node.text, local } : undefined;
}

function directAnnotationName(parameter: PythonSyntaxNode): string | undefined {
	// `typed_default_parameter` is FastAPI's `db: Session = Depends(get_db)`.
	if (
		parameter.type !== "typed_parameter" &&
		parameter.type !== "typed_default_parameter"
	) {
		return undefined;
	}
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
	assignments: Map<string, PythonSyntaxNode>;
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
	const extracted = collectBindingNames(target, "target");
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
	const isFrom = node.type === "import_from_statement";
	const children = namedChildren(node);
	const moduleName = isFrom ? children[0]?.text : undefined;
	// A star import can introduce anything: give up on the file.
	if (node.text.includes("*") || (isFrom && !moduleName)) markInvalid(state);
	for (const part of isFrom ? children.slice(1) : children) {
		const binding = parseImportBinding(part, isFrom);
		if (!binding) {
			markInvalid(state);
			continue;
		}
		addBinding(state, binding.local, state.functionChain);
		// Only imports at module top level prove provenance: a class-body or
		// function-body import is not in scope for the sink's namespace.
		if (!state.moduleDirect) continue;
		const provenance = isFrom
			? FROM_IMPORT_PROVENANCE.get(`${moduleName}:${binding.source}`)
			: PLAIN_PACKAGE_PROVENANCE.get(binding.source);
		if (provenance) {
			state.imports.set(binding.local, {
				name: binding.local,
				provenance,
				endIndex: node.endIndex,
			});
		}
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

/**
 * `stmt = select(User)` — the assigned value, indexed by name. Only consulted
 * when the name has exactly one binding in the file, so a rebound or shadowed
 * name never proves anything.
 */
function recordAssignmentValue(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	recordTargetBinding(node, state);
	const target = node.childForFieldName?.("left") ?? namedChildren(node)[0];
	const value = node.childForFieldName?.("right") ?? namedChildren(node).at(-1);
	if (target?.type !== "identifier" || !value || value === target) return;
	state.assignments.set(target.text, value);
}

function recordAsPatternBinding(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	const extracted = collectBindingNames(node, "as");
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
	const extracted = collectBindingNames(
		directNamedChild(node, "case_pattern"),
		"pattern",
	);
	if (extracted.unknown) markInvalid(state);
	for (const name of extracted.names)
		addBinding(state, name, state.functionChain);
}

/**
 * `global sql` / `nonlocal sql` — the declaration alone is enough to give up on
 * the name (covered by the "global" case of the fail-closed runner regression).
 */
function recordDeclarationBindings(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	for (const child of namedChildren(node)) {
		addBinding(state, child.text, state.functionChain);
	}
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

const DYNAMIC_NAMESPACE_BUILTINS = new Set([
	"exec",
	"eval",
	"globals",
	"locals",
	"vars",
]);

/** `exec`/`eval`/`globals()` can rebind anything: give up on the whole file. */
function recordDynamicNamespaceHazard(
	node: PythonSyntaxNode,
	state: SummaryBuildState,
): void {
	const callee = calleeNode(node);
	if (
		callee?.type === "identifier" &&
		DYNAMIC_NAMESPACE_BUILTINS.has(callee.text)
	) {
		markInvalid(state);
	}
}

const SUMMARY_NODE_RECORDERS: Readonly<Record<string, SummaryNodeRecorder>> =
	Object.freeze({
		function_definition: recordFunctionDefinition,
		class_definition: recordDefinitionBinding,
		lambda: recordLambdaParameters,
		import_from_statement: recordImportBindings,
		import_statement: recordImportBindings,
		assignment: recordAssignmentValue,
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
		call: recordDynamicNamespaceHazard,
	});

class Summary implements PythonProvenanceSummary {
	readonly invalid: boolean;
	private readonly imports: ReadonlyMap<string, EligibleImport>;
	private readonly bindingCounts: ReadonlyMap<string, number>;
	private readonly assignments: ReadonlyMap<string, PythonSyntaxNode>;
	private readonly functions: ReadonlyMap<string, FunctionSummary>;

	constructor(root: PythonSyntaxNode) {
		const state: SummaryBuildState = {
			imports: new Map(),
			bindingCounts: new Map(),
			assignments: new Map(),
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

		this.invalid = state.invalid;
		this.imports = state.imports;
		this.bindingCounts = state.bindingCounts;
		this.assignments = state.assignments;
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
		// Exactly one binding in the file, and it is the import itself: any
		// shadow, rebind or `del` anywhere makes the name unusable as proof.
		const candidate = this.boundOnce(name) ? this.imports.get(name) : undefined;
		return candidate && candidate.endIndex <= reference.startIndex
			? candidate.provenance
			: null;
	}

	private boundOnce(name: string): boolean {
		return !this.invalid && (this.bindingCounts.get(name) ?? 0) === 1;
	}

	singleAssignmentValue(
		name: string,
		reference: PythonSyntaxNode,
	): PythonSyntaxNode | null {
		if (!this.boundOnce(name)) return null;
		const value = this.assignments.get(name);
		return value && value.endIndex <= reference.startIndex ? value : null;
	}

	isFunctionLocalName(reference: PythonSyntaxNode): boolean {
		if (this.invalid || reference.type !== "identifier") return true;
		let current: PythonSyntaxNode | null | undefined = reference.parent;
		for (let depth = 0; current && depth < ANCESTOR_DEPTH_CAP; depth++) {
			if (current.type === "function_definition") {
				const summary = this.functions.get(nodeKey(current));
				if (!summary) return true;
				if ((summary.bindingCounts.get(reference.text) ?? 0) > 0) return true;
			}
			current = current.parent;
		}
		return false;
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

function getPythonProvenanceSummary(
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

function isStaticStringLiteral(node: PythonSyntaxNode | undefined): boolean {
	return (
		node?.type === "string" &&
		!namedChildren(node).some((child) => child.type === "interpolation")
	);
}

function callArguments(call: PythonSyntaxNode): PythonSyntaxNode[] {
	return namedChildren(directNamedChild(call, "argument_list") ?? call).filter(
		(child) => child.type !== "comment",
	);
}

// Node types that ARE SQL text, or that compose it (`+`, `%`).
const COMPOSED_SQL_NODE_TYPES = new Set([
	"string",
	"concatenated_string",
	"binary_operator",
]);

/**
 * True when an expression carries SQL text a caller composed — a literal, a
 * concatenation, a `%` format, an f-string, `"...".format(...)`, or any call
 * that wraps one. Fails closed at the depth cap: unknown means composed.
 */
function carriesComposedSql(
	node: PythonSyntaxNode | undefined,
	depth = 0,
): boolean {
	if (!node) return false;
	if (depth > EXPRESSION_DEPTH_CAP) return true;
	if (COMPOSED_SQL_NODE_TYPES.has(node.type)) return true;
	if (node.type !== "call") return false;
	const callee = calleeNode(node);
	if (callee?.type === "attribute") {
		// `"SELECT {}".format(uid)` — the template hangs off the callee.
		const object =
			callee.childForFieldName?.("object") ?? namedChildren(callee)[0];
		if (carriesComposedSql(object, depth + 1)) return true;
	}
	return callArguments(node).some((argument) =>
		carriesComposedSql(argument, depth + 1),
	);
}

/**
 * The builder name a call invokes: a bare `select(...)`, or `sa.select(...)`
 * where `sa` is a PROVEN sqlalchemy import. Without that proof any object's
 * `.update(...)` would read as a statement builder (#2577 review F2).
 */
function builderCalleeName(
	call: PythonSyntaxNode,
	summary: PythonProvenanceSummary,
): string | undefined {
	const callee = calleeNode(call);
	if (callee?.type === "identifier") return callee.text;
	if (callee?.type !== "attribute") return undefined;
	const object =
		callee.childForFieldName?.("object") ?? namedChildren(callee)[0];
	if (expressionProvenance(object, summary) !== "sqlalchemy-module") {
		return undefined;
	}
	const attribute =
		callee.childForFieldName?.("attribute") ?? namedChildren(callee).at(-1);
	return attribute?.type === "identifier" ? attribute.text : undefined;
}

/**
 * `select(User)`, `sa.update(User)`, `text("SELECT 1")` — a statement object,
 * not a SQL string. `text()` is the one builder that carries raw SQL, so only a
 * literal template counts; and no builder may wrap composed SQL, or
 * `update("UPDATE t SET x=" + uid)` would launder it (#2577 review F2).
 */
function isStatementBuilderCall(
	node: PythonSyntaxNode | undefined,
	summary: PythonProvenanceSummary,
): boolean {
	if (node?.type !== "call") return false;
	const name = builderCalleeName(node, summary);
	if (!name) return false;
	const args = callArguments(node);
	if (name === "text") {
		return args.length === 1 && isStaticStringLiteral(args[0]);
	}
	if (!PYTHON_SQLALCHEMY_STATEMENT_BUILDERS.has(name)) return false;
	return !args.some((argument) => carriesComposedSql(argument));
}

/**
 * True when a statement-executing argument is a builder call, or a name bound
 * exactly once in the file to one (`stmt = select(User); db.execute(stmt)`).
 */
export function isSqlAlchemyStatementArgument(
	node: PythonSyntaxNode | undefined,
	root: PythonSyntaxNode | undefined,
): boolean {
	if (!node || !root) return false;
	const summary = getPythonProvenanceSummary(root);
	if (isStatementBuilderCall(node, summary)) return true;
	if (node.type !== "identifier") return false;
	const bound = summary.singleAssignmentValue(node.text, node);
	return isStatementBuilderCall(bound ?? undefined, summary);
}

/**
 * `Session.query` takes mapped classes, so it must NOT require a builder
 * argument (`db.query(User)` is the case #2576 reports). It suppresses only
 * what cannot be SQL text: composed strings and opaque function-local values
 * stay diagnostic (#2577 review F1).
 */
export function isSqlAlchemyEntityQueryArgument(
	node: PythonSyntaxNode | undefined,
	root: PythonSyntaxNode | undefined,
): boolean {
	if (!node || !root) return false;
	const summary = getPythonProvenanceSummary(root);
	if (isStatementBuilderCall(node, summary)) return true;
	if (carriesComposedSql(node)) return false;
	if (node.type !== "identifier") return true;
	// A name the enclosing function binds is a runtime value that may hold SQL
	// text (`q = build_sql(uid); db.query(q)`), so it stays diagnostic whatever
	// it was assigned; a free or module-level name is the mapped class this API
	// expects. A model built inside the function (`User = get_model()`) is
	// statically indistinguishable from the first and fires: accepted noise,
	// since following the assignment loses the true positive (#2577 round 3).
	return !summary.isFunctionLocalName(node);
}
