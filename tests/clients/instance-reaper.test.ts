/**
 * Tests for the PURE decision logic in clients/instance-reaper.ts
 * (`decideOrphanReaping`) — #472. All liveness/identity checks are injected
 * fake predicates; no real process.kill/spawn ever runs in these tests.
 */

import { describe, expect, it } from "vitest";
import {
	buildIdentityMatcher,
	decideBackstopOrphanReaping,
	decideOrphanReaping,
	STALE_HEARTBEAT_MS,
	type ChildToKill,
	type OsProcessInfo,
} from "../../clients/instance-reaper.js";
import type { InstanceEntry, LspChildEntry } from "../../clients/instance-registry.js";

function child(overrides: Partial<LspChildEntry> = {}): LspChildEntry {
	return {
		pid: 1000,
		serverId: "ast-grep",
		command: "ast-grep.exe",
		spawnedAt: new Date().toISOString(),
		...overrides,
	};
}

function instance(overrides: Partial<InstanceEntry> = {}): InstanceEntry {
	return {
		pid: 1,
		startedAt: new Date().toISOString(),
		projectRoot: "/proj",
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: new Date().toISOString(),
		...overrides,
	};
}

function alivePids(...pids: number[]): (pid: number) => boolean {
	const set = new Set(pids);
	return (pid) => set.has(pid);
}

describe("decideOrphanReaping", () => {
	it("live parent pid — instance and all its children are left untouched", () => {
		const reg = [
			instance({ pid: 1, lspChildren: [child({ pid: 100 })] }),
		];
		const decision = decideOrphanReaping(reg, alivePids(1, 100));

		expect(decision.deadInstances).toHaveLength(0);
		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toHaveLength(0);
	});

	it("dead parent pid + live child pid — child goes in the kill list", () => {
		const reg = [
			instance({ pid: 1, lspChildren: [child({ pid: 100, serverId: "ast-grep" })] }),
		];
		const decision = decideOrphanReaping(reg, alivePids(100)); // 1 is dead

		expect(decision.deadInstances).toHaveLength(1);
		expect(decision.deadInstances[0].pid).toBe(1);
		expect(decision.childrenToKill).toEqual<ChildToKill[]>([
			{ pid: 100, serverId: "ast-grep", command: "ast-grep.exe" },
		]);
		expect(decision.markerSearches).toHaveLength(0);
	});

	it("dead parent pid + already-dead child pid, no marker — nothing to kill or search", () => {
		const reg = [instance({ pid: 1, lspChildren: [child({ pid: 100 })] })];
		const decision = decideOrphanReaping(reg, alivePids()); // nothing alive

		expect(decision.deadInstances).toHaveLength(1);
		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toHaveLength(0);
	});

	it("dead parent pid + dead child pid WITH a marker — surfaces a marker search, not a direct kill", () => {
		const reg = [
			instance({
				pid: 1,
				lspChildren: [
					child({ pid: 100, marker: "C:/temp/pi-lens-ast-grep/x.yml" }),
				],
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids());

		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toEqual([
			{ marker: "C:/temp/pi-lens-ast-grep/x.yml", serverId: "ast-grep" },
		]);
	});

	it("ESRCH-vs-EPERM conservatism: an ambiguous/ EPERM-style liveness result must NOT be treated as dead", () => {
		// Simulate: isPidAlive returns true for pid 1 (EPERM path — exists, no
		// permission, or any non-ESRCH outcome must be conservative "alive").
		const reg = [instance({ pid: 1, lspChildren: [child({ pid: 100 })] })];
		const decision = decideOrphanReaping(reg, alivePids(1, 100));

		expect(decision.deadInstances).toHaveLength(0);
		expect(decision.childrenToKill).toHaveLength(0);
	});

	it("multiple dead instances each contribute their own children to the kill list", () => {
		const reg = [
			instance({ pid: 1, lspChildren: [child({ pid: 100, serverId: "ast-grep" })] }),
			instance({ pid: 2, lspChildren: [child({ pid: 200, serverId: "typescript" })] }),
		];
		const decision = decideOrphanReaping(reg, alivePids(100, 200)); // both parents dead

		expect(decision.deadInstances).toHaveLength(2);
		expect(decision.childrenToKill).toHaveLength(2);
		expect(decision.childrenToKill.map((c) => c.serverId).sort()).toEqual([
			"ast-grep",
			"typescript",
		]);
	});

	it("a live child under a matchProcess identity mismatch (recycled pid) is NOT killed directly, falls to marker search", () => {
		const reg = [
			instance({
				pid: 1,
				lspChildren: [
					child({
						pid: 100,
						command: "ast-grep.exe",
						marker: "C:/temp/pi-lens-ast-grep/y.yml",
					}),
				],
			}),
		];
		const matchProcess = () => false; // pid recycled to an unrelated process
		const decision = decideOrphanReaping(reg, alivePids(100), matchProcess);

		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toEqual([
			{ marker: "C:/temp/pi-lens-ast-grep/y.yml", serverId: "ast-grep" },
		]);
	});

	it("a live child WITH matching identity is killed even when matchProcess is provided", () => {
		const reg = [
			instance({
				pid: 1,
				lspChildren: [child({ pid: 100, command: "ast-grep.exe" })],
			}),
		];
		const matchProcess = (_pid: number, expected: { command: string }) =>
			expected.command === "ast-grep.exe";
		const decision = decideOrphanReaping(reg, alivePids(100), matchProcess);

		expect(decision.childrenToKill).toHaveLength(1);
	});

	it("empty registry — no work at all", () => {
		const decision = decideOrphanReaping([], alivePids());
		expect(decision.deadInstances).toHaveLength(0);
		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toHaveLength(0);
	});

	it("dead parent with multiple children — mixed live/dead/marker outcomes coexist", () => {
		const reg = [
			instance({
				pid: 1,
				lspChildren: [
					child({ pid: 100, serverId: "a", command: "a.exe" }), // will be alive
					child({ pid: 200, serverId: "b", command: "b.exe" }), // dead, no marker
					child({
						pid: 300,
						serverId: "c",
						command: "c.exe",
						marker: "C:/temp/pi-lens-ast-grep/m.yml",
					}), // dead, with marker
				],
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids(100));

		expect(decision.childrenToKill).toEqual([
			{ pid: 100, serverId: "a", command: "a.exe" },
		]);
		expect(decision.markerSearches).toEqual([
			{ marker: "C:/temp/pi-lens-ast-grep/m.yml", serverId: "c" },
		]);
	});

	it("never surfaces a marker search for a marker a LIVE instance also claims (machine-wide live-kill guard)", () => {
		// The critical #472 review case: with a shared (non-unique) marker, the
		// marker fallback would command-line-match — and tree-kill — the LIVE
		// session's server. The decision must exclude live-claimed markers.
		const shared = "C:/temp/pi-lens-ast-grep/baseline.sgconfig.yml";
		const reg = [
			instance({
				pid: 1, // dead
				lspChildren: [child({ pid: 100, marker: shared })], // child also dead
			}),
			instance({
				pid: 2, // ALIVE
				lspChildren: [child({ pid: 200, marker: shared })],
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids(2, 200));

		expect(decision.deadInstances.map((i) => i.pid)).toEqual([1]);
		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toHaveLength(0); // shared marker suppressed
	});

	it("a marker unique to the dead instance IS surfaced even when live instances exist", () => {
		const reg = [
			instance({
				pid: 1, // dead
				lspChildren: [
					child({ pid: 100, marker: "C:/temp/pi-lens-ast-grep/baseline-1.sgconfig.yml" }),
				],
			}),
			instance({
				pid: 2, // ALIVE, different marker
				lspChildren: [
					child({ pid: 200, marker: "C:/temp/pi-lens-ast-grep/baseline-2.sgconfig.yml" }),
				],
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids(2, 200));

		expect(decision.markerSearches).toEqual([
			{
				marker: "C:/temp/pi-lens-ast-grep/baseline-1.sgconfig.yml",
				serverId: "ast-grep",
			},
		]);
	});
});

/**
 * #525 root-cause regression: heartbeat staleness cleans REGISTRY ENTRIES,
 * never enables kills — the asymmetry is load-bearing (see the
 * clients/instance-reaper.ts module docstring). Pins BOTH scenarios:
 * - the dogfooded pollution case (heartbeat 2026-07-10T17:00, ~13h stale by
 *   a 2026-07-11T06:35 session_start sweep, pid recycled onto an unrelated
 *   live process ⇒ entry dropped, nothing killed), and
 * - the overnight-idle case that FORBIDS kills on staleness (a pi session
 *   left open but unused fires no heartbeat — runtime-turn.ts / quiet-window
 *   are the only call sites, no timer exists — so a GENUINELY ALIVE session
 *   legitimately goes >6h stale; its warm LSP fleet must never be killed
 *   under it, and its markers must stay protected).
 */
describe("decideOrphanReaping — heartbeat staleness (#525)", () => {
	const NOW = Date.parse("2026-07-11T06:35:00.000Z");

	it("stale heartbeat + dead pid ⇒ kill-eligible deadInstances (the pre-#525 baseline stays fixed)", () => {
		const reg = [
			instance({
				pid: 1,
				heartbeatAt: "2026-07-10T17:00:00.000Z", // ~13h30m before NOW
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids(), undefined, NOW);

		expect(decision.deadInstances).toHaveLength(1);
		expect(decision.deadInstances[0].pid).toBe(1);
		expect(decision.staleInstances).toHaveLength(0); // dead wins — not double-listed
	});

	it("stale heartbeat + LIVE (recycled) pid ⇒ staleInstances (entry removal), NEVER deadInstances — the #525 pollution fix", () => {
		const reg = [
			instance({
				pid: 1,
				heartbeatAt: "2026-07-10T17:00:00.000Z", // ~13h30m before NOW
			}),
		];
		// pid 1 reports ALIVE (simulates Windows pid-recycling: the original
		// process is long dead, but the OS reassigned pid 1 to some unrelated
		// live process). Before the #525 fix this entry was never removed.
		const decision = decideOrphanReaping(reg, alivePids(1), undefined, NOW);

		expect(decision.staleInstances).toHaveLength(1);
		expect(decision.staleInstances[0].pid).toBe(1);
		expect(decision.deadInstances).toHaveLength(0); // record cleanup, not a kill
		expect(decision.childrenToKill).toHaveLength(0);
	});

	it("OVERNIGHT-IDLE scenario: pid ALIVE + heartbeat 8h stale ⇒ entry removed, ZERO kills, children still marker-protected", () => {
		const idleMarker = "C:/temp/pi-lens-ast-grep/baseline-1.sgconfig.yml";
		const reg = [
			// The overnight-idle-but-genuinely-alive session with a live LSP child.
			instance({
				pid: 1,
				heartbeatAt: new Date(NOW - 8 * 60 * 60 * 1000).toISOString(), // 8h stale
				lspChildren: [
					child({ pid: 100, serverId: "ast-grep", marker: idleMarker }),
				],
			}),
			// A DEAD instance whose dead child carries the SAME marker — without
			// pid-liveness-only marker protection, this dead instance's marker
			// search would kill the idle session's live server by command-line
			// match. (Markers are per-process-unique in production; this is the
			// defense-in-depth case the protection loop exists for.)
			instance({
				pid: 2,
				heartbeatAt: new Date(NOW - 8 * 60 * 60 * 1000).toISOString(),
				lspChildren: [
					child({ pid: 200, serverId: "ast-grep", marker: idleMarker }),
				],
			}),
		];
		// pids 1 and 100 alive (the idle session + its LSP child); 2 and 200 dead.
		// matchProcess would verify child 100's identity as GENUINE — that must
		// not matter, because the kill path must never be reached on staleness.
		const matchProcess = () => true;
		const decision = decideOrphanReaping(reg, alivePids(1, 100), matchProcess, NOW);

		// Idle-but-alive instance: entry removed (record cleanup) but NO kills.
		expect(decision.staleInstances.map((i) => i.pid)).toEqual([1]);
		expect(decision.childrenToKill).toHaveLength(0);
		// Dead instance 2 is kill-eligible, but its dead child's marker is
		// claimed by the pid-ALIVE instance 1 — protection held despite the
		// stale heartbeat, so no marker search targets the live server.
		expect(decision.deadInstances.map((i) => i.pid)).toEqual([2]);
		expect(decision.markerSearches).toHaveLength(0);
	});

	it("fresh heartbeat + live pid ⇒ untouched (neither dead nor stale)", () => {
		const reg = [
			instance({
				pid: 1,
				heartbeatAt: new Date(NOW - 5 * 60 * 1000).toISOString(), // 5 min ago
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids(1), undefined, NOW);

		expect(decision.deadInstances).toHaveLength(0);
		expect(decision.staleInstances).toHaveLength(0);
	});

	it("heartbeat exactly at the staleness boundary is NOT yet stale (strictly greater-than)", () => {
		const reg = [
			instance({
				pid: 1,
				heartbeatAt: new Date(NOW - STALE_HEARTBEAT_MS).toISOString(),
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids(1), undefined, NOW);

		expect(decision.deadInstances).toHaveLength(0);
		expect(decision.staleInstances).toHaveLength(0);
	});

	it("heartbeat one ms past the staleness boundary IS stale (entry removal only)", () => {
		const reg = [
			instance({
				pid: 1,
				heartbeatAt: new Date(NOW - STALE_HEARTBEAT_MS - 1).toISOString(),
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids(1), undefined, NOW);

		expect(decision.staleInstances).toHaveLength(1);
		expect(decision.deadInstances).toHaveLength(0);
	});

	it("unparseable heartbeatAt on a live pid is treated as stale (entry removal only, no kills)", () => {
		const reg = [
			instance({
				pid: 1,
				heartbeatAt: "not-a-date",
				lspChildren: [child({ pid: 100 })],
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids(1, 100), () => true, NOW);

		expect(decision.staleInstances).toHaveLength(1);
		expect(decision.deadInstances).toHaveLength(0);
		expect(decision.childrenToKill).toHaveLength(0);
	});
});

/**
 * #658: registry-INDEPENDENT backstop sweep. Fake OS-process rows + fake
 * registry snapshot, no real process enumeration/kills — mirrors the
 * pure/impure split `decideOrphanReaping` already established.
 */
function osProc(overrides: Partial<OsProcessInfo> = {}): OsProcessInfo {
	return {
		pid: 5000,
		parentPid: 4000,
		command: "C:\\tools\\opengrep.exe --lsp",
		...overrides,
	};
}

describe("decideBackstopOrphanReaping", () => {
	it("untracked process + confirmed-dead parent ⇒ kill-eligible", () => {
		const proc = osProc({ pid: 5000, parentPid: 4000 });
		const decision = decideBackstopOrphanReaping([proc], [], alivePids()); // parent 4000 dead

		expect(decision).toEqual([proc]);
	});

	it("untracked process + LIVE parent ⇒ never kill-eligible, however unfamiliar the binary", () => {
		const proc = osProc({ pid: 5000, parentPid: 4000 });
		const decision = decideBackstopOrphanReaping([proc], [], alivePids(4000));

		expect(decision).toHaveLength(0);
	});

	it("process already tracked in the registry (any instance's lspChildren) ⇒ deferred to the registry-driven reaper, never backstop-killed — even with a dead parent", () => {
		const proc = osProc({ pid: 5000, parentPid: 4000 });
		const reg = [instance({ pid: 1, lspChildren: [child({ pid: 5000 })] })];
		const decision = decideBackstopOrphanReaping([proc], reg, alivePids()); // parent dead too

		expect(decision).toHaveLength(0);
	});

	it("unverifiable parent pid (0, negative, NaN) ⇒ never kill-eligible — ambiguity is conservative, not confirmed-dead", () => {
		const zero = osProc({ pid: 5001, parentPid: 0 });
		const negative = osProc({ pid: 5002, parentPid: -1 });
		const nan = osProc({ pid: 5003, parentPid: Number.NaN });
		const decision = decideBackstopOrphanReaping(
			[zero, negative, nan],
			[],
			alivePids(),
		);

		expect(decision).toHaveLength(0);
	});

	it("self-parenting malformed row (parentPid === pid) ⇒ never kill-eligible", () => {
		const proc = osProc({ pid: 5000, parentPid: 5000 });
		const decision = decideBackstopOrphanReaping([proc], [], alivePids());

		expect(decision).toHaveLength(0);
	});

	it("multiple untracked candidates with mixed parent liveness — only the dead-parent one is selected", () => {
		const orphan = osProc({ pid: 5000, parentPid: 4000, command: "opengrep.exe" });
		const legit = osProc({ pid: 6000, parentPid: 7000, command: "opengrep-core.exe" });
		const decision = decideBackstopOrphanReaping(
			[orphan, legit],
			[],
			alivePids(7000), // 7000 alive, 4000 dead
		);

		expect(decision).toEqual([orphan]);
	});

	it("empty process list ⇒ no work", () => {
		expect(decideBackstopOrphanReaping([], [], alivePids())).toHaveLength(0);
	});
});

describe("buildIdentityMatcher", () => {
	const expected = {
		command: "C:\\tools\\ast-grep.exe",
		marker: "C:/temp/pi-lens-ast-grep/baseline-42.sgconfig.yml",
	};

	it("pid absent from the command-line map ⇒ false (unverifiable — never kill by pid)", () => {
		const match = buildIdentityMatcher(new Map());
		expect(match(100, expected)).toBe(false);
	});

	it("marker present in the command line ⇒ match", () => {
		const match = buildIdentityMatcher(
			new Map([
				[
					100,
					"node wrapper.js lsp --config C:/temp/pi-lens-ast-grep/baseline-42.sgconfig.yml",
				],
			]),
		);
		expect(match(100, expected)).toBe(true);
	});

	it("command basename matches case-insensitively when no marker matches", () => {
		// Separator-free command so path.basename behaves identically on every
		// CI platform (win32 backslash paths don't split under POSIX basename).
		const match = buildIdentityMatcher(
			new Map([[100, '"C:\\Other\\Path\\AST-GREP.EXE" lsp']]),
		);
		expect(match(100, { command: "ast-grep.exe" })).toBe(true);
	});

	it("neither marker nor basename in the command line ⇒ false (recycled pid)", () => {
		const match = buildIdentityMatcher(
			new Map([[100, "C:\\Windows\\System32\\notepad.exe unrelated.txt"]]),
		);
		expect(match(100, expected)).toBe(false);
	});

	it("empty command basename never matches (guard against includes(''))", () => {
		const match = buildIdentityMatcher(new Map([[100, "anything at all"]]));
		expect(match(100, { command: "" })).toBe(false);
	});
});
