/**
 * Regression: #214 — the Windows cmd.exe spawn string escaped only the args,
 * not the command, so a tool whose path contains a space (e.g. Go installed at
 * `C:\Program Files\Go\bin\go.exe`) made cmd.exe parse `C:\Program` as the
 * command and fail with "'C:\Program' is not recognized". This silently broke
 * any tool under a spaced path on Windows (go-vet exposed it). The command is
 * now escaped like the args.
 */

import { describe, expect, it } from "vitest";
import { buildWindowsShellCommand } from "../../clients/safe-spawn.js";

describe("buildWindowsShellCommand (Windows cmd.exe quoting — #214)", () => {
	it("quotes a command path containing spaces", () => {
		const s = buildWindowsShellCommand("C:\\Program Files\\Go\\bin\\go.exe", [
			"vet",
			"x.go",
		]);
		expect(s).toContain('"C:\\Program Files\\Go\\bin\\go.exe"');
		// the command must be quoted as a single token, not split on the space
		expect(s).not.toMatch(/&& C:\\Program Files/);
	});

	it("leaves a space-free command unquoted (no regression for npm/.pi-lens paths)", () => {
		expect(buildWindowsShellCommand("ruff", ["check", "x.py"])).toBe(
			"chcp 65001 >nul 2>&1 && ruff check x.py",
		);
	});

	it("escapes args containing spaces too", () => {
		const s = buildWindowsShellCommand("tool", ["--path", "C:\\a b\\c.txt"]);
		expect(s).toContain('"C:\\a b\\c.txt"');
	});

	it("always prefixes the UTF-8 code-page switch", () => {
		expect(buildWindowsShellCommand("go", ["version"])).toMatch(
			/^chcp 65001 >nul 2>&1 && /,
		);
	});
});
