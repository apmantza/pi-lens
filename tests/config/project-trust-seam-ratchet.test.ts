/**
 * #4281: in-process module doubles must use the module's real test seam.
 * Recurrence: a project-trust mock hid a newly-added export and let callers
 * exercise a second module instance instead of the process singleton.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

export const SEAM_MODULES = [
	{
		module: "clients/project-trust.js",
		seam: ["setProjectTrustState", "resetProjectTrust"],
	},
];

const BASELINE: Record<string, number> = {
	"clients/project-trust.js": 1,
};

function countViMockSites(source: string, moduleName: string): number {
	const structure = stripSource(source);
	let count = 0;
	for (const match of structure.matchAll(/\bvi\s*\.\s*mock\s*\(\s*/g)) {
		const start = match.index ?? 0;
		const argument = source
			.slice(start)
			.match(/^vi\s*\.\s*mock\s*\(\s*["']([^"']+)["']/);
		if (argument?.[1].endsWith(moduleName)) count++;
	}
	return count;
}

function counts(): Record<string, number> {
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith("fixtures/"),
	});
	assertNonEmptyScan("#4281 project-trust seam ratchet", files.length, 900);
	const result = Object.fromEntries(
		SEAM_MODULES.map(({ module }) => [module, 0]),
	);
	for (const { source } of readWalkedFiles(files)) {
		for (const { module } of SEAM_MODULES)
			result[module] += countViMockSites(source, module);
	}
	return result;
}

describe("project-trust real seam ratchet (#4281)", () => {
	it("keeps every seam module's whole-module mock population at or below baseline", () => {
		const live = counts();
		for (const { module } of SEAM_MODULES) {
			expect(live[module]).toBeGreaterThan(0);
			expect(live[module]).toBeLessThanOrEqual(BASELINE[module]);
		}
	});

	it("counts executable vi.mock calls while ignoring comments and strings", () => {
		const source = [
			'// vi.mock("./clients/project-trust.js")',
			"const text = 'vi.mock(\"./clients/project-trust.js\")';",
			'vi.mock("../../clients/project-trust.js", () => ({}));',
		].join("\n");
		expect(countViMockSites(source, "clients/project-trust.js")).toBe(1);
	});
});
