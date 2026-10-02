---
section: Changed
audience: user
---

- **Declare the `@earendil-works/pi-tui` peer as `"*"`, like pi-coding-agent (refs #2682, #3805)** — pi provides both packages from its own runtime and warns when an extension lists one any other way, and the old `^0.84.1 || ^0.85.0` range made a raw `npm i` with a current pi-tui at the top level a hard ERESOLVE. The hosts pi-lens supports are still bounded, now only by `PI_HOST_SUPPORTED_RANGE` in `install-smoke.yml`, which `tests/packaging.test.ts` pins against the release-qa verified hosts.
