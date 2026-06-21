#!/usr/bin/env node
/**
 * playground-cdp.mjs — minimal CDP driver for pi-lens's playground verifier.
 * Adapted from GreedySearch-pi's bin/cdp.mjs (https://github.com/apmantza/GreedySearch-pi)
 * with the daemon/target-resolution/snap/shot machinery stripped down to the
 * minimum needed for one-shot tab + eval. The full cdp.mjs has 1000+ lines of
 * accessibility-tree rendering, network tracing, and persistent per-tab
 * daemons — all useful for GreedySearch's flow, but irrelevant to "navigate
 * to the playground, eval some JS, read the result".
 *
 * Usage:
 *   node scripts/playground-cdp.mjs list
 *   node scripts/playground-cdp.mjs nav <targetId> <url>
 *   node scripts/playground-cdp.mjs eval <targetId> <js-expr>
 *   node scripts/playground-cdp.mjs snap <targetId>
 *
 * Uses the dedicated Chrome launched by playground-chrome.mjs (port 9224 by
 * default). The DevToolsActivePort file is read from the same profile dir.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

const PORT = Number(process.env.PILENS_PLAYGROUND_PORT) || 9224;
const PROFILE_DIR = join(tmpdir(), "pilens-playground-profile");
const ACTIVE_PORT = join(PROFILE_DIR, "DevToolsActivePort");
const TIMEOUT_MS = 30_000;

// Node 22+ exposes WebSocket as a global. GreedySearch's cdp.mjs uses
// `import { WebSocket } from "ws"` for Node 20 compat — we don't need
// the dep, but pin to the global so this script is self-contained.
const WS = globalThis.WebSocket;

class CDP {
	#ws;
	#id = 0;
	#pending = new Map();
	#handlers = new Map();
	constructor(wsUrl) {
		this.#ws = new WS(wsUrl);
		this.#ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id && this.#pending.has(msg.id)) {
				const { resolve, reject } = this.#pending.get(msg.id);
				this.#pending.delete(msg.id);
				if (msg.error) reject(new Error(msg.error.message));
				else resolve(msg.result);
			} else if (msg.method && this.#handlers.has(msg.method)) {
				for (const h of this.#handlers.get(msg.method)) {
					try {
						h(msg.params || {}, msg);
					} catch {}
				}
			}
		};
	}
	on(method, handler) {
		if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
		this.#handlers.get(method).add(handler);
		return () => this.#handlers.get(method).delete(handler);
	}
	connect() {
		return new Promise((res, rej) => {
			this.#ws.onopen = () => res();
			this.#ws.onerror = (e) =>
				rej(new Error(`ws error: ${e.message || e.type}`));
		});
	}
	send(method, params = {}, sessionId) {
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			const msg = { id, method, params };
			if (sessionId) msg.sessionId = sessionId;
			this.#ws.send(JSON.stringify(msg));
			setTimeout(() => {
				if (this.#pending.has(id)) {
					this.#pending.delete(id);
					reject(new Error(`Timeout: ${method}`));
				}
			}, TIMEOUT_MS);
		});
	}
	close() {
		try {
			this.#ws.close();
		} catch {}
	}
}

function readPortFile() {
	if (!existsSync(ACTIVE_PORT)) {
		throw new Error(
			`Chrome not running. Start with: node scripts/playground-chrome.mjs launch`,
		);
	}
	return readFileSync(ACTIVE_PORT, "utf-8").trim().split("\n");
}

async function connect() {
	const [port, wsPath] = readPortFile();
	if (Number(port) !== PORT) {
		throw new Error(
			`DevToolsActivePort reports port ${port} but expected ${PORT}. Is another Chrome using this profile?`,
		);
	}
	// Verify Chrome is actually reachable on /json/version.
	const ver = await new Promise((resolve, reject) => {
		const req = http.get(`http://127.0.0.1:${PORT}/json/version`, (res) => {
			let b = "";
			res.on("data", (d) => (b += d));
			res.on("end", () => resolve(b));
		});
		req.on("error", reject);
		req.setTimeout(2000, () => {
			req.destroy();
			reject(new Error(`Chrome /json/version timed out on port ${PORT}`));
		});
	});
	const json = JSON.parse(ver);
	const cdp = new CDP(
		json.webSocketDebuggerUrl || `ws://127.0.0.1:${PORT}${wsPath}`,
	);
	await cdp.connect();
	return cdp;
}

async function cmdList() {
	const cdp = await connect();
	try {
		const { targetInfos } = await cdp.send("Target.getTargets");
		const pages = targetInfos
			.filter((t) => t.type === "page")
			.map((t) => ({
				targetId: t.targetId,
				url: t.url,
				title: t.title,
			}));
		console.log(JSON.stringify(pages, null, 2));
	} finally {
		cdp.close();
	}
}

async function cmdNewPage() {
	// Always create with about:blank, then nav separately. The
	// Target.createTarget path is racy: the load event for the
	// initial URL can fire before the cdp.mjs handler subscribes to
	// Page.loadEventFired (Page.enable happens after attach). Going
	// through about:blank first means nav's load event is guaranteed
	// to fire post-subscribe. The URL arg is accepted for ergonomics
	// and dropped — callers should run `nav <targetId> <url>` after.
	const cdp = await connect();
	try {
		const { targetId } = await cdp.send("Target.createTarget", {
			url: "about:blank",
		});
		console.log(JSON.stringify({ targetId, note: "call nav to load a URL" }));
	} finally {
		cdp.close();
	}
}

async function cmdNav(targetId, url) {
	const cdp = await connect();
	try {
		const { sessionId } = await cdp.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		// Enable Page BEFORE navigating so the load event lands on a
		// subscribed handler. (Page.enable also implicitly enables
		// the load-event notification.)
		await cdp.send("Page.enable", {}, sessionId);
		const navP = new Promise((resolve) => {
			const off = cdp.on("Page.loadEventFired", (params) => {
				if (params.sessionId === sessionId) {
					off();
					resolve(params);
				}
			});
		});
		await cdp.send("Page.navigate", { url }, sessionId);
		// Hard cap on wait — if the page never fires (cached load,
		// 204, etc.) the script shouldn't hang.
		const result = await Promise.race([
			navP,
			new Promise((resolve) =>
				setTimeout(() => resolve({ timeout: true }), 10_000),
			),
		]);
		console.log(
			JSON.stringify({
				ok: !result.timeout,
				url,
				targetId,
				sessionId,
				timedOut: !!result.timeout,
			}),
		);
	} finally {
		cdp.close();
	}
}

async function cmdEval(targetId, expr) {
	const cdp = await connect();
	try {
		const { sessionId } = await cdp.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		await cdp.send("Runtime.enable", {}, sessionId);
		const { result, exceptionDetails } = await cdp.send(
			"Runtime.evaluate",
			{ expression: expr, returnByValue: true, awaitPromise: true },
			sessionId,
		);
		if (exceptionDetails) {
			console.error(
				`page eval error: ${exceptionDetails.text} (${JSON.stringify(exceptionDetails).slice(0, 200)})`,
			);
			process.exit(2);
		}
		// Stringify objects, primitives pass through
		if (result?.value === undefined) {
			console.log("undefined");
		} else if (typeof result?.value === "string") {
			console.log(result.value);
		} else {
			console.log(JSON.stringify(result?.value));
		}
	} finally {
		cdp.close();
	}
}

async function cmdSnap(targetId) {
	const cdp = await connect();
	try {
		const { sessionId } = await cdp.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		await cdp.send("Accessibility.enable", {}, sessionId);
		const { nodes } = await cdp.send(
			"Accessibility.getFullAXTree",
			{},
			sessionId,
		);
		// Best-effort: print a flat text-ish representation (nodeId, role, name).
		for (const n of nodes) {
			const role = n.role?.value ?? "";
			const name = n.name?.value ?? "";
			const value = n.value?.value ?? "";
			const text = (name || value || "").replace(/\s+/g, " ").trim();
			if (text) console.log(`[${role}] ${text}`);
		}
	} finally {
		cdp.close();
	}
}

const [cmd, ...args] = process.argv.slice(2);
const handlers = {
	list: () => cmdList().catch(reportErr),
	newpage: () => cmdNewPage().catch(reportErr),
	nav: () => cmdNav(args[0], args[1]).catch(reportErr),
	eval: () => cmdEval(args[0], args.slice(1).join(" ")).catch(reportErr),
	snap: () => cmdSnap(args[0]).catch(reportErr),
	help: () => {
		console.log(`playground-cdp.mjs — minimal CDP driver for the pi-lens playground verifier.

Usage:
  playground-cdp.mjs list                       List page targets
  playground-cdp.mjs newpage                   Create a new about:blank page
  playground-cdp.mjs nav  <targetId> <url>    Navigate + wait for load (10s cap)
  playground-cdp.mjs eval <targetId> <js>     Evaluate JS in page context
  playground-cdp.mjs snap <targetId>          Print accessible names`);
	},
};

function reportErr(e) {
	console.error(e.message);
	process.exit(1);
}

if (!handlers[cmd]) {
	console.error(`unknown command: ${cmd}`);
	handlers.help();
	process.exit(2);
}
const result = handlers[cmd]();
// The WebSocket close() in CDP doesn't always release the event loop on
// Windows — the process can hang for 30s waiting for the close handshake.
// Force-exit after the work is done.
if (result && typeof result.then === "function") {
	result.then(
		() => process.exit(0),
		(e) => {
			console.error(e.message);
			process.exit(1);
		},
	);
} else {
	process.exit(0);
}
