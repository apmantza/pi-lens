import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatWithheldBlockerLine } from "../../clients/pipeline.js";

/**
 * #5784: the withheld line names the one fact that decides what an agent should
 * do next — whether the findings it shows were re-checked on this write.
 *
 * A withheld finding recorded by an earlier check that this write did not
 * re-check (its runner or server reached no verdict, or its edit-range gate kept
 * it outside these bytes) cannot be retired by fixing the code: only a run that
 * re-checks the file judges it. The line used to say only "cannot confirm this
 * call wrote it. If this call wrote it, fix them.", which reads as "re-verify";
 * re-reading never changes that verdict, and a real dispatch spent its budget
 * re-reading the file until it timed out.
 *
 * Defect shape 10, silencing as fixing: the verdict's state is disclosed on the
 * surface that renders it.
 */
const blocker = (line: number): Diagnostic => ({
	id: `b${line}`,
	message: "m",
	filePath: "/p/a.ts",
	line,
	rule: "debugger-statement",
	severity: "error",
	semantic: "blocking",
	tool: "ast-grep-napi",
});

describe("formatWithheldBlockerLine, the carried count (#5784)", () => {
	it("says nothing about a re-check when every finding is this write's own", () => {
		expect(
			formatWithheldBlockerLine([blocker(1)], "/p/a.ts", "a.ts", "changed"),
		).toBe(
			"\u26a0 1 blocking finding in a.ts (L1 debugger-statement) withheld: the file changed while this call ran, but pi-lens cannot confirm this call wrote it. If this call wrote it, fix it. lens_diagnostics mode=all lists it.",
		);
	});

	it("names the re-check a single recorded finding needs, and the probe that does it", () => {
		const line = formatWithheldBlockerLine(
			[blocker(1)],
			"/p/a.ts",
			"a.ts",
			"changed",
			"pi",
			1,
		);
		expect(line).toContain(
			"1 recorded earlier was not re-checked on this write, so fixing the code cannot retire it; lens_diagnostics source=lsp path=a.ts settles it.",
		);
		// The pointer to the listing call survives: the agent still needs it to
		// see all of them.
		expect(line).toContain("lens_diagnostics mode=all lists it.");
	});

	it("counts in the plural, and keeps the line about this call's authorship", () => {
		const line = formatWithheldBlockerLine(
			[blocker(1), blocker(2)],
			"/p/a.ts",
			"a.ts",
			"named",
			"pi",
			2,
		);
		expect(line).toContain(
			"2 recorded earlier were not re-checked on this write, so fixing the code cannot retire them; lens_diagnostics source=lsp path=a.ts settles them.",
		);
		expect(line).toContain(
			"this call names the file, but pi-lens could not confirm the call changed it",
		);
		expect(line).toContain("If this call wrote it, fix them.");
		expect(line).toContain("recorded earlier");
	});

	it("names the diagnostics tool of its host, not the pi one", () => {
		const line = formatWithheldBlockerLine(
			[blocker(1), blocker(2)],
			"/p/a.ts",
			"a.ts",
			"changed",
			"mcp",
			2,
		);
		expect(line).toContain(
			"pilens_diagnostics source=lsp path=a.ts settles them",
		);
		expect(line).not.toMatch(/(?<!pi)lens_diagnostics/);
	});
});
