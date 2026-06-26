#!/usr/bin/env node
/**
 * RPC load check — positively verify pi-lens loaded, headless and model-free.
 *
 * Spawns `pi --mode rpc`, watches the JSONL event stream for `extension_error`,
 * then sends `get_commands` and asserts pi-lens's `lens-*` slash commands are
 * registered. `get_commands` does NOT call the LLM, so this needs no real
 * credentials — it is a deterministic POSITIVE check that pi actually loaded the
 * extension (vs. the weaker "no error + auth wall" signal).
 *
 * Used by .github/workflows/install-smoke.yml (pi-load job) to confirm a
 * `pi install npm:pi-lens` under each package manager / install method really
 * loads. Exit 0 = pass, 1 = fail (load error or no pi-lens commands), 2 = timeout.
 *
 * Usage: node scripts/rpc-load-check.mjs [path-to-pi-bin]
 */
import { spawn } from "node:child_process";

const piBin = process.argv[2] || "pi";
const pi = spawn(piBin, ["--mode", "rpc", "--no-session"], {
	stdio: ["pipe", "pipe", "inherit"],
	env: {
		...process.env,
		// RPC needs a provider configured to start; get_commands never calls it.
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "sk-ant-dummy-rpc-load-check",
	},
});

let buf = "";
const extErrors = [];
let done = false;
const finish = (code, msg) => {
	if (done) return;
	done = true;
	if (msg) console.log(msg);
	try { pi.kill("SIGKILL"); } catch {}
	process.exit(code);
};
const timer = setTimeout(() => finish(2, "TIMEOUT waiting for get_commands response"), 30000);

function handle(line) {
	let m;
	try { m = JSON.parse(line); } catch { return; }
	if ((m.type === "event" && m.event === "extension_error") || m.type === "extension_error") {
		extErrors.push(m);
		console.log("extension_error:", JSON.stringify(m).slice(0, 300));
	}
	if (m.type === "response" && m.command === "get_commands") {
		const cmds = (m.data && m.data.commands) || [];
		const lens = cmds.filter(
			(c) => /^lens-/.test(c.name) || String(c.path || "").includes("pi-lens"),
		);
		console.log(
			`total commands: ${cmds.length}; pi-lens commands: ${lens.map((c) => c.name).join(", ") || "(none)"}`,
		);
		clearTimeout(timer);
		if (extErrors.length) finish(1, `FAIL: ${extErrors.length} extension_error event(s)`);
		else if (!lens.length) finish(1, "FAIL: pi-lens registered no commands (did it load?)");
		else finish(0, `PASS: pi-lens loaded — ${lens.length} lens-* commands registered`);
	}
}

pi.stdout.on("data", (d) => {
	// Strict JSONL: split on LF only (per pi RPC framing rules).
	buf += d.toString();
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const l = buf.slice(0, i).replace(/\r$/, "");
		buf = buf.slice(i + 1);
		if (l.trim()) handle(l);
	}
});
pi.on("exit", (c) => {
	if (!done) finish(extErrors.length ? 1 : 2, `pi exited early (code ${c})`);
});

// Give extensions a moment to register, then request the command list.
setTimeout(() => {
	try { pi.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`); } catch {}
}, 2500);
