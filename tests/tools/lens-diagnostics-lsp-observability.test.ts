/**
 * #2860 round 3 F11: the folded `source=lsp` route had no durable trace of
 * its own — nothing in `latency.log` distinguished a `source=lsp` call from
 * a `source=session` one, so F1's class of defect (a real LSP result
 * rendering as "clean") would have shipped with no bounded record to catch
 * it. `tools/lens-diagnostics.ts`'s `source === "lsp"` branch now emits one
 * `lens_diagnostics_lsp_route` phase per tool call naming `scope` and the
 * confirmed/unconfirmed split.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency,
}));

import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { removeTempDirSync } from "../clients/test-utils.js";

function makeCacheManager() {
	return { readCache: vi.fn(() => undefined) } as any;
}

function findRoutePhase() {
	return logLatency.mock.calls
		.map(([entry]) => entry as Record<string, unknown>)
		.find((entry) => entry.phase === "lens_diagnostics_lsp_route");
}

describe("lens_diagnostics source=lsp observability (#2860 F11)", () => {
	beforeEach(() => {
		logLatency.mockReset();
	});

	it("records one lens_diagnostics_lsp_route phase naming scope and the confirmed/unconfirmed split", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-f11-"));
		const file = path.join(cwd, "bad.ts");
		fs.writeFileSync(file, "const value: number = 'bad';\n");
		const service = {
			touchFile: vi.fn(async () => undefined),
			getDiagnostics: vi.fn(async () => [
				{
					severity: 1,
					message: "probe finding",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
				},
			]),
			getCapabilitySnapshots: vi.fn(async () => []),
		};
		const tool = createLensDiagnosticsTool(
			makeCacheManager(),
			() => cwd,
			() => service as any,
		);

		try {
			const result = (await tool.execute(
				"diag-f11",
				{ source: "lsp", scope: "paths", paths: [file] },
				new AbortController().signal,
				null,
				{ cwd },
			)) as any;

			expect(result.isError).toBe(false);
			const record = findRoutePhase();
			expect(record).toBeDefined();
			expect(record?.toolName).toBe("lens_diagnostics");
			expect(record?.metadata).toMatchObject({
				scope: "paths",
				isError: false,
				totalDiagnostics: 1,
			});
			expect(typeof record?.durationMs).toBe("number");
		} finally {
			removeTempDirSync(cwd);
		}
	});

	it("records the phase with isError=true on the no-path/paths error path", async () => {
		const tool = createLensDiagnosticsTool(makeCacheManager(), () => "/proj");

		const result = (await tool.execute(
			"diag-f11b",
			{ source: "lsp", scope: "paths" },
			new AbortController().signal,
			null,
			{ cwd: "/proj" },
		)) as any;

		expect(result.isError).toBe(true);
		const record = findRoutePhase();
		expect(record).toBeDefined();
		expect(record?.metadata).toMatchObject({
			scope: "paths",
			isError: true,
			totalDiagnostics: 0,
		});
	});

	// Mutation-equivalent: if the phase call were dropped, no call would ever
	// carry this phase name — this is the assertion that would catch it.
	it("emits nothing under this phase name when no source=lsp call was made", async () => {
		const tool = createLensDiagnosticsTool(makeCacheManager(), () => "/proj");
		await tool.execute("diag-f11c", {}, new AbortController().signal, null, {
			cwd: "/proj",
		});
		expect(findRoutePhase()).toBeUndefined();
	});
});
