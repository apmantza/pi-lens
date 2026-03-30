# LSP Configuration Guide

pi-lens supports **31 built-in LSP servers** covering most popular languages. If you need additional servers or want to customize existing ones, you can define them via configuration.

## Quick Start

Create `.pi-lens/lsp.json` in your project root:

```json
{
  "servers": {
    "graphql": {
      "name": "GraphQL Language Server",
      "extensions": [".graphql", ".gql"],
      "command": "graphql-lsp",
      "args": ["server", "--method=stream"]
    }
  }
}
```

## Configuration File

pi-lens looks for config in these locations (first found wins):

1. `.pi-lens/lsp.json`
2. `.pi-lens.json`  
3. `pi-lsp.json`

## Server Definition

Each server requires:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name |
| `extensions` | string[] | File extensions (e.g., [".rs"]) |
| `command` | string | Executable name or path |
| `args` | string[] | Command arguments (optional) |
| `rootMarkers` | string[] | Files that indicate project root (optional) |
| `env` | object | Environment variables (optional) |

## Examples

### GraphQL

```json
{
  "servers": {
    "graphql": {
      "name": "GraphQL Language Server",
      "extensions": [".graphql", ".gql"],
      "command": "graphql-lsp",
      "args": ["server", "--method=stream"]
    }
  }
}
```

Install first: `npm i -g @graphql-codegen/cli graphql-language-service-cli`

### Scala (Metals)

```json
{
  "servers": {
    "scala": {
      "name": "Metals",
      "extensions": [".scala", ".sc"],
      "command": "metals",
      "args": ["-Dmetals.http=false"],
      "rootMarkers": ["build.sbt", ".scala-build"]
    }
  }
}
```

Install first: `cs install metals`

### R Language Server

```json
{
  "servers": {
    "r": {
      "name": "R Language Server",
      "extensions": [".r", ".R"],
      "command": "R",
      "args": ["--slave", "-e", "languageserver::run()"]
    }
  }
}
```

Install first: `R -e "install.packages('languageserver')"`

### Astro

```json
{
  "servers": {
    "astro": {
      "name": "Astro Language Server",
      "extensions": [".astro"],
      "command": "astro-ls",
      "args": ["--stdio"]
    }
  }
}
```

Install first: `npm i -g @astrojs/language-server`

## Disabling Built-in Servers

To disable a built-in server (e.g., if you prefer a different one):

```json
{
  "disabledServers": ["typescript", "eslint"]
}
```

## Environment Variables

Set custom environment for a server:

```json
{
  "servers": {
    "python": {
      "name": "Pyright with venv",
      "extensions": [".py"],
      "command": "pyright-langserver",
      "args": ["--stdio"],
      "env": {
        "PYTHONPATH": "/path/to/my/venv/lib/python3.11/site-packages"
      }
    }
  }
}
```

## Complete Example

```json
{
  "servers": {
    "graphql": {
      "name": "GraphQL Language Server",
      "extensions": [".graphql", ".gql"],
      "command": "graphql-lsp",
      "args": ["server", "--method=stream"],
      "rootMarkers": [".graphqlconfig", "codegen.yml"]
    },
    "toml": {
      "name": "Taplo (TOML)",
      "extensions": [".toml"],
      "command": "taplo",
      "args": ["lsp", "stdio"]
    }
  },
  "disabledServers": ["eslint"]
}
```

## Auto-Installation

For the **31 built-in servers**, pi-lens can auto-install via npm/pip when `--lens-lsp` is enabled:

- TypeScript: `typescript-language-server`
- Python: `pyright`
- Vue: `@vue/language-server`
- Svelte: `svelte-language-server`
- And more...

**Custom servers** must be installed manually before use.

## Troubleshooting

### Server not found

Check that the command is in your PATH:
```bash
which graphql-lsp
# or
graphql-lsp --version
```

### LSP not starting

Enable debug mode to see errors:
```bash
pi --lens-lsp --lens-verbose
```

### Root detection failing

Add appropriate `rootMarkers` for your project structure:
```json
{
  "rootMarkers": ["package.json", ".git", "my-project.config.js"]
}
```

## Built-in Servers (31 Total)

| Language | Server |
|----------|--------|
| TypeScript/JavaScript | typescript-language-server |
| Python | pyright |
| Go | gopls |
| Rust | rust-analyzer |
| Ruby | ruby-lsp |
| PHP | intelephense |
| C# | csharp-ls |
| F# | fsautocomplete |
| Java | JDTLS |
| Kotlin | kotlin-language-server |
| Swift | sourcekit-lsp |
| Dart | dart |
| Lua | lua-language-server |
| C/C++ | clangd |
| Zig | zls |
| Haskell | haskell-language-server |
| Elixir | elixir-ls |
| Gleam | gleam |
| OCaml | ocamllsp |
| Clojure | clojure-lsp |
| Terraform | terraform-ls |
| Nix | nixd |
| Bash | bash-language-server |
| Docker | dockerfile-language-server |
| YAML | yaml-language-server |
| JSON | vscode-json-languageserver |
| Prisma | @prisma/language-server |
| **Vue** | @vue/language-server |
| **Svelte** | svelte-language-server |
| **ESLint** | vscode-eslint |
| **CSS/SCSS** | vscode-css-languageserver |
