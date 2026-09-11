/**
 * Structural analyser behind the availability-policy coverage gate (#1476).
 *
 * The first cut of this gate was a bag of regexes over file text, and a review
 * broke it seven different ways in one sitting: a `Map<string, boolean>` cache,
 * a field called `installed`, a `let cached` closure, a probe flag hoisted into
 * a const, `["-v"]` instead of `["--version"]`, a `?: boolean` field with no
 * initialiser, and — the one that hurt — a `// TODO: route through
 * availability-policy.js` COMMENT, which made the file read as compliant.
 *
 * So this is an AST analysis, not a text scan. It parses each module with
 * `@ast-grep/napi` (already a runtime dependency) and asks structural
 * questions:
 *
 *   * does the module IMPORT the policy — an `import_statement` node, so a
 *     comment or a dead string can never answer yes;
 *   * does a unit run a VERSION PROBE — a spawn-shaped call plus a version flag
 *     reachable from that unit, including one hoisted into a const;
 *   * does it MEMOIZE the verdict — a write to state that OUTLIVES the call
 *     (class field, module-level binding, factory closure, session fact), which
 *     is what makes a bad verdict stick.
 *
 * ## Units, not files
 *
 * Granularity is per top-level declaration ("unit"), not per file. The
 * file-level version of this gate cleared `runner-helpers.ts` and
 * `govulncheck-client.ts` because each already imported the policy for a
 * DIFFERENT memo — 2 of the 7 sites this change migrates hid behind their own
 * neighbours. A unit is one top-level class or function, so a second
 * hand-rolled latch beside a compliant one is its own unit and is judged on its
 * own.
 *
 * ## What it still cannot prove
 *
 * Names carry part of the load: a memo is recognised by an availability-ish
 * identifier holding boolean-ish state. A latch named `q7` with a probe spliced
 * in from another module is out of reach without full type resolution. The
 * vocabulary is deliberately wide (see `MEMO_NAME`), and every widening is
 * pinned by an evasion fixture in the gate's test.
 *
 * ROUTING INHERITANCE — whether a unit that does not spawn its own probe may
 * borrow the routing of the callee it delegates the spawn to — used to be a
 * BLACKLIST: inherit unless the unit's own memo "looks boolean". A #1529 review
 * (#1552) broke that with a memo that is neither boolean nor a policy handle
 * (`Map<string, "yes" | "no">`) and with a genuine boolean reached through a
 * type alias no factory name ever touches — neither spells "boolean", so both
 * inherited routing they never earned. It is now a WHITELIST
 * (`isPolicyHandleMemoShape`): inherit only when the unit's own memo is
 * traceably a `POLICY_FACTORY`'s handle, directly or one hop through a
 * module-local wrapper (`Map<string, ReturnType<typeof makeEslintProbe>>`).
 * An unrecognised shape now defaults to NOT inheriting, which is the safe
 * default a blacklist can never offer — it must relearn every disguise.
 *
 * The whitelist has its own known blind spots:
 *
 *   * a wrapper reached through TWO hops of module-local helpers (unit A calls
 *     helper B, which calls helper C, which calls the factory) is invisible —
 *     `policyHandles` is built from each unit's own direct `policyCalls`, not
 *     propagated transitively, so only a one-hop wrapper like `makeEslintProbe`
 *     is recognised. This narrows what a unit may inherit routing from, so it
 *     is a false NEGATIVE (an actually-routed unit reads as unrouted) — the
 *     safer failure direction, and the one the whitelist was built for;
 *   * a legitimate policy handle hidden behind a type alias (`type
 *     ToolHandle = ReturnType<typeof makeToolProbe>; Map<string,
 *     ToolHandle>`) is not resolved, so it reads as unrouted. This is another
 *     false negative and the safe direction; type resolution is outside this
 *     test-support analyser;
 *   * a `POLICY_FACTORY` imported under a renamed binding
 *     (`import { createCwdCachedProbe as ccp }`) does not match the factory's
 *     canonical name and reads as a hand-rolled latch, not a handle. Also a
 *     false negative, and not new here — the boolean-shape blacklist this
 *     replaced had the same gap, since neither version resolves import
 *     aliases;
 *   * the whitelist reads a memo's DECLARED shape (`typeText`/`valueText`)
 *     only — never a write's own inlined expression, and never a session fact
 *     (`setSessionFact` records a value, it does not call a factory). A round
 *     of review (#1552 round 2) found both omissions matter: reading a
 *     write's text let an inlined wrapper call
 *     (`cache.set(cwd, await makeToolProbe(cwd))`) leak the wrapper's name
 *     into a plain `Map<string, boolean>` latch's shape, and an unguarded
 *     session-fact check returned non-null unconditionally, so either read as
 *     a policy handle and inherited routing it never earned — the false
 *     POSITIVE the whitelist exists to rule out. Both are fixed; the
 *     `EVASIONS` fixtures below pin them;
 *   * (#1566) the same "reads only the declared shape" rule from the point
 *     above had its own gap: the shape check was a bare `\bname\b` substring
 *     test, so a declared type or value that merely MENTIONED a handle's
 *     name — anywhere in the text — passed, whether or not the memo actually
 *     held that handle. `Map<string, Awaited<ReturnType<ReturnType<typeof
 *     makeToolProbe>>>>` unwraps the wrapper's own return type twice and
 *     peels the promise, landing on a plain `boolean`; `emptyCache<boolean>
 *     (makeToolProbe)` merely hands the wrapper to an unrelated helper as an
 *     argument. Both spell the handle's name and neither holds it. The check
 *     is now shape-anchored: a handle counts only when its name is the
 *     memo's own un-nested `ReturnType<typeof name>` (what a legitimate
 *     one-hop wrapper like `makeEslintProbe` still spells exactly) or the
 *     memo's own direct `= name(...)` call — never a name merely present
 *     somewhere in the text. This closes the two fixtures below without
 *     narrowing the one-hop wrapper case #1552 was built for; the residual
 *     blind spots two points above (transitive wrapper hops, renamed policy
 *     imports) are unchanged and still tracked there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadAstGrepNapi } from "../../clients/deps/ast-grep-napi.js";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";

/** Calls that hand a command line to the OS. */
const SPAWN_CALLS = new Set([
	"exec",
	"execFile",
	"execFileSync",
	"execSync",
	"safeSpawn",
	"safeSpawnAsync",
	"safeSpawnSync",
	"spawn",
	"spawnAsync",
	"spawnSync",
]);

/**
 * Calls that spawn on the unit's behalf. A module that delegates its probe to
 * `createAvailabilityChecker`, `createToolchainAvailability` or a `probeX`
 * helper is still probing.
 */
const SPAWN_DELEGATES =
	/^(?:probe|spawn|exec|run|which|isCommandAvailable|createAvailabilityChecker|createCwdCachedProbe|createToolchainAvailability|resolveCommandWithInstallFallback|verifyOrInstall)/i;

/** Every flag a CLI is asked for its version with. */
const VERSION_FLAGS = new Set([
	"--version",
	"--Version",
	"-version",
	"-V",
	"-v",
	"/version",
	"version",
]);

/**
 * Identifiers that name an availability verdict. Wide on purpose: the review
 * evaded the first draft with `installed`, `cached`, and a bare `Map` named
 * `cache`, none of which contained "avail".
 */
const MEMO_NAME =
	/(?:avail|install|present|detect|cache|found|usable|missing|exists|supported|latch|probed|hastool|ready|enabled)/i;

/**
 * What the parked state has to LOOK like to be an availability verdict. Without
 * this the scan drags in every string cache a probing module happens to own —
 * the installer's `resolvedPathCache`, spotbugs' findings cache — and a gate
 * that cries wolf gets a baseline entry instead of a fix.
 */
const VERDICT_SHAPE = /\bboolean\b|Avail|Latch/i;

const BOOL_LITERAL = /^(?:true|false|null|undefined)$/;

/** Cheap pre-filter for the tree scan, DERIVED from `VERSION_FLAGS` (#883). */
const VERSION_FLAG_TEXT = new RegExp(
	`["'\`](?:${[...VERSION_FLAGS]
		.map((flag) => flag.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"))
		.join("|")})["'\`]`,
);

/** Names that only exist because the shared policy is doing the work. */
const POLICY_FACTORIES = new Set([
	"createAvailabilityChecker",
	"createAvailabilityLatch",
	// Owns the latch, the in-flight dedupe and the decision records for the
	// toolchain clients (#1476). A client that hands its lifecycle to this
	// factory is routed as surely as one that calls the latch itself.
	"createToolchainAvailability",
	// Same standing since #1494: it owns a per-cwd latch, the in-flight dedupe
	// and the decision record for the multi-arg probes (eslint, credo, clippy).
	// Before that migration it stored a bare boolean forever, and listing it here
	// is what makes its consumers VISIBLE to the scan at all.
	"createCwdCachedProbe",
]);
const POLICY_CALLS = new Set([
	...POLICY_FACTORIES,
	"classifyProbeFailure",
	"isLatchingOutcome",
	"isTransientDecision",
	"transientRetryDelayMs",
]);
/** The `SecurityScanClient` seam applies the policy inside the base class. */
const BASE_CLASS_SEAM = new Set([
	"ensureViaInstaller",
	"markTransientlyUnavailable",
	"probeVersion",
	"probeWasTransient",
]);

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_declaration",
	"function_expression",
	"generator_function_declaration",
	"method_definition",
]);

export interface AvailabilityUnit {
	/** Repo-relative POSIX path of the module. */
	file: string;
	/** Top-level declaration the finding belongs to. */
	unit: string;
	/** The memoized verdict that made this unit a consumer. */
	memo: string;
	/** True when the verdict is produced or classified by the shared policy. */
	governed: boolean;
}

/** `"foo"` / `'foo'` → `foo`. */
function unquote(text: string): string {
	return text.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

function baseName(callee: string): string {
	const parts = callee.split(".");
	return parts[parts.length - 1] ?? callee;
}

/**
 * The declared name a member expression hangs off: `registry` for
 * `registry.toolAvailable`, `cached` for `cached.entries.set`.
 *
 * Memo writes are resolved against declarations, and it is the ROOT that is
 * declared — the trailing segments are properties of it. Taking the last
 * segment instead loses the container entirely, so a verdict parked on a
 * module-level registry object reads as an undeclared local and escapes the
 * gate.
 */
function rootName(expr: string): string {
	return expr.split(".")[0] ?? expr;
}

/** Stable identity for a node, used as a scope key. */
function scopeKey(node: SgNode | null): string {
	if (!node) return "<module>";
	const r = node.range();
	return `${r.start.index}:${r.end.index}`;
}

interface Decl {
	name: string;
	/** Scope the binding LIVES in — a write from a deeper scope outlives the call. */
	scope: string;
	isClassField: boolean;
	typeText: string;
	valueText: string;
}

interface Write {
	target: string;
	base: string;
	/** Scope the write happens in. */
	scope: string;
	isThisMember: boolean;
	/** The value being parked, when it is visible at the write site. */
	valueText: string;
}

interface UnitFacts {
	name: string;
	/** Base names of every call in the unit, for module-local call-graph reach. */
	calls: Set<string>;
	decls: Decl[];
	writes: Write[];
	sessionFact: boolean;
	spawns: boolean;
	versionFlag: boolean;
	policyCalls: Set<string>;
	seamCalls: Set<string>;
	extendsSecurityScanClient: boolean;
	latchDecl: string | null;
}

/**
 * Collect the facts for one top-level unit in a single descent, carrying the
 * enclosing function scope so "does this state outlive the call?" is answerable.
 */
function collectUnit(
	root: SgNode,
	constInitializers: Map<string, string>,
	policyHandles: Map<string, string>,
): Omit<UnitFacts, "name"> {
	const facts: Omit<UnitFacts, "name"> = {
		calls: new Set(),
		decls: [],
		writes: [],
		sessionFact: false,
		spawns: false,
		versionFlag: false,
		policyCalls: new Set(),
		seamCalls: new Set(),
		extendsSecurityScanClient: false,
		latchDecl: null,
	};

	const visit = (node: SgNode, scope: string): void => {
		const kind = String(node.kind());
		const childScope = FUNCTION_KINDS.has(kind) ? scopeKey(node) : scope;

		switch (kind) {
			case "string_fragment":
				if (VERSION_FLAGS.has(node.text())) facts.versionFlag = true;
				break;
			case "class_heritage":
				if (/\bextends\s+SecurityScanClient\b/.test(node.text())) {
					facts.extendsSecurityScanClient = true;
				}
				break;
			case "call_expression": {
				const callee = node.field("function")?.text() ?? "";
				const name = baseName(callee);
				facts.calls.add(name);
				if (SPAWN_CALLS.has(name) || SPAWN_DELEGATES.test(name)) {
					facts.spawns = true;
				}
				if (POLICY_CALLS.has(name)) facts.policyCalls.add(name);
				// `java.isAvailableAsync(cwd)` where `java` is a module-level
				// `createAvailabilityChecker(…)` handle: the policy owns that verdict,
				// so the unit is routed even though it names no policy symbol itself.
				const factory = policyHandles.get(callee.split(".")[0] ?? "");
				if (factory) facts.policyCalls.add(factory);
				if (BASE_CLASS_SEAM.has(name)) facts.seamCalls.add(name);
				if (name === "setSessionFact") facts.sessionFact = true;
				// `cache.set(key, verdict)` parks a verdict in a container.
				if (name === "set" && callee.includes(".")) {
					const container = callee.slice(0, callee.lastIndexOf("."));
					const args = node.field("arguments")?.children() ?? [];
					facts.writes.push({
						target: callee,
						base: rootName(container),
						scope: childScope,
						isThisMember: container.startsWith("this."),
						valueText: args[args.length - 2]?.text() ?? "",
					});
				}
				// A version flag hoisted into a const is still a version flag.
				for (const arg of node.field("arguments")?.children() ?? []) {
					const hoisted = constInitializers.get(arg.text());
					if (hoisted && hasVersionFlagText(hoisted)) facts.versionFlag = true;
				}
				break;
			}
			case "public_field_definition":
			case "variable_declarator": {
				const name = node.field("name")?.text() ?? "";
				const valueText = node.field("value")?.text() ?? "";
				if (POLICY_FACTORIES.has(baseName(valueText.split("(")[0] ?? ""))) {
					facts.latchDecl = name;
				}
				facts.decls.push({
					name,
					scope,
					isClassField: kind === "public_field_definition",
					typeText: node.field("type")?.text() ?? "",
					valueText,
				});
				break;
			}
			case "assignment_expression": {
				// Every write is recorded; `findMemo` decides which ones park an
				// availability VERDICT. Filtering on the right-hand side here missed
				// `toolAvailable = await probeTool(cmd)` — the latch whose verdict is
				// computed a function away, which is precisely the shape that hid in
				// `runner-helpers.ts`.
				const left = node.field("left")?.text() ?? "";
				const right = (node.field("right")?.text() ?? "").trim();
				facts.writes.push({
					target: left,
					base: rootName(left),
					scope: childScope,
					isThisMember: left.startsWith("this."),
					valueText: right,
				});
				break;
			}
			default:
				break;
		}

		for (const child of node.children()) visit(child, childScope);
	};

	visit(root, "<module>");
	return facts;
}

function hasVersionFlagText(text: string): boolean {
	return VERSION_FLAG_TEXT.test(text);
}

/**
 * The memo test: state that OUTLIVES the probe call. A local `let ok = …`
 * rebuilt on every call cannot latch anything, so it is not a memo — which is
 * why `installer/index.ts`'s per-call `status.installed` report is not a
 * finding, while `pipeline.ts`'s module-level `_eslintCache` is.
 */
function findMemo(
	facts: Omit<UnitFacts, "name">,
	moduleDecls: Map<string, Decl>,
	options: {
		policyHandleOnly?: boolean;
		policyHandles?: Map<string, string>;
	} = {},
): string | null {
	// `policyHandleOnly` asks the narrower question that decides ROUTING
	// INHERITANCE (#1552): does this unit park a POLICY HANDLE of its own — a
	// verdict object a `POLICY_FACTORY` built, directly or one hop through a
	// module-local wrapper? Only that shape may borrow a callee's routing.
	// Everything else defaults to NOT inheriting: a plain boolean, a
	// `Map<string, "yes" | "no">` string-union verdict, or a boolean reached
	// through a type alias never spells a factory name and is refused by
	// default, which is what a blacklist on "looks like a boolean" could not
	// guarantee (#1552 evaded it by never spelling the banned word).
	// A session fact is not a factory-built HANDLE — `setSessionFact` records a
	// value, it never calls a `POLICY_FACTORY` — so in `policyHandleOnly` mode
	// its presence must not itself grant inheritance. In the default mode it is
	// still the memo: a unit that only ever writes a session fact has no other
	// state to report.
	if (facts.sessionFact && !options.policyHandleOnly) return "setSessionFact";
	// A latch built by a policy factory IS a policy handle, in both senses of
	// the question this function is asked.
	if (facts.latchDecl) return facts.latchDecl;

	// Module-level bindings are in scope for every unit, and a `const cache = new
	// Map()` at the top of the file is exactly where a latch hides from a
	// function that writes to it — `pipeline.ts`'s `_eslintCache` is that shape.
	const declsByName = new Map<string, Decl>(moduleDecls);
	for (const decl of facts.decls) {
		declsByName.set(decl.name, decl);
	}

	for (const write of facts.writes) {
		if (!MEMO_NAME.test(write.target)) continue;
		const decl = declsByName.get(write.base);
		// A class member always outlives the method that writes it — including an
		// inherited accessor with no declaration in this file.
		const persistent =
			write.isThisMember ||
			(decl !== undefined &&
				(decl.isClassField ||
					decl.scope === "<module>" ||
					// Declared in an ENCLOSING scope (a factory closure), written from
					// within: the classic memoizing-closure latch. Containment matters —
					// a same-named local in a sibling branch outlives nothing.
					enclosesScope(decl.scope, write.scope)));
		if (!persistent) continue;
		if (options.policyHandleOnly) {
			if (isPolicyHandleMemoShape(decl, options.policyHandles ?? new Map())) {
				return write.target;
			}
			continue;
		}
		if (holdsVerdict(decl, write.valueText, write.target)) return write.target;
	}

	for (const decl of facts.decls) {
		if (!MEMO_NAME.test(decl.name)) continue;
		if (!decl.isClassField && decl.scope !== "<module>") continue;
		if (options.policyHandleOnly) {
			if (isPolicyHandleMemoShape(decl, options.policyHandles ?? new Map())) {
				return decl.name;
			}
			continue;
		}
		if (holdsVerdict(decl, "", decl.name)) return decl.name;
	}
	return null;
}

/**
 * Does this state hold a POLICY HANDLE — a verdict object a `POLICY_FACTORY`
 * built, directly or through one hop of a module-local wrapper — rather than a
 * hand-rolled latch? This is the WHITELIST #1552 replaced the boolean-shape
 * blacklist with: reachability to a factory NAME is the only thing that grants
 * inheritance, so an unrecognised shape is refused rather than accepted.
 *
 * `policyHandles` is the same name→factory map `collectUnit` already resolves
 * member-call reach against (`java.isAvailableAsync` ← `createAvailabilityChecker`),
 * extended with every top-level function whose OWN body hands its verdict
 * straight to a factory (`makeEslintProbe` ← `createCwdCachedProbe`) — so
 * `Map<string, ReturnType<typeof makeEslintProbe>>` is recognised without a
 * second, hand-rolled classifier.
 *
 * Deliberately reads only the DECLARATION's own `typeText`/`valueText`, never
 * a write's inlined value: a review probe (#1552 round 2) inlined the wrapper
 * call straight into the write site —
 * `toolAvailableByCwd.set(cwd, await makeToolProbe(cmd)(cwd))` against a plain
 * `Map<string, boolean>` declaration — and reading the write's own text let
 * the wrapper's name leak into a hand-rolled boolean latch's shape and pass it
 * off as a handle. A write can echo whatever name it likes; only what the
 * variable was DECLARED to hold is evidence of what it actually is.
 */
function isPolicyHandleMemoShape(
	decl: Decl | undefined,
	policyHandles: Map<string, string>,
): boolean {
	const shape = `${decl?.typeText ?? ""} ${decl?.valueText ?? ""}`;
	for (const factory of POLICY_FACTORIES) {
		if (
			isDeclaredAsTypeConstructor(shape, factory) ||
			isDirectCall(shape, factory)
		) {
			return true;
		}
	}
	for (const handleName of policyHandles.keys()) {
		if (
			isDeclaredAsTypeConstructor(shape, handleName) ||
			isDirectCall(shape, handleName)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Does `name` appear as the memo's own `ReturnType<typeof name>` — one hop,
 * un-nested — rather than merely somewhere in the declaration's text? (#1566)
 *
 * The bare `\bname\b` substring test this replaces reads the handle's name
 * off ANY position in the type, so unwrapping a wrapper's return type all
 * the way down to a plain `boolean` (`Awaited<ReturnType<ReturnType<typeof
 * makeToolProbe>>>`) still spelled the name and passed — the type mentions
 * the handle, but the memo does not hold it. Requiring `ReturnType<typeof
 * name>` to sit un-wrapped (nothing but whitespace, `Map<string, …>`, or the
 * start of the text immediately before it) is what a legitimate one-hop
 * wrapper handle (`Map<string, ReturnType<typeof makeEslintProbe>>`, #1494)
 * still spells exactly, while the doubled/`Awaited`-peeled evasion above
 * does not — its `ReturnType<typeof name>` is immediately preceded by
 * another `ReturnType<` or `Awaited<`, which this rejects.
 */
function isDeclaredAsTypeConstructor(shape: string, name: string): boolean {
	const normalized = shape.replace(/\s+/g, "");
	const needle = `ReturnType<typeof${name}>`;
	let from = 0;
	for (;;) {
		const at = normalized.indexOf(needle, from);
		if (at === -1) return false;
		const before = normalized.slice(Math.max(0, at - "ReturnType<".length), at);
		if (!/(?:ReturnType|Awaited)<$/.test(before)) return true;
		from = at + 1;
	}
}

/**
 * Does the declaration's own value directly CALL `name` — `= name(...)` —
 * rather than merely pass `name` as an argument to something else? (#1566)
 *
 * `emptyCache<boolean>(makeToolProbe)` hands the wrapper to an unrelated
 * helper; the memo it produces is whatever `emptyCache` returns (a plain
 * boolean map), not the wrapper's own handle. A bare substring test could
 * not tell "calls" from "is handed to", which is exactly how that shape
 * inherited routing it never earned.
 */
function isDirectCall(shape: string, name: string): boolean {
	return baseName(shape.trim().split("(")[0] ?? "") === name;
}

/** Is `outer` a strictly enclosing scope of `inner`? Keys are source ranges. */
function enclosesScope(outer: string, inner: string): boolean {
	if (outer === inner) return false;
	if (outer === "<module>") return true;
	if (inner === "<module>") return false;
	const [outerStart, outerEnd] = outer.split(":").map(Number);
	const [innerStart, innerEnd] = inner.split(":").map(Number);
	return (
		(outerStart ?? 0) <= (innerStart ?? 0) && (outerEnd ?? 0) >= (innerEnd ?? 0)
	);
}

/** Does this state hold an availability VERDICT, rather than arbitrary data? */
function holdsVerdict(
	decl: Decl | undefined,
	writtenValue: string,
	target: string,
): boolean {
	const shape = `${decl?.typeText ?? ""} ${decl?.valueText ?? ""} ${writtenValue}`;
	if (VERDICT_SHAPE.test(shape)) return true;
	if (BOOL_LITERAL.test(writtenValue.trim())) return true;
	return /avail/i.test(target);
}

/**
 * A unit is governed when the shared policy — reached through a real import
 * binding — decides or classifies its verdict.
 */
function isGoverned(
	facts: Omit<UnitFacts, "name">,
	policyBindings: Set<string>,
	securityScanClientImported: boolean,
): boolean {
	for (const call of facts.policyCalls) {
		if (policyBindings.has(call)) return true;
	}
	if (
		facts.extendsSecurityScanClient &&
		securityScanClientImported &&
		facts.seamCalls.size > 0
	) {
		return true;
	}
	return false;
}

/** Import BINDINGS — an `import_statement` node, never a comment. */
function readImports(root: SgNode): {
	policyBindings: Set<string>;
	securityScanClientImported: boolean;
} {
	const policyBindings = new Set<string>();
	let securityScanClientImported = false;
	const visit = (node: SgNode): void => {
		if (node.kind() === "import_statement") {
			const source = unquote(node.field("source")?.text() ?? "");
			const clause = node
				.children()
				.find((child) => child.kind() === "import_clause");
			const names = (clause?.text() ?? "")
				.replace(/[{}]/g, " ")
				.split(/[\s,]+/)
				.filter(Boolean);
			const fromPolicy = /availability-policy\.js$/.test(source);
			const fromHelpers = /runner-helpers\.js$/.test(source);
			// The module that owns the toolchain lifecycle, same standing as
			// `runner-helpers.ts` for `createAvailabilityChecker`.
			const fromToolchain = /utils\/toolchain-availability\.js$/.test(source);
			for (const name of names) {
				// `runner-helpers.ts` owns `createAvailabilityChecker` /
				// `createCwdCachedProbe` and RE-EXPORTS the rest of the policy surface,
				// so an import from there binds the same functions as the policy module.
				if ((fromPolicy || fromHelpers) && POLICY_CALLS.has(name)) {
					policyBindings.add(name);
				}
				if (fromToolchain && name === "createToolchainAvailability") {
					policyBindings.add(name);
				}
				if (name === "SecurityScanClient") securityScanClientImported = true;
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return { policyBindings, securityScanClientImported };
}

/** Top-level bindings, which are in scope — and alive — for every unit. */
function readModuleDecls(root: SgNode): Map<string, Decl> {
	const decls = new Map<string, Decl>();
	for (const stmt of topLevelUnits(root)) {
		if (
			stmt.kind() !== "lexical_declaration" &&
			stmt.kind() !== "variable_declaration"
		) {
			continue;
		}
		for (const child of stmt.children()) {
			if (child.kind() !== "variable_declarator") continue;
			const name = child.field("name")?.text();
			if (!name) continue;
			decls.set(name, {
				name,
				scope: "<module>",
				isClassField: false,
				typeText: child.field("type")?.text() ?? "",
				valueText: child.field("value")?.text() ?? "",
			});
		}
	}
	return decls;
}

/** Module-level `const X = …` initializers, for resolving hoisted probe args. */
function readConstInitializers(root: SgNode): Map<string, string> {
	const map = new Map<string, string>();
	const visit = (node: SgNode): void => {
		if (node.kind() === "variable_declarator") {
			const name = node.field("name")?.text();
			const value = node.field("value")?.text();
			if (name && value && !map.has(name)) map.set(name, value);
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return map;
}

function unitLabel(node: SgNode): string {
	const named = node.field("name")?.text();
	if (named) return named;
	const declarator = node
		.children()
		.find((child) => child.kind() === "variable_declarator");
	const declared = declarator?.field("name")?.text();
	if (declared) return declared;
	return String(node.kind());
}

/**
 * The unit list: every top-level declaration, with `export` unwrapped so
 * `export function f` and `function f` are the same unit.
 */
function topLevelUnits(root: SgNode): SgNode[] {
	const units: SgNode[] = [];
	for (const stmt of root.children()) {
		let node = stmt;
		if (node.kind() === "export_statement") {
			const inner = node
				.children()
				.find(
					(child) => child.kind() !== "export" && child.kind() !== "default",
				);
			if (inner) node = inner;
		}
		if (node.kind() === "import_statement" || node.kind() === "comment")
			continue;
		units.push(node);
	}
	return units;
}

export async function analyzeAvailabilityUnits(
	source: string,
	file: string,
): Promise<AvailabilityUnit[]> {
	const napi = await loadAstGrepNapi();
	const root = napi.parse(napi.Lang.TypeScript, source).root();
	const { policyBindings, securityScanClientImported } = readImports(root);
	const constInitializers = readConstInitializers(root);
	const moduleDecls = readModuleDecls(root);
	// A module that DEFINES a policy symbol (the policy itself, and the helpers
	// module that owns `createAvailabilityChecker`) is bound to it as surely as
	// one that imports it.
	for (const unit of topLevelUnits(root)) {
		const label = unitLabel(unit);
		if (POLICY_CALLS.has(label)) policyBindings.add(label);
	}
	const policyHandles = new Map<string, string>();
	for (const [name, decl] of moduleDecls) {
		const factory = baseName(decl.valueText.split("(")[0] ?? "");
		if (POLICY_FACTORIES.has(factory)) policyHandles.set(name, factory);
	}

	const units = topLevelUnits(root).map((node) => ({
		node,
		name: unitLabel(node),
		facts: collectUnit(node, constInitializers, policyHandles),
	}));
	// A top-level FUNCTION whose own body hands its verdict straight to a
	// factory (`makeEslintProbe` returns `createCwdCachedProbe(...)`) is a
	// handle producer as surely as a module-level `const x = createXxx(...)` —
	// `collectUnit` already recorded that reach in the unit's own `policyCalls`,
	// with no propagation needed, since the call sits in the function's own
	// body. Folding it into the same `policyHandles` map is what lets
	// `Map<string, ReturnType<typeof makeEslintProbe>>` read as a policy handle
	// via the ONE whitelist (#1552), instead of a second name-matching rule.
	for (const unit of units) {
		for (const call of unit.facts.policyCalls) {
			if (POLICY_FACTORIES.has(call)) policyHandles.set(unit.name, call);
		}
	}
	propagateProbeReach(units, moduleDecls, policyHandles);

	const found: AvailabilityUnit[] = [];
	for (const unit of units) {
		const { facts } = unit;
		if (!facts.spawns || !facts.versionFlag) continue;
		const memo = findMemo(facts, moduleDecls);
		if (!memo) continue;
		found.push({
			file,
			unit: unit.name,
			memo,
			governed: isGoverned(facts, policyBindings, securityScanClientImported),
		});
	}
	return found;
}

/**
 * Carry "this reaches a version probe" across module-local helpers, to a fixed
 * point.
 *
 * `runner-helpers.ts` is why this exists: pre-#1476 its shared ast-grep latch
 * lived in `isSgAvailableAsync` while the `--version` literal and the spawn sat
 * one function away in `probeAstGrepCommandAsync`. Judging each unit only on its
 * own text let that latch — one of the two sites the file-level gate missed —
 * read as innocent.
 */
function propagateProbeReach(
	units: Array<{ name: string; facts: Omit<UnitFacts, "name"> }>,
	moduleDecls: Map<string, Decl>,
	policyHandles: Map<string, string>,
): void {
	const byName = new Map(units.map((unit) => [unit.name, unit.facts]));
	// Whether a unit spawns on its OWN, captured before propagation starts. A
	// unit that owns its spawn owns its classification too, so it never inherits
	// a neighbour's routing (that separation is why the gate judges per unit).
	const ownSpawn = new Map(
		units.map((unit) => [unit.facts, unit.facts.spawns]),
	);
	// WHITELIST (#1552): a unit may only inherit a callee's routing when its OWN
	// memo is itself traceable to a policy factory — a handle, not a hand-rolled
	// latch. The inverse (blacklist "not recognisably boolean") let anything
	// unspoken through: a `Map<string, "yes" | "no">` string-union verdict, or a
	// boolean reached through a type alias, neither of which spell "boolean",
	// evaded it and inherited routing they never earned. A review probe re-added
	// #1494's own latch beside `getEslintProbe`, delegating the spawn to the
	// routed factory, and the first version of this propagation read it as
	// routed for the same reason.
	const ownPolicyHandleMemo = new Map(
		units.map((unit) => [
			unit.facts,
			findMemo(unit.facts, moduleDecls, {
				policyHandleOnly: true,
				policyHandles,
			}) !== null,
		]),
	);
	let changed = true;
	while (changed) {
		changed = false;
		for (const unit of units) {
			for (const call of unit.facts.calls) {
				const callee = byName.get(call);
				if (!callee || callee === unit.facts) continue;
				if (callee.versionFlag && !unit.facts.versionFlag) {
					unit.facts.versionFlag = true;
					changed = true;
				}
				if (callee.spawns && !unit.facts.spawns) {
					unit.facts.spawns = true;
					changed = true;
				}
				// The probe this unit memoizes is PERFORMED by the callee, so the
				// callee's routing is this unit's routing: `getEslintProbe` parks a
				// handle built by `makeEslintProbe`, and it is `makeEslintProbe` that
				// hands the verdict to the shared policy (#1494). Only for a unit that
				// does not spawn itself — otherwise a hand-rolled latch would launder
				// its verdict through a compliant neighbour.
				if (
					callee.spawns &&
					!ownSpawn.get(unit.facts) &&
					ownPolicyHandleMemo.get(unit.facts)
				) {
					for (const policyCall of callee.policyCalls) {
						if (unit.facts.policyCalls.has(policyCall)) continue;
						unit.facts.policyCalls.add(policyCall);
						changed = true;
					}
				}
			}
		}
	}
}

function* walkTs(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			yield* walkTs(full);
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".d.ts") &&
			!entry.name.endsWith(".test.ts")
		) {
			yield full;
		}
	}
}

export async function scanClientsTree(
	repoRoot: string,
): Promise<AvailabilityUnit[]> {
	const clientsRoot = path.join(repoRoot, "clients");
	const found: AvailabilityUnit[] = [];
	for (const file of walkTs(clientsRoot)) {
		const source = fs.readFileSync(file, "utf-8");
		// Parsing every module in `clients/` costs seconds. A module with no
		// version flag ANYWHERE in its text cannot contain a version probe — the
		// hoisted-const case reads its initializer from the same file — so this
		// skip cannot hide a consumer, only make the gate affordable.
		if (!VERSION_FLAG_TEXT.test(source)) continue;
		const rel = path.relative(repoRoot, file).split(path.sep).join("/");
		found.push(...(await analyzeAvailabilityUnits(source, rel)));
	}
	return found.sort((a, b) =>
		`${a.file}::${a.unit}`.localeCompare(`${b.file}::${b.unit}`),
	);
}

/** `clients/foo.ts::Bar` — the identity a gate finding is keyed by. */
export function unitId(unit: AvailabilityUnit): string {
	return `${unit.file}::${unit.unit}`;
}
