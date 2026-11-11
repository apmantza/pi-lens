/**
 * Whether a warm endpoint derived from the ambient temp root has lost its
 * identity to the `sun_path` cut (#5488 review round 2, G1). Production then
 * neither binds nor dials that name, so a case that needs a live listener at
 * such an endpoint skips instead of failing. The cut rule is
 * `boundUnixSocketKeepsIdentity`'s; nothing here re-derives it.
 *
 * Kept out of `tests/clients/test-utils.ts` so shared setup does not load
 * `clients/mcp/ipc.js` into every test file.
 */

import * as os from "node:os";
import {
	boundUnixSocketKeepsIdentity,
	diagnosticsIpcPathForCwd,
	ipcPathForCwd,
} from "../../clients/mcp/ipc.js";

/** True when the workspace endpoint (no `ownerPid`) or the pid-scoped
 *  endpoint of `ownerPid` under `os.tmpdir()` is a shared name. Any cwd gives
 *  the same length: the workspace hash is always 16 hex characters. */
export function ambientSocketNameIsShared(ownerPid?: number): boolean {
	const cwd = os.tmpdir();
	if (ownerPid === undefined)
		return !boundUnixSocketKeepsIdentity(ipcPathForCwd(cwd));
	return !boundUnixSocketKeepsIdentity(
		diagnosticsIpcPathForCwd(cwd, ownerPid),
		{ ownerPid },
	);
}
