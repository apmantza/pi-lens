import { describe, expect, it } from "vitest";
import {
	importFactProvider,
	type ImportEntry,
	type ReExportEntry,
} from "../../../clients/dispatch/facts/import-facts.js";

// Minimal FactStore stub for testing the provider in isolation
function makeStore(content: string) {
	const facts = new Map<string, unknown>();
	facts.set("file.content", content);
	return {
		getFileFact: <T>(_file: string, key: string) => facts.get(key) as T | undefined,
		setFileFact: (_file: string, key: string, value: unknown) => {
			facts.set(key, value);
		},
		getAll: (key: string) => facts.get(key),
	};
}

// The provider parses via the shared tree-sitter client, so run() is async now.
async function runProvider(filePath: string, content: string) {
	const store = makeStore(content);
	await importFactProvider.run({ filePath } as any, store as any);
	return {
		imports: (store.getAll("file.imports") as ImportEntry[]) ?? [],
		reexports: (store.getAll("file.reexports") as ReExportEntry[]) ?? [],
	};
}

describe("importFactProvider — static imports", () => {
	it("extracts named imports with moduleType esm", async () => {
		const { imports } = await runProvider("f.ts", `import { readFile, writeFile } from "node:fs";`);
		expect(imports).toHaveLength(1);
		expect(imports[0]).toMatchObject({
			source: "node:fs",
			names: ["readFile", "writeFile"],
			moduleType: "esm",
		});
	});

	it("extracts default import", async () => {
		const { imports } = await runProvider("f.ts", `import React from "react";`);
		expect(imports[0]).toMatchObject({ source: "react", defaultName: "React", moduleType: "esm" });
	});

	it("extracts namespace import", async () => {
		const { imports } = await runProvider("f.ts", `import * as fs from "node:fs";`);
		expect(imports[0]).toMatchObject({ source: "node:fs", namespace: "fs", moduleType: "esm" });
	});

	it("extracts side-effect-only import (no clause)", async () => {
		const { imports } = await runProvider("f.ts", `import "reflect-metadata";`);
		expect(imports[0]).toMatchObject({ source: "reflect-metadata", names: [], moduleType: "esm" });
	});

	it("uses the local binding for aliased named imports", async () => {
		const { imports } = await runProvider("f.ts", `import { readFile as rf } from "node:fs";`);
		expect(imports[0]).toMatchObject({ source: "node:fs", names: ["rf"] });
	});

	it("extracts a combined default + named import", async () => {
		const { imports } = await runProvider("f.ts", `import React, { useState } from "react";`);
		expect(imports[0]).toMatchObject({
			source: "react",
			defaultName: "React",
			names: ["useState"],
		});
	});

	// Grammar smoke: .tsx routes to the tsx grammar (not typescript). Guards against
	// the tsx grammar failing to parse/extract (the class of regression that would
	// otherwise silently yield empty imports — cf. the init() gap during the port).
	it("extracts imports from .tsx files (tsx grammar + JSX body)", async () => {
		const { imports } = await runProvider(
			"c.tsx",
			`import { useState } from "react";\nexport const C = () => <div className="x" />;\n`,
		);
		expect(imports).toHaveLength(1);
		expect(imports[0]).toMatchObject({
			source: "react",
			names: ["useState"],
			moduleType: "esm",
		});
	});
});

describe("importFactProvider — dynamic imports", () => {
	it("captures dynamic import() calls as isDynamic entries", async () => {
		// File also has a static import → ESM detected
		const { imports } = await runProvider("f.ts", `
import { something } from "./base.js";
const mod = await import("./heavy-module.js");
`);
		const dynamic = imports.find((i) => i.isDynamic);
		expect(dynamic).toBeDefined();
		expect(dynamic).toMatchObject({
			source: "./heavy-module.js",
			isDynamic: true,
			moduleType: "esm",
		});
	});

	it("dynamic import() alone yields unknown moduleType (ambiguous)", async () => {
		const { imports } = await runProvider("f.ts", `
const mod = await import("./heavy-module.js");
`);
		const dynamic = imports.find((i) => i.isDynamic);
		expect(dynamic).toBeDefined();
		expect(dynamic?.moduleType).toBe("unknown");
	});

	it("captures require() calls as cjs entries", async () => {
		const { imports } = await runProvider("f.ts", `
const fs = require("node:fs");
const path = require("node:path");
`);
		const cjsImports = imports.filter((i) => i.moduleType === "cjs");
		expect(cjsImports).toHaveLength(2);
		expect(cjsImports.map((i) => i.source)).toContain("node:fs");
		expect(cjsImports.map((i) => i.source)).toContain("node:path");
	});

	it("captures nested dynamic import inside a function body", async () => {
		const { imports } = await runProvider("f.ts", `
async function loadPlugin(name: string) {
  const plugin = await import(\`./plugins/\${name}\`);
  return plugin;
}
const mod = await import("./static-path.js");
`);
		const dynamic = imports.filter((i) => i.isDynamic);
		// The string-literal one is captured; the template literal is not (non-string arg)
		expect(dynamic).toHaveLength(1);
		expect(dynamic[0].source).toBe("./static-path.js");
	});
});

describe("importFactProvider — moduleType detection", () => {
	it("detects pure ESM files", async () => {
		const { imports } = await runProvider("f.ts", `
import { foo } from "./foo.js";
export const bar = 1;
`);
		expect(imports.every((i) => i.moduleType === "esm")).toBe(true);
	});

	it("detects pure CJS files", async () => {
		const { imports } = await runProvider("f.ts", `
const fs = require("node:fs");
module.exports = { fs };
`);
		expect(imports.every((i) => i.moduleType === "cjs")).toBe(true);
	});

	it("treats mixed ESM+CJS files as esm (static imports present)", async () => {
		const { imports } = await runProvider("f.ts", `
import something from "./esm.js";
const legacy = require("./cjs.js");
`);
		const esmEntry = imports.find((i) => i.source === "./esm.js");
		expect(esmEntry?.moduleType).toBe("esm");
	});
});

describe("importFactProvider — re-export edges", () => {
	it("captures named re-exports", async () => {
		const { reexports } = await runProvider("f.ts", `
export { readFile, writeFile } from "node:fs";
`);
		expect(reexports).toHaveLength(1);
		expect(reexports[0]).toMatchObject({
			source: "node:fs",
			names: ["readFile", "writeFile"],
		});
	});

	it("captures star re-exports as empty names array", async () => {
		const { reexports } = await runProvider("barrel.ts", `
export * from "./utils.js";
export * from "./helpers.js";
`);
		expect(reexports).toHaveLength(2);
		expect(reexports.every((r) => r.names.length === 0)).toBe(true);
		expect(reexports.map((r) => r.source)).toContain("./utils.js");
	});

	it("does not include re-exports in imports", async () => {
		const { imports, reexports } = await runProvider("barrel.ts", `
export { foo } from "./foo.js";
import { bar } from "./bar.js";
`);
		expect(reexports).toHaveLength(1);
		expect(reexports[0].source).toBe("./foo.js");
		// The import is in imports, not re-exports
		expect(imports.some((i) => i.source === "./bar.js")).toBe(true);
		expect(imports.some((i) => i.source === "./foo.js")).toBe(false);
	});

	it("does not treat a plain `export const` as a re-export", async () => {
		const { reexports } = await runProvider("f.ts", `export const value = 1;\n`);
		expect(reexports).toHaveLength(0);
	});

	it("empty reexports for files with no re-exports", async () => {
		const { reexports } = await runProvider("f.ts", `import { foo } from "./foo.js";`);
		expect(reexports).toHaveLength(0);
	});
});

describe("importFactProvider — appliesTo", () => {
	it.each([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])(
		"applies to %s files",
		(ext) => {
			expect(importFactProvider.appliesTo({ filePath: `src/foo${ext}` } as any)).toBe(true);
		},
	);

	it.each([".py", ".go", ".rs", ".java", ".rb"])(
		"does not apply to %s files",
		(ext) => {
			expect(importFactProvider.appliesTo({ filePath: `src/foo${ext}` } as any)).toBe(false);
		},
	);

	it("extracts imports from .js files", async () => {
		const { imports } = await runProvider("f.js", `import { foo } from "./foo.js";`);
		expect(imports).toHaveLength(1);
		expect(imports[0]).toMatchObject({ source: "./foo.js", moduleType: "esm" });
	});

	it("extracts require() from .cjs files", async () => {
		const { imports } = await runProvider("f.cjs", `const fs = require("node:fs");`);
		const req = imports.find((i) => i.source === "node:fs");
		expect(req).toMatchObject({ source: "node:fs", moduleType: "cjs" });
	});

	it("extracts re-exports from .mjs files", async () => {
		const { reexports } = await runProvider("barrel.mjs", `export * from "./utils.js";`);
		expect(reexports).toHaveLength(1);
		expect(reexports[0].source).toBe("./utils.js");
	});
});
