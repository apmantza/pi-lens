// flake-shape: real-process-spawn — the subject is a REAL ast-grep CLI rewrite of real files under a real pi session; a stubbed CLI could not say whether the bytes it wrote reached a dispatcher.
/**
 * #5239 witness: an applied `ast_grep_replace` dispatches the files it wrote
 * like an `edit` does, so the blocker it introduces reaches the commit gate.
 *
 * Recurrence prevented: `ast_grep_replace` names its targets in a `paths`
 * ARRAY and records its writes straight through the mutation bridge, which
 * defers autofix and format but queues no dispatch; the classified chain
 * skipped it as "not a classified mutation". A `debugger;` the rewrite added
 * reached neither the turn-end check nor `git commit` under `--lens-guard`,
 * while the same bytes through `edit` blocked.
 *
 * REAL here: the BUILT extension's registered `tool_call` / `tool_result`
 * handlers inside a real pi `AgentSession`, pi-lens's own `ast_grep_replace`
 * tool driving the real ast-grep CLI, the dispatcher and the commit gate.
 * Scripted is the model only, at the provider boundary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeMapKey } from "../clients/path-utils.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	RAN_MARKER,
	commitAttempt,
	endTurn,
	openGuardedSession,
	readTarget,
	seed,
	step,
	toolResults,
	warmGuardedSession,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import { fauxToolCall, piSessionFixture } from "./support/pi-session.js";

const fixture = piSessionFixture();

beforeAll(() => warmGuardedSession(fixture.root));

/** `ast_grep_replace` is situational: callable only after activation. */
function activateReplace(): Record<string, unknown> {
	return fauxToolCall("pi_lens_activate_tools", {
		tools: ["ast_grep_replace"],
	});
}

function replace(
	paths: string[] | undefined,
	apply: boolean,
): Record<string, unknown> {
	return fauxToolCall("ast_grep_replace", {
		pattern: "return $X;",
		rewrite: "debugger;\n\treturn $X;",
		lang: "typescript",
		...(paths ? { paths } : {}),
		apply,
	});
}

interface Row {
	type?: string;
	filePath?: string;
	diagnostics?: Array<{ rule?: string }>;
}

describe("#5239 an applied ast_grep_replace dispatches what it wrote", () => {
	it("control: a write of the same bytes dispatches the file once (the row detector sees it)", async () => {
		const { proj, target } = seed(fixture.root, "write-control", CLEAN_FILE);
		const handle = await openGuardedSession(fixture.root, proj, [
			step(readTarget(target), "reading"),
			step(writeTarget(target, BLOCKING_FILE), "writing"),
			endTurn("done"),
		]);
		await handle.prompt("write it");
		const read = await handle.latencyRows();
		expect(read.skipped).toBe(0);
		expect(
			(read.rows as Row[])
				.filter(
					(row) =>
						row.type === "runner" &&
						row.filePath !== undefined &&
						normalizeMapKey(row.filePath) === normalizeMapKey(target),
				)
				.flatMap((row) => (row.diagnostics ?? []).map((d) => d.rule)),
		).toContain("debugger-statement");
	});

	it("refuses a commit over the blocker an applied replace introduced", async () => {
		const { proj, target } = seed(fixture.root, "apply-gate", CLEAN_FILE);
		const handle = await openGuardedSession(fixture.root, proj, [
			step(readTarget(target), "reading"),
			step(activateReplace(), "activating"),
			step(replace([target], true), "replacing"),
			step(commitAttempt(), "committing"),
			endTurn("done"),
		]);
		await handle.prompt("rewrite and commit");

		// The rewrite really landed: the defect was delivery.
		expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING_FILE);
		const commits = toolResults(handle.requests.at(-1) ?? [], "bash");
		expect(commits).toHaveLength(1);
		expect(commits[0]?.text).toContain(GATE_BLOCK);
		expect(commits[0]?.text).not.toContain(RAN_MARKER);
		expect(commits[0]?.isError).toBe(true);
	});

	it("dispatches each file a multi-file replace changed once, and a dry run none", async () => {
		const { proj, target } = seed(fixture.root, "apply-counts", CLEAN_FILE);
		const second = path.join(proj, "src", "second.ts");
		const untouched = path.join(proj, "src", "untouched.ts");
		fs.writeFileSync(second, CLEAN_FILE);
		fs.writeFileSync(untouched, "export const keep = 1;\n");
		const handle = await openGuardedSession(fixture.root, proj, [
			step(activateReplace(), "activating"),
			// A dry run first: it writes nothing and must dispatch nothing.
			step(replace([path.join(proj, "src")], false), "previewing"),
			endTurn("preview done"),
			step(replace([path.join(proj, "src")], true), "applying"),
			endTurn("apply done"),
		]);
		await handle.prompt("preview");
		const afterPreview = await handle.latencyRows();
		expect(afterPreview.skipped).toBe(0);
		const runnerRowsFor = (rows: Row[], file: string) =>
			rows.filter(
				(row) =>
					row.type === "runner" &&
					row.filePath !== undefined &&
					normalizeMapKey(row.filePath) === normalizeMapKey(file),
			);
		expect(fs.readFileSync(target, "utf8")).toBe(CLEAN_FILE);
		for (const file of [target, second, untouched])
			expect(runnerRowsFor(afterPreview.rows as Row[], file)).toEqual([]);

		await handle.prompt("apply");
		const read = await handle.latencyRows();
		expect(read.skipped).toBe(0);
		const rows = read.rows as Row[];
		expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING_FILE);
		expect(fs.readFileSync(second, "utf8")).toBe(BLOCKING_FILE);
		const rules = (file: string) =>
			runnerRowsFor(rows, file).flatMap((row) =>
				(row.diagnostics ?? []).map((d) => d.rule),
			);
		// Each changed file reached the dispatcher exactly once; the file the
		// pattern did not match reached it never.
		expect(
			rules(target).filter((r) => r === "debugger-statement"),
		).toHaveLength(1);
		expect(
			rules(second).filter((r) => r === "debugger-statement"),
		).toHaveLength(1);
		expect(runnerRowsFor(rows, untouched)).toEqual([]);
	});
});
