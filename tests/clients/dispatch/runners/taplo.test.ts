import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn((..._args: unknown[]) => ({
	error: null,
	status: 0,
	stdout: "",
	stderr: "",
}));
const safeSpawnAsync = vi.fn((...args: Parameters<typeof safeSpawn>) =>
	Promise.resolve(safeSpawn(...args)),
);
vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

const lspPrimaryCoversFile = vi.fn((..._args: unknown[]) => false);
vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")>()),
	createAvailabilityChecker: () => ({
		isAvailable: () => true,
		isAvailableAsync: async () => true,
		getCommand: () => "taplo",
	}),
	resolveToolCommandWithInstallFallback: async () => "taplo",
	lspPrimaryCoversFile: (...args: unknown[]) => lspPrimaryCoversFile(...args),
}));

vi.mock("../../../../clients/tool-policy.js", () => ({
	getLinterPolicyForCwd: () => null,
}));

function createTomlCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "toml",
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("taplo runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		lspPrimaryCoversFile.mockReset();
		lspPrimaryCoversFile.mockReturnValue(false);
		safeSpawnAsync.mockImplementation((...args: Parameters<typeof safeSpawn>) =>
			Promise.resolve(safeSpawn(...args)),
		);
	});

	it("self-skips (no CLI spawn) when the toml LSP covers the file + taplo present (#233)", async () => {
		const env = setupTestEnvironment("pi-lens-taplo-");
		try {
			const filePath = path.join(env.tmpDir, "config.toml");
			fs.writeFileSync(filePath, "a = 1\n");
			lspPrimaryCoversFile.mockReturnValue(true); // toml LSP (taplo lsp) is primary

			const runner = (
				await import("../../../../clients/dispatch/runners/taplo.js")
			).default;
			const result = await runner.run(
				createTomlCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(safeSpawn).not.toHaveBeenCalled(); // no redundant CLI scan
		} finally {
			env.cleanup();
		}
	});

	it("still runs when taplo is unavailable as a tool (LSP can't cover) (#233)", async () => {
		const env = setupTestEnvironment("pi-lens-taplo-");
		try {
			const filePath = path.join(env.tmpDir, "config.toml");
			fs.writeFileSync(filePath, "a = 1\n");
			lspPrimaryCoversFile.mockReturnValue(true);
			// A clean taplo run: exit 0, nothing on stdout, only tracing on
			// stderr. The literal here used to be `{"errors":[]}`, a JSON
			// envelope taplo has never emitted (#1937).
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "",
				stderr:
					" INFO taplo:lint_files:collect_files: found files total=1 excluded=0",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/taplo.js")
			).default;
			// taplo not available → LSP can't actually cover → run the CLI
			const ctx = {
				...createTomlCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			};
			const result = await runner.run(ctx as never);

			expect(result.status).not.toBe("skipped");
			expect(safeSpawn).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	// taplo exits nonzero with an empty stdout when it never linted — a rejected
	// flag, an unreadable schema. A nonzero exit is not a spawn failure, so
	// `result.error` is unset and an error-only guard reports a clean file.
	// #1731 discipline B: the availability checker resolves through pi-lens's
	// MANAGED taplo (findManagedNodeToolBinary) before any project-local check
	// ever runs, so a project's own `node_modules/.bin/taplo` (npm
	// `@taplo/cli`) was unreachable whenever the managed shim answered. The
	// checker in this file is mocked to always report available, mirroring
	// that managed-shim-present condition — the project binary must still win.
	it("spawns the project's own node_modules/.bin/taplo ahead of the checker's command (#1731)", async () => {
		const env = setupTestEnvironment("pi-lens-taplo-local-");
		try {
			const filePath = path.join(env.tmpDir, "config.toml");
			fs.writeFileSync(filePath, "a = 1\n");
			const binDir = path.join(env.tmpDir, "node_modules", ".bin");
			fs.mkdirSync(binDir, { recursive: true });
			const shimName = process.platform === "win32" ? "taplo.cmd" : "taplo";
			const shim = path.join(binDir, shimName);
			fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
			// A clean taplo run: exit 0, nothing on stdout, only tracing on
			// stderr. The literal here used to be `{"errors":[]}`, a JSON
			// envelope taplo has never emitted (#1937).
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "",
				stderr:
					" INFO taplo:lint_files:collect_files: found files total=1 excluded=0",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/taplo.js")
			).default;
			await runner.run(createTomlCtx(filePath, env.tmpDir) as never);

			expect(safeSpawn).toHaveBeenCalled();
			const [spawnedCmd] = safeSpawn.mock.calls[0] as [string, ...unknown[]];
			expect(spawnedCmd).toBe(shim);
		} finally {
			env.cleanup();
		}
	});

	it("skips when taplo exits nonzero without producing output", async () => {
		const env = setupTestEnvironment("pi-lens-taplo-");
		try {
			const filePath = path.join(env.tmpDir, "config.toml");
			fs.writeFileSync(filePath, "a = 1\n");
			// The original #1937 case, restored: a lowercase `error:` line on
			// stderr that is NOT a codespan diagnostic. It has no `┌─
			// file:line:col` location, so it must not become a finding.
			safeSpawn.mockReturnValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "error: invalid schema reference",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/taplo.js")
			).default;

			const result = await runner.run(
				createTomlCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// #1937 round 2. Fixing the parser without an exit-code table swapped one
	// wrong answer for another: clap's rejection message begins with the same
	// lowercase `error:` a real taplo diagnostic does, so a mistyped flag would
	// have reported a blocking finding on line 1 of every valid TOML file.
	// Real clap text and the real exit code, taken from taplo 0.10.0.
	it("treats a rejected invocation as a skip, never as a finding", async () => {
		const env = setupTestEnvironment("pi-lens-taplo-");
		try {
			const filePath = path.join(env.tmpDir, "config.toml");
			fs.writeFileSync(filePath, "a = 1\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 2,
				stdout: "",
				stderr:
					"error: unexpected argument '--output' found\n\n  tip: to pass '--output' as a value, use '-- --output'\n\nUsage: taplo lint [OPTIONS] [FILES]...\n",
			});

			const ledger = await import("../../../../clients/degradation-ledger.js");
			ledger.resetDegradationLedger();

			const runner = (
				await import("../../../../clients/dispatch/runners/taplo.js")
			).default;
			const result = await runner.run(
				createTomlCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);

			// The verdict alone does not distinguish "taplo rejected the flags"
			// from "taplo failed the file" — both skip. The ledger row is what
			// tells a reader which one happened, and only the exit-code table
			// produces the rejection wording.
			const row = ledger
				.getDegradationSummary()
				.find((entry) => entry.kind === "runner-empty-result")
				?.latestReasons.find((e) => e.subject === "taplo");
			expect(row, "expected a runner-empty-result row for taplo").toBeDefined();
			expect(row?.reason).toContain("rejected-invocation");
			expect(row?.reason).toContain("2");
		} finally {
			env.cleanup();
		}
	});

	it("parses a real codespan diagnostic off stderr", async () => {
		const env = setupTestEnvironment("pi-lens-taplo-");
		try {
			const filePath = path.join(env.tmpDir, "config.toml");
			fs.writeFileSync(filePath, "[package\nname = 'x'\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: [
					" INFO taplo:lint_files:collect_files: found files total=1 excluded=0",
					"error: invalid TOML",
					"  ┌─ config.toml:2:9",
					"  │  ",
					"2 │   [package",
					"ERROR taplo:lint_files: invalid file error=syntax errors found",
				].join("\n"),
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/taplo.js")
			).default;
			const result = await runner.run(
				createTomlCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].message).toBe("invalid TOML");
			expect(result.diagnostics[0].line).toBe(2);
			expect(result.diagnostics[0].column).toBe(9);
		} finally {
			env.cleanup();
		}
	});
});
