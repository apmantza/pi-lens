/**
 * THE shared config core (#2425). Every future config loader, catalog, and
 * selector resolves through this module rather than growing a fourth merge
 * semantics of its own.
 *
 * The pipeline, in one line:
 *
 *   RawConfig -> validate(schema) -> NormalizedConfig -> merge(sources) -> Resolved<T>
 *
 * `resolveConfig` runs both halves and is the front door. It is a pure function
 * of its arguments: no file reads, no ledger writes, no logging. Reporting is a
 * separate, explicit step — `reportPiLensConfigRecords` in
 * `clients/config-resolve.ts` — so a caller decides when a user gets warned and
 * under which subsystem; a library that warns on its own would fragment the
 * warn-once latch across every consumer.
 *
 * That step used to live HERE, in `records.ts`, which meant this "pure" library
 * imported `config-warn.js` and the degradation ledger (#2426). Purity was the
 * claim and the import graph disagreed: it broke every suite that `vi.mock`s the
 * ledger wholesale, and it closed seven import cycles the moment the first
 * loader — all of which sit downstream of `file-utils.ts` — resolved through the
 * core. The reporting function moved to the module that owns the loaders'
 * subsystem vocabulary, and the one constant records needs from the ledger
 * (`DEGRADATION_ENTRIES_PER_KIND`) moved to the `ledger-bounds.js` leaf that
 * exists for exactly this. Nothing under `config-core/` imports a sink now.
 *
 * ALL THREE LOADERS ARE WIRED as of #2426, through `clients/config-resolve.ts`
 * and the canonical schema in `clients/config-schema.ts`:
 * `clients/lsp/config.ts` (`loadLSPConfig`), `clients/lens-config.ts`
 * (`loadPiLensGlobalConfig`), and `clients/project-lens-config.ts`
 * (`loadPiLensProjectConfig`) are now projections of one resolution. #2416
 * brings the `lsp.servers.<id>` shape the schema currently only reserves.
 */

export { SOURCE_TIERS } from "./provenance.js";

// `merge()` itself is NOT re-exported. Its input type only PROMISES a
// post-`validate()` value; nothing in the language enforces that a caller
// who imports it directly honors the promise, and `merge()`'s own bounds are
// a narrow backstop, not a second validator (see `merge.ts`'s module doc).
// `resolveConfig` (re-exported at the bottom of this file, from `resolve.js`)
// is the one supported way in: it always validates
// every source before merging. `merge()` stays exported from `merge.ts`
// itself — marked `@internal` there — for this module's own use and for
// tests that probe it directly.
// `resolveConfig` and its types live in `./resolve.js` (#2426) so a caller can
// import the front door without also importing this barrel's width — in
// particular `process-spec.js` -> `project-trust.js`, which closed three
// import cycles once the config loaders (all downstream of `file-utils.ts`)
// started resolving through the core. The public surface is unchanged: this is
// still where the supported entry point is exported from.
export { resolveConfig } from "./resolve.js";
