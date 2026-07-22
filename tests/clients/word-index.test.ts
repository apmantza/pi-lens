import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildWordIndex,
	centralityFromReverseDeps,
	deserializeWordIndex,
	searchWordIndex,
	serializeWordIndex,
	splitIdentifier,
	tokenizeLine,
	_resetWordIndexBuildGuardForTests,
	triggerBackgroundWordIndexBuild,
} from "../../clients/word-index.ts";
import { loadProjectSnapshot } from "../../clients/project-snapshot.ts";
import { createTempFile, setupTestEnvironment } from "./test-utils.ts";

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

describe("triggerBackgroundWordIndexBuild (#348 cold-query stampede guard)", () => {
	afterEach(() => {
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
			// Give any (wrongly) scheduled build a beat to persist, then confirm
			// nothing was written.
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(loadProjectSnapshot(env.tmpDir)?.wordIndex).toBeUndefined();
		} finally {
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
			const { saveProjectSnapshot, PROJECT_SNAPSHOT_VERSION } = await import(
				"../../clients/project-snapshot.ts"
			);
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
});
