#!/usr/bin/env node
/**
 * Raw-LSP measurement for Expert's Mix-project readiness ordering (#3405).
 *
 * This intentionally has no pi-lens imports. Each variant gets a fresh Expert
 * process and a fresh tiny Mix project so a result cannot be inherited from the
 * other ordering.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIMIT_MS = 120_000;
const RETRY_MS = 2_000;
const INIT_TIMEOUT_MS = 30_000;
const scriptRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

function argValue(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

const command = argValue("--command", "expert");
const output = path.resolve(
	argValue(
		"--output",
		path.join(scriptRoot, ".probe-home", "expert-readiness-probe.log"),
	),
);
fs.mkdirSync(path.dirname(output), { recursive: true });
const logStream = fs.createWriteStream(output, { flags: "w" });

function log(event, fields = {}) {
	const line = JSON.stringify({
		timestamp: new Date().toISOString(),
		event,
		...fields,
	});
	logStream.write(`${line}\n`);
	console.log(line);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProject() {
	const project = fs.mkdtempSync(
		path.join(process.cwd(), ".probe-home", "expert-project-"),
	);
	fs.writeFileSync(
		path.join(project, "mix.exs"),
		`defmodule Smoke.MixProject do\n  use Mix.Project\n\n  def project do\n    [app: :smoke, version: "0.1.0", elixir: "~> 1.14", deps: []]\n  end\nend\n`,
	);
	fs.writeFileSync(
		path.join(project, "bad.ex"),
		`defmodule Smoke do\n  def greet do\n    undefined_function()\n  end\nend\n`,
	);
	return project;
}

function frame(message) {
	const body = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

async function runVariant(name, retrySaves) {
	const project = createProject();
	const file = path.join(project, "bad.ex");
	const uri = pathToFileURL(file).href;
	const rootUri = pathToFileURL(project).href;
	const startedAt = process.hrtime.bigint();
	let firstDiagnosticsMs = null;
	let nextId = 1;
	let buffer = Buffer.alloc(0);
	let retryTimer;
	let child;
	let handleMessage = () => {};

	const elapsed = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

	const send = (method, params, id) => {
		const message =
			id === undefined
				? { jsonrpc: "2.0", method, params }
				: { jsonrpc: "2.0", id, method, params };
		log("outgoing", {
			variant: name,
			elapsedMs: Math.round(elapsed()),
			message,
		});
		if (!child.stdin.destroyed) child.stdin.write(frame(message));
	};

	const diagnostics = new Promise((resolve) => {
		const mark = (message) => {
			if (message.method !== "textDocument/publishDiagnostics") return;
			if (message.params?.uri !== uri || firstDiagnosticsMs !== null) return;
			firstDiagnosticsMs = elapsed();
			log("first_diagnostics", {
				variant: name,
				elapsedMs: Math.round(firstDiagnosticsMs),
				count: message.params?.diagnostics?.length ?? 0,
			});
			resolve();
		};
		handleMessage = mark;
	});

	log("variant_start", { variant: name, retrySaves, project, file });
	child = spawn(command, ["--stdio"], {
		cwd: project,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	});
	child.on("error", (error) =>
		log("process_error", { variant: name, error: error.message }),
	);
	child.stdin.on("error", (error) =>
		log("stdin_error", { variant: name, error: error.message }),
	);
	child.stderr.on("data", (chunk) =>
		log("stderr", { variant: name, text: chunk.toString() }),
	);
	child.stdout.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const separator = buffer.indexOf("\r\n\r\n");
			if (separator < 0) break;
			const header = buffer.subarray(0, separator).toString("ascii");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				log("malformed_header", { variant: name, header });
				buffer = buffer.subarray(separator + 4);
				continue;
			}
			const length = Number(match[1]);
			const bodyStart = separator + 4;
			if (buffer.length < bodyStart + length) break;
			const body = buffer
				.subarray(bodyStart, bodyStart + length)
				.toString("utf8");
			buffer = buffer.subarray(bodyStart + length);
			try {
				const message = JSON.parse(body);
				log("incoming", {
					variant: name,
					elapsedMs: Math.round(elapsed()),
					message,
				});
				handleMessage(message);
			} catch (error) {
				log("malformed_message", { variant: name, body, error: error.message });
			}
		}
	});

	const initializeId = nextId++;
	send(
		"initialize",
		{
			processId: process.pid,
			clientInfo: { name: "pi-lens-expert-readiness-probe", version: "1" },
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: path.basename(project) }],
			capabilities: {
				window: { workDoneProgress: false },
				workspace: { workspaceFolders: true },
				textDocument: {
					synchronization: {
						dynamicRegistration: false,
						willSave: false,
						didSave: true,
						willSaveWaitUntil: false,
					},
				},
			},
			trace: "off",
		},
		initializeId,
	);

	await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("initialize response timeout")),
			INIT_TIMEOUT_MS,
		);
		const originalHandleMessage = handleMessage;
		handleMessage = (message) => {
			if (message.id === initializeId) {
				clearTimeout(timer);
				resolve();
			}
			originalHandleMessage(message);
		};
	}).catch((error) => {
		log("initialize_error", { variant: name, error: error.message });
		throw error;
	});

	send("initialized", {});
	const text = fs.readFileSync(file, "utf8");
	send("textDocument/didOpen", {
		textDocument: { uri, languageId: "elixir", version: 1, text },
	});
	send("textDocument/didChange", {
		textDocument: { uri, version: 2 },
		contentChanges: [{ text }],
	});

	const save = () => send("textDocument/didSave", { textDocument: { uri } });
	save();
	if (retrySaves) retryTimer = setInterval(save, RETRY_MS);

	const result = await Promise.race([
		diagnostics.then(() => ({ firstDiagnosticsMs })),
		sleep(LIMIT_MS).then(() => ({ firstDiagnosticsMs: null })),
	]);

	clearInterval(retryTimer);
	log("variant_end", {
		variant: name,
		firstDiagnosticsMs:
			result.firstDiagnosticsMs === null
				? null
				: Math.round(result.firstDiagnosticsMs),
	});
	child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolve) => child.once("close", resolve)),
		sleep(2_000),
	]);
	if (child.exitCode === null && child.signalCode === null)
		child.kill("SIGKILL");
	return result.firstDiagnosticsMs;
}

try {
	const immediateMs = await runVariant("immediate-save", false);
	const retryMs = await runVariant("retry-save", true);
	log("summary", {
		immediateSaveMs: immediateMs === null ? null : Math.round(immediateMs),
		retrySaveMs: retryMs === null ? null : Math.round(retryMs),
		verdict:
			retryMs === null
				? "inconclusive"
				: "hypothesis-confirmed-if-immediate-null",
	});
} finally {
	await new Promise((resolve) => logStream.end(resolve));
}
