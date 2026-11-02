import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LENS_EVENT_NAMES } from "../../clients/lens-events.js";
import {
	assertNonEmptyScan,
	codeMatches,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const repoRoot = process.cwd();
const clientsDir = path.resolve(repoRoot, "clients");

/**
 * The file that owns the publish path (`createBusPublisher`): the live-emitter
 * resolve, the once-per-process skip rows, the guarded emit, and every
 * `bus-events.log` row a publish writes. `bus-events-logger.ts` is the NDJSON
 * sink it writes through.
 */
const SEAM_FILE = "live-bus-emitter.ts";
const SEAM_PATH = `clients/${SEAM_FILE}`;
const SINK_PATH = "clients/bus-events-logger.ts";

/**
 * Recurrence this file prevents (shape 83): before the fold eight
 * publish functions in five producers each carried their own copy of the
 * disabled / unwired / stale / emit / failure-latch dance, so a fix to one
 * (the `ctxSource` field on `emit_failed`, #1432 S2c; the stale-session probe,
 * #1415) left its siblings behind. A producer is admitted by routing through
 * `createBusPublisher`; every other spelling of a publish is refused.
 *
 * M3 (#1415 review): the producer list is derived, never hand-maintained. A
 * producer is a `clients/*.ts` file that imports the live-emitter seam.
 */
function discoverProducerFiles(): string[] {
	return fs
		.readdirSync(clientsDir)
		.filter((file) => file.endsWith(".ts") && file !== SEAM_FILE)
		.filter((file) => {
			const source = fs.readFileSync(path.join(clientsDir, file), "utf8");
			return /from\s+["']\.\/live-bus-emitter\.js["']/.test(source);
		})
		.sort();
}

/**
 * Files outside the seam that may name the sink: `index.ts` reads the
 * session-end rollup (`emitBusEventRollupAtSessionEnd`) and never writes a row.
 */
const SINK_IMPORTERS = new Set(["index.ts"]);

/** The sink's module specifier, in an import, re-export, dynamic import or require. */
const SINK_SPECIFIER =
	/(?:from|import|require)\s*\(?\s*["'][^"']*bus-events-logger(?:\.js)?["']/g;

/** A dynamic `import(...)` or `require(...)` call, in code. */
const DYNAMIC_LOAD_CALL = /\b(?:import|require)\s*\(/g;

/**
 * A plain quoted specifier: a `"…"` or `'…'` string literal that is the whole
 * argument (`import("./x.js")`) or the specifier of an attributed import
 * (`import("./x.json", { with: … })`). A template literal, an identifier, a
 * concatenation or a call (`pathToFileURL(entry).href`) does not match: the
 * detector cannot resolve it to a module, so it is refused. A specifier longer
 * than this window is refused too (fail closed).
 */
const PLAIN_LITERAL_SPECIFIER =
	/^\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*[),]/;
const SPECIFIER_WINDOW = 512;

function hasPlainLiteralSpecifier(source: string, openParen: number): boolean {
	return PLAIN_LITERAL_SPECIFIER.test(
		source.slice(openParen + 1, openParen + 1 + SPECIFIER_WINDOW),
	);
}

/**
 * Lines of dynamic loads whose specifier is not a plain string literal.
 *
 * A specifier the detector cannot resolve is refused, not skipped: `'`/`"` is
 * a list of the spellings someone thought of, which is exactly the gate this
 * repository forbids (AGENTS shape 69). The Greptile thread on #5179 hit it
 * with `await import(\`./bus-events-logger.js\`)`, and a specifier held in a
 * variable (`const p = "./bus-events-logger.js"; import(p)`) escapes the same
 * way. Positions come from the string-blanked text, so a call quoted in a
 * comment or inside a literal is not a site; the argument is read from the raw
 * text at that offset.
 */
function unresolvedDynamicLoadLines(source: string, blanked: string): number[] {
	const lines: number[] = [];
	for (const match of blanked.matchAll(DYNAMIC_LOAD_CALL)) {
		const start = match.index ?? 0;
		if (hasPlainLiteralSpecifier(source, start + match[0].length - 1)) continue;
		lines.push(source.slice(0, start).split("\n").length);
	}
	return lines;
}

/**
 * Files admitted to hold a dynamic load whose specifier is not a plain
 * literal: the module's path is only known at runtime. Keyed by the file the
 * admission is for (never by a spelling), with the site count it admits and
 * the reason. An admitted file still answers every other needle — it may not
 * write a bus row and may not name the sink — and a site past its count is
 * refused (AGENTS shape 69: the population is enumerated, the form is not).
 */
const UNRESOLVED_SPECIFIER_ADMISSIONS = new Map<
	string,
	{ sites: number; reason: string }
>([
	[
		"clients/deps/ast-grep-napi.ts",
		{
			sites: 1,
			reason:
				"the native addon's entry path is only known after _require.resolve at runtime: a bare specifier does not resolve under pi's bundled host, so the specifier is a computed file:// URL",
		},
	],
	[
		"clients/deps/web-tree-sitter.ts",
		{
			sites: 1,
			reason:
				"the wasm package exposes only the `.` entry, so its path is only known after _require.resolve at runtime and the specifier is a computed file:// URL",
		},
	],
]);

/** Test seam: the admissions, so the suite pins each one and its reason. */
export function unresolvedSpecifierAdmissions(): Array<
	readonly [string, { sites: number; reason: string }]
> {
	return [...UNRESOLVED_SPECIFIER_ADMISSIONS.entries()];
}

/**
 * Admitted: the seam writes bus rows and `index.ts` reads the rollup. Every
 * other file that names the sink writer (`logBusEvent`, under any import alias
 * or re-export) or its module is refused. Matches code only: the identifier is
 * read from comment-and-string-blanked text, and the specifier needle (a
 * string literal) is kept only when the `from`/`import`/`require` that
 * introduces it is code.
 */
export function findBusSinkBypasses(source: string, file: string): string[] {
	if (file === SEAM_PATH || file === SINK_PATH) return [];
	const blanked = stripSource(source, { strings: "blank" });
	const found: string[] = [];
	if (/\blogBusEvent\b/.test(blanked)) found.push("logBusEvent");
	if (
		!SINK_IMPORTERS.has(file) &&
		codeMatches(source, SINK_SPECIFIER, blanked).length > 0
	) {
		found.push("bus-events-logger import");
	}
	const admittedSites = UNRESOLVED_SPECIFIER_ADMISSIONS.get(file)?.sites ?? 0;
	for (const line of unresolvedDynamicLoadLines(source, blanked).slice(
		admittedSites,
	)) {
		found.push(`unresolved dynamic load specifier at line ${line}`);
	}
	return found;
}

/** Every `<expr>.emit(` call in code, caller token included. */
function findEmitCalls(source: string): string[] {
	return [...stripSource(source, { strings: "blank" }).matchAll(/\.emit\s*\(/g)]
		.map((m) => source.slice(0, m.index).split("\n").length)
		.map((line) => `line ${line}`);
}

describe("bus producer guarded-seam coverage", () => {
	it(
		"routes every event producer through createBusPublisher",
		() => {
			const producers = discoverProducerFiles();
			// Sanity: the sweep must actually find the known producer family, not
			// silently discover zero files (a discovery bug would make every
			// assertion below vacuously pass on an empty list).
			expect(producers).toEqual([
				"bus-publish.ts",
				"diagnostics-publish.ts",
				"disposition-publish.ts",
				"format-events-publish.ts",
				"lens-events.ts",
			]);

			for (const file of producers) {
				const code = stripSource(
					fs.readFileSync(path.join(clientsDir, file), "utf8"),
					{ strings: "blank" },
				);
				expect(code, file).toMatch(/\bcreateBusPublisher\s*\(/);
				expect(code, file).toMatch(/\.publish\s*[<(]/);
				expect(code, file).not.toMatch(/liveEmitter\.resolve\s*\(/);
				expect(code, file).not.toMatch(
					/(?:lensEventBusGetter|busEmitterGetter)\?\.\(/,
				);
			}

			const direct = listSourceFiles(clientsDir)
				.filter((file) => path.basename(file) !== SEAM_FILE)
				.filter((file) =>
					/liveEmitter\.resolve\s*\(/.test(
						stripSource(fs.readFileSync(file, "utf8"), { strings: "blank" }),
					),
				)
				.map((file) => relativePosix(repoRoot, file));
			expect(direct).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("has no .emit( call in a producer: the seam emits through the resolved target", () => {
		// The planted `rawGetter?.().emit(...)` bypass of #1415 M3b stayed green
		// against a file-existence sweep; every `.emit(` in a producer is now a
		// bypass, since the seam owns the only sanctioned one.
		const violations: string[] = [];
		for (const file of discoverProducerFiles()) {
			const source = fs.readFileSync(path.join(clientsDir, file), "utf8");
			for (const site of findEmitCalls(source)) {
				violations.push(`${file} ${site} — .emit( outside the seam`);
			}
		}
		expect(violations).toEqual([]);
	});

	it(
		"writes bus-events rows only through the seam",
		() => {
			const roots = ["clients", "tools", "mcp"].map((r) =>
				path.resolve(repoRoot, r),
			);
			const files = [
				...roots.flatMap((root) => listSourceFiles(root)),
				path.resolve(repoRoot, "index.ts"),
			];
			assertNonEmptyScan("bus sink bypass scan", files.length, 400);
			const bypasses = files.flatMap((file) =>
				findBusSinkBypasses(
					fs.readFileSync(file, "utf8"),
					relativePosix(repoRoot, file),
				).map((what) => `${relativePosix(repoRoot, file)}: ${what}`),
			);
			expect(bypasses).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("refuses a hand-written publish row under an alias, a namespace import and a re-export", () => {
		// The detector's own state table: the seam and the rollup reader are the
		// two admitted forms; each planted spelling below is one the fold's author
		// did not write, and every one must be refused.
		const planted: Array<[string, string, string]> = [
			[
				"alias",
				'import { logBusEvent as record } from "./bus-events-logger.js";\nrecord({});',
				"clients/x-publish.ts",
			],
			[
				"namespace import",
				'import * as sink from "./bus-events-logger.js";\nsink["logBus" + "Event"]({});',
				"clients/x-publish.ts",
			],
			[
				"import through another module's re-export",
				'import { logBusEvent } from "./bus-hub.js";\nlogBusEvent({});',
				"clients/x-publish.ts",
			],
			[
				"re-export",
				'export { logBusEvent } from "./bus-events-logger.js";',
				"clients/x-publish.ts",
			],
			[
				"require through a binding",
				'const sink = require("./bus-events-logger.js");\nconst write = sink.logBusEvent;\nwrite({});',
				"clients/x-publish.ts",
			],
			[
				"quoted dynamic import (control: already refused)",
				'const sink = await import("./bus-events-logger.js");\nsink["logBus" + "Event"]({});',
				"clients/x-publish.ts",
			],
			[
				"template-literal specifier",
				'const sink = await import(`./bus-events-logger.js`);\nsink["logBus" + "Event"]({});',
				"clients/x-publish.ts",
			],
			[
				"specifier held in a variable",
				'const p = "./bus-events-logger.js";\nconst sink = await import(p);\nsink["logBus" + "Event"]({});',
				"clients/x-publish.ts",
			],
			[
				"dynamic require through a variable",
				'const p = "./bus-events-logger.js";\nconst sink = require(p);\nsink["logBus" + "Event"]({});',
				"clients/x-publish.ts",
			],
			[
				"concatenated specifier",
				'const sink = await import("./bus-events" + "-logger.js");\nsink["logBus" + "Event"]({});',
				"clients/x-publish.ts",
			],
		];
		// Every planted spelling is refused, and one miss names itself instead of
		// hiding behind the first failure: a fail-closed detector owes its author
		// the whole refused set.
		const admitted = planted
			.filter(
				([, source, file]) => findBusSinkBypasses(source, file).length === 0,
			)
			.map(([label]) => label);
		expect(admitted).toEqual([]);
		// Admitted, and prose never excuses or accuses.
		expect(
			findBusSinkBypasses(
				'import { emitBusEventRollupAtSessionEnd } from "./clients/bus-events-logger.js";',
				"index.ts",
			),
		).toEqual([]);
		// A dynamic load of a module the detector can resolve is not a bypass;
		// refusing plain literals would make every lazy `import()` a finding.
		expect(
			findBusSinkBypasses(
				'const m = await import("./metrics-history.js");',
				"clients/x-publish.ts",
			),
		).toEqual([]);
		expect(
			findBusSinkBypasses(
				'const m = await import("./x.json", { with: { type: "json" } });',
				"clients/x-publish.ts",
			),
		).toEqual([]);
		expect(
			findBusSinkBypasses(
				"// await import(dynamicSpecifier);\nconst ok = 1;",
				"clients/x-publish.ts",
			),
		).toEqual([]);
		expect(
			findBusSinkBypasses(
				'// logBusEvent is the seam\'s\nconst s = "from \\"./bus-events-logger.js\\"";',
				"clients/x-publish.ts",
			),
		).toEqual([]);
		expect(findBusSinkBypasses("logBusEvent({});", SEAM_PATH)).toEqual([]);
	});

	it("admits exactly the two runtime-resolved loader sites, and refuses a second computed load in an admitted file", () => {
		// The fail-closed branch found exactly two live sites (#5179 F1). Each is
		// admitted by FILE with its site count and a reason, never by a spelling: a
		// third file, or a second computed load in an admitted one, reds.
		const admissions = unresolvedSpecifierAdmissions();
		expect(admissions.map(([file]) => file)).toEqual([
			"clients/deps/ast-grep-napi.ts",
			"clients/deps/web-tree-sitter.ts",
		]);
		for (const [file, admission] of admissions) {
			expect(admission.reason.length, file).toBeGreaterThan(40);
			expect(admission.sites, file).toBe(1);
		}
		expect(
			findBusSinkBypasses(
				"const a = await import(first);\nconst b = await import(second);",
				"clients/deps/web-tree-sitter.ts",
			),
		).toEqual(["unresolved dynamic load specifier at line 2"]);
	});

	it("carries ctxSource on the emit_failed row the seam writes for every producer", () => {
		// #1432 review (S2c): lens-events.ts's emit_failed row was missing
		// ctxSource while the other four producers carried it. The five copies
		// are one row now; a static read of the seam (not a runtime assertion, the
		// logger is a no-op in test mode) fails loud if the field is dropped.
		const source = fs.readFileSync(path.join(clientsDir, SEAM_FILE), "utf8");
		const blanked = stripSource(source, { strings: "blank" });
		const rows = codeMatches(source, /outcome:\s*"emit_failed"/g, blanked);
		expect(rows).toHaveLength(1);
		const start = rows[0].index ?? 0;
		const block = source.slice(start, source.indexOf("});", start));
		expect(block).toMatch(/ctxSource:\s*resolution\.ctxSource/);
	});

	it("keeps the complete lens producer family in the guarded producer set", () => {
		expect(Object.values(LENS_EVENT_NAMES)).toEqual([
			"pi-lens/analysis-complete",
			"pi-lens/findings",
			"pi-lens/turn-findings",
		]);
	});
});
