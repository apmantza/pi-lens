/**
 * #5100 r3 — a file that starts nothing. With `PI_LENS_DEAD_OWNER_CENSUS_FILE`
 * set (CI shard 5) the shared setup runs `ps` from its own afterAll; the gate
 * must not charge that child to this file.
 */
import { expect, it } from "vitest";

it("starts no child of its own", () => {
	expect(1).toBe(1);
});
