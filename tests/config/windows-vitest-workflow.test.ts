import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { siblingPin } from "../support/sibling-pin.js";
import { matchingCloseIndex, stripSource } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/ci.yml");

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	shell?: string;
	id?: string;
	if?: string;
	"continue-on-error"?: boolean;
};
type Job = {
	name?: string;
	"runs-on"?: string;
	"continue-on-error"?: boolean;
	"timeout-minutes"?: number;
	needs?: string | string[];
	if?: string;
	outputs?: Record<string, string>;
	permissions?: Record<string, string>;
	steps?: Step[];
};

function readWorkflow(): { jobs: Record<string, Job> } {
	return yaml.load(readFileSync(WORKFLOW_PATH, "utf8")) as {
		jobs: Record<string, Job>;
	};
}

const OPENERS: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

/** `text` with every bracket group emptied (`f(a, b)` reads `f()`), blank
 *  string contents dropped, and whitespace collapsed: the statement shape at
 *  this nesting level. */
function skeleton(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const close = OPENERS[text[i]];
		if (close === undefined) {
			out += text[i];
			continue;
		}
		const end = matchingCloseIndex(text, i, text[i], close);
		if (end < 0) throw new Error(`unbalanced ${text[i]} at ${i}`);
		out += text[i] + close;
		i = end;
	}
	return out
		.replace(/(["'`])\s*\1/g, "$1$1")
		.replace(/\s+/g, " ")
		.trim();
}

/** Top-level statements of a block body (split at depth-0 `;`), each with its
 *  whitespace collapsed. */
function statements(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch in OPENERS) depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === ";" && depth === 0) {
			out.push(body.slice(start, i + 1));
			start = i + 1;
		}
	}
	out.push(body.slice(start));
	return out
		.map((entry) => entry.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.flatMap(expandTry);
}

/** A `try {...} finally {...}` statement as its own lines, so a drift inside
 *  it names the statement that moved. Any other shape stays one statement. */
function expandTry(statement: string): string[] {
	if (!statement.startsWith("try {")) return [statement];
	const tryEnd = matchingCloseIndex(statement, 4, "{", "}");
	const tail = statement.slice(tryEnd + 1).trimStart();
	if (!tail.startsWith("finally {")) return [statement];
	const open = statement.length - tail.length + "finally ".length;
	const end = matchingCloseIndex(statement, open, "{", "}");
	if (end !== statement.length - 1) return [statement];
	return [
		"try {",
		...statements(statement.slice(5, tryEnd)),
		"} finally {",
		...statements(statement.slice(open + 1, end)),
		"}",
	];
}

/**
 * The census hook's statements as `censusStructure` reads them (comments and
 * string contents blanked, whitespace collapsed). The admitted form of the
 * hook: any added, removed or edited statement reds, so a guard spelled any
 * way (a ternary on an env var or `path.sep`, an early `return`, a value
 * swapped for `[]`) is a reviewed change to this list (#5081 review F1).
 * Editing a comment or a message's wording does not move it. After a
 * deliberate hook change, copy the pin's received list here.
 */
const CENSUS_HOOK_STATEMENTS: readonly string[] = [
	"const scan = await tmpHygieneWaitForOwnerDrain();",
	"const liveOwners = scan.live;",
	"const { testFile, leftovers } = tmpHygieneLeakReport();",
	"const creators = censusTmpRootCreators();",
	"const otherInvocation = new Set( tmpHygieneForeignRunEntries( leftovers, ownersForTmpEntry, tmpHygieneRunFiles(), creators, ), );",
	"const attributable = tmpHygieneExcludeLiveOwnerEntries( leftovers.filter((entry) => !otherInvocation.has(entry)), ownerForTmpEntry, liveOwners, );",
	"const described = attributable.map((entry) => formatTmpHygieneLeakEntry( entry, ownerForTmpEntry(entry), creators.get(entry), ), );",
	"const rootCensus = unadmittedRepoRootEntries(repoRootBaseline());",
	"if (rootCensus.unknown) process.stderr.write( ` ${rootCensus.unknown} `, );",
	"const repoRootCreated = [...tmpHygieneRepoRootCreates()].filter( ([, creator]) => creator !== OWN_FILE, );",
	"const repoRootCreateNames = repoRootCreated.map(([name]) => name);",
	"const repoRootCreateLeaks = untrackedUnignoredEntries( repoRootCreateNames, process.cwd(), new Set(repoRootCreateNames), );",
	"const tmpRootWrites = tmpHygieneTmpRootWrites();",
	"const tmpRootWriteLeaks = judgedTmpRootWrites( tmpRootWrites ?? [], creators, );",
	"try {",
	'expect( attributable, ` ${testFile} ${attributable.length} ${described.join(" ")} ${[...liveOwners].join(" ") || " "} ${diagnoseTmpHygieneLeaks(attributable, creators)}`, ).toEqual([]);',
	'expect( tmpRootWriteLeaks, ` ${testFile} ${tmpRootWriteLeaks.length} ${tmpRootWriteLeaks .map( (entry) => `${entry} ${creators.get(entry) ?? " "} `, ) .join( " ", )} `, ).toEqual([]);',
	'expect( rootCensus.leaked, ` ${rootCensus.leaked.length} ${rootCensus.leaked .map( (entry) => `${entry} ${repoRootEntryCandidates(entry).join(" ") || " "} `, ) .join( " ", )} `, ).toEqual([]);',
	'expect( repoRootCreateLeaks, ` ${repoRootCreateLeaks === undefined ? " " : `${repoRootCreateLeaks.length} `} ${repoRootCreated .map(([name, creator]) => `${name} ${creator} `) .join( " ", )} `, ).toEqual([]);',
	"} finally {",
	"const reaped = cleanupTmpHygiene(otherInvocation);",
	"writeCensusSummary( scan, otherInvocation.size, reaped, tmpRootWrites, tmpRootWriteLeaks.length, );",
	"}",
];
/** The only statements the census describe body may hold. */
const BODY_STATEMENTS = ["afterAll();", "it();", "describe();"];
const CENSUS_HEAD = 'describe("tmp-fixture-hygiene", () => {';
const VITEST_BINDINGS = ["describe", "afterAll", "it", "expect"] as const;

/**
 * The census file's structure as the pin judges it (#4591, #5081 review F1),
 * read with comments and strings blanked so prose never satisfies it. Admitted,
 * and nothing else: the census `describe` is a top-level statement (the code
 * before it ends in `;`) with exactly the head above; its body holds only
 * `afterAll()`, `it()` and `describe()` statements, with at least one direct
 * `it()` whose arguments are a name and a callback (no options object, no
 * `.skipIf`); the hook is `afterAll(async () => {...})` whose statements equal
 * `CENSUS_HOOK_STATEMENTS`; and `describe`, `afterAll`, `it` and `expect` are
 * bound only by the vitest import (every other occurrence is a call). Each
 * field reports what it read when it is not the admitted form, so the failure
 * names the drift.
 */
function censusStructure(raw: string) {
	const code = stripSource(raw);
	const at = raw.indexOf(CENSUS_HEAD);
	const before = code.slice(0, Math.max(at, 0)).trimEnd();
	const open = at + CENSUS_HEAD.length - 1;
	const close = at < 0 ? -1 : matchingCloseIndex(code, open, "{", "}");
	const bodyText = close < 0 ? "" : code.slice(open + 1, close);
	const shapes = statements(skeleton(bodyText));
	// Every direct `it` call, judged on its own argument shape.
	const directIts: string[] = [];
	let hookArgs = "missing";
	let hookBody = "";
	for (let i = 0, depth = 0; i < bodyText.length; i++) {
		const ch = bodyText[i];
		if (ch in OPENERS) depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth--;
		if (depth !== 0 || !/[ai]/.test(ch) || /[\w$.]/.test(bodyText[i - 1] ?? ""))
			continue;
		const call = /^(afterAll|it)\(/.exec(bodyText.slice(i));
		if (!call) continue;
		const paren = i + call[1].length;
		const end = matchingCloseIndex(bodyText, paren, "(", ")");
		const args = skeleton(bodyText.slice(paren + 1, end));
		if (call[1] === "it") directIts.push(args);
		else if (hookArgs === "missing") {
			hookArgs = args;
			const brace = bodyText.indexOf("{", paren);
			hookBody = bodyText.slice(
				brace + 1,
				matchingCloseIndex(bodyText, brace, "{", "}"),
			);
		}
	}
	// One direct case with no third argument (no options object, so no `skip`)
	// is what makes Vitest run the suite, and with it the hook.
	const plainIt = (args: string) => /^"", (?:async )?\(\) => \{\}$/.test(args);
	const bodyAdmitted =
		shapes.every((entry) => BODY_STATEMENTS.includes(entry)) &&
		directIts.some(plainIt);
	const vitestImport = /import\s*\{[^}]*\}\s*from\s*"\s*"\s*;/g;
	const imports = [...code.matchAll(vitestImport)].filter((entry) =>
		raw.slice(entry.index, entry.index + entry[0].length).includes('"vitest"'),
	);
	const bindings: string[] = [];
	for (const name of VITEST_BINDINGS) {
		for (const hit of code.matchAll(
			new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g"),
		)) {
			const index = hit.index;
			if (
				imports.some(
					(entry) =>
						index > entry.index && index < entry.index + entry[0].length,
				)
			)
				continue;
			const after = code.slice(index + name.length).trimStart()[0];
			const prior = code.slice(0, index).trimEnd();
			if (
				(after === "(" || after === ".") &&
				!/\b(?:function|class)$/.test(prior)
			)
				continue;
			bindings.push(
				`${name} at line ${code.slice(0, index).split("\n").length}`,
			);
		}
	}
	return {
		topLevel: before.endsWith(";"),
		body: bodyAdmitted
			? "afterAll(), it() and describe() only"
			: `${shapes.join(" ")}${directIts.some(plainIt) ? "" : " (no direct it() with only a name and a callback)"}`,
		hookArgs,
		hook: statements(hookBody),
		bindings,
	};
}

const ADMITTED_CENSUS = {
	topLevel: true,
	body: "afterAll(), it() and describe() only",
	hookArgs: "async () => {}",
	hook: CENSUS_HOOK_STATEMENTS,
	bindings: [],
};

describe("Windows Vitest workflow contract (#2536)", () => {
	it("keeps the Windows subset lane present, bounded, and gating (#4518)", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		// #4518: promoted from `(advisory)` on 2026-10-17. The name carries no
		// suffix, so ci-verdict gates it, and no `needs:`/`if:` scales it back
		// behind the heavy gate -- a required row that a docs-only diff skips
		// would be absent forever.
		expect(job?.name).toBe("Unit tests Windows");
		expect(job?.["runs-on"]).toBe("windows-latest");
		expect(job?.["continue-on-error"]).toBeUndefined();
		expect(job?.["timeout-minutes"]).toBe(25);
		expect(job?.outputs?.windows_vitest).toBe(
			"${{ steps.windows-vitest.outcome }}",
		);
		expect(job?.permissions).toEqual({ contents: "read" });
		expect(job?.needs).toBeUndefined();
		expect(job?.if).toBeUndefined();
	});

	it("keeps dynamic Windows enumeration and the runner command wired", () => {
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		const enumeration = steps.find(
			(step) => step.name === "Enumerate Windows Vitest subset",
		);
		const runner = steps.find(
			(step) => step.name === "Run Windows Vitest subset",
		);
		const outcome = steps.find(
			(step) => step.name === "Record Windows Vitest outcome",
		);

		// Recurrence: #2536's Windows-only tests were present but had no CI
		// consumer; deleting either population source would silently recreate it.
		expect(enumeration?.shell).toBe("bash");
		expect(enumeration?.run).toContain(
			"node scripts/lib/win32-gate-population.mjs --files",
		);
		expect(enumeration?.run).not.toMatch(/git grep/);
		expect(enumeration?.run).toContain("${#FILES[@]} -eq 0");
		expect(raw).toContain("win32-gate-population.mjs --summary");
		expect(runner?.run).toContain("--configLoader runner");
		expect(runner?.id).toBe("windows-vitest");
		// #4518: the run step reports its own red. `continue-on-error` here would
		// let a future edit of the failure step turn a red subset green, the
		// #4019 shape that hid 56 failed Windows tests.
		expect(runner?.["continue-on-error"]).toBeUndefined();
		expect(outcome?.if).toBe("always()");
		expect(raw).toContain("Windows Vitest subset step outcome:");
		expect(raw).toContain("windows_vitest=$outcome");
		expect(raw).toContain("PI_LENS_TEST_TIMEOUT_SCALE: '3'");
	});

	// #3926: a failed checkout leaves no repository and the enumeration step is
	// skipped, so the summary must not invoke the checked-out population script;
	// it reports "Not executed" and still writes the outcome keys the job output
	// reads. The node invocation stays inside the list-present branch.
	it("guards the Windows summary on the executed-file list", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		const outcome = (job?.steps ?? []).find(
			(step) => step.name === "Record Windows Vitest outcome",
		);
		const run = String(outcome?.run ?? "");
		expect(outcome?.if).toBe("always()");
		const guard = run.indexOf('[ -f "$RUNNER_TEMP/windows-vitest-files.txt" ]');
		const population = run.indexOf("win32-gate-population.mjs --summary");
		const unavailable = run.indexOf("Not executed");
		const key = run.indexOf("windows_vitest=$outcome");
		expect(guard).toBeGreaterThan(-1);
		expect(population).toBeGreaterThan(guard);
		expect(unavailable).toBeGreaterThan(population);
		expect(key).toBeGreaterThan(-1);
	});

	it("publishes a visible red after recording the failed Vitest count", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		const record = steps.find(
			(step) => step.name === "Record Windows Vitest outcome",
		);
		const failure = steps.find(
			(step) =>
				step.name === "Fail a failed or under-executed Windows Vitest subset",
		);

		// Recurrence: #4019's continue-on-error made 56 failed Windows tests read
		// as a green job, hiding the red from both reviewers and ci-verdict.
		expect(record?.run).toContain(
			'windows-vitest-failure-count.mjs "$RUNNER_TEMP/windows-vitest.log"',
		);
		expect(record?.run).toContain("Windows Vitest failures:");
		expect(failure?.if).toBe("always()");
		expect(failure?.run).toContain("steps.windows-vitest.outcome");
		expect(failure?.run).toContain("exit 1");
		expect(failure?.run).toContain("title=Windows Vitest subset::");
		// #4518: the red is the run step's own failure now; no step of this job
		// needs `continue-on-error`, so a broken failure step cannot hide it.
		expect(
			steps.filter((entry) => entry["continue-on-error"] !== undefined),
		).toEqual([]);
	});

	// Recurrence: #4042 review F1 — a Vitest crash creates an empty log, so an
	// absent summary must stay visibly unavailable rather than becoming zero.
	it("reports an unknown count when Vitest emits no summary", () => {
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		const job = readWorkflow().jobs["unit-tests-windows"];
		const record = (job?.steps ?? []).find(
			(step) => step.name === "Record Windows Vitest outcome",
		);
		const failure = (job?.steps ?? []).find(
			(step) =>
				step.name === "Fail a failed or under-executed Windows Vitest subset",
		);
		expect(record?.run).toContain(
			"Windows Vitest failures: ${failures:-unknown}",
		);
		expect(failure?.run).toContain("${failures:-unknown} Vitest tests failed");
		expect(raw).not.toContain("Windows Vitest failures: ${failures:-0}");
	});

	// #4591: the tmp-fixture census asserts on the Windows lane. It was declined
	// there (a `win32` guard around its assertions) while the producer of a
	// root that reappeared after its file's sweep was unnamed; the quarantine is
	// gone so a Windows soak measures the census, and its failure message now
	// carries the diagnosis that names the producer. Recurrence this prevents: a
	// platform guard returning around the census (the lane then runs the file
	// and measures nothing, shapes 10 and 31). Round 1 enumerated guard words
	// and #5081's review passed three plants through it (an env ternary, a
	// `path.sep` ternary, an early `return` in the describe), so the pin now
	// ADMITS the one known-good structure and refuses every other form; see
	// `censusStructure` for what is admitted. Out of a source pin's reach: a
	// Windows branch inside a function the hook already calls (a support helper
	// returning `[]`); those helpers are judged by their own tests.
	it("keeps the tmp-fixture census asserting on win32, with no platform guard (#4591)", () => {
		const raw = readFileSync(
			resolve(ROOT, "tests/config/tmp-fixture-hygiene.test.ts"),
			"utf8",
		);
		expect(censusStructure(raw)).toEqual(ADMITTED_CENSUS);
		// The census line states the verdict the run reached, and it is asserted.
		expect(stripSource(raw, { strings: "keep" })).toContain(
			'const censusVerdict: TmpHygieneCensusVerdict = "asserted";',
		);
	});

	// #5081 review F1: the plants that passed round 1's needle pin, plus the
	// other spellings the state table names (an alias, an indirect call, a
	// value reached through another binding). Each must leave the admitted
	// structure; a comment-only edit must not. Applied in memory to the real
	// file, so the plants track the file's current text.
	it("refuses every guard spelling #5081 review planted in the census", () => {
		const raw = readFileSync(
			resolve(ROOT, "tests/config/tmp-fixture-hygiene.test.ts"),
			"utf8",
		);
		const onWindows = 'process.env.RUNNER_OS === "Windows"';
		const plant = (from: string, to: string, text = raw): string => {
			expect(text).toContain(from);
			return text.replace(from, to);
		};
		const plants: Record<string, string> = {
			"env ternary on a subject": plant(
				"const attributable = tmpHygieneExcludeLiveOwnerEntries(",
				`const attributable = ${onWindows} ? [] : tmpHygieneExcludeLiveOwnerEntries(`,
			),
			"path.sep ternary on the repo-root census": plant(
				"const rootCensus = unadmittedRepoRootEntries(repoRootBaseline());",
				'const rootCensus = path.sep === "\\\\" ? { leaked: [], unknown: undefined } : unadmittedRepoRootEntries(repoRootBaseline());',
			),
			"early return first in the describe": plant(
				CENSUS_HEAD,
				`${CENSUS_HEAD}\n\tif (${onWindows}) return;`,
			),
			"early return on an in-file helper": plant(
				"const censusVerdict",
				'function isHostWin() { return os.EOL === "\\r\\n"; }\nconst censusVerdict',
				plant(CENSUS_HEAD, `${CENSUS_HEAD}\n\tif (isHostWin()) return;`),
			),
			"early return on an imported flag": plant(
				CENSUS_HEAD,
				`${CENSUS_HEAD}\n\tif (hostIsWindows) return;`,
			),
			"return after the hook (no case runs, so neither does the hook)": plant(
				'\n\t});\n\n\tit("reports an unknown baseline',
				`\n\t});\n\tif (${onWindows}) return;\n\n\tit("reports an unknown baseline`,
			),
			"skipIf on the describe": plant(
				CENSUS_HEAD,
				`describe.skipIf(${onWindows})("tmp-fixture-hygiene", () => {`,
			),
			"describe wrapped in an if": plant(
				CENSUS_HEAD,
				`if (!(${onWindows}))\n${CENSUS_HEAD}`,
			),
			"alias: the hook through another binding": plant(
				"const censusVerdict",
				`const hook = ${onWindows} ? () => undefined : afterAll;\nconst censusVerdict`,
				plant(
					"\tafterAll(async () => {\n\t\tconst scan",
					"\thook(async () => {\n\t\tconst scan",
				),
			),
			"every direct case skipped through an options object": raw.replace(
				/(\n\tit\(\s*)("(?:[^"\\]|\\.)*"),/g,
				`$1$2, { skip: ${onWindows} },`,
			),
			"hook callback chosen by a ternary": plant(
				"\tafterAll(async () => {\n\t\tconst scan",
				`\tafterAll(${onWindows} ? () => undefined : async () => {\n\t\tconst scan`,
			),
			"afterAll imported from another module": plant(
				'import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";',
				'import { beforeAll, describe, expect, it, vi } from "vitest";\nimport { afterAll } from "../support/win-skip.js";',
			),
			"value reached through another binding": plant(
				"\t\t\texpect(\n\t\t\t\tattributable,",
				"\t\t\texpect(\n\t\t\t\tdescribed.filter(() => false),",
			),
		};
		for (const [name, text] of Object.entries(plants)) {
			expect(text, name).not.toBe(raw);
			expect(censusStructure(text), name).not.toEqual(ADMITTED_CENSUS);
		}
		// A commented-out guard is prose, not code: it never moves the verdict.
		expect(
			censusStructure(
				plant(CENSUS_HEAD, `${CENSUS_HEAD}\n\t// if (${onWindows}) return;`),
			),
		).toEqual(ADMITTED_CENSUS);
	});

	it("pins the sibling action revisions and the isolated home", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		expect(steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
			siblingPin(readWorkflow().jobs, "actions/checkout", "unit-tests-windows"),
			siblingPin(
				readWorkflow().jobs,
				"actions/setup-node",
				"unit-tests-windows",
			),
		]);
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		expect(raw).toContain(
			'PI_LENS_HOME=$RUNNER_TEMP/pi-lens-home" >> "$GITHUB_ENV"',
		);
		expect(raw).toContain("npm ci --no-audit --no-fund");
		expect(raw).toContain("npm run build");
	});
});
