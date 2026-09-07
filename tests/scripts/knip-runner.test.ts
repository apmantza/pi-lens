import { describe, expect, it, vi } from "vitest";
import { runKnip } from "../../scripts/lib/knip-runner.mjs";

function fakeSpawn(status: number | null, error?: Error) {
	return vi.fn().mockReturnValue({ status, error });
}

describe("runKnip (#2698 review round 2)", () => {
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

	it("F5: skips the purge entirely for --help", () => {
		const purge = vi.fn();
		const resolveCommand = vi
			.fn()
			.mockReturnValue({ command: "node", args: ["bin/knip.js", "--help"] });
		const spawn = fakeSpawn(0);

		const code = runKnip(["--help"], "/repo", {
			purge,
			resolveCommand,
			spawn,
			log: vi.fn(),
			logError: vi.fn(),
		});

		expect(purge).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalled();
		expect(code).toBe(0);
	});

	it("F5: skips the purge entirely for --version", () => {
		const purge = vi.fn();
		runKnip(["--version"], "/repo", {
			purge,
			resolveCommand: vi.fn().mockReturnValue({ command: "node", args: [] }),
			spawn: fakeSpawn(0),
			log: vi.fn(),
			logError: vi.fn(),
		});
		expect(purge).not.toHaveBeenCalled();
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
