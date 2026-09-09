// #2817 F7: exercise cache admission through a real LSP process. The Python
// row has snapshot import facts; the Lua row is deliberately uncovered and
// must take the language-neutral fallback.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../../clients/project-snapshot.js";
import {
	buildScopeKey,
	cacheKeyFor,
	saveWorkspaceDiagnosticsCache,
	WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import { CacheManager } from "../../../clients/cache-manager.js";
import { LANGUAGES } from "../../../clients/language-registry.js";

const root = fs.mkdtempSync(path.join(process.cwd(), ".probe-lsp-language-"));
const workspace = path.join(root, "workspace");
const fakeServer = fileURLToPath(
	new URL("../../fixtures/fake-lsp-server.mjs", import.meta.url),
);

describe("language-neutral workspace resync (#2817)", () => {
	const pythonDependency = path.join(workspace, "dependency.py");
	const pythonImporter = path.join(workspace, "consumer.py");
	const luaImporter = path.join(workspace, "consumer.lua");
	const matrixLanguages = LANGUAGES.filter((entry) =>
		entry.extensions.some((extension) => [".py", ".lua"].includes(extension)),
	);
	const factsLanguage = matrixLanguages.find((entry) =>
		entry.extensions.includes(".py"),
	);
	const fallbackLanguage = matrixLanguages.find((entry) =>
		entry.extensions.includes(".lua"),
	);
	if (!factsLanguage || !fallbackLanguage)
		throw new Error("language registry lost the Python/Lua matrix entries");
	const traceFile = path.join(root, "fake-lsp.trace");

	beforeAll(async () => {
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		for (const [file, content] of [
			[pythonDependency, "value = 1\n"],
			[pythonImporter, "from dependency import value\n"],
			[luaImporter, "local value = require('dependency')\n"],
		] as const)
			fs.writeFileSync(file, content);
		fs.writeFileSync(
			path.join(workspace, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					servers: {
						[`fake-${factsLanguage.id}`]: {
							name: `fake ${factsLanguage.id} server`,
							extensions: factsLanguage.extensions,
							command: process.execPath,
							args: [fakeServer],
							env: { FAKE_LSP_TRACE_FILE: traceFile },
							rootMarkers: [".pi-lens.json"],
						},
						[`fake-${fallbackLanguage.id}`]: {
							name: `fake ${fallbackLanguage.id} server`,
							extensions: fallbackLanguage.extensions,
							command: process.execPath,
							args: [fakeServer],
							env: { FAKE_LSP_TRACE_FILE: traceFile },
							rootMarkers: [".pi-lens.json"],
						},
					},
				},
			}),
		);
		const dependencyStat = fs.statSync(pythonDependency);
		const importerStat = fs.statSync(pythonImporter);
		saveProjectSnapshot(workspace, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: workspace,
			generatedAt: new Date().toISOString(),
			seq: 1,
			files: {
				[cacheKeyFor(pythonDependency)]: {
					path: pythonDependency,
					mtimeMs: dependencyStat.mtimeMs,
					size: dependencyStat.size,
					imports: [],
					lastSeq: 1,
				},
				[cacheKeyFor(pythonImporter)]: {
					path: pythonImporter,
					mtimeMs: importerStat.mtimeMs,
					size: importerStat.size,
					imports: [pythonDependency],
					lastSeq: 1,
				},
				// Deliberately omit luaImporter: the real snapshot loader must
				// leave importsFor(luaImporter) undefined.
			},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		});
		process.env.PI_LENS_HOME = path.join(root, ".pi-lens-home");
		process.env.FAKE_LSP_TRACE_FILE = traceFile;
		fs.writeFileSync(traceFile, "");
		const { initLSPConfig } = await import("../../../clients/lsp/config.js");
		await initLSPConfig(workspace);
	});

	afterAll(async () => {
		const { resetLSPService } = await import("../../../clients/lsp/index.js");
		resetLSPService({ reason: "test" });
		fs.rmSync(root, { recursive: true, force: true });
		delete process.env.FAKE_LSP_TRACE_FILE;
	});

	it("resyncs registry-selected Python facts and Lua fallback via the real server", async () => {
		const { getLSPService } = await import("../../../clients/lsp/index.js");
		const service = getLSPService();
		await service.touchFile(
			pythonDependency,
			fs.readFileSync(pythonDependency, "utf8"),
			{ diagnostics: "none", clientScope: "primary", source: "test" },
		);
		await service.touchFile(
			pythonImporter,
			fs.readFileSync(pythonImporter, "utf8"),
			{ diagnostics: "none", clientScope: "primary", source: "test" },
		);
		await service.touchFile(luaImporter, fs.readFileSync(luaImporter, "utf8"), {
			diagnostics: "none",
			clientScope: "primary",
			source: "test",
		});
		fs.writeFileSync(pythonDependency, "value = 2\n");
		fs.writeFileSync(
			pythonImporter,
			"from dependency import value\n# changed\n",
		);
		fs.writeFileSync(
			luaImporter,
			"local value = require('dependency')\n-- changed\n",
		);
		const scopeKey = buildScopeKey("all", ["opengrep"]);
		const stale = (filePath: string) => ({
			diagnostics: [
				{
					severity: 1 as const,
					message: `stale ${path.basename(filePath)}`,
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					serverId: `fake-${path.extname(filePath) === ".py" ? factsLanguage.id : fallbackLanguage.id}`,
				},
			],
			count: 1,
			mtimeMs: fs.statSync(filePath).mtimeMs,
			// Force the Python dependency freshness check to run. Lua reaches
			// the separate uncovered-facts fallback after the same cache hit.
			scannedAt: Date.now(),
			scopeKey,
			depIndexAtScan: true,
		});
		saveWorkspaceDiagnosticsCache(workspace, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheKeyFor(pythonImporter)]: stale(pythonImporter),
				[cacheKeyFor(luaImporter)]: stale(luaImporter),
			},
		});
		const { createLensDiagnosticsTool } =
			await import("../../../tools/lens-diagnostics.js");
		const result = await createLensDiagnosticsTool(
			new CacheManager(),
			() => workspace,
			() => service,
		).execute(
			"language-neutral-2817",
			{
				mode: "full",
				paths: [pythonImporter, luaImporter],
				refreshRunners: "none",
			},
			new AbortController().signal,
			null,
			{ cwd: workspace },
		);
		const text = String((result as any).content?.[0]?.text);
		expect(text).not.toContain("stale consumer.lua");
		const dependencyUri = `file://${pythonDependency}`;
		expect(fs.readFileSync(traceFile, "utf8")).toContain(
			`textDocument/didChange ${dependencyUri}`,
		);
		fs.writeFileSync(traceFile, "");
		expect(fs.readFileSync(traceFile, "utf8")).toBe("");
		// The persisted snapshot is the real facts loader. Removing its Python
		// importer edge must remove the dependency touch, not merely change labels.
		saveProjectSnapshot(workspace, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: workspace,
			generatedAt: new Date().toISOString(),
			seq: 2,
			files: {
				[cacheKeyFor(pythonDependency)]: {
					path: pythonDependency,
					mtimeMs: fs.statSync(pythonDependency).mtimeMs,
					size: fs.statSync(pythonDependency).size,
					imports: [],
					lastSeq: 2,
				},
			},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		});
		await service.runWorkspaceDiagnostics(workspace, {
			files: [pythonImporter],
		});
		expect(fs.readFileSync(traceFile, "utf8")).not.toContain(
			`textDocument/didChange ${dependencyUri}`,
		);
		expect(`${factsLanguage.id},${fallbackLanguage.id}`).toBe("python,lua");
	}, 30_000);
});
