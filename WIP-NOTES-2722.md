# WIP notes — #2722 (DELETE THIS FILE BEFORE OPENING THE PR)

Checkpoint commit taken because the machine is rebooting. Everything below is
from real runs in this worktree, with `PI_LENS_HOME` / `PILENS_DATA_DIR` pinned
to `<worktree>/.probe-home/scratch1` (never the real `~/.pi-lens`).

## What is DONE (compiles clean: `npm run build` green)

`clients/installer/index.ts`
- `ToolDefinition.verification?: "package-entry"` (new optional field).
- `intelephense` registry entry declares `verification: "package-entry"`, with
  the measured byte offsets in its comment.
- `packageEntryVerification(tool)` — exported; returns `tool.packageName` only
  when the entry declares `verification: "package-entry"`.
- `verifyNpmPackageEntry(binPath, packageName)` — exported; spawn-free. Resolves
  `<node_modules>/<bare package name>` beside the `.bin` shim, requires a
  readable `package.json` with a `version` string, resolves the entry module
  (`bin[<shim name>]` / bare `bin` string / `main`) and requires it to exist as
  a non-empty file. Logs `auto-install verify: failed for <p> (check=package-entry,
  kind=...)` on every failure branch.
- `verifyToolBinary` gained two trailing optional params:
  `packageEntryOf?: string` (present ⇒ skip the spawn, delegate to
  `verifyNpmPackageEntry`) and `onInconclusive?: () => void`.
- `verifyToolBinary` failure path: when `result.outputTruncated`, fire
  `onInconclusive` and `recordDegradationOnce({ kind:
  "installer-verification-inconclusive", subject: binPath, ... })`.
- `installNpmTool` gained `packageEntryOf?`; tracks `lastAttemptInconclusive`
  and returns WITHOUT the delete-and-cleanup branch when the last attempt was
  inconclusive, logging
  `auto-install <pkg>: verification inconclusive (output truncated before the
  transport-required marker); keeping installation for re-probe`.
- `packageEntryVerification(tool)` threaded to the five managed-local verify
  sites: `getAllToolStatuses` local `.bin`, `getToolPath` local `.bin`
  (win `.cmd`, win `.exe`, posix), and `verifyRefreshedArtifact`; plus
  `installTool`'s `installNpmTool` call.

`clients/degradation-ledger.ts`
- New ledger kind `"installer-verification-inconclusive"` with its doc comment.
  (Session lifetime is the ledger's own: `resetDegradationLedger()` clears
  `onceKeys` — catalog shape 17 satisfied by reuse, no new latch.)

## What is NOT done yet

1. **No tests written yet. Nothing has been proven red.** This is the single
   biggest remaining item.
2. Changelog fragment.
3. Commit split / final message, PR.
4. Targeted + governance suite runs.
5. `npx oxfmt --check` on the touched files.

## Real-binary evidence already captured (reuse in the PR body)

intelephense@1.18.5, linux, Node 24, installed into
`<worktree>/.probe-scratch/node_modules` with a pinned scratch `PI_LENS_HOME`:

```
$ ./node_modules/.bin/intelephense --version 2>&1 | wc -c
1048576
$ ./node_modules/.bin/intelephense --version 2>&1 | grep -c "Connection input stream is not set"
0
$ ./node_modules/.bin/intelephense --version > /dev/null 2> err.txt ; wc -c < err.txt
4423356
$ grep -abo "Connection input stream is not set" err.txt | head -1
4154741:Connection input stream is not set
$ node -p "require('./node_modules/intelephense/package.json').version"
1.18.5
$ node -p "JSON.stringify(require('./node_modules/intelephense/package.json').bin)"
{"intelephense":"./lib/intelephense.js"}
$ readlink node_modules/.bin/intelephense
../intelephense/lib/intelephense.js
```

Reproduces the issue exactly (issue quoted 4423468 / 4154757 for a slightly
different path prefix length; same defect).

## Sibling sweep — REAL runs, all npm-strategy LSP servers in TOOLS

Installed every one of them into the scratch prefix and ran
`<bin> --version </dev/null`, splitting the first 64 KiB (the installer's
retained window) from the whole stream:

```
tool                        | exit | bytes   | marker offset | in first 64K
typescript-language-server  |   0  |       6 | none          | 0   -> real --version
pyright                     |   0  |      16 | none          | 0   -> real --version
bash-language-server        |   0  |     205 | none          | 0   -> real --version
fish-lsp                    |   0  |       6 | none          | 0   -> real --version
yaml-language-server        |   0  |       7 | none          | 0   -> real --version
vscode-json-language-server |   1  |    1527 | 203           | 2   -> #208 rescue fires
vscode-html-language-server |   1  |    1527 | 203           | 2   -> #208 rescue fires
vscode-css-language-server  |   1  |    1525 | 203           | 2   -> #208 rescue fires
docker-langserver           |   1  |    1513 | 208           | 2   -> #208 rescue fires
prisma-language-server      |   0  |       0 | none          | 0   -> exit 0, verifies
vue-language-server         |   0  |       7 | none          | 0   -> real --version
svelteserver                |   0  |       0 | none          | 0   -> exit 0, verifies
intelephense                |   1  | 4423356 | 4154741       | 0   -> THE DEFECT
```

Verdict: intelephense is the ONLY registry entry in the class today. The other
twelve either print a real version (exit 0) or land their transport-required
marker at byte ~203-208, far inside the 64 KiB window. So the second tool in
the test table (acceptance 4) must be a FIXTURE server in the same shape
(>2 MiB of noise, then the marker), not a second registry entry — the fixture
is what proves the fix is class-wide rather than intelephense-specific.

## Test plan for the next fixer (red-first, in this order)

1. `tests/clients/installer/intelephense-verify-real.test.ts` — **replace it.**
   It is currently vacuous AND wrong: it `skipIf`s unless the MAINTAINER'S REAL
   `~/.pi-lens/tools/node_modules/.bin/intelephense` exists (probe-hygiene
   violation), and if it ever did run it would assert `true` against the very
   bug this issue reports. Delete it in this PR with the reason in
   `Test assessment`.
2. New test at the real seam, hermetic, patterned on
   `tests/clients/installer/verify-binary-semantics.test.ts` (mkdtemp + shim
   writer, cross-platform `.cmd` / `#!/bin/sh`):
   - a shim that writes >2 MiB then the transport-required marker, driven
     through the REAL `verifyToolBinary` (no double supplies the marker —
     test-authoring screen 1): asserts `false` AND that `onInconclusive` fired
     AND that the ledger holds `installer-verification-inconclusive`.
     Pre-fix: `onInconclusive` does not exist / never fires -> red.
   - a real `node_modules` layout on disk (`node_modules/.bin/<shim>` plus
     `node_modules/<pkg>/package.json` + entry file) driven through
     `verifyToolBinary(..., packageEntryOf)`: verifies true with NO spawn.
     Mutations to prove: delete the entry file -> false; blank the `version`
     -> false; remove the package dir -> false.
   - a SECOND fixture tool in the same table (acceptance 4) — a different
     package/shim name proving the path is not intelephense-keyed.
3. End-to-end through the real production call path, patterned on
   `tests/clients/installer/installer-lifecycle.integration.test.ts`: a fake
   npm (`PI_LENS_TEST_NPM_SCRIPT`, `PI_LENS_TEST_MODE=1`) that lays down a
   fake `intelephense` package (package.json + `lib/intelephense.js` entry +
   a `.bin` shim that dumps 2 MiB then the marker), then `ensureTool
   ("intelephense")` in a child process with a scratch `PI_LENS_HOME`.
   - PRE-FIX expectation (the red): `value === undefined`, sessionstart log
     contains `installed but verification failed, cleaning up`, and
     `<home>/tools/node_modules/intelephense` is GONE.
   - POST-FIX: `value` is the real `.bin` path and the package dir survives.
   Prove it red by `git checkout <pre-fix-sha> -- clients/installer/index.ts
   clients/degradation-ledger.ts` + `npm run build` AFTER committing the tests.
4. `tests/clients/installer/markdownlint-verify-2045.test.ts` around line 194
   WILL go red: its "bounds retained output for noisy language-server probes"
   case asserts `getDegradationSummary()` `toEqual` exactly one row, and the
   new inconclusive row now lands on that same `status: 1 + outputTruncated`
   path. Update it to expect BOTH rows — that is honest, and it is itself a
   guard for the new row.
5. Governance batch, selected mechanically:
   `ls tests/clients/*{sweep,ratchet,conformance,coverage,gate,governance,silence,hermeticity,invariant,contract}*.test.ts`
   plus EVERY `tests/config/*.test.ts`. Also
   `tests/clients/installer/*.test.ts` and any file grepping
   `verifyToolBinary` (11 files: managed-tool-refresh, runner-helpers-
   generation-ledger, verify-binary-semantics, installer-lifecycle.integration,
   intelephense-verify-real, probe-cache-transient, tool-discovery,
   markdownlint-verify-2045, version-drift, runner-helpers, lsp-transport-verify)
   plus `tool-registry-consistency.test.ts` / `tool-definition.test.ts` (a new
   ToolDefinition field may be enumerated there).

## Mutations that must be shown red in the PR body

- `verification: "package-entry"` removed from the intelephense entry.
- `packageEntryVerification` returning `undefined` unconditionally.
- the `if (packageEntryOf !== undefined) return verifyNpmPackageEntry(...)`
  short-circuit deleted, and forced BOTH ways (`if (true)` / `if (false)`).
- `if (result.outputTruncated)` in `verifyToolBinary` forced true and false.
- `if (!isValid && lastAttemptInconclusive)` forced true and false.
- each `fail(...)` branch in `verifyNpmPackageEntry` (entry-missing,
  no-version, package-json-unreadable) neutered to `return true`.

## Other things to check before reporting

- The intelephense registry comment claims `--stdio </dev/null`, `--help`,
  `-v`, `--socket=0` all reproduce the dump. That is quoted FROM THE ISSUE,
  not from my own run (shape 16). Either run them in the scratch prefix or
  trim the sentence to what was measured.
- `probeManagedToolVersion` (clients/installer/index.ts, ~line 3874) spawns
  `tool.checkArgs` directly against the cached path, bypassing
  `verifyToolBinary`. intelephense is unpinned so it should not reach there —
  CONFIRM that, and if it can, it is a 4 MB spawn on a probe path.
- `installNpmTool`'s cleanup uses the raw (possibly pinned) `packageName` for
  its `rm` path — pre-existing, out of this brief, do NOT fix here.
- Do not touch `scripts/smoke-tools.mjs` classification, and do not change
  `--ignore-scripts` / `NEEDS_POSTINSTALL`.
