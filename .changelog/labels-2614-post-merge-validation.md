---
section: Fixed
---
- **Label-sync post-merge validation fails when the syncer deletes or loses any label (refs #2614)** — the `labels.yml` sync job now snapshots the live label set before `action-label-syncer` runs and re-validates after: any before-vs-after deletion, or any manifest label missing from the live set, fails the job through `::error::label sync deleted or missing labels:` with the names printed, instead of a silent success while prune deletes labels (the #2553 recurrence, twice for the priority labels).
