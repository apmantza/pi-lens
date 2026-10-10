#!/usr/bin/env node
/**
 * #4133 round 3: a fake external scanner for the MCP harness witness in
 * `tests/mcp/jscpd-report-root.test.ts`. It answers the availability probe
 * instantly (`--version`, or gitleaks's bare `version` verb), records the
 * report directory it was handed (from `--output`, `--report-path` or
 * `--json-output`), then parks until the harness kills it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version") || args[0] === "version") {
	process.stdout.write("0.0.0-fake\n");
	process.exit(0);
}

const outputFlags = ["--output", "--report-path", "--json-output"];
let value = "";
for (const flag of outputFlags) {
	const index = args.indexOf(flag);
	if (index >= 0 && index + 1 < args.length) value = args[index + 1];
}

if (value) {
	let dir = value;
	try {
		if (!fs.statSync(value).isDirectory()) dir = path.dirname(value);
	} catch {
		dir = path.dirname(value);
	}
	try {
		fs.writeFileSync(process.env.SCANNER_FAKE_MARKER, dir);
	} catch {
		// The marker is the witness's only channel; a missing env var is a test
		// wiring bug, and the test's own wait then times out.
	}
}

setTimeout(() => process.exit(0), 60_000);
