import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendProjectChange,
	getProjectChangeLogPath,
	readChangesSince,
	readLatestProjectSequence,
} from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("project change sequence", () => {
	it("bumps project and file sequences independently", () => {
		const runtime = new RuntimeCoordinator();
		const first = runtime.bumpFileSeq("src/a.ts");
		const second = runtime.bumpFileSeq("src/a.ts");
		const third = runtime.bumpFileSeq("src/b.ts");

		expect(first).toEqual({ projectSeq: 1, fileSeq: 1 });
		expect(second).toEqual({ projectSeq: 2, fileSeq: 2 });
		expect(third).toEqual({ projectSeq: 3, fileSeq: 1 });
		expect(runtime.projectSeq).toBe(3);
		expect(runtime.getFileSeq("src/a.ts")).toBe(2);
		expect(runtime.getFileSeq("src/b.ts")).toBe(1);
	});

	it("persists append-only changes and reads changes since a sequence", () => {
		const env = setupTestEnvironment("project-changes-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			const firstFile = path.join(cwd, "src", "a.ts");
			const secondFile = path.join(cwd, "src", "b.ts");

			appendProjectChange(cwd, {
				seq: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				sessionId: "s1",
				turnIndex: 1,
				source: "agent-edit",
				filePath: firstFile,
				fileSeq: 1,
				changedRange: { start: 3, end: 5 },
			});
			appendProjectChange(cwd, {
				seq: 2,
				timestamp: "2026-01-01T00:00:01.000Z",
				sessionId: "s1",
				turnIndex: 1,
				source: "format",
				filePath: firstFile,
				fileSeq: 2,
			});
			appendProjectChange(cwd, {
				seq: 3,
				timestamp: "2026-01-01T00:00:02.000Z",
				sessionId: "s2",
				turnIndex: 1,
				source: "agent-write",
				filePath: secondFile,
				fileSeq: 1,
			});

			expect(getProjectChangeLogPath(cwd)).toContain("change-log.jsonl");
			expect(readChangesSince(cwd, 1).map((entry) => entry.seq)).toEqual([
				2, 3,
			]);
			const latest = readLatestProjectSequence(cwd);
			expect(latest.projectSeq).toBe(3);
			expect(latest.fileSeqByPath.get(firstFile.replace(/\\/g, "/"))).toBe(2);
			expect(latest.fileSeqByPath.get(secondFile.replace(/\\/g, "/"))).toBe(1);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});
});
