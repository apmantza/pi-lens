---
section: Fixed
---

- **Windows lane enumerated zero files because six scripts detected "am I the entry module" by string-comparing `import.meta.url` with `file://${process.argv[1]}`** (refs #2536) — on Windows the two spellings never match, so the main block never ran; every gate now compares against `pathToFileURL(process.argv[1]).href`, the win32 gate scanner excludes fixtures by the platform separator, and a governance test rejects the hand-built comparison.
