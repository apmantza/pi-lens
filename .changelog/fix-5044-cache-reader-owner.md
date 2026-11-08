---
section: Fixed
audience: user
area: tools
---

- **A mark on a finding's own file now hides it in cached reports.** A chart-level finding recorded under the edited file's session record (helm-lint reporting `Chart.yaml`) honored marks made on the edited file's path and ignored its own; `lens_diagnostics mode=all`/`delta` and the footer's tags now anchor on the file each finding names. A cited file that moved after the finding was observed, or that sits outside the project or cannot be read, no longer suppresses that row. (refs #5044)
