import * as fs from "node:fs";
import * as path from "node:path";
import { walkUpDirs } from "./path-utils.js";

// ast-grep's root config marker. The `ast-grep lsp` server is workspace-gated:
// it only operates in a project that has an `sgconfig.y[a]ml` at (or above) the
// file. These are the names ast-grep itself looks for as root markers.
export const SGCONFIG_NAMES = ["sgconfig.yml", "sgconfig.yaml"] as const;

/**
 * Nearest `sgconfig.y[a]ml` walking up from `startDir`, or undefined if none.
 * Used both to gate the ast-grep LSP server (no sgconfig ⇒ it never attaches,
 * so the napi runner stays the path) and to decide blocking eligibility (a repo
 * sgconfig is the team's deliberately-authored ruleset, like a curated opengrep
 * config — see clients/dispatch/auxiliary-lsp.ts).
 */
export function findLocalSgconfig(startDir: string): string | undefined {
	for (const dir of walkUpDirs(startDir || process.cwd())) {
		for (const name of SGCONFIG_NAMES) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}
