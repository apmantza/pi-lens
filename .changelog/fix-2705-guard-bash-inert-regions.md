---
section: Fixed
---
- **Guard-bash preserves here-string boundaries and rejects malformed heredoc substitutions (refs #2705, #2726)** — `<<<` is consumed as a here-string operator instead of being re-read as a phantom heredoc delimiter, and an unclosed `$(` or backtick in an unquoted heredoc body is treated as non-executable by the scanner while later live commands remain classified.
