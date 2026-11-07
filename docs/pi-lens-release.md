<important if="building, packaging, or releasing">

## Build, packaging, and release

`main` and `pi.extensions` point to `dist/index.js`; `dist/` is generated and
not committed. `prepare` builds it for git and package installs. `build:dist`
bundles pure-JS dependencies while keeping host-provided and lazy native
packages external. Package-root resource resolution is depth-robust; pi
resolves `pi.skills` entries relative to the package root, so manifests use
`"./skills"` and never an escaping path.

Runtime imports must be production dependencies. The pi SDK is an optional
peer/dev dependency and must be imported type-only. Lockfiles use the pinned
npm version. Release notes use one `.changelog/<slug>.md` fragment per PR
(`audience: user` or `internal`; the release body lists only `user`); never
edit `CHANGELOG.md` for ordinary PR notes.
A `user` fragment carries an `area` and the one shape
`- **Headline sentence.** Body. (refs #N)`; `.changelog/README.md` lists the
rules, and internal fragments are exempt.

### Release roll: duplicate entries and highlights

The orchestrator's `release-roll.sh` runs the first step after it rolls the
fragments into `CHANGELOG.md` (it works in `--dry`), and both steps belong to the
release PR:

1. `node scripts/rollup-changelog.mjs --duplicates <version>` prints a checklist
   of entry pairs of one section and one area whose headlines have a word
   overlap of 0.4 or more, or that share three or more code spans. The roll
   appends it to its `summary.md`, the source of the release PR body; run it by
   hand to re-check after an edit. It edits no file. The maintainer merges,
   keeps or dismisses each pair in that PR; an unchecked box is not a gate.
2. The orchestrator drafts 3 to 5 highlights and the maintainer approves them in
   that PR as `.changelog/highlights/<version>.md`: the line `### Highlights`,
   then 3 to 5 `- ` bullets, nothing else. `changelog-extract.mjs --summary`
   (what `release.yml` passes) puts that block on top of the release body, and
   `rollup-changelog.mjs --check` refuses a malformed file. `CHANGELOG-USER.md`
   stays count-only. No model runs in CI and no step needs a secret.

</important>
