---
section: Fixed
audience: user
---

- **`lsp.servers.<id>.command` accepts the argv array the docs show**: `"command": ["my-lsp-server", "--stdio"]` now launches (the first element is the program, the rest come before `args`, and no default `--stdio` is added) instead of failing with `The "path" argument must be of type string`, and `effective_config` shows such a server's command and argument count (#5127).
