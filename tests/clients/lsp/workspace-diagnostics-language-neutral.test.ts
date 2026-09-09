// #2817 F7/F8: exercise cache admission through a real LSP process. The
// facts and no-facts rows are selected from the production provider predicate.
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
import { importFactsApplyTo } from "../../../clients/dispatch/facts/import-facts.js";
import { LANGUAGES } from "../../../clients/language-registry.js";

const root = fs.mkdtempSync(path.join(process.cwd(), ".probe-lsp-language-"));
const workspace = path.join(root, "workspace");
const fakeServer = fileURLToPath(
	new URL("../../fixtures/fake-lsp-server.mjs", import.meta.url),
);

describe("language-neutral workspace resync (#2817)", () => {
	const factsLanguages = LANGUAGES.filter((entry) =>
		entry.extensions.some((extension) =>
			importFactsApplyTo(`file${extension}`),
		),
	);
	const noFactsLanguages = LANGUAGES.filter(
		(entry) =>
			entry.extensions.length > 0 &&
			!entry.extensions.some((extension) =>
				importFactsApplyTo(`file${extension}`),
			),
	);
	const factsLanguage = factsLanguages[0];
	const fallbackLanguage = noFactsLanguages[0];
	if (!factsLanguage || !fallbackLanguage)
		throw new Error("language registry lost a facts matrix class");
	const factsExtension = factsLanguage.extensions[0];
	const fallbackExtension = fallbackLanguage.extensions[0];
	if (!factsExtension || !fallbackExtension)
		throw new Error("language registry matrix entries need extensions");
	const factsDependency = path.join(workspace, `dependency${factsExtension}`);
	const factsImporter = path.join(workspace, `consumer${factsExtension}`);
	const fallbackImporter = path.join(workspace, `consumer${fallbackExtension}`);
	const traceFile = path.join(root, "fake-lsp.trace");
	console.log(
		`workspace diagnostics language matrix: facts=${factsLanguage.id}; no-facts=${fallbackLanguage.id}`,
	);

	beforeAll(async () => {
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		for (const [file, content] of [
			[factsDependency, "value = 1\n"],
			[factsImporter, "from dependency import value\n"],
			[fallbackImporter, "local value = require('dependency')\n"],
		] as const)
			fs.writeFileSync(file, content);
		fs.writeFileSync(
			path.join(workspace, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					disabledServers: ["typescript"],
					servers: {
						"fake-language-neutral": {
							name: "fake language-neutral server",
							extensions: [factsExtension, fallbackExtension],
							command: process.execPath,
							args: [fakeServer],
							env: { FAKE_LSP_TRACE_FILE: traceFile },
							rootMarkers: [".pi-lens.json"],
						},
					},
				},
			}),
		);
		const dependencyStat = fs.statSync(factsDependency);
		const importerStat = fs.statSync(factsImporter);
		saveProjectSnapshot(workspace, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: workspace,
			generatedAt: new Date().toISOString(),
			seq: 1,
			files: {
				[cacheKeyFor(factsDependency)]: {
					path: factsDependency,
					mtimeMs: dependencyStat.mtimeMs,
					size: dependencyStat.size,
					imports: [],
					lastSeq: 1,
				},
				[cacheKeyFor(factsImporter)]: {
					path: factsImporter,
					mtimeMs: importerStat.mtimeMs,
					size: importerStat.size,
					imports: [factsDependency],
					lastSeq: 1,
				},
				// Deliberately omit fallbackImporter: the real snapshot loader must
				// leave importsFor(fallbackImporter) undefined.
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

	it("resyncs one facts and one no-facts registry language via the real server", async () => {
		const { getLSPService } = await import("../../../clients/lsp/index.js");
		const service = getLSPService();
		await service.touchFile(
			factsDependency,
			fs.readFileSync(factsDependency, "utf8"),
			{ diagnostics: "none", clientScope: "primary", source: "test" },
		);
		await service.touchFile(
			factsImporter,
			fs.readFileSync(factsImporter, "utf8"),
			{ diagnostics: "none", clientScope: "primary", source: "test" },
		);
		await service.touchFile(
			fallbackImporter,
			fs.readFileSync(fallbackImporter, "utf8"),
			{
				diagnostics: "none",
				clientScope: "primary",
				source: "test",
			},
		);
		fs.writeFileSync(factsDependency, "value = 2\n");
		fs.writeFileSync(
			factsImporter,
			"from dependency import value\n# changed\n",
		);
		fs.writeFileSync(
			fallbackImporter,
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
					serverId: "fake-language-neutral",
				},
			],
			count: 1,
			mtimeMs: fs.statSync(filePath).mtimeMs,
			// Force the facts dependency freshness check to run. The no-facts row
			// reaches the separate uncovered-facts fallback after the same cache hit.
			scannedAt: Date.now(),
			scopeKey,
			depIndexAtScan: true,
		});
		saveWorkspaceDiagnosticsCache(workspace, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheKeyFor(factsImporter)]: stale(factsImporter),
				[cacheKeyFor(fallbackImporter)]: stale(fallbackImporter),
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
				paths: [factsImporter, fallbackImporter],
				refreshRunners: "none",
			},
			new AbortController().signal,
			null,
			{ cwd: workspace },
		);
		const text = String((result as any).content?.[0]?.text);
		expect(text).not.toContain(`stale ${path.basename(fallbackImporter)}`);
		const dependencyUri = `file://${factsDependency}`;
		expect(fs.readFileSync(traceFile, "utf8")).toContain(
			`textDocument/didChange ${dependencyUri}`,
		);
		fs.writeFileSync(traceFile, "");
		expect(fs.readFileSync(traceFile, "utf8")).toBe("");
		// The persisted snapshot is the real facts loader. Removing its importer
		// edge must remove the dependency touch, not merely change labels.
		saveProjectSnapshot(workspace, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: workspace,
			generatedAt: new Date().toISOString(),
			seq: 2,
			files: {
				[cacheKeyFor(factsDependency)]: {
					path: factsDependency,
					mtimeMs: fs.statSync(factsDependency).mtimeMs,
					size: fs.statSync(factsDependency).size,
					imports: [],
					lastSeq: 2,
				},
			},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		});
		await service.runWorkspaceDiagnostics(workspace, {
			files: [factsImporter],
		});
		expect(fs.readFileSync(traceFile, "utf8")).not.toContain(
			`textDocument/didChange ${dependencyUri}`,
		);
		expect(importFactsApplyTo(`file${factsExtension}`)).toBe(true);
		expect(importFactsApplyTo(`file${fallbackExtension}`)).toBe(false);
	}, 30_000);
});
