---
section: Added
audience: user
---

- **Built-in Lean 4 language support (refs #4119)** — `.lean` files are recognized and sent to the Lean language server using the `lean` LSP language id. In Lake projects, pi-lens launches `lake serve` from the detected project root, so Lake and elan honor the project's toolchain and environment. pi-lens does not install or manage Lean; install Lean and Lake separately and ensure `lake` is on `PATH`.
