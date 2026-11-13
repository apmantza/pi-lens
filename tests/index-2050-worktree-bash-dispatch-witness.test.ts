// flake-shape: real-process-spawn — the subject is what a REAL bash command does to a REAL linked worktree (`git worktree add`), and the detector under test is git's own `status --porcelain`; a stubbed shell or git could not answer either question.
/**
 * #2050 witness: a bash command's writes in a LINKED WORKTREE of the session's
 * repository are recovered, published and dispatched.
 *
 * The reported incident (2026-10-19, investigation `sub-mveuxgfh-195`): the
 * session cwd was the `plegma` checkout, a `cd <linked-worktree> && python3 -`
 * heredoc rewrote seven `.ts` files there, and pi-lens said nothing. Opaque
 * recovery ran `git status` in the session's own checkout, read that clean tree
 * as complete evidence that nothing changed, and the `written.length > 0` gate
 * skipped delivery. 563 of 1 126 retained bash prescans `cd` into a
 * `plegma-worktrees/...` checkout, so this is the maintainer's normal mode.
 *
 * What is REAL here: pi's own `bash` tool runs the command, so the write is a
 * real write by a real interpreter; the BUILT extension's registered
 * `tool_call` and `tool_result` handlers; the real tree-sitter dispatch behind
 * the synthetic write; and the disk-change publisher (#4612) every delivery
 * surface consumes. Scripted is the model only, at the provider boundary.
 *
 * The delivered effect is the DISPATCHER's own `runner` record for the file
 * (rule `debugger-statement`, semantic `blocking`). An opaque recovered write
 * deliberately issues no model-facing inline blocker (it is not the agent's
 * edit), so the model's tool text is not where this delivery shows up.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeMapKey } from "../clients/path-utils.js";
import { execFileSync } from "./support/git-fixture-env.js";
import { endTurn, step } from "./support/pi-session-commit-gate.js";
import { toolResults } from "./support/pi-session-commit-gate.js";
import {
	type PiSession,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

/** The bundled rule that proves the recovered bytes reached a dispatcher. */
const DISPATCH_RULE = "debugger-statement";
/** That rule's message, as the MODEL reads it when the write is authored. */
const DISPATCHED_FINDING = "Debugger statement — remove before committing";
/** A file the bundled `debugger-statement` rule blocks on. */
const BLOCKING = "export function f() {\n\tdebugger;\n}\n";
/** The same bytes as a shell `printf` format, for the recognised-write case. */
const BLOCKING_PRINTF = "'export function f() {\\n\\tdebugger;\\n}\\n'";

const fixture = piSessionFixture();

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A committed repository at `dir` with `seed.ts`, so `git status` has a HEAD to
 * compare against. The return value is the REAL path: a linked worktree's
 * `.git` file names the real common dir, and checkout identity is compared by
 * real location (`realpathOrResolve`).
 */
function initRepo(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "seed.ts"), "export const seed = 1;\n");
	git(["init", "-q"], dir);
	git(["config", "user.email", "t@t.local"], dir);
	git(["config", "user.name", "t"], dir);
	git(["add", "-A"], dir);
	git(["commit", "-qm", "base"], dir);
	return fs.realpathSync.native(dir);
}

/** A heredoc the extractor cannot recognise as a write: no redirect, no verb. */
function heredocWriter(target: string): string {
	return [
		"node - <<'EOF'",
		`require("node:fs").writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(BLOCKING)});`,
		"EOF",
	].join("\n");
}

interface Row {
	type?: string;
	phase?: string;
	filePath?: string;
	result?: string;
	runnerId?: string;
	status?: string;
	diagnostics?: Array<{ rule?: string; semantic?: string }>;
	metadata?: Record<string, unknown>;
}

/**
 * The rows this CASE wrote: one fixture root serves every case in the file, so
 * its `latency.log` holds the earlier cases' rows too. Each case owns a
 * directory of its own, and every row's `filePath` names a path inside it.
 */
async function rows(session: PiSession, scope: string): Promise<Row[]> {
	const read = await session.latencyRows();
	expect(read.skipped).toBe(0);
	return (read.rows as Row[]).filter((row) =>
		(row.filePath ?? "").startsWith(scope),
	);
}

function phases(rowsRead: readonly Row[], phase: string): Row[] {
	return rowsRead.filter((row) => row.phase === phase);
}

/**
 * The dispatcher's verdict for `target`: the rule ids a runner reported there.
 * `[]` means no runner analysed that path at all.
 */
function dispatchedRules(rowsRead: readonly Row[], target: string): string[] {
	const key = normalizeMapKey(target);
	return rowsRead
		.filter(
			(row) =>
				row.type === "runner" &&
				row.filePath !== undefined &&
				normalizeMapKey(row.filePath) === key,
		)
		.flatMap((row) => (row.diagnostics ?? []).map((entry) => entry.rule ?? ""));
}

function bashResults(session: PiSession): string {
	return toolResults(session.requests.at(-1) ?? [], "bash")
		.map((result) => result.text)
		.join("\n");
}

/** One turn: the scripted model calls pi's real `bash` tool, then answers. */
async function runBash(session: PiSession): Promise<PiSession> {
	await session.prompt("run the command");
	return session;
}

describe("a bash write in a linked worktree of the session repo (#2050)", () => {
	it(
		"recovers a recognized mv overwrite when the destination keeps an old mtime (#5552)",
		{ timeout: 180_000 },
		async () => {
			const root = path.join(fixture.root, "mtime-mv");
			const repo = initRepo(path.join(root, "proj"));
			const scope = fs.realpathSync.native(root);
			const target = path.join(repo, "seed.ts");
			const source = path.join(repo, "old-source.ts");
			fs.writeFileSync(source, BLOCKING);
			const old = new Date(Date.now() - 60_000);
			fs.utimesSync(source, old, old);

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							command: `cd ${repo} && mv -f old-source.ts seed.ts`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			const read = await rows(session, scope);
			expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING);
			expect(dispatchedRules(read, target)).toContain(DISPATCH_RULE);
			expect(bashResults(session)).toContain(DISPATCHED_FINDING);
			expect(
				phases(read, "disk_change_published").some(
					(row) =>
						row.metadata?.sources === "bash-write" &&
						row.metadata?.recorded === 1,
				),
			).toBe(true);
		},
	);

	it(
		"recovers a recognized cp -p overwrite when a non-TypeScript destination keeps an old mtime (#5552)",
		{ timeout: 180_000 },
		async () => {
			const root = path.join(fixture.root, "mtime-cp");
			const repo = initRepo(path.join(root, "proj"));
			const scope = fs.realpathSync.native(root);
			const target = path.join(repo, "seed.ts");
			const source = path.join(repo, "old-source.md");
			const destination = path.join(repo, "tracked.md");
			fs.writeFileSync(destination, "before\n");
			git(["add", "tracked.md"], repo);
			git(["commit", "-qm", "tracked markdown"], repo);
			fs.writeFileSync(source, "after\n");
			const old = new Date(Date.now() - 60_000);
			fs.utimesSync(source, old, old);

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							command: `cd ${repo} && cp -p old-source.md tracked.md`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			const read = await rows(session, scope);
			expect(fs.readFileSync(target, "utf8")).toContain("seed");
			expect(fs.readFileSync(destination, "utf8")).toBe("after\n");
			expect(
				phases(read, "opaque_mutation_recovered").some((row) =>
					String(row.filePath).includes("tracked.md"),
				),
			).toBe(true);
			expect(dispatchedRules(read, destination)).toEqual([]);
			expect(
				phases(read, "disk_change_published").some(
					(row) =>
						row.metadata?.sources === "bash-write" &&
						row.metadata?.recorded === 1,
				),
			).toBe(true);
		},
	);

	it(
		"recovers and dispatches a heredoc write in the session's own checkout (control)",
		{ timeout: 180_000 },
		async () => {
			const root = path.join(fixture.root, "control");
			const repo = initRepo(path.join(root, "proj"));
			const scope = fs.realpathSync.native(root);
			const target = path.join(repo, "opaque-control.ts");

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							command: `cd ${repo} && ${heredocWriter("opaque-control.ts")}`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			const read = await rows(session, scope);
			expect(
				phases(read, "opaque_mutation_recovered").map((row) => row.result),
			).toEqual(["changed:1"]);
			expect(dispatchedRules(read, target)).toContain(DISPATCH_RULE);
		},
	);

	it(
		"recovers, publishes and dispatches a heredoc write in a sibling linked worktree",
		{ timeout: 180_000 },
		async () => {
			const root = path.join(fixture.root, "sibling");
			const repo = initRepo(path.join(root, "proj"));
			const scope = fs.realpathSync.native(root);
			const worktree = path.join(root, "linked-worktree");
			git(["worktree", "add", "-q", worktree, "HEAD"], repo);
			expect(fs.statSync(path.join(worktree, ".git")).isFile()).toBe(true);
			const target = path.join(worktree, "opaque-sibling.ts");

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							command: `cd ${worktree} && ${heredocWriter("opaque-sibling.ts")}`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			// The write really landed in the worktree: the defect was detection,
			// never execution.
			expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING);

			const read = await rows(session, scope);
			const recovered = phases(read, "opaque_mutation_recovered");
			expect(recovered.map((row) => row.result)).toEqual(["changed:1"]);
			// Each recovered row names the checkout it came from, and the prescan
			// row names the roots this call took baselines in.
			expect(recovered.map((row) => row.metadata?.root)).toEqual([
				fs.realpathSync.native(worktree),
			]);
			// The row's `filePath` is the command's first 80 characters, so the
			// ROOTS it recorded are the needle, not the (truncated) path text.
			const prescan = (await rows(session, "")).filter(
				(row) =>
					row.phase === "opaque_mutation_prescan" &&
					String(row.metadata?.roots ?? "").includes(worktree),
			);
			expect(prescan.map((row) => row.metadata?.root)).toEqual([
				fs.realpathSync.native(repo),
			]);
			expect(prescan.map((row) => row.metadata?.roots)).toEqual([
				`${fs.realpathSync.native(repo)},${fs.realpathSync.native(worktree)}`,
			]);
			// DELIVERY, half 1: the recovered bytes reached a dispatcher.
			expect(dispatchedRules(read, target)).toContain(DISPATCH_RULE);
			// DELIVERY, half 2: the publisher (#4612) got each phase's population
			// under the WORKTREE root, so the LSP consumer asks that root's clients.
			// Both phases are asserted by their own source label AND by the
			// population the publish carried: `recorded` is the count the publisher
			// derived from the paths handed to it, so an emptied population reds
			// here too (review round 3, F4: the root-only assertion survived both
			// `paths: files -> []` and `publishRecoveredDrift(root, [])`).
			const published = (source: string) =>
				phases(read, "disk_change_published")
					.filter((row) => row.metadata?.sources === source)
					.map((row) => ({
						root: row.filePath,
						recorded: row.metadata?.recorded,
						result: row.result,
					}));
			const worktreeRoot = fs.realpathSync.native(worktree);
			expect(published("bash-write")).toEqual([
				{ root: worktreeRoot, recorded: 1, result: "bash-recovery:1" },
			]);
			expect(published("recovered-drift")).toEqual([
				{ root: worktreeRoot, recorded: 1, result: "bash-recovery:1" },
			]);
		},
	);

	it(
		"dispatches a write in a nested worktree the session checkout ignores",
		{ timeout: 180_000 },
		async () => {
			// The documented fixer layout: this repository ignores `.claude/`, and a
			// fixer cuts its worktree under `.claude/worktrees/`. The owning checkout
			// admits the file; judging it again against the PARENT's ignores dropped
			// it silently (review round 3, F2: publish under the nested root, no
			// runner row, no record).
			const root = path.join(fixture.root, "ignored-parent");
			const repo = initRepo(path.join(root, "proj"));
			const scope = fs.realpathSync.native(root);
			fs.writeFileSync(path.join(repo, ".gitignore"), ".claude/\n");
			git(["add", "-A"], repo);
			git(["commit", "-qm", "ignore the worktree parent"], repo);
			const nested = path.join(repo, ".claude", "worktrees", "nested");
			git(["worktree", "add", "-q", nested, "HEAD"], repo);
			const target = path.join(nested, "opaque-nested-ignored.ts");

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							command: `cd .claude/worktrees/nested && ${heredocWriter("opaque-nested-ignored.ts")}`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING);
			const read = await rows(session, scope);
			expect(
				phases(read, "opaque_mutation_recovered").map((row) => row.result),
			).toEqual(["changed:1"]);
			expect(
				phases(read, "disk_change_published")
					.filter((row) => row.metadata?.sources === "bash-write")
					.map((row) => ({
						root: row.filePath,
						recorded: row.metadata?.recorded,
					})),
			).toEqual([{ root: fs.realpathSync.native(nested), recorded: 1 }]);
			// The parent's `.claude/` rule never reaches the nested checkout's own
			// files, so the recovered bytes reach a dispatcher.
			expect(dispatchedRules(read, target)).toContain(DISPATCH_RULE);
		},
	);

	it(
		"keeps the ownership of a write reached through a symlinked worktree spelling",
		{ timeout: 180_000 },
		async () => {
			// A `cd` into a symlink that points at a linked worktree names the same
			// checkout under a different spelling. The witness that judges a
			// recognised write by ITS OWN root's observation compared a lexical
			// spelling with a real path, lost the match, and fell back to the opaque
			// half: dispatched, but with no authorship, so no inline finding
			// (review round 3, F3).
			const root = path.join(fixture.root, "alias");
			const repo = initRepo(path.join(root, "proj"));
			const scope = fs.realpathSync.native(root);
			const worktree = path.join(root, "linked-worktree");
			git(["worktree", "add", "-q", worktree, "HEAD"], repo);
			const alias = path.join(repo, "alias-to-linked");
			fs.symlinkSync(fs.realpathSync.native(worktree), alias);
			const target = path.join(worktree, "alias-target.ts");
			const spelled = path.join(alias, "alias-target.ts");

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							command: `cd ${alias} && printf ${BLOCKING_PRINTF} > alias-target.ts`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING);
			const read = await rows(session, scope);
			// The recognised write dispatches under the spelling the command used
			// (the symlink), which is the checkout the recovery root also reports.
			expect(dispatchedRules(read, spelled)).toContain(DISPATCH_RULE);
			// The same effect the sibling-worktree case pins for its own spelling:
			// authorship is what carries the finding to the model, and with the
			// ownership lost the file dispatched as an opaque write instead.
			expect(bashResults(session)).toContain(DISPATCHED_FINDING);
			// One file, one dispatch: the opaque half subtracts the identity the
			// recognised write already claimed, so the model is never told "clean"
			// about the same bytes it has just been told are blocked.
			expect(phases(read, "dispatch_start")).toHaveLength(1);
		},
	);

	it(
		"recovers and dispatches a write in a nested worktree under the session root",
		{ timeout: 180_000 },
		async () => {
			const root = path.join(fixture.root, "nested");
			const repo = initRepo(path.join(root, "proj"));
			const scope = fs.realpathSync.native(root);
			const nested = path.join(repo, ".claude", "worktrees", "nested");
			git(["worktree", "add", "-q", nested, "HEAD"], repo);
			const target = path.join(nested, "opaque-nested.ts");

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							command: `cd .claude/worktrees/nested && ${heredocWriter("opaque-nested.ts")}`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			const read = await rows(session, scope);
			expect(
				phases(read, "opaque_mutation_recovered").map((row) => row.result),
			).toEqual(["changed:1"]);
			expect(dispatchedRules(read, target)).toContain(DISPATCH_RULE);
			// The NESTED root owns the file, so that is the root the publish names:
			// the session root's own `git status` only ever reports the worktree
			// directory, never the files inside it (probed).
			expect(
				phases(read, "disk_change_published")
					.filter((row) => row.metadata?.sources === "bash-write")
					.map((row) => row.filePath),
			).toEqual([fs.realpathSync.native(nested)]);
		},
	);

	it(
		"resolves a relative redirect after `cd` against the command's own directory",
		{ timeout: 180_000 },
		async () => {
			const root = path.join(fixture.root, "recognised");
			const repo = initRepo(path.join(root, "proj"));
			const scope = fs.realpathSync.native(root);
			const worktree = path.join(root, "linked-worktree");
			git(["worktree", "add", "-q", worktree, "HEAD"], repo);
			const target = path.join(worktree, "redirect-target.ts");

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							command: `cd ${worktree} && printf ${BLOCKING_PRINTF} > redirect-target.ts`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			// The command wrote the worktree file, never a phantom under the
			// session root.
			expect(fs.readFileSync(target, "utf8")).toBe(BLOCKING);
			expect(fs.existsSync(path.join(repo, "redirect-target.ts"))).toBe(false);
			// AC4: the recognised operand resolves against the command's own `cd`,
			// so the write survives the clean-verdict clearing rule and dispatches.
			expect(dispatchedRules(await rows(session, scope), target)).toContain(
				DISPATCH_RULE,
			);
			// The command wrote this file as the agent's own recognised write, so
			// its finding is delivered inline exactly as a redirect in the session
			// root would be. This is the admission's real effect: recovery finds
			// the bytes either way, while AUTHORSHIP (and with it the autonomous
			// writer tier) comes only from the recognised path.
			expect(bashResults(session)).toContain(DISPATCHED_FINDING);
		},
	);

	it(
		"recovers both roots of one mixed command, and records the multi-root result",
		{ timeout: 180_000 },
		async () => {
			const root = path.join(fixture.root, "mixed");
			const repo = initRepo(path.join(root, "proj"));
			const worktree = path.join(root, "linked-worktree");
			git(["worktree", "add", "-q", worktree, "HEAD"], repo);
			const scope = fs.realpathSync.native(root);
			const inWorktree = path.join(worktree, "opaque-mixed-wt.ts");
			const inSession = path.join(repo, "opaque-mixed-session.ts");

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							// Two heredocs need a real newline between them: `EOF ; node -`
							// is not the delimiter, and the second body would be swallowed.
							command: `cd ${worktree} && ${heredocWriter("opaque-mixed-wt.ts")}\ncd ${repo} && ${heredocWriter("opaque-mixed-session.ts")}`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			expect(fs.readFileSync(inWorktree, "utf8")).toBe(BLOCKING);
			expect(fs.readFileSync(inSession, "utf8")).toBe(BLOCKING);
			const read = await rows(session, scope);
			expect(
				phases(read, "opaque_mutation_recovered")
					.map((row) => row.metadata?.root)
					.sort(),
			).toEqual(
				[fs.realpathSync.native(repo), fs.realpathSync.native(worktree)].sort(),
			);
			expect(
				phases(read, "opaque_mutation_multi_root").map((row) => row.result),
			).toEqual(["roots:2"]);
		},
	);

	it(
		"records one bounded refusal for a `cd` into another repository",
		{ timeout: 180_000 },
		async () => {
			const root = path.join(fixture.root, "other-repo");
			const repo = initRepo(path.join(root, "proj"));
			const other = initRepo(path.join(root, "other"));
			const scope = fs.realpathSync.native(root);

			const session = await startPiSession({
				root: fixture.root,
				cwd: repo,
				responses: [
					step(
						fauxToolCall("bash", {
							command: `cd ${other} && ${heredocWriter("opaque-other.ts")}`,
						}),
					),
					endTurn(),
				],
			});
			await runBash(session);

			const refusals = phases(
				await rows(session, scope),
				"degradation_ledger",
			).filter((row) => row.metadata?.kind === "opaque-recovery-root-refused");
			expect(refusals.map((row) => row.filePath)).toEqual([other]);
		},
	);
});
