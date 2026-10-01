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
	runWithFixRestore,
} from "../../clients/fix-run-restore.js";
import { getProcessSingleton } from "../../clients/process-singletons.js";
import { beginScope } from "../../clients/session-scope.js";
import {
	type MutationBridgeDeps,
	recordMutationThroughSeam,
} from "../../clients/mutation-bridge.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
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

	function pipelineContext(filePath: string): PipelineContext {
		return {
			filePath,
			cwd: tmpDir,
			toolName: "write",
			getFlag: () => false,
			dbg: () => {},
		};
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
					getFlag: (flag: string) => kind === "write" && flag === "no-autofix",
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		// The agent's host tool wrote a.rs; the fixer then wrote its stale-based
		// content; only THEN does pi-lens's tool_result read the file.
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		fs.writeFileSync(aRs, TOOL_FIXED);
		await edit.deliver();
		proceed.open();
		const result = await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
		expect(result.output).toContain("a.rs");
		expect(result.output).toContain("re-apply");
		expect(overwrittenCount()).toBe(1);
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const write = agentEdit(aRs, "let AGENT = 1;", "write");
		write.write();
		// The tool's stale-based bytes contain none of the agent's content.
		fs.writeFileSync(aRs, TOOL_FIXED);
		await write.deliver();
		proceed.open();
		const result = await run;

		expect(result.output).toContain("a.rs");
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		// The tool fixed a.rs; the agent's edit of it then failed (nothing written).
		fs.writeFileSync(aRs, TOOL_FIXED);
		const failed = agentEdit(aRs, "let AGENT = 1;", "edit", true);
		await failed.deliver();
		proceed.open();
		const result = await run;

		expect(result.output ?? "").not.toContain("re-apply");
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let a = 1;\n    let b = 2;", "edit", false, {
			bytes: agentBytes,
		});
		edit.write();
		await edit.deliver();
		proceed.open();
		const result = await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe(agentBytes);
		expect(result.output ?? "").not.toContain("re-apply");
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let a = 1;\n    let b = 2;", "edit", false, {
			bytes: "pub fn f() {\r\n    let a = 1;\r\n    let b = 2;\r\n}\r\n",
		});
		edit.write();
		fs.writeFileSync(aRs, "pub fn f() {\r\n    let _x = 1;\r\n}\r\n");
		await edit.deliver();
		proceed.open();
		const result = await run;

		expect(result.output).toContain("a.rs");
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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
		const result = await run;
		await second.deliver();

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let TWO = 1;\n");
		expect(result.output).toContain("a.rs");
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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
		const result = await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let ONE = 1;\n");
		expect(result.output ?? "").not.toContain("cannot confirm");
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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
			const result = await run;
			expect(fs.readFileSync(aRs, "utf-8")).toBe("let NEWER = 1;\n");
			expect(result.output).toContain("a.rs");
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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
		const result = await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let BRIDGED = 1;\n");
		expect(result.output).toContain("a.rs");
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "", "edit", false, {
			bytes: "pub fn f() {  }\n",
		});
		edit.write();
		fs.writeFileSync(aRs, `${ORIGINAL}// tool\n`);
		await edit.deliver();
		proceed.open();
		const result = await run;

		expect(result.output).toContain("a.rs");
	});

	it("records one cost row for the pre-run hash", async () => {
		const spy = vi.spyOn(latencyLogger, "logLatency");
		try {
			fake.clippy = async () => 0;
			await runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
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

		await runPipeline(pipelineContext(mainRs), pipelineDeps());

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

		const run = runPipeline(pipelineContext(mainDart), pipelineDeps());
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
		await run;

		expect(fs.readFileSync(aDart, "utf-8")).toBe("int a() => AGENT;\n");
		expect(overwrittenCount()).toBe(1);
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
			await runPipeline(pipelineContext(mainDart), pipelineDeps());

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
		const result = await runPipeline(
			{ ...pipelineContext(mainRs), autofixMode: "deferred" },
			pipelineDeps(),
		);

		expect(result.output).not.toContain("auto-fix run");
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
	function activeRuns(): Set<unknown> {
		return getProcessSingleton<{ active: Set<unknown> }>(
			"fix-run-restore",
			1,
			() => ({ active: new Set() }),
		).active;
	}

	it("unregisters the run when the fixer settles and when it throws", async () => {
		const before = activeRuns().size;
		await runWithFixRestore(
			{ tool: "rust-clippy", extension: ".rs", candidates: [] },
			async () => {
				expect(activeRuns().size).toBe(before + 1);
			},
		);
		expect(activeRuns().size).toBe(before);
		await expect(
			runWithFixRestore(
				{ tool: "rust-clippy", extension: ".rs", candidates: [] },
				async () => {
					throw new Error("spawn exploded");
				},
			),
		).rejects.toThrow("spawn exploded");
		expect(activeRuns().size).toBe(before);
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
		const report = await run.finish();

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
		await run.finish();

		const cut = getDegradationSummary().find(
			(group) => group.kind === "fix-run-scope-truncated",
		);
		expect(cut?.latestReasons[0]?.reason).toContain("1 of 3 .rs file(s)");
	});
});
