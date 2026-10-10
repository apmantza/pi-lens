/**
 * Shared constants and helpers for tool definitions
 */

import { resolveHostToolPath } from "../clients/path-utils.js";

/**
 * Resolve the `paths` argument of an ast-grep tool against the session cwd.
 *
 * The ast-grep CLI runs from a pi-lens-owned tools directory when its npx
 * fallback wins (#4193), so a relative target would otherwise resolve under
 * that directory and silently match nothing. Every ast-grep tool resolves here
 * before it dispatches, through the same host-path seam the read/edit/write
 * tools use (so `~`, `@` and unicode-space spellings behave identically); the
 * defaulted (no `paths`) case resolves the cwd itself, so the child always
 * receives an absolute target (#4233 V3-HIGH-01).
 */
export function resolveAstGrepPaths(
	paths: readonly string[] | undefined,
	cwd: string | undefined,
): string[] {
	const base = cwd || ".";
	const requested = paths?.length ? paths : [base];
	return requested.map((p) => resolveHostToolPath(p, base));
}

export const LANGUAGES = [
	"bash",
	"c",
	"cpp",
	"csharp",
	"css",
	"elixir",
	"go",
	"haskell",
	"html",
	"java",
	"javascript",
	"json",
	"kotlin",
	"lua",
	"nix",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"swift",
	"tsx",
	"typescript",
	"yaml",
] as const;
