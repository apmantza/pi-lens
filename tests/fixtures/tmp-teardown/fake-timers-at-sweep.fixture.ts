// Fixture for tests/support/tmp-root-teardown.test.ts (#4591): a case installs
// fake timers pinned to the epoch and never restores them, so the file's
// afterAll sweep runs under a fake `Date`. The sweep record's time must still
// be the real clock, the one filesystem times share.
import { it, vi } from "vitest";
import { setupTestEnvironment } from "../../clients/test-utils.js";

it("sweeps under fake timers", () => {
	setupTestEnvironment("pi-lens-4591-faketimers-");
	vi.useFakeTimers({ now: 0 });
});
