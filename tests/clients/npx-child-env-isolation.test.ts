/**
 * Witness for #4268 MED-8: the cache-only package-runner (npx) child
 * environment carries no `npm_config_*` variable (case-insensitive) and no
 * project-derived `NPM_CONFIG_USERCONFIG`, whatever `process.env` holds.
 *
 * `getIsolatedNpxSpawnOptions()` used to return a stripped `env` copy, but
 * `getSpawnEnvironment` merges `process.env` UNDERNEATH the caller's override,
 * so removing a key from the override could not remove it from the child: the
 * strip was a no-op at all seven spawn sites. This test therefore observes the
 * CHILD: it drives the real formatter npx fallback through the real spawn
 * seam, with a fake `npx` on PATH, and asserts what the spawned process
 * actually received.
 *
 * The fake `npx` is a tiny node program: the child boundary is the
 * observation, and only a real spawned process can see the merge
 * `getSpawnEnvironment` performs.
 */
// flake-shape: real-process-spawn — the defect is a child's own environment, so
// only a real spawned process can witness it; every in-process double asserts
// what production sets on the options object, which is the exact mistake the
// replaced test made.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { setupTestEnvironment } from "./test-utils.js";

// `resolveNpxFallback` asks the installer for a managed binary; undefined keeps
// the fallback on the bare `npx` command so the isolated seam is what the test
// exercises. The real spawn seam is deliberately NOT mocked.
const ensureTool = vi.hoisted(() => vi.fn());
vi.mock("../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/installer/index.js")
	>()),
	ensureTool,
}));

/** Project lockfile evidence so the formatter agreement gate stays open. */
function writeNodeAgreementEvidence(tmpDir: string): void {
	fs.writeFileSync(
		path.join(tmpDir, "package.json"),
		JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
	);
	fs.writeFileSync(
		path.join(tmpDir, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: { "node_modules/prettier": { version: "3.0.0" } },
		}),
	);
}

/**
 * Plant a fake `npx` on PATH that records the environment IT was spawned with
 * into `PI_LENS_NPX_PROBE_OUT`. Cross-platform: a POSIX shell-free node shim,
 * and a `.cmd` wrapper on Windows.
 */
function plantFakeNpx(binDir: string, childScript: string): void {
	const program = `#!/usr/bin/env node\n${childScript}`;
	if (process.platform === "win32") {
		fs.writeFileSync(path.join(binDir, "npx.js"), childScript);
		fs.writeFileSync(
			path.join(binDir, "npx.cmd"),
			'@echo off\r\nnode "%~dp0npx.js" %*\r\n',
		);
		return;
	}
	fs.writeFileSync(path.join(binDir, "npx"), program, { mode: 0o755 });
}

const CHILD_SCRIPT = `
const fs = require("node:fs");
const npmConfig = {};
for (const [key, value] of Object.entries(process.env)) {
	if (/^npm_config_/i.test(key)) npmConfig[key] = value;
}
fs.writeFileSync(
	process.env.PI_LENS_NPX_PROBE_OUT,
	JSON.stringify({
		cwd: process.cwd(),
		npmConfig,
		registry: process.env.npm_config_registry ?? null,
		userconfig: process.env.NPM_CONFIG_USERCONFIG ?? null,
		hasPath: Boolean(process.env.PATH),
	}),
);
process.exit(0);
`;

describe("#4268 MED-8 cache-only npx child environment", () => {
	beforeEach(() => {
		setProjectTrustState("trusted");
		ensureTool.mockReset();
		ensureTool.mockResolvedValue(undefined);
	});

	afterEach(() => {
		resetProjectTrust();
		vi.unstubAllEnvs();
	});

	it("spawns npx without npm_config_* or a project-derived userconfig", async () => {
		const env = setupTestEnvironment("pi-lens-npx-child-env-");
		const binDir = path.join(env.tmpDir, "fake-bin");
		fs.mkdirSync(binDir, { recursive: true });
		const outFile = path.join(env.tmpDir, "child-env.json");
		try {
			writeNodeAgreementEvidence(env.tmpDir);
			plantFakeNpx(binDir, CHILD_SCRIPT);
			const filePath = path.join(env.tmpDir, "formatted.js");
			fs.writeFileSync(filePath, "const value = 1;\n");

			// The hostile ambient npm config MED-8 names, plus the node child's
			// own output path (which must survive the strip).
			vi.stubEnv("npm_config_registry", "http://hostile.invalid/");
			vi.stubEnv("NPM_CONFIG_USERCONFIG", "/hostile/.npmrc");
			vi.stubEnv("PI_LENS_NPX_PROBE_OUT", outFile);
			vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

			const mod = await import("../../clients/formatters.js");
			const formatter = {
				...mod.prettierFormatter,
				resolveCommand: async () => null,
			};
			const result = await mod.formatFile(filePath, formatter);
			expect(result.outcome).toBe("unchanged");

			expect(fs.existsSync(outFile)).toBe(true);
			const child = JSON.parse(fs.readFileSync(outFile, "utf8")) as {
				cwd: string;
				npmConfig: Record<string, string>;
				registry: string | null;
				userconfig: string | null;
				hasPath: boolean;
			};
			expect(child.registry).toBeNull();
			expect(child.userconfig).toBeNull();
			expect(Object.keys(child.npmConfig)).toEqual([]);
			// Control: the child really ran with a merged, non-empty environment,
			// so an empty `npmConfig` is a real strip, not a missing env.
			expect(child.hasPath).toBe(true);
			// And the neutral pi-lens-owned cwd reached the child, not the project.
			expect(path.relative(env.tmpDir, child.cwd)).toMatch(/^\.\./);
		} finally {
			env.cleanup();
		}
	});
});
