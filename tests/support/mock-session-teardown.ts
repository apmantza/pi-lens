// flake-shape: ungoverned-wait-for — the fast POSIX shutdown sends SIGTERM and returns without awaiting the child's exit, and that exit exposes no awaitable, so the census vi.waitFor polls /proc for the owned child to leave.
/**
 * The one teardown for sessions a test starts through `createPiMock` (#5146).
 *
 * The recurrence this prevents: a test that emitted `session_start` and never
 * `session_shutdown` left the `ast-grep lsp` child its `tool_result` spawned
 * alive in the worker. On CI that child outlived its file and reached
 * `tests/index-4632-s7-turn-end-ordering.test.ts`'s orphan sweep, which
 * refused it: `kill pid -6885 (SIGKILL)` under the #2042 kill guard (PR #5161
 * shard 5, job 124892873231). `tests/config/mock-session-teardown-sweep.test.ts`
 * pins that no importer of the double starts a session and skips this.
 *
 * `pi-mock.ts` reports every `session_start` / `session_shutdown` its `emit`
 * carries to {@link trackSessionEvent}. A test calls {@link endMockSessions}
 * first in its `afterEach`, before it removes the fixture root: it ends every
 * session still open in reverse start order, as the host does (the primary,
 * started first, ends last and runs the shared LSP fleet reset; a secondary's
 * shutdown skips it while a session is live, #4554), then, on Linux, asserts
 * that no `ast-grep lsp` child this worker owns outlived the case.
 *
 * Nothing here fakes a store: the shutdown handlers are the extension's own.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, vi } from "vitest";

/** The slice of `PiMock` the tracker needs, so this module never loads the double. */
interface SessionHost {
	emit(event: string, payload?: unknown, ctx?: unknown): Promise<unknown>;
}

interface OpenSession {
	host: SessionHost;
	ctx: unknown;
}

const open: OpenSession[] = [];
let childrenBeforeCase: ReadonlySet<number> = new Set();

// lane: unit-linux. The census reads `/proc`, which only Linux has. Other hosts
// still end every session and skip only the census.
const CENSUS_HOST = process.platform === "linux";

/** A session's identity as the host names it: its id and working directory. */
function identityOf(ctx: unknown): { sessionId?: string; cwd?: string } {
	try {
		const c = ctx as {
			cwd?: string;
			sessionManager?: { getSessionId?: () => string | undefined };
		};
		return { sessionId: c.sessionManager?.getSessionId?.(), cwd: c.cwd };
	} catch {
		// An invalidated ctx throws on every accessor (`makeStaleCtx`).
		return {};
	}
}

/**
 * The `ast-grep lsp` children this worker owns (#5146): alive, parented to this
 * process, launched as `ast-grep lsp`. The #2042 kill guard refuses a child that
 * outlives its worker, found later by the production orphan sweep. Read from
 * `/proc`, so the census spawns nothing.
 */
export function astGrepLspChildrenOwnedHere(): number[] {
	const owned: number[] = [];
	// `opendirSync`, not `readdirSync`: this lists processes, not a source tree,
	// and `pi-mock.ts` reaches it, so a `readdirSync` here would make the
	// tree-scanner census (#3426) read every importer of the double as a walker.
	const procDir = fs.opendirSync("/proc");
	try {
		for (let e = procDir.readSync(); e !== null; e = procDir.readSync()) {
			const entry = e.name;
			if (!/^\d+$/.test(entry)) continue;
			try {
				// `pid (comm) state ppid ...`: `comm` may hold spaces, so split after `)`.
				const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
				const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
				if (Number(ppid) !== process.pid || state === "Z" || state === "X") {
					continue;
				}
				const argv = fs
					.readFileSync(`/proc/${entry}/cmdline`, "utf8")
					.split("\0");
				if (path.basename(argv[0] ?? "") === "ast-grep" && argv[1] === "lsp") {
					owned.push(Number(entry));
				}
			} catch {
				// Exited between the listing and the read: not a live child.
			}
		}
	} finally {
		procDir.closeSync();
	}
	return owned;
}

/**
 * Called by `PiMock.emit` for every event it carries. A start opens a session,
 * a shutdown closes the matching one (same host, id and directory), so a test
 * that ends a session by hand is not ended twice.
 */
export function trackSessionEvent(
	host: SessionHost,
	event: string,
	ctx: unknown,
): void {
	if (event === "session_start") {
		// The census judges only the children this case created: a child an
		// earlier case left in this worker is that case's to answer for.
		if (open.length === 0 && CENSUS_HOST) {
			childrenBeforeCase = new Set(astGrepLspChildrenOwnedHere());
		}
		open.push({ host, ctx });
		return;
	}
	if (event !== "session_shutdown") return;
	const { sessionId, cwd } = identityOf(ctx);
	for (let i = open.length - 1; i >= 0; i--) {
		const s = open[i];
		const id = identityOf(s.ctx);
		if (s.host === host && id.sessionId === sessionId && id.cwd === cwd) {
			open.splice(i, 1);
			return;
		}
	}
}

/**
 * Ends the sessions the running case left open and checks the case left no
 * `ast-grep lsp` child behind. A no-op when every session already ended.
 */
export async function endMockSessions(): Promise<void> {
	if (open.length === 0) return;
	let failure: unknown;
	for (let s = open.pop(); s !== undefined; s = open.pop()) {
		try {
			await s.host.emit("session_shutdown", { reason: "quit" }, s.ctx);
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
	if (!CENSUS_HOST) return;
	// #5146 (CI: PR #5155 shard 4/5, job 124859079792): the fast POSIX shutdown
	// sends SIGTERM and returns, so the child can still be exiting here. Poll,
	// bounded: a child that never leaves still reds, with the same pid list.
	await vi.waitFor(
		() => {
			expect(
				astGrepLspChildrenOwnedHere().filter(
					(pid) => !childrenBeforeCase.has(pid),
				),
			).toEqual([]);
		},
		{ timeout: 2_000, interval: 25 },
	);
}
