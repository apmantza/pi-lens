import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const SELF = "tests/config/lsp-service-double-sweep.test.ts";

/**
 * #2582 recurrence: a partial service double puts a direct `touchFile` mock
 * beside production-shaped calls. Keep this detector narrow to the shipped
 * hand-rolled shape; the factory itself is the one intentional occurrence.
 */
export function findHandRolledTouchFileDoubles(source: string): number[] {
	const stripped = stripSource(source);
	const rows: number[] = [];
	const pattern = /touchFile\s*:\s*vi\.fn\s*\(/g;
	for (const match of stripped.matchAll(pattern)) {
		rows.push(stripped.slice(0, match.index ?? 0).split("\n").length);
	}
	return rows;
}

function testSources(): string[] {
	return listSourceFiles(TESTS_ROOT, { extensions: [".ts"] })
		.filter((file) => file.endsWith(".test.ts"))
		.filter((file) => relativePosix(REPO_ROOT, file) !== SELF);
}

describe("#2582 shared LSP service-double recurrence sweep", () => {
	it("finds no direct touchFile vi.fn service literals outside the factory", () => {
		const files = testSources();
		assertNonEmptyScan("#2582 LSP service-double test walk", files.length, 20);
		const violations = files.flatMap((file) => {
			const rows = findHandRolledTouchFileDoubles(
				fs.readFileSync(file, "utf8"),
			);
			return rows.map((line) => `${relativePosix(REPO_ROOT, file)}:${line}`);
		});
		expect(violations, violations.join("\n")).toEqual([]);
	});

	// Mutation proof for the recurrence guard: this synthetic fresh fixture is
	// the exact shape that escaped before #2582. Removing the detector's match
	// turns this assertion red, so the sweep cannot pass vacuously.
	it("red-proves a fresh hand-rolled double", () => {
		const source = [
			"const service = {",
			"  " + "touchFile" + ": " + "vi.fn" + "(),",
			"};",
		].join("\n");
		expect(findHandRolledTouchFileDoubles(source)).toEqual([2]);
	});
});
