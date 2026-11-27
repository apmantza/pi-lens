/**
 * Detector for a flag read whose name the registry never registers (#4946).
 *
 * Recurrence this prevents (#4944, #4946): `pi.getFlag("no-ast-grep")` and
 * `killSwitchFlag: "no-typos"` were read for months while no
 * `clients/lens-flag-registry.ts` entry registered the name, so the host
 * answered `undefined` and the feature behind it could not be switched. The
 * call compiles and runs, so only a cross-file check against the registry can
 * see it.
 *
 * Population: the TypeScript files the caller hands in (`clients/`, `tools/`,
 * `mcp/`, `index.ts`). Input: the raw source, parsed by the census AST seam
 * (`ast-census.ts`). No regex reads source text: a comment is a `comment` node
 * and a string (a template's fixed parts included) is a `string` node, so
 * neither can hold a call or a `<x>Flag` field (a template's `${..}`
 * substitution is code and is scanned), and a comment that quotes
 * `getFlag("x")` is no read (engineering principles §2, detectors match
 * code, not prose; AGENTS.md shape 69). The flag name IS a string
 * literal, so the only strings the scan reads are the first argument of a call
 * it found as code, a string KEY in a field position, and the value a `<x>Flag`
 * field is given.
 *
 * Registered names (the closed set): every `LENS_FLAGS` name the caller passes,
 * plus every literal first argument of a `registerFlag(...)` call in the scanned
 * files (`index.ts` registers `no-tool` outside the registry).
 *
 * ADMITTED forms; every other form the scan reads is REFUSED and reported with
 * file and line. Forms it never reads, so no site is reported, are named under
 * UNREAD below:
 *
 * - R1: a call to a reader whose first argument is a string literal naming a
 *   registered flag.
 * - R2: a field named `<x>Flag` (`killSwitchFlag`, `optInFlag`: the
 *   auxiliary-LSP profile fields `isEnabledByConfiguration` hands to `getFlag`),
 *   however its name is spelled (identifier, quoted or computed string key,
 *   subscript with a string index). The scan keys on the NAME, never on one
 *   write form: every name in a field position is classified by its container,
 *   and a container not listed here is refused. Listed containers: an
 *   object-literal pair, a member or subscript assignment (plain or compound),
 *   a class field with a value, or a destructuring default, whose value is a
 *   string literal naming a registered flag (any other value, and a shorthand
 *   `{ xFlag }`, is refused); a type-level `property_signature` or
 *   `method_signature` (no value); a method call `a.xFlag(..)` (a method, not a
 *   field); and a READ in a context that cannot pass the name on (a comparison,
 *   `!`, a condition, the left side of `&&`). A method or accessor definition,
 *   a destructured read and any other read are refused.
 * - R3: a call to a reader whose first argument is a parameter of the enclosing
 *   function (a forwarder). A forwarder bound to a bare name (`const f = (p) =>
 *   getFlag(p)`, `function f(p)`) makes `f` a reader too, so its callers are
 *   scanned (derived, to a fixpoint). A first argument that reads an R2 field off
 *   a record (`getFlag(profile.killSwitchFlag)`) is refused like any other
 *   non-literal and admitted only by a counted R5 row keyed on the receiver's
 *   spelling: the scan cannot tell which record the receiver holds, so a row
 *   names it and a new receiver or a new site is a new refusal.
 * - R4: a reader named as a call argument, a declaration or parameter name, a
 *   shorthand property, a `pair` key, the value of a `pair` under the same key,
 *   the left side of an assignment, an operand of a comparison, logical or
 *   `!`, the condition of an `if` or ternary, or the operand of a type query.
 * - R5: a {@link FlagReadAdmission} row keyed `file:form`, with a reason and a
 *   site count; a key with more live sites reports every one, one with fewer is
 *   stale.
 *
 * A reader is a callee whose final identifier matches {@link READER_NAME}.
 *
 * RESIDUALS, named (each an admitted form that is too broad): R4's "passed as a
 * call argument" lets the receiving function name its parameter anything and
 * call it with a literal; R3's anonymous forwarder (`(f) => getFlag(f)` handed
 * to a callee) leaves the names to that callee.
 *
 * NOT READ (spellings whose field name is not written in the source, reported
 * to the maintainer, not admitted): a name built at run time (`const k =
 * "killSwitchFlag"; p[k] = ..`, `{ [k]: .. }`), and a forwarder parameter's
 * default value (`function f(name = "x") { getFlag(name) }`). Each needs
 * dataflow the AST seam does not do.
 *
 * UNREAD, accepted residuals (#4960; live population 0 for each flag-name form).
 * The scan emits no site for these, so a flag name written in them is never
 * checked and the ratchet stays green. The PR body records each one as a p3
 * residual with its measured population.
 * - A reader called through a method, a class field or an object-pair key:
 *   `this.pi.getFlag(name)` in `class A { flagOn(name) { .. } }`,
 *   `check = (f) => pi.getFlag(f)` in a class, `{ check: (f) => pi.getFlag(f) }`.
 *   The forwarder's name is no bound name, so its callers are not scanned.
 * - A computed callee with a non-literal index: `pi[g]("x")`, `pi["get" +
 *   "Flag"]("x")`. It has no callee name, so the whole call is skipped. The
 *   measured computed callees are `x[Symbol.iterator]()`, which read no flag.
 * - A reflection write that names a `<x>Flag` field: `Object.defineProperty(p,
 *   "killSwitchFlag", ..)` and `Reflect.set(p, "killSwitchFlag", ..)`.
 */
import type { SgNode } from "@ast-grep/napi";
import { parseNodes } from "./ast-census.js";
import { lineOf } from "./sweep-kit.js";

/** The callee names that read a flag: `getFlag`, `getLensFlag`, `getFlagSource`, ... */
const READER_NAME = /^get\w*Flag\w*$/;

/** A refused site the tree admits under one key: how many, and why none is a defect. */
export type FlagReadAdmission = Readonly<
	Record<string, { readonly count: number; readonly reason: string }>
>;

export interface FlagReadSite {
	readonly file: string;
	readonly line: number;
	/** `file:form`, the admission key. */
	readonly key: string;
	/** What was refused, for the report. */
	readonly detail: string;
}

export interface FlagReadScan {
	/** Every flag name read as a registered literal (R1, R2). */
	readonly literalReads: readonly {
		file: string;
		line: number;
		name: string;
	}[];
	/** The registered names the scan used (registry plus `registerFlag` literals). */
	readonly registered: ReadonlySet<string>;
	/** Refused sites, admitted or not. */
	readonly sites: readonly FlagReadSite[];
	/** Sites no admission covers, or every site of a key with more sites than its row admits. */
	readonly unadmitted: readonly FlagReadSite[];
	/** Admission keys with fewer sites than the row admits. */
	readonly staleAdmissions: readonly string[];
}

const kindOf = (node: SgNode): string => String(node.kind());

const TRANSPARENT = new Set([
	"parenthesized_expression",
	"as_expression",
	"satisfies_expression",
	"non_null_expression",
]);

const FUNCTIONS = new Set([
	"arrow_function",
	"function_declaration",
	"function_expression",
	"function",
	"method_definition",
	"generator_function",
	"generator_function_declaration",
]);

/** A call's first argument node. Nothing is visited: it indexes the argument list. */
const firstArgument = (call: SgNode): SgNode | undefined =>
	call.field("arguments")?.namedChildren()[0];

/** The value of a string literal node, or undefined for anything else (template substitutions included). */
function literalValue(node: SgNode): string | undefined {
	const text = node.text();
	if (kindOf(node) === "string") return text.slice(1, -1);
	if (kindOf(node) === "template_string" && !text.includes("${"))
		return text.slice(1, -1);
	return undefined;
}

const unwrap = (node: SgNode): SgNode => {
	let current = node;
	while (TRANSPARENT.has(kindOf(current))) {
		const inner = current.namedChildren()[0];
		if (!inner) break;
		current = inner;
	}
	return current;
};

/** The final identifier a callee names, and whether it is a computed (string-keyed) access. */
function calleeName(callee: SgNode): { name?: string; computed: boolean } {
	const node = unwrap(callee);
	const kind = kindOf(node);
	if (kind === "identifier") return { name: node.text(), computed: false };
	if (kind === "member_expression")
		return { name: node.field("property")?.text(), computed: false };
	if (kind === "subscript_expression") {
		const index = node.field("index");
		const value = index ? literalValue(index) : undefined;
		return { name: value, computed: true };
	}
	return { computed: false };
}

/** The reference expression `node` is part of, climbing `a.<node>` and wrappers. */
function referenceOf(node: SgNode): SgNode {
	let current = node;
	for (;;) {
		const parent = current.parent();
		if (!parent) return current;
		if (
			TRANSPARENT.has(kindOf(parent)) ||
			(kindOf(parent) === "member_expression" &&
				parent.field("property")?.range().start.index ===
					current.range().start.index &&
				parent.field("property")?.range().end.index ===
					current.range().end.index)
		)
			current = parent;
		else return current;
	}
}

const sameNode = (a: SgNode | null | undefined, b: SgNode): boolean =>
	a !== null &&
	a !== undefined &&
	a.range().start.index === b.range().start.index &&
	a.range().end.index === b.range().end.index;

/** Why a reader reference is refused, or undefined when an admitted context holds it (R4). */
function refusedContext(identifier: SgNode): string | undefined {
	const ref = referenceOf(identifier);
	const parent = ref.parent();
	if (!parent) return undefined;
	const kind = kindOf(parent);
	// The callee of a call is checked at the call; an argument is R4.
	if (kind === "call_expression" || kind === "arguments") return undefined;
	if (kind === "pair")
		return sameNode(parent.field("key"), ref) ||
			parent.field("key")?.text() === identifier.text()
			? undefined
			: `pair value under another key \`${parent.field("key")?.text()}\``;
	if (kind === "assignment_expression")
		return sameNode(parent.field("left"), ref)
			? undefined
			: "right-hand side of an assignment";
	if (kind === "binary_expression" || kind === "unary_expression")
		return undefined;
	if (kind === "ternary_expression")
		return sameNode(parent.field("condition"), ref)
			? undefined
			: "ternary branch";
	// `typeof getFlag` in a type position names the type; nothing can call it.
	if (kind === "if_statement" || kind === "type_query") return undefined;
	if (kind === "import_specifier" || kind === "export_specifier")
		return parent.field("alias")
			? `aliased by \`${parent.field("alias")?.text()}\``
			: undefined;
	// A declaration or parameter name keeps the name.
	if (
		["name", "pattern"].some((field) => sameNode(parent.field(field), ref)) &&
		kind !== "pair_pattern"
	)
		return undefined;
	if (
		kind === "shorthand_property_identifier" ||
		kind === "shorthand_property_identifier_pattern"
	)
		return undefined;
	if (kind === "member_expression")
		return `object of \`.${parent.field("property")?.text()}\``;
	if (kind === "variable_declarator") return "right-hand side of a binding";
	return `form \`${kind}\``;
}

/** The innermost enclosing function node. */
function enclosingFunction(node: SgNode): SgNode | undefined {
	for (let at = node.parent(); at; at = at.parent())
		if (FUNCTIONS.has(kindOf(at))) return at;
	return undefined;
}

function parameterNames(fn: SgNode): Set<string> {
	const names = new Set<string>();
	const single = fn.field("parameter");
	if (single) names.add(single.text());
	for (const param of fn.field("parameters")?.namedChildren() ?? []) {
		const pattern = param.field("pattern") ?? param;
		if (kindOf(pattern) === "identifier") names.add(pattern.text());
	}
	return names;
}

/** The bare name a function is bound to (`const f = ..`, `function f`), the only names a forwarder lends the reader set. */
function boundName(fn: SgNode): string | undefined {
	if (kindOf(fn) === "function_declaration") return fn.field("name")?.text();
	const parent = fn.parent();
	return parent && kindOf(parent) === "variable_declarator"
		? parent.field("name")?.text()
		: undefined;
}

/** A name that ends in `Flag` and is not a reader: a field that carries a flag name. */
const isFlagFieldName = (name: string | undefined): name is string =>
	name !== undefined && /Flag$/.test(name) && !READER_NAME.test(name);

/**
 * The static field name a node spells in a NAME position, and the node that
 * stands in the parent's name slot (a computed `["x"]` key is wrapped, a bare
 * identifier or string is the slot itself). Anything else returns undefined:
 * a value, a callee, a local variable.
 */
function fieldNameAt(
	node: SgNode,
	kind: string,
): { name: string; slot: SgNode } | undefined {
	if (
		kind === "property_identifier" ||
		kind === "shorthand_property_identifier" ||
		kind === "shorthand_property_identifier_pattern"
	)
		return { name: node.text(), slot: node };
	if (kind !== "string" && kind !== "template_string") return undefined;
	const value = literalValue(node);
	const parent = node.parent();
	if (value === undefined || !parent) return undefined;
	if (kindOf(parent) === "computed_property_name")
		return { name: value, slot: parent };
	const slotField =
		kindOf(parent) === "subscript_expression"
			? "index"
			: ["pair", "pair_pattern"].includes(kindOf(parent))
				? "key"
				: ["public_field_definition", "property_signature"].includes(
							kindOf(parent),
					  )
					? "name"
					: undefined;
	return slotField && sameNode(parent.field(slotField), node)
		? { name: value, slot: node }
		: undefined;
}

/** True when `node` is the callee of the call it sits in (`a.xFlag(...)`: a method, not a field). */
const isCallee = (node: SgNode): boolean => {
	const parent = node.parent();
	return (
		parent !== null &&
		kindOf(parent) === "call_expression" &&
		sameNode(parent.field("function"), node)
	);
};

const COMPARISONS = new Set(["===", "!==", "==", "!="]);

/**
 * Why a read of a `<x>Flag` field is refused, or undefined when an admitted
 * context holds it. The field's value is a flag NAME; a context that cannot
 * pass the name on is admitted (a comparison, a negation, a condition, the
 * left side of `&&`). The first argument of a reader call is reported by the
 * call itself, so it returns `"reader"` and the caller skips it.
 */
function refusedFieldRead(
	ref: SgNode,
	isReader: (name: string | undefined) => boolean,
): string | undefined | "reader" {
	const parent = ref.parent();
	if (!parent) return `read as a top-level expression`;
	const kind = kindOf(parent);
	if (kind === "arguments") {
		const call = parent.parent();
		const first = call ? firstArgument(call) : undefined;
		const name = call
			? calleeName(call.field("function") as SgNode).name
			: undefined;
		if (call && sameNode(first, ref) && isReader(name)) return "reader";
		return `read as an argument of \`${call?.field("function")?.text()}\``;
	}
	if (kind === "unary_expression") return undefined;
	if (kind === "binary_expression") {
		const operator = parent.field("operator")?.text() ?? "";
		if (COMPARISONS.has(operator)) return undefined;
		if (operator === "&&" && sameNode(parent.field("left"), ref))
			return undefined;
		return `read as an operand of \`${operator}\``;
	}
	if (kind === "if_statement" || kind === "while_statement") return undefined;
	if (kind === "ternary_expression")
		return sameNode(parent.field("condition"), ref)
			? undefined
			: "read as a ternary branch";
	return `read as form \`${kind}\``;
}

/**
 * Scan source texts. `files` maps a repo-relative path to its raw source;
 * `registeredByRegistry` is the registry's names; `admitted` is the R5 table.
 */
export function scanFlagReads(
	files: Readonly<Record<string, string>>,
	registeredByRegistry: Iterable<string>,
	admitted: FlagReadAdmission = {},
): FlagReadScan {
	const parsed = Object.entries(files).map(([file, raw]) => {
		const nodes = parseNodes(raw);
		// Each node's kind is asked once here; every pass below reads this array
		// (`node.kind()` is a native call plus a string allocation, and three
		// whole-file passes ask the same node the same question).
		const kinds = nodes.map(kindOf);
		const calls = nodes.filter((_, i) => kinds[i] === "call_expression");
		return { file, text: raw, nodes, kinds, calls };
	});
	const registered = new Set(registeredByRegistry);
	for (const { calls } of parsed)
		for (const node of calls) {
			const { name } = calleeName(node.field("function") as SgNode);
			if (name !== "registerFlag") continue;
			const first = firstArgument(node);
			const value = first ? literalValue(first) : undefined;
			if (value !== undefined) registered.add(value);
		}

	const readers = new Set<string>();
	const isReader = (name: string | undefined): boolean =>
		name !== undefined && (READER_NAME.test(name) || readers.has(name));

	// R3 fixpoint: a forwarder bound to a bare name is a reader too.
	for (let grew = true; grew;) {
		grew = false;
		for (const { calls } of parsed)
			for (const node of calls) {
				const { name } = calleeName(node.field("function") as SgNode);
				if (!isReader(name)) continue;
				const first = firstArgument(node);
				const fn = enclosingFunction(node);
				if (!first || !fn || kindOf(first) !== "identifier") continue;
				if (!parameterNames(fn).has(first.text())) continue;
				const bound = boundName(fn);
				if (bound !== undefined && !readers.has(bound)) {
					readers.add(bound);
					grew = true;
				}
			}
	}

	const literalReads: FlagReadScan["literalReads"][number][] = [];
	const sites: FlagReadSite[] = [];
	const refuse = (file: string, text: string, node: SgNode, form: string) =>
		sites.push({
			file,
			line: lineOf(text, node.range().start.index),
			key: `${file}:${form}`,
			detail: form,
		});
	const checkLiteral = (
		file: string,
		text: string,
		node: SgNode,
		value: string,
		form: string,
	) => {
		if (registered.has(value))
			literalReads.push({
				file,
				line: lineOf(text, node.range().start.index),
				name: value,
			});
		else refuse(file, text, node, `unregistered ${form} \`${value}\``);
	};

	/** A value assigned to a `<x>Flag` field: a registered literal, or refused (R2). */
	const checkValue = (
		file: string,
		text: string,
		name: string,
		value: SgNode | undefined,
		at: SgNode,
	) => {
		const literal = value ? literalValue(value) : undefined;
		if (literal === undefined)
			refuse(file, text, at, `${name} without a literal name`);
		else checkLiteral(file, text, value as SgNode, literal, name);
	};
	/**
	 * Every `<x>Flag` name in a NAME position goes through here, however it is
	 * spelled (R2). The container decides; every container not listed is refused,
	 * so a spelling nobody planned for is a refusal, not a pass.
	 */
	const checkField = (
		file: string,
		text: string,
		name: string,
		slot: SgNode,
	) => {
		const container = slot.parent();
		if (!container) return;
		const kind = kindOf(container);
		const valueOf = (value: SgNode | null | undefined) =>
			checkValue(file, text, name, value ?? undefined, slot);
		if (kind === "pair" && sameNode(container.field("key"), slot))
			return valueOf(container.field("value"));
		if (kind === "object" || kind === "object_assignment_pattern")
			// `{ xFlag }` (shorthand: a binding, never a literal) or the default of
			// a destructured field.
			return kind === "object"
				? valueOf(undefined)
				: valueOf(container.field("right"));
		if (kind === "public_field_definition")
			return container.field("value")
				? valueOf(container.field("value"))
				: undefined;
		// A type-level slot holds no value. A method DEFINITION does (a getter
		// returns the name), so it is not listed and falls to the refusal below.
		if (["property_signature", "method_signature"].includes(kind)) return;
		if (kind === "member_expression" || kind === "subscript_expression") {
			if (isCallee(container)) return; // a method named `<x>Flag`, not a field
			const ref = referenceOf(container);
			const parent = ref.parent();
			if (
				parent &&
				["assignment_expression", "augmented_assignment_expression"].includes(
					kindOf(parent),
				) &&
				sameNode(parent.field("left"), ref)
			)
				return valueOf(parent.field("right"));
			const why = refusedFieldRead(ref, isReader);
			if (why === "reader") return; // the call reports its own first argument
			if (why !== undefined) refuse(file, text, slot, `${ref.text()} ${why}`);
			return;
		}
		refuse(file, text, slot, `${name} as form \`${kind}\``);
	};

	for (const { file, text, nodes, kinds } of parsed)
		for (const [at, node] of nodes.entries()) {
			const kind = kinds[at] as string;
			if (kind === "call_expression") {
				const callee = node.field("function") as SgNode;
				const { name, computed } = calleeName(callee);
				if (!isReader(name)) continue;
				if (computed) {
					refuse(file, text, node, `computed reader \`[${name}]\``);
					continue;
				}
				const first = firstArgument(node);
				if (!first) {
					refuse(file, text, node, `${name}() with no flag name`);
					continue;
				}
				const value = literalValue(first);
				if (value !== undefined) {
					checkLiteral(file, text, first, value, `${name}(...)`);
					continue;
				}
				const fn = enclosingFunction(node);
				if (
					kindOf(first) === "identifier" &&
					fn !== undefined &&
					parameterNames(fn).has(first.text())
				)
					continue; // R3: a forwarder
				refuse(file, text, node, `${callee.text()}(${first.text()})`);
			} else if (
				(kind === "identifier" || kind === "property_identifier") &&
				isReader(node.text())
			) {
				const why = refusedContext(node);
				if (why !== undefined)
					refuse(file, text, node, `${node.text()} as ${why}`);
			} else if (kind === "subscript_expression") {
				const index = node.field("index");
				const value = index ? literalValue(index) : undefined;
				if (isReader(value) && sameNode(referenceOf(node), node)) {
					const parent = node.parent();
					if (!parent || kindOf(parent) !== "call_expression")
						refuse(file, text, node, `computed reader \`[${value}]\``);
				}
			}
			const field = fieldNameAt(node, kind);
			if (field === undefined || !isFlagFieldName(field.name)) continue;
			checkField(file, text, field.name, field.slot);
		}

	const counts = new Map<string, number>();
	for (const site of sites)
		counts.set(site.key, (counts.get(site.key) ?? 0) + 1);
	const unadmitted = sites.filter((site) => {
		const row = admitted[site.key];
		return row === undefined || (counts.get(site.key) ?? 0) > row.count;
	});
	const staleAdmissions = Object.entries(admitted)
		.filter(([key, row]) => (counts.get(key) ?? 0) < row.count)
		.map(([key]) => key);
	return { literalReads, registered, sites, unadmitted, staleAdmissions };
}
