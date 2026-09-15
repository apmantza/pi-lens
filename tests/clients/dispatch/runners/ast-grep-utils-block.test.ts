import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import astGrepNapiRunner, {
	evaluateAstGrepRules,
	resetAstGrepUnsupportedLanguageLog,
} from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import type { Diagnostic } from "../../../../clients/dispatch/types.js";
import {
	linesFor,
	makeRealRunnerEnv,
	napiFallbackHasTool,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: (entry: unknown) => logLatency(entry),
}));
vi.mock("../../../../clients/lsp/wait-policy/index.js", () => ({
	resolveAstGrepNativeExe: () => undefined,
}));

const RULES_DIR = path.join(process.cwd(), "rules", "ast-grep-rules", "rules");

let env: RealRunnerEnv;
beforeAll(() => {
	env = makeRealRunnerEnv({ hasTool: napiFallbackHasTool });
});
afterAll(() => env.cleanup());

async function diagnosticsOn(
	code: string,
	sampleFile = "sample.ts",
	log: (message: string) => void = () => {},
): Promise<Diagnostic[]> {
	const { ctx } = env.addFile(sampleFile, code, { log });
	return (await astGrepNapiRunner.run(ctx)).diagnostics;
}

describe("ast-grep NAPI utils: block passthrough (#663)", () => {
	it("passes utils through the TypeScript no-dupe-keys rule", async () => {
		const diagnostics = await diagnosticsOn(
			[
				"const duplicate = { a: 1, a: 2 };",
				"const distinct = { a: 1, b: 2 };",
				"const keyAndMethod = { a: 1, a() {} };",
				"",
			].join("\n"),
		);

		expect(linesFor(diagnostics, "no-dupe-keys")).toEqual([1, 3]);
	});

	it("runs TSX-tagged utils rules on TSX files", async () => {
		const diagnostics = await diagnosticsOn(
			[
				"function usePlain() { return 42; }",
				"function useRealHook() { useEffect(() => {}); }",
				"const [value, setValue] = useState<number>(0);",
				"",
			].join("\n"),
			"sample.tsx",
		);
		expect(linesFor(diagnostics, "unnecessary-react-hook")).toEqual([1]);
		expect(linesFor(diagnostics, "redundant-usestate-type")).toEqual([3]);
	});

	it("does not cross-fire TSX-tagged rules on TypeScript files", async () => {
		const diagnostics = await diagnosticsOn(
			"function usePlain() { return 42; }\nconst [value, setValue] = useState<number>(0);\n",
			"sample.ts",
		);
		expect(linesFor(diagnostics, "unnecessary-react-hook")).toEqual([]);
		expect(linesFor(diagnostics, "redundant-usestate-type")).toEqual([]);
	});

	it("aggregates unsupported-language skips into latency telemetry", async () => {
		resetAstGrepUnsupportedLanguageLog();
		logLatency.mockClear();
		const logs: string[] = [];
		await diagnosticsOn("const value = 1;\n", "sample.ts", (message) =>
			logs.push(message),
		);

		expect(
			logs.filter((message) => message.includes("unsupported language")),
		).toEqual([]);
		const entries = logLatency.mock.calls
			.map(
				([entry]) =>
					entry as { phase?: string; metadata?: Record<string, unknown> },
			)
			.filter(
				(entry) => entry.phase === "astgrep_napi_unsupported_rules_skipped",
			);
		expect(entries).toHaveLength(1);
		const skipped = entries[0].metadata?.skippedByLanguage as Record<
			string,
			{ count: number; ruleIds: string[]; route?: string }
		>;
		const python = skipped.python;
		expect(python.ruleIds.length).toBeGreaterThan(0);
		expect(python.ruleIds.length).toBeLessThanOrEqual(5);
		expect(python.count).toBeGreaterThanOrEqual(python.ruleIds.length);

		// #2215 review F1: the `route` annotation is only worth emitting if it
		// is read back off the RECORD. Pinning `deliveryRouteForRuleLanguage`
		// alone leaves the wiring free to be deleted while every test stays
		// green. Both of `skipRouteFor`'s branches land in this one record, so
		// assert one of each. `python` has no bundled napi grammar, so its
		// rules deliver through the ast-grep LSP/CLI. A `mismatch:` key is a
		// language this engine DOES serve that simply is not this file's
		// grammar, so it still routes through napi on its own files.
		expect(python.route).toBe("ast-grep-lsp-cli");
		expect(skipped["mismatch:javascript->typescript"]?.route).toBe("napi");
		// No key may go unrouted: `unclassified` is the runtime signal that
		// rules ship for a language nobody decided a delivery route for.
		expect(
			Object.entries(skipped)
				.filter(([, value]) => value.route !== "ast-grep-lsp-cli")
				.filter(([, value]) => value.route !== "napi")
				.map(([key]) => key),
		).toEqual([]);
	});

	it("dedupes unsupported-language telemetry across files and resets per session", async () => {
		resetAstGrepUnsupportedLanguageLog();
		logLatency.mockClear();
		const root = { findAll: () => [] };
		const first = env.addFile("first.ts", "const value = 1\n").filePath;
		const second = env.addFile("second.ts", "const value = 2\n").filePath;
		const options = { log: () => {} };
		evaluateAstGrepRules(first, root, env.cwd, "python", options);
		evaluateAstGrepRules(second, root, env.cwd, "python", options);
		let entries = logLatency.mock.calls.filter(
			([entry]) =>
				(entry as { phase?: string }).phase ===
				"astgrep_napi_unsupported_rules_skipped",
		);
		expect(entries).toHaveLength(1);

		resetAstGrepUnsupportedLanguageLog();
		evaluateAstGrepRules(first, root, env.cwd, "python", options);
		entries = logLatency.mock.calls.filter(
			([entry]) =>
				(entry as { phase?: string }).phase ===
				"astgrep_napi_unsupported_rules_skipped",
		);
		expect(entries).toHaveLength(2);
		const python = (entries[0][0] as { metadata: any }).metadata
			.skippedByLanguage.python;
		expect(python.count).toBeGreaterThan(python.ruleIds.length);
		expect(python.ruleIds).toHaveLength(5);
	});

	it("logs each unsupported rule once for a shared dedup set", async () => {
		const { filePath } = env.addFile("sample.py", "value = 1\n");
		const { evaluateAstGrepRules } =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
		logLatency.mockClear();
		const logs: string[] = [];
		const options = {
			log: (message: string) => logs.push(message),
			unsupportedLanguageLog: new Set<string>(),
		};
		const root = { findAll: () => [] };
		evaluateAstGrepRules(filePath, root, env.cwd, "python", options);
		evaluateAstGrepRules(filePath, root, env.cwd, "python", options);

		expect(
			logs.filter((message) => message.includes("unsupported language")),
		).toEqual([]);
		const entries = logLatency.mock.calls
			.map(
				([entry]) =>
					entry as { phase?: string; metadata?: Record<string, unknown> },
			)
			.filter(
				(entry) => entry.phase === "astgrep_napi_unsupported_rules_skipped",
			);
		expect(entries).toHaveLength(1);
		const languages = entries[0].metadata?.skippedByLanguage as Record<
			string,
			{ ruleIds: string[] }
		>;
		expect(languages.python.ruleIds.length).toBeGreaterThan(0);
	});

	it("passes utils through the JavaScript no-dupe-keys twin", async () => {
		const diagnostics = await diagnosticsOn(
			"const duplicate = { a: 1, a: 2 };\nconst distinct = { a: 1, b: 2 };\n",
			"sample.js",
		);
		expect(linesFor(diagnostics, "no-dupe-keys-js")).toEqual([1]);
	});

	it("keeps no-dupe-class-members scoped to actual duplicates", async () => {
		const diagnostics = await diagnosticsOn(
			[
				"class DuplicateMethod { foo() {} foo() {} }",
				"class DuplicateField { foo = 1; foo = 2; }",
				"class Distinct { foo() {} bar() {} }",
				"class AccessorPair { get value() {} set value(next) {} }",
				"",
			].join("\n"),
		);
		expect(linesFor(diagnostics, "no-dupe-class-members")).toEqual([1, 2]);
	});

	it("preserves utils when parsing the Rust rule covered by the CLI suite", async () => {
		const { loadYamlRulesUncached } =
			await import("../../../../clients/dispatch/runners/yaml-rule-parser.js");
		const rule = loadYamlRulesUncached(RULES_DIR).find(
			(candidate) => candidate.id === "rust-2024-let-chain-candidate",
		);
		expect(rule, "rust-2024-let-chain-candidate rule not found").toBeTruthy();
		expect(rule?.utils && Object.keys(rule.utils).length > 0).toBe(true);
	});
});
