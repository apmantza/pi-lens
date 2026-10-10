/**
 * `runHandlerExpectingNoThrow` fails a handler-verdict test when the handler
 * threw and production swallowed it (#3518).
 *
 * Recurrence this pins: #4182. `observed-mutation-integration.test.ts` mocked
 * `clients/bootstrap.js` WITHOUT `requestBootstrapClients`, so the real
 * `handleToolCall` threw at its complexity-baseline step, absorbed the throw as
 * a `tool-call-handler-throw` degradation, returned `undefined`, and every
 * "result is undefined / not blocked" assertion in the file passed whatever
 * the read guard would have said. This file rebuilds that exact shape (the
 * same incomplete `bootstrap.js` mock, the real `handleToolCall`, a real read
 * of a supported file) and proves, in this order:
 *
 * 1. the OLD assertion still passes on the broken mock: the defect is real and
 *    the swallow is what hides it;
 * 2. the helper turns the same call into a failure carrying the swallowed
 *    message, and the ledger-reset keeps it to one failure;
 * 3. a handler that completes returns its real verdict, blocking or not;
 * 4. the handlers WITHOUT a whole-handler catch need no helper: their throw
 *    rejects the awaited call by itself.
 *
 * `expectHelperFailure` is the expected-failure check the mutation row in the
 * PR body neuters: a helper that ignored the degradation record would resolve
 * where this file requires a rejection.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	recordDegradationOnce,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { surfaceHandlerCrash } from "../../clients/session-event-guard.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/lsp/capabilities.js")
	>()),
	getLSPService: () => makeLspServiceDouble(),
	resetLSPService: () => {},
	notifyExternalFileChange: vi.fn(async () => undefined),
}));

// The #4182 defect: `handleToolCall` demands `requestBootstrapClients` for its
// complexity baseline and the mock did not supply it, so the demand threw.
// #4182's factory omitted the export outright (vitest throws on reading an
// export the factory lacks). That spelling is the population of the
// `vi-mock-export-sweep` ratchet, so this fixture spreads the real module and
// makes the export itself throw: same observable, the handler throws before its
// read guard, and the throw is swallowed.
vi.mock("../../clients/bootstrap.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/bootstrap.js")>()),
	requestBootstrapClients: async () => {
		throw new Error(
			'No "requestBootstrapClients" export is defined on the bootstrap mock',
		);
	},
}));

const SOURCE = "export const value = 1;\n";

function readDeps(
	tmpDir: string,
	filePath: string,
	overrides: Record<string, unknown> = {},
): Parameters<typeof handleToolCall>[0] {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmpDir;
	return {
		event: {
			toolName: "read",
			toolCallId: "call-3518",
			input: { path: filePath },
		},
		ctx: { cwd: tmpDir },
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
		...overrides,
	} as unknown as Parameters<typeof handleToolCall>[0];
}

/** The rejection a checked call must produce, as a string for assertions. */
async function expectHelperFailure(
	call: () => Promise<unknown>,
): Promise<string> {
	let failure: unknown;
	try {
		await call();
	} catch (error) {
		failure = error;
	}
	expect(
		failure,
		"the helper must reject, not return the swallowed verdict",
	).toBeInstanceOf(Error);
	return (failure as Error).message;
}

beforeEach(() => {
	resetDegradationLedger();
});

describe("#3518 — a swallowed handler throw fails the handler-verdict test", () => {
	it("the unchecked #4182 assertion passes on the broken mock: the swallow hides the defect", async () => {
		const env = setupTestEnvironment("pi-lens-3518-old-");
		try {
			const filePath = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(filePath, SOURCE);

			const result = await handleToolCall(readDeps(env.tmpDir, filePath));

			// The assertion #4182's review found vacuous: it holds although the
			// handler never reached a verdict.
			expect(result).toBeUndefined();
			const crashed = getDegradationSummary().find(
				(group) => group.kind === "tool-call-handler-throw",
			);
			expect(crashed?.latestReasons[0]?.reason).toContain(
				"requestBootstrapClients",
			);
		} finally {
			env.cleanup();
		}
	});

	it("the helper fails the same call with the swallowed message", async () => {
		const env = setupTestEnvironment("pi-lens-3518-new-");
		try {
			const filePath = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(filePath, SOURCE);

			const message = await expectHelperFailure(() =>
				runHandlerExpectingNoThrow(() =>
					handleToolCall(readDeps(env.tmpDir, filePath)),
				),
			);

			expect(message).toContain("tool-call-handler-throw (read)");
			expect(message).toContain("requestBootstrapClients");
		} finally {
			env.cleanup();
		}
	});

	it("a throw is reported once: the helper resets the ledger so the next checked call is judged fresh", async () => {
		const env = setupTestEnvironment("pi-lens-3518-once-");
		try {
			const filePath = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(filePath, SOURCE);
			await expectHelperFailure(() =>
				runHandlerExpectingNoThrow(() =>
					handleToolCall(readDeps(env.tmpDir, filePath)),
				),
			);

			// An unsupported-extension read never reaches the baseline step, so
			// this call completes; it must not inherit the previous call's failure.
			const textPath = path.join(env.tmpDir, "notes.txt");
			fs.writeFileSync(textPath, "plain\n");
			const verdict = await runHandlerExpectingNoThrow(() =>
				handleToolCall(readDeps(env.tmpDir, textPath)),
			);
			expect(verdict).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("an earlier swallowed throw fails the next checked call at entry, because the repeat would be invisible", async () => {
		const env = setupTestEnvironment("pi-lens-3518-entry-");
		try {
			const filePath = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(filePath, SOURCE);

			// An unchecked call swallows the throw and leaves the ledger record.
			await handleToolCall(readDeps(env.tmpDir, filePath));
			// The ledger keeps ONE record per (kind, subject): a second throw for
			// the same tool name records nothing new.
			await handleToolCall(readDeps(env.tmpDir, filePath));
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "tool-call-handler-throw",
				)?.count,
			).toBe(1);

			let ran = false;
			const message = await expectHelperFailure(() =>
				runHandlerExpectingNoThrow(async () => {
					ran = true;
					return await handleToolCall(readDeps(env.tmpDir, filePath));
				}),
			);

			expect(ran, "the entry check refuses before the handler runs").toBe(
				false,
			);
			expect(message).toContain("already threw");
			expect(message).toContain("requestBootstrapClients");
		} finally {
			env.cleanup();
		}
	});

	it("an entry failure resets the ledger: the next checked call is judged fresh (#4201 F2)", async () => {
		// Recurrence: without the reset in the entry branch, one earlier swallow
		// fails EVERY later checked call in the file, not the one that met it.
		recordDegradationOnce({
			kind: "tool-call-handler-throw",
			subject: "earlier",
			reason: "swallowed before this call",
		});
		const first = await expectHelperFailure(() =>
			runHandlerExpectingNoThrow(async () => "never reached"),
		);
		expect(first).toContain("swallowed before this call");
		await expect(
			runHandlerExpectingNoThrow(async () => "verdict"),
		).resolves.toBe("verdict");
	});

	it("reads the ledger of the module graph the handler ran in, after vi.resetModules() (#4201 F1)", async () => {
		// Recurrence: tests/index-integration.test.ts calls vi.resetModules() and
		// imports index.js, so the production handler records into a FRESH
		// degradation-ledger instance while the helper (imported once) held the
		// original. With handleToolCallImpl always throwing, two tool_call tests
		// there passed with no helper message (AGENTS.md shape 14).
		const env = setupTestEnvironment("pi-lens-3518-reset-");
		try {
			const filePath = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(filePath, SOURCE);
			vi.resetModules();
			const fresh = await import("../../clients/runtime-tool-call.js");
			const freshLedger = await import("../../clients/degradation-ledger.js");
			expect(freshLedger.getDegradationSummary).not.toBe(getDegradationSummary);
			const pi = createPiMock();
			pi.on("tool_call", (event) =>
				fresh.handleToolCall({
					...readDeps(env.tmpDir, filePath),
					event: event as never,
				}),
			);

			const message = await expectHelperFailure(() =>
				pi.emit(
					"tool_call",
					{
						toolName: "read",
						toolCallId: "call-3518-reset",
						input: { path: filePath },
					},
					makeCtx({ cwd: env.tmpDir }),
				),
			);

			expect(message).toContain("tool-call-handler-throw (read)");
			// The split the fix closes: the statically imported ledger saw nothing.
			expect(
				getDegradationSummary().some(
					(group) => group.kind === "tool-call-handler-throw",
				),
			).toBe(false);
			// The failure reset the fresh ledger too: the next checked call is clean.
			await expect(
				runHandlerExpectingNoThrow(async () => "verdict"),
			).resolves.toBe("verdict");
		} finally {
			env.cleanup();
		}
	});

	it("a handler that completes returns its real verdict, blocking or not", async () => {
		const env = setupTestEnvironment("pi-lens-3518-verdict-");
		try {
			const filePath = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(filePath, SOURCE);

			// `no-complexity` skips the baseline step, so the handler completes
			// and reaches the read guard for an edit with no prior read.
			const noOpinion = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					readDeps(env.tmpDir, filePath, {
						getFlag: (name: string) => name === "no-complexity",
					}),
				),
			);
			expect(noOpinion).toBeUndefined();

			const blocked = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					readDeps(env.tmpDir, filePath, {
						getFlag: (name: string) => name === "no-complexity",
						event: {
							toolName: "edit",
							toolCallId: "call-3518-edit",
							input: {
								path: filePath,
								oldText: "export const value = 1;",
								newText: "export const value = 2;",
							},
						},
					}),
				),
			);
			expect(blocked).toMatchObject({ block: true });
		} finally {
			env.cleanup();
		}
	});

	it("a rejecting handler rejects through the helper unchanged", async () => {
		const boom = new Error("handler rejected");
		await expect(
			runHandlerExpectingNoThrow(async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
	});

	it("a crash recorded without a rethrow (surfaceHandlerCrash rethrow:false) fails the call too", async () => {
		const message = await expectHelperFailure(() =>
			runHandlerExpectingNoThrow(async () => {
				surfaceHandlerCrash("quiet_window", new Error("late crash"), {
					rethrow: false,
				});
				return "verdict";
			}),
		);
		expect(message).toContain("hook-handler-crash (quiet_window)");
		expect(message).toContain("late crash");
	});

	it("an unrelated degradation record is not a swallowed handler throw", async () => {
		recordDegradationOnce({
			kind: "lsp-idle-eviction",
			subject: "unrelated",
			reason: "not a handler throw",
		});
		await expect(
			runHandlerExpectingNoThrow(async () => "verdict"),
		).resolves.toBe("verdict");
	});

	it("the pi mock runs every registered tool_call hook through the helper", async () => {
		const env = setupTestEnvironment("pi-lens-3518-mock-");
		try {
			const filePath = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(filePath, SOURCE);
			const pi = createPiMock();
			pi.on("tool_call", (event) =>
				handleToolCall({
					...readDeps(env.tmpDir, filePath),
					event: event as never,
				}),
			);
			const event = {
				toolName: "read",
				toolCallId: "call-3518-mock",
				input: { path: filePath },
			};

			// Every route to the registered hook is checked, not only `emit`.
			const viaEmit = await expectHelperFailure(() =>
				pi.emit("tool_call", event, makeCtx({ cwd: env.tmpDir })),
			);
			expect(viaEmit).toContain("requestBootstrapClients");
			const viaGetHandlers = await expectHelperFailure(async () =>
				pi.getHandlers("tool_call")[0](event, makeCtx({ cwd: env.tmpDir })),
			);
			expect(viaGetHandlers).toContain("tool-call-handler-throw");
			// Other events are not wrapped: a handler returning undefined still
			// resolves.
			pi.on("turn_end", () => undefined);
			await expect(pi.emit("turn_end", {}, makeCtx())).resolves.toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("handleToolResult has no whole-handler catch: its throw rejects the call without the helper", async () => {
		const env = setupTestEnvironment("pi-lens-3518-result-");
		try {
			const filePath = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(filePath, SOURCE);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await expect(
				handleToolResult({
					event: {
						toolName: "read",
						input: { path: filePath },
						content: [{ type: "text", text: SOURCE }],
					},
					getFlag: () => {
						throw new Error("tool_result flag exploded");
					},
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					biomeClient: {},
					ruffClient: {},
					metricsClient: {},
					resetLSPService: () => {},
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
				} as unknown as Parameters<typeof handleToolResult>[0]),
			).rejects.toThrow("tool_result flag exploded");
			expect(
				getDegradationSummary().some(
					(group) => group.kind === "tool-call-handler-throw",
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
