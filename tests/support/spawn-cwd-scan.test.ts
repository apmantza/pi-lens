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

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { loadAstGrepNapi } from "../../clients/deps/ast-grep-napi.js";
import { scanSpawnCwd } from "./spawn-cwd-scan.js";

/** What the sweep itself asks of a scan, in a form a fixture can assert. */
async function analyze(source: string): Promise<{
	flagged: string[];
	wrappers: string[];
	redundantExemptions: string[];
	sites: string[];
}> {
	// Inline fixtures use the real seam-shaped import so the scanner never
	// falls back to a resolver name. Keep the deliberate local-function and
	// foreign-import probes untouched.
	if (
		!/^\s*import\b/m.test(source) &&
		!/^\s*function\s+resolve(?:Tool|Runner|Formatter)Cwd\b/m.test(source)
	) {
		source = `${source}\nimport { resolveToolCwd } from "./tool-cwd.js";`;
	}
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
	it("resolves the innermost dominating block binding", async () => {
		const source = `import { resolveToolCwd } from "./tool-cwd.js";
			async function run(ctx) {
				const cwd = resolveToolCwd("runner", "tool", file, ctx);
				await safeSpawnAsync("good", [], { cwd });
				{ const cwd = ctx.cwd; await safeSpawnAsync("bad", [], { cwd }); }
			}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites.map((site) => site.resolvedFromToolCwd)).toEqual([
			true,
			false,
		]);
	});

	it("keeps the later resolver binding when the block appears first", async () => {
		const source = `import { resolveToolCwd } from "./tool-cwd.js";
			async function run(ctx) {
				{ const cwd = ctx.cwd; await safeSpawnAsync("bad", [], { cwd }); }
				const cwd = resolveToolCwd("runner", "tool", file, ctx);
				await safeSpawnAsync("good", [], { cwd });
			}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites.map((site) => site.resolvedFromToolCwd)).toEqual([
			false,
			true,
		]);
	});

	it("rejects a resolver binding after reassignment", async () => {
		const source = `import { resolveToolCwd } from "./tool-cwd.js";
			async function run(ctx) {
				let cwd = resolveToolCwd("runner", "tool", file, ctx);
				cwd = ctx.cwd;
				await safeSpawnAsync("bad", [], { cwd });
			}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites[0].resolvedFromToolCwd).toBe(false);
	});

	it("rejects a file-local resolver with the seam name", async () => {
		const source = `function resolveToolCwd() { return ctx.cwd; }
			async function run() { await safeSpawnAsync("bad", [], { cwd: resolveToolCwd() }); }`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites[0].resolvedFromToolCwd).toBe(false);
	});

	it("rejects a same-named resolver imported from a foreign module", async () => {
		const source = `import { resolveToolCwd } from "./my-helpers.js";
			import { safeSpawnAsync } from "../../safe-spawn.js";
			async function run(ctx) {
				await safeSpawnAsync("bad", [], { cwd: resolveToolCwd(ctx) });
			}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites[0].resolvedFromToolCwd).toBe(false);
	});

	it("does not let a closed sibling block launder a function binding", async () => {
		const source = `import { resolveToolCwd } from "./tool-cwd.js";
			async function run(ctx) {
				const cwd = resolveToolCwd("runner", "tool", file, ctx);
				if (ctx.fast) { const cwd = ctx.cwd; await safeSpawnAsync("bad", [], { cwd }); }
				await safeSpawnAsync("good", [], { cwd });
			}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites.map((site) => site.resolvedFromToolCwd)).toEqual([
			false,
			true,
		]);
	});

	it("does not let a for-body binding poison the outer site", async () => {
		const source = `import { resolveToolCwd } from "./tool-cwd.js";
			async function run(ctx, files) {
				const cwd = resolveToolCwd("runner", "tool", file, ctx);
				for (const f of files) { const cwd = f.dir; await safeSpawnAsync("bad", [], { cwd }); }
				await safeSpawnAsync("good", [], { cwd });
			}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites.map((site) => site.resolvedFromToolCwd)).toEqual([
			false,
			true,
		]);
	});

	it("requires resolver origin, including a local binding and object spread", async () => {
		const source = `import { resolveToolCwd } from "./tool-cwd.js";
			const dir = resolveToolCwd("runner", "tool", file, ctx);
			const options = { cwd: dir, timeout: 1000 };
			await safeSpawn("tool", [], { ...options });
		`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites).toHaveLength(1);
		expect(scan.sites[0].resolvedFromToolCwd).toBe(true);
	});

	it("rejects ctx.cwd, process.cwd(), and a shorthand parameter as origins", async () => {
		const sources = [
			`async function run(ctx) { await safeSpawn("tool", [], { cwd: ctx.cwd }); }`,
			`async function run() { await safeSpawn("tool", [], { cwd: process.cwd() }); }`,
			`async function run(cwd) { await safeSpawn("tool", [], { cwd }); }`,
		];
		for (const source of sources) {
			const scan = await scanSpawnCwd("fixture.ts", source);
			expect(scan.sites[0].resolvedFromToolCwd).toBe(false);
		}
	});
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

	// ── P8 · what the `cwd` property CARRIES (round-4 R3-F1) ────────────────
	//
	// Rounds 1-3 decided the direct path on the KEY alone and never read the
	// value, so four worthless values all passed. Node's own semantics, as
	// measured by the round-3 verify: `undefined` and `null` make the child
	// INHERIT the host cwd, which is #2691 exactly; `""` is ENOENT, so the
	// lint never runs at all; and `process.cwd()` is the cheapest possible way
	// to turn a red sweep green (defect shape 38), while shape 40 says prefer
	// `ctx.cwd`.

	it("f-direct-value-undefined · P8: `cwd: undefined` is flagged (child inherits the host cwd)", async () => {
		const source = `
			async function run(ctx) {
				await safeSpawnAsync("yamllint", [], { cwd: undefined, timeout: 15000 });
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-direct-value-null · P8: `cwd: null` is flagged (same inheritance)", async () => {
		const source = `
			async function run(ctx) {
				await safeSpawnAsync("yamllint", [], { cwd: null, timeout: 15000 });
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it('f-direct-value-empty-string · P8: `cwd: ""` is flagged (ENOENT, the lint never runs)', async () => {
		const source = `
			async function run(ctx) {
				await safeSpawnAsync("yamllint", [], { cwd: "", timeout: 15000 });
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-direct-value-processcwd · P8: `cwd: process.cwd()` is flagged (the cheapest red-to-green edit)", async () => {
		const source = `
			async function run(ctx) {
				await safeSpawnAsync("yamllint", [], { cwd: process.cwd(), timeout: 15000 });
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-direct-value-laundered-const · P8: `cwd: hostCwd` with `const hostCwd = process.cwd()` is flagged", async () => {
		const source = `
			async function run(ctx) {
				const hostCwd = process.cwd();
				await safeSpawnAsync("yamllint", [], { cwd: hostCwd, timeout: 15000 });
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-direct-value-shorthand-laundered · P8: `{ cwd }` with `const cwd = process.cwd()` is flagged", async () => {
		// The shorthand spelling of the same laundering. The CANONICAL
		// `const cwd = ctx.cwd || process.cwd()` (f-direct-key above) still
		// passes: it is a binary expression, not the host cwd.
		const source = `
			async function run(ctx) {
				const cwd = process.cwd();
				await safeSpawnAsync("yamllint", [], { cwd, timeout: 15000 });
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
	});

	it("f-direct-value-other · P8: any other value passes — the KEY already declares the intent", async () => {
		// Deliberately NOT `isCwdBearingExpression`: on the direct path the key
		// `cwd:` states what the value is for, so the value's own NAME carries no
		// extra information and `cwd: resolvedRoot` must not be flagged. The
		// positional-wrapper path has no key, which is why it does read the name.
		const { flagged } = await analyze(`
			async function run(ctx, resolvedRoot) {
				await safeSpawnAsync("yamllint", [], { cwd: resolvedRoot, timeout: 15000 });
			}
		`);
		expect(flagged).toEqual([]);
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

	// P8 for the options-mode wrapper path (round-4 R3-F1). `argumentHasCwdKey`
	// was the sibling key-only acceptance the round-3 verify found; probe A10 is
	// `spawnPs(…, { cwd: undefined })`.
	it("f-optsparam-caller-value-undefined · P8: a caller passing `{ cwd: undefined }` is flagged", async () => {
		const source = `${K3_WRAPPER}\nspawnPs(cmd, args, { timeoutMs: 1000, cwd: undefined });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "cwd: undefined", "spawnPs")]);
	});

	it("f-optsparam-caller-value-null · P8: a caller passing `{ cwd: null }` is flagged", async () => {
		const source = `${K3_WRAPPER}\nspawnPs(cmd, args, { timeoutMs: 1000, cwd: null });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "cwd: null", "spawnPs")]);
	});

	it('f-optsparam-caller-value-empty-string · P8: a caller passing `{ cwd: "" }` is flagged', async () => {
		const source = `${K3_WRAPPER}\nspawnPs(cmd, args, { timeoutMs: 1000, cwd: "" });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, 'cwd: ""', "spawnPs")]);
	});

	it("f-optsparam-caller-value-processcwd · P8: a caller passing `{ cwd: process.cwd() }` is flagged", async () => {
		const source = `${K3_WRAPPER}\nspawnPs(cmd, args, { timeoutMs: 1000, cwd: process.cwd() });`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([at(source, "cwd: process.cwd()", "spawnPs")]);
	});

	it("f-optsparam-caller-value-other · P8: any other value passes", async () => {
		const { flagged } = await analyze(
			`${K3_WRAPPER}\nspawnPs(cmd, args, { timeoutMs: 1000, cwd: resolvedRoot });`,
		);
		expect(flagged).toEqual([]);
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

	it("f-positional-caller-hostcwd-const · R3-F4: a cwd-NAMED local holding process.cwd() is flagged", async () => {
		// `/cwd/i` on the identifier text alone reads `hostCwd` as conforming.
		// One hop through the same-scope `const` initializer is what makes the
		// laundering visible.
		const source = `${K4_WRAPPER}
			async function run(ctx) {
				const hostCwd = process.cwd();
				return lintChart(chartRoot, hostCwd);
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "lintChart(chartRoot, hostCwd)", "lintChart"),
		]);
	});

	it("f-positional-caller-alias-const · R3-F4: a NON-cwd-named local holding ctx.cwd passes", async () => {
		// The same hop in the other direction: without it `c` fails the name test
		// and a conforming call is flagged.
		const { flagged } = await analyze(`${K4_WRAPPER}
			async function run(ctx) {
				const c = ctx.cwd;
				return lintChart(chartRoot, c);
			}
		`);
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

	it("f-funcexpr-caller-ok: the same rule reads a `const w = async function (…)` form", async () => {
		// `functionName`'s variable-declarator branch has to name an anonymous
		// FUNCTION EXPRESSION as well as an arrow, or the wrapper is invisible
		// under a spelling change alone (AGENTS.md shape 34).
		const wrapper = `
			const runTool = async function (cmd: string, args: string[], cwd: string) {
				return safeSpawnAsync(cmd, args, { cwd, timeout: 1000 });
			};
		`;
		const source = `${wrapper}\nrunTool("tool", [], process.cwd());`;
		const { flagged, wrappers } = await analyze(source);
		expect(wrappers).toEqual(["runTool:positional@2"]);
		expect(flagged).toEqual([at(source, "process.cwd()", "runTool")]);
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

	it("f-exempt-thin-reason: a tag with no real reason exempts nothing", async () => {
		// The admission has to cost something (defect shape 38): a bare tag is a
		// one-line data edit that would otherwise buy a permanent pass.
		const source = `
			async function probe() {
				// cwd-exempt: no
				await safeSpawnAsync("cl", [], { timeout: 5000 });
			}
		`;
		const { flagged } = await analyze(source);
		expect(flagged).toEqual([
			at(source, "await safeSpawnAsync(", "safeSpawnAsync"),
		]);
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

	it("keeps following at depth three — the fixed point iterates, it does not do one pass", async () => {
		// Without the iteration, `lintForDispatch` is never reached: the direct
		// scan finds `lintChart`, one pass finds `lintNearestChart`, and the
		// third hop is where a laundered `process.cwd()` would go free.
		const source = `${K4_WRAPPER}
			async function lintNearestChart(root: string, cwd: string) {
				return lintChart(root, cwd);
			}
			async function lintForDispatch(root: string, cwd: string) {
				return lintNearestChart(root, cwd);
			}
			lintForDispatch(chartRoot, process.cwd());
		`;
		const { flagged, wrappers } = await analyze(source);
		expect(wrappers).toEqual([
			"lintChart:positional@1",
			"lintForDispatch:positional@1",
			"lintNearestChart:positional@1",
		]);
		expect(flagged).toEqual([
			at(
				source,
				"lintForDispatch(chartRoot, process.cwd())",
				"lintForDispatch",
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

// ── S — lexical scope, enumerated from the grammar ──────────────────────────

/**
 * ## Why this table is generated and not written
 *
 * Three rounds of this detector resolved a `cwd` identifier against a
 * hand-written list of scope-opening node kinds — "the enclosing function"
 * (r1), then "a function or a `statement_block`" (r2, r3). Each round closed
 * the launderer the review had shown it and shipped with the next one open:
 * the verify at `6f09c4cc5` moved yamllint's real spawn onto `ctx.cwd`, put
 * the good binding in a dead `switch` case, and the sweep stayed green. Adding
 * `switch_body` to the list would be the fourth spelling of one mistake
 * (AGENTS.md defect shape 34).
 *
 * So the list comes from the grammar. `@ast-grep/napi` ships the tree-sitter
 * `node-types` table for every language it bundles —
 * `node_modules/@ast-grep/napi/lang/TypeScript.d.ts`, whose first line reads
 * "Auto-generated from tree-sitter TypeScript v0.23.2". Every node type whose
 * fields or children can hold a `lexical_declaration` / `variable_declaration`
 * (directly, or through the `declaration` / `statement` supertypes) is a node
 * that can OWN a declaration, and therefore a scope boundary the resolver has
 * to get right. {@link declarationOwnerKindsFromGrammar} recomputes that set
 * on every run; {@link SCOPE_CASES} must carry a fixture for each member, and
 * the first test below fails if the two ever diverge — a grammar bump that
 * adds a scope-owning node type reds HERE, with the kind named, instead of
 * quietly opening the hole round 4 was sent to close.
 *
 * Recurrence this guards: PR #2877 review v3 F1 — a declarator inside a closed
 * `switch` case or a `for` head laundered the binding a later spawn actually
 * used.
 */
const GRAMMAR_NODE_TYPES_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../node_modules/@ast-grep/napi/lang/TypeScript.d.ts",
);

interface GrammarSlot {
	types?: { type: string; named: boolean }[];
}
interface GrammarNodeType {
	subtypes?: { type: string; named: boolean }[];
	fields?: Record<string, GrammarSlot>;
	children?: GrammarSlot;
}

/** Every node type the TypeScript grammar lets own a declaration statement. */
function declarationOwnerKindsFromGrammar(): string[] {
	const raw = fs.readFileSync(GRAMMAR_NODE_TYPES_PATH, "utf8");
	const types = JSON.parse(
		raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
	) as Record<string, GrammarNodeType>;
	// Close over supertypes: a slot that accepts `statement` accepts a
	// `lexical_declaration`, and the grammar spells that indirection out.
	const declarationTypes = new Set([
		"lexical_declaration",
		"variable_declaration",
	]);
	for (let grew = true; grew;) {
		grew = false;
		for (const [kind, node] of Object.entries(types)) {
			if (declarationTypes.has(kind)) continue;
			if ((node.subtypes ?? []).some((sub) => declarationTypes.has(sub.type))) {
				declarationTypes.add(kind);
				grew = true;
			}
		}
	}
	const owners: string[] = [];
	for (const [kind, node] of Object.entries(types)) {
		if (node.subtypes) continue; // a supertype alias, never a real node
		const slots = [node.children, ...Object.values(node.fields ?? {})];
		const ownsDeclaration = slots.some((slot) =>
			(slot?.types ?? []).some((type) => declarationTypes.has(type.type)),
		);
		if (ownsDeclaration) owners.push(kind);
	}
	return owners.sort();
}

/** The node kinds that actually own a declaration in this fixture, read off
 * the parse — so a row cannot claim to exercise `switch_case` while its
 * source produces a plain block. */
async function declarationOwnerKindsIn(source: string): Promise<string[]> {
	const napi = await loadAstGrepNapi();
	const root = napi.parse(napi.Lang.TypeScript, source).root();
	const kinds = new Set<string>();
	const visit = (node: SgNode): void => {
		const kind = String(node.kind());
		if (kind === "lexical_declaration" || kind === "variable_declaration") {
			kinds.add(String(node.parent()?.kind() ?? "program"));
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return [...kinds];
}

async function verdicts(source: string): Promise<string[]> {
	const scan = await scanSpawnCwd("fixture.ts", source);
	return scan.sites.map(
		(site) => `hasCwd=${site.hasCwd} resolved=${site.resolvedFromToolCwd}`,
	);
}

const SEAM = `import { resolveToolCwd } from "./tool-cwd.js";`;
const GOOD = `resolveToolCwd("runner", "tool", file, ctx)`;

interface ScopeCase {
	/** The grammar node type that owns the shadow/hoisted declaration. */
	owner: string;
	what: string;
	source: string;
	/** One entry per site, in source order. */
	expected: string[];
}

/**
 * Two shapes, one per declaration form, because `const`/`let` and `var` are
 * scoped differently and only one of them can be laundered:
 *
 * - **lexical owners** (`const`/`let`) take the LAUNDERER shape: the outer
 *   binding is the #2691 defect (`ctx.cwd`), the good binding sits inside the
 *   owner, and the spawn reads the outer one after the owner has closed. A
 *   resolver that treats the owner as transparent reports `resolved=true` and
 *   the sweep goes green on the defect — that is the bug this round fixes, so
 *   every one of these rows reds on the pre-fix scanner.
 * - **`var` owners** (`if (c) var cwd = …`, and the other bare-body
 *   statements: a `const` there is a syntax error) take the HOISTED shape:
 *   `var` is function-scoped, so the binding IS visible at the later spawn and
 *   the honest verdict is `true`. The discriminating direction for these rows
 *   is exactly that: a resolver that scoped the `var` to its owner node would
 *   report `false` and false-red a legitimate seam use.
 */
const SCOPE_CASES: ScopeCase[] = [
	{
		owner: "statement_block",
		what: "a closed sibling block cannot launder the binding the spawn reads",
		source: `${SEAM}
async function run(ctx) {
	const cwd = ctx.cwd;
	{ const cwd = ${GOOD}; void cwd; }
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=false"],
	},
	{
		owner: "for_statement",
		what: "a `for` head's binding dies with the loop",
		source: `${SEAM}
async function run(ctx) {
	const cwd = ctx.cwd;
	for (let cwd = ${GOOD}; false; ) { void cwd; }
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=false"],
	},
	{
		owner: "switch_case",
		what: "a dead `case`'s binding does not reach the spawn below the switch",
		source: `${SEAM}
async function run(ctx) {
	const cwd = ctx.cwd;
	switch (ctx.k) { case 1: const cwd = ${GOOD}; break; }
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=false"],
	},
	{
		owner: "switch_default",
		what: "same for `default:`",
		source: `${SEAM}
async function run(ctx) {
	const cwd = ctx.cwd;
	switch (ctx.k) { default: const cwd = ${GOOD}; }
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=false"],
	},
	{
		owner: "switch_case",
		what: "a binding from an earlier case IS visible in a later one — JS scopes case declarations to the whole switch body",
		source: `${SEAM}
async function run(ctx) {
	switch (ctx.k) {
		case 1:
			const cwd = ${GOOD};
			void cwd;
		case 2:
			await safeSpawnAsync("b", [], { cwd });
	}
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "statement_block",
		what: "a spawn ABOVE the good declaration does not read it (temporal dead zone)",
		source: `${SEAM}
async function run(ctx) {
	await safeSpawnAsync("b", [], { cwd });
	const cwd = ${GOOD};
	void cwd;
}`,
		expected: ["hasCwd=true resolved=false"],
	},
	{
		owner: "statement_block",
		what: "two `var` declarations of one name in one scope prove nothing",
		source: `${SEAM}
async function run(ctx) {
	if (ctx.fast) { var cwd = ctx.cwd; } else { var cwd = ${GOOD}; }
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=false resolved=false"],
	},
	{
		owner: "program",
		what: "a module-level binding reaches into every function below it",
		source: `${SEAM}
const cwd = ${GOOD};
async function run(ctx) {
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "export_statement",
		what: "`export` wraps a declaration without scoping it",
		source: `${SEAM}
export const cwd = ${GOOD};
async function run(ctx) {
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "ambient_declaration",
		what: "`declare const` has no initializer, so it supplies no usable cwd",
		source: `${SEAM}
declare const cwd: string;
async function run(ctx) {
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=false resolved=false"],
	},
	{
		owner: "if_statement",
		what: "a hoisted `var` in a bare consequence is visible after it",
		source: `${SEAM}
async function run(ctx) {
	if (ctx.fast) var cwd = ${GOOD};
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "else_clause",
		what: "same for a bare `else`",
		source: `${SEAM}
async function run(ctx) {
	if (ctx.fast) { void 0; } else var cwd = ${GOOD};
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "while_statement",
		what: "same for a bare `while` body",
		source: `${SEAM}
async function run(ctx) {
	while (ctx.fast) var cwd = ${GOOD};
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "do_statement",
		what: "same for a bare `do` body",
		source: `${SEAM}
async function run(ctx) {
	do var cwd = ${GOOD}; while (false);
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "for_in_statement",
		what: "same for a bare `for…of` body",
		source: `${SEAM}
async function run(ctx, files) {
	for (const f of files) var cwd = ${GOOD};
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "labeled_statement",
		what: "same under a label",
		source: `${SEAM}
async function run(ctx) {
	outer: var cwd = ${GOOD};
	await safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "with_statement",
		what: "same inside `with` (illegal in a module, still in the grammar)",
		source: `${SEAM}
function run(ctx) {
	with (ctx) var cwd = ${GOOD};
	return safeSpawnAsync("b", [], { cwd });
}`,
		expected: ["hasCwd=true resolved=true"],
	},
];

describe("S — every scope node type the grammar can produce", () => {
	it("has a fixture for every declaration owner in the grammar's node types", () => {
		const fromGrammar = declarationOwnerKindsFromGrammar();
		expect(
			fromGrammar.length,
			`no declaration owners parsed out of ${GRAMMAR_NODE_TYPES_PATH} — the ` +
				"generated node-type table moved or changed shape; fix this reader " +
				"before trusting anything below it",
		).toBeGreaterThan(5);
		expect(
			[...new Set(SCOPE_CASES.map((row) => row.owner))].sort(),
			"every node type that can own a declaration is a scope boundary the " +
				"resolver has to get right; give the new one a launderer fixture " +
				"(lexical) or a hoisted fixture (`var`-only body) in SCOPE_CASES",
		).toEqual(fromGrammar);
	});

	for (const row of SCOPE_CASES) {
		it(`S-${row.owner}: ${row.what}`, async () => {
			expect(
				await declarationOwnerKindsIn(row.source),
				`this fixture must really produce a declaration owned by ${row.owner}`,
			).toContain(row.owner);
			expect(await verdicts(row.source)).toEqual(row.expected);
		});
	}
});

/**
 * The other half of "which binding does this name refer to": constructs that
 * bind a name with no declaration statement, so the grammar's
 * declaration-owner table above cannot enumerate them. Each one SHADOWS an
 * outer binding, and the value it holds is not readable from the binding site
 * — so the origin rule must report "not proven", never inherit the outer
 * binding's proof. The fail-safe direction is built in: an unresolvable name
 * yields no initializer, and no initializer means no resolver origin.
 *
 * Recurrence: the same v3-F1 laundering, one construct over. `run(ctx)` opens
 * with `const cwd = resolveRunnerCwd(…)` in 44 runners, so ANY shadow inside
 * `run` inherits a proof it never earned.
 */
const SHADOW_CASES: ScopeCase[] = [
	{
		owner: "arrow parameter",
		what: "a callback parameter named cwd does not inherit the outer proof",
		source: `${SEAM}
async function run(ctx, withDir) {
	const cwd = ${GOOD};
	await withDir(ctx.cwd, async (cwd) => { await safeSpawnAsync("b", [], { cwd }); });
	void cwd;
}`,
		expected: ["hasCwd=true resolved=false"],
	},
	{
		owner: "catch parameter",
		what: "a catch binding shadows the outer one",
		source: `${SEAM}
async function run(ctx) {
	const cwd = ${GOOD};
	try { void cwd; } catch (cwd) { await safeSpawnAsync("b", [], { cwd }); }
}`,
		expected: ["hasCwd=true resolved=false"],
	},
	{
		owner: "for…of head",
		what: "a loop binding shadows the outer one inside the body",
		source: `${SEAM}
async function run(ctx, dirs) {
	const cwd = ${GOOD};
	for (const cwd of dirs) { await safeSpawnAsync("b", [], { cwd }); }
	void cwd;
}`,
		expected: ["hasCwd=true resolved=false"],
	},
	{
		owner: "destructuring pattern",
		what: "`const { cwd } = ctx` shadows the outer one with an unreadable value",
		source: `${SEAM}
async function run(ctx) {
	const cwd = ${GOOD};
	{ const { cwd } = ctx; await safeSpawnAsync("b", [], { cwd }); }
	void cwd;
}`,
		expected: ["hasCwd=true resolved=false"],
	},
	{
		owner: "nested function (no shadow)",
		what: "a closure that captures the outer binding keeps its proof",
		source: `${SEAM}
async function run(ctx) {
	const cwd = ${GOOD};
	const inner = async () => { await safeSpawnAsync("b", [], { cwd }); };
	await inner();
}`,
		expected: ["hasCwd=true resolved=true"],
	},
	{
		owner: "inner block (no shadow)",
		what: "a block that declares nothing keeps the enclosing proof",
		source: `${SEAM}
async function run(ctx) {
	const cwd = ${GOOD};
	if (ctx.fast) { await safeSpawnAsync("b", [], { cwd }); }
}`,
		expected: ["hasCwd=true resolved=true"],
	},
];

describe("S — bindings with no declaration statement", () => {
	for (const row of SHADOW_CASES) {
		it(`S-shadow-${row.owner}: ${row.what}`, async () => {
			expect(await verdicts(row.source)).toEqual(row.expected);
		});
	}
});

/**
 * `cwdLines` and `callLines` are what the live-tree sweep hashes into an
 * admission key, so their contract is asserted here rather than only through
 * the sweep. The recurrence: round 3's key hashed the `safeSpawnAsync(` line
 * alone, so an admitted site's cwd could be swapped for `ctx.cwd` with the row
 * still matching (v3-F2), and two spawns in one class method shared a key
 * (v3-F3).
 */
describe("the lines an admission key is derived from", () => {
	const lineOf = (source: string, needle: string): number =>
		source.split("\n").findIndex((line) => line.includes(needle)) + 1;

	it("covers the cwd property and the declaration of every local it hops through", async () => {
		const source = `${SEAM}
async function run(ctx) {
	const dir = ${GOOD};
	await safeSpawnAsync("t", [], {
		cwd: dir,
		timeout: 1000,
	});
}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites[0].cwdLines).toEqual([
			lineOf(source, "const dir ="),
			lineOf(source, "cwd: dir"),
		]);
	});

	it("reaches through a spread options local to the cwd inside it", async () => {
		const source = `${SEAM}
async function run(ctx) {
	const options = { cwd: ctx.cwd, timeout: 1000 };
	await safeSpawnAsync("t", [], { ...options });
}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites[0].cwdLines).toEqual([lineOf(source, "const options =")]);
	});

	it("spans the whole call, so two spawns differ by what they run", async () => {
		const source = `${SEAM}
async function run(ctx) {
	const cwd = ${GOOD};
	await safeSpawnAsync(
		"t",
		["--version"],
		{ cwd },
	);
}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites[0].callLines).toEqual([4, 5, 6, 7, 8]);
	});

	it("names the enclosing class and method, not the file's first declaration", async () => {
		const source = `${SEAM}
class Runner {
	async probe(ctx) {
		await safeSpawnAsync("t", ["--version"], { timeout: 1000 });
	}
}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites[0].symbol).toBe("Runner.probe");
		expect(scan.sites[0].cwdLines).toEqual([]);
	});
});

/**
 * ## R — rebinding, in every shape the grammar allows
 *
 * Round 4 asked "was this binding reassigned before the use?" with
 * `left.text() === name`, which is one spelling of five: `({ cwd } = ctx)`,
 * `({ dir: cwd } = ctx)`, `[cwd] = […]`, `(cwd) = ctx.cwd` and
 * `for (cwd of dirs)` all rebind the name, and the round-4 verify shipped the
 * literal #2691 defect into the real `yamllint.ts` through the first of them
 * with the sweep green. AGENTS.md defect shape 34 — a guard that enumerates
 * surface spellings — on the one axis round 4 did not rewrite.
 *
 * The rule is now structural: a rebinding is any assignment whose LEFT TARGET
 * BINDS the name (the pattern is walked, parentheses unwrapped), plus a
 * `for…of`/`for…in` head that assigns without declaring. Every row below must
 * come back unproven: the seam value is gone by the time the spawn runs.
 */
const REBINDING_CASES: { id: string; what: string; rebind: string }[] = [
	{ id: "R1", what: "plain assignment", rebind: "cwd = ctx.cwd;" },
	{ id: "R2", what: "object destructuring", rebind: "({ cwd } = ctx);" },
	{ id: "R3", what: "array destructuring", rebind: "[cwd] = [ctx.cwd];" },
	{
		id: "R4",
		what: "`for…of` head without a declaration",
		rebind: "for (cwd of dirs) { void cwd; }",
	},
	{
		id: "R5",
		what: "renamed object destructuring",
		rebind: "({ dir: cwd } = ctx);",
	},
	{ id: "R6", what: "compound assignment", rebind: 'cwd += "/nested";' },
	{
		id: "R7",
		what: "assignment inside a closure",
		rebind: "(() => { cwd = ctx.cwd; })();",
	},
	{
		id: "R8",
		what: "assignment inside a block",
		rebind: "if (ctx.fast) { cwd = ctx.cwd; }",
	},
	{ id: "R9", what: "parenthesised target", rebind: "(cwd) = ctx.cwd;" },
	{
		id: "R10",
		what: "assignment inside a switch case",
		rebind: "switch (ctx.k) { case 1: cwd = ctx.cwd; }",
	},
];

describe("R — a rebinding before the use, whatever shape it takes", () => {
	for (const row of REBINDING_CASES) {
		it(`${row.id}: ${row.what} leaves the binding unproven`, async () => {
			const source = `${SEAM}
async function run(ctx, dirs) {
	let cwd = ${GOOD};
	${row.rebind}
	await safeSpawnAsync("b", [], { cwd });
}`;
			expect(await verdicts(source)).toEqual(["hasCwd=false resolved=false"]);
		});
	}

	it("a write to a PROPERTY is not a rebinding", async () => {
		// `o.cwd = …` changes an object, not the local the spawn reads.
		const source = `${SEAM}
async function run(ctx, o) {
	const cwd = ${GOOD};
	o.cwd = ctx.cwd;
	await safeSpawnAsync("b", [], { cwd });
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=true"]);
	});

	it("a straight-line rebinding AFTER the use leaves the binding unproven", async () => {
		const source = `${SEAM}
async function run(ctx) {
	let cwd = ${GOOD};
	await safeSpawnAsync("b", [], { cwd });
	({ cwd } = ctx);
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=false resolved=false"]);
	});

	it("R11: a retry-loop rebinding leaves the binding unproven", async () => {
		const source = `${SEAM}
async function run(ctx) {
		let cwd = ${GOOD};
		for (;;) {
			await safeSpawnAsync("b", [], { cwd });
			cwd = ctx.cwd;
		}
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=false resolved=false"]);
	});

	it("rejects a hoisted function rebinding declared below the spawn", async () => {
		const source = `${SEAM}
async function run(ctx) {
		let cwd = ${GOOD};
		await safeSpawnAsync("b", [], { cwd });
		bump();
		function bump() { cwd = ctx.cwd; }
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=false resolved=false"]);
	});
});

describe("a same-file function that returns the seam is a seam resolver", () => {
	it("follows a private method whose body returns resolveToolCwd (#2879)", async () => {
		// `clients/test-runner-client.ts` migrated onto the seam through
		// `private resolveSpawnCwd(…) { return resolveToolCwd(…) }`. Matching the
		// two known wrapper names by hand — round 4's rule — called that
		// conforming site non-seam on the merge result (round-5 v4-F2).
		const source = `${SEAM}
class Client {
	private resolveSpawnCwd(runner, file, root) {
		return resolveToolCwd("runner", runner, file, { cwd: root });
	}
	async run(ctx) {
		const spawnCwd = this.resolveSpawnCwd("vitest", ctx.filePath, ctx.cwd);
		await safeSpawnAsync("b", [], { cwd: spawnCwd });
	}
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=true"]);
	});

	it("does not follow a method that merely CALLS the seam", async () => {
		// Logging the resolver's answer is not returning it.
		const source = `${SEAM}
class Client {
	private resolveSpawnCwd(runner, file, root) {
		void resolveToolCwd("runner", runner, file, { cwd: root });
		return ctx.cwd;
	}
	async run(ctx) {
		const spawnCwd = this.resolveSpawnCwd("vitest", ctx.filePath, ctx.cwd);
		await safeSpawnAsync("b", [], { cwd: spawnCwd });
	}
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=false"]);
	});

	it("follows a plain function and an arrow with a concise body", async () => {
		const source = `${SEAM}
function resolveHere(ctx) {
	return resolveToolCwd("runner", "tool", ctx.filePath, { cwd: ctx.cwd });
}
const resolveThere = (ctx) =>
	resolveToolCwd("runner", "tool", ctx.filePath, { cwd: ctx.cwd });
async function run(ctx) {
	await safeSpawnAsync("a", [], { cwd: resolveHere(ctx) });
	await safeSpawnAsync("b", [], { cwd: resolveThere(ctx) });
}`;
		expect(await verdicts(source)).toEqual([
			"hasCwd=true resolved=true",
			"hasCwd=true resolved=true",
		]);
	});

	it("rejects a mixed-return resolver with an early host return", async () => {
		const source = `${SEAM}
function resolveHere(ctx, ready) {
		if (!ready) return process.cwd();
		return resolveToolCwd("runner", "tool", ctx.filePath, { cwd: ctx.cwd });
}
async function run(ctx) {
	await safeSpawnAsync("b", [], { cwd: resolveHere(ctx, true) });
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=false"]);
	});

	it("rejects a promoted resolver with a bare return", async () => {
		const source = `${SEAM}
function resolveHere(ctx, ready) {
		if (!ready) return;
		return resolveToolCwd("runner", "tool", ctx.filePath, { cwd: ctx.cwd });
}
async function run(ctx) {
	await safeSpawnAsync("b", [], { cwd: resolveHere(ctx, true) });
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=false"]);
	});

	it("rejects a promoted resolver with implicit fall-through", async () => {
		const source = `${SEAM}
function resolveHere(ctx, ready) {
		if (ready) return resolveToolCwd("runner", "tool", ctx.filePath, { cwd: ctx.cwd });
}
async function run(ctx) {
	await safeSpawnAsync("b", [], { cwd: resolveHere(ctx, true) });
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=false"]);
	});

	it("does not credit a same-named module function for a method resolver", async () => {
		const source = `${SEAM}
class Client {
		resolveSpawnCwd(ctx) {
			return resolveToolCwd("runner", "tool", ctx.filePath, { cwd: ctx.cwd });
		}
}
function resolveSpawnCwd(ctx) { return ctx.cwd; }
async function run(ctx) {
	await safeSpawnAsync("b", [], { cwd: resolveSpawnCwd(ctx) });
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=false"]);
	});
});

describe("round-5 scope and key residues", () => {
	it("N1: a class static block is a `var` boundary the owner table cannot name", async () => {
		// The static block's body is a plain `statement_block`, so the grammar's
		// declaration-owner table says "statement_block" and nothing marks the
		// block as a `var` scope. Round 4 credited the binding to the whole class
		// (round-5 v4-N1).
		const source = `${SEAM}
class Runner {
	static { var cwd = ${GOOD}; void cwd; }
	async run(ctx) {
		await safeSpawnAsync("b", [], { cwd });
	}
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=false"]);
	});

	it("F4: the key covers a local the cwd expression only READS", async () => {
		// `cwd: cargoToml.replace(…)` — round 4's key stopped at the call, so the
		// local could be repointed at `ctx.cwd` with the admission intact
		// (round-5 v4-F4).
		const source = `${SEAM}
async function run(ctx) {
	const cargoToml = findCargoToml(ctx.filePath);
	await safeSpawnAsync("t", [], { cwd: cargoToml.replace("Cargo.toml", "") });
}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		const lineOfText = (needle: string): number =>
			source.split("\n").findIndex((line) => line.includes(needle)) + 1;
		expect(scan.sites[0].cwdLines).toEqual([
			lineOfText("const cargoToml"),
			lineOfText("cwd: cargoToml.replace"),
		]);
	});
});

describe("node:child_process is a site only when the file imports it", () => {
	const CHILD_PROCESS = JSON.stringify("node:child_process");
	it("a method named `spawn` on some object is not a child spawn", async () => {
		// `clients/lsp/index.ts` calls `server.spawn(root, { allowInstall })` —
		// an LSP server definition's own method. Matching `spawn` by simple name
		// made that a phantom site the moment the population filter and the
		// scanner's name list were reconciled (round-5 v4-N3).
		const source = `${SEAM}
async function run(ctx, server) {
	await server.spawn(ctx.cwd, { allowInstall: true });
}`;
		const scan = await scanSpawnCwd("fixture.ts", source);
		expect(scan.sites).toEqual([]);
	});

	it("an unaliased `node:child_process` import makes it one", async () => {
		const source = `import { spawn } from "node:child_process";
${SEAM}
async function run(ctx) {
	spawn("tool", [], { cwd: ctx.cwd });
}`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=false"]);
	});

	const aliasedFixtures = [
		[
			"aliased named import",
			`import { spawn as s } from ${CHILD_PROCESS};\n${SEAM}\nfunction run(ctx) { s("tool", [], { cwd: ctx.cwd }); }`,
		],
		[
			"namespace import",
			`import * as cp from ${CHILD_PROCESS};\n${SEAM}\nfunction run(ctx) { cp.spawn("tool", [], { cwd: ctx.cwd }); }`,
		],
		[
			"default import",
			`import cp from ${CHILD_PROCESS};\n${SEAM}\nfunction run(ctx) { cp.exec("tool", { cwd: ctx.cwd }); }`,
		],
		[
			"dynamic destructuring",
			`async function run(ctx) { const { fork } = await import(${CHILD_PROCESS}); fork("tool", [], { cwd: ctx.cwd }); }\n${SEAM}`,
		],
		[
			"require namespace",
			`const cp = require(${CHILD_PROCESS});\n${SEAM}\nfunction run(ctx) { cp.execFile("tool", [], { cwd: ctx.cwd }); }`,
		],
	] as const;
	for (const [label, source] of aliasedFixtures) {
		it(`resolves ${label}`, async () => {
			expect(await verdicts(source)).toEqual(["hasCwd=true resolved=false"]);
		});
	}

	it("resolves a destructured require alias", async () => {
		const source = `const { spawn: s } = require(${CHILD_PROCESS});
${SEAM}
function run(ctx) { s("tool", [], { cwd: ctx.cwd }); }`;
		expect(await verdicts(source)).toEqual(["hasCwd=true resolved=false"]);
	});
});
