/**
 * The read guard's evidence comes from the bytes the conversation showed the
 * agent, not from the disk at handler time (#3519, #3523, #3524). Each case
 * replays a `formal/read-guard` counterexample through the real
 * `handleToolCall` / `handleToolResult` / `RuntimeCoordinator` / `ReadGuard`,
 * with pi's real `read` tool. Only the dispatch runners, the LSP service and
 * the fixer process are doubled.
 *
 * "Another writer" is an explicit write between two real handler calls; no
 * sleeps. Every write gets a fresh, strictly increasing mtime so FileTime sees
 * it; fixtures start with an mtime older than any guard.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { computeHashlineAnchors } from "../../clients/hashline-anchor.js";
import { createFileTime } from "../../clients/file-time.js";
import { lineContentHash } from "../../clients/read-guard.js";
import { recordIOEntry } from "../../clients/io-bridge.js";
import {
	READ_BRIDGE_KEY,
	registerReadBridge,
	type ReadBridge,
} from "../../clients/read-bridge.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/integration.js")
	>()),
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/recent-touches.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/recent-touches.js")>()),
	appendRecentTouches: vi.fn().mockResolvedValue(undefined),
}));
// The formatter child process is the boundary: the FormatService, its
// FileTime and the agent_end drain stay real (#3785 review r1 F1). No
// formatter resolves unless a case supplies one.
vi.mock("../../clients/formatters.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/formatters.js")>()),
	getFormattersForFile: vi.fn(async () => []),
	formatFile: vi.fn(),
}));
// The real logger, observed (rows are dropped in test mode).
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency: vi.fn(actual.logLatency) };
});
import {
	getLastLoggedPhase,
	logLatency,
} from "../../clients/latency-logger.js";

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";
import { getFormatService } from "../../clients/format-service.js";
import {
	type FormatterInfo,
	formatFile as runFormatter,
	getFormattersForFile,
} from "../../clients/formatters.js";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";

const CLEAN_DISPATCH = {
	diagnostics: [],
	blockers: [],
	warnings: [],
	baselineWarningCount: 0,
	fixed: [],
	resolvedCount: 0,
	output: "",
	blockerOutput: "",
	hasBlockers: false,
};

const noLspOrComplexity = (name: string) =>
	name === "no-lsp" || name === "no-complexity";
const noReadGuardEither = (name: string) =>
	noLspOrComplexity(name) || name === "no-read-guard";

const FIXTURE_MTIME_MS = Date.now() - 3_600_000;
let nextMtimeMs = Date.now() + 60_000;
const lines = (n: number, prefix = "line") =>
	Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** Write `content` with a fresh mtime, so FileTime sees every write. */
function writeNow(file: string, content: string): void {
	fs.writeFileSync(file, content);
	nextMtimeMs += 10_000;
	fs.utimesSync(file, nextMtimeMs / 1000, nextMtimeMs / 1000);
}
function fixture(dir: string, name: string, content: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	fs.utimesSync(file, FIXTURE_MTIME_MS / 1000, FIXTURE_MTIME_MS / 1000);
	return file;
}
function diskLines(file: string): string[] {
	return fs.readFileSync(file, "utf8").split("\n");
}
function newRuntime(dir: string): RuntimeCoordinator {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = dir;
	return runtime;
}
function callDeps(runtime: RuntimeCoordinator, event: unknown) {
	return {
		event,
		ctx: { cwd: runtime.projectRoot },
		lensEnabled: true,
		getFlag: noLspOrComplexity,
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
	extra: {
		biome?: BiomeClient;
		getFlag?: (name: string) => boolean;
		attachmentBudget?: { remaining: number };
		/** Runs where the handler renders behavior warnings, after the pipeline. */
		afterPipeline?: () => void;
	} = {},
) {
	return {
		event,
		getFlag: extra.getFlag ?? noLspOrComplexity,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		biomeClient: extra.biome ?? {
			isSupportedFile: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isPythonFile: () => false,
			ensureAvailable: async () => false,
		},
		metricsClient: {},
		resetLSPService: () => {},
		readGuard: runtime.readGuard,
		agentBehaviorRecord: () => (extra.afterPipeline ? ["warning"] : []),
		formatBehaviorWarnings: () => {
			extra.afterPipeline?.();
			return "";
		},
		...(extra.attachmentBudget
			? { _attachmentBudget: extra.attachmentBudget }
			: {}),
	} as never;
}

let seq = 0;

/**
 * pi's read: tool_call, pi's real `read` tool, optional `gate` (another
 * writer between the host read and the handler), tool_result. `rewrite`
 * stands in for another producer that rewrote the delivered text.
 */
async function piRead(
	runtime: RuntimeCoordinator,
	file: string,
	input: { offset?: number; limit?: number },
	opts: {
		gate?: () => void | Promise<void>;
		beforeExec?: () => void;
		afterToolCall?: () => void;
		rewrite?: (text: string) => string;
		skipToolCall?: boolean;
	} = {},
): Promise<string> {
	const toolCallId = `read-${++seq}`;
	const args = { path: file, ...input };
	if (!opts.skipToolCall) {
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(
				callDeps(runtime, { toolName: "read", toolCallId, input: args }),
			),
		);
		opts.afterToolCall?.();
	}
	opts.beforeExec?.();
	const tool = createReadToolDefinition(runtime.projectRoot);
	const result = await tool.execute(toolCallId, args, undefined, undefined, {
		cwd: runtime.projectRoot,
	} as never);
	await opts.gate?.();
	const content = opts.rewrite
		? result.content.map((part: { type: string; text?: string }) =>
				part.type === "text" && part.text !== undefined
					? { ...part, text: opts.rewrite!(part.text) }
					: part,
			)
		: result.content;
	await handleToolResult(
		resultDeps(runtime, {
			toolName: "read",
			toolCallId,
			input: args,
			content,
			details: result.details,
		}),
	);
	return content.map((part: { text?: string }) => part.text ?? "").join("\n");
}

type RangeEdit = {
	range: { start: { line: number }; end: { line: number } };
	newText: string;
};

/** A positional edit's tool_call. Returns the verdict and the (possibly relocated) input. */
async function positionalEdit(
	runtime: RuntimeCoordinator,
	file: string,
	edits: Array<[start: number, end: number, newText: string]>,
) {
	const toolCallId = `edit-${++seq}`;
	const input = {
		path: file,
		edits: edits.map(([start, end, newText]): RangeEdit => ({
			range: { start: { line: start }, end: { line: end } },
			newText,
		})),
	};
	const verdict = (await runHandlerExpectingNoThrow(() =>
		handleToolCall(callDeps(runtime, { toolName: "edit", toolCallId, input })),
	)) as { block?: boolean; reason?: string } | undefined;
	return {
		toolCallId,
		input,
		blocked: verdict?.block === true,
		reason: verdict?.reason,
		ranges: input.edits.map(
			(edit) => [edit.range.start.line, edit.range.end.line] as const,
		),
	};
}

/**
 * The host applies the (executed) positional edits against the ORIGINAL
 * file's line numbers, bottom-up, then pi-lens' tool_result runs. `gate`
 * lands between the apply and the handler.
 */
async function applyEdit(
	runtime: RuntimeCoordinator,
	file: string,
	edit: Awaited<ReturnType<typeof positionalEdit>>,
	gate?: () => void,
	/** The lines a host writes for `newText`; a raw split writes a trailing "\n" as a blank line. */
	hostLines: (newText: string) => string[] = (newText) => newText.split("\n"),
): Promise<void> {
	const current = diskLines(file);
	const ordered = [...edit.input.edits].sort(
		(a, b) => b.range.start.line - a.range.start.line,
	);
	for (const { range, newText } of ordered) {
		current.splice(
			range.start.line - 1,
			range.end.line - range.start.line + 1,
			...hostLines(newText),
		);
	}
	writeNow(file, current.join("\n"));
	gate?.();
	await handleToolResult(
		resultDeps(runtime, {
			toolName: "edit",
			toolCallId: edit.toolCallId,
			input: edit.input,
			content: [{ type: "text", text: "ok" }],
		}),
	);
}

/**
 * pi's `write`: tool_call, the host writes `content` verbatim (pi's write
 * tool is `writeFile(path, content, "utf-8")`), `gate` (another writer
 * between the host write and the handler), tool_result. No autofix runs.
 */
async function piWrite(
	runtime: RuntimeCoordinator,
	file: string,
	content: string,
	gate?: () => void,
): Promise<void> {
	const toolCallId = `write-${++seq}`;
	const input = { path: file, content };
	await runHandlerExpectingNoThrow(() =>
		handleToolCall(callDeps(runtime, { toolName: "write", toolCallId, input })),
	);
	writeNow(file, content);
	gate?.();
	await handleToolResult(
		resultDeps(runtime, { toolName: "write", toolCallId, input, content: [] }),
	);
}

/**
 * pi's native `edit` (oldText/newText): tool_call, host apply, `gate`
 * (another writer between the host apply and the handler), tool_result.
 */
async function textEdit(
	runtime: RuntimeCoordinator,
	file: string,
	oldText: string,
	newText: string,
	gate?: () => void,
): Promise<{ blocked: boolean; reason?: string }> {
	const toolCallId = `text-edit-${++seq}`;
	const input = { path: file, edits: [{ oldText, newText }] };
	const verdict = (await runHandlerExpectingNoThrow(() =>
		handleToolCall(callDeps(runtime, { toolName: "edit", toolCallId, input })),
	)) as { block?: boolean; reason?: string } | undefined;
	if (verdict?.block === true) return { blocked: true, reason: verdict.reason };
	writeNow(file, fs.readFileSync(file, "utf8").replace(oldText, newText));
	gate?.();
	await handleToolResult(
		resultDeps(runtime, {
			toolName: "edit",
			toolCallId,
			input,
			content: [{ type: "text", text: "ok" }],
		}),
	);
	return { blocked: false };
}

/** The host's apply of a one-line replacement at line `n` (1-based). */
function hostApplyLine(file: string, n: number, text: string): void {
	const v = diskLines(file);
	v[n - 1] = text;
	writeNow(file, v.join("\n"));
}

/** A `write` whose turn-first autofix (a biome double) drops line 1. */
async function writeWithAutofix(
	runtime: RuntimeCoordinator,
	file: string,
	content: string,
	extra: {
		getFlag?: (name: string) => boolean;
		attachmentBudget?: { remaining: number };
		afterPipeline?: () => void;
	} = {},
) {
	const biome = {
		isSupportedFile: () => true,
		ensureAvailable: async () => true,
		fixFileAsync: async (target: string) => {
			writeNow(target, diskLines(target).slice(1).join("\n"));
			return { success: true, changed: true, fixed: 1 };
		},
	} as unknown as BiomeClient;
	const input = { path: file, content };
	await runHandlerExpectingNoThrow(() =>
		handleToolCall(
			callDeps(runtime, { toolName: "write", toolCallId: "w1", input }),
		),
	);
	writeNow(file, content);
	const res = (await handleToolResult(
		resultDeps(
			runtime,
			{ toolName: "write", toolCallId: "w1", input, content: [] },
			{ biome, ...extra },
		),
	)) as { content: Array<{ text?: string }> } | undefined;
	return (res?.content ?? [])
		.map((part) => part.text ?? "")
		.find((text) => text.startsWith("pi-lens applied autofix"));
}

function biomeProject(dir: string): void {
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.4.10" } }),
	);
	fs.writeFileSync(
		path.join(dir, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": {},
				"node_modules/@biomejs/biome": { version: "2.4.10" },
			},
		}),
	);
}

const WRITTEN = [
	"import unused;",
	"const a = 1;",
	"const b = 2;",
	"const c = 3;",
	"const d = 4;",
].join("\n");

beforeEach(async () => {
	resetDegradationLedger();
	vi.mocked(logLatency).mockClear();
	await installLspServiceDouble({
		supportsLSP: () => false,
		hasLSP: async () => false,
		openFile: async () => {},
		touchFile: async () => {},
		getAllDiagnostics: async () => new Map(),
	});
	vi.mocked(dispatchLintWithResult).mockReset();
	vi.mocked(dispatchLintWithResult).mockResolvedValue(CLEAN_DISPATCH as never);
});

/**
 * The real cross-extension read bridge, registered once for the file (its
 * global property is non-configurable); `_bridgeRuntime` points it at the
 * current case's guard. #3654: the v1 shim runs the unified bridge body,
 * wired as index.ts wires it; only the read half of the deps is reachable
 * from a read.
 */
let _bridgeRuntime: RuntimeCoordinator | undefined;
function wireReadBridge(): void {
	const unused = (): never => {
		throw new Error("read-only bridge deps: unexpected mutation call");
	};
	const deps = {
		getRuntime: unused,
		getCacheManager: unused,
		getProjectRoot: unused,
		getDispatchCwd: unused,
		countFileLines: unused,
		isRecordable: () => true,
		getReadGuard: () => _bridgeRuntime!.readGuard,
		getTurnIndex: () => 0,
		peekWriteIndex: () => 0,
		getFlag: () => undefined,
		isExternalOrVendorFile: unused,
		isPathIgnoredByProject: unused,
		notifyExternalFileChange: unused,
		nodeFs: { existsSync: fs.existsSync, statSync: fs.statSync },
	};
	registerReadBridge({
		isRecordable: () => true,
		forward: (entry) => recordIOEntry(entry, deps),
	});
}

describe("#3519: the attached post-autofix bytes are a read", () => {
	it("allows a one-line edit at the attachment's line numbers (AutofixFalseBlock)", async () => {
		const env = setupTestEnvironment("rg-3519-attach-one-");
		try {
			biomeProject(env.tmpDir);
			const file = fixture(env.tmpDir, "b.ts", "old\n");
			const runtime = newRuntime(env.tmpDir);
			const attached = await writeWithAutofix(runtime, file, WRITTEN);
			// The agent now holds the attachment: line 2 = "const b = 2;".
			expect(attached).toContain(
				"authoritative for subsequent edits:\n\nconst a = 1;\nconst b = 2;",
			);
			const one = await positionalEdit(runtime, file, [
				[2, 2, "const b = 20;"],
			]);
			expect(one.reason).toBeUndefined();
			expect(one.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not relocate a two-line edit at the attachment's line numbers (AutofixRelocate)", async () => {
		const env = setupTestEnvironment("rg-3519-attach-two-");
		try {
			biomeProject(env.tmpDir);
			const file = fixture(env.tmpDir, "b.ts", "old\n");
			const runtime = newRuntime(env.tmpDir);
			await writeWithAutofix(runtime, file, WRITTEN);
			const two = await positionalEdit(runtime, file, [
				[2, 3, "const b = 20;\nconst c = 30;"],
			]);
			expect(two.ranges).toEqual([[2, 3]]);
			expect(two.blocked).toBe(false);
			expect(diskLines(file).slice(1, 3)).toEqual([
				"const b = 2;",
				"const c = 3;",
			]);
			const record = runtime.readGuard.getReadHistory(file).at(-1);
			expect(record?.source).toBe("autofix-attachment");
			expect([record?.effectiveOffset, record?.effectiveLimit]).toEqual([1, 4]);
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "read_guard_conversation_read",
					metadata: {
						source: "autofix-attachment",
						offset: 1,
						lineCount: 4,
						hashed: true,
					},
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps an attachment the shared budget withheld unrecorded, so pre-fix line numbers still relocate", async () => {
		const env = setupTestEnvironment("rg-3519-withheld-");
		try {
			biomeProject(env.tmpDir);
			const file = fixture(env.tmpDir, "b.ts", "old\n");
			const runtime = newRuntime(env.tmpDir);
			const attached = await writeWithAutofix(runtime, file, WRITTEN, {
				attachmentBudget: { remaining: 0 },
			});
			expect(attached).toBeUndefined();
			// Without the attachment the agent's view is its own write: lines 3-4
			// are "const b"/"const c", which the fix moved to 2-3.
			const edit = await positionalEdit(runtime, file, [
				[3, 4, "const b = 20;\nconst c = 30;"],
			]);
			expect(edit.blocked).toBe(false);
			expect(edit.ranges).toEqual([[2, 3]]);
			expect(
				runtime.readGuard
					.getReadHistory(file)
					.some((record) => record.source === "autofix-attachment"),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("hashes the attached bytes, so a write during the pipeline's analysis is not credited", async () => {
		const env = setupTestEnvironment("rg-3519-analysis-write-");
		try {
			biomeProject(env.tmpDir);
			const file = fixture(env.tmpDir, "b.ts", "old\n");
			const runtime = newRuntime(env.tmpDir);
			// Another writer lands after the pipeline read the post-fix bytes,
			// while its analysis runs (pi's queue is free again by then).
			vi.mocked(dispatchLintWithResult).mockImplementationOnce(async () => {
				const v = diskLines(file);
				v[1] = "EXTERNAL2";
				writeNow(file, v.join("\n"));
				return CLEAN_DISPATCH as never;
			});
			await writeWithAutofix(runtime, file, WRITTEN);
			expect(diskLines(file)[1]).toBe("EXTERNAL2");
			const edit = await positionalEdit(runtime, file, [
				[2, 2, "const b = 20;"],
			]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("Edit range changed since read");
		} finally {
			env.cleanup();
		}
	});

	it("leaves FileTime to recordWritten, so a write after it stays visible on an unhashed attachment", async () => {
		const env = setupTestEnvironment("rg-3519-unhashed-");
		try {
			biomeProject(env.tmpDir);
			const file = fixture(env.tmpDir, "big.ts", "old\n");
			const runtime = newRuntime(env.tmpDir);
			// 3001 post-fix lines: past READ_HASH_MAX_LINES, so FileTime is the
			// attachment record's only staleness check.
			const big = ["import unused;", ...lines(3001, "const v")].join("\n");
			await writeWithAutofix(runtime, file, big, {
				// Another writer lands after recordWritten stamped the fixed file
				// and before the attachment is recorded.
				afterPipeline: () => {
					const v = diskLines(file);
					v[4] = "EXTERNAL5";
					writeNow(file, v.join("\n"));
				},
			});
			const record = runtime.readGuard.getReadHistory(file).at(-1);
			expect(record?.source).toBe("autofix-attachment");
			expect(record?.lineHashes).toBeUndefined();
			const edit = await positionalEdit(runtime, file, [[5, 5, "agent5"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("records no attachment read under --no-read-guard", async () => {
		const env = setupTestEnvironment("rg-3519-no-guard-");
		try {
			biomeProject(env.tmpDir);
			const file = fixture(env.tmpDir, "b.ts", "old\n");
			const runtime = newRuntime(env.tmpDir);
			const attached = await writeWithAutofix(runtime, file, WRITTEN, {
				getFlag: noReadGuardEither,
			});
			expect(attached).toContain("authoritative for subsequent edits");
			expect(
				runtime.readGuard
					.getReadHistory(file)
					.some((record) => record.source === "autofix-attachment"),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

describe("#3523: the agent's own positional edit is a read", () => {
	it.each([0, -5])(
		"records the clamped offset and allows editing the last shown line when native read offset is %s (#3588)",
		async (offset) => {
			const env = setupTestEnvironment(`rg-3588-offset-${offset}-`);
			try {
				const file = fixture(env.tmpDir, "g.ts", `${lines(6).join("\n")}\n`);
				const runtime = newRuntime(env.tmpDir);
				let provisionalOffset: number | undefined;
				await piRead(
					runtime,
					file,
					{ offset, limit: 3 },
					{
						afterToolCall: () => {
							provisionalOffset = runtime.readGuard
								.getReadHistory(file)
								.at(-1)?.requestedOffset;
						},
					},
				);
				expect(provisionalOffset).toBe(1);
				expect(
					runtime.readGuard.getReadHistory(file).at(-1)?.requestedOffset,
				).toBe(1);
				const edit = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
				expect(edit.blocked).toBe(false);
			} finally {
				env.cleanup();
			}
		},
	);

	// Prevents provisional full-read evidence from over-counting past EOF,
	// which makes read_pattern fractionRead exceed 1 (#3714 F1).
	it.each([0, -5])(
		"clamps the provisional full-read limit to the file line count at offset %s (#3588)",
		async (offset) => {
			const env = setupTestEnvironment(`rg-3588-full-read-${offset}-`);
			try {
				const file = fixture(env.tmpDir, "g.ts", `${lines(6).join("\n")}\n`);
				const runtime = newRuntime(env.tmpDir);
				await piRead(
					runtime,
					file,
					{ offset },
					{
						afterToolCall: () => {
							const record = runtime.readGuard.getReadHistory(file).at(-1);
							expect([record?.requestedLimit, record?.effectiveLimit]).toEqual([
								7, 7,
							]);
						},
					},
				);
			} finally {
				env.cleanup();
			}
		},
	);

	it("allows re-editing the line the agent just wrote (OwnReEdit)", async () => {
		const env = setupTestEnvironment("rg-3523-reedit-");
		const realLogLatency = vi.mocked(logLatency).getMockImplementation()!;
		const lastPhaseAtRecord: Array<string | undefined> = [];
		vi.mocked(logLatency).mockImplementation((entry) => {
			realLogLatency(entry);
			if (entry.phase === "read_guard_conversation_read")
				lastPhaseAtRecord.push(getLastLoggedPhase()?.phase);
		});
		try {
			const file = fixture(env.tmpDir, "g.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 6 });
			const first = await positionalEdit(runtime, file, [[2, 2, "agent2"]]);
			expect(first.blocked).toBe(false);
			await applyEdit(runtime, file, first);
			// The record stays out of stall attribution: read the last-phase
			// pointer the moment the record is logged.
			expect(lastPhaseAtRecord).toHaveLength(1);
			expect(lastPhaseAtRecord[0]).not.toBe("read_guard_conversation_read");
			const second = await positionalEdit(runtime, file, [[2, 2, "agent2b"]]);
			expect(second.reason).toBeUndefined();
			expect(second.blocked).toBe(false);
			const record = runtime.readGuard.getReadHistory(file).at(-1);
			expect(record?.source).toBe("own-edit");
			expect(record?.lineHashes).toEqual({ 2: lineContentHash("agent2") });
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "read_guard_conversation_read",
					metadata: {
						source: "own-edit",
						offset: 2,
						lineCount: 1,
						hashed: true,
					},
				}),
			);
		} finally {
			vi.mocked(logLatency).mockImplementation(realLogLatency);
			env.cleanup();
		}
	});

	// #3739 F1: `deliveredLineEvidence("agent5\n", 5)` covers lines 5-6, the
	// second an empty line. A host that takes the "\n" as line 5's terminator
	// writes no such line, and the own-edit record must not claim it: it would
	// shadow the agent's good read of the real line 6. No installed package
	// implements `edits[].range` (pi 0.87.1's edit is oldText-only), so both
	// host semantics are replayed.
	it("allows the next line after an own edit whose newText ends in a newline the host takes as a terminator", async () => {
		const env = setupTestEnvironment("rg-3739-terminator-");
		try {
			const file = fixture(env.tmpDir, "t.ts", `${lines(12).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, {});
			const first = await positionalEdit(runtime, file, [[5, 5, "agent5\n"]]);
			expect(first.blocked).toBe(false);
			await applyEdit(runtime, file, first, undefined, (text) =>
				text.replace(/\n$/, "").split("\n"),
			);
			expect(diskLines(file)[5]).toBe("line6");
			// The record covers exactly the line the host wrote.
			expect(runtime.readGuard.getReadHistory(file).at(-1)?.lineHashes).toEqual(
				{ 5: lineContentHash("agent5") },
			);
			const next = await positionalEdit(runtime, file, [[6, 6, "agent6"]]);
			expect(next.reason).toBeUndefined();
			expect(next.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("claims no trailing empty line when the file cannot be read back after the edit", async () => {
		const env = setupTestEnvironment("rg-3739-unreadable-");
		try {
			const file = fixture(env.tmpDir, "t.ts", `${lines(12).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, {});
			const first = await positionalEdit(runtime, file, [[5, 5, "agent5\n"]]);
			await applyEdit(
				runtime,
				file,
				first,
				() => fs.rmSync(file),
				(text) => text.split("\n"),
			);
			expect(runtime.readGuard.getReadHistory(file).at(-1)?.lineHashes).toEqual(
				{ 5: lineContentHash("agent5") },
			);
		} finally {
			env.cleanup();
		}
	});

	it("allows the blank line the agent wrote when the host writes a newText's trailing newline as one", async () => {
		const env = setupTestEnvironment("rg-3739-blank-line-");
		try {
			const file = fixture(env.tmpDir, "t.ts", `${lines(12).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, {});
			const first = await positionalEdit(runtime, file, [[5, 5, "agent5\n"]]);
			expect(first.blocked).toBe(false);
			await applyEdit(runtime, file, first);
			expect(diskLines(file).slice(4, 7)).toEqual(["agent5", "", "line6"]);
			expect(runtime.readGuard.getReadHistory(file).at(-1)?.lineHashes).toEqual(
				{ 5: lineContentHash("agent5"), 6: lineContentHash("") },
			);
			const next = await positionalEdit(runtime, file, [[6, 6, "agent6"]]);
			expect(next.reason).toBeUndefined();
			expect(next.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("still blocks a foreign change to the agent's own line after its edit", async () => {
		const env = setupTestEnvironment("rg-3523-foreign-after-");
		// One frozen millisecond: the own-edit record ties the edit's verdict
		// record, the #3523 tie that let the 120 s own-edit rescue skip
		// FileTime and the range-stale grace downgrade to a warn (#3525).
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
		try {
			const file = fixture(env.tmpDir, "g.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 6 });
			const first = await positionalEdit(runtime, file, [[2, 2, "agent2"]]);
			await applyEdit(runtime, file, first);
			const v = diskLines(file);
			v[1] = "EXTERNAL2";
			writeNow(file, v.join("\n"));
			const second = await positionalEdit(runtime, file, [[2, 2, "agent2b"]]);
			expect(second.blocked).toBe(true);
			expect(second.reason).toContain("File modified since read");
		} finally {
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("hashes the agent's newText, so a write between the host's apply and the handler is not credited", async () => {
		const env = setupTestEnvironment("rg-3523-apply-race-");
		try {
			const file = fixture(env.tmpDir, "g.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 6 });
			const first = await positionalEdit(runtime, file, [[2, 2, "agent2"]]);
			await applyEdit(runtime, file, first, () => {
				const v = diskLines(file);
				v[1] = "EXTERNAL2";
				writeNow(file, v.join("\n"));
			});
			const second = await positionalEdit(runtime, file, [[2, 2, "agent2b"]]);
			expect(second.blocked).toBe(true);
			expect(second.reason).toContain("Edit range changed since read");
		} finally {
			env.cleanup();
		}
	});

	it("does not record a relocated edit at the agent's line numbers (OwnEditRelocInsert)", async () => {
		const env = setupTestEnvironment("rg-3523-relocated-");
		try {
			const file = fixture(env.tmpDir, "r.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 10 });
			// Another writer inserts a line above; a later read elsewhere stamps
			// FileTime without re-reading lines 1-2.
			writeNow(file, ["INSERTED", ...diskLines(file)].join("\n"));
			await piRead(runtime, file, { offset: 8, limit: 2 });
			const moved = await positionalEdit(runtime, file, [[1, 2, "n1\nn2"]]);
			expect(moved.blocked).toBe(false);
			expect(moved.ranges).toEqual([[2, 3]]);
			await applyEdit(runtime, file, moved);
			// The agent believes line 2 holds "n2"; the file has "n1" there.
			expect(diskLines(file)[1]).toBe("n1");
			const again = await positionalEdit(runtime, file, [[2, 2, "n2b"]]);
			expect(again.blocked).toBe(true);
			expect(again.reason).toContain("Edit range changed since read");
		} finally {
			env.cleanup();
		}
	});

	it("does not record the edits of a multi-edit batch at their original line numbers", async () => {
		const env = setupTestEnvironment("rg-3523-batch-");
		try {
			const file = fixture(env.tmpDir, "m.ts", `${lines(8, "a").join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 8 });
			const batch = await positionalEdit(runtime, file, [
				[5, 6, "X\nY"],
				[2, 2, "b\nc"],
			]);
			expect(batch.blocked).toBe(false);
			await applyEdit(runtime, file, batch);
			expect(diskLines(file).slice(0, 8)).toEqual([
				"a1",
				"b",
				"c",
				"a3",
				"a4",
				"X",
				"Y",
				"a7",
			]);
			// The agent's lines 5-6 are "a4"/"X"; X/Y sit at 6-7.
			const next = await positionalEdit(runtime, file, [[5, 6, "p\nq"]]);
			expect(next.ranges).toEqual([[5, 6]]);
			expect(next.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// #3760: the shapes whose written lines pi-lens cannot place record no
	// own-edit read, so the re-edit is a re-read, never an allow from a guessed
	// geometry. Recurrence: recording them from a host contract no test pins.
	const ownEditRecords = (runtime: RuntimeCoordinator, file: string) =>
		runtime.readGuard
			.getReadHistory(file)
			.filter((record) => record.source === "own-edit").length;

	it("records no own-edit read for an oldRange edit, which carries no text", async () => {
		const env = setupTestEnvironment("rg-3760-old-range-");
		try {
			const file = fixture(env.tmpDir, "o.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 6 });
			const oldRangeEdit = async (toolCallId: string) => {
				const input = {
					path: file,
					oldRange: { start: { line: 2 }, end: { line: 2 } },
				};
				const verdict = (await runHandlerExpectingNoThrow(() =>
					handleToolCall(
						callDeps(runtime, { toolName: "edit", toolCallId, input }),
					),
				)) as { block?: boolean; reason?: string } | undefined;
				return { input, verdict };
			};
			const first = await oldRangeEdit(`old-range-${++seq}`);
			expect(first.verdict?.block).not.toBe(true);
			hostApplyLine(file, 2, "agent2");
			await handleToolResult(
				resultDeps(runtime, {
					toolName: "edit",
					toolCallId: `old-range-${seq}`,
					input: first.input,
					content: [{ type: "text", text: "ok" }],
				}),
			);
			expect(ownEditRecords(runtime, file)).toBe(0);
			const again = await oldRangeEdit(`old-range-${++seq}`);
			expect(again.verdict?.block).toBe(true);
			expect(again.verdict?.reason).toContain("Edit range changed since read");
		} finally {
			env.cleanup();
		}
	});

	it("records no own-edit read for a hashline replace, whose anchors pi-lens recomputes", async () => {
		const env = setupTestEnvironment("rg-3760-hashline-");
		try {
			const file = fixture(env.tmpDir, "h.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 6 });
			const replace = async (toolCallId: string) => {
				const anchors = computeHashlineAnchors(fs.readFileSync(file, "utf8"));
				const input = {
					path: file,
					remove_from: anchors?.[1],
					remove_to: anchors?.[1],
					replacement_lines: ["agent2"],
				};
				const verdict = (await runHandlerExpectingNoThrow(() =>
					handleToolCall(
						callDeps(runtime, { toolName: "replace", toolCallId, input }),
					),
				)) as { block?: boolean; reason?: string } | undefined;
				return { input, verdict };
			};
			const first = await replace(`hashline-${++seq}`);
			expect(first.verdict?.block).not.toBe(true);
			hostApplyLine(file, 2, "agent2");
			await handleToolResult(
				resultDeps(runtime, {
					toolName: "replace",
					toolCallId: `hashline-${seq}`,
					input: first.input,
					content: [{ type: "text", text: "replaced" }],
				}),
			);
			expect(ownEditRecords(runtime, file)).toBe(0);
			const again = await replace(`hashline-${++seq}`);
			expect(again.verdict?.block).toBe(true);
			expect(again.verdict?.reason).toContain("Edit range changed since read");
		} finally {
			env.cleanup();
		}
	});
});

describe("#3524: a native read's evidence is the delivered text", () => {
	it("does not credit a write that lands after pi's read and before its tool_result (EvidenceAtResult)", async () => {
		const env = setupTestEnvironment("rg-3524-race-");
		try {
			const file = fixture(env.tmpDir, "a.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			const delivered = await piRead(
				runtime,
				file,
				{ offset: 1, limit: 6 },
				{
					gate: () => {
						const v = lines(6);
						v[2] = "EXTERNAL3";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			expect(delivered.split("\n")[2]).toBe("line3");
			expect(
				runtime.readGuard.getReadHistory(file).at(-1)?.lineHashes?.[3],
			).toBe(lineContentHash("line3"));
			const edit = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(edit.blocked).toBe(true);
			expect(
				getDegradationSummary().find(
					(g) => g.kind === "native-read-raced-writer",
				)?.count,
			).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("keeps disk evidence for a read whose delivered text another producer rewrote", async () => {
		const env = setupTestEnvironment("rg-3524-rewritten-");
		try {
			const file = fixture(env.tmpDir, "t.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{ offset: 1, limit: 6 },
				{
					rewrite: (text) =>
						text
							.split("\n")
							.map((line, i) => `${i + 1}│${line}`)
							.join("\n"),
				},
			);
			// A whitespace-only touch: FileTime moves, the hash rescue absorbs it.
			writeNow(file, fs.readFileSync(file, "utf8").replace("line3", "line3  "));
			const edit = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
			expect(
				getDegradationSummary().some(
					(g) => g.kind === "native-read-raced-writer",
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("falls back to the tool_call's capture for a raced read whose delivered text another producer decorated", async () => {
		const env = setupTestEnvironment("rg-3524-decorated-race-");
		try {
			const file = fixture(env.tmpDir, "t.ts", `${lines(12).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{ offset: 1, limit: 12 },
				{
					rewrite: (text) =>
						text
							.split("\n")
							.map((line, i) => `${i + 1}│${line}`)
							.join("\n"),
					gate: () => {
						const v = lines(12);
						v[10] = "EXTERNAL11";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			// The changed line first, so no own-edit record can stand in for it.
			const changed = await positionalEdit(runtime, file, [[11, 11, "a11"]]);
			expect(changed.blocked).toBe(true);
			// Line 3 did not change: an edit of it must not be refused.
			const edit = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
			expect(
				getDegradationSummary()
					.find((g) => g.kind === "native-read-raced-writer")
					?.latestReasons.at(-1)?.reason,
			).toContain("the tool_call's capture is the evidence");
		} finally {
			env.cleanup();
		}
	});

	it("falls back to the tool_call's capture for a raced read another extension led with a note", async () => {
		const env = setupTestEnvironment("rg-3524-noted-race-");
		try {
			const file = fixture(env.tmpDir, "u.ts", `${lines(20).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{ offset: 1, limit: 12 },
				{
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: () => {
						const v = lines(20);
						v[10] = "EXTERNAL11";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			const changed = await positionalEdit(runtime, file, [[11, 11, "a11"]]);
			expect(changed.blocked).toBe(true);
			const edit = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("records nothing for a decorated raced read with no tool_call capture", async () => {
		const env = setupTestEnvironment("rg-3524-noted-race-no-call-");
		try {
			const file = fixture(env.tmpDir, "v.ts", `${lines(20).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 12 });
			await piRead(
				runtime,
				file,
				{ offset: 1, limit: 12 },
				{
					skipToolCall: true,
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: () => {
						const v = lines(20);
						v[10] = "EXTERNAL11";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			expect(runtime.readGuard.getReadHistory(file)).toHaveLength(1);
			const changed = await positionalEdit(runtime, file, [[11, 11, "a11"]]);
			expect(changed.blocked).toBe(true);
			// An own edit elsewhere re-stamps FileTime; the foreign line 11 is
			// still refused.
			const own = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(own.blocked).toBe(false);
			await applyEdit(runtime, file, own);
			const after = await positionalEdit(runtime, file, [[11, 11, "a11"]]);
			expect(after.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("records nothing for a decorated raced read whose tool_call capture was evicted", async () => {
		const env = setupTestEnvironment("rg-3524-noted-race-evicted-");
		try {
			const file = fixture(env.tmpDir, "x.ts", `${lines(20).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{ offset: 1, limit: 12 },
				{
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: async () => {
						// 128 later reads of lines 1-4 push the capture past the
						// per-file record cap before the result arrives.
						for (let i = 0; i < 128; i++) {
							await piRead(runtime, file, { offset: 1, limit: 4 });
						}
						expect(
							runtime.readGuard
								.getReadHistory(file)
								.some((record) => record.provisional === true),
						).toBe(false);
						const v = lines(20);
						v[10] = "EXTERNAL11";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			const own = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(own.blocked).toBe(false);
			await applyEdit(runtime, file, own);
			const changed = await positionalEdit(runtime, file, [[11, 11, "a11"]]);
			expect(changed.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("takes the newest capture when a tool_call id is reused", async () => {
		const env = setupTestEnvironment("rg-3524-reused-capture-");
		try {
			const file = fixture(env.tmpDir, "r.ts", `${lines(20).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			const args = { path: file, offset: 1, limit: 12 };
			// A tool_call whose result never came (another extension blocked it).
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					callDeps(runtime, {
						toolName: "read",
						toolCallId: "call_9",
						input: args,
					}),
				),
			);
			await piRead(runtime, file, { offset: 1, limit: 12 });
			const own = await positionalEdit(runtime, file, [[5, 5, "own5"]]);
			await applyEdit(runtime, file, own);
			// The id comes back: decorated, and raced on line 11.
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					callDeps(runtime, {
						toolName: "read",
						toolCallId: "call_9",
						input: args,
					}),
				),
			);
			const tool = createReadToolDefinition(runtime.projectRoot);
			const result = await tool.execute("call_9", args, undefined, undefined, {
				cwd: runtime.projectRoot,
			} as never);
			const v = diskLines(file);
			v[10] = "EXTERNAL11";
			writeNow(file, v.join("\n"));
			await handleToolResult(
				resultDeps(runtime, {
					toolName: "read",
					toolCallId: "call_9",
					input: args,
					content: [
						{ type: "text", text: "[other-extension: header note]" },
						...result.content,
					],
					details: result.details,
				}),
			);
			const record = runtime.readGuard.getReadHistory(file).at(-1);
			expect(record?.lineHashes?.[5]).toBe(lineContentHash("own5"));
			const changed = await positionalEdit(runtime, file, [[11, 11, "a11"]]);
			expect(changed.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("refuses the shifted line of a whole-file raced read another extension led with a note", async () => {
		const env = setupTestEnvironment("rg-3524-countless-insert-");
		try {
			const file = fixture(env.tmpDir, "y.ts", `${lines(12).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{},
				{
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: () => writeNow(file, `INSERTED\n${lines(12).join("\n")}\n`),
				},
			);
			// The agent saw "line5" at line 5; the disk now holds "line4" there.
			expect(diskLines(file)[4]).toBe("line4");
			const edit = await positionalEdit(runtime, file, [[5, 5, "agent5"]]);
			expect(edit.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("refuses a line a whole-file decorated raced read blanked by coincidence", async () => {
		const env = setupTestEnvironment("rg-3524-countless-blank-");
		try {
			const file = fixture(env.tmpDir, "q.ts", "a\n\nc\nd\ne\n");
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{},
				{
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: () => writeNow(file, "a\n\n\nd\ne\n"),
				},
			);
			// The agent saw "c" at line 3; the disk now holds a blank line.
			const edit = await positionalEdit(runtime, file, [[3, 3, "c2"]]);
			expect(edit.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("does not cover a line pi truncated from a decorated whole-file raced read", async () => {
		const env = setupTestEnvironment("rg-3524-truncated-lines-");
		try {
			const file = fixture(env.tmpDir, "h.ts", `${lines(2500).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{},
				{
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: () => {
						const v = lines(2500);
						v[4] = "EXTERNAL5";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			// pi showed lines 1-2000; lines 2001 and 2400 were never shown.
			const edit = await positionalEdit(runtime, file, [[2400, 2400, "blind"]]);
			expect(edit.blocked).toBe(true);
			const next = await positionalEdit(runtime, file, [[2001, 2001, "blind"]]);
			expect(next.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("refuses the shifted line of a decorated raced read pi truncated", async () => {
		const env = setupTestEnvironment("rg-3524-truncated-shift-");
		try {
			const file = fixture(env.tmpDir, "t2.ts", `${lines(2500).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{},
				{
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: () => writeNow(file, `INSERTED\n${lines(2500).join("\n")}\n`),
				},
			);
			// The agent saw "line5" at line 5; the disk now holds "line4".
			const edit = await positionalEdit(runtime, file, [[5, 5, "agent5"]]);
			expect(edit.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("does not cover a line pi cut at its byte limit from a decorated limited raced read", async () => {
		const env = setupTestEnvironment("rg-3524-truncated-bytes-");
		try {
			const long = Array.from(
				{ length: 600 },
				(_, i) => `const v${i + 1} = "${"x".repeat(150)}";`,
			);
			const file = fixture(env.tmpDir, "h2.ts", `${long.join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			const shown = await piRead(
				runtime,
				file,
				{ offset: 1, limit: 600 },
				{
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: () => {
						const v = [...long];
						v[4] = "EXTERNAL5";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			expect(shown).toMatch(/\[Showing lines 1-307 of 601 \(50\.0KB limit\)/);
			const edit = await positionalEdit(runtime, file, [[550, 550, "blind"]]);
			expect(edit.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("records nothing for a decorated raced read whose capture was too long to hash", async () => {
		const env = setupTestEnvironment("rg-3524-unhashed-capture-");
		try {
			// 3500 lines: past the 3000-line hash bound, so the capture has no hashes.
			const file = fixture(env.tmpDir, "u.ts", `${lines(3500).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 4 });
			await piRead(
				runtime,
				file,
				{},
				{
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: () => {
						const v = lines(3500);
						v[1499] = "EXTERNAL1500";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			// An own edit re-stamps FileTime; the line the other writer changed,
			// which pi did show, stays refused: nothing vouches for it.
			const own = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(own.blocked).toBe(false);
			await applyEdit(runtime, file, own);
			const edit = await positionalEdit(runtime, file, [[1500, 1500, "a1500"]]);
			expect(edit.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("does not relocate an edit onto lines pi cut from a decorated raced read", async () => {
		const env = setupTestEnvironment("rg-3524-cut-relocate-");
		try {
			const line = (i: number, tag = "v") =>
				`const ${tag}${i} = "${"x".repeat(1500)}";`;
			const base = Array.from({ length: 50 }, (_, i) => line(i + 1));
			const file = fixture(env.tmpDir, "r.ts", `${base.join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			// The agent's view of lines 20-50, including v45-v46.
			await piRead(runtime, file, { offset: 20, limit: 31 });
			// Another writer changes 45-46; the agent never re-reads them.
			const changed = [...base];
			changed[44] = line(45, "Y");
			changed[45] = line(46, "Y");
			writeNow(file, `${changed.join("\n")}\n`);
			// pi cuts this read at its byte limit, well before line 45.
			const shown = await piRead(
				runtime,
				file,
				{ offset: 1, limit: 50 },
				{
					rewrite: (text) => `[other-extension: header note]\n${text}`,
					gate: () => {
						const moved = [...changed];
						moved.splice(40, 0, line(901, "ins"), line(902, "ins"));
						writeNow(file, `${moved.join("\n")}\n`);
					},
				},
			);
			expect(shown).toMatch(/\(50\.0KB limit\)/);
			// A later read of other lines re-stamps FileTime (an own edit no
			// longer does over the racer's bytes, #3525), so the edit below
			// reaches the snapshot gate.
			await piRead(runtime, file, { offset: 1, limit: 2 });
			// Y45-46 moved to 47-48; the agent never saw Y.
			const edit = await positionalEdit(runtime, file, [
				[45, 46, "agentX45\nagentX46"],
			]);
			expect(edit.blocked).toBe(true);
			expect(edit.ranges).toEqual([[45, 46]]);
			expect(edit.reason).toContain("Edit range changed since read");
		} finally {
			env.cleanup();
		}
	});

	it("does not cover lines past the file end of a decorated limited raced read", async () => {
		const env = setupTestEnvironment("rg-3524-limit-past-lines-");
		try {
			const file = fixture(env.tmpDir, "f.ts", lines(8).join("\n"));
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{ offset: 1, limit: 50 },
				{
					rewrite: (text) => `${text}\n[other-extension: footer]`,
					gate: () =>
						writeNow(
							file,
							[
								...lines(8),
								...Array.from({ length: 12 }, (_, i) => `APPENDED${i + 9}`),
							].join("\n"),
						),
				},
			);
			// As above: a read of other lines re-stamps FileTime (#3525).
			await piRead(runtime, file, { offset: 1, limit: 2 });
			// pi showed 8 lines; line 16 was never delivered.
			const edit = await positionalEdit(runtime, file, [[16, 16, "agent16"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("Edit outside read range");
		} finally {
			env.cleanup();
		}
	});

	for (const limit of [100, 12, 13]) {
		it(`refuses the shifted line of a decorated raced read with limit ${limit} on a 12-line file`, async () => {
			const env = setupTestEnvironment("rg-3524-limit-past-end-");
			try {
				const file = fixture(env.tmpDir, "y.ts", `${lines(12).join("\n")}\n`);
				const runtime = newRuntime(env.tmpDir);
				await piRead(
					runtime,
					file,
					{ offset: 1, limit },
					{
						rewrite: (text) => `[other-extension: header note]\n${text}`,
						gate: () => writeNow(file, `INSERTED\n${lines(12).join("\n")}\n`),
					},
				);
				// The agent saw "line5" at line 5; the disk now holds "line4".
				const edit = await positionalEdit(runtime, file, [[5, 5, "agent5"]]);
				expect(edit.blocked).toBe(true);
			} finally {
				env.cleanup();
			}
		});
	}

	it("refuses, until a re-read, a line a whole-file raced read showed when the write landed before pi's read", async () => {
		const env = setupTestEnvironment("rg-3524-countless-before-read-");
		try {
			const file = fixture(env.tmpDir, "z.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			const delivered = await piRead(
				runtime,
				file,
				{},
				{
					beforeExec: () => {
						const v = lines(6);
						v[2] = "EXTERNAL3";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			// The accepted cost: with no count from pi, only the tool_call's
			// capture vouches, and it predates the write the agent was shown.
			expect(delivered.split("\n")[2]).toBe("EXTERNAL3");
			const edit = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(edit.blocked).toBe(true);
			await piRead(runtime, file, {});
			const reread = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(reread.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("records a raced read from its delivered text, not the tool_call's capture, when the write landed before pi's read", async () => {
		const env = setupTestEnvironment("rg-3524-before-read-");
		try {
			const file = fixture(env.tmpDir, "w.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			const delivered = await piRead(
				runtime,
				file,
				{ offset: 1, limit: 6 },
				{
					beforeExec: () => {
						const v = lines(6);
						v[2] = "EXTERNAL3";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			// The agent was shown the other writer's line.
			expect(delivered.split("\n")[2]).toBe("EXTERNAL3");
			const edit = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("leaves FileTime at the tool_call stamp after a raced read, so a newer context-only read cannot cancel the mismatch", async () => {
		const env = setupTestEnvironment("rg-3524-no-restamp-");
		try {
			const file = fixture(env.tmpDir, "e.ts", `${lines(12).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 4 });
			await piRead(
				runtime,
				file,
				{ offset: 5, limit: 4 },
				{
					gate: () => {
						const v = lines(12);
						v[3] = "EXTERNAL4";
						writeNow(file, `${v.join("\n")}\n`);
					},
				},
			);
			const edit = await positionalEdit(runtime, file, [[4, 4, "agent4"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("stamps a read whose tool_call pi-lens never saw, as before", async () => {
		const env = setupTestEnvironment("rg-3524-no-call-");
		try {
			const file = fixture(env.tmpDir, "n.ts", `${lines(12).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{ offset: 1, limit: 4 },
				{ skipToolCall: true },
			);
			// Line 6 is inside the read's context slack (contextLines 3).
			const edit = await positionalEdit(runtime, file, [[6, 6, "agent6"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("sizes a raced read from the delivered text, not from lines another writer appended", async () => {
		const env = setupTestEnvironment("rg-3524-appended-");
		try {
			const file = fixture(env.tmpDir, "p.ts", lines(10).join("\n"));
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{},
				{
					gate: () => writeNow(file, lines(15).join("\n")),
				},
			);
			// A later read elsewhere stamps FileTime without covering line 15.
			await piRead(runtime, file, { offset: 1, limit: 2 });
			const edit = await positionalEdit(runtime, file, [[15, 15, "agent15"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("Edit outside read range");
		} finally {
			env.cleanup();
		}
	});

	it("credits every delivered line when another writer shortened the file during the read", async () => {
		const env = setupTestEnvironment("rg-3524-shortened-");
		try {
			const file = fixture(env.tmpDir, "s.ts", lines(6).join("\n"));
			const runtime = newRuntime(env.tmpDir);
			await piRead(
				runtime,
				file,
				{ offset: 1, limit: 6 },
				{
					gate: () =>
						writeNow(
							file,
							lines(6)
								.filter((_, i) => i !== 1)
								.join("\n"),
						),
				},
			);
			// Another writer inserts a line on top: line 6 holds "line6" again,
			// exactly what the agent was shown there.
			writeNow(file, ["INSERTED", ...diskLines(file)].join("\n"));
			expect(diskLines(file)[5]).toBe("line6");
			const edit = await positionalEdit(runtime, file, [[6, 6, "agent6"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not credit pi's continuation notice as delivered lines", async () => {
		const env = setupTestEnvironment("rg-3524-notice-");
		try {
			const file = fixture(env.tmpDir, "q.ts", lines(20).join("\n"));
			const runtime = newRuntime(env.tmpDir);
			const delivered = await piRead(
				runtime,
				file,
				{ offset: 1, limit: 5 },
				{
					gate: () => {
						const v = lines(20);
						v[14] = "EXTERNAL15";
						writeNow(file, v.join("\n"));
					},
				},
			);
			expect(delivered).toContain(
				"[15 more lines in file. Use offset=6 to continue.]",
			);
			await piRead(runtime, file, { offset: 1, limit: 2 });
			// Delivered 1-5 (+3 context) does not reach line 10.
			const edit = await positionalEdit(runtime, file, [[10, 10, "agent10"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("Edit outside read range");
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #3522: an edit line is judged by the newest read that DELIVERED it, never by
 * a read that only context-covers it, and never by "some read covers the whole
 * range". Recurrence: `validateRangeSnapshot` let a newer context-only read
 * cancel a real mismatch (ContextSuppress) and let a two-line edit spanning two
 * reads skip the hash check (SpanAcrossReads); the FileTime hash rescue and
 * relocation asked the same wrong question. Each case replays a
 * `formal/read-guard` trace through the real handlers; contextLines is the
 * default 3.
 */
describe("#3522: a stale line is judged by the newest read that delivered it", () => {
	/** Another writer replaces line `n` (1-based) with `text`. */
	const foreignWrite = (file: string, n: number, text: string) => {
		const v = diskLines(file);
		v[n - 1] = text;
		writeNow(file, v.join("\n"));
	};
	const RANGE_STALE = "Edit range changed since read";
	// Reads land in the same millisecond on a fast box, and the pre-fix guard
	// broke that tie by timestamp (`lastUnavailableTimestamp <= lastMismatch
	// Timestamp`), so the same replay flipped between allow and block. A fake
	// Date that moves between reads makes the pre-fix red deterministic; the
	// fix does not look at timestamps.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	const read = (
		runtime: RuntimeCoordinator,
		file: string,
		input: { offset?: number; limit?: number },
	) => {
		vi.advanceTimersByTime(10);
		return piRead(runtime, file, input);
	};
	const setup = (name: string) => {
		const env = setupTestEnvironment(`rg-3522-${name}-`);
		const file = fixture(env.tmpDir, "s.ts", `${lines(12).join("\n")}\n`);
		return { env, file, runtime: newRuntime(env.tmpDir) };
	};

	it("does not let a newer context-only read cancel a stale line (ContextSuppress)", async () => {
		const { env, file, runtime } = setup("ctx-suppress");
		try {
			await read(runtime, file, { offset: 1, limit: 4 });
			foreignWrite(file, 4, "EXTERNAL4");
			// Delivers 5-8; line 4 is only in its context zone.
			await read(runtime, file, { offset: 5, limit: 4 });
			const edit = await positionalEdit(runtime, file, [[4, 4, "agent4"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain(RANGE_STALE);
		} finally {
			env.cleanup();
		}
	});

	it("hash-checks an edit that spans two reads (SpanAcrossReads)", async () => {
		const { env, file, runtime } = setup("span");
		try {
			await read(runtime, file, { offset: 1, limit: 4 });
			foreignWrite(file, 4, "EXTERNAL4");
			await read(runtime, file, { offset: 5, limit: 4 });
			const edit = await positionalEdit(runtime, file, [
				[4, 5, "agent4\nagent5"],
			]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain(RANGE_STALE);
			expect(edit.ranges).toEqual([[4, 5]]);
			expect(diskLines(file)[3]).toBe("EXTERNAL4");
		} finally {
			env.cleanup();
		}
	});

	it("blocks a spanning edit when the SECOND read's line went stale", async () => {
		const { env, file, runtime } = setup("span-second");
		try {
			await read(runtime, file, { offset: 1, limit: 4 });
			await read(runtime, file, { offset: 5, limit: 4 });
			foreignWrite(file, 5, "EXTERNAL5");
			// Re-stamps FileTime; delivers 8-11, so line 5 is only in its context zone.
			await read(runtime, file, { offset: 8, limit: 4 });
			const edit = await positionalEdit(runtime, file, [
				[4, 5, "agent4\nagent5"],
			]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain(RANGE_STALE);
		} finally {
			env.cleanup();
		}
	});

	it("blocks a spanning edit when both lines went stale, and does not relocate it", async () => {
		const { env, file, runtime } = setup("span-both");
		try {
			await read(runtime, file, { offset: 1, limit: 4 });
			await read(runtime, file, { offset: 5, limit: 4 });
			foreignWrite(file, 4, "EXTERNAL4");
			foreignWrite(file, 5, "EXTERNAL5");
			await read(runtime, file, { offset: 8, limit: 4 });
			const edit = await positionalEdit(runtime, file, [
				[4, 5, "agent4\nagent5"],
			]);
			expect(edit.blocked).toBe(true);
			expect(edit.ranges).toEqual([[4, 5]]);
			expect(edit.reason).not.toContain("Re-target");
		} finally {
			env.cleanup();
		}
	});

	it("allows a spanning edit when each line still matches the read that delivered it", async () => {
		const { env, file, runtime } = setup("span-fresh");
		try {
			await read(runtime, file, { offset: 1, limit: 4 });
			await read(runtime, file, { offset: 5, limit: 4 });
			const edit = await positionalEdit(runtime, file, [
				[4, 5, "agent4\nagent5"],
			]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("allows the line a newer read re-delivered after the other writer (no false block)", async () => {
		const { env, file, runtime } = setup("reread");
		try {
			await read(runtime, file, { offset: 1, limit: 4 });
			foreignWrite(file, 4, "EXTERNAL4");
			await read(runtime, file, { offset: 4, limit: 1 });
			const edit = await positionalEdit(runtime, file, [[4, 4, "agent4"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("allows a two-line edit whose lines each match their own newest read, though an older read is stale on one", async () => {
		const { env, file, runtime } = setup("mixed");
		try {
			await read(runtime, file, { offset: 1, limit: 8 });
			foreignWrite(file, 4, "EXTERNAL4");
			// Delivers only line 4; line 5 stays the first read's view.
			await read(runtime, file, { offset: 4, limit: 1 });
			const edit = await positionalEdit(runtime, file, [
				[4, 5, "agent4\nagent5"],
			]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not let an older read that matches the disk vouch for a line a newer read saw differently", async () => {
		const { env, file, runtime } = setup("revert");
		try {
			await read(runtime, file, { offset: 1, limit: 4 });
			foreignWrite(file, 4, "EXTERNAL4");
			await read(runtime, file, { offset: 4, limit: 1 });
			// The writer puts line 4 back: the disk equals the OLD read again,
			// but the agent's latest view of line 4 is EXTERNAL4.
			foreignWrite(file, 4, "line4");
			const edit = await positionalEdit(runtime, file, [[4, 4, "agent4"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("rescues a touched file whose delivered lines still match", async () => {
		const { env, file, runtime } = setup("rescue");
		try {
			await read(runtime, file, { offset: 1, limit: 4 });
			// Same bytes, new mtime: FileTime moves, the hashes do not.
			writeNow(file, fs.readFileSync(file, "utf8"));
			const edit = await positionalEdit(runtime, file, [[4, 4, "agent4"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not rescue a touched file for a line no read delivered", async () => {
		const { env, file, runtime } = setup("rescue-ctx");
		try {
			await read(runtime, file, { offset: 1, limit: 4 });
			writeNow(file, fs.readFileSync(file, "utf8"));
			// Line 6 is inside the read's context zone but was never delivered.
			const edit = await positionalEdit(runtime, file, [[6, 6, "agent6"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("still admits the context zone for a line no read delivered (ContextSlack)", async () => {
		const { env, file, runtime } = setup("slack");
		try {
			await read(runtime, file, { offset: 5, limit: 4 });
			const edit = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not relocate a spanning edit from a read that is not the newest view of every line (SpanSnapshotFixAnyReloc)", async () => {
		const { env, file, runtime } = setup("any-reloc");
		try {
			await read(runtime, file, { offset: 1, limit: 2 });
			// Another writer inserts a line on top: line1,line2 now sit at 2-3.
			writeNow(file, ["EXTERNAL0", ...diskLines(file)].join("\n"));
			// The agent's newest view of line 1 is EXTERNAL0.
			await read(runtime, file, { offset: 1, limit: 1 });
			// It believes lines 1-2 are EXTERNAL0/line2. The older read's run
			// (line1, line2) is unique at 2-3, but relocating there would
			// overwrite line1, which the agent's newest view contradicts.
			const edit = await positionalEdit(runtime, file, [
				[1, 2, "agent1\nagent2"],
			]);
			expect(edit.blocked).toBe(true);
			expect(edit.ranges).toEqual([[1, 2]]);
			expect(edit.reason).toContain(RANGE_STALE);
			expect(edit.reason).not.toContain("Re-target");
			expect(diskLines(file).slice(0, 3)).toEqual([
				"EXTERNAL0",
				"line1",
				"line2",
			]);
		} finally {
			env.cleanup();
		}
	});

	it("does not relocate or allow an edit onto the line past the attachment's end (AutofixPastEnd)", async () => {
		const env = setupTestEnvironment("rg-3522-past-end-");
		try {
			biomeProject(env.tmpDir);
			const file = fixture(env.tmpDir, "b.ts", "old\n");
			const runtime = newRuntime(env.tmpDir);
			// The write's creation read covers 5 lines; the autofix drops line 1,
			// so the attachment (the agent's newest view) has 4.
			await writeWithAutofix(runtime, file, WRITTEN);
			expect(diskLines(file)).toHaveLength(4);
			// Line 5 exists only in the older creation read.
			const edit = await positionalEdit(runtime, file, [
				[4, 5, "agent4\nagent5"],
			]);
			expect(edit.blocked).toBe(true);
			expect(edit.ranges).toEqual([[4, 5]]);
			expect(diskLines(file)).toEqual([
				"const a = 1;",
				"const b = 2;",
				"const c = 3;",
				"const d = 4;",
			]);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * The pin of `WholeVouchesPastEnd = FALSE` (formal/switch-pins.json): a
	 * whole-file read vouches for the lines it delivered, never that no line
	 * follows its end. So an older read still speaks for a line past a newer
	 * whole-file read's end, and an edit of it passes while it holds the
	 * bytes that read showed. Recurrence (#4387, #4393): a guard change that
	 * let a whole-file view vouch past its end would leave the switch at
	 * FALSE, and TLC would keep proving the old design.
	 */
	it("lets an older read speak for a line past a newer whole-file read's end (WholeVouchesPastEnd)", async () => {
		const env = setupTestEnvironment("rg-3522-past-whole-end-");
		try {
			// No trailing newline: pi delivers it as one more, empty, line.
			const file = fixture(env.tmpDir, "s.ts", lines(12).join("\n"));
			const runtime = newRuntime(env.tmpDir);
			await read(runtime, file, {});
			writeNow(file, lines(11).join("\n"));
			// The agent's newest whole-file view ends at line 11.
			await read(runtime, file, {});
			writeNow(file, lines(12).join("\n"));
			const edit = await positionalEdit(runtime, file, [[12, 12, "agent12"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not relocate from the read that delivered the first line when a newer read delivered the last (SpanSnapshotFixAnyReloc)", async () => {
		const { env, file, runtime } = setup("any-reloc-last");
		try {
			await read(runtime, file, { offset: 1, limit: 6 });
			writeNow(file, ["INS1", "INS2", ...diskLines(file)].join("\n"));
			// The agent's newest view of line 4 is now the shifted "line2".
			await read(runtime, file, { offset: 4, limit: 1 });
			// The first read's run (line3, line4) is unique at 5-6, but its line4
			// is not what the agent last saw at line 4.
			const edit = await positionalEdit(runtime, file, [
				[3, 4, "agent3\nagent4"],
			]);
			expect(edit.blocked).toBe(true);
			expect(edit.ranges).toEqual([[3, 4]]);
			expect(edit.reason).toContain(RANGE_STALE);
			expect(edit.reason).not.toContain("Re-target");
		} finally {
			env.cleanup();
		}
	});

	it("relocates a shifted two-line edit from the read that is the newest view of both lines", async () => {
		const { env, file, runtime } = setup("reloc");
		try {
			await read(runtime, file, { offset: 1, limit: 6 });
			writeNow(file, ["INS1", "INS2", ...diskLines(file)].join("\n"));
			await read(runtime, file, { offset: 9, limit: 2 });
			// The agent means line3-line4, now at 5-6.
			const edit = await positionalEdit(runtime, file, [
				[3, 4, "agent3\nagent4"],
			]);
			expect(edit.blocked).toBe(false);
			expect(edit.ranges).toEqual([[5, 6]]);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #3525: FileTime is the only staleness check for a line whose newest view
 * carries no hash (a record past READ_HASH_MAX_LINES), so it may move only
 * over bytes the conversation accounts for: the agent's own call. Recurrence:
 * the 120 s own-edit rescue skipped it for any writer, an own edit that
 * passed a stale FileTime re-stamped it over the other writer's bytes (#3519
 * r4, R4), and the deferred agent_end format re-stamped it over bytes the
 * agent never saw. Each case replays a `formal/read-guard` trace, or R4,
 * through the real handlers.
 */
describe("#3525: FileTime moves only over bytes the conversation accounts for", () => {
	/** Past READ_HASH_MAX_LINES (3000): the write's creation read has no hashes. */
	const BIG = `${lines(3100).join("\n")}\n`;
	const foreignWrite = (file: string, n: number, text: string) => {
		const v = diskLines(file);
		v[n - 1] = text;
		writeNow(file, v.join("\n"));
	};

	/**
	 * The deferred agent_end format through the real `FormatService`, built
	 * the way `index.ts` builds it for the drain (the guard's session id).
	 * Only the formatter child is doubled; `format` returning its input is a
	 * formatter that changed nothing.
	 */
	const drainFormat = async (
		runtime: RuntimeCoordinator,
		file: string,
		format: (text: string) => string,
	) => {
		vi.mocked(getFormattersForFile).mockResolvedValueOnce([
			{ name: "biome" } as FormatterInfo,
		]);
		let ran = false;
		vi.mocked(runFormatter).mockImplementationOnce(async (fp: string) => {
			ran = true;
			const before = fs.readFileSync(fp, "utf8");
			const after = format(before);
			if (after !== before) writeNow(fp, after);
			return {
				success: true,
				changed: after !== before,
				outcome: after !== before ? "formatted" : "unchanged",
			};
		});
		runtime.deferFormat(file, runtime.projectRoot, "edit", runtime.projectRoot);
		await handleAgentEnd({
			ctxCwd: runtime.projectRoot,
			getFlag: noLspOrComplexity,
			notify: () => {},
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			getFormatService: () =>
				getFormatService(runtime.telemetrySessionId, true),
		});
		// G1': the service's own "modified externally" check let it run.
		expect(ran).toBe(true);
	};

	/**
	 * #4131 (maintainer decision F5 on #4187): authorship follows content
	 * identity. A recognized bash write credits authorship without a read
	 * and without the bytes it wrote; it holds while the disk holds the bytes
	 * the conversation last wrote, and ends when another writer changes them.
	 * `stat` only pre-filters, so a metadata-only change keeps it (the #3520
	 * no-drop direction). Recurrences: the zero-read arm injected a creation
	 * read over the other writer's bytes (#4131, R1); round 1 of #4187 ended
	 * authorship on any stat change (R2); an own bash write or the agent_end
	 * drain re-baselined it over the other writer's bytes (F6, R3, R4).
	 */
	const bashSed = async (
		runtime: RuntimeCoordinator,
		file: string,
		from: string,
		to: string,
	) => {
		const toolCallId = `bash-${++seq}`;
		const input = { command: `sed -i 's/^${from}$/${to}/' ${file}` };
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(
				callDeps(runtime, { toolName: "bash", toolCallId, input }),
			),
		);
		writeNow(
			file,
			fs.readFileSync(file, "utf8").replace(`${from}\n`, `${to}\n`),
		);
		await handleToolResult(
			resultDeps(runtime, {
				toolName: "bash",
				toolCallId,
				input,
				content: [{ type: "text", text: "" }],
			}),
		);
	};
	const AUTHORSHIP_RETIRED = "File modified since your write";

	it("ends bash authorship when another writer changes the bytes (#4131 R1)", async () => {
		const env = setupTestEnvironment("rg-4131-r1-");
		try {
			const file = fixture(env.tmpDir, "big.ts", BIG);
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "line3", "agent3");
			foreignWrite(file, 11, "EXTERNAL11");
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain(AUTHORSHIP_RETIRED);
			// The retirement holds: the next edit still needs a read.
			const again = await positionalEdit(runtime, file, [[3, 3, "agent3b"]]);
			expect(again.blocked).toBe(true);
			expect(again.reason).toContain(AUTHORSHIP_RETIRED);
		} finally {
			env.cleanup();
		}
	});

	it("unions a native edit's own line with distinct existing authorship (#4210 R3-2)", async () => {
		const env = setupTestEnvironment("rg-4210-native-own-range-");
		try {
			const file = fixture(
				env.tmpDir,
				"native.ts",
				`${lines(12).join("\n")}\n`,
			);
			const runtime = newRuntime(env.tmpDir);
			runtime.readGuard.recordWritten(file, {
				stampFileTime: false,
				authorship: "partial",
				authoredRanges: [[8, 8]],
				allowFirstAuthorship: true,
			});
			await piRead(runtime, file, { offset: 10, limit: 1 });
			const edit = await positionalEdit(runtime, file, [[10, 10, "native10"]]);
			await applyEdit(runtime, file, edit);
			const guard = runtime.readGuard;
			if (!guard) throw new Error("read guard unavailable");
			const entry = guard
				.exportAuthorship()
				.entries?.find((candidate) => candidate.filePath === file);
			expect(entry?.authoredRanges).toEqual([
				[8, 8],
				[10, 10],
			]);
			const resumed = newRuntime(env.tmpDir);
			resumed.readGuard.importAuthorship(
				guard.exportAuthorship(),
				new Set(entry?.toolCallId ? [entry.toolCallId] : []),
			);
			expect(resumed.readGuard.checkEdit(file, [10, 10]).action).toBe("allow");
			expect(resumed.readGuard.checkEdit(file, [9, 9]).action).toBe("block");
			expect(resumed.readGuard.checkEdit(file, [8, 8]).action).toBe("allow");
		} finally {
			env.cleanup();
		}
	});

	it("keeps bash authorship over a metadata-only change and an identical rewrite (#4131 R2, #3520 no-drop)", async () => {
		const env = setupTestEnvironment("rg-4131-r2-");
		try {
			const file = fixture(env.tmpDir, "big.ts", BIG);
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "line3", "agent3");
			// touch: a new mtime, the same bytes.
			const later = (nextMtimeMs += 10_000) / 1000;
			fs.utimesSync(file, later, later);
			expect(
				(await positionalEdit(runtime, file, [[11, 11, "agent11"]])).blocked,
			).toBe(false);
			// A checkout of identical bytes: rewritten, new stat, same content.
			const other = fixture(env.tmpDir, "other.ts", BIG);
			await bashSed(runtime, other, "line5", "agent5");
			writeNow(other, fs.readFileSync(other, "utf8"));
			const edit = await positionalEdit(runtime, other, [[12, 12, "agent12"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not let an own bash write re-author bytes another writer changed (#4131 F6 P2)", async () => {
		const env = setupTestEnvironment("rg-4131-r3-");
		try {
			const file = fixture(env.tmpDir, "big.ts", BIG);
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "line3", "agent3");
			foreignWrite(file, 11, "EXTERNAL11");
			await bashSed(runtime, file, "line4", "agent4");
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain(AUTHORSHIP_RETIRED);
		} finally {
			env.cleanup();
		}
	});

	it("lets an own bash write advance its own authorship when no other writer intervened (F6 no-drop)", async () => {
		const env = setupTestEnvironment("rg-4131-r3-nodrop-");
		try {
			const file = fixture(env.tmpDir, "big.ts", BIG);
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "line3", "agent3");
			await bashSed(runtime, file, "line4", "agent4");
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not let the agent_end format re-author bytes another writer changed (#4131 F6 P3)", async () => {
		const env = setupTestEnvironment("rg-4131-r4-");
		try {
			const file = fixture(env.tmpDir, "big.ts", BIG);
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "line3", "agent3");
			foreignWrite(file, 11, "EXTERNAL11");
			await drainFormat(runtime, file, (text) =>
				text.replace("line2\n", "line2 \n"),
			);
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain(AUTHORSHIP_RETIRED);
		} finally {
			env.cleanup();
		}
	});

	it("carries bash authorship through the agent_end format when no other writer intervened (F6 no-drop)", async () => {
		const env = setupTestEnvironment("rg-4131-r4-nodrop-");
		try {
			const file = fixture(env.tmpDir, "big.ts", BIG);
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "line3", "agent3");
			await drainFormat(runtime, file, (text) =>
				text.replace("line2\n", "line2 \n"),
			);
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #4387 sibling (BashAuthoredPre4387 in formal/read-guard): the zero-read
	 * allow over a whole-file authorship injects a whole-file read, so the own
	 * positional edit's one-line read does not shadow the authorship. #4235
	 * (55fa5210c) dropped the injection for every authorship to keep a range
	 * scope narrow; an edit of another line after the first own edit was then
	 * refused with no other writer (#3520's no-drop direction).
	 */
	it("keeps a bash write's whole-file authorship vouching after its own positional edit (#4387)", async () => {
		const env = setupTestEnvironment("rg-4387-own-positional-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", "alpha\nbeta\ngamma\n");
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "beta", "BETA");
			const first = await positionalEdit(runtime, file, [[1, 1, "ALPHA"]]);
			expect(first.blocked).toBe(false);
			await applyEdit(runtime, file, first);
			const other = await positionalEdit(runtime, file, [[3, 3, "GAMMA"]]);
			expect(other.reason).toBeUndefined();
			expect(other.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #4387: the conversation's own oldText edit of a file it authored whole
	 * lands its own bytes; only which lines they occupy is unknown, and a
	 * whole-file authorship needs no range (the #4210 N3 rule for a partial
	 * credit). Recurrence: the edit's UNKNOWN-range credit force-retired that
	 * authorship, logged as a "bridge" writer. A native write also leaves a
	 * whole-file read, so there the retirement shows only in pilens_health
	 * and read-guard.log; after a bash write, which leaves none, the next
	 * edit read "File modified since your write" with no other writer.
	 */
	const authorshipRetiredFor = (file: string) =>
		getDegradationSummary()
			.find((group) => group.kind === "read-guard-authorship-retired")
			?.latestReasons.some(
				(row) => path.basename(row.subject) === path.basename(file),
			) ?? false;

	it("does not retire a write's authorship at its own oldText edit (#4387)", async () => {
		const env = setupTestEnvironment("rg-4387-own-write-");
		resetDegradationLedger();
		try {
			// The issue's reproduction: a pre-existing file, a native write, then
			// a native oldText edit, with no other writer.
			const file = fixture(env.tmpDir, "probe.ts", "alpha\nbeta\ngamma\n");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, "alpha\nbeta\ngamma\ndelta\n");
			expect((await textEdit(runtime, file, "beta\n", "BETA\n")).blocked).toBe(
				false,
			);
			expect(authorshipRetiredFor(file)).toBe(false);
			expect(
				runtime.readGuard
					.exportAuthorship()
					.entries?.find((entry) => entry.filePath === file)?.retired,
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	/**
	 * `/tree` to the current leaf, or a resume of it: every tool call so far
	 * is on the branch (`index.ts` passes `retainBranch` the branch's tool
	 * call ids; `importBranch` and `importAuthorship` keep the same set).
	 */
	const moveToLeaf = (runtime: RuntimeCoordinator) => {
		const ids = new Set<string>();
		for (const prefix of ["read-", "edit-", "write-", "text-edit-", "bash-"])
			for (let n = 0; n <= seq; n += 1) ids.add(`${prefix}${n}`);
		runtime.readGuard.retainBranch(ids);
	};

	it("allows the next edit after a bash write and its own oldText edits, also after a branch move (#4387)", async () => {
		const env = setupTestEnvironment("rg-4387-own-bash-");
		resetDegradationLedger();
		try {
			const file = fixture(env.tmpDir, "probe.ts", "alpha\nbeta\ngamma\n");
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "beta", "BETA");
			expect(
				(await textEdit(runtime, file, "gamma\n", "GAMMA\n")).blocked,
			).toBe(false);
			const second = await textEdit(runtime, file, "alpha\n", "ALPHA\n");
			expect(second.reason).toBeUndefined();
			expect(second.blocked).toBe(false);
			moveToLeaf(runtime);
			const positional = await positionalEdit(runtime, file, [[2, 2, "BETA2"]]);
			expect(positional.reason).toBeUndefined();
			expect(positional.blocked).toBe(false);
			expect(authorshipRetiredFor(file)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// #4387 keeps #4210's fail-closed direction: the own oldText edit advances
	// the authorship to its own bytes, so a later foreign change is refused,
	// before a move and after one.
	it("still refuses the line another writer changed after the own oldText edit, also after a move (#4387)", async () => {
		const env = setupTestEnvironment("rg-4387-own-bash-foreign-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", "alpha\nbeta\ngamma\n");
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "beta", "BETA");
			expect(
				(await textEdit(runtime, file, "gamma\n", "GAMMA\n")).blocked,
			).toBe(false);
			foreignWrite(file, 1, "EXTERNAL1");
			expect((await positionalEdit(runtime, file, [[1, 1, "A"]])).blocked).toBe(
				true,
			);
			moveToLeaf(runtime);
			expect((await positionalEdit(runtime, file, [[1, 1, "A"]])).blocked).toBe(
				true,
			);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #4387 review r1 F1 (S3, AuthorOwnOldTextForeign in formal/read-guard): an
	 * own oldText edit that passes on the read path advances the authorship
	 * over bytes its preflight never checked, here another writer's line 5.
	 * The read that bounds it is the one the first own edit recorded from the
	 * authorship. Recurrence: that read named no tool call, so a move dropped
	 * it and kept the authorship, and the edit of the line the agent never saw
	 * passed.
	 */
	it("keeps another writer's line refused after own oldText edits and a move (#4387 S3)", async () => {
		const env = setupTestEnvironment("rg-4387-s3-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "line3", "agent3");
			expect(
				(await textEdit(runtime, file, "line1\n", "AGENT1\n")).blocked,
			).toBe(false);
			foreignWrite(file, 5, "EXTERNAL5");
			expect(
				(await textEdit(runtime, file, "line2\n", "AGENT2\n")).blocked,
			).toBe(false);
			moveToLeaf(runtime);
			const edit = await positionalEdit(runtime, file, [[5, 5, "agent5"]]);
			expect(edit.blocked).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #4387 review r1 F1 (S10, AuthorOwnOldTextInflight): another writer lands
	 * between the host's apply of an own oldText edit and pi-lens' tool_result,
	 * so the credit advances over its line. Recurrence: commit 1 alone let the
	 * next edit of that line pass with no move; with the id-less read, after one.
	 */
	it("keeps a line another writer changed during an own oldText edit refused, also after a move (#4387 S10)", async () => {
		const env = setupTestEnvironment("rg-4387-s10-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await bashSed(runtime, file, "line3", "agent3");
			expect(
				(await textEdit(runtime, file, "line1\n", "AGENT1\n")).blocked,
			).toBe(false);
			const inflight = await textEdit(
				runtime,
				file,
				"line2\n",
				"AGENT2\n",
				() => foreignWrite(file, 5, "EXTERNAL5"),
			);
			expect(inflight.blocked).toBe(false);
			expect(
				(await positionalEdit(runtime, file, [[5, 5, "agent5"]])).blocked,
			).toBe(true);
			moveToLeaf(runtime);
			expect(
				(await positionalEdit(runtime, file, [[5, 5, "agent5"]])).blocked,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * S12's setup: a bash write, a bridge read of lines 1-3 (no tool call id),
	 * then an own oldText edit of line 2 during which another writer changes
	 * line 5. The edit's credit leaves an empty scope.
	 */
	const bashThenBridgeEditInflight = async (
		runtime: RuntimeCoordinator,
		file: string,
	) => {
		wireReadBridge();
		_bridgeRuntime = runtime;
		await bashSed(runtime, file, "line3", "agent3");
		(globalThis as Record<symbol, ReadBridge>)[READ_BRIDGE_KEY].recordRead({
			filePath: file,
			requestedOffset: 1,
			requestedLimit: 3,
		});
		expect(runtime.readGuard.getReadHistory(file)).toHaveLength(1);
		const inflight = await textEdit(runtime, file, "line2\n", "AGENT2\n", () =>
			foreignWrite(file, 5, "EXTERNAL5"),
		);
		expect(inflight.blocked).toBe(false);
	};

	/**
	 * #4387 r2 (S12, AuthorOwnOldTextIdless): an authorship vouches only through
	 * a read a move keeps with it. A bridge read names no tool call, so with
	 * only that read the own oldText edit's tool_call records the authorship
	 * as a read itself. Recurrence: with the bridge read alone, the credit
	 * advanced over a line another writer landed during the edit, the move
	 * dropped the bridge read, and the authorship let that line be edited.
	 */
	it("keeps a line another writer changed during an own oldText edit refused when only a bridge read was there (#4387 S12)", async () => {
		const env = setupTestEnvironment("rg-4387-s12-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await bashThenBridgeEditInflight(runtime, file);
			moveToLeaf(runtime);
			expect(
				(await positionalEdit(runtime, file, [[5, 5, "agent5"]])).blocked,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #4387 review G3: the pipeline's own-path whole-file credit after a native
	 * edit runs only when the pipeline rewrote the bytes, as it already did
	 * for a positional edit. Recurrence: after an oldText edit of a file the
	 * conversation had only partly read, it made a whole-file authorship the
	 * edit's UNKNOWN credit refused, with no transcript id, which round 1 then
	 * let outlive the next oldText edit.
	 */
	it("makes no authorship from an oldText edit of a file the conversation only read (#4387 G3)", async () => {
		const env = setupTestEnvironment("rg-4387-g3-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(20).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 3 });
			const authorship = () =>
				runtime.readGuard
					.exportAuthorship()
					.entries?.find((entry) => entry.filePath === file);
			expect(
				(await textEdit(runtime, file, "line2\n", "AGENT2\n")).blocked,
			).toBe(false);
			expect(authorship()).toBeUndefined();
			expect(
				(await textEdit(runtime, file, "line3\n", "AGENT3\n")).blocked,
			).toBe(false);
			expect(authorship()).toBeUndefined();
			expect(
				(await positionalEdit(runtime, file, [[15, 15, "x"]])).blocked,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	/** A first credit of lines 3-5 from a writer no pre-write check guarded. */
	const bridgeScope = (runtime: RuntimeCoordinator, file: string) =>
		runtime.readGuard.recordWritten(file, {
			stampFileTime: false,
			advanceAuthorship: false,
			authorship: "partial",
			authoredRanges: [[3, 5]],
			allowFirstAuthorship: true,
			toolCallId: "bridge-scope",
		});

	/**
	 * #4387 review G2 (S8): an own oldText edit inside a range scope names no
	 * line it produced, so it leaves an empty scope: the next zero-read edit
	 * needs a read, and says so. Recurrence: the credit retired the scope, and
	 * the next edit read "File modified since your write" with no other writer.
	 */
	it("asks for a read, without blaming another writer, after an own oldText edit inside a range scope (#4387 S8)", async () => {
		const env = setupTestEnvironment("rg-4387-s8-");
		resetDegradationLedger();
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			foreignWrite(file, 4, "BRIDGE4");
			bridgeScope(runtime, file);
			expect(
				(await textEdit(runtime, file, "BRIDGE4\n", "AGENT4\n")).blocked,
			).toBe(false);
			const next = await positionalEdit(runtime, file, [[4, 4, "x"]]);
			expect(next.blocked).toBe(true);
			expect(next.reason).toContain("this write only covered part");
			expect(authorshipRetiredFor(file)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #4387 r2 (S13): the empty scope is what keeps G2 fail-closed. A range
	 * scope gets no read from the zero-read arm (#4210), so nothing but the
	 * scope bounds the authorship. Recurrence it guards: composing the old
	 * scope with an empty range kept lines 3-5 vouching after the credit
	 * advanced over a line another writer landed during the own edit.
	 */
	it("keeps a scope line another writer changed during an own oldText edit refused (#4387 S13)", async () => {
		const env = setupTestEnvironment("rg-4387-s13-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			foreignWrite(file, 4, "BRIDGE4");
			bridgeScope(runtime, file);
			const inflight = await textEdit(
				runtime,
				file,
				"BRIDGE4\n",
				"AGENT4\n",
				() => foreignWrite(file, 3, "EXTERNAL3"),
			);
			expect(inflight.blocked).toBe(false);
			expect(
				(await positionalEdit(runtime, file, [[3, 3, "agent3"]])).blocked,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #4387 r3: a scope widens only over bytes the conversation holds. A
	 * whole-file credit that holds none (the agent_end drain, a bash write, a
	 * pipeline rewrite) keeps the scope it meets. Recurrences: after S12's
	 * empty scope absorbed the in-flight line, the drain (S14) or an own bash
	 * write of another line (S16) widened it to the whole file, and the line
	 * passed after a move; after S13 the drain widened it with no move (S17);
	 * on base the drain widened a bridge's range scope over a line the agent
	 * never saw (S15b).
	 */
	it("keeps the in-flight line refused after a format drain and a move (#4387 S14)", async () => {
		const env = setupTestEnvironment("rg-4387-s14-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await bashThenBridgeEditInflight(runtime, file);
			await drainFormat(runtime, file, (text) =>
				text.replace("line10", "line10;"),
			);
			moveToLeaf(runtime);
			expect(
				(await positionalEdit(runtime, file, [[5, 5, "agent5"]])).blocked,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the in-flight line refused after an own bash write of another line and a move (#4387 S16)", async () => {
		const env = setupTestEnvironment("rg-4387-s16-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await bashThenBridgeEditInflight(runtime, file);
			await bashSed(runtime, file, "line9", "agent9");
			moveToLeaf(runtime);
			expect(
				(await positionalEdit(runtime, file, [[5, 5, "agent5"]])).blocked,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a scope line another writer changed during an own oldText edit refused after a format drain (#4387 S17)", async () => {
		const env = setupTestEnvironment("rg-4387-s17-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			foreignWrite(file, 4, "BRIDGE4");
			bridgeScope(runtime, file);
			const inflight = await textEdit(
				runtime,
				file,
				"BRIDGE4\n",
				"AGENT4\n",
				() => foreignWrite(file, 3, "EXTERNAL3"),
			);
			expect(inflight.blocked).toBe(false);
			await drainFormat(runtime, file, (text) =>
				text.replace("line10", "line10;"),
			);
			expect(
				(await positionalEdit(runtime, file, [[3, 3, "agent3"]])).blocked,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a range scope to its lines through a format drain (#4387 S15b)", async () => {
		const env = setupTestEnvironment("rg-4387-s15b-");
		try {
			const file = fixture(env.tmpDir, "probe.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			bridgeScope(runtime, file);
			await drainFormat(runtime, file, (text) =>
				text.replace("line10", "line10;"),
			);
			// Line 8 was never shown to the agent: the drain holds no bytes for it.
			const outside = await positionalEdit(runtime, file, [[8, 8, "x"]]);
			expect(outside.blocked).toBe(true);
			expect(outside.reason).toContain("this write only covered part");
			// The scope itself survives the same-length format (no-drop).
			expect(
				(await positionalEdit(runtime, file, [[4, 4, "agent4"]])).blocked,
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("keeps another writer's change stale after an oldText edit passed it (R4)", async () => {
		const env = setupTestEnvironment("rg-3525-r4-");
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			foreignWrite(file, 11, "EXTERNAL11");
			// The host resolves oldText in the live bytes, so FileTime is skipped.
			expect(
				(await textEdit(runtime, file, "line3\n", "agent3\n")).blocked,
			).toBe(false);
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("carries the stamp decision through the tool_result debounce (R4)", async () => {
		const env = setupTestEnvironment("rg-3525-r4-debounce-");
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			foreignWrite(file, 11, "EXTERNAL11");
			// The re-entry after the debounce finds the attribution taken.
			vi.stubEnv("PI_LENS_TOOL_RESULT_DEBOUNCE_MS", "5");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const toolCallId = `text-edit-${++seq}`;
			const input = {
				path: file,
				edits: [{ oldText: "line3\n", newText: "agent3\n" }],
			};
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					callDeps(runtime, { toolName: "edit", toolCallId, input }),
				),
			);
			writeNow(
				file,
				fs.readFileSync(file, "utf8").replace("line3\n", "agent3\n"),
			);
			const result = handleToolResult(
				resultDeps(runtime, {
					toolName: "edit",
					toolCallId,
					input,
					content: [{ type: "text", text: "ok" }],
				}),
			);
			await vi.advanceTimersByTimeAsync(5);
			await result;
			vi.useRealTimers();
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			vi.useRealTimers();
			vi.unstubAllEnvs();
			env.cleanup();
		}
	});

	it("keeps another writer's change stale after an own positional edit (UnhashedOwnEditRescue)", async () => {
		const env = setupTestEnvironment("rg-3525-rescue-");
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			const own = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(own.blocked).toBe(false);
			await applyEdit(runtime, file, own);
			// The own edit left no read record newer than its verdict (an
			// oldText edit records none), so the rescue would read the next
			// staleness as its own.
			expect(
				(await textEdit(runtime, file, "line5\n", "agent5\n")).blocked,
			).toBe(false);
			foreignWrite(file, 11, "EXTERNAL11");
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("keeps another writer's change stale after a positional edit its line hashes passed", async () => {
		const env = setupTestEnvironment("rg-3525-hash-passed-");
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			// Lines 1-10 get a hashed view; line 20 keeps only the unhashed one.
			await piRead(runtime, file, { offset: 1, limit: 10 });
			foreignWrite(file, 20, "EXTERNAL20");
			const own = await positionalEdit(runtime, file, [[3, 3, "agent3"]]);
			expect(own.blocked).toBe(false);
			await applyEdit(runtime, file, own);
			const edit = await positionalEdit(runtime, file, [[20, 20, "agent20"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("does not credit the deferred format's bytes to an unhashed read (UnhashedFormatStamp)", async () => {
		const env = setupTestEnvironment("rg-3525-format-stamp-");
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			// The formatter inserts a line on top: line 5 now holds "line4".
			await drainFormat(runtime, file, (text) => `// formatted\n${text}`);
			expect(diskLines(file)[4]).toBe("line4");
			const edit = await positionalEdit(runtime, file, [[5, 5, "agent5"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("lets the hash rescue absorb a whitespace-only deferred format", async () => {
		const env = setupTestEnvironment("rg-3525-format-ws-");
		try {
			const file = fixture(env.tmpDir, "f.ts", `${lines(8).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 8 });
			await drainFormat(runtime, file, (text) => text.replace(/\n/g, "  \n"));
			const edit = await positionalEdit(runtime, file, [[5, 5, "agent5"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// #3785 review r1 F1: the real service shared the guard's FileTime (same
	// session id) and stamped it before and after formatting, so the most
	// common drain, a formatter that changed nothing, vouched for the other
	// writer's line.
	it("does not credit another writer's change to a deferred format that changed nothing", async () => {
		const env = setupTestEnvironment("rg-3525-format-unchanged-");
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			foreignWrite(file, 11, "EXTERNAL11");
			await drainFormat(runtime, file, (text) => text);
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	/**
	 * An oldText batch whose second edit does not resolve (#2402's partial
	 * apply): tool_call rewrites it to the first edit (#5120), the host applies
	 * the executed input, and the edit's tool_result reports the partial apply.
	 */
	const partialApply = async (
		runtime: RuntimeCoordinator,
		file: string,
		oldText: string,
		newText: string,
	) => {
		const toolCallId = `partial-${++seq}`;
		const input: {
			path: string;
			edits: Array<{ oldText: string; newText: string }>;
		} = {
			path: file,
			edits: [
				{ oldText, newText },
				{ oldText: "NOPE\n", newText: "x\n" },
			],
		};
		const verdict = (await runHandlerExpectingNoThrow(() =>
			handleToolCall(
				callDeps(runtime, { toolName: "edit", toolCallId, input }),
			),
		)) as { block?: boolean; reason?: string } | undefined;
		expect(verdict).toBeUndefined();
		let text = fs.readFileSync(file, "utf8");
		for (const edit of input.edits)
			text = text.replace(edit.oldText, edit.newText);
		writeNow(file, text);
		const result = await handleToolResult(
			resultDeps(runtime, { toolName: "edit", toolCallId, input, content: [] }),
		);
		const reported = (result?.content ?? [])
			.map((part) => part.text)
			.join("\n");
		expect(reported).toContain("PARTIAL APPLY — 1 edit committed");
		expect(reported).not.toContain("Post-edit analysis failed");
	};

	// #3785 review r1 F2: the partial apply reached tool_result with no
	// tool-call id, so the fresh-at-check rule never saw it.
	it("keeps another writer's change stale after a partial apply passed it", async () => {
		const env = setupTestEnvironment("rg-3525-partial-");
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			foreignWrite(file, 11, "EXTERNAL11");
			await partialApply(runtime, file, "line3\n", "agent3\n");
			expect(diskLines(file)[2]).toBe("agent3");
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("re-stamps after a partial apply made at a fresh FileTime", async () => {
		const env = setupTestEnvironment("rg-3525-partial-fresh-");
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			await partialApply(runtime, file, "line3\n", "agent3\n");
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// #3785 review r1 F2: a recognized bash write is the agent's call, but its
	// bytes (sed's output, a redirect, a checkout) are not in the conversation.
	it("keeps another writer's change stale after a bash write", async () => {
		const env = setupTestEnvironment("rg-3525-bash-");
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			foreignWrite(file, 11, "EXTERNAL11");
			const toolCallId = `bash-${++seq}`;
			const input = { command: `sed -i 's/^line3$/agent3/' ${file}` };
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					callDeps(runtime, { toolName: "bash", toolCallId, input }),
				),
			);
			writeNow(
				file,
				fs.readFileSync(file, "utf8").replace("line3\n", "agent3\n"),
			);
			await handleToolResult(
				resultDeps(runtime, {
					toolName: "bash",
					toolCallId,
					input,
					content: [{ type: "text", text: "" }],
				}),
			);
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	// #3785 review r1 F2: the server computes a rename's edits; the agent sees
	// a summary, not the bytes.
	it("keeps another writer's change stale after an LSP rename", async () => {
		const env = setupTestEnvironment("rg-3525-lsp-rename-");
		setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
		try {
			const file = fixture(env.tmpDir, "big.ts", "");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, BIG);
			foreignWrite(file, 11, "EXTERNAL11");
			await installLspServiceDouble({
				supportsLSP: () => true,
				hasLSP: async () => true,
				rename: async () => ({
					changes: {
						[pathToFileURL(file).href]: [
							{
								range: {
									start: { line: 2, character: 0 },
									end: { line: 2, character: 4 },
								},
								newText: "renamed",
							},
						],
					},
				}),
			});
			const tool = createLspNavigationTool((flag) => flag === "lens-lsp", {
				runtime,
				cacheManager: new CacheManager(false),
				readGuard: runtime.readGuard,
			});
			await tool.execute(
				`rename-${++seq}`,
				{
					operation: "rename",
					path: file,
					line: 3,
					character: 1,
					newName: "renamed",
					apply: true,
				},
				new AbortController().signal,
				null,
				{ cwd: runtime.projectRoot },
			);
			expect(diskLines(file)[2]).toBe("renamed3");
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			setHostFileMutationQueueLoader(undefined);
			env.cleanup();
		}
	});

	it("re-stamps after an own edit made at a fresh FileTime, so a shifted edit still relocates", async () => {
		const env = setupTestEnvironment("rg-3525-fresh-stamp-");
		try {
			const file = fixture(env.tmpDir, "r.ts", `${lines(10).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			await piRead(runtime, file, { offset: 1, limit: 10 });
			const grow = await positionalEdit(runtime, file, [[2, 2, "a\nb"]]);
			await applyEdit(runtime, file, grow);
			// "line5"/"line6" moved to 6-7; only a fresh FileTime reaches the
			// content-verified relocation.
			const edit = await positionalEdit(runtime, file, [[5, 6, "x\ny"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.ranges).toEqual([[6, 7]]);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #3524 remainder: the creation read a `write` injects is the agent's view of
 * the bytes it wrote, so it is hashed from the executed `content`, not from
 * the disk at tool_result. Recurrence: `injectCreationRead` read the disk and
 * vouched for another writer's change between the host write and the handler.
 */
describe("#3524: the creation read is the written content", () => {
	it("does not credit a write that lands between the host write and its tool_result (CreationAtResult)", async () => {
		const env = setupTestEnvironment("rg-3524-creation-");
		try {
			// An overwrite: pi-lens' tool_call returns before noting a creation
			// for a path that does not exist yet (that write's first edit takes
			// the #3520 `session_authored` path).
			const file = fixture(env.tmpDir, "c.ts", "old\n");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, `${lines(6).join("\n")}\n`, () => {
				const v = diskLines(file);
				v[1] = "EXTERNAL2";
				writeNow(file, v.join("\n"));
			});
			const edit = await positionalEdit(runtime, file, [[2, 2, "agent2"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("Edit range changed since read");
		} finally {
			env.cleanup();
		}
	});

	it("allows an edit of a line the write put there", async () => {
		const env = setupTestEnvironment("rg-3524-creation-ok-");
		try {
			const file = fixture(env.tmpDir, "c.ts", "old\n");
			const runtime = newRuntime(env.tmpDir);
			await piWrite(runtime, file, `${lines(6).join("\n")}\n`);
			const edit = await positionalEdit(runtime, file, [[2, 2, "agent2"]]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #3962: the bridge's `contentBinding` is the only content-bound read anchor,
 * but the block's own remedy ("Re-read the file") produces a NATIVE record,
 * which carries read-time hashes and never a binding. This drives the real
 * cross-extension bridge and the real native `read` tool through
 * `handleToolCall` / `handleToolResult`: the stale binding is superseded only
 * by a newer covering read whose hashes still match disk.
 */
describe("#3962: a native re-read supersedes a stale bridge binding", () => {
	beforeAll(wireReadBridge);

	it("lets the real read tool clear a stale bridge binding for a positional edit", async () => {
		const env = setupTestEnvironment("rg-3962-native-");
		try {
			const file = fixture(
				env.tmpDir,
				"b.ts",
				"const a = 1;\nconst b = 2;\nconst c = 3;\n",
			);
			const runtime = newRuntime(env.tmpDir);
			_bridgeRuntime = runtime;
			// The producer's real recordRead: a non-zero read binds the bytes it saw.
			const bridge = (globalThis as Record<symbol, ReadBridge>)[
				READ_BRIDGE_KEY
			];
			bridge.recordRead({
				filePath: file,
				requestedOffset: 1,
				requestedLimit: 1,
			});
			expect(runtime.readGuard.checkEdit(file, [1, 1]).action).toBe("allow");
			// An external writer changes the bytes; the binding goes stale.
			writeNow(file, "const a = 99;\nconst b = 2;\nconst c = 3;\n");
			// The remedy the block asks for: the real native read of the new bytes.
			await piRead(runtime, file, { offset: 1, limit: 3 });
			const edit = await positionalEdit(runtime, file, [
				[1, 1, "const a = 100;"],
			]);
			expect(edit.reason).toBeUndefined();
			expect(edit.blocked).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// #3865 member 3 (#4187 F3, P4): a v1 bridge read reports a range, not
	// bytes the conversation holds whole, so it must not re-stamp the
	// whole-file FileTime. Recurrence: a bridge read of lines 1-10 re-stamped
	// it, and an edit of line 11, which another writer changed and whose
	// newest view carries no hash (a read past READ_HASH_MAX_LINES), passed.
	it("does not let a bridge read of other lines re-stamp FileTime over another writer's change (#3865)", async () => {
		const env = setupTestEnvironment("rg-3865-bridge-read-");
		try {
			const big = lines(3100);
			const file = fixture(env.tmpDir, "big.ts", `${big.join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			_bridgeRuntime = runtime;
			// The agent's whole-file read, past READ_HASH_MAX_LINES: no hashes.
			runtime.readGuard.recordRead({
				filePath: file,
				requestedOffset: 1,
				requestedLimit: 3101,
				effectiveOffset: 1,
				effectiveLimit: 3101,
				expandedByLsp: false,
				turnIndex: 0,
				writeIndex: 0,
				timestamp: Date.now(),
			});
			big[10] = "EXTERNAL11";
			writeNow(file, `${big.join("\n")}\n`);
			const bridge = (globalThis as Record<symbol, ReadBridge>)[
				READ_BRIDGE_KEY
			];
			bridge.recordRead({
				filePath: file,
				requestedOffset: 1,
				requestedLimit: 10,
			});
			const edit = await positionalEdit(runtime, file, [[11, 11, "agent11"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
			// No-drop: the bridge read still judges the lines it covered.
			expect(
				(await positionalEdit(runtime, file, [[2, 2, "agent2"]])).blocked,
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// #3865 member 3: a bridge read moves the whole-file FileTime only when it
	// read every line. Recurrence: a small file's range read carries a
	// whole-file content binding, and stamping on that alone vouched for a
	// line the agent last saw, unhashed, in an older whole-file bridge read.
	it("does not let a bridge range read of a small file re-stamp FileTime (#3865)", async () => {
		const env = setupTestEnvironment("rg-3865-bridge-range-small-");
		try {
			const file = fixture(env.tmpDir, "s.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			_bridgeRuntime = runtime;
			const bridge = (globalThis as Record<symbol, ReadBridge>)[
				READ_BRIDGE_KEY
			];
			// A whole-file v1 read: a whole-file binding, no line hashes.
			bridge.recordRead({
				filePath: file,
				requestedOffset: 1,
				requestedLimit: undefined,
			});
			const v = diskLines(file);
			v[4] = "EXTERNAL5";
			writeNow(file, v.join("\n"));
			bridge.recordRead({
				filePath: file,
				requestedOffset: 1,
				requestedLimit: 2,
			});
			const edit = await positionalEdit(runtime, file, [[5, 5, "agent5"]]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("File modified since read");
		} finally {
			env.cleanup();
		}
	});

	it("still blocks when the native re-read did not deliver the edited line", async () => {
		const env = setupTestEnvironment("rg-3962-native-noncover-");
		try {
			const file = fixture(
				env.tmpDir,
				"b.ts",
				"const a = 1;\nconst b = 2;\nconst c = 3;\n",
			);
			const runtime = newRuntime(env.tmpDir);
			_bridgeRuntime = runtime;
			const bridge = (globalThis as Record<symbol, ReadBridge>)[
				READ_BRIDGE_KEY
			];
			bridge.recordRead({
				filePath: file,
				requestedOffset: 1,
				requestedLimit: 1,
			});
			writeNow(file, "const a = 99;\nconst b = 2;\nconst c = 3;\n");
			// A newer native read of line 1 only; the edit targets line 3, which
			// the read never delivered. The strong anchor is not dropped for it.
			await piRead(runtime, file, { offset: 1, limit: 1 });
			const edit = await positionalEdit(runtime, file, [
				[3, 3, "const c = 30;"],
			]);
			expect(edit.blocked).toBe(true);
			expect(edit.reason).toContain("content no longer matches");
		} finally {
			env.cleanup();
		}
	});
});

describe("#4942 r7: a primary reset keeps a live secondary's in-flight read stamp", () => {
	it("blocks an edit on a line another writer changed while the secondary's read was in flight across the primary's reset", async () => {
		// RECURRENCE GUARDED: #4955 review F13 (CodeRabbit PRRT_kwDORt8rec6xWL2f,
		// AGENTS shape 46: a bound must not drop state a live reader still
		// needs). resetForSession released every dropped secondary guard's
		// FileTime bucket. A secondary's read whose tool_call stamped the file
		// before the reset and whose tool_result came after it then found no
		// stamp, so diskMovedSinceStamp read false after an external write and
		// the result recorded the racer's bytes as read.
		const env = setupTestEnvironment("rg-4942-r7-reset-inflight-");
		try {
			const file = fixture(env.tmpDir, "a.ts", `${lines(6).join("\n")}\n`);
			const runtime = newRuntime(env.tmpDir);
			runtime.setSessionLifecycle({ sessionId: "primary-r7" });
			const sub = "sub-r7";
			const toolCallId = `read-${++seq}`;
			const args = { path: file, offset: 1, limit: 6 };
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					...(callDeps(runtime, {
						toolName: "read",
						toolCallId,
						input: args,
					}) as object),
					sessionId: sub,
				} as never),
			);
			const result = await createReadToolDefinition(
				runtime.projectRoot,
			).execute(toolCallId, args, undefined, undefined, {
				cwd: runtime.projectRoot,
			} as never);
			// The primary resets while the secondary's read is in flight, and
			// another writer changes line 3 before the tool_result.
			runtime.resetForSession();
			const changed = lines(6);
			changed[2] = "EXTERNAL3";
			writeNow(file, `${changed.join("\n")}\n`);
			await handleToolResult({
				...(resultDeps(runtime, {
					toolName: "read",
					toolCallId,
					input: args,
					content: result.content,
					details: result.details,
				}) as object),
				sessionId: sub,
				readGuard: runtime.readGuardFor(sub),
			} as never);

			const editId = `edit-${++seq}`;
			const verdict = (await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					...(callDeps(runtime, {
						toolName: "edit",
						toolCallId: editId,
						input: {
							path: file,
							edits: [
								{
									range: { start: { line: 3 }, end: { line: 3 } },
									newText: "agent3",
								},
							],
						},
					}) as object),
					sessionId: sub,
				} as never),
			)) as { block?: boolean } | undefined;
			expect(verdict?.block).toBe(true);
		} finally {
			createFileTime("sub-r7").clear();
			env.cleanup();
		}
	});
});
