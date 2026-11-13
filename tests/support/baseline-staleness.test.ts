import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	expectPlantedStaleRow,
	plantedStaleRowRegistrations,
} from "./baseline-staleness.js";

/**
 * Direct tests of the seam every planted-stale-row cell drives (#5072).
 *
 * The cells are the coverage of the baselines; this file is the coverage of the
 * seam itself. It matters because a seam that stops throwing turns every cell in
 * the repository into a comment: the governance check reads the CALL, so only
 * these assertions prove the call means anything. Each case drives the real
 * function against a real ledger file on disk — the committed bytes the seam
 * reads are the same bytes the owner ratchet reads — and asserts the throw's
 * message, not only that it threw.
 */

let dir: string;
const ledgerPath = (name: string): string => path.join(dir, name);

function writeLedger(name: string, content: string): string {
	const target = ledgerPath(name);
	fs.writeFileSync(target, content, "utf-8");
	return target;
}

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-baseline-staleness-"));
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("expectPlantedStaleRow (#5072)", () => {
	it("keeps a planted row the committed ledger does not carry and the verdict names", () => {
		const ledger = writeLedger(
			"rows.json",
			JSON.stringify({ "tests/live.test.ts": 1 }),
		);
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/planted.test.ts",
				direction: "extra-row",
				verdict: ["tests/planted.test.ts: no live member"],
			}),
		).not.toThrow();
	});

	it("rejects a plant that leaves the ratchet green", () => {
		const ledger = writeLedger(
			"green.json",
			JSON.stringify({ "tests/live.test.ts": 1 }),
		);
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/planted.test.ts",
				direction: "extra-row",
				verdict: [],
			}),
		).toThrow(/returned no verdict/);
	});

	it("rejects a verdict that never names the planted row", () => {
		const ledger = writeLedger(
			"other.json",
			JSON.stringify({ "tests/live.test.ts": 1 }),
		);
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/planted.test.ts",
				direction: "extra-row",
				// Something red, but about a different row: an unrelated failure would
				// certify a plant that never entered the corpus.
				verdict: ["tests/live.test.ts: count drifted from 1 to 2"],
			}),
		).toThrow(/no verdict line names/);
	});

	it("rejects an extra-row plant whose row the committed ledger already lists", () => {
		const ledger = writeLedger(
			"member.json",
			JSON.stringify({ "tests/real.test.ts": 1 }),
		);
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/real.test.ts",
				direction: "extra-row",
				verdict: ["tests/real.test.ts"],
			}),
		).toThrow(/already carries/);
	});

	it("rejects a withheld-member plant the committed ledger does not hold", () => {
		const ledger = writeLedger("withheld.json", JSON.stringify({ a: 1 }));
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/absent.test.ts",
				direction: "withheld-member",
				verdict: ["tests/absent.test.ts: the run no longer reports it"],
			}),
		).toThrow(/not a row of the committed ledger/);
	});

	it("keeps a withheld-member plant the ledger does hold", () => {
		const ledger = writeLedger(
			"held.json",
			JSON.stringify({ "tests/gone.test.ts": 1 }),
		);
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/gone.test.ts",
				direction: "withheld-member",
				verdict: ["tests/gone.test.ts: no live member"],
			}),
		).not.toThrow();
	});

	it("reads a row of a TypeScript table, and a member of an export list", () => {
		const table = writeLedger(
			"table.ts",
			'export const TABLE = {\n\t"live.ts": 1,\n};\nexport const OTHER = {\n\t"other.ts": 1,\n};\n',
		);
		// A row of the named table is a member; a row of the sibling export is not,
		// which is what stops a plant being certified against any text in the file.
		expect(() =>
			expectPlantedStaleRow({
				baseline: `${table}#TABLE`,
				rowKey: "live.ts",
				direction: "withheld-member",
				verdict: ["live.ts"],
			}),
		).not.toThrow();
		expect(() =>
			expectPlantedStaleRow({
				baseline: `${table}#TABLE`,
				rowKey: "other.ts",
				direction: "extra-row",
				verdict: ["other.ts"],
			}),
		).not.toThrow();
		expect(() =>
			expectPlantedStaleRow({
				baseline: `${table}#TABLE`,
				rowKey: "other.ts",
				direction: "withheld-member",
				verdict: ["other.ts"],
			}),
		).toThrow(/not a row of the committed ledger/);

		const list = writeLedger(
			"list.ts",
			'export const NAMES = ["one.ts", "two.ts"];\n',
		);
		expect(() =>
			expectPlantedStaleRow({
				baseline: `${list}#NAMES`,
				rowKey: "one.ts",
				direction: "withheld-member",
				verdict: ["one.ts"],
			}),
		).not.toThrow();
	});

	it("treats a row that lives only in a comment as absent", () => {
		// The ledger is a table and the row appears only in prose: a plant keyed on
		// a sentence would certify itself against text no scan reads.
		const ledger = writeLedger(
			"prose.ts",
			'export const TABLE = {\n\t"live.ts": 1,\n};\n// "tests/commented.ts" was retired here\n',
		);
		expect(() =>
			expectPlantedStaleRow({
				baseline: `${ledger}#TABLE`,
				rowKey: "tests/commented.ts",
				direction: "withheld-member",
				verdict: ["tests/commented.ts"],
			}),
		).toThrow(/not a row of the committed ledger/);
	});

	it("reports the ledger file it could not read rather than passing", () => {
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledgerPath("missing.json"),
				rowKey: "x",
				direction: "extra-row",
				verdict: ["x"],
			}),
		).toThrow(/not in the tree/);
	});
});

describe("plantedStaleRowRegistrations (#5072)", () => {
	it("reads the literals of a call and skips one inside a comment", () => {
		const source = [
			'it("plants a row", () => {',
			"  expectPlantedStaleRow({",
			'    baseline: "a/b.json",',
			'    rowKey: "x",',
			'    direction: "extra-row",',
			"    verdict: [],",
			"  });",
			"});",
			'// expectPlantedStaleRow({ baseline: "c/d.json", rowKey: "x", direction: "extra-row" })',
			"",
		].join("\n");
		const registrations = plantedStaleRowRegistrations(source);
		expect(registrations).toHaveLength(1);
		expect(registrations[0]).toMatchObject({
			baseline: "a/b.json",
			hasRowKey: true,
			direction: "extra-row",
		});
	});

	it("reports a rowKey written as an expression as present without a value", () => {
		const source = [
			"const planted = computeName();",
			'it("plants", () => {',
			"  expectPlantedStaleRow({",
			'    baseline: "a/b.json",',
			"    rowKey: planted,",
			'    direction: "withheld-member",',
			"    verdict: [],",
			"  });",
			"});",
			"",
		].join("\n");
		expect(plantedStaleRowRegistrations(source)).toEqual([
			{
				baseline: "a/b.json",
				hasRowKey: true,
				direction: "withheld-member",
				line: 3,
			},
		]);
	});
});
