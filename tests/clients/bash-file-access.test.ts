import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractGrepSearchReadsFromOutput,
	extractReadPathsFromCommand,
	extractWrittenPathsFromCommand,
	type ReadSpan,
} from "../../clients/bash-file-access.js";

let tmp: string;

/** Write a file with `lines` newline-separated lines; returns its absolute path. */
function touchLines(name: string, lines = 1): string {
	const p = path.join(tmp, name);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(
		p,
		Array.from({ length: lines }, (_, i) => `line${i + 1}`).join("\n"),
	);
	return p;
}

/** An absolute path inside tmp that does NOT exist yet (for write targets). */
function pathIn(name: string): string {
	return path.join(tmp, name);
}

function readSpan(result: ReadSpan[], file: string): ReadSpan | undefined {
	return result.find((s) => s.filePath === file);
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-bfa-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

// ── reads: full-file viewers ────────────────────────────────────────────────

describe("extractReadPathsFromCommand — full-file viewers", () => {
	it("cat FILE registers the whole file", () => {
		const f = touchLines("a.ts", 5);
		expect(readSpan(extractReadPathsFromCommand(`cat ${f}`, tmp), f)).toEqual({
			filePath: f,
			offset: 1,
			limit: 5,
		});
	});

	it("less / more / bat / nl also register full reads", () => {
		const f = touchLines("a.ts", 3);
		for (const verb of ["less", "more", "bat", "nl"]) {
			expect(
				readSpan(extractReadPathsFromCommand(`${verb} ${f}`, tmp), f),
				verb,
			).toEqual({ filePath: f, offset: 1, limit: 3 });
		}
	});

	it("resolves a relative path against cwd", () => {
		const f = touchLines("sub/b.ts", 2);
		const rel = path.relative(tmp, f);
		expect(readSpan(extractReadPathsFromCommand(`cat ${rel}`, tmp), f)).toEqual(
			{
				filePath: f,
				offset: 1,
				limit: 2,
			},
		);
	});

	it("registers each file across && / ; segments and dedupes", () => {
		const a = touchLines("a.ts", 4);
		const b = touchLines("b.ts", 6);
		const r = extractReadPathsFromCommand(
			`cat ${a} && cat ${b} ; cat ${a}`,
			tmp,
		);
		expect(readSpan(r, a)).toEqual({ filePath: a, offset: 1, limit: 4 });
		expect(readSpan(r, b)).toEqual({ filePath: b, offset: 1, limit: 6 });
		expect(r.filter((s) => s.filePath === a)).toHaveLength(1);
	});
});

// ── reads: partial viewers register the EXACT range shown ───────────────────

describe("extractReadPathsFromCommand — partial viewers", () => {
	it("head -n N → lines 1..N", () => {
		const f = touchLines("a.ts", 100);
		expect(
			readSpan(extractReadPathsFromCommand(`head -n 20 ${f}`, tmp), f),
		).toEqual({ filePath: f, offset: 1, limit: 20 });
	});

	it("head -N shorthand → lines 1..N", () => {
		const f = touchLines("a.ts", 100);
		expect(
			readSpan(extractReadPathsFromCommand(`head -20 ${f}`, tmp), f),
		).toEqual({ filePath: f, offset: 1, limit: 20 });
	});

	it("head clamps when N exceeds the file length", () => {
		const f = touchLines("a.ts", 5);
		expect(
			readSpan(extractReadPathsFromCommand(`head -20 ${f}`, tmp), f),
		).toEqual({ filePath: f, offset: 1, limit: 5 });
	});

	it("tail -n N → the LAST N lines", () => {
		const f = touchLines("a.ts", 100);
		expect(
			readSpan(extractReadPathsFromCommand(`tail -n 10 ${f}`, tmp), f),
		).toEqual({ filePath: f, offset: 91, limit: 10 });
	});

	it("sed -n 'A,Bp' → lines A..B", () => {
		const f = touchLines("a.ts", 100);
		expect(
			readSpan(extractReadPathsFromCommand(`sed -n '2,40p' ${f}`, tmp), f),
		).toEqual({ filePath: f, offset: 2, limit: 39 });
	});
});

// ── grep output: scattered search results become searchReads at tool_result ─

describe("extractGrepSearchReadsFromOutput", () => {
	it("parses multi-file grep -n output as file:line matches", () => {
		const a = touchLines("a.ts", 20);
		const b = touchLines("sub/b.ts", 30);
		const relB = path.relative(tmp, b);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n foo ${a} ${relB}`,
				tmp,
				`${a}:7:foo\n${relB}:12:foo`,
			),
		).toEqual([
			{ file: a, startLine: 7, endLine: 7 },
			{ file: b, startLine: 12, endLine: 12 },
		]);
	});

	it("parses single-file grep -n output using the command file", () => {
		const a = touchLines("a.ts", 20);
		expect(
			extractGrepSearchReadsFromOutput(`grep -n foo ${a}`, tmp, "9:foo here"),
		).toEqual([{ file: a, startLine: 9, endLine: 9 }]);
	});

	it("recognizes combined grep flags that include line numbers", () => {
		const a = touchLines("a.ts", 20);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -Rns foo ${a}`,
				tmp,
				`${a}:11:foo here`,
			),
		).toEqual([{ file: a, startLine: 11, endLine: 11 }]);
	});

	it("ignores grep output when -n is absent", () => {
		const a = touchLines("a.ts", 20);
		expect(
			extractGrepSearchReadsFromOutput(`grep foo ${a}`, tmp, `${a}:9:foo`),
		).toHaveLength(0);
	});
});

// ── writes: agent authored the file (mirrors the Write tool) ────────────────

describe("extractWrittenPathsFromCommand — bash writes", () => {
	const cases: Array<[string, (f: string) => string]> = [
		["redirect (>)", (f) => `echo "x" > ${f}`],
		["redirect no space (>file)", (f) => `echo "x" >${f}`],
		["append (>>)", (f) => `echo "x" >> ${f}`],
		["fd redirect (2>)", (f) => `node build.js 2> ${f}`],
		["tee", (f) => `echo x | tee ${f}`],
		["tee -a", (f) => `echo x | tee -a ${f}`],
		["sed -i (in-place)", (f) => `sed -i 's/a/b/' ${f}`],
		["touch", (f) => `touch ${f}`],
		["cp destination", (f) => `cp /other/src.ts ${f}`],
		["mv destination", (f) => `mv /other/src.ts ${f}`],
		["git checkout -- <file>", (f) => `git checkout -- ${f}`],
		["git checkout <ref> -- <file>", (f) => `git checkout HEAD~1 -- ${f}`],
		["git restore <file>", (f) => `git restore ${f}`],
		["git restore --staged <file>", (f) => `git restore --staged ${f}`],
	];

	for (const [label, build] of cases) {
		it(`registers ${label}`, () => {
			const f = pathIn("a.ts"); // need not exist yet
			expect(extractWrittenPathsFromCommand(build(f), tmp)).toContain(f);
		});
	}

	it("cp source is NOT registered as a write (only the destination)", () => {
		const dst = pathIn("dst.ts");
		const r = extractWrittenPathsFromCommand(`cp /other/src.ts ${dst}`, tmp);
		expect(r).toContain(dst);
		expect(r).not.toContain("/other/src.ts");
	});

	it("whole-tree / non-content git ops are NOT registered (can't enumerate files)", () => {
		const f = pathIn("a.ts");
		// branch switch (no `--`), hard reset, status, diff, add, stash pop
		expect(
			extractWrittenPathsFromCommand(`git checkout main`, tmp),
		).toHaveLength(0);
		expect(
			extractWrittenPathsFromCommand(`git reset --hard`, tmp),
		).toHaveLength(0);
		expect(extractWrittenPathsFromCommand(`git status`, tmp)).toHaveLength(0);
		expect(extractWrittenPathsFromCommand(`git diff ${f}`, tmp)).not.toContain(
			f,
		);
		expect(extractWrittenPathsFromCommand(`git add ${f}`, tmp)).not.toContain(
			f,
		);
		expect(extractWrittenPathsFromCommand(`git stash pop`, tmp)).toHaveLength(
			0,
		);
	});
});

// ── neither read nor write: no content involved ─────────────────────────────

describe("commands with no file content are not registered at all", () => {
	const noops: Array<[string, (f: string) => string]> = [
		["ls (names only)", (f) => `ls -l ${f}`],
		["grep (scattered matches)", (f) => `grep -n "foo" ${f}`],
		["find (names only)", (f) => `find . -name ${path.basename(f)}`],
		["bare mention", (f) => `echo building ${f} now`],
	];

	for (const [label, build] of noops) {
		it(`${label} → no read and no write`, () => {
			const f = touchLines("a.ts", 5);
			expect(
				readSpan(extractReadPathsFromCommand(build(f), tmp), f),
			).toBeUndefined();
			expect(extractWrittenPathsFromCommand(build(f), tmp)).not.toContain(f);
		});
	}
});

// ── edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
	it("non-existent file is not a read (file must exist to be viewed)", () => {
		expect(
			extractReadPathsFromCommand(`cat /does/not/exist.ts`, tmp),
		).toHaveLength(0);
	});

	it("directory argument is rejected as a read", () => {
		expect(extractReadPathsFromCommand(`cat ${tmp}`, tmp)).toHaveLength(0);
	});

	it("unsupported extension is not registered (read or write)", () => {
		const f = touchLines("package.lock", 3);
		expect(
			readSpan(extractReadPathsFromCommand(`cat ${f}`, tmp), f),
		).toBeUndefined();
		expect(extractWrittenPathsFromCommand(`echo x > ${f}`, tmp)).not.toContain(
			f,
		);
	});

	it("empty / fileless commands return []", () => {
		expect(extractReadPathsFromCommand("", tmp)).toHaveLength(0);
		expect(
			extractWrittenPathsFromCommand("echo hello world", tmp),
		).toHaveLength(0);
	});

	it("does not throw on paths with spaces", () => {
		expect(() =>
			extractReadPathsFromCommand(`cat '/tmp/my file.ts'`, tmp),
		).not.toThrow();
		expect(() =>
			extractWrittenPathsFromCommand(`echo x > '/tmp/my file.ts'`, tmp),
		).not.toThrow();
	});
});
