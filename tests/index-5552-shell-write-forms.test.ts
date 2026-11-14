// flake-shape: real-process-spawn — the subject is what a REAL `mv`, `rsync` and `tar` do to a REAL git checkout under a real pi session (their copies keep the source's old mtime), and the detector under test is git's own `status --porcelain`; a stubbed shell or git could not answer either question.
/**
 * #5552 witness: a bash `mv a.ts src/`, `rsync -a` and `tar x` write a file
 * that keeps its source's OLD mtime, and every consumer still learns of it.
 *
 * Recurrence prevented: #5581 recovered an mtime-preserving overwrite by
 * content only where the prescan named the destination FILE. `mv a.ts src/`
 * names a directory, and `rsync -a` and `tar x` name a tree or an archive, so
 * `scanShellWriteScopes` returned no written path for them: no dispatch, no
 * change-log row, and `git commit` allowed the `debugger;` they brought in
 * (writer-route audit, 2026-11-13).
 *
 * REAL here: pi's own `bash` tool runs each command, so the write is a real
 * write by the real `mv`, `rsync` or `tar`; the BUILT extension's handlers; the
 * real dispatcher and commit gate; a real git repository whose tracked file is
 * clean. Scripted is the model only, at the provider boundary.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeMapKey } from "../clients/path-utils.js";
import { execFileSync } from "./support/git-fixture-env.js";
import {
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	commitAttempt,
	endTurn,
	step,
	toolResults,
	warmGuardedSession,
} from "./support/pi-session-commit-gate.js";
import {
	type PiSession,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

/** The bundled rule that proves the recovered bytes reached a dispatcher. */
const DISPATCH_RULE = "debugger-statement";
/** A file the bundled `debugger-statement` rule blocks on. */
const BLOCKING = "export function f() {\n\tdebugger;\n}\n";
const CLEAN = "export const a = 1;\n";

const fixture = piSessionFixture();
const haveRsync =
	spawnSync("rsync", ["--version"], { stdio: "ignore" }).status === 0;

beforeAll(() => warmGuardedSession(fixture.root));

interface Row {
	type?: string;
	phase?: string;
	filePath?: string;
	diagnostics?: Array<{ rule?: string }>;
	metadata?: Record<string, unknown>;
}

/** What one case lays out: the repo, and the staged bytes with an old mtime. */
interface Layout {
	proj: string;
	target: string;
	stage: string;
}

/**
 * A committed repository whose `src/a.ts` is clean, and, outside it, `stage/`
 * holding `a.ts` (the blocking bytes, mtime a minute old), `x.tar` (that file)
 * and `root.tar` (that file as `src/a.ts`). A copy, a move or an extraction of
 * the staged file keeps the old mtime.
 */
function layout(name: string): Layout {
	const root = path.join(fixture.root, name);
	const proj = path.join(root, "proj");
	const stage = path.join(root, "stage");
	const target = path.join(proj, "src", "a.ts");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.mkdirSync(path.join(stage, "tree", "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "package.json"), "{}\n");
	fs.writeFileSync(target, CLEAN);
	fs.mkdirSync(path.join(proj, "vendor"));
	fs.writeFileSync(path.join(proj, "vendor", "a.ts"), CLEAN);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: proj, stdio: "ignore" });
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
	const old = new Date(Date.now() - 60_000);
	for (const file of [
		path.join(stage, "a.ts"),
		path.join(stage, "tree", "src", "a.ts"),
	]) {
		fs.writeFileSync(file, BLOCKING);
		fs.utimesSync(file, old, old);
	}
	execFileSync("tar", ["-cf", path.join(stage, "x.tar"), "-C", stage, "a.ts"]);
	execFileSync("tar", [
		"-cf",
		path.join(stage, "root.tar"),
		"-C",
		path.join(stage, "tree"),
		"src/a.ts",
	]);
	return { proj: fs.realpathSync.native(proj), target, stage };
}

/** One bash call, then a commit attempt, over `command` for this layout. */
async function runThenCommit(
	name: string,
	command: (l: Layout) => string,
): Promise<{ l: Layout; session: PiSession; scope: string; commit: string }> {
	const l = layout(name);
	const session = await startPiSession({
		root: fixture.root,
		cwd: l.proj,
		flags: new Map(GUARDED_FLAGS),
		responses: [
			step(fauxToolCall("bash", { command: command(l) }), "moving"),
			step(commitAttempt(), "committing"),
			endTurn("done"),
		],
	});
	await session.prompt("bring the file in and commit");
	const commits = toolResults(session.requests.at(-1) ?? [], "bash").filter(
		(r) => r.text.includes(RAN_MARKER) || r.text.includes(GATE_BLOCK),
	);
	expect(commits).toHaveLength(1);
	return {
		l,
		session,
		scope: fs.realpathSync.native(path.dirname(l.proj)),
		commit: commits[0]?.text ?? "",
	};
}

async function rows(session: PiSession, scope: string): Promise<Row[]> {
	const read = await session.latencyRows();
	expect(read.skipped).toBe(0);
	return (read.rows as Row[]).filter((row) =>
		(row.filePath ?? "").startsWith(scope),
	);
}

function dispatchedRules(rowsRead: readonly Row[], target: string): string[] {
	const key = normalizeMapKey(target);
	return rowsRead
		.filter(
			(row) =>
				row.type === "runner" &&
				row.filePath !== undefined &&
				normalizeMapKey(row.filePath) === key,
		)
		.flatMap((row) => (row.diagnostics ?? []).map((entry) => entry.rule ?? ""));
}

/** What every form must reach once the bytes landed: dispatch, log, gate. */
async function expectReached(
	run: Awaited<ReturnType<typeof runThenCommit>>,
): Promise<void> {
	expect(fs.readFileSync(run.l.target, "utf8")).toBe(BLOCKING);
	const read = await rows(run.session, run.scope);
	expect(dispatchedRules(read, run.l.target)).toContain(DISPATCH_RULE);
	expect(
		read.some(
			(row) =>
				row.phase === "disk_change_published" &&
				row.metadata?.sources === "bash-write" &&
				Number(row.metadata?.recorded) >= 1,
		),
	).toBe(true);
	// The gate row: the moved, copied or extracted `debugger;` blocks the commit,
	// and the shell never ran it.
	expect(run.commit).toContain(GATE_BLOCK);
	expect(run.commit).not.toContain(RAN_MARKER);
}

const LANE = { timeout: 180_000 };

describe("a bash write into a directory keeps its old mtime (#5552)", () => {
	// Control, merged in #5581: the prescan names the destination FILE, so the
	// same bytes reach every consumer. It proves the harness, not the fix.
	it(
		"control: mv onto the named file reaches dispatch, the log and the gate",
		LANE,
		async () => {
			await expectReached(
				await runThenCommit(
					"mv-file",
					(l) => `mv -f ${l.stage}/a.ts ${path.join(l.proj, "src", "a.ts")}`,
				),
			);
		},
	);

	// Recurrence prevented: `mv a.ts src/` named the directory `src/`, which the
	// prescan dropped, so the moved bytes stayed on the mtime filter.
	it(
		"mv into a directory with a trailing slash reaches dispatch, the log and the gate",
		LANE,
		async () => {
			await expectReached(
				await runThenCommit("mv-slash", (l) => `mv -f ${l.stage}/a.ts src/`),
			);
		},
	);

	// Recurrence prevented: the same, with no trailing slash: only the
	// filesystem says whether `src` is a directory.
	it(
		"mv into a directory without a trailing slash reaches dispatch, the log and the gate",
		LANE,
		async () => {
			await expectReached(
				await runThenCommit("mv-bare", (l) => `mv -f ${l.stage}/a.ts src`),
			);
		},
	);

	it.skipIf(!haveRsync)(
		"rsync -a of a directory into a directory reaches dispatch, the log and the gate",
		LANE,
		async () => {
			await expectReached(
				await runThenCommit(
					"rsync-dir",
					(l) => `rsync -a --delete-after ${l.stage}/tree/src/ src/`,
				),
			);
		},
	);

	it.skipIf(!haveRsync)(
		"rsync -a of one file into a directory reaches dispatch, the log and the gate",
		LANE,
		async () => {
			await expectReached(
				await runThenCommit(
					"rsync-file",
					(l) => `rsync -a --exclude '*.log' ${l.stage}/a.ts src/`,
				),
			);
		},
	);

	// Recurrence prevented: `tar x` names an archive, not the files it writes.
	it(
		"tar -xf into -C DIR reaches dispatch, the log and the gate",
		LANE,
		async () => {
			await expectReached(
				await runThenCommit(
					"tar-C",
					(l) => `tar -xf ${l.stage}/x.tar -C ${path.join(l.proj, "src")}`,
				),
			);
		},
	);

	it(
		"tar xf in the working directory reaches dispatch, the log and the gate",
		LANE,
		async () => {
			await expectReached(
				await runThenCommit("tar-cwd", (l) => `tar xf ${l.stage}/root.tar`),
			);
		},
	);

	it(
		"tar xf after a cd reaches dispatch, the log and the gate",
		LANE,
		async () => {
			await expectReached(
				await runThenCommit(
					"tar-cd",
					(l) => `cd src && tar xf ${l.stage}/x.tar`,
				),
			);
		},
	);

	// Recurrence prevented (#5581 r2 F3, for the new forms): a named scope may
	// hold a file the command wrote nothing over. `--ignore-existing` leaves the
	// user's own old-mtime edit alone, and crediting it to the command would
	// block the user's bytes at the commit gate.
	it.skipIf(!haveRsync)(
		"does not credit an rsync that wrote nothing over a user-dirty file",
		LANE,
		async () => {
			const l = layout("rsync-ignore-existing");
			const old = new Date(Date.now() - 60_000);
			fs.writeFileSync(l.target, BLOCKING);
			fs.utimesSync(l.target, old, old);
			const session = await startPiSession({
				root: fixture.root,
				cwd: l.proj,
				flags: new Map(GUARDED_FLAGS),
				responses: [
					step(
						fauxToolCall("bash", {
							command: `rsync -a --ignore-existing ${l.stage}/tree/src/ src/`,
						}),
						"syncing",
					),
					endTurn("done"),
				],
			});
			await session.prompt("sync");
			const read = await rows(
				session,
				fs.realpathSync.native(path.dirname(l.proj)),
			);
			expect(dispatchedRules(read, l.target)).toEqual([]);
		},
	);
	// Recurrence prevented: a failed command's partial writes are not credited
	// by name (the restore rule `cp` follows, #2000): an `exit 1` after the
	// extraction leaves the old-mtime bytes on the mtime filter.
	it("does not credit a directory a failed command filled", LANE, async () => {
		const l = layout("tar-failed");
		const session = await startPiSession({
			root: fixture.root,
			cwd: l.proj,
			flags: new Map(GUARDED_FLAGS),
			responses: [
				step(
					fauxToolCall("bash", {
						command: `tar -xf ${l.stage}/x.tar -C src; exit 1`,
					}),
					"extracting",
				),
				endTurn("done"),
			],
		});
		await session.prompt("extract");
		expect(fs.readFileSync(l.target, "utf8")).toBe(BLOCKING);
		const read = await rows(
			session,
			fs.realpathSync.native(path.dirname(l.proj)),
		);
		expect(dispatchedRules(read, l.target)).toEqual([]);
	});

	// Recurrence prevented: a file a scope credited joins the recognized set, and
	// that set is the recordable one: a vendored tree is not dispatched.
	it("does not dispatch a vendored file a tar filled", LANE, async () => {
		const run = await runThenCommit(
			"tar-vendor",
			(l) => `tar -xf ${l.stage}/x.tar -C vendor`,
		);
		const vendored = path.join(run.l.proj, "vendor", "a.ts");
		expect(fs.readFileSync(vendored, "utf8")).toBe(BLOCKING);
		const read = await rows(run.session, run.scope);
		expect(dispatchedRules(read, vendored)).toEqual([]);
		expect(run.commit).toContain(RAN_MARKER);
	});
});
