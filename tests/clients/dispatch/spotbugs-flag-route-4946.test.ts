/**
 * SpotBugs is reachable through its documented flag and config key (#4946).
 *
 * RECURRENCE THIS PREVENTS: #4946. `withSpotbugsGroup` read `lens-spotbugs`
 * while `clients/lens-flag-registry.ts` registered no such flag, so the host
 * answered `undefined` on every call and the runner could never be scheduled
 * (`clients/tool-policy.ts` documents it as opt-in behind that flag). The
 * reader below is the production resolver `index.ts` hands the dispatcher
 * (`resolvePiLensFlag`: host value, then global config, then the registry
 * default). Only the host is a stand-in, and it answers like pi does: a CLI
 * value exists only for a flag the extension registered (`getLensFlagSpec`).
 * The JVM tool is the process boundary (`safeSpawnAsync`); tool installation is
 * off under vitest (`PI_LENS_DISABLE_TOOL_INSTALL`), so the real availability
 * checks and the real runner decide what reaches that boundary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import spotbugsRunner from "../../../clients/dispatch/runners/spotbugs.js";
import { dispatchLintDetailed } from "../../../clients/dispatch/integration.js";
import { resolvePiLensFlag } from "../../../clients/lens-config.js";
import { getLensFlagSpec } from "../../../clients/lens-flag-registry.js";
import { setupTestEnvironment, useTrackedTempDirs } from "../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

describe("lens-spotbugs reaches the SpotBugs runner (#4946)", () => {
	let cwd: string;
	let filePath: string;
	useTrackedTempDirs("pi-lens-spotbugs-route-");

	beforeEach(() => {
		// #5547: dispatcher budget must cover the runner-owned 120s spawn.
		expect(spotbugsRunner.timeoutMs).toBe(120_000);
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});
		cwd = setupTestEnvironment("pi-lens-spotbugs-route-").tmpDir;
		fs.writeFileSync(path.join(cwd, "pom.xml"), "<project/>\n");
		fs.mkdirSync(path.join(cwd, "target", "classes"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, "target", "classes", "Foo.class"),
			Buffer.from([0xca, 0xfe]),
		);
		fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
		filePath = path.join(cwd, "src", "Foo.java");
		fs.writeFileSync(filePath, "class Foo {}\n");
	});

	/** The scans the runner asked the process boundary for: `spotbugs -textui ... <classes dir>`. */
	const spotbugsScans = () =>
		safeSpawnAsync.mock.calls.filter(([, args]) =>
			(args as string[]).includes("-textui"),
		);

	const runnerIds = async (
		hostValues: Record<string, boolean | undefined>,
		config: Parameters<typeof resolvePiLensFlag>[2],
	) => {
		const { runners } = await dispatchLintDetailed(
			filePath,
			cwd,
			{
				getFlag: (name) =>
					resolvePiLensFlag(
						name,
						// pi answers `undefined` for a flag no extension registered.
						getLensFlagSpec(name) ? (hostValues[name] ?? false) : undefined,
						config,
					),
			},
			{ blockingOnly: false },
		);
		return runners.map(({ runnerId }) => runnerId);
	};

	it("schedules the runner for the CLI flag", async () => {
		expect(
			await runnerIds({ "lens-spotbugs": true, "no-lsp": true }, {}),
		).toContain("spotbugs");
		expect(spotbugsScans()).toHaveLength(1);
		expect(spotbugsScans()[0]?.[1]).toContain(
			path.join(cwd, "target", "classes"),
		);
	}, 30_000);

	it("schedules the runner for spotbugs.enabled=true in the global config", async () => {
		expect(
			await runnerIds({ "no-lsp": true }, { spotbugs: { enabled: true } }),
		).toContain("spotbugs");
	}, 30_000);

	it("stays off by default and for spotbugs.enabled=false", async () => {
		expect(await runnerIds({ "no-lsp": true }, {})).not.toContain("spotbugs");
		expect(
			await runnerIds({ "no-lsp": true }, { spotbugs: { enabled: false } }),
		).not.toContain("spotbugs");
		expect(spotbugsScans()).toHaveLength(0);
	}, 30_000);
});
