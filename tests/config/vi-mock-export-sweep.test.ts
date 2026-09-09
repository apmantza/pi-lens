/**
 * #2281 / #2784 wave 2: whole-module `vi.mock` factories must not drop
 * production exports. Recurrences: #2272 and #2782.
 *
 * The sweep uses importer-use reachability over the test's direct production
 * imports and one production-importer hop. The measured all-export fallback
 * would flag 509 sites, while the selected rule flags 29 actionable sites.
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
const BASELINE: Record<string, string[]> = JSON.parse(
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
	return `${relativePosix(REPO_ROOT, finding.file)}:${finding.line}:${finding.specifier}`;
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
			fs.writeFileSync(importerFile, 'import { b } from "./module.js"; export { b };\n');
			const source = 'import "./importer.js";\nvi.mock("./module.js", () => ({ a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source)).toMatchObject([
				{ missing: ["b"] },
			]);
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
			fs.writeFileSync(importerFile, 'import { b } from "./module.js"; export { b };\n');
			const source = 'import "./importer.js";\nvi.mock("./module.js", async (importOriginal) => ({ ...(await importOriginal()), a: 1 }));\n';
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
			const source = '// import { b } from "./module.js";\nconst text = "b";\nvi.mock("./module.js", () => ({ a: 1 }));\n';
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
			fs.writeFileSync(path.join(moduleDir, "index.ts"), "export const b = 1;\n");
			const source = 'vi.mock("./.probe-vi-m.mjs", () => ({ a: 1 }));\nvi.mock("node:fs", () => ({ a: 1 }));\n';
			fs.writeFileSync(testFile, source);
			expect(findViMockExportGaps(testFile, source, "all")).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports every omitted production export with a file:line and specifier", () => {
		const findings = scan();
		const live = new Map(findings.map((finding) => [key(finding), finding]));
		const problems: string[] = [];
		for (const [entry, finding] of live) {
			const before = BASELINE[entry];
			if (before === undefined) {
				problems.push(
					`${entry}: regression; missing ${finding.missing.join(", ")}`,
				);
			} else if (finding.missing.join("\0") !== before.join("\0")) {
				problems.push(
					`${entry}: missing export set changed from ${before.join(", ")} to ${finding.missing.join(", ")}; ` +
						`missing ${finding.missing.join(", ")}`,
				);
			}
		}
		for (const entry of Object.keys(BASELINE)) {
			if (!live.has(entry))
				problems.push(`${entry}: ratchet down; offender was fixed`);
		}
		expect(problems, problems.join("\n")).toEqual([]);
	}, 60_000);

	it("baseline entries remain live", () => {
		const findings = scan();
		const live = new Set(findings.map(key));
		const dead = Object.keys(BASELINE).filter((entry) => !live.has(entry));
		expect(dead).toEqual([]);
	}, 60_000);
});
