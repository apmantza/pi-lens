import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "../index.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";

const { logExtensionSpy } = vi.hoisted(() => ({ logExtensionSpy: vi.fn() }));
vi.mock("../clients/extension-log.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/extension-log.js")>()),
	logExtension: logExtensionSpy,
}));

// Same two heavy seams tests/index-wiring.test.ts stubs, so firing
// session_start stays a fast deterministic wiring check.
vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: {
			recordToolCall: () => {},
			formatWarnings: () => "",
		},
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: () => null,
		},
	}));
});
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async () => {},
}));

const tmpDirs: string[] = [];

function tmpProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mode-aware-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	resetDegradationLedger();
	for (const dir of tmpDirs.splice(0)) removeTempDirSync(dir);
});

/**
 * #1334 S2 — terminal-ownership behavior is derived from the HOST's
 * `ctx.mode`, not guessed. The widget is a terminal-only custom component; the
 * one-shot output modes get no proactive notify chatter.
 */
/**
 * The mount is driven through `/lens-widget-toggle` rather than
 * `session_start`: #473's concurrent-secondary guard makes a SECOND
 * `session_start` in the same process return early, which would make these
 * assertions silently order-dependent (and the negative ones vacuous). The
 * command path runs the same `mountLensWidget` through the real handler.
 * The widget starts visible, so the first toggle hides it and the second is
 * the mount under test.
 */
describe("widget mounting is mode-derived (#1334 S2)", () => {
	async function toggleTwice(mode: "tui" | "rpc" | "json" | "print" | null) {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const ctx = makeCtx({ cwd: tmpProject(), mode });
		await pi.runCommand("lens-widget-toggle", "", ctx);
		await pi.runCommand("lens-widget-toggle", "", ctx);
		return ctx;
	}

	/** A mount is a setWidget call carrying a component factory. */
	const mounts = (ctx: Awaited<ReturnType<typeof toggleTwice>>) =>
		ctx.widgetCalls.filter((c) => typeof c.content === "function");

	for (const mode of ["print", "json", "rpc"] as const) {
		it(`never mounts the widget in "${mode}" mode`, async () => {
			const ctx = await toggleTwice(mode);

			expect(mounts(ctx)).toHaveLength(0);
		});
	}

	it('explains the MODE, not the pi version, when refusing in "rpc"', async () => {
		const ctx = await toggleTwice("rpc");

		const last = ctx.notifications.at(-1);
		expect(last?.message).toContain("interactive TUI");
		expect(last?.message).toContain("rpc");
		expect(last?.type).toBe("warning");
	});

	it('mounts the widget in "tui" mode', async () => {
		const ctx = await toggleTwice("tui");

		expect(mounts(ctx)).toHaveLength(1);
		expect(mounts(ctx)[0]).toMatchObject({
			key: "pi-lens",
			options: { placement: "belowEditor" },
		});
	});

	it("mounts the widget on an older host with no mode field", async () => {
		const ctx = await toggleTwice(null);

		expect(mounts(ctx)).toHaveLength(1);
	});

	it("re-mounts on the live UI when the host replaces it (#1381)", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const ctxA = makeCtx({ cwd: tmpProject(), mode: "tui" });
		const ctxB = makeCtx({ cwd: ctxA.cwd, mode: "tui" });
		const setWidgetA = vi.spyOn(ctxA.ui, "setWidget");
		const setWidgetB = vi.spyOn(ctxB.ui, "setWidget");

		await pi.runCommand("lens-widget-toggle", "", ctxA);
		await pi.runCommand("lens-widget-toggle", "", ctxA);
		await pi.emit("turn_start", {}, ctxB);

		expect(
			setWidgetA.mock.calls.filter(
				([, content]) => typeof content === "function",
			),
		).toHaveLength(1);
		expect(
			setWidgetB.mock.calls.filter(
				([, content]) => typeof content === "function",
			),
		).toHaveLength(1);
	});

	it("does not resurrect a widget toggled off before a UI replacement (#1381)", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const ctxA = makeCtx({ cwd: tmpProject(), mode: "tui" });
		const ctxB = makeCtx({ cwd: ctxA.cwd, mode: "tui" });
		const setWidgetB = vi.spyOn(ctxB.ui, "setWidget");

		await pi.runCommand("lens-widget-toggle", "", ctxA);
		await pi.runCommand("lens-widget-toggle", "", ctxA);
		await pi.runCommand("lens-widget-toggle", "", ctxA);
		await pi.emit("turn_start", {}, ctxB);

		expect(setWidgetB).not.toHaveBeenCalled();
	});

	it("logs a missing setWidget host once and never throws (#1381)", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		logExtensionSpy.mockClear();
		const ctx = makeCtx({ cwd: tmpProject(), mode: "tui" });
		delete (ctx.ui as { setWidget?: unknown }).setWidget;

		await expect(
			pi.runCommand("lens-widget-toggle", "", ctx),
		).resolves.toBeUndefined();
		await expect(
			pi.runCommand("lens-widget-toggle", "", ctx),
		).resolves.toBeUndefined();
		await expect(pi.emit("turn_start", {}, ctx)).resolves.toBeUndefined();

		expect(
			logExtensionSpy.mock.calls.filter(
				([entry]) =>
					entry.message ===
					"widget mount unavailable: host ui.setWidget is missing",
			),
		).toHaveLength(1);
	});
});

describe("notify chatter is mode-derived (#1334 S2)", () => {
	for (const mode of ["print", "json"] as const) {
		it(`suppresses command notify output in "${mode}" mode`, async () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			const ctx = makeCtx({ cwd: tmpProject(), mode });

			await pi.runCommand("lens-toggle", "", ctx);

			expect(ctx.notifications).toHaveLength(0);
			expect(getDegradationSummary()).toEqual([
				expect.objectContaining({ kind: "mode-suppression", count: 1 }),
			]);
		});
	}

	for (const mode of ["tui", "rpc"] as const) {
		it(`still notifies in "${mode}" mode`, async () => {
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			const ctx = makeCtx({ cwd: tmpProject(), mode });

			await pi.runCommand("lens-toggle", "", ctx);

			expect(ctx.notifications).toHaveLength(1);
		});
	}

	it("still notifies on an older host with no mode field", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const ctx = makeCtx({ cwd: tmpProject(), mode: null });

		await pi.runCommand("lens-toggle", "", ctx);

		expect(ctx.notifications).toHaveLength(1);
	});
});
