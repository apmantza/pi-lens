import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	registerPrimarySession,
	releasePrimarySession,
} from "../../clients/session-lifecycle.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import {
	clearFormatterRuntimeState,
	getFormattersForFile,
} from "../../clients/formatters.js";
import { getProjectIgnoreMatcher } from "../../clients/file-utils.js";
import {
	getVerifiedPathAttributionGuessCount,
	resetVerifiedPathAttributionGuessCount,
} from "../../clients/path-attribution-telemetry.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const logLatency = vi.hoisted(() => vi.fn());
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
vi.mock("../../clients/lsp/index.js", () => ({ notifyExternalFileChange }));

const readdirMock = vi.mocked(fsp.readdir);
const realReaddir = readdirMock.getMockImplementation()!;

beforeEach(() => {
	readdirMock.mockImplementation(realReaddir);
	readdirMock.mockClear();
});

describe("bash grep searchReads registration", () => {
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
			);
			expect(deferMutation).toHaveBeenCalledWith(
				filePath,
				expect.any(String),
				"edit",
				env.tmpDir,
				"autofix",
				undefined,
				env.tmpDir,
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
			expect(
				vi.mocked(runPipeline).mock.calls.map((call) => call[0].autofixMode),
			).toEqual(["immediate", "deferred"]);
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

			await handleToolCall({
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
			} as any);

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

			await handleToolCall({
				event: {
					toolCallId,
					toolName: "write",
					input: { path: "src/brand-new.ts", content: "export const x = 1;\n" },
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
			} as any);

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

			const result = await handleToolCall({
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
			} as any);

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

			await handleToolCall({
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
			} as any);

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
			await handleToolCall(callDeps("call-A", worktreeA) as any);
			await handleToolCall(callDeps("call-B", worktreeB) as any);

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
