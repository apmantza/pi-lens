---
section: Fixed
audience: user
area: rules
---

- **The shipped ast-grep rules load on ast-grep 0.51.1 and later.** Those versions refuse a rule file with a top-level key outside the rule schema, which stopped the whole rule set from loading. The 218 rules that carried `tags`, `examples`, `has_fix` or the vendored CodeRabbit `ast-grep-essentials` marker at top level now keep them under `metadata:`, and what each rule matches is unchanged. (refs #5424)
