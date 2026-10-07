import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { removeTempDirSync } from "../test-utils.js";

// Bound optional toolchain discovery; this smoke must never trigger a download
// or hang when elan/Lake is unavailable on the host.
const elanShow = spawnSync("elan", ["show"], {
	encoding: "utf8",
	timeout: 5_000,
});
const installedDefault =
	elanShow.status === 0
		? elanShow.stdout.match(/^\s*(leanprover\/lean4:\S+)\s+\(default\)$/m)?.[1]
		: undefined;
const lakeAvailable =
	spawnSync("lake", ["--version"], {
		encoding: "utf8",
		timeout: 5_000,
	}).status === 0;
const canRunLeanSmoke = Boolean(installedDefault && lakeAvailable);

let root: string | undefined;
let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
let serverProcess: Awaited<ReturnType<typeof launchLSP>> | undefined;

afterEach(async () => {
	if (client) {
		try {
			await client.shutdown();
		} catch {
			// The server may already have exited after a failed startup.
		}
		client = undefined;
	}
	if (serverProcess) {
		await stopLSP(serverProcess);
		serverProcess = undefined;
	}
	if (root) {
		removeTempDirSync(root);
		root = undefined;
	}
});

describe("Lean LSP real-process smoke", () => {
	it.skipIf(!canRunLeanSmoke)(
		"publishes a Lean type error for a .lean document opened with language id lean",
		async () => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean-smoke-"));
			fs.writeFileSync(
				path.join(root, "lean-toolchain"),
				`${installedDefault}\n`,
			);
			fs.writeFileSync(
				path.join(root, "lakefile.lean"),
				"import Lake\nopen Lake DSL\npackage leanSmoke\nlean_lib Main\n",
			);
			const file = path.join(root, "Main.lean");
			const source = 'def wrong : Nat := "not a natural number"\n';
			fs.writeFileSync(file, source);

			serverProcess = await launchLSP("lake", ["serve"], { cwd: root });
			client = await createLSPClient({
				serverId: "lean",
				process: serverProcess,
				root,
			});
			expect(await client.notify.open(file, source, "lean")).toBe(true);
			expect(await client.notify.change(file, source)).toBe(true);
			// Lean can publish an initial clean snapshot before elaboration finishes;
			// waitForDiagnostics may accept that pull result, so wait for the pushed
			// type error rather than treating the early empty snapshot as final.
			await client.waitForDiagnostics(file, 20_000);
			await expect
				.poll(() => client?.getDiagnostics(file), {
					interval: 100,
					timeout: 15_000,
				})
				.toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							message: expect.stringContaining("String"),
						}),
					]),
				);
		},
		30_000,
	);
});
