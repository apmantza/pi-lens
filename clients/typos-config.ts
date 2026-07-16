import { findLocalToolConfig } from "./path-utils.js";

/**
 * typos (source-code spell checker) configuration discovery. typos runs as a
 * cross-cutting auxiliary LSP (#283); like Opengrep's local-rules gate and
 * zizmor's `zizmor.yml` gate, the PRESENCE of a repo-local typos config is the
 * project's deliberate opt-in to let spelling findings BLOCK (it carries the
 * team's curated allow-list / `extend-words` / severity). Advisory otherwise.
 *
 * typos discovers its config as `typos.toml`, `_typos.toml`, or `.typos.toml`
 * at the project root (see typos' configuration docs). We only need to know if
 * one EXISTS for the blocking gate — the `typos-lsp` server reads it itself.
 *
 * Note: `files.*` ignore globs in the config have NO effect under the LSP
 * (CLI-only), so a `.typos.toml` does not exclude paths from the LSP scan — it
 * only tunes the dictionary/severity. The blocking gate keys purely on presence.
 */
export const LOCAL_TYPOS_CONFIG_NAMES = [
	"typos.toml",
	"_typos.toml",
	".typos.toml",
] as const;

export function findLocalTyposConfig(startDir: string): string | undefined {
	return findLocalToolConfig(startDir, LOCAL_TYPOS_CONFIG_NAMES);
}
