import { AsyncLocalStorage } from "node:async_hooks";
import { getProcessSingleton } from "./process-singletons.js";

interface TurnContextState {
	sessions: Map<string, { turnId: string; turnIndex: number }>;
	activeSession: AsyncLocalStorage<string>;
}

const FAMILY = "turn-context";
const VERSION = 2;

function state(): TurnContextState {
	return getProcessSingleton(FAMILY, VERSION, () => ({
		sessions: new Map(),
		activeSession: new AsyncLocalStorage<string>(),
	}));
}

function sessionState(sessionId: string): {
	turnId: string;
	turnIndex: number;
} {
	const current = state();
	let session = current.sessions.get(sessionId);
	if (!session) {
		session = { turnId: `${sessionId}:0`, turnIndex: 0 };
		current.sessions.set(sessionId, session);
	}
	return session;
}

/** Reset the emit identity before a new session can publish rows. */
export function resetTurnContext(sessionId?: string): void {
	const current = state();
	if (sessionId === undefined) return;
	current.sessions.set(sessionId, { turnId: `${sessionId}:0`, turnIndex: 0 });
}

/** Ensure a stable host session has a counter without changing detached identity. */
export function setTurnContextSession(sessionId?: string): void {
	const current = state();
	const stableSessionId = sessionId?.trim();
	if (stableSessionId !== undefined && stableSessionId !== "")
		sessionState(stableSessionId);
}

/** Mint the one id shared by every row emitted during this turn. */
export function beginTurnContext(sessionId: string): string {
	const current = state();
	const session = sessionState(sessionId);
	session.turnIndex += 1;
	session.turnId = `${sessionId}:${session.turnIndex}`;
	return session.turnId;
}

/** Run a host event with the session identity that owns its writes. */
export function runWithTurnContext<T>(
	sessionId: string | undefined,
	fn: () => T,
): T {
	if (sessionId === undefined) return fn();
	return state().activeSession.run(sessionId, fn);
}

export function getTurnId(): string {
	const current = state();
	const sessionId = current.activeSession.getStore();
	if (sessionId === undefined) return "turn:0";
	return sessionState(sessionId).turnId;
}
