import { getProcessSingleton } from "./process-singletons.js";

interface TurnContextState {
	sessionId: string | undefined;
	turnId: string;
	turnIndex: number;
}

const FAMILY = "turn-context";
const VERSION = 1;

function state(): TurnContextState {
	return getProcessSingleton(FAMILY, VERSION, () => ({
		sessionId: undefined,
		turnId: "turn:0",
		turnIndex: 0,
	}));
}

/** Reset the emit identity before a new session can publish rows. */
export function resetTurnContext(sessionId?: string): void {
	const current = state();
	current.sessionId = sessionId;
	current.turnIndex = 0;
	current.turnId = "turn:0";
}

/** Adopt the stable host session id without advancing the turn counter. */
export function setTurnContextSession(sessionId?: string): void {
	const current = state();
	current.sessionId = sessionId?.trim() || undefined;
	current.turnId =
		current.sessionId === undefined
			? "turn:0"
			: `${current.sessionId}:${current.turnIndex}`;
}

/** Mint the one id shared by every row emitted during this turn. */
export function beginTurnContext(sessionId: string): string {
	const current = state();
	current.sessionId = sessionId;
	current.turnIndex += 1;
	current.turnId = `${sessionId}:${current.turnIndex}`;
	return current.turnId;
}

export function getTurnId(): string {
	return state().turnId;
}
