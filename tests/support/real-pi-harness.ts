import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
	cpSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
	sweepScratchDirs,
} from "../../scripts/lib/scratch-dir.mjs";

// flake-shape: raw-timer-wait — the bounded timeout waits for real child progress

type JsonObject = Record<string, unknown>;
type HarnessEvent = JsonObject & { event?: string; type?: string };
class RealPiChildExitError extends Error {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;

	constructor(code: number | null, signal: NodeJS.Signals | null) {
		super(
			`real pi child exited (code ${code ?? "null"}, signal ${signal ?? "none"})`,
		);
		this.name = "RealPiChildExitError";
		this.code = code;
		this.signal = signal;
	}
}
export type Script = Array<
	Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; name: string; id?: string; arguments?: JsonObject }
	>
>;
export type RealPi = {
	prompt(text: string): Promise<JsonObject>;
	getState(): Promise<JsonObject>;
	getCommands(): Promise<JsonObject>;
	newSession(): Promise<JsonObject>;
	events(kind: string): Promise<ReadonlyArray<HarnessEvent>>;
	toolResults(): ReadonlyArray<HarnessEvent>;
	awaitAssistantTurn(): Promise<HarnessEvent>;
	awaitToolResult(name: string): Promise<HarnessEvent>;
	killChildForTest(): void;
	providerObservations(): ReadonlyArray<JsonObject>;
	projectPath(): string;
	lens: {
		latencyRows(): ReadonlyArray<JsonObject>;
		extensionLog(): ReadonlyArray<JsonObject>;
		sessionStartLog(): ReadonlyArray<string>;
		degradations(): ReadonlyArray<JsonObject>;
	};
};
type RpcMessage = HarnessEvent;
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
export const realHarnessFixtureRoot = path.join(
	repoRoot,
	"tests/fixtures/real-harness",
);
const fixtureRoot = realHarnessFixtureRoot;

export function validateScript(value: unknown, source = "script.json"): Script {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error(`${source} must be a non-empty array of turns`);
	for (const [turnIndex, turn] of value.entries()) {
		if (!Array.isArray(turn) || turn.length === 0)
			throw new Error(`${source} turn ${turnIndex} must be a non-empty array`);
		for (const [actionIndex, action] of turn.entries()) {
			if (
				!action ||
				typeof action !== "object" ||
				typeof (action as JsonObject).type !== "string"
			)
				throw new Error(
					`${source} turn ${turnIndex} action ${actionIndex} must have a type field`,
				);
			const record = action as JsonObject;
			if (record.type === "text" && typeof record.text !== "string")
				throw new Error(
					`${source} turn ${turnIndex} action ${actionIndex} text must be a string`,
				);
			if (record.type === "toolCall" && typeof record.name !== "string")
				throw new Error(
					`${source} turn ${turnIndex} action ${actionIndex} name must be a string`,
				);
			if (record.type !== "text" && record.type !== "toolCall")
				throw new Error(
					`${source} turn ${turnIndex} action ${actionIndex} has unsupported type ${String(record.type)}`,
				);
		}
	}
	return value as Script;
}

function fixtureProject(scenario: string, root: string): string {
	const dir = claimScratchDir(root, `real-pi-${scenario}-project`);
	writeFileSync(path.join(dir, "guarded.ts"), "export const value = 1;\n");
	writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
	return dir;
}

function startRealPi(
	scenario: string,
	scriptFile: string,
	homeOverride?: string,
	args: readonly string[] = [],
	env: Record<string, string> = {},
) {
	const scratchRoot = homeOverride ?? SCRATCH_DIR_ROOT;
	sweepScratchDirs(scratchRoot, "real-pi-", { maxAgeMs: 0 });
	const project = fixtureProject(scenario, scratchRoot);
	const home = homeOverride ?? claimScratchDir(scratchRoot, "real-pi-home");
	cpSync(path.join(fixtureRoot, scenario, "project"), project, {
		recursive: true,
	});
	const providerLog = path.join(home, "provider.jsonl");
	const child: ChildProcessWithoutNullStreams = spawn(
		"pi",
		[
			"--mode",
			"rpc",
			"--no-session",
			"--provider",
			"scripted",
			"--model",
			"harness",
			"-e",
			path.join(repoRoot, "index.js"),
			"-e",
			path.join(fixtureRoot, "scripted-provider.mjs"),
			...args,
		],
		{
			cwd: project,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_LENS_HOME: home,
				HOME: home,
				REAL_PI_HARNESS_SCRIPT: scriptFile,
				REAL_PI_HARNESS_PROVIDER_LOG: providerLog,
				ANTHROPIC_API_KEY: "sk-ant-real-harness-dummy",
				...env,
			},
		},
	);
	const events: RpcMessage[] = [];
	const waiters = new Map<
		string,
		Array<{
			timer: NodeJS.Timeout;
			predicate: (message: RpcMessage) => boolean;
			resolve: (message: RpcMessage) => void;
			reject: (error: Error) => void;
		}>
	>();
	let childFailure: RealPiChildExitError | undefined;
	const rejectPending = (error: RealPiChildExitError) => {
		childFailure = error;
		for (const pending of waiters.values()) {
			for (const waiter of pending) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		}
		waiters.clear();
	};
	child.once("error", (error) => {
		if (!childFailure) rejectPending(new RealPiChildExitError(null, null));
		else void error;
	});
	child.once("exit", (code, signal) => {
		if (!childFailure) rejectPending(new RealPiChildExitError(code, signal));
	});
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			const line = buffer.slice(0, end).replace(/\r$/, "");
			buffer = buffer.slice(end + 1);
			end = buffer.indexOf("\n");
			if (!line.trim()) continue;
			try {
				const message = JSON.parse(line) as RpcMessage;
				events.push(message);
				for (const key of [message.id, message.event, message.type]) {
					const pending = waiters.get(String(key));
					if (!pending) continue;
					const remaining = pending.filter((waiter) => {
						if (!waiter.predicate(message)) return true;
						clearTimeout(waiter.timer);
						waiter.resolve(message);
						return false;
					});
					if (remaining.length) waiters.set(String(key), remaining);
					else waiters.delete(String(key));
				}
			} catch {
				/* protocol owns stdout */
			}
		}
	});
	const waitFor = (
		key: string,
		predicate: (message: RpcMessage) => boolean = () => true,
	) =>
		new Promise<RpcMessage>((resolve, reject) => {
			if (childFailure) {
				reject(childFailure);
				return;
			}
			const timer = setTimeout(() => {
				waiters.delete(key);
				reject(new Error(`timed out waiting for ${key}`));
			}, 60_000);
			const waiter = {
				timer,
				predicate,
				resolve,
				reject,
			};
			waiters.set(key, [...(waiters.get(key) ?? []), waiter]);
		});
	const request = (type: string, fields: RpcMessage = {}) => {
		const id = `${type}-${Date.now()}-${Math.random()}`;
		const response = waitFor(id);
		child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		return response;
	};
	return {
		child,
		project,
		home,
		events,
		request,
		waitFor,
		killChildForTest: () => child.kill("SIGKILL"),
		providerObservations: () =>
			readFileSync(providerLog, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as JsonObject),
		async close() {
			child.stdin.end();
			child.kill("SIGKILL");
			rmSync(project, { recursive: true, force: true });
			if (!homeOverride) rmSync(home, { recursive: true, force: true });
		},
	};
}

export async function withRealPi<T>(
	options: {
		fixture: string;
		script: string;
		home?: string;
		args?: readonly string[];
		env?: Record<string, string>;
	},
	callback: (pi: RealPi) => Promise<T>,
): Promise<T> {
	const fixture = options.fixture;
	const scriptFile = path.join(fixtureRoot, fixture, options.script);
	if (!existsSync(scriptFile))
		throw new Error(`real-harness fixture: ${options.script} does not exist`);
	validateScript(JSON.parse(readFileSync(scriptFile, "utf8")), scriptFile);
	const harness = startRealPi(
		fixture,
		scriptFile,
		options.home,
		options.args,
		options.env,
	);
	try {
		let cursor = harness.events.length;
		const matches = (kind: string, after: number) =>
			harness.events
				.slice(after)
				.filter((event) => event.event === kind || event.type === kind);
		const waitEvent = async (
			kind: string,
			after: number,
			predicate: (event: RpcMessage) => boolean = () => true,
		) => {
			const existing = matches(kind, after).filter(predicate);
			if (existing.length) return existing[existing.length - 1];
			return harness.waitFor(
				kind,
				(event) => harness.events.indexOf(event) > after && predicate(event),
			);
		};
		const pi: RealPi = {
			getCommands: () => harness.request("get_commands"),
			getState: () => harness.request("get_state"),
			newSession: async () => {
				cursor = harness.events.length;
				return harness.request("new_session");
			},
			prompt: async (message) => {
				cursor = harness.events.length;
				return harness.request("prompt", { message });
			},
			events: async (kind) => {
				const event = await waitEvent(kind, cursor);
				cursor = harness.events.indexOf(event) + 1;
				return [event];
			},
			awaitAssistantTurn: async () => {
				const event = await waitEvent(
					"message_end",
					cursor,
					(candidate) =>
						(candidate.message as JsonObject | undefined)?.role === "assistant",
				);
				cursor = harness.events.indexOf(event) + 1;
				return event;
			},
			awaitToolResult: async (name) => {
				const event = await waitEvent("tool_execution_end", cursor);
				const toolName =
					event.toolName ?? event.name ?? (event as JsonObject).tool_name;
				if (toolName !== name)
					throw new Error(
						`expected tool result ${name}, received ${String(toolName)}`,
					);
				cursor = harness.events.indexOf(event) + 1;
				return event;
			},
			killChildForTest: harness.killChildForTest,
			toolResults: () =>
				harness.events.filter(
					(event) =>
						event.event === "tool_execution_end" ||
						event.type === "tool_execution_end",
				),
			providerObservations: () => harness.providerObservations(),
			projectPath: () => harness.project,
			lens: {
				latencyRows: () => readRows(path.join(harness.home, "latency.log")),
				extensionLog: () => readRows(path.join(harness.home, "extension.log")),
				sessionStartLog: () =>
					readLines(path.join(harness.home, "sessionstart.log")),
				degradations: () =>
					readRows(path.join(harness.home, "degradation-ledger.json")),
			},
		};
		await harness.request("get_commands");
		return await callback(pi);
	} finally {
		await harness.close();
	}
}

function readRows(file: string): JsonObject[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const row = JSON.parse(line) as unknown;
				return row && typeof row === "object" ? [row as JsonObject] : [];
			} catch {
				return [];
			}
		});
}

function readLines(file: string): string[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean);
}
