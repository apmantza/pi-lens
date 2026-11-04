import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	flushDebouncedToolResults,
	handleToolResult,
} from "../../clients/runtime-tool-result.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(),
}));

let previousDebounceEnv: string | undefined;

function makeDeps(
	filePath: string,
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Partial<Parameters<typeof handleToolResult>[0]> = {},
): Parameters<typeof handleToolResult>[0] {
	return {
		event: {
			toolName: "edit",
			input: { path: filePath },
			details: {},
			content: [{ type: "text", text: "base" }],
		},
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		biomeClient: {},
		ruffClient: {},
		testRunnerClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
		...overrides,
	} as Parameters<typeof handleToolResult>[0];
}

describe("tool_result debounce (#115)", () => {
	beforeEach(async () => {
		previousDebounceEnv = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
		vi.mocked(pipeline.runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
	});

	afterEach(async () => {
		// Always flush so a hung debounce timer doesn't leak across tests.
		await flushDebouncedToolResults();
		if (previousDebounceEnv === undefined) {
			delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		} else {
			process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounceEnv;
		}
	});

	it("coalesces two back-to-back tool_results within the window into one pipeline run", async () => {
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "150";
		const env = setupTestEnvironment("pi-lens-debounce-coalesce-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-coalesce" });
			runtime.beginTurn();

			const first = handleToolResult(makeDeps(filePath, runtime, cacheManager));
			// Mutate file to change state before the second call.
			fs.writeFileSync(filePath, "export const x = 2;\n");
			const second = handleToolResult(
				makeDeps(filePath, runtime, cacheManager),
			);

			await Promise.all([first, second]);

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("runs both pipelines when calls are spaced beyond the window", async () => {
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "60";
		const env = setupTestEnvironment("pi-lens-debounce-spaced-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-spaced" });
			runtime.beginTurn();

			await handleToolResult(makeDeps(filePath, runtime, cacheManager));
			// Wait beyond the debounce window so the second call schedules a fresh run.
			await new Promise((resolve) => setTimeout(resolve, 120));
			fs.writeFileSync(filePath, "export const x = 2;\n");
			await handleToolResult(makeDeps(filePath, runtime, cacheManager));

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);
		} finally {
			env.cleanup();
		}
	});

	it("flushDebouncedToolResults forces a pending pipeline to run immediately", async () => {
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "5000";
		const env = setupTestEnvironment("pi-lens-debounce-flush-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-flush" });
			runtime.beginTurn();

			const pending = handleToolResult(
				makeDeps(filePath, runtime, cacheManager),
			);
			// Without the flush, the 5s debounce would keep the pipeline pending.
			await flushDebouncedToolResults();
			await pending;

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("a debounced tool_result keeps the session it entered in (#3596)", async () => {
		// Recurrence: #3596 finding G. `scheduleDebounced` kept the deps but not
		// the session the handler captured at entry, so the re-entry captured
		// whichever session was live when the timer or the flush fired, and a
		// session-1 edit was dispatched and credited in session 2.
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "5000";
		const env = setupTestEnvironment("pi-lens-debounce-session-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const longAgo = new Date("2000-01-01T00:00:00Z");
			fs.utimesSync(filePath, longAgo, longAgo);
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-session" });
			runtime.beginTurn();

			const pending = handleToolResult(
				makeDeps(filePath, runtime, cacheManager, {
					readGuard: runtime.readGuard,
				}),
			);
			// `/new` while the edit waits in the debounce window.
			runtime.resetForSession();
			runtime.beginTurn();
			await flushDebouncedToolResults();
			await pending;

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect({
				dispatched: vi.mocked(runPipeline).mock.calls.length,
				verdict: runtime.readGuard.checkEdit(filePath, [1, 1]).action,
			}).toEqual({ dispatched: 0, verdict: "block" });
		} finally {
			env.cleanup();
		}
	});

	it("runs immediately when the debounce env var is unset or zero", async () => {
		delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		const env = setupTestEnvironment("pi-lens-debounce-disabled-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-disabled" });
			runtime.beginTurn();

			await handleToolResult(makeDeps(filePath, runtime, cacheManager));

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);

			// Explicit 0 behaves the same as unset.
			process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "0";
			fs.writeFileSync(filePath, "export const x = 2;\n");
			await handleToolResult(makeDeps(filePath, runtime, cacheManager));
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);
		} finally {
			env.cleanup();
		}
	});

	it("rejects non-numeric / negative env values and falls back to disabled", async () => {
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "not-a-number";
		const env = setupTestEnvironment("pi-lens-debounce-bogus-env-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-bogus" });
			runtime.beginTurn();

			await handleToolResult(makeDeps(filePath, runtime, cacheManager));
			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #1086 P1 — inFlightPipelines/lastAnalyzedStateByFile/debouncedPipelines
 * converted to `PathKeyedMap` + `normalizeEphemeralMapKey` so divergent
 * Windows spellings of one file (case, separators) collapse to a single map
 * entry instead of bypassing the concurrent-state dedupe / debounce coalesce
 * (the #210/#1020/#1025 raw-path-key class).
 *
 * `normalizeEphemeralMapKey` only case-folds on win32 (AGENTS.md: Linux is
 * case-sensitive, so a case-divergent path there names a genuinely different
 * file — collapsing it would be WRONG, not a bug). To assert the win32 fold
 * behavior deterministically regardless of which OS actually runs this suite
 * (dev on Windows, CI on Linux — see AGENTS.md's OS-agnostic-tests rule), we
 * stub `process.platform` for the duration of these tests: the normalizer
 * reads `process.platform` fresh on every call, so the stub drives its branch
 * exactly like a real Windows host would, without depending on the host's
 * actual filesystem case-sensitivity or Node's (statically-bound, unstubbable)
 * `path.resolve`/`path.isAbsolute` implementation.
 *
 * Each "divergent spelling" pair below is two REAL files with identical
 * content — on a case-sensitive host (Linux CI) they are, correctly, two
 * distinct files on disk; the win32 stub is what makes the MAP treat their
 * paths as one key, exactly as it would on a real case-insensitive Windows
 * host. This is deliberately a map-keying test, not a filesystem-aliasing
 * test — see the class note above.
 */
describe("tool_result path-keyed maps: divergent-spelling collapse (#1086)", () => {
	let savedPlatform: PropertyDescriptor | undefined;

	beforeEach(async () => {
		previousDebounceEnv = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
		vi.mocked(pipeline.runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			checkedClean: false,
		});
		savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
	});

	afterEach(async () => {
		await flushDebouncedToolResults();
		if (previousDebounceEnv === undefined) {
			delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		} else {
			process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounceEnv;
		}
		if (savedPlatform) {
			Object.defineProperty(process, "platform", savedPlatform);
			savedPlatform = undefined;
		}
	});

	it("inFlightPipelines dedupes concurrent same-state calls for divergently-spelled paths into one pipeline run", async () => {
		delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS; // route through inFlightPipelines, not the debounce queue
		const env = setupTestEnvironment("pi-lens-inflight-spelling-");
		try {
			const dir = path.join(env.tmpDir, "sub");
			fs.mkdirSync(dir, { recursive: true });
			const upperPath = path.join(dir, "Foo.ts");
			const lowerPath = path.join(dir, "foo.ts");
			// Two real files, identical content — see class-doc comment above for why.
			fs.writeFileSync(upperPath, "export const x = 1;\n");
			fs.writeFileSync(lowerPath, "export const x = 1;\n");

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "inflight-spelling" });
			runtime.beginTurn();

			const logs: string[] = [];
			const deps = (filePath: string) =>
				makeDeps(filePath, runtime, cacheManager, {
					dbg: (msg: string) => logs.push(msg),
				});

			// Fired back-to-back without awaiting: both run synchronously up to
			// the pipeline's own await, so the second call observes the first's
			// in-flight entry (see class-doc comment: no intervening await in
			// handleToolResult before the pipeline is dispatched).
			const first = handleToolResult(deps(upperPath));
			const second = handleToolResult(deps(lowerPath));
			await Promise.all([first, second]);

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
			expect(
				logs.some((entry) =>
					entry.includes("skipping duplicate concurrent state"),
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("flushDebouncedToolResults(filePath) flushes a pending entry scheduled under a divergently-spelled path", async () => {
		// getDebounceMs() clamps to MAX_DEBOUNCE_MS (1000), so this schedules a
		// real ~1s timer. The load-immune discriminator (review round 1): the
		// flush AWAITS the entry's promise, so on a HIT `runPipeline` has already
		// run when `flushDebouncedToolResults` resolves — asserted BEFORE awaiting
		// `pending`. On a pre-fix MISS the flush is a no-op that resolves with the
		// call count still 0 (the natural timer hasn't fired yet), so the same
		// assertion fails deterministically — no wall-clock bound needed.
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "5000";
		const env = setupTestEnvironment("pi-lens-flush-spelling-");
		try {
			const dir = path.join(env.tmpDir, "sub");
			fs.mkdirSync(dir, { recursive: true });
			const upperPath = path.join(dir, "Bar.ts");
			const lowerPath = path.join(dir, "bar.ts");
			fs.writeFileSync(upperPath, "export const y = 1;\n");
			fs.writeFileSync(lowerPath, "export const y = 1;\n");

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "flush-spelling" });
			runtime.beginTurn();

			// Schedule under the upper-case spelling.
			const pending = handleToolResult(
				makeDeps(upperPath, runtime, cacheManager),
			);
			// Flush addressed by the differently-cased spelling: pre-fix (a bare
			// `Map` keyed on the raw path), `debouncedPipelines.has(lowerPath)`
			// would miss the entry scheduled under `upperPath` and silently no-op,
			// leaving `pending` to only resolve once the natural ~1s timer fires.
			await flushDebouncedToolResults(lowerPath);
			// Event-order assertion, pre-`pending`: a hit has already run the
			// pipeline; a pre-fix miss has not (its natural timer is still ~1s out).
			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
			await pending;
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("inFlightPipelines composite key keeps distinct entries for the same path with different stateHash", async () => {
		delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS; // route through inFlightPipelines
		const env = setupTestEnvironment("pi-lens-inflight-hash-axis-");
		try {
			const filePath = path.join(env.tmpDir, "baz.ts");
			fs.writeFileSync(filePath, "export const z = 1;\n");

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "inflight-hash-axis" });
			runtime.beginTurn();

			const logs: string[] = [];
			const dbg = (msg: string) => logs.push(msg);

			// Same path, fired back-to-back without awaiting (no intervening
			// `await` before either call reaches `getFileStateHash`), but the
			// file content — and therefore stateHash — differs between the two
			// synchronous calls: the composite key's hash axis must keep these
			// as two distinct inFlightPipelines entries, not collapse them.
			const first = handleToolResult(
				makeDeps(filePath, runtime, cacheManager, { dbg }),
			);
			fs.writeFileSync(filePath, "export const z = 2;\n");
			const second = handleToolResult(
				makeDeps(filePath, runtime, cacheManager, { dbg }),
			);
			await Promise.all([first, second]);

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);
			expect(
				logs.some((entry) =>
					entry.includes("skipping duplicate concurrent state"),
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
