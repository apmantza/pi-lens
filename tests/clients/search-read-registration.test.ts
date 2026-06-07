import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadGuard } from "../../clients/read-guard.js";
import {
	registerSearchReads,
	type SearchReadLocation,
} from "../../clients/search-read-registration.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));
vi.mock("../../clients/file-time.js", () => ({
	createFileTime: () => ({
		read: vi.fn(),
		hasChanged: vi.fn(() => false),
		assert: vi.fn(),
		get: vi.fn(),
	}),
	FileTimeError: class extends Error {},
}));

let tmp: string;
function fileWithLines(name: string, lines: number): string {
	const p = path.join(tmp, name);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(
		p,
		Array.from({ length: lines }, (_, i) => `line${i + 1}`).join("\n"),
	);
	const past = new Date(Date.now() - 3_600_000);
	fs.utimesSync(p, past, past);
	return p;
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-srr-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("registerSearchReads", () => {
	function spyGuard() {
		const calls: Array<{ effectiveOffset: number; effectiveLimit: number; filePath: string }> = [];
		return {
			calls,
			recordRead: (r: { effectiveOffset: number; effectiveLimit: number; filePath: string }) =>
				calls.push(r),
		};
	}

	it("records each shown range with a ±2 context margin (1-based)", () => {
		fileWithLines("a.ts", 100);
		const guard = spyGuard();
		const locs: SearchReadLocation[] = [{ file: "a.ts", startLine: 10, endLine: 12 }];
		const n = registerSearchReads(guard, locs, {
			projectRoot: tmp,
			turnIndex: 0,
			writeIndex: 0,
		});
		expect(n).toBe(1);
		// lines 10..12 ± 2 → 8..14 → offset 8, limit 7
		expect(guard.calls[0]).toMatchObject({ effectiveOffset: 8, effectiveLimit: 7 });
	});

	it("clamps the start at line 1", () => {
		fileWithLines("a.ts", 100);
		const guard = spyGuard();
		registerSearchReads(guard, [{ file: "a.ts", startLine: 1, endLine: 1 }], {
			projectRoot: tmp,
			turnIndex: 0,
			writeIndex: 0,
		});
		expect(guard.calls[0].effectiveOffset).toBe(1);
	});

	it("dedupes identical spans", () => {
		fileWithLines("a.ts", 100);
		const guard = spyGuard();
		registerSearchReads(
			guard,
			[
				{ file: "a.ts", startLine: 10, endLine: 10 },
				{ file: "a.ts", startLine: 10, endLine: 10 },
			],
			{ projectRoot: tmp, turnIndex: 0, writeIndex: 0 },
		);
		expect(guard.calls).toHaveLength(1);
	});

	it("skips non-existent and external/vendor files", () => {
		fileWithLines("node_modules/pkg/x.ts", 100);
		const guard = spyGuard();
		const n = registerSearchReads(
			guard,
			[
				{ file: "missing.ts", startLine: 5 },
				{ file: "node_modules/pkg/x.ts", startLine: 5 },
			],
			{ projectRoot: tmp, turnIndex: 0, writeIndex: 0 },
		);
		expect(n).toBe(0);
	});
});

describe("search reads → read-guard (end-to-end)", () => {
	it("unblocks edits to a revealed match (± margin) but still blocks far edits", () => {
		const guard = createReadGuard("s");
		const f = fileWithLines("a.ts", 100);
		registerSearchReads(guard, [{ file: f, startLine: 10, endLine: 12 }], {
			projectRoot: tmp,
			turnIndex: 0,
			writeIndex: 0,
		});
		expect(guard.checkEdit(f, [11, 11]).action).toBe("allow"); // inside match
		expect(guard.checkEdit(f, [8, 8]).action).toBe("allow"); // within ±2 margin
		expect(guard.checkEdit(f, [60, 60]).action).toBe("block"); // far outside
	});
});
