/**
 * Shared constants and helpers for tool definitions
 */

import * as path from "node:path";
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
 *
 * #4577 R2-2: with no `paths` the target is the session cwd — a path pi-lens
 * generated, not one a model typed. An internally generated path gets no host
 * resolver stage: running the cwd through those stages folded its bytes (a cwd
 * holding U+00A0 became the sibling `proj x`, which does not exist, and the
 * child then failed with `No such file or directory`). It only needs to be
 * absolute.
 */
export function resolveAstGrepPaths(
	paths: readonly string[] | undefined,
	cwd: string | undefined,
): string[] {
	const base = cwd || ".";
	if (!paths?.length) return [path.resolve(base)];
	return paths.map((p) => resolveHostToolPath(p, base));
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
