/**
 * #5231: the managed installer half of the kill switch, driven through the
 * real `installTool` / `ensureTool` / `refreshManagedTool` entry points.
 *
 * Recurrence this prevents: the four managed-installer reads of
 * `PI_LENS_DISABLE_TOOL_INSTALL` were folded onto `isToolInstallDisabled()`
 * (clients/env-utils.ts); a fold that drops one read lets that entry spawn
 * `gem install` with the switch set. The spawn boundary is faked, so nothing
 * installs on the host, and the positive control proves the fake sees an
 * install once the switch is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.js");

const { safeSpawnAsync } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(
		async (
			_command: string,
			_args?: string[],
			_options?: Record<string, unknown>,
		) => ({ status: 0, stdout: "", stderr: "" }),
	),
}));
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import {
	ensureTool,
	installTool,
	refreshManagedTool,
} from "../../../clients/installer/index.js";
import { withEnv } from "../../support/with-env.js";

/** `gem` is the install strategy of rubocop: a spawn of it is an install. */
const installSpawns = () =>
	safeSpawnAsync.mock.calls.filter(
		([command, args]) => command === "gem" && (args ?? []).includes("install"),
	);

let restoreEnv: () => void;
beforeEach(() => {
	safeSpawnAsync.mockClear();
	restoreEnv = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
});
afterEach(() => restoreEnv());

describe("the managed installer honours PI_LENS_DISABLE_TOOL_INSTALL (#5231)", () => {
	it("installTool refuses before any spawn", async () => {
		expect(await installTool("rubocop")).toBe(false);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("ensureTool refuses to install and spawns no installer", async () => {
		await ensureTool("rubocop");
		expect(installSpawns()).toEqual([]);
	});

	it("ensureTool with forceReinstall refuses to install and spawns no installer", async () => {
		await ensureTool("rubocop", { forceReinstall: true });
		expect(installSpawns()).toEqual([]);
	});

	it("refreshManagedTool declines through the shared gate", async () => {
		const outcome = await refreshManagedTool("rubocop");
		expect(outcome).toMatchObject({ ok: false, declined: true });
		expect(installSpawns()).toEqual([]);
	});

	it("positive control: with the switch off installTool spawns `gem install`", async () => {
		const restore = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "0" });
		try {
			await installTool("rubocop");
			expect(installSpawns().length).toBeGreaterThan(0);
		} finally {
			restore();
		}
	});
});
