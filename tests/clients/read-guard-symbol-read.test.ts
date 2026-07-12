/**
 * ReadGuard.recordSymbolRead — the readSymbol read-substitute tie-in (#245).
 *
 * readSymbol returns a symbol's verbatim body, so recording it must grant
 * edit-coverage for that symbol's range (like a TS/LSP-expanded read) WITHOUT
 * over-granting to lines outside it. Module outlines deliberately get no such
 * tie-in (shape, not body) — there is no recordModuleReport equivalent.
 */

import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createReadGuard } from "../../clients/read-guard.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

// FileTime always "unchanged" so these tests isolate read-coverage, not staleness.
vi.mock("../../clients/file-time.js", () => ({
	createFileTime: () => ({
		read: vi.fn(),
		hasChanged: vi.fn(() => false),
		assert: vi.fn(),
		get: vi.fn(),
	}),
}));

function setup() {
	const env = setupTestEnvironment("pi-lens-guard-symbolread-");
	const file = createTempFile(
		env.tmpDir,
		"sample.ts",
		[
			"const noise = 1;", // 1
			"export function target(n: number): number {", // 2
			"  const doubled = n * 2;", // 3
			"  return doubled;", // 4
			"}", // 5
			"// filler", // 6
			"// filler", // 7
			"// filler", // 8
			"// filler", // 9
			"// filler", // 10
			"const tail = 2;", // 11
			"// end", // 12
		].join("\n") + "\n",
	);
	// Backdate the fixture so the guard treats it as pre-existing code, not
	// session-authored. The zero-read branch calls wasWrittenThisSession, which
	// compares the file's mtime to the guard's session-start time; a fixture
	// written in the same instant the guard is constructed reads as
	// authored-this-session on fast / fine-grained-mtime runners (Linux CI) and
	// wrongly skips the zero-read block. Real source files predate the session.
	const past = new Date(Date.now() - 3_600_000);
	fs.utimesSync(file, past, past);
	const symbol = {
		name: "target",
		kind: "function",
		startLine: 2,
		endLine: 5,
	};
	return { env, file, symbol };
}

describe("ReadGuard.recordSymbolRead (#245 tie-in)", () => {
	it("covers an edit inside the symbol after recording the symbol read", () => {
		const { env, file, symbol } = setup();
		try {
			const guard = createReadGuard("s-inside");
			guard.recordSymbolRead(file, symbol, 0, 0);
			expect(guard.checkEdit(file, [3, 4]).action).toBe("allow");
		} finally {
			env.cleanup();
		}
	});

	it("blocks the same in-symbol edit when nothing was read (control)", () => {
		const { env, file } = setup();
		try {
			const guard = createReadGuard("s-control");
			const verdict = guard.checkEdit(file, [3, 4]);
			expect(verdict.action).toBe("block");
			expect(verdict.reason).toContain("Edit without read");
		} finally {
			env.cleanup();
		}
	});

	it("does NOT over-grant: an edit well outside the symbol range is still blocked", () => {
		const { env, file, symbol } = setup();
		try {
			const guard = createReadGuard("s-outside");
			guard.recordSymbolRead(file, symbol, 0, 0);
			const verdict = guard.checkEdit(file, [11, 11]); // `const tail = 2;`
			expect(verdict.action).toBe("block");
			expect(verdict.reason).toContain("Edit outside read range");
		} finally {
			env.cleanup();
		}
	});

	it("covers an edit to the attached doc comment when the recorded range includes it (#523)", () => {
		// readSymbol (#523 item 1) extends the recorded range to the doc comment's
		// start line when one is attached — this test drives the guard directly
		// with that extended range (comment lines 1-3, declaration lines 4-6) to
		// prove editing ONLY the comment is not a zero_read / out-of-range block.
		const env = setupTestEnvironment("pi-lens-guard-symbolread-doc-");
		const file = createTempFile(
			env.tmpDir,
			"sample.ts",
			[
				"/**", // 1
				" * Whether agent nudges are enabled for this session.", // 2
				" */", // 3
				"export function isAgentNudgeEnabled(): boolean {", // 4
				"  return true;", // 5
				"}", // 6
			].join("\n") + "\n",
		);
		const past = new Date(Date.now() - 3_600_000);
		fs.utimesSync(file, past, past);
		try {
			const guard = createReadGuard("s-doc-comment");
			guard.recordSymbolRead(
				file,
				{ name: "isAgentNudgeEnabled", kind: "function", startLine: 1, endLine: 6 },
				0,
				0,
			);
			// Edit touches ONLY the comment line (2), not the declaration.
			const verdict = guard.checkEdit(file, [2, 2]);
			expect(verdict.action).toBe("allow");
		} finally {
			env.cleanup();
		}
	});

	it("records line hashes so a drifted in-symbol edit is snapshot-blocked", () => {
		const { env, file, symbol } = setup();
		try {
			const guard = createReadGuard("s-drift");
			guard.recordSymbolRead(file, symbol, 0, 0);
			// Rewrite the body so lines 3-4 no longer match the recorded hashes.
			fs.writeFileSync(
				file,
				[
					"const noise = 1;",
					"export function target(n: number): number {",
					"  const tripled = n * 3;",
					"  return tripled;",
					"}",
					"const tail = 2;",
				].join("\n") + "\n",
			);
			const verdict = guard.checkEdit(file, [3, 4]);
			expect(verdict.action).toBe("block");
		} finally {
			env.cleanup();
		}
	});
});
