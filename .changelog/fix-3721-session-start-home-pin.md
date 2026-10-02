---
section: Fixed
audience: internal
---

- **A test process can no longer truncate the real `~/.pi-lens` logs (refs #3721, refs #3715)** — the shared log writer's `truncate()` (behind `clearLatencyLog`) now refuses, in a vitest process, to cut a log that lives under `<homedir>/.pi-lens`, and counts the refusal as one `log-sink-truncate-refused` row per sink in `pilens_health`, emitting one `process.emitWarning` (visible on stderr) on the first refusal so the test process that caused it sees it. A test with a pinned home still truncates, and production, which never truncates a log, is unchanged. On 2026-09-30 an unpinned test's `clearLatencyLog()` cut 76 minutes of rows out of a maintainer's real `latency.log`. The test harness also gives every vitest worker its own `PI_LENS_HOME` (the 33 test-mode-off files shared one `latency.log`, the #3880 flake), and a run that leaves new untracked entries in the repo root now reds the hygiene owner.
