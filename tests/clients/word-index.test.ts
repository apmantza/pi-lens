import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	buildWordIndexQueryFilter,
	centralityFromReverseDeps,
	deserializeWordIndex,
	getWordIndexBuildStatus,
	getWordIndexWireBytes,
	parseWordIndexQuery,
	flushWordIndexRecompactionsForTests,
	searchWordIndex,
	serializeWordIndex,
	splitIdentifier,
	tokenizeLine,
	updateWordIndexDocument,
	WORD_INDEX_FORMAT_VERSION,
	WordIndexQueryError,
	wordIndexKey,
	_resetWordIndexBuildGuardForTests,
	triggerBackgroundWordIndexBuild,
} from "../../clients/word-index.js";
import {
	compactPostingsIntoArena,
	compactPostingsIntoArenaCooperatively,
	countPostingBackingStores,
	estimateWordIndexStoreBytes,
	WORD_POSTING_LIST_OVERHEAD_BYTES,
	WordPostingList,
} from "../../clients/word-index-store.js";
import { KIND_EXTENSIONS } from "../../clients/file-kinds.js";
import { loadProjectSnapshot } from "../../clients/project-snapshot.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

/**
 * Arena repacks recorded so far, read from the degradation ledger's own
 * `word-index-arena-recompact` tally (#2117) rather than a parallel counter —
 * `recompactWordIndexPostingsIfNeeded` bumps that ledger once per repack.
 */
function recompactionCount(): number {
	return (
		getDegradationSummary().find(
			(group) => group.kind === "word-index-arena-recompact",
		)?.count ?? 0
	);
}

describe("splitIdentifier", () => {
	it("splits camelCase and keeps the whole identifier", () => {
		expect(splitIdentifier("getUserByID")).toEqual(
			expect.arrayContaining(["getuserbyid", "get", "user", "by", "id"]),
		);
	});

	it("splits PascalCase acronym boundaries", () => {
		const parts = splitIdentifier("HTTPServerConfig");
		expect(parts).toEqual(expect.arrayContaining(["http", "server", "config"]));
	});

	it("splits snake_case, kebab, and digit boundaries (dropping 1-char tokens)", () => {
		// Sub-tokens at digit boundaries are produced; single-char "2"/"5" are
		// dropped as noise (the >=2 floor), but multi-char parts survive.
		expect(splitIdentifier("MAX_RETRY_2")).toEqual(
			expect.arrayContaining(["max", "retry"]),
		);
		expect(splitIdentifier("MAX_RETRY_2")).not.toContain("2");
		expect(splitIdentifier("parseHtml5Doc")).toEqual(
			expect.arrayContaining(["parse", "html", "doc"]),
		);
	});

	it("drops stopwords and sub-2-char fragments", () => {
		// "const" is a stopword; "x" is too short.
		expect(splitIdentifier("const")).toEqual([]);
		expect(splitIdentifier("x")).toEqual([]);
	});
});

describe("tokenizeLine", () => {
	it("extracts identifiers and splits them, ignoring punctuation/operators", () => {
		const tokens = tokenizeLine("  const userName = getUser(accountId);");
		expect(tokens).toEqual(
			expect.arrayContaining([
				"username",
				"user",
				"name",
				"getuser",
				"account",
				"id",
			]),
		);
		expect(tokens).not.toContain("const");
	});

	it("returns nothing for a line with no identifiers", () => {
		expect(tokenizeLine("   () => { + - * }")).toEqual([]);
	});
});

// #1450: lang:/file:/ext: prefix filters mixed into the plain query string.
describe("parseWordIndexQuery (#1450)", () => {
	it("splits plain terms with no filters, unchanged", () => {
		const parsed = parseWordIndexQuery("authenticate user");
		expect(parsed.terms).toBe("authenticate user");
		expect(parsed.filters).toEqual([]);
	});

	it("extracts a lang: filter", () => {
		const parsed = parseWordIndexQuery("lang:jsts rank");
		expect(parsed.terms.trim()).toBe("rank");
		expect(parsed.filters).toEqual([
			{ key: "lang", value: "jsts", negated: false },
		]);
	});

	it("extracts a file: filter", () => {
		const parsed = parseWordIndexQuery("file:clients/ rank");
		expect(parsed.terms.trim()).toBe("rank");
		expect(parsed.filters).toEqual([
			{ key: "file", value: "clients/", negated: false },
		]);
	});

	it("extracts an ext: filter", () => {
		const parsed = parseWordIndexQuery("ext:ts rank");
		expect(parsed.terms.trim()).toBe("rank");
		expect(parsed.filters).toEqual([
			{ key: "ext", value: "ts", negated: false },
		]);
	});

	it("extracts a negated filter with a leading -", () => {
		const parsed = parseWordIndexQuery("-file:test rank");
		expect(parsed.terms.trim()).toBe("rank");
		expect(parsed.filters).toEqual([
			{ key: "file", value: "test", negated: true },
		]);
	});

	it("extracts mixed filters and terms in the issue's own example", () => {
		const parsed = parseWordIndexQuery("lang:ts file:clients/ -file:test rank");
		expect(parsed.terms.trim()).toBe("rank");
		expect(parsed.filters).toEqual([
			{ key: "lang", value: "ts", negated: false },
			{ key: "file", value: "clients/", negated: false },
			{ key: "file", value: "test", negated: true },
		]);
	});

	it("passes an unknown colon token through as an ordinary term", () => {
		// Legitimate search terms carry colons: C++ scope operators, log
		// prefixes, URLs, Windows paths, TODO tags. None may throw; all must
		// search as plain terms, matching the pre-filter behavior.
		for (const query of [
			"std::vector rank",
			"error:foo",
			"http://example.com",
			"TODO:fixme",
			String.raw`C:\Users\foo`,
			"type:foo rank",
		]) {
			const parsed = parseWordIndexQuery(query);
			expect(parsed.filters).toEqual([]);
			expect(parsed.terms).toBe(query);
		}
	});

	it("still throws WordIndexQueryError for a KNOWN key with a bad value", () => {
		// The throw lives at filter-build time (eager resolution), not parse.
		const parsed = parseWordIndexQuery("lang:notalang rank");
		let caught: unknown;
		try {
			buildWordIndexQueryFilter(parsed.filters);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WordIndexQueryError);
	});

	it("treats a bare hyphenated term (no colon) as an ordinary term, not a filter", () => {
		const parsed = parseWordIndexQuery("-rank other");
		expect(parsed.filters).toEqual([]);
		expect(parsed.terms.trim()).toBe("-rank other");
	});

	it("treats an empty-value key: as an ordinary term, not a filter", () => {
		const parsed = parseWordIndexQuery("lang: rank");
		expect(parsed.filters).toEqual([]);
		expect(parsed.terms.trim()).toBe("lang: rank");
	});
});

// `file:` case behavior mirrors the SAME normalizer the index's own
// path-keyed maps already fold through (#1025) — probe its REAL behavior
// rather than branching on `process.platform` (the #1024/shape-2/shape-7
// class): folds case only where the host's map-key normalizer does
// (win32), never on a case-sensitive FS (e.g. Linux CI), so this test is
// honest either way instead of vacuously passing.
const WORD_INDEX_KEY_FOLDS_CASE = wordIndexKey("A.ts") === wordIndexKey("a.ts");

describe("buildWordIndexQueryFilter (#1450)", () => {
	it("lang: accepts every KIND_EXTENSIONS key — no second, hand-maintained language list (#894)", () => {
		// Coverage-style assertion: the accepted `lang:` values ARE
		// KIND_EXTENSIONS' own keys, proven by resolving each key through the
		// real filter builder rather than any duplicated list.
		for (const kind of Object.keys(KIND_EXTENSIONS)) {
			const predicate = buildWordIndexQueryFilter([
				{ key: "lang", value: kind, negated: false },
			]);
			expect(predicate).toBeTypeOf("function");
		}
	});

	it("lang: throws for an unrecognized kind, listing known kinds", () => {
		expect(() =>
			buildWordIndexQueryFilter([
				{ key: "lang", value: "klingon", negated: false },
			]),
		).toThrow(WordIndexQueryError);
	});

	it("lang: matches files by KIND_EXTENSIONS extension set", () => {
		const predicate = buildWordIndexQueryFilter([
			{ key: "lang", value: "python", negated: false },
		]);
		expect(predicate?.("scripts/tool.py")).toBe(true);
		expect(predicate?.("src/tool.ts")).toBe(false);
	});

	it("ext: normalizes with or without a leading dot", () => {
		const withDot = buildWordIndexQueryFilter([
			{ key: "ext", value: ".ts", negated: false },
		]);
		const withoutDot = buildWordIndexQueryFilter([
			{ key: "ext", value: "ts", negated: false },
		]);
		expect(withDot?.("src/tool.ts")).toBe(true);
		expect(withoutDot?.("src/tool.ts")).toBe(true);
		expect(withDot?.("src/tool.tsx")).toBe(false);
	});

	it("file: substring-matches the (wordIndexKey-normalized) path", () => {
		const predicate = buildWordIndexQueryFilter([
			{ key: "file", value: "clients/", negated: false },
		]);
		expect(predicate?.("clients/word-index.ts")).toBe(true);
		expect(predicate?.("tools/symbol-search.ts")).toBe(false);
	});

	it("file: matches regardless of separator (backslash vs forward slash, all platforms)", () => {
		const predicate = buildWordIndexQueryFilter([
			{ key: "file", value: "clients/word-index.ts", negated: false },
		]);
		expect(predicate?.("sub\\clients\\word-index.ts")).toBe(true);
	});

	it.skipIf(!WORD_INDEX_KEY_FOLDS_CASE)(
		"file: is case-insensitive on a case-insensitive FS (win32)",
		() => {
			const predicate = buildWordIndexQueryFilter([
				{ key: "file", value: "CLIENTS/", negated: false },
			]);
			expect(predicate?.("clients/word-index.ts")).toBe(true);
		},
	);

	it.skipIf(WORD_INDEX_KEY_FOLDS_CASE)(
		"file: is case-SENSITIVE on a case-sensitive FS (POSIX/Linux CI)",
		() => {
			const predicate = buildWordIndexQueryFilter([
				{ key: "file", value: "CLIENTS/", negated: false },
			]);
			expect(predicate?.("clients/word-index.ts")).toBe(false);
		},
	);

	it("same-key positive filters OR together", () => {
		const predicate = buildWordIndexQueryFilter([
			{ key: "lang", value: "python", negated: false },
			{ key: "lang", value: "go", negated: false },
		]);
		expect(predicate?.("a.py")).toBe(true);
		expect(predicate?.("b.go")).toBe(true);
		expect(predicate?.("c.ts")).toBe(false);
	});

	it("different-key filters AND together", () => {
		const predicate = buildWordIndexQueryFilter([
			{ key: "lang", value: "jsts", negated: false },
			{ key: "file", value: "clients/", negated: false },
		]);
		expect(predicate?.("clients/word-index.ts")).toBe(true);
		expect(predicate?.("tools/word-index.ts")).toBe(false);
		expect(predicate?.("clients/tool.py")).toBe(false);
	});

	it("negations always subtract, even against a matching positive filter", () => {
		const predicate = buildWordIndexQueryFilter([
			{ key: "file", value: "clients/", negated: false },
			{ key: "file", value: "test", negated: true },
		]);
		expect(predicate?.("clients/word-index.ts")).toBe(true);
		expect(predicate?.("clients/word-index.test.ts")).toBe(false);
	});
});

describe("buildWordIndex + searchWordIndex", () => {
	const files = [
		{
			path: "src/auth/login.ts",
			content:
				"export function authenticateUser(credentials) {\n  return verifyPassword(credentials);\n}",
		},
		{
			path: "src/user/profile.ts",
			content:
				"export function loadUserProfile(userId) {\n  return db.users.find(userId);\n}",
		},
		{
			path: "src/util/format.ts",
			content: "export function formatDate(date) {\n  return date.toISO();\n}",
		},
	];

	it("ranks the file whose identifiers match the query first", () => {
		const index = buildWordIndex(files);
		const results = searchWordIndex(index, "authenticate user");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].file).toBe("src/auth/login.ts");
		expect(results[0].lines).toContain(1);
	});

	it("returns no results for a query with no matching tokens", () => {
		const index = buildWordIndex(files);
		expect(searchWordIndex(index, "kubernetes helm chart")).toEqual([]);
	});

	it("matches a sub-token of a compound identifier", () => {
		const index = buildWordIndex(files);
		const results = searchWordIndex(index, "profile");
		expect(results[0].file).toBe("src/user/profile.ts");
	});

	it("respects the result limit", () => {
		const index = buildWordIndex(files);
		const results = searchWordIndex(index, "user", { limit: 1 });
		expect(results).toHaveLength(1);
	});
});

// #771: symbol_search's `paths`/`lang` params compile down to a `fileFilter`
// predicate applied BEFORE scoring — a surviving file's score must be
// byte-identical to what an unfiltered query would have produced for it.
describe("searchWordIndex fileFilter (#771)", () => {
	const files = [
		{
			path: "src/auth/login.ts",
			content:
				"export function authenticateUser(credentials) {\n  return verifyPassword(credentials);\n}",
		},
		{
			path: "src/user/profile.ts",
			content:
				"export function loadUserProfile(userId) {\n  return db.users.find(userId);\n}",
		},
	];

	it("drops files the predicate rejects without changing surviving files' scores", () => {
		const index = buildWordIndex(files);
		const unfiltered = searchWordIndex(index, "user");
		expect(unfiltered.map((r) => r.file)).toEqual(
			expect.arrayContaining(["src/auth/login.ts", "src/user/profile.ts"]),
		);
		const unfilteredProfile = unfiltered.find(
			(r) => r.file === "src/user/profile.ts",
		);

		const filtered = searchWordIndex(index, "user", {
			fileFilter: (file) => file.startsWith("src/user/"),
		});
		expect(filtered.map((r) => r.file)).toEqual(["src/user/profile.ts"]);
		expect(filtered[0].score).toBe(unfilteredProfile?.score);
	});

	it("omitting fileFilter reproduces the unfiltered result set", () => {
		const index = buildWordIndex(files);
		const withUndefinedFilter = searchWordIndex(index, "user", {
			fileFilter: undefined,
		});
		const plain = searchWordIndex(index, "user");
		expect(withUndefinedFilter).toEqual(plain);
	});
});

// #1450: the SAME query-string filter syntax exercised end-to-end through
// searchWordIndex, which is the word-index query entry point both symbol_search
// and pilens_symbol_search forward their raw `query` argument into unchanged.
describe("searchWordIndex inline query filters (#1450)", () => {
	const files = [
		{
			path: "src/auth/login.ts",
			content:
				"export function authenticateUser(credentials) {\n  return verifyPassword(credentials);\n}",
		},
		{
			path: "src/user/profile.ts",
			content:
				"export function loadUserProfile(userId) {\n  return db.users.find(userId);\n}",
		},
		{
			path: "scripts/authenticate.py",
			content: "def authenticate_user(id):\n    return id\n",
		},
		{
			path: "src/user/profile.test.ts",
			content:
				"export function loadUserProfile(userId) {\n  return db.users.find(userId);\n}",
		},
	];

	it("an unfiltered query is byte-identical to before (regression guard)", () => {
		const index = buildWordIndex(files);
		const before = searchWordIndex(index, "user");
		const after = searchWordIndex(index, "user");
		expect(after).toEqual(before);
	});

	it("filters BEFORE ranking: the filtered top hit differs from the unfiltered global top", () => {
		const index = buildWordIndex(files);
		const unfiltered = searchWordIndex(index, "user");
		// The global top hit for "user" is whichever file scores highest overall.
		expect(unfiltered[0].file).not.toBe("scripts/authenticate.py");

		// Excluding the global top via a lang: filter changes what wins.
		const filtered = searchWordIndex(index, "lang:python user");
		expect(filtered).toHaveLength(1);
		expect(filtered[0].file).toBe("scripts/authenticate.py");
		expect(filtered[0].file).not.toBe(unfiltered[0].file);
	});

	it("file: filter scopes hits to a path substring", () => {
		const index = buildWordIndex(files);
		const results = searchWordIndex(index, "file:auth/ user");
		expect(results.map((r) => r.file)).toEqual(["src/auth/login.ts"]);
	});

	it("negated file: filter excludes matching paths", () => {
		const index = buildWordIndex(files);
		const results = searchWordIndex(index, "-file:test profile");
		expect(results.map((r) => r.file)).toEqual(["src/user/profile.ts"]);
	});

	it("combined lang:/file:/-file: filters from the issue's own example", () => {
		const index = buildWordIndex(files);
		const results = searchWordIndex(
			index,
			"lang:jsts file:src/ -file:test user",
		);
		expect(results.map((r) => r.file).sort()).toEqual(
			["src/auth/login.ts", "src/user/profile.ts"].sort(),
		);
	});

	it("an unknown lang: value propagates WordIndexQueryError out of searchWordIndex", () => {
		const index = buildWordIndex(files);
		expect(() => searchWordIndex(index, "lang:klingon user")).toThrow(
			WordIndexQueryError,
		);
	});

	it("empty result after filtering is a normal empty array, not a thrown error", () => {
		const index = buildWordIndex(files);
		expect(searchWordIndex(index, "lang:go user")).toEqual([]);
	});

	it("composes (AND) with a caller-supplied fileFilter option", () => {
		const index = buildWordIndex(files);
		const results = searchWordIndex(index, "lang:jsts user", {
			fileFilter: (file) => file.startsWith("src/auth/"),
		});
		expect(results.map((r) => r.file)).toEqual(["src/auth/login.ts"]);
	});
});

describe("searchWordIndex priors", () => {
	it("demotes a test-path file below an equivalent source match", () => {
		const index = buildWordIndex([
			{ path: "src/widget.ts", content: "function renderWidget() {}" },
			{ path: "tests/widget.test.ts", content: "function renderWidget() {}" },
		]);
		const results = searchWordIndex(index, "render widget");
		expect(results[0].file).toBe("src/widget.ts");
		const test = results.find((r) => r.file === "tests/widget.test.ts");
		expect(test).toBeDefined();
		expect(results[0].score).toBeGreaterThan(test!.score);
	});

	it("demotes a doc/data file below a source match", () => {
		const index = buildWordIndex([
			{ path: "src/widget.ts", content: "function renderWidget() {}" },
			{ path: "docs/widget.md", content: "renderWidget renders the widget" },
		]);
		const results = searchWordIndex(index, "render widget");
		expect(results[0].file).toBe("src/widget.ts");
	});

	it("demotes vendor and generated-tree matches below equivalent source code", () => {
		const index = buildWordIndex([
			{ path: "src/widget.ts", content: "function renderWidget() {}" },
			{ path: "vendor/widget.ts", content: "function renderWidget() {}" },
			{ path: "dist/widget.js", content: "function renderWidget() {}" },
		]);
		const results = searchWordIndex(index, "render widget");
		const source = results.find((result) => result.file === "src/widget.ts");
		const vendor = results.find((result) => result.file === "vendor/widget.ts");
		const generated = results.find(
			(result) => result.file === "dist/widget.js",
		);

		expect(results[0].file).toBe("src/widget.ts");
		expect(source?.score).toBeGreaterThan(vendor?.score ?? 0);
		expect(source?.score).toBeGreaterThan(generated?.score ?? 0);
	});

	it("boosts a well-connected file via centrality", () => {
		const files = [
			{ path: "src/a.ts", content: "function sharedHelper() {}" },
			{ path: "src/b.ts", content: "function sharedHelper() {}" },
		];
		const index = buildWordIndex(files);
		const baseline = searchWordIndex(index, "shared helper");
		// Without centrality the two are tied → alphabetical: a before b.
		expect(baseline[0].file).toBe("src/a.ts");
		// Give b high centrality → it should now rank first.
		const boosted = searchWordIndex(index, "shared helper", {
			centrality: new Map([["src/b.ts", 25]]),
		});
		expect(boosted[0].file).toBe("src/b.ts");
	});
});

describe("centralityFromReverseDeps", () => {
	const index = buildWordIndex([
		{ path: "src/a.ts", content: "function helper() {}" },
		{ path: "src/b.ts", content: "function helper() {}" },
	]);

	it("maps importedBy counts onto the index's own file keys", () => {
		const centrality = centralityFromReverseDeps(index, {
			"src/a.ts": ["x.ts", "y.ts", "z.ts"],
		});
		expect(centrality.get("src/a.ts")).toBe(3);
		expect(centrality.has("src/b.ts")).toBe(false); // no importers → omitted
	});

	it("applies the injected key normalizer to bridge snapshot keys", () => {
		const centrality = centralityFromReverseDeps(
			index,
			{ "SRC/A.TS": ["x.ts"] },
			(file) => file.toUpperCase(),
		);
		expect(centrality.get("src/a.ts")).toBe(1);
	});

	it("returns empty when reverseDeps is absent", () => {
		expect(centralityFromReverseDeps(index, undefined).size).toBe(0);
	});

	it("feeds searchWordIndex to reorder tied files", () => {
		const ranked = searchWordIndex(index, "helper", {
			centrality: centralityFromReverseDeps(index, {
				"src/b.ts": ["a", "b", "c"],
			}),
		});
		expect(ranked[0].file).toBe("src/b.ts");
	});
});

describe("serializeWordIndex / deserializeWordIndex", () => {
	const files = [
		{ path: "src/a.ts", content: "function alphaHandler() {}" },
		{ path: "src/b.ts", content: "function betaHandler(alpha) {}" },
	];

	it("leaves wire bytes unset until the snapshot persist measures them (#4129)", () => {
		const index = buildWordIndex(files);
		serializeWordIndex(index);
		// Recurrence: measuring JSON in serializeWordIndex puts whole-index work
		// back on every incremental persist and defeats the occupancy guard (#2068).
		expect(getWordIndexWireBytes(index)).toBeNull();
	});

	it("round-trips to identical search behavior", () => {
		const index = buildWordIndex(files);
		const round = deserializeWordIndex(serializeWordIndex(index));
		expect(round).not.toBeNull();
		expect(round!.docCount).toBe(index.docCount);
		expect(round!.totalTokens).toBe(index.totalTokens);

		const before = searchWordIndex(index, "alpha handler");
		const after = searchWordIndex(round!, "alpha handler");
		expect(after.map((r) => r.file)).toEqual(before.map((r) => r.file));
		expect(after[0].score).toBeCloseTo(before[0].score, 10);
	});

	it("references files by index to avoid repeating paths", () => {
		const serialized = serializeWordIndex(buildWordIndex(files));
		expect(serialized.files).toEqual(["src/a.ts", "src/b.ts"]);
		// "handler" appears in both files → its postings reference both indices.
		const handler = serialized.postings.find(([token]) => token === "handler");
		expect(handler).toBeDefined();
		expect(handler![1]).toEqual(expect.arrayContaining([0, 1]));
	});

	it("round-trips indexed-file coverage and truncation (#928)", () => {
		const cappedFiles = Object.assign([...files], { truncated: true });
		const serialized = serializeWordIndex(buildWordIndex(cappedFiles));
		expect(serialized.indexedFileCount).toBe(2);
		expect(serialized.truncated).toBe(true);
		expect(deserializeWordIndex(serialized)).toMatchObject({
			docCount: 2,
			truncated: true,
		});
	});

	it("treats missing legacy coverage fields as not truncated (#928)", () => {
		const serialized = serializeWordIndex(buildWordIndex(files));
		delete serialized.indexedFileCount;
		delete serialized.truncated;
		expect(deserializeWordIndex(serialized)).toMatchObject({
			docCount: 2,
			truncated: false,
		});
	});

	it("returns null for malformed serialized input", () => {
		expect(deserializeWordIndex(null)).toBeNull();
		expect(deserializeWordIndex({} as never)).toBeNull();
	});

	it("treats a legacy serializer version as a cache miss (#958)", () => {
		const serialized = serializeWordIndex(buildWordIndex(files));
		// Deliberately pinned to the literal 1, one below WORD_INDEX_FORMAT_VERSION,
		// to exercise the legacy-format rejection path itself. If the format
		// version is ever bumped to 1 this assertion fails loudly instead of the
		// test silently testing nothing (the #1082/#1106 vacuous-fixture class).
		expect(WORD_INDEX_FORMAT_VERSION).not.toBe(1);
		const legacy = { ...serialized, version: 1 };
		expect(deserializeWordIndex(legacy as never)).toBeNull();
	});
});

describe("triggerBackgroundWordIndexBuild (#348 cold-query stampede guard)", () => {
	beforeEach(() => {
		// #958: the snapshot body is written by a worker thread by default. This
		// suite seeds a snapshot and then triggers a background word-index build
		// that reads it back (via `project-snapshot.js`) to preserve unrelated
		// fields — but the test's own seed save goes through `project-snapshot.ts`,
		// a DISTINCT module instance whose in-process authoritative-write map the
		// build cannot see. Pre-#958 the synchronous disk write bridged the two;
		// forcing the sync writer restores that so the cross-module read observes
		// the seed on disk. (The async worker offload is covered directly by
		// project-snapshot.test.ts.) Production imports `.js` everywhere — a single
		// module instance — so the authoritative map bridges this without disk.
		process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
	});
	afterEach(() => {
		delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
		_resetWordIndexBuildGuardForTests();
	});

	it("builds and persists a word index for a cwd with no prior snapshot", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-cold-");
		try {
			createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export function authenticateUser(id) { return id; }",
			);
			triggerBackgroundWordIndexBuild(env.tmpDir);
			await vi.waitFor(
				() => {
					const snapshot = loadProjectSnapshot(env.tmpDir);
					expect(snapshot?.wordIndex).toBeDefined();
				},
				{ timeout: 5000 },
			);
			const snapshot = loadProjectSnapshot(env.tmpDir);
			const index = deserializeWordIndex(snapshot!.wordIndex);
			expect(index).not.toBeNull();
			const results = searchWordIndex(index!, "authenticate user");
			expect(results.length).toBeGreaterThan(0);
			expect(path.basename(results[0].file)).toBe("auth.ts");
		} finally {
			env.cleanup();
		}
	}, 10_000);

	// #747 hardening: this trigger is the one word-index build path with no
	// canWarmCaches gate in front of it — a cold symbol_search from a
	// $HOME-rooted cwd must refuse instead of walking-and-reading the whole
	// home tree.
	it("refuses to build when cwd is at or above the home directory (#747)", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-unsafe-root-");
		try {
			createTempFile(env.tmpDir, "src/a.ts", "export function helperA() {}");
			const messages: string[] = [];
			triggerBackgroundWordIndexBuild(env.tmpDir, (m) => messages.push(m), {
				homeDir: env.tmpDir,
			});
			// The refusal is synchronous — no build is ever scheduled.
			expect(messages.some((m) => m.includes("at/above home directory"))).toBe(
				true,
			);
			expect(getWordIndexBuildStatus(env.tmpDir)).toMatchObject({
				state: "refused",
				reason: expect.stringContaining("at/above home directory"),
			});
			// Give any (wrongly) scheduled build a beat to persist, then confirm
			// nothing was written.
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(loadProjectSnapshot(env.tmpDir)?.wordIndex).toBeUndefined();
		} finally {
			env.cleanup();
		}
	}, 10_000);

	it("remembers a failed build outcome after the in-flight attempt ends (#926)", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-failed-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		try {
			createTempFile(env.tmpDir, "src/a.ts", "export function helperA() {}");
			process.env.PILENS_DATA_DIR = createTempFile(
				env.tmpDir,
				"not-a-directory",
				"occupied",
			);
			const messages: string[] = [];
			triggerBackgroundWordIndexBuild(env.tmpDir, (message) =>
				messages.push(message),
			);

			await vi.waitFor(() => {
				expect(getWordIndexBuildStatus(env.tmpDir)?.state).toBe("failed");
			});
			expect(getWordIndexBuildStatus(env.tmpDir)).toMatchObject({
				state: "failed",
				reason: expect.any(String),
			});
			expect(messages.some((message) => message.includes("failed"))).toBe(true);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	}, 10_000);

	it("still builds for a project directory UNDER the home directory (#747)", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-under-home-");
		try {
			const project = path.join(env.tmpDir, "code", "app");
			createTempFile(project, "src/a.ts", "export function helperA() {}");
			triggerBackgroundWordIndexBuild(project, undefined, {
				homeDir: env.tmpDir,
			});
			await vi.waitFor(
				() => {
					const snapshot = loadProjectSnapshot(project);
					expect(snapshot?.wordIndex).toBeDefined();
				},
				{ timeout: 5000 },
			);
		} finally {
			env.cleanup();
		}
	}, 10_000);

	it("dedupes concurrent triggers for the same cwd (stampede guard)", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-stampede-");
		try {
			createTempFile(env.tmpDir, "src/a.ts", "export function helperA() {}");
			// Fire several times back-to-back — only one build should actually run;
			// the guard is a Set keyed by resolved cwd, so a second call while the
			// first is still in flight is a no-op (fire-and-forget, no error either
			// way — this just asserts it doesn't throw / double-schedule visibly).
			triggerBackgroundWordIndexBuild(env.tmpDir);
			triggerBackgroundWordIndexBuild(env.tmpDir);
			triggerBackgroundWordIndexBuild(env.tmpDir);
			await vi.waitFor(
				() => {
					const snapshot = loadProjectSnapshot(env.tmpDir);
					expect(snapshot?.wordIndex).toBeDefined();
				},
				{ timeout: 5000 },
			);
		} finally {
			env.cleanup();
		}
	}, 10_000);

	it("preserves other snapshot fields when persisting the built index", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-preserve-");
		try {
			createTempFile(env.tmpDir, "src/a.ts", "export function helperA() {}");
			// Seed a snapshot (as a real session would) with unrelated data.
			const { saveProjectSnapshot, PROJECT_SNAPSHOT_VERSION } =
				await import("../../clients/project-snapshot.js");
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 7,
				files: {},
				symbols: {},
				reverseDeps: { "some/file.ts": ["some/importer.ts"] },
				cachedExports: [["helperA", "src/a.ts"]],
			});
			triggerBackgroundWordIndexBuild(env.tmpDir);
			await vi.waitFor(
				() => {
					const snapshot = loadProjectSnapshot(env.tmpDir);
					expect(snapshot?.wordIndex).toBeDefined();
				},
				{ timeout: 5000 },
			);
			const snapshot = loadProjectSnapshot(env.tmpDir);
			expect(snapshot?.seq).toBe(7);
			expect(snapshot?.cachedExports).toEqual([["helperA", "src/a.ts"]]);
			expect(snapshot?.reverseDeps).toEqual({
				"some/file.ts": ["some/importer.ts"],
			});
		} finally {
			env.cleanup();
		}
	}, 10_000);

	it("recompacts the arena after full-corpus incremental churn (#2117)", async () => {
		const env = setupTestEnvironment("pi-lens-wordindex-recompact-");
		try {
			for (let file = 0; file < 100; file += 1) {
				createTempFile(
					env.tmpDir,
					`src/f${file}.ts`,
					`sharedToken stableToken${file}`,
				);
			}
			const docs = await collectWordIndexDocs(env.tmpDir);
			const index = buildWordIndex(docs);
			for (let file = 0; file < 100; file += 1) {
				createTempFile(
					env.tmpDir,
					`src/f${file}.ts`,
					`sharedToken changedToken${file} revision`,
				);
			}
			for (let file = 0; file < 100; file += 1) {
				updateWordIndexDocument(index, {
					path: path.join(env.tmpDir, "src", `f${file}.ts`),
					content: `sharedToken changedToken${file} revision`,
				});
			}
			await flushWordIndexRecompactionsForTests(index);
			expect(countPostingBackingStores(index.postings)).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	// #2246: the recompaction gate is a share of the vocabulary, not a flat 64
	// stores. The flat gate was crossed by every edit — one replacement raises the
	// store estimate by the edited document's distinct-token count (hundreds) — so
	// the whole O(vocab) arena was rebuilt per edit. On a large-vocabulary index
	// the proportional gate must fire a bounded number of times over many edits,
	// while still firing at least once so churn cannot grow the arena without end.
	//
	// The loop turns the event loop between edits, the way a real session lands
	// one edit per turn: the scheduled recompaction is a fire-and-forget async job
	// coalesced by a single-flight, so without a turn a whole synchronous burst
	// collapses into one repack and the gate's frequency is never exercised.
	//
	// Red-first proof: with the pre-#2246 flat 64-store gate (restore
	// clients/word-index.ts from origin/master), the same fixture repacks once
	// per edit — measured 297 of 300 — so the `toBeLessThan(40)` bound fails.
	it("recompacts a share of the vocabulary, not once per edit (#2246)", async () => {
		const DOCS = 100;
		const REVISIONS = 3;
		const TOKENS_PER_DOC = 40;
		// Every document carries a disjoint token block, so the vocabulary is large
		// (~4,000) and the proportional threshold (10% ≈ 400 stores) sits well above
		// the 64-store floor. A flat 64 gate would repack far more often here.
		const doc = (revision: number, id: number) => ({
			path: `src/module${id}.ts`,
			content: Array.from(
				{ length: TOKENS_PER_DOC },
				(_unused, t) =>
					`const tokenR${revision}D${id}N${t} = valueR${revision}D${id}N${t};`,
			).join("\n"),
		});

		const index = buildWordIndex(
			Array.from({ length: DOCS }, (_unused, id) => doc(0, id)),
		);
		expect(index.postings.size).toBeGreaterThan(640); // 0.1 * size > 64 floor
		resetDegradationLedger();
		// Replace every document three times with fresh disjoint tokens, turning the
		// loop between edits so each edit's scheduled repack can run before the next.
		for (let revision = 1; revision <= REVISIONS; revision += 1) {
			for (let id = 0; id < DOCS; id += 1) {
				updateWordIndexDocument(index, doc(revision, id));
				await new Promise((resolve) => setImmediate(resolve));
			}
		}
		await flushWordIndexRecompactionsForTests(index);
		const recompactions = recompactionCount();
		// Bounded: the proportional gate repacks on the order of the churn-to-
		// threshold ratio, not once per edit. 300 edits over a ~4,000-token
		// vocabulary repacks under 40 times; the flat 64 gate does it ~300 times.
		expect(recompactions).toBeGreaterThan(0);
		expect(recompactions).toBeLessThan(40);
	});

	// #2246 review F2: the 64-store FLOOR needs its own red. The proportional
	// half of the gate is pinned above, but on a small index the floor IS the
	// gate, and dropping `Math.max(64, ...)` leaves a single-digit threshold that
	// repacks a small corpus on nearly every edit. That mutation used to red only
	// the wall-clock occupancy bound in word-index-per-edit.test.ts, which #2254
	// replaces with a work count — so without this test the floor loses its guard.
	// Deterministic by construction: it counts repacks, not milliseconds.
	it("keeps the 64-store floor governing a small index (#2246)", async () => {
		const DOCS = 40;
		const REVISIONS = 2;
		// A deliberately tiny vocabulary: two shared tokens plus one unique token
		// per document, so `0.1 * postings.size` is single digits and the 64-store
		// floor is what actually gates. This is the regime the floor exists for.
		const doc = (revision: number, id: number) => ({
			path: `src/small${id}.ts`,
			content: `sharedalpha sharedbeta uniquetoken${revision}x${id}`,
		});

		const index = buildWordIndex(
			Array.from({ length: DOCS }, (_unused, id) => doc(0, id)),
		);
		// Not vacuous: the proportional term really is below the floor here, so
		// dropping the floor changes the threshold instead of being masked by it.
		expect(Math.floor(index.postings.size * 0.1)).toBeLessThan(64);
		resetDegradationLedger();
		for (let revision = 1; revision <= REVISIONS; revision += 1) {
			for (let id = 0; id < DOCS; id += 1) {
				updateWordIndexDocument(index, doc(revision, id));
				await new Promise((resolve) => setImmediate(resolve));
			}
		}
		await flushWordIndexRecompactionsForTests(index);
		// With the floor, 80 edits on this corpus repack a handful of times.
		// Dropping `Math.max(64, ...)` repacks on nearly every edit.
		expect(recompactionCount()).toBeLessThan(15);
	});

	// #2117 review F2: the cooperative compactor sizes the arena from a snapshot,
	// then yields. A synchronous edit that grows a not-yet-adopted list during a
	// yield made the pre-fix `adoptArena` write past the arena, and V8 silently
	// dropped the overflow so the tail postings read `undefined`. The fix skips
	// any list that changed since the snapshot, so no posting is ever corrupted.
	it("never corrupts postings when an edit grows a list mid-recompaction (#2117)", async () => {
		// A sizeable corpus so the arena spans many lists, but the yield itself is
		// no longer sized to cross a wall-clock budget — see the forced deadline
		// below (#2293).
		const postings = new Map<string, WordPostingList>();
		const LISTS = 2_000;
		const ENTRIES = 20;
		for (let t = 0; t < LISTS; t += 1) {
			const list = new WordPostingList(`token${t}`, ENTRIES);
			for (let e = 0; e < ENTRIES; e += 1) list.push(t % 7, e);
			postings.set(`token${t}`, list);
		}
		// The victim is inserted last, so the copy adopts it only at the very end;
		// the forced yield below lands well before its adoption.
		const victim = new WordPostingList("victimToken", 1);
		victim.push(3, 0);
		postings.set("victimToken", victim);

		// #2293: `grewDuringYield` used to be a PRECONDITION riding on the real
		// 8 ms deadline actually crossing during the copy — true only when the
		// scheduler let the copy run long enough to yield at least once before
		// finishing, which a busy CI box or a smaller corpus could miss, failing
		// the assertion below for a reason unrelated to the #2117 invariant. This
		// deadline expires on its very first check (deterministically, before the
		// victim's plan is reached, since the victim is last) and never expires
		// again once reset — the real `CooperativeDeadline` contract, just driven
		// by an explicit trigger instead of wall-clock time. `beforeYield` runs
		// in-line with the production yield, so the growth is guaranteed to land
		// mid-copy without racing a second concurrently-scheduled loop.
		let usedOnce = false;
		let grewDuringYield = false;
		const recompact = compactPostingsIntoArenaCooperatively(postings, {
			deadline: {
				expired: () => !usedOnce,
				reset: () => {
					usedOnce = true;
				},
			},
			beforeYield: () => {
				// On the pre-fix code the grown victim overruns its 1-entry arena slot.
				victim.push(3, victim.length);
				grewDuringYield = true;
			},
		});
		await recompact;

		expect(grewDuringYield).toBe(true);
		let corruptPostings = 0;
		for (const list of postings.values()) {
			for (let i = 0; i < list.length; i += 1) {
				if (list.fileIdAt(i) === undefined || list.lineAt(i) === undefined) {
					corruptPostings += 1;
				}
			}
		}
		expect(corruptPostings).toBe(0);
	}, 30_000);

	// #2117 criterion 3: the estimator charges each distinct backing store once,
	// including abandoned arena slack, so a churned index reads higher than
	// master's per-list-slice sum, which cannot see the vacated lanes. A list
	// that outgrows its arena slice detaches to a private store; its old slice
	// stays resident inside the shared arena but no list's `byteLength` covers
	// it. The estimate must account for that slack.
	it("charges abandoned arena slack that a per-list sum misses (#2117)", () => {
		const postings = new Map<string, WordPostingList>();
		for (const token of ["alpha", "beta", "gamma"]) {
			const list = new WordPostingList(token, 4);
			for (let e = 0; e < 4; e += 1) list.push(0, e);
			postings.set(token, list);
		}
		// Pack the three lists into ONE shared arena (3 * 4 entries * 8 bytes).
		compactPostingsIntoArena(postings);
		const store = { postings };
		const arena = postings.get("alpha")!.backingStore;
		expect(arena.byteLength).toBe(96);
		expect(postings.get("gamma")!.backingStore).toBe(arena);

		// Grow beta far past its 4-entry slice: it detaches to a private store and
		// abandons its 4-entry (32-byte) slice inside the still-referenced arena.
		const beta = postings.get("beta")!;
		beta.reserve(64);
		expect(beta.backingStore).not.toBe(arena);

		const estimate = estimateWordIndexStoreBytes(store);
		// alpha and gamma still pin the whole arena, so its full byteLength — the
		// abandoned beta slice included — is resident and must be charged, plus
		// beta's new private store and one fixed overhead per list. Master summed
		// only each list's own live slice (alpha 32 + gamma 32 for the arena), so
		// it missed the 32 abandoned bytes and reads below this floor.
		expect(estimate).toBeGreaterThanOrEqual(
			arena.byteLength +
				beta.backingStore.byteLength +
				3 * WORD_POSTING_LIST_OVERHEAD_BYTES,
		);
	});
});
