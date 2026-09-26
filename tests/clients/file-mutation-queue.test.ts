/**
 * #3506: the host-queue lookup behind pi-lens' own writers. The pi adapter
 * registers the lookup; a host that cannot serve it must still let the writer
 * run, and must say so once in the degradation ledger (AGENTS.md shape 10: a
 * lost safety property is never silent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	noteHostSessionManager,
	setHostFileMutationQueueLoader,
	withHostFileMutationQueue,
} from "../../clients/file-mutation-queue.js";

// The success row is an extension-log record, which the sink drops in test
// mode; capture it at the seam.
vi.mock("../../clients/extension-log.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/extension-log.js")>()),
	logExtension: vi.fn(),
}));
import { logExtension } from "../../clients/extension-log.js";

function resolvedRows() {
	return vi
		.mocked(logExtension)
		.mock.calls.map(([entry]) => entry)
		.filter((entry) => entry.subsystem === "file-mutation-queue");
}

const KIND = "host-file-mutation-queue-unavailable";

function queueRows() {
	return getDegradationSummary().filter((group) => group.kind === KIND);
}

describe("withHostFileMutationQueue (#3506)", () => {
	beforeEach(() => {
		resetDegradationLedger();
		vi.mocked(logExtension).mockClear();
	});
	afterEach(() => {
		setHostFileMutationQueueLoader(undefined);
		noteHostSessionManager(undefined);
		resetDegradationLedger();
	});

	it("runs the writer directly, and records nothing, outside the pi host adapter", async () => {
		expect(await withHostFileMutationQueue("a.ts", async () => "ran")).toBe(
			"ran",
		);
		expect(queueRows()).toEqual([]);
	});

	it("runs the writer inside the host queue it resolves, and records nothing", async () => {
		const queued: string[] = [];
		setHostFileMutationQueueLoader(async () => ({
			withFileMutationQueue: async <T>(
				filePath: string,
				fn: () => Promise<T>,
			) => {
				queued.push(filePath);
				return fn();
			},
		}));
		const result = await withHostFileMutationQueue("a.ts", async () => "ran");
		expect(result).toBe("ran");
		expect(queued).toHaveLength(1);
		expect(queueRows()).toEqual([]);
	});

	it("runs the writer unqueued and records the degradation once when the host SDK import fails", async () => {
		setHostFileMutationQueueLoader(async () => {
			throw new Error("Cannot find package '@earendil-works/pi-coding-agent'");
		});
		expect(await withHostFileMutationQueue("a.ts", async () => "ran")).toBe(
			"ran",
		);
		expect(await withHostFileMutationQueue("b.ts", async () => "ran")).toBe(
			"ran",
		);
		expect(queueRows()).toEqual([
			expect.objectContaining({
				count: 1,
				latestReasons: [
					{
						subject: "withFileMutationQueue",
						reason: "Cannot find package '@earendil-works/pi-coding-agent'",
					},
				],
			}),
		]);
	});

	it("runs the writer unqueued and records the degradation when the host SDK has no queue export", async () => {
		setHostFileMutationQueueLoader(async () => ({}));
		expect(await withHostFileMutationQueue("a.ts", async () => "ran")).toBe(
			"ran",
		);
		expect(queueRows()).toEqual([
			expect.objectContaining({
				latestReasons: [
					{
						subject: "withFileMutationQueue",
						reason: "the host SDK exports no withFileMutationQueue",
					},
				],
			}),
		]);
	});

	// #3506 r1 (C2): the lazy import can reach a second copy of the SDK where
	// pi-lens' static imports resolve natively; that copy's queue does not
	// order pi's own edits, so the lookup checks the copy against the host's
	// session manager and records the outcome either way.
	describe("which SDK copy the lookup reached", () => {
		function hostQueueDouble(queued: string[]) {
			return async <T>(filePath: string, fn: () => Promise<T>) => {
				queued.push(filePath);
				return fn();
			};
		}

		it("records the host's own copy as verified, and no degradation", async () => {
			class SessionManager {}
			noteHostSessionManager(new SessionManager());
			const queued: string[] = [];
			setHostFileMutationQueueLoader(async () => ({
				withFileMutationQueue: hostQueueDouble(queued),
				SessionManager,
			}));
			await withHostFileMutationQueue("a.ts", async () => {});
			expect(queued).toHaveLength(1);
			expect(resolvedRows()).toEqual([
				expect.objectContaining({
					message: "resolved the host's withFileMutationQueue",
					metadata: { hostCopy: "verified" },
				}),
			]);
			expect(queueRows()).toEqual([]);
		});

		it("records the copy as unverified, and no degradation, before any session_start", async () => {
			class SessionManager {}
			const queued: string[] = [];
			setHostFileMutationQueueLoader(async () => ({
				withFileMutationQueue: hostQueueDouble(queued),
				SessionManager,
			}));
			await withHostFileMutationQueue("a.ts", async () => {});
			expect(queued).toHaveLength(1);
			expect(resolvedRows()).toEqual([
				expect.objectContaining({ metadata: { hostCopy: "unverified" } }),
			]);
			expect(queueRows()).toEqual([]);
		});

		it("records the copy as unverified, and still queues, when the SDK exports no SessionManager", async () => {
			class SessionManager {}
			noteHostSessionManager(new SessionManager());
			const queued: string[] = [];
			setHostFileMutationQueueLoader(async () => ({
				withFileMutationQueue: hostQueueDouble(queued),
			}));
			await withHostFileMutationQueue("a.ts", async () => {});
			expect(queued).toHaveLength(1);
			expect(resolvedRows()).toEqual([
				expect.objectContaining({ metadata: { hostCopy: "unverified" } }),
			]);
			expect(queueRows()).toEqual([]);
		});

		it("records a degradation when the import loaded a second copy, and still queues through it", async () => {
			class HostSessionManager {}
			class SecondCopySessionManager {}
			noteHostSessionManager(new HostSessionManager());
			const queued: string[] = [];
			setHostFileMutationQueueLoader(async () => ({
				withFileMutationQueue: hostQueueDouble(queued),
				SessionManager: SecondCopySessionManager,
			}));
			await withHostFileMutationQueue("a.ts", async () => {});
			await withHostFileMutationQueue("b.ts", async () => {});
			expect(queued).toHaveLength(2);
			expect(resolvedRows()).toEqual([]);
			expect(queueRows()).toEqual([
				expect.objectContaining({
					count: 1,
					latestReasons: [
						{
							subject: "withFileMutationQueue",
							reason: expect.stringContaining("second copy"),
						},
					],
				}),
			]);
		});
	});
});
