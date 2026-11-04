/**
 * #4483 witness (ADR 0007), the `--no-delta` half: with the delta switched off
 * nothing reads a file's bytes before its first edit, so a linter error the
 * file already had is reported as the blocker it is.
 *
 * Recurrence it prevents: the pre-edit capture seeds the delta baseline, and
 * `--no-delta` reports every finding anyway. A capture that still ran under the
 * flag would spend a linter run on bytes nothing compares against; one that
 * did not run when the flag was OFF would stop the agent on errors it never
 * touched (#4481's remainder). This file moved off the pi double with the
 * `no-delta` case of `tests/index-4483-first-write-seed-witness.test.ts`
 * (#4937 L6): the flag is pi's own `--no-delta`, handed to `extensionFlagValues`
 * and applied after the factory exactly as the CLI does (#4913), not a global
 * config key standing in for it.
 *
 * Tier 2, inline-factory mode. Real: the extension in a real pi session, pi's
 * own `read` and `edit` tools, `tool_call` and `tool_result` in pi's order, the
 * read guard, `runPipeline`, `dispatchForFile` with the real `shellcheck`
 * runner. Doubled only at the process boundary: `clients/safe-spawn.js`
 * (shellcheck) and the LSP service, off. The `vi.mock` is why the file needs
 * the inline mode: a spawn the extension makes from its own module copy would
 * never reach it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => {
	/** shellcheck runs, by the bytes each read. */
	const sh = { runs: [] as string[] };
	const isDoubled = (c: string) => /(^|[\\/])shellcheck(\.exe)?$/i.test(c);
	function run(command: string, args: readonly string[] = []) {
		if (isDoubled(command) && args.includes("--format")) {
			const file = args[args.length - 1] ?? "";
			const nodeFs = (
				process as unknown as {
					getBuiltinModule: (m: "node:fs") => typeof import("node:fs");
				}
			).getBuiltinModule("node:fs");
			const text = nodeFs.existsSync(file)
				? nodeFs.readFileSync(file, "utf8")
				: "";
			sh.runs.push(text);
			const items = text.split("\n").flatMap((line, i) =>
				line.includes("BAD_SH")
					? [
							{
								file,
								line: i + 1,
								endLine: i + 1,
								column: 1,
								endColumn: 2,
								level: "error",
								code: 1072,
								message: "Unexpected BAD_SH token",
							},
						]
					: [],
			);
			return {
				stdout: JSON.stringify(items),
				stderr: "",
				status: items.length ? 1 : 0,
			};
		}
		if (isDoubled(command))
			return { stdout: "version: 0.10.0", stderr: "", status: 0 };
		return {
			stdout: "",
			stderr: "command not found",
			status: 127,
			failure: "spawn" as const,
			spawnFailure: { kind: "tool-not-found" as const },
		};
	}
	return { sh, isDoubled, run };
});

vi.mock("../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/safe-spawn.js")>()),
	safeSpawn: boundary.run,
	safeSpawnAsync: async (command: string, args: readonly string[] = []) =>
		boundary.run(command, args),
	isCommandAvailableAsync: async (command: string) =>
		boundary.isDoubled(command),
	findCommand: (command: string) =>
		boundary.isDoubled(command) ? command : null,
	findCommandAsync: async (command: string) =>
		boundary.isDoubled(command) ? command : null,
}));

import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { installLspServiceDouble } from "./support/lsp-service-seam.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
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

const OLD_ERROR = "#!/bin/sh\nBAD_SH\necho a\n";

/**
 * One session over a shell script that already carries a linter error, and one
 * `edit` of a line the error is not on. `noDelta` is pi's `--no-delta`.
 */
async function editOnce(slug: string, noDelta: boolean) {
	boundary.sh.runs = [];
	// Always the double, with no language server: the shell cell needs none.
	await installLspServiceDouble({
		supportsLSP: () => false,
		hasLSP: async () => false,
		touchFile: async () => ({ diags: [] }),
	});
	const cwd = path.join(fixture.root, slug, "proj");
	const target = path.join(cwd, "scripts", `${slug}.sh`);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, OLD_ERROR);
	const handle = await startPiSession({
		root: fixture.root,
		cwd,
		flags: new Map([
			["lens-guard", true],
			["no-delta", noDelta],
		]),
		inlineFactory: async () => (await import("../index.js")).default,
		responses: [
			step(readTarget(target)),
			step(
				fauxToolCall("edit", {
					path: target,
					edits: [{ oldText: "echo a", newText: "echo b" }],
				}),
			),
			endTurn(),
		],
	});
	await handle.prompt("edit it");
	expect(handle.errors).toEqual([]);
	const edits = toolResults(handle.requests.at(-1) ?? [], "edit");
	expect(edits).toHaveLength(1);
	/** The latency rows naming this file with `phase` (or `result`) `name`. */
	const rows = async (name: string) => {
		// The latency logger keeps its own queue, which `latencyRows`' writer
		// flush does not reach; inline mode shares the module, so the test drains it.
		await flushLatencyLog();
		const read = readNdjsonRows(getLatencyLogPath());
		// A torn row cannot be the row this witness names.
		expect(read.skipped).toBe(0);
		return read.rows.filter(
			(r) => r.filePath === target && (r.phase === name || r.result === name),
		);
	};
	return { out: edits[0]?.text ?? "", rows };
}

describe("#4483 witness: --no-delta, where every finding is reported anyway", () => {
	it("captures nothing and stops on the error the file had", async () => {
		const { out, rows } = await editOnce("no-delta", true);
		expect(out).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		// No run read the bytes before the edit.
		expect(boundary.sh.runs).not.toContain(OLD_ERROR);
		expect(await rows("pre_edit_capture")).toEqual([]);
	});

	it("is the flag that decides it: the same script without --no-delta seeds the capture and does not stop", async () => {
		// The control for the case above: same file, same script, same flags but
		// the one under test. A capture-count of zero is only evidence of the flag
		// when the same turn captures once the flag is off.
		const { out, rows } = await editOnce("delta", false);
		expect(out).not.toContain("🔴 STOP");
		expect(out).toMatch(
			/Pre-existing: 1 linter error .*\(L2 [^)]*\); not blocking\./,
		);
		// The capture read the bytes before the edit; the record says so.
		expect(boundary.sh.runs[0]).toBe(OLD_ERROR);
		const [capture] = await rows("pre_edit_capture");
		expect(capture?.result).toBe("seeded");
	});
});
