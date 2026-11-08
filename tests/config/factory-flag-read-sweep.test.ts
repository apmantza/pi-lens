/**
 * No flag read runs while the extension factory runs (#4913).
 *
 * RECURRENCE THIS PREVENTS: #4913. pi applies the command-line value of an
 * extension flag AFTER every factory has run, so `pi.getFlag` inside the
 * factory answers the registered default. `index.ts` read `no-lens`,
 * `no-lens-context`, `lens-compact-tool-line` and `--no-tool` at the factory's
 * top level and `pi --no-lens` started language servers. The detector, its
 * state table and its residual are in `tests/support/factory-flag-read-scan.ts`.
 *
 * Runtime observation of the host's order is `tests/index-4913-cli-flag-timing.test.ts`
 * (tier 2); this sweep is the source-level fence that keeps a NEW factory-time
 * read out, which a runtime case for the four known flags cannot (AGENTS.md
 * shape 33: a source scan is admitted where the population is "every read in
 * the factory", not four named flags).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type FactoryFlagAdmission,
	scanFactoryFlagReads,
} from "../support/factory-flag-read-scan.js";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const indexSource = fs.readFileSync(path.join(ROOT, "index.ts"), "utf-8");

/**
 * Refused sites the tree admits, each keyed `<function>:<binding>:<reader>:<form>`.
 * `count` is the number of sites the row admits: a key with more sites reds
 * every one of them, and a key with fewer reds as stale (#4917 F11).
 */
const ADMITTED: FactoryFlagAdmission = {
	"activateExtension:<top>:getLensFlag:assignment_expression": {
		count: 1,
		reason:
			"`_bridgeGetFlag = getLensFlag` stores the closure for the read/mutation/io bridges, which call it per event, never while the factory runs",
	},
	"activateExtension:enabledLazyTools:isToolEnabled:call": {
		count: 1,
		reason:
			"registration decides on the config tiers, which are readable at factory time; the CLI value reaches `applyToolSetPlan` and `pi_lens_activate_tools` through `isToolEnabled` at use",
	},
	"activateExtension:toolsToRegister:isToolEnabled:call": {
		count: 1,
		reason:
			"same registration filter as `enabledLazyTools`: config tiers at registration, the CLI value at session_start",
	},
	"activateExtension:alwaysActiveTools:getLensFlag:call": {
		count: 2,
		reason:
			"closures handed to the tool constructors (`createLensDiagnosticsTool`), which store them and call them per tool execution",
	},
	"activateExtension:lazyTools:getLensFlag:call": {
		count: 2,
		reason:
			"the closures handed to `createLspNavigationTool` and `createAstGrepReplaceTool` (#5417: its `no-autofix` refusal), which store them and call them per tool execution",
	},
	"activateExtension:<top>:pi:initI18n()": {
		count: 1,
		reason:
			"`initI18n` (i18n.ts) only calls `pi.events?.emit?.(..)` to register the bundle; it reads no flag",
	},
	"activateExtension:activateToolsTool:pi:createActivateToolsTool()": {
		count: 1,
		reason:
			"`createActivateToolsTool` (tools/activate-tools.ts) stores `pi` and calls `getActiveTools`/`setActiveTools` per tool execution",
	},
	"activateExtension:<top>:pi:.events": {
		count: 2,
		reason:
			"`pi.events` is the event bus handed to `wireAgentNudgeSubscriber`; it carries no flag value",
	},
	"createHostPorts:activeTools:pi:variable_declarator": {
		count: 1,
		reason:
			"a type-asserted alias whose `getActiveTools`/`setActiveTools` run only inside the ports' `tools.getActive`/`setActive` closures, at event time",
	},
	"createHostPorts:<top>:emit:pair-value": {
		count: 1,
		reason:
			"the ports table's `emit.bus` closure reads `pi.events` when a consumer emits, never while `createHostPorts` builds the table",
	},
	"createHostPorts:<top>:pi:.getFlag": {
		count: 1,
		reason:
			"the ports table's `flags.get` closure: its consumers call it at event time, never while `createHostPorts` builds the table",
	},
	"createHostPorts:<top>:pi:.getTool": {
		count: 1,
		reason:
			"the ports table's `tools.has` closure: it calls `getTool` when a consumer asks, at event time",
	},
};

/** A factory whose body is `body`, with the readers a real one has. */
function factory(body: string): string {
	return [
		"function activateExtension(pi: any) {",
		"\tconst getLensFlag = (name: string) => pi.getFlag(name);",
		"\tconst register = (_: unknown) => undefined;",
		`\t${body}`,
		"}",
		"export default function (pi: any) { return activateExtension(pi); }",
		"",
	].join("\n");
}

describe("factory-time flag reads (#4913)", () => {
	it("reads no flag at the top of index.ts's factory, apart from the admitted registration sites", () => {
		const scan = scanFactoryFlagReads(indexSource, ADMITTED);
		// #4917 F6: the population starts at the function pi calls, the default
		// export itself; a scan seeded from its callees missed a read in its body.
		expect(
			scan.population.length,
			"the population is not empty",
		).toBeGreaterThan(0);
		expect(scan.population[0], "the scan starts at the default export").toBe(
			"<default>",
		);
		expect(scan.population, "the scan reached the factory").toContain(
			"activateExtension",
		);
		expect(
			scan.unadmitted.map((site) => `${site.line}: ${site.key} (${site.form})`),
			"a flag read that runs while the factory runs reads pi's default, not the command line",
		).toEqual([]);
		expect(scan.staleAdmissions, "every admission row is used").toEqual([]);
		// The admitted rows are the ones the table names, nothing wider.
		expect([...new Set(scan.sites.map((site) => site.key))].sort()).toEqual(
			Object.keys(ADMITTED).sort(),
		);
	});

	it("refuses the read #4913 shipped: a flag read assigned at the factory's top level", () => {
		const mutated = indexSource.replace(
			"let lensEnabled = true;",
			'let lensEnabled = !getLensFlag("no-lens");',
		);
		expect(mutated, "the mutation applied").not.toBe(indexSource);
		const scan = scanFactoryFlagReads(mutated, ADMITTED);
		expect(scan.unadmitted.map((site) => site.key)).toEqual([
			"activateExtension:lensEnabled:getLensFlag:call",
		]);
	});

	describe("an admission row admits a stated number of sites (#4917 F11)", () => {
		// RECURRENCE THIS PREVENTS: #4917 F11. A row admitted every site sharing
		// its key, so a factory-time `pi.getFlag` at the top of `createHostPorts`
		// hid behind the row written for the deferred `flags.get` closure.
		it("refuses a second site under an admitted key", () => {
			const mutated = indexSource.replace(
				"\tconst context = () => options.getContext() as any;",
				'\tconst context = () => options.getContext() as any;\n\tif (pi.getFlag("no-lens")) context();',
			);
			expect(mutated, "the mutation applied").not.toBe(indexSource);
			const scan = scanFactoryFlagReads(mutated, ADMITTED);
			expect(scan.unadmitted.map((site) => site.key)).toEqual([
				"createHostPorts:<top>:pi:.getFlag",
				"createHostPorts:<top>:pi:.getFlag",
			]);
		});

		const twoSites = factory(
			'register(getLensFlag("a")); register(getLensFlag("b"));',
		);
		const key = "activateExtension:<top>:getLensFlag:call";
		const admit = (count: number): FactoryFlagAdmission => ({
			[key]: { count, reason: "a planted row" },
		});

		it("admits the stated number of sites under one key", () => {
			const scan = scanFactoryFlagReads(twoSites, admit(2));
			expect(scan.sites.map((site) => site.key)).toEqual([key, key]);
			expect(scan.unadmitted).toEqual([]);
			expect(scan.staleAdmissions).toEqual([]);
		});

		it("refuses every site under a key whose row admits fewer", () => {
			const scan = scanFactoryFlagReads(twoSites, admit(1));
			expect(scan.unadmitted.map((site) => site.key)).toEqual([key, key]);
			expect(scan.staleAdmissions).toEqual([]);
		});

		it("reports an admission row that admits more sites than the tree has", () => {
			const scan = scanFactoryFlagReads(twoSites, admit(3));
			expect(scan.unadmitted).toEqual([]);
			expect(scan.staleAdmissions).toEqual([key]);
		});

		it("reports an admission row whose sites went away", () => {
			const scan = scanFactoryFlagReads(factory(""), admit(1));
			expect(scan.staleAdmissions).toEqual([key]);
		});
	});

	describe("spellings the author did not design for", () => {
		const refused: Array<[string, string, string]> = [
			[
				"a direct call",
				'const on = !getLensFlag("no-lens");',
				"activateExtension:on:getLensFlag:call",
			],
			[
				"an alias",
				'const g = getLensFlag; const on = g("no-lens");',
				"activateExtension:g:getLensFlag:variable_declarator",
			],
			[
				"an indirect call through a local function",
				'const read = () => getLensFlag("no-lens"); const on = read();',
				"activateExtension:on:read:call",
			],
			[
				"a value reached through another binding",
				'const o = { get: getLensFlag }; const on = o.get("no-lens");',
				"activateExtension:o:getLensFlag:pair-value",
			],
			[
				"the host member",
				'const on = pi.getFlag("no-lens");',
				"activateExtension:on:pi:.getFlag",
			],
			[
				"a synchronous array callback",
				'const on = ["a"].filter((n) => getLensFlag(n));',
				"activateExtension:on:getLensFlag:call",
			],
			[
				"an array element",
				"const list = [getLensFlag]; list[0]('x');",
				"activateExtension:list:getLensFlag:array",
			],
			[
				"a call through .call",
				'const on = getLensFlag.call(undefined, "no-lens");',
				"activateExtension:on:getLensFlag:member_expression",
			],
			// #4917 F2: each of these ran while the factory ran and scanned green
			// when the detector enumerated synchronous callbacks instead of the
			// forms that only defer one.
			[
				"an immediately invoked arrow function",
				'const on = (() => getLensFlag("no-lens"))();',
				"activateExtension:on:getLensFlag:call",
			],
			[
				"an immediately invoked function expression",
				'const on = (function () { return getLensFlag("no-lens"); })();',
				"activateExtension:on:getLensFlag:call",
			],
			[
				"an object method the factory invokes",
				'const o = { m() { return getLensFlag("no-lens"); } }; const on = o.m();',
				"activateExtension:o:getLensFlag:call",
			],
			[
				"an object property function the factory invokes",
				'const o = { m: () => getLensFlag("no-lens") }; const on = o.m();',
				"activateExtension:o:getLensFlag:call",
			],
			[
				"a new Promise executor",
				'const p = new Promise((resolve) => resolve(getLensFlag("no-lens")));',
				"activateExtension:p:getLensFlag:call",
			],
			[
				"a constructor call inside a registrar's argument",
				'pi.on("x", new Handler(() => getLensFlag("no-lens")));',
				"activateExtension:<top>:getLensFlag:call",
			],
			[
				"a reader handed to a constructor",
				"const h = new Handler(getLensFlag);",
				"activateExtension:h:getLensFlag:new-argument",
			],
			[
				"a wrapper call that is not a registrar's argument",
				'const on = wrap(() => getLensFlag("no-lens"));',
				"activateExtension:on:getLensFlag:call",
			],
		];
		it.each(refused)("refuses %s", (_name, body, key) => {
			const scan = scanFactoryFlagReads(factory(body));
			expect(scan.unadmitted.map((site) => site.key)).toContain(key);
		});

		it("refuses a module-level helper the factory calls while it runs", () => {
			// #4917 F2: the helper is not the default export's body, so a scan of
			// only that body never read it.
			const source = [
				"function readNoLens(pi: any) { return pi.getFlag('no-lens'); }",
				"function activateExtension(pi: any) {",
				"\tconst on = readNoLens(pi);",
				"}",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			const scan = scanFactoryFlagReads(source);
			expect(scan.population).toEqual([
				"<default>",
				"activateExtension",
				"readNoLens",
			]);
			expect(scan.unadmitted.map((site) => site.key)).toContain(
				"readNoLens:<top>:pi:.getFlag",
			);
		});

		it("follows the helper chain transitively", () => {
			const source = [
				"function inner(pi: any) { return pi.getFlag('no-lens'); }",
				"const outer = (pi: any) => inner(pi);",
				"function activateExtension(pi: any) { outer(pi); }",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			const scan = scanFactoryFlagReads(source);
			expect(scan.population).toEqual([
				"<default>",
				"activateExtension",
				"outer",
				"inner",
			]);
			expect(scan.unadmitted.map((site) => site.key)).toContain(
				"inner:<top>:pi:.getFlag",
			);
		});

		// #4917 F6: a read in the function pi calls as the factory, in each form a
		// default export takes. Each scanned green while the population started
		// at the export's callees instead of the export itself.
		const helper = "function activateExtension(pi: any) { return 1; }";
		const read = "const on = pi.getFlag('no-lens');";
		const defaultExports: Array<[string, string, string]> = [
			[
				"a read in an inline default-export function declaration",
				`export default function factory(pi: any) { ${read} return activateExtension(pi); }`,
				"factory:on:pi:.getFlag",
			],
			[
				"a read in a default-export function expression",
				`export default function (pi: any) { ${read} return activateExtension(pi); }`,
				"<default>:on:pi:.getFlag",
			],
			[
				"a read in a default-export arrow behind a type assertion",
				`export default ((pi: any) => { ${read} return activateExtension(pi); }) as any;`,
				"<default>:on:pi:.getFlag",
			],
			[
				"a read in the function `export default <name>` names",
				`function factory(pi: any) { ${read} return activateExtension(pi); }\nexport default factory;`,
				"factory:on:pi:.getFlag",
			],
			[
				"a read in the function `export { x as default }` names",
				`const factory = (pi: any) => { ${read} return activateExtension(pi); };\nexport { factory as default };`,
				"factory:on:pi:.getFlag",
			],
			[
				"a read in the default export after an export whose body has a `switch` default",
				`export function pick(x: number) { switch (x) { default: return 1; } }\nexport default function (pi: any) { ${read} return activateExtension(pi); }`,
				"<default>:on:pi:.getFlag",
			],
			[
				"a read in an arrow the default export passes to a call",
				`export default function (pi: any) { return run(() => { ${read} return activateExtension(pi); }); }`,
				"<default>:on:pi:.getFlag",
			],
		];
		it.each(defaultExports)("refuses %s", (_name, body, key) => {
			const scan = scanFactoryFlagReads(`${helper}\n${body}\n`);
			expect(scan.unadmitted.map((site) => site.key)).toEqual([key]);
		});

		const admitted: Array<[string, string]> = [
			[
				"a handler the host calls later",
				'pi.on("session_start", () => getLensFlag("no-lens"));',
			],
			[
				"a handler wrapped by a call whose result is the registrar's argument",
				'pi.on("session_start", wrap("session_start", async () => getLensFlag("no-lens")));',
			],
			[
				"a command handler inside an options object",
				'pi.registerCommand("x", { handler: () => getLensFlag("no-lens") });',
			],
			["a timer callback", 'setTimeout(() => getLensFlag("no-lens"), 10);'],
			[
				"a promise continuation",
				'Promise.resolve().then(() => getLensFlag("no-lens"));',
			],
			[
				"a callback handed to a callee that stores it",
				"register(getLensFlag);",
			],
			[
				"a function declared and never called while the factory runs",
				'const later = () => getLensFlag("no-lens");',
			],
			[
				"a nested function declaration",
				'function later() { return getLensFlag("no-lens"); }',
			],
			[
				"a comment or string that quotes the call",
				'// getLensFlag("no-lens")\nconst note = "getLensFlag(x)";',
			],
		];
		it.each(admitted)("admits %s", (_name, body) => {
			const scan = scanFactoryFlagReads(factory(body));
			expect(scan.unadmitted).toEqual([]);
		});

		it("admits a module-level helper that only a handler calls", () => {
			const source = [
				"function readNoLens(pi: any) { return pi.getFlag('no-lens'); }",
				"function activateExtension(pi: any) {",
				"\tpi.on('session_start', () => readNoLens(pi));",
				"}",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			const scan = scanFactoryFlagReads(source);
			expect(scan.population).toEqual(["<default>", "activateExtension"]);
			expect(scan.unadmitted).toEqual([]);
		});
	});

	describe("the allowlist of uses of `pi` (#4917 round 4)", () => {
		// #4917 F9: a renamed destructuring of `pi.getFlag` scanned green while
		// the scanner enumerated reader spellings. Every use of the factory's
		// `pi` outside the allowlist is now refused, however it is spelled.
		const refusedUses: Array<[string, string, string]> = [
			[
				"a member read not on the list",
				'const on = pi.getFlag("no-lens");',
				"activateExtension:on:pi:.getFlag",
			],
			[
				"a renamed destructuring",
				'const { getFlag: read } = pi; const on = read("no-lens");',
				"activateExtension:{ getFlag: read }:pi:variable_declarator",
			],
			[
				"a shorthand destructuring",
				"const { getFlag } = pi;",
				"activateExtension:{ getFlag }:pi:variable_declarator",
			],
			[
				"a nested destructuring",
				"const { events: { emit } } = pi;",
				"activateExtension:{ events: { emit } }:pi:variable_declarator",
			],
			[
				"an alias",
				'const p = pi; const on = p.getFlag("no-lens");',
				"activateExtension:p:pi:variable_declarator",
			],
			[
				"a spread",
				"const copy = { ...pi };",
				"activateExtension:copy:pi:spread_element",
			],
			[
				"a computed member",
				'const on = pi["getFlag"]("no-lens");',
				"activateExtension:on:pi:subscript_expression",
			],
			[
				"a shorthand property",
				"const holder = { pi };",
				"activateExtension:holder:pi:shorthand",
			],
			[
				"pi handed to a function outside the population",
				"configure(pi);",
				"activateExtension:<top>:pi:configure()",
			],
			[
				"pi stored",
				"stored = pi;",
				"activateExtension:<top>:pi:assignment_expression",
			],
			[
				"a closure that reads through a destructured pi, called at factory time",
				'const read = () => { const { getFlag } = pi; return getFlag("no-lens"); }; const on = read();',
				"activateExtension:on:read:call",
			],
		];
		it.each(refusedUses)("refuses %s", (_name, body, key) => {
			const scan = scanFactoryFlagReads(factory(body));
			expect(scan.unadmitted.map((site) => site.key)).toContain(key);
		});

		it("refuses a closure that hands pi to a reading helper, called at factory time", () => {
			const source = [
				"function readNoLens(api: any) { return api.getFlag('no-lens'); }",
				"function activateExtension(pi: any) {",
				"\tconst go = () => readNoLens(pi);",
				"\tconst on = go();",
				"}",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			expect(
				scanFactoryFlagReads(source).unadmitted.map((site) => site.key),
			).toEqual(["activateExtension:on:go:call"]);
		});

		// #4917 F10: the destructured-parameter arm of a helper reached through a
		// closure, and a non-zero argument index, each had no red.
		it("refuses a closure that hands pi to a helper with a destructured parameter", () => {
			const source = [
				"function boot({ getFlag }: any) { return getFlag('no-lens'); }",
				"function activateExtension(pi: any) {",
				"\tconst go = () => boot(pi);",
				"\tconst on = go();",
				"}",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			expect(
				scanFactoryFlagReads(source).unadmitted.map((site) => site.key),
			).toEqual(["activateExtension:on:go:call"]);
		});

		it("follows pi handed at a helper's second parameter", () => {
			const source = [
				"function boot(name: string, api: any) { return api.getFlag('no-lens'); }",
				"function activateExtension(pi: any) {",
				"\tboot('x', pi);",
				"}",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			expect(
				scanFactoryFlagReads(source).unadmitted.map((site) => site.key),
			).toEqual(["boot:<top>:api:.getFlag"]);
		});

		it("refuses a destructured parameter that receives pi", () => {
			const source = [
				'function activateExtension({ getFlag: read }: any) { const on = read("no-lens"); }',
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			expect(
				scanFactoryFlagReads(source).unadmitted.map((site) => site.key),
			).toEqual(["activateExtension:<top>:pi:object_pattern"]);
		});

		it("refuses arguments[0] in a factory with no parameter", () => {
			const source =
				'export default function () { const on = arguments[0].getFlag("no-lens"); }\n';
			expect(
				scanFactoryFlagReads(source).unadmitted.map((site) => site.key),
			).toEqual(["<default>:on:arguments:subscript_expression"]);
		});

		it("refuses a flag read through the withConsoleCaptureWindows wrapper", () => {
			const source = [
				"function activateExtension(hostPi: any) {",
				"\tconst pi = withConsoleCaptureWindows(hostPi);",
				'\tconst on = pi.getFlag("no-lens");',
				"}",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			expect(
				scanFactoryFlagReads(source).unadmitted.map((site) => site.key),
			).toEqual(["activateExtension:on:pi:.getFlag"]);
		});

		const admittedUses: Array<[string, string]> = [
			["pi.on", 'pi.on("session_start", () => undefined);'],
			["pi.registerTool", 'pi.registerTool({ name: "t" });'],
			["pi.registerFlag", 'pi.registerFlag("f", { type: "boolean" });'],
			[
				"pi.registerCommand",
				'pi.registerCommand("c", { handler: () => undefined });',
			],
			[
				"pi.registerMessageRenderer",
				'if (typeof pi.registerMessageRenderer === "function") pi.registerMessageRenderer("t", () => undefined);',
			],
			[
				"a registrar reached through a type assertion and an optional call",
				'(pi as any).on?.("context", () => undefined);',
			],
		];
		it.each(admittedUses)("admits %s", (_name, body) => {
			expect(scanFactoryFlagReads(factory(body)).unadmitted).toEqual([]);
		});

		it("admits pi handed to a module-level function that only registers", () => {
			const source = [
				"function registerAll(api: any) { api.registerTool({ name: 't' }); }",
				"function activateExtension(pi: any) { registerAll(pi); }",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			const scan = scanFactoryFlagReads(source);
			expect(scan.population).toEqual([
				"<default>",
				"activateExtension",
				"registerAll",
			]);
			expect(scan.unadmitted).toEqual([]);
		});

		it("admits a registrar on pi wrapped by withConsoleCaptureWindows", () => {
			const source = [
				"function activateExtension(hostPi: any) {",
				"\tconst pi = withConsoleCaptureWindows(hostPi);",
				'\tpi.on("session_start", () => pi.getFlag("no-lens"));',
				"}",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			expect(scanFactoryFlagReads(source).unadmitted).toEqual([]);
		});
	});

	it("fails closed when the source has no default export", () => {
		expect(() => scanFactoryFlagReads("function a() {}")).toThrow(
			/no default export/,
		);
	});

	it("fails closed on a default export it cannot resolve to a function", () => {
		// #4917 F6: `export default wrap(factory)` scanned a population of [] and
		// passed, with a read in `factory` unseen.
		expect(() =>
			scanFactoryFlagReads(
				"function factory(pi: any) { const on = pi.getFlag('no-lens'); }\nexport default wrap(factory);\n",
			),
		).toThrow(/is not a function this module defines/);
		expect(() =>
			scanFactoryFlagReads("export { default } from './factory';\n"),
		).toThrow(/re-exported from another module/);
	});
});
