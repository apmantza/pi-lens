// flake-shape: real-process-spawn — the mutation CLI's child Vitest process and SIGINT restoration are the process boundary under test.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { waitFor } from "../clients/interleaving-kit.js";
import { isProcessAlive } from "../support/process-tree.js";

// Every case spawns a real Vitest child; a shared CI runner needs more than the
// 5 s default (the round-2 orphan-journal test timed out there).
vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);
const root = process.cwd();
const cli = "scripts/mutate.mjs";
const target = "tests/scripts/mutate-fixture.test.ts";
const find = "true";
const replace = "Boolean(1)";
const digest = (file: string = target) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

function invoke(testFile: string, ...extra: string[]) {
	return execFileAsync(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			find,
			"--replace",
			replace,
			"--tests",
			testFile,
			...extra,
		],
		{ cwd: root },
	);
}

it("restores the source after a successful test run and reports SURVIVED", async () => {
	const before = digest();
	const { stdout } = await invoke(target);
	expect(stdout).toContain("SURVIVED");
	expect(digest()).toBe(before);
});

// The usage line says `--tests <files…>`; the argument loop used to read the
// rest of argv as the list and then reject its second entry as "unknown
// argument" (found while mutating #4087 against several test files).
it("accepts several test files after --tests", async () => {
	const before = digest();
	const { stdout } = await invoke(target, target);
	expect(stdout).toContain("SURVIVED");
	expect(digest()).toBe(before);
});

// The usage line puts [--table] after `--tests <files…>`; the list used to run
// to the end of argv, so the flag reached vitest (CACError) and a surviving
// mutation read RED (PR #4109 review F2).
it("ends the --tests list at the next flag", async () => {
	const before = digest();
	const { stdout } = await invoke(target, "--table");
	expect(stdout).toContain("SURVIVED");
	expect(stdout).toContain(
		"mutation-table: | tests/scripts/mutate-fixture.test.ts | 0 | SURVIVED",
	);
	expect(digest()).toBe(before);
});

it("restores the source after a failing test run and reports RED with a title", async () => {
	// Round 2 searched a string-only needle, which the matcher refuses with the
	// same exit code 1, so this test never reached RED. A code needle does.
	const before = digest();
	await expect(
		execFileAsync(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--find",
				"expect(mutationSafeMarker).toBe(true)",
				"--replace",
				"expect(mutationSafeMarker).toBe(false)",
				"--tests",
				target,
			],
			{ cwd: root },
		),
	).rejects.toMatchObject({
		code: 1,
		stdout: expect.stringMatching(
			/mutation fixture remains original[\s\S]*\nRED\n[\s\S]*\| 1 \| RED \|/,
		),
	});
	expect(digest()).toBe(before);
});

// Recurrence (#4490 L1): a failed test title is free text, and the mutation-
// table row is pasted into PR_BODY.md. A pipe in the title must not add a
// table cell, so the escaped row keeps its five unescaped pipes.
it("keeps a failed title's pipe inside its mutation-table cell (#4490 L1)", async () => {
	const pipeTarget = "tests/scripts/mutate-pipe-title.test.ts";
	const before = createHash("sha256")
		.update(readFileSync(pipeTarget))
		.digest("hex");
	const error = await execFileAsync(
		process.execPath,
		[
			cli,
			"--file",
			pipeTarget,
			"--find",
			"const mutatePipeMarker = true;",
			"--replace",
			"const mutatePipeMarker = false;",
			"--tests",
			pipeTarget,
		],
		{ cwd: root },
	).then(
		() => null,
		(thrown: { stdout: string }) => thrown,
	);
	const row = error?.stdout
		.split("\n")
		.find((line) => line.startsWith("mutation-table:"));
	expect(row).toContain("pipe \\| in a title");
	const cells = row?.slice("mutation-table: ".length) ?? "";
	let unescaped = 0;
	for (let i = 0; i < cells.length; i++) {
		if (cells[i] === "\\") i++;
		else if (cells[i] === "|") unescaped++;
	}
	expect(unescaped).toBe(5);
	expect(digest(pipeTarget)).toBe(before);
});

// The failed-title row is pasted into PR bodies; under CI's colour the titles
// must reach it without escape codes (#4087: the strip moved onto the shared
// Vitest parser).
it("prints the mutation-table row without colour codes (coloured run)", async () => {
	const before = digest();
	const error = await execFileAsync(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			"expect(mutationSafeMarker).toBe(true)",
			"--replace",
			"expect(mutationSafeMarker).toBe(false)",
			"--tests",
			target,
		],
		{
			cwd: root,
			env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: "1" },
		},
	).then(
		() => null,
		(thrown: { stdout: string }) => thrown,
	);
	const row = error?.stdout
		.split("\n")
		.find((line) => line.startsWith("mutation-table:"));
	expect(row).toContain("mutation fixture remains original");
	expect(row).not.toContain("\u001b");
	expect(digest()).toBe(before);
});

it("restores after a mutation throw", async () => {
	const before = digest();
	await expect(
		execFileAsync(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--find",
				"/[",
				"--replace",
				"changed",
				"--tests",
				target,
			],
			{ cwd: root },
		),
	).rejects.toMatchObject({ code: 1 });
	expect(digest()).toBe(before);
});

// Recurrence (#4510): the catch around edit, build and test printed every
// thrown error as RED, so a mutation that never ran read as a test that
// catches it (PR #4491 rounds 4 to 6). Each stage prints its own status line.
it("refuses a no-op and leaves the source untouched, printing REFUSED (#4510)", async () => {
	const before = digest();
	const result = await run([
		cli,
		"--file",
		target,
		"--find",
		"missing",
		"--replace",
		"changed",
		"--tests",
		target,
	]);
	expect(result.code).toBe(1);
	expect(result.stdout).toMatch(/\nREFUSED\n/);
	expect(result.stdout).not.toMatch(/\nRED\n/);
	expect(result.stdout).toContain(
		"mutation-table: | tests/scripts/mutate-fixture.test.ts | 1 | REFUSED |",
	);
	expect(digest()).toBe(before);
});

it("prints ERROR, not RED, when the run fails before any edit (#4510)", async () => {
	// A directory passes the existence and git-clean checks and then fails to
	// read: a failure that is neither a refused edit nor a failed build.
	const result = await run([
		cli,
		"--file",
		"scripts/lib",
		"--find",
		"x",
		"--replace",
		"y",
		"--tests",
		target,
	]);
	expect(result.code).toBe(1);
	expect(result.stdout).toMatch(/\nERROR\n/);
	expect(result.stdout).not.toMatch(/\n(RED|REFUSED|BROKEN)\n/);
});

it("prints BROKEN, exits 1 and restores source and twin when the build fails (#4510)", async () => {
	// A leaf client stands in for any built source (see the --restore twin case).
	const source = "clients/freshness-cadence.ts";
	const twin = "clients/freshness-cadence.js";
	const sourceOriginal = readFileSync(source);
	const twinOriginal = readFileSync(twin);
	try {
		const result = await run([
			cli,
			"--file",
			source,
			"--find",
			"2_000",
			"--replace",
			"2_000 )",
			"--tests",
			target,
		]);
		expect(result.code).toBe(1);
		expect(result.stdout).toMatch(/\nBROKEN\n/);
		expect(result.stdout).not.toMatch(/\nRED\n/);
		expect(result.stdout).toContain(
			"mutation-table: | clients/freshness-cadence.ts | 1 | BROKEN |",
		);
		expect(readFileSync(source).equals(sourceOriginal)).toBe(true);
		expect(readFileSync(twin).equals(twinOriginal)).toBe(true);
	} finally {
		forceRestore(source, sourceOriginal);
		forceRestore(twin, twinOriginal);
	}
}, 120_000);

it("restores on SIGINT", async () => {
	const before = digest();
	const child = spawn(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			find,
			"--replace",
			replace,
			"--tests",
			target,
		],
		{
			cwd: root,
			env: { ...process.env, PI_LENS_MUTATION_RUN: "1" },
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	await new Promise((resolve) => child.stdout?.once("data", resolve));
	child.kill("SIGINT");
	const [code, signal] = await new Promise<
		[number | null, NodeJS.Signals | null]
	>((resolve) =>
		child.once("close", (exitCode, closeSignal) =>
			resolve([exitCode, closeSignal]),
		),
	);
	expect(code).toBeNull();
	expect(signal).toBe("SIGINT");
	expect(digest()).toBe(before);
});

it("supports a surviving built-twin mutation", async () => {
	const builtTarget = "tests/scripts/mutate-built.txt";
	const before = createHash("sha256")
		.update(readFileSync(builtTarget))
		.digest("hex");
	const { stdout } = await execFileAsync(
		process.execPath,
		[
			cli,
			"--built",
			"--file",
			builtTarget,
			"--find",
			"mutation-built-marker",
			"--replace",
			"changed",
			"--tests",
			target,
		],
		{ cwd: root },
	);
	expect(stdout).toContain("SURVIVED");
	expect(
		createHash("sha256").update(readFileSync(builtTarget)).digest("hex"),
	).toBe(before);
});

it("refuses a comment-only match unless explicitly allowed", async () => {
	const before = digest();
	await expect(
		execFileAsync(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--find",
				"mutation-comment-only-marker",
				"--replace",
				"changed",
				"--tests",
				target,
			],
			{ cwd: root },
		),
	).rejects.toMatchObject({
		code: 1,
		stdout: expect.stringContaining("comments/strings"),
	});
	const { stdout } = await execFileAsync(
		process.execPath,
		[
			cli,
			"--allow-comment",
			"--file",
			target,
			"--find",
			"mutation-comment-only-marker",
			"--replace",
			"changed",
			"--tests",
			target,
		],
		{ cwd: root },
	);
	expect(stdout).toContain("SURVIVED");
	expect(digest()).toBe(before);
});

it("refuses repeated --file options", async () => {
	await expect(
		execFileAsync(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--file",
				"tests/scripts/mutate-built.txt",
				"--find",
				find,
				"--replace",
				replace,
				"--tests",
				target,
			],
			{ cwd: root },
		),
	).rejects.toMatchObject({
		code: 2,
		stderr: expect.stringContaining("repeated --file"),
	});
});

// CI colours Vitest's summary ("Tests" and "no tests" are split by escape
// codes), and a plain terminal does not; PR #4075's first CI run was red on the
// coloured form only.
it.each([
	["plain", {}],
	["coloured", { FORCE_COLOR: "1" }],
])(
	"reports a test load failure as ERROR (%s output)",
	async (_name, colour) => {
		const before = digest();
		await expect(
			execFileAsync(
				process.execPath,
				[
					cli,
					"--file",
					target,
					"--find",
					"const mutationSafeMarker =",
					"--replace",
					"const mutationSafeMarker = =",
					"--tests",
					target,
				],
				{ cwd: root, env: { ...process.env, NO_COLOR: undefined, ...colour } },
			),
		).rejects.toMatchObject({
			code: 1,
			stdout: expect.stringContaining("\nERROR\n"),
		});
		expect(digest()).toBe(before);
	},
	60_000,
);

// Recurrence (#4510 review F1): a test-stage run with no verdict printed RED,
// so "only a failed test run prints RED" was false for a bad --tests path and
// for a vitest killed from outside.
it("prints ERROR, not RED, when --tests names no test file (#4510)", async () => {
	const before = digest();
	const result = await run([
		cli,
		"--file",
		target,
		"--find",
		find,
		"--replace",
		replace,
		"--tests",
		"tests/scripts/does-not-exist-4510.test.ts",
	]);
	expect(result.code).toBe(1);
	expect(result.stdout).toMatch(/\nERROR\n/);
	expect(result.stdout).not.toMatch(/\nRED\n/);
	expect(digest()).toBe(before);
});

it("prints ERROR, not RED, when vitest is killed from outside after a summary line (#4510)", async () => {
	const before = digest();
	const result = await run(
		[
			cli,
			"--file",
			target,
			"--find",
			find,
			"--replace",
			replace,
			"--tests",
			target,
		],
		{ PI_LENS_MUTATION_KILL_RUNNER: "1" },
	);
	expect(result.code).toBe(130);
	expect(result.stdout).toMatch(/\nERROR\n/);
	expect(result.stdout).not.toMatch(/\nRED\n/);
	expect(digest()).toBe(before);
});

// Recurrence (#4510 review F2): a signal SIGKILLed only the vitest launcher and
// its worker fork ran on until its test ended (two 99% CPU orphans, 4 h).
it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
	"%s to the run kills the vitest worker fork too (#4510)",
	async (signal) => {
		const before = digest();
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-mutate-pid-"));
		const pidFile = join(dir, "worker.pid");
		// The fixture creates the pid file before it writes it (#5105). Plant
		// that empty state first, so the wait must read content, not existence.
		writeFileSync(pidFile, "");
		const child = spawn(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--find",
				find,
				"--replace",
				replace,
				"--tests",
				target,
			],
			{
				cwd: root,
				env: {
					...process.env,
					PI_LENS_MUTATION_RUN: "1",
					PI_LENS_MUTATION_PIDFILE: pidFile,
				},
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		const closed = new Promise((resolve) => child.once("close", resolve));
		try {
			await waitFor(
				() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0,
				(found) => found,
				{ timeoutMs: 60_000, intervalMs: 100 },
			);
			const worker = Number(readFileSync(pidFile, "utf8"));
			expect(worker).toBeGreaterThan(0);
			child.kill(signal);
			await closed;
			await waitFor(
				() => isProcessAlive(worker),
				(alive) => !alive,
				{ timeoutMs: 5_000, intervalMs: 100 },
			);
			expect(digest()).toBe(before);
		} finally {
			child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	},
	60_000,
);

async function terminatesAndRestores(signal: "SIGTERM" | "SIGHUP") {
	const before = digest();
	const child = spawn(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			find,
			"--replace",
			replace,
			"--tests",
			target,
		],
		{
			cwd: root,
			env: { ...process.env, PI_LENS_MUTATION_RUN: "1" },
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	await new Promise((resolve) => child.stdout?.once("data", resolve));
	child.kill(signal);
	const [code, closeSignal] = await new Promise<
		[number | null, NodeJS.Signals | null]
	>((resolve) =>
		child.once("close", (exitCode, observedSignal) =>
			resolve([exitCode, observedSignal]),
		),
	);
	expect(code).toBeNull();
	expect(closeSignal).toBe(signal);
	expect(digest()).toBe(before);
}

it("restores on SIGTERM", () => terminatesAndRestores("SIGTERM"));

it("restores on SIGHUP", () => terminatesAndRestores("SIGHUP"));

it("restores when a real timeout sends SIGTERM", async () => {
	const builtTarget = "tests/scripts/mutate-built.txt";
	const before = createHash("sha256")
		.update(readFileSync(builtTarget))
		.digest("hex");
	await expect(
		execFileAsync(
			"timeout",
			[
				"-s",
				"TERM",
				"2s",
				process.execPath,
				cli,
				"--built",
				"--file",
				"tests/scripts/mutate-built.txt",
				"--find",
				"mutation-built-marker",
				"--replace",
				"changed",
				"--tests",
				target,
			],
			{ cwd: root, env: { ...process.env, PI_LENS_MUTATION_RUN: "1" } },
		),
	).rejects.toMatchObject({
		code: 124,
	});
	expect(
		createHash("sha256").update(readFileSync(builtTarget)).digest("hex"),
	).toBe(before);
});

it("restores a SIGKILLed run on the next --restore invocation", async () => {
	const before = digest();
	const child = spawn(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			find,
			"--replace",
			replace,
			"--tests",
			target,
		],
		{
			cwd: root,
			env: { ...process.env, PI_LENS_MUTATION_RUN: "1" },
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	await new Promise((resolve) => child.stdout?.once("data", resolve));
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("close", resolve));
	expect(digest()).not.toBe(before);
	await execFileAsync(process.execPath, [cli, "--restore"], { cwd: root });
	expect(digest()).toBe(before);
});

// ---- #4048 round 3: conditional restore (state table rows in the PR body) ----

const builtTarget = "tests/scripts/mutate-built.txt";
const builtArgs = (file: string, ...extra: string[]) => [
	cli,
	"--built",
	"--file",
	file,
	"--find",
	file === builtTarget ? "mutation-built-marker" : find,
	"--replace",
	file === builtTarget ? "changed" : replace,
	"--tests",
	target,
	...extra,
];
const shaOf = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");
const journalOf = (file: string) => `${file}.mutate-backup`;

type Held = {
	child: ReturnType<typeof spawn>;
	stderr: () => string;
	closed: Promise<[number | null, NodeJS.Signals | null]>;
};

// A live run: journal written, file mutated, the fixture test holding the child.
async function heldRun(file: string, env: Record<string, string> = {}) {
	let stderr = "";
	const child = spawn(process.execPath, builtArgs(file), {
		cwd: root,
		env: { ...process.env, PI_LENS_MUTATION_RUN: "1", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	const closed = new Promise<[number | null, NodeJS.Signals | null]>(
		(resolve) => child.once("close", (code, signal) => resolve([code, signal])),
	);
	await new Promise((resolve) => child.stdout?.once("data", resolve));
	return { child, stderr: () => stderr, closed } satisfies Held;
}

async function crashedRun(file: string) {
	const held = await heldRun(file);
	held.child.kill("SIGKILL");
	await held.closed;
}

// Whatever a test leaves behind is put back, so a red assertion cannot dirty
// the tree for the next case.
function forceRestore(file: string, original: Buffer) {
	writeFileSync(file, original);
	rmSync(journalOf(file), { force: true });
}

async function run(args: string[], env: Record<string, string> = {}) {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, args, {
			cwd: root,
			env: { ...process.env, ...env },
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const { code, stdout, stderr } = error as {
			code: number;
			stdout: string;
			stderr: string;
		};
		return { code, stdout, stderr };
	}
}

function expectReport(
	output: string,
	file: string,
	hashes: { original: string; mutated: string; current: string },
) {
	expect(output).toContain(journalOf(file));
	expect(output).toContain(hashes.original);
	expect(output).toContain(hashes.mutated);
	expect(output).toContain(hashes.current);
}

it("a second run on the same file refuses while the first run's journal exists", async () => {
	// Round-2 recurrence: a normal run restored whatever journal it found, so a
	// second run on the same file pulled the live run's mutation out from under it.
	const original = readFileSync(builtTarget);
	const originalSha = shaOf(builtTarget);
	const live = await heldRun(builtTarget);
	try {
		const mutatedSha = shaOf(builtTarget);
		expect(mutatedSha).not.toBe(originalSha);
		const second = await run(builtArgs(builtTarget));
		expect(second.code).toBe(1);
		expectReport(second.stderr, builtTarget, {
			original: originalSha,
			mutated: mutatedSha,
			current: mutatedSha,
		});
		expect(shaOf(builtTarget)).toBe(mutatedSha);
		live.child.kill("SIGTERM");
		await live.closed;
		expect(shaOf(builtTarget)).toBe(originalSha);
	} finally {
		live.child.kill("SIGKILL");
		await live.closed;
		forceRestore(builtTarget, original);
	}
}, 60_000);

it("two live runs on different files restore independently", async () => {
	// Table row 14: journals are per file; neither run touches the other's file.
	const builtOriginal = readFileSync(builtTarget);
	const fixtureOriginal = readFileSync(target);
	const a = await heldRun(builtTarget);
	const b = await heldRun(target);
	try {
		expect(shaOf(builtTarget)).not.toBe(
			createHash("sha256").update(builtOriginal).digest("hex"),
		);
		expect(shaOf(target)).not.toBe(
			createHash("sha256").update(fixtureOriginal).digest("hex"),
		);
		a.child.kill("SIGTERM");
		await a.closed;
		expect(readFileSync(builtTarget).equals(builtOriginal)).toBe(true);
		expect(shaOf(target)).not.toBe(
			createHash("sha256").update(fixtureOriginal).digest("hex"),
		);
		b.child.kill("SIGTERM");
		await b.closed;
		expect(readFileSync(target).equals(fixtureOriginal)).toBe(true);
	} finally {
		a.child.kill("SIGKILL");
		b.child.kill("SIGKILL");
		await Promise.all([a.closed, b.closed]);
		forceRestore(builtTarget, builtOriginal);
		forceRestore(target, fixtureOriginal);
	}
}, 60_000);

it("a normal run refuses after a crash and --restore restores", async () => {
	// Table rows 5 and 8. Round 2 consumed the orphan journal in the next normal
	// run, which cannot tell a dead journal from a live one.
	const original = readFileSync(builtTarget);
	const originalSha = shaOf(builtTarget);
	await crashedRun(builtTarget);
	try {
		const mutatedSha = shaOf(builtTarget);
		const normal = await run(builtArgs(builtTarget));
		expect(normal.code).toBe(1);
		expectReport(normal.stderr, builtTarget, {
			original: originalSha,
			mutated: mutatedSha,
			current: mutatedSha,
		});
		expect(shaOf(builtTarget)).toBe(mutatedSha);
		const restore = await run([cli, "--restore"]);
		expect(restore.code).toBe(0);
		expect(restore.stdout).toContain("restored 1 mutation journal(s)");
		expect(shaOf(builtTarget)).toBe(originalSha);
		expect(await run([cli, "--restore", "--file", builtTarget])).toMatchObject({
			code: 0,
			stdout: expect.stringContaining("restored 0 mutation journal(s)"),
		});
	} finally {
		forceRestore(builtTarget, original);
	}
}, 60_000);

it.each([
	[
		"a normal run",
		[
			"--built",
			"--file",
			builtTarget,
			"--find",
			"mutation-built-marker",
			"--replace",
			"x",
			"--tests",
			target,
		],
	],
	["--restore", ["--restore", "--file", builtTarget]],
])(
	"%s refuses a journal whose file was legitimately edited afterwards",
	async (_name, args) => {
		// The round-2 HIGH (rows 7 and 10): the journal overwrote a later edit.
		const original = readFileSync(builtTarget);
		const originalSha = shaOf(builtTarget);
		await crashedRun(builtTarget);
		try {
			const mutatedSha = shaOf(builtTarget);
			writeFileSync(builtTarget, "legitimate later edit\n");
			const currentSha = shaOf(builtTarget);
			const result = await run([cli, ...args]);
			expect(result.code).toBe(1);
			expectReport(result.stderr, builtTarget, {
				original: originalSha,
				mutated: mutatedSha,
				current: currentSha,
			});
			expect(readFileSync(builtTarget, "utf8")).toBe("legitimate later edit\n");
			expect(readFileSync(journalOf(builtTarget), "utf8")).toContain(
				originalSha,
			);
		} finally {
			forceRestore(builtTarget, original);
		}
	},
	60_000,
);

it.each([
	[
		"a normal run",
		[
			"--built",
			"--file",
			builtTarget,
			"--find",
			"mutation-built-marker",
			"--replace",
			"x",
			"--tests",
			target,
		],
	],
	["--restore", ["--restore", "--file", builtTarget]],
])(
	"%s refuses a journal whose file already equals the original",
	async (_name, args) => {
		// Rows 6 and 9: the journal is stale. Nothing is written, the journal stays
		// for explicit recovery, and the report names the hashes.
		const original = readFileSync(builtTarget);
		const originalSha = shaOf(builtTarget);
		await crashedRun(builtTarget);
		try {
			const mutatedSha = shaOf(builtTarget);
			writeFileSync(builtTarget, original);
			const result = await run([cli, ...args]);
			expect(result.code).toBe(1);
			expectReport(result.stderr, builtTarget, {
				original: originalSha,
				mutated: mutatedSha,
				current: originalSha,
			});
			expect(readFileSync(journalOf(builtTarget), "utf8")).toContain(
				mutatedSha,
			);
		} finally {
			forceRestore(builtTarget, original);
		}
	},
	60_000,
);

it("--restore with no journal is a no-op", async () => {
	// Table row 3. Drift this prevents: treating an absent journal as a refusal
	// would turn every clean --restore sweep into exit 1.
	const before = shaOf(builtTarget);
	const result = await run([cli, "--restore", "--file", builtTarget]);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("restored 0 mutation journal(s)");
	expect(shaOf(builtTarget)).toBe(before);
});

it("an unreadable journal is refused and nothing is written", async () => {
	// Row 13: a torn or hand-edited journal proves nothing about the file.
	const original = readFileSync(builtTarget);
	try {
		writeFileSync(journalOf(builtTarget), "{ torn");
		const before = shaOf(builtTarget);
		for (const args of [
			[cli, "--restore", "--file", builtTarget],
			builtArgs(builtTarget),
		]) {
			const result = await run(args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(journalOf(builtTarget));
			expect(result.stderr).toContain(before);
			expect(shaOf(builtTarget)).toBe(before);
		}
	} finally {
		forceRestore(builtTarget, original);
	}
}, 60_000);

it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
	"a run's own %s cleanup refuses to overwrite a legitimate edit",
	async (signal) => {
		// Row 12 on the signal path: the in-memory copy in round 2 was written
		// back over the edit.
		const original = readFileSync(builtTarget);
		const originalSha = shaOf(builtTarget);
		const live = await heldRun(builtTarget);
		try {
			const mutatedSha = shaOf(builtTarget);
			writeFileSync(builtTarget, "legitimate edit during the run\n");
			const currentSha = shaOf(builtTarget);
			live.child.kill(signal);
			const [, closeSignal] = await live.closed;
			expect(closeSignal).toBe(signal);
			expect(readFileSync(builtTarget, "utf8")).toBe(
				"legitimate edit during the run\n",
			);
			expectReport(live.stderr(), builtTarget, {
				original: originalSha,
				mutated: mutatedSha,
				current: currentSha,
			});
		} finally {
			live.child.kill("SIGKILL");
			await live.closed;
			forceRestore(builtTarget, original);
		}
	},
	60_000,
);

it("a finished run whose file was edited meanwhile reports ERROR, exits 4 and keeps the edit", async () => {
	// Row 12 on the normal path: the fixture test edits the file mid-run.
	const original = readFileSync(builtTarget);
	const originalSha = shaOf(builtTarget);
	try {
		const result = await run(builtArgs(builtTarget), {
			PI_LENS_MUTATION_EDIT: builtTarget,
		});
		expect(result.code).toBe(4);
		expect(result.stdout).toContain("ERROR");
		expect(result.stdout).toContain(journalOf(builtTarget));
		expect(readFileSync(builtTarget, "utf8")).toMatch(/legitimate edit\n$/);
		expect(readFileSync(journalOf(builtTarget), "utf8")).toContain(originalSha);
	} finally {
		forceRestore(builtTarget, original);
	}
}, 60_000);

it.each([
	["a regex literal", "mutation-regex-only-marker"],
	["a template literal's text", "mutation-template-only-marker"],
])(
	"refuses a needle that only %s contains, unless --allow-comment",
	async (_name, needle) => {
		// Round-2 MEDIUM: a regex-literal needle was accepted and reported SURVIVED.
		const before = digest();
		const refused = await run([
			cli,
			"--built",
			"--file",
			target,
			"--find",
			needle,
			"--replace",
			"changed",
			"--tests",
			target,
		]);
		expect(refused.code).toBe(1);
		expect(refused.stdout).toContain("comments/strings/regex literals");
		expect(digest()).toBe(before);
		const allowed = await run([
			cli,
			"--allow-comment",
			"--built",
			"--file",
			target,
			"--find",
			needle,
			"--replace",
			"changed",
			"--tests",
			target,
		]);
		expect(allowed.stdout).toContain("SURVIVED");
		expect(digest()).toBe(before);
	},
	60_000,
);

it.each([
	[
		"code after a regex literal holding a quote",
		"mutationAfterRegex = true",
		"mutationAfterRegex = false",
	],
	["code across a division", "8 / 2", "9 / 3"],
	[
		"code inside a template substitution",
		"mutationQuotient + 1",
		"mutationQuotient + 2",
	],
])(
	"accepts a needle in %s",
	async (_name, needle, replacement) => {
		// A scanner that treats a slash as a regex start, or a quote in a regex as a
		// string start, blanks real code and refuses a valid mutation.
		const before = digest();
		const result = await run([
			cli,
			"--built",
			"--file",
			target,
			"--find",
			needle,
			"--replace",
			replacement,
			"--tests",
			target,
		]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("SURVIVED");
		expect(digest()).toBe(before);
	},
	60_000,
);

it("--restore --file restores the compiled twin along with the source", async () => {
	// The twin carries its own journal, created before the build and completed
	// after it. Round 2 restored only the named file and left the twin's journal
	// to block the next run. A leaf client stands in for any built source: the
	// serialized lane runs nothing else against it.
	const source = "clients/freshness-cadence.ts";
	const twin = "clients/freshness-cadence.js";
	const sourceOriginal = readFileSync(source);
	const twinOriginal = readFileSync(twin);
	const child = spawn(
		process.execPath,
		[
			cli,
			"--file",
			source,
			"--find",
			"2_000",
			"--replace",
			"2_001",
			"--tests",
			target,
		],
		{
			cwd: root,
			env: { ...process.env, PI_LENS_MUTATION_RUN: "1" },
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	const stdoutSeen = new Promise((resolve) =>
		child.stdout?.once("data", resolve),
	);
	const closed = new Promise((resolve) => child.once("close", resolve));
	try {
		await stdoutSeen;
		child.kill("SIGKILL");
		await closed;
		expect(readFileSync(source).equals(sourceOriginal)).toBe(false);
		expect(readFileSync(twin).equals(twinOriginal)).toBe(false);
		const restore = await run([cli, "--restore", "--file", source]);
		expect(restore.code).toBe(0);
		expect(restore.stdout).toContain("restored 2 mutation journal(s)");
		expect(readFileSync(source).equals(sourceOriginal)).toBe(true);
		expect(readFileSync(twin).equals(twinOriginal)).toBe(true);
	} finally {
		child.kill("SIGKILL");
		await closed;
		forceRestore(source, sourceOriginal);
		forceRestore(twin, twinOriginal);
	}
}, 60_000);
