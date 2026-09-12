import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

describe("#2992 read bridge lifecycle", () => {
	let probeHome: string;
	let filePath: string;

	beforeEach(() => {
		probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2992-home-"));
		process.env.PI_LENS_HOME = probeHome;
		filePath = path.join(process.cwd(), "index-2992-probe.ts");
		fs.writeFileSync(filePath, "export const guarded = true;\n");
	});

	afterEach(() => {
		fs.rmSync(filePath, { force: true });
		fs.rmSync(probeHome, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("records through real bridges, authorizes edit, bounds rows, and recovers after reactivation", async () => {
		// #2992 recurrence: a stale host context must not turn a read into a
		// false zero-read edit block. Keep the real ReadGuard and ledger; inject
		// staleness only at the host getFlag boundary.
		const { default: registerExtension } = await import("../index.js");
		const first = createPiMock();
		const firstApi = first.asExtensionAPI();
		registerExtension(firstApi);
		await first.emit(
			"session_start",
			{ reason: "new" },
			makeCtx({ cwd: process.cwd(), sessionId: "session-before" }),
		);

		const staleMessage =
			"This extension ctx is stale after session replacement or reload. " +
			"Do not use a captured pi or command ctx after ctx.newSession(), " +
			"ctx.fork(), ctx.switchSession(), or ctx.reload().";
		(firstApi as unknown as Record<string, unknown>).getFlag = () => {
			throw new Error(staleMessage);
		};

		const readBridge = (globalThis as Record<symbol, unknown>)[
			Symbol.for("pi-lens:read-bridge")
		] as { recordRead(entry: unknown): void };
		const mutationBridge = (globalThis as Record<symbol, unknown>)[
			Symbol.for("pi-lens:mutation-bridge")
		] as { recordMutation(entry: unknown): boolean };
		for (let i = 0; i < 100; i++) {
			readBridge.recordRead({
				filePath,
				requestedOffset: 1,
				requestedLimit: 1,
			});
			mutationBridge.recordMutation({
				filePath,
				kind: "edit",
				touchedLines: [1, 1],
				deferAutofix: false,
			});
		}

		const { getDegradationSummary, resetDegradationLedger } =
			await import("../clients/degradation-ledger.js");
		const staleRows = getDegradationSummary().find(
			(group) => group.kind === "extension-ctx-stale",
		);
		expect(staleRows?.count).toBe(2);
		expect(staleRows?.latestReasons).toEqual(
			expect.arrayContaining([
				{
					subject: "read-bridge",
					reason: expect.stringContaining("stale extension ctx"),
				},
				{
					subject: "mutation-bridge",
					reason: expect.stringContaining("stale extension ctx"),
				},
			]),
		);

		const toolCall = first.getHandlers("tool_call")[0];
		expect(
			await toolCall(
				{
					toolName: "edit",
					input: {
						path: filePath,
						edits: [
							{
								oldText: "export const guarded = true;",
								newText: "export const guarded = false;",
							},
						],
					},
				},
				makeCtx({ cwd: process.cwd() }),
			),
		).toBeUndefined();

		// A real factory reactivation refreshes the shared getter. The live SET
		// flag must be observed again, rather than remaining stuck at fallback.
		const second = createPiMock({ "no-read-guard": true });
		const secondApi = second.asExtensionAPI();
		registerExtension(secondApi);
		await second.emit(
			"session_start",
			{ reason: "reload" },
			makeCtx({ cwd: process.cwd(), sessionId: "session-after" }),
		);
		const recoveredPath = path.join(process.cwd(), "index-2992-recovered.ts");
		fs.writeFileSync(recoveredPath, "export const recovered = true;\n");
		try {
			// The replacement session re-arms the session ledger; reset explicitly
			// as the durable test seam so this assertion remains independent of
			// unrelated startup work in the host lifecycle.
			resetDegradationLedger();
			readBridge.recordRead({
				filePath: recoveredPath,
				requestedOffset: 1,
				requestedLimit: 1,
			});
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "extension-ctx-stale",
				),
			).toBeUndefined();
			(secondApi as unknown as Record<string, unknown>).getFlag = () => {
				throw new Error(staleMessage);
			};
			readBridge.recordRead({
				filePath: recoveredPath,
				requestedOffset: 1,
				requestedLimit: 1,
			});
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "extension-ctx-stale",
				)?.count,
			).toBe(1);
		} finally {
			fs.rmSync(recoveredPath, { force: true });
		}
	}, 45_000);
});
