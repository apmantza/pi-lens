---
section: Added
audience: internal
---

- A daily scheduled workflow (`untriaged-issues.yml`) now fails loudly, listing every open issue that carries no TYPE label or no `priority:*` label — the mechanical check for issues filed through the GitHub API, which bypasses the issue templates that would otherwise force one. A `tracking:`-titled issue is allowed a priority without a TYPE label (closes #3563).
