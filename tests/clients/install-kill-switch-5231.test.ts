/**
 * #5231: `PI_LENS_DISABLE_TOOL_INSTALL=1` must stop EVERY tool install, not
 * only the managed installer's `acquireManagedInstallGate`.
 *
 * Recurrence this prevents: the lazy installer (`gem install rubocop`,
 * `rustup component add clippy|rustfmt`) and govulncheck (`go install`) checked
 * project trust only, so a user who set the switch still got a `gem` spawn
 * (alignment probe 2026-11-03, `strace -f -e execve`). The same shape as the
 * `#1759 F2` comment in `clients/installer/index.ts`: a kill switch skipped by
 * another install path.
 *
 * The spawn boundary is faked (`safeSpawnAsync`), so no installer runs on the
 * host. The positive controls prove the fake sees a real spawn once the switch
 * is off, so "no spawn" is not a vacuous result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { resetProjectTrust } from "../../clients/project-trust.js";
import { resetLazyInstallAttempts } from "../../clients/dispatch/runners/utils/lazy-installer.js";
import { withEnv } from "../support/with-env.js";

const { safeSpawnAsync } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(
		async (
			_command: string,
			_args?: string[],
			_options?: Record<string, unknown>,
		) => ({
			status: 0,
			stdout: "",
			stderr: "",
		}),
	),
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

let restoreEnv: () => void;
beforeEach(() => {
	resetDegradationLedger();
	resetLazyInstallAttempts();
	resetProjectTrust();
	safeSpawnAsync.mockClear();
	restoreEnv = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
});
afterEach(() => {
	restoreEnv();
	resetProjectTrust();
});

function installDisabledRows() {
	return (
		getDegradationSummary().find((g) => g.kind === "install-disabled")
			?.latestReasons ?? []
	);
}

describe("PI_LENS_DISABLE_TOOL_INSTALL reaches the lazy installer (#5231)", () => {
	it.each(["rubocop", "rust-clippy", "rustfmt"] as const)(
		"tryLazyInstall(%s) answers false without spawning an installer",
		async (tool) => {
			const { tryLazyInstall } =
				await import("../../clients/dispatch/runners/utils/lazy-installer.js");
			expect(await tryLazyInstall(tool, "/kill-switch/runner")).toBe(false);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		},
	);

	it.each(["rubocop", "rustfmt"] as const)(
		"tryLazyInstallForFormatter(%s) answers false without spawning an installer",
		async (tool) => {
			const { tryLazyInstallForFormatter } =
				await import("../../clients/dispatch/runners/utils/lazy-installer.js");
			expect(await tryLazyInstallForFormatter(tool, "/kill-switch/fmt")).toBe(
				false,
			);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		},
	);

	it("tryLazyInstallFormatterTool (the formatters.ts entry) spawns nothing", async () => {
		const { tryLazyInstallFormatterTool } =
			await import("../../clients/formatters.js");
		expect(await tryLazyInstallFormatterTool("rubocop", "/kill-switch/f")).toBe(
			false,
		);
		expect(await tryLazyInstallFormatterTool("rustfmt", "/kill-switch/f")).toBe(
			false,
		);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("positive control: with the switch off the same call spawns gem / rustup", async () => {
		const restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: undefined });
		try {
			const { tryLazyInstall } =
				await import("../../clients/dispatch/runners/utils/lazy-installer.js");
			expect(await tryLazyInstall("rubocop", "/kill-switch/control")).toBe(
				true,
			);
			expect(await tryLazyInstall("rust-clippy", "/kill-switch/control")).toBe(
				true,
			);
			expect(safeSpawnAsync.mock.calls.map((call) => call[0])).toEqual([
				"gem",
				"rustup",
			]);
		} finally {
			restore();
		}
	});

	it("records one install-disabled row per tool per session, however often it is asked", async () => {
		const { tryLazyInstall, tryLazyInstallForFormatter } =
			await import("../../clients/dispatch/runners/utils/lazy-installer.js");
		for (let i = 0; i < 5; i++) {
			await tryLazyInstall("rubocop", "/kill-switch/obs");
			await tryLazyInstallForFormatter("rubocop", "/kill-switch/obs2");
		}
		await tryLazyInstall("rustfmt", "/kill-switch/obs");
		expect(
			installDisabledRows()
				.map((row) => row.subject)
				.sort(),
		).toEqual(["rubocop", "rustfmt"]);
		expect(
			getDegradationSummary().find((g) => g.kind === "install-disabled")?.count,
		).toBe(2);
	});
});

describe("PI_LENS_DISABLE_TOOL_INSTALL reaches govulncheck (#5231)", () => {
	async function absentClient() {
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const client = new GovulncheckClient() as any;
		// The PATH probe says "not installed": the only branch that installs.
		vi.spyOn(client, "probeVersion").mockResolvedValue(false);
		return client;
	}

	it("answers unavailable without probing `go` or running `go install`", async () => {
		const client = await absentClient();
		expect(await client.doEnsureAvailable()).toBe(false);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(installDisabledRows().map((row) => row.subject)).toEqual([
			"govulncheck",
		]);
		// A second ask records nothing new.
		expect(await client.doEnsureAvailable()).toBe(false);
		expect(
			getDegradationSummary().find((g) => g.kind === "install-disabled")?.count,
		).toBe(1);
	});

	it("positive control: with the switch off the install path runs `go`", async () => {
		const restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: undefined });
		try {
			const client = await absentClient();
			await client.doEnsureAvailable();
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"go",
				["install", "golang.org/x/vuln/cmd/govulncheck@latest"],
				expect.any(Object),
			);
		} finally {
			restore();
		}
	});
});
