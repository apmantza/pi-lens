---
section: Removed
audience: internal
---

- **Remove the frozen pre-#5150 `project_report` compact renderer (refs #5168)** — `renderCompactProjectReport`, `ProjectReportOptions.view`, `ProjectReport.view` and the engine `view` plumbing are production-dead after #5150 made the default text cell; the pi tool and the MCP mirror never passed `view` to the engine (their `view:"json"` hatch is tool-local). No observable change.
