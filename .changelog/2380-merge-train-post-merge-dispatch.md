---
section: Fixed
---

- **Replay exact-SHA master validation after merge-train merges (closes #2380)** - merge-lane merges authenticated with `GITHUB_TOKEN` no longer lose the ordinary push-triggered validation. The lane dispatches a `merge-train-post-merge` event with the merge response's exact SHA, repository, and PR number. Each validation workflow checks out trusted workflow-revision code for its prerequisite, authenticates the payload SHA's resolution and ancestry, then lets downstream jobs check out that exact SHA and report bot-authored terminal state. Durable requested markers, six-hour retry generations, and bounded reconciliation recover process exits, missing runs, and failed validation without treating HTTP acceptance as completion. Missing merge identity and dispatch failures stay visible as landed-but-unverified errors.
