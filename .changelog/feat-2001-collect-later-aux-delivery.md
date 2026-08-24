---
section: Added
---

- **Collect-later delivery for slow auxiliary LSP servers (closes #2001, refs #2002)** —
  When an auxiliary scanner such as opengrep misses its aux-grace window,
  pi-lens now marks the file and server pair in a bounded pending store
  instead of dropping the scanner's eventual findings. The next turn end
  probes the auxiliary's client cache through a read-only seam,
  freshness-gates the result against the mark timestamp, and delivers
  survivors as a `Late auxiliary diagnostics` advisory. A cited file that was
  edited or deleted since the mark drops its findings, and both drop arms are
  counted in the new `late_auxiliary_findings` latency record.
