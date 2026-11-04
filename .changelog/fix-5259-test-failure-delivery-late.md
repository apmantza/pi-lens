---
section: Fixed
audience: user
---

- **A failing test result reaches the model at the next prompt**: a run that finished after the agent did, or a newer run that was still going or finished before the next prompt, used to hold the failure back until the run after (#5259). A run that finishes while the agent is working still waits for that run to end.
