---
section: Removed
audience: internal
---

- **Retired the merge-train lane and the dispatch-only first hop in CI; PR title, body and close-keyword checks no longer re-run Lint on edit (closes #3837, closes #3838)** — the lane (`merge-train-lane.yml`, its scripts, the `train:approved` and `train:squash` labels) ran 322 times in one five-hour window with 0 merges, and its only `repository_dispatch` sender is gone, so every `validate-merge-train-dispatch` job (a no-op on pull requests that still queued a median 310 s in front of every `ci.yml` and `lint.yml` job), every `record-post-merge-validation` recorder and every `repository_dispatch` trigger went with it; required check names are unchanged. `PR title`, `PR body (advisory)` and `Close-keyword syntax` now live in one `pr-metadata.yml` that runs on opened, edited, synchronize and reopened, and `lint.yml` no longer runs on `edited`. The merge policy moved from the `merge-train` skill to `docs/pi-lens-merge-policy.md` with the lane text cut; the merge-train warden is untouched.
