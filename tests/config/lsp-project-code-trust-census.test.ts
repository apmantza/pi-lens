import { describe, expect, it } from "vitest";
import { LSP_SERVERS } from "../../clients/lsp/server.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

/**
 * #4269: keep the project-code execution population explicit. A new built-in
 * must not silently become an unknown-trust execution path by omission.
 *
 * The census walks the WHOLE registry in both directions:
 *
 *  - every server that declares `executesProjectCode: true` is in the intended
 *    executor set (no accidental promotion), and
 *  - every server that does not declare it is admitted BY NAME in
 *    {@link DOES_NOT_EXECUTE_PROJECT_CODE}, so a row that omits the field
 *    cannot pass vacuously.
 *
 * The pre-fix census filtered `LSP_SERVERS` by the very field it enforced and
 * compared that to a hand list, so an omitted field was invisible: the Lean row
 * shipped with `lake serve` (which interprets `lakefile.lean`) and passed.
 */
const PROJECT_CODE_SERVERS = new Set([
	"rust",
	"ruby",
	"powershell",
	"csharp",
	"omnisharp",
	"fsharp",
	"java",
	"kotlin",
	"lean",
	"swift",
	"dart",
	"zig",
	"haskell",
	"elixir",
	"expert",
	"ocaml",
	"clojure",
	"terraform",
	"nix",
	"cmake",
	"vue",
	"svelte",
	"tinymist",
]);

/**
 * Servers whose startup/indexing does NOT execute project-owned build or plugin
 * code. Every non-executor is named here, so the census cannot pass by omission
 * (#4269). The reason documents the verdict for a human reader; the census only
 * requires presence.
 */
const DOES_NOT_EXECUTE_PROJECT_CODE = new Map<string, string>([
	[
		"ast-grep",
		"scans source with bundled patterns; the project's rules are patterns, never executed",
	],
	["bash", "parses shell source; it never runs the project's scripts"],
	[
		"cpp",
		"clangd parses and indexes C/C++ source; it does not run the project's build",
	],
	["css", "CSS language service reads stylesheets only"],
	[
		"cue",
		"CUE language server reads configuration; it runs no project build script",
	],
	["deno", "deno lsp type-checks module source; it runs no project build step"],
	["docker", "Dockerfile language server parses Dockerfiles only"],
	[
		"docker-official",
		"Dockerfile language server alternate parses Dockerfiles only",
	],
	["fish", "parses shell source; it never runs the project's scripts"],
	[
		"gleam",
		"gleam lsp parses and type-checks source; it runs no project build script",
	],
	["go", "gopls type-checks and indexes; it does not run the project's build"],
	["html", "HTML language service reads markup only"],
	["json", "JSON language service reads data files only"],
	[
		"lua",
		"lua-language-server parses and indexes; it does not run the project's Lua",
	],
	["marksman", "Markdown language server reads documents only"],
	[
		"opengrep",
		"scans source with bundled patterns; the project's rules are patterns, never executed",
	],
	["php", "intelephense parses and indexes; it does not run the project's PHP"],
	["prisma", "Prisma language server parses schema files only"],
	[
		"python",
		"pyright/basedpyright type-checks; it does not run the project's Python",
	],
	[
		"python-jedi",
		"jedi analyzes and completes; it does not run the project's Python",
	],
	["shuck", "parses shell source; it never runs the project's scripts"],
	["toml", "TOML language service reads data files only"],
	[
		"typescript",
		"TypeScript type-checks and completes; project classic/native compilers require trusted session ownership, and adopted roots use admitted managed classic TypeScript (#4296/#4299)",
	],
	["typos", "spell-checker over source text; it executes nothing"],
	["yaml", "YAML language service reads data files only"],
	["zizmor", "scans workflow YAML with bundled rules; it executes nothing"],
]);

describe("LSP project-code trust census", () => {
	it("accounts for every server as a declared executor or a named non-executor", () => {
		const declared = new Set(
			LSP_SERVERS.filter((server) => server.executesProjectCode).map(
				(server) => server.id,
			),
		);
		const admitted = new Set(DOES_NOT_EXECUTE_PROJECT_CODE.keys());
		const allIds = LSP_SERVERS.map((server) => server.id);

		// Floor (sweep-floor meta-sweep): an emptied registry must fail loud,
		// never read as a clean census. 49 built-ins on 2026-10-10; the exact
		// coverage below pins the membership, so this only bounds the population.
		assertNonEmptyScan("LSP server population", allIds.length, 49);

		// Non-vacuity: every id is either declared or admitted by name. The
		// pre-fix filter hid an omission here, so this set must be empty.
		const unaccounted = allIds.filter(
			(id) => !declared.has(id) && !admitted.has(id),
		);
		expect(unaccounted, "servers in neither set").toEqual([]);

		// Declared executors match the intended population exactly: no
		// accidental promotion, and no silent demotion of an intended member.
		expect(declared).toEqual(PROJECT_CODE_SERVERS);

		// The admitted set is exactly the non-declared population, so a stale
		// admission fails as loudly as a missing one.
		expect(new Set(allIds.filter((id) => !declared.has(id)))).toEqual(admitted);
	});
});
