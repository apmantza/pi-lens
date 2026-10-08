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
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(),
	resyncGitChangedFiles: vi.fn().mockResolvedValue(undefined),
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
import { getLSPService } from "../../clients/lsp/index.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

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
		await handleToolCall(
			callDeps(runtime, { toolName: "read", toolCallId, input: args }),
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
	const verdict = (await handleToolCall(
		callDeps(runtime, { toolName: "edit", toolCallId, input }),
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
	await handleToolCall(
		callDeps(runtime, { toolName: "write", toolCallId, input }),
	);
	writeNow(file, content);
	gate?.();
	await handleToolResult(
		resultDeps(runtime, { toolName: "write", toolCallId, input, content: [] }),
	);
}

/** pi's native `edit` (oldText/newText): tool_call, host apply, tool_result. */
async function textEdit(
	runtime: RuntimeCoordinator,
	file: string,
	oldText: string,
	newText: string,
): Promise<{ blocked: boolean; reason?: string }> {
	const toolCallId = `text-edit-${++seq}`;
	const input = { path: file, edits: [{ oldText, newText }] };
	const verdict = (await handleToolCall(
		callDeps(runtime, { toolName: "edit", toolCallId, input }),
	)) as { block?: boolean; reason?: string } | undefined;
	if (verdict?.block === true) return { blocked: true, reason: verdict.reason };
	writeNow(file, fs.readFileSync(file, "utf8").replace(oldText, newText));
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
	await handleToolCall(
		callDeps(runtime, { toolName: "write", toolCallId: "w1", input }),
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

beforeEach(() => {
	resetDegradationLedger();
	vi.mocked(logLatency).mockClear();
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
	vi.mocked(dispatchLintWithResult).mockResolvedValue(CLEAN_DISPATCH as never);
});

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
				const verdict = (await handleToolCall(
					callDeps(runtime, { toolName: "edit", toolCallId, input }),
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
				const verdict = (await handleToolCall(
					callDeps(runtime, { toolName: "replace", toolCallId, input }),
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
			await handleToolCall(
				callDeps(runtime, {
					toolName: "read",
					toolCallId: "call_9",
					input: args,
				}),
			);
			await piRead(runtime, file, { offset: 1, limit: 12 });
			const own = await positionalEdit(runtime, file, [[5, 5, "own5"]]);
			await applyEdit(runtime, file, own);
			// The id comes back: decorated, and raced on line 11.
			await handleToolCall(
				callDeps(runtime, {
					toolName: "read",
					toolCallId: "call_9",
					input: args,
				}),
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
			await handleToolCall(
				callDeps(runtime, { toolName: "edit", toolCallId, input }),
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
	 * An oldText batch whose second edit does not resolve: pi-lens applies the
	 * first itself and refuses the batch (#2402's partial apply).
	 */
	const partialApply = async (
		runtime: RuntimeCoordinator,
		file: string,
		oldText: string,
		newText: string,
	) => {
		const toolCallId = `partial-${++seq}`;
		const input = {
			path: file,
			edits: [
				{ oldText, newText },
				{ oldText: "NOPE\n", newText: "x\n" },
			],
		};
		const verdict = (await handleToolCall(
			callDeps(runtime, { toolName: "edit", toolCallId, input }),
		)) as { block?: boolean; reason?: string } | undefined;
		expect(verdict?.reason).toContain("PARTIAL APPLY — 1 edit committed");
		expect(verdict?.reason).not.toContain("Post-edit analysis failed");
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
			await handleToolCall(
				callDeps(runtime, { toolName: "bash", toolCallId, input }),
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
			vi.mocked(getLSPService).mockReturnValue(
				makeLspServiceDouble({
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
				}) as never,
			);
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
 * by a newer covering read whose hashes still match disk. The bridge is
 * registered once for the file (its global property is non-configurable);
 * `_bridgeRuntime` points it at the current case's guard.
 */
let _bridgeRuntime: RuntimeCoordinator | undefined;

describe("#3962: a native re-read supersedes a stale bridge binding", () => {
	beforeAll(() => {
		// #3654: the v1 shim runs the unified bridge body, wired as index.ts
		// wires it; only the read half of the deps is reachable from a read.
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
	});

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
