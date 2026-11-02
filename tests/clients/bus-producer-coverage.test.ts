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
		];
		for (const [label, source, file] of planted) {
			expect(findBusSinkBypasses(source, file), label).not.toEqual([]);
		}
		// Admitted, and prose never excuses or accuses.
		expect(
			findBusSinkBypasses(
				'import { emitBusEventRollupAtSessionEnd } from "./clients/bus-events-logger.js";',
				"index.ts",
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
