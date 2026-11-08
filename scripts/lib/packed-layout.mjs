/**
 * #3219 invariant: everything in the published package loads from the bundled
 * tree. No packed path lives under dist/clients/ or dist/tools/ (the unbundled
 * tsc emit), and no packed .js/.mjs file imports, dynamic-imports, or
 * `new URL(...)`s a relative path that resolves there. The second half is the
 * recurring shape the issue names: a bundle that still reaches back into the
 * unbundled tree through `new URL("./clients/…", import.meta.url)`.
 *
 * Pure (paths and a text reader in, findings out) so a unit test can pin it on
 * fixed lists. Its only importers are tests/scripts/packed-layout.test.ts (fixed
 * lists) and tests/packaging-pack-manifest.test.ts (the real tarball), so the
 * `oxc-parser` devDependency below is always installed where it runs; no
 * published file and no install-leg script imports this module.
 */
import * as path from "node:path";
import { parseSync, Visitor } from "oxc-parser";

export const UNBUNDLED_PREFIXES = ["dist/clients/", "dist/tools/"];

// Static `from "…"`, bare `import "…"`, dynamic `import("…")`, and
// `new URL("…", …)` — the four ways a shipped file names another file.
const RELATIVE_REFERENCE =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew\s+URL\(\s*)(["'`])(\.{1,2}\/[^"'`]+)\1/g;

// The shipped JavaScript population: every one of these files' relative
// specifiers has to land on another member of the pack list.
const JS_SUFFIXES = [".js", ".mjs", ".cjs"];

function isUnbundled(packedPath) {
	return UNBUNDLED_PREFIXES.some((prefix) => packedPath.startsWith(prefix));
}

/**
 * @param {readonly string[]} packedPaths  package-relative POSIX paths
 * @param {(packedPath: string) => string} readText
 * @returns {string[]} one line per violation, sorted
 */
export function packedLayoutViolations(packedPaths, readText) {
	const violations = [];
	for (const packedPath of packedPaths) {
		if (isUnbundled(packedPath)) {
			violations.push(`ships unbundled ${packedPath}`);
			continue;
		}
		if (!/\.m?js$/.test(packedPath)) continue;
		const text = readText(packedPath);
		for (const match of text.matchAll(RELATIVE_REFERENCE)) {
			const target = path.posix.normalize(
				path.posix.join(path.posix.dirname(packedPath), match[2]),
			);
			if (isUnbundled(target))
				violations.push(`${packedPath} reaches ${match[2]} (${target})`);
		}
	}
	return violations.sort();
}

/**
 * Computed `import()` / `require()` arguments the live pack carries, each
 * admitted by exact (file, call, argument text) and nothing broader. Every one
 * is a bare package specifier or an absolute `file://` URL the script resolves
 * at run time inside the INSTALLED package, so none names a packed path. A
 * rename or a new computed argument in these files reds the gate on purpose:
 * the author reads the argument and adds a row with its `reason`, which the
 * unit test requires to be a non-empty string (#5365 r3, shape 38).
 */
export const COMPUTED_ADMISSIONS = [
	// install-selftest.mjs probes the installed package's dependencies.
	{
		file: "scripts/install-selftest.mjs",
		kind: "import",
		argument: "url.href",
		reason: "file:// URL of a resolved dependency",
	},
	{
		file: "scripts/install-selftest.mjs",
		kind: "import",
		argument: "installerUrl",
		reason: "file:// URL inside the install",
	},
	{
		file: "scripts/install-selftest.mjs",
		kind: "require.resolve",
		argument: "spec",
		reason: "bare package specifier",
	},
	{
		file: "scripts/install-selftest.mjs",
		kind: "require.resolve",
		argument: "`${tool.packageName}/package.json`",
		reason: "bare package name",
	},
	{
		file: "scripts/install-selftest.mjs",
		kind: "require.resolve",
		argument: "specifier",
		reason: "bare package specifier",
	},
	// warm-loader-cache.mjs resolves jiti and the extension entry.
	{
		file: "scripts/warm-loader-cache.mjs",
		kind: "import.meta.resolve",
		argument: "specifier",
		reason: "bare package specifier",
	},
	{
		file: "scripts/warm-loader-cache.mjs",
		kind: "require.resolve",
		argument: "specifier",
		reason: "bare package specifier",
	},
	{
		file: "scripts/warm-loader-cache.mjs",
		kind: "import",
		argument: "url",
		reason: "file:// URL it just resolved",
	},
];

// A literal specifier outside the package: a Node builtin or an npm package
// name (optionally scoped, optionally with a subpath). A colon anywhere else
// (`file:`, `https:`, `data:`) or a leading slash does not match.
const PACKAGE_SPECIFIER =
	/^(?:node:[\w/.-]+|(?:@[\w.~-]+\/)?[\w~-][\w.~-]*(?:\/\S*)?)$/;

const PATH_TO_FILE_URL = /^pathToFileURL\d*$/;

// A bare load call: `require`, and esbuild's renames of it (`__require` in the
// shipped bundle, `_require2` on a collision).
const REQUIRE_CALLEE = /^_*require\d*$/;

// The dotted loader members the gate reads (`require.resolve` and so on).
const LOADER_MEMBERS = [
	"require.resolve",
	"module.require",
	"import.meta.resolve",
];

/**
 * #5365: every relative specifier a packed file names must be in that SAME
 * list. `scripts/check-extensions.mjs` run from the source tree resolves
 * against the source tree, so a packaged file that imports a file `files[]`
 * omits passes locally and fails only in CI's install leg; every occurrence of
 * that shape (#4789, #2626, #3409, #5364) was caught there and pinned by one
 * hand-written `files[]` assertion per file afterwards. This is the generic
 * version: each packed file is PARSED (oxc-parser, so a string, a comment or a
 * regex literal can neither hide nor fake an import) and every module
 * reference in it is judged.
 *
 * Known-good forms, everything else is a finding:
 * - a literal specifier that is relative: it must equal a packed path exactly
 *   (Node ESM guesses no extension, index file or `.json`; a query suffix,
 *   a trailing slash or `.` is not a file);
 * - a literal that is a Node builtin or an npm package name: out of scope;
 * - `import(pathToFileURL(<identifier>)[.href])`, the form the deleted #4314
 *   pin admitted (esbuild renames a colliding import `pathToFileURL2`);
 * - the exact (file, call, argument) rows of `COMPUTED_ADMISSIONS`.
 * A computed argument, a literal outside the package (`file:`, `/abs`), and a
 * file that does not parse are findings. #4314 shipped
 * `import(["./lsp", "capabilities.js"].join("/"))`, a file no build produces.
 *
 * Forms read: `import … from`, `export … from`, `import()`, `require()` (and
 * esbuild's `__require()`), `module.require()`, `require.resolve()`,
 * `import.meta.resolve()`, the same calls through a string-literal computed key
 * (`module["require"]()`), and a non-literal computed key on `require`,
 * `module` or `import.meta` as a load call. The parser also reads the minified
 * `import"./x"` and escaped spellings. Not read:
 * `new URL("./…", import.meta.url)` (a runtime asset path whose base the bundle
 * rewrites; `packedLayoutViolations` only checks its `dist/clients|tools`
 * prefix, not that the target exists), a `createRequire(…)` result bound to
 * another name, and `Worker` path strings.
 *
 * `tally.relative` (optional out-parameter) receives the number of relative
 * specifiers examined, so the real-tarball case can floor a dead matcher.
 *
 * Pure like `packedLayoutViolations`, so `tests/scripts/packed-layout.test.ts`
 * pins it on fixed lists while `tests/packaging-pack-manifest.test.ts` runs it
 * over the real tarball.
 *
 * @param {readonly string[]} packedPaths  package-relative POSIX paths
 * @param {(packedPath: string) => string} readText
 * @param {{ relative: number }} [tally]
 * @returns {string[]} one line per finding, sorted
 */
export function packedImportResolutionViolations(
	packedPaths,
	readText,
	tally = { relative: 0 },
) {
	tally.relative = 0;
	const shipped = packedPaths.filter((p) =>
		JS_SUFFIXES.some((s) => p.endsWith(s)),
	);
	if (shipped.length === 0) return ["the pack list carries no JavaScript file"];
	const packed = new Set(packedPaths);
	const findings = new Set();
	for (const packedPath of shipped) {
		const text = readText(packedPath);
		// package.json is `"type": "module"`: Node reads .js and .mjs as ESM and
		// only .cjs as CommonJS.
		const parsed = parseSync(packedPath, text, {
			sourceType: packedPath.endsWith(".cjs") ? "commonjs" : "module",
		});
		const syntax = parsed.errors.find((e) => e.severity === "Error");
		if (syntax) {
			findings.add(`${packedPath}: does not parse (${syntax.message})`);
			continue;
		}
		const literal = (specifier) => {
			if (isRelative(specifier)) {
				tally.relative += 1;
				const target = path.posix.normalize(
					path.posix.join(path.posix.dirname(packedPath), specifier),
				);
				if (packed.has(target)) return;
			} else if (PACKAGE_SPECIFIER.test(specifier)) return;
			findings.add(
				`${packedPath}: import "${specifier}" is not in the package`,
			);
		};
		const argument = (kind, node) => {
			const value = stringValue(node);
			if (value !== null) return literal(value);
			const source = node ? text.slice(node.start, node.end) : "";
			const argumentText = source.replace(/\s+/g, " ");
			if (kind === "import" && isPathToFileUrl(node)) return;
			if (
				COMPUTED_ADMISSIONS.some(
					(row) =>
						row.file === packedPath &&
						row.kind === kind &&
						row.argument === argumentText,
				)
			)
				return;
			findings.add(`${packedPath}: computed ${kind}(${argumentText})`);
		};
		new Visitor({
			ImportDeclaration: (node) => literal(node.source.value),
			ExportAllDeclaration: (node) => literal(node.source.value),
			ExportNamedDeclaration: (node) => {
				if (node.source) literal(node.source.value);
			},
			ImportExpression: (node) => argument("import", node.source),
			CallExpression: (node) => {
				const kind = referenceCall(node.callee);
				if (kind !== null) argument(kind, node.arguments[0]);
			},
		}).visit(parsed.program);
	}
	return [...findings].sort();
}

function isRelative(specifier) {
	return (
		specifier === "." ||
		specifier === ".." ||
		specifier.startsWith("./") ||
		specifier.startsWith("../")
	);
}

/** The value of a string literal or an interpolation-free template, else null. */
function stringValue(node) {
	if (node?.type === "Literal" && typeof node.value === "string")
		return node.value;
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
		return node.quasis[0].value.cooked ?? null;
	return null;
}

/** `pathToFileURL(<identifier>)`, optionally `.href`: a path the caller resolved. */
function isPathToFileUrl(node) {
	const call =
		node.type === "MemberExpression" &&
		!node.computed &&
		node.property.name === "href"
			? node.object
			: node;
	return (
		call.type === "CallExpression" &&
		call.callee.type === "Identifier" &&
		PATH_TO_FILE_URL.test(call.callee.name) &&
		call.arguments.length === 1 &&
		call.arguments[0].type === "Identifier"
	);
}

/**
 * The call kinds that load a module by specifier, else null. A string-literal
 * computed key reads as its dotted name (`module["require"]` is
 * `module.require`). A non-literal key on `require`, `module` or `import.meta`
 * is a load call of that object's own kind, so its first argument is judged
 * like any other (`require[k]("./m.js")`; #5365 r3).
 */
function referenceCall(callee) {
	if (callee.type === "Identifier")
		return REQUIRE_CALLEE.test(callee.name) ? "require" : null;
	if (callee.type !== "MemberExpression") return null;
	const owner = loaderOwner(callee.object);
	if (owner === null) return null;
	const key = callee.computed
		? stringValue(callee.property)
		: callee.property.name;
	if (key === null) return owner;
	const kind = `${owner}.${key}`;
	return LOADER_MEMBERS.includes(kind) ? kind : null;
}

/** The object a loader member hangs off: `require`, `module`, `import.meta`. */
function loaderOwner(object) {
	if (
		object.type === "Identifier" &&
		(object.name === "require" || object.name === "module")
	)
		return object.name;
	if (object.type === "MetaProperty" && object.meta.name === "import")
		return "import.meta";
	return null;
}
