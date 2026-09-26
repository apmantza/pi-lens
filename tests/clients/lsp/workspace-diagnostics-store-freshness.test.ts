/**
 * Replays of the `formal/store-freshness` workspace-cache counterexamples
 * (#3505) through the real `LSPService.runWorkspaceDiagnostics` and the real
 * workspace-diagnostics cache. Only the language-server client, the server
 * config and the warm-attach incumbent are doubled.
 *
 * Recurrence: the sweep recorded each file's stat, and its `scannedAt`, AFTER
 * it read the bytes the answer was computed from. A write that landed in
 * between was recorded as the entry's own state, so a later sweep served the
 * pre-edit verdict from cache (own file), and a dependency written during the
 * sweep predated the entry (dependency axis).
 *
 * The concurrent writer lands the moment the sweep's read of `a.ts` resolves
 * (a pass-through spy on `fs.promises.readFile`, the read the sweep performs).
 * `other.ts` is swept first so the group warm-up reads it, not `a.ts`.
 *
 * The controls are the no-drop direction: with no write, or a write before the
 * read, the second sweep still serves the file from cache.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cacheKeyFor,
	loadWorkspaceDiagnosticsCache,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import {
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../../clients/project-snapshot.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

const { getServersForFileWithConfig, createLSPClient, warm } = vi.hoisted(
	() => ({
		getServersForFileWithConfig: vi.fn(),
		createLSPClient: vi.fn(),
		warm: {
			attached: false,
			diagnostics: vi.fn(),
		},
	}),
);
vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal()),
	createLSPClient,
}));
vi.mock("../../../clients/warm-attach.js", async (importOriginal) => ({
	...(await importOriginal()),
	isWarmAttached: () => warm.attached,
	tryWarmAttachedDiagnostics: warm.diagnostics,
}));

import type { LSPService } from "../../../clients/lsp/index.js";

const PREFIX = "pi-lens-wsd-store-freshness-";
const T_READ = 1_900_000_000_000;
const T_EDIT = T_READ + 400;
const T_REC = T_READ + 1500;
// A cold `vi.resetModules()` import of the LSP service dominates each case.
const CASE_MS = 30_000;

function setMtime(file: string, ms: number): void {
	fs.utimesSync(file, ms / 1000, ms / 1000);
}

function makeServer(root: string) {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/** A version-less push server that answers clean and counts its waits. */
function makeClient(root: string) {
	const waits: string[] = [];
	return {
		waits,
		client: {
			isAlive: () => true,
			isDocumentOpen: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId: "typescript",
			root,
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (filePath: string) => {
				waits.push(filePath);
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		},
	};
}

/** Run `write` once, right after the sweep's first read of `file` resolves. */
function afterFirstRead(file: string, write: () => void): () => boolean {
	const realReadFile = fs.promises.readFile;
	let landed = false;
	vi.spyOn(fs.promises, "readFile").mockImplementation(
		async (...args: Parameters<typeof realReadFile>) => {
			const bytes = await realReadFile(...args);
			if (!landed && args[0] === file) {
				landed = true;
				write();
			}
			return bytes as never;
		},
	);
	return () => landed;
}

describe("formal/store-freshness workspace-cache replays (#3505)", () => {
	let tmp: string;
	let other: string;
	let file: string;
	let dep: string;
	const services: LSPService[] = [];

	async function sweep(): Promise<void> {
		if (services.length === 0) {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			services.push(new LSPService());
		}
		await services[0].runWorkspaceDiagnostics(tmp, { files: [other, file] });
	}

	/** Import facts for both swept files, so a scoped cache hit is eligible. */
	function writeSnapshot(): void {
		const facts = (p: string, imports: string[]) => {
			const stat = fs.statSync(p);
			return {
				path: p,
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				imports,
				lastSeq: 1,
			};
		};
		saveProjectSnapshot(tmp, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: tmp,
			generatedAt: new Date(T_READ - 1000).toISOString(),
			seq: 1,
			files: {
				[cacheKeyFor(other)]: facts(other, []),
				[cacheKeyFor(file)]: facts(file, [dep]),
			},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		});
	}

	/** An external rewrite of `a.ts` with a strictly newer mtime. */
	function rewriteFile(): void {
		const before = fs.statSync(file).mtimeMs;
		fs.writeFileSync(file, "x = (\n");
		setMtime(file, before + 5000);
	}

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		warm.attached = false;
		warm.diagnostics.mockReset();
		tmp = setupTestEnvironment(PREFIX).tmpDir;
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		other = path.join(tmp, "other.ts");
		file = path.join(tmp, "a.ts");
		dep = path.join(tmp, "dep.ts");
		fs.writeFileSync(other, "export const other = 1;\n");
		fs.writeFileSync(file, 'import { y } from "./dep.js";\n');
		fs.writeFileSync(dep, "export const y = 1;\n");
		for (const p of [other, file, dep]) setMtime(p, T_READ - 1000);
		writeSnapshot();
		// Every sweep starts at T_READ, after the fixture was written.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T_READ);
		const server = makeServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [server] : [],
		);
	});
	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await Promise.all(services.splice(0).map((s) => s.shutdown()));
			},
		});
	});

	// ── (a) own file: the stat is taken before the read ──────────────────────
	describe("the recorded stat describes the bytes that were read", () => {
		for (const written of [true, false]) {
			it(
				written
					? "WorkspaceOwnStatAfterRead (#3505): a write after the pre-open read makes the next sweep re-query the file"
					: "WorkspaceOwnStatBefore no-drop (#3505): with no write, the next sweep serves the file from cache",
				async () => {
					const { client, waits } = makeClient(tmp);
					createLSPClient.mockResolvedValue(client);
					const landed = afterFirstRead(file, () => {
						if (written) rewriteFile();
					});
					await sweep();
					expect(landed()).toBe(true);
					const waitsAfterFirst = waits.filter((fp) => fp === file).length;
					expect(waitsAfterFirst).toBe(1);
					await sweep();
					expect(waits.filter((fp) => fp === file).length).toBe(
						waitsAfterFirst + (written ? 1 : 0),
					);
				},
				CASE_MS,
			);
		}

		for (const written of [true, false]) {
			it(
				written
					? "WorkspaceOwnStatAfterRead (#3505): a write right after the warm-attach sweep's own read makes the next sweep re-query the file"
					: "WorkspaceOwnStatBefore no-drop (#3505): with no write, the next warm-attach sweep serves the file from cache",
				async () => {
					warm.attached = true;
					warm.diagnostics.mockResolvedValue({
						available: true,
						response: { diagnostics: [] },
					});
					const landed = afterFirstRead(file, () => {
						if (written) rewriteFile();
					});
					const asked = () =>
						warm.diagnostics.mock.calls.filter(([fp]) => fp === file).length;
					await sweep();
					expect(landed()).toBe(true);
					expect(asked()).toBe(1);
					await sweep();
					expect(asked()).toBe(written ? 2 : 1);
				},
				CASE_MS,
			);
		}
	});

	// ── (c) dependency axis: scannedAt is stamped before the file's read ─────
	describe("the entry's scannedAt is the file's read", () => {
		for (const [label, depWrittenDuringAnalysis] of [
			[
				"WorkspaceDepLateStamp (#3505): a dependency written while the file is analysed makes the next sweep re-query it",
				true,
			],
			[
				"FixReadStamp no-drop (#3505): a dependency written before the file's read leaves the file served from cache",
				false,
			],
		] as const) {
			it(
				label,
				async () => {
					if (!depWrittenDuringAnalysis) {
						// Before the read, its mtime leading the clock by 40 ms.
						setMtime(dep, T_READ + 40);
					}
					const { client, waits } = makeClient(tmp);
					createLSPClient.mockResolvedValue(client);
					// a.ts is read at T_READ; its analysis runs on, a dependency
					// is written 400 ms in, and the sweep records at T_REC.
					afterFirstRead(file, () => {
						vi.setSystemTime(T_EDIT);
						if (depWrittenDuringAnalysis) {
							fs.writeFileSync(dep, "export const y = 2;\n");
							setMtime(dep, T_EDIT);
						}
						vi.setSystemTime(T_REC);
					});
					await sweep();
					const waitsAfterFirst = waits.filter((fp) => fp === file).length;
					expect(waitsAfterFirst).toBe(1);
					await sweep();
					expect(waits.filter((fp) => fp === file).length).toBe(
						waitsAfterFirst + (depWrittenDuringAnalysis ? 1 : 0),
					);
					if (!depWrittenDuringAnalysis) {
						// The persisted stamp is the read, not the record.
						const entry =
							loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(file)];
						expect(entry?.scannedAt).toBe(T_READ);
					}
				},
				CASE_MS,
			);
		}
	});
});
