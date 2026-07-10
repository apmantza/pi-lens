import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetAgentNudgeForTests,
	consumeAgentNudge,
	isAgentNudgeEnabled,
	recordCrossProcessTouches,
	wireAgentNudgeSubscriber,
} from "../../clients/agent-nudge.js";
import { createReadGuard, type ReadRecord } from "../../clients/read-guard.js";
import { logReadGuardEvent } from "../../clients/read-guard-logger.js";

// Suppress log writes — tests care about nudge behavior, not read-guard log output.
vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

const logLatency = vi.fn();
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: (...args: unknown[]) => logLatency(...args),
}));

vi.mock("../../clients/file-time.js", () => ({
	createFileTime: (_sessionId: string) => ({
		read: vi.fn(),
		hasChanged: vi.fn(() => false),
		assert: vi.fn(),
		get: vi.fn(),
	}),
	FileTimeError: class FileTimeError extends Error {
		constructor(
			message: string,
			readonly filePath: string,
			readonly reason: "not-read" | "modified",
		) {
			super(message);
		}
	},
}));

function createReadRecord(
	filePath: string,
	overrides: Partial<ReadRecord> = {},
): ReadRecord {
	return {
		filePath,
		requestedOffset: 1,
		requestedLimit: 100,
		effectiveOffset: 1,
		effectiveLimit: 100,
		expandedByLsp: false,
		turnIndex: 1,
		writeIndex: 1,
		timestamp: Date.now(),
		...overrides,
	};
}

function makeBus() {
	const handlers: Array<(data: unknown) => void> = [];
	return {
		on: vi.fn((_channel: string, handler: (data: unknown) => void) => {
			handlers.push(handler);
			return () => {
				const idx = handlers.indexOf(handler);
				if (idx >= 0) handlers.splice(idx, 1);
			};
		}),
		emit(data: unknown) {
			for (const h of handlers) h(data);
		},
	};
}

function touchedPayload(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		v: 1,
		source: "pi-lens",
		reason: "autofix",
		paths: ["/repo/src/a.ts"],
		cwd: "/repo",
		...overrides,
	};
}

describe("agent-nudge — inline context nudge for out-of-view mutations (#485)", () => {
	const originalEnv = process.env.PI_LENS_AGENT_NUDGE;

	beforeEach(() => {
		_resetAgentNudgeForTests();
		vi.mocked(logReadGuardEvent).mockClear();
	});

	afterEach(() => {
		_resetAgentNudgeForTests();
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_AGENT_NUDGE;
		} else {
			process.env.PI_LENS_AGENT_NUDGE = originalEnv;
		}
	});

	it("is enabled by default (no env var set)", () => {
		delete process.env.PI_LENS_AGENT_NUDGE;
		_resetAgentNudgeForTests();
		expect(isAgentNudgeEnabled()).toBe(true);
	});

	it("empty accumulator ⇒ consumeAgentNudge returns undefined (zero bytes injected)", () => {
		expect(consumeAgentNudge()).toBeUndefined();
	});

	it("feature-detects a missing pi.events.on and no-ops without throwing", () => {
		expect(() =>
			wireAgentNudgeSubscriber({
				events: undefined,
				getReadGuard: () => createReadGuard("s1"),
			}),
		).not.toThrow();
		expect(() =>
			wireAgentNudgeSubscriber({
				events: {},
				getReadGuard: () => createReadGuard("s1"),
			}),
		).not.toThrow();
	});

	it("relevance filter: nudges for a file the session has READ", () => {
		const guard = createReadGuard("s1");
		guard.recordRead(createReadRecord("/repo/src/a.ts"));

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });

		bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"] }));

		const result = consumeAgentNudge();
		expect(result).toBeDefined();
		expect(result?.messages[0].role).toBe("user");
		expect(result?.messages[0].content).toContain("a.ts");
		expect(result?.messages[0].content).toContain("re-read before editing");
	});

	it("relevance filter: silently drops a file the session never read or edited", () => {
		const guard = createReadGuard("s1"); // never reads/edits anything

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });

		bus.emit(touchedPayload({ paths: ["/repo/src/unseen.ts"] }));

		expect(consumeAgentNudge()).toBeUndefined();
	});

	it("agent_nudge phase reports filesFiltered = relevance drops, not display overflow", () => {
		logLatency.mockClear();
		const guard = createReadGuard("s1");
		guard.recordRead(createReadRecord("/repo/src/seen.ts"));

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });

		// One relevant file + two never-seen files in the same payload.
		bus.emit(
			touchedPayload({
				paths: ["/repo/src/seen.ts", "/repo/src/x.ts", "/repo/src/y.ts"],
			}),
		);

		expect(consumeAgentNudge()).toBeDefined();
		const phase = logLatency.mock.calls
			.map((c) => c[0] as { phase?: string; metadata?: Record<string, unknown> })
			.find((e) => e.phase === "agent_nudge");
		expect(phase?.metadata).toMatchObject({
			filesTotal: 1,
			filesShown: 1,
			filesFiltered: 2,
		});

		// The filter counter drains with the consume — a second consume must
		// not re-report the same drops.
		logLatency.mockClear();
		guard.recordRead(createReadRecord("/repo/src/z.ts"));
		bus.emit(touchedPayload({ paths: ["/repo/src/z.ts"] }));
		expect(consumeAgentNudge()).toBeDefined();
		const phase2 = logLatency.mock.calls
			.map((c) => c[0] as { phase?: string; metadata?: Record<string, unknown> })
			.find((e) => e.phase === "agent_nudge");
		expect(phase2?.metadata).toMatchObject({ filesFiltered: 0 });
	});

	it("relevance filter honors cross-form paths: read recorded with backslashes, bus event uses forward slashes", () => {
		const guard = createReadGuard("s1");
		// Read recorded in Windows-native backslash form (as the Read tool gives).
		guard.recordRead(createReadRecord("C:\\repo\\src\\b.ts"));

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });

		// Bus payload arrives slash-normalized (bus-publish.ts normalizes via
		// normalizeFilePath before emitting) for the SAME file.
		bus.emit(touchedPayload({ paths: ["C:/repo/src/b.ts"] }));

		const result = consumeAgentNudge();
		expect(result).toBeDefined();
		expect(result?.messages[0].content).toContain("b.ts");
	});

	it("relevance filter: nudges for a file the session EDITED (not just read)", () => {
		const guard = createReadGuard("s1");
		guard.recordRead(createReadRecord("/repo/src/edited.ts"));
		guard.checkEdit("/repo/src/edited.ts", [1, 1]);

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });

		bus.emit(touchedPayload({ paths: ["/repo/src/edited.ts"] }));

		const result = consumeAgentNudge();
		expect(result).toBeDefined();
	});

	it("dedupes repeated events for the same path across the turn-gap", () => {
		const guard = createReadGuard("s1");
		guard.recordRead(createReadRecord("/repo/src/a.ts"));

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });

		bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"], reason: "autofix" }));
		bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"], reason: "format" }));
		bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"], reason: "autofix" }));

		const result = consumeAgentNudge();
		expect(result).toBeDefined();
		// Exactly one file counted despite three events.
		expect(result?.messages[0].content).toMatch(/^\[pi-lens automated context.*\] pi-lens: 1 file/);
	});

	it("caps the visible name list at 5 and summarizes the rest as 'and N more'", () => {
		const guard = createReadGuard("s1");
		const paths = Array.from({ length: 8 }, (_, i) => `/repo/src/f${i}.ts`);
		for (const p of paths) guard.recordRead(createReadRecord(p));

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
		bus.emit(touchedPayload({ paths }));

		const result = consumeAgentNudge();
		expect(result).toBeDefined();
		const content = result?.messages[0].content ?? "";
		expect(content).toContain("8 file(s)");
		expect(content).toContain("and 3 more");
		// Only 5 concrete names should appear before the "and N more" tail.
		const nameCount = paths.filter((p) => content.includes(p.split("/").pop() as string)).length;
		expect(nameCount).toBe(5);
	});

	it("kill switch: PI_LENS_AGENT_NUDGE=0 disables both accumulation and injection", () => {
		process.env.PI_LENS_AGENT_NUDGE = "0";
		_resetAgentNudgeForTests();

		const guard = createReadGuard("s1");
		guard.recordRead(createReadRecord("/repo/src/a.ts"));

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
		bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"] }));

		expect(consumeAgentNudge()).toBeUndefined();
	});

	it("ignores malformed / mismatched-version payloads without throwing", () => {
		const guard = createReadGuard("s1");
		guard.recordRead(createReadRecord("/repo/src/a.ts"));

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });

		expect(() => bus.emit(null)).not.toThrow();
		expect(() => bus.emit({ v: 2, source: "pi-lens", reason: "autofix", paths: ["/repo/src/a.ts"] })).not.toThrow();
		expect(() => bus.emit({ v: 1, source: "someone-else", reason: "autofix", paths: ["/repo/src/a.ts"] })).not.toThrow();

		expect(consumeAgentNudge()).toBeUndefined();
	});

	it("consumeAgentNudge clears the accumulator (one message max per turn-gap)", () => {
		const guard = createReadGuard("s1");
		guard.recordRead(createReadRecord("/repo/src/a.ts"));

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
		bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"] }));

		expect(consumeAgentNudge()).toBeDefined();
		// Second consume in the same "next turn" sees nothing new.
		expect(consumeAgentNudge()).toBeUndefined();
	});

	it("survives across a run boundary: accumulated at run A's turn_end, injected at run B's first turn_start-equivalent context call", () => {
		// The bus event lands after run A's LAST turn_end (a deferred-cascade
		// autofix settling post-tool-result). Nothing calls consumeAgentNudge
		// before agent_end/agent_settled fire for run A — this module has no
		// listener on either event, by design (#485 cross-run requirement: only
		// consumeAgentNudge() itself may clear the accumulator).
		const guard = createReadGuard("s1");
		guard.recordRead(createReadRecord("/repo/src/a.ts"));

		const bus = makeBus();
		wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
		bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"], reason: "autofix" }));

		// Simulate run A ending: agent_end / agent_settled fire in the real
		// host, but neither has a handler that touches the accumulator, so
		// nothing here clears it — that's the point being tested.

		// Run B starts; its first LLM call fires `context` (transformContext
		// runs on every provider call, including the first one of a fresh
		// agent_start — see clients/agent-nudge.ts header). The nudge must
		// still be there and attribute the change to pi-lens so a `git status`
		// at the top of run B gets an answer instead of triggering investigation.
		const result = consumeAgentNudge();
		expect(result).toBeDefined();
		expect(result?.messages[0].content).toContain("pi-lens");
		expect(result?.messages[0].content).toContain("a.ts");
		expect(result?.messages[0].content).toContain("working-tree changes to these are expected");
	});

	it("never publishes back to the bus (read-only subscriber)", () => {
		const guard = createReadGuard("s1");
		guard.recordRead(createReadRecord("/repo/src/a.ts"));

		const bus = makeBus();
		const emitSpy = vi.fn();
		wireAgentNudgeSubscriber({
			events: { on: bus.on, emit: emitSpy } as unknown as {
				on: typeof bus.on;
			},
			getReadGuard: () => guard,
		});
		bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"] }));
		consumeAgentNudge();

		expect(emitSpy).not.toHaveBeenCalled();
	});

	describe("#492: cross-process origin merge + framing", () => {
		it("a pure cross-process batch uses the 'another pi-lens instance' framing", () => {
			recordCrossProcessTouches([
				{ path: "/repo/src/child.ts", reason: "autofix" },
			]);

			const result = consumeAgentNudge();
			expect(result).toBeDefined();
			expect(result?.messages[0].content).toContain(
				"by another pi-lens instance (e.g. a subagent's)",
			);
			expect(result?.messages[0].content).not.toContain("after your last turn");
		});

		it("a pure local batch keeps the original #485 wording unchanged", () => {
			const guard = createReadGuard("s1");
			guard.recordRead(createReadRecord("/repo/src/a.ts"));
			const bus = makeBus();
			wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
			bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"] }));

			const result = consumeAgentNudge();
			expect(result?.messages[0].content).toContain("after your last turn");
			expect(result?.messages[0].content).not.toContain("another pi-lens instance");
		});

		it("a mixed batch (local + cross-process) produces ONE message that never assigns local files to another instance", () => {
			const guard = createReadGuard("s1");
			guard.recordRead(createReadRecord("/repo/src/a.ts"));
			const bus = makeBus();
			wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
			bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"] }));
			recordCrossProcessTouches([
				{ path: "/repo/src/child.ts", reason: "autofix" },
			]);

			const result = consumeAgentNudge();
			expect(result?.messages).toHaveLength(1);
			expect(result?.messages[0].content).toContain("2 file(s)");
			// Mixed framing: local base wording + exact cross-process count. The
			// whole-batch "were autofixed by another pi-lens instance" clause must
			// NOT be used here — that would misattribute the local file too.
			expect(result?.messages[0].content).toContain(
				"after your last turn (1 of them by another pi-lens instance)",
			);
			expect(result?.messages[0].content).not.toContain(
				"autofixed by another pi-lens instance",
			);
		});

		it("mixed-batch attribution counts the cross-process portion exactly (2 of 3)", () => {
			const guard = createReadGuard("s1");
			guard.recordRead(createReadRecord("/repo/src/a.ts"));
			const bus = makeBus();
			wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
			bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"] }));
			recordCrossProcessTouches([
				{ path: "/repo/src/child1.ts", reason: "autofix" },
				{ path: "/repo/src/child2.ts", reason: "autofix" },
			]);

			const result = consumeAgentNudge();
			expect(result?.messages[0].content).toContain("3 file(s)");
			expect(result?.messages[0].content).toContain(
				"after your last turn (2 of them by another pi-lens instance)",
			);
		});

		it("local+cross-process merge rule: a file seen via BOTH channels reads as local (sticky), never split", () => {
			recordCrossProcessTouches([
				{ path: "/repo/src/shared.ts", reason: "autofix" },
			]);
			const guard = createReadGuard("s1");
			guard.recordRead(createReadRecord("/repo/src/shared.ts"));
			const bus = makeBus();
			wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
			bus.emit(touchedPayload({ paths: ["/repo/src/shared.ts"] }));

			const result = consumeAgentNudge();
			// Only one file total (merged, not duplicated) and — because the SAME
			// file is now also known locally — the batch reads as pure local, not
			// cross-process (the "local is sticky" rule).
			expect(result?.messages[0].content).toContain("1 file(s)");
			expect(result?.messages[0].content).toContain("after your last turn");
			expect(result?.messages[0].content).not.toContain("another pi-lens instance");
		});

		it("the reverse order (local first, then the SAME file arrives via cross-process) still reads as local", () => {
			const guard = createReadGuard("s1");
			guard.recordRead(createReadRecord("/repo/src/shared.ts"));
			const bus = makeBus();
			wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
			bus.emit(touchedPayload({ paths: ["/repo/src/shared.ts"] }));
			recordCrossProcessTouches([
				{ path: "/repo/src/shared.ts", reason: "format" },
			]);

			const result = consumeAgentNudge();
			expect(result?.messages[0].content).toContain("1 file(s)");
			expect(result?.messages[0].content).not.toContain("another pi-lens instance");
		});

		it("agent_nudge phase metadata reports the local/cross-process origin mix", () => {
			logLatency.mockClear();
			const guard = createReadGuard("s1");
			guard.recordRead(createReadRecord("/repo/src/a.ts"));
			const bus = makeBus();
			wireAgentNudgeSubscriber({ events: bus, getReadGuard: () => guard });
			bus.emit(touchedPayload({ paths: ["/repo/src/a.ts"] }));
			recordCrossProcessTouches([
				{ path: "/repo/src/child1.ts", reason: "autofix" },
				{ path: "/repo/src/child2.ts", reason: "format" },
			]);

			expect(consumeAgentNudge()).toBeDefined();
			const phase = logLatency.mock.calls
				.map((c) => c[0] as { phase?: string; metadata?: Record<string, unknown> })
				.find((e) => e.phase === "agent_nudge");
			expect(phase?.metadata).toMatchObject({
				originLocal: 1,
				originCrossProcess: 2,
			});
		});

		it("cross-process entries bypass the read-guard relevance filter (recordCrossProcessTouches has no guard dependency)", () => {
			// No read-guard subscription wired at all — recordCrossProcessTouches
			// is called directly, as the index.ts turn_start/session_start
			// consumers do after their OWN upstream relevance decision.
			recordCrossProcessTouches([
				{ path: "/repo/src/never-read.ts", reason: "autofix" },
			]);

			const result = consumeAgentNudge();
			expect(result).toBeDefined();
			expect(result?.messages[0].content).toContain("never-read.ts");
		});

		it("kill switch: PI_LENS_AGENT_NUDGE=0 disables recordCrossProcessTouches too", () => {
			process.env.PI_LENS_AGENT_NUDGE = "0";
			_resetAgentNudgeForTests();

			recordCrossProcessTouches([
				{ path: "/repo/src/child.ts", reason: "autofix" },
			]);

			expect(consumeAgentNudge()).toBeUndefined();
		});
	});
});
