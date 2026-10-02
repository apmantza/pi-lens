---
section: Fixed
audience: user
---

- **Every `pilens_analyze` pull reports an unanalysable file (#3791)** — The dispatcher latched its synthetic coverage notice once per session, so a second warm `pilens_analyze` call for a file with no toolchain returned zero counts and an empty diagnostics list — a silent false clean. The pi push surface keeps its once-per-session notice; the MCP pull surface, including the warm PostToolUse hook route, now repeats it on every call, matching the cold hook route.
