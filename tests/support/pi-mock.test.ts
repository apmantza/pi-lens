import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	endMockSessions,
	failOnOpenMockSessions,
} from "./mock-session-teardown.js";
import {
	createPiMock,
	makeCtx,
	SESSION_START_TEST_BUDGET_MS,
} from "./pi-mock.js";
import { stripSource } from "./sweep-kit.js";

describe("createPiMock", () => {
	it("records flags and exposes defaults via getFlag", () => {
		const pi = createPiMock();
		pi.registerFlag("no-lens", { type: "boolean", default: false });
		pi.registerFlag("lens-opengrep-config", { type: "string" });
		expect(pi.flags.has("no-lens")).toBe(true);
		expect(pi.getFlag("no-lens")).toBe(false); // seeded from default
		expect(pi.getFlag("lens-opengrep-config")).toBeUndefined();
	});

	it("setFlag overrides getFlag once the factory has registered the flag", () => {
		const pi = createPiMock();
		pi.registerFlag("no-lens-context", { type: "boolean", default: false });
		expect(pi.getFlag("no-lens-context")).toBe(false); // the registered default
		pi.setFlag("no-lens-context", true);
		expect(pi.getFlag("no-lens-context")).toBe(true);
	});

	// #4913 part D: pi applies command-line flag values after every factory, so
	// a value set before the factory registers its flag is the pre-set path this
	// double no longer has. Recurrence: #4917's factory-time reads passed on a
	// double that applied flags before the factory ran.
	it("setFlag refuses a flag the factory has not registered yet (no pre-set path)", () => {
		const pi = createPiMock();
		expect(() => pi.setFlag("no-lens-context", true)).toThrow(/not registered/);
		expect(pi.getFlag("no-lens-context")).toBeUndefined();
	});

	it("records tools and throws on duplicate names (like the host)", () => {
		const pi = createPiMock();
		pi.registerTool({ name: "lens_diagnostics" });
		expect(pi.getTool("lens_diagnostics")).toBeDefined();
		expect(() => pi.registerTool({ name: "lens_diagnostics" })).toThrow(
			/already registered/,
		);
	});

	it("records multiple handlers per event and emit runs them in order", async () => {
		const pi = createPiMock();
		const calls: number[] = [];
		pi.on("turn_end", () => {
			calls.push(1);
		});
		pi.on("turn_end", () => {
			calls.push(2);
			return { done: true };
		});
		const result = await pi.emit("turn_end", { foo: 1 }, makeCtx());
		expect(calls).toEqual([1, 2]);
		expect(result).toEqual({ done: true }); // last defined result
	});

	it("emit passes payload + ctx through to the handler", async () => {
		const pi = createPiMock();
		let seen: { event: unknown; cwd: unknown } | undefined;
		pi.on("context", (event, ctx) => {
			seen = { event, cwd: (ctx as { cwd: string }).cwd };
			return undefined;
		});
		await pi.emit("context", { messages: [] }, makeCtx({ cwd: "/tmp/x" }));
		expect(seen).toEqual({ event: { messages: [] }, cwd: "/tmp/x" });
	});

	it("getHandlerOrThrow throws when an event has no handler", () => {
		const pi = createPiMock();
		expect(() => pi.getHandlerOrThrow("session_start")).toThrow(/no handler/);
	});

	// #2866 review F7: the budget's own timer is `setTimeout` inside
	// `clients/deadline-utils`, so it is fakeable — a real 5s wait bought
	// nothing but a wall-clock admission this suite does not need.
	it("fails a session_start handler that never settles", async () => {
		vi.useFakeTimers();
		try {
			const pi = createPiMock();
			pi.on("session_start", () => new Promise<never>(() => {}));

			const settled = pi.emit("session_start", {}, makeCtx());
			const assertion = expect(settled).rejects.toThrow(
				/session_start handler exceeded test budget/,
			);
			await vi.advanceTimersByTimeAsync(SESSION_START_TEST_BUDGET_MS);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("runCommand invokes the handler and captures notifications", async () => {
		const pi = createPiMock();
		pi.registerCommand("greet", {
			handler: (_args, ctx) => {
				ctx.ui.notify("hello", "info");
			},
		});
		const ctx = makeCtx();
		await pi.runCommand("greet", "", ctx);
		expect(ctx.notifications).toEqual([{ message: "hello", type: "info" }]);
	});
});

/**
 * #3855 (verify r2 V1): pi-lens keys a file-less successor by its session
 * manager's identity. The recurrence: the mock minted a manager per ctx, where
 * pi 1.0.4 hands a /reload or in-memory /fork successor its predecessor's
 * object (`core/agent-session.js` `_buildRuntime` builds the runner from
 * `this.sessionManager`; `core/extensions/runner.js` returns
 * `runner.sessionManager`; the in-memory `fork()` passes
 * `this.session.sessionManager`), and a rule clause (J6) was written to keep
 * that double green.
 */
describe("createPiMock session-manager identity (#3855)", () => {
	async function replace(
		shutdown: Record<string, unknown>,
		startReason: string,
	) {
		const dying = createPiMock();
		const successor = createPiMock();
		const before = makeCtx({ sessionId: "s1" });
		const after = makeCtx({ sessionId: "s2", sessionFile: "/s/two.jsonl" });
		const beforeManager = before.sessionManager;
		await dying.emit("session_shutdown", shutdown, before);
		await successor.emit(
			"session_start",
			{ type: "session_start", reason: startReason },
			after,
		);
		return { beforeManager, after };
	}

	for (const shutdown of [{ reason: "reload" }, { reason: "fork" }] as const) {
		it(`hands the ${shutdown.reason} successor its predecessor's manager, with its own id and file`, async () => {
			const { beforeManager, after } = await replace(shutdown, shutdown.reason);
			expect(after.sessionManager).toBe(beforeManager);
			expect(after.sessionManager.getSessionId()).toBe("s2");
			expect(after.sessionManager.getSessionFile()).toBe("/s/two.jsonl");
		});
	}

	for (const [shutdown, startReason] of [
		[{ reason: "fork", targetSessionFile: "/s/fork.jsonl" }, "fork"],
		[{ reason: "new" }, "new"],
		[{ reason: "resume", targetSessionFile: "/s/r.jsonl" }, "resume"],
		[{ reason: "reload" }, "startup"],
	] as const) {
		it(`keeps a new manager where pi builds one (${shutdown.reason} -> ${startReason})`, async () => {
			const { beforeManager, after } = await replace(shutdown, startReason);
			expect(after.sessionManager).not.toBe(beforeManager);
		});
	}

	// A hand-over a test never consumed must not reach the next test, where a
	// first reload start would adopt a stale manager and its stale ticket.
	it("leaves a reload hand-over unconsumed (sets up the next test)", async () => {
		await createPiMock().emit(
			"session_shutdown",
			{ reason: "reload" },
			makeCtx({ sessionId: "stale" }),
		);
	});

	it("starts the next test with no hand-over pending", async () => {
		const fresh = makeCtx({ sessionId: "fresh" });
		const own = fresh.sessionManager;
		await createPiMock().emit("session_start", { reason: "reload" }, fresh);
		expect(fresh.sessionManager).toBe(own);
	});

	it("hands a manager over once", async () => {
		const pi = createPiMock();
		const before = makeCtx({ sessionId: "s1" });
		await pi.emit("session_shutdown", { reason: "reload" }, before);
		const first = makeCtx({ sessionId: "s1" });
		const second = makeCtx({ sessionId: "s1" });
		await pi.emit("session_start", { reason: "reload" }, first);
		await pi.emit("session_start", { reason: "reload" }, second);
		expect(first.sessionManager).toBe(before.sessionManager);
		expect(second.sessionManager).not.toBe(before.sessionManager);
	});
});

// #5146: the double's own cases start sessions too (the never-settling handler
// below); end them here so the root gate in pi-mock.ts has nothing to red.
afterEach(async () => {
	await endMockSessions();
});

/**
 * #5146: the double itself reports every session its handlers saw, and a case
 * that ends with one open reds. Recurrence: a test that emitted `session_start`
 * and never `session_shutdown` left the `ast-grep lsp` child its `tool_result`
 * spawned alive past its file, where
 * `tests/index-4632-s7-turn-end-ordering.test.ts`'s orphan sweep reached it
 * (PR #5161 shard 5, job 124892873231). The previous guard was a scan of how
 * each file spelled the start, and PR #5163's review found seven importers and
 * five spellings it let through; this one is a verdict on what the double
 * observed, so each start route below is a plant for it.
 */
describe("createPiMock sessions and the shared teardown (#5146)", () => {
	type Pi = ReturnType<typeof createPiMock>;
	const START = { type: "session_start", reason: "startup" };
	const SHUTDOWN = { type: "session_shutdown", reason: "quit" };

	/** A host with a session_start and a session_shutdown handler, as the extension has. */
	function host(): { pi: Pi; ended: string[] } {
		const pi = createPiMock();
		const ended: string[] = [];
		pi.on("session_start", () => {});
		pi.on("session_shutdown", (_event, ctx) => {
			ended.push(
				(
					ctx as { sessionManager: { getSessionId(): string } }
				).sessionManager.getSessionId(),
			);
		});
		return { pi, ended };
	}
	const ctxOf = (id: string) => makeCtx({ cwd: `/p/${id}`, sessionId: id });

	it("ends the open sessions newest first, skips one ended by hand, and ends none twice", async () => {
		const { pi, ended } = host();
		for (const id of ["a", "b", "c"])
			await pi.emit("session_start", START, ctxOf(id));
		// By hand, on a fresh ctx of the same session, as the pre-#5146 files do.
		await pi.emit("session_shutdown", SHUTDOWN, ctxOf("b"));
		expect(ended).toEqual(["b"]);

		await endMockSessions();
		expect(ended).toEqual(["b", "c", "a"]);

		await endMockSessions();
		expect(ended).toEqual(["b", "c", "a"]);
	});

	it("counts one session when several handlers receive the same start", async () => {
		const pi = createPiMock();
		pi.on("session_start", () => {});
		pi.on("session_start", () => {});
		const ended: string[] = [];
		pi.on("session_shutdown", () => {
			ended.push("1");
		});
		pi.on("session_shutdown", () => {
			ended.push("2");
		});
		await pi.emit("session_start", START, ctxOf("m"));
		await expect(failOnOpenMockSessions()).rejects.toThrow(
			/^1 pi-mock session\(s\) still open/,
		);
		// One shutdown emit reached both handlers, once.
		expect(ended).toEqual(["1", "2"]);
	});

	// Every route to a session_start handler leaves the session open unless
	// something ends it. A scan of the test source had to know each spelling.
	it.each<[string, (pi: Pi, ctx: unknown) => Promise<unknown>]>([
		["emit", (pi, ctx) => pi.emit("session_start", START, ctx)],
		[
			"an aliased bound emit",
			async (pi, ctx) => {
				const go = pi.emit.bind(pi);
				await go("session_start", START, ctx);
			},
		],
		[
			"a computed member built at run time",
			async (pi, ctx) => {
				await (pi as unknown as Record<string, Function>)["em" + "it"](
					"session_" + "start",
					START,
					ctx,
				);
			},
		],
		[
			"a destructured emit",
			async (pi, ctx) => {
				const { emit } = pi;
				await emit.call(pi, "session_start", START, ctx);
			},
		],
		[
			"a handler out of getHandlers",
			async (pi, ctx) => {
				await pi.getHandlers("session_start")[0](START, ctx);
			},
		],
		[
			"a loop over the handlers map",
			async (pi, ctx) => {
				for (const h of pi.handlers.get("session_start") ?? []) {
					await h(START, ctx);
				}
			},
		],
		[
			"a wrapper in a support module",
			async (pi, ctx) => {
				const startThere = (p: Pi) => p.emit("session_start", START, ctx);
				await startThere(pi);
			},
		],
		[
			"the reload helper after a hand shutdown",
			async (pi, ctx) => {
				await pi.emit("session_start", START, ctx);
				await pi.emit("session_shutdown", SHUTDOWN, ctx);
				await pi.simulateSessionShutdownAndRebuild("reload", ctx);
			},
		],
	])(
		"reds a case that started a session through %s and ended none",
		async (_name, start) => {
			const { pi, ended } = host();
			await start(pi, ctxOf("x"));
			const shutdownsBefore = ended.length;
			await expect(failOnOpenMockSessions()).rejects.toThrow(
				/^1 pi-mock session\(s\) still open when the case ended; call endMockSessions\(\)/,
			);
			// The gate ended it, so the next case starts clean.
			expect(ended.length - shutdownsBefore).toBe(1);
			await expect(failOnOpenMockSessions()).resolves.toBeUndefined();
		},
	);

	it("reds a case whose shutdown ended only one of its two sessions", async () => {
		// Recurrence: a file excused whole by one hand-written shutdown (index-3814
		// 29 cases, index-wiring 12, ...: 61 cases in 7 files left a session open).
		const { pi, ended } = host();
		await pi.emit("session_start", START, ctxOf("a"));
		await pi.emit("session_start", START, ctxOf("b"));
		await pi.emit("session_shutdown", SHUTDOWN, ctxOf("a"));
		await expect(failOnOpenMockSessions()).rejects.toThrow(
			/^1 pi-mock session/,
		);
		expect(ended).toEqual(["a", "b"]);
	});

	it.each<[string, (pi: Pi, ctx: unknown) => Promise<unknown>]>([
		["endMockSessions", () => endMockSessions()],
		[
			"a shutdown emit by hand",
			(pi, ctx) => pi.emit("session_shutdown", SHUTDOWN, ctx),
		],
		[
			"a shutdown handler called directly",
			async (pi, ctx) => {
				await pi.getHandlers("session_shutdown")[0](SHUTDOWN, ctx);
			},
		],
	])("passes a case that ended its session through %s", async (_name, end) => {
		const { pi, ended } = host();
		await pi.emit("session_start", START, ctxOf("y"));
		await end(pi, ctxOf("y"));
		await expect(failOnOpenMockSessions()).resolves.toBeUndefined();
		expect(ended).toEqual(["y"]);
	});

	// Recurrence: the gate above is only a function until `pi-mock.ts` registers
	// it. A root `afterEach` deleted, commented out, or moved inside a function
	// that never runs leaves every importer ungated while this file stays green.
	// The one file read is our own, and the form is the whole contract.
	const ROOT_GATE =
		/^afterEach\(async \(\) => \{\s*await failOnOpenMockSessions\(\);\s*\}\);$/m;
	const gated = (source: string) =>
		ROOT_GATE.test(stripSource(source, { strings: "blank" }));

	it("pi-mock.ts registers the gate as a root afterEach", () => {
		expect(
			gated(readFileSync(resolve(import.meta.dirname, "pi-mock.ts"), "utf8")),
		).toBe(true);
	});

	it.each([
		[
			"commented out",
			"// afterEach(async () => {\n//\tawait failOnOpenMockSessions();\n// });\n",
		],
		[
			"inside a function that never runs",
			"function later() {\n\tafterEach(async () => {\n\t\tawait failOnOpenMockSessions();\n\t});\n}\n",
		],
		[
			"registered without the gate call",
			"afterEach(async () => {\n\tawait other();\n});\n",
		],
	])("does not read a gate that is %s as registered", (_name, source) => {
		expect(gated(source)).toBe(false);
	});
});
