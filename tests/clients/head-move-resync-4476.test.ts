// flake-shape: in-process-mock — a project lsp.json cannot declare an auxiliary server (its role is reserved and inert), so the role lookup (getServerById) answers for the auxiliary fake the config setter's selection adds for the repositories registered here (#4476); every server is still a real child process on a real stdio wire
// flake-shape: ungoverned-wait-for — #4528 r1 F3 joins a dependency restart that runs between real server processes and ends after the bounded tool_call hook returns; nothing in it is awaitable.
/**
 * #4476: a change pi-lens sees only on disk reaches the servers and the cache.
 * Split out of `head-move-resync-4493.test.ts` for #3801; the shared harness is
 * `tests/support/head-move-resync-kit.ts` (real git repository, fake-LSP
 * children, the real `handleToolCall` / `handleToolResult` seams).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workspaceFileCreatedAtFor } from "../../clients/lsp/workspace-diagnostics-session.js";
import {
	auxiliaries,
	type Repo,
	makeRepo,
	lspService,
	hold,
	holdWithAuxiliary,
	traceLines,
	session,
	phaseRows,
	useHeadMoveHarness,
} from "../support/head-move-resync-kit.js";

// #4476: the role lookup the registry's restart asks (`getServerById`) knows
// the built-in catalog only; it answers for the auxiliaries registered here too.
vi.mock("../../clients/lsp/server.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/server.js")>();
	return {
		...actual,
		getServerById: (id: string) =>
			[...auxiliaries.values()].find(
				(aux) => (aux as { id?: string }).id === id,
			) ?? actual.getServerById(id),
	};
});

useHeadMoveHarness();

/** The `lsp_diagnostics` tool's answer for `file`, as the model reads it. */
async function diagnose(repo: Repo, file: string): Promise<string> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4476",
		{ paths: [file], serverScope: "primary", waitMs: 3000, concurrency: 1 },
		undefined,
		null,
		{ cwd: repo.dir },
	)) as { content: Array<{ text?: string }> };
	return result.content.map((part) => String(part.text ?? "")).join("\n");
}

/** How many times a fake server was initialized for `repo`. */
const initializeCount = (repo: Repo) =>
	traceLines(repo).filter((line) => line === "recv initialize").length;

/** The lsp_out_of_band_change rows of `repo` (#4476). */
async function outOfBandRows(repo: Repo) {
	return (await phaseRows("lsp_out_of_band_change")).filter(
		(row) => row.filePath === repo.dir,
	) as unknown as Array<{ result: string; metadata: Record<string, unknown> }>;
}

describe("a change pi-lens sees only on disk reaches the servers and the cache (#4476)", () => {
	// The checker profile models TypeScript 7's native server: a closed file's
	// view is what it first read, until an exact-URI watched-files event or a
	// restart. `G_*` names need an ambient declaration; `dep` resolves to
	// node_modules/dep/index.d.ts.
	const CHECKER = { FAKE_LSP_CLOSED_FILE_CACHE: "1" };
	const IGNORE = { ".gitignore": ".pi-lens/\ngen/\nnode_modules/\n" };
	const NOTES = [{ "notes.txt": "a\n" }, { "notes.txt": "b\n" }] as const;
	const USES_G = "export const n: number = G_FOO;\n";
	const USES_DEP = 'import type { Cfg2 } from "dep";\nexport type T = Cfg2;\n';
	let previousLookMs: string | undefined;
	beforeAll(() => {
		// Every tool_call look walks: the interval is pinned in its own case.
		previousLookMs = process.env.PI_LENS_DECLARATION_LOOK_MS;
		process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
	});
	afterAll(() => {
		if (previousLookMs === undefined)
			delete process.env.PI_LENS_DECLARATION_LOOK_MS;
		else process.env.PI_LENS_DECLARATION_LOOK_MS = previousLookMs;
	});

	// Recurrence: #4476 R1. A command wrote a declaration file into a gitignored
	// directory (codegen); no tool result names it, so the server never re-read
	// it and the cache kept serving the importer's old finding.
	it("clears a finding when a bash command creates the ambient declaration in a gitignored directory", async () => {
		const repo = await makeRepo(
			{ ...IGNORE, "a.ts": USES_G, ...NOTES[0] },
			NOTES[1],
			[],
			CHECKER,
		);
		const s = session(repo, "s-4476-create");
		expect(await diagnose(repo, repo.file("a.ts"))).toContain(
			"Cannot find name 'G_FOO'",
		);

		await s.bash("node gen.mjs", () => {
			fs.mkdirSync(repo.file("gen"));
			fs.writeFileSync(
				repo.file("gen/globals.d.ts"),
				"declare const G_FOO: number;\n",
			);
		});

		expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
			"Cannot find name",
		);
		expect(await outOfBandRows(repo)).toMatchObject([
			{
				result: "declarations",
				metadata: {
					trigger: "tool_result",
					created: 1,
					changed: 0,
					deleted: 0,
				},
			},
		]);
	}, 60_000);

	// Recurrence: #4476 with #4507's shape. A command that generates a
	// declaration and rewrites a file using it: the file's dispatch follows the
	// look at once, so the watched-files event must be on the wire before it,
	// not after the debounce window.
	it.each([
		["push", CHECKER],
		["pull", { ...CHECKER, FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "0" }],
	] as const)(
		"checks a file the same command rewrote against the declaration it generated (%s diagnostics)",
		async (_mode, profile) => {
			const repo = await makeRepo(
				{ ...IGNORE, "a.ts": "export const n: number = 1;\n", ...NOTES[0] },
				NOTES[1],
				[],
				profile,
			);
			await hold(repo, ["a.ts"]);
			const s = session(repo, "s-4476-same-command");

			const text = await s.bash("sed -i s/1/G_FOO/ a.ts", () => {
				fs.mkdirSync(repo.file("gen"));
				fs.writeFileSync(
					repo.file("gen/globals.d.ts"),
					"declare const G_FOO: number;\n",
				);
				fs.writeFileSync(repo.file("a.ts"), USES_G);
			});

			expect(text).not.toContain("Cannot find name");
			expect(text).not.toContain("STOP");
		},
		60_000,
	);

	// Recurrence: #4476 R2, edit and delete. An ambient declaration changed
	// outside pi kept its old view on the server, and a clean cache entry kept
	// answering clean for a file that no longer compiles.
	const edit = (file: string) =>
		fs.writeFileSync(file, "declare const G_BAR: number;\n");
	const remove = (file: string) => fs.rmSync(file);
	const PULL = { ...CHECKER, FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "0" };
	it.each([
		["edited", "push", edit, { changed: 1 }, CHECKER],
		["deleted", "push", remove, { deleted: 1 }, CHECKER],
		["edited", "pull", edit, { changed: 1 }, PULL],
	] as const)(
		"reports the finding when the ambient declaration is %s outside pi, at the next tool_call (%s diagnostics)",
		async (_label, mode, change, counts, profile) => {
			const repo = await makeRepo(
				{
					"a.ts": USES_G,
					"types/globals.d.ts": "declare const G_FOO: number;\n",
					...NOTES[0],
				},
				NOTES[1],
				[],
				profile,
			);
			const s = session(repo, `s-4476-${_label}-${mode}`);
			expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
				"Cannot find name",
			);
			await s.read(repo.file("a.ts"));

			change(repo.file("types/globals.d.ts"));
			await s.read(repo.file("a.ts"));

			expect(await diagnose(repo, repo.file("a.ts"))).toContain(
				"Cannot find name 'G_FOO'",
			);
			expect(await outOfBandRows(repo)).toMatchObject([
				{
					result: "declarations",
					metadata: { trigger: "tool_call", ...counts },
				},
			]);
		},
		60_000,
	);

	// Recurrence: #4476 R2 for a finding. An edit outside pi that declares the
	// missing name: the cached finding names the server that reported it, and
	// a change seen on disk names none, so it must count for every server.
	it("clears a finding when the ambient declaration is edited outside pi to declare the name", async () => {
		const repo = await makeRepo(
			{
				"a.ts": USES_G,
				"types/globals.d.ts": "declare const G_BAR: number;\n",
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		const s = session(repo, "s-4476-edit-fixes");
		expect(await diagnose(repo, repo.file("a.ts"))).toContain(
			"Cannot find name 'G_FOO'",
		);
		await s.read(repo.file("a.ts"));

		fs.writeFileSync(
			repo.file("types/globals.d.ts"),
			"declare const G_FOO: number;\n",
		);
		await s.read(repo.file("a.ts"));

		expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
			"Cannot find name",
		);
	}, 60_000);

	// Recurrence: #4476's install comment. After `npm install` brought a
	// version with different types, the server kept the old declarations of
	// the closed dependency files for its whole life.
	it("restarts the server after a bash dependency install, so the dependent sees the new declarations", async () => {
		const repo = await makeRepo(
			{
				...IGNORE,
				"a.ts": USES_DEP,
				"node_modules/dep/index.d.ts": "export type Cfg = { a: string };\n",
				"node_modules/.package-lock.json": '{"v":1}\n',
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		// Another project's server, live in the same service.
		const other = await makeRepo(
			{ "b.ts": "export {};\n", ...NOTES[0] },
			NOTES[1],
		);
		await hold(other, ["b.ts"]);
		try {
			// The repository's auxiliary scanner resolves no dependencies.
			await holdWithAuxiliary(repo, ["a.ts"], 0);
			const s = session(repo, "s-4476-install");
			expect(await diagnose(repo, repo.file("a.ts"))).toContain(
				"has no exported member 'Cfg2'",
			);
			// A command that installs nothing restarts nothing.
			await s.bash("ls", () => {});
			expect(initializeCount(repo)).toBe(1);

			await s.bash("npm install dep@2", () => {
				fs.writeFileSync(
					repo.file("node_modules/dep/index.d.ts"),
					"export type Cfg2 = { b: number };\n",
				);
				fs.writeFileSync(
					repo.file("node_modules/.package-lock.json"),
					'{"v":2}\n',
				);
			});

			expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
				"no exported member",
			);
			expect(initializeCount(repo)).toBe(2);
			expect(await outOfBandRows(repo)).toMatchObject([
				{
					result: "install",
					metadata: { trigger: "tool_result", restarted: 1 },
				},
			]);
			// Only the primary clients of the installed root restart.
			expect(initializeCount(other)).toBe(1);
		} finally {
			auxiliaries.delete(repo.dir);
		}
	}, 60_000);

	// Recurrence: #4528 r1 F2. A codemode script's `npm install` is a nested
	// bash (parentToolCallId on both events); its result must look for the
	// install like a top-level one.
	it("restarts the server after a dependency install a nested bash ran", async () => {
		const repo = await makeRepo(
			{
				...IGNORE,
				"a.ts": USES_DEP,
				"node_modules/dep/index.d.ts": "export type Cfg = { a: string };\n",
				"node_modules/.package-lock.json": '{"v":1}\n',
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		const s = session(repo, "s-4528-nested-install", undefined, "codemode-2");
		expect(await diagnose(repo, repo.file("a.ts"))).toContain(
			"has no exported member 'Cfg2'",
		);
		await s.bash("ls", () => {});

		await s.bash("npm install dep@2", () => {
			fs.writeFileSync(
				repo.file("node_modules/dep/index.d.ts"),
				"export type Cfg2 = { b: number };\n",
			);
			fs.writeFileSync(
				repo.file("node_modules/.package-lock.json"),
				'{"v":2}\n',
			);
		});

		expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
			"no exported member",
		);
		expect(await outOfBandRows(repo)).toMatchObject([
			{ result: "install", metadata: { trigger: "tool_result", restarted: 1 } },
		]);
	}, 60_000);

	// Recurrence: #4476 F5/F12. An install made outside pi is seen at the next
	// tool_call, and two sessions on one root share the server: the install
	// restarts it once, not once per session.
	it("restarts once at the next tool_call after an install outside pi, however many sessions look", async () => {
		const repo = await makeRepo(
			{
				...IGNORE,
				"a.ts": USES_DEP,
				"node_modules/dep/index.d.ts": "export type Cfg = { a: string };\n",
				"pnpm-lock.yaml": "v: 1\n",
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		const first = session(repo, "s-4476-outside-1");
		const second = session(repo, "s-4476-outside-2");
		expect(await diagnose(repo, repo.file("a.ts"))).toContain(
			"has no exported member 'Cfg2'",
		);
		await first.read(repo.file("a.ts"));
		await second.read(repo.file("a.ts"));

		fs.writeFileSync(
			repo.file("node_modules/dep/index.d.ts"),
			"export type Cfg2 = { b: number };\n",
		);
		fs.writeFileSync(repo.file("pnpm-lock.yaml"), "v: 2\n");
		await Promise.all([
			first.read(repo.file("a.ts")),
			second.read(repo.file("a.ts")),
		]);

		expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
			"no exported member",
		);
		expect(await outOfBandRows(repo)).toMatchObject([
			{ result: "install", metadata: { trigger: "tool_call", restarted: 1 } },
		]);
	}, 60_000);

	// Recurrence: #4528 r1 F3, refuted and pinned. The install moves the cache
	// clock, then the restart waits on the spawn gate (here behind another
	// root's restart, whose server ignores shutdown). A project-wide pull
	// started in that wait reads the old server's view, with a stamp newer
	// than the clock; the read after the restart must still not serve it.
	// (lsp_diagnostics' own per-file pulls take their leases through the same
	// gate, behind the restart, so they get the new server.)
	it("refuses an entry the old server answered while the restart waited for the spawn gate", async () => {
		const previousPull = process.env.PI_LENS_LSP_WORKSPACE_PULL;
		process.env.PI_LENS_LSP_WORKSPACE_PULL = "1";
		try {
			const slow = await makeRepo(
				{
					...IGNORE,
					"b.ts": "export {};\n",
					"pnpm-lock.yaml": "v: 1\n",
					...NOTES[0],
				},
				NOTES[1],
				[],
				{ FAKE_LSP_IGNORE_SHUTDOWN: "1" },
			);
			const repo = await makeRepo(
				{
					...IGNORE,
					"a.ts": USES_DEP,
					"node_modules/dep/index.d.ts": "export type Cfg = { a: string };\n",
					"node_modules/.package-lock.json": '{"v":1}\n',
					...NOTES[0],
				},
				NOTES[1],
				[],
				{
					...CHECKER,
					FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "0",
					FAKE_LSP_WORKSPACE_DIAGNOSTICS: "1",
				},
			);
			await hold(slow, ["b.ts"]);
			const first = session(slow, "s-4528-f3-slow");
			const second = session(repo, "s-4528-f3");
			expect(await diagnose(repo, repo.file("a.ts"))).toContain(
				"has no exported member 'Cfg2'",
			);
			await first.read(slow.file("b.ts"));
			await second.read(repo.file("a.ts"));

			fs.writeFileSync(slow.file("pnpm-lock.yaml"), "v: 2\n");
			fs.writeFileSync(
				repo.file("node_modules/dep/index.d.ts"),
				"export type Cfg2 = { b: number };\n",
			);
			fs.writeFileSync(
				repo.file("node_modules/.package-lock.json"),
				'{"v":2}\n',
			);
			// The slow root's restart holds the spawn gate through its shutdown.
			const slowLook = first.read(slow.file("b.ts"));
			await vi.waitFor(() =>
				expect(traceLines(slow)).toContain("recv shutdown"),
			);
			const clock = () =>
				workspaceFileCreatedAtFor(
					() => false,
					() => false,
				);
			const before = clock();
			const look = second.read(repo.file("a.ts"));
			await vi.waitFor(() => expect(clock()).toBeGreaterThan(before));
			// The install is noted; the restart waits behind the slow one.
			const service = await lspService();
			const sweep = async () =>
				JSON.stringify(
					(
						await service.runWorkspaceDiagnostics(repo.dir, {
							files: [repo.file("a.ts")],
						})
					).map((result) => result.diagnostics.map((d) => d.message)),
				);
			const during = await sweep();
			await Promise.all([slowLook, look]);
			// The hooks bound their looks; the restarts finish after them.
			await vi.waitFor(
				async () =>
					expect(await outOfBandRows(repo)).toMatchObject([
						{ result: "install", metadata: { restarted: 1 } },
					]),
				{ timeout: 15_000 },
			);

			expect(during).toContain("no exported member");
			expect(await diagnose(repo, repo.file("a.ts"))).not.toContain(
				"no exported member",
			);
		} finally {
			if (previousPull === undefined)
				delete process.env.PI_LENS_LSP_WORKSPACE_PULL;
			else process.env.PI_LENS_LSP_WORKSPACE_PULL = previousPull;
		}
	}, 60_000);

	// Recurrence: the walk's cost at every tool_call. Within the interval a
	// tool_call look reads the install stamps only; a bash result always walks.
	it("walks the declaration files at most once per interval at tool_calls, and at every bash result", async () => {
		const repo = await makeRepo(
			{
				"a.ts": USES_G,
				"types/globals.d.ts": "declare const G_FOO: number;\n",
				...NOTES[0],
			},
			NOTES[1],
			[],
			CHECKER,
		);
		const s = session(repo, "s-4476-interval");
		process.env.PI_LENS_DECLARATION_LOOK_MS = "600000";
		try {
			await s.read(repo.file("a.ts"));
			fs.rmSync(repo.file("types/globals.d.ts"));
			await s.read(repo.file("a.ts"));
			expect(await outOfBandRows(repo)).toEqual([]);

			await s.bash("ls", () => {});
			expect(await outOfBandRows(repo)).toMatchObject([
				{
					result: "declarations",
					metadata: { trigger: "tool_result", deleted: 1 },
				},
			]);
		} finally {
			process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
		}
	}, 60_000);

	// Recurrence: shape 10. A tree too large to walk must say so, never read as
	// "no declaration changed".
	it.each([
		[
			"directory",
			(repo: Repo) => {
				for (let i = 0; i < 4100; i++)
					fs.mkdirSync(repo.file(`gen/d${i}`), { recursive: true });
			},
		],
		[
			"file",
			(repo: Repo) => {
				fs.mkdirSync(repo.file("gen"));
				for (let i = 0; i < 2100; i++)
					fs.writeFileSync(repo.file(`gen/t${i}.d.ts`), "export {};\n");
			},
		],
	] as const)(
		"records one degradation when the walk passes its %s cap",
		async (label, grow) => {
			// In a gitignored directory: the bash result dispatches none of them.
			const repo = await makeRepo(
				{ ...IGNORE, "a.ts": USES_G, ...NOTES[0] },
				NOTES[1],
			);
			grow(repo);
			const s = session(repo, `s-4476-cap-${label}`);
			const { getDegradationSummary } =
				await import("../../clients/degradation-ledger.js");
			const capped = () =>
				getDegradationSummary()
					.find((group) => group.kind === "lsp-declaration-look-capped")
					?.latestReasons.filter((entry) =>
						entry.subject.includes(path.basename(repo.dir)),
					).length ?? 0;

			await s.read(repo.file("a.ts"));
			await s.bash("ls", () => {});

			expect(capped()).toBe(1);
			expect(await outOfBandRows(repo)).toEqual([]);
		},
		60_000,
	);
});
