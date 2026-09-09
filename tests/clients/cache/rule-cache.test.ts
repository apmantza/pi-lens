import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BUNDLED_RULES_ROOT,
	CACHE_VERSION,
	RuleCache,
} from "../../../clients/cache/rule-cache.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import * as treeSitterQueryLoader from "../../../clients/tree-sitter-query-loader.js";
import { ruleFilesForLanguage } from "../../../clients/tree-sitter-query-loader.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../../clients/user-notify.js";
import { removeTempDirSync } from "../test-utils.js";

const cleanup: string[] = [];

afterEach(() => {
	while (cleanup.length > 0) {
		const dir = cleanup.pop();
		if (dir && fs.existsSync(dir)) {
			removeTempDirSync(dir);
		}
	}
});

function setupProject(): { cwd: string; ruleFile: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-cache-"));
	cleanup.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi-lens"));
	const ruleFile = path.join(cwd, "fake-rule.yml");
	fs.writeFileSync(ruleFile, "id: fake\n", "utf-8");
	return { cwd, ruleFile };
}

describe("RuleCache", () => {
	it("preserves has_fix across a save+load roundtrip", () => {
		const { cwd, ruleFile } = setupProject();
		const cache = new RuleCache("typescript", cwd);

		cache.set(
			[ruleFile],
			[
				{
					id: "console-statement",
					name: "Console Statement",
					severity: "warning",
					language: "typescript",
					message: "remove debug statements",
					query: "(call_expression) @x",
					metavars: ["x"],
					has_fix: true,
					defect_class: "safety",
					inline_tier: "warning",
					filePath: ruleFile,
				},
				{
					id: "deep-nesting",
					name: "Deep Nesting",
					severity: "warning",
					language: "typescript",
					message: "too deep",
					query: "(block) @b",
					metavars: ["b"],
					has_fix: false,
					filePath: ruleFile,
				},
			],
		);

		const loaded = cache.get([ruleFile]);
		expect(loaded).not.toBeNull();
		expect(loaded?.queries).toHaveLength(2);

		const consoleRule = loaded?.queries.find(
			(q) => q.id === "console-statement",
		);
		const nestingRule = loaded?.queries.find((q) => q.id === "deep-nesting");
		expect(consoleRule?.has_fix).toBe(true);
		expect(nestingRule?.has_fix).toBe(false);
		expect(consoleRule?.defect_class).toBe("safety");
		expect(consoleRule?.inline_tier).toBe("warning");
	});

	// #448: the set() projection in the tree-sitter runner once dropped
	// skip_test_files and fix_action, silently killing the #440 test-file
	// carve-out on every cache HIT. Pin every runner-consulted field.
	it("preserves every runner-consulted field across a save+load roundtrip", () => {
		const { cwd, ruleFile } = setupProject();
		const cache = new RuleCache("python", cwd);

		cache.set(
			[ruleFile],
			[
				{
					id: "python-assert-production",
					name: "Assert in production",
					severity: "warning",
					language: "python",
					message: "assert is stripped by -O",
					query: "(assert_statement) @a",
					metavars: ["a"],
					post_filter: "name_matches_param",
					post_filter_params: { max: 3 },
					defect_class: "safety",
					inline_tier: "warning",
					skip_test_files: true,
					has_fix: true,
					fix_action: "remove",
					filePath: ruleFile,
				},
			],
		);

		const loaded = cache.get([ruleFile])?.queries[0];
		expect(loaded).toMatchObject({
			severity: "warning",
			post_filter: "name_matches_param",
			post_filter_params: { max: 3 },
			defect_class: "safety",
			inline_tier: "warning",
			skip_test_files: true,
			has_fix: true,
			fix_action: "remove",
			filePath: ruleFile,
		});
	});

	// #448 follow-up: the v3→v4 bump left orphaned `<language>-rules-v3.json`
	// files on disk forever — nothing ever read or removed them again once the
	// version bumped. `set()` now prunes stale-version siblings after writing.
	it("prunes an orphaned prior-version cache file on set()", () => {
		const { cwd, ruleFile } = setupProject();
		const staleFile = path.join(cwd, ".pi-lens", "cache", "go-rules-v3.json");
		fs.mkdirSync(path.dirname(staleFile), { recursive: true });
		fs.writeFileSync(staleFile, JSON.stringify({ version: "v3" }), "utf-8");

		const cache = new RuleCache("go", cwd);
		cache.set(
			[ruleFile],
			[
				{
					id: "fake",
					name: "Fake",
					severity: "warning",
					language: "go",
					message: "",
					query: "(x) @x",
					metavars: [],
					has_fix: false,
					filePath: ruleFile,
				},
			],
		);

		const currentFile = path.join(
			cwd,
			".pi-lens",
			"cache",
			`go-rules-${CACHE_VERSION}.json`,
		);
		expect(fs.existsSync(staleFile)).toBe(false);
		expect(fs.existsSync(currentFile)).toBe(true);
	});

	// #878: the cache key fingerprints the full EFFECTIVE rule set, so an edit
	// to an inherited rule file (tsx runs the typescript rules) must invalidate
	// the inheriting language's entry — pre-fix only the language's OWN
	// directory was hashed and the stale compiled rules kept running.
	it("invalidates an inheriting language's cache when an inherited rule file changes", () => {
		const { cwd } = setupProject();
		const tsxRule = path.join(
			cwd,
			"rules",
			"tree-sitter-queries",
			"tsx",
			"own.yml",
		);
		const tsRule = path.join(
			cwd,
			"rules",
			"tree-sitter-queries",
			"typescript",
			"inherited.yml",
		);
		const pyRule = path.join(
			cwd,
			"rules",
			"tree-sitter-queries",
			"python",
			"unrelated.yml",
		);
		for (const f of [tsxRule, tsRule, pyRule]) {
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, "id: x\nquery: (identifier) @X\n", "utf-8");
		}

		const cache = new RuleCache("tsx", cwd);
		const queries = [
			{
				id: "fake",
				name: "Fake",
				severity: "warning",
				language: "tsx",
				message: "",
				query: "(x) @x",
				metavars: ["x"],
				has_fix: false,
				filePath: tsxRule,
			},
		];

		// Cold: nothing cached. Warm: hit.
		expect(cache.get(ruleFilesForLanguage("tsx", cwd))).toBeNull();
		cache.set(ruleFilesForLanguage("tsx", cwd), queries);
		expect(cache.get(ruleFilesForLanguage("tsx", cwd))).not.toBeNull();

		// Editing an INHERITED (typescript) rule invalidates the tsx entry.
		fs.writeFileSync(
			tsRule,
			"id: x\nquery: (identifier) @X\n# changed\n",
			"utf-8",
		);
		expect(cache.get(ruleFilesForLanguage("tsx", cwd))).toBeNull();

		// Control: an unrelated language's rule change does NOT invalidate it.
		cache.set(ruleFilesForLanguage("tsx", cwd), queries);
		fs.writeFileSync(pyRule, "id: y\nquery: (block) @B\n# changed\n", "utf-8");
		expect(cache.get(ruleFilesForLanguage("tsx", cwd))).not.toBeNull();
	});

	it("invalidates the cache when the schema version changes", () => {
		const { cwd, ruleFile } = setupProject();
		const cache = new RuleCache("typescript", cwd);

		cache.set(
			[ruleFile],
			[
				{
					id: "fake",
					name: "Fake",
					severity: "warning",
					language: "typescript",
					message: "",
					query: "(x) @x",
					metavars: [],
					has_fix: true,
					filePath: ruleFile,
				},
			],
		);

		const cacheFile = path.join(
			cwd,
			".pi-lens",
			"cache",
			`typescript-rules-${CACHE_VERSION}.json`,
		);
		expect(fs.existsSync(cacheFile)).toBe(true);

		const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
		// Pin (#1082/#1116 pattern): the runtime constant must never coincide with
		// this deliberate mismatch literal, or this test would vacuously pass.
		expect(CACHE_VERSION).not.toBe("v2");
		raw.version = "v2";
		fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");

		expect(cache.get([ruleFile])).toBeNull();
	});

	// #1118: computeRuleHash fingerprinted rule-file METADATA (mtime+size) only
	// — the review-graph first-filter without the content-hash CONFIRM the gold
	// standard pairs it with. An edit to a PROJECT-LOCAL (mutable) rule file that
	// preserves both mtime and byte size (git-checkout timestamp restoration, a
	// same-length tweak, a formatter that preserves mtime) replayed a stale
	// compiled set pre-fix. Pin mtime via utimesSync (not a real-clock race) and
	// keep size identical — #1024-safe on Linux CI.
	it("content-confirms a project-local rule file: a same-mtime+same-size edit invalidates the cache", () => {
		const { cwd } = setupProject();
		const ruleFile = path.join(
			cwd,
			"rules",
			"tree-sitter-queries",
			"typescript",
			"mutable.yml",
		);
		fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
		fs.writeFileSync(ruleFile, "id: aaaa\nquery: (identifier) @X\n", "utf-8");
		// Pin mtime via utimesSync rather than trusting the write's natural
		// timestamp: some filesystems round mtime to a coarser precision than
		// Date's, so comparing a later utimesSync round-trip against a naturally
		// written stat can flake. Setting the SAME fixed Date both times before
		// and after guarantees identical rounding, hence a genuinely
		// same-mtime+same-size edit rather than an accidental one.
		const pinnedMtime = new Date(2024, 0, 1, 0, 0, 0);
		fs.utimesSync(ruleFile, pinnedMtime, pinnedMtime);
		const statBefore = fs.statSync(ruleFile);

		const cache = new RuleCache("typescript", cwd);
		const queries = [
			{
				id: "fake",
				name: "Fake",
				severity: "warning",
				language: "typescript",
				message: "",
				query: "(x) @x",
				metavars: ["x"],
				has_fix: false,
				filePath: ruleFile,
			},
		];
		cache.set([ruleFile], queries);
		expect(cache.get([ruleFile])).not.toBeNull();

		// Same byte length ("aaaa" -> "bbbb"), content changed, mtime restored.
		fs.writeFileSync(ruleFile, "id: bbbb\nquery: (identifier) @X\n", "utf-8");
		fs.utimesSync(ruleFile, pinnedMtime, pinnedMtime);
		const statAfter = fs.statSync(ruleFile);
		expect(statAfter.size).toBe(statBefore.size);
		expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);

		expect(cache.get([ruleFile])).toBeNull();
	});

	// #1118: bundled rule files (~705 across all languages) are immutable within
	// a process — content-confirming them unconditionally on the per-edit
	// tree-sitter runner hot path is exactly the discipline AGENTS.md forbids.
	// Prove the split behaviorally rather than via a readFileSync spy (ESM
	// namespace exports aren't spy-configurable, and this is closer to the real
	// contract anyway): mutate a REAL bundled file's content while preserving
	// mtime+size — if bundled files were content-confirmed too, this would
	// invalidate; they must not be, so the cache keeps HITTING. The mutation is
	// always restored, even on assertion failure, since this is a real repo
	// file.
	it("does not content-confirm bundled rule files (hot-path cost stays metadata-only, still cache-hits)", () => {
		const { cwd } = setupProject();
		// No `rules/tree-sitter-queries/go/` under this tmp cwd, so the effective
		// set is bundled files only.
		const files = ruleFilesForLanguage("go", cwd);
		expect(files.length).toBeGreaterThan(0);
		const bundledFile = files[0];
		const originalContent = fs.readFileSync(bundledFile);
		const originalStat = fs.statSync(bundledFile);
		const pinnedMtime = new Date(2024, 0, 1, 0, 0, 0);

		const cache = new RuleCache("go", cwd);
		const queries = [
			{
				id: "fake",
				name: "Fake",
				severity: "warning",
				language: "go",
				message: "",
				query: "(x) @x",
				metavars: [],
				has_fix: false,
				filePath: bundledFile,
			},
		];

		try {
			fs.utimesSync(bundledFile, pinnedMtime, pinnedMtime);
			const statBefore = fs.statSync(bundledFile);
			cache.set(files, queries);
			expect(cache.get(files)).not.toBeNull();

			// Same byte length, content differs, mtime restored to the pin.
			const mutated = Buffer.alloc(originalContent.length, 0x23); // "#"
			fs.writeFileSync(bundledFile, mutated);
			fs.utimesSync(bundledFile, pinnedMtime, pinnedMtime);
			const statAfter = fs.statSync(bundledFile);
			expect(statAfter.size).toBe(statBefore.size);
			expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);

			expect(cache.get(files)).not.toBeNull();
		} finally {
			fs.writeFileSync(bundledFile, originalContent);
			fs.utimesSync(bundledFile, originalStat.atime, originalStat.mtime);
		}
	});

	// #1118 disk-poisoning half: a persisted entry whose ruleHash was computed
	// over metadata ONLY (what a pre-fix process would have written for a
	// same-mtime+size stale edit) must not be trusted post-fix — the
	// content-confirming fingerprint differs, so the poisoned entry is rejected
	// rather than replayed under a "fresh-looking" key.
	it("does not trust a persisted entry fingerprinted without the project-local content hash", () => {
		const { cwd } = setupProject();
		const ruleFile = path.join(
			cwd,
			"rules",
			"tree-sitter-queries",
			"typescript",
			"mutable.yml",
		);
		fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
		fs.writeFileSync(ruleFile, "id: aaaa\n", "utf-8");
		const stat = fs.statSync(ruleFile);

		const cacheFile = path.join(
			cwd,
			".pi-lens",
			"cache",
			`typescript-rules-${CACHE_VERSION}.json`,
		);
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

		// Metadata-only fingerprint (the pre-#1118 formula) for the CURRENT
		// mtime+size — exactly what a stale-but-matching entry looked like.
		const metadataOnlyHash = crypto
			.createHash("sha256")
			.update(`${ruleFile}:${stat.mtimeMs}:${stat.size}`)
			.digest("hex")
			.slice(0, 16);
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({
				version: CACHE_VERSION,
				timestamp: Date.now(),
				ruleHash: metadataOnlyHash,
				queries: [
					{
						id: "stale",
						name: "Stale",
						severity: "warning",
						language: "typescript",
						message: "",
						query: "(x) @x",
						metavars: [],
						has_fix: false,
						filePath: ruleFile,
					},
				],
			}),
			"utf-8",
		);

		const cache = new RuleCache("typescript", cwd);
		expect(cache.get([ruleFile])).toBeNull();
	});
});

/**
 * #2636 (the #2626 class sweep's tree-sitter leg): `BUNDLED_RULES_ROOT` was
 * used unconditionally with no existence check — same
 * managed-cache-relocation gap #2626 fixed for `skills/`.
 * `classifyBundledResourceDir` is independently pinned in
 * `bundled-resource-health.test.ts`; these tests pin the CONSTRUCTOR's
 * WIRING to it. `BUNDLED_RULES_ROOT` is a module-load-time constant fixed to
 * THIS repo's real, healthy install layout, so the unhealthy branch is
 * exercised by spying on `getBundledQueriesRootHealth`'s return value (the
 * memoized wrapper `rule-cache.ts` actually calls, #2636 review F6) rather
 * than faking `import.meta.url`. Spied via the `tree-sitter-query-loader.js`
 * namespace import — `rule-cache.ts` calls it as a CROSS-module import, so
 * the live-binding spy reaches it (confirmed empirically: spying on the
 * SAME function from within `tree-sitter-query-loader.test.ts` does NOT
 * intercept that module's own internal same-file call — see that file's
 * tests for the fs-mock technique used there instead).
 */
describe("RuleCache — bundled tree-sitter-queries root health (#2636)", () => {
	const notified: Array<{ message: string; level: string | undefined }> = [];

	beforeEach(() => {
		notified.length = 0;
		resetDegradationLedger();
		wireUserNotifier(() => (message, level) => {
			notified.push({ message, level });
		});
	});

	afterEach(() => {
		resetUserNotifier();
		resetDegradationLedger();
		vi.restoreAllMocks();
	});

	function degradationGroup() {
		return getDegradationSummary().find(
			(g) => g.kind === "tree-sitter-queries-dir-missing",
		);
	}

	it("records nothing when the bundled root is healthy (this repo's own real layout)", () => {
		const { cwd } = setupProject();
		void new RuleCache("typescript", cwd);
		expect(degradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("records a bounded degradation + notify when the bundled root is absent", () => {
		const healthSpy = vi
			.spyOn(treeSitterQueryLoader, "getBundledQueriesRootHealth")
			.mockReturnValue({ status: "absent" });
		const { cwd } = setupProject();

		void new RuleCache("typescript", cwd);

		expect(healthSpy).toHaveBeenCalledTimes(1);
		const group = degradationGroup();
		expect(group).toBeDefined();
		expect(group?.latestReasons.at(-1)?.subject).toBe(BUNDLED_RULES_ROOT);
		expect(notified).toHaveLength(1);
		expect(notified[0].message).toContain(
			"bundled tree-sitter query rules unavailable",
		);
	});

	it("does not re-notify across repeated constructions in the same session", () => {
		vi.spyOn(
			treeSitterQueryLoader,
			"getBundledQueriesRootHealth",
		).mockReturnValue({
			status: "absent",
		});
		const { cwd } = setupProject();

		void new RuleCache("typescript", cwd);
		void new RuleCache("python", cwd);
		void new RuleCache("go", cwd);

		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(3);
	});
});
