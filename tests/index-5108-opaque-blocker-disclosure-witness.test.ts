// flake-shape: real-process-spawn — the subject is what a REAL bash tool call writes into a REAL git checkout and what the model receives for it; the detector is git's own `status --porcelain` and a stubbed shell could not say whether the write was seen.
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
import * as fs from "node:fs";
import * as path from "node:path";
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
	/** A handler that, after `holdMs`, finishes having collected these notices. */
	fakeNotices: undefined as string[] | undefined,
	pending: [] as Promise<void>[],
	results: [] as Array<{ command: string; text: string }>,
}));
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
import { execFileSync } from "./support/git-fixture-env.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	commitAttempt,
	endTurn,
	step,
	toolResults,
} from "./support/pi-session-commit-gate.js";
import {
	type PiMessage,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A git checkout with one committed file, so the bash recovery has a base. */
function initRepo(name: string): string {
	const dir = path.join(fixture.root, name, "proj");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "seed.ts"), CLEAN_FILE);
	git(["init", "-q"], dir);
	git(["config", "user.email", "t@t.local"], dir);
	git(["config", "user.name", "t"], dir);
	git(["add", "-A"], dir);
	git(["commit", "-qm", "base"], dir);
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

/** How many `withheld_blocker_late_advisory` rows the fixture's log holds. */
async function lateAdvisoryRows(): Promise<number> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	expect(read.skipped).toBe(0);
	return read.rows.filter(
		(row) => row.phase === "withheld_blocker_late_advisory",
	).length;
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
			const repo = initRepo("in-time");
			const handle = await startPiSession({
				root: fixture.root,
				cwd: repo,
				flags: new Map(GUARDED_FLAGS),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [
					step(scriptWrite("opaque.ts", BLOCKING_FILE), "writing"),
					step(commitAttempt(), "committing"),
					endTurn("done"),
				],
			});
			await handle.prompt("write the file with a script");

			await Promise.all(gate.pending);
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
			expect(write?.text).not.toMatch(/clean/);
			// Unauthored bytes never latch the commit gate (#3226, #4137): the
			// disclosure is not a blocker record.
			expect(commit?.text).not.toContain(GATE_BLOCK);
			expect(commit?.text).toContain(RAN_MARKER);
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
				const repo = initRepo("abandoned");
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
});
