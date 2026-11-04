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
import {
	createTempFile,
	pinFixtureHome,
	setupTestEnvironment,
} from "./test-utils.js";

const mockTouchFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

import { isSessionRootRegistered } from "../../clients/lsp/session-roots.js";
import {
	loadLSPConfig,
	resetLSPConfigStateForTests,
} from "../../clients/lsp/config.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import {
	installLspService,
	installLspServiceDouble,
} from "../support/lsp-service-seam.js";

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
		complexityBaselines: new Set(),
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
	let pinnedHome: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		// The real config loader walks up from the session cwd to HOME (#4709).
		pinnedHome = pinFixtureHome("runtime-session-warm").home;

		await installLspServiceDouble({
			touchFile: mockTouchFile,
			supportsLSP: (f: string) => /\.(ts|tsx|js|jsx|py|cpp)$/.test(f),
		});
	});

	afterEach(() => {
		resetLSPConfigStateForTests();
		delete process.env.PI_LENS_STARTUP_MODE;
	});

	it("calls touchFile for each warm file in .pi-lens.json lsp.warmFiles", async () => {
		const env = setupTestEnvironment("pi-lens-warm-");
		const restoreStartupMode = setStartupMode("full");

		createTempFile(env.tmpDir, "src/main.cpp", "int main() {}");
		createTempFile(env.tmpDir, "src/engine.cpp", "void engine() {}");

		createTempFile(
			env.tmpDir,
			".pi-lens.json",
			JSON.stringify({
				lsp: { warmFiles: ["src/main.cpp", "src/engine.cpp"] },
			}),
		);

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

			// The warm path declares the project a served session root through the
			// real `initLSPConfig`; the root registry is where that is visible.
			expect(isSessionRootRegistered(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
			restoreStartupMode();
		}
	}, 15_000);

	it("stops the config walk at the pinned home, so a config above it is never read (the HOME pin)", async () => {
		// Recurrence it prevents (#4709): the group-B suites run the REAL config
		// loader, whose project walk is bounded by `os.homedir()`. The pin is what
		// bounds it at a fixture home; nothing observed that, so a lost pin let
		// the walk read whatever sits above the session cwd on the maintainer's
		// machine. The planted config sits ABOVE the pinned home: only a walk
		// ceilinged at that home leaves it unread.
		const project = path.join(pinnedHome, "project");
		fs.mkdirSync(project, { recursive: true });
		const above = path.join(path.dirname(pinnedHome), ".pi-lens.json");
		fs.writeFileSync(
			above,
			JSON.stringify({ lsp: { warmFiles: ["hostile.cpp"] } }),
		);
		try {
			const config = await loadLSPConfig(project);
			expect(config.warmFiles ?? []).toEqual([]);
		} finally {
			fs.rmSync(above, { force: true });
		}
	});

	it("skips touchFile when warmFiles is empty and the project has no source files", async () => {
		const env = setupTestEnvironment("pi-lens-warm-");
		const restoreStartupMode = setStartupMode("full");

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

		installLspService(
			makeLspServiceDouble({
				touchFile: mockTouchFile,
				supportsLSP: (f: string) => /\.(ts|json|ya?ml)$/.test(f),
			}),
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
		// behavior instead of skipping warmup entirely. The fixture root marker
		// makes the root warm-eligible (canWarmCaches) without adding code files.
		createTempFile(env.tmpDir, "a.yaml", "a: 1\n");
		createTempFile(env.tmpDir, "b.yaml", "b: 2\n");

		installLspService(
			makeLspServiceDouble({
				touchFile: mockTouchFile,
				supportsLSP: (f: string) => /\.ya?ml$/.test(f),
			}),
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

		createTempFile(
			env.tmpDir,
			".pi-lens.json",
			JSON.stringify({ lsp: { warmFiles: ["src/main.cpp"] } }),
		);
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
