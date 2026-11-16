/**
 * #5410 D9: the installer `TOOLS` entry is the only place a tool's
 * "install without asking" opt-in is declared.
 *
 * Recurrence this prevents: the opt-in lived in three lists that never read
 * each other (the execution policy's `autoInstall`, the formatter map and the
 * lazy-install table), so typstyle installed while the policy said no, and
 * rubocop, rust-clippy and rustfmt installed through a table with no policy row
 * at all (`gem install` / `rustup component add` rewrite the user's whole
 * gem root and toolchain).
 *
 * `OPT_IN` below is the pinned table of observed behaviour. It is hand-written
 * on purpose: a derived expectation would move with the code it checks. Every
 * other tool, and the three removed lazy installs, answer "not asked, not
 * installed".
 *
 * Driven through the real `shouldAutoInstallTool`, the real runner install
 * gate (`resolveToolCommandWithInstallFallback`) and the real formatter
 * selection (`getFormattersForFile`). Only the child process (`safe-spawn`) is
 * doubled. The runner gate runs under the suite's install kill switch, so the
 * real `ensureTool` refuses before any download and records a `declined`
 * attempt: that record is how the test sees which tools reached the installer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_FORMATTERS } from "../../clients/formatters.js";
import { TOOLS, getInstallAttempt } from "../../clients/installer/index.js";
import {
	TOOL_COMMAND_SPECS,
	TOOL_EXECUTION_POLICY,
	shouldAutoInstallTool,
} from "../../clients/tool-policy.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { withEnv } from "../support/with-env.js";
import { setupTestEnvironment, useTrackedTempDirs } from "./test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

/** The tools pi-lens installs without asking: the observed table, 2026-11-17. */
const OPT_IN = [
	"actionlint",
	"ast-grep",
	"biome",
	"golangci-lint",
	"hadolint",
	"helm",
	"htmlhint",
	"jscpd",
	"knip",
	"ktfmt",
	"ktlint",
	"madge",
	"markdownlint",
	"mypy",
	"opengrep",
	"oxlint",
	"prettier",
	"pyright",
	"ruff",
	"shellcheck",
	"shfmt",
	"spotbugs",
	"sqlfluff",
	"stylelint",
	"swiftlint",
	"taplo",
	"terragrunt",
	"tflint",
	"trivy",
	"typescript-language-server",
	"typstyle",
	"yamllint",
].sort();

/** The one intended behaviour change: these installed unasked before. */
const NO_LONGER_INSTALLED = ["rubocop", "rust-clippy", "rustfmt"];

describe("the installer entry is the one install opt-in (#5410 D9)", () => {
	it("the entries that opt in are exactly the pinned table", () => {
		expect(
			TOOLS.filter((tool) => tool.autoInstall)
				.map((tool) => tool.id)
				.sort(),
		).toEqual(OPT_IN);
	});

	it("shouldAutoInstallTool answers the table for every id any registry names", () => {
		const ids = new Set<string>([
			...TOOLS.map((tool) => tool.id),
			...TOOL_EXECUTION_POLICY.keys(),
			...TOOL_COMMAND_SPECS.keys(),
			...ALL_FORMATTERS.map((formatter) => formatter.name),
			...OPT_IN,
			...NO_LONGER_INSTALLED,
			"not-a-tool",
		]);
		assertNonEmptyScan("install opt-in ids", ids.size, 60);
		const wrong = [...ids].filter(
			(id) => shouldAutoInstallTool(id) !== OPT_IN.includes(id),
		);
		expect(wrong).toEqual([]);
	});

	it("rubocop, rust-clippy and rustfmt do not install unasked", () => {
		for (const id of NO_LONGER_INSTALLED) {
			expect(shouldAutoInstallTool(id), id).toBe(false);
		}
	});
});

describe("the runner install gate follows the entry (#5410 D9)", () => {
	useTrackedTempDirs("pi-lens-optin-");
	let restoreEnv: () => void = () => {};
	beforeEach(async () => {
		safeSpawnAsync.mockReset();
		// Every probe answers "not installed": the only state that may install.
		safeSpawnAsync.mockImplementation(async (cmd: string) => ({
			error: Object.assign(new Error(`spawn ${cmd} ENOENT`), {
				code: "ENOENT",
			}),
			status: null,
			stdout: "",
			stderr: "",
			spawnFailure: { kind: "tool-not-found" },
		}));
		const empty = setupTestEnvironment("pi-lens-optin-path-").tmpDir;
		restoreEnv = withEnv({
			PATH: empty,
			PI_LENS_DISABLE_TOOL_INSTALL: "1",
		});
		setProjectTrustState("trusted");
		const { resetDispatchAvailabilityState } =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		resetDispatchAvailabilityState();
	});
	afterEach(() => {
		restoreEnv();
		resetProjectTrust();
	});

	it("an absent tool reaches the installer exactly when its entry opts in", async () => {
		const { resolveToolCommandWithInstallFallback } =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		const cwd = setupTestEnvironment("pi-lens-optin-cwd-").tmpDir;
		const reachedInstaller: string[] = [];
		const managedIds: string[] = [];
		for (const [toolId, spec] of TOOL_COMMAND_SPECS) {
			const installerId = spec.managedToolId ?? toolId;
			managedIds.push(installerId);
			await resolveToolCommandWithInstallFallback(cwd, toolId);
			if (getInstallAttempt(installerId)?.outcome === "declined") {
				reachedInstaller.push(installerId);
			}
		}
		// The population floor: a vacuous scan would pass an empty table.
		assertNonEmptyScan("command specs driven", managedIds.length, 20);
		// Nothing outside the table reaches the installer. The other direction is
		// pinned on representatives: a project-local or dev-installed copy (oxlint
		// in this checkout) answers before the installer, so it is not asserted.
		expect(reachedInstaller.filter((id) => !OPT_IN.includes(id))).toEqual([]);
		for (const id of ["shellcheck", "tflint", "hadolint", "pyright", "ruff"]) {
			expect(reachedInstaller, id).toContain(id);
		}
		expect(reachedInstaller).not.toContain("rubocop");
	});
});

describe("formatters never install a toolchain component or gem (#5410 D9)", () => {
	useTrackedTempDirs("pi-lens-optin-fmt-");
	let restoreEnv: () => void = () => {};
	const finder = process.platform === "win32" ? "where" : "which";
	beforeEach(() => {
		safeSpawnAsync.mockReset();
		// `rustup` and `gem` are on PATH, the tools are not: the state that ran
		// `rustup component add rustfmt` and `gem install rubocop` before.
		safeSpawnAsync.mockImplementation(
			async (cmd: string, args: readonly string[] = []) => {
				if (cmd === finder && (args[0] === "rustup" || args[0] === "gem")) {
					return { stdout: `/usr/bin/${args[0]}\n`, stderr: "", status: 0 };
				}
				return { stdout: "", stderr: "", status: 1 };
			},
		);
		restoreEnv = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "0" });
		setProjectTrustState("trusted");
	});
	afterEach(() => {
		restoreEnv();
		resetProjectTrust();
	});

	const spawned = () =>
		safeSpawnAsync.mock.calls
			.map((call) => String(call[0]))
			.filter((cmd) => cmd !== finder);

	it("an absent rustfmt in a Rust project is not installed and not selected", async () => {
		const { getFormattersForFile, clearFormatterCache } =
			await import("../../clients/formatters.js");
		clearFormatterCache();
		const cwd = setupTestEnvironment("pi-lens-optin-rs-").tmpDir;
		fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\nname='a'\n");
		const filePath = path.join(cwd, "lib.rs");
		fs.writeFileSync(filePath, "fn main() {}\n");

		const selected = await getFormattersForFile(filePath, cwd);

		expect(selected.map((formatter) => formatter.name)).toEqual([]);
		expect(spawned()).toEqual([]);
	});

	it("an absent ktfmt reaches the installer only while its entry opts in", async () => {
		// Recurrence: `ktfmtFormatter.resolveCommand` called `ensureTool("ktfmt")`
		// after every ladder miss, whatever the entry said. The kill switch makes
		// the real `ensureTool` refuse before any download and record `declined`.
		const { ktfmtFormatter } = await import("../../clients/formatters.js");
		const cwd = setupTestEnvironment("pi-lens-optin-kt-").tmpDir;
		const filePath = path.join(cwd, "Main.kt");
		fs.writeFileSync(filePath, "fun main() {}\n");
		const restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
		const entry = TOOLS.find((tool) => tool.id === "ktfmt");
		expect(entry?.autoInstall).toBe(true);
		try {
			delete (entry as { autoInstall?: true }).autoInstall;
			const before = getInstallAttempt("ktfmt");
			await ktfmtFormatter.resolveCommand?.(filePath, cwd);
			expect(getInstallAttempt("ktfmt")).toBe(before);
			(entry as { autoInstall?: true }).autoInstall = true;
			await ktfmtFormatter.resolveCommand?.(filePath, cwd);
			expect(getInstallAttempt("ktfmt")).not.toBe(before);
			expect(getInstallAttempt("ktfmt")?.outcome).toBe("declined");
		} finally {
			(entry as { autoInstall?: true }).autoInstall = true;
			restore();
		}
	});

	it("an absent rubocop with a .rubocop.yml is not installed and not selected", async () => {
		const { getFormattersForFile, clearFormatterCache } =
			await import("../../clients/formatters.js");
		clearFormatterCache();
		const cwd = setupTestEnvironment("pi-lens-optin-rb-").tmpDir;
		fs.writeFileSync(
			path.join(cwd, ".rubocop.yml"),
			"AllCops:\n  NewCops: enable\n",
		);
		const filePath = path.join(cwd, "app.rb");
		fs.writeFileSync(filePath, "puts 1\n");

		const selected = await getFormattersForFile(filePath, cwd);

		expect(selected.map((formatter) => formatter.name)).toEqual([]);
		expect(spawned()).toEqual([]);
	});
});
