---
section: Fixed
audience: user
---

- **A `pi-lens-ignore` comment or a disposition mark now applies to the file a finding names**: a comment in the edited Helm template no longer hides the blocking `helm-lint` error reported on `Chart.yaml`, on the edit path, in a slow runner's late answer or in the turn-end blocker; a mark on one file's finding no longer hides the same finding on another file; a finding whose file cannot be read or lies outside the project is never suppressed; and a mark made earlier against the template path for a `Chart.yaml` finding stops applying, so that finding shows once until it is marked on `Chart.yaml` (#5044).
