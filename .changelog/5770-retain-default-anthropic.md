---
section: Changed
audience: user
area: config
---

- **Retained context injections are now on by default for `anthropic-messages` models.** Findings that pi-lens injects are repeated unchanged in later requests so the provider's prompt cache keeps hitting; every other API keeps the old default of off. Set `contextInjection.retain` to `false` in `~/.pi-lens/config.json` to opt out, or to `true` to turn it on for every API. (refs #5770)
