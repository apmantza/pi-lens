/**
 * #5100 r3 — the #5084 shape: the test never names `child_process`; production
 * code under test runs the child. The chain holds this file's frame, so the
 * file owes the admission.
 */
import { expect, it } from "vitest";
import { safeSpawn } from "../../../clients/safe-spawn.js";

it("starts one real child through clients/", () => {
	const result = safeSpawn(process.execPath, ["-e", "process.exit(0)"]);
	expect(result.status).toBe(0);
});
