/**
 * #631: `lsp_diagnostics`' batch/directory scan (`collectBatchDiagnostics` in
 * tools/lsp-diagnostics.ts) used to fan files out across a flat, server-
 * oblivious bounded-concurrency pool — up to `concurrency` files in flight at
 * once, regardless of which LSP server they belonged to. A same-language
 * batch (the common case) could fire many concurrent touches at the SAME
 * shared, single-threaded LSP server, which is exactly the pattern #387
 * found doesn't parallelize (it queues server-side and cascades per-file
 * timeouts by queue position).
 *
 * The fix reuses `groupFilesByPrimaryServer`/`runPerServerGroups` — the same
 * primitives `runWorkspaceDiagnostics` (the engine behind `lens_diagnostics
 * mode=full`) has used since #387 — via `mapWithConcurrency`. This test
 * mirrors `tests/clients/lsp/workspace-diagnostics-per-server.test.ts`'s own
 * proof of the property, but drives it through the actual `lsp_diagnostics`
 * tool's batch path: N files targeting the SAME primary server never have
 * more than 1 in-flight touch at a time, while files targeting DIFFERENT
 * servers run concurrently.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ service: null as unknown }));
const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));
vi.mock("../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

// Real `groupFilesByPrimaryServer`/`runPerServerGroups` — only `getLSPService`
// is faked. Using the real scheduling primitives is the whole point: a fake
// scheduler would trivially satisfy the property under test either way.
vi.mock("../../clients/lsp/index.js", async () => {
	const actual =
		await vi.importActual<typeof import("../../clients/lsp/index.js")>(
			"../../clients/lsp/index.js",
		);
	return {
		...actual,
		getLSPService: () => mocked.service,
	};
});

vi.mock("../../clients/widget-state.js", () => ({
	reconcileScanDiagnostics: vi.fn(),
}));

import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";

function serverIdForFile(file: string): string {
	if (file.endsWith(".py")) return "python";
	if (file.endsWith(".ts")) return "typescript";
	return "none";
}

describe("lsp_diagnostics batch — per-server serialization (#631)", () => {
	let tmpDir: string;
	let live: Map<string, number>;
	let maxPerServer: Map<string, number>;
	let crossServerOverlap: boolean;
	let touchFile: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-diag-pergroup-"));
		getServersForFileWithConfig.mockReset();
		getServersForFileWithConfig.mockImplementation((fp: string) => {
			const id = serverIdForFile(fp);
			return id === "none" ? [] : [{ id }];
		});

		live = new Map();
		maxPerServer = new Map();
		crossServerOverlap = false;

		touchFile = vi.fn().mockImplementation(async (filePath: string) => {
			const serverId = serverIdForFile(filePath);
			const n = (live.get(serverId) ?? 0) + 1;
			live.set(serverId, n);
			maxPerServer.set(serverId, Math.max(maxPerServer.get(serverId) ?? 0, n));
			if ([...live.values()].filter((v) => v > 0).length > 1) {
				crossServerOverlap = true;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
			live.set(serverId, (live.get(serverId) ?? 1) - 1);
			return [];
		});

		mocked.service = {
			touchFile,
			getDiagnostics: vi.fn().mockResolvedValue([]),
			getDiagnosticsHealth: vi.fn().mockReturnValue(undefined),
			getCapabilitySnapshots: vi.fn().mockResolvedValue([]),
		};
	});

	function writeFiles(names: string[]): string[] {
		return names.map((name) => {
			const full = path.join(tmpDir, name);
			fs.writeFileSync(full, "x\n");
			return full;
		});
	}

	it("never runs two concurrent touches against one server, but overlaps distinct servers", async () => {
		const pyFiles = writeFiles(["a.py", "b.py", "c.py"]);
		const tsFiles = writeFiles(["d.ts", "e.ts", "f.ts"]);

		const tool = createLspDiagnosticsTool();
		const result = (await tool.execute(
			"diag-pergroup-batch",
			{
				paths: [...pyFiles, ...tsFiles],
				severity: "all",
				concurrency: 8,
				// waitMs forces the touchFile branch (see collectDiagnosticsForFile)
				// so this test can observe per-touch in-flight concurrency directly.
				waitMs: 50,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		)) as any;

		expect(result.isError).toBeUndefined();
		expect(result.details?.filesChecked).toBe(6);
		expect(touchFile).toHaveBeenCalledTimes(6);
		// Serial within each server: at most one in-flight touch at a time.
		expect(maxPerServer.get("python")).toBe(1);
		expect(maxPerServer.get("typescript")).toBe(1);
		// But the two distinct servers ran concurrently.
		expect(crossServerOverlap).toBe(true);
	});

	it("concurrency:1 makes even distinct server groups run one at a time (no cross-server overlap)", async () => {
		const pyFiles = writeFiles(["a.py", "b.py"]);
		const tsFiles = writeFiles(["c.ts", "d.ts"]);

		const tool = createLspDiagnosticsTool();
		const result = (await tool.execute(
			"diag-pergroup-serial",
			{
				paths: [...pyFiles, ...tsFiles],
				severity: "all",
				concurrency: 1,
				waitMs: 50,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		)) as any;

		expect(result.isError).toBeUndefined();
		expect(result.details?.filesChecked).toBe(4);
		expect(maxPerServer.get("python")).toBe(1);
		expect(maxPerServer.get("typescript")).toBe(1);
		// `concurrency: 1` caps how many DISTINCT server groups run at once —
		// with only one worker, the python and typescript groups run
		// sequentially rather than overlapping.
		expect(crossServerOverlap).toBe(false);
	});
});
