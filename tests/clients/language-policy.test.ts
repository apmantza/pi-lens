import { describe, expect, it } from "vitest";
import {
	canRunStartupHeavyScans,
	getLspCapableKinds,
	getPrimaryDispatchGroup,
} from "../../clients/language-policy.js";
import { getDefaultStartupTools } from "../../clients/language-profile.js";

describe("language-policy", () => {
	it("exposes LSP-capable kinds from centralized policy", () => {
		const kinds = getLspCapableKinds();
		expect(kinds).toContain("python");
		expect(kinds).toContain("yaml");
		expect(kinds).toContain("java");
		expect(kinds).toContain("kotlin");
		expect(kinds).toContain("elixir");
		expect(kinds).toContain("swift");
		expect(kinds).toContain("zig");
		// markdown gained a primary LSP (marksman, #274).
		expect(kinds).toContain("markdown");
		expect(kinds).not.toContain("sql");
	});

	it("gates config-sensitive startup defaults while keeping core defaults", () => {
		const profile = {
			present: {
				jsts: true,
				python: true,
				go: false,
				rust: false,
				cxx: false,
				cmake: false,
				shell: false,
				json: false,
				markdown: false,
				css: false,
				yaml: true,
				sql: true,
				ruby: false,
			},
			configured: {
				jsts: false,
				python: false,
				yaml: true,
				sql: false,
			},
			counts: {},
			detectedKinds: ["jsts", "python", "yaml", "sql"],
		} as const;

		const tools = getDefaultStartupTools(
			profile as unknown as import("../../clients/language-policy.js").ProjectLanguageProfile,
		);
		expect(tools).toContain("pyright");
		expect(tools).toContain("ruff");
		expect(tools).not.toContain("typescript-language-server");
		expect(tools).toContain("yamllint");
		expect(tools).not.toContain("sqlfluff");
	});

	it("uses centralized heavy-scan gate policy", () => {
		const profile = {
			present: {
				jsts: true,
				python: false,
				go: false,
				rust: false,
				cxx: false,
				cmake: false,
				shell: false,
				json: false,
				markdown: false,
				css: false,
				yaml: false,
				sql: false,
				ruby: false,
			},
			configured: { jsts: false },
			counts: {},
			detectedKinds: ["jsts"],
		} as const;

		expect(
			canRunStartupHeavyScans(
				profile as unknown as import("../../clients/language-policy.js").ProjectLanguageProfile,
				"jsts",
			),
		).toBe(false);
		const configured = { ...profile, configured: { jsts: true } };
		expect(
			canRunStartupHeavyScans(
				configured as unknown as import("../../clients/language-policy.js").ProjectLanguageProfile,
				"jsts",
			),
		).toBe(true);
	});

	it("provides language primary dispatch fallback groups", () => {
		const py = getPrimaryDispatchGroup("python", true);
		expect(py?.runnerIds).toEqual(["lsp", "pyright"]);

		const pyNoLsp = getPrimaryDispatchGroup("python", false);
		expect(pyNoLsp?.runnerIds).toEqual(["pyright"]);

		const sql = getPrimaryDispatchGroup("sql", true);
		expect(sql?.runnerIds).toEqual(["sqlfluff"]);

		const html = getPrimaryDispatchGroup("html", true);
		expect(html?.runnerIds).toEqual(["lsp", "htmlhint"]);

		const powershell = getPrimaryDispatchGroup("powershell", false);
		expect(powershell?.runnerIds).toEqual(["psscriptanalyzer"]);

		const java = getPrimaryDispatchGroup("java", true);
		expect(java?.runnerIds).toEqual(["lsp", "javac"]);

		const csharp = getPrimaryDispatchGroup("csharp", false);
		expect(csharp?.runnerIds).toEqual(["dotnet-build"]);

		const cxx = getPrimaryDispatchGroup("cxx", false);
		expect(cxx?.runnerIds).toEqual(["cpp-check"]);

		const terraform = getPrimaryDispatchGroup("terraform", true);
		expect(terraform?.runnerIds).toEqual(["lsp", "tflint"]);

		const kotlin = getPrimaryDispatchGroup("kotlin", false);
		expect(kotlin?.runnerIds).toEqual(["ktlint"]);

		const dart = getPrimaryDispatchGroup("dart", false);
		expect(dart?.runnerIds).toEqual(["dart-analyze"]);

		const zig = getPrimaryDispatchGroup("zig", false);
		expect(zig?.runnerIds).toEqual(["zig-check"]);

		const gleam = getPrimaryDispatchGroup("gleam", false);
		expect(gleam?.runnerIds).toEqual(["gleam-check"]);

		const elixir = getPrimaryDispatchGroup("elixir", false);
		expect(elixir?.runnerIds).toEqual(["elixir-check", "credo"]);
	});

	it("keeps zig compile coverage active even when lsp is enabled", () => {
		const zig = getPrimaryDispatchGroup("zig", true);
		expect(zig?.mode).toBe("all");
		expect(zig?.runnerIds).toEqual(["lsp", "zig-check"]);
	});

	// #274: markdown's primary group now runs the LSP (marksman) ALONGSIDE the
	// prose runners (mode "all"), and drops only the lsp when LSP is disabled.
	it("runs the markdown LSP alongside spellcheck/vale, and drops it when lsp is off", () => {
		const md = getPrimaryDispatchGroup("markdown", true);
		expect(md?.mode).toBe("all");
		expect(md?.runnerIds).toEqual(["lsp", "spellcheck", "vale"]);

		const mdNoLsp = getPrimaryDispatchGroup("markdown", false);
		expect(mdNoLsp?.runnerIds).toEqual(["spellcheck", "vale"]);
	});
});
