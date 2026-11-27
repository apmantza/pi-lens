import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnostics,
	reconcileStaleWidgetFiles,
	recordDiagnostics,
	recordLsp,
} from "../clients/widget-state.js";
import { saveSessionState } from "../clients/session-state-store.js";
import extension from "../index.js";
import { useGlobalConfig } from "./support/global-config.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { setupTestEnvironment } from "./clients/test-utils.js";

const INTEGRATION_TIMEOUT_MS = 45_000;
const setGlobalConfig = useGlobalConfig();
const ISSUES_KEY = "pi-lens-issues";

function issueStatuses(ctx: {
	statusCalls: Array<{ key: string; text?: string }>;
}) {
	return ctx.statusCalls
		.filter((call) => call.key === ISSUES_KEY)
		.map((call) => call.text);
}

async function startSession(
	config: Record<string, unknown>,
	options: {
		mode?: "tui" | "rpc";
		cwd: string;
		sessionId?: string;
		reason?: string;
	} = { cwd: process.cwd() },
) {
	_resetSessionLifecycleForTests();
	setGlobalConfig(config);
	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	const ctx = makeCtx({
		cwd: options.cwd,
		sessionId: options.sessionId ?? "issues-status-session",
		mode: options.mode ?? "tui",
	});
	await pi.emit("session_start", { reason: options.reason ?? "startup" }, ctx);
	return ctx;
}

afterEach(async () => {
	await endMockSessions();
	_resetSessionLifecycleForTests();
	clearWidgetState();
});

describe("pi-lens-issues status", () => {
	it(
		"publishes nothing when lens-issues-status is off",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-issues-off-");
			try {
				const ctx = await startSession({}, { cwd: tmpDir });
				recordDiagnostics(path.join(tmpDir, "off.ts"), [
					{
						severity: "error",
						semantic: "blocking",
						message: "blocking",
						line: 1,
						rule: "typescript:1",
					},
				]);

				expect(issueStatuses(ctx)).toEqual([]);
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"publishes live from the widget store without a turn",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-issues-live-");
			try {
				const ctx = await startSession(
					{ ui: { issuesStatus: true } },
					{ cwd: tmpDir },
				);
				recordDiagnostics(path.join(tmpDir, "live.ts"), [
					{
						severity: "error",
						semantic: "blocking",
						message: "blocking",
						line: 1,
						rule: "typescript:1",
					},
					{
						severity: "warning",
						message: "warning",
						line: 2,
						rule: "ts-react-antipatterns",
					},
				]);

				expect(issueStatuses(ctx).at(-1)).toBe("●1E !1W");
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"publishes undefined once when the flag is on but no file is analyzed",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-issues-empty-");
			try {
				const ctx = await startSession(
					{ ui: { issuesStatus: true } },
					{ cwd: tmpDir },
				);

				expect(issueStatuses(ctx)).toEqual([undefined]);
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"publishes a resumed snapshot after adoptHandoff",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-issues-resume-",
			);
			const sessionId = "issues-status-resume";
			const filePath = path.join(tmpDir, "resumed.ts");
			try {
				fs.writeFileSync(filePath, "const a = 1;\n");
				const past = new Date(Date.now() - 60_000);
				fs.utimesSync(filePath, past, past);
				clearWidgetState();
				recordDiagnostics(filePath, [
					{
						severity: "error",
						semantic: "blocking",
						message: "resumed blocking",
						line: 1,
						rule: "typescript:1",
					},
				]);
				await saveSessionState(tmpDir, sessionId, {
					widget: exportWidgetState(),
				});
				clearWidgetState();

				const ctx = await startSession(
					{ ui: { issuesStatus: true } },
					{ cwd: tmpDir, sessionId, reason: "resume" },
				);

				expect(issueStatuses(ctx).at(-1)).toBe("●1E");
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"dedupes identical consecutive text",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-issues-dedupe-",
			);
			try {
				const ctx = await startSession(
					{ ui: { issuesStatus: true } },
					{ cwd: tmpDir },
				);
				const before = issueStatuses(ctx).length;
				recordDiagnostics(path.join(tmpDir, "dedupe.ts"), [
					{
						severity: "error",
						semantic: "blocking",
						message: "blocking",
						line: 1,
						rule: "typescript:1",
					},
				]);
				const afterFirst = issueStatuses(ctx);
				expect(afterFirst.at(-1)).toBe("●1E");
				expect(afterFirst.length).toBe(before + 1);

				// An LSP-state mutation repaints the store without changing the
				// tallies; the identical text must not reach the host again.
				recordLsp("typescript", tmpDir, "spawn_success");
				expect(issueStatuses(ctx).length).toBe(afterFirst.length);
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"republishes after a session reset even when the text is unchanged",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-issues-reset-");
			try {
				_resetSessionLifecycleForTests();
				setGlobalConfig({ ui: { issuesStatus: true } });
				const pi = createPiMock();
				extension(pi.asExtensionAPI());

				const first = makeCtx({
					cwd: tmpDir,
					sessionId: "issues-status-reset-1",
				});
				await pi.emit("session_start", { reason: "startup" }, first);
				expect(issueStatuses(first)).toEqual([undefined]);

				// The host clears extension statuses on a session reset, so the
				// unchanged `undefined` still has to reach the new footer.
				await pi.emit("session_shutdown", { reason: "new" }, first);
				const second = makeCtx({
					cwd: tmpDir,
					sessionId: "issues-status-reset-2",
				});
				await pi.emit("session_start", { reason: "new" }, second);
				expect(issueStatuses(second)).toEqual([undefined]);
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"publishes in rpc mode",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-issues-rpc-");
			try {
				const ctx = await startSession(
					{ ui: { issuesStatus: true } },
					{ cwd: tmpDir, mode: "rpc" },
				);
				recordDiagnostics(path.join(tmpDir, "rpc.ts"), [
					{
						severity: "warning",
						message: "warning",
						line: 2,
						rule: "ts-react-antipatterns",
					},
				]);

				expect(issueStatuses(ctx).at(-1)).toBe("!1W");
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"publishes the unchecked state, not an intermediate clean frame, when the reason arrives with the snapshot",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-issues-unchecked-",
			);
			try {
				const ctx = await startSession(
					{ ui: { issuesStatus: true } },
					{ cwd: tmpDir },
				);
				const filePath = path.join(tmpDir, "unchecked.ts");

				recordDiagnostics(filePath, [], undefined, undefined, {
					reason: "no primary checker is enabled for this kind",
				});
				expect(issueStatuses(ctx).at(-1)).toBe("⚠ 1 unchecked");
				expect(issueStatuses(ctx)).not.toContain("✓ clean");

				// Clearing the reason in the same write path must publish clean, not
				// leave the previous unchecked text in place.
				recordDiagnostics(filePath, []);
				expect(issueStatuses(ctx).at(-1)).toBe("✓ clean");
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"publishes a failed host status write without breaking the store write, then retries",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-issues-throwing-status-",
			);
			try {
				const ctx = await startSession(
					{ ui: { issuesStatus: true } },
					{ cwd: tmpDir },
				);
				const filePath = path.join(tmpDir, "throwing.ts");
				resetDegradationLedger();
				const original = ctx.ui.setStatus;
				ctx.ui.setStatus = () => {
					throw new Error("stale extension ctx");
				};

				expect(() =>
					recordDiagnostics(filePath, [
						{
							severity: "error",
							semantic: "blocking",
							message: "blocking",
							line: 1,
							rule: "typescript:1",
						},
					]),
				).not.toThrow();
				expect(getFileDiagnostics(filePath)).toHaveLength(1);
				// The publish seam handles its own host failure; the store-write
				// listener guard must not see it as a broken projection.
				expect(
					getDegradationSummary().map((group) => group.kind),
				).not.toContain("widget-change-listener-failed");

				// The dedupe state did not advance on the failed call, so the next store
				// change retries and reaches the host once it accepts the key again.
				ctx.ui.setStatus = original;
				recordLsp("typescript", tmpDir, "spawn_success");
				expect(issueStatuses(ctx).at(-1)).toBe("●1E");
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"publishes a tally change when stale-file reconciliation changes the store",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-issues-reconcile-",
			);
			try {
				const ctx = await startSession(
					{ ui: { issuesStatus: true } },
					{ cwd: tmpDir },
				);
				const filePath = path.join(tmpDir, "reconcile.ts");
				fs.writeFileSync(filePath, "const a = 1;\n");
				const observedAt = Date.now() - 20_000;
				recordDiagnostics(
					filePath,
					[
						{
							severity: "error",
							semantic: "blocking",
							message: "blocking",
							line: 1,
							rule: "typescript:1",
						},
					],
					undefined,
					observedAt,
				);
				expect(issueStatuses(ctx).at(-1)).toBe("●1E");

				// The file changed after the observation, so reconciliation sheds the
				// finding and the footer must republish without another write.
				const mtime = new Date(Date.now() - 10_000);
				fs.utimesSync(filePath, mtime, mtime);
				expect(await reconcileStaleWidgetFiles()).toBe(1);
				expect(issueStatuses(ctx).at(-1)).toBeUndefined();
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"clears a visible status when the store is reset",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-issues-clear-");
			try {
				const ctx = await startSession(
					{ ui: { issuesStatus: true } },
					{ cwd: tmpDir },
				);
				recordDiagnostics(path.join(tmpDir, "clear.ts"), [
					{
						severity: "error",
						semantic: "blocking",
						message: "blocking",
						line: 1,
						rule: "typescript:1",
					},
				]);
				expect(issueStatuses(ctx).at(-1)).toBe("●1E");

				clearWidgetState();
				expect(issueStatuses(ctx).at(-1)).toBeUndefined();
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"clears a visible status when the flag turns off after a publish",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-issues-flag-off-",
			);
			try {
				_resetSessionLifecycleForTests();
				setGlobalConfig({});
				const pi = createPiMock();
				extension(pi.asExtensionAPI());
				// The flag is read at publish time, so turning it off after a visible
				// publish must clear the key on the next store change.
				pi.setFlag("lens-issues-status", true);
				const ctx = makeCtx({
					cwd: tmpDir,
					sessionId: "issues-status-flag-off",
				});
				await pi.emit("session_start", { reason: "startup" }, ctx);
				recordDiagnostics(path.join(tmpDir, "flag-off.ts"), [
					{
						severity: "error",
						semantic: "blocking",
						message: "blocking",
						line: 1,
						rule: "typescript:1",
					},
				]);
				expect(issueStatuses(ctx).at(-1)).toBe("●1E");

				pi.setFlag("lens-issues-status", false);
				recordLsp("typescript", tmpDir, "spawn_success");
				expect(issueStatuses(ctx).at(-1)).toBeUndefined();
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"keeps the listener with the primary when a concurrent secondary starts",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-issues-secondary-",
			);
			try {
				_resetSessionLifecycleForTests();
				setGlobalConfig({ ui: { issuesStatus: true } });
				// The host shape is one factory run per session, so the secondary is a
				// separate activation over its own pi handle (#4704).
				const primaryPi = createPiMock();
				extension(primaryPi.asExtensionAPI());
				const primaryCtx = makeCtx({
					cwd: tmpDir,
					sessionId: "issues-status-primary",
				});
				await primaryPi.emit(
					"session_start",
					{ reason: "startup" },
					primaryCtx,
				);
				recordDiagnostics(path.join(tmpDir, "primary.ts"), [
					{
						severity: "error",
						semantic: "blocking",
						message: "blocking",
						line: 1,
						rule: "typescript:1",
					},
				]);
				expect(issueStatuses(primaryCtx).at(-1)).toBe("●1E");

				const secondaryPi = createPiMock();
				extension(secondaryPi.asExtensionAPI());
				const secondaryCtx = makeCtx({
					cwd: tmpDir,
					sessionId: "issues-status-secondary",
				});
				await secondaryPi.emit(
					"session_start",
					{ reason: "startup" },
					secondaryCtx,
				);
				expect(issueStatuses(secondaryCtx)).toEqual([]);

				// A later store write still reaches the PRIMARY footer, through the
				// primary's own ctx rather than the process-global latest ctx.
				recordDiagnostics(path.join(tmpDir, "after-secondary.ts"), [
					{
						severity: "warning",
						message: "warning",
						line: 2,
						rule: "ts-react-antipatterns",
					},
				]);
				expect(issueStatuses(primaryCtx).at(-1)).toBe("●1E !1W");
				expect(issueStatuses(secondaryCtx)).toEqual([]);

				// The secondary leaving must not clear the primary's listener.
				await secondaryPi.emit(
					"session_shutdown",
					{ reason: "quit" },
					secondaryCtx,
				);
				recordDiagnostics(path.join(tmpDir, "after-secondary-leave.ts"), [
					{
						severity: "warning",
						message: "warning",
						line: 3,
						rule: "ts-react-antipatterns",
					},
				]);
				expect(issueStatuses(primaryCtx).at(-1)).toBe("●1E !2W");

				// The primary leaving clears it: a later store write publishes nothing.
				const beforeLeave = issueStatuses(primaryCtx).length;
				await primaryPi.emit(
					"session_shutdown",
					{ reason: "quit" },
					primaryCtx,
				);
				recordDiagnostics(path.join(tmpDir, "after-primary-leave.ts"), [
					{
						severity: "warning",
						message: "warning",
						line: 4,
						rule: "ts-react-antipatterns",
					},
				]);
				expect(issueStatuses(primaryCtx).length).toBe(beforeLeave);

				// A primary turn_start reclaims the listener, as it reclaims the render
				// callback, so the footer resumes publishing.
				await primaryPi.emit("turn_start", {}, primaryCtx);
				recordDiagnostics(path.join(tmpDir, "after-turn-start.ts"), [
					{
						severity: "warning",
						message: "warning",
						line: 5,
						rule: "ts-react-antipatterns",
					},
				]);
				expect(issueStatuses(primaryCtx).at(-1)).toBe("●1E !4W");
			} finally {
				cleanup();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);
});
