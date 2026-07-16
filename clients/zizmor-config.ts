import * as path from "node:path";
import { safeSpawnAsync } from "./safe-spawn.js";
import { findLocalToolConfig } from "./path-utils.js";

/**
 * zizmor (GitHub Actions workflow security scanner) configuration discovery and
 * online-mode token resolution. zizmor runs as a cross-cutting auxiliary LSP
 * (#272); this module owns the two repo/environment-derived inputs the server
 * spawn and the auxiliary profile need.
 */

// zizmor discovers its config (curated ignores + per-rule config) as
// `zizmor.yml`/`.yaml` at the repo root or under `.github/` — see zizmor's
// configuration docs (discovery order: .github/zizmor.y[a]ml, then root). The
// presence of one is the repo's deliberate opt-in: it carries the author's
// chosen severities/ignores, so we let zizmor findings BLOCK in that workspace
// (advisory-only otherwise, like Opengrep's local-rules gate).
export const LOCAL_ZIZMOR_CONFIG_NAMES = [
	path.join(".github", "zizmor.yml"),
	path.join(".github", "zizmor.yaml"),
	"zizmor.yml",
	"zizmor.yaml",
] as const;

export function findLocalZizmorConfig(startDir: string): string | undefined {
	return findLocalToolConfig(startDir, LOCAL_ZIZMOR_CONFIG_NAMES);
}

// zizmor's own input collection (see `zizmor --collect`) only ever audits three
// path shapes: workflow YAML under `.github/workflows/`, a composite/reusable
// action definition (`action.yml`/`action.yaml`, anywhere in the repo — GitHub
// resolves these relative to whichever directory references them, not just the
// root), and the repo's Dependabot config (`.github/dependabot.yml`/`.yaml`,
// GitHub only ever reads this one location). Every other YAML file is a
// guaranteed no-op: measured directly against a real `zizmor --lsp` process
// (#<issue>), a non-matching file gets NO `publishDiagnostics` at all — not
// even an empty one — so `waitForDiagnostics` burns its full aggregateWaitMs
// budget (2000ms, bounded by the per-edit caller cap) on every such edit for
// zero signal (#636). This predicate is the LSP-candidacy gate (server.ts's
// `ZizmorServer.pathFilter`) that keeps zizmor out of the candidate list for
// files it can never report on, mirroring its own collection rules exactly —
// under-matching would silently drop real workflow/action coverage,
// over-matching would leave the wasted-wait gap in place for common
// non-GitHub YAML (docker-compose.yml, k8s manifests, …).
export function isZizmorAuditTarget(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const base = path.basename(normalized).toLowerCase();
	if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalized)) return true;
	if (base === "action.yml" || base === "action.yaml") return true;
	if (/(^|\/)\.github\/dependabot\.ya?ml$/i.test(normalized)) return true;
	return false;
}

let cachedGhToken: { value: string | undefined } | undefined;

/** Test-only: clear the memoized `gh auth token` lookup. */
export function _resetZizmorTokenCacheForTests(): void {
	cachedGhToken = undefined;
}

async function deriveGhCliToken(): Promise<string | undefined> {
	// Best-effort: a missing/unauthenticated `gh` just leaves zizmor offline.
	// ignoreAmbientSignal so a mid-turn Esc can't silently drop the server into
	// offline mode; short timeout so a wedged `gh` never stalls the warm spawn.
	const res = await safeSpawnAsync("gh", ["auth", "token"], {
		timeout: 5000,
		ignoreAmbientSignal: true,
	});
	if (res.error || res.status !== 0) return undefined;
	const token = res.stdout.trim();
	return token.length > 0 ? token : undefined;
}

/**
 * Resolve a GitHub token to put zizmor into ONLINE mode, so the audits that need
 * the GitHub API (e.g. `known-vulnerable-actions`, `unpinned-uses`,
 * `impostor-commit`) actually run instead of being silently skipped.
 *
 * zizmor's own precedence: `ZIZMOR_OFFLINE` forces offline regardless of any
 * token; otherwise any of `GH_TOKEN` / `GITHUB_TOKEN` / `ZIZMOR_GITHUB_TOKEN`
 * enables online mode. Those env vars already flow to the spawned server
 * (launchLSP merges `process.env`), so the ONLY gap we close here is the very
 * common case of a user who has authenticated the `gh` CLI but exported no
 * token — we derive one via `gh auth token`. Memoized per process; best-effort.
 */
export async function resolveZizmorGitHubToken(): Promise<string | undefined> {
	// Respect an explicit offline request — never derive a token then.
	if (process.env.ZIZMOR_OFFLINE) return undefined;
	const fromEnv =
		process.env.ZIZMOR_GITHUB_TOKEN ||
		process.env.GH_TOKEN ||
		process.env.GITHUB_TOKEN;
	if (fromEnv) return fromEnv;
	if (cachedGhToken) return cachedGhToken.value;
	const value = await deriveGhCliToken();
	cachedGhToken = { value };
	return value;
}
