import { logLatency } from "../../latency-logger.js";
import type { FactProvider } from "../fact-provider-types.js";
import {
	childrenOfType,
	firstChildOfType,
	parseFactTree,
	type TsNode,
	walk,
} from "./tree-sitter-facts.js";

export interface ImportEntry {
	/** Module specifier, e.g. "node:fs", "./utils.js", "react" */
	source: string;
	/** Named imports: ["readFile", "writeFile"] */
	names: string[];
	/** Default import name, if any */
	defaultName?: string;
	/** Namespace import alias, if any (import * as X) */
	namespace?: string;
	/** True when this is a dynamic import() call rather than a static import declaration. */
	isDynamic?: boolean;
	/** ESM (import/export), CJS (require/module.exports), or unknown. */
	moduleType?: "esm" | "cjs" | "unknown";
}

/** Re-export edge: this file re-exports names from another module. */
export interface ReExportEntry {
	/** Source module being re-exported from. */
	source: string;
	/** Names re-exported. Empty array means `export * from '...'`. */
	names: string[];
}

// JS/TS extensions this provider handles (→ tree-sitter typescript/tsx/javascript
// grammars via resolveTreeSitterLanguage). Ported off the `typescript` compiler API
// onto tree-sitter (#402) — the parse is served from the shared, cached client.
const JSTS_EXTS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
]);

function stripQuotes(raw: string): string {
	return raw.replace(/^["'`]+|["'`]+$/g, "");
}

/** Parse a top-level `import_statement` node into an ImportEntry. */
function parseStaticImport(
	node: TsNode,
	moduleType: "esm" | "cjs" | "unknown",
): ImportEntry | null {
	const sourceNode = firstChildOfType(node, "string");
	if (!sourceNode) return null;
	const source = stripQuotes(sourceNode.text);

	const clause = firstChildOfType(node, "import_clause");
	if (!clause) {
		// `import "reflect-metadata";` — side-effect only, no bindings.
		return { source, names: [], moduleType };
	}

	const entry: ImportEntry = { source, names: [], moduleType };
	for (const child of clause.children ?? []) {
		if (!child) continue;
		if (child.type === "identifier") {
			// `import React from ...` — default binding is a bare identifier.
			entry.defaultName = child.text;
		} else if (child.type === "namespace_import") {
			// `import * as fs from ...`
			const id = firstChildOfType(child, "identifier");
			if (id) entry.namespace = id.text;
		} else if (child.type === "named_imports") {
			// `import { a, b as c } from ...` — the local binding is the alias when
			// present (last identifier of the specifier), else the imported name.
			for (const spec of childrenOfType(child, "import_specifier")) {
				const ids = childrenOfType(spec, "identifier");
				const local = ids.length ? ids[ids.length - 1].text : undefined;
				if (local) entry.names.push(local);
			}
		}
	}
	return entry;
}

/** Parse a top-level `export_statement` into a ReExportEntry, or null if it isn't a
 *  re-export (a plain `export const x` has no `from` source). */
function parseReExport(node: TsNode): ReExportEntry | null {
	const sourceNode = firstChildOfType(node, "string");
	if (!sourceNode) return null; // not `export ... from '...'`
	const source = stripQuotes(sourceNode.text);

	const clause = firstChildOfType(node, "export_clause");
	if (!clause) {
		// `export * from '...'`
		return { source, names: [] };
	}
	const names: string[] = [];
	for (const spec of childrenOfType(clause, "export_specifier")) {
		const ids = childrenOfType(spec, "identifier");
		// Exported name is the alias when present (`a as b` → b), else the name.
		const name = ids.length ? ids[ids.length - 1].text : undefined;
		if (name) names.push(name);
	}
	return { source, names };
}

export const importFactProvider: FactProvider = {
	id: "fact.file.imports",
	provides: ["file.imports", "file.reexports"],
	requires: ["file.content"],
	appliesTo(ctx) {
		const ext = ctx.filePath.slice(ctx.filePath.lastIndexOf(".")).toLowerCase();
		return JSTS_EXTS.has(ext);
	},
	async run(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		const setEmpty = () => {
			store.setFileFact(ctx.filePath, "file.imports", []);
			store.setFileFact(ctx.filePath, "file.reexports", []);
		};
		if (!content) {
			setEmpty();
			return;
		}

		// Grammar unavailable / parse failed / wasm aborted — degrade to empty
		// (there is no typescript-compiler fallback by design, #402).
		const root = await parseFactTree(ctx.filePath, content);
		if (!root) {
			setEmpty();
			return;
		}

		// --- module-type detection + static import/re-export node collection ---
		let hasEsm = false;
		let hasCjs = false;
		const importNodes: TsNode[] = [];
		const reExportNodes: TsNode[] = [];

		for (const child of root.children ?? []) {
			if (!child) continue;
			if (child.type === "import_statement") {
				hasEsm = true;
				importNodes.push(child);
			} else if (child.type === "export_statement") {
				const isReExport = Boolean(firstChildOfType(child, "string"));
				// `export { x }` / `export * from` / `export { x } from` are ESM
				// declarations (like TS's isExportDeclaration); `export const x` /
				// `export default` (a wrapped declaration) is NOT counted here.
				if (isReExport || firstChildOfType(child, "export_clause")) {
					hasEsm = true;
				}
				if (isReExport) reExportNodes.push(child);
			}
		}

		// --- dynamic import() / require() / module.exports (anywhere in the tree) ---
		const dynamicRaw: Array<{ source: string; kind: "import" | "require" }> = [];
		walk(root, (node) => {
			if (node.type === "call_expression") {
				const callee = node.children?.[0];
				const args = firstChildOfType(node, "arguments");
				const strArg = args ? firstChildOfType(args, "string") : undefined;
				if (!strArg) return; // non-string arg (e.g. template literal) — skip
				const source = stripQuotes(strArg.text);
				if (callee?.type === "import") {
					dynamicRaw.push({ source, kind: "import" });
				} else if (callee?.type === "identifier" && callee.text === "require") {
					dynamicRaw.push({ source, kind: "require" });
					hasCjs = true;
				}
			} else if (node.type === "member_expression") {
				// module.exports = ...
				const obj = node.children?.[0];
				if (obj?.type === "identifier" && obj.text === "module") {
					const prop = firstChildOfType(node, "property_identifier");
					if (prop?.text === "exports") hasCjs = true;
				}
			}
		});

		const moduleType: "esm" | "cjs" | "unknown" =
			hasEsm && !hasCjs
				? "esm"
				: hasCjs && !hasEsm
					? "cjs"
					: hasEsm || hasCjs
						? "esm" // mixed — static imports present, treat as ESM
						: "unknown";

		// --- build entries ---
		const imports: ImportEntry[] = [];
		for (const node of importNodes) {
			const entry = parseStaticImport(node, moduleType);
			if (entry) imports.push(entry);
		}
		let dynamicCount = 0;
		for (const d of dynamicRaw) {
			if (d.kind === "import") {
				imports.push({
					source: d.source,
					names: [],
					isDynamic: true,
					moduleType,
				});
			} else {
				imports.push({ source: d.source, names: [], moduleType: "cjs" });
			}
			dynamicCount++;
		}
		store.setFileFact(ctx.filePath, "file.imports", imports);

		const reexports: ReExportEntry[] = [];
		for (const node of reExportNodes) {
			const r = parseReExport(node);
			if (r) reexports.push(r);
		}
		store.setFileFact(ctx.filePath, "file.reexports", reexports);

		// Telemetry: log when a file has dynamic imports or re-exports so we can
		// measure coverage and validate the implementation across real projects.
		if (dynamicCount > 0 || reexports.length > 0) {
			logLatency({
				type: "call_graph_facts" as any,
				filePath: ctx.filePath,
				durationMs: 0,
				metadata: {
					moduleType,
					staticImports: imports.length - dynamicCount,
					dynamicImports: dynamicCount,
					reexports: reexports.length,
					starReexports: reexports.filter((r) => r.names.length === 0).length,
				},
			});
		}
	},
};
