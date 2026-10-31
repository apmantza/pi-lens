---
section: Fixed
audience: user
---

- **An edit whose dependents the graph cannot place no longer reads as a leaf.** When a caller references a changed symbol by name alone and another definition shares the name, the cascade dropped the caller and reported no neighbours, the same verdict as a file nothing uses. It now reports the run as indeterminate and says a clean cascade result does not cover those files (#5055).
