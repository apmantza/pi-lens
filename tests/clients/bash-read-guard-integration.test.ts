/**
 * End-to-end: the bash command parser (#168) feeds the read-guard correctly.
 *
 * The parser is unit-tested in bash-file-access.test.ts and the guard's range
 * coverage in read-guard.test.ts; this proves the two compose the way index.ts /
 * runtime-tool-result.ts wire them — i.e. a ReadSpan's {offset, limit} maps onto
 * recordRead's {effectiveOffset, effectiveLimit} so the guard's range enforcement
 * actually unblocks (and still blocks) the right edits.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractReadPathsFromCommand,
	extractWrittenPathsFromCommand,
} from "../../clients/bash-file-access.js";
import { createReadGuard } from "../../clients/read-guard.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

// Mock FileTime so range coverage (not mtime) decides the verdict — same as
// read-guard.test.ts.
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
	fs.writeFileSync(
		p,
		Array.from({ length: lines }, (_, i) => `line${i + 1}`).join("\n"),
	);
	// Backdate mtime to before the session so the guard's "modified this session"
	// mtime fallback doesn't mask the block path (in production, edited files
	// predate the session; here they'd otherwise be brand-new).
	const past = new Date(Date.now() - 3_600_000);
	fs.utimesSync(p, past, past);
	return p;
}

/** Mirror index.ts: register reads (with their range) + writes from a command. */
function applyBashAccess(
	guard: ReturnType<typeof createReadGuard>,
	command: string,
	cwd: string,
) {
	for (const span of extractReadPathsFromCommand(command, cwd)) {
		guard.recordRead({
			filePath: span.filePath,
			requestedOffset: span.offset,
			requestedLimit: span.limit,
			effectiveOffset: span.offset,
			effectiveLimit: span.limit,
			expandedByLsp: false,
			turnIndex: 0,
			writeIndex: 0,
			timestamp: Date.now(),
		});
	}
	for (const wp of extractWrittenPathsFromCommand(command, cwd)) {
		guard.noteCreatedFile(wp, 0, 0);
		guard.recordWritten(wp);
	}
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-brgi-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bash file access → read-guard", () => {
	it("cat (full read) unblocks an edit anywhere in the file", () => {
		const guard = createReadGuard("s");
		const f = fileWithLines("a.ts", 100);
		applyBashAccess(guard, `cat ${f}`, tmp);
		expect(guard.checkEdit(f, [80, 82]).action).toBe("allow");
	});

	it("head -10 unblocks edits in 1..10 but still blocks edits far outside", () => {
		const guard = createReadGuard("s");
		const f = fileWithLines("a.ts", 100);
		applyBashAccess(guard, `head -10 ${f}`, tmp);
		expect(guard.checkEdit(f, [5, 5]).action).toBe("allow");
		expect(guard.checkEdit(f, [60, 60]).action).toBe("block");
	});

	it("a bash write (echo > file) unblocks a later edit (agent authored it)", () => {
		const guard = createReadGuard("s");
		const f = fileWithLines("a.ts", 100);
		applyBashAccess(guard, `echo "x" > ${f}`, tmp);
		expect(guard.checkEdit(f, [40, 40]).action).toBe("allow");
	});

	it("ls (no content) does NOT unblock an edit", () => {
		const guard = createReadGuard("s");
		const f = fileWithLines("a.ts", 100);
		applyBashAccess(guard, `ls -l ${f}`, tmp);
		expect(guard.checkEdit(f, [40, 40]).action).toBe("block");
	});

	it("grep (scattered matches) does NOT unblock an edit", () => {
		const guard = createReadGuard("s");
		const f = fileWithLines("a.ts", 100);
		applyBashAccess(guard, `grep -n "foo" ${f}`, tmp);
		expect(guard.checkEdit(f, [40, 40]).action).toBe("block");
	});
});
