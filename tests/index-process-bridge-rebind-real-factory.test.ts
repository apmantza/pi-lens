import { expect, it } from "vitest";
import { getIOBridge } from "../clients/io-bridge.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import extension from "../index.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

// Recurrence prevented: a factory reload can mount the process bridge before
// the replacement primary starts; dropping the primary rebind then leaves the
// live B session using A's retired dependencies (#4258).
it("rebinds bridge dependencies across a real factory reload", async () => {
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
