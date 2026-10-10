---
section: Added
audience: internal
---

- Add an end-to-end witness that a save-only LSP server's diagnostics reach pi-lens exactly when `textDocument/didSave` is sent: the fake stdio server publishes only from its `didSave` branch (`FAKE_LSP_PUBLISH_ON_SAVE`), and a real `createLSPClient` reads the seeded diagnostic after a save touch and none without one (refs #3405).
