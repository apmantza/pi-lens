/**
 * #3763 item 5 / #3824 S2 / #3937 — the mutation bridge's epoch/lineage
 * population.
 *
 * The bridge accepts a foreign `readGuardBranchEpoch` on an entry and resolves
 * it against the live read guard. A well-formed value ABOVE the live epoch is
 * ignored and recorded (never silently skipped), and the entry is then
 * fail-open: it is credited and queued at the current epoch. That direction is
 * safe only because a producer that can name an epoch also captured the
 * lineage that answers currency (the in-process settled sweep). The bridge
 * exposes no epoch to read, so a producer without a lineage cannot learn one;
 * a no-lineage entry carrying an epoch is therefore an invented value.
 *
 * This sweep pins that population: every construction site that can send an
 * epoch into the bridge must also send `lineage`. A future producer that sends
 * an epoch without a lineage reds here, at the construction site, before it can
 * reach the fail-open branch. The behavioural half — that the one real
 * producer's entry carries both — is pinned in
 * `tests/index-observed-sweep-no-read-guard.test.ts`. The producer runtime pin
 * is unchanged and remains the independent witness for released writers.
 *
 * ## #3937: the spread blind spot
 *
 * The first cut read the CALL-SITE object literal's field names. A producer
 * that forwards a previously built object through a spread
 * (`const hidden = { ...entry, readGuardBranchEpoch: 5 };
 * replayThroughMutationBridge({ ...hidden })`) never spells the field at the
 * call site, so it escaped the census entirely — the spelling-enumerator
 * defect shape (AGENTS.md 34). The #3824 follow-up quoted that fixture.
 *
 * This version folds bounded LOCAL provenance instead of matching spellings.
 * Each expression resolves to at most sixteen possible OUTPUTS, of which at
 * most fourteen are reachable (`absent` never coexists with `unknown`); the
 * profiles are deduped, never capped, so no alternative is dropped. An output
 * records whether an epoch is present, what the `lineage` field's VALUE is
 * known to be, and whether an unresolved part could add or overwrite census
 * keys. The runtime fence is value-based (`clients/mutation-bridge.ts`: the
 * entry is dropped only when `lineage !== undefined` and the guard refuses), so
 * the census asks the same question: `safe` requires a lineage value the fold
 * can prove is not `undefined`. A key that is present but nullable or built by
 * a call is INDETERMINATE, never `safe`, and never described as runtime-safe.
 * The verdict is taken per output, so a conditional's lineage arm cannot
 * launder its epoch-only sibling:
 *
 *   * an object-literal argument contributes its explicit keys (`pair`,
 *     shorthand, method, and a computed STRING-literal key — an unlisted
 *     spelling of the same explicit key), plus the keys of every spread;
 *   * ONLY a literal object written at the call site is folded. A bound object
 *     is OPAQUE: `const h = { … }` captures a heap object, and a later statement
 *     can reach that same object through a property value, an array slot, an
 *     assignment RHS, a conditional arm, a destructuring source, a nested call
 *     argument, or a bare alias (`const other = h`) and mutate it. The fold
 *     cannot enumerate those spellings (AGENTS.md 34 — the r4 single-spelling
 *     `const b = a` relation read every other carrier as SAFE), so it proves
 *     NOTHING about a binding, only about the literal at the call site;
 *   * `a ? b : c` unions both arms as separate outputs; `a && b` contributes
 *     its right operand only when `a` can be truthy, and nothing when `a` is
 *     falsy, because a falsy operand spreads no keys; `a || b` / `a ?? b`
 *     union both operands;
 *   * a parameter, an import, a call result, a cross-file name, a computed key
 *     with a template substitution, or a string/template literal carrying an
 *     escape this fold does not decode is UNRESOLVED. `Object.assign(…)` is a
 *     call result and is UNRESOLVED too: folding it would fold the object it
 *     mutates and returns, which is the same opaque binding by another name.
 *
 * The lineage value is folded beside its presence, because presence alone is
 * the r2 false-safe: `undefined` / `void 0` is not a lineage, a non-`undefined`
 * literal or a constructor is, and **anything else** — a name, a call, a member
 * read, a parameter, an import, `null` — is MAYBE: present but unproven, hence
 * indeterminate beside an epoch. The fold does not resolve TypeScript types, so
 * no annotation is proof (not even the owned `LineageHandle`): a named type that
 * includes `undefined` behind an alias, a generic, an import, or a local shadow
 * is indistinguishable from the owned interface by spelling alone.
 *
 * The call population enumerates the callee spellings that rebind the bridge:
 * an import rename, a variable alias (`const r = replayThrough…`), a property
 * alias (`const r = mod.replayThrough…`), a destructured binding
 * (`const { replayThrough…: r } = mod`), a defaulted destructured binding
 * (`const { replayThrough…: r = mod.recordMutation } = mod`), a sequence callee
 * (`(0, mod.recordMutation)(…)`), and a subscript call
 * (`bridge["recordMutation"](…)`). A bridge callee silently absent from the
 * population is the F3 defect this round closes.
 *
 * An unresolved spread leaves the site INDETERMINATE, never falsely safe: the
 * forwarding might carry an epoch. The indeterminate set is registered below
 * with a checked reason and audited in BOTH directions (a new unresolved form
 * fails, and a stale admission fails) via `auditRegistry`. That is the honest
 * statement of coverage — the census proves the resolved population and names
 * the unresolved one; it does not assert whole-population completeness.
 *
 * Known limits, stated rather than papered over:
 *   * cross-file provenance is outside this static fold; a binding whose value
 *     is imported or built in another module resolves to indeterminate;
 *   * TypeScript type resolution is not attempted, deliberately: proving a
 *     named annotation non-nullable needs a type resolver this fold does not
 *     have. The value fold reads a literal, a constructor, or an explicit
 *     `undefined` written at the call site; a name, a call, a member read, a
 *     parameter, or an import is MAYBE, so
 *     a site that cannot prove its lineage value defined beside an epoch is
 *     INDETERMINATE — including the one production epoch sender (`index.ts`'s
 *     settled sweep). That producer's real value is pinned at runtime by
 *     `tests/index-observed-sweep-no-read-guard.test.ts`, and the producer plus
 *     the generic replay seam are registered below with their reasons;
 *   * a lineage VALUE named by a variable is NOT followed: `const lineage = 1`
 *     and `const { lineage } = entry` are the same spelling to a name-only
 *     fold, and a binding-declaration form it does not enumerate (a
 *     destructuring, `for…of`, or defaulted pattern) resolves the WRONG
 *     binding (the R5-1 finding, AGENTS.md 34). A name is MAYBE; only a
 *     literal, constructor, or explicit `undefined` at the call site decides;
 *   * a local function or class that shares a bridge callee's name is still
 *     counted as the bridge — a name collision this fold cannot resolve without
 *     type/module information. The approximation is LOUD: it can red a safe
 *     site, never pass an epoch-without-lineage site as safe. No production
 *     file declares one; a guard pins that population;
 *   * the call population is the lexical set `calleeName` decodes (a bare name,
 *     a member read, a string/identifier subscript, a sequence, and local
 *     aliases). A fully dynamic callee (`bridge[index](…)` with a computed
 *     `index`) is OUTSIDE it. `mightContainBridgeCallee` is only a lexical
 *     file-admission check — whether the text names a bridge callee at all —
 *     so a file can contain the plain name and still yield ZERO sites when
 *     every call spells the callee dynamically. The census makes no universal
 *     call-coverage claim.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import {
	type MutationBridgeDeps,
	recordMutationThroughSeam,
} from "../../clients/mutation-bridge.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** The bridge field whose presence obliges `lineage`. */
const EPOCH_FIELD = "readGuardBranchEpoch";
/** The currency field the epoch obliges. */
const LINEAGE_FIELD = "lineage";

/** The bridge callee names, including local import aliases of them. */
const BRIDGE_CALLEES: ReadonlySet<string> = new Set([
	"recordMutation",
	"replayThroughMutationBridge",
]);

type SiteKind = "safe" | "unsafe" | "indeterminate";

/**
 * The verdict for one bridge construction site.
 *
 * The obligation is the runtime fence's (`clients/mutation-bridge.ts`:
 * `lineage !== undefined`), so `safe` is a VALUE verdict, not a key verdict: it
 * requires the fold to prove an output either cannot carry an epoch or carries
 * a lineage value it can prove is not `undefined`. A `lineage` key whose value
 * is merely present, nullable, or unprovable is NOT `safe`.
 *
 * `unsafe`  — an output has a definite epoch and a lineage that is definitely
 *   not defined (absent, or the literal `undefined`).
 * `indeterminate` — no output is definitely unsafe, but one could be: a
 *   definite epoch beside a maybe-defined value, or an unresolved part that
 *   could add an epoch. Disclosed, never silently clean.
 * `safe` — every output either cannot carry an epoch, or carries a lineage
 *   value the fold proved is not `undefined`.
 */
interface BridgeSite {
	readonly file: string;
	readonly line: number;
	readonly symbol: string;
	readonly callee: string;
	readonly kind: SiteKind;
	/** Stable per-site identity for the indeterminate admission registry. */
	readonly key: string;
	/**
	 * The census keys the fold proved present in at least one possible output of
	 * the argument (`readGuardBranchEpoch` only; the `lineage` presence is read
	 * through `kind`, never here). A key present in one alternative of a
	 * conditional is still reported.
	 */
	readonly keys: ReadonlySet<string>;
	/** True when an unresolved spread/alias could add arbitrary keys. */
	readonly unknown: boolean;
}

/** Function-shaped scopes that own parameter and local bindings. */
const FUNCTION_SCOPE_KINDS: ReadonlySet<string> = new Set([
	"function_declaration",
	"function_expression",
	"arrow_function",
	"method_definition",
	"generator_function_declaration",
	"generator_function",
]);

/**
 * What the fold knows about the `lineage` VALUE in one output. The runtime
 * fence tests the value (`lineage !== undefined`), so only `defined`
 * satisfies it: `absent` and `undefined` are definite holes, `maybe` is an
 * unproven value the census refuses to call safe.
 */
type LineageState = "absent" | "undefined" | "maybe" | "defined";

/**
 * One possible final object a construction can produce: whether an epoch is
 * present in the known part, what the `lineage` value is known to be, and
 * whether an unresolved part could add or overwrite census keys (an epoch
 * without a lineage, in the worst case).
 *
 * The verdict is per OUTPUT, not per key set: two mutually exclusive
 * conditional arms must not let a lineage key in one launder an epoch-only
 * sibling. Deduping the profiles bounds a construction to at most sixteen
 * profiles (fourteen reachable), so folding alternatives is not an exponential
 * branch product and no alternative is capped away.
 */
interface Output {
	readonly epoch: boolean;
	readonly lineage: LineageState;
	readonly unknown: boolean;
}

interface Construction {
	readonly outputs: readonly Output[];
}

const EMPTY_OUTPUT: Output = {
	epoch: false,
	lineage: "absent",
	unknown: false,
};

const UNKNOWN_CONSTRUCTION: Construction = {
	outputs: [{ epoch: false, lineage: "absent", unknown: true }],
};

/** The weaker of two value states; `defined` only when both are defined. */
function joinLineage(a: LineageState, b: LineageState): LineageState {
	if (a === "defined" && b === "defined") return "defined";
	if (a === "absent" && b === "absent") return "absent";
	if (a === "undefined" && b === "undefined") return "undefined";
	return "maybe";
}

/** Strip one layer of matching quotes/backticks from an AST key's text. */
function unquote(text: string): string {
	const first = text.charAt(0);
	const last = text.charAt(text.length - 1);
	if (
		text.length >= 2 &&
		((first === '"' && last === '"') ||
			(first === "'" && last === "'") ||
			(first === "`" && last === "`"))
	) {
		return text.slice(1, -1);
	}
	return text;
}

/**
 * The canonical string a literal key or subscript spells, or `undefined` when
 * the node is not a static string this fold can trust: a template with a
 * substitution is dynamic (the `template_substitution` named child, never a
 * `${` text match), and a literal carrying a backslash escape is left UNKNOWN
 * rather than decoded, because this fold is not a JavaScript string decoder.
 */
function staticStringValue(node: SgNode | null): string | undefined {
	if (!node) return undefined;
	const kind = node.kind();
	if (kind !== "string" && kind !== "template_string") return undefined;
	if (
		kind === "template_string" &&
		node
			.namedChildren()
			.some((child) => child.kind() === "template_substitution")
	) {
		return undefined;
	}
	if (node.text().includes("\\")) return undefined;
	return unquote(node.text());
}

/**
 * The bridge callee a call names, across the callable spellings the census
 * enumerates: `recordMutation`, `bridge.recordMutation`, `bridge["recordMutation"]`,
 * `(bridge.recordMutation)`, and any local alias of them (resolved separately by
 * `collectCalleeNames`).
 */
function calleeName(fn: SgNode | null): string | undefined {
	if (!fn) return undefined;
	const kind = fn.kind();
	if (kind === "identifier") return fn.text();
	if (kind === "member_expression") return fn.field("property")?.text();
	if (kind === "subscript_expression") {
		const index = fn.field("index");
		if (!index) return undefined;
		if (index.kind() === "string" || index.kind() === "template_string") {
			// A template with a substitution is not a static callee name, so the
			// site is outside the lexical population (see the header's known
			// limits); a no-substitution template is the explicit name it spells.
			return staticStringValue(index);
		}
		if (
			index.kind() === "identifier" ||
			index.kind() === "property_identifier"
		) {
			return index.text();
		}
		return undefined;
	}
	if (kind === "parenthesized_expression") {
		return calleeName(fn.namedChildren()[0] ?? null);
	}
	if (kind === "sequence_expression") {
		// `(0, mod.recordMutation)(…)` — the callable is the last operand.
		const operands = fn.namedChildren();
		return calleeName(operands[operands.length - 1] ?? null);
	}
	return undefined;
}

/** Every local name an object pattern binds to a bridge callee's key. */
function collectObjectPatternAliases(
	pattern: SgNode,
	out: Array<{ name: string; value: string }>,
): void {
	for (const binding of pattern.namedChildren()) {
		const kind = binding.kind();
		if (kind === "shorthand_property_identifier_pattern") {
			out.push({ name: binding.text(), value: binding.text() });
			continue;
		}
		if (kind !== "pair_pattern") continue;
		const parts = binding.namedChildren();
		const key = parts[0]?.text();
		const local = parts[parts.length - 1];
		if (!key || !local) continue;
		// `{ replay: r = mod.recordMutation }` — the bound name is the pattern's
		// left, never the default expression.
		const target =
			local.kind() === "assignment_pattern" ? local.field("left") : local;
		if (target?.kind() === "identifier") {
			out.push({ name: target.text(), value: key });
		} else if (target?.kind() === "object_pattern") {
			collectObjectPatternAliases(target, out);
		}
	}
}

/** The callee names this file can call the bridge through, import aliases included. */
function collectCalleeNames(root: SgNode): ReadonlySet<string> {
	const names = new Set<string>(BRIDGE_CALLEES);
	const aliases: Array<{ name: string; value: string }> = [];
	const visit = (node: SgNode): void => {
		const kind = node.kind();
		if (kind === "import_specifier") {
			const imported = node.field("name");
			const alias = node.field("alias");
			if (
				imported &&
				alias?.kind() === "identifier" &&
				BRIDGE_CALLEES.has(imported.text())
			) {
				names.add(alias.text());
			}
		} else if (kind === "variable_declarator") {
			const name = node.field("name");
			if (name?.kind() === "identifier") {
				const terminal = calleeName(node.field("value"));
				if (terminal !== undefined) {
					aliases.push({ name: name.text(), value: terminal });
				}
			} else if (name?.kind() === "object_pattern") {
				collectObjectPatternAliases(name, aliases);
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	// A local alias of the bridge function (`const replay = replayThroughMutationBridge`)
	// is the same seam under a different name, whether it comes from an import
	// rename, a variable or property alias, or a destructured binding. Close over
	// chains of aliases so one hop cannot hide the call.
	let changed = true;
	while (changed) {
		changed = false;
		for (const alias of aliases) {
			if (names.has(alias.value) && !names.has(alias.name)) {
				names.add(alias.name);
				changed = true;
			}
		}
	}
	return names;
}

/**
 * A parse-error region that names a bridge callee means the walk cannot trust
 * its own population for this file. That is a hard failure naming the file and
 * line, never a silent skip: the error region may hold the very construction
 * the census guards.
 */
function findMalformedBridgeRegion(
	root: SgNode,
): { line: number; text: string } | undefined {
	let found: { line: number; text: string } | undefined;
	const visit = (node: SgNode): void => {
		if (found) return;
		if (node.kind() === "ERROR") {
			const text = node.text();
			if ([...BRIDGE_CALLEES].some((callee) => text.includes(callee))) {
				found = { line: node.range().start.line + 1, text: text.slice(0, 120) };
				return;
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return found;
}

/** The name of the nearest enclosing function/class, for the site identity. */
function enclosingSymbol(node: SgNode): string {
	for (const ancestor of node.ancestors()) {
		const kind = ancestor.kind();
		if (FUNCTION_SCOPE_KINDS.has(String(kind))) {
			const name = ancestor.field("name");
			if (name?.kind() === "identifier") return name.text();
			const parent = ancestor.parent();
			if (parent?.kind() === "variable_declarator") {
				const declared = parent.field("name");
				if (declared?.kind() === "identifier") return declared.text();
			}
		}
		if (kind === "class_declaration") {
			const name = ancestor.field("name");
			if (name?.kind() === "identifier") return name.text();
		}
	}
	return "<module>";
}

type Truth = "truthy" | "falsy" | "unknown";

/**
 * The static truthiness of an operand, so `a && b` folds as `b` when `a` is
 * truthy and as nothing when it is falsy. Only syntactic literals and
 * constructors are decided; everything else is `unknown` (the union arm).
 */
function truthiness(node: SgNode | null): Truth {
	if (!node) return "unknown";
	const kind = node.kind();
	if (kind === "false" || kind === "null" || kind === "undefined")
		return "falsy";
	if (kind === "number")
		return node.text() === "0" || node.text() === "0n" ? "falsy" : "truthy";
	if (kind === "string")
		return unquote(node.text()) === "" ? "falsy" : "truthy";
	if (kind === "true") return "truthy";
	if (
		kind === "object" ||
		kind === "array" ||
		kind === "function_expression" ||
		kind === "arrow_function" ||
		kind === "class" ||
		kind === "new_expression"
	) {
		return "truthy";
	}
	if (kind === "unary_expression") {
		if (node.children().some((child) => child.kind() === "void"))
			return "falsy";
	}
	return "unknown";
}

function makeResolver(): (node: SgNode | null) => Construction {
	/** Distinct output profiles, deduped by `(epoch, lineage, unknown)`. */
	const dedupe = (outputs: readonly Output[]): Output[] => {
		const byProfile = new Map<string, Output>();
		for (const output of outputs) {
			const profile = `${output.epoch ? "e" : "-"}:${output.lineage}:${output.unknown ? "u" : "-"}`;
			if (!byProfile.has(profile)) byProfile.set(profile, output);
		}
		return [...byProfile.values()];
	};

	/** Both expressions can be the result (a conditional, `||`, or `??`). */
	const unionConstructions = (
		left: Construction,
		right: Construction,
	): Construction => ({ outputs: dedupe([...left.outputs, ...right.outputs]) });

	/**
	 * The result carries the keys of both (a spread): `right` overwrites `left`
	 * for every key it carries. An unresolved `right` may carry ANY key,
	 * including `lineage: undefined`, so it weakens an existing value proof.
	 */
	const combineConstructions = (
		left: Construction,
		right: Construction,
	): Construction => {
		const outputs: Output[] = [];
		for (const a of left.outputs) {
			for (const b of right.outputs) {
				const lineage =
					b.lineage !== "absent" ? b.lineage : b.unknown ? "maybe" : a.lineage;
				outputs.push({
					epoch: a.epoch || b.epoch,
					lineage,
					unknown: a.unknown || b.unknown,
				});
			}
		}
		return { outputs: dedupe(outputs) };
	};

	const markEpoch = (construction: Construction): Construction => ({
		outputs: construction.outputs.map((output) => ({
			...output,
			epoch: true,
		})),
	});

	const setLineage = (
		construction: Construction,
		state: LineageState,
	): Construction => ({
		outputs: construction.outputs.map((output) => ({
			...output,
			lineage: state,
		})),
	});

	/**
	 * An unresolved property or spread may add or overwrite any key, so it can
	 * supply an epoch and it can replace a proven lineage with `undefined`.
	 */
	const markUnknown = (construction: Construction): Construction => ({
		outputs: construction.outputs.map((output) => ({
			...output,
			lineage: "maybe",
			unknown: true,
		})),
	});

	/**
	 * What an expression's value tells us about the `lineage` obligation.
	 *
	 * A NAME is never a proof. `const lineage = 1` and
	 * `const { lineage } = entry` share the spelling the old identifier arm
	 * followed, and recording every binding-declaration form would be another
	 * enumerator one layer down (AGENTS.md 34, the R5-1 finding). Only what is
	 * written at the call site decides: an explicit `undefined` (or `void`), a
	 * literal or constructor, or a fold of those across `??`/`?:`. Everything
	 * else is MAYBE.
	 */
	const resolveLineageValue = (node: SgNode | null): LineageState => {
		if (!node) return "maybe";
		const kind = node.kind();
		if (kind === "undefined") return "undefined";
		if (kind === "unary_expression") {
			// `void 0` is `undefined`.
			return node.children().some((child) => child.kind() === "void")
				? "undefined"
				: "maybe";
		}
		if (
			kind === "number" ||
			kind === "string" ||
			kind === "true" ||
			kind === "false" ||
			kind === "regex" ||
			kind === "template_string" ||
			kind === "object" ||
			kind === "array" ||
			kind === "function_expression" ||
			kind === "arrow_function" ||
			kind === "class" ||
			kind === "new_expression"
		) {
			return "defined";
		}
		if (kind === "identifier" || kind === "shorthand_property_identifier") {
			// A name is NOT followed to its initializer: an unenumerated binding
			// form (a destructuring, `for…of`, or defaulted pattern) would resolve
			// the wrong declaration (R5-1). The `undefined` KEYWORD is its own node
			// kind and is handled above; a name spelled `undefined` is still only a
			// name (a shorthand `{ undefined }` is keyed `undefined` and never
			// routed here under `lineage`), so every identifier is MAYBE.
			return "maybe";
		}
		if (
			kind === "parenthesized_expression" ||
			kind === "as_expression" ||
			kind === "satisfies_expression" ||
			kind === "type_assertion" ||
			kind === "non_null_expression"
		) {
			return resolveLineageValue(
				node.field("expression") ?? node.namedChildren()[0] ?? null,
			);
		}
		if (kind === "ternary_expression" || kind === "conditional_expression") {
			return joinLineage(
				resolveLineageValue(node.field("consequence")),
				resolveLineageValue(node.field("alternative")),
			);
		}
		if (kind === "binary_expression") {
			const operator = node.field("operator")?.text();
			const left = resolveLineageValue(node.field("left"));
			const right = resolveLineageValue(node.field("right"));
			if (operator === "??") {
				// `a ?? b` is `undefined` only when BOTH are.
				if (left === "defined" || right === "defined") return "defined";
				if (left === "undefined" && right === "undefined") return "undefined";
				return "maybe";
			}
			return joinLineage(left, right);
		}
		return "maybe";
	};

	const resolveKey = (
		key: SgNode | null,
	): { key?: string; dynamic: boolean } => {
		if (!key) return { dynamic: true };
		const kind = key.kind();
		if (kind === "property_identifier" || kind === "identifier") {
			return { key: key.text(), dynamic: false };
		}
		if (kind === "string" || kind === "template_string") {
			const value = staticStringValue(key);
			return value === undefined
				? { dynamic: true }
				: { key: value, dynamic: false };
		}
		if (kind === "computed_property_name") {
			const value = staticStringValue(key.namedChildren()[0] ?? null);
			return value === undefined
				? { dynamic: true }
				: { key: value, dynamic: false };
		}
		return { dynamic: true };
	};

	const resolveObject = (node: SgNode): Construction => {
		let result: Construction = { outputs: [EMPTY_OUTPUT] };
		for (const property of node.namedChildren()) {
			const kind = property.kind();
			// In-object comments are named children in this grammar; they are not
			// properties and must not read as an unknown key (r2 V5).
			if (kind === "comment") continue;
			if (kind === "pair") {
				const resolved = resolveKey(property.field("key") ?? property);
				if (resolved.dynamic) {
					result = markUnknown(result);
				} else if (resolved.key === EPOCH_FIELD) {
					result = markEpoch(result);
				} else if (resolved.key === LINEAGE_FIELD) {
					result = setLineage(
						result,
						resolveLineageValue(property.field("value")),
					);
				}
				continue;
			}
			if (kind === "shorthand_property_identifier") {
				const name = property.text();
				if (name === EPOCH_FIELD) result = markEpoch(result);
				else if (name === LINEAGE_FIELD) {
					result = setLineage(result, resolveLineageValue(property));
				}
				continue;
			}
			if (kind === "method_definition") {
				const resolved = resolveKey(property.field("name") ?? property);
				if (resolved.dynamic) result = markUnknown(result);
				else if (resolved.key === EPOCH_FIELD) result = markEpoch(result);
				else if (resolved.key === LINEAGE_FIELD)
					result = setLineage(result, "defined");
				continue;
			}
			if (kind === "spread_element") {
				result = combineConstructions(
					result,
					resolve(property.namedChildren()[0] ?? null),
				);
				continue;
			}
			result = markUnknown(result);
		}
		return result;
	};

	const resolve = (node: SgNode | null): Construction => {
		if (!node) return UNKNOWN_CONSTRUCTION;
		const kind = node.kind();
		if (kind === "object") return resolveObject(node);
		// A bound object is OPAQUE. `const h = { … }` captures an object, but any
		// later statement can reach that same heap object through a property, an
		// array slot, an assignment, a conditional arm, a destructuring source, a
		// nested argument, or a copy-free alias and mutate it. The fold cannot
		// enumerate those spellings (AGENTS.md 34), so it proves nothing about a
		// binding: only an object literal written at the call site, or a
		// conditional/short-circuit of such literals, is folded. See the header.
		if (kind === "identifier") return UNKNOWN_CONSTRUCTION;
		if (kind === "parenthesized_expression") {
			return resolve(node.namedChildren()[0] ?? null);
		}
		if (
			kind === "as_expression" ||
			kind === "satisfies_expression" ||
			kind === "type_assertion" ||
			kind === "non_null_expression"
		) {
			return resolve(
				node.field("expression") ?? node.namedChildren()[0] ?? null,
			);
		}
		if (kind === "ternary_expression" || kind === "conditional_expression") {
			return unionConstructions(
				resolve(node.field("consequence")),
				resolve(node.field("alternative")),
			);
		}
		if (kind === "binary_expression") {
			const operator = node.field("operator")?.text();
			if (operator === "&&") {
				// `a && b` is `a` when `a` is falsy and `b` otherwise. A falsy operand
				// spreads no keys, so a statically-falsy left contributes nothing and a
				// statically-truthy left contributes only `b`. An unknown left may
				// contribute either, so a guarded `...(lineage && { lineage })` beside
				// an unconditional epoch cannot read as safe.
				const left = truthiness(node.field("left"));
				if (left === "falsy") return { outputs: [EMPTY_OUTPUT] };
				if (left === "truthy") return resolve(node.field("right"));
				return unionConstructions(resolve(node.field("right")), {
					outputs: [EMPTY_OUTPUT],
				});
			}
			if (operator === "||" || operator === "??") {
				return unionConstructions(
					resolve(node.field("left")),
					resolve(node.field("right")),
				);
			}
			return UNKNOWN_CONSTRUCTION;
		}
		// A call result (including `Object.assign(…)`) is opaque: the fold does not
		// see the object it returns.
		return UNKNOWN_CONSTRUCTION;
	};

	return resolve;
}

/**
 * The verdict over every possible output. A definite epoch paired with no
 * lineage key or an explicitly-undefined value is `unsafe`: the runtime fence
 * `lineage !== undefined` is skipped there and the entry is credited. A
 * definite epoch with a possibly-undefined value, or an unresolved structure
 * that could itself carry an epoch, is `indeterminate` — the obligation may or
 * may not be met. `safe` means every output proves the lineage value defined
 * wherever an epoch is present.
 */
function classify(construction: Construction): SiteKind {
	let indeterminate = false;
	for (const output of construction.outputs) {
		if (
			output.epoch &&
			(output.lineage === "absent" || output.lineage === "undefined")
		) {
			return "unsafe";
		}
		if (
			(output.epoch && output.lineage === "maybe") ||
			(output.unknown && output.lineage !== "defined")
		) {
			indeterminate = true;
		}
	}
	return indeterminate ? "indeterminate" : "safe";
}

/**
 * The census keys present in at least one possible output: the epoch alone. The
 * `lineage` value is the verdict's question, answered through `kind`, and the
 * epoch-site floor below is the only consumer of this set; a second presence
 * key here would be dead bookkeeping.
 */
function censusKeys(construction: Construction): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const output of construction.outputs) {
		if (output.epoch) keys.add(EPOCH_FIELD);
	}
	return keys;
}

/**
 * Test seam: the distinct `(epoch, lineage, unknown)` profiles one argument
 * expression resolves to, so the lattice bound is asserted directly (sixteen
 * cells, fourteen reachable) instead of inferred from a verdict. Identifiers
 * the probe does not bind (`__unknown__`, `getLineage`) resolve to the
 * UNKNOWN/MAYBE arms by design.
 */
function resolveOutputProfiles(expression: string): string[] {
	const root = parse(
		Lang.TypeScript,
		`const __r4_probe__ = (${expression});`,
	).root();
	const declarators: SgNode[] = [];
	const visit = (node: SgNode): void => {
		if (
			node.kind() === "variable_declarator" &&
			node.field("name")?.text() === "__r4_probe__"
		) {
			declarators.push(node);
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	const resolve = makeResolver();
	return resolve(declarators[0]?.field("value") ?? null).outputs.map(
		(output) =>
			`${output.epoch ? "e" : "-"}|${output.lineage}|${output.unknown ? "u" : "-"}`,
	);
}

/**
 * A file that never spells a bridge callee cannot call one, directly or
 * through an import alias (the alias still imports the original name). This is
 * a lexical ADMISSION check only: every admitted match still comes from the
 * AST below, so a callee named only in a comment or string is filtered out by
 * the walk, not by this probe.
 */
function mightContainBridgeCallee(source: string): boolean {
	for (const callee of BRIDGE_CALLEES) {
		if (source.includes(callee)) return true;
	}
	return false;
}

/**
 * Every bridge construction site in one source text, with its local-provenance
 * verdict. Exported through a test-visible seam (called directly by the
 * fixture cases below) so a regression in the fold is caught on synthetic code
 * before it hides behind the whole-tree census.
 */
function analyzeBridgeSites(source: string, file: string): BridgeSite[] {
	if (!mightContainBridgeCallee(source)) return [];
	const root = parse(Lang.TypeScript, source).root();
	const malformed = findMalformedBridgeRegion(root);
	if (malformed) {
		throw new Error(
			`mutation-bridge census: malformed source at ${file}:${malformed.line} names a bridge callee inside a parse error; the construction population cannot be read: ${JSON.stringify(malformed.text)}`,
		);
	}
	const calleeNames = collectCalleeNames(root);
	const resolve = makeResolver();
	const sites: BridgeSite[] = [];
	const visit = (node: SgNode): void => {
		if (node.kind() === "call_expression") {
			const callee = calleeName(node.field("function"));
			if (callee !== undefined && calleeNames.has(callee)) {
				const args = node.field("arguments")?.namedChildren() ?? [];
				const construction =
					args.length === 1 ? resolve(args[0] ?? null) : UNKNOWN_CONSTRUCTION;
				const symbol = enclosingSymbol(node);
				sites.push({
					file,
					line: node.range().start.line + 1,
					symbol,
					callee,
					kind: classify(construction),
					key: `${file}::${symbol}::${callee}`,
					keys: censusKeys(construction),
					unknown: construction.outputs.some((output) => output.unknown),
				});
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return sites;
}

/** Bridge source roots: runtime and adapter trees plus the pi host entry. */
function productionSourceFiles(): string[] {
	const files: string[] = [];
	for (const root of ["clients", "tools", "mcp", "scripts"]) {
		const dir = path.join(REPO_ROOT, root);
		if (fs.existsSync(dir)) {
			files.push(...listSourceFiles(dir, { skipTests: true }));
		}
	}
	files.push(path.join(REPO_ROOT, "index.ts"));
	return files;
}

let cachedSites: BridgeSite[] | undefined;
function productionSites(): BridgeSite[] {
	cachedSites ??= productionSourceFiles().flatMap((file) =>
		analyzeBridgeSites(
			fs.readFileSync(file, "utf8"),
			relativePosix(REPO_ROOT, file),
		),
	);
	return cachedSites;
}

/**
 * Bridge callee names a file declares with a `function`, `class`, or top-level
 * `const`/`let`/`var`. A local declaration sharing a bridge name is the shape the
 * fold cannot tell from the bridge (F5): it is counted as the bridge, which can
 * red a safe site but never passes an epoch-without-lineage site. This measures
 * that population so a real shadow has to be assessed rather than assumed.
 */
function localBridgeDeclarations(source: string): string[] {
	if (!mightContainBridgeCallee(source)) return [];
	const root = parse(Lang.TypeScript, source).root();
	const declared = new Set<string>();
	const visit = (node: SgNode): void => {
		const kind = node.kind();
		if (kind === "function_declaration" || kind === "class_declaration") {
			const name = node.field("name");
			if (name?.kind() === "identifier" && BRIDGE_CALLEES.has(name.text())) {
				declared.add(name.text());
			}
		} else if (kind === "variable_declarator") {
			const name = node.field("name");
			if (name?.kind() === "identifier" && BRIDGE_CALLEES.has(name.text())) {
				declared.add(name.text());
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return [...declared];
}

/**
 * Every forwarding site the local fold cannot resolve. Each carries a checked
 * reason; the audit below fails on a new one (a new unsupported form) and on a
 * stale one (a resolved form), so the list can only stay honest.
 */
const ADMITTED_INDETERMINATE: Readonly<Record<string, string>> = {
	"clients/lsp-mutation.ts::recordThroughBridge::recordMutation":
		"#5551: the entry is the `entry` parameter, built by `lspMutationEntry` in the same file for both LSP branches; that builder names no `readGuardBranchEpoch`, and it sets `lineage` from `context.session` whenever the caller threads one",
	"clients/observed-mutation-sources.ts::replayThroughMutationBridge::recordMutation":
		"the generic replay seam forwards a caller-built entry; its two in-tree callers construct lineage at the call site",
	"clients/runtime-tool-result.ts::handleToolResult::replayThroughMutationBridge":
		"the value is `deps._sessionGeneration ?? runtime.captureSessionGeneration()`, a call result the fold does not resolve; the tool_result replay regression `tests/clients/observed-mutation-integration.test.ts` '#3596 a settle replay that lands after the replacement credits nothing in the new session' drops the replay, which is only possible when the lineage value is defined",
	"index.ts::runObservedSettledSweepSafely::replayThroughMutationBridge":
		"the lineage is the `lineage: LineageHandle` parameter, and the fold does not resolve types (`LineageHandle` itself has no `undefined`, but proving that needs a type resolver, and a nullable alias would spell the same). The real settled-sweep producer is pinned at runtime by `tests/index-observed-sweep-no-read-guard.test.ts` 'a third-party write under --no-read-guard is still caught by the settled sweep and replayed through the bridge, skipping only the read-guard stamp', whose floor observes the producer replay an epoch and whose safety clause asserts every epoch-carrying entry carries `lineage !== undefined`; if this value ever became `undefined`, that clause reds and the static `unsafe` check does too",
};

describe("#3824 S2 / #3937: a bridge entry names its lineage whenever it can name an epoch", () => {
	it("no resolvable construction site carries an epoch without lineage", () => {
		const sites = productionSites();
		assertNonEmptyScan("bridge entry construction sites", sites.length, 1);
		const epochSites = sites.filter((site) => site.keys.has(EPOCH_FIELD));
		// Floor: the one real epoch sender (the settled sweep) is in the census,
		// so a dead scan or a moved producer cannot read as clean.
		assertNonEmptyScan("epoch-carrying bridge entries", epochSites.length, 1);
		const unsafe = sites
			.filter((site) => site.kind === "unsafe")
			.map((site) => `${site.file}:${site.line} (${site.callee})`);
		expect(unsafe, "epoch-carrying construction without lineage").toEqual([]);
	});

	it("no production file declares a bridge callee name beyond the bridge definition", () => {
		const declaringFiles = productionSourceFiles()
			.map((file) => ({
				file: relativePosix(REPO_ROOT, file),
				declared: localBridgeDeclarations(fs.readFileSync(file, "utf8")),
			}))
			.filter((entry) => entry.declared.length > 0);
		// The only production declaration is the bridge itself. A second one must
		// be assessed here, because the fold would count it as the bridge and could
		// red a safe producer (loud, never false-clean).
		expect(declaringFiles).toEqual([
			{
				file: "clients/observed-mutation-sources.ts",
				declared: ["replayThroughMutationBridge"],
			},
		]);
	});

	it("every unresolved forwarding site is admitted with a checked reason", () => {
		const indeterminate = productionSites()
			.filter((site) => site.kind === "indeterminate")
			.map((site) => ({ key: site.key, detail: `${site.file}:${site.line}` }));
		const audit = auditRegistry({
			sweepName: "mutation-bridge epoch/lineage indeterminate coverage",
			flagged: indeterminate,
			registered: [],
			exemptions: ADMITTED_INDETERMINATE,
			// The set is legitimately empty when every forwarding site resolves;
			// `assertNonEmptyScan` above is the population floor for the scan.
			minFlagged: 0,
			minReasonLength: 20,
			remediation:
				"Resolve the forwarding with the bounded local fold, or admit it above with a reason it cannot carry an epoch without lineage.",
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});
});

describe("#3937: bounded local object/spread provenance", () => {
	const analyze = (source: string): BridgeSite[] =>
		analyzeBridgeSites(source, "fixture.ts");
	const only = (source: string): BridgeSite => {
		const sites = analyze(source);
		expect(sites).toHaveLength(1);
		return sites[0] as BridgeSite;
	};

	it("flags the spread-forwarded epoch without a proven lineage", () => {
		const site = only(`
			function replayCaller(entry: unknown) {
				const hiddenEntry = { ...entry, readGuardBranchEpoch: 5 };
				replayThroughMutationBridge({ ...hiddenEntry });
			}
		`);
		// The epoch is definite, but `entry` is unresolved and may itself carry a
		// lineage, so the r3 value model reads honest uncertainty, never `safe`.
		expect(site.kind).toBe("indeterminate");
		// The failure must name the file and the seam, so a red is actionable.
		expect(site.file).toBe("fixture.ts");
		expect(site.callee).toBe("replayThroughMutationBridge");
		expect(site.line).toBe(4);
	});

	it("passes a benign spread whose last write proves the lineage", () => {
		// The proof is the call-site literal's OWN ordered spread, not a binding's
		// captured initializer: a bound object is opaque (see the R4-1 section
		// below), so only the literal written at the call site is folded.
		const site = only(`
			function replayCaller(entry: unknown) {
				replayThroughMutationBridge({ ...entry, lineage: 1 });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	it("does not call an untyped lineage value safe", () => {
		// The r2 false-safe: the key is present, so the old key-based fold read
		// `safe`; the runtime fence is `lineage !== undefined`, and an untyped
		// parameter may be `undefined`.
		const site = only(`
			function replayCaller(entry: unknown, lineage: unknown) {
				const built = { ...entry, lineage };
				replayThroughMutationBridge({ ...built });
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("passes a legacy lineage-only construction with no epoch", () => {
		const site = only(`
			function replayCaller(lineage: unknown) {
				replayThroughMutationBridge({ lineage });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	it("does not count a type declaration as a construction site", () => {
		expect(
			analyze(`
				interface ObservedReplayEntry {
					readGuardBranchEpoch?: number;
					lineage?: unknown;
				}
			`),
		).toEqual([]);
	});

	it("treats a const alias and an Object.assign result as opaque bindings", () => {
		// Both name a heap object the fold does not refresh: the alias can be
		// mutated through any carrier, and `Object.assign` is a call result. The
		// verdict narrows from `unsafe` to `indeterminate` — still non-safe, but the
		// census no longer claims a definite hole it cannot prove. A fresh literal
		// keeps the definite verdict (the R4-1 section below pins that control).
		const viaAlias = only(`
			function replayCaller(epoch: number) {
				const built = { readGuardBranchEpoch: epoch };
				replayThroughMutationBridge(built);
			}
		`);
		expect(viaAlias.kind).toBe("indeterminate");
		const viaAssign = only(`
			function replayCaller(epoch: number) {
				replayThroughMutationBridge(
					Object.assign({}, { readGuardBranchEpoch: epoch }),
				);
			}
		`);
		expect(viaAssign.kind).toBe("indeterminate");
	});

	it("sees an import-renamed replay call as an unlisted spelling", () => {
		const site = only(`
			import { replayThroughMutationBridge as replay } from "./observed-mutation-sources.js";
			function run(epoch: number) {
				replay({ readGuardBranchEpoch: epoch });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("sees a variable-renamed replay function as an unlisted spelling", () => {
		const site = only(`
			function run(epoch: number) {
				const replay = replayThroughMutationBridge;
				replay({ readGuardBranchEpoch: epoch });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("fails loudly when a bridge construction sits inside a parse error", () => {
		expect(() =>
			analyze(
				`function f( { replayThroughMutationBridge({ readGuardBranchEpoch: 1 })`,
			),
		).toThrow(/fixture\.ts:1.*parse error/);
	});

	it("sees a computed string-literal key as the explicit key it spells", () => {
		const site = only(`
			function replayCaller(epoch: number) {
				replayThroughMutationBridge({ ["readGuardBranchEpoch"]: epoch });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("does not treat a call named only in a comment or a string as a site", () => {
		expect(
			analyze(`
				// replayThroughMutationBridge({ readGuardBranchEpoch: 5 })
				const note = "replayThroughMutationBridge({ readGuardBranchEpoch: 5 })";
			`),
		).toEqual([]);
	});

	it("treats an unresolved spread as indeterminate, never safe", () => {
		const site = only(`
			function replayCaller(entry: unknown) {
				replayThroughMutationBridge({ ...entry });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("treats a cycle, a reassignment, and a shadow conservatively", () => {
		const cyclic = only(`
			function replayCaller() {
				const a = { ...b, readGuardBranchEpoch: 5 };
				const b = { ...a };
				replayThroughMutationBridge(a);
			}
		`);
		// A self-reference cycle leaves the epoch definite but the spread's keys
		// unresolved, so the site is `indeterminate` (the loud verdict), not silent.
		expect(cyclic.kind).toBe("indeterminate");
		const reassigned = only(`
			function replayCaller(epoch: number) {
				let built = { lineage: 1 };
				built = { readGuardBranchEpoch: epoch };
				replayThroughMutationBridge(built);
			}
		`);
		expect(reassigned.kind).not.toBe("safe");
		const shadowed = only(`
			const hidden = { lineage: 1 };
			function replayCaller(hidden: unknown) {
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(shadowed.kind).not.toBe("safe");
	});
});

describe("#3937 review round 2 — per-output soundness and callee/mutation coverage", () => {
	const analyze = (source: string): BridgeSite[] =>
		analyzeBridgeSites(source, "fixture.ts");
	const only = (source: string): BridgeSite => {
		const sites = analyze(source);
		expect(sites).toHaveLength(1);
		return sites[0] as BridgeSite;
	};

	// F1 — a conditional's arms are mutually exclusive; a lineage key in one arm
	// must not launder an epoch-only sibling into a safe verdict.
	it("flags a heterogeneous conditional whose epoch arm lacks lineage", () => {
		const site = only(`
			function replayCaller(cond: boolean) {
				replayThroughMutationBridge(cond ? { lineage: 1 } : { readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("flags a conditional whose epoch arm is only partially repaired", () => {
		const site = only(`
			function replayCaller(cond: boolean, entry: unknown) {
				const hidden = cond ? { ...entry, readGuardBranchEpoch: 5 } : { lineage: 1 };
				replayThroughMutationBridge({ ...hidden });
			}
		`);
		// The epoch arm's unresolved spread may carry a lineage, so the r3 value
		// model is `indeterminate`; a key-union classify reads the other arm's
		// `{ lineage: 1 }` and reds the pair.
		expect(site.kind).toBe("indeterminate");
	});

	// Non-regression: the outer overlay still repairs every arm (the `safe`
	// counterexample to a "classify arms worst" remedy).
	it("does not drop an outer lineage overlay over a conditional", () => {
		const site = only(`
			function replayCaller(cond: boolean) {
				const hidden = cond ? { readGuardBranchEpoch: 5 } : {};
				replayThroughMutationBridge({ ...hidden, lineage: 1 });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	it("does not let an unrelated lineage arm launder a short-circuit epoch arm", () => {
		// Direct literals keep the per-output verdict: the `||`'s epoch arm is
		// still `unsafe` beside the lineage-only arm.
		const site = only(`
			function replayCaller(cond: boolean) {
				replayThroughMutationBridge((cond && { lineage: 1 }) || { readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("models a && spread as its right operand so a guarded lineage arm stays safe", () => {
		const site = only(`
			function replayCaller(lineage: unknown) {
				replayThroughMutationBridge({ ...(lineage && { lineage }) });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	// F2 — the pinned TypeScript grammar parses `delete x.y` as unary_expression
	// (children `delete`, `member_expression`), never `delete_expression`.
	it("treats a post-construction delete of lineage as unresolved", () => {
		const site = only(`
			function replayCaller() {
				const hidden: any = { lineage: 1, readGuardBranchEpoch: 5 };
				delete hidden.lineage;
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	// F3 — a bridge callee rebound through destructuring, a property alias, or a
	// subscript is still the same seam; it must be a site, never silently zero.
	it("sees a destructured bridge callee alias", () => {
		const site = only(`
			import * as mod from "./observed-mutation-sources.js";
			const { replayThroughMutationBridge: replay } = mod;
			function run() {
				replay({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("sees a property-aliased bridge callee", () => {
		const site = only(`
			import * as mod from "./observed-mutation-sources.js";
			const replay = mod.replayThroughMutationBridge;
			function run() {
				replay({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("sees a subscript bridge callee", () => {
		const site = only(`
			function run() {
				bridge["recordMutation"]({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	// F4 — Object.assign(target, ...) mutates target, so a later read of the
	// binding cannot resolve to the stale initializer. It read as unsafe before.
	it("treats an Object.assign target as unresolved rather than stale", () => {
		const site = only(`
			function replayCaller() {
				const hidden = { readGuardBranchEpoch: 5 };
				Object.assign(hidden, { lineage: 1 });
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	// F5 — a local function that shadows a bridge name is conservatively flagged
	// (loud over-approximation). No production file has this shape; the measured
	// guard below pins that population so a real shadow must be assessed.
	it("conservatively flags a same-name local function shadow", () => {
		const site = only(`
			function replayThroughMutationBridge(x: unknown) { return x; }
			function run() {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});
});

describe("#3937 review round 3 — value-level soundness and spelling coverage", () => {
	const analyze = (source: string): BridgeSite[] =>
		analyzeBridgeSites(source, "fixture.ts");
	const only = (source: string): BridgeSite => {
		const sites = analyze(source);
		expect(sites).toHaveLength(1);
		return sites[0] as BridgeSite;
	};

	// V1 — `a && b` is `b` only while `a` is truthy. A guarded lineage spread
	// beside an unconditional epoch must not read as safe.
	it("does not launder an unconditional epoch through a guarded lineage spread", () => {
		const site = only(`
			function replayCaller(lineage: LineageHandle | undefined) {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, ...(lineage && { lineage }) });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("treats a statically-falsy && left as the empty spread it is", () => {
		const site = only(`
			function replayCaller() {
				replayThroughMutationBridge({ ...(0 && { readGuardBranchEpoch: 5 }) });
			}
		`);
		expect(site.kind).not.toBe("unsafe");
	});

	it("keeps a statically-truthy && left safe beside an epoch", () => {
		const site = only(`
			function replayCaller() {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, ...(true && { lineage: 1 }) });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	it("flags an unknown && left beside an epoch", () => {
		const site = only(`
			function replayCaller(cond: boolean) {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, ...(cond && { lineage: 1 }) });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	// V2 — value definedness, not key naming. The runtime fence tests the VALUE.
	it("does not let a literal undefined lineage satisfy the epoch obligation", () => {
		const site = only(`
			function replayCaller() {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage: undefined });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("treats a maybe-defined lineage value beside an epoch as indeterminate", () => {
		const site = only(`
			function replayCaller(lineage: LineageHandle | undefined) {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not let an unknown spread overwrite a proven lineage silently", () => {
		const site = only(`
			function replayCaller(entry: unknown) {
				replayThroughMutationBridge({ lineage: 1, ...entry, readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("does not rederive a value proof from a call result", () => {
		const site = only(`
			function replayCaller() {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage: getLineage() });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not let a dynamic computed key leave a proven lineage defined", () => {
		// A computed key can be `lineage`, so it may overwrite the proven value
		// with `undefined`; the unresolved-property marker must weaken the value.
		const site = only(`
			function replayCaller(key: string) {
				replayThroughMutationBridge({ lineage: 1, [key]: 1, readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	// V3 — every target spelling that rewrites the binding.
	it("treats an array-destructuring assignment target as mutated", () => {
		const site = only(`
			function replayCaller() {
				const hidden: any = { lineage: 1, readGuardBranchEpoch: 5 };
				[hidden] = [{ readGuardBranchEpoch: 9 }];
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("treats an object-destructuring assignment target as mutated", () => {
		const site = only(`
			function replayCaller() {
				const hidden: any = { lineage: 1, readGuardBranchEpoch: 5 };
				({ x: hidden } = { x: { readGuardBranchEpoch: 9 } });
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("treats a reflective delete/define target as mutated", () => {
		const viaDelete = only(`
			function replayCaller() {
				const hidden: any = { lineage: 1, readGuardBranchEpoch: 5 };
				Reflect.deleteProperty(hidden, "lineage");
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(viaDelete.kind).not.toBe("safe");
		const viaDefine = only(`
			function replayCaller() {
				const hidden: any = { lineage: 1, readGuardBranchEpoch: 5 };
				Object.defineProperty(hidden, "lineage", { value: undefined });
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(viaDefine.kind).not.toBe("safe");
	});

	// V4 — the call population must not silently drop a callee spelling.
	it("sees a defaulted destructured bridge callee alias", () => {
		const site = only(`
			import * as mod from "./observed-mutation-sources.js";
			const { replayThroughMutationBridge: replay = mod.recordMutation } = mod;
			function run() {
				replay({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("sees a sequence-expression bridge callee", () => {
		const site = only(`
			import * as mod from "./observed-mutation-sources.js";
			function run() {
				(0, mod.recordMutation)({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	// V5 — a comment is not a property.
	it("does not read an in-object comment as an unknown property", () => {
		const site = only(`
			function replayCaller() {
				replayThroughMutationBridge({ filePath: "x" /* not a key */ });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	it("does not prove a required parameter's lineage value from its annotation", () => {
		const site = only(`
			function replayCaller(entry: unknown, readGuardBranchEpoch: number, lineage: LineageHandle) {
				replayThroughMutationBridge({ ...entry, readGuardBranchEpoch, lineage });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});
});

describe("#3937 review round 4 — the provable floor (no type, heap, or key overreach)", () => {
	const analyze = (source: string): BridgeSite[] =>
		analyzeBridgeSites(source, "fixture.ts");
	const only = (source: string): BridgeSite => {
		const sites = analyze(source);
		expect(sites).toHaveLength(1);
		return sites[0] as BridgeSite;
	};

	// W1 — no annotation is proof. A named nullable alias, a generic, an import,
	// a local shadow of the owned name, and an explicit inline union are all the
	// same question the fold cannot answer without a type resolver.
	it("does not prove a named nullable type alias", () => {
		const site = only(`
			type OptionalLineage = LineageHandle | undefined;
			function f(entry: unknown, lineage: OptionalLineage) {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not prove a generic type parameter", () => {
		const site = only(`
			function f<T>(lineage: T) {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not prove an imported named type", () => {
		const site = only(`
			import type { MaybeLineage } from "./x.js";
			function f(lineage: MaybeLineage) {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not prove a local shadow of the owned type's name", () => {
		const site = only(`
			interface LineageHandle { x: number }
			function f(lineage: LineageHandle) {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not prove a generic default of undefined", () => {
		const site = only(`
			function f<T = undefined>(lineage: T) {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	// W2 — object identity, not name identity.
	it("taints the original through an identity alias", () => {
		const site = only(`
			function f() {
				const h: any = { lineage: 1, readGuardBranchEpoch: 5 };
				const other = h;
				delete other.lineage;
				replayThroughMutationBridge(h);
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("taints the original through a reflective alias mutation", () => {
		const site = only(`
			function f() {
				const h: any = { lineage: 1, readGuardBranchEpoch: 5 };
				const other = h;
				Reflect.deleteProperty(other, "lineage");
				replayThroughMutationBridge(h);
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("treats a binding passed to an unresolved callee as escaped, not stale", () => {
		const site = only(`
			function f(mutate: (x: any) => void) {
				const h = { lineage: 1, readGuardBranchEpoch: 5 };
				mutate(h);
				replayThroughMutationBridge(h);
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("does not propagate a copy spread's mutation to the original", () => {
		// A copy spread is not an identity alias: deleting a key on the copy leaves
		// the original's key in place. The plain-JavaScript assertion is the
		// independent proof of that rule. Under the opaque floor the ORIGINAL also
		// reads `indeterminate`, because a bound object is not folded whether or not
		// anything aliases it; the copy must not make it WORSE (`unsafe`).
		const original: Record<string, unknown> = { lineage: 1 };
		const copy: Record<string, unknown> = { ...original };
		delete copy.lineage;
		expect("lineage" in original).toBe(true);
		const site = only(`
			function f() {
				const h: any = { lineage: 1, readGuardBranchEpoch: 5 };
				const other = { ...h };
				delete other.lineage;
				replayThroughMutationBridge(h);
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	// W3 — a computed template key with a substitution is dynamic, never the
	// literal `${k}` string the fold used to read.
	it("treats a computed template key with a substitution as dynamic", () => {
		const site = only(`
			function f(k: string) {
				replayThroughMutationBridge({ [\`\${k}\`]: 5 });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not let a substituted key overwrite a proven lineage", () => {
		const site = only(`
			function f(k: string) {
				replayThroughMutationBridge({ lineage: 1, [\`\${k}\`]: undefined, readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("still sees a no-substitution template key", () => {
		const site = only(`
			function f() {
				replayThroughMutationBridge({ [\`readGuardBranchEpoch\`]: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("leaves an escaped census key unknown rather than decoding it", () => {
		const site = only(`
			function f() {
				replayThroughMutationBridge({ "\\u0072eadGuardBranchEpoch": 5 });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	// W4 — `null` is nullish, never a defined proof.
	it("does not treat a null ?? undefined lineage as defined", () => {
		const site = only(`
			function f() {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage: null ?? undefined });
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("does not treat a bare null lineage as defined beside an epoch", () => {
		const site = only(`
			function f() {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage: null });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	// W6 — the survivor arms the r3 reviewer found untested.
	it("does not resolve a new-expression argument", () => {
		const site = only(`
			function f() {
				replayThroughMutationBridge(new Entry());
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not resolve a member-expression argument", () => {
		const site = only(`
			function f(mod: { entry: unknown }) {
				replayThroughMutationBridge(mod.entry);
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not resolve a call-result argument", () => {
		const site = only(`
			function f() {
				replayThroughMutationBridge(getEntry());
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("folds a void-falsy && left as the empty spread it is", () => {
		const site = only(`
			function f() {
				replayThroughMutationBridge({ ...(void 0 && { readGuardBranchEpoch: 5 }) });
			}
		`);
		expect(site.kind).not.toBe("unsafe");
	});

	it("reads a method named lineage as a defined value", () => {
		const site = only(`
			function f() {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage() {} });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	// W5 — the profile lattice is finite and uncapped. Every reachable
	// `(epoch, lineage, unknown)` profile appears once; `absent` never coexists
	// with `unknown`, so 16 cartesian cells leave 14 reachable. A drop cap or a
	// lost profile would make this count fall below 14.
	it("keeps exactly the fourteen reachable profiles (no drop cap)", () => {
		const expression = [
			"{}",
			"{ lineage: 1 }",
			"{ ...__unknown__, lineage: 1 }",
			"{ lineage: getLineage() }",
			"{ ...__unknown__, lineage: getLineage() }",
			"{ lineage: undefined }",
			"{ ...__unknown__, lineage: undefined }",
			"{ readGuardBranchEpoch: 5 }",
			"{ readGuardBranchEpoch: 5, lineage: 1 }",
			"{ readGuardBranchEpoch: 5, ...__unknown__, lineage: 1 }",
			"{ readGuardBranchEpoch: 5, lineage: getLineage() }",
			"{ readGuardBranchEpoch: 5, ...__unknown__ }",
			"{ readGuardBranchEpoch: 5, lineage: undefined }",
			"{ readGuardBranchEpoch: 5, ...__unknown__, lineage: undefined }",
		].join(" || ");
		expect(resolveOutputProfiles(expression).sort()).toEqual(
			[
				"-|absent|-",
				"-|defined|-",
				"-|defined|u",
				"-|maybe|-",
				"-|maybe|u",
				"-|undefined|-",
				"-|undefined|u",
				"e|absent|-",
				"e|defined|-",
				"e|defined|u",
				"e|maybe|-",
				"e|maybe|u",
				"e|undefined|-",
				"e|undefined|u",
			].sort(),
		);
	});
});

describe("#3937 review round 5 — R4-1: a bound object is opaque", () => {
	const analyze = (source: string): BridgeSite[] =>
		analyzeBridgeSites(source, "fixture.ts");
	const only = (source: string): BridgeSite => {
		const sites = analyze(source);
		expect(sites).toHaveLength(1);
		return sites[0] as BridgeSite;
	};
	// A bound object with a proven-looking literal initializer. If the fold
	// resolved it (r4 did), every carrier below would read `safe`; the runtime
	// entry it stands for has `lineage === undefined` beside an epoch, which is
	// the bridge's fail-open branch.
	const H = "const h: any = { lineage: 1, readGuardBranchEpoch: 5 };";

	it("treats a heap-sharing carrier as opaque: property value", () => {
		const site = only(
			`function f(a: boolean) { ${H} const box = { item: h }; delete box.item.lineage; replayThroughMutationBridge(h); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("treats a heap-sharing carrier as opaque: reflective member", () => {
		const site = only(
			`function f(a: boolean) { ${H} const box = { item: h }; Reflect.deleteProperty(box.item, "lineage"); replayThroughMutationBridge(h); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("treats a heap-sharing carrier as opaque: assignment RHS", () => {
		const site = only(
			`function f(a: boolean) { ${H} let other; other = h; delete other.lineage; replayThroughMutationBridge(h); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("treats a heap-sharing carrier as opaque: conditional arm", () => {
		const site = only(
			`function f(a: boolean) { ${H} const other = a ? h : h; delete other.lineage; replayThroughMutationBridge(h); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("treats a heap-sharing carrier as opaque: array element", () => {
		const site = only(
			`function f(a: boolean) { ${H} const arr = [h]; delete arr[0].lineage; replayThroughMutationBridge(h); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("treats a heap-sharing carrier as opaque: destructuring source", () => {
		const site = only(
			`function f(a: boolean) { ${H} const box = { item: h }; const { item } = box; delete item.lineage; replayThroughMutationBridge(h); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("treats a heap-sharing carrier as opaque: nested argument", () => {
		const site = only(
			`function f(a: boolean) { ${H} const box = { item: h }; consume(box); replayThroughMutationBridge(h); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("treats a heap-sharing carrier as opaque: Object.assign member target", () => {
		const site = only(
			`function f(a: boolean) { ${H} const box = { item: h }; Object.assign(box.item, { lineage: undefined }); replayThroughMutationBridge(h); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not prove a bound object that nothing aliases", () => {
		// The floor is the call-site literal, not the binding: a `const` binding can
		// still be reached through a carrier the fold cannot enumerate, so even an
		// untouched-looking binding is opaque.
		const site = only(`
			function f(epoch: number) {
				const built = { readGuardBranchEpoch: epoch, lineage: 1 };
				replayThroughMutationBridge(built);
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("keeps a fresh literal argument's definite epoch unsafe", () => {
		// The `unsafe` verdict survives the narrowing for a call-site literal.
		const site = only(`
			function f(epoch: number) {
				replayThroughMutationBridge({ readGuardBranchEpoch: epoch });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("keeps a fresh literal argument that proves the lineage safe", () => {
		const site = only(`
			function f(epoch: number) {
				replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: 1 });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	// A name is never followed (r6, R5-1): the direct rebind, the destructuring
	// rebind, and the unrebound binding all read `indeterminate`, because the
	// fold cannot tell which declaration the name denotes. They stay as
	// independent classification checks — a mutation that made a name `defined`
	// would read all three `safe`.
	it("does not prove a lineage value variable that is later rebound", () => {
		const site = only(`
			function f() {
				let lineage = 1;
				lineage = undefined;
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage });
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("does not prove a destructured value variable that is rebound", () => {
		const site = only(`
			function f() {
				let lineage = 1;
				[lineage] = [undefined];
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage });
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	it("does not prove a lineage value variable that is never rebound", () => {
		const site = only(`
			function f() {
				const lineage = 1;
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});
});

describe("#3937 review round 6 — R5-1: a name is not a value proof", () => {
	const analyze = (source: string): BridgeSite[] =>
		analyzeBridgeSites(source, "fixture.ts");
	const only = (source: string): BridgeSite => {
		const sites = analyze(source);
		expect(sites).toHaveLength(1);
		return sites[0] as BridgeSite;
	};
	// The R5-1 counterexamples: a destructuring declaration is a binding form
	// `buildBindings` never recorded, so the old identifier arm walked past it to
	// an enclosing same-named constant and proved the WRONG value. Each shape
	// below read `safe` on the r5 scanner beside an epoch whose runtime `lineage`
	// is `undefined` — the bridge's fail-open branch (VERIFY_R5).
	const OUTER = "const lineage = 1;";

	it("does not resolve an object-destructured name to an outer constant", () => {
		const site = only(
			`${OUTER} function f(obj: any) { const { lineage } = obj; replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage }); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not resolve an array-destructured name to an outer constant", () => {
		const site = only(
			`${OUTER} function f(arr: any) { const [lineage] = arr; replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage }); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not resolve a for-of destructured name to an outer constant", () => {
		const site = only(
			`${OUTER} function f(xs: any) { for (const { lineage } of xs) { replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage }); } }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not resolve a defaulted destructured name to an outer constant", () => {
		const site = only(
			`${OUTER} function f(obj: any) { const { lineage = obj } = obj; replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage }); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not resolve a nested destructured name to an outer constant", () => {
		const site = only(
			`${OUTER} function f(obj: any) { const { a: { lineage } } = obj; replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage }); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not resolve a destructured name to an outer object constant", () => {
		const site = only(
			`const lineage = { x: 1 }; function f(obj: any) { const { lineage } = obj; replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage }); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	it("does not resolve a destructured name to an outer function-scope constant", () => {
		const site = only(
			`function outer() { const lineage = 1; function f(obj: any) { const { lineage } = obj; replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage }); } return f; }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	// The control: a sibling scope that declares the same name is NOT an
	// ancestor, so even the r5 fold read `indeterminate` there. The fix must not
	// turn it `unsafe` or resolve the sibling's constant.
	it("does not resolve a sibling scope's same-named constant", () => {
		const site = only(
			`function g() { const lineage = 1; return lineage; } function f(obj: any) { const { lineage } = obj; replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage }); }`,
		);
		expect(site.kind).toBe("indeterminate");
	});

	// The unsafe direction is retained independently through the supported
	// vector: a `void 0` written at the call site is a definite hole.
	it("keeps a direct void 0 lineage literal unsafe beside an epoch", () => {
		const site = only(
			`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: void 0 }); }`,
		);
		expect(site.kind).toBe("unsafe");
	});

	// A ternary VALUE joins both arms, so a defined arm cannot prove the sibling
	// that may be `undefined`.
	it("does not let a ternary's defined arm prove an undefined sibling", () => {
		const site = only(`
			function f(cond: boolean) {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage: cond ? 1 : undefined });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});
});

describe("#3937: the census obligation is the bridge fence's value check", () => {
	it("credits a no-lineage at-live epoch and drops a defined-but-retired handle", () => {
		// The census is a STATIC approximation; this drives the real seam with a
		// typed handle so the two verdicts map to the fence, never to a
		// `{ lineage: 1 }` stand-in.
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = "/probe";
		runtime.beginTurn();
		const deps: MutationBridgeDeps = {
			getRuntime: () => runtime as never,
			getCacheManager: () => ({ addModifiedRange: () => undefined }),
			getProjectRoot: () => "/probe",
			getDispatchCwd: () => "/probe",
			countFileLines: () => 1,
			isRecordable: () => true,
			dbg: () => {},
		};
		const entry = {
			filePath: "/probe/census.ts",
			kind: "edit" as const,
			touchedLines: [1, 2] as [number, number],
		};
		const atLive = runtime.readGuard.currentBranchEpoch;
		// No lineage: the fence is skipped and the at-live epoch is credited. This
		// is the hole the census's `unsafe` verdict names.
		expect(
			recordMutationThroughSeam(
				{ ...entry, readGuardBranchEpoch: atLive },
				deps,
			),
		).toBe(true);
		expect(runtime.consumeDeferredFormatFiles().length).toBeGreaterThan(0);
		// A real typed handle the value fold calls `defined`: the fence runs, and a
		// retired handle writes none of the live scope's state.
		const retired = runtime.captureSessionGeneration();
		runtime.resetForSession();
		runtime.beginTurn();
		expect(
			recordMutationThroughSeam(
				{ ...entry, readGuardBranchEpoch: atLive, lineage: retired },
				deps,
			),
		).toBe(true);
		expect(runtime.consumeDeferredFormatFiles()).toEqual([]);
	});
});

describe("#3937 review round 7 — survivor witnesses: deferred aliases, malformed objects, positive arms", () => {
	const analyze = (source: string): BridgeSite[] =>
		analyzeBridgeSites(source, "fixture.ts");
	const only = (source: string): BridgeSite => {
		const sites = analyze(source);
		expect(sites).toHaveLength(1);
		return sites[0] as BridgeSite;
	};

	// R6-1 — the alias closure is a fixpoint, not a single pass. Each chain is
	// initialized before `deliver` runs, so the order is a valid execution, not a
	// temporal-dead-zone error, and the fold must find the bridge call. A single
	// pass reads `[]`, which the census gate would call clean: the false-clean the
	// retained fixpoint prevents.
	it("finds a bridge site behind a deferred alias initialized after it is named", () => {
		const site = only(`
			function deliver() {
				const first = second;
				first({ readGuardBranchEpoch: 5 });
			}
			const second = replayThroughMutationBridge;
			deliver();
		`);
		expect(site.callee).toBe("first");
		expect(site.kind).toBe("unsafe");
	});

	it("finds a bridge site behind a two-hop deferred alias chain", () => {
		const site = only(`
			function deliver() {
				const first = second;
				const third = first;
				third({ readGuardBranchEpoch: 5 });
			}
			const second = replayThroughMutationBridge;
			deliver();
		`);
		expect(site.callee).toBe("third");
		expect(site.kind).toBe("unsafe");
	});

	it("runs a deferred alias chain in an order that is not a TDZ error", () => {
		// Independent bounded in-process trace: the deferred aliases are
		// initialized before `deliver` runs, so the ordering the fold resolves is a
		// real execution order. The stand-in is a local function, not the real
		// bridge or store.
		const order: string[] = [];
		let second: () => void = () => {};
		const replayThroughMutationBridge = (): void => {
			order.push("call");
		};
		function deliver(): void {
			const first = second;
			first();
		}
		second = replayThroughMutationBridge;
		order.push("init");
		deliver();
		expect(order).toEqual(["init", "call"]);
	});

	// R6-2 — the object fallback is reachable. A parse `ERROR` that does not name
	// a bridge callee leaves the object to the fold, and its unhandled child kind
	// must read `not safe`; the mutation that drops the fallback marks the
	// epoch+lineage literal `safe`.
	it("reads a malformed object argument as indeterminate, never safe", () => {
		const site = only(`
			function f() {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5, lineage: 1, @@@ });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	// R6-3 — the positive, call-site arms are retained, and each has a named
	// witness. Every value is written at the call site (a name is not a proof),
	// so no abstract `LineageHandle`-shaped stand-in reaches the real seam.
	// Dropping a `defined` kind, the `??` precision, or the parenthesis peel turns
	// one of these `safe` arms into `indeterminate` and reds its witness.
	it("keeps a direct string lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: "x" }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps a direct template-string lineage value safe beside an epoch", () => {
		expect(
			only(
				"function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: `t` }); }",
			).kind,
		).toBe("safe");
	});

	it("keeps a direct regex lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: /re/ }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps a direct true lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: true }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps a direct false lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: false }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps a direct object lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: {} }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps a direct array lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: [] }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps a direct constructor lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: new Foo() }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps a parenthesized literal lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: (1) }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps a defined-left nullish lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: 1 ?? undefined }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps an undefined-left nullish lineage value safe beside an epoch", () => {
		expect(
			only(
				`function f(epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: undefined ?? 1 }); }`,
			).kind,
		).toBe("safe");
	});

	it("keeps a name-on-the-left nullish lineage value safe beside an epoch", () => {
		// `x ?? 1` is defined whichever arm wins: the defined right arm decides the
		// fold, and the run-time value is never `undefined`. Measured through the
		// real analyzer, not assumed from the prose.
		expect(
			only(
				`function f(x: unknown, epoch: number) { replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: x ?? 1 }); }`,
			).kind,
		).toBe("safe");
	});

	it("flags an undefined-by-both-arms nullish lineage value as unsafe", () => {
		const site = only(`
			function f(epoch: number) {
				replayThroughMutationBridge({ readGuardBranchEpoch: epoch, lineage: undefined ?? undefined });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});
});
