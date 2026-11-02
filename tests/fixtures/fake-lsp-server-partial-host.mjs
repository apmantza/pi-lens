// #5169: a separate Node host is required to observe natural event-loop exit.
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode === "server") {
	let buffer = Buffer.alloc(0);
	process.stdin.on("data", (data) => {
		buffer = Buffer.concat([buffer, data]);
		for (;;) {
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
			if (buffer.length < end + 4 + length) return;
			const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
			buffer = buffer.subarray(end + 4 + length);
			if (message.method === "initialize") {
				const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
			} else if (message.method === "initialized") {
				process.stdout.write('Content-Length: 500\r\n\r\n{"jsonrpc":"2.0",', () => {
					if (process.argv[3] === "exit") process.exit(0);
				});
			}
		}
	});
	process.stdin.on("end", () => process.exit(0));
} else {
	const { setProjectTrustState } = await import("../../clients/project-trust.js");
	setProjectTrustState("trusted");
	const { launchLSP } = await import("../../clients/lsp/launch.js");
	const { createLSPClient } = await import("../../clients/lsp/client.js");
	const proc = await launchLSP(process.execPath, [fileURLToPath(import.meta.url), "server", mode], { cwd: process.cwd() });
	// launchLSP unrefs background servers; keep this probe alive until the wire arrives.
	proc.process.ref();
	for (const stream of [proc.stdin, proc.stdout, proc.stderr]) stream.ref?.();
	try {
		let seenPartial = false;
		const partial = new Promise((resolve) => {
			proc.stdout.on("data", (data) => {
				if (data.toString().includes("Content-Length: 500")) {
					seenPartial = true;
					resolve();
				}
			});
		});
		const exited = once(proc.process, "exit");
		const client = await createLSPClient({ serverId: "partial-message-5169", process: proc, root: process.cwd() });
		await partial;
		assert.ok(seenPartial);
		if (mode === "shutdown") {
			assert.equal(proc.process.exitCode, null);
			await client.shutdown({ fast: true });
		}
		await exited;
		console.log(`completed:${mode}:partial-body`);
		process.once("beforeExit", () => {
			assert.ok(!process.getActiveResourcesInfo().includes("Timeout"));
			console.log("natural-exit:no-ref-timer");
		});
	} finally {
		if (proc.process.exitCode === null && proc.process.signalCode === null) proc.process.kill("SIGKILL");
	}
}
