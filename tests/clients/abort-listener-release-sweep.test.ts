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
 * Fail closed. A code token `addEventListener` (a call, an alias, a destructured
 * binding, a bracket-string access), a `.onabort` property, or an `events.once`
 * or `events.on` call whose event is `"abort"` is a SITE. A site is admitted only
 * when it is a registered key in `ADMITTED_SITES` with its reason, and a
 * registered site that claims a release also holds a `removeEventListener` token
 * in its outermost enclosing function. Everything else refuses, including a site
 * whose release is named only in a comment. The set of registered sites is held
 * to equality in both directions, so a site that moved or vanished reds as STALE
 * instead of silently re-admitting a deleted release.
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

/** Tokens that attach a listener to an `EventTarget`, as code or as a string. */
const ADD_TOKENS = new Set(["addEventListener", "onabort"]);

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

/** An `events.once(signal, "abort")` / `events.on(signal, "abort")` call. */
function isEventsAbortCall(node: SgNode): boolean {
	if (node.kind() !== "call_expression") return false;
	const fn = node.field("function");
	const name =
		fn?.kind() === "member_expression"
			? fn.field("property")?.text()
			: fn?.text();
	if (name !== "once" && name !== "on") return false;
	const second = node.field("arguments")?.namedChildren()[1];
	return second?.kind() === "string" && /^["']abort["']$/.test(second.text());
}

/** Every abort-listener site in one source text. */
export function scanAbortListenerSites(
	source: string,
	relPath = "<source>",
): AbortListenerSite[] {
	if (!/addEventListener|onabort|["']abort["']/.test(source)) return [];
	const lines = source.split("\n");
	const seen = new Map<string, number>();
	const sites: AbortListenerSite[] = [];
	walkAst(parseRoot(source), (node: SgNode) => {
		const token = tokenOf(node);
		const isToken = token !== undefined && ADD_TOKENS.has(token);
		if (!isToken && !isEventsAbortCall(node)) return;
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
