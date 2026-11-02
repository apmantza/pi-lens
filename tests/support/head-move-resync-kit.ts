/**
 * Shared harness for the HEAD-move resync cases (#4493, #4507, #4476), moved
 * unchanged out of `tests/clients/head-move-resync-4493.test.ts` when its
 * three describes were split over three files for #3801: the real-git
 * repository builder, the fake-LSP wiring, the session driver and the row
 * readers. `useHeadMoveHarness()` registers the file-level hooks, because a
 * hook registers in the file that calls it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { resetLSPService } from "../../clients/lsp/capabilities.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import { getGlobalPiLensLogDir } from "../../clients/probe-home-state.js";
import { resetOpaqueMutationState } from "../../clients/opaque-mutation-scan.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { execFileSync } from "./git-fixture-env.js";
import { runHandlerExpectingNoThrow } from "./handler-verdict.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

/**
 * #4493 r2: the auxiliary scanner a repository's `.ts` files also go to (the
 * ast-grep slot of the default stack). A project `lsp.json` cannot declare an
 * auxiliary (its `role` is reserved and inert, clients/lsp/config.ts), so the
 * selection (the config module's test setter) adds it for the repositories
 * registered here, the pattern the #1714 real-stream suites use; every other
 * lookup is the real one.
 */
export const primaryOrdering = new Map<
	string,
	"single-task-ordered" | "threaded" | "unmeasured"
>();
/** #4782: each registered repository's primary `resendRecheck` trait. */
export const primaryResend = new Map<string, "rechecks" | "unmeasured">();
export const auxiliaries = new Map<string, unknown>();

/**
 * The selection the config module's setter answers with: the real gate's
 * verdict (`explainServersForFile` reads the session config and is not
 * routed through the injected list) with each registered repository's
 * reply ordering and auxiliary added.
 */
export function selectWithAuxiliaries(
	explain: typeof import("../../clients/lsp/config.js").explainServersForFile,
) {
	return (filePath: string) => {
		const servers = explain(filePath)
			.filter((entry) => entry.selected)
			.map((entry) => entry.server)
			.map((server) => {
				for (const [dir, ordering] of primaryOrdering)
					if (filePath.startsWith(`${dir}${path.sep}`)) {
						const resendRecheck = primaryResend.get(dir);
						return {
							...server,
							replyOrdering: ordering,
							...(resendRecheck !== undefined && { resendRecheck }),
						};
					}
				return server;
			});
		for (const [dir, aux] of auxiliaries)
			if (filePath.startsWith(`${dir}${path.sep}`))
				return [...servers, aux as (typeof servers)[number]];
		return servers;
	};
}

export const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
export const PREFIX = "pi-lens-4493-head-move-";
export const env = setupTestEnvironment(PREFIX);

export const sha = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, 12);

export interface Repo {
	dir: string;
	trace: string;
	git: (...args: string[]) => string;
	file: (name: string) => string;
}

export let repoCount = 0;

/** Real git in `cwd`, with a fixed identity; its trimmed stdout. */
export function runGit(cwd: string, args: string[]): string {
	return String(
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t.local",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t.local",
			},
		}),
	).trim();
}

/**
 * A repository on branch `A` whose branch `B` rewrites `changed`. Both
 * servers are the fake, one for `.ts` and one for `.py` (the non-TypeScript
 * row); the built-in servers that would claim those files are disabled.
 */
export async function makeRepo(
	base: Record<string, string>,
	changed: Record<string, string>,
	initArgs: string[] = [],
	profile: Record<string, string> = {},
): Promise<Repo> {
	const dir = path.join(env.tmpDir, `repo-${++repoCount}`);
	const trace = path.join(env.tmpDir, `repo-${repoCount}.trace`);
	primaryOrdering.set(dir, "single-task-ordered");
	fs.mkdirSync(path.join(dir, ".pi-lens"), { recursive: true });
	const shim = path.join(env.tmpDir, `repo-${repoCount}-server.mjs`);
	fs.writeFileSync(
		shim,
		[
			'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
			'process.env.FAKE_LSP_TRACE_TEXT = "1";',
			`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
			...Object.entries(profile).map(
				([name, value]) => `process.env.${name} = ${JSON.stringify(value)};`,
			),
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	const server = (extensions: string[]) => ({
		name: "fake",
		extensions,
		command: process.execPath,
		args: [shim],
		rootMarkers: ["package.json"],
	});
	const files: Record<string, string> = {
		"package.json": "{}\n",
		".gitignore": ".pi-lens/\n",
		// Same files committed in the same second give the same commit ids;
		// this makes every repository's ids, and so its rows, its own.
		"repo-id.txt": `${repoCount}\n`,
		...base,
	};
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), content);
	}
	fs.writeFileSync(
		path.join(dir, ".pi-lens", "lsp.json"),
		JSON.stringify({
			servers: { "fake-ts": server([".ts"]), "fake-py": server([".py"]) },
			disabledServers: [
				"typescript",
				"deno",
				"python",
				"python-jedi",
				"opengrep",
				"ast-grep",
				"typos",
			],
		}),
	);
	const git = (...args: string[]) => runGit(dir, args);
	git("init", "-q", "-b", "A", ...initArgs);
	git("add", "-A");
	git("commit", "-qm", "base");
	git("branch", "B");
	git("checkout", "-q", "B");
	for (const [name, content] of Object.entries(changed))
		fs.writeFileSync(path.join(dir, name), content);
	git("commit", "-qam", "B");
	git("checkout", "-q", "A");
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(dir);
	config._setServersForFileForTests(
		selectWithAuxiliaries(config.explainServersForFile),
	);
	return { dir, trace, git, file: (name) => path.join(dir, name) };
}

export async function lspService() {
	const lsp = await import("../../clients/lsp/index.js");
	return lsp.getLSPService();
}

/** Open `files` on their server, as the post-write sync does. */
export async function hold(repo: Repo, names: string[]): Promise<void> {
	const service = await lspService();
	for (const name of names) {
		const file = repo.file(name);
		await service.touchFile(file, fs.readFileSync(file, "utf8"), {
			diagnostics: "none",
			clientScope: "primary",
			source: "lsp_sync",
		});
	}
}

/**
 * Give `repo`'s `.ts` files an auxiliary scanner that spends `changeCostMs` of
 * synchronous work on each didChange, and open `names` on both servers.
 */
export async function holdWithAuxiliary(
	repo: Repo,
	names: string[],
	changeCostMs: number,
): Promise<void> {
	const { spawnFakeLspServer } = await import("../support/fake-lsp-server.js");
	auxiliaries.set(repo.dir, {
		id: `fake-aux-${path.basename(repo.dir)}`,
		name: "fake-aux",
		role: "auxiliary",
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => repo.dir,
		spawn: async () => ({
			process: await spawnFakeLspServer({
				cwd: repo.dir,
				env: {
					...process.env,
					FAKE_LSP_CHANGE_COST_MS: String(changeCostMs),
				},
			}),
			source: "test" as const,
		}),
	});
	const service = await lspService();
	for (const name of names) {
		const file = repo.file(name);
		await service.touchFile(file, fs.readFileSync(file, "utf8"), {
			diagnostics: "none",
			clientScope: "all",
			source: "lsp_sync",
		});
	}
}

export function traceLines(repo: Repo): string[] {
	return fs.existsSync(repo.trace)
		? fs.readFileSync(repo.trace, "utf8").split("\n").filter(Boolean)
		: [];
}

/**
 * The server's trace up to a request sent now. The fake reads stdin in
 * order, and the client writes one ordered stream, so a didChange written
 * before this call is traced before the request is answered. A plain read of
 * the trace races the server process instead.
 */
export async function wire(repo: Repo, onServerOf: string): Promise<string[]> {
	await (await lspService()).documentSymbol(repo.file(onServerOf));
	return traceLines(repo);
}

/** The bytes the server received after `mark` trace lines, as `text` lines. */
export async function textSince(
	repo: Repo,
	mark: number,
	onServerOf: string,
): Promise<string[]> {
	return (await wire(repo, onServerOf))
		.slice(mark)
		.filter((line) => line.startsWith("text "));
}

/**
 * Send everything waiting on `repo`'s client watch queue now, so a later
 * window starts empty. The round trip first lets the announcements a touch
 * started (promise chains, no timers) enqueue; the out-of-band notify then
 * flushes the queue synchronously and clears its debounce timer.
 */
export async function drainWatchQueue(repo: Repo): Promise<void> {
	await wire(repo, "main.ts");
	(await lspService()).notifyOutOfBandFileChanges([
		{ filePath: repo.file("lib/drain-marker.ts"), type: 2 },
	]);
	await wire(repo, "main.ts");
}

/**
 * The `watched <uri> <type>` lines of each didChangeWatchedFiles notification
 * in `lines`, one array per notification, in wire order.
 */
export function watchedNotifications(lines: string[]): string[][] {
	const batches: string[][] = [];
	for (const line of lines) {
		if (line === "recv workspace/didChangeWatchedFiles") batches.push([]);
		else if (line.startsWith("watched ")) batches.at(-1)?.push(line);
	}
	return batches;
}

export const textLine = (repo: Repo, name: string) =>
	`text ${pathToFileURL(repo.file(name)).href} ${sha(fs.readFileSync(repo.file(name), "utf8"))}`;

/**
 * Whether the client already sent `name`'s disk bytes, read synchronously:
 * called right after a hook returns, with the service fetched beforehand, it
 * says the didChange went out BEFORE the return (no later microtask or I/O
 * can complete in between). The wire check then shows the server got them.
 */
export function sentDiskBytes(
	service: Awaited<ReturnType<typeof lspService>>,
	repo: Repo,
	name: string,
): boolean {
	const file = repo.file(name);
	const want = hashDiagnosticContent(fs.readFileSync(file, "utf8"));
	return service.getTrackedContent(file, repo.dir)?.hash === want;
}

/** The text of a tool_result's content, as the model reads it. */
export function resultText(
	result: Awaited<ReturnType<typeof handleToolResult>>,
): string {
	return (result?.content ?? [])
		.map((part) => ("text" in part ? String(part.text ?? "") : ""))
		.join("\n");
}

/**
 * One pi session's hooks. `shared` passes another session's coordinator: in
 * index.ts one module-level RuntimeCoordinator serves the primary and every
 * concurrent secondary session, so they share its `sessionGeneration`.
 */
/**
 * A session's hooks. `parent` makes every call nested under that tool call,
 * as a codemode script's bash is (`parentToolCallId` on both events).
 */
export function session(
	repo: Repo,
	sessionId: string,
	shared?: RuntimeCoordinator,
	parent?: string,
) {
	const runtime = shared ?? new RuntimeCoordinator();
	runtime.projectRoot = repo.dir;
	if (!shared) runtime.setTelemetryIdentity({ sessionId });
	let n = 0;
	const callDeps = (toolName: string, input: unknown, toolCallId: string) =>
		({
			event: {
				toolName,
				toolCallId,
				input,
				...(parent !== undefined && { parentToolCallId: parent }),
			},
			ctx: { cwd: repo.dir },
			lensEnabled: true,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
			sessionId,
		}) as Parameters<typeof handleToolCall>[0];
	const resultDeps = (command: string, toolCallId: string) =>
		({
			event: {
				toolName: "bash",
				toolCallId,
				input: { command },
				content: [{ type: "text", text: "ok" }],
				...(parent !== undefined && { parentToolCallId: parent }),
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			testRunnerClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
			sessionId,
		}) as unknown as Parameters<typeof handleToolResult>[0];
	return {
		runtime,
		/** The bash tool_call; the returned function is its tool_result. */
		async bashCall(command: string): Promise<() => Promise<string>> {
			const id = `${sessionId}-c${++n}`;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps("bash", { command }, id)),
			);
			return async () =>
				resultText(await handleToolResult(resultDeps(command, id)));
		},
		/**
		 * One whole bash call: tool_call, the host's run, tool_result. Answers
		 * the text the tool_result returned to the model.
		 */
		async bash(command: string, run: () => void): Promise<string> {
			const result = await this.bashCall(command);
			run();
			return result();
		},
		async read(file: string): Promise<void> {
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					callDeps("read", { path: file }, `${sessionId}-c${++n}`),
				),
			);
		},
	};
}

/**
 * The head_moved rows whose move landed on `ref` (branch B): `repo-id.txt`
 * makes commit ids unique per repository, so no other case's row can match.
 */
export async function headMovedRows(
	repo: Repo,
	ref = "B",
): Promise<Array<{ result: string; metadata: Record<string, unknown> }>> {
	await flushLatencyLog();
	const to = repo.git("rev-parse", ref).slice(0, 12);
	const log = path.join(getGlobalPiLensLogDir(), "latency.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.includes('"opaque_mutation_head_moved"'))
		.map(
			(line) =>
				JSON.parse(line) as {
					result: string;
					metadata: Record<string, unknown>;
				},
		)
		.filter((row) => row.metadata.to === to);
}

/**
 * The head_moved rows once `count` have landed. The row is written when the
 * resync's detached second phase (every holding server, the drift records)
 * ends, after the hook returned.
 */
export async function settledHeadMovedRows(
	repo: Repo,
	count: number,
	ref = "B",
) {
	await expect
		.poll(async () => (await headMovedRows(repo, ref)).length, {
			timeout: 30_000,
			interval: 100,
		})
		.toBe(count);
	return headMovedRows(repo, ref);
}

/** Every `phase` row in the real latency sink. */
export async function phaseRows(
	phase: string,
): Promise<Array<{ filePath: string; metadata: Record<string, unknown> }>> {
	await flushLatencyLog();
	const log = path.join(getGlobalPiLensLogDir(), "latency.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.includes(`"${phase}"`))
		.map(
			(line) =>
				JSON.parse(line) as {
					filePath: string;
					metadata: Record<string, unknown>;
				},
		);
}

export const TYPES_A =
	"export function isChatModel(x: unknown): boolean { return !!x; }\n";
export const TYPES_B = `${TYPES_A}export function isChatModelConfig(x: unknown): boolean { return !!x; }\n`;
export const MAIN =
	'import { isChatModel } from "./lib/types";\nexport const note = "one";\n';

export function useHeadMoveHarness(): void {
	let previousTestMode: string | undefined;
	let previousDriftMs: string | undefined;

	beforeAll(() => {
		// Host-boundary stub: a project-configured server needs pi's trust answer
		// (#4248 refuses it otherwise).
		setProjectTrustState("trusted");
		// latency.log writes are off under PI_LENS_TEST_MODE (#1742); the
		// head_moved row is read back from the real sink.
		previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		// The paced drift heartbeat could heal a stale document by chance on a
		// later touch; off, only the HEAD-move resync can produce the new bytes.
		previousDriftMs = process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
		process.env.PI_LENS_LSP_DRIFT_CHECK_MS = "0";
	});

	afterAll(async () => {
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
		if (previousDriftMs === undefined)
			delete process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
		else process.env.PI_LENS_LSP_DRIFT_CHECK_MS = previousDriftMs;
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await (await lspService()).shutdown();
			},
		});
		resetProjectTrust();
	});

	beforeEach(() => {
		resetOpaqueMutationState();
	});

	afterEach(() => {
		// #4831: removing an auxiliary's selection entry does not retire its
		// client. No case shares held documents with another; retire every client
		// so a slow auxiliary cannot consume a later case's resync drain budget.
		resetLSPService();
	});
}
