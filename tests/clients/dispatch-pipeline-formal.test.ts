/**
 * Replays of the `formal/dispatch-pipeline` counterexamples against the real
 * `handleToolResult` + `runPipeline` + `RuntimeCoordinator` + widget store.
 * Only the dispatch runners, the LSP service and the fixer PROCESS are
 * doubled; every ordering decision under test is production code. Each case
 * names the TLC config whose trace it replays.
 *
 * No wall clock: every interleaving is pinned with a gate a double opens or
 * waits on.
 */
import * as fs from "node:fs";
import * as path from "node:path";
// pi's real per-file queue, the one its `edit`/`write` tools run under. The
// pi host adapter hands the same export to pi-lens' writers (index.ts).
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import type { CacheManager } from "../../clients/cache-manager.js";
import type { FormatService } from "../../clients/format-service.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { runPipeline } from "../../clients/pipeline.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import {
	clearWidgetState,
	getFileDiagnostics,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/integration.js")
	>()),
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(),
	resyncGitChangedFiles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/recent-touches.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/recent-touches.js")>()),
	appendRecentTouches: vi.fn().mockResolvedValue(undefined),
}));
// The on-demand bootstrap: clients are NOT resident until the test opens the
// gate, which is the state the #3508 claim gap needs.
const bootstrapGate = vi.hoisted(() => {
	const waiters: Array<() => void> = [];
	let onPark: (() => void) | undefined;
	return {
		waiters,
		park(waiter: () => void) {
			waiters.push(waiter);
			onPark?.();
		},
		/** Resolves once `count` demands are parked on the gate. */
		parked(count: number): Promise<void> {
			return new Promise((resolve) => {
				onPark = () => {
					if (waiters.length >= count) resolve();
				};
				onPark();
			});
		},
		release: () => waiters.splice(0).forEach((w) => w()),
	};
});
vi.mock("../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
	return bootstrapSeamMock(
		() =>
			new Promise((resolve) => {
				bootstrapGate.park(() =>
					resolve({
						biomeClient: {
							isSupportedFile: () => false,
							ensureAvailable: async () => false,
						},
						ruffClient: {
							isPythonFile: () => false,
							ensureAvailable: async () => false,
						},
						metricsClient: {},
					}),
				);
			}),
	);
});

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";
import { getLSPService } from "../../clients/lsp/index.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

function clean(label: string) {
	return {
		diagnostics: [],
		blockers: [],
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: `analysed ${label}: clean`,
		blockerOutput: "",
		hasBlockers: false,
	};
}

function blocking(filePath: string, label: string) {
	const d = {
		id: `tsc:${label}`,
		tool: "tsc",
		rule: "TS2322",
		message: `BLOCKER-FROM-${label}`,
		filePath,
		line: 1,
		column: 1,
		severity: "error",
		semantic: "blocking",
	};
	return {
		diagnostics: [d],
		blockers: [d],
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: `STOP ${label}`,
		blockerOutput: `STOP ${label}`,
		hasBlockers: true,
	};
}

/** The revision label a fixture file's bytes carry (`v1`, `v2`, ...). */
function revisionOf(filePath: string): string {
	return /v\d/.exec(fs.readFileSync(filePath, "utf8"))?.[0] ?? "none";
}

/**
 * Dispatch double for the inline-record replays: `slow` revisions park until
 * their gate opens, and `entered` opens once one of them has been dispatched.
 */
function scriptDispatch(verdicts: Record<string, "clean" | "blocker">) {
	const entered = gate();
	const release = gate();
	vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
		const rev = revisionOf(fp as string);
		if (rev === "v1") {
			entered.open();
			await release.p;
		}
		return (
			verdicts[rev] === "blocker" ? blocking(fp as string, rev) : clean(rev)
		) as never;
	});
	return { entered, release };
}

function inlineSummaries(runtime: RuntimeCoordinator) {
	return runtime.getInlineBlockersSnapshot().map((r) => ({
		writeIndex: r.writeIndex,
		blocker: r.summary.match(/BLOCKER-FROM-v\d/)?.[0],
	}));
}

type Dbg = (message: string) => void;

/**
 * The Biome agreement evidence the autofix gate requires before it lets an
 * autonomous writer touch the project.
 */
function writeBiomeAgreement(root: string): void {
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.4.10" } }),
	);
	fs.writeFileSync(
		path.join(root, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": {},
				"node_modules/@biomejs/biome": { version: "2.4.10" },
			},
		}),
	);
}

/**
 * The agent's next edit of `filePath`, run the way pi's edit tool runs it:
 * read-modify-write inside pi's mutation queue. The body is synchronous once
 * the queue admits it.
 */
function agentAppend(filePath: string, line: string) {
	let wrote = false;
	const done = withFileMutationQueue(filePath, async () => {
		fs.writeFileSync(filePath, `${fs.readFileSync(filePath, "utf8")}${line}`);
		wrote = true;
	});
	return { done, wrote: () => wrote };
}

/**
 * Resolves once every queue call made before it has registered: pi chains
 * registrations through one module-wide promise, so a call on another path
 * registers after them. An earlier call whose file is free has run by then.
 */
function afterQueueRegistration(dir: string): Promise<void> {
	return withFileMutationQueue(
		path.join(dir, "registration-barrier"),
		async () => {},
	);
}

/**
 * A `BiomeClient.fixFileAsync` double with the real one's shape
 * (biome-client.ts): read the file, let `lint --write` rewrite what it read,
 * read it back, and report a fix only when the bytes moved. `hold` parks the
 * process between its read and the step `holdBefore` names.
 */
function gatedFixer(holdBefore: "write" | "after-read") {
	const parked = gate();
	const resume = gate();
	const fixer = {
		isSupportedFile: () => true,
		ensureAvailable: async () => true,
		fixFileAsync: async (fp: string) => {
			const before = fs.readFileSync(fp, "utf8");
			if (holdBefore === "write") {
				parked.open();
				await resume.p;
			}
			fs.writeFileSync(fp, before.replace("var ", "const "));
			if (holdBefore === "after-read") {
				parked.open();
				await resume.p;
			}
			const after = fs.readFileSync(fp, "utf8");
			return {
				success: true,
				changed: before !== after,
				fixed: before !== after ? 1 : 0,
			};
		},
	} as unknown as BiomeClient;
	return { fixer, parked, resume };
}

const text = (r: unknown) =>
	((r as { content?: Array<{ text?: string }> })?.content ?? [])
		.map((c) => c.text ?? "")
		.join("\n");

function deps(
	runtime: RuntimeCoordinator,
	biomeClient: unknown,
	options: { resident?: boolean; dbg?: Dbg } = {},
) {
	const resident = options.resident ?? true;
	return {
		getFlag: (name: string) => name === "no-lsp",
		dbg: options.dbg ?? (() => {}),
		runtime,
		cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
		...(resident
			? {
					biomeClient,
					ruffClient: {
						isPythonFile: () => false,
						ensureAvailable: async () => false,
					},
					metricsClient: {},
				}
			: {}),
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}
const noBiome = {
	isSupportedFile: () => false,
	ensureAvailable: async () => false,
};
const ev = (toolName: string, filePath: string, id: string) => ({
	toolName,
	toolCallId: id,
	input: { path: filePath },
	details: {},
	content: [],
});

describe("formal/dispatch-pipeline replays", () => {
	beforeEach(() => {
		clearWidgetState();
		vi.mocked(getLSPService).mockReturnValue(
			makeLspServiceDouble({
				supportsLSP: () => false,
				hasLSP: async () => false,
				openFile: async () => {},
				touchFile: async () => {},
				getAllDiagnostics: async () => new Map(),
			}) as never,
		);
		vi.mocked(dispatchLintWithResult).mockReset();
	});

	// ── #3507: the inline-blocker record (InlineParallel) ──────────────────────
	// P1 is the older edit's pipeline, parked in its dispatch; P2, the newer
	// edit's, runs to completion; then P1 settles last.
	async function olderSettlesLast(
		verdicts: Record<string, "clean" | "blocker">,
	): Promise<{
		runtime: RuntimeCoordinator;
		filePath: string;
		afterP2: ReturnType<typeof inlineSummaries>;
		cleanup: () => void;
	}> {
		const env = setupTestEnvironment("tla-inline-");
		const filePath = path.join(env.tmpDir, "a.ts");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		runtime.beginTurn();
		const { entered, release } = scriptDispatch(verdicts);
		fs.writeFileSync(filePath, "export const x = 'v1';\n");
		const p1 = handleToolResult({
			...deps(runtime, noBiome),
			event: ev("edit", filePath, "c1"),
		} as never);
		await entered.p;
		fs.writeFileSync(filePath, "export const y = 'v2';\n");
		await handleToolResult({
			...deps(runtime, noBiome),
			event: ev("edit", filePath, "c2"),
		} as never);
		const afterP2 = inlineSummaries(runtime);
		release.open();
		await p1;
		return { runtime, filePath, afterP2, cleanup: env.cleanup };
	}

	it("InlineParallel (#3507): an older clean pipeline that settles last does not erase the newer edit's blocker", async () => {
		const run = await olderSettlesLast({ v1: "clean", v2: "blocker" });
		try {
			expect(run.afterP2).toEqual([
				{ writeIndex: 2, blocker: "BLOCKER-FROM-v2" },
			]);
			expect(inlineSummaries(run.runtime)).toEqual(run.afterP2);
			expect(run.runtime.gitGuardHasBlockers).toBe(true);
			// The widget store's own guard agrees.
			expect(
				(getFileDiagnostics(run.filePath) ?? []).map((d) => d.message),
			).toEqual(["BLOCKER-FROM-v2"]);
		} finally {
			run.cleanup();
		}
	});

	it("InlineParallel (#3507): an older blocker that settles last does not replace the newer edit's verdict", async () => {
		const run = await olderSettlesLast({ v1: "blocker", v2: "blocker" });
		try {
			expect(inlineSummaries(run.runtime)).toEqual([
				{ writeIndex: 2, blocker: "BLOCKER-FROM-v2" },
			]);
		} finally {
			run.cleanup();
		}
	});

	it("InlineParallel (#3507): an older blocker that settles after the newer edit cleared the record neither restores it nor latches the commit gate", async () => {
		const run = await olderSettlesLast({ v1: "blocker", v2: "clean" });
		try {
			expect(run.afterP2).toEqual([]);
			expect(inlineSummaries(run.runtime)).toEqual([]);
			expect(run.runtime.gitGuardHasBlockers).toBe(false);
		} finally {
			run.cleanup();
		}
	});

	it("InlineParallel (#3507): the order spans turns, so a later turn's clean clears a blocker recorded under a higher write index", async () => {
		const env = setupTestEnvironment("tla-inline-turns-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			vi.mocked(dispatchLintWithResult).mockImplementation(
				async (fp) =>
					(revisionOf(fp as string) === "v3"
						? blocking(fp as string, "v3")
						: clean(revisionOf(fp as string))) as never,
			);
			for (const rev of ["v1", "v2", "v3"]) {
				fs.writeFileSync(filePath, `export const x = '${rev}';\n`);
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, rev),
				} as never);
			}
			expect(inlineSummaries(runtime)).toEqual([
				{ writeIndex: 3, blocker: "BLOCKER-FROM-v3" },
			]);
			runtime.beginTurn();
			fs.writeFileSync(filePath, "export const x = 'v4';\n");
			await handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, "v4"),
			} as never);
			expect(inlineSummaries(runtime)).toEqual([]);
			expect(runtime.gitGuardHasBlockers).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// ── #3506: pi-lens' own writers inside pi's mutation queue ────────────────
	describe("the immediate autofix and the deferred drain", () => {
		beforeEach(() => {
			setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
		});
		afterEach(() => {
			setHostFileMutationQueueLoader(undefined);
		});

		it("FixerParallel (#3506): the immediate autofix does not write over an agent edit made through pi's queue", async () => {
			const env = setupTestEnvironment("tla-fixer-lost-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async () => clean("any") as never,
				);
				const { fixer, parked, resume } = gatedFixer("write");
				fs.writeFileSync(filePath, "var a = 1;\n");
				const write = handleToolResult({
					...deps(runtime, fixer),
					event: ev("write", filePath, "c1"),
				} as never);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				await write;
				await agent.done;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"const a = 1;\nexport const AGENT_EDIT_2 = 2;\n",
				);
			} finally {
				env.cleanup();
			}
		});

		it("FixerAttribution (#3506): an agent edit is never reported as pi-lens' autofix, and its own analysis runs", async () => {
			const env = setupTestEnvironment("tla-fixer-attr-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				const analysed: string[] = [];
				vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
					analysed.push(fs.readFileSync(fp as string, "utf8"));
					return clean("any") as never;
				});
				// Nothing to fix: the fixer writes back what it read, then parks
				// before its after-read.
				const { fixer, parked, resume } = gatedFixer("after-read");
				fs.writeFileSync(filePath, "export const a = 1;\n");
				const write = handleToolResult({
					...deps(runtime, fixer),
					event: ev("write", filePath, "c1"),
				} as never);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				const writeResult = await write;
				await agent.done;
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c2"),
				} as never);
				expect(text(writeResult)).not.toContain("pi-lens applied autofix");
				expect(analysed.filter((a) => a.includes("AGENT_EDIT_2"))).toHaveLength(
					1,
				);
			} finally {
				env.cleanup();
			}
		});

		it("FixerQueueNoReToken (#3506): a pipeline whose autofix fixed a newer revision records it under a fresh write index", async () => {
			const env = setupTestEnvironment("tla-fixer-token-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
					const bytes = fs.readFileSync(fp as string, "utf8");
					const rev = bytes.includes("E3")
						? "v3"
						: bytes.includes("E2")
							? "v2"
							: "v1";
					return blocking(fp as string, rev) as never;
				});
				// The first write's fixer starts late (its availability probe),
				// by which time two more edits have landed.
				const probing = gate();
				const probed = gate();
				const fixer = {
					isSupportedFile: () => true,
					ensureAvailable: async () => {
						probing.open();
						await probed.p;
						return true;
					},
					fixFileAsync: async (fp: string) => {
						const before = fs.readFileSync(fp, "utf8");
						fs.writeFileSync(fp, before.replace("var ", "const "));
						const after = fs.readFileSync(fp, "utf8");
						return {
							success: true,
							changed: before !== after,
							fixed: before !== after ? 1 : 0,
						};
					},
				} as unknown as BiomeClient;
				fs.writeFileSync(filePath, "var a = 1;\n");
				const write = handleToolResult({
					...deps(runtime, fixer),
					event: ev("write", filePath, "c1"),
				} as never);
				await probing.p;
				fs.writeFileSync(filePath, "var a = 1;\nexport const E2 = 2;\n");
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c2"),
				} as never);
				fs.writeFileSync(
					filePath,
					"var a = 1;\nexport const E2 = 2;\nexport const E3 = 3;\n",
				);
				probed.open();
				await write;
				// Edit 3's own handler finds the bytes already analysed.
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c3"),
				} as never);
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"const a = 1;\nexport const E2 = 2;\nexport const E3 = 3;\n",
				);
				expect(
					(getFileDiagnostics(filePath) ?? []).map((d) => d.message),
				).toEqual(["BLOCKER-FROM-v3"]);
				expect(inlineSummaries(runtime)).toEqual([
					{ writeIndex: 3, blocker: "BLOCKER-FROM-v3" },
				]);
			} finally {
				env.cleanup();
			}
		});

		it("FixerQueue (#3506): a queued pipeline whose fixer changed nothing keeps its handler's token, so the newer edit's verdict stands", async () => {
			const env = setupTestEnvironment("tla-fixer-keep-token-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async (fp) =>
						blocking(fp as string, revisionOf(fp as string)) as never,
				);
				fs.writeFileSync(filePath, "export const a = 'v1';\n");
				// The agent's edit 2 already holds pi's queue for the file.
				const agentEntered = gate();
				const agentGo = gate();
				const agent = withFileMutationQueue(filePath, async () => {
					agentEntered.open();
					await agentGo.p;
					fs.writeFileSync(filePath, "export const a = 'v2';\n");
				});
				await agentEntered.p;
				// The first write's pipeline reaches its fixer and queues behind it.
				const atAutofix = gate();
				const dbg: Dbg = (message) => {
					if (message.startsWith("autofix: policy for")) atAutofix.open();
				};
				const { fixer, parked, resume } = gatedFixer("write");
				const write = handleToolResult({
					...deps(runtime, fixer, { dbg }),
					event: ev("write", filePath, "c1"),
				} as never);
				await atAutofix.p;
				agentGo.open();
				await agent;
				// The fixer reads v2 and finds nothing to fix; meanwhile edit 2's own
				// handler analyses v2.
				await parked.p;
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c2"),
				} as never);
				resume.open();
				await write;
				expect(
					(getFileDiagnostics(filePath) ?? []).map((d) => d.message),
				).toEqual(["BLOCKER-FROM-v2"]);
				expect(inlineSummaries(runtime)).toEqual([
					{ writeIndex: 2, blocker: "BLOCKER-FROM-v2" },
				]);
			} finally {
				env.cleanup();
			}
		});

		it("immediate format (#3506): the --immediate-format write does not overwrite an agent edit made through pi's queue", async () => {
			const env = setupTestEnvironment("tla-immediate-format-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(filePath, "let value=1\n");
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async () => clean("any") as never,
				);
				const parked = gate();
				const resume = gate();
				const formatService = {
					recordRead: () => {},
					formatFile: async (fp: string) => {
						const before = fs.readFileSync(fp, "utf8");
						parked.open();
						await resume.p;
						fs.writeFileSync(
							fp,
							before.replace("let value=1", "let value = 1;"),
						);
						return {
							filePath: fp,
							formatters: [{ name: "biome", success: true, changed: true }],
							anyChanged: true,
							allSucceeded: true,
						};
					},
				} as unknown as FormatService;
				const run = runPipeline(
					{
						filePath,
						cwd: env.tmpDir,
						toolName: "edit",
						autofixMode: "deferred",
						getFlag: (name: string) =>
							name === "immediate-format" || name === "no-lsp",
						dbg: () => {},
					},
					{
						biomeClient: noBiome as unknown as BiomeClient,
						ruffClient: {} as never,
						metricsClient: {} as never,
						getFormatService: () => formatService,
						fixedThisTurn: new Set<string>(),
					},
				);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				await run;
				await agent.done;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"let value = 1;\nexport const AGENT_EDIT_2 = 2;\n",
				);
			} finally {
				env.cleanup();
			}
		});

		function drainDeps(
			runtime: RuntimeCoordinator,
			env: { tmpDir: string },
			overrides: {
				biomeClient?: BiomeClient;
				getFormatService?: () => FormatService;
			},
		) {
			return {
				ctxCwd: env.tmpDir,
				getFlag: (name: string) => name === "no-lsp",
				notify: () => {},
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: () => {},
				} as unknown as CacheManager,
				biomeClient: overrides.biomeClient,
				ruffClient: {} as never,
				getFormatService:
					overrides.getFormatService ?? (() => ({}) as FormatService),
			};
		}

		it("deferred drain (#3506): the agent_end autofix does not write over an agent edit made through pi's queue", async () => {
			const env = setupTestEnvironment("tla-drain-autofix-");
			try {
				writeBiomeAgreement(env.tmpDir);
				fs.writeFileSync(path.join(env.tmpDir, "biome.json"), "{}\n");
				const filePath = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(filePath, "var a = 1;\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferMutation(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"autofix",
				);
				const { fixer, parked, resume } = gatedFixer("write");
				const drain = handleAgentEnd(
					drainDeps(runtime, env, { biomeClient: fixer }),
				);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				await drain;
				await agent.done;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"const a = 1;\nexport const AGENT_EDIT_2 = 2;\n",
				);
			} finally {
				env.cleanup();
			}
		});

		it("deferred drain (#3506): the agent_end format does not write over an agent edit made through pi's queue", async () => {
			const env = setupTestEnvironment("tla-drain-format-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(filePath, "let value=1\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferMutation(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"format",
				);
				const parked = gate();
				const resume = gate();
				const formatService = {
					recordRead: () => {},
					formatFile: async (fp: string) => {
						const before = fs.readFileSync(fp, "utf8");
						parked.open();
						await resume.p;
						fs.writeFileSync(
							fp,
							before.replace("let value=1", "let value = 1;"),
						);
						return {
							filePath: fp,
							formatters: [{ name: "biome", success: true, changed: true }],
							anyChanged: true,
							allSucceeded: true,
						};
					},
				} as unknown as FormatService;
				const drain = handleAgentEnd(
					drainDeps(runtime, env, { getFormatService: () => formatService }),
				);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				await drain;
				await agent.done;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"let value = 1;\nexport const AGENT_EDIT_2 = 2;\n",
				);
			} finally {
				env.cleanup();
			}
		});
	});

	it("ClaimGap (#3508): with the bootstrap clients not resident, two handlers for one post-write state dispatch once", async () => {
		const env = setupTestEnvironment("tla-claim-gap-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			// `decided` opens once the second handler has either joined the live
			// pipeline (the fixed code) or dispatched its own (the claim gap);
			// only then may the first dispatch finish.
			const decided = gate();
			const finish = gate();
			vi.mocked(dispatchLintWithResult).mockImplementation(async () => {
				if (vi.mocked(dispatchLintWithResult).mock.calls.length > 1)
					decided.open();
				await finish.p;
				return clean("a") as never;
			});
			const dbg: Dbg = (message) => {
				if (message.includes("skipping duplicate concurrent state"))
					decided.open();
			};
			fs.writeFileSync(filePath, "export const a = 1;\n");
			// Two parallel edits of one file both landed before either handler
			// hashed it, so both handlers see the same post-write state.
			const first = handleToolResult({
				...deps(runtime, noBiome, { resident: false, dbg }),
				event: ev("edit", filePath, "c1"),
			} as never);
			const second = handleToolResult({
				...deps(runtime, noBiome, { resident: false, dbg }),
				event: ev("edit", filePath, "c2"),
			} as never);
			// Both handlers park on the bootstrap demand; releasing it resumes
			// them in order.
			await bootstrapGate.parked(2);
			bootstrapGate.release();
			await decided.p;
			finish.open();
			await Promise.all([first, second]);
			expect(vi.mocked(dispatchLintWithResult).mock.calls).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});
