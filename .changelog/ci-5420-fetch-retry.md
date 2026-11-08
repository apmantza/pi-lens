---
section: Fixed
audience: internal
---

- CI npm installs retry a transient registry 5xx: every workflow that reaches the npm registry sets `npm_config_fetch_retries` and `npm_config_fetch_retry_maxtimeout` once at its top level, and the four `oven-sh/setup-bun` steps in install-smoke now install `bun@latest` from the npm registry. The fetch gate fails closed on a workflow that installs from npm without the env, on an install step it cannot classify, and on any `uses:` action with no recorded verdict (refs #5420).
