/**
 * #5231 — `PI_LENS_DISABLE_TOOL_INSTALL=1` stopped only the managed installer.
 * The lazy installer (`gem install rubocop`, `rustup component add`) and
 * govulncheck's `go install` checked project trust and spawned anyway, so an
 * operator who set the switch still had tools installed behind their back.
 *
 * Recurrence this file guards: a new install path that checks trust and not
 * the switch. Each case drives one install path through its production caller
 * with the switch on and asserts no installer process was spawned, then flips
 * the switch off and asserts the same call spawns (so the refusal is the
 * switch, not a broken fixture) and that the refusal latched nothing.
 *
 * Only `safeSpawnAsync` is replaced: it is the process boundary.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLazyInstallAttempts } from "../../clients/dispatch/runners/utils/lazy-installer.js";
import { resetDispatchAvailabilityState } from "../../clients/dispatch/runners/utils/runner-helpers.js";
import { tryLazyInstallFormatterTool } from "../../clients/formatters.js";
import { tryLazyInstall } from "../../clients/dispatch/runners/utils/lazy-installer.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { withEnv } from "../support/with-env.js";
import { removeTempDirSync } from "./test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

const ok = { stdout: "", stderr: "", status: 0 };
const missing = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

/** argv of every spawn that installs something. */
function installSpawns(): string[] {
	return safeSpawnAsync.mock.calls
		.map(([cmd, args]) => `${String(cmd)} ${(args as string[]).join(" ")}`)
		.filter((line) =>
			/^(gem install|rustup component add|go install)\b/.test(line),
		);
}

let restoreEnv: () => void;
let tmpHome = "";
let cwdSeq = 0;
const freshCwd = () => `/proj/install-kill-switch-${cwdSeq++}`;

beforeEach(() => {
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5231-home-"));
	restoreEnv = withEnv({
		PI_LENS_HOME: tmpHome,
		PI_LENS_DISABLE_TOOL_INSTALL: "1",
	});
	safeSpawnAsync.mockReset();
	safeSpawnAsync.mockResolvedValue(ok);
	resetLazyInstallAttempts();
	resetDispatchAvailabilityState();
	setProjectTrustState("trusted");
});

afterEach(() => {
	resetProjectTrust();
	restoreEnv();
	removeTempDirSync(tmpHome);
});

describe("the lazy installer honours PI_LENS_DISABLE_TOOL_INSTALL (#5231)", () => {
	it.each([
		["rubocop", "gem install rubocop --no-document"],
		["rust-clippy", "rustup component add clippy"],
		["rustfmt", "rustup component add rustfmt"],
	] as const)(
		"runner seam: %s spawns nothing with the switch on",
		async (tool, argv) => {
			const cwd = freshCwd();

			expect(await tryLazyInstall(tool, cwd)).toBe(false);
			expect(installSpawns()).toEqual([]);

			// The refusal is not a verdict: with the switch off the same call runs.
			restoreEnv();
			restoreEnv = withEnv({
				PI_LENS_HOME: tmpHome,
				PI_LENS_DISABLE_TOOL_INSTALL: "0",
			});
			expect(await tryLazyInstall(tool, cwd)).toBe(true);
			expect(installSpawns()).toEqual([argv]);
		},
	);

	it.each(["rubocop", "rustfmt"] as const)(
		"formatter seam: %s spawns nothing with the switch on",
		async (tool) => {
			const cwd = freshCwd();

			expect(await tryLazyInstallFormatterTool(tool, cwd)).toBe(false);
			expect(installSpawns()).toEqual([]);

			restoreEnv();
			restoreEnv = withEnv({
				PI_LENS_HOME: tmpHome,
				PI_LENS_DISABLE_TOOL_INSTALL: "0",
			});
			expect(await tryLazyInstallFormatterTool(tool, cwd)).toBe(true);
			expect(installSpawns()).toHaveLength(1);
		},
	);
});

describe("govulncheck honours PI_LENS_DISABLE_TOOL_INSTALL (#5231)", () => {
	/** govulncheck absent from PATH, the Go toolchain present. */
	function goPresentGovulncheckAbsent(): void {
		safeSpawnAsync.mockImplementation(async (cmd: unknown, args: unknown) => {
			const argv = Array.isArray(args) ? (args as string[]).join(" ") : "";
			if (String(cmd) === "go" && argv.startsWith("version"))
				return { stdout: "go1.22.0", stderr: "", status: 0 } as never;
			if (String(cmd) === "go" && argv.startsWith("install"))
				return ok as never;
			return missing as never;
		});
	}

	it("does not `go install` with the switch on, and latches nothing", async () => {
		goPresentGovulncheckAbsent();
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const client = new GovulncheckClient(false);

		expect(await client.ensureAvailable()).toBe(false);
		expect(installSpawns()).toEqual([]);

		// Same client, switch off: the refusal was not cached as absence.
		restoreEnv();
		restoreEnv = withEnv({
			PI_LENS_HOME: tmpHome,
			PI_LENS_DISABLE_TOOL_INSTALL: "0",
		});
		await client.ensureAvailable();
		expect(installSpawns()).toEqual([
			"go install golang.org/x/vuln/cmd/govulncheck@latest",
		]);
	});

	it("still discovers a govulncheck already on PATH with the switch on", async () => {
		safeSpawnAsync.mockResolvedValue({
			stdout: "Go: go1.22.0\nScanner: govulncheck@v1.1.3",
			stderr: "",
			status: 0,
		} as never);
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");

		expect(await new GovulncheckClient(false).ensureAvailable()).toBe(true);
		expect(installSpawns()).toEqual([]);
	});
});
