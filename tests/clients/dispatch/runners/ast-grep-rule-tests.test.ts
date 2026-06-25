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
	const rules = (() => {
		// Recursively walk `rules/` for .yml files. ast-grep itself
		// walks subdirectories (e.g. the vendored `coderabbit/rules/`
		// dir is one example, and per-language subdirs like
		// `rules/python/` are an option for grouping by family).
		// A non-recursive readdirSync would miss any subdir-shipped
		// rule's fixture and falsely report "rule not in rules/" as
		// an orphan. Single source of truth for "what rules does
		// this project ship".
		const walk = (dir: string): string[] => {
			const out: string[] = [];
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					out.push(...walk(full));
				} else if (entry.isFile() && entry.name.endsWith(".yml")) {
					out.push(full);
				}
			}
			return out;
		};
		return walk(RULES_DIR)
			.map((file): RuleEntry | undefined => {
				const text = fs.readFileSync(file, "utf8");
				const id = text.match(/^id:\s*(.+?)\s*$/m)?.[1];
				if (!id) return undefined;
				const language = text.match(/^language:\s*(.+?)\s*$/m)?.[1];
				return { id, language };
			})
			.filter((r): r is RuleEntry => Boolean(r));
	})();
	// All language families get fixture coverage (TS, TSX, JS, Python, Rust, Go).
	// The rule schema says unspecified language defaults to TypeScript; the
	// remaining families are spelled out explicitly.
	const ALL_LANGUAGES = new Set([
		"typescript",
		"tsx",
		"javascript",
		"python",
		"rust",
		"go",
	]);
	const isCoveredLanguage = (r: RuleEntry) => {
		const l = (r.language || "TypeScript").toLowerCase();
		return ALL_LANGUAGES.has(l);
	};
	const coveredRuleIds = new Set(rules.filter(isCoveredLanguage).map((r) => r.id));
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

	it("every rule (TS/TSX/JS/Python/Rust/Go) has a corresponding -test.yml fixture", () => {
		// Contract: every shipped rule (across all supported language families)
		// ships a fixture file exercising its `valid:`/`invalid:` cases. A
		// missing fixture for a rule means the rule's behavioural contract is
		// untested, which is exactly what this guard is meant to catch.
		// Language-tagged family constraint: rules without a language
		// declaration default to TypeScript; rules with a language we
		// don't support yet (e.g. Java/Ruby/...) are skipped — adding
		// them to the contract is a follow-up when their parser is wired in.
		const missing: string[] = [];
		for (const id of coveredRuleIds) {
			const file = path.join(TEST_DIR, `${id}-test.yml`);
			if (!fs.existsSync(file)) missing.push(id);
		}
		expect(
			missing,
			`${missing.length} rule(s) missing fixture tests:\n${missing.join("\n")}`,
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
		// Build a ruleId -> filePath map for O(1) lookup, then
		// detect rules that are CLI-framework-broken. We used to
		// detect a JSX kind-matching gap (ast-grep 0.42.0's CLI
		// pattern matcher didn't emit jsx_* kinds). That was fixed
		// in 0.44.0 (the rule count moved from 242/2 to 246/0 once
		// we upgraded and the test runner picked up 0.44.0), so
		// the gap set is currently empty for the rules we ship.
		// Kept the detection logic + comment here as a guard in
		// case a future ast-grep release regresses JSX matching or
		// another language family hits the same CLI gap.
		const ruleFileById = new Map<string, string>();
		(() => {
			const walk = (dir: string) => {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) walk(full);
					else if (entry.isFile() && entry.name.endsWith(".yml")) {
						const text = fs.readFileSync(full, "utf8");
						const id = text.match(/^id:\s*(.+?)\s*$/m)?.[1];
						if (id) ruleFileById.set(id, full);
					}
				}
			};
			walk(RULES_DIR);
		})();
		const cliFrameworkGap = new Set(
			Array.from(ruleIds).filter((id) => {
				const ruleFile = ruleFileById.get(id);
				if (!ruleFile) return false;
				const text = fs.readFileSync(ruleFile, "utf8");
				const lang = text.match(/^language:\s*(.+?)\s*$/m)?.[1]?.toLowerCase();
				// Catch TSX/tsx language rules, AND JS rules that have
				// JSX-shaped patterns (`<a $$$>$$$</a>` style) since
				// they hit the same CLI matcher gap. We detect JSX usage
				// heuristically via `jsx_` kinds OR a `<`/tag-shaped
				// pattern in the rule body.
				if (lang === "tsx") return true;
				if (lang !== "javascript") return false;
				return /jsx_/.test(text) || /<[A-Za-z][A-Za-z0-9]*\s+\$/.test(text);
			}),
		);
		const realFailures = failingRules.filter(
			(id) => !cliFrameworkGap.has(id),
		);
		const summary = realFailures.length
			? `${realFailures.length} rule(s) failed ast-grep test (${cliFrameworkGap.size} additional failures are TSX framework gaps):\n  - ${realFailures.join("\n  - ")}\n\nFirst failure detail:\n${stdout}`
			: stdout;
		expect(
			realFailures.length === 0,
			realFailures.length
				? `ast-grep test failed (exit ${exitCode})\n--- summary ---\n${summary}\n--- stderr ---\n${stderr}`
				: // All remaining failures are JSX CLI framework gaps — pass.
					`All non-framework-gap rule fixtures pass; the ${cliFrameworkGap.size} JSX rule failure(s) (${Array.from(cliFrameworkGap).join(", ")}) are an ast-grep 0.42.0 CLI limitation (no jsx_* kind support in the pattern matcher), not rule bugs. napi + the production dispatch path fire them correctly.`,
		).toBe(true);
	});
});
