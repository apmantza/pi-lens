// flake-shape: ungoverned-wait-for — the fast POSIX shutdown sends SIGTERM and returns without awaiting the child's exit, and that exit exposes no awaitable, so the census vi.waitFor polls /proc for the owned child to leave.
/**
 * The one teardown for sessions a test starts through `createPiMock` (#5146).
 *
 * The recurrence this prevents: a test that emitted `session_start` and never
 * `session_shutdown` left the `ast-grep lsp` child its `tool_result` spawned
 * alive in the worker. On CI that child outlived its file and reached
 * `tests/index-4632-s7-turn-end-ordering.test.ts`'s orphan sweep, which
 * refused it: `kill pid -6885 (SIGKILL)` under the #2042 kill guard (PR #5161
 * shard 5, job 124892873231). The root `afterEach` of
 * `pi-mock.ts` (`failOnOpenMockSessions`) reds any case that skips this.
 *
 * `pi-mock.ts` reports every `session_start` / `session_shutdown` handler call
 * to {@link trackSessionEvent}, whichever route reached the handler (`emit`, a
 * handler out of `getHandlers`, a loop over `handlers`). A test calls
 * {@link endMockSessions} first in its `afterEach`, before it removes the
 * fixture root: it ends every session still open in reverse start order, as the
 * host does (the primary, started first, ends last and runs the shared LSP
 * fleet reset; a secondary's shutdown skips it while a session is live, #4554),
 * then, on Linux, asserts that no `ast-grep lsp` child this worker owns
 * outlived the case.
 *
 * Nothing trusts a file to call it: `pi-mock.ts` registers a root `afterEach`
 * that runs last and calls {@link failOnOpenMockSessions}, which reds the case
 * that left a session open, and ends it so the next case starts clean. The rule
 * is derived from what the double observed, not from a scan of how a test is
 * spelled.
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
/** A session started in the running case: its census is owed even if it was ended by hand. */
let startedThisCase = false;
let childrenBeforeCase: ReadonlySet<number> = new Set();

// lane: unit-linux. The census reads `/proc`, which only Linux has. Other hosts
// still end every session and skip only the census.
const CENSUS_HOST = process.platform === "linux";
/** Where the census reads; `mock-session-teardown.test.ts` points it at a fixture tree. */
let censusProcRoot = "/proc";

/** Test seam: read the census from `root` until the returned function restores `/proc`. */
export function readCensusFromForTests(root: string): () => void {
	censusProcRoot = root;
	return () => {
		censusProcRoot = "/proc";
	};
}

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
 * `/proc`, so the census spawns nothing. `procRoot` and `workerPid` are the
 * seams `mock-session-teardown.test.ts` feeds a fixture tree through.
 */
export function astGrepLspChildrenOwnedHere(
	procRoot = "/proc",
	workerPid = process.pid,
): number[] {
	const owned: number[] = [];
	// `opendirSync`, not `readdirSync`: this lists processes, not a source tree,
	// and `pi-mock.ts` reaches it, so a `readdirSync` here would make the
	// tree-scanner census (#3426) read every importer of the double as a walker.
	const procDir = fs.opendirSync(procRoot);
	try {
		for (let e = procDir.readSync(); e !== null; e = procDir.readSync()) {
			const entry = e.name;
			if (!/^\d+$/.test(entry)) continue;
			try {
				// `pid (comm) state ppid ...`: `comm` may hold spaces, so split after `)`.
				const stat = fs.readFileSync(`${procRoot}/${entry}/stat`, "utf8");
				const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
				if (Number(ppid) !== workerPid || state === "Z" || state === "X") {
					continue;
				}
				const argv = fs
					.readFileSync(`${procRoot}/${entry}/cmdline`, "utf8")
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
 * The owned children the case created: those the census sees now that it did not
 * see when the case's first session started.
 */
export function newAstGrepLspChildren(
	before: ReadonlySet<number>,
	procRoot = "/proc",
	workerPid = process.pid,
): number[] {
	return astGrepLspChildrenOwnedHere(procRoot, workerPid).filter(
		(pid) => !before.has(pid),
	);
}

/**
 * Called by the double's `session_start` / `session_shutdown` handler wrapper
 * (`PiMock.on`), whichever route reached the handler. A start opens a session,
 * a shutdown closes the matching one (same host, id and directory), so a test
 * that ends a session by hand is not ended twice.
 */
export function trackSessionEvent(
	host: SessionHost,
	event: string,
	ctx: unknown,
): void {
	if (event === "session_start") {
		// Every `session_start` handler of one emit gets the same ctx: one session.
		if (open.some((s) => s.host === host && s.ctx === ctx)) return;
		// The census judges only the children this case created: a child an
		// earlier case left in this worker is that case's to answer for.
		if (!startedThisCase && CENSUS_HOST) {
			childrenBeforeCase = new Set(astGrepLspChildrenOwnedHere(censusProcRoot));
		}
		startedThisCase = true;
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
 * The census (#5146): no `ast-grep lsp` child this worker owns outlived the
 * case. Owed by every case that started a session, ended by hand or here.
 */
async function assertNoLeakedLspChild(): Promise<void> {
	startedThisCase = false;
	if (!CENSUS_HOST) return;
	// #5146 (CI: PR #5155 shard 4/5, job 124859079792): the fast POSIX shutdown
	// sends SIGTERM and returns, so the child can still be exiting here. Poll,
	// bounded: a child that never leaves still reds, with the same pid list.
	await vi.waitFor(
		() => {
			expect(newAstGrepLspChildren(childrenBeforeCase, censusProcRoot)).toEqual(
				[],
			);
		},
		{ timeout: 2_000, interval: 25 },
	);
}

/**
 * Ends the sessions the running case left open and checks the case left no
 * `ast-grep lsp` child behind. A no-op when the case started no session.
 */
export async function endMockSessions(): Promise<void> {
	let failure: unknown;
	for (let s = open.pop(); s !== undefined; s = open.pop()) {
		try {
			await s.host.emit("session_shutdown", { reason: "quit" }, s.ctx);
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) {
		startedThisCase = false;
		throw failure;
	}
	if (startedThisCase) await assertNoLeakedLspChild();
}

/**
 * The root `afterEach` of `pi-mock.ts` (#5146): the case ended with a session
 * still open, so no `afterEach` of the file ended it. Ends it anyway, so the
 * next case does not inherit it and its child, then reds the case. A case that
 * ended its sessions by hand still owes the census.
 */
export async function failOnOpenMockSessions(): Promise<void> {
	const left = open.length;
	if (left === 0) {
		if (startedThisCase) await assertNoLeakedLspChild();
		return;
	}
	let cause: unknown;
	try {
		await endMockSessions();
	} catch (error) {
		cause = error;
	}
	throw new Error(
		`${left} pi-mock session(s) still open when the case ended; call endMockSessions() from tests/support/mock-session-teardown.ts first in the file's afterEach, before it removes the fixture root (#5146, the s7 orphan-sweep red on PR #5161 shard 5)`,
		{ cause },
	);
}
