---
section: Added
---

- **Dogfood knip on pi-lens's own source (closes #2698)** — `knip.jsonc` now resolves the compiled-sibling layout (`clients/*.js` sitting gitignored beside `clients/*.ts` after `npm run build`) that previously made knip report 491 source files "unused"; `npm run knip` (advisory in `lint.yml`, `continue-on-error`) purges those build artifacts before every run, declares the real `mcp/`/`scripts/` entry points, and documents each dependency/binary/file exemption it needed (husky, `@biomejs/biome`, `typescript-language-server`, `markdownlint-cli2`, two parked/dynamically-loaded files) with the reason knip can't see the usage on its own.
