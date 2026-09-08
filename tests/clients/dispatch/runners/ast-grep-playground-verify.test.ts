/**
 * Test the playground-verifier pipeline end-to-end. The verifier spins up
 * a headless Chrome, navigates to https://ast-grep.github.io/playground.html
 * with the rule YAML and the caller's source encoded in the URL hash, then
 * scrapes the "Found N match(es)" / "No match found" text. This test asserts
 * the pipeline runs without error, actually evaluates the caller's `--code`
 * (not a fallback sample), and produces a non-error result for a known-good
 * rule.
 *
 * #2208: the verifier used to write the caller's code into the playground's
 * `query` field, which only feeds its separate "Pattern" mode. In "Config"
 * mode (what this verifier always uses) the engine matches against
 * `state.source` instead, so the hash carried no `source` at all and the
 * playground's state merge silently fell back to its own hardcoded sample.
 * Every run graded the rule against that fixed sample — `--code` was inert —
 * so `matches` was 0 (or whatever the sample produced) regardless of what
 * was actually passed in. "smoke: loads the playground and reports a
 * known-good rule's match count against the caller's code" below is the
 * fix's regression test: a rule + a snippet it demonstrably matches, which
 * reported 0 before the fix (`source` now carries `--code`).
 *
 * Skipped when:
 *   - Google Chrome is not on PATH (and PILENS_PLAYGROUND_CHROME is unset)
 *   - the playground URL can't be reached (offline / firewalled CI)
 *
 * Slow path (~15s per rule): the playground is a Docusaurus + VitePress SPA
 * with heavy JS bundles; first-load is the dominant cost. Don't enable this
 * in the default `npm test` run; it's opt-in for local dev / nightly.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeSpawnAsync } from "../../../../clients/safe-spawn.js";

const SCRIPT = join(process.cwd(), "scripts", "playground-verify-rule.mjs");
const CHROME_CANDIDATES: string[] = [
	process.env.PILENS_PLAYGROUND_CHROME,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter((p): p is string => Boolean(p));

function chromeAvailable(): boolean {
	return CHROME_CANDIDATES.some((p) => existsSync(p));
}

const RULES_DIR = join(process.cwd(), "rules", "ast-grep-rules", "rules");

interface VerifyResult {
	ok: boolean;
	rule_id?: string;
	matches?: number;
	lines?: number[];
	fix?: string | null;
	error?: string;
	engine_ms?: number;
}

// #902: was a hand-rolled `spawn(process.execPath, ...)` promise wrapper.
// `safeSpawnAsync` (shared with production, `clients/safe-spawn.ts`) already
// does timeout+kill, stdout/stderr accumulation, and spawn-error surfacing —
// reusing it here instead of a second, hand-rolled spawn strategy (single
// source of truth, #883). Behavior preserved: a spawn error or timeout still
// rejects (via `result.error`), and a non-JSON stdout tail still rejects with
// the same diagnostic message shape.
async function runVerify(
	ruleFile: string,
	args: string[] = [],
	timeoutMs = 60_000,
): Promise<VerifyResult> {
	const result = await safeSpawnAsync(
		process.execPath,
		[SCRIPT, ruleFile, ...args],
		{
			timeout: timeoutMs,
		},
	);
	if (result.error) throw result.error;
	// A clean run's JSON result is on stdout. Setup/engine errors
	// (`ok: false`, exit 2 or 3) go through `console.error` instead, so
	// their JSON lands on stderr — fall back there when stdout is empty.
	const last =
		result.stdout.trim().split("\n").pop() ||
		result.stderr.trim().split("\n").pop() ||
		"";
	try {
		return JSON.parse(last);
	} catch {
		throw new Error(
			`failed to parse result (exit ${result.status}): stdout=${result.stdout.slice(0, 300)} stderr=${result.stderr.slice(0, 300)}`,
		);
	}
}

const skip = !chromeAvailable()
	? "Google Chrome not on PATH (set PILENS_PLAYGROUND_CHROME)"
	: false;

(skip ? describe.skip : describe)(
	"playground-verify-rule.mjs (headless CDP)",
	() => {
		it("smoke: loads the playground and reports a known-good rule's match count against the caller's code", async () => {
			// #2208 regression test (acceptance criterion 2): a rule and a
			// snippet it demonstrably matches. console.log(...) is exactly what
			// no-console-except-error's pattern fires on. Before the fix this
			// reported 0 — `--code` never reached the upstream engine, which
			// matched against the playground's own hardcoded sample instead.
			const result = await runVerify(
				join(RULES_DIR, "no-console-except-error.yml"),
				["--code", "console.log('x');", "--keep-chrome", "--timeout", "30000"],
			);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			expect(result.rule_id).toBe("no-console-except-error");
			expect(result.matches).toBeGreaterThanOrEqual(1);
		}, 60_000);

		it("rule with no match in the caller's code reports 0 (not an error)", async () => {
			// jsx-boolean-short-circuit requires `cond.length && <jsx-element>`.
			// Plain code with no JSX genuinely produces 0 matches — this must
			// stay distinguishable from an evaluation error (ok:false, exit 3),
			// which is what the harness reports when the playground never
			// renders "Found N match(es)" / "No match found" at all.
			const result = await runVerify(
				join(RULES_DIR, "jsx-boolean-short-circuit.yml"),
				["--code", "const a = 1;", "--keep-chrome", "--timeout", "30000"],
			);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			expect(result.rule_id).toBe("jsx-boolean-short-circuit");
			expect(result.matches).toBe(0);
			expect(result.fix).toBe("{$COND ? $JSX : null}");
		}, 60_000);

		it("reports a genuine match for a JSX snippet the rule is written to catch", async () => {
			// #2208: adapted from the issue's evidence. The issue's own snippet
			// used a self-closing `<b/>`, which is a `jsx_self_closing_element`
			// node — the rule requires `kind: jsx_element` on the `&&`'s right
			// side, so that exact snippet was already a correct 0-match result
			// (mis-specified repro, confirmed with `ast-grep scan --rule ... `
			// plus `--debug-query ast`, and noted on the issue). Swapping to a
			// non-self-closing `<b>hi</b>` keeps the issue's shape (`.length &&
			// <jsx>`) while producing a snippet the rule genuinely catches. It
			// reported 0 matches from the playground before the fix, because
			// the snippet was written into `query` (Pattern mode only) instead
			// of `source` (what Config mode actually matches against).
			const result = await runVerify(
				join(RULES_DIR, "jsx-boolean-short-circuit.yml"),
				[
					"--code",
					"const A = () => <div>{items.length && <b>hi</b>}</div>;",
					"--keep-chrome",
					"--timeout",
					"30000",
				],
			);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			expect(result.rule_id).toBe("jsx-boolean-short-circuit");
			expect(result.matches).toBeGreaterThanOrEqual(1);
		}, 60_000);
	},
);

// This case fails before ensureChrome() ever runs (main() checks the rule
// file exists first), so it doesn't need Chrome and isn't gated by `skip`.
describe("playground-verify-rule.mjs setup errors", () => {
	it("an evaluation error is distinguishable from a genuine zero-match result", async () => {
		// A rule file that doesn't exist can never reach the playground —
		// the harness must fail with ok:false + a setup error, never with
		// the same {ok:true, matches:0} shape a clean run produces. This
		// pins the "empty result must distinguish clean from errored"
		// contract the #2208 bug violated implicitly (the harness never
		// errored even though it wasn't evaluating the caller's code).
		const result = await runVerify(join(RULES_DIR, "does-not-exist-2208.yml"), [
			"--code",
			"console.log('x');",
		]);
		expect(result.ok).toBe(false);
		expect(result.matches).toBeUndefined();
		expect(result.error).toMatch(/rule not found/);
	}, 15_000);
});
// flake-shape: real-process-spawn — the real playground verifier subprocess boundary is part of contention
