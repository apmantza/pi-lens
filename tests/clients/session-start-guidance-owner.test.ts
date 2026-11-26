/**
 * #5792: `consumeSessionStartGuidance` answers to the session whose full
 * `session_start` wrote the record. The tier-2 witness is
 * `tests/index-5792-guidance-per-session.test.ts`; this file pins the record
 * rules at the seam, including the pre-#5792 record every upgraded project
 * may still hold.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { consumeSessionStartGuidance } from "../../clients/runtime-context.js";
import { setupTestEnvironment } from "./test-utils.js";

/** The coordinator and a concurrent secondary, as ids a request reads as. */
const PRIMARY = "primary-session";
const SECONDARY = "secondary-session";
const asPrimary = { sessionId: PRIMARY, coordinatorId: PRIMARY };
const asSecondary = { sessionId: SECONDARY, coordinatorId: PRIMARY };

/**
 * A record exactly as pi-lens 4.5.2 wrote it (`{ content }` with no session
 * field), taken from the version's own writer.
 */
const OLD_RECORD = path.join(
	process.cwd(),
	"tests/fixtures/session-start-guidance/4.5.2-unconsumed.json",
);

let env: ReturnType<typeof setupTestEnvironment>;
let cache: CacheManager;

function recordFile(): string {
	return path.join(
		getProjectDataDir(env.tmpDir),
		"cache",
		"session-start-guidance.json",
	);
}

function skips(): Array<{ count: number; subjects: string[] }> {
	return getDegradationSummary()
		.filter(
			(group) => group.kind === "session-start-guidance-addressed-elsewhere",
		)
		.map((group) => ({
			count: group.count,
			subjects: group.latestReasons.map((entry) => entry.subject),
		}));
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-5792-owner-");
	cache = new CacheManager(false);
	resetDegradationLedger();
});

afterEach(() => env.cleanup());

describe("#5792 the guidance record's owner", () => {
	it("hands a record to the session that wrote it and consumes it", () => {
		cache.writeCache(
			"session-start-guidance",
			{ content: "GUIDANCE-A", sessionId: PRIMARY },
			env.tmpDir,
		);
		const taken = consumeSessionStartGuidance(cache, env.tmpDir, asPrimary);
		expect(taken?.messages[0]?.content).toContain("GUIDANCE-A");
		expect(JSON.parse(fs.readFileSync(recordFile(), "utf8"))).toEqual({
			content: "",
		});
		expect(consumeSessionStartGuidance(cache, env.tmpDir, asPrimary)).toBe(
			undefined,
		);
	});

	it("leaves another session's record untouched and records the skip once per owner", () => {
		// RECURRENCE GUARDED: #5792, a second session's request consumed the
		// writer's guidance from the shared per-project record.
		cache.writeCache(
			"session-start-guidance",
			{ content: "GUIDANCE-A", sessionId: PRIMARY },
			env.tmpDir,
		);
		const before = fs.readFileSync(recordFile(), "utf8");
		for (let request = 0; request < 3; request++)
			expect(consumeSessionStartGuidance(cache, env.tmpDir, asSecondary)).toBe(
				undefined,
			);
		expect(fs.readFileSync(recordFile(), "utf8")).toBe(before);
		expect(skips()).toEqual([{ count: 1, subjects: [PRIMARY] }]);
		// The owner still takes it afterwards.
		expect(
			consumeSessionStartGuidance(cache, env.tmpDir, asPrimary)?.messages[0]
				?.content,
		).toContain("GUIDANCE-A");
	});

	it("does not replay an ended session's record to the session that replaced it", () => {
		// RECURRENCE GUARDED: #5792 table row "writes, session ends, new session
		// starts": a quick start writes nothing, so the old record is still there
		// under the old id and the new session's id must not match it.
		cache.writeCache(
			"session-start-guidance",
			{ content: "GUIDANCE-ENDED", sessionId: "ended-session" },
			env.tmpDir,
		);
		const successor = {
			sessionId: "new-session",
			coordinatorId: "new-session",
		};
		expect(consumeSessionStartGuidance(cache, env.tmpDir, successor)).toBe(
			undefined,
		);
		expect(skips()).toEqual([{ count: 1, subjects: ["ended-session"] }]);
	});

	it("hands a record written before #5792 to the coordinator only", () => {
		// RECURRENCE GUARDED: an upgrade leaves the 4.5.2 `{ content }` record
		// (no session field) on disk. The pre-fix writer was always the
		// coordinator's full start, so the coordinator takes it; a secondary
		// cannot prove it wrote one.
		const content = (
			JSON.parse(fs.readFileSync(OLD_RECORD, "utf8")) as { content: string }
		).content;
		expect(
			Object.keys(JSON.parse(fs.readFileSync(OLD_RECORD, "utf8"))),
		).toEqual(["content"]);
		cache.writeCache("session-start-guidance", { content }, env.tmpDir);
		const before = fs.readFileSync(recordFile(), "utf8");
		expect(fs.readFileSync(recordFile(), "utf8")).toBe(
			fs.readFileSync(OLD_RECORD, "utf8"),
		);
		expect(consumeSessionStartGuidance(cache, env.tmpDir, asSecondary)).toBe(
			undefined,
		);
		expect(fs.readFileSync(recordFile(), "utf8")).toBe(before);
		expect(skips()).toEqual([{ count: 1, subjects: ["unstamped"] }]);
		expect(
			consumeSessionStartGuidance(cache, env.tmpDir, asPrimary)?.messages[0]
				?.content,
		).toContain("pi-lens active");
	});

	it("refuses a stamped record no session took within the cache's age bound", () => {
		// The bound that keeps an abandoned record from replaying to a later
		// session: `readCache`'s 30-minute age limit applies to the record.
		cache.writeCache(
			"session-start-guidance",
			{ content: "GUIDANCE-A", sessionId: PRIMARY },
			env.tmpDir,
		);
		const meta = path.join(
			getProjectDataDir(env.tmpDir),
			"cache",
			"session-start-guidance.meta.json",
		);
		fs.writeFileSync(
			meta,
			JSON.stringify({
				timestamp: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
			}),
		);
		expect(consumeSessionStartGuidance(cache, env.tmpDir, asPrimary)).toBe(
			undefined,
		);
	});
});
