import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// #2626 review round 2, F4 pattern, extended: `getBundledQueriesRootHealth`
// (#2636 review F6's memo) is called by `ruleFilesForLanguage` as a SAME-FILE
// internal reference, not a namespace-import call — empirically confirmed
// `vi.spyOn(moduleNamespace, "getBundledQueriesRootHealth")` does NOT
// intercept that internal call (unlike `clients/cache/rule-cache.ts`'s
// CROSS-module import of the same function, spied successfully in
// `rule-cache.test.ts`). Exercising the real "bundled root gone" path here
// therefore mocks `node:fs`'s `readdirSync` for the ONE real, known
// `BUNDLED_QUERIES_ROOT` path, delegating every other call (this file's own
// temp rule dirs) to the real implementation. #4212 round 3 extends the same
// mock with `readFileSync`: the r2 verify measured the warm memo re-reading
// and re-content-hashing the whole rule corpus on EVERY call (100 warm
// `loadQueries` calls: 134.98 ms on the r2 head vs 18.03 ms on master), and
// the regression guard below counts rule-content reads across warm calls.
const actualFsRef = vi.hoisted(() => {
	return {
		readdirSync: undefined as unknown as typeof import("node:fs").readdirSync,
		readFileSync: undefined as unknown as typeof import("node:fs").readFileSync,
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	actualFsRef.readdirSync = actual.readdirSync;
	actualFsRef.readFileSync = actual.readFileSync;
	return {
		...actual,
		readdirSync: vi.fn(actual.readdirSync),
		readFileSync: vi.fn(actual.readFileSync),
	};
});

import * as fs from "node:fs";
import { _resetRuleCorpusCycleFingerprintsForTests } from "../../clients/custom-rule-locations.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_resetBundledQueriesRootHealthForTests,
	BUNDLED_QUERIES_ROOT,
	getQueryLanguageKey,
	isDisabledQueryFilePath,
	queriesForLanguage,
	ruleFilesForLanguage,
	ruleSourceLanguages,
	type TreeSitterQuery,
	TreeSitterQueryLoader,
} from "../../clients/tree-sitter-query-loader.js";
import {
	beginTurnContext,
	runWithTurnContext,
} from "../../clients/turn-context.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

function writeRule(root: string, relPath: string, content: string): void {
	const filePath = path.join(root, relPath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function makeTempRulesRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-query-loader-"));
	tmpDirs.push(dir);
	return dir;
}

/**
 * Run `fn` inside a FRESH dispatch cycle, entered the way the pi host enters
 * one: `RuntimeCoordinator.beginTurn` calls `beginTurnContext` and
 * `clients/session-event-guard.ts` runs every host event inside
 * `runWithTurnContext`. The mutable rule corpus is content-fingerprinted at
 * most once per cycle (#4212 round 4), so a case that must observe a rule edit
 * through the no-`force` path has to cross that boundary — production crosses
 * it at every turn. Each call mints a distinct session so no two cases share a
 * turn counter.
 */
let cycleSessions = 0;
async function inNextCycle<T>(fn: () => Promise<T>): Promise<T> {
	cycleSessions += 1;
	const session = `query-loader-cycle-${cycleSessions}`;
	beginTurnContext(session);
	return runWithTurnContext(session, fn);
}

beforeEach(() => {
	_resetRuleCorpusCycleFingerprintsForTests();
});

afterAll(() => {
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

describe("tree-sitter query loader metadata parsing", () => {
	it("loads user rules between project and bundled rules and fingerprints the user root", async () => {
		const project = makeTempRulesRoot();
		const machine = makeTempRulesRoot();
		const previous = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = machine;
		try {
			writeRule(
				machine,
				"rules/tree-sitter-queries/typescript/user-rule.yml",
				`id: user-rule\nname: user\nquery: |\n  (identifier) @X\n`,
			);
			writeRule(
				project,
				"rules/tree-sitter-queries/typescript/project-rule.yml",
				`id: user-rule\nname: project\nquery: |\n  (string) @X\n`,
			);
			const loader = new TreeSitterQueryLoader();
			await loader.loadQueries(project);
			expect(loader.getQueryById("user-rule")?.name).toBe("project");
			expect(
				loader.getAllQueries().filter((query) => query.id === "user-rule"),
			).toHaveLength(1);
			expect(ruleFilesForLanguage("typescript", project)).toContain(
				path.join(
					machine,
					"rules/tree-sitter-queries/typescript/user-rule.yml",
				),
			);
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previous;
		}
	});

	it("refreshes project, user, and structural-search loads after edit/add/remove without force", async () => {
		const project = makeTempRulesRoot();
		const machine = makeTempRulesRoot();
		const previous = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = machine;
		try {
			const userDir = path.join(
				machine,
				"rules/tree-sitter-queries/typescript",
			);
			const rulePath = path.join(userDir, "live-user.yml");
			writeRule(
				machine,
				"rules/tree-sitter-queries/typescript/live-user.yml",
				`id: live-user\nname: OLD\nquery: |\n  (identifier) @X\n`,
			);
			const loader = new TreeSitterQueryLoader();
			await loader.loadQueries(project);
			expect(loader.getQueryById("live-user")?.name).toBe("OLD");

			writeRule(
				machine,
				"rules/tree-sitter-queries/typescript/live-user.yml",
				`id: live-user\nname: NEW\nquery: |\n  (identifier) @X\n`,
			);
			await inNextCycle(() => loader.loadQueries(project));
			expect(loader.getQueryById("live-user")?.name).toBe("NEW");

			writeRule(
				machine,
				"rules/tree-sitter-queries/typescript/added-user.yml",
				`id: added-user\nname: ADDED\nquery: |\n  (identifier) @X\n`,
			);
			await inNextCycle(() => loader.loadQueries(project));
			expect(loader.getQueryById("added-user")?.name).toBe("ADDED");

			fs.rmSync(rulePath);
			fs.rmSync(path.join(userDir, "added-user.yml"));
			await inNextCycle(() => loader.loadQueries(project));
			expect(loader.getQueryById("live-user")).toBeUndefined();
			expect(loader.getQueryById("added-user")).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previous;
		}
	});

	it("parses cwe/owasp/confidence in inline arrays", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/meta-inline.yml",
			`id: meta-inline
name: Meta Inline
severity: warning
category: security
language: typescript
message: test
query: |
  (identifier) @X
metavars: [X]
cwe: [CWE-327, CWE-330]
owasp: [A02]
confidence: high
defect_class: injection
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("meta-inline");
		expect(query).toBeTruthy();
		expect(query?.cwe).toEqual(["CWE-327", "CWE-330"]);
		expect(query?.owasp).toEqual(["A02"]);
		expect(query?.confidence).toBe("high");
	});

	it("parses multiline arrays with comments and quoted confidence", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/python/meta-multiline.yml",
			`id: meta-multiline
name: Meta Multiline
severity: warning
category: security
language: python
message: test
query: |
  (identifier) @X
metavars:
  - X
cwe:
  - CWE-89 # SQLi
  - CWE-22
owasp:
  - A03
  - A01
confidence: "medium"
defect_class: injection
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("meta-multiline");
		expect(query).toBeTruthy();
		expect(query?.cwe).toEqual(["CWE-89", "CWE-22"]);
		expect(query?.owasp).toEqual(["A03", "A01"]);
		expect(query?.confidence).toBe("medium");
	});

	it("preserves tree-sitter predicates in query blocks", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/predicate-preserve.yml",
			`id: predicate-preserve
name: Predicate Preserve
severity: warning
category: correctness
language: typescript
message: test
query: |
  (call_expression
    function: (member_expression
      object: (identifier) @OBJ
      property: (property_identifier) @FN))
  (#eq? @OBJ "Math")
  (#eq? @FN "random")
metavars:
  - OBJ
  - FN
defect_class: correctness
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("predicate-preserve");
		expect(query).toBeTruthy();
		expect(query?.query).toContain('#eq? @OBJ "Math"');
		expect(query?.query).toContain('#eq? @FN "random"');
	});

	it("loads disabled-directory rules for tests but excludes them from production language queries", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/python-disabled/disabled-example.yml",
			`id: disabled-example
name: Disabled Example
severity: warning
category: correctness
language: python
message: test
query: |
  (identifier) @X
metavars:
  - X
defect_class: correctness
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(loader.getAllQueries().map((q) => q.id)).toContain(
			"disabled-example",
		);
		expect(
			loader.getQueriesForLanguage("python").map((q) => q.id),
		).not.toContain("disabled-example");
	});

	it("detects disabled query paths independent of path separator", () => {
		expect(getQueryLanguageKey("typescript-disabled")).toBe("typescript");
		expect(
			isDisabledQueryFilePath(
				"rules/tree-sitter-queries/typescript-disabled/ts-path-traversal.yml",
			),
		).toBe(true);
		expect(
			isDisabledQueryFilePath(
				"rules\\tree-sitter-queries\\typescript-disabled\\ts-path-traversal.yml",
			),
		).toBe(true);
		expect(
			isDisabledQueryFilePath(
				"rules/tree-sitter-queries/typescript/console-statement.yml",
			),
		).toBe(false);
	});
});

// #4212 round 4 (the r3 verify's HIGH-4212-R3-2, and the r2 verify's HIGH
// before it): a per-call corpus check cannot stay at master's warm cost. All
// four variants measured on this machine in one session, 1000 warm
// `loadQueries` calls in a fresh process over a 170-file project corpus:
//
//	master, no corpus check            1.55 / 2.21 ms
//	r2 head, per-call content hash  1854.26 / 1880.22 ms   (~1000x master)
//	r3 head, per-call stat signature 402.12 / 405.36 ms    (~220x master)
//	r4 head, per-cycle content hash    2.00 / 2.04 ms      (inside master's spread)
//
// The corpus is now content-fingerprinted AT MOST ONCE PER DISPATCH CYCLE
// (`ruleCorpusFingerprintForCycle`), so a warm call inside a cycle does no
// filesystem work at all. At the 20000-call count, where the extra code is
// JIT-warm, it is 18.41 ms against master's 15.21 ms (1.21x).
//
// These counts are the deterministic proxy for that wall clock. They red on any
// change that re-introduces a per-call walk, per-call hashing, or per-call
// bundled-root work, and they red on a memo that never invalidates.
describe("the mutable rule corpus is fingerprinted at most once per dispatch cycle (#4212 round 4)", () => {
	function countRuleContentReads(): number {
		return vi
			.mocked(fs.readFileSync)
			.mock.calls.filter(([filePath]) => String(filePath).endsWith(".yml"))
			.length;
	}

	function countBundledRootWalks(): number {
		return vi
			.mocked(fs.readdirSync)
			.mock.calls.filter(([dir]) => dir === BUNDLED_QUERIES_ROOT).length;
	}

	/**
	 * Every `readdirSync` under the project's own rule root — the fingerprint
	 * walk's listing step. Counted from the fixture's known shape (one queries
	 * root plus one entry per language directory), never from production code.
	 */
	function countProjectRuleWalks(project: string): number {
		const queriesRoot = path.join(project, "rules", "tree-sitter-queries");
		return vi
			.mocked(fs.readdirSync)
			.mock.calls.filter(
				([dir]) =>
					String(dir) === queriesRoot ||
					String(dir).startsWith(queriesRoot + path.sep),
			).length;
	}

	function writeTwoLanguageCorpus(project: string): void {
		writeRule(
			project,
			"rules/tree-sitter-queries/typescript/warm-a.yml",
			`id: warm-a\nname: A\nquery: |\n  (identifier) @X\n`,
		);
		writeRule(
			project,
			"rules/tree-sitter-queries/python/warm-b.yml",
			`id: warm-b\nname: B\nquery: |\n  (identifier) @X\n`,
		);
	}

	it("reads no rule content and does not re-walk the bundled root across memoized calls", async () => {
		const project = makeTempRulesRoot();
		writeTwoLanguageCorpus(project);
		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(project); // cold parse, not measured

		const contentReadsBefore = countRuleContentReads();
		const bundledWalksBefore = countBundledRootWalks();
		for (let i = 0; i < 25; i++) {
			await loader.loadQueries(project);
		}
		expect(countRuleContentReads() - contentReadsBefore).toBe(0);
		expect(countBundledRootWalks() - bundledWalksBefore).toBe(0);
	});

	it("walks the mutable corpus zero times inside a cycle and exactly one fingerprint walk on the next one", async () => {
		const project = makeTempRulesRoot();
		const machine = makeTempRulesRoot();
		const previous = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = machine;
		writeTwoLanguageCorpus(project);
		// Derived from the fixture, not from the loader: one listing of the
		// queries root plus one per language directory it holds.
		const oneFingerprintWalk = 1 + 2;
		try {
			const loader = new TreeSitterQueryLoader();
			await loader.loadQueries(project); // cold: one fingerprint walk + one reload walk

			const walksBefore = countProjectRuleWalks(project);
			for (let i = 0; i < 25; i++) {
				await loader.loadQueries(project);
			}
			// The counted-walk guard the round brief asks for: nothing inside
			// the cycle re-walks. The r3 head re-walked on every one of these.
			expect(countProjectRuleWalks(project) - walksBefore).toBe(0);

			// And the memo is not permanent: a fresh cycle re-walks exactly
			// once, finds an unchanged corpus, and serves the loaded rules
			// without a reload — one walk, and one content read per rule file
			// for the hash, never a second walk for a parse.
			const readsBefore = countRuleContentReads();
			await inNextCycle(() => loader.loadQueries(project));
			expect(countProjectRuleWalks(project) - walksBefore).toBe(
				oneFingerprintWalk,
			);
			expect(countRuleContentReads() - readsBefore).toBe(2);
			expect(loader.getQueryById("warm-a")?.name).toBe("A");
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previous;
		}
	});

	it("sees a same-size rewrite whose mtime was pinned back, at the next cycle", async () => {
		// The r3 verify's HIGH-4212-R3-1: it wrote AAAA -> BBBB, restored the
		// exact timestamp with `touch`, and the r3 stat signature (path +
		// mtimeMs + size) still reported no change, so the loader served AAAA.
		// A whole-millisecond pin round-trips through `utimesSync` exactly, so
		// this reproduces that state without spawning `touch`.
		const project = makeTempRulesRoot();
		const machine = makeTempRulesRoot();
		const previous = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = machine;
		const pinnedSeconds = 1700000000.456;
		const rel = "rules/tree-sitter-queries/typescript/pinned.yml";
		try {
			writeRule(
				machine,
				rel,
				`id: pinned\nname: AAAA\nquery: |\n  (identifier) @X\n`,
			);
			const rulePath = path.join(machine, rel);
			fs.utimesSync(rulePath, pinnedSeconds, pinnedSeconds);
			const before = fs.statSync(rulePath);

			const loader = new TreeSitterQueryLoader();
			await loader.loadQueries(project);
			expect(loader.getQueryById("pinned")?.name).toBe("AAAA");

			// Same byte length: only the name's four characters differ.
			writeRule(
				machine,
				rel,
				`id: pinned\nname: BBBB\nquery: |\n  (identifier) @X\n`,
			);
			fs.utimesSync(rulePath, pinnedSeconds, pinnedSeconds);
			const after = fs.statSync(rulePath);

			// Prove the fixture still arms the defect: stat identity is
			// bit-identical, so any stat-derived gate is blind here.
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(after.size).toBe(before.size);
			expect(fs.readFileSync(rulePath, "utf-8")).toContain("BBBB");

			await inNextCycle(() => loader.loadQueries(project));
			expect(loader.getQueryById("pinned")?.name).toBe("BBBB");
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previous;
		}
	});

	it("holds the cycle's rules for the rest of that cycle and heals on a forced load", async () => {
		// State-table rows 8 and 9: an edit DURING a cycle is not seen by a
		// later warm call in the same cycle — that is the declared trade for a
		// warm call at master's cost — but a dispatch's `force: true` reload
		// republishes the fresh fingerprint into the cycle, so every later warm
		// call in that same cycle sees the edit without another walk. The rule
		// lives under the PROJECT root so the walk counter below has a
		// population to count.
		const project = makeTempRulesRoot();
		const machine = makeTempRulesRoot();
		const previous = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = machine;
		const rel = "rules/tree-sitter-queries/typescript/mid-cycle.yml";
		try {
			writeRule(
				project,
				rel,
				`id: mid-cycle\nname: OLD\nquery: |\n  (identifier) @X\n`,
			);
			const session = "mid-cycle-session";
			beginTurnContext(session);
			await runWithTurnContext(session, async () => {
				const loader = new TreeSitterQueryLoader();
				await loader.loadQueries(project);
				expect(loader.getQueryById("mid-cycle")?.name).toBe("OLD");

				writeRule(
					project,
					rel,
					`id: mid-cycle\nname: NEW\nquery: |\n  (identifier) @X\n`,
				);
				await loader.loadQueries(project);
				expect(loader.getQueryById("mid-cycle")?.name).toBe("OLD");

				const walksBefore = countProjectRuleWalks(project);
				await loader.loadQueries(project, { force: true });
				expect(loader.getQueryById("mid-cycle")?.name).toBe("NEW");
				// The forced reload did its own single fingerprint walk, then a
				// reload walk: this fixture holds one language directory, so
				// each walk is one listing of the queries root plus one of that
				// directory.
				const walksAfterForce = countProjectRuleWalks(project);
				expect(walksAfterForce - walksBefore).toBe((1 + 1) * 2);

				// The forced reload republished into this cycle, so the warm
				// call now agrees with it and does not walk the corpus again.
				await loader.loadQueries(project);
				expect(loader.getQueryById("mid-cycle")?.name).toBe("NEW");
				expect(countProjectRuleWalks(project) - walksAfterForce).toBe(0);
			});
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previous;
		}
	});
});

describe("scalar values drop trailing YAML comments", () => {
	it("keeps a commented post_filter usable as a filter name", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/commented-scalar.yml",
			`id: commented-scalar
name: Commented Scalar
severity: warning
category: quality
language: typescript
message: "uses # in a quoted message"
post_filter: not_in_test_block  # skip test blocks
query: |
  (identifier) @X
metavars: [X]
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("commented-scalar");
		// Carrying the comment into the name meant the filter never resolved and
		// the rule reported every raw match unfiltered.
		expect(query?.post_filter).toBe("not_in_test_block");
		expect(query?.message).toBe("uses # in a quoted message");
	});
});

// #3054: the hand-rolled line-regex scanner (its own inline-comment stripper,
// its own inline `[a, b]` array branch, its own multi-line `- item` branch,
// its own nested-object branch) is gone; `yaml.load` — the same real parser
// `clients/dispatch/runners/yaml-rule-parser.ts` already used for ast-grep
// rules (#206) — parses the whole document now. One fixture exercises every
// construct the deleted scanner special-cased, in the shape #3046 showed
// disagreeing: an inline array, a multi-line list, BOTH multi-line quote
// spellings (the exact defect: the inline-array branch unquoted, the
// multi-line branch didn't, so `console-statement.yml`'s quoted
// `ignore_paths` glob carried its quote marks and the #965 carve-out never
// matched a path), a nested object, and both an inline comment on an
// unquoted scalar and a literal `#` preserved inside a quoted one.
describe("fold onto js-yaml (#3054)", () => {
	it("parses inline arrays, multi-line lists in both quote spellings, nested objects, and inline/quoted comments in one document", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/all-constructs.yml",
			`id: all-constructs
name: All Constructs
severity: warning
category: correctness
language: typescript
message: "keeps a # inside a quoted string"
post_filter: not_in_test_block  # trailing comment stripped
query: |
  (identifier) @X
metavars: [X, Y]
tags:
  - alpha
  - beta
ignore_paths:
  - "scripts/**"
  - 'bin/**'
post_filter_params:
  KEY: "value"
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("all-constructs");
		expect(query).toBeTruthy();
		expect(query?.message).toBe("keeps a # inside a quoted string");
		expect(query?.post_filter).toBe("not_in_test_block");
		expect(query?.metavars).toEqual(["X", "Y"]);
		expect(query?.tags).toEqual(["alpha", "beta"]);
		expect(query?.ignore_paths).toEqual(["scripts/**", "bin/**"]);
		expect(query?.post_filter_params).toEqual({ KEY: "value" });
	});
});

// #3054 review F1: `yaml.load` throws on realistic authoring mistakes the
// deleted hand-rolled scanner tolerated (a colon in an unquoted scalar, a
// duplicate key, an unclosed quote, …), which widened the skip surface with
// no observability — the only sink was `dbg()`, gated behind `verbose`, and
// both production instantiations construct with the `verbose = false`
// default. A malformed rule must now leave a durable signal.
describe("malformed query files are recorded once per file (#3054 review F1)", () => {
	beforeEach(() => resetDegradationLedger());
	afterEach(() => resetDegradationLedger());

	function parseFailureGroup() {
		return getDegradationSummary().find(
			(g) => g.kind === "tree-sitter-query-parse-failed",
		);
	}

	it("records a degradation for a rule file yaml.load rejects, even with verbose:false (the production default)", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/broken-colon.yml",
			`id: broken-colon
name: Broken Colon
severity: warning
category: quality
language: typescript
message: some: unquoted colon breaks YAML
query: |
  (identifier) @X
`,
		);

		const loader = new TreeSitterQueryLoader(); // verbose defaults to false
		await loader.loadQueries(root);

		expect(loader.getQueryById("broken-colon")).toBeUndefined();
		const group = parseFailureGroup();
		expect(group?.count).toBe(1);
		expect(
			group?.latestReasons.some((r) => r.subject.endsWith("broken-colon.yml")),
		).toBe(true);
	});

	it("records a degradation for a syntactically valid document with a mapping-valued query (#3054 review F2)", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/mapping-query.yml",
			`id: mapping-query
name: Mapping Query
severity: warning
category: quality
language: typescript
message: forgot the block-scalar pipe
query:
  not: a string
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);

		// The old truthy-only check let this sail through as the literal
		// string "[object Object]"; the type-checked guard skips it instead.
		expect(loader.getQueryById("mapping-query")).toBeUndefined();
		const group = parseFailureGroup();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.reason).toContain("'query'");
	});

	// #3070 N1: `loadQueries` short-circuits on `this.loaded && this.loadedRoot
	// === resolvedRoot` before `parseQueryFile` runs, so a memoized (no
	// `force`) return in a LATER session never re-parses and never replays the
	// `tree-sitter-query-parse-failed` record for this session's generation.
	// `handleSessionStart` -> `resetDegradationLedger()` clears the once-keys
	// every session, but the loader's shared client (`clients/tree-sitter-shared.ts:39`)
	// and its `loaded`/`loadedRoot` memo are deliberately kept across
	// sessions, so the SECOND session's health summary silently loses the row
	// the first session recorded — the exact "silently drops to zero" shape
	// `getBundledQueriesRootHealth` (this file, generation-keyed) already
	// solves correctly.
	it("replays the parse-failure record on a memoized (no-force) reload after a session boundary (#3070 N1)", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/broken-colon.yml",
			`id: broken-colon
name: Broken Colon
severity: warning
category: quality
language: typescript
message: some: unquoted colon breaks YAML
query: |
  (identifier) @X
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(parseFailureGroup()?.count).toBe(1);

		// Session boundary: handleSessionStart's resetDegradationLedger() call,
		// simulated directly. The loader instance itself is NOT recreated —
		// tree-sitter-shared.ts deliberately keeps the client across sessions.
		resetDegradationLedger();
		expect(parseFailureGroup()).toBeUndefined();

		// No `force`: this is the memoized return path every non-RuleCache-miss
		// call takes. It must still carry the row in the NEW session's ledger.
		await loader.loadQueries(root);
		const group = parseFailureGroup();
		expect(group?.count).toBe(1);
		expect(
			group?.latestReasons.some((r) => r.subject.endsWith("broken-colon.yml")),
		).toBe(true);
	});

	// #3070 N2: `str()` (clients/tree-sitter-query-loader.ts) refuses a
	// mapping-valued scalar field so `message` falls back to the id-derived
	// default rather than stringifying to the literal text "[object Object]"
	// a user would otherwise read in the diagnostic. Unlike the `id`/`query`
	// mapping cases above (both load-blocking), a mapping-valued `message` is
	// non-fatal — the rule still loads — so this pins the FALLBACK behavior on
	// a field no other test in this file exercises with a non-scalar value.
	it("falls back to the id-derived message for a mapping-valued `message` field (#3070 N2)", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/mapping-message.yml",
			`id: mapping-message
name: Mapping Message
severity: warning
category: quality
language: typescript
message:
  not: a string
query: |
  (identifier) @X
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);

		const query = loader.getQueryById("mapping-message");
		expect(query).toBeTruthy();
		// A loosened guard would stringify the mapping to "[object Object]".
		expect(query?.message).toBe("Pattern: mapping-message");
	});

	// #3070 N1 companion: a FIXED rule must stop replaying once a fresh
	// (`force`) load re-parses it clean — the per-file memo the replay draws
	// on is repopulated on every non-memoized load, not merely appended to,
	// or a file corrected on disk keeps reporting its stale failure forever
	// across every later session boundary.
	it("stops replaying a parse failure once the rule file is fixed and force-reloaded", async () => {
		const root = makeTempRulesRoot();
		const relPath = "rules/tree-sitter-queries/typescript/fixable.yml";
		writeRule(
			root,
			relPath,
			`id: fixable
name: Fixable
severity: warning
category: quality
language: typescript
message: some: unquoted colon breaks YAML
query: |
  (identifier) @X
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(parseFailureGroup()?.count).toBe(1);

		// Fix the file on disk, then force-reload (the RuleCache-miss path).
		writeRule(
			root,
			relPath,
			`id: fixable
name: Fixable
severity: warning
category: quality
language: typescript
message: "no more colon problem"
query: |
  (identifier) @X
`,
		);
		await loader.loadQueries(root, { force: true });
		expect(loader.getQueryById("fixable")).toBeTruthy();

		// A later session must not resurrect the stale failure for a file
		// that is clean now.
		resetDegradationLedger();
		await loader.loadQueries(root);
		expect(parseFailureGroup()).toBeUndefined();
	});
});

// #3054 review F2: pins the corpus-wide equivalence claim in CI, not only in
// the PR body — a bundled rule that silently fails to parse (thrown syntax
// error, or a shape the type-checked `id`/`query` guard now rejects) shows up
// as a count mismatch here.
describe("bundled corpus loads in full (#3054 review F2)", () => {
	it("loads every .yml under rules/tree-sitter-queries/ — count mismatch means a bundled rule silently failed to parse", async () => {
		const fileCount = fs
			.readdirSync(BUNDLED_QUERIES_ROOT, { recursive: true })
			.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.endsWith(".yml"),
			).length;
		expect(fileCount).toBeGreaterThan(0);

		// An isolated, empty project root: loadQueries also scans
		// `rootDir/rules/tree-sitter-queries` when it exists, which would
		// double-count or shadow the bundled directory this test pins.
		const root = makeTempRulesRoot();
		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(loader.getAllQueries().length).toBe(fileCount);
	});
});

describe("queriesForLanguage", () => {
	const rule = (id: string, filePath: string): TreeSitterQuery =>
		({ id, filePath }) as TreeSitterQuery;

	const map = new Map<string, TreeSitterQuery[]>([
		[
			"typescript",
			[
				rule("ts-on", "rules/tree-sitter-queries/typescript/on.yml"),
				rule("ts-off", "rules/tree-sitter-queries/typescript-disabled/off.yml"),
			],
		],
		["tsx", [rule("tsx-own", "rules/tree-sitter-queries/tsx/own.yml")]],
		[
			"javascript",
			[rule("js-own", "rules/tree-sitter-queries/javascript/own.yml")],
		],
	]);

	it("never returns a rule from a -disabled directory", () => {
		expect(queriesForLanguage(map, "typescript").map((q) => q.id)).toEqual([
			"ts-on",
		]);
	});

	it("gives tsx the typescript rule set on top of its own", () => {
		expect(queriesForLanguage(map, "tsx").map((q) => q.id)).toEqual([
			"tsx-own",
			"ts-on",
		]);
	});

	it("does NOT give javascript the typescript rule set", () => {
		// Those rules are written against the typescript grammar: on a javascript
		// tree `duplicate-function-arg` alone reported 59 phantom duplicates.
		expect(queriesForLanguage(map, "javascript").map((q) => q.id)).toEqual([
			"js-own",
		]);
	});
});

describe("ruleSourceLanguages / ruleFilesForLanguage (#878)", () => {
	it("mirrors the rule-set composition queriesForLanguage applies", () => {
		// tsx is the one typescript-rule heir; javascript is deliberately not.
		expect(ruleSourceLanguages("tsx")).toEqual(["tsx", "typescript"]);
		expect(ruleSourceLanguages("typescript")).toEqual(["typescript"]);
		expect(ruleSourceLanguages("javascript")).toEqual(["javascript"]);
		expect(ruleSourceLanguages("python")).toEqual(["python"]);
	});

	it("enumerates project-local rule files across every rule-source language", () => {
		const root = makeTempRulesRoot();
		writeRule(root, "rules/tree-sitter-queries/tsx/own.yml", "id: tsx-own\n");
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/inherited.yml",
			"id: ts-rule\n",
		);
		writeRule(
			root,
			"rules/tree-sitter-queries/python/unrelated.yml",
			"id: py-rule\n",
		);
		// Non-.yml files never load, so they must not fingerprint either.
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/notes.txt",
			"not a rule\n",
		);

		const files = ruleFilesForLanguage("tsx", root).map((f) =>
			f.replaceAll("\\", "/"),
		);
		expect(files.some((f) => f.endsWith("tsx/own.yml"))).toBe(true);
		expect(files.some((f) => f.endsWith("typescript/inherited.yml"))).toBe(
			true,
		);
		expect(files.some((f) => f.endsWith("python/unrelated.yml"))).toBe(false);
		expect(files.some((f) => f.endsWith("notes.txt"))).toBe(false);

		// A non-heir language fingerprints only its own directory.
		const pyFiles = ruleFilesForLanguage("python", root).map((f) =>
			f.replaceAll("\\", "/"),
		);
		expect(pyFiles.some((f) => f.endsWith("python/unrelated.yml"))).toBe(true);
		expect(pyFiles.some((f) => f.endsWith("typescript/inherited.yml"))).toBe(
			false,
		);
	});
});

/**
 * #2636 (the #2626 class sweep's tree-sitter leg): `ruleFilesForLanguage`
 * resolving zero files is NORMAL for a language nobody has authored bundled
 * queries for by design — seven REACHABLE grammars have none:
 * bash, dart, elixir, lua, ocaml, swift, zig (`.sh`/`.bash`, `.dart`,
 * `.ex`/`.exs`, `.lua`, `.ml`/`.mli`, `.swift`, `.zig` — see
 * `language-registry.ts`'s `EXTENSION_TO_GRAMMAR`). cobol/plsql are NOT in
 * that registry at all (only their `-disabled` query directories exist), so
 * `ruleFilesForLanguage` never actually resolves those two languageIds in
 * production — `bash`/`lua` below are the REAL examples (#2636 review F2).
 * The two must never be confused: a record fires only when the shared ROOT
 * is unhealthy, never merely because ONE language's own subdirectory is
 * empty.
 */
describe("ruleFilesForLanguage — bundled root health (#2636)", () => {
	const notified: Array<{ message: string; level: string | undefined }> = [];

	beforeEach(() => {
		notified.length = 0;
		resetDegradationLedger();
		_resetBundledQueriesRootHealthForTests();
		vi.mocked(fs.readdirSync).mockClear();
		vi.mocked(fs.readdirSync).mockImplementation(actualFsRef.readdirSync);
		wireUserNotifier(() => (message, level) => {
			notified.push({ message, level });
		});
	});

	afterEach(() => {
		resetUserNotifier();
		resetDegradationLedger();
		_resetBundledQueriesRootHealthForTests();
		vi.mocked(fs.readdirSync).mockImplementation(actualFsRef.readdirSync);
		vi.restoreAllMocks();
	});

	function degradationGroup() {
		return getDegradationSummary().find(
			(g) => g.kind === "tree-sitter-queries-dir-missing",
		);
	}

	/**
	 * Makes the ONE real `BUNDLED_QUERIES_ROOT` directory read as absent
	 * (ENOENT), while every OTHER `readdirSync` call (this file's own temp
	 * rule dirs) still hits the real filesystem — same-file internal calls
	 * to `getBundledQueriesRootHealth` cannot be `vi.spyOn`-intercepted (see
	 * the file-header comment), so the memoized fact underneath it is forced
	 * unhealthy at the real fs layer instead.
	 */
	function mockBundledQueriesRootAbsent(): void {
		vi.mocked(fs.readdirSync).mockImplementation(((
			dir: Parameters<typeof actualFsRef.readdirSync>[0],
			...rest: unknown[]
		) => {
			if (dir === BUNDLED_QUERIES_ROOT) {
				throw Object.assign(new Error("no such directory"), {
					code: "ENOENT",
				});
			}
			// biome-ignore lint/suspicious/noExplicitAny: passthrough to the real overload set
			return (actualFsRef.readdirSync as any)(dir, ...rest);
		}) as typeof fs.readdirSync);
	}

	it("records nothing for bash: zero files, but the REAL bundled root is healthy (no queries authored by design)", () => {
		const root = makeTempRulesRoot();
		expect(ruleFilesForLanguage("bash", root)).toEqual([]);
		expect(degradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	// #2636 review F6: getBundledQueriesRootHealth's memo — a real,
	// measured per-call `readdirSync` cost paid on every dispatched file by
	// BOTH this cold branch and RuleCache's constructor — must survive
	// repeated calls across DIFFERENT by-design-empty languages, not just
	// repeated calls for the SAME one.
	it("memoizes the bundled root's health across calls, even for different languages", () => {
		const root = makeTempRulesRoot();
		ruleFilesForLanguage("bash", root);
		ruleFilesForLanguage("lua", root);
		ruleFilesForLanguage("bash", root);
		const bundledRootCalls = vi
			.mocked(fs.readdirSync)
			.mock.calls.filter(([dir]) => dir === BUNDLED_QUERIES_ROOT);
		expect(bundledRootCalls).toHaveLength(1);
	});

	// #2636 review round 2, F3: the memo must re-probe once per SESSION
	// (never once forever) — a managed-cache relocation of a LIVE install is
	// exactly the failure #2587/#2626 investigated, so a permanently-cached
	// "absent" verdict from the first probe would never notice the directory
	// coming back (or a healthy root going away) later in the same process.
	it("re-probes exactly once after a session boundary (resetDegradationLedger), not on every call within it", () => {
		mockBundledQueriesRootAbsent();
		const root = makeTempRulesRoot();

		ruleFilesForLanguage("bash", root);
		ruleFilesForLanguage("lua", root);
		expect(
			vi
				.mocked(fs.readdirSync)
				.mock.calls.filter(([dir]) => dir === BUNDLED_QUERIES_ROOT),
		).toHaveLength(1);

		// Session boundary — runtime-session.ts's handleSessionStart calls
		// this first thing in production.
		resetDegradationLedger();

		ruleFilesForLanguage("bash", root);
		ruleFilesForLanguage("lua", root);
		expect(
			vi
				.mocked(fs.readdirSync)
				.mock.calls.filter(([dir]) => dir === BUNDLED_QUERIES_ROOT),
		).toHaveLength(2);
	});

	it("never touches the bundled root's own readdirSync on the common, non-empty path (typescript)", () => {
		const root = makeTempRulesRoot();
		expect(ruleFilesForLanguage("typescript", root).length).toBeGreaterThan(0);
		const bundledRootCalls = vi
			.mocked(fs.readdirSync)
			.mock.calls.filter(([dir]) => dir === BUNDLED_QUERIES_ROOT);
		expect(bundledRootCalls).toHaveLength(0);
	});

	it("records a bounded degradation + notify when the bundled root is actually gone", () => {
		mockBundledQueriesRootAbsent();
		const root = makeTempRulesRoot();

		expect(ruleFilesForLanguage("bash", root)).toEqual([]);

		const group = degradationGroup();
		expect(group).toBeDefined();
		expect(group?.latestReasons.at(-1)?.subject).toBe(BUNDLED_QUERIES_ROOT);
		expect(notified).toHaveLength(1);
		expect(notified[0].message).toContain(
			"bundled tree-sitter query rules unavailable",
		);
	});

	it("collapses every zero-file language into ONE ledger row, not one per language", () => {
		mockBundledQueriesRootAbsent();
		const root = makeTempRulesRoot();

		ruleFilesForLanguage("bash", root);
		ruleFilesForLanguage("lua", root);
		ruleFilesForLanguage("bash", root);

		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(3);
		expect(
			getDegradationSummary().filter(
				(g) => g.kind === "tree-sitter-queries-dir-missing",
			),
		).toHaveLength(1);
	});

	// #2636 review round 2, F2: the ONLY observability record for this branch
	// is the degradation ledger row — no separate phase/latency record (see
	// the source comment). `incrementDegradationCount` bounds durable writes
	// to power-of-two milestones on its own; this pins that MANY occurrences
	// of the same failure still write exactly ONE bounded row (not one raw
	// row per dispatched file), directly answering "what would 200 touches
	// of a broken root cost" — the ledger's in-memory `count` is the exact
	// total regardless of how many of those are durably persisted.
	it("tallies many occurrences into the ledger's exact count, never a raw per-call record", () => {
		mockBundledQueriesRootAbsent();
		const root = makeTempRulesRoot();

		for (let i = 0; i < 200; i++) {
			ruleFilesForLanguage("bash", root);
		}

		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(200);
		expect(
			getDegradationSummary().filter(
				(g) => g.kind === "tree-sitter-queries-dir-missing",
			),
		).toHaveLength(1);
	});
});
