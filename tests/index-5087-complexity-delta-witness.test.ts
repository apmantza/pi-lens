// flake-shape: real-process-spawn — the witness's repository is made with real git, and the edit's default-branch read runs real `git` children through pi's own tool path.
/**
 * #5087 S2 witness: an edit's tool result names a function the edit made
 * worse than the default branch.
 *
 * Tier 2, inline-factory mode. Real: the extension in a real pi session, pi's
 * own `read` and `edit` tools, `tool_call` and `tool_result` in pi's order,
 * the first-touch baseline (the shared parser, real `git` against a real
 * repository whose `main` holds the file), `runPipeline` and the edit's
 * re-measure. Doubled only at the process boundary: the LSP service, off.
 * `no-complexity`, on in the tier's default flag set, is turned off.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { installLspServiceDouble } from "./support/lsp-service-seam.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import { gitExecFileSync } from "./support/git-fixture-env.js";
import {
	endTurn,
	readTarget,
	step,
	toolResults,
} from "./support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** A function of cyclomatic complexity `1 + branches`. */
function fn(name: string, branches: number): string {
	const body = Array.from(
		{ length: branches },
		(_, i) => `\tif (x === ${i}) return ${i};`,
	).join("\n");
	return `export function ${name}(x: number): number {\n${body}\n\treturn -1;\n}\n`;
}

/**
 * A repository whose `main` holds `svc.ts` with `handle` at cyclomatic 4,
 * then one session that reads it and edits it to `next`. The edit's text.
 */
async function editTo(
	slug: string,
	next: string,
): Promise<{ out: string; rows: Array<Record<string, unknown>> }> {
	await installLspServiceDouble({
		supportsLSP: () => false,
		hasLSP: async () => false,
		touchFile: async () => ({ diags: [] }),
	});
	const cwd = path.join(fixture.root, slug, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const git = (...args: string[]) =>
		gitExecFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t.local");
	git("config", "user.name", "t");
	const target = path.join(cwd, "svc.ts");
	const before = fn("handle", 3);
	fs.writeFileSync(target, before);
	git("add", "-A");
	git("commit", "-q", "-m", "c");
	const handle = await startPiSession({
		root: fixture.root,
		cwd,
		// The tier's default set turns complexity off; this case is about it.
		flags: new Map([["no-complexity", false]]),
		inlineFactory: async () => (await import("../index.js")).default,
		responses: [
			step(readTarget(target)),
			step(
				fauxToolCall("edit", {
					path: target,
					edits: [{ oldText: before, newText: next }],
				}),
			),
			endTurn(),
		],
	});
	await handle.prompt("edit it");
	expect(handle.errors).toEqual([]);
	const edits = toolResults(handle.requests.at(-1) ?? [], "edit");
	expect(edits).toHaveLength(1);
	// The latency logger keeps its own queue; inline mode shares the module,
	// so the test drains it before reading this file's rows.
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	expect(read.skipped).toBe(0);
	const rows = read.rows.filter(
		(r) => r.filePath === target && r.phase === "complexity_delta",
	);
	return { out: edits[0]?.text ?? "", rows };
}

describe("#5087 witness: the edit's tool result names a function it made worse than main", () => {
	it("names the function, main's value and the threshold", async () => {
		const { out, rows } = await editTo("worse", fn("handle", 17));
		expect(out).toContain("⚠ complexity vs main: handle cc 4→18 (≥15)");
		// The decision record of the judged edit.
		expect(rows.map((r) => r.metadata)).toEqual([
			{
				against: "main",
				main: "file",
				functions: 1,
				worsened: 1,
				advised: true,
			},
		]);
	});

	it("says nothing for an edit that stays under the threshold", async () => {
		const { out, rows } = await editTo("under", fn("handle", 6));
		expect(out).not.toContain("complexity vs");
		expect(rows.map((r) => r.metadata)).toEqual([
			{
				against: "main",
				main: "file",
				functions: 1,
				worsened: 0,
				advised: false,
			},
		]);
	});
});
