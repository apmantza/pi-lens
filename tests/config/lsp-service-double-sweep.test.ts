/**
 * #2582 — hand-rolled `LSPService` doubles: a semantic sweep, a two-sided
 * ratchet, and a two-part admission gate.
 *
 * The recurrence this guards: a test stubs `getLSPService` with a partial,
 * hand-rolled object, production later calls a method that object does not
 * have, and the failure lands in a swallow-all catch. It has cost three rounds
 * already — #1766 F3 (`isSpawnInFlight`), #2540/#2582 F3
 * (`getAuxiliaryClientsForFile`), and the CI red on this branch's first head
 * (`tests/clients/lsp-lazy-liveness.test.ts:88`). `makeLspServiceDouble` gives
 * every such test the full surface with focused overrides; this sweep keeps
 * the hand-rolled population from growing back.
 *
 * ## The baseline is EMPTY (#2592)
 *
 * #2585 shipped this as a ratchet over 18 surviving hand-rolled doubles in 17
 * files. #2592 migrated all 17 onto the factory, so
 * `tests/support/lsp-double-baseline.json` is now `{}` and the ratchet is a
 * plain gate: with nothing pinned, EVERY live hit is a `new-file` red. The
 * ratchet machinery is kept rather than deleted because it is what makes the
 * gate re-openable — a future double that genuinely cannot use the factory
 * pays the two-part admission below instead of being waved through, and the
 * `vanished-pin` / `dead-admission` rules keep a half-burnt pin from
 * lingering.
 *
 * ## The admission gate, and why it exists
 *
 * Round 2 shipped this ratchet with the defect the ratchet exists to stop, one
 * level up: a brand-new test file carrying a hand-rolled double, plus ONE line
 * added to the baseline JSON, passed the whole suite — no reason, no second
 * gate. That is #2582 round 1's identifier laundering in a new spelling, and
 * it is AGENTS.md defect shape 38: a guard a one-line data edit satisfies
 * away.
 *
 * So a pin costs three edits in three places, and EVERY pin pays: an entry in
 * `tests/support/lsp-double-baseline.json` (the count), an entry in
 * {@link ADMITTED} with a reason naming the issue that tracks it, and a
 * `// lsp-double: <reason>` header in the file itself. One of the three is
 * source-reviewed prose in the admitted file, so a data edit alone admits
 * nothing. Same shape as `tests/clients/flake-shape-ratchet.test.ts`'s
 * admission gate (header + `wallClockBudgetInclude` membership), reused rather
 * than re-derived.
 *
 * Round 3 tried to spare the seventeen inherited files by exempting an
 * `ORIGINAL_POPULATION` Set, and the verifier walked straight through it: a
 * fresh double, one baseline line, one line in the Set, 29/29 green. An exempt
 * tier IS a door. There is one path in and one path out; the seventeen carried
 * their headers like everything else until #2592 removed all three parts per
 * file.
 *
 * ## The rules
 *
 * Live-vs-pin, two-sided: `new-file`, `count-risen`, `stale-ceiling`,
 * `vanished-pin`. Provenance: `unadmitted-pin`, `missing-header`,
 * `reason-not-real`, `dead-admission`. The PR body for #2585 carries the
 * (state × writer) cell list; every cell below has a test.
 *
 * ## Why the detector is structural
 *
 * Round 1 of this sweep was the literal string `touchFile: vi.fn(`, and it
 * shipped with 28 `const makeTouchFileMock = vi.fn;` call sites in
 * `cascade-compute.test.ts` whose only purpose was to rename the literal out
 * of its own reach. `tests/support/lsp-double-gate.ts` replaces it with an AST
 * walk from the `getLSPService` seam; the five shapes that defeated the regex
 * are pinned below as REAL FIXTURE FILES under
 * `tests/fixtures/lsp-double-gate/`, read and parsed through the same path as
 * the population walk — a string concatenated inside this file would only
 * prove the sweep agrees with itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	admissionHeader,
	findHandRolledLspDoubles,
	lspServiceMethodNames,
	repoRoot,
} from "../support/lsp-double-gate.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";

const TESTS_ROOT = path.join(repoRoot, "tests");
const FIXTURES = path.join(TESTS_ROOT, "fixtures/lsp-double-gate");

/** The factory and its analyser are the sweep's own machinery, not its subjects. */
const NOT_SUBJECTS = new Set([
	"tests/support/lsp-service-double.ts",
	"tests/support/lsp-double-gate.ts",
]);

type Baseline = Record<string, number>;

const BASELINE: Baseline = JSON.parse(
	fs.readFileSync(
		path.join(repoRoot, "tests/support/lsp-double-baseline.json"),
		"utf8",
	),
);

/**
 * EVERY pin, with the reason it is still hand-rolled. There is no exempt
 * "original debt" tier: round 3 had one (`ORIGINAL_POPULATION`) and the
 * verifier walked straight through it — a fresh double, one baseline JSON
 * line, one line added to that Set, and the suite was 29/29 green with no
 * reason and no header. That is #2585 round 2's escape relocated one `Set`
 * away, and it is the Screen clause of AGENTS.md shape 38 failing on the very
 * guard that introduced the shape.
 *
 * So there is ONE path in and one path out, for anything added tomorrow
 * exactly as for the seventeen files inherited from #2582: a pin in
 * `tests/support/lsp-double-baseline.json`, an entry here naming the issue
 * that tracks it, and a `// lsp-double: <reason>` header in the file itself.
 * Burn-down removes all three; the dead-admission rule reds on any leftover.
 * #2592 burnt all seventeen down, which is why this map is now empty — and
 * empty is the state the cell-by-cell tests below exist to keep meaningful.
 *
 * The old tier was also inverted in its own terms: keeping a burned-down file
 * in `ORIGINAL_POPULATION` PERMITTED a silent re-pin rather than preventing
 * one — `lsp/late-auxiliary-findings` was migrated in round 3 and stayed in
 * the Set, so only a separate hardcoded array noticed when it came back.
 * That array is gone too: a migrated file that regrows a double is now a
 * `new-file` red like any other.
 */
const ADMITTED: Readonly<Record<string, string>> = {};

/** Shortest text this gate will accept as a reason, in either half. */
const MIN_REASON = 15;

// ── The scan ─────────────────────────────────────────────────────────────

/** `file → hand-rolled double count` for every test source outside the fixtures. */
async function liveCounts(): Promise<Record<string, number>> {
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (rel) => rel.startsWith("fixtures/"),
	});
	assertNonEmptyScan("#2582 LSP service-double test walk", files.length, 200);
	const counts: Record<string, number> = {};
	for (const file of files) {
		const rel = relativePosix(repoRoot, file);
		if (NOT_SUBJECTS.has(rel)) continue;
		const hits = await findHandRolledLspDoubles(fs.readFileSync(file, "utf8"));
		if (hits.length > 0) counts[rel] = hits.length;
	}
	return counts;
}

// ── The two-sided live-vs-pin ratchet ────────────────────────────────────

interface RatchetProblem {
	file: string;
	kind: "new-file" | "count-risen" | "stale-ceiling" | "vanished";
	before?: number;
	after?: number;
}

export function auditAgainstBaseline(
	live: Readonly<Record<string, number>>,
	baseline: Readonly<Baseline> = BASELINE,
): RatchetProblem[] {
	const problems: RatchetProblem[] = [];
	for (const [file, after] of Object.entries(live)) {
		const before = baseline[file];
		if (before === undefined) problems.push({ file, kind: "new-file", after });
		else if (after > before)
			problems.push({ file, kind: "count-risen", before, after });
		else if (after < before)
			problems.push({ file, kind: "stale-ceiling", before, after });
	}
	for (const file of Object.keys(baseline)) {
		if (!(file in live))
			problems.push({ file, kind: "vanished", before: baseline[file] });
	}
	return problems.sort((a, b) => a.file.localeCompare(b.file));
}

const SEED_ADVICE =
	"seed from makeLspServiceDouble(), using omit for methods that must be absent";

function describeProblem(p: RatchetProblem): string {
	switch (p.kind) {
		case "new-file":
			return (
				`${p.file}: ${p.after} hand-rolled LSPService double(s) in a file the ` +
				`baseline has never seen — ${SEED_ADVICE}; a partial double is how ` +
				"#1766 F3 and #2582 F3 both shipped"
			);
		case "count-risen":
			return `${p.file}: rose from ${p.before} to ${p.after} hand-rolled double(s) — ${SEED_ADVICE}`;
		case "stale-ceiling":
			return `${p.file}: fell from ${p.before} to ${p.after} — tighten the pin in tests/support/lsp-double-baseline.json to ${p.after}`;
		default:
			return `${p.file}: pinned at ${p.before} but the scan no longer flags it — delete the entry from tests/support/lsp-double-baseline.json`;
	}
}

// ── The two-part admission gate ──────────────────────────────────────────

/**
 * Provenance for every baseline key, and liveness for every admission.
 *
 * Pulled out as a pure function taking all four inputs so it is unit-testable
 * against fixtures directly — `ADMITTED` is empty in steady
 * state, so a test that only iterates the real map (as the sweep does) can
 * never prove this logic is mutation-sensitive. That is the lesson
 * `flake-shape-ratchet.test.ts` records for the same gate shape.
 */
export function auditAdmissions(
	baseline: Readonly<Baseline>,
	admitted: Readonly<Record<string, string>>,
	readSource: (file: string) => string | undefined,
): string[] {
	const problems: string[] = [];

	for (const file of Object.keys(baseline)) {
		const reason = admitted[file];
		if (reason === undefined) {
			problems.push(
				`${file}: pinned in tests/support/lsp-double-baseline.json but never ` +
					"admitted. A pin is not a data edit: add an ADMITTED " +
					"entry naming the issue that tracks it, AND a `// lsp-double: " +
					"<reason>` header in the file itself. Both parts are required " +
					`(AGENTS.md shape 38). Or ${SEED_ADVICE}.`,
			);
			continue;
		}
		if (reason.trim().length < MIN_REASON) {
			problems.push(
				`${file}: ADMITTED reason is under ${MIN_REASON} characters — say why this double cannot use the factory`,
			);
		} else if (!/#\d+/.test(reason)) {
			problems.push(
				`${file}: ADMITTED reason names no issue — an admission must point at tracked work (#NNN)`,
			);
		}
		const source = readSource(file);
		if (source === undefined) {
			problems.push(`${file}: admitted but the file does not exist`);
			continue;
		}
		const header = admissionHeader(source);
		if (!header) {
			problems.push(
				`${file}: admitted in ADMITTED but carries no ` +
					"`// lsp-double: <reason>` header. Both parts are required " +
					"(AGENTS.md shape 38).",
			);
		} else if (header.length < MIN_REASON) {
			problems.push(
				`${file}: its \`// lsp-double:\` header reason is under ${MIN_REASON} characters — a marker is not a reason`,
			);
		}
	}

	for (const file of Object.keys(admitted)) {
		if (!(file in baseline)) {
			problems.push(
				`${file}: ADMITTED names a file with no pin — delete the dead admission`,
			);
		}
	}

	return problems.sort();
}

function readRepoSource(file: string): string | undefined {
	const absolute = path.join(repoRoot, file);
	return fs.existsSync(absolute)
		? fs.readFileSync(absolute, "utf8")
		: undefined;
}

// ── The sweep ────────────────────────────────────────────────────────────

describe("#2582 hand-rolled LSPService double ratchet", () => {
	let live: Record<string, number>;
	beforeAll(async () => {
		live = await liveCounts();
	}, 120_000);

	it("no new file, no risen count, no stale pin", () => {
		expect(auditAgainstBaseline(live).map(describeProblem)).toEqual([]);
	});

	it("every pin carries a reason and the file carries its header", () => {
		expect(auditAdmissions(BASELINE, ADMITTED, readRepoSource)).toEqual([]);
	});
});

// ── The admission machine, cell by cell ──────────────────────────────────

/**
 * One (state × writer) cell of the PR-body table each. `ADMITTED`
 * is empty in steady state, so these drive `auditAdmissions` against synthetic
 * inputs — the only way this logic is mutation-sensitive at all.
 */
describe("#2582 admission gate — the state space", () => {
	const NEW = "tests/clients/fresh-double.test.ts";
	const header = (reason: string) => `// lsp-double: ${reason}\nconst x = 1;\n`;
	const GOOD_REASON = "different seam, tracked in #2592";
	const noSource = () => undefined;
	const withHeader = (reason: string) => () => header(reason);

	it("C2: a bare pin — one baseline JSON line and nothing else — reds", () => {
		const problems = auditAdmissions({ [NEW]: 1 }, {}, withHeader(GOOD_REASON));
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("never admitted");
		expect(problems[0]).toContain("ADMITTED");
		expect(problems[0]).toContain("lsp-double:");
	});

	it("C3: the ADMITTED map alone, without the file's header, reds", () => {
		const problems = auditAdmissions(
			{ [NEW]: 1 },
			{ [NEW]: GOOD_REASON },
			() => "const x = 1;\n",
		);
		expect(problems).toEqual([
			expect.stringContaining("carries no `// lsp-double: <reason>` header"),
		]);
	});

	it("C4: the header alone, without an ADMITTED entry, reds", () => {
		const problems = auditAdmissions({ [NEW]: 1 }, {}, withHeader(GOOD_REASON));
		expect(problems).toEqual([expect.stringContaining("never admitted")]);
	});

	it("C5: both parts present, with a real reason, passes", () => {
		expect(
			auditAdmissions(
				{ [NEW]: 1 },
				{ [NEW]: GOOD_REASON },
				withHeader(GOOD_REASON),
			),
		).toEqual([]);
	});

	it("C6: an empty ADMITTED reason reds", () => {
		expect(
			auditAdmissions({ [NEW]: 1 }, { [NEW]: "   " }, withHeader(GOOD_REASON)),
		).toEqual([expect.stringContaining(`under ${MIN_REASON} characters`)]);
	});

	it("C7: an ADMITTED reason naming no issue reds", () => {
		expect(
			auditAdmissions(
				{ [NEW]: 1 },
				{ [NEW]: "this one is special, honestly" },
				withHeader(GOOD_REASON),
			),
		).toEqual([expect.stringContaining("names no issue")]);
	});

	it("C8: a header reason too short to be real reds", () => {
		expect(
			auditAdmissions({ [NEW]: 1 }, { [NEW]: GOOD_REASON }, withHeader("todo")),
		).toEqual([expect.stringContaining("a marker is not a reason")]);
	});

	it("C16/C17: an ADMITTED entry with no pin reds as a dead admission", () => {
		expect(auditAdmissions({}, { [NEW]: GOOD_REASON }, noSource)).toEqual([
			expect.stringContaining("no pin — delete the dead admission"),
		]);
	});

	it("C23: a `// lsp-double:` line inside a string is not a header", () => {
		// #2585 round 4, F3. The header used to be matched on raw file text, so
		// a marker inside a template literal or a plain string admitted a file
		// without ever being a comment — sweep-kit's comment/string-laundering
		// attack, one level down from the gate it defends. Real fixture files,
		// read from disk, not strings built here.
		const readFixture = (name: string) => () =>
			fs.readFileSync(path.join(FIXTURES, name), "utf8");
		expect(
			auditAdmissions(
				{ [NEW]: 1 },
				{ [NEW]: GOOD_REASON },
				readFixture("header-inside-a-string.ts"),
			),
		).toEqual([
			expect.stringContaining("carries no `// lsp-double: <reason>` header"),
		]);
		// The same file's sibling, with the marker as a genuine comment, passes.
		expect(
			auditAdmissions(
				{ [NEW]: 1 },
				{ [NEW]: GOOD_REASON },
				readFixture("header-real-comment.ts"),
			),
		).toEqual([]);
	});

	it("C15: removing pin, admission and doubles together passes", () => {
		expect(auditAdmissions({}, {}, noSource)).toEqual([]);
	});

	it("admits a file that has vanished from disk only as a problem", () => {
		expect(
			auditAdmissions({ [NEW]: 1 }, { [NEW]: GOOD_REASON }, noSource),
		).toEqual([expect.stringContaining("the file does not exist")]);
	});
});

describe("#2582 live-vs-pin ratchet — the four directions", () => {
	const F = "tests/tools/lsp-navigation.test.ts";

	it("C1/C21: a file the baseline has never seen reds; so does a pin with no live hit", () => {
		expect(auditAgainstBaseline({ [F]: 1 }, {}).map(describeProblem)).toEqual([
			expect.stringContaining("the baseline has never seen"),
		]);
		expect(auditAgainstBaseline({}, { [F]: 1 }).map(describeProblem)).toEqual([
			expect.stringContaining("the scan no longer flags it"),
		]);
	});

	it("C10/C11: a risen count and a fallen count both red", () => {
		expect(auditAgainstBaseline({ [F]: 3 }, { [F]: 1 })[0].kind).toBe(
			"count-risen",
		);
		expect(auditAgainstBaseline({ [F]: 1 }, { [F]: 3 })[0].kind).toBe(
			"stale-ceiling",
		);
	});

	it("C13/C14: burn-down passes only when the pin goes with the doubles", () => {
		expect(auditAgainstBaseline({}, {})).toEqual([]);
		expect(auditAgainstBaseline({ [F]: 1 }, {})[0].kind).toBe("new-file");
	});
});

describe("#2582 factory contract", () => {
	it("omit leaves the named method ABSENT, not stubbed", () => {
		// The production fallbacks this factory has to be able to exercise are
		// `typeof service.method === "function"` checks (clients/pipeline.ts
		// ~1145, #1766 F3). A default that merely returns false is a DIFFERENT
		// state: it never reaches the fallback. Without this, `omit` is
		// indistinguishable from its absence in every suite that uses it —
		// a mutation probe that neutered `omit` left the whole
		// pipeline-lsp-sync suite green.
		const omitted = makeLspServiceDouble({}, { omit: ["isSpawnInFlight"] });
		expect("isSpawnInFlight" in omitted).toBe(false);
		expect("touchFile" in omitted).toBe(true);
	});

	it("overrides replace a default without dropping the rest of the surface", () => {
		const touchFile = vi.fn();
		const service = makeLspServiceDouble({ touchFile });
		expect(service.touchFile).toBe(touchFile);
		expect(typeof service.getAuxiliaryClientsForFile).toBe("function");
	});
});

describe("#2582 detector — the shapes the round-1 regex could not see", () => {
	// Each case reads a REAL file from tests/fixtures/lsp-double-gate through
	// the same read-and-parse path as the population walk. `touchFile: vi.fn(`
	// matches NONE of the five.
	const REGEX_ROUND_1 = /touchFile\s*:\s*vi\.fn\s*\(/;
	const scanFixture = (name: string, vocabulary?: ReadonlySet<string>) =>
		findHandRolledLspDoubles(
			fs.readFileSync(path.join(FIXTURES, name), "utf8"),
			vocabulary,
		);

	it.each([
		["shape-a-shorthand.ts", "shorthand properties"],
		["shape-b-plain-async.ts", "a plain async stub, no vi.fn at all"],
		["shape-c-post-hoc.ts", "post-hoc property assignment"],
		["shape-d-multiline.ts", "vi + newline + .fn()"],
		["shape-e-alias-laundered.ts", "const makeTouchFileMock = vi.fn"],
	])("flags %s (%s)", async (fixture) => {
		const source = fs.readFileSync(path.join(FIXTURES, fixture), "utf8");
		expect(REGEX_ROUND_1.test(source)).toBe(false);
		expect(await scanFixture(fixture)).not.toEqual([]);
	});

	it.each([
		["compliant-factory-override.ts", "focused overrides on a seeded object"],
		["compliant-lsp-client-double.ts", "a fake LSP client, a different seam"],
	])("does NOT flag %s (%s)", async (fixture) => {
		expect(await scanFixture(fixture)).toEqual([]);
	});

	it("the OBJECT rule does not read the vocabulary — the seam is the anchor", () => {
		// #2582 round 3, N2. Round 2 computed `vocabulary ∩ keys` on every
		// object hit, stored it, and never gated on it, while the docstring
		// claimed the vocabulary filtered the object rule. Emptying the
		// vocabulary must leave every object-shaped hit EXACTLY where it was:
		// an object the seam receives that the factory did not seed is
		// hand-rolled whatever it carries.
		const objectShapes = [
			"shape-a-shorthand.ts",
			"shape-b-plain-async.ts",
			"shape-d-multiline.ts",
			"shape-e-alias-laundered.ts",
		];
		return Promise.all(
			objectShapes.map(async (fixture) => {
				const withVocabulary = await scanFixture(fixture);
				const without = await scanFixture(fixture, new Set<string>());
				expect(without).toEqual(withVocabulary);
				expect(without).not.toEqual([]);
			}),
		);
	});

	it("the POST-HOC rule DOES read the vocabulary — there it is load-bearing", async () => {
		// The mirror of the test above, and the only place the vocabulary
		// decides anything: `service.foo = …` has no other signal than the
		// property name. Emptying the vocabulary must red exactly this fixture.
		expect(await scanFixture("shape-c-post-hoc.ts")).not.toEqual([]);
		expect(await scanFixture("shape-c-post-hoc.ts", new Set<string>())).toEqual(
			[],
		);
	});

	it("the vocabulary is derived from the factory, not from a hand-copied list", () => {
		const vocabulary = lspServiceMethodNames();
		expect(vocabulary).toEqual(new Set(Object.keys(makeLspServiceDouble())));
		expect(vocabulary.has("touchFile")).toBe(true);
	});
});
