/**
 * #5100 r3 — the #5064 spelling: the module is mocked, then the real one is
 * asked for through `vi.importActual`. The gate must red this file.
 */
import { expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

it("starts one real child through vi.importActual", async () => {
	const actual =
		await vi.importActual<typeof import("node:child_process")>(
			"node:child_process",
		);
	const result = actual.spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	expect(result.status).toBe(0);
});
