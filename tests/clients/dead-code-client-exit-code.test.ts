/**
 * #1736 class-sweep: vulture's runAnalyze() must never read a silent
 * nonzero-exit failure as "No dead code found". A separate file from
 * dead-code-client.test.ts (which spawns the REAL vulture binary) because
 * this suite mocks safe-spawn.js at the module level and the two must not
 * share a test process.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type DeadCodeResult,
	PythonDeadCodeClient,
} from "../../clients/dead-code-client.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: vi.fn(async () => ({
		error: null,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

describe("PythonDeadCodeClient.runAnalyze exit-code discipline (#1736 sweep)", () => {
	it("reports a nonzero exit with empty stdout AND empty stderr as errored, never clean", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-vulture-silent-crash-",
		);
		try {
			const client = new PythonDeadCodeClient(false) as unknown as {
				resolved: { cmd: string; prefix: string[] } | null;
				runAnalyze: (root: string) => Promise<{
					success: boolean;
					summary: string;
					unusedExports: unknown[];
				}>;
			};
			client.resolved = { cmd: "vulture", prefix: [] };

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: "",
				stderr: "",
			} as never);

			const result = await client.runAnalyze(tmpDir);

			expect(result.success).toBe(false);
			expect(result.summary).not.toMatch(/no dead code found/i);
			expect(result.unusedExports).toHaveLength(0);
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("keeps the traceback exception in the summary and degradation reason", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-vulture-traceback-",
		);
		try {
			const client = new PythonDeadCodeClient(false) as unknown as {
				runAnalyze: (root: string) => Promise<DeadCodeResult>;
			};
			// Captured from vulture 2.16 reading a directory named example.py;
			// paths shortened. The first line alone hid the actual failure.
			const stderr = [
				"Traceback (most recent call last):",
				'  File "/tools/bin/vulture", line 10, in <module>',
				"    sys.exit(main())",
				"             ^^^^^^",
				'  File "/tools/vulture/core.py", line 676, in main',
				'    vulture.scavenge(config["paths"], exclude=config["exclude"])',
				'  File "/tools/vulture/core.py", line 287, in scavenge',
				"    module_string = utils.read_file(module)",
				"                    ^^^^^^^^^^^^^^^^^^^^^^^",
				'  File "/tools/vulture/utils.py", line 108, in read_file',
				"    with tokenize.open(filename) as f:",
				"         ^^^^^^^^^^^^^^^^^^^^^^^",
				'  File "/tools/python3.12/tokenize.py", line 457, in open',
				"    buffer = _builtin_open(filename, 'rb')",
				"             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
				"IsADirectoryError: [Errno 21] Is a directory: '/project/example.py'",
				"",
				"",
			].join("\r\n");
			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				status: 1,
				stdout: "",
				stderr,
			});

			const result = await client.runAnalyze(tmpDir);

			expect(result.success).toBe(false);
			expect(result.summary).toBe(
				"vulture error: IsADirectoryError: [Errno 21] Is a directory: '/project/example.py'",
			);
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "runner-empty-result",
				)?.latestReasons,
			).toContainEqual({
				subject: "vulture",
				reason: expect.stringContaining(
					"vulture exited 1 with no output: IsADirectoryError: [Errno 21] Is a directory: '/project/example.py'",
				),
			});
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("still reports a genuine clean run (exit 0, empty stdout) as clean", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-vulture-genuine-clean-",
		);
		try {
			const client = new PythonDeadCodeClient(false) as unknown as {
				resolved: { cmd: string; prefix: string[] } | null;
				runAnalyze: (
					root: string,
				) => Promise<{ success: boolean; summary: string }>;
			};
			client.resolved = { cmd: "vulture", prefix: [] };

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			} as never);

			const result = await client.runAnalyze(tmpDir);

			expect(result.success).toBe(true);
			expect(result.summary).toMatch(/no dead code found/i);
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});
});
