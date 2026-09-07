/**
 * The state-space suite for `spawn-cwd-scan.ts` (#2691 round 3).
 *
 * The live-tree sweep in
 * `tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts` can only
 * ever assert what the tree happens to contain today: it goes green on 62
 * conforming sites and says nothing about the cells no runner currently
 * occupies. That is how rounds 1 and 2 each shipped a detector whose hole was
 * invisible to its own test — round 1's red block quoted six rows while
 * missing a seventh defect the PR was fixing, and round 2's wrapper rule left
 * two live helm wrappers unchecked.
 *
 * So every cell of PR #2693's "Detector state space (round 3)" table —
 * call-site kind × where a `cwd` token can sit — is driven here on an INLINE
 * source string, named with the same fixture id the table cites, and the live
 * tree is the integration assertion on top.
 *
 * Rows: K1 direct · K2 destructured `{ cwd }` param · K3 options param
 * destructured in the body · K4 positional cwd param · K5 arrow/const form ·
 * K6 method form · K7 `createCwdCachedProbe` closure · K8 `...rest` spread ·
 * K9 opaque options identifier · K10 `// cwd-exempt:` tag.
 *
 * Columns: P1 options KEY · P2 comment inside the options · P3 string value
 * inside the options · P4 another argument · P5 a non-`cwd` key's value ·
 * P6 the wrapper's parameter list only · P7 absent.
 */

import { describe, expect, it } from "vitest";
import { scanSpawnCwd } from "./spawn-cwd-scan.js";

/** What the sweep itself asks of a scan, in a form a fixture can assert. */
async function analyze(source: string): Promise<{
	flagged: string[];
	wrappers: string[];
	redundantExemptions: string[];
	sites: string[];
}> {
	const scan = await scanSpawnCwd("fixture.ts", source);
	return {
		flagged: scan.sites
			.filter((site) => !site.hasCwd && !site.exemptReason)
			.map((site) => `${site.line}:${site.callee}`),
		wrappers: scan.wrappers.map((w) => `${w.name}:${w.mode}@${w.paramIndex}`),
		redundantExemptions: scan.sites
			.filter((site) => site.exemptReason && site.hasCwd)
			.map((site) => `${site.line}:${site.callee}`),
		sites: scan.sites.map((site) => `${site.line}:${site.callee}:${site.kind}`),
	};
}

/**
 * The expected `line:callee` for the fixture line containing `snippet`, so a
 * line expectation is derived from the FIXTURE TEXT rather than copied out of
 * the detector's own output. It also pins a real property: a wrapper call site
 * is reported at the CALLER's line, never at the spawn buried inside the
 * wrapper — reporting the latter is what made round 2's F2 unfixable from the
 * sweep's message alone.
 */
function at(source: string, snippet: string, callee: string): string {
	const matches = source
		.split("\n")
		.map((line, index) => (line.includes(snippet) ? index + 1 : 0))
		.filter((line) => line > 0);
	if (matches.length !== 1) {
		throw new Error(
			`fixture must contain exactly one line with ${JSON.stringify(snippet)}, found ${matches.length}`,
		);
	}
	return `${matches[0]}:${callee}`;
}

// ── K1 · direct spawn ───────────────────────────────────────────────────────

describe("K1 — a direct safeSpawn* call", () => {
	it("f-direct-key · P1: a `cwd` key in the options object passes", async () => {
		const { flagged } = await analyze(`
			async function run(ctx) {
				const cwd = ctx.cwd || process.cwd();
				await safeSpawnAsync("yamllint", ["-f", "parsable", ctx.filePath], {
					cwd,
					timeout: 15000,
				});
			}
		`);
		expect(flagged).toEqual([]);
	});

	it("f-direct-comment · P2: `cwd` inside a COMMENT in the options is flagged", async () => {
		// Round 2's detector tested the RAW text of the options span, so this
		// exact comment cleared the guard with #2691's defect fully intact.
		const source = `
			async function run(ctx) {
				const cwd = ctx.cwd || process.cwd();
				await safeSpawnAsync("yamllint", ["-f", "parsable", ctx.filePath], {
					// no cwd here: yamllint resolves config from the file
					timeout: 15000,
				});
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-direct-string · P3: `cwd` inside a STRING value in the options is flagged", async () => {
		const source = `
			async function run(ctx) {
				const cwd = ctx.cwd || process.cwd();
				await safeSpawnAsync("yamllint", [], {
					timeout: 15000,
					resourceLabel: "yamllint-cwd",
				});
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-direct-argsarray · P4: `cwd` used only in the ARGS ARRAY is flagged", async () => {
		// Round 1's detector tested the whole call text, so this — and
		// `typos.getCommand(ctx.cwd)` in argument one, one of the six real
		// defects this PR fixes — read as conforming.
		const source = `
			async function run(ctx) {
				const cwd = ctx.cwd || process.cwd();
				await safeSpawnAsync(typos.getCommand(cwd), ["-f", path.resolve(cwd, ctx.filePath)], {
					timeout: 15000,
				});
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-direct-envpwd · P5: `cwd` in a NON-cwd key's value is flagged", async () => {
		// The cell the round-2 review's prescribed remedy (test the
		// comment/string-BLANKED slice instead of the raw slice) leaves open:
		// this `cwd` is a real identifier that no blanking touches, and
		// `/\bcwd\b/` over the options span still matches it.
		const source = `
			async function run(ctx) {
				const cwd = ctx.cwd || process.cwd();
				await safeSpawnAsync("yamllint", [], {
					timeout: 15000,
					env: { ...process.env, PWD: cwd },
				});
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-direct-absent · P7: no options argument at all is flagged", async () => {
		const source = `
			async function run(ctx) {
				await safeSpawnAsync("yamllint", ["-f", "parsable", ctx.filePath]);
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});
});

// ── K2 · wrapper with a destructured `{ cwd }` parameter ────────────────────

/** `w`'s own spawn always reads as P1+P6 — it forwards its parameter. The site
 * under judgement is the CALLER, which is round 2's F2 in one line. */
const K2_WRAPPER = `
	function w(cmd: string, args: string[], { cwd, timeoutMs }: { cwd?: string; timeoutMs?: number }) {
		return safeSpawnAsync(cmd, args, { cwd, timeout: timeoutMs });
	}
`;

describe("K2 — a wrapper with a destructured { cwd } parameter", () => {
	it("f-destructured-caller-ok · P1: a caller passing `{ cwd }` passes", async () => {
		const { flagged, wrappers } = await analyze(
			`${K2_WRAPPER}\nw("tool", [], { cwd, timeoutMs: 1000 });`,
		);
		expect(wrappers).toEqual(["w:options@2"]);
		expect(flagged).toEqual([]);
	});

	it("f-destructured-caller-comment · P2: a caller whose options only MENTION cwd in a comment is flagged", async () => {
		const source = `${K2_WRAPPER}\nw("tool", [], {\n// cwd is not needed for a presence probe\ntimeoutMs: 1000,\n});`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, 'w("tool", [], {', "w")]);
	});

	it("f-destructured-caller-string · P3: a caller whose options only carry cwd in a string is flagged", async () => {
		const source = `${K2_WRAPPER}\nw("tool", [], { label: "tool-cwd", timeoutMs: 1000 });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, 'label: "tool-cwd"', "w")]);
	});

	it("f-destructured-caller-argsarray · P4: a caller with cwd only in the args array is flagged", async () => {
		const source = `${K2_WRAPPER}\nw("tool", [path.resolve(cwd, file)], { timeoutMs: 1000 });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "path.resolve(cwd, file)", "w")]);
	});

	it("f-destructured-caller-envpwd · P5: a caller with cwd in another key's value is flagged", async () => {
		const source = `${K2_WRAPPER}\nw("tool", [], { env: { PWD: cwd }, timeoutMs: 1000 });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "env: { PWD: cwd }", "w")]);
	});

	it("f-destructured-caller-bare · P6/P7: a caller supplying no options at all is flagged", async () => {
		// P6 alone — `cwd` appearing in the WRAPPER's parameter list and nowhere
		// at the caller — is the whole of round 2's F2. The wrapper's own literal
		// names cwd; the caller supplies none.
		const source = `${K2_WRAPPER}\nw("tool", []);`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, 'w("tool", []);', "w")]);
	});
});

// ── K3 · wrapper whose options PARAMETER is destructured in the body ────────

/** `spawnPs` and `runIacPass`, verbatim in shape. Round 2 recognised this one
 * only through the parameter's TYPE ANNOTATION, which is why a wrapper without
 * one (`lintChart`) was invisible to it. */
const K3_WRAPPER = `
	function spawnPs(cmd: string, args: string[], options = {}) {
		const { timeoutMs = 30000, cwd } = options;
		return safeSpawnAsync(cmd, args, { cwd, timeout: timeoutMs });
	}
`;

describe("K3 — a wrapper whose options parameter is destructured in the body", () => {
	it("f-optsparam-caller-ok · P1: a caller passing `{ cwd }` passes", async () => {
		const { flagged, wrappers } = await analyze(
			`${K3_WRAPPER}\nspawnPs(cmd, args, { timeoutMs: 1000, cwd });`,
		);
		expect(wrappers).toEqual(["spawnPs:options@2"]);
		expect(flagged).toEqual([]);
	});

	it("f-optsparam-caller-comment · P2: a comment in the caller's options is flagged", async () => {
		const source = `${K3_WRAPPER}\nspawnPs(cmd, args, {\n// cwd deliberately omitted\ntimeoutMs: 1000,\n});`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "spawnPs(cmd, args, {", "spawnPs")]);
	});

	it("f-optsparam-caller-string · P3: a string in the caller's options is flagged", async () => {
		const source = `${K3_WRAPPER}\nspawnPs(cmd, args, { label: "ps-cwd", timeoutMs: 1000 });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, 'label: "ps-cwd"', "spawnPs")]);
	});

	it("f-optsparam-caller-argsarray · P4: cwd only in the caller's args array is flagged", async () => {
		const source = `${K3_WRAPPER}\nspawnPs(cmd, ["-File", path.resolve(cwd, f)], { timeoutMs: 1000 });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "path.resolve(cwd, f)", "spawnPs")]);
	});

	it("f-optsparam-caller-envpwd · P5: cwd in another key's value is flagged", async () => {
		const source = `${K3_WRAPPER}\nspawnPs(cmd, args, { env: { PWD: cwd }, timeoutMs: 1000 });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "env: { PWD: cwd }", "spawnPs")]);
	});

	it("f-optsparam-caller-bare · P6/P7: a caller supplying no options is flagged", async () => {
		const source = `${K3_WRAPPER}\nspawnPs(cmd, args);`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "spawnPs(cmd, args);", "spawnPs")]);
	});
});

// ── K4 · wrapper with a POSITIONAL cwd parameter (round 2 F2's blind spot) ──

/** `helm-lint.ts`'s `lintChart(chartRoot, cwd)` in shape. Round 2's rule — "a
 * parameter list containing a `{…}` naming cwd" — does not match this
 * declaration at all, so its callers were never checked and swapping `ctx.cwd`
 * for `process.cwd()` left the sweep green. */
const K4_WRAPPER = `
	async function lintChart(chartRoot: string, cwd: string) {
		return safeSpawnAsync("helm", ["lint", chartRoot], { cwd, timeout: 60000 });
	}
`;

describe("K4 — a wrapper with a positional cwd parameter", () => {
	it("f-positional-caller-ctxcwd · P1: a cwd-bearing argument at the cwd index passes", async () => {
		const { flagged, wrappers } = await analyze(
			`${K4_WRAPPER}\nlintChart(chartRoot, ctx.cwd);`,
		);
		expect(wrappers).toEqual(["lintChart:positional@1"]);
		expect(flagged).toEqual([]);
	});

	it("f-positional-caller-processcwd · P5: `process.cwd()` at the cwd index is flagged", async () => {
		// The reviewer's round-2 probe, verbatim: #2691's own defect
		// reintroduced at a live call site, with the round-2 sweep green.
		const source = `${K4_WRAPPER}\nlintChart(chartRoot, process.cwd());`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "process.cwd()", "lintChart")]);
	});

	it("f-positional-caller-comment · P2: a comment naming cwd at the slot is flagged", async () => {
		const source = `${K4_WRAPPER}\nlintChart(chartRoot, /* the cwd */ workspaceRoot);`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "/* the cwd */", "lintChart")]);
	});

	it("f-positional-caller-string · P3: a string naming cwd at the slot is flagged", async () => {
		const source = `${K4_WRAPPER}\nlintChart(chartRoot, "the-cwd");`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, '"the-cwd"', "lintChart")]);
	});

	it("f-positional-caller-wrongslot · P4: a cwd-bearing argument at the WRONG index is flagged", async () => {
		const source = `${K4_WRAPPER}\nlintChart(ctx.cwd, workspaceRoot);`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "lintChart(ctx.cwd, workspaceRoot)", "lintChart"),
		]);
	});

	it("f-positional-caller-missing · P7: a caller too short to reach the cwd index is flagged", async () => {
		const source = `${K4_WRAPPER}\nlintChart(chartRoot);`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "lintChart(chartRoot);", "lintChart")]);
	});

	it("ignores a comment sitting in front of a good argument", async () => {
		// The comment filter in `namedParts` earns its place here: a grammar
		// comment is a NAMED child, so without it the comment would be counted
		// as argument 1 and this conforming call would be flagged.
		const { flagged } = await analyze(
			`${K4_WRAPPER}\nlintChart(chartRoot, /* the dispatch cwd */ ctx.cwd);`,
		);
		expect(flagged).toEqual([]);
	});

	it("keeps `cwd || process.cwd()` bearing — the canonical fallback is not the host cwd", async () => {
		const { flagged } = await analyze(
			`${K4_WRAPPER}\nlintChart(chartRoot, ctx.cwd || process.cwd());`,
		);
		expect(flagged).toEqual([]);
	});
});

// ── K5 · arrow / const-bound wrapper ────────────────────────────────────────

describe("K5 — a wrapper declared as `const x = async (…) => …`", () => {
	const wrapper = `
		const runTool = async (cmd: string, args: string[], cwd: string) =>
			safeSpawnAsync(cmd, args, { cwd, timeout: 1000 });
	`;

	it("f-arrow-caller-ok · P1: a cwd-bearing argument passes", async () => {
		const { flagged, wrappers } = await analyze(
			`${wrapper}\nrunTool("tool", [], ctx.cwd);`,
		);
		expect(wrappers).toEqual(["runTool:positional@2"]);
		expect(flagged).toEqual([]);
	});

	it("f-arrow-caller-comment · P2: a comment at the slot is flagged", async () => {
		const source = `${wrapper}\nrunTool("tool", [], /* cwd */ repoRoot);`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "/* cwd */", "runTool")]);
	});

	it("f-arrow-caller-bare · P6/P7: a caller too short to reach the slot is flagged", async () => {
		const source = `${wrapper}\nrunTool("tool", []);`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, 'runTool("tool", []);', "runTool")]);
	});
});

// ── K6 · method / object-literal property wrapper ───────────────────────────

describe("K6 — a wrapper declared as an object method", () => {
	const wrapper = `
		const tools = {
			async spawnTool(cmd: string, cwd: string) {
				return safeSpawnAsync(cmd, [], { cwd, timeout: 1000 });
			},
		};
	`;

	it("f-method-caller-ok · P1: a cwd-bearing argument passes", async () => {
		const { flagged, wrappers } = await analyze(
			`${wrapper}\ntools.spawnTool("tool", ctx.cwd);`,
		);
		expect(wrappers).toEqual(["spawnTool:positional@1"]);
		expect(flagged).toEqual([]);
	});

	it("f-method-caller-comment · P2: a comment at the slot is flagged", async () => {
		const source = `${wrapper}\ntools.spawnTool("tool", /* cwd */ repoRoot);`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "/* cwd */", "spawnTool")]);
	});

	it("f-method-caller-bare · P6/P7: a caller too short to reach the slot is flagged", async () => {
		const source = `${wrapper}\ntools.spawnTool("tool");`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, 'tools.spawnTool("tool");', "spawnTool"),
		]);
	});
});

// ── K7 · probe closure fed by createCwdCachedProbe ──────────────────────────

describe("K7 — a probe closure fed by createCwdCachedProbe", () => {
	it("f-cwdcached-closure: the factory is NOT followed, and its callers are not checked", async () => {
		// `eslint.ts`'s `makeEslintProbe`, in shape. The innermost binder of the
		// spawn's `cwd` is the ANONYMOUS arrow that `createCwdCachedProbe` invokes
		// per call — not `makeEslintProbe(cmd)`, whose only parameter is `cmd`.
		// Rounds 1 and 2 had to exclude six of these by hand, in prose, because a
		// text scan cannot see a scope.
		const source = `
			function makeEslintProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 3000, cwd }),
					{ tool: "eslint", budgetMs: 3000 },
				);
			}
			const created = makeEslintProbe(cmd);
			const again = makeEslintProbe(otherCmd);
		`;
		const { flagged, wrappers, sites } = await analyze(source);
		expect(wrappers).toEqual([]);
		expect(sites).toEqual([
			`${at(source, "(cwd) => safeSpawnAsync(", "safeSpawnAsync")}:direct`,
		]);
		expect(flagged).toEqual([]);
	});
});

// ── K8 / K9 · options the scan cannot read through ──────────────────────────

describe("K8/K9 — an options object the scan cannot prove", () => {
	it("f-spread-only · K8/P7: a spread-only options object is flagged (fail-safe)", async () => {
		const source = `
			async function run(ctx, rest) {
				await safeSpawnAsync("tool", [], { ...rest });
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "{ ...rest }", "safeSpawnAsync")]);
	});

	it("f-spread-plus-key · K8/P1: an explicit `cwd` next to the spread passes", async () => {
		const { flagged } = await analyze(`
			async function run(ctx, rest) {
				await safeSpawnAsync("tool", [], { ...rest, cwd: ctx.cwd });
			}
		`);
		expect(flagged).toEqual([]);
	});

	it("f-opaque-options-ident · K9/P7: an opaque identifier as the options argument is flagged (fail-safe)", async () => {
		const source = `
			async function run(ctx, opts) {
				await safeSpawnAsync("tool", [], opts);
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});
});

// ── K10 · the exemption tag ─────────────────────────────────────────────────

describe("K10 — `// cwd-exempt:` tags", () => {
	it("f-exempt-absent: a tagged cwd-less site is exempt, not flagged", async () => {
		const { flagged } = await analyze(`
			async function probe() {
				// cwd-exempt: presence probe only -- no target file and no config to resolve
				await safeSpawnAsync("cl", [], { timeout: 5000 });
			}
		`);
		expect(flagged).toEqual([]);
	});

	it("f-exempt-comment: the tag must be the line DIRECTLY above the call", async () => {
		const source = `
			async function probe() {
				// cwd-exempt: presence probe only -- no target file and no config to resolve
				// (an explanatory line that displaces the tag)
				await safeSpawnAsync("cl", [], { timeout: 5000 });
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-exempt-redundant: a tag above a site that DOES pass cwd is reported as redundant", async () => {
		const source = `
			async function probe(cwd) {
				// cwd-exempt: presence probe only -- no target file and no config to resolve
				await safeSpawnAsync("cl", [], { timeout: 5000, cwd });
			}
		`;
		const { flagged, redundantExemptions } = await analyze(source);
		expect(flagged).toEqual([]);
		expect(redundantExemptions).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-exempt-thin-reason: a tag's reason text is carried through for the length gate", async () => {
		const scan = await scanSpawnCwd(
			"fixture.ts",
			`
			async function probe() {
				// cwd-exempt: no
				await safeSpawnAsync("cl", [], { timeout: 5000 });
			}
		`,
		);
		expect(scan.sites.map((s) => s.exemptReason)).toEqual(["no"]);
	});

	it("exempts a WRAPPER call site by the tag above the wrapper call, not the spawn", async () => {
		// psscriptanalyzer.ts's two `-Command` presence probes: the spawn lives
		// inside `spawnPs` and always names cwd, so the tag has to bind to the
		// caller's line or the exemption would be unexpressible.
		const { flagged } = await analyze(`${K3_WRAPPER}
			// cwd-exempt: global interpreter-presence probe, not tied to any project
			spawnPs(cmd, ["-Command", "exit 0"], { timeoutMs: 1000 });
		`);
		expect(flagged).toEqual([]);
	});
});

// ── Cross-cutting properties of the wrapper rule ────────────────────────────

describe("the wrapper rule itself", () => {
	it("follows a wrapper wrapping a wrapper (fixed point) — wrapping is not an escape", async () => {
		const source = `${K4_WRAPPER}
			async function lintNearestChart(root: string, cwd: string) {
				return lintChart(root, cwd);
			}
			lintNearestChart(chartRoot, process.cwd());
		`;
		const { flagged, wrappers } = await analyze(source);
		expect(wrappers).toEqual([
			"lintChart:positional@1",
			"lintNearestChart:positional@1",
		]);
		expect(flagged).toEqual([
			at(
				source,
				"lintNearestChart(chartRoot, process.cwd())",
				"lintNearestChart",
			),
		]);
	});

	it("does NOT treat a runner's `run(ctx)` as a cwd wrapper", async () => {
		// `ctx` is a dispatch context, not a cwd. If `ctx.cwd` counted as
		// "parameter 0 is the cwd", every in-file `run(ctx)` call would be flagged
		// for not passing a cwd — exactly backwards.
		const { flagged, wrappers } = await analyze(`
			const runner = {
				async run(ctx) {
					await safeSpawnAsync("tool", [], { cwd: ctx.cwd, timeout: 1000 });
				},
			};
			runner.run(ctx);
		`);
		expect(wrappers).toEqual([]);
		expect(flagged).toEqual([]);
	});

	it("reports the wrapper's own spawn once, as a direct site", async () => {
		const source = `${K4_WRAPPER}\nlintChart(chartRoot, ctx.cwd);`;
		const { sites } = await analyze(source);
		expect(sites).toEqual([
			`${at(source, 'return safeSpawnAsync("helm"', "safeSpawnAsync")}:direct`,
			`${at(source, "lintChart(chartRoot, ctx.cwd);", "lintChart")}:wrapper`,
		]);
	});
});
