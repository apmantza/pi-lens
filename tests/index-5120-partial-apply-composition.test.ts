/**
 * #5120: a partial apply composes with another extension's pre-write guard.
 *
 * The defect: when some edits of a batch matched and others did not, pi-lens
 * wrote the matched subset itself, inside its `tool_call` handler, and then
 * blocked the call. pi stops at the first block, so a guard loaded after
 * pi-lens never saw the bytes pi-lens had already written.
 *
 * The fix: pi-lens rewrites the call's `edits` to the matched subset and lets
 * the host edit write it, so every later `tool_call` handler sees exactly what
 * will be written and can refuse it.
 *
 * Tier 2 (#4632): the BUILT extension and a guard extension, both loaded by
 * pi's own loader in a real `AgentSession`, the model scripted at the provider
 * boundary. The guard is a file this case writes; it records what it saw.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	endTurn,
	readTarget,
	step,
	toolResults,
} from "./support/pi-session-commit-gate.js";
import {
	type PiSession,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

const ORIGINAL = "export const initial = 1;\n";
const MATCHED_OLD = "export const initial = 1;";
/** The guard refuses any proposed edit whose new text carries this token. */
const GOVERNED = "export const initial = 2; // GOVERNED";
const ALLOWED = "export const initial = 2;";
const UNMATCHED_OLD = "absent anchor";

/**
 * How the guard treats a batch it cannot preview because an `oldText` does
 * not occur exactly once: `strict` refuses it, `defer` leaves it to the host
 * edit's own atomic refusal (the investigator's variant). A batch it can
 * preview is refused when a new text carries the governed token.
 */
type GuardMode = "strict" | "defer";

interface Lane {
	target: string;
	cwd: string;
	guard: string;
	seen: string;
}

function lane(name: string, mode: GuardMode): Lane {
	const dir = path.join(fixture.root, name);
	const cwd = path.join(dir, "proj");
	const target = path.join(cwd, "src", "target.ts");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, ORIGINAL);
	const seen = path.join(dir, "guard-seen.ndjson");
	const guard = path.join(dir, "guard.mjs");
	fs.writeFileSync(
		guard,
		[
			`import fs from "node:fs";`,
			`export default function (pi) {`,
			`	pi.on("tool_call", (event) => {`,
			`		if (event.toolName !== "edit") return;`,
			`		const edits = (event.input.edits ?? []).map((e) => ({ oldText: e.oldText, newText: e.newText }));`,
			`		fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify(edits) + "\\n");`,
			`		const content = fs.readFileSync(${JSON.stringify(target)}, "utf8");`,
			`		const previewable = edits.every((e) => content.split(e.oldText).length === 2);`,
			`		if (!previewable) return ${JSON.stringify(mode)} === "strict" ? { block: true, reason: "GUARD: cannot preview the batch" } : undefined;`,
			`		if (edits.some((e) => String(e.newText).includes("GOVERNED"))) return { block: true, reason: "GUARD: governed text refused" };`,
			`	});`,
			`}`,
			``,
		].join("\n"),
	);
	return { target, cwd, guard, seen };
}

/** Every batch the guard was shown, in order. */
function guardSaw(l: Lane): Array<Array<{ oldText: string; newText: string }>> {
	if (!fs.existsSync(l.seen)) return [];
	return fs
		.readFileSync(l.seen, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function batch(newText: string): Record<string, unknown> {
	return fauxToolCall("edit", {
		path: "src/target.ts",
		edits: [
			{ oldText: MATCHED_OLD, newText },
			{ oldText: UNMATCHED_OLD, newText: "x = 1" },
		],
	});
}

/** What each edit tool call told the model, as pi sent it. */
function editResults(
	handle: PiSession,
): Array<{ text: string; isError: boolean }> {
	return toolResults(handle.requests.at(-1) ?? [], "edit");
}

describe("#5120: a partial apply reaches every pre-write guard", () => {
	/** pi-lens first, then a guard that refuses the governed text. */
	async function lensThenGuard(
		name: string,
		flags?: ReadonlyMap<string, boolean | string>,
	): Promise<void> {
		const l = lane(name, "strict");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: l.cwd,
			extraExtensions: { after: [l.guard] },
			...(flags && { flags }),
			responses: [
				step(readTarget("src/target.ts"), "reading"),
				step(batch(GOVERNED), "editing"),
				endTurn("done"),
			],
		});
		await handle.prompt("edit it");

		expect(fs.readFileSync(l.target, "utf8")).toBe(ORIGINAL);
		// The guard saw exactly what the host edit would have written: the one
		// matched edit, at its exact bytes.
		expect(guardSaw(l)).toEqual([
			[{ oldText: MATCHED_OLD, newText: GOVERNED }],
		]);
		const [result] = editResults(handle);
		expect(result?.isError).toBe(true);
		expect(result?.text).toContain("GUARD: governed text refused");
		expect(handle.errors).toEqual([]);
		await handle.dispose();
	}

	it("leaves the file unchanged when a guard loaded after pi-lens refuses the matched subset", async () => {
		// RECURRENCE GUARDED: #5120, the reporter's order. pi-lens wrote the
		// subset from its own tool_call and blocked, so the later guard never
		// ran and the governed bytes landed.
		await lensThenGuard("lens-first");
	});

	it("writes nothing from tool_call with format and autofix on, so the later guard still refuses", async () => {
		// RECURRENCE GUARDED: #5120 member 1b. The direct write's post-edit
		// pipeline ran pi-lens's formatter and autofix inside tool_call, so
		// they also wrote before any later guard.
		await lensThenGuard(
			"lens-first-format",
			new Map<string, boolean | string>([
				["no-autoformat", false],
				["no-autofix", false],
				["immediate-format", true],
			]),
		);
	});

	it("tells a later call that reuses a blocked partial apply's id nothing about that apply", async () => {
		// RECURRENCE GUARDED: #5125 r1 F1. A later guard blocked the rewritten
		// call, so pi emitted no tool_result for it, and the next call with the
		// same id (Mistral's index ids) was told "1 edit committed" and failed.
		const l = lane("reused-id", "strict");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: l.cwd,
			extraExtensions: { after: [l.guard] },
			responses: [
				step(readTarget("src/target.ts"), "reading"),
				step(
					fauxToolCall(
						"edit",
						{
							path: "src/target.ts",
							edits: [
								{ oldText: MATCHED_OLD, newText: GOVERNED },
								{ oldText: UNMATCHED_OLD, newText: "x = 1" },
							],
						},
						{ id: "dup1" },
					),
					"editing",
				),
				step(
					fauxToolCall("bash", { command: "echo hello" }, { id: "dup1" }),
					"listing",
				),
				endTurn("done"),
			],
		});
		await handle.prompt("edit it");

		expect(fs.readFileSync(l.target, "utf8")).toBe(ORIGINAL);
		expect(editResults(handle)[0]?.text).toContain(
			"GUARD: governed text refused",
		);
		const [bash] = toolResults(handle.requests.at(-1) ?? [], "bash");
		expect(bash?.isError).toBe(false);
		expect(bash?.text).not.toContain("PARTIAL APPLY");
		expect(bash?.text).toContain("hello");
		await handle.dispose();
	});

	it("still reports the misses when a later handler rewrites the matched subset in place", async () => {
		// RECURRENCE GUARDED: #5125 r1 F1's structural remedy. Pairing the
		// result to the call by comparing its edits with the rewrite drops the
		// partial apply when a later handler edits them, and the agent is never
		// told edits[1] missed. The call's own input object pairs it.
		const dir = path.join(fixture.root, "rewrite-in-place");
		const cwd = path.join(dir, "proj");
		const target = path.join(cwd, "src", "target.ts");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, ORIGINAL);
		const rewriter = path.join(dir, "rewriter.mjs");
		fs.writeFileSync(
			rewriter,
			[
				`export default function (pi) {`,
				`	pi.on("tool_call", (event) => {`,
				`		if (event.toolName !== "edit") return;`,
				`		for (const e of event.input.edits ?? []) e.newText = "export const initial = 99;";`,
				`	});`,
				`}`,
				``,
			].join("\n"),
		);
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			extraExtensions: { after: [rewriter] },
			responses: [
				step(readTarget("src/target.ts"), "reading"),
				step(batch(ALLOWED), "editing"),
				endTurn("done"),
			],
		});
		await handle.prompt("edit it");

		expect(fs.readFileSync(target, "utf8")).toBe(
			"export const initial = 99;\n",
		);
		const [result] = editResults(handle);
		expect(result?.isError).toBe(true);
		expect(result?.text).toContain(
			`edits[1].oldText ("${UNMATCHED_OLD}") was not found`,
		);
		await handle.dispose();
	});

	it("leaves the file unchanged when a strict guard loaded before pi-lens refuses the batch", async () => {
		// The reverse order: the guard refuses the batch it cannot preview, so
		// pi never reaches pi-lens.
		const l = lane("guard-first-strict", "strict");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: l.cwd,
			extraExtensions: { before: [l.guard] },
			responses: [
				step(readTarget("src/target.ts"), "reading"),
				step(batch(GOVERNED), "editing"),
				endTurn("done"),
			],
		});
		await handle.prompt("edit it");

		expect(fs.readFileSync(l.target, "utf8")).toBe(ORIGINAL);
		expect(guardSaw(l)).toHaveLength(1);
		expect(editResults(handle)[0]?.text).toContain(
			"GUARD: cannot preview the batch",
		);
		await handle.dispose();
	});

	it("writes the matched subset past a guard loaded before pi-lens that deferred the batch to the host", async () => {
		// The investigator's variant, pinned as the host contract's residual: a
		// handler that runs before pi-lens is shown the agent's batch, never
		// pi-lens's rewrite of it (pi has no re-run of earlier handlers). This
		// guard deferred because the host refuses an unmatched batch whole; the
		// rewrite makes the batch applicable, so the subset lands.
		const l = lane("guard-first-defer", "defer");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: l.cwd,
			extraExtensions: { before: [l.guard] },
			responses: [
				step(readTarget("src/target.ts"), "reading"),
				step(batch(GOVERNED), "editing"),
				endTurn("done"),
			],
		});
		await handle.prompt("edit it");

		expect(guardSaw(l)).toEqual([
			[
				{ oldText: MATCHED_OLD, newText: GOVERNED },
				{ oldText: UNMATCHED_OLD, newText: "x = 1" },
			],
		]);
		expect(fs.readFileSync(l.target, "utf8")).toBe(`${GOVERNED}\n`);
		expect(editResults(handle)[0]?.text).toMatch(/^⚠️ PARTIAL APPLY/);
		await handle.dispose();
	});

	it("applies the matched subset for a pi-lens-only session and recognises an identical resubmission", async () => {
		// RECURRENCE GUARDED: #1053 and #2402 for a user with no other
		// extension. The subset lands through the host edit, the agent is told
		// which edit applied and which did not, and resubmitting the same batch
		// writes nothing a second time.
		const l = lane("lens-only", "strict");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: l.cwd,
			responses: [
				step(readTarget("src/target.ts"), "reading"),
				step(batch(ALLOWED), "editing"),
				step(batch(ALLOWED), "resubmitting"),
				endTurn("done"),
			],
		});
		await handle.prompt("edit it");

		expect(fs.readFileSync(l.target, "utf8")).toBe(`${ALLOWED}\n`);
		const [first, second] = editResults(handle);
		expect(first?.isError).toBe(true);
		expect(first?.text).toMatch(
			/^⚠️ PARTIAL APPLY — 1 edit committed \(edits\[0\]\)\. Do NOT resubmit the applied edits\./,
		);
		expect(first?.text).toContain(
			`edits[1].oldText ("${UNMATCHED_OLD}") was not found`,
		);
		expect(second?.isError).toBe(true);
		expect(second?.text).toContain("edits[0] was already applied");
		expect(second?.text).not.toMatch(/PARTIAL APPLY/);
		expect(handle.errors).toEqual([]);
		await handle.dispose();
	});
});
