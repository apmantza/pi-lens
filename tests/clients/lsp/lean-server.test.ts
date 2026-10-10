import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchLSP } = vi.hoisted(() => ({ launchLSP: vi.fn() }));
vi.mock("../../../clients/lsp/launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/launch.js")>()),
	launchLSP,
}));

import { LeanServer, LSP_SERVERS } from "../../../clients/lsp/server.js";
import { removeTempDirSync } from "../test-utils.js";

const dirs: string[] = [];
const fakeProcess = { kill: vi.fn() } as never;

afterEach(() => {
	launchLSP.mockReset();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("Lean Lake LSP server", () => {
	it("is registered for Lean files and launches Lake in the project root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean-lsp-"));
		dirs.push(root);
		fs.writeFileSync(path.join(root, "lakefile.lean"), "import Lake\n");
		fs.writeFileSync(
			path.join(root, "lean-toolchain"),
			"leanprover/lean4:v4.33.0\n",
		);
		launchLSP.mockResolvedValue(fakeProcess);

		expect(LSP_SERVERS).toContain(LeanServer);
		expect(LeanServer.extensions).toContain(".lean");
		await expect(LeanServer.spawn(root)).resolves.toMatchObject({
			process: fakeProcess,
			source: "direct",
		});
		expect(launchLSP).toHaveBeenCalledWith("lake", ["serve"], { cwd: root });
	});

	// #3750/#4119: `lake serve` cannot analyse a file outside a Lake project, so
	// an empty answer under `RootWithFallback`'s fallback root is unconfirmed,
	// not clean. Pin the trait on the registered row, not only the export.
	it("declares requiresProjectRoot on the registry row", () => {
		expect(
			LSP_SERVERS.find((server) => server.id === "lean")?.requiresProjectRoot,
		).toBe(true);
	});
});
