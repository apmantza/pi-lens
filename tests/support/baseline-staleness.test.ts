import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	expectPlantedStaleRow,
	plantedStaleRowRegistrations,
	rowsWithoutLiveMember,
} from "./baseline-staleness.js";

/**
 * Direct tests of the seam every planted-stale-row cell drives (#5072).
 *
 * A seam that stops throwing turns every cell in the repository into a
 * comment: the census reads the CALL, so only these assertions prove the call
 * means anything. Each case drives the real function against a ledger file on
 * disk and asserts the throw's message, not only that it threw.
 */

let dir: string;

function writeLedger(name: string, content: string): string {
	const target = path.join(dir, name);
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
		const ledger = writeLedger("rows.json", '{"tests/live.test.ts": 1}');
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/planted.test.ts",
				verdict: ["tests/planted.test.ts: no live member"],
			}),
		).not.toThrow();
	});

	it("rejects a plant that leaves the ratchet green, or a blank row", () => {
		const ledger = writeLedger("green.json", '{"tests/live.test.ts": 1}');
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/planted.test.ts",
				verdict: ["", undefined],
			}),
		).toThrow(/returned no verdict/);
		expect(() =>
			expectPlantedStaleRow({ baseline: ledger, rowKey: " ", verdict: ["x"] }),
		).toThrow(/names no row/);
	});

	it("rejects a verdict that names the planted row only inside a longer identity", () => {
		// Recurrence (#5546 B3): a substring check accepted a verdict about
		// `tests/x.test.tsx` as naming the planted `tests/x.test.ts`.
		const ledger = writeLedger("other.json", '{"tests/live.test.ts": 1}');
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/x.test.ts",
				verdict: ["tests/x.test.tsx: count drifted from 1 to 2"],
			}),
		).toThrow(/no verdict line names/);
	});

	it("reads the committed rows parsed, so an escaped or a longer row is told apart", () => {
		// Recurrence (#5546 F7): the raw-text check missed a JSON-escaped row the
		// ledger really carried, and called a row committed because a longer one
		// contained it.
		const ledger = writeLedger(
			"escaped.json",
			'// header\n[{"file": "tests/x.test.tsx", "title": "\\"c\\""}]',
		);
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: '"c"',
				verdict: ['tests/x.test.tsx: "c"'],
			}),
		).toThrow(/already carries/);
		expect(() =>
			expectPlantedStaleRow({
				baseline: ledger,
				rowKey: "tests/x.test.ts",
				verdict: ["tests/x.test.ts: no live member"],
			}),
		).not.toThrow();
	});

	it("reads the rows of the named table only, following an alias, and never a comment", () => {
		const table = writeLedger(
			"table.ts",
			[
				'const ROWS = { "live.ts": 1 };',
				"export const TABLE: Record<string, number> = ROWS;",
				'export const OTHER = { "other.ts": 1 };',
				'// "commented.ts" was retired here',
				"",
			].join("\n"),
		);
		const plant = (rowKey: string) => () =>
			expectPlantedStaleRow({
				baseline: `${table}#TABLE`,
				rowKey,
				verdict: [`${rowKey}: no live member`],
			});
		expect(plant("live.ts")).toThrow(/already carries/);
		expect(plant("other.ts")).not.toThrow();
		expect(plant("commented.ts")).not.toThrow();
		expect(() =>
			expectPlantedStaleRow({
				baseline: `${table}#MISSING`,
				rowKey: "x",
				verdict: ["x"],
			}),
		).toThrow(/declares no MISSING/);
	});

	it("reports a ledger it cannot read rather than passing", () => {
		expect(() =>
			expectPlantedStaleRow({
				baseline: path.join(dir, "missing.json"),
				rowKey: "x",
				verdict: ["x"],
			}),
		).toThrow(/not in the tree/);
		const notJson = writeLedger("rows.csv", "file\ntests/a.test.ts\n");
		expect(() =>
			expectPlantedStaleRow({ baseline: notJson, rowKey: "x", verdict: ["x"] }),
		).toThrow(/not a JSON document/);
	});
});

describe("rowsWithoutLiveMember (#5072)", () => {
	it("returns the rows no live member produces, in code-unit order", () => {
		expect(
			rowsWithoutLiveMember(["b", "a", "B", "live"], new Set(["live"])),
		).toEqual(["B", "a", "b"]);
	});
});

describe("plantedStaleRowRegistrations (#5072)", () => {
	it("reads a call's baseline literal and rowKey, and skips a call in a comment or a string", () => {
		const source = [
			'it("plants a row", () => {',
			"  expectPlantedStaleRow({",
			'    baseline: "a/b.json",',
			"    rowKey,",
			"    verdict: [],",
			"  });",
			"});",
			'// expectPlantedStaleRow({ baseline: "c/d.json", rowKey: "x" })',
			'const s = "expectPlantedStaleRow({ baseline: \\"e/f.json\\", rowKey: 1 })";',
			"",
		].join("\n");
		expect(plantedStaleRowRegistrations(source)).toMatchObject([
			{ baseline: "a/b.json", hasRowKey: true, line: 2 },
		]);
	});

	it("reads properties only inside the call's own parentheses", () => {
		// Recurrence (#5546 B7): a fixed window credited a later object's
		// literals to a call whose claim was a variable.
		const source = [
			"expectPlantedStaleRow(claim);",
			'const other = { baseline: "a/b.json", rowKey: "x" };',
			'expectPlantedStaleRow({ baseline: name, rowKey: "x" });',
			"",
		].join("\n");
		expect(plantedStaleRowRegistrations(source)).toMatchObject([
			{ baseline: undefined, hasRowKey: false },
			{ baseline: undefined, hasRowKey: true },
		]);
	});
});
