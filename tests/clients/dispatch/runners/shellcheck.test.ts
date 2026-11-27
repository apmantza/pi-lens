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

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawn,
	safeSpawnAsync,
}));

const lspPrimaryCoversFile = vi.fn((..._args: unknown[]) => false as unknown);
vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		// The runner resolves through the registry resolver, which binds the real
		// checker inside runner-helpers, so a checker double never reaches it
		// (#5410 S2). Same answer, at the seam the runner now calls.
		resolveToolCommandWithInstallFallback: async () => "shellcheck",
		lspPrimaryCoversFile: (...args: unknown[]) => lspPrimaryCoversFile(...args),
	}),
);

function createShellCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "shell",
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("shellcheck runner", () => {
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

	it("adds --severity info when no .shellcheckrc exists (surfaces SC2086, #213)", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			const filePath = path.join(env.tmpDir, "script.sh");
			fs.writeFileSync(filePath, "echo $x\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			await runner.run(createShellCtx(filePath, env.tmpDir) as never);

			const args = safeSpawn.mock.calls[0]?.[1] ?? [];
			expect(args).toContain("--severity");
			// info (not warning) so SC2086-class info findings surface; pure `style`
			// stays opt-in via .shellcheckrc.
			expect(args).toContain("info");
			expect(args).not.toContain("warning");
		} finally {
			env.cleanup();
		}
	});

	// #2691: the lint spawn passed no `cwd`, so it ran under the extension
	// host's `process.cwd()` instead of `ctx.cwd` -- same shape as #1731
	// (sqlfluff) and #2691's own yamllint.
	it("spawns shellcheck with the dispatch context's cwd, not the host's (#2691)", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-cwd-");
		try {
			const filePath = path.join(env.tmpDir, "script.sh");
			fs.writeFileSync(filePath, "echo $x\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			await runner.run(createShellCtx(filePath, env.tmpDir) as never);

			expect(safeSpawn).toHaveBeenCalled();
			const [, , options] = safeSpawn.mock.calls[0] as [
				string,
				string[],
				{ cwd?: string } | undefined,
			];
			expect(options?.cwd).toBe(env.tmpDir);
		} finally {
			env.cleanup();
		}
	});

	it("finds parent .shellcheckrc and does not force --severity", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, ".shellcheckrc"),
				"disable=SC2034\n",
			);
			const filePath = path.join(env.tmpDir, "scripts", "script.sh");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "echo $x\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			await runner.run(createShellCtx(filePath, env.tmpDir) as never);

			const args = safeSpawn.mock.calls[0]?.[1] ?? [];
			expect(args).not.toContain("--severity");
		} finally {
			env.cleanup();
		}
	});

	it("self-skips (no CLI spawn) when the bash LSP covers the file + tools present (#233)", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			const filePath = path.join(env.tmpDir, "script.sh");
			fs.writeFileSync(filePath, "echo $x\n");
			lspPrimaryCoversFile.mockReturnValue({
				// the seam's match shape: the bash LSP covers the shellcheck runner,
				// gated on the LSP's own binary
				serverId: "bash",
				gateCommands: ["bash-language-server"],
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			// hasTool true for both bash-language-server + shellcheck → LSP covers
			const result = await runner.run(
				createShellCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(safeSpawn).not.toHaveBeenCalled(); // no redundant CLI scan
		} finally {
			env.cleanup();
		}
	});

	it("still runs when the bash LSP is unavailable even if it would be primary (#233)", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			const filePath = path.join(env.tmpDir, "script.sh");
			fs.writeFileSync(filePath, "echo $x\n");
			lspPrimaryCoversFile.mockReturnValue({
				serverId: "bash",
				gateCommands: ["bash-language-server"],
			});
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			// bash-language-server NOT installed → LSP can't actually cover → run CLI
			const ctx = {
				...createShellCtx(filePath, env.tmpDir),
				hasTool: async (t: string) => t !== "bash-language-server",
			};
			const result = await runner.run(ctx as never);

			expect(result.status).not.toBe("skipped");
			expect(safeSpawn).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("appliesTo shell but not fish (so dispatch skips .fish files)", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/shellcheck.js")
		).default;
		expect(runner.appliesTo).toContain("shell");
		expect(runner.appliesTo).not.toContain("fish");
	});

	it("returns failed/blocking when shellcheck reports error severity", async () => {
		const env = setupTestEnvironment("pi-lens-shellcheck-");
		try {
			const filePath = path.join(env.tmpDir, "script.sh");
			fs.writeFileSync(filePath, "echo $x\n");
			safeSpawn.mockReturnValue({
				error: null,
				status: 1,
				stdout: JSON.stringify([
					{
						file: filePath,
						line: 1,
						column: 1,
						level: "error",
						code: 2086,
						message: "Double quote to prevent globbing",
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			const result = await runner.run(
				createShellCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.semantic).toBe("blocking");
		} finally {
			env.cleanup();
		}
	});
});
/**
 * #3968 — shell dialect ownership. Two separate mechanisms, ordered:
 *
 *  1. covered-by-primary — the file's selected primary LSP declares a covers
 *     fact for the `shellcheck` runner capability AND the covering lane can
 *     actually run (its gate commands probeable). Generalized from the old
 *     literal `bash` server-id match, so a shell LSP that owns lint (builtin
 *     bash/shuck — config-declared covers lands in the stacked PR) defers the
 *     CLI without the user demoting anything.
 *  2. dialect-unsupported — categorical, never consults covers: resolve the
 *     dialect the way bash-language-server@server-5.8.1 `analyzeFile` does
 *     (`server/src/util/shebang.ts` at that tag, pinned per defect shape 16)
 *     and skip dialects outside ShellCheck's `SHELLCHECK_DIALECTS` — zsh
 *     otherwise gets SC1071-class error-severity findings (the reported harm)
 *     on a dialect ShellCheck cannot analyze at all.
 *
 * When a shebang or a `shellcheck shell=` directive is present the runner
 * passes NO `--shell` override (mirror of upstream's "ShellCheck performs
 * shebang parsing and shell detection itself" logic; their #1064 guard). A
 * shebang-less file keeps the bash fallback override, exactly like upstream's
 * own lint flow.
 */
describe("shell dialect ownership (#3968)", () => {
	const COVER_BASH_MATCH = {
		serverId: "bash",
		gateCommands: ["bash-language-server"],
	} as const;
	const COVER_SHUCK_MATCH = {
		serverId: "shuck",
		gateCommands: ["shuck"],
	} as const;
	// zsh-only constructs the pre-fix runner mis-analyzed under `--shell bash`
	// (real-binary probe: SC2168/SC2296 error-severity, SC1073 parse failures).
	const zshHeavy = [
		"#!/usr/bin/env zsh",
		"zparseopts -D -E -F -- a=opts",
		"local -A counts",
		"counts[answer]=42",
	].join("\n");

	/**
	 * Real runner entry, spawn mocked at the process boundary only (the mock
	 * carries the fields the production seam honours).
	 * `cover` feeds the mocked runner-helpers seam. The coverage gate commands
	 * of the arms' covering lanes are `bash-language-server` and `shuck`, and
	 * the runner's own `shellcheck` gate: all default to present except where
	 * the arm explicitly marks them absent.
	 */
	async function runDialectArm(
		tmpDir: string,
		relFile: string,
		content: string,
		options: {
			cover?: typeof COVER_BASH_MATCH | typeof COVER_SHUCK_MATCH | false;
			bashLanguageServerPresent?: boolean;
			shuckPresent?: boolean;
			shellcheckPresent?: boolean;
		} = {},
	): Promise<{
		status: string;
		semantic: string;
		skipReason: string | undefined;
		args: string[];
		spawned: boolean;
	}> {
		const filePath = path.join(tmpDir, relFile);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content);
		lspPrimaryCoversFile.mockReturnValue(options.cover ?? false);
		safeSpawn.mockReturnValue({
			error: null,
			status: 0,
			stdout: "[]",
			stderr: "",
		});
		const present: Record<string, boolean> = {
			"bash-language-server": options.bashLanguageServerPresent ?? true,
			shuck: options.shuckPresent ?? false,
			shellcheck: options.shellcheckPresent ?? true,
		};
		const runner = (
			await import("../../../../clients/dispatch/runners/shellcheck.js")
		).default;
		const ctx = {
			...createShellCtx(filePath, tmpDir),
			hasTool: async (t: string) => present[t] ?? true,
		};
		const result = await runner.run(ctx as never);
		return {
			status: result.status,
			semantic: result.semantic,
			skipReason: (result as { skipReason?: string }).skipReason,
			args: (safeSpawn.mock.calls[0]?.[1] ?? []) as string[],
			spawned: safeSpawn.mock.calls.length > 0,
		};
	}

	it("skips a shebang'd .zsh file dialect-unsupported (zdot repro; bash LSP absent)", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"dotfiles/zshrc",
				`${zshHeavy}\n`,
				{ bashLanguageServerPresent: false },
			);
			expect(out.status).toBe("skipped");
			expect(out.skipReason).toBe("dialect-unsupported");
			expect(out.spawned).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("skips a bare (no-shebang) .zsh file dialect-unsupported", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"bare.zsh",
				"autoload -Uz compinit\n",
				{
					bashLanguageServerPresent: false,
				},
			);
			expect(out.status).toBe("skipped");
			expect(out.skipReason).toBe("dialect-unsupported");
			expect(out.spawned).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("a .sh file with a zsh shebang is a zsh file", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"legacy.sh",
				"#!/usr/bin/env zsh\nautoload -Uz compinit\n",
				{ bashLanguageServerPresent: false },
			);
			expect(out.status).toBe("skipped");
			expect(out.skipReason).toBe("dialect-unsupported");
			expect(out.spawned).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("a leading `shellcheck shell=zsh` directive makes the file a zsh file", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"directed.sh",
				"# shellcheck shell=zsh\nautoload -Uz compinit\n",
				{ bashLanguageServerPresent: false },
			);
			expect(out.status).toBe("skipped");
			expect(out.skipReason).toBe("dialect-unsupported");
			expect(out.spawned).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("skips a case-variant uppercase .ZSH file dialect-unsupported", async () => {
		// #3159 screen: this fixture's basename is unique on this tmp root (no
		// same-basename case sibling is created), so a case-insensitive
		// filesystem cannot surface a collision; the case-arm is the point, not
		// a platform skip.
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			// Filesystem collision probe: the arm's name differs from every
			// other fixture's basename, so no case-collision exists even on an
			// APFS case-insensitive volume — verified by creation succeeding.
			const out = await runDialectArm(
				env.tmpDir,
				"CASEVAR.ZSH",
				"autoload -Uz compinit\n",
				{
					bashLanguageServerPresent: false,
				},
			);
			expect(out.status).toBe("skipped");
			expect(out.skipReason).toBe("dialect-unsupported");
			expect(out.spawned).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("zsh skips regardless of LSP state: the shuck-absent arm skips dialect-unsupported", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			// The shuck covers match is present but the covering lane is absent:
			// no covered-by-primary skip, and the categorical gate still skips.
			// (The no-lsp arm belongs to the seam's own unit tests — the kill
			// switch is the seam's rule, and this file's double sits above it.)
			const out = await runDialectArm(env.tmpDir, "a.zsh", `${zshHeavy}\n`, {
				cover: COVER_SHUCK_MATCH,
				shuckPresent: false,
				bashLanguageServerPresent: false,
				shellcheckPresent: true,
			});
			expect(out.spawned).toBe(false);
			expect(out.skipReason).toBe("dialect-unsupported");
		} finally {
			env.cleanup();
		}
	});

	it("a shebang'd supported-dialect file runs with NO --shell override (shellcheck parses the shebang itself)", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"deploy.sh",
				"#!/bin/sh\nF=1\necho $F\n",
				{
					bashLanguageServerPresent: false,
				},
			);
			expect(out.spawned).toBe(true);
			expect(out.args).not.toContain("--shell");
		} finally {
			env.cleanup();
		}
	});

	it("an env-shebang supported dialect drops the override too", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"dash.sh",
				"#!/usr/bin/env dash\nF=1\necho $F\n",
				{
					bashLanguageServerPresent: false,
				},
			);
			expect(out.spawned).toBe(true);
			expect(out.args).not.toContain("--shell");
		} finally {
			env.cleanup();
		}
	});

	it("a shebang'd ksh file keeps shellcheck's own dialect detection", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"ksh-script.sh",
				"#!/bin/ksh\nF=1\necho $F\n",
				{
					bashLanguageServerPresent: false,
				},
			);
			expect(out.spawned).toBe(true);
			expect(out.args).not.toContain("--shell");
		} finally {
			env.cleanup();
		}
	});

	it("a shebang-less .sh keeps the bash fallback override (unchanged from upstream's own lint flow)", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"plain.sh",
				"F=1\necho $F\n",
				{
					bashLanguageServerPresent: false,
				},
			);
			expect(out.spawned).toBe(true);
			const i = out.args.indexOf("--shell");
			expect(i).toBeGreaterThanOrEqual(0);
			expect(out.args[i + 1]).toBe("bash");
		} finally {
			env.cleanup();
		}
	});

	it("skips covered-by-primary when the covering lane's gate commands are all present", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"script.sh",
				"F=1\necho $F\n",
				{
					cover: COVER_BASH_MATCH,
					bashLanguageServerPresent: true,
					shellcheckPresent: true,
				},
			);
			expect(out.status).toBe("skipped");
			expect(out.skipReason).toBe("covered-by-primary");
			expect(out.spawned).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("shuck-installed arm: .zsh primary covers shellcheck → covered-by-primary", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"zshrc.zsh",
				"autoload -Uz compinit\n",
				{
					cover: COVER_SHUCK_MATCH,
					shuckPresent: true,
					shellcheckPresent: true,
				},
			);
			expect(out.status).toBe("skipped");
			expect(out.skipReason).toBe("covered-by-primary");
			expect(out.spawned).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("an absent covering lane never skips: the CLI run keeps coverage", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"script.sh",
				"F=1\necho $F\n",
				{
					cover: COVER_BASH_MATCH,
					bashLanguageServerPresent: false,
					shellcheckPresent: true,
				},
			);
			expect(out.spawned).toBe(true);
			expect(out.status).not.toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	it("an absent shellcheck binary under a covering lane never skips (the covering LSP cannot emit)", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			const out = await runDialectArm(
				env.tmpDir,
				"script.sh",
				"F=1\necho $F\n",
				{
					cover: COVER_BASH_MATCH,
					bashLanguageServerPresent: true,
					shellcheckPresent: false,
				},
			);
			expect(out.spawned).toBe(true);
			expect(out.status).not.toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	it("an unreadable dialect source fails open to the pre-fix lint (coverage never regresses)", async () => {
		const env = setupTestEnvironment("pi-lens-shell-dialect-");
		try {
			// File gone between dispatch and run: dialect resolution cannot read
			// content, so the runner behaves exactly as it did pre-fix and lets
			// the spawn's own classification disclose the failure.
			const filePath = path.join(env.tmpDir, "vanishing.zsh");
			fs.mkdirSync(env.tmpDir, { recursive: true });
			lspPrimaryCoversFile.mockReturnValue(false);
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: "[]",
				stderr: "",
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/shellcheck.js")
			).default;
			const result = await runner.run(
				createShellCtx(filePath, env.tmpDir) as never,
			);
			expect(safeSpawn).toHaveBeenCalled();
			expect(result.status).toBe("succeeded");
		} finally {
			env.cleanup();
		}
	});
});
