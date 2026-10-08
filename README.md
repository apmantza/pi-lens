<p align="center">
  <img src="https://raw.githubusercontent.com/apmantza/pi-lens/master/banner.png" alt="pi-lens" width="1100">
</p>

# pi-lens

pi-lens gives AI coding agents fast, language-aware feedback while they write/edit.

> **Working in this project as an AI agent?** Read the [agent guide](docs/agent-guide.md)
> for how pi-lens surfaces diagnostics (honesty labels, blockers, read-before-edit)
> and how to respond.

## What It Does

- LSP diagnostics and navigation across supported languages
- Impact cascade diagnostics that show which related files were affected and run LSP diagnostics on them
- Language-specific linters, type-checkers, and scanners on every write/edit
- Safe formatting/autofix where tools are configured or confidently detected
- ast-grep and tree-sitter structural rules for correctness/security smells
- Agent-facing tools for LSP navigation/diagnostics, AST search/replace,
  diagnostics state, and project intelligence
- Review-graph intelligence for supported languages via bundled tree-sitter WASMs
- Ranked identifier search (`symbol_search`) over an always-warm word index,
  feeding the discovery funnel (symbol_search → module_report → read_symbol)
- Diagnostic triage (`lens_diagnostic_mark`): findings can be marked
  false-positive, suppressed in source, deferred, or flagged-to-fix — honored
  across all surfaces
- `/lens-map` — interactive HTML dependency map of the project
- Read-guard and edit-autopatch support to reduce bad edits
- Background security/dependency scans for opted-in projects
- Runtime health telemetry (`/lens-health`) including a bounded degradation
  ledger for silently-degraded behavior (LSP breakers, formatter
  skips/failures, idle evictions, timeouts)
- MCP server (experimental) so Claude Code or any MCP client can drive the
  same diagnostics/read-substitute tools pi-lens exposes to pi

## Architecture

Most lifecycle events enter through one wrapper, which drops and counts events
that arrive on a replaced session. `tool_call` registers raw: it delegates
straight to a handler that owns its own total guard. Events fan out into the
edit-time lane and the LSP lane. Both lanes write into the findings stores.
Nothing reaches the agent from those stores until a freshness gate or an
explicit age label clears it.

```mermaid
flowchart TD
    subgraph host["pi host"]
        HOST["Host events<br/>tool_call, tool_result, turn_start/end,<br/>session_start/shutdown, agent_end, context"]
        WRAP["Stale-ctx wrapper<br/>skips and counts events on a replaced session<br/>tool_result, turn_start, turn_end, agent_end,<br/>agent_settled, session_start, context"]
    end

    subgraph guards["Guards"]
        RG["Read-guard<br/>blocks edits that lack prior reading"]
        GG["Git-guard<br/>holds commit/push while findings stay unresolved"]
    end

    subgraph edit["Edit-time lane"]
        PIPE["Post-write pipeline<br/>secrets, format, autofix, sync, lint, tests"]
        PLAN["Dispatch plan<br/>per file kind, per capability group"]
        RUN["Runners<br/>format, lint, types, security, smells, docs"]
        STRUCT["Structural rules<br/>tree-sitter queries and ast-grep"]
        BUS["files-touched bus<br/>tells extensions which paths moved"]
    end

    subgraph lsp["LSP lane"]
        POOL["Client pool<br/>warm reuse, idle eviction"]
        DIAGS["File and workspace diagnostics"]
        CASC["Impact cascade<br/>tiered wait policy"]
    end

    STORES["Findings stores<br/>widget state, warning caches, project snapshot"]

    subgraph gate["Freshness gating"]
        FRESH["Path freshness<br/>mtime vs scan time, past-EOF, dependency drift"]
        DISPO["Dispositions<br/>false-positive, suppress, defer, flagged"]
        LABEL["Explicit age label<br/>for findings no path gate can check"]
    end

    subgraph deliver["Delivery surfaces"]
        TURN["Turn-end findings injection"]
        WIDGET["Widget and footer tally"]
        TOOLS["lens_diagnostics tool"]
        NUDGE["Agent nudges"]
    end

    SESSION["Session lifecycle<br/>primary, sequential replacement, concurrent secondary"]
    SINKS["Observability sinks<br/>latency.log, degradation ledger, bounded telemetry,<br/>cache observability, cascade and tree-sitter logs"]
    CONFIG["Config-core<br/>resolve, merge, deny"]
    REVIEWGRAPH["Review-graph intelligence<br/>call graph, reverse deps, import resolution"]

    HOST --> WRAP
    HOST -->|tool_call, raw| RG
    HOST -->|tool_call, raw| GG
    WRAP -->|session_start| SESSION
    WRAP -->|tool_result| PIPE
    WRAP -->|tool_result, records reads and writes| RG
    SESSION --> POOL
    SESSION --> STORES
    PIPE --> PLAN
    PLAN --> RUN
    PLAN --> STRUCT
    PIPE --> POOL
    PIPE --> BUS
    CONFIG --> PIPE
    CONFIG --> PLAN
    STRUCT --> REVIEWGRAPH
    REVIEWGRAPH --> CASC
    POOL --> DIAGS
    DIAGS --> CASC
    RUN --> STORES
    STRUCT --> STORES
    DIAGS --> STORES
    CASC --> STORES
    BUS --> NUDGE
    RG -->|read and edit history filter| NUDGE
    STORES --> FRESH
    STORES --> LABEL
    FRESH --> DISPO
    DISPO --> TURN
    DISPO --> WIDGET
    DISPO --> TOOLS
    LABEL --> TURN
    TURN --> GG
    WRAP --> SINKS
    PIPE --> SINKS
    RUN --> SINKS
    STRUCT --> SINKS
    POOL --> SINKS
    CASC --> SINKS
    RG --> SINKS
    GG --> SINKS
    FRESH --> SINKS
```

Architecture-level view, updated when a lane changes. Per-tool inventories live
in [features](docs/features.md) and
[language coverage](docs/language-coverage.md). Today the edit-time lane carries
45+ runner modules over 35+ file kinds, and the LSP lane speaks to 47
language server definitions.

The gating box is an abstraction, not a call order. Freshness covers several
independent mechanisms: path freshness against scan time, past-EOF line checks,
and forward-import dependency drift. Dispositions are one more filter alongside
them, not a second stage every finding walks through. Read the box as "a finding
passes the gates that apply to it", and see `clients/finding-delivery-gate.ts`
for the per-surface contract.

## Install

```bash
pi install npm:pi-lens
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-lens
```

pi-lens delivers its four skills through the `pi.skills` package manifest, so
install it as a package (`npm:`, `git:`, or a local path); a package install
honours the host's `packages[].skills` filters (for example `[]`,
`!skills/<name>/SKILL.md`, or `-skills/<name>/SKILL.md`). Loading the extension
file directly (`pi --extension ./index.js`) does not read that manifest and
loads no pi-lens skills.

Requires Node.js >=22.19.0 (matches the pi host's own floor — see `engines`
in `package.json`).

Letting a coding agent do it: paste this into its prompt.

```text
Install pi-lens (npm:pi-lens) into pi, then read AGENTS.md in
https://github.com/apmantza/pi-lens for how the extension works and how it
expects to be operated.
```

> **npm v12 users:** dependency lifecycle scripts (e.g. `@ast-grep/cli`'s
> `postinstall`) now require explicit approval — if `npm install` warns about
> unreviewed install scripts, review and allow them with
> `npm approve-scripts`, or trust the `allowScripts` entries already declared
> in this package's `package.json` (maintainers: see CONTRIBUTING.md
> "Lifecycle-script approvals"). Installing from a git source (`pi install
> git:...` / `pi update --extension git:...`) may similarly prompt for
> git-dependency approval; accept it to let the `prepare` build step run.

## Documentation

- [Agent guide](docs/agent-guide.md) — how an AI agent should consume and respond to pi-lens
- [Agent tools](docs/agent-tools.md) — pi tool names, scopes, and arguments
- [Usage guide](docs/usage.md) — lifecycle, tool behavior, MCP notes, and
  troubleshooting
- [Features](docs/features.md) — detailed feature reference
- [Word index](docs/word-index.md) — identifier search (`symbol_search`) and
  the discovery funnel
- [Tools and commands](docs/tools.md) — runtime flags and slash commands
- [Diagnostic dispositions](docs/dispositions.md) — triage: false-positive,
  suppress, defer, flagged-to-fix
- [Settings](docs/settings.md) — the configuration hub: defaults, env vars, CLI
  flags, and global vs project config at a glance
- [Configuration](docs/globalconfig.md) — global and project config files
- [Environment variables](docs/environment-variables.md) — common env vars and
  full reference
- [Language coverage](docs/language-coverage.md) — supported languages, runners,
  and formatters
- [Dependencies](docs/dependencies.md) — auto-install policy and external tools
- [Custom rules](docs/custom-rules.md) — project ast-grep and tree-sitter rules
- [MCP server](docs/mcp.md) — experimental MCP server for Claude Code and
  other MCP clients
- [Architecture decision records](docs/adr/README.md) — settled design
  decisions, linked from the engineering-defect catalog

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow, runner,
LSP, formatter, and rule checklists, and issue/PR conventions.

Security issues should be reported privately; see [`SECURITY.md`](SECURITY.md).
pi-lens is released under the [MIT License](LICENSE).

## Contributors

Thanks goes to these wonderful people:
<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/apmantza"><img src="https://avatars.githubusercontent.com/u/247365598?v=4" width="100px;" alt=""/><br /><sub><b>Apostolos Mantzaris</b></sub></a><br /><a href="#code-apmantza" title="Code">💻</a> <a href="#doc-apmantza" title="Documentation">📖</a> <a href="#ideas-apmantza" title="Ideas & Planning">🤔</a> <a href="#maintenance-apmantza" title="Maintenance">🚧</a> <a href="#review-apmantza" title="Reviewed Pull Requests">👀</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/AngriestBird"><img src="https://avatars.githubusercontent.com/u/12663269?v=4" width="100px;" alt=""/><br /><sub><b>Kenneth McCormick</b></sub></a><br /><a href="#bug-AngriestBird" title="Bug reports">🐛</a> <a href="#code-AngriestBird" title="Code">💻</a> <a href="#ideas-AngriestBird" title="Ideas & Planning">🤔</a> <a href="#doc-AngriestBird" title="Documentation">📖</a> <a href="https://github.com/apmantza/pi-lens/commits?author=AngriestBird" title="Tests">⚠️</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/anh-chu"><img src="https://avatars.githubusercontent.com/u/34973633?v=4" width="100px;" alt=""/><br /><sub><b>Anh Chu</b></sub></a><br /><a href="#code-anh-chu" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/loss-and-quick"><img src="https://avatars.githubusercontent.com/u/39405619?v=4" width="100px;" alt=""/><br /><sub><b>minicx</b></sub></a><br /><a href="#code-loss-and-quick" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/silvanshade"><img src="https://avatars.githubusercontent.com/u/11022302?v=4" width="100px;" alt=""/><br /><sub><b>silvanshade</b></sub></a><br /><a href="#code-silvanshade" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tifandotme"><img src="https://avatars.githubusercontent.com/u/33323177?v=4" width="100px;" alt=""/><br /><sub><b>Tifan Dwi Avianto</b></sub></a><br /><a href="#code-tifandotme" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/amit-gshe"><img src="https://avatars.githubusercontent.com/u/7383028?v=4" width="100px;" alt=""/><br /><sub><b>Amit</b></sub></a><br /><a href="#code-amit-gshe" title="Code">💻</a> <a href="#bug-amit-gshe" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/fractiunate"><img src="https://avatars.githubusercontent.com/u/78024279?v=4" width="100px;" alt=""/><br /><sub><b>Fractiunate // David Rahäuser</b></sub></a><br /><a href="#code-fractiunate" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/vkarasen"><img src="https://avatars.githubusercontent.com/u/7932536?v=4" width="100px;" alt=""/><br /><sub><b>Vitali Karasenko</b></sub></a><br /><a href="#code-vkarasen" title="Code">💻</a> <a href="#ideas-vkarasen" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/rfxlamia"><img src="https://avatars.githubusercontent.com/u/222023708?v=4" width="100px;" alt=""/><br /><sub><b>V</b></sub></a><br /><a href="#code-rfxlamia" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/fabio-dee"><img src="https://avatars.githubusercontent.com/u/10808443?v=4" width="100px;" alt=""/><br /><sub><b>Fabio Dee</b></sub></a><br /><a href="#code-fabio-dee" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/moj02090"><img src="https://avatars.githubusercontent.com/u/57255166?v=4" width="100px;" alt=""/><br /><sub><b>moj02090</b></sub></a><br /><a href="#code-moj02090" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mehalter"><img src="https://avatars.githubusercontent.com/u/1591837?v=4" width="100px;" alt=""/><br /><sub><b>Micah Halter</b></sub></a><br /><a href="#code-mehalter" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/JulienEllie"><img src="https://avatars.githubusercontent.com/u/670518?v=4" width="100px;" alt=""/><br /><sub><b>Julien Ellie</b></sub></a><br /><a href="#code-JulienEllie" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Istar-Eldritch"><img src="https://avatars.githubusercontent.com/u/3746468?v=4" width="100px;" alt=""/><br /><sub><b>Ruben Paz</b></sub></a><br /><a href="#code-Istar-Eldritch" title="Code">💻</a> <a href="#bug-Istar-Eldritch" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/cjunxiang"><img src="https://avatars.githubusercontent.com/u/26619858?v=4" width="100px;" alt=""/><br /><sub><b>C.Junxiang</b></sub></a><br /><a href="#code-cjunxiang" title="Code">💻</a> <a href="#bug-cjunxiang" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/trvon"><img src="https://avatars.githubusercontent.com/u/6031322?v=4" width="100px;" alt=""/><br /><sub><b>Trevon</b></sub></a><br /><a href="#code-trvon" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/cmptr"><img src="https://avatars.githubusercontent.com/u/32746889?v=4" width="100px;" alt=""/><br /><sub><b>Aaron Bell</b></sub></a><br /><a href="#code-cmptr" title="Code">💻</a> <a href="#bug-cmptr" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/StartupBros"><img src="https://avatars.githubusercontent.com/u/16693591?v=4" width="100px;" alt=""/><br /><sub><b>Will Mitchell</b></sub></a><br /><a href="#code-StartupBros" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/spyrosbazios"><img src="https://avatars.githubusercontent.com/u/37960233?v=4" width="100px;" alt=""/><br /><sub><b>spyrosbazios</b></sub></a><br /><a href="#code-spyrosbazios" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Roman-Galeev"><img src="https://avatars.githubusercontent.com/u/40388226?v=4" width="100px;" alt=""/><br /><sub><b>Roman Galeev</b></sub></a><br /><a href="#code-Roman-Galeev" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jerryfan"><img src="https://avatars.githubusercontent.com/u/2540814?v=4" width="100px;" alt=""/><br /><sub><b>jerryfan</b></sub></a><br /><a href="#code-jerryfan" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/shaDmx"><img src="https://avatars.githubusercontent.com/u/91132641?v=4" width="100px;" alt=""/><br /><sub><b>Max L.</b></sub></a><br /><a href="#code-shaDmx" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/radge"><img src="https://avatars.githubusercontent.com/u/129205?v=4" width="100px;" alt=""/><br /><sub><b>David Ryan</b></sub></a><br /><a href="#code-radge" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/JayceFreeman"><img src="https://avatars.githubusercontent.com/u/92962110?v=4" width="100px;" alt=""/><br /><sub><b>JayceFreeman</b></sub></a><br /><a href="#code-JayceFreeman" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/bloodf"><img src="https://avatars.githubusercontent.com/u/1626923?v=4" width="100px;" alt=""/><br /><sub><b>Heitor Ramon Ribeiro</b></sub></a><br /><a href="#code-bloodf" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/feoh"><img src="https://avatars.githubusercontent.com/u/330070?v=4" width="100px;" alt=""/><br /><sub><b>Chris Patti</b></sub></a><br /><a href="#code-feoh" title="Code">💻</a> <a href="#bug-feoh" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/chenxin-yan"><img src="https://avatars.githubusercontent.com/u/71162231?v=4" width="100px;" alt=""/><br /><sub><b>Chenxin Yan</b></sub></a><br /><a href="#code-chenxin-yan" title="Code">💻</a> <a href="#doc-chenxin-yan" title="Documentation">📖</a> <a href="#bug-chenxin-yan" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/flowing-abyss"><img src="https://avatars.githubusercontent.com/u/98622217?v=4" width="100px;" alt=""/><br /><sub><b>flowing-abyss</b></sub></a><br /><a href="#code-flowing-abyss" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/shaochong-theoai"><img src="https://avatars.githubusercontent.com/u/305592060?v=4" width="100px;" alt=""/><br /><sub><b>shaochong-theoai</b></sub></a><br /><a href="#code-shaochong-theoai" title="Code">💻</a> <a href="#ideas-shaochong-theoai" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/xuli500177"><img src="https://avatars.githubusercontent.com/u/62830942?v=4" width="100px;" alt=""/><br /><sub><b>Xu Yili</b></sub></a><br /><a href="#bug-xuli500177" title="Bug reports">🐛</a> <a href="#code-xuli500177" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ricardoraposo"><img src="https://avatars.githubusercontent.com/u/50217712?v=4" width="100px;" alt=""/><br /><sub><b>Ricardo Raposo</b></sub></a><br /><a href="#code-ricardoraposo" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jsmestad"><img src="https://avatars.githubusercontent.com/u/16150?v=4" width="100px;" alt=""/><br /><sub><b>Justin Smestad</b></sub></a><br /><a href="#code-jsmestad" title="Code">💻</a> <a href="#ideas-jsmestad" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/anasalsbey-glitch"><img src="https://avatars.githubusercontent.com/u/283609702?v=4" width="100px;" alt=""/><br /><sub><b>anasalsbey-glitch</b></sub></a><br /><a href="#code-anasalsbey-glitch" title="Code">💻</a> <a href="#bug-anasalsbey-glitch" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/PeraSite"><img src="https://avatars.githubusercontent.com/u/19837403?v=4" width="100px;" alt=""/><br /><sub><b>정제훈</b></sub></a><br /><a href="#code-PeraSite" title="Code">💻</a> <a href="#ideas-PeraSite" title="Ideas & Planning">🤔</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ymek"><img src="https://avatars.githubusercontent.com/u/300569?v=4" width="100px;" alt=""/><br /><sub><b>Myke Stubbs</b></sub></a><br /><a href="#code-ymek" title="Code">💻</a> <a href="#bug-ymek" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/JSap0914"><img src="https://avatars.githubusercontent.com/u/116227558?v=4" width="100px;" alt=""/><br /><sub><b>JSap0914</b></sub></a><br /><a href="#code-JSap0914" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/knthmn"><img src="https://avatars.githubusercontent.com/u/60438008?v=4" width="100px;" alt=""/><br /><sub><b>Kent Hou Man</b></sub></a><br /><a href="#code-knthmn" title="Code">💻</a> <a href="#bug-knthmn" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://neumie.dev/"><img src="https://avatars.githubusercontent.com/u/23665482?v=4" width="100px;" alt=""/><br /><sub><b>Jakub Neumann</b></sub></a><br /><a href="#code-neumie" title="Code">💻</a> <a href="#bug-neumie" title="Bug reports">🐛</a> <a href="#ideas-neumie" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/cy7372"><img src="https://avatars.githubusercontent.com/u/142197117?v=4" width="100px;" alt=""/><br /><sub><b>CyYu</b></sub></a><br /><a href="#code-cy7372" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/carolitascl"><img src="https://avatars.githubusercontent.com/u/26188349?v=4" width="100px;" alt=""/><br /><sub><b>Carolina</b></sub></a><br /><a href="#bug-carolitascl" title="Bug reports">🐛</a> <a href="#ideas-carolitascl" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/leakedby"><img src="https://avatars.githubusercontent.com/u/4213260?v=4" width="100px;" alt=""/><br /><sub><b>LeakedBy</b></sub></a><br /><a href="#bug-leakedby" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mdbooth"><img src="https://avatars.githubusercontent.com/u/1318691?v=4" width="100px;" alt=""/><br /><sub><b>Matthew Booth</b></sub></a><br /><a href="#bug-mdbooth" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Wiedzmin89"><img src="https://avatars.githubusercontent.com/u/61706855?v=4" width="100px;" alt=""/><br /><sub><b>Wiedzmin89</b></sub></a><br /><a href="#ideas-Wiedzmin89" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/grodingo"><img src="https://avatars.githubusercontent.com/u/244184972?v=4" width="100px;" alt=""/><br /><sub><b>Virgile</b></sub></a><br /><a href="#bug-grodingo" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/finnvyrn"><img src="https://avatars.githubusercontent.com/u/90801772?v=4" width="100px;" alt=""/><br /><sub><b>Finn</b></sub></a><br /><a href="#ideas-finnvyrn" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ywh555hhh"><img src="https://avatars.githubusercontent.com/u/121592812?v=4" width="100px;" alt=""/><br /><sub><b>Wayne E</b></sub></a><br /><a href="#bug-ywh555hhh" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/RimuruW"><img src="https://avatars.githubusercontent.com/u/59136309?v=4" width="100px;" alt=""/><br /><sub><b>RimuruW</b></sub></a><br /><a href="#ideas-RimuruW" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Bjynt"><img src="https://avatars.githubusercontent.com/u/22177300?v=4" width="100px;" alt=""/><br /><sub><b>Bjynt</b></sub></a><br /><a href="#bug-Bjynt" title="Bug reports">🐛</a> <a href="#ideas-Bjynt" title="Ideas & Planning">🤔</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/pvtri96"><img src="https://avatars.githubusercontent.com/u/28696888?v=4" width="100px;" alt=""/><br /><sub><b>Tri Van Pham</b></sub></a><br /><a href="#bug-pvtri96" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/BingWuJ"><img src="https://avatars.githubusercontent.com/u/117666511?v=4" width="100px;" alt=""/><br /><sub><b>BingWuJ</b></sub></a><br /><a href="#bug-BingWuJ" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tackleberrybey"><img src="https://avatars.githubusercontent.com/u/156954032?v=4" width="100px;" alt=""/><br /><sub><b>tackleberrybey</b></sub></a><br /><a href="#bug-tackleberrybey" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/TaterDoge"><img src="https://avatars.githubusercontent.com/u/121467933?v=4" width="100px;" alt=""/><br /><sub><b>Mariann Abshire</b></sub></a><br /><a href="#bug-TaterDoge" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ProbabilityEngineer"><img src="https://avatars.githubusercontent.com/u/38498804?v=4" width="100px;" alt=""/><br /><sub><b>ProbabilityEngineer</b></sub></a><br /><a href="#ideas-ProbabilityEngineer" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/LeonardoRick"><img src="https://avatars.githubusercontent.com/u/17517057?v=4" width="100px;" alt=""/><br /><sub><b>Leonardo Rick</b></sub></a><br /><a href="#bug-LeonardoRick" title="Bug reports">🐛</a> <a href="#ideas-LeonardoRick" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/kenbanks-peng"><img src="https://avatars.githubusercontent.com/u/26904200?v=4" width="100px;" alt=""/><br /><sub><b>Ken Banks</b></sub></a><br /><a href="#bug-kenbanks-peng" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/rstacruz"><img src="https://avatars.githubusercontent.com/u/74385?v=4" width="100px;" alt=""/><br /><sub><b>Rico Sta. Cruz</b></sub></a><br /><a href="#ideas-rstacruz" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/acidnik"><img src="https://avatars.githubusercontent.com/u/1227955?v=4" width="100px;" alt=""/><br /><sub><b>Nikita Bilous</b></sub></a><br /><a href="#bug-acidnik" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/av1155"><img src="https://avatars.githubusercontent.com/u/117413846?v=4" width="100px;" alt=""/><br /><sub><b>Andrea Arturo Venti Fuentes</b></sub></a><br /><a href="#bug-av1155" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/dacec354"><img src="https://avatars.githubusercontent.com/u/90093629?v=4" width="100px;" alt=""/><br /><sub><b>dacec354</b></sub></a><br /><a href="#bug-dacec354" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/nodnarbnitram"><img src="https://avatars.githubusercontent.com/u/44812862?v=4" width="100px;" alt=""/><br /><sub><b>Brandon Martin</b></sub></a><br /><a href="#bug-nodnarbnitram" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/alpertarhan"><img src="https://avatars.githubusercontent.com/u/50966980?v=4" width="100px;" alt=""/><br /><sub><b>Alper Tarhan</b></sub></a><br /><a href="#bug-alpertarhan" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/asolopovas"><img src="https://avatars.githubusercontent.com/u/6893216?v=4" width="100px;" alt=""/><br /><sub><b>Andrius Solopovas</b></sub></a><br /><a href="#bug-asolopovas" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/GrahamJenkins"><img src="https://avatars.githubusercontent.com/u/6607975?v=4" width="100px;" alt=""/><br /><sub><b>Graham Jenkins</b></sub></a><br /><a href="#bug-GrahamJenkins" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/wings1848"><img src="https://avatars.githubusercontent.com/u/120104016?v=4" width="100px;" alt=""/><br /><sub><b>Wings Butterfly</b></sub></a><br /><a href="#bug-wings1848" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/JohannesKlauss"><img src="https://avatars.githubusercontent.com/u/6214415?v=4" width="100px;" alt=""/><br /><sub><b>Johannes Klauss</b></sub></a><br /><a href="#ideas-JohannesKlauss" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tan-yong-sheng"><img src="https://avatars.githubusercontent.com/u/64836390?v=4" width="100px;" alt=""/><br /><sub><b>Tan Yong Sheng</b></sub></a><br /><a href="#ideas-tan-yong-sheng" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/fmatray"><img src="https://avatars.githubusercontent.com/u/8267716?v=4" width="100px;" alt=""/><br /><sub><b>Frédéric</b></sub></a><br /><a href="#bug-fmatray" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/fuentesjr"><img src="https://avatars.githubusercontent.com/u/9240?v=4" width="100px;" alt=""/><br /><sub><b>Salvador Fuentes Jr</b></sub></a><br /><a href="#bug-fuentesjr" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Viterkim"><img src="https://avatars.githubusercontent.com/u/17838985?v=4" width="100px;" alt=""/><br /><sub><b>Viktor</b></sub></a><br /><a href="#bug-Viterkim" title="Bug reports">🐛</a> <a href="#ideas-Viterkim" title="Ideas & Planning">🤔</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ortonomy"><img src="https://avatars.githubusercontent.com/u/6688676?v=4" width="100px;" alt=""/><br /><sub><b>Gregory Orton</b></sub></a><br /><a href="#bug-ortonomy" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jimallen"><img src="https://avatars.githubusercontent.com/u/868773?v=4" width="100px;" alt=""/><br /><sub><b>Jim Allen</b></sub></a><br /><a href="#bug-jimallen" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/quantfiction"><img src="https://avatars.githubusercontent.com/u/49965454?v=4" width="100px;" alt=""/><br /><sub><b>quantfiction</b></sub></a><br /><a href="#bug-quantfiction" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Artawower"><img src="https://avatars.githubusercontent.com/u/16963833?v=4" width="100px;" alt=""/><br /><sub><b>Art</b></sub></a><br /><a href="#bug-Artawower" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/chozandrias76"><img src="https://avatars.githubusercontent.com/u/2087677?v=4" width="100px;" alt=""/><br /><sub><b>Colin Swenson-Healey</b></sub></a><br /><a href="#bug-chozandrias76" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/JustlyAI"><img src="https://avatars.githubusercontent.com/u/12634140?v=4" width="100px;" alt=""/><br /><sub><b>Laurent Wiesel</b></sub></a><br /><a href="#bug-JustlyAI" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/stark-bit"><img src="https://avatars.githubusercontent.com/u/44064758?v=4" width="100px;" alt=""/><br /><sub><b>Rei Starks</b></sub></a><br /><a href="#bug-stark-bit" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/robertoecf"><img src="https://avatars.githubusercontent.com/u/54923863?v=4" width="100px;" alt=""/><br /><sub><b>Roberto Freitas</b></sub></a><br /><a href="#bug-robertoecf" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tmttodd"><img src="https://avatars.githubusercontent.com/u/160077416?v=4" width="100px;" alt=""/><br /><sub><b>tmttodd</b></sub></a><br /><a href="#bug-tmttodd" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/smaharnav"><img src="https://avatars.githubusercontent.com/u/263328627?v=4" width="100px;" alt=""/><br /><sub><b>smaharnav</b></sub></a><br /><a href="#bug-smaharnav" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/MzaGuille"><img src="https://avatars.githubusercontent.com/u/151482698?v=4" width="100px;" alt=""/><br /><sub><b>Mza.Guille</b></sub></a><br /><a href="#bug-MzaGuille" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://jasonrimmer.com/"><img src="https://avatars.githubusercontent.com/u/629?v=4" width="100px;" alt=""/><br /><sub><b>Jason Rimmer</b></sub></a><br /><a href="#bug-jrimmer" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ArthurHeymans"><img src="https://avatars.githubusercontent.com/u/15137817?v=4" width="100px;" alt=""/><br /><sub><b>Arthur Heymans</b></sub></a><br /><a href="#ideas-ArthurHeymans" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Blue-B"><img src="https://avatars.githubusercontent.com/u/55532956?v=4" width="100px;" alt=""/><br /><sub><b>Blue-B</b></sub></a><br /><a href="#bug-Blue-B" title="Bug reports">🐛</a> <a href="#ideas-Blue-B" title="Ideas & Planning">🤔</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/bisko"><img src="https://avatars.githubusercontent.com/u/184938?v=4" width="100px;" alt=""/><br /><sub><b>Biser Perchinkov</b></sub></a><br /><a href="#bug-bisko" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/xificurC"><img src="https://avatars.githubusercontent.com/u/4800719?v=4" width="100px;" alt=""/><br /><sub><b>Peter Nagy</b></sub></a><br /><a href="#bug-xificurC" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/orest-tokovenko-block"><img src="https://avatars.githubusercontent.com/u/190554467?v=4" width="100px;" alt=""/><br /><sub><b>Orest Tokovenko</b></sub></a><br /><a href="#bug-orest-tokovenko-block" title="Bug reports">🐛</a> <a href="#ideas-orest-tokovenko-block" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://eisterman.dev/"><img src="https://avatars.githubusercontent.com/u/3028953?v=4" width="100px;" alt=""/><br /><sub><b>Federico Pasqua</b></sub></a><br /><a href="#bug-eisterman" title="Bug reports">🐛</a> <a href="#ideas-eisterman" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/black-snow"><img src="https://avatars.githubusercontent.com/u/579733?v=4" width="100px;" alt=""/><br /><sub><b>Ronald</b></sub></a><br /><a href="#bug-black-snow" title="Bug reports">🐛</a> <a href="#ideas-black-snow" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/aaronkyriesenbach"><img src="https://avatars.githubusercontent.com/u/12665860?v=4" width="100px;" alt=""/><br /><sub><b>Aaron Ky-Riesenbach</b></sub></a><br /><a href="#bug-aaronkyriesenbach" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/LovelyLoong"><img src="https://avatars.githubusercontent.com/u/54889641?v=4" width="100px;" alt=""/><br /><sub><b>可爱的龙</b></sub></a><br /><a href="#bug-LovelyLoong" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/pppobear"><img src="https://avatars.githubusercontent.com/u/21952175?v=4" width="100px;" alt=""/><br /><sub><b>pppobear</b></sub></a><br /><a href="#bug-pppobear" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/bcachet"><img src="https://avatars.githubusercontent.com/u/45542?v=4" width="100px;" alt=""/><br /><sub><b>Bertrand Cachet</b></sub></a><br /><a href="#code-bcachet" title="Code">💻</a> <a href="#ideas-bcachet" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/EarthChen"><img src="https://avatars.githubusercontent.com/u/20179425?v=4" width="100px;" alt=""/><br /><sub><b>earthchen</b></sub></a><br /><a href="#code-EarthChen" title="Code">💻</a> <a href="#bug-EarthChen" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Don-Yin"><img src="https://avatars.githubusercontent.com/u/65135356?v=4" width="100px;" alt=""/><br /><sub><b>Don Yin</b></sub></a><br /><a href="#code-Don-Yin" title="Code">💻</a> <a href="#bug-Don-Yin" title="Bug reports">🐛</a> <a href="#ideas-Don-Yin" title="Ideas & Planning">🤔</a> <a href="#doc-Don-Yin" title="Documentation">📖</a> <a href="https://github.com/apmantza/pi-lens/commits?author=Don-Yin" title="Tests">⚠️</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ELA718"><img src="https://avatars.githubusercontent.com/u/193304463?v=4" width="100px;" alt=""/><br /><sub><b>ELA718</b></sub></a><br /><a href="#doc-ELA718" title="Documentation">📖</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/sujeito-operator/pilot"><img src="https://avatars.githubusercontent.com/u/313599463?v=4" width="100px;" alt=""/><br /><sub><b>Sujeito Operator</b></sub></a><br /><a href="#code-sujeito-operator" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://www.blahs.life/"><img src="https://avatars.githubusercontent.com/u/620336?v=4" width="100px;" alt=""/><br /><sub><b>Dan Blah</b></sub></a><br /><a href="#bug-danblah" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/3choBoomer"><img src="https://avatars.githubusercontent.com/u/521828?v=4" width="100px;" alt=""/><br /><sub><b>Nathan Cooke</b></sub></a><br /><a href="#code-3choBoomer" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/white-hat"><img src="https://avatars.githubusercontent.com/u/922988?v=4" width="100px;" alt=""/><br /><sub><b>Eli Stark</b></sub></a><br /><a href="#code-white-hat" title="Code">💻</a> <a href="#bug-white-hat" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://marvinaziz.de/"><img src="https://avatars.githubusercontent.com/u/33159023?v=4" width="100px;" alt=""/><br /><sub><b>Marvin Aziz</b></sub></a><br /><a href="#code-marvtub" title="Code">💻</a> <a href="#bug-marvtub" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mjfaga"><img src="https://avatars.githubusercontent.com/u/7584015?v=4" width="100px;" alt=""/><br /><sub><b>Mark</b></sub></a><br /><a href="#code-mjfaga" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://aeturnal.io/"><img src="https://avatars.githubusercontent.com/u/219271200?v=4" width="100px;" alt=""/><br /><sub><b>aeturnal</b></sub></a><br /><a href="#code-aeturnal" title="Code">💻</a> <a href="#bug-aeturnal" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/floatGray"><img src="https://avatars.githubusercontent.com/u/44295302?v=4" width="100px;" alt=""/><br /><sub><b>floatGray</b></sub></a><br /><a href="#code-floatGray" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/thomasfsteeples"><img src="https://avatars.githubusercontent.com/u/32720359?v=4" width="100px;" alt=""/><br /><sub><b>Thomas F Steeples</b></sub></a><br /><a href="#code-thomasfsteeples" title="Code">💻</a> <a href="#bug-thomasfsteeples" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/amasen02"><img src="https://avatars.githubusercontent.com/amasen02?v=4" width="100px;" alt=""/><br /><sub><b>Ama Senevirathne</b></sub></a><br /><a href="#code-amasen02" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/AcademyKUB8"><img src="https://avatars.githubusercontent.com/AcademyKUB8?v=4" width="100px;" alt=""/><br /><sub><b>AcademyKUB8</b></sub></a><br /><a href="#code-AcademyKUB8" title="Code">💻</a> <a href="#bug-AcademyKUB8" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/soulocker"><img src="https://avatars.githubusercontent.com/u/9692331?v=4" width="100px;" alt=""/><br /><sub><b>soulocker</b></sub></a><br /><a href="#bug-soulocker" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/sonic182"><img src="https://avatars.githubusercontent.com/u/4070466?v=4" width="100px;" alt=""/><br /><sub><b>Johanderson Mogollon</b></sub></a><br /><a href="#ideas-sonic182" title="Ideas & Planning">🤔</a> <a href="#bug-sonic182" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/kurihada"><img src="https://avatars.githubusercontent.com/u/63988604?v=4" width="100px;" alt=""/><br /><sub><b>kurihada</b></sub></a><br /><a href="#bug-kurihada" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Giraffe224"><img src="https://avatars.githubusercontent.com/u/193071526?v=4" width="100px;" alt=""/><br /><sub><b>Giraffe224</b></sub></a><br /><a href="#bug-Giraffe224" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://www.crshman.com"><img src="https://avatars.githubusercontent.com/u/39948?v=4" width="100px;" alt=""/><br /><sub><b>Robert Navarro</b></sub></a><br /><a href="#bug-rnavarro" title="Bug reports">🐛</a> <a href="#code-rnavarro" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/kapkema"><img src="https://avatars.githubusercontent.com/u/774573?v=4" width="100px;" alt=""/><br /><sub><b>Marc</b></sub></a><br /><a href="#bug-kapkema" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://javymarmol.com"><img src="https://avatars.githubusercontent.com/u/3501269?v=4" width="100px;" alt=""/><br /><sub><b>Heyner Javier Marmol Verbel</b></sub></a><br /><a href="#bug-javymarmol" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Stijnus"><img src="https://avatars.githubusercontent.com/u/72551117?v=4" width="100px;" alt=""/><br /><sub><b>Stijnus</b></sub></a><br /><a href="#bug-Stijnus" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Macrox"><img src="https://avatars.githubusercontent.com/u/571851?v=4" width="100px;" alt=""/><br /><sub><b>macroxing</b></sub></a><br /><a href="#bug-Macrox" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jwtracy"><img src="https://avatars.githubusercontent.com/u/58991818?v=4" width="100px;" alt=""/><br /><sub><b>John Tracy</b></sub></a><br /><a href="#code-jwtracy" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/woyxiang"><img src="https://avatars.githubusercontent.com/u/119841810?v=4" width="100px;" alt=""/><br /><sub><b>woyxiang</b></sub></a><br /><a href="#ideas-woyxiang" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Juncanthia"><img src="https://avatars.githubusercontent.com/u/17041926?v=4" width="100px;" alt=""/><br /><sub><b>Juncanthia</b></sub></a><br /><a href="#bug-Juncanthia" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/kevinkirkup"><img src="https://avatars.githubusercontent.com/u/38406?v=4" width="100px;" alt=""/><br /><sub><b>Kevin S Kirkup</b></sub></a><br /><a href="#bug-kevinkirkup" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/georgeharker"><img src="https://avatars.githubusercontent.com/u/2169888?v=4" width="100px;" alt=""/><br /><sub><b>George Harker</b></sub></a><br /><a href="#code-georgeharker" title="Code">💻</a> <a href="#bug-georgeharker" title="Bug reports">🐛</a> <a href="#ideas-georgeharker" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://zuey.me"><img src="https://avatars.githubusercontent.com/u/6857382?v=4" width="100px;" alt=""/><br /><sub><b>Duy /zuey/</b></sub></a><br /><a href="#ideas-mrgoonie" title="Ideas & Planning">🤔</a> <a href="#code-mrgoonie" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/luw2007"><img src="https://avatars.githubusercontent.com/u/1415541?v=4" width="100px;" alt=""/><br /><sub><b>luw2007</b></sub></a><br /><a href="#bug-luw2007" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/WrongWorry"><img src="https://avatars.githubusercontent.com/u/188037855?v=4" width="100px;" alt=""/><br /><sub><b>WrongWorry</b></sub></a><br /><a href="#bug-WrongWorry" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/nanaxx131-gif"><img src="https://avatars.githubusercontent.com/u/310295749?v=4" width="100px;" alt=""/><br /><sub><b>nanaxx131-gif</b></sub></a><br /><a href="#bug-nanaxx131-gif" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/CIECJS"><img src="https://avatars.githubusercontent.com/u/130489549?v=4" width="100px;" alt=""/><br /><sub><b>MateusCx</b></sub></a><br /><a href="#bug-CIECJS" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/HughZadora"><img src="https://avatars.githubusercontent.com/u/32498443?v=4" width="100px;" alt=""/><br /><sub><b>Hugh Zadora</b></sub></a><br /><a href="#bug-HughZadora" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/cxh0312"><img src="https://avatars.githubusercontent.com/u/10069427?v=4" width="100px;" alt=""/><br /><sub><b>撑伞的鱼</b></sub></a><br /><a href="#bug-cxh0312" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/LvGitHub-9"><img src="https://avatars.githubusercontent.com/u/69997168?v=4" width="100px;" alt=""/><br /><sub><b>Lv</b></sub></a><br /><a href="#bug-LvGitHub-9" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/apmcodes"><img src="https://avatars.githubusercontent.com/u/13360356?v=4" width="100px;" alt=""/><br /><sub><b>apmcodes</b></sub></a><br /><a href="#bug-apmcodes" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jondong"><img src="https://avatars.githubusercontent.com/u/700736?v=4" width="100px;" alt=""/><br /><sub><b>Jonathan Dong</b></sub></a><br /><a href="#bug-jondong" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/alchemistklk"><img src="https://avatars.githubusercontent.com/u/56862773?v=4" width="100px;" alt=""/><br /><sub><b>Caprika</b></sub></a><br /><a href="#bug-alchemistklk" title="Bug reports">🐛</a> <a href="#code-alchemistklk" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/dmontague-crwv"><img src="https://avatars.githubusercontent.com/u/289768493?v=4" width="100px;" alt=""/><br /><sub><b>dmontague-crwv</b></sub></a><br /><a href="#bug-dmontague-crwv" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/glyh"><img src="https://avatars.githubusercontent.com/u/12870742?v=4" width="100px;" alt=""/><br /><sub><b>Yihang "Corvo" Liu</b></sub></a><br /><a href="#bug-glyh" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/LucaBarrella"><img src="https://avatars.githubusercontent.com/u/109086416?v=4" width="100px;" alt=""/><br /><sub><b>Luca Barrella</b></sub></a><br /><a href="#code-LucaBarrella" title="Code">💻</a> <a href="#ideas-LucaBarrella" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Rianico"><img src="https://avatars.githubusercontent.com/u/32795735?v=4" width="100px;" alt=""/><br /><sub><b>xuankun zheng</b></sub></a><br /><a href="#code-Rianico" title="Code">💻</a> <a href="#bug-Rianico" title="Bug reports">🐛</a> <a href="#ideas-Rianico" title="Ideas & Planning">🤔</a> <a href="#doc-Rianico" title="Documentation">📖</a> <a href="https://github.com/apmantza/pi-lens/commits?author=Rianico" title="Tests">⚠️</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/drakeo338"><img src="https://avatars.githubusercontent.com/u/328244157?v=4" width="100px;" alt=""/><br /><sub><b>Younes Beriane</b></sub></a><br /><a href="#code-drakeo338" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/zjael"><img src="https://avatars.githubusercontent.com/u/13909277?v=4" width="100px;" alt=""/><br /><sub><b>Jakob Sjælland</b></sub></a><br /><a href="#bug-zjael" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/nzbrian"><img src="https://avatars.githubusercontent.com/u/15132755?v=4" width="100px;" alt=""/><br /><sub><b>Brian B</b></sub></a><br /><a href="#code-nzbrian" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/dearbld"><img src="https://avatars.githubusercontent.com/u/297515257?v=4" width="100px;" alt=""/><br /><sub><b>dearbld</b></sub></a><br /><a href="#code-dearbld" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/stekman08"><img src="https://avatars.githubusercontent.com/u/38240615?v=4" width="100px;" alt=""/><br /><sub><b>Fredrik Ekman</b></sub></a><br /><a href="#code-stekman08" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Pluto-Yt"><img src="https://avatars.githubusercontent.com/u/82994778?v=4" width="100px;" alt=""/><br /><sub><b>plutoYang</b></sub></a><br /><a href="#code-Pluto-Yt" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Flash-Z"><img src="https://avatars.githubusercontent.com/u/65103912?v=4" width="100px;" alt=""/><br /><sub><b>Flash-Z</b></sub></a><br /><a href="#bug-Flash-Z" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/fwhskr"><img src="https://avatars.githubusercontent.com/u/310062135?v=4" width="100px;" alt=""/><br /><sub><b>Kristjan</b></sub></a><br /><a href="#bug-fwhskr" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/raulriqueleme79-wq"><img src="https://avatars.githubusercontent.com/u/321362673?v=4" width="100px;" alt=""/><br /><sub><b>raulriqueleme79-wq</b></sub></a><br /><a href="#bug-raulriqueleme79-wq" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/existyay"><img src="https://avatars.githubusercontent.com/u/100055751?v=4" width="100px;" alt=""/><br /><sub><b>liujam</b></sub></a><br /><a href="#bug-existyay" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/usaturn"><img src="https://avatars.githubusercontent.com/u/1503215?v=4" width="100px;" alt=""/><br /><sub><b>Go.YAMADA</b></sub></a><br /><a href="#bug-usaturn" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/axe312ger"><img src="https://avatars.githubusercontent.com/u/1737026?v=4" width="100px;" alt=""/><br /><sub><b>Benedikt Rötsch</b></sub></a><br /><a href="#ideas-axe312ger" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Stark-X"><img src="https://avatars.githubusercontent.com/u/13653522?v=4" width="100px;" alt=""/><br /><sub><b>Stark-X</b></sub></a><br /><a href="#bug-Stark-X" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/raphaelbahat"><img src="https://avatars.githubusercontent.com/u/119133576?v=4" width="100px;" alt=""/><br /><sub><b>Yahav Bahat</b></sub></a><br /><a href="#bug-raphaelbahat" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/edwinsaavedran"><img src="https://avatars.githubusercontent.com/u/126927003?v=4" width="100px;" alt=""/><br /><sub><b>Edwin A. Saavedra Navarro</b></sub></a><br /><a href="#bug-edwinsaavedran" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/laurentftech"><img src="https://avatars.githubusercontent.com/u/44120190?v=4" width="100px;" alt=""/><br /><sub><b>Laurent</b></sub></a><br /><a href="#bug-laurentftech" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/CaptainVincent"><img src="https://avatars.githubusercontent.com/u/12159865?v=4" width="100px;" alt=""/><br /><sub><b>vincent</b></sub></a><br /><a href="#bug-CaptainVincent" title="Bug reports">🐛</a> <a href="#ideas-CaptainVincent" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/smoryan"><img src="https://avatars.githubusercontent.com/u/18289482?v=4" width="100px;" alt=""/><br /><sub><b>Linx</b></sub></a><br /><a href="#bug-smoryan" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/audigregorie"><img src="https://avatars.githubusercontent.com/u/122812915?v=4" width="100px;" alt=""/><br /><sub><b>Audi Young</b></sub></a><br /><a href="#bug-audigregorie" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/aspiers"><img src="https://avatars.githubusercontent.com/u/100738?v=4" width="100px;" alt=""/><br /><sub><b>Adam Spiers</b></sub></a><br /><a href="#bug-aspiers" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/oidualc"><img src="https://avatars.githubusercontent.com/u/6648988?v=4" width="100px;" alt=""/><br /><sub><b>Claudio Cocciarelli</b></sub></a><br /><a href="#ideas-oidualc" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/205Dev"><img src="https://avatars.githubusercontent.com/u/229137888?v=4" width="100px;" alt=""/><br /><sub><b>205 Dev</b></sub></a><br /><a href="#bug-205Dev" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/yceachan"><img src="https://avatars.githubusercontent.com/u/108170840?v=4" width="100px;" alt=""/><br /><sub><b>Ea Chan</b></sub></a><br /><a href="#bug-yceachan" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/xiaoming6969"><img src="https://avatars.githubusercontent.com/u/27881216?v=4" width="100px;" alt=""/><br /><sub><b>XiaoMing </b></sub></a><br /><a href="#bug-xiaoming6969" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jreeder"><img src="https://avatars.githubusercontent.com/u/264973?v=4" width="100px;" alt=""/><br /><sub><b>John Reeder</b></sub></a><br /><a href="#bug-jreeder" title="Bug reports">🐛</a> <a href="#ideas-jreeder" title="Ideas & Planning">🤔</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Po1ynomial"><img src="https://avatars.githubusercontent.com/u/165783849?v=4" width="100px;" alt=""/><br /><sub><b>Yejia Mo</b></sub></a><br /><a href="#ideas-Po1ynomial" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/bricabrol"><img src="https://avatars.githubusercontent.com/u/279064582?v=4" width="100px;" alt=""/><br /><sub><b>bricabrol</b></sub></a><br /><a href="#bug-bricabrol" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/0xkite"><img src="https://avatars.githubusercontent.com/u/96210987?v=4" width="100px;" alt=""/><br /><sub><b>0xkite</b></sub></a><br /><a href="#bug-0xkite" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/phionax"><img src="https://avatars.githubusercontent.com/u/15048251?v=4" width="100px;" alt=""/><br /><sub><b>Steve Lovelace</b></sub></a><br /><a href="#bug-phionax" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ravshansbox"><img src="https://avatars.githubusercontent.com/u/1499188?v=4" width="100px;" alt=""/><br /><sub><b>ravshansbox</b></sub></a><br /><a href="#bug-ravshansbox" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/misc4747"><img src="https://avatars.githubusercontent.com/u/33905096?v=4" width="100px;" alt=""/><br /><sub><b>misc4747</b></sub></a><br /><a href="#bug-misc4747" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jaudiger"><img src="https://avatars.githubusercontent.com/u/31616285?v=4" width="100px;" alt=""/><br /><sub><b>Jérémy Audiger</b></sub></a><br /><a href="#ideas-jaudiger" title="Ideas & Planning">🤔</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/snrogers"><img src="https://avatars.githubusercontent.com/u/7806061?v=4" width="100px;" alt=""/><br /><sub><b>Sebastian Rogers</b></sub></a><br /><a href="#bug-snrogers" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/pierre-mgmt"><img src="https://avatars.githubusercontent.com/u/244913946?v=4" width="100px;" alt=""/><br /><sub><b>Pierre</b></sub></a><br /><a href="#ideas-pierre-mgmt" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/douglasf"><img src="https://avatars.githubusercontent.com/u/845443?v=4" width="100px;" alt=""/><br /><sub><b>douglasf</b></sub></a><br /><a href="#bug-douglasf" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/danbka33"><img src="https://avatars.githubusercontent.com/u/1656453?v=4" width="100px;" alt=""/><br /><sub><b>Bolshakov Danila</b></sub></a><br /><a href="#ideas-danbka33" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/theverymrp"><img src="https://avatars.githubusercontent.com/u/28730110?v=4" width="100px;" alt=""/><br /><sub><b>theverymrp</b></sub></a><br /><a href="#bug-theverymrp" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/kaushal9696"><img src="https://avatars.githubusercontent.com/u/76026791?v=4" width="100px;" alt=""/><br /><sub><b>Kaushal Prajapati</b></sub></a><br /><a href="#bug-kaushal9696" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Yabuku-xD"><img src="https://avatars.githubusercontent.com/u/78594762?v=4" width="100px;" alt=""/><br /><sub><b>Shyamalan Kannan</b></sub></a><br /><a href="#ideas-Yabuku-xD" title="Ideas & Planning">🤔</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/neilwashere"><img src="https://avatars.githubusercontent.com/u/12393193?v=4" width="100px;" alt=""/><br /><sub><b>Neil Chambers</b></sub></a><br /><a href="#bug-neilwashere" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/denisdasilvarocha"><img src="https://avatars.githubusercontent.com/u/92863811?v=4" width="100px;" alt=""/><br /><sub><b>Denis Da Silva Rocha</b></sub></a><br /><a href="#ideas-denisdasilvarocha" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/unprofessor"><img src="https://avatars.githubusercontent.com/u/4581119?v=4" width="100px;" alt=""/><br /><sub><b>David Brenton Allen</b></sub></a><br /><a href="#bug-unprofessor" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/andersea"><img src="https://avatars.githubusercontent.com/u/10992982?v=4" width="100px;" alt=""/><br /><sub><b>Anders E. Andersen</b></sub></a><br /><a href="#bug-andersea" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/vedmaka"><img src="https://avatars.githubusercontent.com/u/592009?v=4" width="100px;" alt=""/><br /><sub><b>Vedmaka</b></sub></a><br /><a href="#bug-vedmaka" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/sith-samin"><img src="https://avatars.githubusercontent.com/u/174289293?v=4" width="100px;" alt=""/><br /><sub><b>sith007</b></sub></a><br /><a href="#bug-sith-samin" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/punk-dev-robot"><img src="https://avatars.githubusercontent.com/u/3915056?v=4" width="100px;" alt=""/><br /><sub><b>Punk Dev Robot</b></sub></a><br /><a href="#bug-punk-dev-robot" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/StativBus"><img src="https://avatars.githubusercontent.com/u/109903597?v=4" width="100px;" alt=""/><br /><sub><b>StativBus</b></sub></a><br /><a href="#ideas-StativBus" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/maxdswain"><img src="https://avatars.githubusercontent.com/u/89113255?v=4" width="100px;" alt=""/><br /><sub><b>Max Swain</b></sub></a><br /><a href="#ideas-maxdswain" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/DrunkenDonkey80"><img src="https://avatars.githubusercontent.com/u/92183746?v=4" width="100px;" alt=""/><br /><sub><b>DrunkenDonkey80</b></sub></a><br /><a href="#bug-DrunkenDonkey80" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/marioSoftmedic"><img src="https://avatars.githubusercontent.com/u/44755030?v=4" width="100px;" alt=""/><br /><sub><b>marioHealthSoft</b></sub></a><br /><a href="#ideas-marioSoftmedic" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/OrestesK"><img src="https://avatars.githubusercontent.com/u/56927612?v=4" width="100px;" alt=""/><br /><sub><b>Orestes Kassian</b></sub></a><br /><a href="#ideas-OrestesK" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/vanyastaff"><img src="https://avatars.githubusercontent.com/u/24690216?v=4" width="100px;" alt=""/><br /><sub><b>vanyastaff</b></sub></a><br /><a href="#bug-vanyastaff" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/EightDoor"><img src="https://avatars.githubusercontent.com/u/35022264?v=4" width="100px;" alt=""/><br /><sub><b>周凯</b></sub></a><br /><a href="#code-EightDoor" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/pikachu01"><img src="https://avatars.githubusercontent.com/u/1090194?v=4" width="100px;" alt=""/><br /><sub><b>pikachu01</b></sub></a><br /><a href="#ideas-pikachu01" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/igorggor"><img src="https://avatars.githubusercontent.com/u/236343180?v=4" width="100px;" alt=""/><br /><sub><b>Igor G. Gor</b></sub></a><br /><a href="#bug-igorggor" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/dampent"><img src="https://avatars.githubusercontent.com/u/32382169?v=4" width="100px;" alt=""/><br /><sub><b>dampent</b></sub></a><br /><a href="#bug-dampent" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/arbelafor"><img src="https://avatars.githubusercontent.com/u/288174596?v=4" width="100px;" alt=""/><br /><sub><b>arbelafor</b></sub></a><br /><a href="#bug-arbelafor" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/qiyangfan"><img src="https://avatars.githubusercontent.com/u/102476247?v=4" width="100px;" alt=""/><br /><sub><b>yangfan qi</b></sub></a><br /><a href="#ideas-qiyangfan" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/IGabrielRC"><img src="https://avatars.githubusercontent.com/u/99936003?v=4" width="100px;" alt=""/><br /><sub><b>IGabrielRC</b></sub></a><br /><a href="#bug-IGabrielRC" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Antrakos"><img src="https://avatars.githubusercontent.com/u/13787714?v=4" width="100px;" alt=""/><br /><sub><b>Taras Zubrei</b></sub></a><br /><a href="#ideas-Antrakos" title="Ideas & Planning">🤔</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/pandas9"><img src="https://avatars.githubusercontent.com/u/81386636?v=4" width="100px;" alt=""/><br /><sub><b>pandas9</b></sub></a><br /><a href="#bug-pandas9" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/renzooliveira"><img src="https://avatars.githubusercontent.com/u/10881850?v=4" width="100px;" alt=""/><br /><sub><b>Renzo Oliveira</b></sub></a><br /><a href="#ideas-renzooliveira" title="Ideas & Planning">🤔</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->
