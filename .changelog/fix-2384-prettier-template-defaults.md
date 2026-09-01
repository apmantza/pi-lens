---
section: Fixed
---

- **Unconfigured HTML and YAML files no longer auto-format with Prettier (closes #2384)** — Template markers such as an HTML `<script>{{JS}}</script>` embed or a Helm `{{ .Values.x }}` were reinterpreted as code by the smart-default Prettier selection, silently corrupting runtime templates. `.html`, `.htm`, `.yaml`, and `.yml` now select no formatter without a project Prettier config, following the Markdown precedent; an explicit `.prettierrc` or `package.json` `prettier` field still opts in. Thanks to @aspiers for the report and reproduction.
