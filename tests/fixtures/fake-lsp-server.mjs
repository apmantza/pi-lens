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

process.stdin.on("data", (chunk) => {
	readBuffer = Buffer.concat([readBuffer, chunk]);
	const { messages, rest } = decodeFrames(readBuffer);
	readBuffer = rest;
	for (const m of messages) handle(m);
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

	// Initialize handshake
	if (data.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: {
				capabilities: {
					textDocumentSync: { openClose: true, change: 1 },
					hoverProvider: true,
					definitionProvider: true,
					referencesProvider: true,
					documentSymbolProvider: true,
					workspaceSymbolProvider: true,
					diagnosticProvider: {
						interFileDependencies: false,
						workspaceDiagnostics: false,
					},
				},
			},
		});
		return;
	}

	// Ignore notifications without id
	if (data.method === "initialized") return;
	if (data.method === "textDocument/didOpen") return;
	if (data.method === "textDocument/didChange") return;
	if (data.method === "workspace/didChangeConfiguration") return;
	if (data.method === "workspace/didChangeWatchedFiles") return;
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

	// Definition
	if (data.method === "textDocument/definition") {
		send({
			jsonrpc: "2.0",
			id: data.id,
			result: {
				uri: data.params?.textDocument?.uri ?? "file:///test.ts",
				range: {
					start: { line: 1, character: 6 },
					end: { line: 1, character: 13 },
				},
			},
		});
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

	// Shutdown
	if (data.method === "shutdown") {
		send({ jsonrpc: "2.0", id: data.id, result: null });
		return;
	}

	// Default: respond null to keep transport flowing
	if (typeof data.id !== "undefined") {
		send({ jsonrpc: "2.0", id: data.id, result: null });
	}
}
