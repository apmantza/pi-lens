/**
 * #3389 population sweep — every `node:net` socket in the shipped trees has an
 * `error` listener.
 *
 * ## The recurrence this guards
 *
 * A `net.Socket` with no `error` listener RETHROWS, and the rethrow lands as an
 * uncaught exception in whichever host owns the socket. `clients/warm-attach.ts`
 * shipped that shape: `server.on("error")` covered the listener while every
 * ACCEPTED socket was bare, so a client destroying its connection mid-reply
 * killed the pi session (#3389, measured). `mcp/server.ts` had the listener; the
 * two `net.createConnection` clients in `clients/mcp/ipc.ts` had theirs. Nothing
 * in the type system tells the two apart, and the population is small and
 * enumerable — so it is pinned here, in both directions, and a new server or
 * client socket with no `error` binding fails this file rather than a user's
 * session.
 *
 * ## What is scanned, and how
 *
 * `clients/`, `mcp/`, `tools/`, `tests/support/` and `index.ts` (`scripts/` has
 * no `node:net` site: `grep -rn "node:net" scripts/` is empty, and a script
 * that grew one would be a build-time tool, not a host). The broader `tests/`
 * corpus is an explicit admission (`TESTS_CORPUS_FAULT_INJECTION`): those test
 * cases intentionally create fault-injection sockets and are not shared host
 * fixtures; `tests/support/` is the reusable fixture population and is scanned.
 * Call sites come from the AST
 * (`@ast-grep/napi`), so a factory named in prose is not a call site, and the
 * `error` binding is required as CODE via `codeMatches` — a comment or a
 * string that spells `socket.on("error")` cannot satisfy it (the dangerous
 * direction: prose making a guard pass).
 *
 * Two roles, one rule:
 * - `net.createServer(handler)` — the socket is the handler's own parameter, so
 *   the binding must be inside that handler.
 * - `net.createConnection(...)` / `net.connect(...)` — the socket is the call's
 *   value, so the binding must be inside the function that holds it.
 *
 * A site whose socket identifier cannot be resolved (a handler passed by name,
 * a connection not bound to a variable) is reported LOUD as unresolved rather
 * than silently counted as compliant.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRoot, walkAst } from "../support/ast-census.js";
import {
	assertNonEmptyScan,
	codeMatches,
	escapeRegExp,
	findEnclosingSymbol,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The `node:net` factories that hand back a socket. */
const SOCKET_FACTORIES = new Set([
	"createServer",
	"createConnection",
	"connect",
]);

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_declaration",
	"function_expression",
	"generator_function",
	"generator_function_declaration",
	"method_definition",
]);

interface SocketSite {
	/** `<file>#<enclosing symbol> <factory>` — stable under line churn. */
	key: string;
	factory: string;
	role: "accepted" | "connected";
	socket: string;
	hasErrorListener: boolean;
}

interface SocketScan {
	sites: SocketSite[];
	unresolved: string[];
}

/** The napi node type is untyped, exactly as `parseNodes` walks it. */
// oxlint-disable-next-line typescript/no-explicit-any
type SgNode = any;

function enclosingFunctionText(node: SgNode): string | undefined {
	for (let current = node.parent(); current; current = current.parent()) {
		if (FUNCTION_KINDS.has(current.kind())) return current.text();
	}
	return undefined;
}

/** The variable this call's value is bound to, if it is bound directly. */
function assignedName(node: SgNode): string | undefined {
	const parent = node.parent();
	if (parent?.kind() !== "variable_declarator") return undefined;
	const name = parent.field("name");
	return name?.kind() === "identifier" ? name.text() : undefined;
}

function bindsError(scope: string, socket: string): boolean {
	return (
		codeMatches(
			scope,
			new RegExp(
				`\\b${escapeRegExp(socket)}\\s*\\.\\s*(?:on|once|addListener|prependListener|prependOnceListener)\\s*\\(\\s*["']error["']`,
			),
		).length > 0
	);
}

/** Every `node:net` socket site in one source text, with its verdict. */
function scanSocketSites(source: string, relPath = "<source>"): SocketScan {
	const sites: SocketSite[] = [];
	const unresolved: string[] = [];
	if (!/createServer|createConnection|connect/.test(source)) {
		return { sites, unresolved };
	}
	const lines = source.split("\n");
	walkAst(parseRoot(source), (node: SgNode) => {
		if (node.kind() !== "call_expression") return;
		const fn = node.field("function");
		if (fn?.kind() !== "member_expression") return;
		if (fn.field("object")?.text() !== "net") return;
		const factory = fn.field("property")?.text() ?? "";
		if (!SOCKET_FACTORIES.has(factory)) return;
		const line = node.range().start.line;
		const symbol = findEnclosingSymbol(lines, line) ?? `line-${line + 1}`;
		const key = `${relPath}#${symbol} ${factory}`;
		if (factory === "createServer") {
			const handler = node.field("arguments")?.namedChildren()[0];
			const parameter =
				handler && FUNCTION_KINDS.has(handler.kind())
					? (handler.field("parameters")?.namedChildren()[0] ??
						handler.field("parameter"))
					: undefined;
			const socket = parameter?.text();
			if (!socket || !/^[A-Za-z_$][\w$]*$/.test(socket)) {
				unresolved.push(
					`${key}: the connection handler's socket parameter is not a plain identifier — name it and bind "error" on it`,
				);
				return;
			}
			sites.push({
				key,
				factory,
				role: "accepted",
				socket,
				hasErrorListener: bindsError(handler.text(), socket),
			});
			return;
		}
		const socket = assignedName(node);
		const scope = enclosingFunctionText(node) ?? source;
		if (!socket) {
			unresolved.push(
				`${key}: the connected socket is not bound to a variable — bind it and attach "error" on it`,
			);
			return;
		}
		sites.push({
			key,
			factory,
			role: "connected",
			socket,
			hasErrorListener: bindsError(scope, socket),
		});
	});
	return { sites, unresolved };
}

/**
 * The live population, with the per-site verdict recorded in #3389's sweep.
 * Held to EXACT equality in both directions: a new site reds as UNPINNED, a
 * site that moved or vanished reds as STALE. A pin that only grows would
 * silently re-admit a deleted listener (#3279's stale-pin shape).
 */
const PINNED_SITES: Readonly<Record<string, string>> = {
	"clients/mcp/ipc.ts#probeIpcSocketListener createConnection":
		// #5702: the retention sweep's liveness dial. The error listener IS
		// the probe's answer: a no-listener errno resolves "dead", anything
		// else "indeterminate" (kept), so no net error can be unhandled.
		"connecting dial; socket.on(error, cause => finish(isNoListenerError(cause) ? dead : indeterminate)) — the verdict is the sweep's keep/delete gate",
	"clients/mcp/ipc.ts#requestOverWarmIpc createConnection":
		'connected socket; `socket.on("error", …)` finishes the request as unavailable (clients/mcp/ipc.ts:312) — correct before #3389',
	"clients/mcp/ipc.ts#requestWarmAnalyze createConnection":
		'connected socket; `socket.on("error", () => finish(undefined))` — correct before #3389',
	"clients/warm-attach.ts#startServer createServer":
		'accepted socket; the #3389 fix — `socket.on("error", …)` counts the errno in the degradation ledger',
	"mcp/server.ts#startIpcServer createServer":
		'accepted socket; `socket.on("error", () => socket.destroy())` — correct before #3389',
};

function scanShippedTrees(): {
	sites: SocketSite[];
	unresolved: string[];
	scannedFiles: number;
} {
	const files = [
		...listSourceFiles(path.join(REPO_ROOT, "clients"), { skipTests: true }),
		...listSourceFiles(path.join(REPO_ROOT, "mcp"), { skipTests: true }),
		...listSourceFiles(path.join(REPO_ROOT, "tools"), { skipTests: true }),
		...listSourceFiles(path.join(REPO_ROOT, "tests", "support"), {
			skipTests: true,
		}),
		path.join(REPO_ROOT, "index.ts"),
	];
	const sites: SocketSite[] = [];
	const unresolved: string[] = [];
	let scannedFiles = 0;
	for (const file of files) {
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		scannedFiles++;
		const scan = scanSocketSites(source, relativePosix(REPO_ROOT, file));
		sites.push(...scan.sites);
		unresolved.push(...scan.unresolved);
	}
	return { sites, unresolved, scannedFiles };
}

describe("node:net socket error-listener sweep (#3389)", () => {
	it("binds an error listener on every socket in the shipped trees", () => {
		const { sites, unresolved, scannedFiles } = scanShippedTrees();
		// #1718 shape: a walk that resolved to nothing would read as a clean
		// sweep. 300 is comfortably under the ~470 TypeScript files these trees
		// held when this sweep was written.
		assertNonEmptyScan(
			"socket error-listener sweep (files)",
			scannedFiles,
			300,
		);
		assertNonEmptyScan("socket error-listener sweep (sites)", sites.length, 4);
		expect(unresolved).toEqual([]);
		expect(
			sites
				.filter((site) => !site.hasErrorListener)
				.map((site) => `${site.key} (${site.role} socket: ${site.socket})`),
		).toEqual([]);
	});

	it("pins the population in both directions", () => {
		const { sites } = scanShippedTrees();
		const live = sites.map((site) => site.key).sort();
		const pinned = Object.keys(PINNED_SITES).sort();
		expect(
			live.filter((key) => !pinned.includes(key)),
			"UNPINNED live net socket sites — add each with its verdict to PINNED_SITES",
		).toEqual([]);
		expect(
			pinned.filter((key) => !live.includes(key)),
			"STALE pins — the scan no longer finds these sites; re-pin from the live scan",
		).toEqual([]);
	});

	it("does not accept a listener that exists only in a comment or a string", () => {
		// The self-excuse direction: prose must never satisfy the requirement.
		const source = [
			"import * as net from 'node:net';",
			"export function startServer() {",
			"  const server = net.createServer((socket) => {",
			'    // socket.on("error", () => socket.destroy());',
			"    const advice = 'socket.on(\"error\", handler)';",
			"    socket.on('data', () => advice);",
			"  });",
			"  return server;",
			"}",
		].join("\n");
		expect(scanSocketSites(source, "fixture.ts").sites).toEqual([
			{
				key: "fixture.ts#startServer createServer",
				factory: "createServer",
				role: "accepted",
				socket: "socket",
				hasErrorListener: false,
			},
		]);
	});

	it("accepts a real binding through any of the listener spellings", () => {
		for (const spelling of ["on", "once", "prependListener"]) {
			const source = [
				"export function startServer() {",
				"  return net.createServer((peer) => {",
				`    peer.${spelling}("error", () => peer.destroy());`,
				"  });",
				"}",
			].join("\n");
			expect(
				scanSocketSites(source, "fixture.ts").sites[0]?.hasErrorListener,
				spelling,
			).toBe(true);
		}
	});

	it("reports an unresolvable socket loud instead of passing it", () => {
		const byName = [
			"export function startServer() {",
			"  return net.createServer(handleConnection);",
			"}",
		].join("\n");
		const scan = scanSocketSites(byName, "fixture.ts");
		expect(scan.sites).toEqual([]);
		expect(scan.unresolved).toEqual([
			'fixture.ts#startServer createServer: the connection handler\'s socket parameter is not a plain identifier — name it and bind "error" on it',
		]);
		const unbound = [
			"export function ping() {",
			"  net.createConnection('/tmp/x.sock').write('hi');",
			"}",
		].join("\n");
		expect(scanSocketSites(unbound, "fixture.ts").unresolved).toEqual([
			'fixture.ts#ping createConnection: the connected socket is not bound to a variable — bind it and attach "error" on it',
		]);
	});

	it("requires the binding in the scope that HOLDS the socket, not anywhere in the file", () => {
		// A sibling function's listener must not excuse this one's socket: that
		// laundering is how a third client in clients/mcp/ipc.ts would ship bare.
		const source = [
			"export function guarded() {",
			"  const socket = net.createConnection('/tmp/a.sock');",
			"  socket.on('error', () => undefined);",
			"  return socket;",
			"}",
			"export function bare() {",
			"  const socket = net.connect('/tmp/b.sock');",
			"  return socket;",
			"}",
		].join("\n");
		expect(
			scanSocketSites(source, "fixture.ts").sites.map((site) => [
				site.key,
				site.hasErrorListener,
			]),
		).toEqual([
			["fixture.ts#guarded createConnection", true],
			["fixture.ts#bare connect", false],
		]);
	});
});
