import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	clearWidgetState,
	exportWidgetState,
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
});
