---
section: Fixed
audience: user
area: security
---

- **On Windows, an untrusted project's gopls or rust-analyzer no longer runs through a sibling file.** When `$GOPATH\bin` or `$CARGO_HOME\bin` sat inside the repository and pi did not trust it, pi-lens refused the project's `<tool>.exe` but still offered the extensionless name, which Windows completes to any `.cmd`, `.bat` or `.com` beside it. The extensionless name is now withheld from an untrusted project directory, and the refusal is recorded as `trust-refusal`. (refs #5715)
