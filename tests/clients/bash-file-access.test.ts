import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractDeletedPathsFromCommand,
	extractGrepSearchReadsFromOutput,
	extractReadPathsFromCommand,
	extractWrittenPathsFromCommand,
	isEditClassToolResult,
	parseGrepContextLines,
	tokenizeShellCommand,
	type ReadSpan,
} from "../../clients/bash-file-access.js";
import { removeTempDirSync } from "./test-utils.js";

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
	removeTempDirSync(tmp);
});

describe("tokenizeShellCommand — heredocs", () => {
	it.each([
		[";", "bare", "EOF"],
		[";", "single-quoted", "'EOF'"],
		[";", "double-quoted", '"EOF"'],
		[";", "escaped", "\\EOF"],
		["&", "bare", "EOF"],
		["&", "single-quoted", "'EOF'"],
		["&", "double-quoted", '"EOF"'],
		["&", "escaped", "\\EOF"],
		["|", "bare", "EOF"],
		["|", "single-quoted", "'EOF'"],
		["|", "double-quoted", '"EOF"'],
		["|", "escaped", "\\EOF"],
		["<", "bare", "EOF"],
		["<", "single-quoted", "'EOF'"],
		["<", "double-quoted", '"EOF"'],
		["<", "escaped", "\\EOF"],
		[">", "bare", "EOF"],
		[">", "single-quoted", "'EOF'"],
		[">", "double-quoted", '"EOF"'],
		[">", "escaped", "\\EOF"],
		[" ", "bare", "EOF"],
		[" ", "single-quoted", "'EOF'"],
		[" ", "double-quoted", '"EOF"'],
		[" ", "escaped", "\\EOF"],
	] as const)(
		"terminates the delimiter at $0 ($1)",
		(operator, _form, delimiter) => {
			const command = `cat <<${delimiter}${operator}echo git push\nbody\nEOF`;
			const expected =
				operator === ";" || operator === "&"
					? [
							{ tokens: ["cat"], unsupported: true },
							{ tokens: ["echo", "git", "push"], unsupported: false },
						]
					: operator === "|"
						? [
								{
									tokens: ["cat"],
									unsupported: true,
									terminator: "pipe" as const,
								},
								{ tokens: ["echo", "git", "push"], unsupported: false },
							]
						: [{ tokens: ["cat", "echo", "git", "push"], unsupported: true }];
			expect(tokenizeShellCommand(command)).toEqual(expected);
		},
	);

	it("drops heredoc body words while preserving the surrounding command", () => {
		expect(
			tokenizeShellCommand("cat <<EOF\nbody git push\nEOF\necho done"),
		).toEqual([
			{ tokens: ["cat"], unsupported: true },
			{ tokens: ["echo", "done"], unsupported: false },
		]);
	});

	it("drops quoted bodies and keeps substitutions from unquoted bodies", () => {
		expect(
			tokenizeShellCommand(
				"cat <<'EOF'\n$(git push)\nEOF\ncat <<EOF\n$(git commit)\nEOF",
			),
		).toEqual([
			{ tokens: ["cat"], unsupported: true },
			{ tokens: ["cat"], unsupported: true },
			{ tokens: ["git", "commit"], unsupported: false },
		]);
	});

	it("matches tab-stripped heredoc delimiters", () => {
		expect(tokenizeShellCommand("cat <<-EOF\n\tbody git push\n\tEOF")).toEqual([
			{ tokens: ["cat"], unsupported: true },
		]);
	});

	it("does not treat a here-string as a heredoc", () => {
		expect(tokenizeShellCommand("cat <<< git push\necho done")).toEqual([
			{ tokens: ["cat", "git", "push"], unsupported: true },
			{ tokens: ["echo", "done"], unsupported: false },
		]);
	});
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
			{ file: a, startLine: 7, endLine: 7, contextBefore: 0, contextAfter: 0 },
			{
				file: b,
				startLine: 12,
				endLine: 12,
				contextBefore: 0,
				contextAfter: 0,
			},
		]);
	});

	it("parses single-file grep -n output using the command file", () => {
		const a = touchLines("a.ts", 20);
		expect(
			extractGrepSearchReadsFromOutput(`grep -n foo ${a}`, tmp, "9:foo here"),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	it("recognizes combined grep flags that include line numbers", () => {
		const a = touchLines("a.ts", 20);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -Rns foo ${a}`,
				tmp,
				`${a}:11:foo here`,
			),
		).toEqual([
			{
				file: a,
				startLine: 11,
				endLine: 11,
				contextBefore: 0,
				contextAfter: 0,
			},
		]);
	});

	it("ignores grep output when -n is absent", () => {
		const a = touchLines("a.ts", 20);
		expect(
			extractGrepSearchReadsFromOutput(`grep foo ${a}`, tmp, `${a}:9:foo`),
		).toHaveLength(0);
	});

	// ── #1904 item 2: credit only the lines the grep actually printed ────────

	it("credits no context for a bare grep hit", () => {
		const a = touchLines("a.ts", 20);
		expect(
			extractGrepSearchReadsFromOutput(`grep -n foo ${a}`, tmp, "9:foo"),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	it("credits the context grep -A/-B/-C actually printed", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(`grep -n -A 3 foo ${a}`, tmp, "9:foo"),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 3 },
		]);
		expect(
			extractGrepSearchReadsFromOutput(`grep -n -B2 foo ${a}`, tmp, "9:foo"),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 2, contextAfter: 0 },
		]);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n --context=4 foo ${a}`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 4, contextAfter: 4 },
		]);
	});

	it("reads context flags clustered with other short flags", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -rnC2 foo ${a}`,
				tmp,
				`${a}:9:foo`,
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 2, contextAfter: 2 },
		]);
	});

	it("credits the narrowest context when a command chains several greps", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -nC5 foo ${a} && grep -n bar ${a}`,
				tmp,
				`${a}:9:foo`,
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	// ── #1908: a truncating pipe tail severs the flags-to-delivery link ──────

	it("falls back to match-line-only credit when piped through head", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} | head -1`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	it("falls back to match-line-only credit when piped through tail", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} | tail -n 1`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	it("falls back to match-line-only credit when piped through sed q", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} | sed q`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	it("still credits full context through a non-truncating pipe tail", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} | sort`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 2, contextAfter: 2 },
		]);
	});

	it("credits nothing when piped through wc, since the count carries no lines", () => {
		const a = touchLines("a.ts", 40);
		// `wc` replaces grep's `file:line:` output with a bare count, so the
		// output-line parser already finds zero matches — no special-casing
		// needed for #1908's "shows NO lines" policy.
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} | wc -l`,
				tmp,
				"1",
			),
		).toEqual([]);
	});

	it("follows a pass-through filter before the truncating tail", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} | cat | head -1`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	it("falls back to match-line-only credit when piped through uniq", () => {
		const a = touchLines("a.ts", 40);
		// uniq drops adjacent duplicate lines, which can include a repeated
		// context line — same drop hazard as head/tail (#1913 F4).
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} | uniq`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	// ── #1913 review F2: a real `|` must be required, not mere adjacency ─────

	it("keeps full credit when head follows via ; instead of a pipe", () => {
		const a = touchLines("a.ts", 40);
		// `head` here runs as its own command, never fed grep's stdout — a
		// mutant that treats ANY adjacent head/tail as truncating (dropping the
		// `terminator === "pipe"` check) would wrongly zero this out.
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} ; head -1 ${a}`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 2, contextAfter: 2 },
		]);
	});

	it("keeps full credit when head follows via && instead of a pipe", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} && head -1 ${a}`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 2, contextAfter: 2 },
		]);
	});

	it("credits full context when the command is not piped at all", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(`grep -n -C2 foo ${a}`, tmp, "9:foo"),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 2, contextAfter: 2 },
		]);
	});
});

describe("parseGrepContextLines", () => {
	it("returns zero context for flags that carry no context request", () => {
		expect(parseGrepContextLines(["-rn", "foo", "src"])).toEqual({
			before: 0,
			after: 0,
		});
	});

	it("parses attached, separated, long, and bare-number forms", () => {
		expect(parseGrepContextLines(["-A3"])).toEqual({ before: 0, after: 3 });
		expect(parseGrepContextLines(["-B", "4"])).toEqual({ before: 4, after: 0 });
		expect(parseGrepContextLines(["--after-context", "2"])).toEqual({
			before: 0,
			after: 2,
		});
		expect(parseGrepContextLines(["--before-context=1"])).toEqual({
			before: 1,
			after: 0,
		});
		expect(parseGrepContextLines(["-5"])).toEqual({ before: 5, after: 5 });
	});

	it("does not read a pattern or path as a context value", () => {
		expect(parseGrepContextLines(["-A", "foo", "src/a.ts"])).toEqual({
			before: 0,
			after: 0,
		});
		expect(parseGrepContextLines(["--", "-C3"])).toEqual({
			before: 0,
			after: 0,
		});
	});

	it("bounds an absurd context request", () => {
		expect(parseGrepContextLines(["-C99999"])).toEqual({
			before: 100,
			after: 100,
		});
	});
});

// ── writes: agent authored the file (mirrors the Write tool) ────────────────

describe("extractWrittenPathsFromCommand — bash writes", () => {
	it("classifies a third-party shell result from its written paths", () => {
		const f = pathIn("third-party.ts");
		expect(
			isEditClassToolResult(
				{
					toolName: "mcp__acme__shell",
					input: { command: `echo x > ${f}` },
				},
				tmp,
			),
		).toBe(true);
		expect(
			isEditClassToolResult(
				{
					toolName: "mcp__acme__shell",
					input: { command: `cat ${f}` },
				},
				tmp,
			),
		).toBe(false);
	});

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
		[
			"git mv destination (#1668 review F2)",
			(f) => `git mv /other/src.ts ${f}`,
		],
		["biome format --write", (f) => `npx biome format --write ${f}`],
		["biome check --write", (f) => `biome check --write ${f}`],
		["prettier --write", (f) => `prettier --write ${f}`],
		["eslint --fix", (f) => `eslint --fix ${f}`],
		["ruff format", (f) => `ruff format ${f}`],
		["ruff check --fix", (f) => `ruff check --fix ${f}`],
		["ruff --fix", (f) => `ruff --fix ${f}`],
		["gofmt -w", (f) => `gofmt -w ${f}`],
		["cargo fmt explicit path", (f) => `cargo fmt -- ${f}`],
		["rustfmt explicit path", (f) => `rustfmt ${f}`],
		["black", (f) => `black ${f}`],
		["clang-format -i", (f) => `clang-format -i ${f}`],
		["dotnet format --include", (f) => `dotnet format --include ${f}`],
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

	it("git mv source is NOT registered as a write (only the destination)", () => {
		const dst = pathIn("dst.ts");
		const r = extractWrittenPathsFromCommand(
			`git mv /other/src.ts ${dst}`,
			tmp,
		);
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

	it("does not invent paths for project-scoped formatter invocations", () => {
		expect(extractWrittenPathsFromCommand("cargo fmt", tmp)).toHaveLength(0);
		expect(extractWrittenPathsFromCommand("dotnet format", tmp)).toHaveLength(
			0,
		);
		expect(extractWrittenPathsFromCommand("rustfmt", tmp)).toHaveLength(0);
	});

	it("does not register formatter operands without their write flag", () => {
		const f = pathIn("a.ts");
		expect(
			extractWrittenPathsFromCommand(`biome format ${f}`, tmp),
		).not.toContain(f);
		expect(extractWrittenPathsFromCommand(`prettier ${f}`, tmp)).not.toContain(
			f,
		);
		expect(extractWrittenPathsFromCommand(`eslint ${f}`, tmp)).not.toContain(f);
		expect(extractWrittenPathsFromCommand(`gofmt ${f}`, tmp)).not.toContain(f);
		expect(
			extractWrittenPathsFromCommand(`clang-format ${f}`, tmp),
		).not.toContain(f);
	});
});

// ── deletes: the #1668 type-3 watched-files gap ─────────────────────────────

describe("extractDeletedPathsFromCommand — bash deletes (#1668)", () => {
	it("rm FILE registers the target", () => {
		const f = touchLines("a.ts", 3);
		expect(extractDeletedPathsFromCommand(`rm ${f}`, tmp)).toContain(f);
	});

	it("rm -f/-rf FILE ignores the flag, keeps the target", () => {
		const f = touchLines("a.ts", 3);
		expect(extractDeletedPathsFromCommand(`rm -f ${f}`, tmp)).toContain(f);
		expect(extractDeletedPathsFromCommand(`rm -rf ${f}`, tmp)).toContain(f);
	});

	it("rm A B registers every named target", () => {
		const a = touchLines("a.ts", 1);
		const b = touchLines("b.ts", 1);
		const result = extractDeletedPathsFromCommand(`rm ${a} ${b}`, tmp);
		expect(result).toContain(a);
		expect(result).toContain(b);
	});

	it("git rm FILE registers the target", () => {
		const f = touchLines("a.ts", 1);
		expect(extractDeletedPathsFromCommand(`git rm ${f}`, tmp)).toContain(f);
	});

	it("git rm --cached -- FILE registers the target after --", () => {
		const f = touchLines("a.ts", 1);
		expect(
			extractDeletedPathsFromCommand(`git rm --cached -- ${f}`, tmp),
		).toContain(f);
	});

	it("mv SRC DEST registers the source (vanishes) but not the destination", () => {
		const src = touchLines("a.ts", 1);
		const dst = pathIn("b.ts");
		const result = extractDeletedPathsFromCommand(`mv ${src} ${dst}`, tmp);
		expect(result).toContain(src);
		expect(result).not.toContain(dst);
	});

	it("git mv SRC DEST registers the source (vanishes) but not the destination (#1668 review F2)", () => {
		const src = touchLines("a.ts", 1);
		const dst = pathIn("b.ts");
		const result = extractDeletedPathsFromCommand(`git mv ${src} ${dst}`, tmp);
		expect(result).toContain(src);
		expect(result).not.toContain(dst);
	});

	it("git mv registers every source when moving multiple files into a directory", () => {
		const a = touchLines("a.ts", 1);
		const b = touchLines("b.ts", 1);
		const destDir = pathIn("dest/");
		const result = extractDeletedPathsFromCommand(
			`git mv ${a} ${b} ${destDir}`,
			tmp,
		);
		expect(result).toContain(a);
		expect(result).toContain(b);
	});

	it("KNOWN MISS (#1668 review F3, documented not fixed): `mv -t DEST SRC` misreads the -t target-directory form", () => {
		// GNU `-t DEST` puts the destination BEFORE the source, but this parser
		// always treats the destination as the LAST non-flag argument — so `-t`
		// usage is misread. Documented in extractDeletedPathsFromCommand's doc
		// comment; this test pins the current (wrong) behavior so a future
		// change to it is a deliberate, reviewed decision, not a silent drift.
		const src = touchLines("a.ts", 1);
		const dst = pathIn("dest.ts");
		const result = extractDeletedPathsFromCommand(`mv -t ${dst} ${src}`, tmp);
		// The real source (`src`) is NOT reported as deleted — the miss.
		expect(result).not.toContain(src);
	});

	it("bare directory rm is skipped — no explicit file, nothing to confirm", () => {
		// A dir has no recognized extension, so isReadableSourceFile rejects it —
		// this is the "don't stat the world" guard: no candidate is proposed.
		expect(extractDeletedPathsFromCommand(`rm -rf build/`, tmp)).toHaveLength(
			0,
		);
	});

	it("git clean (no named files) proposes nothing", () => {
		expect(extractDeletedPathsFromCommand(`git clean -fd`, tmp)).toHaveLength(
			0,
		);
	});

	it("unrelated commands (cat, grep, git status) propose nothing", () => {
		const f = touchLines("a.ts", 1);
		expect(extractDeletedPathsFromCommand(`cat ${f}`, tmp)).toHaveLength(0);
		expect(
			extractDeletedPathsFromCommand(`grep -n foo ${f}`, tmp),
		).toHaveLength(0);
		expect(extractDeletedPathsFromCommand(`git status`, tmp)).toHaveLength(0);
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
