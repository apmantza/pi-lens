// #5699: a language server that never ends by itself.
//
// It answers `initialize` and nothing else, and it honours none of the ways a
// cooperative server leaves when its host is gone: it ignores stdin EOF,
// SIGTERM, SIGINT and SIGHUP, and it has no parent-pid watchdog and reads no
// `initialize.processId`. Only SIGKILL ends it. That is the server the host
// exit ledger must end without the server's help (PowerShell Editor Services
// is the one reported, #5694).
//
// argv[2] is a file the server writes "<pid> <ppid>" to once it runs, so a
// test can find its own grandchild and adopt it for cleanup.
//
// A hard cap ends it after HARD_CAP_MS whatever happens, so a failed test can
// never leave it running for longer than that: the cap is far above every
// wait a test makes, so it does not decide any verdict.
import fs from "node:fs";

const HARD_CAP_MS = 120_000;
const pidFile = process.argv[2];

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(signal, () => {});
}
process.stdin.on("end", () => {});
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), HARD_CAP_MS);

if (pidFile) fs.writeFileSync(pidFile, `${process.pid} ${process.ppid}`);

function send(message) {
	const json = JSON.stringify(message);
	process.stdout.write(
		`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
	);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const header = buffer.subarray(0, headerEnd).toString("utf8");
		const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
		const bodyEnd = headerEnd + 4 + length;
		if (buffer.length < bodyEnd) return;
		const body = buffer.subarray(headerEnd + 4, bodyEnd).toString("utf8");
		buffer = buffer.subarray(bodyEnd);
		let message;
		try {
			message = JSON.parse(body);
		} catch {
			continue;
		}
		if (message.method === "initialize") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { capabilities: { textDocumentSync: 1 } },
			});
		} else if (message.id !== undefined && message.method !== undefined) {
			// Answer every other request with null so no caller waits on it.
			send({ jsonrpc: "2.0", id: message.id, result: null });
		}
	}
});
