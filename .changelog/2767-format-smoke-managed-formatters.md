---
section: Fixed
---

- **The format smoke lane installs the managed formatters it selects (refs #2767)** —
  The `--install` path prefetches configured formatters through `ensureTool`
  and the formatter pipeline resolves those managed binaries, with venv/local
  → PATH → managed precedence; every managed resolver returns the typed
  unavailable outcome instead of falling through to a bare command; GitHub and
  archive installs record a typed unavailable outcome when no asset exists for
  the host platform and architecture; the formatter-absence tests pin the
  installer's independent PATH lookup so npm's `node_modules/.bin` prefix on
  CI cannot resolve a dev-dependency binary.
