---
section: Changed
audience: internal
---

- PR bodies now have four sections (`Summary`, `Notes for the reviewer`, `Change outline`, and `Proof and checks`), and the body lint counts the parsed markdown: visible text is capped at 5000 characters, each code block at 20 lines and 400 columns (100 lines in all), the summary at three sentences and 600 characters, and reviewer notes at one list of five bullets. `Class sweep` carries an `Alignment:` line naming the families of `docs/alignment-families.md` it touches. `Why` folds into `Summary`, `Test assessment`, `Type of change`, `Area`, and `Checklist` are gone, and `Blast radius` is conditional (#5003). A table row whose cell count differs from its header (an unescaped `|` in a backticked cell splits it on GitHub) is refused.
