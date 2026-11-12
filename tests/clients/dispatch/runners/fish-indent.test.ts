import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn((..._args: unknown[]): Promise<Spawned> =>
	Promise.resolve({ error: null, status: 0, stdout: "", stderr: "" }),
);

vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

// Whether the mocked availability checker reports fish_indent present. A case
// flips it instead of re-mocking the module with vi.doMock, which would outlive
// the case (resetModules does not clear the mock registry, #2883) and, undone,
// would drop this hoisted mock too.
const availability = vi.hoisted(() => ({
	present: true,
	/** `fish`, which `fish --no-execute` needs, is a separate binary on PATH. */
	fish: true,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => {
			const present = () =>
				command === "fish" ? availability.fish : availability.present;
			return {
				isAvailable: () => present(),
				isAvailableAsync: async () => present(),
				getVerdict: () => ({
					outcome: "missing",
					cause: "not-found",
					elapsedMs: 0,
					latched: true,
					retryAtMs: 0,
				}),
				getCommand: () => (present() ? command : null),
			};
		},
	}),
);

type Spawned = {
	error: Error | null;
	status: number | null;
	stdout: string;
	stderr: string;
};
const OK: Spawned = { error: null, status: 0, stdout: "", stderr: "" };

/**
 * Answer the two argvs the runner spawns separately: `fish --no-execute` (the
 * syntax step) and `fish_indent --check`. A single canned answer for both made
 * a fish_indent line read as fish output and the other way round.
 */
function answer(fishNoExecute: Spawned, indentCheck: Spawned) {
	safeSpawnAsync.mockImplementation((...args: unknown[]) =>
		Promise.resolve(
			(args[1] as string[]).includes("--no-execute")
				? fishNoExecute
				: indentCheck,
		),
	);
}

const spawnedCommands = () =>
	safeSpawnAsync.mock.calls.map((call) => [call[0], ...(call[1] as string[])]);

function createFishCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "fish",
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("fish-indent runner", () => {
	beforeEach(() => {
		vi.resetModules();
		availability.present = true;
		availability.fish = true;
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation((..._args: unknown[]) =>
			Promise.resolve({ error: null, status: 0, stdout: "", stderr: "" }),
		);
	});

	it("appliesTo fish only", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/fish-indent.js")
		).default;
		expect(runner.appliesTo).toEqual(["fish"]);
	});

	it("returns succeeded with no diagnostics when file is already formatted", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "config.fish");
			fs.writeFileSync(filePath, "function greet\n    echo hello\nend\n");
			answer(OK, {
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("returns warning diagnostic when file needs formatting", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "config.fish");
			fs.writeFileSync(filePath, "function greet\necho hello\nend\n");
			answer(OK, {
				error: null,
				status: 1,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.rule).toBe("fish-indent-unformatted");
			expect(result.diagnostics[0]?.fixable).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: fish_indent 4.9.3 --check prints the file's own name on stderr
	// for a merely unformatted file, and the runner read any stderr line as a
	// syntax error (#4454). It hands fish_indent an absolute path and fish
	// prints it back as spelled, so the production stderr is the absolute name.
	it("treats the file's own name on stderr as an unformatted file, not a syntax error", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "config.fish");
			fs.writeFileSync(filePath, "if true\n        echo hi\nend\n");
			answer(OK, {
				error: null,
				status: 1,
				stdout: "",
				stderr: `${filePath}\n`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics.map((d) => [d.rule, d.semantic])).toEqual([
				["fish-indent-unformatted", "warning"],
			]);
		} finally {
			env.cleanup();
		}
	});

	// fish_indent 4.9.3's own bytes for a file it could not open: stderr that
	// does not name the file stays a blocking finding.
	it("keeps other stderr text blocking", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "gone.fish");
			fs.writeFileSync(filePath, "echo hi\n");
			answer(OK, {
				error: null,
				status: 1,
				stdout: "",
				stderr: `Opening "${filePath}" failed: No such file or directory (os error 2)\n`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.rule).toBe("fish-indent-parse-error");
		} finally {
			env.cleanup();
		}
	});

	it("returns blocking error diagnostic on parse failure (stderr present)", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "broken.fish");
			fs.writeFileSync(filePath, "function (\n");
			answer(OK, {
				error: null,
				status: 1,
				stdout: "",
				stderr: "broken.fish (line 1): Expected a command name\n",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.rule).toBe("fish-indent-parse-error");
			expect(result.diagnostics[0]?.line).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: fish_indent --check exits 0 on an unterminated quote and on a
	// missing `end` in a formatted file, so a real syntax error reached the agent
	// as nothing (#4454). The stderr below is fish 4.9.3's own `--no-execute`
	// bytes; the file is formatted, so fish_indent has nothing to say.
	it("reports a syntax error from fish --no-execute as blocking, with its line", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "stray.fish");
			fs.writeFileSync(filePath, "echo hello\nend\n");
			answer(
				{
					error: null,
					status: 127,
					stdout: "",
					stderr: `${filePath} (line 2): 'end' outside of a block\nend\n^~^\nwarning: Error while reading file ${filePath}\n`,
				},
				OK,
			);

			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(
				result.diagnostics.map((d) => [d.rule, d.semantic, d.filePath, d.line]),
			).toEqual([["fish-syntax-error", "blocking", filePath, 2]]);
			// The syntax step never executes: it asks for a parse only, and a
			// file that does not parse is not formatted either.
			expect(spawnedCommands()).toEqual([
				["fish", "--no-config", "--no-execute", filePath],
			]);
		} finally {
			env.cleanup();
		}
	});

	// A valid file costs both spawns, and fish --no-execute comes first.
	it("asks fish --no-execute before fish_indent for a valid file", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "ok.fish");
			fs.writeFileSync(filePath, "echo hello\n");
			answer(OK, OK);
			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			await runner.run(createFishCtx(filePath, env.tmpDir) as never);
			expect(spawnedCommands()).toEqual([
				["fish", "--no-config", "--no-execute", filePath],
				["fish_indent", "--check", filePath],
			]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: a header naming some other file is not this file's finding
	// (shape 32, reported-path attribution).
	it("ignores a syntax header that names another file", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "ok.fish");
			fs.writeFileSync(filePath, "echo hello\n");
			answer(
				{
					error: null,
					status: 127,
					stdout: "",
					stderr: `${path.join(env.tmpDir, "other.fish")} (line 3): Missing end\n`,
				},
				OK,
			);
			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			expect(result.diagnostics).toEqual([]);
			expect(result.status).toBe("succeeded");
		} finally {
			env.cleanup();
		}
	});

	// fish 4.9.3's own bytes for a file it could not read: no `(line N)` header,
	// so the syntax step decides nothing, leaves one bounded row, and the I/O
	// error is still reported (blocking) by fish_indent.
	it("falls through to fish_indent when fish --no-execute names no line", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "gone.fish");
			fs.writeFileSync(filePath, "echo hi\n");
			answer(
				{
					error: null,
					status: 127,
					stdout: "",
					stderr: `error: Error reading script file '${filePath}':\nNo such file or directory (os error 2)\n`,
				},
				{
					error: null,
					status: 1,
					stdout: "",
					stderr: `Opening "${filePath}" failed: No such file or directory (os error 2)\n`,
				},
			);
			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			expect(result.diagnostics[0]?.rule).toBe("fish-indent-parse-error");
			const ledger = await import("../../../../clients/degradation-ledger.js");
			expect(
				ledger
					.getDegradationSummary()
					.find((g) => g.kind === "runner-parsed-nothing")?.latestReasons[0]
					?.subject,
			).toBe("fish-syntax-check");
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: a missing `fish` next to a present `fish_indent` must not turn
	// into a silent pass. The format check still runs, and the gap is one row
	// per session however many files follow.
	it("degrades visibly, once per session, when fish is missing but fish_indent is present", async () => {
		availability.fish = false;
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "config.fish");
			fs.writeFileSync(filePath, "if true\n        echo hi\nend\n");
			answer(OK, {
				error: null,
				status: 1,
				stdout: "",
				stderr: `${filePath}\n`,
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const ledger = await import("../../../../clients/degradation-ledger.js");
			ledger.resetDegradationLedger();
			const first = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			await runner.run(createFishCtx(filePath, env.tmpDir) as never);

			expect(first.diagnostics.map((d) => d.rule)).toEqual([
				"fish-indent-unformatted",
			]);
			expect(spawnedCommands().map((c) => c[0])).toEqual([
				"fish_indent",
				"fish_indent",
			]);
			const group = ledger
				.getDegradationSummary()
				.find((g) => g.kind === "fish-syntax-check-unavailable");
			expect(group?.count).toBe(1);
			expect(group?.latestReasons[0]?.subject).toBe("fish");
		} finally {
			env.cleanup();
		}
	});

	// A fish that spawns but never answers (timeout, killed) is the same gap.
	it("degrades visibly when fish --no-execute does not complete", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "config.fish");
			fs.writeFileSync(filePath, "echo hi\n");
			answer(
				{
					error: new Error("Process timed out after 10000ms"),
					status: null,
					stdout: "",
					stderr: "",
				},
				OK,
			);
			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const ledger = await import("../../../../clients/degradation-ledger.js");
			ledger.resetDegradationLedger();
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			expect(result.status).toBe("succeeded");
			expect(
				ledger
					.getDegradationSummary()
					.find((g) => g.kind === "runner-empty-result")?.latestReasons[0]
					?.subject,
			).toBe("fish-syntax-check");
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: fish 3.3.1 (Ubuntu 22.04) prints the header as `~` + the
	// absolute path (`~/home/u/x.fish (line 2): ...`), so the attribution
	// dropped every syntax error and left only a runner-parsed-nothing row.
	it("reports a syntax error whose header fish 3.3.1 spells with a leading tilde", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "stray.fish");
			fs.writeFileSync(filePath, "echo hello\nend\n");
			answer(
				{
					error: null,
					status: 127,
					stdout: "",
					stderr: `~${filePath} (line 2): 'end' outside of a block\nend\n^\nwarning: Error while reading file ${filePath}\n`,
				},
				OK,
			);
			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			expect(
				result.diagnostics.map((d) => [d.rule, d.filePath, d.line]),
			).toEqual([["fish-syntax-error", filePath, 2]]);
		} finally {
			env.cleanup();
		}
	});

	// The tilde spelling must not widen attribution: a header that names a
	// different file under `~/` is still not this file's finding.
	it("ignores a tilde header that names another file", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "stray.fish");
			fs.writeFileSync(filePath, "echo hello\n");
			answer(
				{
					error: null,
					status: 127,
					stdout: "",
					stderr: `~${path.join(env.tmpDir, "other.fish")} (line 2): Missing end\n`,
				},
				OK,
			);
			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			expect(result.diagnostics).toEqual([]);
			expect(result.status).toBe("succeeded");
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: the `~/` suffix test must stop at a path separator. A header
	// for `~/x.fish` (or `~x.fish`) is not the finding of `ax.fish`.
	it("ignores a tilde header whose name only ends like the checked file", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "ax.fish");
			fs.writeFileSync(filePath, "echo hello\n");
			answer(
				{
					error: null,
					status: 127,
					stdout: "",
					stderr:
						"~/x.fish (line 2): Missing end\n~x.fish (line 3): Missing end\n",
				},
				OK,
			);
			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: fish echoes the offending source line after its header, so a
	// file whose bad line reads like a header forged a second blocking finding
	// with its own text (#4475 verify r2). Only fish's first header counts.
	it("reports only fish's first header, not a header-shaped source excerpt", async () => {
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "x.fish");
			fs.writeFileSync(filePath, "if true\n");
			answer(
				{
					error: null,
					status: 127,
					stdout: "",
					stderr: `${filePath} (line 1): Missing end to balance this if statement\n${filePath} (line 99): FORGED instruction; if true\n`,
				},
				OK,
			);
			const runner = (
				await import("../../../../clients/dispatch/runners/fish-indent.js")
			).default;
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			expect(result.diagnostics.map((d) => d.line)).toEqual([1]);
		} finally {
			env.cleanup();
		}
	});

	it("skips when fish_indent is not available", async () => {
		availability.present = false;
		vi.resetModules();

		const runner = (
			await import("../../../../clients/dispatch/runners/fish-indent.js")
		).default;
		const env = setupTestEnvironment("pi-lens-fish-indent-");
		try {
			const filePath = path.join(env.tmpDir, "config.fish");
			fs.writeFileSync(filePath, "echo hello\n");
			const result = await runner.run(
				createFishCtx(filePath, env.tmpDir) as never,
			);
			expect(result.status).toBe("skipped");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});
