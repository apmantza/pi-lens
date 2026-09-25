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
