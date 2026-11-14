---
section: Added
audience: user
area: host
---

- **An opt-in `pi-lens-issues` footer status shows diagnostics counts.** `--lens-issues-status` (or
  `ui.issuesStatus: true`) publishes `●<N>E`, `!<N>W`, both side by side,
  `⚠ <N> unchecked`, or `✓ clean`, drawn from the widget header's own tallies so
  the footer and the widget cannot disagree. Off by default; the footer is
  unchanged when the flag is unset. The text is plain, with no terminal color
  escapes, so a status-rendering host or bridge reads it as written. (refs #5588)
