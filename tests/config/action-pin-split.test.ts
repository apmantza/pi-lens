import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { toPosix } from "../../clients/path-utils.js";
import {
	type ActionPin,
	checkActionPins,
	displayPath,
	interpreterPinErrors,
	parseActionPins,
	workflowFiles,
} from "../../scripts/check-action-pins.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";

// Recurrence #4350: the combined dependabot merge #4333 bumped
// github/codeql-action/analyze and /upload-sarif to v4.38.3 and left /init on
// v4.38.2, in both ci.yml and codeql.yml. Dependabot treats each subpath of an
// action repo as its own dependency, so it can bump them in separate PRs.
// CodeQL refuses a mixed run ("All steps in a workflow that use
// github/codeql-action must use the same version"), and every CodeQL job
// failed in the analyze post-step. The per-file codeql-workflow test compared
// ci.yml with codeql.yml step by step, so a split both files shared passed it.
//
// The rule is one SHA per action repository (owner/repo) across the whole
// tree that scripts/check-action-pins.mjs reads, not only codeql-action: it
// held for every other repository when it landed, and a subpath action such
// as actions/cache/restore + actions/cache/save splits the same way.

const ROOT = resolve(import.meta.dirname, "../..");

// Repository-relative path with forward slashes on every platform. The walker
// emits platform separators, and every expectation in this file uses `/`.
function repoRelative(
	file: string,
	root = ROOT,
	api: { relative: (from: string, to: string) => string } = { relative },
): string {
	return toPosix(api.relative(root, file));
}

const repoOf = (action: string) => action.split("/").slice(0, 2).join("/");

function pinSplits(pins: ActionPin[]): string[] {
	const byRepo = new Map<string, Map<string, string[]>>();
	for (const pin of pins) {
		const repo = repoOf(pin.action);
		const shas = byRepo.get(repo) ?? new Map<string, string[]>();
		byRepo.set(repo, shas);
		const sites = shas.get(pin.sha) ?? [];
		shas.set(pin.sha, sites);
		sites.push(`${pin.file}:${pin.line}`);
	}
	return [...byRepo]
		.filter(([, shas]) => shas.size > 1)
		.map(
			([repo, shas]) =>
				`${repo} has ${shas.size} SHAs: ${[...shas]
					.map(([sha, sites]) => `${sha} at ${sites.join(", ")}`)
					.join("; ")}`,
		);
}

// A `uses:` key in block, flow-map or quoted form. Comment lines are skipped.
const USES_KEY = /(?:^|[\s{,-])["']?uses["']?\s*:\s*["']?([^\s"'},#]+)/;
// Local actions and container uses are not pinned by design.
const LOCAL_OR_DOCKER = /^(?:\.\/|docker:\/\/)/;

interface RemoteUses {
	line: number;
	text: string;
}

function remoteUsesLines(text: string): RemoteUses[] {
	const found: RemoteUses[] = [];
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		if (raw.trimStart().startsWith("#")) continue;
		const match = raw.match(USES_KEY);
		if (!match || LOCAL_OR_DOCKER.test(match[1])) continue;
		found.push({ line: index + 1, text: raw.trim() });
	}
	return found;
}

// Every remote uses: line that parseActionPins does not turn into a pin.
function unparsedUses(text: string, file: string): string[] {
	const pinned = new Set(parseActionPins(text, file).map((pin) => pin.line));
	return remoteUsesLines(text)
		.filter((use) => !pinned.has(use.line))
		.map((use) => `${file}:${use.line}: ${use.text}`);
}

async function treeScan(): Promise<{
	pins: ActionPin[];
	uses: number;
	unparsed: string[];
}> {
	const pins: ActionPin[] = [];
	let uses = 0;
	const unparsed: string[] = [];
	for (const file of await workflowFiles(ROOT)) {
		const text = readFileSync(file, "utf8");
		const rel = repoRelative(file);
		pins.push(...parseActionPins(text, rel));
		uses += remoteUsesLines(text).length;
		unparsed.push(...unparsedUses(text, rel));
	}
	return { pins, uses, unparsed };
}

const FIXTURE_UNPARSED = `jobs:
  build:
    steps:
      - uses: actions/checkout@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v7
      - uses: github/codeql-action/init@v4
      - uses: "actions/cache@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2" # v5
      - {uses: actions/setup-node@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2}
      - uses: ./local-action
      - uses: docker://alpine:3.19
`;

describe("#4350 one SHA per action repository across the workflow tree", () => {
	it("pins every action repository, codeql-action included, to one SHA", async () => {
		const { pins, uses, unparsed } = await treeScan();
		// Every remote uses: line must be parsed into a pin, or the SHA rule
		// below is checking a subset of the tree. Recurrence #4350 review F1.
		expect(
			unparsed,
			`uses: lines parseActionPins does not pin (tag, quoted or flow form): ${unparsed.join("; ")}`,
		).toEqual([]);
		expect(
			uses,
			`${uses} remote uses: lines but ${pins.length} parsed pins`,
		).toBe(pins.length);
		// Floor: the tree still holds the three codeql-action steps in
		// codeql.yml (ci.yml's PR-time job left in #5275), so an empty walk or a
		// parser change cannot pass vacuously.
		const codeql = pins.filter(
			(pin) => repoOf(pin.action) === "github/codeql-action",
		);
		expect(new Set(codeql.map((pin) => pin.action))).toEqual(
			new Set([
				"github/codeql-action/init",
				"github/codeql-action/analyze",
				"github/codeql-action/upload-sarif",
			]),
		);
		expect(new Set(codeql.map((pin) => pin.file))).toEqual(
			new Set([".github/workflows/codeql.yml"]),
		);
		expect(pinSplits(pins)).toEqual([]);
	});

	it("reports a subpath split within one repository and not across repositories", () => {
		const a = "2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2";
		// A fake SHA, not the live codeql pin: a live one goes stale on each bump
		// (live-pin-literal-sweep.test.ts, #4418/#4421).
		const b = "4444444444444444444444444444444444444444";
		const pins = [
			...parseActionPins(
				[
					`      - uses: actions/checkout@${a} # v7`,
					`      - uses: github/codeql-action/init@${a} # v4.38.2`,
					`      - uses: github/codeql-action/analyze@${b} # v4.38.3`,
				].join("\n"),
				"ci.yml",
			),
			...parseActionPins(
				[
					`      - uses: actions/setup-node@${b} # v6.5.0`,
					`      - uses: github/codeql-action/upload-sarif@${b} # v4.38.3`,
				].join("\n"),
				"codeql.yml",
			),
		];
		expect(pinSplits(pins)).toEqual([
			`github/codeql-action has 2 SHAs: ${a} at ci.yml:2; ${b} at ci.yml:3, codeql.yml:2`,
		]);
	});

	it("normalizes a Windows-shaped workflow path to forward slashes", () => {
		// Recurrence #4350 round 3: Unit tests Windows (advisory) reded on
		// Set{'.github\\workflows\\ci.yml'} because the tree path kept the
		// platform separator. Fed through win32 here so Linux reproduces it.
		expect(
			repoRelative("C:\\repo\\.github\\workflows\\ci.yml", "C:\\repo", win32),
		).toBe(".github/workflows/ci.yml");
	});

	it("names every uses: line parseActionPins cannot pin, and only those", () => {
		// Recurrence #4350 review F1: a tag pin (@v4), a quoted uses value and a
		// flow-map step were silently skipped, so a tag-pinned CodeQL step next to
		// SHA-pinned ones passed both checkers. Local ./ and docker:// uses are
		// exempt by design and must not be reported.
		expect(unparsedUses(FIXTURE_UNPARSED, "ci.yml")).toEqual([
			"ci.yml:5: - uses: github/codeql-action/init@v4",
			`ci.yml:6: - uses: "actions/cache@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2" # v5`,
			"ci.yml:7: - {uses: actions/setup-node@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2}",
		]);
	});
});

// #4683: a floating `python-version` silently changes which interpreter (and
// therefore which wheels) a job gets. #4666 was one instance; #4671 tried to
// gate it with a TEXT scan of the workflows and six review rounds each found a
// new silent pass (shape 69: an enumerated gate fails open) — flow-style steps,
// a key leaking across flow siblings, anchors, aliases, tags, a collection
// opened on one line and filled on the next. The gate below PARSES the file
// with js-yaml, so those forms arrive resolved and are never re-handled by
// text, and every form the walker cannot classify refuses.
//
// STATE_TABLE.md carries the whole population: one row per input shape and its
// verdict. The tables below are that population, one case each, driven through
// the real entry point `checkActionPins({ root })` over a fixture root — not
// through `interpreterPinErrors` — so a rule that is not wired is not green.
const STEP0 = ".github/workflows/plant.yml: jobs.lint.steps[0]";
const WORKFLOW_HEAD = "jobs:\n  lint:\n    runs-on: ubuntu-latest\n";

// A tag ref, not a SHA: the interpreter rule is the subject here, and a tag
// pin makes no GitHub API call, so `pinErrors` can forbid the network.
const SETUP = "      - uses: actions/setup-python@v7.0.0";

const floating = (at: string, pin: string) =>
	`${at}: actions/setup-python python-version ${JSON.stringify(pin)} is not a concrete x.y or x.y.z release`;
const notString = (at: string, value: string) =>
	`${at}: actions/setup-python python-version ${value} is not a string; quote the exact release`;
const noPin = (at: string) =>
	`${at}: actions/setup-python has no python-version pin`;
const unresolved = (at: string, pin: string, why: string) =>
	`${at}: actions/setup-python python-version ${JSON.stringify(pin)} cannot be resolved: ${why}`;

const workflowWith = (steps: string) => `${WORKFLOW_HEAD}    steps:\n${steps}`;

// One `with:` block pinning `python-version` to the given YAML value literal.
const pinning = (value: string) =>
	`${SETUP}\n        with:\n          python-version: ${value}\n`;

async function pinErrors(files: Record<string, string>): Promise<string[]> {
	const fixture = setupTestEnvironment("pi-lens-4683-action-pin-");
	try {
		for (const [rel, text] of Object.entries(files)) {
			const path = resolve(fixture.tmpDir, rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
		return await checkActionPins({
			root: fixture.tmpDir,
			// A tag-pinned fixture yields no action pin, so nothing here may
			// resolve a tag: a fetch means the fixture reached the network.
			fetchImpl: async () => {
				throw new Error("this fixture must not resolve a tag");
			},
		});
	} finally {
		fixture.cleanup();
	}
}

// [input shape, the workflow's steps:, expected errors]. Shape table rows 1-33
// and 39-42 and 45-46 and 54-59.
const PLANTS: Array<[string, string, string[]]> = [
	["a concrete x.y release", pinning('"3.12"'), []],
	["a concrete x.y.z release", pinning('"3.12.15"'), []],
	[
		"a concrete release in a flow step",
		'      - {uses: actions/setup-python@v7.0.0, with: {python-version: "3.12"}}\n',
		[],
	],
	["the floating channel", pinning('"3.x"'), [floating(STEP0, "3.x")]],
	["a bare major", pinning('"3"'), [floating(STEP0, "3")]],
	["a floating minor", pinning('"3.12.x"'), [floating(STEP0, "3.12.x")]],
	["a wildcard", pinning('"3.12.*"'), [floating(STEP0, "3.12.*")]],
	["a range specifier", pinning('">=3.12"'), [floating(STEP0, ">=3.12")]],
	["a tilde range", pinning('"~3.12"'), [floating(STEP0, "~3.12")]],
	["the latest channel", pinning("latest"), [floating(STEP0, "latest")]],
	["a pre-release", pinning('"3.13.0rc1"'), [floating(STEP0, "3.13.0rc1")]],
	["a dev release", pinning('"3.13-dev"'), [floating(STEP0, "3.13-dev")]],
	[
		"an unquoted float that keeps its digits",
		pinning("3.12"),
		[notString(STEP0, "3.12")],
	],
	[
		"an unquoted float that loses a digit",
		pinning("3.10"),
		[notString(STEP0, "3.1")],
	],
	["a boolean", pinning("true"), [notString(STEP0, "true")]],
	["a list", pinning('["3.12"]'), [notString(STEP0, '["3.12"]')]],
	["a mapping", pinning("{minor: 12}"), [notString(STEP0, '{"minor":12}')]],
	["an empty value", pinning(""), [notString(STEP0, "null")]],
	["a quoted empty string", pinning('""'), [floating(STEP0, "")]],
	["a leading space", pinning('" 3.12"'), [floating(STEP0, " 3.12")]],
	["a block scalar", pinning("|\n            3.x"), [floating(STEP0, "3.x\n")]],
	[
		"a with: written as a flow mapping",
		`${SETUP}\n        with: {python-version: "3.x"}\n`,
		[floating(STEP0, "3.x")],
	],
	["a step with no with: block", `${SETUP}\n`, [noPin(STEP0)]],
	[
		"a with: block with other inputs only",
		`${SETUP}\n        with:\n          cache: pip\n`,
		[noPin(STEP0)],
	],
	[
		"a with: that is not a mapping",
		`${SETUP}\n        with: pip\n`,
		[`${STEP0}: with is not a mapping; the python-version pin cannot be read`],
	],
	[
		"a mixed-case action name",
		'      - uses: Actions/Setup-Python@v7\n        with:\n          python-version: "3.x"\n',
		[floating(STEP0, "3.x")],
	],
	[
		"an env expression",
		pinning('"${{ env.PIN }}"'),
		[floating(STEP0, "${{ env.PIN }}")],
	],
	[
		"a compound matrix expression",
		pinning(`"\${{ matrix.py || '3.12' }}"`),
		[floating(STEP0, "${{ matrix.py || '3.12' }}")],
	],
	[
		"an expression inside a string",
		pinning('"3.${{ x }}"'),
		[floating(STEP0, "3.${{ x }}")],
	],
	[
		"a uses: that is not a string",
		"      - uses:\n          name: actions/setup-python\n",
		[`${STEP0}: uses is not a string; the action cannot be read`],
	],
	[
		"a step that is not a mapping",
		'      - "just a string"\n',
		[`${STEP0}: the step is not a mapping`],
	],
	[
		"a block scalar body that prints a setup-python step",
		'      - name: print\n        run: |\n          - uses: actions/setup-python@v7\n            with:\n              python-version: "3.x"\n',
		[],
	],
	[
		"a one-line run: that prints a setup-python step",
		"      - run: 'echo uses: actions/setup-python@v7 with python-version 3.x'\n",
		[],
	],
	[
		"a step name that mentions the action",
		'      - name: actions/setup-python "3.x"\n        run: echo ok\n',
		[],
	],
	[
		"a wrapper input whose value names the action",
		"      - uses: owner/wrapper@v1\n        with:\n          uses: actions/setup-python@v7\n",
		[],
	],
	[
		"setup-node with a floating node version",
		'      - uses: actions/setup-node@v7\n        with:\n          node-version: "22"\n',
		[],
	],
	[
		"a local action with uses as an input",
		"      - uses: ./local-action\n        with:\n          uses: actions/setup-python@v7\n",
		[],
	],
];

// [input shape, repo-relative file, file text, expected errors]. Shape table
// rows 4-7 (anchors and matrices), 26-29 and 31-32 (flow and tag shapes),
// 34-38 and 43-44 (matrix resolution and composite actions), 47-53 (read side).
const DOCUMENTS: Array<[string, string, string, string[]]> = [
	[
		"a with: that carries a merge key",
		".github/workflows/plant.yml",
		`x-base: &base\n  python-version: "3.x"\n${WORKFLOW_HEAD}    steps:\n      - uses: actions/setup-python@v7\n        with:\n          <<: *base\n`,
		[
			`.github/workflows/plant.yml: jobs.lint.steps[0].with carries a "<<" merge key this rule does not resolve; pin python-version on the step it applies to`,
		],
	],
	[
		"a step that inherits its uses through a merge key",
		".github/workflows/plant.yml",
		`x-step: &step\n  uses: actions/setup-python@v7\n  with:\n    python-version: "3.x"\n${WORKFLOW_HEAD}    steps:\n      - <<: *step\n`,
		[
			`.github/workflows/plant.yml: jobs.lint.steps[0] carries a "<<" merge key this rule does not resolve; pin python-version on the step it applies to`,
		],
	],
	[
		"a job that inherits its steps through a merge key",
		".github/workflows/plant.yml",
		`x-job: &job\n  runs-on: ubuntu-latest\n  steps:\n    - uses: actions/setup-python@v7\n      with:\n        python-version: "3.x"\njobs:\n  lint:\n    <<: *job\n`,
		[
			`.github/workflows/plant.yml: jobs.lint carries a "<<" merge key this rule does not resolve; pin python-version on the step it applies to`,
		],
	],
	[
		"a composite runs: that inherits its steps through a merge key",
		".github/actions/pin/action.yml",
		`x-runs: &runs\n  using: composite\n  steps:\n    - uses: actions/setup-python@v7\n      with:\n        python-version: "3.x"\nruns:\n  <<: *runs\n`,
		[
			`.github/actions/pin/action.yml: runs carries a "<<" merge key this rule does not resolve; pin python-version on the step it applies to`,
		],
	],
	[
		"a matrix that inherits its legs through a merge key",
		".github/workflows/plant.yml",
		`x-matrix: &m\n  py: ["3.x"]\n${WORKFLOW_HEAD}    strategy:\n      matrix:\n        <<: *m\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[
			`.github/workflows/plant.yml: jobs.lint.strategy.matrix carries a "<<" merge key this rule does not resolve; pin python-version on the step it applies to`,
		],
	],
	[
		"a step anchor reused through an alias",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps:\n      - &pin\n        uses: actions/setup-python@v7\n        with:\n          python-version: "3.x"\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - *pin\n`,
		[
			floating(".github/workflows/plant.yml: jobs.lint.steps[0]", "3.x"),
			floating(".github/workflows/plant.yml: jobs.other.steps[0]", "3.x"),
		],
	],
	[
		"a pinned step aliased into a second job",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps:\n      - &pin\n        uses: actions/setup-python@v7\n        with:\n          python-version: "3.12"\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - *pin\n`,
		[],
	],
	[
		"a whole steps list anchored and aliased",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps: &shared\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "3.x"\n  other:\n    runs-on: ubuntu-latest\n    steps: *shared\n`,
		[
			floating(".github/workflows/plant.yml: jobs.lint.steps[0]", "3.x"),
			floating(".github/workflows/plant.yml: jobs.other.steps[0]", "3.x"),
		],
	],
	[
		"a uses: value resolved through a scalar anchor",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps:\n      - uses: &action actions/setup-python@v7\n        with:\n          python-version: "3.x"\n      - uses: *action\n        with:\n          python-version: "3.12"\n`,
		[floating(".github/workflows/plant.yml: jobs.lint.steps[0]", "3.x")],
	],
	[
		"a steps list behind a !!seq tag",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps: !!seq\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "3.x"\n`,
		[floating(STEP0, "3.x")],
	],
	[
		"a quoted uses key in a flow step",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps:\n      - {"uses": actions/setup-python@v7, "with": {python-version: "3.x"}}\n`,
		[floating(STEP0, "3.x")],
	],
	[
		"a single-quoted uses key in a flow step",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps:\n      - {'uses': actions/setup-python@v7, 'with': {python-version: "3.x"}}\n`,
		[floating(STEP0, "3.x")],
	],
	[
		"a one-line flow steps list",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps: [{uses: actions/setup-python@v7, with: {python-version: "3.x"}}]\n`,
		[floating(STEP0, "3.x")],
	],
	[
		"a floating step after a with:-only flow sibling",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps: [{uses: actions/checkout@v7, with: {}}, {uses: actions/setup-python@v7, with: {python-version: "3.x"}}]\n`,
		[floating(".github/workflows/plant.yml: jobs.lint.steps[1]", "3.x")],
	],
	[
		"a whole job written as a flow mapping",
		".github/workflows/plant.yml",
		'jobs: {lint: {runs-on: ubuntu-latest, steps: [{uses: actions/setup-python@v7, with: {python-version: "3.x"}}]}}\n',
		[floating(STEP0, "3.x")],
	],
	[
		"a matrix reference whose legs are concrete",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix:\n        py: ["3.10", "3.12.15"]\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[],
	],
	[
		"a matrix reference supplied only by include:",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix:\n        include:\n          - py: "3.12"\n          - py: "3.12.15"\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[],
	],
	[
		"a matrix reference with one floating leg",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix:\n        py: ["3.12", "3.x"]\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[
			unresolved(
				STEP0,
				"${{ matrix.py }}",
				'matrix.py holds "3.x", which is not a concrete x.y or x.y.z release',
			),
		],
	],
	[
		"a matrix reference with a numeric leg",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix:\n        py: [3.12]\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[
			unresolved(
				STEP0,
				"${{ matrix.py }}",
				"matrix.py holds 3.12, which is not a concrete x.y or x.y.z release",
			),
		],
	],
	[
		"a matrix reference with no strategy at all",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[
			unresolved(
				STEP0,
				"${{ matrix.py }}",
				"the job declares no strategy.matrix, so matrix.py has no value",
			),
		],
	],
	[
		"a matrix reference to a key nothing declares",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix:\n        py: ["3.12"]\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.python }}"\n`,
		[
			unresolved(
				STEP0,
				"${{ matrix.python }}",
				"matrix.python declares no value",
			),
		],
	],
	[
		"a matrix reference to a key that is not a list",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix:\n        py: "3.12"\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[
			unresolved(
				STEP0,
				"${{ matrix.py }}",
				"matrix.py is not a list of values",
			),
		],
	],
	// Shape 69 sweep (round 3): every matrix shape the rule cannot read refuses
	// instead of reading as absent. Recurrence F-4695-1: `matrix.include` was
	// read only when it was an array, so an expression-valued include vanished
	// and the concrete axis legs admitted the step.
	[
		"a matrix include: that is not a list",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix:\n        py: ["3.12"]\n        include: "\${{ fromJSON('{}') }}"\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[
			unresolved(
				STEP0,
				"${{ matrix.py }}",
				"matrix.include is not a list the rule can read",
			),
		],
	],
	[
		"an empty matrix include:",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix:\n        py: ["3.12"]\n        include:\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[],
	],
	[
		"a matrix include: row that is not a mapping",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix:\n        include:\n          - 3.12\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[
			unresolved(
				STEP0,
				"${{ matrix.py }}",
				"matrix.include holds 3.12, which is not a mapping",
			),
		],
	],
	[
		"a strategy that is not a mapping",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy: [py]\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[
			unresolved(
				STEP0,
				"${{ matrix.py }}",
				"the job's strategy is not a mapping",
			),
		],
	],
	[
		"a strategy.matrix that is not a mapping",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    strategy:\n      matrix: py\n    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "\${{ matrix.py }}"\n`,
		[unresolved(STEP0, "${{ matrix.py }}", "strategy.matrix is not a mapping")],
	],
	[
		"a floating pin in a composite action",
		".github/actions/pin/action.yml",
		'name: pin\ndescription: pin\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-python@v7\n      with:\n        python-version: "3.x"\n',
		[floating(".github/actions/pin/action.yml: runs.steps[0]", "3.x")],
	],
	[
		"an inputs expression in a composite action",
		".github/actions/pin/action.yml",
		'name: pin\ndescription: pin\ninputs:\n  py:\n    default: "3.12"\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-python@v7\n      with:\n        python-version: "${{ inputs.py }}"\n',
		[
			floating(
				".github/actions/pin/action.yml: runs.steps[0]",
				"${{ inputs.py }}",
			),
		],
	],
	[
		"a pinned composite action",
		".github/actions/pin/action.yml",
		'name: pin\ndescription: pin\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-python@v7\n      with:\n        python-version: "3.12"\n',
		[],
	],
	[
		"a steps: mapping instead of a list",
		".github/workflows/plant.yml",
		`${WORKFLOW_HEAD}    steps:\n      first:\n        uses: actions/setup-python@v7\n`,
		[".github/workflows/plant.yml: jobs.lint.steps is not a list of steps"],
	],
	[
		"a document with no jobs and no runs",
		".github/workflows/plant.yml",
		"name: plant\non: [push]\n",
		[
			".github/workflows/plant.yml: neither a jobs nor a runs mapping; this file is not a workflow or composite action",
		],
	],
	[
		"a jobs: that is not a mapping",
		".github/workflows/plant.yml",
		"jobs:\n  - uses: actions/setup-python@v7\n",
		[".github/workflows/plant.yml: jobs is not a mapping of jobs"],
	],
	[
		"a runs: that is not a mapping",
		".github/actions/pin/action.yml",
		"runs: composite\n",
		[".github/actions/pin/action.yml: runs is not a mapping"],
	],
	[
		"a job that is not a mapping",
		".github/workflows/plant.yml",
		"jobs:\n  lint: ubuntu-latest\n",
		[".github/workflows/plant.yml: jobs.lint is not a mapping"],
	],
	[
		"a document that is a list",
		".github/workflows/plant.yml",
		"- uses: actions/setup-python@v7\n",
		[
			".github/workflows/plant.yml: the document is not a mapping; no step's python-version can be read",
		],
	],
];

describe("#4683 the interpreter pin is read from the parsed workflow", () => {
	for (const [shape, steps, expected] of PLANTS)
		it(`pins or refuses ${shape}`, async () => {
			expect(
				await pinErrors({ ".github/workflows/plant.yml": workflowWith(steps) }),
			).toEqual(expected);
		});

	for (const [shape, file, text, expected] of DOCUMENTS)
		it(`pins or refuses ${shape}`, async () => {
			expect(await pinErrors({ [file]: text })).toEqual(expected);
		});

	it("spells every message path with forward slashes, as the Windows lane needs", () => {
		// Unit tests Windows reded on 08f672c1d: `relative()` yields backslashes
		// there, so every message in this file disagreed with its expectation.
		expect(displayPath(".github\\workflows\\plant.yml", win32.sep)).toBe(
			".github/workflows/plant.yml",
		);
		expect(displayPath(".github/workflows/plant.yml")).toBe(
			".github/workflows/plant.yml",
		);
	});

	it("refuses a workflow the parser cannot read, and names the file", async () => {
		const errors = await pinErrors({
			".github/workflows/plant.yml": `${WORKFLOW_HEAD}    steps: !mine\n      - uses: actions/setup-python@v7\n`,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(
			/^\.github\/workflows\/plant\.yml: cannot be parsed as YAML: unknown sequence tag/,
		);
	});

	it("refuses a multi-document file rather than reading the first document", async () => {
		// The state table listed this shape with no case until round 3 of the
		// review (F-4695-6). js-yaml answers `expected a single document`.
		const errors = await pinErrors({
			".github/workflows/plant.yml": `${WORKFLOW_HEAD}    steps:\n      - uses: actions/setup-python@v7\n        with:\n          python-version: "3.12"\n---\njobs:\n  other:\n    runs-on: ubuntu-latest\n`,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(
			/^\.github\/workflows\/plant\.yml: cannot be parsed as YAML: expected a single document/,
		);
	});

	it("refuses a duplicate key rather than keeping the last one", async () => {
		const errors = await pinErrors({
			".github/workflows/plant.yml": `${WORKFLOW_HEAD}    steps:\n      - uses: actions/setup-python@v7\n        uses: actions/checkout@v7\n`,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(
			/^\.github\/workflows\/plant\.yml: cannot be parsed as YAML: /,
		);
	});

	it("admits every setup-python step in the tree, counting them independently of the rule", async () => {
		const files = await workflowFiles(ROOT);
		const mentions = files.flatMap((file) =>
			readFileSync(file, "utf8")
				.split(/\r?\n/)
				.filter((line) => line.includes("actions/setup-python"))
				.map((line) => `${repoRelative(file)}: ${line.trim()}`),
		);
		// Floor: the four uses #4683's class sweep names, so an empty walk or a
		// rule that reads nothing cannot pass this case.
		expect(mentions).toHaveLength(4);
		expect(
			await Promise.all(
				files.map(async (file) =>
					interpreterPinErrors(readFileSync(file, "utf8"), repoRelative(file)),
				),
			),
		).toEqual(files.map(() => []));
	});
});
