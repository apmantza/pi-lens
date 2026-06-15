import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseElixirOutput } from "../../../../clients/dispatch/runners/elixir-check.js";

// Regression guard for #209: elixir-check was silently non-functional on modern
// Elixir. Two real bugs were found and fixed here, neither covered by the
// fallback-only runner test:
//   1. Elixir 1.16+ emits a multi-line "code snippet" diagnostic format with the
//      location on a trailing `└─ path:line:col` line — the old parser only
//      understood the legacy single-line / `warning:`-then-indented-path forms.
//   2. elixirc reports paths RELATIVE to its cwd, so the parser must resolve the
//      reported path against the runner cwd, not process.cwd().
describe("elixir-check output parser (parseElixirOutput)", () => {
	const cwd = path.resolve("/elixir-project");
	const target = path.join(cwd, "lib", "app.ex");

	it("parses a modern (1.16+) compile error with a cwd-relative snippet path", () => {
		const raw = [
			"    error: undefined function undefined_function/0 (expected App to define such a function)",
			"    │",
			"  4 │     undefined_function()",
			"    │     ^^^^^^^^^^^^^^^^^^",
			"    │",
			"    └─ lib/app.ex:4:5: App.greet/0",
			"",
			"== Compilation error in file lib/app.ex ==",
			"** (CompileError) lib/app.ex: cannot compile module App (errors have been logged)",
		].join("\n");

		const diagnostics = parseElixirOutput(raw, target, cwd);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			severity: "error",
			semantic: "blocking",
			line: 4,
			column: 5,
			tool: "elixir-check",
		});
		expect(diagnostics[0].message).toContain("undefined function");
	});

	it("parses a modern (1.16+) warning with a cwd-relative snippet path", () => {
		const raw = [
			'    warning: variable "x" is unused (if the variable is not meant to be used, prefix it with an underscore)',
			"    │",
			"  3 │     x = 1",
			"    │     ~",
			"    │",
			"    └─ lib/app.ex:3:5: App.greet/0",
			"",
		].join("\n");

		const diagnostics = parseElixirOutput(raw, target, cwd);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			severity: "warning",
			semantic: "warning",
			line: 3,
			column: 5,
		});
		expect(diagnostics[0].message).toContain("unused");
	});

	it("ignores diagnostics for files other than the target", () => {
		const raw = [
			"    error: something is wrong",
			"    └─ lib/other.ex:1:1: App.x/0",
		].join("\n");

		expect(parseElixirOutput(raw, target, cwd)).toHaveLength(0);
	});

	it("still parses the legacy single-line compile-error format", () => {
		const raw =
			"** (SyntaxError) lib/app.ex:1:1: unexpected end of file";

		const diagnostics = parseElixirOutput(raw, target, cwd);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			severity: "error",
			semantic: "blocking",
			line: 1,
			column: 1,
			rule: "SyntaxError",
		});
	});

	it("matches paths case-insensitively on win32 (lowercase drive letter)", () => {
		if (process.platform !== "win32") return;
		// Elixir lowercases the drive letter and uses forward slashes.
		const lowerDrive = target.replace(/^[A-Z]:/, (m) => m.toLowerCase()).replace(/\\/g, "/");
		const raw = [
			"    error: undefined function foo/0",
			`    └─ ${lowerDrive}:4:5: App.greet/0`,
		].join("\n");

		expect(parseElixirOutput(raw, target, cwd)).toHaveLength(1);
	});
});
