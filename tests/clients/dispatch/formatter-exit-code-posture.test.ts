/**
 * Formatter exit-code posture guard (#1337, generalizing #1336).
 *
 * #1336: `ruff format` rejected invented `--indent-style` flags and exited 2.
 * Exit-code strictness was OPT-IN (`strictExitCode`) and ruff had not opted in,
 * so `formatFile` ignored the exit, read the untouched file back, and returned
 * `{ success: true, changed: false }` — byte-identical to "already formatted".
 * Every unconfigured Python file silently went unformatted for a release cycle.
 *
 * The flag was the accident; the DEFAULT was the defect. #1337 inverts it: the
 * seam is strict unless a formatter carries `lenientExitCode`, whose value is
 * the documented benign-nonzero evidence (a string, so the justification is
 * structurally required — an opt-out cannot be added without writing why).
 *
 * Two layers here:
 *  1. POSTURE — a static audit of every entry in ALL_FORMATTERS, pinning the
 *     lenient set so a new opt-out cannot ride in unnoticed.
 *  2. SEAM — the behavior itself: a nonzero exit from a formatter that has not
 *     opted out must never read as `{ success: true, changed: false }`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../test-utils.js";

const safeSpawnAsync = vi.fn();
vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	which: vi.fn(async () => null),
}));

// The compiled .js is what ships and what production loads — the build
// freshness guard (tests/support/check-build-freshness.ts) keeps it in step.
async function loadFormatters() {
	return await import("../../../clients/formatters.js");
}

function writeFormatterAgreementEvidence(tmpDir: string): void {
	const nodeTools = {
		"@biomejs/biome": "1.0.0",
		prettier: "3.0.0",
		oxfmt: "0.66.0",
	};
	fs.writeFileSync(
		path.join(tmpDir, "package.json"),
		JSON.stringify({
			devDependencies: Object.fromEntries(
				Object.entries(nodeTools).map(([name, version]) => [
					name,
					`^${version}`,
				]),
			),
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: Object.fromEntries(
				Object.entries(nodeTools).map(([name, version]) => [
					`node_modules/${name}`,
					{ version },
				]),
			),
		}),
	);
	for (const file of [
		"pyproject.toml",
		"requirements.txt",
		"Gemfile",
		"Cargo.toml",
		"go.mod",
		"build.zig",
		"pubspec.yaml",
		".editorconfig",
		".ocamlformat",
		".clang-format",
		"gleam.toml",
		".terraform.lock.hcl",
		".php-cs-fixer.php",
		".csharpierrc",
		".fantomasignore",
		".swiftformat",
		"stylua.toml",
		".ormolu",
		"taplo.toml",
		".google-java-format",
		".cljfmt.edn",
		".cmake-format",
		"PSScriptAnalyzerSettings.psd1",
		".formatter.exs",
		".ktfmt",
		"terragrunt.hcl",
	]) {
		const content =
			file === "pyproject.toml"
				? "[tool.black]\n[tool.ruff]\n"
				: file === "requirements.txt"
					? "sqlfluff\n"
					: file === "Gemfile"
						? 'gem "rubocop"\ngem "standard"\n'
						: file === "Cargo.toml"
							? '[package]\nname = "probe"\nversion = "0.1.0"\n'
							: file === "go.mod"
								? "module example.com/probe\n"
								: "\n";
		fs.writeFileSync(path.join(tmpDir, file), content);
	}
	fs.mkdirSync(path.join(tmpDir, "cue.mod"));
}

/**
 * The ONLY formatters allowed a benign nonzero exit: lint-autofixers, which
 * report remaining offenses through the exit status AFTER a successful rewrite.
 * Everything else is a pure formatter — nonzero means the rewrite never
 * happened. Adding a name here requires per-tool evidence in the definition.
 */
const EXPECTED_LENIENT = new Set([
	"rubocop",
	"standardrb",
	"ktlint",
	"sqlfluff",
]);

describe("formatter exit-code posture (#1337)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("pins the exact set of formatters that opt out of exit-code strictness", async () => {
		const { ALL_FORMATTERS } = await loadFormatters();
		const lenient = ALL_FORMATTERS.filter((f) => f.lenientExitCode).map(
			(f) => f.name,
		);
		expect(new Set(lenient)).toEqual(EXPECTED_LENIENT);
	});

	it("requires a substantive justification on every opt-out", async () => {
		const { ALL_FORMATTERS } = await loadFormatters();
		for (const formatter of ALL_FORMATTERS.filter((f) => f.lenientExitCode)) {
			expect(
				(formatter.lenientExitCode ?? "").trim().length,
				`${formatter.name}: lenientExitCode must carry the documented benign-nonzero evidence, not a placeholder`,
			).toBeGreaterThan(40);
		}
	});

	// biome is the formatter the first pass of this audit got WRONG: it exits 1
	// with "No files were processed in the specified paths" whenever the path is
	// ignored by the repo's own biome.json or has an extension biome does not
	// handle. In a biome-configured repo, biome is selected for every matching
	// file INCLUDING ignored ones, so without --no-errors-on-unmatched the strict
	// default reports a formatting failure on every edit under gen/, dist/, or
	// any vendored dir. Verified against biome 2.4.12; the lint runner
	// (clients/dispatch/runners/biome-check.ts) already passed this flag.
	it("passes --no-errors-on-unmatched on every biome command path", async () => {
		const { biomeFormatter } = await loadFormatters();
		expect(biomeFormatter.command).toContain("--no-errors-on-unmatched");

		const env = setupTestEnvironment("pi-lens-biome-unmatched-");
		try {
			// An indented file so indentationArgs resolves rather than SKIP_FORMATTING.
			const filePath = path.join(env.tmpDir, "app.js");
			fs.writeFileSync(filePath, "function f() {\n  return 1;\n}\n");
			// Plant a node_modules/.bin/biome so the local branch resolves
			// deterministically — no `if (resolved)` guard that could skip the
			// assertion. All three resolveCommand branches spread the same `args`.
			const binDir = path.join(env.tmpDir, "node_modules", ".bin");
			fs.mkdirSync(binDir, { recursive: true });
			for (const name of ["biome", "biome.cmd"]) {
				fs.writeFileSync(path.join(binDir, name), "");
			}

			const resolved = await biomeFormatter.resolveCommand?.(
				filePath,
				env.tmpDir,
			);

			expect(Array.isArray(resolved)).toBe(true);
			expect(resolved as string[]).toContain("--no-errors-on-unmatched");
			// The flag must precede the file path, not trail it as a stray arg.
			const args = resolved as string[];
			expect(args.indexOf("--no-errors-on-unmatched")).toBeLessThan(
				args.indexOf(filePath),
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("formatFile is strict by default at the seam (#1337)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	// The real-definition case, and the one that mutation-verifies the fix:
	// gofmt had NO strictExitCode before #1337. `gofmt -w` exits 2 on a file it
	// cannot parse (verified locally against Go's gofmt) and leaves it untouched.
	// Pre-fix, that returned { success: true, changed: false } — a syntax error
	// reported to the user as "already formatted".
	it("a nonzero exit from gofmt is a failure, not a clean no-op", async () => {
		const env = setupTestEnvironment("pi-lens-exit-posture-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "go.mod"),
				"module example.com/probe\n",
			);
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(filePath, "package main\nfunc main( {\n");
			safeSpawnAsync.mockResolvedValue({
				status: 2,
				stdout: "",
				stderr: "main.go:2:12: expected ')', found '{'",
			});

			const { formatFile, gofmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, gofmtFormatter);

			expect(result).not.toEqual({ success: true, changed: false });
			expect(result.success).toBe(false);
			expect(result.changed).toBe(false);
			expect(result.error).toContain("expected");
		} finally {
			env.cleanup();
		}
	});

	// Whole-registry sweep. `resolveCommand` is stripped so the seam — not each
	// tool's binary discovery — is what is under test; every other field,
	// crucially `lenientExitCode`, comes from the real definition.
	it("every formatter without an opt-out reports failure on a nonzero exit", async () => {
		const { ALL_FORMATTERS, formatFile } = await loadFormatters();
		const env = setupTestEnvironment("pi-lens-exit-posture-all-");
		try {
			writeFormatterAgreementEvidence(env.tmpDir);
			for (const definition of ALL_FORMATTERS) {
				const ext = definition.extensions[0] ?? "";
				const name = definition.filenames?.[0] ?? `probe${ext}`;
				const filePath = path.join(env.tmpDir, name);
				fs.writeFileSync(filePath, "a\n\tb\n");
				safeSpawnAsync.mockResolvedValue({
					status: 1,
					stdout: "",
					stderr: `${definition.name}: boom`,
				});

				const result = await formatFile(filePath, {
					...definition,
					resolveCommand: undefined,
				});

				if (result.outcome === "unavailable") {
					// nixfmt has no honest project marker and is intentionally declined
					// by #3005's conservative agreement policy.
					expect(definition.name).toBe("nixfmt");
					continue;
				}
				if (definition.lenientExitCode) {
					expect(
						result.success,
						`${definition.name} opted out, so a nonzero exit stays non-fatal`,
					).toBe(true);
				} else {
					expect(
						result,
						`${definition.name}: a nonzero exit must not read as a clean unchanged file`,
					).not.toEqual({ success: true, changed: false });
					expect(result.success, definition.name).toBe(false);
				}
			}
		} finally {
			env.cleanup();
		}
	});

	// Making nonzero exits user-visible put this string in front of the agent
	// (clients/pipeline.ts) and in the end-of-turn summary. "First line of
	// stderr" is not good enough: biome opens stderr with a decorated section
	// rule, so the message a user saw was a row of box-drawing characters.
	it("surfaces a real diagnostic, not biome's stderr banner", async () => {
		const env = setupTestEnvironment("pi-lens-exit-msg-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "go.mod"),
				"module example.com/probe\n",
			);
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(filePath, "package main\n");
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: `format ${"━".repeat(90)}\n\n./a.js internalError/io INTERNAL\n`,
			});

			const { formatFile, gofmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, gofmtFormatter);

			expect(result.success).toBe(false);
			expect(result.error).toBe("./a.js internalError/io INTERNAL");
			expect(result.error).not.toMatch(/[─-╿]/);
		} finally {
			env.cleanup();
		}
	});

	// biome, ktlint and `mix format` report on stdout. Reading stderr only threw
	// the diagnostic away and told the user just "exited with status 1".
	it("falls back to stdout when stderr carries nothing useful", async () => {
		const env = setupTestEnvironment("pi-lens-exit-msg-stdout-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "go.mod"),
				"module example.com/probe\n",
			);
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(filePath, "package main\n");
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "Formatted 0 files. No fixes applied.\n",
				stderr: "   \n",
			});

			const { formatFile, gofmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, gofmtFormatter);

			expect(result.error).toBe("Formatted 0 files. No fixes applied.");
		} finally {
			env.cleanup();
		}
	});

	it("strips ANSI colour from the surfaced diagnostic", async () => {
		const esc = String.fromCharCode(27);
		const { firstDiagnosticLine } = await loadFormatters();
		expect(firstDiagnosticLine(`${esc}[31merror: bad flag${esc}[0m`)).toBe(
			"error: bad flag",
		);
		// Last resort only: with nothing usable anywhere, the caller's exit-code
		// string must still win rather than an empty message.
		expect(firstDiagnosticLine("")).toBeUndefined();
		expect(firstDiagnosticLine(undefined)).toBeUndefined();
	});

	// #2461 round-2 (S3-r2b): this used to strip ANSI via a private,
	// letters-only `[A-Za-z]`-final-byte regex (a third stripper, obfuscated
	// via `String.fromCharCode(27)` to dodge no-control-regex) that missed the
	// full ECMA-48 CSI grammar `sanitize.ts`'s `stripAnsi` already handles —
	// so a private-mode sequence like a cursor-hide (`\x1b[?25l`, common
	// terminal-progress noise) survived into the user-visible diagnostic.
	// Routed through `stripAnsi` instead.
	it("strips a private-mode CSI sequence (cursor hide) from the surfaced diagnostic", async () => {
		const esc = String.fromCharCode(27);
		const { firstDiagnosticLine } = await loadFormatters();
		expect(firstDiagnosticLine(`${esc}[?25lerror: bad flag${esc}[0m`)).toBe(
			"error: bad flag",
		);
	});

	it("still reports a clean unchanged file when the exit is zero", async () => {
		const env = setupTestEnvironment("pi-lens-exit-posture-ok-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "go.mod"),
				"module example.com/probe\n",
			);
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(filePath, "package main\n");
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const { formatFile, gofmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, gofmtFormatter);

			expect(result).toEqual({
				success: true,
				changed: false,
				outcome: "unchanged",
			});
		} finally {
			env.cleanup();
		}
	});
});

// #1343 review P1: lenience covers ONLY the documented offense-remains
// statuses. A bad flag / config failure / crashed child (status 2+) must
// surface as failure even for lenient tools -- otherwise the #1336 silent
// no-op survives behind the lenient label.
describe("lenient statuses are exact, not blanket", () => {
	it("every lenient formatter declares its exact benign statuses", async () => {
		const { ALL_FORMATTERS } = await loadFormatters();
		for (const formatter of ALL_FORMATTERS) {
			if (formatter.lenientExitCode !== undefined) {
				expect(
					formatter.lenientStatuses,
					`${formatter.name} is lenient but declares no lenientStatuses`,
				).toBeDefined();
				expect(formatter.lenientStatuses!.length).toBeGreaterThan(0);
				expect(formatter.lenientStatuses).not.toContain(0);
			} else {
				expect(
					formatter.lenientStatuses,
					`${formatter.name} declares lenientStatuses without lenientExitCode`,
				).toBeUndefined();
			}
		}
	});
});
