// mutation-lane: exclude
/**
 * #2439 — oxlint was a devDependency with no npm script and no CI job, so an
 * undefined identifier (a `ReferenceError` at runtime) in a `scripts/*.mjs`
 * file passed `npm run lint` (tsc over the TS project only) and CI. That bug
 * shipped in scripts/prune-agent-worktrees.mjs and was only caught by running
 * the CLI by hand (#2435).
 *
 * These tests spawn the REAL shipped oxlint binary (resolved via Node module
 * resolution, not a hard-coded path) against the repo's own committed
 * `.oxlintrc.json`, and the real `npm run lint:js` script itself (case 5 —
 * read from `package.json`, not a hand-rolled copy of its argv) — so a
 * regression in the npm script wiring, the config's `no-undef` override, or
 * a missing `--deny-warnings` fails here, not just in someone's manual
 * dogfood run.
 */
// flake-shape: real-process-spawn — the #2700 gating/advisory subset test
// below adds one more real oxlint `--print-config` spawn; no in-process
// double is faithful to which rules each npm script actually enables (see
// `ADMITTED_AFTER_BASELINE` in tests/clients/flake-shape-ratchet.test.ts).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const IS_WIN = process.platform === "win32";
const NPM = IS_WIN ? "npm.cmd" : "npm";
// Resolved via Node's own module resolution (not a hard-coded
// `<root>/node_modules/oxlint/bin/oxlint` path) so this still finds the
// shipped binary in a worktree where oxlint is hoisted to a parent
// `node_modules` rather than living directly under REPO_ROOT.
const require = createRequire(import.meta.url);
const OXLINT_ENTRY = path.join(
	path.dirname(require.resolve("oxlint/package.json")),
	"bin",
	"oxlint",
);
const OXLINT_CONFIG = path.join(REPO_ROOT, ".oxlintrc.json");
const SPAWN_TIMEOUT_MS = 15_000;

function runOxlint(targetFile: string) {
	return spawnSync(
		process.execPath,
		[OXLINT_ENTRY, "--config", OXLINT_CONFIG, "-f", "unix", targetFile],
		{ encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
	);
}

/**
 * Run a node entry (the lint wrapper) in `cwd` with the shipped oxlint on
 * PATH, as the wrapper spawns `oxlint` by name. One spawn site for every
 * type-aware planted-probe case (#3244, #4402).
 */
function runNodeWithOxlint(args: string[], cwd: string) {
	return spawnSync(process.execPath, args, {
		encoding: "utf8",
		cwd,
		env: {
			...process.env,
			PATH: `${path.dirname(OXLINT_ENTRY)}${path.delimiter}${process.env.PATH ?? ""}`,
		},
		timeout: SPAWN_TIMEOUT_MS * 2,
	});
}

describe("lint:js (#2439 — oxlint wired over .mjs/.cjs)", () => {
	it("package.json wires lint:js into npm run lint", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		);
		expect(pkg.scripts["lint:js"]).toMatch(/^oxlint\b/);
		expect(pkg.scripts.lint).toMatch(/npm run lint:js/);
	});

	it("fails on an undefined identifier in a .mjs file (the #2435 shape)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-lint-js-2439-");
		try {
			const fixture = path.join(tmpDir, "broken.mjs");
			fs.writeFileSync(
				fixture,
				"export function broken() {\n  return someUndefinedThing + 1;\n}\n",
			);
			const result = runOxlint(fixture);
			expect(result.status).not.toBe(0);
			expect(result.stdout).toContain("no-undef");
			expect(result.stdout).toContain("someUndefinedThing");
		} finally {
			cleanup();
		}
	});

	it("fails on an undefined identifier in a plain .js file (#2452 review round 1 — scripts/download-grammars.js has no other coverage)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-lint-js-2439-");
		try {
			const fixture = path.join(tmpDir, "broken.js");
			fs.writeFileSync(
				fixture,
				"export function broken() {\n  return someUndefinedThing + 1;\n}\n",
			);
			const result = runOxlint(fixture);
			expect(result.status).not.toBe(0);
			expect(result.stdout).toContain("no-undef");
			expect(result.stdout).toContain("someUndefinedThing");
		} finally {
			cleanup();
		}
	});

	it("does not false-positive on Node globals (env: node is wired)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-lint-js-2439-");
		try {
			const fixture = path.join(tmpDir, "clean.mjs");
			fs.writeFileSync(
				fixture,
				"export function greet() {\n  console.log(process.argv[2] ?? 'hi');\n}\n",
			);
			const result = runOxlint(fixture);
			expect(result.status).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("stays off for .ts files (no-undef risks TS ambient-type false positives)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-lint-js-2439-");
		try {
			const fixture = path.join(tmpDir, "broken.ts");
			fs.writeFileSync(
				fixture,
				"export function broken(): number {\n  return someUndefinedThing + 1;\n}\n",
			);
			const result = runOxlint(fixture);
			// tsc (not oxlint's no-undef) is the source of truth for TS files —
			// asserted separately by `npm run lint`'s tsc step.
			expect(result.status).toBe(0);
		} finally {
			cleanup();
		}
	});

	it(
		"`npm run lint:js` — the repo's real self-lint scope — currently passes clean",
		() => {
			// Spawns the REAL `npm run lint:js` (package.json's own script, not a
			// hand-rolled copy of its ignore-pattern argv) so a drift between this
			// pin and the actual wiring fails here, not just in CI. `--deny-warnings`
			// is baked into the script itself, so a warning-only regression (the
			// #2452 review-round-1 gap — 19 baseline hits exited 0 pre-fix) reds
			// this case too, not just errors.
			const result = spawnSync(NPM, ["run", "lint:js"], {
				encoding: "utf8",
				cwd: REPO_ROOT,
				shell: IS_WIN,
				timeout: SPAWN_TIMEOUT_MS,
			});
			expect(result.status, result.stdout + result.stderr).toBe(0);

			// #2461 round-2 (F1-r2): a narrowed target (e.g. swapping the trailing
			// whole-repo `.` for `scripts`, or any other subdirectory) still exits 0
			// on this clean tree, so the assertion above alone does not catch a
			// scope regression — it would silently stop linting clients/tools/mcp
			// again while this test stays green. Assert the real argv still targets
			// the whole repo.
			const pkg = JSON.parse(
				fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
			);
			const lintJs: string = pkg.scripts["lint:js"];
			expect(lintJs.trim()).toMatch(/\s\.\s*$/);
		},
		SPAWN_TIMEOUT_MS + 5_000,
	);
});

describe("lint:js:tests (#3244 — required type-aware test population)", () => {
	const TEST_SCRIPT = "lint:js:tests";
	const RULES = [
		[
			"typescript/no-floating-promises",
			"async function probe() { Promise.resolve(); }\n",
		],
		["typescript/await-thenable", "async function probe() { await 1; }\n"],
		[
			"eslint/no-unsafe-optional-chaining",
			"function probe(value) { return (value?.property).nested; }\n",
		],
	] as const;

	it("is wired through the real lint wrapper and required by npm run lint", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		);
		expect(pkg.scripts.lint).toContain(`npm run ${TEST_SCRIPT}`);
		expect(pkg.scripts[TEST_SCRIPT]).toMatch(
			/^node scripts\/lint-js-advisory\.mjs\s+--deny-warnings\s+--format unix\s+--type-aware/,
		);
		for (const [rule] of RULES)
			expect(pkg.scripts[TEST_SCRIPT]).not.toContain(`-D ${rule}`);
	});

	it("the committed config enables all three rules for tests", () => {
		const config = JSON.parse(fs.readFileSync(OXLINT_CONFIG, "utf8"));
		const testOverride = config.overrides.find(
			(override: { files?: string[] }) =>
				override.files?.includes("tests/**/*.ts"),
		);
		expect(testOverride?.rules).toMatchObject({
			"typescript/no-floating-promises": "error",
			"typescript/await-thenable": "error",
			"eslint/no-unsafe-optional-chaining": "error",
		});
	});

	it.each(RULES)(
		"the real required command fails on a planted %s recurrence",
		(rule, source) => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-lint-js-3244-");
			const fixture = path.join(tmpDir, "tests", "probe.ts");
			fs.mkdirSync(path.dirname(fixture), { recursive: true });
			const configPath = path.join(tmpDir, ".oxlintrc.json");
			fs.copyFileSync(OXLINT_CONFIG, configPath);
			fs.symlinkSync(
				path.join(REPO_ROOT, "node_modules"),
				path.join(tmpDir, "node_modules"),
				"dir",
			);
			fs.writeFileSync(
				path.join(tmpDir, "tsconfig.json"),
				JSON.stringify({ compilerOptions: { strict: true } }),
			);
			try {
				fs.writeFileSync(fixture, source);
				const commandArgs = [
					path.join(REPO_ROOT, "scripts/lint-js-advisory.mjs"),
					"--deny-warnings",
					"--format",
					"unix",
					"--type-aware",
					"-A",
					"correctness",
					"-A",
					"suspicious",
					"-A",
					"perf",
					"--ignore-pattern",
					"tests/fixtures/**",
					"--config",
					configPath,
					fixture,
				];
				const run = (args: string[]) => runNodeWithOxlint(args, tmpDir);
				const result = run(commandArgs);
				expect(result.status, result.stdout + result.stderr).not.toBe(0);
				expect(result.stdout + result.stderr).toContain(
					rule.replace(/^.*\//, ""),
				);

				const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
				const override = config.overrides.find((entry: { files?: string[] }) =>
					entry.files?.includes("tests/**/*.ts"),
				);
				override.rules[rule] = "off";
				fs.writeFileSync(configPath, JSON.stringify(config));
				const disabled = run(commandArgs);
				expect(disabled.status, disabled.stdout + disabled.stderr).toBe(0);
			} finally {
				cleanup();
			}
		},
		SPAWN_TIMEOUT_MS * 2 + 5_000,
	);
});

/**
 * #4402 (#4413 r2 verify D1): a promise a worker `message` listener drops
 * rejects outside its try, and pi's crash guard rethrows an unhandled
 * rejection, the same host death as #4400. The message-handler ratchet has no
 * type information, so an un-voided call to an imported async function, or to
 * a sync function that returns a promise, passed it. `lint:js:promises` runs
 * the type-aware floating-promise rules over the shipped roots inside the
 * gating `npm run lint`.
 */
describe("lint:js:promises (#4402 — floating promises in shipped code)", () => {
	const SCRIPT = "lint:js:promises";
	const ROOTS = "clients mcp tools index.ts";
	const PROBES = [
		[
			"an un-voided imported async call in a message handler",
			[
				'import { persist } from "./store.js";',
				'declare const port: { on(event: "message", h: (m: unknown) => void): void };',
				'port.on("message", (message: unknown) => {',
				"\ttry {",
				"\t\tpersist(message);",
				"\t} catch (err) {",
				"\t\tconsole.error(err);",
				"\t}",
				"});",
			],
			"no-floating-promises",
			(text: string) => text.replace(/\t\t(persist|save)\(/, "\t\tvoid $1("),
		],
		[
			"a sync function returning a promise, called un-voided",
			[
				"function save(message: unknown): Promise<void> {",
				"\treturn Promise.resolve(message).then(() => undefined);",
				"}",
				"export function handle(message: unknown): void {",
				"\ttry {",
				"\t\tsave(message);",
				"\t} catch (err) {",
				"\t\tconsole.error(err);",
				"\t}",
				"}",
			],
			"no-floating-promises",
			(text: string) => text.replace(/\t\t(persist|save)\(/, "\t\tvoid $1("),
		],
		[
			// #4428 step 1 (#4411 review shape): an `await` of a value that is not
			// a thenable reads as if it waited, and hides a call that lost its
			// promise (a sync refactor that left the `await` behind).
			"an await of a value that is not a thenable",
			[
				"declare function load(): number;",
				"export async function handle(): Promise<number> {",
				"\treturn await load();",
				"}",
			],
			"await-thenable",
			(text: string) => text.replace("return await load()", "return load()"),
		],
		[
			// #5331: a union switch whose `default` absorbs a member nobody listed.
			// The default is not exhaustive for a union (considerDefaultExhaustiveForUnions
			// stays off), so a new member would reach it silently; the rule reds it.
			"a union switch whose default absorbs an unlisted member",
			[
				'export type Mode = "read" | "write" | "admin";',
				"export function label(mode: Mode): string {",
				"\tswitch (mode) {",
				'\t\tcase "read":',
				'\t\t\treturn "R";',
				'\t\tcase "write":',
				'\t\t\treturn "W";',
				"\t\tdefault:",
				'\t\t\treturn "?";',
				"\t}",
				"}",
			],
			"switch-exhaustiveness-check",
			(text: string) =>
				text.replace(
					"\t\tdefault:",
					'\t\tcase "admin":\n\t\t\treturn "A";\n\t\tdefault:',
				),
		],
	] as const;

	function readScript(): string {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		);
		return pkg.scripts[SCRIPT];
	}

	it("is wired through the real lint wrapper and required by npm run lint", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		);
		expect(pkg.scripts.lint).toContain(`npm run ${SCRIPT}`);
		const script = readScript();
		expect(script).toMatch(
			/^node scripts\/lint-js-advisory\.mjs\s+--deny-warnings\s+--format unix\s+--type-aware/,
		);
		expect(script).toContain("-D typescript/await-thenable");
		expect(script).toContain("-D typescript/no-floating-promises");
		expect(script).toContain("-D typescript/no-misused-promises");
		expect(script).toContain("-D typescript/switch-exhaustiveness-check");
		expect(script.endsWith(` ${ROOTS}`)).toBe(true);
	});

	it.each(PROBES)(
		"the real required command fails on %s, and passes once it is repaired",
		(_label, lines, rule, repair) => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-lint-js-4402-");
			const fixture = path.join(tmpDir, "clients", "probe.ts");
			fs.mkdirSync(path.dirname(fixture), { recursive: true });
			fs.copyFileSync(OXLINT_CONFIG, path.join(tmpDir, ".oxlintrc.json"));
			fs.symlinkSync(
				path.join(REPO_ROOT, "node_modules"),
				path.join(tmpDir, "node_modules"),
				"dir",
			);
			fs.writeFileSync(
				path.join(tmpDir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						strict: true,
						module: "nodenext",
						moduleResolution: "nodenext",
					},
				}),
			);
			fs.writeFileSync(
				path.join(tmpDir, "clients", "store.ts"),
				"export async function persist(_message: unknown): Promise<void> {}\n",
			);
			// The package.json argv itself, with the shipped roots swapped for the
			// fixture: never a re-typed rule list.
			const argv = readScript()
				.replace(/^node\s+scripts\/lint-js-advisory\.mjs\s+/, "")
				.replace(` ${ROOTS}`, "")
				.split(/\s+/);
			const run = () =>
				runNodeWithOxlint(
					[
						path.join(REPO_ROOT, "scripts/lint-js-advisory.mjs"),
						...argv,
						fixture,
					],
					tmpDir,
				);
			try {
				fs.writeFileSync(fixture, `${lines.join("\n")}\n`);
				const planted = run();
				expect(planted.status, planted.stdout + planted.stderr).not.toBe(0);
				expect(planted.stdout + planted.stderr).toContain(rule);
				fs.writeFileSync(fixture, `${repair(lines.join("\n"))}\n`);
				const voided = run();
				expect(voided.status, voided.stdout + voided.stderr).toBe(0);
			} finally {
				cleanup();
			}
		},
		SPAWN_TIMEOUT_MS * 4 + 5_000,
	);
});

/**
 * #2700 — two tiers: `lint:js` (gating) enumerates individually-promoted
 * rules with zero findings on master, `lint:js:advisory` (continue-on-error
 * in lint.yml) runs the full categories+plugins+type-aware set. Nothing
 * stops the two npm-script strings from drifting apart by hand (a rule
 * added to `lint:js` without ever reaching `lint:js:advisory`, or a rule
 * removed from `lint:js:advisory` that `lint:js` still names) — this
 * resolves each script's REAL enabled-rule set via oxlint's own
 * `--print-config` (never a hand-copied rule list) and asserts the gating
 * set is a subset of the advisory set.
 */
describe("lint:js / lint:js:advisory — the gating rule set stays a subset of the advisory set (#2700)", () => {
	function enabledRules(npmScript: string): Set<string> {
		// oxlint's own argv, not a re-typed copy: strip the leading `oxlint`
		// token off the REAL package.json script string and run the shipped
		// binary directly (resolved the same way as OXLINT_ENTRY above) so a
		// change to either script's flags is picked up automatically.
		const rest = npmScript.replace(/^oxlint\s+/, "");
		const result = spawnSync(`${OXLINT_ENTRY} ${rest} --print-config`, {
			encoding: "utf8",
			cwd: REPO_ROOT,
			shell: true,
			timeout: SPAWN_TIMEOUT_MS,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
		const config = JSON.parse(result.stdout) as {
			rules: Record<string, string | null>;
		};
		return new Set(
			Object.entries(config.rules)
				.filter(([, severity]) => severity && severity !== "off")
				.map(([name]) => name),
		);
	}

	it(
		"every rule `lint:js` denies is also enabled in `lint:js:advisory`",
		() => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
			);
			const gating = enabledRules(pkg.scripts["lint:js"]);
			const advisory = enabledRules(pkg.scripts["lint:js:advisory"]);
			expect(gating.size).toBeGreaterThan(0);
			const missing = [...gating].filter((rule) => !advisory.has(rule));
			expect(missing).toEqual([]);
		},
		SPAWN_TIMEOUT_MS * 2 + 5_000,
	);

	// `gating.size > 0` above holds even with none of the 32 individually
	// promoted rules present (the default `correctness` category alone is
	// non-empty), so it would not notice one silently dropped from the
	// `lint:js` argv. Named here instead.
	const PROMOTED_RULES = [
		"block-scoped-var",
		"import/default",
		"import/namespace",
		"import/no-absolute-path",
		"import/no-empty-named-blocks",
		"import/no-named-as-default",
		"import/no-self-import",
		"no-extend-native",
		"no-extra-bind",
		"no-implied-eval",
		"no-new",
		"no-unexpected-multiline",
		"no-useless-constructor",
		"oxc/approx-constant",
		"oxc/misrefactored-assign-op",
		"oxc/no-accumulating-spread",
		"oxc/no-async-endpoint-handlers",
		"oxc/no-this-in-exported-function",
		"promise/no-callback-in-promise",
		"promise/no-multiple-resolved",
		"promise/no-new-statics",
		"promise/valid-params",
		"typescript/no-confusing-non-null-assertion",
		"typescript/no-extraneous-class",
		"typescript/no-unnecessary-type-constraint",
		"typescript/no-unsafe-enum-comparison",
		"unicorn/no-accessor-recursion",
		"unicorn/no-array-fill-with-reference-type",
		"unicorn/no-confusing-array-with",
		"unicorn/no-instanceof-builtins",
		"unicorn/prefer-array-flat-map",
		"unicorn/require-module-specifiers",
	];

	it(
		"all 32 individually-promoted rules are actually enabled in `lint:js`",
		() => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
			);
			const gating = enabledRules(pkg.scripts["lint:js"]);
			const missing = PROMOTED_RULES.filter((rule) => !gating.has(rule));
			expect(missing).toEqual([]);
		},
		SPAWN_TIMEOUT_MS + 5_000,
	);

	// Coordination note from the orchestrator (2026-09-07, #2700): eight
	// rules are policy-`-A`llowed in `lint:js:advisory` rather than left to
	// deny-and-triage, each for a named reason -- NOT drive-by suppression:
	//   - no-underscore-dangle, no-await-in-loop, unicorn/no-array-sort,
	//     unicorn/consistent-function-scoping: overwhelmingly test-tree
	//     noise (755/696/451/369 hits respectively on the full advisory
	//     sweep) that would swamp the tier's signal rather than surface a
	//     real defect class.
	//   - promise/no-promise-in-callback: false positive on a deliberate
	//     `void x.then(...)` inside a callback.
	//   - no-useless-call: false positive on an explicit `.call(bus, ...)`
	//     this-binding.
	//   - import/no-unassigned-import: false positive on a deliberate
	//     side-effect import.
	//   - no-unmodified-loop-condition: false positive on an AbortSignal
	//     property poll (`while (!signal.aborted)`).
	it("the eight policy-allowed rules resolve to off in `lint:js:advisory`", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		);
		const advisory = enabledRules(pkg.scripts["lint:js:advisory"]);
		for (const rule of [
			"no-underscore-dangle",
			"no-await-in-loop",
			"unicorn/no-array-sort",
			"unicorn/consistent-function-scoping",
			"promise/no-promise-in-callback",
			"no-useless-call",
			"import/no-unassigned-import",
			"no-unmodified-loop-condition",
		]) {
			expect(advisory.has(rule)).toBe(false);
		}
	});
});

describe("lint:js — TS lane (#2454 — clients/tools/mcp/index.ts scanned for warning-tier hits)", () => {
	it("does not ignore .ts/.tsx (the **/*.ts blanket ignore-pattern is gone)", () => {
		// The #2439 baseline shipped with a blanket `**/*.ts`/`**/*.tsx`
		// ignore-pattern (the TS tree had 30+ un-triaged warning-tier hits at
		// the time). #2454 drove those to zero and dropped the blanket ignore
		// — a regression that puts it back (even accidentally, e.g. copy-pasting
		// the old flag list) would silently stop linting clients/tools/mcp/
		// index.ts TypeScript again, so assert directly against the argv string
		// rather than only re-deriving pass/fail from a clean tree.
		const pkg = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		);
		const lintJs: string = pkg.scripts["lint:js"];
		expect(lintJs).not.toMatch(/--ignore-pattern\s+"?\*\*\/\*\.tsx?"?/);
	});

	it(
		"mutation proof: a planted warning-tier hit fails the real `npm run lint:js` argv",
		() => {
			// This is the #2454 acceptance criterion's literal mutation proof,
			// codified as a regression test rather than only a one-off manual run.
			// Round 2 (#2461 review): the probe used to be planted straight into
			// the live, git-tracked `clients/` tree and driven through
			// `npm run lint` (tsc + lint:js) — tsc alone runs ~25s in CI, blowing
			// past vitest's 5000ms default test timeout and flaking the whole
			// suite. It's also unsafe to plant into `clients/` at all: other
			// vitest workers (or another agent sharing this worktree) can be
			// running `npm run lint`/`lint:js` scanning `.` at the same moment,
			// and a stray probe file sitting inside that scanned tree races their
			// runs (#2007 directory isolation).
			//
			// Fixed by testing the flag actually under test — `lint:js`, not the
			// tsc-fronted `lint` — and by pointing the REAL npm script (its own
			// `--deny-warnings` + ignore-pattern argv from package.json, unchanged)
			// at an isolated temp-dir probe passed as an extra oxlint target via
			// `npm run lint:js -- <path>`, instead of writing into `clients/`.
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-lint-js-2454-mutation-",
			);
			try {
				const probePath = path.join(tmpDir, "lint2454-mutation-probe.ts");
				fs.writeFileSync(
					probePath,
					"export function __lint2454MutationProbe(n: number): number[] {\n\treturn new Array(n);\n}\n",
				);
				const result = spawnSync(NPM, ["run", "lint:js", "--", probePath], {
					encoding: "utf8",
					cwd: REPO_ROOT,
					shell: IS_WIN,
					timeout: SPAWN_TIMEOUT_MS,
				});
				expect(result.status).not.toBe(0);
				expect(result.stdout + result.stderr).toContain("no-new-array");
			} finally {
				cleanup();
			}
		},
		SPAWN_TIMEOUT_MS + 5_000,
	);
});
