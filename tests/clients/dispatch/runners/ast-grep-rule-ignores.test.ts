// #965: no-console-except-error should not flag CLI scripts or a logger
// implementation's console fallback/sink, while still flagging accidental
// console output in ordinary application source. Exercises the real
// `ignores` glob carve-out (clients/dispatch/runners/ast-grep-napi.ts +
// clients/dispatch/runners/yaml-rule-parser.ts) end to end through the
// shipped no-console-except-error rule YAML.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import astGrepNapiRunner from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import { loadYamlRules } from "../../../../clients/dispatch/runners/yaml-rule-parser.js";
import { resolveAstGrepNativeExe } from "../../../../clients/lsp/wait-policy/strategies.js";
import { resolveBaselineSgconfig } from "../../../../clients/sgconfig.js";
import { safeSpawnAsync } from "../../../../clients/safe-spawn.js";
import { createTempFile, setupTestEnvironment } from "../../test-utils.js";
import {
	linesFor,
	makeRealRunnerEnv,
	napiFallbackHasTool,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

vi.mock("../../../../clients/lsp/wait-policy/index.js", () => ({
	resolveAstGrepNativeExe: () => undefined,
}));

let env: RealRunnerEnv;
beforeAll(() => {
	env = makeRealRunnerEnv({ hasTool: napiFallbackHasTool });
});
afterAll(() => env.cleanup());

describe("no-console-except-error ignores CLI scripts and logger sinks (#965)", () => {
	it("uses ignores for every VTCode Go rule and covers fixture paths (#2207)", () => {
		const rules = loadYamlRules(
			path.join(process.cwd(), "rules", "ast-grep-rules", "rules"),
		);
		const expected = new Map([
			["no-raw-types", ["**/test/**"]],
			["no-string-concat-in-loop", ["**/test/**"]],
			["no-system-out-println", ["**/test/**", "**/*Test.java"]],
			[
				"go-no-fmt-println",
				["**/*_test.go", "**/examples/**", "tests/fixtures/**", "cases/**"],
			],
			["go-no-panic-in-lib", ["**/*_test.go", "**/cmd/**"]],
			["go-no-underscore-func-name", ["**/*_test.go"]],
			["go-prefer-errors-is", ["**/*_test.go"]],
			["go-prefer-string-builder", ["**/*_test.go"]],
		]);
		for (const [id, ignores] of expected) {
			expect(rules.find((rule) => rule.id === id)).toMatchObject({ ignores });
		}
	});

	it("still flags accidental console.log in ordinary application source", async () => {
		const { ctx } = env.addFile(
			"src/widget.ts",
			'console.log("leftover debug output");\n',
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(linesFor(result.diagnostics, "no-console-except-error")).toEqual([
			1,
		]);
	});

	it("does not flag console output inside scripts/**", async () => {
		const { ctx } = env.addFile(
			"scripts/bench-startup.ts",
			'console.log("benchmark result: 12ms");\n',
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(linesFor(result.diagnostics, "no-console-except-error")).toEqual([]);
	});

	it("does not flag console output inside a logger.ts implementation", async () => {
		const { ctx } = env.addFile(
			"lib/logger.ts",
			"export function warn(msg: string) { console.warn(msg); }\n",
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(linesFor(result.diagnostics, "no-console-except-error")).toEqual([]);
	});
});

/**
 * #2280's three Java rules deliver ONLY through the real ast-grep CLI/LSP
 * engine, never the in-process napi runner: `java` is in
 * `AST_GREP_LSP_ONLY_RULE_LANGUAGES` (ast-grep-napi.ts), so
 * `astGrepNapiRunner.canHandle()` returns false for a `.java` path and
 * `run()` short-circuits to `{status: "skipped"}` before touching a rule.
 * Driving these fixtures through `astGrepNapiRunner.run()` (the original
 * shape of this suite) therefore always produced zero diagnostics — the
 * assertion passed whether or not the fix worked. `matchesRuleIgnores`
 * (ast-grep-napi.ts:471) is a pi-lens-only re-implementation of `ignores:`
 * for the six napi grammars; it never runs for Java. `ignores:` itself is a
 * real ast-grep rule-schema field the native binary honors on its own
 * (issue #2280's evidence), so the only faithful probe is the real CLI
 * against real files — exactly what the issue's acceptance criteria ask
 * for ("Real-file probe ... not just the `ast-grep test` fixture harness").
 *
 * Reuses the production config-assembly seam (`resolveBaselineSgconfig`)
 * so the merged rule set under test is byte-identical to what a live
 * `ast-grep scan`/LSP session would load — no hand-rolled YAML.
 */
describe("Java rule ignores deliver through the real ast-grep CLI (#2280)", () => {
	const astGrepExe = resolveAstGrepNativeExe();
	const skip = !astGrepExe
		? "no native ast-grep binary resolvable for this platform/arch"
		: false;

	interface ScanFinding {
		file: string;
		ruleId: string;
	}

	async function scan(cwd: string): Promise<ScanFinding[]> {
		const configPath = resolveBaselineSgconfig(cwd);
		if (!configPath) throw new Error("no ast-grep rule sources found");
		const result = await safeSpawnAsync(
			astGrepExe as string,
			["scan", "--config", configPath, "--json", cwd],
			{ timeout: 60_000, cwd },
		);
		if (result.error) throw result.error;
		try {
			const parsed: ScanFinding[] = JSON.parse(result.stdout || "[]");
			// ast-grep's `--json` output mixes separators on Windows (a
			// forward-slashed drive root, backslashed path segments below
			// it), so normalize before the suffix checks below compare paths.
			return parsed.map((finding) => ({
				...finding,
				file: finding.file.split("\\").join("/"),
			}));
		} catch {
			throw new Error(
				`failed to parse ast-grep --json output: stdout=${result.stdout.slice(0, 300)} stderr=${result.stderr.slice(0, 300)}`,
			);
		}
	}

	// A body that trips all three rules when unfiltered: a raw `List` (no
	// generic parameter), a `+=` string concatenation inside a `for` loop,
	// and a `System.out.println` call.
	const OFFENDING_BODY = [
		"import java.util.List;",
		"class Example {",
		"  void run() {",
		"    List values = null;",
		'    String text = "";',
		"    for (;;) { text += values; }",
		"    System.out.println(text);",
		"  }",
		"}",
		"",
	].join("\n");

	// Each case spawns the real ast-grep binary over a temp tree. The spawn
	// itself budgets 60s, but vitest's default 5s test timeout did not, so under
	// a loaded worker pool these cases timed out while the scan was still
	// running (#2336). Match the spawn budget, as the other real-binary
	// ast-grep suites already do (ast-grep-rule-tests.test.ts:268).
	(skip ? describe.skip : describe)("with the real binary", () => {
		let env: { tmpDir: string; cleanup: () => void };

		beforeAll(() => {
			env = setupTestEnvironment("pi-lens-java-ignores-");
			// Non-test file: every rule should fire.
			createTempFile(env.tmpDir, "src/Example.java", OFFENDING_BODY);
			// `**/test/**` carve-out: fully excluded, all three rules.
			createTempFile(env.tmpDir, "src/test/Example.java", OFFENDING_BODY);
			// `**/*Test.java` carve-out: no-system-out-println names this glob
			// too, but no-raw-types/no-string-concat-in-loop only ignore
			// `**/test/**`, which an `ExampleTest.java` under `src/` does not
			// match — so this file still fires those two.
			createTempFile(
				env.tmpDir,
				"src/ExampleTest.java",
				OFFENDING_BODY.replace(/Example/g, "ExampleTest"),
			);
		});
		afterAll(() => env.cleanup());

		it("fires all three rules on an ordinary Java file", async () => {
			const findings = await scan(env.tmpDir);
			const ids = new Set(
				findings
					.filter((f) => f.file.endsWith("src/Example.java"))
					.map((f) => f.ruleId),
			);
			expect(ids).toEqual(
				new Set([
					"no-raw-types",
					"no-string-concat-in-loop",
					"no-system-out-println",
				]),
			);
		}, 60_000);

		it("excludes every rule under **/test/**", async () => {
			const findings = await scan(env.tmpDir);
			const hits = findings.filter((f) =>
				f.file.endsWith("src/test/Example.java"),
			);
			expect(hits).toEqual([]);
		}, 60_000);

		it("excludes only no-system-out-println on an *Test.java file", async () => {
			const findings = await scan(env.tmpDir);
			const ids = new Set(
				findings
					.filter((f) => f.file.endsWith("src/ExampleTest.java"))
					.map((f) => f.ruleId),
			);
			expect(ids).toEqual(
				new Set(["no-raw-types", "no-string-concat-in-loop"]),
			);
		}, 60_000);
	});
});
// flake-shape: real-process-spawn — the real ast-grep subprocess boundary is part of rule-ignore contention
