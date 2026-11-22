/**
 * State table for `process-slot-scan.ts` (AGENTS.md shape 69): the admitted
 * forms stay clean, and every spelling its author did not design for is a site.
 * The three plant families the fixer contract names are here: an alias, an
 * indirect call and a value reached through another binding.
 */
import { describe, expect, it } from "vitest";
import { scanProcessSlotSites } from "./process-slot-scan.js";

const forms = (source: string): string[] =>
	scanProcessSlotSites(source).map((site) => site.form);

describe("process slot scan: admitted forms", () => {
	it.each([
		["a described symbol", 'const key = Symbol("local");'],
		["a well-known symbol", "const it = obj[Symbol.iterator];"],
		["an environment read", "const home = process.env.HOME;"],
		["a documented process write", "process.exitCode = 1;"],
		["an environment write", "process.env.PI_X = '1';"],
		["a listener", 'process.once("exit", () => {});'],
		["a type query", "type P = typeof process & typeof globalThis;"],
		["a console call", "console.log(1);"],
		[
			"a local binding named like the global",
			"function f() { const global = load(); return global.x; }",
		],
		[
			"a parameter named like the global",
			"const f = (Symbol) => Symbol.for('a');",
		],
		[
			"a type-only import named like the global",
			'import type { Symbol } from "./t.js";',
		],
		["a comment", "// Symbol.for(x) and globalThis[k] and process[k]\n"],
		["a string", 'const s = "Symbol.for(globalThis)";'],
		["a template", "const s = `process[${k}] globalThis`;"],
	])("reads %s as clean", (_name, source) => {
		expect(forms(source)).toEqual([]);
	});
});

describe("process slot scan: spellings it was not designed around", () => {
	// Recurrence: a hand-rolled slot beside `getProcessSingleton` (shape 25,
	// #2146). Each plant is a slot a detector keyed on the call spelling
	// `Symbol.for(` would miss.
	it.each([
		["the registry call", 'const k = Symbol.for("a");', "Symbol.for"],
		[
			"a computed registry call",
			'Symbol["for"]("a");',
			"symbol-computed-member",
		],
		[
			"an alias of the registry function",
			'const sf = Symbol.for; sf("a");',
			"Symbol.for",
		],
		["an alias of Symbol", 'const S = Symbol; S.for("a");', "symbol-value"],
		[
			"a destructured registry function",
			'const { for: f } = Symbol; f("a");',
			"symbol-value",
		],
		[
			"an indirect call",
			'Reflect.apply(Symbol.for, Symbol, ["a"]);',
			"Symbol.for",
		],
		["a bound global", "const g = globalThis; g[k] = 1;", "global-object"],
		["a cast global", "(globalThis as any).slot = 1;", "global-object"],
		["a destructured global", "const { slot } = globalThis;", "global-object"],
		["the node alias of the global", "global.slot = 1;", "global-object"],
		["a bound process", "const p = process; p[k] = 1;", "process-value"],
		[
			"a process cast",
			"const p = process as typeof process & { x?: number }; p.x = 1;",
			"process-cast",
		],
		[
			"a computed process member",
			"process[key] ??= 1;",
			"process-computed-member",
		],
		["a process member write", "process.__slot = 1;", "process-member-write"],
		["a console patch", "console.log = () => {};", "console-member-write"],
		[
			"a computed console patch",
			"console[method] = fn;",
			"console-computed-member",
		],
		[
			"a process member delete",
			"delete process.__slot;",
			"process-member-write",
		],
		[
			"a process passed along",
			"Object.defineProperty(process, 'x', {});",
			"process-value",
		],
	])("reports %s", (_name, source, form) => {
		expect(forms(source)).toContain(form);
	});

	it("keys a second site in one symbol with an ordinal", () => {
		const sites = scanProcessSlotSites(
			'function slot() {\n  const a = Symbol.for("a");\n  const b = Symbol.for("b");\n}\n',
		);
		expect(sites.map((site) => site.anchor)).toEqual(["slot", "slot#2"]);
	});

	it("anchors a method to its class and a module-level binding to itself", () => {
		const sites = scanProcessSlotSites(
			'class Holder { read() { return globalThis.x; } }\nconst host = globalThis;\nSymbol.for("m");\n',
		);
		expect(sites.map((site) => site.anchor)).toEqual([
			"Holder.read",
			"host",
			"<module>",
		]);
	});
});
