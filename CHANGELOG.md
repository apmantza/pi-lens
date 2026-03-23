# Changelog

All notable changes to pi-lens will be documented in this file.

## [1.4.0] - 2026-03-23

### Added
- **Design smell rules**: New `long-method`, `long-parameter-list`, and `large-class` rules for structural quality checks.
- **`/design-review` command**: Analyze files for design smells. Usage: `/design-review [path]`

### Changed
- **Improved ast-grep tool descriptions**: Better pattern guidance to prevent overly broad searches.

## [1.3.0] - 2026-03-23

### Changed
- **Biome auto-fix disabled by default**: Biome still provides linting feedback, but no longer auto-fixes on write. Use `/format` to apply fixes or enable with `--autofix-biome`.

### Added
- **ast-grep search/replace tools**: New `ast_grep_search` and `ast_grep_replace` tools for AST-aware code pattern matching. Supports meta-variables and 24 languages.
- **Rule descriptions in diagnostics**: ast-grep violations now include the rule's message and note, making feedback more actionable for the agent.

### Changed
- **Reduced console noise**: Extension no longer prints to console by default. Enable with `--lens-verbose`.

## [1.2.0] - 2026-03-23

### Added
- GitHub repository link in npm package

## [1.1.2] - Previous

- See git history for earlier releases
