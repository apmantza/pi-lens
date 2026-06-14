/**
 * #190 Phase 1 — RuntimeCoordinator session identity pinning.
 *
 * resetForSession() assigns a fresh random telemetry id; setSessionLifecycle()
 * runs AFTER it and pins pi's STABLE session id (from
 * ctx.sessionManager.getSessionId()) so it survives a quit→resume and can key
 * persisted state. When pi gives no id, the random fallback must remain.
 */

import { describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

describe("RuntimeCoordinator.setSessionLifecycle (#190)", () => {
	it("pins the stable session id over the post-reset random id", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const randomId = runtime.telemetrySessionId;
		expect(randomId).toMatch(/^lens-/);
		expect(runtime.hasStableSessionId).toBe(false);

		runtime.setSessionLifecycle({
			sessionId: "019ead34-0e73-7e7d-8a78-43c2496a6ead",
			reason: "resume",
		});

		expect(runtime.telemetrySessionId).toBe(
			"019ead34-0e73-7e7d-8a78-43c2496a6ead",
		);
		expect(runtime.hasStableSessionId).toBe(true);
		expect(runtime.sessionLifecycleReason).toBe("resume");
	});

	it("keeps the random fallback when pi provides no session id", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const randomId = runtime.telemetrySessionId;

		runtime.setSessionLifecycle({ sessionId: undefined, reason: "new" });

		expect(runtime.telemetrySessionId).toBe(randomId);
		expect(runtime.hasStableSessionId).toBe(false);
		expect(runtime.sessionLifecycleReason).toBe("new");
	});

	it("a later resetForSession clears the stable-id flag (re-pin required)", () => {
		const runtime = new RuntimeCoordinator();
		runtime.setSessionLifecycle({ sessionId: "sid-1", reason: "resume" });
		expect(runtime.hasStableSessionId).toBe(true);

		runtime.resetForSession();
		expect(runtime.hasStableSessionId).toBe(false);
		expect(runtime.telemetrySessionId).not.toBe("sid-1");
	});
});
