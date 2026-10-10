# index.ts hook-anchor replay (#3803 F4, #3878)

`index-ts-replay.json` is the last 25 commits that touched `index.ts` at
origin/master `4e1cfbfd0` (`git log -25 --format=%H -- index.ts`, merges
included). Per commit it keeps:

- `diff`: `git diff -U0 --no-color <sha>^ <sha> -- index.ts`, the shape the PR-body
  lint reads (no context lines, so no hunk names the hook it sits in);
- `ranges`: `findHookRanges` (`scripts/lib/tla-coverage.mjs`) over that commit's
  post-image, hook to 1-based inclusive line ranges. A post-image is 170 KB, so
  25 of them are stored as their ranges; `index-ts-2e4848dd5.txt` is one full
  post-image (a `turn_end` edit made through the named handler `onTurnEnd`) for
  the end-to-end case through `lintTlaCoverage`;
- `expected`: the hooks that fire.

`expected` was cross-checked when generated against an independent method (the
nearest preceding one-tab statement opener in the post-image, no range
arithmetic): 25 of 25 agreed. 19 of the 25 commits edit a lifecycle handler. The
other 6 (`60c02f38f`, `75c426d0a`, `8cbcdaf7f`, `c6e91f789`, `b4e729e8a`,
`8934c1f7a`) have hunks outside every handler (imports, bridge wiring,
activation helpers, `resources_discover`) and print the advisory note without
gating.
