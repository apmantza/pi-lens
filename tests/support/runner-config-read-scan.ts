/**
 * Detector behind `tests/config/runner-config-presence-census.test.ts` (#5408):
 * which dispatch-runner modules reach the filesystem, a directory climb or a
 * config finder directly instead of asking `clients/tool-config-presence.ts`.
 *
 * Fail closed (AGENTS.md shape 34/69): a runner module is CLEAN only when every
 * import it makes is a form this file lists as safe. It reads the AST, never
 * text, so a comment or a string that merely mentions `node:fs` is not a hit.
 * Any module, name or ambient reach the scan does not recognise is a MEMBER:
 * it needs a row in the census (with the reason) or an admission here.
 *
 * STATE TABLE (every form not named as admitted is a member):
 *
 * | form                                                                   | verdict  |
 * |------------------------------------------------------------------------|----------|
 * | `import type ...`, `import { type X }`                                 | admitted |
 * | fs module (`fs`, `node:fs`, `fs/promises`, `node:fs/promises`), any    | member   |
 * |   clause shape, `export ... from`, `require()`, `import()`             |          |
 * | `node:module`                                                          | member   |
 * | bare specifier other than `node:path`, `path`, `node:crypto`           | member   |
 * | `import x = require(...)` (no `source` field)                          | member   |
 * | relative module under `clients/dispatch/` (not `runners/utils.js`)     | admitted |
 * | `runners/utils.js` (its one export, `readFileContent`, reads a file)   | member   |
 * | `clients/<module>` listed in ADMITTED_CLIENT_MODULES as `"*"`          | admitted |
 * | `clients/<module>` listed with names: each imported name (an alias     | per name |
 * |   does not change it) must be listed; default / namespace / `export *` | member   |
 * |   / `require()` / `import()` of it                                     |          |
 * | `clients/<module>` not listed, or a module outside `clients/`          | member   |
 * | `require(x)` / `import(x)` with a non-literal or template argument     | member   |
 * | the identifier `require` used other than as a call callee              | member   |
 * | `process` used other than as `process.<cwd|platform|env|pid|execPath>` | member   |
 * |   (an alias, `process[...]`, `process.getBuiltinModule`, destructuring)|          |
 * | `globalThis`, any identifier spelled `getBuiltinModule`                | member   |
 *
 * It cannot see a config read made by a helper module the runner imports from
 * `clients/dispatch/` or by a listed `"*"` module: that transitive reach is the
 * stated residual, and the list below is where a module is judged.
 */
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";

type SgNode = ReturnType<ReturnType<typeof parse>["root"]>;

const FS_MODULES = new Set([
	"fs",
	"node:fs",
	"fs/promises",
	"node:fs/promises",
]);
const MODULE_MODULES = new Set(["module", "node:module"]);
const ADMITTED_BARE = new Set(["node:path", "path", "node:crypto"]);
const RUNNERS_DIR = "clients/dispatch/runners";
const PROCESS_PROPERTIES = new Set([
	"cwd",
	"platform",
	"env",
	"pid",
	"execPath",
]);

const PURE_PATH_HELPERS = [
	"pathsEqual",
	"toPosix",
	"relativeInside",
	"isWithinIdentity",
	"normalizeMapKey",
	"normalizeEphemeralMapKey",
	"realpathOrResolve",
	"isAbsoluteFilePath",
	"isUnderDir",
	"toProjectRelativePath",
];
/** The policy layer's own lookups: they answer from the policy table. */
const POLICY_LOOKUPS = [
	"getLinterPolicyForCwd",
	"getAutofixCapability",
	"getJstsLintPolicyForCwd",
	"getToolCommandSpec",
	"shouldAutoInstallTool",
	"getRubocopCommand",
];
const PYTHON_ENVIRONMENT_NAMES = [
	"augmentPythonEnvironment",
	"describePythonCompileWithheld",
	"detectPythonEnvironment",
	"partitionOutrankedPythonCompileVerdicts",
	"recordPythonCompileVerdictDrop",
];

/**
 * `clients/` modules a runner may import without a row, by path under
 * `clients/` without the extension. `"*"` admits every name: the module does
 * not decide whether a tool is configured (logging, spawning, caching, trust,
 * binary lookup #5410, root resolution). A list admits only those names.
 * Anything absent here, notably `workspace-topology`, `project-lens-config`
 * and the tool-policy finders, makes the importing runner a census member.
 */
const ADMITTED_CLIENT_MODULES: Readonly<
	Record<string, "*" | readonly string[]>
> = {
	"path-utils": PURE_PATH_HELPERS,
	"tool-policy": POLICY_LOOKUPS,
	"python-environment": PYTHON_ENVIRONMENT_NAMES,
	"tool-config-presence": "*",
	"analysis-root": "*",
	"availability-probe-flight": "*",
	"bounded-cache": "*",
	"bounded-telemetry": "*",
	"cache/rule-cache": "*",
	"command-path": "*",
	"degradation-ledger": "*",
	"dependency-checker": "*",
	"deps/ast-grep-napi": "*",
	"deps/js-yaml": "*",
	"env-utils": "*",
	"extension-log": "*",
	"file-kinds": "*",
	"file-utils": "*",
	"generation-guard": "*",
	"go-client": "*",
	"installer/index": "*",
	"language-policy": "*",
	"latency-logger": "*",
	"ledger-bounds": "*",
	"lsp/capabilities": "*",
	"lsp/config": "*",
	"lsp/content-limits": "*",
	"lsp/diagnostic-binding": "*",
	"lsp/inferred-project": "*",
	"lsp/pending-aux-coverage": "*",
	"lsp/server-covers": "*",
	"lsp/server-traits": "*",
	"lsp/server": "*",
	"lsp/session-roots": "*",
	"lsp/client": "*",
	"lsp/tsserver-sync": "*",
	"mcp/ipc": "*",
	"package-manager": "*",
	"package-root": "*",
	"path-keyed-map": "*",
	"project-trust": "*",
	"review-graph/service": "*",
	"runtime-config": "*",
	"rust-client": "*",
	"safe-spawn": "*",
	sanitize: "*",
	"scanner-temp-root": "*",
	"session-repository": "*",
	"sessionstart-logger": "*",
	sgconfig: "*",
	"shell-dialect": "*",
	"single-flight": "*",
	"spawn-output-cap": "*",
	"spawn-timeout-cooldown": "*",
	"string-utils": "*",
	"tool-cwd": "*",
	"tool-probe": "*",
	"tree-sitter-client": "*",
	"tree-sitter-logger": "*",
	"tree-sitter-query-loader": "*",
	"tree-sitter-shared": "*",
	"trivy-client": "*",
	"warm-attach": "*",
};

const stripQuotes = (text: string): string =>
	text.replace(/^["'`]|["'`]$/g, "");

type Imported = { names: string[]; whole: boolean };

/** Why `specifier`, imported as `imported`, makes the module a member; undefined when admitted. */
function specifierReason(
	specifier: string,
	imported: Imported,
	file: string,
): string | undefined {
	if (FS_MODULES.has(specifier)) return `import of ${specifier}`;
	if (MODULE_MODULES.has(specifier)) {
		return `import of ${specifier} (createRequire reaches fs)`;
	}
	if (!specifier.startsWith(".")) {
		return ADMITTED_BARE.has(specifier)
			? undefined
			: `import of unlisted module ${specifier}`;
	}
	const resolved = path.posix
		.normalize(
			path.posix.join(RUNNERS_DIR, path.posix.dirname(file), specifier),
		)
		.replace(/\.(?:js|ts)$/, "");
	if (resolved === `${RUNNERS_DIR}/utils`) {
		return `import of ${specifier} (readFileContent reads a file)`;
	}
	if (resolved.startsWith("clients/dispatch/")) return undefined;
	const admitted = resolved.startsWith("clients/")
		? ADMITTED_CLIENT_MODULES[resolved.replace(/^clients\//, "")]
		: undefined;
	if (admitted === "*") return undefined;
	if (admitted === undefined) return `import of unlisted module ${specifier}`;
	if (imported.whole) return `import of ${specifier} as a whole module`;
	const outside = imported.names.filter((name) => !admitted.includes(name));
	return outside.length
		? `import of ${outside.join(", ")} from ${specifier}`
		: undefined;
}

/** The names a static import or `export ... from` takes; `whole` for any form that hides them. */
function importedNames(node: SgNode): Imported {
	const names: string[] = [];
	let whole =
		node.kind() === "export_statement" &&
		!node.find({ rule: { kind: "export_clause" } });
	if (node.find({ rule: { kind: "namespace_import" } })) whole = true;
	const clause = node.find({ rule: { kind: "import_clause" } });
	if (clause) {
		const named = clause.find({ rule: { kind: "named_imports" } });
		// A default binding sits beside `{...}` or alone: its names cannot be checked.
		const hasDefault = clause
			.children()
			.some((child) => child.kind() === "identifier");
		if (hasDefault || !named) whole = true;
	}
	for (const spec of node.findAll({
		rule: { any: [{ kind: "import_specifier" }, { kind: "export_specifier" }] },
	})) {
		if (/^type\s/.test(spec.text())) continue;
		names.push(spec.field("name")?.text() ?? spec.text());
	}
	return { names, whole };
}

/**
 * Why the module is a member, one entry per offending form; empty when clean.
 * `file` is the module's path under `clients/dispatch/runners/` (posix), which
 * resolves its relative specifiers.
 */
export function configReadReasons(source: string, file = "x.ts"): string[] {
	const reasons = new Set<string>();
	const root = parse(Lang.TypeScript, source).root();
	for (const node of root.findAll({
		rule: {
			any: [
				{ kind: "import_statement" },
				{ kind: "export_statement" },
				{ kind: "call_expression" },
				{ kind: "identifier", regex: "^(?:process|require|globalThis)$" },
				{ regex: "^getBuiltinModule$" },
			],
		},
	})) {
		const kind = node.kind();
		if (kind === "import_statement" || kind === "export_statement") {
			if (/^(?:import|export)\s+type\b/.test(node.text())) continue;
			const sourceNode = node.field("source");
			if (!sourceNode) {
				if (kind === "import_statement") {
					reasons.add("import without a resolvable source (import = require)");
				}
				continue;
			}
			const reason = specifierReason(
				stripQuotes(sourceNode.text()),
				importedNames(node),
				file,
			);
			if (reason) reasons.add(`${kind}: ${reason}`);
		} else if (kind === "call_expression") {
			const name = node.field("function")?.text() ?? "";
			if (/(?:^|\.)getBuiltinModule$/.test(name)) {
				reasons.add("getBuiltinModule call");
			} else if (name === "require" || name === "import") {
				const arg = node.field("arguments")?.child(1);
				if (!arg || arg.kind() !== "string") {
					reasons.add(`${name}() with an unresolvable argument`);
					continue;
				}
				const reason = specifierReason(
					stripQuotes(arg.text()),
					{ names: [], whole: true },
					file,
				);
				if (reason) reasons.add(`${name}(): ${reason}`);
			}
		} else if (kind === "identifier" && node.text() === "process") {
			const parent = node.parent();
			const property = parent?.field("property")?.text() ?? "";
			const isMemberObject =
				parent?.kind() === "member_expression" &&
				parent.field("object")?.id() === node.id();
			if (!isMemberObject || !PROCESS_PROPERTIES.has(property)) {
				reasons.add("process reached other than by a listed property");
			}
		} else if (kind === "identifier" && node.text() === "require") {
			const parent = node.parent();
			const isCallee =
				parent?.kind() === "call_expression" &&
				parent.field("function")?.id() === node.id();
			if (!isCallee) reasons.add("require used as a value");
		} else if (node.text() === "globalThis") {
			reasons.add("globalThis");
		} else if (node.text() === "getBuiltinModule") {
			reasons.add("getBuiltinModule named");
		}
	}
	return [...reasons];
}
