/**
 * Per-function code metrics over the shipped tree-sitter grammars (#5086).
 *
 * One table per language and one walk per function body. The `function-facts`
 * provider (and through it `high-complexity`, `unsafe-boundary` and the review
 * graph) and `ComplexityClient` both read their numbers here.
 */
import { buildQualifiedName } from "../symbol-containment.js";
import {
	type ComplexityLanguageId,
	firstChildOfType,
	type TsNode,
} from "../tree-sitter-shared.js";

export interface FunctionMetrics {
	/** McCabe: 1 + decision points + logical operators in the body. */
	cyclomatic: number;
	/** Each scored structure adds 1 + its nesting (a nested function counts as a level); each logical operator and each labeled break or continue adds 1. */
	cognitive: number;
	/** Deepest control-structure nesting below the body; a flat body is 0. */
	nesting: number;
	/** Source lines the function node spans. */
	length: number;
	parameters: number;
}

export interface NamedFunctionMetrics extends FunctionMetrics {
	name: string;
	line: number;
	/** 1-based last line of the function node. */
	endLine: number;
	/**
	 * Identity that survives an edit which only moves the function (#5087):
	 * the owner-qualified name (`Class.method`, `outer.inner`), `<anonymous>`
	 * for an unnamed function, and `#2`, `#3` on later same-key siblings in
	 * source order. No line number takes part in it.
	 */
	key: string;
}

export interface FileMetrics {
	cognitive: number;
	nesting: number;
	/** Every function-like node, in source order, nested ones included. */
	functions: NamedFunctionMetrics[];
}

/** Sees each body node once, during the metrics walk (#1740: one pass). */
export type BodyVisitor = (
	node: TsNode,
	type: string,
	children: TsNode[],
) => void;

interface MetricsTable {
	functions: ReadonlySet<string>;
	/** Declarations that own the functions inside them (classes, impls). */
	containers: ReadonlySet<string>;
	decisions: ReadonlySet<string>;
	cognitive: ReadonlySet<string>;
	nesting: ReadonlySet<string>;
	/** Operator tokens of a logical `binary_expression` or `boolean_operator`. */
	logical: ReadonlySet<string>;
}

const JSTS: MetricsTable = {
	functions: new Set([
		"function_declaration",
		"function_expression",
		"arrow_function",
		"method_definition",
		"generator_function",
		"generator_function_declaration",
	]),
	containers: new Set([
		"class_declaration",
		"abstract_class_declaration",
		"class",
		"interface_declaration",
	]),
	// `switch_default` is not a decision.
	decisions: new Set([
		"if_statement",
		"for_statement",
		"for_in_statement",
		"while_statement",
		"do_statement",
		"switch_case",
		"catch_clause",
		"ternary_expression",
	]),
	cognitive: new Set([
		"if_statement",
		"for_statement",
		"for_in_statement",
		"while_statement",
		"do_statement",
		"switch_statement",
		"catch_clause",
		"ternary_expression",
	]),
	nesting: new Set([
		"if_statement",
		"for_statement",
		"for_in_statement",
		"while_statement",
		"do_statement",
		"switch_statement",
		"try_statement",
	]),
	logical: new Set(["&&", "||", "??"]),
};

const PYTHON: MetricsTable = {
	functions: new Set(["function_definition", "lambda"]),
	containers: new Set(["class_definition"]),
	decisions: new Set([
		"if_statement",
		"elif_clause",
		"for_statement",
		"while_statement",
		"case_clause",
		"conditional_expression",
		"except_clause",
	]),
	cognitive: new Set([
		"if_statement",
		"elif_clause",
		"for_statement",
		"while_statement",
		"match_statement",
		"conditional_expression",
		"except_clause",
	]),
	nesting: new Set([
		"if_statement",
		"for_statement",
		"while_statement",
		"match_statement",
		"try_statement",
	]),
	logical: new Set(["and", "or"]),
};

const GO: MetricsTable = {
	functions: new Set([
		"function_declaration",
		"method_declaration",
		"func_literal",
	]),
	// A Go method's owner is its receiver type (`ownerOf`), not a container.
	containers: new Set<string>(),
	// `default_case` is not a decision.
	decisions: new Set([
		"if_statement",
		"for_statement",
		"expression_case",
		"type_case",
		"communication_case",
	]),
	cognitive: new Set([
		"if_statement",
		"for_statement",
		"expression_switch_statement",
		"type_switch_statement",
		"select_statement",
	]),
	nesting: new Set([
		"if_statement",
		"for_statement",
		"expression_switch_statement",
		"type_switch_statement",
		"select_statement",
	]),
	logical: new Set(["&&", "||"]),
};

const RUST: MetricsTable = {
	functions: new Set(["function_item", "closure_expression"]),
	containers: new Set(["impl_item", "trait_item", "mod_item"]),
	decisions: new Set([
		"if_expression",
		"while_expression",
		"for_expression",
		"loop_expression",
		"match_arm",
	]),
	cognitive: new Set([
		"if_expression",
		"while_expression",
		"for_expression",
		"loop_expression",
		"match_expression",
	]),
	nesting: new Set([
		"if_expression",
		"while_expression",
		"for_expression",
		"loop_expression",
		"match_expression",
	]),
	logical: new Set(["&&", "||"]),
};

/** `satisfies` a `Record` over the language union, so a grammar added to
 * `COMPLEXITY_LANGUAGE_IDS` without a table here is a compile error. */
const TABLES = {
	typescript: JSTS,
	tsx: JSTS,
	javascript: JSTS,
	python: PYTHON,
	go: GO,
	rust: RUST,
} satisfies Record<ComplexityLanguageId, MetricsTable>;

/** Named children of a parameter list that are not parameters. */
const NOT_PARAMETERS = new Set([
	"comment",
	"line_comment",
	"block_comment",
	"attribute_item",
	"keyword_separator",
	"positional_separator",
]);

interface Tally {
	cyclomatic: number;
	cognitive: number;
	nesting: number;
}

interface Walk {
	table: MetricsTable;
	visit: BodyVisitor | undefined;
	tally: Tally;
}

function isLogicalOperator(
	type: string,
	children: TsNode[],
	table: MetricsTable,
): boolean {
	if (type !== "binary_expression" && type !== "boolean_operator") return false;
	return children.some((c: TsNode) => table.logical.has(c?.type));
}

function step(
	walk: Walk,
	node: TsNode,
	depth: number,
	cognitiveDepth: number,
	inFunction: boolean,
): void {
	const { table, tally } = walk;
	const type: string = node.type;
	const children: TsNode[] = node.children ?? [];
	walk.visit?.(node, type, children);
	tally.nesting = Math.max(tally.nesting, depth);
	if (table.decisions.has(type)) tally.cyclomatic++;
	if (table.cognitive.has(type)) tally.cognitive += 1 + cognitiveDepth;
	if (isLogicalOperator(type, children, table)) {
		tally.cyclomatic++;
		tally.cognitive++;
	}
	// A labeled jump adds 1, flat (SonarSource); a bare one adds nothing. Rust
	// labels sit on a break_expression and are not scored.
	if (
		(type === "break_statement" || type === "continue_statement") &&
		children.some(
			(c: TsNode) =>
				c?.type === "statement_identifier" || c?.type === "label_name",
		)
	) {
		tally.cognitive++;
	}
	const nests = table.nesting.has(type);
	const isFunction = table.functions.has(type);
	const nextDepth = nests ? depth + 1 : depth;
	// Only a function nested in another one deepens cognitive nesting.
	const deepens = nests || (isFunction && inFunction);
	const nextCognitiveDepth = deepens ? cognitiveDepth + 1 : cognitiveDepth;
	for (const child of children) {
		if (child)
			step(
				walk,
				child,
				nextDepth,
				nextCognitiveDepth,
				inFunction || isFunction,
			);
	}
}

function tally(
	scope: TsNode | null,
	table: MetricsTable,
	insideFunction: boolean,
	visit?: BodyVisitor,
): Tally {
	const walk: Walk = {
		table,
		visit,
		tally: { cyclomatic: 1, cognitive: 0, nesting: 0 },
	};
	if (scope) step(walk, scope, 0, 0, insideFunction);
	return walk.tally;
}

/**
 * The `body` field as one of `fn.children`'s own objects. web-tree-sitter
 * caches a node's children on its object, and `childForFieldName` returns a
 * fresh object, so walking it re-marshals the whole body (3x slower on
 * `clients/review-graph/builder.ts`).
 */
function bodyOf(fn: TsNode): TsNode | null {
	const id = fn.childForFieldName("body")?.id;
	if (id === undefined) return null;
	return (fn.children ?? []).find((c: TsNode) => c?.id === id) ?? null;
}

function countParameters(fn: TsNode): number {
	const list = fn.childForFieldName("parameters");
	// A bare `x => x` arrow names its one parameter in the `parameter` field.
	if (!list) return fn.childForFieldName("parameter") ? 1 : 0;
	let count = 0;
	for (const param of list.namedChildren ?? []) {
		if (!param || NOT_PARAMETERS.has(param.type)) continue;
		// Go declares several names in one `a, b int`.
		count += Math.max(1, param.childrenForFieldName("name").length);
	}
	return count;
}

/** Metrics for one function-like node of `languageId`'s grammar. */
export function measureFunction(
	fn: TsNode,
	languageId: ComplexityLanguageId,
	visit?: BodyVisitor,
): FunctionMetrics {
	const { cyclomatic, cognitive, nesting } = tally(
		bodyOf(fn),
		TABLES[languageId],
		true,
		visit,
	);
	return {
		cyclomatic,
		cognitive,
		nesting,
		length: fn.endPosition.row - fn.startPosition.row + 1,
		parameters: countParameters(fn),
	};
}

/**
 * The name a function-like node declares or is bound to, or `undefined` for
 * an anonymous one. Moved here from `function-facts.ts` (#5087) so the
 * provider and the metrics name a function the same way: a JS/TS arrow or
 * function expression takes its binding site (`const f = () => …`,
 * `{ prop: () => … }`), a Python lambda its assignment target, anything else
 * its grammar's `name` field.
 */
export function functionName(node: TsNode): string | undefined {
	const type: string = node.type;
	if (type === "function_declaration") {
		return firstChildOfType(node, "identifier")?.text;
	}
	if (type === "method_definition") {
		// The name is the child just before formal_parameters (property_identifier /
		// private / computed / string / number); skip async/get/set modifiers.
		const kids = node.children ?? [];
		const paramsIdx = kids.findIndex(
			(c: TsNode) => c?.type === "formal_parameters",
		);
		for (let i = paramsIdx - 1; i >= 0; i -= 1) {
			const t = kids[i]?.type;
			if (
				t === "property_identifier" ||
				t === "private_property_identifier" ||
				t === "computed_property_name" ||
				t === "string" ||
				t === "number"
			) {
				return kids[i].text;
			}
		}
		return undefined;
	}
	if (type === "arrow_function" || type === "function_expression") {
		const parent = node.parent;
		if (parent?.type === "variable_declarator") {
			return firstChildOfType(parent, "identifier")?.text;
		}
		if (parent?.type === "pair") return (parent.children ?? [])[0]?.text;
		return undefined;
	}
	if (type === "lambda") {
		const parent = node.parent;
		return parent?.type === "assignment"
			? parent.childForFieldName("left")?.text
			: undefined;
	}
	return node.childForFieldName("name")?.text;
}

/** A Go method's receiver type: `func (s *Server) Run()` is `Server`'s. */
function receiverType(fn: TsNode): string | undefined {
	const receiver = fn.childForFieldName("receiver");
	if (!receiver) return undefined;
	let found: string | undefined;
	const visit = (node: TsNode): void => {
		if (found !== undefined) return;
		if (node.type === "type_identifier") {
			found = node.text;
			return;
		}
		for (const child of node.children ?? []) if (child) visit(child);
	};
	visit(receiver);
	return found;
}

/** A container's own name: a class's `name`, a Rust impl's `type`. */
function containerName(node: TsNode): string | undefined {
	return (
		node.childForFieldName("name")?.text ?? node.childForFieldName("type")?.text
	);
}

interface Span {
	priority?: number;
	name: string;
	startLine: number;
	endLine: number;
}

/** The base of an unnamed function's key (see {@link NamedFunctionMetrics.key}). */
export const ANONYMOUS_KEY = "<anonymous>";

/** Shared first-touch and edit keying byte cap (#5087). */
export const MAX_MEASURED_BYTES = 256 * 1024;

/**
 * Give each function its {@link NamedFunctionMetrics.key}: the shared
 * containment rule (strict line ranges, smallest span, first owner on ties)
 * finds the nearest owning class, impl or named function in linear work over
 * owners and source lines. Same-key siblings are numbered in source order.
 */
function assignKeys(
	functions: Array<Omit<NamedFunctionMetrics, "key">>,
	nodes: TsNode[],
	containers: Span[],
	languageId: ComplexityLanguageId,
): NamedFunctionMetrics[] {
	const owners: Span[] = [...containers];
	const declared = nodes.map((node) => functionName(node));
	functions.forEach((fn, i) => {
		const name = declared[i];
		if (name !== undefined)
			owners.push({ name, startLine: fn.line, endLine: fn.endLine });
	});
	owners.forEach((owner, priority) => {
		owner.priority = priority;
	});
	// Stable counting passes order line intervals by start ascending, end
	// descending. Container-first input preserves findOwnerName's tie rule.
	// Sorting by lines also includes later declarations on a shared boundary
	// line; an AST-parent stack alone would change their existing keys.
	const entries = [
		...owners.map((owner) => ({ ...owner, index: -1 })),
		...functions.map((fn, index) => ({
			name: undefined as string | undefined,
			startLine: fn.line,
			endLine: fn.endLine,
			index,
		})),
	];
	const byEnd: (typeof entries)[] = [];
	let lastLine = 0;
	for (const entry of entries) {
		(byEnd[entry.endLine] ??= []).push(entry);
		lastLine = Math.max(lastLine, entry.endLine);
	}
	const byStart: (typeof entries)[] = [];
	for (let line = lastLine; line >= 0; line--) {
		for (const entry of byEnd[line] ?? []) {
			(byStart[entry.startLine] ??= []).push(entry);
		}
	}
	// Distinct syntax siblings can touch on one line. A preceding owner's
	// last line can still strictly contain a one-line target on that boundary.
	const ending: Array<Span | undefined> = [];
	for (const owner of owners) {
		const prior = ending[owner.endLine];
		const span = owner.endLine - owner.startLine;
		if (span > 0 && (!prior || span < prior.endLine - prior.startLine))
			ending[owner.endLine] = owner;
	}
	const open: Span[] = [];
	const ownerNames: Array<string | undefined> = [];
	for (let line = 0; line <= lastLine; line++) {
		for (const entry of byStart[line] ?? []) {
			while (open.length && open[open.length - 1]!.endLine < entry.endLine)
				open.pop();
			const top = open[open.length - 1];
			const equal =
				top?.startLine === entry.startLine && top.endLine === entry.endLine;
			if (entry.index >= 0) {
				let owner = equal ? open[open.length - 2] : top;
				const boundary = ending[entry.endLine];
				if (
					entry.startLine === entry.endLine &&
					boundary &&
					(!owner ||
						boundary.endLine - boundary.startLine <
							owner.endLine - owner.startLine ||
						(boundary.endLine - boundary.startLine ===
							owner.endLine - owner.startLine &&
							boundary.priority! < owner.priority!))
				)
					owner = boundary;
				ownerNames[entry.index] = owner?.name;
			}
			if (entry.name !== undefined && !equal)
				open.push({ ...entry, name: entry.name });
		}
	}
	const seen = new Map<string, number>();
	return functions.map((fn, i) => {
		const node = nodes[i]!;
		const base = declared[i] ?? ANONYMOUS_KEY;
		const owner =
			languageId === "go" && node.type === "method_declaration"
				? receiverType(node)
				: ownerNames[i];
		const qualified = buildQualifiedName(owner, base) ?? base;
		const count = (seen.get(qualified) ?? 0) + 1;
		seen.set(qualified, count);
		return { ...fn, key: count === 1 ? qualified : `${qualified}#${count}` };
	});
}

/** File-level nesting and cognitive complexity, plus every function's metrics. */
export function measureFile(
	root: TsNode,
	languageId: ComplexityLanguageId,
	keyFunctions = true,
): FileMetrics {
	const table = TABLES[languageId];
	const functions: Array<Omit<NamedFunctionMetrics, "key">> = [];
	const nodes: TsNode[] = [];
	const containers: Span[] = [];
	const { cognitive, nesting } = tally(root, table, false, (node, type) => {
		if (keyFunctions && table.containers.has(type)) {
			const name = containerName(node);
			if (name !== undefined)
				containers.push({
					name,
					startLine: node.startPosition.row + 1,
					endLine: node.endPosition.row + 1,
				});
			return;
		}
		// Python's `lambda` keyword token shares its node's type name.
		if (!table.functions.has(type) || !node.isNamed) return;
		const line = node.startPosition.row + 1;
		if (keyFunctions) nodes.push(node);
		functions.push({
			name: functionName(node) ?? `<anonymous@L${line}>`,
			line,
			endLine: node.endPosition.row + 1,
			...measureFunction(node, languageId),
		});
	});
	return {
		cognitive,
		nesting,
		functions: keyFunctions
			? assignKeys(functions, nodes, containers, languageId)
			: functions.map((fn) => ({ ...fn, key: ANONYMOUS_KEY })),
	};
}
