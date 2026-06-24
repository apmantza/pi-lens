// Behavioural fixture-style tests for every shipped ast-grep rule.
//
// The ast-grep CLI ships a dedicated test harness for this exact use case
// (https://ast-grep.github.io/guide/test-rule.html): you write one
// `<id>-test.yml` per rule in `rule-tests/`, listing `valid:` (must NOT
// match) and `invalid:` (must match) snippets, then `ast-grep test` runs
// them all. This file is the vitest wrapper — it shells out to that
// harness and asserts pass/fail per rule.
//
// Why this file exists alongside ast-grep-rule-validity.test.ts and
// ast-grep-catalog-rules.test.ts:
//   - ast-grep-rule-validity: every rule YAML must PARSE in napi (the
//     runner path). Catches malformed kinds / broken rule shape, NOT
//     behaviour.
//   - ast-grep-catalog-rules: ~10 catalog-derived rules get hand-written
//     positive/negative snippets, run via `ast-grep scan`.
//   - THIS file: every TS-family rule gets the guide-recommended
//     `<id>-test.yml` fixture form, run via `ast-grep test`. Opt-in
//     when `ast-grep` CLI is on PATH (same pattern as the catalog test).
//
// `--skip-snapshot-tests` because we only want behavioural
// valid/invalid coverage here, not byte-exact message/span output —
// snapshot drift is a different (per-rule) maintenance burden and adds
// nothing for "does this rule fire / not-fire" purposes.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const RULES_ROOT = path.join(process.cwd(), "rules", "ast-grep-rules");
const SGCONFIG_PATH = path.join(RULES_ROOT, ".sgconfig.yml");
const TEST_DIR = path.join(RULES_ROOT, "rule-tests");
const RULES_DIR = path.join(RULES_ROOT, "rules");

// opt-in: skip the whole suite if the `ast-grep` CLI isn't on PATH. CI
// installs it; the package is dev-only because users don't need it.
function probeCli(): boolean {
	try {
		execFileSync("ast-grep", ["--version"], {
			stdio: ["ignore", "ignore", "ignore"],
			// shell:true so the Windows .cmd shim resolves through
			// PATHEXT (mirrors ast-grep-catalog-rules.test.ts).
			shell: true,
		});
		return true;
	} catch {
		return false;
	}
}

const cliAvailable = probeCli();
const d = cliAvailable ? describe : describe.skip;

d("shipped ast-grep rules have fixture-style valid/invalid tests", () => {
	// Every test file in `rule-tests/` must (1) parse, (2) target a rule
	// that actually exists in `rules/`, and (3) the rule YAML must name
	// the same `id` as the test file's `id:`. Catches stale/orphaned
	// fixtures before `ast-grep test` even runs.
	const testFiles = fs.existsSync(TEST_DIR)
		? fs.readdirSync(TEST_DIR).filter((f) => f.endsWith("-test.yml"))
		: [];

	it("at least one test file exists", () => {
		expect(testFiles.length).toBeGreaterThan(0);
	});

	interface RuleEntry {
		id: string;
		language: string | undefined; // undefined ⇒ default to TypeScript (per rule schema)
	}
	const rules = fs
		.readdirSync(RULES_DIR)
		.filter((f) => f.endsWith(".yml"))
		.map((f): RuleEntry | undefined => {
			const text = fs.readFileSync(path.join(RULES_DIR, f), "utf8");
			const id = text.match(/^id:\s*(.+?)\s*$/m)?.[1];
			if (!id) return undefined;
			const language = text.match(/^language:\s*(.+?)\s*$/m)?.[1];
			return { id, language };
		})
		.filter((r): r is RuleEntry => Boolean(r));
	// TS-family = explicit TypeScript/TSX (any case) OR unspecified language
	// (the rule schema says unspecified defaults to TypeScript). Excludes JS,
	// Python, Rust, Go — those need their own fixture batches in a follow-up.
	const isTsFamily = (r: RuleEntry) => {
		const l = (r.language || "TypeScript").toLowerCase();
		return l === "typescript" || l === "tsx";
	};
	const tsRuleIds = new Set(rules.filter(isTsFamily).map((r) => r.id));
	const ruleIds = new Set(rules.map((r) => r.id));

	it("every test file's `id:` matches a real rule in rules/", () => {
		const orphans: string[] = [];
		for (const file of testFiles) {
			const m = fs
				.readFileSync(path.join(TEST_DIR, file), "utf8")
				.match(/^id:\s*(.+?)\s*$/m);
			const id = m?.[1];
			if (!id) {
				orphans.push(`${file}: missing id:`);
				continue;
			}
			if (!ruleIds.has(id)) {
				orphans.push(`${file}: id "${id}" not found in rules/`);
			}
		}
		expect(orphans, orphans.join("\n")).toEqual([]);
	});

	it("every TS-family rule has a corresponding -test.yml fixture", () => {
		// Contract: every TypeScript-language rule ships a fixture file
		// exercising its `valid:`/`invalid:` cases. JS/TSX/Python/Rust/Go
		// fixtures are deliberately out of scope here — they belong in
		// follow-up batches (each gets its own language-specific
		// contract). A missing fixture for a TS rule means the rule's
		// behavioural contract is untested, which is exactly what this
		// guard is meant to catch.
		const missing: string[] = [];
		for (const id of tsRuleIds) {
			const file = path.join(TEST_DIR, `${id}-test.yml`);
			if (!fs.existsSync(file)) missing.push(id);
		}
		expect(
			missing,
			`${missing.length} TS-family rule(s) missing fixture tests:\n${missing.join("\n")}`,
		).toEqual([]);
	});

	it("ast-grep test reports all fixtures pass (valid/invalid coverage)", () => {
		// shell:true so Windows .cmd shim resolves; -c explicit because
		// pi-lens's internal runner uses `.sgconfig.yml` (with the dot)
		// while ast-grep's default is `sgconfig.yml` (no dot).
		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		try {
			stdout = execFileSync(
				"ast-grep",
				["test", "-c", SGCONFIG_PATH, "--skip-snapshot-tests"],
				{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], shell: true },
			);
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; status?: number };
			stdout = e.stdout ?? "";
			stderr = e.stderr ?? "";
			exitCode = e.status ?? -1;
		}
		// ast-grep test prints a single dot per passing case; on
		// failure it appends "N" (noisy) and "M" (missing) markers
		// to the per-rule progress string and dumps per-case snippets
		// under "Case Details". Pull out the failing rule IDs so the
		// vitest failure message is actionable instead of a wall of
		// ANSI-coloured raw output.
		const failingRules = Array.from(stdout.matchAll(/^FAIL\s+(\S+)\s/gm)).map(
			(m) => m[1],
		);
		const summary = failingRules.length
			? `${failingRules.length} rule(s) failed ast-grep test:\n  - ${failingRules.join("\n  - ")}\n\nFirst failure detail:\n${stdout}`
			: stdout;
		expect(
			exitCode,
			`ast-grep test failed (exit ${exitCode})\n--- summary ---\n${summary}\n--- stderr ---\n${stderr}`,
		).toBe(0);
	});
});
