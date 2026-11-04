# Per-entry changelog files

Each user-facing change gets one Markdown file in this directory. The file name
must be `<branch-or-slug>-<short-desc>.md`, for example
`feat-1321-changelog-entries.md`.

Use YAML front matter to select one Keep a Changelog section, followed by one
entry in any of the repository's existing styles:

```markdown
---
section: Fixed
audience: user
---

- **Short title (closes #1321)** — Explain the user-visible change.
```

New `audience: user` fragments must open with a bold lead (`**...**`) of at
most 100 characters; issue references such as `(#1321)` do not count. Internal
fragments are exempt. This keeps release-summary lines readable.

`section` must be `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or
`Security`. `audience` is required: `user` for anything a pi-lens user or an
agent using pi-lens can observe (tools, diagnostics, messages, config, install,
performance, a fixed bug they could hit), `internal` for CI, tests, `formal/`,
contributor docs, orchestration and refactors with no observable change. The
GitHub release body lists only `user` entries plus a one-line internal count;
`CHANGELOG.md` keeps the `internal` ones in a collapsed `### Internal` block.
The entry may use a `-` or `*` bullet, bold or plain text, and an
em dash, period, or no title separator. Continuation lines and nested bullets
are preserved; each file must contain exactly one top-level entry.

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
