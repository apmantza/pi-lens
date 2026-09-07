import { describe, expect, it, vi } from "vitest";
import { runKnip } from "../../scripts/lib/knip-runner.mjs";

function fakeSpawn(status: number | null, error?: Error) {
	return vi.fn().mockReturnValue({ status, error });
}

describe("runKnip (#2698 review rounds 2-3)", () => {
	it("purges, then spawns the resolved command, and propagates knip's exit code", () => {
		const purge = vi.fn().mockReturnValue(["clients/a.js"]);
		const resolveCommand = vi
			.fn()
			.mockReturnValue({ command: "node", args: ["bin/knip.js", "--x"] });
		const spawn = fakeSpawn(3);
		const log = vi.fn();

		const code = runKnip(["--x"], "/repo", {
			purge,
			resolveCommand,
			spawn,
			log,
			logError: vi.fn(),
		});

		expect(purge).toHaveBeenCalledWith("/repo");
		expect(spawn).toHaveBeenCalledWith(
			"node",
			["bin/knip.js", "--x"],
			expect.objectContaining({ cwd: "/repo" }),
		);
		expect(code).toBe(3);
	});

	// #2698 review F3: the pre-fix caller caught ANY purge failure (including
	// a real ENOBUFS from an unbounded git buffer), warned, and fell through
	// to spawning knip anyway — regenerating the false "unused files" report
	// this wrapper exists to prevent. This is the red-first proof that the
	// caller now honors scripts/lib/knip-sibling-purge.test.ts's "propagates
	// a git failure" contract instead of swallowing it.
	it("F3: aborts with a non-zero exit and never spawns knip when the purge throws", () => {
		const purge = vi.fn().mockImplementation(() => {
			throw new Error("git ls-files ENOBUFS");
		});
		const resolveCommand = vi.fn();
		const spawn = vi.fn();
		const logError = vi.fn();

		const code = runKnip(["--reporter", "json"], "/repo", {
			purge,
			resolveCommand,
			spawn,
			log: vi.fn(),
			logError,
			isCI: false,
		});

		expect(code).toBe(1);
		expect(spawn).not.toHaveBeenCalled();
		expect(resolveCommand).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining("git ls-files ENOBUFS"),
		);
	});

	it("F3: prints an ::error:: line under CI on a purge failure", () => {
		const purge = vi.fn().mockImplementation(() => {
			throw new Error("boom");
		});
		const logError = vi.fn();

		runKnip([], "/repo", {
			purge,
			resolveCommand: vi.fn(),
			spawn: vi.fn(),
			log: vi.fn(),
			logError,
			isCI: true,
		});

		expect(logError).toHaveBeenCalledWith(expect.stringMatching(/^::error::/));
	});

	// #2698 review round 3, R2-F1, red-first over the whole per-argv skip
	// table: round 2 listed `-v` (lowercase) as knip's short version flag,
	// but knip's real short flag is `-V` (capital) — `-v` is "Unknown
	// option" to knip itself (verified against the installed 6.34.0 binary).
	// `npm run knip -- -V` still purged under round 2's code. This table
	// covers every skip arg AND proves `-v` is no longer treated as one.
	it.each([
		["--help", 0],
		["-h", 0],
		["--version", 0],
		["-V", 0],
		// Not a recognized knip flag (knip itself rejects it) — must NOT be
		// treated as a version request, so the purge still runs.
		["-v", 1],
	])("F5/R2-F1: purge call count for %s is %i", (arg, purgeCallCount) => {
		const purge = vi.fn().mockReturnValue([]);
		const resolveCommand = vi
			.fn()
			.mockReturnValue({ command: "node", args: ["bin/knip.js", arg] });
		const spawn = fakeSpawn(0);

		const code = runKnip([arg], "/repo", {
			purge,
			resolveCommand,
			spawn,
			log: vi.fn(),
			logError: vi.fn(),
		});

		expect(purge).toHaveBeenCalledTimes(purgeCallCount);
		expect(spawn).toHaveBeenCalled();
		expect(code).toBe(0);
	});

	it("F5: prints the rebuild reminder only when files were actually purged", () => {
		const log = vi.fn();
		runKnip([], "/repo", {
			purge: vi.fn().mockReturnValue(["clients/a.js"]),
			resolveCommand: vi.fn().mockReturnValue({ command: "node", args: [] }),
			spawn: fakeSpawn(0),
			log,
			logError: vi.fn(),
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining('needs "npm run build"'),
		);
	});

	it("F5: does not print the rebuild reminder when nothing was purged", () => {
		const log = vi.fn();
		runKnip([], "/repo", {
			purge: vi.fn().mockReturnValue([]),
			resolveCommand: vi.fn().mockReturnValue({ command: "node", args: [] }),
			spawn: fakeSpawn(0),
			log,
			logError: vi.fn(),
		});
		expect(log).not.toHaveBeenCalledWith(
			expect.stringContaining('needs "npm run build"'),
		);
	});

	it("reports a failure to even start knip", () => {
		const code = runKnip([], "/repo", {
			purge: vi.fn().mockReturnValue([]),
			resolveCommand: vi.fn().mockReturnValue({ command: "node", args: [] }),
			spawn: fakeSpawn(null, new Error("ENOENT")),
			log: vi.fn(),
			logError: vi.fn(),
		});
		expect(code).toBe(1);
	});

	it("treats a signal-killed spawn (no numeric status) as a failure", () => {
		const code = runKnip([], "/repo", {
			purge: vi.fn().mockReturnValue([]),
			resolveCommand: vi.fn().mockReturnValue({ command: "node", args: [] }),
			spawn: fakeSpawn(null),
			log: vi.fn(),
			logError: vi.fn(),
		});
		expect(code).toBe(1);
	});
});
