/**
 * The path-containment detector (#2556): finds a hand-rolled "is this path
 * inside that root" test written over a `path.relative` result. Its state
 * table is `tests/support/path-containment-scan.test.ts`; the census over the
 * repository's source and test trees is
 * `tests/config/path-containment-sweep.test.ts`, whose header lists the forms
 * this detector cannot see.
 *
 * The rule is derived from the seam, not from a list of spellings (AGENTS.md
 * shape 69). `clients/path-utils.ts` owns containment — `isUnderDir`,
 * `isWithinForm`, and the home-ceiling predicate `isAtOrAboveHomeDir` — and
 * every other containment test is a copy of a rule that seam already owns
 * (shape 83). The copies recur because the predicate LOOKS total and is not:
 *
 * - **#4878 F1 (HIGH, `069ff0e`):** `tests/support/vi-mock-export-gate.ts` read
 *   `path.relative(cwd, file)` with `!rel.startsWith("..")`. Across Windows
 *   drives `path.relative` returns an ABSOLUTE path, which does not start with
 *   `..`, so a file on another drive read as inside and 26 cells of
 *   `Unit tests Windows` failed. No Linux lane can see it.
 * - **#4876 review r2 F5:** `tests/config/path-identity-sweep.test.ts` reads
 *   map keys and raw `realpath` calls only, so a containment test over a
 *   relative result is outside every shipped census.
 * - **#4835 residual:** 13 live sites read a `..`-prefixed directory NAME
 *   (`..foo/x`) as outside, because they test the prefix rather than a segment.
 *
 * ## The two halves, and why neither is a spelling list
 *
 * **Value half (which values are relative).** A value derives from a
 * `path.relative` result when it is that call, a name bound to one in any
 * number of hops, or a derived expression over it: a string transform
 * (`.replace(/\\/g, "/")`, `toPosix(…)`, `.split(sep).join("/")`), a segment
 * extraction (`.split(sep)[0]`, `.slice(0, 2)`, `.at(0)`), or an index read
 * (`rel[0]`). None of those can turn an out-of-tree relative into an in-tree
 * one, so all of them read as the same value. The set of derived NAMES is a
 * fixed point over the file's declarators, so a predicate costs one expression
 * walk and never re-explores every binding site (#4882 review F1's first cut
 * re-walked them and cost 17.8 s on one test file).
 *
 * **Predicate half (which uses answer containment).** #4882 review F1: the
 * first cut enumerated one predicate (`startsWith`), so `split(sep)[0] === ".."`,
 * `rel === ".." || isAbsolute(rel)`, `slice(0, 2) === ".."` and
 * `rel[0] + rel[1] === ".."` were all invisible — the same defect in four other
 * spellings. The rule is therefore not a method list: a site is a COMPARISON or
 * a CALL in which a relative-derived value meets a parent-segment literal, in
 * either operand order and in every operator. That admits `===`, `!==`, `==`,
 * `!=`, `<`, `>`, `<=`, `>=`, `startsWith`, `endsWith`, `indexOf`, `includes`,
 * `match`/`test`, `String.prototype.startsWith.call(rel, "..")`, and every
 * spelling nobody has written yet, because none of them is named here.
 *
 * **What a parent-segment literal is.** A string whose TEXT holds a `..`
 * segment at a segment boundary (`".."`, `"../"`, `"..\\"`, `".." + path.sep`,
 * the first fragment of a template), a marker a template SUBSTITUTION carries
 * (`` `${UP}${path.sep}` `` with `const UP = ".."`, #4882 verify r3 N5), the
 * same value reached through a binding (`const UP = ".."`), or a RegExp
 * literal whose source escapes both dots (`/^\.\./`). `"..."` fails the
 * boundary test, so the rest-element prefix (`clients/config-warn.ts`,
 * `clients/middle-man-analysis.ts`, `tests/support/sweep-kit.ts` all spell it)
 * is never read as a parent segment, and `"..foo"` is not a segment either.
 *
 * One boolean chain is one predicate: `relative && relative !== ".." &&
 * !relative.startsWith(…)` answers containment once, so it is one site. A
 * second chain inside the SAME symbol is a second site, and its anchor carries
 * an ordinal (`<title>#2`) so both hold their own baseline row instead of
 * colliding on one key.
 *
 * It parses the file (`@ast-grep/napi`), so a comment is never code and a
 * string is read only by its cooked value: a file that only MENTIONS the
 * spelling (`clients/file-utils.ts` carries such a comment) is not a site.
 *
 * A `relative` callee is the member `.relative` (or `["relative"]`) on any
 * object, or a name this file binds to one: `import { relative }`,
 * `import { relative as rel }`, `const { relative: rel } = path`, or
 * `const rel = path.relative`.
 */
import { Lang, parse } from "@ast-grep/napi";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { cookedIdentifier, cookedString } from "./cooked-literal.js";

export interface PathContainmentSite {
	/** 0-based line of the comparison or call that makes the site. */
	line: number;
	/**
	 * The enclosing named symbol: `Class.method` for a class member, a
	 * `const name = () => {…}` binding, the title of an `it("…", () => {…})`
	 * callback, and `<module>` at file scope. A second predicate inside the same
	 * symbol appends its ordinal (`… #2`), so each site keeps its own row.
	 */
	anchor: string;
	/** Which admitted predicate shape matched, for messages and the state table. */
	form: string;
}

/** Wrappers that keep the value they hold (the path identity detector's set). */
const TRANSPARENT: ReadonlySet<string> = new Set([
	"parenthesized_expression",
	"as_expression",
	"satisfies_expression",
	"non_null_expression",
	"type_assertion",
]);

/** Operators that answer a question about a value rather than transform it. */
const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
	"===",
	"!==",
	"==",
	"!=",
	"<",
	">",
	"<=",
	">=",
]);

/** Operators a predicate chain is built from; one chain is one site. */
const CHAIN_OPERATORS: ReadonlySet<string> = new Set(["&&", "||", "??"]);

function named(node: SgNode): SgNode[] {
	return node
		.children()
		.filter((child) => child.isNamed() && child.kind() !== "comment");
}

function unwrap(node: SgNode): SgNode {
	let current = node;
	while (TRANSPARENT.has(String(current.kind()))) {
		const inner = named(current)[0];
		if (inner === undefined) return current;
		current = inner;
	}
	return current;
}

/** A member access: `a.b`, or `a[k]` (whose name is static only for a literal `k`). */
function isMember(node: SgNode): boolean {
	const kind = node.kind();
	return kind === "member_expression" || kind === "subscript_expression";
}

/** The static name a member reads: `a.b` and `a["b"]`, never a computed key. */
function memberName(member: SgNode): string | undefined {
	if (member.kind() === "subscript_expression") {
		const index = member.field("index");
		if (!index) return undefined;
		const value = unwrap(index);
		const text = value.text();
		if (!isQuoted(text)) return undefined;
		return cookedString(text);
	}
	const property = member.field("property");
	return property ? cookedIdentifier(property.text()) : undefined;
}

function isQuoted(text: string): boolean {
	return text.startsWith('"') || text.startsWith("'") || text.startsWith("`");
}

function argumentsOf(call: SgNode): SgNode[] {
	const args = call.field("arguments");
	return args ? named(args) : [];
}

/** The binding forms both readings of a file need, found in ONE tree walk. */
interface Bindings {
	specifiers: SgNode[];
	pairPatterns: SgNode[];
	declarators: SgNode[];
}

/**
 * A `findAll` is a full tree traversal however few nodes it returns, and the
 * two readings below asked for `variable_declarator` twice and the import and
 * destructuring forms once each. One walk collects all three, each kind in its
 * own tree order.
 */
function bindingsOf(root: SgNode): Bindings {
	const bindings: Bindings = {
		specifiers: [],
		pairPatterns: [],
		declarators: [],
	};
	for (const node of root.findAll({
		rule: {
			any: [
				{ kind: "import_specifier" },
				{ kind: "pair_pattern" },
				{ kind: "variable_declarator" },
			],
		},
	})) {
		const kind = node.kind();
		if (kind === "import_specifier") bindings.specifiers.push(node);
		else if (kind === "pair_pattern") bindings.pairPatterns.push(node);
		else bindings.declarators.push(node);
	}
	return bindings;
}

/** Names this file binds to `relative`: `import { relative as rel }`, `const rel = path.relative`. */
function relativeNames(bindings: Bindings): Set<string> {
	const names = new Set<string>(["relative"]);
	for (const specifier of bindings.specifiers) {
		const parts = named(specifier);
		const imported = parts[0];
		const local = parts[1] ?? parts[0];
		if (imported && local && cookedIdentifier(imported.text()) === "relative")
			names.add(cookedIdentifier(local.text()));
	}
	for (const pair of bindings.pairPatterns) {
		const key = pair.field("key");
		const value = pair.field("value");
		if (
			key &&
			value &&
			cookedIdentifier(key.text()) === "relative" &&
			value.kind() === "identifier"
		)
			names.add(cookedIdentifier(value.text()));
	}
	for (const declarator of bindings.declarators) {
		const name = declarator.field("name");
		const value = declarator.field("value");
		if (!name || !value || name.kind() !== "identifier") continue;
		const held = unwrap(value);
		if (isMember(held) && memberName(held) === "relative")
			names.add(cookedIdentifier(name.text()));
	}
	return names;
}

/** Every declarator initializer in the file, by bound name, for the fixed point. */
function declaratorsByName(bindings: Bindings): Map<string, SgNode[]> {
	const byName = new Map<string, SgNode[]>();
	for (const declarator of bindings.declarators) {
		const name = declarator.field("name");
		const value = declarator.field("value");
		if (!name || !value || name.kind() !== "identifier") continue;
		const key = cookedIdentifier(name.text());
		byName.set(key, [...(byName.get(key) ?? []), value]);
	}
	return byName;
}

interface Reading {
	relativeNames: ReadonlySet<string>;
	declarators: ReadonlyMap<string, readonly SgNode[]>;
}

/**
 * Every name in the file bound (in any number of hops) to a value that keeps
 * one of `seed`'s answers: a fixed point over the declarators, so a name bound
 * in one function counts for a use in another (the r1 reading, kept fail
 * closed) without re-exploring every binding on every query.
 */
function closedOver(
	declarators: ReadonlyMap<string, readonly SgNode[]>,
	seed: (node: SgNode, names: ReadonlySet<string>) => boolean,
): Set<string> {
	const names = new Set<string>();
	for (let changed = true; changed;) {
		changed = false;
		for (const [name, initializers] of declarators) {
			if (names.has(name)) continue;
			// A name already in `names` answers true inside `seed`, which is what
			// makes this loop terminate.
			if (!initializers.some((initializer) => seed(initializer, names)))
				continue;
			names.add(name);
			changed = true;
		}
	}
	return names;
}

function isRelativeCallee(node: SgNode, reading: Reading): boolean {
	const value = unwrap(node);
	if (isMember(value)) return memberName(value) === "relative";
	if (value.kind() === "identifier")
		return reading.relativeNames.has(cookedIdentifier(value.text()));
	return false;
}

/**
 * Does this expression hold (or derive from) a `path.relative` result? Walks
 * the expression only: a name is answered by `derived`, the fixed point over
 * the file's declarators, after the parameter test below.
 */
function derivesFromRelative(
	node: SgNode,
	reading: Reading,
	derived: ReadonlySet<string>,
): boolean {
	const value = unwrap(node);
	switch (value.kind()) {
		case "call_expression": {
			const callee = value.field("function");
			if (callee && isRelativeCallee(callee, reading)) return true;
			// A transform keeps the value it was handed: `.replace`, `toPosix(…)`,
			// `.split(sep)[0]` and `.slice(0, 2)` all keep a parent segment a parent
			// segment. A method this reading does not name is followed too, so an
			// unrecognised conversion is reported instead of silently dropped.
			const receiver =
				callee && isMember(callee) ? callee.field("object") : null;
			if (receiver && derivesFromRelative(receiver, reading, derived))
				return true;
			return argumentsOf(value).some((argument) =>
				derivesFromRelative(argument, reading, derived),
			);
		}
		// A member read or an index read over the value is still the value:
		// `rel.split(sep)[0]`, `parsed.rel`, `rel[0]`.
		case "member_expression":
		case "subscript_expression": {
			const object = value.field("object");
			return object ? derivesFromRelative(object, reading, derived) : false;
		}
		case "identifier": {
			const name = cookedIdentifier(value.text());
			// Both tests are pure, so the cheap set lookup goes first: the parent
			// climb is only worth making for a name that could be derived at all.
			return derived.has(name) && !isEnclosingParameter(value, name);
		}
		case "binary_expression": {
			const left = value.field("left");
			const right = value.field("right");
			return Boolean(
				(left && derivesFromRelative(left, reading, derived)) ||
				(right && derivesFromRelative(right, reading, derived)),
			);
		}
		case "template_string":
			return named(value)
				.filter((child) => child.kind() === "template_substitution")
				.flatMap((child) => named(child))
				.some((child) => derivesFromRelative(child, reading, derived));
		default:
			return false;
	}
}

/**
 * Does this expression hold a parent-segment literal? Reads the cooked value of
 * a string, every static fragment of a template AND what its substitutions
 * bind (`${UP}${path.sep}`), either side of a `+` (the `".." + path.sep`
 * spelling), a RegExp literal whose source escapes both dots, and a name bound
 * to one of those. `"..."` and `"..foo"` fail the boundary test, so a
 * rest-element prefix and a `..`-leading NAME are never read as a parent
 * segment.
 */
function mentionsParentSegment(
	node: SgNode,
	literals: ReadonlySet<string>,
): boolean {
	const value = unwrap(node);
	switch (value.kind()) {
		case "string": {
			const cooked = cookedString(value.text());
			return cooked !== undefined && holdsParentSegment(cooked);
		}
		case "template_string": {
			const children = named(value);
			const substitutions = children.filter(
				(child) => child.kind() === "template_substitution",
			);
			if (substitutions.length === 0) {
				const cooked = cookedString(value.text());
				return cooked !== undefined && holdsParentSegment(cooked);
			}
			// A template that INTERPOLATES the marker keeps it: `${UP}${path.sep}`
			// holds `..` plus a separator when `UP` is bound to `..` (#4882 verify
			// r3 N5), so each substitution is read through the same binding set as
			// a bare name rather than ignored.
			return (
				children
					.filter((child) => child.kind() === "string_fragment")
					.some((child) => holdsParentSegment(child.text())) ||
				substitutions
					.flatMap((child) => named(child))
					.some((child) => mentionsParentSegment(child, literals))
			);
		}
		case "regex":
			return PARENT_SEGMENT_REGEX_SOURCE.test(value.text());
		case "binary_expression": {
			if (value.field("operator")?.text() !== "+") return false;
			const left = value.field("left");
			const right = value.field("right");
			return Boolean(
				(left && mentionsParentSegment(left, literals)) ||
				(right && mentionsParentSegment(right, literals)),
			);
		}
		case "identifier":
			return literals.has(cookedIdentifier(value.text()));
		default:
			return false;
	}
}

/** A `..` SEGMENT: at a path boundary and followed by a boundary or the end. */
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** A RegExp literal whose source escapes both dots — `/^\.\./`, `/\.\.\//`. */
const PARENT_SEGMENT_REGEX_SOURCE = /\\\.\\\./;

function holdsParentSegment(text: string): boolean {
	if (!text.includes("..")) return false;
	return PARENT_SEGMENT.test(text);
}

interface Hit {
	node: SgNode;
	line: number;
	form: string;
}

/** The outermost `&&`/`||`/`??` chain a predicate node belongs to. */
function chainRoot(node: SgNode): SgNode {
	let current = node;
	for (let parent = current.parent(); parent; parent = parent.parent()) {
		const kind = String(parent.kind());
		if (kind === "unary_expression" || TRANSPARENT.has(kind)) {
			current = parent;
			continue;
		}
		if (kind === "binary_expression") {
			const operator = parent.field("operator")?.text();
			if (operator !== undefined && CHAIN_OPERATORS.has(operator)) {
				current = parent;
				continue;
			}
		}
		break;
	}
	return current;
}

/** `Class.method`, a function-valued declarator, a test title, or `<module>`. */
function anchorOf(node: SgNode): string {
	for (let current = node.parent(); current; current = current.parent()) {
		const kind = String(current.kind());
		if (
			kind === "function_declaration" ||
			kind === "generator_function_declaration" ||
			kind === "method_definition"
		) {
			const name = current.field("name");
			if (!name) continue;
			const base = cookedIdentifier(name.text());
			const owner = enclosingClassName(current);
			return owner ? `${owner}.${base}` : base;
		}
		// A `const name = () => {…}` binds a symbol; a `const rel = path.relative(…)`
		// does not, so a site inside a value initializer keeps walking out to the
		// function that owns it.
		if (kind === "variable_declarator") {
			const value = current.field("value");
			const name = current.field("name");
			if (!name || !value || !NAME_BINDING_VALUES.has(String(value.kind())))
				continue;
			return name.text();
		}
		// An anonymous callback is named by the declaration that receives it:
		// `it("…", () => {…})`, `describe("…", …)`. Without this, every block in a
		// test file anchors to `<module>` and two obvious sites collide.
		const title = callbackTitle(current);
		if (title !== undefined) return title;
	}
	return "<module>";
}

/**
 * The enclosing class of a member: the walk from a site meets
 * `method_definition` BEFORE `class_declaration`, so the class has to be read
 * upward from the member itself (#4882 review F3: `Alpha.run` and `Beta.run`
 * both keyed as `run`, and the census reported a collision).
 */
function enclosingClassName(member: SgNode): string | undefined {
	for (let current = member.parent(); current; current = current.parent()) {
		const kind = String(current.kind());
		if (
			kind === "class_declaration" ||
			kind === "class" ||
			kind === "class_expression"
		) {
			const name = current.field("name");
			if (name) return name.text();
		}
	}
	return undefined;
}

/** The title of a call that RECEIVES a callback: `<callee>("title", () => {…})`. */
function callbackTitle(call: SgNode): string | undefined {
	if (call.kind() !== "call_expression") return undefined;
	const args = argumentsOf(call);
	const title = args[0];
	if (!title) return undefined;
	const titleText = title.text();
	if (!isQuoted(titleText)) return undefined;
	const receivesCallback = args
		.slice(1)
		.some((argument) => CALLABLE_KINDS.has(String(unwrap(argument).kind())));
	if (!receivesCallback) return undefined;
	const cooked = cookedString(titleText);
	return cooked === undefined || cooked.length === 0 ? undefined : cooked;
}

/** Function-valued declarator initializers, whose name is the symbol's name. */
const NAME_BINDING_VALUES: ReadonlySet<string> = new Set([
	"arrow_function",
	"function_expression",
	"generator_function",
]);

/** The names a formal-parameter list introduces, by position. */
function parameterNames(fn: SgNode): string[] {
	const parameters = fn.field("parameters");
	if (!parameters) return [];
	return named(parameters).map((parameter) => {
		const inner =
			parameter.field("pattern") ??
			parameter.field("left") ??
			parameter.field("name") ??
			parameter;
		return cookedIdentifier(inner.text());
	});
}

/**
 * True when `name` is a parameter of one of `use`'s enclosing functions. A
 * parameter is a caller-supplied spelling, not a `path.relative` result: the
 * hand-off through a call argument is outside this needle (header, known
 * missed shapes), and reading a same-named binding from a sibling function
 * would be the accident this guard exists to stop.
 */
function isEnclosingParameter(use: SgNode, name: string): boolean {
	for (let current = use.parent(); current; current = current.parent()) {
		if (!CALLABLE_KINDS.has(String(current.kind()))) continue;
		if (parameterNames(current).includes(name)) return true;
	}
	return false;
}

const CALLABLE_KINDS: ReadonlySet<string> = new Set([
	"function_declaration",
	"function_expression",
	"generator_function_declaration",
	"generator_function",
	"method_definition",
	"arrow_function",
]);

/**
 * The census's prefilter. It can only skip WORK: an admitted site always needs
 * a `relative` callee (or a name the file binds to one), so a file that never
 * spells `relative` holds no site. It is ONE condition on purpose (#4882
 * verify r3 N1): a second one on the marker's spelling (`source.includes("..")`)
 * skipped every form written with escapes, which the detector below reports.
 */
export function mayHoldContainment(source: string): boolean {
	return source.includes("relative");
}

/**
 * Every containment predicate over a `path.relative` result in one source.
 * One entry per (symbol, boolean chain): a chain that spells the parent-segment
 * test twice answers the question once.
 *
 * The search runs BACKWARDS from the parent-segment literals: those are rare
 * (a few hundred in the whole census), while comparison and call expressions
 * are hundreds of thousands. Walking every predicate node instead cost 137 s
 * over the census on the authoring host and blew its walk budget.
 */
export function scanPathContainmentSites(
	source: string,
): PathContainmentSite[] {
	const root = parse(Lang.TypeScript, source).root();
	const bindings = bindingsOf(root);
	const reading: Reading = {
		relativeNames: relativeNames(bindings),
		declarators: declaratorsByName(bindings),
	};
	const derived = closedOver(reading.declarators, (node, names) =>
		derivesFromRelative(node, reading, names),
	);
	const literals = closedOver(reading.declarators, (node, names) =>
		mentionsParentSegment(node, names),
	);
	const holds = (node: SgNode): boolean =>
		derivesFromRelative(node, reading, derived);
	const literal = (node: SgNode): boolean =>
		mentionsParentSegment(node, literals);

	const hits: Hit[] = [];
	const seen = new Set<number>();
	const add = (node: SgNode, form: string): void => {
		const key = node.range().start.index;
		if (seen.has(key)) return;
		seen.add(key);
		hits.push({ node, line: node.range().start.line, form });
	};

	for (const predicate of predicatePositions(root, literals)) {
		if (predicate.kind() === "binary_expression") {
			// A comparison answers containment whenever one operand is the relative
			// value and the other is a parent-segment literal, in either order.
			const left = predicate.field("left");
			const right = predicate.field("right");
			if (!left || !right) continue;
			if ((holds(left) && literal(right)) || (holds(right) && literal(left)))
				add(predicate, "comparison");
			continue;
		}
		// A call answers containment whenever the relative value is its receiver
		// and a parent-segment literal is its argument (`rel.startsWith("..")`),
		// its receiver is the literal (`/^\.\./.test(rel)`), or both are
		// arguments (`String.prototype.startsWith.call(rel, "..")`).
		const callee = predicate.field("function");
		const receiver = callee && isMember(callee) ? callee.field("object") : null;
		const args = argumentsOf(predicate);
		const receiverHolds = receiver ? holds(receiver) : false;
		const receiverLiteral = receiver ? literal(receiver) : false;
		const argumentHolds = args.some(holds);
		const argumentLiteral = args.some(literal);
		if (receiverHolds && (argumentLiteral || receiverLiteral))
			add(predicate, "predicate call");
		else if (receiverLiteral && argumentHolds)
			add(predicate, "literal receiver");
		else if (argumentHolds && argumentLiteral)
			add(predicate, "argument hand-off");
	}

	// One chain is one predicate (see header): keep the earliest line.
	const byChain = new Map<string, { anchor: string; hit: Hit }>();
	for (const hit of hits) {
		const chain = chainRoot(hit.node);
		const anchor = anchorOf(hit.node);
		const key = `${chain.range().start.index}:${anchor}`;
		const held = byChain.get(key);
		if (held === undefined || hit.line < held.hit.line)
			byChain.set(key, { anchor, hit });
	}
	const sites = [...byChain.values()]
		.map(({ anchor, hit }) => ({ anchor, line: hit.line, form: hit.form }))
		.sort((a, b) => a.line - b.line);
	// A second predicate in one symbol takes an ordinal, so each site keeps its
	// own row instead of colliding on the symbol's key.
	const ordinals = new Map<string, number>();
	for (const site of sites) {
		const count = ordinals.get(site.anchor) ?? 0;
		ordinals.set(site.anchor, count + 1);
		if (count > 0) site.anchor = `${site.anchor}#${count + 1}`;
	}
	return sites;
}

/**
 * Every comparison or call a parent-segment literal takes part in. A literal
 * is followed up through the transforms that keep it (`".." + path.sep`,
 * parentheses, a template substitution, a cast) to the predicate that reads
 * it, and a literal bound to a name (`const UP = ".."`) is followed to that
 * name's reads, so the named-constant spelling is not a known miss either.
 */
function predicatePositions(
	root: SgNode,
	literals: ReadonlySet<string>,
): SgNode[] {
	const positions = new Set<SgNode>();
	// One walk for the three literal kinds, kept in the order the separate
	// walks produced (strings, templates, regexes): a tie between two hits on
	// one line keeps whichever was added first.
	const strings: SgNode[] = [];
	const templates: SgNode[] = [];
	const regexes: SgNode[] = [];
	for (const node of root.findAll({
		rule: {
			any: [
				{ kind: "string", regex: "\\.\\." },
				{ kind: "template_string", regex: "\\.\\." },
				{ kind: "regex" },
			],
		},
	})) {
		const kind = node.kind();
		if (kind === "string") strings.push(node);
		else if (kind === "template_string") templates.push(node);
		else if (PARENT_SEGMENT_REGEX_SOURCE.test(node.text())) regexes.push(node);
	}
	const literalNodes = [...strings, ...templates, ...regexes];
	for (const literalNode of literalNodes) {
		const own = predicatePositionOf(literalNode);
		if (own) positions.add(own);
	}
	for (const name of literals) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		for (const reference of root.findAll({
			rule: { kind: "identifier", regex: `^${escaped}$` },
		})) {
			const viaName = predicatePositionOf(reference);
			if (viaName) positions.add(viaName);
		}
	}
	return [...positions];
}

/** The predicate a literal (or a name bound to one) is read by, if any. */
function predicatePositionOf(literalNode: SgNode): SgNode | undefined {
	let current = literalNode;
	for (let parent = current.parent(); parent; parent = parent.parent()) {
		const kind = String(parent.kind());
		if (
			TRANSPARENT.has(kind) ||
			kind === "unary_expression" ||
			kind === "template_substitution" ||
			// A template's value carries its substitutions, so a literal read
			// inside one (`${UP}`) still reaches the predicate above it (#4882 r3
			// N5).
			kind === "template_string" ||
			kind === "arguments"
		) {
			current = parent;
			continue;
		}
		// The literal is the RECEIVER here: `/^\.\./.test(rel)`, `"..".localeCompare(rel)`.
		if (kind === "member_expression") {
			const object = parent.field("object");
			if (object && object.id() === current.id()) {
				current = parent;
				continue;
			}
			return undefined;
		}
		if (kind === "binary_expression") {
			const operator = parent.field("operator")?.text();
			// `+` concatenation keeps the literal; a comparison reads it.
			if (operator === "+") {
				current = parent;
				continue;
			}
			return operator !== undefined && COMPARISON_OPERATORS.has(operator)
				? parent
				: undefined;
		}
		if (kind === "call_expression") return parent;
		return undefined;
	}
	return undefined;
}
