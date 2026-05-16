import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	getQueryLanguageKey,
	isDisabledQueryFilePath,
	TreeSitterQueryLoader,
} from "../../clients/tree-sitter-query-loader.js";

const tmpDirs: string[] = [];

function writeRule(root: string, relPath: string, content: string): void {
	const filePath = path.join(root, relPath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function makeTempRulesRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-query-loader-"));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("tree-sitter query loader metadata parsing", () => {
	it("parses cwe/owasp/confidence in inline arrays", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/meta-inline.yml",
			`id: meta-inline
name: Meta Inline
severity: warning
category: security
language: typescript
message: test
query: |
  (identifier) @X
metavars: [X]
cwe: [CWE-327, CWE-330]
owasp: [A02]
confidence: high
defect_class: injection
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("meta-inline");
		expect(query).toBeTruthy();
		expect(query?.cwe).toEqual(["CWE-327", "CWE-330"]);
		expect(query?.owasp).toEqual(["A02"]);
		expect(query?.confidence).toBe("high");
	});

	it("parses multiline arrays with comments and quoted confidence", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/python/meta-multiline.yml",
			`id: meta-multiline
name: Meta Multiline
severity: warning
category: security
language: python
message: test
query: |
  (identifier) @X
metavars:
  - X
cwe:
  - CWE-89 # SQLi
  - CWE-22
owasp:
  - A03
  - A01
confidence: "medium"
defect_class: injection
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("meta-multiline");
		expect(query).toBeTruthy();
		expect(query?.cwe).toEqual(["CWE-89", "CWE-22"]);
		expect(query?.owasp).toEqual(["A03", "A01"]);
		expect(query?.confidence).toBe("medium");
	});

	it("preserves tree-sitter predicates in query blocks", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/predicate-preserve.yml",
			`id: predicate-preserve
name: Predicate Preserve
severity: warning
category: correctness
language: typescript
message: test
query: |
  (call_expression
    function: (member_expression
      object: (identifier) @OBJ
      property: (property_identifier) @FN))
  (#eq? @OBJ "Math")
  (#eq? @FN "random")
metavars:
  - OBJ
  - FN
defect_class: correctness
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("predicate-preserve");
		expect(query).toBeTruthy();
		expect(query?.query).toContain('#eq? @OBJ "Math"');
		expect(query?.query).toContain('#eq? @FN "random"');
	});

	it("loads disabled-directory rules for tests but excludes them from production language queries", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/python-disabled/disabled-example.yml",
			`id: disabled-example
name: Disabled Example
severity: warning
category: correctness
language: python
message: test
query: |
  (identifier) @X
metavars:
  - X
defect_class: correctness
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(loader.getAllQueries().map((q) => q.id)).toContain(
			"disabled-example",
		);
		expect(
			loader.getQueriesForLanguage("python").map((q) => q.id),
		).not.toContain("disabled-example");
	});

	it("detects disabled query paths independent of path separator", () => {
		expect(getQueryLanguageKey("typescript-disabled")).toBe("typescript");
		expect(
			isDisabledQueryFilePath(
				"rules/tree-sitter-queries/typescript-disabled/ts-path-traversal.yml",
			),
		).toBe(true);
		expect(
			isDisabledQueryFilePath(
				"rules\\tree-sitter-queries\\typescript-disabled\\ts-path-traversal.yml",
			),
		).toBe(true);
		expect(
			isDisabledQueryFilePath(
				"rules/tree-sitter-queries/typescript/console-statement.yml",
			),
		).toBe(false);
	});
});
