/**
 * The host-exit ledger's two questions, for a module that cannot import
 * `safe-spawn.ts` (#5699).
 *
 * `safe-spawn.ts` holds every LSP child a host spawned and SIGKILLs their
 * process groups when the host exits. `instance-registry.ts` must ask it
 * whether any child is still held (a quit keeps the registry row then) and
 * whether the exit kill confirmed every death (only then the row goes).
 * Importing `safe-spawn.ts` there closes a module cycle, so `safe-spawn.ts`
 * provides its answers here when it loads, and the registry reads them here.
 *
 * Before `safe-spawn.ts` loads, the process has spawned no child, so it holds
 * none and nothing is left to end: the defaults answer exactly that. The
 * provider lives on a process singleton because the held store does too: the
 * exit handler of one evaluation must see the children of every evaluation.
 */
import { getProcessSingleton } from "./process-singletons.js";

export interface HeldChildrenLedger {
	/** Whether any child is still held. */
	holds(): boolean;
	/** SIGKILL every held child's process group now; true when each death
	 *  is confirmed. Synchronous and spawn-free: it runs in `exit` handlers. */
	end(): boolean;
}

export interface OwnedChildLedger {
	record(entry: {
		pid: number;
		serverId: string;
		command: string;
	}): Promise<void>;
	remove(pid: number): Promise<void>;
}

const FAMILY = "held-children.ledger";
/** Bump when the cell's shape changes. */
const VERSION = 1;

function cell(): {
	ledger: HeldChildrenLedger | undefined;
	owned: OwnedChildLedger | undefined;
} {
	return getProcessSingleton(FAMILY, VERSION, () => ({
		ledger: undefined as HeldChildrenLedger | undefined,
		owned: undefined as OwnedChildLedger | undefined,
	}));
}

/** Called once by `safe-spawn.ts` at load. */
export function provideHeldChildrenLedger(ledger: HeldChildrenLedger): void {
	cell().ledger = ledger;
}

export function provideOwnedChildLedger(ledger: OwnedChildLedger): void {
	cell().owned = ledger;
}

export function recordOwnedChild(entry: {
	pid: number;
	serverId: string;
	command: string;
}): Promise<void> {
	return cell().owned?.record(entry) ?? Promise.resolve();
}

export function removeOwnedChild(pid: number): Promise<void> {
	return cell().owned?.remove(pid) ?? Promise.resolve();
}

export function holdsChildren(): boolean {
	return cell().ledger?.holds() ?? false;
}

export function endHeldChildren(): boolean {
	return cell().ledger?.end() ?? true;
}
