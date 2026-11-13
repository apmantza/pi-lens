import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import {
	MAX_OWED_ANCHORS,
	RuntimeCoordinator,
} from "../../clients/runtime-coordinator.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { createFileTime } from "../../clients/file-time.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	beginScope,
	bindSessionId,
	retireScope,
	type SessionScope,
} from "../../clients/session-scope.js";

describe("RuntimeCoordinator", () => {
	it("resetForSession clears recorded tool-call path attributions (#1642 F5)", () => {
		// A per-session-numbered host (or a fresh session after a crash) must
		// never let a new session inherit a dead session's recorded skip
		// verdict for a reused tool-call id — every sibling correlation/state
		// map is cleared on resetForSession, and this one must be too.
		const runtime = new RuntimeCoordinator();
		runtime.recordToolCallAttribution("call-reused-id", {
			resolvedPath: path.resolve("src/dead-session-file.ts"),
			skipped: true,
			originCwd: path.resolve("."),
		});

		runtime.resetForSession();

		expect(runtime.takeToolCallAttribution("call-reused-id")).toBeUndefined();
	});

	it("resetForSession clears applied-edit retry records (#2402)", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/applied-session-file.ts");
		runtime.partialApplyRecords.record(filePath, "old text", "new text");

		expect(
			runtime.partialApplyRecords.find(filePath, "old text", "new text"),
		).toBeDefined();

		runtime.resetForSession();

		expect(
			runtime.partialApplyRecords.find(filePath, "old text", "new text"),
		).toBeUndefined();
	});

	/** #3613: one code-quality record, named by the session that recorded it. */
	const quality = (rule: string) => ({
		id: `cq:${rule}`,
		filePath: path.resolve("src/quality.ts"),
		displayPath: "src/quality.ts",
		line: 1,
		severity: "warning" as const,
		tool: "ast-grep",
		rule,
		message: rule,
		category: "maintainability" as const,
		origin: "dispatch" as const,
	});
	const rules = (records: { rule?: string }[]) => records.map((r) => r.rule);

	/**
	 * #4965: what a concurrent secondary's `session_start` does in index.ts: it
	 * begins the session's scope and binds it to the session id, so the
	 * coordinator finds the secondary's per-turn cells by id.
	 */
	const startSecondary = (sessionId: string): SessionScope => {
		const scope = beginScope({ role: "secondary" });
		bindSessionId(scope, sessionId);
		return scope;
	};

	it("resetForSession drops the outgoing session's turn warnings and keeps a concurrent session's (#3613)", () => {
		// The recurrences: a reset that clears every partition drops a live
		// subagent's warnings at the primary's /new, and one that clears none
		// carries a /reload's (same session id) old warnings into its turn.
		const runtime = new RuntimeCoordinator();
		runtime.setSessionLifecycle({ sessionId: "primary-session" });
		startSecondary("subagent-session");
		runtime.recordCodeQualityWarnings([quality("own")]);
		runtime.recordCodeQualityWarnings([quality("sub")], "subagent-session");

		runtime.resetForSession();
		runtime.setSessionLifecycle({ sessionId: "primary-session" });

		expect({
			own: rules(runtime.peekCodeQualityWarnings()),
			sub: rules(runtime.peekCodeQualityWarnings("subagent-session")),
		}).toEqual({ own: [], sub: ["sub"] });
	});

	it("forgetTurnSession never drops this coordinator's own turn warnings (#3613)", () => {
		// The recurrence: a secondary shutdown with no session id of its own,
		// or the coordinator's id, cleared the primary's partition.
		const runtime = new RuntimeCoordinator();
		startSecondary("subagent-session");
		runtime.recordCodeQualityWarnings([quality("own")]);
		runtime.recordCodeQualityWarnings([quality("sub")], "subagent-session");

		runtime.forgetTurnSession(undefined);
		runtime.forgetTurnSession(runtime.telemetrySessionId);
		const kept = rules(runtime.peekCodeQualityWarnings());
		runtime.forgetTurnSession("subagent-session");

		expect({
			kept,
			sub: rules(runtime.peekCodeQualityWarnings("subagent-session")),
		}).toEqual({ kept: ["own"], sub: [] });
	});

	/** #4965: one actionable record; the actionable store is the seam's other tenant. */
	const actionable = (name: string) => ({
		id: `act:${name}`,
		filePath: path.resolve("src/actionable.ts"),
		displayPath: "src/actionable.ts",
		line: 1,
		severity: "warning" as const,
		tool: "ast-grep",
		rule: name,
		message: name,
		actions: [],
		suppressed: false,
		origin: "dispatch" as const,
	});

	it("the actionable-warning partitions follow the same session rules as the code-quality ones (#4965)", () => {
		// RECURRENCE GUARDED: #4965 moved both stores onto scope cells. A drain that
		// dropped every session's partition, or none, would only show on the half a
		// test exercised: the first cut covered code-quality alone.
		const runtime = new RuntimeCoordinator();
		runtime.setSessionLifecycle({ sessionId: "primary-session" });
		const peek = (sessionId?: string) =>
			rules(runtime.peekActionableWarnings(sessionId));
		for (const id of ["sub-a", "sub-b", "sub-c"]) startSecondary(id);

		runtime.recordActionableWarnings([actionable("own")]);
		runtime.recordActionableWarnings([actionable("sub-a")], "sub-a");
		runtime.recordActionableWarnings([actionable("sub-b")], "sub-b");
		runtime.recordActionableWarnings([actionable("sub-b2")], "sub-b");
		expect({ own: peek(), a: peek("sub-a"), b: peek("sub-b") }).toEqual({
			own: ["own"],
			a: ["sub-a"],
			b: ["sub-b", "sub-b2"],
		});

		runtime.forgetTurnSession("sub-a");
		expect({ own: peek(), a: peek("sub-a"), b: peek("sub-b") }).toEqual({
			own: ["own"],
			a: [],
			b: ["sub-b", "sub-b2"],
		});

		runtime.beginTurn("sub-b");
		expect({ own: peek(), b: peek("sub-b") }).toEqual({
			own: ["own"],
			b: [],
		});

		runtime.recordActionableWarnings([actionable("sub-c")], "sub-c");
		runtime.resetForSession();
		runtime.setSessionLifecycle({ sessionId: "primary-session" });
		expect({ own: peek(), c: peek("sub-c") }).toEqual({
			own: [],
			c: ["sub-c"],
		});

		runtime.clearActionableWarnings("sub-c");
		expect(peek("sub-c")).toEqual([]);
	});

	it("a concurrent session's turn warnings end with its scope, without a forgetTurnSession call (#4965)", () => {
		// RECURRENCE GUARDED: shape 72. The partitions were a process table that
		// only an explicit forget (or the coordinator's reset) ended, so a
		// secondary retired by any other path left both partitions behind.
		const runtime = new RuntimeCoordinator();
		const sub = startSecondary("sub-retired");
		runtime.recordActionableWarnings([actionable("a")], "sub-retired");
		runtime.recordCodeQualityWarnings([quality("q")], "sub-retired");

		retireScope(sub, "shutdown");

		expect({
			actionable: rules(runtime.peekActionableWarnings("sub-retired")),
			quality: rules(runtime.peekCodeQualityWarnings("sub-retired")),
		}).toEqual({ actionable: [], quality: [] });
	});

	it("a write for a session with no live scope is dropped and counted once per store (#4965)", () => {
		// RECURRENCE GUARDED: the resurrection a process table allowed. A late
		// tool result for a retired session (or one that never started here)
		// re-created its partition, which nothing then ended.
		resetDegradationLedger();
		const runtime = new RuntimeCoordinator();
		const sub = startSecondary("sub-late");
		retireScope(sub, "shutdown");

		runtime.recordActionableWarnings([actionable("late")], "sub-late");
		runtime.recordCodeQualityWarnings([quality("late")], "sub-late");
		runtime.recordCodeQualityWarnings([quality("late2")], "never-started");

		expect({
			actionable: rules(runtime.peekActionableWarnings("sub-late")),
			quality: rules(runtime.peekCodeQualityWarnings("sub-late")),
			neverStarted: rules(runtime.peekCodeQualityWarnings("never-started")),
		}).toEqual({ actionable: [], quality: [], neverStarted: [] });
		const [missed] = getDegradationSummary().filter(
			(group) => group.kind === "session-scope-lookup-missed",
		);
		expect({
			count: missed?.count,
			subjects: missed?.latestReasons.map((r) => r.subject).sort(),
		}).toEqual({
			count: 3,
			subjects: ["turn-warnings"],
		});
	});

	it("readGuardFor keys one guard per owner and answers the coordinator's own for its turns (#4942)", () => {
		// RECURRENCE GUARDED: #4942. One guard for every session of the process
		// let a subagent's read license the primary's edit. A turn with no
		// session id of its own, or the coordinator's, is the coordinator's
		// (`recordSession`'s rule, #4921); any other id is its own guard, the
		// same object on every call.
		const runtime = new RuntimeCoordinator();
		runtime.setSessionLifecycle({ sessionId: "primary-session" });
		const sub = runtime.readGuardFor("subagent-session");

		expect({
			undefinedIsOwn: runtime.readGuardFor(undefined) === runtime.readGuard,
			ownIdIsOwn: runtime.readGuardFor("primary-session") === runtime.readGuard,
			subIsSeparate: sub !== runtime.readGuard,
			subIsStable: runtime.readGuardFor("subagent-session") === sub,
			twoSubsDiffer: runtime.readGuardFor("other-session") !== sub,
		}).toEqual({
			undefinedIsOwn: true,
			ownIdIsOwn: true,
			subIsSeparate: true,
			subIsStable: true,
			twoSubsDiffer: true,
		});
	});

	it("readGuardFor ends a concurrent session's guard at its shutdown and the coordinator's reset (#4942)", () => {
		// RECURRENCE GUARDED: #4942's resource axis. A guard per owner with no
		// release is bounded along sessions-at-once and unbounded along
		// sessions-over-time. A shutdown drops its own guard only, never the
		// coordinator's; a reset drops the coordinator's and every owner's.
		const runtime = new RuntimeCoordinator();
		runtime.setSessionLifecycle({ sessionId: "primary-session" });
		const own = runtime.readGuard;
		const subA = runtime.readGuardFor("sub-a");
		const subB = runtime.readGuardFor("sub-b");

		runtime.forgetTurnSession("sub-a");
		runtime.forgetTurnSession(undefined);
		runtime.forgetTurnSession("primary-session");
		const afterShutdown = {
			aRebuilt: runtime.readGuardFor("sub-a") !== subA,
			bKept: runtime.readGuardFor("sub-b") === subB,
			ownKept: runtime.readGuard === own,
		};
		runtime.resetForSession();
		runtime.setSessionLifecycle({ sessionId: "primary-session" });

		expect({
			afterShutdown,
			bRebuiltByReset: runtime.readGuardFor("sub-b") !== subB,
			ownRebuiltByReset: runtime.readGuard !== own,
		}).toEqual({
			afterShutdown: { aRebuilt: true, bKept: true, ownKept: true },
			bRebuiltByReset: true,
			ownRebuiltByReset: true,
		});
	});

	it("forgetTurnSession releases the session's FileTime bucket and leaves the others (#4942 F8)", () => {
		// RECURRENCE GUARDED: #4955 review F8 (AGENTS shape 46). A secondary's
		// ReadGuard stamps files into the process-global FileTime map keyed by
		// session id; deleting the guard object left one bucket per retired
		// secondary session. The coordinator's own bucket and a live
		// secondary's must survive.
		const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-f8-"));
		try {
			const file = path.join(dir, "a.ts");
			writeFileSync(file, "export const a = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.setSessionLifecycle({ sessionId: "primary-f8" });
			runtime.readGuard.recordWritten(file);
			runtime.readGuardFor("sub-f8-a").recordWritten(file);
			const liveSecondary = runtime.readGuardFor("sub-f8-b");
			liveSecondary.recordWritten(file);
			// #4955 review F14: releasing the bucket must not move the shared
			// branch epoch, so the coordinator's and the live secondary's stay put.
			const epochsBefore = {
				primary: runtime.readGuard.currentBranchEpoch,
				liveSecondary: liveSecondary.currentBranchEpoch,
			};

			runtime.forgetTurnSession("sub-f8-a");

			expect({
				forgotten: createFileTime("sub-f8-a").get(file),
				liveSecondary: createFileTime("sub-f8-b").get(file) !== undefined,
				primary:
					createFileTime(runtime.telemetrySessionId).get(file) !== undefined,
				epochs: {
					primary: runtime.readGuard.currentBranchEpoch,
					liveSecondary: liveSecondary.currentBranchEpoch,
				},
			}).toEqual({
				forgotten: undefined,
				liveSecondary: true,
				primary: true,
				epochs: epochsBefore,
			});
			runtime.forgetTurnSession("sub-f8-b");
			createFileTime(runtime.telemetrySessionId).clear();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("makes edit autofix deferral sticky after a write until beginTurn", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/sticky.ts");

		expect(
			runtime.recordMutationToolReceipt(filePath, "write").autofixMode,
		).toBe("immediate");
		expect(
			runtime.recordMutationToolReceipt(filePath, "edit").autofixMode,
		).toBe("deferred");
		expect(
			runtime.recordMutationToolReceipt(filePath, "write").autofixMode,
		).toBe("deferred");

		runtime.beginTurn();
		expect(
			runtime.recordMutationToolReceipt(filePath, "write").autofixMode,
		).toBe("immediate");
	});

	it("coalesces autofix and format kinds on one owner-scoped path record", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/coalesced.ts");
		expect(
			runtime.deferMutation(
				filePath,
				process.cwd(),
				"edit",
				process.cwd(),
				"autofix",
				"owner",
			),
		).toBe(true);
		expect(
			runtime.deferMutation(
				filePath,
				process.cwd(),
				"edit",
				process.cwd(),
				"format",
				"owner",
			),
		).toBe(true);

		const [record] = runtime.consumeDeferredFormatFiles();
		expect(record.kinds).toEqual(new Set(["autofix", "format"]));
		expect(record.ownerSessionId).toBe("owner");
	});

	it("merges independently requeued kinds and tool names for one path", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/requeued.ts");
		runtime.deferMutation(
			filePath,
			process.cwd(),
			"write",
			process.cwd(),
			"autofix",
		);
		const [claimed] = runtime.consumeDeferredFormatFiles();
		runtime.requeueDeferredMutations([
			{
				...claimed,
				kinds: new Set(["autofix"]),
				toolNames: new Set(["write"]),
			},
		]);
		runtime.requeueDeferredMutations([
			{ ...claimed, kinds: new Set(["format"]), toolNames: new Set(["edit"]) },
		]);

		const [requeued] = runtime.consumeDeferredFormatFiles();
		expect(requeued.kinds).toEqual(new Set(["autofix", "format"]));
		expect(requeued.toolNames).toEqual(new Set(["write", "edit"]));
	});

	it("merges a requeued phase into a newer record queued during the drain", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = path.resolve("src/newer.ts");
		runtime.deferMutation(
			filePath,
			"old-cwd",
			"write",
			"old-root",
			"autofix",
			"old-owner",
		);
		const [claimed] = runtime.consumeDeferredFormatFiles();
		runtime.deferMutation(
			filePath,
			"new-cwd",
			"edit",
			"new-root",
			"format",
			"new-owner",
		);
		runtime.requeueDeferredMutations([claimed]);

		const [record] = runtime.consumeDeferredFormatFiles();
		expect(record.kinds).toEqual(new Set(["format", "autofix"]));
		expect(record.toolNames).toEqual(new Set(["edit", "write"]));
		expect(record.cwd).toBe("new-cwd");
		expect(record.ownerSessionId).toBe("new-owner");
	});
	it("resetForSession clears any existing read guard state", () => {
		const runtime = new RuntimeCoordinator();
		const runtimeState = runtime as any;

		runtimeState._readGuard = { sentinel: true };
		runtime.resetForSession();

		expect(runtimeState._readGuard).toBeNull();
	});

	it("accepts the hook-start boundary when resetting a session", () => {
		const runtime = new RuntimeCoordinator();
		const hookStartedAt = Date.now() - 250;

		runtime.resetForSession(hookStartedAt);

		expect(runtime.sessionStartedAt).toBe(hookStartedAt);
	});

	it("tracks first-read LSP warming and suppresses duplicate warmups", () => {
		const runtime = new RuntimeCoordinator();
		const filePath = "/tmp/example.ts";

		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(true);

		runtime.markLspReadWarmStarted(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(false);

		runtime.markLspReadWarmCompleted(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(false);

		runtime.clearLspReadWarmState(filePath);
		expect(runtime.shouldWarmLspOnRead(filePath)).toBe(true);
	});

	describe("telemetry model/provider identity (#1448)", () => {
		it("exposes the raw model id separately from the combined display string", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({
				model: "claude-sonnet-4-5",
				provider: "anthropic",
			});

			expect(runtime.telemetryModelId).toBe("claude-sonnet-4-5");
			expect(runtime.telemetryProviderId).toBe("anthropic");
			expect(runtime.telemetryModel).toBe("anthropic/claude-sonnet-4-5");
		});

		it("derives a blank provider before any identity is set", () => {
			const runtime = new RuntimeCoordinator();

			expect(runtime.telemetryModelId).toBe("");
			expect(runtime.telemetryProviderId).toBe("");
		});

		it("derives provider from a known model-id prefix when the host omits provider", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ model: "claude-sonnet-4-5" });

			expect(runtime.telemetryProviderId).toBe("anthropic");
		});

		it("leaves provider blank when the model id is ambiguous", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ model: "some-custom-finetune" });

			expect(runtime.telemetryProviderId).toBe("");
		});

		it("never lets a later ambiguous model overwrite an already-known provider", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ model: "gpt-5", provider: "openai" });
			runtime.setTelemetryIdentity({ model: "some-custom-finetune" });

			expect(runtime.telemetryProviderId).toBe("openai");
		});

		it("re-derives a DERIVED provider across a mid-session model switch with no explicit provider", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ model: "gpt-5-mini" });
			expect(runtime.telemetryProviderId).toBe("openai");

			// Switch models without an explicit provider — the stale "openai"
			// derivation must not survive; it has to re-derive for the new model.
			runtime.setTelemetryIdentity({ model: "claude-sonnet-4-5" });
			expect(runtime.telemetryProviderId).toBe("anthropic");
		});

		it("resetForSession clears the raw model/provider identity", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({
				model: "claude-sonnet-4-5",
				provider: "anthropic",
			});

			runtime.resetForSession();

			expect(runtime.telemetryModelId).toBe("");
			expect(runtime.telemetryProviderId).toBe("");
		});
	});

	describe("getFilesChangedSince (#451)", () => {
		it("returns only files bumped after the given projectSeq", () => {
			const runtime = new RuntimeCoordinator();
			const a = runtime.bumpFileSeq("/proj/a.ts"); // projectSeq 1
			runtime.bumpFileSeq("/proj/b.ts"); // projectSeq 2
			runtime.bumpFileSeq("/proj/c.ts"); // projectSeq 3

			// Since seq 1: b and c (a's last bump was at seq 1, not > 1).
			const changed = runtime.getFilesChangedSince(a.projectSeq);
			expect(changed).toHaveLength(2);
			expect(changed.some((f) => f.endsWith("/b.ts"))).toBe(true);
			expect(changed.some((f) => f.endsWith("/c.ts"))).toBe(true);
			expect(changed.some((f) => f.endsWith("/a.ts"))).toBe(false);

			// Since seq 0: all three.
			expect(runtime.getFilesChangedSince(0)).toHaveLength(3);
		});

		it("keys are separator-normalized: bump one form, query returns the other", () => {
			const runtime = new RuntimeCoordinator();
			// Record with a backslash path form.
			runtime.bumpFileSeq("C:\\proj\\src\\Widget.ts");

			const changed = runtime.getFilesChangedSince(0);
			expect(changed).toHaveLength(1);
			// The returned key is normalized to forward slashes (never backslashes),
			// so a builder keyed on forward-slash fileSignatures matches it.
			expect(changed[0]).not.toContain("\\");
			expect(changed[0].replace(/\\/g, "/").toLowerCase()).toContain(
				"proj/src/widget.ts",
			);
		});

		it("is cleared on session reset", () => {
			const runtime = new RuntimeCoordinator();
			runtime.bumpFileSeq("/proj/a.ts");
			expect(runtime.getFilesChangedSince(0)).toHaveLength(1);

			runtime.resetForSession();
			expect(runtime.getFilesChangedSince(0)).toHaveLength(0);
		});

		it("is cleared when sequences are seeded", () => {
			const runtime = new RuntimeCoordinator();
			runtime.bumpFileSeq("/proj/a.ts");
			expect(runtime.getFilesChangedSince(0)).toHaveLength(1);

			runtime.seedProjectSequence(5, new Map([["/proj/a.ts", 3]]));
			// Seeded per-file counters carry no seq provenance ⇒ empty changed map.
			expect(runtime.getFilesChangedSince(0)).toHaveLength(0);
		});
	});

	// #4137 round 3: an analysis without authorship withholds the blocker
	// channel (#3226), so its clean result says nothing about bytes an authored
	// analysis found blocking. Before this, an opaque recovery of the very bytes
	// an agent authored cleared the record whenever the already-analysed latch
	// was gone (a concurrent session's turn start, the session's own next turn).
	describe("an unauthored clean result on the recorded bytes (#4137 round 3)", () => {
		const recorded = { size: 12, sha256: "a".repeat(64) };
		let dir = "";
		let file = "";
		beforeEach(() => {
			// A live file: the snapshot drops records of deleted files (#1245).
			dir = mkdtempSync(path.join(tmpdir(), "pi-lens-same-bytes-"));
			file = path.join(dir, "same-bytes.ts");
			writeFileSync(file, "debugger;\n");
			resetDegradationLedger();
		});
		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("keeps the record, notes nothing resolved, and consumes no write order", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP L2",
				1,
				["biome"],
				[2],
				recorded,
			);
			expect(
				runtime.clearInlineBlockers(file, 2, undefined, {
					authored: false,
					sha256: recorded.sha256,
				}),
			).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
			// Other bytes are not the record's: a later clean write still clears.
			expect(
				runtime.clearInlineBlockers(file, 3, undefined, {
					authored: false,
					sha256: "b".repeat(64),
				}),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
		});

		// The refusal's observability: one ledger entry per file key, counted, so
		// a script that keeps touching a blocked file does not write a row per run.
		it("counts repeated refusals on one ledger entry per file, not one per occurrence", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP L2",
				1,
				["biome"],
				[2],
				recorded,
			);
			for (const writeIndex of [2, 3, 4]) {
				expect(
					runtime.clearInlineBlockers(file, writeIndex, undefined, {
						authored: false,
						sha256: recorded.sha256,
					}),
				).toBe(false);
			}
			const group = getDegradationSummary().find(
				(candidate) => candidate.kind === "blocker-clear-refused",
			);
			expect(group?.count).toBe(3);
			expect(group?.latestReasons).toEqual([
				{
					subject: normalizeMapKey(file),
					reason: expect.stringContaining("(count: 3)"),
				},
			]);
			// Nothing is counted when the clear is not refused.
			runtime.clearInlineBlockers(file, 5, undefined, {
				authored: false,
				sha256: "b".repeat(64),
			});
			expect(
				getDegradationSummary().find((c) => c.kind === "blocker-clear-refused")
					?.count,
			).toBe(3);
		});

		it("clears a record that carries no content baseline, as before", () => {
			// #2982: a dispatch that could not fingerprint the file (unreadable, or
			// over the baseline cap) records no hash, so nothing can match it.
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(file, "🔴 STOP L2", 1, ["biome"], [2]);
			expect(
				runtime.clearInlineBlockers(file, 2, undefined, {
					authored: false,
					sha256: undefined,
				}),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		});

		it("lets an authored clean of the same bytes clear the record", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP L2",
				1,
				["biome"],
				[2],
				recorded,
			);
			expect(
				runtime.clearInlineBlockers(file, 2, undefined, {
					authored: true,
					sha256: recorded.sha256,
				}),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		});

		// #4484: a blocker is pending until a fresh observation no longer holds
		// it. A clearing run whose own observation still holds one (an opaque
		// recovery of new bytes, whose blocker channel is withheld) left the
		// record cleared and turn end reported a false "Resolved".
		it("refuses a clear while the clearing run still observes a blocker, whatever its authorship (#4484)", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP L2",
				1,
				["biome"],
				[2],
				recorded,
			);
			for (const [writeIndex, authored] of [
				[2, false],
				[3, true],
			] as const) {
				expect(
					runtime.clearInlineBlockers(file, writeIndex, undefined, {
						authored,
						sha256: "b".repeat(64),
						blocking: 1,
					}),
				).toBe(false);
			}
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
			expect(
				getDegradationSummary().find((c) => c.kind === "blocker-clear-refused")
					?.latestReasons,
			).toEqual([
				{
					subject: normalizeMapKey(file),
					reason: expect.stringMatching(
						/still observed a blocker.*\(count: 2\)/,
					),
				},
			]);
			// An observation with nothing left clears and reports it resolved.
			expect(
				runtime.clearInlineBlockers(file, 4, undefined, {
					authored: false,
					sha256: "b".repeat(64),
					blocking: 0,
				}),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
		});
	});

	// #4484 round 2: a settled collect-later run is the only observation that
	// may retire what its runner left pending while it was in flight. Without
	// the guards it would retire another runner's blocker, a server's it never
	// heard from, or a verdict about bytes it did not read.
	describe("retireUnobservedRunnerBlockers (#4484 round 2)", () => {
		// A real file: the snapshot drops a record whose file is gone (#1245).
		let dir = "";
		let file = "";
		beforeEach(() => {
			dir = mkdtempSync(path.join(tmpdir(), "pi-lens-4484-retire-"));
			file = path.join(dir, "carry.ts");
			writeFileSync(file, "BAD_CALL();\n");
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));
		const sha256 = "c".repeat(64);
		const blocker = (
			runnerId: string,
			message: string,
			serverId?: string,
		): Diagnostic => ({
			id: `${runnerId}:${message}`,
			message,
			filePath: file,
			line: 2,
			severity: "error",
			semantic: "blocking",
			tool: runnerId === "lsp" ? "lsp" : runnerId,
			rule: `${runnerId}:rule`,
			runnerId,
			...(serverId !== undefined && { serverId }),
		});
		const record = (runtime: RuntimeCoordinator, diags: Diagnostic[]) =>
			runtime.recordInlineBlockers(
				file,
				"🔴 STOP",
				1,
				undefined,
				[2],
				{ size: 10, sha256 },
				diags,
				undefined,
				1_000,
			);

		it("retires only its own runner's unobserved blockers and keeps an unconfirmed server's", () => {
			const runtime = new RuntimeCoordinator();
			const ts = blocker("lsp", "Cannot find name 'X'.", "typescript");
			const deno = blocker("lsp", "Deno says no.", "deno");
			const lint = blocker("eslint", "no-debugger");
			record(runtime, [ts, deno, lint]);
			expect(
				runtime.retireUnobservedRunnerBlockers(file, {
					runnerId: "lsp",
					observed: [],
					markedAtMs: 2_000,
					sha256,
					unconfirmedServerIds: ["deno"],
				}),
			).toBe(1);
			expect(runtime.getInlineBlockerDiagnostics(file)).toEqual([deno, lint]);
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
		});

		it("keeps a blocker the run still observes, as its observed copy", () => {
			const runtime = new RuntimeCoordinator();
			record(runtime, [blocker("lsp", "Cannot find name 'X'.")]);
			const observed = blocker("lsp", "Cannot  find name 'x'.");
			expect(
				runtime.retireUnobservedRunnerBlockers(file, {
					runnerId: "lsp",
					observed: [observed],
					markedAtMs: 2_000,
					sha256,
				}),
			).toBe(0);
			expect(runtime.getInlineBlockerDiagnostics(file)).toHaveLength(1);
		});

		// #4484 round 3 (R3): the run is about the recorded bytes, so the
		// blocker is still observed only at its own line. Recurrence: another
		// occurrence of the same rule kept a fixed blocker (review F1).
		it("retires a blocker whose identity the run observes only at another line", () => {
			const runtime = new RuntimeCoordinator();
			record(runtime, [blocker("lsp", "Cannot find name 'X'.")]);
			expect(
				runtime.retireUnobservedRunnerBlockers(file, {
					runnerId: "lsp",
					observed: [{ ...blocker("lsp", "Cannot find name 'X'."), line: 7 }],
					markedAtMs: 2_000,
					sha256,
				}),
			).toBe(1);
		});

		it("refuses a run about other bytes, or marked before the record's read", () => {
			const runtime = new RuntimeCoordinator();
			record(runtime, [blocker("lsp", "Cannot find name 'X'.")]);
			for (const run of [
				{ markedAtMs: 2_000, sha256: "d".repeat(64) },
				{ markedAtMs: 2_000, sha256: undefined },
				{ markedAtMs: 999, sha256 },
			]) {
				expect(
					runtime.retireUnobservedRunnerBlockers(file, {
						runnerId: "lsp",
						observed: [],
						...run,
					}),
				).toBe(0);
			}
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		});

		it("deletes an emptied record and notes the file resolved", () => {
			const runtime = new RuntimeCoordinator();
			record(runtime, [blocker("lsp", "Cannot find name 'X'.")]);
			expect(
				runtime.retireUnobservedRunnerBlockers(file, {
					runnerId: "lsp",
					observed: [],
					markedAtMs: 1_000,
					sha256,
				}),
			).toBe(1);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
		});
	});

	// #4484 round 3: the anchor follows the record. Recurrence: a new
	// session's first write aligned its recorded lines (none) to a dead
	// session's bytes, or an owed range outlived the session that owed it.
	// Round 4 (G1, G3): the anchor lived in a 256-entry cache apart from the
	// record, so writes to other files evicted a live record's anchor and the
	// next edit retired its blocker with nothing to align (verify probe P18).
	describe("analysis anchor (#4484 rounds 3 to 5)", () => {
		const anchor = {
			lineHashes: Uint32Array.of(1, 2),
			owedRanges: new Map([["ast-grep-napi", [{ start: 2, end: 2 }]]]),
		};

		it("keeps the anchor on the file's record, under any spelling of its path", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers("/p/src/a.ts", "blocker A");
			runtime.setAnalysisAnchor("/p/src/../src/a.ts", anchor);
			expect(runtime.getAnalysisAnchor("/p/src/a.ts")).toBe(anchor);
		});

		it("keeps a record's anchor however many other files take anchors", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers("/p/a.ts", "blocker A");
			runtime.setAnalysisAnchor("/p/a.ts", anchor);
			for (let i = 0; i < 300; i += 1)
				runtime.setAnalysisAnchor(`/p/other-${i}.ts`, {
					lineHashes: Uint32Array.of(i),
					owedRanges: new Map(),
				});
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toBe(anchor);
		});

		// Round 5 (K2, verify probe P23): only the runner id stayed, so the
		// next write owed it the whole file. The owed lines' texts stay.
		it("drops the hashes with the record and keeps the owed line texts", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers("/p/a.ts", "blocker A");
			runtime.setAnalysisAnchor("/p/a.ts", anchor);
			runtime.clearInlineBlockers("/p/a.ts");
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toEqual({
				lineHashes: undefined,
				owedRanges: new Map(),
				owedContent: new Map([["ast-grep-napi", Uint32Array.of(2)]]),
			});
		});

		// Round 5 (K2, verify probe P23): a file with no record kept only the
		// owing runner's id. It keeps its whole anchor now, bounded; an evicted
		// file falls back to owed line texts, never the whole file.
		it("keeps a record-less file's whole anchor while a runner owes lines, then its owed texts", () => {
			const runtime = new RuntimeCoordinator();
			runtime.setAnalysisAnchor("/p/a.ts", anchor);
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toBe(anchor);
			for (let i = 0; i < MAX_OWED_ANCHORS; i += 1)
				runtime.setAnalysisAnchor(`/p/other-${i}.ts`, anchor);
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toEqual({
				lineHashes: undefined,
				owedRanges: new Map(),
				owedContent: new Map([["ast-grep-napi", Uint32Array.of(2)]]),
			});
			runtime.setAnalysisAnchor("/p/a.ts", {
				lineHashes: Uint32Array.of(1),
				owedRanges: new Map(),
			});
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toBeUndefined();
		});

		// Round 5 (K3, verify probe P25): a carry moved a blocker's line but kept
		// its line-bound id, so the settled copy at the same line joined the
		// record beside it and the turn end listed it twice.
		it("merges a settled copy of a carried blocker whose id names its old line", () => {
			const runtime = new RuntimeCoordinator();
			const carried = {
				id: "lsp:2304:2",
				message: "Cannot find name 'BAD_CALL'.",
				filePath: "/p/a.ts",
				line: 4,
				column: 1,
				severity: "error" as const,
				semantic: "blocking" as const,
				tool: "lsp",
				rule: "ts:2304",
			};
			expect(
				runtime.recordDeferredInlineBlockers("/p/a.ts", [carried], {
					recordedAtMs: 1,
				}),
			).toBe(1);
			expect(
				runtime.recordDeferredInlineBlockers(
					"/p/a.ts",
					[
						{ ...carried, id: "lsp:2304:4" },
						{ ...carried, line: 5, id: "lsp:2304:5" },
					],
					{ recordedAtMs: 2 },
				),
			).toBe(1);
			expect(runtime.getInlineBlockerDiagnostics("/p/a.ts")).toHaveLength(2);
		});

		it("drops every anchor and owing runner at a session reset", () => {
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers("/p/a.ts", "blocker A");
			runtime.setAnalysisAnchor("/p/a.ts", anchor);
			runtime.setAnalysisAnchor("/p/b.ts", anchor);
			runtime.resetForSession();
			expect(runtime.getAnalysisAnchor("/p/a.ts")).toBeUndefined();
			expect(runtime.getAnalysisAnchor("/p/b.ts")).toBeUndefined();
		});
	});

	describe("inline blockers reconcile against disk (#1245)", () => {
		it("drops a blocker whose file no longer exists from the snapshot", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(
				path.join(tmpdir(), "pi-lens-blocker-reconcile-"),
			);
			const file = path.join(dir, "stale.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				rmSync(file);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("drops a stale blocker for a mixed-case filename too (#1245 Windows key trap)", () => {
			// `normalizeMapKey` realpaths a live file (canonical case) but
			// lowercases the tail of a deleted one, so a delete-in-place
			// reconcile missed `MyCase.ts` on Windows — the reconcile must not
			// depend on delete-time key normalization matching set-time.
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-case-"));
			const file = path.join(dir, "MyCase.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				rmSync(file);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps a blocker whose file still exists", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-keep-"));
			const file = path.join(dir, "stays.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
				expect(runtime.getInlineBlockersSnapshot()[0].summary).toBe(
					"blocker A",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps re-serving a blocker whose CAUSE was fixed in another file (#1561)", () => {
			// The live incident: 3 blockers land on a test file, the signature that
			// caused them is fixed in the provider it imports, and the provider —
			// not the test file — is what gets re-dispatched. Neither existing
			// invalidation path (re-dispatch of the SAME path, #1245's existence
			// check) covers that, so the verdict is never re-taken.
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(
				path.join(tmpdir(), "pi-lens-blocker-crossfile-"),
			);
			const testFile = path.join(dir, "provider.test.ts");
			const provider = path.join(dir, "provider.ts");
			writeFileSync(testFile, "import './provider.ts';\n");
			writeFileSync(provider, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(testFile, "🔴 STOP L320", 1, ["lsp"]);
				// The fix: the PROVIDER re-dispatches clean. Its own entry clears…
				runtime.clearInlineBlockers(provider);
				// …and the test file's stale verdict is still there, by design.
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				// A fresh, confirmed-clean view of the test file must retire it.
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(testFile, 2, ["lsp"]),
				).toBe(true);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("#1561 F1: refuses to retire a source the verdict did not cover", () => {
			// Inline blockers span every runner, not just the language server —
			// `dispatcher.ts` filters `semantic === "blocking"` across all of them.
			// An LSP-only clean must not clear an ast-grep security rule.
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-source-"));
			const file = path.join(dir, "app.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "🔴 STOP cors-wildcard", 1, [
					"ast-grep",
				]);
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, ["lsp"]),
				).toBe(false);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

				// Partial coverage is not coverage.
				runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp", "eslint"]);
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, [
						"lsp",
						"ast-grep",
					]),
				).toBe(false);

				// Full coverage does retire.
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, [
						"lsp",
						"eslint",
					]),
				).toBe(true);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("#1561 F1: a record with unknown provenance fails closed", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-unknown-"));
			const file = path.join(dir, "app.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				// No sources recorded — "we don't know what raised this" must not
				// resolve to "an LSP check can clear it".
				runtime.recordInlineBlockers(file, "🔴 STOP", 1);
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, ["lsp"]),
				).toBe(false);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("does not let an older confirmed clean erase a newer blocker (#1198 inv. 1-2)", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-order-"));
			const file = path.join(dir, "raced.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				// A clean check that STARTED at token 4 settles after a dispatch at
				// token 7 found real blockers. The slow old answer must lose.
				runtime.recordInlineBlockers(file, "🔴 STOP", 7, ["lsp"]);
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 4, ["lsp"]),
				).toBe(false);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
				// Equal tokens are the same observation, not a newer one.
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 7, ["lsp"]),
				).toBe(false);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
				// Strictly newer retires.
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 8, ["lsp"]),
				).toBe(true);
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("reports no retire for a path that has no blocker", () => {
			const runtime = new RuntimeCoordinator();
			expect(
				runtime.retireInlineBlockerOnConfirmedClean(
					path.resolve("never/recorded.ts"),
					9,
				),
			).toBe(false);
		});

		it("releases the git guard once the blocker is retired (#1561)", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(
				path.join(tmpdir(), "pi-lens-blocker-retire-guard-"),
			);
			const file = path.join(dir, "gated.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp"]);
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(true);

				expect(
					runtime.retireInlineBlockerOnConfirmedClean(file, 2, ["lsp"]),
				).toBe(true);
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("no longer counts a deleted file's blocker toward the git guard", () => {
			const runtime = new RuntimeCoordinator();
			const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-blocker-guard-"));
			const file = path.join(dir, "stale.ts");
			writeFileSync(file, "export const x = 1;\n");
			try {
				runtime.recordInlineBlockers(file, "blocker A");
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(true);

				rmSync(file);
				runtime.updateGitGuardStatus(false, "");
				expect(runtime.gitGuardHasBlockers).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("inline blockers belong to the turn session that wrote them (#4921)", () => {
		// A concurrent in-process subagent (#473) shares this coordinator; its
		// writes and the primary's land in one path-keyed map. Real files: the
		// snapshot drops a record whose file is gone (#1245).
		let dir = "";
		let primaryFile = "";
		let subagentFile = "";
		beforeEach(() => {
			dir = mkdtempSync(path.join(tmpdir(), "pi-lens-4921-owner-"));
			primaryFile = path.join(dir, "primary.ts");
			subagentFile = path.join(dir, "subagent.ts");
			writeFileSync(primaryFile, "debugger;\n");
			writeFileSync(subagentFile, "debugger;\n");
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));
		const PRIMARY = "primary-session";
		const SUBAGENT = "subagent-session";
		const record = (
			runtime: RuntimeCoordinator,
			filePath: string,
			sessionId: string | undefined,
		) =>
			runtime.recordInlineBlockers(
				filePath,
				"🔴 STOP",
				1,
				undefined,
				[1],
				undefined,
				undefined,
				undefined,
				undefined,
				sessionId,
			);
		const files = (records: { filePath: string }[]) =>
			records.map((entry) => entry.filePath);
		const twoSessions = (): RuntimeCoordinator => {
			const runtime = new RuntimeCoordinator();
			runtime.setSessionLifecycle({ sessionId: PRIMARY });
			record(runtime, primaryFile, PRIMARY);
			record(runtime, subagentFile, SUBAGENT);
			return runtime;
		};

		it("shows each turn session only its own records, and the commit gate every record", () => {
			// RECURRENCE GUARDED: #4921. The subagent's turn end read the whole
			// map and told it about the primary's file.
			const runtime = twoSessions();
			expect({
				primary: files(
					runtime.getInlineBlockersSnapshot({ sessionId: PRIMARY }),
				),
				subagent: files(
					runtime.getInlineBlockersSnapshot({ sessionId: SUBAGENT }),
				),
				// A turn with no session id of its own is the coordinator's.
				unnamed: files(
					runtime.getInlineBlockersSnapshot({ sessionId: undefined }),
				),
				gate: files(runtime.getInlineBlockersSnapshot()).sort(),
			}).toEqual({
				primary: [primaryFile],
				subagent: [subagentFile],
				unnamed: [primaryFile],
				gate: [primaryFile, subagentFile].sort(),
			});
		});

		it("files a settled collect-later blocker under the session whose write it answered (#4943)", () => {
			// RECURRENCE GUARDED: #4943 (the #4940 review's probe P6). The recorder
			// took no session, so a subagent's settled deferred-runner blocker
			// became a coordinator-owned record and the primary's turn end
			// delivered it as its own.
			const runtime = new RuntimeCoordinator();
			runtime.setSessionLifecycle({ sessionId: PRIMARY });
			const blocking: Diagnostic = {
				id: "late-1",
				message: "late blocker",
				filePath: subagentFile,
				line: 1,
				column: 1,
				severity: "error",
				semantic: "blocking",
				tool: "slow-runner",
				runnerId: "slow-runner",
			};
			const analysed = { recordedAtMs: Date.now() };
			runtime.recordDeferredInlineBlockers(
				subagentFile,
				[blocking],
				analysed,
				SUBAGENT,
			);
			runtime.recordDeferredInlineBlockers(
				primaryFile,
				[{ ...blocking, filePath: primaryFile }],
				analysed,
				PRIMARY,
			);
			expect({
				primary: files(
					runtime.getInlineBlockersSnapshot({ sessionId: PRIMARY }),
				),
				subagent: files(
					runtime.getInlineBlockersSnapshot({ sessionId: SUBAGENT }),
				),
			}).toEqual({ primary: [primaryFile], subagent: [subagentFile] });
		});

		it("lets one session's policy pass set verdicts on its own records only", () => {
			// RECURRENCE GUARDED: the pass rewrites the whole verdict axis it
			// judged; run over every record, the subagent's empty pass cleared
			// the primary's suppression and reopened its commit gate latch.
			const runtime = twoSessions();
			runtime.applyInlineBlockerPolicyVerdicts([primaryFile], {
				sessionId: PRIMARY,
			});
			runtime.applyInlineBlockerPolicyVerdicts([], { sessionId: SUBAGENT });
			const verdicts = Object.fromEntries(
				runtime
					.getInlineBlockersSnapshot()
					.map((entry) => [entry.filePath, entry.policySuppressed ?? false]),
			);
			expect(verdicts).toEqual({
				[primaryFile]: true,
				[subagentFile]: false,
			});
		});

		it("says Resolved only to the session whose blocker a clean write retired", () => {
			// RECURRENCE GUARDED: the Resolved note is the same store's; the
			// primary's turn end consumed the subagent's note.
			const runtime = twoSessions();
			expect(runtime.clearInlineBlockers(subagentFile, 2)).toBe(true);
			expect(
				runtime.consumeResolvedBlockerFiles(() => false, {
					sessionId: PRIMARY,
				}).files,
			).toEqual([]);
			expect(
				files(
					runtime.consumeResolvedBlockerFiles(() => false, {
						sessionId: SUBAGENT,
					}).files,
				),
			).toEqual([subagentFile]);
		});
	});
});

describe("RuntimeCoordinator.claimBlockerRepeat (#5532)", () => {
	let dir: string;
	const CAP = 3;
	const blocking = (filePath: string, code: number): Diagnostic => ({
		id: `lsp:${code}:1`,
		message: `Problem ${code}.`,
		filePath,
		line: 1,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
		rule: `ts:${code}`,
	});
	const raise = (runtime: RuntimeCoordinator, name: string): string => {
		const filePath = path.join(dir, name);
		writeFileSync(filePath, "alpha();\n");
		runtime.recordInlineBlockers(filePath, "blocker");
		return filePath;
	};
	/** Claim once per prompt `times` times; the verdicts, in order. */
	const prompts = (runtime: RuntimeCoordinator, times: number): boolean[] =>
		Array.from(
			{ length: times },
			() => runtime.claimBlockerRepeat({ sessionId: undefined }, CAP).capped,
		);

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "pi-lens-5532-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("caps a set after CAP full repeats and reports the cap once", () => {
		// RECURRENCE GUARDED: #5532. The repeat had no count, so it fired for the
		// rest of the session; and a cap event reported per claim would write one
		// ledger row per prompt.
		const runtime = new RuntimeCoordinator();
		raise(runtime, "a.ts");
		const verdicts = Array.from({ length: 6 }, () =>
			runtime.claimBlockerRepeat({ sessionId: undefined }, CAP),
		);
		expect(verdicts.map((verdict) => verdict.capped)).toEqual([
			false,
			false,
			false,
			true,
			true,
			true,
		]);
		expect(verdicts.map((verdict) => verdict.capReached)).toEqual([
			false,
			false,
			false,
			true,
			false,
			false,
		]);
	});

	it("restarts the count when a member joins and keeps the cap when one leaves", () => {
		// RECURRENCE GUARDED: #5532. A set that gains a never-reported blocker
		// must repeat it in full; fixing one blocker must not re-open the others.
		const runtime = new RuntimeCoordinator();
		const first = raise(runtime, "a.ts");
		expect(prompts(runtime, 4)).toEqual([false, false, false, true]);
		const second = raise(runtime, "b.ts");
		expect(prompts(runtime, 4)).toEqual([false, false, false, true]);
		runtime.clearInlineBlockers(second);
		expect(prompts(runtime, 1)).toEqual([true]);
		runtime.clearInlineBlockers(first);
		const empty = runtime.claimBlockerRepeat({ sessionId: undefined }, CAP);
		expect(empty).toEqual({ files: [], capped: false, capReached: false });
	});

	it("restarts the count when a late runner adds findings to the record", () => {
		// RECURRENCE GUARDED: #5532. The merge keeps the record, so a count that
		// survived it would pointer findings the model was never told about.
		const runtime = new RuntimeCoordinator();
		const filePath = path.join(dir, "a.ts");
		writeFileSync(filePath, "alpha();\n");
		runtime.recordInlineBlockers(
			filePath,
			"blocker",
			undefined,
			undefined,
			undefined,
			undefined,
			[blocking(filePath, 1)],
		);
		expect(prompts(runtime, 4)).toEqual([false, false, false, true]);
		runtime.recordDeferredInlineBlockers(filePath, [blocking(filePath, 2)], {
			recordedAtMs: 2,
		});
		expect(prompts(runtime, 4)).toEqual([false, false, false, true]);
	});

	it("leaves a demoted record out of the set and its drift count untouched", () => {
		// RECURRENCE GUARDED: #5532. The repeat count is not the drift cap's
		// `staleDeliveryCount`; sharing it would retire a freshly demoted record on
		// its first stale delivery.
		const runtime = new RuntimeCoordinator();
		const filePath = raise(runtime, "a.ts");
		expect(prompts(runtime, 4)).toEqual([false, false, false, true]);
		expect(runtime.markInlineBlockerStale(filePath)).toBe(true);
		expect(runtime.peekInlineBlockerStaleDeliveryCount(filePath)).toBe(0);
		expect(
			runtime.claimBlockerRepeat({ sessionId: undefined }, CAP).files,
		).toEqual([]);
	});

	it("counts per turn session: another session's prompts never cap this one", () => {
		// RECURRENCE GUARDED: #5532 (#4921 shape). The map is shared by the
		// coordinator's sessions; a claim spends only its own session's records.
		const runtime = new RuntimeCoordinator();
		const mine = path.join(dir, "mine.ts");
		const theirs = path.join(dir, "theirs.ts");
		writeFileSync(mine, "alpha();\n");
		writeFileSync(theirs, "alpha();\n");
		runtime.recordInlineBlockers(mine, "blocker");
		runtime.recordInlineBlockers(
			theirs,
			"blocker",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"secondary",
		);
		for (let i = 0; i < 5; i++)
			runtime.claimBlockerRepeat({ sessionId: "secondary" }, CAP);
		expect(runtime.claimBlockerRepeat({ sessionId: undefined }, CAP)).toEqual({
			files: [mine],
			capped: false,
			capReached: false,
		});
	});
});
