// flake-shape: real-process-spawn — the real hook stdin/exit-code contract
// and the base-to-head differential are the subjects; in-process
// classification cannot prove either child-process boundary (#4071).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import { copyFixtureGitHelper } from "../support/fixture-git-copy.js";

const root = process.cwd();
const probe = path.join(root, "scripts", "guard-bash-probe.mjs");
const probesDir = path.join(root, "tests", "fixtures", "guard-bash-probes");
const corpus = path.join(probesDir, "reviewer-corpus.jsonl");
// Frozen #4054 hook bytes (an open PR, not on master): the r2 head and the r3
// head whose swallowed `--prefix` allowance is R3-1. The blob ids are the git
// object ids of `scripts/hooks/guard-bash.mjs` at those commits.
const R2 = {
	file: path.join(probesDir, "hooks", "guard-bash-4054-r2-2a486ce70.txt"),
	blob: "8e41c75e1ea88a318af5e2a7457cd0727be8099d",
};
const R3 = {
	file: path.join(probesDir, "hooks", "guard-bash-4054-r3-784a6c2d8.txt"),
	blob: "d7d4e708ce2d672b5e3817c8c08800f71e0b4791",
};

type Row = {
	id: string;
	lane: string;
	command: string;
	expect: string;
	gap: string | null;
	head: string;
	base: string | null;
	status: string;
	change: string | null;
};
type Outcome = {
	results: Row[];
	summary: { head: { blob: string }; base: { blob: string } | null };
};

const scratch = mkdtempSync(
	path.join(tmpdir(), "pi-lens-guard-bash-probe-test-"),
);
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/** One private TMPDIR per run, so a leaked fixture directory is observable. */
function run(args: string[], env: Record<string, string> = {}) {
	const home = mkdtempSync(path.join(scratch, "run-"));
	const child = spawnSync(process.execPath, [probe, ...args], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, TMPDIR: home, ...env },
		timeout: 100_000,
	});
	return { ...child, leaked: readdirSync(home) };
}

function json(args: string[], env?: Record<string, string>) {
	const child = run([...args, "--json"], env);
	return { child, outcome: JSON.parse(child.stdout) as Outcome };
}

function writeFile(name: string, text: string) {
	const file = path.join(scratch, name);
	writeFileSync(file, text);
	return file;
}

function writeMatrix(name: string, rows: object[]) {
	return writeFile(
		name,
		rows.map((row) => JSON.stringify({ source: "test", ...row })).join("\n"),
	);
}

function gitBlob(file: string) {
	const bytes = readFileSync(file);
	return createHash("sha1")
		.update(`blob ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
}

// Every test here spawns real children. The round-1 CI run took 15.5 s for
// 384 rows on the 4-core runner (job 112781918398) and failed on vitest's 5 s
// default, so the budget is explicit for the whole file.
describe.skipIf(process.platform === "win32")(
	"guard-bash differential corpus (#4071)",
	{ timeout: 120_000 },
	() => {
		it("judges every corpus row against the real hook of this checkout", () => {
			// Recurrence: review-4078 F3. The round-1 test pinned exit status 1
			// because 12 known-gap rows always failed; neutering the git
			// stash/reset/push guards added 53 more allowed rows and the test
			// stayed green. Per-row verdicts: an unexpected allow reds here, an
			// expect-allow row that denies reds, and a gap row that now denies reds
			// too (its label must go).
			const started = Date.now();
			const { child, outcome } = json([corpus]);
			const elapsed = Date.now() - started;
			const failures = outcome.results
				.filter((row) => row.status.startsWith("FAIL"))
				.map((row) => `${row.id} ${row.status} ${row.command}`);
			expect(failures).toEqual([]);
			expect(child.status).toBe(0);
			expect(child.leaked).toEqual([]);
			// Recurrence: verify-4078-r2 V1. After #4054 merged, 296 rows still
			// carried gap labels; neutering every npm/rm/find guard left the test
			// green because a gap row that denies only printed a note. A gap row
			// that now denies must have its label dropped in the same change.
			const enforced = outcome.results
				.filter((r) => r.status === "enforced")
				.map((r) => `${r.id} (${r.gap}) ${r.command}`);
			expect(
				enforced,
				"known-gap rows now enforced; drop their gap label in the corpus",
			).toEqual([]);
			// The remaining known gaps are exactly the open issues' rows.
			const gaps = outcome.results.filter((r) => r.gap !== null);
			expect(gaps.every((r) => r.status === "gap")).toBe(true);
			expect(
				Object.entries(
					gaps.reduce<Record<string, number>>((count, r) => {
						count[r.gap as string] = (count[r.gap as string] ?? 0) + 1;
						return count;
					}, {}),
				).sort(),
			).toEqual([["#4025", 3]]);
			console.info(
				`guard-bash corpus: ${outcome.results.length} rows in ${elapsed} ms`,
			);
			// Both lanes run, and the guards F3 neutered stay non-gap deny rows.
			expect(new Set(outcome.results.map((r) => r.lane))).toEqual(
				new Set(["linked", "real"]),
			);
			for (const prefix of [
				"git stash",
				"git reset --hard",
				"git push --force",
			])
				expect(
					outcome.results.some(
						(r) =>
							r.command.startsWith(prefix) &&
							r.expect === "deny" &&
							r.gap === null &&
							r.status === "ok",
					),
					prefix,
				).toBe(true);
		});

		it("keeps the corpus free of round-1 padding", () => {
			// Recurrence: review-4078 F4. Round 1 shipped 344 rows that were 53
			// commands cycled with a `# corpus-N` comment suffix.
			const commands = readFileSync(corpus, "utf8")
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { command: string }).command);
			expect(commands.filter((c) => /# corpus-\d+$/.test(c))).toEqual([]);
		});

		it("flags a deny that turns into an allow between two hooks (R3-1)", () => {
			// Recurrence: #4054 r3 let `npm --prefix "$(pwd)" ci` through in a
			// linked lane while r2 denied it; only a hand-built differential
			// found it. The hook bytes are vendored because 784a6c2d8 is not on
			// master and a depth-1 CI checkout cannot read it.
			expect(gitBlob(R2.file)).toBe(R2.blob);
			expect(gitBlob(R3.file)).toBe(R3.blob);
			// The corpus rows that came from the R3-1 finding, sliced at run
			// time so the rows stay in one place.
			const r31 = readFileSync(corpus, "utf8")
				.trim()
				.split("\n")
				.filter((line) => JSON.parse(line).source.includes("R3-1"));
			expect(r31.length).toBeGreaterThanOrEqual(5);
			const matrix = writeFile("r3-1.jsonl", `${r31.join("\n")}\n`);
			const args = [matrix, "--lane", "linked"];
			const hooks = ["--base", R2.file, "--head", R3.file];
			const { child, outcome } = json([...args, ...hooks]);
			expect(outcome.summary.base?.blob).toBe(R2.blob);
			expect(outcome.summary.head.blob).toBe(R3.blob);
			const regressed = outcome.results.filter(
				(r) => r.change === "REGRESSION",
			);
			for (const command of [
				'npm --prefix "$(pwd)" ci',
				"npm ci --prefix=$(pwd)",
				'npm ci --prefix "$(git rev-parse --show-toplevel)"',
				"npm ci --prefix `pwd`",
				'npm --prefix "$(mktemp -d)" ci',
			])
				expect(
					regressed.find((r) => r.command === command),
					command,
				).toMatchObject({ base: "deny", head: "allow", expect: "deny" });
			expect(child.status).toBe(1);
			// The human table prints the same rows and exits the same way.
			const text = run([...args, ...hooks]);
			expect(text.status).toBe(1);
			expect(text.stdout).toContain(
				'deny -> allow\texpect deny\tREGRESSION\tnpm --prefix "$(pwd)" ci',
			);
			// Head and base swapped: going r3 -> r2 repairs the --prefix rows, so
			// none of them is a regression (the scratch-remedy row, which r2
			// over-denies, is).
			const back = run([...args, "--base", R3.file, "--head", R2.file]);
			expect(back.stdout).toContain("fixed\tnpm --prefix");
			expect(back.stdout).not.toContain("REGRESSION\tnpm --prefix");
		});

		it("judges rows per verdict with allow-all and deny-all heads", () => {
			// Recurrence: review-4078 F3 (see the corpus test). Stub hooks make
			// the verdict independent of the real classifier, so the probe's own
			// per-row judgement is the subject.
			const allowAll = writeFile("allow-all.mjs", "process.exit(0);\n");
			const denyAll = writeFile("deny-all.mjs", "process.exit(2);\n");
			const matrix = writeMatrix("judge.jsonl", [
				{ command: "echo a", lane: "real", expect: "deny" },
				{ command: "echo b", lane: "real", expect: "deny", gap: "#1" },
				{ command: "echo c", lane: "real", expect: "allow" },
			]);
			const gapOnly = writeMatrix("gap-only.jsonl", [
				{ command: "echo b", lane: "real", expect: "deny", gap: "#1" },
			]);
			const judged = (file: string, hook: string) => {
				const { child, outcome } = json([file, "--head", hook]);
				return {
					code: child.status,
					stderr: child.stderr,
					by: Object.fromEntries(
						outcome.results.map((r) => [r.command, r.status]),
					),
				};
			};
			const allowed = judged(matrix, allowAll);
			expect(allowed.by).toEqual({
				"echo a": "FAIL-allowed",
				"echo b": "gap",
				"echo c": "ok",
			});
			expect(allowed.code).toBe(1);
			const denied = judged(matrix, denyAll);
			expect(denied.by).toEqual({
				"echo a": "ok",
				"echo b": "enforced",
				"echo c": "FAIL-denied",
			});
			expect(denied.code).toBe(1);
			// A gap row alone never fails the run, whichever way the hook goes.
			expect(judged(gapOnly, allowAll).code).toBe(0);
			expect(judged(gapOnly, denyAll).code).toBe(0);
			const note = run([gapOnly, "--head", denyAll]);
			expect(note.status).toBe(0);
			expect(note.stderr).toContain("NOW ENFORCED");
		});

		it("runs each lane's rows in that lane's fixture with a scrubbed env", () => {
			// Recurrence: review-4078 F1/F5. Round 1 sent the literal `{{LINKED}}`
			// as the payload cwd, so linked rows ran in the checkout under test
			// and passed only because a plegma worktree has a symlinked
			// node_modules; and it pinned PI_LENS_HOME, which turns an unpinned-
			// probe rule off. The stub denies only when every property of the
			// real Claude Code invocation holds for the row's lane.
			const stub = writeFile(
				"env-stub.mjs",
				`import { lstatSync } from "node:fs";
import { basename, dirname } from "node:path";
const payload = JSON.parse(await new Promise((res) => {
	let text = "";
	process.stdin.on("data", (c) => (text += c)).on("end", () => res(text));
}));
const cwd = payload.cwd;
const link = lstatSync(cwd + "/node_modules").isSymbolicLink();
const lane = basename(cwd);
const ok =
	process.cwd() === cwd &&
	!cwd.includes("{{") &&
	payload.hook_event_name === "PreToolUse" &&
	(lane === "lane" ? link : lane === "real" && !link) &&
	dirname(process.env.HOME) === dirname(cwd) &&
	Object.keys(process.env).sort().join() === "HOME,PATH,TMPDIR";
process.exit(ok ? 2 : 0);
`,
			);
			const matrix = writeMatrix("env.jsonl", [
				{ command: "echo env", lane: "both", expect: "deny" },
			]);
			const { child, outcome } = json([matrix, "--head", stub], {
				PI_LENS_HOME: path.join(scratch, "ambient-pin"),
				PILENS_DATA_DIR: path.join(scratch, "ambient-data"),
			});
			expect(
				outcome.results.map((r) => `${r.lane}:${r.status}`).sort(),
			).toEqual(["linked:ok", "real:ok"]);
			expect(child.status).toBe(0);
		});

		it("reads a hook from a ref a depth-1 checkout lacks by fetching it once", () => {
			// Recurrence: review-4078 F6. The round-1 test ran `git show` on a
			// commit that only an open PR carries; the CI `test` job checks out
			// at depth 1, so the object was absent. The probe now fetches the
			// ref on demand. A local origin and a depth-1 clone stand in for
			// GitHub: the object is genuinely missing from the clone.
			const git = (cwd: string, ...args: string[]) =>
				String(gitExecFileSync(args, { cwd, encoding: "utf8" })).trim();
			const origin = path.join(scratch, "origin");
			mkdirSync(path.join(origin, "scripts", "hooks"), { recursive: true });
			git(origin, "init", "-q");
			const commit = (hook: string, subject: string) => {
				writeFileSync(
					path.join(origin, "scripts", "hooks", "guard-bash.mjs"),
					hook,
				);
				git(origin, "add", "-A");
				git(
					origin,
					"-c",
					"user.name=probe",
					"-c",
					"user.email=probe@example.invalid",
					"commit",
					"-q",
					"-m",
					subject,
				);
				return git(origin, "rev-parse", "HEAD");
			};
			const denying = commit("process.exit(2);\n", "deny");
			const allowing = commit("process.exit(0);\n", "allow");
			const clone = path.join(scratch, "clone");
			git(scratch, "clone", "-q", "--depth", "1", `file://${origin}`, clone);
			expect(() => git(clone, "cat-file", "-e", denying)).toThrow();
			mkdirSync(path.join(clone, "scripts", "lib"), { recursive: true });
			copyFileSync(probe, path.join(clone, "scripts", "guard-bash-probe.mjs"));
			copyFileSync(
				path.join(root, "scripts", "lib", "is-main-module.mjs"),
				path.join(clone, "scripts", "lib", "is-main-module.mjs"),
			);
			// The copied helper resolves its background-maintenance policy relative
			// to its own module, so the policy file travels with it; the clone has
			// no `tests/fixtures/` otherwise, and Git would fall back to
			// `maintenance.auto` and fork the detached child again (#4552 R2).
			copyFixtureGitHelper(clone);
			const matrix = writeMatrix("ref.jsonl", [
				{ command: "echo a", lane: "real", expect: "deny" },
			]);
			const home = mkdtempSync(path.join(scratch, "run-"));
			const child = spawnSync(
				process.execPath,
				[
					path.join(clone, "scripts", "guard-bash-probe.mjs"),
					matrix,
					"--base",
					denying,
					"--head",
					allowing,
				],
				{ cwd: clone, encoding: "utf8", env: { ...process.env, TMPDIR: home } },
			);
			expect(child.stdout).toContain(
				"deny -> allow\texpect deny\tREGRESSION\techo a",
			);
			expect(child.status).toBe(1);
			expect(git(clone, "cat-file", "-t", denying)).toBe("commit");
		});

		it("rejects bad arguments and bad matrices, and leaks no fixture", () => {
			// Recurrence: review-4078 F7. `--lane bogus` printed rows=0 and
			// exited 0; a bad `--base` threw after the fixtures existed and left
			// a scratch directory behind.
			const rows = [{ command: "echo a", lane: "real", expect: "allow" }];
			const matrix = writeMatrix("args.jsonl", rows);
			const cases: [string[], RegExp][] = [
				[[matrix, "--lane", "bogus"], /--lane must be one of/],
				[[matrix, "--base"], /--base needs a value/],
				[[matrix, "--head", "--lane", "real"], /--head needs a value/],
				[[matrix, "--nope"], /unknown option --nope/],
				[[], /expected exactly one matrix file/],
				[[matrix, "--lane", "linked"], /no rows selected/],
				[[matrix, "--base", "no such ref"], /not a file or a usable git ref/],
			];
			for (const [args, message] of cases) {
				const child = run(args);
				expect(child.status, args.join(" ")).toBe(1);
				expect(child.stderr, args.join(" ")).toMatch(message);
				expect(child.leaked, args.join(" ")).toEqual([]);
			}
			const bad: [object, RegExp][] = [
				[{ ...rows[0], expect: "maybe" }, /expect must be allow or deny/],
				[{ ...rows[0], gap: "#7" }, /gap is only valid with expect deny/],
				[{ ...rows[0], lane: "both", cwd: "{{OTHER}}" }, /must name one lane/],
				[{ ...rows[0], bogus: "allow" }, /unknown field bogus/],
				[{ ...rows[0], source: "" }, /missing source/],
				[{ ...rows[0], command: "echo {{NOPE}}" }, /unresolved placeholder/],
			];
			for (const [row, message] of bad) {
				const child = run([writeMatrix("bad.jsonl", [row])]);
				expect(child.status, JSON.stringify(row)).toBe(1);
				expect(child.stderr, JSON.stringify(row)).toMatch(message);
				expect(child.leaked, JSON.stringify(row)).toEqual([]);
			}
			const twice = run([writeMatrix("dup.jsonl", [rows[0], rows[0]])]);
			expect(twice.status).toBe(1);
			expect(twice.stderr).toMatch(/duplicate of line 1/);
		});
	},
);
