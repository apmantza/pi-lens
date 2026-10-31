/**
 * Shape 4 sweep: every abort listener in the shipped trees is a watcher that is
 * released on every settle path.
 *
 * ## The recurrence this guards
 *
 * Racing a promise against a caller's `AbortSignal` was written five times as
 * `new Promise((resolve) => signal.addEventListener("abort", () => resolve(),
 * { once: true }))` inside a `Promise.race`, and none of the five ever removed
 * the listener. A signal outlives one call (a turn's signal, a sweep's), so each
 * call left a dead closure on it until the signal itself died: the warm-up race,
 * its retry backoff and the per-file pre-open in `clients/lsp/index.ts`, the
 * analyzer race in `clients/project-diagnostics/fresh-fetch.ts`, and the
 * per-file race in `tools/lsp-diagnostics.ts` (one listener per file of a
 * batch). Two more copies removed theirs correctly, one in
 * `clients/out-of-band-changes.ts` and one in the first-contact wait, and the
 * fix routed all seven through `untilAborted` (`clients/deadline-utils.ts`).
 *
 * ## What is admitted, and what is refused
 *
 * Fail closed. A SITE is any of: a code token `addEventListener`,
 * `addAbortListener` or `.onabort` (a call, an alias, a destructured binding, a
 * bracket-string access); a computed call whose method name is not a plain
 * string literal (`signal["add" + "EventListener"](...)`, a template with a
 * substitution); or an `once`/`on` call whose event is `"abort"` or is not a
 * string literal (a constant, a template, a spread). Only a plain literal event
 * of another name, and `x[Symbol.iterator]()`, are read as not-a-site. A site is
 * admitted only when it is a registered key in `ADMITTED_SITES` with its reason,
 * and a registered site that claims a release also holds a
 * `removeEventListener` token in its outermost enclosing function. Everything
 * else refuses, including a site whose release is named only in a comment. The
 * set of registered sites is held to equality in both directions, so a site that
 * moved or vanished reds as STALE instead of silently re-admitting a deleted
 * release.
 *
 * ## Accepted gap (p3)
 *
 * A spelling that never names the listener method or the event in the scanned
 * file still passes: an aliased import (`import { once as waitFor } from
 * "node:events"`, then `waitFor(signal, "abort")`), a method fetched by
 * `Reflect.get(signal, "add" + "EventListener")`, and a listener attached in a
 * file outside `clients/`, `mcp/`, `tools/` and `index.ts`. The scan cannot read
 * an indirection that crosses a binding; closing it means keying on the
 * `AbortSignal` type, which this file does not have. No live site is missed
 * today (`rg` over the shipped trees is clean).
 *
 * Structure comes from the parsed tree, never from text: a comment or a string
 * that spells the token is not a site and cannot excuse one.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRoot, walkAst } from "../support/ast-census.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";
import {
	assertNonEmptyScan,
	findEnclosingSymbol,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The napi node type is untyped, exactly as the other AST sweeps read it. */
// oxlint-disable-next-line typescript/no-explicit-any
type SgNode = any;

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_declaration",
	"function_expression",
	"generator_function",
	"generator_function_declaration",
	"method_definition",
]);

/**
 * Tokens that attach a listener to an abort signal, as code or as a string:
 * `addEventListener`, the `onabort` property and `addAbortListener`
 * (`node:events`, documented for this very job).
 */
const ADD_TOKENS = new Set(["addEventListener", "onabort", "addAbortListener"]);

interface AbortListenerSite {
	/** `<file>#<enclosing symbol> <token>`, `#n` on a repeat; stable under line churn. */
	key: string;
	/** Does the outermost enclosing function hold a `removeEventListener` token? */
	releases: boolean;
}

/** The text of a leaf that is a token or the content of a string literal. */
function tokenOf(node: SgNode): string | undefined {
	if (node.children().length > 0) return undefined;
	const kind: string = node.kind();
	if (kind === "comment") return undefined;
	return node.text();
}

function outermostFunction(node: SgNode): SgNode | undefined {
	let found: SgNode | undefined;
	for (let current = node.parent(); current; current = current.parent()) {
		if (FUNCTION_KINDS.has(current.kind())) found = current;
	}
	return found;
}

/**
 * Does `scope` hold `token` as CODE? Per-needle policy: an ADD token counts as a
 * site when it is a string (`signal["addEventListener"]`), but a release counts
 * only as code, so a string that spells `removeEventListener` cannot excuse a
 * listener (the self-excuse direction).
 */
function holdsCodeToken(scope: SgNode, token: string): boolean {
	let found = false;
	walkAst(scope, (node: SgNode) => {
		if (found || node.kind() === "string_fragment") return;
		if (tokenOf(node) === token) found = true;
	});
	return found;
}

const EVENT_METHODS = new Set(["once", "on"]);

/** A string literal with no substitution (a template with `${}` is not one). */
function isPlainString(node: SgNode | undefined): boolean {
	return node?.kind() === "string";
}

/** The text between a string literal's quotes. */
function stringValue(node: SgNode): string {
	return node.text().slice(1, -1);
}

/**
 * The callee's method name, or `undefined` when it is not a plain name: a
 * computed callee (`x[expr](...)`) whose index is not a string literal.
 */
function calleeName(fn: SgNode | undefined): string | undefined {
	if (!fn) return undefined;
	if (fn.kind() === "member_expression") return fn.field("property")?.text();
	if (fn.kind() === "subscript_expression") {
		const index = fn.field("index");
		return isPlainString(index) ? stringValue(index) : undefined;
	}
	return fn.text();
}

/**
 * A call that can attach a listener under a name or event the scan cannot read.
 * Fail closed: it is a site unless BOTH the method name and the event are plain
 * string literals that name something other than the abort event.
 *   - a computed callee whose index is not a string literal (`s["add" + "X"](...)`,
 *     a template with a substitution), whatever the call passes;
 *   - an `once`/`on` call whose event is not a string literal, or is `"abort"`.
 *     The event is the first argument of an emitter's own `.on("evt", fn)` and
 *     the second of `events.once(target, "evt")`, so a literal first argument
 *     names the event and a non-literal one sends us to the second.
 */
function isUnreadableListenerCall(node: SgNode): boolean {
	if (node.kind() !== "call_expression") return false;
	const fn = node.field("function");
	if (fn?.kind() === "subscript_expression" && calleeName(fn) === undefined) {
		// `x[Symbol.iterator]()` is the one admitted computed form: a well-known
		// symbol cannot name a listener method.
		return !/^Symbol\.\w+$/.test(fn.field("index")?.text() ?? "");
	}
	const name = calleeName(fn);
	if (name === undefined || !EVENT_METHODS.has(name)) return false;
	const args: SgNode[] = node.field("arguments")?.namedChildren() ?? [];
	if (args.some((arg) => arg.kind() === "spread_element")) return true;
	const [first, second] = args;
	if (isPlainString(first)) return stringValue(first) === "abort";
	if (isPlainString(second)) return stringValue(second) === "abort";
	return true;
}

/**
 * A speed screen, not a verdict: it must admit every text that can hold a site
 * (a listener token, an `once`/`on` call or string name, or a
 * computed call `](`), because a
 * parse of every shipped file costs 6x the screened scan.
 */
const MAY_HOLD_SITE =
	/addEventListener|addAbortListener|onabort|\b(?:once|on)\s*\??\.?\s*[<(]|["'`](?:once|on)["'`]|\]\s*\??\.?\s*[<(]/;

/** Every abort-listener site in one source text. */
export function scanAbortListenerSites(
	source: string,
	relPath = "<source>",
): AbortListenerSite[] {
	if (!MAY_HOLD_SITE.test(source)) return [];
	const lines = source.split("\n");
	const seen = new Map<string, number>();
	const sites: AbortListenerSite[] = [];
	walkAst(parseRoot(source), (node: SgNode) => {
		const token = tokenOf(node);
		const isToken = token !== undefined && ADD_TOKENS.has(token);
		if (!isToken && !isUnreadableListenerCall(node)) return;
		const label = isToken ? token : "events-abort";
		const line = node.range().start.line;
		const symbol = findEnclosingSymbol(lines, line) ?? `line-${line + 1}`;
		const base = `${relPath}#${symbol} ${label}`;
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		const scope = outermostFunction(node);
		sites.push({
			key: n === 1 ? base : `${base} #${n}`,
			releases: scope ? holdsCodeToken(scope, "removeEventListener") : false,
		});
	});
	return sites;
}

/**
 * Every listener site in the shipped trees. A value is the reason the site is
 * admitted; `release: "paired"` means the site must hold a
 * `removeEventListener` in its function, `"none"` means it cannot and says why.
 */
const ADMITTED_SITES: Readonly<
	Record<string, { release: "paired" | "none"; reason: string }>
> = {
	"clients/agent-nudge.ts#wireAgentNudgeSubscriber events-abort": {
		release: "none",
		reason:
			"pi.events.on(BUS_FILES_TOUCHED_EVENT, ...): the bus's named-constant event, not the abort event",
	},
	"clients/deadline-utils.ts#bounded addEventListener": {
		release: "paired",
		reason:
			"bounded()'s caller-signal bound; released in its finally (#2530 F2/F4)",
	},
	"clients/deadline-utils.ts#bounded addEventListener #2": {
		release: "paired",
		reason: "bounded()'s teardown-signal bound; released in its finally",
	},
	"clients/deadline-utils.ts#combineAbortSignals addEventListener": {
		release: "none",
		reason:
			"the AbortSignal.any-absent fallback, unreachable on engines >=22.19.0 (package.json); the composite dies with its sources",
	},
	"clients/deadline-utils.ts#untilAborted addEventListener": {
		release: "paired",
		reason: "the one race of a promise against a caller's abort signal",
	},
	"clients/lsp/client.ts#clientWaitForDiagnostics events-abort": {
		release: "none",
		reason:
			"the diagnostics emitter's named-constant event (PENDING_RECEIPT_DROPPED), not the abort event; an emitter of ours, not a signal",
	},
	"clients/lsp/client.ts#safeSendRequest addEventListener": {
		release: "paired",
		reason:
			"cancels the request's CancellationToken on abort, not a race; released in the request's finally",
	},
	"clients/runtime-turn.ts#runTestTargetsBounded addEventListener": {
		release: "paired",
		reason:
			"the batch's own finish() path: kills the pool, clears the timer and removes the listener",
	},
	"clients/safe-spawn.ts#installLifetimeCleanup events-abort": {
		release: "none",
		reason:
			"process.once(signal, ...) over SIGINT, SIGTERM and SIGHUP, not the abort event",
	},
	"clients/safe-spawn.ts#safeSpawnAsync addEventListener": {
		release: "paired",
		reason:
			"kills the child on abort; removed on every settle path of the spawn",
	},
};

let shippedScan: { sites: AbortListenerSite[]; scannedFiles: number };

function scanShippedTrees(): {
	sites: AbortListenerSite[];
	scannedFiles: number;
} {
	if (shippedScan) return shippedScan;
	const files = [
		...listSourceFiles(path.join(REPO_ROOT, "clients"), { skipTests: true }),
		...listSourceFiles(path.join(REPO_ROOT, "mcp"), { skipTests: true }),
		...listSourceFiles(path.join(REPO_ROOT, "tools"), { skipTests: true }),
		path.join(REPO_ROOT, "index.ts"),
	];
	const sites: AbortListenerSite[] = [];
	let scannedFiles = 0;
	for (const file of files) {
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		scannedFiles++;
		sites.push(
			...scanAbortListenerSites(source, relativePosix(REPO_ROOT, file)),
		);
	}
	shippedScan = { sites, scannedFiles };
	return shippedScan;
}

describe("abort-listener release sweep (shape 4)", () => {
	it(
		"admits only registered sites, and a paired site holds its removal",
		() => {
			const { sites, scannedFiles } = scanShippedTrees();
			// #1718 shape: a walk that resolved to nothing would read as a clean sweep.
			assertNonEmptyScan("abort-listener sweep (files)", scannedFiles, 300);
			assertNonEmptyScan("abort-listener sweep (sites)", sites.length, 5);
			const unregistered = sites
				.filter((site) => ADMITTED_SITES[site.key] === undefined)
				.map((site) => site.key);
			expect(
				unregistered,
				"UNREGISTERED abort listener: route the race through untilAborted (clients/deadline-utils.ts) or register the site with its reason",
			).toEqual([]);
			const unreleased = sites
				.filter(
					(site) =>
						ADMITTED_SITES[site.key]?.release === "paired" && !site.releases,
				)
				.map((site) => site.key);
			expect(
				unreleased,
				"a registered site claims a release but holds no removeEventListener in its function",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"pins the population in both directions",
		() => {
			const live = scanShippedTrees()
				.sites.map((site) => site.key)
				.sort();
			const registered = Object.keys(ADMITTED_SITES).sort();
			expect(
				registered.filter((key) => !live.includes(key)),
				"STALE registrations — the scan no longer finds these sites; delete them",
			).toEqual([]);
			expect(live).toEqual(registered);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	describe("refuses spellings the registry was not written for", () => {
		const refused = (source: string): AbortListenerSite[] =>
			scanAbortListenerSites(source, "plant.ts").filter(
				(site) => ADMITTED_SITES[site.key] === undefined,
			);

		it("a direct listener with no removal", () => {
			const sites = refused(
				[
					"export function wait(signal: AbortSignal) {",
					"  return new Promise<void>((resolve) => {",
					'    signal.addEventListener("abort", () => resolve(), { once: true });',
					"  });",
					"}",
				].join("\n"),
			);
			expect(sites.map((site) => site.key)).toEqual([
				"plant.ts#wait addEventListener",
			]);
			expect(sites[0]?.releases).toBe(false);
		});

		it("an alias of the method, an indirect call and a bracket access", () => {
			const sites = refused(
				[
					"export function alias(signal: AbortSignal, f: () => void) {",
					"  const add = signal.addEventListener.bind(signal);",
					'  add("abort", f);',
					"}",
					"export function indirect(signal: AbortSignal, f: () => void) {",
					'  Reflect.apply(signal.addEventListener, signal, ["abort", f]);',
					"}",
					"export function bracket(signal: AbortSignal, f: () => void) {",
					'  signal["addEventListener"]("abort", f);',
					"}",
				].join("\n"),
			);
			expect(sites.map((site) => site.key)).toEqual([
				"plant.ts#alias addEventListener",
				"plant.ts#indirect addEventListener",
				"plant.ts#bracket addEventListener",
			]);
		});

		it("a target reached through another binding, a destructure and onabort", () => {
			const sites = refused(
				[
					"export function viaBinding(turn: { signal: AbortSignal }, f: () => void) {",
					"  const target: EventTarget = turn.signal;",
					'  target.addEventListener("abort", f);',
					"}",
					"export function destructured(signal: AbortSignal) {",
					"  const { addEventListener } = signal;",
					"}",
					"export function property(signal: AbortSignal, f: () => void) {",
					"  signal.onabort = f;",
					"}",
				].join("\n"),
			);
			expect(sites.map((site) => site.key)).toEqual([
				"plant.ts#viaBinding addEventListener",
				"plant.ts#destructured addEventListener",
				"plant.ts#property onabort",
			]);
		});

		it("an events.once wait on the abort event", () => {
			const sites = refused(
				[
					'import { once } from "node:events";',
					"export async function wait(signal: AbortSignal) {",
					'  await once(signal, "abort");',
					"}",
				].join("\n"),
			);
			expect(sites.map((site) => site.key)).toEqual([
				"plant.ts#wait events-abort",
			]);
		});

		// #5077 review r1 F1: the detector was a token denylist, so a spelling it
		// did not list (the node:events helper, a computed or constant name) passed
		// as no site at all. Each plant below slipped through.
		it("addAbortListener from node:events", () => {
			const sites = refused(
				[
					'import { addAbortListener } from "node:events";',
					"export function wait(signal: AbortSignal, f: () => void) {",
					"  const handle = addAbortListener(signal, f);",
					"  return handle;",
					"}",
				].join("\n"),
			);
			expect(sites.length).toBeGreaterThan(0);
			expect(sites.map((site) => site.key)).toContain(
				"plant.ts#wait addAbortListener",
			);
		});

		it("a method name built at run time", () => {
			const sites = refused(
				[
					"export function concat(signal: AbortSignal, f: () => void) {",
					'  signal["add" + "EventListener"]("abort", f);',
					"}",
					"export function template(signal: AbortSignal, f: () => void) {",
					'  signal[`add${"Event"}Listener`]("abort", f);',
					"}",
				].join("\n"),
			);
			expect(sites.map((site) => site.key)).toEqual([
				"plant.ts#concat events-abort",
				"plant.ts#template events-abort",
			]);
		});

		it("an events.once wait whose event is a constant, a template or hidden in a spread", () => {
			const sites = refused(
				[
					'import { once } from "node:events";',
					'const EVENT = "abort";',
					"export async function viaConstant(signal: AbortSignal) {",
					"  await once(signal, EVENT);",
					"}",
					"export async function viaTemplate(signal: AbortSignal) {",
					'  await once(signal, `${"ab"}ort`);',
					"}",
					"export async function viaSpread(args: [AbortSignal, string]) {",
					'  await once(...args, "exit");',
					"}",
				].join("\n"),
			);
			expect(sites.map((site) => site.key)).toEqual([
				"plant.ts#viaConstant events-abort",
				"plant.ts#viaTemplate events-abort",
				"plant.ts#viaSpread events-abort",
			]);
		});

		// #5077 verify r1 V7: the first-literal arm (`emitter.on("abort", f)`) had no
		// plant, so neutering it stayed green. The second-literal arm is the
		// `once(signal, "abort")` wait above.
		it("an emitter's own on with the abort event as its first literal", () => {
			const sites = refused(
				[
					"export function viaEmitter(emitter: NodeJS.EventEmitter, f: () => void) {",
					'  emitter.on("abort", f);',
					"}",
				].join("\n"),
			);
			expect(sites.map((site) => site.key)).toEqual([
				"plant.ts#viaEmitter events-abort",
			]);
		});

		it("an emitter's own on/once with a literal event that is not abort", () => {
			// Not noise: the rule is fail-closed on the UNREADABLE, so a plain
			// literal event of another name stays out of the population.
			const source = [
				'import { once } from "node:events";',
				"export async function quiet(child: NodeJS.EventEmitter, f: () => void) {",
				'  child.on("close", f);',
				'  child.once("error", f);',
				'  await once(child, "exit");',
				// Split before the call: ast-census.test.ts reads this line as text.
				"  return pair[Symbol.iterator]" + "();",
				"}",
			].join("\n");
			expect(scanAbortListenerSites(source, "plant.ts")).toEqual([]);
		});

		it("a removal named only in a comment or a string", () => {
			const source = [
				"export function wait(signal: AbortSignal, f: () => void) {",
				'  signal.addEventListener("abort", f);',
				'  // signal.removeEventListener("abort", f);',
				"  const note = 'removeEventListener';",
				"  return note;",
				"}",
			].join("\n");
			const sites = scanAbortListenerSites(source, "plant.ts");
			expect(sites).toHaveLength(1);
			expect(sites[0]?.releases).toBe(false);
		});

		it("does not count a listener that exists only in a comment or a string", () => {
			const source = [
				"export function advice() {",
				'  // signal.addEventListener("abort", f);',
				"  return 'signal.addEventListener(abort)';",
				"}",
			].join("\n");
			expect(scanAbortListenerSites(source, "plant.ts")).toEqual([]);
		});

		it("sees a removal in the function that adds the listener", () => {
			const source = [
				"export function paired(signal: AbortSignal, f: () => void) {",
				'  signal.addEventListener("abort", f, { once: true });',
				"  return () => {",
				'    signal.removeEventListener("abort", f);',
				"  };",
				"}",
			].join("\n");
			expect(scanAbortListenerSites(source, "plant.ts")).toEqual([
				{ key: "plant.ts#paired addEventListener", releases: true },
			]);
		});
	});
});
