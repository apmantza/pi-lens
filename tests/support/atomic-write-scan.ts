/**
 * Mechanical scan for direct-to-final-path filesystem writes under `clients/`
 * that bypass the shared atomic tmp+rename seam (#762's `clients/atomic-write.ts`,
 * #1609 layer a).
 *
 * A process that gets SIGKILLed mid-write (the Node auto-upgrade
 * RestartManager kill from the pi-free crash forensics, or any other hard
 * kill) can leave a torn file behind at whatever path it was writing to. A
 * raw `fs.writeFile`/`fs.writeFileSync` straight at the final path has no
 * protection against this: a reader can observe the file mid-write. The
 * shared `writeFileAtomic`/`writeFileAtomicAsync` helpers (and the
 * `commitDurableStore`/`commitDurableStoreAsync` locked read-modify-write
 * seam built on them) stage into a per-call tmp file and `rename()` over the
 * target, so a reader only ever observes the fully-old or fully-new file.
 *
 * This scan DERIVES the write-site inventory from the source at test-run
 * time — it does not hand-maintain a parallel list of "files that write
 * state" (the single-source-of-truth rule). What IS hand-maintained is the
 * EXEMPTION list below, because "is this write persisted state that must
 * survive a crash, or a same-call scratch file / append-only log / different
 * atomicity discipline (O_EXCL lock creation)" is a semantic judgment a
 * static scan cannot make reliably — exactly `AGENTS.md` shape 7's
 * "syntactically identical, semantically different" trap. Every exemption
 * below carries a REASON; `tests/clients/atomic-write-sweep.test.ts` is
 * expected to review it, not just import it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { toPosix } from "../../clients/path-utils.js";
import { escapeRegExp } from "./sweep-kit.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const CLIENTS_ROOT = path.join(repoRoot, "clients");

/** One raw filesystem-write call site found outside the atomic seam. */
export interface RawWriteSite {
	/** Repo-relative posix path of the file containing the call. */
	file: string;
	/** 1-based line number of the call. */
	line: number;
	/** The matched call text (trimmed), for a legible failure message. */
	snippet: string;
	/** True when the call's own TARGET (first) argument names an
	 *  obviously-scratch temp path (see {@link TMP_TARGET_PATTERN}) — judged
	 *  from that argument alone, never the whole line or file (#1609 review
	 *  F2: a `tmp`-prefixed DATA argument must not clear an unrelated
	 *  target). Cleared per SITE, never per file. */
	transientTarget: boolean;
}

/**
 * Import forms that bind a local identifier to `node:fs` or
 * `node:fs/promises` as a whole (default or namespace import, or a
 * `{ promises as X }` named-and-aliased import) — the shapes whose bound
 * name can then be used as a `<name>.writeFile(...)`-style receiver.
 * Deliberately does NOT need to catch a bare named import of `writeFile`
 * itself (`import { writeFile } from "node:fs/promises"`): a repo-wide grep
 * at #1609 review time found no such call site in `clients/`, so this stays
 * scoped to the receiver forms actually in use rather than speculatively
 * handling a shape nothing exercises.
 */
const FS_BINDING_PATTERNS = [
	/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+["']node:fs(?:\/promises)?["']/g,
	/import\s*\{[^}]*\bpromises\s+as\s+(\w+)[^}]*\}\s*from\s+["']node:fs["']/g,
];

/**
 * #1609 review F3: the receiver alternation used to be hardcoded to the
 * literal names `fs`/`fsp`, which a differently-named import binding
 * (`nodeFs`, `fsPromises`, …) — already in use across a dozen files in this
 * very codebase — trivially escapes. Deriving the receiver set from each
 * file's OWN `node:fs`/`node:fs/promises` import bindings closes that:
 * whatever local name a file chose, the scan matches calls through it. `fs`
 * and `fsp` stay in the set unconditionally as a defensive fallback (never a
 * narrowing) for the (currently nonexistent, but cheap to guard) case of a
 * write call reached through neither an import this scan recognizes nor one
 * of the two conventional bare names.
 */
function importedFsBindings(source: string): string[] {
	const bindings = new Set(["fs", "fsp"]);
	for (const pattern of FS_BINDING_PATTERNS) {
		for (const match of source.matchAll(pattern)) {
			if (match[1]) bindings.add(match[1]);
		}
	}
	return [...bindings];
}

/**
 * Matches a raw write call that lands directly at its target path: any of
 * `bindings` (this file's own `node:fs`/`node:fs/promises` import names,
 * plus the `fs`/`fsp` fallback) qualified with an optional `.promises.`,
 * followed by `writeFile`/`writeFileSync`/`appendFile`/`appendFileSync`, or
 * `createWriteStream`. Deliberately does NOT match `writeFileAtomic(`/
 * `writeFileAtomicAsync(` (different identifier) or a bare `.writeFile(` on
 * an arbitrary receiver (e.g. a file HANDLE from `fs.open` — a different,
 * O_EXCL-flavored atomicity discipline, reviewed per-site instead).
 */
function buildRawWritePattern(bindings: string[]): RegExp {
	const receivers = bindings.map(escapeRegExp).join("|");
	return new RegExp(
		`\\b(?:${receivers})\\.(?:promises\\.)?(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\\(`,
		"g",
	);
}

/**
 * A raw write whose OWN target argument is an obviously-scratch, per-call
 * temp variable (`tmpArchive`, `tmpScript`, `tmpFile`, …) or `os.tmpdir()`
 * itself. Checked per SITE, not per file: a large multi-concern module (e.g.
 * `installer/index.ts`, which both owns probe-cache's durable-store commit
 * AND writes several per-call scratch archives) can have both a real
 * persisted-state write and a same-call scratch write side by side — a
 * file-level "this file imports the atomic seam somewhere" check would
 * wrongly clear BOTH, which is exactly what let the #1609 installer
 * violations (bare-gzip/bare-binary/jar/launcher/shim writes straight to
 * their final path) go undetected: `installer/index.ts` already imports
 * `commitDurableStoreAsync` from `durable-store.js` for probe-cache, so a
 * whole-file exemption would have silently cleared every OTHER raw write in
 * the same 3000+ line file too.
 */
const TMP_TARGET_PATTERN = /\btmp[A-Z]\w*|os\.tmpdir\(\)/;

/**
 * Repo-relative posix paths (relative to `clients/`) whose ENTIRE raw-write
 * surface is exempt from the atomic-seam requirement, each with the reason
 * it's safe. Grouped by shape. Keep this list reviewed, not just present —
 * an entry here is a standing claim that a torn write at that site cannot
 * produce a misleadingly-valid or throw-on-read state (verified for the
 * log-shaped entries via the readers' own tolerant-parse code, spot-checked
 * against fault injection in `tests/clients/instance-registry.test.ts` and
 * `tests/clients/installer/probe-cache.test.ts`'s #1609 additions — layer b).
 */
export const EXEMPT_RAW_WRITE_FILES: Readonly<Record<string, string>> = {
	// --- Defines the seam itself ---
	"atomic-write.ts": "defines writeFileAtomic/writeFileAtomicAsync",
	"instance-registry-lock.ts":
		"lines 102 and 133 create the O_EXCL lock with a raw exclusive write; tmp+rename would destroy the exclusivity",

	// --- Append-only NDJSON logs: a torn tail is a documented, tolerated read
	// shape (line-oriented readers skip an unparseable trailing line; #1609
	// layer b spot-checks this). These are observability substrate, not
	// state a session_start loader trusts wholesale. ---
	"ndjson-logger.ts":
		"append-only NDJSON log writer; a torn trailing line is a documented, tolerated read shape (line-oriented consumers skip an unparseable line, never trust a partial one)",
	"log-cleanup.ts":
		"truncates a log to the empty string for rotation; an empty file is always a valid state, there is nothing to tear",
	"fix-worklog.ts":
		"append-only worklog.jsonl; readers are line-oriented and skip an unparseable trailing line (see ndjson-logger.ts)",
	"lsp/launch.ts":
		"append-only sessionstart.log via fs.appendFileSync; same tolerated-tail shape as ndjson-logger.ts",
	"project-changes.ts":
		"append-only change-log.jsonl; parseChangeLine (this file) already try/catches each line and drops an unparseable one rather than throwing or half-trusting it (verified directly, not just by pattern)",
	"code-quality-warnings.ts":
		"append-only NDJSON history file (appendCodeQualityWarningsHistory) that pi-lens never reads back itself — write-only observability for external tooling, so a torn trailing line has no functional read path to mislead",
	"actionable-warnings.ts":
		"append-only NDJSON history file (getActionableWarningsHistoryPath's writer), same write-only shape as code-quality-warnings.ts — no reader in this codebase to mislead",

	// --- Per-invocation scratch files: written and consumed synchronously
	// within the SAME command/spawn, never re-read across a session boundary,
	// so a crash mid-write just means that one invocation fails (surfaced
	// normally through its own exit code), not a persisted-state read. ---
	"sg-runner.ts":
		"per-invocation ast-grep sgconfig/rule scratch files under a fresh session dir, consumed synchronously by the spawned ast-grep process in the same call, never read back at session_start",
	"sgconfig.ts":
		"per-invocation ast-grep sgconfig scratch file, same shape as sg-runner.ts",
	"gitleaks-client.ts":
		"per-invocation gitleaks TOML config, consumed synchronously by the spawned gitleaks process in the same call",
	"ast-grep-client.ts":
		"per-invocation source/snippet scratch files fed to ast-grep synchronously in the same call",
	"dispatch/runners/psscriptanalyzer.ts":
		"per-invocation PS1 scratch script under os.tmpdir(), consumed synchronously by the spawned pwsh process in the same call",
	"gzip-stage-write.ts":
		"streams through the shared stagePathFor(...) staging-name scheme (re-exported from atomic-write-staging.js) because it needs its own gzip pipeline, not the whole-buffer writeFileAtomic; still same-scheme, reviewed at #1205",

	// --- Lock files: O_EXCL exclusive-create is the atomicity primitive here,
	// not tmp+rename — the write only ever succeeds when the file did not
	// already exist, so there is no "torn over a previously-valid file" case;
	// a torn/short lock body is handled by the stale-owner recovery path,
	// separately from tmp+rename discipline. ---
	"bounded-pid-file-lock.ts":
		"lock-file token writes; O_EXCL exclusive-create is the atomicity primitive, not tmp+rename, and stale/short lock bodies are handled by the existing stale-owner recovery path",

	// --- Human-facing report output, not machine-parsed session state. ---
	"lens-map.ts":
		"writes a human-facing HTML report for a browser, never re-read by pi-lens itself as state",

	// --- Edits to the USER's own source files (LSP applyEdit), not pi-lens's
	// own persisted state. A crash mid-write here is a normal
	// editor/VCS-recoverable risk (the user's own editor/undo history, not
	// pi-lens's session_start loaders, is the recovery path) — a different
	// class from the umbrella issue's scope (probe-cache, registries,
	// worklog); tracked separately rather than silently folded into this
	// sweep's "fixed" count. partial-edit-apply.ts graduated out of this
	// exemption in #2402: its commit now routes through the shared
	// writeFileAtomic seam under the FileTime lock. ---
	"lsp/edits.ts":
		"writes the user's own source file(s) via applyEdit, same class as partial-edit-apply.ts",
};

/** Every `.ts` file under `clients/`, minus `.d.ts` and test fixtures. */
export function clientSourceFiles(dir = CLIENTS_ROOT): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) return clientSourceFiles(entryPath);
		if (!/\.ts$/.test(entry.name)) return [];
		if (/\.d\.ts$/.test(entry.name)) return [];
		if (entry.name.endsWith(".test.ts")) return [];
		return [entryPath];
	});
}

/**
 * Extracts the TARGET (first) argument's source text for a call whose
 * opening `(` is at `openParenIndex` in `source`. Tracks paren/bracket/brace
 * depth and quote state so a nested call (`path.join(a, b)`), an object
 * literal, or a comma/paren inside a string doesn't end the scan early, and
 * stops at the first depth-0 comma (or the call's own closing paren, for a
 * single-argument call). Scanning the source directly — not the single
 * matched line — also correctly handles a call whose target argument sits on
 * a later line than the `fs.writeFile(` token itself.
 *
 * #1609 review F2: judging "is this a scratch temp write" from the whole
 * matched LINE let a `tmp`-prefixed DATA argument clear an unrelated,
 * non-scratch TARGET — e.g. `fs.writeFileSync(registryPath(), tmpData)`
 * writes to `registryPath()`, not a temp file, but the old line-wide check
 * saw `tmpData` anywhere on the line and cleared it. Judging only the first
 * argument closes that gap.
 */
function extractTargetArgument(source: string, openParenIndex: number): string {
	let depth = 0;
	let quote: '"' | "'" | "`" | undefined;
	let i = openParenIndex + 1;
	const start = i;
	for (; i < source.length; i++) {
		const ch = source[i];
		if (quote) {
			if (ch === "\\") {
				i++; // skip the escaped character
			} else if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
		} else if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
		} else if (ch === ")" || ch === "]" || ch === "}") {
			if (depth === 0) break; // the call's own closing paren
			depth--;
		} else if (ch === "," && depth === 0) {
			break;
		}
	}
	return source.slice(start, i);
}

/** Raw write-call sites in `source`, with 1-based line numbers. Each site's
 *  `transientTarget` is judged from its own TARGET argument only — see
 *  {@link extractTargetArgument}'s docstring for why, and
 *  {@link TMP_TARGET_PATTERN}'s docstring for why per-file import checks are
 *  not used either. */
export function findRawWriteSites(
	file: string,
	source: string,
): RawWriteSite[] {
	const sites: RawWriteSite[] = [];
	const pattern = buildRawWritePattern(importedFsBindings(source));
	for (const match of source.matchAll(pattern)) {
		const matchIndex = match.index ?? 0;
		const upTo = source.slice(0, matchIndex);
		const line = upTo.split("\n").length;
		const lineText = source.split("\n")[line - 1]?.trim() ?? match[0];
		const openParenIndex = matchIndex + match[0].length - 1;
		const targetArg = extractTargetArgument(source, openParenIndex);
		sites.push({
			file,
			line,
			snippet: lineText,
			transientTarget: TMP_TARGET_PATTERN.test(targetArg),
		});
	}
	return sites;
}

export interface RawWriteFileScan {
	/** `clients/`-relative posix path. */
	file: string;
	sites: RawWriteSite[];
}

/** Every `clients/`-relative file with at least one raw write-call site.
 *  Derived from the source at call time — not a hand-maintained list.
 *  Callers filter each SITE against `EXEMPT_RAW_WRITE_FILES` (whole-file) or
 *  `site.transientTarget` (per-site) — never against "the file imports the
 *  atomic seam somewhere," which a large multi-concern file can satisfy
 *  while still having an unrelated raw write elsewhere in the same file. */
export function scanRawWriteFiles(): RawWriteFileScan[] {
	const found: RawWriteFileScan[] = [];
	for (const absolute of clientSourceFiles()) {
		const source = fs.readFileSync(absolute, "utf8");
		const file = toPosix(path.relative(CLIENTS_ROOT, absolute));
		const sites = findRawWriteSites(file, source);
		if (sites.length === 0) continue;
		found.push({ file, sites });
	}
	return found;
}
