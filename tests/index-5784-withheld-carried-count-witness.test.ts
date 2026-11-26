// flake-shape: real-process-spawn — the second write is a REAL bash heredoc into a REAL git checkout, and the recovery dispatch that reads it back is git's own `status --porcelain`; a stubbed shell could not say whether the bytes landed.
/**
 * #5784 witness: the `withheld:` line says how many of the findings it lists
 * this write did not re-check, and that count is the carried-and-unobserved
 * half, not the whole live set.
 *
 * Recurrence prevented: the line named the blocker as still on the file but
 * never said the passive path would not answer for it, so the agent re-read
 * the file instead of settling it with a budgeted probe (pi-lens 4.5.2
 * session 2026-11-26, 30 minutes of re-reads until the harness timed out).
 *
 * Real: `index.ts`'s registered handlers, `runPipeline`, the dispatch with its
 * real `git` recovery and the real bundled `debugger-statement` rule,
 * `carryRecordedBlockers`, and pi's own `write` and `bash` tools in a real
 * `AgentSession`. Doubled only at the process boundary: the LSP service
 * behind `clients/lsp/capabilities.js`, whose `touchFile` answers the
 * TypeScript runner's error until `boundary.silent` turns it inconclusive (no
 * verdict, which is the state the carry branch is about).
 *
 * The count is asserted where it can differ from `liveBlockers.length`: the
 * second write delivers one blocker of its own (the bundled rule's `debugger`
 * finding) while the recorded TypeScript blocker is carried unobserved, so
 * the line reads two findings and one of them as not re-checked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { gitExecFileSync } from "./support/git-fixture-env.js";
import { installLspServiceDouble } from "./support/lsp-service-seam.js";
import {
	endTurn,
	step,
	toolResults,
} from "./support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** The recorded blocker's line, kept across both writes so it stays placeable. */
const RECORDED = "const old = BAD_OLD;\n";
/** The second write's own blocker: the bundled `debugger-statement` rule. */
const FRESH = "debugger;\n";
const V1 = `export ${RECORDED}export const keep = 1;\n`;
const V2 = `export ${RECORDED}export const keep = 1;\n${FRESH}`;

/** What the TypeScript runner is handed; `silent` is the no-verdict state. */
const boundary = { silent: false };

function tsError(row: number) {
	return {
		severity: 1,
		message: "Cannot find name 'BAD_OLD'.",
		code: 2304,
		source: "ts",
		serverId: "typescript",
		range: {
			start: { line: row, character: 13 },
			end: { line: row, character: 20 },
		},
	};
}

function debuggerRow(row: number) {
	return {
		severity: 1,
		message: "Unexpected 'debugger' statement",
		code: "debugger-statement",
		source: "ast-grep",
		serverId: "ast-grep",
		range: {
			start: { line: row, character: 0 },
			end: { line: row, character: 9 },
		},
	};
}
/**
 * A heredoc that writes through `node`, which the write extractor does not
 * recognise (it recognises `cat > path` and a few verbs, not an interpreter's
 * own file write). The path comes back through the git recovery, so the run
 * has no authorship and withholds its findings.
 */
function scriptWrite(target: string, content: string) {
	return fauxToolCall("bash", {
		command: `node - <<'JS'\nrequire("node:fs").writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(content)});\nJS`,
	});
}

async function session(slug: string) {
	boundary.silent = false;
	await installLspServiceDouble({
		supportsLSP: () => true,
		hasLSP: async () => true,
		touchFile: async (_filePath: string, content: string) => {
			const rows = content.split("\n");
			const recordedAt = rows.findIndex((l) => l.includes("BAD_OLD"));
			const freshAt = rows.findIndex((l) => l.trim() === "debugger;");
			const diags = [
				...(recordedAt >= 0 && !boundary.silent ? [tsError(recordedAt)] : []),
				...(freshAt >= 0 ? [debuggerRow(freshAt)] : []),
			];
			// #4484 row 10: the server reached no verdict on these bytes. Its own
			// rows are withheld; the other server's answer still stands.
			if (!boundary.silent) return { diags };
			return {
				diags: diags.filter((d) => d.serverId !== "typescript"),
				inconclusive: true,
				inconclusiveServerIds: ["typescript"],
			};
		},
	});
	const cwd = path.join(fixture.root, slug, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const git = (...args: string[]) =>
		gitExecFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t.local");
	git("config", "user.name", "t");
	const target = path.join(cwd, "svc.ts");
	fs.writeFileSync(target, "export const keep = 1;\n");
	git("add", "-A");
	git("commit", "-q", "-m", "c");
	const handle = await startPiSession({
		root: fixture.root,
		cwd,
		inlineFactory: async () => (await import("../index.js")).default,
		// The type's own server answers here; the tier's default set turns it off.
		flags: new Map([["no-lsp", false]]),
		responses: [
			// Turn 1: the authored write records the TypeScript blocker.
			step(fauxToolCall("write", { path: target, content: V1 })),
			endTurn(),
			// Turn 2: the script's write is opaque, so the run withholds.
			step(scriptWrite(target, V2)),
			endTurn(),
		],
	});
	return { handle, target };
}

/** Both writes, with the server going silent between them. */
async function runWrites(slug: string, silentOnSecond: boolean) {
	const { handle } = await session(slug);
	await handle.prompt("write it");
	const first =
		toolResults(handle.requests.at(-1) ?? [], "write")[0]?.text ?? "";
	boundary.silent = silentOnSecond;
	await handle.prompt("script it");
	const second =
		toolResults(handle.requests.at(-1) ?? [], "bash")[0]?.text ?? "";
	return { handle, first, second };
}

describe("#5784 witness: the withheld line counts the findings this write never re-checked", () => {
	it("says one of the two findings was not re-checked, and how to settle it", async () => {
		const { handle, first, second } = await runWrites("carried", true);
		expect(handle.errors).toEqual([]);
		// Turn 1 is an authored write: the blocker is delivered, not withheld.
		expect(first).toContain("STOP");
		// Three findings are on the file; two of them came from this write.
		expect(second).toContain("⚠ 3 blocking findings in svc.ts");
		expect(second).toContain("withheld:");
		// ...and only the recorded one was not re-checked.
		expect(second).toContain(
			"1 recorded earlier was not re-checked on this write, so fixing the code cannot retire it; lens_diagnostics source=lsp path=svc.ts settles it.",
		);
	}, 120_000);

	it("says nothing about a re-check when the same write observed every finding", async () => {
		const { handle, second } = await runWrites("observed", false);
		expect(handle.errors).toEqual([]);
		expect(second).toContain("withheld:");
		expect(second).not.toContain("recorded earlier was not re-checked");
	}, 120_000);
});
