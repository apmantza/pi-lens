/**
 * #5231 — the managed installer reads the install kill switch at four places
 * (`acquireManagedInstallGate`, `installTool`, and the two refusals in
 * `ensureToolResolved`). They now share `isToolInstallDisabledByEnv`, and this
 * file gives each its own witness: `installTool` and `ensureToolResolved`'s two
 * branches shadow one another (every ensure path ends in `installTool`, which
 * refuses too), so neutering one site alone left every earlier witness green.
 *
 * Recurrence this guards: one of the four sites losing its read (or reading a
 * different spelling of the switch) while a sibling site still refuses, so the
 * path's refusal record changes and nothing notices. Each case reads the
 * session-start line that only its own site writes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../support/with-env.js";

vi.unmock("../../../clients/installer/index.js");

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

let piLensHome = "";
let restoreEnv: () => void;

/**
 * The session-start log lines the installer wrote, read from the real sink: the
 * sink is a no-op under the test-mode gate, so the gate is lifted for these
 * cases and `PI_LENS_HOME` points the log at the case's own directory.
 */
async function sessionStartLines(): Promise<string[]> {
	const { flushSessionStartLog, SESSIONSTART_LOG_FILE } =
		await import("../../../clients/sessionstart-logger.js");
	await flushSessionStartLog();
	if (!fs.existsSync(SESSIONSTART_LOG_FILE)) return [];
	return fs
		.readFileSync(SESSIONSTART_LOG_FILE, "utf8")
		.split("\n")
		.map((line) => line.replace(/^\[[^\]]*\] /, ""))
		.filter(Boolean);
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	safeSpawnAsync.mockResolvedValue({ stdout: "", stderr: "", status: 1 });
	piLensHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5231-sites-"));
	restoreEnv = withEnv({
		PI_LENS_HOME: piLensHome,
		PI_LENS_DISABLE_TOOL_INSTALL: "1",
		PI_LENS_TEST_MODE: "0",
	});
	vi.resetModules();
});

afterEach(async () => {
	(await import("../../../clients/project-trust.js")).resetProjectTrust();
	restoreEnv();
	fs.rmSync(piLensHome, { recursive: true, force: true });
});

const installerModule = () => import("../../../clients/installer/index.js");

const installSpawns = () =>
	safeSpawnAsync.mock.calls.filter(([, args]) =>
		(args as string[]).some((a) => a === "install" || a === "add"),
	);

describe("each installer kill-switch site refuses on its own (#5231)", () => {
	it("installTool records its own refusal line and spawns nothing", async () => {
		const { installTool } = await installerModule();

		expect(await installTool("fish-lsp")).toBe(false);

		expect(await sessionStartLines()).toContain(
			"auto-install fish-lsp: refused — PI_LENS_DISABLE_TOOL_INSTALL=1",
		);
		expect(installSpawns()).toEqual([]);
	});

	it("ensureTool's normal path records the timed refusal and spawns nothing", async () => {
		const { ensureTool } = await installerModule();

		expect(await ensureTool("fish-lsp")).toBeUndefined();

		expect(
			(await sessionStartLines()).filter((l) =>
				/^auto-install ensure fish-lsp: refused — PI_LENS_DISABLE_TOOL_INSTALL=1 \(\d+ms\)$/.test(
					l,
				),
			),
		).toHaveLength(1);
		expect(installSpawns()).toEqual([]);
	});

	it("ensureTool's forceReinstall branch records its own untimed refusal", async () => {
		const { ensureTool } = await installerModule();

		expect(await ensureTool("fish-lsp", { forceReinstall: true })).toBe(
			undefined,
		);

		expect(await sessionStartLines()).toContain(
			"auto-install ensure fish-lsp: refused — PI_LENS_DISABLE_TOOL_INSTALL=1",
		);
		expect(installSpawns()).toEqual([]);
	});
});
