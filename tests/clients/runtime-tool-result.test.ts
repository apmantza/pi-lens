// lane: windows-vitest — #3294's case-spelling cell asserts the host
// filesystem's own answer; no external toolchain is required because the
// production handleToolResult path and pipeline boundary are in-process.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	_resetAgentNudgeForTests,
	consumeAgentNudge,
} from "../../clients/agent-nudge.js";
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
import { normalizeFilePath } from "../../clients/path-utils.js";
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
vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/lsp/capabilities.js")
	>()),
	notifyExternalFileChange,
}));

const readdirMock = vi.mocked(fsp.readdir);
const realReaddir = readdirMock.getMockImplementation()!;

beforeEach(() => {
	requestBootstrapClients.mockClear();
	readdirMock.mockImplementation(realReaddir);
	readdirMock.mockClear();
	_resetAgentNudgeForTests();
});

it("notices once when an edit is outside the session root (#4218)", async () => {
	resetDegradationLedger();
	const env = setupTestEnvironment("pi-lens-4218-outside-root-");
	try {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		const outsidePath = path.join(env.tmpDir, "..", "capture", "outside.ts");
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

it("adopts a home sibling but refuses home, ancestors, and a home symlink (#4230 D1)", () => {
	const env = setupTestEnvironment("pi-lens-4230-home-boundary-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousTmpDir = process.env.TMPDIR;
	// Windows' os.tmpdir() is normally below USERPROFILE, and Windows
	// os.homedir() reads USERPROFILE rather than HOME. Keep this fake home
	// outside the OS temp tree and pin both environment spellings so the D1
	// boundary is testing home ownership, not the temp-root refusal (#4230).
	const home = fs.mkdtempSync(path.join(process.cwd(), ".analysis-root-home-"));
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
	} catch {
		expect(true).toBe(true);
		if (previousTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpDir;
		fs.rmSync(home, { recursive: true, force: true });
		env.cleanup();
		return;
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
				expect(runtime.gitGuardCacheUnknownReason).toBeUndefined();
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
