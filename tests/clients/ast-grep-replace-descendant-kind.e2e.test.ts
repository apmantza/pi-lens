// flake-shape: real-process-spawn — Real sg execution proves CLI match behavior; a runner stub cannot exercise the binary.
/**
 * End-to-end proof that `ast_grep_replace`'s new `hasDescendantKind` param
 * (#1423) actually changes match behavior against the real ast-grep CLI —
 * not just that it parses into YAML. `hasKind` is ast-grep's default
 * immediate-child `has` (stopBy: neighbor); `hasDescendantKind` is the
 * explicit recursive form (stopBy: end). A target whose matching kind sits
 * a level below the immediate child (nested inside an `if` block) must
 * match under `hasDescendantKind` but NOT under `hasKind`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AstGrepClient } from "../../clients/ast-grep-client.js";
import { synthesizeReplaceRule } from "../../clients/ast-grep-yaml-synth.js";

describe("ast_grep_replace hasDescendantKind — real ast-grep CLI behavioral proof (#1423)", () => {
	let tmpDir: string;
	let filePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-hdk-"));
		filePath = path.join(tmpDir, "sample.ts");
		// `await deepCall()` is nested two levels below the function_declaration's
		// immediate child (statement_block -> if_statement -> statement_block ->
		// expression_statement -> await_expression) — NOT an immediate child.
		fs.writeFileSync(
			filePath,
			[
				"async function outer() {",
				"  if (true) {",
				"    await deepCall();",
				"  }",
				"}",
			].join("\n"),
			"utf8",
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("hasKind (immediate child) does NOT match a deep descendant", async () => {
		const client = new AstGrepClient();
		expect(await client.ensureAvailable()).toBe(true);
		const ruleYaml = synthesizeReplaceRule({
			pattern: "async function $NAME() { $$$BODY }",
			lang: "typescript",
			rewrite: "async function $NAME() { /* matched */ $$$BODY }",
			hasKind: "await_expression",
		});
		const result = await client.replaceWithRule(ruleYaml, [filePath], false);
		expect(result.error).toBeUndefined();
		expect(result.matches).toHaveLength(0);
	});

	it("hasDescendantKind (recursive) DOES match the same deep descendant", async () => {
		const client = new AstGrepClient();
		expect(await client.ensureAvailable()).toBe(true);
		const ruleYaml = synthesizeReplaceRule({
			pattern: "async function $NAME() { $$$BODY }",
			lang: "typescript",
			rewrite: "async function $NAME() { /* matched */ $$$BODY }",
			hasDescendantKind: "await_expression",
		});
		const result = await client.replaceWithRule(ruleYaml, [filePath], false);
		expect(result.error).toBeUndefined();
		expect(result.matches).toHaveLength(1);
	});
});
