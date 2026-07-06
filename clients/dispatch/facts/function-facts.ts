import type { FactProvider } from "../fact-provider-types.js";
import {
	extractFactsFromTree,
	firstChildOfType,
	type TsNode,
	walk,
} from "./tree-sitter-facts.js";

const BOUNDARY_PREFIXES = [
	"fetch",
	"fs.",
	"db.",
	"http",
	"axios",
	"got",
	"req.",
	"res.",
];

export interface FunctionSummary {
	name: string;
	line: number;
	column: number;
	isAsync: boolean;
	hasAwait: boolean;
	hasReturnAwaitCall: boolean;
	statementCount: number;
	parameterCount: number;
	isPassThroughWrapper: boolean;
	passThroughTarget?: string;
	isBoundaryWrapper: boolean;
	/** McCabe cyclomatic complexity (branches + 1) */
	cyclomaticComplexity: number;
	/** Maximum control-flow nesting depth within the function */
	maxNestingDepth: number;
	/** Distinct callees invoked within the function body */
	outgoingCalls: string[];
}

const FUNCTION_TYPES = new Set([
	"function_declaration",
	"method_definition",
	"function_expression",
	"arrow_function",
]);

// Decision points for McCabe complexity (matches the old ts.SyntaxKind set).
const COMPLEXITY_TYPES = new Set([
	"if_statement",
	"for_statement",
	"for_in_statement", // for…of and for…in both parse to for_in_statement
	"while_statement",
	"do_statement",
	"switch_case", // `case` only — `default` (switch_default) is not counted
	"catch_clause",
	"ternary_expression",
]);

// Control structures that increase nesting depth (matches the old set).
const NESTING_TYPES = new Set([
	"if_statement",
	"for_statement",
	"for_in_statement",
	"while_statement",
	"do_statement",
	"switch_statement",
	"try_statement",
]);

const LOGICAL_OPERATORS = new Set(["&&", "||", "??"]);

/** Named children excluding comments — i.e. the "real" statements/args/expressions. */
function namedChildren(node: TsNode): TsNode[] {
	return (node.children ?? []).filter(
		(c: TsNode) => c && c.isNamed && c.type !== "comment",
	);
}

/** First named, non-comment child (e.g. a return statement's returned expression). */
function firstNamedChild(node: TsNode): TsNode | undefined {
	return namedChildren(node)[0];
}

function getBody(node: TsNode): TsNode | undefined {
	// Only block-bodied functions get a summary (expression-bodied arrows have no
	// statement_block — matching the old `!ts.isBlock(body)` skip).
	return firstChildOfType(node, "statement_block");
}

function getParameters(node: TsNode): TsNode[] {
	const fp = firstChildOfType(node, "formal_parameters");
	if (!fp) return [];
	return (fp.children ?? []).filter(
		(c: TsNode) =>
			c &&
			(c.type === "required_parameter" ||
				c.type === "optional_parameter" ||
				c.type === "rest_pattern"),
	);
}

function parameterName(param: TsNode): string {
	return firstNamedChild(param)?.text ?? "";
}

function getFunctionName(node: TsNode): string {
	if (node.type === "function_declaration") {
		return firstChildOfType(node, "identifier")?.text ?? "<anonymous>";
	}
	if (node.type === "method_definition") {
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
		return "<anonymous>";
	}
	if (node.type === "arrow_function" || node.type === "function_expression") {
		// Name comes from the binding site (like the old parent-based lookup):
		// `const f = () => …` / `{ prop: () => … }`.
		const parent = node.parent;
		if (parent?.type === "variable_declarator") {
			const id = firstChildOfType(parent, "identifier");
			if (id) return id.text;
		} else if (parent?.type === "pair") {
			const key = (parent.children ?? [])[0];
			if (key) return key.text;
		}
		return "<anonymous>";
	}
	return "<unknown>";
}

function isCallPassThrough(
	stmt: TsNode,
	paramNames: string[],
): { pass: boolean; target?: string } {
	if (stmt.type !== "return_statement") return { pass: false };
	const expr = firstNamedChild(stmt);
	if (!expr || expr.type !== "call_expression") return { pass: false };

	const argsNode = firstChildOfType(expr, "arguments");
	const args = argsNode ? namedChildren(argsNode).map((a) => a.text) : [];
	if (args.length !== paramNames.length) return { pass: false };
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] !== paramNames[i]) return { pass: false };
	}
	return { pass: true, target: (expr.children ?? [])[0]?.text };
}

function calcCyclomaticComplexity(body: TsNode): number {
	let cc = 1;
	walk(body, (node) => {
		if (COMPLEXITY_TYPES.has(node.type)) {
			cc++;
		} else if (node.type === "binary_expression") {
			if (
				(node.children ?? []).some((c: TsNode) =>
					LOGICAL_OPERATORS.has(c?.type),
				)
			) {
				cc++;
			}
		}
	});
	return cc;
}

function calcMaxNestingDepth(body: TsNode): number {
	let maxDepth = 0;
	const walkDepth = (node: TsNode, depth: number): void => {
		if (depth > maxDepth) maxDepth = depth;
		const next = NESTING_TYPES.has(node.type) ? depth + 1 : depth;
		for (const child of node.children ?? []) {
			if (child) walkDepth(child, next);
		}
	};
	// Start at the body's children at depth 0 (the body block itself isn't counted).
	for (const child of body.children ?? []) {
		if (child) walkDepth(child, 0);
	}
	return maxDepth;
}

function collectOutgoingCalls(body: TsNode): string[] {
	const calls = new Set<string>();
	walk(body, (node) => {
		if (node.type === "call_expression") {
			const callee = (node.children ?? [])[0]?.text ?? "";
			if (callee.length < 80) calls.add(callee);
		}
	});
	return [...calls];
}

function hasAwaitInNode(node: TsNode): boolean {
	let found = false;
	walk(node, (n) => {
		if (n.type === "await_expression") found = true;
	});
	return found;
}

function hasReturnAwaitCall(node: TsNode): boolean {
	let found = false;
	walk(node, (n) => {
		if (n.type !== "return_statement") return;
		const ret = firstNamedChild(n);
		if (ret?.type !== "await_expression") return;
		const awaited = firstNamedChild(ret);
		if (awaited?.type === "call_expression") found = true;
	});
	return found;
}

export const functionFactProvider: FactProvider = {
	id: "fact.file.functions",
	provides: ["file.functionSummaries"],
	requires: ["file.content"],
	appliesTo(ctx) {
		return /\.tsx?$/.test(ctx.filePath);
	},
	async run(ctx, store) {
		await extractFactsFromTree(
			ctx,
			store,
			{ "file.functionSummaries": [] },
			(root) => {
				const summaries: FunctionSummary[] = [];

				const addSummary = (node: TsNode): void => {
					const body = getBody(node);
					if (!body) return;

					const params = getParameters(node);
					const paramNames = params.map(parameterName);
					const statements = namedChildren(body);
					const statementCount = statements.length;

					const passThrough =
						statementCount === 1
							? isCallPassThrough(statements[0], paramNames)
							: { pass: false as const };
					const target = passThrough.target ?? "";
					const lowerTarget = target.toLowerCase();
					const isBoundaryWrapper = BOUNDARY_PREFIXES.some((prefix) =>
						lowerTarget.startsWith(prefix),
					);

					summaries.push({
						name: getFunctionName(node),
						line: node.startPosition.row + 1,
						column: node.startPosition.column + 1,
						isAsync: Boolean(firstChildOfType(node, "async")),
						hasAwait: hasAwaitInNode(body),
						hasReturnAwaitCall: hasReturnAwaitCall(body),
						statementCount,
						parameterCount: params.length,
						isPassThroughWrapper: passThrough.pass,
						passThroughTarget: passThrough.target,
						isBoundaryWrapper,
						cyclomaticComplexity: calcCyclomaticComplexity(body),
						maxNestingDepth: calcMaxNestingDepth(body),
						outgoingCalls: collectOutgoingCalls(body),
					});
				};

				walk(root, (node) => {
					if (FUNCTION_TYPES.has(node.type)) addSummary(node);
				});

				return { "file.functionSummaries": summaries };
			},
		);
	},
};
