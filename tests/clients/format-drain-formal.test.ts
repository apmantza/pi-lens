/**
 * Replays of the `formal/format-drain` counterexamples (#3527, #3528, #3529)
 * against the real deferred drain: `handleAgentEnd`, `runFormatPhase`, the
 * real `FormatService` and `formatters.formatFile` (contentBefore, spawn,
 * contentAfter), `holdFileMutationQueue` over pi's real
 * `withFileMutationQueue`, `RuntimeCoordinator`, `ReadGuard`, `CacheManager`,
 * and for the LSP cases the real `LSPService` notify queue down to a mock
 * connection. Doubled: the formatter PROCESS (`safeSpawnAsync`), the
 * formatter selection, the LSP server registry and client construction.
 *
 * No wall clock: every interleaving is pinned with a gate that a double
 * opens or waits on, and the hook bounds run under fake timers. Each case
 * names the TLC config whose trace it replays.
 */
import * as fs from "node:fs";
import * as path from "node:path";
// pi's real per-file queue, the one its `edit`/`write` tools run under.
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import {
	FormatService,
	getFormatService,
} from "../../clients/format-service.js";
import { HOOK_WALL_BUDGET_MS } from "../../clients/hook-budgets.js";
import * as clientModule from "../../clients/lsp/client.js";
import {
	getLSPService,
	LSPService,
	resetLSPService,
} from "../../clients/lsp/index.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { type PipelineDeps, runPipeline } from "../../clients/pipeline.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setAmbientAbortSignal } from "../../clients/safe-spawn.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { retireScope } from "../../clients/session-scope.js";
import { waitFor } from "./interleaving-kit.js";
import { createMockState } from "./lsp/mock-client-state.js";
import { setupTestEnvironment } from "./test-utils.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

/**
 * The in-place formatter child, at the process boundary formatters.ts
 * `formatFile` spawns through: it reads F, parks, and writes its format of
 * what it READ, whatever the drain decided meanwhile (the `--write` shape).
 * No case holds a spawned child past its 15 s spawn timeout, so the kill is
 * not modelled.
 */
const child = vi.hoisted(() => ({
	command: "format-drain-child",
	resolving: undefined as undefined | (() => void),
	resolved: undefined as undefined | Promise<void>,
	spawned: undefined as undefined | (() => void),
	read: undefined as undefined | Promise<void>,
	didRead: undefined as undefined | (() => void),
	write: undefined as undefined | Promise<void>,
	wrote: undefined as undefined | (() => void),
	removeAfterWrite: false,
}));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: async (
			command: string,
			args: string[],
			options?: Parameters<typeof actual.safeSpawnAsync>[2],
		) => {
			if (command !== child.command)
				return actual.safeSpawnAsync(command, args, options);
			const file = args[0] as string;
			child.spawned?.();
			await child.read;
			const content = fs.readFileSync(file, "utf8");
			child.didRead?.();
			await child.write;
			fs.writeFileSync(file, content.replace(/[ \t]*=[ \t]*/g, " = "));
			if (child.removeAfterWrite) fs.rmSync(file);
			child.wrote?.();
			return { stdout: "", stderr: "", status: 0 };
		},
	};
});

// The formatter selection: one formatter whose command is the child above.
// Its command resolution can park (`child.resolved`), the #3558 shape.
vi.mock("../../clients/formatters-lazy.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/formatters-lazy.js")>();
	return {
		...actual,
		loadFormatters: async () => {
			const real = await actual.loadFormatters();
			const formatter = {
				name: "prettier",
				command: [child.command],
				extensions: [".ts"],
				detect: async () => true,
				resolveCommand: async (fp: string) => {
					child.resolving?.();
					await child.resolved;
					return [child.command, fp];
				},
			};
			return { ...real, getFormattersForFile: async () => [formatter] };
		},
	};
});

// The LSP half: the REAL LSPService and notify queue over a mock connection
// (the harness of tests/clients/lsp/notify-read-order.test.ts). The drain's
// touches pass through a gate: `drainTouch` lets a case order the drain's
// resync after the next edit's own sync, and `drainTouchesWaiting` says when
// the drain's touch has been issued.
const lsp = vi.hoisted(() => ({
	service: undefined as unknown,
	drainTouch: Promise.resolve() as Promise<void>,
	drainTouchesWaiting: 0,
	/** Serve the drain the real `getLSPService()` singleton instead of the gate. */
	realService: undefined as undefined | (() => unknown),
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
}));
vi.mock("../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/config.js")>()),
	getServersForFileWithConfig: lsp.getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/client.js")>()),
	createLSPClient: lsp.createLSPClient,
}));
const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));
// `resyncLspFile` reaches the service through the lazy seam
// (clients/lsp-lazy.ts); measured on this branch, a mock of `lsp/index.js`
// does not reach that dynamic import, which then serves a second, real
// service instance.
vi.mock("../../clients/lsp-lazy.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp-lazy.js")>();
	const { makeLspServiceDouble } =
		await import("../support/lsp-service-double.js");
	return {
		...actual,
		loadLspService: async () => ({
			...(await actual.loadLspService()),
			getLSPService: () => {
				if (lsp.realService) return lsp.realService() as LSPService;
				const service = lsp.service as LSPService;
				return makeLspServiceDouble({
					supportsLSP: (fp: string) => service.supportsLSP(fp),
					touchFile: async (...args: Parameters<LSPService["touchFile"]>) => {
						lsp.drainTouchesWaiting++;
						await lsp.drainTouch;
						return service.touchFile(...args);
					},
				}) as unknown as LSPService;
			},
		}),
	};
});

// #3858: the in-band cases run the real `runPipeline`; only its dispatch
// (runners, cascade) is doubled, to a clean verdict, since the format phase and
// the LSP sync under test run before it.
vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/integration.js")
	>()),
	dispatchLintWithResult: vi.fn(async () => ({
		diagnostics: [],
		blockers: [],
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: "",
		blockerOutput: "",
		hasBlockers: false,
	})),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let filePath: string;
let notices: string[];
let flags: Set<string>;
let cacheManager: CacheManager;

/** Arms the child's gates; each step is open unless the case parks it. */
function armChild(parked: { read?: boolean; write?: boolean } = {}) {
	const spawned = gate();
	const read = gate();
	const didRead = gate();
	const write = gate();
	const wrote = gate();
	child.spawned = spawned.open;
	child.read = read.p;
	child.didRead = didRead.open;
	child.write = write.p;
	child.wrote = wrote.open;
	if (!parked.read) read.open();
	if (!parked.write) write.open();
	return {
		spawned: spawned.p,
		didRead: didRead.p,
		wrote: wrote.p,
		openRead: read.open,
		openWrite: write.open,
	};
}

function drainDeps(
	over: Partial<Parameters<typeof handleAgentEnd>[0]> = {},
): Parameters<typeof handleAgentEnd>[0] {
	return {
		ctxCwd: env.tmpDir,
		getFlag: (name: string) => flags.has(name),
		notify: (msg: string) => notices.push(msg),
		dbg: () => {},
		runtime,
		cacheManager,
		getFormatService: () => new FormatService("format-drain", true),
		...over,
	} as Parameters<typeof handleAgentEnd>[0];
}

/**
 * The next run's edit, the way pi's edit tool runs it: a read-modify-write
 * inside pi's mutation queue. `sync` also sends the edit's own pipeline
 * sync to the LSP, stamped before its read (#3481).
 */
function agentAppend(line: string, sync?: LSPService) {
	let wrote = false;
	const done = withFileMutationQueue(filePath, async () => {
		const readStamp = performance.now();
		const content = `${fs.readFileSync(filePath, "utf8")}${line}`;
		fs.writeFileSync(filePath, content);
		wrote = true;
		return { content, readStamp };
	}).then(async ({ content, readStamp }) => {
		await sync?.touchFile(filePath, content, {
			diagnostics: "none",
			source: "test",
			readStamp,
		});
	});
	return { done, wrote: () => wrote };
}

/**
 * Resolves once every queue call made before it has registered: pi chains
 * registrations through one module-wide promise, so a call on another path
 * registers after them. An earlier call whose file is free has run by then.
 */
function afterQueueRegistration(): Promise<void> {
	return withFileMutationQueue(
		path.join(env.tmpDir, "registration-barrier"),
		async () => {},
	);
}

/** An edit of F with no read this session: what the read guard decides. */
function blindEditVerdict(): string | undefined {
	// Take #3520's mtime fallback out of play: F predates session 2.
	const old = new Date(Date.now() - 3_600_000);
	fs.utimesSync(filePath, old, old);
	return (runtime.readGuard.checkEdit(filePath, [1, 1]) as { action?: string })
		.action;
}

/** The drain's post-exit resync records (latency.log). */
const postExitRows = () =>
	logLatency.mock.calls
		.map(([row]) => row as { phase?: string; metadata?: unknown })
		.filter((row) => row.phase === "deferred_format_post_exit_resync");
/**
 * #3828: the drain's LATE resync rows: the resync chained onto an abandoned
 * formatter's settlement after the post-exit wait above gave up.
 */
const lateRows = () =>
	logLatency.mock.calls
		.map(([row]) => row as { phase?: string; metadata?: unknown })
		.filter((row) => row.phase === "deferred_format_late_resync");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A case whose bound gave up on the phase waits for the drain's detached
 * post-exit task to settle, so its ledger and latency rows cannot land in
 * the next case.
 */
function postExitSettled() {
	return waitFor(postExitRows, (rows) => rows.length > 0, {
		yieldControl: tick,
		timeoutMs: 2_000,
	});
}

function staleWriteSubjects(): string[] {
	return getDegradationSummary()
		.filter((group) => group.kind === "generation-guard-stale-write")
		.flatMap((group) => group.latestReasons.map((r) => r.subject));
}

/**
 * The post-exit resync's OWN `hook-await-exceeded` rows (#3599) — the
 * abandoned-formatter wait, not the in-hook `deferred-format` bound it runs
 * after. Subject is `<hook>:<label>`, so the off-hook label is the filter.
 */
function postExitResyncSubjects(): string[] {
	return getDegradationSummary()
		.filter((group) => group.kind === "hook-await-exceeded")
		.flatMap((group) => group.latestReasons.map((r) => r.subject))
		.filter(
			(subject) => subject === "off_hook:deferred-format-post-exit-resync",
		);
}

beforeEach(() => {
	logLatency.mockClear();
	setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
	setAmbientAbortSignal(undefined);
	resetDegradationLedger();
	notices = [];
	flags = new Set(["no-lsp"]);
	child.resolving = undefined;
	child.resolved = undefined;
	child.removeAfterWrite = false;
	env = setupTestEnvironment("pi-lens-format-drain-");
	// Project evidence for the "prettier" tool agreement (tool-agreement.ts).
	fs.writeFileSync(
		path.join(env.tmpDir, "package.json"),
		JSON.stringify({ devDependencies: { prettier: "3.3.3" } }),
	);
	fs.writeFileSync(
		path.join(env.tmpDir, "package-lock.json"),
		JSON.stringify({
			packages: { "node_modules/prettier": { version: "3.3.3" } },
		}),
	);
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	cacheManager = new CacheManager(false);
	filePath = path.join(env.tmpDir, "f.ts");
	fs.writeFileSync(filePath, "const x=1\n");
	runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "format");
});

afterEach(() => {
	vi.useRealTimers();
	setHostFileMutationQueueLoader(undefined);
	env.cleanup();
});

describe("#3527: the drain's format runs inside pi's mutation queue", () => {
	it("OverlapLostEdit (#3527): a next-run edit made after the child read F waits for the child, so the format does not erase it", async () => {
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		const agent = agentAppend("const y=2\n");
		await afterQueueRegistration();
		expect(agent.wrote()).toBe(false);
		c.openWrite();
		const summary = await drain;
		await agent.done;
		expect(fs.readFileSync(filePath, "utf8")).toBe("const x = 1\nconst y=2\n");
		expect(summary?.changed).toEqual([filePath]);
	});

	it("OverlapClaim (#3527): a next-run edit never lands inside the drain's before/after window, so what it reports as its format is formatting only", async () => {
		const c = armChild({ read: true });
		const drain = handleAgentEnd(drainDeps());
		// contentBefore is read before the spawn.
		await c.spawned;
		const agent = agentAppend("const y=2\n");
		await afterQueueRegistration();
		expect(agent.wrote()).toBe(false);
		c.openRead();
		const summary = await drain;
		await agent.done;
		// The agent's line is outside the claimed diff: the child never
		// formatted it, and the drain's claim is its own format of line 1.
		expect(fs.readFileSync(filePath, "utf8")).toBe("const x = 1\nconst y=2\n");
		expect(summary?.changed).toEqual([filePath]);
		expect(notices).toEqual([
			"pi-lens deferred format applied to 1 file(s): f.ts",
		]);
	});

	it("OrphanLostEdit (#3527): the child the hook's 10 s bound gave up on keeps pi's queue until it writes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
		// The hook returned: an interactive pi now takes the next prompt.
		const summary = await drain;
		expect(summary?.failed).toEqual([
			{
				filePath,
				errors: ["deferred formatter exceeded agent_settled budget"],
			},
		]);
		const agent = agentAppend("const y=2\n");
		await afterQueueRegistration();
		expect(agent.wrote()).toBe(false);
		c.openWrite();
		await agent.done;
		expect(fs.readFileSync(filePath, "utf8")).toBe("const x = 1\nconst y=2\n");
		await postExitSettled();
	});
});

/**
 * #3558: the formatter enters pi's queue only once its command is resolved.
 * `child.resolved` parks `resolveCommand`, the step where the eight
 * install-capable resolvers call `ensureTool` (an install can take 120 s).
 */
describe("#3558: the drain's formatter resolves its command outside pi's queue", () => {
	function parkResolution() {
		const resolving = gate();
		const resolution = gate();
		child.resolving = resolving.open;
		child.resolved = resolution.p;
		return { resolving: resolving.p, resolve: resolution.open };
	}

	it("InstallHold (#3558): a next-run edit made while the formatter resolves its command lands at once, and is formatted with the file", async () => {
		const r = parkResolution();
		const c = armChild();
		const drain = handleAgentEnd(drainDeps());
		await r.resolving;
		const agent = agentAppend("const y=2\n");
		await afterQueueRegistration();
		expect(agent.wrote()).toBe(true);
		r.resolve();
		const summary = await drain;
		await c.wrote;
		expect(fs.readFileSync(filePath, "utf8")).toBe(
			"const x = 1\nconst y = 2\n",
		);
		expect(summary?.changed).toEqual([filePath]);
	});

	it("InstallOrphan (#3558): a formatter both bounds gave up on while it resolved holds no queue until it reaches its write, then writes inside one", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const r = parkResolution();
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await r.resolving;
		// The hook's bound, then the service's 30 s aggregate, give up while the
		// install runs on; the phase settles and releases its hold.
		await vi.advanceTimersByTimeAsync(30_000);
		await drain;
		const whileResolving = agentAppend("const y=2\n");
		await afterQueueRegistration();
		expect(whileResolving.wrote()).toBe(true);
		// The install finishes: the late formatter reads F inside a queue entry
		// of its own, so an edit made before its write waits for it.
		r.resolve();
		await c.didRead;
		const whileWriting = agentAppend("const z=3\n");
		await afterQueueRegistration();
		expect(whileWriting.wrote()).toBe(false);
		c.openWrite();
		await whileWriting.done;
		expect(fs.readFileSync(filePath, "utf8")).toBe(
			"const x = 1\nconst y = 2\nconst z=3\n",
		);
		await postExitSettled();
	});
});

/**
 * #3599: after `agent_settled`'s bound gives up on the phase, the post-exit
 * resync waited forever on the abandoned formatter — its command resolution
 * auto-installs and has no leaf bound. It now waits under the drain's own
 * budget, and a wait that expires records one `hook-await-exceeded`
 * degradation and abandons the resync instead of publishing bytes the
 * formatter is about to replace.
 */
describe("#3599: an abandoned formatter's resync wait is bounded", () => {
	it("AbandonedInstall (#3599): a formatter whose install never finishes no longer parks the post-exit resync", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const resolving = gate();
		child.resolving = resolving.open;
		// The install never finishes: `resolveCommand` (the auto-install step)
		// returns a promise that never settles.
		child.resolved = new Promise<void>(() => {});
		armChild();
		const drain = handleAgentEnd(drainDeps());
		await resolving.p;
		// The hook bound (10 s) gives up on the phase; the formatter service's
		// own aggregate then marks the formatter abandoned; the post-exit wait
		// is bounded by that same budget. Advance just past all three.
		await vi.advanceTimersByTimeAsync(
			HOOK_WALL_BUDGET_MS.agent_settled + 30_000 + 1,
		);
		await drain;
		await postExitSettled();
		expect(postExitRows()).toEqual([
			expect.objectContaining({
				filePath,
				metadata: { outcome: "abandoned" },
			}),
		]);
		// `bounded()` records `hook-await-exceeded` once per (hook, label); the
		// off-hook label is this wait's own, so it appears exactly once.
		expect(postExitResyncSubjects()).toEqual([
			"off_hook:deferred-format-post-exit-resync",
		]);
		// #3828: a formatter that never settles is never synced, and the
		// continuation chained on it writes no row and holds nothing.
		expect(lateRows()).toEqual([]);
	});
});

describe("#3528: a drain that outlives its session writes nothing into the next", () => {
	it("Straddle (#3528): a session-1 drain's recordWritten does not admit a never-read session-2 edit", async () => {
		flags.add("lens-turn-summary");
		const addModifiedRange = vi.spyOn(cacheManager, "addModifiedRange");
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		// `/new` in the editor while the drain awaits its formatter.
		runtime.resetForSession(Date.now());
		c.openWrite();
		const summary = await drain;
		// The format itself ran: the file is the project's, not the session's.
		expect(summary?.changed).toEqual([filePath]);
		expect(fs.readFileSync(filePath, "utf8")).toBe("const x = 1\n");
		expect(blindEditVerdict()).toBe("block");
		expect(runtime.getFileSeq(filePath)).toBe(0);
		expect(runtime.projectSeq).toBe(0);
		expect(addModifiedRange).not.toHaveBeenCalled();
		expect(runtime.turnSummary.peek()).toEqual([]);
		expect(staleWriteSubjects()).toEqual([`runtime-session:${filePath}`]);
	});

	it("StraddleState (#3528): an abandoned session-1 format is not requeued into session 2's cleared queue", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		runtime.resetForSession(Date.now());
		expect(runtime.pendingDeferredMutationCount).toBe(0);
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
		await drain;
		expect(runtime.pendingDeferredMutationCount).toBe(0);
		expect(staleWriteSubjects()).toEqual([`runtime-session:${filePath}`]);
		c.openWrite();
		await c.wrote;
		await postExitSettled();
		expect(postExitRows()).toEqual([
			expect.objectContaining({ metadata: { outcome: "stale-session" } }),
		]);
	});

	it("StraddleAutofix (#3528): the drain's autofix bookkeeping does not land in session 2", async () => {
		const { fixer, parked, resume } = gatedBiome();
		writeBiomeAgreement();
		runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "autofix");
		flags.add("no-autoformat");
		const addModifiedRange = vi.spyOn(cacheManager, "addModifiedRange");
		const drain = handleAgentEnd(
			drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
		);
		await parked.p;
		runtime.resetForSession(Date.now());
		resume.open();
		await drain;
		expect(fs.readFileSync(filePath, "utf8")).toBe("let x=1\n");
		expect(blindEditVerdict()).toBe("block");
		expect(runtime.getFileSeq(filePath)).toBe(0);
		expect(addModifiedRange).not.toHaveBeenCalled();
		expect(staleWriteSubjects()).toEqual([`runtime-session:${filePath}`]);
	});

	it("StraddleAutofix (#3576): a replaced session's autofix does not mark the file fixed for the next session", async () => {
		const { fixer, parked, resume } = gatedBiome();
		writeBiomeAgreement();
		runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "autofix");
		flags.add("no-autoformat");
		const drain = handleAgentEnd(
			drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
		);
		await parked.p;
		runtime.resetForSession(Date.now());
		resume.open();
		await drain;
		expect(fs.readFileSync(filePath, "utf8")).toBe("let x=1\n");
		// runAutofix would skip this file for the rest of session 2's turn.
		expect(runtime.fixedThisTurn.has(filePath)).toBe(false);
		expect(staleWriteSubjects()).toContain(`runtime-session:${filePath}`);
	});

	describe("a drain whose session was replaced starts no new in-place write (#3528 r1 F1)", () => {
		// FormatDrain FixNoStartGen: the old drain's write could not be synced to
		// the next session's LSP document (its resync is skipped), so it must not
		// start one.
		it("the format phase does not start after /new during the autofix phase", async () => {
			const { fixer, parked, resume } = gatedBiome();
			writeBiomeAgreement();
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			let spawned = false;
			armChild();
			child.spawned = () => {
				spawned = true;
			};
			const drain = handleAgentEnd(
				drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
			);
			await parked.p;
			runtime.resetForSession(Date.now());
			resume.open();
			await drain;
			expect(spawned).toBe(false);
			expect(fs.readFileSync(filePath, "utf8")).toBe("let x=1\n");
			expect(staleWriteSubjects()).toContain(`runtime-session:${filePath}`);
		});

		it("every claimed file it did not start is named in summary.skipped (#3528 r2)", async () => {
			const { fixer, parked, resume } = gatedBiome();
			writeBiomeAgreement();
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			const formatOnly = ["b.ts", "c.ts", "d.ts", "e.ts"].map((name) => {
				const fp = path.join(env.tmpDir, name);
				fs.writeFileSync(fp, "const z=3\n");
				runtime.deferMutation(fp, env.tmpDir, "edit", env.tmpDir, "format");
				return fp;
			});
			// Its own project, so Biome's project scope does not dedupe it.
			const otherRoot = path.join(env.tmpDir, "other");
			fs.mkdirSync(otherRoot);
			writeBiomeAgreement(otherRoot);
			const bothKinds = path.join(otherRoot, "g.ts");
			fs.writeFileSync(bothKinds, "const y=2\n");
			runtime.deferMutation(bothKinds, otherRoot, "edit", otherRoot, "autofix");
			// Both kinds, neither started: named once, not by each loop.
			runtime.deferMutation(bothKinds, otherRoot, "edit", otherRoot, "format");
			// Autofix only, in a third project: only the autofix loop can name it.
			const thirdRoot = path.join(env.tmpDir, "third");
			fs.mkdirSync(thirdRoot);
			writeBiomeAgreement(thirdRoot);
			const autofixOnly = path.join(thirdRoot, "h.ts");
			fs.writeFileSync(autofixOnly, "const w=4\n");
			runtime.deferMutation(
				autofixOnly,
				thirdRoot,
				"edit",
				thirdRoot,
				"autofix",
			);
			const drain = handleAgentEnd(
				drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
			);
			await parked.p;
			runtime.resetForSession(Date.now());
			resume.open();
			const summary = await drain;
			// f.ts: its autofix ran, its format was never started. g.ts: neither
			// its autofix nor its format was started. h.ts: its autofix was never
			// started. b-e.ts: never formatted.
			expect(
				summary?.skipped
					.filter((entry) => entry.reason === "session-replaced")
					.map((entry) => path.basename(entry.filePath))
					.sort(),
			).toEqual(["b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"]);
			for (const fp of formatOnly)
				expect(fs.readFileSync(fp, "utf8")).toBe("const z=3\n");
		});

		it("the autofix loop does not start the next file after /new", async () => {
			const { fixer, parked, resume } = gatedBiome();
			const fixFileAsync = vi.spyOn(
				fixer as unknown as { fixFileAsync: () => unknown },
				"fixFileAsync",
			);
			writeBiomeAgreement();
			flags.add("no-autoformat");
			// Its own project: Biome's fix scope is the project, so a second file
			// of the same project would be deduped rather than started.
			const otherRoot = path.join(env.tmpDir, "other");
			fs.mkdirSync(otherRoot);
			writeBiomeAgreement(otherRoot);
			const second = path.join(otherRoot, "g.ts");
			fs.writeFileSync(second, "const y=2\n");
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			runtime.deferMutation(second, otherRoot, "edit", otherRoot, "autofix");
			const drain = handleAgentEnd(
				drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
			);
			await parked.p;
			runtime.resetForSession(Date.now());
			resume.open();
			await drain;
			expect(fixFileAsync).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync(second, "utf8")).toBe("const y=2\n");
		});
	});

	describe("no-drop (#3528, shape 54): a drain that stays in its session still records", () => {
		it("the format's recordWritten, change log, modified range and turn summary land in its own session", async () => {
			flags.add("lens-turn-summary");
			const addModifiedRange = vi.spyOn(cacheManager, "addModifiedRange");
			armChild();
			const summary = await handleAgentEnd(drainDeps());
			expect(summary?.changed).toEqual([filePath]);
			expect(blindEditVerdict()).toBe("allow");
			expect(runtime.getFileSeq(filePath)).toBe(1);
			expect(addModifiedRange).toHaveBeenCalledTimes(1);
			expect(runtime.turnSummary.peek()).toEqual([
				expect.objectContaining({
					filePath,
					events: [{ kind: "format", tool: "prettier" }],
				}),
			]);
			expect(staleWriteSubjects()).toEqual([]);
		});

		it("an abandoned format is requeued in its own session", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
			await drain;
			expect(runtime.pendingDeferredMutationCount).toBe(1);
			c.openWrite();
			await c.wrote;
			await postExitSettled();
		});

		it("the autofix's fixedThisTurn mark lands in its own session (#3576)", async () => {
			const { fixer, parked, resume } = gatedBiome();
			writeBiomeAgreement();
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			flags.add("no-autoformat");
			const drain = handleAgentEnd(
				drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
			);
			await parked.p;
			resume.open();
			await drain;
			expect(runtime.fixedThisTurn.has(filePath)).toBe(true);
		});

		it("the autofix's recordWritten, change log and modified range land in its own session", async () => {
			const { fixer, resume } = gatedBiome();
			resume.open();
			writeBiomeAgreement();
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			flags.add("no-autoformat");
			const addModifiedRange = vi.spyOn(cacheManager, "addModifiedRange");
			await handleAgentEnd(
				drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
			);
			expect(blindEditVerdict()).toBe("allow");
			expect(runtime.getFileSeq(filePath)).toBe(1);
			expect(addModifiedRange).toHaveBeenCalledTimes(1);
		});
	});
});

/** The Biome agreement evidence the autofix gate needs, and a biome.json. */
function writeBiomeAgreement(root = env.tmpDir): void {
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({
			devDependencies: { "@biomejs/biome": "^2.4.10", prettier: "3.3.3" },
		}),
	);
	fs.writeFileSync(
		path.join(root, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": {},
				"node_modules/@biomejs/biome": { version: "2.4.10" },
				"node_modules/prettier": { version: "3.3.3" },
			},
		}),
	);
	fs.writeFileSync(path.join(root, "biome.json"), "{}\n");
}

const noRuff = {
	isPythonFile: () => false,
	ensureAvailable: async () => false,
} as never;

/**
 * A `BiomeClient.fixFileAsync` double with the real one's shape
 * (biome-client.ts): read, let `lint --write` rewrite what it read, read it
 * back, report a fix only when the bytes moved. Parks between read and write.
 */
function gatedBiome() {
	const parked = gate();
	const resume = gate();
	const fixer = {
		isSupportedFile: () => true,
		ensureAvailable: async () => true,
		fixFileAsync: async (fp: string) => {
			const before = fs.readFileSync(fp, "utf8");
			parked.open();
			await resume.p;
			fs.writeFileSync(fp, before.replace("const ", "let "));
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

describe("#3529: the drain's LSP sync ends on the bytes on disk", () => {
	/** didOpen/didChange texts the server received, in order. */
	let wire: string[];
	let service: LSPService;
	/** The mock connection's state and the client every spawn returns. */
	let lspState: ReturnType<typeof createMockState>;
	let lspClient: Record<string, unknown>;

	beforeEach(async () => {
		flags.delete("no-lsp");
		wire = [];
		const state = createMockState({
			root: env.tmpDir,
			serverId: "typescript",
		});
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: unknown, params: unknown) => {
				const m = String(method).replace("textDocument/", "");
				if (m !== "didOpen" && m !== "didChange") return;
				const p = params as {
					textDocument?: { text?: string };
					contentChanges?: Array<{ text: string }>;
				};
				wire.push(
					p?.textDocument?.text ?? p?.contentChanges?.at(-1)?.text ?? "",
				);
			},
		);
		const client = {
			serverId: "typescript",
			root: env.tmpDir,
			customServer: false,
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			getAdvertisedCommands: () => [],
			getRawCapabilityKeys: () => [],
			getLaunchVariant: () => undefined,
			diagnosticsVersion: 0,
			getDiagnosticsVersionForPath: vi.fn(() => 0),
			getDiagnostics: vi.fn(() => []),
			getAllDiagnostics: vi.fn(() => new Map()),
			getDiagnosticBinding: vi.fn(() => undefined),
			notify: {
				open: (
					fp: string,
					content: string,
					languageId: string,
					preserveDiagnostics?: boolean,
					silent?: boolean,
					saved?: boolean,
					readStamp?: number,
				) =>
					clientModule.handleNotifyOpen(
						state,
						fp,
						content,
						languageId,
						preserveDiagnostics,
						silent,
						saved,
						readStamp,
					),
				change: vi.fn(async () => {}),
				close: vi.fn(async () => {}),
			},
			pingLiveness: vi.fn().mockResolvedValue(true),
			waitForDiagnostics: vi.fn(async () => {}),
		};
		lsp.getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "typescript",
				extensions: [".ts"],
				root: async () => env.tmpDir,
				spawn: vi.fn(async () => ({ process: {}, source: "test" })),
			},
		]);
		lsp.createLSPClient.mockResolvedValue(client);
		lspState = state;
		lspClient = client;
		service = new LSPService();
		lsp.service = service;
		lsp.drainTouch = Promise.resolve();
		lsp.drainTouchesWaiting = 0;
		lsp.realService = undefined;
		// The queued edit's own pipeline sync of the unformatted bytes.
		await service.touchFile(filePath, "const x=1\n", {
			diagnostics: "none",
			source: "test",
			readStamp: performance.now(),
		});
	});

	afterEach(() => {
		if (lsp.realService) resetLSPService({ reason: "session_shutdown" });
		lsp.realService = undefined;
		lsp.getServersForFileWithConfig.mockReset();
		lsp.createLSPClient.mockReset();
	});

	const disk = () => fs.readFileSync(filePath, "utf8");
	/** The drain's post-exit resync records (latency.log). */

	it("OverlapLsp (#3529): the drain's resync of bytes read before a next-run edit does not replace that edit's newer sync", async () => {
		const drainTouch = gate();
		lsp.drainTouch = drainTouch.p;
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		const agent = agentAppend("const y=2\n", service);
		c.openWrite();
		// The drain read its fileContent inside the hold; the edit lands when
		// the hold is released, and its own sync goes out first.
		await agent.done;
		drainTouch.open();
		await drain;
		expect(disk()).toBe("const x = 1\nconst y=2\n");
		expect(wire.at(-1)).toBe(disk());
	});

	it("OverlapLsp (#3529): the drain's autofix resync of bytes read before a next-run edit does not replace that edit's newer sync", async () => {
		const drainTouch = gate();
		lsp.drainTouch = drainTouch.p;
		const { fixer, resume } = gatedBiome();
		resume.open();
		writeBiomeAgreement();
		runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "autofix");
		flags.add("no-autoformat");
		const drain = handleAgentEnd(
			drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
		);
		// The drain has read the fixed bytes and issued its resync.
		await waitFor(
			() => lsp.drainTouchesWaiting,
			(waiting) => waiting === 1,
			{ yieldControl: tick, timeoutMs: 2_000 },
		);
		const agent = agentAppend("const y=2\n", service);
		await agent.done;
		drainTouch.open();
		await drain;
		expect(disk()).toBe("let x=1\nconst y=2\n");
		expect(wire.at(-1)).toBe(disk());
	});

	it("no-drop (#3529, shape 54): with no newer edit, the drain's stamped autofix resync still sends its fixed bytes", async () => {
		const { fixer, resume } = gatedBiome();
		resume.open();
		writeBiomeAgreement();
		runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "autofix");
		flags.add("no-autoformat");
		await handleAgentEnd(drainDeps({ biomeClient: fixer, ruffClient: noRuff }));
		expect(disk()).toBe("let x=1\n");
		expect(wire.at(-1)).toBe(disk());
	});

	it("no-drop (#3529, shape 54): with no newer edit, the drain's stamped resync still sends its formatted bytes", async () => {
		armChild();
		await handleAgentEnd(drainDeps());
		expect(disk()).toBe("const x = 1\n");
		expect(wire.at(-1)).toBe(disk());
		// A phase that settled inside the bound needs no post-exit resync.
		expect(postExitRows()).toEqual([]);
	});

	it("OrphanLsp (#3529): the child the hook's 10 s bound gave up on is synced after it writes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
		await drain;
		expect(wire.at(-1)).toBe("const x=1\n");
		c.openWrite();
		await c.wrote;
		await waitFor(
			() => wire.at(-1),
			(last) => last === "const x = 1\n",
			{ yieldControl: tick, timeoutMs: 2_000 },
		);
		expect(disk()).toBe("const x = 1\n");
		expect(postExitRows()).toEqual([
			expect.objectContaining({
				filePath,
				metadata: expect.objectContaining({ outcome: "synced" }),
			}),
		]);
		// The wait did not give up, so nothing is chained for a second sync.
		expect(lateRows()).toEqual([]);
	});

	it("OrphanLsp (#3529): the child the writer's own 30 s aggregate gave up on is synced after it writes, not before", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const resolving = gate();
		const resolution = gate();
		child.resolving = resolving.open;
		child.resolved = resolution.p;
		const c = armChild();
		const drain = handleAgentEnd(drainDeps());
		// The service's own bound is armed once the formatter run starts (the
		// hold's queue entry is real I/O); both bounds then give up while the
		// command resolution is in flight.
		await resolving.p;
		await vi.advanceTimersByTimeAsync(30_000);
		await drain;
		resolution.open();
		await c.wrote;
		await waitFor(
			() => wire.at(-1),
			(last) => last === "const x = 1\n",
			{ yieldControl: tick, timeoutMs: 2_000 },
		);
		expect(disk()).toBe("const x = 1\n");
		expect(postExitRows()).toEqual([
			expect.objectContaining({
				filePath,
				metadata: expect.objectContaining({ outcome: "synced" }),
			}),
		]);
	});

	it("OrphanLsp (#3529): the post-exit resync of a read taken before a next-run edit does not replace that edit's newer sync", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const drainTouch = gate();
		lsp.drainTouch = drainTouch.p;
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
		await drain;
		// Another queued mutation of F holds the queue past the child's exit,
		// so the post-exit read is taken before the next-run edit lands.
		const other = gate();
		const holder = withFileMutationQueue(filePath, () => other.p);
		const agent = agentAppend("const y=2\n", service);
		c.openWrite();
		await waitFor(
			() => lsp.drainTouchesWaiting,
			(waiting) => waiting === 1,
			{ yieldControl: tick, timeoutMs: 2_000 },
		);
		other.open();
		await holder;
		await agent.done;
		drainTouch.open();
		await waitFor(postExitRows, (rows) => rows.length > 0, {
			yieldControl: tick,
			timeoutMs: 2_000,
		});
		expect(disk()).toBe("const x = 1\nconst y=2\n");
		expect(wire.at(-1)).toBe(disk());
		// #3528 r2: the queue dropped the older read, so the row does not say synced.
		expect(postExitRows()).toEqual([
			expect.objectContaining({ metadata: { outcome: "superseded" } }),
		]);
	});

	it("the post-exit row says not-sent when the language server could not start (#3528 r2)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		lsp.realService = getLSPService;
		resetLSPService({ reason: "session_shutdown" });
		lsp.createLSPClient.mockRejectedValue(new Error("spawn failed"));
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
		await drain;
		c.openWrite();
		await c.wrote;
		await postExitSettled();
		expect(postExitRows()).toEqual([
			expect.objectContaining({ metadata: { outcome: "not-sent" } }),
		]);
	});

	describe("a drain whose session was replaced touches no language server (#3528 r1 F1)", () => {
		/**
		 * `/new` or quit while the drain runs: session_start / session_shutdown
		 * bump the generation and retire the LSP service, so the next
		 * `getLSPService()` builds a fresh one and a touch spawns its server.
		 */
		function replaceSession(): number {
			runtime.resetForSession(Date.now());
			resetLSPService({ reason: "session_shutdown" });
			return lsp.createLSPClient.mock.calls.length;
		}

		it("the post-exit resync is skipped and recorded as stale-session", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			lsp.realService = getLSPService;
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
			await drain;
			const spawnsBefore = replaceSession();
			c.openWrite();
			await c.wrote;
			await waitFor(postExitRows, (rows) => rows.length > 0, {
				yieldControl: tick,
				timeoutMs: 2_000,
			});
			expect(lsp.createLSPClient.mock.calls.length - spawnsBefore).toBe(0);
			expect(postExitRows()).toEqual([
				expect.objectContaining({
					metadata: { outcome: "stale-session" },
				}),
			]);
			expect(staleWriteSubjects()).toContain(`runtime-session:${filePath}`);
		});

		it("no-drop: in its own session the post-exit resync runs and spawns the server", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			lsp.realService = getLSPService;
			resetLSPService({ reason: "session_shutdown" });
			const spawnsBefore = lsp.createLSPClient.mock.calls.length;
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
			await drain;
			c.openWrite();
			await c.wrote;
			await waitFor(postExitRows, (rows) => rows.length > 0, {
				yieldControl: tick,
				timeoutMs: 2_000,
			});
			expect(lsp.createLSPClient.mock.calls.length - spawnsBefore).toBe(1);
			expect(postExitRows()).toEqual([
				expect.objectContaining({ metadata: { outcome: "synced" } }),
			]);
		});

		it("the in-hook format resync is skipped", async () => {
			lsp.realService = getLSPService;
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			const spawnsBefore = replaceSession();
			c.openWrite();
			await drain;
			expect(fs.readFileSync(filePath, "utf8")).toBe("const x = 1\n");
			expect(lsp.createLSPClient.mock.calls.length - spawnsBefore).toBe(0);
		});

		it("the in-hook autofix resync is skipped", async () => {
			lsp.realService = getLSPService;
			const { fixer, parked, resume } = gatedBiome();
			writeBiomeAgreement();
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			flags.add("no-autoformat");
			const drain = handleAgentEnd(
				drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
			);
			await parked.p;
			const spawnsBefore = replaceSession();
			resume.open();
			await drain;
			expect(fs.readFileSync(filePath, "utf8")).toBe("let x=1\n");
			expect(lsp.createLSPClient.mock.calls.length - spawnsBefore).toBe(0);
		});
	});

	// #3576: FixNoServiceGen (a retire without a session bump) and
	// FixNoHeldResync (R1) are the TLC configs these cases replay.
	describe("#3576: a drain after a session end or an LSP retire", () => {
		const spawns = () => lsp.createLSPClient.mock.calls.length;
		/** The drain's `actionable_warnings_autofix` latency rows. */
		const quickfixRows = () =>
			logLatency.mock.calls
				.map(([row]) => row as { phase?: string; metadata?: unknown })
				.filter((row) => row.phase === "actionable_warnings_autofix");
		/**
		 * A fresh actionable-warnings report with one quickfix-eligible warning
		 * on another file, current at `projectSeqEnd`.
		 */
		function writeQuickfixReport(projectSeqEnd: number): string {
			const target = path.join(env.tmpDir, "g.ts");
			fs.writeFileSync(target, "let y=1\n");
			const warning = {
				id: "prettier:quickfix",
				filePath: target,
				displayPath: "g.ts",
				line: 1,
				column: 1,
				severity: "warning" as const,
				tool: "prettier",
				message: "quickfix-eligible warning",
				actions: [
					{
						title: "Fix it",
						hasEdit: true,
						hasCommand: false,
						autoFixEligible: true,
					},
				],
				suppressed: false,
			};
			cacheManager.writeCache(
				"actionable-warnings",
				{
					generatedAt: new Date().toISOString(),
					scope: "turn_delta",
					sessionId: "s1",
					turnIndex: 1,
					projectSeqEnd,
					deltaOnly: true,
					includeLspCodeActions: true,
					files: [
						{ filePath: target, displayPath: "g.ts", warnings: [warning] },
					],
					summary: {
						warnings: 1,
						unsuppressed: 1,
						suppressed: 0,
						files: 1,
						actions: 1,
						autoFixEligible: 1,
					},
				},
				env.tmpDir,
			);
			flags.add("lens-actionable-warnings");
			flags.add("lens-actionable-warning-autofix");
			return target;
		}

		it("the actionable-warnings quickfix pass does not start after /new", async () => {
			lsp.realService = getLSPService;
			// Session 2's project sequence restarts at 0.
			writeQuickfixReport(0);
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			runtime.resetForSession(Date.now());
			resetLSPService({ reason: "session_start" });
			const spawnsBefore = spawns();
			c.openWrite();
			await drain;
			expect(spawns() - spawnsBefore).toBe(0);
			expect(quickfixRows()).toEqual([]);
		});

		it("the actionable-warnings quickfix pass does not start after a /new that left the LSP service in place", async () => {
			// session_start retires the service only without --no-lsp; the pass's
			// edits and bookkeeping belong to the drain's session either way.
			lsp.realService = getLSPService;
			writeQuickfixReport(0);
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			runtime.resetForSession(Date.now());
			const spawnsBefore = spawns();
			c.openWrite();
			await drain;
			expect(spawns() - spawnsBefore).toBe(0);
			expect(quickfixRows()).toEqual([]);
			expect(staleWriteSubjects()).toContain(
				`runtime-session:actionable-warnings:${env.tmpDir}`,
			);
		});

		it("the actionable-warnings quickfix pass does not start after session_shutdown retired the LSP service", async () => {
			lsp.realService = getLSPService;
			// The session is not bumped: the drain's own format still records.
			writeQuickfixReport(1);
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			resetLSPService({ reason: "session_shutdown" });
			const spawnsBefore = spawns();
			c.openWrite();
			await drain;
			expect(spawns() - spawnsBefore).toBe(0);
			expect(quickfixRows()).toEqual([]);
		});

		it("no-drop: in its own session the quickfix pass runs", async () => {
			lsp.realService = getLSPService;
			// The drain's own format bumps the project sequence to 1.
			writeQuickfixReport(1);
			const c = armChild({ write: false });
			await handleAgentEnd(drainDeps());
			await c.wrote;
			expect(quickfixRows()).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ considered: 1 }),
				}),
			]);
		});

		it("the in-hook format resync spawns no server after session_shutdown retired the service", async () => {
			lsp.realService = getLSPService;
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			// Quit: the service is retired, the runtime session is not bumped.
			resetLSPService({ reason: "session_shutdown" });
			const spawnsBefore = spawns();
			c.openWrite();
			await drain;
			expect(fs.readFileSync(filePath, "utf8")).toBe("const x = 1\n");
			expect(spawns() - spawnsBefore).toBe(0);
			expect(staleWriteSubjects()).toContain(
				`lsp-launch-availability:${filePath}`,
			);
		});

		it("the in-hook autofix resync spawns no server after session_shutdown retired the service", async () => {
			lsp.realService = getLSPService;
			const { fixer, parked, resume } = gatedBiome();
			writeBiomeAgreement();
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			flags.add("no-autoformat");
			const drain = handleAgentEnd(
				drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
			);
			await parked.p;
			resetLSPService({ reason: "session_shutdown" });
			const spawnsBefore = spawns();
			resume.open();
			await drain;
			expect(fs.readFileSync(filePath, "utf8")).toBe("let x=1\n");
			expect(spawns() - spawnsBefore).toBe(0);
		});

		it("the post-exit resync spawns no server after the idle reset retired the service", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			lsp.realService = getLSPService;
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
			await drain;
			resetLSPService({ reason: "idle" });
			const spawnsBefore = spawns();
			c.openWrite();
			await c.wrote;
			await postExitSettled();
			expect(spawns() - spawnsBefore).toBe(0);
			expect(postExitRows()).toEqual([
				expect.objectContaining({ metadata: { outcome: "stale-session" } }),
			]);
		});

		it("R1: a replaced session's format resyncs the next session's open document to the bytes on disk, without a spawn", async () => {
			lsp.realService = getLSPService;
			lspClient.isDocumentOpen = (fp: string) =>
				lspState.openDocuments.has(normalizeMapKey(fp));
			const c = armChild({ write: true });
			const drain = handleAgentEnd(drainDeps());
			await c.didRead;
			runtime.resetForSession(Date.now());
			resetLSPService({ reason: "session_start" });
			// Session 2's read-warm touch opens F (runtime-tool-call.ts), outside
			// pi's queue, before the child writes.
			const spawnsBefore = spawns();
			await getLSPService().touchFile(filePath, disk(), {
				diagnostics: "none",
				source: "read-warm",
				readStamp: performance.now(),
			});
			expect(spawns() - spawnsBefore).toBe(1);
			c.openWrite();
			await drain;
			expect(disk()).toBe("const x = 1\n");
			expect(wire.at(-1)).toBe(disk());
			expect(spawns() - spawnsBefore).toBe(1);
		});
	});

	it("the post-exit row names resyncLspFile's early return, not synced (#3528 r1 F1)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		flags.add("no-lsp");
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
		await drain;
		c.openWrite();
		await c.wrote;
		await waitFor(postExitRows, (rows) => rows.length > 0, {
			yieldControl: tick,
			timeoutMs: 2_000,
		});
		expect(postExitRows()).toEqual([
			expect.objectContaining({ metadata: { outcome: "no-lsp" } }),
		]);
	});

	it("the post-exit resync of a file the child removed records the failure instead of rejecting (#3529)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		child.removeAfterWrite = true;
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
		await drain;
		c.openWrite();
		await c.wrote;
		await waitFor(postExitRows, (rows) => rows.length > 0, {
			yieldControl: tick,
			timeoutMs: 2_000,
		});
		expect(postExitRows()).toEqual([
			expect.objectContaining({
				filePath,
				metadata: expect.objectContaining({ outcome: "read-failed" }),
			}),
		]);
	});

	/**
	 * #3828 (`formal/format-drain` `OrphanNoLateSync`, `FixNoLateSync`; the
	 * merged-fix configs `OrphanLsp` and `Fix`): #3728 bounded the post-exit
	 * wait and, on expiry, never synced again, so a formatter that writes
	 * after the bound left the LSP document behind the disk. The wait gives up
	 * on a formatter whose command resolution (an auto-install) outlives the
	 * hook's 10 s bound, the writer's own 30 s aggregate and the wait's 30 s
	 * budget; the child then runs and writes.
	 */
	describe("#3828: a formatter that writes after the post-exit wait gave up", () => {
		async function giveUpBeforeTheChildRuns() {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const resolving = gate();
			const resolution = gate();
			child.resolving = resolving.open;
			child.resolved = resolution.p;
			const c = armChild();
			const drain = handleAgentEnd(drainDeps());
			await resolving.p;
			await vi.advanceTimersByTimeAsync(
				HOOK_WALL_BUDGET_MS.agent_settled + 30_000 + 1,
			);
			await drain;
			await postExitSettled();
			return { c, install: resolution.open };
		}
		const lateSettled = () =>
			waitFor(lateRows, (rows) => rows.length > 0, {
				yieldControl: tick,
				timeoutMs: 2_000,
			});
		const spawns = () => lsp.createLSPClient.mock.calls.length;
		/** `/new`: the session bump and the service retire `session_start` runs. */
		function newSession() {
			runtime.resetForSession(Date.now());
			resetLSPService({ reason: "session_start" });
		}
		/**
		 * The drain is served the real `getLSPService()` singleton, and a read-warm
		 * touch of the unformatted F leaves a live client of it holding F: the
		 * one document the late resync may bring to the disk.
		 */
		async function currentServiceHoldsF() {
			lsp.realService = getLSPService;
			lspClient.isDocumentOpen = (fp: string) =>
				lspState.openDocuments.has(normalizeMapKey(fp));
			await getLSPService().touchFile(filePath, "const x=1\n", {
				diagnostics: "none",
				source: "read-warm",
				readStamp: performance.now(),
			});
		}

		it("OrphanGiveUp (#3828): the LSP document equals the disk once the child settles", async () => {
			await currentServiceHoldsF();
			const { c, install } = await giveUpBeforeTheChildRuns();
			// The wait gave up: one abandoned row, and the LSP still has the bytes
			// from before the format.
			expect(postExitRows()).toEqual([
				expect.objectContaining({ metadata: { outcome: "abandoned" } }),
			]);
			expect(wire.at(-1)).toBe("const x=1\n");
			install();
			await c.wrote;
			expect(disk()).toBe("const x = 1\n");
			await waitFor(
				() => wire.at(-1),
				(last) => last === disk(),
				{ yieldControl: tick, timeoutMs: 2_000 },
			);
			await lateSettled();
			expect(lateRows()).toEqual([
				expect.objectContaining({
					filePath,
					metadata: { outcome: "resynced" },
				}),
			]);
			// The give-up row stays the only post-exit row: nothing re-reported it.
			expect(postExitRows()).toHaveLength(1);
			// `hook-await-exceeded` is still recorded once, at the give-up.
			expect(postExitResyncSubjects()).toEqual([
				"off_hook:deferred-format-post-exit-resync",
			]);
		});

		it("OrphanGiveUp (#3828): an Escape that ends the wait early, with no ledger record, still chains the late resync", async () => {
			await currentServiceHoldsF();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const controller = new AbortController();
			const resolving = gate();
			const resolution = gate();
			child.resolving = resolving.open;
			child.resolved = resolution.p;
			const c = armChild();
			const drain = handleAgentEnd(drainDeps({ signal: controller.signal }));
			await resolving.p;
			// Only the hook's 10 s bound has fired; the post-exit wait is still
			// inside its 30 s budget when the user presses Escape.
			await vi.advanceTimersByTimeAsync(HOOK_WALL_BUDGET_MS.agent_settled + 1);
			await drain;
			controller.abort();
			await postExitSettled();
			expect(postExitRows()).toEqual([
				expect.objectContaining({ metadata: { outcome: "abandoned" } }),
			]);
			// A cancel is deliberate, not a degradation: `bounded()` records nothing.
			expect(postExitResyncSubjects()).toEqual([]);
			resolution.open();
			await c.wrote;
			await waitFor(
				() => wire.at(-1),
				(last) => last === disk(),
				{ yieldControl: tick, timeoutMs: 2_000 },
			);
			await lateSettled();
			expect(disk()).toBe("const x = 1\n");
		});

		it("OrphanGiveUp (#3828 r2 F1): in the current session, a file no live client holds is neither opened nor spawned for", async () => {
			// The session and the service are both current, and the service holds
			// nothing: the client was idle-evicted during the install, or F was
			// never opened in it. `service` (the harness's own) holds F; the
			// drain's real singleton was never built, so the row is `no-service`
			// (#3828 r3: the live-service case is `late, not held, same session`).
			lsp.realService = getLSPService;
			const { c, install } = await giveUpBeforeTheChildRuns();
			const spawnsBefore = spawns();
			const wireBefore = wire.length;
			install();
			await c.wrote;
			await lateSettled();
			expect(disk()).toBe("const x = 1\n");
			expect(spawns() - spawnsBefore).toBe(0);
			expect(wire.length).toBe(wireBefore);
			expect(lateRows()).toEqual([
				expect.objectContaining({ metadata: { outcome: "no-service" } }),
			]);
		});

		it("OrphanGiveUp (#3828 r2 F3): another turn's aborted signal at the settle does not stop the late sync", async () => {
			await currentServiceHoldsF();
			const { c, install } = await giveUpBeforeTheChildRuns();
			// A later turn is running when the formatter settles, and the user
			// has pressed Escape in it: the ambient signal is that turn's.
			const foreign = new AbortController();
			foreign.abort();
			setAmbientAbortSignal(foreign.signal);
			install();
			await c.wrote;
			await lateSettled();
			expect(disk()).toBe("const x = 1\n");
			expect(wire.at(-1)).toBe(disk());
		});

		it("OrphanGiveUp (#3828): after session_shutdown retired the service the late resync spawns no server", async () => {
			await currentServiceHoldsF();
			const { c, install } = await giveUpBeforeTheChildRuns();
			resetLSPService({ reason: "session_shutdown" });
			const spawnsBefore = spawns();
			install();
			await c.wrote;
			await lateSettled();
			expect(spawns() - spawnsBefore).toBe(0);
			expect(lateRows()).toEqual([
				expect.objectContaining({ metadata: { outcome: "no-service" } }),
			]);
		});

		it("OrphanGiveUp (#3828): after /new the late resync spawns no server", async () => {
			lsp.realService = getLSPService;
			const { c, install } = await giveUpBeforeTheChildRuns();
			newSession();
			const spawnsBefore = spawns();
			install();
			await c.wrote;
			await lateSettled();
			expect(spawns() - spawnsBefore).toBe(0);
			expect(lateRows()).toEqual([
				expect.objectContaining({ metadata: { outcome: "no-service" } }),
			]);
		});

		it("OrphanGiveUp (#3828, #3576 R1): after /new the late resync brings only a document the next session already holds to the bytes on disk, without a spawn", async () => {
			lsp.realService = getLSPService;
			lspClient.isDocumentOpen = (fp: string) =>
				lspState.openDocuments.has(normalizeMapKey(fp));
			const { c, install } = await giveUpBeforeTheChildRuns();
			newSession();
			// Session 2's read-warm touch opens F before the child writes.
			const spawnsBefore = spawns();
			await getLSPService().touchFile(filePath, disk(), {
				diagnostics: "none",
				source: "read-warm",
				readStamp: performance.now(),
			});
			expect(spawns() - spawnsBefore).toBe(1);
			install();
			await c.wrote;
			await lateSettled();
			expect(disk()).toBe("const x = 1\n");
			expect(wire.at(-1)).toBe(disk());
			expect(spawns() - spawnsBefore).toBe(1);
		});

		it("OrphanGiveUp (#3828 r2 F2): a file the child removed is a quiet late resync: no crash row, no rejection", async () => {
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => rejections.push(reason);
			process.on("unhandledRejection", onRejection);
			try {
				await currentServiceHoldsF();
				child.removeAfterWrite = true;
				const { c, install } = await giveUpBeforeTheChildRuns();
				install();
				await c.wrote;
				expect(fs.existsSync(filePath)).toBe(false);
				// Either the row lands or, without a catch, a rejection does;
				// unhandled rejections surface after the microtask queue drains.
				await waitFor(
					() => rejections.length + lateRows().length,
					(count) => count > 0,
					{ yieldControl: tick, timeoutMs: 2_000 },
				);
				await tick();
				await tick();
				expect(rejections).toEqual([]);
				// An ordinary event (F removed during a long install), not a crash.
				expect(
					getDegradationSummary().filter(
						(group) => group.kind === "hook-handler-crash",
					),
				).toEqual([]);
				expect(lateRows()).toEqual([
					expect.objectContaining({ metadata: { outcome: "vanished" } }),
				]);
			} finally {
				process.off("unhandledRejection", onRejection);
			}
		});

		it("OrphanGiveUp (#3828 r2 F2): any other throw in the late resync is one hook-handler-crash row and a failed late row, and rejects nothing", async () => {
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => rejections.push(reason);
			process.on("unhandledRejection", onRejection);
			try {
				await currentServiceHoldsF();
				// The real service's held-only resync fails (a server root that
				// cannot be resolved, say): nothing awaits the continuation.
				vi.spyOn(getLSPService(), "resyncGitChangedFiles").mockRejectedValue(
					new Error("root resolution failed"),
				);
				const { c, install } = await giveUpBeforeTheChildRuns();
				install();
				await c.wrote;
				await lateSettled();
				await tick();
				await tick();
				expect(rejections).toEqual([]);
				expect(lateRows()).toEqual([
					expect.objectContaining({ metadata: { outcome: "failed" } }),
				]);
				expect(
					getDegradationSummary()
						.filter((group) => group.kind === "hook-handler-crash")
						.flatMap((group) => group.latestReasons.map((r) => r.subject)),
				).toEqual(["deferred-format-late-resync"]);
			} finally {
				process.off("unhandledRejection", onRejection);
			}
		});

		/**
		 * #3828 r3: the whole state space, {settled, late} x {held, not held,
		 * vanished} x {same session, /new, session_shutdown, idle reset}, one
		 * case per cell with the wire, spawn, `saved` and row it must produce.
		 * Recurrences: VERIFY r2 F6 (the late resync, and #3576 R1's held-only
		 * branch of `syncDrainWrite`, synced the bytes without the didSave a
		 * save-triggered server recompiles on, #3405) and F7 (the late row read
		 * `held-only` whether it synced F or did nothing). The r2 cases asserted
		 * `wire.at(-1) === disk()` only, which sees neither.
		 *
		 * `held`: a live client of the service current at the settle holds F (the
		 * successor's, after a retire). `not held`: in the same session the
		 * service holds a sibling file but not F; after a retire no successor was
		 * built. `vanished`: held, and the child removes F after its write.
		 */
		const STATE_SPACE: ReadonlyArray<{
			cell: string;
			wire: "disk" | "none";
			spawn: number;
			saved: boolean[];
			didSave: number;
			row: string;
		}> = [
			{
				cell: "settled, held, same session",
				wire: "disk",
				spawn: 0,
				saved: [true],
				didSave: 1,
				row: "synced",
			},
			{
				cell: "settled, not held, same session",
				wire: "disk",
				spawn: 0,
				saved: [true],
				didSave: 1,
				row: "synced",
			},
			{
				cell: "settled, vanished, same session",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "read-failed",
			},
			{
				cell: "settled, held, /new",
				wire: "disk",
				spawn: 0,
				saved: [true],
				didSave: 1,
				row: "stale-session",
			},
			{
				cell: "settled, not held, /new",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "stale-session",
			},
			{
				cell: "settled, vanished, /new",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "stale-session",
			},
			{
				cell: "settled, held, session_shutdown",
				wire: "disk",
				spawn: 0,
				saved: [true],
				didSave: 1,
				row: "stale-session",
			},
			{
				cell: "settled, not held, session_shutdown",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "stale-session",
			},
			{
				cell: "settled, vanished, session_shutdown",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "stale-session",
			},
			{
				cell: "settled, held, idle reset",
				wire: "disk",
				spawn: 0,
				saved: [true],
				didSave: 1,
				row: "stale-session",
			},
			{
				cell: "settled, not held, idle reset",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "stale-session",
			},
			{
				cell: "settled, vanished, idle reset",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "stale-session",
			},
			{
				cell: "late, held, same session",
				wire: "disk",
				spawn: 0,
				saved: [true],
				didSave: 1,
				row: "resynced",
			},
			{
				cell: "late, not held, same session",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "unheld",
			},
			{
				cell: "late, vanished, same session",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "vanished",
			},
			{
				cell: "late, held, /new",
				wire: "disk",
				spawn: 0,
				saved: [true],
				didSave: 1,
				row: "resynced",
			},
			{
				cell: "late, not held, /new",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "no-service",
			},
			{
				cell: "late, vanished, /new",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "vanished",
			},
			{
				cell: "late, held, session_shutdown",
				wire: "disk",
				spawn: 0,
				saved: [true],
				didSave: 1,
				row: "resynced",
			},
			{
				cell: "late, not held, session_shutdown",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "no-service",
			},
			{
				cell: "late, vanished, session_shutdown",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "vanished",
			},
			{
				cell: "late, held, idle reset",
				wire: "disk",
				spawn: 0,
				saved: [true],
				didSave: 1,
				row: "resynced",
			},
			{
				cell: "late, not held, idle reset",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "no-service",
			},
			{
				cell: "late, vanished, idle reset",
				wire: "none",
				spawn: 0,
				saved: [],
				didSave: 0,
				row: "vanished",
			},
		];

		it.each(STATE_SPACE)("state space (#3828 r3): $cell", async (expected) => {
			const [settle, held, session] = expected.cell.split(", ");
			lsp.realService = getLSPService;
			lspClient.isDocumentOpen = (fp: string) =>
				lspState.openDocuments.has(normalizeMapKey(fp));
			// A save-triggered server: it declared `textDocumentSync.save`.
			lspState.saveOptions = { includeText: false };
			const didSaves: string[] = [];
			const send = vi.mocked(lspState.connection.sendNotification);
			const wireOf = send.getMockImplementation();
			send.mockImplementation(async (method: string, params: unknown) => {
				if (method === "textDocument/didSave") {
					didSaves.push(
						String(
							(params as { textDocument: { uri: string } }).textDocument.uri,
						),
					);
				}
				return wireOf?.(method, params);
			});
			const notify = lspClient.notify as {
				open: (...args: unknown[]) => Promise<unknown>;
			};
			const opens = vi.spyOn(notify, "open");
			const readWarm = (target: string, content: string) =>
				getLSPService().touchFile(target, content, {
					diagnostics: "none",
					source: "read-warm",
					readStamp: performance.now(),
				});
			if (session === "same session") {
				if (held === "not held") {
					// The harness's own `service` opened F on this shared mock
					// client in `beforeEach`; the singleton's client must not.
					lspState.openDocuments.delete(normalizeMapKey(filePath));
					const sibling = path.join(env.tmpDir, "g.ts");
					fs.writeFileSync(sibling, "let y=1\n");
					await readWarm(sibling, "let y=1\n");
				} else {
					await readWarm(filePath, disk());
				}
			}
			if (held === "vanished") child.removeAfterWrite = true;

			let write: () => void;
			let wrote: Promise<void>;
			if (settle === "settled") {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				const c = armChild({ write: true });
				const drain = handleAgentEnd(drainDeps());
				await c.didRead;
				await vi.advanceTimersByTimeAsync(
					HOOK_WALL_BUDGET_MS.agent_settled + 1,
				);
				await drain;
				write = c.openWrite;
				wrote = c.wrote;
			} else {
				const { c, install } = await giveUpBeforeTheChildRuns();
				write = install;
				wrote = c.wrote;
			}
			if (session === "/new") newSession();
			else if (session === "session_shutdown")
				resetLSPService({ reason: "session_shutdown" });
			else if (session === "idle reset") resetLSPService({ reason: "idle" });
			if (session !== "same session" && held !== "not held") {
				await readWarm(filePath, disk());
			}

			const spawnsBefore = spawns();
			const wireBefore = wire.length;
			const opensBefore = opens.mock.calls.length;
			const didSavesBefore = didSaves.length;
			write();
			await wrote;
			if (settle === "settled") await postExitSettled();
			else await lateSettled();

			expect(fs.existsSync(filePath)).toBe(held !== "vanished");
			if (expected.wire === "disk") {
				expect(wire.slice(wireBefore).at(-1)).toBe("const x = 1\n");
			} else {
				expect(wire.slice(wireBefore)).toEqual([]);
			}
			expect(spawns() - spawnsBefore).toBe(expected.spawn);
			expect(
				opens.mock.calls
					.slice(opensBefore)
					.filter(
						([fp]) => normalizeMapKey(String(fp)) === normalizeMapKey(filePath),
					)
					.map((call) => call[5]),
			).toEqual(expected.saved);
			expect(didSaves.length - didSavesBefore).toBe(expected.didSave);
			if (settle === "settled") {
				expect(postExitRows()).toEqual([
					expect.objectContaining({ metadata: { outcome: expected.row } }),
				]);
			} else {
				expect(postExitRows()).toEqual([
					expect.objectContaining({ metadata: { outcome: "abandoned" } }),
				]);
				expect(lateRows()).toEqual([
					expect.objectContaining({
						filePath,
						metadata: { outcome: expected.row },
					}),
				]);
			}
		});
	});

	describe("#3858: a formatter the in-band (--immediate-format) budget gave up on", () => {
		/**
		 * The in-band pipeline (`runPipeline`, the tool_result path) formats
		 * with `HOOK_WALL_BUDGET_MS.tool_result_edit`, then reads F and syncs
		 * those bytes to the LSP and moves on while the abandoned child runs on
		 * and writes later. Recurrence: #3828's stale LSP document, on the other
		 * caller of `runFormatPhase`. TLC: `InBandLsp` and `FixInBand` (pass),
		 * `InBandNoLateSync` and `FixInBandNoLateSync` (violate `LspMatchesDisk`).
		 */
		const inBandRows = () =>
			logLatency.mock.calls
				.map(([row]) => row as { phase?: string; metadata?: unknown })
				.filter((row) => row.phase === "inband_format_late_resync");
		const inBandSettled = () =>
			waitFor(inBandRows, (rows) => rows.length > 0, {
				yieldControl: tick,
				timeoutMs: 2_000,
			});
		const spawns = () => lsp.createLSPClient.mock.calls.length;

		beforeEach(() => {
			flags.add("immediate-format");
			// The pipeline's own sync and the late resync both go to the real
			// singleton; its client holds F once the pipeline has synced it.
			lsp.realService = getLSPService;
			lspClient.isDocumentOpen = (fp: string) =>
				lspState.openDocuments.has(normalizeMapKey(fp));
		});

		function runInBand(signal?: AbortSignal) {
			return runPipeline(
				{
					filePath,
					cwd: env.tmpDir,
					toolName: "edit",
					autofixMode: "deferred",
					getFlag: (name: string) => flags.has(name),
					dbg: () => {},
					...(signal ? { signal } : {}),
				},
				{
					biomeClient: {} as never,
					ruffClient: {} as never,
					metricsClient: {} as never,
					getFormatService: () => new FormatService("format-drain", true),
					fixedThisTurn: new Set<string>(),
				} as PipelineDeps,
			);
		}

		/** The budget fires while the formatter still resolves its command. */
		async function giveUpInBand() {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const resolving = gate();
			const resolution = gate();
			child.resolving = resolving.open;
			child.resolved = resolution.p;
			const c = armChild();
			const run = runInBand();
			await resolving.p;
			await vi.advanceTimersByTimeAsync(
				HOOK_WALL_BUDGET_MS.tool_result_edit + 1,
			);
			await run;
			return { c, install: resolution.open };
		}

		it("OrphanGiveUp (#3858): the LSP document equals the disk once the formatter the budget gave up on writes", async () => {
			const { c, install } = await giveUpInBand();
			// The pipeline moved on and synced the bytes from before the format.
			expect(wire.at(-1)).toBe("const x=1\n");
			const spawnsBefore = spawns();
			install();
			await c.wrote;
			expect(disk()).toBe("const x = 1\n");
			await waitFor(
				() => wire.at(-1),
				(last) => last === disk(),
				{ yieldControl: tick, timeoutMs: 2_000 },
			);
			await inBandSettled();
			expect(spawns() - spawnsBefore).toBe(0);
			expect(inBandRows()).toEqual([
				expect.objectContaining({
					filePath,
					metadata: { outcome: "resynced" },
				}),
			]);
		});

		it("OrphanGiveUp (#3858): an Escape that ends the formatter's wait still chains the late resync", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const controller = new AbortController();
			const resolving = gate();
			const resolution = gate();
			child.resolving = resolving.open;
			child.resolved = resolution.p;
			const c = armChild();
			const run = runInBand(controller.signal);
			await resolving.p;
			controller.abort();
			await run;
			// An Escape is not a degradation, and the child is still alive.
			expect(wire.at(-1)).toBe("const x=1\n");
			resolution.open();
			await c.wrote;
			await waitFor(
				() => wire.at(-1),
				(last) => last === disk(),
				{ yieldControl: tick, timeoutMs: 2_000 },
			);
			await inBandSettled();
			expect(disk()).toBe("const x = 1\n");
		});

		it("OrphanGiveUp (#3858): a formatter that never settles leaves the LSP as the pipeline synced it, with no row, frame or spawn", async () => {
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => rejections.push(reason);
			process.on("unhandledRejection", onRejection);
			try {
				await giveUpInBand();
				const spawnsBefore = spawns();
				const wireBefore = wire.length;
				// A wedged install has no leaf bound: nothing wakes the continuation.
				await vi.advanceTimersByTimeAsync(10 * 60_000);
				await tick();
				await tick();
				expect(inBandRows()).toEqual([]);
				expect(wire.length).toBe(wireBefore);
				expect(spawns() - spawnsBefore).toBe(0);
				expect(rejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", onRejection);
			}
		});

		it("OrphanGiveUp (#3858): another turn's aborted signal at the settle does not stop the late sync", async () => {
			const { c, install } = await giveUpInBand();
			// A later turn is running when the formatter settles, and the user has
			// pressed Escape in it: the ambient signal is that turn's.
			const foreign = new AbortController();
			foreign.abort();
			setAmbientAbortSignal(foreign.signal);
			install();
			await c.wrote;
			await inBandSettled();
			expect(disk()).toBe("const x = 1\n");
			expect(wire.at(-1)).toBe(disk());
		});

		it("OrphanGiveUp (#3858): a throw in the late resync is one hook-handler-crash row and a failed late row, and rejects nothing", async () => {
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => rejections.push(reason);
			process.on("unhandledRejection", onRejection);
			try {
				const { c, install } = await giveUpInBand();
				// The held-only resync fails (a server root that cannot be
				// resolved, say): nothing awaits the continuation.
				vi.spyOn(getLSPService(), "resyncGitChangedFiles").mockRejectedValue(
					new Error("root resolution failed"),
				);
				install();
				await c.wrote;
				await inBandSettled();
				await tick();
				await tick();
				expect(rejections).toEqual([]);
				expect(inBandRows()).toEqual([
					expect.objectContaining({ metadata: { outcome: "failed" } }),
				]);
				expect(
					getDegradationSummary()
						.filter((group) => group.kind === "hook-handler-crash")
						.flatMap((group) => group.latestReasons.map((r) => r.subject)),
				).toEqual(["inband-format-late-resync"]);
			} finally {
				process.off("unhandledRejection", onRejection);
			}
		});

		it("a formatter the budget did not abandon chains no late resync", async () => {
			// Recurrence guard: `FormatSummary.abandoned` was always present, so
			// chaining on its presence would resync (and send a save) after every
			// in-band format, not only after a late write.
			const c = armChild();
			await runInBand();
			await c.wrote;
			await tick();
			await tick();
			expect(disk()).toBe("const x = 1\n");
			expect(wire.at(-1)).toBe(disk());
			expect(inBandRows()).toEqual([]);
		});

		/**
		 * The state space (#3858): {settled in budget, abandoned then late write}
		 * x {F held, not held, vanished} x {same session, /new, session_shutdown,
		 * idle reset}. `settled in budget` has no boundary to cross (the pipeline
		 * runs inside one tool_result), so it is one cell per F state. The late
		 * cells are #3828's, on this caller; the expectations are derived from
		 * the contract (held-only, a save, a row naming what happened to F), not
		 * from the code under test. Recurrence: the #3828 r2 F6 shape (a resync
		 * that matches the disk and sends no didSave, which a save-triggered
		 * server needs, #3405) and F7 (a row that cannot tell a sync from a
		 * no-op), which `wire.at(-1) === disk()` alone sees neither.
		 *
		 * `held`: a live client of the service current at the settle holds F (the
		 * successor's, after a retire). `not held`: the live service's client
		 * dropped F (idle eviction, a close); after a retire no successor was
		 * built. `vanished`: held, and the child removes F after its write.
		 */
		const IN_BAND_STATE_SPACE: ReadonlyArray<{
			cell: string;
			wire: "disk" | "none";
			saved: boolean[];
			didSave: number;
			rows: string[];
		}> = [
			{
				cell: "settled, held, same session",
				wire: "disk",
				saved: [true],
				didSave: 1,
				rows: [],
			},
			{
				cell: "late, held, same session",
				wire: "disk",
				saved: [true],
				didSave: 1,
				rows: ["resynced"],
			},
			{
				cell: "late, held, /new",
				wire: "disk",
				saved: [true],
				didSave: 1,
				rows: ["resynced"],
			},
			{
				cell: "late, held, session_shutdown",
				wire: "disk",
				saved: [true],
				didSave: 1,
				rows: ["resynced"],
			},
			{
				cell: "late, held, idle reset",
				wire: "disk",
				saved: [true],
				didSave: 1,
				rows: ["resynced"],
			},
			{
				cell: "late, not held, same session",
				wire: "none",
				saved: [],
				didSave: 0,
				rows: ["unheld"],
			},
			{
				cell: "late, not held, /new",
				wire: "none",
				saved: [],
				didSave: 0,
				rows: ["no-service"],
			},
			{
				cell: "late, not held, session_shutdown",
				wire: "none",
				saved: [],
				didSave: 0,
				rows: ["no-service"],
			},
			{
				cell: "late, not held, idle reset",
				wire: "none",
				saved: [],
				didSave: 0,
				rows: ["no-service"],
			},
			{
				cell: "late, vanished, same session",
				wire: "none",
				saved: [],
				didSave: 0,
				rows: ["vanished"],
			},
			{
				cell: "late, vanished, /new",
				wire: "none",
				saved: [],
				didSave: 0,
				rows: ["vanished"],
			},
			{
				cell: "late, vanished, session_shutdown",
				wire: "none",
				saved: [],
				didSave: 0,
				rows: ["vanished"],
			},
			{
				cell: "late, vanished, idle reset",
				wire: "none",
				saved: [],
				didSave: 0,
				rows: ["vanished"],
			},
		];

		it.each(IN_BAND_STATE_SPACE)(
			"state space (#3858): $cell",
			async (expected) => {
				const [settle, held, session] = expected.cell.split(", ");
				// A save-triggered server: it declared `textDocumentSync.save`.
				lspState.saveOptions = { includeText: false };
				const didSaves: string[] = [];
				const send = vi.mocked(lspState.connection.sendNotification);
				const wireOf = send.getMockImplementation();
				send.mockImplementation(async (method: string, params: unknown) => {
					if (method === "textDocument/didSave") {
						didSaves.push(
							String(
								(params as { textDocument: { uri: string } }).textDocument.uri,
							),
						);
					}
					return wireOf?.(method, params);
				});
				const opens = vi.spyOn(
					lspClient.notify as {
						open: (...args: unknown[]) => Promise<unknown>;
					},
					"open",
				);
				const snap = () => ({
					opens: opens.mock.calls.length,
					didSaves: didSaves.length,
					wire: wire.length,
					spawns: spawns(),
				});
				if (held === "vanished") child.removeAfterWrite = true;

				// `settled` counts from the start: the pipeline's own sync is the one
				// sync. `late` counts from just before the child writes.
				let at = snap();
				let write = () => {};
				let wrote: Promise<void>;
				if (settle === "settled") {
					const c = armChild();
					await runInBand();
					wrote = c.wrote;
				} else {
					const { c, install } = await giveUpInBand();
					write = install;
					wrote = c.wrote;
					// The boundary falls while the abandoned child still runs on.
					if (session === "/new") {
						runtime.resetForSession(Date.now());
						resetLSPService({ reason: "session_start" });
					} else if (session === "session_shutdown")
						resetLSPService({ reason: "session_shutdown" });
					else if (session === "idle reset")
						resetLSPService({ reason: "idle" });
					if (held === "not held" && session === "same session") {
						// The live client dropped F (idle eviction, a close).
						lspClient.isDocumentOpen = (fp: string) =>
							normalizeMapKey(fp) !== normalizeMapKey(filePath) &&
							lspState.openDocuments.has(normalizeMapKey(fp));
					} else if (session !== "same session" && held !== "not held") {
						// The successor's read-warm touch opens F before the child writes.
						await getLSPService().touchFile(filePath, "const x=1\n", {
							diagnostics: "none",
							source: "read-warm",
							readStamp: performance.now(),
						});
					}
					at = snap();
				}

				write();
				await wrote;
				if (settle === "late") await inBandSettled();
				else {
					await tick();
					await tick();
				}

				expect(fs.existsSync(filePath)).toBe(held !== "vanished");
				// The late resync spawns nothing; the settled pipeline's own sync is the
				// one spawn of this cell's client.
				expect(spawns() - at.spawns).toBe(settle === "settled" ? 1 : 0);
				if (expected.wire === "disk") {
					expect(wire.slice(at.wire).at(-1)).toBe("const x = 1\n");
				} else {
					expect(wire.slice(at.wire)).toEqual([]);
				}
				expect(
					opens.mock.calls
						.slice(at.opens)
						.filter(
							([fp]) =>
								normalizeMapKey(String(fp)) === normalizeMapKey(filePath),
						)
						.map((call) => call[5]),
				).toEqual(expected.saved);
				expect(didSaves.length - at.didSaves).toBe(expected.didSave);
				expect(inBandRows()).toEqual(
					expected.rows.map((outcome) =>
						expect.objectContaining({ filePath, metadata: { outcome } }),
					),
				);
			},
		);

		it("OrphanGiveUp (#3858): the abandoned formatter's late bytes are not credited as seen", async () => {
			// The assertions after the late write are pins: nothing ever stamped
			// there, so only the wait for the late row reds before the fix. They
			// name the recurrence the late resync must not introduce: a FileTime
			// stamp of bytes the agent never saw (#3525, the FormatService sharing
			// the read guard's table). The late read is the drift sweep's, which
			// stamps neither.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const resolving = gate();
			const resolution = gate();
			child.resolving = resolving.open;
			child.resolved = resolution.p;
			const c = armChild();
			// The agent's own write, through the real tool_result handler: once the
			// pipeline returns, it records that write in the read guard.
			const result = handleToolResult({
				event: {
					toolName: "write",
					toolCallId: "c1",
					input: { path: filePath, content: "const x=1\n" },
					details: {},
					content: [],
				},
				getFlag: (name: string) => flags.has(name),
				dbg: () => {},
				runtime,
				cacheManager,
				readGuard: runtime.readGuard,
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as never);
			await resolving.p;
			await vi.advanceTimersByTimeAsync(
				HOOK_WALL_BUDGET_MS.tool_result_edit + 1,
			);
			await result;
			// The bytes the agent wrote and the pipeline synced are credited.
			expect(runtime.readGuard.diskMovedSinceStamp(filePath)).toBe(false);
			expect(getFormatService().hasChanged(filePath)).toBe(false);
			resolution.open();
			await c.wrote;
			await inBandSettled();
			expect(wire.at(-1)).toBe(disk());
			// The formatter's late bytes are not: both tables still see the disk
			// as moved past what they stamped. (An edit verdict would not show it:
			// the read guard's content hashes tolerate a whitespace-only format.)
			expect(runtime.readGuard.diskMovedSinceStamp(filePath)).toBe(true);
			expect(getFormatService().hasChanged(filePath)).toBe(true);
		});
	});
});

/**
 * #3611, the #3609 F1 decision (A + C): a drain write that its session's
 * lineage dropped is counted by the scope's retirement reason, so the
 * correct `/new` drops can be told from the `/reload` and resume false
 * blocks (`formal/session-lifecycle` `recordDrop`, `NoUnrecordedFalseBlock`).
 * `retireScope` is what `index.ts`'s `session_shutdown` runs.
 */
describe("#3611 F1: a drain write dropped by its retired scope is counted by reason", () => {
	function readDrops(): Array<{ subject: string; count: number }> {
		return getDegradationSummary()
			.filter((group) => group.kind === "session-scope-read-dropped")
			.flatMap((group) =>
				group.latestReasons.map((r) => ({
					subject: r.subject,
					count: group.count,
				})),
			);
	}

	it("a format drain dropped by /reload leaves one record with the reason reload", async () => {
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		retireScope(runtime.sessionScope, "reload");
		c.openWrite();
		await drain;
		expect(staleWriteSubjects()).toEqual([`runtime-session:${filePath}`]);
		expect(readDrops()).toEqual([
			{ subject: "reload:deferred-format", count: 1 },
		]);
	});

	it("an autofix drain dropped by /new leaves one record with the reason new", async () => {
		const { fixer, parked, resume } = gatedBiome();
		writeBiomeAgreement();
		runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "autofix");
		flags.add("no-autoformat");
		const drain = handleAgentEnd(
			drainDeps({ biomeClient: fixer, ruffClient: noRuff }),
		);
		await parked.p;
		retireScope(runtime.sessionScope, "new");
		runtime.resetForSession(Date.now());
		resume.open();
		await drain;
		expect(readDrops()).toEqual([
			{ subject: "new:deferred-autofix", count: 1 },
		]);
	});

	it("records nothing when a /tree moved the branch before the scope retired (the entry may be gone)", async () => {
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		runtime.readGuard.retainBranch(new Set());
		retireScope(runtime.sessionScope, "reload");
		c.openWrite();
		await drain;
		expect(staleWriteSubjects()).toEqual([`runtime-session:${filePath}`]);
		expect(readDrops()).toEqual([]);
	});

	it("records nothing for a write queued before a /tree and dropped by /reload after it", async () => {
		// #3611 r2 F1 (review probe A): the record was queued at epoch 0; the
		// live read guard would refuse its write as a branch move, so its drop
		// is no false block and must not count as one.
		runtime.readGuard.retainBranch(new Set());
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		retireScope(runtime.sessionScope, "reload");
		c.openWrite();
		await drain;
		expect(staleWriteSubjects()).toEqual([`runtime-session:${filePath}`]);
		expect(readDrops()).toEqual([]);
	});

	it("records nothing when the read guard is off", async () => {
		flags.add("no-read-guard");
		const c = armChild({ write: true });
		const drain = handleAgentEnd(drainDeps());
		await c.didRead;
		retireScope(runtime.sessionScope, "reload");
		c.openWrite();
		await drain;
		expect(readDrops()).toEqual([]);
	});

	it("records nothing for a drain that stays in its live scope (no drop)", async () => {
		armChild();
		await handleAgentEnd(drainDeps());
		expect(blindEditVerdict()).toBe("allow");
		expect(readDrops()).toEqual([]);
	});
});
