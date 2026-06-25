/**
 * Import-extraction smoke test (#249) — one case per supported grammar.
 *
 * For every language with an IMPORT_QUERIES entry, parse a fixture with the
 * SHIPPED tree-sitter WASM and assert the import sources extract. This is a
 * regression guard against grammar drift (a grammar update that breaks a query
 * shows up here, not as silently-missing import edges in the review graph).
 *
 * NOTE: this exercises import extraction specifically. Several languages'
 * *symbol* (defs/refs) queries are currently broken against their shipped
 * grammars (kotlin/php/ocaml/dart) — tracked separately; the extractor's
 * per-query-independent init means a broken symbol query no longer disables
 * imports, which is exactly what this test locks in.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

interface ImportCase {
	file: string;
	src: string;
	expect: string[];
}

const CASES: Record<string, ImportCase> = {
	// TS/JS imports go through the TS compiler in the WARM review graph; these
	// IMPORT_QUERIES entries (#301) feed the COLD module_report path. ESM import +
	// re-export sources extract; CJS require is intentionally out of scope.
	typescript: {
		file: "a.ts",
		src: 'import { a } from "./local";\nimport express from "express";\nexport { b } from "./reexport";\n',
		expect: ["./local", "express", "./reexport"],
	},
	tsx: {
		file: "a.tsx",
		src: 'import { a } from "./local";\nimport React from "react";\n',
		expect: ["./local", "react"],
	},
	// C/C++ #include (#302) — local "foo.h" (quotes stripped) + system <stdio.h>
	// (angle brackets kept so the bucketer can tell local from system).
	c: {
		file: "a.c",
		src: '#include "foo.h"\n#include <stdio.h>\nint main(void) { return 0; }\n',
		expect: ["foo.h", "<stdio.h>"],
	},
	cpp: {
		file: "a.cpp",
		src: '#include "bar.hpp"\n#include <vector>\nint main() { return 0; }\n',
		expect: ["bar.hpp", "<vector>"],
	},
	python: {
		file: "a.py",
		src: "import os\nfrom os.path import join\n",
		expect: ["os", "os.path"],
	},
	go: {
		file: "a.go",
		src: 'package m\nimport (\n\t"fmt"\n\t"strings"\n)\n',
		expect: ["fmt", "strings"],
	},
	rust: { file: "a.rs", src: "use std::io;\n", expect: ["std::io"] },
	java: {
		file: "A.java",
		src: "import java.util.List;\n",
		expect: ["java.util.List"],
	},
	kotlin: {
		file: "A.kt",
		src: "import kotlin.collections.List\n",
		expect: ["kotlin.collections.List"],
	},
	csharp: {
		file: "A.cs",
		src: "using System;\nusing System.Collections.Generic;\n",
		expect: ["System", "System.Collections.Generic"],
	},
	swift: {
		file: "A.swift",
		src: "import Foundation\n",
		expect: ["Foundation"],
	},
	php: { file: "a.php", src: "<?php\nuse App;\n", expect: ["App"] },
	ocaml: { file: "a.ml", src: "open Core\n", expect: ["Core"] },
	dart: { file: "a.dart", src: 'import "dart:io";\n', expect: ["dart:io"] },
	// Call/builtin-based imports (#249 coverage expansion) — predicate-filtered.
	// lua is omitted on purpose: its tree parses to ERROR once a 2nd grammar
	// loads into the shared WASM Module (#255), so it can't be exercised through
	// the shared client here. Its validated import query is recorded on #255.
	ruby: {
		file: "a.rb",
		src: 'require "json"\nrequire_relative "./foo"\nputs "hi"\n',
		expect: ["json", "./foo"],
	},
	zig: {
		file: "a.zig",
		src: 'const std = @import("std");\nconst f = @import("foo.zig");\n',
		expect: ["std", "foo.zig"],
	},
	elixir: {
		file: "a.ex",
		src: "defmodule M do\n  import Foo\n  alias Bar.Baz\n  require Logger\n  use GenServer\nend\n",
		expect: ["Foo", "Bar.Baz", "Logger", "GenServer"],
	},
	bash: {
		file: "a.sh",
		src: "source ./lib.sh\n. ./other.sh\necho hi\n",
		expect: ["./lib.sh", "./other.sh"],
	},
};

let client: TreeSitterClient;
beforeAll(async () => {
	client = new TreeSitterClient();
	await client.init();
});

describe("tree-sitter import extraction (#249) — per supported grammar", () => {
	for (const [lang, c] of Object.entries(CASES)) {
		it(`extracts imports for ${lang}`, async () => {
			const env = setupTestEnvironment(`pi-lens-imp-${lang}-`);
			try {
				const fp = createTempFile(env.tmpDir, c.file, c.src);
				const tree = await client.parseFile(fp, lang);
				expect(tree).toBeTruthy();
				const extractor = new TreeSitterSymbolExtractor(lang, client);
				expect(await extractor.init()).toBe(true);
				const sources = extractor
					.extract(tree, fp, c.src)
					.imports.map((i) => i.source);
				for (const expected of c.expect) {
					expect(sources).toContain(expected);
				}
			} finally {
				env.cleanup();
			}
		});
	}
});
