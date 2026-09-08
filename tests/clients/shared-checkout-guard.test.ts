/**
 * Shared-checkout WIP guard (#2007).
 *
 * The incident: several agent sessions shared one checkout, one ran
 * `git checkout <branch>`, and three files of another session's uncommitted
 * work vanished unrecoverably.
 *
 * Every guard the fix adds is pinned INDEPENDENTLY, with the mutation that
 * reds it named in a comment. The four are: the command classification, the
 * live-peer requirement, the dirty-tree requirement, and the unknown-is-not-
 * clean rule. A compensating pair would let one deletion pass unnoticed
 * (#1733's lesson), so no test stands in for another.
 *
 * `probeWorkingTreeState` is exercised against the REAL `git` binary in a
 * real temp repo (catalog shape 16): a hand-written porcelain fixture would
 * only pin our guess about git's output.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const latencyCalls: Array<Record<string, unknown>> = [];
vi.mock("../../clients/latency-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Record<string, unknown>) => {
			latencyCalls.push(entry);
		},
	};
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	collectGitInvocations,
	isGitCommitOrPushAttempt,
	resolveGitTargetDirectory,
} from "../../clients/git-guard.js";
import type { InstanceEntry } from "../../clients/instance-registry.js";
import { selectLivePeerInstances } from "../../clients/instance-registry.js";
import {
	evaluateSharedCheckoutGuard,
	isWorktreeMutatingGitAttempt,
	probeWorkingTreeState,
	type SharedCheckoutGuardDeps,
	type WorkingTreeState,
} from "../../clients/shared-checkout-guard.js";
import { resolveGitToplevel } from "../../clients/opaque-mutation-scan.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { gitFixtureSpawnAsync } from "../support/git-fixture-env.js";

const ROOT = path.resolve("/shared/checkout");

function bash(command: string): { command: string } {
	return { command };
}

function phaseCalls(phase: string): Array<Record<string, unknown>> {
	return latencyCalls.filter((entry) => entry.phase === phase);
}

function summaryFor(kind: string) {
	return getDegradationSummary().find((group) => group.kind === kind);
}

function peer(overrides: Partial<InstanceEntry> = {}): InstanceEntry {
	return {
		pid: process.pid + 1,
		startedAt: new Date(1_000).toISOString(),
		projectRoot: normalizeFilePath(ROOT),
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: new Date(2_000).toISOString(),
		...overrides,
	};
}

/** All seams stubbed: a live peer, a real repo, and a dirty tree. */
function deps(
	overrides: Partial<SharedCheckoutGuardDeps> = {},
	probeSpy?: { calls: number },
): SharedCheckoutGuardDeps {
	return {
		readRegistry: async () => [peer()],
		isPidAlive: () => true,
		now: 3_000,
		resolveToplevel: async () => ROOT,
		probeWorkingTree: async (): Promise<WorkingTreeState> => {
			if (probeSpy) probeSpy.calls += 1;
			return "dirty";
		},
		...overrides,
	};
}

describe("worktree-mutating git classification (#2007)", () => {
	it("recognizes every verb that rewrites tracked files", () => {
		for (const command of [
			"git checkout main",
			"git checkout -b feature",
			"git checkout -- clients/dispatcher.ts",
			"git switch master",
			"git restore .",
			"git reset --hard HEAD",
			"git reset --merge",
			"git reset --keep origin/master",
			"git stash",
			"git stash push -m wip",
			"git stash pop",
			"git clean -fd",
			"git merge origin/master",
			"git rebase master",
			"git pull",
			"git cherry-pick abc123",
			"git revert abc123",
		]) {
			expect(isWorktreeMutatingGitAttempt("bash", bash(command)), command).toBe(
				true,
			);
		}
	});

	it("leaves read-only and index-only git alone", () => {
		for (const command of [
			"git status",
			"git log --oneline",
			"git diff",
			"git add .",
			"git commit -m x",
			"git push origin master",
			// Soft/mixed reset moves HEAD and the index, never the worktree.
			"git reset HEAD~1",
			"git reset --soft HEAD~1",
			"git stash list",
			"git stash show",
			"git clean -n",
			"git clean --dry-run",
			"git --help checkout",
			'echo "git checkout main"',
			"npm run build",
		]) {
			expect(isWorktreeMutatingGitAttempt("bash", bash(command)), command).toBe(
				false,
			);
		}
	});

	it("never classifies `git init` as worktree-mutating (#2345)", () => {
		// `init` was never a member of ALWAYS_MUTATING_VERBS and has no special
		// case below it, unlike `reset`/`stash`/`clean` — matchesVerb's final
		// `return false` is what actually answers this, so the gap was real: no
		// test named `init` by itself, positive or negative. #2345 reported the
		// guard rejecting `git init -q` for a temp Git fixture; it does not,
		// because `init` never reaches the verb's mutating branches — it creates
		// or refreshes `.git` metadata and never rewrites a tracked file, so it
		// does not belong to the class this guard exists to stop (see the
		// module docstring's THE HAZARD). This is the invariant that makes every
		// `git init`-based fixture safe everywhere, with no directory carve-out
		// needed. MUTATION PROOF: add `"init"` to `ALWAYS_MUTATING_VERBS` and
		// every case here reds.
		for (const command of [
			"git init",
			"git init -q",
			"git init --bare",
			"git init -b main",
			"git init /tmp/some/fixture",
		]) {
			expect(isWorktreeMutatingGitAttempt("bash", bash(command)), command).toBe(
				false,
			);
		}
	});

	it("inherits the #1063 wrapper and substitution analysis instead of re-parsing", () => {
		// MUTATION PROOF for the reuse decision: a hand-rolled `startsWith("git ")`
		// classifier passes the plain cases above and reds on every line here.
		for (const command of [
			"sh -c 'git checkout main'",
			'bash -lc "git switch master"',
			"cmd /c git reset --hard",
			"pwsh -Command git clean -fd",
			"echo $(git checkout main)",
			"git${IFS}checkout${IFS}main",
			"GIT_DIR=.git git checkout main",
			"git -C /elsewhere checkout main",
		]) {
			expect(isWorktreeMutatingGitAttempt("bash", bash(command)), command).toBe(
				true,
			);
		}
	});

	it("narrows the indirect-git fail-closed rule to governed verbs only", () => {
		// The commit gate is a policy an agent may evade, so ANY indirect git
		// fails closed there. This guard protects the agent from an accident,
		// so a read-only indirect git must stay usable.
		expect(isGitCommitOrPushAttempt("bash", bash("xargs git status"))).toBe(
			true,
		);
		expect(isWorktreeMutatingGitAttempt("bash", bash("xargs git status"))).toBe(
			false,
		);
		// MUTATION PROOF: make `indirectAlwaysMatches` irrelevant by returning
		// false for every indirect git and this line reds.
		expect(
			isWorktreeMutatingGitAttempt("bash", bash("xargs git checkout main")),
		).toBe(true);
	});

	it("reads the verb from git's COMMAND POSITION, not from any token", () => {
		// F5: scanning every token after `git` fires on a positional value that
		// happens to spell a subcommand. `checkout` here is a -name argument.
		for (const command of [
			"find . -name checkout | xargs git add",
			"git log --format=checkout",
			"git config alias.co checkout",
			"git add restore.ts",
			"xargs git add -- clean",
		]) {
			expect(isWorktreeMutatingGitAttempt("bash", bash(command)), command).toBe(
				false,
			);
		}
	});

	it("treats a post-verb --help as documentation, not a mutation", () => {
		// F4: the global-option walk cannot see `--help` after the verb, so
		// `git checkout --help` classified as a branch switch.
		for (const command of [
			"git checkout --help",
			"git stash -h",
			"git clean --help",
		]) {
			expect(isWorktreeMutatingGitAttempt("bash", bash(command)), command).toBe(
				false,
			);
		}
	});

	it("suppresses help only in the LEADING post-verb position", () => {
		// #2107 verify, L1: the suppression reads argsAfterVerb[0] only.
		// Widening it to .some() would wrongly suppress both of these, which
		// really mutate: `-h` here is the value of `-e` (an exclude pattern),
		// and `-- --help` checks out a path literally named `--help`.
		for (const command of ["git clean -e -h -fd", "git checkout -- --help"]) {
			expect(isWorktreeMutatingGitAttempt("bash", bash(command)), command).toBe(
				true,
			);
		}
	});

	it("reads a clustered -n as `git clean` dry-run", () => {
		// F4: short flags cluster. An exact-token set read `-nfd` as mutating.
		for (const command of [
			"git clean -nfd",
			"git clean -ndx",
			"git clean -n -f",
		]) {
			expect(isWorktreeMutatingGitAttempt("bash", bash(command)), command).toBe(
				false,
			);
		}
		expect(isWorktreeMutatingGitAttempt("bash", bash("git clean -fdx"))).toBe(
			true,
		);
	});

	it("only classifies bash tool input", () => {
		expect(
			isWorktreeMutatingGitAttempt("write", bash("git checkout main")),
		).toBe(false);
		expect(isWorktreeMutatingGitAttempt("bash", {})).toBe(false);
	});

	it("keeps the commit/push gate's own answers unchanged after the refactor", () => {
		expect(isGitCommitOrPushAttempt("bash", bash('git commit -m "x"'))).toBe(
			true,
		);
		expect(isGitCommitOrPushAttempt("bash", bash("git push origin main"))).toBe(
			true,
		);
		expect(isGitCommitOrPushAttempt("bash", bash("git checkout main"))).toBe(
			false,
		);
		expect(isGitCommitOrPushAttempt("bash", bash('echo "git push"'))).toBe(
			false,
		);
	});
});

describe("git target-directory resolution (#2007)", () => {
	function targetOf(command: string, cwd: string): string {
		const [gitTokens] = collectGitInvocations("bash", bash(command));
		return resolveGitTargetDirectory(gitTokens ?? [], cwd);
	}

	it("composes cumulative -C the way git does, and lets --work-tree win", () => {
		const cwd = path.resolve("/cwd");
		expect(targetOf("git checkout main", cwd)).toBe(cwd);
		expect(targetOf("git -C sub checkout main", cwd)).toBe(
			path.resolve(cwd, "sub"),
		);
		expect(targetOf("git -C /a -C b checkout main", cwd)).toBe(
			path.resolve("/a/b"),
		);
		expect(targetOf("git -Csub checkout main", cwd)).toBe(
			path.resolve(cwd, "sub"),
		);
		expect(targetOf("git -C /a --work-tree=/w checkout main", cwd)).toBe(
			path.resolve("/w"),
		);
		expect(targetOf("git --work-tree /w checkout main", cwd)).toBe(
			path.resolve("/w"),
		);
		// `-c key=value` is config, not a directory, and must not be consumed
		// as one.
		expect(targetOf("git -c core.autocrlf=false checkout main", cwd)).toBe(cwd);
	});
});

describe("live-peer selection (#2007)", () => {
	it("counts only another pid, alive, on this root, with a fresh heartbeat", () => {
		const entries = [
			peer(),
			peer({ pid: process.pid }), // this process is not its own peer
			peer({ pid: process.pid + 2, projectRoot: normalizeFilePath("/other") }),
			peer({ pid: process.pid + 3, heartbeatAt: "not-a-date" }),
		];
		const live = selectLivePeerInstances(entries, ROOT, 3_000, () => true);
		expect(live.map((entry) => entry.pid)).toEqual([process.pid + 1]);
	});

	it("matches a peer at the repo root from a subdirectory, in both directions", () => {
		// F3: an exact compare reported no peer whenever the agent ran the
		// command from a subdirectory of the shared checkout, which allowed the
		// exact destructive command this guard exists to decline.
		const sub = `${ROOT}/clients`;
		expect(
			selectLivePeerInstances([peer()], sub, 3_000, () => true, "containment"),
		).toHaveLength(1);
		expect(
			selectLivePeerInstances(
				[peer({ projectRoot: normalizeFilePath(sub) })],
				ROOT,
				3_000,
				() => true,
				"containment",
			),
		).toHaveLength(1);
		// Segment boundaries: a sibling directory sharing a name PREFIX is not
		// the same checkout.
		expect(
			selectLivePeerInstances(
				[peer({ projectRoot: normalizeFilePath(`${ROOT}-backup`) })],
				ROOT,
				3_000,
				() => true,
				"containment",
			),
		).toHaveLength(0);
		// Warm attach keeps the exact rule, because it shares one LSP service.
		expect(
			selectLivePeerInstances([peer()], sub, 3_000, () => true),
		).toHaveLength(0);
	});

	it("drops a dead pid and a stale heartbeat", () => {
		expect(
			selectLivePeerInstances([peer()], ROOT, 3_000, () => false),
		).toHaveLength(0);
		expect(
			selectLivePeerInstances(
				[peer()],
				ROOT,
				Date.parse("2100-01-01T00:00:00Z"),
				() => true,
			),
		).toHaveLength(0);
	});
});

describe("evaluateSharedCheckoutGuard (#2007)", () => {
	beforeEach(() => {
		latencyCalls.length = 0;
		resetDegradationLedger();
	});

	it("declines a branch switch when a live peer shares this dirty checkout", async () => {
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			ROOT,
			deps(),
		);
		// MUTATION PROOF: return `{ block: false }` from the dirty branch and
		// this is the only test that reds — the incident ships again.
		expect(decision.block).toBe(true);
		expect(decision.unknown).toBeUndefined();
		expect(decision.reason).toContain(`pid ${process.pid + 1}`);
		expect(decision.reason).toContain("uncommitted changes");
	});

	it("evaluates the directory `-C` retargets at, not the caller's cwd", async () => {
		// F2: `git -C <shared> checkout main` run from a private worktree
		// destroys the SHARED tree. Evaluating cwd found no peer and allowed it.
		const probed: string[] = [];
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash(`git -C ${ROOT} checkout main`),
			"/private/worktree",
			deps({
				probeWorkingTree: async (root) => {
					probed.push(root);
					return "dirty";
				},
			}),
		);
		expect(decision.block).toBe(true);
		// MUTATION PROOF: pass `cwd` to `evaluateOneTarget` instead of the
		// resolved target and this reds — the probe would name /private/worktree
		// and the peer on ROOT would never be found.
		expect(probed).toEqual([path.resolve(ROOT)]);
	});

	it("declines from a SUBDIRECTORY of the shared checkout, end to end", async () => {
		// R2: round 2 proved containment only by calling
		// `selectLivePeerInstances` directly, so swapping the call site back to
		// "exact" left every test green. This drives the real evaluator.
		const sub = path.join(ROOT, "clients");
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			sub,
			deps({
				// Both the subdirectory and the peer's root belong to one tree.
				resolveToplevel: async () => ROOT,
			}),
		);
		// MUTATION PROOF: change the call site's "containment" back to "exact"
		// and this reds — a command run from any subdirectory would be allowed.
		expect(decision.block).toBe(true);
		expect(decision.reason).toContain(`pid ${process.pid + 1}`);
	});

	it("finds a peer REGISTERED on a subdirectory of the shared checkout", async () => {
		// R2, second direction. The first subdirectory test moves the CWD, which
		// the toplevel lookup alone already handles — so it does not prove the
		// call site's "containment" argument. This one moves the PEER: pi-lens
		// registers a session at whatever project root it opened, which can be
		// a package inside the repo. Only containment admits that candidate.
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			ROOT,
			deps({
				readRegistry: async () => [
					peer({ projectRoot: normalizeFilePath(path.join(ROOT, "clients")) }),
				],
				resolveToplevel: async () => ROOT,
			}),
		);
		// MUTATION PROOF: swap the call site's "containment" for "exact" and
		// this reds — a peer registered one directory down is invisible.
		expect(decision.block).toBe(true);
	});

	it("allows inside a NESTED worktree, which shares no files with its parent", async () => {
		// R3: a linked worktree lives at a path under the main checkout but is
		// a separate working tree. Lexical containment declined it, and the
		// refusal told the operator to go use a dedicated worktree — which is
		// exactly where they already were.
		const nested = path.join(ROOT, ".claude", "worktrees", "agent-x");
		const probed: string[] = [];
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			nested,
			deps({
				// The peer's root resolves to the MAIN tree, the cwd to its own.
				resolveToplevel: async (root) =>
					normalizeFilePath(root) === normalizeFilePath(nested) ? nested : ROOT,
				probeWorkingTree: async (root) => {
					probed.push(root);
					return "dirty";
				},
			}),
		);
		// MUTATION PROOF: drop the toplevel comparison and keep containment
		// alone, and this reds — every agent worktree under `.claude/` would be
		// declined on the main checkout's peers.
		expect(decision.block).toBe(false);
		// It never even reaches the working-tree probe: there is no peer.
		expect(probed).toEqual([]);
		expect(
			phaseCalls("shared_checkout_guard_allow")[0]?.metadata,
		).toMatchObject({ reasonCategory: "no_peer_session" });
	});

	describe("multi-root peers (#2130)", () => {
		// A host serving two roots: its PRIMARY is an unrelated repo, its SECOND
		// root is inside the shared checkout. This is the plegma host shape from
		// #2130 — the real root plus a subagent worktree.
		const OTHER = path.resolve("/unrelated/repo");

		function multiRootPeer(): InstanceEntry {
			return peer({
				projectRoot: normalizeFilePath(OTHER),
				projectRoots: [normalizeFilePath(OTHER), normalizeFilePath(ROOT)],
			});
		}

		/** Each directory resolves to the working tree that actually contains it. */
		const resolveToplevel = async (dir: string) =>
			normalizeFilePath(dir).startsWith(normalizeFilePath(OTHER))
				? OTHER
				: ROOT;

		it("blocks on a peer admitted by its SECOND root", async () => {
			// MUTATION PROOF: resolve only `candidate.projectRoot` (the index-0
			// root) instead of every root, and this reds — the peer is dropped at
			// stage 2, the guard reports no peer, and the destructive command is
			// ALLOWED against a checkout somebody else has uncommitted work in.
			const decision = await evaluateSharedCheckoutGuard(
				"bash",
				bash("git checkout main"),
				ROOT,
				deps({
					readRegistry: async () => [multiRootPeer()],
					resolveToplevel,
				}),
			);
			expect(decision.block).toBe(true);
			expect(decision.reason).toContain("shared with");
		});

		it("control: the same peer on its PRIMARY root blocks too", async () => {
			// Pins that the test above is not passing for an unrelated reason —
			// the only difference between the two is WHICH root matches.
			const decision = await evaluateSharedCheckoutGuard(
				"bash",
				bash("git checkout main"),
				ROOT,
				deps({
					readRegistry: async () => [
						peer({
							projectRoot: normalizeFilePath(ROOT),
							projectRoots: [normalizeFilePath(ROOT), normalizeFilePath(OTHER)],
						}),
					],
					resolveToplevel,
				}),
			);
			expect(decision.block).toBe(true);
		});

		it("a peer whose roots are ALL elsewhere still allows", async () => {
			// The widening must not become "any live peer blocks anything".
			const decision = await evaluateSharedCheckoutGuard(
				"bash",
				bash("git checkout main"),
				ROOT,
				deps({
					readRegistry: async () => [
						peer({
							projectRoot: normalizeFilePath(OTHER),
							projectRoots: [
								normalizeFilePath(OTHER),
								normalizeFilePath(path.join(OTHER, "sub")),
							],
						}),
					],
					resolveToplevel,
				}),
			);
			expect(decision.block).toBe(false);
			expect(
				phaseCalls("shared_checkout_guard_allow")[0]?.metadata,
			).toMatchObject({ reasonCategory: "no_peer_session" });
		});

		it("counts a peer once even when SEVERAL of its roots match", async () => {
			// MUTATION PROOF: drop the `break` after the first matching root and
			// this reds — the same session is pushed once per matching root, so
			// the refusal claims "2 other live pi-lens sessions" when there is
			// one, and `peerCount` in the telemetry inflates the same way.
			const decision = await evaluateSharedCheckoutGuard(
				"bash",
				bash("git checkout main"),
				ROOT,
				deps({
					readRegistry: async () => [
						peer({
							projectRoot: normalizeFilePath(ROOT),
							projectRoots: [
								normalizeFilePath(ROOT),
								normalizeFilePath(path.join(ROOT, "clients")),
							],
						}),
					],
					resolveToplevel,
				}),
			);
			expect(decision.block).toBe(true);
			expect(decision.reason).toContain("1 other live pi-lens session");
			expect(
				phaseCalls("shared_checkout_switch_blocked")[0]?.metadata,
			).toMatchObject({ peerCount: 1 });
		});

		it("resolves each distinct root at most once", async () => {
			// The per-root loop must not turn one `git rev-parse` into N on a
			// path that already spawns one for the target.
			const resolved: string[] = [];
			await evaluateSharedCheckoutGuard(
				"bash",
				bash("git checkout main"),
				ROOT,
				deps({
					readRegistry: async () => [multiRootPeer(), multiRootPeer()],
					resolveToplevel: async (dir) => {
						resolved.push(normalizeFilePath(dir));
						return resolveToplevel(dir);
					},
				}),
			);
			// One for the target, then OTHER and ROOT once each across BOTH peers.
			// Without the memo this is five calls (1 + 2 + 2).
			expect(resolved).toEqual([
				normalizeFilePath(ROOT),
				normalizeFilePath(OTHER),
				normalizeFilePath(ROOT),
			]);
		});
	});

	it("allows when the target is not inside any working tree", async () => {
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			ROOT,
			deps({ resolveToplevel: async () => undefined }),
		);
		expect(decision.block).toBe(false);
		expect(
			phaseCalls("shared_checkout_guard_allow")[0]?.metadata,
		).toMatchObject({ reasonCategory: "not_a_git_worktree" });
	});

	it("allows the same command when no other session is here", async () => {
		const probeSpy = { calls: 0 };
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			ROOT,
			deps({ readRegistry: async () => [] }, probeSpy),
		);
		// MUTATION PROOF: delete the peer check and this reds — every solo
		// session's branch switch would be declined.
		expect(decision.block).toBe(false);
		// The probe is the expensive part; a peerless checkout must not pay it.
		expect(probeSpy.calls).toBe(0);
		expect(
			phaseCalls("shared_checkout_guard_allow")[0]?.metadata,
		).toMatchObject({ reasonCategory: "no_peer_session" });
	});

	it("allows the same command when the shared checkout is clean", async () => {
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			ROOT,
			deps({ probeWorkingTree: async () => "clean" }),
		);
		// MUTATION PROOF: drop the `clean` branch and every shared checkout
		// becomes unswitchable, which would get the flag turned off.
		expect(decision.block).toBe(false);
		expect(
			phaseCalls("shared_checkout_guard_allow")[0]?.metadata,
		).toMatchObject({ reasonCategory: "working_tree_clean" });
	});

	it("declines on an UNKNOWN probe rather than assuming clean", async () => {
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git reset --hard"),
			ROOT,
			deps({ probeWorkingTree: async () => "unknown" }),
		);
		// MUTATION PROOF (catalog shape 10): collapse `unknown` into `clean`
		// and this reds while every other test stays green.
		expect(decision.block).toBe(true);
		expect(decision.unknown).toBe(true);
		expect(decision.reason).toContain("could not report");
		expect(summaryFor("shared-checkout-probe")?.count).toBe(1);
		expect(phaseCalls("shared_checkout_probe_failed")).toHaveLength(1);
	});

	it("never touches the registry for a command that cannot rewrite the tree", async () => {
		let registryReads = 0;
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git status"),
			ROOT,
			deps({
				readRegistry: async () => {
					registryReads += 1;
					return [peer()];
				},
			}),
		);
		expect(decision.block).toBe(false);
		// MUTATION PROOF for the cost story: move the classification below the
		// registry read and this reds. Every bash command would pay file I/O.
		expect(registryReads).toBe(0);
		expect(latencyCalls).toHaveLength(0);
	});

	it("allows when the registry itself cannot be read", async () => {
		const decision = await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			ROOT,
			deps({
				readRegistry: async () => {
					throw new Error("registry unreadable");
				},
			}),
		);
		// A registry outage must not start refusing branch switches machine-wide.
		expect(decision.block).toBe(false);
		expect(
			phaseCalls("shared_checkout_guard_allow")[0]?.metadata,
		).toMatchObject({ reasonCategory: "registry_unreadable" });
	});

	it("counts every repeat while logging one detailed record per checkout", async () => {
		for (let i = 0; i < 4; i++) {
			await evaluateSharedCheckoutGuard(
				"bash",
				bash("git switch other"),
				ROOT,
				deps(),
			);
		}
		expect(phaseCalls("shared_checkout_switch_blocked")).toHaveLength(1);
		// The ledger keeps the exact total, and its subject says WHICH checkout
		// is contended — aggregation that lost that identity would be the
		// failure AGENTS.md names.
		expect(summaryFor("shared-checkout-wip")?.count).toBe(4);
		expect(
			summaryFor("shared-checkout-wip")?.latestReasons.at(-1)?.subject,
		).toBe(normalizeFilePath(ROOT));
	});

	it("re-arms at the session boundary rather than latching for the process", async () => {
		await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			ROOT,
			deps(),
		);
		expect(phaseCalls("shared_checkout_switch_blocked")).toHaveLength(1);
		// MUTATION PROOF (catalog shape 17): replace the ledger's rising edge
		// with a module-level `Set` and this stays at 1 after the reset.
		resetDegradationLedger();
		await evaluateSharedCheckoutGuard(
			"bash",
			bash("git checkout main"),
			ROOT,
			deps(),
		);
		expect(phaseCalls("shared_checkout_switch_blocked")).toHaveLength(2);
	});
});

describe("probeWorkingTreeState against the real git binary (#2007)", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2007-"));

	afterAll(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("gives a nested linked worktree its OWN toplevel (R3's premise)", async () => {
		// The whole R3 fix rests on a claim about git: that a worktree created
		// UNDER the main checkout reports itself, not the parent. Verified
		// against the real binary rather than assumed (catalog shape 16) — this
		// mirrors how this repo stores agent worktrees under `.claude/`.
		const main = path.join(tmpRoot, "main-repo");
		fs.mkdirSync(main, { recursive: true });
		const run = async (args: string[], cwd: string) =>
			gitFixtureSpawnAsync(cwd, args, { cwd, timeout: 20000 });
		const init = await run(["init", "-q", "-b", "master"], main);
		if (init.error || init.status !== 0) {
			throw new Error(`git init unavailable: ${init.error ?? init.status}`);
		}
		await run(["config", "user.email", "t@t.t"], main);
		await run(["config", "user.name", "t"], main);
		fs.writeFileSync(path.join(main, "base.txt"), "base\n");
		await run(["add", "-A"], main);
		await run(["commit", "-qm", "init"], main);

		const nested = path.join(main, ".claude", "worktrees", "agent-x");
		const added = await run(
			["worktree", "add", "-q", "-b", "agent-x", nested],
			main,
		);
		if (added.error || added.status !== 0) {
			throw new Error(
				`git worktree add failed: ${added.error ?? added.status}`,
			);
		}

		const mainTop = await resolveGitToplevel(main);
		const nestedTop = await resolveGitToplevel(nested);
		expect(mainTop).toBeDefined();
		expect(nestedTop).toBeDefined();
		// The nested tree is lexically INSIDE the main one and is still a
		// different working tree. Containment alone cannot tell them apart.
		expect(
			normalizeFilePath(nestedTop!).startsWith(normalizeFilePath(mainTop!)),
		).toBe(true);
		expect(normalizeFilePath(nestedTop!)).not.toBe(normalizeFilePath(mainTop!));

		// A plain subdirectory of the main tree DOES resolve back to it.
		const plainSub = path.join(main, "sub");
		fs.mkdirSync(plainSub, { recursive: true });
		expect(normalizeFilePath((await resolveGitToplevel(plainSub))!)).toBe(
			normalizeFilePath(mainTop!),
		);
	});

	it("reports clean, then dirty, then unknown outside a repo", async () => {
		const repo = path.join(tmpRoot, "repo");
		fs.mkdirSync(repo, { recursive: true });
		const init = await gitFixtureSpawnAsync(repo, ["init", "-q"], {
			cwd: repo,
			timeout: 20000,
		});
		if (init.error || init.status !== 0) {
			throw new Error(`git init unavailable: ${init.error ?? init.status}`);
		}
		expect(await probeWorkingTreeState(repo)).toBe("clean");

		fs.writeFileSync(path.join(repo, "wip.ts"), "export const a = 1;\n");
		// An UNTRACKED file is work too — this is exactly what the incident lost.
		expect(await probeWorkingTreeState(repo)).toBe("dirty");

		const outside = path.join(tmpRoot, "not-a-repo");
		fs.mkdirSync(outside, { recursive: true });
		// git exits non-zero outside a repo. That is UNKNOWN, not clean.
		expect(await probeWorkingTreeState(outside)).toBe("unknown");
	});

	// #2100 F3: the probe carried no `maxOutputBytes`, so `outputTruncated` could
	// never fire, and the failure check ahead of it downgraded a DEFINITE dirty
	// to `unknown` the moment a cap kill landed — `error` + null status on POSIX,
	// status 1 on Windows. This shims a chatty `git` on PATH that floods stdout
	// past the 16 MiB cap and then hangs, so the ONLY way it ends is the cap kill
	// (post-fix) or the probe's own 5 s timeout (pre-fix). A real spawn, not a
	// mock. Pre-fix: no cap, the flood is held whole and the hang trips the probe
	// timeout, so the probe answers `unknown`. Post-fix: the cap kills the child,
	// `truncatedByOutputCap` is read first, and 16 MiB of porcelain is dirt.
	// Removing the cap OR restoring the old order reds this test.
	it("calls a cap-flooded working tree dirty, not unknown", async () => {
		const shimDir = path.join(tmpRoot, "chatty-git-shim");
		fs.mkdirSync(shimDir, { recursive: true });
		const chatty = path.join(shimDir, "chatty.js");
		// One ~20 MiB write (past the 16 MiB cap) then a keep-alive, so the child
		// never exits on its own — the cap kill or the timeout ends it.
		fs.writeFileSync(
			chatty,
			[
				'const line = "?? " + "a".repeat(200) + String.fromCharCode(10);',
				"process.stdout.write(line.repeat(100000));",
				"setTimeout(() => {}, 10000);",
				"",
			].join("\n"),
		);
		const node = process.execPath;
		if (process.platform === "win32") {
			fs.writeFileSync(
				path.join(shimDir, "git.cmd"),
				`@"${node}" "${chatty}" %*\r\n`,
			);
		} else {
			const shim = path.join(shimDir, "git");
			fs.writeFileSync(shim, `#!/bin/sh\nexec "${node}" "${chatty}"\n`);
			fs.chmodSync(shim, 0o755);
		}

		const savedPath = process.env.PATH;
		process.env.PATH = `${shimDir}${path.delimiter}${savedPath ?? ""}`;
		try {
			expect(await probeWorkingTreeState(shimDir)).toBe("dirty");
		} finally {
			process.env.PATH = savedPath;
		}
	}, 20000);
});

/**
 * #2345's reported incident: a real-Git test fixture under `os.tmpdir()`
 * (e.g. `pi-lens-opaque-git-*`) had a worktree-mutating command rejected as
 * though it were a shared checkout. This is the PRODUCTION call path, no
 * stubbed `deps` — `evaluateSharedCheckoutGuard` reads the REAL instance
 * registry (isolated to this worker's `PI_LENS_HOME`, itself a fresh
 * `os.tmpdir()` fixture per `tests/support/vitest-setup.ts`).
 *
 * The premise in #2345 — that the guard treats a temp fixture directory as
 * "shared" — does not hold structurally: `evaluateOneTarget` only declines
 * when a LIVE PEER is registered whose resolved toplevel matches the
 * target's exactly (clients/shared-checkout-guard.ts). Nothing in a test
 * process ever calls `registerInstance()` against an ephemeral
 * `fs.mkdtempSync` directory, so `selectLivePeerInstances` always returns
 * zero candidates for one and the guard allows unconditionally at
 * `no_peer_session` — regardless of the fixture's location, dirtiness, or
 * how recently it was `git init`-ed. No directory-based allowlist is needed
 * for this to be true; it already is.
 */
describe("a real ephemeral test fixture is never a shared checkout (#2345)", () => {
	it("allows a worktree-mutating command in a fresh, dirty, unregistered fixture repo", async () => {
		const fixture = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-2345-fixture-"),
		);
		try {
			const init = await gitFixtureSpawnAsync(fixture, ["init", "-q"], {
				cwd: fixture,
				timeout: 20000,
			});
			if (init.error || init.status !== 0) {
				throw new Error(`git init unavailable: ${init.error ?? init.status}`);
			}
			// Untracked content — dirty, exactly like the incident's fixtures
			// mid-setup, and the state `probeWorkingTreeState` would report as
			// "dirty" if a peer were ever found.
			fs.writeFileSync(path.join(fixture, "wip.txt"), "fixture content\n");

			// Real deps throughout: the default `readInstanceRegistry`, the
			// default `resolveGitToplevel`, the default `probeWorkingTreeState`.
			const decision = await evaluateSharedCheckoutGuard(
				"bash",
				bash("git checkout -b feature"),
				fixture,
			);
			expect(decision).toEqual({ block: false });
			// `block: false` alone doesn't say WHY: `resolveGitToplevel` failing
			// (fixture judged not-a-worktree) allows too, via `not_a_git_worktree`
			// — a different, unrelated escape hatch that would mask a REAL
			// regression in the peer-detection path this test exists to pin.
			// Assert the specific reason category the incident's fix depends on:
			// zero registered peers, not a broken toplevel probe. MUTATION PROOF:
			// stub `resolveToplevel` to always return `undefined` and this reds
			// with `not_a_git_worktree` in place of `no_peer_session`, even though
			// `decision.block` above stays `false`.
			const allow = phaseCalls("shared_checkout_guard_allow").filter(
				(entry) => entry.filePath === normalizeFilePath(fixture),
			);
			expect(
				allow.map(
					(e) => (e.metadata as { reasonCategory: string }).reasonCategory,
				),
			).toEqual(["no_peer_session"]);
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	});
});
// flake-shape: real-process-spawn — this test calls a child-process helper; its boundary remains part of the contention surface
