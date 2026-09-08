// flake-shape: elapsed-time-assertion — the defect under test is regex
// backtracking. A mocked clock cannot observe the synchronous matcher cost.

/**
 * #2622 — adjacent wildcard runs in the read-guard and directory-name glob
 * compilers must not create one nullable regex group per star.
 *
 * Both dialects have only `*` wildcards. Collapsing a run of adjacent stars is
 * therefore language-preserving: `.*.*` and `.*` accept exactly the same
 * strings, while the latter has no exponential partitioning choices.
 */

import { describe, expect, it } from "vitest";
import { isExcludedDirName } from "../../clients/file-utils.js";
import { createReadGuard } from "../../clients/read-guard.js";

const ADJACENT_STARS = 12;
const PATH_COMPONENTS = 40;
const BUDGET_MS = 500;

function oldReadGuardMatch(filePath: string, pattern: string): boolean {
	if (pattern.startsWith("*")) return filePath.endsWith(pattern.slice(1));
	if (pattern.includes("*")) {
		const regex = new RegExp(
			`^${pattern.replace(/\\/g, "\\\\").replace(/\./g, "\\.").replace(/\*/g, ".*")}$`,
		);
		return regex.test(filePath);
	}
	return filePath === pattern;
}

function readGuardMatch(filePath: string, pattern: string): boolean {
	return (
		createReadGuard("read-guard-glob-differential", {
			exemptions: [{ pattern, mode: "allow" }],
		}).checkEdit(filePath).action === "allow"
	);
}

function oldDirectoryNameMatch(candidate: string, pattern: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i").test(candidate);
}

function directoryNameMatch(candidate: string, pattern: string): boolean {
	return isExcludedDirName(candidate, [pattern]);
}

const readGuardCorpus = [
	"src/*/secret",
	"src/**/secret",
	"src************/secret",
	"src/**/**/secret",
	"*.md",
	"/src/api.ts",
	"literal.with.dots",
];

const directoryNameCorpus = [
	"*.dSYM",
	"cache**tmp",
	"cache************tmp",
	"?odule",
	"literal.with.dots",
	"excluded-dir-2622",
];

const subjectCorpus = [
	"src/secret",
	"src/a/secret",
	"src/a/b/secret",
	"srcXXXXXXXXXXXX/secret",
	"src/not-secret",
	"/docs/readme.md",
	"/src/api.ts",
	"literal.with.dots",
	"module",
	"cache123tmp",
	"CACHE123TMP",
	"excluded-dir-subject-2622",
];

describe("adjacent wildcard glob compilers (#2622)", () => {
	it("answers the read-guard corpus exactly as the pre-fix compiler did", () => {
		const differences: string[] = [];
		for (const pattern of readGuardCorpus) {
			for (const subject of subjectCorpus) {
				const expected = oldReadGuardMatch(subject, pattern);
				const actual = readGuardMatch(subject, pattern);
				if (actual !== expected) {
					differences.push(`${pattern} ${subject}: ${actual} !== ${expected}`);
				}
			}
		}
		expect(differences, differences.join("\n")).toEqual([]);
	});

	it("answers the directory-name corpus exactly as the pre-fix compiler did", () => {
		const differences: string[] = [];
		for (const pattern of directoryNameCorpus) {
			for (const subject of subjectCorpus) {
				const expected = oldDirectoryNameMatch(subject, pattern);
				const actual = directoryNameMatch(subject, pattern);
				if (actual !== expected) {
					differences.push(`${pattern} ${subject}: ${actual} !== ${expected}`);
				}
			}
		}
		expect(differences, differences.join("\n")).toEqual([]);
	});

	it(`answers a ${ADJACENT_STARS}-star read-guard miss within ${BUDGET_MS}ms`, () => {
		const filePath = [
			"src",
			...Array.from({ length: PATH_COMPONENTS }, (_, i) => `component-${i}`),
			"not-secret",
		].join("/");
		const pattern = `src${"*".repeat(ADJACENT_STARS)}/secret`;

		const started = performance.now();
		const matched = readGuardMatch(filePath, pattern);
		const elapsed = performance.now() - started;

		expect(matched).toBe(false);
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});

	it(`answers a ${ADJACENT_STARS}-star directory-name miss within ${BUDGET_MS}ms`, () => {
		const candidate = "cache" + "x".repeat(245);
		const started = performance.now();
		const matched = isExcludedDirName(candidate, ["cache************tmp"]);
		const elapsed = performance.now() - started;

		// Keep deliberate headroom for scheduler contention in the serialized lane.
		expect(matched).toBe(false);
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});
});
