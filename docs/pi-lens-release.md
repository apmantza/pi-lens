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

After `npm run changelog:release` rolls the fragments into `CHANGELOG.md`, and
before the release PR opens:

1. Run `node scripts/rollup-changelog.mjs --duplicates <version>` and paste its
   checklist into the release PR body. It flags entry pairs of one section and
   one area whose headlines share most of their words (overlap 0.4 or more) or
   that share three or more code spans, and it edits no file. The maintainer
   merges, keeps or dismisses each pair in that PR; an unchecked box is not a
   gate.
2. The orchestrator drafts 3 to 5 highlights for `CHANGELOG-USER.md` and the
   release body in the same PR. The maintainer approves both there. No model
   runs in CI and no step needs a secret.

</important>
