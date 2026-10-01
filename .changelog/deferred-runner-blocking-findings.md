---
section: Fixed
---

- Deliver a collect-later runner's findings at turn end when it reports `failed` with diagnostics. Turn end used to treat every failed deferred result as a broken runner and drop its blocking errors, telling the agent only "Deferred runner pyright failed". Only a failed result with no diagnostics, or with a fault kind such as a clippy timeout, is reported as a broken runner now (its partial findings still deliver); the rest passes the freshness gate like a success, and a late blocking finding is no longer labelled "no action required" (refs #3796).
