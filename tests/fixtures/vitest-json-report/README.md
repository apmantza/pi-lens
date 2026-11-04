# vitest JSON report fixtures (#5257)

Captured from real `vitest run <file> --reporter=json --passWithNoTests` runs
on 2026-11-04 (node 22.22.1), one throwaway project per version. Paths were
rewritten to `/project` and `file:///deps/`; nothing else was edited.

- `vitest-5.0.5/*.json`: the file vitest 5 writes for `--outputFile=<path>`.
  Without `--outputFile` vitest 5 writes `.vitest/json/output.json` and prints
  only `JSON report written to <path>` on stdout, so stdout carries no report.
  Sources: `fail` (one failing and one passing test), `pass`, `empty` (no
  tests), `skipped` (`it.skip` only), `import-error` (suite fails to load).
- `vitest-3.2.7/*.stdout.json`: the same command's stdout on vitest 3.2.7,
  which prints the report to stdout. vitest 3.2.7 also honours `--outputFile`.
  vitest 4 was not available on the capture host (no install allowed in the
  lane); `tests/clients/test-runner-client.test.ts` pins hand-shaped 4.1.10
  payloads from #1452.
