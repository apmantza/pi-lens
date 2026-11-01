/**
 * `rules.<id>.ignorePaths` matches with the SAME gitignore semantics as the
 * `ignore` field (#783, `clients/file-utils.ts`): last match wins, `!`
 * re-includes, a leading `/` roots the entry at the declaring file's
 * directory, a trailing `/` matches directories only (#5029).
 *
 * Recurrence this guards: `isRuleIgnoredForPath` matched an entry list with
 * `patterns.some(minimatch(...))`, so a `!legacy/keep.ts` entry matched every
 * path the negated glob did NOT name and hid all of them (#5011 verify round 3,
 * `negation.txt`), while `/legacy/**` and `legacy/` matched nothing at all.
 *
 * Each row writes ONE pattern list to a real `.pi-lens.json` as BOTH the
 * `ignore` field and `rules.no-eval.ignorePaths`, at the repo root and in a
 * nested `pkg/`, then asks the production matcher of each field about the same
 * files: `getProjectIgnoreMatcher(repo).isIgnored` for `ignore`, and
 * `applyRulePolicy` over `loadProjectRulePolicy(repo)` (the one seam every
 * rule-policy surface reads) for `ignorePaths`. The expected set is written
 * from git's rules per row, so two fields that agree on a wrong answer still
 * red.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectIgnoreMatcher } from "../../../clients/file-utils.js";
import {
	applyPushedFindingPolicy,
	loadProjectRulePolicy,
} from "../../../clients/dispatch/finding-policy.js";
import {
	applyRulePolicy,
	ruleIgnoredForPath,
} from "../../../clients/dispatch/rule-policy.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";
import { toPosix } from "../../../clients/path-utils.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { useConfigPath } from "../../support/global-config.js";
import { removeTempDirSync } from "../test-utils.js";

const setConfigPath = useConfigPath();

let tmpDir: string;
let repo: string;

/** Files probed under the declaring directory; `../sibling/s.ts` is outside it. */
const PROBED = [
	"legacy/a.ts",
	"legacy/keep.ts",
	"legacy/sub/deep.ts",
	"src/c.ts",
	"src/legacy/x.ts",
	"legacy.ts",
	"src/legacy.ts",
	"../sibling/s.ts",
] as const;

interface Row {
	name: string;
	patterns: string[];
	/** Of {@link PROBED}, the files git's rules ignore. */
	ignored: string[];
}

const ROWS: Row[] = [
	{
		name: "plain glob",
		patterns: ["legacy/**"],
		ignored: ["legacy/a.ts", "legacy/keep.ts", "legacy/sub/deep.ts"],
	},
	{
		name: "negation re-includes one file",
		patterns: ["legacy/**", "!legacy/keep.ts"],
		ignored: ["legacy/a.ts", "legacy/sub/deep.ts"],
	},
	{
		name: "a lone negation hides nothing",
		patterns: ["!legacy/keep.ts"],
		ignored: [],
	},
	{
		name: "rooted entry",
		patterns: ["/legacy/**"],
		ignored: ["legacy/a.ts", "legacy/keep.ts", "legacy/sub/deep.ts"],
	},
	{
		name: "rooted slashless entry matches only at the declaring directory",
		patterns: ["/legacy.ts"],
		ignored: ["legacy.ts"],
	},
	{
		name: "rooted directory-only entry",
		patterns: ["/src/legacy/"],
		ignored: ["src/legacy/x.ts"],
	},
	{
		name: "directory-only entry matches the directory at any depth",
		patterns: ["legacy/"],
		ignored: [
			"legacy/a.ts",
			"legacy/keep.ts",
			"legacy/sub/deep.ts",
			"src/legacy/x.ts",
		],
	},
	{
		name: "slashless entry matches at any depth",
		patterns: ["deep.ts"],
		ignored: ["legacy/sub/deep.ts"],
	},
	{
		name: "last match wins: an ignore after a negation ignores",
		patterns: ["!legacy/keep.ts", "legacy/**"],
		ignored: ["legacy/a.ts", "legacy/keep.ts", "legacy/sub/deep.ts"],
	},
	{
		name: "last match wins: a negation after an ignore re-includes",
		patterns: ["legacy/**", "!legacy/**", "legacy/a.ts"],
		ignored: ["legacy/a.ts"],
	},
	{
		name: "a ../ escape matches nothing",
		patterns: ["../sibling/**"],
		ignored: [],
	},
];

function finding(filePath: string): Diagnostic {
	return {
		id: `no-eval:${filePath}`,
		message: "no-eval",
		filePath,
		severity: "warning",
		semantic: "warning",
		tool: "ast-grep",
		rule: "no-eval",
		line: 1,
	};
}

function writeConfig(dir: string, config: unknown): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi-lens.json"), JSON.stringify(config));
}

/** Of {@link PROBED}, the files each field hides, as spelled in PROBED. */
function verdicts(declaringDir: string): {
	ignoreField: string[];
	ignorePaths: string[];
} {
	const absolute = PROBED.map((rel) => path.resolve(declaringDir, rel));
	const matcher = getProjectIgnoreMatcher(repo);
	const ignoreField = PROBED.filter((_rel, i) =>
		matcher.isIgnored(absolute[i] as string, false),
	);
	const kept = new Set(
		applyRulePolicy(absolute.map(finding), loadProjectRulePolicy(repo), {
			root: repo,
			filePath: repo,
		}).map((d) => d.filePath),
	);
	const ignorePaths = PROBED.filter(
		(_rel, i) => !kept.has(absolute[i] as string),
	);
	return { ignoreField, ignorePaths };
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ignore-paths-"));
	repo = path.join(tmpDir, "repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	setConfigPath(path.join(tmpDir, "global", "config.json"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	resetProjectLensConfigCache();
	removeTempDirSync(tmpDir);
});

describe.each([
	["the repo root's .pi-lens.json", ""],
	["a nested pkg/.pi-lens.json", "pkg"],
])(
	"rules.<id>.ignorePaths in %s matches like the ignore field (#5029)",
	(_label, sub) => {
		it.each(ROWS)("$name: $patterns", ({ patterns, ignored }) => {
			const declaringDir = path.join(repo, sub);
			writeConfig(declaringDir, {
				ignore: patterns,
				rules: { "no-eval": { ignorePaths: patterns } },
			});

			const { ignoreField, ignorePaths } = verdicts(declaringDir);

			expect(ignoreField).toEqual(ignored);
			expect(ignorePaths).toEqual(ignoreField);
		});
	},
);

describe("rules.<id>.ignorePaths across config tiers (#5029)", () => {
	// Recurrence: a nearer file lifting a carve-out another file declared. The
	// schema marks `ignorePaths` `array-union` and docs/configuration.md says
	// "a nearer file adds carve-outs and never lifts one"; a flat last-match
	// chain across files would let a project `!` clear a global denial.
	it("a nested negation re-includes only against its own file's lines", () => {
		writeConfig(repo, {
			rules: { "no-eval": { ignorePaths: ["**/legacy/**"] } },
		});
		writeConfig(path.join(repo, "pkg"), {
			rules: {
				"no-eval": { ignorePaths: ["legacy/**", "!legacy/keep.ts"] },
			},
		});

		const kept = applyRulePolicy(
			[
				finding(path.join(repo, "legacy/keep.ts")),
				finding(path.join(repo, "pkg/legacy/a.ts")),
				finding(path.join(repo, "pkg/legacy/keep.ts")),
				finding(path.join(repo, "pkg/src/c.ts")),
			],
			loadProjectRulePolicy(repo),
			{ root: repo, filePath: repo },
		).map((d) => toPosix(path.relative(repo, d.filePath)));

		// pkg's `!legacy/keep.ts` lifts pkg's own `legacy/**`, but the root's
		// `**/legacy/**` still carves out pkg/legacy/keep.ts.
		expect(kept).toEqual(["pkg/src/c.ts"]);
	});

	it("a global entry's carve-out survives a project negation", () => {
		setConfigPath(
			path.join(tmpDir, "global", "config.json"),
			JSON.stringify({ rules: { "no-eval": { ignorePaths: ["legacy/**"] } } }),
		);
		writeConfig(repo, {
			rules: { "no-eval": { ignorePaths: ["!legacy/keep.ts"] } },
		});

		const kept = applyRulePolicy(
			[
				finding(path.join(repo, "legacy/keep.ts")),
				finding(path.join(repo, "src/c.ts")),
			],
			loadProjectRulePolicy(repo),
			{ root: repo, filePath: repo },
		).map((d) => toPosix(path.relative(repo, d.filePath)));

		expect(kept).toEqual(["src/c.ts"]);
	});

	it("a pushed finding reads the same verdict as the dispatcher's filter", () => {
		writeConfig(repo, {
			rules: {
				"no-eval": { ignorePaths: ["legacy/**", "!legacy/keep.ts"] },
			},
		});
		const files = ["legacy/a.ts", "legacy/keep.ts", "src/c.ts"].map((rel) =>
			path.join(repo, rel),
		);

		const { kept } = applyPushedFindingPolicy(files.map(finding), {
			cwd: repo,
			filePath: files[0] as string,
			content: "eval('1');\n",
		});

		expect(kept.map((d) => toPosix(path.relative(repo, d.filePath)))).toEqual([
			"legacy/keep.ts",
			"src/c.ts",
		]);
	});
});

describe("ruleIgnoredForPath on a policy map built from bare strings (#5029)", () => {
	// Recurrence: the strings a `rulePolicyMapFromConfig` map carries (no config
	// file behind them) are gitignore lines relative to the workspace root, not
	// plain globs. A single rooted entry used to match nothing.
	const verdict = (patterns: string[], rel: string): boolean =>
		ruleIgnoredForPath("no-eval", path.join(repo, rel), repo, {
			"no-eval": { ignorePaths: patterns },
		});

	it("reads a lone rooted entry relative to the workspace root", () => {
		expect(verdict(["/legacy/**"], "legacy/a.ts")).toBe(true);
		expect(verdict(["/legacy/**"], "src/legacy/a.ts")).toBe(false);
	});

	// Recurrence: a refactor that hands `ruleIgnoredForPath`'s root-relative
	// `filePath` to the gitignore evaluator unresolved. `relativeInside` then
	// resolves it against the process cwd, not the workspace root, so the
	// rooted `/legacy/**` misses `legacy/a.ts` (#5029).
	it("resolves a root-relative file path against the workspace root", () => {
		expect(
			ruleIgnoredForPath("no-eval", "legacy/a.ts", repo, {
				"no-eval": { ignorePaths: ["/legacy/**"] },
			}),
		).toBe(true);
	});

	it("reads a negation against the entries before it", () => {
		const patterns = ["legacy/**", "!legacy/keep.ts"];
		expect(verdict(patterns, "legacy/a.ts")).toBe(true);
		expect(verdict(patterns, "legacy/keep.ts")).toBe(false);
		expect(verdict(patterns, "src/c.ts")).toBe(false);
	});
});

describe("a final extglob that can match nothing, on a directory walk (#5129)", () => {
	// Recurrence: minimatch 10 matched the trailing-slash directory candidate
	// (`legacy/`, `src/`) against a final extglob that can match nothing, such as
	// `?(x)`, `*(x)` or `dir/!(x)`, so the entry hid the whole directory from the
	// walkers that call `isIgnored(dir, true)` (source-walker, pipeline,
	// workspace-modules); minimatch 11 (the GHSA-g3hv-75wg-m249 bump) leaves an
	// empty path portion to an empty pattern portion. Git reads `?(x)` as one
	// character then `(x)`, which names none of these directories.
	it.each([
		{ entry: "?(x)", dir: "legacy", child: "sub" },
		{ entry: "*(x)", dir: "legacy", child: "sub" },
		{ entry: "src/*(x)", dir: "src", child: "sub" },
		// `!(x)` matches every name but `x`, so the child the walk keeps is `x`.
		{ entry: "src/!(x)", dir: "src", child: "x" },
	])(
		"$entry hides no directory: $dir and $dir/$child",
		({ entry, dir, child }) => {
			fs.mkdirSync(path.join(repo, dir, child), { recursive: true });
			writeConfig(repo, { ignore: [entry] });
			const matcher = getProjectIgnoreMatcher(repo);

			expect(matcher.isIgnored(path.join(repo, dir), true)).toBe(false);
			expect(matcher.isIgnored(path.join(repo, dir, child), true)).toBe(false);
		},
	);
});
