/**
 * One mutation seam (#2000 phase 1): RuntimeCoordinator.recordProjectMutation
 * is the single bump + attributed-receipt + change-log entry point. These
 * tests pin the seam contract: receipt attribution, getMutationsSince
 * filtering, ring bounding with a dropped-count, session reset, and
 * append-failure isolation. Red-first property for the consolidation: any
 * producer that hand-rolls `bumpFileSeq` + `appendProjectChange` instead of
 * calling the seam records NO receipt, which these assertions detect.
 */
import { describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { getProjectChangeLogPath } from "../../clients/project-changes.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

/** Derive the receipt key exactly as the seam does - never hardcode it. */
const keyOf = (p: string) => normalizeMapKey(path.resolve(p));

function makeRuntime(): RuntimeCoordinator {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = "/proj";
	return runtime;
}

describe("recordProjectMutation — the one mutation seam", () => {
	it("bumps seq and records an attributed receipt", () => {
		const runtime = makeRuntime();
		const { projectSeq } = runtime.recordProjectMutation({
			filePath: "/proj/src/a.ts",
			source: "agent-edit",
		});
		expect(projectSeq).toBe(1);
		const receipts = runtime.getMutationsSince(0);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].source).toBe("agent-edit");
		expect(receipts[0].seq).toBe(projectSeq);
		expect(receipts[0].turnIndex).toBe(runtime.turnIndex);
		expect(typeof receipts[0].ts).toBe("number");
	});

	it("normalizes receipt paths to the same form getFilesChangedSince uses", () => {
		const runtime = makeRuntime();
		runtime.recordProjectMutation({
			filePath: "/proj/src/./a.ts",
			source: "agent-write",
		});
		const changed = runtime.getFilesChangedSince(0);
		const receipts = runtime.getMutationsSince(0);
		// The receipt key must be derivable from the changed-set key — a
		// consumer joining the two views must not need a third normalizer.
		expect(changed).toContain(receipts[0].filePath);
	});

	it("getMutationsSince filters strictly after seq", () => {
		const runtime = makeRuntime();
		runtime.recordProjectMutation({ filePath: "/p/a.ts", source: "format" });
		const first = runtime.recordProjectMutation({
			filePath: "/p/b.ts",
			source: "autofix",
		}).projectSeq;
		runtime.recordProjectMutation({ filePath: "/p/c.ts", source: "format" });
		const since = runtime.getMutationsSince(first);
		expect(since.map((r) => r.filePath)).toEqual([keyOf("/p/c.ts")]);
	});

	it("ring cap evicts oldest and counts drops — never silently incomplete", () => {
		const runtime = makeRuntime();
		for (let i = 0; i < 600; i++) {
			runtime.recordProjectMutation({
				filePath: `/p/f${i}.ts`,
				source: "agent-write",
			});
		}
		expect(runtime.droppedMutationReceiptCount).toBeGreaterThan(0);
		const receipts = runtime.getMutationsSince(0);
		expect(receipts.length).toBeLessThanOrEqual(512);
		// The OLDEST receipts are what dropped (insertion-order eviction).
		expect(receipts.some((r) => r.filePath === keyOf("/p/f0.ts"))).toBe(false);
		expect(receipts.at(-1)?.filePath).toBe(keyOf("/p/f599.ts"));
	});

	it("clears receipts on resetForSession alongside the seq store", () => {
		const runtime = makeRuntime();
		runtime.recordProjectMutation({ filePath: "/p/a.ts", source: "format" });
		runtime.resetForSession();
		expect(runtime.getMutationsSince(0)).toEqual([]);
		expect(runtime.droppedMutationReceiptCount).toBe(0);
		expect(runtime.getFilesChangedSince(0)).toEqual([]);
	});

	it("change-log append failure is isolated: receipt survives, error routes to callback", () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mutation-seam-fail-"),
		);
		try {
			const runtime = makeRuntime();
			const onAppendError = vi.fn();
			// REAL filesystem fault, no mocks: pre-create the project data dir
			// as a regular FILE so the append's recursive mkdir throws EEXIST.
			const logPath = getProjectChangeLogPath(cwd);
			// REAL filesystem fault, no mocks: pre-create the project DATA DIR
			// itself (the slug directory) as a regular FILE, so the append's
			// recursive mkdir throws EEXIST.
			const projectDataDir = path.dirname(logPath);
			fs.mkdirSync(path.dirname(projectDataDir), { recursive: true });
			fs.writeFileSync(projectDataDir, "not a directory", "utf8");
			runtime.recordProjectMutation({
				filePath: "/p/a.ts",
				source: "agent-write",
				cwd,
				onAppendError,
			});
			// The dispatch path must survive AND the failure must be observable.
			expect(runtime.getMutationsSince(0)).toHaveLength(1);
			expect(onAppendError).toHaveBeenCalledTimes(1);
			expect(onAppendError.mock.calls[0][0]).toBeInstanceOf(Error);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("no cwd means no change-log attempt but full receipt bookkeeping", () => {
		const runtime = makeRuntime();
		const { projectSeq, fileSeq } = runtime.recordProjectMutation({
			filePath: "/p/a.ts",
			source: "lsp-edit",
		});
		expect(projectSeq).toBe(1);
		expect(fileSeq).toBe(1);
		expect(runtime.getMutationsSince(0)).toHaveLength(1);
	});

	it("change-log happy path writes the real JSONL sink with matching attribution", () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mutation-seam-"),
		);
		try {
			const runtime = makeRuntime();
			const { projectSeq } = runtime.recordProjectMutation({
				filePath: path.join(cwd, "src", "a.ts"),
				source: "agent-edit",
				cwd,
			});
			// Assert against the REAL durable sink (the same bytes a smell
			// analyzer reads), not a logger mock (#1742 direction).
			const logPath = getProjectChangeLogPath(cwd);
			expect(fs.existsSync(logPath)).toBe(true);
			const lines = fs
				.readFileSync(logPath, "utf8")
				.split("\n")
				.filter((l) => l.trim());
			expect(lines).toHaveLength(1);
			const entry = JSON.parse(lines[0]) as {
				seq: number;
				source: string;
				filePath: string;
			};
			expect(entry.seq).toBe(projectSeq);
			expect(entry.source).toBe("agent-edit");
			expect(path.resolve(entry.filePath)).toBe(
				path.resolve(path.join(cwd, "src", "a.ts")),
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
