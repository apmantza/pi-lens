/**
 * #5127: `lsp.servers.<id>.command` documented an argv array
 * (`docs/configuration.md`) that the loader handed straight to `launchLSP`,
 * which threw `The "path" argument must be of type string`.
 *
 * Everything here drives the production path: a real config file on disk,
 * `loadLSPConfig`, `compileLspRegistry`, and the registered server's own
 * `spawn`. Only `launchLSP` (the process boundary) is doubled, so the
 * assertion is what the loader would have asked the OS to run.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const launchLSP = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	admitProjectSuppliedTsserver: (tsserverPath: string) => tsserverPath,
}));

const dirs: string[] = [];
const originalPiLensHome = process.env.PI_LENS_HOME;

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cmd-array-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	launchLSP.mockClear();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	const trust = await import("../../../clients/project-trust.js");
	trust.resetProjectTrust();
	if (originalPiLensHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalPiLensHome;
});

/** Write a global `lsp.json` server and compile it through the real loader. */
async function compiled(entry: Record<string, unknown>) {
	const project = tempDir();
	const globalDir = tempDir();
	process.env.PI_LENS_HOME = globalDir;
	fs.writeFileSync(
		path.join(globalDir, "lsp.json"),
		JSON.stringify({
			servers: { mine: { name: "Mine", extensions: [".myext"], ...entry } },
		}),
	);
	const trust = await import("../../../clients/project-trust.js");
	trust.setProjectTrustState("trusted");
	const { loadLSPConfig, compileLspRegistry } =
		await import("../../../clients/lsp/config.js");
	const config = await loadLSPConfig(project);
	const registry = compileLspRegistry(config, config.__provenance);
	return { project, server: registry.customServers[0] };
}

describe("custom server command forms (#5127)", () => {
	it("spawns the documented argv array: head is the program, the rest is argv", async () => {
		const { project, server } = await compiled({
			command: ["my-lsp-server", "--stdio"],
		});
		expect(server?.command).toBe("my-lsp-server");
		await server?.spawn(project);
		expect(launchLSP).toHaveBeenCalledTimes(1);
		expect(launchLSP.mock.calls[0]?.slice(0, 2)).toEqual([
			"my-lsp-server",
			["--stdio"],
		]);
	});

	it("puts the array's tail before `args` and adds no default --stdio", async () => {
		const withArgs = await compiled({
			command: ["srv", "--lang", "x"],
			args: ["--extra"],
		});
		await withArgs.server?.spawn(withArgs.project);
		const bare = await compiled({ command: ["srv"] });
		await bare.server?.spawn(bare.project);
		expect(launchLSP.mock.calls.map((call) => call.slice(0, 2))).toEqual([
			["srv", ["--lang", "x", "--extra"]],
			["srv", []],
		]);
	});

	it("keeps the string form: default args --stdio, or the configured args", async () => {
		const plain = await compiled({ command: "srv" });
		await plain.server?.spawn(plain.project);
		const custom = await compiled({ command: "srv", args: ["--pipe"] });
		await custom.server?.spawn(custom.project);
		expect(launchLSP.mock.calls.map((call) => call.slice(0, 2))).toEqual([
			["srv", ["--stdio"]],
			["srv", ["--pipe"]],
		]);
	});

	it.each([
		["an empty array", []],
		["an array with a non-string member", ["srv", 1]],
		["an array with an empty head", ["", "--stdio"]],
		["an empty string", ""],
		["a number", 42],
	])(
		"refuses %s at spawn, naming the field, without launching",
		async (_label, command) => {
			const { project, server } = await compiled({ command });
			await expect(server?.spawn(project)).rejects.toThrow(
				/lsp\.servers\.mine\.command must be a non-empty string or a non-empty array of strings/,
			);
			expect(launchLSP).not.toHaveBeenCalled();
		},
	);

	it("still gates an argv-array command by pi trust (project tier, untrusted)", async () => {
		// Recurrence guard: provenance for an array leaf is recorded per
		// element, so the registry's command gate must still see the project
		// tier for a value that is no longer a single scalar.
		const project = tempDir();
		const globalDir = tempDir();
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					servers: {
						mine: {
							name: "Mine",
							extensions: [".myext"],
							command: ["project-lsp", "--stdio"],
						},
					},
				},
			}),
		);
		const trust = await import("../../../clients/project-trust.js");
		trust.setProjectTrustState("untrusted");
		const { loadLSPConfig, compileLspRegistry } =
			await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(project);
		const registry = compileLspRegistry(config, config.__provenance);
		expect(registry.customServers.map((server) => server.id)).toEqual([]);
	});
});
