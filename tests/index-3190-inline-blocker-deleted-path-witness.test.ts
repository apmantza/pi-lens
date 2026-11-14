/**
 * #3190 witness (ADR 0007) — the deleted-path retraction through the pi HOST
 * entry, with the REAL producer.
 *
 * Round 1 review (M3357-1): the other witnesses in this tree double
 * `clients/pipeline.js`, which is the very producer #3190 changes, so none of
 * them can see this fix. This one keeps `index.ts`'s registered
 * `session_start` / `turn_start` / `tool_result` / `turn_end` / `context`
 * handlers, the real `handleToolResult`, the real `runPipeline`, the real
 * dispatcher and helm-lint runner, the real `RuntimeCoordinator`, the real
 * `CacheManager` and the real `handleTurnEnd`, and replaces only
 * `clients/safe-spawn.js` — the true PROCESS boundary — with deterministic
 * tool output. A mocked process boundary is an EXEMPTION (no real spawn is
 * admitted), not a `flake-shape-ratchet` admission: nothing here spawns, waits
 * on a wall clock, or touches the network.
 *
 * Why helm-lint is the runner under the mock: it is one of the runners whose
 * findings are POOLED across files (`clients/pipeline.ts`'s `inlineBlockerLines`
 * comment names helm-lint / helm-render alongside javac / dotnet-build), so it
 * can report a blocker against a chart sibling of the edited file. That is the
 * shape #1245's read-time reconcile cannot see and the shape this PR fixes.
 * Its spawn contract is the one pinned in
 * `tests/clients/dispatch/runners/helm-lint.test.ts` (`[LEVEL] <file>[:line]:
 * message` lines, non-zero exit when a chart fails).
 *
 * Two cells in ONE golden (`turn-end-delivery.txt`), in this order:
 *
 *   - cell 1 — `values.yaml` is deleted; its blocker must be retracted from
 *     the tool result AND from the turn-end delivery, while the blocker on the
 *     edited template is served on both. This is the cell the fix changes.
 *   - cell 2 — a second chart with every cited file present: both blockers are
 *     served on both surfaces. This is the byte-identity cell — its text is
 *     what `origin/master` produces too, proven by re-running this file with
 *     the pre-fix `clients/pipeline.ts` restored.
 *
 * Every host-dependent spelling is scrubbed (the project root, the pinned
 * `PI_LENS_HOME` and its `~`-folded form, millisecond timings), and the suite
 * is proven to match with `HOME` moved.
 *
 * Round 3 (#4631): the startup mode is pinned (`beforeEach`) so the golden
 * records the blocker delivery alone. Left to the process-first-session
 * heuristic, the same two cells wrote the `session-start-guidance` cache once
 * and delivered the "📌 pi-lens active" banner in cell 2 only, which reddened
 * this file in a loaded pre-push run whose second start wrote no guidance. The
 * banner's own pin is `tests/index-integration.test.ts` and
 * `tests/clients/context-append-to-last-user.test.ts`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnosticLogger } from "../clients/diagnostic-logger.js";
import { getGlobalPiLensLogDir } from "../clients/probe-home-state.js";

/**
 * The router lives in the hoisted block, NOT inside the `vi.mock` factory:
 * `tests/config/vi-mock-export-sweep.test.ts` reads a factory's export list off
 * the first `return` statement it finds, so a factory that returns anything but
 * its one spread object literal is read as dropping every production export
 * (measured: it reported this file as exporting `["status","stderr","stdout"]`).
 * Same rule the `read-guard` double in `tests/index-integration.test.ts`
 * follows with class fields.
 */
const spawnRouter = vi.hoisted(() => {
	/** Every command this witness's chain tried to run, in order. */
	const calls: Array<{ command: string; args: string[] }> = [];
	/** Set per cell: the `helm lint` stdout that cell's chart produces. */
	const state = { helmLintStdout: "", mypyStdout: "" };
	const isHelm = (command: string): boolean =>
		/(^|[\\/])helm(\.exe)?$/i.test(command);
	/** #5020: the non-helm cross-file runner (mypy follows imports and names
	 *  the module a regression lands in). */
	const isMypy = (command: string): boolean =>
		/(^|[\\/])mypy(\.exe)?$/i.test(command);
	const isDoubled = (command: string): boolean =>
		isHelm(command) || isMypy(command);
	function run(
		command: string,
		args: readonly string[] = [],
	): {
		stdout: string;
		stderr: string;
		status: number;
		failure?: "spawn";
		spawnFailure?: { kind: "tool-not-found" };
	} {
		// The fixture's `.git` is an empty directory, which real git answers with
		// "not a git repository" (the commit gate's staged-delta read, #5553).
		if (command === "git")
			return { stdout: "", stderr: "fatal: not a git repository", status: 128 };
		calls.push({ command, args: [...args] });
		if (isMypy(command))
			return args.includes("--show-column-numbers")
				? {
						stdout: state.mypyStdout,
						stderr: "",
						status: state.mypyStdout ? 1 : 0,
					}
				: { stdout: "mypy 1.11.0", stderr: "", status: 0 };
		// Every binary except helm and mypy is simply not on this host, which is
		// how the runners that do not matter here skip without inventing
		// failures the golden would then have to carry.
		if (!isHelm(command))
			return {
				stdout: "",
				stderr: "command not found",
				status: 127,
				failure: "spawn",
				spawnFailure: { kind: "tool-not-found" },
			};
		if (args[0] === "lint")
			return {
				stdout: state.helmLintStdout,
				stderr: state.helmLintStdout
					? "Error: 1 chart(s) linted, 1 chart(s) failed"
					: "",
				status: state.helmLintStdout ? 1 : 0,
			};
		return {
			stdout: 'version.BuildInfo{Version:"v3.16.2"}',
			stderr: "",
			status: 0,
		};
	}
	return { calls, state, isHelm, isDoubled, run };
});

/** The ONE double: the process boundary. */
vi.mock("../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/safe-spawn.js")>()),
	safeSpawn: spawnRouter.run,
	safeSpawnAsync: async (command: string, args: readonly string[] = []) =>
		spawnRouter.run(command, args),
	isCommandAvailableAsync: async (command: string) =>
		spawnRouter.isDoubled(command),
	findCommand: (command: string) =>
		spawnRouter.isDoubled(command) ? command : null,
	findCommandAsync: async (command: string) =>
		spawnRouter.isDoubled(command) ? command : null,
}));

import extension from "../index.js";
import { getDegradationSummary } from "../clients/degradation-ledger.js";
import { renderWidget } from "../clients/widget-state.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { useGlobalConfig } from "./support/global-config.js";

const GOLDEN_DIR = path.join(
	import.meta.dirname,
	"fixtures/witness/inline-blocker-deleted-path",
);

let tmpDir: string;
const originalTestMode = process.env.PI_LENS_TEST_MODE;

function diagnosticLogPath(): string {
	const date = new Date().toISOString().split("T")[0];
	return path.join(getGlobalPiLensLogDir(), "logs", `${date}.jsonl`);
}

async function readNewDiagnosticRows(
	offset: number,
): Promise<Array<Record<string, unknown>>> {
	await getDiagnosticLogger().flush();
	// `offset` is a byte count: the reader slices the bytes before decoding
	// (#4484 review F3). A line it cannot parse would lower the step count this
	// witness reads, so it is a red, named by its count.
	const read = readNdjsonRows(diagnosticLogPath(), offset);
	expect(read.skipped).toBe(0);
	return read.rows;
}

beforeEach(() => {
	process.env.PI_LENS_TEST_MODE = "0";
	// #3190 round 3: pin the startup mode, so the delivered text below cannot
	// depend on a session_start side effect this witness does not own. The
	// process's FIRST session is forced to `quick`
	// (`globalThis.__piLensFirstSessionDone`, `clients/runtime-session.ts`), and
	// a `quick` start returns before the `session-start-guidance` cache write —
	// so with the mode left to the heuristic, cell 1 delivers no guidance while
	// cell 2 does, and the golden records that latch. Pinning `quick` makes both
	// cells write none, which is the same delivery in both cells whatever the
	// admission or timing of a second start. The guidance-through-the-injector
	// pin lives in `tests/clients/context-append-to-last-user.test.ts` and
	// `tests/index-integration.test.ts` (`context_with_system`), which seed the
	// cache directly.
	vi.stubEnv("PI_LENS_STARTUP_MODE", "quick");
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3190-witness-")),
	);
	spawnRouter.calls.length = 0;
	spawnRouter.state.helmLintStdout = "";
	spawnRouter.state.mypyStdout = "";
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = originalTestMode;
	vi.unstubAllEnvs();
});

/**
 * A minimal chart in its OWN directory, so the two cells never share a chart
 * root, an inline-blocker record or a turn-state entry.
 */
function createChart(name: string): {
	chartRoot: string;
	template: string;
	values: string;
} {
	const chartRoot = path.join(tmpDir, "charts", name);
	fs.mkdirSync(path.join(chartRoot, "templates"), { recursive: true });
	fs.writeFileSync(
		path.join(chartRoot, "Chart.yaml"),
		"apiVersion: v2\nname: witness\nversion: 0.1.0\n",
	);
	const values = path.join(chartRoot, "values.yaml");
	fs.writeFileSync(values, "replicas: 2\n");
	const template = path.join(chartRoot, "templates", "deployment.yaml");
	fs.writeFileSync(
		template,
		"apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: {{ .Values.replicas }}\n",
	);
	return { chartRoot, template, values };
}

/**
 * `helm lint`'s own output shape (the contract pinned by
 * `tests/clients/dispatch/runners/helm-lint.test.ts`): one `[LEVEL] <path>:
 * <message>` line per finding, paths relative to the chart root.
 */
const HELM_LINT_OUTPUT = [
	"==> Linting .",
	"[ERROR] values.yaml:1: replicas must be an integer, got string",
	"[ERROR] templates/deployment.yaml:4: nil pointer evaluating interface {}.image",
].join("\n");

function scrub(text: string): string {
	const probeHome = path.resolve(process.env.PI_LENS_HOME ?? "");
	const home = os.homedir();
	const relativeHome = path.relative(home, probeHome);
	// `displayProjectDataPath` folds `$HOME` to `~` when the store is not under
	// cwd, so the same directory can reach the agent under two spellings and
	// both are scrubbed (#3290's golden lost a round to exactly that). The
	// fallback is a string no delivered text can contain.
	const tildeHome =
		relativeHome &&
		!relativeHome.startsWith("..") &&
		!path.isAbsolute(relativeHome)
			? `~/${relativeHome.split(path.sep).join("/")}`
			: "<never-matches-any-delivered-text>";
	return (
		text
			.replaceAll(tmpDir, "<PROJECT>")
			.replaceAll(probeHome, "<PROBE_HOME>")
			.replaceAll(tildeHome, "<PROBE_HOME>")
			.replaceAll(home, "<HOME>")
			.replaceAll("\\", "/")
			// Every duration the pipeline prints (`✓ … · 12ms`).
			.replace(/·\s*\d+ms/g, "· <MS>ms")
			.trimEnd()
	);
}

/** Drive one turn through the REAL registered host handlers. */
async function witnessTurn(
	name: string,
	deleteValues: boolean,
): Promise<{
	chartRoot: string;
	toolResult: string;
	turnEnd: string;
	diagnosticRows: Array<Record<string, unknown>>;
}> {
	const { chartRoot, template, values } = createChart(name);
	const logFile = diagnosticLogPath();
	// Drain before the offset: a row still queued from setup would land after
	// it and be read as this turn's (#4381).
	await getDiagnosticLogger().flush();
	const logOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
	spawnRouter.state.helmLintStdout = HELM_LINT_OUTPUT;
	if (deleteValues) fs.rmSync(values);

	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	await pi.emit(
		"session_start",
		makeSessionStartEvent(),
		makeCtx({ cwd: tmpDir, sessionId: "pi-lens-3190-witness" }),
	);
	await pi.emit("turn_start", {}, makeCtx({ cwd: tmpDir }));
	const returned = (await pi.emit(
		"tool_result",
		{
			toolName: "edit",
			input: { path: template },
			details: { diff: "+  4   replicas: {{ .Values.replicas }}" },
			content: [{ type: "text", text: "base" }],
		},
		makeCtx({ cwd: tmpDir }),
	)) as { content?: Array<{ text?: string }> } | undefined;
	await pi.emit("turn_end", {}, makeCtx({ cwd: tmpDir }));
	const injected = (await pi.emit(
		"context_with_system",
		makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
		makeCtx({ cwd: tmpDir }),
	)) as { messages?: Array<{ role?: string; content: string }> } | undefined;

	// #4631 round 5 (F2): the transcript leads with the host's system head, so the
	// golden records the messages pi-lens APPENDED. The assertion pins that the
	// head is still at index 0: losing it would shift this golden.
	expect((injected?.messages ?? [])[0]?.role).toBe("system");
	// Each turn is its own host session and shuts down when it ends. Left live,
	// the first turn's session kept the process registration, so a case that ran
	// afterwards started as a declined secondary and delivered nothing (#4483's
	// teardown carries the same rule).
	await pi.emit(
		"session_shutdown",
		{ type: "session_shutdown", reason: "quit" },
		makeCtx({ cwd: tmpDir, sessionId: "pi-lens-3190-witness" }),
	);
	return {
		chartRoot,
		toolResult:
			scrub(
				(returned?.content ?? [])
					.map((part) => part.text ?? "")
					.join("\n")
					.trim(),
			) || "(nothing delivered)",
		turnEnd:
			scrub(
				(injected?.messages ?? [])
					.slice(1)
					.map((m) => m.content)
					.join("\n\n"),
			) || "(nothing injected)",
		diagnosticRows: await readNewDiagnosticRows(logOffset),
	};
}

function assertGolden(name: string, actual: string): void {
	const golden = path.join(GOLDEN_DIR, name);
	if (process.env.PI_LENS_WITNESS_UPDATE === "1") {
		fs.mkdirSync(GOLDEN_DIR, { recursive: true });
		fs.writeFileSync(golden, `${actual}\n`);
	}
	expect(`${actual}\n`).toBe(fs.readFileSync(golden, "utf-8"));
}

describe("#3190 witness: a retracted deleted-path blocker through pi", () => {
	it("matches the golden across the retracted and unretracted cells", async () => {
		// Both cells in ONE case, in this order, so the golden records one
		// deterministic process history: `index.ts`'s module graph is a process
		// singleton (the session banner below is once-per-process), and two
		// separate cases would make each golden depend on whether its sibling
		// ran first.
		const retracted = await witnessTurn("retracted", true);
		const intact = await witnessTurn("intact", false);

		const retractedRows = retracted.diagnosticRows.filter(
			(row) =>
				typeof row.filePath === "string" &&
				row.filePath.includes("charts/retracted"),
		);
		expect(retractedRows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filePath: expect.stringContaining("values.yaml"),
					shownInline: false,
					shownToAgent: false,
				}),
				expect.objectContaining({
					filePath: expect.stringContaining("deployment.yaml"),
					shownInline: true,
					shownToAgent: true,
				}),
			]),
		);

		// The real helm-lint runner really ran, once per cell, through the mocked
		// process boundary — without this the golden could record silence from a
		// chain that never dispatched anything.
		//
		// Review round 2 (M3357-2): counting the calls was not enough. The
		// reviewer mutated the real runner from `["lint", chartRoot]` to
		// `["lint", cwd]` and this case stayed green, so a dispatch aimed at the
		// wrong chart could ride behind the golden. Equality on the WHOLE
		// recorded call — the resolved helm command, the subcommand and the exact
		// chart root — in dispatch order, so linting the workspace root, the
		// other cell's chart, or the two charts in the wrong order all red.
		expect(spawnRouter.calls.filter((call) => call.args[0] === "lint")).toEqual(
			[
				{ command: "helm", args: ["lint", retracted.chartRoot] },
				{ command: "helm", args: ["lint", intact.chartRoot] },
			],
		);

		assertGolden(
			"turn-end-delivery.txt",
			[
				"=== cell 1: helm lint reported two blockers; values.yaml was deleted this turn ===",
				"--- tool_result delivered to the agent ---",
				retracted.toolResult,
				"--- turn_end context message ---",
				retracted.turnEnd,
				"",
				"=== cell 2: the same two blockers; every cited file exists ===",
				"--- tool_result delivered to the agent ---",
				intact.toolResult,
				"--- turn_end context message ---",
				intact.turnEnd,
			].join("\n"),
		);
	});

	/**
	 * #5008 review round 3 (F6): the count ending the `Still unfixed` line splits
	 * its causes. A chart-wide runner reports a blocking row for ANOTHER file in
	 * the chart (`values.yaml`, while the edited template is the file the write
	 * is about). That row has a line, just not in these bytes, so it is the cause
	 * the `; N with no line in this file` clause owns. The other clause names a
	 * same-file stale carry, guarded in
	 * `tests/index-4484-unfixed-blocker-witness.test.ts` (rows 34/35 and the
	 * acceptance-3 count cell).
	 *
	 * Recurrence: the round-2 wording called every unplaced blocker `with no line
	 * in this file`, which is false for the same-file carry those rows hold and
	 * true only for this one.
	 */
	it("counts another file's blocker row as having no line in this file (#5008 review r3)", async () => {
		const { template } = createChart("foreign-row");
		spawnRouter.state.helmLintStdout = [
			"==> Linting .",
			"[ERROR] values.yaml:1: replicas must be an integer, got string",
		].join("\n");
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const ctx = () =>
			makeCtx({ cwd: tmpDir, sessionId: "pi-lens-3190-foreign-row" });
		await pi.emit("session_start", makeSessionStartEvent(), ctx());
		await pi.emit("turn_start", {}, ctx());
		const write = async (content: string): Promise<string> => {
			fs.writeFileSync(template, content);
			const returned = (await pi.emit(
				"tool_result",
				{
					toolName: "write",
					input: { path: template, content },
					content: [{ type: "text", text: "wrote" }],
				},
				ctx(),
			)) as { content?: Array<{ text?: string }> } | undefined;
			return scrub(
				(returned?.content ?? []).map((part) => part.text ?? "").join("\n"),
			);
		};
		const before = fs.readFileSync(template, "utf8");
		expect(await write(`${before}# note one\n`)).toContain("🔴 STOP");
		const second = await write(`${before}# note two\n`);
		expect(second).toMatch(
			/Still unfixed: 1 blocker reported earlier; 1 with no line in this file\./,
		);
		expect(second).not.toMatch(/could not be re-placed in these bytes/);
		await pi.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			ctx(),
		);
	});
});

// --- #5020 ---
const setGlobalConfig = useGlobalConfig();

type Tool = {
	execute: (...a: unknown[]) => Promise<{ content?: Array<{ text?: string }> }>;
};

/** The chart: `deploy-a.yaml` is the file the agent writes, `other-b.yaml` the
 *  file the chart-wide runner cites. */
function createTwoFileChart(name: string) {
	const chartRoot = path.join(tmpDir, "charts", name);
	fs.mkdirSync(path.join(chartRoot, "templates"), { recursive: true });
	fs.writeFileSync(
		path.join(chartRoot, "Chart.yaml"),
		"apiVersion: v2\nname: witness\nversion: 0.1.0\n",
	);
	fs.writeFileSync(path.join(chartRoot, "values.yaml"), "replicas: 2\n");
	const body = (kind: string) =>
		`apiVersion: apps/v1\nkind: ${kind}\nspec:\n  replicas: 1\n`;
	const a = path.join(chartRoot, "templates", "deploy-a.yaml");
	const b = path.join(chartRoot, "templates", "other-b.yaml");
	fs.writeFileSync(a, body("Deployment"));
	fs.writeFileSync(b, body("Deployment"));
	return { chartRoot, a, b, body };
}

const ROW_B = [
	"==> Linting .",
	"[ERROR] templates/other-b.yaml:2: nil pointer evaluating interface {}.image",
].join("\n");

/**
 * What the ledger holds for `chart`'s `cross-file-row-retired` retire: the
 * durable row the real latency.log sink received (flushed first, no other
 * await between) and the reason the in-memory summary kept.
 */
async function retiredRow(
	chart: string,
): Promise<{ durableRows: number; reasons: string[] }> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	// The ledger rows ARE the trace under test; a skipped line would shorten it.
	expect(read.skipped).toBe(0);
	const named = (subject: unknown) =>
		String(subject ?? "").includes(`charts/${chart}/`);
	return {
		durableRows: read.rows.filter((row) => {
			const metadata = row.metadata as Record<string, unknown> | undefined;
			return (
				row.phase === "degradation_ledger" &&
				metadata?.kind === "cross-file-row-retired" &&
				named(metadata.subject)
			);
		}).length,
		reasons: (
			getDegradationSummary().find((c) => c.kind === "cross-file-row-retired")
				?.latestReasons ?? []
		).flatMap((r) => (named(r.subject) ? [r.reason] : [])),
	};
}

/** A cell that fails before its own shutdown must not leave the process-wide
 *  registration to the next cell (the second session would be declined). */
let liveSession: { shutdown(): Promise<void> } | undefined;
afterEach(async () => {
	const live = liveSession;
	liveSession = undefined;
	await live?.shutdown().catch(() => {});
});

async function openSession(name: string) {
	setGlobalConfig({ guard: { enabled: true } });
	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	const ctx = () => makeCtx({ cwd: tmpDir, sessionId: `pi-lens-5020-${name}` });
	await pi.emit("session_start", makeSessionStartEvent(), ctx());
	await pi.emit("turn_start", {}, ctx());
	const session = {
		/** A command the host ran that changed `file` without naming it: the
		 *  `bash` tool_call (baseline), the change, then the tool_result. The
		 *  recovered write is opaque evidence, an unauthored run. */
		async opaqueWrite(file: string, content: string): Promise<void> {
			const toolCallId = `5020-opaque-${Date.now()}`;
			const input = { command: "node scripts/regen.mjs" };
			await pi.emit(
				"tool_call",
				{ toolName: "bash", toolCallId, input },
				ctx(),
			);
			fs.writeFileSync(file, content);
			await pi.emit(
				"tool_result",
				{
					toolName: "bash",
					toolCallId,
					input,
					isError: false,
					content: [{ type: "text", text: "ok" }],
				},
				ctx(),
			);
		},
		async write(file: string, content: string): Promise<string> {
			fs.writeFileSync(file, content);
			const r = (await pi.emit(
				"tool_result",
				{
					toolName: "write",
					input: { path: file, content },
					content: [{ type: "text", text: "wrote" }],
				},
				ctx(),
			)) as { content?: Array<{ text?: string }> } | undefined;
			return scrub((r?.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		async commitBlocked(): Promise<boolean> {
			const v = ((await pi.emit(
				"tool_call",
				{ toolName: "bash", input: { command: 'git commit -m "wip"' } },
				ctx(),
			)) ?? {}) as { block?: boolean };
			return v.block === true;
		},
		async endTurn(): Promise<string> {
			await pi.emit("turn_end", {}, ctx());
			const injected = (await pi.emit(
				"context_with_system",
				makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
				ctx(),
			)) as { messages?: Array<{ content: string }> } | undefined;
			await pi.emit("turn_start", {}, ctx());
			return scrub(
				(injected?.messages ?? []).map((m) => m.content).join("\n\n"),
			);
		},
		async sessionDiagnostics(): Promise<string> {
			const lens = pi.tools.get("lens_diagnostics") as Tool;
			const out = await lens.execute(
				`zz-${name}`,
				{ source: "session", mode: "all" },
				undefined,
				null,
				{ cwd: tmpDir },
			);
			return scrub((out.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		/** The footer the human reads: the real widget store through the real
		 *  renderer, wide enough that no row is truncated. */
		footer(): string {
			return renderWidget(160, { fg: (_color, text) => text }).join("\n");
		},
		async shutdown() {
			await pi.emit(
				"session_shutdown",
				{ type: "session_shutdown", reason: "quit" },
				ctx(),
			);
		},
	};
	liveSession = session;
	return session;
}

/**
 * The widget store's twin of the gate row (#5020 remainder): the row the
 * session listing (`lens_diagnostics source=session`) and the footer both
 * read. Soft, so one red names both surfaces.
 */
async function expectWidgetRowGone(s: {
	sessionDiagnostics(): Promise<string>;
	footer(): string;
}): Promise<void> {
	expect.soft(await s.sessionDiagnostics()).not.toContain("other-b.yaml");
	expect.soft(s.footer()).not.toContain("nil pointer");
	// The header's tally is the stored count, a separate field from the rows.
	expect.soft(s.footer()).not.toMatch(/●\d+E/);
}

/**
 * The mypy cells write three or four files through the real dispatch chain,
 * so they exceed vitest's 5000 ms default under a loaded host (5021 ms and
 * 5330 ms measured at load 27, round 3). They assert no elapsed time, so the
 * call site carries the timeout, as the #2512 note in vitest.config.ts says.
 */
const MYPY_CELL_TIMEOUT_MS = 20_000;

describe("#5020 witness: a cross-file row retires once its cited file is clean or gone", () => {
	/**
	 * Both write 1 and write 2 land on `deploy-a.yaml` while helm-lint cites
	 * `other-b.yaml`, so the row is recorded against the file the agent wrote.
	 */
	async function recordRowAgainstA(name: string) {
		const chart = createTwoFileChart(name);
		const s = await openSession(name);
		spawnRouter.state.helmLintStdout = ROW_B;
		expect(
			await s.write(chart.a, `${chart.body("Deployment")}# one\n`),
		).toContain("🔴 STOP");
		expect(
			await s.write(chart.a, `${chart.body("Deployment")}# two\n`),
		).toMatch(
			/Still unfixed: 1 blocker reported earlier; 1 with no line in this file\./,
		);
		expect(await s.commitBlocked()).toBe(true);
		// The widget store holds the same row: it is the control every retire cell
		// below turns off, so a cell that passed because the row never reached the
		// store (or the footer never drew it) would be vacuous.
		expect(await s.sessionDiagnostics()).toContain("other-b.yaml");
		expect(s.footer()).toContain("nil pointer");
		return { ...chart, s };
	}

	/**
	 * Recurrence (#5020): the agent fixes the file the row cites (here by
	 * writing it), and the record keyed on the OTHER file kept the row, so the
	 * commit gate stayed shut with nothing left to fix.
	 */
	it("opens the gate when the cited file is written clean", async () => {
		const { b, body, s } = await recordRowAgainstA("fixed-b");
		spawnRouter.state.helmLintStdout = "";
		await s.write(b, body("Service"));
		expect(await s.commitBlocked()).toBe(false);
		const end = await s.endTurn();
		expect(end).not.toContain("Unresolved from this turn");
		expect(end).toMatch(
			/Resolved this turn: charts\/fixed-b\/templates\/deploy-a\.yaml/,
		);
		// The retire is never silent: one ledger row, naming the clean verdict.
		expect(await retiredRow("fixed-b")).toEqual({
			durableRows: 1,
			reasons: [expect.stringContaining("reported nothing on it")],
		});
		// The widget store is the gate's twin (#5020 remainder): its row cites the
		// same file, so it leaves at the same point.
		await expectWidgetRowGone(s);
		await s.shutdown();
	});

	/**
	 * Recurrence (#5020): the cited file is deleted and nothing rewrites the
	 * file the row was recorded against, so no dispatch ever re-took its verdict.
	 */
	it("opens the gate when the cited file is deleted", async () => {
		const { b, s } = await recordRowAgainstA("deleted-b");
		fs.rmSync(b);
		const end = await s.endTurn();
		expect(end).not.toContain("Unresolved from this turn");
		// A deletion is not a clean verdict, so no file is reported "Resolved".
		expect(end).not.toContain("Resolved this turn");
		expect(await s.commitBlocked()).toBe(false);
		expect(await retiredRow("deleted-b")).toEqual({
			durableRows: 1,
			reasons: [expect.stringContaining("no longer exists")],
		});
		await expectWidgetRowGone(s);
		await s.shutdown();
	});

	/**
	 * Recurrence (#5020): the agent deletes the cited file and commits in the
	 * SAME turn, so no turn end has run to sweep. The commit gate is the read
	 * that matters, so it retires the row itself before it judges.
	 */
	it("opens the gate for a commit right after the cited file is deleted", async () => {
		const { b, s } = await recordRowAgainstA("commit-after-delete");
		fs.rmSync(b);
		expect(await s.commitBlocked()).toBe(false);
		await expectWidgetRowGone(s);
		await s.shutdown();
	});

	/**
	 * The issue's literal sequence: the cited file is deleted and the recorded
	 * file is rewritten clean. This cleared on master already (the premise is
	 * partially confirmed); it stays as the guard that the rewrite path keeps
	 * clearing.
	 */
	it("opens the gate when the cited file is deleted and the written file is rewritten clean", async () => {
		const { a, b, body, s } = await recordRowAgainstA("rewritten-a");
		fs.rmSync(b);
		spawnRouter.state.helmLintStdout = "";
		await s.write(a, `${body("Deployment")}# three\n`);
		const end = await s.endTurn();
		expect(end).not.toContain("Unresolved from this turn");
		expect(await s.commitBlocked()).toBe(false);
		await s.shutdown();
	});

	/**
	 * Recurrence (#5020), for a runner that is not helm: mypy follows imports
	 * and names the module a regression lands in (`mypy.ts`, #265 A2), so its
	 * row for `b.py` is recorded against the written `a.py` the same way, and
	 * writing `b.py` clean must retire it by the same rule.
	 */
	it(
		"opens the gate when the file another runner cites is written clean",
		{ timeout: MYPY_CELL_TIMEOUT_MS },
		async () => {
			const root = path.join(tmpDir, "pyproj");
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, "mypy.ini"),
				"[mypy]\nstrict = True\n",
			);
			const a = path.join(root, "a.py");
			const b = path.join(root, "b.py");
			fs.writeFileSync(a, "import b\n");
			fs.writeFileSync(b, "x: int = 1\n");
			const s = await openSession("mypy-cross-file");
			spawnRouter.state.mypyStdout = `${b}:1:10: error: Incompatible types in assignment [assignment]`;
			expect(await s.write(a, "import b\n# one\n")).toContain("🔴 STOP");
			expect(await s.write(a, "import b\n# two\n")).toMatch(/Still unfixed/);
			expect(await s.commitBlocked()).toBe(true);
			spawnRouter.state.mypyStdout = "";
			await s.write(b, "x: int = 2\n");
			expect(await s.commitBlocked()).toBe(false);
			expect(await s.endTurn()).not.toContain("Unresolved from this turn");
			await s.shutdown();
		},
	);

	/**
	 * Recurrence (PR #5033 round 3, CodeRabbit and Greptile on
	 * `verdictRunnerIds`): a runner that answers the cited file and fails on
	 * findings in ANOTHER module reports `failed` with `blocking_diagnostics`.
	 * That is a completed check (`hasUsableResult`), but the retire read only
	 * `succeeded`, so the row naming `b.py` outlived its cause and the commit
	 * stayed refused after every file was clean. The run still holds no blocker
	 * of its own on `b.py` (`stillReported`), which is what lets it speak.
	 */
	it(
		"opens the gate when the cited file's runner answers it while failing on another module",
		{ timeout: MYPY_CELL_TIMEOUT_MS },
		async () => {
			const root = path.join(tmpDir, "pyproj-failing");
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, "mypy.ini"),
				"[mypy]\nstrict = True\n",
			);
			const a = path.join(root, "a.py");
			const b = path.join(root, "b.py");
			const c = path.join(root, "c.py");
			fs.writeFileSync(a, "import b\n");
			fs.writeFileSync(b, "import c\nx: int = 1\n");
			fs.writeFileSync(c, "y: int = 1\n");
			const s = await openSession("mypy-failing-elsewhere");
			spawnRouter.state.mypyStdout = `${b}:2:10: error: Incompatible types in assignment [assignment]`;
			expect(await s.write(a, "import b\n# one\n")).toContain("🔴 STOP");
			expect(await s.write(a, "import b\n# two\n")).toMatch(/Still unfixed/);
			// mypy answers b.py and reports only c.py: `failed`, `blocking_diagnostics`.
			spawnRouter.state.mypyStdout = `${c}:1:10: error: Incompatible types in assignment [assignment]`;
			await s.write(b, "import c\nx: int = 2\n");
			// c.py's row now sits in b.py's record, so the gate is still shut here.
			expect(await s.commitBlocked()).toBe(true);
			spawnRouter.state.mypyStdout = "";
			await s.write(c, "y: int = 2\n");
			expect(await s.commitBlocked()).toBe(false);
			expect(await s.endTurn()).not.toContain("Unresolved from this turn");
			await s.shutdown();
		},
	);

	/**
	 * Negative (#4137 rule): a run without authorship withholds the blocker
	 * channel, so its empty observation is no evidence the cited file is clean.
	 * A command that regenerated `other-b.yaml` is opaque evidence, and it must
	 * not retire the row the way an authored write does.
	 */
	it("keeps the row when the cited file is changed by a command, not authored", async () => {
		const { b, body, s } = await recordRowAgainstA("opaque-b");
		spawnRouter.state.helmLintStdout = "";
		await s.opaqueWrite(b, `${body("Service")}# regenerated\n`);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.sessionDiagnostics()).toContain("other-b.yaml");
		await s.shutdown();
	});

	/**
	 * Negative: the raising runner reached no verdict on the cited file's write
	 * (helm failed), so "no blocker reported" is not a clean answer.
	 */
	it("keeps the row when the runner that raised it did not answer on the cited file", async () => {
		const { b, body, s } = await recordRowAgainstA("failed-b");
		spawnRouter.state.helmLintStdout = "Error: could not load chart";
		await s.write(b, body("Service"));
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.sessionDiagnostics()).toContain("other-b.yaml");
		await s.shutdown();
	});

	/**
	 * Negative: the cited file is written but helm still reports it, so the
	 * runner's verdict on it is not clean. The row stays in the record of the
	 * file it was recorded against, which turn end still lists beside the
	 * cited file's own record (the gate alone would stay shut on the latter).
	 */
	it("keeps the row while the cited file is still reported", async () => {
		const { b, body, s } = await recordRowAgainstA("still-bad-b");
		await s.write(b, `${body("Service")}# edit\n`);
		expect(await s.commitBlocked()).toBe(true);
		const end = await s.endTurn();
		expect(end).toContain(
			"Unresolved from this turn \u2014 charts/still-bad-b/templates/deploy-a.yaml",
		);
		await s.shutdown();
	});
});
