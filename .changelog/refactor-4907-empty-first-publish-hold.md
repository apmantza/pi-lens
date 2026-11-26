---
section: Changed
audience: internal
---

- Fold the stored-path and fence-drop producers of the `lsp_empty_first_publish_held` hold onto one `spendEmptyFirstPublishHold` helper in `clients/lsp/client.ts`; the spend rule and the record are unchanged (384-case old-versus-new probe identical). (refs #4907)
