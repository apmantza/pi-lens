/**
 * #3506: the host-queue lookup behind pi-lens' own writers. The pi adapter
 * registers the lookup; a host that cannot serve it must still let the writer
 * run, and must say so once in the degradation ledger (AGENTS.md shape 10: a
 * lost safety property is never silent).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	setHostFileMutationQueueLoader,
	withHostFileMutationQueue,
} from "../../clients/file-mutation-queue.js";

const KIND = "host-file-mutation-queue-unavailable";

function queueRows() {
	return getDegradationSummary().filter((group) => group.kind === KIND);
}

describe("withHostFileMutationQueue (#3506)", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});
	afterEach(() => {
		setHostFileMutationQueueLoader(undefined);
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
						subject: "@earendil-works/pi-coding-agent",
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
						subject: "@earendil-works/pi-coding-agent",
						reason: "the host SDK exports no withFileMutationQueue",
					},
				],
			}),
		]);
	});
});
