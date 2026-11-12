---
section: Fixed
audience: user
area: tools
---

- **`/lens-allow-edit`, `effective_config` and the MCP analyze and turn-end tools read `~` and `@` paths.** They resolved a path such as `@src/a.ts` or `~/proj/a.ts` to a file that cannot exist, so `/lens-allow-edit` armed nothing, `effective_config` reported on a missing file, and `pilens_analyze` and `pilens_turn_end` checked a ghost path. They now resolve it as pi does, `pilens_analyze` reads a `~` cwd as the home directory, and `pilens_turn_end` no longer counts a file outside the workspace as registered. (refs #4907)
