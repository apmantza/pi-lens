/**
 * #3576: `agent_settled`'s post-drain observed-ledger refresh belongs to the
 * session its drain started in.
 *
 * `refreshObservedLedgerSafely` runs after the deferred drain and re-baselines
 * the files the drain handed the observed-mutation net, with the read guard of
 * whichever session is current. `/new`, fork or resume can run while the drain
 * awaits its formatter; a refresh after that walks the next session's
 * `handled` set with the next session's read guard. This file prevents that
 * recurrence: the refresh of a drain whose session was replaced is dropped
 * with one generation-guard ledger row, and a drain that stays in its session
 * still refreshes (shape 54).
 *
 * Production chain: the real extension activation and `agent_settled`
 * handler (`index.ts`), the real module-level `RuntimeCoordinator` handed to
 * the drain, and the real `refreshObservedMutationLedger` (wrapped, not
 * replaced). The drain itself is doubled: it only replaces the session, the
 * way `/new` lands while the real drain awaits its formatter.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drain = vi.hoisted(() => ({
	replaceSession: false,
	/** #5108 F8: a loss notice the doubled drain queues, as the real one does. */
	lossNotice: undefined as string | undefined,
}));
const refresh = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
	}));
});
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: { projectRoot: string };
		ctxCwd?: string;
	}) => {
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));
// #5108 F8: the double queues its loss notice the way the real drain's
// `queueAgentAdvisory(text, advisoryScope ?? session)` does. The real path
// needs a whole-package fixer that overwrites an agent edit mid-drain (the
// `tests/clients/fix-run-restore.test.ts` clippy fixture), which this file's
// drain double replaces; that file pins the real drain, this one pins the
// scope `index.ts` hands it.
vi.mock("../clients/runtime-agent-end.js", async () => {
	const { queueAgentAdvisory } = await import("../clients/agent-nudge.js");
	return {
		handleAgentEnd: vi.fn(
			async (deps: {
				runtime: {
					resetForSession: () => void;
					captureSessionGeneration: () => unknown;
				};
				advisoryScope?: unknown;
			}) => {
				if (drain.replaceSession) deps.runtime.resetForSession();
				if (drain.lossNotice !== undefined)
					queueAgentAdvisory(
						drain.lossNotice,
						(deps.advisoryScope ??
							deps.runtime.captureSessionGeneration()) as never,
					);
				return undefined;
			},
		),
	};
});
vi.mock("../clients/observed-mutation.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/observed-mutation.js")>();
	return {
		...actual,
		refreshObservedMutationLedger: (
			...args: Parameters<typeof actual.refreshObservedMutationLedger>
		) => {
			refresh.calls += 1;
			return actual.refreshObservedMutationLedger(...args);
		},
	};
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import { _resetAgentNudgeForTests } from "../clients/agent-nudge.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import extension from "../index.js";
import { makeContextWithSystemEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

describe("#3576: the post-drain ledger refresh stays in the drain's session", () => {
	let tmp: string;
	let prevDataDir: string | undefined;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3576-refresh-"));
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, "data");
		refresh.calls = 0;
		resetDegradationLedger();
	});

	afterEach(() => {
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		removeTempDirSync(tmp);
	});

	async function settle(replaceSession: boolean): Promise<void> {
		drain.replaceSession = replaceSession;
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const ctx = makeCtx({ cwd: tmp, sessionId: "s-3576-refresh" });
		await pi.emit("session_start", { reason: "startup" }, ctx);
		await pi.emit("agent_settled", {}, ctx);
	}

	it("a drain whose session was replaced does not refresh the next session's ledger", async () => {
		await settle(true);
		expect(refresh.calls).toBe(0);
		expect(
			getDegradationSummary()
				.filter((group) => group.kind === "generation-guard-stale-write")
				.flatMap((group) => group.latestReasons.map((r) => r.subject)),
		).toEqual([`runtime-session:observed-ledger-refresh:${tmp}`]);
	});

	it("no-drop (shape 54): a drain that stays in its session refreshes the ledger", async () => {
		await settle(false);
		expect(refresh.calls).toBe(1);
	});
});

/**
 * #5108 F8: `index.ts` hands the agent_settled drain the scope of the session
 * that settled, resolved as that session's `context` drain resolves it.
 * Recurrence prevented: the F5 shape at the index.ts call (#5114 verify r3,
 * m11): the drain's loss notice for a concurrent secondary (#473) queued under
 * the coordinator's scope, the primary's, so the secondary's own context never
 * carried it.
 */
describe("#5108 F8: the agent_settled drain's advisory reaches the session that settled", () => {
	let primaryRoot: string;
	let secondaryRoot: string;

	beforeEach(() => {
		_resetSessionLifecycleForTests();
		_resetAgentNudgeForTests();
		primaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5108-p-"));
		secondaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5108-s-"));
	});

	afterEach(() => {
		drain.lossNotice = undefined;
		removeTempDirSync(primaryRoot);
		removeTempDirSync(secondaryRoot);
	});

	it("queues a secondary's drain notice for the secondary's own context", async () => {
		drain.lossNotice = "lost edit in drain.rs";
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const primary = () =>
			makeCtx({ cwd: primaryRoot, sessionId: "pi-5108-f8-p" });
		const secondary = () =>
			makeCtx({ cwd: secondaryRoot, sessionId: "pi-5108-f8-s" });
		await pi.emit("session_start", { reason: "startup" }, primary());
		// A different root: declined as a concurrent secondary with its own scope.
		await pi.emit("session_start", { reason: "startup" }, secondary());
		await pi.emit("agent_settled", {}, secondary());

		const textOf = async (ctx: ReturnType<typeof makeCtx>) => {
			const injected = (await pi.emit(
				"context_with_system",
				makeContextWithSystemEvent([{ role: "user", content: "go" }]),
				ctx,
			)) as { messages?: Array<{ content: unknown }> } | undefined;
			return JSON.stringify((injected?.messages ?? []).map((m) => m.content));
		};
		expect(await textOf(secondary())).toContain("drain.rs");
		expect(await textOf(primary())).not.toContain("drain.rs");
	});
});
