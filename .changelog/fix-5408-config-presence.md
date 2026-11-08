---
section: Fixed
audience: user
area: runners
---

- **Config-gated linters now agree on whether your project has config.** The detekt runner now finds a config at the repo root from a Gradle module, and tflint receives a `.tflint.hcl` that sits in your home directory. Black and ruff config is read from real TOML tables and requirement names, so a commented `[tool.ruff]` or a `flake8-black` entry no longer counts. The `effective_config` tool reports `no-project-config` for a linter that would skip, and the SQL lint policy no longer claims it needs config. (refs #5408)
