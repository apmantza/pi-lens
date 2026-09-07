/**
 * ast-grep NAPI runner for dispatch system
 *
 * Uses @ast-grep/napi for programmatic parsing instead of CLI.
 * The languages it can serve are exactly the grammars that addon bundles —
 * see `NAPI_LANGUAGE_BINDINGS` for the matrix and for what the other twelve
 * catalog languages deliver through instead.
 *
 * Replaces CLI-based runners for faster performance (100x speedup).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "../../degradation-ledger.js";
import {
	type AstGrepNapi,
	loadAstGrepNapi,
	type SgRoot,
} from "../../deps/ast-grep-napi.js";
import { minimatch } from "../../deps/minimatch.js";
import { logLatency } from "../../latency-logger.js";
import { hasAuxiliaryLspPublishedForRoot } from "../../lsp/index.js";
import {
	clearPendingAuxiliaryCoverage,
	hasPendingAuxiliaryCoverage,
	recordNapiFallbackCoverage,
} from "../../lsp/pending-aux-coverage.js";
import {
	type AstGrepRuleSource,
	getAstGrepRuleSources,
} from "../../sgconfig.js";
import { hasEslintConfig } from "../../tool-policy.js";
import { enabledAuxiliaryLspServerIds } from "../auxiliary-lsp.js";
import { classifyDefect } from "../diagnostic-taxonomy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	calculateRuleComplexity,
	isOverlyBroadPattern,
	isStructuredRule,
	loadYamlRules,
	loadYamlRulesFresh,
	MAX_BLOCKING_RULE_COMPLEXITY,
	type YamlRule,
} from "./yaml-rule-parser.js";

const defaultUnsupportedLanguageLog = new Set<string>();
const UNSUPPORTED_RULE_ID_SAMPLE_SIZE = 5;

/** Clear per-session unsupported-language telemetry dedupe. */
export function resetAstGrepUnsupportedLanguageLog(): void {
	defaultUnsupportedLanguageLog.clear();
}

// Lazy load the napi package.
let sg: AstGrepNapi | undefined;
/**
 * In-flight load, shared by every caller (#1567). The per-edit fallback
 * runner and the session-start scanner (clients/project-diagnostics/scanner.ts)
 * both call `loadSg()` and can race. Pre-fix, the "attempted" flag was set
 * before the load and read by the SECOND caller as "already tried" while the
 * first load was still pending and about to succeed — a false-negative
 * STARVATION, not a duplicate load: the second caller got back `undefined`
 * for a load that was in flight and would have succeeded, not a second
 * redundant `import()`. Sharing one promise means every concurrent caller
 * observes the SAME outcome instead of a subset of them starving.
 *
 * Evicted on settle (#1536's pattern, see clients/tree-sitter-client.ts) — a
 * rejected load must not be remembered as the permanent answer; only
 * concurrent callers during the SAME attempt observe this promise.
 */
let sgLoadPromise: Promise<AstGrepNapi | undefined> | undefined;
/**
 * Set on ANY load failure and cleared only by `resetAstGrepNapiLoadState()`
 * at session_start (#1567 review round 2, F2).
 *
 * This holds for BOTH genuine and classified-transient failures, which is
 * narrower than the original design (a cooldown-then-retry for transient
 * failures within the same session). The reason: `loadAstGrepNapi()`
 * (clients/deps/ast-grep-napi.ts) resolves the addon to a `file://` URL and
 * dynamically `import()`s it. Node's ESM loader permanently memoizes a
 * module record that threw during evaluation — re-importing the SAME
 * resolved URL replays the cached rejection, it does not re-run the load.
 * A cooldown-then-retry loop would therefore call `loadAstGrepNapi()` again
 * after the cooldown and get back the identical cached rejection every
 * time: a retry that LOOKS like it tries again but structurally cannot
 * succeed within the process. Rather than ship that, every failure holds
 * until the next `session_start`, which is the point this cache can
 * actually be expected to have moved on (a fresh session re-arms the latch;
 * whether the underlying Node module cache also gets a fresh start depends
 * on whether the host recycles the process between sessions, but re-arming
 * the latch is the most this in-process code can honestly promise).
 */
let sgSessionHold = false;
/**
 * Why `sgSessionHold` was set — feeds the degradation-ledger message and log
 * line only. It does not change retry behavior: both classes hold
 * identically for the session, per `sgSessionHold`'s doc above.
 */
let sgHoldReason: "transient" | "genuine" | undefined;

/** A positively-identified, narrow errno family for a native-addon load: the
 * kind of momentary FS contention (too many open files, a file mid-write,
 * a transient permission/resource block) that says nothing durable about
 * whether the addon itself can load. Everything NOT in this allowlist is
 * genuine by default (#1567 review round 2, F1) — the original classifier
 * inverted this: it matched a handful of message patterns as "genuine" and
 * treated every OTHER error, including the real native-binding failure
 * family (ABI mismatch, a missing platform package, a napi version
 * mismatch, an unsupported arch), as transient. None of those recover on
 * their own; an unrecognized error is far more likely to be one of them
 * than a genuine FS hiccup. */
const TRANSIENT_ERRNO_ALLOWLIST = new Set([
	"EMFILE",
	"EBUSY",
	"EAGAIN",
	"EPERM",
	"ETXTBSY",
]);

/**
 * `@ast-grep/napi`'s own terminal "this machine cannot run this addon"
 * messages (from its `index.js` platform-detection shim). Already covered
 * by the genuine-by-default policy above; listed explicitly so the
 * classification is legible at the call site instead of an emergent
 * property of "didn't match the allowlist".
 */
const KNOWN_GENUINE_NATIVE_LOAD_MESSAGES = [
	/cannot find native binding/i,
	/failed to load native binding/i,
];

/**
 * Walk an error's `.cause` chain — Node/napi wrap the real dlopen/ABI
 * failure there rather than on the top-level thrown Error — collecting
 * every `code` and `message` seen along the way, so classification isn't
 * blind to a nested cause (#1567 review round 2, F1).
 */
function collectErrorChain(err: unknown): {
	codes: string[];
	messages: string[];
} {
	const codes: string[] = [];
	const messages: string[] = [];
	let current: unknown = err;
	const seen = new Set<unknown>();
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			messages.push(current.message);
			const code = (current as Error & { code?: unknown }).code;
			if (typeof code === "string") codes.push(code);
			current = (current as Error & { cause?: unknown }).cause;
		} else {
			messages.push(String(current));
			break;
		}
	}
	return { codes, messages };
}

/**
 * Classify a `loadAstGrepNapi()` rejection. Transient requires a positively
 * identified errno match somewhere in the cause chain AND no known-genuine
 * native-load message anywhere in that same chain (an errno wrapping a
 * "cannot find native binding" cause is genuine, not transient — the errno
 * describes how the OS reported it, not what actually failed). Everything
 * else — including an error with no `code` at all — is genuine.
 */
function classifyAstGrepLoadFailure(err: unknown): "transient" | "genuine" {
	const { codes, messages } = collectErrorChain(err);
	const hasKnownGenuineMessage = messages.some((message) =>
		KNOWN_GENUINE_NATIVE_LOAD_MESSAGES.some((pattern) => pattern.test(message)),
	);
	if (hasKnownGenuineMessage) return "genuine";
	const hasTransientErrno = codes.some((code) =>
		TRANSIENT_ERRNO_ALLOWLIST.has(code),
	);
	return hasTransientErrno ? "transient" : "genuine";
}

function recordAstGrepUnavailableOnce(reason: "transient" | "genuine"): void {
	recordDegradationOnce({
		kind: "ast-grep-napi-unavailable",
		subject: "ast-grep-napi",
		reason:
			reason === "genuine"
				? "native addon failed to load (durable for this session)"
				: "native addon load hit a transient error (durable for this session — see sgSessionHold doc)",
	});
}

export async function loadSg(): Promise<AstGrepNapi | undefined> {
	if (sg) return sg;
	if (sgLoadPromise) return sgLoadPromise;
	if (sgSessionHold) {
		// #1567 review F4: a held/degraded load must be distinguishable from a
		// clean scan that found nothing to report, not silently read as
		// "skipped/empty" by every caller (clients/project-diagnostics/scanner.ts,
		// this file's own runner) — otherwise the two are indistinguishable in
		// the degradation ledger.
		recordAstGrepUnavailableOnce(sgHoldReason ?? "genuine");
		return undefined;
	}

	const task = (async (): Promise<AstGrepNapi | undefined> => {
		try {
			const loaded = await loadAstGrepNapi();
			sg = loaded;
			return loaded;
		} catch (err) {
			const reason = classifyAstGrepLoadFailure(err);
			sgSessionHold = true;
			sgHoldReason = reason;
			recordAstGrepUnavailableOnce(reason);
			return undefined;
		}
	})();
	sgLoadPromise = task;
	// `task` never rejects (the IIFE catches), so the derived promise is inert;
	// `void` records that no consumer awaits it (oxlint no-floating-promises).
	void task.finally(() => {
		if (sgLoadPromise === task) sgLoadPromise = undefined;
	});
	return task;
}

/**
 * Re-arm the napi load latch for a new session (#1567). `sg` itself is left
 * alone — a successful load stays valid and cached for the process — but a
 * session hold (transient or genuine) is session-scoped state and must not
 * outlive the session that set it. Called from `resetDispatchBaselines()`
 * (clients/dispatch/integration.ts) beside `resetAstGrepUnsupportedLanguageLog`,
 * this module's other session latch.
 */
export function resetAstGrepNapiLoadState(): void {
	sgSessionHold = false;
	sgHoldReason = undefined;
}

/**
 * The in-process language matrix — ONE table describing every extension this
 * fallback admits, the `@ast-grep/napi` export that parses it, and the rule
 * `language:` token it scopes rules to. `canHandle`, `ruleLanguageForFile`,
 * `SUPPORTED_RULE_LANGUAGES`, and `getLang` all derive from it, so the four
 * hand-maintained lists that used to drift cannot disagree (#2215; the #883
 * derive-don't-hand-maintain pattern).
 *
 * `napiExport` is a CLAIM about the addon, not a fact. `getLang` resolves it
 * against the module that actually loaded, so the EFFECTIVE in-process set is
 * always this matrix intersected with the addon's real capabilities. The
 * addon's `Lang` export cannot be probed instead: at runtime it is an empty
 * object — the enum in `@ast-grep/napi/types/lang.d.ts` is type-only — so the
 * module's own language accessors ARE the capability surface. Probed against
 * 0.45.1 on 2026-08-26: `css html js jsx ts tsx` and nothing else, and
 * `registerDynamicLanguage` is called nowhere in this tree, so no grammar is
 * added at runtime.
 *
 * The routed extensions deliberately left OUT — `.vue`/`.svelte` (no grammar)
 * and `.less`/`.sass`/`.scss` (the css grammar is not validated against them)
 * — carry their reasons in `ast-grep-napi-language-coverage.test.ts`, which
 * reds when a newly registered `KIND_EXTENSIONS` entry is in neither list.
 */
interface NapiLanguageBinding {
	/** Lowercased rule `language:` token this grammar serves. */
	ruleLanguage: "typescript" | "tsx" | "javascript" | "css" | "html";
	/** Accessor on the loaded addon that parses it. */
	napiExport: "ts" | "tsx" | "js" | "css" | "html";
	/** `KIND_EXTENSIONS` members (clients/file-kinds.ts) this grammar parses. */
	extensions: readonly string[];
}

const NAPI_LANGUAGE_BINDINGS: readonly NapiLanguageBinding[] = [
	// `.mts`/`.cts` and `.mjs`/`.cjs` are the same two grammars under a
	// module-system-flavored extension; leaving them off the old hand list meant
	// the whole catalog went dark on every ES/CommonJS module file (#2215).
	{
		ruleLanguage: "typescript",
		napiExport: "ts",
		extensions: [".ts", ".mts", ".cts"],
	},
	{ ruleLanguage: "tsx", napiExport: "tsx", extensions: [".tsx"] },
	{
		ruleLanguage: "javascript",
		napiExport: "js",
		// `.jsx` stays on the `js` grammar it has always used here. The addon
		// also exports a separate `jsx`, but switching to it is a matching
		// change, not a coverage one, and belongs with its own fixtures.
		extensions: [".js", ".jsx", ".mjs", ".cjs"],
	},
	{ ruleLanguage: "css", napiExport: "css", extensions: [".css"] },
	{ ruleLanguage: "html", napiExport: "html", extensions: [".html", ".htm"] },
];

const BINDING_BY_EXTENSION = new Map<string, NapiLanguageBinding>(
	NAPI_LANGUAGE_BINDINGS.flatMap((binding) =>
		binding.extensions.map((ext) => [ext, binding] as const),
	),
);

const SUPPORTED_RULE_LANGUAGES: readonly string[] = NAPI_LANGUAGE_BINDINGS.map(
	(binding) => binding.ruleLanguage,
);

/**
 * Rule `language:` tokens the shipped catalog carries that NO bundled napi
 * grammar can parse. Their rules deliver through the ast-grep LSP/CLI, which
 * ships its own grammar set — never in-process. One shared reason, so this is
 * a list of decisions rather than twelve copies of a sentence: the addon
 * bundles six grammars (see `NAPI_LANGUAGE_BINDINGS`) and nothing registers
 * more at runtime.
 *
 * The LSP/CLI half of that claim is measured, not assumed: every entry below
 * was run through the real `ast-grep run -l <lang>` on 2026-08-26 and parsed,
 * with `cobol` as the negative control (`cobol is not supported!`, exit 2). So
 * no catalog language is unreachable by BOTH engines — the issue's
 * "genuinely missing" bucket is empty, and this list is a routing fact rather
 * than a coverage hole.
 *
 * This is the deliberate-exclusion half of the #2215 contract; the served half
 * is derived from the addon itself. `ast-grep-napi-language-coverage.test.ts`
 * reds when a catalog language with enabled rules is in neither half.
 */
export const AST_GREP_LSP_ONLY_RULE_LANGUAGES: readonly string[] = [
	"c",
	"cpp",
	"csharp",
	"go",
	"java",
	"kotlin",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"swift",
];

const LSP_ONLY_RULE_LANGUAGES = new Set(AST_GREP_LSP_ONLY_RULE_LANGUAGES);

export type RuleLanguageDeliveryRoute =
	| "napi"
	| "ast-grep-lsp-cli"
	| "unclassified";

/**
 * How a rule's declared language reaches the user. `unclassified` is the
 * runtime signal that the #2215 class regrew: rules ship for a language nobody
 * decided a delivery route for, so they may run nowhere at all.
 */
export function deliveryRouteForRuleLanguage(
	ruleLanguage: string,
): RuleLanguageDeliveryRoute {
	if (SUPPORTED_RULE_LANGUAGES.includes(ruleLanguage)) return "napi";
	return LSP_ONLY_RULE_LANGUAGES.has(ruleLanguage)
		? "ast-grep-lsp-cli"
		: "unclassified";
}

/**
 * Delivery route for one aggregated skip key. A `mismatch:<rule>-><file>` key
 * is a rule whose language this engine DOES serve and that simply isn't this
 * file's grammar, so it still routes through napi on its own files.
 */
function skipRouteFor(key: string): RuleLanguageDeliveryRoute {
	return key.startsWith("mismatch:")
		? "napi"
		: deliveryRouteForRuleLanguage(key);
}

/** Maximum matches per rule to prevent excessive false positives */
const MAX_MATCHES_PER_RULE = 10;

/** Maximum total diagnostics per file to prevent output spam */
const MAX_TOTAL_DIAGNOSTICS = 50;

/**
 * #660: this runner used to skip a hardcoded set of rule ids
 * (`constructor-super`, `empty-catch`, `long-parameter-list`,
 * `nested-ternary`, `no-dupe-class-members`) on the assumption that the
 * tree-sitter query runner (priority 14) already covered them, to avoid
 * double-reporting. That assumption was false for every entry: three of
 * them (`nested-ternary`, `long-parameter-list`, `no-dupe-class-members`)
 * have no active tree-sitter query — their would-be queries either live
 * under `rules/tree-sitter-queries/typescript-disabled/` (excluded from
 * loading, see clients/tree-sitter-query-loader.ts) or were never written —
 * so those three rule ids had ZERO coverage in the NAPI fallback runner
 * (used when the ast-grep binary isn't installed) despite having a
 * perfectly good, shipped, active ast-grep rule sitting right there. The
 * other two (`constructor-super`, `empty-catch`) are disabled everywhere
 * (ast-grep AND tree-sitter, see rules-disabled/, #206), so skipping them
 * was already a no-op. The whole skip-set has been removed; if tree-sitter
 * coverage is ever added back for one of these rule ids, reintroduce a
 * scoped skip alongside the query that actually covers it — don't recreate
 * a blanket assumption-based list.
 *
 * Note: `no-dupe-class-members` didn't actually fire immediately
 * post-removal — its rule YAML uses a top-level `utils:` block that this
 * runner's native-config passthrough dropped entirely, a separate bug
 * (affecting 5 shipped rules, not just this one) fixed in #663.
 */

/**
 * Rules commonly covered by ESLint/Biome correctness checks.
 * We can suppress these from ast-grep in lint-enabled projects to reduce noise.
 */
const LINTER_OVERLAP = new Set([
	"getter-return",
	"no-array-constructor",
	"no-async-promise-executor",
	"no-await-in-loop",
	"no-case-declarations",
	"no-compare-neg-zero",
	"no-cond-assign",
	"no-constant-condition",
	"no-constructor-return",
	"no-dupe-args",
	"no-dupe-keys",
	"no-extra-boolean-cast",
	"no-new-symbol",
	"no-new-wrappers",
	"no-prototype-builtins",
]);

const NON_SUPPRESSIBLE = new Set([
	"empty-catch",
	"no-discarded-error",
	"unchecked-throwing-call",
]);

function defaultFixSuggestion(defectClass: string, ruleId: string): string {
	if (defectClass === "silent-error") {
		return "Handle the error path explicitly: log context and rethrow or return a typed error result.";
	}
	if (defectClass === "secrets") {
		return "Remove hardcoded secret material and load values from env/secret manager.";
	}
	if (defectClass === "injection") {
		return "Avoid dynamic execution/interpolation here; use parameterized APIs or strict allowlists.";
	}
	if (defectClass === "async-misuse") {
		return "Make async flow explicit: await consistently and handle rejection/error paths.";
	}
	if (ruleId.includes("unsafe") || ruleId.includes("security")) {
		return "Refactor to a safer API usage with explicit validation and bounded behavior.";
	}
	return "Refactor this pattern to the safer equivalent used in the codebase.";
}

function explicitRuleFixSuggestion(rule: YamlRule): string | undefined {
	const raw = (rule.fix ?? rule.note ?? "").trim();
	if (!raw) return undefined;
	const oneLine = raw.replace(/\s+/g, " ").trim();
	return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

function normalizeRuleId(ruleId: string): string {
	return ruleId.replace(/-js$/, "");
}

/**
 * `filePath` relative to `root`, forward-slashed, for matching a rule's
 * `ignores` globs (#965). Falls back to the absolute (slash-normalized) path
 * when `filePath` isn't under `root` (e.g. an out-of-tree temp file), so a
 * glob like `scripts/**` simply never matches rather than throwing.
 */
function relativeForIgnoreGlob(filePath: string, root: string): string {
	const rel = path.relative(root, filePath);
	return (rel.startsWith("..") ? filePath : rel).split(path.sep).join("/");
}

function matchesRuleIgnores(
	filePath: string,
	root: string,
	patterns: string[] | undefined,
): boolean {
	if (!patterns || patterns.length === 0) return false;
	const rel = relativeForIgnoreGlob(filePath, root);
	return patterns.some((pattern) => minimatch(rel, pattern, { dot: true }));
}

export function canHandle(filePath: string): boolean {
	return BINDING_BY_EXTENSION.has(path.extname(filePath).toLowerCase());
}

/**
 * The TypeScript grammar is a syntactic superset of JavaScript, so a
 * `JavaScript`-tagged rule using generic node kinds (`variable_declarator`,
 * `assignment_expression`, …) still matches against a parsed `.ts` root
 * — and vice versa isn't an issue since JS files never parse
 * TS-only syntax, but a `TypeScript`-tagged rule with a plain-JS-compatible
 * body would equally double-fire alongside a `JavaScript` twin on a `.ts`
 * file. Without this, `language:` reads as a real filter but isn't one for
 * ts↔js pairs, so twin rules sharing a base name (e.g. `hardcoded-url` /
 * `hardcoded-url-js`) both match the same construct in the SAME runner
 * invocation (#657). TSX is its own grammar here too — the primary
 * ast-grep CLI/LSP also treats `tsx` as distinct from `typescript` — but
 * the caller's language-match check adds ONE deliberate exception on top
 * of the exact-match rule: a `TypeScript`-tagged rule also runs against
 * a `.tsx` file's fileLang (#1608). This is grounded empirically, not by
 * analogy — tsx's grammar is a syntactic superset of typescript's for
 * every construct the shipped catalog's rules target (JSX productions
 * added, plus the removal of the `<T>expr` cast form, which cannot
 * appear in valid `.tsx` source), and every `language: TypeScript`
 * rule's fixture-test `invalid:` snippet is asserted to still match
 * parsed as tsx (ast-grep-tsx-coverage.test.ts) rather than assumed.
 * Without this exception the entire TS ruleset silently never runs on
 * `.tsx` files. `TSX`-tagged rules stay `.tsx`-exclusive; the exception
 * is TS→TSX only. Returns undefined for an extension outside the matrix.
 */
export function ruleLanguageForFile(
	filePath: string,
): NapiLanguageBinding["ruleLanguage"] | undefined {
	return BINDING_BY_EXTENSION.get(path.extname(filePath).toLowerCase())
		?.ruleLanguage;
}

/**
 * The grammar for `filePath` on the addon that actually loaded, or undefined
 * when there is none.
 *
 * Both callers (this file's runner and clients/project-diagnostics/scanner.ts)
 * gate on `canHandle` first, so an undefined return HERE means the matrix
 * admitted the file and the addon then dropped it — the silent skip #2215 is
 * about, which is why it records instead of just returning. An extension
 * outside the matrix was never admitted, so it records nothing.
 */
export function getLang(filePath: string, sgModule: AstGrepNapi) {
	const binding = BINDING_BY_EXTENSION.get(
		path.extname(filePath).toLowerCase(),
	);
	if (!binding) return undefined;
	const lang = sgModule[binding.napiExport];
	if (!lang) {
		recordDegradationOnce({
			kind: "ast-grep-napi-language-unavailable",
			subject: binding.ruleLanguage,
			reason: `@ast-grep/napi exposes no "${binding.napiExport}" grammar; every ${binding.ruleLanguage} rule is skipped in-process this session`,
		});
	}
	return lang;
}

/** Per-edit defaults — tuned to keep inline output bounded on a broken file. */
export interface AstGrepEvaluateOptions {
	/** Drop non-error rules and complexity-bounded blocking rules (per-edit blocking pass). */
	blockingOnly?: boolean;
	/** Cap matches kept per rule (default {@link MAX_MATCHES_PER_RULE}). */
	maxMatchesPerRule?: number;
	/** Cap total diagnostics per file (default {@link MAX_TOTAL_DIAGNOSTICS}). */
	maxTotalDiagnostics?: number;
	/** Workspace root that owns project-local rules; defaults to `cwd`. */
	projectRoot?: string;
	/**
	 * Optional sink for a rule that napi's native engine rejected outright
	 * (malformed shape, unresolved `matches: <name>` reference, invalid kind,
	 * …). Without this, a rule failure is swallowed as "zero diagnostics"
	 * indistinguishable from "the rule legitimately found nothing" (#663).
	 * Best-effort only — never let a logging failure affect matching.
	 */
	log?: (message: string) => void;
	/** Rule ids already reported as unsupported by the surrounding scan/run. */
	unsupportedLanguageLog?: Set<string>;
	/**
	 * Original file content. Required together with `sgModule` for embedded
	 * `<script>` coverage on HTML (#2347): every `script_element` body is
	 * parsed as JavaScript and `language: JavaScript` rules run against those
	 * bodies, mirroring the ast-grep CLI/LSP (ast-grep 0.45.1 injects every
	 * script body regardless of `type`/`src`; verified by direct CLI repro).
	 * Absent on a non-HTML file this is unused and irrelevant.
	 */
	content?: string;
	/** Loaded addon, required with `content` to parse script bodies (#2347). */
	sgModule?: AstGrepNapi;
}

/**
 * One embedded `<script>` body of an HTML file, already parsed as JavaScript
 * (#2347). `root` is body-relative; findings must be translated back to the
 * original file with `startIndex` plus the file's line-start table.
 */
export interface HtmlScriptInjection {
	/** The JavaScript body exactly as it appears in the file. */
	body: string;
	/**
	 * UTF-16 code-unit index of `body`'s first character within the original
	 * file. `@ast-grep/napi`'s `Pos.index` is a UTF-16 code-unit offset (not a
	 * byte offset — verified against 0.45.1 with multibyte content), so the
	 * translation keeps one unit everywhere and never mixes units.
	 */
	startIndex: number;
	/** Root of `body` parsed with the addon's JavaScript grammar. */
	root: { findAll(config: never): unknown[] };
}

/**
 * Budget for embedded-`<script>` evaluation (#2347 review F2/F4). Every nonempty
 * script body is reparsed as JS and EVERY `language: JavaScript` rule runs
 * against it, so the work is `rules * bodies * body-size`, all multiplied by
 * the native addon's per-call overhead. Measured on this seam (full catalog,
 * real addon, 2026-08-30): ~8.5 ms per small body, ~9 s for 500 blocks, and
 * ~19.5 s for one ~1 MiB dense body (the shape that made the byte axis the
 * real bound). The caps apply to EVERY body — first one included — so an
 * oversized single inline script is omitted and recorded like any other
 * over-budget body. Hand-authored HTML carries a handful of small inline
 * scripts, so the caps only ever trip on generated/pathological pages, where a
 * bounded, recorded partial evaluation beats a seconds-long synchronous stall
 * on the per-edit hook. Budget truncation is a coverage loss and is recorded
 * (see `emitHtmlScriptDegradations`).
 */
export const MAX_SCRIPT_BODIES_EVALUATED = 64;
/**
 * Cumulative parsed script-body size cap; bounds the `rules * bytes` work.
 * Every body — including the first — must fit within the running total.
 */
export const MAX_SCRIPT_BODY_BYTES_EVALUATED = 128 * 1024;

/**
 * The outcome of {@link collectHtmlScriptInjections}. Beyond the parsed
 * injections it carries every bounded count the evaluation seam needs to
 * preserve raw coverage evidence and surface silent failure modes (#2347
 * review F3): a coverage engine that reports "no findings" must be able to say
 * whether that was genuine, a budget cut, or a parser failure.
 */
export interface HtmlScriptCollectionResult {
	/** Script bodies that were parsed and are ready for rule matching. */
	injections: HtmlScriptInjection[];
	/**
	 * RAW number of `script_element` nodes found in the HTML file, before any
	 * whitespace skip or budget cut. This is the count coverage evidence must
	 * preserve: a reader comparing it against `bodiesEvaluated` and
	 * `truncatedBodies` can reconstruct exactly what was and was not scanned.
	 */
	scriptElementCount: number;
	/** Number of script bodies actually evaluated (post-budget, pre-failures). */
	bodiesEvaluated: number;
	/** Number of nonempty bodies dropped by the evaluation budget. */
	truncatedBodies: number;
	/** Number of evaluated bodies the JS grammar itself refused to parse. */
	parseFailures: number;
	/** True when the loaded addon exposes no `js` grammar. */
	missingJsGrammar: boolean;
	/** True when the `script_element` scan of the HTML root threw. */
	htmlScanFailure: boolean;
}

/**
 * UTF-16 code-unit indexes, in the original file, of every line start, newest
 * line last. `@ast-grep/napi` reports line/column/index in UTF-16 code units
 * (verified against 0.45.1 with `é` and emoji), so the line table must be
 * built in the SAME unit; a UTF-8 byte walk would shift every coordinate that
 * follows a multibyte character.
 */
function computeLineStartsUtf16(content: string): number[] {
	const starts: number[] = [0];
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 0x0a) starts.push(i + 1);
	}
	return starts;
}

/** 0-based line and code-unit column for a UTF-16 index, via binary search. */
function filePositionForIndex(
	lineStarts: number[],
	index: number,
): { line: number; column: number } {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStarts[mid] <= index) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo, column: index - lineStarts[lo] };
}

/**
 * Extract every `<script>` body from an HTML root and parse it as JavaScript
 * (#2347). Mirrors the ast-grep CLI/LSP: the injection is unconditional —
 * `type` and `src` attributes do not suppress it (verified against the 0.45.1
 * CLI with `text/template`, `application/ld+json`, and `src`-bearing script
 * tags, all injected). Whitespace-only bodies are skipped (nothing to match).
 * A body the JS grammar cannot parse is dropped the way an unparseable `.js`
 * file would be; the failure is counted, never silent. The evaluation budget
 * (count + cumulative bytes) is applied BEFORE any grammar parse. The caller
 * emits the bounded degradation records from the result — collection stays
 * pure so the count evidence is directly testable.
 */
export function collectHtmlScriptInjections(
	htmlRoot: {
		findAll(config: unknown): unknown[];
	},
	sgModule: AstGrepNapi,
): HtmlScriptCollectionResult {
	// SAFETY: `AstGrepNapi` is the loaded addon module's own (typed) shape, so
	// its `js` accessor is guaranteed present while the addon lives; this
	// narrowing only names the subshape this helper consumes (a `js` grammar
	// whose parses expose `findAll`), and the absence check right below
	// degrades to "no embedded coverage" rather than throwing when the addon
	// ever drops the grammar.
	const addon = sgModule as unknown as {
		js?: {
			parse(src: string): { root(): { findAll(config: never): unknown[] } };
		};
	};
	if (!addon.js) {
		return {
			injections: [],
			scriptElementCount: 0,
			bodiesEvaluated: 0,
			truncatedBodies: 0,
			parseFailures: 0,
			missingJsGrammar: true,
			htmlScanFailure: false,
		};
	}
	let scripts: Array<{
		children(): Array<{
			kind(): string;
			range(): { start: { index: number } };
			text(): string;
		}>;
	}>;
	try {
		scripts = htmlRoot.findAll({ rule: { kind: "script_element" } }) as never;
	} catch {
		return {
			injections: [],
			scriptElementCount: 0,
			bodiesEvaluated: 0,
			truncatedBodies: 0,
			parseFailures: 0,
			missingJsGrammar: false,
			htmlScanFailure: true,
		};
	}

	// Extract every nonempty body first (text extraction is cheap) so the raw
	// script-element count is exact, then apply the budget BEFORE parsing any
	// of them.
	let scriptElementCount = 0;
	const candidates: Array<{ body: string; startIndex: number }> = [];
	for (const element of scripts) {
		scriptElementCount += 1;
		let raw:
			| {
					kind(): string;
					range(): { start: { index: number } };
					text(): string;
			  }
			| undefined;
		for (const child of element.children()) {
			if (child.kind() === "raw_text") {
				raw = child;
				break;
			}
		}
		if (!raw) continue;
		const body = raw.text();
		if (!body.trim()) continue;
		candidates.push({
			body,
			startIndex: raw.range().start.index,
		});
	}
	let budgetedBytes = 0;
	const selected: Array<{ body: string; startIndex: number }> = [];
	let truncatedBodies = 0;
	for (const candidate of candidates) {
		const bytes = Buffer.byteLength(candidate.body, "utf8");
		// EVERY body must fit inside both caps — including the first. There is
		// no "one big script" allowance: a single over-cap body (a ~1 MiB dense
		// inline script measured 19.5 s of synchronous rule traversal on this
		// seam) is omitted like any other over-budget body, and the omission is
		// recorded via `truncatedBodies`, so the bounded
		// `ast-grep-napi-html-script-budget` degradation record always explains
		// why that file lost embedded coverage.
		if (
			selected.length >= MAX_SCRIPT_BODIES_EVALUATED ||
			budgetedBytes + bytes > MAX_SCRIPT_BODY_BYTES_EVALUATED
		) {
			truncatedBodies += 1;
			continue;
		}
		selected.push(candidate);
		budgetedBytes += bytes;
	}

	const injections: HtmlScriptInjection[] = [];
	let parseFailures = 0;
	for (const candidate of selected) {
		try {
			const root = addon.js.parse(candidate.body).root();
			injections.push({
				body: candidate.body,
				startIndex: candidate.startIndex,
				root,
			});
		} catch {
			parseFailures += 1;
		}
	}
	return {
		injections,
		scriptElementCount,
		bodiesEvaluated: selected.length,
		truncatedBodies,
		parseFailures,
		missingJsGrammar: false,
		htmlScanFailure: false,
	};
}

/**
 * Emit bounded, discriminating degradation records for every embedded-script
 * coverage loss (#2347 review F3). Each failure mode keeps its own kind so the
 * ledger answers WHICH failure and WHICH file; subjects are the normalized file
 * path, bounded by the ledger's own per-kind window. Collection failures
 * (`missingJsGrammar`, `htmlScanFailure`) are once-per-file-per-session
 * categorical events; parse failures and budget truncation are counted per file
 * so the EXACT totals survive past the retained-entry window.
 */
function emitHtmlScriptDegradations(
	filePath: string,
	result: HtmlScriptCollectionResult,
): void {
	if (result.missingJsGrammar) {
		recordDegradationOnce({
			kind: "ast-grep-napi-html-js-grammar-missing",
			subject: filePath,
			reason: "addon exposes no js grammar; embedded <script> coverage dropped",
		});
	}
	if (result.htmlScanFailure) {
		recordDegradationOnce({
			kind: "ast-grep-napi-html-script-scan-failed",
			subject: filePath,
			reason:
				"script_element enumeration failed; embedded <script> coverage dropped",
		});
	}
	if (result.parseFailures > 0) {
		incrementDegradationCount({
			kind: "ast-grep-napi-html-script-parse-failed",
			subject: filePath,
			reason: `${result.parseFailures} of ${result.bodiesEvaluated} script bodies refused to parse as JS`,
			metadata: {
				scriptElementCount: result.scriptElementCount,
				parseFailures: result.parseFailures,
			},
		});
	}
	if (result.truncatedBodies > 0) {
		incrementDegradationCount({
			kind: "ast-grep-napi-html-script-budget",
			subject: filePath,
			reason: `script budget truncated coverage: ${result.bodiesEvaluated}/${result.scriptElementCount} bodies evaluated, ${result.truncatedBodies} dropped`,
			metadata: {
				scriptElementCount: result.scriptElementCount,
				bodiesEvaluated: result.bodiesEvaluated,
				truncatedBodies: result.truncatedBodies,
			},
		});
	}
}

function duplicateRuleIds(rules: YamlRule[]): string[] {
	const counts = new Map<string, number>();
	for (const rule of rules) {
		counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
	}
	return Array.from(counts)
		.filter(([, count]) => count > 1)
		.map(([id]) => id)
		.sort((a, b) => a.localeCompare(b));
}

function appendDuplicateRuleDiagnostics(
	diagnostics: Diagnostic[],
	seenRuleIds: Set<string>,
	duplicateIds: string[],
	source: AstGrepRuleSource,
	filePath: string,
	maxTotalDiagnostics: number,
): boolean {
	const sourceLabel = `${source.origin} ${source.tier} rules`;
	for (const ruleId of duplicateIds) {
		diagnostics.push({
			id: `ast-grep-napi-config-duplicate-${source.origin}-${source.tier}-${ruleId}`,
			message: `Duplicate ast-grep rule id "${ruleId}" in ${sourceLabel}`,
			filePath,
			line: 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "ast-grep-napi",
			rule: ruleId,
			defectClass: "correctness",
			fixable: false,
			autoFixAvailable: false,
			fixSuggestion: `Give every rule in ${sourceLabel} a unique id`,
		});
		seenRuleIds.add(ruleId);
		if (diagnostics.length >= maxTotalDiagnostics) return true;
	}
	return false;
}

/**
 * The four tiers `Diagnostic.severity` accepts (clients/dispatch/types.ts).
 * `YamlRule.severity` is a free-form string straight off disk, so an unknown
 * or missing value must land somewhere deliberate rather than being cast.
 */
const DIAGNOSTIC_SEVERITY_TIERS = new Set<Diagnostic["severity"]>([
	"error",
	"warning",
	"info",
	"hint",
]);

/**
 * Map a rule's declared YAML severity onto a `Diagnostic.severity` tier (#1777).
 *
 * A rule that declares nothing, or declares a value pi-lens does not model
 * (ast-grep also accepts `off`), falls back to `warning` — the tier every such
 * rule already reported at before #1777, so reviving hint/info never silently
 * demotes an existing rule.
 */
export function normalizeRuleSeverity(
	raw: string | undefined,
): Diagnostic["severity"] {
	const tier = raw as Diagnostic["severity"] | undefined;
	return tier && DIAGNOSTIC_SEVERITY_TIERS.has(tier) ? tier : "warning";
}

/**
 * Run the shipped ast-grep YAML ruleset against a parsed file via napi's native
 * engine, applying the same suppression policy (linter/tree-sitter overlap,
 * overly-broad-pattern guard) as the per-edit runner. Extracted so the
 * project-wide scanner can reuse the identical engine + rules WITHOUT the
 * ast-grep binary — closing the no-binary gap (#308) — while the per-edit runner
 * keeps its tight budgets. Callers pass the already-parsed `rootNode` so they
 * control parsing/size gating.
 */
export function evaluateAstGrepRules(
	filePath: string,
	rootNode: { findAll(config: never): unknown[] },
	cwd: string,
	kind: string | undefined,
	options: AstGrepEvaluateOptions = {},
): Diagnostic[] {
	const maxMatchesPerRule = options.maxMatchesPerRule ?? MAX_MATCHES_PER_RULE;
	const maxTotalDiagnostics =
		options.maxTotalDiagnostics ?? MAX_TOTAL_DIAGNOSTICS;
	const blockingOnly = options.blockingOnly === true;
	const log = options.log;
	const unsupportedLanguageLog =
		options.unsupportedLanguageLog ?? defaultUnsupportedLanguageLog;

	const diagnostics: Diagnostic[] = [];
	const seenRuleIds = new Set<string>();
	const suppressLinterOverlap = kind === "jsts" && hasEslintConfig(cwd);
	const fileLang = ruleLanguageForFile(filePath);
	// Embedded `<script>` coverage (#2347): on an HTML file, every script body
	// is parsed as JavaScript and `language: JavaScript` rules run inside it —
	// the exact behavior the ast-grep CLI/LSP has (verified against 0.45.1).
	// `content` + `sgModule` are only needed for HTML; other callers of this
	// shared seam (the per-edit runner and the project scanner both now pass
	// them) cost a no-op on non-HTML files. The collection is budget-bounded
	// and every silent-failure mode plus the budget cut is recorded, so "no
	// embedded findings" stays distinguishable from "coverage was dropped"
	// (#2347 review F2/F3).
	const htmlCollection: HtmlScriptCollectionResult =
		fileLang === "html" &&
		options.content !== undefined &&
		options.sgModule !== undefined
			? collectHtmlScriptInjections(
					rootNode as { findAll(config: unknown): unknown[] },
					options.sgModule,
				)
			: {
					injections: [],
					scriptElementCount: 0,
					bodiesEvaluated: 0,
					truncatedBodies: 0,
					parseFailures: 0,
					missingJsGrammar: false,
					htmlScanFailure: false,
				};
	const htmlInjections = htmlCollection.injections;
	emitHtmlScriptDegradations(filePath, htmlCollection);
	// UTF-16 code-unit index of each line start in the ORIGINAL file, used to
	// translate an injected match's body-relative UTF-16 index back to file
	// line/column. The unit matters: napi positions are UTF-16, so a UTF-8 byte
	// table would shift every coordinate after a multibyte character (#2347
	// review F1).
	const fileLineStarts =
		htmlInjections.length > 0 && options.content !== undefined
			? computeLineStartsUtf16(options.content)
			: [];
	// Unsupported-language skips are expected in bulk (every non-jsts rule in the
	// catalog, e.g. ~30 Python rules) — aggregate them into ONE latency-log entry
	// per evaluation instead of per-rule terminal lines (#282 follow-up).
	const newlyUnsupported = new Map<string, string[]>();
	const flushUnsupportedRuleSkips = (): void => {
		if (newlyUnsupported.size === 0) return;
		const firstSeenLanguages = Array.from(newlyUnsupported.entries()).filter(
			([language]) => !unsupportedLanguageLog.has(language),
		);
		for (const [language] of firstSeenLanguages) {
			unsupportedLanguageLog.add(language);
		}
		if (firstSeenLanguages.length === 0) {
			newlyUnsupported.clear();
			return;
		}
		for (const [language] of firstSeenLanguages)
			unsupportedLanguageLog.add(language);
		logLatency({
			type: "phase",
			phase: "astgrep_napi_unsupported_rules_skipped",
			filePath,
			durationMs: 0,
			metadata: {
				skippedByLanguage: Object.fromEntries(
					firstSeenLanguages.map(([language, ruleIds]) => [
						language,
						{
							count: ruleIds.length,
							ruleIds: ruleIds.slice(0, UNSUPPORTED_RULE_ID_SAMPLE_SIZE),
							// #2215: a skip count alone says a rule did not run and
							// nothing about whether it runs anywhere else. `route` names
							// the delivery path (`ast-grep-lsp-cli` for the twelve
							// grammar-less catalog languages); `unclassified` means rules
							// ship for a language nobody decided a route for, which is the
							// class this issue closed regrowing.
							route: skipRouteFor(language),
							// #2347 observability: on an HTML file the per-language skip
							// count is only part of the picture — `mismatch:*->html`
							// entries name a rule family that never enters scripts, and
							// `htmlInlineScriptCount` says whether the file offered any
							// script bodies to enter. A `javascript->html` mismatch here
							// is necessarily `0` (JS rules RUN when scripts exist), so the
							// field makes "no injection target" distinguishable from the
							// same key on a plain non-HTML file, keeping the residual
							// coverage gap countable in production.
							...(fileLang === "html"
								? { htmlInlineScriptCount: htmlInjections.length }
								: {}),
						},
					]),
				),
			},
		});
		newlyUnsupported.clear();
	};

	// Shared with the raw sgconfig materializer so both surfaces walk the same
	// workspace-rooted sources in the same precedence order.
	const ignoreRoot = options.projectRoot ?? cwd;
	const ruleSources = getAstGrepRuleSources(ignoreRoot);

	for (const source of ruleSources) {
		let rules: YamlRule[];
		try {
			// Project rules are mutable during a session, so their cache fingerprints
			// relative paths and contents. Bundled catalogs are immutable per install.
			const loader =
				source.origin === "project" ? loadYamlRulesFresh : loadYamlRules;
			rules = loader(source.dir);
		} catch {
			continue;
		}

		const duplicates = duplicateRuleIds(rules);
		if (
			appendDuplicateRuleDiagnostics(
				diagnostics,
				seenRuleIds,
				duplicates,
				source,
				filePath,
				maxTotalDiagnostics,
			)
		) {
			flushUnsupportedRuleSkips();
			return diagnostics;
		}
		const duplicateSet = new Set(duplicates);

		for (const rule of rules) {
			if (duplicateSet.has(rule.id)) continue;
			// Cross-layer collisions keep the first (higher-precedence) source.
			if (seenRuleIds.has(rule.id)) continue;
			seenRuleIds.add(rule.id);
			if (blockingOnly && rule.severity !== "error") continue;
			// Per-rule path carve-out (#965): a rule that's noise on CLI scripts or
			// a project's own logging sink (e.g. no-console-except-error firing
			// inside scripts/** or lib/logger.ts) opts out via `ignores`.
			if (matchesRuleIgnores(filePath, ignoreRoot, rule.ignores)) continue;

			if (
				suppressLinterOverlap &&
				LINTER_OVERLAP.has(normalizeRuleId(rule.id)) &&
				!NON_SUPPRESSIBLE.has(normalizeRuleId(rule.id))
			) {
				continue;
			}

			// Skip rules whose top-level pattern is overly broad ($NAME, $X, etc.)
			// without additional structural constraints to narrow matches.
			if (
				rule.rule &&
				isOverlyBroadPattern(rule.rule.pattern) &&
				!isStructuredRule(rule)
			) {
				continue;
			}

			// CSS and HTML rules are scoped to their parsed roots.
			// Without this scope, language-tagged rules scan unrelated roots.
			// The file-language mismatch check below enforces this scope.
			// CSS rules therefore run only on CSS roots.
			// This preserves CSS rule findings while avoiding unrelated scans.
			// The fallback and LSP paths share the same parsed-language scope.
			const lang = rule.language?.toLowerCase();
			if (lang && !SUPPORTED_RULE_LANGUAGES.includes(lang)) {
				if (!unsupportedLanguageLog.has(lang)) {
					const ids = newlyUnsupported.get(lang) ?? [];
					ids.push(rule.id);
					newlyUnsupported.set(lang, ids);
				}
				continue;
			}
			// Scope TypeScript/JavaScript-tagged rules to the file's actual
			// grammar (#657) — otherwise a `-js` twin sharing generic node
			// kinds with its TS sibling double-fires on every .ts file. TSX
			// is the one deliberate exception (#1608): the tsx grammar is a
			// syntactic superset of typescript's for every non-JSX construct
			// (the `<T>expr` cast form is the only TS-only production, and
			// it can't appear in valid .tsx source anyway), so a
			// `language: TypeScript` rule still matches a tsx-parsed root
			// and must run there too, or the entire TS ruleset (120 of 263
			// rules) goes dark on every .tsx file. `language: TSX` rules
			// stay tsx-exclusive — they're already scoped to fileLang
			// "tsx" by the exact-match check.
			// #2347: `language: JavaScript` rules run INSIDE an HTML file's
			// embedded `<script>` bodies instead of being filtered out as a
			// language mismatch — that filter is what closed napi's embedded
			// coverage entirely while the ast-grep CLI/LSP resolves the
			// injections itself. Only when the file has at least one inline
			// script body; with none, a `javascript->html` rule stays a
			// genuine mismatch with nothing to run against (countable via
			// `htmlInlineScriptCount` in the skip record).
			const runsInsideHtmlScript =
				fileLang === "html" &&
				lang === "javascript" &&
				htmlInjections.length > 0;
			if (lang && fileLang && lang !== fileLang) {
				const runsAsTsOnTsx = fileLang === "tsx" && lang === "typescript";
				if (!runsAsTsOnTsx && !runsInsideHtmlScript) {
					const key = `mismatch:${lang}->${fileLang}`;
					if (!unsupportedLanguageLog.has(key)) {
						const ids = newlyUnsupported.get(key) ?? [];
						ids.push(rule.id);
						newlyUnsupported.set(key, ids);
					}
					continue;
				}
			}

			if (blockingOnly && rule.rule) {
				const complexity = calculateRuleComplexity(rule.rule);
				if (complexity > MAX_BLOCKING_RULE_COMPLEXITY) {
					continue;
				}
			}

			if (!rule.rule) continue;

			try {
				// A `language: JavaScript` rule on an HTML file with inline
				// scripts runs against EACH parsed script body; every other rule
				// runs against the file root. `scope.position` maps a match onto
				// 0-based FILE line/column — injection matches are body-relative
				// and must be translated via the injection's `startIndex` and the
				// file's line-start table, all in UTF-16 code units (#2347); the
				// file-root scope is the node's own range, so its derived
				// id/diagnostic stay byte-identical to the pre-#2347 path.
				const scopes: Array<{
					root: { findAll(config: never): unknown[] };
					position(match: unknown): { line: number; column: number };
				}> = runsInsideHtmlScript
					? htmlInjections.map((injection) => ({
							root: injection.root,
							position(match) {
								const start = (
									match as {
										range(): {
											start: { line: number; column: number; index: number };
										};
									}
								).range().start;
								return filePositionForIndex(
									fileLineStarts,
									injection.startIndex + start.index,
								);
							},
						}))
					: [
							{
								root: rootNode,
								position(match) {
									const start = (
										match as {
											range(): { start: { line: number; column: number } };
										}
									).range().start;
									return { line: start.line, column: start.column };
								},
							},
						];

				// Delegate matching to napi's native engine, which handles the
				// full ast-grep rule grammar (pattern, kind, has/inside/follows/
				// precedes/stopBy/field/nthChild, any/all/not) plus metavariable
				// `constraints` (#206) AND top-level `utils` — reusable named
				// matchers referenced via `matches: <name>` inside `rule`
				// (#663; `NapiConfig.utils: Record<string, Rule>` per
				// @ast-grep/napi's types, same shape napi already expects for
				// `rule`/`constraints`). A faithful js-yaml parse feeds the rule
				// object straight through. If napi rejects the rule for a scope
				// (a malformed or invalid-kind rule, or an unresolved `matches:`
				// reference), skip that scope — never silently match nothing
				// through a partial interpreter. The reject log fires once per
				// rule; a grammar-level rejection is uniform across scopes.
				const nativeConfig: Record<string, unknown> = { rule: rule.rule };
				if (rule.constraints) nativeConfig.constraints = rule.constraints;
				if (rule.utils) nativeConfig.utils = rule.utils;
				const collected: Array<{
					match: unknown;
					position: { line: number; column: number };
				}> = [];
				let rejectLogged = false;
				for (const scope of scopes) {
					let found: unknown[];
					try {
						found = scope.root.findAll(nativeConfig as never);
					} catch (err) {
						if (!rejectLogged) {
							rejectLogged = true;
							log?.(
								`ast-grep-napi: rule "${rule.id}" rejected by native engine (${
									err instanceof Error ? err.message : String(err)
								})`,
							);
						}
						continue;
					}
					for (const match of found) {
						if (collected.length >= maxMatchesPerRule) break;
						collected.push({ match, position: scope.position(match) });
					}
					if (collected.length >= maxMatchesPerRule) break;
				}

				for (const { position } of collected) {
					if (diagnostics.length >= maxTotalDiagnostics) break;

					// #1777: carry the rule's own tier through. The old collapse
					// (`=== "error" ? "error" : "warning"`) erased hint and info,
					// so the quiet tier the #1727 anti-slop rules ship at did not
					// exist anywhere downstream. `Diagnostic.severity` has been
					// 4-valued all along (clients/dispatch/types.ts). The BLOCKING
					// gate is unchanged and deliberately narrower: only `error`
					// blocks, so hint and info stay advisory exactly like warning.
					const severity = normalizeRuleSeverity(rule.severity);
					const semantic = severity === "error" ? "blocking" : "warning";
					const defectClass = classifyDefect(
						rule.id,
						"ast-grep-napi",
						rule.message || rule.id,
					);
					const ruleFix = explicitRuleFixSuggestion(rule);

					diagnostics.push({
						id: `ast-grep-napi-${position.line}-${rule.id}`,
						message: `[${rule.metadata?.category || "slop"}] ${rule.message || rule.id}`,
						filePath,
						line: position.line + 1,
						column: position.column + 1,
						severity,
						semantic,
						tool: "ast-grep-napi",
						rule: rule.id,
						defectClass,
						fixable: !!ruleFix,
						autoFixAvailable: false,
						fixKind: ruleFix ? "suggestion" : undefined,
						fixSuggestion:
							semantic === "blocking"
								? (ruleFix ?? defaultFixSuggestion(defectClass, rule.id))
								: ruleFix,
					});
				}

				if (diagnostics.length >= maxTotalDiagnostics) break;
			} catch {
				// Rule failed, skip
			}
		}
	}

	flushUnsupportedRuleSkips();
	return diagnostics;
}

// --- Runner Definition ---

const astGrepNapiRunner: RunnerDefinition = {
	id: "ast-grep-napi",
	appliesTo: ["jsts", "css", "html"],
	priority: PRIORITY.SPECIALIZED_ANALYSIS,
	skipTestFiles: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		if (!canHandle(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// #239 Phase 2: the ast-grep LSP supersedes this in-process runner when its
		// binary is available — same Rust engine, plus codeAction fixes, and it runs
		// the shipped baseline ruleset via `--config`. Skip here so we don't double-
		// report against the LSP's `tool: ast-grep` diagnostics. Resume ONLY as the
		// fallback when the binary is absent / can't spawn (Gate B).
		const astGrepLspEnabled = enabledAuxiliaryLspServerIds((f) =>
			ctx.pi?.getFlag?.(f),
		).includes("ast-grep");
		// Gate B asks whether the LSP has proved it can handle this root, not
		// whether an ast-grep process or binary merely exists.
		// A first publication covers the warm case. Process liveness and binary
		// resolution do not: both precede proof that this root can publish findings.
		const astGrepLspPublished = astGrepLspEnabled
			? await hasAuxiliaryLspPublishedForRoot("ast-grep", ctx.filePath)
			: false;
		if (astGrepLspEnabled && astGrepLspPublished) {
			// #2324 F2/R2-C: "has this server EVER published for this file" can go
			// stale — a LATER touch's aux-grace wait can find the server silent
			// for the CURRENT content while an OLDER revision's publication still
			// satisfies this per-file gate. Any pending late-aux entry visible
			// HERE is necessarily a LEFTOVER from an earlier touch, never this
			// one: the wait that marks a pair for THIS touch runs to completion
			// (up to its own grace budget, ~1800ms) strictly AFTER this
			// synchronous Gate-B check returns, so it cannot have marked
			// anything yet. Re-running napi here would risk the F3 duplicate
			// this fix closes, so the loss is made observable instead.
			if (hasPendingAuxiliaryCoverage(ctx.filePath, "ast-grep")) {
				incrementDegradationCount({
					kind: "aux-runner-findings-lost",
					subject: "ast-grep",
					reason: `Gate B skipped napi for ${ctx.filePath}: a pending late-auxiliary pair from an EARLIER touch is still undelivered while a prior publication satisfies the per-file gate`,
				});
			}
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const sgModule = await loadSg();
		if (!sgModule) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (!fs.existsSync(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lang = getLang(ctx.filePath, sgModule);
		if (!lang) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let stats: import("fs").Stats;
		try {
			stats = fs.statSync(ctx.filePath);
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		if (stats.size > 1024 * 1024) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let content: string;
		const contentFromFacts = ctx.facts.getFileFact<string | null>(
			ctx.filePath,
			"file.content",
		);
		if (contentFromFacts !== undefined && contentFromFacts !== null) {
			content = contentFromFacts;
		} else {
			try {
				content = fs.readFileSync(ctx.filePath, "utf-8");
			} catch {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		let root: SgRoot;
		try {
			root = lang.parse(content);
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let rootNode: any;
		try {
			rootNode = root.root();
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// #2336: napi is standing in for the ast-grep auxiliary LSP exactly when
		// that server is expected but has not published for this root. Gate B
		// above already returned for the published case, so reaching here with
		// the auxiliary enabled IS the substitute role.
		const runningAsLspSubstitute = astGrepLspEnabled && !astGrepLspPublished;

		if (runningAsLspSubstitute) {
			// #2324 F3/R2-A/R2-B: napi is about to ACTUALLY EVALUATE RULES —
			// every early-return skip above (load failure, missing file,
			// unresolved language, stat/size/read/parse failure) is now behind
			// us, so this run genuinely covers the file rather than reporting a
			// zero-finding no-op. Placing this here (not at Gate-B's decision
			// point) matters twice over:
			//   - R2-B: a napi run that never reached rule evaluation must NOT
			//     consume anything — an unparseable .html file, say, would
			//     otherwise silence the LSP's legitimate late delivery for a
			//     file napi never actually covered.
			//   - R2-A: recording coverage HERE, keyed by timestamp, lets the
			//     aux-grace wait (clients/lsp/index.ts) — which decides whether
			//     to mark a pending pair for THIS touch strictly AFTER this
			//     synchronous call returns — see that napi already delivered
			//     and skip marking, instead of racing a clear against a mark
			//     that has not been written yet.
			// The clear below only ever removes a LEFTOVER pair from an
			// EARLIER touch (this touch's own pair, if the wait decides to
			// mark one, is marked strictly later) — that pair describes a
			// PREVIOUS revision this fresh evaluation supersedes, so dropping
			// it is safe. Unknown pairs are a no-op.
			recordNapiFallbackCoverage(ctx.filePath);
			clearPendingAuxiliaryCoverage(ctx.filePath, "ast-grep");
		}

		// #2336: the substitute runs at the severity floor the server it replaces
		// would have used. The ast-grep auxiliary profile states that floor in
		// words — "the rule severity is deliberate, so preserve ast-grep's
		// severity semantics: ERROR can block, WARNING/INFO stay advisory"
		// (clients/dispatch/auxiliary-lsp.ts:179-183). `blockingOnly` drops every
		// rule whose declared severity is not `error`, which is 380 of the 481
		// bundled rules, so the substitute delivered a fifth of the coverage the
		// LSP delivers and the runner reported zero diagnostics in all 255
		// retained dispatch records. Nothing downstream needs the filter for
		// noise control: `dispatcher.ts` already shows only `semantic:
		// "blocking"` diagnostics inline and routes warning-tier ones to
		// lens_diagnostics, and `tree-sitter.ts:525` already runs its full query
		// set under `blockingOnly` for the same reason.
		//
		// Scoped to the substitute role deliberately. Evaluating the full catalog
		// costs ~6x more per file (measured on this repo: 2.4 ms -> 23 ms at 68
		// lines, 19 ms -> 188 ms at 1275 lines), and outside the substitute role
		// either the LSP is publishing (Gate B skipped napi already) or the user
		// retired ast-grep with `no-ast-grep`. Paying the cost only when napi is
		// the sole ast-grep surface buys coverage that nothing else provides.
		const diagnostics = evaluateAstGrepRules(
			ctx.filePath,
			rootNode,
			ctx.cwd,
			ctx.kind,
			{
				blockingOnly: runningAsLspSubstitute ? false : ctx.blockingOnly,
				projectRoot: ctx.projectRoot,
				log: (message: string) => ctx.log(message),
				content,
				sgModule,
			},
		);

		if (runningAsLspSubstitute) {
			// #2336 observability: the dispatcher's own runner record carries
			// `diagnosticCount`, which is what showed 0 of 255. It cannot say WHICH
			// severity floor produced that count. One line per substitute run —
			// the same cadence as the runner record it annotates — names the floor
			// and the tier mix, so a future "napi found nothing" reading can tell
			// an empty catalog pass from a filtered one.
			const bySeverity: Record<string, number> = {};
			for (const d of diagnostics) {
				bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1;
			}
			logLatency({
				type: "phase",
				phase: "astgrep_napi_substitute_floor",
				filePath: ctx.filePath,
				durationMs: 0,
				metadata: {
					floor: "lsp-equivalent",
					ctxBlockingOnly: ctx.blockingOnly === true,
					diagnosticCount: diagnostics.length,
					bySeverity,
				},
			});
		}

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
		let semantic: "blocking" | "warning" | "none" = "none";
		if (hasBlocking) {
			semantic = "blocking";
		} else if (diagnostics.length > 0) {
			semantic = "warning";
		}
		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic,
		};
	},
};

export default astGrepNapiRunner;
