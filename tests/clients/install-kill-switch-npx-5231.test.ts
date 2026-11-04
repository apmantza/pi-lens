/**
 * #5231 H1: with `PI_LENS_DISABLE_TOOL_INSTALL=1` an npx probe must not
 * download.
 *
 * ## The recurrence this guards
 *
 * The first #5231 round gated the lazy installer and govulncheck, then a
 * review probed `BiomeClient.ensureAvailable()` with the switch set: its
 * presence probe ran `npx @biomejs/biome --version` through `probeToolAsync`
 * with no spawn options, and the registry logged `GET /@biomejs%2fbiome`. A
 * package-runner fallback is an install path that no installer function
 * guards, so the rule lives where every spawn's command is visible: the spawn
 * seam (`getSpawnEnvironment`) sets `npm_config_offline=true` for `npx`.
 *
 * ## What is observed
 *
 * The CHILD's environment, through the real spawn seam: a fake `npx` on PATH
 * records what it was spawned with (the same technique as
 * `npx-child-env-isolation.test.ts`). Only a real spawned process sees the
 * merge `getSpawnEnvironment` performs, and the probe passes no options, so an
 * options-level double would assert the very thing that was wrong.
 */
// flake-shape: real-process-spawn — the defect is a child's own environment, so
// only a real spawned process can witness it.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BiomeClient } from "../../clients/biome-client.js";
import { probeToolAsync } from "../../clients/tool-probe.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { withEnv } from "../support/with-env.js";
import { setupTestEnvironment } from "./test-utils.js";

const CHILD_SCRIPT = `
const fs = require("node:fs");
fs.appendFileSync(
	process.env.PI_LENS_NPX_PROBE_OUT,
	JSON.stringify({
		argv: process.argv.slice(2),
		offline: process.env.npm_config_offline ?? null,
		npmConfig: Object.keys(process.env).filter((key) => /^npm_config_/i.test(key)),
		hasPath: Boolean(process.env.PATH),
	}) + "\\n",
);
process.exit(1);
`;

interface ChildRecord {
	argv: string[];
	npmConfig: string[];
	offline: string | null;
	hasPath: boolean;
}

/** A fake `npx` that records its argv and environment, then reports "missing". */
function plantFakeNpx(binDir: string): void {
	if (process.platform === "win32") {
		fs.writeFileSync(path.join(binDir, "npx.js"), CHILD_SCRIPT);
		fs.writeFileSync(
			path.join(binDir, "npx.cmd"),
			'@echo off\r\nnode "%~dp0npx.js" %*\r\n',
		);
		return;
	}
	fs.writeFileSync(
		path.join(binDir, "npx"),
		`#!${process.execPath}\n${CHILD_SCRIPT}`,
		{ mode: 0o755 },
	);
}

describe("PI_LENS_DISABLE_TOOL_INSTALL reaches the npx probe (#5231 H1)", () => {
	const restores: Array<() => void> = [];
	let cleanup: () => void;
	let outFile: string;

	/** Run the production presence probe with the switch at `value`. */
	async function probeBiome(value: "0" | "1"): Promise<ChildRecord[]> {
		restores.push(withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: value }));
		const client = new BiomeClient();
		await client.ensureAvailable();
		if (!fs.existsSync(outFile)) return [];
		return fs
			.readFileSync(outFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ChildRecord);
	}

	beforeEach(() => {
		setProjectTrustState("trusted");
		const env = setupTestEnvironment("pi-lens-npx-offline-");
		cleanup = env.cleanup;
		const binDir = path.join(env.tmpDir, "fake-bin");
		fs.mkdirSync(binDir, { recursive: true });
		plantFakeNpx(binDir);
		outFile = path.join(env.tmpDir, "npx-child.jsonl");
		// PATH is only the fake directory: no package manager or biome of the
		// host can answer first, so the probe falls through to the npx arm.
		restores.push(
			withEnv({
				PATH: binDir,
				PI_LENS_HOME: path.join(env.tmpDir, "pi-lens-home"),
				PI_LENS_NPX_PROBE_OUT: outFile,
			}),
		);
		vi.spyOn(process, "cwd").mockReturnValue(env.tmpDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		while (restores.length > 0) restores.pop()?.();
		resetProjectTrust();
		cleanup();
	});

	it("BiomeClient.ensureAvailable() spawns npx offline when the switch is set", async () => {
		const spawned = await probeBiome("1");

		const probes = spawned.filter((child) => child.argv.includes("--version"));
		expect(probes.length).toBeGreaterThan(0);
		for (const child of probes) {
			expect(child.argv[0]).toBe("@biomejs/biome");
			// Control inside the same record: the child really ran with a merged,
			// non-empty environment.
			expect(child.hasPath).toBe(true);
			expect(child.offline).toBe("true");
		}
	});

	it("keeps npm_config_offline through the stripped cache-only spawn (the formatters fallback)", async () => {
		restores.push(
			withEnv({
				PI_LENS_DISABLE_TOOL_INSTALL: "1",
				// The hostile ambient npm config the strip exists to remove.
				npm_config_registry: "http://hostile.invalid/",
			}),
		);
		const filePath = path.join(path.dirname(outFile), "formatted.js");
		fs.writeFileSync(filePath, "const value = 1;\n");
		fs.writeFileSync(
			path.join(path.dirname(outFile), "package.json"),
			JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
		);
		fs.writeFileSync(
			path.join(path.dirname(outFile), "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: { "node_modules/prettier": { version: "3.0.0" } },
			}),
		);

		const mod = await import("../../clients/formatters.js");
		await mod.formatFile(filePath, {
			...mod.prettierFormatter,
			resolveCommand: async () => null,
		});

		const [child] = fs
			.readFileSync(outFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ChildRecord);
		expect(child?.hasPath).toBe(true);
		// The strip removed the hostile registry; only the kill switch's own
		// variable survives it.
		expect(child?.npmConfig).toEqual(["npm_config_offline"]);
		expect(child?.offline).toBe("true");
	});

	it("leaves the child online when the switch is off (positive control)", async () => {
		// Not through BiomeClient: with the switch off its install path would run
		// the real installer. The seam alone shows the variable is the switch's.
		restores.push(withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "0" }));
		await probeToolAsync("npx", ["@biomejs/biome", "--version"]);

		const [child] = fs
			.readFileSync(outFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ChildRecord);
		expect(child?.hasPath).toBe(true);
		expect(child?.offline).toBeNull();
	});
});
