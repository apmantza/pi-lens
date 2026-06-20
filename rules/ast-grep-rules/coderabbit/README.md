# CodeRabbit ast-grep essentials

Vendored from https://github.com/coderabbitai/ast-grep-essentials at commit `73120109bf45c284d0cd8a37bdd7082e80e92e87`.

License: Apache-2.0 (see ./LICENSE).

The rules are included in pi-lens's synthesized baseline `sgconfig` when a target repository does not provide its own `sgconfig.yml` / `sgconfig.yaml`. If a repository supplies its own sgconfig, pi-lens respects that project config instead.

Compatibility note: ast-grep rejects utility ids containing reserved characters. Some upstream utility names include characters such as parentheses, dots, commas, and spaces. During vendoring, those utility ids were normalized to ast-grep-safe identifiers and matching `matches:` references were rewritten. Rule ids, languages, messages, notes, and severities are preserved.
