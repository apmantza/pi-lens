# Dependencies and Auto-install Policy

Auto-install behavior depends on gate type:

- **Config-gated**: installs only when project config/deps indicate usage
- **Flow/language-gated**: installs when the runtime path needs it for the current file/session flow
- **Operational prewarm**: installs during session warm scans / turn-end analysis paths
- **GitHub release**: platform-specific binary downloaded from GitHub releases to `~/.pi-lens/bin/`

| Tool                                | Purpose                          | Auto-installed | Gate                               |
| ----------------------------------- | -------------------------------- | -------------- | ---------------------------------- |
| `@biomejs/biome`                    | JS/TS lint/format/autofix        | Yes            | Config-gated                       |
| `prettier`                          | Formatting fallback              | Yes            | Config-gated                       |
| `yamllint`                          | YAML linting                     | Yes            | Config-gated                       |
| `actionlint`                        | GitHub Actions workflow linting  | Yes            | GitHub release                     |
| `sqlfluff`                          | SQL linting/formatting           | Yes            | Config-gated                       |
| `ruff`                              | Python lint/format/autofix       | Yes            | Language-default + flow-gated      |
| `typescript-language-server`        | Unified LSP diagnostics          | Yes            | Language-default                   |
| `typescript`                        | TypeScript compiler              | Yes            | Language-default                   |
| `pyright`                           | Python type diagnostics fallback | Yes            | Flow/language-gated                |
| `@ast-grep/cli` (sg)                | AST scans/search/replace         | Yes            | Operational prewarm                |
| `knip`                              | Dead code analysis               | Yes            | Operational prewarm + config-gated |
| `jscpd`                             | Duplicate code detection         | Yes            | Operational prewarm + config-gated |
| `madge`                             | Circular dependency analysis     | Yes            | Turn-end analysis flow             |
| `mypy`                              | Python type checking             | Yes            | Flow-gated                         |
| `stylelint`                         | CSS/SCSS/Less linting            | Yes            | Config-gated                       |
| `markdownlint-cli2`                 | Markdown linting                 | Yes            | Config-gated                       |
| `shellcheck`                        | Shell script linting             | Yes            | GitHub release                     |
| `shfmt`                             | Shell script formatting          | Yes            | GitHub release                     |
| `rust-analyzer`                     | Rust LSP                         | Yes            | GitHub release                     |
| `golangci-lint`                     | Go linting                       | Yes            | GitHub release                     |
| `hadolint`                          | Dockerfile linting               | Yes            | GitHub release                     |
| `ktlint`                            | Kotlin linting                   | Yes            | GitHub release                     |
| `tflint`                            | Terraform linting                | Yes            | GitHub release                     |
| `taplo`                             | TOML linting/formatting          | Yes            | GitHub release                     |
| `terraform-ls`                      | Terraform LSP                    | Yes            | GitHub release                     |
| `htmlhint`                          | HTML linting                     | Yes            | Config-gated                       |
| `@prisma/language-server`           | Prisma LSP                       | Yes            | Flow-gated                         |
| `dockerfile-language-server-nodejs` | Dockerfile LSP                   | Yes            | Flow-gated                         |
| `intelephense`                      | PHP LSP                          | Yes            | Flow-gated                         |
| `bash-language-server`              | Bash LSP                         | Yes            | Language-default                   |
| `yaml-language-server`              | YAML LSP                         | Yes            | Language-default                   |
| `vscode-json-language-server`       | JSON LSP (`vscode-langservers-extracted`) | Yes  | Language-default                   |
| `vscode-css-languageserver`         | CSS LSP (`vscode-langservers-extracted`)  | Yes  | Language-default                   |
| `vscode-html-languageserver-bin`    | HTML LSP (`vscode-langservers-extracted`) | Yes  | Language-default                   |
| `svelte-language-server`            | Svelte LSP                       | Yes            | Flow-gated                         |
| `@vue/language-server`              | Vue LSP                          | Yes            | Flow-gated                         |
| `opengrep`                          | Experimental security dispatch   | Auto-install   | Local config / explicit opt-in     |
| `gitleaks`                          | Committed-secret session scan    | Auto-install   | Opt-in (config / hook / dep)       |
| `govulncheck`                       | Go reachable-CVE session scan    | `go install`   | Auto (`go.mod` present)            |
| `trivy`                             | Dependency-CVE session scan      | Auto-install   | Explicit opt-in (`trivy.enabled`)  |
| `psscriptanalyzer`                  | PowerShell linting               | Manual         | —                                  |

Additional language servers (gopls, ruby-lsp, solargraph, etc.) are auto-detected from PATH or installed via native package managers (`go install`, `gem install`) when their language is detected.
