/**
 * #5100 — a harness file that starts a real child with no admission.
 *
 * The gate's red must land here, at this file's teardown, in the run that
 * started the child. Its key must never appear in either admission ledger
 * (`flake-shape-baseline.json` or `real-spawn-observed.json`); the parent test
 * asserts that, so the red cannot be "fixed" by admitting the fixture.
 */
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("starts one real child through the named import", () => {
	const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	expect(result.status).toBe(0);
});
