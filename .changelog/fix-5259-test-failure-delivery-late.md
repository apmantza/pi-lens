---
section: Fixed
audience: user
---

- **A failing test result no longer reaches the model one agent run late**: when the agent's next edit launched another test run that was still going when the agent finished, the earlier failure was dropped from the next prompt and shown only after the following run (#5259).
