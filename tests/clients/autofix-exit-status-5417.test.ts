/**
 * #5417: a fixer that rewrites the file and then exits nonzero was recorded as
 * "no change". `detectFileChangedAfterCommand` returned 0 for an exit code
 * missing from the caller's ignore list WITHOUT comparing bytes, so rubocop
 * (`-a` exits 1 while offenses remain) and sqlfluff, which pass no list, lost
 * the file's `fixedThisTurn`, `changedFiles` and `needsContentRefresh` while
 * ktlint (ignore `[1]`) kept them for the same bytes and the same exit code.
 *
 * Driven through the production entry (`runAutofix`, the real policy, the real
 * resolver, the real before/after compare). Only `safeSpawnAsync`, the child
 * process boundary, is a double: it rewrites the file the way the fixer does.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import { runAutofix } from "../../clients/pipeline.js";

// `status` is an exit code missing from the caller's ignore list before the
// fix: rubocop passed `[1]` and sqlfluff nothing, so rubocop/1 already held.
const ROWS = [
	{
		tool: "rubocop",
		status: 2,
		file: "app.rb",
		config: ".rubocop.yml",
		before: "puts 'x'\n",
		after: 'puts "x"\n',
	},
	{
		tool: "rubocop",
		status: 1,
		file: "app.rb",
		config: ".rubocop.yml",
		before: "puts 'x'\n",
		after: 'puts "x"\n',
	},
	{
		tool: "sqlfluff",
		status: 1,
		file: "q.sql",
		config: ".sqlfluff",
		before: "select 1\n",
		after: "SELECT 1\n",
	},
	{
		tool: "sqlfluff",
		status: 255,
		file: "q.sql",
		config: ".sqlfluff",
		before: "select 1\n",
		after: "SELECT 1\n",
	},
] as const;

// The sqlfluff PATH double below is a POSIX executable file.
const RUNNABLE_ROWS = ROWS.filter(
	(row) => !(row.tool === "sqlfluff" && process.platform === "win32"),
);

describe("a fixer that rewrites then exits nonzero is recorded as changed (#5417)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		safeSpawnAsync.mockReset();
		env = setupTestEnvironment("pi-lens-autofix-exit-5417-");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		env.cleanup();
	});

	function deps() {
		return {
			biomeClient: {
				isSupportedFile: () => false,
				ensureAvailable: async () => false,
			},
			ruffClient: {
				isPythonFile: () => false,
				ensureAvailable: async () => false,
			},
			fixedThisTurn: new Set<string>(),
		};
	}

	function project(row: (typeof ROWS)[number]): string {
		if (row.tool === "sqlfluff") {
			// The resolver walks PATH before it probes; a file by the tool's name
			// keeps it off the installer, and the spawn double answers the probe.
			const bin = path.join(env.tmpDir, "bin");
			fs.mkdirSync(bin);
			fs.writeFileSync(path.join(bin, "sqlfluff"), "#!/bin/sh\n", {
				mode: 0o755,
			});
			vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
		}
		fs.writeFileSync(
			path.join(env.tmpDir, row.config),
			row.tool === "sqlfluff" ? "[sqlfluff]\ndialect = ansi\n" : "{}\n",
		);
		const filePath = path.join(env.tmpDir, row.file);
		fs.writeFileSync(filePath, row.before);
		return filePath;
	}

	/** The fixer: a call naming the file rewrites it and exits `status`. */
	function fixerExiting(filePath: string, to: string, status: number) {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			// Only the fixer call names the file; probes (`--version`, the
			// python user-base lookup) answer without touching it.
			if (!args.includes(filePath)) {
				return { error: null, status: 0, stdout: "1.0.0", stderr: "" };
			}
			fs.writeFileSync(filePath, to);
			return { error: null, status, stdout: "", stderr: "" };
		});
	}

	it.each(RUNNABLE_ROWS)(
		"$tool: the rewritten file is recorded when the fixer exits $status",
		async (row) => {
			const filePath = project(row);
			fixerExiting(filePath, row.after, row.status);
			const fixedThisTurn = new Set<string>();

			const result = await runAutofix(
				filePath,
				env.tmpDir,
				() => undefined,
				() => {},
				{ ...deps(), fixedThisTurn } as never,
			);

			expect(result.attemptedTools).toContain(row.tool);
			expect(fs.readFileSync(filePath, "utf8")).toBe(row.after);
			expect(result.fixedCount).toBe(1);
			expect(result.changedFiles).toEqual([path.resolve(filePath)]);
			expect(result.needsContentRefresh).toBe(true);
			expect(fixedThisTurn.has(filePath)).toBe(true);
		},
	);

	it.each(RUNNABLE_ROWS)(
		"$tool: a fixer that exits $status and leaves the bytes alone records nothing",
		async (row) => {
			// Recurrence guard for the opposite direction: success is the exit
			// code and changed is the bytes, so a nonzero exit alone is no change.
			const filePath = project(row);
			fixerExiting(filePath, row.before, row.status);

			const result = await runAutofix(
				filePath,
				env.tmpDir,
				() => undefined,
				() => {},
				deps() as never,
			);

			expect(result.attemptedTools).toContain(row.tool);
			expect(result.fixedCount).toBe(0);
			expect(result.changedFiles).toEqual([]);
			expect(result.needsContentRefresh).toBe(false);
		},
	);

	// Recurrence (#5408 slice 2): the `--dialect ansi` fallback was keyed on a
	// private sqlfluff finder; it is keyed on the seam now. A project that has a
	// sqlfluff config states its own dialect, so the fixer must not be handed one.
	it("sqlfluff: a project with a sqlfluff config is not handed a fallback dialect (#5408)", async () => {
		const row = RUNNABLE_ROWS.find((r) => r.tool === "sqlfluff");
		if (!row) return;
		const filePath = project(row);
		const calls: string[][] = [];
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args.includes(filePath)) calls.push(args);
			return { error: null, status: 0, stdout: "1.0.0", stderr: "" };
		});

		await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			deps() as never,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toContain("--dialect");
	});

	// The whole-package fixers (`cargo clippy --fix`, `dart fix --apply`) read
	// the project diff, and gated that diff on exit code 0: the same shape.
	it("rust-clippy: the files a nonzero cargo clippy --fix rewrote are recorded", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, "Cargo.toml"),
			'[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		fs.mkdirSync(path.join(env.tmpDir, "src"));
		const filePath = path.join(env.tmpDir, "src", "main.rs");
		fs.writeFileSync(filePath, "fn main() { let x = 1; }\n");
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
			if (args.includes("--version")) {
				return { error: null, status: 0, stdout: "cargo 1.82.0", stderr: "" };
			}
			if (cmd === "cargo" && args.includes("--fix")) {
				fs.writeFileSync(filePath, "fn main() { let _x = 1; }\n");
				return { error: null, status: 101, stdout: "", stderr: "" };
			}
			return { error: null, status: 0, stdout: "", stderr: "" };
		});

		const result = await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			deps() as never,
		);

		expect(result.attemptedTools).toContain("rust-clippy");
		expect(fs.readFileSync(filePath, "utf8")).toBe(
			"fn main() { let _x = 1; }\n",
		);
		expect(result.changedFiles).toContain(path.resolve(filePath));
		expect(result.needsContentRefresh).toBe(true);
	});
});
