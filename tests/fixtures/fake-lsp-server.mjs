// Minimal JSON-RPC 2.0 LSP fake server over stdio
// Used for integration tests — speaks real LSP protocol without actual language smarts

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
const openDocuments = new Map();

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

function handle(raw) {
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return;
	}
	if (process.env.FAKE_LSP_TRACE_FILE) {
		const trace = (what) => {
			import("node:fs")
				.then((fs) =>
					fs.appendFileSync(
						process.env.FAKE_LSP_TRACE_FILE,
						`${what}\n`,
					),
				)
				.catch(() => {});
		};
		trace(`recv ${data.method ?? "<response>"}`);
		if (
			process.env.FAKE_LSP_ECHO_NOTIFY_METHODS === "1" &&
			data.id === undefined
		) {
			trace(`echo-eligible ${data.method}`);
		}
	}

	// Initialize handshake. FAKE_LSP_IGNORE_INITIALIZE simulates a hung server
	// that never completes the handshake, so createLSPClient's
	// initializeTimeoutMs/withTimeout fires and exercises the initialize-
	// timeout kill + 2s SIGKILL-backstop path (#1114).
	if (data.method === "initialize") {
		if (process.env.FAKE_LSP_IGNORE_INITIALIZE === "1") return;
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
		const workspaceFileOperations =
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
						commands: ["fake.doThing", "fake.applyEdit"],
					},
					diagnosticProvider: {
						interFileDependencies: false,
						workspaceDiagnostics:
							process.env.FAKE_LSP_WORKSPACE_DIAGNOSTICS === "1",
					},
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
		if (process.env.FAKE_LSP_WEDGE_STDIN_AFTER_INIT === "1") {
			process.stdin.pause();
			if (process.env.FAKE_LSP_BURN_CPU_AFTER_INIT === "1") {
				const burnHandle = setInterval(() => burnCpu(100), 100);
				process.on("exit", () => clearInterval(burnHandle));
			} else {
				setInterval(() => {}, 60_000);
			}
		}
		return;
	}
	if (data.method === "textDocument/didOpen") {
		openDocuments.set(
			data.params?.textDocument?.uri,
			data.params?.textDocument?.text ?? "",
		);
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
		if (typeof text === "string") {
			openDocuments.set(data.params?.textDocument?.uri, text);
		}
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
	if (data.method === "workspace/didChangeConfiguration") return;
	if (data.method === "workspace/didChangeWatchedFiles") {
		// #271 smoke: echo each received batch back so an integration test can
		// assert the client coalesced N file opens into ONE wire frame. Off by
		// default (the bulk of tests neither send nor care about watched-files).
		if (process.env.FAKE_LSP_ECHO_WATCHED_FILES) {
			send({
				jsonrpc: "2.0",
				method: "$/test/watchedFilesReceived",
				params: { changes: data.params?.changes ?? [] },
			});
		}
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
		const text = openDocuments.get(data.params?.textDocument?.uri) ?? "";
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: {
				kind: "full",
				items: text.includes("fake-lsp-clean")
					? []
					: [
					{
						severity: 1,
						code: "FAKE1001",
						source: "fake-lsp",
						message:
							"actual diagnostic\nfor further information visit https://example.test\nhttps://example.test/docs",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 5 },
						},
					},
					],
			},
		});
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
			send({
				jsonrpc: "2.0",
				id: data.id,
				result: {
					items: uri ? [{ uri, kind: "full", items: [] }] : [],
				},
			});
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
		if (cmd === "fake.applyEdit") {
			const uri = data.params?.arguments?.[0];
			const applyId = ++applyEditIdCounter;
			pendingExec = { execId: data.id, command: cmd };
			send({
				jsonrpc: "2.0",
				id: applyId,
				method: "workspace/applyEdit",
				params: {
					edit: {
						changes: {
							[uri]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 5 },
									},
									newText: "EDITED",
								},
							],
						},
					},
				},
			});
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
