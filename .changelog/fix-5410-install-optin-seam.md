---
section: Changed
audience: user
area: install
---

- **pi-lens no longer installs rubocop, rustfmt or rust-clippy without asking.** Their installs (`gem install`, `rustup component add`) change your whole gem root or toolchain. The three still run when present, and when absent they report "not installed". (refs #5410)
