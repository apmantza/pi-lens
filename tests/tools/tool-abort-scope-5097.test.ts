// flake-shape: real-process-spawn — the defect is a signal that never reaches a real ast-grep child; only a real child shows it killed or left running.
/**
 * #5097: pi hands every tool call its abort signal, but a tool's spawns read
 * the ambient default, which only hook handlers set. Esc therefore left
 * `ast_grep_outline` and `ast_grep_replace` children running, and an apply
 * still rewrote every file after the abort.
 *
 * Each case enters through the registration loop's wrapper: the built
 * extension loaded into pi's real `ExtensionRunner` (tier 1), with the
 * registered definition's `execute` called as pi's definition wrapper calls
 * it (`signal` positional plus `ctx.signal`).
 *
 * The `ast-grep` on PATH is a wrapper around the real binary, the process
 * boundary double. It records each phase's pid, can park a phase until the test
 * releases it, can linger on its stdout after it exits (the pipe-idle window in
 * which safe-spawn no longer listens for the abort), and rewrites files one per
 * step for `--update-all`, so a kill in the middle leaves part of them written,
 * as the real binary did at 842 of 2250 files. Every wait ends on a marker file
 * the wrapper writes, never on a clock; a parked phase releases itself after
 * PARK_LIMIT_MS so pre-fix code still settles (and reds) instead of hanging.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startPiRunner, type PiRunner } from "../support/pi-runner.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REAL_SG = path.join(REPO_ROOT, "node_modules", ".bin", "ast-grep");
const PARK_LIMIT_MS = 8_000;

/** The wrapper's control protocol, read from `<ctl>/plan.json` per call. */
interface Plan {
	/**
	 * What each `--json`/`--json=compact` call does, by call index (0-based).
	 * `fail` exits 2 with a stderr line, a real failure that is not the abort.
	 * `kill` SIGKILLs the test host's direct child, as the OOM killer would: a
	 * spawn-level failure (`failure: "signal"`) that is not the abort either.
	 */
	json?: Array<"pass" | "park" | "linger" | "fail" | "kill">;
	/** `outline`: park, or pass straight to the real binary. */
	outline?: "pass" | "park";
	/**
	 * `--update-all`: one file per step, parking after the first; `fail`
	 * then exits 2 instead of writing the rest.
	 */
	updateAll?: "pass" | "stepwise" | "fail";
}

const WRAPPER = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
const ctl = process.env.PI_LENS_TEST_SG_CTL;
const real = process.env.PI_LENS_TEST_SG_REAL;
const host = process.env.PI_LENS_TEST_SG_HOST;
const args = process.argv.slice(2);
if (args.includes("--version")) {
	process.stdout.write("ast-grep 0.0.0-wrapper\n");
	process.exit(0);
}
const plan = JSON.parse(fs.readFileSync(path.join(ctl, "plan.json"), "utf8"));
const counter = (name) => {
	const file = path.join(ctl, name + ".count");
	const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
	fs.writeFileSync(file, String(n + 1));
	return n;
};
const runReal = (argv) =>
	spawnSync(real, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const parkUntilReleased = (marker) => {
	fs.writeFileSync(path.join(ctl, marker), String(process.pid));
	const until = Date.now() + ${PARK_LIMIT_MS};
	while (!fs.existsSync(path.join(ctl, "release")) && Date.now() < until) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
	}
};
const passThrough = (argv) => {
	const r = runReal(argv);
	process.stdout.write(r.stdout ?? "");
	process.stderr.write(r.stderr ?? "");
	process.exit(r.status ?? 1);
};
if (args[0] === "outline") {
	if (plan.outline === "park") parkUntilReleased("outline.pid");
	passThrough(args);
}
if (args.includes("--update-all")) {
	if (plan.updateAll !== "stepwise" && plan.updateAll !== "fail") passThrough(args);
	const isScan = args[0] === "scan";
	const target = args[args.length - 1];
	const listArgs = args.filter((a) => a !== "--update-all");
	listArgs.splice(listArgs.length - 1, 0, isScan ? "--json" : "--json=compact");
	const files = [...new Set(JSON.parse(runReal(listArgs).stdout || "[]").map((m) => m.file))].sort();
	files.forEach((file, i) => {
		const step = [...args.slice(0, -1), path.isAbsolute(file) ? file : path.join(target, file)];
		runReal(step);
		if (i === 0) parkUntilReleased("applied-1");
		if (i === 0 && plan.updateAll === "fail") {
			process.stderr.write("wrapper: disk full after the first file\n");
			process.exit(2);
		}
	});
	process.exit(0);
}
const mode = (plan.json ?? [])[counter("json")] ?? "pass";
if (mode === "fail") {
	process.stderr.write("wrapper: scan failed, not an abort\n");
	process.exit(2);
}
if (mode === "kill") {
	let top = process.pid;
	for (let pid = process.ppid; pid > 1 && String(pid) !== host; ) {
		top = pid;
		pid = Number(spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim() || 0);
	}
	process.kill(top, "SIGKILL");
	process.exit(2);
}
if (mode === "park") parkUntilReleased("json.pid");
if (mode === "linger") {
	const r = runReal(args);
	process.stdout.write(r.stdout ?? "");
	// A grandchild keeps stdout open after this process exits, so the parent
	// sits in its post-exit pipe-idle wait. Each step is ordered by a marker,
	// never a clock: the grandchild writes before this process exits (so the
	// 100 ms idle grace never lapses on a slow start), writes lingering only
	// once every process between this one and the test host is gone (the npx
	// fallback puts npm and a shell in between; an abort while they live
	// lands in the scan instead of the idle wait), and keeps writing every
	// 10 ms until the test writes release after its abort.
	const chain = [process.pid];
	for (let pid = process.ppid; pid > 1 && String(pid) !== host; ) {
		chain.push(pid);
		pid = Number(spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim() || 0);
		if (pid <= 1) throw new Error("linger: test host not among the ancestors");
	}
	const started = path.join(ctl, "linger-started");
	spawn(process.execPath, ["-e", [
		"const fs = require('node:fs');",
		"const [started, marker, release, chain, limit] = process.argv.slice(1);",
		"const until = Date.now() + Number(limit);",
		"process.stdout.write(' '); fs.writeFileSync(started, 'x');",
		"const alive = () => chain.split(',').some((pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } });",
		"const t = setInterval(() => {",
		"  if (fs.existsSync(release) || Date.now() > until) { clearInterval(t); return; }",
		"  process.stdout.write(' ');",
		"  if (!alive() && !fs.existsSync(marker)) fs.writeFileSync(marker, 'x');",
		"}, 10);",
	].join(""), started, path.join(ctl, "lingering"), path.join(ctl, "release"), chain.join(","), String(${PARK_LIMIT_MS})], { stdio: ["ignore", "inherit", "ignore"], detached: true }).unref();
	const until = Date.now() + ${PARK_LIMIT_MS};
	while (!fs.existsSync(started) && Date.now() < until) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
	process.exit(r.status ?? 1);
}
passThrough(args);
`;

/** Resolve once `file` has content; rejects after `timeoutMs` (fs.watchFile poll). */
function waitForFile(file: string, timeoutMs = 20_000): Promise<void> {
	const deadline = AbortSignal.timeout(timeoutMs);
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (err?: Error): void => {
			if (settled) return;
			settled = true;
			fs.unwatchFile(file, listener);
			deadline.removeEventListener("abort", onTimeout);
			if (err) reject(err);
			else resolve();
		};
		const onTimeout = (): void =>
			finish(new Error(`waitForFile timed out: ${file}`));
		const listener = (): void => {
			try {
				if (fs.existsSync(file) && fs.readFileSync(file, "utf8").length > 0)
					finish();
			} catch (err) {
				// A marker removed before the read is not ready yet.
				if ((err as NodeJS.ErrnoException).code !== "ENOENT")
					finish(err as Error);
			}
		};
		deadline.addEventListener("abort", onTimeout);
		fs.watchFile(file, { interval: 20, persistent: true }, listener);
		listener();
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };

// lane: the Linux unit shards; the wrapper is a POSIX shebang script and the
// Windows leg runs tests/config only.
describe.skipIf(process.platform === "win32" || !fs.existsSync(REAL_SG))(
	"#5097 a tool call's abort reaches the spawns it starts",
	{ timeout: 30_000 },
	() => {
		let pi: PiRunner;
		let ctl: string;

		beforeAll(async () => {
			pi = await startPiRunner();
			// The project is untrusted under tier 1 (no session_start adopts pi's
			// trust), so ast-grep resolves through the scoped npx fallback, which
			// runs in the managed tools directory and takes the `@ast-grep/cli`
			// installed there. The wrapper is planted as that package.
			const tools = path.join(process.env.PI_LENS_HOME ?? "", "tools");
			const pkg = path.join(tools, "node_modules", "@ast-grep", "cli");
			fs.mkdirSync(pkg, { recursive: true });
			fs.mkdirSync(path.join(tools, "node_modules", ".bin"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(pkg, "package.json"),
				JSON.stringify({
					name: "@ast-grep/cli",
					version: "0.0.0",
					bin: { "ast-grep": "wrapper.mjs" },
				}),
			);
			fs.writeFileSync(
				path.join(pkg, "wrapper.mjs"),
				`#!/usr/bin/env node\n${WRAPPER}`,
				{
					mode: 0o755,
				},
			);
			fs.symlinkSync(
				path.join("..", "@ast-grep", "cli", "wrapper.mjs"),
				path.join(tools, "node_modules", ".bin", "ast-grep"),
			);
			process.env.PI_LENS_TEST_SG_REAL = REAL_SG;
			process.env.PI_LENS_TEST_SG_HOST = String(process.pid);
		});

		// A parked wrapper left behind by a failed case releases itself now.
		afterEach(() => {
			if (ctl) fs.writeFileSync(path.join(ctl, "release"), "");
			delete process.env.PI_LENS_TEST_SG_CTL;
		});

		afterAll(() => {
			delete process.env.PI_LENS_TEST_SG_REAL;
			delete process.env.PI_LENS_TEST_SG_HOST;
		});

		/** A fresh project tree and control dir for one case. */
		function setup(name: string, plan: Plan, files = 3): string {
			const root = path.join(pi.cwd, name);
			ctl = path.join(root, ".ctl");
			fs.mkdirSync(ctl, { recursive: true });
			fs.writeFileSync(path.join(ctl, "plan.json"), JSON.stringify(plan));
			process.env.PI_LENS_TEST_SG_CTL = ctl;
			for (let i = 0; i < files; i++) {
				fs.mkdirSync(path.join(root, "src"), { recursive: true });
				fs.writeFileSync(
					path.join(root, "src", `f${i}.ts`),
					`export function f${i}(): void {}\nlegacyCall(${i});\n`,
				);
			}
			return root;
		}

		function rewritten(root: string): number {
			return fs
				.readdirSync(path.join(root, "src"))
				.filter((f) =>
					fs
						.readFileSync(path.join(root, "src", f), "utf8")
						.includes("modernCall("),
				).length;
		}

		async function run(
			toolName: string,
			params: Record<string, unknown>,
			root: string,
			/** The marker to abort on; `null` runs the call with no abort. */
			abortOn: string | null,
			/** `ctx` passes the signal only through `ctx.signal`, positional undefined. */
			via: "both" | "ctx" = "both",
		): Promise<ToolResult> {
			const tool = pi
				.getAllRegisteredTools()
				.find((t) => t.definition.name === toolName);
			if (!tool) throw new Error(`missing ${toolName}`);
			const execute = tool.definition.execute as unknown as (
				...args: unknown[]
			) => Promise<ToolResult>;
			const ac = new AbortController();
			const call = execute(
				"call-5097",
				params,
				via === "ctx" ? undefined : ac.signal,
				undefined,
				{ cwd: root, signal: ac.signal },
			);
			if (abortOn === null) return call;
			// A call that settles before its marker never reached the phase the
			// case aborts in; fail with its text instead of waiting out the poll.
			const early = call.then((result) => {
				throw new Error(
					`settled before ${abortOn}: ${result.content?.[0]?.text ?? ""}`,
				);
			});
			await Promise.race([waitForFile(path.join(ctl, abortOn)), early]);
			early.catch(() => {});
			ac.abort();
			// The lingering pipe holds the call until release; write it only
			// once the abort is in, so the re-check is what decides (#5097).
			if (abortOn === "lingering") {
				fs.writeFileSync(path.join(ctl, "release"), "");
			}
			return call;
		}

		const REPLACE = {
			pattern: "legacyCall($A)",
			rewrite: "modernCall($A)",
			lang: "typescript",
			paths: ["src"],
		};

		it("ast_grep_outline: an abort kills the parked child and returns aborted", async () => {
			const root = setup("outline", { outline: "park" });
			const result = await run(
				"ast_grep_outline",
				{ paths: ["src"] },
				root,
				"outline.pid",
			);
			const pid = Number(
				fs.readFileSync(path.join(ctl, "outline.pid"), "utf8"),
			);
			expect(result.isError).toBe(true);
			expect(result.content?.[0]?.text).toMatch(/^Error: Spawn aborted/);
			expect(isAlive(pid)).toBe(false);
		});

		it("outline waits for pid marker content before aborting", async () => {
			const root = setup("outline-empty-marker", { outline: "park" });
			const marker = path.join(ctl, "outline.pid");
			fs.writeFileSync(marker, "");
			const result = await run(
				"ast_grep_outline",
				{ paths: ["src"] },
				root,
				"outline.pid",
			);
			const pid = Number(fs.readFileSync(marker, "utf8"));
			expect(pid).toBeGreaterThan(0);
			expect(result.isError).toBe(true);
			expect(result.content?.[0]?.text).toMatch(/^Error: Spawn aborted/);
			expect(isAlive(pid)).toBe(false);
		});

		it("outline: ctx.signal alone kills the child", async () => {
			const root = setup("outline-ctx", { outline: "park" });
			const result = await run(
				"ast_grep_outline",
				{ paths: ["src"] },
				root,
				"outline.pid",
				"ctx",
			);
			const pid = Number(
				fs.readFileSync(path.join(ctl, "outline.pid"), "utf8"),
			);
			expect(isAlive(pid)).toBe(false);
			expect(result.isError).toBe(true);
		});

		it("ast_grep_replace dry run: an abort kills the child and returns a plain aborted result", async () => {
			const root = setup("dry", { json: ["park"] });
			const result = await run("ast_grep_replace", REPLACE, root, "json.pid");
			const pid = Number(fs.readFileSync(path.join(ctl, "json.pid"), "utf8"));
			expect(result.isError).toBe(true);
			// The pattern hint would send the model to fix a pattern that was fine.
			const text = result.content?.[0]?.text ?? "";
			expect(text).toMatch(/^Error: operation aborted(\n|$)/);
			expect(text).not.toMatch(/Hint|write had started/);
			expect(isAlive(pid)).toBe(false);
		});

		it("ast_grep_replace apply: an abort during the precheck rewrites no file", async () => {
			const root = setup("apply-precheck", { json: ["park"] });
			const result = await run(
				"ast_grep_replace",
				{ ...REPLACE, apply: true },
				root,
				"json.pid",
			);
			const text = result.content?.[0]?.text ?? "";
			expect(text).toMatch(/^Error: operation aborted(\n|$)/);
			expect(text).not.toMatch(/Hint|write had started/);
			expect(rewritten(root)).toBe(0);
		});

		it("ast_grep_replace apply: an abort after the precheck exits, before the write starts, rewrites no file", async () => {
			// The precheck child has exited, so safe-spawn no longer listens for
			// the abort while it waits for the lingering pipe; only the re-check
			// before `--update-all` sees it.
			const root = setup("apply-recheck", { json: ["linger"] });
			const result = await run(
				"ast_grep_replace",
				{ ...REPLACE, apply: true },
				root,
				"lingering",
			);
			// N1 (r3): the prefix alone also matches a trailing pattern hint.
			const text = result.content?.[0]?.text ?? "";
			expect(text).toMatch(/^Error: operation aborted(\n|$)/);
			expect(text).not.toMatch(/Hint|write had started/);
			expect(rewritten(root)).toBe(0);
		});

		it("ast_grep_replace apply: an abort during --update-all leaves every file rewritten, never part", async () => {
			const root = setup("apply-write", { updateAll: "stepwise" });
			const pending = run(
				"ast_grep_replace",
				{ ...REPLACE, apply: true },
				root,
				"applied-1",
			);
			// The abort has fired once `run` passes the marker; let the write go on.
			await waitForFile(path.join(ctl, "applied-1"));
			fs.writeFileSync(path.join(ctl, "release"), "");
			const result = await pending;
			expect(rewritten(root)).toBe(3);
			expect(result.content?.[0]?.text).toMatch(/^\[APPLIED\] 3 replacement/);
		});

		it("ast_grep_replace structural apply: an abort during --update-all leaves every file rewritten", async () => {
			const root = setup("rule-write", { updateAll: "stepwise" });
			const pending = run(
				"ast_grep_replace",
				{ ...REPLACE, apply: true, insideKind: "program" },
				root,
				"applied-1",
			);
			await waitForFile(path.join(ctl, "applied-1"));
			fs.writeFileSync(path.join(ctl, "release"), "");
			await pending;
			expect(rewritten(root)).toBe(3);
		});

		it("ast_grep_replace structural apply: an abort after its scan exits, before the write starts, rewrites no file", async () => {
			// Call 0 is the precheck, call 1 the runner's own count scan.
			const root = setup("rule-recheck", { json: ["pass", "linger"] });
			const result = await run(
				"ast_grep_replace",
				{ ...REPLACE, apply: true, insideKind: "program" },
				root,
				"lingering",
			);
			// N1 (r3): the prefix alone also matches a trailing pattern hint.
			const text = result.content?.[0]?.text ?? "";
			expect(text).toMatch(/^Error: operation aborted(\n|$)/);
			expect(text).not.toMatch(/Hint|write had started/);
			expect(rewritten(root)).toBe(0);
		});

		it("pattern apply: a failed write keeps its error", async () => {
			const root = setup("apply-fail", { updateAll: "fail" });
			const pending = run(
				"ast_grep_replace",
				{ ...REPLACE, apply: true },
				root,
				"applied-1",
			);
			await waitForFile(path.join(ctl, "applied-1"));
			fs.writeFileSync(path.join(ctl, "release"), "");
			const result = await pending;
			const text = result.content?.[0]?.text ?? "";
			expect(rewritten(root)).toBe(1);
			expect(result.isError).toBe(true);
			expect(text).not.toMatch(/operation aborted/);
			expect(text).toMatch(/some files may already be rewritten/);
		});

		it("rule apply: abort at path 2 names path 1 files", async () => {
			// Path 1: precheck (json 0), count scan (json 1), write. Path 2's
			// precheck (json 2) parks and the abort kills it.
			const root = setup("rule-two-paths", { json: ["pass", "pass", "park"] });
			fs.mkdirSync(path.join(root, "src2"));
			fs.writeFileSync(path.join(root, "src2", "g.ts"), "legacyCall(9);\n");
			const result = await run(
				"ast_grep_replace",
				{
					...REPLACE,
					apply: true,
					insideKind: "program",
					paths: ["src", "src2"],
				},
				root,
				"json.pid",
			);
			const text = result.content?.[0]?.text ?? "";
			expect(rewritten(root)).toBe(3);
			expect(text).toMatch(
				/^Error: operation aborted\n3 file\(s\) were already rewritten/,
			);
			expect(text).toContain("f0.ts");
			expect(text).not.toMatch(/Hint|write had started/);
		});

		it("rule dry run: abort is plain aborted", async () => {
			const root = setup("rule-dry", { json: ["park"] });
			const result = await run(
				"ast_grep_replace",
				{ ...REPLACE, insideKind: "program" },
				root,
				"json.pid",
			);
			const text = result.content?.[0]?.text ?? "";
			expect(text).toMatch(/^Error: operation aborted(\n|$)/);
			expect(text).not.toMatch(/Hint|write had started/);
		});

		it("rule apply: count-scan abort writes nothing", async () => {
			// Call 0 is the precheck, call 1 the runner's count scan, parked here.
			const root = setup("rule-count", { json: ["pass", "park"] });
			const result = await run(
				"ast_grep_replace",
				{ ...REPLACE, apply: true, insideKind: "program" },
				root,
				"json.pid",
			);
			const text = result.content?.[0]?.text ?? "";
			expect(text).toMatch(/^Error: operation aborted(\n|$)/);
			expect(text).not.toMatch(/Hint|write had started/);
			expect(rewritten(root)).toBe(0);
		});

		it("rule apply: a failed write keeps its error", async () => {
			const root = setup("rule-fail", { updateAll: "fail" });
			const pending = run(
				"ast_grep_replace",
				{ ...REPLACE, apply: true, insideKind: "program" },
				root,
				"applied-1",
			);
			await waitForFile(path.join(ctl, "applied-1"));
			fs.writeFileSync(path.join(ctl, "release"), "");
			const result = await pending;
			const text = result.content?.[0]?.text ?? "";
			expect(rewritten(root)).toBe(1);
			expect(text).not.toMatch(/operation aborted/);
			expect(text).toMatch(/some files may already be rewritten/);
		});

		const KILLED = /^Error: Process killed by signal: SIGKILL/;

		/**
		 * N2 (#5097 r3): `aborted` is admitted only for the spawn's own abort or
		 * the re-check. A real failure on a scan or precheck keeps its text and
		 * the pattern hint; a flag set on any failure would hide both. The pattern
		 * path reports an exit failure with no `failure` kind, so its cases use
		 * `kill`, which sets one; the rule path sets `cli-failure` on either.
		 */
		async function expectRealFailure(
			name: string,
			plan: Plan,
			params: Record<string, unknown>,
			own = /^Error: wrapper: scan failed, not an abort/,
		): Promise<void> {
			const root = setup(name, plan);
			const result = await run("ast_grep_replace", params, root, null);
			const text = result.content?.[0]?.text ?? "";
			expect(result.isError).toBe(true);
			expect(text).toMatch(own);
			expect(text).toMatch(/\n\nHint: /);
			expect(text).not.toMatch(/operation aborted|write had started/);
			expect(rewritten(root)).toBe(0);
		}

		it("pattern dry run: a real failure keeps its text and hint", () =>
			expectRealFailure("dry-fail", { json: ["kill"] }, REPLACE, KILLED));

		it("pattern precheck: a real failure keeps its text and hint", () =>
			expectRealFailure(
				"precheck-fail",
				{ json: ["kill"] },
				{ ...REPLACE, apply: true },
				KILLED,
			));

		it("rule dry run: a real failure keeps its text and hint", () =>
			expectRealFailure(
				"rule-dry-fail",
				{ json: ["fail"] },
				{ ...REPLACE, insideKind: "program" },
			));

		it("rule precheck: a real failure keeps its text and hint", () =>
			expectRealFailure(
				"rule-precheck-fail",
				{ json: ["fail"] },
				{ ...REPLACE, apply: true, insideKind: "program" },
			));

		it("rule count scan: a real failure keeps its text and hint", () =>
			expectRealFailure(
				"rule-count-fail",
				{ json: ["pass", "fail"] },
				{ ...REPLACE, apply: true, insideKind: "program" },
			));
	},
);
