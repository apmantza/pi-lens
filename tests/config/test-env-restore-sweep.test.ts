/**
 * #4589: unrestored `process.env` writes in test source — a ratchet.
 *
 * The 2026-10-17 audit of Greptile's reviews counted the same test-hygiene
 * leak seven times (#4563, #4572, #4573, #4574, #4581, #4582, #4586): a case
 * assigns or deletes an environment variable and nothing puts it back, so the
 * NEXT case in the same worker inherits the value. This sweep decides the one
 * shape that is decidable from test source. The detector lives in
 * `tests/support/test-env-restore-gate.ts`; its docstring lists the accepted
 * restore shapes (a covering teardown or same-function `finally` that deletes,
 * re-assigns a SAVED value, writes a declared key list or saved record, or
 * runs `vi.unstubAllEnvs()` after `vi.stubEnv`).
 *
 * The baseline (`tests/support/test-env-restore-baseline.ts`) admits the
 * writes no restore provably covers, so this lands as a ratchet instead of a
 * mass edit. Most rows are the leaks master already had; a change adds a row
 * only where a restore would re-arm the defect its write pins (#4673's
 * run-wide jiti cache pin). Every admitted file carries a reason in
 * `tests/support/test-env-restore-admissions.ts`, re-checked against the file
 * here: a new row cannot be admitted by appending one line (AGENTS.md shape
 * 38). Shrinking the baseline is the work; growing it reds.
 *
 * The sweep reads comment- and string-BLANKED source (principles §2,
 * "Detectors match code, not prose"), so an env write quoted in a comment or
 * in a fixture string is not a write, and a restore quoted in one is not a
 * restore.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	readWalkedFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import {
	type EnvRestoreFinding,
	type EnvRestoreMechanism,
	envRestoreKey,
	envRestoreMechanisms,
	escapeRowKey,
	findUnrestoredEnvWrites,
} from "../support/test-env-restore-gate.js";
import { TEST_ENV_RESTORE_ADMISSIONS } from "../support/test-env-restore-admissions.js";
import { TEST_ENV_RESTORE_BASELINE } from "../support/test-env-restore-baseline.js";
import { expectPlantedStaleRow } from "../support/baseline-staleness.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const BASELINE_PATH = path.join(
	REPO_ROOT,
	"tests/support/test-env-restore-baseline.ts",
);
const BASELINE_HEADER =
	"#4589 baseline: env writes no restore provably covers, admitted so the sweep is a ratchet, not a mass edit. Rows are the leaks master already had, plus rows a change adds where a restore would re-arm the defect its write pins.";
/** The admission guard's row spelling; a regenerated row must pass it. */
const ROW_RE = /^tests\/[\w./-]+\.ts:[^\s]+$/;
/** Baseline for the live tree, as a Set so the two directions are symmetric. */
const BASELINE: ReadonlySet<string> = new Set(TEST_ENV_RESTORE_BASELINE);

/**
 * `tests/fixtures/**` is out of the population: a fixture entry script runs in
 * its own child process, so the env it writes dies with that process and no
 * sibling case can inherit it.
 */
const OUT_OF_POPULATION = "fixtures/";

/**
 * Every env write in test source that no accepted restore covers.
 *
 * The walk reads one file at a time and turns the event loop between files,
 * the shape the sibling `vi-mock-export-sweep` uses (#3565), so a big
 * population cannot pin every file's text at once inside one case budget.
 */
function detectAcrossFiles(files: string[]): EnvRestoreFinding[] {
	const findings: EnvRestoreFinding[] = [];
	for (const { file, source } of readWalkedFiles(files)) {
		// Repo-relative, so a baseline row survives a lane's absolute path.
		findings.push(
			...findUnrestoredEnvWrites(relativePosix(REPO_ROOT, file), source),
		);
	}
	return findings;
}

let sweepPromise: EnvRestoreFinding[] | undefined;

function sweptFiles(): string[] {
	return listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith(OUT_OF_POPULATION),
	});
}

function sweepOnce(): EnvRestoreFinding[] {
	if (sweepPromise) return sweepPromise;
	const files = sweptFiles();
	// Floor 1,400 against the ~1,590 non-fixture `tests/**/*.ts` at authoring
	// time: low enough that ordinary file churn never trips it, high enough
	// that a silently dropped directory does (shape 10).
	assertNonEmptyScan("#4589 test-env-restore sweep", files.length, 1400);
	sweepPromise = detectAcrossFiles(files);
	return sweepPromise;
}

/** Baseline rows the live tree no longer reports, so the list only shrinks. */
function staleBaselineRows(
	findings: readonly EnvRestoreFinding[],
	baseline: ReadonlySet<string>,
): string[] {
	const live = new Set(findings.map(envRestoreKey));
	return [...baseline].filter((entry) => !live.has(entry)).sort();
}

function formatFinding(finding: EnvRestoreFinding): string {
	return `${envRestoreKey(finding)} (${finding.kind} at line ${finding.line})`;
}

/**
 * Keys the live tree reports that the baseline does not admit. One red per
 * distinct `file:key` row: a second write of an admitted key in the same file
 * is the same decision, not a new offender.
 */
function unadmittedOffenders(
	findings: readonly EnvRestoreFinding[],
	baseline: ReadonlySet<string>,
): string[] {
	const reported = new Map<string, EnvRestoreFinding>();
	for (const finding of findings) {
		const entry = envRestoreKey(finding);
		if (baseline.has(entry) || reported.has(entry)) continue;
		reported.set(entry, finding);
	}
	return [...reported.values()].map(formatFinding);
}

describe("#4589 test-env-restore detector — the shapes that must red and green", () => {
	const detect = (source: string) =>
		findUnrestoredEnvWrites("tests/config/case.test.ts", source);
	const keys = (findings: readonly EnvRestoreFinding[]) =>
		findings.map((finding) => finding.key);

	it("r3 expression matrix detects wrapped and rebound env writes (#4593 F1)", () => {
		// Shape 69: identity follows AST expressions, not a wrapper spelling list.
		const prefix =
			"const env = process.env; const again = env; const { env: destructured } = process;";
		for (const expression of [
			"process.env.K!",
			"process.env['K']!",
			"(env).K",
			"(env as NodeJS.ProcessEnv).K",
			"(env!).K",
			"(process?.env).K",
			"process['env'].K",
			"destructured.K",
			"again.K",
			"(<NodeJS.ProcessEnv>process.env).K",
			"(env satisfies NodeJS.ProcessEnv).K",
		]) {
			expect(
				keys(detect(`${prefix} ${expression} = "x";`)),
				expression,
			).toContain("K");
		}
		for (const object of [
			"(env)",
			"(env as NodeJS.ProcessEnv)",
			"env!",
			"process['env']",
			"(process?.env)",
			"destructured",
			"again",
			"(<NodeJS.ProcessEnv>env)",
		]) {
			expect(keys(detect(`${prefix} delete ${object}.K;`)), object).toContain(
				"K",
			);
			expect(
				keys(detect(`${prefix} Object.assign(${object}, {K: "x"});`)),
				object,
			).toContain("<process.env>");
			expect(detect(`${prefix} void ${object}.K;`), object).toEqual([]);
		}
	});

	it("r3 assign cannot delete new keys or restore a partial record's other key (#4593 F2)", () => {
		for (const saved of [
			"{ ...process.env }",
			"{ OTHER: process.env.OTHER }",
		]) {
			for (const cleanup of [
				"afterEach(() => { Object.assign(process.env, saved); });",
				"",
			]) {
				const write = 'process.env.NEW_KEY = "x";';
				const source = `const saved = ${saved}; ${cleanup} it("a", () => { ${cleanup ? write : `try { ${write} } finally { Object.assign(process.env, saved); }`} });`;
				expect(keys(detect(source))).toContain("NEW_KEY");
			}
		}
		expect(
			keys(
				detect(
					'const saved = { K: process.env.K }; afterEach(() => { Object.assign(process.env, saved); }); it("a", () => { process.env.K = "x"; });',
				),
			),
		).toContain("K");
	});

	it("r3 delete-all must execute for every current key (#4593 F2)", () => {
		for (const body of [
			'if (key.startsWith("PREFIX")) delete process.env[key];',
			"const unused = () => { delete process.env[key]; };",
			"delete process.env.OTHER;",
		]) {
			const source = `const saved = { ...process.env }; it("a", () => { try { process.env.NEW_KEY = "x"; } finally { for (const key of Object.keys(process.env)) { ${body} } Object.assign(process.env, saved); } });`;
			expect(keys(detect(source)), body).toContain("NEW_KEY");
		}
		for (const body of [
			"delete process.env[key];",
			"{ delete process.env[key]; }",
		]) {
			expect(
				detect(
					`const saved = { ...process.env }; it("a", () => { try { process.env.NEW_KEY = "x"; } finally { for (const key of Object.keys(process.env)) ${body} Object.assign(process.env, saved); } });`,
				),
			).toEqual([]);
		}
	});

	it("reds on an env write with no restore anywhere (#4563)", () => {
		expect(
			detect(
				[
					'import { it } from "vitest";',
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME", kind: "assign", line: 3 }]);
	});

	it("greens when an afterEach deletes the same key (#4563)", () => {
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					"afterEach(() => {",
					"\tdelete process.env.PI_LENS_HOME;",
					"});",
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("greens when an afterEach restores the saved value", () => {
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					"const saved = process.env.PILENS_DATA_DIR;",
					"afterEach(() => {",
					"\tprocess.env.PILENS_DATA_DIR = saved;",
					"});",
					'it("a case", () => {',
					'\tprocess.env.PILENS_DATA_DIR = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on a teardown assignment of a LITERAL, which restores nothing", () => {
		// A write inside a teardown is still a write unless it puts a saved
		// value back. The reset-to-a-default idiom is the live shape.
		const findings = detect(
			[
				'import { afterEach, it } from "vitest";',
				"afterEach(() => {",
				'\tprocess.env.PI_LENS_HOME = "0";',
				"});",
				'it("a case", () => {',
				'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
				"});",
			].join("\n"),
		);
		// Two sites, one row: the teardown's literal reset and the case's leak.
		expect(keys(findings)).toEqual(["PI_LENS_HOME", "PI_LENS_HOME"]);
		expect(findings.map((finding) => finding.line)).toEqual([3, 6]);
	});

	it("still reds when the only restore is in a comment or a string", () => {
		// §2, "Detectors match code, not prose": a restore QUOTED in the file
		// is not a restore, or every offending file could green itself with a
		// comment.
		expect(
			detect(
				[
					'import { it } from "vitest";',
					"// afterEach(() => { delete process.env.PI_LENS_HOME; });",
					'const reminder = "afterEach(() => delete process.env.PI_LENS_HOME)";',
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME", kind: "assign" }]);
	});

	it("reds on a write quoted only inside a fixture string", () => {
		// The other half of the same rule: a test that STORES a leaking
		// assignment in a fixture string writes nothing.
		expect(
			detect(
				[
					"const fixture = [",
					"\t'process.env.PI_LENS_HOME = \"/tmp/leak\";',",
					'].join("\\n");',
				].join("\n"),
			),
		).toEqual([]);
	});

	it("greens on vi.stubEnv paired with vi.unstubAllEnvs (#4572)", () => {
		expect(
			detect(
				[
					'import { afterEach, it, vi } from "vitest";',
					"afterEach(() => {",
					"\tvi.unstubAllEnvs();",
					"});",
					'it("a case", () => {',
					'\tvi.stubEnv("GITHUB_TOKEN", "test-token");',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on vi.stubEnv with no unstubAllEnvs (#4572)", () => {
		expect(
			detect(
				[
					'import { it, vi } from "vitest";',
					'it("a case", () => {',
					'\tvi.stubEnv("GITHUB_TOKEN", "test-token");',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "GITHUB_TOKEN", kind: "stub" }]);
	});

	it("greens on a teardown key-list loop", () => {
		// The dominant live idiom: keys held in one array and put back in a
		// loop. The loop's own `delete` is the restore, so the array is read.
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					'const ENV_KEYS = ["PI_LENS_HOME", "PILENS_DATA_DIR"] as const;',
					"afterEach(() => {",
					"\tfor (const key of ENV_KEYS) delete process.env[key];",
					"});",
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on a loop that only READS the key list", () => {
		// The loop is real and writes through its variable,
		// but only reads the value, so nothing is restored. Deleting the
		// write-through requirement in the detector cannot keep this green.
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					'const ENV_KEYS = ["PI_LENS_HOME"] as const;',
					"afterEach(() => {",
					"\tfor (const key of ENV_KEYS) {",
					"\t\texpect(process.env[key]).toBeUndefined();",
					"\t}",
					"});",
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME" }]);
	});

	it("greens on a teardown helper call that carries the saved value", () => {
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					"const previous = { home: process.env.PI_LENS_HOME };",
					"function restore(name: string, value: string | undefined): void {",
					"\tif (value === undefined) delete process.env[name];",
					"\telse process.env[name] = value;",
					"}",
					"afterEach(() => {",
					'\trestore("PI_LENS_HOME", previous.home);',
					"});",
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("greens on a restore loop through a one-hop file-local helper", () => {
		// The `ndjson-truncate-real-home-guard` shape: the teardown calls the
		// file's own restoreEnv(), whose record loop puts every saved key back.
		expect(
			detect(
				[
					"const saved = { HOME: process.env.HOME, PI_LENS_HOME: process.env.PI_LENS_HOME };",
					"function restoreEnv(): void {",
					"\tfor (const [key, value] of Object.entries(saved)) {",
					"\t\tif (value === undefined) delete process.env[key];",
					"\t\telse process.env[key] = value;",
					"\t}",
					"}",
					"afterEach(() => { restoreEnv(); });",
					'it("a case", () => {',
					'\tprocess.env.HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on a teardown call that only names the key", () => {
		// `log("K", process.env.K)` reads the key: a call is not a restore
		// because it has two arguments. Only the callee's body decides.
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					'it("a case", () => { process.env.PI_LENS_HOME = "/tmp/leak"; });',
					'afterEach(() => { console.log("PI_LENS_HOME", process.env.PI_LENS_HOME); });',
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME" }]);
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					'it("a case", () => { process.env.PI_LENS_HOME = "/tmp/leak"; });',
					'afterEach(() => { expect("PI_LENS_HOME", "unrelated").toBe("PI_LENS_HOME"); });',
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME" }]);
	});

	it("reds on a write made INSIDE a teardown", () => {
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					"afterEach(() => {",
					'\tprocess.env.PROBE_LEAK_IN_TEARDOWN = "1";',
					"});",
					'it("a case", () => {});',
				].join("\n"),
			),
		).toMatchObject([{ key: "PROBE_LEAK_IN_TEARDOWN" }]);
	});

	it("reds when a SIBLING describe's afterEach restores the key", () => {
		// A teardown runs for its own describe and its nested suites only.
		expect(
			detect(
				[
					'describe("A", () => {',
					"\tafterEach(() => { delete process.env.PROBE_K; });",
					'\tit("a", () => {});',
					"});",
					'describe("B", () => {',
					'\tit("b", () => { process.env.PROBE_K = "1"; });',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PROBE_K" }]);
	});

	it("greens when the covering afterEach is in the write's own describe", () => {
		expect(
			detect(
				[
					'describe("A", () => {',
					"\tafterEach(() => { delete process.env.PROBE_OK; });",
					'describe("inner", () => {',
					'\tit("a", () => { process.env.PROBE_OK = "1"; });',
					"});",
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("binds a key list to the declaration in the reader's scope", () => {
		// Two suites each declare ENV_KEYS; the write belongs to the second
		// array, which does not name its key.
		expect(
			detect(
				[
					'describe("A", () => {',
					'\tconst ENV_KEYS = ["PROBE_G3"];',
					"\tafterEach(() => {",
					"\t\tfor (const key of ENV_KEYS) delete process.env[key];",
					"\t});",
					"});",
					'describe("B", () => {',
					'\tconst ENV_KEYS = ["SOMETHING_ELSE"];',
					"\tafterEach(() => {",
					"\t\tfor (const key of ENV_KEYS) delete process.env[key];",
					"\t});",
					'\tit("b", () => { process.env.PROBE_G3 = "1"; });',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PROBE_G3" }]);
	});

	it("greens on a finally in the same function (#4573)", () => {
		expect(
			detect(
				[
					'import { it } from "vitest";',
					'it("a case", async () => {',
					"\ttry {",
					'\t\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"\t} finally {",
					"\t\tdelete process.env.PI_LENS_HOME;",
					"\t}",
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on a finally in a different function (#4573)", () => {
		// A restore in SOME function is not a restore of this write: the two
		// cases run under different owners. This is the `sameOwner` guard.
		expect(
			detect(
				[
					'import { it } from "vitest";',
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
					'it("another case", async () => {',
					"\ttry {",
					'\t\tprocess.env.PI_LENS_PROBE = "1";',
					"\t} finally {",
					"\t\tdelete process.env.PI_LENS_HOME;",
					"\t}",
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME" }, { key: "PI_LENS_PROBE" }]);
	});

	it("reds on a finally whose owner is the enclosing test, not the nested arrow", () => {
		// The nested function is the write's owner, so an outer `finally`
		// does not run for it as the same function.
		expect(
			detect(
				[
					'import { it } from "vitest";',
					'it("a case", async () => {',
					"\tconst run = () => {",
					'\t\tprocess.env.PI_LENS_NESTED = "1";',
					"\t};",
					"\ttry {",
					"\t\trun();",
					"\t} finally {",
					"\t\tdelete process.env.PI_LENS_NESTED;",
					"\t}",
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_NESTED" }]);
	});

	it("names a computed key by its expression, and escapes its row", () => {
		const findings = detect(
			[
				'import { it } from "vitest";',
				'it("a case", () => {',
				'\tprocess.env["PI_LENS_" + "HOME"] = "/tmp/leak";',
				'\tprocess.env[ENV_REVIEW_GRAPH_MAX] = "3";',
				"});",
			].join("\n"),
		);
		expect(keys(findings)).toEqual([
			'["PI_LENS_" + "HOME"]',
			"ENV_REVIEW_GRAPH_MAX",
		]);
		// The row a regen writes must pass the admission guard, so a computed
		// key cannot block the tree: whitespace is escaped, not dropped.
		const rows = findings.map(envRestoreKey);
		expect(rows).toEqual([
			'tests/config/case.test.ts:["PI_LENS_"%20+%20"HOME"]',
			"tests/config/case.test.ts:ENV_REVIEW_GRAPH_MAX",
		]);
		expect(rows.filter((row) => !ROW_RE.test(row))).toEqual([]);
		expect(escapeRowKey("100% done")).toBe("100%25%20done");
	});

	it("fail-closed: reds on every write spelling the enumerator knows", () => {
		// Shape 69: each spelling is a write; none may pass silently.
		const cases: Array<{ name: string; source: string; key: string }> = [
			{
				name: "Object.assign(process.env, {...})",
				source:
					'it("a", () => { Object.assign(process.env, { PROBE_OA: "1" }); });',
				key: "<process.env>",
			},
			{
				name: "an alias bound from process.env",
				source: [
					'it("a", () => {',
					"\tconst env = process.env;",
					'\tenv.PROBE_ALIAS = "1";',
					"});",
				].join("\n"),
				key: "PROBE_ALIAS",
			},
			{
				name: "globalThis.process.env",
				source: 'it("a", () => { globalThis.process.env.PROBE_GT = "1"; });',
				key: "PROBE_GT",
			},
			{
				name: "Object.defineProperty(process.env, ...)",
				source: [
					'it("a", () => {',
					'\tObject.defineProperty(process.env, "PROBE_DP", { value: "1" });',
					"});",
				].join("\n"),
				key: "PROBE_DP",
			},
			{
				name: "a logical-and assignment",
				source: 'it("a", () => { process.env.PROBE_AND &&= "x"; });',
				key: "PROBE_AND",
			},
			{
				name: "a nullish assignment",
				source: 'it("a", () => { process.env.PROBE_NULL ??= "x"; });',
				key: "PROBE_NULL",
			},
			{
				name: "an operator on the next line",
				source: 'it("a", () => { process.env.PROBE_NL\n\t= "x"; });',
				key: "PROBE_NL",
			},
			{
				name: "an index operator on the next line",
				source: 'it("a", () => { process.env["PROBE_NLB"]\n\t= "x"; });',
				key: "PROBE_NLB",
			},
			{
				name: "a destructuring assignment target",
				source: 'it("a", () => { [process.env.PROBE_UNK] = ["1"]; });',
				key: "PROBE_UNK",
			},
		];
		for (const probe of cases) {
			const findings = detect(probe.source);
			expect(
				findings.map((finding) => finding.key),
				`${probe.name} must be a finding`,
			).toContain(probe.key);
			for (const finding of findings)
				expect(
					ROW_RE.test(envRestoreKey(finding)),
					`${probe.name}: ${envRestoreKey(finding)} must pass the row guard`,
				).toBe(true);
		}
		// A `defineProperty` cannot name a saved value, so its kind says so.
		expect(
			detect(
				'it("a", () => { Object.defineProperty(process.env, "K", { value: "1" }); });',
			),
		).toMatchObject([{ kind: "unclassified" }]);
	});

	it("fail-closed: an optional chain, non-null assertion or cast is still a write", () => {
		// The role decides, not the spelling: each of these continues the member
		// chain of the same seam, so the assignment writes the environment.
		const cases: Array<{ name: string; source: string; key: string }> = [
			{
				name: "optional chaining",
				source: 'it("a", () => { (process?.env).PROBE_OPT = "1"; });',
				key: "PROBE_OPT",
			},
			{
				name: "optional index",
				source: 'it("a", () => { (process?.env)["PROBE_OIDX"] = "1"; });',
				key: "PROBE_OIDX",
			},
			{
				name: "non-null assertion",
				source: 'it("a", () => { process.env!.PROBE_NN = "1"; });',
				key: "PROBE_NN",
			},
			{
				name: "grouped reference",
				source: 'it("a", () => { (process.env).PROBE_GRP = "1"; });',
				key: "PROBE_GRP",
			},
			{
				name: "cast target",
				source: 'it("a", () => { (process.env as any).PROBE_CAST = "1"; });',
				key: "PROBE_CAST",
			},
			{
				name: "satisfies target",
				source:
					'it("a", () => { (process.env satisfies unknown as any).PROBE_SAT = "1"; });',
				key: "PROBE_SAT",
			},
			{
				name: "optional chain on an alias",
				source: [
					'it("a", () => {',
					"\tconst env = process.env;",
					'\t(env!).PROBE_AO = "1";',
					"});",
				].join("\n"),
				key: "PROBE_AO",
			},
			{
				name: "Object.assign on an alias",
				source: [
					'it("a", () => {',
					"\tconst env = process.env;",
					'\tObject.assign(env, { PROBE_AM: "1" });',
					"});",
				].join("\n"),
				key: "<process.env>",
			},
			{
				name: "Reflect.set on an alias",
				source: [
					'it("a", () => {',
					"\tconst env = process.env;",
					'\tReflect.set(env, "PROBE_AR", "1");',
					"});",
				].join("\n"),
				key: "<process.env>",
			},
		];
		for (const probe of cases) {
			const findings = detect(probe.source);
			expect(
				findings.map((finding) => finding.key),
				`${probe.name} must be a finding`,
			).toContain(probe.key);
			for (const finding of findings)
				expect(
					ROW_RE.test(envRestoreKey(finding)),
					`${probe.name}: ${envRestoreKey(finding)} must pass the row guard`,
				).toBe(true);
		}
	});

	it("keeps a cast or grouped reference used as a VALUE a read", () => {
		// The same wrapper: the role after it decides. No assignment target, no
		// finding, or every `expect(process.env)` would red.
		expect(
			detect('const e = (process.env as any); it("a", () => { void e; });'),
		).toEqual([]);
		expect(
			detect('it("a", () => { expect(process.env).toBeTruthy(); });'),
		).toEqual([]);
	});

	it("fail-closed: an unrecognised follower is unclassified, not a read", () => {
		// The last-resort classification: the seam was reached in a role the
		// enumerator cannot place, so it reports instead of staying silent.
		expect(detect('it("a", () => { process.env(); });')).toMatchObject([
			{ key: "<process.env>", kind: "unclassified" },
		]);
		expect(detect('it("a", () => { process.env`x`; });')).toMatchObject([
			{ key: "<process.env>", kind: "unclassified" },
		]);
	});

	it("reds on a teardown that reassigns the environment from live state", () => {
		// A whole-environment assignment restores only from a saved copy. The
		// live environment, a fresh literal, and a live copy plus one key put
		// nothing back, so the case still leaks its key.
		for (const value of [
			"{ ...process.env }",
			'{ OTHER_KEY: "1" }',
			'{ ...process.env, EXTRA: "1" }',
		]) {
			const findings = detect(
				[
					`afterEach(() => { process.env = ${value}; });`,
					'it("a", () => { process.env.PROBE_WHOLE = "1"; });',
				].join("\n"),
			);
			expect(
				findings.map((finding) => finding.key),
				value,
			).toContain("PROBE_WHOLE");
		}
	});

	it("reds on a whole-environment copy saved INSIDE the teardown", () => {
		// Only a value captured before the write is saved. A copy taken in the
		// teardown copies whatever the case leaked, so it restores nothing.
		const findings = detect(
			[
				"afterEach(() => {",
				"\tconst live = { ...process.env };",
				"\tprocess.env = { ...live };",
				"});",
				'it("a", () => { process.env.PROBE_IN = "1"; });',
			].join("\n"),
		);
		expect(findings.map((finding) => finding.key)).toContain("PROBE_IN");
	});

	it("greens on a whole-environment restore from a saved copy", () => {
		expect(
			detect(
				[
					"const saved = { ...process.env };",
					"afterEach(() => { process.env = { ...saved }; });",
					'it("a", () => { process.env.PROBE_WHOLE_OK = "1"; });',
				].join("\n"),
			),
		).toEqual([]);
	});

	it("greens on delete-all then Object.assign(process.env, saved) in a finally", () => {
		// A mutator copies a saved record back: the value argument is the
		// restore, exactly as an assignment's right side is.
		expect(
			detect(
				[
					"const saved = { ...process.env };",
					'it("a", () => {',
					"\ttry {",
					'\t\tprocess.env.PROBE_OA = "1";',
					"\t} finally {",
					"\t\tfor (const key of Object.keys(process.env)) delete process.env[key];",
					"\t\tObject.assign(process.env, saved);",
					"\t}",
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on a teardown that reassigns a FIXED DEFAULT", () => {
		// A name declared outside cleanup is only saved when it READ the
		// environment. A constant default restores nothing.
		expect(
			detect(
				[
					'const DEFAULT_MODE = "0";',
					"afterEach(() => { process.env.PI_LENS_TEST_MODE = DEFAULT_MODE; });",
					'it("a", () => { process.env.PI_LENS_TEST_MODE = "1"; });',
				].join("\n"),
			).map((finding) => finding.key),
		).toContain("PI_LENS_TEST_MODE");
		// The whole-environment twin: a literal record is a default too.
		expect(
			detect(
				[
					'const DEFAULTS = { PI_LENS_TEST_MODE: "0" };',
					"afterEach(() => { process.env = { ...DEFAULTS }; });",
					'it("a", () => { process.env.PI_LENS_TEST_MODE = "1"; });',
				].join("\n"),
			).map((finding) => finding.key),
		).toContain("PI_LENS_TEST_MODE");
	});

	it("reds when a member call shares a file-local helper's name", () => {
		// `logger.restore()` calls a method on another object; the file-local
		// `restore` is not the callee, so its delete restores nothing.
		const source = [
			"function restore(): void { delete process.env.PROBE_T2_ONE; }",
			"const logger = { restore() {} };",
			'it("a", () => { process.env.PROBE_T2_ONE = "1"; });',
			"afterEach(() => { logger.restore(); });",
		].join("\n");
		expect(detect(source).map((finding) => finding.key)).toContain(
			"PROBE_T2_ONE",
		);
	});

	it("reds when a helper name is declared in two scopes", () => {
		// Two `restore` bodies exist; only one can run at this call, so the
		// detector refuses to inline either and keeps the write as a finding.
		const source = [
			'describe("A", () => {',
			"\tfunction restore(): void { delete process.env.PROBE_T2_TWO; }",
			"\tafterEach(() => { restore(); });",
			'\tit("a", () => { process.env.PROBE_T2_TWO = "1"; });',
			"});",
			'describe("B", () => {',
			"\tfunction restore(): void {}",
			"});",
		].join("\n");
		expect(detect(source).map((finding) => finding.key)).toContain(
			"PROBE_T2_TWO",
		);
	});

	it("reds on a nested function declared in cleanup but never called", () => {
		// Declaring `unused` never performs its delete.
		const source = [
			'it("a", () => { process.env.PROBE_T3 = "1"; });',
			"afterEach(() => {",
			"\tconst unused = () => { delete process.env.PROBE_T3; };",
			"\tvoid unused;",
			"});",
		].join("\n");
		expect(detect(source).map((finding) => finding.key)).toContain("PROBE_T3");
	});

	it("reds on a write that runs after its finally", () => {
		// The finally has already run when the write happens.
		const source = [
			'it("case", () => {',
			"\ttry {} finally { delete process.env.PROBE_T4; }",
			'\tprocess.env.PROBE_T4 = "leak";',
			"});",
		].join("\n");
		expect(detect(source).map((finding) => finding.key)).toContain("PROBE_T4");
	});

	it("binds a cleanup loop to the loop that encloses the delete", () => {
		// The delete sits outside the loop, so it deletes whatever `key` holds
		// (an outer binding), not the loop's literal.
		const source = [
			'const key = "PROBE_T5_OUTER";',
			"afterEach(() => {",
			'\tfor (const key of ["PROBE_T5_LOOP"]) { void key; }',
			"\tdelete process.env[key];",
			"});",
			'it("a", () => { process.env.PROBE_T5_LOOP = "1"; });',
		].join("\n");
		expect(detect(source).map((finding) => finding.key)).toContain(
			"PROBE_T5_LOOP",
		);
	});

	it("reds when a baseline row vanishes from the tree", () => {
		const live = detect(
			[
				'import { it } from "vitest";',
				'it("a case", () => {',
				'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
				"});",
			].join("\n"),
		);
		expect(
			staleBaselineRows(
				live,
				new Set(["tests/config/case.test.ts:PI_LENS_HOME"]),
			),
		).toEqual([]);
		const plantedRow = "tests/config/gone.test.ts:PI_LENS_HOME";
		const stale = staleBaselineRows(
			live,
			new Set(["tests/config/case.test.ts:PI_LENS_HOME", plantedRow]),
		);
		expect(stale).toEqual([plantedRow]);
		// The registration for this ratchet's ledger (#5072): the plant is a row
		// no live tree produces, and the verdict above names it.
		expectPlantedStaleRow({
			baseline:
				"tests/support/test-env-restore-baseline.ts#TEST_ENV_RESTORE_BASELINE",
			rowKey: plantedRow,
			direction: "extra-row",
			verdict: stale,
		});
	});
});

describe("#4589 test-env-restore ratchet", () => {
	// The shared walk reads ~1,590 files once; give it its own budget so test
	// order cannot move the cost into a 60 s case (the #4549 shape).
	beforeAll(() => sweepOnce(), 120_000);

	it(
		"reports every unrestored env write and reds on a new one",
		() => {
			const findings = sweepOnce();
			const problems = unadmittedOffenders(findings, BASELINE);
			process.stderr.write(
				`test-env-restore-sweep: ${findings.length} live write(s), ${BASELINE.size} baselined, ${problems.length} new\n`,
			);
			expect(problems, problems.join("\n")).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"baseline entries remain live",
		() => {
			// The shrink-only direction: a restore added anywhere makes its row
			// stale, and a stale row reds until it is deleted.
			expect(staleBaselineRows(sweepOnce(), BASELINE)).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it.skipIf(!process.env.TEST_ENV_RESTORE_REGEN)(
		"regenerates the baseline",
		() => {
			const rows = [...new Set(sweepOnce().map(envRestoreKey))].sort();
			fs.writeFileSync(
				BASELINE_PATH,
				[
					"/**",
					` * ${BASELINE_HEADER}`,
					" *",
					" * A row is `<file>:<key>`, keyed on file and environment key,",
					' * never on line. It means "this write is not PROVABLY restored',
					' * here", so a row in a file that does put its key back is honest:',
					" * it shrinks when the file is made readable. Why each file is",
					" * admitted, and which rows are real leaks, lives in",
					" * `test-env-restore-admissions.ts`; every row here must have an",
					" * entry there.",
					" */",
					"",
					"export const TEST_ENV_RESTORE_BASELINE: readonly string[] = [",
					...rows.map((row) => `\t${JSON.stringify(row)},`),
					"];",
					"",
				].join("\n"),
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

describe("#4589 test-env-restore admission guard", () => {
	it("keeps the baseline a list of file:key rows", () => {
		// A row that cannot name a file and a key would admit everything under
		// that file, or nothing at all; the ratchet's identity is `file:key`.
		const malformed = TEST_ENV_RESTORE_BASELINE.filter(
			(row) => !ROW_RE.test(row),
		);
		expect(malformed).toEqual([]);
		expect(new Set(TEST_ENV_RESTORE_BASELINE).size).toBe(
			TEST_ENV_RESTORE_BASELINE.length,
		);
		expect(
			fs.readFileSync(BASELINE_PATH, "utf8").includes(BASELINE_HEADER),
		).toBe(true);
	});

	it("keeps every baseline row inside the swept population", () => {
		// A row for a path the walk never visits can never go stale, so it
		// would sit in the list forever.
		const outside = TEST_ENV_RESTORE_BASELINE.filter((row) =>
			row.startsWith(`tests/${OUT_OF_POPULATION}`),
		);
		expect(outside).toEqual([]);
		expect(
			relativePosix(REPO_ROOT, path.join(REPO_ROOT, "tests/config/x.test.ts")),
		).toBe("tests/config/x.test.ts");
	});

	it("admits every row with a reason, and no reason without a row", () => {
		// Shape 38: a new leak cannot be admitted by appending one baseline
		// line. Both directions, so a deleted row takes its reason with it.
		const rows = new Set(
			TEST_ENV_RESTORE_BASELINE.map((row) => row.slice(0, row.indexOf(":"))),
		);
		const admitted = new Set(Object.keys(TEST_ENV_RESTORE_ADMISSIONS));
		expect([...rows].filter((file) => !admitted.has(file)).sort()).toEqual([]);
		expect([...admitted].filter((file) => !rows.has(file)).sort()).toEqual([]);
		for (const [file, admission] of Object.entries(TEST_ENV_RESTORE_ADMISSIONS))
			expect(
				admission.reason.length,
				`${file} needs a real reason`,
			).toBeGreaterThan(40);
	});

	it(
		"re-checks every admission's mechanism against the file it names",
		() => {
			// The reason's mechanism is a claim about the file's source, re-derived
			// here by the detector's own classifier (#4589 review round 1). A
			// `teardown` claim needs a teardown hook, and a `vi.hoisted` or
			// module-scope write cannot be `teardown`: no hook runs before the suite.
			const findingsByFile = new Map<string, EnvRestoreFinding[]>();
			for (const finding of sweepOnce()) {
				const list = findingsByFile.get(finding.file) ?? [];
				list.push(finding);
				findingsByFile.set(finding.file, list);
			}
			const problems: string[] = [];
			for (const [file, admission] of Object.entries(
				TEST_ENV_RESTORE_ADMISSIONS,
			)) {
				const source = readWalkedFile(path.join(REPO_ROOT, file));
				if (source === undefined) {
					problems.push(`${file}: admission names a file the walk skips`);
					continue;
				}
				const mechanisms: EnvRestoreMechanism[] = envRestoreMechanisms(
					source,
					findingsByFile.get(file) ?? [],
				);
				if (!mechanisms.includes(admission.mechanism))
					problems.push(
						`${file}: admitted as ${admission.mechanism}, but the file shows [${mechanisms.join(", ")}]`,
					);
			}
			expect(problems, problems.join("\n")).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("crosses the boundary: a hoisted write cannot be admitted as teardown", () => {
		// The guard's own seam, driven through the production classifier: the
		// file has a teardown hook AND a `vi.hoisted` pin, and the true class is
		// `module-pin`. Presence alone would accept `teardown`, which is the
		// wrong record this check exists to red.
		const source = [
			'import { afterEach, vi } from "vitest";',
			"vi.hoisted(() => {",
			'\tprocess.env.PI_LENS_PROBE_MODE = "0";',
			"});",
			"afterEach(() => { delete process.env.OTHER_KEY; });",
		].join("\n");
		const findings = findUnrestoredEnvWrites(
			"tests/config/probe.test.ts",
			source,
		);
		expect(findings.map((finding) => finding.key)).toEqual([
			"PI_LENS_PROBE_MODE",
		]);
		expect(envRestoreMechanisms(source, findings)).toEqual(["module-pin"]);
		// The plain module-scope write is the same class.
		const moduleScope = 'process.env.PROBE_PIN = "1";';
		expect(
			envRestoreMechanisms(
				moduleScope,
				findUnrestoredEnvWrites("tests/config/probe.test.ts", moduleScope),
			),
		).toEqual(["module-pin"]);
	});
});
