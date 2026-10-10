/**
 * pi-lens-analyze bin — the push-half engine (PostToolUse hook + CLI). Spawns
 * the in-place-compiled bin and asserts its CLI, --hook envelope, clean-file
 * silence, the Claude Code PostToolUse stdin path, and the Stop-hook turn-end
 * mode against a stub warm server. Requires `npm run build`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	ipcPathForCwd,
	readTurnEndStatus,
	turnEndStatusPathForCwd,
	WARM_TURN_END_SCHEMA_VERSION,
} from "../../clients/mcp/ipc.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { AUTOMATION_FRAMING } from "../../clients/runtime-context.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const binJs = path.join(repoRoot, "mcp", "analyze-cli.js");
const testIsolationDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "pi-lens-cli-isolation-"),
);

const SMELLY = `export function f(x) {
\tif (x) { if (x.a) { if (x.b) { if (x.c) { return 1; } } } }
\tconsole.log("debug");
}
`;

function runBin(
	args: string[],
	stdin?: string,
	nodeArgs: string[] = [],
	home = path.join(testIsolationDir, "home"),
	cwd?: string,
	entry = binJs,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...nodeArgs, entry, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd,
			env: {
				...process.env,
				HOME: home,
				PILENS_DATA_DIR: path.join(testIsolationDir, "data"),
				PI_LENS_HOME: home,
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c: string) => (stdout += c));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c: string) => (stderr += c));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code: code ?? 0 });
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("timeout"));
		}, 40_000);
		timer.unref();
		if (stdin !== undefined) child.stdin.end(stdin);
		else child.stdin.end();
	});
}

/**
 * #1271 harness: the same spawn WITHOUT `child.stdin.end()`. Every other test
 * here closes stdin, which is exactly why none of them could catch a bin that
 * blocks on an open pipe — the real spawners (CI wrappers, `sh -c`, pre-commit
 * runners, Claude Code itself with `stdio: 'pipe'`) do not necessarily close
 * it. Resolves the elapsed ms so the assertion is "it exited", not "the outer
 * harness gave up".
 */
function runBinWithOpenStdin(
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; elapsedMs: number; code: number }> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const child = spawn(process.execPath, [binJs, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PILENS_DATA_DIR: path.join(testIsolationDir, "data"),
				PI_LENS_HOME: path.join(testIsolationDir, "home"),
			},
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c: string) => (stdout += c));
		child.stderr.resume();
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, elapsedMs: Date.now() - startedAt, code: code ?? 0 });
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`bin did not exit within ${timeoutMs}ms with stdin left open (#1271)`,
				),
			);
		}, timeoutMs);
		// Deliberately NO child.stdin.end() — the pipe stays open and idle.
	});
}

// #2420: a file whose only finding is the hint-tier `no-any-type` rule. Before
// #2420 this rendered "0 blocking, 1 warning(s)" — a style opinion folded into
// the model-facing warning count via the dispatch semantic axis.
const HINT_ONLY =
	"// biome-ignore lint/suspicious/noExplicitAny: exercise the hint-tier rule\nexport const y: any = 1;\n";

let tmpDir: string;
let smellyFile: string;
let cleanFile: string;
let hintFile: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cli-"));
	smellyFile = path.join(tmpDir, "smelly.ts");
	cleanFile = path.join(tmpDir, "clean.ts");
	hintFile = path.join(tmpDir, "hinty.ts");
	fs.writeFileSync(smellyFile, SMELLY);
	fs.writeFileSync(cleanFile, "export const x = 1;\n");
	fs.writeFileSync(hintFile, HINT_ONLY);
});

afterAll(() => {
	removeTempDirSync(tmpDir);
	removeTempDirSync(testIsolationDir);
});

// Spawns a real node subprocess that loads the engine (tree-sitter/native) and
// runs analysis. In the full 200+-file parallel suite this occasionally loses a
// CPU-starvation race and the child crashes at startup (non-zero exit / no
// output) — it passes every time in isolation. retry: 2 absorbs the transient
// contention spike (the established pattern for load-sensitive tests here).
describe("pi-lens-analyze bin", { retry: 2 }, () => {
	it("reports structural warnings in plain CLI mode", async () => {
		const { stdout, code } = await runBin([
			`--file=${smellyFile}`,
			`--cwd=${tmpDir}`,
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("pi-lens:");
		expect(stdout).toMatch(/deep-nesting|console-statement/);
	}, 45_000);

	// #2420: a hint-only file must report 0 warnings and its findings under the
	// `advisory(ies)` label, never folded into the warning count.
	it("reports hint-tier findings as advisories, not warnings, in the CLI header", async () => {
		const { stdout, code } = await runBin([
			`--file=${hintFile}`,
			`--cwd=${tmpDir}`,
		]);
		expect(code).toBe(0);
		const header = stdout.split("\n")[0];
		// The only findings are hint-tier: zero warnings, at least one advisory.
		expect(header).toMatch(/0 warning\(s\)/);
		expect(header).toMatch(/[1-9]\d* advisory\(ies\)/);
		expect(header).toMatch(/0 blocking/);
	}, 45_000);

	it("emits a PostToolUse JSON envelope with --hook", async () => {
		const { stdout } = await runBin([
			`--file=${smellyFile}`,
			`--cwd=${tmpDir}`,
			"--hook",
		]);
		const parsed = JSON.parse(stdout) as {
			hookSpecificOutput?: {
				hookEventName?: string;
				additionalContext?: string;
			};
		};
		expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
		expect(parsed.hookSpecificOutput?.additionalContext).toContain("pi-lens:");
	}, 45_000);

	it("stays silent (no output) on a clean file", async () => {
		const { stdout, code } = await runBin([
			`--file=${cleanFile}`,
			`--cwd=${tmpDir}`,
		]);
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
	}, 45_000);

	// #1271: `main()` used to await the stdin read BEFORE looking at `--file`,
	// with no timeout and only an `isTTY` guard — so any spawner holding the pipe
	// open hung the bin forever. As a Stop hook that is a 60 s stall every turn.
	it("exits with --file even when stdin is a pipe that is never closed", async () => {
		const { code, elapsedMs } = await runBinWithOpenStdin(
			[`--file=${cleanFile}`, `--cwd=${tmpDir}`],
			30_000,
		);
		expect(code).toBe(0);
		expect(elapsedMs).toBeLessThan(30_000);
	}, 45_000);

	// The companion: `--turn-end` must not read stdin either. No warm server, so
	// the pass skips immediately — the only thing that could delay this exit is
	// the stdin read the flag is supposed to short-circuit.
	it("exits with --turn-end even when stdin is a pipe that is never closed", async () => {
		const turnDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cli-open-"));
		try {
			const { code, elapsedMs } = await runBinWithOpenStdin(
				["--turn-end", `--cwd=${turnDir}`],
				30_000,
			);
			expect(code).toBe(0);
			expect(elapsedMs).toBeLessThan(30_000);
		} finally {
			try {
				fs.rmSync(turnEndStatusPathForCwd(turnDir), { force: true });
			} catch {
				/* best effort */
			}
			removeTempDirSync(turnDir);
		}
	}, 45_000);

	it("analyzes the file from a Claude Code PostToolUse stdin payload", async () => {
		const payload = JSON.stringify({
			tool_input: { path: smellyFile },
			cwd: tmpDir,
		});
		const { stdout } = await runBin([], payload);
		expect(stdout).toContain("pi-lens:");
		expect(stdout).toMatch(/deep-nesting|console-statement/);
	}, 45_000);
});

/** The `metadata.runners[].id` set of the last `dispatch_complete` record per file in a latency sink. */
function readDispatchRunnerIds(logPath: string): Map<string, string[]> {
	const byFile = new Map<string, string[]>();
	if (!fs.existsSync(logPath)) return byFile;
	for (const line of fs.readFileSync(logPath, "utf8").trim().split("\n")) {
		if (!line) continue;
		let row: {
			type?: string;
			result?: string;
			filePath?: string;
			metadata?: { runners?: { id?: unknown }[] };
		};
		try {
			row = JSON.parse(line) as typeof row;
		} catch {
			continue;
		}
		if (row.type !== "tool_result" || row.result !== "dispatch_complete") {
			continue;
		}
		if (!row.filePath) continue;
		byFile.set(
			row.filePath,
			(row.metadata?.runners ?? []).map((runner) => String(runner.id)),
		);
	}
	return byFile;
}

interface AnalyzeFailureRecord {
	metadata: { cwd: string; operation: string; reason: string };
}

/** The last `analyze-cli-failed` extension-log record written under `home`. */
function readFailureRecord(home: string): AnalyzeFailureRecord | undefined {
	const logPath = path.join(home, "extension.log");
	if (!fs.existsSync(logPath)) return undefined;
	let last: AnalyzeFailureRecord | undefined;
	for (const line of fs.readFileSync(logPath, "utf8").trim().split("\n")) {
		if (!line) continue;
		try {
			const row = JSON.parse(line) as {
				message?: string;
				metadata?: { cwd?: string; operation?: string; reason?: string };
			};
			if (
				row.message === "analyze-cli-failed" &&
				typeof row.metadata?.cwd === "string" &&
				typeof row.metadata.reason === "string" &&
				typeof row.metadata.operation === "string"
			) {
				last = {
					metadata: {
						cwd: row.metadata.cwd,
						operation: row.metadata.operation,
						reason: row.metadata.reason,
					},
				};
			}
		} catch {
			/* not a record */
		}
	}
	return last;
}

/**
 * #3961 — deterministic witnesses for the #3935 added-line mutation survivors,
 * driven through the real built bin (`node mcp/analyze-cli.js`). Each case
 * asserts an independent effect of the real cold analyzer — the rendered
 * header, the `analyze-cli-failed` record, the dispatch latency sink, or the
 * durable `turn-state.json` — never a captured options object and never an
 * in-process library/store double. Only true external boundaries are faked
 * (the stdin stream here).
 */
describe("pi-lens-analyze cold-path witnesses", { retry: 2 }, () => {
	let coldDir: string;
	// Every cwd a case hands to the bin, so the describe can remove exactly the
	// `turnEndStatusPathForCwd` artifacts those cases own (#3961 F3). `coldDir`
	// plus the two argv cwds the failure/fallback cases create; no glob, no
	// foreign deletion.
	const ownedCwds = new Set<string>();

	const ownCwd = (cwd: string): string => {
		ownedCwds.add(cwd);
		return cwd;
	};

	beforeEach(() => {
		coldDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cli-cold-"));
		ownedCwds.add(coldDir);
	});

	afterEach(() => {
		for (const cwd of ownedCwds) {
			try {
				fs.rmSync(turnEndStatusPathForCwd(cwd), { force: true });
			} catch {
				/* best effort, same as the turn-end describe's own cleanup */
			}
		}
		ownedCwds.clear();
		vi.unstubAllEnvs();
		removeTempDirSync(coldDir);
	});

	const writeFindingFile = (name: string): string => {
		const file = path.join(coldDir, name);
		fs.writeFileSync(file, SMELLY);
		return file;
	};

	// ids 21 and 33: with no `--cwd` and no stdin payload, cwd falls back to
	// process.cwd() through the optional chain — it must not crash or be lost.
	it("renders the report relative to the child cwd when --cwd is omitted", async () => {
		const file = writeFindingFile("smelly.ts");
		const { stdout, code } = await runBin(
			[`--file=${file}`],
			undefined,
			[],
			undefined,
			coldDir,
		);
		expect(code).toBe(0);
		expect(stdout.split("\n")[0]).toContain("🔎 pi-lens: smelly.ts ");
	}, 45_000);

	// ids 21 and 22: a stdin read failure must record the `--cwd` argv value,
	// not the child's process.cwd().
	it("records the --cwd value when the stdin read fails", async () => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		const argvCwd = ownCwd(path.join(coldDir, "argv-cwd"));
		const childCwd = path.join(coldDir, "child-cwd");
		fs.mkdirSync(argvCwd);
		fs.mkdirSync(childCwd);
		const home = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cli-stdin-home-"),
		);
		const preload = new URL(
			"../fixtures/mcp/analyze-cli-stdin-error.mjs",
			import.meta.url,
		);
		try {
			const { code } = await runBin(
				[`--cwd=${argvCwd}`],
				undefined,
				["--import", preload.href],
				home,
				childCwd,
			);
			expect(code).toBe(2);
			const record = readFailureRecord(home);
			expect(record?.metadata.cwd).toBe(argvCwd);
			expect(record?.metadata.operation).toBe("analyze");
			expect(readTurnEndStatus(argvCwd)?.failed).toBe(1);
			expect(readTurnEndStatus(argvCwd)?.lastFailureReason).toContain(
				"stdin probe boom",
			);
		} finally {
			removeTempDirSync(home);
		}
	}, 30_000);

	// id 32: the argv `--cwd` wins over a stdin payload's cwd; the report must be
	// relative to the argv cwd.
	it("prefers the argv --cwd over the stdin payload cwd", async () => {
		const argvCwd = ownCwd(path.join(coldDir, "argv"));
		const payloadCwd = path.join(coldDir, "payload");
		fs.mkdirSync(argvCwd);
		fs.mkdirSync(payloadCwd);
		const file = path.join(argvCwd, "smelly.ts");
		fs.writeFileSync(file, SMELLY);
		const payload = JSON.stringify({
			cwd: payloadCwd,
			tool_input: { path: file },
		});
		const { stdout, code } = await runBin([`--cwd=${argvCwd}`], payload);
		expect(code).toBe(0);
		expect(stdout.split("\n")[0]).toContain("🔎 pi-lens: smelly.ts ");
	}, 45_000);

	// ids 58 and 59: no file, no --turn-end, and empty stdin is a silent no-op.
	it("exits silently with no file, no --turn-end, and empty stdin", async () => {
		const { stdout, stderr, code } = await runBin(
			[],
			"",
			[],
			undefined,
			coldDir,
		);
		expect(code).toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toBe("");
		expect(readTurnEndStatus(coldDir)).toBeUndefined();
	}, 20_000);

	// ids 64, 65, and 66: the fast default must not schedule the lsp runner; an
	// explicit `--lsp` must. The witness is the real dispatch latency sink, not a
	// captured options object, so it holds whether or not a language server is
	// installed (a skipped lsp runner still records its row).
	it("defaults to the no-lsp path and schedules lsp only with --lsp", async () => {
		vi.stubEnv("PI_LENS_DISABLE_LSP_INSTALL", "1");
		vi.stubEnv("PI_LENS_DISABLE_TOOL_INSTALL", "1");
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cli-latency-"));
		const plainFile = writeFindingFile("plain.ts");
		const lspFile = writeFindingFile("lsp.ts");
		try {
			const plain = await runBin(
				[`--file=${plainFile}`, `--cwd=${coldDir}`],
				undefined,
				[],
				home,
			);
			expect(plain.code).toBe(0);
			const lsp = await runBin(
				[`--file=${lspFile}`, `--cwd=${coldDir}`, "--lsp"],
				undefined,
				[],
				home,
			);
			expect(lsp.code).toBe(0);
			const runnersByFile = readDispatchRunnerIds(
				path.join(home, "latency.log"),
			);
			// The plain run must have dispatched at all, so "no lsp" is meaningful.
			expect(runnersByFile.get(plainFile)).toBeDefined();
			expect(runnersByFile.get(plainFile) ?? []).not.toContain("lsp");
			expect(runnersByFile.get(lspFile) ?? []).toContain("lsp");
		} finally {
			removeTempDirSync(home);
		}
	}, 60_000);

	// ids 64 and 68: a cold one-shot analyze registers the edited file in the
	// durable turn-state so a later Stop can pick it up.
	it("writes turn-state.json for a cold one-shot analyze", async () => {
		const file = writeFindingFile("smelly.ts");
		const { code } = await runBin([`--file=${file}`, `--cwd=${coldDir}`]);
		expect(code).toBe(0);
		vi.stubEnv("PILENS_DATA_DIR", path.join(testIsolationDir, "data"));
		const turnStatePath = path.join(
			getProjectDataDir(coldDir),
			"turn-state.json",
		);
		expect(fs.existsSync(turnStatePath)).toBe(true);
		const state = JSON.parse(fs.readFileSync(turnStatePath, "utf8")) as {
			files?: Record<string, unknown>;
		};
		expect(Object.keys(state.files ?? {})).toContain("smelly.ts");
	}, 30_000);

	// id 74: every whitespace run in a failure reason collapses to one space.
	it("collapses whitespace runs in a failure reason", async () => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cli-ws-home-"));
		const preload = new URL(
			"../fixtures/mcp/analyze-cli-failure.mjs",
			import.meta.url,
		);
		preload.searchParams.set("message", "p   q\t\n\tz");
		const file = writeFindingFile("smelly.ts");
		try {
			const { stderr, code } = await runBin(
				[`--cwd=${coldDir}`, `--file=${file}`],
				undefined,
				["--import", preload.href],
				home,
			);
			expect(code).toBe(2);
			expect(stderr.trim()).toBe("pi-lens-analyze failed: p q z");
			expect(readFailureRecord(home)?.metadata.reason).toBe("p q z");
			expect(readTurnEndStatus(coldDir)?.lastFailureReason).toBe("p q z");
		} finally {
			removeTempDirSync(home);
		}
	}, 20_000);

	// id 79: the 1000-code-unit cap is strict — exactly 1000 stays whole, 1001
	// truncates.
	it("keeps exactly 1000 code units and truncates 1001", async () => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		for (const [length, truncated] of [
			[1000, false],
			[1001, true],
		] as const) {
			const home = fs.mkdtempSync(
				path.join(os.tmpdir(), `pi-lens-cli-cap-${length}-`),
			);
			const preload = new URL(
				"../fixtures/mcp/analyze-cli-failure.mjs",
				import.meta.url,
			);
			preload.searchParams.set("message", "x".repeat(length));
			const file = writeFindingFile(`cap-${length}.ts`);
			try {
				const { stderr, code } = await runBin(
					[`--cwd=${coldDir}`, `--file=${file}`],
					undefined,
					["--import", preload.href],
					home,
				);
				expect(code).toBe(2);
				const reason = readFailureRecord(home)?.metadata.reason ?? "";
				expect(reason.length).toBe(truncated ? 1013 : 1000);
				expect(reason.includes("… (truncated)")).toBe(truncated);
				expect(stderr.trim()).toBe(`pi-lens-analyze failed: ${reason}`);
			} finally {
				removeTempDirSync(home);
			}
		}
	}, 30_000);
});

interface TurnEndStub {
	sockets: net.Socket[];
	requests: unknown[];
	close: () => Promise<void>;
}

function startTurnEndStub(
	cwd: string,
	response: Record<string, unknown>,
): Promise<TurnEndStub> {
	const endpoint = ipcPathForCwd(cwd);
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(endpoint);
		} catch {
			/* none */
		}
	}
	const sockets: net.Socket[] = [];
	const requests: unknown[] = [];
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.setEncoding("utf8");
		let replied = false;
		socket.on("data", (chunk: string) => {
			const message = JSON.parse(chunk.trim()) as { ack?: boolean };
			if (!replied) {
				replied = true;
				requests.push(message);
				socket.write(`${JSON.stringify({ result: response })}\n`);
				return;
			}
			if (message.ack === true) socket.end('{"ack":true}\n');
		});
	});
	return new Promise((resolve) =>
		server.listen(endpoint, () =>
			resolve({
				sockets,
				requests,
				close: () =>
					new Promise<void>((done) => {
						(
							server as net.Server & { closeAllConnections?: () => void }
						).closeAllConnections?.();
						server.close(() => done());
					}),
			}),
		),
	);
}

function startWarmAnalyzeStub(
	cwd: string,
	response: Record<string, unknown>,
): Promise<TurnEndStub> {
	const endpoint = ipcPathForCwd(cwd);
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(endpoint);
		} catch {
			/* none */
		}
	}
	const sockets: net.Socket[] = [];
	const requests: unknown[] = [];
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.setEncoding("utf8");
		let replied = false;
		socket.on("data", (chunk: string) => {
			if (replied) return;
			replied = true;
			requests.push(JSON.parse(chunk.trim()));
			socket.end(`${JSON.stringify({ result: response })}\n`);
		});
	});
	return new Promise((resolve) =>
		server.listen(endpoint, () =>
			resolve({
				sockets,
				requests,
				close: () =>
					new Promise<void>((done) => {
						(
							server as net.Server & { closeAllConnections?: () => void }
						).closeAllConnections?.();
						server.close(() => done());
					}),
			}),
		),
	);
}

// Built from the producer's real constant so a wording change in
// runtime-context.ts cannot silently diverge from what the bin strips.
const FRAMED_ADVISORY = `${AUTOMATION_FRAMING}Address 🔴 blockers before continuing; ℹ️ advisories are informational only.

🔴 knip: 2 unused exports in clients/thing.ts`;

describe("pi-lens-analyze turn-end mode", { retry: 2 }, () => {
	let turnDir: string;
	let stub: TurnEndStub | undefined;

	beforeEach(() => {
		turnDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cli-turn-"));
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await stub?.close();
		stub = undefined;
		try {
			fs.rmSync(turnEndStatusPathForCwd(turnDir), { force: true });
		} catch {
			/* best effort */
		}
		removeTempDirSync(turnDir);
	});

	// #3922: exercise the real bin, failing only the external peer or IPC boundary.
	it.each([
		{ name: "plain CLI", args: "file", event: undefined, code: 2, json: false },
		{
			name: "explicit hook",
			args: "hook",
			event: undefined,
			code: 0,
			json: true,
		},
		{
			name: "PostToolUse stdin",
			args: "stdin",
			event: "PostToolUse",
			code: 0,
			json: false,
		},
		{
			name: "legacy stdin",
			args: "stdin",
			event: undefined,
			code: 0,
			json: false,
		},
		{
			name: "Stop flag",
			args: "turn-end",
			event: undefined,
			code: 0,
			json: false,
		},
		{
			name: "Stop flag with --hook",
			args: "turn-end-hook",
			event: undefined,
			code: 0,
			json: false,
		},
		{ name: "Stop stdin", args: "stdin", event: "Stop", code: 0, json: false },
		{
			name: "PostToolUse stdin with --hook",
			args: "stdin",
			event: "PostToolUse",
			code: 0,
			json: true,
			hook: true,
		},
		{
			name: "Stop stdin with --hook",
			args: "stdin",
			event: "Stop",
			code: 0,
			json: false,
			hook: true,
		},
	])(
		"reports an unrunnable $name without claiming a clean scan",
		async ({ args, event, code, json, hook }) => {
			const turnEnd = args.startsWith("turn-end") || event === "Stop";
			const file = path.join(turnDir, "sample.js");
			fs.writeFileSync(file, "const unused = 1;\n");
			const preload = new URL(
				"../fixtures/mcp/analyze-cli-failure.mjs",
				import.meta.url,
			);
			if (turnEnd) preload.searchParams.set("target", "ipc");
			const argv = [
				...(args === "stdin"
					? []
					: [
							`--cwd=${turnDir}`,
							...(turnEnd ? ["--turn-end"] : [`--file=${file}`]),
						]),
				...(hook || json || args === "turn-end-hook" ? ["--hook"] : []),
			];
			const payload = JSON.stringify({
				cwd: turnDir,
				hook_event_name: event,
				tool_input: { file_path: file },
			});
			const result = await runBin(argv, payload, ["--import", preload.href]);
			expect(result.stderr).toContain(
				"Cannot find package '@earendil-works/pi-tui'",
			);
			const report = json
				? (
						JSON.parse(result.stdout) as {
							hookSpecificOutput: {
								hookEventName: string;
								additionalContext: string;
							};
						}
					).hookSpecificOutput
				: undefined;
			if (json) expect(report?.hookEventName).toBe("PostToolUse");
			expect(report?.additionalContext ?? result.stdout).toMatch(
				/^pi-lens-analyze failed:/,
			);
			expect(result.code).toBe(code);
			expect(readTurnEndStatus(turnDir)).toMatchObject({
				ran: 0,
				skipped: 0,
				failed: 1,
				lastFailureOperation: turnEnd ? "turn-end" : "analyze",
				lastFailureReason: expect.stringContaining("@earendil-works/pi-tui"),
				lastFailureAt: expect.any(String),
			});
		},
		20_000,
	);

	// #3922: a later Stop must not erase failures from the separate hook process.
	it("keeps repeated failures through Stop writes and reports them through health", async () => {
		const preload = new URL(
			"../fixtures/mcp/analyze-cli-failure.mjs",
			import.meta.url,
		);
		const args = [`--cwd=${turnDir}`, `--file=${cleanFile}`];
		await runBin(args, undefined, ["--import", preload.href]);
		await runBin(args, undefined, ["--import", preload.href]);
		await runBin(["--turn-end", `--cwd=${turnDir}`]);
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
		});
		await runBin(["--turn-end", `--cwd=${turnDir}`]);
		await stub.close();
		stub = undefined;
		expect(readTurnEndStatus(turnDir)).toMatchObject({
			ran: 1,
			skipped: 1,
			failed: 2,
		});

		const harness = new McpHarness({
			cwd: turnDir,
			env: { HOME: path.join(testIsolationDir, "home") },
		});
		try {
			const response = await harness.request(3922, "tools/call", {
				name: "pilens_health",
				arguments: {},
			});
			const text = (response.result as { content: { text: string }[] })
				.content[0].text;
			expect(text).toContain(
				"Analyzer invocations: 2 failed; last analyze failure at",
			);
			expect(text).toContain("@earendil-works/pi-tui");
			const json = JSON.parse(
				text.match(/```json\n([\s\S]*)\n```/)?.[1] ?? "{}",
			);
			expect(json.turnEnd).toMatchObject({
				ran: 1,
				skipped: 1,
				failed: 2,
				lastFailureOperation: "analyze",
			});
		} finally {
			harness.dispose();
		}
	}, 30_000);

	// #3922: surfaced exception text must be bounded, redacted, and one line.
	it("redacts and bounds failures before stdout, stderr, and persistence", async () => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		const secret = `ghp_${"a".repeat(36)}`;
		const preload = new URL(
			"../fixtures/mcp/analyze-cli-failure.mjs",
			import.meta.url,
		);
		preload.searchParams.set(
			"message",
			`failed\u001b[31m ${secret}\u001b[0m\n\t${"x".repeat(1500)}`,
		);
		const result = await runBin(
			[`--cwd=${turnDir}`, `--file=${cleanFile}`],
			undefined,
			["--import", preload.href],
		);
		expect(result.code).toBe(2);
		const records = fs
			.readFileSync(
				path.join(testIsolationDir, "home", "extension.log"),
				"utf8",
			)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter(
				(row) =>
					row.subsystem === "analyze-cli" && row.metadata?.cwd === turnDir,
			);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			message: "analyze-cli-failed",
			metadata: { cwd: turnDir, operation: "analyze" },
		});
		for (const text of [
			result.stdout,
			result.stderr,
			records[0].metadata.reason,
			readTurnEndStatus(turnDir)?.lastFailureReason ?? "",
		]) {
			expect(text).toContain("[REDACTED:github-token]");
			expect(text).not.toContain(secret);
			expect(text).not.toContain("\u001b");
			expect(text).not.toContain("\t");
			expect(text.trimEnd().split("\n")).toHaveLength(1);
			expect(text).toContain("… (truncated)");
			expect(text.length).toBeLessThan(1100);
		}
	}, 20_000);

	it("reports non-Error failures and survives an unwritable status destination", async () => {
		const statusPath = turnEndStatusPathForCwd(turnDir);
		fs.mkdirSync(statusPath);
		try {
			const preload = new URL(
				"../fixtures/mcp/analyze-cli-failure.mjs",
				import.meta.url,
			);
			preload.searchParams.set("nonError", "true");
			const result = await runBin(
				["--hook", `--cwd=${turnDir}`, `--file=${cleanFile}`],
				undefined,
				["--import", preload.href],
			);
			expect(result.code).toBe(0);
			expect(
				JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
			).toBe(
				"pi-lens-analyze failed: Cannot find package '@earendil-works/pi-tui'",
			);
			expect(result.stderr).toContain(
				"Cannot find package '@earendil-works/pi-tui'",
			);
			expect(readTurnEndStatus(turnDir)).toBeUndefined();
		} finally {
			fs.rmdirSync(statusPath);
		}
	}, 20_000);

	it("keeps hook failures visible when extension.log cannot be written", async () => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		const home = path.join(turnDir, "log-home");
		const logPath = path.join(home, "extension.log");
		fs.mkdirSync(logPath, { recursive: true });
		const preload = new URL(
			"../fixtures/mcp/analyze-cli-failure.mjs",
			import.meta.url,
		);
		const result = await runBin(
			["--hook", `--cwd=${turnDir}`, `--file=${cleanFile}`],
			undefined,
			["--import", preload.href],
			home,
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).hookSpecificOutput).toEqual({
			hookEventName: "PostToolUse",
			additionalContext:
				"pi-lens-analyze failed: Cannot find package '@earendil-works/pi-tui'",
		});
		expect(result.stderr).toContain("@earendil-works/pi-tui");
		expect(readTurnEndStatus(turnDir)).toMatchObject({ failed: 1 });
		expect(fs.statSync(logPath).isDirectory()).toBe(true);
	}, 20_000);

	it("renders the warm server's report without the injection framing", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			turnEnd: FRAMED_ADVISORY,
		});
		const { stdout, code } = await runBin(["--turn-end", `--cwd=${turnDir}`]);

		expect(code).toBe(0);
		expect(stdout).toContain("🔎 pi-lens turn-end");
		expect(stdout).toContain("🔴 knip: 2 unused exports");
		expect(stdout).toContain("Address 🔴 blockers before continuing");
		expect(stdout).not.toContain("not a user request");
		expect(stub.requests[0]).toEqual({
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd: turnDir,
		});
	}, 20_000);

	it("describes deferred LSP diagnostics as deferred in the warm analyze report", async () => {
		const file = path.join(turnDir, "deferred.ts");
		fs.writeFileSync(file, "export const value = 1;\n");
		stub = await startTurnEndStub(turnDir, {
			filePath: file,
			counts: { blockers: 0, warnings: 0, advisories: 0 },
			diagnostics: [],
			lsp: { status: "deferred", diagnosticCount: 0, durationMs: 1 },
		});
		const { stdout, code } = await runBin([
			`--file=${file}`,
			`--cwd=${turnDir}`,
		]);

		expect(code).toBe(0);
		expect(stdout).toContain("LSP diagnostics were skipped or deferred");
		expect(stdout).not.toContain("LSP type-check skipped");
	}, 20_000);

	it("stays silent when the warm pass found nothing", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
		});
		const { stdout, code } = await runBin(["--turn-end", `--cwd=${turnDir}`]);

		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
		// Silence must mean "clean turn", not "never dialed" or "reply rejected".
		expect(stub.requests).toHaveLength(1);
	}, 20_000);

	// No cold fallback: a cold pass has empty cascade runs and accumulators, so a
	// skip is honest where a local run would report a false clean. But #1272: the
	// skip used to be stderr-ONLY, and Claude Code never surfaces stderr from a
	// hook that exits 0 — so a permanently dead integration was byte-for-byte
	// identical to a clean turn. The skip must reach stdout, the hook's only
	// transcript-visible channel.
	it("announces a skip on stdout when no warm server is listening", async () => {
		const { stdout, stderr, code } = await runBin([
			"--turn-end",
			`--cwd=${turnDir}`,
		]);

		expect(code).toBe(0);
		expect(stdout).toContain("pi-lens turn-end skipped");
		expect(stderr).toContain("turn-end skipped");
		// One line — an absent server is a footnote, not a wall of text.
		expect(stdout.trimEnd().split("\n")).toHaveLength(1);
	}, 20_000);

	// #1272: the message used to say "no warm pi-lens MCP server" for EVERY
	// failure mode, including the ones where the server was warm and answering.
	// Absent server / slow pass / schema skew have different remedies, so the
	// wire reason must reach the transcript.
	it("names the reason a skip happened", async () => {
		// #3255 H1: "nothing is listening" is now its OWN reason, split out of
		// `ipc-error` the same way #1272 split schema skew out of it. After the
		// case-fold narrowing this is also what an upgrade-stranded server looks
		// like from a fresh hook, so the remedy line has to name the restart.
		const noServer = await runBin(["--turn-end", `--cwd=${turnDir}`]);
		expect(noServer.stdout).toContain("(no-listener)");
		expect(noServer.stdout).toMatch(/restart it|start the MCP server/);
		expect(noServer.stdout).toContain("upgraded");

		// A server that answers with the WRONG schema version: warm, reachable,
		// and still unusable — the pre-fix message called this an absent server.
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION + 1,
		});
		const skewed = await runBin(["--turn-end", `--cwd=${turnDir}`]);
		expect(skewed.stdout).toContain("(schema-mismatch)");
		expect(skewed.stdout).toContain("different turn-end schema");
		expect(skewed.stdout).not.toContain("no warm pi-lens MCP server answered");
	}, 25_000);

	// #1272, the #544 precedent: the hook is a separate short-lived process, so
	// without a recorded surface `pilens_health` had no way to report that
	// turn-end had been dead all session.
	it("records the skip and the run for pilens_health to report", async () => {
		await runBin(["--turn-end", `--cwd=${turnDir}`]);
		const afterSkip = readTurnEndStatus(turnDir);
		expect(afterSkip?.skipped).toBe(1);
		expect(afterSkip?.ran).toBe(0);
		// #3255 H1: this field IS the `pilens_health` surface for a hook-process
		// skip (rendered as "last skip: …"), so the discriminating reason has to
		// land here and not just on stdout.
		expect(afterSkip?.lastSkipReason).toBe("no-listener");
		expect(afterSkip?.lastSkipAt).toBeTypeOf("string");

		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
		});
		await runBin(["--turn-end", `--cwd=${turnDir}`]);
		const afterRun = readTurnEndStatus(turnDir);
		expect(afterRun?.ran).toBe(1);
		expect(afterRun?.skipped).toBe(1);
		expect(afterRun?.lastRunAt).toBeTypeOf("string");
	}, 25_000);

	it("detects a Stop payload on stdin without the flag", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			tests: `${AUTOMATION_FRAMING}Test failures detected last turn — fix before continuing:\n\nsuite/thing.test.ts > it works`,
		});
		const { stdout, code } = await runBin(
			[],
			JSON.stringify({ cwd: turnDir, hook_event_name: "Stop" }),
		);

		expect(code).toBe(0);
		expect(stdout).toContain("🔎 pi-lens turn-end");
		expect(stdout).toContain("suite/thing.test.ts > it works");
		expect(stdout).not.toContain("not a user request");
	}, 20_000);

	// `turnEnd` arrives server-capped at 20 lines, but `tests` does not — a vitest
	// failure dump (runtime-turn.ts) is unbounded, and this render lands straight
	// in the Claude Code transcript. Two independent guards, so two inputs: this
	// one trips ONLY the line cap (81 lines, well under 2000 chars), which a
	// combined over-long payload would hide behind the character cap.
	it("caps a long report at 40 lines", async () => {
		const manyLines = `Test failures detected last turn:\n${Array.from(
			{ length: 80 },
			(_, i) => `  FAIL suite/case-${i}`,
		).join("\n")}`;
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			tests: manyLines,
		});
		const { stdout, code } = await runBin(["--turn-end", `--cwd=${turnDir}`]);

		expect(code).toBe(0);
		const lines = stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(41); // 40 kept + the truncation marker
		expect(lines.at(-1)).toContain("… (truncated)");
		expect(stdout).toContain("  FAIL suite/case-0");
		expect(stdout).not.toContain("  FAIL suite/case-79");
	}, 20_000);

	// The companion guard: 11 lines, so the line cap never fires, and only the
	// 2000-character ceiling stands between a wide dump and the transcript.
	it("caps a long report at 2000 characters", async () => {
		const wideLines = `Test failures detected last turn:\n${Array.from(
			{ length: 10 },
			(_, i) => `  FAIL suite/case-${i}: ${"detail ".repeat(45)}`,
		).join("\n")}`;
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			tests: wideLines,
		});
		const { stdout, code } = await runBin(["--turn-end", `--cwd=${turnDir}`]);

		const out = stdout.trimEnd();
		expect(code).toBe(0);
		expect(out.split("\n").length).toBeLessThanOrEqual(40);
		expect(out).toContain("… (truncated)");
		// 2000 kept + the "\n  … (truncated)" marker.
		expect(out).toHaveLength(2016);
	}, 20_000);

	// #1275: `slice` counts UTF-16 code units. Findings are dense with emoji, and
	// a cut that lands between the halves of a surrogate pair is written to the
	// pipe as U+FFFD — a replacement character in the transcript where a marker
	// should be. The payload below is sized so the 2000-char cut falls exactly
	// inside the 🔴.
	it("never splits a surrogate pair at the character cap", async () => {
		const header = "🔎 pi-lens turn-end\n";
		const pad = "x".repeat(2000 - header.length - 1);
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			tests: `${pad}🔴 knip: unused export`,
		});
		const { stdout, code } = await runBin(["--turn-end", `--cwd=${turnDir}`]);

		expect(code).toBe(0);
		expect(stdout).not.toContain("�");
		// Backed off by one unit rather than cutting the pair.
		expect(stdout.trimEnd()).toHaveLength(1999 + "\n  … (truncated)".length);
	}, 20_000);

	// #1275: the `tests` section is the RAW vitest dump, which carries SGR colour
	// codes; nothing stripped them, and the character cap could slice an escape
	// sequence in half and leak its tail as literal text.
	it("strips ANSI escapes and control characters from the report", async () => {
		const esc = String.fromCharCode(0x1b);
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			tests: `${esc}[31mFAIL${esc}[0m suite/thing.test.ts${esc}[2K\u0007\u0000 done`,
		});
		const { stdout, code } = await runBin(["--turn-end", `--cwd=${turnDir}`]);

		expect(code).toBe(0);
		expect(stdout).not.toContain(esc);
		expect(stdout).not.toContain("[31m");
		expect(stdout).not.toContain("[2K");
		expect(stdout).toContain("FAIL suite/thing.test.ts");
	}, 20_000);

	// #1275: the framing strip was `startsWith`-only, so a token carried into the
	// middle of a joined section survived into the transcript.
	it("strips injection framing that is not at the start of a section", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			turnEnd: `🔴 knip: 2 unused exports\n\n${AUTOMATION_FRAMING}🔴 madge: a cycle`,
		});
		const { stdout, code } = await runBin(["--turn-end", `--cwd=${turnDir}`]);

		expect(code).toBe(0);
		expect(stdout).toContain("🔴 madge: a cycle");
		expect(stdout).not.toContain("not a user request");
	}, 20_000);

	it("never dials the server on SubagentStop", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			turnEnd: FRAMED_ADVISORY,
		});
		const { stdout, stderr, code } = await runBin(
			[],
			JSON.stringify({ cwd: turnDir, hook_event_name: "SubagentStop" }),
		);

		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
		expect(stderr).toContain("SubagentStop");
		expect(stub.sockets).toHaveLength(0);
	}, 20_000);

	it("still runs when another hook kept the agent active and more edits may exist", async () => {
		stub = await startTurnEndStub(turnDir, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			turnEnd: FRAMED_ADVISORY,
		});
		const { stdout, code } = await runBin(
			[],
			JSON.stringify({
				cwd: turnDir,
				hook_event_name: "Stop",
				stop_hook_active: true,
			}),
		);

		expect(code).toBe(0);
		expect(stdout).toContain("🔎 pi-lens turn-end");
		expect(stub.requests).toHaveLength(1);
	}, 20_000);
});

describe("pi-lens-analyze warm hook route", { retry: 2 }, () => {
	it("repeats the warm coverage notice on every PostToolUse hook (#3791 F1)", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cli-warm-hook-"),
		);
		const file = path.join(cwd, "main.go");
		fs.writeFileSync(file, "package main\n");
		const stub = await startWarmAnalyzeStub(cwd, {
			filePath: file,
			cwd,
			counts: {
				diagnostics: 1,
				blockers: 0,
				warnings: 1,
				advisories: 0,
				fixed: 0,
			},
			diagnostics: [
				{
					line: 1,
					semantic: "warning",
					tool: "coverage",
					message: "coverage: go scanner silent",
				},
			],
		});
		try {
			const first = await runBin([`--file=${file}`, `--cwd=${cwd}`, "--hook"]);
			const second = await runBin([`--file=${file}`, `--cwd=${cwd}`, "--hook"]);
			for (const run of [first, second]) {
				expect(run.code).toBe(0);
				const parsed = JSON.parse(run.stdout) as {
					hookSpecificOutput?: { additionalContext?: string };
				};
				expect(parsed.hookSpecificOutput?.additionalContext).toContain(
					"coverage: go scanner silent",
				);
			}
			expect(stub.requests).toHaveLength(2);
		} finally {
			await stub.close();
			removeTempDirSync(cwd);
		}
	}, 45_000);
});

// #4300: invalid input still crosses the real standalone host startup policy.
// Reuse the bounded bin harness; the preload observes real trust consumers.
describe("standalone host trust startup (#4300)", () => {
	it.each([
		["analyze-cli", ["--file=missing.js"]],
		["cli", ["invalid-command"]],
		["worker", []],
	])(
		"%s admits project execution and records its host policy",
		async (entry, args) => {
			const project = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-cli-isolation-"),
			);
			const home = path.join(project, "home");
			const bin = path.join(project, "node_modules", ".bin");
			fs.mkdirSync(bin, { recursive: true });
			fs.writeFileSync(path.join(bin, "oxlint"), "");
			fs.writeFileSync(path.join(bin, "oxlint.cmd"), "");
			try {
				await runBin(
					args,
					undefined,
					[
						"--import",
						path.join(
							repoRoot,
							"tests/fixtures/witness/non-pi-trust/startup-probe.mjs",
						),
					],
					home,
					project,
					path.join(repoRoot, "mcp", `${entry}.js`),
				);
				const result = JSON.parse(
					fs.readFileSync(path.join(project, "trust-startup.json"), "utf8"),
				) as { command: string; codeServerAllowed: boolean };
				expect(result.command).toMatch(/node_modules[\\/]\.bin[\\/]oxlint/);
				expect(result.codeServerAllowed).toBe(true);
				const host =
					entry === "cli"
						? "build-graph"
						: entry === "worker"
							? "mcp-worker"
							: entry;
				const records = fs
					.readFileSync(path.join(home, "extension.log"), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { message: string });
				expect(
					records.filter(
						(row) =>
							row.message.startsWith(`${host}: workspace trust belongs to`) &&
							row.message.endsWith("pi trust not consulted"),
					),
				).toHaveLength(1);
			} finally {
				removeTempDirSync(project);
			}
		},
		60_000,
	);
});
