/**
 * #4281: in-process module doubles must use the module's real test seam.
 * Recurrence: a project-trust mock hid a newly-added export and let callers
 * exercise a second module instance instead of the process singleton.
 */

import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
} from "../support/sweep-kit.js";
import { isViMockCall, unquote } from "../support/vi-mock-export-gate.js";

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

/**
 * Both the hoisted `vi.mock` and the non-hoisted `vi.doMock` replace a whole
 * module, so the ratchet owns both. The structural {@link isViMockCall}
 * (shared with the export gate) answers dot, bracket and spaced forms; this is
 * the one caller that widens its property set.
 */
const MOCK_METHODS = ["mock", "doMock"] as const;

/**
 * Resolve a module specifier to its module identity: posix separators, any
 * relative depth, and a `.js`/`.ts`/extensionless spelling all name the same
 * module. Comparing the trailing `clients/<name>` path (never a raw
 * `endsWith("…js")`) keeps a nested same-named file from counting.
 */
function resolvesToModule(specifier: string, moduleName: string): boolean {
	const strip = (value: string) =>
		value.replace(/\\/g, "/").replace(/\.(?:[cm]?[jt]s)$/, "");
	const candidate = strip(specifier);
	const modulePath = strip(moduleName);
	return candidate === modulePath || candidate.endsWith(`/${modulePath}`);
}

function countViMockSites(source: string, moduleName: string): number {
	const calls = parse(Lang.TypeScript, source)
		.root()
		.findAll({ rule: { kind: "call_expression" } });
	let count = 0;
	for (const call of calls) {
		if (!isViMockCall(call.field("function"), MOCK_METHODS)) continue;
		const argument = call.field("arguments")?.namedChildren()[0];
		const specifier = argument ? unquote(argument.text()) : undefined;
		if (specifier && resolvesToModule(specifier, moduleName)) count++;
	}
	return count;
}

function seamBaseName(module: string): string {
	return module.replace(/^.*\//, "").replace(/\.(?:js|ts)$/, "");
}

async function counts(): Promise<Record<string, number>> {
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith("fixtures/"),
	});
	assertNonEmptyScan("#4281 project-trust seam ratchet", files.length, 900);
	const result = Object.fromEntries(
		SEAM_MODULES.map(({ module }) => [module, 0]),
	);
	for (const { source } of readWalkedFiles(files)) {
		// Parse only files that name a seam module: every mock spelling the
		// liveness case pins carries the module's base name as text, so the
		// substring test keeps the population exact and skips ~900 AST parses
		// (the unfiltered loop timed out in CI at 5000 ms, #4285 verify).
		const named = SEAM_MODULES.filter(({ module }) =>
			source.includes(seamBaseName(module)),
		);
		if (named.length === 0) continue;
		for (const { module } of named)
			result[module] += countViMockSites(source, module);
		// Turn the loop between files so `@ast-grep/napi` can free each parsed
		// tree from its finalizer before the next one is built (the
		// `vi-mock-export-sweep` memory bound, #3565).
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return result;
}

describe("project-trust real seam ratchet (#4281)", () => {
	it("keeps every seam module's whole-module mock population at or below baseline", async () => {
		const live = await counts();
		for (const { module } of SEAM_MODULES) {
			expect(live[module]).toBeLessThanOrEqual(BASELINE[module]);
		}
	});

	// Liveness: a detector that silently counts zero would pass the shrink-only
	// assertion above, so the known sites are pinned here. The comment and the
	// string literal must not count; each executable spelling must (shape 34:
	// the unlisted `doMock`/`.ts`/backtick/bracket forms are the point).
	it("detects executable mocks and ignores comments and strings", () => {
		const source = [
			'// vi.mock("../clients/project-trust.js")',
			"const text = 'vi.mock(\"../clients/project-trust.js\")';",
			'vi.mock("../clients/project-trust.js", () => ({}));',
			'vi.doMock("../clients/project-trust.js", () => ({}));',
			'vi.mock("../clients/project-trust.ts", () => ({}));',
			"vi.mock(`../clients/project-trust.js`, () => ({}));",
			'vi["mock"]("../clients/project-trust.js", () => ({}));',
			'vi.doMock("../clients/other.js", () => ({}));',
		].join("\n");
		expect(countViMockSites(source, "clients/project-trust.js")).toBe(5);
	});
});
