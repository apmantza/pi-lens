/**
 * Verifies configured warmFiles are opened during full session startup.
 * This helps short-lived symbol queries avoid empty clangd results caused by
 * lazy translation-unit indexing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const mockTouchFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn(),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() => ({
		touchFile: mockTouchFile,
		supportsLSP: (f: string) => /\.(ts|tsx|js|jsx|py|cpp)$/.test(f),
	})),
}));

import { initLSPConfig, loadLSPConfig } from "../../clients/lsp/config.js";
import { getLSPService } from "../../clients/lsp/index.js";

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

function makeDefaultRuntime() {
	return {
		sessionGeneration: 99,
		isCurrentSession: () => true,
		markStartupScanInFlight: () => {},
		clearStartupScanInFlight: () => {},
		complexityBaselines: new Map(),
		resetForSession: () => {},
		projectRoot: "",
		projectRulesScan: { hasCustomRules: false, rules: [] },
		cachedExports: new Map(),
		errorDebtBaseline: { testsPassed: true, buildPassed: true },
	};
}

function makeDeps(
	overrides: {
		getFlag?: (name: string) => boolean | string | undefined;
		dbg?: (msg: string) => void;
		ctxCwd?: string;
	} = {},
) {
	return {
		ctxCwd: overrides.ctxCwd ?? process.cwd(),
		getFlag: overrides.getFlag ?? (() => false),
		notify: vi.fn(),
		dbg: overrides.dbg ?? (() => {}),
		log: () => {},
		runtime: makeDefaultRuntime(),
		metricsClient: { reset: () => {} },
		cacheManager: {
			writeCache: () => {},
			readCache: () => null,
		},
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			scanExports: async () => new Map(),
		},
		biomeClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		knipClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		jscpdClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		typeCoverageClient: { isAvailable: () => false },
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		testRunnerClient: {
			detectRunner: () => ({ runner: "vitest", config: null }),
			runTestFile: () => ({ failed: 1, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
	} as any;
}

describe("warmFiles session start", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(loadLSPConfig).mockResolvedValue({});
		vi.mocked(getLSPService).mockReturnValue({
			touchFile: mockTouchFile,
			supportsLSP: (f: string) => /\.(ts|tsx|js|jsx|py|cpp)$/.test(f),
		} as any);
	});

	afterEach(() => {
		delete process.env.PI_LENS_STARTUP_MODE;
	});

	it("calls touchFile for each warm file in .pi-lens/lsp.json", async () => {
		const env = setupTestEnvironment("pi-lens-warm-");
		const restoreStartupMode = setStartupMode("full");

		createTempFile(env.tmpDir, "src/main.cpp", "int main() {}");
		createTempFile(env.tmpDir, "src/engine.cpp", "void engine() {}");

		vi.mocked(loadLSPConfig).mockResolvedValue({
			warmFiles: ["src/main.cpp", "src/engine.cpp"],
		});

		try {
			await handleSessionStart(makeDeps({ ctxCwd: env.tmpDir }));

			await vi.waitFor(() => expect(mockTouchFile).toHaveBeenCalledTimes(2), {
				timeout: 5000,
			});

			const calls = mockTouchFile.mock.calls as Array<
				[string, string, Record<string, unknown>]
			>;

			expect(calls[0][0]).toContain("main.cpp");
			expect(calls[0][1]).toContain("int main()");
			expect(calls[0][2]).toMatchObject({
				source: "startup-warm",
				clientScope: "primary",
			});

			expect(calls[1][0]).toContain("engine.cpp");
			expect(calls[1][1]).toContain("void engine()");
			expect(calls[1][2]).toMatchObject({
				source: "startup-warm",
				clientScope: "primary",
			});

			expect(initLSPConfig).toHaveBeenCalled();
		} finally {
			env.cleanup();
			restoreStartupMode();
		}
	}, 15_000);

	it("skips touchFile when warmFiles is empty and the project has no source files", async () => {
		const env = setupTestEnvironment("pi-lens-warm-");
		const restoreStartupMode = setStartupMode("full");

		vi.mocked(loadLSPConfig).mockResolvedValue({});

		try {
			// Empty project — no detected language, so dominant-language auto-warm
			// has nothing to spawn.
			await handleSessionStart(makeDeps({ ctxCwd: env.tmpDir }));
			expect(mockTouchFile).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
			restoreStartupMode();
		}
	});

	it("auto-warms only the dominant language when warmFiles is empty (#203)", async () => {
		const env = setupTestEnvironment("pi-lens-warm-");
		const restoreStartupMode = setStartupMode("full");

		// TypeScript dominates (3 files) over Python (1) — exactly one server
		// should be warmed, via a representative .ts file.
		createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;");
		createTempFile(env.tmpDir, "src/b.ts", "export const b = 2;");
		createTempFile(env.tmpDir, "src/c.ts", "export const c = 3;");
		createTempFile(env.tmpDir, "src/util.py", "x = 1\n");

		vi.mocked(loadLSPConfig).mockResolvedValue({});

		try {
			await handleSessionStart(makeDeps({ ctxCwd: env.tmpDir }));

			await vi.waitFor(() => expect(mockTouchFile).toHaveBeenCalledTimes(1), {
				timeout: 5000,
			});

			const [filePath, , options] = mockTouchFile.mock.calls[0] as [
				string,
				string,
				Record<string, unknown>,
			];
			expect(filePath).toMatch(/\.ts$/);
			expect(options).toMatchObject({
				source: "startup-warm-dominant",
				clientScope: "primary",
				diagnostics: "none",
			});
		} finally {
			env.cleanup();
			restoreStartupMode();
		}
	}, 15_000);

	it("skips touchFile when no-lsp flag is set", async () => {
		const env = setupTestEnvironment("pi-lens-warm-");
		const restoreStartupMode = setStartupMode("full");

		vi.mocked(loadLSPConfig).mockResolvedValue({
			warmFiles: ["src/main.cpp"],
		});
		createTempFile(env.tmpDir, "src/main.cpp", "int main() {}");

		try {
			await handleSessionStart(
				makeDeps({
					ctxCwd: env.tmpDir,
					getFlag: (name: string) => name === "no-lsp",
				}),
			);
			expect(mockTouchFile).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
			restoreStartupMode();
		}
	});
});
