/**
 * #4631 on a pre-0.87 host: the `context` hook still injects, exactly once.
 *
 * The fix gates on what the EVENT carries, never on a version string, so this
 * file pins the older generation's shape: a `context` event whose messages
 * include the transcript's system messages, with a changed return list assigned
 * verbatim. Recorded from the certified 0.86.1 host
 * (`~/.local/share/pi-lens-orchestrator/pi-0.86.1`), whose real
 * `ExtensionRunner.emitContext` gives a handler exactly this:
 *
 *   { type: "context",
 *     messages: [system, user, assistant, system, user] }   // head + mid-list
 *   // and assigns `handlerResult.messages` verbatim, so the head survives
 *
 * 0.86.1 also never emits `context_with_system` (its `emitContext` has one
 * handler loop); `pi.on` stores that unknown name silently, so the newer
 * registration is inert there. A host that emitted both still injects once,
 * because the first hook consumes the queued payload.
 *
 * NOT OBSERVABLE AT TIER 2 (#4632 slice 3), so both cases keep the double.
 * Tier 2 (`tests/support/pi-session.ts`) runs the INSTALLED host, and no
 * payload there can carry the shape this file asserts: 1.3.0's own
 * `ExtensionRunner.emitContext` STRIPS the system messages before it builds a
 * `context` event — `dist/core/extensions/runner.js` does
 * `currentMessages.filter((message) => message.role !== "system")` into
 * `{ type: "context", messages: visibleMessages }` — so a tier-2 `context`
 * handler never sees the head, and the pre-0.87 arm cannot be driven from it.
 * The certified 0.86.1 host is the probe (#4632 acceptance 9's manual host
 * spread), not a per-PR tier-2 case. The row for this file in
 * `tests/support/pi-mock-importers.ts` records the class.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import { snapshotAdvisoryProvenance } from "../clients/advisory-provenance.js";
import { CacheManager } from "../clients/cache-manager.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./clients/test-utils.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const TMP_PREFIX = "pi-lens-4631-pre087-";
const FINDING_MARKER = "TESTFINDINGS_4631_PRE087";
let env: ReturnType<typeof setupTestEnvironment>;
let tmp: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	_resetSessionLifecycleForTests();
	env = setupTestEnvironment(TMP_PREFIX);
	tmp = env.tmpDir;
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmp, "data");
});

afterEach(async () => {
	// #5146: end the session before the lifecycle state and the root go.
	await endMockSessions();
	_resetSessionLifecycleForTests();
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	env.cleanup();
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});

/** The 0.86.1 request shape: the full transcript, system messages included. */
function pre087Transcript(): Array<Record<string, unknown>> {
	return [
		{
			role: "system",
			content: "You are pi.",
			sections: { tone: "terse" },
			timestamp: 1_700_000_000_000,
		},
		{ role: "user", content: "do the thing", timestamp: 1_700_000_001_000 },
		{
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			timestamp: 1_700_000_002_000,
		},
		{
			role: "system",
			content: "UPDATED SYSTEM PROMPT SECTION: tools changed",
			timestamp: 1_700_000_003_000,
		},
		{ role: "user", content: "keep working", timestamp: 1_700_000_004_000 },
	];
}

function seedTurnEndFindings(): void {
	const file = path.join(tmp, "unchanged.ts");
	fs.writeFileSync(file, "export const unchanged = true;\n");
	const provenance = snapshotAdvisoryProvenance({
		cwd: tmp,
		runtime: new RuntimeCoordinator(),
		generation: 1,
		files: [{ path: file, role: "affected" }],
	});
	new CacheManager().writeCache(
		"turn-end-findings",
		{ content: `${FINDING_MARKER} blocker`, provenance },
		tmp,
	);
}

async function boot(): Promise<ReturnType<typeof createPiMock>> {
	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	await pi.emit(
		"session_start",
		{ type: "session_start", reason: "new" },
		makeCtx({ cwd: tmp, sessionId: "pre-087-session" }),
	);
	return pi;
}

describe("#4631 a pre-0.87 host injects in `context`", () => {
	it("returns the injected list from `context` when the event carries the head", async () => {
		const pi = await boot();
		seedTurnEndFindings();

		const result = (await pi.emit(
			"context",
			{ messages: pre087Transcript() },
			makeCtx({ cwd: tmp, sessionId: "pre-087-session" }),
		)) as { messages?: Array<Record<string, unknown>> } | undefined;

		expect(result?.messages).toBeDefined();
		const messages = result?.messages ?? [];
		// Prepended-equivalent append: the head and the mid-list system message
		// are untouched, and the finding lands after the transcript.
		expect(messages[0]).toEqual(pre087Transcript()[0]);
		expect(messages[3]).toEqual(pre087Transcript()[3]);
		expect(JSON.stringify(messages)).toContain(FINDING_MARKER);
		expect(JSON.stringify(messages).split(FINDING_MARKER)).toHaveLength(2);
	});

	it("adds nothing a second time when both request hooks fire", async () => {
		const pi = await boot();
		seedTurnEndFindings();

		const first = (await pi.emit(
			"context",
			{ messages: pre087Transcript() },
			makeCtx({ cwd: tmp, sessionId: "pre-087-session" }),
		)) as { messages?: Array<Record<string, unknown>> } | undefined;
		expect(JSON.stringify(first)).toContain(FINDING_MARKER);

		// A host that ALSO emitted the newer hook must not inject a second copy:
		// the payload was consumed by the `context` hook above.
		const second = await pi.emit(
			"context_with_system",
			{ messages: first?.messages ?? [] },
			makeCtx({ cwd: tmp, sessionId: "pre-087-session" }),
		);
		expect(JSON.stringify(second ?? "")).not.toContain(FINDING_MARKER);
	});
});
