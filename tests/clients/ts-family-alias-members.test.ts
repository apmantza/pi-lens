/**
 * Shape 42 ("Language-specific rule"): the TypeScript family is `.ts`, `.tsx`,
 * `.mts` and `.cts`, one registry fact (`isTypeScriptFile`,
 * `clients/language-registry.ts`; the JS/TS source family is `isJstsFactFile`,
 * `clients/file-kinds.ts`). Seventeen consumers spelled it by hand
 * (`/\.tsx?$/`, `[".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]`), and every
 * copy left `.mts`/`.cts` out. A `.mts` file therefore read as unchecked for
 * the fact rules, the autofix policy and the project scan, with no notice.
 *
 * Each cell enters through the production caller of one member site and runs
 * the same input under every TypeScript-family extension:
 *
 * - the fact providers and rules, through the registered `runProviders` then
 *   `evaluateRules` pair the dispatcher and the scanner both call;
 * - the autofix and linter policy lookups `runAutofix` calls;
 * - the project scan (`scanProjectDiagnostics`), which gates fact rules on its
 *   own extension set.
 *
 * Recurrence guarded: the pre-fix tree answers `.ts` and `.tsx` and refuses
 * `.mts` and `.cts` at every cell below.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import "../../clients/dispatch/integration.js";
import { evaluateRules } from "../../clients/dispatch/fact-rule-runner.js";
import { runProviders } from "../../clients/dispatch/fact-runner.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import type { DispatchContext } from "../../clients/dispatch/types.js";
import { detectFileKind } from "../../clients/file-kinds.js";
import { isTypeScriptFile } from "../../clients/language-registry.js";
import { isTsProjectFile } from "../../clients/lsp/inferred-project.js";
import { scanProjectDiagnostics } from "../../clients/project-diagnostics/scanner.js";
import {
	getAutofixPolicyForFile,
	getLinterPolicyForFile,
} from "../../clients/tool-policy.js";
import { setupTestEnvironment } from "./test-utils.js";

const TS_FAMILY = [".ts", ".tsx", ".mts", ".cts"] as const;

const SOURCE = [
	"export function handle(res: unknown) {",
	'\t(res as { setHeader(n: string, v: string): void }).setHeader("Access-Control-Allow-Origin", "*");',
	'\t// password: "hunter2hunter2"',
	"\t// add more validation here",
	'\ttry { JSON.parse("{"); } catch (e) {}',
	"}",
	"",
].join("\n");

/** The registered providers, then the registered rules: the scanner's path. */
async function ruleFindings(filePath: string): Promise<string[]> {
	const facts = new FactStore();
	const ctx = {
		filePath,
		cwd: "/tmp",
		kind: detectFileKind(filePath),
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
		hasTool: async () => false,
		log: () => {},
	} as DispatchContext;
	facts.setFileFact(filePath, "file.content", SOURCE);
	await runProviders(ctx);
	return evaluateRules(ctx)
		.map((d) => d.rule)
		.filter((rule): rule is string => typeof rule === "string")
		.sort();
}

describe("TypeScript family: one registry fact, four extensions (shape 42)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("answers true for every TypeScript-family extension and false for plain JavaScript", () => {
		for (const ext of TS_FAMILY) {
			expect(isTypeScriptFile(`/repo/src/a${ext}`)).toBe(true);
		}
		for (const ext of [".js", ".jsx", ".mjs", ".cjs", ".py", ".vue"]) {
			expect(isTypeScriptFile(`/repo/src/a${ext}`)).toBe(false);
		}
	});

	it("runs the same four fact rules on every TypeScript-family file", async () => {
		const expected = [
			"cors-wildcard",
			"error-swallowing",
			"no-commented-credentials",
			"placeholder-comments",
		];
		for (const ext of TS_FAMILY) {
			const rules = await ruleFindings(`/tmp/handler${ext}`);
			expect(
				expected.filter((rule) => !rules.includes(rule)),
				`${ext} lost a fact rule`,
			).toEqual([]);
		}
	});

	it("keeps the credential-fixture exemption on every TypeScript-family file", async () => {
		for (const ext of TS_FAMILY) {
			const rules = await ruleFindings(`/tmp/secrets-scanner${ext}`);
			expect(rules, `${ext} fixture file`).not.toContain(
				"no-commented-credentials",
			);
		}
	});

	it("gives every JS/TS source file an autofix and a linter policy", () => {
		for (const ext of [...TS_FAMILY, ".js", ".jsx", ".mjs", ".cjs"]) {
			const file = `/repo/src/a${ext}`;
			expect(getAutofixPolicyForFile(file), `autofix ${ext}`).toBeDefined();
			expect(getLinterPolicyForFile(file), `linter ${ext}`).toBeDefined();
		}
	});

	it("keeps the tsserver project gate on all eight JS/TS extensions", () => {
		for (const ext of [...TS_FAMILY, ".js", ".jsx", ".mjs", ".cjs"]) {
			expect(isTsProjectFile(`/repo/src/a${ext}`), ext).toBe(true);
		}
		expect(isTsProjectFile("/repo/src/a.vue")).toBe(false);
	});

	it("scans the same findings in .mts and .cts as in .ts through the project scan", async () => {
		const env = setupTestEnvironment("pi-lens-ts-family-");
		cleanups.push(env.cleanup);
		fs.writeFileSync(path.join(env.tmpDir, "package.json"), '{"name":"x"}');
		for (const ext of TS_FAMILY) {
			fs.writeFileSync(path.join(env.tmpDir, `handler${ext}`), SOURCE);
		}
		const snapshot = await scanProjectDiagnostics({
			cwd: env.tmpDir,
			tier: "cheap",
		});
		const byFile = (name: string) =>
			snapshot.diagnostics
				.filter((d) => path.basename(d.filePath) === name)
				.map((d) => d.rule)
				.filter(
					(rule): rule is string =>
						rule === "cors-wildcard" || rule === "error-swallowing",
				)
				.sort();
		const reference = byFile("handler.ts");
		expect(reference).toEqual(["cors-wildcard", "error-swallowing"]);
		for (const ext of TS_FAMILY) {
			expect(byFile(`handler${ext}`), `handler${ext}`).toEqual(reference);
		}
	});
});
