// flake-shape: in-process-mock — #1712: the language server and the cascade compute are the process boundary for the nightly lane's runner; the lane's own runner, fixtures and verdict code are real, and the real servers are driven by `node scripts/smoke-tools.mjs --lsp-cascade` in .github/workflows/tool-smoke.yml.
/**
 * #1712: the nightly `--lsp-cascade` lane. Its live half runs only in the
 * nightly; this file pins what must not drift without a server: the verdict on
 * one cascade run, the row a measurement turns into, the fixtures' shape, and
 * the runner's exit status when a server never concludes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CASCADE_FIXTURES,
	CASCADE_RENAME_EXTRA_DEADLINES,
	CASCADE_RETRY_INTERVAL_MS,
	type CascadeFixture,
	type CascadeMeasurement,
	type CascadeRunLike,
	cascadeRow,
	cascadeTimesRecord,
	classifyCascadeRun,
	classifyRenameImporter,
	describeLastTouch,
	neighbourShowsFinding,
	neighbourVerdict,
} from "../../scripts/lib/lsp-cascade-smoke.mjs";
import { CASCADE_GRAPH_KINDS } from "../../clients/dispatch/integration.js";
import {
	LSP_FIXTURES,
	passFloorBreach,
	report,
	runLspCascade,
} from "../../scripts/smoke-tools.mjs";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WS = "/work/space";
const fx: CascadeFixture = {
	lang: "demo",
	dir: "unused",
	file: "src/a.ts",
	symbol: "foo",
	neighbours: ["src/b.ts", "src/c.ts"],
	edit: { from: "x", to: "y" },
	expectFindings: "is not assignable",
};

const block = (rel: string, message: string) =>
	`<diagnostics file="${rel}" reason="references">\n  line 2, col 1 rule=x: ${message}\n</diagnostics>\n`;

/** A run as `computeCascadeForFile` shapes it after a live typescript-go edit. */
function liveRun(over: Partial<CascadeRunLike> = {}): CascadeRunLike {
	return {
		observedNeighborPaths: [`${WS}/src/c.ts`, `${WS}/src/b.ts`],
		result: {
			formatted:
				block("src/b.ts", "Type 'string' is not assignable to type 'number'.") +
				block("src/c.ts", "Type 'string' is not assignable to type 'number'."),
		},
		...over,
	};
}

describe("classifyCascadeRun (#1712)", () => {
	it("reads both importers concluded with the server's own finding", () => {
		expect(classifyCascadeRun(liveRun(), fx, WS)).toEqual({
			state: "conclusive",
			neighbours: { "src/b.ts": "findings", "src/c.ts": "findings" },
			detail: "all neighbours concluded",
		});
	});

	it("reads a skip reason as a cascade that never asked, even with every neighbour observed", () => {
		// Recurrence: #5021 review F3. computeCascadeForFile can return
		// skipReason "indeterminate" beside observedNeighborPaths (a graph that
		// failed to build after neighbours were selected); the observed paths must
		// not turn that into a conclusive run.
		expect(
			classifyCascadeRun(liveRun({ skipReason: "indeterminate" }), fx, WS),
		).toMatchObject({
			state: "inconclusive",
			skipReason: "indeterminate",
			detail: "cascade skipped: indeterminate",
		});
	});

	it("reads a neighbour the run never observed as unconfirmed", () => {
		// Recurrence: #4485, classic neighbours deferred and never asked, so the
		// run read as a leaf's all-clear. An unobserved neighbour is not clean.
		const run = liveRun({ observedNeighborPaths: [`${WS}/src/b.ts`] });
		expect(classifyCascadeRun(run, fx, WS)).toMatchObject({
			state: "inconclusive",
			neighbours: { "src/b.ts": "findings", "src/c.ts": "unconfirmed" },
		});
	});

	it("reads a neighbour listed under unconfirmed as unconfirmed even when observed", () => {
		// Recurrence: #4485, `unconfirmed` is the run's own word for "asked, no
		// answer in the bound", and outranks a path that was merely selected.
		const run = liveRun({
			unconfirmed: { servers: [{ paths: [`${WS}/src/c.ts`] }] },
		});
		expect(neighbourVerdict(run, WS, "src/c.ts")).toBe("unconfirmed");
		expect(classifyCascadeRun(run, fx, WS).state).toBe("inconclusive");
	});

	it("reads a skip reason as a cascade that never asked", () => {
		// Recurrence: #4485, `no_neighbors` (a leaf's all-clear) returned for an
		// edit that broke its importers.
		expect(
			classifyCascadeRun({ skipReason: "no_neighbors" }, fx, WS),
		).toMatchObject({
			state: "inconclusive",
			detail: "cascade skipped: no_neighbors",
		});
	});

	it("refuses a clean verdict on an importer of a broken export", () => {
		// Recurrence: measured on 2026-10-30, rust-analyzer started without cargo
		// loads no workspace and answered clean for both importers of a broken
		// export. Concluded is not correct: the stale importer is the defect.
		const run = liveRun({ result: { formatted: "" } });
		const verdict = classifyCascadeRun(run, fx, WS);
		expect(verdict.state).toBe("wrong-verdict");
		expect(verdict.neighbours).toEqual({
			"src/b.ts": "clean",
			"src/c.ts": "clean",
		});
	});

	it("takes a clean verdict when the fixture declares no expected finding", () => {
		const run = liveRun({ result: { formatted: "" } });
		expect(
			classifyCascadeRun(run, { ...fx, expectFindings: undefined }, WS).state,
		).toBe("conclusive");
	});

	it("matches the finding text inside the neighbour's own block only", () => {
		// A finding in src/b.ts must not satisfy src/c.ts.
		const run = liveRun({
			result: { formatted: block("src/b.ts", "is not assignable") },
		});
		expect(neighbourShowsFinding(run, "src/b.ts", "is not assignable")).toBe(
			true,
		);
		expect(neighbourShowsFinding(run, "src/c.ts", "is not assignable")).toBe(
			false,
		);
	});
});

describe("cascadeRow (#1712)", () => {
	const concluded = (
		state: "conclusive" | "inconclusive" | "wrong-verdict",
		detail = "x",
		skipReason?: string,
	) => ({
		state,
		detail,
		neighbours: {},
		...(skipReason ? { skipReason } : {}),
	});
	const m = (over: Partial<CascadeMeasurement> = {}): CascadeMeasurement => ({
		answered: true,
		warmMs: 10,
		attempts: 1,
		firstCascadeMs: 80,
		timeToConclusiveMs: 93,
		elapsedMs: 93,
		concluded: concluded("conclusive"),
		...over,
	});

	it("passes a conclusive run and names the time", () => {
		expect(cascadeRow(fx, m())).toMatchObject({
			state: "pass",
			detail: expect.stringContaining("93 ms"),
		});
	});

	it("reds a server that handshook and never answered the warm-up", () => {
		// Recurrence: #1712, a server that never answers within budget must red
		// the lane, not read as unavailable.
		expect(
			cascadeRow(fx, m({ answered: false, handshook: true, warmMs: 120000 })),
		).toMatchObject({ state: "fail" });
	});

	it("warns, not reds, for a server that never handshook or has no census", () => {
		expect(cascadeRow(fx, m({ answered: false, handshook: false })).state).toBe(
			"skip",
		);
		expect(cascadeRow(fx, m({ answered: false })).state).toBe("skip");
	});

	it("reds a run that never concluded inside the deadline", () => {
		const row = cascadeRow(
			fx,
			m({
				concluded: concluded("inconclusive", "src/c.ts unconfirmed"),
				attempts: 40,
				elapsedMs: 90000,
			}),
		);
		expect(row.state).toBe("fail");
		expect(row.detail).toContain("src/c.ts unconfirmed");
	});

	const defectFx = {
		...fx,
		expectDefect: {
			skipReason: "non_code",
			reason: "the cascade skips the language",
		},
	};
	const declaredShape = concluded(
		"inconclusive",
		"cascade skipped: non_code",
		"non_code",
	);

	it("reads a declared defect's own outcome as a known-defect row that names the cause", () => {
		// Recurrence: #1712 review M2. The declared shape was a `skip` row, the
		// word for "unavailable", so the nightly log and the durable table read
		// "jdtls was not provisioned" and "jdtls answered and showed the known
		// defect" the same way.
		const row = cascadeRow(defectFx, m({ concluded: declaredShape }));
		expect(row.state).toBe("known-defect");
		expect(row.detail).toContain(
			"known defect (the cascade skips the language)",
		);
		expect(row.detail).toContain("cascade skipped: non_code");
	});

	it("reds a declared-defect fixture whose cascade concluded, so the declaration cannot outlive the defect", () => {
		// Recurrence: #1712 review (named output). A declaration that a fixed
		// server also passes stays forever and covers the next regression.
		const row = cascadeRow(defectFx, m());
		expect(row.state).toBe("fail");
		expect(row.detail).toContain("remove the declaration");
	});

	it.each([
		[
			"an unconfirmed importer",
			concluded("inconclusive", "src/c.ts unconfirmed"),
		],
		[
			"another skip reason",
			concluded("inconclusive", "cascade skipped: blockers", "blockers"),
		],
		[
			"an importer read clean after the export broke",
			concluded("wrong-verdict", "src/c.ts read clean"),
		],
		[
			"an importer whose finding is not the expected one",
			concluded("wrong-verdict", "src/c.ts read findings"),
		],
	])(
		"still reds a declared-defect fixture whose run is %s",
		(_name, outcome) => {
			// Recurrence: #1712 review M1. A declaration that excuses a state, not a
			// shape, painted a changed jdtls message and an unrelated importer error
			// as the known defect: the lane exited 0 where the same run without the
			// declaration exited 3.
			expect(cascadeRow(defectFx, m({ concluded: outcome })).state).toBe(
				"fail",
			);
		},
	);

	it("reds the declared shape on a fixture that declares no defect", () => {
		expect(cascadeRow(fx, m({ concluded: declaredShape })).state).toBe("fail");
	});

	const renameFx = {
		...fx,
		rename: {
			to: "src/renamed.ts",
			staleSpecifier: '"./a"',
			expectFindings: "Cannot find module",
		},
	};
	const renamed = (
		over: Partial<NonNullable<CascadeMeasurement["rename"]>> = {},
	) => ({
		state: "concluded" as const,
		detail: "importers concluded 118 ms after the rename",
		...over,
	});

	it("passes a rename fixture only when the rename phase concluded, and names both times", () => {
		const row = cascadeRow(renameFx, m({ rename: renamed() }));
		expect(row.state).toBe("pass");
		expect(row.detail).toContain("93 ms");
		expect(row.detail).toContain("118 ms after the rename");
	});

	it.each([
		["a rename that never ran", undefined, "rename: not run"],
		[
			"importers that never concluded",
			renamed({ state: "unconcluded", detail: "stale-clean" }),
			"rename: stale-clean",
		],
		[
			"a notify that failed",
			renamed({ state: "notify-failed", detail: "didRename typescript" }),
			"rename: didRename typescript",
		],
	])(
		"reds a rename fixture with %s even though the edit cascade concluded",
		(_name, rename, detail) => {
			// Recurrence: #1712 (the #1677 path). A lane whose rename phase cannot
			// red would stay green while a file move left every importer stale.
			const row = cascadeRow(renameFx, m({ rename }));
			expect(row.state).toBe("fail");
			expect(row.detail).toContain(detail);
		},
	);

	it("leaves a fixture with no rename phase unaffected by a stray rename measurement", () => {
		expect(
			cascadeRow(fx, m({ rename: renamed({ state: "unconcluded" }) })).state,
		).toBe("pass");
	});
});

describe("describeLastTouch (#1712)", () => {
	// Lines as latency.log writes them for a jdtls that never launched.
	const file = "/ws/src/lib/Lib.java";
	const line = (
		phase: string,
		metadata: Record<string, unknown>,
		filePath = file,
	) => JSON.stringify({ type: "phase", phase, filePath, metadata });
	const log = [
		line("lsp_client_selected", { serverId: "java", outcome: "spawn-failure" }),
		line("lsp_touch_file", {
			failureKind: "no_clients_none_spawning",
			candidates: [{ serverId: "java", clientFound: "none" }],
		}),
		line("lsp_touch_file", { failureKind: "other-file" }, "/ws/other.java"),
		"not json at all",
	].join("\n");

	it("names the launch outcome and the touch failure of the file", () => {
		// Recurrence: #1712 CI run 41019475461, a jdtls red that said only
		// "never answered a touch" and left the cause in a runner log.
		expect(describeLastTouch(log, file)).toBe(
			"client java: spawn-failure; touch no_clients_none_spawning",
		);
	});

	it("adds the launcher's spawn classification for a process that never started", () => {
		const extension = JSON.stringify({
			message: "spawn failure classified",
			metadata: {
				kind: "tool-not-found",
				command: "/runner/pi-lens-jdtls/bin/jdtls",
				cwd: "/ws",
			},
		});
		expect(describeLastTouch(log, file, extension)).toBe(
			"client java: spawn-failure; touch no_clients_none_spawning; spawn tool-not-found (jdtls)",
		);
		// A failure in another workspace is not this file's.
		expect(
			describeLastTouch(log, file, extension.replace("/ws", "/elsewhere")),
		).not.toContain("spawn tool-not-found");
	});

	it("says nothing for a file the log never mentions", () => {
		expect(describeLastTouch(log, "/ws/missing.java")).toBe("");
	});

	it("puts the reason into the red row", () => {
		const row = cascadeRow(
			{ ...fx, provisionedBy: "X" },
			{
				answered: false,
				handshook: true,
				warmMs: 5,
				attempts: 0,
				why: "client java: spawn-failure",
			},
		);
		expect(row.detail).toContain("(client java: spawn-failure)");
	});
});

describe("cascade fixtures (#1712)", () => {
	const baseLangs = new Set(LSP_FIXTURES.map((f: { lang: string }) => f.lang));

	it("covers the four priority servers", () => {
		// The four servers of #1712's remainder: typescript-go (the typescript7
		// row), rust-analyzer, gopls, jdtls.
		expect(CASCADE_FIXTURES.map((f) => f.lang)).toEqual([
			"typescript7",
			"rust",
			"go",
			"java",
		]);
	});

	it.each(CASCADE_FIXTURES.map((f) => [f.lang, f] as const))(
		"%s: reuses a handshake row and is a real import edge",
		(_lang, f) => {
			expect(baseLangs.has(f.lang)).toBe(true);
			const read = (rel: string) =>
				fs.readFileSync(path.join(REPO_ROOT, f.dir, rel), "utf8");
			const primary = read(f.file);
			// The edit applies once and changes the exporter.
			expect(primary.split(f.edit.from).length - 1).toBe(1);
			expect(primary.replace(f.edit.from, f.edit.to)).not.toBe(primary);
			expect(primary).toContain(f.symbol);
			// Two importers, each calling the symbol the edit breaks.
			expect(f.neighbours).toHaveLength(2);
			for (const rel of f.neighbours)
				expect(read(rel)).toContain(`${f.symbol}(`);
			expect(() => new RegExp(f.expectFindings ?? "")).not.toThrow();
		},
	);

	it("lists every fixture's language in the cascade graph unless it declares the skip", () => {
		// Recurrence: tool-smoke run 41027095385, jdtls answered every warm touch
		// and the cascade still returned skipReason=non_code for java, because
		// CASCADE_GRAPH_KINDS had no java: thirty attempts, no importer asked. A
		// fixture for a language the cascade skips can only measure the skip, so it
		// declares that skip; java joined the set with #5040 and declares nothing,
		// and a declaration for a language the cascade models would excuse nothing
		// and hide the next regression (re-declaring java's reds this test).
		const graphKind: Record<string, string> = {
			typescript7: "jsts",
			rust: "rust",
			go: "go",
			java: "java",
		};
		for (const f of CASCADE_FIXTURES) {
			const kind = graphKind[f.lang];
			expect(kind, `a graph kind for ${f.lang}`).toBeTruthy();
			expect(
				CASCADE_GRAPH_KINDS.has(kind),
				`${f.lang} (${kind}) is a cascade graph kind exactly when it declares no non_code skip`,
			).toBe(f.expectDefect?.skipReason !== "non_code");
		}
	});

	it("gives the rename phase a stale specifier every importer spells and a target that is not there yet", () => {
		const withRename = CASCADE_FIXTURES.filter((f) => f.rename);
		expect(withRename.map((f) => f.lang)).toEqual(["typescript7"]);
		for (const f of withRename) {
			const rename = f.rename as NonNullable<CascadeFixture["rename"]>;
			expect(fs.existsSync(path.join(REPO_ROOT, f.dir, rename.to))).toBe(false);
			for (const rel of f.neighbours)
				expect(
					fs.readFileSync(path.join(REPO_ROOT, f.dir, rel), "utf8"),
				).toContain(rename.staleSpecifier);
			expect(() => new RegExp(rename.expectFindings)).not.toThrow();
		}
	});
});

describe("classifyRenameImporter (#1712, #1677)", () => {
	const rename = {
		to: "src/renamed.ts",
		staleSpecifier: '"./a"',
		expectFindings: "Cannot find module",
	};
	const stale = 'import { foo } from "./a";\n';
	const rewritten = 'import { foo } from "./renamed";\n';
	const missing =
		"Cannot find module './a' or its corresponding type declarations.";

	it.each([
		["no answer", stale, undefined, "unconfirmed"],
		[
			"a stale importer reporting the missing module",
			stale,
			[missing],
			"concluded",
		],
		["a stale importer the server calls clean", stale, [], "stale-clean"],
		[
			"a stale importer with an unrelated finding",
			stale,
			["x is unused"],
			"wrong-finding",
		],
		["a rewritten importer that is clean", rewritten, [], "concluded"],
		[
			"a rewritten importer still in error",
			rewritten,
			[missing],
			"wrong-finding",
		],
	])("reads %s as %s", (_name, content, messages, verdict) => {
		// Recurrence: the stale importer (#4485's quiet form) after a file move: a
		// server that never learned of the rename leaves the importer clean while
		// its import names a module that is gone.
		expect(classifyRenameImporter(rename, { content, messages })).toBe(verdict);
	});
});

describe("runLspCascade (#1712)", () => {
	const dirs: string[] = [];
	const savedHome = process.env.PI_LENS_HOME;
	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
	});

	/** A workspace holding the real fixture files, as bootstrap would leave it. */
	function workspaceFor(f: CascadeFixture) {
		const workspace = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cascade-lane-"),
		);
		dirs.push(workspace);
		fs.cpSync(path.join(REPO_ROOT, f.dir), workspace, { recursive: true });
		return workspace;
	}

	async function runLane(opts: {
		fixture?: Partial<CascadeFixture>;
		census?: string;
		answers?: boolean;
		launchVariant?: string;
		minPass?: number;
		/** How the server double behaves once the exporter is moved (#1677). */
		afterRename?: "reports-missing" | "rewrites-importers" | "stays-clean";
		renameThrows?: string;
		renameResult?: Record<string, unknown>;
		/** Importers still report an error after the exporter is restored. */
		neverClean?: boolean;
		/** Importers report an error until this much (fake) time has passed. */
		cleanAfterMs?: number;
		run: (workspace: string, attempt: number) => CascadeRunLike;
	}) {
		const base = CASCADE_FIXTURES[0];
		const fixture = {
			...base,
			// The deadline is below one retry interval: one attempt, no sleeping.
			conclusiveDeadlineMs: 10,
			warmDeadlineMs: 10,
			serverHint: "probe-server",
			...opts.fixture,
		};
		const home = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cascade-home-"),
		);
		dirs.push(home);
		process.env.PI_LENS_HOME = home;
		if (opts.census)
			fs.writeFileSync(
				path.join(home, "lsp-handshake-census.json"),
				JSON.stringify({ [fixture.lang]: { state: opts.census } }),
			);
		const timesOut = path.join(home, "times.json");
		const workspace = workspaceFor(fixture);
		let attempt = 0;
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a) =>
			output.push(a.join(" ")),
		);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		// The language server is the process boundary, so it is the one thing
		// doubled: it answers a clean file as clean, and once the exporter has
		// moved it answers an importer the way `afterRename` says.
		let moved = false;
		const startedAt = Date.now();
		// Resolved, not suffix-matched: `path.join` spells a Windows path with
		// backslashes, and `endsWith("src/b.ts")` then matches no importer.
		const isImporter = (file: string) =>
			(fixture.neighbours ?? []).some(
				(rel) => path.resolve(file) === path.resolve(workspace, rel),
			);
		const touchFile = vi.fn(async (file: string, content: string) => {
			if (opts.answers === false) return undefined;
			const missing = {
				message:
					"Cannot find module './a' or its corresponding type declarations.",
			};
			if (opts.neverClean && isImporter(file)) return { diags: [missing] };
			if (
				opts.cleanAfterMs !== undefined &&
				!moved &&
				isImporter(file) &&
				Date.now() - startedAt < opts.cleanAfterMs
			)
				return { diags: [missing] };
			const stale =
				moved &&
				isImporter(file) &&
				content.includes('"./a"') &&
				opts.afterRename !== "stays-clean";
			return { diags: stale ? [missing] : [] };
		});
		const renameFile = vi.fn(async (from: string, to: string) => {
			if (opts.renameThrows) throw new Error(opts.renameThrows);
			fs.renameSync(from, to);
			moved = true;
			if (opts.afterRename === "rewrites-importers")
				for (const rel of fixture.neighbours ?? [])
					fs.writeFileSync(
						path.join(workspace, rel),
						fs
							.readFileSync(path.join(workspace, rel), "utf8")
							.replace('"./a"', '"./renamed"'),
					);
			return {
				applied: true,
				willRenameFailures: [],
				didRenameFailures: [],
				...opts.renameResult,
			};
		});
		const deps = {
			fixtures: [fixture],
			touchFile,
			renameFile,
			getLSPService: () =>
				makeLspServiceDouble({
					touchFile,
					renameFile,
					getCapabilitySnapshots: vi.fn(async () => [
						{ launchVariant: opts.launchVariant ?? "native-ts7" },
					]),
					shutdown: vi.fn(async () => undefined),
				}),
			computeCascadeForFile: vi.fn(async () => opts.run(workspace, ++attempt)),
			initLSPConfig: vi.fn(async () => undefined),
			ensureTool: vi.fn(async () => "/mock/tool"),
			getInstallAttempt: vi.fn(),
			adoptProjectTrustFromContext: vi.fn(),
			bootstrapFixtureWorkspace: vi.fn(async () => ({
				workspace,
				absFile: path.join(workspace, fixture.file),
				cleanup: vi.fn(),
			})),
		};
		const failures = await runLspCascade({
			langs: [fixture.lang],
			install: false,
			verbose: false,
			timesOut,
			minPass: opts.minPass ?? null,
			deps,
		});
		const times = fs.existsSync(timesOut)
			? JSON.parse(fs.readFileSync(timesOut, "utf8"))
			: undefined;
		return { failures, times, output: output.join("\n"), deps, workspace };
	}

	const concludes = (workspace: string) =>
		liveRun({
			observedNeighborPaths: [
				path.join(workspace, "src/b.ts"),
				path.join(workspace, "src/c.ts"),
			],
		});

	it("passes and records the time when both importers conclude", async () => {
		const { failures, times, output, deps } = await runLane({
			census: "pass",
			run: concludes,
		});
		expect(failures).toBe(0);
		expect(output).toContain("✓  typescript7");
		// The edit reached disk before the cascade asked.
		expect(deps.computeCascadeForFile).toHaveBeenCalledOnce();
		expect(times.rows[0]).toMatchObject({
			lang: "typescript7",
			state: "pass",
			attempts: 1,
			timeToConclusiveMs: expect.any(Number),
			neighbours: { "src/b.ts": "findings", "src/c.ts": "findings" },
		});
		expect(times.schema).toBe(1);
	});

	it("reds when a server that handshook never concludes an importer", async () => {
		// Recurrence: #1712, the quiet shape: a cascade that never concludes
		// every night while the handshake layer stays green.
		const { failures, times, output } = await runLane({
			census: "pass",
			run: (workspace) =>
				liveRun({
					observedNeighborPaths: [path.join(workspace, "src/b.ts")],
					unconfirmed: {
						servers: [{ paths: [path.join(workspace, "src/c.ts")] }],
					},
				}),
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("✗  typescript7");
		expect(output).toContain("src/c.ts unconfirmed");
		expect(times.rows[0]).toMatchObject({
			state: "fail",
			timeToConclusiveMs: null,
		});
	});

	it("reds an importer that concluded clean after the export broke", async () => {
		const { failures, output } = await runLane({
			census: "pass",
			run: (workspace) => ({
				...concludes(workspace),
				result: { formatted: "" },
			}),
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("concluded without a");
	});

	const declaredDefect = {
		expectDefect: {
			skipReason: "non_code",
			reason: "the cascade skips the language",
		},
	};

	it("turns a declared defect's own outcome into a known-defect row with its cause and no time", async () => {
		// Recurrence: #1712 review M2, jdtls. The excuse ends at a row of its own
		// (not `skip`, the word for unavailable, which the durable table would
		// then share): it counts toward no failure and carries the cause in the
		// artifact, and no time-to-conclusive it never had.
		const { failures, output, times } = await runLane({
			census: "pass",
			fixture: declaredDefect,
			run: () => ({ skipReason: "non_code" }),
		});
		expect(failures).toBe(0);
		expect(output).toContain("≈  typescript7");
		expect(output).toContain("known defect (the cascade skips the language)");
		expect(output).toContain("1 known-defect (declared, not a pass)");
		expect(times.rows[0]).toMatchObject({
			state: "known-defect",
			detail: expect.stringContaining("the cascade skips the language"),
			timeToConclusiveMs: null,
		});
	});

	it("reds a declared-defect fixture whose run is a different defect than the one named", async () => {
		// Recurrence: #1712 review M1, through the production runner: the same run
		// without the declaration exited 3, with it exited 0.
		const withDeclaration = await runLane({
			census: "pass",
			fixture: declaredDefect,
			run: (workspace) => ({
				...concludes(workspace),
				result: { formatted: "" },
			}),
		});
		const without = await runLane({
			census: "pass",
			run: (workspace) => ({
				...concludes(workspace),
				result: { formatted: "" },
			}),
		});
		expect(without.failures).toBeGreaterThan(0);
		expect(withDeclaration.failures).toBe(without.failures);
		expect(withDeclaration.output).toContain("✗  typescript7");
		expect(withDeclaration.times.rows[0].state).toBe("fail");
	});

	it("reds a server that handshook and answered nothing here", async () => {
		const { failures, output, deps } = await runLane({
			census: "pass",
			answers: false,
			run: concludes,
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("never answered a touch");
		expect(deps.computeCascadeForFile).not.toHaveBeenCalled();
	});

	it("warns for a server whose handshake never passed", async () => {
		const { output, deps } = await runLane({
			census: "skip",
			answers: false,
			run: concludes,
		});
		expect(output).toContain("⚠  typescript7");
		// Recurrence: a missing server made the lane wait out its whole warm-up
		// deadline (4.5 minutes for two absent servers, measured 2026-10-30).
		expect(deps.touchFile).not.toHaveBeenCalled();
		expect(deps.computeCascadeForFile).not.toHaveBeenCalled();
	});

	it("takes a provisioned server's availability from its env var, not the census", async () => {
		// Recurrence: #1712/#3400, jdtls has no managed installer, so the nightly's
		// handshake step never starts it and its census row says skip every night.
		// A lane that read that row would skip java forever; one that ignored an
		// unset variable would red a developer's machine.
		const fixture = { provisionedBy: "PI_LENS_TEST_PROVISIONED_SERVER" };
		const savedVar = process.env[fixture.provisionedBy];
		try {
			delete process.env[fixture.provisionedBy];
			const missing = await runLane({
				census: "skip",
				fixture,
				answers: false,
				run: concludes,
			});
			expect(missing.output).toContain("⚠  typescript7");
			expect(missing.deps.touchFile).not.toHaveBeenCalled();

			process.env[fixture.provisionedBy] = "/opt/server/bin/server";
			const present = await runLane({
				census: "skip",
				fixture,
				answers: false,
				run: concludes,
			});
			expect(present.failures).toBeGreaterThan(0);
			expect(present.output).toContain("never answered a touch");
			expect(present.deps.touchFile).toHaveBeenCalled();
		} finally {
			if (savedVar === undefined) delete process.env[fixture.provisionedBy];
			else process.env[fixture.provisionedBy] = savedVar;
		}
	});

	it("asks the cascade again after a first unconfirmed answer and passes when the retry concludes", async () => {
		// Recurrence: #5021 review F3. rust-analyzer's first cascade call returns
		// in 62 ms and its neighbours conclude at 2887 ms (the committed table), so
		// a lane collapsed to one attempt reds most rust nights. Only setTimeout
		// is faked: the retry sleep resolves when the test advances it, and the
		// deadline clock stays real and far away.
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const lane = runLane({
				census: "pass",
				fixture: { conclusiveDeadlineMs: 60_000, warmDeadlineMs: 60_000 },
				run: (workspace, attempt) =>
					attempt === 1
						? liveRun({
								observedNeighborPaths: [path.join(workspace, "src/b.ts")],
								unconfirmed: {
									servers: [{ paths: [path.join(workspace, "src/c.ts")] }],
								},
							})
						: concludes(workspace),
			});
			let settled = false;
			void lane.finally(() => {
				settled = true;
			});
			while (!settled)
				await vi.advanceTimersByTimeAsync(CASCADE_RETRY_INTERVAL_MS);
			const { failures, times, deps } = await lane;
			expect(failures).toBe(0);
			expect(deps.computeCascadeForFile).toHaveBeenCalledTimes(2);
			expect(times.rows[0]).toMatchObject({
				state: "pass",
				attempts: 2,
				timeToConclusiveMs: expect.any(Number),
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("reds a lane that passed fewer servers than its floor and holds one that met it", async () => {
		// Recurrence: #5021 review F2. A floor equal to the fixture population
		// reds one unavailable server as "installs nothing"; a floor of zero lets
		// an all-unavailable night read green. One passing server against a floor
		// of two is red, against a floor of one it is not.
		const breached = await runLane({
			census: "pass",
			minPass: 2,
			run: concludes,
		});
		// The row itself passed; the one failure is the floor breach.
		expect(breached.output).toContain("✓  typescript7");
		expect(breached.failures).toBe(1);
		const held = await runLane({ census: "pass", minPass: 1, run: concludes });
		expect(held.failures).toBe(0);
	});

	it("counts a known-defect row toward the floor and an unavailable one not", () => {
		// Recurrence: #1712. The declared java row counted toward `--min-pass=3`
		// before it had a state of its own (one unavailable server stays a
		// warning); a `skip` is unavailable and proves nothing.
		const row = (state: "pass" | "skip" | "known-defect") => ({
			lang: state,
			runner: "r",
			state,
			detail: "",
			diags: 0,
		});
		expect(passFloorBreach([row("pass"), row("known-defect")], 2)).toBeNull();
		expect(passFloorBreach([row("pass"), row("skip")], 2)).toContain(
			"1 runner(s) passed, at least 2 required (1 unavailable)",
		);
	});

	it("reds a silent fallback to the classic server", async () => {
		// Recurrence: #530, native and classic TypeScript share one server id, so
		// a cascade that concluded through the wrong server proves nothing about
		// typescript-go.
		const { failures, output, deps } = await runLane({
			census: "pass",
			launchVariant: "classic",
			run: concludes,
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("silent fallback");
		expect(deps.computeCascadeForFile).not.toHaveBeenCalled();
	});

	it("reds a fixture whose edit no longer applies", async () => {
		const { failures, output, deps } = await runLane({
			census: "pass",
			fixture: { edit: { from: "no such text", to: "x" } },
			run: concludes,
		});
		expect(failures).toBeGreaterThan(0);
		expect(output).toContain("fixture drift");
		expect(deps.computeCascadeForFile).not.toHaveBeenCalled();
	});

	describe("rename phase (#1677)", () => {
		it("moves the restored exporter through renameFile and records the importers' conclusion", async () => {
			const { failures, times, output, deps, workspace } = await runLane({
				census: "pass",
				run: concludes,
			});
			expect(failures).toBe(0);
			expect(deps.renameFile).toHaveBeenCalledWith(
				path.join(workspace, "src/a.ts"),
				path.join(workspace, "src/renamed.ts"),
				{ cwd: workspace, apply: true },
			);
			// The exporter was restored first: the move is of the original file.
			expect(
				fs.readFileSync(path.join(workspace, "src/renamed.ts"), "utf8"),
			).toBe("export function foo(x: number): number {\n\treturn x;\n}\n");
			expect(output).toContain("rename: importers concluded");
			expect(times.rows[0].rename).toMatchObject({
				state: "concluded",
				renameMs: expect.any(Number),
				timeToConclusiveMs: expect.any(Number),
				importersRewritten: 0,
				importers: { "src/b.ts": "concluded", "src/c.ts": "concluded" },
			});
		});

		it("passes importers the server's own edit rewrote when they are clean, and counts them", async () => {
			const { failures, times } = await runLane({
				census: "pass",
				afterRename: "rewrites-importers",
				run: concludes,
			});
			expect(failures).toBe(0);
			expect(times.rows[0].rename).toMatchObject({
				state: "concluded",
				importersRewritten: 2,
			});
		});

		it("reds importers a server calls clean while they still import the moved module", async () => {
			// Recurrence: the stale importer (#4485's quiet form) after a file move,
			// the #1677 path's silent failure: the notify was sent and the server
			// never learned of the move.
			const { failures, times, output } = await runLane({
				census: "pass",
				afterRename: "stays-clean",
				run: concludes,
			});
			expect(failures).toBeGreaterThan(0);
			expect(output).toContain("stale-clean");
			expect(times.rows[0].rename).toMatchObject({
				state: "unconcluded",
				timeToConclusiveMs: null,
			});
		});

		it("reds a rename the service refuses, naming the cause", async () => {
			const { failures, output } = await runLane({
				census: "pass",
				renameThrows:
					"workspace/didClose failed; rename aborted: typescript (timedOut)",
				run: concludes,
			});
			expect(failures).toBeGreaterThan(0);
			expect(output).toContain("renameFile threw: workspace/didClose failed");
		});

		it("reds a rename whose notify failed, even though renameFile returned", async () => {
			// Recurrence: #1621/#1677, a didRenameFiles notify that timed out is
			// recorded in the result, not thrown: a lane that read only the throw
			// would call a wedged notify a pass.
			const { failures, output } = await runLane({
				census: "pass",
				renameResult: {
					didRenameFailures: [
						{
							serverId: "typescript",
							error: "Timeout after 1500ms",
							disposition: "timedOut",
						},
					],
				},
				run: concludes,
			});
			expect(failures).toBeGreaterThan(0);
			expect(output).toContain(
				"didRename typescript (timedOut): Timeout after 1500ms",
			);
		});

		it("reds, without renaming, when the importers never return to clean", async () => {
			const { failures, output, deps } = await runLane({
				census: "pass",
				neverClean: true,
				run: concludes,
			});
			expect(failures).toBeGreaterThan(0);
			expect(output).toContain("did not return to clean");
			expect(deps.renameFile).not.toHaveBeenCalled();
		});

		it("spends no more than the lane's rename deadlines beyond the edit cascade", async () => {
			// Recurrence: #3123 (a lane hang costing the step cap), through the
			// rename phase: tests/config/lsp-cascade-lane.test.ts bounds the lane
			// by CASCADE_RENAME_EXTRA_DEADLINES; a third wait in the phase would
			// spend more than the bound counts. The importers return to clean just
			// before the baseline deadline, then never conclude after the move, so
			// both waits run nearly their whole deadline (fake clock).
			const deadlineMs = 20_000;
			const stepMs = 500;
			vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
			try {
				const lane = runLane({
					census: "pass",
					fixture: { conclusiveDeadlineMs: deadlineMs, warmDeadlineMs: 60_000 },
					cleanAfterMs: deadlineMs - 3_000,
					afterRename: "stays-clean",
					run: concludes,
				});
				let settled = false;
				void lane.finally(() => {
					settled = true;
				});
				// The fake clock is advanced in whole steps, so the steps taken are the
				// virtual time spent (a counter, not a read of the clock).
				let steps = 0;
				while (!settled) {
					await vi.advanceTimersByTimeAsync(stepMs);
					steps += 1;
				}
				const { times } = await lane;
				expect(times.rows[0].rename.state).toBe("unconcluded");
				expect(steps * stepMs).toBeGreaterThan(
					(CASCADE_RENAME_EXTRA_DEADLINES - 0.5) * deadlineMs,
				);
				expect(steps * stepMs).toBeLessThanOrEqual(
					CASCADE_RENAME_EXTRA_DEADLINES * deadlineMs + 2_000,
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not rename after an edit cascade that did not conclude", async () => {
			const { deps } = await runLane({
				census: "pass",
				run: (workspace) =>
					liveRun({
						observedNeighborPaths: [path.join(workspace, "src/b.ts")],
						unconfirmed: {
							servers: [{ paths: [path.join(workspace, "src/c.ts")] }],
						},
					}),
			});
			expect(deps.renameFile).not.toHaveBeenCalled();
		});
	});

	it("applies the edit to the exporter before the cascade asks", async () => {
		const seen: string[] = [];
		await runLane({
			census: "pass",
			run: (workspace) => {
				seen.push(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8"));
				return concludes(workspace);
			},
		});
		expect(seen).toEqual([
			"export function foo(x: string): string {\n\treturn x;\n}\n",
		]);
	});
});

describe("report with a skipped server (#1712)", () => {
	// Recurrence: #5021 verify F8. Retuning the floor from 4 of 4 to 3 of 4 made
	// "one unavailable server is a warning" load bearing: it holds only because a
	// skip row adds nothing to the failure count. The verifier's mutation
	// `failOnSkipOnly && counts.skip > 0` survived every cell before this one.
	const rows = [
		{ lang: "a", runner: "r", state: "pass" as const, detail: "", diags: 2 },
		{ lang: "b", runner: "r", state: "skip" as const, detail: "", diags: 0 },
	];

	it("reads one unavailable server beside a pass as a warning, not a failure", () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		expect(report(rows, "x", { failOnSkipOnly: true })).toBe(0);
		vi.restoreAllMocks();
	});

	it("reads a lane that only skipped as a failure", () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		expect(report([rows[1]], "x", { failOnSkipOnly: true })).toBe(1);
		vi.restoreAllMocks();
	});

	it("reads a known defect beside a skip as work done, and names it apart from the skip", () => {
		// Recurrence: #1712 review M2. The summary counts a known defect under its
		// own word after the `skipped` clause tool-smoke-drift parses, so a skip
		// and a known defect never read the same.
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a) => {
			lines.push(a.join(" "));
		});
		const known = {
			lang: "c",
			runner: "r",
			state: "known-defect" as const,
			detail: "",
			diags: 0,
		};
		expect(report([rows[1], known], "x", { failOnSkipOnly: true })).toBe(0);
		const text = lines.join("\n");
		expect(text).toContain(
			"0 passed · 0 failed · 0 setup-failed · 1 skipped (tool/config unavailable) · 1 known-defect (declared, not a pass)",
		);
		expect(text).not.toContain("SKIPPED:");
		vi.restoreAllMocks();
	});
});

describe("cascadeTimesRecord (#1712)", () => {
	it("keeps null for a time that was not measured", () => {
		const record = cascadeTimesRecord(
			[
				{
					lang: "go",
					runner: "gopls",
					state: "skip",
					detail: "unavailable",
					diags: 0,
				},
			],
			{},
			{ GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "42" },
		);
		expect(record.runner).toMatchObject({ ci: true, runId: "42" });
		expect(record.rows[0]).toMatchObject({
			lang: "go",
			warmMs: null,
			timeToConclusiveMs: null,
		});
	});
});
