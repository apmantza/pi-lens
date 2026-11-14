/**
 * #2050: which checkouts one bash command's writes are recovered from.
 *
 * The population is the command's OWN text — its `cd`/`pushd` targets and its
 * recognised write operands — admitted only when the checkout belongs to the
 * session's repository (the #3871 `sameCheckoutOtherRoot` rule), capped at
 * `OPAQUE_RECOVERY_ROOT_CAP`, and every refused or over-cap root named once.
 *
 * Pure filesystem fixtures on purpose: `resolveGitCheckout` reads `.git`
 * entries and never spawns `git`, so the admission rule can be pinned on every
 * platform without a real repository. `git worktree add` writes exactly the
 * layout `initLinkedWorktree` builds (a `.git` FILE naming the private gitdir,
 * whose `commondir` names the shared one).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	OPAQUE_RECOVERY_ROOT_CAP,
	type OpaqueRecoveryRoots,
	resolveOpaqueRecoveryRoots,
} from "../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { setupTestEnvironment } from "../clients/test-utils.js";

let env: ReturnType<typeof setupTestEnvironment>;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2050-roots-");
});

afterEach(() => {
	resetDegradationLedger();
	env.cleanup();
});

/** A checkout whose `.git` is a directory, as `git init` writes it (with HEAD: #4508 skips a HEAD-less `.git`). */
function initRepo(dir: string): string {
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
	fs.writeFileSync(path.join(dir, "seed.ts"), "export const seed = 1;\n");
	return dir;
}

/**
 * A linked worktree of `repo` at `dir`: `.git` is a FILE naming the worktree's
 * private gitdir, and that gitdir's `commondir` names the shared one — the two
 * facts `resolveGitCheckout` compares.
 */
function initLinkedWorktree(dir: string, repo: string): string {
	const gitDir = path.join(repo, ".git", "worktrees", path.basename(dir));
	fs.mkdirSync(gitDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gitDir}\n`);
	return dir;
}

/**
 * A directory the resolver answers "not a checkout" for without walking past it
 * to an ancestor: a `.git` entry it cannot follow stops the walk. Needed here
 * because the shared fixture root carries its own `.git` marker, so every
 * descendant directory would otherwise resolve to that checkout.
 */
function initCheckoutless(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".git"), "not a gitdir line\n");
	return dir;
}

/** The keys of a root list, so assertions never depend on realpath spelling. */
function keys(roots: readonly string[]): string[] {
	return roots.map((root) => normalizeMapKey(path.resolve(root)));
}

function rootsOf(command: string, sessionRoot: string): OpaqueRecoveryRoots {
	return resolveOpaqueRecoveryRoots(command, sessionRoot);
}

describe("resolveOpaqueRecoveryRoots (#2050)", () => {
	it("recovers only the session root for a command that names nothing", () => {
		const repo = initRepo(path.join(env.tmpDir, "plain"));
		const scopes = rootsOf("node scripts/gen.mjs", repo);
		expect(keys(scopes.roots)).toEqual(keys([repo]));
		expect(scopes.refused).toEqual([]);
		expect(scopes.capped).toEqual([]);
	});

	it("admits a linked worktree the command cds into", () => {
		const repo = initRepo(path.join(env.tmpDir, "repo"));
		const worktree = initLinkedWorktree(path.join(env.tmpDir, "linked"), repo);
		const scopes = rootsOf(`cd ${worktree} && node - <<'EOF'\nx\nEOF`, repo);
		expect(keys(scopes.roots)).toEqual(keys([repo, worktree]));
	});

	it("admits a nested worktree the command cds into, though it sits under the session root", () => {
		const repo = initRepo(path.join(env.tmpDir, "nested-repo"));
		const nested = initLinkedWorktree(
			path.join(repo, ".claude", "worktrees", "nested"),
			repo,
		);
		const scopes = rootsOf(
			"cd .claude/worktrees/nested && python3 - <<'EOF'\nx\nEOF",
			repo,
		);
		expect(keys(scopes.roots)).toEqual(keys([repo, nested]));
	});

	it("admits a linked worktree named only by an absolute write operand", () => {
		const repo = initRepo(path.join(env.tmpDir, "operand-repo"));
		const worktree = initLinkedWorktree(
			path.join(env.tmpDir, "operand-linked"),
			repo,
		);
		const target = path.join(worktree, "generated.ts");
		const scopes = rootsOf(`printf 'x' > ${target}`, repo);
		expect(keys(scopes.roots)).toEqual(keys([repo, worktree]));
	});

	// #5552: `rsync -a src/ <linked worktree>/` and `tar x -C <worktree>` fill a
	// tree argv names only as a directory, so the root candidates take the
	// scope's own checkout, and the scopes ride the result to the recovery.
	it("admits a linked worktree named only as an rsync or tar directory (#5552)", () => {
		const repo = initRepo(path.join(env.tmpDir, "scope-repo"));
		const worktree = initLinkedWorktree(
			path.join(env.tmpDir, "scope-linked"),
			repo,
		);
		for (const command of [
			`rsync -a in/ ${worktree}/`,
			`tar -xf a.tar -C ${worktree}`,
		]) {
			const scopes = rootsOf(command, repo);
			expect(keys(scopes.roots), command).toEqual(keys([repo, worktree]));
			expect(keys(scopes.writtenDirs), command).toEqual(keys([worktree]));
		}
	});

	it("names the session checkout itself once, however many ways the command reaches it", () => {
		const repo = initRepo(path.join(env.tmpDir, "same-repo"));
		fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
		const scopes = rootsOf(
			`cd ${path.join(repo, "pkg")} && cd .. && node - <<'EOF'\nx\nEOF`,
			repo,
		);
		expect(keys(scopes.roots)).toEqual(keys([repo]));
	});

	it("refuses a checkout of another repository instead of scanning it", () => {
		const repo = initRepo(path.join(env.tmpDir, "mine"));
		const other = initRepo(path.join(env.tmpDir, "other"));
		const scopes = rootsOf(`cd ${other} && node -e "1"`, repo);
		expect(keys(scopes.roots)).toEqual(keys([repo]));
		expect(scopes.refused.map((entry) => entry.reason)).toEqual([
			"different-repository",
		]);
		expect(keys(scopes.refused.map((entry) => entry.root))).toEqual(
			keys([other]),
		);
	});

	it("ignores a directory that is not a checkout at all", () => {
		const repo = initRepo(path.join(env.tmpDir, "checkout"));
		const plain = initCheckoutless(path.join(env.tmpDir, "plain-dir"));
		const scopes = rootsOf(`cd ${plain} && touch x.ts`, repo);
		expect(keys(scopes.roots)).toEqual(keys([repo]));
		expect(scopes.refused).toEqual([]);
	});

	it("refuses every beyond-cap checkout and reports the cap", () => {
		const repo = initRepo(path.join(env.tmpDir, "capped"));
		const worktrees = Array.from(
			{ length: OPAQUE_RECOVERY_ROOT_CAP + 1 },
			(_, index) =>
				initLinkedWorktree(path.join(env.tmpDir, `capped-wt-${index}`), repo),
		);
		const command = worktrees
			.map((worktree) => `cd ${worktree} && true`)
			.join(" && ");
		const scopes = rootsOf(command, repo);
		expect(scopes.roots).toHaveLength(OPAQUE_RECOVERY_ROOT_CAP + 1);
		expect(scopes.capped.map((root) => normalizeMapKey(root))).toEqual(
			keys([worktrees[OPAQUE_RECOVERY_ROOT_CAP]!]),
		);
	});

	it("refuses a checkout when the session root is not one", () => {
		const loose = initCheckoutless(path.join(env.tmpDir, "loose"));
		const repo = initRepo(path.join(env.tmpDir, "target"));
		const scopes = rootsOf(`cd ${repo} && node -e "1"`, loose);
		expect(keys(scopes.roots)).toEqual(keys([loose]));
		expect(scopes.refused.map((entry) => entry.reason)).toEqual([
			"session-root-not-a-checkout",
		]);
	});

	// #4713 R8-1: the cd target was read from the first word after the verb, so
	// a redirection, an assignment or a prefix before it left the worktree
	// unnamed, and an opaque write there got no baseline.
	it.each([
		["a redirection before the operand", "cd 2>/dev/null"],
		["an assignment prefix", "FOO=1 cd"],
		["an empty CDPATH prefix", "CDPATH= cd"],
		["builtin", "builtin cd"],
		["command", "command cd"],
		["an escaped verb", "\\cd"],
		// #4713 R11 (greptile u5ycK): an escape and an empty quote in one word.
		["an escaped verb holding an empty quote", '\\c""d'],
		["an escaped builtin holding an empty quote", 'b\\u""iltin cd'],
	])("admits a linked worktree a cd names after %s", (_label, verb) => {
		const repo = initRepo(path.join(env.tmpDir, "prefixed-repo"));
		const worktree = initLinkedWorktree(
			path.join(env.tmpDir, "prefixed-linked"),
			repo,
		);
		const scopes = rootsOf(`${verb} ${worktree} && node -e "1"`, repo);
		expect(keys(scopes.roots)).toEqual(keys([repo, worktree]));
	});

	// #4713 R8-2: `cd ~+1` names a directory-stack entry, never `./~+1`, so a
	// worktree that happens to sit at that relative name is not one bash enters.
	it("does not admit a worktree spelled like an expanded tilde operand", () => {
		const repo = initRepo(path.join(env.tmpDir, "tilde-repo"));
		for (const operand of ["~+1", "~-", "~nosuchuser"]) {
			initLinkedWorktree(path.join(repo, operand), repo);
			const scopes = rootsOf(`cd ${operand} && node -e "1"`, repo);
			expect(keys(scopes.roots)).toEqual(keys([repo]));
		}
	});

	it("resolves a relative cd target against the session root", () => {
		const repo = initRepo(path.join(env.tmpDir, "relative"));
		const worktree = initLinkedWorktree(
			path.join(env.tmpDir, "relative-linked"),
			repo,
		);
		const scopes = rootsOf(
			`cd ${path.relative(repo, worktree)} && node -e "1"`,
			repo,
		);
		expect(keys(scopes.roots)).toEqual(keys([repo, worktree]));
	});
});

describe("the refusals are recorded once (#2050)", () => {
	it("records one ledger entry per refused root, and one for the cap", async () => {
		const repo = initRepo(path.join(env.tmpDir, "ledger-repo"));
		const other = initRepo(path.join(env.tmpDir, "ledger-other"));
		const worktrees = Array.from(
			{ length: OPAQUE_RECOVERY_ROOT_CAP + 1 },
			(_, index) =>
				initLinkedWorktree(path.join(env.tmpDir, `ledger-wt-${index}`), repo),
		);
		const command = [
			`cd ${other} && true`,
			...worktrees.map((worktree) => `cd ${worktree} && true`),
		].join(" && ");
		const scopes = rootsOf(command, repo);
		resetDegradationLedger();
		const { recordOpaqueRootRefusals } =
			await import("../../clients/opaque-mutation-scan.js");
		// Twice: the record is once per root per session, so the second call
		// adds nothing.
		recordOpaqueRootRefusals(scopes);
		recordOpaqueRootRefusals(scopes);

		const refused = getDegradationSummary().find(
			(group) => group.kind === "opaque-recovery-root-refused",
		);
		// Two distinct once-only entries: the refused repository, and the cap.
		// The second `recordOpaqueRootRefusals` call adds nothing.
		expect(refused?.count).toBe(2);
		const subjects = refused?.latestReasons.map((entry) => entry.subject) ?? [];
		expect(subjects).toContain("cap");
		expect(subjects).toContain(normalizeMapKey(other));
	});
});
