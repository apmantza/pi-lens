// flake-shape: real-process-spawn — the subject is what a REAL bash tool call writes into a REAL git checkout and what the model receives for it; the detector is git's own `status --porcelain` and a stubbed shell could not say whether the write was seen.
// flake-shape: raw-timer-wait — the 500 ms read-only bound is a live wall deadline racing a handler that this file holds open for 700 ms; a fake clock would settle the race instantly and the abandonment under test would never happen. The 10 s inner pipeline bound is the same kind of live deadline: the pipeline is held past it for 11.5 s, and no fake clock can move it.
// flake-shape: in-process-mock — the wrapper around `handleToolResult` is the only way to hold the real handler open past the host bound and to read its return value; the dispatch, the pipeline, the advisory queue and the pi session are real.
// flake-shape: in-process-mock — the wrapper around `runPipeline` only delays the REAL pipeline (a cold analyzer stand-in) so a dispatch outlives the inner 10 s bound; it runs the real pipeline after the hold.
/**
 * #5108 witness: a blocker on a file the agent wrote through a script (a
 * heredoc that is not a recognised write) is delivered or disclosed as
 * withheld, never rendered as a clean result.
 *
 * Recurrence prevented: pi session 01a192b9 (2026-10-31), where a python
 * heredoc wrote `config.ts` over an undefined name. The write is opaque, so
 * the recovered dispatch runs without authorship and withholds the STOP block
 * (#3226); the pipeline then dropped the blocker from every channel and the
 * tool result read `✓ JavaScript/TypeScript clean`. The host's 500 ms
 * read-only bound had also abandoned the handler, so the model saw `done`
 * and nothing about the blocker. Defect shape 10, silencing as fixing.
 *
 * Tier 2 (#4632), inline-factory mode: the BUILT extension in a real pi
 * `AgentSession`, pi's real `bash` tool, the real git recovery, and the real
 * bundled `debugger-statement` rule as the blocker. The one double is the
 * TIMING of `handleToolResult` (the real export, held for longer than the
 * read-only budget before it runs), the same seam
 * `tests/index-2939-tool-result-budget-witness.test.ts` uses.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "../clients/deps/typebox.js";
import { getDiagnosticLogger } from "../clients/diagnostic-logger.js";
import { getGlobalPiLensLogDir } from "../clients/probe-home-state.js";
import { describe, expect, it, vi } from "vitest";

/**
 * `holdMs` delays the real handler for a bash event so the host's 500 ms
 * bound abandons it. `pending` settles when every handler has finished,
 * so a case can wait for the late record instead of sleeping. `results` is
 * what the real handler RETURNED for each bash event, whether or not the
 * host was still listening: a cold dispatch outruns the 500 ms bound by
 * itself, so the model's transcript cannot say what the handler produced.
 */
const gate = vi.hoisted(() => ({
	holdMs: 0,
	/**
	 * #5108 remainder: a stand-in for a cold analyzer. The real `runPipeline`
	 * for a file named in `pipelineHoldFile` starts only after `pipelineHoldMs`
	 * (a live wall delay, because the 10 s inner bound is the subject) and after
	 * `pipelineLatch` settles. `pipelines` settle when each held run has finished.
	 */
	pipelineHoldMs: 0,
	pipelineReject: false,
	pipelineHoldFile: "",
	pipelineLatch: undefined as Promise<void> | undefined,
	pipelines: [] as Promise<void>[],
	pipelineStartedAt: [] as number[],
	/** A handler that, after `holdMs`, finishes having collected these notices. */
	fakeNotices: undefined as string[] | undefined,
	pending: [] as Promise<void>[],
	results: [] as Array<{ command: string; text: string }>,
}));
vi.mock("../clients/pipeline.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/pipeline.js")>();
	return {
		...actual,
		runPipeline: (...args: Parameters<typeof actual.runPipeline>) => {
			const held =
				gate.pipelineHoldFile !== "" &&
				args[0].filePath.endsWith(gate.pipelineHoldFile);
			if (!held) return actual.runPipeline(...args);
			const run = (async () => {
				gate.pipelineStartedAt.push(Date.now());
				if (gate.pipelineHoldMs > 0)
					await new Promise((resolve) =>
						setTimeout(resolve, gate.pipelineHoldMs),
					);
				await gate.pipelineLatch;
				if (gate.pipelineReject)
					throw new Error("#5165 late analyzer rejection");
				return actual.runPipeline(...args);
			})();
			gate.pipelines.push(
				run.then(
					() => undefined,
					() => undefined,
				),
			);
			return run;
		},
	};
});
vi.mock("../clients/runtime-tool-result.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/runtime-tool-result.js")>();
	return {
		...actual,
		handleToolResult: async (
			deps: Parameters<typeof actual.handleToolResult>[0],
		) => {
			if (deps.event.toolName !== "bash") return actual.handleToolResult(deps);
			if (gate.fakeNotices !== undefined) {
				const notices = gate.fakeNotices;
				const fake = (async () => {
					if (gate.holdMs > 0)
						await new Promise((resolve) => setTimeout(resolve, gate.holdMs));
					deps.withheldNotices?.push(...notices);
					return undefined;
				})();
				gate.pending.push(fake);
				return fake;
			}
			const work = (async () => {
				if (gate.holdMs > 0)
					await new Promise((resolve) => setTimeout(resolve, gate.holdMs));
				const result = await actual.handleToolResult(deps);
				const content = (result?.content ?? []) as Array<{ text?: string }>;
				gate.results.push({
					command: String((deps.event.input as { command?: string }).command),
					text: content.map((block) => block.text ?? "").join("\n"),
				});
				return result;
			})();
			gate.pending.push(
				work.then(
					() => undefined,
					() => undefined,
				),
			);
			return work;
		},
	};
});

import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { normalizeMapKey } from "../clients/path-utils.js";
import { getProjectChangeLogPath } from "../clients/project-changes.js";
import { execFileSync } from "./support/git-fixture-env.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	GUARDED_FLAGS,
	MARKED_FILE,
	RAN_MARKER,
	commitAttempt,
	endTurn,
	readTarget,
	step,
	toolResults,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A git checkout with one committed file, so the bash recovery has a base.
 * `dirty` names files left untracked after the commit. A script write to one
 * of them is not credited to the call (#5616: dirty before it), so the
 * withheld path is the one a case drives.
 */
function initRepo(name: string, dirty: readonly string[] = []): string {
	const dir = path.join(fixture.root, name, "proj");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "seed.ts"), CLEAN_FILE);
	git(["init", "-q"], dir);
	git(["config", "user.email", "t@t.local"], dir);
	git(["config", "user.name", "t"], dir);
	git(["add", "-A"], dir);
	git(["commit", "-qm", "base"], dir);
	for (const file of dirty)
		fs.writeFileSync(path.join(dir, file), "// placeholder\n");
	return fs.realpathSync.native(dir);
}

/**
 * A heredoc that writes the file through `node`. The write extractor
 * recognises `cat > path` and a few verbs, not an interpreter's own file
 * write, so the path comes back through the git recovery and runs without
 * authorship, exactly as the python heredoc did.
 */
function scriptWrite(file: string, content: string): Record<string, unknown> {
	return fauxToolCall("bash", {
		command: `node - <<'JS'\nrequire("node:fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)});\nJS`,
	});
}

/** How many times an inner pipeline bound has been ledgered in the fixture's log. */
async function innerBoundRows(label = "pipeline-analysis"): Promise<number> {
	await flushLatencyLog();
	return readNdjsonRows(getLatencyLogPath()).rows.filter(
		(row) =>
			row.phase === "degradation_ledger" &&
			row.filePath === `tool_result_edit:${label}`,
	).length;
}

/** How many `withheld_blocker_late_advisory` rows the fixture's log holds. */
async function lateAdvisoryRows(): Promise<number> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	expect(read.skipped).toBe(0);
	return read.rows.filter(
		(row) => row.phase === "withheld_blocker_late_advisory",
	).length;
}

/** How many late REJECTION disclosures the fixture's log holds (#5165 F3). */
async function crashLateRows(): Promise<number> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	expect(read.skipped).toBe(0);
	return read.rows.filter(
		(row) =>
			row.phase === "withheld_blocker_late_advisory" &&
			(row.metadata as { crash?: boolean } | undefined)?.crash === true,
	).length;
}

/**
 * #5616: the causes of the `script-write-credit-withheld` records the
 * fixture's log holds for `repo` (subject `<cause>:<root>`), sorted.
 */
async function creditWithheldCauses(repo: string): Promise<string[]> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	expect(read.skipped).toBe(0);
	const suffix = `:${normalizeMapKey(repo)}`;
	return read.rows
		.filter(
			(row) =>
				row.phase === "degradation_ledger" &&
				(row.metadata as { kind?: string } | undefined)?.kind ===
					"script-write-credit-withheld",
		)
		.map((row) => String((row.metadata as { subject?: unknown }).subject))
		.filter((subject) => subject.endsWith(suffix))
		.map((subject) => subject.slice(0, -suffix.length))
		.sort();
}

/** #5616: the `credited` counts of `repo`'s `opaque_mutation_recovered` rows. */
async function creditedCounts(repo: string): Promise<number[]> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	expect(read.skipped).toBe(0);
	return read.rows
		.filter(
			(row) =>
				row.phase === "opaque_mutation_recovered" &&
				(row.metadata as { root?: unknown } | undefined)?.root === repo,
		)
		.map((row) =>
			Number((row.metadata as { credited?: unknown }).credited ?? 0),
		);
}

/**
 * #5616 review F1: the `pre_edit_capture` rows of files under `repo`, as
 * `[result, runners]`. A credited script write's seed is captured from the
 * file's HEAD copy, which only the lanes that read the content fact can see.
 */
async function preEditCaptureRows(repo: string): Promise<string[][]> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	expect(read.skipped).toBe(0);
	return read.rows
		.filter(
			(row) =>
				row.phase === "pre_edit_capture" &&
				String(row.filePath).startsWith(repo),
		)
		.map((row) => [
			String(row.result),
			String((row.metadata as { runners?: unknown }).runners ?? ""),
		]);
}

function everyText(requests: readonly (readonly PiMessage[])[]): string {
	return requests
		.flatMap((messages) => messages)
		.map((message) => JSON.stringify(message.content ?? ""))
		.join("\n");
}

describe("#5108: a blocker on a script-written file is never rendered clean", () => {
	it(
		"names the file and count in the tool result and leaves the commit gate open",
		{ timeout: 60_000 },
		async () => {
			gate.results.length = 0;
			const repo = initRepo("in-time", ["opaque.ts"]);
			const handle = await startPiSession({
				root: fixture.root,
				cwd: repo,
				flags: new Map(GUARDED_FLAGS),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [
					step(scriptWrite("opaque.ts", BLOCKING_FILE), "writing"),
					step(commitAttempt(), "committing"),
					endTurn("turn 1 done"),
					step(fauxToolCall("lens_diagnostics", { mode: "all" }), "listing"),
					endTurn("turn 2 done"),
				],
			});
			await handle.prompt("write the file with a script");

			await Promise.all(gate.pending);
			await handle.prompt("list the findings");
			const write = gate.results.find((r) => r.command.includes("opaque.ts"));
			const [, commit] = toolResults(handle.requests.at(-1) ?? [], "bash");
			expect(fs.readFileSync(path.join(repo, "opaque.ts"), "utf8")).toBe(
				BLOCKING_FILE,
			);
			// DELIVERY: the model is told a blocker exists and where, and never
			// reads the all-clear line over it.
			expect(write?.text).toContain("opaque.ts");
			// One or two: the bundled rule always raises it and biome's `noDebugger`
			// sometimes joins it (`BLOCKING_FILE`).
			expect(write?.text).toMatch(/[12] blocking findings? in opaque\.ts/);
			expect(write?.text).toContain("withheld");
			expect(write?.text).toContain("lens_diagnostics mode=all");
			expect(write?.text).not.toMatch(/clean/);
			// #5616 part 1: each blocker's line and rule, the one fact pi-lens holds
			// (the file changed during this call), and a fix asked for if the call
			// wrote it. Recurrence: pi session 01a1db69 (2026-11-14), where an agent
			// read "cannot tell it was your edit" and left its script's blockers.
			expect(write?.text).toContain("L3 debugger-statement");
			expect(write?.text).toContain("the file changed while this call ran");
			expect(write?.text).toContain("If this call wrote it, fix");
			expect(await creditWithheldCauses(repo)).toEqual(["dirty-before"]);
			// Unauthored bytes never latch the commit gate (#3226, #4137): the
			// disclosure is not a blocker record.
			expect(commit?.text).not.toContain(GATE_BLOCK);
			expect(commit?.text).toContain(RAN_MARKER);
			const [listed] = toolResults(
				handle.requests.at(-1) ?? [],
				"lens_diagnostics",
			);
			// The pointer holds: the withheld finding is in the session cache the
			// disclosure names.
			expect(listed?.text).toContain("opaque.ts");
			expect(listed?.text).toContain("[debugger-statement]");
			expect(handle.errors).toEqual([]);
		},
	);

	it(
		"leaves an authored blocker standing when a later script write still holds one",
		{ timeout: 60_000 },
		async () => {
			// Pins #3226/#4137/#4484: the run without authorship neither replaces the
			// authored record with its own nor retires it, so the commit gate keeps
			// naming the blocker the agent was shown, and the disclosure is additive.
			gate.results.length = 0;
			const repo = initRepo("authored-then-script");
			const handle = await startPiSession({
				root: fixture.root,
				cwd: repo,
				flags: new Map(GUARDED_FLAGS),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [
					step(
						fauxToolCall("write", {
							path: path.join(repo, "kept.ts"),
							content: BLOCKING_FILE,
						}),
						"writing",
					),
					step(
						scriptWrite("kept.ts", `${BLOCKING_FILE}// edited\n`),
						"scripting",
					),
					step(commitAttempt(), "committing"),
					endTurn("done"),
				],
			});
			await handle.prompt("write it, then rewrite it with a script");
			await Promise.all(gate.pending);

			const [authored] = toolResults(handle.requests.at(-1) ?? [], "write");
			expect(authored?.text).toContain("\u{1F534} STOP");
			// #5165: truthful late visibility must not relabel an in-bound STOP.
			await getDiagnosticLogger().flush();
			const inlineRead = readNdjsonRows(
				path.join(
					getGlobalPiLensLogDir(),
					"logs",
					`${new Date().toISOString().slice(0, 10)}.jsonl`,
				),
			);
			expect(inlineRead.skipped).toBe(0);
			expect(inlineRead.rows).toContainEqual(
				expect.objectContaining({
					filePath: path.join(repo, "kept.ts"),
					ruleId: "debugger-statement",
					shownInline: true,
					shownToAgent: true,
				}),
			);

			const scripted = gate.results.find((r) =>
				r.command.includes("// edited"),
			);
			expect(scripted?.text).toMatch(/[12] blocking findings? in kept\.ts/);
			expect(scripted?.text).not.toContain("\u{1F534} STOP");
			const [, commit] = toolResults(handle.requests.at(-1) ?? [], "bash");
			expect(commit?.text).toContain(GATE_BLOCK);
			expect(commit?.text).not.toContain(RAN_MARKER);
			expect(handle.errors).toEqual([]);
		},
	);

	it(
		"queues the disclosure for the next context call when the host abandoned the handler",
		{ timeout: 60_000 },
		async () => {
			gate.results.length = 0;
			gate.holdMs = 700;
			try {
				const repo = initRepo("abandoned", ["opaque.ts"]);
				const rowsBefore = await lateAdvisoryRows();
				const handle = await startPiSession({
					root: fixture.root,
					cwd: repo,
					flags: new Map(GUARDED_FLAGS),
					inlineFactory: async () => (await import("../index.js")).default,
					responses: [
						step(scriptWrite("opaque.ts", BLOCKING_FILE), "writing"),
						endTurn("turn 1 done"),
						// Turn 2 writes no file: its turn end is the first chance to say it.
						endTurn("turn 2 done"),
					],
				});
				await handle.prompt("write the file with a script");
				const [write] = toolResults(handle.requests.at(-1) ?? [], "bash");
				// The host gave up on the handler: the model saw no pi-lens text.
				expect(write?.text).not.toContain("opaque.ts");
				// The abandoned handler finishes later and records its verdict.
				await Promise.all(gate.pending);
				await handle.prompt("anything else?");

				const surface = everyText(handle.requests);
				expect(surface).toContain("opaque.ts");
				expect(surface).toContain("withheld");
				expect(surface).toMatch(/abandoned/);
				expect(surface).not.toContain("\u2713");
				// The queued advisory leaves one bounded record for the call. The
				// file is the fixture root's, so an earlier case's row is subtracted.
				expect(await lateAdvisoryRows()).toBe(rowsBefore + 1);
				expect(handle.errors).toEqual([]);
			} finally {
				gate.holdMs = 0;
			}
		},
	);
	it(
		"queues nothing when the handler finished inside the bound",
		{ timeout: 60_000 },
		async () => {
			// The tool result already carried the disclosure: a second copy at the
			// next context call would be noise.
			gate.results.length = 0;
			gate.fakeNotices = [
				"\u26a0 1 blocking finding in fast.ts withheld: test",
			];
			try {
				const repo = initRepo("in-bound");
				const rowsBefore = await lateAdvisoryRows();
				const handle = await startPiSession({
					root: fixture.root,
					cwd: repo,
					flags: new Map(GUARDED_FLAGS),
					inlineFactory: async () => (await import("../index.js")).default,
					responses: [
						step(scriptWrite("fast.ts", CLEAN_FILE), "writing"),
						endTurn("turn 1 done"),
						endTurn("turn 2 done"),
					],
				});
				await handle.prompt("write the file with a script");
				await handle.prompt("anything else?");

				expect(await lateAdvisoryRows()).toBe(rowsBefore);
				expect(everyText(handle.requests)).not.toContain("fast.ts withheld");
				expect(handle.errors).toEqual([]);
			} finally {
				gate.fakeNotices = undefined;
			}
		},
	);

	it(
		"says nothing about an abandoned check that withheld nothing",
		{ timeout: 60_000 },
		async () => {
			// The abandonment alone is not the disclosure: a clean script write the
			// host stopped waiting for has nothing to report.
			gate.results.length = 0;
			gate.holdMs = 700;
			try {
				const repo = initRepo("abandoned-clean");
				const rowsBefore = await lateAdvisoryRows();
				const handle = await startPiSession({
					root: fixture.root,
					cwd: repo,
					flags: new Map(GUARDED_FLAGS),
					inlineFactory: async () => (await import("../index.js")).default,
					responses: [
						step(scriptWrite("tidy.ts", CLEAN_FILE), "writing"),
						endTurn("turn 1 done"),
						endTurn("turn 2 done"),
					],
				});
				await handle.prompt("write the file with a script");
				await Promise.all(gate.pending);
				await handle.prompt("anything else?");

				expect(gate.results.some((r) => r.command.includes("tidy.ts"))).toBe(
					true,
				);
				expect(await lateAdvisoryRows()).toBe(rowsBefore);
				expect(everyText(handle.requests)).not.toContain("abandoned");
				expect(handle.errors).toEqual([]);
			} finally {
				gate.holdMs = 0;
			}
		},
	);
	it(
		"bounds the queued advisory to five notices and counts the rest",
		{ timeout: 60_000 },
		async () => {
			// A script that writes many files must not queue an unbounded message.
			gate.results.length = 0;
			gate.holdMs = 700;
			gate.fakeNotices = Array.from(
				{ length: 7 },
				(_, i) => `\u26a0 1 blocking finding in file${i}.ts withheld: test`,
			);
			try {
				const repo = initRepo("capped");
				const handle = await startPiSession({
					root: fixture.root,
					cwd: repo,
					flags: new Map(GUARDED_FLAGS),
					inlineFactory: async () => (await import("../index.js")).default,
					responses: [
						step(scriptWrite("many.ts", CLEAN_FILE), "writing"),
						endTurn("turn 1 done"),
						endTurn("turn 2 done"),
					],
				});
				await handle.prompt("write the files with a script");
				await Promise.all(gate.pending);
				await handle.prompt("anything else?");

				const surface = everyText(handle.requests);
				expect(surface).toContain("file4.ts withheld");
				expect(surface).not.toContain("file5.ts withheld");
				expect(surface).toContain("+2 more");
				expect(handle.errors).toEqual([]);
			} finally {
				gate.holdMs = 0;
				gate.fakeNotices = undefined;
			}
		},
	);

	describe("a pipeline slower than the 10 s inner bound (#5108 remainder)", () => {
		// Recurrence prevented: a first-run analyzer (cold Pyright) outruns the
		// inner `pipeline-analysis` bound, `handleToolResult` returns before the
		// tail that collects the withheld line, and #5114's late advisory reads an
		// empty array. The line then reached no channel (r2 probe case B:
		// `[0,0,0,0,0,0,0,0]` requests carried it). Defect shape 10.
		const SETTLE_TAIL_MS = 1_000;

		/** The held run has finished; give the dispatch tail a moment to queue. */
		async function afterPipelines(): Promise<void> {
			await Promise.all(gate.pipelines);
			await new Promise((resolve) => setTimeout(resolve, SETTLE_TAIL_MS));
		}

		/** Occurrences, not messages: the drain may join advisories into one message. */
		function copiesOfAdvisory(
			requests: readonly (readonly PiMessage[])[],
		): number {
			return everyText(requests).split("was abandoned").length - 1;
		}

		function hold(file: string, ms: number): void {
			gate.pipelineHoldFile = file;
			gate.pipelineHoldMs = ms;
			gate.pipelines.length = 0;
			gate.pipelineStartedAt.length = 0;
		}
		function release(): void {
			gate.pipelineHoldFile = "";
			gate.pipelineHoldMs = 0;
			gate.pipelineLatch = undefined;
			gate.pipelineReject = false;
		}

		it.each(["classified", "observed"] as const)(
			"#5165 %s late authored blocker closes the commit gate and reports honest inline delivery",
			{ timeout: 90_000 },
			async (member) => {
				// Recurrence: both authored dispatch callers abandoned their verdict
				// after 10 s, leaving a real blocker with an open commit gate.
				hold("authored.ts", 11_500);
				try {
					const repo = initRepo(`5165-${member}`);
					const target = path.join(repo, "authored.ts");
					fs.writeFileSync(target, CLEAN_FILE);
					const call =
						member === "classified"
							? fauxToolCall("write", { path: target, content: BLOCKING_FILE })
							: fauxToolCall("change_module", { path: target });
					const handle = await startPiSession({
						root: fixture.root,
						cwd: repo,
						flags: new Map(GUARDED_FLAGS),
						inlineFactory: async () => (await import("../index.js")).default,
						customTools: [
							{
								name: "change_module",
								label: "Change module",
								description: "Change the module",
								parameters: Type.Object({ path: Type.String() }),
								async execute() {
									fs.writeFileSync(target, BLOCKING_FILE);
									return {
										content: [{ type: "text", text: "changed" }],
										details: undefined,
									};
								},
							},
						],
						responses: [
							step(fauxToolCall("read", { path: target })),
							step(call),
							endTurn("write done"),
							step(commitAttempt()),
							endTurn("commit done"),
						],
					});
					await handle.prompt("change the module");
					await afterPipelines();
					await flushLatencyLog();
					const boundLabel =
						member === "classified"
							? "pipeline-analysis"
							: "observed-tool-result-analysis";
					expect(
						readNdjsonRows(getLatencyLogPath()).rows.some(
							(row) =>
								row.phase === "degradation_ledger" &&
								row.filePath === `tool_result_edit:${boundLabel}`,
						),
					).toBe(true);
					await handle.prompt("commit it");
					const commit = toolResults(handle.requests.at(-1) ?? [], "bash").at(
						-1,
					);
					expect(commit?.text).toContain(GATE_BLOCK);
					expect(commit?.text).not.toContain(RAN_MARKER);
					expect(everyText(handle.requests)).toContain("was abandoned");
					await getDiagnosticLogger().flush();
					const read = readNdjsonRows(
						path.join(
							getGlobalPiLensLogDir(),
							"logs",
							`${new Date().toISOString().slice(0, 10)}.jsonl`,
						),
					);
					expect(read.skipped).toBe(0);
					const findings = read.rows.filter(
						(row) =>
							row.filePath === target && row.ruleId === "debugger-statement",
					);
					expect(findings.length).toBeGreaterThan(0);
					expect(findings.every((row) => row.shownInline === false)).toBe(true);
					expect(handle.errors).toEqual([]);
				} finally {
					release();
				}
			},
		);

		it.each([
			["classified", "rejected"],
			["observed", "rejected"],
			["classified", "replaced"],
			["observed", "replaced"],
		] as const)(
			"#5165 %s late %s result stays with its writing session",
			{ timeout: 90_000 },
			async (member, state) => {
				// Recurrence: a late failed analysis must be disclosed; a replaced
				// session's late verdict must never gate or message its replacement.
				hold("authored.ts", 11_500);
				let open = () => {};
				if (state === "replaced")
					gate.pipelineLatch = new Promise<void>((resolve) => {
						open = resolve;
					});
				gate.pipelineReject = state === "rejected";
				const crashRowsBefore =
					state === "rejected" ? await crashLateRows() : 0;
				try {
					const repo = initRepo(`5165-${member}-${state}`);
					const target = path.join(repo, "authored.ts");
					fs.writeFileSync(target, CLEAN_FILE);
					const handle = await startPiSession({
						root: fixture.root,
						cwd: repo,
						flags: new Map(GUARDED_FLAGS),
						inlineFactory: async () => (await import("../index.js")).default,
						customTools: [
							{
								name: "change_module",
								label: "Change module",
								description: "Change module",
								parameters: Type.Object({ path: Type.String() }),
								async execute() {
									fs.writeFileSync(target, BLOCKING_FILE);
									return {
										content: [{ type: "text", text: "changed" }],
										details: undefined,
									};
								},
							},
						],
						responses: [
							step(fauxToolCall("read", { path: target })),
							step(
								member === "classified"
									? fauxToolCall("write", {
											path: target,
											content: BLOCKING_FILE,
										})
									: fauxToolCall("change_module", { path: target }),
							),
							endTurn("done"),
							step(commitAttempt()),
							endTurn("done"),
						],
					});
					await handle.prompt("change module");
					const live =
						state === "replaced"
							? await handle.restart({ reason: "new" }, [
									step(commitAttempt()),
									endTurn("done"),
								])
							: handle;
					open();
					await afterPipelines();
					await live.prompt("commit it");
					const commit = toolResults(live.requests.at(-1) ?? [], "bash").at(-1);
					if (state === "replaced") {
						expect(commit?.text).not.toContain(GATE_BLOCK);
						expect(everyText(live.requests)).not.toContain("was abandoned");
					} else {
						expect(commit?.text).toContain(GATE_BLOCK);
						expect(everyText(live.requests)).toContain("was abandoned");
						expect(everyText(live.requests)).toContain("analysis");
						if (state === "rejected") {
							// #5165 F3: the late rejection discloses on the same phase as the
							// late success, so the undercount is closed; `crash` keeps the two
							// populations apart. One record for this call.
							expect(await crashLateRows()).toBe(crashRowsBefore + 1);
							const crashRow = readNdjsonRows(getLatencyLogPath())
								.rows.filter(
									(row) =>
										row.phase === "withheld_blocker_late_advisory" &&
										(row.metadata as { crash?: boolean } | undefined)?.crash ===
											true,
								)
								.at(-1);
							expect(crashRow?.metadata).toMatchObject({
								late: "inner-bound",
								notices: 1,
							});
						}
					}
					expect(live.errors).toEqual([]);
				} finally {
					open();
					release();
				}
			},
		);

		it(
			"delivers the withheld line once at the next context when the dispatch outlives the bound, and leaves the commit gate open",
			{ timeout: 90_000 },
			async () => {
				hold("opaque.ts", 11_500);
				try {
					const repo = initRepo("slow-pipeline", ["opaque.ts"]);
					const rowsBefore = await lateAdvisoryRows();
					const handle = await startPiSession({
						root: fixture.root,
						cwd: repo,
						flags: new Map(GUARDED_FLAGS),
						inlineFactory: async () => (await import("../index.js")).default,
						responses: [
							step(scriptWrite("opaque.ts", BLOCKING_FILE), "writing"),
							endTurn("turn 1 done"),
							endTurn("turn 2 done"),
							step(commitAttempt(), "committing"),
							endTurn("turn 3 done"),
						],
					});
					await handle.prompt("write the file with a script");
					const [write] = toolResults(handle.requests.at(-1) ?? [], "bash");
					expect(write?.text).not.toContain("opaque.ts");
					await afterPipelines();
					await handle.prompt("anything else?");

					const surface = everyText(handle.requests);
					expect(surface).toContain("opaque.ts");
					expect(surface).toContain("withheld");
					expect(surface).toMatch(/abandoned/);
					expect(copiesOfAdvisory(handle.requests)).toBe(1);
					expect(await lateAdvisoryRows()).toBe(rowsBefore + 1);
					const rows = readNdjsonRows(getLatencyLogPath()).rows.filter(
						(row) => row.phase === "withheld_blocker_late_advisory",
					);
					expect(rows.at(-1)?.metadata).toMatchObject({
						late: "inner-bound",
						notices: 1,
					});

					// Unauthored bytes never latch the commit gate (#3226, #4137): the
					// late disclosure is an advisory, not a blocker record.
					await handle.prompt("commit it");
					const commit = toolResults(handle.requests.at(-1) ?? [], "bash").at(
						-1,
					);
					expect(commit?.text).not.toContain(GATE_BLOCK);
					expect(commit?.text).toContain(RAN_MARKER);
					expect(handle.errors).toEqual([]);
				} finally {
					release();
				}
			},
		);

		it(
			"delivers exactly one copy when the dispatch ends inside the 10 s bound but past the host's",
			{ timeout: 60_000 },
			async () => {
				// Two writers can carry the line (#5114's work.then and the inner-bound
				// continuation); exactly one of them has the notice for a given call.
				hold("opaque.ts", 2_000);
				try {
					const repo = initRepo("mid-pipeline", ["opaque.ts"]);
					const rowsBefore = await lateAdvisoryRows();
					const handle = await startPiSession({
						root: fixture.root,
						cwd: repo,
						flags: new Map(GUARDED_FLAGS),
						inlineFactory: async () => (await import("../index.js")).default,
						responses: [
							step(scriptWrite("opaque.ts", BLOCKING_FILE), "writing"),
							endTurn("turn 1 done"),
							endTurn("turn 2 done"),
						],
					});
					await handle.prompt("write the file with a script");
					await afterPipelines();
					await handle.prompt("anything else?");

					expect(everyText(handle.requests)).toContain("withheld");
					expect(copiesOfAdvisory(handle.requests)).toBe(1);
					expect(await lateAdvisoryRows()).toBe(rowsBefore + 1);
					expect(handle.errors).toEqual([]);
				} finally {
					release();
				}
			},
		);

		it(
			"reports no inline delivery when the host wall discarded the result inside the inner bound",
			{ timeout: 60_000 },
			async () => {
				// Recurrence (Greptile on #5196): the host's 500 ms wall for a
				// non-edit-class tool result discards what pi-lens returns while the
				// dispatch inside still has its own 10 s bound to run in. A pipeline
				// that settles at 2 s logged `shownInline: true` for text the model
				// never saw, so every opaque bash write and third-party write sat in a
				// band of false rows up to 9.5 s wide. Defect shape 10.
				hold("authored.ts", 2_000);
				try {
					const observedBoundRowsBefore = await innerBoundRows(
						"observed-tool-result-analysis",
					);
					const repo = initRepo("5165-host-wall");
					const target = path.join(repo, "authored.ts");
					fs.writeFileSync(target, CLEAN_FILE);
					const handle = await startPiSession({
						root: fixture.root,
						cwd: repo,
						flags: new Map(GUARDED_FLAGS),
						inlineFactory: async () => (await import("../index.js")).default,
						customTools: [
							{
								name: "change_module",
								label: "Change module",
								description: "Change module",
								parameters: Type.Object({ path: Type.String() }),
								async execute() {
									fs.writeFileSync(target, BLOCKING_FILE);
									return {
										content: [{ type: "text", text: "changed" }],
										details: undefined,
									};
								},
							},
						],
						responses: [
							step(fauxToolCall("read", { path: target })),
							step(fauxToolCall("change_module", { path: target })),
							endTurn("write done"),
							step(commitAttempt()),
							endTurn("commit done"),
						],
					});
					await handle.prompt("change the module");
					await afterPipelines();
					// The inner 10 s bound did NOT fire: the dispatch settled inside it,
					// after the host's wall. Without that, the case would be testing the
					// inner bound instead of the host's. Counted, not read: an earlier
					// case in this file ledgers the same subject once per session.
					expect(await innerBoundRows("observed-tool-result-analysis")).toBe(
						observedBoundRowsBefore,
					);
					// The text still reaches the model: the settled dispatch recorded the
					// blocker, so the next turn's commit gate names it.
					await handle.prompt("commit it");
					const commit = toolResults(handle.requests.at(-1) ?? [], "bash").at(
						-1,
					);
					expect(commit?.text).toContain(GATE_BLOCK);
					expect(commit?.text).toContain("\u{1F534} STOP");
					await getDiagnosticLogger().flush();
					const read = readNdjsonRows(
						path.join(
							getGlobalPiLensLogDir(),
							"logs",
							`${new Date().toISOString().slice(0, 10)}.jsonl`,
						),
					);
					expect(read.skipped).toBe(0);
					const findings = read.rows.filter(
						(row) =>
							row.filePath === target && row.ruleId === "debugger-statement",
					);
					expect(findings.length).toBeGreaterThan(0);
					// The row is honest: pi discarded the result, so nothing was inline.
					expect(findings.every((row) => row.shownInline === false)).toBe(true);
					expect(handle.errors).toEqual([]);
				} finally {
					release();
				}
			},
		);

		it(
			"queues nothing for a clean file whose dispatch outlives the bound",
			{ timeout: 90_000 },
			async () => {
				hold("tidy.ts", 11_500);
				try {
					const repo = initRepo("slow-clean");
					const rowsBefore = await lateAdvisoryRows();
					const handle = await startPiSession({
						root: fixture.root,
						cwd: repo,
						flags: new Map(GUARDED_FLAGS),
						inlineFactory: async () => (await import("../index.js")).default,
						responses: [
							step(scriptWrite("tidy.ts", CLEAN_FILE), "writing"),
							endTurn("turn 1 done"),
							endTurn("turn 2 done"),
						],
					});
					await handle.prompt("write the file with a script");
					await afterPipelines();
					await handle.prompt("anything else?");

					expect(gate.pipelineStartedAt.length).toBeGreaterThan(0);
					expect(await lateAdvisoryRows()).toBe(rowsBefore);
					expect(copiesOfAdvisory(handle.requests)).toBe(0);
					expect(everyText(handle.requests)).not.toContain("abandoned");
					expect(handle.errors).toEqual([]);
				} finally {
					release();
				}
			},
		);

		it(
			"queues nothing when the session was replaced before the dispatch settled",
			{ timeout: 90_000 },
			async () => {
				// The latch holds the dispatch until the inner bound has fired AND the
				// session is gone, so the settle is the only thing left to deliver.
				let open: () => void = () => undefined;
				gate.pipelineLatch = new Promise<void>((resolve) => {
					open = resolve;
				});
				hold("opaque.ts", 0);
				try {
					const repo = initRepo("slow-replaced", ["opaque.ts"]);
					const rowsBefore = await lateAdvisoryRows();
					const boundRowsBefore = await innerBoundRows();
					const first = await startPiSession({
						root: fixture.root,
						cwd: repo,
						flags: new Map(GUARDED_FLAGS),
						inlineFactory: async () => (await import("../index.js")).default,
						responses: [
							step(scriptWrite("opaque.ts", BLOCKING_FILE), "writing"),
							endTurn("turn 1 done"),
						],
					});
					await first.prompt("write the file with a script");
					// Let the 10 s inner bound fire (a live deadline, so a live wait),
					// with a margin: its timer was armed after the dispatch started.
					const [startedAt] = gate.pipelineStartedAt;
					await new Promise((resolve) =>
						setTimeout(
							resolve,
							Math.max(0, (startedAt ?? Date.now()) + 10_800 - Date.now()),
						),
					);
					const next = await first.restart({ reason: "new" }, [
						endTurn("fresh turn 1 done"),
						endTurn("fresh turn 2 done"),
					]);
					open();
					await afterPipelines();
					await next.prompt("start fresh");
					await next.prompt("anything else?");

					// The ledger row is only written for the deadline, so a bound that
					// had not fired (an aborted wait) would make this case vacuous.
					expect(await innerBoundRows()).toBe(boundRowsBefore + 1);
					expect(copiesOfAdvisory(next.requests)).toBe(0);
					expect(everyText(next.requests)).not.toContain("opaque.ts");
					expect(await lateAdvisoryRows()).toBe(rowsBefore);
					expect(next.errors).toEqual([]);
				} finally {
					release();
				}
			},
		);
	});
});

/**
 * #5616 part 2: a successful bash call is credited with a file it changed
 * without naming it when the file was clean before the call (or absent), git
 * lists it changed in the call's window, and no other writer pi-lens recorded
 * touched it since the call began. The file then gets the STOP and the gate.
 * Every other case stays on the withheld line above, with one record per cause.
 *
 * Recurrence prevented: pi session 01a1db69 (pi-webaio, 2026-11-14, turn 81),
 * where `python3 /tmp/fix_storage.py` rewrote the clean, committed
 * `src/storage.ts` and its two biome blockers went out withheld; the agent
 * moved on.
 */
describe("#5616: a script write the call is credited with", () => {
	const havePython =
		spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

	/** One prompt, its pending handlers, then a second prompt that commits. */
	async function writeThenCommit(
		repo: string,
		call: Record<string, unknown>,
	): Promise<{ write: string; commit: string; requests: string }> {
		gate.results.length = 0;
		const handle = await startPiSession({
			root: fixture.root,
			cwd: repo,
			flags: new Map(GUARDED_FLAGS),
			inlineFactory: async () => (await import("../index.js")).default,
			responses: [
				step(call, "writing"),
				endTurn("turn 1 done"),
				step(commitAttempt(), "committing"),
				endTurn("turn 2 done"),
			],
		});
		await handle.prompt("change the file with a script");
		await Promise.all(gate.pending);
		await handle.prompt("commit it");
		const commit = toolResults(handle.requests.at(-1) ?? [], "bash").at(-1);
		expect(handle.errors).toEqual([]);
		return {
			write: gate.results.at(0)?.text ?? "",
			commit: commit?.text ?? "",
			requests: everyText(handle.requests),
		};
	}

	it.skipIf(!havePython)(
		"credits a python script that rewrites a clean tracked file: STOP, then the commit gate shuts",
		{ timeout: 90_000 },
		async () => {
			// The trigger's own form: `cd`, a heredoc that writes the script
			// outside the project, then `python3` running it.
			const repo = initRepo("5616-python");
			const script = path.join(path.dirname(repo), "fix.py");
			const run = await writeThenCommit(
				repo,
				fauxToolCall("bash", {
					command: `cd ${repo} && cat > ${script} <<'PY'\npath = 'seed.ts'\ns = open(path).read()\nopen(path, 'w').write(s.replace('\\treturn a;', '\\tdebugger;\\n\\treturn a;'))\nprint('ok')\nPY\npython3 ${script}`,
				}),
			);
			expect(fs.readFileSync(path.join(repo, "seed.ts"), "utf8")).toBe(
				BLOCKING_FILE,
			);
			expect(run.write).toContain("\u{1F534} STOP");
			expect(run.write).toContain("debugger");
			expect(run.write).not.toContain("withheld");
			expect(run.commit).toContain(GATE_BLOCK);
			expect(run.commit).not.toContain(RAN_MARKER);
			expect(await creditedCounts(repo)).toEqual([1]);
			expect(await creditWithheldCauses(repo)).toEqual([]);
		},
	);

	it(
		"credits a node script that creates a new file",
		{ timeout: 90_000 },
		async () => {
			// Absent before the call is clean before it: no other bytes were there.
			const repo = initRepo("5616-node-new");
			const run = await writeThenCommit(
				repo,
				scriptWrite("made.ts", BLOCKING_FILE),
			);
			expect(run.write).toContain("\u{1F534} STOP");
			expect(run.write).not.toContain("withheld");
			expect(run.commit).toContain(GATE_BLOCK);
			expect(await creditedCounts(repo)).toEqual([1]);
		},
	);

	// #5616 review F1: a credited script write is judged against the bytes the
	// file held before the call (its HEAD copy, as it was clean), the way an
	// edit is judged against its pre-edit seed. Recurrence prevented: a
	// formatter-shaped script over 8 committed files that each held an old
	// blocker gave 8 STOP blocks and shut the gate; the edit tool gives none.
	// The blocker is `ts-weak-hash`, which only the tree-sitter lane raises.
	it(
		"judges a credited script write against the file's HEAD copy: old blockers stay quiet, a new one stops",
		{ timeout: 150_000 },
		async () => {
			const repo = initRepo("5616-head-seed");
			const files = Array.from({ length: 8 }, (_, i) => `legacy${i}.ts`);
			for (const file of [...files, "other.ts"])
				fs.writeFileSync(path.join(repo, file), MARKED_FILE);
			git(["add", "-A"], repo);
			git(["commit", "-qm", "legacy"], repo);
			const reformat = `node -e 'const fs = require("node:fs"); for (const f of ${JSON.stringify(files)}) fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/\\t/g, "    ")); fs.writeFileSync("made.ts", "export const m = 1;\\n")'`;
			const added = `node -e 'require("node:fs").appendFileSync("other.ts", "export const h = crypto.createHash(\\"sha1\\").update(\\"x\\").digest(\\"hex\\");\\n")'`;
			gate.results.length = 0;
			const handle = await startPiSession({
				root: fixture.root,
				cwd: repo,
				flags: new Map([...GUARDED_FLAGS, ["no-delta", false]]),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [
					step(fauxToolCall("bash", { command: reformat }), "formatting"),
					endTurn("turn 1 done"),
					step(commitAttempt(), "committing"),
					endTurn("turn 2 done"),
					step(fauxToolCall("bash", { command: added }), "adding"),
					endTurn("turn 3 done"),
				],
			});
			await handle.prompt("reformat the files with a script");
			await Promise.all(gate.pending);
			expect(fs.readFileSync(path.join(repo, files[0] ?? ""), "utf8")).toBe(
				MARKED_FILE.replace(/\t/g, "    "),
			);
			await handle.prompt("commit it");
			const commit = toolResults(handle.requests.at(-1) ?? [], "bash").at(-1);
			await handle.prompt("add a hash with a script");
			await Promise.all(gate.pending);
			const [reformatted, , addition] = gate.results.map((r) => r.text);
			expect(reformatted).not.toContain("\u{1F534} STOP");
			expect(commit?.text ?? "").toContain(RAN_MARKER);
			// The new hash (L5) stops; the one HEAD held (L3) is pre-existing.
			expect(addition).toContain("\u{1F534} STOP \u2014 1 issue(s)");
			expect(addition).toContain("L5: Weak hash");
			expect(addition).toMatch(/Pre-existing: 1 .*\(L3 ts-weak-hash\)/);
			expect(await creditedCounts(repo)).toEqual([9, 1]);
			// One seed per credited file HEAD holds (the created made.ts has none
			// and leaves no row), from the content lanes only: a linter spawned on
			// the path would read the write and seed its findings.
			const seeds = await preEditCaptureRows(repo);
			expect(seeds.map(([result]) => result)).toEqual(Array(9).fill("seeded"));
			expect(
				[...new Set(seeds.flatMap(([, runners]) => runners.split(",")))].sort(),
			).toEqual(["ast-grep-napi", "tree-sitter"]);
			expect(handle.errors).toEqual([]);
			await handle.dispose();
		},
	);

	it(
		"credits a script write to a file an earlier call of the session wrote",
		{ timeout: 90_000 },
		async () => {
			// Recurrence prevented: "another observed writer" is a write pi-lens
			// recorded since THIS call's baseline. Read from the session's start, an
			// earlier edit of the file counts against every later script write to it.
			const repo = initRepo("5616-earlier-write");
			const handle = await startPiSession({
				root: fixture.root,
				cwd: repo,
				flags: new Map(GUARDED_FLAGS),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [
					step(readTarget("seed.ts"), "reading"),
					step(writeTarget("seed.ts", CLEAN_FILE), "writing"),
					step(scriptWrite("seed.ts", BLOCKING_FILE), "scripting"),
					endTurn("turn 1 done"),
				],
			});
			await handle.prompt("write the file, then change it with a script");
			await Promise.all(gate.pending);
			expect(await creditWithheldCauses(repo)).toEqual([]);
			expect(await creditedCounts(repo)).toEqual([1]);
			const bash = toolResults(handle.requests.at(-1) ?? [], "bash").at(-1);
			expect(bash?.text ?? "").toContain("\u{1F534} STOP");
			expect(handle.errors).toEqual([]);
			await handle.dispose();
		},
	);

	it(
		"leaves a credited script write unread: an edit without a read is still refused",
		{ timeout: 90_000 },
		async () => {
			// Recurrence prevented (shape 65): the credit is for the blockers and the
			// gate only. Passing it to the read guard stamps bytes the agent never
			// saw as its own, and its next blind edit goes through.
			const repo = initRepo("5616-read-guard");
			const handle = await startPiSession({
				root: fixture.root,
				cwd: repo,
				flags: new Map(GUARDED_FLAGS),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [
					step(scriptWrite("made.ts", CLEAN_FILE), "writing"),
					step(
						fauxToolCall("edit", {
							path: "made.ts",
							edits: [{ oldText: "return a;", newText: "return 2;" }],
						}),
						"editing",
					),
					endTurn("turn 1 done"),
				],
			});
			await handle.prompt("write the file with a script, then edit it");
			await Promise.all(gate.pending);
			expect(await creditedCounts(repo)).toEqual([1]);
			const edit = toolResults(handle.requests.at(-1) ?? [], "edit").at(-1);
			expect(edit?.text ?? "").toContain("Edit without read");
			expect(fs.readFileSync(path.join(repo, "made.ts"), "utf8")).toBe(
				CLEAN_FILE,
			);
			expect(handle.errors).toEqual([]);
			await handle.dispose();
		},
	);

	// Recurrence prevented (#5552 r1 F1's shape, for scripts): past the cap a
	// user-dirty file may read as clean before the call, so nothing is credited.
	it(
		"does not credit a script write once the dirty set is cut",
		{ timeout: 120_000 },
		async () => {
			const repo = initRepo("5616-cut");
			const users = path.join(repo, "users");
			fs.mkdirSync(users);
			for (let i = 0; i < 600; i += 1)
				fs.writeFileSync(path.join(users, `u${i}.txt`), "a\n");
			git(["add", "-A"], repo);
			git(["commit", "-qm", "users"], repo);
			for (let i = 0; i < 600; i += 1)
				fs.writeFileSync(path.join(users, `u${i}.txt`), "b\n");
			const run = await writeThenCommit(
				repo,
				scriptWrite("seed.ts", BLOCKING_FILE),
			);
			expect(run.write).toContain("withheld");
			expect(run.write).not.toContain("\u{1F534} STOP");
			expect(run.commit).toContain(RAN_MARKER);
			expect(await creditWithheldCauses(repo)).toEqual(["dirty-set-cut"]);
		},
	);

	// Recurrence prevented: a checkout with no git holds no dirty set, so no
	// script write is credited there; and its file walk lists the files the
	// command names too, which are the named route's, so they leave no cause.
	it(
		"does not credit a script write in a checkout with no git, and records no cause for a named one",
		{ timeout: 90_000 },
		async () => {
			const runIn = async (name: string, call: Record<string, unknown>) => {
				const dir = path.join(fixture.root, name, "proj");
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "seed.ts"), CLEAN_FILE);
				const root = fs.realpathSync.native(dir);
				gate.results.length = 0;
				const handle = await startPiSession({
					root: fixture.root,
					cwd: root,
					flags: new Map(GUARDED_FLAGS),
					inlineFactory: async () => (await import("../index.js")).default,
					responses: [step(call, "writing"), endTurn("turn 1 done")],
				});
				await handle.prompt("write the file");
				await Promise.all(gate.pending);
				expect(handle.errors).toEqual([]);
				await handle.dispose();
				return { root, write: gate.results.at(0)?.text ?? "" };
			};
			const script = await runIn(
				"5616-nogit-script",
				scriptWrite("made.ts", BLOCKING_FILE),
			);
			expect(script.write).toContain("withheld");
			expect(script.write).not.toContain("\u{1F534} STOP");
			expect(await creditWithheldCauses(script.root)).toEqual(["no-dirty-set"]);
			const named = await runIn(
				"5616-nogit-named",
				fauxToolCall("bash", {
					command: `cat > made.ts <<'TS'\n${BLOCKING_FILE}TS`,
				}),
			);
			expect(named.write).toContain("\u{1F534} STOP");
			expect(await creditWithheldCauses(named.root)).toEqual([]);
		},
	);

	// Recurrence prevented: a failed call's writes are not credited, as its
	// named writes are not (#2000, #5552).
	it(
		"does not credit a script write in a failed command",
		{ timeout: 90_000 },
		async () => {
			const repo = initRepo("5616-failed");
			const run = await writeThenCommit(
				repo,
				fauxToolCall("bash", {
					command: `node -e 'require("node:fs").writeFileSync("seed.ts", ${JSON.stringify(BLOCKING_FILE)})'; exit 1`,
				}),
			);
			expect(fs.readFileSync(path.join(repo, "seed.ts"), "utf8")).toBe(
				BLOCKING_FILE,
			);
			expect(run.write).toContain("withheld");
			expect(run.write).not.toContain("\u{1F534} STOP");
			expect(run.commit).toContain(RAN_MARKER);
			expect(await creditWithheldCauses(repo)).toEqual(["failed-command"]);
		},
	);

	// Control (acceptance 4): a file another writer pi-lens observed changed in
	// the call's window is not the call's. The other writer is a `write` call
	// pi runs beside the bash call in one batch; the bash call writes nothing
	// and waits until that write's change-log row exists.
	it(
		"does not credit a file another observed writer changed in the call's window",
		{ timeout: 90_000 },
		async () => {
			gate.results.length = 0;
			const repo = initRepo("5616-other-writer");
			const other = path.join(repo, "other.ts");
			const log = getProjectChangeLogPath(repo);
			const wait = `const fs = require("node:fs"); const end = Date.now() + 20000; const pause = new Int32Array(new SharedArrayBuffer(4)); while (Date.now() < end) { try { if (fs.readFileSync(${JSON.stringify(log)}, "utf8").includes("other.ts")) break; } catch {} Atomics.wait(pause, 0, 0, 50); }`;
			const handle = await startPiSession({
				root: fixture.root,
				cwd: repo,
				flags: new Map(GUARDED_FLAGS),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [
					fauxAssistantMessage([
						fauxText("both"),
						fauxToolCall("bash", { command: `node -e '${wait}'` }),
						fauxToolCall("write", { path: other, content: BLOCKING_FILE }),
					]),
					endTurn("turn 1 done"),
				],
			});
			await handle.prompt("write while the script runs");
			await Promise.all(gate.pending);
			const [written] = toolResults(handle.requests.at(-1) ?? [], "write");
			const bash = gate.results.at(0)?.text ?? "";
			// The writer's own result carries its STOP; the bash call's does not.
			// Its claim on the same bytes joins the writer's analysis (#4137), so
			// the decision shows in its records: no credit, one other-writer row.
			expect(written?.text).toContain("\u{1F534} STOP");
			expect(bash).not.toContain("\u{1F534} STOP");
			expect(await creditWithheldCauses(repo)).toEqual(["other-writer"]);
			expect(await creditedCounts(repo)).toEqual([0]);
			expect(handle.errors).toEqual([]);
		},
	);

	// #5616 part 1, the other evidence: a file the command names but did not
	// change (here `touch`) is not said to have changed.
	it(
		"says the call names a file it did not confirm changing",
		{ timeout: 90_000 },
		async () => {
			const repo = initRepo("5616-named");
			fs.writeFileSync(path.join(repo, "held.ts"), BLOCKING_FILE);
			git(["add", "-A"], repo);
			git(["commit", "-qm", "held"], repo);
			const run = await writeThenCommit(
				repo,
				fauxToolCall("bash", {
					command: "touch held.ts && echo 'export const b = 1;' > b.ts",
				}),
			);
			expect(run.write).toContain("in held.ts (L3 debugger-statement");
			expect(run.write).toContain(
				"this call names the file, but pi-lens could not confirm the call changed it",
			);
			expect(run.write).not.toContain("changed while this call ran");
		},
	);

	it(
		"bounds the withheld places at five and counts the rest",
		{ timeout: 90_000 },
		async () => {
			const repo = initRepo("5616-places", ["many.ts"]);
			const body = Array.from(
				{ length: 7 },
				(_, i) => `export function f${i}() {\n\tdebugger;\n}\n`,
			).join("");
			const run = await writeThenCommit(repo, scriptWrite("many.ts", body));
			// Exactly five `L<n> <rule>` places, then the count of the rest. The
			// whole-file run renders more than seven findings here, so a bound of
			// seven still ends in `+N more`; only the five-place prefix pins it.
			expect(run.write).toMatch(
				/in many\.ts \((?:L\d+ [\w-]+, ){5}\+\d+ more\) withheld/,
			);
		},
	);
});
