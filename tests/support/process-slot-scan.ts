/**
 * The process-slot scan behind `tests/config/process-slot-sweep.test.ts`
 * (AGENTS.md shape 25, #2146).
 *
 * Question: where does production code keep state on the process-wide objects
 * (`globalThis`, `process`) or in the cross-realm symbol registry
 * (`Symbol.for`), instead of through `getProcessSingleton`
 * (`clients/process-singletons.ts`)? Those three are the only places a
 * module-evaluation-independent slot can live, so a hand-rolled slot has to
 * name one of them.
 *
 * STATE TABLE (the forms the scan ADMITS; every other form is a site):
 *
 * | node                      | admitted when                                                         |
 * |---------------------------|-----------------------------------------------------------------------|
 * | `Symbol`                  | it is the callee of `Symbol(...)`, or the object of a well-known      |
 * |                           | member (`Symbol.iterator`, `asyncIterator`, `dispose`, `asyncDispose`, |
 * |                           | `hasInstance`, `toPrimitive`, `toStringTag`)                          |
 * | `globalThis` / `global`   | never: every value use is a site (a `typeof globalThis` type query    |
 * |                           | is not a value and is skipped)                                        |
 * | `process`                 | it is the object of a member read `process.<name>`, and that member   |
 * |                           | is not the target of an assignment unless the member is a documented  |
 * |                           | writable (`exitCode`, `title`, `env`); a type query is skipped        |
 * | `console`                 | it is the object of a member read, and no member is assigned          |
 *
 * Everything else is reported: `Symbol.for(...)`, `Symbol["for"](...)`, an alias
 * (`const S = Symbol`), a destructure (`const { for: f } = Symbol`), an
 * argument (`Reflect.apply(Symbol.for, ...)`), a bound global
 * (`const g = globalThis`), a cast (`process as typeof process & {...}`), a
 * computed member (`process[key]`), and a write to an undocumented member
 * (`process.__x = 1`). The scan reads cooked syntax trees, so a comment or a
 * string that spells one of these names is never a site.
 *
 * Population rows are `<file>#<anchor>`, the anchor being the enclosing named
 * symbol; a second site in the same symbol carries `#2`, `#3`, so one row
 * never excuses two.
 */
import { ts } from "@ast-grep/napi";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";

export interface ProcessSlotSite {
	anchor: string;
	line: number;
	form: string;
}

/** Well-known symbols hold no registry state; reading one is not a slot. */
const WELL_KNOWN_SYMBOLS: ReadonlySet<string> = new Set([
	"iterator",
	"asyncIterator",
	"dispose",
	"asyncDispose",
	"hasInstance",
	"toPrimitive",
	"toStringTag",
]);

/** `process` members the runtime documents as assignable. */
const WRITABLE_PROCESS_MEMBERS: ReadonlySet<string> = new Set([
	"exitCode",
	"title",
	"env",
]);

const NEEDLE = /\b(?:Symbol|globalThis|global|process|console)\b/;

/** Cheap prefilter: a file that never spells a needle holds no site. */
export function mayHoldProcessSlot(source: string): boolean {
	return NEEDLE.test(source);
}

const ASSIGNMENT_KINDS: ReadonlySet<string> = new Set([
	"assignment_expression",
	"augmented_assignment_expression",
]);

/** The node kind as a string (ast-grep types it as a language-specific union). */
function kindOf(node: SgNode | null | undefined): string {
	return node ? String(node.kind()) : "";
}

function fieldChild(node: SgNode, field: string): SgNode | null {
	return node.field(field);
}

function sameNode(a: SgNode | null, b: SgNode): boolean {
	return a !== null && a.range().start.index === b.range().start.index;
}

function anchorOf(node: SgNode): string {
	for (let cursor: SgNode | null = node.parent(); cursor;) {
		const kind = kindOf(cursor);
		if (
			kind === "function_declaration" ||
			kind === "generator_function_declaration" ||
			kind === "class_declaration" ||
			kind === "method_definition" ||
			(kind === "variable_declarator" && isNamedScope(cursor)) ||
			kind === "public_field_definition"
		) {
			const name = fieldChild(cursor, "name");
			if (name && /^[A-Za-z_$][\w$]*$/.test(name.text())) {
				// A method reads best qualified by its class.
				if (kind === "method_definition") {
					const owner = enclosingClass(cursor);
					return owner ? `${owner}.${name.text()}` : name.text();
				}
				return name.text();
			}
		}
		cursor = cursor.parent();
	}
	return "<module>";
}

/**
 * A declarator names a scope when it binds a function or sits at module level;
 * a local `const` inside a function belongs to that function's anchor instead.
 */
function isNamedScope(declarator: SgNode): boolean {
	const value = fieldChild(declarator, "value");
	if (value && /function|arrow_function|class/.test(kindOf(value))) return true;
	const statement = declarator.parent()?.parent();
	return (
		kindOf(statement) === "program" ||
		(kindOf(statement) === "export_statement" &&
			kindOf(statement?.parent()) === "program")
	);
}

function enclosingClass(node: SgNode): string | undefined {
	for (let cursor: SgNode | null = node.parent(); cursor;) {
		if (kindOf(cursor) === "class_declaration" || kindOf(cursor) === "class") {
			const name = fieldChild(cursor, "name");
			return name?.text();
		}
		cursor = cursor.parent();
	}
	return undefined;
}

function classifySymbol(node: SgNode): string | undefined {
	const parent = node.parent();
	if (!parent) return "symbol-value";
	if (
		kindOf(parent) === "call_expression" &&
		sameNode(fieldChild(parent, "function"), node)
	)
		return undefined;
	if (
		kindOf(parent) === "member_expression" &&
		sameNode(fieldChild(parent, "object"), node)
	) {
		const property = fieldChild(parent, "property")?.text() ?? "";
		if (WELL_KNOWN_SYMBOLS.has(property)) return undefined;
		return property === "for" ? "Symbol.for" : "symbol-member";
	}
	if (kindOf(parent) === "subscript_expression")
		return "symbol-computed-member";
	return "symbol-value";
}

/**
 * `process` and `console` are process-wide objects a slot can hang on:
 * reading a member is admitted, writing one is not unless the runtime documents
 * it (`WRITABLE_MEMBERS`), and every other use of the object as a value is a
 * site.
 */
function classifyHostObject(node: SgNode, label: string): string | undefined {
	const parent = node.parent();
	if (!parent) return `${label}-value`;
	if (kindOf(parent) === "type_query") return undefined;
	if (
		kindOf(parent) === "member_expression" &&
		sameNode(fieldChild(parent, "object"), node)
	) {
		const member = fieldChild(parent, "property")?.text() ?? "";
		const outer = parent.parent();
		const written =
			outer !== null &&
			((ASSIGNMENT_KINDS.has(kindOf(outer)) &&
				sameNode(fieldChild(outer, "left"), parent)) ||
				kindOf(outer) === "update_expression" ||
				(kindOf(outer) === "unary_expression" &&
					outer.text().startsWith("delete")));
		const writable = label === "process" ? WRITABLE_PROCESS_MEMBERS : new Set();
		if (written && !writable.has(member)) return `${label}-member-write`;
		return undefined;
	}
	if (kindOf(parent) === "subscript_expression")
		return `${label}-computed-member`;
	if (kindOf(parent) === "as_expression") return `${label}-cast`;
	return `${label}-value`;
}

function classifyGlobal(node: SgNode): string | undefined {
	if (kindOf(node.parent()) === "type_query") return undefined;
	return "global-object";
}

const FUNCTION_KINDS: ReadonlySet<string> = new Set([
	"function_declaration",
	"function_expression",
	"function",
	"generator_function_declaration",
	"generator_function",
	"arrow_function",
	"method_definition",
]);

const NAME_PATTERN_CACHE = new Map<string, string>();

function identifiersNamed(scope: SgNode | null, name: string): boolean {
	if (!scope) return false;
	let regex = NAME_PATTERN_CACHE.get(name);
	if (!regex) {
		regex = `^${name}$`;
		NAME_PATTERN_CACHE.set(name, regex);
	}
	return scope.findAll({ rule: { kind: "identifier", regex } }).length > 0;
}

/**
 * True when an enclosing scope declares `name` as a value binding (a `const`,
 * `let` or `var` declarator, or a parameter), so the identifier is that
 * local, not the global of the same name. A type-only import binds no value
 * and never shadows.
 */
function isLocallyBound(node: SgNode, name: string): boolean {
	for (let cursor: SgNode | null = node.parent(); cursor;) {
		const kind = kindOf(cursor);
		if (FUNCTION_KINDS.has(kind)) {
			if (identifiersNamed(cursor.field("parameters"), name)) return true;
			if (identifiersNamed(cursor.field("parameter"), name)) return true;
		}
		if (
			kind === "statement_block" ||
			kind === "program" ||
			kind === "class_body"
		) {
			for (const child of cursor.children()) {
				const declaration =
					kindOf(child) === "export_statement"
						? (child.children().find((c) => /declaration/.test(kindOf(c))) ??
							child)
						: child;
				if (
					kindOf(declaration) !== "lexical_declaration" &&
					kindOf(declaration) !== "variable_declaration"
				)
					continue;
				for (const declarator of declaration.children()) {
					if (kindOf(declarator) !== "variable_declarator") continue;
					if (identifiersNamed(declarator.field("name"), name)) return true;
				}
			}
		}
		cursor = cursor.parent();
	}
	return false;
}

/** Every process-slot site in one source file, in source order. */
export function scanProcessSlotSites(source: string): ProcessSlotSite[] {
	const root = ts.parse(source).root();
	const hits: Array<{ node: SgNode; form: string }> = [];
	for (const node of root.findAll({
		rule: {
			kind: "identifier",
			regex: "^(?:Symbol|globalThis|global|process|console)$",
		},
	})) {
		const name = node.text();
		// An imported name is no value use, and a local binding of the same name
		// is not the global.
		if (kindOf(node.parent()) === "import_specifier") continue;
		if (isLocallyBound(node, name)) continue;
		const form =
			name === "Symbol"
				? classifySymbol(node)
				: name === "process" || name === "console"
					? classifyHostObject(node, name)
					: classifyGlobal(node);
		if (form) hits.push({ node, form });
	}
	hits.sort((a, b) => a.node.range().start.index - b.node.range().start.index);
	const ordinals = new Map<string, number>();
	return hits.map(({ node, form }) => {
		const base = anchorOf(node);
		const count = (ordinals.get(base) ?? 0) + 1;
		ordinals.set(base, count);
		return {
			anchor: count > 1 ? `${base}#${count}` : base,
			line: node.range().start.line,
			form,
		};
	});
}
