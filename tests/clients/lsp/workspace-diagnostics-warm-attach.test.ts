import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
let warmAttached = false;
const tryWarmAttachedDiagnostics = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));
vi.mock("../../../clients/warm-attach.js", () => ({
	isWarmAttached: () => warmAttached,
	tryWarmAttachedDiagnostics,
}));

function diagnostic(message: string) {
	return {
		message,
		severity: 1,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		},
	};
}

function makeServer() {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

describe("runWorkspaceDiagnostics warm attach sweeps (#822)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tryWarmAttachedDiagnostics.mockReset();
		warmAttached = true;
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wsd-warm-attach-"));
		const server = makeServer();
		getServersForFileWithConfig.mockImplementation((filePath: string) =>
			filePath.endsWith(".ts") ? [server] : [],
		);
	});

	afterEach(() => removeTempDirSync(tmp));

	it("uses incumbent diagnostics without spawning or warming a local client", async () => {
		const files = ["a.ts", "b.ts"].map((name) => path.join(tmp, name));
		for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
		tryWarmAttachedDiagnostics.mockImplementation(async (file: string) => ({
			available: true,
			response: {
				diagnostics: [diagnostic(`attached:${path.basename(file)}`)],
			},
		}));

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const warmup = vi.spyOn(service, "ensureWarmForSweep");
		const results = await service.runWorkspaceDiagnostics(tmp, { files });

		expect(results.map((result) => result.diagnostics[0]?.message)).toEqual([
			"attached:a.ts",
			"attached:b.ts",
		]);
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledTimes(2);
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledWith(
			files[0],
			"const x = 1;\n",
			15_000,
			"sweep",
		);
		expect(createLSPClient).not.toHaveBeenCalled();
		expect(warmup).not.toHaveBeenCalled();
	});

	// #1470: the sweep's own honesty gate. The incumbent touches with
	// `clientScope: "with-auxiliary"`, so it is the one route into this sweep
	// that can produce a coverage gap today. A partially covered answer must
	// never be persisted as a confirmed clean and replayed on every later sweep.
	//
	// #1549 remapped HOW the gap is carried, not WHETHER it blocks the cache.
	// Before, the gap collapsed the whole file to `timedOut: true`, which also
	// discarded the primary's usable answer. #1470's own "suggested direction"
	// rejects that collapse: a primary that answered stays trustworthy when only
	// an auxiliary was cut off. The gap now rides on `unconfirmedServerIds`, the
	// sweep's cache write requires an empty `unconfirmedServerIds` as well as
	// `!timedOut`, and `timedOut` is reserved for primary-scoped failures. This
	// test asserts the same protection through the new state: the uncovered lane
	// is named on the result, and the file stays out of the cache.
	it("does not cache a sweep result whose auxiliary the incumbent could not cover (#1470)", async () => {
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		tryWarmAttachedDiagnostics.mockResolvedValue({
			available: true,
			response: {
				diagnostics: [],
				confirmation: "partial",
				unconfirmedServerIds: ["typos"],
			},
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp, {
			files: [file],
		});

		expect(results[0]?.unconfirmedServerIds).toEqual(["typos"]);
		const { cacheKeyFor, loadWorkspaceDiagnosticsCache } =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		expect(
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(file)],
		).toBeUndefined();
	});

	// #2300 C1 (verify round): `runWorkspaceDiagnostics`'s own `record` call
	// (`clients/lsp/index.ts`) wires `scannedSizeByFile.get(result.filePath)`
	// as the `sizeBytes` argument. A unit test against the cache primitive
	// alone (`workspace-diagnostics-cache.test.ts`) cannot see this wiring —
	// it calls `ctx.record` directly with a hand-supplied size, so neutering
	// the PRODUCTION argument to `undefined` would leave that test green.
	// This drives the real sweep end to end and reads the persisted entry
	// back through the cache's own load API.
	it("persists the swept file's real byte size into the cache entry (#2300)", async () => {
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		tryWarmAttachedDiagnostics.mockResolvedValue({
			available: true,
			response: { diagnostics: [] },
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(tmp, { files: [file] });

		const { cacheKeyFor, loadWorkspaceDiagnosticsCache } =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		const entry =
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(file)];
		expect(entry?.sizeBytes).toBe(fs.statSync(file).size);
	});

	it("promotes after an IPC failure and completes that file and the remainder locally", async () => {
		const files = ["a.ts", "b.ts", "c.ts"].map((name) => path.join(tmp, name));
		for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
		let attachedCalls = 0;
		tryWarmAttachedDiagnostics.mockImplementation(async (file: string) => {
			attachedCalls += 1;
			if (attachedCalls === 1) {
				return {
					available: true,
					response: {
						diagnostics: [diagnostic(`attached:${path.basename(file)}`)],
					},
				};
			}
			warmAttached = false;
			return { available: false, reason: "ipc-error" };
		});
		const localDiagnostic = diagnostic("local");
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "typescript",
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async () => undefined),
			getDiagnostics: vi.fn(() => [localDiagnostic]),
		};
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp, {
			files,
		});

		expect(results.map((result) => result.diagnostics[0]?.message)).toEqual([
			"attached:a.ts",
			"local",
			"local",
		]);
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledTimes(2);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(warmAttached).toBe(false);
	});
});
