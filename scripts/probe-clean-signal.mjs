#!/usr/bin/env node
/**
 * #240/#460 per-server clean-signal probe — the measurement prerequisite for the
 * learned clean-signal deadlines (#458). PHASE-AWARE 4-way classification of each
 * PUSH-mode LSP server (see scripts/lib/clean-signal.mjs for the two-axis model):
 *   - publishes-versioned   (tier 2 ): versioned publish on clean transitions —
 *     affirmative + currency-proven (ast-grep).
 *   - publishes-unversioned (tier 2*): version-less publish on clean transitions
 *     — still early-returns the wait at runtime (the client accepts a
 *     version-less publish as fresh: it can't be proven stale), but currency is
 *     only temporally correlated (opengrep). A staleness-risk note, not latency.
 *   - silent                (tier 3 ): alive (published on dirty) but silent on
 *     clean transitions — the budget-wait case, #458's target set.
 *   - unknown: no publish at all (slow/absent — conservatively unclassified).
 * PULL-mode servers are Tier 1 by protocol (#240) and reported `n/a (pull)`.
 *
 * How it decides: the server's in-process publish trace (`[lsp-pub]`, gated by
 * PILENS_PUB_DEBUG, which we force on) is the authoritative record of what the
 * server pushed, attributed per phase:
 *   - dirty phase: the first touch of the (deliberately dirty) fixture — proves
 *     the server is live. If nothing ever arrives the server is `unknown` — a
 *     slow server is NEVER misclassified as Tier 3 from the dirty step.
 *   - clean-transition phase: a byte-changing, diagnostic-neutral edit (the
 *     clean→clean analog on a dirty fixture — nothing about the diagnostics
 *     changes). Publish here (and its versioned-ness) is the discriminator.
 * Classification lives in scripts/lib/clean-signal.mjs (pure, unit-tested).
 *
 * Enumerates the same LSP_FIXTURES as characterize-lsp.mjs, one isolated temp
 * workspace per server, hard per-server timeout so a wedged server can't eat the
 * nightly, always exits 0. Auxiliary servers (ast-grep, opengrep, zizmor, typos)
 * are probed via their with-auxiliary touch path — keeping the ast-grep coverage
 * the original one-off script had.
 *
 * Output mirrors characterize-lsp: per-server lines to stdout; the nightly
 * tool-smoke log is the vehicle from which docs/lsp-capability-matrix.md's
 * `clean-behavior` column is refreshed (same manual mechanism as `mode`).
 *
 *   node scripts/probe-clean-signal.mjs [lang ...] [--install]
 *   PILENS_PUB_DEBUG=1 node scripts/probe-clean-signal.mjs   # also echo raw trace
 * Requires `npm run build:dist` (imports from dist/). Measures only
 * already-installed servers unless --install is passed.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkCleanSignalDrift, classifyCleanBehavior } from "./lib/clean-signal.mjs";
import { mergeRows, mergeSrc, parseTable, replaceTable } from "./lib/md-matrix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const install = argv.includes("--install");
const langs = argv.filter((a) => !a.startsWith("--"));
const ECHO_TRACE = Boolean(process.env.PILENS_PUB_DEBUG);
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

// Force the client's publish trace on so we can tally publishes in-process. It
// writes `[lsp-pub] server=… pubVersion=… docVersion=… diags=…` to console.error
// on every textDocument/publishDiagnostics. Must be set BEFORE importing dist
// (the flag is read once at module load).
process.env.PILENS_PUB_DEBUG = "1";

const { LSP_FIXTURES } = await imp("scripts/smoke-tools.mjs");
const { getLSPService, resetLSPService } = await imp("dist/clients/lsp/index.js");
const { initLSPConfig } = await imp("dist/clients/lsp/config.js");
const { SERVER_DIAGNOSTIC_STRATEGIES } = await imp("dist/clients/lsp/server-strategies.js");
let ensureTool;
if (install) ({ ensureTool } = await imp("dist/clients/installer/index.js"));

// #529 drift check: server-strategies.ts keys its table by SERVER ID, which
// usually equals the fixture's `lang`, but a few fixtures use a different key
// (a language alias fixture, e.g. `jedi` → the "python-jedi" strategy entry).
// Explicit map for the known deviations; anything absent here falls back to
// identity (fixture lang === strategy key), which covers the core set
// (typescript, python, ast-grep, opengrep, yaml, …) without upkeep.
const LANG_TO_STRATEGY_KEY = {
	jedi: "python-jedi",
	// typescript7[-clean] shares the "typescript" server id with classic (#524) —
	// but silentOnClean is documented as CLASSIC-only (server-strategies.ts), so
	// the native variant must NOT be compared against the same marker: comparing
	// it would either falsely flag drift (if TS7 behaves differently, which is
	// the whole reason #524 excluded it) or falsely validate it (if it happens to
	// match). Route it to a key that's never in the table, which classifies as
	// "no marker" via lookup — see the isNativeTs7 handling below instead, which
	// skips the comparison entirely rather than reporting misleading drift.
};

// typescript7[-clean] shares the "typescript" server-strategy key with classic
// (#524) but silentOnClean is documented CLASSIC-only — the native `tsc --lsp
// --stdio` binary's clean-signal behavior is unverified and must not be
// compared against classic's marker in either direction (a mismatch would be
// misleading, not a real drift; a match would be coincidence, not validation).
// These langs are filtered OUT of the drift-check input entirely (not routed
// through the marker lookup as "unmarked" — that would still risk a
// silent-not-marked false positive if the native variant also probes silent).
const NATIVE_VARIANT_LANGS = new Set(["typescript7", "typescript7-clean"]);

function lookupSilentOnClean(lang) {
	const key = LANG_TO_STRATEGY_KEY[lang] ?? lang;
	return SERVER_DIAGNOSTIC_STRATEGIES[key]?.silentOnClean;
}

// Budgets (reuse the original probe's generosity — this is off the hot path).
const CLIENT_WAIT_MS = 30000; // cold spawn + initialize
const PROVE_LIVE_WAIT_MS = 8000; // first touch: cold analysis may be slow (match smoke-tools)
const STEP_WAIT_MS = 2500; // per-touch publish budget (matches the old probe)
const SETTLE_MS = 400; // let a late publish land + past the touch debounce
// Hard per-server cap so one wedged server can't eat the nightly. Sized to cover
// a cold spawn (CLIENT_WAIT_MS) + the two probe steps + settle, with margin.
const PER_SERVER_TIMEOUT_MS = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = process.env.CI ? "ci" : "dev";

// ---- in-process publish capture -------------------------------------------
// The [lsp-pub] trace runs in THIS process (dist is imported), so we intercept
// console.error, count matching lines per step, and (when PILENS_PUB_DEBUG was
// already set by the user) still echo them.
const PUB_RE = /^\[lsp-pub\] server=(\S+) pubVersion=(\S+) docVersion=(\S+) diags=(\d+)/;
let pubSink = null;
const realErr = console.error.bind(console);
console.error = (...args) => {
	const line = args.length === 1 && typeof args[0] === "string" ? args[0] : args.join(" ");
	const m = typeof line === "string" ? line.match(PUB_RE) : null;
	if (m && pubSink) {
		pubSink.push({
			server: m[1],
			pubVersion: m[2],
			diags: Number(m[4]),
			versioned: m[2] !== "undefined",
		});
	}
	if (!m || ECHO_TRACE) realErr(...args);
};

// A byte-changing, diagnostic-neutral edit: append a trailing comment line in the
// file's comment syntax (falls back to a blank line). Keeps the diagnostic SET
// unchanged so a re-publish is purely the server's clean-scan behavior.
function commentFor(file) {
	const ext = path.extname(file).toLowerCase();
	if ([".py", ".rb", ".sh", ".yaml", ".yml", ".toml", ".tf", ".ex", ".exs", ".nix", ".ps1"].includes(ext))
		return "#";
	if ([".lua", ".sql", ".hs"].includes(ext)) return "--";
	if ([".clj", ".ml", ".mli"].includes(ext)) return ";;"; // best-effort; ocaml uses (* *) but a trailing line is harmless bytes
	return "//"; // js/ts/go/rust/c/cpp/java/kotlin/php/dart/zig/vue/svelte/prisma…
}

const lsp = getLSPService();
const fixtures = langs.length
	? LSP_FIXTURES.filter((f) => langs.includes(f.lang))
	: LSP_FIXTURES;

const rows = [];

for (const fx of fixtures) {
	// `clean: true` fixtures (e.g. typescript-clean) hold a genuinely CLEAN file,
	// so their transition IS a true clean→clean — authoritative for the clean-file
	// behavior. Dirty fixtures approximate it with a diagnostic-neutral edit, which
	// OVERSTATES servers whose publish behavior depends on the diagnostic set
	// being non-empty (typescript re-publishes while dirty, goes silent once
	// clean). updateMatrix prefers the clean fixture's verdict for the base lang.
	const row = {
		lang: fx.lang,
		server: fx.serverHint,
		behavior: "unknown",
		tier: 0,
		tierLabel: "",
		mode: "?",
		detail: "",
		cleanFixture: Boolean(fx.clean),
	};
	const dst = fs.mkdtempSync(path.join(os.tmpdir(), "clean-probe-"));
	try {
		await withTimeout(probeFixture(fx, dst, row), PER_SERVER_TIMEOUT_MS, row);
	} catch (e) {
		row.behavior = "unknown";
		row.tierLabel = "";
		row.detail = `error: ${e?.message ?? e}`;
	} finally {
		try { fs.rmSync(dst, { recursive: true, force: true }); } catch {}
	}
	rows.push(row);
	console.error(
		`[${fx.lang}] mode=${row.mode} clean-behavior=${row.behavior}${row.tierLabel ? ` (tier ${row.tierLabel})` : ""} — ${row.detail}`,
	);
}

async function probeFixture(fx, dst, row) {
	fs.cpSync(path.join(repoRoot, fx.dir), dst, { recursive: true });
	const absFile = path.join(dst, fx.file);
	if (fx.gitInit) {
		try { execFileSync("git", ["init", "-q"], { cwd: dst, stdio: "ignore" }); } catch {}
	}
	if (fx.disableServers) {
		fs.mkdirSync(path.join(dst, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(dst, ".pi-lens", "lsp.json"),
			JSON.stringify({ disabledServers: fx.disableServers }, null, 2),
		);
		await initLSPConfig(dst);
	}
	if (install && ensureTool) {
		for (const t of fx.tools ?? []) await ensureTool(t).catch(() => undefined);
	}
	if (!lsp.supportsLSP(absFile)) {
		row.mode = "no-lsp";
		row.detail = "no LSP server registered for this file";
		return;
	}

	const auxIds = fx.auxiliaryServerIds ?? [];
	const useAux = auxIds.length > 0;
	const touch = (content, diagWaitMs) =>
		lsp.touchFile(absFile, content, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: useAux ? "with-auxiliary" : "primary",
			...(useAux ? { auxiliaryServerIds: auxIds } : {}),
			maxClientWaitMs: CLIENT_WAIT_MS,
			maxDiagnosticsWaitMs: diagWaitMs,
			source: "clean-probe",
		});

	const dirtyContent = fs.readFileSync(absFile, "utf8");

	// PHASE-AWARE capture: one sink per phase, switched between touches (a
	// publish can land during touchFile, the settle window, or the capability
	// read, so the sink stays live across each phase's whole span):
	//   dirty phase — the first touch: cold spawn + initialize + first analysis
	//     (generous budget + settle, so a slow cold publish is both captured AND
	//     attributed to the dirty phase, not leaked into the next one);
	//   clean-transition phase — a byte-changing, diagnostic-neutral edit (the
	//     clean→clean analog): bytes differ so the file re-opens (the touch-notify
	//     debounce doesn't dedupe it) and the server re-scans, while the
	//     diagnostic SET is unchanged. Publish here (and whether it carries a
	//     version) is the discriminator.
	const dirtyPubs = [];
	const cleanPubs = [];
	let dirtyResult;
	let support;
	try {
		pubSink = dirtyPubs;
		dirtyResult = await touch(dirtyContent, PROVE_LIVE_WAIT_MS);
		await sleep(SETTLE_MS);
		support = await lsp.getWorkspaceDiagnosticsSupport(absFile);
		await sleep(SETTLE_MS);

		pubSink = cleanPubs;
		fs.writeFileSync(absFile, `${dirtyContent}\n${commentFor(fx.file)} clean-probe edit\n`);
		await sleep(SETTLE_MS);
		await touch(fs.readFileSync(absFile, "utf8"), STEP_WAIT_MS);
		await sleep(SETTLE_MS);
	} finally {
		pubSink = null;
	}

	row.mode = support?.mode ?? "unknown";
	if (row.mode === "pull") {
		row.behavior = "n/a (pull)";
		row.tier = 1;
		row.tierLabel = "1";
		row.detail = "pull-mode: authoritative clean via textDocument/diagnostic";
		return;
	}

	const obs = {
		dirtyPublishes: dirtyPubs.length,
		dirtyVersioned: dirtyPubs.filter((p) => p.versioned).length,
		cleanTransitionPublishes: cleanPubs.length,
		cleanTransitionVersioned: cleanPubs.filter((p) => p.versioned).length,
	};
	const dirtyDiagCount = Array.isArray(dirtyResult) ? dirtyResult.length : 0;
	const verdict = classifyCleanBehavior(obs);
	row.behavior = verdict.behavior;
	row.tier = verdict.tier;
	row.tierLabel = verdict.tierLabel;
	row.detail = `dirtyPubs=${obs.dirtyPublishes}(v:${obs.dirtyVersioned}) cleanPubs=${obs.cleanTransitionPublishes}(v:${obs.cleanTransitionVersioned}) dirtyDiags=${dirtyDiagCount} — ${verdict.reason}`;
}

function withTimeout(promise, ms, row) {
	let timer;
	const guard = new Promise((_, reject) => {
		timer = setTimeout(() => {
			row.detail = `per-server timeout after ${ms}ms`;
			reject(new Error(`per-server timeout after ${ms}ms`));
		}, ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// ---- report ---------------------------------------------------------------
console.log("\nClean-signal matrix (4-way: 2 versioned / 2* unversioned / 3 silent / unknown, among push servers)\n");
console.log(`  ${"LANG".padEnd(18)} ${"MODE".padEnd(11)} ${"CLEAN-BEHAVIOR".padEnd(22)} ${"TIER".padEnd(5)} ${"SRC".padEnd(4)} SERVER`);
for (const r of rows.sort((a, b) => String(a.behavior).localeCompare(String(b.behavior)) || a.lang.localeCompare(b.lang))) {
	console.log(
		`  ${r.lang.padEnd(18)} ${String(r.mode).padEnd(11)} ${String(r.behavior).padEnd(22)} ${String(r.tierLabel || "").padEnd(5)} ${src.padEnd(4)} ${r.server}`,
	);
}
const t2v = rows.filter((r) => r.behavior === "publishes-versioned").length;
const t2u = rows.filter((r) => r.behavior === "publishes-unversioned").length;
const t3 = rows.filter((r) => r.behavior === "silent").length;
const unk = rows.filter((r) => r.behavior === "unknown").length;

// ---- #529 drift check ------------------------------------------------------
// Compare each measured server's observed behavior against server-strategies
// .ts's `silentOnClean` marker. Telemetry only — NEVER a CI gate (this script
// always exit(0)s regardless); a mismatch is logged to stdout and written as a
// matrix footnote so a human decides whether to flip the marker. `unknown`
// rows are never fed in (checkCleanSignalDrift already guards this).
//
// Resolved to the same `targetLang` the matrix merge uses (clean fixture wins
// over its dirty sibling for the same base lang — resolveTargetLangRows is
// shared with updateMatrix below) so the console report and the footnote never
// disagree, and so typescript's clean-fixture verdict (the authoritative
// clean→clean observation) is what's compared, not the dirty fixture's
// diagnostic-neutral-edit approximation.
const driftWarnings = resolveTargetLangRows(rows)
	.filter((r) => !NATIVE_VARIANT_LANGS.has(r.lang))
	.map((r) => checkCleanSignalDrift(r, lookupSilentOnClean(r.lang)))
	.filter((d) => d.kind === "silent-not-marked" || d.kind === "marked-not-silent");
if (driftWarnings.length) {
	console.log(`\n  Drift vs server-strategies.ts silentOnClean marker (${driftWarnings.length} — telemetry only, never a CI gate):`);
	for (const d of driftWarnings) console.log(`    [${d.kind}] ${d.detail}`);
} else {
	console.log("\n  Drift vs server-strategies.ts silentOnClean marker: none.");
}
console.log(`\n  Tier 2  (publishes-versioned — affirmative + currency-proven):        ${t2v}`);
console.log(`  Tier 2* (publishes-unversioned — early-returns, currency correlated): ${t2u}`);
console.log(`  Tier 3  (silent on clean — budget-wait, the #458 target set):         ${t3}`);
console.log(`  unknown (slow/absent/ambiguous — conservative, not guessed):          ${unk}`);
console.log("  n/a (pull) rows are Tier 1 by protocol (#240), not probed.\n");

// Merge classifications into docs/lsp-capability-matrix.md — MERGE, don't
// overwrite: a server this run couldn't probe (unavailable/unknown on an
// ubuntu-poor host) keeps its prior dev-measured classification, and the row
// count never shrinks (#390). This script owns `clean-behavior` (+ `tier` for the
// push rows it classified) and bumps `src`; characterize owns `mode`. Rows that
// came back `unknown` are NOT written (don't blank a prior good value).
try {
	updateMatrix(rows);
} catch (e) {
	console.error(`matrix update skipped: ${e?.message ?? e}`);
}

console.error = realErr;
try { await resetLSPService?.({ fast: true }); } catch {}
process.exit(0);

// Resolve a `clean: true` fixture (e.g. typescript-clean) onto its base lang's
// row (typescript), winning over the dirty fixture's diagnostic-neutral-edit
// approximation for the same base lang — the ONE resolution rule shared by the
// console drift report and the matrix merge, so they never disagree. Only rows
// with a comparable classification are kept (mirrors `measurable` below).
function resolveTargetLangRows(measuredRows) {
	const measurable = measuredRows.filter(
		(r) =>
			r.behavior === "publishes-versioned" ||
			r.behavior === "publishes-unversioned" ||
			r.behavior === "silent",
	);
	const byTargetLang = new Map();
	for (const r of measurable) {
		const targetLang = r.cleanFixture ? r.lang.replace(/-clean$/, "") : r.lang;
		const prev = byTargetLang.get(targetLang);
		if (prev && prev.cleanFixture && !r.cleanFixture) continue; // clean fixture wins
		byTargetLang.set(targetLang, { ...r, lang: targetLang, targetLang });
	}
	return [...byTargetLang.values()];
}

function updateMatrix(measuredRows) {
	const docPath = path.join(repoRoot, "docs", "lsp-capability-matrix.md");
	if (!fs.existsSync(docPath)) {
		console.error(`matrix update skipped: ${docPath} not found (gitignored — nothing to merge)`);
		return;
	}
	const text = fs.readFileSync(docPath, "utf8");
	const marker = "| lang | server |";
	const tbl = parseTable(text, marker);
	if (!tbl) {
		console.error("matrix update skipped: capability table not found in doc");
		return;
	}
	// Only classifications we're confident in are authoritative — resolveTargetLangRows
	// already filters to publishes-versioned/publishes-unversioned/silent and applies
	// the clean-fixture-wins rule (a `clean: true` fixture like typescript-clean writes
	// to its BASE lang's row (typescript): a genuinely clean file is the authoritative
	// clean→clean observation, and typescript measurably re-publishes while dirty but
	// goes silent once clean — the clean-file behavior is the one #458 (and the
	// production budget-wait) cares about). `unknown`/`n/a (pull)`/`no-lsp` are NOT
	// written — don't clobber a prior dev-measured value with a CI non-result.
	const keyIdx = tbl.header.indexOf("lang");
	const srcIdx = tbl.header.indexOf("src");
	const existingByLang = new Map(tbl.rows.map((c) => [c[keyIdx], c]));
	const targetLangRows = resolveTargetLangRows(measuredRows);
	const measured = targetLangRows.map((r) => {
		const prior = existingByLang.get(r.targetLang);
		return {
			lang: r.targetLang,
			"clean-behavior": r.behavior,
			tier: r.tierLabel || String(r.tier),
			src: mergeSrc(prior ? prior[srcIdx] : "", src),
		};
	});
	const merged = mergeRows(
		tbl.rows,
		tbl.header,
		measured,
		"lang",
		["clean-behavior", "tier", "src"],
		{ updateOnly: true },
	);
	let out = replaceTable(text, marker, tbl.header, tbl.sep, merged);
	if (!out) out = text;

	// #529 drift footnote: same targetLangRows the table merge above just used
	// (clean fixture wins), so the footnote and the row it's about agree.
	// NEVER a CI gate — this only rewrites a footnote section in the doc.
	const footnoteWarnings = targetLangRows
		.filter((r) => !NATIVE_VARIANT_LANGS.has(r.lang))
		.map((r) => checkCleanSignalDrift(r, lookupSilentOnClean(r.lang)))
		.filter((d) => d.kind === "silent-not-marked" || d.kind === "marked-not-silent");
	out = writeDriftFootnote(out, footnoteWarnings);

	if (out !== text) {
		fs.writeFileSync(docPath, out);
		console.error(
			`Updated docs/lsp-capability-matrix.md clean-behavior column (${measured.length} servers classified, ${tbl.rows.length} rows preserved).`,
		);
	} else {
		console.error("matrix clean-behavior column: no changes.");
	}
}

// Replace the `## silentOnClean drift (nightly-generated)` section (own the
// span between that heading and the next `## `/EOF), so re-runs update rather
// than append. Telemetry only, per #529 — the section header says so.
function writeDriftFootnote(text, warnings) {
	const heading = "## silentOnClean drift (nightly-generated)";
	const lines = text.split("\n");
	const bodyLines = warnings.length
		? warnings.map((d) => `- **[${d.kind}]** ${d.detail}`)
		: ["_None observed as of the last probe run._"];
	const section = [
		heading,
		"",
		"Telemetry only — never a CI gate. Compares each probed server's observed",
		"`clean-behavior` against `clients/lsp/server-strategies.ts`'s `silentOnClean`",
		"marker; a mismatch means the marker may need a human update (#529). `unknown`",
		"observations are never compared (a slow/absent server is not evidence either way).",
		"",
		...bodyLines,
		"",
	];
	const headingIdx = lines.findIndex((l) => l.trim() === heading);
	if (headingIdx < 0) {
		// Trim any trailing blank lines already at EOF so we don't double them up.
		let trimmed = lines;
		while (trimmed.length && trimmed[trimmed.length - 1] === "") {
			trimmed = trimmed.slice(0, -1);
		}
		return [...trimmed, "", "", ...section].join("\n");
	}
	let end = lines.length;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	lines.splice(headingIdx, end - headingIdx, ...section);
	return lines.join("\n");
}
