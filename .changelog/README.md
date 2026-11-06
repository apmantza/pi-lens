# Per-entry changelog files

Each user-facing change gets one Markdown file in this directory. The file name
must be `<branch-or-slug>-<short-desc>.md`, for example
`feat-1321-changelog-entries.md`.

Use YAML front matter to select one Keep a Changelog section, the audience and
(for `user` entries) the area, followed by one entry:

```markdown
---
section: Fixed
audience: user
area: lsp
---

- **A resumed session now publishes its restored diagnostics.** An extension that listens on the bus sees the same findings as the widget. (refs #1321)
```

`section` must be `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or
`Security`. `audience` is required: `user` for anything a pi-lens user or an
agent using pi-lens can observe (tools, diagnostics, messages, config, install,
performance, a fixed bug they could hit), `internal` for CI, tests, `formal/`,
contributor docs, orchestration and refactors with no observable change. The
GitHub release body lists only `user` entries plus a one-line internal count;
`CHANGELOG.md` keeps the `internal` ones in a collapsed `### Internal` block.

`area` is required on `user` entries and names one of `lsp` (language servers),
`blockers` (blockers, turn-end findings, sessions), `runners` (linters, test
runners, scanners), `rules`, `tools` (tool output and reports), `config`
(flags and config keys), `install` (installer, updates), `host` (pi, MCP and
other hosts) or `security`. There is no catch-all: a change that fits none is
a maintainer decision, not a new value. The release rollup groups each
section's entries under a `#### <area>` heading in that order. Internal
entries need no area.

A `user` entry is the form above and nothing else, and
`node scripts/rollup-changelog.mjs --check` refuses every other shape:

- One bullet starting with `- `, the first line after the front matter (a
  heading or any other text before it is refused). The bold headline is one
  sentence of 4 to 16 words (at most 100 characters as a reader sees it, code
  spans counted in full) that ends in a period and states what changed
  for the user ("X now does Y."). It has no colon, dash or reference, and it
  does not open with a command ("Keep X out of Y.").
- The body, if any, is one short paragraph (at most 120 words) that starts a
  new sentence after the headline and ends in a period. Wrap continuation lines
  with two spaces of indent, and start each with a letter, a number, a code
  span, a quote or an opening parenthesis. No blank line, list, quote, table,
  heading or fence can start a line.
- At most one reference, as the last thing in the entry: `(refs #N)`, or
  `(refs #N, #M)`. No `closes`, `fixes`, bare `#N` or issue URL.
- No internal terms (degradation, projection, metrics table, seam, latch,
  ledger) outside code spans.

The release body shows the bold headline and the trailing reference only, so the
headline must read alone.

Entry files must land through a PR even though the repository permits direct
pushes for other docs-only changes. At version-bump time,
`npm run changelog:release` folds the populated `Unreleased` section and every
entry file into the new version section, then removes the entry files while
retaining this README. The tag-time release workflow only verifies that this
rollup has already happened.

`CHANGELOG-USER.md` contains the latest five numbered releases: each original
release heading, one count line (features, fixes and other changes, or `No
user-facing changes.`), and a Full notes link. It changes when
`scripts/changelog-release.mjs` invokes the release rollup; ordinary fragment
PRs do not regenerate it. Pi ignores Unreleased sections.
`npm run changelog:check` and the Unit tests check the shipped file against the
release sections from `CHANGELOG.md`. To repair drift, run
`node scripts/rollup-changelog.mjs --user`.
