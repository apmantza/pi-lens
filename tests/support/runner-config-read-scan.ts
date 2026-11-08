/**
 * Detector behind `tests/config/runner-config-presence-census.test.ts` (#5408):
 * which dispatch-runner modules reach the filesystem or a directory climb
 * directly instead of asking `clients/tool-config-presence.ts`.
 *
 * Fail closed (AGENTS.md shape 34/69): a module is a MEMBER unless every import
 * it makes is a form the scan knows is safe. It reads the AST, never text, so a
 * comment or a string that merely mentions `node:fs` is not a hit.
 *
 * STATE TABLE (what the scan admits; every other form is a member):
 *
 * | form                                                                 | verdict    |
 * |----------------------------------------------------------------------|------------|
 * | `import ... from "<fs module>"`, any clause shape, incl. `export from`| member     |
 * | `require("<fs module>")` / `import("<fs module>")`                    | member     |
 * | `require(x)` / `import(x)` / template argument (cannot resolve)       | member     |
 * | `process.getBuiltinModule(...)`, any import of `node:module`          | member     |
 * | default / namespace / side-effect-free import of path-utils or        | member     |
 * |   workspace-topology (names cannot be checked)                        |            |
 * | named import of path-utils / workspace-topology whose IMPORTED name   | member     |
 * |   (an alias does not change it) is not a pure path helper             |            |
 * | `import type ...`, `import { type X }`                                | admitted   |
 * | named import of a pure path helper                                    | admitted   |
 * | any other module                                                      | admitted   |
 *
 * It cannot see a config read made by a helper module the runner imports from
 * elsewhere in `clients/`; that transitive reach is the stated residual.
 */
import { Lang, parse } from "@ast-grep/napi";

const FS_MODULES = new Set([
	"fs",
	"node:fs",
	"fs/promises",
	"node:fs/promises",
]);
const MODULE_MODULES = new Set(["module", "node:module"]);
const WALKER_MODULE = /(?:^|\/)(?:path-utils|workspace-topology)\.js$/;
/** Names from path-utils that compare or normalise a path and never touch disk. */
const PURE_PATH_HELPERS = new Set([
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
]);

const stripQuotes = (text: string): string =>
	text.replace(/^["'`]|["'`]$/g, "");

/** Why the module is a member, one entry per offending form; empty when clean. */
export function configReadReasons(source: string): string[] {
	const reasons: string[] = [];
	const root = parse(Lang.TypeScript, source).root();
	const candidates = root.findAll({
		rule: {
			any: [
				{ kind: "import_statement" },
				{ kind: "export_statement" },
				{ kind: "call_expression" },
			],
		},
	});
	for (const node of candidates) {
		const kind = node.kind();
		if (kind === "import_statement" || kind === "export_statement") {
			const sourceNode = node.field("source");
			if (!sourceNode) continue;
			const specifier = stripQuotes(sourceNode.text());
			if (FS_MODULES.has(specifier)) {
				reasons.push(`${kind} of ${specifier}`);
			} else if (MODULE_MODULES.has(specifier)) {
				reasons.push(`${kind} of ${specifier} (createRequire reaches fs)`);
			} else if (WALKER_MODULE.test(specifier)) {
				if (/^import\s+type\b/.test(node.text())) continue;
				const named = node.find({ rule: { kind: "named_imports" } });
				const clause = node.find({ rule: { kind: "import_clause" } });
				if (kind === "export_statement" || (clause && !named)) {
					reasons.push(`${kind} of ${specifier} as a whole module`);
					continue;
				}
				for (const spec of node.findAll({
					rule: { kind: "import_specifier" },
				})) {
					if (/^type\s/.test(spec.text())) continue;
					const imported = spec.field("name")?.text() ?? spec.text();
					if (!PURE_PATH_HELPERS.has(imported)) {
						reasons.push(`${kind} of ${imported} from ${specifier}`);
					}
				}
			}
		} else if (kind === "call_expression") {
			const callee = node.field("function")?.text() ?? "";
			if (/(?:^|\.)getBuiltinModule$/.test(callee)) {
				reasons.push("getBuiltinModule call");
			} else if (callee === "require" || callee === "import") {
				const arg = node.field("arguments")?.child(1);
				const literal =
					arg && (arg.kind() === "string" || arg.kind() === "template_string")
						? stripQuotes(arg.text())
						: undefined;
				if (literal === undefined || arg?.kind() === "template_string") {
					reasons.push(`${callee}() with an unresolvable argument`);
				} else if (FS_MODULES.has(literal) || MODULE_MODULES.has(literal)) {
					reasons.push(`${callee}("${literal}")`);
				} else if (WALKER_MODULE.test(literal)) {
					reasons.push(`${callee}("${literal}") as a whole module`);
				}
			}
		}
	}
	return reasons;
}
