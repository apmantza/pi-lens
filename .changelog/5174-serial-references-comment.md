---
section: Changed
audience: internal
---

- Record the rust-analyzer measurement at the neighbour cascade's references loop. Overlapping the calls saves 5 ms warm, 16 ms after a body edit and an unstable 21-77 ms after a structural edit on clap, short of a stable 50 ms, so the loop stays serial. (closes #5174)
