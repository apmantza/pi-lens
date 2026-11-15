// flake-shape: real-process-spawn — the subject is what a REAL pi session's tool_result dispatches for a call whose writes reached the mutation bridge; a stubbed host could not say which files the dispatcher saw.
/**
 * #5551: the call's written set (`RuntimeCoordinator.takeCallWrites`) feeds
 * the `tool_result` dispatch with the files the mutation bridge recorded for
 * that call, whatever the tool is named.
 *
 * REAL here: the built extension's `tool_call` / `tool_result` handlers in a
 * real pi `AgentSession`, pi-lens's own `lens_diagnostic_mark`, the mutation
 * bridge, the opaque recovery and the dispatcher. Scripted is the model only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { Type } from "../clients/deps/typebox.js";
import {
	BLOCKER,
	BLOCKING_FILE,
	CLEAN_FILE,
	GUARDED_FLAGS,
	MARKED_FILE,
	type DispatchRow,
	activateMarkTool,
	endTurn,
	openGuardedSession,
	raise,
	runnerRowsFor,
	seed,
	step,
	toolResults,
	warmGuardedSession,
} from "./support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();
beforeAll(() => warmGuardedSession(fixture.root));

/**
 * Another extension's tool that names no path: it writes two files and
 * records only the first through the public mutation bridge, with its own
 * call id.
 */
function bridgeWriter(
	recordedFile: string,
	unrecorded: string,
): ToolDefinition {
	return {
		name: "bridge_writer",
		label: "Bridge writer",
		description: "Write two files, record one through the mutation bridge.",
		parameters: Type.Object({}),
		async execute(toolCallId: string) {
			fs.writeFileSync(recordedFile, BLOCKING_FILE);
			fs.writeFileSync(unrecorded, BLOCKING_FILE);
			const bridge = (globalThis as Record<symbol, unknown>)[
				Symbol.for("pi-lens:mutation-bridge")
			] as { recordMutation(entry: unknown): boolean } | undefined;
			const recorded = bridge?.recordMutation({
				filePath: recordedFile,
				kind: "write",
				consumer: "bridge_writer",
				provenance: "observed",
				toolCallId,
			});
			return {
				content: [{ type: "text", text: `wrote, recorded=${recorded}` }],
				details: {},
			};
		},
	};
}

/** The base names of every file a runner ran on. */
function dispatchedFiles(rows: readonly DispatchRow[]): string[] {
	return [
		...new Set(
			rows
				.filter((row) => row.type === "runner" && row.filePath !== undefined)
				.map((row) => path.basename(row.filePath ?? "")),
		),
	].sort();
}

/** How many times the dispatcher started on `file` (one per dispatch). */
function dispatchStarts(rows: readonly DispatchRow[], file: string): number {
	return rows.filter(
		(row) =>
			row.type === "phase" &&
			(row as { phase?: string }).phase === "dispatch_start" &&
			row.filePath === file,
	).length;
}

describe("#5551 a call's written set reaches its tool_result dispatch", () => {
	// Recurrence prevented (#5551 r1b probe, against d43b4dd): the opaque
	// recovery's per-file re-entries share the host call's id, so the first
	// one claimed the call's written set and dispatched the recorded file in
	// place of the one it was for, and other.ts went undispatched. A host call
	// with an opaque baseline that also merged its set dispatched the recorded
	// file twice. On a88ac1a87 each file was dispatched once and disclosed.
	it("still recovers and discloses a file the bridging call wrote but did not record", async () => {
		const { proj, target } = seed(fixture.root, "bridge-other", CLEAN_FILE);
		const other = path.join(proj, "src", "other.ts");
		fs.writeFileSync(other, CLEAN_FILE);
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			flags: new Map(GUARDED_FLAGS),
			customTools: [bridgeWriter(target, other)],
			responses: [
				step(fauxToolCall("bridge_writer", {}), "writing"),
				endTurn("done"),
			],
		});
		await handle.prompt("write");

		// The tool really wrote both files: a miss below is the dispatch's.
		expect(fs.readFileSync(other, "utf8")).toBe(BLOCKING_FILE);
		const read = await handle.latencyRows();
		expect(read.skipped).toBe(0);
		const rows = read.rows as DispatchRow[];
		expect(dispatchedFiles(rows)).toEqual(["other.ts", "target.ts"]);
		// Once each: the recovery dispatched the bridged file, so the call's
		// written set must not send it through the observed path again.
		expect(dispatchStarts(rows, other)).toBe(1);
		expect(dispatchStarts(rows, target)).toBe(1);
		const [result] = toolResults(handle.requests.at(-1) ?? [], "bridge_writer");
		// Which runners report before the result settles varies with load (a
		// late biome adds its own rule), so the line is matched by its file,
		// one rule and its withheld wording.
		expect(result?.text).toMatch(
			/in src\/other\.ts \([^)]*debugger-statement[^)]*\) withheld/,
		);
		expect(handle.errors).toEqual([]);
	});

	// The scope growth, pinned: `lens_diagnostic_mark` records its suppress
	// through the bridge with its call id, so its result now dispatches the
	// one file it wrote, and nothing else (a88ac1a87 dispatched none).
	it("dispatches only the file a lens_diagnostic_mark suppress wrote", async () => {
		const { proj, target } = seed(fixture.root, "mark-suppress", CLEAN_FILE);
		const handle = await openGuardedSession(fixture.root, proj, [
			...raise(target, MARKED_FILE),
			step(activateMarkTool(), "activating"),
			step(
				fauxToolCall("lens_diagnostic_mark", {
					filePath: target,
					...BLOCKER,
					disposition: "suppress",
				}),
				"suppressing",
			),
			endTurn("turn 2 done"),
		]);
		await handle.prompt("write the file");
		const before = (await handle.latencyRows()).rows as DispatchRow[];
		await handle.prompt("suppress it");
		const after = await handle.latencyRows();
		expect(after.skipped).toBe(0);
		const turn2 = (after.rows as DispatchRow[]).slice(before.length);

		expect(fs.readFileSync(target, "utf8")).toContain("pi-lens-ignore");
		expect(runnerRowsFor(turn2, target).length).toBeGreaterThan(0);
		expect(dispatchedFiles(turn2)).toEqual(["target.ts"]);
		expect(handle.errors).toEqual([]);
	});
});
