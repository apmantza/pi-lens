import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	centralityFromReverseDeps,
	deserializeWordIndex,
	searchWordIndex,
	serializeWordIndex,
	splitIdentifier,
	tokenizeLine,
} from "../../clients/word-index.ts";

describe("splitIdentifier", () => {
	it("splits camelCase and keeps the whole identifier", () => {
		expect(splitIdentifier("getUserByID")).toEqual(
			expect.arrayContaining(["getuserbyid", "get", "user", "by", "id"]),
		);
	});

	it("splits PascalCase acronym boundaries", () => {
		const parts = splitIdentifier("HTTPServerConfig");
		expect(parts).toEqual(
			expect.arrayContaining(["http", "server", "config"]),
		);
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
			expect.arrayContaining(["username", "user", "name", "getuser", "account", "id"]),
		);
		expect(tokens).not.toContain("const");
	});

	it("returns nothing for a line with no identifiers", () => {
		expect(tokenizeLine("   () => { + - * }")).toEqual([]);
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
			centrality: centralityFromReverseDeps(index, { "src/b.ts": ["a", "b", "c"] }),
		});
		expect(ranked[0].file).toBe("src/b.ts");
	});
});

describe("serializeWordIndex / deserializeWordIndex", () => {
	const files = [
		{ path: "src/a.ts", content: "function alphaHandler() {}" },
		{ path: "src/b.ts", content: "function betaHandler(alpha) {}" },
	];

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

	it("returns null for malformed serialized input", () => {
		expect(deserializeWordIndex(null)).toBeNull();
		expect(deserializeWordIndex({} as never)).toBeNull();
	});
});
