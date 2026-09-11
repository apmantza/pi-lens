---
section: Fixed
---

- **The release workflow's publish toolchain is now exercised before a release (closes #2940)** — `release.yml`'s publish job runs npm through the version pinned in `package.json`'s `packageManager`; since the pin moved to `npx`, a bare `npm publish` silently used the runner's bundled npm, which has no OIDC trusted-publishing support, and the v4.1.6 release created its tag and GitHub release before the registry answered E404. The publish job now asserts the pinned npm's version in the step immediately before publishing, `prepare`'s dry-run publish goes through the same pinned invocation, a governance test reds on any bare `npm <verb>` in either job, and the release-QA matrix gained a `publish-toolchain-pinned` row that runs that toolchain against the candidate before a tag exists.
