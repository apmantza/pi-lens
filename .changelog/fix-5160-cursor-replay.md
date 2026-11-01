---
section: Fixed
audience: user
---

- **Cursor's replayed edit cards are no longer refused "Edit without read" (refs #5160)** — pi-cursor-sdk replays Cursor's native work as display-only `cursor` tool calls (ids prefixed `cursor-replay-`) after the files are already written. pi-lens learned `cursor` as a mutating tool from the first such replay and then refused every later one, turning each Cursor edit card red. Calls with that id prefix are now never armed for learning and never classified from a learned name, so a `cursor` entry already saved in `observed-mutating-tools.json` is ignored. Real `edit` and `write` calls, and tools that really mutate, are checked as before.
