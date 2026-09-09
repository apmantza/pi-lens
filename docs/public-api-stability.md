# Public API stability and versioning policy

**Status:** normative. Landed by #2418; gates #2416.
**Enforced by:** `clients/config-diagnostic-codes.ts` (the data),
`tests/support/schema-stability.ts`, `tests/config/schema-stability-tiers.test.ts`,
`tests/clients/config-diagnostic-codes.test.ts`,
`tests/clients/config-deprecation-registry.test.ts` (the tests).

pi-lens ships to roughly 28k installs a month. A config field, a warning a user
greps for, or a tool id becomes a compatibility obligation the moment it ships —
whether or not anyone wrote that obligation down. This document writes it down,
and every clause below is backed by a test rather than by convention, because a
policy nobody can fail is not a policy.

Scope: the unified config schema (#2415/#2416/#2383/#195), the capability
facades, the MCP tool mirror, and the versioned `PiLensApi` (#1358). It does not
define any catalog schema; it constrains how those schemas evolve.

## 1. Field stability tiers

Every property in a published pi-lens schema carries an `x-stability`
annotation, whose value is one of a closed vocabulary:

| Tier | Meaning |
| --- | --- |
| `experimental` | May change shape, semantics, or disappear in a **minor** release. Not covered by the compatibility guarantee. |
| `stable` | Covered by the guarantee. Shape and semantics change only in a **major**, through the checklist in section 4. |

Rules:

- **New fields default to `experimental`.** Shipping a field straight to
  `stable` is a deliberate act, not a default.
- **Promotion `experimental` → `stable` is changelogged** under `Changed`,
  naming the field. Demotion `stable` → `experimental` is a breaking change and
  follows section 4.
- **A property with no tier fails CI.** `assertSchemaStabilityTiers` walks the
  whole schema — `properties`, `patternProperties`, `items`, `prefixItems`,
  `additionalProperties`, `oneOf`/`anyOf`/`allOf`, `not`, `if`/`then`/`else`,
  `$defs`/`definitions` — so a field cannot hide from the tier requirement by
  living inside a composition keyword.
- The **root schema** is not itself a property and carries no tier. Entries
  under `$defs`/`definitions` are reusable subschemas, not published fields;
  they need no tier, but every property *inside* them does.

The vocabulary lives in `STABILITY_TIERS` and the annotation key in
`STABILITY_TIER_KEY` (`clients/config-diagnostic-codes.ts`). #2416's first real
catalog schema asserts itself with the same two exported functions rather than
writing a second walker.

## 2. Stable config diagnostic codes

Every user-facing config validation or migration warning carries a code from a
closed, **append-only** namespace, `PILENS_CFG_NNNN`, registered once in
`CONFIG_DIAGNOSTIC_CODES`.

- **The prose is not API; the code is.** Message text may be rewritten in any
  release. A code is never renumbered, never removed, and a retired number is
  never reused — a retired code keeps its registry entry with an amended
  description.
- The code is threaded through the one durable choke point
  (`recordDegradationOnce` / `incrementDegradationCount` in
  `clients/degradation-ledger.ts`) and through `notifyUserDegradation`, so the
  same code appears in the user-visible message, in `extension.log`, and in the
  durable `latency.log` degradation row.
- The durable row writes `code` **after** the bounded caller metadata, so the
  ledger's `MAX_METADATA_KEYS` cap can never evict the one field a user greps
  on.
- A new `notifyUserDegradation` call from any `clients/**/*config*.ts` file
  without a registered code fails CI
  (`tests/clients/config-diagnostic-codes.test.ts` scans for it; it does not
  keep a hand-maintained list of call sites).

### How a user matches or suppresses a warning

**The match key is the bracketed suffix, not the prose.** Every coded warning is
rendered as:

```
pi-lens: ignoring invalid LSP config .pi-lens/lsp.json: Unexpected token } [PILENS_CFG_0001]
```

The trailing ` [PILENS_CFG_NNNN]` marker is appended by
`withConfigDiagnosticCode`, is idempotent, and is always last. Match on it:

```sh
# every ignored-config warning this session, from the durable degradation log
grep 'PILENS_CFG_0001' ~/.pi-lens/latency.log

# suppress one code while keeping every other pi-lens warning
pi ... 2>&1 | grep -v 'PILENS_CFG_0001'
```

The extraction pattern is exported as `CONFIG_DIAGNOSTIC_MARKER_PATTERN`
(capture group 1 is the code) so tooling need not re-derive it. Anything that
filters on the prose instead — `"ignoring invalid"` — is filtering on a string
this policy explicitly reserves the right to change.

### Registered codes

| Code | Meaning | Emitter |
| --- | --- | --- |
| `PILENS_CFG_0001` | A config file exists but could not be read or parsed, so it is ignored. | `warnIgnoredConfigOnce` (`clients/config-warn.ts`), the single choke point behind the LSP, global, and project config loaders. |
| `PILENS_CFG_0002` | A deprecated config **key** was accepted inside its deprecation window. | `deprecationRecords` (`clients/config-resolve.ts`), one record per `(file, key)`, delivered by `reportPiLensConfigRecords` (#2426). |
| `PILENS_CFG_0003` | A deprecated config **file location** was read inside its window. | Same producer and same delivery path as `PILENS_CFG_0002`. |
| `PILENS_CFG_0004` | A config field no schema property claims was dropped. | `validate()` (`clients/config-core/normalize.ts`) produces the record; `reportPiLensConfigRecords` (`clients/config-resolve.ts`) delivers it through `warnIgnoredConfigOnce` (#2426). |
| `PILENS_CFG_0005` | A config field's value did not match its schema and was dropped. One FIELD; the rest of the file is in effect. | Same producer and same delivery path as `PILENS_CFG_0004`. |
| `PILENS_CFG_0006` | A config key that would modify an object's prototype (`__proto__`, `constructor`, `prototype`) was refused. | Both halves of the config core, through the shared policy in `clients/config-core/safe-object.ts`. |
| `PILENS_CFG_0007` | Further config notices were suppressed by a bound, and this one carries the count — the WHOLE count, including anything an earlier bound in the same pipeline dropped. Nothing about the config is wrong; the notice list was truncated. | `MigrationRecordCollector.finalize` (`clients/config-core/records.ts`) — the ONE producer, reached through `finalizeRecords` by every record list: the shared resolution, the global loader's unknown-key scan, the project loader's unknown-key scan, and its legacy-document enumeration. Rendered with neutral prose and recorded under the `config-notice-suppressed` degradation kind, never `config-ignored`. |
| `PILENS_CFG_0008` | Resolving a config failed internally, so the WHOLE file was ignored and pi-lens ran on defaults. | The two guards under the pipeline: `resolveConfig` (`clients/config-core/resolve.ts`) and the global loader's post-parse catch (`clients/lens-config.ts`). Carries the error class only, never its message. |
| `PILENS_CFG_0009` | A tool config key is unknown or names a required, non-disableable tool. | The shared model-facing tool registry (`clients/tool-config.ts`) and both pi/MCP registration surfaces. |

A reserved code is registered and referenced by the deprecation registry, but
nothing emits it today. That is deliberate: the number must be pinned before the
migration warning ships, because append-only means the number cannot be chosen
later.

## 3. Config-envelope identity anchor

The unified config format reserves a `$schema` URL from its first published
version. Both halves are pinned in `clients/config-diagnostic-codes.ts`:

- `CONFIG_SCHEMA_ID` — the canonical schema URL. The published schema's own
  `$id` must equal it.
- `CONFIG_SCHEMA_ANCHOR_KEY` (`"$schema"`) — the key a user's config file uses
  to name the schema it was written against.

`assertSchemaIdentityAnchor` checks all three facts: the schema's `$id` matches,
the schema declares a meta-schema, and the root declares a `$schema` **instance**
property so a user's file can carry the anchor. Pinning the URL in one module is
what stops it drifting between the schema, the validator, and the docs.

## 4. Deprecation window and removal checklist

### The maintainer stance

**A legacy source is read for exactly one deprecation window, and then it is
actually removed.** pi-lens does not carry legacy config surfaces forever, and
it does not silently drop them either. Both failure modes are ruled out by the
same rule: while a surface is inside its window it is read and honored exactly
as before, with a bounded coded warning; at the next major it is removed through
the checklist below, announced in `Removed`. Nothing is ever dropped without an
announced window that preceded it.

### The data

Every deprecated key or file location is a row in `DEPRECATED_CONFIG_SURFACES`
carrying `surface`, `kind`, `code`, `deprecatedSince`, `removeNotBefore`, and a
`reason`. The registry test enforces:

- `deprecatedSince` names the release that **announces** the deprecation — for a
  row announced only in an unreleased `.changelog/` fragment, that must be a
  version later than the newest release in `CHANGELOG.md` (you cannot back-date
  a deprecation into a version that already shipped without it);
- `removeNotBefore` is a **later major**, `X.0.0` — removal never happens in a
  minor;
- the row's code is registered, and matches its kind;
- the surface is announced in a Changelog `Deprecated` section as a delimited
  token (`` `pi-lens.json` ``), so a substring of a longer filename does not
  count as an announcement;
- FILE rows name a location a loader actually reads, and KEY rows name a key the
  `LSPConfig` interface actually declares — both checked against the exported
  constants and the real interface body, never a hand-copied list.

Note that a canonical file is not deprecated because some of its keys are.
`.pi-lens.json` is a canonical location (#2426); the deprecated surfaces are the
legacy top-level LSP keys read from it, which are `kind: "key"` rows.

### The removal checklist

This is the checklist #2372 slice 5's "separately approved breaking-change plan"
instantiates. It does not invent a second process; slice 5 is one execution of
this list.

1. **Window elapsed.** The current version is at or past the row's
   `removeNotBefore`, and that version is a major.
2. **Announced.** The surface has been in a shipped `Deprecated` changelog
   section since `deprecatedSince`, continuously.
3. **Warned in-product.** The migration warning has been emitting its stable
   code for the whole window — the user has had a coded, greppable signal, not
   only a release note.
4. **Migration path documented and reachable.** The replacement surface exists,
   is `stable`, and the `reason` field names it.
5. **Canonical-wins collision behavior verified.** For the whole window, a
   config setting both the legacy and the canonical surface resolved to the
   canonical one, with the coded warning naming the ignored legacy value.
6. **Removal PR does all four:** deletes the reader, deletes the registry row,
   adds a `Removed` changelog entry naming the surface and the replacement, and
   keeps the diagnostic code registered (codes outlive the surfaces they
   described).
7. **Approved as a breaking change.** A major-version bump plus explicit
   maintainer approval on the plan; a removal never rides in on an unrelated PR.

Removing a row from `DEPRECATED_CONFIG_SURFACES` while the reader still exists,
or removing the reader while the row still exists, fails the registry test. The
two move together or not at all.

## 5. The config core

`clients/config-core/` is the one place a pi-lens configuration is validated,
merged, and explained. Every loader, catalog, and selector resolves through it
(#2425); a fourth merge semantics is a defect, not a design choice.

The pipeline is `RawConfig -> validate(schema) -> NormalizedConfig ->
merge(sources) -> Resolved<T>`, and `resolveConfig` runs both halves. It is
pure: no file reads, no logging, no ledger writes. Reporting is the separate,
explicit `reportPiLensConfigRecords` step (`clients/config-resolve.ts`, which is
where the loaders share it — never inside the core), so the warn-once latch
stays with the loaders rather than with the library.

Every loader reports **every** record its own resolution produced — it does not
filter to the records it "owns". Ownership is a property of the RECORD, not of
the caller: `reportPiLensConfigRecords` derives the reporting subsystem from the
record's own owner and tier, so an `lsp.*` key always reports as an LSP setting
and a pi-lens key always reports under the loader for its tier, whichever loader
happened to open the file. A `(file, key)` that three loaders all resolve is
reported three times and the warn-once latch — keyed on
`(subsystem, file, key, reason)` — collapses those into the one notice the user
sees. Filtering by caller instead is what left a record no loader claimed
reported by nobody at all (#2426 review round 3, F1).

### Source tiers

Seven tiers, lowest value-precedence first. A later tier's value replaces an
earlier one for the same leaf.

| Tier | Class | Meaning |
| --- | --- | --- |
| `builtin` | **default** | pi-lens's own shipped defaults. |
| `global` | operator | The user's machine-global config. |
| `project` | **repo** | A config file inside the checkout. |
| `nested-project` | **repo** | A config file in a nested package. |
| `env` | operator | Environment variables. |
| `cli` | operator | Command-line arguments. |
| `host` | operator | The host application's decision. |

The class column is a second, independent axis, and it has **three** values, not
two. `repo` tiers carry content that arrived with a checkout — content a user
may never have read. `operator` tiers are a deliberate act by the person running
pi-lens. `default` is pi-lens's own shipped opinion, which nobody chose. Only the
class decides who may lift a denial; `builtin` being its own class is what keeps
a shipped default overridable by the operator while still out of reach of
repository content.

### Monotonic deny precedence

A schema node marked `x-deny` resolves by denial rules instead of
last-tier-wins:

- `x-deny: "boolean-false"` — a `false` from an **operator** tier is never
  lifted, by anything. A `false` from a `default` or `repo` tier is lifted only
  by an explicit `true` from an **operator** tier of higher precedence. A repo
  tier never lifts a denial at all, its own class included.
- `x-deny: "array-union"` — the resolved list is the union of every tier's
  members. There is no vocabulary for un-denying a member, so a nearer tier that
  omits one is expressing nothing. This outranks the node's own
  `x-merge-strategy`: a denial a merge strategy could erase would not be
  monotonic.

Provenance for a denied leaf names the tier that **made** the denial, not the
last tier to restate it — the answer to "why can I not turn this back on".

Two consequences are deliberate rulings rather than accidents of the algorithm,
and both are load-bearing:

**A built-in denial is a default, not a law.** `builtin: false` plus
`global: true` resolves to `true`, attributed to `global`; `builtin: false` plus
`project: true` stays `false`, attributed to `builtin`. When `builtin` sat in the
operator class, a conservative default pi-lens shipped — an `enabled: false`, or
any member of a built-in deny list — could never be lifted by anyone, including
the person who installed pi-lens, and the only escape was editing pi-lens's
source. A default the operator cannot override is not a default.

**An operator denial is not liftable by a nearer operator tier.** `global: false`
plus `cli: true` stays `false`. This is the spec letter and it is kept on
purpose: a denial is a security decision, and letting one operator surface
out-shout another would make the guarantee depend on which surface an attacker
could reach (an inherited `PILENS_*` environment variable, a wrapper script's
argv) rather than on what the operator decided. The escape hatch is an
operator-tier **change** — edit the global config, unset the variable — never a
repo-tier one.

### Prototype-safe keys

`__proto__`, `constructor`, and `prototype` are refused wherever a config
supplies a key, in both halves of the pipeline, with a `PILENS_CFG_0006` record
naming the key. No pi-lens setting is spelled that way, so there is nothing to
preserve, and assigning one would change an object's behavior rather than its
contents — a document that serializes as `{}` while answering an attacker's
value on every field read.

Both halves also bound their own recursion at `MAX_CONFIG_DEPTH` (32) and
`resolveConfig` never throws: a config that cannot be resolved degrades to
absent with records, never to a failed session.

A schema node that declares no `type` — or a `type` keyword the core does not
recognize — is **opaque**, and an opaque node is walked by the value's own
shape rather than passed through. Its children are kept (that is what an opaque
node means), but they are copied, depth-counted, key-checked, and recorded like
any other. A schema that wants a genuinely free-form subtree should still say
`additionalProperties: true`, which states the intent instead of relying on an
omission.

### Merge strategies

Objects are always merged field-wise; a nearer tier setting one key never erases
its siblings. Arrays follow the node's `x-merge-strategy`:

| Value | Behavior |
| --- | --- |
| `replace` (default) | The highest-precedence tier that sets the array supplies all of it. |
| `append` | Every tier's entries, concatenated lowest precedence first. |
| `keyed:<field>` | Entries matched across tiers by `<field>` and merged field-wise; unmatched entries appended. |

### The trust-gated `ProcessSpec`

A `ProcessSpec` carries a non-empty argv, a bounded env (count and bytes), a
closed `cwdMode`/`inputMode`, a timeout, its provenance, and the trust decision
that applied when it was read. `toSpawnArgs(spec)` is the only way to get
spawnable arguments out of one, and for a `project` or `nested-project` spec it
refuses unless **both** the spec's recorded trust and the host's current
`isProjectTrusted()` decision are `"trusted"`. Two conditions, because a session
can revoke trust after the config was read; one condition would make a spec a
permanent capability token.

`unknown` fails closed here, unlike `isToolInstallAllowedByTrust`. That gate
governs pi-lens's own managed tools; this one governs a command string a
repository wrote.

Refusals record under the existing `trust-refusal` degradation kind through
`incrementDegradationCount`, carrying the tier, `argv[0]`, and the trust
generation — never an argument or an env value.

### Redaction

`redactProcessSpec` is the only projection of a spec for a diagnostic or
telemetry surface. It strips every env **value** and every argv entry after
`argv[0]`; env names survive, because a name is a label and "which variables did
this server get" is the question an operator asks.

`provenanceView(resolved)` is redacted by construction: it is built from the
provenance map alone and never reads the resolved value, so no un-redacted view
exists. Validation records are bounded and structural — a reason names a key, a
type, and a count, never a value or a source snippet.

## Where each policy point is enforced

| Policy point | Data | Test |
| --- | --- | --- |
| 1. `x-stability` on every published field | `STABILITY_TIER_KEY`, `STABILITY_TIERS` | `tests/config/schema-stability-tiers.test.ts` via `assertSchemaStabilityTiers` |
| 2. Append-only `PILENS_CFG_*` codes | `CONFIG_DIAGNOSTIC_CODES` | `tests/clients/config-diagnostic-codes.test.ts` |
| 3. Reserved `$schema` identity anchor | `CONFIG_SCHEMA_ID`, `CONFIG_SCHEMA_ANCHOR_KEY` | `assertSchemaIdentityAnchor` |
| 4. Deprecation window + removal checklist | `DEPRECATED_CONFIG_SURFACES` | `tests/clients/config-deprecation-registry.test.ts` |
| 5. Config core: tiers, deny precedence, ProcessSpec trust | `clients/config-core/` | `tests/clients/config-core/*.test.ts`, `tests/config/config-core-schema-stability.test.ts` |

## Related

#2415 (shared config core), #2416/#2372 (catalog schema and its compat
template), #2383, #195 (selector semantics), #1358 (facade versioning — a
separate version axis this policy only has to compose with), #2426 (canonical
config locations).
