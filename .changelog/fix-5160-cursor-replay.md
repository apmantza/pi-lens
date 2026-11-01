---
section: Fixed
audience: user
---

- **Cursor's replayed edit cards are no longer refused "Edit without read" (refs #5160)** — pi-cursor-sdk replays Cursor's native work as display-only tool calls (ids prefixed `cursor-replay-`) after the files are already written. pi-lens learned the neutral `cursor` replay tool as a mutating tool and then refused every later one, turning each Cursor edit card red. Calls with that id prefix are now never armed for learning, never classified from a learned name (a `cursor` entry already saved in `observed-mutating-tools.json` is ignored for them) and never checked by the read guard, including replays shown as built-in `edit`. Real `edit` and `write` calls, Cursor's real bridged executions (`cursor-pi-bridge-*`) and tools that really mutate are checked as before.
