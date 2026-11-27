/**
 * #5770 F5 (dispose route): a session pi disposes with no `session_shutdown`
 * gives its retained injections back, as its shutdown does.
 *
 * Recurrence prevented: `endDisposedMember` (#4965) ended a disposed member's
 * scope and nothing else, so the retained-injection ledger kept that session's
 * entries. With `retainMaxSessions: 0` no LRU eviction drops them either, so
 * they outlived the member for as long as the activation's ledger did. The
 * shutdown route already clears them (`tests/clients/context-injection-tail-
 * stability.test.ts`).
 *
 * Production trigger: pi's `AgentSession.dispose()` invalidates the session's
 * contexts and emits no `session_shutdown`; the next process read of the
 * member lists (any session start, in any activation) finds the member
 * disposed and calls its `onDisposed`. Here that read is a second activation's
 * `session_start`.
 *
 * Tier 2, inline-factory mode, because the ledger is private to the
 * activation: `clients/context-injection-ledger.js` is wrapped so the REAL
 * ledger each activation creates is also handed to the test, which reads
 * `size()`. Nothing is replaced.
 *
 * Does not prove: a host whose dispose leaves the rest of the activation
 * working. pi 1.6.0's does not: `dispose()` invalidates the loader's shared
 * extension runtime, so a sibling of the disposed session in one activation
 * can no longer read the ledger either, and its entries are retained memory,
 * not a stale reply.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	ledgers: [] as Array<{ size(sessionId: string): number }>,
}));

vi.mock("../clients/context-injection-ledger.js", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("../clients/context-injection-ledger.js")
		>();
	return {
		...original,
		createInjectionLedger: (
			...args: Parameters<typeof original.createInjectionLedger>
		) => {
			const ledger = original.createInjectionLedger(...args);
			captured.ledgers.push(ledger);
			return ledger;
		},
	};
});

import { CacheManager } from "../clients/cache-manager.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	fauxAssistantMessage,
	fauxText,
	hostModule,
	type PiSession,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

afterEach(() => {
	vi.unstubAllEnvs();
	_resetSessionLifecycleForTests();
});

interface EmbeddedSession {
	readonly model: unknown;
	readonly modelRuntime: unknown;
	readonly settingsManager: unknown;
	readonly resourceLoader: unknown;
	readonly sessionManager: { getSessionId(): string };
	readonly extensionRunner: {
		emitContext(
			messages: Array<{ role: string; content: unknown }>,
		): Promise<unknown>;
	};
	bindExtensions(bindings: {
		onError: (error: unknown) => void;
	}): Promise<void>;
	dispose(): void;
}

/** A second session on `live`'s activation: the embedder's shape, built from its loader. */
async function embeddedSession(
	live: PiSession,
	cwd: string,
): Promise<EmbeddedSession> {
	const liveSession = live.session as unknown as EmbeddedSession;
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const host = hostModule();
	const created = await host.createAgentSessionFromServices({
		services: {
			cwd,
			agentDir: path.join(fixture.root, "agent"),
			modelRuntime: liveSession.modelRuntime,
			settingsManager: liveSession.settingsManager,
			resourceLoader: liveSession.resourceLoader,
		},
		sessionManager: host.SessionManager.inMemory(cwd),
		model: liveSession.model,
	} as unknown as Parameters<typeof host.createAgentSessionFromServices>[0]);
	const embedded = created.session as unknown as EmbeddedSession;
	await embedded.bindExtensions({ onError: () => undefined });
	return embedded;
}

// #5792: the guidance record is the writing session's; a second session on the
// activation reads as its own id, the coordinator's as no id.
function stage(cwd: string, text: string, sessionId?: string): void {
	new CacheManager(false).writeCache(
		"session-start-guidance",
		{ content: text, ...(sessionId ? { sessionId } : {}) },
		cwd,
	);
}

async function retainSession(name: string): Promise<PiSession> {
	const cwd = path.join(fixture.root, name, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	return startPiSession({
		root: fixture.root,
		cwd,
		startupMode: "quick",
		flags: new Map([["lens-retain-injections", true]]),
		inlineFactory: async () => (await import("../index.js")).default,
		responses: [fauxAssistantMessage(fauxText("unused"))],
	});
}

describe("#5770 F5: a session pi disposed with no shutdown gives its retained injections back", () => {
	it("clears the disposed member's ledger entries at the next process read and keeps a live sibling's", async () => {
		const configPath = path.join(fixture.root, "retain-caps-config.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({ contextInjection: { retainMaxSessions: 0 } }),
		);
		vi.stubEnv("PI_LENS_CONFIG_PATH", configPath);
		const live = await retainSession("disposed-ledger-live");
		const ledger = captured.ledgers.at(-1);
		expect(ledger).toBeDefined();
		if (!ledger) return;
		const liveId = live.session.sessionManager.getSessionId();
		const opened: PiSession[] = [];
		const disposedCwd = path.join(fixture.root, "disposed-ledger", "proj");
		const disposed = await embeddedSession(live, disposedCwd);
		const disposedId = disposed.sessionManager.getSessionId();
		try {
			expect(disposedId).not.toBe(liveId);
			const transcript = () => [{ role: "user", content: "question" }];
			stage(live.cwd, "DISPOSED_LEDGER_LIVE_FINDING");
			await (
				live.session as unknown as EmbeddedSession
			).extensionRunner.emitContext(transcript());
			stage(disposedCwd, "DISPOSED_LEDGER_ENDED_FINDING", disposedId);
			await disposed.extensionRunner.emitContext(transcript());
			// Control: each session holds its own injection before the dispose.
			expect([ledger.size(liveId), ledger.size(disposedId)]).toEqual([1, 1]);

			// pi disposes the session: its contexts go stale, no session_shutdown.
			disposed.dispose();
			expect(ledger.size(disposedId)).toBe(1);

			// A later session start, here another activation's, reads the lists.
			opened.push(await retainSession("disposed-ledger-next"));

			expect(ledger.size(disposedId)).toBe(0);
			expect(ledger.size(liveId)).toBe(1);
			// The member stays listed, so every later read calls `onDisposed`
			// again: a repeat finds nothing to clear and touches no sibling.
			opened.push(await retainSession("disposed-ledger-again"));
			expect([ledger.size(liveId), ledger.size(disposedId)]).toEqual([1, 0]);
			expect(live.errors).toEqual([]);
		} finally {
			for (const handle of opened) await handle.dispose();
			disposed.dispose();
			await live.dispose();
		}
	}, 60_000);
});
