---
section: Fixed
---

- **Biome lint and autofix no longer produce import-type rewrites for projects without a Biome config (refs #2385)** — the bundled fallback `config/biome/core.jsonc` now disables `useImportType` on both surfaces, which share one config seam (`biomeConfigArgs`): the lint surface loses this one advisory, and the autofix pass (`biome lint --write`) stops rewriting value imports. The rule's safe fix turns an import used only in type positions into `import type`, which erases the runtime binding that experimental decorator metadata still needs: with `emitDecoratorMetadata`, the emitted `design:type` stops referencing the imported class (verified with real Biome 2.5.9 and tsc, it becomes `Function`), breaking decorator-based dependency injection at runtime. Every other recommended rule stays on. An explicit project `biome.json(c)` remains authoritative: if you enable `useImportType` there, pi-lens never overrides it.
