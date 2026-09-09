import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type JsonObject = Record<string, unknown>;
export type HarnessEvent = JsonObject & { event?: string; type?: string };
export type Script = Array<Array<{ type: "text"; text: string } | { type: "toolCall"; name: string; id?: string; arguments?: JsonObject }>>;
export type RealPi = {
	prompt(text: string): Promise<JsonObject>; getState(): Promise<JsonObject>; getCommands(): Promise<JsonObject>;
	events(kind: string): Promise<ReadonlyArray<HarnessEvent>>; toolResults(): ReadonlyArray<HarnessEvent>;
	lens: { latencyRows(): ReadonlyArray<JsonObject>; extensionLog(): ReadonlyArray<JsonObject>; degradations(): ReadonlyArray<JsonObject> };
};
export type RpcMessage = HarnessEvent;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const realHarnessFixtureRoot = path.join(repoRoot, "tests/fixtures/real-harness");
const fixtureRoot = realHarnessFixtureRoot;

export function validateScript(value: unknown, source = "script.json"): Script {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${source} must be a non-empty array of turns`);
	for (const [turnIndex, turn] of value.entries()) {
		if (!Array.isArray(turn) || turn.length === 0) throw new Error(`${source} turn ${turnIndex} must be a non-empty array`);
		for (const [actionIndex, action] of turn.entries()) {
			if (!action || typeof action !== "object" || typeof (action as JsonObject).type !== "string") throw new Error(`${source} turn ${turnIndex} action ${actionIndex} must have a type field`);
			const record = action as JsonObject;
			if (record.type === "text" && typeof record.text !== "string") throw new Error(`${source} turn ${turnIndex} action ${actionIndex} text must be a string`);
			if (record.type === "toolCall" && typeof record.name !== "string") throw new Error(`${source} turn ${turnIndex} action ${actionIndex} name must be a string`);
			if (record.type !== "text" && record.type !== "toolCall") throw new Error(`${source} turn ${turnIndex} action ${actionIndex} has unsupported type ${String(record.type)}`);
		}
	}
	return value as Script;
}

function fixtureProject(scenario: string): string {
	const dir = mkdtempSync(path.join(repoRoot, `.real-harness-${scenario}-`));
	writeFileSync(path.join(dir, "guarded.ts"), "export const value = 1;\n");
	writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
	return dir;
}

function startRealPi(scenario: "scenario-1" | "scenario-3", homeOverride?: string) {
	const project = fixtureProject(scenario);
	const home = homeOverride ?? mkdtempSync(path.join(os.tmpdir(), "pi-lens-real-home-"));
	cpSync(path.join(fixtureRoot, scenario, "project"), project, { recursive: true });
	const providerLog = path.join(home, "provider.jsonl");
	const child: ChildProcessWithoutNullStreams = spawn("pi", ["--mode", "rpc", "--no-session", "--provider", "scripted", "--model", "harness", "-e", path.join(repoRoot, "index.js"), "-e", path.join(fixtureRoot, "scripted-provider.mjs")], { cwd: project, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_LENS_HOME: home, HOME: home, REAL_PI_HARNESS_SCRIPT: path.join(fixtureRoot, scenario, "script.json"), REAL_PI_HARNESS_PROVIDER_LOG: providerLog, ANTHROPIC_API_KEY: "sk-ant-real-harness-dummy" } });
	const events: RpcMessage[] = [];
	const waiters = new Map<string, Array<(message: RpcMessage) => void>>();
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString(); let end = buffer.indexOf("\n");
		while (end >= 0) { const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1); end = buffer.indexOf("\n"); if (!line.trim()) continue; try { const message = JSON.parse(line) as RpcMessage; events.push(message); for (const key of [message.id, message.event, message.type]) for (const resolve of waiters.get(String(key)) ?? []) resolve(message); } catch { /* protocol owns stdout */ } }
	});
	const waitFor = (key: string, predicate: (message: RpcMessage) => boolean = () => true) => new Promise<RpcMessage>((resolve, reject) => { const timer = setTimeout(() => { waiters.delete(key); reject(new Error(`timed out waiting for ${key}`)); }, 60_000); const waiter = (message: RpcMessage) => { if (predicate(message)) { clearTimeout(timer); resolve(message); } else waiters.set(key, [...(waiters.get(key) ?? []), waiter]); }; waiters.set(key, [...(waiters.get(key) ?? []), waiter]); });
	const request = (type: string, fields: RpcMessage = {}) => { const id = `${type}-${Date.now()}-${Math.random()}`; const response = waitFor(id); child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); return response; };
	return { child, project, home, events, request, waitFor, providerObservations: () => readFileSync(providerLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as JsonObject), async close() { child.stdin.end(); child.kill("SIGKILL"); rmSync(project, { recursive: true, force: true }); if (!homeOverride) rmSync(home, { recursive: true, force: true }); } };
}

export async function withRealPi<T>(options: { fixture: string; script: string; home?: string }, callback: (pi: RealPi) => Promise<T>): Promise<T> {
	const fixture = options.fixture as "scenario-1" | "scenario-3";
	const scriptFile = path.join(fixtureRoot, fixture, options.script);
	if (!existsSync(scriptFile)) throw new Error(`real-harness fixture: ${options.script} does not exist`);
	validateScript(JSON.parse(readFileSync(scriptFile, "utf8")), scriptFile);
	const harness = startRealPi(fixture, options.home);
	try {
		const matches = (kind: string) => harness.events.filter((event) => event.event === kind || event.type === kind);
		const pi: RealPi = { getCommands: () => harness.request("get_commands"), getState: () => harness.request("get_state"), prompt: (message) => harness.request("prompt", { message }), events: async (kind) => { if (!matches(kind).length) await harness.waitFor(kind); return matches(kind); }, toolResults: () => harness.events.filter((event) => event.event === "tool_execution_end" || event.type === "tool_execution_end"), lens: { latencyRows: () => readRows(path.join(harness.home, "latency.log")), extensionLog: () => readRows(path.join(harness.home, "extension.log")), degradations: () => readRows(path.join(harness.home, "degradation-ledger.json")) } };
		await harness.request("get_commands");
		return await callback(pi);
	} finally { await harness.close(); }
}

function readRows(file: string): JsonObject[] { if (!existsSync(file)) return []; return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).flatMap((line) => { try { const row = JSON.parse(line) as unknown; return row && typeof row === "object" ? [row as JsonObject] : []; } catch { return []; } }); }
