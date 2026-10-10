/**
 * #1731 discipline B: `styluaFormatter` had no `resolveCommand` and its
 * `detect()` only ever checked `which("stylua")` — a bare PATH lookup. A
 * project that installs stylua locally via npm (`@johnnymorganz/stylua`,
 * `node_modules/.bin/stylua`) was invisible whenever that shim was not also
 * on the calling shell's PATH, unlike every other Node-toolchain formatter in
 * this file.
 *
 * These tests use a project-local shim that is NOT on PATH (the real `which`/
 * `where` spawn runs for real; stylua is not installed on the test host), so
 * a pass here can only come from the new local-bin resolution, not a PATH hit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { styluaFormatter } from "../../clients/formatters.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const tmpDirs: string[] = [];

// The suite plants a project-local shim on purpose; the trust gate itself is
// witnessed in `project-local-bin-trust.test.ts`.
beforeEach(() => setProjectTrustState("trusted"));

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir && fs.existsSync(dir)) removeTempDirSync(dir);
	}
});

function installLocalStylua(root: string): string {
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const shim = path.join(
		binDir,
		process.platform === "win32" ? "stylua.cmd" : "stylua",
	);
	fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
	return shim;
}

describe("styluaFormatter — project-local binary resolution (#1731)", () => {
	it("detects a project-local stylua that is not on PATH", async () => {
		const env = setupTestEnvironment("pi-lens-stylua-local-");
		tmpDirs.push(env.tmpDir);
		installLocalStylua(env.tmpDir);
		fs.writeFileSync(
			path.join(env.tmpDir, "stylua.toml"),
			"column_width = 100\n",
		);

		expect(await styluaFormatter.detect(env.tmpDir)).toBe(true);
	});

	it("resolves the command to the project-local shim, not the bare PATH name", async () => {
		const env = setupTestEnvironment("pi-lens-stylua-resolve-");
		tmpDirs.push(env.tmpDir);
		const shim = installLocalStylua(env.tmpDir);
		const filePath = path.join(env.tmpDir, "init.lua");
		fs.writeFileSync(filePath, "print('x')\n");

		const resolved = await styluaFormatter.resolveCommand?.(
			filePath,
			env.tmpDir,
		);
		expect(resolved).toEqual([shim, filePath]);
	});
});
