// flake-shape: real-process-spawn — the linked worktree this witness needs exists only when real git creates it (`git worktree add`), and the opaque recovery under test is git's own `status --porcelain`; a stubbed git could not answer either question.
// flake-shape: in-process-mock — clients/pipeline stands in for per-file dispatch so this witness observes only what the opaque prescan recorded and recovered; the pipeline itself is not under test here.
/**
 * #4504 witness: the opaque prescan finds the baseline its OWN `tool_call`
 * recorded when the session's cwd is not the coordinator's project root.
 *
 * The shape is the concurrent-secondary session (#473): pi-lens starts the
 * secondary WITHOUT `handleSessionStart` (#2129), so `runtime.projectRoot`
 * keeps the live primary's root while `ctx.cwd` is the secondary's own — the
 * subagent-in-a-linked-worktree case the #4500 review probed. The `tool_call`
 * side keyed its record on `ctx.cwd` and the `tool_result` side keyed its take
 * on `runtime.projectRoot`, so one session wrote under one root and looked
 * under another: zero rows at its `tool_result` and a
 * `no-pending-snapshot` verdict for a command that did write.
 *
 * Real here: `index.ts`'s registered `session_start`, `turn_start`,
 * `tool_call` and `tool_result` handlers, one module-level
 * `RuntimeCoordinator` shared by both activations (as `index.ts` runs it), the
 * opaque prescan store, and real git repositories including a real linked
 * worktree. Doubled only at one process boundary: `clients/pipeline`, so the
 * synthetic dispatch of the recovered file stays inert.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("../clients/pipeline.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/pipeline.js")>()),
	// The synthetic dispatch of a recovered opaque write is not this witness's
	// subject; a resolved verdict keeps its linter children out of the run.
	runPipeline: vi.fn().mockResolvedValue({
		output: "✓ no blockers",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	}),
}));

import extension from "../index.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import {
	_resetSessionLifecycleForTests,
	getSecondarySessionCount,
} from "../clients/session-lifecycle.js";
import { resetSessionScopedState } from "../clients/runtime-session.js";
import { setupTestEnvironment } from "./clients/test-utils.js";
import { execFileSync } from "./support/git-fixture-env.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";

/** The file the opaque command is stood in for writing. */
const GENERATED = "generated-4504.ts";
/**
 * An argv no extractor recognizes as a write: one script path, no redirect,
 * no `tee`/`sed -i`/`cp` target. The test runs its effect itself, as every
 * harness on these hooks does (pi owns command execution, not pi-lens).
 */
const COMMAND = "node scripts/gen-4504.mjs";

let env: ReturnType<typeof setupTestEnvironment> | undefined;
let mainRoot = "";
let worktreeRoot = "";
const originalTestMode = process.env.PI_LENS_TEST_MODE;

beforeAll(() => {
	env = setupTestEnvironment("pi-lens-4504-prescan-");
	mainRoot = path.join(env.tmpDir, "main");
	worktreeRoot = path.join(env.tmpDir, "linked-worktree");
});

afterAll(() => {
	_resetSessionLifecycleForTests();
	if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = originalTestMode;
	env?.cleanup();
	env = undefined;
});

beforeEach(() => {
	// The session_start battery runs in the default test mode, where the
	// installer's managed-tool refreshes stay gated. Only the two bash hooks
	// below need real latency rows, so the test turns the suppression off for
	// exactly that window.
	if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = originalTestMode;
});

afterEach(async () => {
	// #5146: end the sessions the case started before their state is reset.
	await endMockSessions();
	// The shared per-session reset, not a hand-picked subset: it clears the
	// opaque baseline and HEAD records these cases write (through
	// `resetOpaqueMutationState`) beside every other owner-held store, and the
	// lifecycle admission fields stay separate because they are the guard, not
	// session state.
	resetSessionScopedState();
	_resetSessionLifecycleForTests();
});

/** A committed repository at `dir`, holding one source file. */
function initRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "seed.ts"), "export const seed = 1;\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** The latency rows whose `filePath` names `needle`. */
async function rowsNaming(
	needle: string,
): Promise<Array<{ phase?: string; filePath?: string; result?: string }>> {
	await flushLatencyLog();
	const read = readNdjsonRows<{
		phase?: string;
		filePath?: string;
		result?: string;
	}>(getLatencyLogPath());
	// A row whose write was torn cannot be the row this witness names; red with
	// the count rather than read a shorter trace as the answer.
	expect(read.skipped).toBe(0);
	return read.rows
		.filter((row) => (row.filePath ?? "").includes(needle))
		.map((row) => ({
			phase: row.phase,
			filePath: row.filePath,
			result: row.result,
		}));
}

describe("the opaque prescan's two looks resolve one root per session (#4504)", () => {
	it(
		"recovers the linked-worktree session's own opaque write at its tool_result",
		{ timeout: 120_000 },
		async () => {
			initRepo(mainRoot);
			// A real linked worktree: its `.git` is a FILE naming the main
			// checkout's worktree directory, which is the layout the #4500 probe
			// ran in.
			git(["worktree", "add", "-q", worktreeRoot, "HEAD"], mainRoot);
			expect(fs.statSync(path.join(worktreeRoot, ".git")).isFile()).toBe(true);

			// The live primary session: it owns the process's one coordinator, so
			// its root is the root that coordinator keeps.
			const primary = createPiMock();
			extension(primary.asExtensionAPI());
			const primaryCtx = makeCtx({ cwd: mainRoot, sessionId: "4504-primary" });
			await primary.emit("session_start", makeSessionStartEvent(), primaryCtx);
			await primary.emit("turn_start", {}, primaryCtx);

			// The concurrent secondary, in the linked worktree: declined by the
			// #473 guard, so no session_start body runs for it and the
			// coordinator keeps the primary's root.
			const secondary = createPiMock();
			extension(secondary.asExtensionAPI());
			const secondaryCtx = makeCtx({
				cwd: worktreeRoot,
				sessionId: "4504-secondary",
			});
			await secondary.emit(
				"session_start",
				makeSessionStartEvent(),
				secondaryCtx,
			);
			expect(getSecondarySessionCount()).toBe(1);
			await secondary.emit("turn_start", {}, secondaryCtx);

			// The host order: tool_call (the command has not run), the command,
			// then tool_result. `PI_LENS_TEST_MODE=0` makes the phase rows real;
			// it covers only these two emits.
			process.env.PI_LENS_TEST_MODE = "0";
			const toolCallId = "4504-call-1";
			const input = { command: COMMAND };
			try {
				await secondary.emit(
					"tool_call",
					{ toolName: "bash", toolCallId, input },
					secondaryCtx,
				);
				fs.writeFileSync(
					path.join(worktreeRoot, GENERATED),
					"export const generated = 2;\n",
				);
				await secondary.emit(
					"tool_result",
					{
						toolName: "bash",
						toolCallId,
						input,
						isError: false,
						content: [{ type: "text", text: "ok" }],
					},
					secondaryCtx,
				);
			} finally {
				if (originalTestMode === undefined)
					delete process.env.PI_LENS_TEST_MODE;
				else process.env.PI_LENS_TEST_MODE = originalTestMode;
			}

			// The record the prescan's own tool_call took is found by its own
			// tool_result: the diff ran against the worktree and named the file.
			const prescan = (await rowsNaming(COMMAND)).filter(
				(row) => row.phase === "opaque_mutation_prescan",
			);
			expect(prescan).toHaveLength(1);
			// The git strategy, so the case is the production one and not the
			// stat-diff fallback.
			expect(prescan[0]?.result).toBe("git");

			// Both halves in one assertion: the command's own write is recovered,
			// and no honest-verdict row claims it had no baseline.
			expect({
				recovered: (await rowsNaming(GENERATED))
					.filter((row) => row.phase === "opaque_mutation_recovered")
					.map((row) => row.result),
				verdicts: (await rowsNaming(COMMAND))
					.filter((row) => row.phase === "opaque_mutation_coverage_unknown")
					.map((row) => row.result),
			}).toEqual({ recovered: ["changed:1"], verdicts: [] });
		},
	);

	// Residual 1 of the same shape (#4493's head-move resync): its record and
	// its take also split the root, so a secondary saw a first sight at its own
	// `tool_result`, and a HEAD move made between the two hooks resynced
	// nothing. Both halves now ask `opaquePrescanRoot`.
	it(
		"resyncs a HEAD move its own tool_call recorded, in the linked worktree",
		{ timeout: 120_000 },
		async () => {
			const headMain = path.join(env!.tmpDir, "head-main");
			const headWorktree = path.join(env!.tmpDir, "head-worktree");
			initRepo(headMain);
			git(["worktree", "add", "-q", headWorktree, "HEAD"], headMain);
			// The command label is the row's `filePath`, so it names this case.
			const command = "node scripts/gen-head.mjs";

			const primary = createPiMock();
			extension(primary.asExtensionAPI());
			const primaryCtx = makeCtx({
				cwd: headMain,
				sessionId: "4504r1-primary",
			});
			await primary.emit("session_start", makeSessionStartEvent(), primaryCtx);
			await primary.emit("turn_start", {}, primaryCtx);

			const secondary = createPiMock();
			extension(secondary.asExtensionAPI());
			const secondaryCtx = makeCtx({
				cwd: headWorktree,
				sessionId: "4504r1-secondary",
			});
			await secondary.emit(
				"session_start",
				makeSessionStartEvent(),
				secondaryCtx,
			);
			expect(getSecondarySessionCount()).toBe(1);
			await secondary.emit("turn_start", {}, secondaryCtx);

			process.env.PI_LENS_TEST_MODE = "0";
			const toolCallId = "4504-r1-call-1";
			const input = { command };
			try {
				// The hook that records the HEAD the command starts from.
				await secondary.emit(
					"tool_call",
					{ toolName: "bash", toolCallId, input },
					secondaryCtx,
				);
				// A clean-tree HEAD move between the two hooks: only the head look
				// can see it, and only under the key its own tool_call recorded.
				fs.writeFileSync(
					path.join(headWorktree, "moved.ts"),
					"export const moved = 1;\n",
				);
				git(["add", "-A"], headWorktree);
				git(["commit", "-qm", "move head"], headWorktree);
				await secondary.emit(
					"tool_result",
					{
						toolName: "bash",
						toolCallId,
						input,
						isError: false,
						content: [{ type: "text", text: "ok" }],
					},
					secondaryCtx,
				);
			} finally {
				if (originalTestMode === undefined)
					delete process.env.PI_LENS_TEST_MODE;
				else process.env.PI_LENS_TEST_MODE = originalTestMode;
			}

			// One row per move, written by the look that found it. A split root
			// reads the coordinator's checkout, whose HEAD this session never
			// recorded, so the move is a first sight and no row appears.
			expect(
				(await rowsNaming(command))
					.filter((row) => row.phase === "opaque_mutation_head_moved")
					.map((row) => row.result),
			).toEqual(["changed:1"]);
		},
	);
});
