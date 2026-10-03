---
section: Fixed
audience: internal
---

- The import fact provider no longer records `export default "x"` or
  `export = "x"` as a re-export from module `x`, and no longer marks a file
  that has only such a statement as ESM. A re-export now needs the `from`
  keyword (closes #3822).
