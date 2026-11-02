import { afterEach, expect, it, vi } from "vitest";
import { getIOBridge } from "../clients/io-bridge.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import extension from "../index.js";
import { setupTestEnvironment } from "./clients/test-utils.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

afterEach(async () => {
	// #5146: end the session the case leaves open (the last primary).
	await endMockSessions();
});

// Recurrence prevented: a factory reload can mount the process bridge before
// the replacement primary starts; dropping the primary rebind then leaves the
// live B session using A's retired dependencies (#4258).
it("rebinds bridge dependencies across a real factory reload", async () => {
	// #4347: session_start on this checkout launches the real jscpd scan, which
	// nothing awaits; its report root is created after this body ends, and the
	// fork is killed mid-scan, so a root under the real tmpdir was stranded. The
	// scanner temp-root seam puts it under this registered root instead, which
	// the shared setup removes at teardown and on SIGTERM. Never unstubbed: the
	// seam is read when the scan starts, after this test returns, and the fork
	// exits with the file.
	vi.stubEnv(
		"PI_LENS_TEST_SCANNER_TMPDIR",
		setupTestEnvironment("pi-lens-real-factory-scanners-").tmpDir,
	);
	_resetSessionLifecycleForTests();
	const primaryA = createPiMock();
	const ctxA = makeCtx({
		cwd: process.cwd(),
		sessionId: "primary-a",
		sessionFile: `${process.cwd()}/primary.jsonl`,
	});
	extension(primaryA.asExtensionAPI());
	await primaryA.emit(
		"session_start",
		{ type: "session_start", reason: "startup" },
		ctxA,
	);

	const beforeReload = getIOBridge()?.record({
		filePath: `${process.cwd()}/index.ts`,
		consumer: "real-factory-rebind",
		read: { ranges: [[1, 1]], evidence: "disk" },
	});
	expect(beforeReload).toEqual({ read: { accepted: true } });

	await primaryA.emit("session_shutdown", { reason: "reload" }, ctxA);
	const duringGap = getIOBridge()?.record({
		filePath: `${process.cwd()}/index.ts`,
		consumer: "real-factory-rebind",
		read: { ranges: [[1, 1]], evidence: "disk" },
	});
	expect(duringGap).toMatchObject({
		read: { accepted: false, reason: "unavailable" },
	});
	const primaryB = createPiMock();
	extension(primaryB.asExtensionAPI());
	await primaryB.emit(
		"session_start",
		{ type: "session_start", reason: "reload" },
		ctxA,
	);

	const afterReload = getIOBridge()?.record({
		filePath: `${process.cwd()}/index.ts`,
		consumer: "real-factory-rebind",
		read: { ranges: [[1, 1]], evidence: "disk" },
	});
	expect(afterReload).toEqual({ read: { accepted: true } });
});
