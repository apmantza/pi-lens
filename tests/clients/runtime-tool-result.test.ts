// lane: windows-vitest — #3294's case-spelling cell asserts the host
// filesystem's own answer; no external toolchain is required because the
// production handleToolResult path and pipeline boundary are in-process.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { evaluateGitGuard } from "../../clients/git-guard.js";
import {
	AgentBehaviorClient,
	type BehaviorWarning,
} from "../../clients/agent-behavior-client.js";
import {
	_resetAgentNudgeForTests,
	consumeAgentNudge,
} from "../../clients/agent-nudge.js";
import { PI_LENS_SYNTHETIC_MUTATION_FIELD } from "../../clients/mutating-tool.js";
import { readChangesSince } from "../../clients/project-changes.js";
import {
	MAX_PENDING_CASCADE_RUNS,
	RuntimeCoordinator,
} from "../../clients/runtime-coordinator.js";
import { gatedPromise } from "../support/fault-injection.js";
import {
	registerPrimarySession,
	releasePrimarySession,
} from "../../clients/session-lifecycle.js";
import { resetSessionScopedState } from "../../clients/runtime-session.js";
import { beginScope, retireScope } from "../../clients/session-scope.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import {
	clearLastAnalyzedStateCache,
	handleToolExecutionEnd,
	handleToolResult,
} from "../../clients/runtime-tool-result.js";
import {
	clearFormatterRuntimeState,
	getFormattersForFile,
} from "../../clients/formatters.js";
import {
	getGlobalPiLensDir,
	getProjectDataDir,
	getProjectIgnoreMatcher,
} from "../../clients/file-utils.js";
import {
	normalizeFilePath,
	normalizeMapKey,
	resolveHostToolPath,
} from "../../clients/path-utils.js";
import { pinFixtureHome, writeLinkedWorktree } from "./test-utils.js";
import {
	captureFileStats,
	getOpaqueBaselineStore,
	opaqueBaselineSlot,
} from "../../clients/opaque-mutation-scan.js";
import { getLSPService } from "../../clients/lsp/capabilities.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { runPipeline } from "../../clients/pipeline.js";
import { resolveAnalysisRoot } from "../../clients/analysis-root.js";
import {
	getVerifiedPathAttributionGuessCount,
	resetVerifiedPathAttributionGuessCount,
} from "../../clients/path-attribution-telemetry.js";
import { toPosix } from "../../clients/path-utils.js";
import {
	createTempFile,
	removeTempDirSync,
	setupTestEnvironment,
} from "./test-utils.js";
import {
	createBashToolDefinition,
	createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import {
	installLspService,
	installLspServiceDouble,
} from "../support/lsp-service-seam.js";

const readFileSyncSpy = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: (...args: any[]) => {
			readFileSyncSpy(...args);
			return (actual.readFileSync as any)(...args);
		},
	};
});

const logLatency = vi.hoisted(() => vi.fn());
const requestBootstrapClients = vi.hoisted(() => vi.fn());
vi.mock("../../clients/bootstrap.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/bootstrap.js")>();
	requestBootstrapClients.mockImplementation(actual.requestBootstrapClients);
	return { ...actual, requestBootstrapClients };
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readdir: vi.fn(actual.readdir) };
});

vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(),
}));

const notifyExternalFileChange = vi.hoisted(() => vi.fn(async () => undefined));
const readdirMock = vi.mocked(fsp.readdir);
const realReaddir = readdirMock.getMockImplementation()!;

beforeEach(async () => {
	// `notifyExternalFileChange` is the spy above: the double answers it for the
	// production export. The install is not eager, so `peekLSPService()` stays
	// undefined until a case builds a service (#4504 r1 builds one below).
	await installLspServiceDouble({ notifyExternalFileChange });
	requestBootstrapClients.mockClear();
	readdirMock.mockImplementation(realReaddir);
	readdirMock.mockClear();
	_resetAgentNudgeForTests();
});

it("notices once when an edit is outside the session root (#4218)", async () => {
	resetDegradationLedger();
	const env = setupTestEnvironment("pi-lens-4218-outside-root-");
	// #4560: the sibling must stay a DIRECT child of the tmp root — a
	// `pi-lens-`-prefixed fixture under it would be classified as pi-owned
	// scratch (`isPiOwnedTempPath`) and never notify. It is removed here, so
	// the widened tmp-root census never sees a leftover.
	const captureRoot = path.join(
		env.tmpDir,
		"..",
		`capture-4218-${process.pid}`,
	);
	try {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		const outsidePath = path.join(captureRoot, "outside.ts");
		fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
		fs.writeFileSync(outsidePath, "export const value = 1;\n");

		for (let i = 0; i < 10; i++)
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: outsidePath },
					content: [{ type: "text", text: "ok" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as never);

		expect(
			getDegradationSummary().filter(
				(entry) => entry.kind === "tool-result-outside-project-root",
			),
		).toHaveLength(1);
		expect(
			consumeAgentNudge(undefined, runtime.sessionScope)?.messages,
		).toEqual([
			expect.objectContaining({
				content: expect.stringContaining(outsidePath),
			}),
		]);
		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();
	} finally {
		env.cleanup();
		fs.rmSync(captureRoot, { recursive: true, force: true });
	}
});

it("keeps intended vendor skips silent (#4218)", async () => {
	resetDegradationLedger();
	const env = setupTestEnvironment("pi-lens-4218-vendor-silent-");
	try {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		const vendorPath = path.join(env.tmpDir, "node_modules", "pkg", "index.ts");
		fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
		fs.writeFileSync(vendorPath, "export const value = 1;\n");

		await handleToolResult({
			event: {
				toolName: "edit",
				input: { path: vendorPath },
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			resetLSPService: () => {},
			readGuard: runtime.readGuard,
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as never);

		expect(
			getDegradationSummary().some(
				(entry) => entry.kind === "tool-result-outside-project-root",
			),
		).toBe(false);
		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();
	} finally {
		env.cleanup();
	}
});

/**
 * What `runPipeline` returns for a linked-worktree edit, by verdict: the
 * shapes `tests/clients/pipeline.test.ts` pins on the real pipeline (its
 * "All-clear output" cells). A clean run's output is the all-clear line,
 * never empty (#4734 review F1), and that line is not the verdict (r3).
 */
const linkedWorktreeResult = {
	clean: () => ({
		output: "✓ JavaScript/TypeScript clean · 5ms",
		hasBlockers: false,
		isError: false,
		fileModified: false,
		checkedClean: true,
	}),
	/**
	 * The same clean line with no clean verdict: a run that recorded only a
	 * warning (the dispatcher renders no text for one), or one no language
	 * server answered (#4734 r3 state table, rows 5, 6, 8, 10-13).
	 */
	uncheckedCleanLine: () => ({
		output: "✓ JavaScript/TypeScript clean · 5ms",
		hasBlockers: false,
		isError: false,
		fileModified: false,
		checkedClean: false,
	}),
	/** A format-only change whose primary did not answer: no output at all. */
	formatOnlyUnconfirmed: (targetPath: string) => ({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: true,
		checkedClean: false,
		postAutofixNotice: { targetPath, changedFiles: [targetPath] },
	}),
};

/**
 * One linked worktree of a session checkout at `checkoutRoot`, its session
 * coordinator, and an edit `tool_result` for one file in the worktree.
 */
function linkedWorktreeEdit(checkoutRoot: string) {
	const { repo, worktree } = writeLinkedWorktree(checkoutRoot);
	const worktreeFile = path.join(worktree, "src", "sibling.ts");
	fs.mkdirSync(path.dirname(worktreeFile), { recursive: true });
	fs.writeFileSync(worktreeFile, "export const value = 1;\n");
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = repo;
	const editResult = () =>
		({
			event: {
				toolName: "edit",
				input: { path: worktreeFile },
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			resetLSPService: () => {},
			readGuard: runtime.readGuard,
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
			// The pipeline is doubled, so these three only satisfy
			// `ensureToolResultClients` (`deps.biomeClient && deps.ruffClient &&
			// deps.metricsClient`): the dispatch itself must be REACHED for the
			// delivery rung to be the thing under test, and a failed bootstrap
			// demand would skip it.
			biomeClient: {},
			ruffClient: {},
			metricsClient: {},
		}) as never;
	return { repo, worktree, worktreeFile, runtime, editResult };
}

it("announces a linked-worktree edit the pipeline found nothing in (#2050 AC3)", async () => {
	resetDegradationLedger();
	const env = setupTestEnvironment("pi-lens-2050-worktree-delivery-");
	// A linked worktree of the session's checkout, written as the metadata git
	// itself writes (`<worktree>/.git` names a worktree-private gitdir whose
	// `commondir` points at the shared `.git`), so no child process is needed.
	// The class assertion below reds if the fixture stops resolving as a
	// worktree. The checkout is a DIRECT child of the temp root with no
	// `pi-lens-` prefix: a pi-owned temp path is the intended-skip class, not
	// the linked-worktree class this rung is about (#4560). Removed here, so the
	// widened tmp-root census never sees a leftover.
	const checkoutRoot = path.join(
		env.tmpDir,
		"..",
		`capture-2050-worktree-${process.pid}`,
	);
	const { repo, worktree, worktreeFile, runtime, editResult } =
		linkedWorktreeEdit(checkoutRoot);
	try {
		expect(resolveAnalysisRoot(worktreeFile, repo)).toBe("linked-worktree");
		vi.mocked(runPipeline).mockResolvedValue(linkedWorktreeResult.clean());
		const runsBefore = vi.mocked(runPipeline).mock.calls.length;

		await handleToolResult(editResult());

		// One bounded row names the root the session analysed, so "the analysis
		// ran on a worktree foreign to the session" is not only in latency.log.
		const worktreeRows = getDegradationSummary().filter(
			(entry) => entry.kind === "tool-result-linked-worktree",
		);
		expect(worktreeRows).toHaveLength(1);
		expect(worktreeRows[0]?.latestReasons[0]?.subject).toContain(
			path.basename(worktree),
		);
		// The advisory is gated by its own once-per-root row, and that record is
		// what a reader can count: one clean run, one row.
		expect(
			getDegradationSummary()
				.filter((entry) => entry.kind === "tool-result-linked-worktree-clean")
				.map((entry) => entry.count),
		).toEqual([1]);
		// The run produced nothing, so silence would be ambiguous: the agent is
		// told the analysis RAN and found nothing.
		expect(
			consumeAgentNudge(undefined, runtime.sessionScope)?.messages,
		).toEqual([
			expect.objectContaining({
				content: expect.stringContaining(path.basename(worktree)),
			}),
		]);
		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();

		// Bounded: a second silent run in the same worktree is covered by the
		// first row and advisory, not by a second pair. Each later edit writes
		// new bytes: an unchanged file never reaches the pipeline, so the run
		// below would observe nothing (the pipeline-call count proves it ran).
		fs.writeFileSync(worktreeFile, "export const value = 2;\n");
		await handleToolResult(editResult());
		expect(vi.mocked(runPipeline).mock.calls).toHaveLength(runsBefore + 2);
		expect(
			getDegradationSummary().filter(
				(entry) => entry.kind === "tool-result-linked-worktree",
			),
		).toHaveLength(1);
		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();

		// The same clean line from a run that recorded a warning, or that no
		// language server answered, states nothing: the line is not the verdict.
		resetDegradationLedger();
		vi.mocked(runPipeline).mockResolvedValue(
			linkedWorktreeResult.uncheckedCleanLine(),
		);
		fs.writeFileSync(worktreeFile, "export const value = 3;\n");
		await handleToolResult(editResult());
		expect(vi.mocked(runPipeline).mock.calls).toHaveLength(runsBefore + 3);
		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();
	} finally {
		vi.mocked(runPipeline).mockReset();
		env.cleanup();
		fs.rmSync(checkoutRoot, { recursive: true, force: true });
	}
});

// Recurrence: #4734 Greptile "Unchecked edits look checked". An empty output
// is a format-only change, and here the primary never answered: telling the
// agent the analysis ran and found nothing would read an unavailable check as
// a clean one (AGENTS.md shape 10).
it("states nothing for a linked-worktree format-only change whose primary did not answer", async () => {
	resetDegradationLedger();
	const env = setupTestEnvironment("pi-lens-2657-worktree-unconfirmed-");
	const checkoutRoot = path.join(
		env.tmpDir,
		"..",
		`capture-2657-unconfirmed-${process.pid}`,
	);
	const { repo, worktreeFile, runtime, editResult } =
		linkedWorktreeEdit(checkoutRoot);
	try {
		expect(resolveAnalysisRoot(worktreeFile, repo)).toBe("linked-worktree");
		vi.mocked(runPipeline).mockResolvedValue(
			linkedWorktreeResult.formatOnlyUnconfirmed("src/sibling.ts"),
		);
		const runsBefore = vi.mocked(runPipeline).mock.calls.length;

		await handleToolResult(editResult());

		expect(vi.mocked(runPipeline).mock.calls).toHaveLength(runsBefore + 1);
		expect(
			getDegradationSummary()
				.filter((entry) => entry.kind.startsWith("tool-result-linked-worktree"))
				.map((entry) => entry.kind),
		).toEqual(["tool-result-linked-worktree"]);
		expect(
			(
				consumeAgentNudge(undefined, runtime.sessionScope)?.messages ?? []
			).filter((message) => String(message.content).includes("found nothing")),
		).toEqual([]);
	} finally {
		vi.mocked(runPipeline).mockReset();
		env.cleanup();
		fs.rmSync(checkoutRoot, { recursive: true, force: true });
	}
});

// Recurrence: #4734 Sourcery thread 3. The row's root came from the
// out-of-session eligibility rule, which refuses a pi-owned temp path, so a
// worktree the class served in full was analysed in silence.
it("records the linked-worktree row for a worktree under a pi-owned temp dir", async () => {
	resetDegradationLedger();
	const env = setupTestEnvironment("pi-lens-2657-pi-owned-worktree-");
	// A `pi-` prefix directly under the temp root is pi-owned
	// (`isPiOwnedTempPath`); removed here, as in the AC3 cell.
	const checkoutRoot = path.join(
		env.tmpDir,
		"..",
		`pi-2657-worktree-${process.pid}`,
	);
	const { repo, worktree, worktreeFile, editResult } =
		linkedWorktreeEdit(checkoutRoot);
	try {
		expect(resolveAnalysisRoot(worktreeFile, repo)).toBe("linked-worktree");
		vi.mocked(runPipeline).mockResolvedValue(linkedWorktreeResult.clean());

		await handleToolResult(editResult());

		expect(
			getDegradationSummary()
				.filter((entry) => entry.kind === "tool-result-linked-worktree")
				.map((entry) => path.basename(entry.latestReasons[0]?.subject ?? "")),
		).toEqual([path.basename(worktree)]);
	} finally {
		vi.mocked(runPipeline).mockReset();
		env.cleanup();
		fs.rmSync(checkoutRoot, { recursive: true, force: true });
	}
});

// Recurrence: #4734 Sourcery thread 4. The row was written after the pipeline
// await without the #3596 liveness check, so a replaced session's handler
// latched its once-key in the new session's ledger.
/**
 * #5108 review F1, class sweep: the caller names the session an advisory
 * belongs to (`deps.advisoryScope`), because the coordinator's own scope is
 * the primary's and a concurrent secondary drains its own (#473). Recurrence
 * prevented: a `queueAgentAdvisory` site here that takes `writeSession`, so a
 * secondary's notice reaches the primary's context. The outside-root and
 * adopted-root sites are witnessed through `index.ts` in
 * `tests/index-3748-advisory-scope-witness.test.ts`.
 */
describe("tool_result advisories follow the caller's advisory scope (#5108 F1)", () => {
	async function editUnderSecondary(
		prefix: string,
		pipeline: (ctx: { onFixRunLoss?: (notice: string) => void }) => unknown,
	) {
		resetDegradationLedger();
		const env = setupTestEnvironment(prefix);
		const checkoutRoot = path.join(
			env.tmpDir,
			"..",
			`capture-5108-${process.pid}-${prefix}`,
		);
		const { runtime, editResult } = linkedWorktreeEdit(checkoutRoot);
		const secondary = beginScope({ role: "secondary" });
		try {
			vi.mocked(runPipeline).mockImplementation(
				async (ctx) => pipeline(ctx as never) as never,
			);
			await handleToolResult({
				...(editResult() as object),
				advisoryScope: secondary.capture(),
			} as never);
			return {
				secondary: consumeAgentNudge(undefined, secondary)?.messages ?? [],
				primary: consumeAgentNudge(undefined, runtime.sessionScope),
			};
		} finally {
			vi.mocked(runPipeline).mockReset();
			retireScope(secondary, "shutdown");
			env.cleanup();
			fs.rmSync(checkoutRoot, { recursive: true, force: true });
		}
	}

	it("queues the linked-worktree clean notice for the advisory scope", async () => {
		const { secondary, primary } = await editUnderSecondary("wt-clean", () =>
			linkedWorktreeResult.clean(),
		);
		expect(secondary).toEqual([
			expect.objectContaining({
				content: expect.stringContaining("found nothing to report"),
			}),
		]);
		expect(primary).toBeUndefined();
	});

	it("queues a fix-run loss notice for the advisory scope", async () => {
		const { secondary, primary } = await editUnderSecondary(
			"fix-loss",
			(ctx) => {
				ctx.onFixRunLoss?.("restore lost edit 5108-loss.ts");
				return linkedWorktreeResult.uncheckedCleanLine();
			},
		);
		expect(secondary).toEqual([
			expect.objectContaining({
				content: expect.stringContaining("5108-loss.ts"),
			}),
		]);
		expect(primary).toBeUndefined();
	});
});

it("a linked-worktree result settling after a replacement records nothing in the new session", async () => {
	resetDegradationLedger();
	const env = setupTestEnvironment("pi-lens-2657-worktree-replaced-");
	const checkoutRoot = path.join(
		env.tmpDir,
		"..",
		`capture-2657-replaced-${process.pid}`,
	);
	const { repo, worktreeFile, runtime, editResult } =
		linkedWorktreeEdit(checkoutRoot);
	const entered = gatedPromise<void>();
	const release = gatedPromise<void>();
	try {
		expect(resolveAnalysisRoot(worktreeFile, repo)).toBe("linked-worktree");
		vi.mocked(runPipeline).mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return linkedWorktreeResult.clean();
		});

		const handler = handleToolResult(editResult());
		await entered.promise;
		// session_start: the coordinator and the ledger reset for session 2.
		runtime.resetForSession();
		resetDegradationLedger();
		release.resolve();
		await handler;

		expect(vi.mocked(runPipeline).mock.calls.length).toBeGreaterThan(0);
		expect(
			getDegradationSummary()
				.filter((entry) => entry.kind.startsWith("tool-result-linked-worktree"))
				.map((entry) => entry.kind),
		).toEqual([]);
		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();
	} finally {
		vi.mocked(runPipeline).mockReset();
		env.cleanup();
		fs.rmSync(checkoutRoot, { recursive: true, force: true });
	}
});

it("classifies outside-root path families through the real tool-result seam (#4230)", async () => {
	resetDegradationLedger();
	const env = setupTestEnvironment("pi-lens-4230-path-families-");
	const previousHome = process.env.HOME;
	const previousTmpDir = process.env.TMPDIR;
	const previousDataDir = process.env.PILENS_DATA_DIR;
	const isolatedTmpDir = path.join(env.tmpDir, "runtime-tmp");
	fs.mkdirSync(isolatedTmpDir, { recursive: true });
	process.env.TMPDIR = isolatedTmpDir;
	const syntheticHome = path.join(env.tmpDir, "home");
	const ordinaryHomeProject = path.join(syntheticHome, "other-project");
	const dataDir = path.join(
		path.dirname(env.tmpDir),
		`pi-lens-4230-data-${process.pid}`,
	);
	fs.mkdirSync(ordinaryHomeProject, { recursive: true });
	fs.writeFileSync(path.join(ordinaryHomeProject, "package.json"), "{}\n");
	process.env.HOME = syntheticHome;
	vi.mocked(
		(await import("../../clients/pipeline.js")).runPipeline,
	).mockResolvedValue({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
		checkedClean: false,
	});
	process.env.PILENS_DATA_DIR = dataDir;
	try {
		const projectDataPath = path.join(
			getProjectDataDir(env.tmpDir),
			"cache.json",
		);
		const cases = [
			[
				"external node_modules",
				path.join(env.tmpDir, "..", "node_modules", "pkg", "index.ts"),
				false,
			],
			[
				"external vendor",
				path.join(env.tmpDir, "..", "vendor", "pkg", "index.ts"),
				false,
			],
			[
				"external venv",
				path.join(env.tmpDir, "..", ".venv", "lib", "index.py"),
				false,
			],
			[
				"external site-packages",
				path.join(env.tmpDir, "..", "site-packages", "pkg.py"),
				false,
			],
			[
				"external bower components",
				path.join(env.tmpDir, "..", "bower_components", "pkg", "index.js"),
				false,
			],
			["pi-lens project cache", projectDataPath, false],
			[
				"pi-lens global home",
				path.join(getGlobalPiLensDir(), "cache.json"),
				false,
			],
			[
				"pi home",
				path.join(os.homedir(), ".pi", "agent", "sessions.jsonl"),
				false,
			],
			[
				"pi-agent scratch",
				path.join(os.tmpdir(), "pi-agent-4230", "tool.tmp"),
				false,
			],
			[
				"pi session-share scratch",
				path.join(os.tmpdir(), "pi-share-4230", "session.html"),
				false,
			],
			[
				"pi external-editor scratch",
				path.join(os.tmpdir(), "pi-editor-4230", "buffer.txt"),
				false,
			],
			[
				"pi WSL clipboard scratch",
				path.join(os.tmpdir(), "pi-wsl-clip-4230.txt"),
				false,
			],
			[
				"generic pi output file",
				path.join(os.tmpdir(), "tool-output-4230-abcdef.txt"),
				false,
			],
			[
				"ordinary tmp project file",
				path.join(path.dirname(env.tmpDir), "capture", "lib", "x.ts"),
				true,
			],
			// D1 maintainer decision: sibling projects below $HOME are adopted;
			// only $HOME itself and its ancestors remain refused.
			[
				"ordinary home project file",
				path.join(ordinaryHomeProject, "src", "a.ts"),
				false,
			],
		] as const;

		for (const [label, filePath, shouldNotify] of cases) {
			resetDegradationLedger();
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					content: [{ type: "text", text: "ok" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as never);
			const notified = getDegradationSummary().some(
				(entry) => entry.kind === "tool-result-outside-project-root",
			);
			expect(notified, label).toBe(shouldNotify);
			const advisory = consumeAgentNudge(undefined, runtime.sessionScope);
			if (shouldNotify) expect(advisory).toBeDefined();
			else expect(advisory).toBeUndefined();
		}
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpDir;
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		removeTempDirSync(dataDir);
		env.cleanup();
	}
});

it("adopts a home sibling but refuses home, ancestors, and a home symlink (#4230 D1)", (ctx) => {
	const env = setupTestEnvironment("pi-lens-4230-home-boundary-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousTmpDir = process.env.TMPDIR;
	// Windows' os.tmpdir() is normally below USERPROFILE, and Windows
	// os.homedir() reads USERPROFILE rather than HOME. Keep this fake home
	// outside the OS temp tree and pin both environment spellings so the D1
	// boundary is testing home ownership, not the temp-root refusal (#4230).
	// Shape 73: it must also sit outside the session's own checkout. In a
	// git-worktree lane `process.cwd()` IS that checkout's root, so the parent
	// of a fixture there resolves a linked worktree of the same repository and
	// the ancestor case below would read `linked-worktree` instead of `none`.
	// A direct child of the OS temp root has a parent that is no checkout.
	const home = path.join(
		path.dirname(env.tmpDir),
		`capture-4230-home-${process.pid}`,
	);
	fs.mkdirSync(home, { recursive: true });
	const sessionRoot = path.join(home, "code", "a");
	const siblingRoot = path.join(home, "code", "b");
	const homeLink = path.join(env.tmpDir, "home-link");
	fs.mkdirSync(sessionRoot, { recursive: true });
	fs.mkdirSync(siblingRoot, { recursive: true });
	fs.writeFileSync(path.join(siblingRoot, "package.json"), "{}\n");
	fs.writeFileSync(path.join(home, "package.json"), "{}\n");
	fs.writeFileSync(path.join(env.tmpDir, "package.json"), "{}\n");
	const isolatedTmpDir = path.join(env.tmpDir, "runtime-tmp");
	fs.mkdirSync(isolatedTmpDir, { recursive: true });
	process.env.TMPDIR = isolatedTmpDir;
	try {
		fs.symlinkSync(home, homeLink, "dir");
	} catch (error) {
		if (previousTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpDir;
		fs.rmSync(home, { recursive: true, force: true });
		env.cleanup();
		ctx.skip(`symlinks are unavailable here: ${String(error)}`);
	}
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		expect(
			resolveAnalysisRoot(path.join(siblingRoot, "src", "b.ts"), sessionRoot),
		).toBe("adopted");
		expect(resolveAnalysisRoot(path.join(home, "home.ts"), sessionRoot)).toBe(
			"none",
		);
		// #4309 r2: assert an actual ancestor of the fake home. env.tmpDir is
		// a separate project under Plegma's marked scratch root, not an ancestor.
		expect(resolveAnalysisRoot(path.dirname(home), sessionRoot)).toBe("none");
		expect(
			resolveAnalysisRoot(path.join(homeLink, "src", "b.ts"), sessionRoot),
		).toBe("none");
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpDir;
		fs.rmSync(home, { recursive: true, force: true });
		env.cleanup();
	}
});

it("does not dispatch an edit when analyzer bootstrap is unavailable (#2939 M9)", async () => {
	const env = setupTestEnvironment("pi-lens-2939-bootstrap-null-");
	try {
		requestBootstrapClients.mockResolvedValueOnce(null);
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		const filePath = createTempFile(
			env.tmpDir,
			"edit.ts",
			"export const x = 1;\n",
		);
		await handleToolResult({
			event: {
				toolName: "edit",
				input: {
					path: filePath,
					oldText: "export const x = 1;",
					newText: "export const x = 2;",
				},
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			resetLSPService: () => {},
			readGuard: runtime.readGuard,
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as never);
		expect(
			vi.mocked((await import("../../clients/pipeline.js")).runPipeline),
		).not.toHaveBeenCalled();
	} finally {
		env.cleanup();
	}
});

describe("bash grep searchReads registration", () => {
	// #3832 recurrence: pi 0.99 codemode hands a script `structuredContent`
	// (`{output, exit_code}`) and drops it from any rewritten result that omits
	// it, so a decorated non-zero bash threw instead of resolving to its object.
	// A real decorated bash is unclassified, so it leaves `handleToolResult` at
	// the `mutation === undefined` return carrying the synthetic-write notes,
	// never at the host-failure return (that one is pinned separately below).
	it.each([
		{ exitCode: 3, isError: true },
		{ exitCode: 0, isError: false },
	])(
		"forwards structuredContent on a decorated bash tool_result that gains pipeline notes, exit $exitCode (#3832)",
		async ({ exitCode, isError }) => {
			const env = setupTestEnvironment("pi-lens-3832-structured-content-");
			try {
				const { runPipeline } = await import("../../clients/pipeline.js");
				vi.mocked(runPipeline).mockResolvedValue({
					output: "PIPELINE-NOTE",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					checkedClean: false,
				});
				const filePath = path.join(env.tmpDir, "changed.ts");
				fs.writeFileSync(filePath, "export const before = true;\n");
				const command = `sed -i 's/before/after/' ${filePath}; exit ${exitCode}`;
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const cacheManager = new CacheManager(false);
				await runHandlerExpectingNoThrow(() =>
					handleToolCall({
						event: {
							toolName: "bash",
							toolCallId: "3832-bash",
							input: { command },
						},
						ctx: { cwd: env.tmpDir },
						lensEnabled: true,
						getFlag: () => false,
						dbg: () => {},
						runtime,
						cacheManager,
						ensureLSPConfigInitialized: async () => {},
						updateLspStatus: () => {},
						resetLSPService: () => {},
					} as any),
				);
				// The host ran the command between tool_call and tool_result.
				fs.writeFileSync(filePath, "export const after = true;\n");
				const structuredContent = {
					output: "",
					truncated: false,
					exit_code: exitCode,
				};

				const rewritten = await handleToolResult({
					event: {
						toolName: "bash",
						toolCallId: "3832-bash",
						input: { command },
						content: [{ type: "text", text: `host exit ${exitCode}` }],
						isError,
						// pi 0.99 supplies this before the tool_result extension hook.
						structuredContent,
					},
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					resetLSPService: () => {},
					readGuard: runtime.readGuard,
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
				} as any);

				expect(rewritten?.structuredContent).toEqual(structuredContent);
				expect(rewritten?.content[0]).toEqual({
					type: "text",
					text: `host exit ${exitCode}`,
				});
				expect(JSON.stringify(rewritten?.content)).toContain("PIPELINE-NOTE");
				// The host's own status must stay the host's: forcing it would change
				// what the script sees.
				expect(rewritten).not.toHaveProperty("isError");
			} finally {
				env.cleanup();
			}
		},
	);

	it("forwards structuredContent on the host-failure return of a classified tool (#3832)", async () => {
		const env = setupTestEnvironment("pi-lens-3832-host-failure-");
		try {
			const filePath = path.join(env.tmpDir, "changed.ts");
			fs.writeFileSync(filePath, "export const value = true;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const rewritten = await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					content: [{ type: "text", text: "host failed" }],
					isError: true,
					structuredContent: { exit_code: 3 },
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(rewritten).toEqual({
				content: [{ type: "text", text: "host failed" }],
				isError: true,
				structuredContent: { exit_code: 3 },
			});
		} finally {
			env.cleanup();
		}
	});

	it("forwards structuredContent on the pipeline-crash response (#3832)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockRejectedValueOnce(new Error("boom"));
		const env = setupTestEnvironment("pi-lens-3832-crash-");
		try {
			const filePath = path.join(env.tmpDir, "changed.ts");
			fs.writeFileSync(filePath, "export const value = true;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			const rewritten = await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const value = true;" },
					content: [{ type: "text", text: "ok" }],
					structuredContent: { result: "structured" },
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(rewritten).toEqual(
				expect.objectContaining({
					isError: true,
					structuredContent: { result: "structured" },
				}),
			);
			expect(rewritten?.content.length).toBeGreaterThan(1);
		} finally {
			env.cleanup();
		}
	});

	it("preserves structuredContent on pipeline rewrites (#3832)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-3832-pipeline-content-");
		try {
			const filePath = path.join(env.tmpDir, "changed.ts");
			fs.writeFileSync(filePath, "export const value = true;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const base = {
				event: {
					toolName: "edit",
					input: { path: filePath },
					content: [{ type: "text", text: "ok" }],
					structuredContent: { result: "structured" },
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any;

			vi.mocked(runPipeline).mockResolvedValueOnce({
				output: "pipeline warning",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				checkedClean: false,
			});
			expect(await handleToolResult(base)).toEqual(
				expect.objectContaining({
					structuredContent: { result: "structured" },
				}),
			);

			runtime.beginTurn();
			vi.mocked(runPipeline).mockResolvedValueOnce({
				output: "pipeline error",
				hasBlockers: false,
				isError: true,
				fileModified: false,
				checkedClean: false,
			});
			expect(await handleToolResult(base)).toEqual(
				expect.objectContaining({
					isError: true,
					structuredContent: { result: "structured" },
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("supersedes the provisional native read before checkEdit", async () => {
		const env = setupTestEnvironment("pi-lens-2802-native-supersession-");
		try {
			const filePath = path.join(env.tmpDir, "large.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 3000 }, (_, i) => `line${i + 1}`).join("\n") +
					"\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolName: "read",
						toolCallId: "2802-supersede",
						input: { path: filePath, offset: 1, limit: 3000 },
					},
					ctx: { cwd: env.tmpDir },
					lensEnabled: true,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);
			const readTool = createReadToolDefinition(env.tmpDir);
			const result = await readTool.execute(
				"2802-supersede",
				{ path: filePath, offset: 1, limit: 3000 },
				undefined,
				undefined,
				{ cwd: env.tmpDir } as never,
			);
			await handleToolResult({
				event: {
					toolName: "read",
					toolCallId: "2802-supersede",
					input: { path: filePath, offset: 1, limit: 3000 },
					content: result.content,
					details: result.details,
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			expect(runtime.readGuard.checkEdit(filePath, [2500, 2500]).action).toBe(
				"block",
			);
		} finally {
			env.cleanup();
		}
	});

	it("registers the native read range the host delivered at EOF", async () => {
		resetDegradationLedger();
		const env = setupTestEnvironment("pi-lens-2802-native-read-eof-");
		try {
			const filePath = path.join(env.tmpDir, "short.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 120 }, (_, i) => `line${i + 1}`).join("\n"),
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const recordRead = vi.spyOn(runtime.readGuard, "recordRead");
			const agentBehaviorRecord = vi.fn(() => []);
			const readTool = createReadToolDefinition(env.tmpDir);
			const result = await readTool.execute(
				"2802",
				{ path: filePath, offset: 1, limit: 400 },
				undefined,
				undefined,
				{ cwd: env.tmpDir } as never,
			);

			await handleToolResult({
				event: {
					toolName: "read",
					input: { path: filePath, offset: 1, limit: 400 },
					content: result.content,
					details: result.details,
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord,
				formatBehaviorWarnings: () => "",
			} as never);

			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath,
					requestedLimit: 400,
					effectiveOffset: 1,
					effectiveLimit: 120,
				}),
				// #3524: no writer raced this read, so it re-stamps FileTime.
				{ stampFileTime: true },
			);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #4138, #3831: the ids on a read's records. The call identity (`c1/1`
	 * for a nested call) keys the tool_call capture and its supersession; the
	 * transcript identity (the parent `c1`, whose toolResult the branch shows)
	 * is the only `toolCallId` a read-evidence record carries, from every
	 * writer. Each case enters through the real `handleToolCall`, so the
	 * attribution a relative path needs at tool_result is the production one,
	 * never seeded (#4185 round 1 F3: a seeded attribution left the
	 * `toolName === "read"` attribution branch with no test that could red).
	 */
	describe("nested call identity on read evidence (#4138 #3831)", () => {
		const noLsp = (name: string) =>
			name === "no-lsp" || name === "no-complexity";
		function callDeps(runtime: RuntimeCoordinator, event: unknown) {
			return {
				event,
				ctx: { cwd: runtime.projectRoot },
				lensEnabled: true,
				getFlag: noLsp,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				ensureLSPConfigInitialized: async () => {},
				updateLspStatus: () => {},
				resetLSPService: () => {},
			} as never;
		}
		function resultDeps(
			runtime: RuntimeCoordinator,
			event: unknown,
			agentBehaviorRecord: () => string[] = () => [],
		) {
			return {
				event,
				getFlag: noLsp,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord,
				formatBehaviorWarnings: () => "",
			} as never;
		}
		/** pi's nested read of a RELATIVE path: tool_call, the real read tool, tool_result. */
		async function nestedRead(
			runtime: RuntimeCoordinator,
			spelling: string,
			agentBehaviorRecord: () => string[] = () => [],
		) {
			const input = { path: spelling, offset: 1, limit: 20 };
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					callDeps(runtime, {
						toolName: "read",
						toolCallId: "codemode-1/1",
						parentToolCallId: "codemode-1",
						input,
					}),
				),
			);
			const result = await createReadToolDefinition(
				runtime.projectRoot!,
			).execute("codemode-1/1", input, undefined, undefined, {
				cwd: runtime.projectRoot,
			} as never);
			await handleToolResult(
				resultDeps(
					runtime,
					{
						toolName: "read",
						toolCallId: "codemode-1/1",
						parentToolCallId: "codemode-1",
						input,
						content: result.content,
						details: result.details,
					},
					agentBehaviorRecord,
				),
			);
		}

		it("records a relative nested read under its parent's transcript identity, after a provisional record keyed by its own call", async () => {
			const env = setupTestEnvironment("pi-lens-relative-nested-read-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"nested.ts",
					"export const value = 1;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const recordRead = vi.spyOn(runtime.readGuard, "recordRead");
				const agentBehaviorRecord = vi.fn(() => []);

				await nestedRead(runtime, "nested.ts", agentBehaviorRecord);

				// tool_call: the capture, keyed by the call (pi's `c1/1`, sanitized
				// to `c1_1` by `sanitizeCorrelationId`), with no transcript id.
				expect(recordRead.mock.calls[0]?.[0]).toMatchObject({
					filePath,
					provisional: true,
					source: "native-read:codemode-1_1:provisional",
				});
				expect(recordRead.mock.calls[0]?.[0]).not.toHaveProperty("toolCallId");
				// tool_result: the delivered record under the parent, superseding
				// the capture by the call identity.
				expect(recordRead).toHaveBeenLastCalledWith(
					expect.objectContaining({
						filePath,
						effectiveOffset: 1,
						toolCallId: "codemode-1",
					}),
					expect.objectContaining({
						supersedes: { toolCallId: "codemode-1_1" },
					}),
				);
				expect(runtime.readGuard.getReadHistory(filePath)).toEqual([
					expect.objectContaining({ toolCallId: "codemode-1" }),
				]);
				expect(agentBehaviorRecord).toHaveBeenCalledWith("read", filePath);
			} finally {
				env.cleanup();
			}
		});

		// Recurrence: the live twin of #4185 round 1 F1, found by the model
		// (`formal/read-guard` FailedReadLive). The capture a read's tool_call
		// records was that read's only record when the host errored, and alone
		// it satisfied the zero-read check for an oldText edit.
		it("drops the capture of a read that errored, so an oldText edit of unseen lines is refused", async () => {
			const env = setupTestEnvironment("pi-lens-failed-read-capture-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"short.ts",
					"export const value = 1;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const input = { path: "short.ts", offset: 999 };
				await runHandlerExpectingNoThrow(() =>
					handleToolCall(
						callDeps(runtime, { toolName: "read", toolCallId: "r1", input }),
					),
				);
				expect(runtime.readGuard.getReadHistory(filePath)).toEqual([
					expect.objectContaining({ provisional: true }),
				]);
				const failed = await createReadToolDefinition(env.tmpDir)
					.execute("r1", input, undefined, undefined, {
						cwd: env.tmpDir,
					} as never)
					.then(
						(result) => ({ content: result.content, isError: false }),
						(error: Error) => ({
							content: [{ type: "text", text: error.message }],
							isError: true,
						}),
					);
				expect(failed.isError).toBe(true);
				await handleToolResult(
					resultDeps(runtime, {
						toolName: "read",
						toolCallId: "r1",
						isError: true,
						input,
						content: failed.content,
					}),
				);
				// pi-lens's own tool_result already released the capture (R4-1);
				// the tool_execution_end pi emits after every handler finds nothing
				// left to release. The end-only release (a blocked read, which has
				// no tool_result) is the "read blocked after its capture" suite.
				expect(
					handleToolExecutionEnd(
						{ toolName: "read", toolCallId: "r1", isError: true },
						runtime.readGuard,
					),
				).toBe(false);
				expect(runtime.readGuard.getReadHistory(filePath)).toEqual([]);
				expect(
					runtime.readGuard.checkEdit(filePath, [1, 1], undefined, {
						skipSnapshotCheck: true,
						oldTextResolved: true,
					}),
				).toMatchObject({ action: "block" });
			} finally {
				env.cleanup();
			}
		});

		// Recurrence: #4185 round 4 R4-1. The tool_execution_end release reads
		// pi's FINAL isError, after every extension's tool_result hook. A later
		// extension that rewrote a failed read into {isError:false} left the
		// capture alive. pi-lens's own handler saw the failure, so it drops the
		// capture there, by call id; the end event below carries the rewritten
		// isError:false exactly as pi emits it.
		it("drops a failed read's capture at its own tool_result, before a later extension rewrites the result to success", async () => {
			const env = setupTestEnvironment("pi-lens-rewritten-read-capture-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"short.ts",
					"export const value = 1;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const input = { path: "short.ts", offset: 999 };
				await runHandlerExpectingNoThrow(() =>
					handleToolCall(
						callDeps(runtime, { toolName: "read", toolCallId: "r1", input }),
					),
				);
				expect(runtime.readGuard.getReadHistory(filePath)).toEqual([
					expect.objectContaining({ provisional: true }),
				]);
				await handleToolResult(
					resultDeps(runtime, {
						toolName: "read",
						toolCallId: "r1",
						isError: true,
						input,
						content: [{ type: "text", text: "offset beyond end of file" }],
					}),
				);
				// A later extension now returns {isError:false}; pi's end event
				// reports the rewritten value, so this release is a no-op.
				expect(
					handleToolExecutionEnd(
						{ toolName: "read", toolCallId: "r1", isError: false },
						runtime.readGuard,
					),
				).toBe(false);
				expect(runtime.readGuard.getReadHistory(filePath)).toEqual([]);
				expect(
					runtime.readGuard.checkEdit(filePath, [1, 1], undefined, {
						skipSnapshotCheck: true,
						oldTextResolved: true,
					}),
				).toMatchObject({ action: "block" });
			} finally {
				env.cleanup();
			}
		});

		it.each(["@a.ts", "~/proj/a.ts"])(
			"releases a failed read's capture whatever path spelling its result carries, %s (#4185 R2-1)",
			async (resultSpelling) => {
				const env = setupTestEnvironment("pi-lens-failed-read-spelling-");
				try {
					const filePath = createTempFile(
						env.tmpDir,
						"a.ts",
						"export const value = 1;\n",
					);
					const runtime = new RuntimeCoordinator();
					runtime.projectRoot = env.tmpDir;
					await runHandlerExpectingNoThrow(() =>
						handleToolCall(
							callDeps(runtime, {
								toolName: "read",
								toolCallId: `failed-${resultSpelling}`,
								input: { path: filePath, offset: 999 },
							}),
						),
					);
					expect(runtime.readGuard.getReadHistory(filePath)).toEqual([
						expect.objectContaining({ provisional: true }),
					]);
					await handleToolResult(
						resultDeps(runtime, {
							toolName: "read",
							toolCallId: `failed-${resultSpelling}`,
							isError: true,
							input: { path: resultSpelling, offset: 999 },
							content: [{ type: "text", text: "failed" }],
						}),
					);
					// The release is keyed by the call, never by the result's
					// spelling (round 2 re-derived the path and missed both).
					handleToolExecutionEnd(
						{
							toolName: "read",
							toolCallId: `failed-${resultSpelling}`,
							isError: true,
						},
						runtime.readGuard,
					);
					expect(runtime.readGuard.getReadHistory(filePath)).toEqual([]);
				} finally {
					env.cleanup();
				}
			},
		);

		// #4185 round 3 R3-2: a later extension blocks a read pi-lens already
		// captured; pi emits tool_execution_end (isError) and no tool_result.
		// Round 3 released the capture only at agent_settled, so an oldText edit
		// later in the SAME run, top-level or nested, was applied on lines the
		// agent never saw. The real-pi twin is
		// tests/real-harness/read-guard-moves.test.ts.
		describe("a read blocked after its capture (#4185 R3-2)", () => {
			const oldTextEdit = (toolCallId: string, parentToolCallId?: string) => ({
				toolName: "edit",
				toolCallId,
				...(parentToolCallId !== undefined && { parentToolCallId }),
				input: {
					path: "blocked.ts",
					oldText: "export const value = 1;",
					newText: "export const value = 2;",
				},
			});
			it.each([
				["top-level", "r-blocked", undefined],
				["nested", "codemode-b/1", "codemode-b"],
			] as const)(
				"refuses a %s oldText edit in the same run once the blocked read's call ended",
				async (_shape, readId, parentId) => {
					const env = setupTestEnvironment("pi-lens-blocked-read-end-");
					try {
						const filePath = createTempFile(
							env.tmpDir,
							"blocked.ts",
							"export const value = 1;\n",
						);
						const runtime = new RuntimeCoordinator();
						runtime.projectRoot = env.tmpDir;
						const parent =
							parentId !== undefined ? { parentToolCallId: parentId } : {};
						await runHandlerExpectingNoThrow(() =>
							handleToolCall(
								callDeps(runtime, {
									toolName: "read",
									toolCallId: readId,
									...parent,
									input: { path: "blocked.ts" },
								}),
							),
						);
						expect(runtime.readGuard.getReadHistory(filePath)).toEqual([
							expect.objectContaining({ provisional: true }),
						]);
						// pi's agent loop: the later extension's block is an
						// "immediate" result, emitted as tool_execution_end only.
						handleToolExecutionEnd(
							{
								type: "tool_execution_end",
								toolName: "read",
								toolCallId: readId,
								...parent,
								isError: true,
								result: {
									content: [{ type: "text", text: "blocked" }],
								},
							},
							runtime.readGuard,
						);
						const verdict = await runHandlerExpectingNoThrow(() =>
							handleToolCall(
								callDeps(runtime, oldTextEdit("e-blocked/1", parentId)),
							),
						);
						expect(verdict).toMatchObject({
							block: true,
							reason: expect.stringContaining("Edit without read"),
						});
					} finally {
						env.cleanup();
					}
				},
			);

			// The other direction: a successful call's end never takes its read's
			// evidence. pi bounds the read tool_result handler (500 ms,
			// HOOK_WALL_BUDGET_MS.tool_result_read_only) and emits
			// tool_execution_end without waiting for a handler past it, so the
			// capture can still be the read's only record at that point.
			it("keeps the capture when the call ended in success before its record landed", async () => {
				const env = setupTestEnvironment("pi-lens-read-end-success-");
				try {
					const filePath = createTempFile(
						env.tmpDir,
						"blocked.ts",
						"export const value = 1;\n",
					);
					const runtime = new RuntimeCoordinator();
					runtime.projectRoot = env.tmpDir;
					await runHandlerExpectingNoThrow(() =>
						handleToolCall(
							callDeps(runtime, {
								toolName: "read",
								toolCallId: "r-slow",
								input: { path: "blocked.ts" },
							}),
						),
					);
					expect(
						handleToolExecutionEnd(
							{ toolName: "read", toolCallId: "r-slow", isError: false },
							runtime.readGuard,
						),
					).toBe(false);
					expect(runtime.readGuard.getReadHistory(filePath)).toEqual([
						expect.objectContaining({
							provisional: true,
							source: "native-read:r-slow:provisional",
						}),
					]);
					const verdict = await runHandlerExpectingNoThrow(() =>
						handleToolCall(callDeps(runtime, oldTextEdit("e-slow"))),
					);
					expect(verdict).not.toMatchObject({ block: true });
				} finally {
					env.cleanup();
				}
			});
		});

		it("uses the parent transcript identity for a nested write creation read (#4185 R2-2)", async () => {
			const env = setupTestEnvironment("pi-lens-nested-write-creation-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"created.ts",
					"export const value = 1;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				await runHandlerExpectingNoThrow(() =>
					handleToolCall(
						callDeps(runtime, {
							toolName: "write",
							toolCallId: "codemode-write/1",
							parentToolCallId: "codemode-write",
							input: { path: filePath, content: "export const value = 2;\n" },
						}),
					),
				);
				await handleToolResult(
					resultDeps(runtime, {
						toolName: "write",
						toolCallId: "codemode-write/1",
						parentToolCallId: "codemode-write",
						input: { path: filePath, content: "export const value = 2;\n" },
						content: [{ type: "text", text: "written" }],
					}),
				);
				expect(runtime.readGuard.getReadHistory(filePath)).toEqual([
					expect.objectContaining({ toolCallId: "codemode-write" }),
				]);
			} finally {
				env.cleanup();
			}
		});

		it("records a nested bash view span under the parent's transcript identity", async () => {
			const env = setupTestEnvironment("pi-lens-nested-bash-view-");
			try {
				const filePath = path.join(env.tmpDir, "sample.ts");
				fs.writeFileSync(filePath, "one\ntwo\nthree\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const recordRead = vi.spyOn(runtime.readGuard, "recordRead");
				await handleToolResult(
					resultDeps(runtime, {
						toolName: "bash",
						toolCallId: "codemode-1/1",
						parentToolCallId: "codemode-1",
						input: { command: `cat ${filePath}` },
						content: [{ type: "text", text: "one\ntwo\nthree" }],
					}),
				);
				expect(recordRead).toHaveBeenCalledWith(
					expect.objectContaining({
						filePath,
						effectiveOffset: 1,
						toolCallId: "codemode-1",
					}),
				);
			} finally {
				env.cleanup();
			}
		});

		it("records a nested bash grep search read under the parent's transcript identity", async () => {
			const env = setupTestEnvironment("pi-lens-nested-grep-read-");
			try {
				const filePath = path.join(env.tmpDir, "sample.ts");
				fs.writeFileSync(
					filePath,
					Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"),
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				const recordRead = vi.spyOn(runtime.readGuard, "recordRead");
				await handleToolResult(
					resultDeps(runtime, {
						toolName: "bash",
						toolCallId: "codemode-1/1",
						parentToolCallId: "codemode-1",
						input: { command: `grep -n line9 ${filePath}` },
						details: {},
						content: [{ type: "text", text: "9:line9" }],
					}),
				);
				expect(recordRead).toHaveBeenCalledWith(
					expect.objectContaining({
						filePath,
						effectiveOffset: 9,
						effectiveLimit: 1,
						toolCallId: "codemode-1",
					}),
					// #1649: hashed from the file's one pass, not re-captured.
					{ captureLineHashes: false },
				);
			} finally {
				env.cleanup();
			}
		});

		it("records a nested own-edit's evidence under the parent's transcript identity", async () => {
			const env = setupTestEnvironment("pi-lens-nested-own-edit-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"nested.ts",
					"export const value = 1;\nexport const other = 2;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				await nestedRead(runtime, filePath);
				const recordRead = vi.spyOn(runtime.readGuard, "recordRead");
				const input = {
					path: filePath,
					edits: [
						{
							range: { start: { line: 1 }, end: { line: 1 } },
							newText: "export const value = 2;",
						},
					],
				};
				const verdict = await runHandlerExpectingNoThrow(() =>
					handleToolCall(
						callDeps(runtime, {
							toolName: "edit",
							toolCallId: "codemode-1/2",
							parentToolCallId: "codemode-1",
							input,
						}),
					),
				);
				expect(verdict).not.toMatchObject({ block: true });
				fs.writeFileSync(
					filePath,
					"export const value = 2;\nexport const other = 2;\n",
				);
				await handleToolResult(
					resultDeps(runtime, {
						toolName: "edit",
						toolCallId: "codemode-1/2",
						parentToolCallId: "codemode-1",
						input,
						content: [{ type: "text", text: "ok" }],
					}),
				);
				expect(recordRead).toHaveBeenCalledWith(
					expect.objectContaining({
						filePath,
						source: "own-edit",
						effectiveOffset: 1,
						toolCallId: "codemode-1",
					}),
					expect.anything(),
				);
			} finally {
				env.cleanup();
			}
		});
	});

	it("registers only the lines shown by the real bash host cap", async () => {
		resetDegradationLedger();
		const env = setupTestEnvironment("pi-lens-2802-bash-cap-");
		try {
			const filePath = path.join(env.tmpDir, "large.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 3000 }, (_, i) => `line${i + 1}`).join("\n") +
					"\n",
			);
			// This case RUNS the command in the real bash host, where an unquoted
			// backslash path (`C:\Users\...`) loses its separators and `cat` reads
			// nothing: the 3000-line file was then registered whole (#4019).
			const shellPath = toPosix(filePath);
			const bashTool = createBashToolDefinition(env.tmpDir, {
				exposeSessionEnvironment: false,
			});
			const result = await bashTool.execute(
				"2802",
				{ command: `cat ${shellPath}` },
				undefined,
				undefined,
				{ cwd: env.tmpDir } as never,
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const recordRead = vi.spyOn(runtime.readGuard, "recordRead");

			await handleToolResult({
				event: {
					toolName: "bash",
					input: { command: `cat ${shellPath}` },
					content: result.content,
					details: result.details,
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as never);

			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({
					// The spelling the command carried (forward slashes above).
					filePath: shellPath,
					effectiveOffset: 1001,
					effectiveLimit: 2000,
				}),
			);
			expect(runtime.readGuard.checkEdit(filePath, [500, 500]).action).toBe(
				"block",
			);
			expect(
				getDegradationSummary().some(
					(entry) => entry.kind === "bash-view-clipped",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a pipe-filtered short output on the full source span", async () => {
		const env = setupTestEnvironment("pi-lens-2802-pipe-fallback-");
		try {
			const filePath = path.join(env.tmpDir, "pipe.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 50 }, (_, i) =>
					i === 30 ? "MATCHME" : `line${i + 1}`,
				).join("\n") + "\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await handleToolResult({
				event: {
					toolName: "bash",
					input: { command: `cat ${filePath} | grep MATCHME` },
					content: [{ type: "text", text: "MATCHME" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			expect(runtime.readGuard.checkEdit(filePath, [3, 3]).action).toBe(
				"allow",
			);
			expect(runtime.readGuard.checkEdit(filePath, [31, 31]).action).toBe(
				"allow",
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not mark a content-identical opaque rewrite as authored", async () => {
		const env = setupTestEnvironment("pi-lens-2802-opaque-noop-");
		try {
			const filePath = path.join(env.tmpDir, "unchanged.ts");
			fs.writeFileSync(filePath, "NEVER_PRESENT\n", "utf8");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			// Run for real by the bash host below: a forward-slash path survives
			// bash on Windows, a backslash one does not (#4019).
			const command = `sed -i 's/ABSENT_VALUE/x/' ${toPosix(filePath)}`;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolName: "bash",
						toolCallId: "2802-noop",
						input: { command },
					},
					ctx: { cwd: env.tmpDir },
					lensEnabled: true,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);
			const bashTool = createBashToolDefinition(env.tmpDir, {
				exposeSessionEnvironment: false,
			});
			const result = await bashTool.execute(
				"2802-noop",
				{ command },
				undefined,
				undefined,
				{ cwd: env.tmpDir } as never,
			);
			await handleToolResult({
				event: {
					toolName: "bash",
					toolCallId: "2802-noop",
					input: { command },
					content: result.content,
					details: result.details,
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			expect(runtime.readGuard.checkEdit(filePath, [1, 1]).action).toBe(
				"block",
			);
		} finally {
			env.cleanup();
		}
	});

	it("blocks a recognized bash write when observation evidence is unavailable", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-2802-unknown-authorship-");
		try {
			vi.mocked(runPipeline).mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				checkedClean: false,
			});
			const filePath = path.join(env.tmpDir, "unknown.ts");
			fs.writeFileSync(filePath, "const a = 1;\n", "utf8");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const command = `sed -i 's/const a = 1;/const a = 9;/' ${filePath}`;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolName: "bash",
						toolCallId: "2802-unknown-authorship",
						input: { command },
					},
					ctx: { cwd: env.tmpDir },
					lensEnabled: true,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);
			const bashTool = createBashToolDefinition(env.tmpDir, {
				exposeSessionEnvironment: false,
			});
			const result = await bashTool.execute(
				"2802-unknown-authorship",
				{ command },
				undefined,
				undefined,
				{ cwd: env.tmpDir } as never,
			);
			await handleToolResult({
				event: {
					toolName: "bash",
					toolCallId: "2802-unknown-authorship",
					input: { command },
					content: result.content,
					details: result.details,
				},
				_opaqueCaptureOptions: { forcedUnknownReason: "walk-failed" },
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			expect(runtime.readGuard.checkEdit(filePath, [1, 1]).action).toBe(
				"block",
			);
		} finally {
			env.cleanup();
		}
	});

	it("blocks every span when a multi-span bash view is clipped", async () => {
		resetDegradationLedger();
		const env = setupTestEnvironment("pi-lens-2802-multi-span-clip-");
		try {
			const paths = ["one.ts", "two.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const filePath of paths)
				fs.writeFileSync(
					filePath,
					Array.from({ length: 3000 }, (_, i) => `line${i}`).join("\n") + "\n",
				);
			for (const filePath of paths)
				fs.utimesSync(filePath, new Date(0), new Date(0));
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await handleToolResult({
				event: {
					toolName: "bash",
					input: { command: `cat ${paths[0]}; cat ${paths[1]}` },
					content: [{ type: "text", text: "output" }],
					details: { truncation: { truncated: true, outputLines: 2000 } },
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			for (const filePath of paths)
				expect(runtime.readGuard.checkEdit(filePath, [1, 1]).action).toBe(
					"block",
				);
			expect(
				getDegradationSummary().some(
					(entry) => entry.kind === "bash-view-clipped",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("invalidates formatter selection through handleToolResult", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		const env = setupTestEnvironment("pi-lens-1603-tool-result-");
		try {
			const filePath = path.join(env.tmpDir, "init.lua");
			const configPath = path.join(env.tmpDir, "stylua.toml");
			expect(await getFormattersForFile(filePath, env.tmpDir)).toEqual([]);
			fs.writeFileSync(configPath, "column_width = 100\n");
			expect(await getFormattersForFile(filePath, env.tmpDir)).toEqual([]);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await handleToolResult({
				event: {
					toolName: "write",
					input: { path: configPath },
					content: [{ type: "text", text: "written" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(
				(await getFormattersForFile(filePath, env.tmpDir)).map((f) => f.name),
			).toEqual(["stylua"]);
		} finally {
			clearFormatterRuntimeState();
			env.cleanup();
		}
	});

	it("invalidates a warm formatter selection after an in-place config rewrite", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		const env = setupTestEnvironment("pi-lens-1603-rewrite-");
		try {
			const filePath = path.join(env.tmpDir, "init.lua");
			const configPath = path.join(env.tmpDir, "stylua.toml");
			fs.writeFileSync(configPath, "column_width = 100\n");

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const deps = {
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any;

			expect(
				(await getFormattersForFile(filePath, env.tmpDir)).map((f) => f.name),
			).toEqual(["stylua"]);
			readdirMock.mockClear();
			expect(
				(await getFormattersForFile(filePath, env.tmpDir)).map((f) => f.name),
			).toEqual(["stylua"]);
			expect(readdirMock).not.toHaveBeenCalled();

			// Keep the same path and file name. Only the contents change in place.
			fs.writeFileSync(configPath, "column_width = 120\n");
			await handleToolResult({
				...deps,
				event: {
					toolName: "write",
					input: { path: configPath },
					content: [{ type: "text", text: "rewritten" }],
				},
			});

			readdirMock.mockClear();
			expect(
				(await getFormattersForFile(filePath, env.tmpDir)).map((f) => f.name),
			).toEqual(["stylua"]);
			// A warm stale entry would return above without walking ancestors.
			expect(readdirMock.mock.calls.length).toBeGreaterThan(0);
		} finally {
			clearFormatterRuntimeState();
			env.cleanup();
		}
	});

	it("invalidates formatter selection for config removal and changedFiles side effects", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		const env = setupTestEnvironment("pi-lens-1603-removal-");
		try {
			const filePath = path.join(env.tmpDir, "init.lua");
			const sourcePath = path.join(env.tmpDir, "source.ts");
			const configPath = path.join(env.tmpDir, "stylua.toml");
			fs.writeFileSync(sourcePath, "const value = 1;\n");
			fs.writeFileSync(configPath, "column_width = 100\n");

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const deps = {
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any;

			await handleToolResult({
				...deps,
				event: {
					toolName: "write",
					input: { path: configPath },
					content: [{ type: "text", text: "written" }],
				},
			});
			expect(
				(await getFormattersForFile(filePath, env.tmpDir)).map((f) => f.name),
			).toEqual(["stylua"]);

			fs.rmSync(configPath);
			await handleToolResult({
				...deps,
				event: {
					toolName: "write",
					input: { path: configPath },
					content: [{ type: "text", text: "removed" }],
				},
			});
			expect(await getFormattersForFile(filePath, env.tmpDir)).toEqual([]);

			fs.writeFileSync(configPath, "column_width = 120\n");
			await handleToolResult({
				...deps,
				event: {
					toolName: "write",
					input: { path: configPath },
					content: [{ type: "text", text: "written" }],
				},
			});
			expect(
				(await getFormattersForFile(filePath, env.tmpDir)).map((f) => f.name),
			).toEqual(["stylua"]);

			fs.rmSync(configPath);
			vi.mocked(runPipeline).mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				checkedClean: false,
				changedFiles: [configPath],
			});
			await handleToolResult({
				...deps,
				event: {
					toolName: "write",
					input: { path: sourcePath },
					content: [{ type: "text", text: "source changed" }],
				},
			});
			expect(await getFormattersForFile(filePath, env.tmpDir)).toEqual([]);
		} finally {
			clearFormatterRuntimeState();
			env.cleanup();
		}
	});

	it("invalidates the ignore matcher through handleToolResult", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		const env = setupTestEnvironment("pi-lens-2071-tool-result-");
		try {
			const nested = path.join(env.tmpDir, "packages", "app");
			fs.mkdirSync(nested, { recursive: true });
			const ignoredPath = path.join(nested, "generated.ts");
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "generated.ts\n");
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(ignoredPath)).toBe(true);

			fs.writeFileSync(ignorePath, "!generated.ts\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await handleToolResult({
				event: {
					toolName: "write",
					input: { path: ignorePath },
					content: [{ type: "text", text: "written" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(matcher.isIgnored(ignoredPath)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("registers bash reads only from a successful tool result", async () => {
		const env = setupTestEnvironment("pi-lens-bash-read-result-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "one\ntwo\nthree\n");
			const recordRead = vi.fn();
			const base = {
				getFlag: () => false,
				dbg: () => {},
				runtime: Object.assign(new RuntimeCoordinator(), {
					projectRoot: env.tmpDir,
				}),
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				readGuard: { recordRead },
			} as any;
			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					input: { command: `cat ${filePath}` },
					content: [{ type: "text", text: "one\\ntwo\\nthree" }],
				},
			});
			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({ filePath, effectiveOffset: 1 }),
			);
			recordRead.mockClear();
			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					isError: true,
					input: { command: `cat ${filePath}` },
					content: [{ type: "text", text: "permission denied" }],
				},
			});
			expect(recordRead).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("does not register grep output from a failed bash result", async () => {
		const env = setupTestEnvironment("pi-lens-bash-failed-grep-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "one\ntwo\nthree\n");
			const recordRead = vi.fn();
			const base = {
				getFlag: () => false,
				dbg: () => {},
				runtime: Object.assign(new RuntimeCoordinator(), {
					projectRoot: env.tmpDir,
				}),
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				readGuard: { recordRead },
			} as any;
			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					isError: true,
					input: { command: `grep -n two ${filePath}; false` },
					content: [{ type: "text", text: `${filePath}:2:two` }],
				},
			});
			expect(recordRead).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("does not record or deliver a failed native edit result", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockClear();
		const env = setupTestEnvironment("pi-lens-native-edit-failed-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const result = await handleToolResult({
				event: {
					toolName: "edit",
					isError: true,
					input: {
						path: filePath,
						edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
					},
					content: [{ type: "text", text: "edit failed" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			expect(result).toMatchObject({ isError: true });
			expect(
				runtime.partialApplyRecords.find(
					filePath,
					"const a = 1;",
					"const a = 2;",
				),
			).toBeUndefined();
			expect(readChangesSince(env.tmpDir, 0)).toEqual([]);
			expect(runPipeline).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("hashes a native multi-edit result once for all applied records", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		const env = setupTestEnvironment("pi-lens-native-edit-hash-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const afterWriteSpy = vi.spyOn(
				runtime.partialApplyRecords,
				"noteAfterWriteHash",
			);
			readFileSyncSpy.mockClear();
			await handleToolResult({
				event: {
					toolName: "edit",
					input: {
						path: filePath,
						edits: [
							{ oldText: "const a = 1;", newText: "const a = 10;" },
							{ oldText: "const b = 2;", newText: "const b = 20;" },
							{ oldText: "const c = 3;", newText: "const c = 30;" },
						],
					},
					content: [],
				},
				_bypassDebounce: true,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			const rawHashReads = readFileSyncSpy.mock.calls.filter(
				(args) => args.length === 1,
			);
			// One raw-byte hash is enough when the pipeline reports no write: the
			// post-write identity is also the state the pipeline analysed. This
			// prevents #2499's parked-pipeline latch from quoting later disk bytes.
			expect(rawHashReads).toHaveLength(1);
			expect(afterWriteSpy).not.toHaveBeenCalled();
			const records = [
				runtime.partialApplyRecords.find(
					filePath,
					"const a = 1;",
					"const a = 10;",
				),
				runtime.partialApplyRecords.find(
					filePath,
					"const b = 2;",
					"const b = 20;",
				),
				runtime.partialApplyRecords.find(
					filePath,
					"const c = 3;",
					"const c = 30;",
				),
			];
			expect(
				records.every(
					(record) => record?.contentHash === records[0]?.contentHash,
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("records grep -n output lines as read-guard search reads", async () => {
		const env = setupTestEnvironment("pi-lens-grep-search-reads-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"),
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			const recordRead = vi.fn();

			await handleToolResult({
				event: {
					toolName: "bash",
					input: { command: `grep -n line9 ${filePath}` },
					details: {},
					content: [{ type: "text", text: "9:line9" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				readGuard: { recordRead },
			} as any);

			// #1904 item 2: a bare `grep -n` shows ONE line, so credit one line.
			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath,
					effectiveOffset: 9,
					effectiveLimit: 1,
					searchCredit: {
						marginBefore: 0,
						marginAfter: 0,
						reason: "match-lines-only",
					},
				}),
				// #1649: hashed from the file's one pass, not re-captured.
				{ captureLineHashes: false },
			);
		} finally {
			env.cleanup();
		}
	});

	it("credits the context lines a grep -C actually printed", async () => {
		const env = setupTestEnvironment("pi-lens-grep-context-credit-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			const sampleLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
			fs.writeFileSync(filePath, sampleLines.join("\n"));
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			const recordRead = vi.fn();

			await handleToolResult({
				event: {
					toolName: "bash",
					input: { command: `grep -n -C2 line9 ${filePath}` },
					details: {},
					content: [{ type: "text", text: "9:line9" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				readGuard: { recordRead },
			} as any);

			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath,
					effectiveOffset: 7,
					effectiveLimit: 5,
					searchCredit: {
						marginBefore: 2,
						marginAfter: 2,
						reason: "delivered-context-flags",
					},
				}),
				// #1649: hashed from the file's one pass, not re-captured.
				{ captureLineHashes: false },
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("bash external-delete detection (#1668)", () => {
	beforeEach(() => {
		notifyExternalFileChange.mockClear();
	});

	function makeBase(
		env: { tmpDir: string },
		readGuardOverrides: Record<string, unknown> = {},
	) {
		return {
			getFlag: () => false,
			dbg: () => {},
			runtime: Object.assign(new RuntimeCoordinator(), {
				projectRoot: env.tmpDir,
			}),
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
			readGuard: {
				recordRead: vi.fn(),
				recordWritten: vi.fn(),
				hasKnownPath: vi.fn(() => true),
				forgetPath: vi.fn(),
				...readGuardOverrides,
			},
		} as any;
	}

	it("a known path that is actually gone after `rm` gets a type-3 notify and is forgotten", async () => {
		const env = setupTestEnvironment("pi-lens-bash-rm-known-");
		try {
			const filePath = path.join(env.tmpDir, "gone.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const base = makeBase(env);

			// Simulate the delete actually landing on disk (the command itself
			// isn't executed by this test — handleToolResult only parses it).
			fs.rmSync(filePath);

			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					input: { command: `rm ${filePath}` },
					content: [{ type: "text", text: "" }],
				},
			});

			expect(notifyExternalFileChange).toHaveBeenCalledTimes(1);
			expect(notifyExternalFileChange).toHaveBeenCalledWith(filePath, 3);
			expect(base.readGuard.forgetPath).toHaveBeenCalledWith(filePath);
		} finally {
			env.cleanup();
		}
	});

	it("a path pi-lens never knew about is NOT notified even if it's gone", async () => {
		const env = setupTestEnvironment("pi-lens-bash-rm-unknown-");
		try {
			const filePath = path.join(env.tmpDir, "gone.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			fs.rmSync(filePath);
			const base = makeBase(env, { hasKnownPath: vi.fn(() => false) });

			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					input: { command: `rm ${filePath}` },
					content: [{ type: "text", text: "" }],
				},
			});

			expect(notifyExternalFileChange).not.toHaveBeenCalled();
			expect(base.readGuard.forgetPath).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("a known path that still exists (rm failed / no-op) is NOT notified", async () => {
		const env = setupTestEnvironment("pi-lens-bash-rm-noop-");
		try {
			const filePath = path.join(env.tmpDir, "still-here.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const base = makeBase(env);

			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					input: { command: `rm ${filePath}` },
					content: [{ type: "text", text: "" }],
				},
			});

			expect(notifyExternalFileChange).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("a failed bash tool result is NOT treated as a real delete", async () => {
		const env = setupTestEnvironment("pi-lens-bash-rm-failed-");
		try {
			const filePath = path.join(env.tmpDir, "gone.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			fs.rmSync(filePath);
			const base = makeBase(env);

			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					isError: true,
					input: { command: `rm ${filePath}` },
					content: [{ type: "text", text: "rm: permission denied" }],
				},
			});

			expect(notifyExternalFileChange).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("a burst of deletes in one command notifies once per confirmed-gone known file", async () => {
		const env = setupTestEnvironment("pi-lens-bash-rm-burst-");
		try {
			const files = ["a.ts", "b.ts", "c.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const f of files) fs.writeFileSync(f, "export const x = 1;\n");
			for (const f of files) fs.rmSync(f);
			const base = makeBase(env);

			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					input: { command: `rm ${files.join(" ")}` },
					content: [{ type: "text", text: "" }],
				},
			});

			expect(notifyExternalFileChange).toHaveBeenCalledTimes(files.length);
			for (const f of files) {
				expect(notifyExternalFileChange).toHaveBeenCalledWith(f, 3);
			}
		} finally {
			env.cleanup();
		}
	});

	it("respects --no-lsp: no external-delete notification is sent", async () => {
		const env = setupTestEnvironment("pi-lens-bash-rm-no-lsp-");
		try {
			const filePath = path.join(env.tmpDir, "gone.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			fs.rmSync(filePath);
			const base = makeBase(env);
			base.getFlag = (name: string) => name === "no-lsp";

			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					input: { command: `rm ${filePath}` },
					content: [{ type: "text", text: "" }],
				},
			});

			expect(notifyExternalFileChange).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});

describe("monorepo turn-state cwd alignment", () => {
	beforeEach(async () => {
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
	});

	it("writes turn state under workspace root, not the nested language root", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});

		const env = setupTestEnvironment("pi-lens-monorepo-cwd-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			// Simulate a monorepo: workspace root with a nested Go module
			const workspaceRoot = path.join(env.tmpDir, "workspace");
			const goModuleDir = path.join(
				workspaceRoot,
				"platform",
				"svc",
				"go",
				"daemon",
			);
			const filePath = path.join(goModuleDir, "main.go");
			fs.mkdirSync(goModuleDir, { recursive: true });
			fs.writeFileSync(
				path.join(goModuleDir, "go.mod"),
				"module daemon\n\ngo 1.22\n",
			);
			fs.writeFileSync(filePath, "package main\n\nfunc main() {}\n");

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = workspaceRoot;
			runtime.setTelemetryIdentity({ sessionId: "monorepo-session" });
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 package main" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			// Turn state must be readable from the workspace root — this is
			// the cwd that turn_end uses. Before the fix, the state was
			// written under the Go module root instead, causing turn_end to
			// see an empty files map and skip the actionable-warnings phase.
			const turnState = cacheManager.readTurnState(workspaceRoot);
			const files = Object.keys(turnState.files);
			expect(files.length).toBeGreaterThan(0);
			expect(files[0]).toContain("main.go");

			// The language root's turn state should NOT have the file —
			// all turn state belongs under the workspace root.
			const langRootState = cacheManager.readTurnState(goModuleDir);
			expect(Object.keys(langRootState.files).length).toBe(0);

			// Project sequence/change-log bookkeeping is also workspace-scoped.
			expect(readChangesSince(workspaceRoot, 0)).toMatchObject([
				{ source: "agent-edit", filePath },
			]);
			expect(readChangesSince(goModuleDir, 0)).toEqual([]);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("still dispatches pipeline to the language root for linting", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});

		const env = setupTestEnvironment("pi-lens-monorepo-dispatch-");
		try {
			const workspaceRoot = path.join(env.tmpDir, "workspace");
			const goModuleDir = path.join(
				workspaceRoot,
				"platform",
				"svc",
				"go",
				"daemon",
			);
			const filePath = path.join(goModuleDir, "main.go");
			fs.mkdirSync(goModuleDir, { recursive: true });
			fs.writeFileSync(
				path.join(goModuleDir, "go.mod"),
				"module daemon\n\ngo 1.22\n",
			);
			fs.writeFileSync(filePath, "package main\n\nfunc main() {}\n");

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = workspaceRoot;
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 package main" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			// Pipeline must receive the language root (Go module dir) as cwd,
			// not the workspace root — linters need to run from there.
			expect(vi.mocked(runPipeline)).toHaveBeenCalledWith(
				expect.objectContaining({
					cwd: goModuleDir,
					filePath,
				}),
				expect.anything(),
			);
		} finally {
			env.cleanup();
		}
	});

	it("hands the pipeline the session generation current when it dispatches (#3512)", async () => {
		// The deferred cascade outlives this handler, and a session-1 compute
		// can record a tier-3 touch after a same-cwd replacement. Its record
		// site drops the touch through this handle, so the handle must name the
		// session the dispatch started in, not the one current at record time.
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		const env = setupTestEnvironment("pi-lens-3512-dispatch-generation-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"edit.ts",
				"export const x = 2;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.resetForSession();
			runtime.beginTurn();
			const dispatchGeneration = runtime.sessionGeneration;

			const dispatch = async (content: string) => {
				fs.writeFileSync(filePath, content);
				await handleToolResult({
					event: {
						toolName: "edit",
						input: { path: filePath },
						details: { diff: `+  1 ${content.trim()}` },
						content: [{ type: "text", text: "ok" }],
					},
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: {
						addModifiedRange: () => {},
						readTurnState: () => ({}),
					},
					biomeClient: {},
					ruffClient: {},
					testRunnerClient: {},
					metricsClient: {},
					resetLSPService: () => {},
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
				} as any);
				return vi.mocked(runPipeline).mock.calls.at(-1)?.[0].sessionGeneration;
			};

			const sessionOne = await dispatch("export const x = 2;\n");
			const currentAtDispatch = sessionOne?.isCurrent();
			// A same-cwd replacement; the next dispatch belongs to session 2.
			runtime.resetForSession();
			const sessionTwo = await dispatch("export const x = 3;\n");
			expect({
				generation: sessionOne?.generation,
				currentAtDispatch,
				currentAfterReplacement: sessionOne?.isCurrent(),
				sessionTwoCurrent: sessionTwo?.isCurrent(),
			}).toEqual({
				generation: dispatchGeneration,
				currentAtDispatch: true,
				currentAfterReplacement: false,
				sessionTwoCurrent: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it.each(["parked", "overflow"] as const)(
		"drops the cascade a session-1 handler admits after the replacement, %s (#3512 r1 B2)",
		async (path_) => {
			// index.ts' bound abandons this handler without cancelling it, and
			// pi's teardown aborts only the active run, so a handler whose
			// pipeline outlives turn end resumes after session 2's reset and
			// admits its compute. The admission must use the generation captured
			// when the handler dispatched, not one captured at admission.
			const { runPipeline } = await import("../../clients/pipeline.js");
			const entered = gatedPromise<void>();
			const release = gatedPromise<void>();
			const sessionOneRun = {
				filePath: "/proj/session-one.ts",
				origin: { projectSeq: 1, turnSeq: 1 },
				result: undefined,
				neighborCount: 1,
				diagnosticCount: 1,
			};
			vi.mocked(runPipeline).mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				return {
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					checkedClean: false,
					cascadePromise: Promise.resolve(sessionOneRun),
				};
			});
			resetDegradationLedger();
			const env = setupTestEnvironment("pi-lens-3512-late-admission-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"edit.ts",
					"export const x = 2;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.resetForSession();
				runtime.beginTurn();

				const handler = handleToolResult({
					event: {
						toolName: "edit",
						input: { path: filePath },
						details: { diff: "+  1 export const x = 2;" },
						content: [{ type: "text", text: "ok" }],
					},
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: {
						addModifiedRange: () => {},
						readTurnState: () => ({}),
					},
					biomeClient: {},
					ruffClient: {},
					testRunnerClient: {},
					metricsClient: {},
					resetLSPService: () => {},
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
				} as any);
				await entered.promise;

				// The replacement's reset lands while the pipeline is in flight.
				runtime.resetForSession();
				// Session 2's own computes: on the overflow row they fill the cap,
				// so the late admission takes the detached `.then` branch.
				const ownRuns = Array.from(
					{ length: path_ === "overflow" ? MAX_PENDING_CASCADE_RUNS : 1 },
					(_, i) => ({ ...sessionOneRun, filePath: `/proj/own-${i}.ts` }),
				);
				for (const own of ownRuns)
					runtime.appendCascadePromise(
						Promise.resolve(own),
						runtime.captureSessionGeneration(),
						own.filePath,
					);
				release.resolve();
				await handler;

				// Session 2's turn_end: everything is settled, so no wait elapses.
				await runtime.settleCascadeRuns(1_000, { trackTurnEndClock: true });
				const delivered = runtime
					.consumeCascadeRuns()
					.map((r) => r.filePath)
					.sort();
				const staleWrites =
					getDegradationSummary()
						.find((e) => e.kind === "generation-guard-stale-write")
						?.latestReasons.map((e) => e.subject) ?? [];
				console.log(
					`[LateAdmission ${path_}] delivered=${delivered.filter((f) => f.includes("session-one")).length ? JSON.stringify(delivered.filter((f) => f.includes("session-one"))) : "[]"} own=${delivered.length} staleWrites=${JSON.stringify(staleWrites.map((s) => s.replace(env.tmpDir, "<tmp>")))}`,
				);
				expect(delivered).toEqual(ownRuns.map((r) => r.filePath).sort());
				// Dropped at admission, under the edited file's subject: the
				// overflow `.then`, whose subject is the run's file, never sees it.
				expect(staleWrites).toContain(`runtime-session:${filePath}`);
				expect(staleWrites).not.toContain(
					`runtime-session:${sessionOneRun.filePath}`,
				);
			} finally {
				env.cleanup();
			}
		},
	);

	it("drops the cascade of a session-1 handler parked before its dispatch (#3568)", async () => {
		// The handler waits for the on-demand analysers before it dispatches.
		// A replacement lands during that wait; the dispatch that follows used
		// to capture session 2, so the admission guard (#3512) passed its
		// compute into session 2's turn end.
		const { runPipeline } = await import("../../clients/pipeline.js");
		const sessionOneRun = {
			filePath: "/proj/session-one-entry.ts",
			origin: { projectSeq: 1, turnSeq: 1 },
			result: undefined,
			neighborCount: 1,
			diagnosticCount: 1,
		};
		vi.mocked(runPipeline).mockImplementation(async () => ({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
			cascadePromise: Promise.resolve(sessionOneRun),
		}));
		const entered = gatedPromise<void>();
		const release = gatedPromise<void>();
		requestBootstrapClients.mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return { biomeClient: {}, ruffClient: {}, metricsClient: {} };
		});
		resetDegradationLedger();
		const env = setupTestEnvironment("pi-lens-3568-entry-cascade-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"edit.ts",
				"export const x = 2;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.resetForSession();
			runtime.beginTurn();
			const handler = handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 2;" },
					content: [{ type: "text", text: "ok" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				testRunnerClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			await entered.promise;
			runtime.resetForSession();
			runtime.beginTurn();
			release.resolve();
			await handler;
			await runtime.settleCascadeRuns(1_000, { trackTurnEndClock: true });
			expect(runtime.consumeCascadeRuns().map((r) => r.filePath)).toEqual([]);
			expect(
				getDegradationSummary()
					.find((e) => e.kind === "generation-guard-stale-write")
					?.latestReasons.map((e) => e.subject),
			).toContain(`runtime-session:${filePath}`);
		} finally {
			env.cleanup();
		}
	});

	it("a bash handler's synthetic writes carry the session its handler entered in (#3568)", async () => {
		// A multi-file bash result dispatches one synthetic handler per written
		// file, one after another. Each used to capture its own session at its
		// dispatch, after the parent's recovery awaits and the earlier synthetic
		// dispatches, so a replacement in between handed the later files
		// session 2's generation.
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-3568-bash-synthetic-");
		try {
			const first = gatedPromise<void>();
			const release = gatedPromise<void>();
			const handles: Array<{ generation: number; isCurrent(): boolean }> = [];
			vi.mocked(runPipeline).mockImplementation(async (ctx) => {
				handles.push(ctx.sessionGeneration as never);
				if (handles.length === 1) {
					first.resolve();
					await release.promise;
				}
				return {
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					checkedClean: false,
				};
			});
			const existingPath = createTempFile(
				env.tmpDir,
				"extracted/existing.js",
				"(function(){ return 1; })();\n",
			);
			const directPath = createTempFile(
				env.tmpDir,
				"direct.js",
				"const direct = 1;\n",
			);
			const command = `echo direct > "${directPath}"; node opaque-extractor.js`;
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const entered = runtime.sessionGeneration;
			const cacheManager = new CacheManager(false);
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolName: "bash",
						toolCallId: "3568-bash",
						input: { command },
					},
					ctx: { cwd: env.tmpDir },
					lensEnabled: true,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);
			fs.writeFileSync(existingPath, "(function(){ return 2; })();\n");
			fs.writeFileSync(directPath, "const direct = 2;\n");
			const handler = handleToolResult({
				event: {
					toolName: "bash",
					toolCallId: "3568-bash",
					input: { command },
					content: [{ type: "text", text: "extracted" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				readGuard: runtime.readGuard,
			} as any);
			await first.promise;
			// `/new` while the first written file is analysed.
			runtime.resetForSession();
			release.resolve();
			await handler;
			// #3596: the second file's synthetic call inherits the dead session,
			// so it is not dispatched at all.
			expect(
				handles.map((h) => ({
					generation: h.generation,
					current: h.isCurrent(),
				})),
			).toEqual([{ generation: entered, current: false }]);
			// #3763 item 1: the second file's write receipt resumed after the
			// replacement too. Session 2 edits that file, then writes it: a dead
			// receipt in session 2's turn would demote the write to deferred.
			expect(
				[directPath, existingPath].map((written) => {
					runtime.recordMutationToolReceipt(written, "edit");
					return runtime.recordMutationToolReceipt(written, "write")
						.autofixMode;
				}),
			).toEqual(["immediate", "immediate"]);
		} finally {
			env.cleanup();
		}
	});
});

// #3596 (S3 of #3609): the writers `handleToolResult` still ran after an
// upstream await against the LIVE coordinator. A handler abandoned by
// index.ts' bound resumes after a replacement's reset and wrote a session-1
// edit into session 2: a read-guard credit for a file session 2 never read
// (#3528's stale-allow shape), its ranges into session 2's turn-state
// worklist (#2504's shape), deferrals the drain then credits, the turn
// summary, and the git-guard cache.
describe("runtime-tool-result writers across a replacement (#3596)", () => {
	const LONG_AGO = new Date("2000-01-01T00:00:00Z");

	function toolResultDeps(args: {
		filePath: string;
		runtime: RuntimeCoordinator;
		cacheManager: CacheManager;
		flags?: string[];
	}) {
		return {
			event: {
				toolName: "edit",
				input: { path: args.filePath },
				details: { diff: "+  1 export const x = 2;" },
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: (name: string) => args.flags?.includes(name) ?? false,
			dbg: () => {},
			runtime: args.runtime,
			cacheManager: args.cacheManager,
			readGuard: args.runtime.readGuard,
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as any;
	}

	async function acrossReplacement(
		slug: string,
		body: (args: {
			tmpDir: string;
			filePath: string;
			runtime: RuntimeCoordinator;
			cacheManager: CacheManager;
		}) => Promise<void>,
	): Promise<void> {
		resetDegradationLedger();
		const env = setupTestEnvironment(`pi-lens-3596-${slug}-`);
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"edit.ts",
				"export const x = 2;\n",
			);
			// Aged, so only an explicit credit can make session 2 allow an edit.
			fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			await body({
				tmpDir: env.tmpDir,
				filePath,
				runtime,
				cacheManager: new CacheManager(false),
			});
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	}

	const turnFiles = (cacheManager: CacheManager, tmpDir: string) =>
		Object.keys(cacheManager.readTurnState(tmpDir).files ?? {}).map((f) =>
			path.basename(f),
		);

	it("a session-1 edit parked on its analysers credits nothing in session 2", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockReset();
		vi.mocked(runPipeline).mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		const entered = gatedPromise<void>();
		const release = gatedPromise<void>();
		requestBootstrapClients.mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return { biomeClient: {}, ruffClient: {}, metricsClient: {} };
		});
		await acrossReplacement(
			"parked",
			async ({ tmpDir, filePath, runtime, cacheManager }) => {
				const handler = handleToolResult(
					toolResultDeps({ filePath, runtime, cacheManager }),
				);
				await entered.promise;
				runtime.resetForSession();
				runtime.beginTurn();
				release.resolve();
				await handler;
				expect({
					verdict: runtime.readGuard.checkEdit(filePath, [1, 1]).action,
					turnFiles: turnFiles(cacheManager, tmpDir),
					dispatched: vi.mocked(runPipeline).mock.calls.length,
					// The edit did land on disk: the change log keeps it (I5).
					receipts: readChangesSince(tmpDir, 0).map((c) => c.filePath),
					falseBlocks: getDegradationSummary()
						.find((group) => group.kind === "session-scope-read-dropped")
						?.latestReasons.map((r) => r.subject),
				}).toEqual({
					verdict: "block",
					turnFiles: [],
					dispatched: 0,
					receipts: [filePath],
					falseBlocks: ["superseded:tool-result"],
				});
			},
		);
	});

	it("a session-1 pipeline settling after the replacement queues nothing in session 2", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const entered = gatedPromise<void>();
		const release = gatedPromise<void>();
		await acrossReplacement(
			"settled",
			async ({ tmpDir, filePath, runtime, cacheManager }) => {
				const sidePath = createTempFile(tmpDir, "side.ts", "export {};\n");
				vi.mocked(runPipeline).mockReset();
				vi.mocked(runPipeline).mockImplementation(async () => {
					entered.resolve();
					await release.promise;
					return {
						output: "",
						hasBlockers: false,
						isError: false,
						fileModified: false,
						changedFiles: [sidePath],
						diagnostics: [
							{
								filePath,
								tool: "eslint",
								rule: "no-unused-vars",
								severity: "warning",
								line: 1,
								message: "unused",
							},
						],
					} as never;
				});
				const handler = handleToolResult(
					toolResultDeps({
						filePath,
						runtime,
						cacheManager,
						flags: ["lens-turn-summary"],
					}),
				);
				await entered.promise;
				runtime.resetForSession();
				runtime.beginTurn();
				release.resolve();
				await handler;
				expect({
					queued: runtime.pendingDeferredFormatCount,
					sideInTurnState: turnFiles(cacheManager, tmpDir).includes("side.ts"),
					sideReceipt: readChangesSince(tmpDir, 0).some(
						(c) => c.filePath === sidePath && c.source === "autofix",
					),
					summaryEmpty: runtime.turnSummary.isEmpty(),
				}).toEqual({
					queued: 0,
					sideInTurnState: false,
					sideReceipt: true,
					summaryEmpty: true,
				});
			},
		);
	});

	it("a session-1 pipeline error leaves session 2's git-guard cache alone", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const entered = gatedPromise<void>();
		const release = gatedPromise<void>();
		vi.mocked(runPipeline).mockReset();
		vi.mocked(runPipeline).mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return {
				output: "pipeline failed",
				hasBlockers: false,
				isError: true,
				fileModified: false,
				checkedClean: false,
			};
		});
		await acrossReplacement(
			"git-guard",
			async ({ filePath, runtime, cacheManager }) => {
				const handler = handleToolResult(
					toolResultDeps({
						filePath,
						runtime,
						cacheManager,
						flags: ["lens-guard"],
					}),
				);
				await entered.promise;
				runtime.resetForSession();
				runtime.beginTurn();
				release.resolve();
				await handler;
				expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			},
		);
	});
	it(
		"a dispatch settling after the 10 s inner bound queues its withheld line for the calling scope while that session lives, and for no one after a replacement (#5108)",
		{ timeout: 40_000 },
		async () => {
			// RECURRENCE GUARDED: #5108 remainder. The bound abandons the dispatch, and
			// the continuation that hands its withheld line to the agent runs after an
			// await against the LIVE coordinator: without the #3596 liveness check, or
			// with the coordinator's own scope in place of the caller's (#473), the
			// line reaches the wrong session or a session that never wrote the file; an
			// Escape mid-check (a cancelled turn) must queue nothing at all.
			// The 10 s is the real bound, so this case holds a live 10 s wait.
			const { runPipeline } = await import("../../clients/pipeline.js");
			const settle = new Map<string, ReturnType<typeof gatedPromise<void>>>();
			const entered = new Map<string, ReturnType<typeof gatedPromise<void>>>();
			vi.mocked(runPipeline).mockReset();
			vi.mocked(runPipeline).mockImplementation((async (ctx: {
				filePath: string;
			}) => {
				const name = path.basename(ctx.filePath);
				entered.get(name)?.resolve();
				await settle.get(name)?.promise;
				return {
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					checkedClean: false,
					withheldBlockerLine: `\u26a0 1 blocking finding in ${name} withheld: test`,
				};
			}) as never);
			// Event-driven: the row is the only observable of the continuation.
			const lateSeen = gatedPromise<void>();
			logLatency.mockClear();
			logLatency.mockImplementation((row?: { phase?: string }) => {
				if (row?.phase === "withheld_blocker_late_advisory") lateSeen.resolve();
			});
			const lateRows = () =>
				logLatency.mock.calls.filter(
					([row]) => row?.phase === "withheld_blocker_late_advisory",
				);
			try {
				await acrossReplacement(
					"late-withheld",
					async ({ tmpDir, filePath, runtime, cacheManager }) => {
						const goneFile = createTempFile(tmpDir, "gone.ts", "export {};\n");
						const abortedFile = createTempFile(
							tmpDir,
							"aborted.ts",
							"export {};\n",
						);
						for (const name of ["edit.ts", "gone.ts", "aborted.ts"]) {
							settle.set(name, gatedPromise<void>());
							entered.set(name, gatedPromise<void>());
						}
						const secondary = beginScope({ role: "secondary" });
						try {
							const liveHandler = handleToolResult({
								...toolResultDeps({ filePath, runtime, cacheManager }),
								advisoryScope: secondary.capture(),
							});
							const goneHandler = handleToolResult(
								toolResultDeps({ filePath: goneFile, runtime, cacheManager }),
							);
							// Escape mid-check: a cancelled turn, not a late result.
							const escape = new AbortController();
							const abortedHandler = handleToolResult({
								...toolResultDeps({
									filePath: abortedFile,
									runtime,
									cacheManager,
								}),
								signal: escape.signal,
							});
							await Promise.all([
								entered.get("edit.ts")?.promise,
								entered.get("gone.ts")?.promise,
								entered.get("aborted.ts")?.promise,
							]);
							escape.abort();
							await abortedHandler;
							settle.get("aborted.ts")?.resolve();
							await new Promise((resolve) => setImmediate(resolve));
							expect(lateRows()).toEqual([]);
							// Both handlers return at the inner bound with nothing collected.
							await Promise.all([liveHandler, goneHandler]);
							expect(lateRows()).toEqual([]);

							settle.get("edit.ts")?.resolve();
							await lateSeen.promise;
							expect(lateRows()[0]?.[0]).toMatchObject({
								filePath: "edit",
								metadata: { notices: 1, late: "inner-bound" },
							});
							expect(
								consumeAgentNudge(undefined, runtime.sessionScope),
							).toBeUndefined();
							const delivered =
								consumeAgentNudge(undefined, secondary)?.messages ?? [];
							expect(delivered).toEqual([
								expect.objectContaining({
									content: expect.stringMatching(
										/abandoned[^]*edit\.ts withheld/,
									),
								}),
							]);

							// Session 2 starts; the held dispatch of session 1 settles.
							runtime.resetForSession();
							runtime.beginTurn();
							settle.get("gone.ts")?.resolve();
							await new Promise((resolve) => setImmediate(resolve));
							expect(lateRows()).toHaveLength(1);
							expect(
								consumeAgentNudge(undefined, runtime.sessionScope),
							).toBeUndefined();
						} finally {
							retireScope(secondary, "shutdown");
						}
					},
				);
			} finally {
				logLatency.mockReset();
			}
		},
	);
	it("drops another session's git-guard section only for a write that reached a whole-file clean verdict (#4733 r1 F2)", async () => {
		// RECURRENCE GUARDED: #4733 r1 F2 (Greptile "Unanswered checks clear
		// blockers"). Every live write under `--lens-guard` called
		// `syncGitGuardRecord` with no verdict, so a write whose runners reached
		// none (timed out, unanswered, a coverage gap) dropped another
		// session's section for the file, and the last one cleared the record.
		const { runPipeline } = await import("../../clients/pipeline.js");
		await acrossReplacement(
			"4733-verdict",
			async ({ tmpDir, filePath, runtime, cacheManager }) => {
				runtime.setTelemetryIdentity({ sessionId: "session-A" });
				const section = `${filePath}: 🔴 STOP — 1 issue(s) must be fixed:\n  L1: Debugger statement`;
				const seed = () =>
					cacheManager.writeCache(
						"turn-end-findings",
						{
							content: section,
							blockerContent: section,
							blockingFiles: [filePath],
							hasBlockers: true,
							affectedFiles: [filePath],
							sessionId: "an-earlier-session",
							projectSeqStart: 0,
							projectSeqEnd: 0,
							fileSeqByPath: {},
							fileContentHashes: {},
							consumed: true,
						},
						tmpDir,
					);
				const stored = () =>
					cacheManager.readCache<{ blockerContent?: string }>(
						"turn-end-findings",
						tmpDir,
						Number.POSITIVE_INFINITY,
					)?.data;
				const clean = {
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					currentBlockerCount: 0,
				};
				const verdicts: Array<[string, Record<string, unknown>]> = [
					["no verdict field", clean],
					[
						"observation still holds a blocker",
						{ ...clean, fileVerdictComplete: true, currentBlockerCount: 1 },
					],
					[
						"pipeline error",
						{ ...clean, isError: true, fileVerdictComplete: true },
					],
					["whole-file clean verdict", { ...clean, fileVerdictComplete: true }],
				];
				const kept: Array<[string, boolean]> = [];
				for (const [label, result] of verdicts) {
					seed();
					vi.mocked(runPipeline).mockReset();
					vi.mocked(runPipeline).mockResolvedValue(result as never);
					runtime.beginTurn();
					// index.ts' turn_start clears the already-analysed latch.
					clearLastAnalyzedStateCache();
					await handleToolResult(
						toolResultDeps({
							filePath,
							runtime,
							cacheManager,
							flags: ["lens-guard"],
						}),
					);
					kept.push([label, stored()?.blockerContent === section]);
				}
				expect(kept).toEqual([
					["no verdict field", true],
					["observation still holds a blocker", true],
					["pipeline error", true],
					["whole-file clean verdict", false],
				]);
			},
		);
	});

	it("keeps this session's own git-guard section after a write that reached no whole-file verdict (#4733 r2 F11)", async () => {
		// RECURRENCE GUARDED: #4733 r2 F11. The section trim asked for a whole-file
		// verdict only of another session's record, so a write of a file that
		// reached none dropped this session's own section, and the next clean
		// write of another file deleted the record and the commit ran. A run with
		// no verdict observes nothing (AGENTS.md shape 10), on either session axis.
		const { runPipeline } = await import("../../clients/pipeline.js");
		await acrossReplacement(
			"4733-own-verdict",
			async ({ tmpDir, filePath, runtime, cacheManager }) => {
				runtime.setTelemetryIdentity({ sessionId: "session-A" });
				const other = createTempFile(
					tmpDir,
					"other.ts",
					"export const y = 1;\n",
				);
				fs.utimesSync(other, LONG_AGO, LONG_AGO);
				const section = (file: string) =>
					`${file}: 🔴 STOP — 1 issue(s) must be fixed:\n  L1: Debugger statement`;
				const blockerContent = `${section(filePath)}\n\n${section(other)}`;
				cacheManager.writeCache(
					"turn-end-findings",
					{
						content: blockerContent,
						blockerContent,
						blockingFiles: [filePath, other],
						hasBlockers: true,
						affectedFiles: [filePath, other],
						sessionId: "session-A",
						projectSeqStart: 0,
						projectSeqEnd: 0,
						fileSeqByPath: {},
						fileContentHashes: {},
						consumed: true,
					},
					tmpDir,
				);
				const stored = () =>
					cacheManager.readCache<{ blockerContent?: string }>(
						"turn-end-findings",
						tmpDir,
						Number.POSITIVE_INFINITY,
					)?.data;
				const clean = {
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					currentBlockerCount: 0,
				};
				const write = async (file: string, result: Record<string, unknown>) => {
					vi.mocked(runPipeline).mockReset();
					vi.mocked(runPipeline).mockResolvedValue(result as never);
					runtime.beginTurn();
					clearLastAnalyzedStateCache();
					await handleToolResult(
						toolResultDeps({
							filePath: file,
							runtime,
							cacheManager,
							flags: ["lens-guard"],
						}),
					);
				};

				await write(filePath, clean);
				expect(stored()?.blockerContent).toContain(section(filePath));

				await write(other, { ...clean, fileVerdictComplete: true });
				expect(stored()?.blockerContent).toBe(section(filePath));
				expect(evaluateGitGuard(runtime, cacheManager, tmpDir).block).toBe(
					true,
				);
			},
		);
	});

	it("keeps another session's section when a superseded write reaches a whole-file clean verdict (#4733 r6 F22)", async () => {
		// RECURRENCE GUARDED: #4733 r6 F22. `wholeFileClean` reads only a verdict
		// that applied. An older write of a file that settles after a newer one
		// has its clear refused by the write order (#3507); without that conjunct
		// its whole-file clean result dropped another session's section anyway.
		const { runPipeline } = await import("../../clients/pipeline.js");
		await acrossReplacement(
			"4733-superseded-verdict",
			async ({ tmpDir, filePath, runtime, cacheManager }) => {
				runtime.setTelemetryIdentity({ sessionId: "session-A" });
				const other = createTempFile(
					tmpDir,
					"other.ts",
					"export const y = 1;\n",
				);
				fs.utimesSync(other, LONG_AGO, LONG_AGO);
				const section = (file: string) =>
					`${file}: 🔴 STOP — 1 issue(s) must be fixed:\n  L1: Debugger statement`;
				const blockerContent = `${section(filePath)}\n\n${section(other)}`;
				cacheManager.writeCache(
					"turn-end-findings",
					{
						content: blockerContent,
						blockerContent,
						blockingFiles: [filePath, other],
						hasBlockers: true,
						affectedFiles: [filePath, other],
						sessionId: "an-earlier-session",
						projectSeqStart: 0,
						projectSeqEnd: 0,
						fileSeqByPath: {},
						fileContentHashes: {},
						consumed: true,
					},
					tmpDir,
				);
				const stored = () =>
					cacheManager.readCache<{ blockerContent?: string }>(
						"turn-end-findings",
						tmpDir,
						Number.POSITIVE_INFINITY,
					)?.data;
				runtime.beginTurn();
				// One order turn for both writes, so only their write index orders them.
				const orderTurn = runtime.writeOrderTurn;
				const write = async (result: Record<string, unknown>) => {
					vi.mocked(runPipeline).mockReset();
					vi.mocked(runPipeline).mockResolvedValue({
						output: "",
						hasBlockers: false,
						isError: false,
						fileModified: false,
						currentBlockerCount: 0,
						orderTurn,
						...result,
					} as never);
					clearLastAnalyzedStateCache();
					await handleToolResult(
						toolResultDeps({
							filePath,
							runtime,
							cacheManager,
							flags: ["lens-guard"],
						}),
					);
				};

				// The newer write settles first, with no whole-file verdict.
				await write({ writeIndex: 900 });
				expect(stored()?.blockerContent).toContain(section(filePath));
				// The older write settles after it, with a whole-file clean verdict.
				await write({ writeIndex: 100, fileVerdictComplete: true });
				expect(stored()?.blockerContent ?? "").toContain(section(filePath));
				expect(stored()?.blockerContent).toContain(section(other));
			},
		);
	});

	it.each([
		["this session's own record", "session-A", {}, false, false],
		["another session's record", "an-earlier-session", {}, false, true],
		// An errored run cleared the entry but observed nothing: the next
		// no-verdict write would otherwise find no entry and the section gone.
		[
			"this session's own record, errored run",
			"session-A",
			{ isError: true },
			false,
			true,
		],
		// #4733 r5 F20: the clear is refused (the observation still holds a
		// blocker it rendered no summary for), so it retired nothing and the
		// section stays. The entry is policy-suppressed, so it does not rewrite
		// the record itself and the write's file argument alone decides.
		[
			"this session's own record, refused clear",
			"session-A",
			{ currentBlockerCount: 1 },
			true,
			true,
		],
	] as const)(
		"%s: a file's section leaves only when the write retired that file's own blocker, without a whole-file verdict (#4733 r3 F15)",
		async (_label, owner, fix, suppress, kept) => {
			// RECURRENCE GUARDED: #4733 r3 F15 (#4509 row 31b). The write that
			// fixed a file's blocker while a language server was cut off reached no
			// whole-file verdict, so the caller passed no file and the record kept a
			// section its own observation had retired: every commit stayed refused.
			// The own section leaves with the inline-blocker entry this write retired
			// (the rule the sibling callers use); another session's section still
			// waits for a whole-file clean verdict.
			const { runPipeline } = await import("../../clients/pipeline.js");
			await acrossReplacement(
				`4733-f15-${owner}`,
				async ({ tmpDir, filePath, runtime, cacheManager }) => {
					runtime.setTelemetryIdentity({ sessionId: "session-A" });
					const other = createTempFile(
						tmpDir,
						"other.ts",
						"export const y = 1;\n",
					);
					fs.utimesSync(other, LONG_AGO, LONG_AGO);
					const summary =
						"🔴 STOP — 1 issue(s) must be fixed:\n  L1: eval() is banned";
					const otherSection = `${other}: 🔴 STOP — 1 issue(s) must be fixed:\n  L1: Debugger statement`;
					const stored = () =>
						cacheManager.readCache<{
							blockerContent?: string;
							sessionId?: string;
						}>("turn-end-findings", tmpDir, Number.POSITIVE_INFINITY)?.data;
					const write = async (
						file: string,
						result: Record<string, unknown>,
					) => {
						vi.mocked(runPipeline).mockReset();
						vi.mocked(runPipeline).mockResolvedValue(result as never);
						runtime.beginTurn();
						clearLastAnalyzedStateCache();
						await handleToolResult(
							toolResultDeps({
								filePath: file,
								runtime,
								cacheManager,
								flags: ["lens-guard"],
							}),
						);
					};

					await write(filePath, {
						output: summary,
						hasBlockers: true,
						isError: false,
						fileModified: false,
						currentBlockerCount: 1,
						inlineBlockerSummary: summary,
						inlineBlockerSources: ["ast-grep-napi"],
						inlineBlockerLines: [1],
					});
					expect(stored()?.blockerContent).toContain(`${filePath}:`);
					// The record as its owner left it: this session's, or another
					// session's that wrote over it since (its section for the file is
					// that session's evidence, not the entry this session retires).
					const fileSection = `${filePath}: ${summary}`;
					const blockerContent = `${fileSection}\n\n${otherSection}`;
					cacheManager.writeCache(
						"turn-end-findings",
						{
							content: blockerContent,
							blockerContent,
							blockingFiles: [filePath, other],
							hasBlockers: true,
							affectedFiles: [filePath, other],
							sessionId: owner,
							projectSeqStart: 0,
							projectSeqEnd: 0,
							fileSeqByPath: {},
							fileContentHashes: {},
							consumed: true,
						},
						tmpDir,
					);

					if (suppress) runtime.applyInlineBlockerPolicyVerdicts([filePath]);
					// The fix: no blocker left, but no whole-file verdict either (a
					// server went unconfirmed), so `fileVerdictComplete` is absent.
					await write(filePath, {
						output: "",
						hasBlockers: false,
						isError: false,
						fileModified: false,
						currentBlockerCount: 0,
						...fix,
					});
					expect(
						stored()?.blockerContent?.includes(`${filePath}:`) ?? false,
					).toBe(kept);
					expect(stored()?.blockerContent).toContain(otherSection);
				},
			);
		},
	);

	it.each([
		["crashed", "pipeline_crash"],
		["errored", "pipeline_error"],
	] as const)(
		"keeps a %s dispatch's latch through other files' clean writes until that file's own dispatch returns (#4733 r2 F12)",
		async (failure, reason) => {
			// RECURRENCE GUARDED: #4733 r2 F12 (Greptile "Unrelated writes erase
			// failed checks"). The latch held one reason and no file, and every record
			// write or delete cleared it, so after one file's pipeline crashed a clean
			// write of another file let the commit run with the crashed file never
			// re-checked.
			const { runPipeline } = await import("../../clients/pipeline.js");
			await acrossReplacement(
				`4733-${failure}-latch`,
				async ({ tmpDir, filePath, runtime, cacheManager }) => {
					runtime.setTelemetryIdentity({ sessionId: "session-A" });
					const crashed = createTempFile(
						tmpDir,
						"crashed.ts",
						"export const z = 1;\n",
					);
					fs.utimesSync(crashed, LONG_AGO, LONG_AGO);
					const clean = {
						output: "",
						hasBlockers: false,
						isError: false,
						fileModified: false,
						currentBlockerCount: 0,
						fileVerdictComplete: true,
					};
					const write = async (file: string, outcome: "fail" | "clean") => {
						vi.mocked(runPipeline).mockReset();
						if (outcome === "fail" && failure === "crashed")
							vi.mocked(runPipeline).mockRejectedValue(
								new Error("runner exploded"),
							);
						else if (outcome === "fail")
							vi.mocked(runPipeline).mockResolvedValue({
								output: "pipeline error",
								hasBlockers: false,
								isError: true,
								fileModified: false,
							} as never);
						else vi.mocked(runPipeline).mockResolvedValue(clean as never);
						runtime.beginTurn();
						clearLastAnalyzedStateCache();
						await handleToolResult(
							toolResultDeps({
								filePath: file,
								runtime,
								cacheManager,
								flags: ["lens-guard"],
							}),
						);
					};
					const gate = () => evaluateGitGuard(runtime, cacheManager, tmpDir);
					// Another session's record whose only section is the clean file, so its
					// clean write deletes the record (the delete site the latch must survive).
					const section = `${filePath}: 🔴 STOP — 1 issue(s) must be fixed:\n  L1: Debugger statement`;
					cacheManager.writeCache(
						"turn-end-findings",
						{
							content: section,
							blockerContent: section,
							blockingFiles: [filePath],
							hasBlockers: true,
							affectedFiles: [filePath],
							sessionId: "an-earlier-session",
							projectSeqStart: 0,
							projectSeqEnd: 0,
							fileSeqByPath: {},
							fileContentHashes: {},
							consumed: true,
						},
						tmpDir,
					);

					await write(crashed, "fail");
					// The gate names one cause at a time: the record's own refusal
					// (another session's section) may come first.
					expect(gate().block).toBe(true);

					await write(filePath, "clean");
					expect(
						cacheManager.readCache(
							"turn-end-findings",
							tmpDir,
							Number.POSITIVE_INFINITY,
						)?.data,
					).toBeUndefined();
					const refusal = gate();
					expect(refusal.block).toBe(true);
					expect(refusal.reason).toContain(reason);
					expect(refusal.reason).toContain("crashed.ts");

					await write(crashed, "clean");
					expect(gate()).toEqual({ block: false });
				},
			);
		},
	);

	it.each([
		["crash", true],
		["errored run", false],
	] as const)(
		"drops a replaced session's late pipeline %s instead of latching the live session (#4733 r5 G2)",
		async (outcome, rejects) => {
			// RECURRENCE GUARDED: #4733 r5 G2 (AGENTS.md shape 22). The crash latch
			// was written in the catch after `await pipelinePromise` without the
			// captured session generation, so session 1's late rejection latched
			// session 2's gate for a file session 2 never dispatched. The errored-run
			// mark, now on the same shared path (r5 G1), takes the same fence.
			const { runPipeline } = await import("../../clients/pipeline.js");
			const entered = gatedPromise<void>();
			const release = gatedPromise<void>();
			vi.mocked(runPipeline).mockReset();
			vi.mocked(runPipeline).mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				if (rejects) throw new Error("runner exploded");
				return {
					output: "",
					hasBlockers: false,
					isError: true,
					fileModified: false,
				} as never;
			});
			await acrossReplacement(
				`4733-late-${outcome.replace(" ", "-")}`,
				async ({ tmpDir, filePath, runtime, cacheManager }) => {
					const handler = handleToolResult(
						toolResultDeps({
							filePath,
							runtime,
							cacheManager,
							flags: ["lens-guard"],
						}),
					);
					await entered.promise;
					runtime.resetForSession();
					runtime.beginTurn();
					release.resolve();
					await handler;
					expect(runtime.gitGuardUnansweredDispatches).toEqual([]);
					expect(evaluateGitGuard(runtime, cacheManager, tmpDir).block).toBe(
						false,
					);
				},
			);
		},
	);

	it("a replaced session's late clean verdict leaves the live session's commit gate as it was (#4737 r2)", async () => {
		// RECURRENCE GUARDED: #4737 r2. The verdict publisher both callers share
		// re-derives the gate's status and rewrites the record. Run for a dead
		// handler, its no-blocker sync cleared the live session's unknown-state
		// latch, and the next commit ran on state no one had re-checked.
		const { runPipeline } = await import("../../clients/pipeline.js");
		const entered = gatedPromise<void>();
		const release = gatedPromise<void>();
		vi.mocked(runPipeline).mockReset();
		vi.mocked(runPipeline).mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return {
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				currentBlockerCount: 0,
				fileVerdictComplete: true,
			} as never;
		});
		await acrossReplacement(
			"4737-late-clean",
			async ({ tmpDir, filePath, runtime, cacheManager }) => {
				const handler = handleToolResult(
					toolResultDeps({
						filePath,
						runtime,
						cacheManager,
						flags: ["lens-guard"],
					}),
				);
				await entered.promise;
				runtime.resetForSession();
				runtime.beginTurn();
				runtime.markGitGuardCacheUnknown("cache_corrupt", tmpDir);
				release.resolve();
				await handler;
				expect(evaluateGitGuard(runtime, cacheManager, tmpDir).block).toBe(
					true,
				);
			},
		);
	});

	it("a session-1 pipeline finishing in session 2's turn does not mark session 2's bytes analysed (#3763)", async () => {
		// #3763 item 2: the already-analysed latch is keyed by the LIVE turn
		// index, so a dead pipeline that settled after session 2's turn_start
		// told session 2's own write of the same bytes that they were analysed:
		// session 2's write was never dispatched, and the skip also passes over
		// its turn-state range and change-log receipt.
		const { runPipeline } = await import("../../clients/pipeline.js");
		const entered = gatedPromise<void>();
		const release = gatedPromise<void>();
		await acrossReplacement(
			"latch",
			async ({ filePath, runtime, cacheManager }) => {
				vi.mocked(runPipeline).mockReset();
				vi.mocked(runPipeline).mockImplementation(async () => {
					if (vi.mocked(runPipeline).mock.calls.length === 1) {
						entered.resolve();
						await release.promise;
					}
					return {
						output: "",
						hasBlockers: false,
						isError: false,
						fileModified: false,
						checkedClean: false,
					};
				});
				const handler = handleToolResult(
					toolResultDeps({ filePath, runtime, cacheManager }),
				);
				await entered.promise;
				runtime.resetForSession();
				runtime.beginTurn();
				// index.ts' turn_start clears the latch for the new turn.
				clearLastAnalyzedStateCache();
				release.resolve();
				await handler;
				await handleToolResult(
					toolResultDeps({ filePath, runtime, cacheManager }),
				);
				expect(vi.mocked(runPipeline).mock.calls.length).toBe(2);
			},
		);
	});

	// #3763 r2 (F1): the pipeline's immediate autofix marks the file fixed
	// after its fixer awaits (`runAutofix`), through the `fixedThisTurn` the
	// handler hands `runPipeline`. A write whose autofix finished after the
	// replacement marked session 2's copy, so session 2's own autofix of that
	// file was skipped as already fixed. The recurrence: the raw set handed to
	// the pipeline instead of one fenced by the handler's session.
	async function immediateAutofixMark(replaced: boolean): Promise<boolean> {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const entered = gatedPromise<void>();
		const release = gatedPromise<void>();
		let marked = false;
		await acrossReplacement(
			replaced ? "fixed-mark" : "fixed-mark-live",
			async ({ filePath, runtime, cacheManager }) => {
				vi.mocked(runPipeline).mockReset();
				vi.mocked(runPipeline).mockImplementation(async (ctx, deps) => {
					entered.resolve();
					await release.promise;
					// What `runAutofix` does once its fixer returned (pipeline.ts).
					if (ctx.autofixMode === "immediate") deps.fixedThisTurn.add(filePath);
					return {
						output: "",
						hasBlockers: false,
						isError: false,
						fileModified: false,
						checkedClean: false,
					};
				});
				const handler = handleToolResult({
					...toolResultDeps({ filePath, runtime, cacheManager }),
					event: {
						toolName: "write",
						input: { path: filePath, content: "export const x = 2;\n" },
						content: [{ type: "text", text: "ok" }],
					},
				});
				await entered.promise;
				if (replaced) {
					runtime.resetForSession();
					runtime.beginTurn();
				}
				release.resolve();
				await handler;
				marked = runtime.fixedThisTurn.has(filePath);
			},
		);
		return marked;
	}

	it("a session-1 autofix finishing after the replacement leaves session 2's file unmarked (#3763)", async () => {
		expect(await immediateAutofixMark(true)).toBe(false);
	});

	it("an immediate autofix in its own session marks the file fixed (#3763)", async () => {
		expect(await immediateAutofixMark(false)).toBe(true);
	});
});

describe("runtime-tool-result inline behavior warnings", () => {
	beforeEach(async () => {
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
	});

	it("appends project change log entries for analyzed agent edits", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-change-log-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "change-session" });
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			const changes = readChangesSince(env.tmpDir, 0);
			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				seq: 1,
				sessionId: "change-session",
				turnIndex: 1,
				source: "agent-edit",
				filePath,
				fileSeq: 1,
				changedRange: { start: 1, end: 1 },
			});
			expect(runtime.projectSeq).toBe(1);
			expect(runtime.getFileSeq(filePath)).toBe(1);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("queues successful write/edit files for deferred formatting by default", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-deferred-format-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const deferFormat = vi.fn();
			const deferMutation = vi.fn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					// #3506 r1 F8: the handler's session capture; this runtime never resets.
					captureSessionGeneration: () => ({
						guardedWrite: (_subject: string, write: () => unknown) => write(),
					}),
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat,
					deferMutation,
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(deferFormat).toHaveBeenCalledWith(
				filePath,
				expect.any(String),
				"edit",
				env.tmpDir,
				undefined,
				// #1642 F3: the true resolution basis (origin cwd), threaded
				// through so the orphan fallback can tell checkouts apart. No
				// tool-call id on this event, so it falls back to the project
				// root, same as the pre-#1642 basis.
				env.tmpDir,
				"session",
			);
			expect(deferMutation).toHaveBeenCalledWith(
				filePath,
				expect.any(String),
				"edit",
				env.tmpDir,
				"autofix",
				undefined,
				env.tmpDir,
				undefined,
				"session",
			);
		} finally {
			env.cleanup();
		}
	});

	it("returns authoritative full content after immediate write autofix", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-post-mutation-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/app.ts",
				"const value = 1;\n",
			);
			vi.mocked(runPipeline).mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				checkedClean: false,
				changedFiles: [filePath],
				postMutation: {
					filePath,
					content: fs.readFileSync(filePath, "utf-8"),
					source: "autofix",
				},
			});
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const returned = await handleToolResult({
				event: {
					toolName: "write",
					input: { path: filePath },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			// #1590: the attachment block carries the bytes and the trailing
			// notice block states the authority — one sentence, one author.
			const attachment = returned?.content.find((part) =>
				part.text?.startsWith("pi-lens applied autofix to"),
			);
			expect(attachment?.text).toContain(fs.readFileSync(filePath, "utf-8"));
			expect(returned?.content.at(-1)?.text).toContain(
				"is authoritative after autofix",
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not stamp an ambiguous side-effect write as the target identity (#2499 HIGH)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-2499-ambiguous-write-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"target.ts",
				"const x = 1;\n",
			);
			vi.mocked(runPipeline).mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				checkedClean: false,
				// A side-effect file changed, but the target write has no owned hash.
				changedFiles: [path.join(env.tmpDir, "helper.rs")],
			});
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const noteAfterWriteHash = vi.spyOn(
				runtime.partialApplyRecords,
				"noteAfterWriteHash",
			);

			await handleToolResult({
				event: {
					toolName: "edit",
					input: {
						path: filePath,
						edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
					},
					content: [],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(noteAfterWriteHash).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	// A bash result fans out into per-file write results. Counting those replays
	// used to evict the real bash call from the five-call BLIND WRITE window.
	it.each([1, 11])(
		"counts one bash call across %i per-file diagnostic results",
		async (fileCount) => {
			const env = setupTestEnvironment("pi-lens-bash-behavior-count-");
			try {
				vi.mocked(runPipeline).mockImplementation(async (ctx) => ({
					output: `diagnostics for ${path.basename(ctx.filePath)}`,
					hasBlockers: false,
					isError: false,
					fileModified: false,
					checkedClean: false,
				}));
				const paths = Array.from({ length: fileCount }, (_, index) =>
					createTempFile(env.tmpDir, `bash-${index}.ts`, "export {};\n"),
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const behavior = new AgentBehaviorClient();
				const base: Omit<Parameters<typeof handleToolResult>[0], "event"> = {
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					resetLSPService: () => {},
					agentBehaviorRecord: (name, filePath) =>
						behavior.recordToolCall(name, filePath),
					formatBehaviorWarnings: (warnings) =>
						behavior.formatWarnings(warnings as BehaviorWarning[]),
				};
				const returned = await handleToolResult({
					...base,
					event: {
						toolName: "bash",
						input: {
							command: paths
								.map((file) => `echo x > "${toPosix(file)}"`)
								.join("; "),
						},
						content: [{ type: "text", text: "bash ok" }],
					},
				});
				const text = returned?.content.map((part) => part.text).join("\n");
				expect(text).not.toContain("BLIND WRITE");
				expect(text).not.toContain("THRASHING");
				for (const filePath of paths) {
					expect(text).toContain(`diagnostics for ${path.basename(filePath)}`);
					expect(runtime.getFileSeq(filePath)).toBe(1);
				}
				expect(
					readChangesSince(env.tmpDir, 0).map((change) => change.filePath),
				).toEqual(paths);

				// The real bash must still provide knowledge for later real calls.
				// Dropping it as well would warn on the third edit of a new file.
				for (let index = 0; index < 3; index++) {
					const filePath = createTempFile(
						env.tmpDir,
						`edit-${index}.ts`,
						"export {};\n",
					);
					const edited = await handleToolResult({
						...base,
						event: { toolName: "edit", input: { path: filePath }, content: [] },
					});
					expect(
						edited?.content.map((part) => part.text).join("\n"),
					).not.toContain("BLIND WRITE");
				}
			} finally {
				env.cleanup();
			}
		},
	);

	// The replay guard must not silence warnings from separate host calls.
	it.each(["write", "edit"])(
		"keeps BLIND WRITE and THRASHING warnings for real %s calls",
		async (toolName) => {
			const env = setupTestEnvironment("pi-lens-native-behavior-count-");
			try {
				vi.mocked(runPipeline).mockResolvedValue({
					output: "diagnostics complete",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					checkedClean: false,
				});
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const behavior = new AgentBehaviorClient();
				const base: Omit<Parameters<typeof handleToolResult>[0], "event"> = {
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					resetLSPService: () => {},
					agentBehaviorRecord: (name, filePath) =>
						behavior.recordToolCall(name, filePath),
					formatBehaviorWarnings: (warnings) =>
						behavior.formatWarnings(warnings as BehaviorWarning[]),
				};
				for (let index = 0; index < 6; index++) {
					const filePath = createTempFile(
						env.tmpDir,
						index < 3 ? `storm-${index}.ts` : "thrash.ts",
						`export const value = ${index};\n`,
					);
					const returned = await handleToolResult({
						...base,
						event: { toolName, input: { path: filePath }, content: [] },
					});
					const text = returned?.content.map((part) => part.text).join("\n");
					if (index === 2) expect(text).toContain("BLIND WRITE");
					if (index === 5) expect(text).toContain("THRASHING");
				}
			} finally {
				env.cleanup();
			}
		},
	);

	// #4623: the guard asks `mutating-tool.ts` which results are bash replays, and
	// only the exact marker keeps a result out of the behavior history. A
	// look-alike marker is still the host call it is: all three writes below
	// are recorded, so the third one warns BLIND WRITE.
	it.each<[string, unknown, boolean]>([
		["the exact bash value", "bash", false],
		["another case", "BASH", true],
		["another replay source", "opaque-script", true],
		["a boolean", true, true],
	])(
		"counts a write result carrying %s as a host call only when it is not the bash marker",
		async (_label, marker, isRecorded) => {
			const env = setupTestEnvironment("pi-lens-replay-marker-behavior-");
			try {
				vi.mocked(runPipeline).mockResolvedValue({
					output: "diagnostics complete",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					checkedClean: false,
				});
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const behavior = new AgentBehaviorClient();
				let text: string | undefined;
				for (let index = 0; index < 3; index++) {
					const filePath = createTempFile(
						env.tmpDir,
						`marked-${index}.ts`,
						"export {};\n",
					);
					const returned = await handleToolResult({
						getFlag: () => false,
						dbg: () => {},
						runtime,
						cacheManager: new CacheManager(false),
						resetLSPService: () => {},
						agentBehaviorRecord: (name, recordedPath) =>
							behavior.recordToolCall(name, recordedPath),
						formatBehaviorWarnings: (warnings) =>
							behavior.formatWarnings(warnings as BehaviorWarning[]),
						event: {
							toolName: "write",
							input: { path: filePath },
							content: [],
							[PI_LENS_SYNTHETIC_MUTATION_FIELD]: marker,
						},
					});
					text = returned?.content.map((part) => part.text).join("\n");
				}
				// The diagnostics still render for every marker: only the history differs.
				expect(text).toContain("diagnostics complete");
				if (isRecorded) expect(text).toContain("BLIND WRITE");
				else expect(text).not.toContain("BLIND WRITE");
			} finally {
				env.cleanup();
			}
		},
	);

	it("runs bash synthetic writes immediately and returns authoritative content", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-bash-write-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"bash.ts",
				"const bash = true;\n",
			);
			vi.mocked(runPipeline).mockImplementation(async (ctx) => ({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				checkedClean: false,
				changedFiles: [filePath],
				postMutation:
					ctx.autofixMode === "immediate"
						? {
								filePath,
								content: fs.readFileSync(filePath, "utf-8"),
								source: "autofix",
							}
						: undefined,
			}));
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const returned = await handleToolResult({
				event: {
					toolName: "bash",
					input: { command: `echo x > "${filePath}"` },
					content: [{ type: "text", text: "bash ok" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			expect(vi.mocked(runPipeline).mock.calls[0][0].autofixMode).toBe(
				"immediate",
			);
			expect(
				returned?.content.some((part) => part.text?.includes("authoritative")),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("recovers opaque multi-file bash changes without granting ownership", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-3226-opaque-ownership-");
		try {
			vi.mocked(runPipeline).mockImplementation(async () => ({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				checkedClean: false,
			}));
			const existingPath = createTempFile(
				env.tmpDir,
				"extracted/existing.js",
				"(function(){ return 1; })();\n",
			);
			const createdPath = path.join(env.tmpDir, "extracted", "created.js");
			const directPath = createTempFile(
				env.tmpDir,
				"direct.js",
				"const direct = 1;\n",
			);
			const command = `echo direct > "${directPath}"; node opaque-extractor.js`;
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const recordWritten = vi.spyOn(runtime.readGuard, "recordWritten");
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolName: "bash",
						toolCallId: "3226-opaque",
						input: { command },
					},
					ctx: { cwd: env.tmpDir },
					lensEnabled: true,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);

			// Stand in for the true extraction/download child boundary: the
			// tool_result path sees only the resulting filesystem state.
			fs.writeFileSync(existingPath, "(function(){ return 2; })();\n");
			fs.writeFileSync(createdPath, "(function(){ return 3; })();\n");
			fs.writeFileSync(directPath, "const direct = 2;\n");
			const opaqueBytesBeforePipeline = new Map([
				[existingPath, fs.readFileSync(existingPath)],
				[createdPath, fs.readFileSync(createdPath)],
			]);
			await handleToolResult({
				event: {
					toolName: "bash",
					toolCallId: "3226-opaque",
					input: { command },
					content: [{ type: "text", text: "extracted" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				readGuard: runtime.readGuard,
			} as any);

			expect(vi.mocked(runPipeline).mock.calls).toHaveLength(3);
			expect(
				vi
					.mocked(runPipeline)
					.mock.calls.filter(([ctx]) => ctx.allowAutonomousWriters === true),
			).toHaveLength(1);
			expect(
				vi
					.mocked(runPipeline)
					.mock.calls.filter(([ctx]) => ctx.allowAutonomousWriters === false),
			).toHaveLength(2);
			expect(runtime.pendingDeferredMutationCount).toBe(1);
			// Authorship for the recognized write, never a FileTime stamp (#3525).
			// The bash write names its transcript entry (#3603); the pipeline's
			// refresh names none and keeps it, handing over the bytes it hashed.
			expect(recordWritten).toHaveBeenCalledWith(directPath, {
				authorship: "unknown",
				advanceAuthorship: false,
				stampFileTime: false,
				toolCallId: "3226-opaque",
			});
			for (const [filePath, opts] of recordWritten.mock.calls) {
				expect(filePath).toBe(directPath);
				expect(opts).toMatchObject({ stampFileTime: false });
			}
			for (const [filePath, bytes] of opaqueBytesBeforePipeline) {
				expect(fs.readFileSync(filePath)).toEqual(bytes);
			}
			expect(readChangesSince(env.tmpDir, 0)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						source: "opaque-script",
						filePath: existingPath,
					}),
					expect.objectContaining({
						source: "opaque-script",
						filePath: createdPath,
					}),
					expect.objectContaining({
						source: "agent-write",
						filePath: directPath,
					}),
				]),
			);
			// #3520: authorship is recordWritten's alone. The opaque-recovered files
			// get no recordWritten above, so they need a read although their mtime is
			// newer than the session; the observed bash write stays editable with
			// its mtime long past.
			expect(runtime.readGuard.exportAuthorship().written).toEqual([
				normalizeFilePath(directPath),
			]);
			for (const filePath of [existingPath, createdPath])
				expect(runtime.readGuard.checkEdit(filePath, [1, 1]).action).toBe(
					"block",
				);
			const longAgo = new Date("2000-01-01T00:00:00Z");
			fs.utimesSync(directPath, longAgo, longAgo);
			expect(runtime.readGuard.checkEdit(directPath, [1, 1]).action).toBe(
				"allow",
			);
		} finally {
			env.cleanup();
		}
	});

	// #4387: an UNKNOWN credit now advances a whole-file authorship when its
	// writer checked the path. The opaque recovery's bytes had no such check,
	// so this credit sends advanceAuthorship: false and still ends the
	// authorship. Recurrence: without it, a script the parser cannot see would
	// re-baseline bytes the conversation never wrote.
	it("ends an existing authorship when a bash write comes with opaque recovery (#4387)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-4387-opaque-authored-");
		try {
			vi.mocked(runPipeline).mockImplementation(async () => ({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				checkedClean: false,
			}));
			const existingPath = createTempFile(
				env.tmpDir,
				"extracted/existing.js",
				"(function(){ return 1; })();\n",
			);
			const directPath = createTempFile(
				env.tmpDir,
				"direct.js",
				"const direct = 1;\n",
			);
			const command = `echo direct > "${directPath}"; node opaque-extractor.js`;
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			// An earlier own write authored the file whole.
			runtime.readGuard.recordWritten(directPath, {
				authorship: "whole-file",
				toolCallId: "4387-earlier-write",
			});
			expect(runtime.readGuard.exportAuthorship().written).toEqual([
				normalizeFilePath(directPath),
			]);
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolName: "bash",
						toolCallId: "4387-opaque",
						input: { command },
					},
					ctx: { cwd: env.tmpDir },
					lensEnabled: true,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);
			fs.writeFileSync(existingPath, "(function(){ return 2; })();\n");
			fs.writeFileSync(directPath, "const direct = 2;\n");
			await handleToolResult({
				event: {
					toolName: "bash",
					toolCallId: "4387-opaque",
					input: { command },
					content: [{ type: "text", text: "extracted" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				readGuard: runtime.readGuard,
			} as any);

			expect(
				readChangesSince(env.tmpDir, 0).some(
					(change) =>
						change.source === "opaque-script" &&
						change.filePath === existingPath,
				),
			).toBe(true);
			const verdict = runtime.readGuard.checkEdit(directPath, [1, 1]);
			expect(verdict.action).toBe("block");
			expect(verdict.reason).toContain("File modified since your write");
		} finally {
			env.cleanup();
		}
	});

	it("shares one authoritative-content budget across a multi-file bash write", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-bash-budget-");
		try {
			// Each file's post-fix content fits the per-attachment cap (2 MiB) on
			// its own, but the pair exceeds it — the second attachment must
			// degrade to the re-read warning instead of inflating the aggregate
			// tool result without bound.
			const bigContent = "x".repeat(1.5 * 1024 * 1024);
			const fileA = createTempFile(env.tmpDir, "budget-a.ts", bigContent);
			const fileB = createTempFile(env.tmpDir, "budget-b.ts", bigContent);
			vi.mocked(runPipeline).mockImplementation(async (ctx) => ({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				checkedClean: false,
				changedFiles: [ctx.filePath],
				postMutation: {
					filePath: ctx.filePath,
					content: bigContent,
					source: "autofix",
				},
			}));
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const returned = await handleToolResult({
				event: {
					toolName: "bash",
					input: { command: `echo x > "${fileA}"; echo x > "${fileB}"` },
					content: [],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			const authoritative = returned?.content.filter((part) =>
				part.text?.startsWith("pi-lens applied autofix to"),
			);
			const warnings = returned?.content.filter((part) =>
				part.text?.includes("aggregate authoritative content"),
			);
			expect(authoritative).toHaveLength(1);
			expect(warnings).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("demotes a bash write followed by an edit through the handler", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const formatEventsPublish =
			await import("../../clients/format-events-publish.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-bash-edit-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"bash-edit.ts",
				"let value = 1;\n",
			);
			vi.mocked(runPipeline).mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				checkedClean: false,
			});
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const emit = vi.fn();
			formatEventsPublish.wireFormatEventsBusEmitter(emit);
			const base = {
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any;
			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					input: { command: `echo x > "${filePath}"` },
					content: [],
				},
			});
			fs.writeFileSync(filePath, "let value = 2;\n");
			await handleToolResult({
				...base,
				event: { toolName: "edit", input: { path: filePath }, content: [] },
			});
			// #3763: both handlers' receipts reached their own (live) turn, so the
			// file's next bash write in it is demoted too.
			fs.writeFileSync(filePath, "let value = 3;\n");
			await handleToolResult({
				...base,
				event: {
					toolName: "bash",
					input: { command: `echo y > "${filePath}"` },
					content: [],
				},
			});
			expect(
				vi.mocked(runPipeline).mock.calls.map((call) => call[0].autofixMode),
			).toEqual(["immediate", "deferred", "deferred"]);
			expect(runtime.consumeDeferredFormatFiles()[0].kinds).toEqual(
				new Set(["format", "autofix"]),
			);
			expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({
				kinds: ["autofix", "format"],
			});
		} finally {
			formatEventsPublish._resetFormatEventsPublishForTests();
			env.cleanup();
		}
	});

	it("clears already-fixed state through an alias spelling on edit", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-fixed-alias-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/alias.ts",
				"let alias = 1;\n",
			);
			let aliasPath = filePath.toUpperCase();
			if (!fs.existsSync(aliasPath)) {
				aliasPath = path.join(env.tmpDir, "alias-link.ts");
				fs.symlinkSync(filePath, aliasPath, "file");
			}
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.recordMutationToolReceipt(filePath, "write");
			runtime.fixedThisTurn.add(filePath);
			vi.mocked(runPipeline).mockImplementation(async (_ctx, deps) => {
				expect(deps.fixedThisTurn.has(filePath)).toBe(false);
				return {
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					checkedClean: false,
				};
			});
			await handleToolResult({
				event: { toolName: "edit", input: { path: aliasPath }, content: [] },
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("logs deferred_format_queued only for a deferral the coordinator accepted (#4689 item 9)", async () => {
		// Recurrence it prevents: the phase row was written after
		// `deferFormat` whatever it answered, so an adopted project's edit
		// (`canWriteAnalysisRoot` refuses it, nothing is queued) still logged
		// "deferred_format_queued" and read as a queue entry in the latency log
		// (#4689 probe row d1-obs). Observed through the production
		// `handleToolResult` with a real coordinator; the control row proves
		// the phase is still written for a session file.
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-4689-deferred-queued-");
		// A direct child of the temp root with no `pi-lens-` prefix: a pi-owned
		// temp path is refused as an analysis root, which is the `none` class and
		// not the adopted one this case measures (#4560).
		const adopted = path.join(
			path.dirname(env.tmpDir),
			`capture-4689-adopted-${process.pid}`,
		);
		try {
			const session = env.tmpDir;
			fs.mkdirSync(adopted, { recursive: true });
			fs.writeFileSync(path.join(adopted, "package.json"), "{}\n");
			const sessionFile = createTempFile(session, "in.ts", "let a = 1;\n");
			const adoptedFile = createTempFile(adopted, "out.ts", "let b = 1;\n");
			vi.mocked(runPipeline).mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				checkedClean: false,
			});
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = session;
			const debugLines: string[] = [];
			const run = async (filePath: string) => {
				logLatency.mockClear();
				debugLines.length = 0;
				await handleToolResult({
					event: { toolName: "edit", input: { path: filePath }, content: [] },
					getFlag: () => false,
					dbg: (line: string) => debugLines.push(line),
					runtime,
					cacheManager: {
						addModifiedRange: () => {},
						readTurnState: () => ({}),
					},
					biomeClient: {},
					ruffClient: {},
					metricsClient: {},
					resetLSPService: () => {},
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
				} as any);
				return logLatency.mock.calls.filter(
					([row]) => row?.phase === "deferred_format_queued",
				);
			};

			expect(resolveAnalysisRoot(adoptedFile, session)).toBe("adopted");
			expect(await run(sessionFile)).toHaveLength(1);
			expect(runtime.consumeDeferredFormatFiles()).toHaveLength(1);
			// The control also claims both queue lines (debug record).
			expect(
				debugLines.filter((line) => line.includes("queued deferred")),
			).toHaveLength(2);

			expect(await run(adoptedFile)).toHaveLength(0);
			expect(runtime.consumeDeferredFormatFiles()).toHaveLength(0);
			// #4957 review F2: the autofix debug line claimed a refused entry too.
			expect(
				debugLines.filter((line) => line.includes("queued deferred")),
			).toEqual([]);
		} finally {
			fs.rmSync(adopted, { recursive: true, force: true });
			env.cleanup();
		}
	});

	it("queues format with deferred autofix under --immediate-format", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-immediate-format-");
		try {
			const filePath = createTempFile(env.tmpDir, "flag.ts", "let flag = 1;\n");
			vi.mocked(runPipeline).mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				checkedClean: false,
			});
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await handleToolResult({
				event: { toolName: "edit", input: { path: filePath }, content: [] },
				getFlag: (name: string) => name === "immediate-format",
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			expect(runtime.consumeDeferredFormatFiles()[0].kinds).toEqual(
				new Set(["autofix", "format"]),
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not attach authoritative content above the LSP byte limit", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-large-content-");
		try {
			logLatency.mockClear();
			const boundaryPath = createTempFile(env.tmpDir, "boundary.ts", "x\n");
			const filePath = createTempFile(env.tmpDir, "large.ts", "x\n");
			const boundaryContent = "x".repeat(2 * 1024 * 1024);
			const content = `${boundaryContent}x`;
			vi.mocked(runPipeline)
				.mockResolvedValueOnce({
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: true,
					checkedClean: false,
					changedFiles: [boundaryPath],
					postMutation: {
						filePath: boundaryPath,
						content: boundaryContent,
						source: "autofix",
					},
				})
				.mockResolvedValueOnce({
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: true,
					checkedClean: false,
					changedFiles: [filePath],
					postMutation: { filePath, content, source: "autofix" },
				});
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const boundaryReturned = await handleToolResult({
				event: {
					toolName: "write",
					input: { path: boundaryPath },
					content: [],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			const returned = await handleToolResult({
				event: { toolName: "write", input: { path: filePath }, content: [] },
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);
			expect(
				boundaryReturned?.content.some((part) =>
					part.text?.includes(boundaryContent),
				),
			).toBe(true);
			expect(
				returned?.content.some((part) => part.text?.includes(content)),
			).toBe(false);
			expect(returned?.content.at(-1)?.text).toContain("too large to attach");
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "authoritative_content_attachment_decision",
					metadata: expect.objectContaining({
						bytes: boundaryContent.length,
						decision: "attached",
					}),
				}),
			);
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "authoritative_content_attachment_decision",
					metadata: expect.objectContaining({
						bytes: content.length,
						decision: "size-capped",
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("publishes pilens:format:queued only when deferFormat reports a NEW queue entry (#673)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		const formatEventsPublish =
			await import("../../clients/format-events-publish.js");

		const env = setupTestEnvironment("pi-lens-runtime-tool-format-queued-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const emit = vi.fn();
			formatEventsPublish.wireFormatEventsBusEmitter(emit);

			const baseDeps = {
				getFlag: () => false,
				dbg: () => {},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			};
			const runtimeStub = {
				projectRoot: env.tmpDir,
				setTelemetryIdentity: () => {},
				updateGitGuardStatus: () => {},
				appendCascadeResult: () => {},
				recordInlineBlockers: () => {},
				clearInlineBlockers: () => {},
				// #3506 r1 F8: the handler's session capture; this runtime never resets.
				captureSessionGeneration: () => ({
					guardedWrite: (_subject: string, write: () => unknown) => write(),
				}),
				nextWriteIndex: () => 1,
				turnIndex: 1,
				telemetryModel: "test-model",
				telemetrySessionId: "test-session",
				fixedThisTurn: new Set<string>(),
				reportedThisTurn: new Set<string>(),
				formatPipelineCrashNotice: () => "",
				lastCascadeOutput: "",
				cachedExports: new Map(),
			};

			// First touch: deferFormat reports a NEW entry -> publish fires.
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				runtime: { ...runtimeStub, deferFormat: () => true },
				...baseDeps,
			} as any);

			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit).toHaveBeenCalledWith(
				"pilens:format:queued",
				expect.objectContaining({
					v: 1,
					source: "pi-lens",
					tool: "edit",
					filePath: filePath.replace(/\\/g, "/"),
				}),
			);

			// Second touch (re-edit before agent_end): deferFormat reports a
			// re-touch (not new) -> no second publish, avoiding event spam.
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 2;" },
					content: [{ type: "text", text: "base" }],
				},
				runtime: { ...runtimeStub, deferFormat: () => false },
				...baseDeps,
			} as any);

			expect(emit).toHaveBeenCalledTimes(1);
		} finally {
			formatEventsPublish._resetFormatEventsPublishForTests();
			env.cleanup();
		}
	});

	it("does not append behavior warnings when blockers are present", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "🔴 blocker output",
			hasBlockers: true,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const response = await handleToolResult({
				event: {
					toolName: "write",
					input: { path: filePath },
					details: {},
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					// #3506 r1 F8: the handler's session capture; this runtime never resets.
					captureSessionGeneration: () => ({
						guardedWrite: (_subject: string, write: () => unknown) => write(),
					}),
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [
					{
						type: "blind-write",
						message: "⚠ BLIND WRITE",
						severity: "warning",
						details: {},
					},
				],
				formatBehaviorWarnings: () => "⚠ BLIND WRITE",
			} as any);

			const text = response?.content.at(-1)?.text ?? "";
			expect(text).toContain("🔴 blocker output");
			expect(text).not.toContain("⚠ BLIND WRITE");
		} finally {
			env.cleanup();
		}
	});

	it("appends behavior warnings when no blockers are present", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const response = await handleToolResult({
				event: {
					toolName: "write",
					input: { path: filePath },
					details: {},
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					// #3506 r1 F8: the handler's session capture; this runtime never resets.
					captureSessionGeneration: () => ({
						guardedWrite: (_subject: string, write: () => unknown) => write(),
					}),
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [
					{
						type: "blind-write",
						message: "⚠ BLIND WRITE",
						severity: "warning",
						details: {},
					},
				],
				formatBehaviorWarnings: () => "⚠ BLIND WRITE",
			} as any);

			const text = response?.content.at(-1)?.text ?? "";
			expect(text).toContain("✓ no blockers");
			expect(text).toContain("⚠ BLIND WRITE");
		} finally {
			env.cleanup();
		}
	});

	it("does not emit file-time warnings on rapid consecutive edits", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-");
		try {
			const filePath = path.join(env.tmpDir, "src", "rapid.py");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "value = 1\n");

			const logs: string[] = [];
			const dbg = (msg: string) => logs.push(msg);

			const deps = {
				getFlag: () => false,
				dbg,
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					// #3506 r1 F8: the handler's session capture; this runtime never resets.
					captureSessionGeneration: () => ({
						guardedWrite: (_subject: string, write: () => unknown) => write(),
					}),
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any;

			await handleToolResult({
				...deps,
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 value = 2" },
					content: [{ type: "text", text: "base" }],
				},
			});

			fs.writeFileSync(filePath, "value = 2\n");

			await handleToolResult({
				...deps,
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 value = 3" },
					content: [{ type: "text", text: "base" }],
				},
			});

			// Distinct same-file states in the same turn must both be analyzed.
			expect(
				logs.filter((entry) => entry.includes("tool_result fired for")).length,
			).toBe(2);
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);
			expect(
				logs.some((entry) =>
					entry.includes("skipping already-analyzed file state this turn"),
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("deduplicates repeated tool_result events for the same file state", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-dedupe-");
		try {
			const filePath = path.join(env.tmpDir, "src", "same.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const value = 1;\n");

			const logs: string[] = [];
			const deps = {
				getFlag: () => false,
				dbg: (msg: string) => logs.push(msg),
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					// #3506 r1 F8: the handler's session capture; this runtime never resets.
					captureSessionGeneration: () => ({
						guardedWrite: (_subject: string, write: () => unknown) => write(),
					}),
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any;

			const event = {
				toolName: "edit",
				input: { path: filePath },
				details: { diff: "+  1 export const value = 1;" },
				content: [{ type: "text", text: "base" }],
			};

			await handleToolResult({ ...deps, event });
			await handleToolResult({ ...deps, event });

			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
			expect(
				logs.some((entry) =>
					entry.includes("skipping already-analyzed file state this turn"),
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("tracks side-effect files changed by the pipeline", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-side-effect-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.rs");
			const sideEffectPath = path.join(env.tmpDir, "src", "helper.rs");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "mod helper;\n");
			fs.writeFileSync(sideEffectPath, "pub fn helper() {}\n");

			vi.mocked(runPipeline).mockResolvedValue({
				output: "✅ Auto-fixed 1 issue(s)",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				checkedClean: false,
				changedFiles: [filePath, sideEffectPath],
			});

			const modifiedRanges: Array<{
				filePath: string;
				range: { start: number; end: number };
			}> = [];
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 mod helper;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					// #3506 r1 F8: the handler's session capture; this runtime never resets.
					captureSessionGeneration: () => ({
						guardedWrite: (_subject: string, write: () => unknown) => write(),
					}),
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: (
						changedFile: string,
						range: { start: number; end: number },
					) => {
						modifiedRanges.push({ filePath: changedFile, range });
					},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(modifiedRanges.map((entry) => entry.filePath)).toContain(
				sideEffectPath,
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a native edit and the sibling its pipeline rewrote editable with their mtimes long past (#3520 no-drop)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-3520-native-sibling-");
		try {
			const filePath = createTempFile(env.tmpDir, "src/main.rs", "mod h;\n");
			const siblingPath = createTempFile(
				env.tmpDir,
				"src/helper.rs",
				"pub fn h() {}\n",
			);
			vi.mocked(runPipeline).mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				checkedClean: false,
				// runPipeline reports the target's post-write hash whenever its own
				// write touched the target (pipeline.ts, #2499).
				postWriteStateHash: createHash("sha256")
					.update(fs.readFileSync(filePath))
					.digest("hex"),
				changedFiles: [filePath, siblingPath],
			});
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 mod h;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			const longAgo = new Date("2000-01-01T00:00:00Z");
			for (const written of [filePath, siblingPath])
				fs.utimesSync(written, longAgo, longAgo);
			expect(runtime.readGuard.exportAuthorship().written.sort()).toEqual(
				[filePath, siblingPath].map(normalizeFilePath).sort(),
			);
			for (const written of [filePath, siblingPath])
				expect(runtime.readGuard.checkEdit(written, [1, 1]).action).toBe(
					"allow",
				);
		} finally {
			env.cleanup();
		}
	});

	it("uses the workspace-edit path identity for the dispatched target (#3294)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment(
			"pi-lens-runtime-tool-workspace-edit-path-",
		);
		const previousCwd = process.cwd();
		try {
			const filePath = path.join(env.tmpDir, "src", "main.rs");
			const unrelatedCwd = path.join(env.tmpDir, "other-cwd");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.mkdirSync(path.join(unrelatedCwd, "src"), { recursive: true });
			fs.writeFileSync(filePath, "mod helper;\n");
			fs.writeFileSync(path.join(unrelatedCwd, "src", "main.rs"), "other\n");
			process.chdir(unrelatedCwd);
			vi.mocked(runPipeline).mockResolvedValue({
				output: "✅ Auto-fixed 1 issue(s)",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				checkedClean: false,
				// A cwd-relative workspace-edit spelling must be resolved against
				// the workspace passed to applyWorkspaceEdit, not process.cwd().
				changedFiles: ["src/main.rs"],
			});

			const modifiedRanges: string[] = [];
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 mod helper;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					// #3506 r1 F8: the handler's session capture; this runtime never resets.
					captureSessionGeneration: () => ({
						guardedWrite: (_subject: string, write: () => unknown) => write(),
					}),
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: (changedFile: string) =>
						modifiedRanges.push(changedFile),
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			// The normal edit receipt records the dispatched target once before
			// this changedFiles walk. The #3294 guard must not record it again as
			// a side effect; a genuine neighbour remains covered by the test above.
			expect(
				modifiedRanges.filter((changed) => changed === filePath),
			).toHaveLength(1);
			expect(modifiedRanges).not.toContain(
				path.join(unrelatedCwd, "src", "main.rs"),
			);
		} finally {
			process.chdir(previousCwd);
			env.cleanup();
		}
	});

	it("uses the filesystem answer for case-variant workspace-edit paths (#3294)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-runtime-tool-case-variant-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.rs");
			const caseVariantPath = path.join(env.tmpDir, "src", "MAIN.rs");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "mod helper;\n");
			if (!fs.existsSync(caseVariantPath))
				fs.writeFileSync(caseVariantPath, "pub fn helper() {}\n");

			const filesystemTarget = fs.realpathSync.native(filePath);
			const filesystemChanged = fs.realpathSync.native(caseVariantPath);
			const isSameFilesystemFile = filesystemTarget === filesystemChanged;
			vi.mocked(runPipeline).mockResolvedValue({
				output: "✅ Auto-fixed 1 issue(s)",
				hasBlockers: false,
				isError: false,
				fileModified: true,
				checkedClean: false,
				changedFiles: [caseVariantPath],
			});

			const modifiedRanges: string[] = [];
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 mod helper;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot: env.tmpDir,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					// #3506 r1 F8: the handler's session capture; this runtime never resets.
					captureSessionGeneration: () => ({
						guardedWrite: (_subject: string, write: () => unknown) => write(),
					}),
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: (changedFile: string) =>
						modifiedRanges.push(changedFile),
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			// The recurrence is a case-folding host receiving the target's spelling
			// back from applyWorkspaceEdit; ext4 instead has a distinct file that
			// must remain visible as a side effect.
			if (isSameFilesystemFile)
				expect(modifiedRanges).not.toContain(caseVariantPath);
			else expect(modifiedRanges).toContain(caseVariantPath);
		} finally {
			env.cleanup();
		}
	});

	it("uses fast LSP reset when pipeline crash recovery resets clients", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockRejectedValue(new Error("boom"));

		const env = setupTestEnvironment("pi-lens-runtime-tool-crash-reset-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			const resetLSPService = vi.fn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 2;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(resetLSPService).toHaveBeenCalledWith({
				fast: true,
				reason: "pipeline_crash",
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not let a secondary pipeline crash reset the primary fleet", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockRejectedValue(new Error("secondary boom"));

		const env = setupTestEnvironment("pi-lens-runtime-tool-secondary-crash-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			registerPrimarySession({}, "primary-session", env.tmpDir);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setSessionLifecycle({ sessionId: "secondary-session" });
			runtime.beginTurn();
			const resetLSPService = vi.fn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 2;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(resetLSPService).not.toHaveBeenCalled();
		} finally {
			releasePrimarySession();
			env.cleanup();
		}
	});

	// R2-F2 (#2157 fix round 2): the primary-direction mirror of the secondary
	// test above — a crash belonging to the registered primary must still
	// reset its own fleet.
	it("lets a primary session's own pipeline crash reset its fleet", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockRejectedValue(new Error("primary boom"));

		const env = setupTestEnvironment("pi-lens-runtime-tool-primary-crash-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			registerPrimarySession({}, "primary-session", env.tmpDir);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setSessionLifecycle({ sessionId: "primary-session" });
			runtime.beginTurn();
			const resetLSPService = vi.fn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 2;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(resetLSPService).toHaveBeenCalledWith({
				fast: true,
				reason: "pipeline_crash",
			});
		} finally {
			releasePrimarySession();
			env.cleanup();
		}
	});

	it("resolves relative tool_result paths against the workspace root", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});

		const env = setupTestEnvironment("pi-lens-runtime-tool-path-");
		try {
			const projectRoot = path.join(env.tmpDir, "workspace");
			const filePath = path.join(projectRoot, "python-utils", "app", "main.py");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "VALUE = 1\n");

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: "python-utils/app/main.py" },
					details: { diff: "+  1 VALUE = 2" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: {
					projectRoot,
					setTelemetryIdentity: () => {},
					updateGitGuardStatus: () => {},
					appendCascadeResult: () => {},
					recordInlineBlockers: () => {},
					clearInlineBlockers: () => {},
					// #3506 r1 F8: the handler's session capture; this runtime never resets.
					captureSessionGeneration: () => ({
						guardedWrite: (_subject: string, write: () => unknown) => write(),
					}),
					nextWriteIndex: () => 1,
					turnIndex: 1,
					telemetryModel: "test-model",
					telemetrySessionId: "test-session",
					fixedThisTurn: new Set<string>(),
					reportedThisTurn: new Set<string>(),
					formatPipelineCrashNotice: () => "",
					lastCascadeOutput: "",
					cachedExports: new Map(),
					deferFormat: () => {},
				},
				cacheManager: {
					addModifiedRange: () => {},
					readTurnState: () => ({}),
				},
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(vi.mocked(runPipeline)).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath,
				}),
				expect.anything(),
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("#484 turn-summary collection gate", () => {
	beforeEach(async () => {
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
	});

	it("does not record diagnostics/autofix/format on the turn-summary collector when lens-turn-summary is off (default)", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: true,
			checkedClean: false,
			diagnostics: [
				{
					id: "d1",
					message: "unused var",
					filePath: "/repo/src/app.ts",
					line: 4,
					severity: "warning",
					semantic: "warning",
					tool: "eslint",
					rule: "no-unused-vars",
				},
			],
			formattersUsed: ["prettier"],
			fixedCount: 1,
			autofixTools: ["ruff:1"],
		});

		const env = setupTestEnvironment("pi-lens-turn-summary-off-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				// lens-turn-summary is never true here — default off
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(runtime.turnSummary.isEmpty()).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("records diagnostics, autofix, and format events on the turn-summary collector when lens-turn-summary is on", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: true,
			checkedClean: false,
			diagnostics: [
				{
					id: "d1",
					message: "unused var",
					filePath: "/repo/src/app.ts",
					line: 4,
					severity: "warning",
					semantic: "warning",
					tool: "eslint",
					rule: "no-unused-vars",
				},
			],
			formattersUsed: ["prettier"],
			fixedCount: 1,
			autofixTools: ["ruff:1"],
		});

		const env = setupTestEnvironment("pi-lens-turn-summary-on-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();

			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 export const x = 1;" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: (name: string) => name === "lens-turn-summary",
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(runtime.turnSummary.isEmpty()).toBe(false);
			const details = runtime.turnSummary.consume(1);
			expect(details.counts).toEqual({
				diagnostics: 1,
				autofixes: 1,
				formats: 1,
				byTool: {
					diagnostic: { eslint: 1 },
					autofix: { ruff: 1 },
					format: { prettier: 1 },
				},
			});
		} finally {
			env.cleanup();
		}
	});
});

describe("#3246 inline blocker provenance", () => {
	beforeEach(async () => {
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
	});

	it("stores the structured blockers the summary was rendered from", async () => {
		// The turn-end replay can only honor a later `lens_diagnostic_mark` if
		// the record carries a diagnostic IDENTITY; before #3246 this hop dropped
		// `dispatchResult.blockers` on the floor and kept only the rendered text.
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-3246-record-provenance-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "eval(input);\n");
			const blocker = {
				id: "b1",
				message: "eval() is banned",
				filePath,
				line: 1,
				severity: "error" as const,
				semantic: "blocking" as const,
				tool: "ast-grep",
				rule: "no-eval",
			};
			vi.mocked(runPipeline).mockResolvedValue({
				output: "🔴 STOP — 1 issue(s) must be fixed:\n  L1: eval() is banned",
				hasBlockers: true,
				isError: false,
				fileModified: false,
				checkedClean: false,
				inlineBlockerSummary:
					"🔴 STOP — 1 issue(s) must be fixed:\n  L1: eval() is banned",
				inlineBlockerSources: ["ast-grep"],
				inlineBlockerLines: [1],
				inlineBlockerDiagnostics: [blocker],
			});

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			await handleToolResult({
				event: {
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+  1 eval(input);" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				// biome-ignore lint/suspicious/noExplicitAny: partial dep surface.
			} as any);

			const record = runtime.getInlineBlockersSnapshot()[0];
			expect(record?.summary).toContain("eval() is banned");
			expect(record?.diagnostics).toEqual([blocker]);
		} finally {
			env.cleanup();
		}
	});
});

describe("path attribution across tool_call/tool_result (#1642)", () => {
	beforeEach(async () => {
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
		vi.mocked(pipeline.runPipeline).mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		logLatency.mockClear();
	});

	it("resolves a relative tool_result path against the call's own worktree cwd, never the parent checkout", async () => {
		const env = setupTestEnvironment("pi-lens-worktree-attribution-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			// Reproduce the #1642 report: a gitignored worktree (`.worktrees/`)
			// holds its own `src/app.ts`, same relative path as the parent
			// checkout's live `src/app.ts`. tool_call resolves and SKIPS the
			// worktree file (gitignored). The paired tool_result's own
			// authoritative `input.path` is the SAME relative string — it must
			// resolve that against the call's own cwd (the worktree, carried by
			// tool-call identity), never against the project root, which is
			// exactly the basis that used to collapse it onto the parent file.
			const parentRoot = env.tmpDir;
			fs.writeFileSync(path.join(parentRoot, ".gitignore"), ".worktrees/\n");
			const parentFile = createTempFile(
				parentRoot,
				"src/app.ts",
				"parent original\n",
			);
			const worktreeDir = path.join(parentRoot, ".worktrees", "wt1");
			const worktreeFile = createTempFile(
				worktreeDir,
				"src/app.ts",
				"worktree edited\n",
			);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = parentRoot;

			const dbg = vi.fn();
			const toolCallId = "call-1642";

			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolCallId,
						toolName: "edit",
						input: { path: "src/app.ts" },
					},
					ctx: { cwd: worktreeDir },
					lensEnabled: true,
					getFlag: (name: string) => name === "no-lsp",
					dbg,
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);

			await handleToolResult({
				event: {
					toolCallId,
					toolName: "edit",
					input: { path: "src/app.ts" },
					details: { diff: "+1 worktree edited" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg,
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			// tool_result must have resolved the WORKTREE file (not the parent)
			// and correctly recognized IT as gitignored — proving the basis
			// correction, not a stale skip flag, is what protects the parent.
			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining(
					`tool_result: skipping gitignored file ${worktreeFile}`,
				),
			);
			// No deferred-format work for EITHER file, and the parent checkout
			// is untouched — that is exactly what dirtied the live checkout in
			// the reported incident (the staleness fallback later formats
			// whatever got queued here).
			expect(runtime.pendingDeferredFormatCount).toBe(0);
			expect(fs.readFileSync(parentFile, "utf-8")).toBe("parent original\n");
			// No divergence between tool_call's call-time resolution and
			// tool_result's fresh one — both correctly landed on the worktree
			// file, so the pure-diagnostic refusal log must NOT fire here.
			expect(dbg).not.toHaveBeenCalledWith(
				expect.stringContaining("path_attribution_refused"),
			);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("runs the full pipeline for a brand-new file's write, not just an existing one (#1642 F1)", async () => {
		const env = setupTestEnvironment("pi-lens-new-file-pipeline-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			// `tool_call` fires PRE-execution — `existsSync` is false for every
			// path a write is about to CREATE. That must never be treated as a
			// "skip": folding it into the skip verdict made every new-file
			// write's paired tool_result refuse diagnostics/autofix/format
			// entirely (0 pipeline runs instead of 1) — a regression worse than
			// the bug #1642 fixes.
			const parentRoot = env.tmpDir;
			const newFilePath = path.join(parentRoot, "src", "brand-new.ts");
			fs.mkdirSync(path.dirname(newFilePath), { recursive: true });

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = parentRoot;
			const toolCallId = "call-new-file";

			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolCallId,
						toolName: "write",
						input: {
							path: "src/brand-new.ts",
							content: "export const x = 1;\n",
						},
					},
					ctx: { cwd: parentRoot },
					lensEnabled: true,
					getFlag: (name: string) => name === "no-lsp",
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);

			// The write itself executes on the host side between tool_call and
			// tool_result — the file exists by the time tool_result fires.
			fs.writeFileSync(newFilePath, "export const x = 1;\n");

			await handleToolResult({
				event: {
					toolCallId,
					toolName: "write",
					input: { path: "src/brand-new.ts", content: "export const x = 1;\n" },
					content: [],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("clears a recorded attribution when the paired tool_call is BLOCKED, so it never leaks into the correlation cache (#1642 F2)", async () => {
		const env = setupTestEnvironment("pi-lens-attribution-block-clear-");
		try {
			// A blocked call never gets a paired tool_result — the host never
			// lets the tool execute. Reproduce a block via the duplicate-export
			// guard (cachedExports), the simplest deterministic block path.
			createTempFile(
				env.tmpDir,
				"src/dupe.ts",
				"export const unrelated = 0;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.cachedExports.set(
				"existing",
				path.join(env.tmpDir, "src/elsewhere.ts"),
			);
			const toolCallId = "call-blocked";

			const result = await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolCallId,
						toolName: "write",
						input: {
							path: "src/dupe.ts",
							content: "export const existing = 2;\n",
						},
					},
					ctx: { cwd: env.tmpDir },
					lensEnabled: true,
					getFlag: (name: string) => name === "no-lsp",
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);

			expect((result as { block?: boolean } | undefined)?.block).toBe(true);
			// The attribution recorded before the block fired must be gone —
			// left behind, it would sit in the bounded correlation cache as
			// pure garbage until evicted, crowding out live in-flight records
			// under enough blocked-edit volume (reviewer-reproduced leak).
			expect(runtime.takeToolCallAttribution(toolCallId)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("fails closed on a relative path when a real correlation id exists but no attribution was recorded under it (#1642 F2)", async () => {
		const env = setupTestEnvironment("pi-lens-attribution-miss-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			// No handleToolCall ever ran for this id (evicted, or a host quirk)
			// — but the tool_result DOES carry a real correlation id. A relative
			// path here is ambiguous: guessing the project root as the basis is
			// exactly the #1642 collapse. This must fail CLOSED, not silently
			// fall back to the old naive resolution.
			resetVerifiedPathAttributionGuessCount();
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const dbg = vi.fn();

			await handleToolResult({
				event: {
					toolCallId: "call-never-seen-by-tool-call",
					toolName: "edit",
					input: { path: "src/app.ts" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg,
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(runtime.pendingDeferredFormatCount).toBe(0);
			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("path_attribution_missing"),
			);
			expect(getVerifiedPathAttributionGuessCount()).toBe(0);
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({ phase: "path_attribution_missing" }),
			);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("keeps a same-named workspace-root guess unverified without execution evidence (#1886)", async () => {
		const env = setupTestEnvironment("pi-lens-attribution-verified-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			resetVerifiedPathAttributionGuessCount();
			createTempFile(env.tmpDir, "src/app.ts", "parent original\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			await handleToolResult({
				event: {
					toolCallId: "call-verified-guess",
					toolName: "edit",
					input: { path: "src/app.ts" },
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: vi.fn(),
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			// A wrong-but-existing same-named file must not verify the guess.
			// MUTATION PROOF: restoring existence-only verification makes both
			// assertions fail because the tally increments and the full record is
			// suppressed.
			expect(getVerifiedPathAttributionGuessCount()).toBe(0);
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({ phase: "path_attribution_missing" }),
			);
		} finally {
			resetVerifiedPathAttributionGuessCount();
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("correlates by `callId` when the host doesn't populate `toolCallId` (#1642 F4)", async () => {
		const env = setupTestEnvironment("pi-lens-correlation-callid-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			// tool-event.ts documents that the host does not always populate
			// `toolCallId` — read-guard-logger.ts's own correlation resolver
			// already had to widen to callId/requestId/id for exactly this
			// reason. The path-attribution correlation must use the SAME
			// shared resolver, not a narrower `event.toolCallId`-only read.
			const worktreeDir = path.join(env.tmpDir, "worktree");
			const worktreeFile = createTempFile(worktreeDir, "src/app.ts", "x\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const callId = "callid-not-toolcallid";

			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						callId,
						toolName: "write",
						input: { path: "src/app.ts", content: "x\n" },
					},
					ctx: { cwd: worktreeDir },
					lensEnabled: true,
					getFlag: (name: string) => name === "no-lsp",
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any),
			);

			const dbg = vi.fn();
			await handleToolResult({
				event: {
					callId,
					toolName: "write",
					input: { path: "src/app.ts", content: "x\n" },
					content: [],
				},
				getFlag: () => false,
				dbg,
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			// No "path_attribution_missing" refusal — the callId-keyed
			// attribution WAS found, so the worktree file's own basis resolved
			// correctly and the write was processed normally.
			expect(dbg).not.toHaveBeenCalledWith(
				expect.stringContaining("path_attribution_missing"),
			);
			// Direct proof it queued the WORKTREE file specifically — not the
			// naive-resolved (and, here, DIFFERENT) parent-root path
			// `env.tmpDir/src/app.ts` that a callId-blind lookup would have
			// fallen back to.
			const queued = runtime
				.consumeDeferredFormatFiles()
				.map((record) => path.resolve(record.filePath));
			expect(queued).toContain(path.resolve(worktreeFile));
			expect(queued).not.toContain(path.resolve(env.tmpDir, "src/app.ts"));
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("correlates two concurrent calls correctly when their results arrive OUT OF ORDER (#1642, pi parallel-execution)", async () => {
		// pi's default execution model runs tool calls in parallel and
		// delivers results in COMPLETION order — call A, call B, result B,
		// result A is normal, not an edge case. An id-keyed correlation map
		// must not assume results arrive in call order.
		const env = setupTestEnvironment("pi-lens-out-of-order-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const worktreeA = path.join(env.tmpDir, "worktree-a");
			const worktreeB = path.join(env.tmpDir, "worktree-b");
			const fileA = createTempFile(worktreeA, "src/app.ts", "a\n");
			const fileB = createTempFile(worktreeB, "src/app.ts", "b\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const callDeps = (toolCallId: string, cwd: string) => ({
				event: {
					toolCallId,
					toolName: "write",
					input: { path: "src/app.ts", content: "x\n" },
				},
				ctx: { cwd },
				lensEnabled: true,
				getFlag: (name: string) => name === "no-lsp",
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				ensureLSPConfigInitialized: async () => {},
				updateLspStatus: () => {},
				resetLSPService: () => {},
			});

			// Call A, then call B (in order) — both fire before either result.
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps("call-A", worktreeA) as any),
			);
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps("call-B", worktreeB) as any),
			);

			const resultDeps = (toolCallId: string) => ({
				event: {
					toolCallId,
					toolName: "write",
					input: { path: "src/app.ts", content: "x\n" },
					content: [],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			});

			// Result B arrives BEFORE result A — out-of-order completion.
			await handleToolResult(resultDeps("call-B") as any);
			await handleToolResult(resultDeps("call-A") as any);

			// Each call's own attribution must have resolved against ITS OWN
			// worktree, regardless of arrival order — no cross-contamination.
			expect(fs.existsSync(fileA)).toBe(true);
			expect(fs.existsSync(fileB)).toBe(true);
			expect(runtime.takeToolCallAttribution("call-A")).toBeUndefined();
			expect(runtime.takeToolCallAttribution("call-B")).toBeUndefined();
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("keeps parallel nested codemode calls apart under an 86-char parent id (#3833)", async () => {
		// pi 0.99 codemode names nested calls `<parent>/<n>`; an OpenAI
		// Responses parent id (`call_id|item.id`) is ~80 chars, so the old
		// 64-char slice in sanitizeCorrelationId cut BOTH ids to the same key:
		// the second tool_call overwrote the first's attribution, the first
		// result took the wrong one, the second found none and refused with
		// path_attribution_missing -> a false-clean turn_end while both files
		// held blockers. Recurrence: two ids differing only after char 64.
		const env = setupTestEnvironment("pi-lens-nested-long-id-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const fileB = createTempFile(env.tmpDir, "b.ts", "debugger;\n");
			const fileC = createTempFile(env.tmpDir, "c.ts", "debugger;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const parent = `call_${"x".repeat(40)}|fc_${"y".repeat(40)}`;
			expect(parent.length).toBeGreaterThan(80);

			const dbg = vi.fn();
			const callDeps = (toolCallId: string, relPath: string) => ({
				event: {
					toolCallId,
					toolName: "write",
					input: { path: relPath, content: "debugger;\n" },
				},
				ctx: { cwd: env.tmpDir },
				lensEnabled: true,
				getFlag: (name: string) => name === "no-lsp",
				dbg,
				runtime,
				cacheManager: new CacheManager(false),
				ensureLSPConfigInitialized: async () => {},
				updateLspStatus: () => {},
				resetLSPService: () => {},
			});
			const resultDeps = (toolCallId: string, relPath: string) => ({
				event: {
					toolCallId,
					toolName: "write",
					input: { path: relPath, content: "debugger;\n" },
					content: [],
				},
				getFlag: () => false,
				dbg,
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			});

			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(`${parent}/1`, "b.ts") as any),
			);
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(`${parent}/2`, "c.ts") as any),
			);
			await handleToolResult(resultDeps(`${parent}/1`, "b.ts") as any);
			await handleToolResult(resultDeps(`${parent}/2`, "c.ts") as any);

			expect(dbg).not.toHaveBeenCalledWith(
				expect.stringContaining("path_attribution_missing"),
			);
			const queued = runtime
				.consumeDeferredFormatFiles()
				.map((record) => path.resolve(record.filePath));
			expect(queued).toContain(path.resolve(fileB));
			expect(queued).toContain(path.resolve(fileC));
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("logs the diagnostic path_attribution_refused when a genuine call-time/execution-time divergence occurs, but still processes the correct fresh path", async () => {
		const env = setupTestEnvironment("pi-lens-attribution-divergence-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			// Source-level fact: tool_call's own resolved path is not
			// authoritative — a later extension handler can mutate event.input
			// in place, or edit's prepareArguments can rewrite args before the
			// event fires (pi host agent-session.ts/types.ts). Simulate that by
			// recording an attribution for one gitignored path and then firing
			// tool_result with a DIFFERENT, non-ignored relative path under the
			// SAME basis — the fresh resolution wins and the file is processed;
			// the divergence is only logged, never gates the outcome.
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "ignored-dir/\n");
			createTempFile(env.tmpDir, "ignored-dir/old.ts", "old\n");
			const newFile = createTempFile(env.tmpDir, "src/new.ts", "new\n");

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.recordToolCallAttribution("call-rewritten", {
				resolvedPath: path.join(env.tmpDir, "ignored-dir", "old.ts"),
				skipped: true,
				originCwd: env.tmpDir,
			});

			const dbg = vi.fn();
			await handleToolResult({
				event: {
					toolCallId: "call-rewritten",
					toolName: "write",
					input: { path: "src/new.ts", content: "new\n" },
					content: [],
				},
				getFlag: () => false,
				dbg,
				runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("path_attribution_refused"),
			);
			// Diagnostic only — the freshly & correctly resolved (non-ignored)
			// path is what actually got processed.
			expect(runtime.pendingDeferredFormatCount).toBe(1);
			expect(fs.existsSync(newFile)).toBe(true);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});
});

/**
 * #4576: `~` on a host-supplied tool path. The tool_call seam
 * (`resolveToolCallFilePath` -> `resolveHostToolPath`) expands it, but the
 * tool_result seam used a bare `path.resolve`, so `~/proj/a.ts` became
 * `<projectRoot>/~/proj/a.ts` — a path that never existed — and that phantom
 * reached runner dispatch (biome `internalError/io`, then a synthetic
 * `coverage-unavailable` notice for a file the agent never touched).
 *
 * HOME/USERPROFILE are pinned to a directory below the test tmp root so
 * `os.homedir()` points there: the real maintainer home is never read or
 * written.
 */
describe("host tool path resolution on the tool_result side (#4576)", () => {
	function callDeps(runtime: RuntimeCoordinator, event: unknown) {
		return {
			event,
			ctx: { cwd: runtime.projectRoot },
			lensEnabled: true,
			getFlag: (name: string) => name === "no-lsp" || name === "no-complexity",
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
		} as never;
	}
	function resultDeps(runtime: RuntimeCoordinator, event: unknown) {
		return {
			event,
			getFlag: (name: string) => name === "no-lsp" || name === "no-complexity",
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			readGuard: runtime.readGuard,
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as never;
	}
	async function writeThroughRealSeams(
		runtime: RuntimeCoordinator,
		toolCallId: string,
		spelling: string,
	) {
		const input = { path: spelling, content: "export const value = 1;\n" };
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(
				callDeps(runtime, { toolName: "write", toolCallId, input }),
			),
		);
		await handleToolResult(
			resultDeps(runtime, {
				toolName: "write",
				toolCallId,
				input,
				content: [{ type: "text", text: "ok" }],
			}),
		);
	}
	/** The `filePath` every runner dispatch was handed, in call order. */
	function dispatchedPaths(): string[] {
		return vi
			.mocked(runPipeline)
			.mock.calls.map(([ctx]) => (ctx as { filePath?: string }).filePath ?? "");
	}

	it("dispatches the expanded home path, never the phantom <root>/~/ path", async () => {
		const env = setupTestEnvironment("pi-lens-4576-tilde-");
		// The fixture HOME lives outside the fixture root (#4591): the write path
		// spawns children that inherit HOME and `cwd`, and one of them writing after
		// this file's teardown sweep re-created a root the harness had just removed.
		// `pinFixtureHome` also keeps the home clear of `isPiOwnedTempPath`, which
		// claims every `<tmp>/pi-*` root and every direct `<tmp>/` child.
		let fixtureHome: ReturnType<typeof pinFixtureHome> | undefined;
		try {
			fixtureHome = pinFixtureHome("4576-tilde-home");
			const home = fixtureHome.home;
			const projectRoot = path.join(env.tmpDir, "workspace");
			const realFile = path.join(home, "proj", "src", "tilde.ts");
			fs.mkdirSync(path.dirname(realFile), { recursive: true });
			fs.mkdirSync(projectRoot, { recursive: true });
			fs.writeFileSync(path.join(home, "proj", "package.json"), "{}\n");
			fs.writeFileSync(realFile, "export const value = 1;\n");
			const runPipelineMock = vi.mocked(runPipeline);
			runPipelineMock.mockReset();
			runPipelineMock.mockResolvedValue({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
			} as never);
			// The pin is live before the handler runs: a stale HOME would make
			// every assertion below pass against the wrong directory.
			expect(os.homedir()).toBe(home);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = projectRoot;
			const phantom = path.join(projectRoot, "~", "proj", "src", "tilde.ts");

			await writeThroughRealSeams(
				runtime,
				"call-4576-tilde",
				"~/proj/src/tilde.ts",
			);

			expect(dispatchedPaths()[0]).toBe(realFile);
			// The phantom path is where the pre-fix resolver landed. No runner
			// may ever be dispatched for it: it is what produced the ghost
			// biome `internalError/io` and the synthetic coverage notice.
			expect(dispatchedPaths()).not.toContain(phantom);
			expect(
				dispatchedPaths().some((p) => p.includes(`${path.sep}~${path.sep}`)),
			).toBe(false);
		} finally {
			fixtureHome?.restore();
			env.cleanup();
		}
	});

	// #4577 N1: `~/x` is the spelling whose behaviour CHANGED, and the case
	// above drives it end to end. `~user/x` did NOT change (pi expands only `~`
	// and `~/`, and the pre-fix ternary also resolved a named-user tilde
	// against the base), so this is an agreement witness, not a regression
	// test: it reds if the two seams ever diverge again, which is the whole
	// defect #4576 fixed.
	it("leaves a ~user path resolved against the base, as the tool_call seam does", async () => {
		const env = setupTestEnvironment("pi-lens-4577-resolver-");
		const { home, restore } = pinFixtureHome("4577-resolver-user");
		const projectRoot = path.join(env.tmpDir, "workspace");
		const userFile = path.join(projectRoot, "~user", "proj", "a.ts");
		fs.mkdirSync(path.dirname(userFile), { recursive: true });
		fs.writeFileSync(userFile, "export const a = 1;\n");
		const runPipelineMock = vi.mocked(runPipeline);
		runPipelineMock.mockReset();
		runPipelineMock.mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		} as never);
		try {
			expect(os.homedir()).toBe(home);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = projectRoot;
			await writeThroughRealSeams(runtime, "call-4577-user", "~user/proj/a.ts");
			expect(dispatchedPaths()[0]).toBe(userFile);
		} finally {
			restore();
			env.cleanup();
		}
	});

	// PIN, not a regression test: a bare `~` resolves to the home DIRECTORY, so
	// no write result can target it and the handler has no effect to observe.
	// The pin keeps the resolver's third spelling from drifting silently.
	it("pins ~ resolving to the home directory itself", () => {
		const env = setupTestEnvironment("pi-lens-4577-resolver-");
		const { home, restore } = pinFixtureHome("4577-resolver-bare");
		const cwd = path.join(env.tmpDir, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		try {
			expect(os.homedir()).toBe(home);
			expect(resolveHostToolPath("~", cwd)).toBe(home);
		} finally {
			restore();
			env.cleanup();
		}
	});

	// #4577 (Greptile P1): a bash-derived synthetic write's path came FROM disk,
	// so its bytes are the identity. Re-resolving it through the host-tool
	// resolver folded U+202F to a space and dispatched `src/a b.ts` — a file that
	// does not exist — for a write that landed at `src/a\u202Fb.ts`. The
	// recovery caller states the provenance (`_pathAlreadyResolved`); nothing
	// re-detects it downstream.
	it("dispatches a recovered write's byte-exact path, never the folded spelling", async () => {
		const env = setupTestEnvironment("pi-lens-4577-recovered-");
		const projectRoot = path.join(env.tmpDir, "workspace");
		const writtenFile = path.join(projectRoot, "src", "a\u202Fb.ts");
		const foldedFile = path.join(projectRoot, "src", "a b.ts");
		fs.mkdirSync(path.dirname(writtenFile), { recursive: true });
		fs.writeFileSync(writtenFile, "export const a = 1;\n");
		const runPipelineMock = vi.mocked(runPipeline);
		runPipelineMock.mockReset();
		runPipelineMock.mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		} as never);
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = projectRoot;
			await handleToolResult(
				resultDeps(runtime, {
					toolName: "bash",
					toolCallId: "call-4577-recovered",
					input: { command: "tee 'src/a\u202Fb.ts'" },
					content: [{ type: "text", text: "export const a = 1;" }],
				}),
			);
			expect(dispatchedPaths()).toContain(writtenFile);
			expect(dispatchedPaths()).not.toContain(foldedFile);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #4504 r1: the root the prescan takes its baseline under is also the root the
 * rest of the bash path must use. Two bot findings on the #4504 fix pinned this:
 * a recognized write into another checkout was dropped, and a recovered write
 * was offered to the servers of a subtree that does not hold it.
 */
describe("the prescan root reaches the send and the recognized set (#4504 r1)", () => {
	/** The deps `index.ts` hands the `tool_result` hook, with the session's cwd. */
	function splitDeps(runtime: RuntimeCoordinator, event: unknown, cwd: string) {
		return {
			event,
			cwd,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			readGuard: runtime.readGuard,
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as never;
	}
	/**
	 * The two roots a concurrent-secondary session splits: the coordinator's
	 * `projectRoot` (the primary's checkout) and the session's own `cwd`. Plain
	 * directories are enough - the seam under test is which root each half
	 * derives, and the pending baseline is a real stat diff, not git's status.
	 */
	function splitDirs(
		env: ReturnType<typeof setupTestEnvironment>,
		tag: string,
	): { mainRoot: string; worktreeRoot: string } {
		const mainRoot = path.join(env.tmpDir, `${tag}-main`);
		const worktreeRoot = path.join(env.tmpDir, `${tag}-session`);
		fs.mkdirSync(mainRoot, { recursive: true });
		fs.mkdirSync(worktreeRoot, { recursive: true });
		return { mainRoot, worktreeRoot };
	}
	/** The real pre-write stat snapshot a `stat-diff` baseline holds. */
	async function baselineSnapshot(root: string) {
		const outcome = await captureFileStats(root, { withHashes: true });
		expect(outcome.unknownReason).toBeUndefined();
		return outcome.snapshot!;
	}
	/** The `filePath` every dispatch was handed, in call order. */
	function dispatchedPaths(): string[] {
		return vi
			.mocked(runPipeline)
			.mock.calls.map(([ctx]) => (ctx as { filePath?: string }).filePath ?? "");
	}
	beforeEach(() => {
		const runPipelineMock = vi.mocked(runPipeline);
		runPipelineMock.mockReset();
		runPipelineMock.mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		} as never);
	});
	afterEach(() => {
		// The shared per-session reset, not a hand-picked subset: `handleToolResult`
		// touches stores beyond the opaque baseline these cases write, and
		// `resetSessionScopedState` clears them all (the opaque store included).
		resetSessionScopedState();
	});

	// Greptile P1 on #4594: the scan of the secondary's own checkout cleared a
	// recognized write that landed in the primary's, so `out.ts` got no
	// dispatch and no mutation record. A scan may only judge the tree it ran in.
	it("keeps a recognized write that lands in the other checkout", async () => {
		const env = setupTestEnvironment("pi-lens-4504-r1-cross-");
		const { mainRoot, worktreeRoot } = splitDirs(env, "cross");
		try {
			const mainOut = path.join(mainRoot, "out.ts");
			fs.writeFileSync(mainOut, "export const out = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = mainRoot;
			const toolCallId = "4504-r1-cross";
			getOpaqueBaselineStore().record(
				opaqueBaselineSlot(worktreeRoot, runtime.sessionGeneration),
				toolCallId,
				{
					startedAt: Date.now(),
					strategy: "stat-diff",
					stats: await baselineSnapshot(worktreeRoot),
				},
			);
			const input = { command: `printf x > ${mainOut}` };
			// The test runs the command's effect itself, as pi's bash tool would.
			fs.writeFileSync(mainOut, "export const out = 2;\n");

			await handleToolResult(
				splitDeps(
					runtime,
					{
						toolName: "bash",
						toolCallId,
						input,
						isError: false,
						content: [{ type: "text", text: "ok" }],
					},
					worktreeRoot,
				),
			);

			expect(dispatchedPaths()).toContain(mainOut);
		} finally {
			env.cleanup();
		}
	});

	// Greptile P1 on #4594: the recovered files reach the servers that hold
	// them by root, so asking the coordinator's root found no holder in the
	// secondary's checkout and sent nothing before the dispatches read a check.
	it("sends a recovered worktree write to the servers that root it", async () => {
		const env = setupTestEnvironment("pi-lens-4504-r1-send-");
		const { mainRoot, worktreeRoot } = splitDirs(env, "send");
		const resync = vi.fn(async () => ({ sent: 1, drained: true }));
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = mainRoot;
			const held = path.join(worktreeRoot, "held.ts");
			const toolCallId = "4504-r1-send";
			getOpaqueBaselineStore().record(
				opaqueBaselineSlot(worktreeRoot, runtime.sessionGeneration),
				toolCallId,
				{
					startedAt: Date.now(),
					strategy: "stat-diff",
					stats: await baselineSnapshot(worktreeRoot),
				},
			);
			// The opaque command's own write, in the secondary's checkout.
			fs.writeFileSync(held, "export const held = 2;\n");
			installLspService(
				makeLspServiceDouble({
					getOpenDocumentPaths: (root: string) =>
						normalizeMapKey(root) === normalizeMapKey(worktreeRoot)
							? [normalizeMapKey(held)]
							: [],
					getTrackedContent: () => ({ hash: "held-before-the-write" }),
					resyncHeldPrimaries: resync,
				}),
			);
			// `peekLSPService` answers only for a service something has built.
			getLSPService();

			await handleToolResult(
				splitDeps(
					runtime,
					{
						toolName: "bash",
						toolCallId,
						input: { command: "node scripts/gen-held.mjs" },
						isError: false,
						content: [{ type: "text", text: "ok" }],
					},
					worktreeRoot,
				),
			);

			expect(resync).toHaveBeenCalledWith(
				[normalizeMapKey(held)],
				expect.any(Number),
			);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #1884 item 3: `tool_call` records a resolution basis only for a mutation and
 * `read` (`attributesMutationTarget` in `clients/runtime-tool-call.ts`). A
 * read-family tool that takes a RELATIVE path — `lsp_navigation` among them —
 * therefore reached the `path_attribution_missing` refusal and returned before
 * `details.searchReads` was registered, so the lines the navigation SHOWED the
 * agent were blocked on the follow-up edit. A `searchReads` entry carries its
 * own path, so the refusal (a rule about the call's named path) never had a
 * reason to cost those lines.
 */
describe("searchReads survive the path-attribution refusal (#1884)", () => {
	it("registers an lsp_navigation result's shown lines when its relative path has no attribution (#1884)", async () => {
		const env = setupTestEnvironment("pi-lens-1884-nav-searchreads-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				filePath,
				Array.from({ length: 120 }, (_, i) => `line${i + 1}`).join("\n") + "\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cacheManager = new CacheManager(false);
			// Production order: the call, then its result. `lsp_navigation`
			// declares `path` (not `filePath`), and `tool_call` attributes no
			// resolution basis for a tool that is neither a mutation nor `read`,
			// so this result arrives with a relative path and no basis under it.
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					event: {
						toolName: "lsp_navigation",
						toolCallId: "1884-nav",
						input: { operation: "references", path: "src/app.ts", line: 42 },
					},
					ctx: { cwd: env.tmpDir },
					lensEnabled: true,
					getFlag: (name: string) => name === "no-lsp",
					dbg: () => {},
					runtime,
					cacheManager,
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as never),
			);

			const dbg = vi.fn();
			await handleToolResult({
				event: {
					toolName: "lsp_navigation",
					toolCallId: "1884-nav",
					input: { operation: "references", path: "src/app.ts", line: 42 },
					content: [{ type: "text", text: `${filePath}:42: line42` }],
					details: {
						operation: "references",
						searchReads: [{ file: filePath, startLine: 42, endLine: 42 }],
					},
				},
				getFlag: () => false,
				dbg,
				runtime,
				cacheManager,
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as never);

			// The refusal still fires: nothing path-keyed ran for the call's own
			// relative path, so turn state and dispatch stay fail-closed.
			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("path_attribution_missing"),
			);
			// ...and the line the navigation SHOWED counts as read, so the
			// follow-up edit to it is not blocked.
			expect(runtime.readGuard.checkEdit(filePath, [42, 42]).action).toBe(
				"allow",
			);
			// Only the shown line: a region the result never delivered is still
			// guarded (#1904).
			expect(runtime.readGuard.checkEdit(filePath, [100, 100]).action).toBe(
				"block",
			);
		} finally {
			env.cleanup();
		}
	});
});
