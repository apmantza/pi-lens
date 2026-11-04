/**
 * Tool-state matrix (#4522): only a clean run may read clean.
 *
 * Premise. The detection retro of 2026-10-16 counted 29 bugs where a tool that
 * had not answered (missing, crashed, timed out, the wrong version) read as a
 * clean file (cluster K4: #4451, #4453, #4454, #4455, #4485, #4486, #4487,
 * #4465, #4322, #4166). Each was found and fixed one runner at a time, because
 * no test asked every runner the same question. This one does.
 *
 * For every registered CLI runner that has captured real-binary bytes
 * (`tests/fixtures/runner-output/`), the production dispatcher
 * (`dispatchForFile` over a registry from `registerDefaultRunners`) runs the
 * runner against each of these tool states, and the verdict is read from the
 * dispatcher's own result (`diagnostics`, `inconclusiveSources`, and for the
 * no-verdict cells the write line's `verdict`) and its own `reachedNoVerdict`
 * rule:
 *
 *   clean            probe ok; the run prints nothing / the empty report
 *   dirty            probe ok; the run prints the captured real bytes
 *   missing          every spawn fails ENOENT (no binary)
 *   crashed          the run dies of SIGSEGV, or exits 101 on a panic
 *   wrong-version    the probe rejects its flag (helm 4 / spotbugs 4 shape,
 *                    #4453), or every call exits 2 with a usage error
 *   unanswered       the run, or the probe, exhausts its spawn budget
 *
 * Only `clean` may yield a clean verdict, and `dirty` must yield findings. The
 * `clean` cell is also the harness control: it proves the runner reached its
 * work spawn, so a harness that never gets there cannot pass the other cells
 * vacuously.
 *
 * Only the process boundary is replaced (`safeSpawnAsync`, a member of the
 * flake-shape ratchet's PROCESS_BOUNDARY_MODULES). The availability checker,
 * the install resolver, the runner, and the dispatcher are real. Every cell
 * loads a fresh module graph: several clients keep process-wide memos of a
 * tool's presence (`goClient`), and one cell's answer must not decide the next.
 *
 * Out of scope here, by the census in `smoke-fixture-coverage.test.ts`: runners
 * with no captured bytes (in-process, LSP-relayed, or exempt there with a
 * category), which have no real output to put in the `dirty` cell.
 *
 * The `clean` cell replays the fixture's CAPTURED clean run (#4522). It used to
 * model `""` for every runner but biome, whose empty report was edited out of
 * the dirty bytes here; for the runners that print a clean report that model
 * replayed bytes the tool never emits. A fixture with no clean run carries the
 * tool fact that makes one unreachable (`cleanUnavailable`), and that cell is a
 * visible skip naming the fact — never invented bytes.
 *
 * The probe answers a "tool present" cell gives are the fixture's recorded
 * availability records (#4473), so the checker is exercised over the real
 * binary's answer instead of a hand-written "tool 1.2.3".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type {
	DispatchResult,
	RunnerResult,
} from "../../../clients/dispatch/types.js";
import {
	type CapturedOutput,
	listCapturedOutputs,
	materialize,
	materializeClean,
	probeAnswer,
	probeCommandNames,
	WORKSPACE_TOKEN,
} from "../../helpers/captured-runner-output.js";
import { setupTestEnvironment } from "../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

const childProcessWindow = vi.hoisted(() => {
	let active = false;
	const calls: Array<{ method: string; command: unknown; args: unknown[] }> =
		[];
	const methods = [
		"spawn",
		"spawnSync",
		"execFile",
		"execFileSync",
		"exec",
		"execSync",
		"fork",
	] as const;

	function begin() {
		calls.length = 0;
		active = true;
	}

	function end() {
		active = false;
	}

	function assertNoRealCall(method: string, args: unknown[]) {
		if (!active) return;
		const command = args[0];
		calls.push({ method, command, args: [...args.slice(1)] });
		const renderedArgs = args.slice(1).map((arg) => {
			try {
				return JSON.stringify(arg);
			} catch {
				return String(arg);
			}
		});
		const stack = (new Error().stack ?? "").split("\n").slice(2, 6).join("\n");
		throw new Error(
			`Unexpected real child_process.${method} during matrix cell: command=${String(command)} args=[${renderedArgs.join(", ")} ]\n${stack}`,
		);
	}

	function wrap(actual: typeof import("node:child_process")) {
		const wrapped = { ...actual };
		for (const method of methods) {
			const original = actual[method] as (...args: unknown[]) => unknown;
			wrapped[method] = function (this: unknown, ...args: unknown[]) {
				assertNoRealCall(method, args);
				return original.apply(this, args);
			} as never;
		}
		return wrapped;
	}

	return { begin, end, wrap };
});

// Recurrence: biome-check-json read clean on CI 2026-10-16 with no probe spawn.
vi.mock("node:child_process", async (importOriginal) =>
	childProcessWindow.wrap(
		await importOriginal<typeof import("node:child_process")>(),
	),
);
vi.mock("child_process", async (importOriginal) =>
	childProcessWindow.wrap(
		await importOriginal<typeof import("node:child_process")>(),
	),
);

// CI 2026-10-16 on c6dcf906c: the runner image has Go at an absolute
// candidate, and candidate-probe.ts accepts an absolute candidate through
// `existsSync` without spawning it, so the go-vet probe cells read clean.
// Hide the absolute entries of GO_UNIX_PATHS (clients/go-client.ts) so only the
// bare `go` candidate answers, through the mocked spawn. Cargo needs no entry:
// rust-clippy's cells pass with an absolute cargo present.
const ABSOLUTE_GO_CANDIDATES = new Set(["/usr/local/go/bin/go", "/usr/bin/go"]);

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (candidate: fs.PathLike) =>
			!ABSOLUTE_GO_CANDIDATES.has(String(candidate)) &&
			actual.existsSync(candidate),
	};
});

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

type Call = "probe" | "work";
type SpawnAnswer = Record<string, unknown>;
type Verdict = "clean" | "findings" | "no-verdict";

interface AnswerContext {
	fixture: CapturedOutput;
	workspace: string;
	classify: (error: Error, cmd: string) => Promise<unknown>;
	SpawnFailureError: typeof import("../../../clients/safe-spawn.js").SpawnFailureError;
	/** Probes the cell answered with no record, in spawn order. */
	unrecorded: string[];
}

interface Cell {
	name: string;
	/**
	 * `no-verdict`: the tool never answered about the file, so the run may state
	 * neither that it is clean nor a finding. `not-clean`: the tool answered
	 * with an exit the runner classifies by its own table, so only the clean
	 * reading is excluded.
	 */
	expect: Verdict | "not-clean";
	answer(
		call: Call,
		cmd: string,
		args: readonly string[],
		ctx: AnswerContext,
	): Promise<SpawnAnswer>;
}

/**
 * The tool's own clean run, captured from the real binary (#4522), spelled for
 * the workspace this cell replays in.
 *
 * This used to be `""` for every runner but biome, whose empty report was edited
 * out of the dirty bytes here. Both were models of a clean run, and for the
 * runners that PRINT a clean report (biome's JSON, eslint's `[]`, pyright's
 * summary) the cell replayed bytes the tool never emits, so the clean half of
 * the parser was never exercised. A fixture without a clean record is refused by
 * the census, so every cell replays a real one.
 */
function cleanRun(fixture: CapturedOutput, workspace: string): SpawnAnswer {
	return {
		error: null,
		...(() => {
			const run = materializeClean(fixture, workspace);
			return { status: run.status, stdout: run.stdout, stderr: run.stderr };
		})(),
	};
}

/**
 * The tool's recorded answer to the probe its runner sends, matched on the
 * command AND the arguments in order (#4522 F5).
 *
 * This used to hand every probe the first accepted record, so biome's
 * `explain noUnusedVariables` spawn got its `--version` banner back — the same
 * substitution of invented-for-real bytes this PR removes from the work half.
 * A probe the capture never recorded is COLLECTED, not invented: the cell
 * asserts the list is empty, because answering it from a neighbour's record
 * would hide exactly the drift the record exists to catch (#4473).
 */
function probeOk(
	ctx: AnswerContext,
	cmd: string,
	args: readonly string[],
): SpawnAnswer {
	const record = probeAnswer(ctx.fixture, cmd, args);
	if (!record) {
		ctx.unrecorded.push(`${cmd} ${JSON.stringify(args)}`);
		return {
			error: new Error(`no recorded availability answer for ${cmd}`),
			status: null,
			stdout: "",
			stderr: "",
			failure: "spawn",
		};
	}
	return {
		error: record.error ? new Error(record.error) : null,
		status: record.exitCode,
		stdout: record.stdout,
		stderr: record.stderr,
	};
}

async function enoent(cmd: string, ctx: AnswerContext): Promise<SpawnAnswer> {
	const error = Object.assign(new Error(`spawn ${cmd} ENOENT`), {
		code: "ENOENT",
	});
	return {
		stdout: "",
		stderr: "",
		status: null,
		error,
		failure: "spawn",
		spawnFailure: await ctx.classify(error, cmd),
	};
}

function signalDeath(ctx: AnswerContext): SpawnAnswer {
	const error = new Error("Process killed by signal: SIGSEGV");
	return {
		stdout: "",
		stderr: "",
		status: null,
		signal: "SIGSEGV",
		error,
		failure: "signal",
		spawnFailure: new ctx.SpawnFailureError("killed", error.message, error),
	};
}

function timedOut(ctx: AnswerContext, ms: number): SpawnAnswer {
	const error = new Error(
		`Process timed out after ${ms}ms (killed with SIGTERM)`,
	);
	return {
		stdout: "",
		stderr: "",
		status: null,
		error,
		failure: "timeout",
		spawnFailure: new ctx.SpawnFailureError("timeout", error.message, error),
	};
}

const rejectedFlag: SpawnAnswer = {
	error: null,
	status: 1,
	stdout: "",
	stderr: "Error: unknown flag: --version\n",
};

const usageError: SpawnAnswer = {
	error: null,
	status: 2,
	stdout: "",
	stderr: "Error: unknown flag: --format\nUsage:\n  tool [flags] <file>\n",
};

const CELLS: Cell[] = [
	{
		name: "clean",
		expect: "clean",
		async answer(call, cmd, args, ctx) {
			return call === "probe"
				? probeOk(ctx, cmd, args)
				: cleanRun(ctx.fixture, ctx.workspace);
		},
	},
	{
		name: "dirty",
		expect: "findings",
		async answer(call, cmd, args, ctx) {
			return call === "probe"
				? probeOk(ctx, cmd, args)
				: materialize(ctx.fixture, ctx.workspace);
		},
	},
	{
		name: "missing",
		expect: "no-verdict",
		answer: (_call, cmd, _args, ctx) => enoent(cmd, ctx),
	},
	{
		name: "crashed (killed by SIGSEGV)",
		expect: "no-verdict",
		async answer(call, cmd, args, ctx) {
			return call === "probe" ? probeOk(ctx, cmd, args) : signalDeath(ctx);
		},
	},
	{
		name: "crashed (panic, exit 101)",
		expect: "not-clean",
		async answer(call, cmd, args, ctx) {
			return call === "probe"
				? probeOk(ctx, cmd, args)
				: {
						error: null,
						status: 101,
						stdout: "",
						// Tool-neutral on purpose: a panic that quotes `file:line:col`
						// is a parser question of its own, not a crash cell.
						stderr: "fatal: internal error: unexpected failure\n",
					};
		},
	},
	{
		// helm 4.3.0 and spotbugs 4.10.2 reject `--version` (#4453, #4473). The
		// work answer is clean on purpose: the only thing that keeps this cell
		// from reading clean is honouring the rejected probe.
		name: "wrong version (probe rejected)",
		expect: "no-verdict",
		async answer(call, _cmd, _args, ctx) {
			return call === "probe"
				? rejectedFlag
				: cleanRun(ctx.fixture, ctx.workspace);
		},
	},
	{
		// A tool whose runner never probes meets the other face of the same
		// state: an older or newer CLI refuses the flags the runner passes.
		name: "wrong version (usage error)",
		expect: "not-clean",
		answer: async () => usageError,
	},
	{
		name: "unanswered (run exhausts its budget)",
		expect: "no-verdict",
		async answer(call, cmd, args, ctx) {
			return call === "probe" ? probeOk(ctx, cmd, args) : timedOut(ctx, 15000);
		},
	},
	{
		name: "unanswered (probe exhausts its budget)",
		expect: "no-verdict",
		async answer(call, _cmd, _args, ctx) {
			return call === "probe"
				? timedOut(ctx, 5000)
				: cleanRun(ctx.fixture, ctx.workspace);
		},
	},
];

/**
 * A spawn is the runner's work when it names the analysed file or carries the
 * fixture's recorded argv (minus the file) in order, the same tie
 * `captured-real-output.test.ts` asserts. Everything else the runner or its
 * availability checker spawns is a probe.
 */
function isWork(
	args: string[],
	fixture: CapturedOutput,
	ws: string,
	file: string = fixture.file,
): boolean {
	const fileTokens = new Set([
		file,
		path.basename(file),
		file.replace(/\\/g, "/"),
	]);
	// The clean cell analyses the clean input, which can be a different name.
	const recordedFileTokens = new Set([
		fixture.file,
		path.basename(fixture.file),
		fixture.file.replace(/\\/g, "/"),
	]);
	if (
		args.some(
			(token) =>
				fileTokens.has(token) ||
				fileTokens.has(path.relative(ws, token).replace(/\\/g, "/")),
		)
	) {
		return true;
	}
	const recorded = (fixture.provenance.argv ?? [])
		.filter((token) => !recordedFileTokens.has(token))
		.map((token) => token.split(WORKSPACE_TOKEN).join(path.resolve(ws)));
	if (recorded.length === 0) return false;
	let cursor = 0;
	for (const token of args) {
		if (cursor < recorded.length && token === recorded[cursor]) cursor++;
	}
	return cursor === recorded.length;
}

function verdictOf(
	runnerId: string,
	dispatched: DispatchResult,
	outcome: RunnerResult | undefined,
	reachedNoVerdict: (r: RunnerResult) => boolean,
): Verdict {
	// The dispatcher's own rule decides first (a fault arm may carry a synthetic
	// diagnostic and still reached no verdict about the file).
	if (
		outcome === undefined ||
		reachedNoVerdict(outcome) ||
		(dispatched.inconclusiveSources?.runnerIds ?? []).includes(runnerId)
	) {
		return "no-verdict";
	}
	if (dispatched.diagnostics.length > 0) return "findings";
	// No status fallback: a skipped or failed run that the dispatcher's own rule
	// does not call "no verdict" is read as clean here, so a weakened rule shows.
	return "clean";
}

/**
 * Cells whose modelled state is not a state the tool can be in, each with the
 * fact about the tool that says so. A key is `<runner id>/<cell name>`; the
 * guard below fails a key that names no runner or cell.
 */
const NOT_APPLICABLE: Readonly<Record<string, string>> = {
	"cpp-check/wrong version (probe rejected)":
		"MSVC `cl` has no version flag, so the runner probes it with no arguments and accepts any exit status as presence; a rejected-flag answer to an argument-less call is not an answer cl gives",
};

const CAPTURES = listCapturedOutputs();
const RUNNER_IDS = [...new Set(CAPTURES.map((c) => c.provenance.runner))];

/**
 * Commands the dispatcher's generic `hasTool` check probes only when the host
 * has them on disk (a PATH walk, `isSpawnableCommand`): oxlint is on PATH under
 * `npm`/`npx` and absent under a bare `vitest`, and the first 4522 mutation run
 * read `clean` from its probe cells for that reason. A cell models the tool's
 * presence through its spawn answers alone.
 *
 * Every command the fixtures name is stubbed, derived from the fixtures rather
 * than listed: the observed spelling was `oxlint` alone, which models presence
 * for exactly the tool that had already broken (#4522 F12). Prepended, so the
 * answer is the same on a host that has the tool and on one that does not, and
 * both replay suites resolve it this way (`probeCommandNames`).
 */
const PRESENCE_STUBS = probeCommandNames(CAPTURES);

describe("tool-state matrix (#4522)", () => {
	const originalPath = process.env.PATH;
	const stubHost = setupTestEnvironment("pi-lens-tool-state-bin-");

	beforeAll(() => {
		for (const name of PRESENCE_STUBS) {
			fs.writeFileSync(path.join(stubHost.tmpDir, name), "#!/bin/sh\n", {
				mode: 0o755,
			});
		}
		process.env.PATH = `${stubHost.tmpDir}${path.delimiter}${originalPath ?? ""}`;
	});

	afterAll(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		stubHost.cleanup();
	});

	beforeEach(() => {
		safeSpawnAsync.mockReset();
	});

	it("has captured runners to drive", () => {
		expect(RUNNER_IDS.length).toBeGreaterThan(0);
	});

	it("names only cells that exist among not-applicable states", () => {
		const live = new Set(
			RUNNER_IDS.flatMap((id) => CELLS.map((cell) => `${id}/${cell.name}`)),
		);
		expect(Object.keys(NOT_APPLICABLE).filter((key) => !live.has(key))).toEqual(
			[],
		);
	});

	for (const runnerId of RUNNER_IDS) {
		const fixtures = CAPTURES.filter((c) => c.provenance.runner === runnerId);
		// The non-dirty states need one fixture to name the file and the argv.
		const first = fixtures.find((c) => c.caseName === "real") ?? fixtures[0];

		describe(runnerId, () => {
			for (const cell of CELLS) {
				if (`${runnerId}/${cell.name}` in NOT_APPLICABLE) continue;
				const targets = cell.name === "dirty" ? fixtures : [first];
				for (const fixture of targets) {
					const label =
						cell.name === "dirty"
							? `${cell.name} (${fixture.caseName})`
							: cell.name;
					// Every fixture carries a clean run: the census refuses one without it,
					// and the old prose escape let a runner silence this cell (#4522 F8).
					if (cell.name === "clean" && !fixture.clean) {
						throw new Error(
							`${fixture.relPath} records no clean run — the census requires one`,
						);
					}
					it(`${label} reads ${cell.expect}`, { timeout: 30000 }, async () => {
						childProcessWindow.begin();
						let env: ReturnType<typeof setupTestEnvironment> | undefined;
						const workerHome = process.env.PI_LENS_HOME;
						const previousHome = workerHome;
						try {
							vi.resetModules();
							env = setupTestEnvironment("pi-lens-tool-state-");
							// Keep every module graph's delayed probe-cache flush inside
							// this cell. A later vi.resetModules() must never read a
							// durable answer written by an earlier graph.
							process.env.PI_LENS_HOME = path.join(env.tmpDir, "probe-home");
							if (
								runnerId === "biome-check-json" &&
								cell.name === "unanswered (probe exhausts its budget)"
							) {
								// A valid durable answer in the inherited worker home is
								// deliberately not visible from this cell's private home.
								// This pins the cache-hit regression without mocking fs.
								const binary = "/bin/true";
								const stat = fs.statSync(binary);
								if (!workerHome) throw new Error("missing worker PI_LENS_HOME");
								fs.mkdirSync(workerHome, { recursive: true });
								fs.writeFileSync(
									path.join(workerHome, "probe-cache.json"),
									JSON.stringify({
										biome: {
											path: binary,
											mtimeMs: stat.mtimeMs,
											sizeBytes: stat.size,
											cachedAt: Date.now(),
										},
									}),
								);
							}
							const { resetSessionScopedState } =
								await import("../../../clients/runtime-session.js");
							resetSessionScopedState(env.tmpDir);
							const dispatcher =
								await import("../../../clients/dispatch/dispatcher.js");
							const { registerDefaultRunners } =
								await import("../../../clients/dispatch/runners/index.js");
							const { FactStore } =
								await import("../../../clients/dispatch/fact-store.js");
							const { reachedNoVerdict } =
								await import("../../../clients/dispatch/types.js");
							const spawn = await import("../../../clients/safe-spawn.js");
							const installer =
								await import("../../../clients/installer/index.js");
							installer.resetProbeCacheStateForTesting();
							// The clean cell replays the CLEAN workspace and its file: copying
							// the dirty one would hand the runner a file full of findings
							// while its spawn answers say clean, and the cell would pass on
							// a parse nothing about it is true (#4522 F4).
							const cleanCell = cell.name === "clean" && fixture.clean;
							fs.cpSync(
								path.join(
									repoRoot,
									cleanCell
										? (fixture.clean?.workspace ?? fixture.provenance.workspace)
										: fixture.provenance.workspace,
								),
								env.tmpDir,
								{ recursive: true },
							);
							const cellFile = cleanCell
								? (fixture.clean?.file ?? fixture.file)
								: fixture.file;
							const filePath = path.join(env.tmpDir, cellFile);
							const answerCtx: AnswerContext = {
								fixture,
								workspace: env.tmpDir,
								classify: (error, cmd) =>
									spawn.classifySpawnFailure(error, { command: cmd }),
								SpawnFailureError: spawn.SpawnFailureError,
								unrecorded: [],
							};
							const spawned: Array<{ call: Call; args: string[] }> = [];
							safeSpawnAsync.mockImplementation(
								async (cmd: string, args: string[]) => {
									const call: Call = isWork(
										args,
										fixture,
										answerCtx.workspace,
										cellFile,
									)
										? "work"
										: "probe";
									spawned.push({ call, args });
									return cell.answer(call, cmd, args, answerCtx);
								},
							);

							const registry = new dispatcher.RunnerRegistry();
							registerDefaultRunners(registry);
							// `no-lsp` is the user kill switch: without it a CLI runner
							// whose language server is installed on the host skips as
							// covered-by-primary, and the cell would depend on the host.
							const ctx = dispatcher.createDispatchContext(
								filePath,
								env.tmpDir,
								{ getFlag: (flag: string) => flag === "no-lsp" },
								new FactStore(),
								undefined,
								undefined,
								env.tmpDir,
							);
							const outcomes = new Map<string, RunnerResult>();
							const dispatched = await dispatcher.dispatchForFile(
								ctx,
								[{ mode: "all", runnerIds: [runnerId] }],
								registry,
								(id, result) => outcomes.set(id, result),
							);
							const outcome = outcomes.get(runnerId);
							const verdict = verdictOf(
								runnerId,
								dispatched,
								outcome,
								reachedNoVerdict,
							);
							const context = `${runnerId} / ${cell.name}: runner ${outcome?.status}${outcome?.failureKind ? `/${outcome.failureKind}` : ""}${outcome?.skipReason ? `/${outcome.skipReason}` : ""}; spawns ${JSON.stringify(spawned.map((s) => `${s.call}:${s.args.join(" ").slice(0, 60)}`))}`;

							// A probe the capture did not record cannot be answered from a
							// neighbour's record: that substitution is what #4522 F5 found in
							// this cell. The cell still runs, so the list names the drift.
							expect(
								answerCtx.unrecorded,
								`${context}: probe(s) no fixture recorded — a cell must answer each probe from its own record, never from another probe's`,
							).toEqual([]);

							if (cell.expect === "not-clean") {
								expect(
									verdict,
									`${context}: an unanswered tool read clean`,
								).not.toBe("clean");
								return;
							}
							if (cell.expect === "clean" || cell.expect === "findings") {
								// The control: the runner reached its work spawn.
								expect(
									spawned.some((s) => s.call === "work"),
									`${context}: the runner never reached its work spawn, so this cell proves nothing`,
								).toBe(true);
							}
							// #5258: the end-to-end half. The group is this runner alone, so a
							// `checked` verdict could only come from it completing: a tool that
							// never answered must not let the write line read clean.
							if (cell.expect === "no-verdict") {
								expect(
									dispatched.verdict.checked,
									`${context}: an unanswered tool let the write line read clean`,
								).toBe(false);
							}
							expect(verdict, context).toBe(cell.expect);
						} finally {
							if (previousHome === undefined) delete process.env.PI_LENS_HOME;
							else process.env.PI_LENS_HOME = previousHome;
							childProcessWindow.end();
							env?.cleanup();
						}
					});
				}
			}
		});
	}
});
