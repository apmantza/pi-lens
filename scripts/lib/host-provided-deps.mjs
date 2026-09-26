/**
 * Single source of truth for the packages `scripts/bundle-dist.mjs` keeps out of
 * the dist bundle, split by the REASON they stay external. #1926.
 *
 * HOST_PROVIDED_PACKAGES
 *   pi ships these inside its own runtime (`@earendil-works/pi-coding-agent`'s
 *   node_modules). They must be declared as OPTIONAL peer dependencies plus dev
 *   dependencies, never as runtime `dependencies`, because a runtime dependency
 *   makes `npm install --omit=dev` — the command pi runs for a `git:` install —
 *   vendor a private second copy into the extension's own node_modules. Node
 *   then resolves the bare specifier to that copy and evaluates a whole extra
 *   module graph at import. That is #1926: vendoring `typebox` and
 *   `@earendil-works/pi-tui` cost 720ms of the 838ms git-install import, and
 *   removing the copies took the PI_TIMING module import from 941ms to ~180ms.
 *
 *   The three entries are NOT interchangeable at runtime. pi resolves the bare
 *   specifiers `typebox` and `@earendil-works/pi-tui` for an extension, so
 *   VALUE imports of those work with no copy on disk — verified by hiding both
 *   from the dogfood install and re-running under PI_TIMING (#1926), and by
 *   `@tintinweb/pi-subagents`, which declares pi-tui as a peer and ships no
 *   copy. That resolution is jiti's: pi's loader hands `dist/index.js` to
 *   jiti, whose native import fails on those unresolvable static imports, and
 *   the transpiled fallback serves them from pi's running instance
 *   (`virtualModules` in the bundled CLI). `@earendil-works/pi-coding-agent` is
 *   served the same way, but a static import of it would fail the extension
 *   LOAD on any host that does not serve it, and where pi-lens' static imports
 *   resolve natively a runtime import of it goes through Node and can load a
 *   second copy. So pi-lens imports it TYPE-ONLY and inlines the runtime
 *   helpers it needs. `tests/host-sdk-type-only.test.ts` enforces that
 *   separate rule (#1334 S6); do not read this list as permission to
 *   value-import the host SDK. Its one admitted exception is lazy and caught:
 *   `index.ts` looks up pi's `withFileMutationQueue` on the first write, and
 *   `clients/file-mutation-queue.ts` records whether it reached the host's
 *   own copy (#3506).
 *
 * LAZY_NATIVE_PACKAGES
 *   Native addon / wasm, dynamic-imported by absolute file:// URL at call time.
 *   They stay external because esbuild cannot inline a .node or .wasm, and they
 *   cost nothing at load because nothing imports them statically.
 *
 * `tests/packaging.test.ts` pins both invariants against package.json and
 * against the built dist entry, so this list cannot drift from what ships.
 */

/**
 * Host-provided packages the extension VALUE-imports. pi resolves these bare
 * specifiers at runtime, so the compiled entry cannot load without them.
 * Outside pi — a bare `node dist/index.js` in a CI smoke check — nothing
 * supplies them, so a job that wants a FULL load has to install them first, the
 * way pi does. `scripts/supply-host-provided-deps.mjs` does that.
 */
export const HOST_PROVIDED_RUNTIME_PACKAGES = Object.freeze([
	"typebox",
	"@earendil-works/pi-tui",
]);

/**
 * Host-provided packages the extension imports TYPE-ONLY. pi does not resolve
 * these for an extension at all, which is why every runtime helper pi-lens
 * needs from the host SDK is inlined instead; `tests/host-sdk-type-only.test.ts`
 * enforces that (#1334 S6). Never install one of these to make a load succeed:
 * the transitive tree has nested paths that exceed Windows MAX_PATH.
 */
export const HOST_PROVIDED_TYPE_ONLY_PACKAGES = Object.freeze([
	"@earendil-works/pi-coding-agent",
]);

/** Everything pi supplies, so pi-lens must never declare it a dependency. */
export const HOST_PROVIDED_PACKAGES = Object.freeze([
	...HOST_PROVIDED_RUNTIME_PACKAGES,
	...HOST_PROVIDED_TYPE_ONLY_PACKAGES,
]);

/** Native/wasm packages dynamic-imported by absolute path at call time. */
export const LAZY_NATIVE_PACKAGES = Object.freeze([
	"@ast-grep/napi",
	"web-tree-sitter",
]);

/** Everything esbuild must NOT inline into dist/index.js. */
export const BUNDLE_EXTERNALS = Object.freeze([
	...HOST_PROVIDED_PACKAGES,
	...LAZY_NATIVE_PACKAGES,
]);
