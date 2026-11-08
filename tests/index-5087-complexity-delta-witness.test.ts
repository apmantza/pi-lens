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

import { installLspServiceDouble } from "./support/lsp-service-seam.js";
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
async function editTo(slug: string, next: string): Promise<string> {
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
	return edits[0]?.text ?? "";
}

describe("#5087 witness: the edit's tool result names a function it made worse than main", () => {
	it("names the function, main's value and the threshold", async () => {
		const out = await editTo("worse", fn("handle", 17));
		expect(out).toContain("⚠ complexity vs main: handle cc 4→18 (≥15)");
	});

	it("says nothing for an edit that stays under the threshold", async () => {
		const out = await editTo("under", fn("handle", 6));
		expect(out).not.toContain("complexity vs");
	});
});
