/**
 * #4689: one file reached through two spellings is one file, as the MODEL
 * sees it.
 *
 * The defect: the POSIX path key kept the link spelling while the license
 * check, the opaque-write recovery and the class seam used the kernel-real
 * path, so a symlinked file had one record per spelling. The model saw it as
 * a refused edit of a file it had just read (the read guard), a "clean"
 * verdict for a bash write that the real path reports as STOP (attribution),
 * and, once keys moved to the identity, a pending `lens_diagnostics` verdict
 * that never cleared because one widget-store writer still passed the
 * spelling (review r1 F4). Each cell drives pi's real read, edit, write and
 * bash tools through a real `AgentSession` (`tests/support/pi-session.ts`) and asserts
 * the tool result the model received, so the identity rule is pinned at the
 * surface that broke rather than at the key function alone (that half is
 * `tests/clients/path-utils.test.ts`, "path identity").
 *
 * Every cell builds its own project from `createPathIdentityFixture`, under
 * this file's one fixture root, so no case reads another's state. Lane:
 * ubuntu Unit tests; a host that cannot create symlinks skips visibly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	GUARDED_FLAGS,
	MARKED_FILE,
	RAN_MARKER,
	type Received,
	activateMarkTool,
	commitAttempt,
	endTurn,
	markFalsePositive,
	readTarget,
	step,
	toolResults,
	warmGuardedSession,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";
import {
	type PathIdentityFixture,
	createPathIdentityFixture,
} from "./clients/test-utils.js";

import { dataDir444 } from "./support/data-dir-4-4-4.js";

const fixture = piSessionFixture();

// The first guarded session's cold cost is paid in a hook (#5061).
beforeAll(() => warmGuardedSession(fixture.root));

/** A 4.4.4 link-rooted session's data dir, every file that names no absolute path. */
const ALIAS_SESSION_444 = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"data-dir-4.4.4",
	"alias-session",
);

/** The read guard's refusal, as the edit tool result carries it. */
const EDIT_WITHOUT_READ = "Edit without read";

function family(name: string): PathIdentityFixture {
	const base = path.join(fixture.root, name);
	fs.mkdirSync(base, { recursive: true });
	return createPathIdentityFixture(base);
}

async function run(
	fx: PathIdentityFixture,
	responses: readonly PiFauxReply[],
	flags?: ReadonlyMap<string, boolean>,
): Promise<{ results: readonly Received[][] }> {
	const handle = await startPiSession({
		root: fixture.root,
		cwd: fx.repo,
		responses,
		...(flags ? { flags } : {}),
	});
	await handle.prompt("go");
	const last = handle.requests.at(-1) ?? [];
	const results = [toolResults(last, "edit"), toolResults(last, "bash")];
	await handle.dispose();
	return { results };
}

function editCall(target: string, oldText: string, newText: string) {
	return fauxToolCall("edit", {
		path: target,
		edits: [{ oldText, newText }],
	});
}

describe("#4689: the read guard credits a read under any spelling of the file", () => {
	// RECURRENCE GUARDED: the read credit (`ReadGuard.key`) kept the spelling
	// while the license (`licenseKey`) took the realpath, so a file read through
	// a link and edited through its target (or the reverse, for a file and a
	// directory link) was refused as never read: 4 of 4 cells in the #4689
	// audit (probe 2.3).
	const cells: Array<
		[
			string,
			(fx: PathIdentityFixture) => {
				read: string;
				edit: string;
				target: string;
				before: string;
			},
		]
	> = [
		[
			"read the file link, edit its target",
			(fx) => ({
				read: fx.fileLink,
				edit: fx.realFile,
				target: fx.realFile,
				before: "export const real = 1;",
			}),
		],
		[
			"read the target, edit the file link",
			(fx) => ({
				read: fx.realFile,
				edit: fx.fileLink,
				target: fx.realFile,
				before: "export const real = 1;",
			}),
		],
		[
			"read through the dir link, edit the real file",
			(fx) => ({
				read: fx.dirLinkFile,
				edit: fx.sharedFile,
				target: fx.sharedFile,
				before: "export const util = 1;",
			}),
		],
		[
			"read the real file, edit through the dir link",
			(fx) => ({
				read: fx.sharedFile,
				edit: fx.dirLinkFile,
				target: fx.sharedFile,
				before: "export const util = 1;",
			}),
		],
		[
			"read and edit the same spelling (control)",
			(fx) => ({
				read: fx.realFile,
				edit: fx.realFile,
				target: fx.realFile,
				before: "export const real = 1;",
			}),
		],
	];

	for (const [index, [name, pick]] of cells.entries()) {
		it(`${name}: the edit lands`, async (ctx) => {
			const fx = family(`read-cell-${index}`);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const cell = pick(fx);
			const after = cell.before.replace("1;", "2;");
			const {
				results: [edits],
			} = await run(fx, [
				step(readTarget(cell.read), "reading"),
				step(editCall(cell.edit, cell.before, after), "editing"),
				endTurn(),
			]);
			expect(edits?.[0]?.text ?? "").not.toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(cell.target, "utf8")).toContain(after);
		});
	}

	it("a file nobody read is still refused under its link spelling", async (ctx) => {
		const fx = family("read-unread");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		const {
			results: [edits],
		} = await run(fx, [
			step(
				editCall(
					fx.fileLink,
					"export const real = 1;",
					"export const real = 2;",
				),
				"editing",
			),
			endTurn(),
		]);
		expect(edits?.[0]?.text ?? "").toContain(EDIT_WITHOUT_READ);
		expect(fs.readFileSync(fx.realFile, "utf8")).toContain(
			"export const real = 1;",
		);
	});
});

/** A bash write of the blocking file, one shell line per source line. */
function bashWrite(relativeTarget: string): Record<string, unknown> {
	const lines = BLOCKING_FILE.replace(/\n$/, "")
		.split("\n")
		.map((line) => `'${line.replace(/\t/g, "  ")}'`)
		.join(" ");
	return fauxToolCall("bash", {
		command: `printf '%s\\n' ${lines} > ${relativeTarget}`,
	});
}

describe("#4689: a bash write through a link reports what the real path reports", () => {
	// RECURRENCE GUARDED: the recognized redirect target kept the link
	// spelling while the opaque recovery reported the realpath, so the
	// subtraction between them never matched and the write was attributed to
	// nobody: the model read "clean" for a file holding a blocker (#4689 audit,
	// probe 2.4). The real-path write is the control.
	for (const [name, relativeTarget] of [
		["through the file link", "src/link.ts"],
		["through the real path (control)", "src/real.ts"],
	] as const) {
		it(`${name}: the bash result names the blocker and the commit gate holds it`, async (ctx) => {
			const fx = family(`bash-${relativeTarget.replace(/\W/g, "-")}`);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const {
				results: [, bash],
			} = await run(
				fx,
				[
					step(readTarget(fx.realFile), "reading"),
					step(bashWrite(relativeTarget), "writing"),
					step(commitAttempt(), "committing"),
					endTurn(),
				],
				new Map(GUARDED_FLAGS),
			);
			// STOP is rendered only when the pipeline keeps autonomous writers
			// (`hasBlockers` is `allowAutonomousWriters && …` in
			// clients/pipeline.ts), so it also shows the write's authorship
			// matched: a mismatch degrades to "clean".
			const write = bash?.[0]?.text ?? "";
			expect(write).toContain("STOP");
			expect(write).not.toContain("clean");
			// The blocker is recorded where the next gate reads it: the commit
			// that follows is refused and never runs.
			const commit = bash?.[1];
			expect(commit?.text).toContain(GATE_BLOCK);
			expect(commit?.text).not.toContain(RAN_MARKER);
		});
	}
});

describe("#4689: a clean write reads clean under any spelling of the session or the file", () => {
	// RECURRENCE GUARDED: review r1 F4. Dispatch recorded its runners in the
	// widget store under the file's path identity (`ctx.filePath`) while the
	// pipeline recorded the final snapshot under the tool's spelling, and the
	// store keys syntactically (#1020), so one file had a pending record that
	// nothing finished. `lens_diagnostics` then read "inconclusive, 1 pending
	// file" every turn for every file of a session rooted at a link (master
	// read "No issues"), and for a write through a file link.
	const CLEAN_VERDICT = "No issues across 1 file diagnosed this session";
	for (const [name, rooted, relativeTarget] of [
		["a session rooted at a link to the repo", "alias", "src/clean.ts"],
		["a write through a file link", "repo", "src/link.ts"],
		["the real root and path (control)", "repo", "src/clean.ts"],
	] as const) {
		it(`${name}: lens_diagnostics reads clean in the writing turn and the next`, async (ctx) => {
			const fx = family(
				`clean-${rooted}-${relativeTarget.replace(/\W/g, "-")}`,
			);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const handle = await startPiSession({
				root: fixture.root,
				cwd: rooted === "alias" ? fx.aliasRoot : fx.repo,
				flags: new Map(GUARDED_FLAGS),
				responses: [
					step(writeTarget(relativeTarget, CLEAN_FILE), "writing"),
					step(fauxToolCall("lens_diagnostics", { mode: "all" }), "checking"),
					endTurn(),
					step(fauxToolCall("lens_diagnostics", { mode: "all" }), "again"),
					endTurn(),
				],
			});
			try {
				await handle.prompt("go");
				await handle.prompt("again");
				// Each request replays the conversation so far; the last one holds
				// both turns' results.
				const both = toolResults(
					handle.requests.at(-1) ?? [],
					"lens_diagnostics",
				);
				expect(both).toHaveLength(2);
				for (const result of both) {
					expect(result.text).toContain(CLEAN_VERDICT);
					expect(result.text).not.toContain("pending file");
				}
			} finally {
				await handle.dispose();
			}
		});
	}
});

describe("#4689: a blocker raised through a link clears when the real file is rewritten clean", () => {
	// RECURRENCE GUARDED: audit case b (stale shadow). A write through
	// `src/link.ts` and a clean write to `src/real.ts` are one file; the
	// widget kept one record per spelling, so the link's blocker stayed
	// pending and `lens_diagnostics` told the model a fixed file was still
	// broken. Both orders are driven: the link may be the spelling that
	// raised, or the one that cleared. Green on the base, since #4712 r2 made
	// the pipeline write the identity: this is the decision-2026-10-24 witness
	// (identity at the entry, syntactic key in the store), and it reds when the
	// pipeline's widget key is the spelling again.
	for (const [name, first, second] of [
		[
			"raise through the link, clear through the real path",
			"src/link.ts",
			"src/real.ts",
		],
		[
			"raise through the real path, clear through the link",
			"src/real.ts",
			"src/link.ts",
		],
	] as const) {
		it(`${name}: lens_diagnostics reads clean`, async (ctx) => {
			const fx = family(`stale-${first.replace(/\W/g, "-")}`);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const handle = await startPiSession({
				root: fixture.root,
				cwd: fx.repo,
				flags: new Map(GUARDED_FLAGS),
				responses: [
					step(readTarget(fx.realFile), "reading"),
					step(writeTarget(first, BLOCKING_FILE), "raising"),
					step(writeTarget(second, CLEAN_FILE), "clearing"),
					step(fauxToolCall("lens_diagnostics", { mode: "all" }), "checking"),
					step(commitAttempt(), "committing"),
					endTurn(),
				],
			});
			try {
				await handle.prompt("go");
				const last = handle.requests.at(-1) ?? [];
				const [raised, cleared] = toolResults(last, "write");
				const [commit] = toolResults(last, "bash");
				expect(commit?.text ?? "").not.toContain(GATE_BLOCK);
				expect(commit?.text ?? "").toContain(RAN_MARKER);
				expect(raised?.text ?? "").toContain("STOP");
				expect(cleared?.text ?? "").not.toContain("STOP");
				const [verdict] = toolResults(last, "lens_diagnostics");
				expect(verdict?.text ?? "").toContain(
					"No issues across 1 file diagnosed this session",
				);
				expect(verdict?.text ?? "").not.toContain("pending file");
			} finally {
				await handle.dispose();
			}
		});
	}
});

describe("#4689: lens_diagnostics names a file relative to the session root under any spelling of it", () => {
	// RECURRENCE GUARDED: the widget store keys a file by its path identity
	// while the session root stays the spelling the session started with, and
	// the report took a lexical `path.relative` of the two, so a session rooted
	// at a link read every file as `../repo/src/...`, a walk out of the
	// project into the link's target (#4689 r2 sweep of the r1 F5 shape).
	for (const [name, rooted] of [
		["a session rooted at a link to the repo", "alias"],
		["the real root (control)", "repo"],
	] as const) {
		it(`${name}: the blocking row reads src/new.ts`, async (ctx) => {
			const fx = family(`render-${rooted}`);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const handle = await startPiSession({
				root: fixture.root,
				cwd: rooted === "alias" ? fx.aliasRoot : fx.repo,
				flags: new Map(GUARDED_FLAGS),
				responses: [
					step(writeTarget("src/new.ts", BLOCKING_FILE), "writing"),
					step(fauxToolCall("lens_diagnostics", { mode: "all" }), "checking"),
					endTurn(),
				],
			});
			try {
				await handle.prompt("go");
				const [all] = toolResults(
					handle.requests.at(-1) ?? [],
					"lens_diagnostics",
				);
				const text = all?.text ?? "";
				expect(text).toMatch(/^src\/new\.ts {2}🔴 \d+ blocking/m);
				expect(text).not.toContain("../");
			} finally {
				await handle.dispose();
			}
		});
	}
});

describe("#4689: a mark silences its finding under any spelling of the session root", () => {
	// RECURRENCE GUARDED: #4689 review r2 A. The mark tool wrote the
	// disposition store under the data dir of the session's spelling while
	// dispatch read it under the data dir of the root's path identity, so in
	// a session rooted at a link the model marked a finding false-positive
	// and the next write of the same file reported it as STOP again.
	for (const [name, rooted] of [
		["a session rooted at a link to the repo", "alias"],
		["the real root (control)", "repo"],
	] as const) {
		it(`${name}: write is STOP, mark, the rewrite reads clean`, async (ctx) => {
			const fx = family(`mark-${rooted}`);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const cwd = rooted === "alias" ? fx.aliasRoot : fx.repo;
			const target = path.join(cwd, "src", "target.ts");
			const handle = await startPiSession({
				root: fixture.root,
				cwd,
				flags: new Map(GUARDED_FLAGS),
				responses: [
					step(activateMarkTool(), "activating"),
					step(writeTarget(target, MARKED_FILE), "writing"),
					step(markFalsePositive(target), "marking"),
					step(writeTarget(target, `${MARKED_FILE}\n`), "rewriting"),
					endTurn(),
				],
			});
			try {
				await handle.prompt("go");
				const last = handle.requests.at(-1) ?? [];
				const [first, second] = toolResults(last, "write");
				const [mark] = toolResults(last, "lens_diagnostic_mark");
				expect(first?.text ?? "").toContain("STOP");
				expect(mark?.text ?? "").toContain("marked false-positive");
				expect(second?.text ?? "").not.toContain("STOP");
				expect(second?.text ?? "").toContain("clean");
			} finally {
				await handle.dispose();
			}
		});
	}

	it("a session rooted at a link reads the marks a 4.4.4 session stored", async (ctx) => {
		// RECURRENCE GUARDED: #4689 review r1 F2 and round 4. The data dir is
		// now named from the root's real path, while 4.4.4 named it from the
		// session's spelling. The directory below is what a 4.4.4 session
		// rooted at a link wrote (tests/fixtures/data-dir-4.4.4/alias-session,
		// a false-positive mark on MARKED_FILE at src/target.ts), placed where
		// 4.4.4 put it. Without adoption the first write reports STOP again.
		const fx = family("mark-444");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		const cwd = fx.aliasRoot;
		const spelled = dataDir444(path.join(fixture.root, "data"), cwd);
		fs.cpSync(ALIAS_SESSION_444, spelled, { recursive: true });
		const target = path.join(cwd, "src", "target.ts");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			flags: new Map(GUARDED_FLAGS),
			responses: [step(writeTarget(target, MARKED_FILE), "writing"), endTurn()],
		});
		try {
			await handle.prompt("go");
			const last = handle.requests.at(-1) ?? [];
			const [write] = toolResults(last, "write");
			expect(write?.text ?? "").not.toContain("STOP");
			expect(write?.text ?? "").toContain("clean");
		} finally {
			await handle.dispose();
		}
		// The old directory is kept, so a downgrade still reads it.
		expect(
			fs.existsSync(
				path.join(spelled, "cache", "diagnostic-dispositions.json"),
			),
		).toBe(true);
	});

	it("a session rooted at a link stores everything in one data dir", async (ctx) => {
		// RECURRENCE GUARDED: #4689 round 4. r1 made the runtime and dispatch
		// hold the root's real path while host-side callers kept the session's
		// spelling, and each named the data dir from what it held: one session
		// wrote turn state, caches, the change log and marks into two
		// directories (r3 probe: getLensDir 38 opens by identity, 222 by
		// spelling; project-changes 4 and 5).
		const fx = family("one-dir");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		const cwd = fx.aliasRoot;
		const target = path.join(cwd, "src", "target.ts");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			flags: new Map(GUARDED_FLAGS),
			responses: [
				step(activateMarkTool(), "activating"),
				step(writeTarget(target, MARKED_FILE), "writing"),
				step(markFalsePositive(target), "marking"),
				step(writeTarget(target, `${MARKED_FILE}\n`), "rewriting"),
				endTurn(),
			],
		});
		try {
			await handle.prompt("go");
		} finally {
			await handle.dispose();
		}
		const data = path.join(fixture.root, "data");
		// No link on the real path, so its name is the same in every version.
		expect(fs.existsSync(dataDir444(data, fs.realpathSync(cwd)))).toBe(true);
		expect(fs.existsSync(dataDir444(data, cwd))).toBe(false);
	});
});
