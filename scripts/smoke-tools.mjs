#!/usr/bin/env node
/**
 * Live tool-smoke harness (#209, layer 2).
 *
 * Drives pi-lens's REAL dispatch path (`dispatchLintDetailed` → real file-kind
 * → runner selection → each runner's `run()` → `safeSpawnAsync` → real tool,
 * with each runner's own auto-install) over a minimal real project per language,
 * and reports per-runner outcomes. Unlike the deterministic registry-consistency
 * test (layer 1, runs per-PR), this installs and spawns real tools — so it is
 * opt-in / nightly, never a per-PR gate.
 *
 *   Step 1 (default):  each target tool SPAWNS and EXITS CLEANLY
 *                      (no timeout/exception/server_error).
 *   Step 2 (--step2):  additionally, the tool PRODUCES A PARSEABLE DIAGNOSTIC
 *                      on the fixture's known defect.
 *
 * LSP handshake layer (--lsp): for each LSP fixture, drives the SAME production
 * entry the lsp runner uses (`LSPService.touchFile`, with a generous cold-spawn
 * budget) so a pass means the real server installed, spawned, completed the
 * JSON-RPC initialize handshake, and answered — verified via
 * `getDiagnosticsHealth` (serverCountReady > 0), not a hand-rolled handshake.
 *
 * Format layer (--format): for each formatter fixture, drives the SAME entry
 * the format pipeline uses (`getFormattersForFile` → `formatFile`) so a pass
 * means the expected formatter was selected and actually reformatted a
 * deliberately mis-formatted file. The lint dispatch path never runs formatters.
 *
 * Usage:
 *   node scripts/smoke-tools.mjs [lang ...] [--step2] [--install] [--verbose]
 *   node scripts/smoke-tools.mjs --lsp [lang ...] [--install] [--verbose]
 *   node scripts/smoke-tools.mjs --format [lang ...] [--install] [--verbose]
 *
 * Requires a built dist/ (run `npm run build:dist` first).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const LOMBOK_DOWNLOAD_URL = "https://projectlombok.org/downloads/lombok.jar";

/**
 * One minimal real project per language. `targets` are the runner ids whose
 * tool we are smoke-testing; `expectDiagnostic` is the fixture's known defect
 * (used by --step2).
 */
const FIXTURES = [
	{
		lang: "typescript",
		dir: "tests/fixtures/tool-smoke/typescript",
		file: "bad.ts",
		targets: ["lsp"],
		tools: ["typescript-language-server"],
		expectDiagnostic: true,
	},
	{
		lang: "python",
		dir: "tests/fixtures/tool-smoke/python",
		file: "bad.py",
		targets: ["ruff-lint"],
		tools: ["ruff", "pyright"],
		expectDiagnostic: true,
	},
	{
		lang: "yaml",
		dir: "tests/fixtures/tool-smoke/yaml",
		file: "bad.yaml",
		targets: ["yamllint"],
		tools: ["yamllint", "yaml-language-server"],
		expectDiagnostic: true,
	},
	{
		lang: "javascript",
		dir: "tests/fixtures/tool-smoke/javascript",
		file: "bad.js",
		targets: ["oxlint"],
		tools: ["oxlint", "typescript-language-server"],
		expectDiagnostic: true,
	},
	{
		lang: "markdown",
		dir: "tests/fixtures/tool-smoke/markdown",
		file: "bad.md",
		targets: ["markdownlint"],
		tools: ["markdownlint"],
		expectDiagnostic: true,
	},
	{
		lang: "shell",
		dir: "tests/fixtures/tool-smoke/shell",
		file: "bad.sh",
		targets: ["shellcheck", "shfmt"],
		tools: ["shellcheck", "shfmt", "bash-language-server"],
		expectDiagnostic: true,
	},
	{
		lang: "css",
		dir: "tests/fixtures/tool-smoke/css",
		file: "bad.css",
		targets: ["stylelint"],
		tools: ["stylelint", "vscode-css-languageserver"],
		expectDiagnostic: true,
	},
	{
		lang: "html",
		dir: "tests/fixtures/tool-smoke/html",
		file: "bad.html",
		targets: ["htmlhint"],
		tools: ["htmlhint", "vscode-html-languageserver-bin"],
		expectDiagnostic: true,
	},
	{
		lang: "toml",
		dir: "tests/fixtures/tool-smoke/toml",
		file: "bad.toml",
		targets: ["taplo"],
		tools: ["taplo"],
		expectDiagnostic: true,
	},
	{
		lang: "sql",
		dir: "tests/fixtures/tool-smoke/sql",
		file: "bad.sql",
		targets: ["sqlfluff"],
		tools: ["sqlfluff"],
		expectDiagnostic: true,
	},
	{
		lang: "dockerfile",
		dir: "tests/fixtures/tool-smoke/dockerfile",
		file: "Dockerfile",
		targets: ["hadolint"],
		tools: ["hadolint", "dockerfile-language-server-nodejs"],
		expectDiagnostic: true,
	},
	{
		lang: "terraform",
		dir: "tests/fixtures/tool-smoke/terraform",
		file: "bad.tf",
		targets: ["tflint"],
		tools: ["tflint", "terraform-ls"],
		expectDiagnostic: true,
	},
	// Toolchain-dependent (run only where the language toolchain is present —
	// ⚠ skip otherwise). No installer `tools`: go vet ships with Go, and the
	// PSScriptAnalyzer module is installed by its own runner.
	{
		lang: "go",
		dir: "tests/fixtures/tool-smoke/go",
		file: "bad.go",
		targets: ["go-vet"],
		tools: [],
		expectDiagnostic: true,
	},
	{
		lang: "powershell",
		dir: "tests/fixtures/tool-smoke/powershell",
		file: "bad.ps1",
		targets: ["psscriptanalyzer"],
		tools: [],
		expectDiagnostic: true,
	},
	{
		lang: "rust",
		dir: "tests/fixtures/tool-smoke/rust",
		file: "src/main.rs",
		targets: ["rust-clippy"],
		tools: [],
		expectDiagnostic: true,
	},
	{
		lang: "csharp",
		dir: "tests/fixtures/tool-smoke/csharp",
		file: "Program.cs",
		targets: ["dotnet-build"],
		tools: [],
		expectDiagnostic: true,
	},
	{
		lang: "zig",
		dir: "tests/fixtures/tool-smoke/zig",
		file: "bad.zig",
		targets: ["zig-check"],
		tools: [],
		expectDiagnostic: true,
	},
	{
		lang: "java",
		dir: "tests/fixtures/tool-smoke/java",
		file: "Bad.java",
		targets: ["javac"],
		tools: [],
		expectDiagnostic: true,
	},
	{
		lang: "dart",
		dir: "tests/fixtures/tool-smoke/dart",
		file: "bad.dart",
		targets: ["dart-analyze"],
		tools: [],
		expectDiagnostic: true,
	},
	{
		lang: "php",
		dir: "tests/fixtures/tool-smoke/php",
		file: "syntax-error.php",
		targets: ["php-lint"],
		tools: [],
		expectDiagnostic: true,
	},
	// rubocop (gem) and ktlint (github binary) are auto-installed by their own
	// runner; listed in `tools` so --install prefetches them.
	{
		lang: "ruby",
		dir: "tests/fixtures/tool-smoke/ruby",
		file: "bad.rb",
		targets: ["rubocop"],
		tools: ["rubocop"],
		expectDiagnostic: true,
	},
	{
		lang: "kotlin",
		dir: "tests/fixtures/tool-smoke/kotlin",
		file: "Bad.kt",
		targets: ["ktlint"],
		tools: ["ktlint"],
		expectDiagnostic: true,
	},
	// `gleam check` compiles the whole project, so the fixture is a minimal
	// gleam package (gleam.toml + src/), not a loose file.
	{
		lang: "gleam",
		dir: "tests/fixtures/tool-smoke/gleam",
		file: "src/smoke.gleam",
		targets: ["gleam-check"],
		tools: [],
		expectDiagnostic: true,
	},
	{
		lang: "elixir",
		dir: "tests/fixtures/tool-smoke/elixir",
		file: "bad.ex",
		targets: ["elixir-check"],
		tools: [],
		expectDiagnostic: true,
	},
];

/**
 * LSP handshake fixtures: a file whose extension routes to the LSP server under
 * test, plus the installer tool id for that server (--install). `lang` is the
 * filter key; `serverHint` is shown in the report.
 */
const LSP_FIXTURES = [
	{
		lang: "typescript",
		dir: "tests/fixtures/tool-smoke/typescript",
		file: "bad.ts",
		serverHint: "typescript-language-server",
		tools: ["typescript-language-server"],
	},
	{
		lang: "python",
		dir: "tests/fixtures/tool-smoke/python",
		file: "bad.py",
		serverHint: "pyright",
		tools: ["pyright"],
	},
	// Clean (no-diagnostic) counterpart — bench-only signal for the clean-file edit
	// path (#240). Every other fixture is intentionally broken, which masks how long
	// a clean-file warm edit takes when the server has nothing fresh to publish.
	{
		lang: "typescript-clean",
		dir: "tests/fixtures/tool-smoke/typescript-clean",
		file: "clean.ts",
		serverHint: "typescript-language-server (clean file)",
		tools: ["typescript-language-server"],
		clean: true,
	},
	{
		lang: "yaml",
		dir: "tests/fixtures/tool-smoke/yaml",
		file: "bad.yaml",
		serverHint: "yaml-language-server",
		tools: ["yaml-language-server"],
	},
	{
		lang: "json",
		dir: "tests/fixtures/tool-smoke/json",
		file: "bad.json",
		serverHint: "vscode-json-language-server",
		tools: ["vscode-json-language-server"],
	},
	{
		lang: "shell",
		dir: "tests/fixtures/tool-smoke/shell",
		file: "bad.sh",
		serverHint: "bash-language-server",
		tools: ["bash-language-server"],
	},
	{
		lang: "css",
		dir: "tests/fixtures/tool-smoke/css",
		file: "bad.css",
		serverHint: "vscode-css-language-server",
		tools: ["vscode-css-languageserver"],
	},
	{
		lang: "html",
		dir: "tests/fixtures/tool-smoke/html",
		file: "bad.html",
		serverHint: "vscode-html-language-server",
		tools: ["vscode-html-languageserver-bin"],
	},
	{
		lang: "dockerfile",
		dir: "tests/fixtures/tool-smoke/dockerfile",
		file: "Dockerfile",
		serverHint: "docker-langserver",
		tools: ["dockerfile-language-server-nodejs"],
	},
	{
		lang: "toml",
		dir: "tests/fixtures/tool-smoke/toml",
		file: "bad.toml",
		serverHint: "taplo",
		tools: ["taplo"],
	},
	{
		lang: "terraform",
		dir: "tests/fixtures/tool-smoke/terraform",
		file: "bad.tf",
		serverHint: "terraform-ls",
		tools: ["terraform-ls"],
	},
	{
		// #274: marksman ships a bare per-platform binary (github single-binary).
		// The fixture's bad.md carries a broken intra-repo link so a provisioned run
		// also exercises marksman's cross-file check, not just the handshake.
		lang: "markdown",
		dir: "tests/fixtures/tool-smoke/markdown",
		file: "bad.md",
		serverHint: "marksman",
		tools: ["marksman"],
	},
	{
		lang: "prisma",
		dir: "tests/fixtures/tool-smoke/prisma",
		file: "schema.prisma",
		serverHint: "@prisma/language-server",
		tools: ["@prisma/language-server"],
	},
	{
		lang: "php",
		dir: "tests/fixtures/tool-smoke/php",
		file: "bad.php",
		serverHint: "intelephense",
		tools: ["intelephense"],
	},
	{
		lang: "rust",
		dir: "tests/fixtures/tool-smoke/rust",
		file: "src/main.rs",
		serverHint: "rust-analyzer",
		tools: ["rust-analyzer"],
	},
	{
		// #278: PowerShell Editor Services — a pwsh-bootstrapped module bundle
		// (archive tree bundle), not a binary. Needs pwsh on the runner (present on
		// the nightly ubuntu image); installs the bundle via the archive strategy.
		lang: "powershell",
		dir: "tests/fixtures/tool-smoke/powershell",
		file: "bad.ps1",
		serverHint: "PowerShell Editor Services (pwsh Start-EditorServices.ps1 -Stdio)",
		tools: ["powershell-editor-services"],
	},
	// Capability-matrix fixtures (#240): one fixture per remaining registered
	// server so `characterize-lsp.mjs` can record each server's diagnostic mode
	// (pull vs push). The mode comes from the server's advertised capabilities at
	// `initialize` — it is content-independent — so for languages that ALREADY
	// have a tool-layer fixture we reuse that file (the deliberately-dirty
	// `bad.*` source the tool layer asserts on) rather than adding a colliding
	// clean duplicate (two `func main`, two `.csproj` would break compilation).
	// New languages (no prior fixture) get a minimal clean source + root marker.
	// Servers needing a toolchain report "unavailable" where it's absent; the
	// fixture stays durable so a provisioned CI run completes the matrix.
	{
		lang: "go",
		dir: "tests/fixtures/tool-smoke/go",
		file: "bad.go",
		serverHint: "gopls",
		tools: ["gopls"],
	},
	{
		lang: "ruby",
		dir: "tests/fixtures/tool-smoke/ruby",
		file: "bad.rb",
		serverHint: "ruby-lsp",
		tools: ["ruby-lsp"],
	},
	{
		lang: "csharp",
		dir: "tests/fixtures/tool-smoke/csharp",
		file: "Program.cs",
		serverHint: "csharp-ls",
		tools: ["csharp-ls"],
	},
	{
		lang: "fsharp",
		dir: "tests/fixtures/tool-smoke/fsharp",
		file: "Program.fs",
		serverHint: "fsautocomplete",
		tools: ["fsautocomplete"],
	},
	{
		lang: "java",
		dir: "tests/fixtures/tool-smoke/java",
		file: "Bad.java",
		serverHint: "jdtls",
		tools: ["jdtls"],
	},
	{
		lang: "java-lombok",
		dir: "tests/fixtures/tool-smoke/java-lombok",
		file: "src/main/java/App.java",
		serverHint: "jdtls + lombok javaagent",
		tools: ["jdtls"],
		lombokJar: true,
		expectNoMessageMatch:
			"getName|undefined|cannot be resolved|cannot find symbol",
	},
	{
		lang: "kotlin",
		dir: "tests/fixtures/tool-smoke/kotlin",
		file: "Bad.kt",
		serverHint: "kotlin-language-server",
		tools: ["kotlin-language-server"],
	},
	{
		lang: "swift",
		dir: "tests/fixtures/tool-smoke/swift",
		file: "main.swift",
		serverHint: "sourcekit-lsp",
		tools: ["sourcekit-lsp"],
	},
	{
		lang: "dart",
		dir: "tests/fixtures/tool-smoke/dart",
		file: "bad.dart",
		serverHint: "dart language-server",
		tools: ["dart"],
	},
	{
		lang: "lua",
		dir: "tests/fixtures/tool-smoke/lua",
		file: "main.lua",
		serverHint: "lua-language-server",
		tools: ["lua-language-server"],
	},
	{
		lang: "cpp",
		dir: "tests/fixtures/tool-smoke/cpp",
		file: "main.cpp",
		serverHint: "clangd",
		tools: ["clangd"],
	},
	{
		lang: "zig",
		dir: "tests/fixtures/tool-smoke/zig",
		file: "bad.zig",
		serverHint: "zls",
		tools: ["zls"],
	},
	{
		lang: "haskell",
		dir: "tests/fixtures/tool-smoke/haskell",
		file: "Main.hs",
		serverHint: "haskell-language-server",
		tools: ["haskell-language-server"],
	},
	{
		lang: "elixir",
		dir: "tests/fixtures/tool-smoke/elixir",
		file: "bad.ex",
		serverHint: "elixir-ls",
		tools: ["elixir-ls"],
	},
	{
		lang: "gleam",
		dir: "tests/fixtures/tool-smoke/gleam",
		file: "src/smoke.gleam",
		serverHint: "gleam lsp",
		tools: ["gleam"],
	},
	{
		lang: "ocaml",
		dir: "tests/fixtures/tool-smoke/ocaml",
		file: "main.ml",
		serverHint: "ocamllsp",
		tools: ["ocaml-lsp-server"],
	},
	{
		lang: "clojure",
		dir: "tests/fixtures/tool-smoke/clojure",
		file: "main.clj",
		serverHint: "clojure-lsp",
		tools: ["clojure-lsp"],
	},
	{
		lang: "nix",
		dir: "tests/fixtures/tool-smoke/nix",
		file: "flake.nix",
		serverHint: "nixd",
		tools: ["nixd"],
	},
	{
		lang: "vue",
		dir: "tests/fixtures/tool-smoke/vue",
		file: "App.vue",
		serverHint: "@vue/language-server",
		tools: ["@vue/language-server"],
	},
	{
		lang: "svelte",
		dir: "tests/fixtures/tool-smoke/svelte",
		file: "App.svelte",
		serverHint: "svelte-language-server",
		tools: ["svelte-language-server"],
	},
	// Auxiliary LSP (cross-cutting, diagnostic-only) — attaches alongside the
	// primary language server. `auxiliaryServerIds` switches the touch to the
	// with-auxiliary scope; `auxiliarySourceMatch` asserts the auxiliary actually
	// produced a finding (proves install→spawn→scan→publish). `gitInit` gives the
	// temp workspace a .git so opengrep's repo-rooted server treats the fixture as
	// in-workspace. Generic: add a server-def + profile and a fixture entry here.
	{
		lang: "opengrep",
		dir: "tests/fixtures/tool-smoke/opengrep-aux",
		file: "danger.js",
		serverHint: "opengrep (auxiliary)",
		tools: ["opengrep"],
		auxiliaryServerIds: ["opengrep"],
		auxiliarySourceMatch: "semgrep|opengrep",
		gitInit: true,
	},
	// ast-grep structural linter (auxiliary, sgconfig-gated). The fixture carries an
	// sgconfig.yml + a rule dir, so the ast-grep LSP roots on it and scans the team's
	// own rule (#239 Phase 1). Proves install→spawn→compile-rules→scan→publish.
	{
		lang: "ast-grep",
		dir: "tests/fixtures/tool-smoke/ast-grep-aux",
		file: "danger.js",
		serverHint: "ast-grep (auxiliary)",
		tools: ["ast-grep"],
		auxiliaryServerIds: ["ast-grep"],
		auxiliarySourceMatch: "ast[-_]?grep",
		gitInit: true,
	},
	// zizmor GitHub Actions security scanner (auxiliary, #272). The fixture is a
	// workflow that interpolates an attacker-controllable issue title into a `run:`
	// step — zizmor's offline `template-injection` audit (no token needed) flags it.
	// Proves install→spawn→scan→publish on the with-auxiliary path.
	{
		lang: "zizmor",
		dir: "tests/fixtures/tool-smoke/zizmor-aux",
		file: ".github/workflows/ci.yml",
		serverHint: "zizmor (auxiliary)",
		tools: ["zizmor"],
		auxiliaryServerIds: ["zizmor"],
		auxiliarySourceMatch: "zizmor",
		gitInit: true,
	},
	// typos source-code spell checker (auxiliary, #283). The fixture is a markdown
	// doc with several known misspellings — typos' compiled-in dictionary flags
	// them with NO config (allow-list based). A markdown fixture deliberately
	// exercises the option-B prose coverage (the novel scope vs the code-only
	// auxiliaries). Proves install→spawn→scan→publish on the with-auxiliary path.
	{
		lang: "typos",
		dir: "tests/fixtures/tool-smoke/typos-aux",
		file: "notes.md",
		serverHint: "typos (auxiliary)",
		tools: ["typos-lsp"],
		auxiliaryServerIds: ["typos"],
		auxiliarySourceMatch: "typos",
		gitInit: true,
	},
	// ast-grep no-sgconfig BASELINE (#239 Phase 2). NO sgconfig in the fixture, so
	// the server must attach everywhere and launch with `lsp --config <shipped
	// baseline>` to run pi-lens's bundled ruleset (`arr.sort()` → the shipped
	// `no-sort-without-comparator`). Proves the baseline path, distinct from the
	// sgconfig-gated team-rules path above.
	{
		lang: "ast-grep-baseline",
		dir: "tests/fixtures/tool-smoke/ast-grep-baseline",
		file: "bad.ts",
		serverHint: "ast-grep (no-sgconfig baseline)",
		tools: ["ast-grep"],
		auxiliaryServerIds: ["ast-grep"],
		auxiliarySourceMatch: "ast[-_]?grep",
		gitInit: true,
	},
	// Alternate primary servers — a second language server for a language whose
	// default is registered ahead of it (deno↔typescript, jedi↔pyright). They are
	// reached only when the default is unavailable/disabled, so the harness writes
	// a `.pi-lens/lsp.json` disabling the default into the temp workspace (the real
	// user-facing selection mechanism) → getClientForFile falls through to the
	// alternate. The alternate must spawn + handshake + diagnose; `expectSourceMatch`
	// fingerprints the diagnostic `source` to prove the alternate (not the default)
	// produced it. Both auto-install via their `tools` ids under --install.
	{
		lang: "deno",
		dir: "tests/fixtures/tool-smoke/deno-alt",
		file: "bad.ts",
		serverHint: "deno (alternate of typescript)",
		tools: ["deno"],
		disableServers: ["typescript"],
		expectServerId: "deno",
		expectSourceMatch: "deno",
	},
	{
		lang: "jedi",
		dir: "tests/fixtures/tool-smoke/jedi-alt",
		file: "bad.py",
		serverHint: "jedi (alternate of pyright)",
		tools: ["jedi-language-server"],
		disableServers: ["python"],
		expectServerId: "python-jedi",
		expectSourceMatch: "compile|jedi",
	},
];

/**
 * Formatter fixtures (--format): a deliberately mis-formatted but otherwise
 * valid file per language. The expected `formatter` (by name, per
 * `listAllFormatters()`) must be selected by `getFormattersForFile` and, when
 * run via the real `formatFile`, must reformat the file (`changed === true`).
 * `tools` are installer ids to prefetch under --install (formatters auto-install
 * via their own resolveCommand otherwise). Toolchain-gated entries only pass
 * where the language toolchain is present (⚠ skip otherwise).
 */
const FORMAT_FIXTURES = [
	{
		// biome is pi-lens's smart-default JS/TS formatter (not prettier, which
		// only wins with explicit project config).
		lang: "javascript",
		dir: "tests/fixtures/format-smoke/javascript",
		file: "messy.js",
		formatter: "biome",
		tools: ["biome"],
	},
	{
		lang: "python",
		dir: "tests/fixtures/format-smoke/python",
		file: "messy.py",
		formatter: "ruff",
		tools: ["ruff"],
	},
	{
		lang: "toml",
		dir: "tests/fixtures/format-smoke/toml",
		file: "messy.toml",
		formatter: "taplo",
		tools: ["taplo"],
	},
	{
		lang: "shell",
		dir: "tests/fixtures/format-smoke/shell",
		file: "messy.sh",
		formatter: "shfmt",
		tools: ["shfmt"],
	},
	{
		// css/html/yaml carry a smart-default formatter policy, so the formatter
		// is auto-selected without project config (no .prettierrc/.biome needed).
		lang: "css",
		dir: "tests/fixtures/format-smoke/css",
		file: "messy.css",
		formatter: "biome",
		tools: ["biome"],
	},
	{
		lang: "html",
		dir: "tests/fixtures/format-smoke/html",
		file: "messy.html",
		formatter: "prettier",
		tools: ["prettier"],
	},
	{
		lang: "yaml",
		dir: "tests/fixtures/format-smoke/yaml",
		file: "messy.yaml",
		formatter: "prettier",
		tools: ["prettier"],
	},
	{
		// markdown/json have NO smart-default policy — prettier is only selected
		// with explicit config, so the fixture ships a `.prettierrc`.
		lang: "markdown",
		dir: "tests/fixtures/format-smoke/markdown",
		file: "messy.md",
		formatter: "prettier",
		tools: ["prettier"],
	},
	{
		lang: "json",
		dir: "tests/fixtures/format-smoke/json",
		file: "messy.json",
		formatter: "prettier",
		tools: ["prettier"],
	},
	// Toolchain-gated (skip where the toolchain is absent).
	{
		lang: "go",
		dir: "tests/fixtures/format-smoke/go",
		file: "messy.go",
		formatter: "gofmt",
		tools: [],
	},
	{
		lang: "rust",
		dir: "tests/fixtures/format-smoke/rust",
		file: "messy.rs",
		formatter: "rustfmt",
		tools: [],
	},
	{
		lang: "dart",
		dir: "tests/fixtures/format-smoke/dart",
		file: "messy.dart",
		formatter: "dart",
		tools: [],
	},
	{
		lang: "zig",
		dir: "tests/fixtures/format-smoke/zig",
		file: "messy.zig",
		formatter: "zig",
		tools: [],
	},
	{
		// ktlint is a smart-default (auto-installs); elixir's `mix format` is
		// toolchain-detected. No project config required.
		lang: "kotlin",
		dir: "tests/fixtures/format-smoke/kotlin",
		file: "messy.kt",
		formatter: "ktlint",
		tools: ["ktlint"],
	},
	{
		// ktfmt wins over the ktlint smart-default when the project ships its
		// .ktfmt opt-in marker (#129).
		lang: "kotlin",
		dir: "tests/fixtures/format-smoke/kotlin-ktfmt",
		file: "messy.kt",
		formatter: "ktfmt",
		tools: ["ktfmt"],
	},
	{
		lang: "elixir",
		dir: "tests/fixtures/format-smoke/elixir",
		file: "messy.ex",
		formatter: "mix",
		tools: [],
	},
	{
		// Config-gated formatters: the fixture ships the config each one's detect()
		// requires (gleam.toml / .rubocop.yml / .sqlfluff). csharpier needs the
		// `dotnet csharpier` tool installed (no config).
		lang: "gleam",
		dir: "tests/fixtures/format-smoke/gleam",
		file: "messy.gleam",
		formatter: "gleam",
		tools: [],
	},
	{
		lang: "ruby",
		dir: "tests/fixtures/format-smoke/ruby",
		file: "messy.rb",
		formatter: "rubocop",
		tools: ["rubocop"],
	},
	{
		lang: "sql",
		dir: "tests/fixtures/format-smoke/sql",
		file: "messy.sql",
		formatter: "sqlfluff",
		tools: ["sqlfluff"],
	},
	{
		lang: "csharp",
		dir: "tests/fixtures/format-smoke/csharp",
		file: "messy.cs",
		formatter: "csharpier",
		tools: [],
	},
	{
		lang: "terraform",
		dir: "tests/fixtures/format-smoke/terraform",
		file: "messy.tf",
		formatter: "terraform",
		tools: [],
	},
	{
		lang: "fsharp",
		dir: "tests/fixtures/format-smoke/fsharp",
		file: "messy.fs",
		formatter: "fantomas",
		tools: [],
	},
	{
		lang: "powershell",
		dir: "tests/fixtures/format-smoke/powershell",
		file: "messy.ps1",
		formatter: "psscriptanalyzer-format",
		tools: [],
	},
	{
		// Config-gated alternates: black is selected over ruff via pyproject
		// [tool.black]; standardrb over rubocop via .standard.yml; cmake-format
		// needs a .cmake-format.yaml. Each fixture ships that config.
		lang: "python-black",
		dir: "tests/fixtures/format-smoke/python-black",
		file: "messy.py",
		formatter: "black",
		tools: [],
	},
	{
		lang: "ruby-standard",
		dir: "tests/fixtures/format-smoke/ruby-standard",
		file: "messy.rb",
		formatter: "standardrb",
		tools: [],
	},
	{
		lang: "cmake",
		dir: "tests/fixtures/format-smoke/cmake",
		file: "messy.cmake",
		formatter: "cmake-format",
		tools: [],
	},
	{
		// oxfmt (the JS Oxidation Compiler formatter) is selected over biome via a
		// package.json `oxfmt` devDependency — the real npm package name (the
		// scoped `@oxc-project/oxfmt` the code used to look for doesn't exist).
		lang: "js-oxfmt",
		dir: "tests/fixtures/format-smoke/js-oxfmt",
		file: "messy.js",
		formatter: "oxfmt",
		tools: [],
	},
	// Standalone-binary formatters (no language runtime needed) — each fixture
	// ships the config its detect() requires (stylua.toml / .cljfmt.edn /
	// .php-cs-fixer.php / .editorconfig); ormolu needs none.
	{
		lang: "lua",
		dir: "tests/fixtures/format-smoke/lua",
		file: "messy.lua",
		formatter: "stylua",
		tools: [],
	},
	{
		lang: "haskell",
		dir: "tests/fixtures/format-smoke/haskell",
		file: "Messy.hs",
		formatter: "ormolu",
		tools: [],
	},
	{
		lang: "clojure",
		dir: "tests/fixtures/format-smoke/clojure",
		file: "messy.clj",
		formatter: "cljfmt",
		tools: [],
	},
	{
		lang: "php",
		dir: "tests/fixtures/format-smoke/php",
		file: "messy.php",
		formatter: "php-cs-fixer",
		tools: [],
	},
	{
		lang: "java-gjf",
		dir: "tests/fixtures/format-smoke/java-gjf",
		file: "Messy.java",
		formatter: "google-java-format",
		tools: [],
	},
	{
		lang: "cpp",
		dir: "tests/fixtures/format-smoke/cpp",
		file: "messy.cpp",
		formatter: "clang-format",
		tools: [],
	},
];

/**
 * Autofix fixtures (--autofix): a file with a SAFELY-autofixable lint violation.
 * The pipeline's safe-autofix phase (`runAutofix`) must select the expected
 * `tool` (per the autofix policy) and apply its fix (`fixedCount > 0`). This is
 * the pipeline path that mutates files via `--fix`/`--write` — distinct from
 * lint dispatch (lint-only) and the formatter pipeline (--format). Config-gated
 * tools ship the config their policy needs. `tools` are installer ids to
 * prefetch under --install.
 */
const AUTOFIX_FIXTURES = [
	{
		// ruff is a smart-default autofix for Python; F401 (unused import) is a
		// safe fix.
		lang: "python",
		dir: "tests/fixtures/autofix-smoke/python",
		file: "messy.py",
		tool: "ruff",
		tools: ["ruff"],
	},
	{
		// biome is the smart-default JS/TS autofix (eslint only with .eslintrc).
		lang: "javascript",
		dir: "tests/fixtures/autofix-smoke/javascript",
		file: "messy.js",
		tool: "biome",
		tools: ["biome"],
	},
	{
		lang: "ruby",
		dir: "tests/fixtures/autofix-smoke/ruby",
		file: "messy.rb",
		tool: "rubocop",
		tools: ["rubocop"],
	},
	{
		// sqlfluff is smart-default for .sql, but the tool needs a dialect to run,
		// so the fixture ships a minimal .sqlfluff.
		lang: "sql",
		dir: "tests/fixtures/autofix-smoke/sql",
		file: "messy.sql",
		tool: "sqlfluff",
		tools: ["sqlfluff"],
	},
	{
		// rust-clippy is smart-default for .rs; needless_return is a
		// MachineApplicable fix `cargo clippy --fix` rewrites. Needs a cargo project.
		lang: "rust",
		dir: "tests/fixtures/autofix-smoke/rust",
		file: "src/main.rs",
		tool: "rust-clippy",
		tools: [],
	},
	{
		// dart-analyze is smart-default for .dart; `dart fix --apply` applies the
		// prefer_const_declarations fix enabled in analysis_options.yaml.
		lang: "dart",
		dir: "tests/fixtures/autofix-smoke/dart",
		file: "lib/messy.dart",
		tool: "dart-analyze",
		tools: [],
	},
	{
		// stylelint is smart-default for .css but needs a config to run; the
		// fixture ships .stylelintrc.json (color-hex-length:short fixes #ffffff).
		lang: "css",
		dir: "tests/fixtures/autofix-smoke/css",
		file: "messy.css",
		tool: "stylelint",
		tools: ["stylelint"],
	},
	{
		// eslint is config-first: only selected when an eslint config is present
		// (eslint.config.js here). semi fixes the missing semicolons. eslint is
		// not auto-installed, so it must be on PATH.
		lang: "javascript-eslint",
		dir: "tests/fixtures/autofix-smoke/javascript-eslint",
		file: "messy.js",
		tool: "eslint",
		tools: [],
	},
	{
		// golangci-lint is config-first (.golangci.yml); the gofmt fixer reformats.
		lang: "go",
		dir: "tests/fixtures/autofix-smoke/go",
		file: "main.go",
		tool: "golangci-lint",
		tools: [],
	},
	{
		// markdownlint is smart-default; --fix strips trailing whitespace (MD009).
		lang: "markdown",
		dir: "tests/fixtures/autofix-smoke/markdown",
		file: "messy.md",
		tool: "markdownlint",
		tools: ["markdownlint"],
	},
	{
		// oxlint is config-first (.oxlintrc.json); no-var --fix rewrites var->let.
		lang: "js-oxlint",
		dir: "tests/fixtures/autofix-smoke/js-oxlint",
		file: "messy.js",
		tool: "oxlint",
		tools: ["oxlint"],
	},
	{
		// ktfmt is config-first (.ktfmt opt-in marker); it reformats the collapsed
		// body in place. Auto-installs via the maven-JAR strategy (#129).
		lang: "kotlin-ktfmt",
		dir: "tests/fixtures/autofix-smoke/kotlin-ktfmt",
		file: "messy.kt",
		tool: "ktfmt",
		tools: ["ktfmt"],
	},
	// NOTE: detekt --auto-correct (Kotlin) is wired into the autofix policy +
	// pipeline (config-first, mirroring the detekt runner's invocation) and guarded
	// by the policy-consistency test, but has no live fixture here: validating it
	// needs the detekt CLI plus the detekt-formatting plugin, which isn't a simple
	// install. Live-validation is deferred to a CI job with that toolchain.
];

// Generous cold-spawn / handshake budgets — the harness is not on the hot path,
// so give a cold server time to install (when --install), spawn, and initialize.
const LSP_CLIENT_WAIT_MS = 30000;
const LSP_DIAGNOSTICS_WAIT_MS = 8000;

// Auxiliary scanners (opengrep, ast-grep, zizmor) compile their rules on the
// FIRST scan of a session and may cache a late result that — by design —
// "surfaces on the next edit" (see the opengrep strategy in
// clients/lsp/server-strategies.ts: a cold scan that overruns aggregateWaitMs
// isn't lost, it lands on the next touch). The smoke does a single touch, so a
// cold rule-load that overran the deadline left this layer asserting 0
// diagnostics and reddening the nightly (a flake, not a real break). We instead
// touch up to AUX_TOUCH_ATTEMPTS times: the first touch warms the rule-load, and
// each later touch re-syncs the auxiliary (reopenOnResync → didClose+didOpen) so
// the now-warm scan re-runs and its diagnostic comes back. We stop early the
// moment the expected finding appears. The per-server aggregateWaitMs still
// bounds each attempt; this only adds attempts, it doesn't lengthen a passing one.
const AUX_TOUCH_ATTEMPTS = 3;
// Settle between retries so each re-touch actually re-opens the document. The LSP
// service skips the didOpen (shouldSkipNotify) when an identical-content touch
// lands within PI_LENS_LSP_TOUCH_DEBOUNCE_MS (default 1500ms) of the prior one;
// without re-opening, the auxiliary never re-scans and the retry just re-reads the
// same empty result. We can't disable the debounce from here — TOUCH_DEBOUNCE_MS
// is captured when clients/lsp is imported, which (ESM hoisting) runs before this
// module's body — so instead we wait just past the active debounce window. Read
// the same env + default the LSP uses, then add a margin, so this stays correct if
// the default changes.
const AUX_RETRY_SETTLE_MS =
	(Number.parseInt(process.env.PI_LENS_LSP_TOUCH_DEBOUNCE_MS ?? "1500", 10) ||
		1500) + 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const INFRA_FAILURES = new Set(["timeout", "exception", "server_error"]);

function parseArgs(argv) {
	const langs = [];
	let step2 = false;
	let verbose = false;
	let install = false;
	let lsp = false;
	let format = false;
	let autofix = false;
	for (const arg of argv) {
		if (arg === "--step2") step2 = true;
		else if (arg === "--verbose" || arg === "-v") verbose = true;
		else if (arg === "--install") install = true;
		else if (arg === "--lsp") lsp = true;
		else if (arg === "--format") format = true;
		else if (arg === "--autofix") autofix = true;
		else langs.push(arg);
	}
	return { langs, step2, verbose, install, lsp, format, autofix };
}

const TMP_PREFIX = "pi-lens-smoke-";

/**
 * Best-effort temp cleanup. On Windows the spawned LSP servers keep a handle on
 * the workspace until THIS process exits, so an in-run rmSync can EPERM; never
 * let that abort the run.
 */
function safeRm(dir) {
	try {
		fs.rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 200,
		});
	} catch {
		// leftover temp dir — swept on the next run (see sweepLeftovers)
	}
}

/**
 * Sweep leftovers from PRIOR runs. Those runs' LSP servers have long since
 * exited, so their workspace locks are released and the dirs delete cleanly —
 * this is why cleanup belongs at startup, not in the same process that holds the
 * lock. Keeps %TEMP% from accumulating across nightly runs without a separate
 * unlock step.
 */
function sweepLeftovers() {
	const tmp = os.tmpdir();
	let swept = 0;
	try {
		for (const entry of fs.readdirSync(tmp)) {
			if (!entry.startsWith(TMP_PREFIX)) continue;
			try {
				fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
				swept++;
			} catch {
				// still locked by a live run — leave it
			}
		}
	} catch {
		// tmpdir unreadable — ignore
	}
	return swept;
}

function copyDirToTemp(srcRel) {
	const src = path.join(repoRoot, srcRel);
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-smoke-"));
	fs.cpSync(src, dest, { recursive: true });
	return dest;
}

function downloadFile(url, dest) {
	return new Promise((resolve, reject) => {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		const request = https.get(url, (response) => {
			if (
				response.statusCode >= 300 &&
				response.statusCode < 400 &&
				response.headers.location
			) {
				response.resume();
				downloadFile(response.headers.location, dest).then(resolve, reject);
				return;
			}
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`download failed ${response.statusCode}: ${url}`));
				return;
			}
			const out = fs.createWriteStream(dest);
			response.pipe(out);
			out.on("finish", () => out.close(resolve));
			out.on("error", reject);
		});
		request.on("error", reject);
	});
}

async function ensureSmokeLombokJar(workspace, verbose) {
	const cached = path.join(os.tmpdir(), "pi-lens-smoke-cache", "lombok.jar");
	if (!fs.existsSync(cached) || fs.statSync(cached).size === 0) {
		if (verbose)
			console.error(`[java-lombok] downloading ${LOMBOK_DOWNLOAD_URL}`);
		await downloadFile(LOMBOK_DOWNLOAD_URL, cached);
	}
	const dest = path.join(workspace, ".lombok", "lombok.jar");
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(cached, dest);
	return dest;
}

/** Classify one target runner's outcome against the Step-1 bar. */
function classify(outcome) {
	if (!outcome) {
		return {
			state: "skip",
			detail: "not executed (filtered / when-skipped)",
			diags: 0,
		};
	}
	const { status, failureKind, failureMessage, diagnostics } = outcome.result;
	const diags = diagnostics.length;
	if (status === "failed" && INFRA_FAILURES.has(failureKind)) {
		return {
			state: "fail",
			detail: `${failureKind}${failureMessage ? `: ${failureMessage}` : ""}`,
			diags,
		};
	}
	if (status === "skipped") {
		return {
			state: "skip",
			detail: "runner skipped (tool/config unavailable)",
			diags,
		};
	}
	// succeeded, or failed with blocking_diagnostics → the tool ran and exited cleanly.
	return {
		state: "pass",
		detail: `${status}${failureKind ? ` (${failureKind})` : ""}`,
		diags,
	};
}

const ICON = { pass: "✓", fail: "✗", skip: "⚠" };

function report(rows, title) {
	const pad = (s, n) => String(s).padEnd(n);
	console.log(`\nLive tool-smoke (#209) — ${title}\n`);
	console.log(
		`${pad("", 2)} ${pad("LANG", 12)} ${pad("RUNNER/SERVER", 28)} ${pad("DIAG", 5)} DETAIL`,
	);
	for (const r of rows) {
		console.log(
			`${ICON[r.state]}  ${pad(r.lang, 12)} ${pad(r.runner, 28)} ${pad(r.diags, 5)} ${r.detail}`,
		);
	}
	const counts = { pass: 0, fail: 0, skip: 0 };
	for (const r of rows) counts[r.state]++;
	console.log(
		`\n${counts.pass} passed · ${counts.fail} failed · ${counts.skip} skipped (tool/config unavailable)`,
	);
	console.log("Legend: ✓ ok  ✗ failure  ⚠ unavailable (not a failure)\n");
	return counts.fail;
}

/**
 * LSP handshake layer — drives the real `LSPService.touchFile` (same entry the
 * lsp runner uses) per fixture, then asserts the handshake via
 * `getDiagnosticsHealth` (serverCountReady > 0). Returns the failure count.
 */
async function runLspHandshake({ langs, install, verbose }) {
	const lspEntry = path.join(repoRoot, "dist", "clients", "lsp", "index.js");
	if (!fs.existsSync(lspEntry)) {
		console.error(
			`dist build missing: ${lspEntry}\nRun \`npm run build:dist\` first.`,
		);
		process.exit(2);
	}
	const { getLSPService } = await import(pathToFileURL(lspEntry).href);
	const configEntry = path.join(
		repoRoot,
		"dist",
		"clients",
		"lsp",
		"config.js",
	);
	const { initLSPConfig } = await import(pathToFileURL(configEntry).href);

	let ensureTool;
	if (install) {
		const installerEntry = path.join(
			repoRoot,
			"dist",
			"clients",
			"installer",
			"index.js",
		);
		({ ensureTool } = await import(pathToFileURL(installerEntry).href));
	}

	const selected = langs.length
		? LSP_FIXTURES.filter((f) => langs.includes(f.lang))
		: LSP_FIXTURES;
	if (selected.length === 0) {
		console.error(`No LSP fixtures matched: ${langs.join(", ")}`);
		process.exit(2);
	}

	const lsp = getLSPService();
	const rows = [];
	for (const fx of selected) {
		const unavailableTools = new Set();
		if (install && ensureTool) {
			for (const toolId of fx.tools ?? []) {
				const resolved = await ensureTool(toolId);
				if (!resolved) unavailableTools.add(toolId);
				if (verbose) {
					console.error(
						`[${fx.lang}] ensureTool(${toolId}) → ${resolved ?? "UNAVAILABLE"}`,
					);
				}
			}
		}
		const workspace = copyDirToTemp(fx.dir);
		const absFile = path.join(workspace, fx.file);
		if (fx.lombokJar) {
			try {
				const jar = await ensureSmokeLombokJar(workspace, verbose);
				if (verbose) console.error(`[${fx.lang}] lombok.jar → ${jar}`);
			} catch (err) {
				rows.push({
					lang: fx.lang,
					runner: fx.serverHint,
					state: "skip",
					detail: `lombok.jar unavailable: ${err?.message ?? err}`,
					diags: 0,
				});
				safeRm(workspace);
				continue;
			}
		}
		// Some auxiliary servers (opengrep) root at the nearest .git — give the
		// temp workspace one so the copied fixture is treated as in-workspace.
		if (fx.gitInit) {
			try {
				execFileSync("git", ["init", "-q"], {
					cwd: workspace,
					stdio: "ignore",
				});
			} catch {
				// git unavailable — opengrep falls back to cwd; may not scan the temp file
			}
		}
		const auxIds = fx.auxiliaryServerIds ?? [];
		const useAux = auxIds.length > 0;
		const push = (state, detail, diags = 0) =>
			rows.push({ lang: fx.lang, runner: fx.serverHint, state, detail, diags });
		// Alternate-primary fixtures: disable the default server for this workspace
		// so getClientForFile falls through to the alternate.
		if (fx.disableServers) {
			fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
			fs.writeFileSync(
				path.join(workspace, ".pi-lens", "lsp.json"),
				JSON.stringify({ disabledServers: fx.disableServers }, null, 2),
			);
			await initLSPConfig(workspace);
			if (verbose) {
				console.error(
					`[${fx.lang}] disabled [${fx.disableServers.join(",")}] via .pi-lens/lsp.json → expecting ${fx.expectServerId}`,
				);
			}
		}
		try {
			if (!lsp.supportsLSP(absFile)) {
				push("skip", "no LSP server registered for this file");
				continue;
			}
			const content = fs.readFileSync(absFile, "utf8");
			let touched;
			let threw;
			// Auxiliary fixtures get up to AUX_TOUCH_ATTEMPTS touches: the first warms
			// the cold rule-load, later ones re-scan and pick up a finding that the
			// first (overrun) scan only cached. Stop the moment the expected source
			// appears. Non-aux fixtures resolve on the primary's first push, so one
			// touch suffices.
			const auxRe =
				useAux && fx.auxiliarySourceMatch
					? new RegExp(fx.auxiliarySourceMatch, "i")
					: null;
			// Don't burn retries on a tool that never installed — a zero result there
			// is "unavailable" (⚠), classified below, not a flake worth re-touching.
			// (Mirrors the `auxUnavailable` check in the assertion: known-unavailable
			// only when every declared tool is missing.)
			const auxToolList = fx.tools ?? [];
			const auxToolUnavailable =
				auxToolList.length > 0 &&
				auxToolList.every((t) => unavailableTools.has(t));
			const maxAttempts = auxRe && !auxToolUnavailable ? AUX_TOUCH_ATTEMPTS : 1;
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				try {
					touched = await lsp.touchFile(absFile, content, {
						diagnostics: "document",
						collectDiagnostics: true,
						clientScope: useAux ? "with-auxiliary" : "primary",
						...(useAux ? { auxiliaryServerIds: auxIds } : {}),
						maxClientWaitMs: LSP_CLIENT_WAIT_MS,
						maxDiagnosticsWaitMs: LSP_DIAGNOSTICS_WAIT_MS,
						source: "smoke-lsp",
					});
				} catch (err) {
					threw = err?.message ?? String(err);
					break;
				}
				if (!auxRe) break;
				const hit = (Array.isArray(touched) ? touched : []).some((d) =>
					auxRe.test(d.source || ""),
				);
				if (hit || attempt === maxAttempts) break;
				if (verbose) {
					console.error(
						`[${fx.lang}] aux=${auxIds.join(",")} attempt ${attempt}/${maxAttempts} no ${fx.auxiliarySourceMatch} finding yet — re-touching after ${AUX_RETRY_SETTLE_MS}ms`,
					);
				}
				// Wait past the touch-notify debounce so the next touch re-opens the
				// document and forces a fresh auxiliary scan (not a deduped no-op).
				await sleep(AUX_RETRY_SETTLE_MS);
			}
			// Auxiliary fixtures assert the cross-cutting server actually produced a
			// finding (proves install→spawn→scan→publish), matched by LSP `source`.
			if (auxRe && !threw) {
				const list = Array.isArray(touched) ? touched : [];
				const auxDiags = list.filter((d) => auxRe.test(d.source || ""));
				if (verbose) {
					console.error(
						`[${fx.lang}] aux=${auxIds.join(",")} matched=${auxDiags.length}/${list.length} sources=${JSON.stringify([...new Set(list.map((d) => d.source))])}`,
					);
				}
				// If the auxiliary server's tool never installed, a zero result is
				// "unavailable" (⚠), not a failure — mirrors the primary/alternate
				// readiness handling so a missing optional tool can't red the nightly.
				// (A tool that DID install but produced nothing is still a real fail.)
				const toolList = fx.tools ?? [];
				const auxUnavailable =
					toolList.length > 0 && toolList.every((t) => unavailableTools.has(t));
				if (auxDiags.length === 0 && auxUnavailable) {
					push(
						"skip",
						`auxiliary ${auxIds.join(",")} unavailable (tool not installed; pass --install)`,
					);
					continue;
				}
				push(
					auxDiags.length > 0 ? "pass" : "fail",
					auxDiags.length > 0
						? `auxiliary ${auxIds.join(",")} returned ${auxDiags.length} diagnostic(s)`
						: `auxiliary ${auxIds.join(",")} produced no diagnostics (expected /${fx.auxiliarySourceMatch}/)`,
					list.length,
				);
				continue;
			}
			// touchFile returns the diagnostics array once a client is ready (spawn
			// + initialize handshake completed), or undefined if none became ready
			// in the budget. (getDiagnosticsHealth is populated by getDiagnostics,
			// not touchFile, so it's only an extra hint when present.)
			const diags = Array.isArray(touched) ? touched.length : 0;
			if (verbose) {
				console.error(
					`[${fx.lang}] touched=${Array.isArray(touched) ? touched.length : touched} health=${JSON.stringify(lsp.getDiagnosticsHealth(absFile))}`,
				);
			}
			// Alternate fixtures: the default is disabled for this workspace, so the
			// only server that can serve is the alternate. Prove it spawned +
			// handshook + diagnosed by fingerprinting the diagnostic `source`
			// (deno → "deno-ts", jedi → "compile") — getDiagnosticsHealth isn't
			// populated by touchFile, so source-match is the reliable signal.
			if (fx.expectServerId && !threw) {
				if (!Array.isArray(touched)) {
					// No client became ready — the alternate isn't installed (and
					// --install wasn't passed or its install failed). Skip, don't fail.
					push(
						"skip",
						`${fx.expectServerId} unavailable (no client ready; pass --install or install ${(fx.tools ?? []).join(",")})`,
					);
					continue;
				}
				const list = touched;
				const sources = [...new Set(list.map((d) => d.source || "?"))];
				const re = fx.expectSourceMatch
					? new RegExp(fx.expectSourceMatch, "i")
					: null;
				const matched = re ? list.filter((d) => re.test(d.source || "")) : list;
				if (verbose) {
					console.error(
						`[${fx.lang}] alternate sources=${JSON.stringify(sources)} matched=${matched.length}/${list.length}`,
					);
				}
				push(
					matched.length > 0 ? "pass" : "fail",
					matched.length > 0
						? `alternate ${fx.expectServerId} served ${matched.length} diagnostic${matched.length === 1 ? "" : "s"} (source /${fx.expectSourceMatch}/; default [${fx.disableServers.join(",")}] disabled)`
						: list.length
							? `${fx.expectServerId}: ${list.length} diagnostic(s) but none matched source /${fx.expectSourceMatch}/ (got: ${sources.join(",")})`
							: `expected ${fx.expectServerId} to serve a diagnostic, got none (server missing/slow?)`,
					list.length,
				);
				continue;
			}
			if (threw) {
				push("fail", `handshake/server error: ${threw}`, diags);
			} else if (Array.isArray(touched)) {
				if (fx.expectNoMessageMatch) {
					const re = new RegExp(fx.expectNoMessageMatch, "i");
					const matched = touched.filter((d) => re.test(d.message || ""));
					push(
						matched.length === 0 ? "pass" : "fail",
						matched.length === 0
							? `handshook — Lombok-generated symbols resolved (${diags} diagnostic${diags === 1 ? "" : "s"})`
							: `Lombok unresolved diagnostic(s): ${matched.map((d) => d.message).join("; ")}`,
						diags,
					);
					continue;
				}
				push(
					"pass",
					`handshook — server replied${diags ? ` (${diags} diagnostic${diags === 1 ? "" : "s"})` : ""}`,
					diags,
				);
			} else {
				push(
					"skip",
					`no client ready in ${LSP_CLIENT_WAIT_MS}ms (server missing/slow; try --install)`,
				);
			}
		} catch (err) {
			push("fail", `error: ${err?.message ?? err}`);
		} finally {
			safeRm(workspace);
		}
	}

	try {
		await lsp.shutdown();
	} catch {
		// best-effort teardown
	}
	return report(rows, "LSP handshake (install → spawn → initialize)");
}

/**
 * Format layer — drives the REAL pipeline entry `FormatService.formatFile`
 * (exactly what `runFormatPhase` calls: enabled gate + `fileTime` external-mod
 * guard + `getFormattersForFile` selection + concurrent `formatFile` exec +
 * telemetry), which the lint dispatch never touches. A pass means the expected
 * formatter was selected for the file and actually reformatted the
 * deliberately-mangled fixture (`changed === true`). In pi-lens the "autofix"
 * for fixable linters IS their formatter (rubocop -a, ruff format, ktlint -F,
 * sqlfluff fix, biome, dart …), so this also covers the safe-autofix path.
 * Returns the failure count.
 */
async function runFormatSmoke({ langs, install, verbose }) {
	const fmtEntry = path.join(repoRoot, "dist", "clients", "format-service.js");
	if (!fs.existsSync(fmtEntry)) {
		console.error(
			`dist build missing: ${fmtEntry}\nRun \`npm run build:dist\` first.`,
		);
		process.exit(2);
	}
	const { getFormatService } = await import(pathToFileURL(fmtEntry).href);
	const formatService = getFormatService();

	let ensureTool;
	if (install) {
		const installerEntry = path.join(
			repoRoot,
			"dist",
			"clients",
			"installer",
			"index.js",
		);
		({ ensureTool } = await import(pathToFileURL(installerEntry).href));
	}

	const selected = langs.length
		? FORMAT_FIXTURES.filter((f) => langs.includes(f.lang))
		: FORMAT_FIXTURES;
	if (selected.length === 0) {
		console.error(`No format fixtures matched: ${langs.join(", ")}`);
		process.exit(2);
	}

	const rows = [];
	for (const fx of selected) {
		if (install && ensureTool) {
			for (const toolId of fx.tools ?? []) {
				const resolved = await ensureTool(toolId);
				if (verbose) {
					console.error(
						`[${fx.lang}] ensureTool(${toolId}) → ${resolved ?? "UNAVAILABLE"}`,
					);
				}
			}
		}
		const workspace = copyDirToTemp(fx.dir);
		const absFile = path.join(workspace, fx.file);
		const push = (state, detail) =>
			rows.push({
				lang: fx.lang,
				runner: fx.formatter,
				state,
				detail,
				diags: 0,
			});
		try {
			// Mirror runFormatPhase: establish the fileTime baseline (recordRead)
			// before formatting so the external-modification guard doesn't skip.
			formatService.recordRead(absFile);
			const summary = await formatService.formatFile(absFile);
			const names = summary.formatters.map((f) => f.name);
			if (verbose) {
				console.error(
					`[${fx.lang}] formatters selected: ${names.join(", ") || "(none)"} | anyChanged=${summary.anyChanged} allSucceeded=${summary.allSucceeded}`,
				);
			}
			const target = summary.formatters.find((f) => f.name === fx.formatter);
			if (!target) {
				push(
					"skip",
					names.length
						? `expected '${fx.formatter}' not selected (got: ${names.join(", ")})`
						: "no formatter selected for this file (toolchain/config missing?)",
				);
				continue;
			}
			if (!target.success) {
				const err = target.error ?? "unknown error";
				// A missing binary is "unavailable", not a failure (matches the rest
				// of the harness — the runner is selected via config, but the tool
				// isn't installed on this machine/runner).
				if (/ENOENT|not found|not recognized|No such file/i.test(err)) {
					push("skip", `tool not installed (${err})`);
				} else {
					push("fail", `formatter failed to run: ${err}`);
				}
			} else if (target.changed) {
				push("pass", `${fx.formatter} reformatted the file`);
			} else {
				push("fail", "ran clean but left the mis-formatted file unchanged");
			}
		} catch (err) {
			push("fail", `error: ${err?.message ?? err}`);
		} finally {
			safeRm(workspace);
		}
	}

	return report(rows, "Format (select → reformat)");
}

/**
 * Autofix layer — drives the pipeline's safe-autofix phase (`runAutofix`, what
 * `runPipeline` calls), which applies fixable linters in fix mode (ruff --fix,
 * biome --write, eslint --fix, stylelint/sqlfluff/rubocop/ktlint/rust-clippy)
 * gated by the autofix policy. Neither the lint layer (lint-only) nor --format
 * (formatters) exercises it, yet it MUTATES files. A pass means the expected
 * tool was policy-selected and fixed the fixture (`fixedCount > 0`). Returns the
 * failure count.
 */
async function runAutofixSmoke({ langs, install, verbose }) {
	const pipelineEntry = path.join(repoRoot, "dist", "clients", "pipeline.js");
	const biomeEntry = path.join(repoRoot, "dist", "clients", "biome-client.js");
	const ruffEntry = path.join(repoRoot, "dist", "clients", "ruff-client.js");
	for (const e of [pipelineEntry, biomeEntry, ruffEntry]) {
		if (!fs.existsSync(e)) {
			console.error(
				`dist build missing: ${e}\nRun \`npm run build:dist\` first.`,
			);
			process.exit(2);
		}
	}
	const { runAutofix } = await import(pathToFileURL(pipelineEntry).href);
	const { BiomeClient } = await import(pathToFileURL(biomeEntry).href);
	const { RuffClient } = await import(pathToFileURL(ruffEntry).href);

	let ensureTool;
	if (install) {
		const installerEntry = path.join(
			repoRoot,
			"dist",
			"clients",
			"installer",
			"index.js",
		);
		({ ensureTool } = await import(pathToFileURL(installerEntry).href));
	}

	const selected = langs.length
		? AUTOFIX_FIXTURES.filter((f) => langs.includes(f.lang))
		: AUTOFIX_FIXTURES;
	if (selected.length === 0) {
		console.error(`No autofix fixtures matched: ${langs.join(", ")}`);
		process.exit(2);
	}

	const getFlag = () => undefined;
	const dbg = verbose ? (m) => console.error(`  ${m}`) : () => {};
	const rows = [];
	for (const fx of selected) {
		if (install && ensureTool) {
			for (const toolId of fx.tools ?? []) {
				const resolved = await ensureTool(toolId);
				if (verbose) {
					console.error(
						`[${fx.lang}] ensureTool(${toolId}) → ${resolved ?? "UNAVAILABLE"}`,
					);
				}
			}
		}
		const workspace = copyDirToTemp(fx.dir);
		// Some autofixers refuse to run outside a VCS (cargo clippy --fix errors
		// "no VCS found"). In production the file lives in the user's repo, so
		// git-init the workspace to mirror that faithfully.
		try {
			execFileSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
		} catch {
			// git unavailable — VCS-gated autofixers will just skip
		}
		const absFile = path.join(workspace, fx.file);
		const push = (state, detail) =>
			rows.push({ lang: fx.lang, runner: fx.tool, state, detail, diags: 0 });
		try {
			const before = fs.readFileSync(absFile, "utf8");
			const deps = {
				biomeClient: new BiomeClient(),
				ruffClient: new RuffClient(),
				fixedThisTurn: new Set(),
			};
			const result = await runAutofix(absFile, workspace, getFlag, dbg, deps);
			const after = fs.readFileSync(absFile, "utf8");
			if (verbose) {
				console.error(
					`[${fx.lang}] attempted=[${result.attemptedTools.join(",")}] applied=[${result.autofixTools.join(",")}] fixedCount=${result.fixedCount}${result.skipReason ? ` skip=${result.skipReason}` : ""}`,
				);
			}
			const attempted = result.attemptedTools.includes(fx.tool);
			if (!attempted) {
				push(
					"skip",
					result.attemptedTools.length
						? `expected '${fx.tool}' not policy-selected (attempted: ${result.attemptedTools.join(",")})`
						: `no safe-autofix tool selected${result.skipReason ? ` (${result.skipReason})` : ""}`,
				);
			} else if (result.fixedCount > 0 && before !== after) {
				push(
					"pass",
					`${fx.tool} applied a safe fix (${result.autofixTools.join(",")})`,
				);
			} else {
				push(
					"fail",
					`${fx.tool} attempted but applied no fix / file unchanged`,
				);
			}
		} catch (err) {
			push("fail", `error: ${err?.message ?? err}`);
		} finally {
			safeRm(workspace);
		}
	}

	return report(rows, "Autofix (policy-select → safe --fix)");
}

async function main() {
	const { langs, step2, verbose, install, lsp, format, autofix } = parseArgs(
		process.argv.slice(2),
	);

	// Clean leftovers from prior runs (their file locks are released now).
	const swept = sweepLeftovers();
	if (verbose && swept > 0)
		console.error(`swept ${swept} leftover temp workspace(s)`);

	if (lsp) {
		process.exit(
			(await runLspHandshake({ langs, install, verbose })) > 0 ? 1 : 0,
		);
	}

	if (format) {
		process.exit(
			(await runFormatSmoke({ langs, install, verbose })) > 0 ? 1 : 0,
		);
	}

	if (autofix) {
		process.exit(
			(await runAutofixSmoke({ langs, install, verbose })) > 0 ? 1 : 0,
		);
	}

	const distEntry = path.join(
		repoRoot,
		"dist",
		"clients",
		"dispatch",
		"integration.js",
	);
	if (!fs.existsSync(distEntry)) {
		console.error(
			`dist build missing: ${distEntry}\nRun \`npm run build:dist\` first.`,
		);
		process.exit(2);
	}
	const { dispatchLintDetailed } = await import(pathToFileURL(distEntry).href);

	let ensureTool;
	if (install) {
		const installerEntry = path.join(
			repoRoot,
			"dist",
			"clients",
			"installer",
			"index.js",
		);
		({ ensureTool } = await import(pathToFileURL(installerEntry).href));
	}

	const selected = langs.length
		? FIXTURES.filter((f) => langs.includes(f.lang))
		: FIXTURES;
	if (selected.length === 0) {
		console.error(`No fixtures matched: ${langs.join(", ")}`);
		process.exit(2);
	}

	// Disable delta filtering so every applicable runner reports its full output.
	const pi = { getFlag: (flag) => (flag === "no-delta" ? true : undefined) };

	const rows = [];
	for (const fixture of selected) {
		if (install && ensureTool) {
			for (const toolId of fixture.tools ?? []) {
				const resolved = await ensureTool(toolId);
				if (verbose) {
					console.error(
						`[${fixture.lang}] ensureTool(${toolId}) → ${resolved ?? "UNAVAILABLE"}`,
					);
				}
			}
		}
		const workspace = copyDirToTemp(fixture.dir);
		const absFile = path.join(workspace, fixture.file);
		try {
			const { runners } = await dispatchLintDetailed(absFile, workspace, pi, {
				blockingOnly: false,
			});
			if (verbose) {
				const desc = runners
					.map((r) => {
						const { status, failureKind, failureMessage } = r.result;
						const why =
							status === "failed" && failureKind
								? `(${failureKind}: ${(failureMessage ?? "").slice(0, 100)})`
								: "";
						return `${r.runnerId}:${status}${why}`;
					})
					.join(", ");
				console.error(
					`[${fixture.lang}] executed runners: ${desc || "(none)"}`,
				);
			}
			for (const target of fixture.targets) {
				const outcome = runners.find((r) => r.runnerId === target);
				const verdict = classify(outcome);
				// Step 2: a tool that ran clean but found nothing on a known defect fails.
				if (
					step2 &&
					verdict.state === "pass" &&
					fixture.expectDiagnostic &&
					verdict.diags === 0
				) {
					verdict.state = "fail";
					verdict.detail =
						"ran clean but produced no diagnostic on known defect";
				}
				rows.push({ lang: fixture.lang, runner: target, ...verdict });
			}
		} catch (err) {
			for (const target of fixture.targets) {
				rows.push({
					lang: fixture.lang,
					runner: target,
					state: "fail",
					detail: `dispatch threw: ${err?.message ?? err}`,
					diags: 0,
				});
			}
		} finally {
			safeRm(workspace);
		}
	}

	process.exit(
		report(
			rows,
			step2 ? "Step 2 (spawn + diagnostic)" : "Step 1 (spawn + exit clean)",
		) > 0
			? 1
			: 0,
	);
}

// Run main() only when executed directly, not when imported (the
// smoke-fixture-coverage guard imports the fixture arrays below).
const invokedDirectly =
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err);
		process.exit(2);
	});
}

export { FIXTURES, LSP_FIXTURES, FORMAT_FIXTURES, AUTOFIX_FIXTURES };
