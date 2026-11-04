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
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { Type } from "../clients/deps/typebox.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	type DispatchRow,
	commitAttempt,
	endTurn,
	openGuardedSession,
	readTarget,
	reportedRules,
	runnerRowsFor,
	seed,
	step,
	toolResults,
	warmGuardedSession,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

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
	structural = false,
): Record<string, unknown> {
	return fauxToolCall("ast_grep_replace", {
		pattern: "return $X;",
		rewrite: "debugger;\n\treturn $X;",
		lang: "typescript",
		...(paths ? { paths } : {}),
		// `insideKind` is structural intent: the call takes `replaceWithRule`.
		...(structural ? { insideKind: "function_declaration" } : {}),
		apply,
	});
}

/**
 * A tool pi-lens never met: it writes nothing and only names `target` in its
 * result's `details.appliedFiles`. Only that claim could make pi-lens dispatch
 * the file, so a dispatch here is the tool-name gate failing.
 */
function foreignClaimTool(target: string): ToolDefinition {
	return {
		name: "evil_tool",
		label: "Foreign claim",
		description: "Report a file in appliedFiles without writing it.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "claimed" }],
				details: { appliedFiles: [target] },
			};
		},
	};
}

describe("#5239 an applied ast_grep_replace dispatches what it wrote", () => {
	it("control: a write of the same bytes reaches the dispatcher (the row detector sees it)", async () => {
		const { proj, target } = seed(fixture.root, "write-control", CLEAN_FILE);
		const handle = await openGuardedSession(fixture.root, proj, [
			step(readTarget(target), "reading"),
			step(writeTarget(target, BLOCKING_FILE), "writing"),
			endTurn("done"),
		]);
		await handle.prompt("write it");
		const read = await handle.latencyRows();
		expect(read.skipped).toBe(0);
		expect(reportedRules(read.rows as DispatchRow[], target)).toContain(
			"debugger-statement",
		);
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
		expect(fs.readFileSync(target, "utf8")).toBe(CLEAN_FILE);
		for (const file of [target, second, untouched])
			expect(runnerRowsFor(afterPreview.rows as DispatchRow[], file)).toEqual(
				[],
			);

		await handle.prompt("apply");
		const read = await handle.latencyRows();
		expect(read.skipped).toBe(0);
		const rows = read.rows as DispatchRow[];
		expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING_FILE);
		expect(fs.readFileSync(second, "utf8")).toBe(BLOCKING_FILE);
		const rules = (file: string) => reportedRules(rows, file);
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

	// Recurrence prevented (Greptile T4 on #5244 r3: a language-neutral dispatch
	// needs a non-TypeScript row): every case above is TypeScript, so a dispatch
	// that only worked for the `.ts` pipeline would pass. The rewrite adds a
	// `hashlib.md5`, which the bundled Python tree-sitter rule `python-weak-hash`
	// blocks (severity error), so the Python file must reach the dispatcher and
	// the commit gate. (`python-debugger` is a warning and never gates a commit,
	// a plain `write` of it included, so it cannot carry this row.)
	it("dispatches and gates the Python file an applied replace wrote", async () => {
		const { proj } = seed(fixture.root, "apply-python", CLEAN_FILE);
		const target = path.join(proj, "src", "target.py");
		const clean = "import hashlib\n\ndef f(d):\n    return hashlib.sha256(d)\n";
		fs.writeFileSync(target, clean);
		const handle = await openGuardedSession(fixture.root, proj, [
			step(readTarget(target), "reading"),
			step(activateReplace(), "activating"),
			step(
				fauxToolCall("ast_grep_replace", {
					pattern: "hashlib.sha256($X)",
					rewrite: "hashlib.md5($X)",
					lang: "python",
					paths: [target],
					apply: true,
				}),
				"replacing",
			),
			step(commitAttempt(), "committing"),
			endTurn("done"),
		]);
		await handle.prompt("rewrite and commit");

		expect(fs.readFileSync(target, "utf8")).toBe(
			"import hashlib\n\ndef f(d):\n    return hashlib.md5(d)\n",
		);
		const read = await handle.latencyRows();
		expect(read.skipped).toBe(0);
		expect(
			reportedRules(read.rows as DispatchRow[], target).filter(
				(r) => r === "python-weak-hash",
			),
		).toHaveLength(1);
		const commits = toolResults(handle.requests.at(-1) ?? [], "bash");
		expect(commits).toHaveLength(1);
		expect(commits[0]?.text).toContain(GATE_BLOCK);
		expect(commits[0]?.text).not.toContain(RAN_MARKER);
	});

	// Recurrence prevented (Greptile T3 on #5244 r3): the structural apply loops
	// over `paths`, rewrites a matching file, then a later path that is stale or
	// fails returned early with no `appliedFiles`, so the rewritten file never
	// reached the dispatcher or the commit gate. The first path writes before
	// the second is checked, so the failure is real on disk, not a mock. The CLI
	// error exit has no real-CLI trigger (a missing path is a stale preview), so
	// it is covered at the runner boundary in `ast-grep-mutation-bridge.test.ts`.
	it(
		"dispatches the file a structural apply wrote when a later path no longer matches (stale preview)",
		{ timeout: 180_000 },
		async () => {
			const { proj, target } = seed(
				fixture.root,
				"structural-partial-stale",
				CLEAN_FILE,
			);
			const second = path.join(proj, "src", "nomatch.ts");
			fs.writeFileSync(second, "export const k = 1;\n");
			const handle = await openGuardedSession(fixture.root, proj, [
				step(activateReplace(), "activating"),
				step(replace([target, second], true, true), "replacing"),
				step(commitAttempt(), "committing"),
				endTurn("done"),
			]);
			await handle.prompt("rewrite then fail on the second path");

			// The first path really was rewritten before the second failed.
			expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING_FILE);
			const results = toolResults(
				handle.requests.at(-1) ?? [],
				"ast_grep_replace",
			);
			expect(results).toHaveLength(1);
			expect(results[0]?.isError).toBe(true);
			const read = await handle.latencyRows();
			expect(read.skipped).toBe(0);
			expect(
				reportedRules(read.rows as DispatchRow[], target).filter(
					(r) => r === "debugger-statement",
				),
			).toHaveLength(1);
			const commits = toolResults(handle.requests.at(-1) ?? [], "bash");
			expect(commits).toHaveLength(1);
			expect(commits[0]?.text).toContain(GATE_BLOCK);
		},
	);

	// Recurrence prevented: the tool-result feed reads `details.appliedFiles`
	// from ANY tool's result, so a tool another extension registers could make
	// pi-lens dispatch a file it never wrote. The name check in
	// `appliedFilesOfOwnTool` is the only barrier (review r1 F1 on #5244).
	it(
		"dispatches nothing for a tool pi-lens does not own that names a file in details.appliedFiles",
		{ timeout: 180_000 },
		async () => {
			const { proj, target } = seed(
				fixture.root,
				"foreign-applied",
				CLEAN_FILE,
			);
			// The blocker is on disk before the foreign tool runs, and the tool
			// writes nothing, so the file reaches a dispatcher only through the claim.
			fs.writeFileSync(target, BLOCKING_FILE);
			const handle = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: new Map(GUARDED_FLAGS),
				customTools: [foreignClaimTool(target)],
				responses: [
					step(fauxToolCall("evil_tool", {}), "claiming"),
					endTurn("done"),
				],
			});
			await handle.prompt("claim");

			// The tool really ran and answered: the defect would be the feed, not the call.
			expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING_FILE);
			const claims = toolResults(handle.requests.at(-1) ?? [], "evil_tool");
			expect(claims).toHaveLength(1);
			expect(claims[0]?.text).toContain("claimed");

			const read = await handle.latencyRows();
			expect(read.skipped).toBe(0);
			expect(reportedRules(read.rows as DispatchRow[], target)).not.toContain(
				"debugger-statement",
			);
		},
	);
});
