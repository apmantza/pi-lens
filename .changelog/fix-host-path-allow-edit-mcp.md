---
section: Fixed
audience: user
area: tools
---

- **`/lens-allow-edit` and the MCP analyze and turn-end tools read `~` and `@` paths.** They resolved a path such as `@src/a.ts` or `~/proj/a.ts` to a file that cannot exist, so `/lens-allow-edit` armed nothing and `pilens_analyze` and `pilens_turn_end` checked a ghost path. They now resolve it as pi does. (refs #4907)
