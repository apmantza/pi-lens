#!/usr/bin/env node
/**
 * One latency sample of the pi-lens hot paths (#4363), in a fresh process.
 *
 *   node scripts/hot-path-sample.mjs --tree <built-checkout> --scratch <dir>
 *
 * Prints one JSON line of wall-clock milliseconds, one key per metric below.
 * `scripts/check-hot-path-latency.mjs` runs it N times against the PR head and
 * N times against the base tree, interleaved, and decides.
 *
 * Every number comes from a production entry point of `--tree`, built with
 * `npm run build` (the compiled twins next to the sources):
 *
 *   extension_load   `import("<tree>/index.js")` plus the default-export
 *                    factory against a recording host.
 *   session_start    the registered `session_start` handler, awaited.
 *   dispatch_small /
 *   dispatch_large   `dispatchLint` (clients/dispatch/integration.js), the
 *                    entry `tool_result` uses, on a 42-line and a 4002-line
 *                    TypeScript fixture (whole six-line functions, so the
 *                    file parses). Small is the process's first
 *                    dispatch (grammar and rule loading included), large the
 *                    second, on a file the process has not seen. The `lsp`
 *                    runner is off (`no-lsp`) and tool installs are disabled
 *                    (`PI_LENS_DISABLE_TOOL_INSTALL`), so the runners left are
 *                    the in-process ones; a language server's or a
 *                    downloader's time is not pi-lens's and not repeatable.
 *   replay_small /
 *   replay_large     the workspace-diagnostics cache replay (#4344): a fresh
 *                    `createWorkspaceDiagnosticsCacheContext` loading a
 *                    persisted cache of 200 / 2000 entries, then one `lookup`
 *                    per file.
 *   tool_call_first_touch /
 *   tool_result_edit the registered `tool_call` of the first read of a
 *                    42-line TypeScript file the process has not seen (the
 *                    first touch, where the complexity baseline is taken,
 *                    #5087), and the `tool_result` of an edit to it after
 *                    the bytes change on disk. The project is a real git
 *                    repository with the file committed on `main`, and the
 *                    edit raises one function past the `high-complexity`
 *                    threshold, so the edit pays the default-branch read
 *                    (two `git` spawns and a parse of `main`'s copy) and the
 *                    advisory (#5443 review F6). The row checks that a
 *                    `tool_result` latency row for the file reached the log.
 *   tool_call_bash_home_overcap
 *                    three consecutive `bash` calls through the registered
 *                    `tool_call` handler, in a session whose cwd is a non-git
 *                    home folder holding more files than the opaque prescan's
 *                    cap (#4905: every call walked the home to the cap and got
 *                    no baseline, about 2 s each on the reporter's machine).
 *                    HOME is pinned to that folder, under `--scratch`, for the
 *                    row only. The row checks that three `opaque_mutation_prescan`
 *                    rows reached the latency log, so a tree whose handler skips
 *                    the prescan is a harness failure, not a fast row.
 *
 * Fixtures are generated deterministically here, so base and head see the
 * same bytes. The host is a recording stub: it is the one boundary a script
 * cannot run for real (no model, no pi UI).
 *
 * Scope: this times pi-lens's own code on these paths. A language server's
 * time (the 624 ms Pyrefly re-touch #4344 measured) is not in it; the replay
 * metric sees the cache half of that regression only.
 *
 * `PI_LENS_HOME` and `PILENS_DATA_DIR` are pinned under `--scratch` before the
 * first import, so nothing reaches the real home.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { scratchHomeEnv } from "./lib/scratch-home-env.mjs";

const SMALL_LINES = 40;
const LARGE_LINES = 4000;
const REPLAY_SMALL = 200;
const REPLAY_LARGE = 2000;
/** Files of the over-cap home: more than the prescan's 2000-file cap. */
const OVERCAP_FILES = 2100;
const TOOL_CALLS = 3;

/**
 * Deterministic TypeScript of at least `lines` lines: whole six-line functions
 * with a few branches, so the file is valid and every runner parses it.
 */
function fixtureSource(lines) {
	const out = [];
	let n = 0;
	while (out.length < lines) {
		out.push(
			`export function f${n}(a: number, b: string): string {`,
			`\tif (a > ${n}) {`,
			`\t\treturn b + String(a * ${n});`,
			"\t}",
			"\treturn b;",
			"}",
		);
		n++;
	}
	return `${out.join("\n")}\n`;
}

/**
 * Make `project` a git repository whose `main` holds every file in it, so the
 * edit row reads the default branch for real. The fixture Git environment
 * (`git-fixture-env.mjs`) reads only the repository's fixture config, so no
 * user config is read and no background maintenance is forked; the identity
 * is passed per command, and a failing command throws.
 */
function commitFixture(project) {
	const git = (args) =>
		gitExecFileSync(args, { cwd: project, stdio: "pipe", encoding: "utf8" });
	git(["init", "-q", "-b", "main"]);
	git(["add", "-A"]);
	git([
		"-c",
		"user.name=hot-path",
		"-c",
		"user.email=hot-path@example.invalid",
		"commit",
		"-q",
		"--no-gpg-sign",
		"-m",
		"fixture",
	]);
}

/**
 * An edit that gives the first function of a fixture file (`f0`) fifteen more
 * branches: its cyclomatic complexity goes from 2 to 17, past
 * `high-complexity`'s 15.
 */
function crossThreshold() {
	const anchor = "\treturn b;\n}";
	const branches = Array.from(
		{ length: 15 },
		(_, i) => `\tif (b === "${i}") return b + ${i};`,
	).join("\n");
	return { oldText: anchor, newText: `${branches}\n${anchor}` };
}

/** A recording stand-in for pi's ExtensionAPI: the host boundary. */
function makeHost() {
	const handlers = new Map();
	const flags = new Map();
	const pi = {
		registerFlag: (name, o) => flags.set(name, o?.default),
		registerCommand: () => {},
		registerTool: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getFlag: (name) => flags.get(name),
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
	return { pi, handlers, flags };
}

function makeCtx(cwd) {
	const manager = {
		getSessionId: () => "hot-path-sample",
		getSessionFile: () => undefined,
	};
	return {
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setTitle: () => {},
			theme: {},
		},
		mode: "tui",
		hasUI: true,
		cwd,
		sessionManager: manager,
		model: undefined,
		signal: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		waitForIdle: async () => {},
		isProjectTrusted: () => true,
	};
}

async function timed(fn) {
	const start = performance.now();
	await fn();
	return performance.now() - start;
}

function argValue(name) {
	const at = process.argv.indexOf(`--${name}`);
	return at >= 0 ? process.argv[at + 1] : undefined;
}

async function sample(tree, scratch) {
	const imp = (rel) => import(pathToFileURL(path.join(tree, rel)).href);
	const project = path.join(scratch, "project");
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(project, "package.json"),
		'{"name":"hot-path-fixture","version":"1.0.0","type":"module"}\n',
	);
	const smallFile = path.join(project, "src", "small.ts");
	const largeFile = path.join(project, "src", "large.ts");
	fs.writeFileSync(smallFile, fixtureSource(SMALL_LINES));
	fs.writeFileSync(largeFile, fixtureSource(LARGE_LINES));
	fs.writeFileSync(
		path.join(project, "src", "edited.ts"),
		fixtureSource(SMALL_LINES),
	);
	commitFixture(project);

	const result = {};
	const { pi, handlers, flags } = makeHost();
	result.extension_load = await timed(async () => {
		const mod = await imp("index.js");
		await mod.default(pi);
	});

	flags.set("no-lsp", false);
	const startHandler = handlers.get("session_start")?.[0];
	if (!startHandler) throw new Error("no session_start handler registered");
	result.session_start = await timed(() =>
		startHandler(
			{ type: "session_start", reason: "startup" },
			makeCtx(project),
		),
	);

	// The `lsp` runner spawns a language server whose time is not pi-lens's.
	flags.set("no-lsp", true);
	const { dispatchLint } = await imp("clients/dispatch/integration.js");
	result.dispatch_small = await timed(() =>
		dispatchLint(smallFile, project, pi),
	);
	result.dispatch_large = await timed(() =>
		dispatchLint(largeFile, project, pi),
	);

	const cache = await imp("clients/lsp/workspace-diagnostics-cache.js");
	for (const [metric, count] of [
		["replay_small", REPLAY_SMALL],
		["replay_large", REPLAY_LARGE],
	]) {
		const dir = path.join(scratch, metric);
		fs.mkdirSync(dir, { recursive: true });
		const files = [];
		for (let i = 0; i < count; i++) {
			const file = path.join(dir, `f${i}.ts`);
			fs.writeFileSync(file, `export const v${i} = ${i};\n`);
			files.push(file);
		}
		const scope = cache.buildScopeKey("all");
		const writer = cache.createWorkspaceDiagnosticsCacheContext(dir);
		for (const [i, file] of files.entries()) {
			const stat = fs.statSync(file);
			// Every fourth entry carries a finding, so the expiry policy runs.
			const diagnostics =
				i % 4 === 0
					? [
							{
								severity: 2,
								message: `unused v${i}`,
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 1 },
								},
								serverId: "typescript",
							},
						]
					: [];
			writer.record(
				file,
				scope,
				diagnostics,
				stat.mtimeMs,
				undefined,
				stat.size,
			);
		}
		writer.persist();
		let served = 0;
		result[metric] = await timed(async () => {
			const reader = cache.createWorkspaceDiagnosticsCacheContext(dir);
			for (const file of files) {
				if (reader.lookup(file, scope)) served++;
			}
		});
		if (served !== count) {
			throw new Error(`${metric}: replay served ${served} of ${count} entries`);
		}
	}
	Object.assign(result, await timeEditRoundTrip(imp, handlers, project));
	result.tool_call_bash_home_overcap = await timeToolCallsAtOvercapHome(
		imp,
		handlers,
		scratch,
	);
	return result;
}

/**
 * Time one agent edit through the registered hooks, on a file the process has
 * not seen: the `tool_call` of its first read (the first touch, where the
 * per-file complexity baseline is taken, #5087), then the edit's `tool_result`
 * after the bytes change on disk. The `edit` call's own `tool_call` runs
 * between them, untimed. The row checks that a `tool_result` latency row for
 * the file reached the log, so a tree whose handler skips the edit path is a
 * harness failure, not a fast row.
 */
async function timeEditRoundTrip(imp, handlers, project) {
	const toolCall = handlers.get("tool_call")?.[0];
	const toolResult = handlers.get("tool_result")?.[0];
	if (!toolCall || !toolResult)
		throw new Error("no tool_call or tool_result handler registered");
	const file = path.join(project, "src", "edited.ts");
	const before = fs.readFileSync(file, "utf8");
	const ctx = makeCtx(project);
	const latency = await imp("clients/latency-logger.js");
	await latency.flushLatencyLog();
	const logPath = latency.getLatencyLogPath();
	const logStart = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

	const tool_call_first_touch = await timed(() =>
		toolCall(
			{
				type: "tool_call",
				toolName: "read",
				toolCallId: "hot-path-read",
				input: { path: file },
			},
			ctx,
		),
	);
	await toolResult(
		{
			type: "tool_result",
			toolName: "read",
			toolCallId: "hot-path-read",
			input: { path: file },
			content: [{ type: "text", text: before }],
		},
		ctx,
	);
	const edit = crossThreshold();
	await toolCall(
		{
			type: "tool_call",
			toolName: "edit",
			toolCallId: "hot-path-edit",
			input: { path: file, edits: [edit] },
		},
		ctx,
	);
	fs.writeFileSync(file, before.replace(edit.oldText, edit.newText));
	const tool_result_edit = await timed(() =>
		toolResult(
			{
				type: "tool_result",
				toolName: "edit",
				toolCallId: "hot-path-edit",
				input: { path: file, edits: [edit] },
				content: [{ type: "text", text: "Successfully replaced text." }],
			},
			ctx,
		),
	);
	await latency.flushLatencyLog();
	const rows = fs
		.readFileSync(logPath, "utf8")
		.slice(logStart)
		.split("\n")
		.filter(
			(line) =>
				line.includes('"type":"tool_result"') && line.includes("edited.ts"),
		).length;
	if (rows === 0) {
		throw new Error(
			"tool_result_edit: no tool_result latency row for the edit",
		);
	}
	return { tool_call_first_touch, tool_result_edit };
}

/**
 * Time {@link TOOL_CALLS} `bash` calls through the registered `tool_call`
 * handler with the session cwd set to a non-git folder of {@link OVERCAP_FILES}
 * files that is also `$HOME`. An empty `.git` file ends the walk's ignore-root
 * search at the folder and, being no repository to git, leaves it non-git;
 * `GIT_CEILING_DIRECTORIES` keeps git from finding a checkout above `--scratch`.
 */
async function timeToolCallsAtOvercapHome(imp, handlers, scratch) {
	const handler = handlers.get("tool_call")?.[0];
	if (!handler) throw new Error("no tool_call handler registered");
	const root = path.join(scratch, "overcap-home");
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, ".git"), "");
	for (let i = 0; i < OVERCAP_FILES; i++) {
		const dir = path.join(root, `dir${i % 50}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `f${i}.ts`),
			`export const v${i} = ${i};\n`,
		);
	}
	const latency = await imp("clients/latency-logger.js");
	await latency.flushLatencyLog();
	const logPath = latency.getLatencyLogPath();
	const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
	const pinned = ["HOME", "USERPROFILE", "GIT_CEILING_DIRECTORIES"].map(
		(name) => [name, process.env[name]],
	);
	process.env.HOME = root;
	process.env.USERPROFILE = root;
	process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
	let elapsed;
	try {
		elapsed = await timed(async () => {
			for (let n = 0; n < TOOL_CALLS; n++) {
				await handler(
					{
						type: "tool_call",
						toolName: "bash",
						toolCallId: `hot-path-bash-${n}`,
						input: { command: "node -e ''" },
					},
					makeCtx(root),
				);
			}
		});
	} finally {
		for (const [name, value] of pinned) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
	await latency.flushLatencyLog();
	const rows = fs
		.readFileSync(logPath, "utf8")
		.slice(before)
		.split("\n")
		.filter((line) => line.includes('"opaque_mutation_prescan"')).length;
	if (rows !== TOOL_CALLS) {
		throw new Error(
			`tool_call_bash_home_overcap: ${rows} opaque_mutation_prescan rows for ${TOOL_CALLS} calls`,
		);
	}
	return elapsed;
}

const tree = argValue("tree");
const scratch = argValue("scratch");
if (!tree || !scratch) {
	console.error("usage: hot-path-sample.mjs --tree <dir> --scratch <dir>");
	process.exit(2);
}
const home = path.join(path.resolve(scratch), "home");
fs.mkdirSync(home, { recursive: true });
Object.assign(process.env, scratchHomeEnv(home));
process.env.PILENS_DATA_DIR = home;
process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";
const result = await sample(path.resolve(tree), path.resolve(scratch));
process.stdout.write(`${JSON.stringify(result)}\n`);
// The extension leaves timers and watchers behind; this process is one sample.
process.exit(0);
