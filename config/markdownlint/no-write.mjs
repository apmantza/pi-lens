// Node preload (`--import`) for the diagnostics-only markdownlint-cli2 run
// (#5119). markdownlint-cli2 has no CLI switch that turns `"fix": true` off:
// a project `.markdownlint-cli2.*` directory config overrides every flag, and
// the fix pass then rewrites the file through `fs.promises.writeFile`. This
// makes that one call a no-op, so the lint pass reports the findings it would
// have fixed and writes nothing. Inert unless the process is the
// markdownlint-cli2 binary, so a shim that execs another node program is safe.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// `process.argv[1]` is the path as invoked (the `.bin` symlink), not its target.
function entryPath() {
	try {
		return fs.realpathSync(process.argv[1] ?? "");
	} catch {
		return "";
	}
}

if (entryPath().endsWith("markdownlint-cli2-bin.mjs")) {
	fs.promises.writeFile = async () => undefined;
	syncBuiltinESMExports();
}
