import { AsyncLocalStorage } from "node:async_hooks";
import { getProcessSingleton } from "./process-singletons.js";

interface TurnContextState {
	sessions: Map<string, { turnId: string; turnIndex: number }>;
	fallbackSessionId: string | undefined;
	activeSession: AsyncLocalStorage<string>;
}

const FAMILY = "turn-context";
const VERSION = 2;

function state(): TurnContextState {
	return getProcessSingleton(FAMILY, VERSION, () => ({
		sessions: new Map(),
		fallbackSessionId: undefined,
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
	current.fallbackSessionId = sessionId;
	if (sessionId === undefined) return;
	current.sessions.set(sessionId, { turnId: `${sessionId}:0`, turnIndex: 0 });
}

/** Adopt the stable host session id without advancing the turn counter. */
export function setTurnContextSession(sessionId?: string): void {
	const current = state();
	current.fallbackSessionId = sessionId?.trim() || undefined;
	if (current.fallbackSessionId !== undefined)
		sessionState(current.fallbackSessionId);
}

/** Mint the one id shared by every row emitted during this turn. */
export function beginTurnContext(sessionId: string): string {
	const current = state();
	const session = sessionState(sessionId);
	current.fallbackSessionId = sessionId;
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
	const sessionId =
		current.activeSession.getStore() ?? current.fallbackSessionId;
	if (sessionId === undefined) return "turn:0";
	return sessionState(sessionId).turnId;
}
