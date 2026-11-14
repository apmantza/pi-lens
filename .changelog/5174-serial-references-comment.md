---
section: Changed
audience: internal
---

- Record the rust-analyzer measurement at the neighbour cascade's references loop. Overlapping the calls saves 5 ms warm and 16 ms after a body edit on clap, so the loop stays serial. (closes #5174)
