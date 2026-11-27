/**
 * One parsed-source reader for the delivery-surface ratchet (#5554 r2, F8).
 *
 * It replaces the regex scan that read markers out of comment-blanked text:
 * the parser decides what is a string, a template, a regex or a comment, so a
 * marker or a clean claim in a comment never counts, and an escape is read by
 * value without a second decoder.
 *
 * Two readers share the walk:
 * - `literalValues`: every string, template and regex literal with its decoded
 *   value (the finding-marker scan reads markers by value from these), plus
 *   every `String.fromCodePoint` / `fromCharCode` site, evaluated when its
 *   arguments are numeric literals and reported unclassified otherwise.
 * - `outputSites`: the census population. Every top-level string or template
 *   literal that can be emitted (not a module specifier, not inside a type,
 *   not nested in another template, not in a read-only position such as a
 *   comparison operand or a key), keyed by its source text.
 */
import { parseSync } from "oxc-parser";

interface AstNode {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

const NUMERIC_LITERAL =
	/^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*)$/;
const CODE_POINT_NAMES = new Set(["fromCodePoint", "fromCharCode"]);

/** Subtrees that only describe types: nothing in them reaches an output. */
const TYPE_ONLY = new Set([
	"TSTypeAnnotation",
	"TSTypeAliasDeclaration",
	"TSInterfaceDeclaration",
	"TSTypeParameterInstantiation",
	"TSTypeParameterDeclaration",
	"TSLiteralType",
	"TSImportType",
	"TSExternalModuleReference",
]);

function isNode(value: unknown): value is AstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

function parse(file: string, source: string): AstNode {
	const { program, errors } = parseSync(file, source);
	if (errors.length > 0)
		throw new Error(`${file}: parse failed: ${errors[0]?.message}`);
	return program as unknown as AstNode;
}

/** Depth-first walk with the parent; `enter` returning false skips a subtree. */
function walk(
	node: AstNode,
	enter: (node: AstNode, parent: AstNode | undefined) => boolean | undefined,
	parent?: AstNode,
): void {
	if (enter(node, parent) === false) return;
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		if (Array.isArray(value)) {
			for (const child of value) if (isNode(child)) walk(child, enter, node);
		} else if (isNode(value)) walk(value, enter, node);
	}
}

function lineAt(source: string): (offset: number) => number {
	const starts = [0];
	for (let i = 0; i < source.length; i++)
		if (source.charCodeAt(i) === 10) starts.push(i + 1);
	return (offset) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (starts[mid]! <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};
}

function isModuleSpecifier(node: AstNode, parent: AstNode | undefined) {
	if (!parent) return false;
	return (
		((parent.type === "ImportDeclaration" ||
			parent.type === "ExportNamedDeclaration" ||
			parent.type === "ExportAllDeclaration" ||
			parent.type === "ImportExpression") &&
			parent.source === node) ||
		(parent.type === "CallExpression" &&
			isNode(parent.callee) &&
			parent.callee.type === "Identifier" &&
			parent.callee.name === "require")
	);
}

/** `String.<name>` or `String["<name>"]`: the property name, else undefined. */
function stringMember(node: AstNode): string | undefined | null {
	if (node.type !== "MemberExpression") return undefined;
	const object = node.object;
	if (
		!isNode(object) ||
		object.type !== "Identifier" ||
		object.name !== "String"
	)
		return undefined;
	const property = node.property;
	if (!isNode(property)) return null;
	if (!node.computed && property.type === "Identifier")
		return String(property.name);
	if (property.type === "Literal" && typeof property.value === "string")
		return property.value;
	return null; // `String[key]`: a member the reader cannot name
}

export interface LiteralValue {
	line: number;
	/** The decoded value, or undefined when the reader cannot evaluate it. */
	value: string | undefined;
}

/**
 * Every literal value and code-point construction in `source`. A value with
 * a lone surrogate half is reported as undefined: it may be one half of a
 * marker assembled elsewhere.
 */
export function literalValues(file: string, source: string): LiteralValue[] {
	const line = lineAt(source);
	const out: LiteralValue[] = [];
	const push = (offset: number, value: string | undefined) => {
		const lone =
			value !== undefined &&
			/[\uD800-\uDFFF]/.test(
				value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
			);
		out.push({ line: line(offset), value: lone ? undefined : value });
	};
	walk(parse(file, source), (node, parent) => {
		if (node.type === "Literal") {
			if (typeof node.value === "string") push(node.start, node.value);
			const regex = node.regex as { pattern?: string } | undefined;
			if (regex?.pattern !== undefined) push(node.start, regex.pattern);
			return undefined;
		}
		if (node.type === "TemplateElement") {
			const cooked = (node.value as { cooked?: string | null }).cooked;
			push(node.start, cooked ?? undefined);
			return undefined;
		}
		const name = stringMember(node);
		if (name === undefined) return undefined;
		if (name === null) {
			push(node.start, undefined);
			return undefined;
		}
		if (!CODE_POINT_NAMES.has(name)) return undefined;
		const called = parent?.type === "CallExpression" && parent.callee === node;
		if (!called) {
			push(node.start, undefined); // a reference: called somewhere unseen
			return undefined;
		}
		const args = (parent.arguments as AstNode[]).map((arg) =>
			source.slice(arg.start, arg.end).trim(),
		);
		if (!args.every((arg) => NUMERIC_LITERAL.test(arg))) {
			push(node.start, undefined);
			return undefined;
		}
		const units = args.map((arg) => Number(arg.replace(/_/g, "")));
		push(
			node.start,
			name === "fromCodePoint"
				? String.fromCodePoint(...units)
				: String.fromCharCode(...units),
		);
		return undefined;
	});
	return out.sort((a, b) => a.line - b.line);
}

export interface OutputSite {
	/** The literal's source text with whitespace runs collapsed: its identity. */
	key: string;
	/** The literal's source text. */
	text: string;
	line: number;
	start: number;
	end: number;
}

const COMPARISON = new Set(["===", "!==", "==", "!=", "in"]);

/**
 * A literal in a position whose value is only read, never emitted: a
 * comparison or `in` operand, a `case` test, a non-computed key, a computed
 * member key, or a directive. Admitted by position (a short known-good list),
 * so a literal anywhere else stays in the census.
 */
function isReadOnlyPosition(node: AstNode, parent: AstNode | undefined) {
	if (!parent) return false;
	switch (parent.type) {
		case "BinaryExpression":
			return COMPARISON.has(String(parent.operator));
		case "SwitchCase":
			return parent.test === node;
		case "Property":
		case "PropertyDefinition":
		case "MethodDefinition":
		case "TSEnumMember":
			return parent.key === node && parent.computed !== true;
		case "MemberExpression":
			return parent.property === node;
		case "ExpressionStatement":
			return typeof parent.directive === "string";
		default:
			return false;
	}
}

/** Every top-level string or template literal that can reach an output. */
export function outputSites(file: string, source: string): OutputSite[] {
	const line = lineAt(source);
	const out: OutputSite[] = [];
	walk(parse(file, source), (node, parent) => {
		if (TYPE_ONLY.has(node.type)) return false;
		const literal =
			(node.type === "Literal" && typeof node.value === "string") ||
			node.type === "TemplateLiteral";
		if (!literal) return undefined;
		if (isModuleSpecifier(node, parent)) return false;
		if (isReadOnlyPosition(node, parent)) return false;
		const text = source.slice(node.start, node.end);
		out.push({
			key: text.replace(/\s+/g, " "),
			text,
			line: line(node.start),
			start: node.start,
			end: node.end,
		});
		return false; // a template's nested literals are part of its site
	});
	return out;
}

/** Source text with whitespace and optional-chaining dots folded away. */
function codeText(source: string, node: AstNode): string {
	return source
		.slice(node.start, node.end)
		.replace(/\s+/g, "")
		.replace(/\?\./g, ".");
}

export interface GuardEvidence {
	/** The enclosing statement reads `guard` as code (not inside a literal). */
	referenced: boolean;
	/**
	 * The initializer of the nearest declaration of `guard` that precedes the
	 * site in an enclosing function or the module, or undefined.
	 */
	init: string | undefined;
}

/**
 * How the site at `start` is guarded: whether its smallest enclosing
 * statement reads `guard` (an identifier, or a member chain such as
 * `verdict.checked`), and what `guard` was initialised from.
 */
export function guardEvidence(
	file: string,
	source: string,
	start: number,
	guard: string,
): GuardEvidence {
	const program = parse(file, source);
	let statement: AstNode | undefined;
	const scopes: AstNode[] = [];
	walk(program, (node) => {
		if (node.start > start || node.end <= start) return false;
		if (/Statement$|Declaration$/.test(node.type) && node.type !== "Program")
			statement = node;
		if (/Function|Program/.test(node.type)) scopes.push(node);
		return undefined;
	});
	let referenced = false;
	if (statement)
		walk(statement, (node) => {
			if (
				(node.type === "Identifier" && node.name === guard) ||
				(node.type === "MemberExpression" && codeText(source, node) === guard)
			)
				referenced = true;
			return !referenced;
		});
	let init: AstNode | undefined;
	for (const scope of scopes.reverse()) {
		walk(scope, (node) => {
			if (node.start >= start) return false;
			if (
				node.type === "VariableDeclarator" &&
				isNode(node.id) &&
				node.id.type === "Identifier" &&
				node.id.name === guard &&
				isNode(node.init)
			)
				init = node.init;
			return undefined;
		});
		if (init) break;
	}
	return {
		referenced,
		init: init ? source.slice(init.start, init.end) : undefined,
	};
}

/**
 * Every value written to a property named `field`: an object literal's
 * `field: value` (shorthand included) and `x.field = value`, with the value's
 * source and offset.
 */
export function fieldWrites(
	file: string,
	source: string,
	field: string,
): { value: string; start: number }[] {
	const out: { value: string; start: number }[] = [];
	const push = (node: AstNode) =>
		out.push({ value: source.slice(node.start, node.end), start: node.start });
	walk(parse(file, source), (node) => {
		if (
			node.type === "Property" &&
			node.computed !== true &&
			isNode(node.key) &&
			((node.key.type === "Identifier" && node.key.name === field) ||
				(node.key.type === "Literal" && node.key.value === field)) &&
			isNode(node.value)
		)
			push(node.value);
		if (
			node.type === "AssignmentExpression" &&
			isNode(node.left) &&
			node.left.type === "MemberExpression" &&
			isNode(node.left.property) &&
			node.left.property.type === "Identifier" &&
			node.left.property.name === field &&
			isNode(node.right)
		)
			push(node.right);
		return undefined;
	});
	return out;
}
