/**
 * #3219 invariant: everything in the published package loads from the bundled
 * tree. No packed path lives under dist/clients/ or dist/tools/ (the unbundled
 * tsc emit), and no packed .js/.mjs file imports, dynamic-imports, or
 * `new URL(...)`s a relative path that resolves there. The second half is the
 * recurring shape the issue names: a bundle that still reaches back into the
 * unbundled tree through `new URL("./clients/…", import.meta.url)`.
 *
 * Pure (paths and a text reader in, findings out) so a unit test can pin it on
 * fixed lists; tests/packaging-bundled-only.test.ts runs it over
 * `npm pack --dry-run --json`, and scripts/check-packed-layout.mjs over the
 * real tarball in CI's production-install lane.
 */
import * as path from "node:path";

export const UNBUNDLED_PREFIXES = ["dist/clients/", "dist/tools/"];

// Static `from "…"`, bare `import "…"`, dynamic `import("…")`, and
// `new URL("…", …)` — the four ways a shipped file names another file.
const RELATIVE_REFERENCE =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew\s+URL\(\s*)(["'`])(\.{1,2}\/[^"'`]+)\1/g;

// The same, minus `new URL` (a runtime asset path, see
// `packedImportResolutionViolations`), plus the CommonJS forms.
const PACKED_RELATIVE_SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire(?:\.resolve)?\s*\(\s*)(["'`])(\.{1,2}\/[^"'`]+)\1/g;

// The shipped JavaScript population: every one of these files' relative
// specifiers has to land on another member of the pack list.
const JS_SUFFIXES = [".js", ".mjs", ".cjs"];

// Opening of an `import(…)` / `require(…)` call, for the computed-argument pass.
const CALL_WITH_ARG = /\b(?:import|require(?:\.resolve)?)\s*\(\s*/g;

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
 * #5365: every relative specifier a packed file names must be in that SAME
 * list. `scripts/check-extensions.mjs` run from the source tree resolves
 * against the source tree, so a packaged file that imports a file `files[]`
 * omits passes locally and fails only in CI's install leg; every occurrence of
 * that shape (#4789, #2626, #3409, #5364) was caught there and pinned by one
 * hand-written `files[]` assertion per file afterwards. This is the generic
 * version: one pass over the pack list, every shipped file, four specifier
 * forms.
 *
 * `new URL("./…", import.meta.url)` is deliberately absent: that form names a
 * runtime asset path (a worker, a grammar, a wasm), the bundle rewrites its
 * base, and `packedLayoutViolations` already owns it. A computed specifier is
 * judged by what it names: text that carries a `./` or `../` reference is a
 * relative import the check cannot resolve, so it is a finding (#4314 shipped
 * `import(["./lsp", "capabilities.js"].join("/"))`, a file no build produces);
 * text that names no relative path at all is not a reference to a packed file.
 * All 15 computed `import`/`require` arguments in the 4.4.10 pack (a probe over
 * `npm pack --dry-run`) are of the second kind: `pathToFileURL(<resolved>).href`
 * loads a package `createRequire` resolved, `install-selftest.mjs` probes
 * absolute `file://` URLs inside the install, `warm-loader-cache.mjs` resolves a
 * bare package specifier, and `$$$ARGS` is esbuild's own placeholder inside a
 * bundled doc string.
 *
 * Pure like `packedLayoutViolations`, so `tests/scripts/packed-layout.test.ts`
 * pins it on fixed lists while `tests/packaging-pack-manifest.test.ts` runs it
 * over the real tarball.
 *
 * @param {readonly string[]} packedPaths  package-relative POSIX paths
 * @param {(packedPath: string) => string} readText
 * @returns {string[]} one line per finding, sorted
 */
export function packedImportResolutionViolations(packedPaths, readText) {
	const shipped = packedPaths.filter((p) =>
		JS_SUFFIXES.some((s) => p.endsWith(s)),
	);
	if (shipped.length === 0) return ["the pack list carries no JavaScript file"];
	const packed = new Set(packedPaths);
	const findings = new Set();
	for (const packedPath of shipped) {
		// Comments blanked: the bundle carries esbuild banner comments and doc
		// comments that quote import paths their target never shipped with
		// (dist/index.js quotes `from "../providers/cline/cline-auth"`). Strings
		// are kept, because the specifier is the evidence.
		const text = readText(packedPath)
			.replace(/\/\/[^\r\n]*/g, "")
			.replace(/\/\*[\s\S]*?\*\//g, "");
		for (const match of text.matchAll(PACKED_RELATIVE_SPECIFIER)) {
			const specifier = match[2];
			// A template with an interpolation is not a literal path: the computed
			// pass below reports it, once.
			if (specifier.includes("${")) continue;
			const base = relativeTarget(packedPath, specifier).replace(/\/+$/, "");
			const candidates = [
				base,
				...[".js", ".mjs", ".cjs", ".json"].map((ext) => base + ext),
				...["/index.js", "/index.mjs", "/index.cjs"].map((idx) => base + idx),
			];
			if (!candidates.some((candidate) => packed.has(candidate))) {
				findings.add(
					`${packedPath}: import "${specifier}" is not in the package`,
				);
			}
		}
		for (const computed of computedSpecifiers(text)) {
			findings.add(`${packedPath}: computed dynamic import (${computed})`);
		}
	}
	return [...findings].sort((a, b) => a.localeCompare(b));
}

/** Package-relative POSIX target a relative specifier names, unresolved. */
function relativeTarget(fromPath, specifier) {
	return path.posix.normalize(
		path.posix.join(path.posix.dirname(fromPath), specifier),
	);
}

/**
 * The arguments of `import(…)` / `require(…)` calls that name a `./`-shaped
 * path without being a plain string literal. Balanced scan (a nested call's
 * `)` is part of the argument), bounded at 300 characters.
 */
function* computedSpecifiers(text) {
	for (const match of text.matchAll(CALL_WITH_ARG)) {
		const arg = readArgument(text, match.index + match[0].length);
		const literal = /^("|'|`)([^"'`]*)\1$/.exec(arg);
		if (literal && !literal[2].includes("${")) continue;
		if (!arg.includes("./") && !arg.includes("../")) continue;
		yield arg;
	}
}

/** The balanced text of a call argument starting at `from`. */
function readArgument(text, from) {
	let depth = 1;
	let quote = null;
	let out = "";
	for (let i = from; i < text.length && depth > 0 && out.length < 300; i++) {
		const char = text[i];
		if (quote !== null) {
			out += char;
			if (char === quote && text[i - 1] !== "\\") quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			out += char;
			continue;
		}
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) break;
		}
		out += char;
	}
	return out.trim();
}
