/**
 * #2281 / #2784 wave 2: whole-module `vi.mock` factories must not drop
 * production exports. Recurrences: #2272 and #2782.
 *
 * The sweep uses transitive importer-use reachability over the test's
 * non-mocked production imports. The master admission contains 605 findings.
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

function key(finding: ViMockExportFinding): string {
	return `${relativePosix(REPO_ROOT, finding.file)}:${finding.specifier}:${finding.factoryProperties.join(",")}`;
}

function baselineFrom(findings: ViMockExportFinding[]): Record<string, number> {
	return Object.fromEntries(
		findings
			.map((finding) => [key(finding), finding.missing.length] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
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

	it("ignores export names mentioned only in comments and strings", () => {
		// Guard against prose laundering a source scan into a false importer use.
		const root = fs.mkdtempSync(path.join(REPO_ROOT, ".probe-vi-mock-"));
		try {
			const moduleFile = path.join(root, "module.ts");
			const testFile = path.join(root, "case.test.ts");
			fs.writeFileSync(moduleFile, "export const b = 1;\n");
			const source =
				'// import { b } from "./module.js";\nconst text = "b";\nvi.mock("./module.js", () => ({ a: 1 }));\n';
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
				[`${relativePosix(REPO_ROOT, finding[0].file)}:./module.js:a,b`]: 0,
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

	it("reports every omitted production export and warns on newly omitted exports", () => {
		const findings = scan();
		const result = compareAgainstBaseline(findings, BASELINE);
		console.warn(result.warnings.join("\n"));
		expect(result.problems, result.problems.join("\n")).toEqual([]);
	}, 60_000);

	it("baseline entries remain live", () => {
		const findings = scan();
		const live = new Set(findings.map(key));
		const dead = Object.keys(BASELINE).filter((entry) => !live.has(entry));
		expect(dead).toEqual([]);
	}, 60_000);

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
