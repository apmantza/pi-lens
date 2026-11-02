// flake-shape: real-process-spawn — the subject is the real `.husky/pre-push`
// -> `pre-push-targeted-tests.mjs` -> `with-test-lock.mjs` chain run in a
// throwaway git fixture (#3717); an in-process call cannot see the hook's exit
// status or the lock wrapper's timeout line. Split out of
// `pre-push-targeted-tests.test.ts` (#3801), which keeps the selection cases.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envFor, gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");

// #3717 recurrence: a busy machine-wide test lock made pre-push exit 0 without
// running the targeted tests, silently. Every case drives the REAL
// `.husky/pre-push` -> `pre-push-targeted-tests.mjs` -> `with-test-lock.mjs`
// chain inside a throwaway git fixture (copied scripts, a stub `npm run build`,
// one mirrored test), so the cases hold in CI's shape: a depth-1 checkout (no
// `HEAD^` of the live repo is read), `PI_LENS_TEST_NO_LOCK=1` in the ambient
// env (stripped from the child, or the hook would run the tests unlocked and
// recurse into this file), and no `tsc` rewrite of the shared tree.
describe("pre-push lock admission (#3717)", () => {
	const roots: string[] = [];

	beforeEach(() => {
		// CI's shape: the ambient env carries the no-lock switch.
		vi.stubEnv("PI_LENS_TEST_NO_LOCK", "1");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0))
			fs.rmSync(root, { recursive: true, force: true });
	});

	const PASSING_TEST =
		'import { expect, it } from "vitest";\nit("ok", () => { expect(1).toBe(1); });\n';

	// Stands in for scripts/with-test-lock.mjs only where a case must observe
	// the bound the hook hands it without waiting that long: it prints the line
	// the real wrapper prints, carrying the bound it received.
	const STUB_LOCK = `import path from "node:path";
import { fileURLToPath } from "node:url";
export function quoteForWindowsCmd(arg) { return arg; }
export function isEntryPoint(url) { return path.resolve(process.argv[1]) === fileURLToPath(url); }
if (isEntryPoint(import.meta.url)) {
	console.error(\`[with-test-lock] timed out after \${process.env.PI_LENS_TEST_LOCK_TIMEOUT_MS}ms waiting for test-suite lock held by PID 4242 since 2026-01-01T00:00:00.000Z\`);
	process.exitCode = 1;
}
`;

	// A wrapper killed by a signal exits with a null code.
	const KILLED_LOCK = `import path from "node:path";
import { fileURLToPath } from "node:url";
export function quoteForWindowsCmd(arg) { return arg; }
export function isEntryPoint(url) { return path.resolve(process.argv[1]) === fileURLToPath(url); }
if (isEntryPoint(import.meta.url)) process.kill(process.pid, "SIGKILL");
`;

	function makeFixture(
		testSource = PASSING_TEST,
		stubLock: string | false = false,
	) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-prepush-fx-"));
		roots.push(root);
		const put = (rel: string, content: string) => {
			const full = path.join(root, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content, "utf8");
		};
		for (const rel of [
			".husky/pre-push",
			"scripts/pre-push-targeted-tests.mjs",
			"scripts/with-test-lock.mjs",
			"scripts/lib/is-main-module.mjs",
			"scripts/lib/suite-lock.mjs",
			"scripts/lib/test-history-selection.mjs",
			"scripts/lib/vitest-summary.mjs",
		])
			put(rel, fs.readFileSync(path.join(repoRoot, rel), "utf8"));
		if (stubLock) put("scripts/with-test-lock.mjs", stubLock);
		put(
			"package.json",
			JSON.stringify({
				scripts: {
					build:
						"node -e \"require('node:fs').writeFileSync('built.marker','1')\"",
					"astgrep:self-scan": 'node -e "process.exit(0)"',
				},
			}),
		);
		fs.symlinkSync(
			path.join(repoRoot, "node_modules"),
			path.join(root, "node_modules"),
			"junction",
		);
		const git = (...args: string[]) =>
			String(
				gitExecFileSync(
					[
						"-c",
						"user.name=t",
						"-c",
						"user.email=t@example.com",
						"-c",
						"commit.gpgsign=false",
						...args,
					],
					{ cwd: root, encoding: "utf8" },
				),
			).trim();
		git("init", "-q");
		git("add", ".husky", "scripts", "package.json");
		git("commit", "-q", "-m", "base");
		const base = git("rev-parse", "HEAD");
		git("update-ref", "refs/remotes/origin/master", base);
		put("clients/x.ts", "export const x = 1;\n");
		put("tests/clients/x.test.ts", testSource);
		git("add", "clients", "tests");
		git("commit", "-q", "-m", "change");
		const head = git("rev-parse", "HEAD");
		const home = path.join(root, "home");
		fs.mkdirSync(home);
		return {
			root,
			home,
			lockPath: path.join(home, "test-suite.lock"),
			logPath: path.join(home, "pre-push.log"),
			refs: `refs/heads/t ${head} refs/heads/t ${base}\n`,
		};
	}

	function runHook(
		fx: ReturnType<typeof makeFixture>,
		extra: Record<string, string | undefined> = {},
	) {
		const env = envFor(fx.root);
		for (const key of Object.keys(env))
			if (
				/^(VITEST|PI_LENS_|PILENS_|NODE_OPTIONS$|GITHUB_STEP_SUMMARY$)/.test(
					key,
				)
			)
				delete env[key];
		Object.assign(env, {
			PI_LENS_HOME: fx.home,
			PI_LENS_TEST_LOCK_POLL_MS: "10",
			PI_LENS_TEST_LOCK_TIMEOUT_MS: "300",
			...extra,
		});
		for (const [key, value] of Object.entries(extra))
			if (value === undefined) delete env[key];
		return spawnSync("sh", [".husky/pre-push"], {
			cwd: fx.root,
			env,
			encoding: "utf8",
			input: fx.refs,
		});
	}

	// The wrapper's own mirrored stderr already carries the holder text, so the
	// message under test is the hook's `[pre-push]` line alone.
	function busyLine(result: { stderr: string }) {
		return (
			result.stderr
				.split("\n")
				.find((line) => line.startsWith("[pre-push] test lock busy")) ?? ""
		);
	}

	function holdExclusiveLock(fx: ReturnType<typeof makeFixture>) {
		// This test process is alive, so the lock is a live holder without a
		// second process or a scheduling wait.
		fs.writeFileSync(
			fx.lockPath,
			JSON.stringify({
				pid: process.pid,
				startedIso: "2026-01-01T00:00:00.000Z",
			}),
		);
	}

	it("runs the selected test and builds inside the fixture when the lock is free", () => {
		const fx = makeFixture();
		const result = runHook(fx);
		expect(result.stderr).not.toContain("test lock busy");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("running 1 targeted test file(s)");
		expect(fs.existsSync(path.join(fx.root, "built.marker"))).toBe(true);
	}, 60_000);

	it("blocks a busy exclusive lock, names the holder, lock path, bound and opt-out, and records nothing", () => {
		const fx = makeFixture();
		holdExclusiveLock(fx);
		const result = runHook(fx);
		expect(result.status).toBe(1);
		expect(busyLine(result)).toContain("test lock busy after 0.3 s");
		expect(busyLine(result)).toContain(
			`(exclusive test-suite lock held by PID ${process.pid} since 2026-01-01T00:00:00.000Z)`,
		);
		expect(busyLine(result)).toContain(fx.lockPath);
		expect(busyLine(result)).toContain("PI_LENS_PREPUSH_LOCK_SKIP=1 git push");
		expect(busyLine(result)).toContain("PI_LENS_TEST_LOCK_TIMEOUT_MS=");
		expect(fs.existsSync(fx.logPath)).toBe(false);
	});

	it("blocks when every shared slot is busy and says how many there are", () => {
		// #3717 F4: the common contention is other lanes' shared slots, which
		// carry no exclusive-holder line to quote. #3839: the hook now takes a
		// shared slot itself, so the wait it reports is the slot ceiling (2).
		const fx = makeFixture();
		for (const index of [0, 1])
			fs.writeFileSync(
				path.join(fx.home, `test-suite.slot-${index}.lock`),
				JSON.stringify({
					pid: process.pid,
					startedIso: "2026-01-01T00:00:00.000Z",
				}),
			);
		const result = runHook(fx);
		expect(result.status).toBe(1);
		expect(busyLine(result)).toContain("(all 2 shared slot(s) busy)");
		// #3839 review B: a slot block names no PID, and the stuck file to delete
		// is a slot file, not the exclusive lock the old hint pointed at.
		expect(busyLine(result)).toContain(
			path.join(fx.home, "test-suite.slot-N.lock"),
		);
		expect(busyLine(result)).not.toContain(fx.lockPath);
		expect(busyLine(result)).toContain("PI_LENS_PREPUSH_LOCK_SKIP=1");
	});

	// #3839 recurrence: the hook took the EXCLUSIVE lock for a named-file
	// batch (history: hook 08-20, shared slots 09-02, never migrated), so one
	// other agent's `test:targeted` made a push wait or fail at the 120 s
	// bound, and a push stalled every other targeted run. The probe below runs
	// INSIDE the hook's own vitest run, so every wrapper it spawns meets the
	// lock state the hook really holds: no wall-clock wait, no sleeping holder.
	const CONCURRENCY_PROBE = `import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { it } from "vitest";
it("probes the lock the hook holds", () => {
	const wrap = (...flags) => spawnSync(process.execPath, ["scripts/with-test-lock.mjs", ...flags, "--", process.execPath, "-e", "0", "tests/x.test.ts"], { encoding: "utf8", env: process.env });
	const exclusive = wrap();
	const shared = wrap("--shared");
	fs.writeFileSync("probe.json", JSON.stringify({ exclusive: { status: exclusive.status, stderr: exclusive.stderr }, shared: { status: shared.status, stderr: shared.stderr } }));
});
`;

	it("admits the hook beside another shared holder; a full-suite run and a third shared run both wait for them (#3839)", () => {
		const fx = makeFixture(CONCURRENCY_PROBE);
		// Another lane's targeted run, already inside slot 0 (this test process
		// is alive, so the slot is a live holder).
		fs.writeFileSync(
			path.join(fx.home, "test-suite.slot-0.lock"),
			JSON.stringify({
				pid: process.pid,
				startedIso: "2026-01-01T00:00:00.000Z",
			}),
		);
		const result = runHook(fx);
		expect(result.stderr).not.toContain("test lock busy");
		expect(result.status).toBe(0);
		const probe = JSON.parse(
			fs.readFileSync(path.join(fx.root, "probe.json"), "utf8"),
		);
		// A full-suite run still excludes the hook: it drains the slots and finds
		// slot 0 (the other lane) and slot 1 (the hook) busy.
		expect(probe.exclusive.status).toBe(1);
		expect(probe.exclusive.stderr).toContain(
			"timed out after 300ms waiting for test-suite lock: 2 of 2 shared slot(s) still busy",
		);
		// The hook took a slot, not the machine, and the ceiling still holds: a
		// third shared run finds both slots taken.
		expect(probe.shared.status).toBe(1);
		expect(probe.shared.stderr).toContain(
			"timed out after 300ms waiting for test-suite lock: all 2 shared slot(s) busy",
		);
	}, 60_000);

	it("PI_LENS_PREPUSH_LOCK_SKIP=1 exits 0 with a warning and appends one durable record", () => {
		const fx = makeFixture();
		holdExclusiveLock(fx);
		const result = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("WARNING: PI_LENS_PREPUSH_LOCK_SKIP=1");
		expect(result.stderr).toContain(fx.logPath);
		expect(result.stderr).toContain("after 0.3 s");
		const lines = fs.readFileSync(fx.logPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]);
		expect(record).toMatchObject({
			event: "lock-skip",
			waitedMs: 300,
			lockPath: fx.lockPath,
			selected: 1,
		});
		expect(record.holder).toContain(`PID ${process.pid}`);
		expect(typeof record.ts).toBe("string");
	});

	it.each(["true", "0", "yes"])(
		"PI_LENS_PREPUSH_LOCK_SKIP=%s is not the opt-out: the push stays blocked and nothing is recorded",
		(value) => {
			const fx = makeFixture();
			holdExclusiveLock(fx);
			const result = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: value });
			expect(result.status).toBe(1);
			expect(result.stderr).not.toContain("WARNING");
			expect(fs.existsSync(fx.logPath)).toBe(false);
		},
	);

	it.each([
		["unset", undefined, "120 s"],
		["zero", "0", "120 s"],
		["leading zeros", "00", "120 s"],
		["garbage", "abc", "120 s"],
		["negative", "-5", "120 s"],
		["fractional", "1.5", "120 s"],
		["positive override", "2500", "2.5 s"],
	])(
		"hands the wrapper a real bound: %s falls back or passes through (%s -> %s)",
		(_name, value, printed) => {
			// #3717 F2: the hook let an ambient 0/garbage through, which the
			// wrapper reads as "wait forever". The stub wrapper echoes the bound
			// it received in the real wrapper's own message shape.
			const fx = makeFixture(PASSING_TEST, STUB_LOCK);
			const result = runHook(fx, { PI_LENS_TEST_LOCK_TIMEOUT_MS: value });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`test lock busy after ${printed}`);
		},
	);

	it("a failing test that quotes the lock-timeout text is a test failure, not a lock timeout", () => {
		// #3717 F5: the classifier matched the whole stderr buffer, so vitest's
		// own failure output quoting the wrapper's text was read as contention,
		// and the opt-out then turned a failing test into exit 0.
		const fx = makeFixture(
			'import { expect, it } from "vitest";\nit("quotes", () => { expect("timed out after 100ms waiting for test-suite lock held by PID 1 since x").toBe("something else"); });\n',
		);
		const plain = runHook(fx);
		expect(plain.status).toBe(1);
		expect(plain.stderr).not.toContain("test lock busy");
		const optedOut = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(optedOut.status).toBe(1);
		expect(optedOut.stderr).not.toContain("WARNING");
		expect(fs.existsSync(fx.logPath)).toBe(false);
	}, 60_000);

	it("a failing test that prints the wrapper's timeout line at a line start is a test failure, not a lock timeout", () => {
		// #3738 (residual of #3717): the classifier matched ANY stderr line
		// starting `[with-test-lock] `, so a failing test printing that exact
		// prefix was read as contention and PI_LENS_PREPUSH_LOCK_SKIP=1 then
		// pushed a red test. A real lock timeout is wrapper-only stderr.
		const fx = makeFixture(
			'import fs from "node:fs";\nimport { expect, it } from "vitest";\nit("prints then fails", () => { fs.writeSync(2, "[with-test-lock] timed out after 5ms waiting for test-suite lock held by PID 1 since x\\n"); expect(1).toBe(2); });\n',
		);
		const optedOut = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(optedOut.status).toBe(1);
		expect(optedOut.stderr).not.toContain("WARNING");
		expect(busyLine(optedOut)).toBe("");
		expect(fs.existsSync(fx.logPath)).toBe(false);
	}, 60_000);

	it("a wrapper line that only quotes the prefix mid-line is not a lock timeout", () => {
		// #3738 M7: the `^` anchor. Every stderr line here starts with the
		// prefix, so the every-line rule passes and only the anchor separates
		// this quote from the wrapper's own timeout line.
		const quoting = STUB_LOCK.replace(
			"console.error(`[with-test-lock] timed out",
			"console.error(`[with-test-lock] note: [with-test-lock] timed out",
		);
		expect(quoting).not.toBe(STUB_LOCK);
		const fx = makeFixture(PASSING_TEST, quoting);
		const result = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(result.status).toBe(1);
		expect(busyLine(result)).toBe("");
		expect(result.stderr).not.toContain("WARNING");
		expect(fs.existsSync(fx.logPath)).toBe(false);
	});

	it("blocks the push when the locked run is killed by a signal (null exit code)", () => {
		const fx = makeFixture(PASSING_TEST, KILLED_LOCK);
		const result = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(result.status).toBe(1);
		expect(result.stderr).not.toContain("test lock busy");
	});

	it("a passing run whose output quotes the wrapper's timeout line is not a lock timeout", () => {
		// The classifier reads the timeout line only from a failed run: a green
		// run must not be blocked by text it printed itself.
		const fx = makeFixture(
			'import fs from "node:fs";\nimport { expect, it } from "vitest";\nit("prints", () => { fs.writeSync(2, "[with-test-lock] timed out after 5ms waiting for test-suite lock held by PID 1 since x\\n"); expect(1).toBe(1); });\n',
		);
		const result = runHook(fx);
		expect(result.status).toBe(0);
		expect(busyLine(result)).toBe("");
	}, 60_000);

	it("blocks the push, with the reason, when the locked test run cannot start", () => {
		// #3717 recurrence class: master returned 0 ("letting the push proceed")
		// on a spawn error. A preload turns the wrapper spawn into a real ENOENT.
		const fx = makeFixture();
		fs.writeFileSync(
			path.join(fx.root, "spawn-fails.cjs"),
			`const cp = require("node:child_process");
const original = cp.spawn;
if (process.argv[1] && process.argv[1].endsWith("pre-push-targeted-tests.mjs")) {
	cp.spawn = (command, args, options) => original(require("node:path").join(__dirname, "no-such-node"), args, options);
	require("node:module").syncBuiltinESMExports();
}
`,
		);
		const result = runHook(fx, {
			NODE_OPTIONS: `--require ${path.join(fx.root, "spawn-fails.cjs")}`,
			PI_LENS_PREPUSH_LOCK_SKIP: "1",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("could not run targeted tests");
		expect(result.stderr).toContain("push blocked");
	});
});
