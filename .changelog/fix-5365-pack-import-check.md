---
section: Added
audience: internal
---

- One generic packaging gate now reads the published file list: `packedImportResolutionViolations` (`scripts/lib/packed-layout.mjs`) checks every relative `import`, dynamic `import()` and `require` in each packed `.js`/`.mjs`/`.cjs` file against that same list, and `tests/packaging-pack-manifest.test.ts` runs it over the real `npm pack` tarball. A published script that imports a file `files[]` omits fails in the Unit tests shards instead of CI's install leg, so the per-file pins it subsumes (#1926, #2626, #3409, #4314, #4789) are deleted. (refs #5365)
