import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetDiagnosticsPublishForTests,
	BUS_DIAGNOSTICS_EVENT,
	type PilensDiagnosticsPayload,
	wireDiagnosticsBusEmitter,
} from "../../clients/diagnostics-publish.js";
import { beginScope, retireScope } from "../../clients/session-scope.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnosticSummaries,
	recordDiagnostics,
	widgetStore,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

afterEach(() => {
	clearWidgetState();
	_resetDiagnosticsPublishForTests();
});

describe("widget sidecar restore and diagnostics bus", () => {
	it("replays the restored fresh diagnostics to an already subscribed consumer", async () => {
		const env = setupTestEnvironment("pi-lens-restore-bus-");
		const scope = beginScope({ role: "primary" });
		try {
			const kept = join(env.tmpDir, "kept.ts");
			const stale = join(env.tmpDir, "stale.ts");
			for (const file of [kept, stale]) {
				writeFileSync(file, "export const value = 1;\n");
				utimesSync(file, new Date(1_000_000), new Date(1_000_000));
				recordDiagnostics(file, [
					{
						tool: "tsc",
						severity: "error",
						message: "boom",
						line: 1,
						column: 7,
						rule: "TS2322",
					},
				]);
			}
			const saved = exportWidgetState();
			utimesSync(stale, new Date(9_000_000), new Date(9_000_000));
			clearWidgetState();
			const received: PilensDiagnosticsPayload[] = [];
			wireDiagnosticsBusEmitter((name, payload) => {
				if (name === BUS_DIAGNOSTICS_EVENT)
					received.push(payload as PilensDiagnosticsPayload);
			});
			await widgetStore.restore(scope, saved, {
				reason: "resume",
				source: "own-sidecar",
				savedAt: 2_000_000,
				sessionManager: undefined,
				cwd: env.tmpDir,
			});
			expect(getFileDiagnosticSummaries().map((f) => f.filePath)).toEqual([
				kept,
			]);
			expect(received).toHaveLength(1);
			expect(received[0].files).toEqual([
				{
					path: kept,
					diagnostics: [
						{
							severity: "error",
							message: "boom",
							tool: "tsc",
							line: 1,
							col: 7,
							ruleId: "TS2322",
						},
					],
				},
			]);
		} finally {
			retireScope(scope, "shutdown");
			env.cleanup();
		}
	});
});
