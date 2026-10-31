---
section: Fixed
audience: user
---

- **A Java edit now cascades to the files that import it.** The cascade used to skip Java files, so an importer broken by the edit was never reported. It now asks jdtls about each importer, delivers the errors it finds, and names an importer jdtls has not re-checked since the edit as unconfirmed instead of clean (#5040).
