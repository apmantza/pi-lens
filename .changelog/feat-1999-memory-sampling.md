---
section: Added
---

- **Memory-sample observability upgrades (refs #1999)** — The periodic
  `memory_sample` latency.log line gains three fields. `peakWorkingSetBytes`
  records the OS high-water working set from `process.resourceUsage().maxRSS`,
  so an idle-moment rss sample can be told apart from true growth (on Windows
  libuv backs both counters with one `GetProcessMemoryInfo()` call: rss reads
  current `WorkingSetSize`, maxRSS reads `PeakWorkingSetSize`). A rising-edge
  cadence tightens sampling from every 10 turns to every turn while heapUsed
  grows more than 20% between samples, reverting once growth stabilizes; the
  state resets at each primary session start. Each sample now also carries
  session age, session start time, and turn count, so growth-vs-age curves are
  plottable from logs alone. The `/lens-health` memory line shows peak WS when
  known.
