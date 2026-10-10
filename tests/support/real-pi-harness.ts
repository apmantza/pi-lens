import {
	spawn,
	type ChildProcess,
	type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
	SWEEP_ANY_AGE,
	sweepScratchDirs,
} from "../../scripts/lib/scratch-dir.mjs";
import { removeTempDirSync } from "../clients/test-utils.js";
import { isProcessAlive, killProcessTree } from "./process-tree.js";

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
	/**
	 * RPC `clone`: pi forks the session at its leaf and rebinds the extensions,
	 * the hand-off a `/clone` makes (#3521, #4138). Works under `--no-session`.
	 */
	clone(): Promise<JsonObject>;
	/** Close the child and resume its persisted session in a new pi process. */
	resume(): Promise<JsonObject>;
	/** Close stdin and wait for the current child to perform orderly shutdown. */
	quit(): Promise<void>;
	events(kind: string): Promise<ReadonlyArray<HarnessEvent>>;
	toolResults(): ReadonlyArray<HarnessEvent>;
	awaitAssistantTurn(): Promise<HarnessEvent>;
	awaitToolResult(name: string): Promise<HarnessEvent>;
	killChildForTest(): void;
	providerObservations(): ReadonlyArray<JsonObject>;
	sessionFiles(): ReadonlyArray<string>;
	projectPath(): string;
	homePath(): string;
	childTempDir(): string;
	childEnvironment(): Readonly<Record<string, string | undefined>>;
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

/**
 * Claim a scratch copy of a scenario's `project/` tree.
 *
 * `startRealPi` calls this for the per-child project it owns, which is the
 * default and is unchanged: one child, one project, removed on close. A test
 * that needs TWO LIVE `pi` children in ONE repository — the #2154 "second
 * active session/worktree" case, whose whole point is that both sessions
 * resolve the same project root and therefore the same `getProjectDataDir`
 * slug — calls this itself and passes the directory back through
 * `withRealPi({ project })`. The caller then owns the directory's lifetime
 * (see `close()`): neither child may delete a tree the other is still
 * scanning.
 *
 * Exported rather than duplicated: a second copy of the claim + seed + copy
 * sequence inside a test file is the parallel-setup shape this harness exists
 * to prevent, and `sweepScratchDirs` only recognises trees under this prefix.
 */
export function createRealPiProject(
	scenario: string,
	root: string = SCRATCH_DIR_ROOT,
): string {
	const dir = claimScratchDir(root, `real-pi-${scenario}-project`);
	writeFileSync(path.join(dir, "guarded.ts"), "export const value = 1;\n");
	writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
	cpSync(path.join(fixtureRoot, scenario, "project"), dir, {
		recursive: true,
	});
	return dir;
}

/**
 * The PATH head `npm run` hands a test, whatever started it: the repo's
 * `node_modules/.bin`, then the running node's directory. The pre-push hook
 * and a bare `vitest` start without the first, and the child then finds
 * neither `pi` nor the `knip` the fixture's project-diagnostics scan resolves
 * through PATH (#3742). Both bins are `#!/usr/bin/env node` shims, hence the
 * second entry. The key is matched case-insensitively because Windows spreads
 * `Path`.
 */
export function withRepoBinOnPath(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const key =
		Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
	const entries = [
		path.join(repoRoot, "node_modules", ".bin"),
		path.dirname(process.execPath),
		env[key],
	];
	return { ...env, [key]: entries.filter(Boolean).join(path.delimiter) };
}

function startRealPi(
	scenario: string,
	scriptFile: string,
	homeOverride?: string,
	args: readonly string[] = [],
	env: Record<string, string> = {},
	projectOverride?: string,
	extensions: readonly string[] = [],
	agentSettings?: JsonObject,
	persistedSession = false,
	entryFile = "index.js",
) {
	const scratchRoot = homeOverride ?? SCRATCH_DIR_ROOT;
	sweepScratchDirs(scratchRoot, "real-pi-", { maxAgeMs: SWEEP_ANY_AGE });
	const project = projectOverride ?? createRealPiProject(scenario, scratchRoot);
	const home = homeOverride ?? claimScratchDir(scratchRoot, "real-pi-home");
	const providerLog = path.join(home, "provider.jsonl");
	const sessionDir = path.join(home, "sessions");
	const childTmp = path.join(home, "tmp");
	mkdirSync(childTmp, { recursive: true });
	// #4292: callers may replace TMPDIR for adoption tests, but scanner
	// reports belong to this child, including when siblings share a home.
	const scannerTempDir = claimScratchDir(home, "scanner-tmp");
	if (persistedSession) mkdirSync(sessionDir, { recursive: true });
	// pi's agent dir (`PI_CODING_AGENT_DIR`) under the removable home, so a
	// scenario can turn on a built-in tool pi keeps off by default (codemode).
	const agentDir = path.join(home, "agent");
	if (agentSettings) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify(agentSettings),
		);
	}
	const childEnv = withRepoBinOnPath({
		...process.env,
		// Keep the real host outside Vitest's runner-only rethrow mode.
		VITEST: undefined,
		PI_LENS_HOME: home,
		REAL_PI_HARNESS_HOME: home,
		HOME: home,
		TMPDIR: childTmp,
		TMP: childTmp,
		TEMP: childTmp,
		REAL_PI_HARNESS_SCRIPT: scriptFile,
		REAL_PI_HARNESS_PROVIDER_LOG: providerLog,
		ANTHROPIC_API_KEY: "sk-ant-real-harness-dummy",
		...(agentSettings && { PI_CODING_AGENT_DIR: agentDir }),
		...env,
		PI_LENS_TEST_SCANNER_TMPDIR: scannerTempDir,
		PI_LENS_TEST_SCANNER_HARNESS: "1",
	});
	let child!: ChildProcessWithoutNullStreams;
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
	const killed = new Set<number>();
	let childStopped = false;
	const spawnArgs = (resume: boolean): string[] => [
		"--mode",
		"rpc",
		...(persistedSession
			? ["--session-dir", sessionDir, ...(resume ? ["--continue"] : [])]
			: ["--no-session"]),
		"--provider",
		"scripted",
		"--model",
		"harness",
		"-e",
		path.join(repoRoot, entryFile),
		"-e",
		path.join(fixtureRoot, "scripted-provider.mjs"),
		...extensions.flatMap((extension) => ["-e", extension]),
		...args,
	];
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
	const attachChild = (resume: boolean) => {
		childFailure = undefined;
		child = spawn("pi", spawnArgs(resume), {
			cwd: project,
			stdio: ["pipe", "pipe", "pipe"],
			env: childEnv,
		});
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
	};
	attachChild(false);
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
	const killTree = () => {
		for (const pid of killProcessTree(child)) killed.add(pid);
	};
	const stopChild = async (kill: boolean) => {
		if (childStopped) return;
		childStopped = true;
		child.stdin.end();
		if (kill) killTree();
		await waitForChildExit(child, [...killed]);
	};
	return {
		child,
		project,
		home,
		childEnv,
		events,
		request,
		waitFor,
		killChildForTest: killTree,
		async resume() {
			await stopChild(false);
			attachChild(true);
			childStopped = false;
			return request("get_commands");
		},
		quit: () => stopChild(false),
		providerObservations: () =>
			readFileSync(providerLog, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as JsonObject),
		async close() {
			await stopChild(true);
			removeTempDirSync(scannerTempDir);
			// A caller-supplied project (and home) outlives this child by
			// construction — a concurrent sibling session is still reading it.
			if (!projectOverride) removeTempDirSync(project);
			if (!homeOverride) removeTempDirSync(home);
		},
	};
}

const CHILD_EXIT_WAIT_MS = 5_000;
const CHILD_EXIT_POLL_MS = 20;

/**
 * SIGKILL is asynchronous: pi can still be releasing files when the signal
 * returns, and its grandchildren (`pids`, from {@link killProcessTree}) outlive
 * it. Wait until the child has reported exit and every pid is gone before
 * recursive cleanup, but keep teardown bounded if either never happens: one
 * stderr line, then removal proceeds (#4081).
 */
export function waitForChildExit(
	child: ChildProcess,
	pids: readonly number[] = [],
	timeoutMs = CHILD_EXIT_WAIT_MS,
): Promise<void> {
	// A child that never spawned (ENOENT) carries exitCode -2 and resolves here.
	const settled = () =>
		(child.exitCode !== null || child.signalCode !== null) &&
		pids.every((pid) => pid === child.pid || !isProcessAlive(pid));
	if (settled()) return Promise.resolve();
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const poll = setInterval(() => {
			const done = settled();
			if (!done && Date.now() < deadline) return;
			clearInterval(poll);
			if (!done)
				process.stderr.write(
					`[real-pi cleanup] child tree did not exit within ${timeoutMs}ms\n`,
				);
			resolve();
		}, CHILD_EXIT_POLL_MS);
	});
}

export async function withRealPi<T>(
	options: {
		fixture: string;
		script: string;
		home?: string;
		args?: readonly string[];
		env?: Record<string, string>;
		extensions?: readonly string[];
		/**
		 * Reuse an EXISTING project directory (from {@link createRealPiProject})
		 * instead of claiming and seeding a fresh one. The caller owns it: it is
		 * neither re-seeded from the fixture on entry nor removed on close, so a
		 * second `withRealPi` can run against the same project root — and, with
		 * `home`, the same `PI_LENS_HOME` — while the first child is still alive.
		 * That pair is what makes two sessions share one repository (#2154 AC1).
		 */
		project?: string;
		/**
		 * pi `settings.json` for the child's own agent dir, for example
		 * `{ defaultTools: ["+codemode"] }` to turn on a tool pi ships off.
		 */
		agentSettings?: JsonObject;
		/** Use a persisted session directory so {@link RealPi.resume} can restart pi. */
		persistedSession?: boolean;
		/**
		 * Extension entrypoint to load, relative to the repo root. The default
		 * `"index.js"` is the built twin real pi loads; `"index.ts"` drives the
		 * TypeScript-source load, where jiti transpiles the entry fresh on every
		 * `/reload` (#4169).
		 */
		entry?: "index.js" | "index.ts";
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
		options.project,
		options.extensions,
		options.agentSettings,
		options.persistedSession,
		options.entry ?? "index.js",
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
			clone: async () => {
				cursor = harness.events.length;
				return harness.request("clone");
			},
			resume: () => harness.resume(),
			quit: () => harness.quit(),
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
			sessionFiles: () =>
				options.persistedSession
					? readdirSync(path.join(harness.home, "sessions"))
							.filter((name) => name.endsWith(".jsonl"))
							.sort()
					: [],
			projectPath: () => harness.project,
			homePath: () => harness.home,
			childTempDir: () => path.join(harness.home, "tmp"),
			childEnvironment: () => harness.childEnv,
			lens: {
				latencyRows: () => readRows(path.join(harness.home, "latency.log")),
				extensionLog: () => readRows(path.join(harness.home, "extension.log")),
				sessionStartLog: () =>
					readLines(path.join(harness.home, "sessionstart.log")),
				degradations: () =>
					readRows(path.join(harness.home, "latency.log"))
						.filter((row) => row.phase === "degradation_ledger")
						.map((row) => ({
							...row,
							...(row.metadata as JsonObject | undefined),
						})),
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
