## Summary

The archived round-3 state-space tables are reconstructed here.

## Tests

| Dimension | Same scope | Before declaration | Nested |
| --- | --- | --- | --- |
| Block shadow | `B01` | `B03` | `B05` |
| Destructuring | `B29` | `B31` | `B32` |
| Parameter default | `B21` | `B23` | `B24` |

| Probe | Runner |
| --- | --- |
| `P01` | ruff |
| `P30` | test-runner |

## Blast radius

The sweep is test-only.

## Class sweep

The table covers every binding and runner dimension.

## Observability

No new failure path; no record added.
