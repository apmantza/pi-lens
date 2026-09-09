## Summary

Refs #2800. Add a real-registration roster pin for the pi extension and MCP
`tools/list`. The pin reports description and parameter-schema bytes separately
per tool and rejects growth above a measured budget.

## Tests

- `tests/config/tool-roster-budget.test.ts`: pin both real registration paths,
  with per-tool description/schema rows and surface totals.
- Red-first budget probe: set each budget one byte below the current total; both
  surfaces red and quote every measured tool row in the failure.
- Mutation probe: add one extra fat registered description; the corresponding
  surface exceeds its budget and reds with the quoted roster.

### Current roster measurement — 2026-09-10

| surface | description bytes | schema bytes | total |
|---|---:|---:|---:|
| pi extension | 3,788 | 22,160 | 25,948 |
| MCP `tools/list` | 6,198 | 20,969 | 27,167 |

Per-tool rows are emitted by the test failure report and are recorded in the
baseline JSON. The current pin budget equals each measured current total until
the trim lands.

## Blast radius

Test-only; no production callers, callbacks, or entry points change. The test
drives `index.ts` through `pi.registerTool` and `mcp/server.ts` through the real
stdio `tools/list` path.

## Observability

The failure report is the bounded governance record: it names the surface,
totals, budget, and every tool's description/schema bytes.

## Class sweep

The roster population is the complete set returned by both registration paths.
The pin remains distributed because pi and MCP have different host seams, while
one test measures both through their real adapters.

## Test assessment

`tests/config/tool-roster-budget.test.ts` uniquely pins byte growth on both
surfaces. The existing baseline file supplies the measured contract; no test is
redundant.
