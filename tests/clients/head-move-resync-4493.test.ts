/**
 * #4493: a clean-tree HEAD move left held documents stale on the server.
 *
 * After `git checkout B` on a clean tree (and a completed rebase or
 * cherry-pick, `git reset --hard`, or the same checkout made outside pi),
 * `git status` is empty, so opaque recovery resynced nothing and the server
 * kept the pre-move bytes of every document pi-lens had open. The next edit
 * of an unrelated line was blocked by an error `tsc` on disk does not report.
 *
 * These cases drive the REAL `handleToolCall` / `handleToolResult` seams with
 * a real RuntimeCoordinator, a real git repository and the real LSPService,
 * client and stdio wire. The servers are the shared fake LSP child process,
 * project-configured, with `FAKE_LSP_TRACE_TEXT` so its trace names the bytes
 * each didOpen/didChange carried: the wire is the witness, not pi-lens's own
 * bookkeeping. Only the host's command execution is stood in for: the test
 * runs the git command between the two hooks, as pi's bash tool would.
 *
 * The #4507 and #4476 describes live in `head-move-resync-4507.test.ts` and
 * `head-move-resync-4476.test.ts` (#3801); the shared harness is
 * `tests/support/head-move-resync-kit.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	headRecordKey,
	observeGitHead,
	recoverOpaqueChangesViaGit,
} from "../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { getProjectChangeLogPath } from "../../clients/project-changes.js";
import { resyncHeadMove } from "../../clients/runtime-tool-result.js";
import {
	auxiliaries,
	env,
	type Repo,
	repoCount,
	runGit,
	makeRepo,
	lspService,
	hold,
	holdWithAuxiliary,
	traceLines,
	wire,
	textSince,
	drainWatchQueue,
	watchedNotifications,
	textLine,
	sentDiskBytes,
	session,
	headMovedRows,
	settledHeadMovedRows,
	phaseRows,
	TYPES_A,
	TYPES_B,
	MAIN,
	useHeadMoveHarness,
} from "../support/head-move-resync-kit.js";

useHeadMoveHarness();

describe("a clean-tree HEAD move resyncs held documents (#4493)", () => {
	// Recurrence: the reported block. `git checkout B` on a clean tree sent no
	// didChange for the held lib/types.ts, so main.ts's import of the new
	// export stayed an error until the 10 s drift heartbeat happened to run.
	it("sends a held document's new bytes before the checkout's tool_result returns, and records no mutation", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN, "lib/unheld.ts": "" },
			{ "lib/types.ts": TYPES_B, "lib/unheld.ts": "export {};\n" },
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-checkout");
		const service = await lspService();
		const mark = (await wire(repo, "main.ts")).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
		expect(repo.git("status", "--porcelain")).toBe("");
		expect(await textSince(repo, mark, "main.ts")).toContain(
			textLine(repo, "lib/types.ts"),
		);
		// The delta is incoming content: no fileSeq bump, no change-log entry.
		expect(s.runtime.getFileSeq(repo.file("lib/types.ts"))).toBe(0);
		expect(fs.existsSync(getProjectChangeLogPath(repo.dir))).toBe(false);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			// The unheld file is in the delta but not resynced: only a held
			// document can be stale.
			result: "changed:2",
			metadata: {
				trigger: "tool_result",
				changed: 2,
				held: 1,
				resynced: 1,
				deferred: 0,
				failed: 0,
			},
		});
	}, 30_000);

	// Recurrence: #4742. The move's delta named lib/unheld.ts and lib/gone.ts,
	// no server held either, and the resync skipped both: a server that had read
	// lib/unheld.ts for an importer kept its old bytes for the server's life
	// (pyright flagged every attribute of the filled module as unknown). A
	// closed file reaches a server only as an exact-URI watched-files event.
	it("sends the delta's unheld paths as watched-files events (Changed, or Deleted when gone) and the held one as a document (#4742)", async () => {
		const repo = await makeRepo(
			{
				"lib/types.ts": TYPES_A,
				"main.ts": MAIN,
				"lib/unheld.ts": "",
				"lib/gone.ts": "export {};\n",
			},
			{ "lib/types.ts": TYPES_B, "lib/unheld.ts": "export {};\n" },
		);
		repo.git("checkout", "-q", "B");
		repo.git("rm", "-q", "lib/gone.ts");
		// A module absent on A, added by B: it is born inside the move.
		fs.writeFileSync(repo.file("lib/born.ts"), "export {};\n");
		repo.git("add", "lib/born.ts");
		repo.git("commit", "-qm", "B deletes gone and adds born");
		repo.git("checkout", "-q", "A");
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-unheld");
		const uri = (name: string) => pathToFileURL(repo.file(name)).href;
		// hold()'s opens queue watched events on the client's watch queue,
		// flushed after WATCH_DEBOUNCE_MS; the move's notification flushes the
		// same queue and would carry them. Send them now, before the mark, so
		// the window holds only the move's own events (review r1 F1, seed 202).
		await drainWatchQueue(repo);
		const mark = (await wire(repo, "main.ts")).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		const sent = (await wire(repo, "main.ts")).slice(mark);
		expect(sent).toContain(`watched ${uri("lib/unheld.ts")} 2`);
		expect(sent).toContain(`watched ${uri("lib/gone.ts")} 3`);
		// The held document goes out as its bytes, never inside the unheld
		// phase's watched-files notification. Only that notification is judged:
		// the earlier hold()'s debounced announce flush (WATCH_DEBOUNCE_MS) and
		// the resync's own Created for the held file are separate notifications
		// that land inside this window depending on test order (review r1 F1,
		// seed 202).
		expect(sent).toContain(textLine(repo, "lib/types.ts"));
		const notifications = watchedNotifications(sent);
		const unheldPhase = notifications.filter((lines) =>
			lines.includes(`watched ${uri("lib/unheld.ts")} 2`),
		);
		expect(unheldPhase).toEqual([
			[
				`watched ${uri("lib/born.ts")} 2`,
				`watched ${uri("lib/gone.ts")} 3`,
				`watched ${uri("lib/unheld.ts")} 2`,
			],
		]);
		// Recurrence: review r1 F2 on #4819. A module born inside the move was
		// only Changed, and a server that cached its failed lookup (pyright)
		// kept the importer's unknown-import finding; Created clears it. It goes
		// out detached from the hook, so wait for it on the wire.
		await expect
			.poll(() => traceLines(repo), { timeout: 10_000 })
			.toContain(`watched ${uri("lib/born.ts")} 1`);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows[0]?.metadata).toMatchObject({ held: 1, unheld: 3 });
	}, 30_000);

	// Recurrence: review r1 F4's named output reads HEAD from the files git
	// keeps. A reftable ref store (git 2.45+) keeps no loose or packed ref, so
	// that read cannot answer; without the `git rev-parse` fallback the
	// feature would be silently off there. Skipped only where this git cannot
	// create a reftable repository.
	const reftable = (() => {
		try {
			const probe = path.join(env.tmpDir, "reftable-probe");
			fs.mkdirSync(probe, { recursive: true });
			runGit(probe, ["init", "-q", "--ref-format=reftable"]);
			return true;
		} catch {
			return false;
		}
	})();
	it("sends the new bytes before the tool_result in a repository whose refs are a reftable", async (ctx) => {
		ctx.skip(!reftable, "this git cannot create a reftable repository");
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
			["--ref-format=reftable"],
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-reftable");
		const service = await lspService();

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
	}, 30_000);

	// Recurrence: the probe's rows 3 and 4 plus the reset sibling. Each
	// completes on a clean tree and moves HEAD, so each was as invisible as
	// the checkout.
	it.each([
		{
			kind: "a completed rebase",
			setup: (repo: Repo) => {
				fs.writeFileSync(repo.file("notes.txt"), "A local\n");
				repo.git("add", "notes.txt");
				repo.git("commit", "-qm", "A local note");
			},
			command: "git rebase B",
		},
		{
			kind: "a completed cherry-pick",
			setup: () => {},
			command: "git cherry-pick B",
		},
		{
			kind: "git reset --hard",
			setup: () => {},
			command: "git reset --hard B",
		},
	])(
		"sends the new bytes before the tool_result of $kind returns",
		async ({ setup, command }) => {
			const repo = await makeRepo(
				{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
				{ "lib/types.ts": TYPES_B },
			);
			setup(repo);
			await hold(repo, ["lib/types.ts", "main.ts"]);
			const s = session(repo, `s-${command.split(" ")[1]}`);
			const service = await lspService();
			const mark = (await wire(repo, "main.ts")).length;

			await s.bash(command, () => repo.git(...command.split(" ").slice(1)));

			expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
			expect(repo.git("status", "--porcelain")).toBe("");
			expect(fs.readFileSync(repo.file("lib/types.ts"), "utf8")).toBe(TYPES_B);
			expect(await textSince(repo, mark, "main.ts")).toContain(
				textLine(repo, "lib/types.ts"),
			);
		},
		30_000,
	);

	// Recurrence: probe row 6 (the non-TypeScript screen, AGENTS.md shape 42).
	// The seam is language-neutral; a held Python document heals the same way.
	it("resyncs a held non-TypeScript document", async () => {
		const repo = await makeRepo(
			{ "app/models.py": "def is_chat_model(x):\n    return bool(x)\n" },
			{
				"app/models.py":
					"def is_chat_model(x):\n    return bool(x)\n\ndef is_chat_model_config(x):\n    return bool(x)\n",
			},
		);
		await hold(repo, ["app/models.py"]);
		const s = session(repo, "s-python");
		const service = await lspService();
		const mark = (await wire(repo, "app/models.py")).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(sentDiskBytes(service, repo, "app/models.py")).toBe(true);
		expect(await textSince(repo, mark, "app/models.py")).toContain(
			textLine(repo, "app/models.py"),
		);
	}, 30_000);

	// Recurrence: probe row 5. A checkout made outside pi emits no tool event,
	// so only the next tool_call can notice it; a read is enough.
	it("resyncs at the next turn's first tool_call after a move made outside pi", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-outside");
		s.runtime.beginTurn("s-outside");
		await s.read(repo.file("main.ts"));
		const service = await lspService();
		const mark = (await wire(repo, "main.ts")).length;

		repo.git("checkout", "-q", "B");
		s.runtime.beginTurn("s-outside");
		await s.read(repo.file("main.ts"));

		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
		expect(await textSince(repo, mark, "main.ts")).toContain(
			textLine(repo, "lib/types.ts"),
		);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			metadata: { trigger: "tool_call", resynced: 1 },
		});
	}, 30_000);

	// Recurrence: probe INJECT2. One forced pass resyncs 4 documents, so a
	// 12-document hop left 8 stale for two more 10 s heartbeats.
	it("heals a 12-document hop before the tool_result returns", async () => {
		const names = Array.from(
			{ length: 12 },
			(_, i) => `lib/m${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			Object.fromEntries(names.map((name) => [name, `export const v = 0;\n`])),
			Object.fromEntries(names.map((name) => [name, `export const v = 1;\n`])),
		);
		await hold(repo, names);
		const s = session(repo, "s-twelve");
		const service = await lspService();
		const mark = (await wire(repo, names[0]!)).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(names.filter((name) => !sentDiskBytes(service, repo, name))).toEqual(
			[],
		);
		const received = await textSince(repo, mark, names[0]!);
		for (const name of names) expect(received).toContain(textLine(repo, name));
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows[0]).toMatchObject({
			metadata: { held: 12, resynced: 12, deferred: 0 },
		});
	}, 60_000);

	// Recurrence: review r1 F1, the reported STOP on the default stack. The
	// resync touched each held document on every holding server in turn, so
	// the auxiliary's #1714 pacing barrier, waiting out a scanner busy with the
	// earlier didChanges, held back the PRIMARY's later didChanges past the
	// hook bound: the tool_result returned with documents stale on the primary
	// and the next edit STOPped on TS2305 (13 held files, 2 of 2 live runs).
	it("sends every changed held document to the primary before the tool_result returns, however slow the auxiliary", async () => {
		const names = Array.from(
			{ length: 12 },
			(_, i) => `lib/s${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			Object.fromEntries(names.map((name) => [name, `export const v = 0;\n`])),
			Object.fromEntries(names.map((name) => [name, `export const v = 1;\n`])),
		);
		try {
			await holdWithAuxiliary(repo, names, 250);
			const s = session(repo, "s-slow-aux");
			const service = await lspService();

			await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

			expect(
				names.filter((name) => !sentDiskBytes(service, repo, name)),
			).toEqual([]);
			// The auxiliary catches up after the look; the one row lands then.
			await expect
				.poll(async () => (await headMovedRows(repo)).length, {
					timeout: 30_000,
					interval: 200,
				})
				.toBe(1);
			expect((await headMovedRows(repo))[0]).toMatchObject({
				metadata: { held: 12, primary: 12, deferred: 0 },
			});
		} finally {
			auxiliaries.delete(repo.dir);
		}
	}, 90_000);

	// Recurrence: review r1 F1, part 2. pi runs one message's tool calls in
	// parallel, so a read's tool_call can arrive while the bash's tool_result
	// look is still resending. The turn was already marked looked, so the
	// tool_call skipped the look and the read ran against the stale primary.
	it("holds a parallel tool_call until the running look has sent the move's bytes", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-join");
		s.runtime.beginTurn("s-join");
		const service = await lspService();
		const result = await s.bashCall("git checkout B");
		repo.git("checkout", "-q", "B");

		const looking = result();
		await s.read(repo.file("main.ts"));
		const sentAtRead = sentDiskBytes(service, repo, "lib/types.ts");
		await looking;

		expect(sentAtRead).toBe(true);
		expect(await settledHeadMovedRows(repo, 1)).toHaveLength(1);
	}, 30_000);

	// Recurrence: review r1 F2 (#1687's shape). A look that joins a running
	// look must see a move made after that look read HEAD; the single-flight's
	// trailing pass is what reads it again. The shim holds the running look in
	// its `git diff` so the second move lands mid-flight.
	it("a look that joins a running look sees a move made after that look read HEAD", async (ctx) => {
		ctx.skip(
			process.platform === "win32",
			"the git shim that stalls the running look is a POSIX shell script",
		);
		// C changes a file B does not, so only a look that reads HEAD after
		// the move to C (the trailing pass) resends it: the running look's
		// delta is A..B.
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "lib/other.ts": "export const o = 0;\n" },
			{ "lib/types.ts": TYPES_B },
		);
		repo.git("checkout", "-q", "B");
		fs.writeFileSync(repo.file("lib/other.ts"), "export const o = 1;\n");
		repo.git("commit", "-qam", "C");
		repo.git("branch", "C");
		repo.git("reset", "-q", "--hard", "HEAD~1");
		repo.git("checkout", "-q", "A");
		await hold(repo, ["lib/types.ts", "lib/other.ts"]);
		const service = await lspService();
		// Host boundary: a `git` on PATH that stalls `diff` while a marker
		// exists, then runs the real git.
		const realGit = (process.env.PATH ?? "")
			.split(path.delimiter)
			.map((dir) => path.join(dir, "git"))
			.find((candidate) => fs.existsSync(candidate));
		if (!realGit) throw new Error("git is not on PATH");
		const shimDir = path.join(env.tmpDir, `git-shim-${repoCount}`);
		const slow = path.join(shimDir, "slow");
		const started = path.join(shimDir, "started");
		fs.mkdirSync(shimDir, { recursive: true });
		fs.writeFileSync(
			path.join(shimDir, "git"),
			[
				"#!/bin/sh",
				`if [ "$1" = "diff" ] && [ -e ${JSON.stringify(slow)} ]; then : > ${JSON.stringify(started)}; sleep 0.4; fi`,
				`exec ${JSON.stringify(realGit)} "$@"`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${shimDir}${path.delimiter}${previousPath ?? ""}`;
		try {
			const look = {
				root: repo.dir,
				key: headRecordKey("trailing", "s-trailing"),
				trigger: "tool_result" as const,
				label: "git checkout",
			};
			await resyncHeadMove(look);
			repo.git("checkout", "-q", "B");
			fs.writeFileSync(slow, "");
			const running = resyncHeadMove(look);
			await expect.poll(() => fs.existsSync(started)).toBe(true);
			repo.git("checkout", "-q", "C");
			fs.rmSync(slow);

			await resyncHeadMove(look);

			expect(sentDiskBytes(service, repo, "lib/other.ts")).toBe(true);
			await running;
		} finally {
			process.env.PATH = previousPath;
		}
	}, 30_000);

	// Recurrence: review r1 F3. The forced passes stop as soon as no queued
	// document is waiting; without that exit every move runs all 16 passes.
	it("runs one forced pass for a one-document move", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const s = session(repo, "s-passes");

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		const file = normalizeMapKey(repo.file("lib/types.ts"));
		const rowFor = async () =>
			(await phaseRows("lsp_external_change_resync")).find(
				(row) => normalizeMapKey(row.filePath) === file,
			);
		await expect.poll(rowFor, { timeout: 10_000 }).toBeDefined();
		expect((await rowFor())?.metadata.passes).toBe(1);
	}, 30_000);

	// Recurrence: the 512-record drift-tracker eviction dropped the record of
	// a document the server still held, so a resync driven by the records
	// would skip it. The HEAD-move targets come from the clients' open
	// documents, so the document still heals before the return. #4503 made the
	// eviction half of that state unreachable (a held record is never evicted),
	// so the record is dropped through the tracker's own API to keep the case
	// the move must answer: held, no record, still on the wire.
	it("resyncs a held document whose drift record is gone", async () => {
		const held = Array.from(
			{ length: 513 },
			(_, i) => `src/f${String(i).padStart(3, "0")}.ts`,
		);
		const moved = held.slice(0, 20);
		const repo = await makeRepo(
			Object.fromEntries(held.map((name) => [name, "export const v = 0;\n"])),
			Object.fromEntries(moved.map((name) => [name, "export const v = 1;\n"])),
		);
		await hold(repo, held);
		const service = await lspService();
		const drift = (
			service as unknown as {
				documentDrift: {
					peek(file: string): unknown;
					forget(file: string): void;
				};
			}
		).documentDrift;
		// #4503: 513 held records no longer evict the oldest one, so the record
		// of a document the server holds survives the cap.
		expect(drift.peek(repo.file(held[0]!))).toBeDefined();
		// The state #4493 is about: a held document with no drift record at all.
		drift.forget(repo.file(held[0]!));
		expect(drift.peek(repo.file(held[0]!))).toBeUndefined();
		const s = session(repo, "s-evicted");
		const mark = (await wire(repo, held[0]!)).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(moved.filter((name) => !sentDiskBytes(service, repo, name))).toEqual(
			[],
		);
		expect(await textSince(repo, mark, held[0]!)).toContain(
			textLine(repo, held[0]!),
		);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			metadata: { changed: 20, held: 20, resynced: 20, deferred: 0 },
		});
	}, 120_000);

	// Recurrence: #4528 r4. The HEAD-move resync ran under the 500 ms
	// read-only bound, so a primary that read the move's changes slowly was
	// cut and the tool_result returned before the moved bytes were sent. CI's
	// shuffle seed 202 hit it with 24 live clients; here the primary pays
	// 120 ms a change on 120 KB fillers, so the phase outlasts 500 ms on any
	// host, and the move must still be on the wire when the result returns.
	it("sends every moved held document before the tool_result returns when the primary phase outlasts the read-only bound", async () => {
		const fillers = Array.from(
			{ length: 10 },
			(_, i) => `lib/h${String(i).padStart(2, "0")}.ts`,
		);
		const big = (tag: string) =>
			`export const s = ${JSON.stringify(tag.repeat(120 * 1024))};\n`;
		const repo = await makeRepo(
			{
				"lib/types.ts": TYPES_A,
				...Object.fromEntries(fillers.map((name) => [name, big("a")])),
			},
			{
				"lib/types.ts": TYPES_B,
				...Object.fromEntries(fillers.map((name) => [name, big("b")])),
			},
			[],
			{ FAKE_LSP_CHANGE_COST_MS: "120" },
		);
		const moved = [...fillers, "lib/types.ts"];
		await hold(repo, moved);
		const service = await lspService();
		const s = session(repo, "s-4528-r4-cut");

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(moved.filter((name) => !sentDiskBytes(service, repo, name))).toEqual(
			[],
		);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows[0]).toMatchObject({
			metadata: { changed: 11, resynced: 11, deferred: 0, drained: true },
		});
	}, 120_000);

	// Recurrence: an unbounded drain would hold the hook for a branch hop of
	// any size. The forced passes stop at 64 documents, and the one row
	// states how many the drain left to the paced heartbeat.
	it("states in the one row how many held documents the drain cap deferred", async () => {
		const held = Array.from(
			{ length: 70 },
			(_, i) => `src/g${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			Object.fromEntries(held.map((name) => [name, "export const v = 0;\n"])),
			Object.fromEntries(held.map((name) => [name, "export const v = 1;\n"])),
		);
		await hold(repo, held);
		const move = {
			root: repo.dir,
			key: headRecordKey("cap", "s-cap"),
			trigger: "tool_result" as const,
			label: "git checkout B",
		};
		await resyncHeadMove(move);

		// The delta is unlistable (an old HEAD the repository never had), so the
		// population is the whole held set: 70 documents, one publish, and the
		// 64-send cap defers the other 6. #4612 round 3: a LISTED population
		// over the cap no longer reaches this state — the detector publishes it
		// in chunks, so all 70 are sent and none is deferred. The cap's row is
		// still owed for the unlistable branch, which is why this cell makes the
		// delta unknown rather than listing it.
		observeGitHead(move.key, "c".repeat(40));
		repo.git("checkout", "-q", "B");
		await resyncHeadMove(move);

		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			result: "delta-unknown",
			metadata: {
				changed: -1,
				held: 70,
				heldPopulation: "all-held",
				primary: 64,
				resynced: 64,
				deferred: 6,
			},
		});
	}, 120_000);

	// Recurrence: queued targets are resent unconditionally, so every agent
	// `git commit` (a HEAD move whose files the server already holds) would
	// resend each committed held document and its importers.
	it("resends nothing when the move leaves the held bytes current, as a commit does", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		fs.writeFileSync(repo.file("lib/types.ts"), TYPES_B);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-commit");
		const mark = (await wire(repo, "main.ts")).length;

		await s.bash("git commit -qam types", () =>
			repo.git("commit", "-qam", "types"),
		);

		expect(await textSince(repo, mark, "main.ts")).toEqual([]);
		const rows = await settledHeadMovedRows(repo, 1, "HEAD");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			result: "changed:1",
			metadata: { held: 1, current: 1, resynced: 0 },
		});
	}, 30_000);

	// Recurrence: a session's parallel bash calls look concurrently. A look
	// that saw no move (its sibling's look claimed it) returned at once, while
	// the sibling was still resending, so that tool_result came back with the
	// held document stale. Looks of one session run one at a time, and a look
	// arriving mid-flight returns only after the flight's resync.
	it("returns no concurrent look of a session before the move's resync is sent", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const service = await lspService();
		const look = {
			root: repo.dir,
			key: headRecordKey("race", "s-race"),
			trigger: "tool_result" as const,
			label: "git checkout B",
		};
		await resyncHeadMove(look);
		repo.git("checkout", "-q", "B");

		const first = await Promise.race([
			resyncHeadMove(look).then(() =>
				sentDiskBytes(service, repo, "lib/types.ts"),
			),
			resyncHeadMove(look).then(() =>
				sentDiskBytes(service, repo, "lib/types.ts"),
			),
		]);

		expect(first).toBe(true);
		expect(await settledHeadMovedRows(repo, 1)).toHaveLength(1);
	}, 30_000);

	// Recurrence: a failed or truncated `git diff` read as an empty delta would
	// report "nothing changed" for a move whose documents stayed stale. The
	// row says the delta is unknown instead (an old HEAD a gc pruned, here a
	// commit id the repository never had).
	it("states delta-unknown and resends the held documents that differ from disk when the old HEAD cannot be diffed", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const move = {
			root: repo.dir,
			key: headRecordKey("gone", "s-gone"),
			trigger: "tool_call" as const,
			label: "read",
		};
		observeGitHead(move.key, "c".repeat(40));
		repo.git("checkout", "-q", "B");

		const service = await lspService();

		await resyncHeadMove(move);

		// Review r1 F6 (shape 48): the delta is unknown but the held set is
		// not, so the held documents whose bytes differ from disk are resent.
		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
		await expect.poll(async () => (await headMovedRows(repo)).length).toBe(1);
		expect((await headMovedRows(repo))[0]).toMatchObject({
			result: "delta-unknown",
			metadata: { changed: -1, held: 1 },
		});
	}, 30_000);

	// Recurrence: a shared record would let one session's observation answer
	// for another's; each session keeps its own HEAD record, so a concurrent
	// session sees the move at its own next call. The two sessions share one
	// coordinator, as in index.ts, so only the session id tells them apart.
	it("keeps one HEAD record per session: a second session sees the move at its own call", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const primary = session(repo, "s-primary");
		const secondary = session(repo, "s-secondary", primary.runtime);
		await secondary.bash("true", () => {});

		await primary.bash("git checkout B", () => repo.git("checkout", "-q", "B"));
		await secondary.read(repo.file("main.ts"));

		const rows = await settledHeadMovedRows(repo, 2);
		expect(rows.map((row) => row.metadata.trigger)).toEqual([
			"tool_result",
			"tool_call",
		]);
	}, 30_000);

	// Recurrence: pi runs the bash calls of one message in parallel, so every
	// tool_call precedes the first tool_result. One move is one row.
	it("records one move once when parallel bash calls share it", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const s = session(repo, "s-parallel");
		const first = await s.bashCall("git checkout B");
		const second = await s.bashCall("ls");
		repo.git("checkout", "-q", "B");

		await first();
		await second();

		expect(await settledHeadMovedRows(repo, 1)).toHaveLength(1);
	}, 30_000);
});

describe("the per-session HEAD records (#4493)", () => {
	const A = "a".repeat(40);
	const B = "b".repeat(40);

	// Recurrence: a record per (slot, session) grows with every cwd and every
	// session a long-lived process sees; the store is capped at 64, and a
	// session that keeps looking keeps its record while idle ones age out.
	it("keeps 64 records, refreshing the one a session observes again", () => {
		for (let i = 0; i < 64; i++) observeGitHead(`k${i}`, A);
		observeGitHead("k0", A);
		observeGitHead("k64", A);

		// k0 was refreshed, so it still reports the move; k1 was the oldest and
		// went, so its next look is a first sight, not a move.
		expect(observeGitHead("k0", B)).toBe(A);
		expect(observeGitHead("k1", B)).toBeUndefined();
	});
});

describe("opaque recovery from a subdirectory (#4493 residual 3)", () => {
	// Recurrence: `git status --porcelain` prints paths relative to the
	// repository root, and recovery resolved them against the session's cwd:
	// from a subdirectory every dirty path pointed below itself and was
	// dropped as vanished, so an opaque write there resynced nothing.
	it("recovers a dirty path when the cwd is a subdirectory of the repository", async () => {
		const repo = await makeRepo(
			{ "sub/x.ts": "export const x = 0;\n" },
			{ "sub/x.ts": "export const x = 1;\n" },
		);
		const startedAt = Date.now();
		fs.writeFileSync(repo.file("sub/x.ts"), "export const x = 2;\n");

		const outcome = await recoverOpaqueChangesViaGit(
			repo.file("sub"),
			startedAt,
		);

		expect(outcome.paths).toEqual([normalizeMapKey(repo.file("sub/x.ts"))]);
	}, 30_000);

	// Recurrence: a linked worktree's `.git` is a file, not a directory with a
	// HEAD; a path base that read only the directory form put every linked
	// worktree back on the cwd and dropped its subdirectory paths again.
	it("recovers a dirty path when the cwd is a subdirectory of a linked worktree", async () => {
		const repo = await makeRepo(
			{ "sub/x.ts": "export const x = 0;\n" },
			{ "sub/x.ts": "export const x = 1;\n" },
		);
		const linked = `${repo.dir}-linked`;
		repo.git("worktree", "add", "-q", linked, "B");
		const startedAt = Date.now();
		fs.writeFileSync(path.join(linked, "sub/x.ts"), "export const x = 2;\n");

		const outcome = await recoverOpaqueChangesViaGit(
			path.join(linked, "sub"),
			startedAt,
		);

		expect(outcome.paths).toEqual([
			normalizeMapKey(path.join(linked, "sub/x.ts")),
		]);
	}, 30_000);
});
