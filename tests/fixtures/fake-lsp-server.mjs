// Minimal JSON-RPC 2.0 LSP fake server over stdio
// Used for integration tests — speaks real LSP protocol without actual language smarts

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// #2436: parent-death watchdog. A test that spawns this fixture and then
// dies without running its own cleanup (a SIGKILLed vitest worker fork, a
// `--force` worktree removal) must not leave this process running forever —
// a real orphan was found on disk an hour after its parent process no
// longer existed, holding its worktree directory open. Two independent
// triggers, because neither alone covers every real teardown shape:
//
//   - stdin EOF: the parent's write end of this process's stdio pipe closes
//     the instant the parent's file descriptors are torn down — true
//     whether it exits cleanly, crashes, or is SIGKILLed (the OS closes a
//     dead process's handles/fds unconditionally, pipes included). This
//     covers the large majority of real teardown paths, INCLUDING a
//     wedged/paused stdin (`FAKE_LSP_WEDGE_STDIN_AFTER_INIT` calls
//     `stdin.pause()`, but a paused Readable still delivers the underlying
//     `end` once the fd itself reports EOF — measured on both Windows and
//     Linux at well under 100ms after the parent process dies; `pause()`
//     only stops flowing `data`, it does not block `end`). Set
//     `FAKE_LSP_SKIP_EOF_EXIT=1` to disable this trigger for a test that
//     needs to isolate the second trigger below.
//   - a `process.ppid` liveness poll — the backstop for the ONE shape stdin
//     EOF cannot cover: a pipe write-end held open by something other than
//     this process's direct parent (e.g. Windows handle-inheritance capture
//     by a long-lived process — see the "#472 CORRECTION" comment at
//     clients/lsp/client.ts:1278-1286). When some other live handle keeps
//     the write end open, the OS never delivers EOF to this process no
//     matter how dead the parent is, so stdin alone is not airtight; the
//     poll is the only trigger that doesn't depend on the pipe staying
//     closeable at all. POSIX reparents an orphan to init/a subreaper, so a
//     changed `process.ppid` is itself conclusive; Windows does NOT do this
//     — `process.ppid` is fixed at process-creation time and never updates
//     to reflect the live parent, so a bare value comparison is a
//     POSIX-only signal there. The portable check is whether the ORIGINAL
//     parent pid is still alive at all: `process.kill(pid, 0)` sends no
//     signal, it only probes existence (ESRCH means gone) — a syscall
//     probe, not a spawned `taskkill` (AGENTS.md's "held handle, not a
//     spawned taskkill" teardown note).
const PARENT_WATCHDOG_INTERVAL_MS = 1000;
const initialPpid = process.ppid;

function parentIsAlive() {
	if (!initialPpid) return true;
	if (process.ppid !== initialPpid) return false;
	try {
		process.kill(initialPpid, 0);
		return true;
	} catch {
		return false;
	}
}

const parentWatchdog = setInterval(() => {
	if (!parentIsAlive()) {
		clearInterval(parentWatchdog);
		process.exit(1);
	}
}, PARENT_WATCHDOG_INTERVAL_MS);
parentWatchdog.unref();

// FAKE_LSP_SKIP_EOF_EXIT=1 disables the stdin-EOF trigger above, isolating
// the ppid poll so a test can prove IT ALONE reaps a parentless process —
// see the second case in
// tests/clients/lsp/fake-lsp-server-parent-watchdog.test.ts.
if (process.env.FAKE_LSP_SKIP_EOF_EXIT !== "1") {
	process.stdin.on("end", () => {
		process.exit(0);
	});
}

function encode(message) {
	const json = JSON.stringify(message);
	const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
	return Buffer.concat([
		Buffer.from(header, "utf8"),
		Buffer.from(json, "utf8"),
	]);
}

function decodeFrames(buffer) {
	const results = [];
	let idx;
	while ((idx = buffer.indexOf("\r\n\r\n")) !== -1) {
		const header = buffer.slice(0, idx).toString("utf8");
		const m = /Content-Length:\s*(\d+)/i.exec(header);
		const len = m ? Number.parseInt(m[1], 10) : 0;
		const bodyStart = idx + 4;
		const bodyEnd = bodyStart + len;
		if (buffer.length < bodyEnd) break;
		const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
		results.push(body);
		buffer = buffer.slice(bodyEnd);
	}
	return { messages: results, rest: buffer };
}

let readBuffer = Buffer.alloc(0);
let applyEditIdCounter = 9000;
let pendingExec = null;
// #2479: the edit spec held back by "fake.applyEditDeferred" until a later
// "fake.releaseDeferredApplyEdit" call sends it. Lets a test open an
// executeCommand window, run an UNRELATED nested executeCommand to completion
// inside it, and only THEN have the outer call's server-initiated applyEdit
// arrive - the ordering the depth-unwind bug lives in, with no reliance on
// message-arrival timing.
let deferredApplyEdit = null;

// #4801: "FAKE_LSP_HANG_PROJECT_INFO" hangs the tsserver `projectInfo` request
// (see the advertised commands and the executeCommand branch below).
const HANG_PROJECT_INFO = ["1", "cancel"].includes(
	process.env.FAKE_LSP_HANG_PROJECT_INFO ?? "",
);
let hungProjectInfoId = null;

// #2450 review round 2 (F2): the target line/columns/replacement text are
// overridable via a second `arguments[1]` object so callers can exercise a real
// non-{1,1} range - a fixed line-0 edit made every caller's "real range" collide
// with the {1,1} resource-op/whole-file default, so a test asserting {1,1}
// passed whether or not the actual range plumbing worked. Omitted fields keep
// the original line-0/0-5 default, so the pre-existing "applies a
// server-initiated edit..." tests are unaffected.
//
// #2479 review round 2 (S1): declared at MODULE scope, beside the state they
// read (`applyEditIdCounter`, `deferredApplyEdit`) and beside `send` - they
// used to sit inside `handle(raw)`, which re-created both closures on every
// single inbound message and left the block that follows them mis-indented.
function buildApplyEditSpec(commandArguments) {
	const uri = commandArguments?.[0];
	const editOpts = commandArguments?.[1] ?? {};
	const line = typeof editOpts.line === "number" ? editOpts.line : 0;
	const startCharacter =
		typeof editOpts.startCharacter === "number" ? editOpts.startCharacter : 0;
	const endCharacter =
		typeof editOpts.endCharacter === "number" ? editOpts.endCharacter : 5;
	const newText =
		typeof editOpts.newText === "string" ? editOpts.newText : "EDITED";
	return { uri, line, startCharacter, endCharacter, newText };
}

function sendApplyEdit(spec) {
	send({
		jsonrpc: "2.0",
		id: ++applyEditIdCounter,
		method: "workspace/applyEdit",
		params: {
			edit: {
				changes: {
					[spec.uri]: [
						{
							range: {
								start: { line: spec.line, character: spec.startCharacter },
								end: { line: spec.line, character: spec.endCharacter },
							},
							newText: spec.newText,
						},
					],
				},
			},
		},
	});
}

const openDocuments = new Map();
const didCreateUris = new Set();

// #2824: deterministic pull/push wire controls for the LSP wait-hardening
// matrix. These are environment-configured because the fixture is a separate
// process. The completion notification lets a test await the exact operation
// through its governed child-progress wait, without observing a later state
// after an unbounded timer has already fired.
const PULL_PUSH_BEFORE_RESPONSE =
	process.env.FAKE_LSP_PUSH_BEFORE_PULL_RESPONSE === "1";
const PULL_PUSH_AFTER_RESPONSE =
	process.env.FAKE_LSP_PUSH_AFTER_PULL_RESPONSE === "1";
const PULL_PUSH_VERSION = Number.parseInt(
	process.env.FAKE_LSP_PUSH_VERSION ?? "",
	10,
);
const PULL_RESPONSE = process.env.FAKE_LSP_RESPOND_PULL_WITH;
const PULL_COMPLETION_SIGNAL = process.env.FAKE_LSP_PULL_COMPLETION === "1";
const PULL_DIAGNOSTIC_MESSAGE =
	process.env.FAKE_LSP_DIAGNOSTIC_MESSAGE ??
	"actual diagnostic\nfor further information visit https://example.test\nhttps://example.test/docs";
const PULL_DIAGNOSTIC_SOURCE =
	process.env.FAKE_LSP_DIAGNOSTIC_SOURCE ?? "fake-lsp";
const DELAY_AFTER_FIRST_PULL_MS = Number.parseInt(
	process.env.FAKE_LSP_DELAY_AFTER_FIRST_PULL_MS ?? "0",
	10,
);
// `FAKE_LSP_DELAY_FIRST_PULL=1` counts the first pull as already served, so
// `FAKE_LSP_DELAY_AFTER_FIRST_PULL_MS` delays it too (#4322: a server that is
// slow from its very first answer, with no earlier case priming it).
let pullCount = process.env.FAKE_LSP_DELAY_FIRST_PULL === "1" ? 1 : 0;

function sendPullPush(uri) {
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri,
			...(Number.isInteger(PULL_PUSH_VERSION)
				? { version: PULL_PUSH_VERSION }
				: {}),
			diagnostics: [
				{
					severity: 1,
					code: "FAKE-2824-PUSH",
					message: "diagnostic from ordered fake server push",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
				},
			],
		},
	});
}

// #3310: an ASYNCHRONOUSLY INDEXING push server's publish sequence, measured
// against the real intelephense 1.18.5 (see docs/lsp-capability-matrix.md's
// `first-publish` column): it answers `didOpen` with an EMPTY set while its
// whole-workspace index builds, then publishes again once indexing ends — the
// real set on a dirty file, another empty set on a clean one.
//
// `FAKE_LSP_PUBLISH_SEQUENCE=empty,dirty` spells that sequence on the wire;
// each element is one publish, `empty` an empty set and `dirty` a one-element
// set. `FAKE_LSP_PUBLISH_SEQUENCE_GAP_MS` (default 300) is the gap between
// consecutive publishes, standing in for the index window. Publishes are
// VERSION-LESS, matching the measured server. Off by default, so every
// existing test keeps the incumbent silent-on-open behaviour.
const PUBLISH_SEQUENCE = (process.env.FAKE_LSP_PUBLISH_SEQUENCE ?? "")
	.split(",")
	.map((part) => part.trim())
	.filter(Boolean);
const PUBLISH_SEQUENCE_GAP_MS = Number(
	process.env.FAKE_LSP_PUBLISH_SEQUENCE_GAP_MS ?? "300",
);
// #3484: delay before the FIRST publish (default 0: published while the
// didOpen/didChange is handled, before any request sent after it is read).
// Measured intelephense answers a documentSymbol sent in the same tick first
// (+2..4 ms) and publishes ~1 s later, which a positive delay reproduces.
const PUBLISH_SEQUENCE_FIRST_MS = Number(
	process.env.FAKE_LSP_PUBLISH_SEQUENCE_FIRST_MS ?? "0",
);

// #4764: `window/showMessage` traffic, so a test can drive the client's own
// handler over a real wire. `FAKE_LSP_SHOW_MESSAGES` is a JSON array of
// `{ type, message }` (LSP `MessageType`: 1 Error, 2 Warning, 3 Info, 4 Log);
// `FAKE_LSP_SHOW_MESSAGE` plus `FAKE_LSP_SHOW_MESSAGE_TYPE` (default 1, Error)
// spells the single-message case. Messages are sent on `initialized` unless
// `FAKE_LSP_SHOW_MESSAGE_AFTER_FIRST_PUBLISH=1`, which sends them right after
// the FIRST publish of `FAKE_LSP_PUBLISH_SEQUENCE` — the order measured from
// opengrep 1.30.0 offline (an empty publish at +10ms, then the rule-download
// error in the same tick). `FAKE_LSP_SHOW_MESSAGE_DELAY_MS` (default 0) delays
// that emission, so a test can choose whether the publish's debounce has
// already stored the answer when the message arrives.
const SHOW_MESSAGES = (() => {
	const raw = process.env.FAKE_LSP_SHOW_MESSAGES;
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed
					.filter((m) => m && typeof m.message === "string")
					.map((m) => ({ type: Number(m.type ?? 1), message: m.message }));
			}
		} catch {
			/* a malformed array falls through to the single-message knob */
		}
	}
	const message = process.env.FAKE_LSP_SHOW_MESSAGE;
	if (!message) return [];
	return [
		{
			type: Number(process.env.FAKE_LSP_SHOW_MESSAGE_TYPE ?? "1"),
			message,
		},
	];
})();
const SHOW_MESSAGES_AFTER_FIRST_PUBLISH =
	process.env.FAKE_LSP_SHOW_MESSAGE_AFTER_FIRST_PUBLISH === "1";
const SHOW_MESSAGE_DELAY_MS = Number(
	process.env.FAKE_LSP_SHOW_MESSAGE_DELAY_MS ?? "0",
);

function emitShowMessages() {
	for (const message of SHOW_MESSAGES) {
		send({
			jsonrpc: "2.0",
			method: "window/showMessage",
			params: { type: message.type, message: message.message },
		});
	}
}

function scheduleShowMessages() {
	if (SHOW_MESSAGE_DELAY_MS > 0) {
		const timer = setTimeout(emitShowMessages, SHOW_MESSAGE_DELAY_MS);
		timer.unref?.();
		return;
	}
	emitShowMessages();
}

// #4320: a server that caches a failed module lookup, as Pyrefly 1.3.2 does
// (measured: `import new_module` keeps its missing-import after the module is
// created, until the server hears a `Created` watched-files event; `Changed`
// does not clear it). `FAKE_LSP_STALE_MODULE_LOOKUP=1` makes every open
// document's `import "./name"` (or `"../dir/name"`) line resolve to
// `<dir>/name.lua` relative to the document, remember a
// lookup that failed, and re-evaluate every open document when a `Created`
// event for the missing file arrives. Push diagnostics, version-matched.
// Off by default. #4346: `FAKE_LSP_STALE_MODULE_EXT` (default `.lua`) names
// the module's extension, so a TypeScript side-effect import
// (`import "./name"`), which the review graph extracts, can model it too.
const STALE_MODULE_LOOKUP = process.env.FAKE_LSP_STALE_MODULE_LOOKUP === "1";
const STALE_MODULE_EXT = process.env.FAKE_LSP_STALE_MODULE_EXT ?? ".lua";
const failedModuleLookups = new Set();

// #4532: a server whose module search path comes from a config file at its
// root, as pyright's `pyrightconfig.json` `extraPaths` does (measured, pyright
// 1.1.414: a config created after the server answered is read only when a
// `workspace/didChangeWatchedFiles` event names it; the registered watchers
// are `**/pyrightconfig.json` and `**`). `FAKE_LSP_CONFIG_FILE=<name>` makes a
// module that is not beside its importer resolve from `<root>/libs` when the
// config read at initialize, or at the last watched-files event naming
// `<root>/<name>`, holds `"extraPaths": ["libs"]`. Such an event drops every
// remembered failed lookup and re-evaluates every open document. Off by
// default.
const CONFIG_FILE = process.env.FAKE_LSP_CONFIG_FILE ?? "";
let configRoot;
let configExtraDirs = [];

function readServerConfig() {
	configExtraDirs = [];
	if (CONFIG_FILE === "" || configRoot === undefined) return;
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(configRoot, CONFIG_FILE), "utf8"),
		);
		for (const extra of parsed.extraPaths ?? [])
			configExtraDirs.push(path.join(configRoot, extra));
	} catch {
		// no config (or unreadable): the module search path stays the importer's dir
	}
}

function resolvesFromConfig(target) {
	return configExtraDirs.some((extra) =>
		fs.existsSync(path.join(extra, path.basename(target))),
	);
}

function publishModuleLookups(uri) {
	const text = openDocuments.get(uri) ?? "";
	const dir = path.dirname(fileURLToPath(uri));
	const diagnostics = [];
	for (const match of text.matchAll(/import\s+"(\.\.?\/[\w/-]+)"/g)) {
		const target = path.join(dir, `${match[1]}${STALE_MODULE_EXT}`);
		if (
			!failedModuleLookups.has(target) &&
			!fs.existsSync(target) &&
			!resolvesFromConfig(target)
		) {
			failedModuleLookups.add(target);
		}
		if (failedModuleLookups.has(target)) {
			diagnostics.push({
				severity: 1,
				source: "fake-stale-lookup",
				code: "missing-import",
				message: `Cannot find module ${path.basename(match[1])}`,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			});
		}
	}
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: { uri, diagnostics },
	});
}

// #4476/#4507: a checker whose view of a CLOSED file is what it read first, as
// TypeScript 7's native server behaves (measured with a raw JSON-RPC probe of
// `tsc --lsp --stdio`, TS 7.0.2): it registers `<root>/**/*` and
// `<root>/node_modules/**/*` as client watchers and re-reads a closed file
// only when a watched-files event names that exact file (a directory or
// manifest event changes nothing), or when it restarts. An open document's
// view is the bytes it was sent. With `FAKE_LSP_NO_DIAGNOSTIC_PROVIDER=1`
// every change to a view republishes every open document (push, version-less),
// as the real server republishes dependents; otherwise each pull is answered
// from the views held then. Opt in with `FAKE_LSP_CLOSED_FILE_CACHE=1`; off by
// default.
//
// The checks, on each open document:
// - `import { A, B } from "./m"` (`m.ts`, then `m.d.ts`) or `from "pkg"`
//   (`<root>/node_modules/pkg/index.d.ts`): a name the module's view does not
//   export is `Module '"m"' has no exported member 'A'.` (2305); a module with
//   no view is `Cannot find module 'm'.` (2307);
// - a `G_NAME` token no ambient declaration declares (`declare const G_NAME`
//   in a `.d.ts` outside node_modules, seen at initialize or announced by a
//   Created event since) is `Cannot find name 'G_NAME'.` (2304).
const CLOSED_FILE_CACHE = process.env.FAKE_LSP_CLOSED_FILE_CACHE === "1";
const closedViews = new Map();
const ambientFiles = new Set();
let checkerRoot;

function viewOf(filePath) {
	const open = openDocuments.get(pathToFileURL(filePath).href);
	if (open !== undefined) return open;
	if (!closedViews.has(filePath)) {
		let text;
		try {
			text = fs.readFileSync(filePath, "utf8");
		} catch {
			text = undefined;
		}
		closedViews.set(filePath, text);
	}
	return closedViews.get(filePath);
}

function walkAmbient(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules" && entry.name !== ".git")
				walkAmbient(full);
		} else if (entry.name.endsWith(".d.ts")) {
			ambientFiles.add(full);
		}
	}
}

function checkerDiagnostics(uri) {
	const text = openDocuments.get(uri) ?? "";
	const dir = path.dirname(fileURLToPath(uri));
	const diagnostics = [];
	const range = {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 1 },
	};
	const report = (code, message) =>
		diagnostics.push({ severity: 1, source: "fake-checker", code, message, range });
	for (const match of text.matchAll(
		/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g,
	)) {
		const spec = match[2];
		const candidates = spec.startsWith(".")
			? [path.join(dir, `${spec}.ts`), path.join(dir, `${spec}.d.ts`)]
			: [path.join(checkerRoot ?? dir, "node_modules", spec, "index.d.ts")];
		const view = candidates
			.map((candidate) => viewOf(candidate))
			.find((candidate) => candidate !== undefined);
		if (view === undefined) {
			report(2307, `Cannot find module '${spec}'.`);
			continue;
		}
		const exported = new Set(
			[
				...view.matchAll(
					/export\s+(?:declare\s+)?(?:function|const|let|type|interface|class)\s+(\w+)/g,
				),
			].map((m) => m[1]),
		);
		for (const name of match[1]
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean)) {
			if (!exported.has(name))
				report(2305, `Module '"${spec}"' has no exported member '${name}'.`);
		}
	}
	const declared = new Set();
	for (const file of ambientFiles) {
		for (const m of (viewOf(file) ?? "").matchAll(/declare\s+const\s+(G_\w+)/g))
			declared.add(m[1]);
	}
	for (const name of new Set([...text.matchAll(/\bG_\w+\b/g)].map((m) => m[0]))) {
		if (!declared.has(name)) report(2304, `Cannot find name '${name}'.`);
	}
	return diagnostics;
}

// Push mode republishes every open document on each change to a view; pull
// mode (`FAKE_LSP_NO_DIAGNOSTIC_PROVIDER` unset) answers each pull from the
// views it holds at that moment.
//
// #4782: `FAKE_LSP_DEFER_DEPENDENTS_MS` re-checks only the document whose
// change or open triggered the pass (`changedUri`) at once; every other open
// document is re-checked that many ms later, against the views held then
// (pyright's and typescript-language-server's dependent re-check is a
// debounced timer, measured +360..400 ms). A watched-files event names no open
// document, so it defers them all. A drain reply can then come before the
// dependents' answers.
function checkEveryOpenDocument(changedUri) {
	if (process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER !== "1") return;
	const publish = (uri) =>
		send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri, diagnostics: checkerDiagnostics(uri) },
		});
	const deferMs = Number(process.env.FAKE_LSP_DEFER_DEPENDENTS_MS ?? "");
	if (!(Number.isFinite(deferMs) && deferMs > 0)) {
		for (const uri of openDocuments.keys()) publish(uri);
		return;
	}
	if (changedUri !== undefined) publish(changedUri);
	const dependents = [...openDocuments.keys()].filter(
		(uri) => uri !== changedUri,
	);
	setTimeout(() => {
		for (const uri of dependents)
			if (openDocuments.has(uri)) publish(uri);
	}, deferMs);
}

// #4763: opengrep's rule-load window. A `refreshed` element sends the param-less
// `semgrep/rulesRefreshed` notification (opengrep@60ed3b3
// `Scan_helpers.refresh_rules`): `empty,refreshed,dirty` is the measured cold
// open of `--config auto` (`[]` at +10 ms, the notification at +0.7..1.0 s, the
// findings after it). Once it has been sent the rules are loaded, so a LATER
// open publishes only what follows the `refreshed` element (the warm shape:
// `dirty` alone). Without a `refreshed` element nothing changes.
let sequenceRefreshed = false;

// #5131: a recompile-from-disk server (groovy-language-server). It "compiles"
// one document at a time: `didOpen` and `didChange` publish one error when the
// text holds `Foo` (an unresolved class), else an empty set, after
// `FAKE_LSP_RECOMPILE_CLEARS_MS` of compile time for the open. A
// `workspace/didChangeWatchedFiles` naming an open document recompiles it from
// the tracker's reset state and publishes an EMPTY set 5 ms after the compile
// queue drains, whatever the document holds (measured on the real server: the
// `unable to resolve class Foo` error, then its `[]` 5 ms later, 100 ms after
// the client's own watched-files notice). Publishes are version-less unless
// `FAKE_LSP_RECOMPILE_VERSIONED=1` stamps the document version the server last
// read; `FAKE_LSP_RECOMPILE_NO_WATCHED_CLEAR=1` leaves the notice unanswered;
// `FAKE_LSP_RECOMPILE_MARK_PUBLISHES=1` follows each publish with a
// `$/test/publishSent` notification.
const RECOMPILE_CLEARS_MS = Number(
	process.env.FAKE_LSP_RECOMPILE_CLEARS_MS ?? "-1",
);
const RECOMPILE_VERSIONED = process.env.FAKE_LSP_RECOMPILE_VERSIONED === "1";
const RECOMPILE_NO_WATCHED_CLEAR =
	process.env.FAKE_LSP_RECOMPILE_NO_WATCHED_CLEAR === "1";
const RECOMPILE_MARK_PUBLISHES =
	process.env.FAKE_LSP_RECOMPILE_MARK_PUBLISHES === "1";
const recompileVersions = new Map();
let recompileBusyUntil = 0;
function recompilePublish(uri, diagnostics, compileMs = 0) {
	const version = recompileVersions.get(uri);
	const at = Math.max(Date.now() + compileMs, recompileBusyUntil) + 5;
	recompileBusyUntil = at;
	const timer = setTimeout(() => {
		send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: {
				uri,
				diagnostics,
				...(RECOMPILE_VERSIONED && version !== undefined ? { version } : {}),
			},
		});
		// The client has handled the publish by the time it reads this marker, so
		// a test joins on it instead of polling.
		if (RECOMPILE_MARK_PUBLISHES)
			send({
				jsonrpc: "2.0",
				method: "$/test/publishSent",
				params: { uri, count: diagnostics.length },
			});
	}, at - Date.now());
	timer.unref?.();
}
function recompileCompile(uri, text, compileMs) {
	recompilePublish(
		uri,
		text.includes("Foo")
			? [
					{
						severity: 1,
						source: "fake-recompile",
						code: "P5131",
						message: "unable to resolve class Foo",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 1 },
						},
					},
				]
			: [],
		compileMs,
	);
}

function publishSequenceFor(uri) {
	if (PUBLISH_SEQUENCE.length === 0) return false;
	const sequence = sequenceRefreshed
		? PUBLISH_SEQUENCE.slice(PUBLISH_SEQUENCE.indexOf("refreshed") + 1)
		: PUBLISH_SEQUENCE;
	sequence.forEach((shape, index) => {
		const emit = () => {
			if (shape === "refreshed") {
				sequenceRefreshed = true;
				send({ jsonrpc: "2.0", method: "semgrep/rulesRefreshed" });
				return;
			}
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {
					uri,
					diagnostics:
						shape === "dirty"
							? [
									{
										severity: 1,
										source: "fake-indexing",
										code: "P3310",
										message: "diagnostic published after the index warmed",
										range: {
											start: { line: 0, character: 0 },
											end: { line: 0, character: 1 },
										},
									},
								]
							: [],
				},
			});
		};
		if (index === 0 && PUBLISH_SEQUENCE_FIRST_MS <= 0) {
			emit();
			if (SHOW_MESSAGES_AFTER_FIRST_PUBLISH) scheduleShowMessages();
			return;
		}
		const timer = setTimeout(
			() => {
				emit();
				if (index === 0 && SHOW_MESSAGES_AFTER_FIRST_PUBLISH) {
					scheduleShowMessages();
				}
			},
			PUBLISH_SEQUENCE_FIRST_MS + index * PUBLISH_SEQUENCE_GAP_MS,
		);
		timer.unref?.();
	});
	return true;
}

function sendPullCompletion() {
	if (!PULL_COMPLETION_SIGNAL) return;
	send({
		jsonrpc: "2.0",
		method: "$/test/pullCompleted",
		params: { response: PULL_RESPONSE ?? "default" },
	});
}

// #1714: a single-threaded scanner with a finite intake ceiling, for the
// full-sweep throttle tests.
//
// Opt in with `FAKE_LSP_NOTIFY_BACKLOG_WEDGE=<N>`. Decoded messages then go into
// a work QUEUE that drains one message at a time, and each `didOpen` costs
// `FAKE_LSP_NOTIFY_COST_MS` of real synchronous work — the shape of a scanner
// that re-parses the whole file on every open. Two properties follow, and both
// are the ones the production failure turned on:
//
//   - a caller that opens documents faster than the cost grows the queue, and
//     past N the server's input path dies: it stops reading stdin and answers
//     nothing again, exactly the end state ast-grep reached twice in two
//     `lens_diagnostics mode=full` exposures;
//   - a reply to a REQUEST proves every message queued before it was processed,
//     because one queue is drained in order.
//
// Off by default, so every existing test keeps the incumbent behaviour.
const NOTIFY_BACKLOG_WEDGE = Number(
	process.env.FAKE_LSP_NOTIFY_BACKLOG_WEDGE ?? "",
);
const HAS_BACKLOG_WEDGE =
	Number.isFinite(NOTIFY_BACKLOG_WEDGE) && NOTIFY_BACKLOG_WEDGE > 0;
const NOTIFY_COST_MS = Number(process.env.FAKE_LSP_NOTIFY_COST_MS ?? "200");
const workQueue = [];
let draining = false;
let wedged = false;

function burnCpu(ms) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		/* the scanner is busy; nothing else runs */
	}
}

function drainWorkQueue() {
	if (draining || wedged) return;
	draining = true;
	const step = () => {
		if (wedged || workQueue.length === 0) {
			draining = false;
			return;
		}
		const next = workQueue.shift();
		handle(next);
		setImmediate(step);
	};
	setImmediate(step);
}

process.stdin.on("data", (chunk) => {
	if (wedged) return;
	readBuffer = Buffer.concat([readBuffer, chunk]);
	const { messages, rest } = decodeFrames(readBuffer);
	readBuffer = rest;
	if (!HAS_BACKLOG_WEDGE) {
		for (const m of messages) handle(m);
		return;
	}
	for (const m of messages) {
        // #4528 r3: a separate request task can reply before queued notifications.
        if (process.env.FAKE_LSP_PING_OVERTAKES === "1" &&
            JSON.parse(m).method === "textDocument/documentSymbol") {
            handle(m);
            continue;
        }
		if (workQueue.length >= NOTIFY_BACKLOG_WEDGE) {
			// More work outstanding than this server can hold. It stops reading and
			// never comes back.
			wedged = true;
			process.stdin.pause();
			return;
		}
		workQueue.push(m);
	}
	drainWorkQueue();
});

function send(msg) {
	process.stdout.write(encode(msg));
}

// #4758: the settings a client delivers, read off the wire. With
// FAKE_LSP_TRACE_CONFIG=1 the trace file gets one line each for the
// initializationOptions, a didChangeConfiguration payload, and (when
// FAKE_LSP_PULL_SECTIONS is a JSON array of section names) the client's answer
// to a `workspace/configuration` request the server sends after `initialized`.
const CONFIG_PULL_ID = "fake-config-pull";
function traceConfig(what) {
	if (process.env.FAKE_LSP_TRACE_CONFIG !== "1") return;
	if (!process.env.FAKE_LSP_TRACE_FILE) return;
	try {
		fs.appendFileSync(process.env.FAKE_LSP_TRACE_FILE, `${what}\n`);
	} catch {}
}

function handle(raw) {
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return;
	}
	if (data.id === CONFIG_PULL_ID && data.method === undefined) {
		traceConfig(`config-pull-answer ${JSON.stringify(data.result ?? null)}`);
		return;
	}
	if (data.method === "initialize") {
		traceConfig(
			`init-options ${JSON.stringify(data.params?.initializationOptions ?? null)}`,
		);
	}
	if (data.method === "workspace/didChangeConfiguration") {
		traceConfig(`config-push ${JSON.stringify(data.params?.settings ?? null)}`);
	}
	if (process.env.FAKE_LSP_TRACE_FILE) {
		const trace = (what) => {
			try {
				fs.appendFileSync(process.env.FAKE_LSP_TRACE_FILE, `${what}\n`);
			} catch {}
		};
		trace(
			`recv ${data.method ?? "<response>"} ${data.params?.textDocument?.uri ?? ""}`.trim(),
		);
		// #4493: which bytes each didOpen/didChange carried, as a short sha256,
		// so a test reads what the server holds from the wire. Off by default.
		if (process.env.FAKE_LSP_TRACE_TEXT === "1") {
			const text =
				data.method === "textDocument/didOpen"
					? data.params?.textDocument?.text
					: data.method === "textDocument/didChange"
						? data.params?.contentChanges?.at(-1)?.text
						: undefined;
			if (typeof text === "string")
				trace(
					`text ${data.params?.textDocument?.uri} ${createHash("sha256").update(text).digest("hex").slice(0, 12)}`,
				);
		}
		// #4636: the `languageId` each `didOpen` announced, so a test reads the
		// classifier's answer off the wire instead of from the helper behind it.
		// Off by default: the line would join every existing trace assertion.
		if (
			process.env.FAKE_LSP_TRACE_LANGUAGE_ID === "1" &&
			data.method === "textDocument/didOpen" &&
			typeof data.params?.textDocument?.languageId === "string"
		) {
			trace(
				`language ${data.params.textDocument.uri} ${data.params.textDocument.languageId}`,
			);
		}
		// #4787: the URIs of each didCreateFiles notification, one line per
		// notification, so a test counts batches and orders them against didOpen.
		if (data.method === "workspace/didCreateFiles") {
			trace(
				`created ${(data.params?.files ?? []).map((file) => file.uri).join(" ")}`,
			);
		}
		// #4320 r3: which watched-files changes reached this server.
		if (data.method === "workspace/didChangeWatchedFiles") {
			for (const change of data.params?.changes ?? []) {
				trace(`watched ${change.uri} ${change.type}`);
			}
		}
		if (
			process.env.FAKE_LSP_ECHO_NOTIFY_METHODS === "1" &&
			data.id === undefined
		) {
			trace(`echo-eligible ${data.method}`);
		}
	}

	if (
		process.env.FAKE_LSP_HANG_PROJECT_INFO === "cancel" &&
		data.method === "$/cancelRequest" &&
		hungProjectInfoId !== null &&
		data.params?.id === hungProjectInfoId
	) {
		send({
			jsonrpc: "2.0",
			id: hungProjectInfoId,
			error: { code: -32800, message: "cancelled" },
		});
		hungProjectInfoId = null;
		return;
	}

	// Initialize handshake. FAKE_LSP_IGNORE_INITIALIZE simulates a hung server
	// that never completes the handshake, so createLSPClient's
	// initializeTimeoutMs/withTimeout fires and exercises the initialize-
	// timeout kill + 2s SIGKILL-backstop path (#1114).
	if (data.method === "initialize") {
		if (process.env.FAKE_LSP_IGNORE_INITIALIZE === "1") return;
		if (CONFIG_FILE !== "" && typeof data.params?.rootUri === "string") {
			configRoot = fileURLToPath(data.params.rootUri);
			readServerConfig();
		}
		if (CLOSED_FILE_CACHE && typeof data.params?.rootUri === "string") {
			checkerRoot = fileURLToPath(data.params.rootUri);
			walkAmbient(checkerRoot);
		}
		const clientCapabilities = data.params?.capabilities;
		const clientCodeAction = clientCapabilities?.textDocument?.codeAction;
		const clientSupportsCodeActionResolve =
			clientCodeAction?.dataSupport === true &&
			Array.isArray(clientCodeAction?.resolveSupport?.properties) &&
			clientCodeAction.resolveSupport.properties.includes("edit");
		const clientSupportsWillRename =
			clientCapabilities?.workspace?.fileOperations?.willRename === true;
		const clientSupportsDidRename =
			clientCapabilities?.workspace?.fileOperations?.didRename === true;
		const clientSupportsDidCreate =
			clientCapabilities?.workspace?.fileOperations?.didCreate === true;
		const renameFilter = (globEnv, globDefault) => ({
			scheme: "file",
			pattern: {
				glob: process.env[globEnv] ?? globDefault,
			},
		});
		const renameFilters = (operation, globEnv, globDefault) => {
			const encoded = process.env[`FAKE_LSP_${operation}_FILTERS`];
			return encoded === undefined
				? [renameFilter(globEnv, globDefault)]
				: JSON.parse(encoded);
		};
		const codeActionProvider =
			process.env.FAKE_LSP_CODE_ACTION_PROVIDER === "false"
				? { resolveProvider: false }
				: process.env.FAKE_LSP_CODE_ACTION_PROVIDER === "malformed"
					? { resolveProvider: "yes" }
					: process.env.FAKE_LSP_NO_CODE_ACTION_RESOLVE === "1" ||
						  !clientSupportsCodeActionResolve
						? {}
						: { resolveProvider: true };
		// #4787: merged into the rename operations below, so a case that sets
		// FAKE_LSP_DID_CREATE and FAKE_LSP_WILL_RENAME keeps both.
		const didCreateFileOperations =
			process.env.FAKE_LSP_DID_CREATE === "true" && clientSupportsDidCreate
				? {
						didCreate: {
							filters: renameFilters(
								"DID_CREATE",
								"FAKE_LSP_DID_CREATE_GLOB",
								"**/*",
							),
						},
					}
				: undefined;
		const renameFileOperations =
			process.env.FAKE_LSP_WILL_RENAME === "true"
				? {
						willRename: clientSupportsWillRename
							? {
									filters: renameFilters(
										"WILL_RENAME",
										"FAKE_LSP_WILL_RENAME_GLOB",
										"**/*",
									),
								}
							: undefined,
						...(process.env.FAKE_LSP_DID_RENAME === "true" &&
						clientSupportsDidRename
							? {
									didRename: {
										filters: renameFilters(
											"DID_RENAME",
											"FAKE_LSP_DID_RENAME_GLOB",
											"**/*",
										),
									},
								  }
							: {}),
				  }
				: process.env.FAKE_LSP_WILL_RENAME === "false"
					? { willRename: false }
					: process.env.FAKE_LSP_WILL_RENAME === "empty-object"
						? { willRename: {} }
						: process.env.FAKE_LSP_WILL_RENAME === "malformed"
							? { willRename: "yes" }
							: undefined;
		const workspaceFileOperations =
			didCreateFileOperations || renameFileOperations
				? { ...didCreateFileOperations, ...renameFileOperations }
				: undefined;
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: {
				capabilities: {
					textDocumentSync: {
						openClose: true,
						// #1669 review F5: only advertise a non-default sync kind when
						// asked, so the bulk of the integration tests stay on Full — the
						// default this fixture has always advertised.
						change: process.env.FAKE_LSP_SYNC_KIND
							? Number(process.env.FAKE_LSP_SYNC_KIND)
							: 1,
						// #3405: `save` is ABSENT by default, the shape this fixture has
						// always advertised — upstream's rule is "If omitted the
						// notification should not be sent", so the default fixture must
						// receive no `textDocument/didSave`. `FAKE_LSP_SAVE=true` declares
						// the bare boolean (Expert's shape), `=includeText` declares
						// `{ includeText: true }`, `=false` declares an explicit refusal.
						...(process.env.FAKE_LSP_SAVE === "true"
							? { save: true }
							: process.env.FAKE_LSP_SAVE === "includeText"
								? { save: { includeText: true } }
								: process.env.FAKE_LSP_SAVE === "emptyObject"
									? { save: {} }
									: process.env.FAKE_LSP_SAVE === "false"
										? { save: false }
										: {}),
					},
					// #269: only advertise a non-default position encoding when asked,
					// so the bulk of the integration tests stay on the UTF-16 default.
					...(process.env.FAKE_LSP_POSITION_ENCODING
						? { positionEncoding: process.env.FAKE_LSP_POSITION_ENCODING }
						: {}),
					// #1969: capability knobs, so a test can build a server that
					// advertises no symbol provider — the ast-grep shape, where
					// the old ungated `workspace/symbol` liveness probe wrote an
					// unimplemented-method error into the server on every ping.
					// Default stays "advertise everything", as it always was.
					...(process.env.FAKE_LSP_NO_HOVER === "1"
						? {}
						: { hoverProvider: true }),
					definitionProvider: true,
					referencesProvider: true,
					...(process.env.FAKE_LSP_NO_DOCUMENT_SYMBOL === "1"
						? {}
						: { documentSymbolProvider: true }),
					...(process.env.FAKE_LSP_NO_WORKSPACE_SYMBOL === "1"
						? {}
						: { workspaceSymbolProvider: true }),
					codeActionProvider,
					...(workspaceFileOperations
						? { workspace: { fileOperations: workspaceFileOperations } }
						: {}),
					executeCommandProvider: {
						commands: [
							"fake.doThing",
							"fake.applyEdit",
							"fake.applyEditDeferred",
							"fake.releaseDeferredApplyEdit",
							// #4801: the tsserver escape hatch, whose `projectInfo` request
							// the server accepts and never answers. "1" ignores a cancel for
							// it; "cancel" answers the cancel with RequestCancelled. Off by
							// default so the advertised list the other suites pin does not
							// move.
							...(HANG_PROJECT_INFO ? ["typescript.tsserverRequest"] : []),
						],
					},
					// #3310: `FAKE_LSP_NO_DIAGNOSTIC_PROVIDER=1` advertises NO pull
					// provider, the measured shape of the push-only servers whose
					// wait policy this fixture stands in for (intelephense 1.18.5
					// answers `initialize` with no `diagnosticProvider` at all). Without
					// it every fixture session is Tier 1 pull-authoritative and the
					// push wait is never exercised. Default unchanged.
					...(process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER === "1"
						? {}
						: {
								diagnosticProvider: {
									interFileDependencies: false,
									workspaceDiagnostics:
										process.env.FAKE_LSP_WORKSPACE_DIAGNOSTICS === "1",
								},
							}),
				},
			},
		});
		return;
	}

	if (
		process.env.FAKE_LSP_ECHO_REQUEST_METHODS === "1" &&
		data.id !== undefined
	) {
		send({
			jsonrpc: "2.0",
			method: "$/test/requestReceived",
			params: { method: data.method },
		});
	}

	// #1971: notification twin of the request echo above, so tests can assert
	// WHETHER a notification (e.g. workspace/didRenameFiles) was sent at all.
	if (
		process.env.FAKE_LSP_ECHO_NOTIFY_METHODS === "1" &&
		data.id === undefined &&
		typeof data.method === "string"
	) {
		send({
			jsonrpc: "2.0",
			method: "$/test/notifyReceived",
			params: { method: data.method },
		});
	}

	// Ignore notifications without id
	if (data.method === "initialized") {
		if (process.env.FAKE_LSP_PULL_SECTIONS) {
			send({
				jsonrpc: "2.0",
				id: CONFIG_PULL_ID,
				method: "workspace/configuration",
				params: {
					items: JSON.parse(process.env.FAKE_LSP_PULL_SECTIONS).map(
						(section) => ({ section }),
					),
				},
			});
		}
		if (SHOW_MESSAGES.length > 0 && !SHOW_MESSAGES_AFTER_FIRST_PUBLISH) {
			scheduleShowMessages();
		}
		// #1969: die mid-session with a chosen exit code and NOTHING on stderr —
		// the exact ast-grep shape (code=1, empty stderr) whose cause used to
		// leave no record. Silent by construction: this path writes no stderr.
		if (process.env.FAKE_LSP_SELF_EXIT_CODE) {
			const code = Number(process.env.FAKE_LSP_SELF_EXIT_CODE);
			const delayMs = Number(process.env.FAKE_LSP_SELF_EXIT_DELAY_MS ?? "50");
			setTimeout(() => process.exit(code), delayMs);
			return;
		}
		// #1620 residual: a live-process fixture for "stdin stops draining"
		// (distinct from FAKE_LSP_NOTIFY_BACKLOG_WEDGE's queue-depth trigger,
		// which still reads N messages first). Pausing right after the
		// handshake means every byte the client writes afterward — the padding
		// notifications AND clientShutdown's own "shutdown"/"exit" writes —
		// sits unread in the OS pipe buffer. A single small write still
		// resolves once the OS accepts it into that buffer; only once enough
		// bytes are queued does a write's own callback stop firing. The test
		// pads with a few MB of unread traffic first to exhaust that buffer
		// before exercising clientShutdown.
		//
		// `pause()` alone is not enough: with no other active handle, Node
		// decides the event loop is empty and exits the process right here —
		// a probe caught this exiting with code 0 within milliseconds, which
		// then makes every subsequent write fail FAST with EPIPE/EOF instead
		// of genuinely hanging (a fast rejection, not the unbounded-await
		// bug). Keep a harmless interval alive so the process (and its stdin
		// pipe) stays open and unread indefinitely, like a real wedged
		// server whose main loop is busy elsewhere.
		//
		// #2358: two stop-reading-but-alive liveness profiles for the
		// notify-stall breaker's CPU discriminator. `FAKE_LSP_BURN_CPU_AFTER_INIT`
		// makes the "dead but spinning" server real — one core busy-looping
		// forever while nothing drains (the breaker must NOT kill it); without
		// it the server is idle and flat (the breaker must kill it). Whether the
		// fixture's burns are visible depends on the discriminator sampling
		// this same process's cumulative CPU, which both Windows and POSIX
		// do via kernel counters.
		//
		// `FAKE_LSP_BURN_CPU_MS=<n>` is the THIRD profile and the one #2358's
		// production evidence actually had: the scanner burns a core for a
		// bounded stretch (draining the burst it was handed) and THEN wedges,
		// flat and silent. Its CPU history therefore carries a burn the process
		// is no longer doing — which is exactly what a liveness verdict must not
		// mistake for progress.
		if (process.env.FAKE_LSP_WEDGE_STDIN_AFTER_INIT === "1") {
			process.stdin.pause();
			const boundedBurnMs = Number(process.env.FAKE_LSP_BURN_CPU_MS ?? "");
			if (process.env.FAKE_LSP_BURN_CPU_AFTER_INIT === "1") {
				const burnHandle = setInterval(() => burnCpu(100), 100);
				process.on("exit", () => clearInterval(burnHandle));
			} else if (Number.isFinite(boundedBurnMs) && boundedBurnMs > 0) {
				const burnUntil = Date.now() + boundedBurnMs;
				const burnHandle = setInterval(() => {
					if (Date.now() >= burnUntil) {
						clearInterval(burnHandle);
						return;
					}
					burnCpu(90);
				}, 100);
				process.on("exit", () => clearInterval(burnHandle));
				// Outlives the burn, so the process stays alive and flat after it.
				setInterval(() => {}, 60_000);
			} else {
				setInterval(() => {}, 60_000);
			}
		}
		return;
	}
	if (data.method === "textDocument/didOpen") {
		if (process.env.FAKE_LSP_DID_CREATE_REQUIRED === "1") {
			const uri = data.params?.textDocument?.uri;
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {
					uri,
					diagnostics: didCreateUris.has(uri)
						? [{
								severity: 1,
								code: "P4787",
								message: "finding after didCreate",
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							}]
						: [],
				},
			});
		}
		openDocuments.set(
			data.params?.textDocument?.uri,
			data.params?.textDocument?.text ?? "",
		);
		publishSequenceFor(data.params?.textDocument?.uri);
		if (RECOMPILE_CLEARS_MS >= 0) {
			recompileVersions.set(
				data.params?.textDocument?.uri,
				data.params?.textDocument?.version,
			);
			recompileCompile(
				data.params?.textDocument?.uri,
				data.params?.textDocument?.text ?? "",
				RECOMPILE_CLEARS_MS,
			);
		}
		if (STALE_MODULE_LOOKUP) publishModuleLookups(data.params?.textDocument?.uri);
		if (CLOSED_FILE_CACHE)
			checkEveryOpenDocument(data.params?.textDocument?.uri);
		if (process.env.FAKE_LSP_PUSH_DIAGNOSTIC === "1") {
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {
					uri: data.params?.textDocument?.uri,
					diagnostics: [{
						severity: 1,
						source: "fake-push",
						code: "P2780",
						message: "diagnostic from pushed custom server",
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					}],
				},
			});
		}
		// Gated on the wedge profile so every existing test keeps the incumbent
		// silent-on-open behaviour it was written against.
		if (HAS_BACKLOG_WEDGE) {
			burnCpu(NOTIFY_COST_MS);
			// Push-model scanner: report clean for the content just received, so a
			// throttled sweep can tell "answered, nothing found" from "never
			// answered".
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {
					uri: data.params?.textDocument?.uri,
					version: data.params?.textDocument?.version,
					diagnostics: [],
				},
			});
		}
		return;
	}
	if (data.method === "textDocument/didChange") {
		const text = data.params?.contentChanges?.at(-1)?.text;
		// #4528 r1 F1: a server that dies on reading one change (after the
		// trace line), so a request queued behind it can never be answered.
		const exitMarker = process.env.FAKE_LSP_EXIT_ON_CHANGE_TEXT;
		if (exitMarker && typeof text === "string" && text.includes(exitMarker))
			process.exit(0);
		if (typeof text === "string") {
			openDocuments.set(data.params?.textDocument?.uri, text);
		}
		// #4782: a dependency whose change takes the checker long to analyze.
		// The work runs BEFORE the republish below, so the dependents' previous
		// answers (checked against the old bytes) are the latest the client
		// holds until this change's answers arrive, right before the reply to
		// any request queued behind it.
		const slowMarker = process.env.FAKE_LSP_SLOW_CHANGE_TEXT;
		if (slowMarker && typeof text === "string" && text.includes(slowMarker))
			burnCpu(Number(process.env.FAKE_LSP_SLOW_CHANGE_MS ?? "400"));
		publishSequenceFor(data.params?.textDocument?.uri);
		if (RECOMPILE_CLEARS_MS >= 0 && typeof text === "string") {
			recompileVersions.set(
				data.params?.textDocument?.uri,
				data.params?.textDocument?.version,
			);
			recompileCompile(data.params?.textDocument?.uri, text, 0);
		}
		if (STALE_MODULE_LOOKUP) publishModuleLookups(data.params?.textDocument?.uri);
		if (CLOSED_FILE_CACHE)
			checkEveryOpenDocument(data.params?.textDocument?.uri);
		// #4493 r2: a scanner that re-parses on every change (ast-grep's live
		// shape). Synchronous, so a request queued behind the changes is answered
		// only after all of them: what the #1714 aux pacing barrier waits on.
		const changeCostMs = Number(process.env.FAKE_LSP_CHANGE_COST_MS ?? "");
		if (Number.isFinite(changeCostMs) && changeCostMs > 0) burnCpu(changeCostMs);
		// #1669 review F5: echo the received contentChanges back so a real-init
		// integration test can assert the ON-THE-WIRE shape (ranged vs
		// whole-document) that the client actually sent, proving
		// `negotiateSyncKind` at the real `createLSPClient` init call site
		// drove `buildContentChanges` end to end. Off by default.
		if (process.env.FAKE_LSP_ECHO_DID_CHANGE) {
			send({
				jsonrpc: "2.0",
				method: "$/test/didChangeReceived",
				params: { contentChanges: data.params?.contentChanges ?? [] },
			});
		}
		return;
	}
	// #3405: twin of the didChange echo above — a real-init integration test
	// asserts WHETHER a didSave arrived and whether it carried `text`, so the
	// capability gate is proved over the wire and not only in the negotiation
	// unit. Off by default.
	if (data.method === "textDocument/didSave") {
		// #3405: a save-triggered server's WHOLE diagnose pass runs here and
		// nowhere else (Expert recompiles the Mix project on didSave and on
		// nothing else). `FAKE_LSP_PUBLISH_ON_SAVE=1` reproduces that shape: the
		// fixture publishes a diagnostic only from this branch, so a real-init
		// test reads the production consequence — the diagnostics a save-only
		// server answers are reachable through pi-lens exactly when the save is.
		if (process.env.FAKE_LSP_PUBLISH_ON_SAVE === "1") {
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {
					uri: data.params?.textDocument?.uri,
					diagnostics: [
						{
							severity: 1,
							source: "fake-save",
							code: "P3405",
							message: "diagnostic published only after didSave",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
						},
					],
				},
			});
		}
		if (process.env.FAKE_LSP_ECHO_DID_SAVE) {
			send({
				jsonrpc: "2.0",
				method: "$/test/didSaveReceived",
				params: {
					uri: data.params?.textDocument?.uri,
					hasText: typeof data.params?.text === "string",
				},
			});
		}
		return;
	}
	if (data.method === "workspace/didChangeConfiguration") return;
	if (data.method === "workspace/didChangeWatchedFiles") {
		// #271 smoke: echo each received batch back so an integration test can
		// assert the client coalesced N file opens into ONE wire frame. Off by
		// default (the bulk of tests neither send nor care about watched-files).
		if (STALE_MODULE_LOOKUP) {
			let created = false;
			for (const change of data.params?.changes ?? []) {
				if (
					CONFIG_FILE !== "" &&
					path.basename(fileURLToPath(change.uri)) === CONFIG_FILE
				) {
					readServerConfig();
					failedModuleLookups.clear();
					created = true;
				}
				if (change.type !== 1) continue;
				created = failedModuleLookups.delete(fileURLToPath(change.uri)) || created;
			}
			if (created) for (const uri of openDocuments.keys()) publishModuleLookups(uri);
		}
		if (CLOSED_FILE_CACHE) {
			for (const change of data.params?.changes ?? []) {
				const changed = fileURLToPath(change.uri);
				closedViews.delete(changed);
				if (
					!changed.endsWith(".d.ts") ||
					changed.includes(`${path.sep}node_modules${path.sep}`)
				)
					continue;
				if (change.type === 3) ambientFiles.delete(changed);
				else ambientFiles.add(changed);
			}
			checkEveryOpenDocument();
		}
		if (RECOMPILE_CLEARS_MS >= 0 && !RECOMPILE_NO_WATCHED_CLEAR) {
			for (const change of data.params?.changes ?? [])
				if (openDocuments.has(change.uri)) recompilePublish(change.uri, []);
		}
		if (process.env.FAKE_LSP_ECHO_WATCHED_FILES) {
			send({
				jsonrpc: "2.0",
				method: "$/test/watchedFilesReceived",
				params: { changes: data.params?.changes ?? [] },
			});
		}
		return;
	}
	if (data.method === "workspace/didCreateFiles") {
		for (const file of data.params?.files ?? []) didCreateUris.add(file.uri);
		return;
	}
	if (data.method === "textDocument/publishDiagnostics") return;
	if (data.method === "exit") {
		process.exit(0);
	}

	// Document symbol
	if (data.method === "textDocument/documentSymbol") {
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: [
				{
					name: "greet",
					kind: 12, // Function
					range: {
						start: { line: 0, character: 0 },
						end: { line: 4, character: 1 },
					},
					selectionRange: {
						start: { line: 0, character: 9 },
						end: { line: 0, character: 14 },
					},
					children: [
						{
							name: "message",
							kind: 13, // Variable
							range: {
								start: { line: 1, character: 2 },
								end: { line: 1, character: 30 },
							},
							selectionRange: {
								start: { line: 1, character: 6 },
								end: { line: 1, character: 13 },
							},
						},
					],
				},
				{
					name: "Person",
					kind: 5, // Class
					range: {
						start: { line: 6, character: 0 },
						end: { line: 10, character: 1 },
					},
					selectionRange: {
						start: { line: 6, character: 6 },
						end: { line: 6, character: 12 },
					},
				},
			],
		});
		return;
	}

	// Hover
	if (data.method === "textDocument/hover") {
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: {
				contents: { kind: "markdown", value: "**string** — greeting message" },
				range: {
					start: { line: 1, character: 6 },
					end: { line: 1, character: 13 },
				},
			},
		});
		return;
	}

	// Definition. Echo the received position into the result range so a test can
	// assert the exact on-the-wire offset the client sent (#269 encoding check).
	// FAKE_LSP_DEFINITION_DELAY_MS delays the reply so a test can bump the
	// document version mid-request and exercise the stale-drop path (#276).
	if (data.method === "textDocument/definition") {
		const ln = data.params?.position?.line ?? 1;
		const ch = data.params?.position?.character ?? 6;
		const reply = () =>
			send({
				jsonrpc: "2.0",
				id: data.id,
				result: {
					uri: data.params?.textDocument?.uri ?? "file:///test.ts",
					range: {
						start: { line: ln, character: ch },
						end: { line: ln, character: ch + 1 },
					},
				},
			});
		const delay = Number.parseInt(
			process.env.FAKE_LSP_DEFINITION_DELAY_MS ?? "0",
			10,
		);
		if (delay > 0) setTimeout(reply, delay);
		else reply();
		return;
	}

	// References
	if (data.method === "textDocument/references") {
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: [
				{
					uri: data.params?.textDocument?.uri ?? "file:///test.ts",
					range: {
						start: { line: 1, character: 6 },
						end: { line: 1, character: 13 },
					},
				},
				{
					uri: data.params?.textDocument?.uri ?? "file:///test.ts",
					range: {
						start: { line: 3, character: 10 },
						end: { line: 3, character: 17 },
					},
				},
			],
		});
		return;
	}

	// Pull diagnostics
	if (data.method === "textDocument/diagnostic") {
		if (process.env.FAKE_LSP_IGNORE_PULL === "1") return;
		const text = openDocuments.get(data.params?.textDocument?.uri) ?? "";
		const uri = data.params?.textDocument?.uri;
		const sendPullResponse = () => {
			if (PULL_RESPONSE === "timeout") return;
			if (PULL_RESPONSE === "-32601") {
				send({
					jsonrpc: "2.0",
					id: data.id,
					error: { code: -32601, message: "method not found" },
				});
				return;
			}
			const items = CLOSED_FILE_CACHE
				? checkerDiagnostics(uri)
				: PULL_RESPONSE === "empty" ||
				(text.includes("fake-lsp-clean") && PULL_RESPONSE !== "items")
					? []
					: [
							{
								severity: 1,
								code: "FAKE1001",
								source: PULL_DIAGNOSTIC_SOURCE,
								message: PULL_DIAGNOSTIC_MESSAGE,
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 5 },
								},
							},
						];
			send({
				jsonrpc: "2.0",
				id: data.id,
				result: { kind: "full", items },
			});
		};
		pullCount += 1;
		if (pullCount > 1 && DELAY_AFTER_FIRST_PULL_MS > 0) {
			setTimeout(sendPullResponse, DELAY_AFTER_FIRST_PULL_MS).unref?.();
			return;
		}
		if (PULL_PUSH_BEFORE_RESPONSE) sendPullPush(uri);
		sendPullResponse();
		if (PULL_PUSH_AFTER_RESPONSE) sendPullPush(uri);
		sendPullCompletion();
		return;
	}

	// Programmable project-wide pull for real-wire workspace sweep tests.
	if (data.method === "workspace/diagnostic") {
		const reply = () => {
			if (process.env.FAKE_LSP_WORKSPACE_DIAGNOSTIC_ERROR === "1") {
				send({
					jsonrpc: "2.0",
					id: data.id,
					error: { code: -32603, message: "fake workspace pull failed" },
				});
				return;
			}
			const uri = process.env.FAKE_LSP_WORKSPACE_DIAGNOSTIC_URI;
			// #4528 r1 F3: the closed-file-cache profile answers a project-wide
			// pull from the views it holds, one full report per open document.
			const items = CLOSED_FILE_CACHE
				? [...openDocuments.keys()].map((open) => ({
						uri: open,
						kind: "full",
						items: checkerDiagnostics(open),
					}))
				: uri
					? [{ uri, kind: "full", items: [] }]
					: [];
			send({ jsonrpc: "2.0", id: data.id, result: { items } });
		};
		const delay = Number.parseInt(
			process.env.FAKE_LSP_WORKSPACE_DIAGNOSTIC_DELAY_MS ?? "0",
			10,
		);
		if (delay > 0) setTimeout(reply, delay);
		else reply();
		return;
	}

	if (data.method === "workspace/willRenameFiles") {
		send({ jsonrpc: "2.0", id: data.id, result: null });
		return;
	}

	// Code actions return lightweight actions; resolve populates the edit.
	if (data.method === "textDocument/codeAction") {
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: [
				{
					title: "Replace greeting",
					kind: "quickfix",
					data: { uri: data.params?.textDocument?.uri ?? "file:///test.ts" },
				},
			],
		});
		return;
	}

	if (data.method === "codeAction/resolve") {
		const uri = data.params?.data?.uri ?? "file:///test.ts";
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: {
				...data.params,
				edit: {
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 5 },
								},
								newText: "hello",
							},
						],
					},
				},
			},
		});
		return;
	}

	// Workspace symbol
	if (data.method === "workspace/symbol") {
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: [
				{
					name: "greet",
					kind: 12,
					location: {
						uri: "file:///test.ts",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
					},
				},
				{
					name: "Person",
					kind: 5,
					location: {
						uri: "file:///test.ts",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
					},
				},
				{
					name: "config",
					kind: 13,
					location: {
						uri: "file:///test.ts",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
					},
				},
				{
					name: "stringLiteral",
					kind: 15,
					location: {
						uri: "file:///test.ts",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
					},
				},
			],
		});
		return;
	}

	// Execute command. "fake.applyEdit" exercises the server-initiated edit path:
	// it sends a workspace/applyEdit request and only returns the executeCommand
	// result once the client has responded (so tests are race-free).
	if (data.method === "workspace/executeCommand") {
		const cmd = data.params?.command;
		// #4801: accepted, never answered; a `$/cancelRequest` for it is
		// ignored, like a wedged server. The trace file shows the cancel.
		if (
			HANG_PROJECT_INFO &&
			cmd === "typescript.tsserverRequest" &&
			data.params?.arguments?.[0] === "projectInfo"
		) {
			hungProjectInfoId = data.id;
			return;
		}
		if (cmd === "fake.applyEdit" || cmd === "fake.applyEditDeferred") {
			const spec = buildApplyEditSpec(data.params?.arguments);
			pendingExec = { execId: data.id, command: cmd };
			// #2479: hold the edit until released, so the client-side
			// executeCommand window stays open across an unrelated nested call.
			if (cmd === "fake.applyEditDeferred") {
				deferredApplyEdit = spec;
				return;
			}
			sendApplyEdit(spec);
			return;
		}
		if (cmd === "fake.releaseDeferredApplyEdit") {
			// Answered immediately; the held edit then rides the STILL-OPEN
			// window of whichever call armed it (#2479).
			send({
				jsonrpc: "2.0",
				id: data.id,
				result: { ran: cmd, released: deferredApplyEdit !== null },
			});
			if (deferredApplyEdit) {
				const spec = deferredApplyEdit;
				deferredApplyEdit = null;
				sendApplyEdit(spec);
			}
			return;
		}
		send({ jsonrpc: "2.0", id: data.id, result: { ran: cmd } });
		return;
	}

	// Response from the client to our workspace/applyEdit request (no method,
	// id in the applyEdit range). Now release the pending executeCommand result.
	if (
		typeof data.method === "undefined" &&
		pendingExec &&
		typeof data.id === "number" &&
		data.id > 9000
	) {
		send({
			jsonrpc: "2.0",
			id: pendingExec.execId,
			result: { ran: pendingExec.command, applied: data.result?.applied === true },
		});
		pendingExec = null;
		return;
	}

	// Shutdown
	if (data.method === "shutdown") {
		if (process.env.FAKE_LSP_IGNORE_SHUTDOWN === "1") return;
		send({ jsonrpc: "2.0", id: data.id, result: null });
		return;
	}

	// Default: respond null to keep transport flowing
	if (typeof data.id !== "undefined") {
		send({ jsonrpc: "2.0", id: data.id, result: null });
	}
}
