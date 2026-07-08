#!/usr/bin/env node
/**
 * Grammar-load health check (#423).
 *
 * A bad tree-sitter grammar WASM can crash the whole process — not throw, ABORT
 * (e.g. `tree-sitter-swift.wasm` @ tree-sitter-wasms 0.1.13 triggers a fatal V8
 * Turboshaft-WASM crash on Node 24). A crash like that can't be caught in-process,
 * so this loads + exercises EACH grammar in an isolated CHILD process and reports
 * which ones crash the runtime (non-zero exit / fatal signal) vs load cleanly.
 *
 *   node scripts/check-grammar-load.mjs            # parent: check every grammar
 *   node scripts/check-grammar-load.mjs <language> # child: load+exercise one grammar
 *
 * Requires a built dist (`npm run build`). Exits non-zero if any grammar crashes.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);

// A chunk of mixed punctuation/keywords/identifiers — not valid in any one
// language, but it drives the parser hard across every grammar, which is what
// heats the WASM enough for the background optimizer to (mis)compile it.
const STRESS = `
function foo(a, b) { if (a && b || c) { for (i in x) { return a ? b : c; } } }
class K extends Base { def method(self): try: pass except E: raise
fn bar<T>(x: i32) -> i32 { match x { 1 => {}, _ => {} } let y = |z| z + 1; }
func baz(a int) (int, error) { switch a { case 1: default: } select {} }
struct S { field: [i32; 4] } impl S { async fn go(&self) { await!(x); } }
`.repeat(40);

async function exerciseGrammar(languageId) {
	const { TreeSitterClient } = await import("../clients/tree-sitter-client.js");
	const client = new TreeSitterClient();
	if (!(await client.init())) {
		console.error("tree-sitter runtime unavailable");
		process.exit(2);
	}
	// Parse repeatedly to make the grammar WASM hot → triggers tiered/background
	// optimization, which is where the bad grammars abort.
	for (let i = 0; i < 200; i++) {
		const tree = await client.parseFile(`stress-${i}.src`, languageId, STRESS);
		if (!tree) {
			// Grammar couldn't be resolved/loaded (download failure, etc.) — not a
			// crash, but nothing was exercised. Report as unavailable.
			console.error(`grammar '${languageId}' did not load`);
			process.exit(3);
		}
	}
	// Give any background (Turboshaft) compilation time to run and, if it's going
	// to abort, abort — before we exit cleanly.
	await new Promise((r) => setTimeout(r, 1500));
	process.exit(0);
}

async function main() {
	const arg = process.argv[2];
	if (arg) {
		await exerciseGrammar(arg);
		return;
	}

	const { LANGUAGE_TO_GRAMMAR, grammarBlockReason } = await import(
		"../clients/grammar-source.js"
	);
	const languages = Object.keys(LANGUAGE_TO_GRAMMAR).sort();

	console.error(
		`[grammar-load-check] Node ${process.version} on ${process.platform}/${process.arch} — checking ${languages.length} grammars\n`,
	);

	const crashed = [];
	const unavailable = [];
	const blocked = [];
	for (const lang of languages) {
		// Grammars the runtime intentionally refuses to load on this runtime
		// (BLOCKED_GRAMMARS) are skipped here too — the runtime never loads them,
		// so exercising them would just reproduce the crash we already handle. A
		// crash from a NON-blocked grammar still fails this guard (hard gate).
		const blockReason = grammarBlockReason(LANGUAGE_TO_GRAMMAR[lang]);
		if (blockReason) {
			blocked.push(lang);
			console.error(`  block  ${lang} (${blockReason})`);
			continue;
		}
		const r = spawnSync(process.execPath, [HERE, lang], {
			timeout: 120_000,
			encoding: "utf8",
		});
		const code = r.status;
		const signal = r.signal;
		if (code === 0) {
			console.error(`  ok     ${lang}`);
		} else if (code === 3) {
			unavailable.push(lang);
			console.error(`  skip   ${lang} (grammar did not load — download/env)`);
		} else {
			// Non-zero exit / killed by signal / timeout = the runtime went down.
			const why = signal
				? `signal ${signal}`
				: r.error
					? String(r.error.message)
					: `exit ${code}`;
			const tail = (r.stderr || "").trim().split("\n").slice(-3).join(" | ");
			crashed.push({ lang, why, tail });
			console.error(`  CRASH  ${lang} (${why})  ${tail}`);
		}
	}

	console.error("\n[grammar-load-check] summary:");
	console.error(`  crashed:     ${crashed.map((c) => c.lang).join(", ") || "none"}`);
	console.error(`  unavailable: ${unavailable.join(", ") || "none"}`);
	console.error(`  blocked:     ${blocked.join(", ") || "none"}`);
	if (crashed.length > 0) {
		console.error(
			`\n✗ ${crashed.length} grammar(s) crash the runtime on this platform — they must be blocklisted (BLOCKED_GRAMMARS).`,
		);
		process.exit(1);
	}
	console.error("\n✓ all resolvable grammars load + parse without crashing.");
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
