---
section: Fixed
---
- **Guard-bash preserves here-string boundaries and classifies heredoc substitutions the way bash expands them (closes #2705, refs #2726)** — `<<<` is consumed as a here-string operator instead of being re-read as a phantom heredoc delimiter; an unclosed `$(` or backtick in an unquoted heredoc body is treated as non-executable while later live commands remain classified; and a valid `$()` or backtick substitution discovered before a later unclosed one stays classified, with substitutions nested inside the malformed span kept inert like bash.
