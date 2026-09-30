import { expect, it } from "vitest";

// PLANTED RED for #3753 evidence: a throwaway branch, never merged. It is
// skipped off CI so the local pre-push hook (which runs targeted tests) passes;
// on the CI runner it fails in exactly one shard.
it.skipIf(!process.env.CI)("planted red: one failing test in one shard", () => {
	expect("shard red").toBe("shard green");
});
