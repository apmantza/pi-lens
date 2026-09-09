# `lsp-service-double-sweep` red-proof fixtures (#2582)

Real files, scanned from disk by `tests/config/lsp-service-double-sweep.test.ts`.
Each `shape-*.ts` is one evasion the round-1 regex (`touchFile: vi.fn(`) could
not see; each `compliant-*.ts` is a shape the sweep must NOT flag. They are
never imported or executed — `tsconfig.json` and `vitest.config.ts` both
exclude `tests/fixtures`.

A concatenated string built inside the sweep would prove only that the sweep
agrees with itself; these go through the same `listSourceFiles` + read + parse
path as the population walk.
