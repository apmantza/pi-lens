/**
 * #3598: `cargo clippy --fix` rewrites every fixable file of the crate, but the
 * pipeline's hold on pi's file-mutation queue covers only the edited target.
 * An agent edit to a SIBLING file that lands while clippy runs was erased by
 * clippy's later write (the tool had read the file before the edit).
 *
 * The real `runPipeline` and its Rust autofix path run, and the real
 * `handleToolResult` delivers the agent's edit. Only the process boundary is
 * faked: `cargo clippy --fix` is a gated double that rewrites sibling files at
 * a moment the test chooses, so each interleaving is pinned with gates rather
 * than timers.
 *
 * Recurrence guarded: an agent edit erased by a whole-package fixer that pi's
 * queue cannot see (#3541's remainder), and the same edit lost silently when
 * the capture itself was already overwritten.
 */
import * as fs from "node:fs";
import * as path from "node:path";
// pi's real per-file queue, the one its `edit`/`write` tools run under.
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import * as latencyLogger from "../../clients/latency-logger.js";
import type { BiomeClient } from "../../clients/biome-client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { MetricsClient } from "../../clients/metrics-client.js";
import {
	type PipelineContext,
	type PipelineDeps,
	runPipeline,
} from "../../clients/pipeline.js";
import type { RuffClient } from "../../clients/ruff-client.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	_resetAgentNudgeForTests,
	consumeAgentNudge,
} from "../../clients/agent-nudge.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import {
	beginFixRun,
	expectationFromToolInput,
	FIX_RUN_MAX_FILE_BYTES,
	noteAgentMutation,
	runWithFixRestore,
} from "../../clients/fix-run-restore.js";
import {
	setHostFileMutationQueueLoader,
	withHostFileMutationQueues,
} from "../../clients/file-mutation-queue.js";
import { getProcessSingleton } from "../../clients/process-singletons.js";
import { beginScope } from "../../clients/session-scope.js";
import {
	type MutationBridgeDeps,
	recordMutationThroughSeam,
} from "../../clients/mutation-bridge.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { waitFor } from "./interleaving-kit.js";
import { setupTestEnvironment } from "./test-utils.js";

const fake = vi.hoisted(() => ({
	/** The body of the fake `cargo clippy --fix`; it runs where clippy would. */
	clippy: undefined as undefined | ((cwd: string) => Promise<number>),
	/** The body of the fake `dart fix --apply`. */
	dartFix: undefined as undefined | ((cwd: string) => Promise<number>),
	/** What `dart fix` was spawned with: the argv and the directory it ran in. */
	dartFixCalls: [] as Array<{ args: readonly string[]; cwd?: string }>,
}));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: vi.fn(
			async (
				command: string,
				args: readonly string[],
				options?: Parameters<typeof actual.safeSpawnAsync>[2],
			) => {
				if (command === "cargo" && args[0] === "--version") {
					return { stdout: "cargo 1.82.0", stderr: "", status: 0 };
				}
				if (command === "cargo" && args[0] === "clippy") {
					const status = (await fake.clippy?.(options?.cwd ?? "")) ?? 0;
					return { stdout: "", stderr: "", status };
				}
				if (command === "dart" && args[0] === "--version") {
					return { stdout: "Dart SDK version: 3.5.0", stderr: "", status: 0 };
				}
				if (command === "dart" && args[0] === "fix") {
					fake.dartFixCalls.push({ args: [...args], cwd: options?.cwd });
					const status = (await fake.dartFix?.(options?.cwd ?? "")) ?? 0;
					return { stdout: "", stderr: "", status };
				}
				return actual.safeSpawnAsync(command, [...args], options);
			},
		),
	};
});

vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/integration.js")
	>()),
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));
import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";

vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(),
}));
import { getLSPService } from "../../clients/lsp/index.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

/** The registry of runs whose restore has not ended (`fix-run-restore.ts`). */
function activeFixRuns(): Set<unknown> {
	return getProcessSingleton<{ active: Set<unknown> }>(
		"fix-run-restore",
		1,
		() => ({ active: new Set() }),
	).active;
}

/**
 * The restore ends after the pipeline's result (#3830), so a test that reads
 * what it wrote, or the notice it queued, waits for the registry to empty and
 * then lets the notice's promise chain run.
 */
async function restoreSettled(): Promise<void> {
	await waitFor(
		() => activeFixRuns().size,
		(size) => size === 0,
		{ timeoutMs: 3000 },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
}

const ORIGINAL = "pub fn f() { let x = 1; }\n";
const TOOL_FIXED = "pub fn f() { let _x = 1; }\n";
const KIND = "fix-run-agent-edit-overwritten";

describe("whole-package fixer restores agent edits (#3598)", () => {
	let tmpDir: string;
	let cleanup: () => void;
	let srcDir: string;
	let mainRs: string;
	let previousDebounce: string | undefined;

	beforeEach(() => {
		notices = [];
		resetDegradationLedger();
		_resetAgentNudgeForTests();
		previousDebounce = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "0";
		const env = setupTestEnvironment("pi-lens-fix-run-restore-");
		tmpDir = env.tmpDir;
		cleanup = env.cleanup;
		const crateDir = path.join(tmpDir, "crate");
		srcDir = path.join(crateDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			path.join(crateDir, "Cargo.toml"),
			'[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[workspace]\nmembers = ["crate"]\n',
		);
		mainRs = path.join(srcDir, "main.rs");
		fs.writeFileSync(mainRs, "mod a;\nmod b;\nfn main() {}\n");
		fs.writeFileSync(path.join(srcDir, "a.rs"), ORIGINAL);
		fs.writeFileSync(path.join(srcDir, "b.rs"), ORIGINAL);
		vi.mocked(getLSPService).mockReturnValue(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
			}) as never,
		);
		vi.mocked(dispatchLintWithResult).mockReset();
		vi.mocked(dispatchLintWithResult).mockResolvedValue({
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: false,
		});
	});

	afterEach(() => {
		fake.clippy = undefined;
		fake.dartFix = undefined;
		fake.dartFixCalls.length = 0;
		if (previousDebounce === undefined)
			delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		else process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounce;
		cleanup();
	});

	function pipelineDeps(): PipelineDeps {
		return {
			biomeClient: {
				isSupportedFile: () => true,
				ensureAvailable: async () => false,
				fixFileAsync: async () => ({ success: true, changed: false, fixed: 0 }),
			} as unknown as BiomeClient,
			ruffClient: {
				isPythonFile: () => false,
				ensureAvailable: async () => false,
			} as unknown as RuffClient,
			testRunnerClient: new TestRunnerClient(),
			metricsClient: new MetricsClient(),
			getFormatService: () => ({}) as never,
			fixedThisTurn: new Set(),
		} as PipelineDeps;
	}

	/** The loss notices the pipeline handed to its host (the advisory queue's seam). */
	let notices: string[] = [];
	const noticeText = () => notices.join("\n");

	function pipelineContext(filePath: string): PipelineContext {
		return {
			filePath,
			cwd: tmpDir,
			toolName: "write",
			getFlag: () => false,
			dbg: () => {},
			onFixRunLoss: (notice) => notices.push(notice),
		};
	}

	/** `runPipeline`, then the restore it detached from its result (#3830). */
	async function runPipelineSettled(
		...args: Parameters<typeof runPipeline>
	): Promise<Awaited<ReturnType<typeof runPipeline>>> {
		const result = await runPipeline(...args);
		await restoreSettled();
		return result;
	}

	/**
	 * The agent's own `edit` of `file`, delivered the way pi delivers it: the
	 * host tool writes the file, then the real tool_result handler runs.
	 * `write` is separate from `deliver` so a test can put the fixer's write
	 * between the two.
	 */
	function agentEdit(
		file: string,
		newText: string,
		kind: "edit" | "write" = "edit",
		isError = false,
		opts: {
			/** The bytes the host tool leaves on disk (default `newText\n`). */
			bytes?: string;
			/** The executed tool input (default: a one-edit `edit`, or a `write`). */
			input?: Record<string, unknown>;
			/** Correlates `start` and `deliver`, as pi's tool_call/tool_result do. */
			toolCallId?: string;
			/** A write runs the immediate autofix: leave it on for a test about it. */
			autofix?: boolean;
		} = {},
	) {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "fix-run-restore" });
		runtime.beginTurn();
		const input =
			opts.input ??
			(kind === "write"
				? { path: file, content: `${newText}\n` }
				: { path: file, edits: [{ oldText: "let x = 1;", newText }] });
		return {
			runtime,
			write: () => fs.writeFileSync(file, opts.bytes ?? `${newText}\n`),
			/** pi's tool_call for this edit: the host tool is about to run. */
			start: async () => {
				return handleToolCall({
					event: {
						toolCallId: opts.toolCallId,
						toolName: kind,
						input,
					},
					ctx: { cwd: tmpDir },
					lensEnabled: true,
					getFlag: (flag: string) => flag === "no-lsp",
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as never);
			},
			deliver: async () => {
				await handleToolResult({
					event: {
						toolCallId: opts.toolCallId,
						toolName: kind,
						input,
						details: {},
						content: [{ type: "text", text: "ok" }],
						...(isError && { isError: true }),
					},
					// A write runs the immediate autofix, which would start a second
					// fake clippy inside this delivery.
					getFlag: (flag: string) =>
						kind === "write" && !opts.autofix && flag === "no-autofix",
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
				} as unknown as Parameters<typeof handleToolResult>[0]);
			},
		};
	}

	function overwrittenCount(): number {
		return (
			getDegradationSummary().find((group) => group.kind === KIND)?.count ?? 0
		);
	}

	it("keeps an agent edit to a sibling file that landed during the run", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		proceed.open();
		const result = await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(result.changedFiles ?? []).not.toContain(aRs);
		expect(overwrittenCount()).toBe(1);
	});

	it("leaves the tool's fix on a sibling the agent did not edit", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const bRs = path.join(srcDir, "b.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			fs.writeFileSync(bRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		proceed.open();
		const result = await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(fs.readFileSync(bRs, "utf-8")).toBe(TOOL_FIXED);
		expect(result.changedFiles).toContain(bRs);
	});

	it("does not rewrite a sibling the agent edited and the tool did not touch", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		// A fixed old mtime: any rewrite after this moves it.
		fs.utimesSync(aRs, 1_000_000, 1_000_000);
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(fs.statSync(aRs).mtimeMs).toBe(1_000_000_000);
		expect(overwrittenCount()).toBe(0);
	});

	it("leaves a file the tool created alone", async () => {
		const created = path.join(srcDir, "generated.rs");
		const started = gate();
		const created$ = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			fs.writeFileSync(created, "let x = 1;\n// created by the tool\n");
			created$.open();
			await proceed.p;
			fs.writeFileSync(created, "// tool rewrote its own file\n");
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		await created$.p;
		// The agent edits the tool's new file during the run. It was not in the
		// pre-run set, so nothing is captured and the tool's rewrite stands.
		const edit = agentEdit(created, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		proceed.open();
		await run;

		expect(fs.readFileSync(created, "utf-8")).toBe(
			"// tool rewrote its own file\n",
		);
		expect(overwrittenCount()).toBe(0);
	});

	it("restores the agent edit even when the tool exits nonzero after writing", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 101;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(overwrittenCount()).toBe(1);
	});

	it("records exactly one degradation for a run that overwrote several edits", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const bRs = path.join(srcDir, "b.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			fs.writeFileSync(bRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		for (const file of [aRs, bRs]) {
			const edit = agentEdit(file, "let AGENT = 1;");
			edit.write();
			await edit.deliver();
		}
		proceed.open();
		await run;

		expect(overwrittenCount()).toBe(1);
		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(fs.readFileSync(bRs, "utf-8")).toBe("let AGENT = 1;\n");
	});

	it("reports a lost edit by file name when the tool wrote before the capture", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		// The agent's host tool wrote a.rs; the fixer then wrote its stale-based
		// content; only THEN does pi-lens's tool_result read the file.
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		fs.writeFileSync(aRs, TOOL_FIXED);
		await edit.deliver();
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
		expect(noticeText()).toContain("a.rs");
		expect(noticeText()).toContain("re-apply");
		expect(overwrittenCount()).toBe(1);
	});

	// Recurrence: AGENTS.md shape 53. The notice is delivered from a detached
	// promise chain (#3830), so a host callback that throws would be an unhandled
	// rejection, which kills the pi host. It is a debug line instead.
	it("survives a loss-notice callback that throws", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};
		const dbg = vi.fn();
		const run = runPipelineSettled(
			{
				...pipelineContext(mainRs),
				dbg,
				onFixRunLoss: () => {
					throw new Error("advisory queue exploded");
				},
			},
			pipelineDeps(),
		);
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		fs.writeFileSync(aRs, TOOL_FIXED);
		await edit.deliver();
		proceed.open();
		await run;

		expect(dbg).toHaveBeenCalledWith(
			expect.stringContaining(
				"fix-run loss notice failed: advisory queue exploded",
			),
		);
	});

	it("warns at agent_end when the deferred fix run overwrote an edit it could not restore", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.deferMutation(mainRs, tmpDir, "edit", tmpDir, "autofix");
		const notify = vi.fn();

		const drain = handleAgentEnd({
			ctxCwd: tmpDir,
			getFlag: (name: string) => name === "no-lsp",
			notify,
			dbg: () => {},
			runtime,
			cacheManager: { addModifiedRange: vi.fn() } as never,
			biomeClient: {} as never,
			ruffClient: {} as never,
			getFormatService: () =>
				({
					recordRead: () => {},
					formatFile: async (filePath: string) => ({
						filePath,
						formatters: [],
						anyChanged: false,
						allSucceeded: true,
					}),
				}) as never,
		});
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		fs.writeFileSync(aRs, TOOL_FIXED);
		await edit.deliver();
		proceed.open();
		await drain;

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("a.rs"),
			"warning",
		);
		// The agent, not only the UI, is told: the next `context` call of THIS
		// session carries it, and another session's call (#3748) does not.
		expect(
			consumeAgentNudge(undefined, beginScope({ role: "secondary" })),
		).toBeUndefined();
		const nudge = consumeAgentNudge(undefined, runtime.sessionScope);
		expect(nudge?.messages[0]?.content).toContain("a.rs");
	});

	it("does not hand a lost-edit advisory to the session that replaced the drain's own (#3748)", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.deferMutation(mainRs, tmpDir, "edit", tmpDir, "autofix");
		const notify = vi.fn();

		const drain = handleAgentEnd({
			ctxCwd: tmpDir,
			getFlag: (name: string) => name === "no-lsp",
			notify,
			dbg: () => {},
			runtime,
			cacheManager: { addModifiedRange: vi.fn() } as never,
			biomeClient: {} as never,
			ruffClient: {} as never,
			getFormatService: () =>
				({
					recordRead: () => {},
					formatFile: async (filePath: string) => ({
						filePath,
						formatters: [],
						anyChanged: false,
						allSucceeded: true,
					}),
				}) as never,
		});
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		fs.writeFileSync(aRs, TOOL_FIXED);
		await edit.deliver();
		// `/new` lands while the drain awaits its fixer.
		runtime.resetForSession();
		proceed.open();
		await drain;

		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();
	});

	it("reports a lost write when the tool overwrote it before the capture", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const write = agentEdit(aRs, "let AGENT = 1;", "write");
		write.write();
		// The tool's stale-based bytes contain none of the agent's content.
		fs.writeFileSync(aRs, TOOL_FIXED);
		await write.deliver();
		proceed.open();
		await run;

		expect(noticeText()).toContain("a.rs");
		expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
	});

	it("does not capture or report an edit the host tool failed", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		// The tool fixed a.rs; the agent's edit of it then failed (nothing written).
		fs.writeFileSync(aRs, TOOL_FIXED);
		const failed = agentEdit(aRs, "let AGENT = 1;", "edit", true);
		await failed.deliver();
		proceed.open();
		await run;

		expect(noticeText()).not.toContain("re-apply");
		expect(overwrittenCount()).toBe(0);
		expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
	});

	// --- Round 2 (#3741 review): the restore never writes over content newer
	// than the capture, and never recreates a file absent at restore time. ---

	it("restores an edit to a CRLF file whose multi-line newText the host normalised to LF", async () => {
		// F1: pi's edit tool matches in LF and writes the file back in its
		// original line endings, so the input's newText never appears in the
		// bytes on disk verbatim.
		const aRs = path.join(srcDir, "a.rs");
		fs.writeFileSync(aRs, "pub fn f() {\r\n    let x = 1;\r\n}\r\n");
		const agentBytes =
			"pub fn f() {\r\n    let a = 1;\r\n    let b = 2;\r\n}\r\n";
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, "pub fn f() {\r\n    let _x = 1;\r\n}\r\n");
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let a = 1;\n    let b = 2;", "edit", false, {
			bytes: agentBytes,
		});
		edit.write();
		await edit.deliver();
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe(agentBytes);
		expect(noticeText()).not.toContain("re-apply");
		expect(overwrittenCount()).toBe(1);
	});

	it("still reports a CRLF edit the tool overwrote before the capture", async () => {
		const aRs = path.join(srcDir, "a.rs");
		fs.writeFileSync(aRs, "pub fn f() {\r\n    let x = 1;\r\n}\r\n");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let a = 1;\n    let b = 2;", "edit", false, {
			bytes: "pub fn f() {\r\n    let a = 1;\r\n    let b = 2;\r\n}\r\n",
		});
		edit.write();
		fs.writeFileSync(aRs, "pub fn f() {\r\n    let _x = 1;\r\n}\r\n");
		await edit.deliver();
		proceed.open();
		await run;

		expect(noticeText()).toContain("a.rs");
	});

	it("does not recreate a file the agent deleted after its edit", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		fs.rmSync(aRs);
		proceed.open();
		await run;

		expect(fs.existsSync(aRs)).toBe(false);
		expect(overwrittenCount()).toBe(0);
	});

	it("does not recreate the old path of a file the agent renamed after its edit", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const renamed = path.join(srcDir, "a2.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		fs.renameSync(aRs, renamed);
		proceed.open();
		await run;

		expect(fs.existsSync(aRs)).toBe(false);
		expect(fs.readFileSync(renamed, "utf-8")).toBe("let AGENT = 1;\n");
	});

	it("does not restore an older capture over a newer edit whose tool_result is late", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const first = agentEdit(aRs, "let ONE = 1;");
		first.write();
		await first.deliver();
		// The second edit's host tool has started and written; pi has not yet
		// delivered its tool_result when the fixer run settles.
		const second = agentEdit(aRs, "let TWO = 1;", "write", false, {
			toolCallId: "late-2",
		});
		await second.start();
		second.write();
		proceed.open();
		await run;
		await second.deliver();

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let TWO = 1;\n");
		expect(noticeText()).toContain("a.rs");
		// #3830: the skip is counted once, so an operator can see how often a
		// newer edit won.
		expect(
			getDegradationSummary().find(
				(group) => group.kind === "fix-run-restore-skipped-newer-edit",
			)?.count,
		).toBe(1);
	});

	it("restores after a second edit whose tool_result was delivered", async () => {
		// The in-flight mark ends at the tool_result: a delivered edit is captured.
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const second = agentEdit(aRs, "let TWO = 1;", "write", false, {
			toolCallId: "delivered-2",
		});
		await second.start();
		second.write();
		await second.deliver();
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let TWO = 1;\n");
		expect(overwrittenCount()).toBe(1);
	});

	it("does not treat a blocked edit as in flight", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const first = agentEdit(aRs, "let ONE = 1;");
		first.write();
		await first.deliver();
		// pi-lens's read guard refuses an edit of a file this session never read:
		// the host tool never runs and no tool_result follows.
		const blocked = agentEdit(aRs, "let TWO = 1;", "edit", false, {
			toolCallId: "blocked-2",
		});
		const verdict = await blocked.start();
		expect(verdict).toMatchObject({ block: true });
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let ONE = 1;\n");
		expect(noticeText()).not.toContain("cannot confirm");
	});

	it("does not write over a newer edit that lands while the restore is reading", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let ONE = 1;");
		edit.write();
		await edit.deliver();
		// The boundary double: a newer edit lands right after the restore's read.
		const realRead = fs.promises.readFile;
		let armed = true;
		const spy = vi
			.spyOn(fs.promises, "readFile")
			.mockImplementation(async (...args: Parameters<typeof realRead>) => {
				const bytes = await realRead(...args);
				if (armed && String(args[0]) === aRs) {
					armed = false;
					fs.writeFileSync(aRs, "let NEWER = 1;\n");
				}
				return bytes;
			});
		try {
			proceed.open();
			await run;
			expect(fs.readFileSync(aRs, "utf-8")).toBe("let NEWER = 1;\n");
			expect(noticeText()).toContain("a.rs");
		} finally {
			spy.mockRestore();
		}
	});

	it("names a bridged edit as possibly lost, since nothing verifies its bytes", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		fs.writeFileSync(aRs, "let BRIDGED = 1;\n");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "fix-run-restore-possibly" });
		runtime.beginTurn();
		recordMutationThroughSeam(
			{ filePath: aRs, kind: "edit" },
			{
				getRuntime: () => runtime as never,
				getCacheManager: () => new CacheManager(false),
				getProjectRoot: () => tmpDir,
				getDispatchCwd: () => tmpDir,
				countFileLines,
				isRecordable: () => true,
				dbg: () => {},
			},
		);
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let BRIDGED = 1;\n");
		expect(noticeText()).toContain("a.rs");
	});

	it("reports a deletion-only edit the tool overwrote before the capture", async () => {
		// The edit's newText is empty, so only the removed oldText can prove it.
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "", "edit", false, {
			bytes: "pub fn f() {  }\n",
		});
		edit.write();
		fs.writeFileSync(aRs, `${ORIGINAL}// tool\n`);
		await edit.deliver();
		proceed.open();
		await run;

		expect(noticeText()).toContain("a.rs");
	});

	it("records one cost row for the pre-run hash", async () => {
		const spy = vi.spyOn(latencyLogger, "logLatency");
		try {
			fake.clippy = async () => 0;
			await runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
			const rows = spy.mock.calls
				.map(([row]) => row)
				.filter((row) => row.phase === "fix_run_hash");
			expect(rows).toHaveLength(1);
			// main.rs, a.rs and b.rs are the crate's Rust files.
			expect(rows[0]?.metadata).toMatchObject({
				tool: "rust-clippy",
				files: 3,
				bytes:
					Buffer.byteLength("mod a;\nmod b;\nfn main() {}\n") +
					2 * ORIGINAL.length,
			});
			expect(typeof rows[0]?.durationMs).toBe("number");
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps an edit recorded through the mutation bridge that landed during the run", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		// An observed or third-party producer: no tool input, so the capture is
		// taken unverified, and it still survives the fixer's later write.
		fs.writeFileSync(aRs, "let BRIDGED = 1;\n");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "fix-run-restore-bridge" });
		runtime.beginTurn();
		const deps: MutationBridgeDeps = {
			getRuntime: () => runtime as never,
			getCacheManager: () => new CacheManager(false),
			getProjectRoot: () => tmpDir,
			getDispatchCwd: () => tmpDir,
			countFileLines,
			isRecordable: () => true,
			dbg: () => {},
		};
		expect(
			recordMutationThroughSeam({ filePath: aRs, kind: "edit" }, deps),
		).toBe(true);
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let BRIDGED = 1;\n");
		expect(overwrittenCount()).toBe(1);
	});

	it("does not restore over a fix when the delivered edit left the bytes unchanged", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		// An edit whose result equals the pre-run bytes is not a change to protect.
		const edit = agentEdit(aRs, "let x = 1;");
		fs.writeFileSync(aRs, ORIGINAL);
		await edit.deliver();
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
		expect(overwrittenCount()).toBe(0);
	});

	it("leaves the tool's fix over an agent edit that landed before the run", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		fake.clippy = async () => {
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		await runPipelineSettled(pipelineContext(mainRs), pipelineDeps());

		expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
		expect(overwrittenCount()).toBe(0);
	});

	it("keeps an agent edit to a Dart sibling during dart fix --apply", async () => {
		const libDir = path.join(tmpDir, "pkg", "lib");
		fs.mkdirSync(libDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "pkg", "pubspec.yaml"),
			"name: fixture\nenvironment:\n  sdk: ^3.5.0\n",
		);
		// The agreement evidence is anchored at the pipeline cwd (#3005 fixture
		// recurrence, as the Cargo.toml above).
		fs.writeFileSync(path.join(tmpDir, "pubspec.yaml"), "name: root\n");
		const mainDart = path.join(libDir, "main.dart");
		const aDart = path.join(libDir, "a.dart");
		fs.writeFileSync(mainDart, "void main() {}\n");
		fs.writeFileSync(aDart, "int a() => 1;\n");
		const started = gate();
		const proceed = gate();
		fake.dartFix = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aDart, "int a() => 1; // tool\n");
			return 0;
		};

		const run = runPipelineSettled(pipelineContext(mainDart), pipelineDeps());
		await started.p;
		fs.writeFileSync(aDart, "int a() => AGENT;\n");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "fix-run-restore-dart" });
		runtime.beginTurn();
		await handleToolResult({
			event: {
				toolName: "write",
				input: { path: aDart, content: "int a() => AGENT;\n" },
				details: {},
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: (flag: string) => flag === "no-autofix",
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
		} as unknown as Parameters<typeof handleToolResult>[0]);
		proceed.open();
		const result = await run;

		expect(fs.readFileSync(aDart, "utf-8")).toBe("int a() => AGENT;\n");
		expect(overwrittenCount()).toBe(1);
		// #3914 r1 F5: the restored sibling is the agent's change, not the fixer's
		// (`tryDartFix` hands the diff its `agentEdited`, as `tryRustClippyFix` does).
		expect(result.changedFiles ?? []).not.toContain(aDart);
	});

	// #3780 (#3741 survivors, pipeline.ts `tryDartFix`): the Dart run is pinned
	// by what it is spawned with and what it hashes, not only by the restore
	// outcome. The restore test above keys the double on `args[0] === "fix"`
	// alone, so a dropped `--apply`, a dropped cwd, or a run that hashed every
	// file of the package (its pubspec.yaml too) all kept it green.
	it("spawns `dart fix --apply` in the pubspec directory and hashes only its .dart files", async () => {
		const pkgDir = path.join(tmpDir, "pkg");
		const libDir = path.join(pkgDir, "lib");
		fs.mkdirSync(libDir, { recursive: true });
		fs.writeFileSync(
			path.join(pkgDir, "pubspec.yaml"),
			"name: fixture\nenvironment:\n  sdk: ^3.5.0\n",
		);
		fs.writeFileSync(path.join(tmpDir, "pubspec.yaml"), "name: root\n");
		const mainDart = path.join(libDir, "main.dart");
		fs.writeFileSync(mainDart, "void main() {}\n");
		fs.writeFileSync(path.join(libDir, "a.dart"), "int a() => 1;\n");
		const spy = vi.spyOn(latencyLogger, "logLatency");
		try {
			fake.dartFix = async () => 0;
			await runPipelineSettled(pipelineContext(mainDart), pipelineDeps());

			expect(fake.dartFixCalls).toEqual([
				{ args: ["fix", "--apply"], cwd: pkgDir },
			]);
			const rows = spy.mock.calls
				.map(([row]) => row)
				.filter((row) => row.phase === "fix_run_hash");
			expect(rows).toHaveLength(1);
			// main.dart and a.dart; the package's pubspec.yaml is not a Dart file.
			expect(rows[0]?.metadata).toMatchObject({
				tool: "dart-analyze",
				files: 2,
			});
		} finally {
			spy.mockRestore();
		}
	});

	// #3780 (#3741 survivors, pipeline.ts `autofixLostFiles` / `autofixPossiblyLostFiles`
	// initial values): an autofix phase that never ran (deferred to agent_end)
	// lost nothing, so the tool result carries no loss notice.
	it("appends no fix-run loss notice when the autofix phase was deferred", async () => {
		const result = await runPipelineSettled(
			{ ...pipelineContext(mainRs), autofixMode: "deferred" },
			pipelineDeps(),
		);

		expect(result.output).not.toContain("auto-fix run");
		expect(noticeText()).toBe("");
	});

	/**
	 * #3830: the restore runs under pi's queue for the sibling, the way the
	 * agent's own `edit` does. pi's queue is the real one; the interleavings are
	 * pinned by parking the restore's own filesystem calls.
	 */
	describe("the restore and pi's per-file queue (#3830)", () => {
		beforeEach(() => {
			setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
		});
		afterEach(() => {
			setHostFileMutationQueueLoader(undefined);
			vi.restoreAllMocks();
		});

		/** pi's edit tool shape: a read-modify-write inside the file's queue. */
		function agentAppend(file: string, line: string) {
			let wrote = false;
			const done = withFileMutationQueue(file, async () => {
				fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}${line}`);
				wrote = true;
			});
			return { done, wrote: () => wrote };
		}

		/**
		 * Resolves once every queue call made before it has registered: pi chains
		 * registrations through one promise, so a call on another path registers
		 * after them, and a call whose file is free has run by then.
		 */
		function afterQueueRegistration(): Promise<void> {
			return withFileMutationQueue(
				path.join(tmpDir, "registration-barrier"),
				async () => {},
			);
		}

		/** Parks the first atomic write of `target` between its staging write and its rename. */
		function parkRenameOf(target: string) {
			const parked = gate();
			const resume = gate();
			const realRename = fs.promises.rename;
			let armed = true;
			vi.spyOn(fs.promises, "rename").mockImplementation(
				async (...args: Parameters<typeof realRename>) => {
					if (armed && String(args[1]) === target) {
						armed = false;
						parked.open();
						await resume.p;
					}
					return realRename(...args);
				},
			);
			return { parked: parked.p, resume: resume.open };
		}

		/** Runs `after` once, right after the restore's first read of `target` returns. */
		function afterFirstReadOf(target: string, after: () => void) {
			const realRead = fs.promises.readFile;
			let armed = true;
			vi.spyOn(fs.promises, "readFile").mockImplementation(
				async (...args: Parameters<typeof realRead>) => {
					const bytes = await realRead(...args);
					if (armed && String(args[0]) === target) {
						armed = false;
						after();
					}
					return bytes;
				},
			);
		}

		// Recurrence: defect 2 of #3741 (the stated residual). The restore's
		// compare and write ran outside pi's queue, so an agent edit that landed
		// between them was overwritten by the older capture, and the report said
		// "restored".
		it("an agent edit made while the restore writes survives it", async () => {
			const aRs = path.join(srcDir, "a.rs");
			const started = gate();
			const proceed = gate();
			fake.clippy = async () => {
				started.open();
				await proceed.p;
				fs.writeFileSync(aRs, TOOL_FIXED);
				return 0;
			};
			const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
			await started.p;
			const first = agentEdit(aRs, "let ONE = 1;");
			first.write();
			await first.deliver();
			const park = parkRenameOf(aRs);
			proceed.open();
			await park.parked;
			// The agent's next edit of a.rs, through pi's queue, while the restore
			// is between its compare and its write.
			const late = agentAppend(aRs, "// AGENT-LATE\n");
			await afterQueueRegistration();
			const enteredWhileRestoring = late.wrote();
			park.resume();
			await run;
			await late.done;

			expect(fs.readFileSync(aRs, "utf-8")).toBe(
				"let ONE = 1;\n// AGENT-LATE\n",
			);
			expect(enteredWhileRestoring).toBe(false);
		});

		// Recurrence: window A of #3830. `finish()` deregistered the run before
		// `settle` read any file, so an agent edit whose tool_call came after the
		// tool exited was neither in flight nor captured, and the restore wrote
		// the older capture over it while the report said "restored". This pins
		// the NEWER edit only: an older edit the tool erased and a later capture
		// replaced is window C, still open (#3914 r1 F3).
		it("an edit whose tool_call comes after the tool exited is not overwritten", async () => {
			const aRs = path.join(srcDir, "a.rs");
			const bRs = path.join(srcDir, "b.rs");
			const started = gate();
			const proceed = gate();
			fake.clippy = async () => {
				started.open();
				await proceed.p;
				fs.writeFileSync(aRs, TOOL_FIXED);
				fs.writeFileSync(bRs, TOOL_FIXED);
				return 0;
			};
			const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
			await started.p;
			for (const file of [aRs, bRs]) {
				const edit = agentEdit(file, "let ONE = 1;");
				edit.write();
				await edit.deliver();
			}
			// The restore is busy with a.rs when the agent's next edit of b.rs runs
			// from tool_call to tool_result.
			const parked = gate();
			const resume = gate();
			const realRead = fs.promises.readFile;
			let armed = true;
			vi.spyOn(fs.promises, "readFile").mockImplementation(
				async (...args: Parameters<typeof realRead>) => {
					if (armed && String(args[0]) === aRs) {
						armed = false;
						parked.open();
						await resume.p;
					}
					return realRead(...args);
				},
			);
			proceed.open();
			await parked.p;
			const second = agentEdit(bRs, "let TWO = 1;", "write", false, {
				toolCallId: "after-exit-2",
			});
			await second.start();
			second.write();
			await second.deliver();
			resume.open();
			await run;

			expect(fs.readFileSync(bRs, "utf-8")).toBe("let TWO = 1;\n");
			expect(fs.readFileSync(aRs, "utf-8")).toBe("let ONE = 1;\n");
		});

		// Recurrence: the #3844 review's forced-mtime probe. The re-stat compared
		// mtime, size and inode, and an in-place edit keeps the inode, so a
		// same-size edit inside one mtime tick passed it and was overwritten
		// (`restored: 1`). The write compares bytes.
		it("skips the write, and records it, when a same-size edit with the same mtime landed after the read", async () => {
			const aRs = path.join(srcDir, "a.rs");
			const started = gate();
			const proceed = gate();
			// One whole second: the mtime the tool leaves and the later edit sets are
			// equal to the bit, as two writes inside one filesystem tick are.
			const TICK = 1_700_000_000;
			fake.clippy = async () => {
				started.open();
				await proceed.p;
				fs.writeFileSync(aRs, TOOL_FIXED);
				fs.utimesSync(aRs, TICK, TICK);
				return 0;
			};
			const run = runPipelineSettled(pipelineContext(mainRs), pipelineDeps());
			await started.p;
			const first = agentEdit(aRs, "let ONE = 1;");
			first.write();
			await first.deliver();
			const NEWER = "pub fn f() { let _y = 2; }\n";
			expect(NEWER.length).toBe(TOOL_FIXED.length);
			afterFirstReadOf(aRs, () => {
				fs.writeFileSync(aRs, NEWER);
				fs.utimesSync(aRs, TICK, TICK);
			});
			proceed.open();
			await run;

			expect(fs.readFileSync(aRs, "utf-8")).toBe(NEWER);
			expect(noticeText()).toContain("a.rs");
			const skipped = getDegradationSummary().find(
				(group) => group.kind === "fix-run-restore-skipped-newer-edit",
			);
			expect(skipped?.count).toBe(1);
			expect(skipped?.latestReasons[0]?.reason).toContain(
				"restore left 1 file(s) alone",
			);
		});

		// Recurrence: the lock-order cycle of #3830. The restore's `settle` ran
		// inside the target F's hold. A queue entry for the sibling S taken there
		// waits behind an LSP multi-path edit that holds S and waits for F (the
		// edit's keys are sorted, and S sorts first): the edit waits for the
		// pipeline, the pipeline for the restore, the restore for the edit. The
		// restore takes S's entry only after the pipeline has left F.
		it("does not deadlock with an LSP multi-path edit that holds the sibling and waits for the target", async () => {
			const aRs = path.join(srcDir, "a.rs");
			const events: string[] = [];
			setHostFileMutationQueueLoader(async () => ({
				withFileMutationQueue: async <T>(
					file: string,
					fn: () => Promise<T>,
				): Promise<T> =>
					withFileMutationQueue(file, async () => {
						events.push(`enter ${path.basename(file)}`);
						try {
							return await fn();
						} finally {
							events.push(`exit ${path.basename(file)}`);
						}
					}),
			}));
			const started = gate();
			const proceed = gate();
			fake.clippy = async () => {
				started.open();
				await proceed.p;
				fs.writeFileSync(aRs, TOOL_FIXED);
				return 0;
			};
			let settled = false;
			const run = runPipeline(pipelineContext(mainRs), pipelineDeps()).then(
				(result) => {
					settled = true;
					return result;
				},
			);
			await started.p;
			const first = agentEdit(aRs, "let ONE = 1;");
			first.write();
			await first.deliver();
			// a.rs sorts before main.rs: the edit holds a.rs and waits for main.rs,
			// which the pipeline holds while clippy runs.
			let lspRan = false;
			const lsp = withHostFileMutationQueues([mainRs, aRs], async () => {
				lspRan = true;
			});
			await waitFor(
				() => events,
				(seen) => seen.includes("enter a.rs"),
			);
			proceed.open();
			await waitFor(
				() => settled,
				(done) => done,
				{ timeoutMs: 3000 },
			);
			await lsp;
			await run;
			await restoreSettled();

			expect(lspRan).toBe(true);
			expect(fs.readFileSync(aRs, "utf-8")).toBe("let ONE = 1;\n");
		});

		// Recurrence: the same cycle at the second caller. The `agent_end` drain
		// holds the target F while its fixer runs, and awaits the restore after
		// releasing it. An await moved under that hold survived the whole suite
		// (#3914 r1, F1).
		it("does not deadlock the agent_end drain with an LSP multi-path edit that holds the sibling", async () => {
			const aRs = path.join(srcDir, "a.rs");
			const events: string[] = [];
			setHostFileMutationQueueLoader(async () => ({
				withFileMutationQueue: async <T>(
					file: string,
					fn: () => Promise<T>,
				): Promise<T> =>
					withFileMutationQueue(file, async () => {
						events.push(`enter ${path.basename(file)}`);
						try {
							return await fn();
						} finally {
							events.push(`exit ${path.basename(file)}`);
						}
					}),
			}));
			const started = gate();
			const proceed = gate();
			fake.clippy = async () => {
				started.open();
				await proceed.p;
				fs.writeFileSync(aRs, TOOL_FIXED);
				return 0;
			};
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = tmpDir;
			runtime.deferMutation(mainRs, tmpDir, "edit", tmpDir, "autofix");
			let settled = false;
			const drain = handleAgentEnd({
				ctxCwd: tmpDir,
				getFlag: (name: string) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: vi.fn() } as never,
				biomeClient: {} as never,
				ruffClient: {} as never,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile: async (filePath: string) => ({
							filePath,
							formatters: [],
							anyChanged: false,
							allSucceeded: true,
						}),
					}) as never,
			}).then(() => {
				settled = true;
			});
			await started.p;
			const first = agentEdit(aRs, "let ONE = 1;");
			first.write();
			await first.deliver();
			let lspRan = false;
			const lsp = withHostFileMutationQueues([mainRs, aRs], async () => {
				lspRan = true;
			});
			await waitFor(
				() => events,
				(seen) => seen.includes("enter a.rs"),
			);
			proceed.open();
			await waitFor(
				() => settled,
				(done) => done,
				{ timeoutMs: 3000 },
			);
			await lsp;
			await drain;
			await restoreSettled();

			expect(lspRan).toBe(true);
			expect(fs.readFileSync(aRs, "utf-8")).toBe("let ONE = 1;\n");
		});

		// Recurrence: #3914 r1, F2. The handler awaited the restore at its end, so
		// F's own diagnostics and blockers waited for whoever held a sibling's
		// queue entry (another pipeline's hold, an LSP edit): on master the restore
		// was unqueued and F never waited on S.
		it("settles F's result while a third party holds the sibling's queue entry", async () => {
			const aRs = path.join(srcDir, "a.rs");
			const started = gate();
			const proceed = gate();
			fake.clippy = async () => {
				started.open();
				await proceed.p;
				fs.writeFileSync(aRs, TOOL_FIXED);
				return 0;
			};
			let settled = false;
			const run = runPipeline(pipelineContext(mainRs), pipelineDeps()).then(
				(result) => {
					settled = true;
					return result;
				},
			);
			await started.p;
			const first = agentEdit(aRs, "let ONE = 1;");
			first.write();
			await first.deliver();
			const release = gate();
			const entered = gate();
			const holder = withFileMutationQueue(aRs, async () => {
				entered.open();
				await release.p;
			});
			await entered.p;
			proceed.open();
			await waitFor(
				() => settled,
				(done) => done,
				{ timeoutMs: 3000 },
			);
			// The restore is still waiting for the sibling, and F is long done.
			expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
			release.open();
			await holder;
			await run;
			await restoreSettled();

			expect(fs.readFileSync(aRs, "utf-8")).toBe("let ONE = 1;\n");
		});

		// Recurrence: #3830's loss notice moved off the tool result. The restore
		// ends after the pipeline returned, so the notice reaches the agent through
		// the host's advisory queue, wired in `handleToolResult`.
		it("queues the loss notice as an advisory for the session that dispatched the write", async () => {
			const aRs = path.join(srcDir, "a.rs");
			const started = gate();
			const proceed = gate();
			fake.clippy = async () => {
				started.open();
				await proceed.p;
				fs.writeFileSync(aRs, TOOL_FIXED);
				return 0;
			};
			const edit = agentEdit(mainRs, "let MAIN = 1;", "write", false, {
				autofix: true,
			});
			edit.write();
			const delivery = edit.deliver();
			await started.p;
			// The tool erased this edit before pi-lens captured it: a stale write.
			const sibling = agentEdit(aRs, "let AGENT = 1;");
			sibling.write();
			fs.writeFileSync(aRs, TOOL_FIXED);
			await sibling.deliver();
			proceed.open();
			await delivery;
			await restoreSettled();

			const nudge = consumeAgentNudge(undefined, edit.runtime.sessionScope);
			expect(nudge?.messages[0]?.content).toContain("a.rs");
		});

		// Recurrence: #3914 r2, F6. `onFixRunLoss` closes over the `writeSession`
		// the tool_result handler captured at entry (#3568), not the session
		// current when the restore ends. A `/new` between the write's dispatch and
		// the restore's notice retires the notice with its own session; it must
		// never reach the successor (the `agent_end` twin is #3748).
		it("does not hand the loss notice to the session that replaced the write's own (#3748)", async () => {
			const aRs = path.join(srcDir, "a.rs");
			const started = gate();
			const proceed = gate();
			fake.clippy = async () => {
				started.open();
				await proceed.p;
				fs.writeFileSync(aRs, TOOL_FIXED);
				return 0;
			};
			const edit = agentEdit(mainRs, "let MAIN = 1;", "write", false, {
				autofix: true,
			});
			edit.write();
			const delivery = edit.deliver();
			await started.p;
			// The tool erased this edit before pi-lens captured it: a stale write.
			const sibling = agentEdit(aRs, "let AGENT = 1;");
			sibling.write();
			fs.writeFileSync(aRs, TOOL_FIXED);
			await sibling.deliver();
			// Hold the sibling's queue entry so the restore cannot end before /new.
			const release = gate();
			const entered = gate();
			const holder = withFileMutationQueue(aRs, async () => {
				entered.open();
				await release.p;
			});
			await entered.p;
			proceed.open();
			await delivery;
			// `/new` lands after the write's handler returned, while its detached
			// restore still waits for the sibling.
			edit.runtime.resetForSession();
			release.open();
			await holder;
			await restoreSettled();

			expect(
				consumeAgentNudge(undefined, edit.runtime.sessionScope),
			).toBeUndefined();
		});

		// Recurrence: #3914 r2, C3. The loss notice was attached after dispatch, so
		// a dispatch throw ended the pipeline before the detached restore could
		// report the lost edit. Attaching it right after the fix run keeps the
		// notice (the ledger row always landed; the agent was not told).
		it("queues the loss notice when dispatch throws after a lossy fix", async () => {
			const aRs = path.join(srcDir, "a.rs");
			const started = gate();
			const proceed = gate();
			fake.clippy = async () => {
				started.open();
				await proceed.p;
				fs.writeFileSync(aRs, TOOL_FIXED);
				return 0;
			};
			const edit = agentEdit(mainRs, "let MAIN = 1;", "write", false, {
				autofix: true,
			});
			edit.write();
			const delivery = edit.deliver();
			await started.p;
			// The tool erased this edit before pi-lens captured it: a stale write.
			const sibling = agentEdit(aRs, "let AGENT = 1;");
			sibling.write();
			fs.writeFileSync(aRs, TOOL_FIXED);
			await sibling.deliver();
			// The sibling's pipeline has settled; the next dispatch is the write's.
			vi.mocked(dispatchLintWithResult).mockRejectedValueOnce(
				new Error("dispatch exploded"),
			);
			proceed.open();
			await delivery;
			await restoreSettled();

			const nudge = consumeAgentNudge(undefined, edit.runtime.sessionScope);
			expect(nudge?.messages[0]?.content).toContain("a.rs");
		});
	});
});

describe("what a native write or edit says it wrote (#3598)", () => {
	it("reads a write's content, an edit's oldText/newText pairs, and the legacy single-edit shape", () => {
		expect(expectationFromToolInput({ content: "abc" }, "write")).toEqual({
			content: "abc",
		});
		expect(
			expectationFromToolInput(
				{ edits: [{ newText: "one" }, { newText: "" }, { newText: "two" }] },
				"edit",
			),
		).toEqual({
			edits: [{ newText: "one" }, { newText: "" }, { newText: "two" }],
		});
		expect(
			expectationFromToolInput({ oldText: "a", newText: "legacy" }, "edit"),
		).toEqual({ edits: [{ oldText: "a", newText: "legacy" }] });
		expect(expectationFromToolInput({ edits: [] }, "edit")).toBeUndefined();
		expect(expectationFromToolInput({}, "write")).toBeUndefined();
	});
});

describe("fix-run registry (#3598)", () => {
	const activeRuns = activeFixRuns;

	it("unregisters the run when the fixer settles and when it throws", async () => {
		const before = activeRuns().size;
		const { restoring } = await runWithFixRestore(
			{ tool: "rust-clippy", extension: ".rs", candidates: [] },
			async () => {
				expect(activeRuns().size).toBe(before + 1);
			},
			async () => {},
		);
		await restoring;
		expect(activeRuns().size).toBe(before);
		await expect(
			runWithFixRestore(
				{ tool: "rust-clippy", extension: ".rs", candidates: [] },
				async () => {
					throw new Error("spawn exploded");
				},
				async () => {},
			),
		).rejects.toThrow("spawn exploded");
		expect(activeRuns().size).toBe(before);
	});

	// Recurrence: window A of #3830. The run left `active` when the tool exited,
	// before the restore read any file. It now stays registered until the
	// restore ends, which waits for pi's queue entry of each sibling, and the
	// restore still runs when the tool throws.
	describe("while the restore waits for a sibling's queue entry (#3830)", () => {
		let dir: string;
		let cleanup: () => void;
		let sibling: string;
		beforeEach(() => {
			resetDegradationLedger();
			const env = setupTestEnvironment("pi-lens-fix-run-registry-");
			dir = env.tmpDir;
			cleanup = env.cleanup;
			sibling = path.join(dir, "a.rs");
			fs.writeFileSync(sibling, "fn a() {}\n");
			setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
		});
		afterEach(() => {
			setHostFileMutationQueueLoader(undefined);
			cleanup();
		});

		/** An agent edit of the sibling, in pi's queue, that holds it until `open`. */
		async function holdSibling() {
			const open = gate();
			const entered = gate();
			const holder = withFileMutationQueue(sibling, async () => {
				entered.open();
				await open.p;
			});
			await entered.p;
			return { release: open.open, holder };
		}

		/** The tool's run: an agent edit lands and is captured, then the tool writes. */
		const toolRun = async () => {
			fs.writeFileSync(sibling, "fn agent() {}\n");
			noteAgentMutation(sibling);
			fs.writeFileSync(sibling, "fn tool() {}\n");
		};

		it("stays registered until the restore has written, and then restores", async () => {
			const before = activeRuns().size;
			const held = await holdSibling();
			const { restoring } = await runWithFixRestore(
				{ tool: "rust-clippy", extension: ".rs", candidates: [sibling] },
				toolRun,
				async () => {},
			);
			expect(activeRuns().size).toBe(before + 1);
			expect(fs.readFileSync(sibling, "utf-8")).toBe("fn tool() {}\n");
			held.release();
			await held.holder;
			const report = await restoring;
			expect(report.restored).toEqual([sibling]);
			expect(fs.readFileSync(sibling, "utf-8")).toBe("fn agent() {}\n");
			expect(activeRuns().size).toBe(before);
		});

		// Recurrence: #3914 r1 F4. The restore waits for the sibling's entry, and an
		// edit that lands meanwhile replaces the capture. A capture read before the
		// wait would write the older edit over the newer one.
		it("reads the capture inside the queue entry, after any wait for it", async () => {
			const held = await holdSibling();
			const { restoring } = await runWithFixRestore(
				{ tool: "rust-clippy", extension: ".rs", candidates: [sibling] },
				toolRun,
				async () => {},
			);
			fs.writeFileSync(sibling, "fn edit2() {}\n");
			noteAgentMutation(sibling, { content: "fn edit2() {}\n" });
			held.release();
			await held.holder;
			const report = await restoring;

			expect(report.restored).toEqual([]);
			expect(fs.readFileSync(sibling, "utf-8")).toBe("fn edit2() {}\n");
		});

		// Recurrence: #3914 r1 C2. The restore waits for pi's queue entries, so the
		// wait is the number to watch; one row per run that had a capture.
		it("records one latency row for the restore, with the time it waited for the queue", async () => {
			let clock = 1_000;
			const rows: Array<{
				phase?: string;
				metadata?: Record<string, unknown>;
			}> = [];
			const latency = vi
				.spyOn(latencyLogger, "logLatency")
				.mockImplementation((row) => {
					rows.push(row as (typeof rows)[number]);
				});
			const held = await holdSibling();
			const now = vi.spyOn(Date, "now").mockImplementation(() => {
				clock += 7;
				return clock;
			});
			try {
				const { restoring } = await runWithFixRestore(
					{ tool: "rust-clippy", extension: ".rs", candidates: [sibling] },
					toolRun,
					async () => {},
				);
				held.release();
				await held.holder;
				await restoring;
			} finally {
				now.mockRestore();
				latency.mockRestore();
			}
			const restoreRows = rows.filter((row) => row.phase === "fix_run_restore");
			expect(restoreRows).toHaveLength(1);
			expect(restoreRows[0]?.metadata).toMatchObject({
				tool: "rust-clippy",
				files: 1,
				restored: 1,
				lost: 0,
				// The capture states nothing to check it against, so it is named.
				possiblyLost: 1,
			});
			expect(restoreRows[0]?.metadata?.queueWaitMs).toBeGreaterThan(0);
		});

		it("still restores when the tool throws", async () => {
			const before = activeRuns().size;
			const held = await holdSibling();
			await expect(
				runWithFixRestore(
					{ tool: "rust-clippy", extension: ".rs", candidates: [sibling] },
					async () => {
						await toolRun();
						throw new Error("spawn exploded");
					},
					async () => {},
				),
			).rejects.toThrow("spawn exploded");
			expect(activeRuns().size).toBe(before + 1);
			held.release();
			await held.holder;
			await waitFor(
				() => fs.readFileSync(sibling, "utf-8"),
				(bytes) => bytes === "fn agent() {}\n",
				{ timeoutMs: 2000 },
			);
			await waitFor(
				() => activeRuns().size,
				(size) => size === before,
				{ timeoutMs: 2000 },
			);
		});

		// Recurrence: the pipeline scans the project right after the tool (the
		// mtime-and-size diff of what the tool changed). A restore running during
		// that scan stages `<file>.tmp-*` beside the sibling and renames it, and the
		// scan can report the staging file, or the restored file, as the tool's.
		it("starts the restore after the caller's scan of the tool's changes, not during it", async () => {
			const realRead = fs.promises.readFile;
			let siblingReads = 0;
			const spy = vi
				.spyOn(fs.promises, "readFile")
				.mockImplementation(async (...args: Parameters<typeof realRead>) => {
					if (String(args[0]) === sibling) siblingReads += 1;
					return realRead(...args);
				});
			try {
				let readsDuringScan = -1;
				let seenDuringScan = "";
				const { restoring } = await runWithFixRestore(
					{ tool: "rust-clippy", extension: ".rs", candidates: [sibling] },
					toolRun,
					async () => {
						const readsBefore = siblingReads;
						// Let a restore that had started reach its queue registration; a queue
						// call on another path then registers after the restore's own, and a
						// free file's entry has run by then.
						await new Promise<void>((resolve) => setImmediate(resolve));
						await withFileMutationQueue(
							path.join(dir, "registration-barrier"),
							async () => {},
						);
						readsDuringScan = siblingReads - readsBefore;
						seenDuringScan = fs.readFileSync(sibling, "utf-8");
					},
				);
				await restoring;
				expect(readsDuringScan).toBe(0);
				expect(seenDuringScan).toBe("fn tool() {}\n");
				expect(fs.readFileSync(sibling, "utf-8")).toBe("fn agent() {}\n");
			} finally {
				spy.mockRestore();
			}
		});

		it("still restores when the caller's scan throws", async () => {
			await expect(
				runWithFixRestore(
					{ tool: "rust-clippy", extension: ".rs", candidates: [sibling] },
					toolRun,
					async () => {
						throw new Error("scan exploded");
					},
				),
			).rejects.toThrow("scan exploded");
			await waitFor(
				() => fs.readFileSync(sibling, "utf-8"),
				(bytes) => bytes === "fn agent() {}\n",
				{ timeoutMs: 2000 },
			);
		});
	});
});

describe("fix-run hash scope (#3598)", () => {
	let dir: string;
	let cleanup: () => void;
	beforeEach(() => {
		resetDegradationLedger();
		const env = setupTestEnvironment("pi-lens-fix-run-scope-");
		dir = env.tmpDir;
		cleanup = env.cleanup;
	});
	afterEach(() => cleanup());

	it("covers only the tool's extension and records a cut set once", async () => {
		const rs = path.join(dir, "a.rs");
		const big = path.join(dir, "big.rs");
		const md = path.join(dir, "notes.md");
		fs.writeFileSync(rs, "fn a() {}\n");
		fs.writeFileSync(big, "x".repeat(FIX_RUN_MAX_FILE_BYTES + 1));
		fs.writeFileSync(md, "# not source\n");

		const run = await beginFixRun({
			tool: "rust-clippy",
			extension: ".rs",
			candidates: [rs, big, md],
		});
		const report = await run.finish().restore();

		expect(report).toEqual({
			restored: [],
			lost: [],
			possiblyLost: [],
			agentEdited: [],
		});
		const cut = getDegradationSummary().find(
			(group) => group.kind === "fix-run-scope-truncated",
		);
		// One file over the size cap; the markdown file was never a candidate.
		expect(cut?.count).toBe(1);
		expect(cut?.latestReasons[0]?.reason).toContain("1 of 2 .rs file(s)");
	});

	it("stops hashing at the byte budget", async () => {
		const files = ["a.rs", "b.rs", "c.rs"].map((name) => path.join(dir, name));
		for (const file of files) fs.writeFileSync(file, "12345678");

		const run = await beginFixRun({
			tool: "rust-clippy",
			extension: ".rs",
			candidates: files,
			byteBudget: 16,
		});
		await run.finish().restore();

		const cut = getDegradationSummary().find(
			(group) => group.kind === "fix-run-scope-truncated",
		);
		expect(cut?.latestReasons[0]?.reason).toContain("1 of 3 .rs file(s)");
	});
});
