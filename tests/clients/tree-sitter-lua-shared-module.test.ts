/**
 * Regression test for #255 — lua must NOT corrupt to ERROR trees once a second
 * grammar loads into web-tree-sitter's process-global WASM Module.
 *
 * The aggregator (tree-sitter-wasms@0.1.13) lua wasm parsed correctly only as the
 * SOLE grammar; any second grammar turned every subsequent lua parse into an ERROR
 * tree, silently emptying lua symbol search / imports / module_report in every
 * multi-language repo. Fixed by pulling lua from @tree-sitter-grammars (a source
 * override). This test loads other grammars first, then asserts lua still parses
 * cleanly and extracts symbols + imports.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

function countErrorNodes(node: { type: string; children?: unknown[] }): number {
	let n = 0;
	const stack: Array<{ type: string; children?: unknown[] }> = [node];
	while (stack.length) {
		const cur = stack.pop();
		if (!cur) continue;
		if (cur.type === "ERROR") n++;
		for (const c of cur.children ?? [])
			stack.push(c as { type: string; children?: unknown[] });
	}
	return n;
}

describe("lua survives the shared WASM Module (#255)", () => {
	let client: TreeSitterClient;
	beforeAll(async () => {
		client = new TreeSitterClient();
		await client.init();
	});

	it("parses lua cleanly AFTER other grammars have loaded", async () => {
		const env = setupTestEnvironment("pi-lens-lua255-");
		try {
			// Load several other grammars into the shared Module first — this is what
			// used to poison lua.
			for (const [lang, file, src] of [
				["python", "a.py", "import os\n"],
				["go", "a.go", "package main\nfunc main() {}\n"],
				["javascript", "a.js", "const x = 1;\n"],
			] as const) {
				await client.parseFile(createTempFile(env.tmpDir, file, src), lang, src);
			}

			const luaSrc =
				'local helper = require("mod.helper")\nfunction M.run(x) return helper.go(x) end\nlocal function util() end\n';
			const fp = createTempFile(env.tmpDir, "m.lua", luaSrc);
			const tree = await client.parseFile(fp, "lua", luaSrc);
			expect(tree).toBeTruthy();
			// The regression: this was 2 ERROR nodes (a corrupt tree).
			expect(countErrorNodes(tree!.rootNode)).toBe(0);

			const ex = new TreeSitterSymbolExtractor("lua", client);
			expect(await ex.init()).toBe(true);
			const result = ex.extract(tree!, fp, luaSrc);
			const names = result.symbols.map((s) => s.name);
			expect(names).toContain("M.run");
			expect(names).toContain("util");
			expect((result.imports ?? []).map((i) => i.source)).toContain(
				"mod.helper",
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("overridden yaml grammar loads (#427)", () => {
	it("parses yaml cleanly (aggregator wasm was ABI-unloadable)", async () => {
		const env = setupTestEnvironment("pi-lens-yaml427-");
		try {
			const client = new TreeSitterClient();
			await client.init();
			// Load a second grammar first, mirroring a real multi-language session.
			const py = createTempFile(env.tmpDir, "a.py", "import os\n");
			await client.parseFile(py, "python", "import os\n");

			const yamlSrc = "foo: 1\nbar:\n  - a\n  - b\n";
			const fp = createTempFile(env.tmpDir, "c.yaml", yamlSrc);
			const tree = await client.parseFile(fp, "yaml", yamlSrc);
			// Regression: the aggregator yaml wasm failed Language.load → null tree.
			expect(tree).toBeTruthy();
			expect(countErrorNodes(tree!.rootNode)).toBe(0);
		} finally {
			env.cleanup();
		}
	});
});
