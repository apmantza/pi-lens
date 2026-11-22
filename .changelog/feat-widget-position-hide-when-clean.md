---
section: Added
audience: user
area: config
---

- **The diagnostics widget can now move above the editor or hide when clean.** Set `widget.position` to `"aboveEditor"` or `"belowEditor"` (the default), and set `widget.hideWhenClean` to `true` to hide the widget 5 seconds after it first shows `✓ clean`. The widget draws nothing until a first edit gives it something to show. It returns on any finding, unchecked file, or starting server. Both keys are global-only and have no CLI flag. (refs #5724)
