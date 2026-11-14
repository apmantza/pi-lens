/**
 * #5594: detekt, phpstan and credo match the ignore globs of the project's own
 * config against the file's ABSOLUTE path, so a project checked out under
 * `<root>/.claude/worktrees/<lane>` whose config ignores `**\/.claude/**` was
 * read as clean without being analysed. The runners now hand the tool a copy of
 * the project's config in which every such glob is anchored at the project root
 * (`clients/dispatch/runners/utils/ignore-anchor.ts`).
 *
 * This file pins the rewrite itself (the glob forms it admits and refuses, each
 * tool's config reader) and the runner's seam to the tool (what the tool is
 * handed, what is removed afterwards, what a refusal reports). The tool's own
 * matching is the real-binary file `ignore-anchor-real.test.ts`; a double has no
 * matcher, so nothing here claims the anchored globs match.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	anchorIgnorePattern,
	anchorIgnorePatterns,
	markUnanchored,
	withOverlayFile,
} from "../../../../clients/dispatch/runners/utils/ignore-anchor.js";
import { anchorDetektConfig } from "../../../../clients/dispatch/runners/detekt.js";
import {
	anchorPhpstanConfig,
	phpstanConfigMayExclude,
} from "../../../../clients/dispatch/runners/phpstan.js";
import yaml from "../../../../clients/deps/js-yaml.js";
import type { RunnerResult } from "../../../../clients/dispatch/types.js";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setProjectTrustState } from "../../../../clients/project-trust.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

// A partial mock: the spawn seam is the process boundary, and the rest of the
// module (the availability probes the runners resolve their command through)
// stays real.
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

// The runners resolve `detekt`, `phpstan` and `mix` by presence on PATH around
// the version probe. Each gets a non-empty stub on a PATH of this file's own,
// never executed because `safeSpawnAsync` is the mocked seam, so the answer is
// the same on a host that has the tool and on one that does not.
const presence = setupTestEnvironment("pi-lens-5594-bin-");
const originalPath = process.env.PATH;

beforeAll(() => {
	for (const name of ["detekt", "phpstan", "mix"]) {
		fs.writeFileSync(path.join(presence.tmpDir, name), "#!/bin/sh\n", {
			mode: 0o755,
		});
	}
	process.env.PATH = `${presence.tmpDir}${path.delimiter}${originalPath ?? ""}`;
	setProjectTrustState("trusted");
});

afterAll(() => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	presence.cleanup();
});

const ROOT = "/work/.claude/worktrees/lane1";

describe("anchorIgnorePattern (java glob, detekt)", () => {
	it.each([
		// The two forms `**/X` stands for: no directory below the root, or one or more.
		["**/.claude/**", [`${ROOT}/.claude/**`, `${ROOT}/**/.claude/**`]],
		["**/*.kt", [`${ROOT}/*.kt`, `${ROOT}/**/*.kt`]],
		// A first segment that keeps a literal reaches an ancestor only where the
		// ancestor matches it, so a layout where it does not exists (row D3).
		["**/*en/**", [`${ROOT}/*en/**`, `${ROOT}/**/*en/**`]],
		["**/?en/**", [`${ROOT}/?en/**`, `${ROOT}/**/?en/**`]],
		// One segment without `**` never crosses a `/`: it only sees the file name.
		["**/*", [`${ROOT}/*`, `${ROOT}/**/*`]],
		["glob:**/gen/**", [`${ROOT}/gen/**`, `${ROOT}/**/gen/**`]],
		// Already absolute: anchored by the user, kept.
		["/abs/proj/**/gen/**", ["/abs/proj/**/gen/**"]],
		// A relative pattern that starts with a name cannot match an absolute path.
		[".claude/**", [".claude/**"]],
		["src/test/**", ["src/test/**"]],
	])("%s -> %j", (pattern, expected) => {
		expect(anchorIgnorePattern(pattern, ROOT, "java-glob")).toEqual(expected);
	});

	// An unknown spelling is refused, never passed through: a pass-through is a
	// silent clean again (principles section 1, gates fail closed).
	it.each([
		"regex:.*\\.claude.*",
		"syntax:whatever",
		"{**/a/**,**/b/**}",
		"**.claude/**",
		"*/gen/**",
		"**/",
		"**//x",
		"[ab]/x",
		"",
		// #5606 round 3: the root's own name fills a leading wildcard segment in
		// every layout, so the anchored pair drops `<root>/gen` and `<root>/X.kt`
		// that detekt excluded (rows D4, D5); a brace group cannot be read (D6).
		"**/*/gen/**",
		"**/**/X.kt",
		"**/{gen,out}/**",
	])("refuses %j", (pattern) => {
		expect(anchorIgnorePattern(pattern, ROOT, "java-glob")).toBeNull();
	});

	it("escapes glob metacharacters in the root and keeps its slashes", () => {
		expect(
			anchorIgnorePattern("**/x/**", "C:\\w[1]\\{p}\\lane*", "java-glob"),
		).toEqual([
			"C:/w\\[1\\]/\\{p\\}/lane\\*/x/**",
			"C:/w\\[1\\]/\\{p\\}/lane\\*/**/x/**",
		]);
	});
});

describe("anchorIgnorePattern (fnmatch, phpstan)", () => {
	it.each([
		["**/.claude/**", [`${ROOT}/.claude/**`, `${ROOT}/*/.claude/**`]],
		["*/vendor/*", [`${ROOT}/vendor/*`, `${ROOT}/*/vendor/*`]],
		["*.min.php", [`${ROOT}/*.min.php`]],
		["/abs/proj/vendor", ["/abs/proj/vendor"]],
	])("%s -> %j", (pattern, expected) => {
		expect(anchorIgnorePattern(pattern, ROOT, "fnmatch")).toEqual(expected);
	});

	it("refuses a relative pattern with no leading wildcard", () => {
		expect(anchorIgnorePattern("src/gen/*", ROOT, "fnmatch")).toBeNull();
	});

	// #5606 round 3: phpstan's `*`, `?` and `[` cross `/`, so a tail led by one
	// of them matches through the root's own name or the separator before the
	// root's entries in every layout: `*/*/gen/*` excludes `<root>/gen/h.php`
	// and `*?h.php` excludes `<root>/h.php` (rows P6, P8).
	it.each(["*/*/gen/*", "*?h.php", "*/?en/*", "*[a]x", "**//x"])(
		"refuses %j",
		(pattern) => {
			expect(anchorIgnorePattern(pattern, ROOT, "fnmatch")).toBeNull();
		},
	);
});

describe("anchorIgnorePatterns", () => {
	it("keeps the user's order, drops a duplicate anchor, and refuses the whole list on one unknown entry", () => {
		expect(
			anchorIgnorePatterns(["**/a/**", "**/a/**", "b/**"], ROOT, "java-glob"),
		).toEqual({
			patterns: [`${ROOT}/a/**`, `${ROOT}/**/a/**`, "b/**"],
		});
		expect(
			anchorIgnorePatterns(["**/a/**", "regex:x"], ROOT, "java-glob"),
		).toEqual({ unrecognized: "regex:x" });
	});
});

describe("anchorDetektConfig", () => {
	const anchored = (text: string) => anchorDetektConfig(text, ROOT);

	it("writes only the lists it anchored, where they sit", () => {
		const result = anchored(
			[
				"build:",
				"  maxIssues: 0",
				"style:",
				"  active: true",
				"  excludes: ['**/gen/**']",
				"  MagicNumber:",
				"    active: true",
				"    ignoreNumbers: ['-1', '0', '42']",
				"    excludes: ['**/.claude/**', 'src/legacy/**']",
				"",
			].join("\n"),
		);
		expect(result.kind).toBe("rewritten");
		if (result.kind !== "rewritten") return;
		// js-yaml's own reader, so the assertion reads the file the tool reads.
		// detekt reads it after the project's own file, which keeps every other key.
		expect(yaml.load(result.text)).toEqual({
			style: {
				excludes: [`${ROOT}/gen/**`, `${ROOT}/**/gen/**`],
				MagicNumber: {
					excludes: [
						`${ROOT}/.claude/**`,
						`${ROOT}/**/.claude/**`,
						"src/legacy/**",
					],
				},
			},
		});
	});

	// Row D20: a copy of the whole tree spelled `threshold: 60.0` back as `60`,
	// and detekt, which refuses 60.0 for an Int, then ran. The overlay carries no
	// value it did not rewrite, so detekt reads that one from the project's file.
	it("leaves every value it does not rewrite to the project's own file", () => {
		const result = anchored(
			"complexity:\n  LongMethod:\n    threshold: 60.0\n    excludes: ['**/gen/**']\n  since: 2024-01-01\n",
		);
		expect(result.kind).toBe("rewritten");
		if (result.kind !== "rewritten") return;
		expect(yaml.load(result.text)).toEqual({
			complexity: {
				LongMethod: { excludes: [`${ROOT}/gen/**`, `${ROOT}/**/gen/**`] },
			},
		});
	});

	it("reads the comma string form detekt accepts as a list", () => {
		const result = anchored("style:\n  excludes: '**/a/**, **/b/**'\n");
		expect(result.kind).toBe("rewritten");
		if (result.kind !== "rewritten") return;
		expect(result.text).toContain(`${ROOT}/a/**`);
		expect(result.text).toContain(`${ROOT}/**/b/**`);
	});

	it("leaves the report sections alone: their excludes name reports, not files", () => {
		expect(
			anchored(
				"processors:\n  excludes: ['**/Whatever']\nconfig:\n  excludes: '.*>.*'\nconsole-reports:\n  excludes: ['ComplexityReport']\n",
			),
		).toEqual({ kind: "unchanged" });
	});

	it("has nothing to rewrite for an empty config or one without path filters", () => {
		expect(anchored("")).toEqual({ kind: "unchanged" });
		expect(anchored("build:\n")).toEqual({ kind: "unchanged" });
		expect(anchored("style:\n  MagicNumber:\n    active: true\n")).toEqual({
			kind: "unchanged",
		});
	});

	// Each of these is a config the rewrite cannot be shown to keep: refusing is
	// the whole point, since a pass-through would hand the tool the very globs
	// that read the ancestors.
	it.each([
		["a regex matcher", "style:\n  excludes: ['regex:.*claude.*']\n"],
		["a brace string", "style:\n  excludes: '**/*.{kt,kts}'\n"],
		["a leading brace group", "style:\n  excludes: ['{**/a/**,**/b/**}']\n"],
		["a non-list value", "style:\n  excludes: 3\n"],
		["a list holding a non-string", "style:\n  excludes: [1]\n"],
		[
			"a rule's unknown form",
			"style:\n  MagicNumber:\n    includes: ['*/x']\n",
		],
		["YAML the loader rejects", "style: [\n"],
		["a non-mapping root", "- a\n- b\n"],
	])("refuses %s", (_name, text) => {
		const result = anchored(text);
		expect(result.kind).toBe("unapplied");
		expect(result.kind === "unapplied" && result.reason).toContain(
			"its detekt config",
		);
	});
});

describe("anchorPhpstanConfig", () => {
	const dump = (excludePaths: unknown) => ({
		status: 0,
		stdout: JSON.stringify({ excludePaths }),
	});
	const config = "/work/.claude/worktrees/lane1/phpstan.neon";

	it("anchors the wildcard entries, marks a path that does not exist, and includes the project's config", () => {
		const result = anchorPhpstanConfig(
			dump({
				analyseAndScan: [`${ROOT}/vendor`, "**/.claude/**"],
				analyse: [`${ROOT}/src/*/gen`, "*/legacy/*"],
			}),
			config,
			ROOT,
		);
		expect(result).toEqual({
			kind: "rewritten",
			text: [
				"includes:",
				`\t- "${config}"`,
				"parameters:",
				"\texcludePaths!:",
				"\t\tanalyse:",
				`\t\t\t- "${ROOT}/src/*/gen"`,
				`\t\t\t- "${ROOT}/legacy/*"`,
				`\t\t\t- "${ROOT}/*/legacy/*"`,
				"\t\tanalyseAndScan:",
				`\t\t\t- "${ROOT}/vendor (?)"`,
				`\t\t\t- "${ROOT}/.claude/**"`,
				`\t\t\t- "${ROOT}/*/.claude/**"`,
				"",
			].join("\n"),
		});
	});

	// #5606 F1: phpstan reads a ` (?)` after a path that EXISTS as part of the
	// path and stops excluding it, so only a missing path carries the marker.
	it("keeps a path that exists as written, and marks only the one that does not", () => {
		const env = setupTestEnvironment("pi-lens-5594-phpstan-exists-");
		try {
			const present = path.join(env.tmpDir, "src/gen");
			fs.mkdirSync(present, { recursive: true });
			const result = anchorPhpstanConfig(
				dump({
					analyseAndScan: [present, `${env.tmpDir}/not-yet`, "**/.claude/**"],
					analyse: [],
				}),
				config,
				env.tmpDir,
			);
			expect(result.kind === "rewritten" && result.text).toContain(
				`- "${present}"\n`,
			);
			expect(result.kind === "rewritten" && result.text).toContain(
				`- "${env.tmpDir}/not-yet (?)"`,
			);
		} finally {
			env.cleanup();
		}
	});

	it("writes an empty list as one, and doubles a percent sign", () => {
		const result = anchorPhpstanConfig(
			dump({ analyseAndScan: ["**/100%/**"], analyse: [] }),
			config,
			ROOT,
		);
		expect(result.kind === "rewritten" && result.text).toContain(
			"\t\tanalyse: []\n",
		);
		expect(result.kind === "rewritten" && result.text).toContain(
			`- "${ROOT}/100%%/**"`,
		);
	});

	it("has nothing to rewrite when every entry is already absolute or there are none", () => {
		expect(
			anchorPhpstanConfig(
				dump({ analyseAndScan: [`${ROOT}/vendor`], analyse: [] }),
				config,
				ROOT,
			),
		).toEqual({ kind: "unchanged" });
		expect(
			anchorPhpstanConfig(
				dump({ analyseAndScan: [], analyse: [] }),
				config,
				ROOT,
			),
		).toEqual({ kind: "unchanged" });
	});

	describe("ignoreErrors (#5606 Q1)", () => {
		const withIgnore = (ignoreErrors: unknown) => ({
			status: 0,
			stdout: JSON.stringify({
				excludePaths: { analyse: [], analyseAndScan: [] },
				ignoreErrors,
			}),
		});

		it("anchors a wildcard in paths, keeps the entry's other keys, and leaves excludePaths alone", () => {
			const result = anchorPhpstanConfig(
				withIgnore([
					"#a message#",
					{
						message: "#100%#",
						paths: ["**/.claude/**", `${ROOT}/src/gen/*`],
						count: 2,
						identifier: "variable.undefined",
					},
				]),
				config,
				ROOT,
			);
			expect(result).toEqual({
				kind: "rewritten",
				text: [
					"includes:",
					`\t- "${config}"`,
					"parameters:",
					"\tignoreErrors!:",
					`\t\t- "#a message#"`,
					`\t\t- {"message": "#100%%#", "paths": ["${ROOT}/.claude/**", "${ROOT}/*/.claude/**", "${ROOT}/src/gen/*"], "count": 2, "identifier": "variable.undefined"}`,
					"",
				].join("\n"),
			});
		});

		it("moves a wildcard path into paths", () => {
			const result = anchorPhpstanConfig(
				withIgnore([{ message: "#m#", path: "*/legacy/*" }]),
				config,
				ROOT,
			);
			expect(result.kind === "rewritten" && result.text).toContain(
				`{"message": "#m#", "paths": ["${ROOT}/legacy/*", "${ROOT}/*/legacy/*"]}`,
			);
		});

		// Rows P16, P17: a moved `path` becomes `paths`. phpstan refuses `count`
		// without `path`, and merges entries that share a `path` and a message
		// into one with a summed count, which `paths` entries never are.
		it.each([
			[
				"a count",
				[{ message: "#m#", count: 1, path: "*/gen/*" }],
				"with count names the wildcard path",
			],
			[
				"a path another entry shares",
				[
					{ message: "#m#", path: "*/gen/*" },
					{ message: "#m#", path: "*/gen/*" },
				],
				"share the wildcard path",
			],
		])("refuses to move a wildcard path with %s", (_name, entries, reason) => {
			const result = anchorPhpstanConfig(withIgnore(entries), config, ROOT);
			expect(result.kind).toBe("unapplied");
			expect(result.kind === "unapplied" && result.reason).toContain(reason);
		});

		it("has nothing to rewrite when no entry carries a wildcard", () => {
			expect(
				anchorPhpstanConfig(
					withIgnore(["#m#", { message: "#m#", path: `${ROOT}/a.php` }]),
					config,
					ROOT,
				),
			).toEqual({ kind: "unchanged" });
		});

		it.each([
			["ignoreErrors that is not a list", { a: 1 }, "not a list"],
			["a path that is not a string", [{ path: 3 }], "path is not a string"],
			["a paths that is not a list", [{ paths: "x" }], "paths is not a list"],
			[
				"a wildcard form it cannot anchor",
				[{ paths: ["src/*"] }],
				"not a form",
			],
		])("refuses %s", (_name, ignoreErrors, reason) => {
			const result = anchorPhpstanConfig(
				withIgnore(ignoreErrors),
				config,
				ROOT,
			);
			expect(result.kind).toBe("unapplied");
			expect(result.kind === "unapplied" && result.reason).toContain(reason);
		});
	});

	it.each([
		["a failed dump", { status: 1, stdout: "" }, "exited 1"],
		["no status", { status: null, stdout: "" }, "without a status"],
		["output that is not JSON", { status: 0, stdout: "Note: x" }, "no JSON"],
		["no excludePaths", { status: 0, stdout: "{}" }, "no excludePaths object"],
		["a list", dump([]), "no excludePaths object"],
		["an unknown list", dump({ other: [] }), "unknown list"],
		["a non-string entry", dump({ analyse: [3] }), "not a list of strings"],
		[
			"a relative entry with no wildcard lead",
			dump({ analyse: ["src/*"] }),
			"not a form",
		],
	])("refuses %s", (_name, input, reason) => {
		const result = anchorPhpstanConfig(input, config, ROOT);
		expect(result.kind).toBe("unapplied");
		expect(result.kind === "unapplied" && result.reason).toContain(reason);
	});

	it("skips the dump for a config that cannot set excludePaths", () => {
		expect(phpstanConfigMayExclude("parameters:\n    level: 5\n")).toBe(false);
		expect(
			phpstanConfigMayExclude("parameters:\n  excludePaths:\n    - x\n"),
		).toBe(true);
		expect(phpstanConfigMayExclude("includes:\n  - base.neon\n")).toBe(true);
		// An ignoreErrors entry holds a glob only through a path or paths key; a
		// message alone (the captured top-level-errors fixture) has none to anchor.
		expect(
			phpstanConfigMayExclude(
				"parameters:\n  paths:\n    - .\n  ignoreErrors:\n    - '#x#'\n",
			),
		).toBe(false);
		expect(
			phpstanConfigMayExclude(
				"parameters:\n  ignoreErrors:\n    -\n      message: '#x#'\n      paths:\n        - a\n",
			),
		).toBe(true);
		expect(
			phpstanConfigMayExclude(
				"parameters:\n  ignoreErrors:\n    - {message: '#x#', path: a}\n",
			),
		).toBe(true);
		expect(
			phpstanConfigMayExclude("parameters:\n  excludes_analyse:\n    - x\n"),
		).toBe(true);
	});
});

describe("withOverlayFile", () => {
	it("hands the text to the tool in a scratch directory and removes it on every exit path", async () => {
		const env = setupTestEnvironment("pi-lens-5594-scratch-");
		const previous = process.env.PI_LENS_TEST_SCANNER_TMPDIR;
		process.env.PI_LENS_TEST_SCANNER_TMPDIR = env.tmpDir;
		try {
			let seen = "";
			let dir = "";
			const value = await withOverlayFile(
				"detekt",
				"d.yml",
				"a: 1\n",
				async (file) => {
					seen = fs.readFileSync(file, "utf8");
					dir = path.dirname(file);
					expect(path.dirname(dir)).toBe(env.tmpDir);
					return 7;
				},
			);
			expect(value).toBe(7);
			expect(seen).toBe("a: 1\n");
			expect(fs.existsSync(dir)).toBe(false);

			await expect(
				withOverlayFile("detekt", "d.yml", "a: 1\n", async (file) => {
					dir = path.dirname(file);
					throw new Error("the tool blew up");
				}),
			).rejects.toThrow("the tool blew up");
			expect(fs.existsSync(dir)).toBe(false);
			expect(
				fs
					.readdirSync(env.tmpDir)
					.filter((n) => n.startsWith("pi-lens-detekt-anchor-")),
			).toEqual([]);
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_TEST_SCANNER_TMPDIR;
			else process.env.PI_LENS_TEST_SCANNER_TMPDIR = previous;
			env.cleanup();
		}
	});
});

async function ledger() {
	const mod = await import("../../../../clients/degradation-ledger.js");
	mod.resetDegradationLedger();
	return mod;
}

function unanchoredRows(summary: {
	getDegradationSummary(): Array<{
		kind: string;
		count: number;
		latestReasons: Array<{ subject: string; reason: string }>;
	}>;
}) {
	return summary
		.getDegradationSummary()
		.find((entry) => entry.kind === "runner-ignore-unanchored");
}

describe("markUnanchored", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("reports a clean run inconclusive and leaves one record per tool", async () => {
		const summary = await ledger();
		const { markUnanchored: mark } =
			await import("../../../../clients/dispatch/runners/utils/ignore-anchor.js");
		const clean: RunnerResult = {
			status: "succeeded",
			diagnostics: [],
			semantic: "none",
		};
		expect(mark("detekt", "an ignore it cannot anchor", clean)).toMatchObject({
			status: "succeeded",
			inconclusive: true,
		});
		mark("detekt", "an ignore it cannot anchor", clean);
		mark("phpstan", "no dump", clean);
		const group = unanchoredRows(summary);
		expect(group?.count).toBe(3);
		expect(group?.latestReasons.map((row) => row.subject).sort()).toEqual([
			"detekt",
			"phpstan",
		]);
		expect(
			group?.latestReasons.find((row) => row.subject === "detekt")?.reason,
		).toContain("an ignore it cannot anchor");
	});

	it("keeps a finding the tool printed and a failure as it was", () => {
		const finding = {
			status: "failed",
			diagnostics: [{ id: "x" }],
			semantic: "blocking",
		} as never;
		expect(markUnanchored("credo", "why", finding)).toBe(finding);
		const failed = {
			status: "failed",
			diagnostics: [],
			semantic: "none",
		} as never;
		expect(markUnanchored("credo", "why", failed)).toBe(failed);
	});
});

function ctx(kind: string, filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

/**
 * The config argument as the tool saw it, and the text of its last file (detekt
 * takes a comma list and lets the later file win a key), read at spawn because
 * the runner removes the overlay after.
 */
function recordConfigAtSpawn(
	flag: string,
	seen: { text?: string; file?: string },
) {
	return async (_cmd: string, args: string[] = []) => {
		const at = args.indexOf(flag);
		if (at >= 0) {
			seen.file = args[at + 1];
			const last = seen.file?.split(",").at(-1) ?? "";
			seen.text = fs.readFileSync(last, "utf8");
		}
		return { stdout: "", stderr: "", status: 0 };
	};
}

describe("detekt runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	async function runDetekt(root: string) {
		const runner = (
			await import("../../../../clients/dispatch/runners/detekt.js")
		).default;
		return runner.run(
			ctx("kotlin", path.join(root, "src/A.kt"), root) as never,
		);
	}

	function plant(root: string, config: string) {
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "src/A.kt"), "fun f() {}\n");
		fs.writeFileSync(path.join(root, "detekt.yml"), config);
	}

	it("hands detekt a config whose globs are anchored at the root, and removes it after", async () => {
		const env = setupTestEnvironment("pi-lens-5594-detekt-");
		const scratch = path.join(env.tmpDir, "scratch");
		fs.mkdirSync(scratch);
		const previous = process.env.PI_LENS_TEST_SCANNER_TMPDIR;
		process.env.PI_LENS_TEST_SCANNER_TMPDIR = scratch;
		try {
			const root = path.join(env.tmpDir, ".claude/worktrees/lane1");
			plant(
				root,
				"style:\n  MagicNumber:\n    active: true\n    excludes: ['**/.claude/**']\n",
			);
			const seen: { text?: string; file?: string } = {};
			safeSpawnAsync.mockImplementation(recordConfigAtSpawn("--config", seen));

			const result = await runDetekt(root);

			expect(result.status).toBe("succeeded");
			expect(result.inconclusive).toBeUndefined();
			// The project's own file first, so every key the overlay does not
			// carry keeps the value detekt read from it (row D20).
			expect(seen.file?.split(",")).toEqual([
				path.join(root, "detekt.yml"),
				expect.stringContaining(scratch),
			]);
			expect(seen.text).not.toContain("active");
			expect(seen.text).toContain(`${root}/.claude/**`);
			expect(seen.text).toContain(`${root}/**/.claude/**`);
			expect(seen.text).not.toContain("'**/.claude/**'");
			expect(fs.readdirSync(scratch)).toEqual([]);
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_TEST_SCANNER_TMPDIR;
			else process.env.PI_LENS_TEST_SCANNER_TMPDIR = previous;
			env.cleanup();
		}
	});

	it("hands detekt the project's own config when it has no path filter", async () => {
		const env = setupTestEnvironment("pi-lens-5594-detekt-plain-");
		try {
			plant(env.tmpDir, "build:\n  maxIssues: 0\n");
			const seen: { text?: string; file?: string } = {};
			safeSpawnAsync.mockImplementation(recordConfigAtSpawn("--config", seen));

			const result = await runDetekt(env.tmpDir);

			expect(seen.file).toBe(path.join(env.tmpDir, "detekt.yml"));
			expect(result.inconclusive).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// The fail-closed cell. A config the rewrite refuses runs as it stands (the
	// status quo, findings and all) and a clean answer from it is not a verdict.
	it("runs a config it cannot anchor as it stands and never reports it clean", async () => {
		const env = setupTestEnvironment("pi-lens-5594-detekt-refused-");
		try {
			const summary = await ledger();
			plant(
				env.tmpDir,
				"style:\n  MagicNumber:\n    excludes: ['regex:.*claude.*']\n",
			);
			const seen: { text?: string; file?: string } = {};
			safeSpawnAsync.mockImplementation(recordConfigAtSpawn("--config", seen));

			const result = await runDetekt(env.tmpDir);

			expect(seen.file).toBe(path.join(env.tmpDir, "detekt.yml"));
			expect(result.status).toBe("succeeded");
			expect(result.inconclusive).toBe(true);
			const row = unanchoredRows(summary)?.latestReasons.find(
				(entry) => entry.subject === "detekt",
			);
			expect(row?.reason).toContain("regex:.*claude.*");
		} finally {
			env.cleanup();
		}
	});

	it("does not call a run clean when the config is unreadable", async () => {
		const env = setupTestEnvironment("pi-lens-5594-detekt-broken-");
		try {
			const summary = await ledger();
			plant(env.tmpDir, "style: [\n");
			safeSpawnAsync.mockResolvedValue({ stdout: "", stderr: "", status: 0 });

			const result = await runDetekt(env.tmpDir);

			expect(result.inconclusive).toBe(true);
			expect(
				unanchoredRows(summary)?.latestReasons.find(
					(e) => e.subject === "detekt",
				)?.reason,
			).toContain("not readable YAML");
		} finally {
			env.cleanup();
		}
	});
});

/** The spawns that did the work, without the availability probe before them. */
const work = (calls: string[][]) =>
	calls.filter((args) => args[0] !== "--version");

describe("phpstan runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	async function runPhpstan(root: string) {
		const runner = (
			await import("../../../../clients/dispatch/runners/phpstan.js")
		).default;
		return runner.run(ctx("php", path.join(root, "a.php"), root) as never);
	}

	function plant(root: string, config: string) {
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, "a.php"), "<?php\n");
		fs.writeFileSync(path.join(root, "phpstan.neon"), config);
	}

	const CLEAN = {
		stdout: JSON.stringify({
			totals: { errors: 0, file_errors: 0 },
			files: [],
			errors: [],
		}),
		stderr: "",
		status: 0,
	};

	it("analyses with a config that includes the project's and anchors its excludePaths", async () => {
		const env = setupTestEnvironment("pi-lens-5594-phpstan-");
		try {
			const root = path.join(env.tmpDir, ".claude/worktrees/lane1");
			plant(root, "parameters:\n  excludePaths:\n    - '**/.claude/**'\n");
			const calls: string[][] = [];
			const seen: { text?: string; file?: string } = {};
			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[] = []) => {
					calls.push(args);
					if (args[0] === "dump-parameters") {
						return {
							status: 0,
							stdout: JSON.stringify({
								excludePaths: {
									analyseAndScan: ["**/.claude/**"],
									analyse: [],
								},
							}),
							stderr: "Note: Using configuration file x.\n",
						};
					}
					return recordConfigAtSpawn("-c", seen)(_cmd, args).then(() => CLEAN);
				},
			);

			const result = await runPhpstan(root);

			expect(work(calls).map((args) => args[0])).toEqual([
				"dump-parameters",
				"analyse",
			]);
			expect(result.status).toBe("succeeded");
			expect(result.inconclusive).toBeUndefined();
			expect(seen.text).toContain(`"${path.join(root, "phpstan.neon")}"`);
			expect(seen.text).toContain(`- "${root}/.claude/**"`);
			expect(seen.text).not.toContain('"**/.claude/**"');
			expect(fs.existsSync(path.dirname(seen.file ?? ""))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("spawns no dump and passes no -c for a config that cannot exclude", async () => {
		const env = setupTestEnvironment("pi-lens-5594-phpstan-plain-");
		try {
			plant(env.tmpDir, "parameters:\n  level: 5\n");
			const calls: string[][] = [];
			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[] = []) => {
					calls.push(args);
					return CLEAN;
				},
			);

			const result = await runPhpstan(env.tmpDir);

			expect(work(calls).map((args) => args[0])).toEqual(["analyse"]);
			expect(work(calls)[0]).not.toContain("-c");
			expect(result.inconclusive).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// Row P18: phpstan looks for `.phpstan.neon` before `phpstan.neon`, so an
	// overlay that includes the second would hand phpstan a config it never read.
	it("runs as it stands when a dotted config may be the one phpstan reads", async () => {
		const env = setupTestEnvironment("pi-lens-5594-phpstan-dotted-");
		try {
			const summary = await ledger();
			plant(env.tmpDir, "parameters:\n  excludePaths:\n    - '*/gen/*'\n");
			fs.writeFileSync(
				path.join(env.tmpDir, ".phpstan.neon"),
				"parameters:\n  level: 1\n",
			);
			const calls: string[][] = [];
			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[] = []) => {
					calls.push(args);
					return CLEAN;
				},
			);

			const result = await runPhpstan(env.tmpDir);

			expect(work(calls).map((args) => args[0])).toEqual(["analyse"]);
			expect(work(calls)[0]).not.toContain("-c");
			expect(result.inconclusive).toBe(true);
			expect(
				unanchoredRows(summary)?.latestReasons.find(
					(e) => e.subject === "phpstan",
				)?.reason,
			).toContain("may read .phpstan.neon in place of phpstan.neon");
		} finally {
			env.cleanup();
		}
	});

	it("never reports a clean run when phpstan cannot say what it resolved", async () => {
		const env = setupTestEnvironment("pi-lens-5594-phpstan-nodump-");
		try {
			const summary = await ledger();
			plant(env.tmpDir, "includes:\n  - base.neon\n");
			const calls: string[][] = [];
			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[] = []) => {
					calls.push(args);
					return args[0] === "dump-parameters"
						? {
								status: 1,
								stdout: "",
								stderr: "Command dump-parameters is not defined.\n",
							}
						: CLEAN;
				},
			);

			const result = await runPhpstan(env.tmpDir);

			expect(work(calls).map((args) => args[0])).toEqual([
				"dump-parameters",
				"analyse",
			]);
			expect(work(calls)[1]).not.toContain("-c");
			expect(result.status).toBe("succeeded");
			expect(result.inconclusive).toBe(true);
			expect(
				unanchoredRows(summary)?.latestReasons.find(
					(e) => e.subject === "phpstan",
				)?.reason,
			).toContain("dump-parameters exited 1");
		} finally {
			env.cleanup();
		}
	});
});

/** What credo 1.7.19 prints when the overlay raises (measured, exit 129). */
const REFUSAL_STDERR =
	'warning: Execution halted during Elixir.Credo.Execution.Task.ConvertCLIOptionsToConfig! Unrecognized error: {:badconfig, "/tmp/x/anchor.exs", %RuntimeError{message: "pi-lens-ignore-unanchored: the file is outside the project root"}}\n  (credo 1.7.19) lib/credo/execution/task.ex:138: Credo.Execution.Task.do_run/3\n';

describe("credo runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	const CLEAN = {
		stdout: JSON.stringify({ issues: [] }),
		stderr: "",
		status: 0,
	};

	async function runCredo(root: string) {
		const runner = (
			await import("../../../../clients/dispatch/runners/credo.js")
		).default;
		return runner.run(
			ctx("elixir", path.join(root, "lib/a.ex"), root) as never,
		);
	}

	function plant(root: string) {
		fs.mkdirSync(path.join(root, "lib"), { recursive: true });
		fs.writeFileSync(path.join(root, "lib/a.ex"), "defmodule A do\nend\n");
		fs.writeFileSync(
			path.join(root, "mix.exs"),
			"defmodule P.MixProject do\nend\n",
		);
	}

	function spawnSeam(
		overlay: { text?: string; env?: NodeJS.ProcessEnv },
		refuse: boolean,
	) {
		const runs: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
		safeSpawnAsync.mockImplementation(
			async (
				_cmd: string,
				args: string[] = [],
				options: { env?: NodeJS.ProcessEnv } = {},
			) => {
				if (args.includes("--version"))
					return { stdout: "Credo 1.7.19", stderr: "", status: 0 };
				runs.push({ args, env: options.env });
				const at = args.indexOf("--config-file");
				if (at >= 0) {
					overlay.text = fs.readFileSync(args[at + 1], "utf8");
					overlay.env = options.env;
					if (refuse) {
						return {
							stdout: "",
							stderr: REFUSAL_STDERR,
							status: 129,
						};
					}
				}
				return CLEAN;
			},
		);
		return runs;
	}

	it("runs credo on an overlay config that takes the root and the file from the environment", async () => {
		const env = setupTestEnvironment("pi-lens-5594-credo-");
		try {
			plant(env.tmpDir);
			const overlay: { text?: string; env?: NodeJS.ProcessEnv } = {};
			const runs = spawnSeam(overlay, false);

			const result = await runCredo(env.tmpDir);

			expect(runs).toHaveLength(1);
			expect(runs[0].args).toContain("--config-file");
			expect(runs[0].args.at(-1)).toBe(path.join(env.tmpDir, "lib/a.ex"));
			expect(overlay.env).toMatchObject({
				PI_LENS_ANCHOR_ROOT: env.tmpDir,
				PI_LENS_ANCHOR_TARGET: path.join(env.tmpDir, "lib/a.ex"),
			});
			// One constant: a path that is not in the script cannot be an injection.
			expect(overlay.text).not.toContain(env.tmpDir);
			expect(overlay.text).toContain("Credo.ConfigFile.read_or_default");
			expect(result.status).toBe("succeeded");
			expect(result.inconclusive).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// The fail-closed cell. The overlay refuses by raising its marker; credo
	// then runs on the project's own config and a clean answer is withheld.
	it("falls back to the project's own config when the overlay refuses, and never reports it clean", async () => {
		const env = setupTestEnvironment("pi-lens-5594-credo-refused-");
		try {
			const summary = await ledger();
			plant(env.tmpDir);
			const overlay: { text?: string; env?: NodeJS.ProcessEnv } = {};
			const runs = spawnSeam(overlay, true);

			const result = await runCredo(env.tmpDir);

			expect(runs).toHaveLength(2);
			expect(runs[1].args).not.toContain("--config-file");
			expect(result.status).toBe("succeeded");
			expect(result.inconclusive).toBe(true);
			expect(
				unanchoredRows(summary)?.latestReasons.find(
					(e) => e.subject === "credo",
				)?.reason,
			).toContain("the file is outside the project root");
		} finally {
			env.cleanup();
		}
	});

	// #5606 F4: a finding message quotes the file's own text, so a source line
	// that holds the marker must not read as the overlay's refusal and discard
	// the anchored run's findings.
	const keptAnchoredRun = async (answer: {
		stdout: string;
		stderr: string;
		status: number;
	}) => {
		const env = setupTestEnvironment("pi-lens-5594-credo-lookalike-");
		try {
			plant(env.tmpDir);
			const runs: string[][] = [];
			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[] = []) => {
					if (args.includes("--version"))
						return { stdout: "Credo 1.7.19", stderr: "", status: 0 };
					runs.push(args);
					return answer;
				},
			);

			const result = await runCredo(env.tmpDir);

			expect(runs).toHaveLength(1);
			expect(runs[0]).toContain("--config-file");
			expect(result.inconclusive).toBeUndefined();
		} finally {
			env.cleanup();
		}
	};

	it("keeps the anchored run when a finding quotes the marker", () =>
		keptAnchoredRun({
			stdout: JSON.stringify({
				issues: [
					{
						check: "Credo.Check.Design.TagTODO",
						message:
							"Found a TODO tag in a comment: # TODO: pi-lens-ignore-unanchored: boom",
						filename: "lib/a.ex",
						line_no: 3,
						priority: 1,
					},
				],
			}),
			stderr: "",
			status: 2,
		}));

	it("keeps the anchored run when a stderr line quotes the marker", () =>
		keptAnchoredRun({
			stdout: JSON.stringify({ issues: [] }),
			stderr:
				'compiler said: %RuntimeError{message: "pi-lens-ignore-unanchored: boom"}\n',
			status: 0,
		}));
});
