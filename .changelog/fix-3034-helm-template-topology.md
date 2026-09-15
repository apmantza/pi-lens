---
section: Fixed
---

- **Require chart topology for Helm YAML classification (refs #3034)** — YAML files under `templates/` remain ordinary YAML unless an ancestor contains `Chart.yaml`; explicit `.tpl` helpers retain their Helm classification.
