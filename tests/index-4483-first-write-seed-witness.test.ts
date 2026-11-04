/**
 * #4483 witness (ADR 0007): on a file's first write in a session, a linter
 * error the file already had is not a STOP blocker.
 *
 * Recurrence it prevents: the delta baseline exists only after a file's first
 * dispatch, so the first write called every linter error in the file new and
 * stopped the agent on errors it never touched (#4481's remainder after
 * #4482). Language servers keep that first-write behaviour by the
 * maintainer's scope (2026-10-15).
 *
 * Real: `index.ts`'s registered handlers (session_start, turn_start,
 * tool_call, tool_result, turn_end), the read guard, `runPipeline`,
 * `dispatchForFile` with the real `shellcheck` and `lsp` runners,
 * `RuntimeCoordinator` and the git-guard gate. Doubled only at the process
 * boundaries: `clients/safe-spawn.js` (shellcheck) and the LSP service behind
 * `clients/lsp/capabilities.js`, whose `touchFile` reports error 2304 on each
 * `BAD_CALL` line of the bytes it is handed.
 *
 * Every write goes through the host order: `tool_call` (the bytes on disk are
 * still the old ones), then the write, then `tool_result`.
 *
 * The `--no-delta` cell moved to tier 2 with the real flag, in
 * `tests/index-4483-no-delta-flag.test.ts` (#4937 L6).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

const boundary = vi.hoisted(() => {
	const lsp = {
		enabled: false,
		diagnose: (content: string): unknown[] =>
			content.split("\n").flatMap((line, i): unknown[] =>
				line.includes("BAD_CALL")
					? [
							{
								severity: 1,
								message: "Cannot find name 'BAD_CALL'.",
								code: 2304,
								source: "ts",
								serverId: "typescript",
								range: {
									start: { line: i, character: 0 },
									end: { line: i, character: 8 },
								},
							},
						]
					: [],
			),
		touch: async (_file: string, content: string) => ({
			diags: lsp.diagnose(content),
		}),
	};
	/**
	 * shellcheck runs, by the bytes each read. Each hook is taken by the next
	 * run only: `onRun` runs after it read its bytes (a host write racing the
	 * capture), `settle` is awaited before it answers (other work landing
	 * while it is out), and `failNext` makes it exit 3 with no JSON (a run
	 * that reaches no verdict).
	 */
	const sh = {
		runs: [] as string[],
		onRun: undefined as ((file: string) => void) | undefined,
		settle: undefined as (() => Promise<void>) | undefined,
		failNext: false,
	};
	/**
	 * shellcheck's JSON for `text`: SC1072 on each `BAD_SH` line, and SC2154 on
	 * each line that reads `$VAR` while no line assigns `VAR=`, so an edit can
	 * cause an error at a line it never touched.
	 */
	function shellcheckJson(file: string, text: string) {
		const lines = text.split("\n");
		const assigned = lines.some((l) => l.startsWith("VAR="));
		const items = lines.flatMap((l, i) => {
			const at = { file, line: i + 1, endLine: i + 1, column: 1, endColumn: 2 };
			if (l.includes("BAD_SH"))
				return [
					{
						...at,
						level: "error",
						code: 1072,
						message: "Unexpected BAD_SH token",
					},
				];
			if (l.includes("$VAR") && !assigned)
				return [
					{
						...at,
						level: "error",
						code: 2154,
						message: "VAR is referenced but not assigned.",
					},
				];
			return [];
		});
		return {
			stdout: JSON.stringify(items),
			stderr: "",
			status: items.length ? 1 : 0,
		};
	}
	const isDoubled = (c: string) => /(^|[\\/])shellcheck(\.exe)?$/i.test(c);
	function run(command: string, args: readonly string[] = []) {
		if (isDoubled(command) && args.includes("--format")) {
			const file = args[args.length - 1] ?? "";
			const nodeFs = (
				process as unknown as {
					getBuiltinModule: (m: "node:fs") => typeof import("node:fs");
				}
			).getBuiltinModule("node:fs");
			const text = nodeFs.existsSync(file)
				? nodeFs.readFileSync(file, "utf8")
				: "";
			sh.runs.push(text);
			const hook = sh.onRun;
			sh.onRun = undefined;
			hook?.(file);
			if (sh.failNext) {
				sh.failNext = false;
				return { stdout: "", stderr: "shellcheck: internal error", status: 3 };
			}
			return shellcheckJson(file, text);
		}
		if (isDoubled(command))
			return { stdout: "version: 0.10.0", stderr: "", status: 0 };
		return {
			stdout: "",
			stderr: "command not found",
			status: 127,
			failure: "spawn" as const,
			spawnFailure: { kind: "tool-not-found" as const },
		};
	}
	return { lsp, sh, isDoubled, run };
});

vi.mock("../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/safe-spawn.js")>()),
	safeSpawn: boundary.run,
	safeSpawnAsync: async (command: string, args: readonly string[] = []) => {
		const result = boundary.run(command, args);
		if (!args.includes("--format")) return result;
		const settle = boundary.sh.settle;
		boundary.sh.settle = undefined;
		await settle?.();
		return result;
	},
	isCommandAvailableAsync: async (command: string) =>
		boundary.isDoubled(command),
	findCommand: (command: string) =>
		boundary.isDoubled(command) ? command : null,
	findCommandAsync: async (command: string) =>
		boundary.isDoubled(command) ? command : null,
}));

import extension from "../index.js";
import { resetDegradationLedger } from "../clients/degradation-ledger.js";
import {
	capturePreEditLinterFindings,
	dispatchLintWithResult,
	resetDispatchBaselines,
} from "../clients/dispatch/integration.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { CacheManager } from "../clients/cache-manager.js";
import { exportWidgetState } from "../clients/widget-state.js";
import {
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../clients/dispatch/collect-later-tier.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { useGlobalConfig } from "./support/global-config.js";
import { installLspServiceDouble } from "./support/lsp-service-seam.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";

let tmpDir = "";
const originalTestMode = process.env.PI_LENS_TEST_MODE;

beforeAll(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4483-witness-")),
	);
});
afterAll(() => removeTempDirSync(tmpDir));
beforeEach(async () => {
	// Always the double: with `enabled` off it supports no file, so no real
	// language server is ever spawned for the shell cells.
	await installLspServiceDouble({
		supportsLSP: () => boundary.lsp.enabled,
		hasLSP: async () => boundary.lsp.enabled,
		touchFile: boundary.lsp.touch,
	});
	process.env.PI_LENS_TEST_MODE = "0";
	// Each cell is a separate session but shares this temporary project. A
	// blocker intentionally left by one cell must not become the next cell's
	// cross-session `turn-end-findings` record and make its commit probe fail
	// closed; production keeps that record until fresh evidence replaces it.
	new CacheManager(false).clearCache("turn-end-findings", tmpDir);
	boundary.lsp.enabled = false;
	boundary.sh.runs = [];
	boundary.sh.onRun = undefined;
	boundary.sh.settle = undefined;
	boundary.sh.failNext = false;
});
afterEach(() => {
	if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = originalTestMode;
});

const scrub = (s: string) =>
	s
		.replaceAll(tmpDir, "<PROJECT>")
		.replace(/·\s*\d+ms/g, "· <MS>ms")
		.trim();

const text = (r: unknown) =>
	scrub(
		(
			((r as { content?: Array<{ text?: string }> } | undefined)?.content ??
				[]) as Array<{ text?: string }>
		)
			.map((p) => p.text ?? "")
			.join("\n"),
	);

/** The latency rows naming `file` with `phase` (or `result`) `name`. */
async function rows(
	file: string,
	name: string,
): Promise<Array<{ result?: string; metadata?: Record<string, unknown> }>> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	// A row whose write was torn cannot be the row this witness names: red
	// rather than read a shorter trace as the answer.
	expect(read.skipped).toBe(0);
	return read.rows
		.filter(
			(r) => r.filePath === file && (r.phase === name || r.result === name),
		)
		.map((r) => ({
			result: r.result as string | undefined,
			metadata: r.metadata as Record<string, unknown> | undefined,
		}));
}

/**
 * One host session over one file that exists before the session starts.
 * `config` is the global config over the lens-guard default.
 */
async function openSession(
	name: string,
	file: string,
	before: string,
	config: Record<string, unknown> = {},
) {
	const target = path.join(tmpDir, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, before);
	setGlobalConfig({ guard: { enabled: true }, ...config });
	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	// #4733 r5: every event carries this session's id. A shutdown with no id
	// left the first cell holding the primary registration, so every later cell
	// ran as its secondary and inherited the first cell's inline blockers.
	const sessionId = `pi-lens-4483-${name}`;
	const ctx = () => makeCtx({ cwd: tmpDir, sessionId });
	await pi.emit("session_start", makeSessionStartEvent(), ctx());
	await pi.emit("turn_start", {}, ctx());
	let call = 0;
	const read = async () => {
		const id = `${name}-read-${++call}`;
		await pi.emit(
			"tool_call",
			{ toolName: "read", toolCallId: id, input: { path: target } },
			ctx(),
		);
		await pi.emit(
			"tool_result",
			{
				toolName: "read",
				toolCallId: id,
				input: { path: target },
				content: [{ type: "text", text: fs.readFileSync(target, "utf8") }],
			},
			ctx(),
		);
	};
	return {
		target,
		async preflight() {
			await read();
			return pi.emit(
				"tool_call",
				{
					toolName: "edit",
					toolCallId: `${name}-preflight-${++call}`,
					input: {
						path: target,
						edits: [{ oldText: "echo a", newText: "echo b" }],
					},
				},
				ctx(),
			);
		},
		/** A host `write` of the whole file: tool_call, the write, tool_result. */
		async write(content: string): Promise<string> {
			await read();
			const id = `${name}-write-${++call}`;
			const input = { path: target, content };
			const verdict = (await pi.emit(
				"tool_call",
				{ toolName: "write", toolCallId: id, input },
				ctx(),
			)) as { block?: boolean } | undefined;
			expect(verdict?.block).not.toBe(true);
			fs.writeFileSync(target, content);
			return text(
				await pi.emit(
					"tool_result",
					{
						toolName: "write",
						toolCallId: id,
						input,
						content: [{ type: "text", text: "wrote" }],
					},
					ctx(),
				),
			);
		},
		/** A host `edit` replacing `oldText` with `newText`, once. */
		async edit(oldText: string, newText: string): Promise<string> {
			await read();
			const id = `${name}-edit-${++call}`;
			const input = { path: target, edits: [{ oldText, newText }] };
			const verdict = (await pi.emit(
				"tool_call",
				{ toolName: "edit", toolCallId: id, input },
				ctx(),
			)) as { block?: boolean } | undefined;
			expect(verdict?.block).not.toBe(true);
			const old = fs.readFileSync(target, "utf8");
			const at = old.indexOf(oldText);
			expect(at).toBeGreaterThanOrEqual(0);
			const next = old.slice(0, at) + newText + old.slice(at + oldText.length);
			fs.writeFileSync(target, next);
			const firstLine = old.slice(0, at).split("\n").length;
			const changed = newText
				.split("\n")
				.map((l, i) => `+${firstLine + i} ${l}`);
			return text(
				await pi.emit(
					"tool_result",
					{
						toolName: "edit",
						toolCallId: id,
						input,
						details: { diff: changed.join("\n") },
						content: [{ type: "text", text: "edited" }],
					},
					ctx(),
				),
			);
		},
		async commitBlocked(): Promise<boolean> {
			const v = ((await pi.emit(
				"tool_call",
				{ toolName: "bash", input: { command: 'git commit -m "wip"' } },
				ctx(),
			)) ?? {}) as { block?: boolean };
			return v.block === true;
		},
		async end(): Promise<void> {
			await pi.emit("turn_end", {}, ctx());
			// Cells are independent host sessions. Shut this one down so a cell
			// that intentionally leaves a blocker cannot keep the shared runtime's
			// commit-gate latch armed for the next shuffled cell.
			await pi.emit(
				"session_shutdown",
				{ type: "session_shutdown", reason: "quit" },
				ctx(),
			);
		},
	};
}

const OLD_ERROR = "#!/bin/sh\nBAD_SH\necho a\n";

const setGlobalConfig = useGlobalConfig();

describe("#4483 witness: a linter blocks on the delta at a file's first write", () => {
	it("does not stop on a linter error the file had before its first edit (acceptance 1)", async () => {
		const s = await openSession("a1", "scripts/a1.sh", OLD_ERROR);
		const out = await s.edit("echo a", "echo b");
		expect(out).not.toContain("🔴 STOP");
		expect(out).not.toMatch(/clean/);
		expect(out).toMatch(
			/Pre-existing: 1 linter error .*\(L2 SC1072\); not blocking\./,
		);
		expect(await s.commitBlocked()).toBe(false);
		// The capture read the bytes before the edit; the record says so.
		expect(boundary.sh.runs[0]).toBe(OLD_ERROR);
		const [capture] = await rows(s.target, "pre_edit_capture");
		expect(capture?.result).toBe("seeded");
		expect(capture?.metadata).toMatchObject({
			seeded: 1,
			runners: "shellcheck",
		});
		const dispatched = await rows(s.target, "dispatch_complete");
		expect(dispatched.at(-1)?.metadata).toMatchObject({
			preEditSeed: true,
			preExisting: 1,
			blockers: 0,
		});
		await s.end();
	});

	it("stops on a linter error the first edit caused at a line it did not change (acceptance 2)", async () => {
		const s = await openSession(
			"a2",
			"scripts/a2.sh",
			"#!/bin/sh\nVAR=1\necho $VAR\n",
		);
		const out = await s.edit("VAR=1", "OTHER=1");
		expect(out).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(out).toContain("L3: [SC2154] VAR is referenced but not assigned.");
		expect(out).not.toMatch(/Pre-existing/);
		expect(await s.commitBlocked()).toBe(true);
		await s.edit("OTHER=1", "VAR=1");
		await s.end();
	});

	it("does not stop on an old linter error moved by a whole-file write (acceptance 3)", async () => {
		const s = await openSession("a3", "scripts/a3.sh", OLD_ERROR);
		const out = await s.write("#!/bin/sh\necho first\nBAD_SH\necho a\n");
		expect(out).not.toContain("🔴 STOP");
		expect(out).toMatch(/Pre-existing: 1 linter error .*\(L3\b/);
		expect(await s.commitBlocked()).toBe(false);
		await s.end();
	});

	it("stops on the error a whole-file write caused and not on the old one beside it (acceptance 3 and 2)", async () => {
		const s = await openSession(
			"a32",
			"scripts/a32.sh",
			"#!/bin/sh\nBAD_SH\nVAR=1\necho $VAR\n",
		);
		const out = await s.write("#!/bin/sh\n# header\nBAD_SH\necho $VAR\n");
		expect(out).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(out).toContain("L4: [SC2154]");
		expect(out).not.toContain("L3: [SC1072]");
		expect(out).toMatch(/Pre-existing: 1 linter error .*\(L3\b/);
		expect(await s.commitBlocked()).toBe(true);
		await s.write("#!/bin/sh\nBAD_SH\nVAR=1\necho $VAR\n");
		await s.end();
	});

	it("still stops on a language-server error the file had before its first edit (acceptance 5)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession(
			"a5",
			"src/a5.ts",
			"const a = 1;\nBAD_CALL();\nconst b = 2;\n",
		);
		const out = await s.edit("const b = 2;", "const b = 3;");
		expect(out).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(out).toContain("L2:");
		expect(out).not.toMatch(/Pre-existing/);
		expect(await s.commitBlocked()).toBe(true);
		await s.edit("BAD_CALL();\n", "");
		await s.end();
	});

	it("keeps an old linter error pre-existing on the second write, never as still unfixed", async () => {
		const s = await openSession("c6", "scripts/c6.sh", OLD_ERROR);
		await s.edit("echo a", "echo b");
		const runsAfterFirst = boundary.sh.runs.length;
		const out = await s.edit("echo b", "echo c");
		// Only the first write pays for a capture: the second runs the linter
		// once, for its own dispatch, and writes no capture record.
		expect(boundary.sh.runs.length).toBe(runsAfterFirst + 1);
		expect(await rows(s.target, "pre_edit_capture")).toHaveLength(1);
		expect(out).not.toContain("🔴 STOP");
		expect(out).not.toMatch(/Still unfixed/);
		expect(out).toMatch(/Pre-existing: 1 linter error .*\(L2\b/);
		expect(await s.commitBlocked()).toBe(false);
		await s.end();
	});

	it("stops on an old linter error the agent fixed and then wrote back", async () => {
		const s = await openSession("c7", "scripts/c7.sh", OLD_ERROR);
		await s.edit("echo a", "echo b");
		const fixed = await s.edit("BAD_SH", "echo ok");
		expect(fixed).not.toMatch(/Pre-existing|STOP/);
		const back = await s.edit("echo ok", "BAD_SH");
		expect(back).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(back).toContain("L2: [SC1072]");
		expect(await s.commitBlocked()).toBe(true);
		await s.edit("BAD_SH", "echo ok");
		await s.end();
	});

	it("stops on a second copy of an old linter error the first edit wrote", async () => {
		const s = await openSession("c12", "scripts/c12.sh", OLD_ERROR);
		const out = await s.edit("echo a", "BAD_SH");
		expect(out).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(out).toMatch(/Pre-existing: 1 linter error .*\(L(2|3)\b/);
		expect(await s.commitBlocked()).toBe(true);
		await s.write("#!/bin/sh\necho a\n");
		await s.end();
	});

	it("stops on an old linter error whose line the first edit changed", async () => {
		const s = await openSession("c13", "scripts/c13.sh", OLD_ERROR);
		const out = await s.edit("BAD_SH", "BAD_SH # still");
		expect(out).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(out).toContain("L2: [SC1072]");
		expect(out).not.toMatch(/Pre-existing/);
		await s.write("#!/bin/sh\necho a\n");
		await s.end();
	});

	it("seeds nothing when the file changed while the capture ran, and the first write blocks as before", async () => {
		const s = await openSession("c9", "scripts/c9.sh", OLD_ERROR);
		// Another writer lands while the capture's run is still out: the state
		// a capture the tool_call bound abandoned meets when it settles.
		boundary.sh.onRun = (file) =>
			fs.writeFileSync(file, "#!/bin/sh\nBAD_SH\necho a # raced\n");
		const out = await s.edit("echo a", "echo b");
		expect(out).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(out).toContain("L2: [SC1072]");
		const [capture] = await rows(s.target, "pre_edit_capture");
		expect(capture?.result).toBe("discarded");
		expect(capture?.metadata).toMatchObject({ reason: "bytes-changed" });
		await s.write("#!/bin/sh\necho b\n");
		await s.end();
	});

	it("seeds nothing when the session that started the capture was replaced while it ran", async () => {
		const s = await openSession("c15", "scripts/c15.sh", OLD_ERROR);
		// A capture the tool_call bound abandoned that settles after the next
		// session_start: its session generation is no longer current.
		const outcome = await capturePreEditLinterFindings(
			s.target,
			tmpDir,
			{ getFlag: () => undefined },
			{ isCurrent: () => false },
		);
		expect(outcome).toEqual({
			outcome: "discarded",
			reason: "session-replaced",
		});
		expect(boundary.sh.runs).toEqual([OLD_ERROR]);
		// Its run read bytes the host is about to replace: the widget's runner
		// state never shows it.
		const shown = exportWidgetState().files.filter((f) =>
			f.filePath.endsWith("c15.sh"),
		);
		expect(shown.flatMap((f) => f.runners)).toEqual([]);
		await s.end();
	});

	it("seeds nothing when the file's first dispatch landed while the capture ran", async () => {
		const s = await openSession("c5", "scripts/c5.sh", OLD_ERROR);
		const pi = { getFlag: () => undefined };
		// The file's own dispatch records its delta baseline while the capture's
		// run is out and the bytes are unchanged (a no-op write, or a capture the
		// bound abandoned that settles late): the seed would arrive after the
		// file's first dispatch.
		boundary.sh.settle = async () => {
			await dispatchLintWithResult(s.target, tmpDir, pi);
		};
		const outcome = await capturePreEditLinterFindings(s.target, tmpDir, pi, {
			isCurrent: () => true,
		});
		expect(outcome).toEqual({
			outcome: "discarded",
			reason: "already-dispatched",
		});
		await s.end();
	});

	it("does not run a linter the observed tier moved off the write path at tool_call", async () => {
		const s = await openSession("c14", "scripts/c14.sh", OLD_ERROR);
		// shellcheck took longer than the collect-later threshold in this
		// project: the tool_call must not wait for it either.
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "shellcheck",
			durationMs: 6_000,
		});
		try {
			await s.edit("echo a", "echo b");
			const [capture] = await rows(s.target, "pre_edit_capture");
			expect(capture?.result).toBe("skipped");
			expect(capture?.metadata).toMatchObject({ reason: "no-linter" });
			expect(boundary.sh.runs).not.toContain(OLD_ERROR);
		} finally {
			resetObservedRunnerLatency();
			await s.end();
		}
	});

	it("abandons at 500 ms and aborts its capture signal", async () => {
		// #4543: foreground bounds must cancel the actual runner work.
		resetDegradationLedger();
		await flushLatencyLog();
		const priorRecords = fs.existsSync(getLatencyLogPath())
			? fs
					.readFileSync(getLatencyLogPath(), "utf8")
					.split("\n")
					.filter((line) => line.includes('"pre-edit-capture-incomplete"'))
					.length
			: 0;
		const s = await openSession(
			"deadline-r2",
			"scripts/deadline-r2.sh",
			OLD_ERROR,
		);
		const { spawnAbortScope } = await import("../clients/safe-spawn.js");
		let signal: AbortSignal | undefined;
		let release: (() => void) | undefined;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		boundary.sh.settle = () =>
			new Promise<void>((resolve) => {
				release = resolve;
				signal = spawnAbortScope.getStore();
				signal?.addEventListener("abort", () => resolve(), { once: true });
				entered();
			});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let finished = false;
			const call = s.preflight().then(() => {
				finished = true;
			});
			await started;
			await vi.advanceTimersByTimeAsync(499);
			expect(finished).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await call;
			expect(signal?.aborted).toBe(true);
		} finally {
			release?.();
			vi.useRealTimers();
		}
		const [capture] = await rows(s.target, "pre_edit_capture");
		expect(capture?.result).toBe("abandoned");
		expect(
			fs
				.readFileSync(getLatencyLogPath(), "utf8")
				.split("\n")
				.filter((line) => line.includes('"pre-edit-capture-incomplete"')),
		).toHaveLength(priorRecords + 1);
		// Pin the raw measuring run behind this budget (12/14 seeded).
		const measured = JSON.parse(
			fs.readFileSync(
				new URL("./fixtures/pre-edit-capture/500ms.json", import.meta.url),
				"utf8",
			),
		);
		expect(
			measured.filter(
				(row: { capture: { result: string } }) =>
					row.capture.result === "seeded",
			),
		).toHaveLength(12);
		expect(
			new Set(
				measured.map(
					(row: { capture: { budgetMs: number } }) => row.capture.budgetMs,
				),
			),
		).toEqual(new Set([capture?.metadata?.budgetMs]));
		await s.end();
	});

	it("bounds distinct captures and refuses a seed after cancellation", async () => {
		// #4543 M1: distinct abandoned files must not retain unlimited children.
		resetDegradationLedger();
		await flushLatencyLog();
		const priorRecords = fs.existsSync(getLatencyLogPath())
			? fs
					.readFileSync(getLatencyLogPath(), "utf8")
					.split("\n")
					.filter((line) => line.includes('"pre-edit-capture-incomplete"'))
					.length
			: 0;
		const s = await openSession("r2", "scripts/r2.sh", OLD_ERROR);
		const releases: (() => void)[] = [];
		const pending: Promise<unknown>[] = [];
		const controllers: AbortController[] = [];
		try {
			for (let i = 0; i < 4; i++) {
				const file = path.join(tmpDir, `r2-${i}.sh`);
				fs.writeFileSync(file, OLD_ERROR);
				let entered!: () => void;
				const started = new Promise<void>((resolve) => {
					entered = resolve;
				});
				boundary.sh.settle = () =>
					new Promise<void>((resolve) => {
						releases.push(resolve);
						entered();
					});
				const controller = new AbortController();
				controllers.push(controller);
				pending.push(
					capturePreEditLinterFindings(
						file,
						tmpDir,
						{ getFlag: () => undefined },
						{ isCurrent: () => true },
						controller.signal,
					),
				);
				await started;
			}
			const fifth = await capturePreEditLinterFindings(
				s.target,
				tmpDir,
				{ getFlag: () => undefined },
				{ isCurrent: () => true },
			);
			expect(fifth).toEqual({ outcome: "skipped", reason: "capacity" });
			await capturePreEditLinterFindings(
				s.target,
				tmpDir,
				{ getFlag: () => undefined },
				{ isCurrent: () => true },
			);
			await flushLatencyLog();
			const records = fs
				.readFileSync(getLatencyLogPath(), "utf8")
				.split("\n")
				.filter((line) => line.includes('"pre-edit-capture-incomplete"'));
			expect(records).toHaveLength(priorRecords + 1);
			controllers.forEach((c) => c.abort());
		} finally {
			releases.forEach((release) => release());
		}
		expect(await Promise.all(pending)).toEqual(
			Array.from({ length: 4 }, () => ({
				outcome: "discarded",
				reason: "aborted",
			})),
		);
		await s.end();
	});

	it("discards a late completion after the first-write capture signal aborts", async () => {
		// #4543 recurrence: `if (captureSignal.aborted)` -> `if (false)` survived
		// because the abandonment witness only proved that the caller stopped
		// waiting; it did not let a signal-ignoring runner complete and inspect
		// the real store after that completion.
		const s = await openSession(
			"late-abort-r3",
			"scripts/late-abort-r3.sh",
			OLD_ERROR,
		);
		const controller = new AbortController();
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		boundary.sh.settle = () =>
			new Promise<void>((resolve) => {
				release = resolve;
				entered();
			});

		const capture = capturePreEditLinterFindings(
			s.target,
			tmpDir,
			{ getFlag: () => undefined },
			{ isCurrent: () => true },
			controller.signal,
		);
		await started;
		controller.abort();
		release();
		expect(await capture).toEqual({ outcome: "discarded", reason: "aborted" });

		// Observe the production FactStore through dispatch: an installed seed
		// would turn this old blocker into pre-existing and leave no blocker.
		const result = await dispatchLintWithResult(s.target, tmpDir, {
			getFlag: () => undefined,
		});
		expect(result.blockers).toHaveLength(1);
		await s.end();
	});

	it("session reset cancels held captures before their unchanged bytes can seed", async () => {
		// #4543: clearing the facts alone let old work install into the new session.
		const s = await openSession("reset-r2", "scripts/reset-r2.sh", OLD_ERROR);
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		boundary.sh.settle = () =>
			new Promise<void>((resolve) => {
				release = resolve;
				entered();
			});
		const capture = capturePreEditLinterFindings(
			s.target,
			tmpDir,
			{ getFlag: () => undefined },
			{ isCurrent: () => true },
		);
		await started;
		resetDispatchBaselines();
		release();
		expect(await capture).toEqual({ outcome: "discarded", reason: "aborted" });
		expect(
			await capturePreEditLinterFindings(
				s.target,
				tmpDir,
				{ getFlag: () => undefined },
				{ isCurrent: () => true },
			),
		).toMatchObject({ outcome: "seeded", seeded: 1 });
		await s.end();
	});

	it("starts no second capture of a file while one is still running", async () => {
		const s = await openSession("c10", "scripts/c10.sh", OLD_ERROR);
		const pi = { getFlag: () => undefined };
		const current = { isCurrent: () => true };
		let release: () => void = () => {};
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		// The first capture's linter run is still out: the state a capture the
		// tool_call bound abandoned leaves for the file's next write.
		boundary.sh.settle = () =>
			new Promise<void>((resolve) => {
				release = resolve;
				started();
			});
		const first = capturePreEditLinterFindings(s.target, tmpDir, pi, current);
		await running;
		const second = await capturePreEditLinterFindings(
			s.target,
			tmpDir,
			pi,
			current,
		);
		expect(second).toEqual({ outcome: "skipped", reason: "in-flight" });
		expect(boundary.sh.runs).toHaveLength(1);
		release();
		expect(await first).toMatchObject({ outcome: "seeded", seeded: 1 });
		await s.end();
	});

	it("keeps an old linter error pre-existing across a write where its linter reached no verdict", async () => {
		const s = await openSession("c8", "scripts/c8.sh", OLD_ERROR);
		await s.edit("echo a", "echo b");
		boundary.sh.failNext = true;
		await s.edit("echo b", "echo c");
		const out = await s.edit("echo c", "echo d");
		expect(out).not.toContain("🔴 STOP");
		expect(out).toMatch(/Pre-existing: 1 linter error .*\(L2\b/);
		await s.end();
	});

	it("keeps another session's saved section for a linter blocker the seed calls pre-existing (#4733 r5 G3)", async () => {
		// RECURRENCE GUARDED: #4733 r5 G3. The seed re-classified a blocker the
		// linter still reports as pre-existing, the write then read as a whole-file
		// clean verdict, and another session's saved section for that blocker left
		// the record: the commit ran on a blocker shellcheck still reported.
		const s = await openSession("g3", "scripts/g3.sh", OLD_ERROR);
		const section = `${s.target}: 🔴 STOP — 1 issue(s) must be fixed:\n  L2: [shellcheck] SC1072`;
		new CacheManager(false).writeCache(
			"turn-end-findings",
			{
				content: section,
				blockerContent: section,
				blockingFiles: [s.target],
				hasBlockers: true,
				affectedFiles: [s.target],
				sessionId: "an-earlier-session",
				projectSeqStart: 0,
				projectSeqEnd: 0,
				fileSeqByPath: {},
				fileContentHashes: {},
				consumed: true,
			},
			tmpDir,
		);
		const out = await s.edit("echo a", "echo b");
		expect(out).toMatch(/Pre-existing: 1 linter error .*\(L2\b/);
		expect(
			new CacheManager(false).readCache<{ blockerContent?: string }>(
				"turn-end-findings",
				tmpDir,
				Number.POSITIVE_INFINITY,
			)?.data?.blockerContent ?? "",
		).toContain(section);
		expect(await s.commitBlocked()).toBe(true);
		await s.end();
	});

	it("keeps a recorded blocker recorded when a later seed finds the same error", async () => {
		const s = await openSession("c18", "scripts/c18.sh", "#!/bin/sh\necho a\n");
		const first = await s.edit("echo a", "BAD_SH");
		expect(first).toContain("🔴 STOP");
		expect(await s.commitBlocked()).toBe(true);
		// The delta baseline is gone while the inline record holds the blocker:
		// the state a baseline evicted from the bounded session facts (and its
		// tombstone with it) leaves. The next write captures a seed again.
		resetDispatchBaselines();
		const out = await s.edit("#!/bin/sh", "#!/bin/sh -e");
		expect(out).not.toMatch(/Pre-existing/);
		expect(out).toMatch(/Still unfixed: 1 blocker reported earlier \(L2\b/);
		expect(await s.commitBlocked()).toBe(true);
		await s.edit("BAD_SH", "echo a");
		await s.end();
	});
});
