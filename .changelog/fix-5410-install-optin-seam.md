---
section: Changed
audience: user
area: install
---

- **pi-lens no longer installs rubocop, rustfmt or rust-clippy without asking.** Their installs (`gem install`, `rustup component add`) change your whole gem root or toolchain. The three still run when present. When they are absent, the rubocop runner reports `not-installed`, the rust-clippy runner reports `probe-rejected`, and the rustfmt and rubocop formatters skip silently. (refs #5410)
