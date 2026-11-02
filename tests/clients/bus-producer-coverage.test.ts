import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LENS_EVENT_NAMES } from "../../clients/lens-events.js";
import {
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
 * `bus-events.log` row a publish writes. The NDJSON writer is private to this module.
 */
const SEAM_FILE = "live-bus-emitter.ts";

/**
 * Recurrence this file prevents (shape 83): before the fold eight
 * publish functions in five producers each carried their own copy of the
 * disabled / unwired / stale / emit / failure-latch dance, so a fix to one
 * (the `ctxSource` field on `emit_failed`, #1432 S2c; the stale-session probe,
 * #1415) left its siblings behind. A producer is admitted by routing through
 * `createBusPublisher`; every other spelling of a publish is refused.
 *
 * M3 (#1415 review): the producer list is derived, never hand-maintained. A
 * producer imports the live-emitter seam; the read-only rollup facade is excluded.
 */
function discoverProducerFiles(): string[] {
	return fs
		.readdirSync(clientsDir)
		.filter(
			(file) =>
				file.endsWith(".ts") &&
				file !== SEAM_FILE &&
				file !== "bus-event-rollup.ts",
		)
		.filter((file) => {
			const source = fs.readFileSync(path.join(clientsDir, file), "utf8");
			return /from\s+["']\.\/live-bus-emitter\.js["']/.test(source);
		})
		.sort();
}

/** Every `<expr>.emit(` call in code, caller token included. */
function findEmitCalls(source: string): string[] {
	return [...stripSource(source, { strings: "blank" }).matchAll(/\.emit\s*\(/g)]
		.map((m) => source.slice(0, m.index).split("\n").length)
		.map((line) => `line ${line}`);
}

describe("bus producer guarded-seam coverage", () => {
	it("keeps the bus writer private to the publish seam", async () => {
		// #5179 F1/F4/F5: imports through any spelling cannot recover a private writer.
		const facade = await import("../../clients/bus-event-rollup.js");
		const seam = await import("../../clients/live-bus-emitter.js");
		expect(facade).not.toHaveProperty("logBusEvent");
		expect(seam).not.toHaveProperty("logBusEvent");
	});

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
