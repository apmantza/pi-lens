// flake-shape: real-process-spawn — the real pi tool_result hook, dispatcher,
// LSP client and a real child-process LSP server exchange the wire messages.
/** #5552 acceptance 2: mtime-preserving shell writes reach the LSP wire. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_LSP_SERVER_PATH } from "./support/fake-lsp-server.js";
import { execFileSync } from "./support/git-fixture-env.js";
import { endTurn, step } from "./support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const BLOCKING = "export function f() {\n\tdebugger;\n}\n";
const BLOCKING_2 = "export function g() {\n\tdebugger;\n}\n";
const CLEAN = "export const a = 1;\n";
const fixture = piSessionFixture();
const flags = new Map<string, boolean>([
	["no-lsp", false],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
	["no-complexity", true],
]);
const wireHashes = [BLOCKING, BLOCKING_2].map((content) =>
	createHash("sha256").update(content).digest("hex").slice(0, 12),
);

function layout(name: string) {
	const root = fs.mkdtempSync(
		path.join(fixture.root, `${name}-${process.pid}-`),
	);
	const proj = path.join(root, "proj");
	const stage = path.join(root, "stage");
	const target = path.join(proj, "src", "a.ts");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.mkdirSync(stage, { recursive: true });
	fs.writeFileSync(path.join(proj, "package.json"), "{}\n");
	fs.writeFileSync(target, CLEAN);
	fs.writeFileSync(path.join(proj, "src", "b.ts"), CLEAN);
	fs.writeFileSync(path.join(stage, "a.ts"), BLOCKING);
	fs.utimesSync(path.join(stage, "a.ts"), new Date(1), new Date(1));
	execFileSync("git", ["init", "-q"], { cwd: proj, stdio: "ignore" });
	execFileSync("git", ["add", "-A"], { cwd: proj, stdio: "ignore" });
	execFileSync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"],
		{ cwd: proj, stdio: "ignore" },
	);
	return { root, proj, stage, target };
}

async function run(
	name: string,
	commands: (l: ReturnType<typeof layout>) => string[],
) {
	const l = layout(name);
	fs.writeFileSync(path.join(l.stage, "b.ts"), BLOCKING_2);
	fs.utimesSync(path.join(l.stage, "b.ts"), new Date(1), new Date(1));
	const trace = path.join(l.root, "wire.log");
	fs.writeFileSync(
		path.join(l.proj, ".pi-lens.json"),
		JSON.stringify({
			lsp: {
				disabledServers: ["typescript", "deno"],
				servers: {
					"wire-5552": {
						command: process.execPath,
						args: [FAKE_LSP_SERVER_PATH],
						extensions: [".ts"],
						rootMarkers: ["package.json"],
						env: { FAKE_LSP_TRACE_FILE: trace, FAKE_LSP_TRACE_TEXT: "1" },
					},
				},
			},
		}) + "\n",
	);
	const session = await startPiSession({
		root: fixture.root,
		cwd: l.proj,
		flags,
		responses: [
			step(
				fauxToolCall("bash", { command: commands(l).join("; ") }),
				"writing",
			),
			endTurn("done"),
		],
	});
	try {
		await session.prompt("write the file");
		return fs.existsSync(trace)
			? fs.readFileSync(trace, "utf8").split("\n").filter(Boolean)
			: [];
	} finally {
		await session.dispose();
	}
}

describe("#5552 shell-write resync on the real LSP wire", () => {
	it("sends new bytes after mv and cp -p shell writes", async () => {
		const lines = await run("mv-and-cp-p", (l) => [
			`cp -p ${l.stage}/a.ts src/a.ts`,
			`mv ${l.stage}/b.ts src/`,
		]);
		expect(
			lines.filter((line) => wireHashes.some((hash) => line.includes(hash))),
			lines.join("\n"),
		).toHaveLength(2);
	});
});
