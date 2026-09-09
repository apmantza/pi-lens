/**
 * Single source of truth for tree-sitter grammar assets: the language→wasm map,
 * the CDN the wasms come from, and the (single-file) download routine.
 *
 * Reused by:
 *  - the runtime client (`tree-sitter-client.ts`), which lazily fetches a
 *    missing grammar on first use (pnpm/bun skip the postinstall);
 *  - the postinstall pre-fetch (`scripts/download-grammars.js`), which can't
 *    import this compiled module (it runs before the TS build), so it keeps a
 *    mirror — guarded against drift by `tests/clients/grammar-source.test.ts`.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { getPackageRoot } from "./package-root.js";

/** tree-sitter-wasms release the grammars are pulled from. */
export const TREE_SITTER_WASMS_VERSION = "0.1.13";

/** unpkg mirror of the tree-sitter-wasms artifacts. */
const GRAMMAR_CDN_BASE = `https://unpkg.com/tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}/out`;

/**
 * Per-grammar source overrides — grammars we pull from a DIFFERENT package than the
 * `tree-sitter-wasms` aggregator, because the aggregator's frozen 0.1.13 build is
 * broken for them. Each override points at the maintained `@tree-sitter-grammars/*`
 * package's prebuilt wasm on unpkg.
 *
 * tree-sitter-lua: the aggregator's lua wasm corrupts to ERROR trees once a second
 * grammar loads into web-tree-sitter's shared WASM Module (#255) — the maintained
 * 0.4.1 build parses cleanly in a multi-grammar process. tree-sitter-yaml: the
 * aggregator's yaml wasm is ABI-incompatible with web-tree-sitter 0.25 and fails to
 * load at all (#427); the maintained 0.7.1 build loads + parses. Mirrored by
 * `SOURCE_OVERRIDES` in scripts/download-grammars.
 */
export interface GrammarSourceOverride {
	/** npm package the wasm actually comes from (for the provenance sidecar). */
	package: string;
	version: string;
	/** Full unpkg URL of the wasm. */
	url: string;
}

export const GRAMMAR_SOURCE_OVERRIDES: Record<string, GrammarSourceOverride> = {
	"tree-sitter-lua.wasm": {
		package: "@tree-sitter-grammars/tree-sitter-lua",
		version: "0.4.1",
		url: "https://unpkg.com/@tree-sitter-grammars/tree-sitter-lua@0.4.1/tree-sitter-lua.wasm",
	},
	"tree-sitter-yaml.wasm": {
		package: "@tree-sitter-grammars/tree-sitter-yaml",
		version: "0.7.1",
		url: "https://unpkg.com/@tree-sitter-grammars/tree-sitter-yaml@0.7.1/tree-sitter-yaml.wasm",
	},
};

/** The URL a grammar wasm is fetched from (override if any, else the aggregator). */
export function grammarSourceUrl(filename: string): string {
	return (
		GRAMMAR_SOURCE_OVERRIDES[filename]?.url ?? `${GRAMMAR_CDN_BASE}/${filename}`
	);
}

/**
 * Provenance for a grammar this repo BUILDS and commits, because no publisher
 * ships a wasm for it. Distinct from `GRAMMAR_SOURCE_OVERRIDES`, which still
 * names a URL to fetch: a vendored grammar has no remote source at all, so
 * every download path must skip it and every resolve path must find it in
 * `vendor/grammars/`.
 *
 * The fields are the reproduction recipe. Re-running `buildCommand` inside a
 * checkout of `repo` at `commit` reproduces the bytes whose sha256 is pinned in
 * `scripts/grammars.lock.json` under `vendored`, and
 * `scripts/check-grammar-provenance.mjs` re-hashes the committed file against
 * that pin — so the committed binary cannot drift unnoticed.
 */
export interface VendoredGrammarSource {
	/** Upstream repository the grammar is built from. */
	repo: string;
	/** Exact upstream commit. Pinned by SHA because upstream cuts no releases. */
	commit: string;
	/** Upstream licence, recorded because the built artifact is redistributed. */
	license: string;
	/** The command run inside that checkout to produce the wasm. */
	buildCommand: string;
}

/**
 * Grammars built in-house and committed to `vendor/grammars/`.
 *
 * tree-sitter-cue: CUE has no published wasm anywhere — not on npm
 * (`tree-sitter-cue` there is a native binding only), not in the
 * `tree-sitter-wasms` aggregator, and upstream cuts no releases (#1522).
 * Building it ourselves, with a modern `dylink.0` section, is the only way to
 * give `.cue` structural analysis, so the artifact is committed and pinned
 * rather than fetched. Mirrored by `VENDORED_GRAMMARS` in
 * scripts/download-grammars.
 */
export const VENDORED_GRAMMARS: Record<string, VendoredGrammarSource> = {
	"tree-sitter-cue.wasm": {
		repo: "https://github.com/eonpatapon/tree-sitter-cue",
		commit: "dd7b90e0770ff18070c515937ba3c3d6d93db00e",
		license: "MIT",
		buildCommand: "npx tree-sitter-cli build --wasm",
	},
};

/** Is `filename` built in-house rather than fetched from a CDN? */
export function isVendoredGrammar(filename: string): boolean {
	return Object.hasOwn(VENDORED_GRAMMARS, filename);
}

/**
 * The verdict for a vendored grammar that isn't on disk. It ships in
 * `vendor/grammars/`, which the resolve path searches first, so needing to
 * "fetch" one means the committed file is missing from the install: a
 * packaging fault, not a network one. No retry, no cooldown ladder, and above
 * all no fetch of a CDN URL that would 404 forever. Non-retryable is the
 * honest verdict precisely because a later attempt cannot change it.
 *
 * Shared so that every caller answers identically. `tree-sitter-client.ts`'s
 * `fetchGrammar` has to consult this BEFORE it resolves a write directory:
 * that resolution can fail on its own (web-tree-sitter not locatable yet) and
 * would otherwise return the generic RETRYABLE environment verdict, hiding a
 * missing vendored asset behind a transient-looking download failure.
 */
export function vendoredGrammarRefusal(
	filename: string,
): GrammarDownloadResult {
	return {
		ok: false,
		retryable: false,
		reason:
			`${filename} is built in-house and ships in vendor/grammars/; it has no ` +
			`download source, so a missing copy means the install is incomplete.`,
	};
}

/**
 * Absolute path to the committed `vendor/grammars` directory. Resolved from the
 * package root for the same reason `grammarManifestPath` is (#1564): an
 * `import.meta.url` offset collapses once `dist/index.js` is bundled.
 */
export function vendoredGrammarsDir(): string {
	return path.join(getPackageRoot(import.meta.url), "vendor", "grammars");
}

/** Language id → grammar wasm filename. */
export const LANGUAGE_TO_GRAMMAR: Record<string, string> = {
	typescript: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	javascript: "tree-sitter-javascript.wasm",
	python: "tree-sitter-python.wasm",
	rust: "tree-sitter-rust.wasm",
	go: "tree-sitter-go.wasm",
	java: "tree-sitter-java.wasm",
	kotlin: "tree-sitter-kotlin.wasm",
	dart: "tree-sitter-dart.wasm",
	c: "tree-sitter-c.wasm",
	cpp: "tree-sitter-cpp.wasm",
	elixir: "tree-sitter-elixir.wasm",
	ruby: "tree-sitter-ruby.wasm",
	bash: "tree-sitter-bash.wasm",
	csharp: "tree-sitter-c_sharp.wasm",
	css: "tree-sitter-css.wasm",
	html: "tree-sitter-html.wasm",
	json: "tree-sitter-json.wasm",
	lua: "tree-sitter-lua.wasm",
	ocaml: "tree-sitter-ocaml.wasm",
	php: "tree-sitter-php.wasm",
	swift: "tree-sitter-swift.wasm",
	toml: "tree-sitter-toml.wasm",
	vue: "tree-sitter-vue.wasm",
	yaml: "tree-sitter-yaml.wasm",
	zig: "tree-sitter-zig.wasm",
	cue: "tree-sitter-cue.wasm",
};

/** The full set of grammar wasm filenames (deduped). */
export const GRAMMAR_FILES: string[] = [
	...new Set(Object.values(LANGUAGE_TO_GRAMMAR)),
];

/** The runtime signals a grammar block predicate may key off. */
export interface GrammarRuntime {
	/** Node major version (0 if unparseable). */
	nodeMajor: number;
	/** True on a V8-backed runtime (Node); false under bun (JavaScriptCore). */
	isV8: boolean;
	platform: NodeJS.Platform;
}

interface GrammarBlock {
	/** Is this grammar unsafe to LOAD on the given runtime? */
	blocked: (rt: GrammarRuntime) => boolean;
	/** Human-readable reason, surfaced in logs + the grammar-health guard. */
	reason: string;
}

/**
 * Grammars that FATALLY crash the host runtime on specific engines/versions and
 * therefore must NOT be loaded there. The crash is an uncatchable process abort
 * (V8 Turboshaft WASM OOM — `Fatal process out of memory: Zone`), so it cannot be
 * degraded in-process with try/catch; the only safe option is to skip the load
 * entirely and degrade the feature (no structural symbols for that language).
 *
 * Membership is GUARD-DRIVEN, not hand-maintained: the grammar-health nightly
 * (`scripts/check-grammar-load.mjs`) is what proves a grammar crashes and thus
 * belongs here, and what proves a future build is safe enough to remove it.
 *
 * tree-sitter-swift crashes on Node >= 24 across all OSes under memory pressure
 * (#423/#432); building from source (an earlier vendoring attempt, #426) does not
 * reliably dodge it. bun (JavaScriptCore) and Node 20/22 are unaffected, so the
 * block is gated on V8 + Node major.
 */
export const BLOCKED_GRAMMARS: Record<string, GrammarBlock> = {
	"tree-sitter-swift.wasm": {
		blocked: ({ isV8, nodeMajor }) => isV8 && nodeMajor >= 24,
		reason:
			"tree-sitter-swift crashes the runtime on Node >= 24 (V8 Turboshaft WASM OOM, #423/#432); skipped so the process degrades gracefully instead of aborting.",
	},
};

/** Runtime signals for the currently-running process. */
function currentGrammarRuntime(): GrammarRuntime {
	const m = /^v?(\d+)/.exec(process.versions?.node ?? "");
	return {
		nodeMajor: m ? Number(m[1]) : 0,
		isV8: !process.versions.bun && Boolean(process.versions.v8),
		platform: process.platform,
	};
}

/**
 * The block reason if `filename` must NOT be loaded on `rt` (default: the running
 * process), else null. Callers skip the load and degrade to "grammar unavailable".
 */
export function grammarBlockReason(
	filename: string,
	rt: GrammarRuntime = currentGrammarRuntime(),
): string | null {
	// Diagnostic escape hatch (grammar-health probe only): force-load a blocked
	// grammar to test whether a fresh build / newer runtime survives — the signal
	// that a block can be LIFTED. Never set in normal operation: it disables the
	// crash protection and can abort the process.
	if (process.env.PILENS_UNSAFE_FORCE_GRAMMAR_LOAD === "1") return null;
	const block = BLOCKED_GRAMMARS[filename];
	return block?.blocked(rt) ? block.reason : null;
}

export interface GrammarDownloadResult {
	ok: boolean;
	/**
	 * Whether a later attempt might succeed. `false` only for a DURABLE
	 * verdict — the CDN itself said this wasm doesn't exist (404/410), which a
	 * retry cannot fix. Every other failure (network error, timeout, DNS,
	 * 5xx, a rate limit) says nothing durable about the grammar and is
	 * retryable (#1536 review F4). Always `true` when `ok` is `true`.
	 */
	retryable: boolean;
	/**
	 * Failure-shape detail for the log line and the degradation ledger, when
	 * the generic "the download failed" is not diagnosable enough. Set for the
	 * #1548 non-wasm-body case ("got HTML, expected wasm") so a captive portal
	 * is distinguishable from an offline laptop in the record. Sentence-shaped
	 * and terminated, because callers splice it into a user-facing message.
	 */
	reason?: string;
}

/**
 * The four-byte WebAssembly module preamble, `\0asm` — the first bytes of
 * every valid `.wasm` file. Single source of truth for the #1548 validation:
 * both the download path (validate before writing) and the on-disk path
 * (`fileHasWasmMagic`, for a file poisoned before this shipped) key off it.
 */
const WASM_MAGIC: readonly number[] = [0x00, 0x61, 0x73, 0x6d];

/** Do `bytes` start with the wasm magic number? */
export function hasWasmMagic(bytes: Uint8Array): boolean {
	if (bytes.length < WASM_MAGIC.length) return false;
	return WASM_MAGIC.every((byte, i) => bytes[i] === byte);
}

/**
 * Does the file at `filePath` start with the wasm magic number? `false` if it
 * doesn't, is shorter than four bytes, or cannot be read at all — every one of
 * those means "do not hand this path to `Language.load`".
 *
 * Reads four bytes, so it is cheap enough to run on a resolve path; callers
 * that resolve repeatedly should still memoize the positive answer.
 */
export function fileHasWasmMagic(filePath: string): boolean {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const head = Buffer.alloc(WASM_MAGIC.length);
		const read = fs.readSync(fd, head, 0, head.length, 0);
		return read === head.length && hasWasmMagic(head);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* nothing useful to do */
			}
		}
	}
}

const HTML_PREFIXES = ["<!doctype html", "<html", "<head", "<?xml"];

/**
 * A short, log-safe sentence naming what arrived instead of a wasm module
 * (#1548). Never echoes the body — only its shape, byte count and the first
 * four bytes in hex — so a proxy's login page cannot smuggle content into a
 * user-facing notification.
 */
export function describeNonWasmBody(bytes: Uint8Array): string {
	if (bytes.length === 0) {
		return "The download returned an empty body (0 bytes) instead of a wasm module.";
	}
	const head = Buffer.from(
		bytes.subarray(0, Math.min(16, bytes.length)),
	).toString("latin1");
	const lead = head.trimStart().toLowerCase();
	const shape = HTML_PREFIXES.some((prefix) => lead.startsWith(prefix))
		? "an HTML page (a captive portal or proxy intercepted the request)"
		: "non-wasm data";
	const magic = Buffer.from(bytes.subarray(0, WASM_MAGIC.length))
		.toString("hex")
		.replace(/../g, "$& ")
		.trim();
	// Kept short on purpose: this is spliced into a user notification and into
	// the degradation ledger, whose fields truncate at 200 characters.
	return (
		`The download returned ${shape} — ` +
		`${bytes.length} bytes starting ${magic}, not a wasm module.`
	);
}

/** Provenance for a single grammar in `scripts/grammars.lock.json`. */
export interface GrammarManifest {
	package: string;
	version: string;
	/** filename → "sha256:<hex>" */
	grammars: Record<string, string>;
	overrides?: Record<string, GrammarSourceOverride>;
	/** filename → build provenance + pinned sha256 for committed grammars. */
	vendored?: Record<string, VendoredGrammarSource & { sha256: string }>;
}

/**
 * Override applied for tests only (`_setGrammarManifestForTests`): `undefined`
 * means "no override — use the real cached/loaded manifest", so `null` is a
 * distinct, deliberate value (simulates a missing/corrupt lock file).
 */
let manifestOverride: GrammarManifest | null | undefined;
let cachedManifest: GrammarManifest | null | undefined;

/**
 * `scripts/grammars.lock.json`'s absolute path, resolved from the installed
 * PACKAGE ROOT rather than a fixed relative offset from this module (#1564).
 * `import.meta.url` collapses to the bundle's own file once `dist/index.js`
 * is esbuild-bundled (every merged module reports the bundle's URL, not its
 * own), so a `join(dirname(fileURLToPath(import.meta.url)), "../scripts/...")`
 * offset — correct in the unbundled repo/`npm run build` layout — resolves to
 * the wrong directory once bundled. `getPackageRoot` instead walks up from
 * wherever this module actually loaded from until it finds `package.json`,
 * which lands on the package root under both layouts; `scripts/grammars.lock.json`
 * is committed and shipped there (see `files` in package.json), so both the
 * repo checkout and an installed npm package resolve it correctly.
 */
function grammarManifestPath(): string {
	return path.join(
		getPackageRoot(import.meta.url),
		"scripts",
		"grammars.lock.json",
	);
}

/**
 * The manifest, without the missing-manifest degradation report — split out
 * so `loadGrammarManifest` can report on every `null` return (cached misses
 * included), while this half stays a pure cache lookup.
 */
function resolveGrammarManifest(): GrammarManifest | null {
	if (manifestOverride !== undefined) return manifestOverride;
	if (cachedManifest !== undefined) return cachedManifest;
	try {
		const raw = fs.readFileSync(grammarManifestPath(), "utf-8");
		cachedManifest = JSON.parse(raw) as GrammarManifest;
	} catch {
		cachedManifest = null;
	}
	return cachedManifest;
}

/**
 * Load + cache `scripts/grammars.lock.json`. Returns `null` (never throws) if
 * the file is missing or malformed — an installed package predating this fix,
 * or a corrupted lock file, degrades to the Content-Length check
 * (`downloadGrammarDetailed`) instead of blocking every runtime grammar
 * fetch. That fallback is silent to the CALLER by design (it's not a fetch
 * failure), so it would otherwise never reach the record a bug report shows —
 * report once per session that the STRONGEST check (sha256) is being skipped
 * repo-wide, so a downgrade to the weaker Content-Length-only path is on the
 * record rather than invisible.
 */
function loadGrammarManifest(): GrammarManifest | null {
	const manifest = resolveGrammarManifest();
	if (manifest === null) {
		recordDegradationOnce({
			kind: "grammar-blocked",
			subject: "grammars.lock.json",
			reason:
				"the pinned sha256 manifest is unavailable — runtime grammar downloads " +
				"fall back to the weaker Content-Length check (or no integrity check at " +
				"all for a source with neither).",
		});
	}
	return manifest;
}

/** Test-only manifest injection — see `manifestOverride` above. */
export function _setGrammarManifestForTests(
	manifest: GrammarManifest | null | undefined,
): void {
	manifestOverride = manifest;
}

/** `sha256:<hex>` digest of `data`, matching the manifest's format. */
function sha256Hex(data: Buffer): string {
	return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/**
 * Pinned sha256 for `filename` from `scripts/grammars.lock.json`, or
 * `undefined` when the manifest is unavailable or has no entry for it — the
 * same "can't verify" fallback `downloadGrammarDetailed`'s own hash check
 * already applies. `manifest.grammars[filename]` is keyed by filename
 * regardless of a `GRAMMAR_SOURCE_OVERRIDES` entry (see the comment on that
 * check), so a single lookup covers both the aggregator and override cases.
 *
 * This is the single source of truth a version bump (`TREE_SITTER_WASMS_VERSION`,
 * or a `SOURCE_OVERRIDES` entry) reaches through: `--write-manifest` regenerates
 * the pinned hash for the new build, so a cached file's sha256 no longer
 * matching this value IS the version-changed signal — no separate "which
 * version produced this file" bookkeeping is needed (#1760).
 */
export function pinnedGrammarHash(filename: string): string | undefined {
	return loadGrammarManifest()?.grammars[filename];
}

/**
 * sha256 of the file at `filePath`, or `undefined` if it cannot be read (does
 * not exist, a directory, a permission error). Callers that cannot verify
 * must treat that the same as "no pinned hash" — never as a mismatch, which
 * would force an unbounded refetch loop against an unreadable path.
 */
export function grammarFileSha256(filePath: string): string | undefined {
	try {
		return sha256Hex(fs.readFileSync(filePath));
	} catch {
		return undefined;
	}
}

/**
 * First 12 hex characters of a `sha256:<hex>` digest, for log/ledger/
 * notification strings. Printing the full 64-hex digest on BOTH sides of a
 * mismatch overran the degradation ledger's 200-character field cap (the
 * truncation `describeNonWasmBody` above already designs around) and left
 * the user notification — 579 characters, almost entirely hex — clipping the
 * more diagnostic PINNED hash mid-string before a reader ever saw it. 12 hex
 * characters (48 bits) is more than enough to tell "genuinely the wrong
 * file" from a coincidence in a log line; it is not a security boundary.
 */
function shortHash(hash: string): string {
	const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
	return `sha256:${hex.slice(0, 12)}…`;
}

/**
 * Fetch one grammar wasm into `destDir`, staged and renamed via
 * `atomic-write.ts` so a reader never sees a half-written wasm. Never
 * throws — a failed fetch (offline, 4xx) degrades to "grammar unavailable"
 * so callers can decide how to handle it.
 *
 * #1548: the response BODY is validated against the wasm magic number before
 * anything is written, so a 200-with-HTML from a captive portal is a failed
 * (retryable) download rather than a poisoned file on disk. A grammar that
 * crashes the runtime
 * is protected at LOAD time (BLOCKED_GRAMMARS / grammarBlockReason), not by
 * refusing to download it.
 *
 * #1564: the magic-number check alone lets a TRUNCATED-but-genuine wasm body
 * through — a connection dropped mid-transfer still starts with `\0asm`. Two
 * further checks close that: (1) when the pinned manifest
 * (`scripts/grammars.lock.json`, already trusted by the postinstall path) has
 * a sha256 for this grammar, the full body must match it; (2) when the
 * response reports `Content-Length`, the received byte count must match it —
 * cheaper, and the only check available when no pinned hash exists (an
 * override not yet in the manifest, or a future grammar added before
 * `--write-manifest` is re-run). Both are retryable failures, same shape as a
 * captive portal: the CDN answered, but the bytes are not trustworthy.
 *
 * #1217: the staging name used to be hand-rolled `.${filename}.${pid}.tmp` —
 * per-process, so two concurrent fetches of one grammar shared a staging inode
 * (#1205). `tree-sitter-client.ts` de-dupes in-flight fetches per grammar file,
 * which made that hard to reach through the runtime path but did not cover
 * direct callers.
 */
export async function downloadGrammarDetailed(
	destDir: string,
	filename: string,
): Promise<GrammarDownloadResult> {
	if (isVendoredGrammar(filename)) return vendoredGrammarRefusal(filename);
	try {
		fs.mkdirSync(destDir, { recursive: true });
		const res = await fetch(grammarSourceUrl(filename));
		if (!res.ok) {
			// 404/410: the CDN has authoritatively answered "this wasm does not
			// exist at this URL" — a retry hits the same answer. Every other
			// non-ok status (429, 5xx) is retryable. A captive portal answers
			// 200, so it never reaches here; the magic-number check below is
			// what catches it (#1548).
			const retryable = res.status !== 404 && res.status !== 410;
			return { ok: false, retryable };
		}
		const data = Buffer.from(await res.arrayBuffer());
		// #1548: `res.ok` says the transport succeeded, NOT that the body is a
		// grammar. A captive portal (airport wifi, corporate proxy) answers 200
		// with its own login page; writing that to disk as tree-sitter-<lang>.wasm
		// poisons the path permanently, because every later resolve finds the
		// (garbage) file and reports the grammar as available while
		// `Language.load` fails on every parse. Validate the wasm preamble BEFORE
		// writing, and classify a non-wasm body as a retryable failure — the same
		// shape as an offline fetch, so it flows through #1536's cooldown ladder.
		if (!hasWasmMagic(data)) {
			return { ok: false, retryable: true, reason: describeNonWasmBody(data) };
		}
		// #1564 cheap check: a body shorter (or longer) than the server's own
		// declared Content-Length is a truncated/corrupted transfer, regardless
		// of whether a pinned hash exists for this grammar.
		const declaredLength = res.headers.get("content-length");
		if (declaredLength !== null) {
			const expectedBytes = Number.parseInt(declaredLength, 10);
			if (Number.isFinite(expectedBytes) && expectedBytes !== data.length) {
				return {
					ok: false,
					retryable: true,
					reason:
						`The download reported Content-Length: ${expectedBytes} but only ` +
						`${data.length} bytes arrived — a truncated transfer.`,
				};
			}
		}
		// #1564 primary check: verify the full body against the pinned sha256,
		// closing the gap Content-Length can't (a proxy that sets a matching
		// Content-Length on a truncated body, or a chunked response with none at
		// all). `manifest.grammars[filename]` is keyed by filename regardless of
		// override — an overridden grammar's hash was generated against the
		// override's own URL (`scripts/download-grammars.ts --write-manifest`
		// fetches via the same `SOURCE_OVERRIDES` map), so no extra alignment is
		// needed here. No entry (manifest missing, or a grammar added before the
		// manifest was regenerated) falls back to the Content-Length check above.
		const expectedHash = loadGrammarManifest()?.grammars[filename];
		if (expectedHash) {
			const actualHash = sha256Hex(data);
			if (actualHash !== expectedHash) {
				return {
					ok: false,
					retryable: true,
					reason:
						`The download's sha256 (${shortHash(actualHash)}) does not match the ` +
						`pinned manifest (${shortHash(expectedHash)}) — a corrupt or truncated transfer.`,
				};
			}
		}
		// bestEffort: false — a swallowed write failure would return true for a
		// grammar that never landed.
		writeFileAtomic(path.join(destDir, filename), data, { bestEffort: false });
		return { ok: true, retryable: true };
	} catch {
		// A thrown fetch (offline, DNS failure, aborted, ECONNRESET) or a write
		// failure is transient by construction — the CDN never got to answer.
		return { ok: false, retryable: true };
	}
}

/** Back-compat boolean-only wrapper for callers that only need pass/fail
 * (the postinstall script, prewarm-grammars test helper). */
export async function downloadGrammar(
	destDir: string,
	filename: string,
): Promise<boolean> {
	return (await downloadGrammarDetailed(destDir, filename)).ok;
}
