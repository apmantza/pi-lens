---
section: Fixed
audience: user
---

- **Late writes from a replaced session no longer land in the new one (closes #3596, closes #3620, closes #3709)** — An edit's tool_result or an `agent_settled` sweep that was still running when `/new`, resume, fork or `/reload` replaced the session could write into the new session: the read guard counted a file the new session never read as authored (so its first edit was allowed without a read), and the file joined the new session's turn state, deferred format queue, turn summary and git-guard cache. Each of these writes now checks the session it started in and is dropped once that session has ended. The drop is counted in the degradation ledger, and the project change log still records the change. Extensions that call the mutation bridge are unaffected. A debounced tool_result keeps its session, and an observed multi-file tool stops analysing files once its session is replaced.
