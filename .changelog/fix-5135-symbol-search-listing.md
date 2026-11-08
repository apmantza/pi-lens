---
section: Fixed
audience: user
area: tools
---

- **`symbol_search` now lists the files that a term-less filter matches.** A call with `paths`, `lang`, or an inline `lang:`, `file:` or `ext:` filter and no search terms lists the matching files instead of answering that nothing matched. A call with neither terms nor scope is now an error that says so, on the pi tool and over MCP alike. An unknown `lang` value is refused with the accepted file kinds and language ids, even when no term has hits or the index is still building. Inline `lang:` also accepts language ids such as `typescript` and `dockerfile`, and `lang:css`, `lang:json` and `lang:terraform` still match `.scss`, `.jsonc` and `.tfvars` files. (refs #5135)
