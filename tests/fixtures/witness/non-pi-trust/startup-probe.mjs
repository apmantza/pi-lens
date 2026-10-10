// #4300: observe the CLI's real trust seam after its startup, even on usage errors.
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveToolCommand } from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { refuseUntrustedLspExecution } from "../../../../clients/lsp/launch.js";
process.env.PI_LENS_TEST_MODE = "0";
process.on("exit", () => {
	let codeServerAllowed = false;
	try {
		refuseUntrustedLspExecution({ kind: "project-code-server", serverId: "lean", root: process.cwd() });
		codeServerAllowed = true;
	} catch {
		// A refused decision is the witness result, never an unhandled exit throw.
	}
	fs.writeFileSync(path.join(process.cwd(), "trust-startup.json"), JSON.stringify({ command: resolveToolCommand(process.cwd(), "oxlint"), codeServerAllowed }));
});
