/**
 * Verifies configured warmFiles are opened during full session startup.
 * This helps short-lived symbol queries avoid empty clangd results caused by
 * lazy translation-unit indexing.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const mockTouchFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn(),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() =>
		makeLspServiceDouble({
			touchFile: mockTouchFile,
			supportsLSP: (f: string) => /\.(ts|tsx|js|jsx|py|cpp)$/.test(f),
		}),
	),
}));

import { initLSPConfig, loadLSPConfig } from "../../clients/lsp/config.js";
import { getLSPService } from "../../clients/lsp/index.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

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
	return withResidentBootstrap({
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
	}) as any;
}

describe("warmFiles session start", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(loadLSPConfig).mockResolvedValue({});
		vi.mocked(getLSPService).mockReturnValue(
			makeLspServiceDouble({
				touchFile: mockTouchFile,
				supportsLSP: (f: string) => /\.(ts|tsx|js|jsx|py|cpp)$/.test(f),
			}) as any,
		);
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

		// TypeScript dominates (3 files) over Python (1) in a real project root —
		// exactly one server should be warmed, via a representative .ts file.
		createTempFile(
			env.tmpDir,
			"package.json",
			JSON.stringify({ type: "module" }),
		);
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

	it("ignores json/yaml dominance and warms the dominant CODE kind (#894 review)", async () => {
		const env = setupTestEnvironment("pi-lens-warm-");
		const restoreStartupMode = setStartupMode("full");

		// Data files outnumber TypeScript (5 json + 2 yaml vs 2 ts) and
		// json/yaml have builtin LSP servers — but the dominant-language warm
		// must still pick tsserver, or the first .ts edit pays the cold-spawn
		// stall (#203) this warm exists to prevent.
		createTempFile(
			env.tmpDir,
			"package.json",
			JSON.stringify({ type: "module" }),
		);
		for (let i = 0; i < 4; i++) {
			createTempFile(env.tmpDir, `locales/l${i}.json`, `{"n": ${i}}`);
		}
		createTempFile(env.tmpDir, "ci/a.yml", "a: 1\n");
		createTempFile(env.tmpDir, "ci/b.yml", "b: 2\n");
		createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;");
		createTempFile(env.tmpDir, "src/b.ts", "export const b = 2;");

		vi.mocked(loadLSPConfig).mockResolvedValue({});
		vi.mocked(getLSPService).mockReturnValue(
			makeLspServiceDouble({
				touchFile: mockTouchFile,
				supportsLSP: (f: string) => /\.(ts|json|ya?ml)$/.test(f),
			}) as any,
		);

		try {
			await handleSessionStart(makeDeps({ ctxCwd: env.tmpDir }));

			await vi.waitFor(() => expect(mockTouchFile).toHaveBeenCalledTimes(1), {
				timeout: 5000,
			});

			const [filePath] = mockTouchFile.mock.calls[0] as [string];
			expect(filePath).toMatch(/\.ts$/);
		} finally {
			env.cleanup();
			restoreStartupMode();
		}
	}, 15_000);

	it("falls back to a non-code kind when no code kind is present (#894 review)", async () => {
		const env = setupTestEnvironment("pi-lens-warm-");
		const restoreStartupMode = setStartupMode("full");

		// Pure-config repo: the non-code fallback keeps #203's warm-something
		// behavior instead of skipping warmup entirely. A .git marker makes the
		// root warm-eligible (canWarmCaches) without adding any code files.
		fs.mkdirSync(path.join(env.tmpDir, ".git"), { recursive: true });
		createTempFile(env.tmpDir, "a.yaml", "a: 1\n");
		createTempFile(env.tmpDir, "b.yaml", "b: 2\n");

		vi.mocked(loadLSPConfig).mockResolvedValue({});
		vi.mocked(getLSPService).mockReturnValue(
			makeLspServiceDouble({
				touchFile: mockTouchFile,
				supportsLSP: (f: string) => /\.ya?ml$/.test(f),
			}) as any,
		);

		try {
			await handleSessionStart(makeDeps({ ctxCwd: env.tmpDir }));

			await vi.waitFor(() => expect(mockTouchFile).toHaveBeenCalledTimes(1), {
				timeout: 5000,
			});

			const [filePath] = mockTouchFile.mock.calls[0] as [string];
			expect(filePath).toMatch(/\.ya?ml$/);
		} finally {
			env.cleanup();
			restoreStartupMode();
		}
	}, 15_000);

	it("skips dominant-language auto-warm on home/no-project roots (#296)", async () => {
		const restoreStartupMode = setStartupMode("full");
		const dbgLog: string[] = [];

		vi.mocked(loadLSPConfig).mockResolvedValue({});

		try {
			await handleSessionStart(
				makeDeps({ ctxCwd: os.homedir(), dbg: (msg) => dbgLog.push(msg) }),
			);

			await vi.waitFor(
				() =>
					expect(dbgLog).toContainEqual(
						expect.stringContaining(
							"session_start lsp-warm: skipping dominant-language auto-warm (home-dir)",
						),
					),
				{ timeout: 5000 },
			);
			expect(mockTouchFile).not.toHaveBeenCalled();
		} finally {
			restoreStartupMode();
		}
	});

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
