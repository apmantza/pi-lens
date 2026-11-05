<important if="touching language and configuration rules">

### Language and configuration

- `clients/language-registry.ts` is the identity source for language ids,
  extensions, filenames, file kinds, LSP ids, and grammars. Consumers project
  from it; they do not maintain parallel language tables. Known unfolded
  sibling: `getExtensionsForLanguage` in `clients/tree-sitter-client.ts`, the
  structural-search walk's hand-kept extension map (14 rows, Groovy included
  per #5235). It is not pinned to the registry: ten rows match
  `extensionsForLanguage` and four do not (`cpp` lists 4 of the registry's 22
  extensions, `python` omits `.pyi`, `ruby` omits `.rake`, `.gemspec` and
  `.ru`, and `tsx` is a grammar name the registry does not know). Folding it
  onto `extensionsForLanguage` changes output for those four, so it is its own
  slice.
- Agent-facing advisory text resolves names through `resolveLensToolName` with
  the delivery host: pi uses `piName`, and MCP uses `mcpName` from
  `TOOL_REGISTRY`. Known tools without a host mapping resolve to `undefined`,
  so callers omit or rephrase them; pi-only rows require
  `PI_ONLY_TOOL_REASONS`. Do not add a second name map or hard-code a pi tool
  name in advisory output (#2535).
- `clients/config-core/` owns schema validation, normalization, merging,
  provenance, deny precedence, merge strategies, trust-gated process specs,
  and bounded migration records. Existing LSP, global, and project loaders
  adopt it without adding another merge implementation.
- Canonical config is `.pi-lens.json` plus `~/.pi-lens/config.json`; locations,
  legacy migrations, and namespaces live in the config-location/schema modules.
  A new config key or environment flag needs a forcing function, stability tier,
  diagnostic code, tests, and docs.
- `rules.<id>.ignorePaths` is an experimental path denial resolved by
  config-core with array-union semantics: global entries cannot be cleared by
  project config. Each entry is a gitignore line, matched as the `ignore` field
  matches (#783: last match wins, `!` re-includes, a leading `/` roots it, a
  trailing `/` is directory-only) through `isIgnoredByGitignoreLines`
  (`clients/file-utils.ts`), relative to the directory of the file that
  declares it (the project root for a global entry). Each file is its own
  scope and a path is carved out when any scope ignores it, so a `!` never
  lifts another file's carve-out. A rule's own YAML `ignores:` stays on the
  ast-grep glob matcher (`isRuleIgnoredForPath`), which mirrors
  `ast-grep scan`. Ast-grep and tree-sitter apply `ignorePaths` before
  scanning; other runner output uses the shared rule-policy filter.
- `rules` and `dispatch.disabledRunners` are read per file from its config
  owner (`resolveDispatchPolicyConfigForFile`, `loadProjectRulePolicy`), so a
  nested `.pi-lens.json` governs its own files on every surface.
- `lens_diagnostics` has one model-facing diagnostic surface. `source` is
  `session` or `lsp`; `scope` is `paths` or `workspace`; explicit paths always
  win. Severity is a threshold. Retired compatibility names must not widen a
  request into a workspace sweep.

</important>
