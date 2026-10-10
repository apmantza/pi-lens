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

// This suite pins formatter resolution and cwd behavior; the trust gate itself
// is witnessed in `package-manager.test.ts`. `vi.resetModules()` in `beforeEach`
// re-evaluates the graph, so the trust answer is mocked rather than latched.
vi.mock("../../clients/project-trust.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/project-trust.js")>()),
	getProjectTrustState: () => "trusted",
}));

// `resolveNpxFallback` installs the package through `ensureTool`; the spy lets
// each case choose whether the fallback RESOLVES (and runs the binary from the
// project cwd) or stays npx (neutral cwd).
const ensureTool = vi.hoisted(() => vi.fn());
vi.mock("../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/installer/index.js")
	>()),
	ensureTool,
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

function writeNodeAgreementEvidence(
	env: { tmpDir: string },
	tool: "prettier" | "biome" | "oxfmt",
): void {
	const packageName = tool === "biome" ? "@biomejs/biome" : tool;
	const version = tool === "oxfmt" ? "0.66.0" : "3.0.0";
	fs.writeFileSync(
		path.join(env.tmpDir, "package.json"),
		JSON.stringify({ devDependencies: { [packageName]: `^${version}` } }),
	);
	fs.writeFileSync(
		path.join(env.tmpDir, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: { [`node_modules/${packageName}`]: { version } },
		}),
	);
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
				writeNodeAgreementEvidence(env, name);
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

	// #3558: `enter` returns once pi's queue has run every edit queued ahead of
	// the formatter. The before-read comes after it, so such an edit is part of
	// the "before" and is never reported as the formatter's change.
	it("reads contentBefore after entering pi's queue, so an edit queued ahead is not claimed as the format (#3558)", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");
			safeSpawnAsync.mockImplementation(async () => ({
				status: 0,
				stdout: "",
				stderr: "",
			}));

			const { formatFile, formatter } = await loadFormatFile();
			const result = await formatFile(filePath, formatter, async () => {
				fs.appendFileSync(filePath, "# queued ahead\n");
			});

			expect(result).toEqual({
				success: true,
				changed: false,
				outcome: "unchanged",
			});
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
			fs.writeFileSync(path.join(env.tmpDir, "Gemfile"), 'gem "rubocop"\n');
			const filePath = path.join(env.tmpDir, "app.rb");
			fs.writeFileSync(filePath, "puts  'hi'\n");
			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[]) => {
					// #3558: only rubocop's own run rewrites the file, not the
					// resolver's `which bundle` probe, which now precedes the before-read.
					if (args.includes(filePath))
						fs.writeFileSync(filePath, "puts 'hi'\n");
					return {
						status: 1,
						stdout: "1 file inspected, 1 offense detected, 1 offense corrected",
						stderr: "",
					};
				},
			);

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

	it("declines a Node formatter when the lockfile disagrees with its pin", async () => {
		const env = setupTestEnvironment("pi-lens-format-node-agreement-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "a { color: red; }\n");
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ devDependencies: { "@biomejs/biome": "^1.0.0" } }),
			);
			fs.writeFileSync(
				path.join(env.tmpDir, "package-lock.json"),
				JSON.stringify({
					packages: { "node_modules/@biomejs/biome": { version: "0.0.0" } },
				}),
			);

			const { formatFile, biome } = await loadFormatFile();
			const result = await formatFile(filePath, biome);

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
		ensureTool.mockReset();
	});

	it("does not spawn any command when the resolver refuses to format", async () => {
		const env = setupTestEnvironment("pi-lens-format-skip-");
		try {
			writeNodeAgreementEvidence(env, "prettier");
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
			fs.writeFileSync(path.join(env.tmpDir, "Gemfile"), 'gem "rubocop"\n');
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
			fs.writeFileSync(path.join(env.tmpDir, "Gemfile"), 'gem "rubocop"\n');
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
			writeNodeAgreementEvidence(env, "prettier");
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

	it("resolves the npx fallback to the managed binary and runs it from the project root", async () => {
		const env = setupTestEnvironment("pi-lens-format-npx-available-");
		try {
			writeNodeAgreementEvidence(env, "prettier");
			const filePath = path.join(env.tmpDir, "formatted.js");
			fs.writeFileSync(filePath, "const value = 1;\n");
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "ignored.md\n");
			const managed = path.join(env.tmpDir, "managed", "prettier");
			ensureTool.mockResolvedValue(managed);
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
			// The resolved binary runs with the PROJECT cwd so cwd-relative
			// `.prettierignore` discovery still applies (#4268 HIGH-2).
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				managed,
				["--write", filePath],
				expect.objectContaining({ cwd: env.tmpDir }),
			);
		} finally {
			env.cleanup();
		}
	});

	it("runs an unresolved npx fallback from the neutral pi-lens-owned cwd", async () => {
		const env = setupTestEnvironment("pi-lens-format-npx-neutral-");
		try {
			writeNodeAgreementEvidence(env, "prettier");
			const filePath = path.join(env.tmpDir, "formatted.js");
			fs.writeFileSync(filePath, "const value = 1;\n");
			ensureTool.mockResolvedValue(undefined);
			const mod = await import("../../clients/formatters.js");
			const formatter = {
				...mod.prettierFormatter,
				resolveCommand: async () => null,
			};
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const result = await mod.formatFile(filePath, formatter);

			expect(result.outcome).toBe("unchanged");
			const npxCall = safeSpawnAsync.mock.calls.find(
				(call: unknown[]) => call[0] === "npx",
			) as [string, string[], { cwd?: string }];
			expect(npxCall).toBeDefined();
			// The cache-only fallback never reads the project's `.npmrc`: it runs
			// from the pi-lens-owned cwd. The child environment's `npm_config_*`
			// removal is witnessed at the process boundary in
			// `npx-child-env-isolation.test.ts`; an assertion on the options object
			// here cannot see the spawn merge (`getSpawnEnvironment`).
			expect(npxCall[2].cwd).not.toBe(env.tmpDir);
		} finally {
			env.cleanup();
		}
	});
});
