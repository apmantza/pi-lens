---
section: Fixed
audience: user
area: tools
---

- **The review graph now marks public Rust, Go, Java, Kotlin and C# symbols as exported.** Editing a `pub fn` now raises the exported symbol changed risk flag, and Rust structs, enums, traits, constants, type aliases and modules now reach the graph. A language whose visibility cannot be read from the declaration, such as Python, reports unknown instead of not exported, and `module_report` lists its symbols under `SYMBOLS (visibility unknown)` with no export count instead of "0 exported". `module_report` now splits Rust files into API and INTERNAL, `mod tests` nests as a class, `read_enclosing` answers struct, enum and mod lines, and on a line shared by an interface and a function the interface now wins. The review graph rebuilds once after upgrade. (refs #5599)
