import { defineConfig } from "vitest/config";

// Minimal config — vitest defaults (test discovery, pools, etc.) are preserved.
// The only addition is a globalSetup that fails fast on a stale in-place build,
// so tests can't silently run against pre-edit compiled `.js` (#198).
export default defineConfig({
	test: {
		globalSetup: ["./tests/support/check-build-freshness.ts"],
	},
});
