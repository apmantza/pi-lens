/**
 * #2281 / #2784 wave 2: whole-module `vi.mock` factories must not drop
 * production exports. Recurrences: #2272 and #2782.
 *
 * The sweep uses transitive importer-use reachability over the test's
 * non-mocked production imports. The admission contains 358 findings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import {
	findViMockExportGaps,
	type ViMockExportFinding,
} from "../support/vi-mock-export-gate.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const BASELINE: Record<string, number> = JSON.parse(
	fs.readFileSync(
		path.join(REPO_ROOT, "tests/support/vi-mock-export-baseline.json"),
		"utf8",
	),
);

function scan(): ViMockExportFinding[] {
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith("fixtures/"),
	});
	assertNonEmptyScan("#2281 vi.mock export sweep", files.length, 200);
	return files.flatMap((file) =>
		findViMockExportGaps(file, fs.readFileSync(file, "utf8")),
	);
}

function scanLatencyLoggerSurface(): ViMockExportFinding[] {
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith("fixtures/"),
	});
	assertNonEmptyScan("#2281 latency-logger mock surface", files.length, 200);
	return files
		.flatMap((file) =>
			findViMockExportGaps(file, fs.readFileSync(file, "utf8"), "all"),
		)
		.filter((finding) => finding.specifier.endsWith("latency-logger.js"));
}

function key(finding: ViMockExportFinding): string {
	return `${relativePosix(REPO_ROOT, finding.file)}:${finding.specifier}:${JSON.stringify(
		[...finding.factoryProperties].sort(compareCodeUnits),
	)}`;
}

function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function baselineFrom(findings: ViMockExportFinding[]): Record<string, number> {
	return Object.fromEntries(
		findings
			.map((finding) => [key(finding), finding.missing.length] as const)
			.sort(([a], [b]) => compareCodeUnits(a, b)),
	);
}

function compareAgainstBaseline(
	findings: ViMockExportFinding[],
	baseline: Record<string, number>,
) {
	const live = new Map(findings.map((finding) => [key(finding), finding]));
	const problems: string[] = [];
	const warnings: string[] = [];
	for (const [entry, finding] of live) {
		const admitted = baseline[entry];
		if (admitted === undefined)
			problems.push(
				`${entry}: regression; missing ${finding.missing.join(", ")}`,
			);
		else if (finding.missing.length > admitted)
			warnings.push(
				`${entry}: missing count rose from ${admitted} to ${finding.missing.length}; missing ${finding.missing.join(", ")}`,
			);
		else if (finding.missing.length < admitted)
			warnings.push(
				`${entry}: missing count fell from ${admitted} to ${finding.missing.length}`,
			);
	}
	for (const entry of Object.keys(baseline))
		if (!live.has(entry))
			problems.push(`${entry}: ratchet down; offender was fixed`);
	return { problems, warnings };
}

describe("#2281 whole-module vi.mock export ratchet", () => {
	it("keeps every latency-logger mock on the real export surface", () => {
		// Recurrence guard for #2272 and #2281: a whole-module factory mock can
		// stay green until an untested production call reaches a newly added export.
		expect(scanLatencyLoggerSurface()).toEqual([]);
	}, 60_000);

	it("flags an export used by a production importer", () => {
		// Regression #2782: importer-use mode must not miss an indirect named import.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", () => ({ a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("follows more than one production-importer hop", () => {
		// Regression #2782: the recurrence is test -> A -> B -> mocked module.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			fs.writeFileSync(path.join(root, "module.ts"), "export const x = 1;\n");
			fs.writeFileSync(
				path.join(root, "b.ts"),
				'import { x } from "./module.js"; export const b = x;\n',
			);
			fs.writeFileSync(
				path.join(root, "a.ts"),
				'import { b } from "./b.js"; export const a = b;\n',
			);
			const source =
				'import { a } from "./a.js";\nvi.mock("./module.js", () => ({ a: 1 }));\n';
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["x"] },
			]);
			expect(
				findViMockExportGaps(testFile, source, "imported", {
					importerDepth: 1,
				}),
			).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a no-argument importOriginal pass-through spread", () => {
		// Regression #2784: the correct Vitest pass-through idiom has no import argument.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal()), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts an explicit-type-argument importOriginal pass-through spread", () => {
		// Regression #2881: `await importOriginal<typeof import("…")>()` is a
		// complete pass-through identical to the no-argument form, but the
		// tree-sitter grammar misparses it as a `<` binary comparison, so the
		// sweep read it as dropping every export.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./module.js")>()), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a simple-type-argument importOriginal pass-through spread", () => {
		// Class sweep #2881: `await importOriginal<T>()` nests the await
		// inside the call callee, so the old identifier-callee check missed it.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\ntype T = typeof import("./module.js");\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal<T>()), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts an as-cast importOriginal pass-through spread", () => {
		// Class sweep #2881: `...(await importOriginal<T>() as any)` wraps
		// the awaited call in an as_expression the old check never unwrapped.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./module.js")>() as any), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a satisfies importOriginal pass-through spread", () => {
		// Class sweep #2881: the satisfies_expression twin of the as-cast.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./module.js")>() satisfies Record<string, unknown>), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a parenthesised importOriginal pass-through spread", () => {
		// Class sweep #2881: `...((await importOriginal<T>()))` nests the
		// awaited call two parenthesised layers deep inside the spread.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...((await importOriginal<typeof import("./module.js")>())), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a two-statement importOriginal binding spread", () => {
		// Class sweep #2881: the dominant live idiom binds the awaited
		// module first (`const actual = await importOriginal<T>()`) and
		// spreads the alias in the returned object.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => { const actual = await importOriginal<typeof import("./module.js")>(); return { ...actual, a: 1 }; });\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a two-statement no-argument importOriginal binding spread", () => {
		// The PREMISE transcript's seventh shape: the alias idiom without a
		// type argument is the same complete pass-through.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => { const actual = await importOriginal(); return { ...actual, a: 1 }; });\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a two-statement binding beside a nested helper", () => {
		// Scope positive control for the F3 fix: a nested function inside the
		// factory must not hide the body's own top-level awaited alias.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => { const actual = await importOriginal(); function helper() { return 1; } return { ...actual, a: 1 }; });\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a no-argument as-cast importOriginal pass-through spread", () => {
		// Pins the as_expression arm of the shared unwrap: the generic-form
		// as-cast test never reaches it (the misparse branch swallows the
		// generic first), so only this no-argument form reds when the arm dies.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal() as any), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a no-argument satisfies importOriginal pass-through spread", () => {
		// Pins the satisfies_expression arm specifically: deleting only that
		// kind from the unwrap reds this test and leaves the as-cast green.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal() satisfies Record<string, unknown>), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a non-null-asserted importOriginal pass-through spread", () => {
		// Review F2/X1 accept side: `...(await importOriginal())!` was clean
		// on master; the shared unwrap covers non_null_expression.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal())!, a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a comment between await and the importOriginal call", () => {
		// Review F2 accept side: a comment is a named child in this grammar,
		// so operand picks must filter it through the shared seam.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await // why\n importOriginal()), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a generic pass-through that spreads a different module", () => {
		// Review F1a reject side: the generic form must be identical to the
		// no-argument form, which flags `...(await importOriginal("./other.js"))`.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(
				moduleFile,
				"export const b = 1;\nexport const c = 2;\n",
			);
			fs.writeFileSync(
				importerFile,
				'import { b, c } from "./module.js"; export { b, c };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./other.js")>("./other.js")), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b", "c"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a two-statement binding that awaits a different module", () => {
		// Review F1b reject side: the alias value carries the same
		// wrong-module argument through the two-statement entry point.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(
				moduleFile,
				"export const b = 1;\nexport const c = 2;\n",
			);
			fs.writeFileSync(
				importerFile,
				'import { b, c } from "./module.js"; export { b, c };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => { const actual = await importOriginal<typeof import("./other.js")>("./other.js"); return { ...actual, a: 1 }; });\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b", "c"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a generic spread with no call parentheses", () => {
		// Criterion-1 reverse direction: `...(await importOriginal)` (no
		// call) is not a pass-through, and neither is its generic twin.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./module.js")>), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a simple-type-argument spread that passes a value", () => {
		// Pins the await-in-callee branch's zero-argument check: deleting it
		// lets `...(await importOriginal<T>("./other.js"))` read as complete.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\ntype T = typeof import("./module.js");\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal<T>("./other.js")), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a no-argument-form spread that passes a value", () => {
		// Pins the await branch's zero-argument check, the twin the generic
		// form must match.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal("./other.js")), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a parenthesised spread that passes a value", () => {
		// Reject twin of the parenthesised accept: parens must not launder
		// an argument either.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...((await importOriginal("./other.js"))), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags an as-cast spread that passes a value", () => {
		// Reject twin of the as-cast accepts: the cast unwrap must not skip
		// the argument check underneath.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal("./other.js") as any), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a satisfies spread that passes a value", () => {
		// Reject twin of the satisfies accept.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal("./other.js") satisfies Record<string, unknown>), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a non-null-asserted spread that passes a value", () => {
		// Reject twin of the non-null accept.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal("./other.js"))!, a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a commented spread that passes a value", () => {
		// Reject twin of the comment accept: filtering the comment must not
		// filter the argument check with it.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await // why\n importOriginal("./other.js")), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a spread of the factory binding itself without await", () => {
		// The shared leaf helper only names the binding; the awaited-call
		// shape around it still has to hold, or `...importOriginal()` would
		// read as a pass-through of the factory function itself.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...importOriginal(), a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a spread alias bound to a non-awaited value", () => {
		// Pins that aliases enter the set only through an awaited binding:
		// collecting every same-named declarator would launder this object.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => { const actual = {}; return { ...actual, a: 1 }; });\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a two-statement generic binding with no call parentheses", () => {
		// Alias-path twin of the no-call spread: the declaration proves its
		// trailing `()` through error recovery, so a bare instantiation
		// keeps flagging even though its value node matches the valid shape.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => { const actual = await importOriginal<typeof import("./module.js")>; return { ...actual, a: 1 }; });\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("flags a spread laundered by a nested-helper binding", () => {
		// Review F3 reject side: the only awaited `actual` binding lives
		// inside a nested helper, so the top-level spread keeps flagging.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const importerFile = path.join(root, "importer.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(
				importerFile,
				'import { b } from "./module.js"; export { b };\n',
			);
			const source =
				'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => { function helper() { const actual = await importOriginal(); return actual; } return { ...actual, a: 1 }; });\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores export names mentioned only in comments and strings", () => {
		// Guard against prose laundering a source scan into a false importer use.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			const source =
				'// vi.mock("./module.js", () => ({ b: 1 }));\nconst text = "vi.mock(\\\"./module.js\\\", () => ({ b: 1 }))";\nvi.mock("./module.js", () => ({ a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips node and non-TypeScript mock specifiers", () => {
		// Guard against scanning .mjs and node: mocks as TypeScript production modules.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleDir = path.join(root, ".probe-vi-m.mjs");
			const testFile = path.join(root, "case.test.ts");
			fs.mkdirSync(moduleDir);
			fs.writeFileSync(
				path.join(moduleDir, "index.ts"),
				"export const b = 1;\n",
			);
			const source =
				'vi.mock("./.probe-vi-m.mjs", () => ({ a: 1 }));\nvi.mock("node:fs", () => ({ a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source, "all")).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("warns when production gains an omitted export", () => {
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const testFile = path.join(root, "case.test.ts");
			const source = 'vi.mock("./module.js", () => ({ a: 1 }));\n';
			fs.writeFileSync(
				moduleFile,
				"export const a = 1;\nexport const b = 2;\n",
			);
			fs.writeFileSync(testFile, source);
			const finding = findViMockExportGaps(testFile, source, "all");
			const admissionKey = key(finding[0]);
			expect(
				compareAgainstBaseline(finding, { [admissionKey]: 0 }),
			).toMatchObject({
				problems: [],
				warnings: [expect.stringContaining("b")],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reds when a factory drops a previously provided export", () => {
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const testFile = path.join(root, "case.test.ts");
			const source =
				'import { a, b } from "./module.js";\nvi.mock("./module.js", () => ({ a: 1 }));\n';
			fs.writeFileSync(moduleFile, "export const a = 1; export const b = 2;\n");
			fs.writeFileSync(testFile, source);
			const finding = findViMockExportGaps(testFile, source);
			const admitted = {
				[`${relativePosix(REPO_ROOT, finding[0].file)}:./module.js:["a","b"]`]: 0,
			};
			expect(
				compareAgainstBaseline(finding, admitted).problems.join("\n"),
			).toContain("regression");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the admission key stable when lines move", () => {
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const testFile = path.join(root, "case.test.ts");
			const before =
				'import { b } from "./module.js";\nvi.mock("./module.js", () => ({ a: 1 }));\n';
			const after = `// inserted\n${before}`;
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(testFile, after);
			const first = findViMockExportGaps(testFile, before)[0];
			const second = findViMockExportGaps(testFile, after)[0];
			expect(key(first)).toBe(key(second));
			expect(key(second)).not.toContain(`:${second.line}:`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("makes line-key mutation red", () => {
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const testFile = path.join(root, "case.test.ts");
			const source =
				'import { b } from "./module.js";\nvi.mock("./module.js", () => ({ a: 1 }));\n';
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			fs.writeFileSync(testFile, source);
			const finding = findViMockExportGaps(testFile, source)[0];
			const oldKey = `${relativePosix(REPO_ROOT, finding.file)}:${finding.line}:${finding.specifier}`;
			expect(
				compareAgainstBaseline([finding], { [oldKey]: 1 }).problems.length,
			).toBeGreaterThan(0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps factory fingerprints injective and code-unit ordered", () => {
		const finding = (factoryProperties: string[]): ViMockExportFinding => ({
			file: path.join(REPO_ROOT, "tests/config/case.test.ts"),
			specifier: "./module.js",
			productionFile: path.join(REPO_ROOT, "clients/module.ts"),
			missing: [],
			factoryProperties,
			line: 1,
		});
		expect(key(finding(["a,b"]))).not.toBe(key(finding(["a", "b"])));
		expect(
			Object.keys(baselineFrom([finding(["a", "_"]), finding(["a", "Z"])])),
		).toEqual([
			'tests/config/case.test.ts:./module.js:["Z","a"]',
			'tests/config/case.test.ts:./module.js:["_","a"]',
		]);
	});

	it.skipIf(!!process.env.VI_MOCK_EXPORT_REGEN)(
		"reports every omitted production export and warns on newly omitted exports",
		() => {
			const findings = scan();
			const result = compareAgainstBaseline(findings, BASELINE);
			if (result.warnings.length > 0)
				process.stderr.write(
					`${result.warnings.map((warning) => `WARNING ${warning}`).join("\n")}\n`,
				);
			process.stderr.write(
				`vi-mock-export-sweep: ${result.warnings.length} warning row(s)\n`,
			);
			expect(result.problems, result.problems.join("\n")).toEqual([]);
		},
		60_000,
	);

	it.skipIf(!!process.env.VI_MOCK_EXPORT_REGEN)(
		"baseline entries remain live",
		() => {
			const findings = scan();
			const live = new Set(findings.map(key));
			const dead = Object.keys(BASELINE).filter((entry) => !live.has(entry));
			expect(dead).toEqual([]);
		},
		60_000,
	);

	it.skipIf(!process.env.VI_MOCK_EXPORT_REGEN)(
		"regenerates the baseline",
		() => {
			fs.writeFileSync(
				path.join(REPO_ROOT, "tests/support/vi-mock-export-baseline.json"),
				`${JSON.stringify(baselineFrom(scan()), null, "\t")}\n`,
			);
		},
		60_000,
	);
});
