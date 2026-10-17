---
section: Fixed
audience: user
---

- **Stop re-pushing byte-identical LSP content once the debounce window has passed.** The touch gate now decides by the bytes the client last sent, so a touch whose own work outlived the window no longer sends a redundant `didChange` that clears the server's diagnostics and restarts computation (#4532).
