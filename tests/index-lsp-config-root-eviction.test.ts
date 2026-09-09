/**
 * #2518, second door: index.ts's `ensureLSPConfigInitialized` memo.
 *
 * `_lspConfigInitializedCwds` is a process-lifetime memo of cwds this
 * extension has initialized. It is NOT the session-root registry, and it never
 * sees the registry's other production writers — `clients/runtime-session.ts`
 * and `clients/lens-engine.ts` both call `initLSPConfig` directly — so the
 * registry can drop a root at its cap while the memo still reports it
 * initialized. The dropped entry carries that root's `lsp.disabledServers`
 * denial with it, and a memo-only check means nothing ever loads it again:
 * the operator's denial is lifted for the rest of the process.
 *
 * `mcp/server.ts`'s `ensureReady` has consulted `shouldInitializeSessionRoot`
 * since #2052 R1 for exactly this reason; this file pins the extension's own
 * entry point to the same seam, through the REAL activation and the real
 * `session_start` emit rather than a hand call to a private function.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import {
	initLSPConfig,
	isServerDisabled,
	resetLSPConfigStateForTests,
} from "../clients/lsp/config.js";
import { isSessionRootRegistered } from "../clients/lsp/session-roots.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const DENIED_SERVER = "typos";
const dirs: string[] = [];
let previousStartupMode: string | undefined;
let previousHome: string | undefined;

function tempRoot(prefix: string): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-2518-idx-${prefix}-`)),
	);
	dirs.push(dir);
	return dir;
}

/** A project whose operator config denies {@link DENIED_SERVER}. */
function denyingRoot(): string {
	const dir = tempRoot("deny");
	fs.writeFileSync(
		path.join(dir, ".pi-lens.json"),
		JSON.stringify({ lsp: { disabledServers: [DENIED_SERVER] } }),
	);
	fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n");
	return dir;
}

beforeEach(() => {
	previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
	// Minimal mode so `ensureLSPConfigInitialized` is the ONLY thing in this
	// activation that resolves LSP config — the seam under test, with no
	// warm-up timer or bootstrap load resolving it by a side door.
	process.env.PI_LENS_STARTUP_MODE = "minimal";
	previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = tempRoot("home");
	_resetSessionLifecycleForTests();
	resetLSPConfigStateForTests();
});

afterEach(() => {
	_resetSessionLifecycleForTests();
	resetLSPConfigStateForTests();
	if (previousStartupMode === undefined)
		delete process.env.PI_LENS_STARTUP_MODE;
	else process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("index.ts ensureLSPConfigInitialized vs the session-root registry (#2518)", () => {
	it("re-initializes a root the registry evicted while its memo still names it", async () => {
		const root = denyingRoot();
		const file = path.join(root, "notes.md");
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: root, sessionId: "host-session-1" }),
		);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);

		// The registry's other production writers: `runtime-session.ts` and
		// `lens-engine.ts` call `initLSPConfig` for a turn's cwd without ever
		// touching index.ts's memo, so the registry advances past it.
		for (let index = 0; index < 128; index++) {
			await initLSPConfig(tempRoot(`other-${index}`));
		}
		expect(isSessionRootRegistered(root)).toBe(false);
		expect(
			isServerDisabled(DENIED_SERVER, file),
			"an evicted root has no config, so its denial is not applied",
		).toBe(false);

		// The next session for that root must load it again. A memo-only check
		// returns early here and leaves the denial lifted for the process.
		_resetSessionLifecycleForTests();
		await pi.emit(
			"session_start",
			makeSessionStartEvent({ reason: "new" }),
			makeCtx({ cwd: root, sessionId: "host-session-2" }),
		);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);
		expect(isSessionRootRegistered(root)).toBe(true);
	}, 120_000);
});
