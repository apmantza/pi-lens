/**
 * #1640: a mode=full sweep must not present inferred-project TypeScript
 * diagnostics as unlabeled blockers.
 *
 * The fixture reproduces the live report exactly: a project whose tsconfig.json
 * includes only `src/**\/*.ts`, plus a test file under `tests/unit/` that uses
 * vitest globals without importing them. That file belongs to NO project, so
 * tsserver checks it in its synthetic inferred project and reports errors the
 * project's own `tsc --noEmit` never sees.
 *
 * tsserver itself is faked — the `projectInfo` response is the real protocol
 * shape (`configFileName: "/dev/null/inferredProject1*"`), so the test pins the
 * detection contract without spawning a language server.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { removeTempDirSync } from "../clients/test-utils.js";

const freshFetchMocks = vi.hoisted(() => ({
	fetchFreshProjectDiagnostics: vi.fn(),
}));

// #1632 landed `ANALYZER_IDS` as the single source of truth for the cold-lane
// list, and `formatFullMode` reads it from this module — so keep the real
// exports and override only the fetch.
vi.mock(
	"../../clients/project-diagnostics/fresh-fetch.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../clients/project-diagnostics/fresh-fetch.js")
			>();
		return {
			...actual,
			fetchFreshProjectDiagnostics:
				freshFetchMocks.fetchFreshProjectDiagnostics,
		};
	},
);

vi.mock("../../clients/bootstrap.js", () => ({
	loadBootstrapClients: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../clients/project-diagnostics/scanner.js", () => ({
	scanProjectDiagnostics: vi.fn(),
}));

vi.mock("../../clients/project-diagnostics/cache.js", () => ({
	PROJECT_DIAGNOSTICS_CACHE_VERSION: 2,
	loadProjectDiagnosticsSnapshot: vi.fn(),
	loadProjectDiagnosticsDeltaReport: vi.fn(),
	reconcileProjectDiagnosticsSnapshot: (snapshot: unknown) => ({
		snapshot,
		staleDropped: 0,
	}),
}));

// Spread the real module rather than hand-listing its exports; see the same
// note in tests/tools/lens-diagnostics-rule-policy.test.ts.
vi.mock("../../clients/widget-state.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/widget-state.js")>();
	return {
		...actual,
		getFileDiagnosticSummaries: () => [],
		reconcileStaleWidgetFiles: async () => 0,
		reconcileStaleWidgetDependencyBlockers: async () => 0,
		reconcileScanDiagnostics: vi.fn().mockReturnValue(true),
		reconcileCorrelatedScanDiagnostics: vi.fn(),
	};
});

beforeEach(() => {
	freshFetchMocks.fetchFreshProjectDiagnostics.mockReset();
	freshFetchMocks.fetchFreshProjectDiagnostics.mockResolvedValue({
		diagnostics: [],
		runners: [],
		cold: [],
		timings: {},
	});
	resetProjectLensConfigCache();
});

const INFERRED_CONFIG_FILE = "/dev/null/inferredProject1*";

function withFixture<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-inferred-")),
	);
	fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "tests", "unit"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, "tsconfig.json"),
		JSON.stringify({ include: ["src/**/*.ts"] }, null, 2),
	);
	fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export const ok = 1;\n");
	// vitest globals, deliberately not imported — the exact shape that produces
	// phantom TS2304/TS2339 errors under inferred compiler options.
	fs.writeFileSync(
		path.join(cwd, "tests", "unit", "spawn.test.ts"),
		"describe('spawn', () => { it('works', () => { expect(1).toBe(1); }); });\n",
	);
	resetProjectLensConfigCache();
	return fn(cwd).finally(() => {
		removeTempDirSync(cwd);
		resetProjectLensConfigCache();
	});
}

function makeCacheManager() {
	return { readCache: vi.fn(() => undefined) };
}

/**
 * A language service double that answers `projectInfo` the way a real classic
 * typescript-language-server does. `projectKind` selects which project the
 * fixture's test file resolves to.
 */
function makeLspService(
	testFilePath: string,
	options: {
		configFileName?: string | undefined;
		/** false = a service with no read-only probe channel at all. */
		hasProbeChannel?: boolean;
	} = {},
) {
	const executeReadOnlyCommandOnLiveClient = vi.fn(
		async (_file: string, command: string, args?: unknown[]) => {
			if (options.hasProbeChannel === false) return { executed: false };
			const [sub] = (args ?? []) as [string];
			if (command !== "typescript.tsserverRequest" || sub !== "projectInfo") {
				return { executed: false };
			}
			return {
				executed: true,
				result: {
					success: true,
					body: {
						configFileName: options.configFileName,
						languageServiceDisabled: false,
					},
				},
			};
		},
	);
	return {
		executeReadOnlyCommandOnLiveClient,
		runWorkspaceDiagnostics: vi.fn().mockResolvedValue([
			{
				filePath: testFilePath,
				diagnostics: [
					{
						severity: 1,
						message:
							"Cannot find name 'describe'. Do you need to install type definitions for a test runner?",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 8 },
						},
						source: "typescript",
						code: 2582,
					},
				],
				count: 1,
			},
		]),
	};
}

function run(cwd: string, lspService: unknown) {
	const tool = createLensDiagnosticsTool(
		makeCacheManager() as never,
		() => cwd,
		() => lspService as never,
	);
	return tool.execute(
		"1",
		{ mode: "full" },
		new AbortController().signal,
		null,
		{ cwd },
	);
}

describe("lens_diagnostics mode=full — inferred-project demotion (#1640)", () => {
	it("demotes and labels a test file that belongs to no tsconfig project", async () => {
		await withFixture(async (cwd) => {
			const testFile = path.join(cwd, "tests", "unit", "spawn.test.ts");
			const lspService = makeLspService(testFile, {
				configFileName: INFERRED_CONFIG_FILE,
			});
			const result = await run(cwd, lspService);
			const text = String(result.content[0].text);

			// The finding survives — suppression would hide the genuine type errors
			// the project's own tsc gate cannot see.
			expect(text).toContain("Cannot find name 'describe'");
			// …but never at blocking authority.
			expect(result.details).toMatchObject({ totalBlocking: 0 });
			expect(text).not.toContain("🔴");
			// …and it names the config gap the user can actually close.
			expect(text).toContain(
				"not in any tsconfig project — checked with inferred settings",
			);
			expect(text).toContain("add tests/** to a tsconfig");
		});
	});

	it("keeps blocking authority for a file inside a real tsconfig project", async () => {
		await withFixture(async (cwd) => {
			const srcFile = path.join(cwd, "src", "index.ts");
			const lspService = makeLspService(srcFile, {
				configFileName: path.join(cwd, "tsconfig.json"),
			});
			const result = await run(cwd, lspService);
			const text = String(result.content[0].text);
			expect(result.details).toMatchObject({ totalBlocking: 1 });
			expect(text).not.toContain(
				"not in any tsconfig project — checked with inferred settings",
			);
		});
	});

	it("keeps blocking authority when the projectInfo probe cannot answer", async () => {
		await withFixture(async (cwd) => {
			const testFile = path.join(cwd, "tests", "unit", "spawn.test.ts");
			// A server with no read-only probe channel: unknown membership, NOT a
			// confirmed inferred project.
			const lspService = makeLspService(testFile, { hasProbeChannel: false });
			const result = await run(cwd, lspService);
			expect(result.details).toMatchObject({ totalBlocking: 1 });
			expect(String(result.content[0].text)).not.toContain(
				"not in any tsconfig project",
			);
		});
	});
});
