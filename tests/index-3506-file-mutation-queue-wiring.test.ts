/**
 * #3506 wiring: activating the pi extension hands pi-lens' own writers pi's
 * REAL per-file mutation queue, the one pi's `edit`/`write` tools run under.
 * `clients/file-mutation-queue.ts` runs writers unqueued until a host adapter
 * registers a lookup, so only driving `index.ts`'s activation can show the
 * pi adapter does, and that the lookup resolves to the host's own instance.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SessionManager,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import {
	noteHostSessionManager,
	setHostFileMutationQueueLoader,
	withHostFileMutationQueue,
} from "../clients/file-mutation-queue.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

// The resolved-queue row is an extension-log record, which the sink drops in
// test mode; capture it at the seam.
vi.mock("../clients/extension-log.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/extension-log.js")>()),
	logExtension: vi.fn(),
}));
import { logExtension } from "../clients/extension-log.js";

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
	}));
});

// A cold `import("../index.js")` plus the host SDK lookup, as the other
// index.ts wiring files budget it.
const WIRING_TIMEOUT_MS = 30_000;

describe("index.ts registers pi's mutation queue for pi-lens' writers (#3506)", () => {
	let tmp: string | undefined;
	afterEach(() => {
		setHostFileMutationQueueLoader(undefined);
		noteHostSessionManager(undefined);
		if (tmp) removeTempDirSync(tmp);
	});

	it(
		"a pi-lens write waits for a pi edit that holds the same file",
		async () => {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3506-wiring-"));
			const filePath = path.join(tmp, "a.ts");
			fs.writeFileSync(filePath, "export const a = 1;\n");
			const { default: registerExtension } = await import("../index.js");
			registerExtension(createPiMock({}).asExtensionAPI() as never);
			// Resolve the lookup first, so the ordering below is the queue's.
			await withHostFileMutationQueue(path.join(tmp, "warm"), async () => {});

			let releaseEdit!: () => void;
			const edit = withFileMutationQueue(
				filePath,
				() =>
					new Promise<void>((resolve) => {
						releaseEdit = resolve;
					}),
			);
			let wrote = false;
			const write = withHostFileMutationQueue(filePath, async () => {
				wrote = true;
			});
			// Every queue call made above has registered once this resolves.
			await withHostFileMutationQueue(
				path.join(tmp, "barrier"),
				async () => {},
			);
			expect(wrote).toBe(false);
			releaseEdit();
			await edit;
			await write;
			expect(wrote).toBe(true);
		},
		WIRING_TIMEOUT_MS,
	);

	// #3506 r1 (C2): session_start hands the host's own session manager to the
	// check that tells the host's SDK copy from a second one.
	describe("the SDK-copy check reads the host's session manager", () => {
		const previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
		afterEach(() => {
			_resetSessionLifecycleForTests();
			resetDegradationLedger();
			vi.mocked(logExtension).mockClear();
			if (previousStartupMode === undefined)
				delete process.env.PI_LENS_STARTUP_MODE;
			else process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
		});

		async function startSessionThenWrite(sessionManager: unknown) {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3506-copy-"));
			process.env.PI_LENS_STARTUP_MODE = "quick";
			_resetSessionLifecycleForTests();
			resetDegradationLedger();
			vi.mocked(logExtension).mockClear();
			const { default: registerExtension } = await import("../index.js");
			const pi = createPiMock({});
			registerExtension(pi.asExtensionAPI() as never);
			const ctx = Object.assign(makeCtx({ cwd: tmp }), { sessionManager });
			await pi.emit("session_start", makeSessionStartEvent(), ctx);
			await withHostFileMutationQueue(path.join(tmp, "a.ts"), async () => {});
			return {
				resolved: vi
					.mocked(logExtension)
					.mock.calls.map(([entry]) => entry)
					.filter((entry) => entry.subsystem === "file-mutation-queue"),
				degraded: getDegradationSummary().filter(
					(group) => group.kind === "host-file-mutation-queue-unavailable",
				),
			};
		}

		it(
			"the host's own session manager verifies the copy the lookup reached",
			async () => {
				const { resolved, degraded } = await startSessionThenWrite(
					SessionManager.inMemory(os.tmpdir()),
				);
				expect(resolved).toEqual([
					expect.objectContaining({ metadata: { hostCopy: "verified" } }),
				]);
				expect(degraded).toEqual([]);
			},
			WIRING_TIMEOUT_MS,
		);

		it(
			"a session manager of another SDK copy records the second-copy degradation",
			async () => {
				class SecondCopySessionManager {
					getSessionId() {
						return "second-copy-session";
					}
					getSessionFile() {
						return undefined;
					}
				}
				const { resolved, degraded } = await startSessionThenWrite(
					new SecondCopySessionManager(),
				);
				expect(resolved).toEqual([]);
				expect(degraded).toEqual([
					expect.objectContaining({
						latestReasons: [
							expect.objectContaining({
								reason: expect.stringContaining("second copy"),
							}),
						],
					}),
				]);
			},
			WIRING_TIMEOUT_MS,
		);
	});
});
