---
section: Fixed
---

- **Classify YAML files under Helm `templates/` directories as Helm templates** — pi-lens no longer sends raw Helm Go templates to the YAML language server, eliminating cascading false-positive YAML parse diagnostics while retaining Helm lint and render validation.
