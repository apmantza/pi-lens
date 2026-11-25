---
section: Fixed
audience: user
area: tools
---

- **A finding in a directory named `..foo` now gets the same id in every checkout.** The id hashed the checkout's absolute path for such files, so a dismissal or a stored warning did not follow the project to another clone; the id of a file in a `..`-prefixed directory changes once. (refs #2556)
