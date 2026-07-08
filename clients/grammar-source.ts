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

import * as fs from "node:fs";
import * as path from "node:path";

/** tree-sitter-wasms release the grammars are pulled from. */
export const TREE_SITTER_WASMS_VERSION = "0.1.13";

/** unpkg mirror of the tree-sitter-wasms artifacts. */
export const GRAMMAR_CDN_BASE = `https://unpkg.com/tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}/out`;

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
	return GRAMMAR_SOURCE_OVERRIDES[filename]?.url ?? `${GRAMMAR_CDN_BASE}/${filename}`;
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
export function currentGrammarRuntime(): GrammarRuntime {
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

/**
 * Fetch one grammar wasm into `destDir` (atomic via a temp file). Returns true
 * on success. Never throws — a failed fetch (offline, 4xx) degrades to "grammar
 * unavailable" so callers can decide how to handle it. A grammar that crashes the
 * runtime is protected at LOAD time (BLOCKED_GRAMMARS / grammarBlockReason), not
 * by refusing to download it.
 */
export async function downloadGrammar(
	destDir: string,
	filename: string,
): Promise<boolean> {
	try {
		fs.mkdirSync(destDir, { recursive: true });
		const res = await fetch(grammarSourceUrl(filename));
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = Buffer.from(await res.arrayBuffer());
		const tmp = path.join(destDir, `.${filename}.${process.pid}.tmp`);
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, path.join(destDir, filename));
		return true;
	} catch {
		return false;
	}
}
