// flake-shape: real-process-spawn — the cost under test is the real `git status` children each tool call spawns, counted at the spawn boundary; a stubbed git would answer only the count it was given.
/**
 * #4732: the opaque before/after diff runs for every tool call that is not
 * known to be read-only or structured, not only for `bash`.
 *
 * Recurrence prevented: the gate admitted one known writer by name
 * (`toolName === "bash"`) and skipped every other tool, so a file written by
 * another extension's tool, an MCP tool routed through pi, or the outer
 * codemode call was never diffed and never reached a diagnostic. Unknown must
 * mean opaque.
 *
 * Real here: `handleToolCall` and `handleToolResult` (the bodies `index.ts`
 * registers), the runtime coordinator, the opaque baseline store, and a real
 * git repository. The one double is at the process boundary: `safeSpawnAsync`
 * passes every call through to the real spawn and records its argv, so the
 * table below can count the `git status` children each call costs; one case
 * makes the post-call `git status` exit 128, as a broken repository does.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({
	argv: [] as string[][],
	/** 1-based: this and every later `git status` exits 128 (git failed). */
	failStatusFrom: Number.POSITIVE_INFINITY,
	/** Runs after the n-th `git status` child exits, before its caller resumes. */
	afterStatus: undefined as undefined | ((n: number) => Promise<void>),
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: vi.fn(
			(...args: Parameters<typeof actual.safeSpawnAsync>) => {
				spawned.argv.push([args[0], ...(args[1] ?? [])]);
				const statuses = spawned.argv.filter(
					(argv) => argv[0] === "git" && argv[1] === "status",
				).length;
				const after = spawned.afterStatus;
				if (args[0] === "git" && args[1]?.[0] === "status" && after)
					return actual.safeSpawnAsync(...args).then(async (outcome) => {
						await after(statuses);
						return outcome;
					});
				if (
					args[0] === "git" &&
					args[1]?.[0] === "status" &&
					statuses >= spawned.failStatusFrom
				)
					return Promise.resolve({
						stdout: "",
						stderr: "fatal: probe",
						status: 128,
					});
				return actual.safeSpawnAsync(...args);
			},
		),
	};
});

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { subscribeDiskChange } from "../../clients/disk-changes.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	MUTATION_BRIDGE_KEY,
	registerMutationBridge,
} from "../../clients/mutation-bridge.js";
import {
	resetOpaqueMutationState,
	shouldRunOpaqueRecovery,
} from "../../clients/opaque-mutation-scan.js";
import { hasPendingObservation } from "../../clients/observed-mutation.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { syncGitGuardRecord } from "../../clients/git-guard.js";
import { execSync } from "../support/git-fixture-env.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import { removeTempDirSync } from "./test-utils.js";

/**
 * The bridge `index.ts` mounts, so an observed call's settle records what it
 * saw (unmounted, every replay is refused and nothing is dispatched). It is a
 * process-global, first-wins singleton: mounted once per file over a holder
 * each case's runtime takes.
 */
const bridgeTarget: { runtime?: RuntimeCoordinator; root: string } = {
	root: "",
};
if (!(MUTATION_BRIDGE_KEY in (globalThis as object)))
	registerMutationBridge({
		getRuntime: () => bridgeTarget.runtime as never,
		getCacheManager: () => new CacheManager(false),
		getProjectRoot: () => bridgeTarget.root,
		getDispatchCwd: () => bridgeTarget.root,
		countFileLines,
		isRecordable: () => true,
		dbg: () => {},
	});

describe("shouldRunOpaqueRecovery: an unknown tool is opaque (#4732)", () => {
	const root = path.join(os.tmpdir(), "pi-lens-opaque-any-tool-gate");
	// Expected values are written out here, not read from the production
	// tables: a row that moves between the lists must red this table.
	it.each([
		// Unknown names: another extension's tool, an MCP tool via pi, codemode.
		["some_ext_tool", true],
		["codemode", true],
		["mcp__github__create_or_update_file", true],
		// An MCP-only pi-lens registry name is a third-party name on pi.
		["pilens_analyze", true],
		// A name that is a property of every object is still just a name.
		["constructor", true],
		// pi's shells write whatever their command does.
		["bash", true],
		["powershell", true],
		// pi's read-only built-ins.
		["read", false],
		["grep", false],
		["find", false],
		["ls", false],
		// pi's structured writers: the classified chain records their path.
		["write", false],
		["edit", false],
		// pi-lens's own tools: read-only, or writing through the mutation bridge.
		["symbol_search", false],
		["module_report", false],
		["ast_grep_replace", false],
		["lsp_navigation", false],
		["lens_diagnostic_mark", false],
	])("answers %s with %s", (toolName, expected) => {
		expect(shouldRunOpaqueRecovery(toolName, root)).toBe(expected);
	});

	it("never runs without a root", () => {
		expect(shouldRunOpaqueRecovery("some_ext_tool", undefined)).toBe(false);
	});
});

describe("which calls pay for git status (#4732)", () => {
	let tmpRoot = "";
	let repoDir = "";
	const originalTestMode = process.env.PI_LENS_TEST_MODE;
	const originalDataDir = process.env.PILENS_DATA_DIR;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-opaque-any-tool-"),
		);
		repoDir = path.join(tmpRoot, "repo");
		fs.mkdirSync(repoDir);
		fs.writeFileSync(path.join(repoDir, "seed.ts"), "export const seed = 1;\n");
		execSync(
			"git init -q && git config user.email t@t.local && git config user.name t && git add -A && git commit -qm base",
			{ cwd: repoDir },
		);
		// Project data outside the repository, so a data write is never a
		// working-tree change of the command under test.
		process.env.PILENS_DATA_DIR = path.join(tmpRoot, "data");
		// The phase rows this table reads are real only outside test mode.
		process.env.PI_LENS_TEST_MODE = "0";
		resetOpaqueMutationState();
		resetDegradationLedger();
		spawned.argv.length = 0;
		spawned.failStatusFrom = Number.POSITIVE_INFINITY;
		spawned.afterStatus = undefined;
	});

	afterEach(() => {
		if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = originalTestMode;
		if (originalDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = originalDataDir;
		resetOpaqueMutationState();
		resetDegradationLedger();
		removeTempDirSync(tmpRoot);
	});

	function runtimeFor(sessionId: string): RuntimeCoordinator {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = repoDir;
		runtime.setTelemetryIdentity({ sessionId });
		bridgeTarget.runtime = runtime;
		bridgeTarget.root = repoDir;
		return runtime;
	}

	function callDeps(
		runtime: RuntimeCoordinator,
		event: Record<string, unknown>,
	): Parameters<typeof handleToolCall>[0] {
		return {
			event,
			ctx: { cwd: repoDir },
			lensEnabled: true,
			getFlag: (flag: string) => flag === "no-lsp",
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
		} as Parameters<typeof handleToolCall>[0];
	}

	function resultDeps(
		runtime: RuntimeCoordinator,
		event: Record<string, unknown>,
	): Parameters<typeof handleToolResult>[0] {
		return {
			event: { content: [{ type: "text", text: "ok" }], ...event },
			getFlag: (flag: string) => flag === "no-lsp",
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
		} as unknown as Parameters<typeof handleToolResult>[0];
	}

	function gitStatusSpawns(): number {
		return spawned.argv.filter(
			(argv) => argv[0] === "git" && argv[1] === "status",
		).length;
	}

	/** The latency rows of one phase this case added. */
	async function phaseRowsSince(
		offset: number,
		phase: string,
	): Promise<Array<{ toolName?: string; filePath?: string }>> {
		await flushLatencyLog();
		const logPath = getLatencyLogPath();
		const text = fs.existsSync(logPath)
			? fs.readFileSync(logPath, "utf8").slice(offset)
			: "";
		const scratch = path.join(tmpRoot, "latency-tail.ndjson");
		fs.writeFileSync(scratch, text);
		const read = readNdjsonRows<{
			phase?: string;
			toolName?: string;
			filePath?: string;
		}>(scratch);
		expect(read.skipped).toBe(0);
		return read.rows.filter((row) => row.phase === phase);
	}

	/** The files whose pipeline ran to its `total` row since `offset`, by tool. */
	async function analysedSince(offset: number): Promise<string[]> {
		return (await phaseRowsSince(offset, "total"))
			.map(
				(row) =>
					`${row.toolName} ${path.relative(repoDir, row.filePath ?? "")}`,
			)
			.sort();
	}

	async function latencyOffset(): Promise<number> {
		await flushLatencyLog();
		const logPath = getLatencyLogPath();
		return fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
	}

	const seed = () => path.join(repoDir, "seed.ts");

	// [label, toolName, input, isError at the result, git status children].
	// A captured call costs two: the dirty set before it runs and the
	// recovery after it. The repository is clean, so the same-HEAD discard
	// read (a third) never runs.
	it.each<[string, string, () => Record<string, unknown>, boolean, number]>([
		[
			"an unknown extension tool",
			"some_ext_tool",
			() => ({ query: "x" }),
			false,
			2,
		],
		[
			"the outer codemode call",
			"codemode",
			() => ({ code: "await bash({})" }),
			false,
			2,
		],
		[
			"an MCP tool routed through pi",
			"mcp__fs__write_file",
			() => ({ content: "x" }),
			false,
			2,
		],
		[
			"bash (control: unchanged)",
			"bash",
			() => ({ command: "node -e ''" }),
			false,
			2,
		],
		["pi's read", "read", () => ({ path: seed() }), false, 0],
		["pi's grep", "grep", () => ({ pattern: "seed", path: repoDir }), false, 0],
		["pi's ls", "ls", () => ({ path: repoDir }), false, 0],
		// The classified chain would dispatch a successful structured result;
		// a failed one returns before the pipeline, after every opaque gate.
		["pi's write", "write", () => ({ path: seed(), content: "x\n" }), true, 0],
		[
			"pi's edit",
			"edit",
			() => ({ path: seed(), edits: [{ oldText: "1", newText: "2" }] }),
			true,
			0,
		],
		[
			"a third-party tool the shape adapters classify",
			"hashline_edit",
			() => ({
				path: seed(),
				operations: [{ set_line: { anchor: "1", new_text: "x" } }],
			}),
			true,
			0,
		],
		[
			"a pi-lens read-only tool",
			"symbol_search",
			() => ({ query: "seed" }),
			false,
			0,
		],
		[
			"a pi-lens tool that writes through the bridge",
			"ast_grep_replace",
			() => ({ pattern: "a", rewrite: "b", apply: false }),
			false,
			0,
		],
	])(
		"%s spawns the expected git status children",
		{ timeout: 30_000 },
		async (_label, toolName, input, isError, expected) => {
			const runtime = runtimeFor(`4732-table-${toolName}`);
			const toolCallId = `4732-${toolName}-1`;
			const offset = await latencyOffset();
			const event = { toolName, toolCallId, input: input() };
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(runtime, event)),
			);
			await handleToolResult(
				resultDeps(runtime, {
					...event,
					...(isError ? { isError: true } : {}),
				}),
			);
			expect(gitStatusSpawns()).toBe(expected);
			// Acceptance: an allowlisted call records no new latency phase; a
			// captured one records exactly its own prescan row.
			const label = toolName === "bash" ? "node -e ''" : toolName;
			expect(
				(await phaseRowsSince(offset, "opaque_mutation_prescan")).map(
					(row) => row.filePath ?? "",
				),
			).toEqual(expected > 0 ? [label] : []);
			// A call whose own `tool_call` took no baseline (allowlisted, or an
			// event the classifier knows) is not recovered at its result either,
			// so it is never reported as an unanswered diff.
			expect(
				getDegradationSummary().filter(
					(group) => group.kind === "opaque-capture-refused",
				),
			).toEqual([]);
		},
	);

	// The captured call's writes went unseen, and nothing else would say so:
	// bash names the same verdict through its coverage row and its withheld
	// blockers, so only a non-bash call records it.
	it("names a captured call whose diff git could not answer", async () => {
		const runtime = runtimeFor("4732-git-failed");
		// The baseline's dirty set is status 1; the recovery's is status 2.
		spawned.failStatusFrom = 2;
		const event = {
			toolName: "some_ext_tool",
			toolCallId: "4732-git-failed-1",
			input: { query: "x" },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps(runtime, event)),
		);
		await handleToolResult(resultDeps(runtime, event));
		const refused = () =>
			getDegradationSummary().find(
				(group) => group.kind === "opaque-capture-refused",
			);
		expect(refused()?.latestReasons.map((entry) => entry.subject)).toEqual([
			"git-failed",
		]);

		resetDegradationLedger();
		spawned.argv.length = 0;
		const bash = {
			toolName: "bash",
			toolCallId: "4732-git-failed-bash",
			input: { command: "node -e ''" },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps(runtime, bash)),
		);
		await handleToolResult(resultDeps(runtime, bash));
		expect(gitStatusSpawns()).toBe(2);
		expect(refused()).toBeUndefined();
	});

	it("leaves a replacement session's observation of a reused call id to that session", async () => {
		// RECURRENCE GUARDED: #4737 r2 (Sourcery 4342686550; AGENTS.md shape 22).
		// The settle after the opaque recovery's await read the LIVE session
		// generation. A host that numbers call ids per session reused this id in
		// the session that replaced this one, so the dead handler settled, and
		// deleted, the new session's observation under its own tool's name.
		const runtime = runtimeFor("4737-reused-id");
		const id = "4737-reused-1";
		const later = path.join(repoDir, "later.ts");
		fs.writeFileSync(later, "export const later = 1;\n");
		const first = {
			toolName: "some_ext_tool",
			toolCallId: id,
			input: { path: seed() },
		};
		const second = {
			toolName: "other_ext_tool",
			toolCallId: id,
			input: { path: later },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps(runtime, first)),
		);
		fs.writeFileSync(seed(), "export const seed = 2;\n");
		// Status 1 is the baseline's dirty set; status 2 is the recovery, the
		// await the replacement lands in.
		spawned.afterStatus = async (n) => {
			if (n !== 2) return;
			spawned.afterStatus = undefined;
			runtime.resetForSession();
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(runtime, second)),
			);
		};
		await handleToolResult(resultDeps(runtime, first));
		expect(spawned.afterStatus).toBeUndefined();
		expect(hasPendingObservation(id)).toBe(true);

		fs.writeFileSync(later, "export const later = 2;\n");
		await handleToolResult(resultDeps(runtime, second));
		expect(hasPendingObservation(id)).toBe(false);
	});

	it("takes no opaque baseline for a provider replay, and recovers nothing at its result", async () => {
		// RECURRENCE GUARDED: #5162 r3 (CodeRabbit PRRT_kwDORt8rec6ycahw). A
		// `cursor-replay-` call is a card for work that ran before it arrived, so
		// a change in its window is another writer's; the opaque net still diffed
		// the session root around it and dispatched the change as the replay's.
		// The near-miss id is pi-cursor-sdk's real bridged execution: still diffed.
		const runtime = runtimeFor("5162-replay-opaque");
		// The near-miss first, on the clean repository; a replay pays nothing
		// whatever the tree holds.
		for (const [toolCallId, spawns, analysed] of [
			// Not a replay: the #2430 net observes it, and the opaque diff runs.
			["cursor-pi-bridge-ab-t1", 2, ["cursor seed.ts"]],
			["cursor-replay-9-1", 0, []],
		] as const) {
			spawned.argv.length = 0;
			const event = {
				toolName: "cursor",
				toolCallId,
				input: {
					path: "seed.ts",
					activityTitle: "Cursor edit",
					activitySummary: "edited the file",
				},
			};
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(runtime, event)),
			);
			const offset = await latencyOffset();
			fs.writeFileSync(seed(), `export const seed = "${toolCallId}";\n`);
			await handleToolResult(resultDeps(runtime, event));
			expect(gitStatusSpawns(), toolCallId).toBe(spawns);
			expect(await analysedSince(offset), toolCallId).toEqual(analysed);
		}
	});

	it("credits no authorship to a replayed bash command's window, and still analyses what it names", async () => {
		// RECURRENCE GUARDED: #5162 r3 sweep (shape 65). pi-cursor-sdk replays
		// Cursor's shell as a pi `bash` card with a `cursor-replay-` id, after the
		// command ran. The git recovery of its window saw another writer's bytes
		// on the path the command names and credited them as the agent's own
		// whole-file write.
		const cases = [
			// [id, Cursor ran it before the call, bytes landing in the window]
			// pi-cursor-sdk's real bridged execution: the host runs it in the
			// window. First, on the clean repository.
			["cursor-pi-bridge-ab-t2", false, "export const x = 1;\n"],
			["cursor-replay-b-1", true, "export const x = 'OTHER';\n"],
		] as const;
		const file = seed();
		for (const [toolCallId, ranBefore, windowBytes] of cases) {
			const runtime = runtimeFor(`5162-${toolCallId}`);
			spawned.argv.length = 0;
			const event = {
				toolName: "bash",
				toolCallId,
				input: { command: "echo 'export const x = 1;' > seed.ts" },
			};
			if (ranBefore) fs.writeFileSync(file, "export const x = 1;\n");
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(runtime, event)),
			);
			fs.writeFileSync(file, windowBytes);
			const offset = await latencyOffset();
			await handleToolResult({
				...resultDeps(runtime, event),
				readGuard: runtime.readGuard,
			} as never);
			const authored = (runtime.readGuard.exportAuthorship().entries ?? [])
				.filter((entry) => entry.filePath === file)
				.map((entry) => entry.toolCallId);
			expect(authored, toolCallId).toEqual(ranBefore ? [] : [toolCallId]);
			expect(gitStatusSpawns(), toolCallId).toBe(ranBefore ? 0 : 2);
			expect(await analysedSince(offset), toolCallId).toEqual([
				"write seed.ts",
			]);
			expect(
				await phaseRowsSince(offset, "opaque_mutation_coverage_unknown"),
				toolCallId,
			).toEqual([]);
		}
	});

	it("analyses an observed call's file when the result refuses its relative path", async () => {
		// RECURRENCE GUARDED: #4737 r3 (Greptile PRRT_kwDORt8rec6vD_bg). With the
		// read guard on, the result side refuses a relative path no attribution
		// backs, so filePath is unset. The recovery leaves the file to the
		// observation, and the observed dispatch ran only under `filePath`, so
		// the file was recorded but never analysed: no lint, and no verdict for
		// the commit gate.
		const runtime = runtimeFor("4737-r3-relative");
		const event = {
			toolName: "relative_ext_tool",
			toolCallId: "4737-r3-relative-1",
			input: { path: "seed.ts" },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps(runtime, event)),
		);
		const offset = await latencyOffset();
		fs.writeFileSync(seed(), "export const seed = 2;\n");
		await handleToolResult(resultDeps(runtime, event));
		expect(await analysedSince(offset)).toEqual(["relative_ext_tool seed.ts"]);
	});

	/**
	 * An unknown tool naming `seed.ts` (relative, so the result refuses it)
	 * renames the export `seed`; then a pi `write` of `seed` lands in a sibling.
	 * Returns that write's verdict and what the export cache maps afterwards.
	 */
	async function writeAfterRemovedExport(
		label: string,
		result: (
			deps: Parameters<typeof handleToolResult>[0],
		) => Parameters<typeof handleToolResult>[0],
	): Promise<{ reason: string | undefined; renamed: string | undefined }> {
		const runtime = runtimeFor(`4737-${label}`);
		// As session_start's export scan leaves it.
		runtime.cachedExports.set("seed", seed());
		const event = {
			toolName: `${label.replaceAll("-", "_")}_ext_tool`,
			toolCallId: `4737-${label}-1`,
			input: { path: "seed.ts" },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps(runtime, event)),
		);
		fs.writeFileSync(seed(), "export const renamed = 2;\n");
		await handleToolResult(result(resultDeps(runtime, event)));
		// An existing sibling: a write to a missing target returns before the
		// export check.
		const other = path.join(repoDir, "other.ts");
		fs.writeFileSync(other, "// placeholder\n");
		const write = {
			toolName: "write",
			toolCallId: `4737-${label}-write`,
			input: { path: other, content: "export const seed = 3;\n" },
		};
		const verdict = (await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps(runtime, write)),
		)) as { block?: boolean; reason?: string } | undefined;
		return {
			reason: verdict?.reason,
			renamed: runtime.cachedExports.get("renamed"),
		};
	}

	it("drops an export a refused relative path's edit removed, so a pi write of that name lands", async () => {
		// RECURRENCE GUARDED: #4737 r3 verify R3-F1. The cachedExports refresh
		// stayed keyed on filePath, so a refused relative path skipped it. The
		// cache kept the export the edit removed, and the next pi write of that
		// name in another file took a false "Redefining existing export(s)" STOP.
		expect(await writeAfterRemovedExport("r3-f1", (deps) => deps)).toEqual({
			reason: undefined,
			renamed: seed(),
		});
	});

	it("drops a removed export even when the analysis clients never arrive", async () => {
		// RECURRENCE GUARDED: #4737 r4 (Greptile PRRT_kwDORt8rec6vFINK). The
		// R3-F1 refresh sat inside the dispatch loop, after the client wait, so
		// a client load failure or a wait cut returned first and the false
		// duplicate-export STOP came back. Here the wait is cut: the clients are
		// not loaded yet and the call is cancelled.
		const cancelled = new AbortController();
		cancelled.abort();
		expect(
			await writeAfterRemovedExport("r4-clients", (deps) => ({
				...deps,
				metricsClient: undefined,
				signal: cancelled.signal,
			})),
		).toEqual({ reason: undefined, renamed: seed() });
	});

	it("clears the saved commit record when a clean observed edit of a refused relative path retires its blocker", async () => {
		// RECURRENCE GUARDED: #4737 r4 (Greptile, per-path mode thread). The
		// observed dispatch took its analysis-root mode from the handler's
		// `filePath`, which a refused relative path leaves unset, so the mode
		// was that of the process cwd, not of the file. syncGitGuardRecord then
		// skipped the saved record: the in-memory blocker cleared, and the saved
		// one kept refusing every commit.
		const runtime = runtimeFor("4737-r4-mode");
		const guarded = (flag: string) =>
			flag === "no-lsp" || flag === "lens-guard";
		let commits = 0;
		const commitBlocked = async () => {
			const commit = {
				toolName: "bash",
				toolCallId: `4737-r4-mode-commit-${++commits}`,
				input: { command: 'git commit -m "wip"' },
			};
			const verdict = (await runHandlerExpectingNoThrow(() =>
				handleToolCall({ ...callDeps(runtime, commit), getFlag: guarded }),
			)) as { block?: boolean } | undefined;
			return verdict?.block === true;
		};
		// As a blocked earlier dispatch of seed.ts leaves the gate: the
		// in-memory entry, and the saved record written from it.
		runtime.recordInlineBlockers(
			seed(),
			"🔴 STOP — 1 issue(s) must be fixed:\n  L1: eval() is banned",
			runtime.nextWriteIndex(),
			["ast-grep-napi"],
			[1],
		);
		syncGitGuardRecord(runtime, new CacheManager(false), repoDir);
		expect(await commitBlocked()).toBe(true);

		const event = {
			toolName: "mode_ext_tool",
			toolCallId: "4737-r4-mode-1",
			input: { path: "seed.ts" },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall({ ...callDeps(runtime, event), getFlag: guarded }),
		);
		const offset = await latencyOffset();
		fs.writeFileSync(seed(), "export const seed = 2;\n");
		await handleToolResult({ ...resultDeps(runtime, event), getFlag: guarded });
		// The run used the file's own class: a session file is not an adopted
		// root, whose dispatch admits only a short runner list.
		expect(
			await phaseRowsSince(offset, "dispatch_adopted_root_allowlist"),
		).toEqual([]);
		expect(runtime.hasInlineBlocker(seed())).toBe(false);
		expect(await commitBlocked()).toBe(false);
	});

	it("leaves a file an observed directory-target edit rewrote to the deferred autofix pass", async () => {
		// RECURRENCE GUARDED: #4737 r4 sweep. The observed path took its mutation
		// receipt for the path the tool named, which for a directory target is
		// the directory (and for a refused relative path, nothing). A file in it
		// that an earlier pi write's autofix had marked fixed this turn stayed
		// marked, so the deferred pass skipped the bytes the tool wrote.
		const runtime = runtimeFor("4737-r4-receipt");
		const dir = path.join(repoDir, "src");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "a.ts");
		fs.writeFileSync(file, "export const a = 1;\n");
		// As a pi write whose immediate autofix fixed the file leaves the turn.
		runtime.recordMutationToolReceipt(file, "write");
		runtime.fixedThisTurn.add(file);
		const event = {
			toolName: "dir_ext_tool",
			toolCallId: "4737-r4-receipt-1",
			input: { path: dir },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps(runtime, event)),
		);
		const offset = await latencyOffset();
		fs.writeFileSync(file, "export const a = 2;\n");
		await handleToolResult(resultDeps(runtime, event));
		expect(await analysedSince(offset)).toEqual(["dir_ext_tool src/a.ts"]);
		expect(runtime.fixedThisTurn.has(file)).toBe(false);
	});

	it("sends an observed file to the servers before a sibling the same call rewrote is checked", async () => {
		// RECURRENCE GUARDED: #4737 r3 (Greptile PRRT_kwDORt8rec6vD_bk; #4507).
		// The observation filter took the observed file out of `written`, so the
		// awaited primary send carried only its sibling, and the sibling's
		// synthetic dispatch checked an importer against its dependency's old
		// bytes before the observed path's own dispatch sent them.
		const runtime = runtimeFor("4737-r3-order");
		const dependency = path.join(repoDir, "z.ts");
		const importer = path.join(repoDir, "a.ts");
		fs.writeFileSync(dependency, "export const z = 1;\n");
		fs.writeFileSync(
			importer,
			'import { z } from "./z";\nexport const a = z;\n',
		);
		const sent: string[] = [];
		const off = subscribeDiskChange("4737-r3-order", (change) => {
			if (change.paths !== "unknown" && change.sources.includes("bash-write"))
				for (const file of change.paths) sent.push(path.basename(file));
		});
		const event = {
			toolName: "order_ext_tool",
			toolCallId: "4737-r3-order-1",
			input: { path: dependency },
		};
		let offset = 0;
		try {
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(runtime, event)),
			);
			offset = await latencyOffset();
			fs.writeFileSync(dependency, "export const zz = 1;\n");
			fs.writeFileSync(
				importer,
				'import { zz } from "./z";\nexport const a = zz;\n',
			);
			await handleToolResult(resultDeps(runtime, event));
		} finally {
			off();
		}
		// The awaited send runs before every synthetic dispatch of the call.
		expect(sent.sort()).toEqual(["a.ts", "z.ts"]);
		// One net each: the recovery dispatches a.ts, the observation z.ts.
		expect(await analysedSince(offset)).toEqual([
			"order_ext_tool z.ts",
			"write a.ts",
		]);
	});

	it("refuses a non-bash call with no tool-call id, once per session", async () => {
		const runtime = runtimeFor("4732-no-id");
		for (const _ of [1, 2]) {
			const event = { toolName: "some_ext_tool", input: { query: "x" } };
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(runtime, event)),
			);
			await handleToolResult(resultDeps(runtime, event));
		}
		// A host with no ids shares one slot with bash; a non-bash take there
		// would steal bash's baseline, so the call is refused and said so.
		expect(gitStatusSpawns()).toBe(0);
		const refused = getDegradationSummary().find(
			(group) => group.kind === "opaque-capture-refused",
		);
		expect(refused?.count).toBe(1);
		expect(refused?.latestReasons.map((entry) => entry.subject)).toEqual([
			"no-tool-call-id",
		]);
	});
});
