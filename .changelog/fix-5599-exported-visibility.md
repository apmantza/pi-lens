---
section: Fixed
audience: user
area: tools
---

- **The review graph now marks public Rust, Go, Java, Kotlin and C# symbols as exported.** Editing a `pub fn` now raises the exported symbol changed risk flag, and Rust structs, enums, traits, constants, type aliases and modules now reach the graph. A language whose visibility cannot be read from the declaration, such as Python, reports unknown instead of not exported. (refs #5599)
