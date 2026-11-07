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
	scanShellWriteScopes,
	tokenizeShellCommand,
	type ReadSpan,
} from "../../clients/bash-file-access.js";
import { toPosix } from "../../clients/path-utils.js";
import { ReadGuard } from "../../clients/read-guard.js";
import { registerSearchReads } from "../../clients/search-read-registration.js";
import { pinFixtureHome, removeTempDirSync } from "./test-utils.js";

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

	// #4577 R4: an absolute operand names the file the shell opened under the
	// spelling the command carried, and re-resolving it rewrites that spelling —
	// on win32 `C:/Users/…/large.ts` became `C:\Users\…` and redded the bash-cap
	// case that pins the reported path (#4019). A dot segment is the same rewrite
	// on every platform, and the posix spelling is what a Windows operand looks
	// like, so this pins the rule on both.
	it("keeps an absolute operand's spelling instead of re-resolving it (#4577 R4)", () => {
		const f = touchLines("sub/c.ts", 2);
		const spelled = toPosix(
			`${path.dirname(f)}${path.sep}.${path.sep}${path.basename(f)}`,
		);
		expect(extractReadPathsFromCommand(`cat ${spelled}`, tmp)).toEqual([
			{ filePath: spelled, offset: 1, limit: 2 },
		]);
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

	it.each([
		[
			"quoted pattern and bare filename",
			"grep -n '~/proj/x.ts' ~/proj/x.ts",
			"home",
		],
		[
			"bare pattern and quoted filename",
			"grep -n ~/proj/x.ts '~/proj/x.ts'",
			"~",
		],
	])(
		"binds quoting to the filename token: %s (#4577 R4)",
		(_label, command, selected) => {
			// The fixture HOME is outside the deleted root (#4591), so the file
			// bash's bare `~` names is created under the pin, not under `tmp`.
			const { home, restore } = pinFixtureHome("bfa-quote-token");
			fs.mkdirSync(path.join(tmp, ".git"));
			const homeFile = path.join(home, "proj", "x.ts");
			fs.mkdirSync(path.dirname(homeFile), { recursive: true });
			fs.writeFileSync(homeFile, "~/proj/x.ts\n");
			const literalFile = touchLines(path.join("~", "proj", "x.ts"));
			fs.writeFileSync(literalFile, `${home}/proj/x.ts\n`);
			try {
				const guard = new ReadGuard("r4-collision");
				// Real bash probe's single-file output. In the mirror, bash expands
				// the PATTERN; the literal file can contain that pattern too.
				const output =
					selected === "home" ? "1:~/proj/x.ts" : `1:${home}/proj/x.ts`;
				const locations = extractGrepSearchReadsFromOutput(
					command,
					tmp,
					output,
				);
				registerSearchReads(guard, locations, {
					projectRoot: tmp,
					turnIndex: 1,
					writeIndex: 0,
				});
				const expected = selected === "home" ? homeFile : literalFile;
				const unseen = selected === "home" ? literalFile : homeFile;
				// The binding itself: the bare operand resolves to $HOME, the quoted
				// one to the literal `<cwd>/~/…` file.
				expect(locations.map((loc) => loc.file)).toEqual([expected]);
				// `registerSearchReads` credits project-internal files only, and
				// #4591 puts the fixture HOME outside the project, so the credit is
				// observable on the in-project branch and the exclusion on the other.
				// Coverage this cell gives up (named in the PR body): a `~` that expands
				// to a project-INTERNAL home being credited. The pin cannot place HOME
				// inside a swept root any more, and no cell pins a raw in-project HOME.
				if (expected === literalFile)
					expect(guard.getReadHistory(literalFile)).toHaveLength(1);
				expect(guard.getReadHistory(unseen)).toHaveLength(0);
			} finally {
				restore();
			}
		},
	);

	it.each(["cat", "touch", "rm"])(
		"keeps identical %s operands distinct by quoting (#4577 R4)",
		(verb) => {
			const { home, restore } = pinFixtureHome("bfa-quote-distinct");
			const homeFile = path.join(home, "proj", "x.ts");
			fs.mkdirSync(path.dirname(homeFile), { recursive: true });
			fs.writeFileSync(homeFile, "line1\n");
			const literalFile = touchLines(path.join("~", "proj", "x.ts"));
			try {
				const command = `${verb} '~/proj/x.ts' ~/proj/x.ts`;
				const actual =
					verb === "cat"
						? extractReadPathsFromCommand(command, tmp).map(
								(span) => span.filePath,
							)
						: verb === "touch"
							? extractWrittenPathsFromCommand(command, tmp)
							: extractDeletedPathsFromCommand(command, tmp);
				expect(actual).toEqual([literalFile, homeFile]);
			} finally {
				restore();
			}
		},
	);

	// #4577 R2-1: the two grep paths that resolve an operand must receive the
	// segment's quoting bit like the three other `resolveCandidate` callers. `args`
	// arrive already `stripQuotes`d, so a quoted `~` here lost its only evidence
	// and was expanded to `$HOME` — a file grep never opened (bash reads
	// `<cwd>/~/…`). `$HOME` and the literal file both exist with different bytes,
	// so a wrong resolver answer is distinguishable from a missing file.
	it("credits a quoted ~ operand to the literal file, not the home file (#4577 R2-1)", () => {
		const { home, restore } = pinFixtureHome("bfa-grep-quoted");
		fs.mkdirSync(path.join(home, "proj"), { recursive: true });
		fs.writeFileSync(path.join(home, "proj", "x.ts"), "home line\n");
		const literalFile = touchLines(path.join("~", "proj", "x.ts"), 40);
		try {
			expect(os.homedir()).toBe(home);
			// Single-operand spelling: grep prints `line:text`, so the credited
			// path comes from `extractGrepSearchFiles` (the operand extraction).
			expect(
				extractGrepSearchReadsFromOutput(
					"grep -n bad '~/proj/x.ts'",
					tmp,
					"2:const bad = 9;",
				).map((loc) => loc.file),
			).toEqual([literalFile]);
		} finally {
			restore();
		}
	});

	it("credits a multi-file hit's quoted ~ operand to the literal file (#4577 R2-1)", () => {
		const { home, restore } = pinFixtureHome("bfa-grep-quoted-multi");
		fs.mkdirSync(path.join(home, "proj"), { recursive: true });
		fs.writeFileSync(path.join(home, "proj", "x.ts"), "home line\n");
		const literalFile = touchLines(path.join("~", "proj", "x.ts"), 40);
		try {
			expect(os.homedir()).toBe(home);
			// Multi-file spelling: grep prefixes each hit with the file it printed,
			// so this credited path comes from `parseGrepLineWithFile`, the other
			// site that had lost the bit.
			expect(
				extractGrepSearchReadsFromOutput(
					"grep -n bad '~/proj/x.ts' other.ts",
					tmp,
					"~/proj/x.ts:2:const bad = 9;",
				).map((loc) => loc.file),
			).toEqual([literalFile]);
		} finally {
			restore();
		}
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

	/**
	 * #2939 W4, classify half. The command half above is pinned; the
	 * `classifyMutatingTool(...) !== undefined` early return that precedes it
	 * was not, and PR #2897's verify measured deleting it green on 115 files.
	 * Recurrence it prevents: a recognised edit tool carries no `input.command`,
	 * so without that early return every `edit`/`write`/third-party edit result
	 * is classified read-only — and `index.ts` then gives it the 500 ms read-only
	 * budget and skips the analyzer-bootstrap load the edit path needs.
	 */
	it("classifies a recognised edit tool that carries no shell command (#2939 W4)", () => {
		expect(isEditClassToolResult({ toolName: "edit", input: {} }, tmp)).toBe(
			true,
		);
		expect(isEditClassToolResult({ toolName: "read", input: {} }, tmp)).toBe(
			false,
		);
	});

	/**
	 * #5248. Recurrence it prevents: `lsp_navigation` and `ast_grep_replace`
	 * rewrote several files, were classed read-only, and got the 500 ms wall,
	 * which abandoned the per-file dispatch after the first file, so the commit
	 * gate ran before the other files published a verdict. A result naming the
	 * files an admitted pi-lens tool wrote is edit-class; the same field on a
	 * tool pi-lens does not own, and an admitted tool that wrote nothing, is not.
	 */
	it("classifies an admitted tool's result that names applied files as edit-class (#5248)", () => {
		const applied = { appliedFiles: [pathIn("a.ts"), pathIn("b.ts")] };
		for (const toolName of ["lsp_navigation", "ast_grep_replace"])
			expect(
				isEditClassToolResult({ toolName, input: {}, details: applied }, tmp),
			).toBe(true);
		expect(
			isEditClassToolResult(
				{
					toolName: "lsp_navigation",
					input: {},
					details: { appliedFiles: [] },
				},
				tmp,
			),
		).toBe(false);
		expect(
			isEditClassToolResult(
				{ toolName: "lsp_navigation", input: {}, details: {} },
				tmp,
			),
		).toBe(false);
		expect(
			isEditClassToolResult(
				{ toolName: "evil_tool", input: {}, details: applied },
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

	// #4576/#4577 M1: a bash operand follows SHELL rules, not host-tool-argument
	// rules. bash expands a bare leading `~` itself and leaves a quoted one
	// literal; nothing else the host resolver does (`@` strip, `file://`
	// conversion, unicode-space fold) applies to a shell word, because the shell
	// opened the literal file name. Each row below pins one of those rules.
	it("expands a bare ~ operand to $HOME instead of pinning it under the cwd (#4576)", () => {
		const { home, restore } = pinFixtureHome("bfa-bare-tilde");
		fs.mkdirSync(path.join(home, "proj"), { recursive: true });
		try {
			expect(os.homedir()).toBe(home);
			expect(
				extractWrittenPathsFromCommand("echo x > ~/proj/a.ts", tmp),
			).toEqual([path.join(home, "proj", "a.ts")]);
			fs.writeFileSync(path.join(home, "proj", "a.ts"), "line1\n");
			expect(
				extractReadPathsFromCommand("cat ~/proj/a.ts", tmp)[0]?.filePath,
			).toBe(path.join(home, "proj", "a.ts"));
			// `~user` is not a spelling pi expands; it stays relative to the
			// cwd, exactly as the host tool resolver leaves it.
			expect(
				extractWrittenPathsFromCommand("echo x > ~user/proj/a.ts", tmp),
			).toEqual([path.join(tmp, "~user", "proj", "a.ts")]);
		} finally {
			restore();
		}
	});

	// #4577 M1: bash does NOT expand a quoted tilde (`info bash`, Tilde
	// Expansion: "If a word begins with an unquoted tilde character …"). The
	// tokenizer drops the quotes, so the segment carries the bit; the pre-fix
	// resolver expanded all three spellings to $HOME and credited a read of a
	// file the command never opened.
	// #4713 R10: so is a tilde after an empty quote, or one whose prefix holds
	// one (`~""/x`): the quote adds no character, but bash sees it.
	it.each([
		["single-quoted", "cat '~/proj/a.ts'"],
		["double-quoted", 'cat "~/proj/a.ts"'],
		["empty-quote-led", 'cat ""~/proj/a.ts'],
		["empty-single-quote-led", "cat ''~/proj/a.ts"],
		["prefix-quoted", 'cat ~""/proj/a.ts'],
	])(
		"keeps a %s ~ operand literal under the cwd (#4577)",
		(_label, command) => {
			const { home, restore } = pinFixtureHome("bfa-quoted-tilde");
			fs.mkdirSync(path.join(home, "proj"), { recursive: true });
			const literalFile = touchLines(path.join("~", "proj", "a.ts"));
			fs.writeFileSync(path.join(home, "proj", "a.ts"), "home line\n");
			try {
				expect(os.homedir()).toBe(home);
				expect(
					extractReadPathsFromCommand(command, tmp).map((s) => s.filePath),
				).toEqual([literalFile]);
			} finally {
				restore();
			}
		},
	);

	it("keeps a quoted redirect target's ~ literal under the cwd (#4577)", () => {
		const { home, restore } = pinFixtureHome("bfa-quoted-redirect");
		fs.mkdirSync(path.join(home, "proj"), { recursive: true });
		const literalFile = touchLines(path.join("~", "proj", "n.ts"));
		try {
			expect(os.homedir()).toBe(home);
			expect(
				extractWrittenPathsFromCommand("echo x > '~/proj/n.ts'", tmp),
			).toEqual([literalFile]);
		} finally {
			restore();
		}
	});

	// #4577 M1: a shell word is a file name. `@x.ts` is not a file mention, and
	// a unicode space in a name is that byte, not U+0020. The host resolver
	// applied both (its `stripAtPrefix` and unicode fold), so the pre-fix code
	// credited `<cwd>/x.ts` and `<cwd>/a b.ts` — files the command never read.
	// The names are quoted because the lexer splits words on `\s`, which matches
	// U+202F; that pre-existing split is a separate defect from this fold.
	it("reads the literal @-prefixed and unicode-spaced file names the shell opened (#4577)", () => {
		const atFile = touchLines("@config.ts");
		const spacedFile = touchLines("a\u202Fb.ts");
		expect([
			...extractReadPathsFromCommand("cat @config.ts", tmp).map(
				(s) => s.filePath,
			),
			...extractWrittenPathsFromCommand("tee 'a\u202Fb.ts'", tmp),
		]).toEqual([atFile, spacedFile]);
	});

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

	// Recurrence this guards (#5378): with `-t DIR` the destination was the last
	// operand, so none of `DIR/<basename>` paths the move actually wrote.
	it("mv -t DIR registers DIR/<basename> for every source (#5378)", () => {
		const a = touchLines("a.ts", 1);
		const b = touchLines("nested/b.ts", 1);
		for (const command of [
			`mv -t dest/ ${a} ${b}`,
			`mv --target-directory=dest/ ${a} ${b}`,
		]) {
			expect(extractWrittenPathsFromCommand(command, tmp), command).toEqual(
				expect.arrayContaining([
					path.join(tmp, "dest", "a.ts"),
					path.join(tmp, "dest", "b.ts"),
				]),
			);
		}
	});

	it("mv -t with an absolute trailing-slash dir keeps that dir's spelling (#5378)", () => {
		const a = touchLines("a.ts", 1);
		const dir = pathIn("deep/dest");
		expect(extractWrittenPathsFromCommand(`mv -t ${dir}/ ${a}`, tmp)).toEqual([
			`${dir}/a.ts`,
		]);
	});

	it("git mv -t DIR registers the written destination too (#5378)", () => {
		const a = touchLines("a.ts", 1);
		const b = touchLines("b.ts", 1);
		expect(
			extractWrittenPathsFromCommand(`git mv -t dest/ ${a} ${b}`, tmp),
		).toEqual(
			expect.arrayContaining([
				path.join(tmp, "dest", "a.ts"),
				path.join(tmp, "dest", "b.ts"),
			]),
		);
	});

	it("cp -t DIR registers DIR/<basename> and not the source (#5378)", () => {
		const a = touchLines("a.ts", 1);
		const r = extractWrittenPathsFromCommand(`cp -t dest/ ${a}`, tmp);
		expect(r).toEqual([path.join(tmp, "dest", "a.ts")]);
		expect(r).not.toContain(a);
	});

	it("mv SRC DEST still registers the trailing destination (#5378)", () => {
		const src = touchLines("a.ts", 1);
		const dst = pathIn("b.ts");
		const r = extractWrittenPathsFromCommand(`mv ${src} ${dst}`, tmp);
		expect(r).toEqual([dst]);
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

	// Recurrence this guards (#5378): the parser used to assume source-before-
	// destination order, so every source but the first of a `-t DIR` move kept a
	// stale read record while its bytes had moved.
	it("mv -t DIR registers every source for both option spellings (#5378)", () => {
		const a = touchLines("a.ts", 1);
		const b = touchLines("b.ts", 1);
		for (const command of [
			`mv -t dest/ ${a} ${b}`,
			`mv -tdest/ ${a} ${b}`,
			`mv --target-directory dest/ ${a} ${b}`,
			`mv --target-directory=dest/ ${a} ${b}`,
		]) {
			expect(extractDeletedPathsFromCommand(command, tmp), command).toEqual(
				expect.arrayContaining([a, b]),
			);
		}
	});

	it("git mv -t DIR registers every source (#5378)", () => {
		const a = touchLines("a.ts", 1);
		const b = touchLines("b.ts", 1);
		expect(
			extractDeletedPathsFromCommand(`git mv -k -t dest/ ${a} ${b}`, tmp),
		).toEqual(expect.arrayContaining([a, b]));
	});

	it("mv -t DEST SRC registers the source it used to miss (#5378)", () => {
		// The single-source spelling the old "Known miss" test pinned as WRONG
		// (`mv -t DEST SRC` reported nothing): the destination now reads from
		// `-t`, so SRC is the source that vanishes.
		const src = touchLines("a.ts", 1);
		const dst = pathIn("dest.ts");
		expect(extractDeletedPathsFromCommand(`mv -t ${dst} ${src}`, tmp)).toEqual([
			src,
		]);
	});

	it("mv -t with no source operand names nothing (#5378)", () => {
		expect(extractDeletedPathsFromCommand(`mv -t dest/`, tmp)).toEqual([]);
	});

	it("mv -- -t DEST SRC reads -- as end-of-options, not as -t (#5378)", () => {
		// After `--`, bash takes every word positionally, so SRC is the source and
		// DEST is the destination: `mv -- -t dest/ a.ts b.ts` moves `-t`, `dest/`
		// and `a.ts` into `b.ts`. Reading the `-t` as the target-directory option
		// instead would report the surviving destination `b.ts` as deleted.
		const src = touchLines("a.ts", 1);
		const surviving = touchLines("b.ts", 1);
		const result = extractDeletedPathsFromCommand(
			`mv -- -t dest/ ${src} ${surviving}`,
			tmp,
		);
		expect(result).toEqual([src]);
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

// ── #2050: a command's own `cd` decides where its operands land ─────────────

describe("scanShellWriteScopes — the command's effective directory (#2050)", () => {
	/** The scan's own absolute paths, so a relative fixture cannot leak in. */
	function written(command: string): string[] {
		return scanShellWriteScopes(command, tmp).written;
	}

	it("resolves a redirect after `cd` against the directory it entered", () => {
		const sub = path.join(tmp, "sub");
		expect(written(`cd ${sub} && echo x > f.ts`)).toEqual([
			path.join(sub, "f.ts"),
		]);
		// The phantom the pre-fix resolution named, under the session root.
		expect(written(`cd ${sub} && echo x > f.ts`)).not.toContain(
			path.join(tmp, "f.ts"),
		);
	});

	it("keeps one directory per segment across a chain of cds", () => {
		const a = path.join(tmp, "a");
		const b = path.join(tmp, "b");
		expect(
			written(`cd ${a} && echo x > in-a.ts && cd ${b} && echo y > in-b.ts`),
		).toEqual([path.join(a, "in-a.ts"), path.join(b, "in-b.ts")]);
	});

	it("tracks pushd, and a relative cd against the directory already entered", () => {
		const a = path.join(tmp, "a");
		expect(
			written(`pushd ${a} && echo x > one.ts && cd nested && echo y > two.ts`),
		).toEqual([path.join(a, "one.ts"), path.join(a, "nested", "two.ts")]);
	});

	it("resolves a recognised `tee` operand against the cd too", () => {
		const sub = path.join(tmp, "tee-dir");
		expect(written(`cd ${sub} && echo x | tee f.ts`)).toEqual([
			path.join(sub, "f.ts"),
		]);
	});

	it("leaves the directory unchanged for a cd it cannot know statically", () => {
		// `$DIR`, `cd -` and a glob are expansions only the shell can resolve, so
		// the operand keeps the pre-#2050 answer rather than a guess.
		for (const cd of ["cd $DIR", "cd -", "cd ../*"]) {
			expect(written(`${cd} && echo x > f.ts`)).toEqual([
				path.join(tmp, "f.ts"),
			]);
		}
	});

	it("reports the cd targets in command order, without duplicates", () => {
		const a = path.join(tmp, "a");
		const b = path.join(tmp, "b");
		expect(
			scanShellWriteScopes(`cd ${a} && cd ${b} && cd ${a} && true`, tmp)
				.cdTargets,
		).toEqual([a, b]);
	});

	it("does not credit a redirect inside a heredoc body", () => {
		// The body is data for the interpreter, not shell syntax, and its offsets
		// are relative to the substituted text.
		expect(
			written(
				["cat <<'EOF'", "python3 - <<'PY' > not-a-write.ts", "PY", "EOF"].join(
					"\n",
				),
			),
		).toEqual([]);
	});

	it("does not credit a heredoc body's redirect to the segment after it", () => {
		// Body offsets sit in the gap BETWEEN two segments, so the first outer
		// segment after the body claimed an unquoted `>` from it as its own
		// redirect (#4713 F5). The trailing body above never showed it.
		expect(
			written(
				["node - <<'EOF'", "foo > phantom.ts", "EOF", "echo done"].join("\n"),
			),
		).toEqual([]);
	});

	/**
	 * One row per row of the PR's state table (#4713 round 4). `bash` is the
	 * file real `bash -c` wrote with cwd = `tmp` (holding `sub/` and `other/`),
	 * measured by the probe the PR body quotes. A row that names a `fallback`
	 * is a residual: the scan answers what the PR's base answered (the
	 * command's own cwd), which is not where bash wrote.
	 *
	 * Recurrence: rounds 3 and 4 of #4713 each found new spellings (a `cd`
	 * entered through a pipe, a backgrounded list, a bare `pushd`, then a
	 * function body, a subshell, `eval`, `\cd`, `cd -`, `2>&1`) that the
	 * enumerated carry rule moved into `sub/` while bash wrote at the top.
	 *
	 * `named` is the row's `cdTargets` (relative to `tmp`): the directory a
	 * recovery root is looked up in, so it names the directory bash entered
	 * and never one bash cannot enter. Recurrence: #4713 R8-1 and R8-2, where
	 * `cdTargets` re-derived its own verb and operand and named `2` for
	 * `cd 2>/dev/null <wt>`, nothing for `FOO=1 cd <wt>`, and `~+1` for
	 * `cd ~+1`.
	 */
	const CWD_ROWS: ReadonlyArray<{
		row: string;
		command: string;
		bash: string;
		fallback?: string;
		named?: readonly string[];
	}> = [
		{
			row: "R1 list start, &&",
			command: "cd sub && printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{ row: "R2 ;", command: "cd sub; printf x > f.ts", bash: "sub/f.ts" },
		{ row: "R3 newline", command: "cd sub\nprintf x > f.ts", bash: "sub/f.ts" },
		{
			row: "R4 entered after &&",
			command: "true && cd sub && printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R5 entered after ;",
			command: "true; cd sub; printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R6 entered after a backgrounded list",
			command: "true & cd sub && printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R7 redirect glue 2>&1",
			command: "cd sub 2>&1 && printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R8 glue &> and a redirect operand",
			command: "pushd sub &>/dev/null && printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R9 assignment prefix",
			command: "cd sub && FOO=1 true && printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R10 ended by || (V1 C5)",
			command: "cd sub || exit 1\nprintf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R11 right side of ||",
			command: "cd missing 2>/dev/null || printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R12 entered after ||",
			command: "false || cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R12b entered after a || whose left side succeeded",
			command: "true || cd sub; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R13 right of a pipe (V1 C1)",
			command: "echo | cd sub && printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R14 left of a pipe",
			command: "cd sub | cat; printf x > f.ts",
			bash: "f.ts",
		},
		{ row: "R15 |&", command: "cd sub |& cat; printf x > f.ts", bash: "f.ts" },
		{
			row: "R15b |& inside a list",
			command: "cd sub && true |& cat; printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R16 backgrounded list (V1 C2)",
			command: "cd sub && true & printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R17 backgrounded cd",
			command: "cd sub & printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R18 write inside a backgrounded list",
			command: "cd sub && printf x > f.ts & wait",
			bash: "sub/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R19 subshell parens",
			command: "( true; cd sub ); printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R20 command substitution",
			command: "x=$(true; cd sub); printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R21 brace group",
			command: "{ cd sub; }; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R22 function body, never called",
			command: "f() {\ncd sub\n}\nprintf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R23 function body, called",
			command: "cd sub && g() { cd ..; }; g; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R24 if body",
			command: "if false\nthen\ncd sub\nfi\nprintf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R25 pushd/popd pair",
			command: "pushd sub; popd; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R25b popd back to a moved directory",
			command: "cd sub && pushd ../other && popd && printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R26 bare pushd (V1 C4)",
			command: "pushd sub; pushd; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R27 popd +0",
			command: "pushd sub && pushd ../other && popd +0 && printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R28 popd +1",
			command: "pushd sub && pushd ../other && popd +1 && printf x > f.ts",
			bash: "other/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R29 popd with no pushd",
			command: "cd sub; popd; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R30 cd -",
			command: "cd sub && cd - && printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R31 builtin cd",
			command: "cd sub && builtin cd .. && printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R32 eval",
			command: "cd sub && eval 'cd ..' && printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R33 escaped verb",
			command: "cd sub && \\cd .. && printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R34 cd inside a heredoc substitution",
			command: "cd sub && cat <<EOF\n$(cd ..)\nEOF\nprintf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub", "."],
		},
		{
			row: "R35 cd on the line after a heredoc",
			command: "cat <<EOF\nx\nEOF\ncd sub && printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R36 a relative cd after a fallback",
			command: "cd sub; pushd; cd ..; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R37 cd after a failed && (R5-1)",
			command: "false && cd sub\nprintf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R38 cd after a failed test (R5-1)",
			command: "[ -d nope ] && cd sub\nprintf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R39 cd after a failed cd (R5-1)",
			command: "cd missing && cd sub\nprintf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R40 && chain, write inside it",
			command: "cd sub && cd ../other && printf x > f.ts",
			bash: "other/f.ts",
		},
		{
			row: "R41 && move across ; (narrowed)",
			command: "true && cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R42 pushd +2 (R5-2)",
			command: "pushd sub && pushd ../other && pushd +2 && printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R43 pipe inside an && chain",
			command: "true && cd sub && echo x | cat > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R44 popd after a failed &&",
			command: "cd other; pushd ../sub; false && popd\nprintf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R45 pushd +foo, an index bash cannot parse (R6-1)",
			command: "pushd +foo; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R46 pushd + (R6-1)",
			command: "pushd +; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R47 pushd \\+foo, an escaped index",
			command: "pushd \\+foo; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R48 cd s\\ub, an escape bash removes",
			command: "cd s\\ub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: "R49 cd +foo enters a directory named +foo",
			command: "mkdir +foo; cd +foo; printf x > f.ts",
			bash: "+foo/f.ts",
			fallback: "f.ts",
		},
		{
			row: 'R50 cd "s\\ub", a quoted backslash bash keeps',
			command: 'cd "s\\ub"; printf x > f.ts',
			bash: "f.ts",
		},
		{
			row: "R51 cd ~+1, a stack entry bash lacks (R7-1)",
			command: "cd ~+1; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R52 cd ~-1 (R7-1)",
			command: "cd ~-1; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R53 cd ~+, the current directory (R7-1)",
			command: "cd ~+; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R54 pushd ~+1 (R7-1)",
			command: "pushd ~+1; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R55 cd ~+1 after a real push (R7-1)",
			command: "cd sub; pushd ..; cd ~+1; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R56 cd ~nosuchuser (R7-1)",
			command: "cd ~nosuchuser; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R57 cd ~- with no OLDPWD (R7-1)",
			command: "unset OLDPWD; cd ~-; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R58 cd ~+ with no OLDPWD (R7-1)",
			command: "unset OLDPWD; cd ~+; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R59 cd ~-1 with no OLDPWD (R7-1)",
			command: "unset OLDPWD; cd ~-1; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R60 cd ~+1 with no OLDPWD (R7-1)",
			command: "unset OLDPWD; cd ~+1; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R61 pushd ~- with no OLDPWD (R7-1)",
			command: "unset OLDPWD; pushd ~-; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R62 cd ~- with OLDPWD set (R7-1)",
			command: "cd old; cd ..; cd ~-; printf x > f.ts",
			bash: "old/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R63 cd ~+ with OLDPWD set (R7-1)",
			command: "cd old; cd ..; cd ~+; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R64 cd ~-1 with OLDPWD set (R7-1)",
			command: "cd old; cd ..; cd ~-1; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R65 cd ~+1 with OLDPWD set (R7-1)",
			command: "cd old; cd ..; cd ~+1; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R66 pushd ~- with OLDPWD set (R7-1)",
			command: "cd old; cd ..; pushd ~-; printf x > f.ts",
			bash: "old/f.ts",
			fallback: "f.ts",
		},
		{
			row: "R67 cd 's\\ub', no escape in single quotes (R7-2)",
			command: "mkdir 's\\ub'; cd 's\\ub'; printf x > f.ts",
			bash: "s\\ub/f.ts",
		},
		{
			row: "R68 pushd 's\\ub' (R7-2)",
			command: "mkdir 's\\ub'; pushd 's\\ub'; printf x > f.ts",
			bash: "s\\ub/f.ts",
		},
		{
			row: "R69 cd 'C:\\src' (R7-2)",
			command: "mkdir 'C:\\src'; cd 'C:\\src'; printf x > f.ts",
			bash: "C:\\src/f.ts",
		},
		{
			row: "R70 a backslash in a prefix assignment (R7-2)",
			command: "FOO=a\\b cd sub; printf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: "R71 a backslash in a trailing comment (R7-2)",
			command: "cd sub # C:\\src\nprintf x > f.ts",
			bash: "sub/f.ts",
		},
		{
			row: 'R72 cd "s\\\\ub", an escape bash also removes (R7-2)',
			command: "mkdir 's\\ub'; cd \"s\\\\ub\"; printf x > f.ts",
			bash: "s\\ub/f.ts",
		},
		{
			row: "R73 cd a=~/x, a tilde bash expands after = (R7-1)",
			command: "mkdir -p 'a=~/x'; cd a=~/x; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R74 cd a\\ b, an escape bash also removes (R7-1)",
			command: "mkdir 'a b'; cd a\\ b; printf x > f.ts",
			bash: "a b/f.ts",
		},
		{
			row: "R75 a redirection before the operand (R8-1)",
			command: "cd 2>/dev/null sub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: "R76 redirect glue before the operand (R8-1)",
			command: "cd 2>&1 sub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: "R77 an assignment prefix names the target (R8-1)",
			command: "FOO=1 cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: "R78 an empty CDPATH prefix (R8-1)",
			command: "CDPATH= cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: "R79 an assignment whose value is quoted (R8-3)",
			command: 'FOO="a b" cd sub; printf x > f.ts',
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: "R80 builtin cd names the target (R8-1)",
			command: "builtin cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
			named: ["sub"],
		},
		{
			row: "R81 command cd names the target (R8-1)",
			command: "command cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
			named: ["sub"],
		},
		{
			row: "R82 \\cd names the target (R8-1)",
			command: "\\cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: "R83 c\\d names the target (R8-1)",
			command: "c\\d sub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: "R84 an assignment before builtin cd (R8-1)",
			command: "FOO=1 builtin cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
			named: ["sub"],
		},
		{
			row: "R85 builtin pushd names the target (R8-1)",
			command: "builtin pushd sub; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
			named: ["sub"],
		},
		{
			row: "R86 command -v cd runs no cd (R8-1)",
			command: "command -v cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R87 a single-quoted assignment word is a command (R8-3)",
			command: "'FOO=bar' cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R88 a double-quoted assignment word is a command (R8-3)",
			command: '"FOO=bar" cd sub; printf x > f.ts',
			bash: "f.ts",
			named: [],
		},
		{
			row: "R89 a quoted = is no assignment (R8-3)",
			command: "FOO'='bar cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R90 a quoted name is no assignment (R8-3)",
			command: "'FOO'=bar cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R91 two quoted assignment words (R8-3)",
			command: "'A=1' 'B=2' cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R92 a quoted assignment word before pushd (R8-3)",
			command: "'FOO=bar' pushd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: 'R93 "\\c"d, a verb bash spells \\cd',
			command: '"\\c"d sub; printf x > f.ts',
			bash: "f.ts",
			named: [],
		},
		{
			row: "R94 a process substitution in a redirection (R8-1)",
			command: "cd sub 2> >(cat); printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
			named: ["sub"],
		},
		{
			row: "R95 an option before the operand (R8-1)",
			command: "cd -P sub; printf x > f.ts",
			bash: "sub/f.ts",
			fallback: "f.ts",
			named: ["sub"],
		},
		{
			row: "R96 a quoted ~+1 is a directory name (R8-3 tokenizer)",
			command: "mkdir '~+1'; cd '~+1'; printf x > f.ts",
			bash: "~+1/f.ts",
			named: ["~+1"],
		},
		{
			row: 'R97 FOO""=bar, an empty quote in the name (R10)',
			command: 'FOO""=bar cd sub; printf x > f.ts',
			bash: "f.ts",
			named: [],
		},
		{
			row: "R98 FOO''=bar (R10)",
			command: "FOO''=bar cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R99 FOO$''=bar (R10)",
			command: "FOO$''=bar cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: 'R100 FOO$""=bar (R10)',
			command: 'FOO$""=bar cd sub; printf x > f.ts',
			bash: "f.ts",
			named: [],
		},
		{
			row: "R101 FOO\\=bar (R10)",
			command: "FOO\\=bar cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: 'R102 F""OO=bar (R10)',
			command: 'F""OO=bar cd sub; printf x > f.ts',
			bash: "f.ts",
			named: [],
		},
		{
			row: 'R103 ""FOO=bar (R10)',
			command: '""FOO=bar cd sub; printf x > f.ts',
			bash: "f.ts",
			named: [],
		},
		{
			row: 'R104 FOO=""bar stays an assignment (R10)',
			command: 'FOO=""bar cd sub; printf x > f.ts',
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: 'R105 cd ""~, a tilde after an empty quote (R10)',
			command: "mkdir '~'; cd \"\"~; printf x > f.ts",
			bash: "~/f.ts",
			named: ["~"],
		},
		{
			row: 'R106 cd ""~/x (R10)',
			command: "mkdir -p '~/x'; cd \"\"~/x; printf x > f.ts",
			bash: "~/x/f.ts",
			named: ["~/x"],
		},
		{
			row: "R107 cd ''~+1 (R10)",
			command: "mkdir '~+1'; cd ''~+1; printf x > f.ts",
			bash: "~+1/f.ts",
			named: ["~+1"],
		},
		{
			row: 'R108 cd ~"", a quote in the tilde-prefix (R10)',
			command: "mkdir '~'; cd ~\"\"; printf x > f.ts",
			bash: "~/f.ts",
			named: ["~"],
		},
		{
			row: 'R109 cd ~""/x (R10)',
			command: "mkdir -p '~/x'; cd ~\"\"/x; printf x > f.ts",
			bash: "~/x/f.ts",
			named: ["~/x"],
		},
		{
			row: "R110 cd ~''/x (R10)",
			command: "mkdir -p '~/x'; cd ~''/x; printf x > f.ts",
			bash: "~/x/f.ts",
			named: ["~/x"],
		},
		{
			row: "R111 cd ~\\ x, an escape in the tilde-prefix (R10)",
			command: "mkdir '~ x'; cd ~\\ x; printf x > f.ts",
			bash: "~ x/f.ts",
			named: ["~ x"],
		},
		// #4713 R11 (greptile u5ycK, verify r11 F1): an escape and an empty
		// quote inside one verb word. Bash runs `cd`; round 10 named nothing.
		{
			row: 'R112 \\c""d, an escape and an empty quote in the verb (R11)',
			command: '\\c""d sub; printf x > f.ts',
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: "R113 ''\\cd (R11)",
			command: "''\\cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		{
			row: 'R114 b\\u""iltin cd, the same in a prefix (R11)',
			command: 'b\\u""iltin cd sub; printf x > f.ts',
			bash: "sub/f.ts",
			fallback: "f.ts",
			named: ["sub"],
		},
		{
			row: "R115 $'cd', ANSI-C quoting in the verb (R11)",
			command: "$'cd' sub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		// #4713 R11 mutations: each row reds one reader of the word model that
		// no earlier row reached (C2, K7, C5, the dropped value regex).
		{
			row: 'R116 cd "s$D", an expansion inside double quotes (R11)',
			command: 'D=ub; cd "s$D"; printf x > f.ts',
			bash: "sub/f.ts",
			fallback: "f.ts",
			named: [],
		},
		{
			row: "R117 cd sub\\ at the end, a backslash bash keeps (R11)",
			command: "printf x > f.ts; cd sub\\",
			bash: "f.ts",
			named: [],
		},
		{
			row: 'R118 cd a""~, a ~ that begins a later part (R11)',
			command: "mkdir 'a~'; cd a\"\"~; printf x > f.ts",
			bash: "a~/f.ts",
			named: ["a~"],
		},
		{
			row: "R119 cd 'a*', a quoted glob character (R11)",
			command: "mkdir 'a*'; cd 'a*'; printf x > f.ts",
			bash: "a*/f.ts",
			named: ["a*"],
		},
		// #4713 R12 (greptile PRRT_kwDORt8rec6u8SH2, verify r12 F2): a separate
		// empty quoted word is a word. Bash runs an empty command name, or
		// passes `cd` two operands, and enters nothing; the dropped word let
		// the rest read as `cd sub`.
		{
			row: "R120 '' \\c\"\"d sub, greptile's command (R12)",
			command: "'' \\c\"\"d sub; printf 'debugger;' > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R121 '' cd sub, an empty command name (R12)",
			command: "'' cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: 'R122 cd "" sub, an empty first operand (R12)',
			command: 'cd "" sub; printf x > f.ts',
			bash: "f.ts",
			named: [],
		},
		{
			row: "R123 FOO=1 '' cd sub (R12)",
			command: "FOO=1 '' cd sub; printf x > f.ts",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R124 '' && cd sub, a command of one empty word (R12)",
			command: "'' && cd sub; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R125 ''; cd sub, an empty command name moves nothing (R12)",
			command: "''; cd sub; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		// #4713 R12: a descriptor is unquoted digits; `2""` is the argument `2`,
		// so `cd` gets two operands and fails.
		{
			row: 'R126 cd sub 2"">/dev/null, quoted digits are no descriptor (R12)',
			command: 'cd sub 2"">/dev/null; printf x > f.ts',
			bash: "f.ts",
		},
		{
			row: "R126b cd sub '2'>/dev/null, the same in one quoted part (R12)",
			command: "cd sub '2'>/dev/null; printf x > f.ts",
			bash: "f.ts",
		},
		{
			row: "R126c cd sub>/dev/null, a word glued to > is no descriptor (R12)",
			command: "cd sub>/dev/null; printf x > f.ts",
			bash: "sub/f.ts",
			named: ["sub"],
		},
		// #4713 R12 (verify r12 F1, F3): every operand reader takes the word
		// model's path reading, not the legacy token text.
		{
			row: 'R127 > "f\\.ts", a backslash bash keeps in double quotes (R12)',
			command: 'printf x > "f\\.ts"',
			bash: "f\\.ts",
			named: [],
		},
		{
			row: "R128 > $'f.ts', an ANSI-C redirect target (R12)",
			command: "printf x > $'f.ts'",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R129 touch $'f.ts', an ANSI-C write operand (R12)",
			command: "touch $'f.ts'",
			bash: "f.ts",
			named: [],
		},
		{
			row: "R130 touch ~$''/f.ts, a quoted tilde-prefix (R12)",
			command: "mkdir '~'; touch ~$''/f.ts",
			bash: "~/f.ts",
			named: [],
		},
		{
			row: "R131 $'tee', an ANSI-C verb (R12)",
			command: "$'tee' f.ts < /dev/null",
			bash: "f.ts",
			named: [],
		},
	];

	it.each(CWD_ROWS)(
		"names the file bash writes, or the base's answer: $row",
		({ command, bash, fallback }) => {
			expect(written(command)).toEqual([path.join(tmp, fallback ?? bash)]);
		},
	);

	it.each(CWD_ROWS.filter((row) => row.named !== undefined))(
		"names the directory bash enters as a cd target, and no other: $row",
		({ command, named }) => {
			expect(scanShellWriteScopes(command, tmp).cdTargets).toEqual(
				(named ?? []).map((dir) => path.join(tmp, dir)),
			);
		},
	);

	// #4713 R11 (mutation D1): the raw redirect scanner splits a quoted name
	// at its space and hands the model `"f.ts`, an open quote; crediting
	// `f.ts` would mark a file bash never wrote as authored.
	it("names no file for a redirect target the raw scanner split (#4713 R11)", () => {
		expect(written('printf x > "f.ts x"')).toEqual([]);
	});

	// #4713 R12 (verify r12 F1): the Windows lane's shape, built with
	// `path.win32` so every platform runs it (AGENTS.md shape 35). The legacy
	// token text dropped every backslash inside the double quotes, so the write
	// named `C:UsersRUNNER~1…` and was never recognized. The unquoted spelling
	// keeps its backslashes through the path reading's kept escapes.
	it("keeps the backslashes of a Windows-shaped redirect target, quoted or not (#4713 R12)", () => {
		const target = path.win32.join(
			"C:\\Users",
			"RUNNER~1",
			"AppData",
			"Local",
			"Temp",
			"direct.js",
		);
		const expected = [path.resolve(tmp, target)];
		expect(written(`echo direct > "${target}"; node x.js`)).toEqual(expected);
		expect(written(`echo direct > ${target}; node x.js`)).toEqual(expected);
		expect(written(`touch "${target}"`)).toEqual(expected);
	});

	// #4713 R12: a verb read from the legacy token text ran commands bash
	// never runs: `"t\ee"` is a command named `t\ee`, and `''` is an empty one.
	it("names no write for a command bash cannot find (#4713 R12)", () => {
		expect(written('"t\\ee" f.ts')).toEqual([]);
		expect(written("'' tee f.ts")).toEqual([]);
	});

	// #4713 R7-1: a leading unquoted `~` moves the directory only as `~` or
	// `~/`, which bash and the scan both expand from HOME; the other tilde
	// forms are rows R51-R66 and R73.
	it("moves to HOME for a leading ~ or ~/ (#4713 R7-1)", () => {
		const { home, restore } = pinFixtureHome("bfa-cd-home");
		try {
			expect(os.homedir()).toBe(home);
			expect(written("cd ~; printf x > f.ts")).toEqual([
				path.join(home, "f.ts"),
			]);
			expect(written("cd ~/x; printf x > f.ts")).toEqual([
				path.join(home, "x", "f.ts"),
			]);
			// #4713 R10: a quote after the tilde-prefix leaves the expansion.
			expect(written('cd ~/x""; printf x > f.ts')).toEqual([
				path.join(home, "x", "f.ts"),
			]);
			expect(written('cd ~/""x; printf x > f.ts')).toEqual([
				path.join(home, "x", "f.ts"),
			]);
		} finally {
			restore();
		}
	});
});

// #4713 R12 (verify r12 F1, F3): every reader of a bash command takes its
// words from the word model. The legacy token text keeps the `$` of `$'…'`, so
// before this round each reader below named `$a.ts`, or saw no `cat`, `rm`,
// `grep` or `head`. One row per reader.
describe("every reader takes its words from the word model (#4713 R12)", () => {
	it("names an ANSI-C operand's file in reads, deletes and grep", () => {
		const a = touchLines("a.ts", 20);
		expect(
			extractReadPathsFromCommand("cat $'a.ts'", tmp).map((s) => s.filePath),
		).toEqual([a]);
		expect(extractDeletedPathsFromCommand("rm $'a.ts'", tmp)).toEqual([a]);
		expect(
			extractGrepSearchReadsFromOutput("grep -n foo $'a.ts'", tmp, "9:foo"),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
		// A flag is a word too: `$'-n'` is `-n`.
		expect(
			extractGrepSearchReadsFromOutput(`grep $'-n' foo ${a}`, tmp, "9:foo"),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	it("reads an ANSI-C verb as the command bash runs", () => {
		const a = touchLines("a.ts", 20);
		expect(
			extractReadPathsFromCommand(`$'cat' ${a}`, tmp).map((s) => s.filePath),
		).toEqual([a]);
		expect(extractDeletedPathsFromCommand(`$'rm' ${a}`, tmp)).toEqual([a]);
		expect(
			extractGrepSearchReadsFromOutput(`$'grep' -n -C2 foo ${a}`, tmp, "9:foo"),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 2, contextAfter: 2 },
		]);
	});

	it("falls back to match-line-only credit through an ANSI-C head", () => {
		const a = touchLines("a.ts", 40);
		expect(
			extractGrepSearchReadsFromOutput(
				`grep -n -C2 foo ${a} | $'head' -1`,
				tmp,
				"9:foo",
			),
		).toEqual([
			{ file: a, startLine: 9, endLine: 9, contextBefore: 0, contextAfter: 0 },
		]);
	});

	// The public stream is what `clients/git-guard.ts` and
	// `clients/runtime-tool-result.ts` read by position, and an empty word now
	// lives in the word model only: neither it nor a command of empty words
	// may reach `tokens`.
	it("keeps empty words out of the public segment stream", () => {
		expect(tokenizeShellCommand("'' && cd '' sub")).toEqual([
			{ tokens: ["cd", "sub"], unsupported: false },
		]);
	});
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
