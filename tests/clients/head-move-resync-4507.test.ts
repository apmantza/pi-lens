// flake-shape: real-process-spawn — a clean-tree HEAD move exists only in a real repository that git checks out, rebases or resets; a stubbed git could not rewrite the files the language server holds.
/**
 * #4507: a bash command's writes reach the primaries before its dispatches.
 * Split out of `head-move-resync-4493.test.ts` for #3801; the shared harness is
 * `tests/support/head-move-resync-kit.ts` (real git repository, fake-LSP
 * children, the real `handleToolCall` / `handleToolResult` seams).
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	primaryOrdering,
	primaryResend,
	auxiliaries,
	sha,
	type Repo,
	makeRepo,
	lspService,
	hold,
	holdWithAuxiliary,
	traceLines,
	wire,
	textLine,
	sentDiskBytes,
	session,
	phaseRows,
	TYPES_A,
	TYPES_B,
	useHeadMoveHarness,
} from "../support/head-move-resync-kit.js";

useHeadMoveHarness();

/** The bash_write_primary_resync rows of `repo` (#4507). */
async function primaryResyncRows(repo: Repo) {
	return (await phaseRows("bash_write_primary_resync")).filter((row) =>
		row.filePath.includes(repo.dir),
	) as unknown as Array<{
		result: string;
		filePath: string;
		metadata: Record<string, unknown>;
	}>;
}

describe("a bash command's writes reach the primaries before its dispatches (#4507)", () => {
	// a.ts imports a name the same command adds to z.ts. The checker profile
	// models TypeScript 7's closed-file view: a.ts is checked against the z.ts
	// bytes the server holds.
	const A0 =
		'import { isChatModel } from "./z";\nexport const v = isChatModel(1);\n';
	const A1 =
		'import { isChatModelConfig } from "./z";\nexport const v = isChatModelConfig(1);\n';
	const CHECKER = { FAKE_LSP_CLOSED_FILE_CACHE: "1" };
	// makeRepo's branch B must change something; these cases never check it out.
	const NOTES_A = { "notes.txt": "a\n" };
	const NOTES_B = { "notes.txt": "b\n" };

	// Recurrence: #4507. The command's files were dispatched one at a time, so
	// a.ts (first) was checked while the server still held z.ts's old bytes and
	// the result STOPped on an export the same command had just added.
	it("checks a dependent the command rewrote against its rewritten dependency", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			CHECKER,
		);
		await hold(repo, ["z.ts", "a.ts"]);
		const s = session(repo, "s-4507-sed");
		const service = await lspService();

		const text = await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(text).not.toContain("no exported member");
		expect(text).not.toContain("STOP");
		expect(sentDiskBytes(service, repo, "z.ts")).toBe(true);
		expect(sentDiskBytes(service, repo, "a.ts")).toBe(true);
		expect(await primaryResyncRows(repo)).toMatchObject([
			{
				result: "sent",
				metadata: { written: 2, opaque: 0, targets: 2, primary: 2 },
			},
		]);
	}, 60_000);

	// Recurrence: #4528 r1 F2. A codemode script's bash is a nested call
	// (parentToolCallId on both events); nothing may key the primary phase on
	// a top-level call, or a nested sed brings the phantom STOP back.
	it("checks a dependent a nested bash rewrote against its rewritten dependency", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			CHECKER,
		);
		await hold(repo, ["z.ts", "a.ts"]);
		const s = session(repo, "s-4528-nested", undefined, "codemode-1");

		const text = await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(text).not.toContain("no exported member");
		expect(await primaryResyncRows(repo)).toMatchObject([
			{ result: "sent", metadata: { written: 2, targets: 2, primary: 2 } },
		]);
	}, 60_000);

	// Recurrence: #4528 r1 F1. The 500 ms bound cut the primary phase while it
	// was still sending, and the dispatch loop then checked a.ts before z.ts's
	// new bytes were on the wire: the #4507 phantom STOP under load. Here the
	// primary reads its input slowly (each didChange of a 120 KB filler costs
	// it 120 ms), so the phase outlasts 500 ms on any host.
	it.each([
		["push", {}],
		["pull", { FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "0" }],
	] as const)(
		"checks a dependent against its rewritten dependency when the primary phase outlasts the read-only bound (%s diagnostics)",
		async (mode, diagnostics) => {
			const fillers = Array.from(
				{ length: 10 },
				(_, i) => `f${String(i).padStart(2, "0")}.ts`,
			);
			const big = (tag: string) =>
				`export const s = ${JSON.stringify(tag.repeat(120 * 1024))};\n`;
			const repo = await makeRepo(
				{
					"z.ts": TYPES_A,
					"a.ts": A0,
					...Object.fromEntries(fillers.map((name) => [name, big("a")])),
					...NOTES_A,
				},
				NOTES_B,
				[],
				{ ...CHECKER, FAKE_LSP_CHANGE_COST_MS: "120", ...diagnostics },
			);
			const order = ["a.ts", ...fillers, "z.ts"];
			await hold(repo, order);
			const s = session(repo, `s-4528-cut-${mode}`);
			const mark = traceLines(repo).length;

			const text = await s.bash(`sed -i s/a/b/ ${order.join(" ")}`, () => {
				fs.writeFileSync(repo.file("a.ts"), A1);
				for (const name of fillers) fs.writeFileSync(repo.file(name), big("b"));
				fs.writeFileSync(repo.file("z.ts"), TYPES_B);
			});

			expect(text).not.toContain("no exported member");
			if (mode === "pull") {
				// The wire: a.ts's first pull came after z.ts's new bytes.
				const after = (await wire(repo, "z.ts")).slice(mark);
				const zSent = after.indexOf(textLine(repo, "z.ts"));
				const aPull = `recv textDocument/diagnostic ${pathToFileURL(repo.file("a.ts")).href}`;
				expect(zSent).toBeGreaterThanOrEqual(0);
				expect(after.indexOf(aPull)).toBeGreaterThan(zSent);
			}
			expect(await primaryResyncRows(repo)).toMatchObject([
				{ result: "sent", metadata: { targets: 12, primary: 12 } },
			]);
		},
		120_000,
	);

	// Recurrence: #4782, the #4528 r1 F1 push case under load. The primary
	// checks a.ts against z.ts's old bytes, stores that answer, and is slow to
	// analyze z.ts's change; its republish of a.ts arrives right before the
	// reply that drains the phase. That newer answer was still in its quiet
	// window when the dispatch read a.ts, so the read took the stored one,
	// computed before z.ts's new bytes: the phantom STOP.
	it("checks a dependent against its rewritten dependency when the dependency's answer arrives right before the drain reply (push diagnostics)", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			{
				...CHECKER,
				FAKE_LSP_SLOW_CHANGE_TEXT: "export function isChatModelConfig",
				FAKE_LSP_SLOW_CHANGE_MS: "400",
			},
		);
		await hold(repo, ["a.ts", "z.ts"]);
		const s = session(repo, "s-4782-slow-dependency");
		// The window is the newer answer's quiet window (150 ms): a dispatch
		// whose first run in this process loads its modules reads a.ts later
		// than that. One earlier edit runs the dispatch once.
		await s.bash("sed -i s/1/2/ a.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A0.replace("(1)", "(2)"));
		});

		const text = await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(text).not.toContain("no exported member");
		expect(await primaryResyncRows(repo)).toMatchObject([
			{ result: "sent", metadata: { targets: 1, primary: 1 } },
			{ result: "sent", metadata: { targets: 2, primary: 2 } },
		]);
	}, 60_000);

	// Recurrence: #4782 item 1, the async republish. The primary checks a.ts
	// as soon as it reads a.ts's change, against z.ts's old bytes, and
	// re-checks its dependents only on a timer after z.ts's change (pyright
	// and typescript-language-server do, +360..400 ms measured). The drain
	// reply comes first, no later receipt is pending, and a.ts's version
	// never moved, so the dispatch read took the answer computed before
	// z.ts's new bytes: the phantom STOP. The server re-checks a document whose
	// unchanged bytes are sent again, so the phase sends a.ts again after
	// z.ts, and the read waits for the answer to that send.
	it("checks a dependent against its rewritten dependency when the primary re-checks dependents only after the drain reply (push diagnostics)", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			{ ...CHECKER, FAKE_LSP_DEFER_DEPENDENTS_MS: "5000" },
		);
		primaryResend.set(repo.dir, "rechecks");
		await hold(repo, ["a.ts", "z.ts"]);
		const s = session(repo, "s-4782-late-dependents");
		const mark = (await wire(repo, "z.ts")).length;

		const text = await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(text).not.toContain("no exported member");
		// The wire: a.ts's bytes went out again after z.ts's, and z.ts's once.
		const sent = (await wire(repo, "z.ts"))
			.slice(mark)
			.filter((line) => line.startsWith("text "));
		expect(sent).toEqual([
			textLine(repo, "a.ts"),
			textLine(repo, "z.ts"),
			textLine(repo, "a.ts"),
		]);
	}, 60_000);

	// Recurrence: the re-send above, sent to a server that publishes nothing
	// for unchanged bytes (clangd 22.1.0, measured; #3405). Its store for a.ts
	// would be emptied with no answer coming, and every dependent of a burst
	// would read inconclusive. A server not declared to re-check gets no
	// re-send.
	it("sends a dependent once when its primary is not declared to re-check unchanged bytes", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			CHECKER,
		);
		await hold(repo, ["a.ts", "z.ts"]);
		const s = session(repo, "s-4782-no-resend");
		const mark = (await wire(repo, "z.ts")).length;

		await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		const sent = (await wire(repo, "z.ts"))
			.slice(mark)
			.filter((line) => line.startsWith("text "));
		expect(sent).toEqual([textLine(repo, "a.ts"), textLine(repo, "z.ts")]);
	}, 60_000);

	// Recurrence: #4829 CodeRabbit 4368747618, measured on the r1 head (wire
	// a.ts = A1, A2, A1, A2). pi runs one message's tool calls in parallel by
	// default, so another tool's post-write sync can send a.ts's newer bytes
	// (stamped with their read, #3481) while the phase runs. An unstamped send
	// of the phase's older read then put those older bytes back on the server
	// until the next sync. Both phase sends carry the stamp taken before their
	// read, so the queue drops each one a newer read already superseded. The
	// touch spy only interleaves that other tool's real send at the point the
	// phase reaches `at`; every send runs through the real service.
	it.each([
		["between the phase's send of a.ts and its re-send", "z.ts", ["A1", "A2"]],
		["before the phase's first send of a.ts", "a.ts", ["A2"]],
	] as const)(
		"keeps a parallel tool's newer bytes that land %s",
		async (_when, at, expected) => {
			const repo = await makeRepo(
				{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
				NOTES_B,
				[],
				CHECKER,
			);
			primaryResend.set(repo.dir, "rechecks");
			await hold(repo, ["a.ts", "z.ts"]);
			const s = session(repo, `s-4782-parallel-edit-${at}`);
			const service = await lspService();
			const bytes = { A1, A2: `${A1}export const w = 2;\n` };
			const real = service.touchFile.bind(service);
			const spy = vi
				.spyOn(service, "touchFile")
				.mockImplementation(async (filePath, content, options) => {
					if (
						options?.source === "head_move_primary" &&
						filePath === repo.file(at)
					) {
						fs.writeFileSync(repo.file("a.ts"), bytes.A2);
						await real(repo.file("a.ts"), bytes.A2, {
							diagnostics: "none",
							clientScope: "primary",
							source: "lsp_sync",
							readStamp: performance.now(),
						});
					}
					return real(filePath, content, options);
				});
			const mark = (await wire(repo, "z.ts")).length;
			try {
				await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
					fs.writeFileSync(repo.file("a.ts"), A1);
					fs.writeFileSync(repo.file("z.ts"), TYPES_B);
				});
			} finally {
				spy.mockRestore();
			}

			const aUri = pathToFileURL(repo.file("a.ts")).href;
			const sent = (await wire(repo, "z.ts"))
				.slice(mark)
				.filter((line) => line.startsWith(`text ${aUri} `));
			expect(sent).toEqual(
				expected.map((name) => `text ${aUri} ${sha(bytes[name])}`),
			);
		},
		60_000,
	);

	// Recurrence: #4528 r1 F1, the second half. A send resolves once its bytes
	// are in the pipe, not once the server read them. This primary reads its
	// input at once and works through it slowly (150 ms a change), republishing
	// every open document after each change, so right after the sends it is
	// still publishing a.ts checked against z.ts's old bytes. The phase ends
	// with a request each server answers only after the sends before it.
	it("checks a dependent against its rewritten dependency while the primary is still working through the command's sends", async () => {
		const fillers = Array.from(
			{ length: 8 },
			(_, i) => `g${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			{
				"z.ts": TYPES_A,
				"a.ts": A0,
				...Object.fromEntries(
					fillers.map((name) => [name, "export const v = 0;\n"]),
				),
				...NOTES_A,
			},
			NOTES_B,
			[],
			{
				...CHECKER,
				FAKE_LSP_NOTIFY_BACKLOG_WEDGE: "100000",
				FAKE_LSP_NOTIFY_COST_MS: "0",
				FAKE_LSP_CHANGE_COST_MS: "150",
			},
		);
		const order = ["a.ts", ...fillers, "z.ts"];
		await hold(repo, order);
		const s = session(repo, "s-4528-backlog");

		const text = await s.bash(`sed -i s/0/1/ ${order.join(" ")}`, () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			for (const name of fillers)
				fs.writeFileSync(repo.file(name), "export const v = 1;\n");
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(text).not.toContain("no exported member");
		expect(await primaryResyncRows(repo)).toMatchObject([
			{ result: "sent", metadata: { targets: 10, primary: 10 } },
		]);
	}, 120_000);

	// Recurrence: #4528 r2, a ping overtakes didChange on a threaded primary.
	it.each(["threaded", "unmeasured"] as const)(
		"records undrained when %s replies overtake queued changes",
		async (ordering) => {
			const repo = await makeRepo(
				{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
				NOTES_B,
				[],
				{
					...CHECKER,
					FAKE_LSP_NOTIFY_BACKLOG_WEDGE: "100000",
					FAKE_LSP_NOTIFY_COST_MS: "0",
					FAKE_LSP_PING_OVERTAKES: "1",
				},
			);
			primaryOrdering.set(repo.dir, ordering);
			await hold(repo, ["a.ts", "z.ts"]);
			const s = session(repo, `s-4528-${ordering}`);
			await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
				fs.writeFileSync(repo.file("a.ts"), A1);
				fs.writeFileSync(repo.file("z.ts"), TYPES_B);
			});
			expect(await primaryResyncRows(repo)).toMatchObject([
				{ result: "undrained", metadata: { targets: 2 } },
			]);
		},
		60_000,
	);

	// Recurrence: the degraded half of #4528 r1 F1. A primary that never
	// answers the drain request (here it dies on reading the first new bytes) may
	// still be serving checks from before the sends; that must be on record,
	// and no check may read clean.
	it("records an undrained phase and reads nothing clean when the primary dies before answering the drain request", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			{ ...CHECKER, FAKE_LSP_EXIT_ON_CHANGE_TEXT: "isChatModelConfig" },
		);
		await hold(repo, ["a.ts", "z.ts"]);
		const s = session(repo, "s-4528-undrained");

		const text = await s.bash("sed -i s/a/b/ a.ts z.ts", () => {
			fs.writeFileSync(repo.file("a.ts"), A1);
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(await primaryResyncRows(repo)).toMatchObject([
			{ result: "undrained", metadata: { targets: 2 } },
		]);
		expect(text).not.toContain("JavaScript/TypeScript clean");
	}, 60_000);

	// Recurrence: #4507's opaque half. An unrecognized command's dirty paths
	// were resent to the servers detached, after the dispatch loop had already
	// checked them one at a time.
	it("sends an opaque command's held writes to the primaries before its result returns", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
			[],
			CHECKER,
		);
		await hold(repo, ["z.ts", "a.ts"]);
		const s = session(repo, "s-4507-opaque");
		const service = await lspService();

		await s.bash("node codemod.mjs", () => {
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
			fs.writeFileSync(repo.file("a.ts"), A1);
		});

		expect(sentDiskBytes(service, repo, "z.ts")).toBe(true);
		expect(sentDiskBytes(service, repo, "a.ts")).toBe(true);
		expect(await primaryResyncRows(repo)).toMatchObject([
			{
				result: "sent",
				metadata: { written: 2, opaque: 2, targets: 2, primary: 2 },
			},
		]);
	}, 60_000);

	// Recurrence: #4493 r1 F1's shape on the bash-write path. Awaiting every
	// holding server would wait out a slow auxiliary and the hook bound would
	// cut the phase; only the primaries are awaited.
	it("sends every written held document to the primary before the result returns, however slow the auxiliary", async () => {
		const names = Array.from(
			{ length: 12 },
			(_, i) => `lib/w${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			{
				...Object.fromEntries(
					names.map((name) => [name, "export const v = 0;\n"]),
				),
				...NOTES_A,
			},
			NOTES_B,
		);
		try {
			await holdWithAuxiliary(repo, names, 250);
			const s = session(repo, "s-4507-slow-aux");
			const service = await lspService();

			await s.bash("node codemod.mjs", () => {
				for (const name of names)
					fs.writeFileSync(repo.file(name), "export const v = 1;\n");
			});

			expect(
				names.filter((name) => !sentDiskBytes(service, repo, name)),
			).toEqual([]);
			expect(await primaryResyncRows(repo)).toMatchObject([
				{ result: "sent", metadata: { opaque: 12, targets: 12, primary: 12 } },
			]);
		} finally {
			auxiliaries.delete(repo.dir);
		}
	}, 90_000);

	// Recurrence: the phase must not open documents no server holds (a write
	// to an unheld file is the dispatch's to open), nor log a row for them.
	it("sends nothing and logs no row when no server holds a written file", async () => {
		const repo = await makeRepo(
			{ "z.ts": TYPES_A, "a.ts": A0, ...NOTES_A },
			NOTES_B,
		);
		const s = session(repo, "s-4507-unheld");

		await s.bash("node codemod.mjs", () => {
			fs.writeFileSync(repo.file("z.ts"), TYPES_B);
		});

		expect(await primaryResyncRows(repo)).toEqual([]);
	}, 60_000);
});
