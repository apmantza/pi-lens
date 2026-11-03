#!/usr/bin/env node
/**
 * playground-verify-rule.mjs — cross-validate an ast-grep rule against the
 * official upstream playground at https://ast-grep.github.io/playground.html.
 *
 * This is a SECOND OPINION against the local CLI test
 * (ast-grep scan -r <rule> <file>). If both produce the same match count on
 * a fixture, we know the rule is consistent across local + upstream
 * ast-grep versions. Useful for catching:
 *   - rule behavior that diverges between versions
 *   - matches that the local CLI misses (or finds spuriously)
 *
 * Architecture:
 *   scripts/playground-chrome.mjs  — dedicated headless Chrome (port 9224,
 *                                   isolated profile, kill-on-exit)
 *   scripts/playground-cdp.mjs     — minimal CDP driver (list, nav, eval)
 *   scripts/playground-verify-rule.mjs  (this file)
 *     1. ensure Chrome is running (auto-launch if not)
 *     2. open a fresh page on the playground URL with the rule + code
 *        encoded in the URL hash (matches the catalog "Try in Playground"
 *        link format)
 *     3. poll page.innerText for "Found N match(es)" + extract line numbers
 *     4. emit JSON to stdout, clean up
 *
 * Usage:
 *   node scripts/playground-verify-rule.mjs <rule.yml> [options]
 *   echo "<code>" | node scripts/playground-verify-rule.mjs <rule.yml> -
 *
 * Options:
 *   --code <text>        Source code to match (inline)
 *   --code-file <path>   Source code to match (file)
 *   -                    Read source code from stdin
 *   --lang <L>           Override language (otherwise read from YAML)
 *   --expected <N>       Assert the match count is exactly N
 *   --timeout <ms>       Page load + config parse timeout (default 30000)
 *   --keep-chrome        Don't kill Chrome on exit (for debugging)
 *
 * Output (JSON to stdout):
 *   { ok, rule_id, language, matches, lines, fix, engine_ms, error? }
 *
 * Exit codes:
 *   0  = matches match --expected (or no expectation set)
 *   1  = matches differ from --expected
 *   2  = setup error
 *   3  = engine / page error
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";
import { safeSpawnAsync } from "../clients/safe-spawn.js";
import { isMainModule } from "./lib/is-main-module.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use os.tmpdir() — the TMP/TEMP env vars differ across shells
// (C:\WINDOWS\TEMP in cmd.exe, C:\Users\…\AppData\Local\Temp in
// PowerShell and Node's os.tmpdir()). The launch script always
// uses os.tmpdir(), so the reuse check must too — otherwise the
// script silently relaunches Chrome every time and adds ~15s.
const PROFILE_DIR = join(tmpdir(), "pilens-playground-profile");
const PORT_FILE = join(PROFILE_DIR, "DevToolsActivePort");

// Map our pascal/short language names to the playground's expected values.
const LANG_ALIASES = {
	TypeScript: "typescript",
	Tsx: "tsx",
	JavaScript: "javascript",
	Python: "python",
	Go: "go",
	Rust: "rust",
	Java: "java",
	CSharp: "csharp",
	C: "c",
	Cpp: "cpp",
	Kotlin: "kotlin",
	Ruby: "ruby",
};

const DEFAULT_TIMEOUT_MS = 30_000;
// Bounded wait for the helper child processes (playground-cdp.mjs /
// playground-chrome.mjs) themselves — separate from DEFAULT_TIMEOUT_MS,
// which bounds the in-page playground poll. Each CDP call already
// self-bounds around 30-40s internally (playground-cdp.mjs's own
// per-message TIMEOUT_MS + nav's 10s hard cap), so 45s here is headroom
// for a wedged/daemonized child that never emits 'close' at all — the
// #1679 hang this constant exists to bound.
const CHILD_SPAWN_TIMEOUT_MS = 45_000;
// #2306: once the source pane has rendered a stable, non-empty
// `sourceLen` this many CONSECUTIVE polls (250ms apart) while the sentinel
// still hasn't matched, the mismatch is real — further polling only wastes
// time up to the full --timeout. Requiring >1 consecutive identical reading
// tolerates the ordinary one-or-two-poll lag between the match-count and
// source-editor components mounting (see the poll loop's own comment).
const STABLE_UNMATCHED_POLLS_REQUIRED = 3;

// #2306: pure poll-to-poll state machine for the fail-fast decision,
// exported so the "is this a real, stable mismatch?" logic can be unit
// tested without a live Chrome/CDP harness. `prevState` is the previous
// call's return value (or the initial state below); returns the next
// state, including `concludedEarly` once a non-empty `scrape.sourceLen`
// has repeated for STABLE_UNMATCHED_POLLS_REQUIRED consecutive calls with
// the sentinel still unmatched.
export const initialPollStability = {
	stableUnmatchedPolls: 0,
	lastUnmatchedSourceLen: null,
	concludedEarly: false,
};

export function trackStableUnmatched(scrape, prevState) {
	if (scrape?.found && !scrape?.sentinelFound && scrape.sourceLen > 0) {
		const stableUnmatchedPolls =
			scrape.sourceLen === prevState.lastUnmatchedSourceLen
				? prevState.stableUnmatchedPolls + 1
				: 1;
		return {
			stableUnmatchedPolls,
			lastUnmatchedSourceLen: scrape.sourceLen,
			concludedEarly: stableUnmatchedPolls >= STABLE_UNMATCHED_POLLS_REQUIRED,
		};
	}
	return initialPollStability;
}

const PORT = Number(process.env.PILENS_PLAYGROUND_PORT) || 9224;
const CHROME_SCRIPT = join(__dirname, "playground-chrome.mjs");
const CDP_SCRIPT = join(__dirname, "playground-cdp.mjs");
const PLAYGROUND_URL = "https://ast-grep.github.io/playground.html";

// ── CLI args ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const args = argv;
	if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
		printUsage();
		process.exit(0);
	}
	const opts = {
		ruleFile: null,
		code: null,
		codeFile: null,
		stdin: false,
		lang: null,
		expected: null,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		keepChrome: Boolean(process.env.PILENS_PLAYGROUND_KEEP),
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--code") opts.code = args[++i];
		else if (a === "--code-file") opts.codeFile = args[++i];
		else if (a === "--lang") opts.lang = args[++i];
		else if (a === "--expected") opts.expected = parseInt(args[++i], 10);
		else if (a === "--timeout") opts.timeoutMs = parseInt(args[++i], 10);
		else if (a === "--keep-chrome") opts.keepChrome = true;
		else if (a === "-") opts.stdin = true;
		else if (!opts.ruleFile) opts.ruleFile = a;
		else throw new Error(`unexpected arg: ${a}`);
	}
	if (!opts.ruleFile) throw new Error("rule YAML path required");
	return opts;
}

function printUsage() {
	console.log(`playground-verify-rule.mjs — cross-validate an ast-grep rule against the
official upstream playground.

Usage:
  node scripts/playground-verify-rule.mjs <rule.yml> [options]

Options:
  --code <text>        Source code to match (inline)
  --code-file <path>   Source code to match (file)
  -                    Read source code from stdin
  --lang <L>           Override the rule's language (otherwise read from YAML)
  --expected <N>       Assert the match count is exactly N
  --timeout <ms>       Page load + config parse timeout (default 30000)
  --keep-chrome        Don't kill Chrome on exit (for debugging)

Output: JSON to stdout with { ok, matches, lines, fix, engine_ms, error? }.
Exit:   0 = match (or no expectation set), 1 = mismatch, 2 = setup, 3 = engine.`);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function readStdin() {
	return new Promise((resolve) => {
		// Bail immediately if stdin isn't piped/redirected — otherwise
		// we'd wait forever and Node would keep the event loop alive
		// past the result.
		if (process.stdin.isTTY) {
			resolve("");
			return;
		}
		let buf = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => (buf += c));
		process.stdin.on("end", () => resolve(buf));
		// Safety net: if no data arrives within 1s, assume the pipe
		// is empty and resolve.
		setTimeout(() => resolve(buf), 1000);
	});
}

// #1679: was a hand-rolled `spawn(...)` + `proc.on("close", ...)` wait with
// NO timeout — a wedged/daemonized child (e.g. Chrome/CDP left in a state
// that never emits 'close') hung this script forever. safeSpawnAsync
// (shared with production, clients/safe-spawn.ts) already does bounded
// timeout+kill, stdout/stderr accumulation, and spawn-error surfacing —
// reusing it here instead of a second, hand-rolled wait (single source of
// truth, #883).
//
// `scriptPath`/`timeoutMs` are overridable (default to the real CDP/Chrome
// helper scripts and CHILD_SPAWN_TIMEOUT_MS) purely so tests can point at a
// never-closing fixture with a short timeout instead of the real helpers —
// production call sites never pass them.
export async function runCdp(
	args,
	{ scriptPath = CDP_SCRIPT, timeoutMs = CHILD_SPAWN_TIMEOUT_MS } = {},
) {
	const result = await safeSpawnAsync(process.execPath, [scriptPath, ...args], {
		env: { ...process.env, PILENS_PLAYGROUND_PORT: String(PORT) },
		timeout: timeoutMs,
	});
	if (result.status === 0) return result.stdout.trim();
	const detail = result.error
		? result.error.message
		: result.stderr.trim() || result.stdout.trim() || "no output";
	throw new Error(`cdp ${args[0]} failed (exit ${result.status}): ${detail}`);
}

export async function runChrome(
	cmd,
	{ scriptPath = CHROME_SCRIPT, timeoutMs = CHILD_SPAWN_TIMEOUT_MS } = {},
) {
	const result = await safeSpawnAsync(process.execPath, [scriptPath, cmd], {
		env: { ...process.env, PILENS_PLAYGROUND_PORT: String(PORT) },
		timeout: timeoutMs,
	});
	// The original spawn inherited stderr so launch/kill diagnostics streamed
	// live; safeSpawnAsync captures instead, so surface it here on failure.
	if (result.status === 0) return;
	if (result.stderr) process.stderr.write(result.stderr);
	const detail = result.error ? result.error.message : `exit ${result.status}`;
	throw new Error(`chrome ${cmd} failed (${detail})`);
}

async function ensureChrome() {
	const t0 = Date.now();
	if (existsSync(PORT_FILE)) {
		try {
			await runCdp(["list"]);
			process.stderr.write(
				`# [playground] chrome reuse: ${Date.now() - t0}ms\n`,
			);
			return;
		} catch {
			try {
				await runChrome("kill");
			} catch {}
		}
	}
	await runChrome("launch");
	process.stderr.write(`# [playground] chrome launch: ${Date.now() - t0}ms\n`);
}

// #2208: the playground's URL-hash state (ast-grep/ast-grep.github.io,
// website/src/components/astGrep/state.ts) matches rules built from
// `state.config` against `state.source` — `state.query` only feeds the
// separate "Pattern" mode and is ignored in Config mode. This harness
// previously wrote the caller's code into `query`, so the hash carried no
// `source` field at all; the playground's `{...defaultState, ...parsed}`
// merge silently fell back to its own hardcoded sample source instead of
// erroring, so every run graded the rule against that fixed sample and
// never against the code the caller passed in.
export function buildPlaygroundUrl(ruleYaml, code, lang) {
	const payload = {
		mode: "Config",
		lang,
		query: "",
		rewrite: "",
		config: ruleYaml,
		source: code,
	};
	const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
	return `${PLAYGROUND_URL}#${b64}`;
}

// JS expression evaluated in the page to scrape the playground result.
// The match-count scan stays selector-free (rendered text), but the
// SENTINEL check deliberately anchors to the first `.half`'s Monaco
// editor under `main.playground` — body-wide text let a rule note in
// the config pane satisfy it (#2253). If the playground's pane layout
// changes, that selector is the thing to revisit.
//
// IMPORTANT: the expression is passed through spawn argv, which on
// Windows strips backslashes. We avoid regex backslash escapes
// entirely — character classes with the raw chars, or split string
// matches, survive the round-trip.
//
// The first non-empty line of the caller's `--code`, used as a sentinel
// (see buildScrapeExpr's `sentinelB64` param). Only the first line: #2208
// fix-round finding F2 established (via a real 122-line fixture) that the
// Monaco source editor virtualizes — the top of the document renders, but
// a line far down the viewport does not. Checking the first non-empty line
// is the one check that survives virtualization for a source of any length.
export function firstNonEmptyLine(code) {
	const line = code.split(/\r?\n/).find((l) => l.trim().length > 0);
	return line ? line.trim() : null;
}

// The playground shows one of:
//   "Found N match(es)."        — the rule fired N times against the
//                                  caller's source (state.source, set via
//                                  the payload above)
//   "No match found."           — the rule did not fire (0 matches)
//   an error message             — the rule's YAML/pattern was rejected
//
// #2208 fix-round finding F2: the 0-match bug this file fixes could recur
// through upstream schema drift alone — e.g. the playground renaming
// `state.source` to something else would make our `source: code` write
// land nowhere, and the playground would again silently grade its own
// hardcoded sample. That failure mode looks identical to a legitimate
// {ok:true, matches:0}: nothing here would throw or time out. `sentinelB64`
// is the caller's first source line (see firstNonEmptyLine), base64-encoded
// with the same routine ast-grep's own playground uses for its URL hash
// (utoa: btoa(unescape(encodeURIComponent(text)))) so it survives Windows
// argv's backslash-stripping (no `\`-containing regex/string literals to
// mangle) and round-trips non-ASCII. The playground always echoes the
// source into the DOM (it's the editor's own content), so if that line is
// genuinely absent from the rendered text, the source never reached the
// engine — regardless of what "Found N match(es)" says.
// #2208 fix-round finding F6: the gutter-number filter used to clamp to
// `n <= count` (the MATCH count), not the source's own line count. A match
// on line 3 of a 3-line file reported `lines: [1]` — the filter discarded
// any gutter number above the match count, even though the match count and
// the line number it occurred on are unrelated quantities (one match can
// sit on line 200 of a 5-line... no, on line 200 of a 200-line file with
// only 1 match). `maxLine` is the caller's own source line count — a gutter
// number can never legitimately exceed it, whereas the match count can be
// smaller than the line a match falls on.
export function buildScrapeExpr(sentinelB64, maxLine) {
	const sentinelExpr = sentinelB64
		? `decodeURIComponent(escape(atob("${sentinelB64}")))`
		: "null";
	const maxLineExpr =
		Number.isFinite(maxLine) && maxLine > 0
			? String(Math.floor(maxLine))
			: "Infinity";
	// #2208 fix-round F2, verified against the live upstream site: Monaco
	// renders the space between tokens as U+00A0 (non-breaking space), not
	// U+0020 — confirmed by dumping charCodes around a rendered "const a = 1"
	// (codes 99,111,110,115,116,160,97,160,61,160,49 — 160 is nbsp). A
	// sentinel built from the caller's raw source (regular spaces) would
	// never match the rendered page for any line containing a space, which
	// looked exactly like the schema-drift condition this check exists to
	// catch. Normalize nbsp to a regular space on the page side before
	// oxlint-disable-next-line no-irregular-whitespace -- the U+00A0 nbsp below is the literal character this comment documents, not accidental paste.
	// comparing. (`" "` here is resolved to the real character by this
	// file's own parser, not sent over argv as a `\`-escape, so it survives
	// Windows argv's backslash-stripping same as the rest of this
	// function's argv-safety already does.)
	//
	// #2306: a tab in the source has the same problem — Monaco does not
	// render it as U+0009 either, so a sentinel built from the caller's raw
	// source (a literal tab) never matched the rendered page for any line
	// containing one, misreporting a genuine run as schema drift exactly
	// like the nbsp case above. Rather than hand-list every substitution
	// Monaco happens to use, collapse EVERY run of whitespace-like
	// characters (tab, nbsp, regular space) to one space on BOTH sides of
	// the comparison — the decoded sentinel string itself, not just the
	// page's rendered text — so a difference in run length (one tab vs. a
	// run of spaces/nbsp) can no longer defeat the match.
	return `(() => {
		const text = (document.body.innerText || "").split(" ").join(" ");
		const sourceEditor = document.querySelector(
			".playground > .half:first-child .monaco-editor",
		);
		const collapseWhitespace = (s) =>
			s
				.split(String.fromCharCode(9))
				.join(" ")
				.split(String.fromCharCode(160))
				.join(" ")
				.split(" ")
				.filter(Boolean)
				.join(" ");
		const sourceTextNormalized = collapseWhitespace(
			sourceEditor?.textContent || "",
		);
		const sentinel = ${sentinelExpr};
		const normalizedSentinel =
			sentinel === null ? null : collapseWhitespace(sentinel);
		const sentinelFound =
			normalizedSentinel === null ||
			sourceTextNormalized.indexOf(normalizedSentinel) !== -1;
		const maxLine = ${maxLineExpr};
		const m = text.match(/Found[ \\t]+(\\d+)[ \\t]+match/i);
		if (m) {
			const count = parseInt(m[1], 10);
			const lines = Array.from(document.querySelectorAll("*"))
				.map((el) => (el.textContent || "").trim())
				.filter((t) => /^[0-9]+$/.test(t))
				.map((t) => parseInt(t, 10))
				.filter((n) => n >= 1 && n <= maxLine)
				.filter((n, i, a) => a.indexOf(n) === i)
				.sort((a, b) => a - b);
			return {
				found: true,
				count,
				lines,
				sentinelFound,
				sourceLen: sourceTextNormalized.length,
			};
		}
		if (/no[ \\t]+match[ \\t]+found/i.test(text)) {
			return {
				found: true,
				count: 0,
				lines: [],
				sentinelFound,
				sourceLen: sourceTextNormalized.length,
			};
		}
		return { found: false, text: text.slice(0, 800), sentinelFound };
	})()`;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const startMs = Date.now();

	// 1) Read rule
	const rulePath = resolve(opts.ruleFile);
	if (!existsSync(rulePath)) {
		console.error(
			JSON.stringify({ ok: false, error: `rule not found: ${rulePath}` }),
		);
		process.exit(2);
	}
	const ruleYaml = readFileSync(rulePath, "utf-8");
	let rule;
	try {
		rule = yamlLoad(ruleYaml);
	} catch (e) {
		console.error(
			JSON.stringify({ ok: false, error: `invalid YAML: ${e.message}` }),
		);
		process.exit(2);
	}
	if (!rule || typeof rule !== "object" || !rule.id) {
		console.error(
			JSON.stringify({ ok: false, error: "rule YAML missing 'id'" }),
		);
		process.exit(2);
	}
	const lang = opts.lang || rule.language || "TypeScript";
	const playLang = LANG_ALIASES[lang] || lang.toLowerCase();

	// 2) Read source code
	let code = "";
	if (opts.code !== null) code = opts.code;
	else if (opts.codeFile) {
		const p = resolve(opts.codeFile);
		if (!existsSync(p)) {
			console.error(
				JSON.stringify({ ok: false, error: `code file not found: ${p}` }),
			);
			process.exit(2);
		}
		code = readFileSync(p, "utf-8");
	} else if (opts.stdin) code = await readStdin();
	if (!code.length) {
		console.error(
			JSON.stringify({
				ok: false,
				error: "no source code (use --code, --code-file, or -)",
			}),
		);
		process.exit(2);
	}

	// 3) Ensure Chrome is running
	try {
		await ensureChrome();
	} catch (e) {
		console.error(JSON.stringify({ ok: false, error: `chrome: ${e.message}` }));
		process.exit(2);
	}

	// 4) Open a new page + navigate to the playground
	const log = (m) => process.stderr.write(`# [playground] ${m}\n`);
	let targetId;
	try {
		const url = buildPlaygroundUrl(ruleYaml, code, playLang);
		log(`url length: ${url.length}`);
		// Create an about:blank page, then nav it to the playground.
		// `newpage` returns the targetId; the follow-up `nav` blocks
		// until Page.loadEventFired, so the React app has parsed
		// the config from the URL hash by the time we poll.
		const newOut = await runCdp(["newpage"]);
		const { targetId: tid } = JSON.parse(newOut);
		targetId = tid;
		log(`targetId: ${tid}`);
		await runCdp(["nav", targetId, url]);
		// 5) Poll for the "Found N match(es)" line (or "No match found").
		const sentinelLine = firstNonEmptyLine(code);
		const sentinelB64 = sentinelLine
			? Buffer.from(sentinelLine, "utf8").toString("base64")
			: null;
		const maxLine = code.split(/\r?\n/).length;
		const scrapeExpr = buildScrapeExpr(sentinelB64, maxLine);
		const deadline = Date.now() + opts.timeoutMs;
		let scrape = null;
		let polls = 0;
		// #2306: distinguishes "the source pane is still mounting" (sourceLen
		// changing between polls — keep waiting) from "the pane is done
		// rendering and the sentinel genuinely doesn't match" (sourceLen
		// stable and non-zero — stop early instead of burning the full
		// --timeout). trackStableUnmatched resets on any change so a
		// still-painting pane never counts toward the early exit.
		let pollStability = initialPollStability;
		while (Date.now() < deadline) {
			polls++;
			const out = await runCdp(["eval", targetId, scrapeExpr]);
			try {
				scrape = JSON.parse(out);
			} catch {
				scrape = null;
			}
			// On a warm/reused Chrome the match count can render a poll or
			// two before the source editor paints its own content — `Found
			// N match(es)` and the source pane are two independently-mounted
			// Vue components, not one atomic update. Keep polling until the
			// sentinel also lands, exactly as we already do for the match
			// text itself; a genuine drift (source never arrives) still
			// exhausts the deadline and reports below, just slower.
			if (scrape?.found && scrape?.sentinelFound) break;
			pollStability = trackStableUnmatched(scrape, pollStability);
			if (pollStability.concludedEarly) break;
			if (polls % 10 === 0) log(`poll #${polls}: still waiting…`);
			await new Promise((r) => setTimeout(r, 250));
		}
		log(`polls done: ${polls}, scrape=${JSON.stringify(scrape)}`);
		if (!scrape?.found) {
			const result = {
				ok: false,
				rule_id: rule.id,
				error: "playground did not render 'Found N match(es)' within timeout",
				debug_text: scrape?.text || null,
				engine_ms: Date.now() - startMs,
			};
			console.error(JSON.stringify(result));
			process.exit(3);
		}
		// #2208 fix-round F2: a {found:true} scrape only means the page
		// rendered SOME match-count text — it says nothing about whose
		// source produced it. If the caller's own first source line never
		// made it into the rendered page, the playground graded a source
		// we didn't send (its own default sample, or a stale one from an
		// upstream field-name change) — never trust the count in that case.
		if (!scrape.sentinelFound) {
			// #2306: a stable, non-empty `sourceLen` rules out "the pane is
			// still mounting" — it does NOT pick between the two remaining
			// causes. A Monaco whitespace substitution collapseWhitespace
			// doesn't yet cover and upstream schema drift (state.source
			// renamed/moved, so the page renders its own default sample)
			// both render a stable pane the sentinel can't be found in, so
			// the early-exit message narrows the search without claiming
			// which one it is.
			const result = {
				ok: false,
				rule_id: rule.id,
				error: pollStability.concludedEarly
					? "caller's source did not appear in the playground page after whitespace normalization, and the source pane is stable (done rendering) — either a sentinel-normalization mismatch in this harness (an un-normalized Monaco whitespace substitution) or upstream schema drift (state.source field renamed/moved, leaving the page's own default sample rendered), not a real 0-match result"
					: "caller's source did not appear in the playground page after whitespace normalization — likely a sentinel-normalization mismatch in this harness (an un-normalized Monaco whitespace substitution) or upstream schema drift (state.source field renamed/moved), not a real 0-match result",
				matches_reported_by_page: scrape.count,
				polls,
				concluded_early: pollStability.concludedEarly,
				engine_ms: Date.now() - startMs,
			};
			console.error(JSON.stringify(result));
			process.exit(3);
		}
		const result = {
			ok: true,
			rule_id: rule.id,
			language: playLang,
			matches: scrape.count,
			lines: scrape.lines,
			fix: rule.fix || null,
			engine_ms: Date.now() - startMs,
		};
		if (opts.expected !== null && opts.expected !== scrape.count) {
			result.ok = false;
			result.expected = opts.expected;
			console.error(JSON.stringify(result));
			process.exit(1);
		}
		console.log(JSON.stringify(result));
	} catch (e) {
		console.error(JSON.stringify({ ok: false, error: `engine: ${e.message}` }));
		process.exit(3);
	} finally {
		// Chrome cleanup is the only thing that needs to finish before
		// the script exits — a leftover headless Chrome would block the
		// next invocation's launch. Await the kill synchronously when
		// --keep-chrome is not set. Timeout the kill in case Chrome
		// itself hangs (the spawn is detached; the worst case is a
		// slow taskkill).
		if (!opts.keepChrome) {
			const killStart = Date.now();
			await Promise.race([
				runChrome("kill"),
				new Promise((_, rej) =>
					setTimeout(() => rej(new Error("kill timeout")), 10_000),
				),
			]).catch((e) =>
				process.stderr.write(`# [playground] kill warning: ${e.message}\n`),
			);
			process.stderr.write(
				`# [playground] killed in ${Date.now() - killStart}ms\n`,
			);
		} else {
			console.error(`# playground Chrome left running on port ${PORT}`);
		}
	}
}

// #1679: only run the CLI when this file is executed directly (`node
// scripts/playground-verify-rule.mjs ...`), not when it's imported as a
// module — tests import `runCdp`/`runChrome` directly to exercise the
// bounded-wait fix without also parsing CLI args / spawning Chrome / calling
// process.exit as a side effect of the import.
const isMain = isMainModule(import.meta.url);
if (isMain) {
	main().then(
		() => process.exit(0),
		(e) => {
			console.error(JSON.stringify({ ok: false, error: e.message }));
			process.exit(2);
		},
	);
}
