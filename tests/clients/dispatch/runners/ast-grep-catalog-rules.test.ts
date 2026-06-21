// Guard for the catalog-derived rules ported in by the ast-grep catalog sweep.
// The existing ast-grep-rule-validity.test.ts validates TS/JS rules through
// the in-process napi engine, which only supports the JS/TS family. Go and
// Rust rules are loaded by the ast-grep LSP / CLI only — the napi runner
// skips non-TS/JS rules. This file validates the non-TS/JS catalog rules
// (and re-validates the TS/JS ones for parity) by running them through the
// real `ast-grep` CLI, the SAME engine the LSP uses.
//
// Validation strategy per rule:
//   1. positive case: code that should fire — exit code 1 (findings) and
//      the rule id appears in the output
//   2. negative case: code that should NOT fire — exit code 0
//   3. rule YAML must parse (the CLI's -r flag fails loudly on a malformed
//      rule, mirroring the LSP "first bad rule aborts the whole scan" hazard
//      documented in #239)
//
// The CLI is opt-in: if `ast-grep` is not on PATH the entire describe is
// skipped (`ast-grep` is bundled as a dev-time smoke tool, not a runtime
// dep). The probe runs synchronously at module load.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RULES_DIR = path.join(process.cwd(), "rules", "ast-grep-rules", "rules");

interface CatalogRule {
	id: string;
	file: string; // file under RULES_DIR
	language: "go" | "rust" | "typescript" | "javascript" | "tsx" | "cpp";
	// snippets that should produce a finding (positive) and should NOT
	// produce a finding (negative). One of each is enough; a finding or
	// its absence on the negative sample is what we assert.
	positive: string;
	negative: string;
	// file extension for the temp snippet
	ext: "go" | "rs" | "ts" | "js" | "tsx" | "cpp";
}

const CATALOG_RULES: CatalogRule[] = [
	{
		id: "unmarshal-tag-is-dash",
		file: "unmarshal-tag-is-dash.yml",
		language: "go",
		ext: "go",
		positive: `package main
type T struct {
\tB string \`json:"-,omitempty"\`
}
`,
		negative: `package main
type T struct {
\tA string \`json:"id"\`
}
`,
	},
	{
		id: "redundant-unsafe-function",
		file: "redundant-unsafe-function.yml",
		language: "rust",
		ext: "rs",
		positive: `unsafe fn redundant_unsafe() {
    println!("no unsafe block");
}
`,
		negative: `unsafe fn proper_unsafe() -> *const i32 {
    unsafe {
        let ptr = 0x1234 as *const i32;
        ptr
    }
}

fn regular_function() -> i32 { 42 }
`,
	},
	{
		id: "no-console-except-error",
		file: "no-console-except-error.yml",
		language: "typescript",
		ext: "ts",
		positive: `console.log("hi");\n`,
		negative: `try {} catch (e) { console.error(e); }\n`,
	},
	{
		id: "no-console-except-error-js",
		file: "no-console-except-error-js.yml",
		language: "javascript",
		ext: "js",
		positive: `console.log("hi");\n`,
		negative: `try {} catch (e) { console.error(e); }\n`,
	},
	{
		id: "missing-component-decorator",
		file: "missing-component-decorator.yml",
		language: "typescript",
		ext: "ts",
		positive: `class NoDecorator {
    ngOnInit() {}
}
`,
		negative: `@Component()
class HasDecorator {
    ngOnInit() {}
}
`,
	},
	{
		id: "avoid-duplicate-export",
		file: "avoid-duplicate-export.yml",
		language: "rust",
		ext: "rs",
		positive: `pub mod foo;
pub use foo::Foo;
`,
		negative: `pub use foo::A;
`,
	},
	{
		id: "rust-2024-let-chain-candidate",
		file: "rust-2024-let-chain-candidate.yml",
		language: "rust",
		ext: "rs",
		positive: `fn f(user: Option<i32>) {
    if let Some(u) = user {
        if u > 0 { println!("{u}"); }
    }
}
`,
		negative: `fn f(x: i32) -> i32 {
    if x > 0 { if x < 10 { x } else { 0 } } else { 0 }
}
`,
	},
	{
		id: "unnecessary-react-hook",
		file: "unnecessary-react-hook.yml",
		language: "tsx",
		ext: "tsx",
		positive: `function useIAmNotHookActually(args) {
    console.log("hi");
    return args.length;
}
`,
		negative: `function useTrueHook() {
    useEffect(() => { console.log("real"); });
}
`,
	},
	{
		id: "find-import-file-without-extension",
		file: "find-import-file-without-extension.yml",
		language: "typescript",
		ext: "ts",
		positive: `import {x} from "./localmod";
import("./dynamic1");
`,
		negative: `import {x} from "./localmod.js";
import {y} from "package";
`,
	},
	{
		id: "redundant-usestate-type",
		file: "redundant-usestate-type.yml",
		language: "tsx",
		ext: "tsx",
		positive: `function Component() {
    const [name, setName] = useState<string>('React');
    const [count, setCount] = useState<number>(0);
}
`,
		negative: `function Component() {
    const [items, setItems] = useState<Item[]>([]);
    const [value, setValue] = useState(42);
}
`,
	},
];

function probeCli(): boolean {
	try {
		// Windows: `ast-grep` ships as a .cmd shim, which `execFile` can't
		// resolve directly. `shell: true` lets the OS shell (cmd.exe on
		// Windows) find the shim through PATHEXT. CI on linux/macOS works
		// the same way — Node's execFile would still bypass PATHEXT there
		// only for .cmd-style shims, and shell: true is harmless.
		execFileSync("ast-grep", ["--version"], {
			stdio: ["ignore", "ignore", "ignore"],
			shell: true,
		});
		return true;
	} catch {
		return false;
	}
}

function runAstGrep(
	ruleFile: string,
	code: string,
	ext: string,
): {
	stdout: string;
	stderr: string;
	exitCode: number;
	fired: boolean;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-sg-"));
	const snippet = path.join(dir, `fixture.${ext}`);
	fs.writeFileSync(snippet, code, "utf-8");
	// shell: true so the Windows .cmd shim resolves through PATHEXT (see
	// probeCli comment for context).
	try {
		const stdout = execFileSync(
			"ast-grep",
			["scan", "-r", ruleFile, snippet, "--report-style", "short"],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], shell: true },
		);
		return { stdout, stderr: "", exitCode: 0, fired: stdout.length > 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		const stdout = e.stdout ?? "";
		// With shell: true on Windows the wrapper exit may be 0 even when
		// the underlying process exited 1. The actual diagnostic is in
		// stdout, so "fired" means "stdout is non-empty" — exit code alone
		// is unreliable here. We still capture it for the assertion message.
		return {
			stdout,
			stderr: e.stderr ?? "",
			exitCode: e.status ?? -1,
			fired: stdout.length > 0,
		};
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

const cliAvailable = probeCli();
const d = cliAvailable ? describe : describe.skip;

// A subset of the catalog rules have a non-trivial `fix:` field that the
// ast-grep LSP surfaces as a codeAction. These are the rules where the
// upstream catalog ships a mechanical rewrite (the others are either "manual
// refactor" hints with no `fix:` string, or framework migrations that
// intentionally don't auto-fix).
//
// Validation: run the rule through the real `ast-grep scan --json=compact`
// and assert the emitted JSON's `replacement` field matches the expected
// post-fix text. This catches:
//   - typos in the `fix:` string (wrong metavar name, etc.)
//   - a `fix:` that doesn't apply to the rule's actual `rule:` shape
//     (the napi runner doesn't validate this — it just reads `rule.fix` as
//     a string for fixSuggestion. Only the CLI/LSP engine actually
//     substitutes the metavars, so we run the real engine here as the
//     source of truth for the rewrite shape.)
const RULES_WITH_FIX: Array<{
	id: string;
	file: string;
	language: "typescript" | "javascript" | "tsx";
	ext: "ts" | "js" | "tsx";
	before: string;
	expectedReplacement: string;
}> = [
	{
		id: "no-console-except-error",
		file: "no-console-except-error.yml",
		language: "typescript",
		ext: "ts",
		before: `console.log("hi");\n`,
		expectedReplacement: "",
	},
	{
		id: "no-console-except-error-js",
		file: "no-console-except-error-js.yml",
		language: "javascript",
		ext: "js",
		before: `console.log("hi");\n`,
		expectedReplacement: "",
	},
	{
		id: "redundant-usestate-type",
		file: "redundant-usestate-type.yml",
		language: "tsx",
		ext: "tsx",
		before: `const [name, setName] = useState<string>('React');\n`,
		expectedReplacement: "useState('React')",
	},
	{
		id: "jsx-boolean-short-circuit",
		file: "jsx-boolean-short-circuit.yml",
		language: "tsx",
		ext: "tsx",
		// The rule narrows the finding to `$COND` being a literal number
		// or `$COND.length` (the classic `0 && ...` / `arr.length && ...`
		// footgun). The metavars are COND=items.length and JSX=<span>show</span>.
		before: `return <div>{items.length && <span>show</span>}</div>;\n`,
		expectedReplacement: "{items.length ? <span>show</span> : null}",
	},
];

d("catalog rules with `fix:` field — CLI rewrite end-to-end", () => {
	for (const rule of RULES_WITH_FIX) {
		const rulePath = path.join(RULES_DIR, rule.file);
		describe(`${rule.id}`, () => {
			it("rule YAML carries a `fix:` field (may be empty string for delete-rewrite)", () => {
				// Don't pin the exact string — the catalog may update the
				// rewrite wording. Just guard that the field is declared,
				// so the napi runner has something to put in fixSuggestion
				// and the LSP has a codeAction to expose. An empty `fix: ""`
				// is legitimate: it means "delete the matched node" (used
				// for rules like `no-console-except-error` where the right
				// fix is to remove the entire call).
				const yamlText = fs.readFileSync(rulePath, "utf-8");
				const m = yamlText.match(/^fix:\s*(.+?)\s*$/m);
				expect(
					m,
					`expected rule ${rule.id} to declare a fix: field — the catalog ships a mechanical rewrite; if the upstream changed, update the rule YAML`,
				).not.toBeNull();
				// The string `fix: ""` (delete rewrite) is valid. Anything
				// else must be at least 1 char of non-quote content.
				const raw = (m?.[1] ?? "").trim();
				const stripped = raw.replace(/^['"]|['"]$/g, "");
				if (raw !== '""' && raw !== "''") {
					expect(
						stripped.length,
						`fix: field for ${rule.id} is empty (got ${JSON.stringify(raw)})`,
					).toBeGreaterThan(0);
				}
			});

			it("ast-grep engine emits the expected `replacement` in the diagnostic JSON", () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-sg-fix-"));
				const snippet = path.join(dir, `fixture.${rule.ext}`);
				fs.writeFileSync(snippet, rule.before, "utf-8");
				// The CLI exits non-zero when the rule fires (a finding
				// counts as an error severity by default). The JSON
				// payload is on stdout regardless — catch the error
				// and just inspect stdout. With `shell: true` on Windows
				// the wrapper may collapse to exit 0, so this is belt-
				// and-suspenders against either shape.
				let stdout = "";
				try {
					stdout = execFileSync(
						"ast-grep",
						["scan", "-r", rulePath, snippet, "--json=compact"],
						{
							encoding: "utf-8",
							stdio: ["ignore", "pipe", "pipe"],
							shell: true,
						},
					);
				} catch (err) {
					stdout = (err as { stdout?: string }).stdout ?? "";
				} finally {
					try {
						fs.rmSync(dir, { recursive: true, force: true });
					} catch {
						// best-effort
					}
				}
				// `--json=compact` emits a single JSON array of findings.
				// The first finding carries the `replacement` we want to
				// verify; if a single snippet produces multiple matches
				// (rare for these rules), we assert on the first.
				const findings = JSON.parse(stdout) as Array<{
					replacement?: string;
				}>;
				expect(
					findings.length,
					`expected at least one finding for ${rule.id}`,
				).toBeGreaterThan(0);
				expect(findings[0]?.replacement).toBe(rule.expectedReplacement);
			});
		});
	}
});

d("catalog-derived ast-grep rules fire via CLI", () => {
	for (const rule of CATALOG_RULES) {
		const rulePath = path.join(RULES_DIR, rule.file);

		describe(`${rule.id} (${rule.language})`, () => {
			it("rule file exists", () => {
				expect(fs.existsSync(rulePath)).toBe(true);
			});

			it("positive sample produces a finding (rule id in output)", () => {
				const { stdout, fired } = runAstGrep(rulePath, rule.positive, rule.ext);
				expect(fired, `expected findings; got empty stdout`).toBe(true);
				expect(stdout).toContain(rule.id);
			});

			it("negative sample produces no finding (empty stdout)", () => {
				const { stdout, fired } = runAstGrep(rulePath, rule.negative, rule.ext);
				expect(fired, `expected clean; got stdout:\n${stdout}`).toBe(false);
			});
		});
	}
});
