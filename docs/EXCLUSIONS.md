# File Exclusions

pi-lens automatically excludes certain files from analysis to reduce noise.

## Test Files

All runners respect test file exclusions.

**Excluded patterns:**
```
**/*.test.ts      **/*.test.tsx      **/*.test.js      **/*.test.jsx
**/*.spec.ts      **/*.spec.tsx      **/*.spec.js      **/*.spec.jsx
**/*.poc.test.ts  **/*.poc.test.tsx
**/test-utils.ts  **/test-*.ts
**/__tests__/**  **/tests/**  **/test/**
```

**Why:** Test files intentionally duplicate patterns and have different complexity standards.

## Build Artifacts

In TypeScript projects (detected by `tsconfig.json`), compiled `.js` files are excluded:

```
**/*.js   **/*.jsx   (when corresponding .ts/.tsx exists)
```

**Why:** Analyzing build artifacts duplicates every issue.

**Note:** In pure JavaScript projects (no `tsconfig.json`), `.js` files are **included** as source files.

## Excluded Directories

| Directory | Reason |
|-----------|--------|
| `node_modules/` | Third-party dependencies |
| `.git/` | Version control metadata |
| `dist/`, `build/` | Build outputs |
| `.pi-lens/`, `.pi/` | pi agent internal files |
| `.next/`, `.ruff_cache/` | Framework/build caches |
| `coverage/` | Test coverage reports |

## Per-Runner Summary

| Runner | Test Files | Build Artifacts | Directories |
|--------|-----------|-----------------|-------------|
| **dispatch runners** | ✅ `skipTestFiles` | ✅ `.js` excluded in TS | ✅ `EXCLUDED_DIRS` |
| **booboo /lens-booboo** | ✅ `shouldIncludeFile()` | ✅ `isTsProject` check | ✅ `EXCLUDED_DIRS` |
| **Secrets scan** | ❌ No exclusion (security) | ❌ No exclusion | ✅ Dirs excluded |

Secrets scanning excludes nothing — security takes precedence over noise reduction.
