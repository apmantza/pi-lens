import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./clients/test-utils.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import {
	_settleRegistryMutationsForTests,
	deregisterInstance,
} from "../clients/instance-registry.js";

const workerHome = process.env.PI_LENS_HOME;

describe("#2992 read bridge lifecycle", () => {
	let probeHome: string;
	let filePath: string;
	let previousHome: string | undefined;
	let homeAtSetup: string | undefined;
	let setupCount = 0;

	beforeEach(() => {
		homeAtSetup = process.env.PI_LENS_HOME;
		previousHome = process.env.PI_LENS_HOME;
		setupCount++;
		const probeRoot = path.join(process.cwd(), ".probe-home");
		fs.mkdirSync(probeRoot, { recursive: true });
		probeHome = path.join(probeRoot, "pi-lens-2992-home");
		removeTempDirSync(probeHome);
		fs.mkdirSync(probeHome, { recursive: true });
		process.env.PI_LENS_HOME = probeHome;
		filePath = path.join(process.cwd(), "index-2992-probe.ts");
		fs.writeFileSync(filePath, "export const guarded = true;\n");
	});

	afterEach(async () => {
		fs.rmSync(filePath, { force: true });
		for (let tick = 0; tick < 3; tick++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			removeTempDirSync(probeHome);
		}
		// #2912 recurrence: session_start queues registerInstance without
		// awaiting it. Drain and remove that test-owned PID entry before the
		// home restore, or a reused Vitest worker leaks this root to the next
		// file's PID-scoped registry assertion.
		await _settleRegistryMutationsForTests();
		deregisterInstance();
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		vi.restoreAllMocks();
	});

	it("records a stale read through the real bridge before authorizing an edit", async () => {
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
		for (let i = 0; i < 100; i++) {
			readBridge.recordRead({
				filePath,
				requestedOffset: 1,
				requestedLimit: 1,
			});
		}

		const { getDegradationSummary, resetDegradationLedger } =
			await import("../clients/degradation-ledger.js");
		const staleRows = getDegradationSummary().find(
			(group) => group.kind === "extension-ctx-stale",
		);
		expect(staleRows?.count).toBe(1);
		expect(staleRows?.latestReasons).toEqual(
			expect.arrayContaining([
				{
					subject: "read-bridge",
					reason: expect.stringContaining("stale extension ctx"),
				},
			]),
		);
		// Keep the host flag live for the edit check. The read bridge's stale
		// fallback is the only authorization source in this scenario.
		(firstApi as unknown as Record<string, unknown>).getFlag = () => undefined;

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

	it("bounds repeated stale mutation-bridge records without authorizing a read", async () => {
		const { default: registerExtension } = await import("../index.js");
		const pi = createPiMock();
		const api = pi.asExtensionAPI();
		registerExtension(api);
		await pi.emit(
			"session_start",
			{ reason: "new" },
			makeCtx({ cwd: process.cwd(), sessionId: "mutation-session" }),
		);
		(api as unknown as Record<string, unknown>).getFlag = () => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload. " +
					"Do not use a captured pi or command ctx after ctx.newSession(), " +
					"ctx.fork(), ctx.switchSession(), or ctx.reload().",
			);
		};

		const mutationBridge = (globalThis as Record<symbol, unknown>)[
			Symbol.for("pi-lens:mutation-bridge")
		] as { recordMutation(entry: unknown): boolean };
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../clients/degradation-ledger.js");
		resetDegradationLedger();
		for (let i = 0; i < 100; i++) {
			expect(
				mutationBridge.recordMutation({
					filePath,
					kind: "edit",
					touchedLines: [1, 1],
					deferAutofix: false,
				}),
			).toBe(true);
		}
		const staleRows = getDegradationSummary().find(
			(group) => group.kind === "extension-ctx-stale",
		);
		expect(staleRows?.count).toBe(1);
		expect(staleRows?.latestReasons[0]?.subject).toBe("mutation-bridge");
	});

	it("rethrows a near-match stale failure at both bridge boundaries", async () => {
		const { default: registerExtension } = await import("../index.js");
		const pi = createPiMock();
		const api = pi.asExtensionAPI();
		registerExtension(api);
		await pi.emit(
			"session_start",
			{ reason: "new" },
			makeCtx({ cwd: process.cwd(), sessionId: "near-match-session" }),
		);
		(api as unknown as Record<string, unknown>).getFlag = () => {
			throw new Error("stale after session replacement");
		};
		const readBridge = (globalThis as Record<symbol, unknown>)[
			Symbol.for("pi-lens:read-bridge")
		] as { recordRead(entry: unknown): void };
		const mutationBridge = (globalThis as Record<symbol, unknown>)[
			Symbol.for("pi-lens:mutation-bridge")
		] as { recordMutation(entry: unknown): boolean };

		expect(() =>
			readBridge.recordRead({
				filePath,
				requestedOffset: 1,
				requestedLimit: 1,
			}),
		).toThrow("stale after session replacement");
		expect(
			mutationBridge.recordMutation({
				filePath,
				kind: "edit",
				touchedLines: [1, 1],
				deferAutofix: false,
			}),
		).toBe(false);
	});

	it("keeps the next test from inheriting PI_LENS_HOME (#2912)", () => {
		// #2912 recurrence: a cross-test PI_LENS_HOME leak redirects the real
		// instance registry and makes an unrelated worker observe an extra root.
		expect(setupCount).toBeGreaterThan(1);
		expect(homeAtSetup).toBe(workerHome);
	});
});
