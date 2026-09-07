---
name: release-qa
description: Run the pi-lens release-readiness QA pass — witness the feature × modality matrix against a real pi, count coverage, and issue a ship / ship-with-caveats / don't-ship / blocked line. Use before cutting a release tag, or when asked whether a build is shippable.
---

# Release QA

The pass that runs before a release is cut. Sibling of `merge-train`: that skill
decides whether one PR may land, this one decides whether the accumulated result
may ship.

Why it exists: #2587. Four shipped skills were suspected of never registering
for four releases (3.8.51 → 4.1.3) because **no check ever asked a real pi what
it loaded**. The unit suite (~10.8k tests) and the nightly smokes (install,
compat, tool, lifecycle, parser) are per-seam; nothing composed them into a
release verdict with counted coverage, so a missing row read as absence rather
than arithmetic.

## Hard rules

These outrank convenience, habit, and the shape of any previous pass.

1. **No witness, no verdict.** A row is PASS only when an artifact SHOWS the
   pass criterion. A witness that merely exists — a log file that was written, a
   process that exited 0 — is not a witness. Quote the line.
2. **Reachability is decided in planning, not discovered mid-run.** A row that
   cannot be reached in this run is SKIPPED with the reason written down BEFORE
   the run, never a PASS that quietly measured nothing.
3. **Coverage is counted, never claimed.** Report the
   `discovered / rows / untested` arithmetic the runner prints, verbatim. "All
   the important paths were checked" is not a coverage statement.
4. **An expired poll is UNTESTED, never PASS.** Async rows are polled to a
   terminal state under a stated cap. Expiry means you did not see the result.
5. **BLOCKED is not a failure and not a pass.** If pi cannot boot, no ship
   verdict is issued at all. Say BLOCKED and stop.
6. **The repo's runbook outranks habit.** `docs/release-qa-baseline.md` and
   `AGENTS.md` are the contract. If a step here disagrees with them, they win
   and this file is wrong.

## Procedure

### 1. Read the baseline

`docs/release-qa-baseline.md` is the matrix — row ids, entry points, pass
criteria, witness kinds. Read it before running anything; the runner parses this
same document, so a row you cannot explain is a row the runner will execute
anyway.

### 2. Derive the DIFF rows

The BASE rows are the matrix. The DIFF rows are what THIS release changed, and
`.changelog/` is the diff inventory:

```
git describe --tags --abbrev=0            # the last tag
ls .changelog/*.md                        # every pending entry = one change
```

For each fragment, ask: does it touch a surface the matrix already covers, or a
new one? A fragment that adds a modality, a new entry point, or a new shipped
resource needs a row. Two outcomes are acceptable and one is not:

- add the row to `docs/release-qa-baseline.md` (and a probe in
  `scripts/release-qa.mjs` — the two lists are tied and the unit test enforces
  it), or
- record in the report that the change is covered by an existing row, naming
  which.

Silently leaving a change unrowed is the failure this skill exists to prevent.

### 3. Run the runner

```
git status --porcelain                # must be empty; the runner packs a commit
node scripts/release-qa.mjs --pi <path-to-pi>
```

Useful flags:

- `--from npm:pi-lens@<version>` — QA a PUBLISHED release instead of the working
  tree. This is how a regression is demonstrated against the last release.
- `--git-ref <ref>` — enable the `git-install` row against a pushed ref. Without
  it that row is SKIPPED, because a `git:` install resolves a pushed ref rather
  than the working tree.
- `--poll-cap-ms <n>` — the cap for polled rows. State the value you used.
- `--keep` — leave the scratch root for inspection.

Use the pi version `install-smoke.yml` pins (bump by hand, #731) and, when a
newer line exists, repeat against the newest one. Both readings go in the
report.

#### Exit codes — read them, do not infer from the log

| code | verdict | what it means |
| --- | --- | --- |
| 0 | SHIP | every discovered row PASSED with a witness |
| 1 | DO-NOT-SHIP | a row FAILED, or the candidate would not install or activate |
| 2 | SHIP-WITH-CAVEATS | every witnessed row passed; some produced no witness |
| 3 | BLOCKED or INCONCLUSIVE | no verdict: pi did not boot, or nothing was witnessed |
| 4 | usage / self-check error | bad option, unparseable matrix, arithmetic mismatch |

**2 is the EXPECTED verdict for a plain working-tree run** — `git-install-loads`
is SKIPPED without `--git-ref`, and one SKIPPED row is a caveat by definition.
Do not read a 2 as a failure, and do not read it as a clean bill either: name
the caveat. A CI lane treats 2 as a warning and 1/3/4 as failures.

#### What the run touches, and what it must not

The runner pins `HOME`, `USERPROFILE`, `PI_LENS_HOME`, `PILENS_DATA_DIR`,
`PI_LENS_INSTALL_LOG` and `npm_config_cache` inside its own scratch root, and
passes that environment to **every** child — `pi`, the MCP server, `node`, and
`npm`. All six matter. `PI_LENS_INSTALL_LOG` is the one that is easy to miss:
`scripts/warm-loader-cache.mjs` (which `prepare` runs on every pack) keys its
install log on THAT variable and falls back to `PI_LENS_HOME/install.log` (or
`~/.pi-lens/install.log` when neither is set). The runner's first six runs
pinned the pi-lens home, passed no environment to `npm`, and put 41
`warm_loader_cache` records into the maintainer's real `~/.pi-lens/install.log`
(#2619 review F1).

The pack runs in a `git archive HEAD` export inside the scratch root, never in
the live checkout, because `npm pack` fires our own `prepack`
(`scripts/strip-dev-deps-for-pack.mjs` rewrites `package.json` AND
`package-lock.json`, restored only by `postpack`, with no signal trap — an
interrupted pack leaves the checkout stripped) and `prepare` (rebuilds `dist/`,
downloads grammars over the network, reinstalls the git hooks). A dirty checkout
is REFUSED rather than packed as its last commit, because a report whose "QA
target" is not what the operator is looking at is the failure this runner
exists to end.

**Cost and cleanup.** A run installs a production dependency tree twice (the
export, then the scratch project) and builds `dist/`, so budget **~1.1 GB under
`/tmp`** and about a minute of wall clock. The scratch root is removed on exit
unless `--keep` — but an INTERRUPTED run leaves it behind, so
`ls -d /tmp/pi-lens-release-qa-*` after a Ctrl-C session, and remove what you
find.

**Remaining side effects on the checkout: none that persist.** `git archive` and
`git status` are reads. The runner writes `release-qa-report.md` and
`release-qa-evidence/` into `--out` (the cwd by default; both are gitignored at
the repo root). Everything else lands in the scratch root, which is removed
unless `--keep`. Verify rather than trust: `git status --porcelain` before and
after a run must be identical, and
`wc -l ~/.pi-lens/install.log` must not change.

Never run any release probe without those pins — an unpinned probe writes into
the maintainer's real `~/.pi` and `~/.pi-lens` (#2506).

### 3b. Pre-bump dry roll (before opening the bump PR)

The bump PR changes three things the unit suite reads as data: the package
version, the `CHANGELOG.md` release headings, and the `.changelog/` fragment
population (which the roll DELETES). Tests calibrated against the pre-roll
tree go red only on the bump PR, after the gate has already said ship. The
4.1.4 bump (2026-09-07) hit two: `config-deprecation-registry` demanded
`deprecatedSince <= the announcing release` (the window said 4.2.0; the
Deprecated entries shipped in 4.1.4), and `tracked-control-bytes`'s Markdown
floor of 80 had been calibrated while 110 fragments existed (64 files remain).

So, in a scratch export, roll for the target version and run the tests that
read release state:

```
S=$(mktemp -d) && git archive HEAD | tar -x -C "$S"
node scripts/changelog-release.mjs <version> --root-dir "$S"
(cd "$S" && npm version <version> --no-git-tag-version >/dev/null && ln -s "$OLDPWD/node_modules" node_modules && npm run build >/dev/null && \
  npx vitest run $(grep -rl "CHANGELOG.md\|\.changelog\|package.json" tests/ | grep -v "^tests/support\|fixtures" | tr '\n' ' '))
```

Every red here is a release-only calibration: fix it IN the bump PR (a
trailing commit after the bump+roll commit is fine) and name it in the PR
body. Also read the rolled section for a "next version" literal that the
fragments assumed (`4.2.0` in a `Deprecated since …` line when the release is
a patch) and correct it in code, docs and the rolled section together.

### 4. Report

The runner writes `release-qa-report.md` and `release-qa-evidence/<row-id>.*`.
The report you hand back carries, in this order:

1. the verdict line — `ship` / `ship-with-caveats` / `don't ship` / `blocked` /
   `inconclusive` — with its exit code;
2. the coverage arithmetic, quoted verbatim from the runner;
3. every non-PASS row with its cause or reason;
4. the pi version(s) driven and the QA target (`tree`, or the published version);
5. the DIFF rows derived in step 2 and where each landed.

`ship-with-caveats` requires the caveats to be named in the release notes. A
caveat nobody wrote down is a defect that shipped.

## What this is not

- Not a substitute for CI. Unit tests and Lint are still the per-PR gate.
- Not a per-language tool sweep — `scripts/smoke-tools.mjs` does that nightly.
- Not a model-driven test. Every row is model-free by construction; a row that
  needs a real LLM turn cannot be a release gate.
