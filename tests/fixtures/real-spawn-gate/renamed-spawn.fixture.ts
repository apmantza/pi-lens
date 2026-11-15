/**
 * #5100 r3 — a renamed import: no spawn helper name appears in this file's
 * source. The gate must red it all the same.
 */
import { execFileSync as launch } from "node:child_process";
import { expect, it } from "vitest";

it("starts one real child through a renamed binding", () => {
	expect(launch(process.execPath, ["-e", "process.exit(0)"]).length).toBe(0);
});
