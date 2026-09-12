import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	which: vi.fn(async () => "/usr/bin/terragrunt"),
}));

async function loadFormatFile() {
	const mod = await import("../../clients/formatters.js");
	return {
		formatFile: mod.formatFile,
		biome: mod.biomeFormatter,
		prettier: mod.prettierFormatter,
		oxfmt: mod.oxfmtFormatter,
		formatter: mod.terragruntHclFormatter,
		rubocop: mod.rubocopFormatter,
		ktlint: mod.ktlintFormatter,
	};
}

describe("formatFile", () => {
	let getDegradationSummary: () => unknown;
	let resetDegradationLedger: () => void;
	beforeEach(async () => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		({ getDegradationSummary, resetDegradationLedger } =
			await import("../../clients/degradation-ledger.js"));
		resetDegradationLedger();
	});

	it.each(["prettier", "biome", "oxfmt"] as const)(
		"runs %s from the project root so cwd-relative ignores are honored",
		async (name) => {
			const env = setupTestEnvironment(`pi-lens-format-${name}-`);
			try {
				const nestedDir = path.join(env.tmpDir, "sub", "deep");
				const filePath = path.join(nestedDir, "app.ts");
				fs.mkdirSync(nestedDir, { recursive: true });
				fs.mkdirSync(path.join(env.tmpDir, "node_modules", ".bin"), {
					recursive: true,
				});
				fs.writeFileSync(
					path.join(env.tmpDir, "node_modules", ".bin", name),
					"",
				);
				fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "ignored.md\n");
				fs.writeFileSync(
					path.join(env.tmpDir, ".prettierignore"),
					"ignored-by-prettier.md\n",
				);
				fs.writeFileSync(filePath, "function f() {\n  return 1;\n}\n");
				safeSpawnAsync.mockResolvedValue({
					status: 0,
					stdout: "",
					stderr: "",
				});

				const mod = await loadFormatFile();
				await mod.formatFile(filePath, mod[name]);

				expect(safeSpawnAsync).toHaveBeenCalledWith(
					expect.any(String),
					expect.any(Array),
					expect.objectContaining({ cwd: env.tmpDir }),
				);
			} finally {
				env.cleanup();
			}
		},
	);

	// A formatter that never ran leaves the file byte-identical, which is
	// indistinguishable from "already formatted" unless the exit status is part
	// of the success test. `SpawnResult.error` is unset on a normal nonzero exit,
	// so an error-only check reports a clean format for an old terragrunt binary
	// that does not know the `hcl` command group.
	it("reports failure when the formatter exits nonzero", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: 'Error: unknown command "hcl" for "terragrunt"',
			});

			const { formatFile, formatter } = await loadFormatFile();
			const result = await formatFile(filePath, formatter);

			expect(result.success).toBe(false);
			expect(result.changed).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("reports failure when the spawn itself fails", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");
			safeSpawnAsync.mockResolvedValue({
				status: null,
				error: new Error("Process timed out after 15000ms"),
				failure: "timeout",
				stdout: "",
				stderr: "",
			});

			const { formatFile, formatter } = await loadFormatFile();
			const result = await formatFile(filePath, formatter);

			expect(result.success).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("reports success with changed=true when a clean run rewrites the file", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals   {}\n");
			safeSpawnAsync.mockImplementation(async () => {
				fs.writeFileSync(filePath, "locals {}\n");
				return { status: 0, stdout: "", stderr: "" };
			});

			const { formatFile, formatter } = await loadFormatFile();
			const result = await formatFile(filePath, formatter);

			expect(result.success).toBe(true);
			expect(result.changed).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// The reason the strict default is opt-OUT-able: `rubocop -a` exits 1 when
	// offenses remain after it has already rewritten the file. Failing that would
	// surface a formatter error on every file with an unfixable offense.
	it("keeps a nonzero exit non-fatal for lint-autofix formatters", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "app.rb");
			fs.writeFileSync(filePath, "puts  'hi'\n");
			safeSpawnAsync.mockImplementation(async () => {
				fs.writeFileSync(filePath, "puts 'hi'\n");
				return {
					status: 1,
					stdout: "1 file inspected, 1 offense detected, 1 offense corrected",
					stderr: "",
				};
			});

			const { formatFile, rubocop } = await loadFormatFile();
			const result = await formatFile(filePath, rubocop);

			expect(result.success).toBe(true);
			expect(result.changed).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("declines a Gradle-managed ktlint before the formatter resolver runs", async () => {
		const env = setupTestEnvironment("pi-lens-format-ktlint-agreement-");
		try {
			const filePath = path.join(env.tmpDir, "App.kt");
			fs.writeFileSync(filePath, 'fun main() { println("hi") }\n');
			fs.writeFileSync(
				path.join(env.tmpDir, "build.gradle"),
				'plugins { id "org.jlleitschuh.gradle.ktlint" version "12.1.1" }\n',
			);

			const { formatFile, ktlint } = await loadFormatFile();
			const result = await formatFile(filePath, ktlint);

			expect(result).toMatchObject({
				success: true,
				changed: false,
				outcome: "unavailable",
				error: expect.stringContaining("agreement could not be established"),
			});
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("records one agreement decline for 200 formatter-path files", async () => {
		const env = setupTestEnvironment(
			"pi-lens-format-ktlint-agreement-bounded-",
		);
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "build.gradle"),
				'plugins { id "org.jlleitschuh.gradle.ktlint" version "12.1.1" }\n',
			);
			const { formatFile, ktlint } = await loadFormatFile();
			for (let index = 0; index < 200; index += 1) {
				const filePath = path.join(env.tmpDir, `App${index}.kt`);
				fs.writeFileSync(filePath, "fun main() {}\n");
				await formatFile(filePath, ktlint);
			}

			const agreementRecords = (
				getDegradationSummary() as Array<{ kind: string }>
			).filter((record) => record.kind === "formatter-agreement-unavailable");
			expect(agreementRecords).toEqual([
				{
					kind: "formatter-agreement-unavailable",
					count: 1,
					droppedCount: 0,
					latestReasons: [
						{
							subject: "kotlin:gradle-ktlint",
							reason: expect.stringContaining("cannot be established"),
						},
					],
				},
			]);
		} finally {
			env.cleanup();
		}
	});

	it("reports success with changed=false when a clean run leaves the file alone", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const { formatFile, formatter } = await loadFormatFile();
			const result = await formatFile(filePath, formatter);

			expect(result.success).toBe(true);
			expect(result.changed).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

// #1144 review follow-up: SKIP_FORMATTING must be honored at the formatFile
// seam. The resolvers return the sentinel when the repo has no config and the
// file's indentation is undetectable — pre-fix, formatFile treated any
// non-array as "fall back to the static command", so the stock-style spawn
// happened anyway and the resolver-level skip was dead code.
describe("formatFile honors SKIP_FORMATTING (#1144)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	it("does not spawn any command when the resolver refuses to format", async () => {
		const env = setupTestEnvironment("pi-lens-format-skip-");
		try {
			// Minified single line: no detectable indentation, and no prettier
			// config anywhere under the temp dir.
			const filePath = path.join(env.tmpDir, "bundle.js");
			fs.writeFileSync(filePath, "const a=1;const b=2;const c=a+b;\n");

			const mod = await import("../../clients/formatters.js");
			const result = await mod.formatFile(filePath, mod.prettierFormatter);

			expect(result).toEqual({
				success: true,
				changed: false,
				outcome: "skipped",
			});
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	// #1343 review P1: lenience covers ONLY the documented statuses. rubocop's
	// benign mode is status 1 (offenses remain after a successful rewrite);
	// status 2 is a command/config failure and must NOT read as success.
	it("lenient formatter: documented benign status (1) still succeeds", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "a.rb");
			fs.writeFileSync(filePath, "x = 1\n");
			safeSpawnAsync.mockResolvedValue({ status: 1, stdout: "", stderr: "" });

			const { formatFile, rubocop } = await loadFormatFile();
			const result = await formatFile(filePath, rubocop);

			expect(result.success).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("lenient formatter: undocumented status (2, bad flag/crash) fails", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "a.rb");
			fs.writeFileSync(filePath, "x = 1\n");
			safeSpawnAsync.mockResolvedValue({
				status: 2,
				stdout: "",
				stderr: "Error: invalid option: --busted",
			});

			const { formatFile, rubocop } = await loadFormatFile();
			const result = await formatFile(filePath, rubocop);

			expect(result.success).toBe(false);
			expect(result.changed).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does not let an unavailable primary reach the npx fallback when gated", async () => {
		const env = setupTestEnvironment("pi-lens-format-npx-gated-");
		try {
			const filePath = path.join(env.tmpDir, "bundle.js");
			fs.writeFileSync(filePath, "const a=1;const b=2;const c=a+b;\n");
			const mod = await import("../../clients/formatters.js");
			const formatter = {
				...mod.prettierFormatter,
				resolveCommand: async () => mod.SKIP_FORMATTING,
			};

			const result = await mod.formatFile(filePath, formatter);

			expect(result).toEqual({
				success: true,
				changed: false,
				outcome: "skipped",
			});
			expect(safeSpawnAsync).not.toHaveBeenCalledWith(
				"npx",
				expect.anything(),
				expect.anything(),
			);
		} finally {
			env.cleanup();
		}
	});

	it("uses the npx fallback when the primary is unavailable and the file is not gated", async () => {
		const env = setupTestEnvironment("pi-lens-format-npx-available-");
		try {
			const filePath = path.join(env.tmpDir, "formatted.js");
			fs.writeFileSync(filePath, "const value = 1;\n");
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "ignored.md\n");
			const mod = await import("../../clients/formatters.js");
			const formatter = {
				...mod.prettierFormatter,
				resolveCommand: async () => null,
			};
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const result = await mod.formatFile(filePath, formatter);

			expect(result).toEqual({
				success: true,
				changed: false,
				outcome: "unchanged",
			});
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"npx",
				["prettier", "--write", filePath],
				expect.objectContaining({ cwd: env.tmpDir }),
			);
		} finally {
			env.cleanup();
		}
	});
});
