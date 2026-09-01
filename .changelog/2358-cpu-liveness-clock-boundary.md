---
section: Fixed
---

- **Make the #2358 CPU-liveness regression proof clock-boundary safe (refs #2358).**
  The real-runner test checks the recorded outstanding wedge window with a
  two-millisecond Windows and Node quantization allowance, and runs in the
  serialized wall-clock budget phase.
