# AGENTS.md - Project-specific context for pi agents

## Build & Test

- `npm run build` — compile TypeScript (`tsc`)
- `npm test` — run tests (`vitest run`)
- **After every edit to `.ts` files, run `npm run build`.** Pi loads `.js` at runtime, not `.ts` directly. The `.js` files are gitignored build artifacts.

## Project Structure

This is a **pi extension**. Entry point: `index.ts`

- `index.ts` — main extension hook (tool_result handler, session_start, flags)
- `clients/` — lint tool wrappers, utilities, pipeline orchestration
- `clients/pipeline.ts` — post-write pipeline (format → fix → lint → test)
- `clients/dispatch/` — lint dispatcher and runners
- `clients/lsp/` — LSP server management
- `commands/` — slash commands (`/lens-booboo`, `/lens-booboo-fix`, `/lens-booboo-refactor`)
- `rules/ast-grep-rules/` — AST structural lint rules

## Knip False Positives

Knip reports all `.ts` files as `[file]` (unused files) because it doesn't
understand that pi loads `index.ts` directly at runtime — not via npm scripts.
**This is a false positive for pi extensions.**

When running `/lens-booboo-fix`:
- **IGNORE** all `[file]` type issues from Knip
- Only act on `[export]`, `[dependency]`, `[devDependency]` issues

Do NOT delete or restructure source files that Knip reports as unused — they ARE used.

## Code Style

- ESM (`"type": "module"` in package.json)
- Strict TypeScript (ES2020 target, bundler module resolution)
- Imports use `.js` extensions (e.g., `import { foo } from "./bar.js"`)

## Debug Logging

Set `PI_LENS_DEBUG=1` to see detailed auto-install logs:

```bash
PI_LENS_DEBUG=1 pi
```

Without the debug flag, you'll see:
- Tool installation progress
- Errors (with message, not full stack traces)

With the debug flag, you'll also see:
- Binary verification details
- Full error stacks
- Internal operation details
