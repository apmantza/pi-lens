# Diagnostic Dispositions (Triage)

pi-lens diagnostics can be *triaged* instead of just read: the agent (and, in a
future release, the user via a review window — #690) can mark any finding as a
false positive, suppress it, defer it, or flag it for a fix. Marks are recorded
once, in one store, and honored by every surface that renders diagnostics — the
per-edit feedback, `lens_diagnostics` (all modes), and the widget counts.

## The tool

`lens_diagnostic_mark` is a *situational* tool (activated on demand via
`pi_lens_activate_tools` on hosts with dynamic tool loading; statically active
elsewhere). Arguments:

- `filePath` — the file the diagnostic is in
- `line` — the flagged line
- `message` — the diagnostic message (used for anchoring; a distinctive prefix
  is enough)
- `disposition` — one of `false-positive` | `suppress` | `defer` | `flagged`
- `rule` — the rule/check id exactly as shown (e.g. `no-floating-promises`,
  an LSP code); optional, but required for `suppress` (it names the rule in
  the written comment)
- `tool` — the producing tool, if known (optional)
- `reason` — optional short reason, kept alongside the disposition and logged
  for rule-tuning telemetry

## The four dispositions

| Disposition | Meaning | Lifetime | Mechanism |
|---|---|---|---|
| `false-positive` | the rule misfired here | project-persistent | store entry, **strict** anchor |
| `suppress` | real finding, deliberate policy not to fix | project-persistent, git-visible | inline `pi-lens-ignore` comment written into the source + store mirror |
| `defer` | not now, maybe later | **session-only** (in-memory) | resurfaces next session |
| `flagged` | should be fixed | persistent until the fix is observed | store entry; rendered as `📌 flagged-to-fix` in `lens_diagnostics` with the stored fix context (line, line text, reason) |

There is deliberately **no manual "fixed"** disposition: a fix is *observed*
(the finding disappears from a fresh scan), never asserted — otherwise an agent
could self-report a fix that didn't land.

## Anchor strength (what survives edits)

Marks are content-anchored to the *finding*, not to a line number, with
per-disposition binding strength:

- `false-positive` uses a **strict** anchor: rule + normalized message + a
  content hash of the flagged line itself. If that line is later rewritten,
  the mark stops matching and the rule gets a fresh chance to re-fire — a
  "false positive" verdict shouldn't outlive the code it was judged against.
  Whitespace-only changes don't break it.
- `suppress` / `defer` / `flagged` use a **weak** anchor: rule + normalized
  message only. These express intent about the *finding*, so they survive
  edits to the line and drift elsewhere in the file. (`suppress` is enforced
  by the inline comment anyway; the store entry is an audit mirror.)

## Suppression comments

`suppress` writes a pi-lens-owned ignore comment on the line immediately
**above** the flagged line (comment syntax chosen by file type,
indentation-matched, appended to an existing `pi-lens-ignore` comment when one
is already there):

```ts
// pi-lens-ignore: no-floating-promises
const x = risky();
```

This is the same convention every runner/profile honors, so a suppression is
portable, git-tracked, and visible in review — not private pi-lens metadata.

## Telemetry

Every mark (including in-memory `defer`) is appended as NDJSON to
`~/.pi-lens/dispositions.log` with the tool, rule, disposition, reason, and any
`previousDisposition` on re-marks — the raw signal for per-rule false-positive
rates and rule tuning. Each mark is also published on pi's shared event bus as
`pilens:diagnostic:disposition` (v1, additive-only payload; disable all bus
publishing with `PI_LENS_BUS_PUBLISH=0`).

## Storage

Persistent marks live in `diagnostic-dispositions.json` under the project data
directory (see `PILENS_DATA_DIR` in
[environment-variables.md](environment-variables.md)). Deleting the file
clears all persistent dispositions; suppression comments in source are
unaffected (they're the enforcement, not the record).
