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
